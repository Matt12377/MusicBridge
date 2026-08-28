import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as c from '@music-bridge/contracts'
const id = (n: number): string => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-08-28T00:00:00.000Z', end = '2026-08-29T00:00:00.000Z', hash = (s: string): string => s.repeat(64);
function planFixture() {
  const technical = { container: 'WAV', codec: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16, durationMs: 1000, lossless: true, sampleFrames: 48000, frameEvidence: 'container-declared' as const };
  const binding: c.SourceBinding = { id: id(4), rootId: id(5), fileName: '合成.wav', acquisition: 'userFileBind', verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability: 'ONLINE', sha256: hash('a'), size: 192044, modifiedAt: date, verifiedAt: date, technical, userConfirmed: true, sourceLockEligible: true };
  const master: c.MasterVersion = { id: id(2), draftId: id(1), sequence: 1, title: '合成母版', createdAt: date, content: { programType: 'compilation', tracks: [{ trackId: id(3), metadata: { title: '合成曲目', durationMs: 1000 }, source: { sha256: binding.sha256, size: binding.size, technical }, transitionAfterMs: 0, keepWithNext: false }] }, contentHash: hash('b'), sourceEvidence: [{ trackId: id(3), binding }], status: 'frozen' };
  const capacityFrames = 1440000;
  const layout: c.LayoutVersion = { id: id(6), draftId: master.draftId, masterVersionId: master.id, sequence: 1, planId: id(7), createdAt: date, spec: { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: false } }, lengthMinutes: 1, reservation: { physicalId: 'MB-C-00001', modelId: id(8), skuId: id(9), packaging: 'opened' }, timeline: { timebase: 'sample-frames', sampleRate: 48000, rounding: 'nearest-half-up-v1', sides: [{ name: 'A', capacityFrames, leadInFrames: 0, tailFrames: 0, totalFrames: 48000, tracks: [{ trackId: id(3), sourceBindingId: binding.id, sourceSampleRate: 48000, sourceFrames: 48000, startFrame: 0, endFrame: 48000, gapAfterFrames: 0 }] }, { name: 'B', capacityFrames, leadInFrames: 0, tailFrames: 0, totalFrames: 0, tracks: [] }] }, timelineHash: hash('c'), status: 'frozen', executionReady: false };
  const profile: c.RecordingProfileVersion = { id: id(10), profileId: id(11), sequence: 1, createdAt: date, contentHash: hash('d'), content: { name: '合成录音配置', signalChain: [{ id: id(12), kind: 'audio-interface', label: '未认证合成设备' }], defaults: { noiseReduction: 'Off', calibration: null, recordLevel: null, preRollMs: 1000 }, compatibility: layout.spec.compatibility, executionFormat: { sampleRate: 48000, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'synthetic-unverified', version: '1' } } } };
  const settings: c.ResolvedRecordingSettings = { profile, overrides: {}, effective: c.effectiveRecordingSettings(profile, {}), format: { ...profile.content.executionFormat, outputProfileVersion: profile.id }, fingerprint: hash('e') };
  const recipe: c.ExecutionRecipe = { schemaVersion: 1, mode: 'direct', compiler: 'musicbridge-pcm-copy-v1', masterVersionId: master.id, layoutVersionId: layout.id, contentHash: master.contentHash, plannedTimelineHash: layout.timelineHash, format: settings.format, side: 'A', capacityFrames, totalFrames: 48000, segments: [{ kind: 'source', trackId: id(3), input: { sha256: binding.sha256, size: binding.size, sampleRate: 48000, channelCount: 2, bitsPerSample: 16, totalFrames: 48000 }, startFrame: 0, endFrame: 48000 }], formalReady: false };
  const receipt: c.ExecutionAudioReceipt = { recipe, recipeHash: hash('f'), origin: 'compiled', audio: { sha256: hash('a'), pcmSha256: hash('b'), size: 192044, frameCount: 48000, dataOffset: 44 }, formalReady: false };
  const material = { master, layout, execution: { assetId: id(13), manifestHash: hash('d'), mode: 'direct' as const, compiledSettings: settings, recipes: [recipe, { ...recipe, side: 'B' as const, totalFrames: 0, segments: [] }], audio: [receipt] }, physicalCopy: { physicalId: layout.reservation.physicalId, lotId: id(14), skuId: layout.reservation.skuId, lengthMinutes: 1, packaging: 'opened' as const, usage: 'reserved' as const, available: true, origin: 'blank-pool' as const, revision: 2 }, mediaPlanRevision: 2, profileSnapshot: { sessionRevision: 3, settings: { ...settings, overrides: { noiseReduction: null }, effective: c.effectiveRecordingSettings(profile, { noiseReduction: null }), fingerprint: hash('f') } }, archive: { operationId: id(15), rootId: id(16), sourcePolicy: 'reference-dependent' as const, manifestHash: hash('a'), phase: 'FINALIZED' as const, objectCount: 3, copyBytes: 192500 }, retentionPolicy: 'f01-permanent-execution-v1' as const, onlineFallback: false as const, formalReady: false as const };
  const selection = { assetId: material.execution.assetId, archiveOperationId: material.archive.operationId };
  const proposal = { ...material, draftId: master.draftId, selection, checkedAt: date, proposalFingerprint: hash('c') };
  const plan = { ...material, id: id(17), draftId: master.draftId, sequence: 1, createdAt: date, contentHash: hash('e'), status: 'frozen' as const };
  return { material, selection, proposal, plan };
}
function recordFixture(): c.RecordingRecord {
  const { plan } = planFixture(), receipt = plan.execution.audio[0]!;
  return { schemaVersion: 1, id: id(50), createdAt: end, contentHash: hash('a'), completion: {
    kind: 'formal', id: id(51), draftId: plan.draftId, planVersionId: plan.id, planContentHash: plan.contentHash, executionAssetId: plan.execution.assetId, physicalId: plan.physicalCopy.physicalId,
    revision: 7, createdAt: date, updatedAt: end, endedAt: end, status: 'completed', phase: 'finished', softwarePlaybackComplete: true, physicalRecordingConfirmedAt: end, finalVerificationCompleteAt: end,
    sides: [{ side: 'A', phase: 'complete', frameCount: receipt.audio.frameCount, recipeHash: receipt.recipeHash, audioSha256: receipt.audio.sha256, pcmSha256: receipt.audio.pcmSha256, runId: id(52), sourceFramesRead: 48000, submittedFrames: 48000, consumedFrames: 48000, sourceEof: true, backendDrained: true, engineStoppedSubmitting: true, stopAcknowledged: false, cleanupQuiescent: false, startedAt: date, endedAt: end, physicalStopConfirmedAt: end }],
  }, media: { snapshotSource: 'completion', modelId: plan.layout.reservation.modelId, lotId: plan.physicalCopy.lotId, skuId: plan.physicalCopy.skuId, lengthMinutes: 1, origin: 'blank-pool', descriptor: { brand: '合成', name: '系列', edition: '', year: null, format: 'cassette', tapeType: 'II', identification: 'unidentified' } },
  visuals: { artwork: { state: 'not-captured', reason: 'not-provided' }, jCard: { state: 'not-captured', reason: 'not-implemented' }, photos: { state: 'not-captured', reason: 'not-provided' } } };
}
function stateFixture(): c.PhysicalRecordingState { return { physicalId: 'MB-C-00001', revision: 1, physicalRevision: 3, knowledge: { state: 'confirmed-recording', recordingId: id(50), confirmedAt: end, evidence: { kind: 'completed-attempt', attemptId: id(51), revision: 7 } }, latestAttempt: { id: id(51), revision: 7, status: 'completed' }, activeRerecordPermit: null }; }

