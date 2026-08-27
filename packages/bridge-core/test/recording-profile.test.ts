import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionRepository } from '../src/collection/repository.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RecordingProfileVersion, RecordingProfileHistory, SaveRecordingProfileRequest, RecordingSessionSettings, SaveRecordingSessionRequest, ResolvedRecordingSettings } from '@music-bridge/contracts';
import { isRecordingProfileVersion, isRecordingProfileHistory, isResolvedRecordingSettings } from '@music-bridge/contracts';
import { recordingProfileContent } from './helpers/recording-profile-fixture.js';

interface Profiles {
  list(): { profiles: readonly RecordingProfileVersion[] };
  history(id: string): RecordingProfileHistory;
  version(id: string): RecordingProfileVersion;
  save(request: SaveRecordingProfileRequest): RecordingProfileVersion;
  session(draftId: string): { session: RecordingSessionSettings | null };
  saveSession(request: SaveRecordingSessionRequest): RecordingSessionSettings;
  resolve(session: RecordingSessionSettings): ResolvedRecordingSettings;
}
function profiles(repository: ReturnType<typeof createCollectionRepository>): Profiles { return (repository as unknown as { recordingProfiles: Profiles }).recordingProfiles; }
async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-profile-'))), filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, filePath, repository, store: profiles(repository) };
}
const request = (): SaveRecordingProfileRequest => ({ commandId: randomUUID(), content: recordingProfileContent(), userConfirmed: true });

test('录音 Profile 有独立持久化仓库，不从 V2 当前播放状态借用默认值', t => {
  const repository = createCollectionRepository({ filePath: ':memory:' }); t.after(() => repository.close());
  assert.ok('recordingProfiles' in repository, '缺少可复用录音 Profile 仓库');
});
test('保存 Profile 产生可复用版本，命令幂等且修改默认值不修改历史', async t => {
  const f = await fixture(t), create = request(); assert.deepEqual(f.store.list(), { profiles: [] });
  const v1 = f.store.save(create); assert.equal(isRecordingProfileVersion(v1), true); assert.equal(v1.sequence, 1); assert.deepEqual(f.store.save(create), v1);
  const v2 = f.store.save({ ...request(), profileId: v1.profileId, expectedVersionId: v1.id, content: { ...create.content, name: '新版默认参数', defaults: { ...create.content.defaults, noiseReduction: 'Dolby B' } } });
  assert.equal(v2.sequence, 2); assert.equal(v2.parentVersionId, v1.id); assert.deepEqual(f.store.version(v1.id), v1); assert.deepEqual(f.store.save(create), v1); assert.deepEqual(f.store.list(), { profiles: [v2] });
  assert.equal(isRecordingProfileHistory(f.store.history(v1.profileId)), true); assert.deepEqual(f.store.history(v1.profileId).versions, [v2,v1]);
  assert.throws(() => f.store.save({ ...create, content: { ...create.content, name: '改用原命令' } }));
  assert.throws(() => f.store.save({ ...request(), profileId: v1.profileId, expectedVersionId: v1.id }));
  assert.equal(f.store.history(v1.profileId).versions.length, 2);
});
test('Session 只覆盖变化项，明确 null 不回退默认；旧参数不受新 Profile 影响', async t => {
  const f = await fixture(t), create = request(), v1 = f.store.save(create);
  const draft = f.repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: '合成参数草稿', programType: 'compilation', metadata: [{ title: '合成曲目' }] });
  assert.deepEqual(f.store.session(draft.draftId), { session: null });
  const save: SaveRecordingSessionRequest = { commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 0, profileVersionId: v1.id, overrides: { noiseReduction: null, recordLevel: '人工电平 -3 dB' }, userConfirmed: true };
  const session = f.store.saveSession(save), resolved = f.store.resolve(session); assert.equal(isResolvedRecordingSettings(resolved), true);
  assert.equal(resolved.effective.noiseReduction, null); assert.equal(resolved.effective.recordLevel, '人工电平 -3 dB'); assert.equal(resolved.effective.calibration, v1.content.defaults.calibration); assert.equal(resolved.format.outputProfileVersion, v1.id);
  f.store.save({ ...request(), profileId: v1.profileId, expectedVersionId: v1.id, content: { ...create.content, defaults: { ...create.content.defaults, calibration: '新习惯' } } });
  assert.deepEqual(f.store.resolve(session), resolved);
  const session2 = f.store.saveSession({ ...save, commandId: randomUUID(), expectedRevision: 1, overrides: {} }); assert.equal(session2.revision, 2); assert.deepEqual(f.store.saveSession(save), session); assert.equal(f.store.session(draft.draftId).session!.revision, 2);
  assert.throws(() => f.store.saveSession({ ...save, commandId: randomUUID(), expectedRevision: 0 }));
  assert.throws(() => f.store.saveSession({ ...save, recordLevel: '额外字段' } as SaveRecordingSessionRequest));
});
test('Profile 与 Session 提交失败均回滚，原命令可安全重试', async t => {
  let failure = 'save-recording-profile'; const f = await fixture(t, action => { if (action === failure) throw new Error('合成事务失败'); });
  const create = request(); assert.throws(() => f.store.save(create)); assert.deepEqual(f.store.list(), { profiles: [] }); failure = '';
  const profile = f.store.save(create); assert.equal(profile.sequence, 1); assert.deepEqual(f.store.save(create), profile);
  const draft = f.repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: '合成故障草稿', programType: 'continuous', metadata: [{ title: '曲目' }] });
  const save: SaveRecordingSessionRequest = { commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 0, profileVersionId: profile.id, overrides: {}, userConfirmed: true };
  failure = 'save-recording-session'; assert.throws(() => f.store.saveSession(save)); assert.equal(f.store.session(draft.draftId).session, null);
  failure = ''; assert.equal(f.store.saveSession(save).revision, 1); assert.equal(f.store.saveSession(save).revision, 1);
});
test('Profile/账本不可被 SQL 改写，冷启动保留版本、Session 与命令结果', async t => {
  const f = await fixture(t), create = request(), version = f.store.save(create);
  const draft = f.repository.drafts.append({ commandId: randomUUID(), fingerprint: 'b'.repeat(64), title: '冷启动参数', programType: 'continuous', metadata: [{ title: '曲目' }] });
  const save: SaveRecordingSessionRequest = { commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 0, profileVersionId: version.id, overrides: { calibration: '本次校准' }, userConfirmed: true }, session = f.store.saveSession(save);
  const db = new DatabaseSync(f.filePath); try {
    assert.throws(() => db.prepare('UPDATE recording_profile_versions SET data=data WHERE id=?').run(version.id));
    assert.throws(() => db.prepare('DELETE FROM recording_profile_versions WHERE id=?').run(version.id));
    assert.throws(() => db.prepare('UPDATE recording_profile_ledger SET result=result WHERE command_id=?').run(create.commandId));
    assert.throws(() => db.prepare('DELETE FROM recording_profile_ledger WHERE command_id=?').run(save.commandId));
  } finally { db.close(); }
  f.repository.close(); const reopened = createCollectionRepository({ filePath: f.filePath }); t.after(() => reopened.close()); const store = profiles(reopened);
  assert.deepEqual(store.save(create), version); assert.deepEqual(store.saveSession(save), session); assert.deepEqual(store.session(draft.draftId), { session }); assert.equal(store.list().profiles.length, 1);
});
test('无效/未确认参数、未知版本或草稿不落库，不给伪造后端认证', async t => {
  const f = await fixture(t), create = request();
  for (const patch of [{ userConfirmed: false }, { content: { ...create.content, signalChain: [] } }, { content: { ...create.content, executionFormat: { ...create.content.executionFormat, outputProfileVersion: randomUUID() } } }, { content: { ...create.content, certified: true } }]) assert.throws(() => f.store.save({ ...create, ...patch } as SaveRecordingProfileRequest));
  assert.deepEqual(f.store.list(), { profiles: [] });
  assert.throws(() => f.store.version(randomUUID())); assert.throws(() => f.store.history(randomUUID())); assert.throws(() => f.store.session(randomUUID()));
});

