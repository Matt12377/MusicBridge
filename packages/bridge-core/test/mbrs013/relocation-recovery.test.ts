import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, lstat, link, mkdir, open, rename, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import * as dto from '@music-bridge/contracts';
import type { RelocationWriteView, RelocationEvent } from '../../src/collection/local-relocation-journal.js';
import { relocationFixture, wholeHash, type RelocationFixture } from './relocation-fixture.js';
import { coldRelocationFixture, type ColdRecoverySeed } from './relocation-recovery-process.js';

/** 故障仅围住真实原作者回调；FD、Scanner ticket、唯一事务与已落盘行都来自生产代码。 */
function failPhase(f: RelocationFixture, select: (event: RelocationEvent) => boolean): () => void {
  const catalog = f.repository.localCatalog, original = catalog.privateRelocationTransaction; let armed = true;
  catalog.privateRelocationTransaction = <T>(operation: (view: RelocationWriteView) => T): T => original(view => operation({ ...view,
    append(event) { if (armed && select(event)) { armed = false; throw new Error('自有夹具在真实阶段持久化边界中断一次。'); } view.append(event); },
  }));
  return () => { catalog.privateRelocationTransaction = original; };
}
function failRealPreparedReads(f: RelocationFixture, times = 1): () => void {
  const catalog = f.repository.localCatalog, original = catalog.privateRelocationPrepareReads;
  catalog.privateRelocationPrepareReads = async (...args: Parameters<typeof original>) => {
    const prepared = await original(...args);
    if (times-- > 0) throw new Error('真实Reader已quiet并形成原Scanner ticket，目录CAS前受控中断。'); return prepared;
  };
  return () => { catalog.privateRelocationPrepareReads = original; };
}
async function submit(f: RelocationFixture, plan: dto.LocalRelocationPlan) {
  const request = f.confirm(plan), challenge = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request });
  const receipt = await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: challenge.grant });
  assert.equal(receipt.outcome, 'accepted');
  return { request, challenge, receipt, done: await f.waitPlan(plan.planId, value => ['SOURCE_RETAINED', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED', 'DEFERRED'].includes(value.state)) };
}
async function movePlan(f: RelocationFixture): Promise<dto.LocalRelocationPlan> {
  const target = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  return f.ready({ kind: 'move', targets: [f.selection()], targetChoiceId: target.choiceId, sourceDisposition: 'RETAIN' });
}
async function recoveryPlan(f: RelocationFixture, originId: string, action: dto.LocalRelocationPlanRecoveryChoice['action']): Promise<dto.LocalRelocationPlan> {
  const origin = await f.plan(originId), choice = origin.recoveryChoices.find(value => value.action === action); assert.ok(choice, JSON.stringify(origin.issues));
  assert.deepEqual(choice.resourceIds, origin.resources.map(value => value.resourceId));
  const plan = await f.ready({ kind: 'recovery', originPlanId: originId, expectedOriginViewRevision: origin.viewRevision, choiceId: choice.choiceId, recoveryFingerprint: choice.recoveryFingerprint });
  assert.notEqual(plan.planId, origin.planId); assert.notEqual(plan.planHash, origin.planHash); assert.notEqual(plan.contextFingerprint, origin.contextFingerprint);
  assert.equal((await f.plan(originId)).viewRevision, origin.viewRevision); return plan;
}
function facts(f: RelocationFixture) { return f.repository.localCatalog.privateRelocationRead(view => [...view.projection.events].filter(event => event.kind === 'location-facts')); }
function resourceZero(f: RelocationFixture): void {
  assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
  assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
}
async function checkCold(f: RelocationFixture, planIds: string[]): Promise<void> {
  const snapshot = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), events = f.repository.localCatalog.privateRelocationRead(view => view.projection.events.map(value => value.eventHash));
  await f.close(); const cold = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try {
    assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(f.track.assetId), snapshot);
    assert.deepEqual(cold.localCatalog.privateRelocationRead(view => view.projection.events.map(value => value.eventHash)), events);
    for (const id of planIds) assert.equal(cold.localCatalog.privateRelocationRead(view => f.modules.journal.relocationUnresolvedResources(view.projection.plans.get(id)!).length), 0);
  } finally { cold.close(); }
}

