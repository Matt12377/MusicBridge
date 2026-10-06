import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stop = code => { const error = new Error('独立负载收据未达到终结身份准入。'); error.code = code; throw error; };
export const SCALE_RECEIPT_FAILURES = ['SCAN_LOAD_TERMINAL_ADAPTER_MISSING','SCAN_LOAD_PROFILE_NOT_TERMINAL',
  'SCAN_LOAD_IDENTITY_INVALID','SCAN_LOAD_RESULT_INVALID','SCAN_LOAD_RUNNER_FAILED','SCAN_LOAD_SNAPSHOT_DRIFT'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** 只后验runner最终结果；20 smoke、progress或声明不能进入该准入。 */
export function validateScaleObservation(value, count) {
  const need = valid => { if (!valid) stop('SCAN_LOAD_RESULT_INVALID'); };
  need([100000,300000].includes(count) && value?.schema === 'mbrs003.digital-audio-scale-observation.v3'
    && value.count === count && value.status === 'SOFTWARE_SCALE_OBSERVED' && value.rehearsal === false
    && value.timedOut === false && value.safeError === null && value.lifecycleFailure === null
    && Number.isFinite(value.scanElapsedMs) && value.scanElapsedMs >= 0
    && integer(value.maxMilliseconds) && value.maxMilliseconds > 0 && value.scanElapsedMs <= value.maxMilliseconds
    && Number.isFinite(value.independentPostHashElapsedMs) && value.independentPostHashElapsedMs >= 0);
  const m = value.metrics;
  need(m && ['readerCalls','ok','failures','workerStarts','workerExits','fdReleased','wholeAudioHashFalse','wholeAudioDecodeFalse',
    'peakReaderFD','peakWorker','maxBatch','preparedFrontierMaximum','catalogPageMaximum'].every(k => integer(m[k])));
  need(m.readerCalls >= count && m.ok === m.readerCalls && m.failures === 0
    && m.workerStarts === m.readerCalls && m.workerExits === m.workerStarts && m.fdReleased === m.workerStarts
    && m.wholeAudioHashFalse === m.readerCalls && m.wholeAudioDecodeFalse === m.readerCalls
    && m.peakReaderFD >= 1 && m.peakReaderFD <= 2 && m.peakWorker >= 1 && m.peakWorker <= 2
    && m.maxBatch >= 1 && m.maxBatch <= 200 && m.preparedFrontierMaximum <= 200
    && m.catalogPageMaximum >= 1 && m.catalogPageMaximum <= 200);
  const names = ['first-pause-after-real-committed-batches','cold-reopen-explicit-resume-then-terminal-cancel',
    'new-job-after-cancel-completes-first-corpus','unchanged-incremental-no-reparse','one-stat-signature-change-one-real-reparse'];
  need(Array.isArray(m.stages) && m.stages.length === names.length && m.stages.every((s,i) => s.name === names[i]));
  const phases = ['paused','cancelled','completed','completed','completed'];
  need(m.stages.every((s,i) => s.phase === phases[i] && s.progress && s.progress.rejected === '0'
    && /^(0|[1-9][0-9]{0,19})$/u.test(s.progress.visited) && /^(0|[1-9][0-9]{0,19})$/u.test(s.progress.accepted)
    && integer(s.delta?.readerCalls)));
  need(BigInt(m.stages[0].progress.visited) >= 400n && BigInt(m.stages[0].progress.visited) < BigInt(count)
    && BigInt(m.stages[1].progress.visited) >= 800n && BigInt(m.stages[1].progress.visited) < BigInt(count));
  need(m.stages.slice(2).every(s => s.progress.visited === String(count) && s.progress.accepted === String(count))
    && m.stages[3].delta.readerCalls === 0 && m.stages[4].delta.readerCalls === 1);
  const identities = m.catalogIdentityChecks;
  need(identities && ['first','unchanged','oneChanged'].every(k => identities[k]?.items === count && hash(identities[k].digest))
    && identities.first.digest === identities.unchanged.digest && identities.first.digest === identities.oneChanged.digest);
  need(m.cancelledColdPersistence?.jobExact === true && m.cancelledColdPersistence.receiptExact === true
    && m.cancelledColdPersistence.checkpointExact === true && m.cancelledColdPersistence.noAutomaticRead === true
    && m.newJobAfterCancel?.different === true && m.newJobAfterCancel.jobId !== m.newJobAfterCancel.previousJobId);
  need(Array.isArray(m.quietCloses) && m.quietCloses.length === 3
    && m.quietCloses.every(c => c.coordinatorJoined === true && c.contextClosed === true));
  return { count, status:'FINITE_SNAPSHOT04_LOAD_OBSERVED', readerCalls:m.readerCalls,
    workerStarts:m.workerStarts, workerExits:m.workerExits, fdReleased:m.fdReleased,
    maxBatch:m.maxBatch, catalogPageMaximum:m.catalogPageMaximum, peakReaderFD:m.peakReaderFD, peakWorker:m.peakWorker,
    scanElapsedMs:value.scanElapsedMs, independentPostHashElapsedMs:value.independentPostHashElapsedMs,
    renderer:'NOT_RUN', productionMediaPriority:'SEPARATE_EVIDENCE_REQUIRED', wholeTaskAcceptance:'NOT_INFERRED' };
}
/** 只读精确私有文件，不运行负载、SQL或导入被测模块。上限防止伪大JSON/日志消耗Gate预算。 */
function checked(ref, storage, budget, maxBytes = 2 * 1024 * 1024) {
  budget.check('SCAN_LOAD_RECEIPT_IDENTITY');
  if (!ref || typeof ref.path !== 'string' || !path.isAbsolute(ref.path) || !integer(ref.bytes) || !hash(ref.sha256)) stop('SCAN_LOAD_IDENTITY_INVALID');
  storage.check(ref.path,{mustExist:true,kind:'file'});
  const info = lstatSync(ref.path);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(ref.path) !== ref.path || info.size !== ref.bytes || info.size > maxBytes) stop('SCAN_LOAD_IDENTITY_INVALID');
  const bytes = readFileSync(ref.path); budget.check('SCAN_LOAD_RECEIPT_IDENTITY');
  if (bytes.length !== ref.bytes || sha(bytes) !== ref.sha256) stop('SCAN_LOAD_IDENTITY_INVALID');
  return bytes;
}
/** profiles只接受两项Root已终结的result+outer runner精确摘要；RUNNING/未开始均fail closed。 */
export function readSnapshot04LoadEvidence(spec, admission, budget) {
  if (spec?.schema === CURRENT_SCHEMA) return readCurrentFixedLoadEvidence(spec,admission,budget);
  if (spec?.schema === CURRENT_ROUND_SCHEMA) return readCurrentFixedScaleRoundLoadEvidence(spec,admission,budget);
  if (spec?.schema !== 'mbrs003.scan-load-receipts.v1' || spec.status !== 'ROOT_TERMINAL_RECEIPTS_FROZEN'
    || !Array.isArray(spec.profiles) || spec.profiles.length !== 2) stop('SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  if (spec.profiles.some(p => p.state !== 'TERMINAL')) stop('SCAN_LOAD_PROFILE_NOT_TERMINAL');
  if (JSON.stringify(spec.profiles.map(p => p.count).sort((a,b)=>a-b)) !== JSON.stringify([100000,300000])) stop('SCAN_LOAD_IDENTITY_INVALID');
  const rootAdmission = JSON.parse(checked(spec.executionAdmission,admission.storage,budget));
  const binding = JSON.parse(checked(spec.snapshotBinding,admission.storage,budget));
  const copy = JSON.parse(checked(spec.snapshotCopy,admission.storage,budget));
  checked(spec.harness,admission.storage,budget);
  if (rootAdmission.schema !== 'mbrs003.root.first-scale-admission.v1' || binding.schema !== 'mbrs003.scale.fresh-runtime.v1'
    || binding.compilerExit !== 0 || binding.precompileInputsPostchecked !== true || binding.ownerAdmission !== 'PRODUCTION_ADMISSION_BODY_IDLE_CONTROL'
    || copy.schema !== 'mbrs003.root.scale-runtime-copy.v1' || copy.compilerExit !== 0 || copy.precompileInputsPostchecked !== true
    || rootAdmission.snapshotBinding.sha256 !== spec.snapshotBinding.sha256 || rootAdmission.snapshotBinding.path !== spec.snapshotBinding.path
    || binding.copiedSnapshotSourceReceipt.sha256 !== spec.snapshotCopy.sha256 || binding.copiedSnapshotSourceReceipt.path !== spec.snapshotCopy.path
    || !Array.isArray(binding.files) || !binding.files.length || binding.files.length > 5000 || !Array.isArray(copy.files)
    || new Set(binding.files.map(f=>f.path)).size !== binding.files.length || copy.files.length !== binding.files.length) stop('SCAN_LOAD_IDENTITY_INVALID');
  checked(binding.contextModule,admission.storage,budget);
  const compiler = JSON.parse(checked(binding.originalActualCompilerResult,admission.storage,budget));
  checked(binding.originalActualPrecompileInputs,admission.storage,budget);
  if (compiler.exitCode !== 0 || compiler.timedOut !== false || compiler.signal !== null
    || copy.actualCoreCompiler04.sha256 !== binding.originalActualCompilerResult.sha256) stop('SCAN_LOAD_IDENTITY_INVALID');
  const snapshotRoot = path.resolve(path.dirname(spec.snapshotBinding.path),'runtime');
  const originalMap = new Map(copy.files.map(f=>[f.path,f]));
  const profiles = [];
  for (const profile of spec.profiles) {
    if (!profile.runner || !profile.observation) stop('SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
    const run = JSON.parse(checked(profile.runner,admission.storage,budget));
    const observation = JSON.parse(checked(profile.observation,admission.storage,budget));
    const original = rootAdmission.profiles?.find(p=>p.count === profile.count);
    if (!original || observation.maxMilliseconds !== original.innerBudgetMs) stop('SCAN_LOAD_IDENTITY_INVALID');
    if (run.exitCode !== 0 || run.timedOut !== false || run.signal !== null
      || !Number.isFinite(run.durationSeconds) || run.durationSeconds < 0 || run.durationSeconds > original.outerWallBudgetSeconds
      || !Array.isArray(run.argv) || run.argv.length !== 7 || run.argv[0] !== spec.nodeExecutable
      || run.argv[1] !== spec.harness.path || run.argv[2] !== original.corpusRoot || run.argv[3] !== profile.observation.path
      || run.argv[4] !== spec.snapshotBinding.path || run.argv[5] !== binding.contextModule.path
      || run.argv[6] !== String(original.innerBudgetMs)) stop('SCAN_LOAD_RUNNER_FAILED');
    checked(run.log,admission.storage,budget,4 * 1024 * 1024);
    if (!Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.completedAt))
      || Date.parse(run.completedAt) < Date.parse(run.startedAt)) stop('SCAN_LOAD_RUNNER_FAILED');
    profiles.push({ ...validateScaleObservation(observation,profile.count), observationIdentity:profile.observation,
      runnerIdentity:profile.runner, logIdentity:run.log });
  }
  // 本次只读再核固定Snapshot04源和产物，不把最终TREE的新CUE/UI等变更冒为规模已测。
  for (const row of binding.files) {
    const original = originalMap.get(row.path);
    if (typeof row.path !== 'string' || !row.path.startsWith(snapshotRoot + path.sep)
      || !original || row.bytes !== original.bytes || row.sha256 !== original.sha256) stop('SCAN_LOAD_IDENTITY_INVALID');
    try { checked(row,admission.storage,budget,8 * 1024 * 1024); }
    catch (error) { if (error.code === 'GATE_TOTAL_BUDGET_EXHAUSTED') throw error; stop('SCAN_LOAD_SNAPSHOT_DRIFT'); }
  }
  return { status:'FINITE_SNAPSHOT04_LOAD_OBSERVED', profiles, snapshotBinding:spec.snapshotBinding,
    snapshotCopy:spec.snapshotCopy, executionAdmission:spec.executionAdmission, harness:spec.harness,
    snapshotFileCount:binding.files.length, sourceAndOutputIdentityUnchanged:true,
    finalTreeWholeTests:'NOT_INFERRED', dependencyClosure:'DECLARED_SNAPSHOT_ONLY_REGISTRY_DEPENDENCIES_REUSED_READONLY',
    renderer:'NOT_RUN', app:'NOT_RUN', realRoon:'NOT_RUN', ownerAcceptance:'NOT_RUN', atAcceptance:'NOT_INFERRED' };
}

