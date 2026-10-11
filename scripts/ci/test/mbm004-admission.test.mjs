import assert from 'node:assert/strict';
import test from 'node:test';
import { MBM004_BRANCH, MBM004_BASE, MBM004_SCOPE_PATH, MBM004_STATUS_PATH, MBM004_CANONICAL,
  validateMbm004Scope, assertMbm004Metadata, mbm004WorkflowOutputs } from '../mbm004-admission.mjs';
import { taskApplicabilityRoute, taskApplicabilityWorkflowOutputs } from '../task-applicability.mjs';
import { TAPE_CATALOG_COMMON_BRANCH, TAPE_CATALOG_COMMON_TASK } from '../tape-catalog-common-admission.mjs';

// 合成准入对象仅测拒绝边界，不签发实际Git/Source准入。
const clone = value => structuredClone(value);
function scope() {
  const required = ['packages/bridge-core/src/mobile/content-runtime.ts', 'packages/bridge-core/src/mobile/content-owner-service.ts',
    'packages/bridge-core/src/netease/mobile-actual-ports.ts', 'apps/desktop/src/main/mobile-content-port.ts',
    'apps/desktop/src/main/mobile-https-server.ts', 'scripts/ci/verify-mbm004-content.mjs', MBM004_STATUS_PATH,
    'project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'];
  return { schema: 'musicbridge.mbm004.execution-scope.v1', task: 'MBM-004', branch: MBM004_BRANCH, baseSha: MBM004_BASE,
    frozen: true, canonicalVersion: '1.7.0', canonicalOperations: 40, contentOperations: 19, canonical: clone(MBM004_CANONICAL),
    remotePushPolicy: 'MILESTONE_ONLY', realEvidence: 'NOT_RUN', oldGateReplayRequired: false, currentSoftwareGateRequired: true,
    files: [...required, ...Array.from({ length: 20 }, (_, index) => `packages/bridge-core/test/mbm004/synthetic-${index}.test.ts`)]
      .map(path => ({ path, status: 'A', bytes: 1, sha256: 'a'.repeat(64), role: 'test' })) };
}
function metadata() {
  const row = { id: 'MBM-004', base_report_sha: MBM004_BASE, branch: MBM004_BRANCH, scope_ref: MBM004_SCOPE_PATH,
    owner_repeated_approval_required: false, production_app: 'NOT_RUN', real_service_device_audio: 'NOT_RUN', owner_acceptance: 'NOT_RUN' };
  return { status: { mobileContentMultidevice: { task: 'MBM-004', branch: MBM004_BRANCH, baseSha: MBM004_BASE,
    scope: MBM004_SCOPE_PATH, ownerRepeatedApprovalRequired: false, remotePushPolicy: 'MILESTONE_ONLY',
    productionApp: 'NOT_RUN', realServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' },
    mobileFrontloading20261008: { currentTask: 'MBM-004', mobileTasks: [clone(row)] } },
  plan: { execution_schedule: { current_task: 'MBM-004', predecessor_final_report: MBM004_BASE,
    current_task_scope_ref: MBM004_SCOPE_PATH }, mobile_tasks: [clone(row)] } };
}
test('004明确分支优先于继承的磁带标记，未知分支不能用004记录回退旧作者', () => {
  assert.equal(taskApplicabilityRoute(MBM004_BRANCH, { task: TAPE_CATALOG_COMMON_TASK }), 'EXACT_MBM004');
  assert.equal(taskApplicabilityRoute('codex/unknown', null, { task: 'MBM-004' }), 'EXACT_MBM004');
  assert.equal(taskApplicabilityRoute(TAPE_CATALOG_COMMON_BRANCH, null, { task: 'MBM-004' }), 'EXACT_TAPE_COMMON');
  assert.equal(taskApplicabilityRoute('codex/mbm-003-lossless-dsd-transport', null), 'ORIGINAL_LOCAL_FIX_OR_MOBILE');
});
test('004范围须冻结且完整声明本轮Gate；canonical与旧证据边界不能升层', () => {
  assert.equal(validateMbm004Scope(scope()).task, 'MBM-004');
  for (const edit of [v => { v.frozen = false; }, v => { v.baseSha = 'b'.repeat(40); }, v => { v.canonicalOperations = 41; },
    v => { v.contentOperations = 18; }, v => { v.currentSoftwareGateRequired = false; }, v => { v.oldGateReplayRequired = true; },
    v => { v.realEvidence = 'PASSED'; }, v => { v.remotePushPolicy = 'EVERY_COMMIT'; }, v => { v.canonical.bytes--; }]) {
    const value = scope(); edit(value); assert.throws(() => validateMbm004Scope(value));
  }
});
test('004路径集合拒绝重复、链接候选、越界、删改、self pin和缺少运行时', () => {
  const integrated = scope();
  integrated.files.push({ path: 'packages/bridge-core/test/mbm004/content-owner-service.integration.test.ts',
    status: 'A', bytes: 1, sha256: 'a'.repeat(64), role: 'test' });
  assert.equal(validateMbm004Scope(integrated).files.length, integrated.files.length);
  for (const path of ['packages/bridge-core/test/mbm004/content-owner-service.extra.integration.test.ts',
    'packages/bridge-core/test/mbm004/unapproved.integration.test.ts']) {
    const invalid = scope();
    invalid.files.push({ path, status: 'A', bytes: 1, sha256: 'a'.repeat(64), role: 'test' });
    assert.throws(() => validateMbm004Scope(invalid));
  }
  for (const edit of [v => { v.files.push(clone(v.files[0])); }, v => { v.files[0].path = '../private'; },
    v => { v.files[0].path = 'packages/contracts/mobile/openapi.json'; }, v => { v.files[0].status = 'D'; },
    v => { v.files[0].sha256 = 'broken'; }, v => { v.files[0].bytes = 0; },
    v => { v.files[0].path = MBM004_SCOPE_PATH; }, v => { v.files.shift(); }]) {
    const value = scope(); edit(value); assert.throws(() => validateMbm004Scope(value));
  }
});
test('004仅准入已释放的WAV固定Worker格式切片；未知路径与历史冻结Gate不扩权', () => {
  const paths = ['packages/bridge-core/src/library/metadata-reader-worker.ts',
    'packages/bridge-core/src/library/metadata-reader-types.ts', 'packages/bridge-core/src/library/metadata-reader.ts',
    'packages/bridge-core/src/collection/local-scan-coordinator.ts',
    'packages/bridge-core/test/local-library-wave-empty-list.test.ts',
    'packages/bridge-core/test/local-library-wave-extensible.test.ts',
    'packages/bridge-core/test/mbrs004/name-rules-scan-integration.test.ts',
    'packages/bridge-core/test/mbrs005/config-integration.test.ts',
    'packages/bridge-core/test/mbrs006/owner-worker.ts', 'packages/bridge-core/test/mbrs007/queue-worker.ts',
    'packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts'];
  const value = scope();
  value.files.push(...paths.map(path => ({ path, status: 'M', bytes: 1, sha256: 'a'.repeat(64), role: 'product' })));
  assert.equal(validateMbm004Scope(value).files.length, value.files.length);
  for (const path of ['packages/bridge-core/src/library/metadata-reader-alternate.ts',
    'packages/bridge-core/src/stream/local-audio-converter.ts',
    'packages/bridge-core/test/local-library-wave-other.test.ts',
    'scripts/ci/tape-catalog-common-admission.mjs', 'scripts/ci/verify-tape-catalog-common.mjs',
    'scripts/ci/local-library-signed-stat-fix-admission.mjs', 'node_modules/music-metadata/lib/wav/WaveParser.js']) {
    const invalid = scope();
    invalid.files.push({ path, status: 'M', bytes: 1, sha256: 'a'.repeat(64), role: 'product' });
    assert.throws(() => validateMbm004Scope(invalid));
  }
});
test('004机器双表、scope、base和真实未验收身份必须一致', () => {
  const { status, plan } = metadata(); assert.equal(assertMbm004Metadata(status, plan), true);
  for (const edit of [(s,p) => { p.mobile_tasks.push(clone(p.mobile_tasks[0])); }, (s,p) => { p.mobile_tasks[0].branch = 'codex/other'; },
    s => { s.mobileContentMultidevice.productionApp = 'PASSED'; }, s => { s.mobileContentMultidevice.ownerRepeatedApprovalRequired = true; },
    (s,p) => { p.execution_schedule.current_task = 'MBRS-016'; }]) {
    const v = metadata(); edit(v.status, v.plan); assert.throws(() => assertMbm004Metadata(v.status, v.plan));
  }
});
test('004手工结果不能取得跳过旧Gate输出，实际Source对象作者不可伪造', () => {
  for (const result of [{ task: 'MBM-004' }, { schema: 'musicbridge.mbm004.admission.v1', task: 'MBM-004',
    oldGateEvidenceReused: true, currentSoftwareGateRequired: true, currentAppDeviceOwnerProven: false }]) {
    assert.throws(() => mbm004WorkflowOutputs(result)); assert.throws(() => taskApplicabilityWorkflowOutputs(result));
  }
});
