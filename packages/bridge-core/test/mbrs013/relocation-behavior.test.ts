import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as dto from '@music-bridge/contracts';
import { relocationFixture, wholeHash } from './relocation-fixture.js';

test('同内容真实跨逻辑根登记保留ID及原件；首次命令与已授予未知分开，独立cleanup后冷核真实Scanner来源', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await f.enable();
  const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const ready = await f.ready({ kind: 'move', targets: [f.selection()], targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' });
  assert.equal(ready.closure.resourceCount, 2); assert.deepEqual(ready.resources.map(resource => resource.role).sort(), ['AUDIO', 'LYRIC']);
  const request = f.confirm(ready), fingerprint = f.modules.journal.relocationRequestFingerprint('localRelocationPlan.confirm', request);
  const initial = await f.api.get({ datasetId: f.datasetId, selector: { kind: 'command', commandId: request.commandId, expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: fingerprint } });
  assert.ok(initial.kind === 'command'); assert.equal(initial.receipt, null); assert.equal(initial.issue?.code, 'NOT_FOUND');
  const challenge = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request });
  const issued = await f.api.get({ datasetId: f.datasetId, selector: { kind: 'command', commandId: request.commandId, expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: fingerprint } });
  assert.ok(issued.kind === 'command'); assert.equal(issued.receipt, null); assert.equal(issued.issue?.code, 'COMMAND_UNKNOWN'); assert.equal(issued.issue?.retry, 'query-original');
  await assert.rejects(f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request }), error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'COMMAND_UNKNOWN');
  const accepted = await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: challenge.grant }); assert.equal(accepted.outcome, 'accepted');
  const done = await f.waitPlan(ready.planId, plan => ['SOURCE_RETAINED', 'FAILED', 'RECOVERY_REQUIRED'].includes(plan.state)); assert.equal(done.state, 'SOURCE_RETAINED', JSON.stringify(done.issues));
  const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId);
  assert.equal(current.asset.id, f.original.asset.id); assert.notEqual(current.asset.libraryRootId, f.original.asset.libraryRootId);
  assert.equal(current.asset.fileRevision, f.original.asset.fileRevision); assert.equal(BigInt(current.asset.locationRevision), BigInt(f.original.asset.locationRevision) + 1n);
  assert.deepEqual(current.tracks, f.original.tracks); assert.equal(current.catalogSha256, f.original.catalogSha256);
  assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes);
  assert.deepEqual(await readFile(path.join(f.destination, 'Original.lrc')), f.lyric); assert.deepEqual(await readFile(path.join(f.media, 'Original.lrc')), f.lyric);
  assert.equal((await lstat(path.join(f.destination, 'Original.flac'))).nlink, 1); assert.equal((await lstat(path.join(f.media, 'Original.flac'))).nlink, 1);
  const facts = f.repository.localCatalog.privateRelocationRead(view => [...view.projection.events].filter(event => event.kind === 'location-facts'));
  assert.equal(facts.length, 1); const event = facts[0]!; assert.ok(event.kind === 'location-facts');
  assert.equal(event.fact.scan.origin.job.phase, 'completed'); assert.equal(event.fact.scan.origin.job.jobRevision, '3'); assert.notEqual(event.fact.scan.origin.job.jobId, f.initialScanJobId);
  assert.equal(new Set([event.fact.scan.origin.startCommandId, event.fact.scan.origin.resumeCommandId, event.fact.scan.origin.prepareCommandId, event.fact.scan.origin.commitCommandId]).size, 4);
  assert.ok(event.fact.scan.state.readFacts); assert.equal(event.fact.scan.state.readFacts.readEvidence.wholeAudioHash, false);
  const cleanup: dto.LocalRelocationPlanCleanup = { ...f.confirm(done), verifiedTargetFingerprint: done.cleanup.verifiedTargetFingerprint!, sourceResourceIds: [...done.cleanup.sourceResourceIds] };
  const second = await f.main('localRelocationMain.challengeCleanup', { datasetId: f.datasetId, cleanup }); assert.equal(second.grant.action, 'cleanup'); assert.notEqual(second.grant.challengeId, challenge.grant.challengeId);
  await f.main('localRelocationMain.cleanupGranted', { datasetId: f.datasetId, cleanup, grant: second.grant });
  const cleaned = await f.waitPlan(done.planId, plan => plan.state === 'COMPLETED' || plan.state === 'RECOVERY_REQUIRED' || plan.cleanup.state === 'blocked'); assert.equal(cleaned.state, 'COMPLETED', JSON.stringify(cleaned.issues));
  await assert.rejects(readFile(path.join(f.media, 'Original.flac')), { code: 'ENOENT' }); await assert.rejects(readFile(path.join(f.media, 'Original.lrc')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), f.bytes); assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
  assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  await f.close(); const cold = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try { assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(f.track.assetId), current);
    assert.equal(cold.localCatalog.privateRelocationRead(view => view.projection.retainedSources.size), 0);
    assert.equal(cold.localCatalog.privateRelocationRead(view => view.projection.plans.get(done.planId)!.plan.state), 'COMPLETED'); }
  finally { cold.close(); }
});

