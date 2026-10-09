import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareCoreTestEnvironment, coreTestSourceInputs } from './run-core-tests.mjs';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput } from './verify-mbrs001-offline.mjs';
import { captureMobileStage, mobileStageSucceeded, readMobileFile, mobileInputIdentity } from './verify-mbm000-contract-adoption.mjs';
import { MBM002_BASE, MBM002_OPERATIONS, MBM002_BUDGETS, assertMbm002Admission } from './mbm002-admission.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scopePath = 'docs/postrust/MBM-002/EXECUTION_SCOPE.json', testPath = 'docs/postrust/MBM-002/TEST_SCOPE.json';
const canonicalPath = 'packages/contracts/mobile/openapi.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reject = code => { const error = new Error('MBM002手机资源播放Gate拒绝。'); error.code = code; throw error; };
function files(relative) {
  const walk = name => {
    const info = lstatSync(path.join(repository, name)); if (info.isSymbolicLink()) reject('MBM002_SYMLINK_INPUT');
    return info.isDirectory() ? readdirSync(path.join(repository, name)).sort().flatMap(child => walk(name + '/' + child)) : info.isFile() ? [name] : reject('MBM002_NONFILE_INPUT');
  };
  return walk(relative);
}

export async function runMbm002Gate(argv = process.argv.slice(2), env = process.env) {
  const admission = validateOfflineArguments(argv, env);
  if (process.versions.node.split('.')[0] !== '22') reject('MBM002_NODE22_REQUIRED');
  const began = performance.now(), remaining = () => MBM002_BUDGETS.totalTimeoutMs - (performance.now() - began);
  const check = () => { if (remaining() <= 0) reject('MBM002_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 16777216 }).trimEnd();
  const read = async relative => (await readMobileFile(path.join(repository, relative), { maxBytes: MBM002_BUDGETS.sourceFileBytes, check, allowEmpty: false })).bytes;
  const json = async relative => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(relative)));
  const execution = await json(scopePath), tests = await json(testPath), status = await json('project/STATUS.json'), plan = await json('project/POSTRUST_PLAN.json');
  const canonicalBytes = await read(canonicalPath), canonical = JSON.parse(canonicalBytes.toString('utf8'));
  const discovered = { contracts: files('packages/contracts/test').filter(name => name.startsWith('packages/contracts/test/mbm002-')), core: files('packages/bridge-core/test/mbm002'), desktop: files('apps/desktop/test/mbm002') };
  assertMbm002Admission({ execution, tests, status, plan, canonical, canonicalBytes, discovered,
    originalPlan: JSON.parse(git(['show', MBM002_BASE + ':project/POSTRUST_PLAN.json'])), originalStatus: JSON.parse(git(['show', MBM002_BASE + ':project/STATUS.json'])) });
  // 001报告、9个独立AT及其全部冻结证据仍属于原交付，不能由002复写。
  const predecessorFiles = git(['ls-tree', '-r', '--name-only', MBM002_BASE, '--', 'docs/postrust/MBM-001', 'reports/MBM-001_RESULT.md', 'reports/MBM-001_EVIDENCE.json']).split('\n');
  if (!predecessorFiles.length || predecessorFiles.some(name => !name)) reject('MBM002_PREDECESSOR_FILES_MISSING');
  for (const relative of predecessorFiles) {
    const original = execFileSync('git', ['show', MBM002_BASE + ':' + relative], { cwd: repository, timeout: Math.max(1, Math.floor(remaining())), maxBuffer: MBM002_BUDGETS.sourceFileBytes });
    if (!(await read(relative)).equals(original)) reject('MBM002_PREDECESSOR_EVIDENCE_CHANGED');
  }
  git(['merge-base', '--is-ancestor', MBM002_BASE, 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(head) || git(['status','--porcelain','--untracked-files=all'])) reject('MBM002_SOURCE_NOT_CLEAN');
  if ((git(['branch','--show-current']) || env.GITHUB_REF_NAME) !== execution.branch) reject('MBM002_BRANCH_CHANGED');
  const names = () => [...new Set([...coreTestSourceInputs(check).map(row => row.path), ...files('scripts/ci'), ...files('.github/workflows'), ...files('docs/postrust/MBM-002'), ...files('docs/postrust/MBM-003'), ...files('docs/postrust/MBM-001'),
    'AGENTS.md','pnpm-lock.yaml','apps/desktop/tsconfig.e2e.json','apps/desktop/electron.vite.config.ts',
    ...files('apps/desktop/scripts'),canonicalPath,'tasks/MBM-002_PHONE_RESOURCE_PLAYBACK.md', 'reports/MBM-001_RESULT.md', 'reports/MBM-001_EVIDENCE.json',
    ...['STATUS.json','POSTRUST_PLAN.json','POSTRUST_TODO.md','POSTRUST_PROGRESS.md'].map(name => 'project/' + name)])].sort();
  const inputRows = async () => {
    const list = names(); if (list.length > MBM002_BUDGETS.maxSourceFiles) reject('MBM002_SOURCE_COUNT_EXCEEDED');
    const rows = [];
    for (const relative of list) { const value = await readMobileFile(path.join(repository, relative), { maxBytes: MBM002_BUDGETS.sourceFileBytes, check, allowEmpty: true }); rows.push({ path: relative, bytes: value.identity.bytes, sha256: value.identity.sha256 }); }
    return rows;
  };
  const inputs = await inputRows(), run = createPrivateRun(admission), temporary = path.join(run, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key)));
  Object.assign(childEnv, { TMPDIR: temporary, NODE_ENV: 'test', COREPACK_ENABLE_NETWORK: '0', npm_config_ignore_scripts: 'true' });
  const runs = [], failures = []; let prepared, currentPreparationStage = '', inputsUnchanged = false, artifactsUnchanged = false;
  const unchanged = async () => { check(); if (git(['rev-parse','HEAD']) !== head || git(['status','--porcelain','--untracked-files=all']) || !same(await inputRows(), inputs)) reject('MBM002_SOURCE_DRIFT'); };
  try {
    prepared = await prepareCoreTestEnvironment({ env: childEnv,
      announce: message => { currentPreparationStage = message.split('：').at(-1); },
      execute: (command, args, options) => {
        if (!['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'].includes(currentPreparationStage)) reject('MBM002_PREPARATION_STAGE_CHANGED');
        const startedMs = Date.now(), result = spawnSync(command, args, { ...options, stdio: ['ignore','pipe','pipe'], maxBuffer: MBM002_BUDGETS.rawOutputBytes });
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
      typeRoots: [path.join(repository,'apps/desktop/node_modules/@types')], types: ['node'] }, files: [...tests.contracts.testFiles,...tests.core.testFiles,...tests.desktop.testFiles].map(file => path.join(repository,file)) });
    const stages = [
      { name: 'mobile-test-types', directory: '.', args: [tsc,'-p',config] },
      { name: 'desktop-types', directory: 'apps/desktop', args: [vue,'--noEmit','-p','tsconfig.json'] },
      { name: 'mobile-app-types', directory: 'apps/desktop', args: [tsc,'--noEmit','-p','tsconfig.e2e.json'] },
      ...['contracts','core','desktop'].map(area => ({ name: 'mobile-' + area + '-behavior', directory: area === 'contracts' ? 'packages/contracts' : area === 'core' ? 'packages/bridge-core' : 'apps/desktop',
        expectedTests: tests[area].expectedTests, caseNames: tests[area].caseNames,
        args: ['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',...tests[area].testFiles.map(file => path.relative(path.join(repository, area === 'contracts' ? 'packages/contracts' : area === 'core' ? 'packages/bridge-core' : 'apps/desktop'),path.join(repository,file)))] })),
    ];
    for (const stage of stages) {
      prepared.assertCurrent(); await unchanged(); check();
      const actual = await captureMobileStage(stage, { run, temporary, env: prepared.env, budgets: MBM002_BUDGETS, remaining,
        spawnProcess: (command, args, options) => spawn(command,args,{...options,cwd:path.join(repository,stage.directory)}) });
      actual.directory = stage.directory; runs.push(actual);
      if (!mobileStageSucceeded(actual)) { failures.push('MBM002_STAGE_FAILED_OR_INCOMPLETE'); break; }
    }
    prepared.assertCurrent(); artifactsUnchanged = true; await unchanged(); inputsUnchanged = true;
  } catch (error) { failures.push(/^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'MBM002_GATE_EXCEPTION'); }
  const success = runs.length === 9 && runs.every(row => row.success) && failures.length === 0 && inputsUnchanged && artifactsUnchanged && remaining() > 0;
  const behavior = runs.filter(row => row.expectedTests != null);
  const summary = { schema: 'musicbridge.mbm002.resource-playback-gate.v1', task: 'MBM-002', baseSha: MBM002_BASE, head,
    startedAt: new Date(Date.now() - (performance.now() - began)).toISOString(), completedAt: new Date().toISOString(), success, failures, gateBudgets: MBM002_BUDGETS,
    operationCount: 40, stageOperationCount: MBM002_OPERATIONS.length, operationCountIsTestCount: false, sourceInputs: inputs, sourceInputIdentity: mobileInputIdentity(inputs), inputsUnchanged,
    freshReaderPreparation: prepared?.receipt ?? null, artifactsUnchanged, runs, expectedStages: 9, completedStages: runs.length,
    expectedTests: tests.contracts.expectedTests + tests.core.expectedTests + tests.desktop.expectedTests, tests: behavior.reduce((n,row) => n + (row.testCounts?.tests ?? 0),0), pass: behavior.reduce((n,row) => n + (row.testCounts?.pass ?? 0),0),
    fullTransitiveToolchainClosure: false, inputScope: 'DECLARED_WHOLE_SOURCE_TEST_CONFIGURATION_AND_FRESH_READER_DIRECT_COMPILER_INPUTS',
    productionApp: 'NOT_RUN_SEPARATE_PRODUCTION_ELECTRON_GATE', realServiceDeviceAudioOwner: 'NOT_RUN', pairedFinalDelivery: 'NOT_PROVEN_BY_THIS_MAC_SOFTWARE_GATE' };
  writePrivateJson(run,'summary.json',summary); return { run, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const { run, summary } = await runMbm002Gate(); process.stdout.write(JSON.stringify({ run, success: summary.success, tests: summary.tests, pass: summary.pass, failures: summary.failures }) + '\n'); if (!summary.success) process.exitCode = 1; }
  catch (error) { process.stderr.write('MBM002 Gate拒绝：' + (/^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'ADMISSION_FAILED') + '\n'); process.exitCode = 1; }
}
