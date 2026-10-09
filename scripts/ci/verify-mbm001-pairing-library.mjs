import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareCoreTestEnvironment, coreTestSourceInputs } from './run-core-tests.mjs';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput } from './verify-mbrs001-offline.mjs';
import { captureMobileStage, mobileStageSucceeded, readMobileFile, mobileInputIdentity } from './verify-mbm000-contract-adoption.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MBM001_BASE = 'c6c4745dfc7fe4242b8a2682798e00605649b12e';
export const MBM001_OPERATIONS = Object.freeze(['getServer','claimPairing','refreshToken','logout','getCapabilities','listAlbums','getAlbum','listTracks','getTrack','getArtwork']);
export const MBM001_BUDGETS = Object.freeze({ stageTimeoutMs: 180000, totalTimeoutMs: 480000, killGraceMs: 10000,
  rawOutputBytes: 16777216, sourceFileBytes: 16777216, maxSourceFiles: 8192 });
const scopePath = 'docs/postrust/MBM-001/EXECUTION_SCOPE.json', testPath = 'docs/postrust/MBM-001/TEST_SCOPE.json';
const canonicalPath = 'packages/contracts/mobile/openapi.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && same([...a].sort(), [...b].sort());
const reject = code => { const error = new Error('MBM001配对和只读曲库Gate拒绝。'); error.code = code; throw error; };
function files(relative) {
  const walk = name => {
    const info = lstatSync(path.join(repository, name)); if (info.isSymbolicLink()) reject('MBM001_SYMLINK_INPUT');
    return info.isDirectory() ? readdirSync(path.join(repository, name)).sort().flatMap(child => walk(name + '/' + child)) : info.isFile() ? [name] : reject('MBM001_NONFILE_INPUT');
  };
  return walk(relative);
}