test('真实发布未知后新完整计划/新grant登记；原UNKNOWN身份不重签，全部FD quiet才消祖先义务', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await movePlan(f), restore = failRealPreparedReads(f);
  const first = await submit(f, ready); restore(); assert.equal(first.done.state, 'RECOVERY_REQUIRED'); assert.equal(facts(f).length, 0);
  assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original);
  assert.ok(f.modules.locks.physicalResourceLocks.combinedSnapshot().writers > 0);
  assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes);
  await assert.rejects(f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: first.request }), error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'COMMAND_UNKNOWN');
  const next = await recoveryPlan(f, ready.planId, 'keep-target');
  await assert.rejects(f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: f.confirm(next), grant: first.challenge.grant }), error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'GRANT_CONSUMED');
  const result = await submit(f, next); assert.equal(result.done.state, 'SOURCE_RETAINED', JSON.stringify(result.done.issues));
  assert.notEqual(result.challenge.grant.challengeId, first.challenge.grant.challengeId); assert.equal(facts(f).length, 1);
  const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId);
  assert.equal(current.asset.id, f.original.asset.id); assert.equal(current.asset.fileRevision, f.original.asset.fileRevision); assert.equal(current.catalogSha256, null);
  assert.equal(BigInt(current.asset.locationRevision), BigInt(f.original.asset.locationRevision) + 1n); assert.deepEqual(current.tracks, f.original.tracks);
  const originalCommand = await f.api.get({ datasetId: f.datasetId, selector: { kind: 'command', commandId: first.request.commandId, expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: first.receipt.requestFingerprint } });
  assert.ok(originalCommand.kind === 'command'); assert.equal(originalCommand.commandId, first.request.commandId);
  assert.equal(originalCommand.expectedCommand, 'localRelocationPlan.confirm'); assert.equal(originalCommand.requestFingerprint, first.receipt.requestFingerprint);
  // Main快照与GET的clone原型可不同；同一严格闭集快照后仍比较完整九字段，并拒额外键。
  const originalReceipt = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.confirm', originalCommand.receipt);
  assert.deepEqual(originalReceipt, dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.confirm', first.receipt));
  assert.throws(() => dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.confirm', { ...originalReceipt, unexpected: true }));
  assert.equal((await f.plan(ready.planId)).state, 'PARTIAL'); assert.deepEqual((await f.plan(ready.planId)).recoveryChoices, []);
  const resolved = f.repository.localCatalog.privateRelocationRead(view => view.projection.events.filter(value => value.kind === 'recovery-resolved'));
  assert.equal(resolved.length, ready.resources.length); resourceZero(f); await checkCold(f, [ready.planId, next.planId]);
});

test('已真实CAS但终结未知仅对账收尾：位置/Scanner来源不双增，恢复的具体cleanup仍独立授权', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await movePlan(f);
  const restore = failPhase(f, event => event.kind === 'phase' && event.fact.phase === 'REGISTERED' && event.resource.role === 'LYRIC');
  const first = await submit(f, ready); restore(); assert.equal(first.done.state, 'RECOVERY_REQUIRED'); assert.equal(facts(f).length, 1);
  const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), recorded = facts(f)[0]!;
  const next = await recoveryPlan(f, ready.planId, 'reconcile'), result = await submit(f, next);
  assert.equal(result.done.state, 'SOURCE_RETAINED', JSON.stringify(result.done.issues)); assert.equal(facts(f).length, 1); assert.deepEqual(facts(f)[0], recorded);
  assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), current); resourceZero(f);
  const captured = f.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(next.planId)!.resources.find(value => value.frozen.role === 'AUDIO')!);
  assert.equal(captured.frozen.source.sourceRootId, current.asset.sourceRootId); assert.equal(captured.frozen.target.sourceRootId, current.asset.sourceRootId);
  assert.equal(captured.recovery?.retainedSource?.endpoint.sourceRootId, f.source.id); assert.equal(captured.recovery?.retainedSource?.endpoint.relative, f.original.relative);
  assert.equal(captured.recovery?.retainedSource?.observation.sha256, wholeHash(f.bytes)); assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes);
  const retained = f.repository.localCatalog.privateRelocationRead(view => [...view.projection.retainedSources.values()]); assert.equal(retained.length, 2);
  assert.ok(retained.every(value => value.source.sourceRootId === f.source.id));
  const cleanup: dto.LocalRelocationPlanCleanup = { ...f.confirm(result.done), verifiedTargetFingerprint: result.done.cleanup.verifiedTargetFingerprint!, sourceResourceIds: result.done.cleanup.sourceResourceIds };
  const grant = await f.main('localRelocationMain.challengeCleanup', { datasetId: f.datasetId, cleanup }); assert.equal(grant.grant.action, 'cleanup');
  await f.main('localRelocationMain.cleanupGranted', { datasetId: f.datasetId, cleanup, grant: grant.grant });
  const done = await f.waitPlan(next.planId, value => ['COMPLETED', 'RECOVERY_REQUIRED'].includes(value.state) || value.cleanup.state === 'blocked');
  assert.equal(done.state, 'COMPLETED', JSON.stringify(done.issues)); await assert.rejects(readFile(path.join(f.media, 'Original.flac')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes); assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.retainedSources.size), 0);
  resourceZero(f); await checkCold(f, [ready.planId, next.planId]);
});

