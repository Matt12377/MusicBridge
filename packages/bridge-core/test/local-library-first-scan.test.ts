import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import ts from 'typescript';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createLocalScanCoordinator } from '../src/collection/local-scan-coordinator.js';
import { createLocalRelocationCoordinator } from '../src/collection/local-relocation-coordinator.js';
import { createCompletedScanSnapshotView } from '../src/collection/local-scan-snapshot-view.js';
import { createLocalWorkbenchReadService, createLocalLibraryManagementRuntime,
  type LocalLibraryManagementImportPort, type LocalLibraryManagementRuntimeOptions,
  type LocalWorkbenchReadContext } from '../src/collection/local-library-workbench/read-service.js';
import { localLibraryManagementDigest, type LocalLibraryManagementOriginalOperation,
  type LocalLibraryManagementOperationRecord, type LocalLibraryManagementBindingRecord } from '../src/collection/local-library-workbench/owner-journal.js';
import { LocalWorkbenchPlanError } from '../src/collection/local-library-workbench/types.js';
import { DatasetWorkbenchWireError, datasetWorkbenchJson, datasetWorkbenchSha,
  type DatasetProjectionPort, type DatasetProjectionCommand, type DatasetProjectionCommandPayloads,
  type DatasetProjectionCommandResults } from '../src/collection/dataset-owner-protocol.js';
import { createScanReadAdmission } from '../src/library/scan-read-admission.js';
import { lyricsPhysicalDigest } from '../src/library/lyrics-source-format.js';
import { METADATA_PARSER_VERSION, type MetadataReaderPort, type MetadataReadResult } from '../src/library/metadata-reader-types.js';
import { authorizeSourceDirectory, sourceRootAvailability, withCheckedReadonlyMetadataSource, type RootCapability } from '../src/recording/source-files.js';
import { createCommandOutboxStore } from '../../../apps/desktop/src/main/command-outbox-store.js';
import { createCommandOutboxService } from '../../../apps/desktop/src/main/command-outbox-service.js';
import { createCommandOutboxExecutor } from '../../../apps/desktop/src/main/command-outbox-executor.js';

type Confirm = dto.LocalLibraryManagementPayloads['library.import.confirm'];
type RegisterHook = NonNullable<Parameters<typeof createLocalRelocationCoordinator>[0]['onRegistered']>;
type InitialHook = NonNullable<LocalLibraryManagementRuntimeOptions['startInitialScan']>;
interface DomainParts {
  consumeLibraryDirectory(choiceId: string): Promise<void>;
  startInitialLibraryScan(commandId: string, root: Readonly<dto.LibraryRoot>): Promise<void>;
  legacyOnRegistered: RegisterHook;
  startCallback: InitialHook;
  imports: Pick<LocalLibraryManagementImportPort, 'confirm' | 'readOriginal'>;
}

function between(source: string, start: string, end: string): string {
  assert.equal(source.split(start).length, 2, '原源码起点必须唯一。');
  const index = source.indexOf(start), stop = source.indexOf(end, index + start.length);
  assert.ok(stop > index, '原源码终点必须存在。');
  return source.slice(index, stop);
}
/** 只提取本次域内函数和实际装配回调；SQL、扫描协调器和FD使用原实现。
 * 外层Owner/Main审批与元数据内容由有限fixture提供；不是完整Main/Owner/Native运行证明。 */
async function domainParts(dependencies: Record<string, unknown>): Promise<DomainParts> {
  const source = await readFile(new URL('../src/collection/dataset-domain.ts', import.meta.url), 'utf8');
  const start = between(source, '  async function startInitialLibraryScan(', '\n  // BackupCoordinator');
  const consume = between(source, '  function consumeLibraryDirectory(', '\n  function assertLibraryJobOriginal(');
  const confirm = between(source, '        async confirm(request,context){', '\n        async readOriginal(commandId){');
  const original = between(source, '        async readOriginal(commandId){', '\n      },\n      watch:');
  const initial = between(source, '      async startInitialScan(commandId,root,context){', '\n      async removeResources(');
  const legacy = between(source, 'onRegistered:', ',onRelinked:').slice('onRegistered:'.length);
  const body = `${start}\n${consume}\nconst imports={${confirm}\n${original}};\nconst callbacks={${initial}};\n`
    + `return {imports,consumeLibraryDirectory,startInitialLibraryScan,legacyOnRegistered:(${legacy}),startCallback:callbacks.startInitialScan};`;
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies)) as DomainParts;
}

