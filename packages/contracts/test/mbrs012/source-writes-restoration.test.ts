import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../../src/index.js';
import { hash, id, originOperationId, other, plan, preview, restorationPlan } from './fixtures.js';

test('012 逆向 artist 原多值合法，直接新写不借 restoration 或计划来源放宽', () => {
  const inverse = restorationPlan();
  assert.equal(c.isLocalSourceWritesPlan(inverse), true);
  assert.deepEqual(inverse.items[0]!.changes[0]!.after, ['原艺人乙 / 别名', '原艺人甲 e\u0301']);
  const applied = structuredClone(inverse); applied.state = 'COMPLETED'; Object.assign(applied.items[0]!, { state: 'applied', phase: 'TERMINAL', currentFileRevision: '3', backup: { state: 'retained', bytes: '256' }, verification: { audio: 'verified', unselectedMetadata: 'verified', content: 'verified', reread: 'verified' } });
  assert.equal(c.isLocalSourceWritesPlan(applied), true);
  assert.equal(c.isLocalSourceWritesPlan({ ...inverse, undoOf: null }), false);
  const missingMaterial = structuredClone(inverse); delete missingMaterial.items[0]!.restoration;
  assert.equal(c.isLocalSourceWritesPlan(missingMaterial), false);
  const direct = plan(); direct.items[0]!.changes = inverse.items[0]!.changes;
  assert.equal(c.isLocalSourceWritesPlan(direct), false);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { kind: 'tags', target: { mode: 'single', trackId: id }, fields: { artist: { action: 'set', value: inverse.items[0]!.changes[0]!.after } } } }), false);
});

test('012 restoration 的原计划/kind/material/完整输出 SHA 闭合，错误组合不能冒充材料', () => {
  const value = restorationPlan(), material = value.items[0]!.restoration!;
  assert.equal(c.isLocalSourceWritesPlan(value), true);
  for (const invalid of [{ originPlanId: id }, { originPlanId: '未知原计划' }, { originOperationId: '未知原操作' }, { kind: 'restore-directory-cover' }, { kind: 'restore' }, { material: 'verified-absence' }, { material: 'assumed-backup' }, { expectedOutputSha256: null }, { expectedOutputSha256: 'a' }, { expectedOutputSha256: hash.toUpperCase() }, { backupPath: '私有原件路径' }]) {
    const changed = { ...value, items: [{ ...value.items[0]!, restoration: { ...material, ...invalid } }] };
    assert.equal(c.isLocalSourceWritesPlan(changed), false);
  }
  const recovery = structuredClone(value); recovery.undoOf = null; recovery.recoveryOf = other;
  assert.equal(c.isLocalSourceWritesPlan(recovery), true);
  assert.equal(c.isLocalSourceWritesPlan({ ...recovery, recoveryOf: id }), false);
  assert.equal(c.isLocalSourceWritesPlan({ ...recovery, undoOf: other }), false);
});

test('012 原无目录封面的逆向明确移除新增文件，不假选图、不递增音频 revision', () => {
  const value = restorationPlan('DIRECTORY_COVER', true), item = value.items[0]!;
  assert.equal(c.isLocalSourceWritesPlan(value), true);
  assert.equal(item.artwork, null);
  assert.deepEqual(item.restoration, { originPlanId: other, originOperationId, kind: 'remove-new-directory-cover', material: 'verified-absence', expectedOutputSha256: null });
  value.state = 'COMPLETED'; Object.assign(item, { state: 'applied', phase: 'TERMINAL', backup: { state: 'retained', bytes: '0' } }); item.verification.content = item.verification.reread = 'verified';
  assert.equal(c.isLocalSourceWritesPlan(value), true);
  const changed = structuredClone(value); changed.items[0]!.currentFileRevision = '3'; assert.equal(c.isLocalSourceWritesPlan(changed), false);
  for (const invalid of [{ expectedOutputSha256: hash }, { material: 'verified-backup', expectedOutputSha256: hash }, { kind: 'restore-directory-cover' }]) assert.equal(c.isLocalSourceWritesPlan({ ...value, items: [{ ...item, restoration: { ...item.restoration!, ...invalid } }] }), false);
});

test('012 备份目录封面/音频内嵌封面的逆向不依赖当前候选，范围不能互换', () => {
  for (const range of ['DIRECTORY_COVER', 'EMBEDDED_COVER'] as const) {
    const value = restorationPlan(range), item = value.items[0]!;
    assert.equal(c.isLocalSourceWritesPlan(value), true);
    assert.equal(item.artwork, null); assert.equal(item.restoration!.material, 'verified-backup'); assert.equal(item.restoration!.expectedOutputSha256, hash);
    const wrongRange = structuredClone(value); wrongRange.range = range === 'DIRECTORY_COVER' ? 'EMBEDDED_COVER' : 'DIRECTORY_COVER'; assert.equal(c.isLocalSourceWritesPlan(wrongRange), false);
    const absent = structuredClone(value); delete absent.items[0]!.restoration; assert.equal(c.isLocalSourceWritesPlan(absent), false);
    const candidate = { editionId: id, candidateId: id, selectionId: id, expectedSelectionRevision: '1', contentRef: id, originalSha256: hash, mime: 'image/png', bytes: 4, width: 1, height: 1, slot: range === 'DIRECTORY_COVER' ? 'directory' : 'front' };
    assert.equal(c.isLocalSourceWritesPlan({ ...value, items: [{ ...item, artwork: candidate }] }), false);
    value.state = 'COMPLETED'; Object.assign(item, { state: 'applied', phase: 'TERMINAL', currentFileRevision: range === 'DIRECTORY_COVER' ? '2' : '3', backup: { state: 'retained', bytes: '256' }, verification: { audio: range === 'DIRECTORY_COVER' ? 'not-applicable' : 'verified', unselectedMetadata: range === 'DIRECTORY_COVER' ? 'not-applicable' : 'verified', content: 'verified', reread: 'verified' } });
    assert.equal(c.isLocalSourceWritesPlan(value), true);
  }
});

