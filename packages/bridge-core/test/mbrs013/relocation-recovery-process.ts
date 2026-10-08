import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { test, type TestContext } from 'node:test';
import * as dto from '@music-bridge/contracts';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { relocationFixture, relocationModules } from './relocation-fixture.js';

export interface ColdRecoverySeed {
  directory: string; media: string; destination: string; filePath: string; datasetId: string; assetId: string; rootPlanId: string; originPlanId: string;
  originalCommand: { commandId: string; fingerprint: string; receipt: dto.LocalRelocationPlanReceipt };
}
/** 独立进程的真实FD/Worker/claims随物理退出结束；没有手工release伪造冷Owner。 */
if (process.argv[2] === 'seed-unknown-family') test('自有生产图进程建立两代真实未知保护后等待物理退出', { timeout: 180_000 }, async t => {
  assert.ok(process.send); const f = await relocationFixture(t); await f.enable();
  const target = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const original = f.repository.localCatalog.privateRelocationPrepareReads; let failures = 2;
  f.repository.localCatalog.privateRelocationPrepareReads = async (...args: Parameters<typeof original>) => {
    const result = await original(...args); if (failures-- > 0) throw new Error('原真实Reader/ticket之后中断，用于物理退出/冷恢复。'); return result;
  };
  async function submit(plan: dto.LocalRelocationPlan) {
    const request = f.confirm(plan), challenge = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request });
    const receipt = await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: challenge.grant });
    assert.equal(receipt.outcome, 'accepted'); const result = await f.waitPlan(plan.planId, value => ['RECOVERY_REQUIRED', 'FAILED', 'SOURCE_RETAINED'].includes(value.state));
    assert.equal(result.state, 'RECOVERY_REQUIRED', JSON.stringify(result.issues)); return { request, receipt, result };
  }
  const ready = await f.ready({ kind: 'move', targets: [f.selection()], targetChoiceId: target.choiceId, sourceDisposition: 'RETAIN' }), first = await submit(ready);
  const origin = await f.plan(ready.planId), choice = origin.recoveryChoices.find(value => value.action === 'keep-target'); assert.ok(choice);
  const recovery = await f.ready({ kind: 'recovery', originPlanId: origin.planId, expectedOriginViewRevision: origin.viewRevision, choiceId: choice.choiceId, recoveryFingerprint: choice.recoveryFingerprint });
  await submit(recovery); assert.ok(f.modules.locks.physicalResourceLocks.combinedSnapshot().writers > 0);
  assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.latestAssets.size), 0);
  const seed: ColdRecoverySeed = { directory: f.directory, media: f.media, destination: f.destination, filePath: f.filePath, datasetId: f.datasetId, assetId: f.track.assetId,
    rootPlanId: ready.planId, originPlanId: recovery.planId, originalCommand: { commandId: first.request.commandId, fingerprint: first.receipt.requestFingerprint, receipt: first.receipt } };
  process.send!({ type: 'owned-unknown-family-prepared', seed });
  // 只由父测试终止本自有进程；不发送quiet、不close原unknown保护，也不继续执行旧命令。
  await new Promise<void>(() => {});
});

