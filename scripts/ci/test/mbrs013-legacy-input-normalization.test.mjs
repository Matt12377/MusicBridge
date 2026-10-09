import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeSealed012LegacyInput } from '../mbrs013-legacy-input-normalization.mjs';
import { normalizeMbm001LegacyProbe } from '../mbm001-legacy-probe-normalization.mjs';
import {
  assertCompatibilityLegacyInputs, COMPATIBILITY_LEGACY_INPUTS,
  COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION, COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION,
  COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION, COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION,
} from '../verify-mbrs014-compatibility.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => normalizeMbm001LegacyProbe(file, readFileSync(new URL('../../../' + file, import.meta.url)));
const manifest = read(COMPATIBILITY_LEGACY_INPUTS.path);
const rows = JSON.parse(manifest).files;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = [COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION,
  COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION, COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION];
const previous = input => execFileSync('git', ['show',
  'c5c36c2c3e327b5068b5ad15ca6c251c5aeb4478:' + input.path], { cwd: repository });

test('013三个真实原始输入经精确逆变换与已封存012 Git blob逐字一致', () => {
  assert.equal(assertCompatibilityLegacyInputs(manifest, read).length, 49);
  for (const input of inputs) {
    const actual = read(input.path);
    assert.equal(actual.length, input.bytes); assert.equal(sha(actual), input.sha256);
    const restored = normalizeSealed012LegacyInput(input.path, actual);
    assert.deepEqual(restored, previous(input));
    const identity = input.path === COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION.path
      ? COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION : rows.find(row => row.path === input.path);
    assert.equal(restored.length, identity.bytes); assert.equal(sha(restored), identity.sha256);
  }
});

test('原012版本继续逐字准入，原49清单及其余46实际输入不变', () => {
  for (const input of inputs) {
    const before = previous(input);
    assert.deepEqual(normalizeSealed012LegacyInput(input.path, before), before);
  }
  assert.equal(manifest.length, COMPATIBILITY_LEGACY_INPUTS.bytes);
  assert.equal(sha(manifest), COMPATIBILITY_LEGACY_INPUTS.sha256);
  for (const row of rows.filter(row => !inputs.some(input => input.path === row.path))) {
    const bytes = normalizeSealed012LegacyInput(row.path, read(row.path));
    assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
  }
});

test('当前三个输入任一原字节损坏或额外字节均拒绝逆变换', () => {
  for (const input of inputs) {
    const bytes = read(input.path), corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 1] ^= 1;
    for (const proposed of [corrupted, Buffer.concat([bytes, Buffer.from('\n')])])
      assert.throws(() => normalizeSealed012LegacyInput(input.path, proposed),
        { code: 'SEALED012_LEGACY_INPUT_CHANGED' });
  }
});

test('封存012任一字节损坏不会借适配放行', () => {
  for (const input of inputs) {
    const before = previous(input), corrupted = Buffer.from(before);
    corrupted[0] ^= 1;
    assert.throws(() => normalizeSealed012LegacyInput(input.path, corrupted),
      { code: 'SEALED012_LEGACY_INPUT_CHANGED' });
  }
});

test('额外方法、假namespace与原断言篡改拒绝，不能仅删匹配行掩盖', () => {
  const changes = [
    [inputs[0], "    'localRelocationPlan',", "    'localRelocationPlan',\n    'unapprovedRelocation',"],
    [inputs[1], 'return localRelocation', 'return { useLocalRelocationPlans: () => ({}) }'],
    [inputs[2], 'return relocationComposables', 'return { useLocalRelocationPlans: () => ({}) }'],
  ];
  for (const [input, before, after] of changes) {
    const text = read(input.path).toString('utf8'); assert.ok(text.includes(before));
    assert.throws(() => normalizeSealed012LegacyInput(input.path, Buffer.from(text.replace(before, after))),
      { code: 'SEALED012_LEGACY_INPUT_CHANGED' });
  }
  const originalText = read(inputs[0].path).toString('utf8');
  const weakened = originalText.replace('assert.equal(Object.isFrozen(api), true)', 'assert.equal(true, true)');
  assert.notEqual(weakened, originalText);
  assert.throws(() => normalizeSealed012LegacyInput(inputs[0].path, Buffer.from(weakened)),
    { code: 'SEALED012_LEGACY_INPUT_CHANGED' });
});

test('适配不改其他路径，原冻结守卫仍拒绝其他输入篡改及无效调用', () => {
  const other = rows.find(row => !inputs.some(input => input.path === row.path));
  const changed = Buffer.concat([read(other.path), Buffer.from('\n')]);
  assert.deepEqual(normalizeSealed012LegacyInput(other.path, changed), changed);
  assert.throws(() => assertCompatibilityLegacyInputs(manifest,
    file => normalizeSealed012LegacyInput(file, file === other.path ? changed : read(file))),
  { code: 'COMPATIBILITY_LEGACY_INPUT_CHANGED' });
  assert.throws(() => normalizeSealed012LegacyInput(null, changed), { code: 'SEALED012_LEGACY_INPUT_CHANGED' });
  assert.throws(() => normalizeSealed012LegacyInput(inputs[0].path, changed.toString()),
    { code: 'SEALED012_LEGACY_INPUT_CHANGED' });
});

