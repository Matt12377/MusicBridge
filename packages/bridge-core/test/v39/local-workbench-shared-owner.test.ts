import test from 'node:test'
import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { PassThrough, Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as dto from '@music-bridge/contracts'
import { createUtilityLyricsProviderBridge } from '../../src/utility-main.js'
import { createLocalLyricsProjectionTransport } from '../../src/collection/local-library-workbench/lyrics-service.js'
import { parseLocalLyricsSearch } from '../../src/collection/local-library-lyrics/providers.js'
import { captureDatasetLyricsProviderRequest, captureDatasetLyricsProviderReply, assertDatasetLyricsProviderReplyForRequest,
  isDatasetLyricsProviderCommand, datasetWorkbenchSha, datasetWorkbenchJson, type DatasetProjectionPort,
  type DatasetProjectionCommandPayloads, type DatasetProjectionCommandResults, type DatasetLyricsProviderCommand,
  type DatasetLyricsProviderReply, type DatasetLyricsProviderRequest } from '../../src/collection/dataset-owner-protocol.js'
import { createLocalLyricsMainProviderBridge, type LocalLyricsProviderCall } from '../../../../apps/desktop/src/main/local-library-workbench/lyrics-service.js'
import type { LocalWorkbenchRootMainAuthor } from '../../../../apps/desktop/src/main/local-library-workbench/service.js'
import type { CommonsTransportResponse } from '../../../../apps/desktop/src/main/commons-artwork-provider.js'

const query={title:'测试歌曲',artist:'测试歌手',album:'测试专辑',language:'',version:'original' as const,durationMs:1000}
const search={netease:{code:200,result:{songs:[]}},qq:{code:0,data:{song:{list:[]}}},kugou:{status:200,candidates:[]},kuwo:{TOTAL:'0',abslist:[]},lrclib:[]}
/** 合成HTTP响应明确只覆盖真实桥与Node流关闭，不能充作真实平台或Owner验收。 */
function harness(transport:(url:URL,signal:AbortSignal)=>Promise<CommonsTransportResponse>,holdFive=false){
  const identity={datasetId:randomUUID(),epoch:randomUUID()},binding={datasetId:identity.datasetId,ownerEpoch:identity.epoch,childGeneration:1,authorityRef:Object.freeze({})}
  let revoked=false,fatal=0;const syntheticAuthor={binding,async assertCurrent(value:unknown){assert.equal(value,binding);if(revoked)throw new Error('合成作者已撤销')}} as unknown as LocalWorkbenchRootMainAuthor
  const main=createLocalLyricsMainProviderBridge({currentAuthor:()=>revoked?undefined:syntheticAuthor,transport})
  const channel=new MessageChannel(),errors:unknown[]=[],requests:DatasetLyricsProviderRequest[]=[],held:Array<()=>void>=[]
  const utility=createUtilityLyricsProviderBridge({on(_event,listener){channel.port1.on('message',data=>listener({data}))},start(){channel.port1.start()},postMessage(value){channel.port1.postMessage(value)}},()=>identity,()=>{fatal++})
  const respond=async(q:DatasetLyricsProviderRequest)=>{let reply:DatasetLyricsProviderReply;const echo={version:1 as const,type:'musicbridge.lyrics.provider-reply' as const,requestId:q.requestId,sequence:q.sequence,epoch:q.epoch,datasetId:q.datasetId,command:q.command,requestSha256:datasetWorkbenchSha(datasetWorkbenchJson(q))}
    try{const result=await main.execute({command:q.command,payload:q.payload} as LocalLyricsProviderCall,{binding,signal:new AbortController().signal,deadlineAtMs:performance.now()+Math.max(1,q.expiresAtMs-Date.now())});reply={...echo,ok:true,result}}
    catch{reply={...echo,ok:false,failure:'NOT_READY'}}
    assertDatasetLyricsProviderReplyForRequest(reply,q);channel.port2.postMessage(captureDatasetLyricsProviderReply(reply))
  }
  channel.port2.on('message',raw=>{try{const q=captureDatasetLyricsProviderRequest(raw);requests.push(q)
    const run=()=>{void respond(q).catch(error=>errors.push(error))}
    if(holdFive&&q.command==='lyricsProviderStart'&&requests.filter(r=>r.command==='lyricsProviderStart').length<=5){held.push(run);if(held.length===5)for(const release of held)release()}
    else run()
  }catch(error){errors.push(error)}})
  const projection:DatasetProjectionPort={call<K extends keyof DatasetProjectionCommandPayloads>(command:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]>{
    if(!isDatasetLyricsProviderCommand(command))throw new Error('合成桥只接受原四个歌词私有命令')
    return utility.call(command,payload as DatasetProjectionCommandPayloads[DatasetLyricsProviderCommand],identity) as Promise<DatasetProjectionCommandResults[K]>
  }}
  const owner=createLocalLyricsProjectionTransport({identity:{datasetId:identity.datasetId,assertCurrent(){}},ownerEpoch:identity.epoch,projection,assertAccepting(){}})
  return {owner,main,requests,errors,get fatal(){return fatal},revoke(){revoked=true},async close(){await owner.close();await main.close();utility.close();channel.port1.close();channel.port2.close()}}
}

test('同Owner五源桥：前四个start响应延迟时第五源仍完成完整EOF与摘要，并分别join原流',async()=>{
  let opened=0,closed=0;const urls:string[]=[]
  const h=harness(async url=>{urls.push(url.hostname);const source=url.hostname.includes('163.com')?'netease':url.hostname.includes('qq.com')?'qq':url.hostname.includes('kugou')?'kugou':url.hostname.includes('kuwo')?'kuwo':'lrclib'
    const raw=Buffer.from(JSON.stringify(search[source])),body=Readable.from([raw.subarray(0,1),raw.subarray(1)]);opened++
    const settled=once(body,'close').then(()=>{closed++});return{statusCode:200,headers:{'content-type':'application/json','content-length':String(raw.length)},body,closed:settled,destroy(){body.destroy()}}
  },true)
  const originalQuery={...query,title:'测'.repeat(600)},expiresAtMs=Date.now()+5000
  try{const raw=await Promise.all(dto.LOCAL_LYRICS_SOURCES.map(source=>h.owner.request(source,'search',originalQuery,new AbortController().signal,{expiresAtMs})))
    assert.equal(h.requests.filter(r=>r.command==='lyricsProviderStart').length,5);assert.equal(raw.length,5)
    for(const request of h.requests.filter(r=>r.command==='lyricsProviderStart')){assert.equal(request.payload.expiresAtMs,expiresAtMs);assert.deepEqual(request.payload.input,originalQuery)}
    for(const[index,bytes]of raw.entries()){assert.ok(bytes.byteLength>0);assert.deepEqual(parseLocalLyricsSearch(dto.LOCAL_LYRICS_SOURCES[index]!,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))),[])}
    assert.equal(opened,5);assert.equal(closed,5);assert.equal(h.requests.filter(r=>r.command==='lyricsProviderJoin').length,5);assert.equal(h.main.pending(),0);assert.equal(h.fatal,0);assert.deepEqual(h.errors,[]);assert.equal(new Set(urls).size,5)
  }finally{await h.close()}
})

