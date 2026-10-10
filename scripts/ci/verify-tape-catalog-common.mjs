import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTapeCatalogCommonAdmission, TAPE_CATALOG_COMMON_TASK,
  TAPE_CATALOG_COMMON_SCOPE as commonScope } from './tape-catalog-common-admission.mjs';
import { LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE as signedScope } from './local-library-signed-stat-fix-admission.mjs';
import { runLocalLibrarySignedStatFixGate } from './verify-local-library-signed-stat-fix.mjs';
import { isCompleteTestRun, validateOfflineArguments, writePrivateJson } from './verify-mbrs001-offline.mjs';
import { mobileInputIdentity, mobileStageSucceeded } from './verify-mbm000-contract-adoption.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const compilerNames=['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'];
const outputRows=rows=>rows.map(({path,bytes,sha256})=>({path,bytes,sha256}));
const workerOutputs=['.mjs','.mjs.map','.meta.json','.build.json'].map(suffix=>'packages/bridge-core/dist/library/metadata-reader-worker.bundle'+suffix);
function fail(code){const error=new Error('磁带组合软件Gate拒绝。');error.code=code;throw error;}
const codeOf=error=>/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'TAPE_COMMON_GATE_FAILED';

/** 两套冻结产品整件路径共存，读取策略产品没有借组合任务改写。 */
export function tapeCatalogCommonCoexistence(admitted){
  if(admitted?.task!==TAPE_CATALOG_COMMON_TASK||admitted.localLibraryFixTask!==signedScope.task
    ||admitted.signedStatFreshSoftwareGateRequired!==true||!Array.isArray(admitted.sourcePins))fail('TAPE_COMMON_GATE_ADMISSION_REQUIRED');
  const fixed=signedScope.productPins.map(row=>({path:row.path,...row.after}));
  if(commonScope.productPins.length!==12||commonScope.tapeCatalogPins.length!==52
    ||new Set(commonScope.productPins.map(row=>row.path)).size!==12
    ||new Set(commonScope.tapeCatalogPins.map(row=>row.path)).size!==52
    ||commonScope.tapeCatalogPins.some(row=>fixed.some(pin=>pin.path===row.path)))fail('TAPE_COMMON_PRODUCT_COEXISTENCE_CHANGED');
  for(const pin of fixed){const row=admitted.sourcePins.find(value=>value.path===pin.path);
    if(!row||row.bytes!==pin.bytes||row.sha256!==pin.sha256)fail('TAPE_COMMON_SIGNED_STAT_PRODUCT_DRIFT');}
  return {mode:'EXACT_SOURCE_CLOSURE',tapeCatalogSourceFiles:52,signedStatProductFiles:12,
    intersectingProductPaths:[],signedStatProductsUnchanged:true,
    referenceInventoryTransactionAndAssetChecks:'SEPARATE_STANDARD_VERIFICATION_REQUIRED',
    appLaunchesByThisGate:0,formalArchiveImportsByThisGate:0,ordinarySourceMediaWritesByThisGate:0};
}

