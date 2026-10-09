import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeMbm000LegacyEarlyProbe, MBM000_EARLY_PROBE_IDENTITY as identity } from '../mbm000-legacy-probe-normalization.mjs';
import { normalizeSealed012LegacyInput } from '../mbrs013-legacy-input-normalization.mjs';
import { assertCompatibilityLegacyInputs, COMPATIBILITY_LEGACY_INPUTS } from '../verify-mbrs014-compatibility.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => readFileSync(new URL('../../../' + file, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const historical = execFileSync('git', ['show', identity.parentSource + ':' + identity.path], { cwd: root });

test('000首页当前完整修复逆回原Git全部字节，旧012适配和原49清单逐字通过', () => {
  const current = read(identity.path);
  assert.equal(current.length, identity.after.bytes); assert.equal(sha(current), identity.after.sha256);
  assert.equal(historical.length, identity.before.bytes); assert.equal(sha(historical), identity.before.sha256);
  assert.deepEqual(normalizeMbm000LegacyEarlyProbe(identity.path, current), historical);
  assert.deepEqual(normalizeSealed012LegacyInput(identity.path, current), historical);
  const manifest = read(COMPATIBILITY_LEGACY_INPUTS.path);
  assert.equal(manifest.length, COMPATIBILITY_LEGACY_INPUTS.bytes); assert.equal(sha(manifest), COMPATIBILITY_LEGACY_INPUTS.sha256);
  assert.equal(assertCompatibilityLegacyInputs(manifest, read).length, 49);
});
test('000首页任一字节/名字/隔离与真实退出断言篡改均不能借时序逆变换通过', () => {
  const current = read(identity.path), text = current.toString('utf8');
  const corrupt = Buffer.from(current); corrupt[corrupt.length - 1] ^= 1;
  const mutations = [corrupt, Buffer.concat([current, Buffer.from('\n')]),
    Buffer.from(text.replace('v5 Home、设置 Footer、Settings、每日推荐和 Renderer isolation', '未批准首页')),
    Buffer.from(text.replace("closed: true, code: 0, signal: null", "closed: false, code: 0, signal: null")),
    Buffer.from(text.replace("process: 'undefined', require: 'undefined'", "process: 'object', require: 'undefined'"))];
  for (const proposed of mutations) {
    assert.notDeepEqual(proposed, current);
    assert.throws(() => normalizeMbm000LegacyEarlyProbe(identity.path, proposed), { code: 'MBM000_LEGACY_PROBE_INPUT_CHANGED' });
  }
});
test('000首页原完整版本继续准入，原版本损坏/无效参数仍拒绝', () => {
  assert.deepEqual(normalizeMbm000LegacyEarlyProbe(identity.path, historical), historical);
  const corrupted = Buffer.from(historical); corrupted[0] ^= 1;
  assert.throws(() => normalizeMbm000LegacyEarlyProbe(identity.path, corrupted), { code: 'MBM000_LEGACY_PROBE_INPUT_CHANGED' });
  assert.throws(() => normalizeMbm000LegacyEarlyProbe(null, historical), { code: 'MBM000_LEGACY_PROBE_INPUT_CHANGED' });
  assert.throws(() => normalizeMbm000LegacyEarlyProbe(identity.path, historical.toString()), { code: 'MBM000_LEGACY_PROBE_INPUT_CHANGED' });
});
test('000首页窄适配不准入其余48个旧输入的额外字节，也不改变原清单', () => {
  const manifest = read(COMPATIBILITY_LEGACY_INPUTS.path), rows = JSON.parse(manifest).files;
  assert.equal(rows.filter(row => row.path !== identity.path).length, 48);
  for (const row of rows.filter(row => row.path !== identity.path)) {
    const changed = Buffer.concat([read(row.path), Buffer.from('\n')]);
    assert.deepEqual(normalizeMbm000LegacyEarlyProbe(row.path, changed), changed);
    assert.throws(() => assertCompatibilityLegacyInputs(manifest, file => file === row.path ? changed : read(file)), { code: 'COMPATIBILITY_LEGACY_INPUT_CHANGED' });
  }
});
