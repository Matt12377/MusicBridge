import { createMediaPlanningCoordinator } from '../src/recording/media-coordinator.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createSourceEvidenceService } from '../src/recording/source-evidence.js';
import { probeReadonlySource, SourceFileError } from '../src/recording/source-files.js';

function wav(seconds = 1): Buffer {
  const bytes = 44100 * 4 * seconds, b = Buffer.alloc(44 + bytes);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(176400, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
async function fixture(t: test.TestContext, probe?: typeof probeReadonlySource) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-source-evidence-')));
  const source = path.join(directory, 'private-source-root'), filePath = path.join(directory, 'collection.sqlite');
  await mkdir(source); const audio = wav(), file = path.join(source, 'actual-source.wav'); await writeFile(file, audio);
  const repository = createCollectionRepository({ filePath });
  const service = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts, ...(probe ? { probe } : {}) });
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: '源验证合成草稿', programType: 'compilation', metadata: [{ title: '合成曲目' }] });
  const root = await service.authorize(randomUUID(), source);
  const selection = () => ({ commandId: randomUUID(), draftId: draft.draftId, trackId: draft.trackIds[0]!, rootId: root.id, acquisition: 'userFileBind' as const });
  t.after(async () => { await service.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, source, file, audio, filePath, repository, service, draft, root, selection };
}

test('Gate A：实际文件全量 Hash/技术参数与人工映射独立；只读并跨重启保留', async t => {
  const f = await fixture(t), selection = f.selection();
  assert.equal((await f.service.snapshot(f.draft.draftId)).sourceLockEligible, false);
  assert.equal(f.service.start(selection, f.file).state, 'running'); await f.service.idle();
  const job = f.service.job(selection.commandId).job!; assert.equal(job.state, 'completed');
  const first = await f.service.snapshot(f.draft.draftId), binding = first.tracks[0]!.binding!;
  assert.equal(binding.sha256, createHash('sha256').update(f.audio).digest('hex'));
  assert.equal(binding.technical.sampleRate, 44100); assert.equal(binding.technical.channels, 2); assert.equal(binding.technical.bitsPerSample, 16); assert.equal(binding.technical.durationMs, 1000);
  assert.equal(binding.verification, 'fileHashVerified'); assert.equal(binding.preservation, 'externalReferenceOnly'); assert.equal(binding.userConfirmed, false); assert.equal(first.sourceLockEligible, false);
  assert.ok(!JSON.stringify(first).includes(f.source)); assert.ok(!JSON.stringify(first).includes('private-source-root'));
  await f.service.confirm({ commandId: randomUUID(), id: binding.id, draftId: f.draft.draftId, trackId: selection.trackId, userConfirmed: true });
  assert.equal((await f.service.snapshot(f.draft.draftId)).sourceLockEligible, true);
  assert.deepEqual(await readFile(f.file), f.audio);
  const after = f.service.start(selection, '/must-not-read/retry.wav'); assert.equal(after.bindingId, binding.id);
  await f.service.close(); f.repository.close();
  const reopened = createCollectionRepository({ filePath: f.filePath });
  const service = createSourceEvidenceService({ store: reopened.sources, drafts: reopened.drafts });
  try { assert.equal((await service.snapshot(f.draft.draftId)).sourceLockEligible, true); assert.equal(service.job(selection.commandId).job?.state, 'completed'); }
  finally { await service.close(); reopened.close(); }
});

test('Gate A：Roon 导出只证明选中文件；改动后不能用旧证据确认；全量重验不同 Hash 失效', async t => {
  const f = await fixture(t), selection = { ...f.selection(), acquisition: 'roonDesktopExport' as const };
  f.service.start(selection, f.file); await f.service.idle();
  const binding = (await f.service.snapshot(f.draft.draftId)).tracks[0]!.binding!;
  assert.equal(binding.acquisition, 'roonDesktopExport'); assert.equal(binding.userConfirmed, false);
  await writeFile(f.file, wav(2));
  const request = { commandId: randomUUID(), id: binding.id, draftId: selection.draftId, trackId: selection.trackId, userConfirmed: true as const };
  assert.equal((await f.service.snapshot(selection.draftId)).tracks[0]!.binding!.availability, 'CONTENT_CHANGED');
  await assert.rejects(f.service.confirm(request));
  const recheck = f.service.recheck({ ...request, commandId: randomUUID() }); await f.service.idle();
  assert.equal(f.service.job(recheck.id).job?.failure, 'CONTENT_CHANGED');
  assert.equal((await f.service.snapshot(selection.draftId)).sourceLockEligible, false);
});