test('实际同名目标整体拒绝且完整原源/目标字节不被覆盖', { timeout: 120_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const occupied = Buffer.from('独立既有目标，不能覆盖。', 'utf8');
  await writeFile(path.join(f.destination, 'Original.flac'), occupied, { flag: 'wx', mode: 0o600 });
  const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const accepted = await f.api.preview({ datasetId: f.datasetId, commandId: randomUUID(), intent: { kind: 'move', targets: [f.selection()], targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' } });
  assert.equal(accepted.outcome, 'accepted'); const plan = await f.waitPlan(accepted.planId!, value => value.state !== 'PREVIEWING');
  assert.equal(plan.state, 'BLOCKED'); assert.equal(plan.issues[0]?.code, 'COLLISION'); assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes);
  assert.deepEqual(await readFile(path.join(f.destination, 'Original.flac')), occupied); assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original);
  assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
});

test('READY后真实原件外改和grant后外改都拒绝，完整改后源保留且没有目标/新Scanner事实', { timeout: 240_000 }, async t => {
  for (const window of ['READY', 'GRANTED'] as const) {
    const f = await relocationFixture(t); await f.enable(); const ready = await f.ready({ kind: 'rename', target: f.selection(), newName: 'Changed.flac', sourceDisposition: 'RETAIN' });
    const request = f.confirm(ready), challenge = window === 'GRANTED' ? await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request }) : null;
    const modified = Buffer.from(f.bytes); modified[modified.length - 1] = modified[modified.length - 1]! ^ 1; await writeFile(path.join(f.media, 'Original.flac'), modified);
    const permitted = challenge ?? await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request });
    await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: permitted.grant });
    const rejected = await f.waitPlan(ready.planId, plan => ['FAILED', 'DEFERRED', 'RECOVERY_REQUIRED'].includes(plan.state));
    assert.equal(rejected.state, 'FAILED', JSON.stringify(rejected.issues)); assert.equal(rejected.issues[0]?.code, 'SOURCE_CHANGED');
    assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), modified); await assert.rejects(readFile(path.join(f.media, 'Changed.flac')), { code: 'ENOENT' });
    assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.latestAssets.size), 0); assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original);
    assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 }); await f.close();
  }
});

test('CUE改名闭集保留原引用与原音频，目标只改FILE引用且整音频字节与所有Track/Segment身份不变', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t, { cue: true }); await f.enable();
  const ready = await f.ready({ kind: 'rename', target: f.selection(), newName: 'Renamed.flac', sourceDisposition: 'RETAIN' });
  assert.equal(ready.closure.complete, true); assert.deepEqual(ready.resources.map(resource => resource.role).sort(), ['AUDIO', 'CUE', 'LYRIC']);
  const done = await f.complete(ready); assert.equal(done.state, 'SOURCE_RETAINED');
  assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.media, 'Renamed.flac')), f.bytes);
  assert.deepEqual(await readFile(path.join(f.media, 'Original.cue')), f.cue);
  assert.deepEqual(await readFile(path.join(f.media, 'Renamed.cue')), Buffer.from(f.cue.toString('utf8').replace('"Original.flac"', '"Renamed.flac"'), 'utf8'));
  const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId); assert.equal(current.asset.id, f.original.asset.id); assert.equal(current.asset.fileRevision, f.original.asset.fileRevision);
  assert.deepEqual(current.tracks, f.original.tracks); assert.equal(done.cleanup.sourceResourceIds.length, 3); assert.equal(done.cleanup.state, 'eligible');
  assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
});

