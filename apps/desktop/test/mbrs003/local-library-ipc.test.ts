import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import type {IpcCommand,IpcCommandPayloads,IpcCommandResults,IpcInternalCommand,IpcInternalCommandResults,LocalRelocationCandidate} from '@music-bridge/contracts'
import {installLocalLibraryHandlers} from '../../src/main/local-library-ipc.js'
const datasetId=randomUUID(),assetId=randomUUID(),rootId=randomUUID(),sourceRootId=randomUUID(),selection={assetId,expectedFileRevision:'1',expectedLocationRevision:'1',expectedRootRevision:'1'}
const candidate:LocalRelocationCandidate={id:randomUUID(),fileName:'new.wav',relativeLabel:'目录 › new.wav',size:100,modifiedAt:'2026-10-04T00:00:00.000Z',evidence:'user-choice'}
function unit(){const handlers=new Map<string,(event:{trusted:boolean},value?:unknown)=>unknown>(),calls:{route:string;command:string;payload:unknown;scope?:string}[]=[];let pickCount=0
 const supervisor={async request<C extends IpcCommand>(command:C,payload:IpcCommandPayloads[C],scope?:string):Promise<IpcCommandResults[C]>{calls.push({route:'ordinary',command,payload,scope});let result:unknown;if(command==='commandOutbox.context')result={datasetId};else if(command==='localCatalog.asset')result={id:assetId,libraryRootId:rootId,sourceRootId,rootRevision:'1',fileRevision:'1',locationRevision:'1',sampleFrames:null,timebaseHz:null};else if(command==='localCatalog.root')result={id:rootId,sourceRootId,role:'library',revision:'1'};else if(command==='localScan.page')result={offset:0,limit:200,total:0,hasMore:false,items:[]};else throw new Error('本测试不提供任意Core route');return result as IpcCommandResults[C]},async requestInternal<C extends IpcInternalCommand>(command:C,payload:IpcCommandPayloads[C],scope?:string):Promise<IpcInternalCommandResults[C]>{calls.push({route:'internal',command,payload,scope});let result:unknown;if(command==='recordingSources.context')result={absolutePath:'/synthetic/authorized'};else if(command==='localRelocation.capture')result={assetId,candidates:[candidate]};else throw new Error('不提供其他内部命令');return result as IpcInternalCommandResults[C]}}
 installLocalLibraryHandlers<{trusted:boolean}>({handle:(name,handler)=>handlers.set(name,handler),requireTrusted:e=>{if(!e.trusted)throw new Error('不可信Renderer')},supervisor,pick:async()=>{pickCount++;return {canceled:false,filePaths:['/synthetic/authorized/new.wav']}}})
 return {handlers,calls,pickCount:()=>pickCount}
}
test('MBRS003 desktop Main：固定七scan名单拒两batch、path/hidden/symbol和不可信窗口且零发送',async()=>{
 const f=unit(),handler=f.handlers.get('localLibrary:request')!
 for(const command of ['localScan.prepareBatch','localScan.commitBatch','recordingSources.authorize','localCatalog.registerAsset'])await assert.rejects(async()=>handler({trusted:true},{datasetId,command,payload:{commandId:randomUUID()}}))
 await assert.rejects(async()=>handler({trusted:false},{datasetId,command:'localScan.page',payload:{offset:0,limit:200}}))
 await assert.rejects(async()=>handler({trusted:true},{datasetId,command:'localScan.start',payload:{commandId:randomUUID(),libraryRootId:rootId,expectedRootRevision:'1',absolutePath:'/禁止'}}))
 await assert.rejects(async()=>handler({trusted:true},Object.defineProperty({datasetId,command:'localScan.page',payload:{offset:0,limit:200}},'path',{value:'/禁止'})))
 await assert.rejects(async()=>handler({trusted:true},{datasetId,command:'localScan.page',payload:{offset:0,limit:200},[Symbol('session')]:'禁止'}))
 assert.equal(f.calls.length,0);assert.equal(f.pickCount(),0)
 assert.deepEqual(await handler({trusted:true},{datasetId,command:'localScan.page',payload:{offset:0,limit:200}}),{offset:0,limit:200,total:0,hasMore:false,items:[]});assert.deepEqual(f.calls,[{route:'ordinary',command:'localScan.page',payload:{offset:0,limit:200},scope:datasetId}])
})
test('MBRS003 desktop Main：真实handler仅Nativepicker结果经requestInternal捕获，公开候选无路径cap或签名',async()=>{
 const f=unit(),handler=f.handlers.get('localLibrary:chooseCandidates')!
 await assert.rejects(async()=>handler({trusted:true},{datasetId,selection:{...selection,absolutePaths:['/禁止']}}));assert.equal(f.calls.length,0)
 const result=await handler({trusted:true},{datasetId,selection});assert.deepEqual(result,{assetId,candidates:[candidate]});assert.equal(f.pickCount(),1)
 const last=f.calls.at(-1)!;assert.equal(last.route,'internal');assert.equal(last.command,'localRelocation.capture');assert.equal(last.scope,datasetId);assert.deepEqual(last.payload,{...selection,absolutePaths:['/synthetic/authorized/new.wav']});assert.ok(!JSON.stringify(result).includes('/synthetic/'));assert.ok(!JSON.stringify(result).includes('signature'))
})
