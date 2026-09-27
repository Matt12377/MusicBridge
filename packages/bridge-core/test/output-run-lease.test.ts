import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PinnedDeviceOutputHelper } from '../src/recording/bundled-device-output-helper.js';
import { createOutputRunLease, revokeOutputRunLease, type OutputRunLeaseBinding } from '../src/recording/output-run-lease.js';

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const binary = process.env.MB_NATIVE_OUTPUT_HELPER_TEST_BINARY;

/** 只以显式提供的受控编译件调用 `--lease-revoke`；本测试绝不调用无参HAL入口。 */
test('Core→Native租约撤销只接受精确DB/Sidecar身份并留下不可逆墓碑', { skip: !binary }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-core-native-lease-'));
  const databaseFile = path.join(directory, 'collection.v1.sqlite');
  await writeFile(databaseFile, Buffer.from('合成数据库身份，不含用户数据'));
  const manifestPath = path.join(directory, 'manifest.json'), manifest = Buffer.from('{}');
  await writeFile(manifestPath, manifest); await chmod(manifestPath, 0o600);
  const helperBytes = await readFile(binary!);
  const pin: PinnedDeviceOutputHelper = { path: binary!, sha256: digest(helperBytes), manifestPath,
    manifestSha256: digest(manifest), sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
  const binding: OutputRunLeaseBinding = { databaseFile, datasetId: randomUUID(), attemptId: randomUUID(),
    side: 'A', runId: randomUUID(), planContentSha256: 'b'.repeat(64), audioSha256: 'c'.repeat(64),
    pcmSha256: 'd'.repeat(64), gateRecordSha256: 'e'.repeat(64), pin };
  const lease = await createOutputRunLease(binding);
  await lease.close();
  const active = await readFile(lease.path);
  assert.equal(active.length, 288); assert.equal(active[6], 1);
  assert.equal(await revokeOutputRunLease({ ...binding, datasetId: randomUUID() }), false,
    'sidecar自报的dataset不能代替可信工作库身份');
  assert.equal((await readFile(lease.path))[6], 1);
  assert.equal(await revokeOutputRunLease(binding), true, '真实原生撤销命令必须持排他锁落盘并fsync');
  assert.equal((await readFile(lease.path))[6], 2);
  assert.equal(await revokeOutputRunLease(binding), true, '原身份再次恢复只能看到同一墓碑');
  await assert.rejects(createOutputRunLease(binding), '同一run sidecar不得被覆盖');

  const movedDatabase = `${databaseFile}.previous`;
  await rename(databaseFile, movedDatabase);
  await writeFile(databaseFile, Buffer.from('复制路径下的新合成数据库'));
  assert.equal(await revokeOutputRunLease(binding), false, '相同路径的新DB inode不能继承旧静止证明');
  await rename(databaseFile, `${databaseFile}.replacement`);
  await rename(movedDatabase, databaseFile);

  const movedLease = `${lease.path}.previous`;
  await rename(lease.path, movedLease);
  await writeFile(lease.path, await readFile(movedLease));
  assert.equal(await revokeOutputRunLease(binding), false, '相同内容的新Sidecar inode不能继承旧静止证明');
});
