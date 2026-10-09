import { normalizeMbm000LegacyEarlyProbe } from './mbm000-legacy-probe-normalization.mjs';
import { normalizeMbm001LegacyProbe } from './mbm001-legacy-probe-normalization.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseSha = 'b33357c09e6bded2b4c6c5acfcf7330e68366a5f';
const scopeFile = 'scripts/ci/mbrs014-compatibility-scope.json';
const packageRoots = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = code => { const error = new Error('014旧来源兼容Gate未准入。'); error.code = code; throw error; };
export const COMPATIBILITY_TASK_SPEC = Object.freeze({ path: 'tasks/MBRS-014_LEGACY_SOURCE_COMPATIBILITY.md', bytes: 3652,
  sha256: 'b1580020d041ef1bc535bc108f8c97adf8a024181d838ef207f943aeddd5526c' });
export const COMPATIBILITY_LEGACY_INPUTS = Object.freeze({ path: 'docs/postrust/MBRS-014/FROZEN_LEGACY_INPUTS.json', bytes: 9378,
  sha256: 'bce19486d23367ff8f9404e1a0f3e4e6d0e9f39fb0d8585f04f84877e2118910', files: 49 });
export const COMPATIBILITY_PRELOAD_EXTENSION = Object.freeze({ path: 'apps/desktop/test/preload.test.ts', bytes: 36786,
  sha256: '7e217790f0cf811b4629bee7de0749402ee56eebe161a1d15c8a1511a1c00fd3' });
export const COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION = Object.freeze({ path: 'apps/desktop/test/preload.test.ts', bytes: 37008,
  sha256: '8fb8b3daef9c1826e6794b02fbb524fdd08ed40f293e51459e4d11bfa95aa639' });
export const COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION = Object.freeze({ path: 'apps/desktop/test/preload.test.ts', bytes: 37035,
  sha256: '596e20ca190f0285d384f9038a80106cefd18761cc79056076692f5130837124' });
export const COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION = Object.freeze({ path: 'apps/desktop/test/mbrs011-organizer-ui.test.ts', bytes: 29493,
  sha256: '6dade2fa5ec73b2667ebd3eb0265296f820b2bc51bf0f4e8e8536a8fb8c2d099' });
export const COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION = Object.freeze({ path: 'apps/desktop/test/mbrs009-local-library-ui.test.ts', bytes: 26687,
  sha256: '414928f85d0e2dc4cd6df0b16b311243dc037ffc543acc1bfb404ee29e9d6e41' });
