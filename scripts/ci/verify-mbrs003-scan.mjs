import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';

import { readSnapshot04LoadEvidence, SCALE_RECEIPT_FAILURES } from './mbrs003-scale-receipts.mjs';
import { readOwnerAcceptedHistoricalScale, OWNER_STAGE_SCALE_FAILURES } from './mbrs003-owner-stage-scale.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = 'a7b27b5b6a5168bd146a3cbe61b579efd5639263';
const scopePath = 'scripts/ci/mbrs003-scan-scope.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const readerSources = ['src/recording/source-files.ts','src/library/metadata-reader.ts','src/library/metadata-reader-worker.ts','src/library/metadata-reader-types.ts'];
const testPackages = ['packages/contracts','packages/bridge-core','apps/desktop'];
const cueSources = ['src/library/cue-sidecar-reader.ts','src/library/cue-sidecar-worker.ts'];
const startupSources = ['src/utility-main.ts','src/rust-core/optional-readonly-manager.ts','src/collection/dataset-owner-client.ts','src/collection/dataset-domain.ts','src/collection/dataset-owner-worker.ts'];
const startupFixtureSource = 'test/helpers/dataset-owner-fixture.ts';
const layers = ['UNIT','COMPILED_READER','PRIORITY_INTEGRATION'];
const relativeFile = value => typeof value === 'string' && value.length < 512 && !path.isAbsolute(value)
  && !value.split('/').includes('..') && !/[\u0000-\u001f\\]/u.test(value);
