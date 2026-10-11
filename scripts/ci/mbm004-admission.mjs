import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalLibraryFixWhole } from './local-library-signed-stat-fix-admission.mjs';

export const MBM004_TASK = 'MBM-004';
export const MBM004_BRANCH = 'codex/mbm-004-content-multidevice';
export const MBM004_BASE = '479e746bb7106a4dac158fe616290220de03a53a';
export const MBM004_SCOPE_PATH = 'docs/postrust/MBM-004/EXECUTION_SCOPE.json';
export const MBM004_STATUS_PATH = 'docs/postrust/MBM-004/STATUS.json';
export const MBM004_CORRECTION_PATH = 'docs/postrust/MBM-004/SOURCE_CORRECTION.json';
export const MBM004_PREDECESSOR_SOURCE = '78184e7849cc3b10191ea64af29ba8bc23162b0a';
const correctionPaths = ['packages/bridge-core/src/mobile/content-state.ts',
  'packages/bridge-core/test/mbm004/content-state.test.ts',
  'packages/bridge-core/src/runtime.ts', 'packages/bridge-core/test/mbm004/content-runtime.test.ts',
  'packages/bridge-core/src/collection/collection-progress-store.ts',
  'packages/bridge-core/test/collection-progress-store.test.ts', 'scripts/ci/mbm004-admission.mjs',
  'scripts/ci/test/mbm004-admission.test.mjs', 'scripts/ci/verify-mbm004-content.mjs',
  'scripts/ci/report-only-admission.mjs', 'scripts/ci/report-only-mbm004.mjs',
  'scripts/ci/test/mbm004-report-only.test.mjs',
  'tasks/MBM-004_CONTENT_MULTIDEVICE.md', 'docs/postrust/MBM-004/STATUS.json',
  'docs/postrust/MBM-004/LOCAL_SOFTWARE_EVIDENCE.json', 'project/STATUS.json',
  'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'];
export const MBM004_CORRECTION_IDENTITY = Object.freeze({
  schema: 'musicbridge.mbm004.source-correction.v1', task: 'MBM-004', baseSha: MBM004_BASE,
  predecessorSource: MBM004_PREDECESSOR_SOURCE,
  predecessorScope: Object.freeze({ path: MBM004_SCOPE_PATH, bytes: 26114,
    sha256: 'bbabf58b0c8898cc786eb7f312873e4c66271c5788d6d85b672ed914d5a0f8f5' }),
  failure: Object.freeze({ repositoryId: 1340424953, runId: 38104035956, runAttempt: 1, event: 'push',
    jobId: 114365640039, artifactId: 11689635522, artifactBytes: 90379222,
    artifactSha256: '95e418182aa91e782d1207b5314544ecada00a0f10692c9543ad816ddd0b0a1d',
    stage: 'core-content-behavior', stageLimitMs: 180000, elapsedMs: 180016, exitCode: null,
    signal: 'SIGKILL', timeout: true, overflow: false, cleanupFailed: false, passed: false,
    expectedTests: 159, counts: null, stageJsonBytes: 448,
    stageJsonSha256: '08f42d9c86bda1cbf4ee1c0137a585b6fe9f89ece1590f05485cade46e7e2108',
    rawBytes: 20998, rawSha256: 'b650470b1f4673a6c1a8fe3e3db8c570311fa45f744522a12a9b63c660abad52' }),
  electronFailure: Object.freeze({ repositoryId: 1340424953, runId: 38104035996, runAttempt: 1, event: 'push',
    jobId: 114365640485, artifactId: 11690078116, artifactBytes: 503958596,
    artifactSha256: 'df4036d655e31c4d919941447a935331b5e7931bd8f1724b528af76031ba1a88',
    conclusion: 'failure', startupCrashSafeStorageRecovery: 'success',
    passedTests: 109, failedTests: 2, skippedTests: 5,
    wholeJobLogBytes: 191806, wholeJobLogSha256: '709677a8b8c597e832fd7bbbf2c688ea8ffe6eb1ab90bb6623ca0b64214bcd2b',
    mobileFailure: 'AUTHENTICATED_CAPABILITIES_STAGE_TEST_RUNTIME_CONTENT_PORT_MISSING',
    collectionFailure: 'SNAPSHOT_HISTORY_PAGE_TIMEOUT',
    mobileFailureCapture: Object.freeze({ entry: 'musicbridge-electron/tmp/mbm001-mobile-connection-hw934x/failure.json',
      bytes: 6278, sha256: 'e08459903a3713f661653a9dd109f16b7f012d31e553e86b1af845272704d924',
      stage: '有鉴权空目录与闭集能力', lastOperation: 'getCapabilities', lastLabel: 'capabilities-A', lastStatus: 503,
      retries: 0, credentialsArchived: false, wholeResponseBodiesArchived: false }),
    collectionFailureContext: Object.freeze({ entry: 'musicbridge-electron/results/task-070-V3完成度：合法大目录历史按响应字节预算分页，完整分组与全部快照均可到达/error-context.md',
      bytes: 29113, sha256: 'c68096b0f50ce78362e043c42242f434afb2a93797635803950614d27b616e56' }),
    artifactFailureCapture: 'WHOLE_FAILURE_MEMBERS_AND_ZIP_DIGEST_REQUIRED_BEFORE_SOURCE_FREEZE' }),
  repairKind: 'CONTENT_STATE_QUALIFICATION_OFFLINE_RUNTIME_AND_REQUEST_LOCAL_HISTORY_REUSE',
  repairPaths: Object.freeze(correctionPaths),
  budgetPolicy: 'UNCHANGED_180000_STAGE_480000_WHOLE',
  currentEvidence: 'REQUIRED_FRESH_SOURCE_GATE_AND_FIRST_NATURAL_CI', realEvidence: 'NOT_RUN',
});
export const MBM004_CANONICAL = Object.freeze({ path: 'packages/contracts/mobile/openapi.json', bytes: 147445,
  sha256: '3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21' });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const metadata = ['project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'];
