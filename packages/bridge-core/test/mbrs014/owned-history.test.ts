import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { preparedPublicationFixture } from './prepared-fixture.js';

for (const omitted of ['owned', 'manifestHash', 'files'] as const) {
  test(`014 completed 输出历史：缺 ${omitted} 不能把已冻结原件保护投影变成完整空态`, async t => {
    const f = await preparedPublicationFixture(t); await f.prepared.freeze(f.freeze);
    const db = new DatabaseSync(f.filePath);
    try {
      const trigger = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='prepared_jobs_completed_no_update'").get()!.sql);
      db.exec('DROP TRIGGER prepared_jobs_completed_no_update');
      for (const table of ['preparation_jobs', 'prepared_jobs']) {
        for (const row of db.prepare(`SELECT id,data FROM ${table}`).all()) {
          const value = JSON.parse(String(row.data)); assert.equal(value.public.state, 'completed'); delete value[omitted];
          db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), String(row.id));
        }
      }
      db.exec(trigger);
      const before = ['preparation_jobs', 'prepared_jobs', 'prepared_versions', 'source_ledger'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const dataVersion = db.prepare('PRAGMA data_version').get()!.data_version;
      const projection = f.repository.sourceProtection.snapshot();
      assert.equal(projection.complete, false, '完整输出缺失必须 UNKNOWN，SOURCE_FILES OFF 不能替代持久保护');
      assert.ok(projection.issues.includes('FROZEN_LINEAGE_UNKNOWN'));
      assert.deepEqual(['preparation_jobs', 'prepared_jobs', 'prepared_versions', 'source_ledger'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
      assert.equal(db.prepare('PRAGMA data_version').get()!.data_version, dataVersion, '保护读取零原表写');
    } finally { db.close(); }
  });
}

test('014 running 输出历史：合法尚未生成 owned/files 的任务不误报损坏', async t => {
  const f = await preparedPublicationFixture(t), existing = f.repository.prepared.job(f.imported.id)!;
  const job = f.repository.prepared.start({ ...existing.request, commandId: randomUUID() }, existing.input);
  assert.equal(job.public.state, 'running'); assert.equal(job.owned, undefined); assert.deepEqual(job.files, []);
  const projection = f.repository.sourceProtection.snapshot();
  assert.equal(projection.issues.includes('FROZEN_LINEAGE_UNKNOWN'), false);
  assert.equal(projection.issues.includes('HISTORY_CORRUPT'), false);
});