test('同卷MOVE部分安装/未登记可真实rollback：原名与全闭集恢复，目标保全材料不被删除，Reader重新登记', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await f.ready({ kind: 'rename', target: f.selection(), newName: 'Moved.flac', sourceDisposition: 'RETAIN' });
  const restore = failPhase(f, event => event.kind === 'phase' && event.fact.phase === 'TARGET_INSTALLED');
  const first = await submit(f, ready); restore(); assert.equal(first.done.state, 'RECOVERY_REQUIRED'); assert.equal(facts(f).length, 0);
  await assert.rejects(readFile(path.join(f.media, 'Original.flac')), { code: 'ENOENT' }); assert.deepEqual(await readFile(path.join(f.media, 'Moved.flac')), f.bytes);
  const backup = f.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(ready.planId)!.events.find(event => event.kind === 'phase' && event.fact.phase === 'SOURCE_CAPTURED'));
  assert.ok(backup?.kind === 'phase' && backup.fact.retained); assert.deepEqual(await readFile(backup.fact.retained), f.bytes);
  const next = await recoveryPlan(f, ready.planId, 'rollback');
  const originalAudio = f.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(ready.planId)!.resources.find(value => value.frozen.role === 'AUDIO')!);
  const recoveredAudio = f.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(next.planId)!.resources.find(value => value.frozen.role === 'AUDIO')!);
  assert.deepEqual(recoveredAudio.sourceObservation.physical, originalAudio.sourceObservation.physical);
  assert.equal(recoveredAudio.sourceObservation.birthtimeNs, originalAudio.sourceObservation.birthtimeNs);
  assert.equal(recoveredAudio.sourceObservation.sha256, wholeHash(f.bytes)); assert.equal(recoveredAudio.recovery?.retainedSource, null);
  const result = await submit(f, next);
  assert.equal(result.done.state, 'COMPLETED', JSON.stringify(result.done.issues));
  assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.media, 'Original.lrc')), f.lyric);
  await assert.rejects(readFile(path.join(f.media, 'Moved.flac')), { code: 'ENOENT' }); assert.deepEqual(await readFile(backup.fact.retained), f.bytes);
  const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId); assert.equal(current.relative, f.original.relative);
  assert.equal(current.asset.id, f.original.asset.id); assert.equal(current.asset.fileRevision, f.original.asset.fileRevision); assert.equal(current.catalogSha256, null);
  assert.equal(BigInt(current.asset.locationRevision), BigInt(f.original.asset.locationRevision) + 1n); assert.equal(facts(f).length, 1);
  resourceZero(f); await checkCold(f, [ready.planId, next.planId]);
});