function detailFixture(): c.RecordingRecordDetail { return { record: recordFixture(), plan: planFixture().plan, current: stateFixture() } }
function deferred<T>() { let resolve!: (value:T)=>void, reject!: (error:Error)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no}); return {promise,resolve,reject} }
function inspection(readId = id(80), detail = detailFixture()): c.RecordingReplicaInspection {
 const r = detail.plan.execution.audio[0]!, f = r.recipe.format;
 return { readId, recordingId: detail.record.id, recordingContentHash: detail.record.contentHash, planVersionId: detail.plan.id, planContentHash: detail.plan.contentHash, archiveOperationId: detail.plan.archive.operationId, archiveManifestHash: detail.plan.archive.manifestHash, checkedAt: end, fingerprint: hash('f'), playback:'blocked',deviceOpened:false,formalReady:false,gateB:'NOT_RUN', targets:[{target:'actual-execution',side:'A',state:'verified',audio:{target:'actual-execution',executionAssetId:detail.plan.execution.assetId,recipeHash:r.recipeHash,fileSha256:r.audio.sha256,pcmSha256:r.audio.pcmSha256,size:r.audio.size,frameCount:r.audio.frameCount,format:{container:'wav',sampleRate:f.sampleRate,channelCount:f.channelCount,sampleFormat:f.outputSampleFormat},pcmHashEvidence:'frozen-execution'}},{target:'actual-execution',side:'B',state:'empty',frameCount:0}] };
}
function fixture() {
 const calls: { name:string; request:unknown }[]=[];
 const api: c.RecordingReplicaPublicApi = {
 async getRecordingReplicaStatus(){calls.push({name:'status',request:{}});return {playback:'blocked',reason:'BACKEND_UNAVAILABLE',deviceAccess:'not-authorized',deviceOpened:false,formalReady:false,gateB:'NOT_RUN'}},
 async inspectRecordingReplica(request){calls.push({name:'inspect',request});return inspection(request.readId)},
 async cancelRecordingReplicaRead(readId){calls.push({name:'cancel',request:readId});return {readId,cancelRequested:true}},
 async startRecordingReplica(request){calls.push({name:'start',request});throw new Error('blocked')},
 async getRecordingReplicaRun(runId){calls.push({name:'get',request:runId});return {run:null}},
 async stopRecordingReplica(runId){calls.push({name:'stop',request:runId});return {kind:'cancelled-before-start',runId,state:'cancelled',started:false,stopRequested:true,cleanupQuiescent:true,evidence:'none',deviceOpened:false,formalReady:false,gateB:'NOT_RUN'}}
 }; return {api,calls};
}
async function controller(f=fixture()) {
 const m=await import('../src/renderer/src/components/recording/recording-replica-controller.js').catch(()=>({})); assert.ok('createRecordingReplicaController' in m,'缺少Replica控制器');
 const ctl=(m as typeof import('../src/renderer/src/components/recording/recording-replica-controller.js')).createRecordingReplicaController({api:f.api,detail:detailFixture()});return {...f,ctl};
}
test('初态不自动核验/选目标/选面，状态只读且播放始终阻断',async()=>{
 const f=await controller();assert.equal(f.calls.length,0);await f.ctl.refreshStatus();assert.equal(f.ctl.state.phase,'unread');assert.equal(f.ctl.state.target,'');assert.equal(f.ctl.state.side,'');await f.ctl.start();assert.deepEqual(f.calls.map(x=>x.name),['status']);
})
test('核验明确历史身份，选择目标再选非空side，切目标清side，不补gap',async()=>{
 const f=await controller();await f.ctl.inspect();assert.equal(f.ctl.state.phase,'ready');assert.equal(f.ctl.state.target,'');f.ctl.selectTarget('actual-execution');assert.equal(f.ctl.state.side,'');f.ctl.selectSide('B');assert.equal(f.ctl.state.side,'');f.ctl.selectSide('A');assert.equal(f.ctl.selected()?.state,'verified');f.ctl.selectTarget('original-render');assert.equal(f.ctl.state.target,'');assert.equal(f.ctl.state.side,'');assert.equal(f.calls.length,1);
})
test('拒绝合法但不属于选中档案/计划/音频的回执与非严格状态',async()=>{
 for(const change of [(r:c.RecordingReplicaInspection)=>{r.recordingId=id(99)},(r:c.RecordingReplicaInspection)=>{r.planContentHash=hash('c')},(r:c.RecordingReplicaInspection)=>{if(r.targets[0]?.state==='verified')r.targets[0].audio.pcmSha256=hash('c')},(r:c.RecordingReplicaInspection)=>{r.readId=id(99)}]) {const f=await controller();f.api.inspectRecordingReplica=async req=>{const r=inspection(req.readId);change(r);return r};await f.ctl.inspect();assert.equal(f.ctl.state.phase,'error');assert.equal(f.ctl.state.inspection,undefined)}
 const f=await controller();f.api.getRecordingReplicaStatus=async()=>({playback:'available'} as never);await f.ctl.refreshStatus();assert.equal(f.ctl.state.statusPhase,'error');await f.ctl.start();assert.equal(f.calls.some(x=>x.name==='start'),false)
})
test('单核验：取消ACK不代表原读取结束，迟到成功作废后才可新read',async()=>{
 const f=await controller(),wait=deferred<c.RecordingReplicaInspection>();let req!:c.InspectRecordingReplicaRequest;f.api.inspectRecordingReplica=r=>{req=r;return wait.promise};const first=f.ctl.inspect();await f.ctl.inspect();await f.ctl.cancel();assert.equal(f.ctl.state.phase,'cancelling');assert.equal(f.ctl.canClose(),false);wait.resolve(inspection(req.readId));await first;assert.equal(f.ctl.state.phase,'cancelled');assert.equal(f.ctl.state.inspection,undefined);assert.equal(f.ctl.canClose(),true);
 const previous=req.readId;f.api.inspectRecordingReplica=async r=>{req=r;return inspection(r.readId)};await f.ctl.inspect();assert.notEqual(req.readId,previous);assert.equal(f.ctl.state.phase,'ready')
})
test('取消先于inspect到达仍沿同readId，取消失败可重试且未知不丢',async()=>{
 const f=await controller(),wait=deferred<c.RecordingReplicaInspection>();let req!:c.InspectRecordingReplicaRequest;f.api.inspectRecordingReplica=r=>{req=r;return wait.promise};const work=f.ctl.inspect();f.api.cancelRecordingReplicaRead=async()=>{throw new Error('/private/token')};await f.ctl.requestClose();assert.equal(f.ctl.state.phase,'cancel-failed');assert.equal(f.ctl.canClose(),false);wait.resolve(inspection(req.readId));await work;assert.equal(f.ctl.canClose(),false);assert.doesNotMatch(f.ctl.state.error,/private|token/);f.api.cancelRecordingReplicaRead=async readId=>({readId,cancelRequested:true});await f.ctl.cancel();assert.equal(f.ctl.canClose(),true);assert.equal(f.ctl.state.inspection,undefined)
})
test('取消响应ID不匹配不能假确认；网络错误不渲染路径，显式重试新read',async()=>{
 const f=await controller(),wait=deferred<c.RecordingReplicaInspection>();f.api.inspectRecordingReplica=()=>wait.promise;const work=f.ctl.inspect();f.api.cancelRecordingReplicaRead=async()=>({readId:id(99),cancelRequested:true});await f.ctl.cancel();assert.equal(f.ctl.state.phase,'cancel-failed');wait.reject(new Error('/private/secret'));await work;assert.equal(f.ctl.canClose(),false)
 const g=await controller();g.api.inspectRecordingReplica=async()=>{throw new Error('/private/secret')};await g.ctl.inspect();assert.equal(g.ctl.state.phase,'error');assert.doesNotMatch(g.ctl.state.error,/private|secret/);g.api.inspectRecordingReplica=async req=>inspection(req.readId);await g.ctl.inspect();assert.equal(g.ctl.state.phase,'ready')
})
test('关闭等待取消和原读取，卸载不接受迟到数据也不自动重播',async()=>{
 const f=await controller(),wait=deferred<c.RecordingReplicaInspection>();let req!:c.InspectRecordingReplicaRequest;f.api.inspectRecordingReplica=r=>{req=r;return wait.promise};const work=f.ctl.inspect();await f.ctl.requestClose();assert.equal(f.ctl.canClose(),false);f.ctl.dispose();wait.resolve(inspection(req.readId));await work;assert.equal(f.ctl.state.inspection,undefined);assert.equal(f.calls.some(x=>x.name==='start'),false)
})
test('状态读取迟到/失败不会伪造可播放，run读取/停止有限且绝不自动start',async()=>{
 const f=await controller();await f.ctl.getRun('invalid');await f.ctl.stopRun('invalid');assert.equal(f.calls.length,0);await f.ctl.getRun(id(88));await f.ctl.stopRun(id(88));assert.equal(f.ctl.state.run?.kind,'cancelled-before-start');assert.deepEqual(f.calls.map(x=>x.name),['get','stop']);await f.ctl.start();assert.equal(f.calls.some(x=>x.name==='start'),false)
})
async function mounted(t: test.TestContext, api: c.RecordingReplicaPublicApi, detail = detailFixture(), entry = false) {
  const vue = await import('vue'), require = createRequire(import.meta.url), fs = require('node:fs') as typeof import('node:fs'), path = require('node:path') as typeof import('node:path')
  const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc') as typeof import('@vue/compiler-sfc'), ts = require('typescript') as typeof import('typescript')
  const controller = await import('../src/renderer/src/components/recording/recording-replica-controller.js')
  const document = { body: {}, activeElement: undefined as unknown }; document.activeElement = document.body
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'); Object.defineProperty(globalThis, 'document', { configurable: true, value: document }); t.after(() => { if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document') })
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const modules = new Map<string, import('vue').Component>()
  function loadSfc(filename: string): import('vue').Component {
    if (modules.has(filename)) return modules.get(filename)!
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8')); assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: filename }), module = { exports: {} as { default: import('vue').Component } }
    const load = (name: string): unknown => name === 'vue' ? vue : name.endsWith('recording-replica-controller') ? controller : name.endsWith('.vue') ? { default: loadSfc(path.resolve(path.dirname(filename), name)) } : require(name)
    new Function('require', 'module', 'exports', 'window', 'document', compile(script.content))(load, module, module.exports, { musicBridge: api }, document)
    const template = compileTemplate({ id: filename, filename, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
    const render = { exports: {} as { render: (...args: unknown[]) => unknown } }; new Function('require', 'module', 'exports', compile(template.code))(load, render, render.exports)
    const result = { ...module.exports.default, render: render.exports.render }; modules.set(filename, result); return result
  }
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; focus(): void; showModal(): void; addEventListener(): void; readonly options: Host[]; value: unknown }
  const node = (tag = ''): Host => vue.markRaw({ tag, text: '', children: [], parent: null, props: {}, value: '', get options() { return this.children.filter((n: Host) => n.tag === 'option') }, addEventListener() {}, focus() { document.activeElement = this }, showModal() {} })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: () => node('#comment'), setText(n, text) { n.text = text }, setElementText(n, text) { n.text = text; n.children = [] }, patchProp(n, key, _old, value) { if (key === 'value') n.value = value; n.props[key] = key === 'disabled' && value === '' ? true : value; if (key === 'disabled' && (value === true || value === '') && document.activeElement === n) document.activeElement = document.body }, insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(child); else parent.children.splice(i, 0, child) }, remove(child) { if (document.activeElement === child) document.activeElement = document.body; child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[(n.parent?.children.indexOf(n) ?? -1) + 1] ?? null })
  const component = loadSfc(new URL('../src/renderer/src/components/recording/' + (entry ? 'RecordingRecordDetail.vue' : 'RecordingReplicaPanel.vue'), import.meta.url).pathname), root = node(); let closed = 0
  const detailRef = vue.shallowRef(detail)
  const app = renderer.createApp({ setup: () => () => vue.h(component, { detail: detailRef.value, state: { visualPhase: 'unread' }, onClose: () => { closed++ } }) }); app.mount(root); t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }; await tick()
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))], text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const button = (label: string) => { const value = all().find(n => n.tag === 'button' && text(n).trim() === label); assert.ok(value, label); return value }
  const click = async (label: string) => { const target = button(label); assert.notEqual(target.props.disabled, true, label); target.focus(); await (target.props.onClick as (e: unknown) => unknown)({ currentTarget: target }); await tick() }
  const field = async (label: string, value: string) => { const parent = all().find(n => n.tag === 'label' && text(n).trim().startsWith(label)); assert.ok(parent, label); const target = all(parent).find(n => n.tag === 'input' || n.tag === 'select'); assert.ok(target); (target.props['onUpdate:modelValue'] as (v: string) => void)(value); const handler = target.props[target.tag === 'select' ? 'onChange' : 'onInput'] as ((event: unknown) => void) | undefined; if (handler) handler({ target: { value } }); await tick() }
  const confirm = async () => { const target = all().find(n => n.tag === 'input' && n.props.type === 'checkbox'); assert.ok(target); (target.props.onChange as (event: unknown) => void)({ target: { checked: true } }); await tick() }
  return { setDetail: async (value: c.RecordingRecordDetail) => { detailRef.value = value; await tick() }, all, text, button, click, field, confirm, tick, focused: () => document.activeElement, body: document.body, closed: () => closed, unmount: () => app.unmount() }
}