test('schema 10 到 12 任一迁移提交失败均回滚，旧草稿与库存账本不变', async t => {
  for (const failedAction of ['migrate-recording-profiles','migrate-execution']) {
    const f = await fixture(t), draft = f.repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: '迁移保留草稿', programType: 'continuous', metadata: [{ title: '曲目' }] }), before = f.repository.drafts.detail(draft.draftId);
    f.repository.close(); const db = new DatabaseSync(f.filePath);
    db.exec('DROP TABLE execution_assets; DROP TABLE execution_jobs; DROP TABLE execution_ledger; DROP TABLE recording_sessions; DROP TABLE recording_profile_versions; DROP TABLE recording_profiles; DROP TABLE recording_profile_ledger; PRAGMA user_version=10');
    const ledger = db.prepare('SELECT * FROM master_drafts_ledger').all(); db.close();
    const failing = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (action === failedAction) throw new Error('合成迁移失败'); } }); assert.throws(() => failing.drafts.detail(draft.draftId)); failing.close();
    const inspected = new DatabaseSync(f.filePath); try { assert.equal(inspected.prepare('PRAGMA user_version').get()!.user_version, 10); assert.equal(inspected.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'recording_%' OR name LIKE 'execution_%'").get()!.n, 0); assert.deepEqual(inspected.prepare('SELECT * FROM master_drafts_ledger').all(), ledger); } finally { inspected.close(); }
    const retried = createCollectionRepository({ filePath: f.filePath }); try { assert.deepEqual(retried.drafts.detail(draft.draftId), before); assert.deepEqual(retried.recordingProfiles.list(), { profiles: [] }); assert.deepEqual(retried.execution.list(draft.draftId), { draftId: draft.draftId, assets: [], jobs: [] }); } finally { retried.close(); }
  }
});

test('schema 11 到 12 回滚保留既有 Profile 版本、Session 和幂等结果', async t => {
  const f = await fixture(t), create = request(), profile = f.store.save(create), draft = f.repository.drafts.append({ commandId: randomUUID(), fingerprint: 'b'.repeat(64), title: '参数迁移', programType: 'continuous', metadata: [{ title: '曲目' }] });
  const session = f.store.saveSession({ commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 0, profileVersionId: profile.id, overrides: {}, userConfirmed: true });
  f.repository.close(); const db = new DatabaseSync(f.filePath); db.exec('DROP TABLE execution_assets; DROP TABLE execution_jobs; DROP TABLE execution_ledger; PRAGMA user_version=11'); db.close();
  const failing = createCollectionRepository({ filePath: f.filePath, beforeCommit: action => { if (action === 'migrate-execution') throw new Error('合成执行迁移失败'); } }); assert.throws(() => failing.recordingProfiles.list()); failing.close();
  const inspected = new DatabaseSync(f.filePath); try { assert.equal(inspected.prepare('PRAGMA user_version').get()!.user_version, 11); assert.equal(inspected.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'execution_%'").get()!.n, 0); } finally { inspected.close(); }
  const retried = createCollectionRepository({ filePath: f.filePath }); try { assert.deepEqual(retried.recordingProfiles.save(create), profile); assert.deepEqual(retried.recordingProfiles.session(draft.draftId), { session }); } finally { retried.close(); }
});