test('已登记跨逻辑根与引用改写可具体rollback；再次未知的reconcile只清理旧目标并保留反向当前文件', { timeout: 240_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await movePlan(f), restore = failPhase(f, event => event.kind === 'phase' && event.fact.phase === 'REGISTERED');
  const first = await submit(f, ready); restore(); assert.equal(first.done.state, 'RECOVERY_REQUIRED'); assert.equal(facts(f).length, 1);
  const moved = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), next = await recoveryPlan(f, ready.planId, 'rollback'), result = await submit(f, next);
  assert.equal(result.done.state, 'SOURCE_RETAINED', JSON.stringify(result.done.issues)); assert.equal(facts(f).length, 2);
  const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId);
  assert.equal(current.relative, f.original.relative); assert.equal(current.asset.libraryRootId, f.original.asset.libraryRootId);
  assert.equal(current.asset.locationRevision, String(BigInt(moved.asset.locationRevision) + 1n)); assert.equal(current.asset.fileRevision, f.original.asset.fileRevision);
  assert.deepEqual(current.tracks, f.original.tracks); assert.equal(current.catalogSha256, f.original.catalogSha256);
  assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes);
  const origins = facts(f).map(value => { assert.ok(value.kind === 'location-facts'); return value.fact.scan.origin.job.jobId; }); assert.equal(new Set(origins).size, 2);
  const retained = f.repository.localCatalog.privateRelocationRead(view => [...view.projection.retainedSources.values()]);
  assert.ok(retained.some(value => value.source.relative === 'Original.flac' && value.source.sourceRootId === moved.asset.sourceRootId));
  assert.equal(retained.some(value => value.source.sourceRootId === f.original.asset.sourceRootId && value.source.relative === f.original.relative), false);
  resourceZero(f); await checkCold(f, [ready.planId, next.planId]);
  const cue = await relocationFixture(t, { cue: true }); await cue.enable();
  const original = await cue.ready({ kind: 'rename', target: cue.selection(), newName: 'Reference.flac', sourceDisposition: 'RETAIN' });
  const failOriginal = failPhase(cue, event => event.kind === 'phase' && event.fact.phase === 'REGISTERED');
  assert.equal((await submit(cue, original)).done.state, 'RECOVERY_REQUIRED'); failOriginal();
  const inverse = await recoveryPlan(cue, original.planId, 'rollback'), failInverse = failPhase(cue, event => event.kind === 'phase' && event.fact.phase === 'REGISTERED');
  assert.equal((await submit(cue, inverse)).done.state, 'RECOVERY_REQUIRED'); failInverse(); assert.equal(facts(cue).length, 2);
  const reconciled = await recoveryPlan(cue, inverse.planId, 'reconcile'), finished = await submit(cue, reconciled); assert.equal(finished.done.state, 'SOURCE_RETAINED', JSON.stringify(finished.done.issues));
  assert.equal(facts(cue).length, 2); const retainedCue = cue.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(reconciled.planId)!.resources.find(value => value.frozen.role === 'CUE')!);
  assert.equal(retainedCue.frozen.target.relative, 'Original.cue'); assert.equal(retainedCue.recovery?.retainedSource?.endpoint.relative, 'Reference.cue');
  assert.equal(retainedCue.frozen.after.sha256, wholeHash(cue.cue)); assert.notEqual(retainedCue.recovery?.retainedSource?.observation.sha256, wholeHash(cue.cue));
  assert.deepEqual(await readFile(path.join(cue.media, 'Original.cue')), cue.cue);
  const cleanup: dto.LocalRelocationPlanCleanup = { ...cue.confirm(finished.done), verifiedTargetFingerprint: finished.done.cleanup.verifiedTargetFingerprint!, sourceResourceIds: finished.done.cleanup.sourceResourceIds };
  const grant = await cue.main('localRelocationMain.challengeCleanup', { datasetId: cue.datasetId, cleanup });
  await cue.main('localRelocationMain.cleanupGranted', { datasetId: cue.datasetId, cleanup, grant: grant.grant });
  assert.equal((await cue.waitPlan(reconciled.planId, value => ['COMPLETED', 'RECOVERY_REQUIRED'].includes(value.state) || value.cleanup.state === 'blocked')).state, 'COMPLETED');
  assert.deepEqual(await readFile(path.join(cue.media, 'Original.flac')), cue.bytes); assert.deepEqual(await readFile(path.join(cue.media, 'Original.cue')), cue.cue);
  await assert.rejects(readFile(path.join(cue.media, 'Reference.flac')), { code: 'ENOENT' }); await assert.rejects(readFile(path.join(cue.media, 'Reference.cue')), { code: 'ENOENT' });
  assert.equal(cue.repository.localCatalog.privateRelocationRead(view => view.projection.retainedSources.size), 0); resourceZero(cue); await checkCold(cue, [original.planId, inverse.planId, reconciled.planId]);
});