test('真实SFC初态/后端阻断/显式核验和目标选择，不生成播放成功入口',async t=>{
 const f=fixture(),p=await mounted(t,f.api);assert.match(p.text(),/尚未核验/);assert.match(p.text(),/播放后端不可用/);assert.equal(f.calls.filter(x=>x.name==='inspect').length,0);assert.equal(p.button('播放所选历史音频').props.disabled,true);await p.click('核验历史音频');assert.match(p.text(),/历史音频核验通过/);assert.match(p.text(),/空面/);assert.equal(p.button('播放所选历史音频').props.disabled,true)
})
test('真实SFC禁用按钮失焦后恢复，用户移焦不抢回；失败可重试',async t=>{
 for(const move of [false,true]) {const f=fixture(),p=await mounted(t,f.api),wait=deferred<c.RecordingReplicaInspection>();let req!:c.InspectRecordingReplicaRequest;f.api.inspectRecordingReplica=r=>{req=r;return wait.promise};const origin=p.button('核验历史音频');origin.focus();const work=(origin.props.onClick as ()=>Promise<void>)();await p.tick();const other=p.button('关闭 Digital Replica');if(move)other.focus();wait.resolve(inspection(req.readId));await work;await p.tick();assert.ok(p.focused()===(move?other:p.all().find(n=>n.tag==='h2')));p.unmount()}
})
test('真实SFC关闭时不消失未知取消，失败仍能重试，迟到成功不展示',async t=>{
 const f=fixture(),p=await mounted(t,f.api),wait=deferred<c.RecordingReplicaInspection>();let req!:c.InspectRecordingReplicaRequest;f.api.inspectRecordingReplica=r=>{req=r;return wait.promise};const work=(p.button('核验历史音频').props.onClick as ()=>Promise<void>)();await p.tick();f.api.cancelRecordingReplicaRead=async()=>{throw new Error('/private/error')};await p.click('关闭 Digital Replica');assert.equal(p.closed(),0);assert.ok(p.button('重试取消核验'));wait.resolve(inspection(req.readId));await work;await p.tick();assert.doesNotMatch(p.text(),/历史音频核验通过|private/);f.api.cancelRecordingReplicaRead=async readId=>({readId,cancelRequested:true});await p.click('重试取消核验');assert.equal(p.closed(),1)
})
test('真实SFC切换record卸载旧read，迟到不覆盖新身份且无自动核验',async t=>{
 const f=fixture(),p=await mounted(t,f.api),wait=deferred<c.RecordingReplicaInspection>();let req!:c.InspectRecordingReplicaRequest;f.api.inspectRecordingReplica=r=>{req=r;return wait.promise};const work=(p.button('核验历史音频').props.onClick as ()=>Promise<void>)();await p.tick();const next=detailFixture();next.record.id=id(99);await p.setDetail(next);wait.resolve(inspection(req.readId));await work;await p.tick();assert.doesNotMatch(p.text(),/历史音频核验通过/);assert.equal(f.calls.filter(x=>x.name==='cancel').length,1)
})

