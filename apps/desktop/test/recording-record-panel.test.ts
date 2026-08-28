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
function summary(): c.RecordingRecordSummary { return { id: id(50), physicalId: 'MB-C-00001', attemptId: id(51), planVersionId: id(17), completedAt: end, title: '合成母版', format: 'cassette', modelId: id(8), mediaBrand: '', mediaSeries: '' }; }
function previewRequest(): c.PreviewPhysicalRecordingDispositionRequest { return { physicalId: 'MB-C-00001', expectedPhysicalRevision: 3, expectedContentRevision: 1, expectedAttempt: { id: id(51), revision: 7 }, intent: { action: 'mark-content-unknown' } }; }
function proposal(): c.PhysicalRecordingDispositionProposal { return { request: previewRequest(), checkedAt: end, proposalFingerprint: hash('a'), before: stateFixture(), effect: 'content-unknown', outputWillStart: false }; }
function applied(): c.ApplyPhysicalRecordingDispositionResult { return { disposition: { id: id(60), physicalId: 'MB-C-00001', createdAt: end, intent: { action: 'mark-content-unknown' }, beforeContentRevision: 1, afterContentRevision: 2, beforePhysicalRevision: 3, afterPhysicalRevision: 3, observedAttempt: { id: id(51), revision: 7 } }, state: { ...stateFixture(), revision: 2, knowledge: { state: 'unknown', reason: 'manual-unknown', since: end } } }; }
function permit(): c.RerecordPermit { return { id: id(61), physicalId: 'MB-C-00001', dispositionId: id(60), createdAt: end, mediaPlanId: id(7), mediaPlanRevision: 3, contentRevision: 2, physicalRevision: 4, precedingAttempt: { id: id(51), revision: 7 }, state: 'available' }; }
function attachment(): c.RecordingVisualAttachment { return { id: id(70), recordingId: id(50), sourcePhotoId: id(71), physicalId: 'MB-C-00001', role: 'photo', source: 'physical-photo', sha256: hash('a'), size: 4, mimeType: 'image/jpeg', width: 1, height: 1 }; }