test('Gate A：Root 离线、单文件丢失、撤销授权互不混淆；历史绑定不删除', async t => {
  const f = await fixture(t), selection = f.selection(); f.service.start(selection, f.file); await f.service.idle();
  await rename(f.source, f.source + '-offline');
  assert.equal((await f.service.snapshot(selection.draftId)).tracks[0]!.binding!.availability, 'SOURCE_ROOT_OFFLINE');
  await rename(f.source + '-offline', f.source); await rename(f.file, f.file + '.moved');
  assert.equal((await f.service.snapshot(selection.draftId)).tracks[0]!.binding!.availability, 'MISSING');
  await f.service.revoke({ commandId: randomUUID(), id: f.root.id });
  assert.equal((await f.service.snapshot(selection.draftId)).tracks[0]!.binding!.availability, 'REVOKED');
  assert.deepEqual(await readFile(f.file + '.moved'), f.audio);
});

test('Gate A：未授权路径、目录及符号链接拒绝；未知音频不会生成绑定', async t => {
  const f = await fixture(t);
  assert.throws(() => f.service.start(f.selection(), path.join(f.directory, 'outside.wav')), SourceFileError);
  await symlink(f.file, path.join(f.source, 'linked.wav'));
  const link = f.selection(); f.service.start(link, path.join(f.source, 'linked.wav')); await f.service.idle();
  assert.equal(f.service.job(link.commandId).job?.failure, 'OUTSIDE_ROOT');
  const invalid = path.join(f.source, 'false.wav'); await writeFile(invalid, 'not actual audio');
  const selection = f.selection(); f.service.start(selection, invalid); await f.service.idle();
  assert.equal(f.service.job(selection.commandId).job?.failure, 'UNSUPPORTED'); assert.equal((await f.service.snapshot(selection.draftId)).sourceLockEligible, false);
});

test('Gate A：显式相同 Hash 重新定位保留内容身份；不同内容不能凭相似名字替换', async t => {
  const f = await fixture(t), selection = f.selection(); f.service.start(selection, f.file); await f.service.idle();
  const binding = (await f.service.snapshot(selection.draftId)).tracks[0]!.binding!;
  await f.service.confirm({ commandId: randomUUID(), id: binding.id, draftId: selection.draftId, trackId: selection.trackId, userConfirmed: true });
  const relocated = path.join(f.source, 'relocated.wav'); await rename(f.file, relocated);
  const request = { ...f.selection(), relocateBindingId: binding.id }; f.service.start(request, relocated); await f.service.idle();
  const current = (await f.service.snapshot(selection.draftId)).tracks[0]!.binding!;
  assert.equal(current.id, binding.id); assert.equal(current.sourceLockEligible, true); assert.equal(current.fileName, 'relocated.wav');
  await writeFile(f.file, wav(2)); const mismatch = { ...f.selection(), relocateBindingId: binding.id }; f.service.start(mismatch, f.file); await f.service.idle();
  assert.equal(f.service.job(mismatch.commandId).job?.failure, 'HASH_MISMATCH');
  assert.equal((await f.service.snapshot(selection.draftId)).tracks[0]!.binding!.fileName, 'relocated.wav');
});

test('后台取消与撤销授权拒绝迟到结果；同一操作不同选曲请求拒绝', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (root, relative, signal) => { await gate; return probeReadonlySource(root, relative, signal); });
  const selection = f.selection(); f.service.start(selection, f.file);
  assert.throws(() => f.service.start({ ...selection, acquisition: 'roonDesktopExport' }, f.file));
  assert.equal(f.service.cancel({ commandId: randomUUID(), id: selection.commandId }).state, 'cancelled');
  release(); await f.service.idle();
  assert.equal(f.service.job(selection.commandId).job?.state, 'cancelled'); assert.equal((await f.service.snapshot(selection.draftId)).tracks[0]!.binding, undefined);
});

test('重启将未完成校验标为中断，不重读源文件或重放；源账本不可修改', async t => {
  const f = await fixture(t), selection = f.selection();
  f.repository.sources.start(selection, 'actual-source.wav', false);
  await f.service.close(); f.repository.close();
  const reopened = createCollectionRepository({ filePath: f.filePath }); let probes = 0;
  const service = createSourceEvidenceService({ store: reopened.sources, drafts: reopened.drafts, probe: async (...args) => { probes++; return probeReadonlySource(...args); } });
  try { assert.equal(service.job(selection.commandId).job?.state, 'interrupted'); assert.equal(probes, 0); assert.equal(service.start(selection, f.file).state, 'interrupted'); }
  finally { await service.close(); reopened.close(); }
  const db = new DatabaseSync(f.filePath); try { assert.throws(() => db.exec("UPDATE source_ledger SET result='changed'"), /immutable ledger/u); } finally { db.close(); }
});

