import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOBILE_API_RESPONSE_MAX_BYTES, MOBILE_OPERATION_TABLE, decodeMobileResponse,
  mapMobileFileAudioParameters, mobileCanonicalJson, validateIpcInternalRequest, validateIpcInternalResponseForCommand, validateIpcResponseForCommand,
  type IpcCommand, type IpcCommandPayloads, type IpcCommandResults, type IpcInternalCommand, type IpcRequest,
  type MobileAlbum, type MobileAlbumPage, type MobileErrorEnvelope, type MobileHeaderPairs,
  type MobileJsonValue, type MobileOperationId, type MobilePairingClaim, type MobileReplyMap,
  type MobileTokenPair, type MobileTrack, type MobileTrackPage, type SourceRoot,
} from '@music-bridge/contracts';
import type {
  DatasetOwnerFatalReason, DatasetOwnerIdentity, DatasetOwnerProjectionHandler,
  DatasetOwnerRequest, DatasetProjectionCommandResults,
} from '../../src/collection/dataset-owner-protocol.js';
import type {
  Mobile001Backend, MobileAuthPersistence, MobileAuthService, MobileOwnerCatalogSnapshot,
  MobileOwnerPrivateRequest, MobileOwnerPrivateResult, MobilePrincipal,
} from '../../src/mobile/types.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fullValue = <T>(value: T): T => JSON.parse(mobileCanonicalJson(value as unknown as MobileJsonValue)) as T;

/** 只用只读文件描述符核字节；不创建额外 SQLite 连接或向数据库注入事实。 */
async function wholeFile(file: string, maximum = 64 * 1024 * 1024) {
  assert.equal(await realpath(file), file, '本用例只接受自己的真实路径。');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assert.equal(before.isFile(), true); assert.equal(before.nlink, 1n);
    assert.ok(before.size > 0n && before.size <= BigInt(maximum));
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    const axes = (s: typeof before) => [s.dev, s.ino, s.size, s.mode, s.uid, s.gid, s.nlink, s.mtimeNs, s.ctimeNs];
    assert.deepEqual(axes(after), axes(before)); assert.deepEqual(axes(named), axes(before));
    assert.equal(named.isSymbolicLink(), false); assert.equal(bytes.length, Number(before.size));
    return { bytes, sha256: digest(bytes), stat: before };
  } finally { await handle.close(); }
}

interface PreparedFile { path: string; bytes: number; sha256: string }
interface PreparedOutput extends PreparedFile { sourcePath?: string; sourceSha256?: string; mtimeMs: number }
interface Preparation {
  schema: string; status: string; readerBindingSha256: string;
  sourceInputs: PreparedFile[]; outputs: PreparedOutput[];
  stages: { name: string; compilerExit: number; startedMs: number; finishedMs: number }[];
  inputsUnchanged: boolean; outputsUnchanged: boolean;
}