function deferred<T>() { let resolve!: (value:T)=>void, reject!: (error:Error)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no}); return {promise,resolve,reject} }
function fixture() {
 const calls:{name:string;request:unknown}[]=[]; const detail:c.RecordingRecordDetail={record:recordFixture(),plan:planFixture().plan,current:stateFixture()};
 const api:c.RecordingRecordsPublicApi={
 async listRecordingRecords(request){calls.push({name:'list',request});return {items:[summary()],offset:request.page.offset,limit:25,total:1,hasMore:false}},
 async getRecordingRecord(request){calls.push({name:'get',request});return {record:structuredClone(detail)}},
 async getRecordingRecordVisual(request){calls.push({name:'visual',request});return {...request,sha256:hash('a'),image:{dataUrl:'data:image/jpeg;base64,/9j/2Q==',width:1,height:1}}},
 async getPhysicalRecordingHistory(request){calls.push({name:'history',request});return {state:stateFixture(),entries:{items:[],offset:request.page.offset,limit:25,total:0,hasMore:false}}},
 async previewPhysicalRecordingDisposition(request){calls.push({name:'preview',request});return {...proposal(),request}},
 async applyPhysicalRecordingDisposition(request){calls.push({name:'apply',request});return applied()}
 }; return {api,calls,detail}
}
async function controller(f=fixture()) {
 const module=await import('../src/renderer/src/components/recording/recording-record-controller.js').catch(()=>({}));assert.ok('createRecordingRecordController' in module,'缺少录音档案控制器');
 const ctl=(module as typeof import('../src/renderer/src/components/recording/recording-record-controller.js')).createRecordingRecordController({api:f.api}); return {...f,ctl}
}
test('首次仅分页25不自动选/预览/写，错误不冒充空档案',async()=>{
 const f=await controller();await f.ctl.refresh();assert.equal(f.ctl.state.selectedId,'');assert.deepEqual(f.calls.map(x=>x.name),['list']);f.api.listRecordingRecords=async()=>{throw new Error('/private/secret')};await f.ctl.refresh();assert.equal(f.ctl.state.listPhase,'error');assert.doesNotMatch(f.ctl.state.listError,/private|secret/)
})
test('筛选原文交Core，纯数字查历史必须显式介质，不分配编号',async()=>{
 const f=await controller();await f.ctl.search({query:'427',artist:'合成'});assert.deepEqual((f.calls[0]!.request as c.ListRecordingRecordsRequest).filter,{query:'427',artist:'合成'});
 const m=await import('../src/renderer/src/components/recording/recording-record-controller.js');assert.equal(m.normalizeRecordingPhysicalId('427',''),'');assert.equal(m.normalizeRecordingPhysicalId('427','D'),'MB-D-00427');assert.equal(m.normalizeRecordingPhysicalId('C-0427',''),'MB-C-00427');assert.equal(m.normalizeRecordingPhysicalId('MB-D-00427','C'),'MB-D-00427')
})
test('无Record实体仍可查历史/current；不默认选首条',async()=>{const f=await controller();await f.ctl.openPhysical('MB-C-00001');assert.equal(f.ctl.state.current?.physicalId,'MB-C-00001');assert.equal(f.ctl.state.selectedId,'');assert.deepEqual(f.calls.map(x=>x.name),['history'])})
test('迟到列表/详情不能盖新选择，详情严格身份匹配',async()=>{
 const f=await controller(), wait=deferred<c.RecordingRecordsPage>();f.api.listRecordingRecords=()=>wait.promise;const old=f.ctl.refresh();await f.ctl.openPhysical('MB-C-00001');wait.resolve({items:[summary()],offset:0,limit:25,total:1,hasMore:false});await old;assert.equal(f.ctl.state.page,undefined);
 const read=deferred<{record:c.RecordingRecordDetail|null}>();f.api.getRecordingRecord=()=>read.promise;const pending=f.ctl.select(id(50));await f.ctl.openPhysical('MB-C-00001');read.resolve({record:f.detail});await pending;assert.equal(f.ctl.state.detail,undefined);
 f.api.getRecordingRecord=async()=>({record:{...f.detail,record:{...f.detail.record,id:id(90)}}});await f.ctl.select(id(50));assert.equal(f.ctl.state.detail,undefined);assert.ok(f.ctl.state.detailError)
})
test('照片按需单图及失败重试；切实体使迟到照片失效',async()=>{
 const f=await controller();f.detail.record.visuals.photos={state:'captured',attachments:[attachment()]};await f.ctl.select(id(50));assert.equal(f.calls.some(x=>x.name==='visual'),false);f.api.getRecordingRecordVisual=async()=>{throw new Error('/private/photo')};await f.ctl.loadVisual(id(70));assert.equal(f.ctl.state.visualPhase,'error');assert.equal(f.ctl.state.visual,undefined);
 const wait=deferred<c.RecordingVisualResult>();f.api.getRecordingRecordVisual=()=>wait.promise;const old=f.ctl.loadVisual(id(70));await f.ctl.openPhysical('MB-C-00001');wait.resolve({recordingId:id(50),attachmentId:id(70),sha256:hash('a'),image:{dataUrl:'data:image/jpeg;base64,/9j/2Q==',width:1,height:1}});await old;assert.equal(f.ctl.state.visual,undefined)
})
test('必须预览及人工勾选才apply；异常同DTO重试',async()=>{
 const f=await controller();await f.ctl.openPhysical('MB-C-00001');await f.ctl.apply();assert.equal(f.calls.some(x=>x.name==='apply'),false);await f.ctl.preview({action:'mark-content-unknown'});await f.ctl.apply();assert.equal(f.calls.some(x=>x.name==='apply'),false);f.ctl.setConfirmed(true);
 f.api.applyPhysicalRecordingDisposition=async request=>{f.calls.push({name:'apply',request});throw new Error('/private/database')};await f.ctl.apply();assert.ok(f.ctl.state.pending);await f.ctl.retry();assert.deepEqual(f.calls.filter(x=>x.name==='apply')[0]!.request,f.calls.filter(x=>x.name==='apply')[1]!.request);assert.doesNotMatch(f.ctl.state.operationError,/private|database/)
})
test('迟到preview/历史不能覆盖新选择或成功确认的revision',async()=>{
 const f=await controller();await f.ctl.openPhysical('MB-C-00001');const preview=deferred<c.PhysicalRecordingDispositionProposal>();f.api.previewPhysicalRecordingDisposition=()=>preview.promise;const stale=f.ctl.preview({action:'mark-content-unknown'});await f.ctl.select(id(50));preview.resolve(proposal());await stale;assert.equal(f.ctl.state.proposal,undefined);
 f.api.previewPhysicalRecordingDisposition=async()=>proposal();await f.ctl.preview({action:'mark-content-unknown'});f.ctl.setConfirmed(true);const read=deferred<c.PhysicalRecordingHistory>(),write=deferred<c.ApplyPhysicalRecordingDispositionResult>();f.api.getPhysicalRecordingHistory=()=>read.promise;f.api.applyPhysicalRecordingDisposition=()=>write.promise;
 const applying=f.ctl.apply(),reading=f.ctl.history();write.resolve(applied());await applying;read.resolve({state:stateFixture(),entries:{items:[],offset:0,limit:25,total:0,hasMore:false}});await reading;assert.equal(f.ctl.state.current?.revision,2);assert.equal(f.ctl.state.detail?.current.revision,2)
})
test('卸载后读写不回填，不自动重试或执行',async()=>{
 const f=await controller();await f.ctl.openPhysical('MB-C-00001');await f.ctl.preview({action:'mark-content-unknown'});f.ctl.setConfirmed(true);const wait=deferred<c.ApplyPhysicalRecordingDispositionResult>();f.api.applyPhysicalRecordingDisposition=()=>wait.promise;const pending=f.ctl.apply();f.ctl.dispose();wait.resolve(applied());await pending;assert.equal(f.ctl.state.current?.revision,1)
})
test('SFC与双库入口存在，正式分支禁止旧补录',async()=>{
 const base='../src/renderer/src/components/';const panel=await readFile(new URL(base+'recording/RecordingRecordsPanel.vue',import.meta.url),'utf8').catch(()=>'');assert.ok(panel,'尚无档案面板');for(const key of ['recording-records-panel','录音档案','查看实体历史'])assert.ok(panel.includes(key),key);
 const music=await readFile(new URL(base+'collection/PhysicalMusicView.vue',import.meta.url),'utf8');assert.match(music,/v-if="!detail.formal"/u);assert.match(music,/档案与当前内容/u);const collection=await readFile(new URL(base+'collection/CollectionModelDetail.vue',import.meta.url),'utf8');assert.match(collection,/档案与当前内容/u)
})

