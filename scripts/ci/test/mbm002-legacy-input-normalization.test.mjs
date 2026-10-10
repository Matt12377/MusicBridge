import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMobileFile } from '../verify-mbm000-contract-adoption.mjs';
import { MBM001_LEGACY_REUSE, normalizeMbm001LegacyReuse } from '../mbm001-legacy-reuse-normalization.mjs';
import { MBM002_LEGACY_INPUT_BASE, MBM002_LEGACY_INPUTS, normalizeMbm002LegacyInputs } from '../mbm002-legacy-input-normalization.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const maxBytes = 4 * 1024 * 1024;
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const changed = error => error?.code === 'MBM002_LEGACY_INPUT_CHANGED';
// 与既有001守卫相同：实际执行者只读读取已提交BASE002，不能用当前产品或本模块伪造原字节。
const original = file => execFileSync('git', ['show', MBM002_LEGACY_INPUT_BASE + ':' + file], {
  cwd: repository, timeout: 10_000, maxBuffer: maxBytes,
});
const current = async file => (await readMobileFile(path.join(repository, file), { maxBytes })).bytes;
const compose = (file, bytes) => normalizeMbm001LegacyReuse(file, normalizeMbm002LegacyInputs(file, bytes));
const ledger = { tasks: 18, acceptanceCases: 156, effectiveTasks: 17, effectiveAcceptanceCases: 150, cancelled015SixCases: 'N_A' };

// 保留历史“三份”用例名；当前覆盖三份原适配和一份目录资格补片，共四份。
test('002旧输入守卫：三份整文件精确逆回BASE002，原字节与工作树均不变', async () => {
  assert.equal(MBM002_LEGACY_INPUT_BASE, '8044d935e242d8647adc21445116fb49c9100e4a');
  assert.equal(MBM002_LEGACY_INPUTS.length, 4);
  assert.equal(new Set(MBM002_LEGACY_INPUTS.map(row => row.path)).size, 4);
  for (const row of MBM002_LEGACY_INPUTS) {
    const before = original(row.path), after = await current(row.path), preserved = Buffer.from(after);
    assert.deepEqual(identity(before), row.before); assert.deepEqual(identity(after), row.after);
    assert.equal(normalizeMbm002LegacyInputs(row.path, before), before);
    const restored = normalizeMbm002LegacyInputs(row.path, after);
    assert.notEqual(restored, after); assert.deepEqual(restored, before);
    assert.deepEqual(after, preserved); assert.deepEqual(await current(row.path), preserved);
    restored[0] ^= 1; assert.deepEqual(after, preserved);
  }
});

test('002旧输入守卫：前后身份以外的任何额外字节、截断及片段内外漂移均拒绝', async () => {
  for (const row of MBM002_LEGACY_INPUTS) {
    const before = original(row.path), after = await current(row.path);
    for (const source of [before, after]) {
      const snapshot = Buffer.from(source);
      const positions = new Set([0, Math.floor(source.length / 2), source.length - 1,
        ...row.hunks.map(hunk => Math.min(hunk.offset, source.length - 1))]);
      for (const position of positions) {
        const mutation = Buffer.from(source); mutation[position] ^= 1;
        assert.throws(() => normalizeMbm002LegacyInputs(row.path, mutation), changed);
      }
      for (const mutation of [source.subarray(0, source.length - 1), Buffer.concat([source, Buffer.from('\n')]),
        Buffer.concat([Buffer.from(' '), source]), Buffer.alloc(0)]) {
        assert.throws(() => normalizeMbm002LegacyInputs(row.path, mutation), changed);
      }
      assert.deepEqual(source, snapshot);
    }
  }
});

test('002旧输入守卫：只有002再001的正确顺序恢复共享Owner域原000完整身份', async () => {
  const file = 'packages/bridge-core/src/collection/dataset-domain.ts';
  const row = MBM002_LEGACY_INPUTS.find(value => value.path === file);
  const first = MBM001_LEGACY_REUSE.find(value => value.path === file);
  assert.ok(row); assert.ok(first); assert.deepEqual(row.before, first.after);
  const lock = JSON.parse(await current('docs/postrust/MBM-000/INPUT_LOCK.json'));
  const pinned = lock.macReusePoints.find(value => value.path === file); assert.ok(pinned);
  const after = await current(file);
  assert.throws(() => normalizeMbm001LegacyReuse(file, after), error => error?.code === 'MBM001_LEGACY_REUSE_INPUT_CHANGED');
  const atBase002 = normalizeMbm002LegacyInputs(file, after); assert.deepEqual(atBase002, original(file));
  const atBase000 = normalizeMbm001LegacyReuse(file, atBase002);
  assert.deepEqual(identity(atBase000), { bytes: pinned.bytes, sha256: pinned.sha256 });
  assert.deepEqual(identity(atBase000), first.before); assert.deepEqual(await current(file), after);
});

