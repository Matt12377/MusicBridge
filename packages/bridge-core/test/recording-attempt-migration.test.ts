import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';

function facts(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'recording_attempt*' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-task074-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'collection.sqlite'), db = new DatabaseSync(filePath);
  db.exec(await readFile(new URL('fixtures/collection-schema18.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18);
  const before = facts(db); db.close();
  return { filePath, before };
}

test('真实schema18旧事实迁移到19逐列不变，新Attempt表为空且外键有效', async t => {
  const f = await fixture(t), repository = createCollectionRepository({ filePath: f.filePath });
  t.after(() => repository.close()); repository.list({ offset: 0, limit: 1 });
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 19);
  assert.deepEqual(facts(db), f.before);
  for (const table of ['recording_attempts', 'recording_attempt_events', 'recording_attempt_receipts']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('schema19提交前故障整体回滚到18，重试不能丢失旧历史', async t => {
  const f = await fixture(t), failed = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (action === 'migrate-recording-attempts') throw new Error('合成迁移提交故障'); } });
  t.after(() => failed.close());
  assert.throws(() => failed.list({ offset: 0, limit: 1 })); failed.close();
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18);
  assert.deepEqual(facts(db), f.before);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name GLOB 'recording_attempt*'").get()!.n, 0); db.close();
  const retried = createCollectionRepository({ filePath: f.filePath }); t.after(() => retried.close());
  retried.list({ offset: 0, limit: 1 });
  const after = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => after.close());
  assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 19); assert.deepEqual(facts(after), f.before);
});