function wav(): Buffer {
  const value = Buffer.alloc(48);
  value.write('RIFF'); value.writeUInt32LE(40, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(48_000, 24);
  value.writeUInt32LE(192_000, 28); value.writeUInt16LE(4, 32); value.writeUInt16LE(16, 34);
  value.write('data', 36); value.writeUInt32LE(4, 40); return value;
}
async function closed(handle: FileHandle): Promise<void> {
  await assert.rejects(handle.stat(), (error: NodeJS.ErrnoException) => error.code === 'EBADF');
}

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary) && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'), 'fixture必须使用外置任务临时目录。');
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-first-scan-'));
  const media = path.join(directory, '原音乐库'), other = path.join(directory, '另一原目录'), file = path.join(directory, 'collection.sqlite');
  await mkdir(media, { mode: 0o700 }); await mkdir(other, { mode: 0o700 });
  await mkdir(path.join(media, '原专辑'), { mode: 0o700 });
  const bytes = wav(), audioFile = path.join(media, '原专辑', '原音轨.wav');
  await writeFile(audioFile, bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(other, '不属于本库.wav'), bytes, { flag: 'wx', mode: 0o600 });
  const capability = await authorizeSourceDirectory(media), choiceId = randomUUID(), context: LocalWorkbenchReadContext = {};
  let mainFd: FileHandle, repository: ReturnType<typeof createCollectionRepository>, alive = false, repositoryAcquired = false;
  const stats = { starts: 0, reads: 0, confirms: 0, originalReads: 0, revalidates: 0, revokes: 0, acquired: 0, released: 0,
    observedPhases: [] as dto.ScanJobRecord['phase'][] };
  let beforeInitial: (() => void | Promise<void>) | undefined, afterInitial: (() => void | Promise<void>) | undefined;
  let revokeGate: Promise<void> | undefined, revokeEntered: (() => void) | undefined, releaseRevoke: (() => void) | undefined, invalidationError = false;
  let workbench: ReturnType<typeof createLocalWorkbenchReadService>, completed: ReturnType<typeof createCompletedScanSnapshotView>;
  let runtime: ReturnType<typeof createLocalLibraryManagementRuntime>, scan: ReturnType<typeof createLocalScanCoordinator>;
  let legacy: ReturnType<typeof createLocalRelocationCoordinator>, domain: DomainParts;
  let admission: ReturnType<typeof createScanReadAdmission>, setupFailed = false, setupFailure: unknown;
  async function setup<T>(acquire: () => T | Promise<T>): Promise<T> {
    try { return await acquire(); } catch (error) { if (!setupFailed) { setupFailed = true; setupFailure = error; } throw error; }
  }
  const ownerFd = await open(media, 'r');
  // 第一个真实FD取得后立即注册；后续FD、SQLite或装配失败也完整收口已取得资源。
  t.after(async () => {
    const failures: unknown[] = setupFailed ? [setupFailure] : [];
    try { await closeComponents(); } catch (error) { failures.push(error); }
    const outcomes = await Promise.allSettled([ownerFd, mainFd].filter(handle => handle !== undefined).map(async handle => {
      const failures: unknown[] = [];
      try { if (handle.fd !== -1) await handle.close(); } catch (error) { failures.push(error); }
      try { await closed(handle); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'fixture原目录FD收口失败。', { cause: failures[0] });
    }));
    for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
    try { assert.equal(stats.acquired, stats.released); } catch (error) { failures.push(error); }
    try { assert.deepEqual(await readFile(audioFile), bytes); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'fixture收尾未完整通过。', { cause: failures[0] });
  });
  mainFd = await setup(() => open(media, 'r'));
  const entry = { binding: { kind: 'library' as const, revision: '1', issuedAtMs: performance.now() }, fd: ownerFd,
    active: true, ownerClosed: false, ui: { family: 'management' } };
  const approvedDirectories = new Map([[choiceId, entry]]), directoryClosures = new Map<string, Promise<void>>();
  const managementContexts = new WeakMap<object, { signal: AbortSignal; deadlineAtMs: number }>();
  managementContexts.set(context, { signal: new AbortController().signal, deadlineAtMs: performance.now() + 60_000 });
  repository = await setup(() => createCollectionRepository({ filePath: file, stagingRoot: path.join(directory, 'stage') })); repositoryAcquired = true; alive = true;
  const identity = { datasetId: randomUUID(), assertCurrent() { assert.ok(alive); repository.list({ offset: 0, limit: 1 }); } };
  const ownerCurrent = (ownerContext?: { signal?: AbortSignal; deadlineAtMs?: number }): void => {
    identity.assertCurrent(); if (ownerContext?.signal?.aborted || ownerContext?.deadlineAtMs !== undefined && performance.now() >= ownerContext.deadlineAtMs) throw new DatasetWorkbenchWireError('NOT_READY');
  };
  async function roots(): Promise<dto.LocalRootView[]> {
    const values: dto.LocalRootView[] = [];
    for (const root of repository.localCatalog.roots()) {
      const source = repository.sources.root(root.sourceRootId);
      values.push({ root, label: source.label, availability: await sourceRootAvailability(source) });
    }
    return values;
  }
  async function scope() {
    return { revision: localLibraryManagementDigest([identity.datasetId, repository.localCatalog.privateAlbumBrowserRevision(), repository.localScan.privateAlbumBrowserRevision(), null]), roots: await roots() };
  }
  async function assemble(): Promise<void> {
    repository.localCatalog.privateBindWorkbenchDataset(identity);
    const settings = repository.localCatalog.privateScanSettingsStore(identity);
    completed = createCompletedScanSnapshotView({ repository, identity });
    admission = createScanReadAdmission({ isBusy: () => false });
    const scanContext = { datasetId: identity.datasetId, epoch: randomUUID() };
    const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') { assert.deepEqual(payload, {}); result = admission.acquire(scanContext); }
      else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(scanContext, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = admission.release(scanContext, (payload as { permitId: string }).permitId);
      else throw new Error('本fixture仅允许原扫描三投影。');
      return result as DatasetProjectionCommandResults[K];
    } };
    const reader: MetadataReaderPort = {
      async read(input, signal = new AbortController().signal): Promise<MetadataReadResult> {
        stats.reads++;
        assert.equal(input.root.path, media); assert.equal(input.relative, '原专辑/原音轨.wav');
        return withCheckedReadonlyMetadataSource<MetadataReadResult>(input.root, input.relative, input.expectedSignature, signal, async (handle, size) => {
          assert.equal(size, bytes.length); const header = Buffer.alloc(44), actual = await handle.read(header, 0, header.length, 0);
          assert.equal(actual.bytesRead, 44); assert.deepEqual(header, bytes.subarray(0, 44));
          // 有限reader提供受控标签；原扫描Walk、FD身份/关闭、catalog落账仍真实执行。
          return { status: 'ok', parserVersion: METADATA_PARSER_VERSION, fields: { title: '原音轨', artist: '合成作者', album: '原专辑' },
            technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48_000, channels: 2, bitsPerSample: 16, durationSeconds: 1 / 48_000, evidence: 'bounded-parser-reported' },
            coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } };
        }, input.assertCurrent, event => { if (event.type === 'lease-acquired') stats.acquired++; else stats.released++; });
      },
      async close() {},
    };
    scan = createLocalScanCoordinator({ repository, datasetId: identity.datasetId, identity, settings, assertCurrent: identity.assertCurrent, projection, reader,
      cueReader: { async read() { throw new Error('本fixture无CUE，不得启动sidecar reader。'); }, async close() {} },
      async onCompleted(job) { completed.captureCompleted(job.jobId); } });
    const trackedScan = { ...scan,
      start(request: dto.LocalScanStartRequest) { stats.starts++; return scan.start(request); },
      get(jobId: string) { const current = scan.get(jobId); stats.observedPhases.push(current.phase); return current; },
    };
    domain = await domainParts({ assertOpen: ownerCurrent, workbenchDto: dto, LocalWorkbenchPlanError, DatasetWorkbenchWireError,
      localScan: trackedScan, collection: repository, identity, sourceRootAvailability, scanBootReady: true,
      approvedDirectories, directoryClosures, options: { sourceWritesMainActor: {} }, managementContexts,
      assertWorkbench: ownerCurrent, lyricsPhysicalDigest, datasetWorkbenchJson, datasetWorkbenchSha,
      async stopRoleProbe() {},
      async requestWorkbenchDirectoryApproval(_actor: unknown, action: string) {
        assert.equal(action, 'revoke'); stats.revokes++; revokeEntered?.(); await revokeGate;
        await mainFd.close(); await closed(mainFd);
      },
      invalidateSourceWorkbenchDirectory() { if (invalidationError) throw new Error('受控原关闭后的失效回执拒绝。'); },
      async revalidateDirectory(id: string) {
        assert.equal(id, choiceId); stats.revalidates++; ownerCurrent(); await ownerFd.stat(); await mainFd.stat();
        return { id: choiceId, ...capability };
      },
    });
    legacy = createLocalRelocationCoordinator({ repository, assertCurrent: identity.assertCurrent,
      async onRegistered(request, root) { await beforeInitial?.(); await domain.legacyOnRegistered(request, root); await afterInitial?.(); } });
    workbench = createLocalWorkbenchReadService({ datasetId: identity.datasetId, repository, assertCurrent: identity.assertCurrent, readRootViews: roots,
      localAlbums: { inspectAlbum() { throw new Error('导入fixture不捕获专辑。'); } } });
    runtime = createLocalLibraryManagementRuntime({ identity, catalog: repository.localCatalog, localScan: repository.localScan, workbench,
      localAlbums: { async queryAlbums(request) { return repository.localCatalog.privateAlbumBrowserQuery(request, await scope()); } },
      readRootViews: roots, assertAccepting: ownerCurrent, completedSnapshots: completed,
      imports: {
        async prepare() { return { choiceId, label: '原音乐库', suggestedRole: 'catalog', evidence: ['受控Main审批适配；不是实际Main授权'] }; },
        async confirm(request, readContext) { stats.confirms++; return domain.imports.confirm(request, readContext); },
        async readOriginal(commandId, readContext) { stats.originalReads++; return domain.imports.readOriginal(commandId, readContext); },
      },
      async startInitialScan(commandId, root, readContext) {
        await beforeInitial?.(); await domain.startCallback(commandId, root, readContext); await afterInitial?.();
      },
    });
  }
  async function closeComponents(): Promise<void> {
    const failures: unknown[] = [];
    try { releaseRevoke?.(); } catch (error) { failures.push(error); }
    for (const close of [() => runtime?.close(), () => workbench?.close(), () => scan?.close(), () => legacy?.close(), () => completed?.close(), () => admission?.close()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    try { if (admission) assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true }); } catch (error) { failures.push(error); }
    try { if (repositoryAcquired) repository.close(); } catch (error) { failures.push(error); } finally { repositoryAcquired = false; alive = false; }
    if (failures.length) throw new AggregateError(failures, 'fixture原组件收口失败。', { cause: failures[0] });
  }
  await setup(assemble);
  const request = (commandId = randomUUID()): Confirm => ({ commandId, choiceId, role: 'catalog' });
  function operation(original: LocalLibraryManagementOriginalOperation, libraryIds: string[] = []): LocalLibraryManagementOperationRecord {
    return { schema: 1, kind: 'operation', datasetId: identity.datasetId, key: original.request.commandId, revision: 1,
      original, originalSha256: localLibraryManagementDigest(original), receipt: { commandId: original.request.commandId, kind: original.command, state: 'running', libraryIds, message: null } };
  }
  function seedImport(input: Confirm, historic = false): dto.LibraryRoot {
    const source = repository.sources.authorize(input.commandId, capability);
    const root = repository.localCatalog.registerRoot({ commandId: input.commandId, sourceRootId: source.id, role: 'library' });
    const record = operation({ command: 'library.import.confirm', request: input });
    if (historic) {
      record.receipt = { ...record.receipt, state: 'succeeded', libraryIds: [root.id] };
      const binding: LocalLibraryManagementBindingRecord = { schema: 1, kind: 'binding', datasetId: identity.datasetId, key: root.id, revision: 1,
        libraryId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, role: input.role, name: '历史已成功库', active: true, watchEnabled: false, operationId: input.commandId };
      repository.localCatalog.privateLibraryManagementCompareAndSwap(identity, [{ record: binding, expectedRevision: null }, { record, expectedRevision: null }]);
    } else repository.localCatalog.privateLibraryManagementCompareAndSwap(identity, [{ record, expectedRevision: null }]);
    return root;
  }
  return { directory, media, other, file, identity, choiceId, context, capability, entry, ownerFd, mainFd, stats, request, seedImport,
    get repository() { return repository; }, get runtime() { return runtime; }, get scan() { return scan; }, get legacy() { return legacy; }, get domain() { return domain; }, get completed() { return completed; },
    get closure() { return directoryClosures.get(choiceId); },
    confirm(input: Confirm) { return runtime.execute('library.import.confirm', input, context); },
    recover(input: Confirm) { return runtime.execute('library.operation.read', { commandId: input.commandId }, context); },
    setHooks(before?: () => void | Promise<void>, after?: () => void | Promise<void>) { beforeInitial = before; afterInitial = after; },
    async wait(commandId: string) { const receipt = repository.localScan.receipt(commandId); assert.ok(receipt); await scan.privateWait(receipt.jobId); return repository.localScan.get(receipt.jobId); },
    jobs() { return repository.localScan.page(identity.datasetId, { offset: 0, limit: 200 }); },
    async cold() {
      await domain.consumeLibraryDirectory(choiceId); await closed(ownerFd); await closed(mainFd);
      await closeComponents(); approvedDirectories.clear(); directoryClosures.clear();
      repository = await setup(() => createCollectionRepository({ filePath: file, stagingRoot: path.join(directory, 'stage') })); repositoryAcquired = true; alive = true; await setup(assemble);
    },
    deferRevoke() { let release!: () => void, entered!: () => void; const observed = new Promise<void>(resolve => { entered = resolve; }); revokeEntered = entered; revokeGate = new Promise<void>(resolve => { release = resolve; }); releaseRevoke = release; return { observed, release }; },
    rejectInvalidation() { invalidationError = true; },
    forgetChoice() { approvedDirectories.delete(choiceId); },
    markRemoving(root: dto.LibraryRoot) {
      const commandId = randomUUID(), record = operation({ command: 'library.remove', request: { commandId, libraryIds: [root.id] } }, [root.id]);
      repository.localCatalog.privateLibraryManagementCompareAndSwap(identity, [{ record, expectedRevision: null }]);
    },
  };
}

