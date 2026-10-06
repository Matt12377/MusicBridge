import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertAudioScope, AUDIO_REGRESSION_TESTS } from '../verify-mbrs008-audio.mjs';

function candidate() {
  const scope = JSON.parse(readFileSync(new URL('../mbrs008-audio-scope.json', import.meta.url), 'utf8'));
  scope.implementationComplete = true;
  scope.countsConfirmed = true;
  const files = ['packages/contracts/test/mbrs008/audio-quality.test.ts', 'packages/bridge-core/test/mbrs008/file-parameters.test.ts', 'apps/desktop/test/mbrs008-audio-quality.test.ts'];
  for (const group of scope.groups) {
    group.expectedTests = 1;
    group.tests = group.tests.filter(file => AUDIO_REGRESSION_TESTS.includes(group.directory + '/' + file));
    group.tests.push(files.find(file => file.startsWith(group.directory + '/')).slice(group.directory.length + 1));
  }
  return { scope, files };
}

test('008有限Gate接受完整匹配清单，不把数量声明当实际TAP', () => {
  const { scope, files } = candidate();
  assert.equal(assertAudioScope(scope, files).length, 3);
});

for (const [name, mutate, code] of [
  ['未完成实现', (s) => { s.implementationComplete = false; }, 'AUDIO_SCOPE_NOT_FROZEN'],
  ['未实际确认数量', (s) => { s.countsConfirmed = false; }, 'AUDIO_SCOPE_NOT_FROZEN'],
  ['别的基线', (s) => { s.baseSha = 'b'.repeat(40); }, 'AUDIO_SCOPE_NOT_FROZEN'],
  ['零数量', (s) => { s.groups[0].expectedTests = 0; }, 'AUDIO_GROUP_INVALID'],
  ['重复组名', (s) => { s.groups[1].name = s.groups[0].name; }, 'AUDIO_GROUP_INVALID'],
  ['未授权目录', (s) => { s.groups[0].directory = 'other'; }, 'AUDIO_GROUP_INVALID'],
  ['路径穿越', (s) => { s.groups[0].tests.push('../audio-quality.test.ts'); }, 'AUDIO_TEST_PATH_INVALID'],
  ['悄悄删除旧回归', (s) => { s.groups[0].tests.shift(); }, 'AUDIO_REQUIRED_REGRESSION_MISSING'],
  ['重复测试', (s) => { s.groups[0].tests.push(s.groups[0].tests[0]); }, 'AUDIO_TEST_INVENTORY_MISMATCH'],
]) {
  test('008有限Gate拒绝' + name, () => {
    const { scope, files } = candidate(); mutate(scope);
    assert.throws(() => assertAudioScope(scope, files), error => error.code === code);
  });
}

test('008新测试缺少或偷偷追加时拒绝，不能沿用旧数量', () => {
  const { scope, files } = candidate();
  for (const discovered of [files.slice(1), [...files, 'packages/bridge-core/test/mbrs008/not-listed.test.ts']])
    assert.throws(() => assertAudioScope(scope, discovered), error => error.code === 'AUDIO_TEST_INVENTORY_MISMATCH');
});
