import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { buildStoragePolicy } from '../../scripts/build-storage-root.mjs';
import { createCommandOutboxExecutor } from '../../src/main/command-outbox-executor.js';
import { createCommandOutboxStore } from '../../src/main/command-outbox-store.js';
import type { CoreSupervisor } from '../../src/main/core-supervisor.js';
import { createCollectionRepository } from '../../../../packages/bridge-core/src/collection/repository.js';
import { createSourceEvidenceService } from '../../../../packages/bridge-core/src/recording/source-evidence.js';
import { authorizeSourceDirectory } from '../../../../packages/bridge-core/src/recording/source-files.js';
import { createLocalRelocationCoordinator } from '../../../../packages/bridge-core/src/collection/local-relocation-coordinator.js';

type Route = { route: 'ordinary' | 'internal'; command: dto.IpcCommand; payload: unknown; datasetId?: string };
async function fixture(t: test.TestContext) {
  const supplied = process.env.TMPDIR;
  assert.ok(supplied && path.isAbsolute(supplied), '必须显式采用外置私有TMPDIR，不能fallback');
  const policy = buildStoragePolicy(), temporary = policy.check(supplied, { mustExist: true });
  const info = await lstat(temporary);
  assert.equal(info.isDirectory() && !info.isSymbolicLink(), true); assert.equal(await realpath(temporary), temporary);
  assert.equal(info.mode & 0o777, 0o700); assert.equal(info.uid, process.getuid!());
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-mbrs003-root-outbox-')); await chmod(directory, 0o700);
  policy.check(directory, { mustExist: true });
  const sourcePath = path.join(directory, 'native-source'), otherSourcePath = path.join(directory, 'other-source');
  await mkdir(sourcePath, { mode: 0o700 }); await mkdir(otherSourcePath, { mode: 0o700 });
  const repositoryFile = path.join(directory, 'collection.sqlite'), outboxFile = path.join(directory, 'outbox.sqlite');
  const datasetId = randomUUID(), calls: Route[] = [];
  let pickerCount = 0, cancelled = false, loseNextCommittedResponse = false;
  function session() {
    const repository = createCollectionRepository({ filePath: repositoryFile });
    const sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
    const relocation = createLocalRelocationCoordinator({ repository, assertCurrent: () => { repository.list({ offset: 0, limit: 1 }); } });
    const outbox = createCommandOutboxStore({ filePath: outboxFile }); let closed = false;
    async function route(command: dto.IpcCommand, payload: unknown, internal: boolean, expectedDatasetId?: string): Promise<unknown> {
      const body = { version: 1, id: randomUUID(), command, payload, ...(expectedDatasetId === undefined ? {} : { expectedDatasetId }) };
      const parsed = internal ? dto.validateIpcInternalRequest(body) : dto.validateIpcRequest(body);
      assert.equal(parsed.ok, true, '受控supervisor保留真实合同校验，不能靠坏payload伪造RED');
      if (command !== 'commandOutbox.context') assert.equal(expectedDatasetId, datasetId, '原工作库scope必须一致');
      calls.push({ route: internal ? 'internal' : 'ordinary', command, payload: structuredClone(payload), ...(expectedDatasetId === undefined ? {} : { datasetId: expectedDatasetId }) });
      if (!internal && command === 'commandOutbox.context') return { datasetId };
      if (internal && command === 'recordingSources.rootReceipt') return sources.rootReceipt((payload as dto.IpcCommandPayloads['recordingSources.rootReceipt']).commandId);
      if (internal && command === 'recordingSources.authorize') {
        const input = payload as dto.IpcCommandPayloads['recordingSources.authorize'];
        return sources.authorize(input.commandId, input.absolutePath);
      }
      if (internal && command === 'localRelocation.registerRoot') {
        const result = await relocation.registerRoot(payload as dto.IpcCommandPayloads['localRelocation.registerRoot']);
        if (loseNextCommittedResponse) { loseNextCommittedResponse = false; throw new Error('受控对端：真实目录登记提交后遗失响应'); }
        return result;
      }
      assert.fail('不提供Fake receipt、通用Core转发或真实账号');
    }
    // 唯一受控supervisor仅转发真实SourceStore服务及真实RelocationCoordinator；不造成功/回执。
    const supervisor: Pick<CoreSupervisor, 'request' | 'requestInternal' | 'activateRestoredDataset'> = {
      async request<C extends dto.IpcCommand>(command: C, payload: dto.IpcCommandPayloads[C], expectedDatasetId?: string): Promise<dto.IpcCommandResults[C]> {
        return await route(command, payload, false, expectedDatasetId) as dto.IpcCommandResults[C];
      },
      async requestInternal<C extends dto.IpcInternalCommand>(command: C, payload: dto.IpcCommandPayloads[C], expectedDatasetId?: string): Promise<dto.IpcInternalCommandResults[C]> {
        return await route(command, payload, true, expectedDatasetId) as dto.IpcInternalCommandResults[C];
      },
      async activateRestoredDataset() { assert.fail('本候选不执行恢复激活'); },
    };
    const executor = createCommandOutboxExecutor({ supervisor, pick: async options => {
      assert.deepEqual(options.properties, ['openDirectory']); pickerCount++;
      return { canceled: cancelled, filePaths: [sourcePath] };
    } });
    return { repository, sources, relocation, outbox, executor,
      async close() { if (closed) return; closed = true; try { await sources.close(); } finally { relocation.close(); try { repository.close(); } finally { outbox.close(); } } },
    };
  }
  let current = session(); t.after(() => current.close());
  function snapshot() {
    const db = new DatabaseSync(repositoryFile, { readOnly: true, allowExtension: false });
    try {
      const tableNames = ['source_roots', 'source_ledger', 'local_catalog_roots', 'local_catalog_ledger'] as const;
      return Object.fromEntries(tableNames.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    } finally { db.close(); }
  }
  const request = (commandId = randomUUID()): Extract<dto.CommandOutboxRequest, { command: 'localLibrary.chooseRoot' }> => ({ datasetId, command: 'localLibrary.chooseRoot', payload: { commandId } });
  return { directory, sourcePath, otherSourcePath, calls, datasetId, request, snapshot,
    active: () => current, pickerCount: () => pickerCount, cancel: () => { cancelled = true; }, enablePicker: () => { cancelled = false; }, loseCommittedResponse: () => { loseNextCommittedResponse = true; },
    async cold() { await current.close(); current = session(); },
    async assertSourceUnchanged() { assert.deepEqual(await readdir(sourcePath), []); assert.deepEqual(await readdir(otherSourcePath), []); },
  };
}

test('MBRS003 Main outbox真实冷恢复：Native仅一次，SourceStore持久许可与完整registerRoot账本恢复未知响应，不混用Outbox指纹', { timeout: 30_000 }, async t => {
  const f = await fixture(t), request = f.request(), first = f.active();
  const confirmed = first.outbox.confirm(request); assert.equal(confirmed.created, true);
  const sent = first.outbox.markSending(confirmed.entry.id), original = structuredClone(sent);
  f.loseCommittedResponse(); await assert.rejects(first.executor.execute(sent), /真实目录登记提交后遗失响应/u);
  assert.deepEqual(sent, original); assert.equal(f.pickerCount(), 1);
  first.outbox.markUncertain(sent.id, 'OUTBOX_RESULT_UNKNOWN');
  const actualSource = first.repository.sources.rootReceipt(request.payload.commandId); assert.ok(actualSource);
  const actualRegister = first.repository.localCatalog.privateReceiptRequest(request.payload.commandId); assert.ok(actualRegister);
  assert.equal(actualRegister.operation, 'register-root');
  assert.deepEqual(actualRegister.request, { commandId: request.payload.commandId, sourceRootId: actualSource.id, role: 'library' });
  assert.equal(dto.isLibraryRoot(actualRegister.result), true);
  const receipt = first.repository.localCatalog.receipt(request.payload.commandId); assert.ok(receipt);
  assert.notEqual(sent.fingerprint, receipt.fingerprint, '不同指纹域不能互换');
  const beforeCold = f.snapshot(); assert.equal(first.repository.sources.roots().length, 1); assert.equal(first.repository.localCatalog.roots().length, 1);
  await f.cold(); const cold = f.active();
  const reConfirmed = cold.outbox.confirm(request); assert.equal(reConfirmed.created, false); assert.equal(reConfirmed.entry.id, sent.id);
  assert.equal(reConfirmed.entry.fingerprint, sent.fingerprint); assert.equal(reConfirmed.entry.state, 'uncertain');
  assert.deepEqual(cold.repository.sources.rootReceipt(request.payload.commandId), actualSource, '新Repository/SourceStore从持久账本恢复实际原cap，不借旧缓存');
  const resending = cold.outbox.markSending(sent.id), result = await cold.executor.execute(resending);
  assert.deepEqual(result, actualRegister.result); assert.equal(f.pickerCount(), 1); assert.deepEqual(f.snapshot(), beforeCold);
  cold.outbox.succeed(sent.id, result);
  assert.equal(cold.outbox.get(sent.id).state, 'succeeded'); assert.deepEqual(cold.outbox.get(sent.id).result, actualRegister.result);
  assert.equal(f.calls.some(call => call.command === 'localCatalog.receipt'), false, '不能以缺完整指纹查询catalog再假设成功');
  assert.equal(f.calls.filter(call => call.command === 'recordingSources.authorize').length, 1);
  assert.equal(f.calls.filter(call => call.command === 'recordingSources.rootReceipt').length, 2);
  assert.equal(f.calls.filter(call => call.command === 'localRelocation.registerRoot').length, 2);
  await f.assertSourceUnchanged();
  // 真Repository/store冷重建的软件证据；不宣称Electron进程崩溃、Native dialog真实操作或Owner跨进程协议。
});

test('MBRS003 Main outbox真实取消与改参拒绝：取消无源/catalog副作用，同commandId错误SourceRoot登记或Outbox操作不能篡改旧数据', { timeout: 30_000 }, async t => {
  const f = await fixture(t), s = f.active(), cancelledRequest = f.request();
  const cancelEntry = s.outbox.confirm(cancelledRequest).entry, cancelling = s.outbox.markSending(cancelEntry.id), empty = f.snapshot();
  f.cancel(); assert.equal(await s.executor.execute(cancelling), null); s.outbox.succeed(cancelEntry.id, null);
  assert.equal(f.pickerCount(), 1); assert.deepEqual(f.snapshot(), empty);
  assert.equal(s.repository.sources.rootReceipt(cancelledRequest.payload.commandId), undefined);
  assert.equal(s.repository.localCatalog.privateReceiptRequest(cancelledRequest.payload.commandId), null);
  assert.equal(f.calls.some(call => call.command === 'recordingSources.authorize' || call.command === 'localRelocation.registerRoot'), false);
  f.enablePicker(); const originalRequest = f.request(), entry = s.outbox.confirm(originalRequest).entry;
  const result = await s.executor.execute(s.outbox.markSending(entry.id)); assert.equal(dto.isLibraryRoot(result), true); s.outbox.succeed(entry.id, result);
  assert.equal(f.pickerCount(), 2);
  const originalSource = s.repository.sources.rootReceipt(originalRequest.payload.commandId); assert.ok(originalSource);
  const originalRegister = s.repository.localCatalog.privateReceiptRequest(originalRequest.payload.commandId); assert.ok(originalRegister);
  const other = s.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(f.otherSourcePath)); assert.notEqual(other.id, originalSource.id);
  const before = f.snapshot(), outboxBefore = s.outbox.get(entry.id);
  await assert.rejects(s.relocation.registerRoot({ commandId: originalRequest.payload.commandId, sourceRootId: other.id }), /操作编号不能复用其他根注册请求/u);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(s.repository.localCatalog.privateReceiptRequest(originalRequest.payload.commandId), originalRegister);
  assert.throws(() => s.outbox.confirm({ datasetId: f.datasetId, command: 'recordingSources.chooseRoot', payload: { commandId: originalRequest.payload.commandId } }), { code: 'OUTBOX_CONFLICT' });
  assert.deepEqual(s.outbox.get(entry.id), outboxBefore); assert.deepEqual(f.snapshot(), before); assert.equal(f.pickerCount(), 2);
  await f.assertSourceUnchanged();
});
