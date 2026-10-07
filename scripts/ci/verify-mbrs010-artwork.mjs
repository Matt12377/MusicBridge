import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPrivateRun, isCompleteTestRun, parseTestCounts, sanitizeOutput, validateOfflineArguments, writePrivateJson } from './verify-mbrs001-offline.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gateFile = 'scripts/ci/verify-mbrs010-artwork.mjs';
const scopeFile = 'docs/postrust/MBRS-010/EXECUTION_SCOPE.json';
const g0File = 'docs/postrust/RUST-016/ADMISSION_DECISION.json';
const taskboardFile = 'docs/postrust/MBRS-000/PACK_TASKBOARD.json';
const acceptanceFile = 'docs/postrust/MBRS-000/PACK_ACCEPTANCE.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = code => { const error = new Error('010封面受控软件Gate未准入或未完整通过。'); error.code = code; throw error; };
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
export const ARTWORK_BASE_SHA = '0a9c211805cdaecf56c699fe0c264590a0839e0e';
export const ARTWORK_TASK_SPEC = freeze({ path: 'tasks/MBRS-010_ARTWORK_SELECTION_CACHE.md', bytes: 3100,
  sha256: 'e84c34ac3d1fc067d803cf7db2476df8ae2c1d3a9077d1419fcfedb622669a2e' });
const originalTaskboardSha = 'b26a933bc7ef84a80c32f417a6a39af9386c6e35f9af9a87c6bc01f6c2a8deec';
const originalAcceptanceSha = '19edef0a2a16c8516517d1262396414e25569898e6eb40d58fb1b2032c2d75a4';

// 数量来自本轮逐文件真实结果；不能由运行者改参数、缩清单或删skip后补尾码。
export const ARTWORK_TESTS = freeze([
  { name: 'contracts-artwork', directory: 'packages/contracts', tests: ['test/local-artwork.test.ts'], expectedTests: 5 },
  { name: 'core-artwork-rules', directory: 'packages/bridge-core', tests: ['test/artwork-selection-rules.test.ts'], expectedTests: 16 },
  { name: 'core-artwork-embedded', directory: 'packages/bridge-core', tests: ['test/local-artwork-embedded-reader.test.ts'], expectedTests: 17 },
  { name: 'core-artwork-store', directory: 'packages/bridge-core', tests: ['test/local-artwork-store.test.ts'], expectedTests: 10 },
  { name: 'core-artwork-service', directory: 'packages/bridge-core', tests: ['test/local-artwork-service.test.ts'], expectedTests: 12 },
  { name: 'core-artwork-dispatch', directory: 'packages/bridge-core', tests: ['test/local-artwork-dispatch.test.ts'], expectedTests: 3 },
  { name: 'desktop-artwork-image', directory: 'apps/desktop', tests: ['test/local-artwork-image.test.ts'], expectedTests: 28 },
  { name: 'desktop-artwork-client', directory: 'apps/desktop', tests: ['test/local-artwork-client.test.ts'], expectedTests: 3 },
  { name: 'desktop-artwork-ipc', directory: 'apps/desktop', tests: ['test/local-artwork-ipc.test.ts'], expectedTests: 5 },
  { name: 'desktop-artwork-state', directory: 'apps/desktop', tests: ['test/local-artwork-state.test.ts'], expectedTests: 33 },
  { name: 'desktop-artwork-commons', directory: 'apps/desktop', tests: ['test/commons-artwork-provider.test.ts'], expectedTests: 34 },
  { name: 'desktop-artwork-music', directory: 'apps/desktop', tests: ['test/music-cover-art-provider.test.ts'], expectedTests: 18 },
]);
export const ARTWORK_EXPECTED_TESTS = 184;
export const ARTWORK_AT_MAPPING = freeze([
  { id: 'MBRS-AT-010-01', stages: ['core-artwork-rules', 'core-artwork-embedded', 'core-artwork-store', 'core-artwork-service', 'desktop-artwork-ipc'],
    boundary: '独立图/内嵌图/缺图与来源仅由自有合成文件、真实FD和SQLite验证；未读取Owner曲库。' },
  { id: 'MBRS-AT-010-02', stages: ['desktop-artwork-client', 'desktop-artwork-ipc', 'desktop-artwork-state', 'desktop-artwork-music', 'desktop-artwork-commons'],
    boundary: '状态会话与真实Vue模板内存SSR、MusicBrainz/CAA受控transport；Commons只是可选CC0补充图库，真实音乐发行搜索及App交互未运行。' },
  { id: 'MBRS-AT-010-03', stages: ['contracts-artwork', 'core-artwork-embedded', 'core-artwork-service', 'desktop-artwork-image', 'desktop-artwork-ipc', 'desktop-artwork-state', 'desktop-artwork-commons', 'desktop-artwork-music'],
    boundary: '图像结构、fake codec、DNS/HTTPS受控桩、资源收口与取消围栏；native codec独立Gate和真实站点网络证据不能由此替代。' },
  { id: 'MBRS-AT-010-04', stages: ['core-artwork-store', 'core-artwork-service', 'core-artwork-dispatch', 'desktop-artwork-image', 'desktop-artwork-ipc', 'desktop-artwork-state'],
    boundary: '自有合成源字节保留、staging/apply/Outbox分离；原文件写回OFF，Organizer独立计划确认和实际写回均未运行。' },
  { id: 'MBRS-AT-010-05', stages: ['contracts-artwork', 'core-artwork-rules', 'core-artwork-store', 'desktop-artwork-state'],
    boundary: '图片Hash不充当发行身份/自动合并或音质真实性；不把规则测试当真实音质或听感证据。' },
  { id: 'MBRS-AT-010-06', stages: ['core-artwork-service', 'desktop-artwork-ipc', 'desktop-artwork-state'],
    boundary: '媒体忙准入、FD quiet与封面失败不派发播放/写回接口的受控证据；当前及新真实直送、Roon收图和听感单列NOT_RUN。' },
  { id: 'MBRS-AT-010-07', stages: ['contracts-artwork', 'core-artwork-rules', 'core-artwork-store'],
    boundary: '数字发行、磁带参考图、个人照片和冻结MasterArtwork用途/身份的规则及SQLite边界；不替代真实资料和冻结成品Owner验收。' },
]);

