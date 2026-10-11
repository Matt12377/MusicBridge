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
function allowed(file) {
  return metadata.includes(file) || sharedProducts.has(file) || sharedCi.has(file) || localFormatTests.has(file)
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
  return scope;
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
export function inspectMbm004Admission(directory = root, env = process.env) {
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
  const record = parse(readLocalLibraryFixWhole(path.join(directory, MBM004_STATUS_PATH)));
  if (record.task !== MBM004_TASK || record.baseSha !== MBM004_BASE || record.branch !== MBM004_BRANCH) fail('MBM004_TASK_RECORD_INVALID');
  const scopeBytes = readLocalLibraryFixWhole(path.join(directory, MBM004_SCOPE_PATH));
  const scope = validateMbm004Scope(parse(scopeBytes));
  const status = parse(readLocalLibraryFixWhole(path.join(directory, metadata[0]))), plan = parse(readLocalLibraryFixWhole(path.join(directory, metadata[1])));
  assertMbm004Metadata(status, plan);
  assertMbm004PredecessorMetadata(parse(git(['show', MBM004_BASE + ':' + metadata[0]])), status,
    parse(git(['show', MBM004_BASE + ':' + metadata[1]])), plan);
  const parents = text(['rev-list', '--parents', '-n', '1', head]).split(' ');
  if (parents.length !== 2 || parents[1] !== MBM004_BASE) fail('MBM004_SOURCE_DIRECT_PARENT_REQUIRED');
  const diff = text(['diff', '--name-status', '--no-renames', MBM004_BASE, head]).split('\n').map(line => line.split('\t'));
  const expected = scope.files.map(row => [row.status, row.path]).concat([['A', MBM004_SCOPE_PATH]]);
  if (!equal(diff.sort((a, b) => a[1].localeCompare(b[1])), expected.sort((a, b) => a[1].localeCompare(b[1])))) fail('MBM004_SOURCE_PATH_SET_CHANGED');
  for (const row of scope.files) {
    const file = path.join(directory, row.path), bytes = readLocalLibraryFixWhole(file);
    if (lstatSync(file).isSymbolicLink() || bytes.length !== row.bytes || digest(bytes) !== row.sha256
      || !git(['show', head + ':' + row.path]).equals(bytes)
      || text(['ls-tree', head, '--', row.path]).split(' ')[0] !== '100644') fail('MBM004_FILE_PIN_CHANGED');
  }
  const canonicalBytes = readLocalLibraryFixWhole(path.join(directory, MBM004_CANONICAL.path));
  if (canonicalBytes.length !== MBM004_CANONICAL.bytes || digest(canonicalBytes) !== MBM004_CANONICAL.sha256
    || !git(['show', MBM004_BASE + ':' + MBM004_CANONICAL.path]).equals(canonicalBytes)) fail('MBM004_CANONICAL_CHANGED');
  if (!git(['show', head + ':' + MBM004_SCOPE_PATH]).equals(scopeBytes) || text(['rev-parse', 'HEAD']) !== head
    || text(['status', '--porcelain=v1', '--untracked-files=all'])) fail('MBM004_ADMISSION_DRIFT');
  const result = Object.freeze({ schema: 'musicbridge.mbm004.admission.v1', task: MBM004_TASK, branch,
    baseSha: MBM004_BASE, headAtAdmission: head, scopeSha256: digest(scopeBytes), exactFiles: scope.files.length,
    oldGateEvidenceReused: true, currentSoftwareGateRequired: true, currentAppDeviceOwnerProven: false });
  accepted.add(result); return result;
}