/** 独立001范围不重写旧任务账本、冻结wire或真实验收。 */
export function assertMbm001Admission({ execution, tests, canonical, canonicalBytes, status, plan, originalPlan, originalStatus, discovered }) {
  if (execution?.schema !== 'musicbridge.mbm001.execution-scope.v1' || execution.task !== 'MBM-001' || execution.baseReportSha !== MBM001_BASE
    || execution.branch !== 'codex/mbm-001-pairing-readonly-library' || execution.canonicalContract !== 'packages/contracts/mobile/openapi.json'
    || execution.canonicalBytes !== 145918 || execution.canonicalSha256 !== 'ee79461bf672e78c4ac29945d794e46286c92b0f909ced85bc4534a8a6de57bb'
    || !Buffer.isBuffer(canonicalBytes) || canonicalBytes.length !== execution.canonicalBytes || sha(canonicalBytes) !== execution.canonicalSha256
    || canonical?.openapi !== '3.1.1' || canonical.info?.version !== '1.6.0' || execution.operationCount !== 40
    || !same(execution.thisStageOperations, MBM001_OPERATIONS) || execution.sourceFilesWrite !== false
    || execution.defaultCore !== 'NODE' || execution.sqliteWriter !== 'EXISTING_DATASET_OWNER_ONLY' || execution.optionalRustReadonly !== 'OFF'
    || execution.newMobileListener !== 'SEPARATE_PRIVATE_HTTPS_DEFAULT_OFF' || execution.realServiceDeviceAudioOwner !== 'NOT_RUN'
    || execution.ownerRepeatedApprovalRequired !== false || !same(execution.gateBudgets, MBM001_BUDGETS)) reject('MBM001_SCOPE_CHANGED');
  const operations = Object.values(canonical.paths ?? {}).flatMap(item => ['get','post','put','patch','delete','head','options','trace'].filter(verb => item?.[verb]).map(verb => item[verb].operationId));
  if (operations.length !== 40 || new Set(operations).size !== 40 || MBM001_OPERATIONS.some(operation => !operations.includes(operation))) reject('MBM001_WIRE_CHANGED');
  if (!same(plan?.tasks, originalPlan?.tasks) || !same(plan?.acceptance_cases, originalPlan?.acceptance_cases)
    || plan.tasks?.length !== 18 || plan.acceptance_cases?.length !== 156) reject('MBM001_ORIGINAL_LEDGER_CHANGED');
  for (const [key, value] of Object.entries(originalStatus ?? {})) if (value?.task?.startsWith?.('MBRS-') && !same(status?.[key], value)) reject('MBM001_ORIGINAL_TASK_STATE_CHANGED');
  const own = status?.mobilePairingReadonlyLibrary, lane = status?.mobileFrontloading20261008;
  if (own?.task !== 'MBM-001' || own.scope !== scopePath || own.baseSha !== MBM001_BASE || own.branch !== execution.branch
    || own.sourceFilesWrite !== false || own.defaultCore !== 'NODE' || own.sqliteWriter !== execution.sqliteWriter || own.optionalRustReadonly !== 'OFF'
    || own.realServiceDeviceAudioOwner !== 'NOT_RUN' || own.ownerRepeatedApprovalRequired !== false
    || lane?.currentTask !== 'MBM-001' || lane.originalTasks !== 18 || lane.originalAcceptanceCases !== 156 || lane.effectiveTasks !== 17 || lane.effectiveAcceptanceCases !== 150
    || plan.execution_schedule?.current_task !== 'MBM-001' || plan.execution_schedule.current_task_scope_ref !== scopePath
    || plan.execution_schedule.predecessor_final_report !== MBM001_BASE) reject('MBM001_AUTHORITY_CHANGED');
  if (tests?.schema !== 'musicbridge.mbm001.test-scope.v1' || tests.task !== 'MBM-001' || tests.baseReportSha !== MBM001_BASE || !same(tests.gateBudgets, MBM001_BUDGETS)) reject('MBM001_TEST_SCOPE_CHANGED');
  for (const area of ['core', 'desktop']) {
    const group = tests[area], found = discovered[area], prefix = area === 'core' ? 'packages/bridge-core/test/mbm001/' : 'apps/desktop/test/mbm001/';
    if (!group || !exact(group.testFiles, found.filter(name => name.endsWith('.test.ts'))) || !exact(group.helperFiles, found.filter(name => !name.endsWith('.test.ts')))
      || group.testFiles.some(name => !name.startsWith(prefix)) || !Number.isSafeInteger(group.expectedTests) || group.expectedTests < 1
      || !Array.isArray(group.caseNames) || group.caseNames.length !== group.expectedTests || new Set(group.caseNames).size !== group.caseNames.length
      || group.caseNames.some(name => typeof name !== 'string' || !name || /[\r\n]/u.test(name))) reject('MBM001_TEST_SCOPE_INCOMPLETE');
  }
  if (!exact(tests.app?.testFiles, ['apps/desktop/e2e/mbm001-mobile-connection.spec.ts']) || !Array.isArray(tests.app.caseNames) || tests.app.expectedTests !== tests.app.caseNames.length
    || !Number.isSafeInteger(tests.app.expectedTests) || tests.app.expectedTests < 1 || new Set(tests.app.caseNames).size !== tests.app.expectedTests
    || tests.app.caseNames.some(name => typeof name !== 'string' || !name || /[\r\n]/u.test(name))
    || tests.app.softwareGate !== 'NOT_RUN_SEPARATE_PRODUCTION_ELECTRON_GATE') reject('MBM001_APP_SCOPE_INCOMPLETE');
  return true;
}