test('可信旧全Hash限定的missing候选重定位保ID；普通nullable旧SHA不能因同名/同字节猜测升级', { timeout: 240_000 }, async t => {
  for (const trusted of [true, false]) {
    const f = await relocationFixture(t, { trustedWholeHash: trusted }); await f.enable();
    await copyFile(path.join(f.media, 'Original.flac'), path.join(f.destination, 'Candidate.flac')); await unlink(path.join(f.media, 'Original.flac'));
    const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'file', absolutePath: path.join(f.destination, 'Candidate.flac') });
    const accepted = await f.api.preview({ datasetId: f.datasetId, commandId: randomUUID(), intent: { kind: 'locate', target: f.selection(), candidateId: choice.choiceId, targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' } });
    assert.equal(accepted.outcome, 'accepted'); const plan = await f.waitPlan(accepted.planId!, value => value.state !== 'PREVIEWING');
    if (!trusted) { assert.equal(plan.state, 'BLOCKED'); assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.latestAssets.size), 0); }
    else { assert.equal(plan.state, 'READY', JSON.stringify(plan.issues)); const done = await f.complete(plan); assert.equal(done.state, 'SOURCE_RETAINED');
      const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId); assert.equal(current.asset.id, f.original.asset.id); assert.equal(current.asset.fileRevision, f.original.asset.fileRevision);
      assert.deepEqual(current.tracks, f.original.tracks); assert.equal(current.catalogSha256, wholeHash(f.bytes));
      const audio = f.repository.localCatalog.privateRelocationRead(view => view.projection.plans.get(done.planId)!.resources.find(resource => resource.frozen.role === 'AUDIO')!);
      assert.equal(audio.sourceAbsent, true); assert.equal(audio.sourceObservationOrigin, 'CANDIDATE_FD_MATCHING_CATALOG_SHA256');
      assert.ok(!done.cleanup.sourceResourceIds.includes(audio.frozen.resourceId));
      assert.ok(f.repository.localCatalog.privateRelocationRead(view => [...view.projection.retainedSources.values()].every(value => value.resourceId !== audio.frozen.resourceId))); }
    assert.deepEqual(await readFile(path.join(f.destination, 'Candidate.flac')), f.bytes); assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 }); await f.close();
  }
});

test('013冷journal沿原Scanner allocation 64MiB边界，不把旧真实Reader的64MiB资格降为32MiB', { timeout: 120_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const ready = await f.ready({ kind: 'rename', target: f.selection(), newName: 'Boundary.flac', sourceDisposition: 'RETAIN' }); await f.complete(ready);
  const event = f.repository.localCatalog.privateRelocationRead(view => view.projection.events.find(value => value.kind === 'location-facts'))!; assert.ok(event.kind === 'location-facts');
  const facts = event.fact.scan.state.readFacts!;
  for (const allocationBytes of [64 * 1024 * 1024, 64 * 1024 * 1024 + 1]) {
    const readFacts = { ...facts, readEvidence: { ...facts.readEvidence, allocationBytes } }, fact = { ...event.fact, scan: { ...event.fact.scan, state: { ...event.fact.scan.state, readFacts } } };
    const body = { version: 1 as const, eventId: randomUUID(), datasetId: f.datasetId, planId: ready.planId, occurredAt: new Date().toISOString(), kind: 'location-facts' as const, fact };
    assert.equal(f.modules.scanStore.isScanReadFacts(readFacts), allocationBytes === 64 * 1024 * 1024);
    if (allocationBytes === 64 * 1024 * 1024) { const boundary = f.modules.journal.relocationEvent(body); assert.equal(f.modules.journal.isRelocationEvent(boundary), true); }
    else assert.throws(() => f.modules.journal.relocationEvent(body), error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'RECOVERY_REQUIRED');
  }
});

test('真实大小写名字与Unicode名字改名保留ID/完整字节；实际文件系统别名只接受成功搬迁或明确碰撞拒绝', { timeout: 240_000 }, async t => {
  for (const newName of ['original.flac', '世界-é.flac']) {
    const f = await relocationFixture(t); await f.enable(); const originalPath = path.join(f.media, 'Original.flac'), target = path.join(f.media, newName);
    const originalStat = await lstat(originalPath, { bigint: true }); let alias = false;
    try { const targetStat = await lstat(target, { bigint: true }); alias = targetStat.dev === originalStat.dev && targetStat.ino === originalStat.ino; }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
    const receipt = await f.api.preview({ datasetId: f.datasetId, commandId: randomUUID(), intent: { kind: 'rename', target: f.selection(), newName, sourceDisposition: 'RETAIN' } });
    assert.equal(receipt.outcome, 'accepted'); const preview = await f.waitPlan(receipt.planId!, value => value.state !== 'PREVIEWING');
    if (preview.state === 'BLOCKED') {
      assert.equal(alias, true); assert.equal(preview.issues[0]?.code, 'COLLISION');
      assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original); assert.deepEqual(await readFile(originalPath), f.bytes);
      assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.latestAssets.size), 0);
    } else {
      assert.equal(preview.state, 'READY', JSON.stringify(preview.issues)); const done = await f.complete(preview); assert.equal(done.state, 'COMPLETED');
      const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId);
      assert.equal(current.asset.id, f.original.asset.id); assert.equal(current.asset.fileRevision, f.original.asset.fileRevision); assert.deepEqual(current.tracks, f.original.tracks);
      assert.equal(current.asset.locationRevision, String(BigInt(f.original.asset.locationRevision) + 1n)); assert.equal(current.relative, newName);
      assert.deepEqual(await readFile(target), f.bytes); assert.equal(wholeHash(await readFile(target)), wholeHash(f.bytes)); assert.equal((await lstat(target)).nlink, 1);
      assert.deepEqual(await readFile(path.join(f.media, newName.replace(/\.flac$/u, '.lrc'))), f.lyric);
      await f.close(); const cold = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
      try { assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(f.track.assetId), current); } finally { cold.close(); }
    }
    assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 }); await f.close();
  }
});