test('同Owner五源桥：原来源context已过期或非有限时，不创建Main请求或HTTP资源',async()=>{
  let opened=0;const h=harness(async()=>{opened++;throw new Error('失效期限不得触发实际请求')})
  try{await assert.rejects(h.owner.request('qq','search',query,new AbortController().signal,{expiresAtMs:Date.now()-1}),{code:'TIMEOUT'})
    await assert.rejects(h.owner.request('qq','search',query,new AbortController().signal,{expiresAtMs:Infinity}),{code:'INVALID'})
    assert.equal(opened,0);assert.deepEqual(h.requests,[]);assert.equal(h.main.pending(),0);assert.equal(h.fatal,0);assert.deepEqual(h.errors,[])
  }finally{await h.close()}
})

test('同Owner五源桥：撤销作者后只让原operation取消与join，真实流关闭后Owner才能结束',async()=>{
  let opened=0,closed=0;let notify!:()=>void;const started=new Promise<void>(resolve=>{notify=resolve})
  const h=harness(async(_url,signal)=>{const body=new PassThrough();opened++;body.write(Buffer.from('{'))
    const stop=()=>body.destroy(),settled=once(body,'close').then(()=>{signal.removeEventListener('abort',stop);closed++});signal.addEventListener('abort',stop,{once:true});notify()
    return{statusCode:200,headers:{'content-type':'application/json'},body,closed:settled,destroy(){body.destroy()}}
  })
  const work=h.owner.request('lrclib','search',query,new AbortController().signal);void work.catch(()=>{})
  try{await started;h.revoke();await h.owner.close();await assert.rejects(work);assert.equal(opened,1);assert.equal(closed,1);assert.equal(h.main.pending(),0)
    assert.equal(h.requests.filter(r=>r.command==='lyricsProviderCancel').length,1);assert.equal(h.requests.filter(r=>r.command==='lyricsProviderJoin').length,1);assert.equal(h.fatal,0);assert.deepEqual(h.errors,[])
  }finally{await h.close()}
})


import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { createUtilityNameProviderBridge } from '../../src/utility-main.js'
import { createLocalNameTransport } from '../../../../apps/desktop/src/main/local-library-workbench/providers/name-transport.js'
import { createLocalWorkbenchNameMainBridge, createLocalWorkbenchManagementBoundary } from '../../../../apps/desktop/src/main/local-library-workbench/service.js'
import { datasetNameOriginalStartSha256, captureDatasetNameProviderRequest, captureDatasetNameProviderReply, assertDatasetNameProviderReplyForRequest,
  type DatasetNameProviderRequest, type DatasetNameProviderReply, type DatasetNameProviderRead, type DatasetNameProviderStart, type DatasetNameProviderCommand,
  DatasetNameProviderBridgeError } from '../../src/collection/dataset-owner-protocol.js'

function nameDeferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
/** 本地HTTP仅证明真实fetch/流/端口与关闭；不是现场模型、真实SQL或Owner验收。 */
async function nameHttp(respond:(body:Record<string,unknown>,response:ServerResponse)=>void){
  const sockets=new Set<Socket>(),socketClosures=new Map<Socket,Promise<void>>(),requests:Record<string,unknown>[]=[],errors:unknown[]=[]
  const server=createServer((request,response)=>{const parts:Buffer[]=[];let bytes=0;request.on('data',(part:Buffer)=>{bytes+=part.length;if(bytes>128*1024)request.destroy();else parts.push(part)})
    request.on('end',()=>{try{const body=JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string,unknown>;requests.push(body);respond(body,response)}catch(error){errors.push(error);response.destroy()}})
  });server.on('connection',socket=>{sockets.add(socket);socketClosures.set(socket,new Promise<void>(resolve=>socket.once('close',()=>{sockets.delete(socket);socketClosures.delete(socket);resolve()})))})
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string')
  return{url:`http://127.0.0.1:${address.port}`,requests,errors,async close(){const socketQuiet=[...socketClosures.values()],closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));server.closeIdleConnections();server.closeAllConnections();await closed;await Promise.all(socketQuiet);assert.equal(server.listening,false);assert.equal(sockets.size,0);assert.deepEqual(errors,[])}}
}
function nameHarness(transport:ReturnType<typeof createLocalNameTransport>,holdOwner=false,checkGate?:()=>Promise<void>){
  const identity={datasetId:randomUUID(),epoch:randomUUID()},binding=Object.freeze({datasetId:identity.datasetId,ownerEpoch:identity.epoch,childGeneration:1,authorityRef:Object.freeze({})}),authorityId=randomUUID()
  let revoked=false,fatal=0,ownerCalls=0,sequence=0
  const ownerStarted=nameDeferred<void>(),ownerAccepted=nameDeferred<dto.LocalLibraryBatchPage>()
  const original:dto.LocalLibraryManagementPayloads['library.ai.start']={commandId:randomUUID(),captureId:randomUUID(),backend:'vllm',selection:'selected',albumIds:[randomUUID()]}
  const page:dto.LocalLibraryBatchPage={jobId:original.commandId,captureId:original.captureId,kind:'ai',state:'queued',totalAlbums:1,processedAlbums:0,succeededAlbums:0,failedAlbums:0,offset:0,items:[{albumId:original.albumIds[0]!,state:'queued',message:null}]}
  const author:LocalWorkbenchRootMainAuthor={binding,async assertCurrent(value){assert.equal(value.authorityRef,binding.authorityRef);assert.equal(value.datasetId,binding.datasetId);assert.equal(value.ownerEpoch,binding.ownerEpoch);if(revoked)throw new Error('合成Owner已撤销');if(checkGate)await checkGate()},async request(request){ownerCalls++;assert.equal(request.family,'management');ownerStarted.resolve();return holdOwner?ownerAccepted.promise:page},async requestOwner(){throw new Error('该受控桥不提供额外Owner命令')}}
  const current=()=>revoked?undefined:author,main=createLocalWorkbenchNameMainBridge({currentAuthor:current,getTransport(value){assert.equal(value.authorityRef,binding.authorityRef);return transport}})
  const trustedFrame=Object.freeze({synthetic:true}),boundary=createLocalWorkbenchManagementBoundary({assertTrusted(event:object){assert.equal(event,trustedFrame)},isAccepting:()=>!revoked,currentAuthor:current,
    acceptNameRequest:(q,c)=>main.accept(q,c),observeNameResult:(q,r,c)=>main.observe(q,r,c)})
  const channel=new MessageChannel(),requests:DatasetNameProviderRequest[]=[],replies:DatasetNameProviderReply[]=[],errors:unknown[]=[]
  const utility=createUtilityNameProviderBridge({on(_event,listener){channel.port1.on('message',data=>listener({data}))},start(){channel.port1.start()},postMessage(value){channel.port1.postMessage(value)}},()=>identity,()=>{fatal++})
  let mutate:((reply:DatasetNameProviderReply)=>DatasetNameProviderReply)|undefined
  channel.port2.on('message',raw=>{void(async()=>{const q=captureDatasetNameProviderRequest(raw);requests.push(q);assert.ok(q.sequence>sequence);sequence=q.sequence
    const echo={version:1 as const,type:'musicbridge.name.provider-reply' as const,requestId:q.requestId,sequence:q.sequence,epoch:q.epoch,datasetId:q.datasetId,authorityId,childGeneration:binding.childGeneration,command:q.command,requestSha256:datasetWorkbenchSha(datasetWorkbenchJson(q))};let reply:DatasetNameProviderReply
    try{const result=await main.execute(q,{binding,signal:new AbortController().signal,deadlineAtMs:performance.now()+Math.max(1,q.expiresAtMs-Date.now())});reply={...echo,ok:true,result}}
    catch(error){reply={...echo,ok:false,failure:error instanceof DatasetNameProviderBridgeError?error.code:'NOT_READY'}}
    assertDatasetNameProviderReplyForRequest(reply,q);replies.push(reply);channel.port2.postMessage(captureDatasetNameProviderReply(mutate?mutate(reply):reply))
  })().catch(error=>errors.push(error))})
  const start:DatasetNameProviderStart={operationId:randomUUID(),jobId:original.commandId,captureId:original.captureId,albumId:original.albumIds[0]!,preparationId:randomUUID(),backend:original.backend,systemPrompt:'合成测试：只返回名称JSON。',userPrompt:'合成专辑原正文。',originalStartSha256:datasetNameOriginalStartSha256(original),expiresAtMs:Date.now()+15_000}
  return{identity,binding,main,utility,boundary,start,original,ownerStarted,ownerAccepted,page,requests,replies,errors,get fatal(){return fatal},get ownerCalls(){return ownerCalls},setMutator(fn:typeof mutate){mutate=fn},
    accept(){return boundary.management(trustedFrame,{datasetId:identity.datasetId,command:'library.ai.start',payload:original})},
    resume(){return boundary.management(trustedFrame,{datasetId:identity.datasetId,command:'library.job.resume',payload:{jobId:original.commandId}})},
    call<K extends DatasetNameProviderCommand>(command:K,payload:DatasetProjectionCommandPayloads[K]){return utility.call(command,payload,identity)},revoke(){revoked=true},
    async close(){await main.close();await boundary.close();await transport.close();utility.close();channel.port1.close();channel.port2.close();assert.deepEqual(errors,[])}}
}
async function nameReadAll(h:ReturnType<typeof nameHarness>):Promise<Buffer>{
  const chunks:Buffer[]=[];let offset=0,total:number|undefined,sha:string|undefined
  for(let attempt=0;attempt<200;attempt++){
    const r=await h.call('nameProviderRead',{operationId:h.start.operationId,offset}) as DatasetNameProviderRead
    if(r.state==='running'||r.state==='queued'){await new Promise<void>(resolve=>setTimeout(resolve,5));continue}
    assert.equal(r.state,'complete');assert.equal(r.failure,null);assert.ok(r.bytes.byteLength<=60*1024);assert.equal(r.offset,offset)
    if(total===undefined){total=r.totalBytes!;sha=r.sha256!}else{assert.equal(r.totalBytes,total);assert.equal(r.sha256,sha)}
    chunks.push(Buffer.from(r.bytes));offset+=r.bytes.byteLength;if(r.eof){const raw=Buffer.concat(chunks);assert.equal(raw.length,total);assert.equal(datasetWorkbenchSha(raw),sha);return raw}
  }
  throw new Error('合成名称流未在有限轮次完成')
}

