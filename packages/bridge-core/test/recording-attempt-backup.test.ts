import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { recordingAttemptFixture as fixture } from './helpers/recording-attempt-fixture.js';
import { createCollectionRepository } from '../src/collection/repository.js';
import { verifyRecordingAttemptDatabase } from '../src/recording/attempt-integrity.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../src/recording/restore-database.js';
import { readBackupIndex } from '../src/recording/backup-index.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { restoreArchiveBackup, verifyRestoredArchive } from '../src/recording/restore-package.js';

test('完整备份含真实执行音频和Attempt链，隔离恢复只追加一次Interrupted且原备份不变', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const result = await f.api.createArchiveBackup(f.backupRequest);
  const original = await f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal);
  for (const audio of f.frozenPlan.execution.audio) assert.ok(result.manifest.objects.some(object => object.sha256 === audio.audio.sha256));
  const target = path.join(f.directory, 'Attempt隔离恢复'); await mkdir(target);
  const recovered = await restoreArchiveBackup({ backup: result.directory, destination: { ...await authorizeSourceDirectory(target), id: randomUUID() }, protectedRoots: [...f.repository.sources.roots(), ...f.repository.preparations.destinations(), f.root.root], id: randomUUID(), userConfirmed: true, signal: f.backupRequest.signal });
  assert.equal((await verifyRestoredArchive(recovered.directory, f.backupRequest.signal)).contentIncluded, true);
  const restoredPath = path.join(recovered.directory.path, 'database', 'collection.sqlite');
  verifyRestoredDatabaseIsolation(restoredPath); readBackupIndex(restoredPath);
  const repository = createCollectionRepository({ filePath: restoredPath });
  const interrupted = repository.recordingAttempts.get({ attemptId: a.id }).attempt!;
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.reason, 'app-restarted'); assert.equal(interrupted.revision, a.revision + 1);
  assert.deepEqual(repository.recordingPlans.version({ id: a.planVersionId }).plan, f.frozenPlan); repository.close();
  const second = createCollectionRepository({ filePath: restoredPath }); t.after(() => second.close());
  assert.deepEqual(second.recordingAttempts.get({ attemptId: a.id }).attempt, interrupted);
  assert.deepEqual(await f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal), original);
  assert.equal(f.attempts.get({ attemptId: a.id }).attempt!.status, 'in-progress'); assert.equal(f.starts.length, 1);
});

test('篡改事件即使恢复不可变trigger仍拒绝备份/恢复，失败不改写原证据', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const damagedPath = path.join(f.directory, '损坏副本.sqlite'), source = new DatabaseSync(f.filePath);
  await backup(source, damagedPath); source.close();
  const db = new DatabaseSync(damagedPath);
  const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_events_no_update'").get()!.sql);
  db.exec('DROP TRIGGER recording_attempt_events_no_update');
  db.prepare("UPDATE recording_attempt_events SET data=json_set(data,'$.event.type','unknown-event') WHERE attempt_id=?").run(a.id);
  db.exec(trigger); assert.throws(() => verifyRecordingAttemptDatabase(db)); db.close();
  const before = await readFile(damagedPath); assert.throws(() => readBackupIndex(damagedPath)); assert.throws(() => isolateRestoredDatabase(damagedPath));
  assert.equal(createHash('sha256').update(await readFile(damagedPath)).digest('hex'), createHash('sha256').update(before).digest('hex'));
  assert.equal(f.attempts.get({ attemptId: a.id }).attempt!.status, 'in-progress');
});

test('终态Attempt关联实体篡改为空白或已擦除，即使恢复trigger也不能备份或恢复', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_copy_no_blank'").get()!.sql);
  const contentTrigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_record_content_copy_guard'").get()!.sql);
  for (const usage of ['blank', 'erased']) {
    db.exec('DROP TRIGGER recording_attempt_copy_no_blank; DROP TRIGGER recording_record_content_copy_guard;');
    db.prepare('UPDATE physical_copies SET usage=?,reserved_from=NULL WHERE physical_id=?').run(usage, a.physicalId); db.exec(trigger); db.exec(contentTrigger);
    assert.throws(() => verifyRecordingAttemptDatabase(db)); assert.throws(() => readBackupIndex(f.filePath));
  }
});
