import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalLibrarySignedStatFixAdmission, localLibraryFixRoute, stripAddedJsonPrefix,
  LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE as scope, LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE_PATH as scopePath,
  LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK as task, LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH as branch,
  LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE as base } from '../local-library-signed-stat-fix-admission.mjs';

// 合成账本故意带unsafe整数。纯准入必须保留原始字节，不能用JSON.parse后的数值作旧账本等价证明。
const oldStatus = Buffer.from('{\n  "currentMobileTask": "MBM-003",\n  "legacyUnsafe": 9007199254740993,\n  "ownerAcceptance": "PARTIAL",\n  "libraryWriteEnabled": false\n}\n');
const oldPlan = Buffer.from('{\n  "execution_schedule": {"current_task":"MBM-003"},\n  "originalTasks": 18,\n  "originalCases": 156,\n  "effectiveTasks": 17,\n  "effectiveCases": 150\n}\n');
function prepend(bytes, additions) {
  return Buffer.concat([Buffer.from('{\n' + Object.entries(additions).map(([key,value]) =>
    '  ' + JSON.stringify(key) + ': ' + JSON.stringify(value) + ',\n').join('')), bytes.subarray(2)]);
}
function statusAdditions() {
  return {
    currentLocalLibraryFixTask: task,
    localLibrarySignedStatFix: { task,branch,baseSha:base,executionScope:scopePath,sourceFilesWrite:'UNCHANGED_DEFAULT_OFF',
      originalMobileTaskAndAcceptanceUnchanged:true,ownerRepeatedApprovalRequired:false },
    currentMobileDeliveryReadback20261010: { task:'MBM-003',source:base,directReport:'99c89519f3357f4018b32930e8179b66719f99e7',
      software:'SOURCE_AND_DIRECT_REPORT_FIRST_NATURAL_CI_CONTENT_SEALED',deviceAcceptance:'PARTIAL_REPLAY_AND_INTERRUPTION_RECOVERY_OPEN',
      nextOrder:['MBM-004','MBRS-016','MBRS-017'],newFixIsSeparatelyVerified:true },
    parallelTapeCatalogDelivery20261010: { source:'cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f',
      software:'ISOLATED_SOURCE_FIRST_NATURAL_FOUR_CI_SUCCESS_READ_BACK',ordinaryAppIntegration:'PENDING_FINAL003_BASELINE_INTEGRATION',
      realCatalogImport:'NOT_RUN',effectiveMainTaskAndAcceptanceCountsUnchanged:true },
  };
}
function planAdditions() { return {local_library_signed_stat_fix:{current_task:task,branch,base_sha:base,scope_ref:scopePath}}; }
function fixture() {
  return {branch,head:'1'.repeat(40),baseIsAncestor:true,statusBytes:prepend(oldStatus,statusAdditions()),planBytes:prepend(oldPlan,planAdditions()),
    baselineStatusBytes:Buffer.from(oldStatus),baselinePlanBytes:Buffer.from(oldPlan),execution:structuredClone(scope),
    changedPaths:scope.sourceChangedPaths.map(({path,status})=>({path,status})),
    productFiles:scope.productPins.map(row=>({path:row.path,...row.after})),frozenFiles:structuredClone(scope.protectedFiles)};
}
const rejected = code => error => error?.code === code;
function changeStatus(input, work) { const additions=statusAdditions();work(additions);input.statusBytes=prepend(oldStatus,additions); }

test('修复准入：独立task精确24路径与9完整产品件准入，不冒充003或App成功',()=>{
  const input=fixture(),result=assertLocalLibrarySignedStatFixAdmission(input);
  assert.equal(result.task,task);assert.notEqual(result.task,'MBM-003');assert.equal(result.exactProductFiles,9);
  assert.equal(result.changedPaths.length,24);assert.equal(result.oldGateEvidenceReused,true);
  assert.equal(result.currentFixSoftwareGateRequired,true);assert.equal(result.currentFixAppDeviceOwnerProven,false);
  assert.deepEqual(stripAddedJsonPrefix(input.statusBytes,scope.projectBinding.statusAddedFields),oldStatus);
  assert.deepEqual(stripAddedJsonPrefix(input.planBytes,scope.projectBinding.planAddedFields),oldPlan);
});