test('NAME真实桥：原trusted start经Owner受理后才调用同Main配置，完整分块EOF与SHA保留原job正文',async()=>{
  const text=JSON.stringify({artistName:'合成歌手',albumName:'名'.repeat(21_000)})
  let failNext=false
  const http=await nameHttp((_body,response)=>{if(failNext){failNext=false;response.writeHead(500,{'content-type':'text/plain'});response.end('合成已知HTTP失败。');return}response.writeHead(200,{'content-type':'text/event-stream'});response.write('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n');response.end('data: [DONE]\n')})
  const transport=createLocalNameTransport({getConfiguration:()=>({baseUrl:http.url,model:'synthetic-fixed'}),maxLineBytes:256*1024}),h=nameHarness(transport,true)
  try{
    const accepted=h.accept();await h.ownerStarted.promise
    let started=false;const start=h.call('nameProviderStart',h.start).then(value=>{started=true;return value})
    await new Promise<void>(resolve=>setTimeout(resolve,20));assert.equal(started,false);assert.equal(http.requests.length,0)
    h.ownerAccepted.resolve(h.page);await accepted;await start
    const raw=await nameReadAll(h);assert.deepEqual(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw)),{backend:'vllm',content:text})
    assert.ok(raw.length>60*1024);assert.equal(http.requests.length,1);assert.equal(http.requests[0]!.model,'synthetic-fixed')
    assert.deepEqual(http.requests[0]!.messages,[{role:'system',content:h.start.systemPrompt},{role:'user',content:h.start.userPrompt}]);assert.equal(h.ownerCalls,1)
    const first=h.requests[0]!;assert.ok(first.command==='nameProviderStart');assert.equal(first.payload.originalStartSha256,datasetNameOriginalStartSha256(h.original));assert.equal(first.payload.expiresAtMs,h.start.expiresAtMs)
    await assert.rejects(h.call('nameProviderStart',{...h.start,userPrompt:'不是原完整Name正文'}),{code:'INVALID_INPUT'})
    await h.call('nameProviderJoin',{operationId:h.start.operationId});assert.equal(h.main.pending(),0);assert.equal(h.fatal,0)
    await h.resume()
    await assert.rejects(h.call('nameProviderStart',{...h.start,preparationId:randomUUID(),expiresAtMs:h.start.expiresAtMs+1}),{code:'INVALID_INPUT'})
    await assert.rejects(h.call('nameProviderStart',{...h.start,preparationId:randomUUID(),userPrompt:'重试不能改原完整正文。'}),{code:'INVALID_INPUT'})
    const retry={...h.start,preparationId:randomUUID(),expiresAtMs:h.start.expiresAtMs-1};await h.call('nameProviderStart',retry);await nameReadAll(h)
    await h.call('nameProviderJoin',{operationId:h.start.operationId});assert.equal(h.main.pending(),0);assert.equal(http.requests.length,2);assert.equal(h.ownerCalls,2)
    // 真正loopback HTTP失败先收口；同一受理job再准备引用只能保留原正文并缩短期限。
    await h.resume();failNext=true
    const failedStart={...h.start,preparationId:randomUUID(),expiresAtMs:h.start.expiresAtMs-2};await h.call('nameProviderStart',failedStart)
    let knownFailed:DatasetNameProviderRead|undefined
    for(let i=0;i<100;i++){const r=await h.call('nameProviderRead',{operationId:h.start.operationId,offset:0}) as DatasetNameProviderRead;if(r.state==='failed'){knownFailed=r;break}await new Promise<void>(resolve=>setTimeout(resolve,5))}
    assert.equal(knownFailed?.state,'failed');assert.equal(knownFailed?.failure,'HTTP_STATUS');assert.equal(knownFailed?.totalBytes,null)
    assert.deepEqual(await h.call('nameProviderJoin',{operationId:h.start.operationId}),{operationId:h.start.operationId,physicalClosed:true});assert.equal(h.main.pending(),0)
    await h.resume()
    const recovered={...h.start,preparationId:randomUUID(),expiresAtMs:h.start.expiresAtMs-3};assert.notEqual(recovered.preparationId,failedStart.preparationId);await h.call('nameProviderStart',recovered)
    const recoveredRaw=await nameReadAll(h);assert.deepEqual(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(recoveredRaw)),{backend:'vllm',content:text})
    assert.deepEqual(await h.call('nameProviderJoin',{operationId:h.start.operationId}),{operationId:h.start.operationId,physicalClosed:true});assert.equal(h.main.pending(),0);assert.equal(http.requests.length,4);assert.equal(h.ownerCalls,4)
    for(const q of h.requests){assert.ok(!JSON.stringify(q).includes(http.url));assert.ok(!Object.hasOwn(q.payload,'baseUrl'));assert.ok(!Object.hasOwn(q.payload,'secret'))}
  }finally{h.ownerAccepted.resolve(h.page);await h.close();await http.close()}
})