test('002旧输入守卫：全部22复用点仍受旧000锁认证，旧18/156和有效17/150不变', async () => {
  const lockFile = 'docs/postrust/MBM-000/INPUT_LOCK.json', lockBytes = await current(lockFile);
  assert.deepEqual(lockBytes, original(lockFile));
  const lock = JSON.parse(lockBytes); assert.deepEqual(lock.originalTaskLedger, ledger);
  assert.equal(lock.macReusePointCount, 22); assert.equal(lock.macReusePoints.length, 22);
  const expectedChanged = [...new Set([...MBM001_LEGACY_REUSE, ...MBM002_LEGACY_INPUTS].map(row => row.path))].sort();
  const actualChanged = [];
  for (const pinned of lock.macReusePoints) {
    const bytes = await current(pinned.path), saved = Buffer.from(bytes);
    const expected = { bytes: pinned.bytes, sha256: pinned.sha256 };
    if (identity(bytes).bytes !== expected.bytes || identity(bytes).sha256 !== expected.sha256) actualChanged.push(pinned.path);
    assert.deepEqual(identity(compose(pinned.path, bytes)), expected);
    assert.deepEqual(bytes, saved); assert.deepEqual(await current(pinned.path), saved);
  }
  assert.deepEqual(actualChanged.sort(), expectedChanged);
  const execution = JSON.parse(await current('docs/postrust/MBM-002/EXECUTION_SCOPE.json'));
  assert.equal(execution.baseSha, MBM002_LEGACY_INPUT_BASE);
  assert.deepEqual([execution.preserve.legacyTasks, execution.preserve.legacyAcceptanceCases,
    execution.preserve.effectiveTasks, execution.preserve.effectiveAcceptanceCases], [18, 156, 17, 150]);
  assert.deepEqual(await current(lockFile), lockBytes);
});

test('002旧输入守卫：类型或同名伪路径不授豁免，未知文件仍由完整旧锁拒绝漂移', async () => {
  const file = 'packages/bridge-core/src/stream/local-file-http.ts', bytes = await current(file);
  assert.equal(normalizeMbm002LegacyInputs(file, bytes), bytes);
  const lock = JSON.parse(await current('docs/postrust/MBM-000/INPUT_LOCK.json'));
  const pinned = lock.macReusePoints.find(value => value.path === file); assert.ok(pinned);
  const mutation = Buffer.from(bytes); mutation[0] ^= 1;
  assert.equal(normalizeMbm002LegacyInputs(file, mutation), mutation);
  assert.notDeepEqual(identity(compose(file, mutation)), { bytes: pinned.bytes, sha256: pinned.sha256 });
  const target = MBM002_LEGACY_INPUTS[0], after = await current(target.path);
  assert.throws(() => normalizeMbm002LegacyInputs(target.path, new Uint8Array(after)), changed);
  assert.throws(() => normalizeMbm002LegacyInputs(target.path, after.toString()), changed);
  assert.throws(() => normalizeMbm002LegacyInputs(null, after), changed);
  assert.equal(normalizeMbm002LegacyInputs('./' + target.path, after), after);
  assert.deepEqual(identity(after), target.after);
});

test('002旧输入守卫：公开完整身份和片段表不可被调用者改写或增添豁免', () => {
  assert.equal(Object.isFrozen(MBM002_LEGACY_INPUTS), true);
  assert.throws(() => MBM002_LEGACY_INPUTS.push({}), TypeError);
  for (const row of MBM002_LEGACY_INPUTS) {
    assert.equal(Object.isFrozen(row), true); assert.equal(Object.isFrozen(row.before), true);
    assert.equal(Object.isFrozen(row.after), true); assert.equal(Object.isFrozen(row.hunks), true);
    assert.throws(() => { row.before.sha256 = '0'.repeat(64); }, TypeError);
    assert.throws(() => { row.after.bytes += 1; }, TypeError);
    for (const hunk of row.hunks) {
      assert.equal(Object.isFrozen(hunk), true);
      assert.throws(() => { hunk.offset += 1; }, TypeError);
    }
  }
});