/** 固定旧断言、夹具和构造器字节，避免以改测试来消除兼容回归。 */
export function assertCompatibilityLegacyInputs(manifestBytes, readInput) {
  if (manifestBytes.length !== COMPATIBILITY_LEGACY_INPUTS.bytes || sha(manifestBytes) !== COMPATIBILITY_LEGACY_INPUTS.sha256)
    reject('COMPATIBILITY_LEGACY_MANIFEST_CHANGED');
  const manifest = JSON.parse(manifestBytes), names = new Set();
  if (manifest.schema !== 'mbrs014.frozen-legacy-verification-inputs.v1' || manifest.baseSha !== baseSha
    || !Array.isArray(manifest.files) || manifest.files.length !== COMPATIBILITY_LEGACY_INPUTS.files) reject('COMPATIBILITY_LEGACY_MANIFEST_INVALID');
  for (const input of manifest.files) {
    if (typeof input.path !== 'string' || !/^(?:packages\/(?:contracts|bridge-core)\/test|apps\/desktop\/(?:test|e2e))\/[A-Za-z0-9_./-]+$/u.test(input.path)
      || input.path.split('/').includes('..') || names.has(input.path) || !Number.isSafeInteger(input.bytes) || input.bytes < 1
      || !/^[a-f0-9]{64}$/u.test(input.sha256)) reject('COMPATIBILITY_LEGACY_MANIFEST_INVALID');
    names.add(input.path); let bytes;
    try { bytes = normalizeMbm000LegacyEarlyProbe(input.path, normalizeMbm001LegacyProbe(input.path, readInput(input.path))); }
    catch { reject('COMPATIBILITY_LEGACY_INPUT_CHANGED'); }
    const original = bytes.length === input.bytes && sha(bytes) === input.sha256;
    // 仅准014六名称、012七名称和013单方法的已核尾部增量；原assertion、loader、context次数逐字节保留。
    const additive = input.path === COMPATIBILITY_PRELOAD_EXTENSION.path
      && bytes.length === COMPATIBILITY_PRELOAD_EXTENSION.bytes && sha(bytes) === COMPATIBILITY_PRELOAD_EXTENSION.sha256;
    const sourceWritesAdditive = input.path === COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION.path
      && bytes.length === COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION.bytes && sha(bytes) === COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION.sha256;
    const relocationAdditive = input.path === COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION.path
      && bytes.length === COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION.bytes && sha(bytes) === COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION.sha256;
    // 013分别补原009/011装载器的真实ESM namespace两行；原夹具、全部业务断言和case数逐字保留。
    const relocationUiLoaderAdditive = input.path === COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION.path
      && bytes.length === COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION.bytes && sha(bytes) === COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION.sha256;
    const relocationLibraryLoaderAdditive = input.path === COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION.path
      && bytes.length === COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION.bytes && sha(bytes) === COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION.sha256;
    if (!original && !additive && !sourceWritesAdditive && !relocationAdditive && !relocationUiLoaderAdditive && !relocationLibraryLoaderAdditive) reject('COMPATIBILITY_LEGACY_INPUT_CHANGED');
  }
  return manifest.files;
}
export function assertCompatibilityAdmission(scope, taskBytes, boardBytes, acceptanceBytes, g0) {
  if (scope?.schema !== 'mbrs014.execution-scope.v1' || scope.task !== 'MBRS-014' || scope.baseSha !== baseSha
    || scope.branch !== 'codex/mbrs-014-legacy-source-compatibility' || scope.sourceFilesWrite !== 'OFF'
    || scope.defaultCore !== 'Node' || scope.optionalRustReadonly !== 'OFF' || scope.g0 !== 'ADMITTED_INHERITED_PHASE_HANDOFF'
    || scope.g0Ref !== 'docs/postrust/RUST-016/ADMISSION_DECISION.json' || scope.originalTaskCount !== 18
    || scope.originalAcceptanceCount !== 156 || scope.taskAcceptanceCount !== 8
    || JSON.stringify(scope.scheduling?.hardDependencies) !== JSON.stringify(['MBRS-002', 'MBRS-009'])
    || scope.effectiveTaskCount !== 17 || scope.effectiveAcceptanceCount !== 150 || scope.catalogSchema !== 34) reject('COMPATIBILITY_EXECUTION_SCOPE_INVALID');
  if (Object.keys(COMPATIBILITY_TASK_SPEC).some(key => scope.taskSpec?.[key] !== COMPATIBILITY_TASK_SPEC[key]) || taskBytes.length !== COMPATIBILITY_TASK_SPEC.bytes
    || sha(taskBytes) !== COMPATIBILITY_TASK_SPEC.sha256) reject('COMPATIBILITY_TASK_IDENTITY_INVALID');
  if (scope.predecessorFinalSeal?.archiveId !== 'MBRS011_FINAL_DELIVERY_RECEIPT' || scope.predecessorFinalSeal.bytes !== 12931
    || scope.predecessorFinalSeal.sha256 !== '43782a4de3caf7ff112f6120cf951a6e0c0a210f224cec3c03826521196d9b9d') reject('COMPATIBILITY_PREDECESSOR_IDENTITY_INVALID');
  if (g0?.kind !== 'HANDOFF_RECORD_NOT_AUTHORIZATION' || g0.is_synthetic !== false || g0.decision !== 'ADMITTED'
    || g0.mode !== 'EXPLICIT_PHASE_HANDOFF' || g0.full_rust_migration_completed !== false
    || !Array.isArray(g0.exit_items) || !g0.exit_items.length || g0.exit_items.some(x => x.required_for_admission && x.status !== 'PASS')
    || !Array.isArray(g0.component_owners)) reject('COMPATIBILITY_G0_INVALID');
  const owners = g0.component_owners.filter(owner => owner.database_id === 'owned-dataset-sqlite');
  if (owners.length !== 1 || owners[0].writer_id !== 'node-dataset-owner-worker'
    || g0.component_owners.some(owner => owner.language === 'Rust' && (owner.writer_id !== null || owner.database_id !== null))) reject('COMPATIBILITY_WRITER_INVALID');
  if (sha(boardBytes) !== 'b26a933bc7ef84a80c32f417a6a39af9386c6e35f9af9a87c6bc01f6c2a8deec'
    || sha(acceptanceBytes) !== '19edef0a2a16c8516517d1262396414e25569898e6eb40d58fb1b2032c2d75a4') reject('COMPATIBILITY_ORIGINAL_PACK_INVALID');
  const board = JSON.parse(boardBytes), acceptance = JSON.parse(acceptanceBytes), ids = Array.from({ length: 8 }, (_, i) => 'MBRS-AT-014-0' + (i + 1));
  const task = board.tasks?.find(t => t.id === 'MBRS-014'), cases = acceptance.cases?.filter(c => c.task === 'MBRS-014');
  if (board.tasks?.length !== 18 || acceptance.cases?.length !== 156 || !task || !cases
    || JSON.stringify(task.depends_on) !== JSON.stringify(['MBRS-002', 'MBRS-009']) || JSON.stringify(task.acceptance_ids) !== JSON.stringify(ids)
    || JSON.stringify(cases.map(c => c.id)) !== JSON.stringify(ids)) reject('COMPATIBILITY_ORIGINAL_AT_INVALID');
  return cases;
}
export const COMPATIBILITY_REGRESSION_TESTS = Object.freeze([
  'packages/contracts/test/validator.test.ts',
  'packages/contracts/test/mbrs002/local-catalog.test.ts',
  'packages/bridge-core/test/mbrs002/local-catalog-store.test.ts',
  'packages/bridge-core/test/mbrs002/local-catalog-restore.test.ts',
  'packages/bridge-core/test/mbrs002/local-catalog-nonempty-migration.test.ts',
  'packages/bridge-core/test/physical-links-coordinator.test.ts',
  'packages/bridge-core/test/source-evidence.test.ts',
  'packages/bridge-core/test/master-versions.test.ts',
  'packages/bridge-core/test/prepared-render.test.ts',
  'packages/bridge-core/test/execution-assets.test.ts',
  'packages/bridge-core/test/archive-transactions.test.ts',
  'packages/bridge-core/test/recording-print-store.test.ts',
  'packages/bridge-core/test/commercial-provenance.test.ts',
  'packages/bridge-core/test/reference-catalog-store.test.ts',
  'packages/bridge-core/test/mbrs005/locks.test.ts',
  'apps/desktop/test/command-outbox-service.test.ts',
  'apps/desktop/test/command-outbox-executor.test.ts',
  'apps/desktop/test/physical-link-history-fence.test.ts',
  'apps/desktop/test/physical-relation-request-fence.test.ts',
  'apps/desktop/test/mbrs009-local-library-session.test.ts',
  'apps/desktop/test/mbrs009-local-library-ui.test.ts',
  'apps/desktop/test/preload.test.ts',
]);
export function assertCompatibilityScope(scope, discovered) {
  if (scope?.schema !== 'mbrs014.compatibility-scope.v1' || scope.baseSha !== baseSha
    || scope.implementationComplete !== true || scope.countsConfirmed !== true
    || scope.sourceFilesWrite !== 'OFF' || !Array.isArray(scope.groups) || scope.groups.length !== 3)
    reject('COMPATIBILITY_SCOPE_NOT_FROZEN');
  const names = new Set(), directories = new Set(), all = [], task = [];
  for (const group of scope.groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name)
      || !packageRoots.includes(group.directory) || directories.has(group.directory)
      || !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0
      || !Array.isArray(group.tests) || group.tests.length === 0) reject('COMPATIBILITY_GROUP_INVALID');
    names.add(group.name); directories.add(group.directory);
    for (const test of group.tests) {
      const full = group.directory + '/' + test;
      const own = group.directory === 'apps/desktop'
        ? /^test\/(?:mbrs014-|mbrs014\/)[A-Za-z0-9_-]+\.test\.ts$/u.test(test)
        : /^test\/mbrs014\/[A-Za-z0-9_-]+\.test\.ts$/u.test(test);
      if (typeof test !== 'string' || !own && !COMPATIBILITY_REGRESSION_TESTS.includes(full)) reject('COMPATIBILITY_TEST_PATH_INVALID');
      all.push(full); if (own) task.push(full);
    }
  }
  if (COMPATIBILITY_REGRESSION_TESTS.some(test => !all.includes(test))) reject('COMPATIBILITY_REGRESSION_MISSING');
  if (new Set(all).size !== all.length || JSON.stringify(task.sort()) !== JSON.stringify([...discovered].sort()))
    reject('COMPATIBILITY_TEST_INVENTORY_MISMATCH');
  return scope.groups;
}
function discoverTaskTests() {
  const found = [];
  const walk = relative => {
    const info = lstatSync(path.join(repository, relative), { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) reject('COMPATIBILITY_TEST_SYMLINK');
    if (info.isDirectory()) for (const child of readdirSync(path.join(repository, relative)).sort()) walk(relative + '/' + child);
    else if (info.isFile() && relative.endsWith('.test.ts')) found.push(relative);
  };
  walk('packages/contracts/test/mbrs014'); walk('packages/bridge-core/test/mbrs014'); walk('apps/desktop/test/mbrs014');
  for (const name of readdirSync(path.join(repository, 'apps/desktop/test')).sort())
    if (/^mbrs014-.*\.test\.ts$/u.test(name)) walk('apps/desktop/test/' + name);
  return found.sort();
}
export function compatibilityStageSucceeded(result) {
  return result.exitCode === 0 && result.signal === null && result.closeObserved === true
    && ['timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].every(key => result[key] === false)
    && (result.expectedTests === null || result.tapStatusesClean === true && isCompleteTestRun(result.testCounts, result.expectedTests));
}
export async function runCompatibilityGate(argv = process.argv.slice(2), env = process.env) {
  const admission = validateOfflineArguments(argv, env);
  if (Number(process.versions.node.split('.')[0]) !== 22) reject('COMPATIBILITY_NODE22_REQUIRED');
  const startedAt = new Date().toISOString(), start = performance.now(), limitMs = 420_000;
  const remaining = () => limitMs - (performance.now() - start);
  const check = () => { if (remaining() <= 0) reject('COMPATIBILITY_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => {
    check(); const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4 * 1024 * 1024 });
    check(); return value.trim();
  };
  git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  assertCompatibilityAdmission(JSON.parse(readFileSync(path.join(repository, 'docs/postrust/MBRS-014/EXECUTION_SCOPE.json'), 'utf8')),
    readFileSync(path.join(repository, COMPATIBILITY_TASK_SPEC.path)),
    readFileSync(path.join(repository, 'docs/postrust/MBRS-000/PACK_TASKBOARD.json')),
    readFileSync(path.join(repository, 'docs/postrust/MBRS-000/PACK_ACCEPTANCE.json')),
    JSON.parse(readFileSync(path.join(repository, 'docs/postrust/RUST-016/ADMISSION_DECISION.json'), 'utf8')));
  assertCompatibilityLegacyInputs(readFileSync(path.join(repository, COMPATIBILITY_LEGACY_INPUTS.path)), file => {
    check(); const source = path.join(repository, file), info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) reject('COMPATIBILITY_LEGACY_INPUT_NOT_ORDINARY_FILE');
    return readFileSync(source);
  });
  const groups = assertCompatibilityScope(JSON.parse(readFileSync(path.join(repository, scopeFile), 'utf8')), discoverTaskTests());
  const head = git(['rev-parse', 'HEAD']);
  const sourceNames = () => {
    const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      ...packageRoots.flatMap(root => [root + '/src', root + '/test']),
      'apps/desktop/e2e', 'scripts/ci/verify-mbrs014-compatibility.mjs', 'scripts/ci/test/verify-mbrs014-compatibility.test.mjs', scopeFile,
      '.github/workflows', 'docs/postrust/MBRS-014', COMPATIBILITY_TASK_SPEC.path]).split('\0').filter(Boolean);
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'scripts/ci/verify-mbrs001-offline.mjs', 'scripts/ci/mbm000-legacy-probe-normalization.mjs', 'scripts/ci/mbm001-legacy-probe-normalization.mjs',
      'apps/desktop/scripts/build-storage-root.mjs',
      'project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md',
      'docs/postrust/MBRS-000/PACK_TASKBOARD.json', 'docs/postrust/MBRS-000/PACK_ACCEPTANCE.json', 'docs/postrust/RUST-016/ADMISSION_DECISION.json',
      'packages/bridge-core/scripts/build-metadata-reader-worker.mjs', 'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs',
      'apps/desktop/electron.vite.config.ts', 'apps/desktop/tsconfig.e2e.json',
      ...packageRoots.flatMap(root => [root + '/package.json', root + '/tsconfig.json',
        ...(root === 'apps/desktop' ? [] : [root + '/tsconfig.test.json'])])]) paths.push(file);
    return [...new Set(paths.filter(file => !file.startsWith('docs/postrust/MBRS-014/evidence/')))].sort();
  };
  const identity = () => sourceNames().map(file => {
    check(); const p = path.join(repository, file), info = lstatSync(p);
    if (!info.isFile() || info.isSymbolicLink()) reject('COMPATIBILITY_INPUT_NOT_ORDINARY_FILE');
    const bytes = readFileSync(p); return { path: file, bytes: bytes.length, sha256: sha(bytes) };
  });
  const inputs = identity();
  const coreRequire = createRequire(path.join(repository, 'packages/bridge-core/package.json'));
  const desktopRequire = createRequire(path.join(repository, 'apps/desktop/package.json'));
  const tsc = coreRequire.resolve('typescript/bin/tsc'); coreRequire.resolve('tsx'); desktopRequire.resolve('tsx');
  const stages = [
    { name: 'fresh-contracts-build', directory: packageRoots[0], args: [tsc, '-p', 'tsconfig.json'] },
    { name: 'contracts-types', directory: packageRoots[0], args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'fresh-core-build', directory: packageRoots[1], args: [tsc, '-p', 'tsconfig.json'] },
    { name: 'fresh-core-worker-bundle', directory: packageRoots[1], args: ['scripts/build-metadata-reader-worker.mjs'] },
    { name: 'core-types', directory: packageRoots[1], args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'desktop-types', directory: packageRoots[2], args: [desktopRequire.resolve('vue-tsc/bin/vue-tsc.js'), '-p', 'tsconfig.json', '--noEmit'] },
    { name: 'desktop-e2e-types', directory: packageRoots[2], args: [tsc, '-p', 'tsconfig.e2e.json', '--noEmit'] },
    ...groups.map(group => ({ ...group, args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...group.tests] })),
  ];
  const run = createPrivateRun(admission), temporary = path.join(run, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const childEnv = { ...env, TMPDIR: temporary }, runs = [], failures = [];
  async function capture(stage) {
    check(); const began = performance.now();
    const result = { name: stage.name, directory: stage.directory, expectedTests: stage.expectedTests ?? null,
      argv: ['node', ...stage.args.map(arg => arg === tsc ? 'typescript/bin/tsc' : arg)],
      startedAt: new Date().toISOString(), exitCode: null, signal: null, closeObserved: false,
      timedOut: false, overflow: false, captureFailed: false, preparationFailed: false, groupTerminationFailed: false };
    const chunks = []; let length = 0;
    await new Promise(resolve => {
      let child, timer;
      const terminate = () => { if (!child?.pid) return; try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') result.groupTerminationFailed = true; } };
      try { child = spawn(process.execPath, stage.args, { cwd: path.join(repository, stage.directory), env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { result.preparationFailed = true; resolve(); return; }
      child.once('close', (code, signal) => { clearTimeout(timer); result.exitCode = code; result.signal = signal; result.closeObserved = true; resolve(); });
      child.once('error', () => { result.preparationFailed = true; terminate(); });
      const append = bytes => {
        if (result.overflow || result.captureFailed) return;
        try { if (length + bytes.length > 4 * 1024 * 1024) { result.overflow = true; terminate(); } else { chunks.push(Buffer.from(bytes)); length += bytes.length; } }
        catch { result.captureFailed = true; terminate(); }
      };
      child.stdout.on('data', append); child.stderr.on('data', append);
      for (const stream of [child.stdout, child.stderr]) stream.once('error', () => { result.captureFailed = true; terminate(); });
      timer = setTimeout(() => { result.timedOut = true; terminate(); }, Math.max(1, Math.min(180_000, remaining())));
    });
    const raw = Buffer.concat(chunks).toString('utf8'), safe = sanitizeOutput(raw);
    result.durationMs = performance.now() - began; result.rawSha256 = sha(raw); result.rawBytes = Buffer.byteLength(raw);
    result.testCounts = stage.expectedTests === undefined ? null : parseTestCounts(raw);
    result.tapStatusesClean = stage.expectedTests === undefined ? null : !/^\s*not ok \d+|^\s*ok \d+[^\r\n]*#\s*(?:SKIP|TODO)\b/imu.test(raw);
    result.log = stage.name + '.log'; result.logSha256 = sha(safe);
    writeFileSync(path.join(run, result.log), safe, { flag: 'wx', mode: 0o600 });
    // 原始诊断只留在本次私有tmp，不进入公共CI artifact。
    writeFileSync(path.join(temporary, stage.name + '.raw.log'), raw, { flag: 'wx', mode: 0o600 });
    result.success = compatibilityStageSucceeded(result); runs.push(result); return result;
  }
  let inputsUnchanged = false;
  try {
    for (const stage of stages) if (!(await capture(stage)).success) { failures.push('COMPATIBILITY_STAGE_FAILED_OR_INCOMPLETE'); break; }
    inputsUnchanged = git(['rev-parse', 'HEAD']) === head && JSON.stringify(identity()) === JSON.stringify(inputs);
    if (!inputsUnchanged) failures.push('COMPATIBILITY_INPUTS_CHANGED_DURING_RUN');
  } catch (error) { failures.push(error?.code ?? 'COMPATIBILITY_GATE_EXCEPTION'); }
  const success = failures.length === 0 && runs.length === stages.length && runs.every(compatibilityStageSucceeded);
  const summary = { schema: 'mbrs014.compatibility-gate.v1', task: 'MBRS-014', baseSha, head, startedAt,
    completedAt: new Date().toISOString(), durationMs: performance.now() - start, success, failures,
    inputScope: 'DECLARED_SOURCE_TEST_CONFIGURATION_INPUTS_NOT_TRANSITIVE_TOOLCHAIN_CLOSURE',
    sourceInputs: inputs, inputsUnchanged, runs, completedStages: runs.length, expectedStages: stages.length,
    tests: runs.filter(r => r.expectedTests !== null).reduce((total, r) => total + (r.testCounts?.tests ?? 0), 0),
    pass: runs.filter(r => r.expectedTests !== null).reduce((total, r) => total + (r.testCounts?.pass ?? 0), 0),
    scope: 'FRESH_SOFTWARE_AND_TYPES_NOT_APP_REAL_USER_MIGRATION_OR_SOURCE_WRITER', sourceFilesWrite: 'OFF',
    realProviderAccountRoonAudioOwner: 'NOT_RUN', productionApp: 'NOT_RUN_BY_THIS_GATE' };
  writePrivateJson(run, 'summary.json', summary);
  return { run, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await runCompatibilityGate(); process.stdout.write(JSON.stringify({ success: result.summary.success, tests: result.summary.tests, pass: result.summary.pass, run: result.run }) + '\n'); if (!result.summary.success) process.exitCode = 1; }
  catch (error) { process.stderr.write('014旧来源兼容Gate拒绝：' + (error?.code ?? 'ADMISSION_FAILED') + '\n'); process.exitCode = 1; }
}