test('NAME真实桥：取消只触达原operation，迟到fetch及reader实际关闭前Join不能声称physicalClosed',async()=>{
  const fetched=nameDeferred<Response>(),fetchStarted=nameDeferred<void>(),cancelEntered=nameDeferred<void>(),cancelQuiet=nameDeferred<void>()
  let fetches=0,cancels=0,stops=0
  const body=new ReadableStream<Uint8Array>({cancel(){cancels++;cancelEntered.resolve();return cancelQuiet.promise}})
  const transport=createLocalNameTransport({getConfiguration:()=>({baseUrl:'http://127.0.0.1:1',model:'synthetic-late'}),fetch:async()=>{fetches++;fetchStarted.resolve();return fetched.promise}})
  const originalStop=transport.stop;transport.stop=()=>{stops++;return originalStop()}
  const h=nameHarness(transport)
  try{
    await h.accept();await h.call('nameProviderStart',h.start);await fetchStarted.promise
    await h.call('nameProviderCancel',{operationId:h.start.operationId});let joined=false
    const join=h.call('nameProviderJoin',{operationId:h.start.operationId}).then(value=>{joined=true;return value})
    await new Promise<void>(resolve=>setTimeout(resolve,20));assert.equal(joined,false);assert.equal(stops,0);assert.equal(fetches,1)
    fetched.resolve(new Response(body,{status:200,headers:{'content-type':'text/event-stream'}}));await cancelEntered.promise
    await new Promise<void>(resolve=>setTimeout(resolve,20));assert.equal(joined,false);assert.equal(h.main.pending(),1);assert.equal(stops,0)
    cancelQuiet.resolve();assert.deepEqual(await join,{operationId:h.start.operationId,physicalClosed:true});assert.equal(cancels,1);assert.equal(h.main.pending(),0);assert.equal(stops,0);assert.equal(h.fatal,0)
  }finally{fetched.resolve(new Response(null,{status:503}));cancelQuiet.resolve();await h.close()}
  let legacyResponse!:ServerResponse;const legacyStarted=nameDeferred<void>()
  const http=await nameHttp((_body,out)=>{legacyResponse=out;out.writeHead(200,{'content-type':'text/event-stream'});out.write(': 合成Legacy等待\n');legacyStarted.resolve()})
  const sameTransport=createLocalNameTransport({getConfiguration:()=>({baseUrl:http.url,model:'synthetic-shared'})}),legacyController=new AbortController()
  let sharedStops=0;const sharedStop=sameTransport.stop;sameTransport.stop=()=>{sharedStops++;return sharedStop()}
  const legacy=sameTransport.suggest({backend:'vllm',systemPrompt:'原Legacy合成系统正文。',userPrompt:'原Legacy合成用户正文。'},legacyController.signal);void legacy.catch(()=>undefined)
  const shared=nameHarness(sameTransport)
  try{
    await legacyStarted.promise;await shared.accept();await shared.call('nameProviderStart',shared.start)
    let failed:DatasetNameProviderRead|undefined
    for(let i=0;i<100;i++){const r=await shared.call('nameProviderRead',{operationId:shared.start.operationId,offset:0}) as DatasetNameProviderRead;if(r.state==='failed'){failed=r;break}await new Promise<void>(resolve=>setTimeout(resolve,5))}
    assert.equal(failed?.failure,'NOT_READY');await shared.call('nameProviderCancel',{operationId:shared.start.operationId});await shared.call('nameProviderJoin',{operationId:shared.start.operationId})
    assert.equal(sharedStops,0);assert.equal(legacyController.signal.aborted,false);assert.equal(legacyResponse.destroyed,false);assert.equal(http.requests.length,1)
    legacyResponse.end('data: '+JSON.stringify({choices:[{delta:{content:'原Legacy完整名称'},finish_reason:'stop'}]})+'\n')
    assert.deepEqual(await legacy,{backend:'vllm',content:'原Legacy完整名称'});await sameTransport.join(legacy);assert.equal(shared.main.pending(),0);assert.equal(sharedStops,0)
  }finally{legacyController.abort();await shared.close();await http.close()}
})