const sharedProducts = new Set(['apps/desktop/src/main/index.ts', 'apps/desktop/src/main/core-supervisor.ts',
  'apps/desktop/src/main/mobile-backend.ts', 'apps/desktop/src/main/mobile-settings.ts',
  'apps/desktop/src/main/mobile-playback-backend.ts', 'apps/desktop/src/main/mobile-https-server.ts',
  'packages/bridge-core/src/runtime.ts', 'packages/bridge-core/src/utility-main.ts',
  'packages/bridge-core/src/collection/dataset-domain.ts', 'packages/bridge-core/src/mobile/types.ts',
  'packages/bridge-core/src/mobile/owner-protocol.ts', 'packages/bridge-core/src/mobile/source-types.ts',
  'packages/bridge-core/src/mobile/playback-state.ts', 'packages/bridge-core/src/mobile/playback-service.ts',
  'packages/bridge-core/src/netease/client.ts', 'packages/bridge-core/src/netease/types.ts', 'packages/contracts/src/mobile-wire.ts']);
// 已授权 MBF001 A/B 的原播放入口、只读回执与有限诊断；不扩大 mobile 1.7/40。
for(const file of ['apps/desktop/src/main/local-library-ipc.ts','apps/desktop/src/preload/local-library-client.ts',
  'apps/desktop/src/renderer/src/App.vue','apps/desktop/src/renderer/src/components/library/LocalLibraryView.vue',
  'apps/desktop/src/renderer/src/components/player/details.ts','apps/desktop/src/renderer/src/composables/application/useLocalLibrary.ts',
  'apps/desktop/src/renderer/src/composables/application/usePlaybackSession.ts','packages/bridge-core/src/application/bridge-controller.ts',
  'packages/bridge-core/src/roon/adapter.ts','packages/bridge-core/src/roon/types.ts','packages/bridge-core/src/stream/gateway.ts',
  'packages/bridge-core/src/stream/local-file-http.ts','packages/contracts/src/diagnostics.ts','packages/contracts/src/validator.ts',
  'packages/contracts/src/ipc.ts','packages/contracts/src/ipc-names.ts','packages/contracts/src/local-play-request.ts',
  'packages/contracts/src/local-relocation.ts'])sharedProducts.add(file);
// MBF001-C 仅放行本轮固定 Worker 的格式投影与版本同步，旧冻结准入身份保持原样。
for (const file of ['packages/bridge-core/src/library/metadata-reader-worker.ts',
  'packages/bridge-core/src/library/metadata-reader-types.ts', 'packages/bridge-core/src/library/metadata-reader.ts',
  'packages/bridge-core/src/collection/local-scan-coordinator.ts']) sharedProducts.add(file);