test('恢复Reader/CAS前再次中断仍保持同一真实保护族；下一新grant逐祖先quiet/resolved，旧命令不重播', { timeout: 240_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await movePlan(f), restore = failRealPreparedReads(f, 2);
  const first = await submit(f, ready); assert.equal(first.done.state, 'RECOVERY_REQUIRED');
  const secondPlan = await recoveryPlan(f, ready.planId, 'keep-target'), second = await submit(f, secondPlan); assert.equal(second.done.state, 'RECOVERY_REQUIRED'); restore();
  assert.equal(facts(f).length, 0); assert.ok(f.modules.locks.physicalResourceLocks.combinedSnapshot().writers > 0);
  assert.deepEqual((await f.plan(ready.planId)).recoveryChoices, []); assert.equal((await f.plan(secondPlan.planId)).recoveryChoices.length, 2);
  const thirdPlan = await recoveryPlan(f, secondPlan.planId, 'keep-target'), third = await submit(f, thirdPlan);
  assert.equal(third.done.state, 'SOURCE_RETAINED', JSON.stringify(third.done.issues)); assert.equal(facts(f).length, 1);
  const family = f.repository.localCatalog.privateRelocationRead(view => f.modules.journal.relocationRecoveryFamily(view.projection, thirdPlan.planId));
  assert.deepEqual(family.map(value => value.plan.planId), [ready.planId, secondPlan.planId, thirdPlan.planId]);
  assert.ok(family.slice(0, -1).every(value => value.resolvedResources.size === value.resources.length && value.plan.state === 'PARTIAL'));
  await assert.rejects(f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: second.request }), error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'COMMAND_UNKNOWN');
  assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes);
  resourceZero(f); await checkCold(f, family.map(value => value.plan.planId));
});

test('认证stage/final双名字窗口只在新grant后消私有alias：普通Reader仍要求nlink1且新目标全字节', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await movePlan(f), restore = failRealPreparedReads(f);
  const first = await submit(f, ready); restore(); assert.equal(first.done.state, 'RECOVERY_REQUIRED');
  const staged = f.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(ready.planId)!.events.find(event => event.kind === 'phase' && event.fact.phase === 'TARGET_STAGED'));
  assert.ok(staged?.kind === 'phase' && staged.fact.stage && staged.fact.targetObservation);
  const target = path.join(f.destination, 'Original.flac'); await link(target, staged.fact.stage); assert.equal((await lstat(target)).nlink, 2);
  const verify = await import(new URL('../../dist/collection/source-relocation-verify.js', import.meta.url).href) as typeof import('../../src/collection/source-relocation-verify.js');
  const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await assert.rejects(verify.observeRelocationFile(fd), error => error instanceof verify.RelocationVerificationError && error.issue === 'SOURCE_UNQUALIFIED'); }
  finally { await fd.close(); }
  const next = await recoveryPlan(f, ready.planId, 'keep-target'); assert.equal((await lstat(target)).nlink, 2);
  const capture = f.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(next.planId)!.resources.find(value => value.frozen.role === 'AUDIO')!);
  assert.equal(capture.recovery?.target?.observation.links, '2'); assert.equal(capture.recovery?.target?.aliases.length, 1);
  const result = await submit(f, next); assert.equal(result.done.state, 'SOURCE_RETAINED', JSON.stringify(result.done.issues));
  assert.equal((await lstat(target)).nlink, 1); await assert.rejects(readFile(staged.fact.stage), { code: 'ENOENT' }); assert.deepEqual(await readFile(target), f.bytes);
  resourceZero(f); await checkCold(f, [ready.planId, next.planId]);
});