export const ARTWORK_EVIDENCE_POLICY = freeze({
  scope: 'CONTROLLED_NODE_SOFTWARE_SYNTHETIC_FD_SQLITE_FAKE_PROVIDER_CODEC_AND_VUE_SSR',
  sourceIdentityScope: 'DECLARED_PRODUCT_AND_TEST_SOURCES_AND_FRESH_COMPILER_OUTPUTS_NOT_TRANSITIVE_DEPENDENCY_CLOSURE',
  sourceFilesWrite: 'OFF_EXCEPT_SELF_SYNTHETIC_FIXTURES_AND_COMPILER_OUTPUTS',
  fullRealAudioHash: 'NOT_RUN', realAccounts: 'NOT_RUN', realLibrary: 'NOT_RUN', actualAppInteraction: 'NOT_RUN',
  realMusicBrainzReleaseSearch: 'NOT_RUN', realCoverArtArchiveImages: 'NOT_RUN', realCommonsSearch: 'NOT_RUN',
  commonsRole: 'OPTIONAL_CC0_SUPPLEMENT_NOT_MUSIC_RELEASE_SEARCH', nativeCodec: 'SEPARATE_GATE_NOT_EVALUATED_HERE',
  roonArtworkDelivery: 'NOT_RUN', currentAndNewRealDirectPlayback: 'NOT_RUN', ownerAcceptance: 'NOT_RUN', listening: 'NOT_RUN',
  sourceFileWritebackOrganizerPlan: 'NOT_RUN', taskCompletion: 'NOT_DECIDED_BY_THIS_SOFTWARE_GATE',
  originalTaskCount: 18, originalAcceptanceCount: 156, taskAcceptanceCount: 7,
  new100k300kStarted: false, oldMbrs003AttemptBudgetReused: false,
  networkPolicy: 'TEST_CHILD_NODE_TCP_TLS_DNS_HTTP_FETCH_DENIED_NOT_AN_OS_SANDBOX_CLAIM',
});

