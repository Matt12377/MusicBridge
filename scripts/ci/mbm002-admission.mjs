import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const MBM002_BASE = '8044d935e242d8647adc21445116fb49c9100e4a';
export const MBM002_OPERATIONS = Object.freeze([
  'createSession', 'getSession', 'closeSession', 'reportObservation', 'createResource',
  'getResource', 'releaseResource', 'renewResource', 'getMediaAsset', 'headMediaAsset',
]);
export const MBM002_BUDGETS = Object.freeze({ stageTimeoutMs: 180000, totalTimeoutMs: 480000, killGraceMs: 10000,
  rawOutputBytes: 16777216, sourceFileBytes: 16777216, maxSourceFiles: 8192 });

const TASK = 'MBM-002', BRANCH = 'codex/mbm-002-phone-resource-playback';
const SCOPE = 'docs/postrust/MBM-002/EXECUTION_SCOPE.json';
const CANONICAL_SHA = 'ee79461bf672e78c4ac29945d794e46286c92b0f909ced85bc4534a8a6de57bb';
const CANONICAL_BYTES = 145918;
const GROUPS = Object.freeze({
  contracts: Object.freeze({ prefix: 'packages/contracts/test/mbm002-', count: 15, files: Object.freeze([
    'packages/contracts/test/mbm002-audio-vocabulary.test.ts',
    'packages/contracts/test/mbm002-media-stream.test.ts',
  ]) }),
  core: Object.freeze({ prefix: 'packages/bridge-core/test/mbm002/', count: 30, files: Object.freeze([
    'packages/bridge-core/test/mbm002/auth-epoch.test.ts',
    'packages/bridge-core/test/mbm002/playback-service.test.ts',
    'packages/bridge-core/test/mbm002/source-service.integration.test.ts',
  ]) }),
  desktop: Object.freeze({ prefix: 'apps/desktop/test/mbm002/', count: 36, files: Object.freeze([
    'apps/desktop/test/mbm002/mobile-media-response.test.ts',
    'apps/desktop/test/mbm002/mobile-playback-https.test.ts',
    'apps/desktop/test/mbm002/mobile-playback-real-owner.test.ts',
  ]) }),
});

const same = isDeepStrictEqual;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = code => { const error = new Error('MBM002 手机资源播放准入拒绝。'); error.code = code; throw error; };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** 只读 JSON 数据，不读取 getter，也不把异常原型、空洞或循环引用当封存输入。 */
function jsonData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !record(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string')) return false;
  if (array && (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length'))) return false;
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || !jsonData(descriptor.value, seen)) return false;
    if (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) return false;
  }
  seen.delete(value);
  return true;
}
function list(value, predicate = () => true) {
  return Array.isArray(value) && jsonData(value) && value.every(predicate);
}
function exact(value, expected) {
  return list(value, item => typeof item === 'string') && value.length === expected.length
    && new Set(value).size === value.length && same([...value].sort(), [...expected].sort());
}
function mbrsEntries(status) {
  return Object.fromEntries(Object.entries(status).filter(([key, value]) => /^mbrs[0-9]/iu.test(key)
    || record(value) && typeof value.task === 'string' && value.task.startsWith('MBRS-')));
}
function effective(value) {
  return record(value) && value.originalTasks === 18 && value.originalAcceptanceCases === 156
    && value.activeTasks === 17 && value.activeAcceptanceCases === 150;
}
function mobileRows(rows) {
  if (!list(rows, value => record(value) && typeof value.id === 'string')
    || new Set(rows.map(value => value.id)).size !== rows.length) reject('MBM002_AUTHORITY_CHANGED');
  const current = rows.filter(value => value.id === TASK);
  if (current.length !== 1 || current[0].scope_ref !== SCOPE || current[0].base_report_sha !== MBM002_BASE
    || current[0].scheduled_after !== 'MBM-001' || current[0].owner_repeated_approval_required !== false
    || current[0].real_service_device_audio !== 'NOT_RUN' || current[0].owner_acceptance !== 'NOT_RUN') reject('MBM002_AUTHORITY_CHANGED');
  for (const id of ['MBM-003', 'MBM-004']) {
    const successor = rows.filter(value => value.id === id);
    if (successor.length !== 1 || successor[0].status !== 'NOT_STARTED' || successor[0].software !== 'NOT_RUN'
      || successor[0].production_app !== 'NOT_RUN' || successor[0].real_service_device_audio !== 'NOT_RUN'
      || successor[0].owner_acceptance !== 'NOT_RUN') reject('MBM002_SUCCESSOR_STARTED');
  }
}