/** 只收本轮完整fresh执行结果；旧FD/CFA/003的软件收据不能换task后充当组合实跑。 */
export function assertTapeCatalogCommonFreshResult(summary,admitted){
  if(admitted?.task!==TAPE_CATALOG_COMMON_TASK||admitted.localLibraryFixTask!==signedScope.task
    ||admitted.signedStatFreshSoftwareGateRequired!==true||!Array.isArray(admitted.sourcePins))fail('TAPE_COMMON_GATE_ADMISSION_REQUIRED');
  if(summary?.schema!=='musicbridge.tape-catalog-common.signed-stat-software-gate.v1'
    ||summary.task!==TAPE_CATALOG_COMMON_TASK||summary.localLibraryFixTask!==signedScope.task
    ||summary.signedStatFreshSoftwareGateRequired!==true||summary.baseSha!==admitted.baseSha
    ||summary.headAtRun!==admitted.headAtAdmission
    ||!equal(summary.admission?.closure,admitted.closure)
    ||!equal(summary.admission?.sourcePins,admitted.sourcePins))fail('TAPE_COMMON_CURRENT_EXECUTION_IDENTITY_REQUIRED');
  if(summary.success!==true||summary.state!=='COMMON_SIGNED_STAT_SOFTWARE_ONLY_PASS'
    ||summary.sourceInputsUnchanged!==true||summary.compiledOutputsUnchanged!==true
    ||summary.expectedStages!==9||summary.completedStages!==9||summary.expectedBehaviorTests!==80
    ||summary.exactCurrentProductSourceFiles!==12||summary.exactCurrentCompatibilityFiles!==6
    ||!Array.isArray(summary.failures)||summary.failures.length!==0
    ||!isCompleteTestRun(summary.behaviorCounts,80)||!Array.isArray(summary.runs)||summary.runs.length!==9
    ||summary.runs.some(row=>!mobileStageSucceeded(row)||row.exitObserved!==true||row.rawCaptureComplete!==true))fail('TAPE_COMMON_FRESH_TAP_INCOMPLETE');
  if(!Array.isArray(summary.selectedTestLeaves)||!equal(summary.selectedTestLeaves.map(({file,expectedTests})=>({file,expectedTests})),signedScope.tests)
    ||!Array.isArray(summary.sourceInputs)||summary.sourceInputIdentity!==mobileInputIdentity(summary.sourceInputs)
    ||admitted.sourcePins.some(pin=>!summary.sourceInputs.some(row=>row.path===pin.path&&row.bytes===pin.bytes&&row.sha256===pin.sha256)))fail('TAPE_COMMON_CURRENT_SOURCE_CLOSURE_INCOMPLETE');
  const leaves=summary.selectedTestLeaves;
  if(summary.runs[0].name!=='fresh-core-preparation'||summary.runs[0].directory!=='.'||summary.runs[0].expectedTests!==null
    ||leaves.some(leaf=>!Array.isArray(leaf.caseNames)||leaf.caseNames.length!==leaf.expectedTests
      ||leaf.caseNames.some(name=>typeof name!=='string'||!name||Buffer.byteLength(name)>4096
        ||/[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)))
    ||new Set(leaves.flatMap(leaf=>leaf.caseNames)).size!==80
    ||leaves.some((leaf,index)=>{
      const directory=leaf.file.startsWith('apps/desktop/')?'apps/desktop':'packages/bridge-core';
      const name=(directory==='apps/desktop'?'desktop-':'core-')+path.basename(leaf.file,'.test.ts');
      const stage=summary.runs[index+1];
      return stage.name!==name||stage.directory!==directory||stage.expectedTests!==leaf.expectedTests
        ||!equal(stage.expectedCaseNames,leaf.caseNames)||!equal(stage.actualCaseNames,leaf.caseNames);
    }))fail('TAPE_COMMON_FRESH_TAP_INCOMPLETE');
  const core=summary.currentCoreAndWorker;
  const requiredProductOutputs=signedScope.productPins.flatMap(row=>['.js','.js.map','.d.ts'].map(suffix=>({
    path:row.path.replace('/src/','/dist/').slice(0,-3)+suffix,sourcePath:row.path,sourceSha256:row.after.sha256})));
  if(core?.mode!=='fresh'||core.originalCompilerExecutionRepeated!==true||core.reusedCoreAndWorkerKeepExactOriginalMtime!==false
    ||core.productSourcesReinterpretedOrNormalized!==false||core.readerBindingInverted!==false
    ||!equal(core.stages?.map(row=>row.name),compilerNames)||core.stages.some(row=>row.compilerExit!==0)
    ||!equal(core.exactSignedStatProductSources,signedScope.productPins.map(row=>({path:row.path,...row.after})))
    ||!Array.isArray(core.productionOutputs)||core.productionOutputs.length!==36
    ||!Array.isArray(core.currentOutputRows)||core.currentOutputRows.length!==core.currentOutputCount
    ||!Number.isSafeInteger(core.currentOutputCount)||core.currentOutputCount<40
    ||new Set(core.currentOutputRows.map(row=>row.path)).size!==core.currentOutputCount
    ||!Array.isArray(core.originalCompilerOutputs)||core.originalCompilerOutputs.length!==core.currentOutputCount
    ||!equal(outputRows(core.currentOutputRows),outputRows(core.originalCompilerOutputs))
    ||requiredProductOutputs.some(required=>!core.productionOutputs.some(row=>row.path===required.path
      &&row.sourcePath===required.sourcePath&&row.sourceSha256===required.sourceSha256
      &&core.currentOutputRows.some(current=>current.path===row.path&&current.bytes===row.bytes&&current.sha256===row.sha256)))
    ||workerOutputs.some(file=>!core.currentOutputRows.some(row=>row.path===file))
    ||core.currentOutputIdentity!==mobileInputIdentity(core.currentOutputRows)
    ||summary.oldGatesRerun!==false||summary.oldExecutionRelabeledCurrent!==false
    ||summary.sourceIdentitySignPreserved!==true||summary.readerBindingInverted!==false)fail('TAPE_COMMON_FRESH_COMPILER_CLOSURE_REQUIRED');
  return {tests:80,passed:80,currentHead:summary.headAtRun,
    sourceInputIdentity:summary.sourceInputIdentity,compiledOutputIdentity:core.currentOutputIdentity};
}