test('真实目标符号链接与源闭集越界链接拒绝，公开相对路径不能越过根且自有边界外字节完整保留', { timeout: 120_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const external = path.join(f.directory, 'outside-owned.bin'), bytes = Buffer.from('自有根外完整内容，服务不能访问或改写。', 'utf8');
  await writeFile(external, bytes, { mode: 0o600, flag: 'wx' }); const pickedLink = path.join(f.directory, 'linked-destination'); await symlink(f.destination, pickedLink, 'dir');
  await assert.rejects(f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: pickedLink }),
    error => error instanceof f.modules.journal.LocalRelocationError && error.code === 'SYMLINK');
  const escapingLink = path.join(f.media, 'Escaping.lrc'); await symlink(external, escapingLink);
  const receipt = await f.api.preview({ datasetId: f.datasetId, commandId: randomUUID(), intent: { kind: 'rename', target: f.selection(), newName: 'Safe.flac', sourceDisposition: 'RETAIN' } });
  assert.equal(receipt.outcome, 'accepted'); const blocked = await f.waitPlan(receipt.planId!, value => value.state !== 'PREVIEWING');
  assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.issues[0]?.code, 'UNKNOWN_REFERENCE');
  await assert.rejects(f.api.preview({ datasetId: f.datasetId, commandId: randomUUID(), intent: { kind: 'rename', target: f.selection(), newName: '../Escaped.flac', sourceDisposition: 'RETAIN' } }), /位置计划的数据描述符、闭集或预算无效/u);
  assert.deepEqual(await readFile(external), bytes); assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.media, 'Original.lrc')), f.lyric);
  assert.equal((await lstat(escapingLink)).isSymbolicLink(), true); await assert.rejects(readFile(path.join(f.media, 'Safe.flac')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.directory, 'Escaped.flac')), { code: 'ENOENT' }); assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original);
  assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.latestAssets.size), 0);
  assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
});

test('READY及具体grant后实际替换目标根名字拒绝；新根既有内容、原根与源全字节保持，无新Scanner事实', { timeout: 120_000 }, async t => {
  const f = await relocationFixture(t); await f.enable(); const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const ready = await f.ready({ kind: 'move', targets: [f.selection()], targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' }), request = f.confirm(ready);
  const challenge = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request }), originalRoot = await lstat(f.destination, { bigint: true });
  const heldRoot = path.join(f.directory, 'held-original-destination'); await rename(f.destination, heldRoot); await mkdir(f.destination, { mode: 0o700 });
  const replaced = await lstat(f.destination, { bigint: true }); assert.notEqual(replaced.ino, originalRoot.ino);
  const secret = Buffer.from('替代根自己的完整文件。', 'utf8'); await writeFile(path.join(f.destination, 'owned-secret.bin'), secret, { mode: 0o600, flag: 'wx' });
  await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: challenge.grant });
  const rejected = await f.waitPlan(ready.planId, value => ['FAILED', 'RECOVERY_REQUIRED'].includes(value.state)); assert.equal(rejected.state, 'FAILED', JSON.stringify(rejected.issues));
  assert.equal(rejected.issues[0]?.code, 'ROOT_CHANGED'); assert.deepEqual(await readFile(path.join(f.destination, 'owned-secret.bin')), secret);
  assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.media, 'Original.lrc')), f.lyric);
  await assert.rejects(readFile(path.join(heldRoot, 'Original.flac')), { code: 'ENOENT' }); await assert.rejects(readFile(path.join(f.destination, 'Original.flac')), { code: 'ENOENT' });
  assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original); assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.latestAssets.size), 0);
  assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
});