let moduleFlight: ReturnType<typeof loadCoreModules> | undefined;
async function loadCoreModules() {
  // Reader helper核原固定Worker；新增Owner/mobile模块再核同轮完整准备收据中的实际产物。
  await loadFreshMetadataReader();
  const bindingFile = process.env.MBRS003_READER_BUILD_BINDING;
  assert.ok(bindingFile && path.isAbsolute(bindingFile), 'Root必须提供真正fresh Reader绑定。');
  const binding = await wholeFile(bindingFile, 16 * 1024 * 1024);
  const preparation = JSON.parse((await wholeFile(path.join(path.dirname(bindingFile), 'preparation-receipt.json'), 16 * 1024 * 1024)).bytes.toString('utf8')) as Preparation;
  assert.equal(preparation.schema, 'core-test.reader-preparation.v1'); assert.equal(preparation.status, 'FRESH_READER_PREPARED');
  assert.equal(preparation.readerBindingSha256, binding.sha256); assert.equal(preparation.inputsUnchanged, true); assert.equal(preparation.outputsUnchanged, true);
  assert.equal(new Set(preparation.sourceInputs.map(row => row.path)).size, preparation.sourceInputs.length);
  assert.equal(new Set(preparation.outputs.map(row => row.path)).size, preparation.outputs.length);
  const stage = preparation.stages.find(row => row.name === 'fresh-core-compiler');
  assert.ok(stage); assert.equal(stage.compilerExit, 0);
  assert.ok(Number.isSafeInteger(stage.startedMs) && stage.startedMs > 0 && stage.finishedMs >= stage.startedMs);
  const modules = ['collection/dataset-owner-client', 'collection/dataset-owner-protocol', 'collection/dataset-owner-worker',
    'collection/dataset-domain', 'mobile/types', 'mobile/owner-protocol', 'mobile/owner-service', 'mobile/sealed-state-store',
    'mobile/auth-service', 'mobile/auth-crypto', 'mobile/catalog-service', 'mobile/cursor', 'library/scan-read-admission'];
  const checked: PreparedFile[] = [];
  for (const module of modules) {
    const sourcePath = `packages/bridge-core/src/${module}.ts`, source = preparation.sourceInputs.find(row => row.path === sourcePath);
    assert.ok(source); checked.push(source);
    for (const extension of ['.js', '.js.map', '.d.ts']) {
      const outputPath = `packages/bridge-core/dist/${module}${extension}`, output = preparation.outputs.find(row => row.path === outputPath);
      assert.ok(output); assert.equal(output.sourcePath, sourcePath); assert.equal(output.sourceSha256, source.sha256);
      assert.ok(output.mtimeMs >= stage.startedMs && output.mtimeMs <= stage.finishedMs);
      const actual = await wholeFile(path.join(repositoryRoot, outputPath));
      assert.ok(actual.stat.mtimeNs >= BigInt(stage.startedMs) * 1_000_000n && actual.stat.mtimeNs <= BigInt(stage.finishedMs) * 1_000_000n);
      checked.push(output);
    }
  }
  // Main工厂由tsx运行真实源文件，不能把它们称为已构建Electron Main产物。
  for (const sourcePath of ['apps/desktop/src/main/mobile-backend.ts', 'apps/desktop/src/main/mobile-https-server.ts', 'apps/desktop/src/main/mobile-tls-identity.ts']) {
    const source = preparation.sourceInputs.find(row => row.path === sourcePath); assert.ok(source); checked.push(source);
  }
  async function assertBoundBytes(): Promise<void> {
    assert.equal((await wholeFile(bindingFile!, 16 * 1024 * 1024)).sha256, binding.sha256);
    for (const row of checked) {
      const actual = await wholeFile(path.join(repositoryRoot, row.path));
      assert.equal(actual.bytes.length, row.bytes); assert.equal(actual.sha256, row.sha256);
    }
  }
  await assertBoundBytes();
  const owner = await import(new URL('../../dist/collection/dataset-owner-client.js', import.meta.url).href) as typeof import('../../src/collection/dataset-owner-client.js');
  const protocol = await import(new URL('../../dist/collection/dataset-owner-protocol.js', import.meta.url).href) as typeof import('../../src/collection/dataset-owner-protocol.js');
  const admission = await import(new URL('../../dist/library/scan-read-admission.js', import.meta.url).href) as typeof import('../../src/library/scan-read-admission.js');
  const mobileProtocol = await import(new URL('../../dist/mobile/owner-protocol.js', import.meta.url).href) as typeof import('../../src/mobile/owner-protocol.js');
  const auth = await import(new URL('../../dist/mobile/auth-service.js', import.meta.url).href) as typeof import('../../src/mobile/auth-service.js');
  const crypto = await import(new URL('../../dist/mobile/auth-crypto.js', import.meta.url).href) as typeof import('../../src/mobile/auth-crypto.js');
  const types = await import(new URL('../../dist/mobile/types.js', import.meta.url).href) as typeof import('../../src/mobile/types.js');
  await assertBoundBytes(); return { owner, protocol, admission, mobileProtocol, auth, crypto, types, assertBoundBytes };
}
const coreModules = () => moduleFlight ??= loadCoreModules();
type CoreModules = Awaited<ReturnType<typeof coreModules>>;

