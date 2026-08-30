import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('print-write子进程：fresh Completed真实领取/完成并返回无base64有界身份回执', { timeout: 120_000 }, async t => {
  const fixtureApi = await import('./helpers/recording-capacity-fixture.js');
  const processApi = await import('./helpers/recording-capacity-process.js');
  const f = await fixtureApi.createCapacityObjectProbe(t);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-print-write-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seedDirectory = path.join(root, 'seed'); mkdirSync(seedDirectory);
  const seedPath = path.join(seedDirectory, 'seed.sqlite'); await backup(f.db, seedPath);
  const seedSha256 = fixtureApi.hashCapacityFile(seedPath);
  const clone = fixtureApi.createCapacityClone(root, 'sample-001', seedPath);

  const result = await processApi.runCapacityPrintWrite({ clone, planId: f.nextPlan.id, planHash: f.nextPlan.contentHash });
  assert.equal(result.outcome, 'ok'); assert.equal(result.closed, true); assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.equal(result.cleanup.termSent, false); assert.equal(result.cleanup.killSent, false);
  assert.equal(result.processGroup?.managed, true); assert.equal(result.processGroup.groupEmpty, true);
  assert.equal(result.result?.kind, 'print-write');
  const receipt = result.result!;
  assert.equal(Buffer.byteLength(JSON.stringify(receipt)) <= 16_384, true, 'IPC回执必须有界');
  assert.equal(/base64|data:image/u.test(JSON.stringify(receipt)), false, '回执不能携带PDF/JPEG正文');
  if (receipt.kind !== 'print-write') assert.fail('回执类型错误');
  assert.deepEqual(receipt.events, [
    { revision: 1, kind: 'create' },
    { revision: 2, kind: 'claim' },
    { revision: 3, kind: 'complete' },
  ]);
  assert.equal(receipt.job.id, receipt.jobId); assert.equal(receipt.job.requestId, receipt.requestId);
  assert.equal(receipt.lease.jobId, receipt.jobId); assert.equal(receipt.lease.requestId, receipt.requestId);
  assert.equal(receipt.lease.inputHash, receipt.inputHash); assert.equal(receipt.job.inputHash, receipt.inputHash);
  assert.equal(receipt.artifact.requestId, receipt.requestId); assert.equal(receipt.artifact.recordingId, receipt.recordingId);
  assert.equal(receipt.artifact.inputHash, receipt.inputHash); assert.equal(receipt.job.artifactId, receipt.artifact.id);
  assert.equal(receipt.completeReceipt.id, `lease:${receipt.lease.leaseId}`); assert.equal(receipt.completeReceipt.kind, 'complete');
  assert.equal(receipt.pdf.sha256, receipt.artifact.pdfSha256); assert.equal(receipt.pdf.size, receipt.artifact.size);
  assert.equal(receipt.preview.sha256, receipt.artifact.previewSha256); assert.equal(receipt.preview.size, receipt.artifact.previewSize);
  assert.equal(receipt.idempotent, true); assert.ok(receipt.claimMs >= 0); assert.ok(receipt.completeMs >= 0);
  assert.equal(fixtureApi.hashCapacityFile(seedPath), seedSha256, '原seed必须保持逐字节不变');

  const db = new DatabaseSync(clone.filePath, { readOnly: true, allowExtension: false });
  try {
    const events = db.prepare('SELECT revision,kind FROM recording_print_events WHERE job_id=? ORDER BY revision').all(receipt.jobId).map(row => ({ revision: Number(row.revision), kind: String(row.kind) }));
    assert.deepEqual(events, receipt.events);
    const complete = db.prepare("SELECT id,kind,request,result FROM recording_print_receipts WHERE id=? AND kind='complete'").get(receipt.completeReceipt.id)!;
    assert.equal(String(complete.request).includes('pdfBase64'), false); assert.equal(String(complete.request).includes('preview'), false);
    assert.deepEqual(JSON.parse(String(complete.result)), JSON.parse(String(db.prepare('SELECT data FROM recording_print_jobs WHERE id=?').get(receipt.jobId)!.data)));
    assert.equal(db.prepare("SELECT count(*) n FROM recording_print_receipts WHERE id=? AND kind='complete'").get(receipt.completeReceipt.id)!.n, 1);
  } finally { db.close(); }
  fixtureApi.finishCapacityClone(clone, { outcome: 'ok', resourcesClosed: true, samples: [receipt] });
});

test('print-write私有协议：只接受clone固定身份且拒绝未知字段', async t => {
  const fixtureApi = await import('./helpers/recording-capacity-fixture.js');
  const processApi = await import('./helpers/recording-capacity-process.js');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'musicbridge-print-write-shape-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, 'seed.sqlite');
  await import('node:fs/promises').then(fs => fs.writeFile(seed, 'shape-only'));
  const clone = fixtureApi.createCapacityClone(root, 'sample-shape', seed);
  const task = { kind: 'print-write' as const, clone, planId: randomUUID(), planHash: 'a'.repeat(64), databaseSha256: fixtureApi.hashCapacityFile(clone.filePath) };
  assert.equal(processApi.isCapacityChildTask(task), true);
  assert.equal(processApi.isCapacityChildTask({ ...task, invented: true }), false);
  assert.equal(processApi.isCapacityChildTask({ ...task, kind: 'print' }), false);
  assert.equal(readFileSync(seed, 'utf8'), 'shape-only');
});
