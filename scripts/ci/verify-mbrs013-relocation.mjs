import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { assertCompatibilityLegacyInputs, COMPATIBILITY_LEGACY_INPUTS } from './verify-mbrs014-compatibility.mjs';
import { assertSourceWritesScope, captureSourceWritesReaderCompiler, makeSourceWritesReaderDeclarations } from './verify-mbrs012-source-writes.mjs';
import { readArtifact, readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RELOCATION_BASE = 'c5c36c2c3e327b5068b5ad15ca6c251c5aeb4478';
export const RELOCATION_TASK_SPEC = Object.freeze({ path: 'tasks/MBRS-013_LOCAL_RELOCATION.md', bytes: 3402, sha256: '10702afad204b607b76d66a85007478f0bd980d3010cb62a0675279df40a98cf' });
export const RELOCATION_BUDGETS = Object.freeze({ operations: 100, closedResources: 256, referenceEdges: 512, sourceAndTargetRoots: 16,
  requestUtf8Bytes: 4194304, completePlanBodyContextBytes: 4194304, snapshotDepth: 32, snapshotNodes: 65536, allTextBytes: 131072,
  singleSourceBytes: 17179869184, planFullSourceBytes: 68719476736, hashChunkBytes: 1048576, concurrentPlans: 1, concurrentFileIo: 1,
  phaseEventsPerResource: 64, phaseEventsPerPlan: 32768, terminalReservedEventsPerResource: 8, terminalReservedEventsPerPlan: 32,
  journalProjectionBytes: 67108864, retainedMaterialsBytes: 137438953472, runtimeDeadlineMs: 1800000,
  overBudget: 'REJECT_FULL_PLAN_WITHOUT_TRUNCATION_OR_PARTIAL_AUTHORIZATION',
  reservation: 'ACTUAL_SOURCE_TARGET_STAGE_RETAINED_MATERIALS_PLUS_TERMINAL_JOURNAL_BEFORE_IO', existing012AndReaderBudgetsChanged: false });
const packageRoots = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'];
const testScopeFile = 'docs/postrust/MBRS-013/TEST_SCOPE.json';
const inheritedScopeFile = 'scripts/ci/mbrs012-source-writes-scope.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const reject = code => { const error = new Error('013位置域Gate拒绝准入。'); error.code = code; throw error; };
function pinned(bytes, expected, code) { if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) reject(code); }
export function assertRelocationAdmission(scope, taskBytes, boardBytes, acceptanceBytes, g0, predecessor) {
  pinned(taskBytes, RELOCATION_TASK_SPEC, 'RELOCATION_TASK_SPEC_CHANGED');
  pinned(boardBytes, { bytes: 38001, sha256: 'b26a933bc7ef84a80c32f417a6a39af9386c6e35f9af9a87c6bc01f6c2a8deec' }, 'RELOCATION_ORIGINAL_TASKBOARD_CHANGED');
  pinned(acceptanceBytes, { bytes: 51702, sha256: '19edef0a2a16c8516517d1262396414e25569898e6eb40d58fb1b2032c2d75a4' }, 'RELOCATION_ORIGINAL_AT_CHANGED');
  if (scope?.schema !== 'mbrs013.execution-scope.v1' || scope.task !== 'MBRS-013' || scope.baseSha !== RELOCATION_BASE
    || scope.branch !== 'codex/mbrs-013-relocation' || scope.g0 !== 'ADMITTED_INHERITED_OWNER_CONTINUOUS_AUTHORIZATION'
    || scope.g0Ref !== 'docs/postrust/MBRS-013/G0_HANDOFF.json' || !same(scope.hardDependencies, ['MBRS-012'])
    || !same(scope.taskSpec, RELOCATION_TASK_SPEC) || scope.domain !== 'LOCAL_RELOCATION_V1'
    || scope.publicDomain !== 'localRelocationPlan' || scope.privateDomain !== 'localRelocationMain'
    || scope.defaultCore !== 'Node' || scope.optionalRustReadonly !== 'OFF' || scope.catalogSchemaAtEntry !== 34
    || scope.libraryWriteEnabledDefault !== false || scope.legacyOrganizerSourceFiles !== 'OFF_UNCHANGED'
    || scope.runtimeRelocation !== 'OFF_UNTIL_FINITE_QUALIFICATION_SPECIFIC_MAIN_PLAN_ONLY'
    || scope.old012SourceFilesWrite !== 'OFF_UNTIL_EXISTING_FINITE_WRITER_QUALIFICATION_CONCRETE_PLAN_GRANTS_ONLY_UNCHANGED'
    || scope.formatEligibility !== 'ORDINARY_READER_ELIGIBLE_WHOLE_BYTE_MOVE_INDEPENDENT_FROM_012_WRITER'
    || scope.copySourceDisposition !== 'RETAIN_UNTIL_NEW_SPECIFIC_VERIFIED_CLEANUP_GRANT'
    || !same(scope.budgets, RELOCATION_BUDGETS) || scope.originalTaskCount !== 18 || scope.originalAcceptanceCount !== 156
    || scope.effectiveTaskCount !== 17 || scope.effectiveAcceptanceCount !== 150 || scope.taskAcceptanceCount !== 8
    || !same(scope.acceptanceIds, Array.from({ length: 8 }, (_, i) => 'MBRS-AT-013-' + String(i + 1).padStart(2, '0')))
    || scope.cancelledTask !== 'MBRS-015' || scope.noRepeatedAgentApproval !== true
    || scope.productPlanConfirmation !== 'FINAL_SPECIFIC_PLAN_BUTTON_NO_EXTRA_APPROVAL_POPUP') reject('RELOCATION_EXECUTION_SCOPE_CHANGED');
  if (g0?.schema !== 'mbrs013.g0-handoff.v1' || g0.task !== 'MBRS-013' || g0.baseSha !== RELOCATION_BASE
    || g0.branch !== scope.branch || g0.decision !== scope.g0 || g0.originalEightAcceptanceRequirementsUnchanged !== true
    || g0.taskSpecSha256 !== RELOCATION_TASK_SPEC.sha256) reject('RELOCATION_G0_CHANGED');
  if (predecessor?.schema !== 'mbrs013.predecessor-delivery.v1' || predecessor.task !== 'MBRS-012'
    || predecessor.result !== 'FINITE_SOFTWARE_DELIVERY_SEALED_LIVE_CARRYOVER_OPEN'
    || predecessor.sourceSha !== '7166e12d7474957041f5d747db5dc9300f7e9ee7'
    || predecessor.reportSha !== RELOCATION_BASE || predecessor.remoteHead !== RELOCATION_BASE
    || predecessor.reportDirectChildOfFinalSource !== true || predecessor.clean !== true
    || predecessor.finalReceipt?.bytes !== 190290
    || predecessor.finalReceipt?.sha256 !== '2ff9c74adb34d5be063fee65adb85aad91d1c0156aecc4a7cf16a3c06bd09988'
    || predecessor.originalFailedExecutionsPreserved !== true || predecessor.noThirdSelfSealing012Commit !== true
    || predecessor.realRoonNasAudioDeviceOwner !== 'NOT_RUN') reject('RELOCATION_PREDECESSOR_CHANGED');
}
export function assertRelocationTestScope(scope, inheritedBytes, discovered, inheritedDiscovered) {
  pinned(inheritedBytes, { bytes: 3165, sha256: 'ec748e744eeeff1b98ec90b1dad683fc4021e532884051dc623761342910ec7a' }, 'RELOCATION_INHERITED_TEST_SCOPE_CHANGED');
  const inherited = assertSourceWritesScope(JSON.parse(inheritedBytes.toString('utf8')), inheritedDiscovered);
  if (scope?.schema !== 'mbrs013.relocation-test-scope.v1' || scope.baseSha !== RELOCATION_BASE
    || scope.implementationComplete !== true || scope.countsConfirmed !== true
    || scope.inherited426TestsPreserved !== true || !Array.isArray(scope.groups) || scope.groups.length !== 3) reject('RELOCATION_TEST_SCOPE_NOT_FROZEN');
  const found = [], names = new Set(), directories = new Set();
  for (const group of scope.groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name)
      || !packageRoots.includes(group.directory) || directories.has(group.directory)
      || !Number.isSafeInteger(group.expectedTests) || group.expectedTests < 1 || !Array.isArray(group.tests) || !group.tests.length) reject('RELOCATION_TEST_GROUP_INVALID');
    names.add(group.name); directories.add(group.directory);
    for (const name of group.tests) {
      if (typeof name !== 'string' || !/^test\/mbrs013\/[A-Za-z0-9_-]+\.test\.ts$/u.test(name)) reject('RELOCATION_TEST_PATH_INVALID');
      found.push(group.directory + '/' + name);
    }
  }
  if (new Set(found).size !== found.length || !same(found.sort(), [...discovered].sort())) reject('RELOCATION_TEST_INVENTORY_CHANGED');
  return [...inherited, ...scope.groups];
}
function discoverTests(task) {
  const found = [];
  const walk = relative => {
    const info = lstatSync(path.join(repository, relative), { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) reject('RELOCATION_TEST_SYMLINK');
    if (info.isDirectory()) for (const child of readdirSync(path.join(repository, relative)).sort()) walk(relative + '/' + child);
    else if (info.isFile() && relative.endsWith('.test.ts')) found.push(relative);
  };
  for (const root of packageRoots) walk(root + '/test/' + task);
  if (task === 'mbrs012') for (const name of readdirSync(path.join(repository, 'apps/desktop/test')).sort())
    if (/^mbrs012-.*\.test\.ts$/u.test(name)) walk('apps/desktop/test/' + name);
  return found.sort();
}
export function relocationStageSucceeded(result) {
  return result.exitCode === 0 && result.signal === null && result.closeObserved === true
    && ['timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].every(key => result[key] === false)
    && (result.expectedTests === null || result.tapStatusesClean === true && isCompleteTestRun(result.testCounts, result.expectedTests));
}
/** 覆盖本轮实际消费的所有编译叶、Worker材料和声明；末尾再走真实FD校验。 */
export async function assertRelocationArtifactClosure(expected, inspect = readArtifact) {
  if (!Array.isArray(expected) || !expected.length || new Set(expected.map(row => row?.file)).size !== expected.length) reject('RELOCATION_ARTIFACT_CLOSURE_INVALID');
  for (const row of expected) {
    if (!row || typeof row.file !== 'string' || !path.isAbsolute(row.file) || !Number.isSafeInteger(row.bytes) || row.bytes < 1
      || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)) reject('RELOCATION_ARTIFACT_CLOSURE_INVALID');
    const actual = (await inspect(row.file)).identity;
    if (actual.file !== row.file || actual.bytes !== row.bytes || actual.sha256 !== row.sha256) reject('RELOCATION_ARTIFACT_CHANGED');
  }
  return true;
}
async function captureRelocationCompilerOutputs(inputs, result, packageRoot, check) {
  const sources = inputs.filter(row => row.path.startsWith(packageRoot + '/src/') && row.path.endsWith('.ts') && !row.path.endsWith('.d.ts'));
  if (!sources.length) reject('RELOCATION_COMPILED_SOURCE_CLOSURE_EMPTY');
  const outputs = [];
  for (const source of sources) for (const suffix of ['.js', '.js.map', '.d.ts']) {
    const name = source.path.replace('/src/', '/dist/').slice(0, -3) + suffix;
    const actual = await readArtifact(path.join(repository, name), check);
    if (actual.mtimeMs < result.startedMs || actual.mtimeMs > result.closedMs) reject('RELOCATION_COMPILED_OUTPUT_NOT_FRESH');
    outputs.push({ ...actual.identity, path: name, sourcePath: source.path, sourceSha256: source.sha256 });
  }
  return outputs;
}
export async function runRelocationGate(argv = process.argv.slice(2), env = process.env) {
  const admission = validateOfflineArguments(argv, env);
  if (process.versions.node.split('.')[0] !== '22') reject('RELOCATION_NODE22_REQUIRED');
  const start = performance.now(), startedAt = new Date().toISOString(), limitMs = 420_000;
  const remaining = () => limitMs - (performance.now() - start);
  const check = () => { if (remaining() <= 0) reject('RELOCATION_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => { check(); const result = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4194304 }); check(); return result.replace(/\s+$/u, ''); };
  git(['merge-base', '--is-ancestor', RELOCATION_BASE, 'HEAD']);
  const read = file => readFileSync(path.join(repository, file));
  assertRelocationAdmission(JSON.parse(read('docs/postrust/MBRS-013/EXECUTION_SCOPE.json')), read(RELOCATION_TASK_SPEC.path),
    read('docs/postrust/MBRS-000/PACK_TASKBOARD.json'), read('docs/postrust/MBRS-000/PACK_ACCEPTANCE.json'),
    JSON.parse(read('docs/postrust/MBRS-013/G0_HANDOFF.json')), JSON.parse(read('docs/postrust/MBRS-013/PREDECESSOR_DELIVERY.json')));
  assertCompatibilityLegacyInputs(read(COMPATIBILITY_LEGACY_INPUTS.path), file => {
    const info = lstatSync(path.join(repository, file));
    if (!info.isFile() || info.isSymbolicLink()) reject('RELOCATION_LEGACY_INPUT_NOT_ORDINARY');
    return read(file);
  });
  const groups = assertRelocationTestScope(JSON.parse(read(testScopeFile)), read(inheritedScopeFile), discoverTests('mbrs013'), discoverTests('mbrs012'));
  const head = git(['rev-parse', 'HEAD']);
  const sourceNames = () => {
    const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      ...packageRoots.flatMap(root => [root + '/src', root + '/test']), 'apps/desktop/e2e', '.github/workflows',
      'scripts/ci', 'docs/postrust/MBRS-013', 'AGENTS.md', RELOCATION_TASK_SPEC.path]).split('\0').filter(Boolean);
    files.push('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'apps/desktop/scripts/build-storage-root.mjs', 'apps/desktop/electron.vite.config.ts',
      'apps/desktop/tsconfig.e2e.json', 'apps/desktop/tsconfig.mbrs013-e2e.json',
      'packages/bridge-core/scripts/build-metadata-reader-worker.mjs', 'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs',
      'project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md',
      'docs/postrust/MBRS-000/PACK_TASKBOARD.json', 'docs/postrust/MBRS-000/PACK_ACCEPTANCE.json', COMPATIBILITY_LEGACY_INPUTS.path,
      ...packageRoots.flatMap(root => [root + '/package.json', root + '/tsconfig.json', ...(root === 'apps/desktop' ? [] : [root + '/tsconfig.test.json'])]));
    return [...new Set(files.filter(file => !file.startsWith('docs/postrust/MBRS-013/evidence/')))].sort();
  };
  const identity = () => sourceNames().map(file => {
    check(); const info = lstatSync(path.join(repository, file));
    if (!info.isFile() || info.isSymbolicLink()) reject('RELOCATION_INPUT_NOT_ORDINARY');
    const bytes = read(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) };
  });
  const inputs = identity(), coreRequire = createRequire(path.join(repository, packageRoots[1] + '/package.json')),
    desktopRequire = createRequire(path.join(repository, packageRoots[2] + '/package.json'));
  const tsc = coreRequire.resolve('typescript/bin/tsc'); coreRequire.resolve('tsx'); desktopRequire.resolve('tsx');
  const stages = [
    { name: 'fresh-contracts-build', directory: packageRoots[0], args: [tsc, '-p', 'tsconfig.json'] },
    { name: 'contracts-types', directory: packageRoots[0], args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'fresh-core-build', directory: packageRoots[1], args: [tsc, '-p', 'tsconfig.json'] },
    { name: 'fresh-core-worker-bundle', directory: packageRoots[1], args: ['scripts/build-metadata-reader-worker.mjs'] },
    { name: 'core-types', directory: packageRoots[1], args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'desktop-types', directory: packageRoots[2], args: [desktopRequire.resolve('vue-tsc/bin/vue-tsc.js'), '-p', 'tsconfig.json', '--noEmit'] },
    { name: 'desktop-original-e2e-types', directory: packageRoots[2], args: [tsc, '-p', 'tsconfig.e2e.json', '--noEmit'] },
    { name: 'desktop-relocation-e2e-types', directory: packageRoots[2], args: [tsc, '-p', 'tsconfig.mbrs013-e2e.json', '--noEmit'] },
    ...groups.map(group => ({ ...group, args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...group.tests] })),
  ];
  const run = createPrivateRun(admission), temporary = path.join(run, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const childEnv = { ...env, TMPDIR: temporary, MBRS003_READER_BUILD_BINDING: path.join(run, 'reader-build-binding.json') };
  const runs = [], failures = [];
  async function capture(stage) {
    check(); const began = performance.now(), result = { name: stage.name, directory: stage.directory, expectedTests: stage.expectedTests ?? null,
      argv: ['node', ...stage.args], startedMs: Date.now(), closedMs: null, exitCode: null, signal: null, closeObserved: false,
      timedOut: false, overflow: false, captureFailed: false, preparationFailed: false, groupTerminationFailed: false };
    const chunks = []; let length = 0;
    await new Promise(resolve => {
      let child, timer;
      const terminate = () => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') result.groupTerminationFailed = true; } };
      try { child = spawn(process.execPath, stage.args, { cwd: path.join(repository, stage.directory), env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { result.preparationFailed = true; resolve(); return; }
      child.once('close', (code, signal) => { clearTimeout(timer); result.closedMs = Date.now(); result.exitCode = code; result.signal = signal; result.closeObserved = true; resolve(); });
      child.once('error', () => { result.preparationFailed = true; terminate(); });
      const append = bytes => {
        if (result.overflow || result.captureFailed) return;
        try { if (length + bytes.length > 4194304) { result.overflow = true; terminate(); } else { chunks.push(Buffer.from(bytes)); length += bytes.length; } }
        catch { result.captureFailed = true; terminate(); }
      };
      for (const stream of [child.stdout, child.stderr]) { stream.on('data', append); stream.once('error', () => { result.captureFailed = true; terminate(); }); }
      timer = setTimeout(() => { result.timedOut = true; terminate(); }, Math.max(1, Math.min(180000, remaining())));
    });
    const raw = Buffer.concat(chunks).toString('utf8'), safe = sanitizeOutput(raw);
    result.durationMs = performance.now() - began; result.rawBytes = Buffer.byteLength(raw); result.rawSha256 = sha(raw);
    result.testCounts = stage.expectedTests === undefined ? null : parseTestCounts(raw);
    result.tapStatusesClean = stage.expectedTests === undefined ? null : !/^\s*not ok \d+|^\s*ok \d+[^\r\n]*#\s*(?:SKIP|TODO)\b/imu.test(raw);
    result.log = stage.name + '.log'; result.logSha256 = sha(safe);
    writeFileSync(path.join(run, result.log), safe, { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(temporary, stage.name + '.raw.log'), raw, { flag: 'wx', mode: 0o600 });
    result.success = relocationStageSucceeded(result); runs.push(result); return result;
  }
  let inputsUnchanged = false, freshReader = null, readerDeclaration = null, readerOutputIdentityUnchanged = false,
    artifactIdentityUnchanged = false, fixedWorkerManifest = null;
  const compiledOutputs = [], artifactClosure = [];
  try {
    for (const stage of stages) {
      const result = await capture(stage); if (!result.success) { failures.push('RELOCATION_STAGE_FAILED_OR_INCOMPLETE'); break; }
      if (stage.name === 'fresh-contracts-build' || stage.name === 'fresh-core-build') {
        const outputs = await captureRelocationCompilerOutputs(inputs, result, stage.directory, check);
        compiledOutputs.push(...outputs); artifactClosure.push(...outputs);
      }
      if (stage.name === 'fresh-core-build') { freshReader = captureSourceWritesReaderCompiler(inputs, result); writePrivateJson(temporary, 'reader-compiler-closed.json', freshReader); }
      if (stage.name === 'fresh-core-worker-bundle') {
        if (!same(identity(), inputs)) reject('RELOCATION_READER_SOURCE_DRIFT');
        const fixed = await readFixedMetadataWorkerBundle(path.join(repository, packageRoots[1]), check);
        fixedWorkerManifest = fixed.manifest;
        artifactClosure.push(fixed.receiptRef);
        for (const row of [fixed.manifest.entry, fixed.manifest.map, fixed.manifest.metafile]) artifactClosure.push({ ...row, file: path.join(repository, packageRoots[1], row.file) });
        const declarations = makeSourceWritesReaderDeclarations(inputs, freshReader, fixed.manifest);
        writePrivateJson(run, 'reader-build-binding.json', declarations.reader); writePrivateJson(temporary, 'namespace-reader-build-binding.json', declarations.namespace);
        for (const file of [path.join(run, 'reader-build-binding.json'), path.join(temporary, 'namespace-reader-build-binding.json')]) artifactClosure.push((await readArtifact(file, check)).identity);
        readerDeclaration = { reader: { bytes: Buffer.byteLength(JSON.stringify(declarations.reader, null, 2) + '\n'), sha256: sha(JSON.stringify(declarations.reader, null, 2) + '\n') }, namespace: declarations.namespace };
      }
    }
    inputsUnchanged = git(['rev-parse', 'HEAD']) === head && same(identity(), inputs);
    if (!inputsUnchanged) failures.push('RELOCATION_INPUTS_CHANGED');
    readerOutputIdentityUnchanged = !!freshReader && freshReader.outputs.every(row => { const bytes = read(row.path); return bytes.length === row.bytes && sha(bytes) === row.sha256; });
    if (readerDeclaration && !readerOutputIdentityUnchanged) failures.push('RELOCATION_READER_OUTPUT_CHANGED');
    if (readerDeclaration) {
      await assertRelocationArtifactClosure(artifactClosure, file => readArtifact(file, check));
      const fixed = await readFixedMetadataWorkerBundle(path.join(repository, packageRoots[1]), check);
      if (!same(fixed.manifest, fixedWorkerManifest)) reject('RELOCATION_WORKER_MANIFEST_CHANGED');
      artifactIdentityUnchanged = true;
      writePrivateJson(run, 'compiled-output-closure.json', compiledOutputs);
      writePrivateJson(run, 'consumed-artifact-closure.json', artifactClosure);
    }
  } catch (error) { failures.push(error.code ?? 'RELOCATION_GATE_EXCEPTION'); }
  const success = failures.length === 0 && runs.length === stages.length && runs.every(relocationStageSucceeded);
  const totals = runs.filter(result => result.expectedTests !== null).reduce((sum, result) => ({ tests: sum.tests + (result.testCounts?.tests ?? 0), pass: sum.pass + (result.testCounts?.pass ?? 0) }), { tests: 0, pass: 0 });
  const summary = { schema: 'mbrs013.relocation-gate.v1', task: 'MBRS-013', baseSha: RELOCATION_BASE, head, startedAt, completedAt: new Date().toISOString(),
    durationMs: performance.now() - start, success, failures, sourceInputs: inputs, inputScope: 'DECLARED_SOURCE_TEST_CONFIGURATION_NOT_TRANSITIVE_TOOLCHAIN_CLOSURE',
    inputsUnchanged, readerDeclaration, readerOutputIdentityUnchanged, artifactIdentityUnchanged,
    compiledOutputCount: compiledOutputs.length, consumedArtifactCount: artifactClosure.length,
    runs, completedStages: runs.length, expectedStages: stages.length, ...totals,
    inherited426TestsPreserved: true, scope: 'FRESH_TYPES_AND_SYNTHETIC_SOFTWARE_NOT_PRODUCTION_APP_LIVE_OR_OWNER',
    relocation: 'DEFAULT_OFF_FINITE_QUALIFIED_SPECIFIC_PLAN_ONLY', originalEightAtResult: 'NOT_CLAIMED_BY_CASE_COUNTS', productionApp: 'NOT_RUN_BY_THIS_GATE', realRoonNasAudioDeviceOwner: 'NOT_RUN' };
  writePrivateJson(run, 'summary.json', summary); return { run, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { run, summary } = await runRelocationGate();
    process.stdout.write(JSON.stringify({ run, success: summary.success, tests: summary.tests, pass: summary.pass,
      failedStages: summary.runs.filter(result => !result.success).map(({ name, exitCode, signal, testCounts }) => ({ name, exitCode, signal, testCounts })) }) + '\n');
    if (!summary.success) process.exitCode = 1;
  } catch (error) { process.stderr.write('013位置域Gate拒绝：' + (error.code ?? 'ADMISSION_FAILED') + '\n'); process.exitCode = 1; }
}
