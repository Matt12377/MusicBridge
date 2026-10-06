import { validateIpcRequest,validateIpcInternalRequest,validateIpcResponseForCommand,LOCAL_SCAN_COMMANDS, isLocalScanPreparedBatch } from '../../src/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isLocalScanStartRequest, isLocalScanTransitionRequest, isLocalScanGetRequest, isLocalScanPageRequest,
  isLocalScanReceiptRequest, isLocalScanReceipt, isLocalScanPage, type ScanJobRecord } from '../../src/index.js';

const job = (): ScanJobRecord => ({ schemaVersion: '1.2', jobId: randomUUID(), datasetId: randomUUID(), libraryRootId: randomUUID(), sourceRootId: randomUUID(),
  rootRevision: '1', jobRevision: '1', checkpointRef: null, progress: { visited: '0', accepted: '0', rejected: '0' }, phase: 'pending', failureCode: null });

test('MBRS003 contract：公开start/control/get/receipt只收逻辑ID与CAS，locator隐藏键symbol和自定义原型拒绝', () => {
  const start = { commandId: randomUUID(), libraryRootId: randomUUID(), expectedRootRevision: '1' };
  const transition = { commandId: randomUUID(), jobId: randomUUID(), expectedRevision: '1' };
  assert.equal(isLocalScanStartRequest(start), true); assert.equal(isLocalScanTransitionRequest(transition), true);
  assert.equal(isLocalScanGetRequest({ jobId: transition.jobId }), true); assert.equal(isLocalScanReceiptRequest({ commandId: transition.commandId }), true);
  for (const key of ['path', 'relative', 'signature', 'readEvidence', 'sourceRootId', 'worker', 'budget', 'epoch', 'expectedDatasetId']) {
    assert.equal(isLocalScanStartRequest({ ...start, [key]: '不公开' }), false);
    assert.equal(isLocalScanTransitionRequest({ ...transition, [key]: '不公开' }), false);
  }
  const hidden = { ...start }; Object.defineProperty(hidden, 'path', { value: '/hidden', enumerable: false });
  assert.equal(isLocalScanStartRequest(hidden), false); assert.equal(isLocalScanStartRequest({ ...start, [Symbol('session')]: '隐藏' }), false);
  assert.equal(isLocalScanStartRequest(Object.assign(Object.create({ inherited: true }), start)), false);
  assert.equal(isLocalScanStartRequest(Object.assign(Object.create(null), start)), true);
});

test('MBRS003 contract：修订沿原u64十进制无精度丢失，分页200正控制201与浮点边界拒绝', () => {
  const transition = { commandId: randomUUID(), jobId: randomUUID(), expectedRevision: '18446744073709551615' };
  assert.equal(isLocalScanTransitionRequest(transition), true);
  for (const value of ['0', '01', '1\n', '1\r', '18446744073709551616', 9007199254740992]) assert.equal(isLocalScanTransitionRequest({ ...transition, expectedRevision: value }), false);
  assert.equal(isLocalScanPageRequest({ offset: 0, limit: 200 }), true);
  for (const page of [{ offset: 0, limit: 201 }, { offset: -1, limit: 1 }, { offset: 0.5, limit: 1 }, { offset: 0, limit: 1, cursor: '额外' }]) assert.equal(isLocalScanPageRequest(page), false);
});

test('MBRS003 contract：receipt/page真实schema闭集200上限，不把job或fingerprint当来源许可证明', () => {
  const value = job(), receipt = { commandId: randomUUID(), jobId: value.jobId, operation: 'start', fingerprint: 'a'.repeat(64), result: value };
  assert.equal(isLocalScanReceipt(receipt), true); assert.equal(isLocalScanReceipt({ ...receipt, jobId: randomUUID() }), false);
  assert.equal(isLocalScanReceipt({ ...receipt, operation: { toString: () => 'start' } }), false);
  assert.equal(isLocalScanReceipt({ ...receipt, authorized: true }), false);
  const items = Array.from({ length: 200 }, job), page = { offset: 0, limit: 200, total: 201, hasMore: true, items };
  assert.equal(isLocalScanPage(page), true); assert.equal(isLocalScanPage({ ...page, items: [...items, job()] }), false);
  assert.equal(isLocalScanPage({ ...page, hasMore: false }), false);
  assert.equal(isLocalScanPage({ ...page, items: [{ ...value, path: '/private' }] }), false);
});