test('恢复READY后外改目标及空父目录替换/越界链接都在新发布前拒绝；修正后只接受另一完整计划', { timeout: 240_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await movePlan(f), restore = failRealPreparedReads(f);
  const first = await submit(f, ready); restore(); assert.equal(first.done.state, 'RECOVERY_REQUIRED');
  const next = await recoveryPlan(f, ready.planId, 'keep-target'), target = path.join(f.destination, 'Original.flac');
  const request = f.confirm(next), challenge = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request });
  const modified = Buffer.from(f.bytes); modified[modified.length - 1] = modified[modified.length - 1]! ^ 1; await writeFile(target, modified);
  await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: challenge.grant });
  const conflict = await f.waitPlan(next.planId, value => ['RECOVERY_REQUIRED', 'FAILED'].includes(value.state)); assert.equal(conflict.state, 'RECOVERY_REQUIRED');
  assert.deepEqual(await readFile(target), modified); assert.equal(facts(f).length, 0); assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes);
  // 自有夹具恢复被它修改的内容；这不授权服务覆盖冲突，也不重用此前FD观察/命令。
  await writeFile(target, f.bytes); const lastPlan = await recoveryPlan(f, next.planId, 'keep-target'), result = await submit(f, lastPlan);
  assert.equal(result.done.state, 'SOURCE_RETAINED', JSON.stringify(result.done.issues)); assert.equal(facts(f).length, 1);
  await assert.rejects(f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request }), error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'COMMAND_UNKNOWN');
  resourceZero(f); await checkCold(f, [ready.planId, next.planId, lastPlan.planId]);
  for (const replacement of ['directory', 'symlink'] as const) {
    const g = await relocationFixture(t); await g.enable(); await mkdir(path.join(g.destination, 'nested'), { mode: 0o700 });
    // 先授权外层根，随后选择其嵌套目录；目标根自身未换，必须核缺失叶的真实父链。
    await g.main('localRelocationMain.captureTarget', { datasetId: g.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: g.destination });
    const choice = await g.main('localRelocationMain.captureTarget', { datasetId: g.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: path.join(g.destination, 'nested') });
    const original = await g.ready({ kind: 'move', targets: [g.selection()], targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' }), fail = failRealPreparedReads(g);
    assert.equal((await submit(g, original)).done.state, 'RECOVERY_REQUIRED'); fail();
    const staged = g.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(original.planId)!.resources.map(resource => {
      const event = view.projection.plans.get(original.planId)!.events.find(value => value.kind === 'phase' && value.fact.resourceId === resource.frozen.resourceId && value.fact.phase === 'TARGET_STAGED');
      assert.ok(event?.kind === 'phase' && event.fact.stage); return { resource, stage: event.fact.stage };
    }));
    // 自有夹具把本域已认证安装副本保全回其stage；READY目标叶真实缺失，但原FD/claims从未释放。
    for (const file of staged) await rename(path.join(g.destination, file.resource.frozen.target.relative), file.stage);
    const parent = path.join(g.destination, 'nested'); assert.deepEqual(await readdir(parent), []);
    const recovery = await recoveryPlan(g, original.planId, 'keep-target'), request = g.confirm(recovery), challenge = await g.main('localRelocationMain.challenge', { datasetId: g.datasetId, confirm: request });
    const materialPaths = [...new Set(g.repository.localCatalog.privateRelocationRead(view => {
      const plan = view.projection.plans.get(original.planId)!;
      return [...plan.resources.flatMap(resource => { const storage = resource.storage; assert.ok(storage);
        return [path.join(storage.targetPrivateRoot.path, storage.stage), path.join(storage.sourcePrivateRoot.path, storage.quarantine), path.join(storage.sourcePrivateRoot.path, storage.backup)];
      }), ...plan.events.flatMap(event => event.kind === 'phase' ? [event.fact.stage, event.fact.quarantine, event.fact.retained].filter((value): value is string => value !== null) : [])];
    }))];
    // phase内名字包含已预留但未创建的槽位；完整库存同时认证既存全字节和缺失，不能丢掉空槽位。
    const snapshotMaterials = () => Promise.all(materialPaths.map(async name => {
      const file = await lstat(name).catch((error: unknown) => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); return null; });
      if (!file) return { name, state: 'missing' as const, bytes: null };
      assert.equal(file.isFile(), true); assert.equal(file.isSymbolicLink(), false);
      return { name, state: 'file' as const, bytes: await readFile(name) };
    }));
    const materials = await snapshotMaterials(); assert.equal(materials.length, staged.length * 3);
    for (const material of materials) {
      const file = staged.find(value => value.stage === material.name);
      if (file) { assert.equal(material.state, 'file'); assert.deepEqual(material.bytes, file.resource.frozen.role === 'AUDIO' ? g.bytes : g.lyric); }
      else assert.deepEqual(material, { name: material.name, state: 'missing', bytes: null });
    }
    const held = path.join(g.destination, `held-nested-${replacement}`), outside = path.join(g.directory, 'owned-empty-outside'); await mkdir(outside, { mode: 0o700 }); await rename(parent, held);
    if (replacement === 'directory') await mkdir(parent, { mode: 0o700 }); else await symlink(outside, parent, 'dir');
    await g.main('localRelocationMain.executeGranted', { datasetId: g.datasetId, confirm: request, grant: challenge.grant });
    const refused = await g.waitPlan(recovery.planId, value => ['RECOVERY_REQUIRED', 'FAILED'].includes(value.state)); assert.equal(refused.state, 'RECOVERY_REQUIRED');
    const phases = g.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(recovery.planId)!.events.filter(event => event.kind === 'phase'));
    assert.ok(phases.every(event => event.kind === 'phase' && !['SOURCE_CAPTURED', 'TARGET_STAGED', 'TARGET_INSTALLED'].includes(event.fact.phase)));
    assert.deepEqual(await readdir(held), []); assert.deepEqual(await readdir(parent), []); assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readFile(path.join(g.media, 'Original.flac')), g.bytes); assert.deepEqual(await readFile(path.join(g.media, 'Original.lrc')), g.lyric);
    assert.deepEqual(await snapshotMaterials(), materials);
    assert.equal(facts(g).length, 0); assert.deepEqual(g.repository.localCatalog.privateRelocationSnapshot(g.track.assetId), g.original);
    await rename(parent, path.join(g.destination, `retained-replacement-${replacement}`)); await rename(held, parent);
    const fresh = await recoveryPlan(g, recovery.planId, 'keep-target'), result = await submit(g, fresh); assert.equal(result.done.state, 'SOURCE_RETAINED', JSON.stringify(result.done.issues));
    assert.deepEqual(await readFile(path.join(parent, 'Original.flac')), g.bytes); assert.deepEqual(await readFile(path.join(parent, 'Original.lrc')), g.lyric);
    resourceZero(g); await checkCold(g, [original.planId, recovery.planId, fresh.planId]);
  }
});