test('截断 WAV 不能凭头部声明的时长生成可确认的证据', async t => {
  const f = await fixture(t), selection = f.selection();
  await writeFile(f.file, f.audio.subarray(0, 100));
  f.service.start(selection, f.file); await f.service.idle();
  assert.equal(f.service.job(selection.commandId).job?.state, 'failed');
  assert.equal(f.service.job(selection.commandId).job?.failure, 'UNSUPPORTED');
  assert.equal((await f.service.snapshot(selection.draftId)).tracks[0]!.binding, undefined);
});

test('超过头部缓存的大 WAV 仍按真实数据块探测完整时长，而不是前缀长度', async t => {
  const f = await fixture(t), selection = f.selection(), large = wav(120);
  await writeFile(f.file, large); f.service.start(selection, f.file); await f.service.idle();
  assert.equal(f.service.job(selection.commandId).job?.state, 'completed');
  const binding = (await f.service.snapshot(selection.draftId)).tracks[0]!.binding!;
  assert.equal(binding.technical.durationMs, 120000); assert.equal(binding.sha256, createHash('sha256').update(large).digest('hex'));
});

test('Gate A-02：真实编码的合成 FLAC 与 AIFF 均只探测技术块，标签不参与证据', async t => {
  const f = await fixture(t);
  // 882 帧双声道静音，经离线 FFmpeg 编码后仅保留 STREAMINFO 与实际 FLAC 帧。
  const flac = Buffer.from('ZkxhQ4AAACISABIAAAAQAAAQCsRC8AAAA3JYQ0OdxN3RU9NrbtgAUZld//h5GAADcWkAAAAAAAB1bg==', 'base64');
  const aiff = Buffer.alloc(54 + 176400); aiff.write('FORM'); aiff.writeUInt32BE(aiff.length - 8, 4); aiff.write('AIFFCOMM', 8); aiff.writeUInt32BE(18, 16); aiff.writeUInt16BE(2, 20); aiff.writeUInt32BE(44100, 22); aiff.writeUInt16BE(16, 26); Buffer.from('400eac44000000000000', 'hex').copy(aiff, 28); aiff.write('SSND', 38); aiff.writeUInt32BE(176408, 42);
  for (const [file, codec, durationMs] of [[flac, 'FLAC', 20], [aiff, 'PCM', 1000]] as const) {
    await writeFile(f.file, file); const selection = f.selection(); f.service.start(selection, f.file); await f.service.idle();
    assert.equal(f.service.job(selection.commandId).job?.state, 'completed'); const b = (await f.service.snapshot(selection.draftId)).tracks[0]!.binding!;
    assert.equal(b.technical.codec, codec); assert.equal(b.technical.durationMs, durationMs); assert.equal(b.sha256, createHash('sha256').update(file).digest('hex')); assert.equal(b.sourceLockEligible, false);
  }
});

test('完成事务中断回滚绑定，源文件和既有草稿不变', async t => {
  const f = await fixture(t); await f.service.close(); f.repository.close();
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (action === 'complete-source-probe') throw new Error('合成提交中断'); } });
  const service = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
  try { const request = f.selection(); service.start(request, f.file); await service.idle(); assert.equal(service.job(request.commandId).job?.state, 'failed'); assert.equal((await service.snapshot(request.draftId)).tracks[0]!.binding, undefined); assert.equal(repository.drafts.detail(request.draftId).trackCount, 1); assert.deepEqual(await readFile(f.file), f.audio); }
  finally { await service.close(); repository.close(); }
});

