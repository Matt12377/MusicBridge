import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRuleScope } from '../verify-mbrs004-rules.mjs';

const valid = () => ({ schema: 'mbrs004.rule-scope.v1', implementationComplete: true, countsConfirmed: true,
  baseSha: '7570d51973cc23d2a9894f63ba09d6444b9f484a', groups: [
    { name: 'contracts-unit', directory: 'packages/contracts', expectedTests: 2, tests: ['test/mbrs004/contracts.test.ts'] },
    { name: 'core-rules', directory: 'packages/bridge-core', expectedTests: 9, tests: ['test/mbrs004/golden.test.ts', 'test/mbrs004/scan.test.ts'] },
  ] });
const inventory = ['packages/contracts/test/mbrs004/contracts.test.ts',
  'packages/bridge-core/test/mbrs004/golden.test.ts', 'packages/bridge-core/test/mbrs004/scan.test.ts'];
const rejects = (change, code) => { const scope = valid(); change(scope); assert.throws(() => assertRuleScope(scope, inventory), error => error.code === code); };

test('004 Gate：完整冻结与实际nested清单一致时准入', () => assert.equal(assertRuleScope(valid(), inventory).length, 2));
test('004 Gate：只有Core行为组时准入，合同另由编译和类型检查验证', () => {
  const scope = valid(); scope.groups.shift();
  assert.equal(assertRuleScope(scope, inventory.filter(name => name.startsWith('packages/bridge-core/'))).length, 1);
});
test('004 Gate：未确认测试数量拒绝', () => rejects(s => { s.countsConfirmed = false; }, 'RULE_SCOPE_NOT_FROZEN'));
test('004 Gate：不是003最终报告基线拒绝', () => rejects(s => { s.baseSha = '85841879bf6d31b3efd0970f235c8431fed980e8'; }, 'RULE_SCOPE_NOT_FROZEN'));
test('004 Gate：零项或非整数计数拒绝', () => { for (const n of [0, 1.5, -1]) rejects(s => { s.groups[0].expectedTests = n; }, 'RULE_GROUP_INVALID'); });
test('004 Gate：缺Core行为测试拒绝', () => rejects(s => { s.groups.pop(); }, 'RULE_SCOPE_NOT_FROZEN'));
test('004 Gate：重复包或名称拒绝', () => { rejects(s => { s.groups[1].directory = s.groups[0].directory; }, 'RULE_GROUP_INVALID'); rejects(s => { s.groups[1].name = s.groups[0].name; }, 'RULE_GROUP_INVALID'); });
test('004 Gate：跨目录或旧任务路径拒绝', () => { for (const p of ['test/mbrs004/../scan.test.ts', 'test/mbrs003/scan.test.ts', '/test/mbrs004/scan.test.ts']) rejects(s => { s.groups[1].tests[0] = p; }, 'RULE_TEST_PATH_INVALID'); });
test('004 Gate：漏掉实际新增测试拒绝', () => assert.throws(() => assertRuleScope(valid(), [...inventory, 'packages/bridge-core/test/mbrs004/new.test.ts']), e => e.code === 'RULE_TEST_INVENTORY_MISMATCH'));
test('004 Gate：重复测试不能覆盖完整清单', () => rejects(s => { s.groups[1].tests.push(s.groups[1].tests[0]); }, 'RULE_TEST_INVENTORY_MISMATCH'));