test('原execute过期不授予；旧已保留计划的cleanup用新具体十分钟grant而不借原expiresAt', { timeout: 180_000 }, async t => {
  let clock = Date.now(); const f = await relocationFixture(t, { now: () => clock }); await f.enable();
  const ready = await movePlan(f), result = await submit(f, ready); assert.equal(result.done.state, 'SOURCE_RETAINED');
  const pending = await f.ready({ kind: 'rename', target: f.selection(), newName: 'Expired.flac', sourceDisposition: 'RETAIN' }), pendingRequest = f.confirm(pending);
  const expired = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: pendingRequest });
  clock += 1_800_001;
  await assert.rejects(f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: pendingRequest, grant: expired.grant }), error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'GRANT_EXPIRED');
  const currentPending = await f.plan(pending.planId); await f.api.cancel({ datasetId: f.datasetId, commandId: randomUUID(), planId: pending.planId, expectedViewRevision: currentPending.viewRevision });
  const cleanup: dto.LocalRelocationPlanCleanup = { ...f.confirm(await f.plan(ready.planId)), verifiedTargetFingerprint: result.done.cleanup.verifiedTargetFingerprint!, sourceResourceIds: result.done.cleanup.sourceResourceIds };
  const fresh = await f.main('localRelocationMain.challengeCleanup', { datasetId: f.datasetId, cleanup }); assert.equal(Date.parse(fresh.expiresAt), clock + 600_000);
  await f.main('localRelocationMain.cleanupGranted', { datasetId: f.datasetId, cleanup, grant: fresh.grant });
  assert.equal((await f.waitPlan(ready.planId, value => value.state === 'COMPLETED' || value.state === 'RECOVERY_REQUIRED')).state, 'COMPLETED');
  assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes); resourceZero(f); await checkCold(f, [ready.planId]);
});