test('档案详情提供显式Replica入口，独立key与关闭返回焦点', async () => {
 const text = await readFile(new URL('../src/renderer/src/components/recording/RecordingRecordDetail.vue', import.meta.url), 'utf8')
 assert.match(text, /<RecordingReplicaPanel/u); assert.match(text, /Digital Replica/u); assert.match(text, /:key="detail.record.id"/u); assert.match(text, /replicaTrigger.value\?\.focus/u)
})

function preparedDetail(): c.RecordingRecordDetail {
 const detail=detailFixture(),m=detail.plan,raw:c.RawRenderAsset={id:id(30),side:'A',sha256:hash('a'),size:192044,format:'wav',sampleRate:48000,channelLayout:'stereo',totalFrames:48000,createdAt:date,creationTimeEvidence:'first-observed'};
 const prepared:c.FrozenPrepared={id:id(31),draftId:m.master.draftId,sequence:1,preparationId:id(32),importJobId:id(33),masterVersionId:m.master.id,layoutVersionId:m.layout.id,contentHash:m.master.contentHash,plannedTimelineHash:m.layout.timelineHash,plannedTimeline:m.layout.timeline,renderTimeline:{timebase:'sample-frames',sides:[{name:'A',renderAssetId:raw.id,renderFileHash:raw.sha256,sampleRate:48000,channelLayout:'stereo',totalFrames:48000,markers:[{trackId:id(3),exactSourceSha256:hash('a'),actualStartFrame:0,actualEndFrame:48000,actualGapToNextFrames:0,confirmationMethod:'manual',userConfirmed:true}]},{name:'B',renderAssetId:null,renderFileHash:null,sampleRate:48000,channelLayout:'none',totalFrames:0,markers:[]}]},renderTimelineHash:hash('d'),assets:[raw],conformance:{status:'MATCHED',policy:'one-render-frame-v1',reasons:[]},varianceReason:'',daw:'合成DAW',processingLineage:'合成人工处理',createdAt:date,transitionRenderingMode:'Baked Into Render',status:'frozen',executionReady:false};
 const recipe:c.ExecutionRecipe={...m.execution.recipes[0] as c.ExecutionRecipe,mode:'prepared-reference',prepared:{id:prepared.id,renderTimelineHash:prepared.renderTimelineHash},segments:[{kind:'render',renderAssetId:raw.id,input:{sha256:raw.sha256,size:raw.size,sampleRate:48000,channelCount:2,bitsPerSample:16,totalFrames:48000},startFrame:0,endFrame:48000}]};
 m.prepared=prepared;m.execution={...m.execution,mode:'prepared-reference',recipes:[recipe,{...recipe,side:'B',totalFrames:0,segments:[]}],audio:[{...m.execution.audio[0]!,recipe,origin:'retained-render'}]};assert.equal(c.isRecordingRecordDetail(detail),true);return detail;
}
function preparedInspection(readId:string,detail=preparedDetail()):c.RecordingReplicaInspection{
 const r=inspection(readId,detail),raw=detail.plan.prepared!.assets[0]!;
 r.targets=[...r.targets,{target:'original-render',side:'A',state:'verified',audio:{target:'original-render',preparedVersionId:detail.plan.prepared!.id,renderAssetId:raw.id,fileSha256:raw.sha256,size:raw.size,frameCount:raw.totalFrames,format:{container:'wav',sampleRate:48000,channelCount:2,sampleFormat:'pcm-s16le'},pcmSha256:hash('b'),pcmHashEvidence:'verified-render-bytes'}},{target:'original-render',side:'B',state:'empty',frameCount:0}];assert.equal(c.isRecordingReplicaInspection(r),true);return r;
}
test('取消失败重试成功清除旧“尚未确认”错误，不留下矛盾状态',async()=>{
 const f=await controller(),wait=deferred<c.RecordingReplicaInspection>();let req!:c.InspectRecordingReplicaRequest;f.api.inspectRecordingReplica=r=>{req=r;return wait.promise};const work=f.ctl.inspect();f.api.cancelRecordingReplicaRead=async()=>{throw new Error('failed')};await f.ctl.cancel();wait.resolve(inspection(req.readId));await work;f.api.cancelRecordingReplicaRead=async readId=>({readId,cancelRequested:true});await f.ctl.cancel();assert.equal(f.ctl.state.phase,'cancelled');assert.equal(f.ctl.state.error,'')
})
test('Prepared原Render明确选择后显示原始字节证据，切版本不沿用side',async t=>{
 const f=fixture(),detail=preparedDetail();f.api.inspectRecordingReplica=async r=>preparedInspection(r.readId,detail);const p=await mounted(t,f.api,detail);await p.click('核验历史音频');
 const selects=p.all().filter(n=>n.tag==='select');assert.equal(selects[0]!.props.value,'');assert.equal(selects[1]!.props.value,'');
 (selects[0]!.props.onChange as (e:unknown)=>void)({target:{value:'original-render'}});await p.tick();assert.equal(selects[1]!.props.value,'');(selects[1]!.props.onChange as (e:unknown)=>void)({target:{value:'A'}});await p.tick();assert.match(p.text(),/PCM 摘要来自本次核验的原始 Render 字节/);assert.equal(p.button('播放所选历史音频').props.disabled,true)
})
test('所有缺失原因中文且空B不冒充成功，源变更不套用旧身份',async t=>{
 for(const reason of ['ARCHIVE_UNAVAILABLE','ARCHIVE_CHANGED','RESTORE_UNAVAILABLE','AUTHORIZATION_REVOKED','AUDIO_UNAVAILABLE','AUDIO_CHANGED','UNSUPPORTED_FORMAT','IDENTITY_MISMATCH','DEPENDENCY_UNAVAILABLE','DURATION_LIMIT'] as const){const f=fixture();f.api.inspectRecordingReplica=async req=>({...inspection(req.readId),targets:[{target:'actual-execution',side:'A',state:'unavailable',reason},{target:'actual-execution',side:'B',state:'empty',frameCount:0}]});const p=await mounted(t,f.api);await p.click('核验历史音频');assert.match(p.text(),/历史音频核验未通过/);assert.doesNotMatch(p.text(),new RegExp(reason));assert.equal(p.button('播放所选历史音频').props.disabled,true);p.unmount()}
})
test('真实SFC显式详情入口、Escape关闭与焦点返回，未核验不取消',async t=>{
 const f=fixture(),p=await mounted(t,f.api,detailFixture(),true);assert.equal(p.all().some(n=>n.props['data-testid']==='recording-replica-panel'),false);await p.click('Digital Replica');assert.equal(f.calls.some(x=>x.name==='inspect'),false);const dialog=p.all().find(n=>n.tag==='dialog');assert.ok(dialog);await (dialog.props.onCancel as (e:unknown)=>Promise<void>)({preventDefault(){}});await p.tick();assert.equal(p.all().some(n=>n.props['data-testid']==='recording-replica-panel'),false);assert.ok(p.focused()===p.button('Digital Replica'));assert.equal(f.calls.some(x=>x.name==='cancel'),false)
})
test('状态迟到不盖新状态，卸载后不通知；失败核验也恢复键盘焦点',async t=>{
 const f=await controller(),wait=deferred<c.RecordingReplicaStatus>();f.api.getRecordingReplicaStatus=()=>wait.promise;const old=f.ctl.refreshStatus();f.api.getRecordingReplicaStatus=async()=>{throw new Error('failed')};await f.ctl.refreshStatus();wait.resolve({playback:'blocked',reason:'BACKEND_UNAVAILABLE',deviceAccess:'not-authorized',deviceOpened:false,formalReady:false,gateB:'NOT_RUN'});await old;assert.equal(f.ctl.state.statusPhase,'error');
 const g=fixture(),p=await mounted(t,g.api);g.api.inspectRecordingReplica=async()=>{throw new Error('/private/secret')};await p.click('核验历史音频');assert.match(p.text(),/历史音频核验失败/);assert.ok(p.focused()===p.all().find(n=>n.tag==='h2'));assert.equal(p.button('核验历史音频').props.disabled,false)
})

