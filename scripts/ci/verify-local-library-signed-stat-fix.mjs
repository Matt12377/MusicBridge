import { lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCoreTestEnvironment, coreTestSourceInputs } from './run-core-tests.mjs';
import { makeReaderBundleBinding } from './verify-mbrs003-scan.mjs';
import { readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { captureMobileStage, mobileStageSucceeded, readMobileFile, mobileInputIdentity } from './verify-mbm000-contract-adoption.mjs';
import { inspectLocalLibrarySignedStatFixAdmission, LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE as scope,
  LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE_PATH as scopePath } from './local-library-signed-stat-fix-admission.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const entry=fileURLToPath(import.meta.url);
export const SIGNED_STAT_FIX_BUDGETS=scope.budgets;
const compilerNames=['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const within=(file,directory)=>typeof file==='string'&&file.startsWith(directory+path.sep);
const safeRelative=file=>typeof file==='string'&&!path.isAbsolute(file)&&!file.includes('\\')
  &&!/[\u0000-\u001f\u007f]/u.test(file)&&file.split('/').every(part=>part&&part!=='.'&&part!=='..');
function fail(code){const error=new Error('本地库有符号身份独立Gate拒绝。');error.code=code;throw error;}
function uniqueSet(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length
  &&new Set(a).size===a.length&&equal([...a].sort(),[...b].sort());}
function parsed(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('SIGNED_STAT_JSON_INVALID');}}
function clock(){const startedMs=Date.now(),began=performance.now(),elapsedMs=()=>performance.now()-began;
  const remaining=()=>SIGNED_STAT_FIX_BUDGETS.totalTimeoutMs-elapsedMs();
  return {startedMs,elapsedMs,remaining,check(){if(remaining()<=0)fail('SIGNED_STAT_TOTAL_BUDGET_EXHAUSTED');}};}
async function whole(file,check,allowEmpty=false){return readMobileFile(file,{maxBytes:SIGNED_STAT_FIX_BUDGETS.sourceFileBytes,check,allowEmpty});}
async function descriptor(file,check,allowEmpty=false){return(await whole(file,check,allowEmpty)).identity;}
function readHead(check,remaining){check();const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8',
  stdio:['ignore','pipe','pipe'],timeout:Math.max(1,Math.floor(Math.min(10000,remaining()))),maxBuffer:4096}).trim();
  check();if(!/^[a-f0-9]{40}$/u.test(head))fail('SIGNED_STAT_HEAD_INVALID');return head;}
