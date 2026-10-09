import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMobileFile } from '../verify-mbm000-contract-adoption.mjs';
import { MBM001_LEGACY_REUSE, normalizeMbm001LegacyReuse } from '../mbm001-legacy-reuse-normalization.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = 'c6c4745dfc7fe4242b8a2682798e00605649b12e';
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const original = file => execFileSync('git', ['show', base + ':' + file], { cwd: repository, maxBuffer: 4 * 1024 * 1024 });
const error = value => value?.code === 'MBM001_LEGACY_REUSE_INPUT_CHANGED';

test('001旧Owner守卫：三个完整当前文件只读逆回原锁字节，旧锁和原输入保持', async () => {
  const lockPath = 'docs/postrust/MBM-000/INPUT_LOCK.json';
  const lockBytes = (await readMobileFile(path.join(repository, lockPath), { maxBytes: 4 * 1024 * 1024 })).bytes;
  assert.deepEqual(lockBytes, original(lockPath));
  const lock = JSON.parse(lockBytes);
  assert.equal(MBM001_LEGACY_REUSE.length, 3);
  for (const row of MBM001_LEGACY_REUSE) {
    const before = original(row.path), actual = (await readMobileFile(path.join(repository, row.path), { maxBytes: 4 * 1024 * 1024 })).bytes;
    assert.deepEqual(identity(before), row.before); assert.deepEqual(identity(actual), row.after);
    const pinned = lock.macReusePoints.find(value => value.path === row.path); assert.ok(pinned);
    assert.deepEqual(row.before, { bytes: pinned.bytes, sha256: pinned.sha256 });
    assert.equal(normalizeMbm001LegacyReuse(row.path, before), before);
    assert.deepEqual(normalizeMbm001LegacyReuse(row.path, actual), before);
    assert.deepEqual((await readMobileFile(path.join(repository, row.path), { maxBytes: 4 * 1024 * 1024 })).bytes, actual);
  }
});
test('001旧Owner守卫：任意额外字节、截断和替换均拒绝，不能扩大到未知改动', async () => {
  for (const row of MBM001_LEGACY_REUSE) {
    const actual = (await readMobileFile(path.join(repository, row.path), { maxBytes: 4 * 1024 * 1024 })).bytes;
    const changed = Buffer.from(actual); changed[0] ^= 1;
    for (const bytes of [changed, actual.subarray(0, actual.length - 1), Buffer.concat([actual, Buffer.from('\n')])])
      assert.throws(() => normalizeMbm001LegacyReuse(row.path, bytes), error);
  }
});
test('001旧Owner守卫：非Buffer拒绝；其它文件原样交旧锁断言，不生成豁免', () => {
  assert.throws(() => normalizeMbm001LegacyReuse(MBM001_LEGACY_REUSE[0].path, 'text'), error);
  assert.throws(() => normalizeMbm001LegacyReuse(null, Buffer.from('text')), error);
  const bytes = Buffer.from('其它文件不属于001增量');
  assert.equal(normalizeMbm001LegacyReuse('packages/bridge-core/src/collection/other.ts', bytes), bytes);
  assert.notDeepEqual(identity(bytes), MBM001_LEGACY_REUSE[0].before);
});