test('DAT只有明确连续节目，不伪造A/B或自动选中',async t=>{
 const detail=detailFixture(),plan=detail.plan,physicalId='MB-D-00001';
 plan.layout.spec={...plan.layout.spec,format:'dat',splitAfter:0,compatibility:{confirmed:true,cassetteTypes:[],dat:true}};
 plan.layout.reservation.physicalId=physicalId;plan.physicalCopy.physicalId=physicalId;plan.layout.timeline.sides=[{...plan.layout.timeline.sides[0]!,name:'Program',capacityFrames:2880000}];
 const recipe={...plan.execution.recipes[0]!,side:'Program' as const,capacityFrames:2880000};plan.execution.recipes=[recipe];plan.execution.audio=[{...plan.execution.audio[0]!,recipe} as c.ExecutionAssetAudio];
 detail.record.completion.physicalId=physicalId;detail.record.completion.sides=[{...detail.record.completion.sides[0]!,side:'Program'}];detail.current.physicalId=physicalId;
 detail.record.media.descriptor={...detail.record.media.descriptor!,format:'dat',tapeType:'dat'};assert.equal(c.isRecordingRecordDetail(detail),true);
 const f=fixture();f.api.inspectRecordingReplica=async req=>{const r=inspection(req.readId,detail);r.targets=[{...r.targets[0]!,side:'Program'}];assert.equal(c.isRecordingReplicaInspection(r),true);return r};const p=await mounted(t,f.api,detail);await p.click('核验历史音频');assert.match(p.text(),/连续节目（Program）/);assert.doesNotMatch(p.text(),/A 面|B 面/);const selects=p.all().filter(n=>n.tag==='select');assert.equal(selects[0]!.props.value,'');assert.equal(selects[1]!.props.value,'')
})