async function mounted(t: test.TestContext, api: c.RecordingRecordsPublicApi, props: { physicalId?: string; draftId?: string } = {}) {
  const vue = await import('vue'), require = createRequire(import.meta.url), fs = require('node:fs') as typeof import('node:fs'), path = require('node:path') as typeof import('node:path')
  const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc') as typeof import('@vue/compiler-sfc'), ts = require('typescript') as typeof import('typescript')
  const controller = await import('../src/renderer/src/components/recording/recording-record-controller.js'), replicaController = await import('../src/renderer/src/components/recording/recording-replica-controller.js')
  const document = { body: {}, activeElement: undefined as unknown }; document.activeElement = document.body
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'); Object.defineProperty(globalThis, 'document', { configurable: true, value: document }); t.after(() => { if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document') })
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const modules = new Map<string, import('vue').Component>()
  function loadSfc(filename: string): import('vue').Component {
    if (modules.has(filename)) return modules.get(filename)!
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8')); assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: filename }), module = { exports: {} as { default: import('vue').Component } }
    const load = (name: string): unknown => name === 'vue' ? vue : name.endsWith('recording-record-controller') ? controller : name.endsWith('recording-replica-controller') ? replicaController : name.endsWith('.vue') ? { default: loadSfc(path.resolve(path.dirname(filename), name)) } : require(name)
    new Function('require', 'module', 'exports', 'window', 'document', compile(script.content))(load, module, module.exports, { musicBridge: api }, document)
    const template = compileTemplate({ id: filename, filename, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
    const render = { exports: {} as { render: (...args: unknown[]) => unknown } }; new Function('require', 'module', 'exports', compile(template.code))(load, render, render.exports)
    const result = { ...module.exports.default, render: render.exports.render }; modules.set(filename, result); return result
  }
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; focus(): void; showModal(): void; addEventListener(): void; readonly options: Host[]; value: unknown }
  const node = (tag = ''): Host => vue.markRaw({ tag, text: '', children: [], parent: null, props: {}, value: '', get options() { return this.children.filter((n: Host) => n.tag === 'option') }, addEventListener() {}, focus() { document.activeElement = this }, showModal() {} })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: () => node('#comment'), setText(n, text) { n.text = text }, setElementText(n, text) { n.text = text; n.children = [] }, patchProp(n, key, _old, value) { if (key === 'value') n.value = value; n.props[key] = key === 'disabled' && value === '' ? true : value; if (key === 'disabled' && (value === true || value === '') && document.activeElement === n) document.activeElement = document.body }, insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(child); else parent.children.splice(i, 0, child) }, remove(child) { if (document.activeElement === child) document.activeElement = document.body; child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[(n.parent?.children.indexOf(n) ?? -1) + 1] ?? null })
  const component = loadSfc(new URL('../src/renderer/src/components/recording/RecordingRecordsPanel.vue', import.meta.url).pathname), root = node(); let closed = 0
  const app = renderer.createApp({ setup: () => () => vue.h(component, { ...props, onClose: () => { closed++ } }) }); app.mount(root); t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }; await tick()
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))], text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const button = (label: string) => { const value = all().find(n => n.tag === 'button' && text(n).trim() === label); assert.ok(value, label); return value }
  const click = async (label: string) => { const target = button(label); assert.notEqual(target.props.disabled, true, label); target.focus(); await (target.props.onClick as (e: unknown) => unknown)({ currentTarget: target }); await tick() }
  const field = async (label: string, value: string) => { const parent = all().find(n => n.tag === 'label' && text(n).trim().startsWith(label)); assert.ok(parent, label); const target = all(parent).find(n => n.tag === 'input' || n.tag === 'select'); assert.ok(target); (target.props['onUpdate:modelValue'] as (v: string) => void)(value); const handler = target.props[target.tag === 'select' ? 'onChange' : 'onInput'] as ((event: unknown) => void) | undefined; if (handler) handler({ target: { value } }); await tick() }
  const confirm = async () => { const target = all().find(n => n.tag === 'input' && n.props.type === 'checkbox'); assert.ok(target); (target.props.onChange as (event: unknown) => void)({ target: { checked: true } }); await tick() }
  return { all, text, button, click, field, confirm, tick, focused: () => document.activeElement, body: document.body, closed: () => closed, unmount: () => app.unmount() }
}