async function fixture(t: TestContext) {
  const files = await audioFixture(t), modules = await coreModules();
  const cleanup: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of [...cleanup].reverse()) try { await close(); } catch (error) { errors.push(error); }
    try { await modules.assertBoundBytes(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '真实Owner/HTTPS测试的关闭或输入身份未完全核实。');
  });
  async function directory(name: string) {
    const value = path.join(files.directory, name); await mkdir(value, { mode: 0o700 }); await chmod(value, 0o700); return value;
  }
  return { files, modules, cleanup, directory };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function owner(f: Fixture, dataDirectory: string) {
  const lifecycle = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT));
  const admission = f.modules.admission.createScanReadAdmission({ isBusy: () => false });
  let identity: DatasetOwnerIdentity | undefined, alive = true;
  const projection: DatasetOwnerProjectionHandler = async (command, payload, context) => {
    assert.ok(identity); assert.equal(context.epoch, identity.epoch); assert.equal(context.datasetId, identity.datasetId);
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(identity);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(identity, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(identity, (payload as { permitId: string }).permitId);
    else throw new Error('自有库测试没有Roon、Provider或播放投影。');
    return result as DatasetProjectionCommandResults[typeof command];
  };
  const worker = new Worker(new URL('../helpers/dataset-owner-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { mode: 'scan-real', dataDirectory, lifecycle: lifecycle.buffer },
  });
  const fatal: DatasetOwnerFatalReason[] = [], exits: number[] = [];
  worker.once('exit', code => { exits.push(code); });
  const endpoint = f.modules.owner.createDatasetOwnerClient({ worker, projection, onFatal: reason => fatal.push(reason) });
  assert.ok(endpoint.mobileMain); const requestMobile = endpoint.mobileMain;
  let closeFlight: Promise<void> | undefined;
  function currentIdentity(): DatasetOwnerIdentity { assert.ok(identity); return identity; }
  function close(): Promise<void> {
    if (closeFlight) return closeFlight; alive = false;
    closeFlight = (async () => {
      try { await endpoint.close(); }
      catch (error) { if (worker.threadId !== -1) await worker.terminate(); throw error; }
      finally { admission.close(); }
      assert.equal(worker.threadId, -1, 'close必须等待真实Worker退出。'); assert.deepEqual(exits, [0]); assert.deepEqual(fatal, []);
      assert.equal(Atomics.load(lifecycle, 0), Atomics.load(lifecycle, 3));
      assert.equal(Atomics.load(lifecycle, 1), Atomics.load(lifecycle, 2));
      assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
    })(); return closeFlight;
  }
  f.cleanup.push(close);
  async function prepare() { identity = await endpoint.prepare(); return identity; }
  async function boot() { await prepare(); await endpoint.commitBoot(); return currentIdentity(); }
  async function mobile(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    const result = await requestMobile(request); assert.equal(f.modules.mobileProtocol.isMobileOwnerPrivateResult(result, request), true); return result;
  }
  async function command<C extends IpcCommand>(name: C, payload: IpcCommandPayloads[C], internal = false): Promise<IpcCommandResults[C]> {
    const request = { version: 1, id: randomUUID(), command: name, payload, expectedDatasetId: currentIdentity().datasetId } as IpcRequest;
    if (internal) {
      assert.equal(validateIpcInternalRequest(request).ok, true, '私有标记不能把普通请求升为可信命令。');
      const result = await endpoint.dispatchInternal!(request);
      const checked = validateIpcInternalResponseForCommand({ version: 1, id: request.id, ok: true, result }, name as IpcInternalCommand);
      assert.equal(checked.ok, true); if (!checked.ok || !checked.value.ok) throw new Error('真实Owner私有回包未通过原Main私有IPC合同。');
      return checked.value.result as IpcCommandResults[C];
    }
    const result = await endpoint.dispatch(request);
    const checked = validateIpcResponseForCommand({ version: 1, id: request.id, ok: true, result }, name);
    assert.equal(checked.ok, true); if (!checked.ok || !checked.value.ok) throw new Error('真实Owner回包未通过原IPC合同。');
    return checked.value.result;
  }
  async function authorizeSource(payload: IpcCommandPayloads['recordingSources.authorize']): Promise<SourceRoot> {
    const request = { version: 1, id: randomUUID(), command: 'recordingSources.authorize', payload,
      expectedDatasetId: currentIdentity().datasetId } as IpcRequest;
    // 原Owner接收可信源授权命令；Main用internal validator核SourceRoot，实际路径/卷身份仍留在Owner。
    const result = await endpoint.dispatch(request), response = { version: 1, id: request.id, ok: true, result };
    const checked = validateIpcInternalResponseForCommand(response, 'recordingSources.authorize');
    assert.equal(checked.ok, true); if (!checked.ok || !checked.value.ok) throw new Error('真实Owner源授权回包未通过原Main私有合同。');
    assert.equal(validateIpcResponseForCommand(response, 'recordingSources.authorize').ok, false, '私有源授权回包不能通过普通公开IPC校验。');
    const source = checked.value.result;
    assert.deepEqual(Reflect.ownKeys(source).sort(), ['authorized', 'availability', 'id', 'label']);
    assert.equal(source.authorized, true); assert.equal(source.availability, 'ONLINE');
    assert.equal(source.label, path.basename(await realpath(payload.absolutePath)));
    return source;
  }
  return { worker, endpoint, lifecycle, dataDirectory, prepare, boot, mobile, command, authorizeSource, close, identity: currentIdentity,
    assertCurrent() { assert.equal(alive && worker.threadId !== -1 && endpoint.isLocalSourceCurrent?.(), true); } };
}
type Owner = ReturnType<typeof owner>;
const notSent = (modules: CoreModules) => (error: unknown) => error instanceof modules.protocol.DatasetOwnerTransportError && error.outcome === 'not-sent';