test('真实进程两代unknown后物理退出：冷journal父族只重持一个保护组，新Owner epoch的grant实际登记并冷核', { timeout: 240_000 }, async t => {
  const childEnvironment = { ...process.env }; delete childEnvironment.NODE_TEST_CONTEXT;
  // 独立故障进程走普通node:test输出，不继承父runner私有v8帧协议；原断言/FD/物理退出保持。
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./relocation-recovery-process.ts', import.meta.url)), 'seed-unknown-family'],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let rawBytes = 0; const raw: Buffer[] = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { rawBytes += chunk.length;
    if (rawBytes <= 4_194_304) raw.push(Buffer.from(chunk)); else child.kill('SIGKILL'); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  const seed = await new Promise<ColdRecoverySeed>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`自有未知保护族进程未到界：${Buffer.concat(raw).toString('utf8')}`)); }, 120_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error(`自有未知保护族进程提前结束：${Buffer.concat(raw).toString('utf8')}`)); });
    child.once('message', (value: unknown) => {
      clearTimeout(timer); assert.ok(value && typeof value === 'object' && 'type' in value && value.type === 'owned-unknown-family-prepared' && 'seed' in value);
      resolve(value.seed as ColdRecoverySeed);
    });
  });
  child.kill('SIGKILL'); const stopped = await exit; assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL'); assert.ok(rawBytes <= 4_194_304);
  const f = await coldRelocationFixture(t, seed), before = f.repository.localCatalog.privateRelocationSnapshot(seed.assetId);
  const state = f.repository.localCatalog.privateRelocationRead(view => ({ plans: [...view.projection.plans.values()].map(value => ({ id: value.plan.planId, unresolved: f.modules.journal.relocationUnresolvedResources(value).length })),
    facts: view.projection.latestAssets.size })); assert.equal(state.facts, 0); assert.equal(state.plans.filter(value => value.unresolved > 0).length, 2);
  assert.ok(f.modules.locks.physicalResourceLocks.combinedSnapshot().writers > 0);
  const query = await f.api.get({ datasetId: seed.datasetId, selector: { kind: 'command', commandId: seed.originalCommand.commandId, expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: seed.originalCommand.fingerprint } });
  assert.ok(query.kind === 'command'); assert.deepEqual(query.receipt, seed.originalCommand.receipt);
  assert.deepEqual((await f.plan(seed.rootPlanId)).recoveryChoices, []);
  const origin = await f.plan(seed.originPlanId), choice = origin.recoveryChoices.find(value => value.action === 'keep-target'); assert.ok(choice);
  const receipt = await f.api.preview({ datasetId: seed.datasetId, commandId: randomUUID(), intent: { kind: 'recovery', originPlanId: origin.planId,
    expectedOriginViewRevision: origin.viewRevision, choiceId: choice.choiceId, recoveryFingerprint: choice.recoveryFingerprint } }); assert.equal(receipt.outcome, 'accepted');
  const ready = await f.waitPlan(receipt.planId!, value => value.state !== 'PREVIEWING'); assert.equal(ready.state, 'READY', JSON.stringify(ready.issues));
  const confirm: dto.LocalRelocationPlanConfirm = { datasetId: seed.datasetId, commandId: randomUUID(), planId: ready.planId, expectedViewRevision: ready.viewRevision,
    domain: dto.LOCAL_RELOCATION_PLAN_DOMAIN, planHash: ready.planHash, contextFingerprint: ready.contextFingerprint };
  const challenge = await f.main('localRelocationMain.challenge', { datasetId: seed.datasetId, confirm });
  await f.main('localRelocationMain.executeGranted', { datasetId: seed.datasetId, confirm, grant: challenge.grant });
  const done = await f.waitPlan(ready.planId, value => ['SOURCE_RETAINED', 'COMPLETED', 'RECOVERY_REQUIRED'].includes(value.state)); assert.equal(done.state, 'SOURCE_RETAINED', JSON.stringify(done.issues));
  const after = f.repository.localCatalog.privateRelocationSnapshot(seed.assetId); assert.equal(after.asset.id, before.asset.id); assert.equal(after.asset.fileRevision, before.asset.fileRevision);
  assert.equal(after.asset.locationRevision, String(BigInt(before.asset.locationRevision) + 1n)); assert.equal(after.catalogSha256, before.catalogSha256); assert.deepEqual(after.tracks, before.tracks);
  assert.deepEqual(await readFile(path.join(seed.media, 'Original.flac')), await readFile(path.join(seed.destination, 'Original.flac')));
  const resolved = f.repository.localCatalog.privateRelocationRead(view => f.modules.journal.relocationRecoveryFamily(view.projection, ready.planId));
  assert.equal(resolved.length, 3); assert.ok(resolved.slice(0, -1).every(value => value.resolvedResources.size === value.resources.length));
  assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
  assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  await f.close(); const cold = f.modules.repository.createCollectionRepository({ filePath: seed.filePath });
  try { assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(seed.assetId), after);
    assert.equal(cold.localCatalog.privateRelocationRead(view => [...view.projection.plans.values()].filter(value => f.modules.journal.relocationUnresolvedResources(value).length).length), 0); }
  finally { cold.close(); }
});
