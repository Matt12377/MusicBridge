import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import type {LocalLibraryScanCommand,LocalScanCommandPayloads,LocalRelocationConfirm} from '@music-bridge/contracts'
import {createLocalLibraryClient} from '../../src/preload/local-library-client.js'
const datasetId=randomUUID(),assetId=randomUUID(),sourceRootId=randomUUID(),rootId=randomUUID(),selection={assetId,expectedFileRevision:'1',expectedLocationRevision:'1',expectedRootRevision:'1'}
const asset={id:assetId,libraryRootId:rootId,sourceRootId,rootRevision:'1',fileRevision:'1',locationRevision:'2',sampleFrames:null,timebaseHz:null},root={id:rootId,sourceRootId,role:'library' as const,revision:'2'}
function unit(){const calls:{channel:string;value:unknown}[]=[],writes:unknown[]=[],body:LocalRelocationConfirm={...selection,commandId:randomUUID(),userConfirmed:true};const client=createLocalLibraryClient(async(channel,value)=>{calls.push({channel,value});if(channel==='localLibrary:request')return {offset:0,limit:200,total:0,hasMore:false,items:[]};return {assetId,candidates:[]}},async()=>datasetId,{chooseRoot:async()=>root,confirm:async request=>{writes.push(request);return asset},relink:async request=>{writes.push(request);return root}});return {calls,writes,body,client}}
test('MBRS003 desktop preload：实际client拒hidden/prototype/两内部batch且发送前零调用',async()=>{
 const f=unit();await assert.rejects(f.client.chooseLocalRelocationCandidates(Object.defineProperty({...selection},'path',{value:'/禁止'})));await assert.rejects(f.client.chooseLocalRelocationCandidates(Object.assign(Object.create({absolutePath:'/禁止'}),selection)));await assert.rejects(f.client.confirmLocalRelocation({...f.body,path:'/禁止'} as LocalRelocationConfirm));
 await assert.rejects(f.client.localLibraryScan('localScan.prepareBatch' as LocalLibraryScanCommand,{commandId:randomUUID()} as LocalScanCommandPayloads[LocalLibraryScanCommand]));assert.equal(f.calls.length,0);assert.equal(f.writes.length,0)
})
test('MBRS003 desktop preload：固定dataset、完整逻辑确认原body经唯一Main outbox且公开分页不发可信观察',async()=>{
 const f=unit();assert.deepEqual(await f.client.localLibraryScan('localScan.page',{offset:0,limit:200}),{offset:0,limit:200,total:0,hasMore:false,items:[]});assert.deepEqual(f.calls,[{channel:'localLibrary:request',value:{datasetId,command:'localScan.page',payload:{offset:0,limit:200}}}]);assert.deepEqual(await f.client.confirmLocalRelocation(f.body),asset);assert.deepEqual(f.writes,[f.body]);assert.ok(!JSON.stringify(f.writes).includes('path'));assert.equal(f.body.commandId,(f.writes[0] as LocalRelocationConfirm).commandId)
})
