import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MBM001_LEGACY_PROBE_IDENTITY as identity, normalizeMbm001LegacyProbe } from '../mbm001-legacy-probe-normalization.mjs';
import { MBM000_EARLY_PROBE_IDENTITY, normalizeMbm000LegacyEarlyProbe } from '../mbm000-legacy-probe-normalization.mjs';
import { normalizeSealed012LegacyInput } from '../mbrs013-legacy-input-normalization.mjs';
import { assertCompatibilityLegacyInputs, COMPATIBILITY_LEGACY_INPUTS } from '../verify-mbrs014-compatibility.mjs';
import { readMobileFile } from '../verify-mbm000-contract-adoption.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const whole = async file => (await readMobileFile(path.join(repository, file), { maxBytes: 4 * 1024 * 1024 })).bytes;
const historical = (revision, file) => execFileSync('git', ['show', revision + ':' + file], { cwd: repository, maxBuffer: 4 * 1024 * 1024 });
const checkIdentity = (bytes, expected) => { assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256); };
const legacy012 = (file, bytes) => normalizeSealed012LegacyInput(file, normalizeMbm000LegacyEarlyProbe(file, normalizeMbm001LegacyProbe(file, bytes)));
async function frozenInputs() {
  const manifest = await whole(COMPATIBILITY_LEGACY_INPUTS.path);
  checkIdentity(manifest, COMPATIBILITY_LEGACY_INPUTS);
  const rows = JSON.parse(manifest).files, bytes = new Map();
  assert.equal(rows.length, 49);
  for (const row of rows) bytes.set(row.path, await whole(row.path));
  return { manifest, rows, bytes };
}

test('001旧探针两窗口逆回c6BASE完整Git字节，旧49链准入且实际Preload文件不变', async () => {
  const current = await whole(identity.path), original = historical(identity.baseReportSha, identity.path);
  checkIdentity(current, identity.after); checkIdentity(original, identity.before);
  const copy = Buffer.from(current), restored = normalizeMbm001LegacyProbe(identity.path, current);
  assert.deepEqual(restored, original); assert.deepEqual(current, copy);
  assert.equal(normalizeMbm001LegacyProbe(identity.path, original), original);
  assert.equal(Object.isFrozen(identity), true); assert.equal(Object.isFrozen(identity.windows), true);
  assert.equal(identity.windows.length, 2);
  const { manifest, bytes } = await frozenInputs();
  assert.equal(assertCompatibilityLegacyInputs(manifest, file => normalizeMbm001LegacyProbe(file, bytes.get(file))).length, 49);
  assert.deepEqual(await whole(identity.path), current);
});

test('001先于000和013适配，首页与三个旧输入精确回到封存012全文而不改执行源', async () => {
  const paths = [identity.path, MBM000_EARLY_PROBE_IDENTITY.path,
    'apps/desktop/test/mbrs009-local-library-ui.test.ts', 'apps/desktop/test/mbrs011-organizer-ui.test.ts'];
  const { manifest, rows, bytes } = await frozenInputs();
  for (const file of paths) {
    const current = bytes.get(file), copy = Buffer.from(current);
    const expected = historical('c5c36c2c3e327b5068b5ad15ca6c251c5aeb4478', file);
    assert.deepEqual(legacy012(file, current), expected); assert.deepEqual(current, copy);
    assert.deepEqual(await whole(file), current);
  }
  for (const row of rows.filter(row => row.path !== identity.path))
    assert.equal(normalizeMbm001LegacyProbe(row.path, bytes.get(row.path)), bytes.get(row.path));
  assert.equal(assertCompatibilityLegacyInputs(manifest, file => legacy012(file, bytes.get(file))).length, 49);
  const oldRevisions = ['b33357c09e6bded2b4c6c5acfcf7330e68366a5f', '09370f19d4422be3b387047999a0722961c52e1e', 'c5c36c2c3e327b5068b5ad15ca6c251c5aeb4478'];
  assert.equal(identity.earlierApprovedOriginals.length, oldRevisions.length);
  for (let index = 0; index < oldRevisions.length; index++) {
    const original = historical(oldRevisions[index], identity.path);
    checkIdentity(original, identity.earlierApprovedOriginals[index]);
    assert.equal(normalizeMbm001LegacyProbe(identity.path, original), original);
    assert.equal(assertCompatibilityLegacyInputs(manifest, file => normalizeMbm001LegacyProbe(file,
      file === identity.path ? original : bytes.get(file))).length, 49);
  }
});