/** 当前组合Source独立实跑；标准verify由Root/CI另行绑定同HEAD，不读取历史CI充数。 */
export async function runTapeCatalogCommonGate(argv=process.argv.slice(2),env=process.env){
  validateOfflineArguments(argv,env);
  const startedMs=Date.now(),began=performance.now();
  const admitted=inspectTapeCatalogCommonAdmission(repository,env);
  const coexistence=tapeCatalogCommonCoexistence(admitted);
  const {run,summary:signedStat}=await runLocalLibrarySignedStatFixGate(argv,env);
  const failures=[];let freshResult=null,readback=null,admissionUnchanged=false;
  try{freshResult=assertTapeCatalogCommonFreshResult(signedStat,admitted);}catch(error){failures.push(codeOf(error));}
  try{
    readback=inspectTapeCatalogCommonAdmission(repository,env);
    admissionUnchanged=readback.headAtAdmission===admitted.headAtAdmission&&equal(readback.closure,admitted.closure)
      &&equal(readback.sourcePins,admitted.sourcePins)&&equal(readback.changedPaths,admitted.changedPaths);
    if(!admissionUnchanged)fail('TAPE_COMMON_FINAL_ADMISSION_DRIFT');
    tapeCatalogCommonCoexistence(readback);
  }catch(error){failures.push(codeOf(error));}
  const success=failures.length===0&&freshResult!==null&&admissionUnchanged;
  const summary={schema:'musicbridge.tape-catalog-common.software-gate.v1',task:TAPE_CATALOG_COMMON_TASK,
    localLibraryFixTask:signedScope.task,success,state:success?'COMBINED_FRESH_SIGNED_STAT_SOFTWARE_ONLY_PASS':'FAILED',
    baseSha:admitted.baseSha,headAtRun:signedStat.headAtRun,sourceClosure:admitted.closure,
    startedMs,finishedMs:Date.now(),durationMs:performance.now()-began,
    admission:admitted,finalAdmission:readback,admissionUnchanged,
    sourcePins:admitted.sourcePins,sourcePinIdentity:mobileInputIdentity(admitted.sourcePins),
    sourceInputs:signedStat.sourceInputs,sourceInputIdentity:signedStat.sourceInputIdentity,
    sourceInputsUnchanged:signedStat.sourceInputsUnchanged,compiledOutputsUnchanged:signedStat.compiledOutputsUnchanged,
    currentCoreAndWorker:signedStat.currentCoreAndWorker,coexistence,freshResult,
    signedStatSummaryFile:'summary.json',runs:signedStat.runs,behaviorCounts:signedStat.behaviorCounts,
    expectedBehaviorTests:80,softwareGateExitCode:success?0:1,failures,signedStatFailures:signedStat.failures,
    readPolicy:{evidence:'EXACT_12_PRODUCT_PINS_AND_CURRENT_80_CASE_FRESH_READER_WORKER',behaviorVerified:freshResult!==null,
      sourceIdentitySignPreserved:true,numberAbsOrUnsignedReinterpretation:false,
      metadataParserVersion:'music-metadata-11.15.0/mbrs003-v3',oldIdentityMismatchStillRejected:true,
      libraryWriteEnabledDefault:'OFF',ordinarySourceFilesRemainReadOnly:true},
    standardVerification:'SEPARATE_REQUIRED_NOT_RUN_BY_THIS_GATE',
    historicalFdAndCfaCi:'HISTORICAL_SOURCE_EVIDENCE_ONLY',oldGatesRerun:false,oldExecutionRelabeledCurrent:false,
    formalArchiveImport:'NOT_RUN',originalArchiveAnd1777CatalogReverification:'NOT_RUN',
    productionApp:'NOT_PROVEN_BY_THIS_GATE',ordinary61:'OPEN',cold61:'OPEN',realOsInterruption:'OPEN',
    newMobileOrPlaybackGate:false,physicalDeviceAudio:'NOT_PROVEN',ownerAcceptance:'OPEN',
    syntheticStatFixturesAreNotOrdinaryProfileProof:true,fullTransitiveToolchainClosure:false};
  writePrivateJson(run,'common-summary.json',summary);return {run,summary};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const {summary}=await runTapeCatalogCommonGate();process.stdout.write(JSON.stringify({task:summary.task,
    headAtRun:summary.headAtRun,success:summary.success,tests:summary.behaviorCounts.tests,
    pass:summary.behaviorCounts.pass,failures:summary.failures,formalArchiveImport:'NOT_RUN',ownerAcceptance:'OPEN'})+'\n');
    if(!summary.success)process.exitCode=1;
  }catch(error){process.stderr.write('磁带组合Gate拒绝：'+codeOf(error)+'\n');process.exitCode=1;}
}
