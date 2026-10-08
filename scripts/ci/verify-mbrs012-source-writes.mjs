import { assertCompatibilityLegacyInputs as assertSourceWritesLegacyInputs, COMPATIBILITY_LEGACY_INPUTS as SOURCE_WRITES_LEGACY_INPUTS } from './verify-mbrs014-compatibility.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { makeReaderBundleBinding } from './verify-mbrs003-scan.mjs';
import { readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseSha = '09370f19d4422be3b387047999a0722961c52e1e';
const scopeFile = 'scripts/ci/mbrs012-source-writes-scope.json';
const packageRoots = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = code => { const error = new Error('012受控源写Gate未准入。'); error.code = code; throw error; };
const readerSources=['src/recording/source-files.ts','src/library/metadata-reader.ts','src/library/metadata-reader-worker.ts','src/library/metadata-reader-types.ts'];
const namespaceReaderSources=['src/stream/physical-resource-locks.ts','src/stream/physical-resource-claims.ts','src/stream/source-namespace-claims.ts'];
/** 本次真实compiler成功且close后，才读取其实际JS/map；不刷新旧产物的mtime。 */
export function captureSourceWritesReaderCompiler(inputs,result){
  if(!sourceWritesStageSucceeded(result)||result.expectedTests!==null||!Number.isFinite(result.startedMs)||!Number.isFinite(result.closedMs)||result.closedMs<result.startedMs)reject('SOURCE_WRITES_READER_FRESH_COMPILER_REQUIRED');
  const outputs=[];
  for(const file of [...readerSources,...namespaceReaderSources]){
    const source=inputs.find(row=>row.path==='packages/bridge-core/'+file);if(!source)reject('SOURCE_WRITES_READER_SOURCE_MISSING');
    const actualSource=readFileSync(path.join(repository,source.path));if(actualSource.length!==source.bytes||sha(actualSource)!==source.sha256)reject('SOURCE_WRITES_READER_SOURCE_DRIFT');
    for(const suffix of ['.js','.js.map']){
      const relative='packages/bridge-core/'+file.replace(/^src\//u,'dist/').slice(0,-3)+suffix,target=path.join(repository,relative),info=lstatSync(target),bytes=readFileSync(target);
      if(!info.isFile()||info.isSymbolicLink()||info.mtimeMs<result.startedMs||info.mtimeMs>result.closedMs)reject('SOURCE_WRITES_READER_OUTPUT_NOT_FRESH');
      outputs.push({path:relative,bytes:bytes.length,sha256:sha(bytes),sourcePath:source.path,sourceSha256:source.sha256,mtimeMs:info.mtimeMs});
    }
  }
  return {compilerExit:0,compilerStartedAtMs:result.startedMs,compilerFinishedAtMs:result.closedMs,outputs};
}
export function makeSourceWritesReaderDeclarations(inputs,freshCore,fixedWorkerBundle){
  const reader=makeReaderBundleBinding(inputs,freshCore,fixedWorkerBundle);
  const sources=namespaceReaderSources.map(file=>{const row=inputs.find(input=>input.path==='packages/bridge-core/'+file);if(!row)reject('SOURCE_WRITES_NAMESPACE_READER_SOURCE_MISSING');return row;});
  const outputs=sources.flatMap(source=>['.js','.js.map'].map(suffix=>{
    const output=freshCore.outputs.find(row=>row.path==='packages/bridge-core/'+source.path.slice('packages/bridge-core/'.length).replace(/^src\//u,'dist/').slice(0,-3)+suffix);
    if(!output||output.sourceSha256!==source.sha256)reject('SOURCE_WRITES_NAMESPACE_READER_OUTPUT_MISMATCH');return output;
  }));
  return {reader,namespace:{schema:'mbrs012.namespace-reader.fresh-build.v1',compilerExit:0,compilerStartedAtMs:freshCore.compilerStartedAtMs,compilerFinishedAtMs:freshCore.compilerFinishedAtMs,sourceInputs:sources,outputs}};
}
export const SOURCE_WRITES_TASK_SPEC = Object.freeze({ path: 'tasks/MBRS-012_SAFE_SOURCE_WRITES.md', bytes: 3788,
  sha256: 'c77b9d1516a85a50e677c20e028f449ab072fc424032d4cb58e804aac2b427b6' });
export const SOURCE_WRITES_LIMITS = Object.freeze({
  binary: { singleBytes: 4194304, envelopeUtf8Bytes: 16384, retainedBytes: 67108864, retainedCount: 128 },
  plan: { operations: 100, completeBodyContextProjectionBytes: 2097152, headerAndItemAllTextBytes: 65536,
    phaseAllTextBytes: 16384, phaseEventsPerOperation: 32, phaseEventsPerPlan: 4096,
    terminalReservedEventsPerOperation: 4, terminalReservedEventsPerPlan: 16, journalProjectionBytes: 67108864 },
  io: { singleSourceBytes: 268435456, tagRegionBytes: 8388608, metadataBlocksOrFrames: 4096,
    planOriginalPayloadIoBytes: 2147483648, safetyStoreRetainedBytes: 2147483648 },
});
export function assertSourceWritesAdmission(scope, taskBytes, boardBytes, acceptanceBytes, g0) {
  if (scope?.schema !== 'mbrs012.execution-scope.v1' || scope.task !== 'MBRS-012' || scope.baseSha !== baseSha
    || scope.branch !== 'codex/mbrs-012-source-writes' || scope.defaultCore !== 'Node' || scope.optionalRustReadonly !== 'OFF'
    || scope.catalogSchema !== 34 || scope.libraryWriteEnabledDefault !== false || scope.legacyOrganizerSourceFiles !== 'OFF'
    || scope.sourceFilesWrite !== 'OFF_UNTIL_FINITE_WRITER_QUALIFICATION_CONCRETE_PLAN_GRANTS_ONLY'
    || scope.g0 !== 'ADMITTED_INHERITED_PHASE_HANDOFF' || scope.g0Ref !== 'docs/postrust/RUST-016/ADMISSION_DECISION.json'
    || scope.originalTaskCount !== 18 || scope.originalAcceptanceCount !== 156 || scope.effectiveTaskCount !== 17
    || scope.effectiveAcceptanceCount !== 150 || scope.taskAcceptanceCount !== 9
    || JSON.stringify(scope.scheduling?.hardDependencies) !== JSON.stringify(['MBRS-010', 'MBRS-011', 'MBRS-014', 'MBRS-005'])
    || scope.scheduling?.cancelledTask !== 'MBRS-015' || scope.publisherProfile !== 'NONATOMIC_QUARANTINE_LINK_V1'
    || JSON.stringify(scope.writerFormatProfiles) !== JSON.stringify(['NATIVE_FLAC_FIXED_TAG_REGION_V1', 'MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1'])) reject('SOURCE_WRITES_EXECUTION_SCOPE_INVALID');
  if (scope.noRepeatedAgentApproval !== true || scope.productPlanConfirmation !== 'FINAL_SPECIFIC_PLAN_BUTTON_NO_EXTRA_APPROVAL_POPUP'
    || scope.unknownCommandReconciliation?.sourceOnlyOutboxViewField !== 'sourceRequestFingerprint'
    || scope.unknownCommandReconciliation?.oldDomainViewAddsField !== false
    || scope.unknownCommandReconciliation?.getUsesOriginalCommandIdAndExpectedCommand !== true
    || scope.unknownCommandReconciliation?.notFoundAllowsRetry !== false
    || scope.unknownCommandReconciliation?.acceptedMeansSourceEffect !== false) reject('SOURCE_WRITES_RECONCILIATION_OR_CONFIRMATION_INVALID');
  if (scope.sourceFactProjection?.newFullRawOrigin !== 'SOURCE_WRITES_V1'
    || scope.sourceFactProjection?.fullRawResetsEarlierRawObservation !== true
    || scope.sourceFactProjection?.laterLegacyObservationKeepsPatchSemantics !== true
    || scope.sourceFactProjection?.oldObservationGuardAndHistoryUnchanged !== true
    || scope.sourceFactProjection?.detailAndSqlSearchShareEffectiveRaw !== true
    || scope.sourceFactProjection?.realExistingScanRowRequired !== true
    || scope.sourceFactProjection?.scanJobAndBatchForeignKeysPreserved !== true
    || scope.sourceFactProjection?.syntheticScanJobAllowed !== false
    || scope.sourceFactProjection?.sameOwnerTransactionRequired !== true
    || scope.sourceFactProjection?.followingScanDoubleRevisionAllowed !== false) reject('SOURCE_WRITES_SOURCE_FACT_PROJECTION_INVALID');
  if (scope.inverseProjection?.discriminator !== 'item.restoration'
    || scope.inverseProjection?.directPlansMayUseRestoration !== false
    || scope.inverseProjection?.coverCandidateIdentityBorrowAllowed !== false
    || scope.inverseProjection?.directoryOriginalAbsenceRemovableByExplicitInversePlan !== true
    || scope.inverseProjection?.originalArtistMultiValuesRestored !== true
    || scope.inverseProjection?.originalFrozenSixBodyNineOperationKeysPreserved !== true) reject('SOURCE_WRITES_INVERSE_PROJECTION_INVALID');
  for (const [field, limits] of Object.entries({ binaryOriginalTransport: SOURCE_WRITES_LIMITS.binary, planLimits: SOURCE_WRITES_LIMITS.plan, writerIoLimits: SOURCE_WRITES_LIMITS.io }))
    for (const [key, value] of Object.entries(limits)) if (scope[field]?.[key] !== value) reject('SOURCE_WRITES_LIMITS_CHANGED');
  if (scope.binaryOriginalTransport.oldArtworkJsonGuardUnchanged !== true || scope.writerIoLimits.oldReaderBudgetsUnchanged !== true
    || JSON.stringify(scope.writerIoLimits.safetyStoreCounts) !== JSON.stringify(['BACKUP_INDEPENDENT_COPY', 'QUARANTINED_ORIGINAL', 'UNCERTAIN_STAGE'])
    || scope.writerIoLimits.prePublicationReservation !== '3*SOURCE_BYTES+ORIGINAL_IMAGE_BYTES+METADATA+TERMINAL_JOURNAL') reject('SOURCE_WRITES_OLD_BUDGET_OR_SAFETY_RESERVATION_CHANGED');
  if (Object.keys(SOURCE_WRITES_TASK_SPEC).some(key => scope.taskSpec?.[key] !== SOURCE_WRITES_TASK_SPEC[key])
    || taskBytes.length !== SOURCE_WRITES_TASK_SPEC.bytes || sha(taskBytes) !== SOURCE_WRITES_TASK_SPEC.sha256) reject('SOURCE_WRITES_TASK_IDENTITY_INVALID');
  if (scope.predecessorFinalSeal?.archiveId !== 'MBRS014_FINAL_DELIVERY_RECEIPT' || scope.predecessorFinalSeal.bytes !== 8005
    || scope.predecessorFinalSeal.sha256 !== '852178579378aa9398dae2edae57bf34f480489bc9e50fa6182b42abf1683940'
    || scope.predecessorFinalSeal.reportSha !== baseSha) reject('SOURCE_WRITES_PREDECESSOR_IDENTITY_INVALID');
  if (g0?.kind !== 'HANDOFF_RECORD_NOT_AUTHORIZATION' || g0.is_synthetic !== false || g0.decision !== 'ADMITTED'
    || g0.mode !== 'EXPLICIT_PHASE_HANDOFF' || g0.full_rust_migration_completed !== false
    || !Array.isArray(g0.exit_items) || !g0.exit_items.length || g0.exit_items.some(x => x.required_for_admission && x.status !== 'PASS')
    || !Array.isArray(g0.component_owners)) reject('SOURCE_WRITES_G0_INVALID');
  const owners = g0.component_owners.filter(owner => owner.database_id === 'owned-dataset-sqlite');
  if (owners.length !== 1 || owners[0].writer_id !== 'node-dataset-owner-worker'
    || g0.component_owners.some(owner => owner.language === 'Rust' && (owner.writer_id !== null || owner.database_id !== null))) reject('SOURCE_WRITES_AUTHOR_INVALID');
  if (sha(boardBytes) !== 'b26a933bc7ef84a80c32f417a6a39af9386c6e35f9af9a87c6bc01f6c2a8deec'
    || sha(acceptanceBytes) !== '19edef0a2a16c8516517d1262396414e25569898e6eb40d58fb1b2032c2d75a4') reject('SOURCE_WRITES_ORIGINAL_PACK_INVALID');
  const board = JSON.parse(boardBytes), acceptance = JSON.parse(acceptanceBytes), ids = Array.from({ length: 9 }, (_, i) => 'MBRS-AT-012-0' + (i + 1));
  const task = board.tasks?.find(t => t.id === 'MBRS-012'), cases = acceptance.cases?.filter(c => c.task === 'MBRS-012');
  if (board.tasks?.length !== 18 || acceptance.cases?.length !== 156 || !task || !cases
    || JSON.stringify(task.depends_on) !== JSON.stringify(['MBRS-010', 'MBRS-011', 'MBRS-014', 'MBRS-005'])
    || JSON.stringify(task.acceptance_ids) !== JSON.stringify(ids) || JSON.stringify(cases.map(c => c.id)) !== JSON.stringify(ids)) reject('SOURCE_WRITES_ORIGINAL_AT_INVALID');
  return cases;
}
export const SOURCE_WRITES_REGRESSION_TESTS = Object.freeze([
  'packages/contracts/test/validator.test.ts',
  'packages/contracts/test/mbrs002/local-catalog.test.ts',
  'packages/contracts/test/mbrs011/contract.test.ts',
  'packages/bridge-core/test/mbrs002/local-catalog-store.test.ts',
  'packages/bridge-core/test/mbrs002/local-catalog-restore.test.ts',
  'packages/bridge-core/test/mbrs003/persistent-scan-store.test.ts',
  'packages/bridge-core/test/mbrs005/locks.test.ts',
  'packages/bridge-core/test/mbrs005/observation-binding.test.ts',
  'packages/bridge-core/test/mbrs011/organizer.test.ts',
  'packages/bridge-core/test/mbrs011/journal.test.ts',
  'packages/bridge-core/test/mbrs014/protection.test.ts',
  'packages/bridge-core/test/mbrs014/recording-protection.test.ts',
  'apps/desktop/test/command-outbox-service.test.ts',
  'apps/desktop/test/command-outbox-executor.test.ts',
  'apps/desktop/test/mbrs011-organizer-ipc.test.ts',
  'apps/desktop/test/mbrs011-organizer-session.test.ts',
  'apps/desktop/test/mbrs011-organizer-ui.test.ts',
  'apps/desktop/test/preload.test.ts',
]);
export function assertSourceWritesScope(scope, discovered) {
  if (scope?.schema !== 'mbrs012.source-writes-scope.v1' || scope.baseSha !== baseSha
    || scope.implementationComplete !== true || scope.countsConfirmed !== true
    || scope.sourceFilesWrite !== 'DEFAULT_OFF_SPECIFIC_QUALIFIED_PLAN_ONLY' || !Array.isArray(scope.groups) || scope.groups.length !== 3)
    reject('SOURCE_WRITES_SCOPE_NOT_FROZEN');
  const names = new Set(), directories = new Set(), all = [], task = [];
  for (const group of scope.groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name)
      || !packageRoots.includes(group.directory) || directories.has(group.directory)
      || !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0
      || !Array.isArray(group.tests) || group.tests.length === 0) reject('SOURCE_WRITES_GROUP_INVALID');
    names.add(group.name); directories.add(group.directory);
    for (const test of group.tests) {
      const full = group.directory + '/' + test;
      const own = group.directory === 'apps/desktop'
        ? /^test\/(?:mbrs012-|mbrs012\/)[A-Za-z0-9_-]+\.test\.ts$/u.test(test)
        : /^test\/mbrs012\/[A-Za-z0-9_-]+\.test\.ts$/u.test(test);
      if (typeof test !== 'string' || !own && !SOURCE_WRITES_REGRESSION_TESTS.includes(full)) reject('SOURCE_WRITES_TEST_PATH_INVALID');
      all.push(full); if (own) task.push(full);
    }
  }
  if (SOURCE_WRITES_REGRESSION_TESTS.some(test => !all.includes(test))) reject('SOURCE_WRITES_REGRESSION_MISSING');
  if (new Set(all).size !== all.length || JSON.stringify(task.sort()) !== JSON.stringify([...discovered].sort()))
    reject('SOURCE_WRITES_TEST_INVENTORY_MISMATCH');
  return scope.groups;
}
function discoverTaskTests() {
  const found = [];
  const walk = relative => {
    const info = lstatSync(path.join(repository, relative), { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) reject('SOURCE_WRITES_TEST_SYMLINK');
    if (info.isDirectory()) for (const child of readdirSync(path.join(repository, relative)).sort()) walk(relative + '/' + child);
    else if (info.isFile() && relative.endsWith('.test.ts')) found.push(relative);
  };
  walk('packages/contracts/test/mbrs012'); walk('packages/bridge-core/test/mbrs012'); walk('apps/desktop/test/mbrs012');
  for (const name of readdirSync(path.join(repository, 'apps/desktop/test')).sort())
    if (/^mbrs012-.*\.test\.ts$/u.test(name)) walk('apps/desktop/test/' + name);
  return found.sort();
}
export function sourceWritesStageSucceeded(result) {
  return result.exitCode === 0 && result.signal === null && result.closeObserved === true
    && ['timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].every(key => result[key] === false)
    && (result.expectedTests === null || result.tapStatusesClean === true && isCompleteTestRun(result.testCounts, result.expectedTests));
}
export async function runSourceWritesGate(argv = process.argv.slice(2), env = process.env) {
  const admission = validateOfflineArguments(argv, env);
  if (Number(process.versions.node.split('.')[0]) !== 22) reject('SOURCE_WRITES_NODE22_REQUIRED');
  const startedAt = new Date().toISOString(), start = performance.now(), limitMs = 420_000;
  const remaining = () => limitMs - (performance.now() - start);
  const check = () => { if (remaining() <= 0) reject('SOURCE_WRITES_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => {
    check(); const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4 * 1024 * 1024 });
    check(); return value.trim();
  };
  git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  assertSourceWritesAdmission(JSON.parse(readFileSync(path.join(repository, 'docs/postrust/MBRS-012/EXECUTION_SCOPE.json'), 'utf8')),
    readFileSync(path.join(repository, SOURCE_WRITES_TASK_SPEC.path)),
    readFileSync(path.join(repository, 'docs/postrust/MBRS-000/PACK_TASKBOARD.json')),
    readFileSync(path.join(repository, 'docs/postrust/MBRS-000/PACK_ACCEPTANCE.json')),
    JSON.parse(readFileSync(path.join(repository, 'docs/postrust/RUST-016/ADMISSION_DECISION.json'), 'utf8')));
  assertSourceWritesLegacyInputs(readFileSync(path.join(repository, SOURCE_WRITES_LEGACY_INPUTS.path)), file => {
    check(); const source = path.join(repository, file), info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) reject('SOURCE_WRITES_LEGACY_INPUT_NOT_ORDINARY_FILE');
    return readFileSync(source);
  });
  const groups = assertSourceWritesScope(JSON.parse(readFileSync(path.join(repository, scopeFile), 'utf8')), discoverTaskTests());
  const head = git(['rev-parse', 'HEAD']);
  const sourceNames = () => {
    const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      ...packageRoots.flatMap(root => [root + '/src', root + '/test']),
      'apps/desktop/e2e', 'scripts/ci/verify-mbrs012-source-writes.mjs', 'scripts/ci/test/verify-mbrs012-source-writes.test.mjs', scopeFile,
      '.github/workflows', 'docs/postrust/MBRS-012', 'docs/adr/ADR-MBRS-012-CONTROLLED-SOURCE-WRITES.md', 'AGENTS.md', SOURCE_WRITES_TASK_SPEC.path]).split('\0').filter(Boolean);
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'scripts/ci/verify-mbrs001-offline.mjs', 'apps/desktop/scripts/build-storage-root.mjs',
      'scripts/ci/verify-mbrs003-scan.mjs', 'scripts/ci/mbrs003-scale-receipts.mjs', 'scripts/ci/mbrs003-owner-stage-scale.mjs',
      'project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md',
      'docs/postrust/MBRS-000/PACK_TASKBOARD.json', 'docs/postrust/MBRS-000/PACK_ACCEPTANCE.json', 'docs/postrust/RUST-016/ADMISSION_DECISION.json',
      'scripts/ci/verify-mbrs014-compatibility.mjs', 'docs/postrust/MBRS-014/FROZEN_LEGACY_INPUTS.json',
      'packages/bridge-core/scripts/build-metadata-reader-worker.mjs', 'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs',
      'apps/desktop/electron.vite.config.ts', 'apps/desktop/tsconfig.e2e.json',
      ...packageRoots.flatMap(root => [root + '/package.json', root + '/tsconfig.json',
        ...(root === 'apps/desktop' ? [] : [root + '/tsconfig.test.json'])])]) paths.push(file);
    return [...new Set(paths.filter(file => !file.startsWith('docs/postrust/MBRS-012/evidence/')))].sort();
  };
  const identity = () => sourceNames().map(file => {
    check(); const p = path.join(repository, file), info = lstatSync(p);
    if (!info.isFile() || info.isSymbolicLink()) reject('SOURCE_WRITES_INPUT_NOT_ORDINARY_FILE');
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
  const childEnv = { ...env, TMPDIR: temporary, MBRS003_READER_BUILD_BINDING:path.join(run,'reader-build-binding.json') }, runs = [], failures = [];
  async function capture(stage) {
    check(); const began = performance.now();
    const result = { name: stage.name, directory: stage.directory, expectedTests: stage.expectedTests ?? null,
      argv: ['node', ...stage.args.map(arg => arg === tsc ? 'typescript/bin/tsc' : arg)],
      startedAt: new Date().toISOString(), startedMs:Date.now(), closedMs:null, exitCode: null, signal: null, closeObserved: false,
      timedOut: false, overflow: false, captureFailed: false, preparationFailed: false, groupTerminationFailed: false };
    const chunks = []; let length = 0;
    await new Promise(resolve => {
      let child, timer;
      const terminate = () => { if (!child?.pid) return; try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') result.groupTerminationFailed = true; } };
      try { child = spawn(process.execPath, stage.args, { cwd: path.join(repository, stage.directory), env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { result.preparationFailed = true; resolve(); return; }
      child.once('close', (code, signal) => { clearTimeout(timer); result.closedMs=Date.now();result.exitCode = code; result.signal = signal; result.closeObserved = true; resolve(); });
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
    result.success = sourceWritesStageSucceeded(result); runs.push(result); return result;
  }
  let inputsUnchanged = false,freshReaderCompiler=null,readerDeclaration=null,readerOutputIdentityUnchanged=false;
  try {
    for (const stage of stages){
      const result=await capture(stage);if(!result.success){failures.push('SOURCE_WRITES_STAGE_FAILED_OR_INCOMPLETE');break;}
      if(stage.name==='fresh-core-build'){freshReaderCompiler=captureSourceWritesReaderCompiler(inputs,result);writePrivateJson(temporary,'reader-compiler-closed.json',freshReaderCompiler);}
      if(stage.name==='fresh-core-worker-bundle'){
        check();if(JSON.stringify(identity())!==JSON.stringify(inputs))reject('SOURCE_WRITES_READER_SOURCE_DRIFT');
        const fixed=await readFixedMetadataWorkerBundle(path.join(repository,'packages/bridge-core'));
        const declaration=makeSourceWritesReaderDeclarations(inputs,freshReaderCompiler,fixed.manifest);
        writePrivateJson(run,'reader-build-binding.json',declaration.reader);writePrivateJson(temporary,'namespace-reader-build-binding.json',declaration.namespace);
        readerDeclaration={reader:{bytes:Buffer.byteLength(JSON.stringify(declaration.reader,null,2)+'\n'),sha256:sha(JSON.stringify(declaration.reader,null,2)+'\n')},namespace:declaration.namespace};
      }
    }
    inputsUnchanged = git(['rev-parse', 'HEAD']) === head && JSON.stringify(identity()) === JSON.stringify(inputs);
    if (!inputsUnchanged) failures.push('SOURCE_WRITES_INPUTS_CHANGED_DURING_RUN');
    readerOutputIdentityUnchanged=!!freshReaderCompiler&&freshReaderCompiler.outputs.every(row=>{check();const bytes=readFileSync(path.join(repository,row.path));return bytes.length===row.bytes&&sha(bytes)===row.sha256;});
    if(readerDeclaration&&!readerOutputIdentityUnchanged)failures.push('SOURCE_WRITES_READER_OUTPUT_CHANGED_DURING_RUN');
  } catch (error) { failures.push(error?.code ?? 'SOURCE_WRITES_GATE_EXCEPTION'); }
  const success = failures.length === 0 && runs.length === stages.length && runs.every(sourceWritesStageSucceeded);
  const summary = { schema: 'mbrs012.source-writes-gate.v1', task: 'MBRS-012', baseSha, head, startedAt,
    completedAt: new Date().toISOString(), durationMs: performance.now() - start, success, failures,
    inputScope: 'DECLARED_SOURCE_TEST_CONFIGURATION_INPUTS_NOT_TRANSITIVE_TOOLCHAIN_CLOSURE',
    sourceInputs: inputs, inputsUnchanged,readerDeclaration,readerOutputIdentityUnchanged, runs, completedStages: runs.length, expectedStages: stages.length,
    tests: runs.filter(r => r.expectedTests !== null).reduce((total, r) => total + (r.testCounts?.tests ?? 0), 0),
    pass: runs.filter(r => r.expectedTests !== null).reduce((total, r) => total + (r.testCounts?.pass ?? 0), 0),
    scope: 'FRESH_SOFTWARE_SYNTHETIC_WRITER_AND_TYPES_NOT_APP_OR_REAL_LIBRARY', sourceFilesWrite: 'DEFAULT_OFF_SPECIFIC_QUALIFIED_PLAN_ONLY',
    realProviderAccountRoonAudioOwner: 'NOT_RUN', productionApp: 'NOT_RUN_BY_THIS_GATE' };
  writePrivateJson(run, 'summary.json', summary);
  return { run, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await runSourceWritesGate(); process.stdout.write(JSON.stringify({ success: result.summary.success, tests: result.summary.tests, pass: result.summary.pass, run: result.run }) + '\n'); if (!result.summary.success) process.exitCode = 1; }
  catch (error) { process.stderr.write('012受控源写Gate拒绝：' + (error?.code ?? 'ADMISSION_FAILED') + '\n'); process.exitCode = 1; }
}
