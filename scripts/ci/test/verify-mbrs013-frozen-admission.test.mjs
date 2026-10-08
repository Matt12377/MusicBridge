import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCompatibilityLegacyInputs, COMPATIBILITY_LEGACY_INPUTS,
  COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION, COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION, COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION,
  COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION,
} from '../verify-mbrs014-compatibility.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = file => readFileSync(path.join(root, file));
const manifest = read(COMPATIBILITY_LEGACY_INPUTS.path);
const name = COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION.path;
const current = read(name);
const check = proposed => assertCompatibilityLegacyInputs(manifest, file => file === name ? proposed : read(file));

test('013冻结旧49输入仅准单个localRelocationPlan名单增量，原012版本继续准入', () => {
  assert.equal(check(current).length, 49);
  const line = "    'localRelocationPlan',\n";
  assert.equal(current.toString('utf8').split(line).length, 2);
  const previous = Buffer.from(current.toString('utf8').replace(line, ''));
  assert.equal(previous.length, COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION.bytes);
  assert.equal(check(previous).length, 49);
});
test('013名单之外新增方法、旧断言或loader字节变更仍拒绝', () => {
  for (const [before, after] of [
    ["    'localRelocationPlan',", "    'localRelocationPlan',\n    'unapprovedRelocation',"],
    ['assert.equal(Object.isFrozen(api), true)', 'assert.equal(true, true)'],
    ['require: (name: string)', 'require: (name: unknown)'],
  ]) {
    assert.ok(current.toString('utf8').includes(before));
    const changed = Buffer.from(current.toString('utf8').replace(before, after));
    assert.throws(() => check(changed), { code: 'COMPATIBILITY_LEGACY_INPUT_CHANGED' });
  }
});
test('013不扩大014原清单或其余46个输入准入', () => {
  assert.throws(() => assertCompatibilityLegacyInputs(Buffer.concat([manifest, Buffer.from('\n')]), read),
    { code: 'COMPATIBILITY_LEGACY_MANIFEST_CHANGED' });
  const other = JSON.parse(manifest).files.find(input => input.path !== name && input.path !== COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION.path && input.path !== COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION.path).path;
  assert.throws(() => assertCompatibilityLegacyInputs(manifest, file => file === other
    ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file)), { code: 'COMPATIBILITY_LEGACY_INPUT_CHANGED' });
});

test('013原009装载器只加真实ESM导入和映射两行，精确逆回原冻结输入', () => {
  const uiName = COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION.path, bytes = read(uiName);
  const imported = "import * as localRelocation from '../src/renderer/src/composables/application/useLocalRelocationPlans.js'\n";
  const mapped = "      if (name.endsWith('/useLocalRelocationPlans.js')) return localRelocation\n";
  const text = bytes.toString('utf8');
  assert.equal(text.split(imported).length, 2); assert.equal(text.split(mapped).length, 2);
  const previous = Buffer.from(text.replace(imported, '').replace(mapped, ''));
  const original = JSON.parse(manifest).files.find(input => input.path === uiName);
  assert.equal(previous.length, original.bytes);
  assert.equal(createHash('sha256').update(previous).digest('hex'), original.sha256);
  assert.equal(assertCompatibilityLegacyInputs(manifest, file => file === uiName ? previous : read(file)).length, 49);
});
test('013原009装载补充不接受假namespace或修改原UI断言', () => {
  const uiName = COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION.path, text = read(uiName).toString('utf8');
  for (const [before, after] of [
    ['return localRelocation', 'return { useLocalRelocationPlans: () => ({}) }'],
    ['assert.deepEqual(template.errors, [])', 'assert.equal(true, true)'],
  ]) {
    assert.ok(text.includes(before));
    const proposed = Buffer.from(text.replace(before, after));
    assert.throws(() => assertCompatibilityLegacyInputs(manifest, file => file === uiName ? proposed : read(file)),
      { code: 'COMPATIBILITY_LEGACY_INPUT_CHANGED' });
  }
});

test('013原011装载器只加真实ESM导入和映射两行，精确逆回原冻结输入', () => {
  const uiName = COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION.path, bytes = read(uiName);
  const imported = "import * as relocationComposables from '../src/renderer/src/composables/application/useLocalRelocationPlans.js'\n";
  const mapped = "      if (name.endsWith('/useLocalRelocationPlans.js')) return relocationComposables\n";
  const text = bytes.toString('utf8');
  assert.equal(text.split(imported).length, 2); assert.equal(text.split(mapped).length, 2);
  const previous = Buffer.from(text.replace(imported, '').replace(mapped, ''));
  const original = JSON.parse(manifest).files.find(input => input.path === uiName);
  assert.equal(previous.length, original.bytes);
  assert.equal(createHash('sha256').update(previous).digest('hex'), original.sha256);
  assert.equal(assertCompatibilityLegacyInputs(manifest, file => file === uiName ? previous : read(file)).length, 49);
});
test('013真实ESM装载补充不接受假namespace或修改原UI断言', () => {
  const uiName = COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION.path, text = read(uiName).toString('utf8');
  for (const [before, after] of [
    ["return relocationComposables", "return { useLocalRelocationPlans: () => ({}) }"],
    ["assert.deepEqual(template.errors, [])", "assert.equal(true, true)"],
  ]) {
    assert.ok(text.includes(before));
    const proposed = Buffer.from(text.replace(before, after));
    assert.throws(() => assertCompatibilityLegacyInputs(manifest, file => file === uiName ? proposed : read(file)),
      { code: 'COMPATIBILITY_LEGACY_INPUT_CHANGED' });
  }
});