/** 原repository/Reader/Scanner和真实Main端口重开已有自建journal；不复制/改写任何DB表。 */
export async function coldRelocationFixture(t: TestContext, seed: ColdRecoverySeed) {
  const modules = await relocationModules(), cleanups: (() => Promise<void> | void)[] = []; let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => { const errors: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '自有冷恢复夹具的真实资源收尾失败。'); })();
  t.after(async () => { await close(); t.diagnostic(`自有冷恢复输入和未知历史保留：${seed.directory}`); });
  const repository = modules.repository.createCollectionRepository({ filePath: seed.filePath }); cleanups.push(() => repository.close());
  const epoch = randomUUID(), admission = modules.admission.createScanReadAdmission({ isBusy: () => false }), context = { datasetId: seed.datasetId, epoch };
  cleanups.push(() => admission.close());
  const projection: DatasetProjectionPort = { async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('冷恢复夹具不提供模拟Roon或Scanner事实。'); return result as DatasetProjectionCommandResults[C];
  } };
  const reader = modules.reader.createMetadataReader(); cleanups.push(() => reader.close());
  const scanner = modules.scanner.createLocalScanCoordinator({ repository, datasetId: seed.datasetId, projection, reader, assertCurrent() { repository.readonlySnapshotStamp(); } });
  cleanups.push(() => scanner.close());
  const channel = new MessageChannel(); cleanups.push(() => { channel.port1.close(); channel.port2.close(); });
  const actor = modules.authority.createRelocationMainActor(channel.port1);
  const api = modules.service.createLocalRelocationService({ repository, datasetId: seed.datasetId, ownerEpoch: epoch,
    assertCurrent() { repository.readonlySnapshotStamp(); }, assertRecoveryCurrent() { repository.readonlySnapshotStamp(); }, beforeMedia: () => scanner.yieldForMedia() });
  cleanups.push(() => api.close()); await api.prepareRecoveryProtection();
  let sequence = 0;
  const waiting = new Map<string, { command: dto.LocalRelocationMainCommand; sequence: number; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  cleanups.push(() => { for (const value of waiting.values()) { clearTimeout(value.timer); value.reject(new Error('自有冷Main端口已关闭。')); } waiting.clear(); });
  channel.port1.on('message', (input: unknown) => { void (async () => {
    const request = dto.localRelocationMainRequestSnapshot(input);
    try { const result = await api.dispatchMain(request, actor); channel.port1.postMessage(dto.localRelocationMainResponseSnapshot({ version: 1, type: 'relocation-main-response', requestId: request.requestId, sequence: request.sequence, ok: true, result }, request.command)); }
    catch (error) { channel.port1.postMessage({ type: 'owned-cold-error', requestId: request.requestId, sequence: request.sequence, code: error instanceof modules.journal.LocalRelocationError ? error.code : 'IO_FAILED' }); }
  })(); });
  channel.port2.on('message', (input: unknown) => {
    assert.ok(input && typeof input === 'object' && 'requestId' in input && typeof input.requestId === 'string'); const current = waiting.get(input.requestId); assert.ok(current);
    assert.ok('sequence' in input); assert.equal(input.sequence, current.sequence); clearTimeout(current.timer); waiting.delete(input.requestId);
    if ('type' in input && input.type === 'owned-cold-error') { assert.ok('code' in input); current.reject(new modules.journal.LocalRelocationError(input.code as dto.LocalRelocationPlanIssueCode)); }
    else { const result = dto.localRelocationMainResponseSnapshot(input, current.command); assert.ok(result.ok); current.resolve(result.result); }
  }); channel.port1.start(); channel.port2.start();
  async function main<C extends dto.LocalRelocationMainCommand>(command: C, payload: dto.LocalRelocationMainCommandPayloads[C]): Promise<dto.LocalRelocationMainCommandResults[C]> {
    const request = dto.localRelocationMainRequestSnapshot({ version: 1, type: 'relocation-main-request', requestId: randomUUID(), sequence: ++sequence, command, payload });
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiting.delete(request.requestId); reject(new Error('自有冷Main真实端口请求超时。')); }, 30_000);
      waiting.set(request.requestId, { command, sequence: request.sequence, resolve: value => resolve(value as dto.LocalRelocationMainCommandResults[C]), reject, timer }); channel.port2.postMessage(request); });
  }
  async function plan(planId: string): Promise<dto.LocalRelocationPlan> { const result = await api.get({ datasetId: seed.datasetId, selector: { kind: 'plan', planId } }); assert.ok(result.kind === 'plan' && result.plan); return result.plan; }
  async function waitPlan(planId: string, accepted: (value: dto.LocalRelocationPlan) => boolean): Promise<dto.LocalRelocationPlan> {
    const until = Date.now() + 120_000;
    for (;;) { const value = await plan(planId); if (accepted(value)) return value; assert.ok(Date.now() < until, JSON.stringify(value.issues)); await new Promise<void>(resolve => setTimeout(resolve, 10)); }
  }
  return { modules, repository, reader, scanner, admission, api, main, plan, waitPlan, close };
}