test('012 仅已绑定逆向 artist 可有1至32值，其他字段保留单值与原字段校验', () => {
  const value = restorationPlan(), change = value.items[0]!.changes[0]!;
  for (const count of [1, 32]) { const changed = structuredClone(value); changed.items[0]!.changes[0]!.after = Array.from({ length: count }, (_, index) => `原艺人${index}`); assert.equal(c.isLocalSourceWritesPlan(changed), true); }
  for (const after of [[], new Array(33).fill('原艺人'), [''], ['\ud800'], ['x'.repeat(513)]]) assert.equal(c.isLocalSourceWritesPlan({ ...value, items: [{ ...value.items[0]!, changes: [{ ...change, after }] }] }), false);
  for (const selected of [{ field: 'title', after: ['甲', '乙'] }, { field: 'year', after: ['2026-10'] }, { field: 'track', after: ['1/12'] }, { field: 'disc', after: ['01'] }]) assert.equal(c.isLocalSourceWritesPlan({ ...value, items: [{ ...value.items[0]!, changes: [{ ...change, ...selected }] }] }), false);
});

test('012 逆向原 body 保持六键九键，artist 原数组与 cover 的 null patch 精确映射', () => {
  for (const range of ['TAGS', 'EMBEDDED_COVER', 'DIRECTORY_COVER'] as const) {
    const projection = restorationPlan(range, range === 'DIRECTORY_COVER'), selected = projection.items[0]!;
    const body: c.OrganizerFrozenBody = { created_at: projection.readyAt!, scope: 'SOURCE_FILES', operations: [{ operation_id: id, kind: range === 'TAGS' ? 'WRITE_TAGS' : 'WRITE_COVER', root_id: id, target_asset_id: id, expected_asset_revision: '2', source_relative_path: '合成.flac', target_relative_path: null, field_patch: range === 'TAGS' ? { artists: selected.changes[0]!.after } : { artwork_selection_id: null }, backup_required: true }], root_mapping_revisions: { [id]: '1' }, conflicts: [], resource_guards: { require_exclusive_asset_lock: true, defer_if_read_lease: true, protect_frozen_sources: true, recheck_at_execution: true } };
    // context 这里只参与完整预算；原 op/backupHash/afterHash 的真实性必须由 Owner 另核。
    const capture = { body, context: { originPlanId: other, originOperationId, backupHash: hash, afterHash: hash }, projection };
    assert.equal(c.isOrganizerFrozenBody(body), true); assert.equal(Object.keys(body).length, 6); assert.equal(Object.keys(body.operations[0]!).length, 9);
    assert.equal(c.localSourceWritesCompletePlanWithinBudget(capture), true);
    const patch = range === 'TAGS' ? { artists: ['被猜测拼接的单艺人'] } : { artwork_selection_id: id };
    assert.equal(c.localSourceWritesCompletePlanWithinBudget({ ...capture, body: { ...body, operations: [{ ...body.operations[0], field_patch: patch }] } }), false);
    assert.equal(c.isOrganizerFrozenBody({ ...body, restoration: selected.restoration }), false);
  }
});

test('012 restoration 原始描述符先拒绝，客户端请求不能提交恢复投影来授能力', () => {
  const value = restorationPlan(); assert.equal(c.isLocalSourceWritesPlan(value), true);
  let reads = 0; Object.defineProperty(value.items[0]!.restoration!, 'expectedOutputSha256', { enumerable: true, get: () => { reads++; return hash; } });
  assert.equal(c.isLocalSourceWritesPlan(value), false); assert.equal(reads, 0);
  const material = restorationPlan().items[0]!.restoration!;
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), restoration: material }), false);
  assert.equal(c.isLocalSourceWritesCommandPayload('localSourceWrites.preview', { ...preview(), intent: { ...preview().intent, restoration: material } }), false);
});

test('012 同一逆向计划不重复借用原操作身份，闭集 restoration 拒 null 或额外键', () => {
  const value = restorationPlan(); assert.equal(c.isLocalSourceWritesPlan(value), true);
  for (const invalid of [null, { ...value.items[0]!.restoration!, permission: id }]) assert.equal(c.isLocalSourceWritesPlan({ ...value, items: [{ ...value.items[0]!, restoration: invalid }] }), false);
  const clone = structuredClone(value.items[0]!); clone.operationId = clone.resourceRef = clone.trackId = clone.assetId = other; value.items.push(clone);
  assert.equal(c.isLocalSourceWritesPlan(value), false);
  clone.restoration!.originOperationId = '44444444-4444-4444-8444-444444444444';
  assert.equal(c.isLocalSourceWritesPlan(value), true);
});