const CURRENT_SCHEMA = 'mbrs003.scan-load-current-fixed-receipts.v2';
const CURRENT_CAP = '151377066685041';
const SOURCE92_SHA = 'e6db4164abe428ade5ace5c5dd3b14e4ad51576f6469fa6238bb78c920c578e2';
const exactRef = r => r && typeof r.path === 'string' && path.isAbsolute(r.path)
  && path.resolve(r.path) === r.path && integer(r.bytes) && r.bytes > 0 && hash(r.sha256);
const sameRef = (a,b) => exactRef(a) && exactRef(b) && a.path === b.path && a.bytes === b.bytes && a.sha256 === b.sha256;
const needCurrent = (value,code='SCAN_LOAD_IDENTITY_INVALID') => { if (!value) stop(code); };
const currentDigest = files => sha(JSON.stringify(files.map(r=>({path:r.path,bytes:r.bytes,sha256:r.sha256}))));
const SIX_KEYS = ['gate','result','admission','fs_terminal','process_closure','terminal'];
const runtimeRows = files => Array.isArray(files) && files.length > 0 && files.length <= 8192
  && new Set(files.map(r=>r?.path)).size === files.length && files.every(exactRef);
const jsonCurrent = (r,a,b) => { b.check('CURRENT_FIXED_JSON'); const v=JSON.parse(checked(r,a.storage,b));b.check('CURRENT_FIXED_JSON');return v; };
const finiteTime = s => Number.isFinite(Date.parse(s));
const naturalGate = r => r?.exitCode === 0 && r.signal === null && r.timedOut === false
  && Number.isFinite(r.durationSeconds) && r.durationSeconds >= 0 && finiteTime(r.startedAt)
  && finiteTime(r.completedAt) && Date.parse(r.completedAt) >= Date.parse(r.startedAt);