async function sourceRows(check){
  const names=new Set(coreTestSourceInputs(check).map(row=>row.path));
  for(const row of [...scope.sourceChangedPaths,...scope.protectedFiles])names.add(row.path);
  for(const file of ['pnpm-lock.yaml',scopePath,'apps/desktop/scripts/build-storage-root.mjs',
    'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs','scripts/ci/verify-mbm000-contract-adoption.mjs'])names.add(file);
  if(names.size>SIGNED_STAT_FIX_BUDGETS.maxSourceFiles)fail('SIGNED_STAT_SOURCE_COUNT_EXCEEDED');
  const rows=[];for(const relative of [...names].sort()){
    check();if(!safeRelative(relative))fail('SIGNED_STAT_SOURCE_PATH');
    const actual=await whole(path.join(repository,relative),check,true);
    rows.push({path:relative,bytes:actual.identity.bytes,sha256:actual.identity.sha256});
  }return rows;
}
async function testLeaf(row,check){
  const text=new TextDecoder('utf-8',{fatal:true}).decode((await whole(path.join(repository,row.file),check)).bytes);
  const caseNames=[...text.matchAll(/^\s*test\(\s*'([^'\\\r\n]+)'/gmu)].map(match=>match[1]);
  if(caseNames.length!==row.expectedTests||new Set(caseNames).size!==caseNames.length
    ||caseNames.some(name=>Buffer.byteLength(name)>4096||/[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)))fail('SIGNED_STAT_TEST_SCOPE_CHANGED');
  return {...row,caseNames};
}
function childEnvironment(env,temporary){
  const result=Object.fromEntries(Object.entries(env).filter(([key])=>!/^(?:MUSIC_BRIDGE_|NETEASE_|ROON_|MBM\d+_|MBRS\d+_|NODE_OPTIONS$)/u.test(key)));
  return {...result,TMPDIR:temporary,NODE_ENV:'test',COREPACK_ENABLE_NETWORK:'0',npm_config_ignore_scripts:'true'};
}
async function capture(stage,context,timeout=SIGNED_STAT_FIX_BUDGETS.stageTimeoutMs){
  context.check();const result=await captureMobileStage(stage,{run:context.run,temporary:context.temporary,env:context.env,
    budgets:{...SIGNED_STAT_FIX_BUDGETS,stageTimeoutMs:timeout},remaining:context.remaining,
    spawnProcess:(command,args,options)=>spawn(command,args,{...options,cwd:path.join(repository,stage.directory)})});
  result.directory=stage.directory;context.runs.push(result);
  if(!mobileStageSucceeded(result)||result.exitObserved!==true||result.rawCaptureComplete!==true)fail('SIGNED_STAT_STAGE_INCOMPLETE');
  context.check();return result;
}

async function coreLayer(receiptFile, check, storage, preparationStage) {
  storage.check(receiptFile, { mustExist: true, kind: 'file' });
  const receipt = parsed((await whole(receiptFile, check)).bytes), directory = path.dirname(receiptFile);
  if (path.basename(receiptFile) !== 'preparation-receipt.json' || receipt.schema !== 'core-test.reader-preparation.v1'
    || receipt.status !== 'FRESH_READER_PREPARED' || receipt.inputsUnchanged !== true || receipt.outputsUnchanged !== true
    || !Array.isArray(receipt.sourceInputs) || !equal(receipt.sourceInputs, coreTestSourceInputs(check))
    || !Array.isArray(receipt.toolInputs) || !receipt.toolInputs.length || !Array.isArray(receipt.outputs) || !receipt.outputs.length
    || !Array.isArray(receipt.stages) || !equal(receipt.stages.map(row => row.name), compilerNames)) fail('SIGNED_STAT_CORE_PREPARATION_INVALID');
  for (const row of receipt.stages) if (row.compilerExit !== 0 || !Number.isFinite(row.startedMs) || !Number.isFinite(row.finishedMs)
    || row.startedMs <= 0 || row.finishedMs < row.startedMs || row.finishedMs > Date.now()
    || row.finishedMs - row.startedMs > SIGNED_STAT_FIX_BUDGETS.stageTimeoutMs) fail('SIGNED_STAT_CORE_PREPARATION_WINDOW');
  if (receipt.stages.some((row, index) => index > 0 && row.startedMs < receipt.stages[index - 1].finishedMs)
    || receipt.stages[2].finishedMs - receipt.stages[0].startedMs > SIGNED_STAT_FIX_BUDGETS.preparationTimeoutMs) fail('SIGNED_STAT_CORE_PREPARATION_WINDOW');
  if (receipt.stages[0].startedMs < preparationStage.startedMs || receipt.stages[2].finishedMs > preparationStage.closedMs) fail('SIGNED_STAT_COMPILER_NOT_IN_CURRENT_GATE');
  const tools = [];
  const require = createRequire(path.join(repository, 'packages/bridge-core/package.json'));
  const toolFiles = [require.resolve('typescript/bin/tsc'), require.resolve('typescript/package.json'),
    ...['tsc.js', '_tsc.js'].map(name => path.join(path.dirname(require.resolve('typescript/package.json')), 'lib', name))].map(file => realpathSync(file));
  if (!uniqueSet(receipt.toolInputs.map(row => row.file), toolFiles)) fail('SIGNED_STAT_CORE_TOOL_CLOSURE_INVALID');
  for (const row of receipt.toolInputs) {
    if (typeof row.file !== 'string' || !path.isAbsolute(row.file) || !positive(row.bytes) || !/^[a-f0-9]{64}$/u.test(row.sha256)) fail('SIGNED_STAT_CORE_TOOL_INVALID');
    const actual = await descriptor(row.file, check);
    if (!equal(actual, row)) fail('SIGNED_STAT_CORE_TOOL_CHANGED'); tools.push(actual);
  }
  if (new Set(tools.map(row => row.file)).size !== tools.length) fail('SIGNED_STAT_CORE_TOOL_INVALID');
  if (parsed((await whole(realpathSync(require.resolve('typescript/package.json')), check)).bytes).version !== '5.9.3') fail('SIGNED_STAT_CORE_TOOL_VERSION_CHANGED');
  const requiredOutputs = receipt.sourceInputs.filter(row => /^(?:packages\/contracts|packages\/bridge-core)\/src\/.*\.ts$/u.test(row.path)
    && !row.path.endsWith('.d.ts')).flatMap(row => ['.js', '.js.map', '.d.ts'].map(suffix => row.path.replace('/src/', '/dist/').slice(0, -3) + suffix));
  requiredOutputs.push(...['.mjs', '.mjs.map', '.meta.json', '.build.json'].map(suffix => 'packages/bridge-core/dist/library/metadata-reader-worker.bundle' + suffix));
  if (!uniqueSet(receipt.outputs.map(row => row.path), requiredOutputs)) fail('SIGNED_STAT_CORE_OUTPUT_CLOSURE_INCOMPLETE');
  const outputSources = new Map(receipt.sourceInputs.filter(row => /^(?:packages\/contracts|packages\/bridge-core)\/src\/.*\.ts$/u.test(row.path)
    && !row.path.endsWith('.d.ts')).flatMap(row => ['.js', '.js.map', '.d.ts'].map(suffix => [row.path.replace('/src/', '/dist/').slice(0, -3) + suffix, row])));
  const current = [], reboundContractOutputs = [];
  for (const row of receipt.outputs) {
    if (!safeRelative(row.path) || !positive(row.bytes) || !/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isFinite(row.mtimeMs)) fail('SIGNED_STAT_CORE_OUTPUT_INVALID');
    const file = path.join(repository, row.path); storage.check(file, { mustExist: true, kind: 'file' });
    const actual = await whole(file, check);
    if (actual.identity.bytes !== row.bytes || actual.identity.sha256 !== row.sha256) fail('SIGNED_STAT_CORE_OUTPUT_CHANGED');
    const index = row.path.startsWith('packages/contracts/dist/') ? 0 : row.path.includes('metadata-reader-worker.bundle.') ? 2 : 1;
    const source = outputSources.get(row.path);
    if (index !== 2 && (!source || row.sourcePath !== source.path || row.sourceSha256 !== source.sha256)
      || index === 2 && (Object.hasOwn(row, 'sourcePath') || Object.hasOwn(row, 'sourceSha256'))) fail('SIGNED_STAT_CORE_OUTPUT_SOURCE_CHANGED');
    const originalStage = receipt.stages[index];
    if (row.mtimeMs < originalStage.startedMs || row.mtimeMs > originalStage.finishedMs) fail('SIGNED_STAT_CORE_OUTPUT_NOT_ORIGINAL_COMPILER');
    const originalMtimeStillCurrent = lstatSync(file).mtimeMs === row.mtimeMs;
    if (!originalMtimeStillCurrent) fail('SIGNED_STAT_CORE_OUTPUT_MTIME_CHANGED');
    current.push({ path: row.path, ...actual.identity, mtimeNs: actual.mtimeNs });
  }
  const bindingFile = path.join(directory, 'reader-build-binding.json'); storage.check(bindingFile, { mustExist: true, kind: 'file' });
  const bindingBytes = (await whole(bindingFile, check)).bytes, binding = parsed(bindingBytes);
  if (!/^[a-f0-9]{64}$/u.test(receipt.readerBindingSha256) || sha(bindingBytes) !== receipt.readerBindingSha256
    || binding.schema !== 'mbrs003.reader.fresh-build.v2' || binding.compilerExit !== 0
    || binding.compilerStartedAtMs !== receipt.stages[1].startedMs || !Number.isFinite(binding.compilerFinishedAtMs)
    || binding.compilerFinishedAtMs < binding.compilerStartedAtMs || binding.compilerFinishedAtMs > receipt.stages[1].finishedMs) fail('SIGNED_STAT_READER_BINDING_INVALID');
  const fixed = await readFixedMetadataWorkerBundle(path.join(repository, 'packages/bridge-core'), check);
  if (fixed.manifest.startedAtMs < receipt.stages[2].startedMs || fixed.manifest.finishedAtMs > receipt.stages[2].finishedMs) fail('SIGNED_STAT_WORKER_NOT_ORIGINAL_BUILD_WINDOW');
  const expectedBinding = makeReaderBundleBinding(receipt.sourceInputs, { compilerExit: 0,
    compilerStartedAtMs: binding.compilerStartedAtMs, compilerFinishedAtMs: binding.compilerFinishedAtMs,
    outputs: receipt.outputs.filter(row => row.path.startsWith('packages/bridge-core/dist/') && !row.path.includes('metadata-reader-worker.bundle.')) }, fixed.manifest);
  if (!equal(binding, expectedBinding)) fail('SIGNED_STAT_READER_BINDING_CLOSURE_CHANGED');
  const productionOutputs = [];
  for (const product of scope.productPins) {
    const source = receipt.sourceInputs.find(row => row.path === product.path);
    if (!source || source.bytes !== product.after.bytes || source.sha256 !== product.after.sha256) fail('SIGNED_STAT_COMPILED_PRODUCT_SOURCE_DRIFT');
    for (const suffix of ['.js','.js.map','.d.ts']) {
      const output = receipt.outputs.find(row => row.path === product.path.replace('/src/','/dist/').slice(0,-3) + suffix);
      if (!output || output.sourcePath !== product.path || output.sourceSha256 !== product.after.sha256) fail('SIGNED_STAT_PRODUCT_NOT_ACTUALLY_COMPILED');
      productionOutputs.push(output);
    }
  }
  if (productionOutputs.length !== 36) fail('SIGNED_STAT_PRODUCT_COMPILE_CLOSURE_INCOMPLETE');
  const snapshot = { inputs: receipt.sourceInputs, tools, outputs: current, readerBinding: await descriptor(bindingFile, check) };
  async function assertCurrent() {
    check(); if (!equal(receipt.sourceInputs, coreTestSourceInputs(check))) fail('SIGNED_STAT_CORE_SOURCE_DRIFT');
    for (const row of tools) if (!equal(await descriptor(row.file, check), row)) fail('SIGNED_STAT_CORE_TOOL_DRIFT');
    for (const row of current) {
      const actual = await whole(row.file, check);
      if (actual.identity.bytes !== row.bytes || actual.identity.sha256 !== row.sha256 || actual.mtimeNs !== row.mtimeNs) fail('SIGNED_STAT_CORE_COMPILED_DRIFT');
    }
    if (!equal(await descriptor(bindingFile, check), snapshot.readerBinding)) fail('SIGNED_STAT_READER_BINDING_DRIFT');
  }
  await assertCurrent();
  return { env: { MBRS003_READER_BUILD_BINDING: bindingFile }, assertCurrent,
    proof: { mode:'fresh', receipt: await descriptor(receiptFile, check), readerBinding: snapshot.readerBinding,
      sourceInputIdentity: mobileInputIdentity(receipt.sourceInputs), stages: receipt.stages,
      toolInputs: tools, currentOutputRows: current, currentOutputCount: current.length,
      currentOutputIdentity: mobileInputIdentity(current.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))),
      originalCompilerExecutionRepeated: true,
      reusedCoreAndWorkerKeepExactOriginalMtime: false, reboundContractOutputs,
      exactSignedStatProductSources:scope.productPins.map(row=>({path:row.path,...row.after})), productionOutputs,
      productSourcesReinterpretedOrNormalized:false, readerBindingInverted:false,
      bindingSnapshotDoesNotCertifyLaterMutableDist: true, fullTransitiveToolchainClosure: false } };
}