test('真实SFC空态/明确编号介质/无默认选择且无播放和认证入口', async t => {
  const f = fixture(); f.api.listRecordingRecords = async () => ({ items: [], offset: 0, limit: 25, total: 0, hasMore: false })
  const p = await mounted(t, f.api); assert.match(p.text(), /暂无符合条件的录音档案；这不表示实体不存在/u); assert.match(p.text(), /不认证 Gate B/u)
  assert.equal(p.all().some(n => n.props['data-testid'] === 'recording-record-detail'), false); await p.field('实体编号', '427')
  const form = p.all().find(n => n.tag === 'form' && p.text(n).includes('查看实体历史')); assert.ok(form); await (form.props.onSubmit as (e: unknown) => unknown)({ preventDefault() {} }); await p.tick(); assert.match(p.text(), /必须明确选择/u); assert.equal(f.calls.some(x => x.name === 'history'), false)
})
test('真实SFC快照/三层事实/单图按需失败后重试，显示非型号图', async t => {
  const f = fixture(); f.detail.record.visuals.photos = { state: 'captured', attachments: [attachment()] }
  const p = await mounted(t, f.api); await p.click('查看录音档案 ' + id(50)); assert.match(p.text(), /录音档案详情/u); assert.match(p.text(), /软件播放完成：已完成/u); assert.match(p.text(), /完成时快照/u); assert.equal(p.all().some(n => n.tag === 'img'), false)
  const original = f.api.getRecordingRecordVisual; f.api.getRecordingRecordVisual = async () => { throw new Error('/private/image') }; await p.click('加载照片 1'); assert.match(p.text(), /此张历史照片读取失败/u); assert.doesNotMatch(p.text(), /private/u)
  f.api.getRecordingRecordVisual = original; await p.click('重试照片 1'); assert.equal(p.all().filter(n => n.tag === 'img').length, 1); assert.equal(f.calls.filter(x => x.name === 'visual').length, 1)
})
test('真实SFC五动作选择、预览与人工确认分开，确认后旧历史不继续供操作', async t => {
  const f = fixture(), p = await mounted(t, f.api, { physicalId: 'MB-C-00001' }); await p.field('处置方式', 'mark-content-unknown'); await p.click('预览处置')
  assert.equal(p.button('确认应用处置').props.disabled, true); assert.equal(f.calls.some(x => x.name === 'apply'), false)
  await p.confirm(); await p.click('确认应用处置'); assert.match(p.text(), /处置已应用/u); assert.match(p.text(), /内容修订 2/u); assert.match(p.text(), /当前内容未知/u); assert.equal(p.button('预览处置').props.disabled, true)
})
test('真实SFC预览禁用失焦后恢复；用户移焦不抢回，关闭读取不写入', async t => {
  for (const move of [false, true]) {
    const f = fixture(), p = await mounted(t, f.api, { physicalId: 'MB-C-00001' }), wait = deferred<c.PhysicalRecordingDispositionProposal>()
    f.api.previewPhysicalRecordingDisposition = () => wait.promise; await p.field('处置方式', 'mark-content-unknown'); const target = p.button('预览处置'); target.focus()
    const work = (target.props.onClick as () => Promise<void>)(); await p.tick(); const other = p.button('关闭录音档案'); if (move) other.focus()
    wait.resolve(proposal()); await work; await p.tick(); if (move) assert.ok(p.focused() === other); else assert.ok(p.focused() === p.all().find(n => n.tag === 'h2'))
    await p.click('关闭录音档案'); assert.equal(p.closed(), 1); assert.equal(f.calls.some(x => x.name === 'apply'), false)
  }
})