test('首次扫描原命令：legacy新注册与unknown恢复复用原导入ID，历史succeeded及取消不补动作', { timeout: 15_000 }, async t => {
  const f = await fixture(t), commandId = randomUUID();
  let picks = 0, executions = 0, fail = true;
  f.setHooks(() => { if (fail) { fail = false; throw new Error('原Root已提交，扫描前响应中断。'); } });
  // 仅适配原Main的私有Supervisor端口；不创建Main、Utility或原生对话框。
  const supervisor = {
    async request(command: string) { assert.equal(command, 'commandOutbox.context'); return { datasetId: f.identity.datasetId }; },
    async requestInternal(command: string, payload: Record<string, string>, datasetId: string) {
      assert.equal(datasetId, f.identity.datasetId);
      if (command === 'recordingSources.rootReceipt') return { root: f.repository.sources.rootReceipt(payload.commandId!) ?? null };
      if (command === 'recordingSources.authorize') return f.repository.sources.authorize(payload.commandId!, await authorizeSourceDirectory(payload.absolutePath!));
      if (command === 'localRelocation.registerRoot') return f.legacy.registerRoot({ commandId: payload.commandId!, sourceRootId: payload.sourceRootId! });
      throw new Error('未批准的私有请求。');
    },
    async activateRestoredDataset() { throw new Error('本fixture不激活工作库。'); },
  } as unknown as Parameters<typeof createCommandOutboxExecutor>[0]['supervisor'];
  const executor = createCommandOutboxExecutor({ supervisor, async pick() { picks++; return { canceled: false, filePaths: [f.media] }; } });
  const store = createCommandOutboxStore({ filePath: path.join(f.directory, 'outbox.sqlite') });
  const service = createCommandOutboxService({ store, currentDataset: async () => f.identity.datasetId, async execute(entry) { executions++; return executor.execute(entry); } });
  t.after(() => service.close());
  const input: dto.CommandOutboxRequest = { datasetId: f.identity.datasetId, command: 'localLibrary.chooseRoot', payload: { commandId } };
  await assert.rejects(service.submit(input)); assert.equal(f.repository.localCatalog.roots().length, 1); assert.equal(f.jobs().total, 0);
  const uncertain = store.list().find(entry => entry.commandId === commandId)!; assert.equal(uncertain.state, 'uncertain');
  const restored = await service.retry({ id: uncertain.id, userConfirmed: true }); assert.ok(dto.isLibraryRoot(restored.result));
  const completed = await f.wait(commandId); assert.equal(completed.phase, 'completed'); assert.equal(completed.progress.accepted, '1');
  assert.equal(f.stats.starts, 1); assert.equal(f.jobs().total, 1); assert.equal(picks, 1); assert.equal(executions, 2);
  assert.deepEqual(await service.submit(input), restored); assert.equal(executions, 2); assert.equal(f.jobs().total, 1);
  const oldCommand = randomUUID(), oldSource = f.repository.sources.authorize(oldCommand, await authorizeSourceDirectory(f.other));
  const oldRoot = f.repository.localCatalog.registerRoot({ commandId: oldCommand, sourceRootId: oldSource.id, role: 'library' });
  const historic: dto.CommandOutboxRequest = { datasetId: f.identity.datasetId, command: 'localLibrary.chooseRoot', payload: { commandId: oldCommand } };
  const old = store.confirm(historic).entry; store.markSending(old.id); store.succeed(old.id, oldRoot);
  assert.deepEqual((await service.submit(historic)).result, oldRoot); assert.equal(executions, 2); assert.equal(f.repository.localScan.receipt(oldCommand), null);
  const cancelledId = randomUUID(), cancelled = createCommandOutboxExecutor({ supervisor, async pick() { return { canceled: true, filePaths: [] }; } });
  const cancelStore = createCommandOutboxStore({ filePath: path.join(f.directory, 'cancel-outbox.sqlite') });
  const cancelService = createCommandOutboxService({ store: cancelStore, currentDataset: async () => f.identity.datasetId, execute: entry => cancelled.execute(entry) }); t.after(() => cancelService.close());
  assert.equal((await cancelService.submit({ datasetId: f.identity.datasetId, command: 'localLibrary.chooseRoot', payload: { commandId: cancelledId } })).result, null);
  assert.equal(f.repository.sources.rootReceipt(cancelledId), undefined); assert.equal(f.repository.localCatalog.receipt(cancelledId), null); assert.equal(f.repository.localScan.receipt(cancelledId), null);
});

