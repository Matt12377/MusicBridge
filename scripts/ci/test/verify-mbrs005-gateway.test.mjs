import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertGatewayScope } from '../verify-mbrs005-gateway.mjs';
const valid = () => {
  const scope = JSON.parse(readFileSync(new URL('../mbrs005-gateway-scope.json', import.meta.url), 'utf8'));
  scope.countsConfirmed = true; scope.implementationComplete = true; return scope;
};
const inventory = scope => scope.groups.flatMap(group => group.tests.filter(name => name.includes('/mbrs005/') || name.startsWith('test/mbrs005-')).map(name => group.directory + '/' + name));
function rejects(edit, code) {
  const scope = valid(), paths = inventory(scope); edit(scope);
  assert.throws(() => assertGatewayScope(scope, paths), error => error.code === code);
}
test('005 Gate：冻结任务测试和受影响回归可同时准入', () => {
  const scope = valid(); assert.equal(assertGatewayScope(scope, inventory(scope)).length, 3);
});
test('005 Gate：未冻结实现或数量拒绝', () => {
  for (const field of ['implementationComplete', 'countsConfirmed']) rejects(scope => { scope[field] = false; }, 'GATEWAY_SCOPE_NOT_FROZEN');
});
test('005 Gate：非004最终报告基线拒绝', () => rejects(scope => { scope.baseSha = 'a'.repeat(40); }, 'GATEWAY_SCOPE_NOT_FROZEN'));
test('005 Gate：零项、负数或非整数计数拒绝', () => {
  for (const count of [0, -1, 0.5]) rejects(scope => { scope.groups[0].expectedTests = count; }, 'GATEWAY_GROUP_INVALID');
});
test('005 Gate：新增测试漏列拒绝', () => {
  const scope = valid(); assert.throws(() => assertGatewayScope(scope, [...inventory(scope), 'packages/bridge-core/test/mbrs005/new.test.ts']), error => error.code === 'GATEWAY_TEST_INVENTORY_MISMATCH');
});
test('005 Gate：漏远程gateway或Owner回归拒绝', () => {
  rejects(scope => { scope.groups[1].tests = scope.groups[1].tests.filter(name => name !== 'test/gateway.test.ts'); }, 'GATEWAY_REQUIRED_REGRESSION_MISSING');
  rejects(scope => { scope.groups.pop(); }, 'GATEWAY_REQUIRED_REGRESSION_MISSING');
});
test('005 Gate：重复测试或组名拒绝', () => {
  rejects(scope => { scope.groups[0].tests.push(scope.groups[0].tests[0]); }, 'GATEWAY_TEST_INVENTORY_MISMATCH');
  rejects(scope => { scope.groups[1].name = scope.groups[0].name; }, 'GATEWAY_GROUP_INVALID');
});
test('005 Gate：跨目录、旧任务、未知平台或任意回归文件拒绝', () => {
  for (const name of ['../secret.test.ts', 'test/mbrs005/../bad.test.ts', 'test/mbrs003/scan.test.ts', '/test/mbrs005/a.test.ts', 'test/arbitrary.test.ts']) {
    rejects(scope => { scope.groups[0].tests[0] = name; }, 'GATEWAY_TEST_PATH_INVALID');
  }
  rejects(scope => { scope.groups[0].directory = 'native/rust-core'; }, 'GATEWAY_GROUP_INVALID');
});