/** 仅验证冻结准入；本地软件/App字段不是 Gate 通过、手机音频或 Owner 接受证明。 */
export function assertMbm002Admission(args) {
  if (!record(args)) reject('MBM002_SCOPE_CHANGED');
  const { execution, tests, canonical, canonicalBytes, status, plan, originalPlan, originalStatus, discovered } = args;
  if (!jsonData(execution) || !record(execution)
    || execution.schema !== 'musicbridge.mbm002.execution-scope.v1' || execution.task !== TASK
    || execution.baseSha !== MBM002_BASE || execution.branch !== BRANCH
    || execution.authority !== 'OWNER_CONTINUOUS_AUTHORIZATION_COORDINATOR_FORMAL_002_RELEASE'
    || execution.repeatedOwnerApprovalRequired !== false || !same(execution.gateBudgets, MBM002_BUDGETS)
    || execution.canonicalBytes !== CANONICAL_BYTES || execution.frozenCanonicalSha256 !== CANONICAL_SHA
    || !same(execution.operations, MBM002_OPERATIONS) || execution.sourceFilesWrite !== false
    || !Buffer.isBuffer(canonicalBytes) || canonicalBytes.length !== CANONICAL_BYTES || sha(canonicalBytes) !== CANONICAL_SHA) reject('MBM002_SCOPE_CHANGED');
  const preserve = execution.preserve;
  if (!record(preserve) || preserve.legacyTasks !== 18 || preserve.legacyAcceptanceCases !== 156
    || preserve.effectiveTasks !== 17 || preserve.effectiveAcceptanceCases !== 150
    || preserve.mbm001AcceptanceCases !== 9 || preserve.mbm001FrozenEvidence !== true
    || preserve.mbm003And004NotStarted !== true || preserve.optionalRust !== 'OFF'
    || preserve.controlAndOriginalStream !== 'LOOPBACK' || preserve.nodeDatasetWriter !== 'UNIQUE'
    || execution.nativeIOSDeviceAudio !== 'NOT_RUN' || execution.realProviderRoonNAS !== 'NOT_RUN'
    || execution.ownerAcceptance !== 'NOT_RUN') reject('MBM002_SCOPE_CHANGED');
  let decoded;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(canonicalBytes)); }
  catch { reject('MBM002_WIRE_CHANGED'); }
  if (!jsonData(canonical) || !same(canonical, decoded) || canonical?.openapi !== '3.1.1'
    || canonical.info?.version !== '1.6.0' || !record(canonical.paths)) reject('MBM002_WIRE_CHANGED');
  const operations = Object.values(canonical.paths).flatMap(item =>
    ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].filter(verb => item?.[verb]).map(verb => item[verb].operationId));
  if (operations.length !== 40 || new Set(operations).size !== 40
    || MBM002_OPERATIONS.some(operation => !operations.includes(operation))) reject('MBM002_WIRE_CHANGED');
  if (!jsonData(plan) || !record(plan) || !jsonData(originalPlan) || !record(originalPlan)
    || !same(plan.tasks, originalPlan.tasks) || !same(plan.acceptance_cases, originalPlan.acceptance_cases)
    || !list(plan.tasks, value => record(value) && typeof value.id === 'string') || plan.tasks.length !== 18
    || new Set(plan.tasks.map(value => value.id)).size !== 18 || plan.acceptance_count !== 156
    || !Array.isArray(plan.acceptance_cases) || plan.acceptance_cases.length !== 156
    || !effective(plan.effective_scope) || !same(plan.effective_scope, originalPlan.effective_scope)) reject('MBM002_ORIGINAL_LEDGER_CHANGED');
  if (!jsonData(status) || !record(status) || !jsonData(originalStatus) || !record(originalStatus)
    || Object.keys(mbrsEntries(originalStatus)).length < 16 || !same(mbrsEntries(status), mbrsEntries(originalStatus))
    || !same(status.currentPostRustTask, originalStatus.currentPostRustTask)
    || !effective(status.postRustEffectiveScope) || !same(status.postRustEffectiveScope, originalStatus.postRustEffectiveScope)
    || !same(status.policy, originalStatus.policy)
    || !record(originalStatus.mobilePairingReadonlyLibrary)
    || !same(status.mobilePairingReadonlyLibrary, originalStatus.mobilePairingReadonlyLibrary)
    || status.mobilePairingReadonlyLibrary.independentAcceptanceCount !== 9) reject('MBM002_ORIGINAL_TASK_STATE_CHANGED');
  const own = status.mobilePlaybackResources, lane = status.mobileFrontloading20261008, schedule = plan.execution_schedule;
  if (!record(own) || own.task !== TASK || own.scope !== SCOPE || own.baseSha !== MBM002_BASE || own.branch !== BRANCH
    || own.nativeIOSDeviceAudio !== 'NOT_RUN' || own.ownerAcceptance !== 'NOT_RUN'
    || own.realProviderRoonNAS !== undefined && own.realProviderRoonNAS !== 'NOT_RUN'
    || own.sourceFilesWrite !== undefined && own.sourceFilesWrite !== false
    || !record(lane) || lane.currentTask !== TASK || lane.nextTask !== 'MBM-003'
    || lane.ownerRepeatedApprovalRequired !== false || lane.originalTasks !== 18 || lane.originalAcceptanceCases !== 156
    || lane.effectiveTasks !== 17 || lane.effectiveAcceptanceCases !== 150
    || !record(schedule) || schedule.current_task !== TASK || schedule.current_task_scope_ref !== SCOPE
    || schedule.predecessor_final_report !== MBM002_BASE
    || schedule.original_dependencies_and_acceptance_unchanged !== true) reject('MBM002_AUTHORITY_CHANGED');
  mobileRows(lane.mobileTasks); mobileRows(plan.mobile_tasks);
  if (!jsonData(tests) || !record(tests) || tests.schema !== 'musicbridge.mbm002.test-scope.v1'
    || tests.task !== TASK || tests.baseSha !== MBM002_BASE || !same(tests.gateBudgets, MBM002_BUDGETS)
    || !jsonData(discovered) || !record(discovered) || !exact(Object.keys(discovered), Object.keys(GROUPS))) reject('MBM002_TEST_SCOPE_CHANGED');
  const allNames = [];
  for (const [area, expected] of Object.entries(GROUPS)) {
    const group = tests[area], found = discovered[area];
    if (!record(group) || !list(found, file => typeof file === 'string')
      || !exact(group.testFiles, expected.files) || !exact(group.helperFiles, [])
      || !exact(found, [...group.testFiles, ...group.helperFiles])
      || found.some(file => !file.startsWith(expected.prefix) || file.includes('..') || file.includes('\\'))
      || group.expectedTests !== expected.count || !list(group.caseNames, name => typeof name === 'string' && name.trim().length > 0
        && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(name))
      || group.caseNames.length !== expected.count || new Set(group.caseNames).size !== expected.count) reject('MBM002_TEST_SCOPE_INCOMPLETE');
    allNames.push(...group.caseNames);
  }
  if (new Set(allNames).size !== allNames.length) reject('MBM002_TEST_SCOPE_INCOMPLETE');
  return true;
}