const localFormatTests = new Set(['packages/bridge-core/test/local-library-wave-empty-list.test.ts',
  'packages/bridge-core/test/local-library-wave-extensible.test.ts',
  'packages/bridge-core/test/mbrs004/name-rules-scan-integration.test.ts',
  'packages/bridge-core/test/mbrs005/config-integration.test.ts', 'packages/bridge-core/test/mbrs006/owner-worker.ts',
  'packages/bridge-core/test/mbrs007/queue-worker.ts', 'packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts']);
const collectionCorrectionRows = Object.freeze([
  Object.freeze({ path: 'packages/bridge-core/src/collection/collection-progress-store.ts', status: 'M', role: 'product' }),
  Object.freeze({ path: 'packages/bridge-core/test/collection-progress-store.test.ts', status: 'M', role: 'test' }),
  Object.freeze({ path: MBM004_CORRECTION_PATH, status: 'A', role: 'authority' }),
]);
const sharedCi = new Set(['.github/workflows/verify.yml', 'scripts/ci/task-applicability.mjs', 'scripts/ci/report-only-admission.mjs',
  'scripts/ci/test/tape-catalog-common-admission.test.mjs']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const relative = value => typeof value === 'string' && value.length > 0 && value.length < 1024
  && !path.isAbsolute(value) && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const without = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
function fail(code) { const error = new Error('004正式内容任务准入拒绝。'); error.code = code; throw error; }
function parse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('MBM004_JSON_INVALID'); }
}
/** 只接受已实读失败的781这一条修复链，不给任意父提交或重跑签发资格。 */
export function validateMbm004Correction(value) {
  if (!equal(value, MBM004_CORRECTION_IDENTITY)) fail('MBM004_SOURCE_CORRECTION_IDENTITY_CHANGED');
  return value;
}
export function assertMbm004SourceLineage({ head, parents, correction = null, predecessorParents = null }) {
  if (!sha(head) || !Array.isArray(parents) || parents.length !== 2 || parents[0] !== head) fail('MBM004_SOURCE_DIRECT_PARENT_REQUIRED');
  if (correction === null) {
    if (head !== MBM004_PREDECESSOR_SOURCE || parents[1] !== MBM004_BASE) fail('MBM004_SOURCE_DIRECT_PARENT_REQUIRED');
  } else {
    validateMbm004Correction(correction);
    if (head === MBM004_PREDECESSOR_SOURCE || parents[1] !== MBM004_PREDECESSOR_SOURCE
      || !equal(predecessorParents, [MBM004_PREDECESSOR_SOURCE, MBM004_BASE])) fail('MBM004_SOURCE_CORRECTION_PARENT_CHANGED');
  }
  return true;
}
function allowed(file) {
  return metadata.includes(file) || sharedProducts.has(file) || sharedCi.has(file) || localFormatTests.has(file)
    || collectionCorrectionRows.some(row => row.path === file)
    || file === 'tasks/MBM-004_CONTENT_MULTIDEVICE.md' || file === 'tasks/00_TASK_INDEX.md'
    || /^docs\/postrust\/MBM-004\/[A-Z0-9_]+\.(?:json|md)$/u.test(file)
    || /^packages\/bridge-core\/src\/mobile\/(?:content-[a-z-]+|owner-content-protocol|netease-[a-z-]+)\.ts$/u.test(file)
    || /^packages\/bridge-core\/src\/netease\/mobile-[a-z-]+\.ts$/u.test(file)
    || /^packages\/bridge-core\/test\/mbm004\/[a-z0-9-]+\.test\.ts$/u.test(file)
    || file === 'packages/bridge-core/test/mbm004/content-owner-service.integration.test.ts'
    || file === 'packages/bridge-core/test/mbm004/content-owner-fixture.ts'
    || /^apps\/desktop\/src\/main\/mobile-content-[a-z-]+\.ts$/u.test(file)
    || /^apps\/desktop\/test\/mobile-content-[a-z-]+\.test\.ts$/u.test(file)
    || file === 'apps/desktop/test/local-playback-main-timeout.test.ts'
    || file === 'apps/desktop/test/local-playback-recovery.test.ts'
    || file === 'packages/contracts/test/mbf001-recovery-diagnostics.test.ts'
    || /^scripts\/ci\/(?:mbm004-admission|report-only-mbm004|verify-mbm004-content)\.mjs$/u.test(file)
    || /^scripts\/ci\/test\/(?:mbm004-[a-z-]+|task-applicability)\.test\.mjs$/u.test(file);
}
export function validateMbm004Scope(scope) {
  if (!object(scope) || scope.schema !== 'musicbridge.mbm004.execution-scope.v1'
    || scope.task !== MBM004_TASK || scope.branch !== MBM004_BRANCH || scope.baseSha !== MBM004_BASE
    || scope.frozen !== true || scope.canonicalVersion !== '1.7.0' || scope.canonicalOperations !== 40
    || scope.contentOperations !== 19 || !equal(scope.canonical, MBM004_CANONICAL)
    || scope.remotePushPolicy !== 'MILESTONE_ONLY' || scope.realEvidence !== 'NOT_RUN'
    || scope.oldGateReplayRequired !== false || scope.currentSoftwareGateRequired !== true
    || !Array.isArray(scope.files) || scope.files.length < 30 || scope.files.length > 120) fail('MBM004_SCOPE_INVALID');
  const paths = new Set();
  for (const row of scope.files) {
    if (!object(row) || !relative(row.path) || !allowed(row.path) || paths.has(row.path)
      || !['A', 'M'].includes(row.status) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 16777216
      || !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '') || !['product', 'test', 'gate', 'metadata', 'authority'].includes(row.role)) fail('MBM004_SCOPE_FILE_INVALID');
    paths.add(row.path);
  }
  for (const file of ['packages/bridge-core/src/mobile/content-runtime.ts',
    'packages/bridge-core/src/mobile/content-owner-service.ts', 'packages/bridge-core/src/netease/mobile-actual-ports.ts',
    'apps/desktop/src/main/mobile-content-port.ts', 'apps/desktop/src/main/mobile-https-server.ts',
    'scripts/ci/verify-mbm004-content.mjs', MBM004_STATUS_PATH, ...metadata]) if (!paths.has(file)) fail('MBM004_SCOPE_REQUIRED_FILE_MISSING');
  if (paths.has(MBM004_SCOPE_PATH)) fail('MBM004_SCOPE_SELF_PIN_FORBIDDEN');
  if (Object.hasOwn(scope, 'sourceCorrection')
    ? scope.sourceCorrection !== MBM004_CORRECTION_PATH || !scope.files.some(row => row.path === MBM004_CORRECTION_PATH && row.role === 'authority')
    : paths.has(MBM004_CORRECTION_PATH)) fail('MBM004_SOURCE_CORRECTION_SCOPE_CHANGED');
  return scope;
}
/** 纯范围比较不签发准入；原111行的身份与角色全部保留，新三行逐项固定。 */
export function assertMbm004CorrectionScope(predecessorScope, scope) {
  validateMbm004Scope(predecessorScope); validateMbm004Scope(scope);
  if (Object.hasOwn(predecessorScope, 'sourceCorrection') || scope.sourceCorrection !== MBM004_CORRECTION_PATH)
    fail('MBM004_SOURCE_CORRECTION_SCOPE_CHANGED');
  const expected = predecessorScope.files.map(({ path, status, role }) => ({ path, status, role }));
  if (collectionCorrectionRows.some(row => expected.some(old => old.path === row.path)))
    fail('MBM004_SOURCE_CORRECTION_PREDECESSOR_PATHS_CHANGED');
  expected.push(...collectionCorrectionRows);
  const actual = scope.files.map(({ path, status, role }) => ({ path, status, role }));
  if (!equal(expected.sort((a,b) => a.path.localeCompare(b.path)), actual.sort((a,b) => a.path.localeCompare(b.path))))
    fail('MBM004_SOURCE_CORRECTION_SCOPE_CHANGED');
  return true;
}
export function assertMbm004Metadata(status, plan) {
  const authority = status?.mobileContentMultidevice, lane = status?.mobileFrontloading20261008;
  const statusRows = lane?.mobileTasks?.filter(row => row.id === MBM004_TASK);
  const planRows = plan?.mobile_tasks?.filter(row => row.id === MBM004_TASK);
  if (authority?.task !== MBM004_TASK || authority.branch !== MBM004_BRANCH || authority.baseSha !== MBM004_BASE
    || authority.scope !== MBM004_SCOPE_PATH || authority.ownerRepeatedApprovalRequired !== false
    || authority.remotePushPolicy !== 'MILESTONE_ONLY' || authority.productionApp !== 'NOT_RUN'
    || authority.realServiceDeviceAudio !== 'NOT_RUN' || authority.ownerAcceptance !== 'NOT_RUN'
    || lane?.currentTask !== MBM004_TASK || plan?.execution_schedule?.current_task !== MBM004_TASK
    || plan.execution_schedule.predecessor_final_report !== MBM004_BASE
    || plan.execution_schedule.current_task_scope_ref !== MBM004_SCOPE_PATH
    || statusRows?.length !== 1 || planRows?.length !== 1 || !equal(statusRows[0], planRows[0])
    || statusRows[0].base_report_sha !== MBM004_BASE || statusRows[0].branch !== MBM004_BRANCH
    || statusRows[0].scope_ref !== MBM004_SCOPE_PATH || statusRows[0].owner_repeated_approval_required !== false
    || ['production_app', 'real_service_device_audio', 'owner_acceptance'].some(key => statusRows[0][key] !== 'NOT_RUN')) fail('MBM004_METADATA_INVALID');
  return true;
}
/** 原18/156历史账和取消015后的17/150有效账逐项保留，新增004不能抵扣旧验收。 */
export function assertMbm004PredecessorMetadata(beforeStatus, status, beforePlan, plan) {
  const laneFields = ['state', 'currentTask', 'nextTask', 'remainingSequence', 'recordedAt'];
  const scheduleFields = ['current_task', 'current_task_scope_ref', 'predecessor_final_report', 'remaining_sequence', 'remote_push_policy'];
  const otherRows = rows => rows.filter(row => row.id !== MBM004_TASK);
  const statusBase = without(beforeStatus, ['mobileFrontloading20261008']);
  const statusCurrent = without(status, ['mobileFrontloading20261008', 'mobileContentMultidevice', 'currentMobileContentTask', 'mbm004Policy']);
  if (!equal(statusBase, statusCurrent)
    || !equal(without(beforeStatus.mobileFrontloading20261008, [...laneFields, 'mobileTasks']), without(status.mobileFrontloading20261008, [...laneFields, 'mobileTasks']))
    || !equal(otherRows(beforeStatus.mobileFrontloading20261008.mobileTasks), otherRows(status.mobileFrontloading20261008.mobileTasks))
    || !equal(without(beforePlan, ['execution_schedule', 'mobile_tasks']), without(plan, ['execution_schedule', 'mobile_tasks']))
    || !equal(without(beforePlan.execution_schedule, scheduleFields), without(plan.execution_schedule, scheduleFields))
    || !equal(otherRows(beforePlan.mobile_tasks), otherRows(plan.mobile_tasks))
    || status.mobileFrontloading20261008.effectiveTasks !== 17 || status.mobileFrontloading20261008.effectiveAcceptanceCases !== 150
    || plan.tasks.length !== 18 || plan.acceptance_cases.length !== 156) fail('MBM004_PREDECESSOR_METADATA_CHANGED');
  return true;
}
/** 只有完整实际准入的同对象能签发004输出，不给手工拼接结果降旧Gate。 */
const accepted = new WeakSet();
export function mbm004WorkflowOutputs(result) {
  if (!accepted.has(result)) fail('MBM004_RESULT_NOT_ADMITTED');
  return { task: MBM004_TASK, mobileTask: MBM004_TASK, legacyGateMode: 'reuse-frozen',
    localLibraryFixTask: 'not-applicable', combinedGateMode: 'not-applicable', contentTask: MBM004_TASK };
}
function currentMbm004Git(directory, env) {
  if (!path.isAbsolute(directory) || realpathSync(directory) !== directory) fail('MBM004_ROOT_INVALID');
  const environment = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(environment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const git = args => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args],
    { cwd: directory, env: environment, timeout: 10000, maxBuffer: 16777216 });
  const text = args => git(args).toString('utf8').trim();
  const head = text(['rev-parse', 'HEAD']), branch = text(['branch', '--show-current']) || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (!sha(head) || branch !== MBM004_BRANCH || env.GITHUB_ACTIONS === 'true' && env.GITHUB_SHA !== head) fail('MBM004_BRANCH_OR_HEAD_MISMATCH');
  const gitRoot = text(['rev-parse', '--show-toplevel']);
  if (gitRoot !== directory || text(['rev-parse', '--is-shallow-repository']) !== 'false'
    || text(['replace', '-l']) || text(['status', '--porcelain=v1', '--untracked-files=all'])) fail('MBM004_GIT_STATE_INVALID');
  const common = text(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  for (const file of ['objects/info/alternates', 'info/grafts', 'shallow']) if (existsSync(path.join(common, file))) fail('MBM004_GIT_OVERLAY_FORBIDDEN');
  return { git, text, head, branch };
}
function nameStatus(git, from, to) {
  const raw = git(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, to]);
  const parts = raw.toString('utf8').split('\0');
  if (parts.pop() !== '' || parts.length % 2 !== 0) fail('MBM004_SOURCE_PATH_SET_CHANGED');
  const rows = [];
  for (let index = 0; index < parts.length; index += 2) rows.push([parts[index], parts[index + 1]]);
  return rows;
}
const samePaths = (left, right) => equal(left.sort((a,b) => a[1].localeCompare(b[1])), right.sort((a,b) => a[1].localeCompare(b[1])));
// 私有对象核验由当前真实 Git 派生 Source；报告不创建临时 checkout 或伪准入输出。
function sourceGitObject(git, text, head) {
  const record = parse(git(['show', head + ':' + MBM004_STATUS_PATH]));
  if (record.task !== MBM004_TASK || record.baseSha !== MBM004_BASE || record.branch !== MBM004_BRANCH) fail('MBM004_TASK_RECORD_INVALID');
  const scopeBytes = git(['show', head + ':' + MBM004_SCOPE_PATH]);
  const scope = validateMbm004Scope(parse(scopeBytes));
  const status = parse(git(['show', head + ':' + metadata[0]])), plan = parse(git(['show', head + ':' + metadata[1]]));
  assertMbm004Metadata(status, plan);
  assertMbm004PredecessorMetadata(parse(git(['show', MBM004_BASE + ':' + metadata[0]])), status,
    parse(git(['show', MBM004_BASE + ':' + metadata[1]])), plan);
  const parents = text(['rev-list', '--parents', '-n', '1', head]).split(' ');
  let correction = null;
  if (scope.sourceCorrection) {
    correction = validateMbm004Correction(parse(git(['show', head + ':' + MBM004_CORRECTION_PATH])));
    const predecessorParents = text(['rev-list', '--parents', '-n', '1', MBM004_PREDECESSOR_SOURCE]).split(' ');
    assertMbm004SourceLineage({ head, parents, correction, predecessorParents });
    const oldBytes = git(['show', MBM004_PREDECESSOR_SOURCE + ':' + MBM004_SCOPE_PATH]);
    if (oldBytes.length !== correction.predecessorScope.bytes || digest(oldBytes) !== correction.predecessorScope.sha256)
      fail('MBM004_SOURCE_CORRECTION_PREDECESSOR_SCOPE_CHANGED');
    const oldScope = validateMbm004Scope(parse(oldBytes));
    if (oldScope.sourceCorrection !== undefined || oldScope.files.length !== 111) fail('MBM004_SOURCE_CORRECTION_PREDECESSOR_SCOPE_CHANGED');
    assertMbm004CorrectionScope(oldScope, scope);
    const oldDiff = nameStatus(git, MBM004_BASE, MBM004_PREDECESSOR_SOURCE);
    const oldExpected = oldScope.files.map(row => [row.status, row.path]).concat([['A', MBM004_SCOPE_PATH]]);
    if (!samePaths(oldDiff, oldExpected))
      fail('MBM004_SOURCE_CORRECTION_PREDECESSOR_PATHS_CHANGED');
    for (const row of oldScope.files) {
      const bytes = git(['show', MBM004_PREDECESSOR_SOURCE + ':' + row.path]);
      if (bytes.length !== row.bytes || digest(bytes) !== row.sha256
        || text(['ls-tree', MBM004_PREDECESSOR_SOURCE, '--', row.path]).split(' ')[0] !== '100644')
        fail('MBM004_SOURCE_CORRECTION_PREDECESSOR_PIN_CHANGED');
    }
    const repairDiff = nameStatus(git, MBM004_PREDECESSOR_SOURCE, head);
    const repairExpected = correction.repairPaths.map(file => ['M', file])
      .concat([['A', MBM004_CORRECTION_PATH], ['M', MBM004_SCOPE_PATH]]);
    if (!samePaths(repairDiff, repairExpected))
      fail('MBM004_SOURCE_CORRECTION_PATH_SET_CHANGED');
  } else assertMbm004SourceLineage({ head, parents });
  const diff = nameStatus(git, MBM004_BASE, head);
  const expected = scope.files.map(row => [row.status, row.path]).concat([['A', MBM004_SCOPE_PATH]]);
  if (!samePaths(diff, expected)) fail('MBM004_SOURCE_PATH_SET_CHANGED');
  for (const row of scope.files) {
    const bytes = git(['show', head + ':' + row.path]);
    if (bytes.length !== row.bytes || digest(bytes) !== row.sha256
      || text(['ls-tree', head, '--', row.path]).split(' ')[0] !== '100644') fail('MBM004_FILE_PIN_CHANGED');
  }
  const canonicalBytes = git(['show', head + ':' + MBM004_CANONICAL.path]);
  if (canonicalBytes.length !== MBM004_CANONICAL.bytes || digest(canonicalBytes) !== MBM004_CANONICAL.sha256
    || !git(['show', MBM004_BASE + ':' + MBM004_CANONICAL.path]).equals(canonicalBytes)) fail('MBM004_CANONICAL_CHANGED');
  return { scope, scopeBytes, correction, canonicalBytes };
}
function assertGitStillCurrent(text, head) {
  if (text(['rev-parse', 'HEAD']) !== head || text(['status', '--porcelain=v1', '--untracked-files=all'])) fail('MBM004_ADMISSION_DRIFT');
}
/** 报告唯一父由当前真实HEAD派生；完整核其Source对象，不给自由SHA或伪父列表降门禁。 */
export function assertMbm004ReportSource(directory, env = process.env) {
  const { git, text, head } = currentMbm004Git(directory, env);
  const parents = text(['rev-list', '--parents', '-n', '1', head]).split(' ');
  if (parents.length !== 2 || parents[0] !== head) fail('MBM004_REPORT_DIRECT_PARENT_REQUIRED');
  const parent = parents[1], source = sourceGitObject(git, text, parent);
  const scopeBytes = readLocalLibraryFixWhole(path.join(directory, MBM004_SCOPE_PATH));
  if (!scopeBytes.equals(source.scopeBytes) || !git(['show', head + ':' + MBM004_SCOPE_PATH]).equals(source.scopeBytes))
    fail('MBM004_REPORT_SOURCE_SCOPE_CHANGED');
  if (source.correction) {
    const bytes = git(['show', parent + ':' + MBM004_CORRECTION_PATH]);
    if (!readLocalLibraryFixWhole(path.join(directory, MBM004_CORRECTION_PATH)).equals(bytes)
      || !git(['show', head + ':' + MBM004_CORRECTION_PATH]).equals(bytes)
      || text(['ls-tree', head, '--', MBM004_CORRECTION_PATH]).split(' ')[0] !== '100644')
      fail('MBM004_REPORT_SOURCE_CORRECTION_CHANGED');
  }
  assertGitStillCurrent(text, head);
  return Object.freeze({ reportSha: head, parentSourceSha: parent, scopeSha256: digest(source.scopeBytes),
    exactFiles: source.scope.files.length, currentSourceCiRequired: true });
}
export function inspectMbm004Admission(directory = root, env = process.env) {
  const { git, text, head, branch } = currentMbm004Git(directory, env);
  const { scope, scopeBytes, correction, canonicalBytes } = sourceGitObject(git, text, head);
  for (const row of scope.files) {
    const file = path.join(directory, row.path), bytes = readLocalLibraryFixWhole(file);
    if (lstatSync(file).isSymbolicLink() || bytes.length !== row.bytes || digest(bytes) !== row.sha256
      || !git(['show', head + ':' + row.path]).equals(bytes)) fail('MBM004_FILE_PIN_CHANGED');
  }
  if (!readLocalLibraryFixWhole(path.join(directory, MBM004_CANONICAL.path)).equals(canonicalBytes)
    || !readLocalLibraryFixWhole(path.join(directory, MBM004_SCOPE_PATH)).equals(scopeBytes)) fail('MBM004_ADMISSION_DRIFT');
  assertGitStillCurrent(text, head);
  const result = Object.freeze({ schema: 'musicbridge.mbm004.admission.v1', task: MBM004_TASK, branch,
    baseSha: MBM004_BASE, headAtAdmission: head, scopeSha256: digest(scopeBytes), exactFiles: scope.files.length,
    ...(correction ? { predecessorSource: correction.predecessorSource, sourceCorrection: MBM004_CORRECTION_PATH } : {}),
    oldGateEvidenceReused: true, currentSoftwareGateRequired: true, currentAppDeviceOwnerProven: false });
  accepted.add(result); return result;
}