test('修复准入：其他分支沿原inspector，精确fix标记不许借错分支回落003',()=>{
  assert.equal(localLibraryFixRoute('codex/mbm-003-lossless-dsd-transport',{currentMobileTask:'MBM-003'},{}),'ORIGINAL_PREDECESSOR_INSPECTOR');
  assert.equal(localLibraryFixRoute('codex/else',{},{}),'ORIGINAL_PREDECESSOR_INSPECTOR');
  assert.equal(localLibraryFixRoute(branch,{},{}),'VALIDATE_EXACT_FIX');
  assert.equal(localLibraryFixRoute('codex/else',{currentLocalLibraryFixTask:task},{}),'VALIDATE_EXACT_FIX');
  for(const value of ['codex/else',branch+'/suffix','',null]) { const input=fixture();input.branch=value;
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_BRANCH_MISMATCH')); }
});

test('修复准入：精确base祖先、40位head和双表base必须一致',()=>{
  for(const value of [false,undefined,'true']) { const input=fixture();input.baseIsAncestor=value;
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_BASE_MISMATCH')); }
  const badHead=fixture();badHead.head='1'.repeat(39);
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(badHead),rejected('SIGNED_STAT_BASE_MISMATCH'));
  const status=fixture();changeStatus(status,a=>{a.localLibrarySignedStatFix.baseSha='0'.repeat(40);});
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(status),rejected('SIGNED_STAT_AUTHORITY_MISMATCH'));
  const plan=fixture(),a=planAdditions();a.local_library_signed_stat_fix.base_sha='0'.repeat(40);plan.planBytes=prepend(oldPlan,a);
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(plan),rejected('SIGNED_STAT_AUTHORITY_MISMATCH'));
});