/** 新任务只实际执行自己的软件链；准备同轮Core/Worker，不接旧Reader声明或旧执行receipt。 */
export async function runLocalLibrarySignedStatFixGate(argv=process.argv.slice(2),env=process.env){
  const budget=clock(),storageAdmission=validateOfflineArguments(argv,env);
  if(process.versions.node.split('.')[0]!=='22')fail('SIGNED_STAT_NODE22_REQUIRED');
  const admitted=inspectLocalLibrarySignedStatFixAdmission(repository,env);
  if(admitted.task!==scope.task)fail('SIGNED_STAT_WRONG_TASK');
  budget.check();const initialHead=readHead(budget.check,budget.remaining),inputs=await sourceRows(budget.check);
  const leaves=await Promise.all(scope.tests.map(row=>testLeaf(row,budget.check)));
  const expectedTests=leaves.reduce((n,row)=>n+row.expectedTests,0);
  if(expectedTests!==80||new Set(leaves.flatMap(row=>row.caseNames)).size!==80)fail('SIGNED_STAT_CASE_CLOSURE_CHANGED');
  const run=createPrivateRun(storageAdmission),temporary=path.join(run,'tmp');mkdirSync(temporary,{mode:0o700});
  const runs=[],failures=[],context={run,temporary,runs,...budget,env:childEnvironment(env,temporary)};
  let core=null,sourceInputsUnchanged=false,compiledOutputsUnchanged=false;
  const unchanged=async()=>{
    budget.check();if(readHead(budget.check,budget.remaining)!==initialHead||!equal(await sourceRows(budget.check),inputs))fail('SIGNED_STAT_SOURCE_DRIFT');
    for(const pin of scope.productPins){const row=inputs.find(item=>item.path===pin.path);
      if(row?.bytes!==pin.after.bytes||row?.sha256!==pin.after.sha256)fail('SIGNED_STAT_PRODUCT_DRIFT');}
    for(const pin of scope.compatibilityPins){const row=inputs.find(item=>item.path===pin.path);
      if(row?.bytes!==pin.after.bytes||row?.sha256!==pin.after.sha256)fail('SIGNED_STAT_COMPATIBILITY_DRIFT');}
  };
  try{
    await unchanged();const handoffFile=path.join(run,'core-handoff.json');
    const preparationStage=await capture({name:'fresh-core-preparation',directory:'.',args:[entry,'--internal=prepare','--handoff='+handoffFile]},context,SIGNED_STAT_FIX_BUDGETS.preparationTimeoutMs);
    const handoff=parsed((await whole(handoffFile,budget.check)).bytes);
    if(handoff.schema!=='musicbridge.local-library-signed-stat-fix.core-handoff.v1'||!within(handoff.receipt,temporary)
      ||!within(handoff.readerBinding,temporary)||!uniqueSet(Object.keys(handoff),['schema','receipt','readerBinding']))fail('SIGNED_STAT_PREPARATION_HANDOFF_INVALID');
    core=await coreLayer(handoff.receipt,budget.check,storageAdmission.storage,preparationStage);
    if(core.env.MBRS003_READER_BUILD_BINDING!==handoff.readerBinding)fail('SIGNED_STAT_READER_HANDOFF_MISMATCH');
    Object.assign(context.env,core.env);await unchanged();
    for(const leaf of leaves){
      await core.assertCurrent();await unchanged();
      const directory=leaf.file.startsWith('apps/desktop/')?'apps/desktop':'packages/bridge-core';
      const name=(directory==='apps/desktop'?'desktop-':'core-')+path.basename(leaf.file,'.test.ts');
      await capture({name,directory,expectedTests:leaf.expectedTests,caseNames:leaf.caseNames,
        args:['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',path.relative(directory,leaf.file)]},context);
      await core.assertCurrent();await unchanged();
    }
    await core.assertCurrent();compiledOutputsUnchanged=true;await unchanged();sourceInputsUnchanged=true;
  }catch(error){failures.push(/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'SIGNED_STAT_GATE_EXCEPTION');
    try{await unchanged();sourceInputsUnchanged=true;}catch{failures.push('SIGNED_STAT_FINAL_SOURCE_READBACK_INCOMPLETE');}}
  const behavior=runs.filter(row=>row.expectedTests!==null);
  const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>[key,behavior.reduce((n,row)=>n+(row.testCounts?.[key]??0),0)]));
  const success=failures.length===0&&core!==null&&sourceInputsUnchanged&&compiledOutputsUnchanged
    &&runs.length===9&&behavior.length===8&&runs.every(mobileStageSucceeded)&&isCompleteTestRun(counts,80)&&budget.remaining()>0;
  const summary={schema:'musicbridge.local-library-signed-stat-fix.software-gate.v1',task:scope.task,
    success,state:success?'EXACT_FIX_SOFTWARE_ONLY_PASS':'FAILED',baseSha:scope.baseSha,headAtRun:initialHead,
    startedMs:budget.startedMs,finishedMs:Date.now(),durationMs:budget.elapsedMs(),budgets:SIGNED_STAT_FIX_BUDGETS,
    admission:admitted,sourceInputs:inputs,sourceInputIdentity:mobileInputIdentity(inputs),sourceInputsUnchanged,
    currentCoreAndWorker:core?.proof??null,compiledOutputsUnchanged,runs,failures,selectedTestLeaves:leaves,
    expectedStages:9,completedStages:runs.length,expectedBehaviorTests:80,behaviorCounts:counts,
    exactCurrentProductSourceFiles:12,exactCurrentCompatibilityFiles:6,oldGatesRerun:false,oldExecutionRelabeledCurrent:false,
    readerBindingInverted:false,sourceIdentitySignPreserved:true,ordinaryProfileRecovery:'NOT_PROVEN_BY_THIS_GATE',
    productionApp:'NOT_PROVEN_BY_THIS_GATE',realProviderRoonNas:'NOT_RUN',physicalDeviceAudio:'NOT_PROVEN',ownerAcceptance:'NOT_PROVEN',
    syntheticStatFixturesAreNotOrdinaryProfileProof:true,fullTransitiveToolchainClosure:false};
  writePrivateJson(run,'summary.json',summary);return {run,summary};
}
async function prepareInternal(argv){
  if(argv.length!==2||argv[0]!=='--internal=prepare'||!argv[1].startsWith('--handoff='))fail('SIGNED_STAT_INTERNAL_ARGUMENT_INVALID');
  const handoff=argv[1].slice('--handoff='.length),storage=(await import('../../apps/desktop/scripts/build-storage-root.mjs')).buildStoragePolicy();
  storage.check(handoff,{kind:'file'});storage.check(process.env.TMPDIR,{mustExist:true});
  if(path.dirname(handoff)!==path.dirname(process.env.TMPDIR)||path.basename(handoff)!=='core-handoff.json')fail('SIGNED_STAT_HANDOFF_PATH');
  const prepared=await prepareCoreTestEnvironment({env:process.env});prepared.assertCurrent();
  const receipt=path.join(prepared.privateRoot,'preparation-receipt.json');
  if(!within(receipt,process.env.TMPDIR)||!within(prepared.env.MBRS003_READER_BUILD_BINDING,process.env.TMPDIR))fail('SIGNED_STAT_PREPARATION_PATH');
  writeFileSync(handoff,JSON.stringify({schema:'musicbridge.local-library-signed-stat-fix.core-handoff.v1',receipt,
    readerBinding:prepared.env.MBRS003_READER_BUILD_BINDING})+'\n',{flag:'wx',mode:0o600});
  process.stdout.write('SIGNED_STAT_FRESH_CORE_WORKER_PREPARED\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const argv=process.argv.slice(2);if(argv[0]?.startsWith('--internal='))await prepareInternal(argv);
    else{const {summary}=await runLocalLibrarySignedStatFixGate(argv);process.stdout.write(JSON.stringify({task:summary.task,
      success:summary.success,tests:summary.behaviorCounts.tests,pass:summary.behaviorCounts.pass,failures:summary.failures,
      deviceAndOwnerAcceptance:'NOT_PROVEN'})+'\n');if(!summary.success)process.exitCode=1;}}
  catch(error){process.stderr.write('本地库修复Gate拒绝：'+(/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'SIGNED_STAT_ADMISSION_OR_PREPARATION_FAILED')+'\n');process.exitCode=1;}
}
