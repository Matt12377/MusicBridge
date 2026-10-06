import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import * as dto from '../../src/index.js';
const datasetId=randomUUID(),selection={assetId:randomUUID(),expectedFileRevision:'1',expectedLocationRevision:'1',expectedRootRevision:'1'};
const request=(command:string,payload:unknown)=>({version:1,id:randomUUID(),command,payload,expectedDatasetId:datasetId});
test('MBRS003 relocation合同：确认ID-only闭集拒path、hidden、symbol、prototype及无人工确认',()=>{
 const body={...selection,commandId:randomUUID(),userConfirmed:true};assert.equal(dto.isLocalRelocationConfirm(body),true);assert.equal(dto.isLocalRelocationConfirm({...body,userConfirmed:false}),false);
 assert.equal(dto.isLocalRelocationConfirm({...body,path:'/禁止'}),false);assert.equal(dto.isLocalRelocationConfirm(Object.defineProperty({...body},'path',{value:'/禁止'})),false);
 assert.equal(dto.isLocalRelocationConfirm({...body,[Symbol('session')]:'禁止'}),false);assert.equal(dto.isLocalRelocationConfirm(Object.assign(Object.create({path:'/禁止'}),body)),false);
 assert.equal(dto.isLocalRelocationConfirm(Object.assign(Object.create(null),body)),true);assert.equal(dto.isLocalRelocationConfirm({...body,expectedFileRevision:'01'}),false);assert.equal(dto.isLocalRelocationConfirm({...body,expectedLocationRevision:'18446744073709551616'}),false);
 assert.equal(dto.validateIpcRequest(request('localRelocation.confirm',body)).ok,true);assert.equal(dto.validateIpcRequest({...request('localRelocation.confirm',body),expectedDatasetId:undefined}).ok,false);
});
test('MBRS003 relocation合同：真实validator区分可信capture/register与普通outbox且不扩大扫描七命令',()=>{
 const capture={...selection,absolutePaths:['/合成/new.wav']};assert.equal(dto.validateIpcRequest(request('localRelocation.capture',capture)).ok,false);assert.equal(dto.validateIpcInternalRequest(request('localRelocation.capture',capture)).ok,true);
 assert.equal(dto.validateIpcInternalRequest(request('localRelocation.capture',{...capture,absolutePaths:['/bad\0']})).ok,false);
 assert.equal(dto.isCommandOutboxRequest({datasetId,command:'localRelocation.capture',payload:{...capture,commandId:randomUUID()}}),false);
 assert.equal(dto.isCommandOutboxRequest({datasetId,command:'localRelocation.confirm',payload:{...selection,commandId:randomUUID(),userConfirmed:true}}),true);
 assert.equal(dto.validateIpcRequest(request('localRelocation.registerRoot',{commandId:randomUUID(),sourceRootId:randomUUID()})).ok,false);
 assert.equal(dto.isCommandOutboxRequest({datasetId,command:'localLibrary.chooseRoot',payload:{commandId:randomUUID(),absolutePath:'/禁止'}}),false);
 assert.equal(dto.isCommandOutboxRequest({datasetId,command:'localScan.prepareBatch',payload:{commandId:randomUUID()}}),false);
});
test('MBRS003 relocation合同：有限候选不承诺same-content并拒私有观察和集合扩展',()=>{
 const candidate={id:randomUUID(),fileName:'同名.wav',relativeLabel:'专辑 › 同名.wav',size:100,modifiedAt:'2026-10-04T00:00:00.000Z',evidence:'user-choice'};
 assert.equal(dto.isLocalRelocationCandidates({assetId:selection.assetId,candidates:[candidate]}),true);
 assert.equal(dto.isLocalRelocationCandidates({assetId:selection.assetId,candidates:[{...candidate,evidence:'same-content'}]}),false);
 for(const extra of [{absolutePath:'/secret'},{signature:'1:2:3:4:5'},{sha256:'a'.repeat(64)}])assert.equal(dto.isLocalRelocationCandidates({assetId:selection.assetId,candidates:[{...candidate,...extra}]}),false);
 assert.equal(dto.isLocalRelocationCandidates({assetId:selection.assetId,candidates:Array.from({length:201},()=>candidate)}),false);
 const hidden=Object.defineProperty({...candidate},'path',{value:'/secret'});assert.equal(dto.isLocalRelocationCandidates({assetId:selection.assetId,candidates:[hidden]}),false);
 const asset={id:selection.assetId,libraryRootId:randomUUID(),sourceRootId:randomUUID(),rootRevision:'1',fileRevision:'1',locationRevision:'1',sampleFrames:null,timebaseHz:null};assert.equal(dto.isLocalRelocationCommandResult('localRelocation.confirm',asset),true);assert.equal(dto.isLocalRelocationCommandResult('localRelocation.confirm',Object.defineProperty({...asset},'absolutePath',{value:'/secret'})),false);assert.equal(dto.isLocalRelocationCommandResult('localRelocation.confirm',{...asset,[Symbol('session')]:'secret'}),false);
});