test('真实SFC未分类来源不改称历史登记，未实现JCard明确区分未提供', async t => {
  const f = fixture(); f.detail.record.media.origin = 'unclassified'; f.detail.plan.physicalCopy.origin = 'unclassified'
  const p = await mounted(t, f.api); await p.click('查看录音档案 ' + id(50)); assert.match(p.text(), /未分类/u); assert.match(p.text(), /J-Card：尚未实现/u)
})

test('确认成功后切换同实体档案的旧详情也不得恢复旧revision', async () => {
  const f = await controller(); await f.ctl.openPhysical('MB-C-00001'); await f.ctl.preview({ action: 'mark-content-unknown' }); f.ctl.setConfirmed(true)
  const write = deferred<c.ApplyPhysicalRecordingDispositionResult>(), read = deferred<{ record: c.RecordingRecordDetail | null }>(); f.api.applyPhysicalRecordingDisposition = () => write.promise; f.api.getRecordingRecord = () => read.promise
  const applying = f.ctl.apply(), selecting = f.ctl.select(id(50)); write.resolve(applied()); await applying; read.resolve({ record: f.detail }); await selecting
  assert.notEqual(f.ctl.state.current?.revision, 1); assert.notEqual(f.ctl.state.detail?.current.revision, 1)
})

test('真实SFC未确认处置后搜索无current，仍可停止本地重试并关闭', async t => {
  const f = fixture(); f.api.applyPhysicalRecordingDisposition = async () => { throw new Error('回执丢失') }
  const p = await mounted(t, f.api, { physicalId: 'MB-C-00001' }); await p.field('处置方式', 'mark-content-unknown'); await p.click('预览处置'); await p.confirm(); await p.click('确认应用处置')
  assert.equal(p.button('关闭录音档案').props.disabled, true)
  const form = p.all().find(n => n.tag === 'form' && p.text(n).includes('搜索录音档案')); assert.ok(form); await (form.props.onSubmit as (event: unknown) => unknown)({ preventDefault() {} }); await p.tick()
  assert.ok(p.button('停止重试并重新读取')); await p.click('停止重试并重新读取'); assert.equal(p.button('关闭录音档案').props.disabled, false); await p.click('关闭录音档案'); assert.equal(p.closed(), 1)
})