test('修复准入：task、authority、scope和plan绑定缺失或相互冲突均拒绝',()=>{
  for(const key of ['currentLocalLibraryFixTask','localLibrarySignedStatFix']) { const input=fixture();
    changeStatus(input,a=>{if(key==='currentLocalLibraryFixTask')a[key]='MBM-003';else a[key].task='MBM-003';});
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_TASK_MISMATCH')); }
  for(const field of ['branch','executionScope']) { const input=fixture();changeStatus(input,a=>{a.localLibrarySignedStatFix[field]='wrong';});
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_AUTHORITY_MISMATCH')); }
  const input=fixture(),a=planAdditions();a.local_library_signed_stat_fix.current_task='MBM-003';input.planBytes=prepend(oldPlan,a);
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_TASK_MISMATCH'));
});

test('修复准入：scope预算、权限、媒体writer和未知字段不能借修复扩张',()=>{
  const edits=[s=>s.budgets.totalTimeoutMs++,s=>s.policy.sourceMediaWrites=true,s=>s.policy.optionalRust='ON',
    s=>s.policy.oldIdentityMismatchStillRejected=false,s=>s.sourceChangedPaths.push({path:'packages/contracts/src/index.ts',status:'M',role:'extra'}),
    s=>{s.ownerAcceptance='PASS';}];
  for(const work of edits){const input=fixture();work(input.execution);
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_SCOPE_CHANGED'));}
});

test('修复准入：9叶任一整件hash、长度或名字漂移均拒绝，不靠regex片段准入',()=>{
  for(let i=0;i<9;i++)for(const field of ['bytes','sha256','path']){const input=fixture();
    input.productFiles[i][field]=field==='bytes'?input.productFiles[i].bytes+1:field==='sha256'?'0'.repeat(64):'else/'+input.productFiles[i].path;
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_PRODUCT_DRIFT'));}
  const input=fixture();input.productFiles.pop();
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_PRODUCT_DRIFT'));
});

test('修复准入：越界、伪路径、删除、改名、未知状态或row字段不能绕changed闭集',()=>{
  for(const path of ['packages/contracts/src/mobile-wire.ts','docs/postrust/MBM-003/EXECUTION_SCOPE.json','../escape','./'+scope.sourceChangedPaths[0].path,'a\\b']){
    const input=fixture();input.changedPaths[0]={path,status:'M'};
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_CHANGED_PATH_REJECTED'));}
  for(const status of ['D','R100','T','?']){const input=fixture();input.changedPaths[0].status=status;
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_CHANGED_PATH_REJECTED'));}
  const input=fixture();input.changedPaths[0].extra=true;
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_CHANGED_PATH_REJECTED'));
});

test('修复准入：缺必需source变更、重复路径或超过26闭集均拒绝',()=>{
  const missing=fixture();missing.changedPaths.pop();
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(missing),rejected('SIGNED_STAT_CHANGED_SET_INVALID'));
  const duplicate=fixture();duplicate.changedPaths[1]={...duplicate.changedPaths[0]};
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(duplicate),rejected('SIGNED_STAT_CHANGED_SET_INVALID'));
  const overflow=fixture();overflow.changedPaths.push(...scope.reportOnlyAddedPaths.map(path=>({path,status:'A'})),{path:'reports/extra.json',status:'A'});
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(overflow),rejected('SIGNED_STAT_CHANGED_SET_INVALID'));
});

test('修复准入：后续报告只接受两个精确basename，不扩大目录或前序报告权限',()=>{
  const input=fixture();input.changedPaths.push(...scope.reportOnlyAddedPaths.map(path=>({path,status:'A'})));
  assert.equal(assertLocalLibrarySignedStatFixAdmission(input).changedPaths.length,26);
  for(const path of ['reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EXTRA.md','reports/MBM-003_RESULT.md','docs/postrust/LOCAL_LIBRARY_SIGNED_STAT_FIX/evidence/extra.json']){
    const bad=fixture();bad.changedPaths.push({path,status:'A'});
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(bad),rejected('SIGNED_STAT_CHANGED_PATH_REJECTED'));}
});

test('修复准入：旧Gate、canonical和003整件冻结漂移不得复用',()=>{
  assert.ok(scope.protectedFiles.some(row=>row.path==='scripts/ci/mbm003-predecessor-reuse.mjs'));
  assert.ok(scope.protectedFiles.some(row=>row.path==='packages/contracts/mobile/openapi.json'));
  for(const field of ['bytes','sha256']){const input=fixture();input.frozenFiles[0][field]=field==='bytes'?input.frozenFiles[0].bytes+1:'0'.repeat(64);
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_FROZEN_PREDECESSOR_DRIFT'));}
});

test('修复准入：旧STATUS字节含相邻unsafe整数亦严格区分，软件或Owner升级拒绝',()=>{
  for(const replacement of ['9007199254740992','9007199254740994']) {const input=fixture();input.statusBytes=Buffer.from(input.statusBytes.toString().replace('9007199254740993',replacement));
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_PREDECESSOR_PROJECT_CHANGED'));}
  const input=fixture();input.statusBytes=Buffer.from(input.statusBytes.toString().replace('"ownerAcceptance": "PARTIAL"','"ownerAcceptance": "PASS"'));
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_PREDECESSOR_PROJECT_CHANGED'));
});

test('修复准入：旧PLAN原18/156与17/150以及003调度逐字保存',()=>{
  for(const [before,after] of [['18','19'],['156','157'],['17','18'],['150','151'],['MBM-003','MBM-004']]){
    const input=fixture();input.planBytes=prepend(Buffer.from(oldPlan.toString().replace(before,after)),planAdditions());
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_PREDECESSOR_PROJECT_CHANGED'));}
});

test('修复准入：仅新增四字段且历史byte不经重排，未声明或非法JSON输入拒绝',()=>{
  const extra=fixture();extra.spoof=true;
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(extra),rejected('SIGNED_STAT_UNKNOWN_INPUT'));
  const raw=fixture();raw.statusBytes=new Uint8Array(raw.statusBytes);
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(raw),rejected('SIGNED_STAT_JSON_INVALID'));
  const fields=fixture(),a=statusAdditions();a.unapproved=true;fields.statusBytes=prepend(oldStatus,a);
  assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(fields),rejected('SIGNED_STAT_PREDECESSOR_PROJECT_CHANGED'));
  assert.throws(()=>stripAddedJsonPrefix(Buffer.from([0xff]),scope.projectBinding.statusAddedFields),rejected('SIGNED_STAT_PROJECT_PREFIX_INVALID'));
});

test('修复准入：新软件读回也不能升级设备、磁带集成或源写权限',()=>{
  for(const work of [a=>{a.currentMobileDeliveryReadback20261010.deviceAcceptance='PASS';},
    a=>{a.parallelTapeCatalogDelivery20261010.realCatalogImport='PASS';},a=>{a.parallelTapeCatalogDelivery20261010.ordinaryAppIntegration='PASS';},
    a=>{a.localLibrarySignedStatFix.sourceFilesWrite='ON';}]){const input=fixture();changeStatus(input,work);
    assert.throws(()=>assertLocalLibrarySignedStatFixAdmission(input),rejected('SIGNED_STAT_EVIDENCE_BOUNDARY_CHANGED'));}
  assert.equal(Object.isFrozen(scope),true);assert.equal(Object.isFrozen(scope.productPins[0].after),true);
  assert.throws(()=>{scope.productPins[0].after.bytes++;},TypeError);
});