function catalogRequest(o: Owner, serverId: string, expectedRevision: string | null = null): MobileOwnerPrivateRequest {
  return { kind: 'catalog', datasetId: o.identity().datasetId, request: { operation: 'listAlbums', serverId,
    offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision } };
}
async function seedScan(f: Fixture, o: Owner) {
  const media = await f.directory('media'), bytes = await f.files.bytes('core-wav');
  for (const name of ['first.wav', 'second.wav']) await writeFile(path.join(media, name), bytes, { flag: 'wx', mode: 0o600 });
  const source = await o.authorizeSource({ commandId: randomUUID(), absolutePath: media });
  const roots = await o.command('recordingSources.roots', {});
  assert.deepEqual(roots.roots.filter(candidate => candidate.id === source.id), [source]);
  const root = await o.command('localCatalog.registerRoot', { commandId: randomUUID(), sourceRootId: source.id, role: 'library' }, true);
  const started = await o.command('localScan.start', { commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  const deadline = performance.now() + 20_000;
  let scan = started;
  while (scan.phase !== 'completed') {
    assert.ok(performance.now() < deadline, '原真实Reader/扫描须在有限等待内完成。');
    assert.equal(scan.failureCode, null); assert.ok(['pending', 'running'].includes(scan.phase));
    await new Promise<void>(resolve => setTimeout(resolve, 5)); scan = await o.command('localScan.get', { jobId: started.jobId });
  }
  assert.equal(scan.datasetId, o.identity().datasetId); assert.deepEqual(scan.progress, { visited: '2', accepted: '2', rejected: '0' });
  const page = await o.command('localCatalog.pageTracks', { offset: 0, limit: 200 }); assert.equal(page.total, 2); assert.equal(page.items.length, 2);
  assert.equal(new Set(page.items.map(track => track.id)).size, 2); assert.equal(new Set(page.items.map(track => track.assetId)).size, 2);
  const details = await Promise.all(page.items.map(track => o.command('localCatalog.trackDetail', { trackId: track.id })));
  for (const detail of details) {
    assert.equal(detail.metadata.effective.title, f.files.entry('core-wav').expectedTags!.title);
    assert.equal(detail.metadata.effective.artist, f.files.entry('core-wav').expectedTags!.artist);
    assert.ok(detail.fileParameters); assert.equal(detail.fileParameters.sampleRateHz, 44_100); assert.equal(detail.fileParameters.channels, 2);
    assert.equal(detail.fileParameters.bitsPerSample, 16); assert.ok(detail.fileParameters.durationMs !== null && detail.fileParameters.durationMs > 0);
    assert.equal(detail.asset.libraryRootId, root.id); assert.equal(detail.asset.sourceRootId, source.id);
  }
  assert.equal(Atomics.load(o.lifecycle, 4), 2, '技术事实来自两次真实Reader完成。');
  return { media, bytes, details };
}

function ownerAuth(f: Fixture, o: Owner, serverId: string, key: Uint8Array) {
  let saves = 0;
  async function invoke(request: MobileOwnerPrivateRequest) {
    const result = await o.mobile(request);
    if ('kind' in result && result.kind === 'mobile-error') {
      if (result.outcome) throw new f.modules.types.MobileAuthPersistenceError(result.outcome);
      throw new f.modules.types.MobileServiceError(result.status, result.code, result.retryable);
    }
    return result;
  }
  const persistence: MobileAuthPersistence = {
    async load(datasetId) {
      const result = await invoke({ kind: 'load', datasetId });
      assert.ok('kind' in result && (result.kind === 'missing' || result.kind === 'sealed')); return result;
    },
    async save(request) {
      saves++; const result = await invoke({ kind: 'save', datasetId: o.identity().datasetId, request });
      assert.ok('kind' in result && (result.kind === 'saved' || result.kind === 'conflict')); return result;
    },
  };
  const auth = f.modules.auth.createMobileAuthService({ persistence, crypto: f.modules.crypto.createMobileAuthCrypto(key),
    serverId, datasetId: o.identity().datasetId, displayName: '自有Owner认证', environment: 'development' });
  f.cleanup.push(() => auth.close()); return { auth, saves: () => saves };
}

interface TlsIdentity { serverId: string; authKey: Buffer; privateKeyPEM: string; certificatePEM: string; certificateSha256: string }
interface MainFactories {
  createMobileBackend(options: { serverId: string; datasetId: string; authKey: Uint8Array; displayName: string; environment: 'development';
    requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult>; assertCurrent(): void;
    resizeArtwork(bytes: Uint8Array, size: 96 | 256 | 512): Uint8Array }): { backend: Mobile001Backend; auth: MobileAuthService; close(): Promise<void> };
}
interface HttpsFactory {
  createMobileHttpsServer(options: { tls: { key: string; cert: string }; host: string; port: number; backend: Mobile001Backend }): {
    start(): Promise<{ baseUrl: string; certificateSha256: string }>; close(): Promise<void>;
  };
}
interface IdentityFactory {
  loadOrCreateMobileIdentity(options: { directory: string; hosts: readonly string[]; secretProtector: {
    encryptString(value: string): Buffer; decryptString(value: Buffer): string;
  } }): Promise<TlsIdentity>;
}
async function mainFactories() {
  const backend = await import(new URL('../../../../apps/desktop/src/main/mobile-backend.ts', import.meta.url).href) as MainFactories;
  const https = await import(new URL('../../../../apps/desktop/src/main/mobile-https-server.ts', import.meta.url).href) as HttpsFactory;
  const tls = await import(new URL('../../../../apps/desktop/src/main/mobile-tls-identity.ts', import.meta.url).href) as IdentityFactory;
  return { ...backend, ...https, ...tls };
}
type Main = Awaited<ReturnType<typeof mainFactories>>;
async function httpsBackend(f: Fixture, o: Owner, factories: Main, identity: TlsIdentity) {
  const backend = factories.createMobileBackend({ serverId: identity.serverId, datasetId: o.identity().datasetId,
    authKey: new Uint8Array(identity.authKey), displayName: '自有真实Owner目录', environment: 'development',
    requestOwner: request => o.mobile(request), assertCurrent: () => o.assertCurrent(),
    resizeArtwork() { throw new Error('本用例不提供封面缩放假事实。'); } });
  f.cleanup.push(() => backend.close());
  const server = factories.createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM },
    host: '127.0.0.1', port: 0, backend: backend.backend });
  f.cleanup.push(() => server.close());
  const listening = await server.start(); assert.equal(listening.certificateSha256, identity.certificateSha256);
  assert.match(listening.baseUrl, /^https:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
  return { ...listening, backend, server, identity };
}
type HttpBackend = Awaited<ReturnType<typeof httpsBackend>>;
async function wire<O extends MobileOperationId>(h: HttpBackend, operation: O, target: string, options: {
  token?: string; body?: MobileJsonValue; key?: string;
} = {}): Promise<MobileReplyMap[O]> {
  const origin = new URL(h.baseUrl), finalUrl = new URL(target, h.baseUrl), body = options.body === undefined ? undefined : Buffer.from(mobileCanonicalJson(options.body));
  const headers: string[] = ['Host', origin.host, 'Connection', 'close'];
  if (options.token) headers.push('Authorization', `Bearer ${options.token}`);
  if (options.key) headers.push('Idempotency-Key', options.key);
  if (body !== undefined) headers.push('Content-Type', 'application/json', 'Content-Length', String(body.length));
  const raw = await new Promise<{ status: number; headers: MobileHeaderPairs; body: Uint8Array }>((resolve, reject) => {
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, path: target, method: MOBILE_OPERATION_TABLE[operation].method,
      headers, ca: h.identity.certificatePEM, agent: false,
      checkServerIdentity(host, certificate) {
        const standard = checkServerIdentity(host, certificate); if (standard) return standard;
        return digest(certificate.raw) === h.certificateSha256 ? undefined : new Error('本次实际证书DER不匹配固定pin。');
      },
    }, response => {
      const socket = response.socket as TLSSocket;
      try { assert.equal(socket.authorized, true); assert.equal(digest(socket.getPeerCertificate(true).raw), h.certificateSha256); }
      catch (error) { request.destroy(); reject(error); return; }
      const chunks: Buffer[] = []; let count = 0;
      response.on('data', (chunk: Buffer) => {
        count += chunk.length; if (count > MOBILE_API_RESPONSE_MAX_BYTES) { request.destroy(new Error('真实响应超过原2MiB边界。')); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.once('end', () => {
        const pairs: [string, string][] = [];
        for (let i = 0; i < response.rawHeaders.length; i += 2) pairs.push([response.rawHeaders[i]!, response.rawHeaders[i + 1]!]);
        resolve({ status: response.statusCode ?? 0, headers: pairs, body: new Uint8Array(Buffer.concat(chunks)) });
      });
      response.once('error', reject); response.once('aborted', () => reject(new Error('实际HTTPS响应未完整结束。')));
    });
    request.once('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('实际HTTPS请求超过有限等待。'))); request.end(body);
  });
  const decoded = decodeMobileResponse(operation, { ...raw, finalUrl: finalUrl.href }, { responseOrigin: origin.origin, requestPath: finalUrl.pathname });
  assert.equal(decoded.ok, true, '收到的完整HTTP状态、原headers和原bytes必须通过正式raw codec。');
  if (!decoded.ok) throw new Error('正式移动wire响应校验失败。'); return decoded.value;
}
function success<O extends MobileOperationId>(reply: MobileReplyMap[O]): Exclude<MobileReplyMap[O]['body'], MobileErrorEnvelope> {
  assert.equal(reply.category, 'success'); return reply.body as Exclude<MobileReplyMap[O]['body'], MobileErrorEnvelope>;
}
function safeFailure(reply: MobileReplyMap[MobileOperationId], status: number, code: string) {
  assert.equal(reply.status, status); assert.equal(reply.category, 'error'); assert.equal((reply.body as MobileErrorEnvelope).error.code, code);
}
async function allPages<O extends 'listAlbums' | 'listTracks'>(h: HttpBackend, operation: O, token: string, extra = '') {
  const items: (O extends 'listAlbums' ? MobileAlbum : MobileTrack)[] = [], cursors = new Set<string>(), sizes: number[] = [];
  let cursor: string | null = null, revision: string | undefined;
  do {
    assert.ok(sizes.length < 4, '本次有限103项不允许无穷游标循环。');
    const query = `source=local&limit=100${extra}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = success(await wire(h, operation, `${MOBILE_OPERATION_TABLE[operation].path}?${query}`, { token })) as MobileAlbumPage | MobileTrackPage;
    if (revision !== undefined) assert.equal(page.libraryRevision, revision); revision = page.libraryRevision;
    assert.ok(page.items.length <= 100); sizes.push(page.items.length);
    items.push(...page.items as typeof items); cursor = page.nextCursor;
    if (cursor !== null) { assert.ok(page.items.length > 0); assert.equal(cursors.has(cursor), false); cursors.add(cursor); }
  } while (cursor !== null);
  assert.equal(new Set(items.map(item => item.id)).size, items.length); return { items, sizes, revision };
}

test('真实Owner在prepare/boot/关闭边界拒绝mobile私有请求；跨库和旧epoch不污染当前实例', { timeout: 60_000 }, async t => {
  const f = await fixture(t), data = await f.directory('data'), o = owner(f, data), provisional = randomUUID();
  await assert.rejects(o.endpoint.mobileMain!({ kind: 'load', datasetId: provisional }), notSent(f.modules));
  const first = await o.prepare();
  await assert.rejects(o.endpoint.mobileMain!({ kind: 'load', datasetId: first.datasetId }), notSent(f.modules));
  await o.endpoint.commitBoot();
  assert.deepEqual(await o.mobile({ kind: 'load', datasetId: first.datasetId }), { kind: 'missing', datasetId: first.datasetId, revision: 0 });
  const empty = await o.mobile(catalogRequest(o, `server:${randomUUID()}`)) as MobileOwnerCatalogSnapshot;
  assert.equal(empty.datasetId, first.datasetId); assert.equal(empty.ownerEpoch, first.epoch); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []);
  await assert.rejects(o.endpoint.mobileMain!({ kind: 'load', datasetId: randomUUID() }), notSent(f.modules));
  const closing = o.close(); assert.equal(o.close(), closing);
  await assert.rejects(o.endpoint.mobileMain!({ kind: 'load', datasetId: first.datasetId }), notSent(f.modules)); await closing;
  const reopened = owner(f, data), second = await reopened.boot(); assert.equal(second.datasetId, first.datasetId); assert.notEqual(second.epoch, first.epoch);
  const staleId = randomUUID(), observed: unknown[] = [];
  const onMessage = (message: unknown) => { if (message && typeof message === 'object' && 'requestId' in message && message.requestId === staleId) observed.push(message); };
  reopened.worker.on('message', onMessage);
  try {
    const old: DatasetOwnerRequest = { version: 1, type: 'request', epoch: first.epoch, requestId: staleId, sequence: 1_000,
      operation: 'mobileMain', expectedDatasetId: first.datasetId, mobile: { kind: 'load', datasetId: first.datasetId } };
    reopened.worker.postMessage(old);
    assert.deepEqual(await reopened.mobile({ kind: 'load', datasetId: second.datasetId }), { kind: 'missing', datasetId: second.datasetId, revision: 0 });
    assert.deepEqual(observed, [], '旧epoch不得响应或占用当前序号。');
  } finally { reopened.worker.off('message', onMessage); }
  await reopened.close();
});

test('真实Node HTTPS与生产Auth/catalog接唯一scan-real Owner：103项完整分页、同名发行、技术事实、搜索和改库/冷重开cursor围栏', { timeout: 60_000 }, async t => {
  const f = await fixture(t), data = await f.directory('data'), o = owner(f, data); await o.boot();
  const scanned = await seedScan(f, o), factories = await mainFactories(), identityDirectory = await f.directory('tls-identity'), protectorKey = randomBytes(32);
  // 这是受控AES密钥保护＋真实TLS工厂，不替代Electron safeStorage或正式Mac Main App证据。
  const identity = await factories.loadOrCreateMobileIdentity({ directory: identityDirectory, hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', protectorKey, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', protectorKey, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  } });
  const h = await httpsBackend(f, o, factories, identity), information = success<'getServer'>(await wire(h, 'getServer', '/mobile/v1/server'));
  assert.equal(information.serverId, identity.serverId); assert.equal(information.contractVersion, '0.1.0');
  const permit = await h.backend.auth.issuePairing(), body: MobilePairingClaim = { pairingSecret: permit.pairingSecret,
    installationId: 'installation.owner-https', deviceName: '自有HTTPS设备' }, key = randomUUID();
  const claim = await wire(h, 'claimPairing', '/mobile/v1/pairings/claim', { body: body as unknown as MobileJsonValue, key }); assert.equal(claim.status, 201);
  const tokens = success(claim) as MobileTokenPair;
  safeFailure(await wire(h, 'listTracks', '/mobile/v1/tracks?source=local&limit=100', { token: tokens.accessToken }), 503, 'BUSY');
  // 关联都经原生产collection命令持久化；两个实际读取的文件各关联51/52个独立发行。
  const relations: { albumId: string; trackId: string; localTrackId: string; editionLabel: string }[] = [];
  for (let i = 0; i < 103; i++) {
    const editionLabel = `自有发行-${String(i).padStart(3, '0')}`, track = scanned.details[i % 2]!.track;
    const edition = await o.command('localCatalog.createEdition', { commandId: randomUUID(), title: '相同标题的独立发行', edition: editionLabel });
    const linked = await o.command('localCatalog.linkEditionTrack', { commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
    assert.equal(linked.editionId, edition.id); assert.equal(linked.trackId, track.id);
    relations.push({ albumId: `la:${o.identity().datasetId}:${edition.id}`, trackId: `lt:${o.identity().datasetId}:${track.id}:${edition.id}`,
      localTrackId: track.id, editionLabel });
  }
  const albums = await allPages(h, 'listAlbums', tokens.accessToken), tracks = await allPages(h, 'listTracks', tokens.accessToken);
  assert.deepEqual(albums.sizes, [100, 3]); assert.deepEqual(tracks.sizes, [100, 3]); assert.equal(albums.revision, tracks.revision);
  assert.deepEqual(new Set(albums.items.map(item => item.id)), new Set(relations.map(item => item.albumId)));
  assert.deepEqual(new Set(tracks.items.map(item => item.id)), new Set(relations.map(item => item.trackId)));
  for (const album of albums.items) { assert.equal(album.title, '相同标题的独立发行'); assert.equal(album.trackCount, 1); assert.equal(album.source, 'local'); }
  const originalFacts = new Map(scanned.details.map(detail => [detail.track.id, detail]));
  for (const relation of relations) {
    const track = tracks.items.find(item => item.id === relation.trackId)!; assert.ok(track);
    const detail = originalFacts.get(relation.localTrackId)!; assert.ok(detail.fileParameters);
    const audio = mapMobileFileAudioParameters(detail.fileParameters); assert.ok(audio.ok);
    assert.equal(track.albumId, relation.albumId); assert.equal(track.editionLabel, relation.editionLabel);
    assert.equal(track.title, detail.metadata.effective.title); assert.deepEqual(track.artists, [detail.metadata.effective.artist]);
    assert.equal(track.sourceItemId, `ls:${o.identity().datasetId}:${detail.asset.id}`); assert.deepEqual(fullValue(track.audio), fullValue(audio.value));
    assert.equal(track.durationMs, detail.fileParameters.durationMs); assert.equal(track.availability, 'unavailable');
  }
  for (const detail of scanned.details) {
    const sameFile = tracks.items.filter(item => item.sourceItemId === `ls:${o.identity().datasetId}:${detail.asset.id}`);
    assert.ok(sameFile.length > 50); assert.equal(new Set(sameFile.map(item => item.versionId)).size, 1);
    assert.equal(new Set(sameFile.map(item => item.contentRevision)).size, 1); assert.equal(new Set(sameFile.map(item => item.id)).size, sameFile.length);
  }
  const selected = tracks.items[0]!, single = success(await wire(h, 'getTrack', `/mobile/v1/tracks/${encodeURIComponent(selected.id)}`, { token: tokens.accessToken }));
  assert.deepEqual(fullValue(single), fullValue(selected));
  const oneAlbum = success(await wire(h, 'getAlbum', `/mobile/v1/albums/${encodeURIComponent(selected.albumId)}`, { token: tokens.accessToken }));
  assert.deepEqual(fullValue(oneAlbum), fullValue(albums.items.find(item => item.id === selected.albumId)!));
  const filtered = await allPages(h, 'listTracks', tokens.accessToken, `&albumId=${encodeURIComponent(selected.albumId)}`);
  assert.deepEqual(filtered.items.map(item => item.id), [selected.id]);
  const matching = await allPages(h, 'listTracks', tokens.accessToken, `&q=${encodeURIComponent(scanned.details[0]!.metadata.effective.title!)}`);
  assert.deepEqual(new Set(matching.items.map(item => item.id)), new Set(relations.map(item => item.trackId)));
  assert.deepEqual((await allPages(h, 'listTracks', tokens.accessToken, '&q=NO_OWNED_TRACK_MATCH')).items, []);
  const beforeChange = success(await wire(h, 'listTracks', '/mobile/v1/tracks?source=local&limit=100', { token: tokens.accessToken })) as MobileTrackPage;
  assert.ok(beforeChange.nextCursor);
  const changed = await o.command('localCatalog.createEdition', { commandId: randomUUID(), title: '实际库修订变化', edition: '独立追加' });
  await o.command('localCatalog.linkEditionTrack', { commandId: randomUUID(), editionId: changed.id, trackId: scanned.details[0]!.track.id, disc: 1, trackNumber: 1, sequence: 1 });
  safeFailure(await wire(h, 'listTracks', `/mobile/v1/tracks?source=local&limit=100&cursor=${encodeURIComponent(beforeChange.nextCursor)}`, { token: tokens.accessToken }), 409, 'SOURCE_CHANGED');
  const current = await allPages(h, 'listTracks', tokens.accessToken), currentAlbums = await allPages(h, 'listAlbums', tokens.accessToken);
  assert.deepEqual(current.sizes, [100, 4]); assert.equal(current.items.length, 104); assert.deepEqual(currentAlbums.sizes, [100, 4]);
  const beforeClose = success(await wire(h, 'listTracks', '/mobile/v1/tracks?source=local&limit=100', { token: tokens.accessToken })) as MobileTrackPage;
  assert.ok(beforeClose.nextCursor); const oldIdentity = o.identity();
  await h.server.close(); await h.backend.close(); await o.close();
  const cold = owner(f, data); await cold.boot(); assert.equal(cold.identity().datasetId, oldIdentity.datasetId); assert.notEqual(cold.identity().epoch, oldIdentity.epoch);
  const reopened = await httpsBackend(f, cold, factories, identity);
  const repeated = success(await wire(reopened, 'claimPairing', '/mobile/v1/pairings/claim', { body: body as unknown as MobileJsonValue, key }));
  assert.deepEqual(fullValue(repeated), fullValue(tokens), '真实Owner密文重开返回原完整回执。');
  safeFailure(await wire(reopened, 'listTracks', `/mobile/v1/tracks?source=local&limit=100&cursor=${encodeURIComponent(beforeClose.nextCursor)}`, { token: tokens.accessToken }), 409, 'SOURCE_CHANGED');
  const coldTracks = await allPages(reopened, 'listTracks', tokens.accessToken); assert.deepEqual(fullValue(coldTracks.items), fullValue(current.items));
  assert.deepEqual(fullValue((await allPages(reopened, 'listAlbums', tokens.accessToken)).items), fullValue(currentAlbums.items));
  for (const name of ['first.wav', 'second.wav']) assert.equal((await wholeFile(path.join(scanned.media, name))).sha256, digest(scanned.bytes));
  await reopened.server.close(); await reopened.backend.close(); await cold.close();
});

async function sqliteSchema(dataDirectory: string) {
  // 原Owner本来就有collection与maintenance两库；这里只核没有新增mobile库或迁移34，不宣称原来只有一个连接。
  const names = (await readdir(dataDirectory)).filter(name => name.endsWith('.sqlite')).sort();
  const schemas: { file: string; userVersion: number; schemaCookie: number }[] = [];
  for (const file of names) {
    const actual = await wholeFile(path.join(dataDirectory, file)); assert.equal(actual.bytes.subarray(0, 16).toString('ascii'), 'SQLite format 3\u0000');
    schemas.push({ file, userVersion: actual.bytes.readUInt32BE(60), schemaCookie: actual.bytes.readUInt32BE(40) });
  }
  assert.deepEqual(names, ['backup-maintenance.v1.sqlite', 'collection.v1.sqlite']);
  assert.equal(schemas.find(row => row.file === 'collection.v1.sqlite')!.userVersion, 34); return schemas;
}

test('真实Owner密封设备状态保存、旋转及冷重开原回执；跨dataset拒绝且SQLite34/原DDL和文件集合不迁移', { timeout: 60_000 }, async t => {
  const f = await fixture(t), data = await f.directory('data'), initial = owner(f, data); await initial.boot(); await initial.close();
  const baseline = await sqliteSchema(data), o = owner(f, data); await o.boot();
  const serverId = `server:${randomUUID()}`, key = new Uint8Array(randomBytes(32)), service = ownerAuth(f, o, serverId, key), auth = service.auth;
  const permit = await auth.issuePairing(), body: MobilePairingClaim = { pairingSecret: permit.pairingSecret,
    installationId: 'installation.sealed-owner', deviceName: '自有持久设备' }, claimKey = randomUUID();
  const original = await auth.claim(body, claimKey); assert.deepEqual(fullValue(await auth.claim(body, claimKey)), fullValue(original));
  assert.equal(service.saves(), 2);
  const oldPrincipal = await auth.authenticate(original.accessToken); assert.equal(oldPrincipal.datasetId, o.identity().datasetId);
  assert.equal(oldPrincipal.accountDomain, `local:${o.identity().datasetId}`); assert.equal(Object.isFrozen(oldPrincipal), true);
  const refreshBody = { refreshToken: original.refreshToken }, refreshKey = randomUUID(), rotated = await auth.refresh(refreshBody, refreshKey);
  assert.notEqual(rotated.accessToken, original.accessToken); assert.notEqual(rotated.refreshToken, original.refreshToken); assert.equal(rotated.deviceId, original.deviceId);
  await assert.rejects(auth.assertCurrent(oldPrincipal), error => error instanceof f.modules.types.MobileServiceError && error.status === 401);
  await assert.rejects(auth.claim(body, claimKey), error => error instanceof f.modules.types.MobileServiceError && error.status === 401);
  assert.deepEqual(fullValue(await auth.refresh(refreshBody, refreshKey)), fullValue(rotated)); assert.equal(service.saves(), 3);
  const state = await o.mobile({ kind: 'load', datasetId: o.identity().datasetId }); assert.ok('kind' in state && state.kind === 'sealed');
  assert.equal(state.revision, 3); assert.match(state.commitId, /^[a-f0-9-]{36}$/u); assert.ok(state.sealed.length > 29);
  await assert.rejects(o.endpoint.mobileMain!({ kind: 'load', datasetId: randomUUID() }), notSent(f.modules));
  const identity = o.identity(); await auth.close(); await o.close();
  const stateFile = path.join(data, 'mobile-devices', 'device-state.v1.sealed.json'), stored = await wholeFile(stateFile, 4 * 1024 * 1024);
  assert.equal(stored.stat.mode & 0o7777n, 0o600n); assert.equal((await lstat(path.dirname(stateFile))).mode & 0o7777, 0o700);
  for (const secret of [body.pairingSecret, original.accessToken, original.refreshToken, rotated.accessToken, rotated.refreshToken]) assert.equal(stored.bytes.includes(secret), false);
  assert.deepEqual(await sqliteSchema(data), baseline);
  const cold = owner(f, data); await cold.boot(); assert.equal(cold.identity().datasetId, identity.datasetId); assert.notEqual(cold.identity().epoch, identity.epoch);
  const persisted = await cold.mobile({ kind: 'load', datasetId: identity.datasetId }); assert.deepEqual(persisted, state);
  const reopened = ownerAuth(f, cold, serverId, key);
  assert.deepEqual(fullValue(await reopened.auth.refresh(refreshBody, refreshKey)), fullValue(rotated)); assert.equal(reopened.saves(), 0, '冷回执查询不得重新save或mint。');
  const currentPrincipal: MobilePrincipal = await reopened.auth.authenticate(rotated.accessToken); await reopened.auth.assertCurrent(currentPrincipal);
  await reopened.auth.logout(currentPrincipal);
  await assert.rejects(reopened.auth.refresh(refreshBody, refreshKey), error => error instanceof f.modules.types.MobileServiceError && error.status === 401);
  await reopened.auth.close(); await cold.close();
  const revoked = await wholeFile(stateFile, 4 * 1024 * 1024); assert.notEqual(revoked.sha256, stored.sha256);
  assert.deepEqual(await sqliteSchema(data), baseline);
  const third = owner(f, data); await third.boot(); const afterLogout = ownerAuth(f, third, serverId, key);
  await assert.rejects(afterLogout.auth.refresh(refreshBody, refreshKey), error => error instanceof f.modules.types.MobileServiceError && error.status === 401);
  assert.equal(afterLogout.saves(), 0); await afterLogout.auth.close(); await third.close();
  assert.equal((await wholeFile(stateFile, 4 * 1024 * 1024)).sha256, revoked.sha256); assert.deepEqual(await sqliteSchema(data), baseline);
  const otherData = await f.directory('other-data'), other = owner(f, otherData); await other.boot(); assert.notEqual(other.identity().datasetId, identity.datasetId);
  assert.deepEqual(await other.mobile({ kind: 'load', datasetId: other.identity().datasetId }), { kind: 'missing', datasetId: other.identity().datasetId, revision: 0 });
  const foreign = ownerAuth(f, other, serverId, key);
  await assert.rejects(foreign.auth.authenticate(rotated.accessToken), error => error instanceof f.modules.types.MobileServiceError && error.status === 401);
  await assert.rejects(other.endpoint.mobileMain!({ kind: 'load', datasetId: identity.datasetId }), notSent(f.modules));
  assert.equal(foreign.saves(), 0); await foreign.auth.close(); await other.close();
});