/** 原始包摘要独立固定；只检查已有G0记录，不凭结构测试创造授权。 */
export function assertArtworkAdmission(scope, taskBytes, taskboardBytes, acceptanceBytes, g0) {
  if (scope?.schema !== 'mbrs010.execution-scope.v1' || scope.task !== 'MBRS-010' || scope.baseSha !== ARTWORK_BASE_SHA
    || scope.branch !== 'codex/mbrs-010-artwork-selection-cache' || scope.g0 !== 'ADMITTED_INHERITED_PHASE_HANDOFF'
    || scope.g0Ref !== g0File || scope.sourceFilesWrite !== 'OFF' || scope.defaultCore !== 'Node' || scope.optionalRustReadonly !== 'OFF'
    || scope.realProviderAccountRoonAudioOwner !== 'NOT_RUN' || scope.originalTaskCount !== 18
    || scope.originalAcceptanceCount !== 156 || scope.taskAcceptanceCount !== 7) reject('ARTWORK_EXECUTION_SCOPE_INVALID');
  if (scope.taskSpec?.path !== ARTWORK_TASK_SPEC.path || scope.taskSpec.bytes !== ARTWORK_TASK_SPEC.bytes
    || scope.taskSpec.sha256 !== ARTWORK_TASK_SPEC.sha256 || taskBytes.length !== ARTWORK_TASK_SPEC.bytes
    || hash(taskBytes) !== ARTWORK_TASK_SPEC.sha256) reject('ARTWORK_ORIGINAL_TASK_IDENTITY');
  if (scope.predecessorFinalSeal?.archiveId !== 'MBRS009_FINAL_DELIVERY_RECEIPT' || scope.predecessorFinalSeal.bytes !== 6839
    || scope.predecessorFinalSeal.sha256 !== '788c337dc8e1265c823eceb08b857d869d03f914ddc87b7c5b091d33f209629b') reject('ARTWORK_PREDECESSOR_SEAL_IDENTITY');
  if (g0?.kind !== 'HANDOFF_RECORD_NOT_AUTHORIZATION' || g0.is_synthetic !== false || g0.decision !== 'ADMITTED'
    || g0.mode !== 'EXPLICIT_PHASE_HANDOFF' || g0.full_rust_migration_completed !== false
    || !Array.isArray(g0.exit_items) || g0.exit_items.length === 0 || g0.exit_items.some(item => item.required_for_admission && item.status !== 'PASS')
    || !Array.isArray(g0.component_owners)) reject('ARTWORK_G0_RECORD_INVALID');
  const owners = g0.component_owners.filter(owner => owner.database_id === 'owned-dataset-sqlite');
  if (owners.length !== 1 || owners[0].writer_id !== 'node-dataset-owner-worker'
    || g0.component_owners.some(owner => owner.language === 'Rust' && (owner.writer_id !== null || owner.database_id !== null))) reject('ARTWORK_DATABASE_OWNER_INVALID');
  if (hash(taskboardBytes) !== originalTaskboardSha || hash(acceptanceBytes) !== originalAcceptanceSha) reject('ARTWORK_ORIGINAL_PACK_IDENTITY');
  const board = JSON.parse(taskboardBytes.toString('utf8')), acceptance = JSON.parse(acceptanceBytes.toString('utf8'));
  if (board.tasks?.length !== 18 || new Set(board.tasks.map(item => item.id)).size !== 18 || acceptance.cases?.length !== 156
    || new Set(acceptance.cases.map(item => item.id)).size !== 156) reject('ARTWORK_ORIGINAL_PACK_COUNTS');
  const task = board.tasks.find(item => item.id === 'MBRS-010'), cases = acceptance.cases.filter(item => item.task === 'MBRS-010');
  const ids = ARTWORK_AT_MAPPING.map(item => item.id);
  if (!task || JSON.stringify(task.depends_on) !== JSON.stringify(['MBRS-009', 'MBRS-004'])
    || JSON.stringify(task.acceptance_ids) !== JSON.stringify(ids) || JSON.stringify(cases.map(item => item.id)) !== JSON.stringify(ids)) reject('ARTWORK_ORIGINAL_AT_MAPPING');
  return cases;
}