test('001当前或历史任一未知字节、假装载器和原冻结断言篡改均拒绝完整逆变换', async () => {
  const current = await whole(identity.path), text = current.toString('utf8'), original = historical(identity.baseReportSha, identity.path);
  const corruptedCurrent = Buffer.from(current); corruptedCurrent[0] ^= 1;
  const corruptedOriginal = Buffer.from(original); corruptedOriginal[corruptedOriginal.length - 1] ^= 1;
  const changed = (before, after) => { assert.equal(text.split(before).length, 2); const bytes = Buffer.from(text.replace(before, after)); assert.notDeepEqual(bytes, current); return bytes; };
  const proposed = [corruptedCurrent, corruptedOriginal, current.subarray(0, current.length - 1), Buffer.concat([current, Buffer.from('\n')]),
    changed(identity.windows[0].after, identity.windows[0].after + identity.windows[0].after),
    changed(identity.windows[1].after, "    './mobile-connection-client.js': { createMobileConnectionClient: () => ({}) },\n"),
    changed("    'localRelocationPlan',\n", "    'localRelocationPlan',\n    'unapprovedRelocation',\n"),
    changed('assert.equal(Object.isFrozen(api), true)', 'assert.equal(true, true)')];
  for (const bytes of proposed) assert.throws(() => normalizeMbm001LegacyProbe(identity.path, bytes), { code: 'MBM001_LEGACY_PROBE_INPUT_CHANGED' });
  for (const revision of ['b33357c09e6bded2b4c6c5acfcf7330e68366a5f', '09370f19d4422be3b387047999a0722961c52e1e', 'c5c36c2c3e327b5068b5ad15ca6c251c5aeb4478']) {
    const original = historical(revision, identity.path), corrupted = Buffer.from(original); corrupted[0] ^= 1;
    for (const bytes of [corrupted, Buffer.concat([original, Buffer.from('\n')])])
      assert.throws(() => normalizeMbm001LegacyProbe(identity.path, bytes), { code: 'MBM001_LEGACY_PROBE_INPUT_CHANGED' });
  }
  for (const [file, bytes] of [[null, current], [identity.path, current.toString('utf8')], [identity.path, new Uint8Array(current)]])
    assert.throws(() => normalizeMbm001LegacyProbe(file, bytes), { code: 'MBM001_LEGACY_PROBE_INPUT_CHANGED' });
  assert.deepEqual(await whole(identity.path), current);
});

test('001窄适配不放行其余48输入或原49清单的任何额外字节，不产生跨路径豁免', async () => {
  const { manifest, rows, bytes } = await frozenInputs();
  const others = rows.filter(row => row.path !== identity.path); assert.equal(others.length, 48);
  for (const row of others) {
    const current = bytes.get(row.path), proposed = Buffer.concat([current, Buffer.from('\n')]);
    assert.equal(normalizeMbm001LegacyProbe(row.path, proposed), proposed);
    assert.throws(() => assertCompatibilityLegacyInputs(manifest, file => normalizeMbm001LegacyProbe(file,
      file === row.path ? proposed : bytes.get(file))), { code: 'COMPATIBILITY_LEGACY_INPUT_CHANGED' });
  }
  assert.throws(() => assertCompatibilityLegacyInputs(Buffer.concat([manifest, Buffer.from('\n')]),
    file => normalizeMbm001LegacyProbe(file, bytes.get(file))), { code: 'COMPATIBILITY_LEGACY_MANIFEST_CHANGED' });
  const alias = 'apps/desktop/test/other-preload.test.ts', proposed = Buffer.concat([bytes.get(identity.path), Buffer.from('\n')]);
  assert.equal(normalizeMbm001LegacyProbe(alias, proposed), proposed);
  assert.deepEqual(await whole(COMPATIBILITY_LEGACY_INPUTS.path), manifest);
});