test('首次扫描原命令：工作台先join原选择两个FD再扫描同库，重复确认不新建job', { timeout: 15_000 }, async t => {
  const f = await fixture(t), input = f.request(), revoke = f.deferRevoke();
  const flight = f.confirm(input); await revoke.observed;
  assert.equal(f.repository.localCatalog.roots().length, 1); assert.equal(f.jobs().total, 0); assert.equal(f.stats.starts, 0);
  await f.ownerFd.stat(); await f.mainFd.stat();
  revoke.release(); const receipt = await flight; assert.equal(receipt.state, 'succeeded');
  await closed(f.ownerFd); await closed(f.mainFd);
  const root = f.repository.localCatalog.root(receipt.libraryIds[0]!), completed = await f.wait(input.commandId);
  assert.equal(completed.phase, 'completed'); assert.equal(completed.libraryRootId, root.id); assert.equal(completed.rootRevision, root.revision);
  assert.equal(f.repository.localScan.receipt(input.commandId)?.commandId, input.commandId); assert.equal(f.jobs().total, 1);
  assert.deepEqual(completed.progress, { visited: '1', accepted: '1', rejected: '0' });
  assert.equal(f.repository.localCatalog.queryTracks({ rootId: root.id, query: '', offset: 0, limit: 10 }).total, 1);
  const read = await f.runtime.execute('library.read', {}, f.context); assert.equal(read.libraries[0]?.totalTracks, 1); assert.equal(read.libraries[0]?.scanState, 'complete');
  assert.deepEqual(await f.confirm(input), receipt); assert.equal(f.stats.starts, 1); assert.equal(f.stats.reads, 1); assert.equal(f.stats.confirms, 1); assert.equal(f.stats.revokes, 1);
  await assert.rejects(f.confirm({ ...input, role: 'album' })); assert.equal(f.jobs().total, 1);
});