/** 明确包装可解析；不接受任意shell/python源，也不从名字猜Node argv。 */
function currentNodeArgv(argv, executable, coreRoot) {
  needCurrent(Array.isArray(argv) && argv.length <= 40,'SCAN_LOAD_RUNNER_FAILED');
  let rest = [...argv];
  if (rest[0] === '/usr/bin/env') {
    needCurrent(rest[1] === '-i','SCAN_LOAD_RUNNER_FAILED'); rest = rest.slice(2);
    const allowed = new Set(['PATH','TMPDIR','DEV_BUILD_ROOT','DEV_CACHE_ROOT','NODE_ENV','COREPACK_ENABLE_NETWORK',
      'MBRS003_READER_BUILD_BINDING','npm_config_ignore_scripts']); const seen = new Set();
    while (typeof rest[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0])) {
      const at = rest[0].indexOf('='),key = rest[0].slice(0,at);
      needCurrent(allowed.has(key) && !seen.has(key) && !/[\u0000\r\n]/u.test(rest[0]),'SCAN_LOAD_RUNNER_FAILED');
      seen.add(key); rest.shift();
    }
  }
  const cwdSource = 'import os,sys;os.chdir(sys.argv[1]);os.execv(sys.argv[2],sys.argv[2:])';
  if (rest[0] !== executable) {
    needCurrent(typeof rest[0] === 'string' && path.isAbsolute(rest[0]) && /\/python3(?:\.\d+)?$/u.test(rest[0])
      && rest[1] === '-c' && rest[2] === cwdSource && rest[3] === coreRoot,'SCAN_LOAD_RUNNER_FAILED');
    rest = rest.slice(4);
  }
  needCurrent(rest.length === 7 && rest[0] === executable && rest.every(x=>typeof x === 'string'),'SCAN_LOAD_RUNNER_FAILED');
  return rest;
}
/** 未来null/NOT_ADMITTED、任一profile不终态，在任何storage/file读前拒绝。 */
function preflightCurrent(spec) {
  needCurrent(spec?.schema === CURRENT_SCHEMA && spec.status === 'ROOT_CURRENT_FIXED_SCALE_TERMINAL_RECEIPTS_FROZEN'
    && typeof spec.nodeExecutable === 'string' && path.isAbsolute(spec.nodeExecutable)
    && Array.isArray(spec.profiles) && spec.profiles.length === 2,'SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  needCurrent(spec.profiles[0]?.count === 100000 && spec.profiles[1]?.count === 300000);
  for (const p of spec.profiles) {
    needCurrent(p.state === 'TERMINAL','SCAN_LOAD_PROFILE_NOT_TERMINAL');
    needCurrent(exactRef(p.bindingRef) && exactRef(p.runnerSealRef) && exactRef(p.executionClosureRef)
      && p.references && Object.keys(p.references).sort().join(',') === [...SIX_KEYS].sort().join(',')
      && SIX_KEYS.every(k=>exactRef(p.references[k])),'SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  }
}
/** 新固定bundle协议：只后验；不SQL、不加载Worker、不启动扫描。 */
export async function readCurrentFixedLoadEvidence(spec, admission, budget) {
  preflightCurrent(spec);
  const profiles = []; let first = null;
  for (const p of spec.profiles) {
    budget.check('CURRENT_FIXED_SCALE_RECEIPTS');
    const refs=p.references,binding=jsonCurrent(p.bindingRef,admission,budget),runAdmission=jsonCurrent(refs.admission,admission,budget);
    const refNames=['currentReaderBuildBindingRef','fixedWorkerValidatorRef','source92Ref','runtimeClosureRef','executionAdmissionRef'];
    needCurrent(binding.schema === 'mbrs003.scale.fixed-worker-fresh-runtime.v2'
      && binding.status === 'ROOT_CURRENT_FIXED_BUNDLE_SCALE_RUNTIME_ADMITTED'
      && refNames.every(k=>exactRef(binding[k])) && exactRef(binding.contextModule)
      && typeof binding.fixedWorkerCoreRoot === 'string' && path.isAbsolute(binding.fixedWorkerCoreRoot)
      && binding.compilerExit === 0 && binding.precompileInputsPostchecked === true
      && binding.ownerAdmission === 'PRODUCTION_ADMISSION_BODY_IDLE_CONTROL' && runtimeRows(binding.files)
      && binding.source92Ref.bytes === 1093923 && binding.source92Ref.sha256 === SOURCE92_SHA
      && binding.files.reduce((n,r)=>n+r.bytes,0) <= 256*1024*1024);
    const expectedInner=p.count===100000?21600000:64800000,expectedWhole=p.count===100000?23400:66600;
    needCurrent(runAdmission.schema === 'mbrs003.root.current-fixed-bundle-scale-run-admission.v1'
      && runAdmission.status === 'ROOT_CURRENT_FIXED_BUNDLE_SCALE_PROFILE_ADMITTED'
      && runAdmission.count === p.count && runAdmission.innerBudgetMs === expectedInner && runAdmission.wholeBudgetSeconds === expectedWhole
      && runAdmission.retries === 0 && runAdmission.originalDeadlineMonotonicNs === CURRENT_CAP
      && runAdmission.freshEmptyDatabase === true && exactRef(runAdmission.authorizationRef)
      && sameRef(binding.executionAdmissionRef,refs.admission) && sameRef(runAdmission.runtimeClosureRef,binding.runtimeClosureRef)
      && exactRef(runAdmission.harnessRef) && typeof runAdmission.corpusDirectory === 'string'
      && path.isAbsolute(runAdmission.corpusDirectory) && typeof runAdmission.databaseDirectory === 'string'
      && path.isAbsolute(runAdmission.databaseDirectory) && runAdmission.outputFile === refs.result.path);
    needCurrent(runAdmission.databaseDirectory !== runAdmission.corpusDirectory
      && !runAdmission.databaseDirectory.startsWith(runAdmission.corpusDirectory+path.sep)
      && !runAdmission.corpusDirectory.startsWith(runAdmission.databaseDirectory+path.sep)
      && !refs.result.path.startsWith(runAdmission.databaseDirectory+path.sep));
    if (p.count === 100000) needCurrent(binding.current100kCompletion === null && binding.completed100kReferences === null);
    else needCurrent(first && sameRef(binding.current100kCompletion,first.references.result)
      && binding.completed100kReferences && SIX_KEYS.every(k=>sameRef(binding.completed100kReferences[k],first.references[k]))
      && Object.keys(binding.completed100kReferences).sort().join(',') === [...SIX_KEYS].sort().join(','));
    const runtimeClosure=jsonCurrent(binding.runtimeClosureRef,admission,budget),digest=currentDigest(binding.files);
    needCurrent(runtimeClosure.schema === 'mbrs003.root.current-fixed-bundle-scale-runtime-closure.v1'
      && runtimeClosure.status === 'ROOT_RUNTIME_SOURCE_AND_OUTPUT_CLOSURE_VERIFIED'
      && runtimeClosure.completeRuntimeCodeClosure === true && runtimeClosure.sourceAndOutputsHeld === true
      && runtimeClosure.runtimeSourceFilesDigest === digest && JSON.stringify(runtimeClosure.runtimeFiles) === JSON.stringify(binding.files)
      && sameRef(runtimeClosure.source92Ref,binding.source92Ref) && sameRef(runtimeClosure.readerBuildBindingRef,binding.currentReaderBuildBindingRef)
      && sameRef(runtimeClosure.fixedWorkerValidatorRef,binding.fixedWorkerValidatorRef) && sameRef(runtimeClosure.contextModuleRef,binding.contextModule)
      && sameRef(runtimeClosure.harnessRef,runAdmission.harnessRef) && exactRef(runtimeClosure.actualCompilerClosureRef));
    // 当前O55实际编译/工具闭合与v2 binding精确互指；不把旧snapshot compiler当新来源。
    needCurrent(runtimeClosure.actualCompilerClosureRef.bytes === 19156
      && runtimeClosure.actualCompilerClosureRef.sha256 === '06b3166586acf72c5c119bbc7ea9525f79a7d4bcb663410a160613ca0285c6c5');
    const compilerClosure=jsonCurrent(runtimeClosure.actualCompilerClosureRef,admission,budget),cg=compilerClosure.gateClosures?.['55'];
    needCurrent(compilerClosure.schema === 'mbrs003.root.direct-tool-current-O-install-original124-closure.v1'
      && compilerClosure.status === 'ACTUAL_INSTALL_AND_CURRENT_ORIGINAL124_ALL_PASS_CHILD_ARCHIVE_WAIT_CLOSED'
      && compilerClosure.actualSoftwareSummary?.freshCore?.compilerExit === 0
      && compilerClosure.actualSoftwareSummary.bindings?.some(r=>r.key === 'readerBindingRef' && r.schema === 'mbrs003.reader.fresh-build.v2'
        && sameRef(r.ref,binding.currentReaderBuildBindingRef)) && cg?.toolExitCode === 0
      && cg.rootRawTerminalToolResult?.exit_code === 0 && cg.childWaitConfirmed === true && cg.archiveWaitConfirmed === true);
    const compilerGate=jsonCurrent(cg.gateResultRef,admission,budget),compilerSeal=jsonCurrent(cg.runnerSealRef,admission,budget);
    needCurrent(naturalGate(compilerGate) && compilerGate.deadlineGuard?.actualChildWaitCompleted === true
      && compilerGate.deadlineGuard.archiveExitCode === 0 && compilerSeal.actualChildExitCode === 0
      && compilerSeal.actualChildWaitCompleted === true && compilerSeal.actualArchiveWaitCompleted === true && compilerSeal.archiveExitCode === 0);
    const authorization=jsonCurrent(runAdmission.authorizationRef,admission,budget);
    needCurrent(authorization.schema === 'mbrs003.root.current-fixed-bundle-scale-authorization.v1'
      && authorization.status === 'ROOT_EXPLICIT_CURRENT_FIXED_SCALE_PROFILE_AUTHORIZED' && authorization.count === p.count
      && sameRef(authorization.source92Ref,binding.source92Ref) && authorization.defaultReaderTimeoutMs === 3000
      && authorization.innerBudgetMs === expectedInner && authorization.wholeBudgetSeconds === expectedWhole
      && authorization.retries === 0 && authorization.originalDeadlineMonotonicNs === CURRENT_CAP);
    const reader=jsonCurrent(binding.currentReaderBuildBindingRef,admission,budget);
    const sourceMap=jsonCurrent(binding.source92Ref,admission,budget);
    needCurrent(Object.keys(sourceMap).length === 1840 && reader.schema === 'mbrs003.reader.fresh-build.v2'
      && reader.compilerExit === 0 && Number.isFinite(reader.compilerStartedAtMs) && Number.isFinite(reader.compilerFinishedAtMs)
      && reader.compilerFinishedAtMs >= reader.compilerStartedAtMs && Array.isArray(reader.sourceInputs)
      && reader.sourceInputs.length === 4 && Array.isArray(reader.outputs) && reader.outputs.length === 8 && reader.fixedWorkerBundle);
    const fileMap=new Map(binding.files.map(r=>[r.path,r]));
    const requireMember = r => needCurrent(exactRef(r) && sameRef(fileMap.get(r.path),r));
    requireMember(binding.contextModule); requireMember(binding.fixedWorkerValidatorRef);requireMember(runAdmission.harnessRef);
    for (const row of reader.sourceInputs) {
      const identity={path:path.resolve(binding.fixedWorkerCoreRoot,row.file),bytes:row.bytes,sha256:row.sha256};requireMember(identity);
      const authoritative=sourceMap['packages/bridge-core/'+row.file];
      needCurrent(authoritative?.reference?.bytes === row.bytes && authoritative.reference.sha256 === row.sha256);
    }
    for (const row of reader.outputs) requireMember({path:path.resolve(binding.fixedWorkerCoreRoot,row.file),bytes:row.bytes,sha256:row.sha256});
    // 运行时闭集仅纯代码/已声明esbuild binary；绝不允许DB、音频、旧result作为绑定输入。
    const tools=new Set(reader.fixedWorkerBundle.toolInputs?.map(r=>r.file));
    for (const row of binding.files) {
      needCurrent(/\.(?:ts|mts|cts|js|mjs|cjs|json|map|yaml|yml)$/u.test(row.path) || tools.has(row.path));
      needCurrent(!/(?:^|\/)(?:library\.sqlite|result(?:100k|300k)\.json|scale-identity\.json)$/u.test(row.path));
      checked(row,admission.storage,budget,16*1024*1024);
    }
    // 只import已逐字pin的validator，不import Reader/Worker；该函数验证map/graph/EOF/guard闭集。
    const localValidatorURL=new URL('../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs',import.meta.url);
    const localValidatorPath=decodeURIComponent(localValidatorURL.pathname);
    budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    const localValidator=readFileSync(localValidatorPath);budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    needCurrent(localValidator.length === binding.fixedWorkerValidatorRef.bytes && sha(localValidator) === binding.fixedWorkerValidatorRef.sha256);
    budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    const {readFixedMetadataWorkerBundle}=await import(localValidatorURL.href);budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    const fixed=await readFixedMetadataWorkerBundle(binding.fixedWorkerCoreRoot,()=>budget.check('CURRENT_FIXED_BUNDLE_CLOSURE'));
    needCurrent(JSON.stringify(fixed.manifest) === JSON.stringify(reader.fixedWorkerBundle));
    budget.check('CURRENT_FIXED_BUNDLE_CLOSURE');
    const manifest=fixed.manifest;
    for (const row of [...manifest.rootInputs,...manifest.loadedInputs,...manifest.packageInputs,...manifest.toolInputs,
      manifest.entry,manifest.map,manifest.metafile,fixed.receiptRef]) {
      requireMember({path:path.resolve(binding.fixedWorkerCoreRoot,row.file),bytes:row.bytes,sha256:row.sha256});
    }
    const gate=jsonCurrent(refs.gate,admission,budget),seal=jsonCurrent(p.runnerSealRef,admission,budget);
    const observation=jsonCurrent(refs.result,admission,budget),identity=observation.fixedWorkerRuntimeIdentity;
    const facts=validateScaleObservation(observation,p.count);
    needCurrent(observation.maxMilliseconds === expectedInner && observation.currentSourceFilesHeld === true
      && observation.runtimeSourceFilesDigest === digest && sameRef(observation.runtimeBindingReference,p.bindingRef)
      && observation.databaseDirectory === runAdmission.databaseDirectory && identity?.schema === 'mbrs003.scale.fixed-worker-runtime-identity.v1'
      && sameRef(identity.source92Ref,binding.source92Ref) && sameRef(identity.currentReaderBuildBindingRef,binding.currentReaderBuildBindingRef)
      && sameRef(identity.runtimeClosureRef,binding.runtimeClosureRef) && sameRef(identity.executionAdmissionRef,refs.admission)
      && sameRef(identity.fixedWorkerBundleReceiptRef,{path:fixed.receiptRef.file,bytes:fixed.receiptRef.bytes,sha256:fixed.receiptRef.sha256})
      && sameRef(identity.fixedWorkerEntryRef,{path:path.resolve(binding.fixedWorkerCoreRoot,manifest.entry.file),bytes:manifest.entry.bytes,sha256:manifest.entry.sha256})
      && identity.wholeBudgetSeconds === expectedWhole && identity.originalDeadlineMonotonicNs === CURRENT_CAP && identity.retries === 0
      && (p.count===100000 ? identity.current100kCompletion === null : sameRef(identity.current100kCompletion,first.references.result)), 'SCAN_LOAD_RESULT_INVALID');
    const g=gate.deadlineGuard;
    needCurrent(naturalGate(gate) && gate.durationSeconds <= expectedWhole && g?.actualChildWaitCompleted === true
      && g.archiveExitCode === 0 && integer(g.ownChildPid) && g.ownChildPid > 0 && integer(g.archivePid) && g.archivePid > 0 && g.archivePid !== g.ownChildPid
      && g.originalWholeDeadlineSupplied === true && /^[1-9][0-9]*$/u.test(g.absoluteDeadlineMonotonicNs)
      && BigInt(g.absoluteDeadlineMonotonicNs) <= BigInt(CURRENT_CAP) && Number.isFinite(g.ownBudgetSeconds)
      && g.ownBudgetSeconds > 0 && g.ownBudgetSeconds <= expectedWhole && Array.isArray(g.terminationSignals) && g.terminationSignals.length === 0
      && seal.schema === 'mbrs003.root.deadline-closure-gate-seal.v1' && seal.name === gate.name
      && seal.actualChildExitCode === 0 && seal.actualChildWaitCompleted === true && seal.actualArchiveWaitCompleted === true
      && seal.archiveExitCode === 0 && seal.originalDeadlineMonotonicNs === g.absoluteDeadlineMonotonicNs
      && Number.isFinite(g.childWaitAllocatedSeconds) && g.childWaitAllocatedSeconds > 0 && g.childWaitAllocatedSeconds <= g.ownBudgetSeconds
      && Number.isFinite(seal.elapsedSecondsAfterResultClosed) && seal.elapsedSecondsAfterResultClosed >= gate.durationSeconds
      && seal.elapsedSecondsAfterResultClosed <= g.ownBudgetSeconds,'SCAN_LOAD_RUNNER_FAILED');
    const argv=currentNodeArgv(gate.argv,spec.nodeExecutable,binding.fixedWorkerCoreRoot);
    const reuse=p.count===100000?'NONE':first.references.result.path;
    needCurrent(JSON.stringify(argv) === JSON.stringify([spec.nodeExecutable,runAdmission.harnessRef.path,runAdmission.corpusDirectory,
      refs.result.path,String(p.count),p.bindingRef.path,reuse]),'SCAN_LOAD_RUNNER_FAILED');
    checked(gate.log,admission.storage,budget,4*1024*1024);
    const fs=jsonCurrent(refs.fs_terminal,admission,budget),pc=jsonCurrent(refs.process_closure,admission,budget),terminal=jsonCurrent(refs.terminal,admission,budget);
    for (const x of [fs,pc,terminal]) needCurrent(x.count === p.count && x.runtimeSourceFilesDigest === digest
      && sameRef(x.runtimeBindingReference,p.bindingRef) && sameRef(x.resultRef,refs.result) && sameRef(x.gateResultRef,refs.gate));
    needCurrent(fs.schema === 'mbrs003.root.current-fixed-scale-fs-terminal.v1' && fs.status === 'ROOT_FS_NORMAL_END_CLOSED'
      && fs.actualExitCode === 0 && fs.normalEnd === true && fs.actualStdoutStderrClosed === true,'SCAN_LOAD_RUNNER_FAILED');
    needCurrent(pc.schema === 'mbrs003.root.current-fixed-scale-process-closure.v1' && pc.status === 'ROOT_CURRENT_FIXED_SCALE_OWNED_PROCESSES_CLOSED'
      && pc.actualExitCode === 0 && pc.actualSignal === null && pc.actualNodePid === g.ownChildPid
      && pc.actualChildWaitCompleted === true && pc.actualStdoutStderrClosed === true && pc.actualNodePidAbsent === true
      && pc.actualArchivePid === g.archivePid && pc.actualArchivePidAbsent === true
      && pc.actualOwnedGroupsAbsent === true && Array.isArray(pc.remainingOwnedProcesses) && pc.remainingOwnedProcesses.length === 0
      && sameRef(pc.fsTerminalRef,refs.fs_terminal),'SCAN_LOAD_RUNNER_FAILED');
    needCurrent(terminal.schema === 'mbrs003.root.current-fixed-scale-terminal-summary.v1' && terminal.status === 'FINITE_SOFTWARE_CURRENT_FIXED_SCALE_PASS'
      && terminal.validatorExitCode === 0 && terminal.runnerActualStatus === 'SOFTWARE_SCALE_OBSERVED'
      && sameRef(terminal.processClosureRef,refs.process_closure) && sameRef(terminal.fsTerminalRef,refs.fs_terminal)
      && terminal.originalDeadlineMonotonicNs === CURRENT_CAP && Number.isFinite(terminal.wholePhaseElapsedSeconds)
      && terminal.wholePhaseElapsedSeconds >= 0 && terminal.wholePhaseElapsedSeconds <= expectedWhole,'SCAN_LOAD_RESULT_INVALID');
    const execution=jsonCurrent(p.executionClosureRef,admission,budget),raw=execution.rootRawTerminalToolResult;
    needCurrent(execution.schema === 'mbrs003.root.current-fixed-scale-execution-closure.v1'
      && execution.status === 'ROOT_ACTUAL_CURRENT_FIXED_SCALE_TOOL_CLOSED' && execution.count === p.count
      && execution.runtimeSourceFilesDigest === digest && sameRef(execution.runtimeBindingReference,p.bindingRef)
      && sameRef(execution.runnerSealRef,p.runnerSealRef) && sameRef(execution.executionAdmissionRef,refs.admission)
      && SIX_KEYS.every(k=>sameRef(execution.references?.[k],refs[k])) && execution.actualToolExitCode === 0
      && execution.actualStdoutStderrClosed === true && raw?.exit_code === 0 && typeof raw.chunk_id === 'string'
      && raw.chunk_id.length > 0 && typeof raw.output === 'string' && !('session_id' in raw)
      && execution.actualSessionId === null && execution.actualChunkId === raw.chunk_id
      && sameRef(execution.rawOutputGateRef,refs.gate),'SCAN_LOAD_RUNNER_FAILED');
    needCurrent(/^[1-9][0-9]*$/u.test(execution.actualToolClosedMonotonicNs)
      && BigInt(execution.actualToolClosedMonotonicNs) <= BigInt(CURRENT_CAP)
      && finiteTime(execution.actualToolClosedAt) && Date.parse(execution.actualToolClosedAt) >= Date.parse(gate.completedAt));
    if (first) needCurrent(digest === first.runtimeSourceFilesDigest && sameRef(binding.runtimeClosureRef,first.runtimeClosureRef)
      && sameRef(binding.source92Ref,first.source92Ref) && sameRef(binding.currentReaderBuildBindingRef,first.readerBuildBindingRef)
      && sameRef(runAdmission.harnessRef,first.harnessRef) && runAdmission.databaseDirectory !== first.databaseDirectory
      && Date.parse(gate.startedAt) >= Date.parse(first.actualToolClosedAt)
      && BigInt(execution.actualToolClosedMonotonicNs) >= BigInt(first.actualToolClosedMonotonicNs));
    first={references:refs,runtimeSourceFilesDigest:digest,runtimeClosureRef:binding.runtimeClosureRef,source92Ref:binding.source92Ref,
      readerBuildBindingRef:binding.currentReaderBuildBindingRef,harnessRef:runAdmission.harnessRef,databaseDirectory:runAdmission.databaseDirectory,
      actualToolClosedAt:execution.actualToolClosedAt,actualToolClosedMonotonicNs:execution.actualToolClosedMonotonicNs};
    profiles.push({...facts,status:'FINITE_CURRENT_FIXED_RUNTIME_SCALE_OBSERVED',references:refs,bindingRef:p.bindingRef,
      runnerSealRef:p.runnerSealRef,executionClosureRef:p.executionClosureRef,runtimeSourceFilesDigest:digest});
  }
  budget.check('CURRENT_FIXED_SCALE_FINAL_DECISION');
  return {status:'FINITE_CURRENT_FIXED_RUNTIME_SCALE_OBSERVED',profiles,noScaleExecutionInGate:true,
    sourceAndOutputIdentityUnchanged:true,dependencyClosure:'ROOT_DECLARED_CODE_RUNTIME_AND_FRESH_FIXED_BUNDLE_CLOSED',
    renderer:'NOT_RUN',app:'NOT_RUN',ownerAcceptance:'NOT_RUN',atAcceptance:'NOT_INFERRED',wholeTaskAcceptance:'NOT_INFERRED'};
}


const CURRENT_ROUND_SCHEMA = 'mbrs003.scan-load-current-fixed-receipts.v3';
/** 旧cap仅历史账；新规模窗口必须有新起点和精确固定预算，不查询当前clock来拒历史成功100k。 */
function currentRoundClock(p) {
  const whole=p?.count===100000?23400:p?.count===300000?66600:null;
  needCurrent(whole !== null && p.wholeBudgetSeconds === whole
    && p.innerBudgetMs === (p.count===100000?21600000:64800000)
    && p.defaultReaderTimeoutMs === 3000 && p.retries === 0);
  needCurrent(p.historicalConsumed300kDeadlineMonotonicNs === CURRENT_CAP
    && typeof p.startedMonotonicNs === 'string' && /^[1-9][0-9]*$/u.test(p.startedMonotonicNs)
    && typeof p.profileDeadlineMonotonicNs === 'string' && /^[1-9][0-9]*$/u.test(p.profileDeadlineMonotonicNs));
  needCurrent(BigInt(p.startedMonotonicNs) > BigInt(CURRENT_CAP)
    && BigInt(p.profileDeadlineMonotonicNs) === BigInt(p.startedMonotonicNs)+BigInt(whole)*1000000000n);
  return {startedMonotonicNs:p.startedMonotonicNs,profileDeadlineMonotonicNs:p.profileDeadlineMonotonicNs};
}
const sameRoundClock = (value,p) => value?.startedMonotonicNs === p.startedMonotonicNs
  && value?.profileDeadlineMonotonicNs === p.profileDeadlineMonotonicNs
  && value?.historicalConsumed300kDeadlineMonotonicNs === CURRENT_CAP;
/** 顶层未来许可/窗口/全部refs必须齐全；在第一份实际文件读取前拒绝。 */
function preflightCurrentRound(spec) {
  needCurrent(spec?.schema === CURRENT_ROUND_SCHEMA && spec.status === 'ROOT_CURRENT_FIXED_SCALE_TERMINAL_RECEIPTS_FROZEN'
    && typeof spec.nodeExecutable === 'string' && path.isAbsolute(spec.nodeExecutable)
    && Array.isArray(spec.profiles) && spec.profiles.length === 2,'SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  needCurrent(spec.profiles[0]?.count === 100000 && spec.profiles[1]?.count === 300000);
  for (const p of spec.profiles) {
    needCurrent(p.state === 'TERMINAL','SCAN_LOAD_PROFILE_NOT_TERMINAL');
    currentRoundClock(p);
    needCurrent(exactRef(p.ownerApprovalRef)
      && p.ownerApprovalRef.sha256 !== 'b3808ca399610f80c4ef3cfa904851e0788a722e22ff9441a4fc4657c2c95f0a'
      && exactRef(p.bindingRef) && exactRef(p.runnerSealRef) && exactRef(p.executionClosureRef)
      && p.references && Object.keys(p.references).sort().join(',') === [...SIX_KEYS].sort().join(',')
      && SIX_KEYS.every(k=>exactRef(p.references[k])),'SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  }
}
export async function readCurrentFixedScaleRoundLoadEvidence(spec, admission, budget) {
  preflightCurrentRound(spec);
  const profiles = []; let first = null;
  for (const p of spec.profiles) {
    budget.check('CURRENT_FIXED_SCALE_RECEIPTS');
    const {startedMonotonicNs:profileStart,profileDeadlineMonotonicNs:profileDeadline}=currentRoundClock(p);
    const refs=p.references,binding=jsonCurrent(p.bindingRef,admission,budget),runAdmission=jsonCurrent(refs.admission,admission,budget);
    const refNames=['currentReaderBuildBindingRef','fixedWorkerValidatorRef','source92Ref','runtimeClosureRef','executionAdmissionRef'];
    needCurrent(binding.schema === 'mbrs003.scale.fixed-worker-fresh-runtime.v3' && sameRoundClock(binding,p)
      && binding.status === 'ROOT_CURRENT_FIXED_BUNDLE_SCALE_RUNTIME_ADMITTED'
      && refNames.every(k=>exactRef(binding[k])) && exactRef(binding.contextModule)
      && typeof binding.fixedWorkerCoreRoot === 'string' && path.isAbsolute(binding.fixedWorkerCoreRoot)
      && binding.compilerExit === 0 && binding.precompileInputsPostchecked === true
      && binding.ownerAdmission === 'PRODUCTION_ADMISSION_BODY_IDLE_CONTROL' && runtimeRows(binding.files)
      && binding.source92Ref.bytes === 1093923 && binding.source92Ref.sha256 === SOURCE92_SHA
      && binding.files.reduce((n,r)=>n+r.bytes,0) <= 256*1024*1024);
    const expectedInner=p.count===100000?21600000:64800000,expectedWhole=p.count===100000?23400:66600;
    needCurrent(runAdmission.schema === 'mbrs003.root.current-fixed-bundle-scale-run-admission.v2' && sameRoundClock(runAdmission,p)
      && runAdmission.status === 'ROOT_CURRENT_FIXED_BUNDLE_SCALE_PROFILE_ADMITTED'
      && runAdmission.count === p.count && runAdmission.innerBudgetMs === expectedInner && runAdmission.wholeBudgetSeconds === expectedWhole
      && runAdmission.retries === 0
      && runAdmission.freshEmptyDatabase === true && exactRef(runAdmission.authorizationRef)
      && sameRef(binding.executionAdmissionRef,refs.admission) && sameRef(runAdmission.runtimeClosureRef,binding.runtimeClosureRef)
      && exactRef(runAdmission.harnessRef) && typeof runAdmission.corpusDirectory === 'string'
      && path.isAbsolute(runAdmission.corpusDirectory) && typeof runAdmission.databaseDirectory === 'string'
      && path.isAbsolute(runAdmission.databaseDirectory) && runAdmission.outputFile === refs.result.path);
    needCurrent(runAdmission.databaseDirectory !== runAdmission.corpusDirectory
      && !runAdmission.databaseDirectory.startsWith(runAdmission.corpusDirectory+path.sep)
      && !runAdmission.corpusDirectory.startsWith(runAdmission.databaseDirectory+path.sep)
      && !refs.result.path.startsWith(runAdmission.databaseDirectory+path.sep));
    if (p.count === 100000) needCurrent(binding.current100kCompletion === null && binding.completed100kReferences === null);
    else needCurrent(first && sameRef(binding.current100kCompletion,first.references.result)
      && binding.completed100kReferences && SIX_KEYS.every(k=>sameRef(binding.completed100kReferences[k],first.references[k]))
      && Object.keys(binding.completed100kReferences).sort().join(',') === [...SIX_KEYS].sort().join(','));
    const runtimeClosure=jsonCurrent(binding.runtimeClosureRef,admission,budget),digest=currentDigest(binding.files);
    needCurrent(runtimeClosure.schema === 'mbrs003.root.current-fixed-bundle-scale-runtime-closure.v1'
      && runtimeClosure.status === 'ROOT_RUNTIME_SOURCE_AND_OUTPUT_CLOSURE_VERIFIED'
      && runtimeClosure.completeRuntimeCodeClosure === true && runtimeClosure.sourceAndOutputsHeld === true
      && runtimeClosure.runtimeSourceFilesDigest === digest && JSON.stringify(runtimeClosure.runtimeFiles) === JSON.stringify(binding.files)
      && sameRef(runtimeClosure.source92Ref,binding.source92Ref) && sameRef(runtimeClosure.readerBuildBindingRef,binding.currentReaderBuildBindingRef)
      && sameRef(runtimeClosure.fixedWorkerValidatorRef,binding.fixedWorkerValidatorRef) && sameRef(runtimeClosure.contextModuleRef,binding.contextModule)
      && sameRef(runtimeClosure.harnessRef,runAdmission.harnessRef) && exactRef(runtimeClosure.actualCompilerClosureRef));
    // 当前O55实际编译/工具闭合与v2 binding精确互指；不把旧snapshot compiler当新来源。
    needCurrent(runtimeClosure.actualCompilerClosureRef.bytes === 19156
      && runtimeClosure.actualCompilerClosureRef.sha256 === '06b3166586acf72c5c119bbc7ea9525f79a7d4bcb663410a160613ca0285c6c5');
    const compilerClosure=jsonCurrent(runtimeClosure.actualCompilerClosureRef,admission,budget),cg=compilerClosure.gateClosures?.['55'];
    needCurrent(compilerClosure.schema === 'mbrs003.root.direct-tool-current-O-install-original124-closure.v1'
      && compilerClosure.status === 'ACTUAL_INSTALL_AND_CURRENT_ORIGINAL124_ALL_PASS_CHILD_ARCHIVE_WAIT_CLOSED'
      && compilerClosure.actualSoftwareSummary?.freshCore?.compilerExit === 0
      && compilerClosure.actualSoftwareSummary.bindings?.some(r=>r.key === 'readerBindingRef' && r.schema === 'mbrs003.reader.fresh-build.v2'
        && sameRef(r.ref,binding.currentReaderBuildBindingRef)) && cg?.toolExitCode === 0
      && cg.rootRawTerminalToolResult?.exit_code === 0 && cg.childWaitConfirmed === true && cg.archiveWaitConfirmed === true);
    const compilerGate=jsonCurrent(cg.gateResultRef,admission,budget),compilerSeal=jsonCurrent(cg.runnerSealRef,admission,budget);
    needCurrent(naturalGate(compilerGate) && compilerGate.deadlineGuard?.actualChildWaitCompleted === true
      && compilerGate.deadlineGuard.archiveExitCode === 0 && compilerSeal.actualChildExitCode === 0
      && compilerSeal.actualChildWaitCompleted === true && compilerSeal.actualArchiveWaitCompleted === true && compilerSeal.archiveExitCode === 0);
    const authorization=jsonCurrent(runAdmission.authorizationRef,admission,budget);
    needCurrent(authorization.schema === 'mbrs003.root.current-fixed-bundle-scale-authorization.v2' && sameRoundClock(authorization,p)
      && authorization.status === 'ROOT_EXPLICIT_CURRENT_FIXED_SCALE_PROFILE_AUTHORIZED' && authorization.count === p.count
      && sameRef(authorization.source92Ref,binding.source92Ref) && authorization.defaultReaderTimeoutMs === 3000
      && authorization.innerBudgetMs === expectedInner && authorization.wholeBudgetSeconds === expectedWhole
      && authorization.retries === 0 && authorization.scope === 'OWNER_NEW_FIXED_SCALE_ROUND'
      && authorization.allowedCompleteRounds === 1 && sameRef(authorization.ownerApprovalRef,p.ownerApprovalRef)
      && sameRef(authorization.harnessRef,runAdmission.harnessRef));
    jsonCurrent(authorization.ownerApprovalRef,admission,budget);
    const reader=jsonCurrent(binding.currentReaderBuildBindingRef,admission,budget);
    const sourceMap=jsonCurrent(binding.source92Ref,admission,budget);
    needCurrent(Object.keys(sourceMap).length === 1840 && reader.schema === 'mbrs003.reader.fresh-build.v2'
      && reader.compilerExit === 0 && Number.isFinite(reader.compilerStartedAtMs) && Number.isFinite(reader.compilerFinishedAtMs)
      && reader.compilerFinishedAtMs >= reader.compilerStartedAtMs && Array.isArray(reader.sourceInputs)
      && reader.sourceInputs.length === 4 && Array.isArray(reader.outputs) && reader.outputs.length === 8 && reader.fixedWorkerBundle);
    const fileMap=new Map(binding.files.map(r=>[r.path,r]));
    const requireMember = r => needCurrent(exactRef(r) && sameRef(fileMap.get(r.path),r));
    requireMember(binding.contextModule); requireMember(binding.fixedWorkerValidatorRef);requireMember(runAdmission.harnessRef);
    for (const row of reader.sourceInputs) {
      const identity={path:path.resolve(binding.fixedWorkerCoreRoot,row.file),bytes:row.bytes,sha256:row.sha256};requireMember(identity);
      const authoritative=sourceMap['packages/bridge-core/'+row.file];
      needCurrent(authoritative?.reference?.bytes === row.bytes && authoritative.reference.sha256 === row.sha256);
    }
    for (const row of reader.outputs) requireMember({path:path.resolve(binding.fixedWorkerCoreRoot,row.file),bytes:row.bytes,sha256:row.sha256});
    // 运行时闭集仅纯代码/已声明esbuild binary；绝不允许DB、音频、旧result作为绑定输入。
    const tools=new Set(reader.fixedWorkerBundle.toolInputs?.map(r=>r.file));
    for (const row of binding.files) {
      needCurrent(/\.(?:ts|mts|cts|js|mjs|cjs|json|map|yaml|yml)$/u.test(row.path) || tools.has(row.path));
      needCurrent(!/(?:^|\/)(?:library\.sqlite|result(?:100k|300k)\.json|scale-identity\.json)$/u.test(row.path));
      checked(row,admission.storage,budget,16*1024*1024);
    }
    // 只import已逐字pin的validator，不import Reader/Worker；该函数验证map/graph/EOF/guard闭集。
    const localValidatorURL=new URL('../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs',import.meta.url);
    const localValidatorPath=decodeURIComponent(localValidatorURL.pathname);
    budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    const localValidator=readFileSync(localValidatorPath);budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    needCurrent(localValidator.length === binding.fixedWorkerValidatorRef.bytes && sha(localValidator) === binding.fixedWorkerValidatorRef.sha256);
    budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    const {readFixedMetadataWorkerBundle}=await import(localValidatorURL.href);budget.check('CURRENT_FIXED_VALIDATOR_IDENTITY');
    const fixed=await readFixedMetadataWorkerBundle(binding.fixedWorkerCoreRoot,()=>budget.check('CURRENT_FIXED_BUNDLE_CLOSURE'));
    needCurrent(JSON.stringify(fixed.manifest) === JSON.stringify(reader.fixedWorkerBundle));
    budget.check('CURRENT_FIXED_BUNDLE_CLOSURE');
    const manifest=fixed.manifest;
    for (const row of [...manifest.rootInputs,...manifest.loadedInputs,...manifest.packageInputs,...manifest.toolInputs,
      manifest.entry,manifest.map,manifest.metafile,fixed.receiptRef]) {
      requireMember({path:path.resolve(binding.fixedWorkerCoreRoot,row.file),bytes:row.bytes,sha256:row.sha256});
    }
    const gate=jsonCurrent(refs.gate,admission,budget),seal=jsonCurrent(p.runnerSealRef,admission,budget);
    const observation=jsonCurrent(refs.result,admission,budget),identity=observation.fixedWorkerRuntimeIdentity;
    const facts=validateScaleObservation(observation,p.count);
    needCurrent(observation.maxMilliseconds === expectedInner && observation.currentSourceFilesHeld === true
      && observation.runtimeSourceFilesDigest === digest && sameRef(observation.runtimeBindingReference,p.bindingRef)
      && observation.databaseDirectory === runAdmission.databaseDirectory && identity?.schema === 'mbrs003.scale.fixed-worker-runtime-identity.v1'
      && sameRef(identity.source92Ref,binding.source92Ref) && sameRef(identity.currentReaderBuildBindingRef,binding.currentReaderBuildBindingRef)
      && sameRef(identity.runtimeClosureRef,binding.runtimeClosureRef) && sameRef(identity.executionAdmissionRef,refs.admission)
      && sameRef(identity.fixedWorkerBundleReceiptRef,{path:fixed.receiptRef.file,bytes:fixed.receiptRef.bytes,sha256:fixed.receiptRef.sha256})
      && sameRef(identity.fixedWorkerEntryRef,{path:path.resolve(binding.fixedWorkerCoreRoot,manifest.entry.file),bytes:manifest.entry.bytes,sha256:manifest.entry.sha256})
      && identity.wholeBudgetSeconds === expectedWhole && sameRoundClock(identity,p) && identity.retries === 0
      && (p.count===100000 ? identity.current100kCompletion === null : sameRef(identity.current100kCompletion,first.references.result)), 'SCAN_LOAD_RESULT_INVALID');
    const g=gate.deadlineGuard;
    needCurrent(naturalGate(gate) && gate.durationSeconds <= expectedWhole && g?.actualChildWaitCompleted === true
      && g.archiveExitCode === 0 && integer(g.ownChildPid) && g.ownChildPid > 0 && integer(g.archivePid) && g.archivePid > 0 && g.archivePid !== g.ownChildPid
      && g.originalWholeDeadlineSupplied === true && /^[1-9][0-9]*$/u.test(g.absoluteDeadlineMonotonicNs)
      && BigInt(g.absoluteDeadlineMonotonicNs) > BigInt(profileStart) && BigInt(g.absoluteDeadlineMonotonicNs) <= BigInt(profileDeadline) && Number.isFinite(g.ownBudgetSeconds)
      && g.ownBudgetSeconds > 0 && g.ownBudgetSeconds <= expectedWhole && Array.isArray(g.terminationSignals) && g.terminationSignals.length === 0
      && seal.schema === 'mbrs003.root.deadline-closure-gate-seal.v1' && seal.name === gate.name
      && seal.actualChildExitCode === 0 && seal.actualChildWaitCompleted === true && seal.actualArchiveWaitCompleted === true
      && seal.archiveExitCode === 0 && seal.originalDeadlineMonotonicNs === g.absoluteDeadlineMonotonicNs
      && Number.isFinite(g.childWaitAllocatedSeconds) && g.childWaitAllocatedSeconds > 0 && g.childWaitAllocatedSeconds <= g.ownBudgetSeconds
      && Number.isFinite(seal.elapsedSecondsAfterResultClosed) && seal.elapsedSecondsAfterResultClosed >= gate.durationSeconds
      && seal.elapsedSecondsAfterResultClosed <= g.ownBudgetSeconds,'SCAN_LOAD_RUNNER_FAILED');
    const argv=currentNodeArgv(gate.argv,spec.nodeExecutable,binding.fixedWorkerCoreRoot);
    const reuse=p.count===100000?'NONE':first.references.result.path;
    needCurrent(JSON.stringify(argv) === JSON.stringify([spec.nodeExecutable,runAdmission.harnessRef.path,runAdmission.corpusDirectory,
      refs.result.path,String(p.count),p.bindingRef.path,reuse]),'SCAN_LOAD_RUNNER_FAILED');
    checked(gate.log,admission.storage,budget,4*1024*1024);
    const fs=jsonCurrent(refs.fs_terminal,admission,budget),pc=jsonCurrent(refs.process_closure,admission,budget),terminal=jsonCurrent(refs.terminal,admission,budget);
    for (const x of [fs,pc,terminal]) needCurrent(sameRoundClock(x,p) && x.count === p.count && x.runtimeSourceFilesDigest === digest
      && sameRef(x.runtimeBindingReference,p.bindingRef) && sameRef(x.resultRef,refs.result) && sameRef(x.gateResultRef,refs.gate));
    needCurrent(fs.schema === 'mbrs003.root.current-fixed-scale-fs-terminal.v1' && fs.status === 'ROOT_FS_NORMAL_END_CLOSED'
      && fs.actualExitCode === 0 && fs.normalEnd === true && fs.actualStdoutStderrClosed === true,'SCAN_LOAD_RUNNER_FAILED');
    needCurrent(pc.schema === 'mbrs003.root.current-fixed-scale-process-closure.v1' && pc.status === 'ROOT_CURRENT_FIXED_SCALE_OWNED_PROCESSES_CLOSED'
      && pc.actualExitCode === 0 && pc.actualSignal === null && pc.actualNodePid === g.ownChildPid
      && pc.actualChildWaitCompleted === true && pc.actualStdoutStderrClosed === true && pc.actualNodePidAbsent === true
      && pc.actualArchivePid === g.archivePid && pc.actualArchivePidAbsent === true
      && pc.actualOwnedGroupsAbsent === true && Array.isArray(pc.remainingOwnedProcesses) && pc.remainingOwnedProcesses.length === 0
      && sameRef(pc.fsTerminalRef,refs.fs_terminal),'SCAN_LOAD_RUNNER_FAILED');
    needCurrent(terminal.schema === 'mbrs003.root.current-fixed-scale-terminal-summary.v1' && terminal.status === 'FINITE_SOFTWARE_CURRENT_FIXED_SCALE_PASS'
      && terminal.validatorExitCode === 0 && terminal.runnerActualStatus === 'SOFTWARE_SCALE_OBSERVED'
      && sameRef(terminal.processClosureRef,refs.process_closure) && sameRef(terminal.fsTerminalRef,refs.fs_terminal)
      && Number.isFinite(terminal.wholePhaseElapsedSeconds)
      && terminal.wholePhaseElapsedSeconds >= 0 && terminal.wholePhaseElapsedSeconds <= expectedWhole,'SCAN_LOAD_RESULT_INVALID');
    const execution=jsonCurrent(p.executionClosureRef,admission,budget),raw=execution.rootRawTerminalToolResult;
    needCurrent(sameRoundClock(execution,p) && typeof terminal.actualToolClosedMonotonicNs === 'string'
      && /^[1-9][0-9]*$/u.test(terminal.actualToolClosedMonotonicNs)
      && BigInt(terminal.actualToolClosedMonotonicNs) >= BigInt(profileStart)
      && BigInt(terminal.actualToolClosedMonotonicNs) <= BigInt(profileDeadline));
    needCurrent(execution.schema === 'mbrs003.root.current-fixed-scale-execution-closure.v1'
      && execution.status === 'ROOT_ACTUAL_CURRENT_FIXED_SCALE_TOOL_CLOSED' && execution.count === p.count
      && execution.runtimeSourceFilesDigest === digest && sameRef(execution.runtimeBindingReference,p.bindingRef)
      && sameRef(execution.runnerSealRef,p.runnerSealRef) && sameRef(execution.executionAdmissionRef,refs.admission)
      && SIX_KEYS.every(k=>sameRef(execution.references?.[k],refs[k])) && execution.actualToolExitCode === 0
      && execution.actualStdoutStderrClosed === true && raw?.exit_code === 0 && typeof raw.chunk_id === 'string'
      && raw.chunk_id.length > 0 && typeof raw.output === 'string' && !('session_id' in raw)
      && execution.actualSessionId === null && execution.actualChunkId === raw.chunk_id
      && sameRef(execution.rawOutputGateRef,refs.gate),'SCAN_LOAD_RUNNER_FAILED');
    needCurrent(/^[1-9][0-9]*$/u.test(execution.actualToolClosedMonotonicNs)
      && BigInt(execution.actualToolClosedMonotonicNs) >= BigInt(profileStart)
      && BigInt(execution.actualToolClosedMonotonicNs) <= BigInt(profileDeadline)
      && BigInt(execution.actualToolClosedMonotonicNs) >= BigInt(terminal.actualToolClosedMonotonicNs)
      && finiteTime(execution.actualToolClosedAt) && Date.parse(execution.actualToolClosedAt) >= Date.parse(gate.completedAt));
    if (first) needCurrent(digest === first.runtimeSourceFilesDigest && sameRef(binding.runtimeClosureRef,first.runtimeClosureRef)
      && sameRef(binding.source92Ref,first.source92Ref) && sameRef(binding.currentReaderBuildBindingRef,first.readerBuildBindingRef)
      && sameRef(runAdmission.harnessRef,first.harnessRef) && runAdmission.databaseDirectory !== first.databaseDirectory
      && Date.parse(gate.startedAt) >= Date.parse(first.actualToolClosedAt)
      && BigInt(profileStart) >= BigInt(first.actualToolClosedMonotonicNs)
      && BigInt(execution.actualToolClosedMonotonicNs) >= BigInt(first.actualToolClosedMonotonicNs));
    first={references:refs,runtimeSourceFilesDigest:digest,runtimeClosureRef:binding.runtimeClosureRef,source92Ref:binding.source92Ref,
      readerBuildBindingRef:binding.currentReaderBuildBindingRef,harnessRef:runAdmission.harnessRef,databaseDirectory:runAdmission.databaseDirectory,
      startedMonotonicNs:profileStart,profileDeadlineMonotonicNs:profileDeadline,
      actualToolClosedAt:execution.actualToolClosedAt,actualToolClosedMonotonicNs:execution.actualToolClosedMonotonicNs};
    profiles.push({...facts,status:'FINITE_CURRENT_FIXED_RUNTIME_SCALE_OBSERVED',references:refs,bindingRef:p.bindingRef,
      runnerSealRef:p.runnerSealRef,executionClosureRef:p.executionClosureRef,runtimeSourceFilesDigest:digest,
      startedMonotonicNs:profileStart,profileDeadlineMonotonicNs:profileDeadline,
      historicalConsumed300kDeadlineMonotonicNs:CURRENT_CAP,ownerApprovalRef:p.ownerApprovalRef});
  }
  budget.check('CURRENT_FIXED_SCALE_FINAL_DECISION');
  return {status:'FINITE_CURRENT_FIXED_RUNTIME_SCALE_OBSERVED',profiles,noScaleExecutionInGate:true,
    sourceAndOutputIdentityUnchanged:true,dependencyClosure:'ROOT_DECLARED_CODE_RUNTIME_AND_FRESH_FIXED_BUNDLE_CLOSED',
    renderer:'NOT_RUN',app:'NOT_RUN',ownerAcceptance:'NOT_RUN',atAcceptance:'NOT_INFERRED',wholeTaskAcceptance:'NOT_INFERRED'};
}