const caughtCodes = new Set([...SCALE_RECEIPT_FAILURES, ...OWNER_STAGE_SCALE_FAILURES, 'COUNTS_NOT_CONFIRMED','DECLARED_FILE_IDENTITY_INVALID', 'DECLARED_PATH_INVALID', 'EVIDENCE_LAYER_INCOMPLETE', 'FIXED_PNPM_REQUIRED', 'FIXTURE_SYMLINK', 'FRESH_COMPILER_SOURCE_EMPTY', 'FRESH_OUTPUT_MTIME_INVALID', 'FROZEN_TEST_GROUP_INVALID', 'FROZEN_TEST_PATH_INVALID', 'GATE_TOTAL_BUDGET_EXHAUSTED', 'IMPLEMENTATION_OR_SCOPE_INCOMPLETE', 'INCREMENTAL_BUILD_NOT_ADMITTED', 'NESTED_TEST_INVENTORY_MISMATCH', 'NESTED_TEST_SYMLINK', 'NODE22_REQUIRED', 'PNPM_STORE_OUTSIDE_CACHE', 'PRE_BINDING_SOURCE_DRIFT', 'READER_FRESH_CORE_REQUIRED', 'READER_FRESH_OUTPUT_SOURCE_MISMATCH', 'READER_SOURCE_MISSING', 'TSCONFIG_EXTENDS_CYCLE', 'TSCONFIG_EXTENDS_OUTSIDE_REPO', 'UNDECLARED_TSCONFIG_EXTENDS']);
const safeCaughtCode = (error,fallback) => caughtCodes.has(error?.code) ? error.code : fallback;
const failWith = code => { const error = new Error('003 Gate 未达到冻结或身份准入。'); error.code = code; throw error; };
/** 文件发现独立于Git ignore；忽略的nested测试也不能被主glob漏过。 */
export function discoverNestedTests(root = repository) {
  const found = [];
  for (const directory of testPackages) {
    const relative = `${directory}/test/mbrs003`;
    const walk = name => {
      const info = lstatSync(path.join(root,name), { throwIfNoEntry:false });
      if (!info) return;
      if (info.isSymbolicLink()) failWith('NESTED_TEST_SYMLINK');
      if (info.isDirectory()) for (const entry of readdirSync(path.join(root,name)).sort()) walk(`${name}/${entry}`);
      else if (info.isFile() && name.endsWith('.test.ts')) found.push(name);
    };
    walk(relative);
  }
  return found.sort();
}
/** enabled与固定非零计数由主控完整冻结；文件名/哈希不能代替实际TAP运行。 */
export function assertFinalScope(scope, discovered) {
  if (scope?.schema !== 'mbrs003.scan-gate-scope.v2' || scope.status !== 'FINAL_NESTED_SOFTWARE_FROZEN'
    || scope.implementationComplete !== true || !Array.isArray(scope.groups)) failWith('IMPLEMENTATION_OR_SCOPE_INCOMPLETE');
  if (scope.countsConfirmed !== true) failWith('COUNTS_NOT_CONFIRMED');
  const groups = scope.groups, names = new Set(), expected = [];
  if (!groups.length || !layers.every(layer => groups.some(g => g.layer === layer))
    || !testPackages.every(directory => groups.some(g => g.directory === directory && g.layer === 'UNIT'))) failWith('EVIDENCE_LAYER_INCOMPLETE');
  for (const group of groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name) || !layers.includes(group.layer)
      || !testPackages.includes(group.directory)
      || (group.layer !== 'UNIT' && group.directory !== 'packages/bridge-core')
      || !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0
      || !Array.isArray(group.tests) || !group.tests.length) failWith('FROZEN_TEST_GROUP_INVALID');
    names.add(group.name);
    for (const test of group.tests) {
      if (!relativeFile(test) || !/^test\/mbrs003\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.ts$/u.test(test)) failWith('FROZEN_TEST_PATH_INVALID');
      expected.push(`${group.directory}/${test}`);
    }
  }
  if (new Set(expected).size !== expected.length || JSON.stringify([...expected].sort()) !== JSON.stringify([...discovered].sort())) failWith('NESTED_TEST_INVENTORY_MISMATCH');
  return groups;
}
function declaredFiles(budget) {
  const prefixes = ['packages/contracts/src','packages/bridge-core/src','packages/contracts/test','packages/bridge-core/test','apps/desktop/src','apps/desktop/test','apps/desktop/e2e'];
  const names = new Set(budgetedGit(['ls-files','--cached','--others','--exclude-standard','-z','--',...prefixes],budget,'SOURCE_INVENTORY').split('\0').filter(Boolean));
  for (const relative of ['scripts/ci/verify-mbrs003-scan.mjs',scopePath,'scripts/ci/test/verify-mbrs003-scan.test.mjs',
    'scripts/ci/prepare-build-workspace-mirror.mjs','scripts/ci/test/metadata-reader-fixed-bundle-v2.test.mjs',
    'scripts/ci/mbrs003-scale-receipts.mjs','scripts/ci/mbrs003-owner-stage-scale.mjs','scripts/ci/test/mbrs003-owner-stage-scale.test.mjs',
    'docs/postrust/MBRS-003/OWNER_STAGE_ACCEPTANCE_2026-10-06.json',
    'docs/postrust/MBRS-003/evidence/historical-new06-result300k.json','docs/postrust/MBRS-003/evidence/historical-new06-gate.json',
    'docs/postrust/MBRS-003/evidence/historical-new06-timeout-code-counts.json','docs/postrust/MBRS-003/evidence/historical-new06-timeout-code-closure.json',
    'scripts/ci/verify-mbrs001-offline.mjs','apps/desktop/scripts/build-storage-root.mjs','apps/desktop/scripts/build-storage-root.d.mts',
    '.github/workflows/verify.yml','.github/workflows/electron-e2e.yml','package.json','pnpm-lock.yaml','pnpm-workspace.yaml',
    'packages/contracts/package.json','packages/bridge-core/package.json','apps/desktop/package.json','apps/desktop/electron.vite.config.ts',
    'packages/bridge-core/scripts/build-metadata-reader-worker.mjs','packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs','packages/bridge-core/scripts/metadata-reader-bundle-artifacts.d.mts',
    'apps/desktop/scripts/metadata-worker-bundle-package.mjs','apps/desktop/scripts/metadata-worker-bundle-package.d.mts',
    'apps/desktop/tsconfig.json','apps/desktop/tsconfig.e2e.json',
    'packages/contracts/tsconfig.json','packages/contracts/tsconfig.test.json','packages/bridge-core/tsconfig.json','packages/bridge-core/tsconfig.test.json']) names.add(relative);
  for (const test of discoverNestedTests()) names.add(test);
  const walkFixture = relative => {
    budget.check('FIXTURE_INVENTORY');
    const info = lstatSync(path.join(repository,relative), { throwIfNoEntry:false });
    if (!info) return;
    if (info.isSymbolicLink()) failWith('FIXTURE_SYMLINK');
    if (info.isDirectory()) for (const entry of readdirSync(path.join(repository,relative)).sort()) walkFixture(`${relative}/${entry}`);
    else if (info.isFile()) names.add(relative);
  };
  walkFixture('packages/bridge-core/test/fixtures/mbrs003');
  walkFixture('packages/bridge-core/test/mbrs003/fixtures');
  const addExtends = (relative, seen = new Set()) => {
    if (seen.has(relative)) failWith('TSCONFIG_EXTENDS_CYCLE'); seen.add(relative);
    const config = JSON.parse(readFileSync(path.join(repository,relative),'utf8'));
    if (config.compilerOptions?.incremental === true || config.compilerOptions?.composite === true) failWith('INCREMENTAL_BUILD_NOT_ADMITTED');
    if (config.extends === undefined) return;
    if (typeof config.extends !== 'string' || !config.extends.startsWith('.')) failWith('UNDECLARED_TSCONFIG_EXTENDS');
    let resolved = path.resolve(repository,path.dirname(relative),config.extends);
    if (!resolved.endsWith('.json')) resolved += '.json';
    const next = path.relative(repository,resolved).split(path.sep).join('/');
    if (!relativeFile(next)) failWith('TSCONFIG_EXTENDS_OUTSIDE_REPO'); names.add(next); addExtends(next,seen);
  };
  for (const name of ['packages/contracts/tsconfig.json','packages/contracts/tsconfig.test.json','packages/bridge-core/tsconfig.json','packages/bridge-core/tsconfig.test.json','apps/desktop/tsconfig.json','apps/desktop/tsconfig.e2e.json']) addExtends(name);
  return [...names].sort();
}
function fileIdentity(relative, budget, phase = 'SOURCE_HASH') {
  budget.check(phase);
  if (!relativeFile(relative)) failWith('DECLARED_PATH_INVALID');
  const filename = path.join(repository,relative), info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(filename) !== filename) failWith('DECLARED_FILE_IDENTITY_INVALID');
  const bytes = readFileSync(filename); budget.check(phase);
  return { path:relative,bytes:bytes.length,sha256:sha(bytes) };
}
function sourceIdentity(budget) { return declaredFiles(budget).map(relative => fileIdentity(relative,budget)); }
function freshOutputs(packageName, sources, result, budget) {
  const prefix = `packages/${packageName}/src/`, packageRoot = `packages/${packageName}/`;
  const sourceFiles = sources.filter(row => row.path.startsWith(prefix) && row.path.endsWith('.ts') && !row.path.endsWith('.d.ts'));
  if (!sourceFiles.length) failWith('FRESH_COMPILER_SOURCE_EMPTY');
  const outputs = [];
  for (const source of sourceFiles) for (const suffix of ['.js','.d.ts','.js.map']) {
    const relative = `${packageRoot}dist/${source.path.slice(prefix.length,-3)}${suffix}`;
    const row = fileIdentity(relative,budget,'FRESH_OUTPUT_HASH'), info = lstatSync(path.join(repository,relative));
    if (info.mtimeMs < result.startedMs || info.mtimeMs > Date.parse(result.captureCompletedAt)) failWith('FRESH_OUTPUT_MTIME_INVALID');
    outputs.push({ ...row,sourcePath:source.path,sourceSha256:source.sha256,mtimeMs:info.mtimeMs });
  }
  return { compilerExit:0,compilerStartedAtMs:result.startedMs,compilerFinishedAtMs:Date.parse(result.captureCompletedAt),
    sourceCount:sourceFiles.length,outputCount:outputs.length,outputs };
}
/** Reader四源/八JS-map结构沿真实helper，摘要始终来自本次precompile与fresh输出。 */
export function makeReaderBinding(sources, freshCore) { return makeBinding(readerSources,'mbrs003.reader.fresh-build.v1',sources,freshCore); }
/** v1仅保留历史工厂；当前固定bundle实际路径必须使用独立v2。 */
export function makeReaderBundleBinding(sources, freshCore, fixedWorkerBundle) {
  if (fixedWorkerBundle?.schema !== 'mbrs003.metadata-worker.fixed-bundle.v2') failWith('READER_FRESH_OUTPUT_SOURCE_MISMATCH');
  return { ...makeReaderBinding(sources,freshCore),schema:'mbrs003.reader.fresh-build.v2',fixedWorkerBundle };
}
export function makeCueBinding(sources, freshCore) { return makeBinding(cueSources,'mbrs003.cue.fresh-build.v1',sources,freshCore); }
/** 启动链五编译源/十JS-map，真实Owner fixture只绑定输入，不伪造测试编译输出。 */
export function makeStartupBinding(sources, freshCore) {
  const binding = makeBinding(startupSources,'mbrs003.utility-startup.fresh-build.v1',sources,freshCore);
  const fixture = sources.find(item => item.path === 'packages/bridge-core/' + startupFixtureSource);
  if (!fixture) failWith('READER_SOURCE_MISSING');
  binding.sourceInputs.push({ file:startupFixtureSource,bytes:fixture.bytes,sha256:fixture.sha256 });
  return binding;
}
function makeBinding(bindingSources, schema, sources, freshCore) {
  const prefix = 'packages/bridge-core/';
  if (freshCore?.compilerExit !== 0 || !Array.isArray(freshCore.outputs)) failWith('READER_FRESH_CORE_REQUIRED');
  const sourceInputs = bindingSources.map(file => {
    const row = sources.find(item => item.path === prefix + file);
    if (!row) failWith('READER_SOURCE_MISSING'); return { file,bytes:row.bytes,sha256:row.sha256 };
  });
  const outputs = [];
  for (const source of sourceInputs) for (const suffix of ['.js','.js.map']) {
    const file = source.file.replace(/^src\//u,'dist/').slice(0,-3) + suffix;
    const row = freshCore.outputs.find(item => item.path === prefix + file);
    if (!row || row.sourceSha256 !== source.sha256) failWith('READER_FRESH_OUTPUT_SOURCE_MISMATCH');
    outputs.push({ file,bytes:row.bytes,sha256:row.sha256 });
  }
  return { schema,compilerExit:0,
    compilerStartedAtMs:freshCore.compilerStartedAtMs,compilerFinishedAtMs:freshCore.compilerFinishedAtMs,sourceInputs,outputs };
}
function outputsUnchanged(rows,budget) {
  return rows.every(item => { const current = fileIdentity(item.path,budget,'FINAL_OUTPUT_HASH'); return current.bytes === item.bytes && current.sha256 === item.sha256; });
}
/** Owner调整阶段验收时只核固定历史记录；旧严格规模分支保持原合同。 */
async function readStageLoadDecision(scope,admission,budget) {
  if (scope.stageLoadDecision !== undefined) {
    return readOwnerAcceptedHistoricalScale(scope.stageLoadDecision,repository,budget);
  }
  return readSnapshot04LoadEvidence(scope.scanLoad,admission,budget);
}
export async function runScanGate(argv = process.argv.slice(2), env = process.env) {
  const budget = createBudget();
  const admission = validateOfflineArguments(argv,env);
  const run = createPrivateRun(admission);
  const runs = [], failures = []; let phase = 'PREPARATION', gitHead = null, sources = [], scope = null, groups = [], stages = [];
  let freshContracts = null, freshCore = null, readerBinding = null, readerBindingIdentity = null, sourceInputsUnchanged = false, outputsIdentityUnchanged = false;
  let sourceVerification = 'NOT_STARTED', outputVerification = 'NOT_STARTED';
  let cueBinding = null, cueBindingIdentity = null, startupBinding = null, startupBindingIdentity = null, scanLoadEvidence = null, incompleteReasons = [];
  const fail = (code,where = phase) => { if (!failures.some(f => f.code === code && f.phase === where)) failures.push({ code,phase:where }); };
  try {
    budget.check(phase);
    if (Number(process.versions.node.split('.')[0]) !== 22) failWith('NODE22_REQUIRED');
    const rootPackage = JSON.parse(readFileSync(path.join(repository,'package.json'),'utf8'));
    if (rootPackage.packageManager !== 'pnpm@10.17.1') failWith('FIXED_PNPM_REQUIRED');
    // 未冻结先明确INCOMPLETE，不让Git/源码准备遮蔽停用原因，更不进入产品阶段。
    scope = JSON.parse(readFileSync(path.join(repository,scopePath),'utf8'));
    incompleteReasons = Array.isArray(scope.pendingPrerequisites) ? scope.pendingPrerequisites.map(item=>item.code).filter(code=>/^[A-Z0-9_]{1,80}$/u.test(code)) : [];
    if (scope.status !== 'FINAL_NESTED_SOFTWARE_FROZEN' || scope.implementationComplete !== true) failWith('IMPLEMENTATION_OR_SCOPE_INCOMPLETE');
    groups = assertFinalScope(scope,discoverNestedTests());
    phase = 'SCAN_LOAD_TERMINAL_RECEIPTS';
    // 只核阶段决定或已终结规模收据；本Gate始终不执行规模扫描。
    scanLoadEvidence = await readStageLoadDecision(scope,admission,budget);
    phase = 'PREPARATION';
    budgetedGit(['merge-base','--is-ancestor',base,'HEAD'],budget,'BASE_ANCESTRY');
    gitHead = head(budget); sources = sourceIdentity(budget);
    const coreRequire = createRequire(path.join(repository,'packages/bridge-core/package.json'));
    const tsc = coreRequire.resolve('typescript/bin/tsc');
    const desktopRequire = createRequire(path.join(repository,'apps/desktop/package.json'));
    const vueTsc = desktopRequire.resolve('vue-tsc/bin/vue-tsc.js');
    const temporary = path.join(run,'tmp'); mkdirSync(temporary,{ mode:0o700 });
    const childEnv = {};
    for (const key of ['PATH','HOME','LANG','LC_ALL','DEV_BUILD_ROOT','DEV_CACHE_ROOT','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_TEMP','COREPACK_HOME','npm_config_cache','npm_config_store_dir']) if (typeof env[key] === 'string') childEnv[key] = env[key];
    Object.assign(childEnv,{ TMPDIR:temporary,NODE_ENV:'test',MUSIC_BRIDGE_CORE_TEST_MODE:'1',COREPACK_ENABLE_NETWORK:'0',npm_config_ignore_scripts:'true',MBRS003_READER_BUILD_BINDING:path.join(run,'reader-build-binding.json'),MBRS003_CUE_BUILD_BINDING:path.join(run,'cue-build-binding.json'),MBRS003_STARTUP_BUILD_BINDING:path.join(run,'startup-build-binding.json') });
    // Corepack不会联网补装；缺外置固定版本缓存即实际准备失败，不能回落HOME。
    childEnv.COREPACK_HOME ??= path.join(admission.cache,'corepack'); admission.storage.check(childEnv.COREPACK_HOME);
    if (childEnv.npm_config_store_dir !== undefined) {
      const store = admission.storage.check(childEnv.npm_config_store_dir);
      if (store !== admission.cache && !store.startsWith(admission.cache + path.sep)) failWith('PNPM_STORE_OUTSIDE_CACHE');
    }
    stages = [
      { name:'pnpm-version',directory:'packages/bridge-core',command:'corepack',args:['pnpm@10.17.1','--version'] },
      { name:'fresh-contracts-build',directory:'packages/contracts',args:[tsc,'-p','tsconfig.json'],display:['typescript/bin/tsc','-p','tsconfig.json'] },
      { name:'fresh-core-build',directory:'packages/bridge-core',args:[tsc,'-p','tsconfig.json'],display:['typescript/bin/tsc','-p','tsconfig.json'] },
      { name:'fresh-core-worker-bundle',directory:'packages/bridge-core',args:['scripts/build-metadata-reader-worker.mjs'] },
      { name:'contracts-noemit',directory:'packages/contracts',args:[tsc,'-p','tsconfig.test.json','--noEmit'],display:['typescript/bin/tsc','-p','tsconfig.test.json','--noEmit'] },
      { name:'core-noemit',directory:'packages/bridge-core',args:[tsc,'-p','tsconfig.test.json','--noEmit'],display:['typescript/bin/tsc','-p','tsconfig.test.json','--noEmit'] },
      { name:'desktop-vue-noemit',directory:'apps/desktop',args:[vueTsc,'--noEmit','-p','tsconfig.json'],display:['vue-tsc/bin/vue-tsc.js','--noEmit','-p','tsconfig.json'] },
      { name:'desktop-e2e-noemit',directory:'apps/desktop',args:[tsc,'--noEmit','-p','tsconfig.e2e.json'],display:['typescript/bin/tsc','--noEmit','-p','tsconfig.e2e.json'] },
      ...groups.map(group => { const require = createRequire(path.join(repository,group.directory,'package.json')); return { ...group,args:['--import',pathToFileURL(require.resolve('tsx')).href,'--test','--test-concurrency=1','--test-reporter=tap',...group.tests] }; }),
    ];
    for (const stage of stages) {
      phase = stage.name; budget.check(phase);
      const result = await capture(run,stage,childEnv,budget,runs);
      if (stage.name === 'fresh-contracts-build' && stageExecutionCaptured(result)) freshContracts = freshOutputs('contracts',sources,result,budget);
      if (stage.name === 'fresh-core-build' && stageExecutionCaptured(result)) {
        freshCore = freshOutputs('bridge-core',sources,result,budget);
        // 先确认编译输入不变，再签本次Reader动态绑定；日志EIO不抹去真实编译输出。
        if (JSON.stringify(sourceIdentity(budget)) !== JSON.stringify(sources)) failWith('PRE_BINDING_SOURCE_DRIFT');

        cueBinding = makeCueBinding(sources,freshCore); writePrivateJson(run,'cue-build-binding.json',cueBinding);
        const cueBytes = readFileSync(path.join(run,'cue-build-binding.json'));
        cueBindingIdentity = { file:'cue-build-binding.json',bytes:cueBytes.length,sha256:sha(cueBytes) };
        startupBinding = makeStartupBinding(sources,freshCore); writePrivateJson(run,'startup-build-binding.json',startupBinding);
        const startupBytes = readFileSync(path.join(run,'startup-build-binding.json'));
        startupBindingIdentity = { file:'startup-build-binding.json',bytes:startupBytes.length,sha256:sha(startupBytes) };
      }
      if (stage.name === 'fresh-core-worker-bundle' && stagePassed(result)) {
        if (JSON.stringify(sourceIdentity(budget)) !== JSON.stringify(sources)) failWith('PRE_BINDING_SOURCE_DRIFT');
        const fixed = await readFixedMetadataWorkerBundle(path.join(repository,'packages/bridge-core'),()=>budget.check('WORKER_BUNDLE_HASH'));
        readerBinding = makeReaderBundleBinding(sources,freshCore,fixed.manifest); writePrivateJson(run,'reader-build-binding.json',readerBinding);
        const bindingBytes = readFileSync(path.join(run,'reader-build-binding.json'));
        readerBindingIdentity = { file:'reader-build-binding.json',bytes:bindingBytes.length,sha256:sha(bindingBytes) };
      }
      if (result.logWriteFailed) fail('PRIVATE_LOG_WRITE_FAILED');
      if (result.gateBudgetTimedOut) fail('GATE_TOTAL_BUDGET_EXHAUSTED');
      if (result.stageTimedOut) fail('STAGE_TIME_LIMIT_EXCEEDED');
      if (result.groupTerminationFailed) fail('OWNED_GROUP_TERMINATION_FAILED');
      if (!stagePassed(result)) { fail('STAGE_FAILED_OR_INCOMPLETE'); break; }
    }
  } catch (error) {
    // 任意底层异常code也可能含私有诊断；仅发布本Gate有限大写状态码。
    fail(safeCaughtCode(error,'EXECUTION_OR_PREPARATION_EXCEPTION'));
  }
  finally {
    if (sources.length) {
      phase = 'FINAL_SOURCE_IDENTITY';
      try { budget.check(phase); sourceInputsUnchanged = head(budget) === gitHead && JSON.stringify(sourceIdentity(budget)) === JSON.stringify(sources); sourceVerification = 'COMPLETE'; if (!sourceInputsUnchanged) fail('DECLARED_SOURCE_OR_HEAD_DRIFT'); }
      catch (error) { sourceVerification = 'INCOMPLETE'; fail(safeCaughtCode(error,'FINAL_SOURCE_IDENTITY_EXCEPTION')); }
    }
    phase = 'FINAL_OUTPUT_IDENTITY';
    try {
      budget.check(phase);
      if (!freshContracts || !freshCore || !readerBinding || !readerBindingIdentity || !cueBinding || !cueBindingIdentity || !startupBinding || !startupBindingIdentity) fail('FRESH_OUTPUT_OR_READER_BINDING_UNAVAILABLE');
      else {
        const bindingFile = path.join(run,readerBindingIdentity.file),info = lstatSync(bindingFile),bindingBytes = readFileSync(bindingFile);
        const bindingUnchanged = info.isFile() && !info.isSymbolicLink() && bindingBytes.length === readerBindingIdentity.bytes && sha(bindingBytes) === readerBindingIdentity.sha256;
        const cueFile = path.join(run,cueBindingIdentity.file),cueInfo = lstatSync(cueFile),cueBytes = readFileSync(cueFile);
        const cueUnchanged = cueInfo.isFile() && !cueInfo.isSymbolicLink() && cueBytes.length === cueBindingIdentity.bytes && sha(cueBytes) === cueBindingIdentity.sha256;
        const startupFile = path.join(run,startupBindingIdentity.file),startupInfo = lstatSync(startupFile),startupBytes = readFileSync(startupFile);
        const startupUnchanged = startupInfo.isFile() && !startupInfo.isSymbolicLink() && startupBytes.length === startupBindingIdentity.bytes && sha(startupBytes) === startupBindingIdentity.sha256;
        const fixedAfter = await readFixedMetadataWorkerBundle(path.join(repository,'packages/bridge-core'),()=>budget.check('FINAL_WORKER_BUNDLE_HASH'));
        outputsIdentityUnchanged = JSON.stringify(fixedAfter.manifest) === JSON.stringify(readerBinding.fixedWorkerBundle)
          && bindingUnchanged && cueUnchanged && startupUnchanged && outputsUnchanged([...freshContracts.outputs,...freshCore.outputs],budget);
        outputVerification = 'COMPLETE'; if (!outputsIdentityUnchanged) fail('CONSUMED_OUTPUT_OR_READER_BINDING_DRIFT');
      }
    } catch (error) { outputVerification = 'INCOMPLETE'; fail(safeCaughtCode(error,'FINAL_OUTPUT_IDENTITY_EXCEPTION')); }
    if (!stages.length || runs.length !== stages.length) fail('STAGES_INCOMPLETE','FINAL_SUCCESS_DECISION');
    try { budget.check('FINAL_SUCCESS_DECISION'); } catch (error) { fail(safeCaughtCode(error,'FINAL_SUCCESS_DECISION_EXCEPTION'),'FINAL_SUCCESS_DECISION'); }
    // 最终再核相同阶段决定及证据，拒绝运行期间的输入替换。
    if (scanLoadEvidence) {
      try { const finalLoad = await readStageLoadDecision(scope,admission,budget);
        if (JSON.stringify(finalLoad) !== JSON.stringify(scanLoadEvidence)) fail('SCAN_LOAD_SNAPSHOT_DRIFT','FINAL_LOAD_IDENTITY');
      } catch (error) { fail(safeCaughtCode(error,'SCAN_LOAD_IDENTITY_INVALID'),'FINAL_LOAD_IDENTITY'); }
    }
    const success = failures.length === 0 && runs.every(stagePassed) && sourceInputsUnchanged && outputsIdentityUnchanged && scanLoadEvidence !== null;
    const evidenceLayers = Object.fromEntries(layers.map(layer => {
      const expected = groups.filter(group => group.layer === layer), actual = runs.filter(item => expected.some(group => group.name === item.name));
      return [layer,{ status:expected.length && actual.length === expected.length && actual.every(stagePassed) ? 'FINITE_SOFTWARE_STAGES_PASSED' : 'INCOMPLETE_OR_NOT_RUN',stageNames:expected.map(g => g.name),atAcceptance:'NOT_INFERRED' }];
    }));
    evidenceLayers.SCAN_LOAD = scanLoadEvidence ?? { status:'INCOMPLETE_OR_NOT_RUN',atAcceptance:'NOT_INFERRED',noScaleExecutionInGate:true };
    try {
      writePrivateJson(run,'manifest.json',{ schema:'mbrs003.scan-gate.v1',startedAt:budget.startedAt,completedAt:now(),success,
        status:success ? (scanLoadEvidence?.ownerAcceptedHistoricalScale ? 'FINITE_SOFTWARE_GATE_SUCCESS_WITH_OWNER_SCALE_CARRYOVER' : 'FINITE_SOFTWARE_GATE_SUCCESS') : failures.some(f => ['IMPLEMENTATION_OR_SCOPE_INCOMPLETE','COUNTS_NOT_CONFIRMED','SCAN_LOAD_TERMINAL_ADAPTER_MISSING','SCAN_LOAD_PROFILE_NOT_TERMINAL'].includes(f.code)) ? 'INCOMPLETE' : 'FAILED',
        failureReason:failures[0]?.code ?? null,failures,incompleteReasons,baseSha:base,gitHead,scope,sourceInputs:sources,sourceInputsUnchanged,sourceVerification,
        freshContracts,freshCore,readerBinding,readerBindingIdentity,cueBinding,cueBindingIdentity,startupBinding,startupBindingIdentity,scanLoadEvidence,outputsIdentityUnchanged,outputVerification,runs,declaredStageCount:stages.length,
        gateBudget:budget.snapshot(),evidenceLayers,app:'NOT_RUN',electron:'NOT_RUN',liveRoonAccounts:'NOT_RUN',ownerAcceptance:'NOT_RUN',
        wholeTaskAcceptance:'NOT_INFERRED_FROM_GATE',
        ownerStageAcceptance:scanLoadEvidence?.ownerAcceptedHistoricalScale ? scanLoadEvidence.status : 'NOT_RECORDED',
        fullScalePass:scanLoadEvidence?.ownerAcceptedHistoricalScale ? false : scanLoadEvidence?.fullScalePass === true,
        currentFullScaleObserved:scanLoadEvidence?.ownerAcceptedHistoricalScale ? false : 'NOT_INFERRED',
        at00306Load:scanLoadEvidence?.ownerAcceptedHistoricalScale ? 'OWNER_ACCEPTED_HISTORICAL_SCALE_FINAL_REAL_LIBRARY_DEFERRED' : 'SEPARATE_RUNTIME_INTEGRATION_AND_LOAD_ASSESSMENT_REQUIRED',
        identityScope:'DECLARED_SOURCE_TEST_FIXTURE_CONFIG_AND_FRESH_OUTPUTS_NOT_TRANSITIVE_DEPENDENCY_CLOSURE',
        failureReceiptPolicy:'BEST_EFFORT_WX0600_COMPLETED_STAGES_PRESERVED',manifestStorageBoundary:'UNWRITABLE_STORAGE_CANNOT_GUARANTEE_FILE',
        cleanupBoundary:'OWNED_POSIX_GROUP_CLOSE_REQUIRED_NO_PROMISE_RACE_QUIET_CLAIM',sourceFilesWrite:'OFF' });
    } catch { console.error('003 Gate私有manifest未能写入；拒绝准入，磁盘故障不能保证收据文件。'); return 1; }
    return success ? 0 : 1;
  }
}
const now = () => new Date().toISOString();
const TOTAL_BUDGET_MS = 360_000;
const STAGE_LIMIT_MS = 180_000;
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
export function createBudget() {
  const startedMs = Date.now(), startedAt = now(), startedMonotonicMs = monotonicMs();
  let exhaustedPhase = null;
  const remainingMs = () => Math.max(0, TOTAL_BUDGET_MS - (monotonicMs() - startedMonotonicMs));
  const check = phase => {
    if (remainingMs() <= 0) {
      exhaustedPhase ??= phase;
      const error = new Error('整个Gate有限预算已耗尽。');
      error.code = 'GATE_TOTAL_BUDGET_EXHAUSTED';
      throw error;
    }
  };
  return { startedMs, startedAt, remainingMs, check,
    snapshot: () => {
      const elapsedMs = monotonicMs() - startedMonotonicMs;
      return { totalLimitMs: TOTAL_BUDGET_MS, startedMs, deadlineMs: startedMs + TOTAL_BUDGET_MS,
        elapsedMs, remainingMs: Math.max(0, TOTAL_BUDGET_MS - elapsedMs), exhausted: elapsedMs >= TOTAL_BUDGET_MS,
        exhaustedPhase, clock: 'MONOTONIC_HRTIME_MS',
        scope: 'ADMISSION_EXECUTION_AND_FINAL_IDENTITY_CHECKS',
        recoveryAfterDeadline: 'NO_NEW_STAGE_OR_IDENTITY_SCAN_OWNED_GROUP_CLOSE_AND_BEST_EFFORT_PRIVATE_SEAL_ONLY',
        recommendedWorkflowStepTimeoutMinutes: 8 };
    } };
}
function budgetedGit(args, budget, phase) {
  budget.check(phase);
  try {
    const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1, budget.remainingMs()), killSignal: 'SIGKILL' });
    budget.check(phase);
    return value;
  } catch (error) {
    // Git自身异常只在公开收据留下有限阶段code；预算耗尽单独记录。
    budget.check(phase);
    throw error;
  }
}
const head = budget => budgetedGit(['rev-parse', 'HEAD'], budget, 'HEAD_IDENTITY').trim();
export async function capture(run, stage, env, budget, runs) {
  budget.check('STAGE_ADMISSION');
  const startedAt = now(), startedMs = Date.now(), startedMonotonicMs = monotonicMs();
  const remainingAtStartMs = budget.remainingMs(), effectiveTimeoutMs = Math.min(STAGE_LIMIT_MS, remainingAtStartMs);
  const expectedTests = stage.expectedTests ?? null;
  // 先登记阶段；日志保存异常不能把已经完成的子进程捕获从最终收据抹掉。
  const result = { name: stage.name, argv: [stage.command ?? 'node', ...(stage.display ?? stage.args)], startedAt, startedMs,
    completedAt: null, durationMs: null, captureCompletedAt: null, exitCode: null, signal: null,
    overflow: false, timedOut: false, stageTimedOut: false, gateBudgetTimedOut: false, timeoutKind: null,
    preparationFailed: false, captureFailed: false, groupTerminationFailed: false, closeObserved: false,
    ownedProcessGroupId: null, processIsolation: 'OWNED_POSIX_PROCESS_GROUP',
    stageLimitMs: STAGE_LIMIT_MS, effectiveTimeoutMs, gateRemainingAtStartMs: remainingAtStartMs,
    gateRemainingAtCloseMs: null, gateRemainingAtCompletedMs: null, expectedTests, testCounts: null, testSummaryValid: null,
    log: `${stage.name}.log`, logWritten: false, logWriteFailed: false, logFailureCode: null,
    logSha256: null, sanitizedCaptureSha256: null, redactedLogRecovery: null,
    capturedRawSha256: null, rawDiagnosticBytes: 0,
    diagnosticsPolicy: 'ALLOWLIST_STATUS_COUNTS_ONLY', rawCaptureScope: 'BOUNDED_STDOUT_STDERR_OBSERVED_ARRIVAL_BYTES' };
  runs.push(result);
  const captured = await new Promise(resolve => {
    const chunks = []; let length = 0, overflow = false, timedOut = false, stageTimedOut = false, gateBudgetTimedOut = false;
    let preparationFailed = false, captureFailed = false, groupTerminationFailed = false, child = null, timer = null, terminated = false;
    const terminateOwned = () => {
      if (terminated || child?.pid === undefined) return;
      terminated = true;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') groupTerminationFailed = true; }
    };
    const finish = (exitCode, signal, closeObserved) => {
      if (timer !== null) clearTimeout(timer);
      let raw = null;
      try { raw = Buffer.concat(chunks, length); } catch { captureFailed = true; }
      resolve({ raw, observedBytes: length, exitCode, signal, closeObserved, overflow, timedOut, stageTimedOut,
        gateBudgetTimedOut, preparationFailed, captureFailed, groupTerminationFailed,
        ownedProcessGroupId: child?.pid ?? null });
    };
    const append = bytes => {
      if (overflow || captureFailed) return;
      try {
        if (length + bytes.length > 4 * 1024 * 1024) { overflow = true; terminateOwned(); return; }
        chunks.push(Buffer.from(bytes)); length += bytes.length;
      } catch { captureFailed = true; terminateOwned(); }
    };
    try {
      budget.check('STAGE_SPAWN');
      child = spawn(stage.command ?? process.execPath, stage.args, { cwd: path.join(repository, stage.directory), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      preparationFailed = true;
      if (error?.code === 'GATE_TOTAL_BUDGET_EXHAUSTED') { timedOut = true; gateBudgetTimedOut = true; }
      finish(null, null, false);
      return;
    }
    // 所有终止分支都等实际close；不以发出kill或exit替代管道和子进程close证据。
    child.once('close', (exitCode, signal) => finish(exitCode, signal, true));
    child.once('error', () => { preparationFailed = true; terminateOwned(); });
    try {
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.stdout.on('error', () => { captureFailed = true; terminateOwned(); });
      child.stderr.on('error', () => { captureFailed = true; terminateOwned(); });
      const expire = () => {
        timedOut = true;
        stageTimedOut = monotonicMs() - startedMonotonicMs >= STAGE_LIMIT_MS;
        gateBudgetTimedOut = budget.remainingMs() <= 0;
        // 计时器提前误差也按原先选择的有限上限失败，不会延长预算或重发阶段。
        if (!stageTimedOut && !gateBudgetTimedOut) {
          if (remainingAtStartMs <= STAGE_LIMIT_MS) gateBudgetTimedOut = true;
          else stageTimedOut = true;
        }
        terminateOwned();
      };
      const delay = Math.min(STAGE_LIMIT_MS - (monotonicMs() - startedMonotonicMs), budget.remainingMs());
      if (delay <= 0) expire();
      else timer = setTimeout(expire, delay);
    } catch { captureFailed = true; terminateOwned(); }
  });
  Object.assign(result, { captureCompletedAt: now(), exitCode: captured.exitCode, signal: captured.signal,
    overflow: captured.overflow, timedOut: captured.timedOut, stageTimedOut: captured.stageTimedOut,
    gateBudgetTimedOut: captured.gateBudgetTimedOut, preparationFailed: captured.preparationFailed,
    captureFailed: captured.captureFailed, groupTerminationFailed: captured.groupTerminationFailed,
    closeObserved: captured.closeObserved, ownedProcessGroupId: captured.ownedProcessGroupId,
    timeoutKind: captured.gateBudgetTimedOut ? 'GATE_TOTAL_BUDGET_EXHAUSTED' : captured.stageTimedOut ? 'STAGE_TIME_LIMIT_EXCEEDED' : null,
    gateRemainingAtCloseMs: budget.remainingMs(), rawDiagnosticBytes: captured.observedBytes });
  try {
    if (captured.raw === null) throw new Error('捕获聚合未完成。');
    result.capturedRawSha256 = sha(captured.raw);
    const decoded = captured.raw.toString('utf8');
    result.pnpmVersionValid = stage.name === 'pnpm-version' ? decoded.trim() === '10.17.1' : null;
    result.testCounts = parseTestCounts(decoded);
    result.testSummaryValid = expectedTests === null ? null : isCompleteTestRun(result.testCounts, expectedTests);
    const safe = sanitizeOutput(decoded);
    result.sanitizedCaptureSha256 = sha(safe);
    try {
      writeFileSync(path.join(run, result.log), safe, { flag: 'wx', mode: 0o600 });
      result.logWritten = true; result.logSha256 = result.sanitizedCaptureSha256;
    } catch {
      result.logWriteFailed = true; result.logFailureCode = 'PRIVATE_LOG_WRITE_FAILED';
      // 只保存同一allowlist后的文本；manifest可写时恢复完整脱敏捕获，不保存原始错误或路径。
      result.redactedLogRecovery = safe;
    }
  } catch {
    result.captureFailed = true;
    result.logFailureCode ??= 'CAPTURE_POSTPROCESS_FAILED';
  }
  result.completedAt = now(); result.durationMs = monotonicMs() - startedMonotonicMs;
  result.gateRemainingAtCompletedMs = budget.remainingMs();
  return result;
}
// 真实执行/capture成功与日志交付分开；故障日志不能抹掉真实fresh编译输出身份。
export const stageExecutionCaptured = item => item.exitCode === 0 && item.signal === null && item.closeObserved
  && !item.overflow && !item.timedOut && !item.preparationFailed && !item.captureFailed && !item.groupTerminationFailed;
export const stagePassed = item => stageExecutionCaptured(item) && item.logWritten && !item.logWriteFailed
  && item.pnpmVersionValid !== false
  && (item.expectedTests === null || isCompleteTestRun(item.testCounts, item.expectedTests));

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runScanGate().then(code => { process.exitCode = code; }).catch(() => { console.error('003 Gate准备未完成，未公开内部路径或诊断。'); process.exitCode = 1; });
}