function mediaPlan(): c.MediaPlan { const plan = planFixture().plan; return { id: id(7), draftId: id(1), draftRevision: 1, revision: 3, spec: plan.layout.spec, layout: { timebase: 'milliseconds', executionReady: false, constraints: [], sides: [{ name: 'A', tracks: [{ trackId: id(3), gapAfterMs: 0 }], durationMs: 1000, gapMs: 0, leadInMs: 0, tailMs: 0 }, { name: 'B', tracks: [], durationMs: 0, gapMs: 0, leadInMs: 0, tailMs: 0 }] }, sourceBasis: 'verified-sources', inputFingerprint: hash('a'), reservation: plan.layout.reservation, requiresReview: false, executionReady: false } }
test('五类处置均沿固定身份/CAS预览和人工确认，结果不创建Record', async () => {
  const cases: { intent: c.PhysicalRecordingDispositionIntent; effect: c.PhysicalRecordingDispositionEffect; before: c.PhysicalRecordingState; result: c.ApplyPhysicalRecordingDispositionResult }[] = []
  const unknown = applied(); cases.push({ intent: unknown.disposition.intent, effect: 'content-unknown', before: stateFixture(), result: unknown })
  const confirmed = applied(); confirmed.disposition.intent = { action: 'confirm-current-recording', recordingId: id(50) }; confirmed.state.knowledge = { state: 'confirmed-recording', recordingId: id(50), confirmedAt: end, evidence: { kind: 'manual-disposition', dispositionId: id(60) } }; cases.push({ intent: confirmed.disposition.intent, effect: 'content-confirmed', before: stateFixture(), result: confirmed })
  const erased = applied(); erased.disposition.intent = { action: 'confirm-erased' }; erased.state.knowledge = { state: 'erased', confirmedAt: end, dispositionId: id(60) }; cases.push({ intent: erased.disposition.intent, effect: 'erased-confirmed', before: stateFixture(), result: erased })
  const prepare = applied(); prepare.disposition.intent = { action: 'prepare-rerecord', mediaPlanId: id(7), expectedMediaPlanRevision: 2 }; prepare.disposition.permitId = id(61); prepare.disposition.afterPhysicalRevision = 4; prepare.state = { ...stateFixture(), revision: 2, physicalRevision: 4, activeRerecordPermit: permit() }; prepare.mediaPlan = mediaPlan(); cases.push({ intent: prepare.disposition.intent, effect: 'rerecord-reserved', before: stateFixture(), result: prepare })
  const cancel = applied(); cancel.disposition.intent = { action: 'cancel-rerecord', permitId: id(61) }; cancel.disposition.permitId = id(61); cancel.disposition.beforeContentRevision = 2; cancel.disposition.afterContentRevision = 3; cancel.disposition.beforePhysicalRevision = 4; cancel.disposition.afterPhysicalRevision = 5; cancel.state = { ...stateFixture(), revision: 3, physicalRevision: 5 }; const { reservation: _reservation, ...unreserved } = mediaPlan(); cancel.mediaPlan = { ...unreserved, revision: 4 }; cases.push({ intent: cancel.disposition.intent, effect: 'rerecord-cancelled', before: prepare.state, result: cancel })
  for (const item of cases) {
    assert.equal(c.isApplyPhysicalRecordingDispositionResult(item.result), true, item.intent.action)
    const f = await controller(); f.api.getPhysicalRecordingHistory = async request => ({ state: item.before, entries: { items: [], total: 0, hasMore: false, offset: request.page.offset, limit: 25 } }); await f.ctl.openPhysical('MB-C-00001')
    f.api.previewPhysicalRecordingDisposition = async request => ({ request, checkedAt: end, before: item.before, proposalFingerprint: hash('a'), effect: item.effect, outputWillStart: false })
    f.api.applyPhysicalRecordingDisposition = async request => { f.calls.push({ name: 'apply', request }); return item.result }
    await f.ctl.preview(item.intent); assert.ok(f.ctl.state.proposal, item.intent.action); await f.ctl.apply(); assert.equal(f.calls.some(x => x.name === 'apply'), false)
    f.ctl.setConfirmed(true); await f.ctl.apply(); assert.equal(f.ctl.state.current?.revision, item.result.state.revision); assert.equal(f.ctl.state.pending, undefined); assert.equal(f.ctl.state.detail, undefined)
  }
})
test('详情/视觉/预览/历史非法回执均失败关闭，不接受别的实体/附件/指纹意图', async () => {
  for (const patch of [{ attachmentId: id(99) }, { recordingId: id(99) }, { sha256: hash('b') }, { image: { dataUrl: 'https://example.invalid/photo', width: 1, height: 1 } }]) {
    const f = await controller(); f.detail.record.visuals.photos = { state: 'captured', attachments: [attachment()] }; await f.ctl.select(id(50)); const original = await f.api.getRecordingRecordVisual({ recordingId: id(50), attachmentId: id(70) }); f.api.getRecordingRecordVisual = async () => ({ ...original, ...patch }); await f.ctl.loadVisual(id(70)); assert.equal(f.ctl.state.visual, undefined); assert.equal(f.ctl.state.visualPhase, 'error')
  }
  const f = await controller(); await f.ctl.openPhysical('MB-C-00001'); f.api.previewPhysicalRecordingDisposition = async () => ({ ...proposal(), request: { ...previewRequest(), intent: { action: 'confirm-erased' } }, effect: 'erased-confirmed' }); await f.ctl.preview({ action: 'mark-content-unknown' }); assert.equal(f.ctl.state.proposal, undefined)
  f.api.getPhysicalRecordingHistory = async () => ({ state: { ...stateFixture(), physicalId: 'MB-C-00002' }, entries: { items: [], offset: 0, limit: 25, total: 0, hasMore: false } }); await f.ctl.history(); assert.equal(f.ctl.state.historyPhase, 'error'); assert.equal(f.ctl.canPreview(), false)
})
test('当前草稿候选只读取并明确选择，不自动重录/新建Plan，跨draft回执拒绝', async t => {
  const f = fixture(), api = Object.assign(f.api, { async listMediaPlans(draftId: string) { f.calls.push({ name: 'plans', request: draftId }); return { draftId, plans: [mediaPlan()] } } })
  const p = await mounted(t, api, { physicalId: 'MB-C-00001', draftId: id(1) }); await p.field('处置方式', 'prepare-rerecord'); assert.equal(f.calls.some(x => x.name === 'plans'), false)
  await p.click('读取目标介质计划'); assert.equal(p.button('预览处置').props.disabled, true); await p.field('目标介质计划', id(7)); assert.equal(p.button('预览处置').props.disabled, false); assert.equal(f.calls.some(x => x.name === 'apply'), false)
  const module = await import('../src/renderer/src/components/recording/recording-record-controller.js'); const ctl = module.createRecordingRecordController({ api: { ...api, async listMediaPlans() { return { draftId: id(90), plans: [mediaPlan()] } } }, draftId: id(1) }); await ctl.loadPlans(); assert.equal(ctl.state.plansPhase, 'error'); assert.equal(ctl.state.plans.length, 0)
})
test('历史分页严格25，读取失败/卸载使确认失效且不无限累积页面', async () => {
  const f = await controller(); f.api.getPhysicalRecordingHistory = async request => ({ state: stateFixture(), entries: { items: [], total: 26, offset: request.page.offset + 1, limit: 25, hasMore: true } })
  // 合同允许稀疏页，但回执必须对应明确请求的offset。
  await f.ctl.openPhysical('MB-C-00001'); assert.equal(f.ctl.state.historyPhase, 'error')
  const wait = deferred<c.RecordingRecordsPage>(); f.api.listRecordingRecords = () => wait.promise; const pending = f.ctl.refresh(); f.ctl.dispose(); wait.resolve({ items: [summary()], offset: 0, limit: 25, total: 1, hasMore: false }); await pending; assert.equal(f.ctl.state.page, undefined)
})