export async function runMbm001Gate(argv = process.argv.slice(2), env = process.env) {
  const admission = validateOfflineArguments(argv, env);
  if (process.versions.node.split('.')[0] !== '22') reject('MBM001_NODE22_REQUIRED');
  const began = performance.now(), remaining = () => MBM001_BUDGETS.totalTimeoutMs - (performance.now() - began);
  const check = () => { if (remaining() <= 0) reject('MBM001_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 16777216 }).trimEnd();
  const read = async relative => (await readMobileFile(path.join(repository, relative), { maxBytes: MBM001_BUDGETS.sourceFileBytes, check, allowEmpty: false })).bytes;
  const json = async relative => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(relative)));
  const execution = await json(scopePath), tests = await json(testPath), status = await json('project/STATUS.json'), plan = await json('project/POSTRUST_PLAN.json');
  const canonicalBytes = await read(canonicalPath), canonical = JSON.parse(canonicalBytes.toString('utf8'));
  const discovered = { core: files('packages/bridge-core/test/mbm001'), desktop: files('apps/desktop/test/mbm001') };
  assertMbm001Admission({ execution, tests, status, plan, canonical, canonicalBytes, discovered,
    originalPlan: JSON.parse(git(['show', MBM001_BASE + ':project/POSTRUST_PLAN.json'])), originalStatus: JSON.parse(git(['show', MBM001_BASE + ':project/STATUS.json'])) });
  git(['merge-base', '--is-ancestor', MBM001_BASE, 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(head) || git(['status','--porcelain','--untracked-files=all'])) reject('MBM001_SOURCE_NOT_CLEAN');
  if ((git(['branch','--show-current']) || env.GITHUB_REF_NAME) !== execution.branch) reject('MBM001_BRANCH_CHANGED');
  const names = () => [...new Set([...coreTestSourceInputs(check).map(row => row.path), ...files('scripts/ci'), ...files('.github/workflows'), ...files('docs/postrust/MBM-001'),
    'AGENTS.md','pnpm-lock.yaml','apps/desktop/tsconfig.e2e.json','apps/desktop/electron.vite.config.ts',
    ...files('apps/desktop/scripts'),execution.canonicalContract,'tasks/MBM-001_PAIRING_READONLY_LIBRARY.md',
    ...['STATUS.json','POSTRUST_PLAN.json','POSTRUST_TODO.md','POSTRUST_PROGRESS.md'].map(name => 'project/' + name)])].sort();
  const inputRows = async () => {
    const list = names(); if (list.length > MBM001_BUDGETS.maxSourceFiles) reject('MBM001_SOURCE_COUNT_EXCEEDED');
    const rows = [];
    for (const relative of list) { const value = await readMobileFile(path.join(repository, relative), { maxBytes: MBM001_BUDGETS.sourceFileBytes, check, allowEmpty: true }); rows.push({ path: relative, bytes: value.identity.bytes, sha256: value.identity.sha256 }); }
    return rows;
  };
  const inputs = await inputRows(), run = createPrivateRun(admission), temporary = path.join(run, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key)));
  Object.assign(childEnv, { TMPDIR: temporary, NODE_ENV: 'test', COREPACK_ENABLE_NETWORK: '0', npm_config_ignore_scripts: 'true' });
  const runs = [], failures = []; let prepared, currentPreparationStage = '', inputsUnchanged = false, artifactsUnchanged = false;
  const unchanged = async () => { check(); if (git(['rev-parse','HEAD']) !== head || git(['status','--porcelain','--untracked-files=all']) || !same(await inputRows(), inputs)) reject('MBM001_SOURCE_DRIFT'); };
  try {
    prepared = await prepareCoreTestEnvironment({ env: childEnv,
      announce: message => { currentPreparationStage = message.split('：').at(-1); },
      execute: (command, args, options) => {
        if (!['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'].includes(currentPreparationStage)) reject('MBM001_PREPARATION_STAGE_CHANGED');
        const startedMs = Date.now(), result = spawnSync(command, args, { ...options, stdio: ['ignore','pipe','pipe'], maxBuffer: MBM001_BUDGETS.rawOutputBytes });
        const raw = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
        writeFileSync(path.join(temporary, 'prepare-' + currentPreparationStage + '.raw.log'), raw, { flag: 'wx', mode: 0o600 });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        const log = 'prepare-' + currentPreparationStage + '.log'; writeFileSync(path.join(run, log), sanitizeOutput(text), { flag: 'wx', mode: 0o600 });
        runs.push({ name: currentPreparationStage, directory: path.relative(repository, options.cwd), argv: [command,...args], startedMs, closedMs: Date.now(),
          exitCode: result.status, signal: result.signal, closeObserved: !result.error, rawBytes: raw.length, rawSha256: sha(raw), log,
          rawCaptureScope: 'COMPLETE_SEPARATE_STDOUT_THEN_STDERR_STREAMS_NOT_ARRIVAL_ORDER', success: !result.error && result.status === 0 && result.signal === null });
        return result;
      } });
    prepared.assertCurrent(); await unchanged();
    writePrivateJson(run, 'reader-preparation.json', prepared.receipt);
    const require = createRequire(path.join(repository,'apps/desktop/package.json')), tsc = require.resolve('typescript/bin/tsc'), vue = require.resolve('vue-tsc/bin/vue-tsc.js');
    const config = path.join(run, 'mobile-test-types.json');
    writePrivateJson(run, path.basename(config), { compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, rootDir: repository,
      typeRoots: [path.join(repository,'apps/desktop/node_modules/@types')], types: ['node'] }, files: [...tests.core.testFiles,...tests.desktop.testFiles].map(file => path.join(repository,file)) });
    const stages = [
      { name: 'mobile-test-types', directory: '.', args: [tsc,'-p',config] },
      { name: 'desktop-types', directory: 'apps/desktop', args: [vue,'--noEmit','-p','tsconfig.json'] },
      { name: 'mobile-app-types', directory: 'apps/desktop', args: [tsc,'--noEmit','-p','tsconfig.e2e.json'] },
      ...['core','desktop'].map(area => ({ name: 'mobile-' + area + '-behavior', directory: area === 'core' ? 'packages/bridge-core' : 'apps/desktop',
        expectedTests: tests[area].expectedTests, caseNames: tests[area].caseNames,
        args: ['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',...tests[area].testFiles.map(file => path.relative(path.join(repository, area === 'core' ? 'packages/bridge-core' : 'apps/desktop'),path.join(repository,file)))] })),
    ];
    for (const stage of stages) {
      prepared.assertCurrent(); await unchanged(); check();
      const actual = await captureMobileStage(stage, { run, temporary, env: prepared.env, budgets: MBM001_BUDGETS, remaining,
        spawnProcess: (command, args, options) => spawn(command,args,{...options,cwd:path.join(repository,stage.directory)}) });
      actual.directory = stage.directory; runs.push(actual);
      if (!mobileStageSucceeded(actual)) { failures.push('MBM001_STAGE_FAILED_OR_INCOMPLETE'); break; }
    }
    prepared.assertCurrent(); artifactsUnchanged = true; await unchanged(); inputsUnchanged = true;
  } catch (error) { failures.push(/^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'MBM001_GATE_EXCEPTION'); }
  const success = runs.length === 8 && runs.every(row => row.success) && failures.length === 0 && inputsUnchanged && artifactsUnchanged && remaining() > 0;
  const behavior = runs.filter(row => row.expectedTests != null);
  const summary = { schema: 'musicbridge.mbm001.pairing-library-gate.v1', task: 'MBM-001', baseReportSha: MBM001_BASE, head,
    startedAt: new Date(Date.now() - (performance.now() - began)).toISOString(), completedAt: new Date().toISOString(), success, failures, gateBudgets: MBM001_BUDGETS,
    operationCount: 40, stageOperationCount: 10, operationCountIsTestCount: false, sourceInputs: inputs, sourceInputIdentity: mobileInputIdentity(inputs), inputsUnchanged,
    freshReaderPreparation: prepared?.receipt ?? null, artifactsUnchanged, runs, expectedStages: 8, completedStages: runs.length,
    expectedTests: tests.core.expectedTests + tests.desktop.expectedTests, tests: behavior.reduce((n,row) => n + (row.testCounts?.tests ?? 0),0), pass: behavior.reduce((n,row) => n + (row.testCounts?.pass ?? 0),0),
    fullTransitiveToolchainClosure: false, inputScope: 'DECLARED_WHOLE_SOURCE_TEST_CONFIGURATION_AND_FRESH_READER_DIRECT_COMPILER_INPUTS',
    productionApp: 'NOT_RUN_SEPARATE_PRODUCTION_ELECTRON_GATE', realServiceDeviceAudioOwner: 'NOT_RUN', pairedFinalDelivery: 'NOT_PROVEN_BY_THIS_MAC_SOFTWARE_GATE' };
  writePrivateJson(run,'summary.json',summary); return { run, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const { run, summary } = await runMbm001Gate(); process.stdout.write(JSON.stringify({ run, success: summary.success, tests: summary.tests, pass: summary.pass, failures: summary.failures }) + '\n'); if (!summary.success) process.exitCode = 1; }
  catch (error) { process.stderr.write('MBM001 Gate拒绝：' + (/^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'ADMISSION_FAILED') + '\n'); process.exitCode = 1; }
}