test('MBRS003 scan IPC：七普通逻辑入口与两可信批闭集、expectedDataset和外壳隐藏键真实validator拒绝',()=>{
  assert.equal(LOCAL_SCAN_COMMANDS.length,9);
  const datasetId=randomUUID(),jobId=randomUUID(),commandId=randomUUID(),batchId=randomUUID();
  const envelope=(command:string,payload:unknown)=>({version:1,id:'scan',command,payload,expectedDatasetId:datasetId});
  const start=envelope('localScan.start',{commandId,libraryRootId:randomUUID(),expectedRootRevision:'1'});assert.equal(validateIpcRequest(start).ok,true);
  assert.equal(validateIpcRequest({...start,expectedDatasetId:undefined}).ok,false);
  assert.equal(validateIpcRequest({...start,payload:{...start.payload as object,relative:'音乐.wav'}}).ok,false);
  const hidden={...start};Object.defineProperty(hidden,'path',{value:'/隐藏'});assert.equal(validateIpcRequest(hidden).ok,false);
  const symbolic={...start,[Symbol('session')]:'隐藏'};assert.equal(validateIpcRequest(symbolic).ok,false);
  const batch={batchId,jobId,expectedJobRevision:'1',checkpointBefore:null,items:[],frontier:[],completed:true};
  const prepare=envelope('localScan.prepareBatch',{commandId,jobId,batch});assert.equal(validateIpcRequest(prepare).ok,false);assert.equal(validateIpcInternalRequest(prepare).ok,true);
  assert.equal(validateIpcInternalRequest({...prepare,payload:{commandId,jobId,batch:{...batch,session:'公开禁止'}}}).ok,false);
  assert.equal(isLocalScanPreparedBatch({...batch,frontier:['../逃逸']}),false);
  const commit=envelope('localScan.commitBatch',{commandId,jobId,batchId,expectedRevision:'1'});assert.equal(validateIpcRequest(commit).ok,false);assert.equal(validateIpcInternalRequest(commit).ok,true);
  assert.equal(validateIpcInternalRequest({...commit,payload:{commandId,jobId,batchId,expectedRevision:'1',relative:'禁止'}}).ok,false);
});

test('MBRS003 scan IPC：实际result validator保持公开receipt原operation与数组200闭集',()=>{
  const datasetId=randomUUID(),jobId=randomUUID(),rootId=randomUUID(),sourceRootId=randomUUID();
  const job={schemaVersion:'1.2',jobId,datasetId,libraryRootId:rootId,sourceRootId,rootRevision:'1',jobRevision:'1',checkpointRef:null,progress:{visited:'0',accepted:'0',rejected:'0'},phase:'pending',failureCode:null};
  const response=(result:unknown)=>({version:1,id:'scan',ok:true,result});
  assert.equal(validateIpcResponseForCommand(response(job),'localScan.start').ok,true);
  assert.equal(validateIpcResponseForCommand(response({...job,path:'/私有'}),'localScan.start').ok,false);
  const receipt={commandId:randomUUID(),jobId,operation:'start',fingerprint:'a'.repeat(64),result:job};
  assert.equal(validateIpcResponseForCommand(response(receipt),'localScan.receipt').ok,true);
  for(const operation of ['abandon-batch','fail']) assert.equal(validateIpcResponseForCommand(response({...receipt,operation}),'localScan.receipt').ok,false);
  const items=[job];Object.defineProperty(items,'path',{value:'/私有'});
  assert.equal(validateIpcResponseForCommand(response({offset:0,limit:1,total:1,hasMore:false,items}),'localScan.page').ok,false);
});
