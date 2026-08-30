import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const hash = 'a'.repeat(64)
async function moduleUnderTest() {
  const module = await import('../src/main/recording-print-ipc.js').catch(() => ({}))
  assert.ok('installRecordingPrintHandlers' in module, '缺少Artwork/J-Card有限IPC')
  return module as typeof import('../src/main/recording-print-ipc.js')
}
test('六个Core命令及原生选择/导出严格固定工作库，不暴露worker或任意HTML/路径入口', async () => {
  const { installRecordingPrintHandlers } = await moduleUnderTest()
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>(), calls: any[] = []
  const datasetId = randomUUID(), masterVersionId = randomUUID(), recordingId = randomUUID(), artifactId = randomUUID()
  let epoch = 1, selected = 0, exported = 0, latePick = false
  installRecordingPrintHandlers({ handle: (channel, handler) => handlers.set(channel, handler), requireTrusted: event => { if (!event) throw new Error('不可信') },
    supervisor: { request: (async (name: string, payload: unknown, scope: string) => { calls.push([name,payload,scope]); return name === 'commandOutbox.context' ? {datasetId} : { ok:true } }) as never,
      requestInternal: (async (name: string,payload: unknown,scope:string) => { calls.push([name,payload,scope]); return { artifactId,pdfSha256:hash,size:20,pdfBase64:Buffer.from('%PDF-1\n%%EOF\n').toString('base64') } }) as never },
    getEpoch: () => epoch,
    pickArtwork: async () => { selected++; if (latePick) epoch++; return { width: 1, height: 1, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' } },
    exportPdf: async options => { exported++; await options.assertCurrent(); assert.equal(options.isCurrent(),true); return {state:'cancelled'} },
  })
  assert.deepEqual([...handlers.keys()].sort(), ['masterArtwork:get','masterArtwork:pick','masterArtwork:save','recordingPrints:export','recordingPrints:get','recordingPrints:list','recordingPrints:request','recordingPrints:retry'].sort())
  assert.equal([...handlers.keys()].some(key => key.includes('Worker') || key.includes('html') || key.includes('path')), false)
  const envelope=(payload:unknown)=>({datasetId,payload})
  const requests:Record<string,unknown>={
    'masterArtwork:get':{masterVersionId},'masterArtwork:save':{commandId:randomUUID(),masterVersionId,expectedVersionId:null,image:{width:1,height:1,dataUrl:'data:image/jpeg;base64,/9j/2Q=='},userConfirmed:true},
    'recordingPrints:list':{recordingId,page:{offset:0,limit:25}},'recordingPrints:request':{commandId:randomUUID(),recordingId,expectedRecordHash:hash,templateId:'jp0-basic-v1',userConfirmed:true},
    'recordingPrints:retry':{commandId:randomUUID(),jobId:randomUUID(),expectedRevision:1,userConfirmed:true},'recordingPrints:get':{recordingId,artifactId},
  }
  for(const [channel,payload] of Object.entries(requests)) await handlers.get(channel)!(true,envelope(payload))
  assert.deepEqual(calls.slice(0,6).map(call=>call[0]), Object.keys(requests).map(key=>key.replace(':','.')))
  assert.ok(calls.slice(0,6).every(call=>call[2]===datasetId))
  assert.deepEqual(await handlers.get('masterArtwork:pick')!(true,envelope({masterVersionId})), {state:'selected',masterVersionId,image:{width:1,height:1,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}})
  assert.equal(selected,1); assert.equal(calls.at(-1)[0],'masterArtwork.get')
  assert.deepEqual(await handlers.get('recordingPrints:export')!(true,envelope({recordingId,artifactId,expectedPdfSha256:hash})),{state:'cancelled'})
  assert.equal(exported,1)
  await assert.rejects(Promise.resolve().then(()=>handlers.get('recordingPrints:list')!(false,envelope(requests['recordingPrints:list']))),/不可信/u)
  for(const bad of [{datasetId,payload:requests['recordingPrints:list'],extra:true},{datasetId:'/private',payload:{}},{datasetId,payload:{recordingId,page:{offset:0,limit:26}}}])
    await assert.rejects(Promise.resolve().then(()=>handlers.get('recordingPrints:list')!(true,bad)),/INVALID_IPC_REQUEST/u)
  latePick = true
  await assert.rejects(Promise.resolve().then(()=>handlers.get('masterArtwork:pick')!(true,envelope({masterVersionId}))),/SCOPE/u)
})
test('preload客户端一次捕获DTO和scope；原生动作失败不重放或换库', async () => {
  const module = await import('../src/preload/recording-print-client.js').catch(() => ({}))
  assert.ok('createRecordingPrintClient' in module)
  const calls:any[]=[],datasetId=randomUUID(),recordingId=randomUUID()
  let release!:(v:unknown)=>void
  const scope=new Promise(resolve=>{release=resolve})
  const client=(module as typeof import('../src/preload/recording-print-client.js')).createRecordingPrintClient(async(channel,value)=>{calls.push([channel,value]);if(channel==='commandOutbox:context')return scope;throw new Error('合成失败')})
  const request={recordingId,page:{offset:0,limit:25}}, original=structuredClone(request), pending=client.listRecordingPrints(request); request.page.limit=1; release({datasetId})
  await assert.rejects(pending,/合成失败/u)
  assert.deepEqual(calls,[['commandOutbox:context',undefined],['recordingPrints:list',{datasetId,payload:original}]])
  await assert.rejects(client.exportRecordingPrint({recordingId,artifactId:randomUUID(),expectedPdfSha256:hash}),/合成失败/u)
  assert.equal(calls.filter(c=>c[0]==='commandOutbox:context').length,1)
})