test('校验期间撤销 Root、移除曲目或改变文件均不能提交迟到结果', async t => {
  for (const action of ['revoke', 'remove-track', 'change-file'] as const) {
    await t.test(action, async t => {
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const f = await fixture(t, async (root, relative, signal) => { const evidence = await probeReadonlySource(root, relative, signal); await gate; return evidence; });
      const request = f.selection(); f.service.start(request, f.file);
      // 探测已进入后台；用可控等待避免睡眠和文件尺寸推测。
      if (action === 'revoke') await f.service.revoke({ commandId: randomUUID(), id: f.root.id });
      else if (action === 'remove-track') f.repository.drafts.update({ commandId: randomUUID(), draftId: request.draftId, expectedRevision: 1, title: '曲目已移除', programType: 'compilation', trackIds: [] }, 'b'.repeat(64));
      else await writeFile(f.file, 'changed during probe');
      release(); await f.service.idle();
      assert.equal(f.service.job(request.commandId).job?.state, 'failed'); assert.equal((await f.service.snapshot(request.draftId)).sourceLockEligible, false);
    });
  }
});

test('含点路径段的请求不通过规范化绕过 Root 路径护栏', async t => {
  const f = await fixture(t);
  assert.throws(() => f.service.start(f.selection(), `${f.source}/nested/../actual-source.wav`), SourceFileError);
});

test('修改时间与验证时间分开记录，公开证据不包含私有文件身份串', async t => {
  const f = await fixture(t), request = f.selection(); f.service.start(request, f.file); await f.service.idle();
  const binding = (await f.service.snapshot(request.draftId)).tracks[0]!.binding!;
  assert.match(String((binding as unknown as { modifiedAt?: string }).modifiedAt), /^\d{4}-\d\d-\d\dT/u);
  assert.ok(!('signature' in binding));
});

test('数据库暂时拒绝完成和失败写入时不产生未处理后台拒绝，恢复后只补记失败', async t => {
  const f = await fixture(t); await f.service.close(); f.repository.close(); let unavailable = false;
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (unavailable && ['complete-source-probe', 'fail-source-probe'].includes(action)) throw new Error('合成数据库暂时不可写'); } });
  let probes = 0; const service = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts, probe: async (...args) => { probes++; return probeReadonlySource(...args); } });
  try {
    const request = f.selection(); service.start(request, f.file); unavailable = true;
    await assert.doesNotReject(service.idle()); unavailable = false;
    assert.equal(service.job(request.commandId).job?.state, 'failed'); assert.equal(probes, 1);
    assert.equal((await service.snapshot(request.draftId)).tracks[0]!.binding, undefined);
  } finally { unavailable = false; await service.close(); repository.close(); }
});

test('分面重新取实际源时长，绑定与内容变化使旧规划失效且不能回退估算', async t => {
  const f = await fixture(t), coordinator = createMediaPlanningCoordinator({ store: f.repository.media, drafts: f.repository.drafts, sources: f.service });
  const spec = { format: 'cassette' as const, splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II' as const], dat: false } };
  const request = { draftId: f.draft.draftId, spec, page: { offset: 0, limit: 20 } };
  const preview = await coordinator.preview(request);
  assert.equal(preview.sourceBasis, 'roon-estimate'); assert.equal(preview.layout.sides[0]!.durationMs, undefined);
  const save = { commandId: randomUUID(), draftId: preview.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec };
  const plan = await coordinator.save(save);
  assert.equal((await coordinator.detail(plan.id)).requiresReview, false);
  const selection = f.selection(); f.service.start(selection, f.file); await f.service.idle();
  assert.equal((await coordinator.preview(request)).sourceBasis, 'unavailable');
  const binding = (await f.service.snapshot(f.draft.draftId)).tracks[0]!.binding!;
  await f.service.confirm({ commandId: randomUUID(), id: binding.id, draftId: f.draft.draftId, trackId: selection.trackId, userConfirmed: true });
  const verified = await coordinator.preview(request);
  assert.equal(verified.sourceBasis, 'verified-sources'); assert.equal(verified.layout.sides[0]!.durationMs, 1000);
  assert.equal((await coordinator.detail(plan.id)).requiresReview, true);
  await assert.rejects(coordinator.save({ ...save, commandId: randomUUID() }));
  const refreshed = await coordinator.save({ ...save, commandId: randomUUID(), planId: plan.id, expectedRevision: plan.revision, inputFingerprint: verified.inputFingerprint });
  assert.equal(refreshed.requiresReview, false);
  assert.equal((await coordinator.save(save)).id, plan.id, '回执重试返回同一规划，不新建');
  await writeFile(f.file, wav(2));
  const changed = await coordinator.preview(request);
  assert.equal(changed.sourceBasis, 'unavailable'); assert.equal(changed.layout.sides[0]!.durationMs, undefined);
  assert.equal((await coordinator.detail(plan.id)).requiresReview, true);
  assert.ok(!JSON.stringify(changed).includes(f.source));
});
