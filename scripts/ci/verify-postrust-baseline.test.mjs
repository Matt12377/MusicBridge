import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadRecords, validateRecords } from './verify-postrust-baseline.mjs';

const baseline = loadRecords();
const changed = operation => { const value = structuredClone(baseline); operation(value); return validateRecords(value); };

test('完整基线记录正例保持156条验收与NOT_ADMITTED', () => assert.deepEqual(validateRecords(baseline), []));
test('强制前置仍OPEN时拒绝G0提升', () => {
  const errors = changed(value => { value.admission.decision = 'ADMITTED'; value.plan.g0_decision = 'ADMITTED'; });
  assert.ok(errors.includes('OPEN_PREREQUISITE_BLOCKS_G0'));
});
test('转交不得计完成', () => {
  const errors = changed(value => { value.carry.entries[0].status = 'PASS'; value.carry.entries[0].transfer_is_completion = true; });
  assert.ok(errors.includes('TRANSFER_NOT_COMPLETION'));
});
test('覆盖所有原始未完框，不能以主题去重丢项', () => {
  const errors = changed(value => value.carry.entries.splice(3, 1));
  assert.ok(errors.includes('ALL_OPEN_TODO_COVERAGE'));
});
test('阻断G0前置交给依赖G0的任务', () => {
  const errors = changed(value => { const entry = value.carry.entries.find(item => item.g0_prerequisite === 'YES'); entry.primary_task = 'MBRS-002'; entry.acceptance_owner = 'MBRS-002'; });
  assert.ok(errors.includes('G0_REVERSE_DEPENDENCY'));
});
test('同库第二writer拒绝，Rust不能偷偷成为业务库作者', () => {
  const duplicate = changed(value => value.admission.component_owners.push({ ...value.admission.component_owners[0], writer_id: 'rust-writer', language: 'Rust' }));
  assert.ok(duplicate.includes('DATABASE_DUPLICATE_OWNER')); assert.ok(duplicate.includes('RUST_READONLY'));
});
test('保留原验收内容而不是只保留ID计数', () => {
  const errors = changed(value => { value.plan.acceptance_cases[50].requirement = '已移交即可通过'; });
  assert.ok(errors.includes('ACCEPTANCE_ASSERTION_PRESERVED'));
});
test('同步篡改冻结验收与当前台账并重封摘要仍拒绝', () => {
  const errors = changed(value => {
    value.frozenAcceptance.cases[50].requirement = '已移交即可通过';
    value.plan.acceptance_cases[50].requirement = '已移交即可通过';
    value.plan.source_acceptance_sha256 = createHash('sha256').update(JSON.stringify(value.frozenAcceptance, null, 2) + '\n').digest('hex');
  });
  assert.ok(errors.includes('PACK_SOURCE_PIN'));
});
test('旧产物blob不能冒充当前基线代码复用', () => {
  const errors = changed(value => { value.reuse.entries[0].resolved_files[0].git_blob = '0'.repeat(40); });
  assert.ok(errors.includes('REUSE_BLOB_IDENTITY'));
});
test('完整迁移未完成与阶段交接保持分层', () => {
  const errors = changed(value => { value.admission.full_rust_migration_completed = true; });
  assert.ok(errors.includes('FULL_MIGRATION_NOT_COMPLETED'));
});
test('跨路线依赖环拒绝', () => {
  const errors = changed(value => value.carry.dependency_edges.push({ prerequisite: 'G0', dependent: 'RUST-016-ci-security-portability' }));
  assert.ok(errors.includes('DEPENDENCY_CYCLE'));
});
test('结构资料不能自动变成App、live或Owner通过', () => {
  const errors = changed(value => { value.plan.acceptance_cases[0].app_status = 'PASS'; value.plan.acceptance_cases[0].owner_status = 'PASS'; });
  assert.ok(errors.includes('BASELINE_NOT_APP_LIVE_OWNER'));
});
test('拟议Rust任务注册依赖同样不能构成G0循环', () => {
  const errors = changed(value => value.carry.planned_task_registry.find(task => task.task === 'RUST-016-ci-security-portability').depends_on.push('G0'));
  assert.ok(errors.includes('DEPENDENCY_CYCLE'));
});