test('NAME真实桥：未配置或无原start不得调用后端，跨Owner与整wire摘要改变拒绝并收口原资源',async()=>{
  let response!:ServerResponse;const http=await nameHttp((_body,out)=>{response=out;out.writeHead(200,{'content-type':'text/event-stream'});out.write(': 合成流等待取消\n')})
  const unavailable=nameHarness(createLocalNameTransport({getConfiguration:()=>null}))
  try{await assert.rejects(unavailable.accept(),{code:'NOT_READY'});assert.equal(unavailable.ownerCalls,0);await assert.rejects(unavailable.call('nameProviderStart',unavailable.start),{code:'NOT_READY'});assert.equal(unavailable.main.pending(),0)}finally{await unavailable.close()}
  const coldHttp=await nameHttp((_body,out)=>{out.writeHead(200,{'content-type':'text/event-stream'});out.end('data: '+JSON.stringify({choices:[{delta:{content:'{"artistName":"合成","albumName":"冷恢复"}'},finish_reason:'stop'}]})+'\n')})
  const cold=nameHarness(createLocalNameTransport({getConfiguration:()=>({baseUrl:coldHttp.url,model:'synthetic-fixed'})}))
  try{
    await assert.rejects(cold.call('nameProviderStart',cold.start),{code:'NOT_READY'});assert.equal(coldHttp.requests.length,0)
    // 本合成Owner回执只验证桥关联；生产fullstart/expandedSelection仍由唯一Root同库读取。
    await cold.resume();await cold.call('nameProviderStart',cold.start);await nameReadAll(cold)
    await assert.rejects(cold.call('nameProviderStart',{...cold.start,operationId:randomUUID(),originalStartSha256:'e'.repeat(64)}),{code:'NOT_READY'})
    await cold.call('nameProviderJoin',{operationId:cold.start.operationId});assert.equal(coldHttp.requests.length,1);assert.equal(cold.main.pending(),0);assert.equal(cold.fatal,0)
  }finally{await cold.close();await coldHttp.close()}
  const h=nameHarness(createLocalNameTransport({getConfiguration:()=>({baseUrl:http.url,model:'synthetic-fixed'})}))
  try{
    await assert.rejects(h.call('nameProviderStart',h.start),{code:'NOT_READY'});assert.equal(http.requests.length,0)
    await h.accept();await assert.rejects(h.call('nameProviderStart',{...h.start,originalStartSha256:'f'.repeat(64)}),{code:'NOT_READY'});assert.equal(http.requests.length,0)
    await h.call('nameProviderStart',h.start);for(let i=0;i<100&&http.requests.length===0;i++)await new Promise<void>(resolve=>setTimeout(resolve,5));assert.equal(http.requests.length,1)
    const original=h.requests.find(q=>q.command==='nameProviderStart'&&q.payload.originalStartSha256===h.start.originalStartSha256)!
    const fake=captureDatasetNameProviderReply({...h.replies.find(r=>r.requestId===original.requestId)!,authorityId:randomUUID()});assert.throws(()=>assertDatasetNameProviderReplyForRequest(fake,{...original,authorityId:h.replies.find(r=>r.requestId===original.requestId)!.authorityId,childGeneration:1}))
    h.setMutator(reply=>({...reply,requestSha256:'f'.repeat(64)}));await assert.rejects(h.call('nameProviderRead',{operationId:h.start.operationId,offset:0}));assert.equal(h.fatal,1)
    h.revoke();await assert.rejects(h.main.execute(captureDatasetNameProviderRequest({...original,requestId:randomUUID(),sequence:100,command:'nameProviderRead',payload:{operationId:h.start.operationId,offset:0}}),{binding:{...h.binding,childGeneration:2,authorityRef:Object.freeze({})},signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}),{code:'NOT_READY'})
    await h.main.revokeOwner(h.binding);assert.equal(h.main.pending(),0);assert.equal(http.requests.length,1);for(let i=0;i<100&&!response.destroyed&&!response.writableEnded;i++)await new Promise<void>(resolve=>setTimeout(resolve,5));assert.ok(response.destroyed||response.writableEnded)
  }finally{await h.close();await http.close()}
})