test('首次扫描原命令：Root已提交但scan未创建，以及已launch未落binding都补原阶段', { timeout: 15_000 }, async t => {
  for (const stop of ['before-start', 'after-launch'] as const) {
    const f = await fixture(t), input = f.request(); let once = true;
    const interrupt = () => { if (once) { once = false; throw new Error('受控原阶段回执遗失。'); } };
    f.setHooks(stop === 'before-start' ? interrupt : undefined, stop === 'after-launch' ? interrupt : undefined);
    assert.equal((await f.confirm(input)).state, 'unknown');
    const root = f.repository.localCatalog.roots()[0]!; assert.ok(root); assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity, 'binding', root.id), null);
    assert.equal(f.stats.confirms, 1); assert.equal(f.stats.revokes, 1);
    const receiptBefore = f.repository.localScan.receipt(input.commandId);
    if (stop === 'before-start') { assert.equal(receiptBefore, null); assert.equal(f.jobs().total, 0); }
    else { assert.ok(receiptBefore); assert.equal((await f.wait(input.commandId)).phase, 'completed'); }
    const recovered = await f.recover(input); assert.equal(recovered?.state, 'succeeded');
    const current = await f.wait(input.commandId); assert.equal(current.phase, 'completed'); assert.equal(f.jobs().total, 1);
    assert.equal(f.stats.starts, 1); assert.equal(f.stats.reads, 1); assert.equal(f.stats.confirms, 1); assert.equal(f.stats.revalidates, 1);
    assert.equal(f.stats.originalReads, 1); assert.equal(f.stats.revokes, 1);
    if (receiptBefore) { assert.deepEqual(f.repository.localScan.receipt(input.commandId), receiptBefore); assert.equal(current.jobId, receiptBefore.jobId); assert.equal(f.stats.observedPhases.at(-1), 'completed'); }
  }
});