export function assertArtworkTestInventory(discovered) {
  const fixed = ARTWORK_TESTS.flatMap(group => group.tests.map(test => `${group.directory}/${test}`)).sort();
  if (!Array.isArray(discovered) || discovered.some(file => typeof file !== 'string') || new Set(discovered).size !== discovered.length
    || JSON.stringify([...discovered].sort()) !== JSON.stringify(fixed) || fixed.length !== 12
    || ARTWORK_TESTS.reduce((total, item) => total + item.expectedTests, 0) !== ARTWORK_EXPECTED_TESTS) reject('ARTWORK_TEST_INVENTORY_MISMATCH');
  return ARTWORK_TESTS;
}

export function artworkStageEvaluation(result, raw, expectedTests = null) {
  const counts = expectedTests === null ? null : parseTestCounts(raw);
  const tapStatusesClean = expectedTests === null ? null : !/^\s*not ok \d+\b/mu.test(raw)
    && !/^\s*(?:not ok|ok) \d+\b[^\r\n]*#\s*(?:SKIP|TODO)\b/imu.test(raw);
  const testSummaryValid = expectedTests === null ? null : isCompleteTestRun(counts, expectedTests) && tapStatusesClean;
  const success = result.exitCode === 0 && result.signal === null && result.closeObserved === true
    && ['timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].every(key => result[key] === false)
    && (expectedTests === null || testSummaryValid);
  return { testCounts: counts, tapStatusesClean, testSummaryValid, success };
}

/** CLI始终用固定stage；可导出capture供入口测试运行自有Node桩，不能经参数替换正式清单。 */
export async function captureArtworkStage(stage, { run, directory = repository, env = process.env, limitMs = 180_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!/^[a-z][a-z0-9-]{1,60}$/u.test(stage.name) || !Number.isSafeInteger(limitMs) || limitMs <= 0 || limitMs > 180_000
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 4 * 1024 * 1024) reject('ARTWORK_CAPTURE_PARAMETERS_INVALID');
  const started = performance.now(), result = { name: stage.name, directory: stage.directory, expectedTests: stage.expectedTests ?? null,
    argv: ['node', ...(stage.displayArgs ?? stage.args)], startedAt: new Date().toISOString(), startedMs: Date.now(), limitMs,
    exitCode: null, signal: null, closeObserved: false, timedOut: false, overflow: false, captureFailed: false,
    preparationFailed: false, groupTerminationFailed: false, processIsolation: 'OWNED_POSIX_PROCESS_GROUP' };
  const chunks = []; let length = 0, child, timer, terminated = false;
  const terminate = () => {
    if (terminated || !child?.pid) return;
    terminated = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') result.groupTerminationFailed = true; }
  };
  await new Promise(resolve => {
    try { child = spawn(process.execPath, stage.args, { cwd: path.join(directory, stage.directory), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { result.preparationFailed = true; resolve(); return; }
    child.once('close', (code, signal) => { clearTimeout(timer); result.exitCode = code; result.signal = signal; result.closeObserved = true; resolve(); });
    child.once('error', () => { result.preparationFailed = true; terminate(); });
    const append = bytes => {
      if (result.overflow || result.captureFailed) return;
      try {
        if (length + bytes.length > maxBytes) { result.overflow = true; terminate(); return; }
        chunks.push(Buffer.from(bytes)); length += bytes.length;
      } catch { result.captureFailed = true; terminate(); }
    };
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', append); stream.once('error', () => { result.captureFailed = true; terminate(); }); }
    timer = setTimeout(() => { result.timedOut = true; terminate(); }, limitMs);
  });
  const bytes = Buffer.concat(chunks), raw = bytes.toString('utf8'), safe = sanitizeOutput(raw);
  Object.assign(result, artworkStageEvaluation(result, raw, result.expectedTests), { capturedRawSha256: hash(bytes), rawDiagnosticBytes: bytes.length,
    rawCaptureScope: 'BOUNDED_STDOUT_STDERR_OBSERVED_ARRIVAL_BYTES', diagnosticsPolicy: 'ALLOWLIST_STATUS_COUNTS_ONLY',
    captureCompletedAt: new Date().toISOString(), durationMs: performance.now() - started, log: `${stage.name}.log`, logSha256: hash(safe) });
  writeFileSync(path.join(run, result.log), safe, { flag: 'wx', mode: 0o600 });
  writePrivateJson(run, `${stage.name}.json`, result);
  return result;
}

function readInput(relative, check = () => {}) {
  check(); const file = path.join(repository, relative), info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(file) !== file) reject('ARTWORK_INPUT_NOT_REGULAR');
  const bytes = readFileSync(file); check(); return { path: relative, bytes: bytes.length, sha256: hash(bytes) };
}
function testInventory() {
  const names = [];
  for (const directory of ['packages/contracts', 'packages/bridge-core', 'apps/desktop']) {
    for (const name of readdirSync(path.join(repository, directory, 'test')).sort()) {
      if (/^(?:local-artwork(?:-[a-z-]+)?|artwork-selection-rules|commons-artwork-provider|music-cover-art-provider)\.test\.ts$/u.test(name)) {
        const relative = `${directory}/test/${name}`; readInput(relative); names.push(relative);
      }
    }
  }
  return names;
}
function sourceIdentity(check) {
  const names = new Set();
  const walk = relative => {
    check(); const info = lstatSync(path.join(repository, relative));
    if (info.isSymbolicLink()) reject('ARTWORK_SOURCE_SYMLINK');
    if (info.isDirectory()) for (const item of readdirSync(path.join(repository, relative)).sort()) walk(`${relative}/${item}`);
    else if (info.isFile() && /\.(?:[cm]?js|ts|vue|css|json)$/u.test(relative)) names.add(relative);
  };
  for (const directory of ['packages/contracts', 'packages/bridge-core', 'apps/desktop']) {
    walk(`${directory}/src`); walk(`${directory}/test`);
    for (const file of ['package.json', 'tsconfig.json', ...(directory === 'apps/desktop' ? [] : ['tsconfig.test.json'])]) names.add(`${directory}/${file}`);
  }
  for (const file of [gateFile, 'scripts/ci/test/verify-mbrs010-artwork.test.mjs', 'scripts/ci/verify-mbrs001-offline.mjs',
    'apps/desktop/scripts/build-storage-root.mjs', 'apps/desktop/scripts/build-storage-root.d.mts', 'apps/desktop/electron.vite.config.ts',
    scopeFile, g0File, taskboardFile, acceptanceFile, ARTWORK_TASK_SPEC.path, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) names.add(file);
  return [...names].sort().map(file => readInput(file, check));
}

// 仅测试child预加载此分支；真实TCP/TLS/DNS及fetch被拒，测试仍可替换受控transport或HTTPS桩。
function installOfflineGuard() {
  const require = createRequire(import.meta.url);
  const denied = () => reject('ARTWORK_NETWORK_FORBIDDEN');
  for (const [name, methods] of [['net', ['connect', 'createConnection']], ['tls', ['connect']], ['http', ['request', 'get']], ['https', ['request', 'get']]]) {
    const module = require(`node:${name}`); for (const method of methods) module[method] = denied;
  }
  const net = require('node:net'); net.Socket.prototype.connect = denied; net.Server.prototype.listen = denied;
  for (const name of ['dns', 'dns/promises']) {
    const module = require(`node:${name}`);
    for (const method of Object.keys(module).filter(key => /^(?:lookup|resolve|reverse)/u.test(key))) if (typeof module[method] === 'function') module[method] = denied;
    for (const method of Object.getOwnPropertyNames(module.Resolver.prototype).filter(key => /^(?:resolve|reverse)/u.test(key))) module.Resolver.prototype[method] = denied;
  }
  const dgram = require('node:dgram'); for (const method of ['bind', 'connect', 'send']) dgram.Socket.prototype[method] = denied;
  globalThis.fetch = async () => denied();
  if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = class { constructor() { denied(); } };
  syncBuiltinESMExports();
}

export async function runArtworkGate(argv = process.argv.slice(2), env = process.env) {
  const started = performance.now(), startedAt = new Date().toISOString(), totalLimitMs = 360_000;
  const remaining = () => totalLimitMs - (performance.now() - started);
  const check = () => { if (remaining() <= 0) reject('ARTWORK_TOTAL_BUDGET_EXHAUSTED'); };
  // 全部flags/外置或Hosted存储、Node和原任务身份均在首mkdir/child前准入。
  const admission = validateOfflineArguments(argv, env);
  if (process.versions.node.split('.')[0] !== '22') reject('ARTWORK_NODE22_REQUIRED');
  const git = args => { check(); const result = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); check(); return result.trim(); };
  git(['merge-base', '--is-ancestor', ARTWORK_BASE_SHA, 'HEAD']);
  const gitHead = git(['rev-parse', 'HEAD']); if (!/^[a-f0-9]{40}$/u.test(gitHead)) reject('ARTWORK_HEAD_INVALID');
  const scope = JSON.parse(readFileSync(path.join(repository, scopeFile), 'utf8'));
  const cases = assertArtworkAdmission(scope, readFileSync(path.join(repository, ARTWORK_TASK_SPEC.path)), readFileSync(path.join(repository, taskboardFile)),
    readFileSync(path.join(repository, acceptanceFile)), JSON.parse(readFileSync(path.join(repository, g0File), 'utf8')));
  assertArtworkTestInventory(testInventory());
  const inputs = sourceIdentity(check), inputDigest = hash(JSON.stringify(inputs));
  const coreRequire = createRequire(path.join(repository, 'packages/bridge-core/package.json'));
  const desktopRequire = createRequire(path.join(repository, 'apps/desktop/package.json'));
  const tsc = coreRequire.resolve('typescript/bin/tsc'), vueTsc = desktopRequire.resolve('vue-tsc/bin/vue-tsc.js');
  const tools = [['typescript', coreRequire, '5.9.3'], ['tsx', coreRequire, '4.23.12'], ['vue-tsc', desktopRequire, '3.0.6'], ['vue', desktopRequire, '3.5.42']];
  const toolFiles = new Set([tsc, vueTsc]);
  for (const [name, require, version] of tools) {
    const packageFile = require.resolve(`${name}/package.json`);
    if (JSON.parse(readFileSync(packageFile, 'utf8')).version !== version) reject('ARTWORK_TOOL_VERSION_MISMATCH');
    toolFiles.add(packageFile); toolFiles.add(require.resolve(name === 'typescript' ? 'typescript/lib/typescript.js' : name));
  }
  for (const filename of ['tsc.js', '_tsc.js']) toolFiles.add(path.join(path.dirname(coreRequire.resolve('typescript/package.json')), 'lib', filename));
  const toolIdentity = () => [...toolFiles].map(file => { check(); const full = realpathSync(file), bytes = readFileSync(full); return { file: path.relative(repository, full), bytes: bytes.length, sha256: hash(bytes) }; });
  const toolInputs = toolIdentity(), toolDigest = hash(JSON.stringify(toolInputs));
  for (const directory of ['packages/contracts', 'packages/bridge-core']) {
    const config = JSON.parse(readFileSync(path.join(repository, directory, 'tsconfig.json'), 'utf8'));
    if (config.compilerOptions?.incremental || config.compilerOptions?.composite || config.compilerOptions?.noEmit
      || config.compilerOptions?.declaration !== true || config.compilerOptions?.sourceMap !== true || config.extends !== undefined) reject('ARTWORK_FRESH_COMPILER_CONFIG_INVALID');
    admission.storage.check(path.join(repository, directory, 'dist'));
  }
  const assertInputs = () => {
    if (git(['rev-parse', 'HEAD']) !== gitHead || hash(JSON.stringify(sourceIdentity(check))) !== inputDigest) reject('ARTWORK_SOURCE_OR_HEAD_DRIFT');
    if (hash(JSON.stringify(toolIdentity())) !== toolDigest) reject('ARTWORK_TOOL_DRIFT');
  };
  const offlineImport = pathToFileURL(path.join(repository, gateFile)).href + '#artwork-offline';
  const stages = [
    { name: 'fresh-contracts-build', directory: 'packages/contracts', args: [tsc, '-p', 'tsconfig.json'], displayArgs: ['typescript/bin/tsc', '-p', 'tsconfig.json'] },
    { name: 'contracts-types', directory: 'packages/contracts', args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'], displayArgs: ['typescript/bin/tsc', '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'fresh-core-build', directory: 'packages/bridge-core', args: [tsc, '-p', 'tsconfig.json'], displayArgs: ['typescript/bin/tsc', '-p', 'tsconfig.json'] },
    { name: 'core-types', directory: 'packages/bridge-core', args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'], displayArgs: ['typescript/bin/tsc', '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'desktop-types', directory: 'apps/desktop', args: [vueTsc, '-p', 'tsconfig.json', '--noEmit'], displayArgs: ['vue-tsc/bin/vue-tsc.js', '-p', 'tsconfig.json', '--noEmit'] },
    ...ARTWORK_TESTS.map(group => ({ ...group, args: ['--import', offlineImport, '--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...group.tests],
      displayArgs: ['--import', '<gate>#artwork-offline', '--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...group.tests] })),
  ];
  assertInputs();
  const run = createPrivateRun(admission), tmp = path.join(run, 'tmp'); mkdirSync(tmp, { mode: 0o700 });
  const childEnv = { ...env, TMPDIR: tmp, NODE_ENV: 'test', COREPACK_ENABLE_NETWORK: '0', npm_config_ignore_scripts: 'true' };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH']) delete childEnv[name];
  const runs = [], freshOutputs = [], receiptInputs = [], failures = [];
  const fail = code => { if (!failures.includes(code)) failures.push(code); };
  const captureReceipt = filename => { const full = path.join(run, filename), info = lstatSync(full), bytes = readFileSync(full);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) reject('ARTWORK_PRIVATE_RECEIPT_INVALID');
    receiptInputs.push({ file: filename, bytes: bytes.length, sha256: hash(bytes) }); };
  writePrivateJson(run, 'precompile-inputs.json', { schema: 'mbrs010.artwork-precompile-inputs.v1', gitHead, sourceInputs: inputs, toolInputs, inputDigest }); captureReceipt('precompile-inputs.json');
  let inputsUnchanged = false, outputsUnchanged = false, receiptsUnchanged = false;
  try {
    for (const stage of stages) {
      check(); assertInputs(); admission.storage.check(tmp, { mustExist: true });
      const result = await captureArtworkStage(stage, { run, env: childEnv, limitMs: Math.max(1, Math.floor(Math.min(180_000, remaining()))) });
      runs.push(result); captureReceipt(result.log); captureReceipt(`${result.name}.json`);
      if (!result.success) { fail(result.timedOut ? 'ARTWORK_STAGE_TIMEOUT' : 'ARTWORK_STAGE_FAILED_OR_INCOMPLETE'); break; }
      assertInputs();
      if (stage.name.startsWith('fresh-')) {
        const sources = inputs.filter(input => input.path.startsWith(`${stage.directory}/src/`) && input.path.endsWith('.ts') && !input.path.endsWith('.d.ts'));
        if (sources.length === 0) reject('ARTWORK_COMPILER_SOURCES_MISSING');
        for (const source of sources) for (const extension of ['.js', '.js.map', '.d.ts']) {
          const relative = source.path.replace('/src/', '/dist/').slice(0, -3) + extension;
          admission.storage.check(path.join(repository, relative), { mustExist: true, kind: 'file' });
          const output = readInput(relative, check), info = lstatSync(path.join(repository, relative));
          if (info.mtimeMs < result.startedMs - 1 || info.mtimeMs > Date.parse(result.captureCompletedAt) + 1) reject('ARTWORK_COMPILER_OUTPUT_NOT_FRESH');
          freshOutputs.push({ ...output, producer: stage.name, sourcePath: source.path, sourceSha256: source.sha256, mtimeMs: info.mtimeMs });
        }
      }
    }
    assertInputs(); inputsUnchanged = true;
    outputsUnchanged = runs.filter(result => result.name.startsWith('fresh-') && result.success).length === 2 && freshOutputs.length > 0
      && new Set(freshOutputs.map(output => output.path)).size === freshOutputs.length && freshOutputs.every(output => {
        const current = readInput(output.path, check); return current.bytes === output.bytes && current.sha256 === output.sha256
          && lstatSync(path.join(repository, output.path)).mtimeMs === output.mtimeMs;
      });
    receiptsUnchanged = receiptInputs.length === 1 + runs.length * 2 && receiptInputs.every(row => {
      check(); const full = path.join(run, row.file), info = lstatSync(full), bytes = readFileSync(full);
      return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && bytes.length === row.bytes && hash(bytes) === row.sha256;
    });
  } catch (error) { fail(typeof error?.code === 'string' && /^ARTWORK_[A-Z_]+$/u.test(error.code) ? error.code : 'ARTWORK_EXECUTION_OR_CAPTURE_FAILED'); }
  if (runs.length !== stages.length) fail('ARTWORK_STAGES_INCOMPLETE');
  if (!inputsUnchanged) fail('ARTWORK_INPUTS_UNVERIFIED'); if (!outputsUnchanged) fail('ARTWORK_OUTPUTS_UNVERIFIED'); if (!receiptsUnchanged) fail('ARTWORK_RECEIPTS_UNVERIFIED');
  if (remaining() <= 0) fail('ARTWORK_TOTAL_BUDGET_EXHAUSTED');
  const tests = runs.filter(result => result.expectedTests !== null);
  const testsComplete = tests.length === 12 && tests.every(result => result.success)
    && tests.reduce((total, result) => total + (result.testCounts?.tests ?? 0), 0) === ARTWORK_EXPECTED_TESTS;
  if (!testsComplete) fail('ARTWORK_184_TESTS_INCOMPLETE');
  const success = failures.length === 0 && runs.every(result => result.success);
  const atEvidence = ARTWORK_AT_MAPPING.map(mapping => { const original = cases.find(item => item.id === mapping.id); return {
    id: mapping.id, kind: original.kind, introducedIn: original.introduced_in, requirement: original.requirement,
    acceptanceStatus: 'NOT_EVALUATED_BY_SOFTWARE_GATE', controlledSoftwareStatus: success && mapping.stages.every(name => runs.some(result => result.name === name && result.success)) ? 'PASS' : 'NOT_PASSED',
    stages: mapping.stages, boundary: mapping.boundary, appStatus: 'NOT_RUN', liveStatus: 'NOT_RUN', ownerStatus: 'NOT_RUN' }; });
  writePrivateJson(run, 'manifest.json', { schema: 'mbrs010.artwork-gate.v1', startedAt, completedAt: new Date().toISOString(), success, failures,
    baseSha: ARTWORK_BASE_SHA, gitHead, originalTaskSpec: ARTWORK_TASK_SPEC, sourceInputs: inputs, toolInputs, inputDigest, inputsUnchanged,
    freshOutputs, outputsUnchanged, receiptInputs, receiptsUnchanged, runs, expectedTestFiles: 12, expectedTests: ARTWORK_EXPECTED_TESTS, testsComplete, atEvidence,
    gateBudget: { totalLimitMs, stageLimitMs: 180_000, elapsedMs: performance.now() - started, clock: 'MONOTONIC_PERFORMANCE' },
    evidencePolicy: ARTWORK_EVIDENCE_POLICY });
  return success ? 0 : 1;
}

if (new URL(import.meta.url).hash === '#artwork-offline') installOfflineGuard();
else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runArtworkGate().then(code => { process.exitCode = code; }).catch(() => {
    console.error('MBRS010封面受控软件Gate失败；准入、准备或私有收据未完成，详细值未公开。'); process.exitCode = 1;
  });
}