async function nameWait467<T>(work:Promise<T>,label:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('测试等待原阶段超时：'+label)),2000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
test('暖关闭467：封原NAME后Owner仍沿原port读结果与Join，拒新Start且共享Legacy继续原HTTP',async t=>{
  const legacyStarted=nameDeferred<void>();let legacyResponse:ServerResponse|undefined,nameResponse:ServerResponse|undefined,legacyDone=false;
  const http=await nameHttp((body,response)=>{const messages=body.messages as {content:string}[];response.writeHead(200,{'content-type':'text/event-stream'});
    if(messages[0]?.content==='独立Legacy合成任务'){legacyResponse=response;response.write('data: '+JSON.stringify({choices:[{delta:{content:'旧'},finish_reason:null}]})+'\n');legacyStarted.resolve();}
    else{nameResponse=response;response.end('data: '+JSON.stringify({choices:[{delta:{content:'完整原名称'},finish_reason:'stop'}]})+'\ndata: [DONE]\n');}
  });
  const transport=createLocalNameTransport({getConfiguration:()=>({baseUrl:http.url,model:'synthetic-fixed'})}),h=nameHarness(transport),legacySignal=new AbortController();
  let legacy:Promise<{backend:'ollama'|'vllm'|'cloud';content:string}>|undefined;
  try{
    // 真实transport只有一个执行slot；原NAME已物理完成但未由Owner Join消费时，Legacy可以使用该slot。
    await h.accept();await h.call('nameProviderStart',h.start);await nameReadAll(h);
    legacy=transport.suggest({backend:'vllm',systemPrompt:'独立Legacy合成任务',userPrompt:'原Legacy正文'},legacySignal.signal).then(value=>{legacyDone=true;return value;});void legacy.catch(()=>undefined);
    await nameWait467(legacyStarted.promise,'Legacy HTTP已进入');h.boundary.seal();await h.main.sealOwner(h.binding);
    assert.equal(legacySignal.signal.aborted,false);assert.equal(legacyDone,false);assert.equal(legacyResponse!.destroyed,false);assert.equal(h.main.pending(),1);
    await assert.rejects(h.call('nameProviderStart',{...h.start,operationId:randomUUID()}),{code:'NOT_READY'});assert.equal(http.requests.length,2);
    const result=await h.call('nameProviderRead',{operationId:h.start.operationId,offset:0}) as DatasetNameProviderRead;assert.equal(result.state,'complete');assert.ok(result.totalBytes!>0);assert.ok(result.bytes.length>0);
    const previous=h.requests.at(-1)!;await assert.rejects(h.main.execute(captureDatasetNameProviderRequest({...previous,requestId:randomUUID(),sequence:100_000}),{binding:{...h.binding,ownerEpoch:randomUUID(),authorityRef:{}},signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}),{code:'INVALID_INPUT'});
    assert.deepEqual(await h.call('nameProviderCancel',{operationId:h.start.operationId}),{operationId:h.start.operationId,cancelRequested:true});
    assert.deepEqual(await h.call('nameProviderJoin',{operationId:h.start.operationId}),{operationId:h.start.operationId,physicalClosed:true});assert.equal(h.main.pending(),0);
    await assert.rejects(h.call('nameProviderJoin',{operationId:h.start.operationId}),{code:'NOT_READY'});assert.ok(nameResponse!.destroyed||nameResponse!.writableEnded);
    legacyResponse!.end('data: '+JSON.stringify({choices:[{delta:{content:'任务'},finish_reason:'stop'}]})+'\ndata: [DONE]\n');assert.deepEqual(await legacy,{backend:'vllm',content:'旧任务'});assert.equal(legacyDone,true);assert.equal(h.fatal,0);assert.deepEqual(h.errors,[]);
  }finally{legacyResponse?.end();await h.close();await http.close();}
  t.diagnostic('实际loopback HTTP、Reader和专用MessagePort；受控作者/Owner受理口，不授完整Main工厂2000ms。');
});
test('暖关闭467：HTTP已真实Join后的作者失权只记语义取消，原Owner还能消费物理关闭回声',async t=>{
  const started=nameDeferred<void>(),checked=nameDeferred<void>(),gate=nameDeferred<void>();let response:ServerResponse|undefined,armed=false;
  const http=await nameHttp((_body,value)=>{response=value;value.writeHead(200,{'content-type':'text/event-stream'});started.resolve();});
  const transport=createLocalNameTransport({getConfiguration:()=>({baseUrl:http.url,model:'synthetic-fixed'})}),h=nameHarness(transport,false,async()=>{if(armed){checked.resolve();await gate.promise;}});
  try{
    await h.accept();await h.call('nameProviderStart',h.start);await nameWait467(started.promise,'NAME HTTP已进入');armed=true;response!.end('data: '+JSON.stringify({choices:[{delta:{content:'完整合成名称'},finish_reason:'stop'}]})+'\ndata: [DONE]\n');await nameWait467(checked.promise,'HTTP已Join后进入原作者核对');
    let sealed=false;const sealing=h.main.sealOwner(h.binding).then(()=>{sealed=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(sealed,false);gate.resolve();await sealing;
    assert.equal(h.main.pending(),1);const read=await h.call('nameProviderRead',{operationId:h.start.operationId,offset:0}) as DatasetNameProviderRead;assert.equal(read.state,'cancelled');assert.equal(read.totalBytes,null);
    assert.deepEqual(await h.call('nameProviderJoin',{operationId:h.start.operationId}),{operationId:h.start.operationId,physicalClosed:true});assert.equal(h.main.pending(),0);assert.equal(http.requests.length,1);assert.equal(h.fatal,0);assert.deepEqual(h.errors,[]);
  }finally{gate.resolve();response?.end();await h.close();await http.close();}
  t.diagnostic('仅在实际transport.join完成后允许语义失败不阻断quiet；未证明的physical失败仍拒绝。');
});


import { spawnSync as spawnMainCapture478 } from 'node:child_process'
import { readFileSync as readMainCapture478, writeFileSync as writeMainCapture478, realpathSync as realMainCapture478, lstatSync as statMainCapture478 } from 'node:fs'
import { createHash as hashMainCapture478 } from 'node:crypto'
import pathMainCapture478 from 'node:path'
import { fileURLToPath as fileUrlMainCapture478 } from 'node:url'

function mainRecord478(value:unknown):Record<string,unknown>{
 assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value),'Main收据必须是实际JSON对象。')
 return value as Record<string,unknown>
}
function mainPin478(value:unknown):{file:string;bytes:number;sha256:string}{
 const row=mainRecord478(value);assert.ok(typeof row.file==='string'&&pathMainCapture478.isAbsolute(row.file))
 assert.ok(typeof row.bytes==='number'&&Number.isSafeInteger(row.bytes)&&row.bytes>=0)
 assert.ok(typeof row.sha256==='string'&&/^[a-f0-9]{64}$/u.test(row.sha256))
 const info=statMainCapture478(row.file);assert.ok(info.isFile()&&!info.isSymbolicLink());assert.equal(realMainCapture478(row.file),row.file)
 const bytes=readMainCapture478(row.file);assert.equal(bytes.length,row.bytes);assert.equal(hashMainCapture478('sha256').update(bytes).digest('hex'),row.sha256)
 return {file:row.file,bytes:row.bytes,sha256:row.sha256}
}
test('002 Main完整库：实际Electron到唯一Owner worker同SQL捕获201专辑405成员遵守原2000ms并自然关闭',{timeout:90000},async t=>{
 const bindingFile=process.env.MB_V39_MAIN_CAPTURE468_BUILD_BINDING,runner=process.env.MB_V39_MAIN_CAPTURE468_RUNNER
 const resultFile=process.env.MB_V39_MAIN_CAPTURE468_RESULT,capture=process.env.MB_V39_MAIN_CAPTURE468_CAPTURE_DIRECTORY
 assert.equal(process.env.V39_INTEGRATION002_GATE_ROLE,'source','完整Main例必须由当前Source Tool准备，缺件不能skip。')
 for(const value of [bindingFile,runner,resultFile,capture])assert.ok(value&&pathMainCapture478.isAbsolute(value),'PREPARATION_FAILED：缺当前Source Main绑定或独立runner。')
 assert.ok(bindingFile&&runner&&resultFile&&capture)
 const repository=pathMainCapture478.resolve(fileUrlMainCapture478(new URL('../../../../',import.meta.url)))
 const bindingBytes=readMainCapture478(bindingFile),binding=mainRecord478(JSON.parse(bindingBytes.toString('utf8')) as unknown)
 assert.equal(binding.schema,'v39.main-library-capture468.fresh-build.v1');assert.equal(binding.root,repository)
 assert.equal(binding.timeBasis,'whole-source-standard-run');assert.equal(binding.sourceSha,process.env.MB_V39_SOURCE_SHA);assert.equal(binding.scopeSha256,process.env.MB_V39_SCOPE_SHA256)
 assert.ok(Array.isArray(binding.gateInputs));const runnerPin=binding.gateInputs.find(value=>mainRecord478(value).file===runner)
 assert.ok(runnerPin);mainPin478(runnerPin);mainPin478(binding.compilerReceiptPin);mainPin478(binding.standardReceipt);mainPin478(binding.electronIdentityReceiptPin)
 const wall=Math.min(Number(process.env.MB_V39_GATE_DEADLINE),Number(process.env.MB_V39_MAIN_CAPTURE468_STAGE_DEADLINE))
 assert.ok(Number.isFinite(wall)&&wall>Date.now(),'原Tool/stage剩余期限已经用尽。')
 const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT
 const child=spawnMainCapture478(process.execPath,['--test','--test-reporter=tap',runner],{cwd:repository,env:childEnv,
  timeout:Math.max(1,Math.floor(Math.min(90000,wall-Date.now()))),killSignal:'SIGTERM',maxBuffer:16*1024*1024})
 writeMainCapture478(pathMainCapture478.join(capture,'runner.stdout.log'),child.stdout??Buffer.alloc(0),{flag:'wx',mode:0o600})
 writeMainCapture478(pathMainCapture478.join(capture,'runner.stderr.log'),child.stderr??Buffer.alloc(0),{flag:'wx',mode:0o600})
 assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,'实际独立Main runner必须自然零退出。')
 const stdout=(child.stdout??Buffer.alloc(0)).toString('utf8');assert.ok(stdout.includes('V39_MAIN_CAPTURE468_RUNNER_PASS'))
 for(const line of ['# tests 1','# pass 1','# fail 0','# cancelled 0','# skipped 0','# todo 0'])assert.ok(stdout.split(/\r?\n/u).includes(line))
 const proof=mainRecord478(JSON.parse(readMainCapture478(resultFile,'utf8')) as unknown),actual=mainRecord478(proof.actual),sql=mainRecord478(proof.sql)
 assert.equal(proof.schema,'v39.main-library-capture468.proof.v1');assert.equal(proof.caseName,'002 Main完整库：实际Electron到唯一Owner worker同SQL捕获201专辑405成员遵守原2000ms并自然关闭')
 assert.equal(proof.sourceSha,binding.sourceSha);assert.equal(proof.scopeSha256,binding.scopeSha256)
 assert.ok(typeof actual.elapsedMs==='number'&&Number.isFinite(actual.elapsedMs)&&actual.elapsedMs>=0&&actual.elapsedMs<2000)
 assert.equal(actual.utilityExit,0);assert.equal(actual.killCalls,0);assert.equal(actual.mainPortsClosed,3);assert.equal(actual.channelsCreated,3)
 assert.equal(sql.albums,201);assert.equal(sql.members,405);assert.equal(sql.largeAlbumMembers,205)
 assert.equal(sql.captureId,mainRecord478(actual.result).captureId);assert.equal(sql.datasetId,mainRecord478(actual.result).datasetId)
 assert.equal(proof.nativeExecuted,true);assert.equal(actual.nativeExecuted,true);assert.equal(proof.parserExecuted,false)
 assert.equal(actual.factory505Executed,true);assert.equal(actual.factory505Invocations,1)
 assert.equal(proof.fullTenActorAcceptance,false);assert.equal(actual.fullTenActorAcceptance,false)
 const nativeBootstrap=mainRecord478(actual.nativeBootstrap);assert.ok(Array.isArray(binding.nativeFrozenInputs))
 for(const key of ['cue','tags','watch']){const bundle=mainRecord478(nativeBootstrap[key]);assert.ok(typeof bundle.root==='string');assert.ok(typeof bundle.manifestSha256==='string')
  const manifest:unknown=binding.nativeFrozenInputs.find(value=>mainRecord478(value).file===pathMainCapture478.join(bundle.root as string,'manifest.json'))
  assert.ok(manifest);assert.equal(mainPin478(manifest).sha256,bundle.manifestSha256)}
 const c03=mainRecord478(actual.c03);assert.equal(mainRecord478(c03.timely).state,'succeeded');assert.equal(mainRecord478(c03.late).state,'unknown')
 for(const key of ['httpSocketsClosed','allOriginalProducerFDsClosed','allActualWindowsClosed'])assert.equal(mainRecord478(c03.afterPhysicalCleanup)[key],true)
 const processProof=mainRecord478(proof.electronProcess);assert.equal(processProof.passed,true);assert.equal(processProof.rawCaptureComplete,true);assert.equal(processProof.observedDescendantsAbsent,true)
 assert.equal(mainRecord478(processProof.physicalShutdown).pidAbsent,true);assert.equal(mainRecord478(processProof.physicalShutdown).processGroupAbsent,true)
 assert.deepEqual(readMainCapture478(bindingFile),bindingBytes)
 t.diagnostic('当前production Main/CoreHost/默认Owner工厂及同SQL完整捕获；三真实Native初始化与watch启动、原统一2000ms、真实Electron raw和自然后代关闭；输出资格另由Native原件核，完整十actor及真实账号仍独立。')
})