test('首次扫描原命令：真实预落pending及冷running暂停只关联同job，不重放当前parser或launch', { timeout: 15_000 }, async t => {
  for (const phase of ['pending', 'running'] as const) {
    const f = await fixture(t), input = f.request(), root = f.seedImport(input);
    // 真正提交原Store start，再关闭重开；不是beforeCommit异常冒充创建后断点。
    const original = f.repository.localScan.start({ commandId: input.commandId, datasetId: f.identity.datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: '原旧解析合同-v1' }).job;
    if (phase === 'running') f.repository.localScan.resume({ commandId: randomUUID(), jobId: original.jobId, expectedRevision: original.jobRevision });
    const receipt = f.repository.localScan.receipt(input.commandId); await f.cold();
    const expected = phase === 'pending' ? 'pending' : 'paused'; assert.equal(f.repository.localScan.get(original.jobId).phase, expected);
    assert.equal((await f.recover(input))?.state, 'succeeded');
    assert.deepEqual(f.repository.localScan.receipt(input.commandId), receipt); assert.equal(f.repository.localScan.privateJobParserVersion(original.jobId), '原旧解析合同-v1');
    assert.equal(f.repository.localScan.get(original.jobId).phase, expected); assert.equal(f.jobs().total, 1); assert.equal(f.stats.starts, 0); assert.equal(f.stats.reads, 0);
    assert.equal(f.stats.confirms, 0); assert.equal(f.stats.revalidates, 0); assert.equal(f.stats.revokes, 1); assert.equal(f.stats.observedPhases.at(-1), expected);
    const read = await f.runtime.execute('library.read', {}, f.context); assert.equal(read.libraries[0]?.scanState, phase === 'pending' ? 'queued' : 'paused'); assert.equal(read.libraries[0]?.totalTracks, 0);
  }
});

test('首次扫描原命令：历史工作台succeeded与已撤选择不补扫，新阶段拒绝Root修订/撤库/撤权', { timeout: 15_000 }, async t => {
  const historic = await fixture(t), old = historic.request(), oldRoot = historic.seedImport(old, true);
  const saved = historic.repository.localCatalog.privateLibraryManagementRead(historic.identity, 'operation', old.commandId)!.record.receipt;
  assert.deepEqual(await historic.confirm(old), saved); assert.deepEqual(await historic.recover(old), saved);
  assert.equal(historic.repository.localScan.receipt(old.commandId), null); assert.equal(historic.stats.starts, 0); assert.equal(historic.stats.originalReads, 0); assert.equal(historic.stats.confirms, 0);
  assert.equal(historic.repository.localCatalog.root(oldRoot.id).id, oldRoot.id);
  const cancelled = await fixture(t), cancel = cancelled.request(); cancelled.entry.active = false;
  assert.equal((await cancelled.confirm(cancel)).state, 'unknown'); assert.equal(cancelled.repository.localCatalog.roots().length, 0); assert.equal(cancelled.jobs().total, 0); assert.equal(cancelled.stats.revalidates, 0);
  for (const change of ['revision', 'removing', 'revoked'] as const) {
    const f = await fixture(t), input = f.request(), root = f.seedImport(input); await f.domain.consumeLibraryDirectory(f.choiceId);
    if (change === 'revision') {
      const next = f.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(f.other));
      f.repository.localCatalog.relinkRoot({ commandId: randomUUID(), rootId: root.id, expectedRevision: root.revision, sourceRootId: next.id, role: 'library' });
    } else if (change === 'removing') f.markRemoving(root);
    else f.repository.sources.revoke({ commandId: randomUUID(), id: root.sourceRootId });
    assert.equal((await f.recover(input))?.state, 'unknown'); assert.equal(f.jobs().total, 0); assert.equal(f.stats.starts, 0); assert.equal(f.stats.confirms, 0); assert.equal(f.stats.revalidates, 0);
    assert.ok(f.repository.localCatalog.receipt(input.commandId)); assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity, 'binding', root.id), null);
  }
});

test('首次扫描原命令：await扫描关联后Root改变不落成功binding，原扫描仍留原修订', { timeout: 15_000 }, async t => {
  const f = await fixture(t), input = f.request(); let original: dto.LibraryRoot | undefined;
  f.setHooks(undefined, async () => {
    original = f.repository.localCatalog.roots()[0]!; await f.wait(input.commandId);
    assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity, 'binding', original.id), null);
    assert.equal(f.completed.load(original.id).status, 'ready', '小目录在成功binding前完成仍可由原Root/settings/batches生成快照。');
    const target = f.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(f.other));
    f.repository.localCatalog.relinkRoot({ commandId: randomUUID(), rootId: original.id, expectedRevision: original.revision, sourceRootId: target.id, role: 'library' });
  });
  assert.equal((await f.confirm(input)).state, 'unknown'); assert.ok(original);
  const job = f.jobs().items[0]!; assert.equal(job.rootRevision, original.revision); assert.notEqual(f.repository.localCatalog.root(original.id).revision, original.revision);
  assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity, 'binding', original.id), null); assert.equal(f.stats.starts, 1);
  f.setHooks(); assert.equal((await f.recover(input))?.state, 'unknown'); assert.equal(f.stats.starts, 1); assert.equal(f.jobs().total, 1);
});

test('首次扫描原命令：关闭Promise同一在途与既有拒绝均须join，ownerClosed也不能洗成成功', { timeout: 15_000 }, async t => {
  const unclosed = await fixture(t), prior = unclosed.request(), priorRoot = unclosed.seedImport(prior);
  assert.equal(unclosed.closure, undefined); assert.equal((await unclosed.recover(prior))?.state, 'succeeded');
  assert.equal(unclosed.stats.confirms, 0); assert.equal(unclosed.stats.revalidates, 0); assert.equal(unclosed.stats.revokes, 1);
  await closed(unclosed.ownerFd); await closed(unclosed.mainFd); assert.equal((await unclosed.wait(prior.commandId)).libraryRootId, priorRoot.id);
  const f = await fixture(t), input = f.request(), root = f.seedImport(input), revoke = f.deferRevoke();
  const originalClose = f.domain.consumeLibraryDirectory(f.choiceId); await revoke.observed;
  assert.equal(f.closure, originalClose); assert.equal(f.domain.consumeLibraryDirectory(f.choiceId), originalClose);
  const recovering = f.recover(input); assert.equal(f.jobs().total, 0); assert.equal(f.stats.starts, 0); assert.equal(f.stats.revokes, 1);
  f.rejectInvalidation(); revoke.release(); await assert.rejects(originalClose);
  assert.equal((await recovering)?.state, 'unknown'); await closed(f.ownerFd); await closed(f.mainFd); assert.equal(f.entry.ownerClosed, true); assert.equal(f.entry.active, false);
  // Map OR不能因entry消失或ownerClosed绕过原拒绝；原Promise不可删除、替换或重close。
  f.forgetChoice();
  assert.equal(f.domain.consumeLibraryDirectory(f.choiceId), originalClose); assert.equal((await f.recover(input))?.state, 'unknown');
  assert.equal(f.closure, originalClose); assert.equal(f.stats.revokes, 1); assert.equal(f.jobs().total, 0); assert.equal(f.stats.starts, 0);
  assert.equal(f.repository.localCatalog.root(root.id).id, root.id); assert.equal(f.repository.localCatalog.privateLibraryManagementRead(f.identity, 'binding', root.id), null);
});
