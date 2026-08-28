<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { isCollectionId } from '@music-bridge/contracts'
import type { MasterDraft, VersionHistory, PreparationHistory, PreparationDestination, PreparedHistory, PreparedSelection, PreparedImportProposal, PreparedImportJob, PreparedReview, RenderMarker, RenderSide, ReviewPreparedRequest, StartPreparedImportRequest, FrozenPrepared } from '@music-bridge/contracts'
const props = defineProps<{ draft: MasterDraft; initialPreparationId?: string }>()
const emit = defineEmits<{ close: [] }>()
const api = window.musicBridge, dialog = ref<HTMLDialogElement>()
const versions = shallowRef<VersionHistory>(), preparations = shallowRef<PreparationHistory>(), history = shallowRef<PreparedHistory>()
const destinations = shallowRef<readonly PreparationDestination[]>([]), selections = shallowRef<readonly PreparedSelection[]>([])
const preparationId = ref(props.initialPreparationId ?? ''), destinationId = ref(''), selectedIds = ref<Record<string, string>>({}), importJobId = ref('')
const proposal = shallowRef<PreparedImportProposal>(), review = shallowRef<PreparedReview>(), importConfirmed = ref(false), freezeConfirmed = ref(false)
const loading = ref(false), busy = ref(false), phase = ref<'idle' | 'import' | 'review'>('idle'), error = ref(''), notice = ref('')
const pending = shallowRef<() => Promise<void>>(), pendingAbort = shallowRef<() => Promise<void>>(), aborting = ref(false)
const markers = ref<Record<string, RenderMarker[]>>({}), daw = ref('Logic Pro'), lineage = ref(''), acceptVariance = ref(false), varianceReason = ref(''), structureChanged = ref(false), contentChanged = ref(false)
const workspace = computed(() => preparations.value?.workspaces.find(w => w.id === preparationId.value))
const layout = computed(() => versions.value?.layouts.find(l => l.id === workspace.value?.layoutVersionId))
const master = computed(() => versions.value?.masters.find(m => m.id === workspace.value?.masterVersionId))
const destination = computed(() => destinations.value.find(d => d.id === destinationId.value))
const jobs = computed(() => history.value?.jobs.filter(j => j.preparationId === preparationId.value) ?? [])
const imported = computed(() => jobs.value.find(j => j.id === importJobId.value && j.state === 'completed'))
const running = computed(() => jobs.value.find(j => j.state === 'running'))
const blocked = computed(() => loading.value || busy.value || !!pending.value || !!pendingAbort.value || !!running.value)
const importReady = computed(() => !!layout.value && destination.value?.authorized && layout.value.timeline.sides.filter(s => s.tracks.length > 0).every(s => selections.value.some(x => x.id === selectedIds.value[s.name] && x.authorized)))
const freezeReady = computed(() => review.value && ['MATCHED','ACCEPTED_VARIANCE'].includes(review.value.conformance.status))
const size = (bytes: number): string => bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
const short = (id: string): string => id.slice(0, 8)
const failures = { SOURCE_INVALID: '所选原始 WAV 已变化或撤销授权。请重新选择。', DESTINATION_INVALID: '保存目标身份、归属或授权已失效。', IO_ERROR: '保存失败，请检查文件与目标目录。', DISK_FULL: '目标空间不足，原件不会被删除。', CANCELLED: '本次导入已取消。' }
const statusText = (j: PreparedImportJob): string => j.state === 'completed' ? '原始 Render 已独立保存，仍须逐曲确认实际时间线。' : j.state === 'running' ? `正在复制并复核原始 Render：${j.completedFiles} / ${j.totalFiles} 份` : j.state === 'interrupted' ? '任务已中断；未自动重放复制。请检查已有目录，再决定重新导入。' : j.failure ? failures[j.failure] : '导入未完成。'
const reasons: Record<string, string> = { INVALID_TIMELINE: '实际帧边界、顺序或 Gap 无效', RENDER_IDENTITY_MISMATCH: '时间线与保留的原始 Render 身份不符', MARKERS_UNCONFIRMED: '尚有曲目未人工确认', CONTENT_OR_ORDER_CHANGED: '曲目、Exact Source 或全局顺序改变，须新母版', SIDE_OR_STRUCTURE_CHANGED: '分面或 Lead-in / Tail 结构改变，须新布局', CAPACITY_EXCEEDED: '实际 Render 超出介质容量，须新布局', VARIANCE_NOT_ACCEPTED: '超出一 Render 帧容差，须明确接受并说明原因', TIMING_VARIANCE: '已明确接受时间差异，后续以实际 Render 时间线为准' }
let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
function invalidate(): void { review.value = undefined; freezeConfirmed.value = false }
watch([daw, lineage, acceptVariance, varianceReason, structureChanged, contentChanged], invalidate)
watch(markers, invalidate, { deep: true })
watch([destinationId, selectedIds], () => { proposal.value = undefined; importConfirmed.value = false }, { deep: true })
async function loadSelections(): Promise<void> {
  const id = preparationId.value; if (!id) return
  const result = await api.listPreparedSelections(id)
  if (!alive || id !== preparationId.value) return
  selections.value = result.selections
  for (const s of layout.value?.timeline.sides ?? []) if (!selectedIds.value[s.name]) selectedIds.value[s.name] = result.selections.find(x => x.side === s.name && x.authorized)?.id ?? ''
}
watch(preparationId, () => { ++generation; selectedIds.value = {}; selections.value = []; proposal.value = undefined; importConfirmed.value = false; importJobId.value = ''; markers.value = {}; invalidate(); void loadSelections().catch(() => { if (alive) error.value = '无法读取此工作区的文件选择，请刷新。' }) })
function initializeMarkers(): void {
  if (!imported.value?.assets || !layout.value || !master.value) return
  const result: Record<string, RenderMarker[]> = {}
  for (const side of layout.value.timeline.sides.filter(s => s.tracks.length > 0)) {
    const asset = imported.value.assets.find(a => a.side === side.name)!, plannedRate = BigInt(layout.value.timeline.sampleRate), renderRate = BigInt(asset.sampleRate)
    const convert = (n: number): number => Number((BigInt(n) * renderRate * 2n + plannedRate) / (plannedRate * 2n))
    result[side.name] = side.tracks.map(t => ({ trackId: t.trackId, exactSourceSha256: master.value!.content.tracks.find(m => m.trackId === t.trackId)!.source.sha256, actualStartFrame: convert(t.startFrame), actualEndFrame: convert(t.endFrame), actualGapToNextFrames: convert(t.gapAfterFrames), confirmationMethod: 'automatic-candidate', userConfirmed: false }))
  }
  markers.value = result; invalidate()
}
watch(importJobId, initializeMarkers)
async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true
  try {
    const [v, p, h, d] = await Promise.all([api.listMasterVersions(props.draft.id), api.listPreparations(props.draft.id), api.listPrepared(props.draft.id), api.listPreparationDestinations()])
    if (!alive) return
    versions.value = v; preparations.value = p; history.value = h; destinations.value = d.destinations
    if (!preparationId.value) preparationId.value = p.workspaces[0]?.id ?? ''
    if (!destinationId.value) destinationId.value = d.destinations.find(x => x.authorized)?.id ?? ''
    await loadSelections()
    if (!alive) return
    if (!importJobId.value) importJobId.value = h.jobs.find(j => j.preparationId === preparationId.value && j.state === 'completed')?.id ?? ''
    if (timer) clearTimeout(timer)
    if (h.jobs.some(j => j.state === 'running')) timer = setTimeout(() => { void refresh() }, 700)
  } catch { if (alive) error.value = 'PREP 状态暂时无法读取，已有历史不会被清空。请刷新。' }
  finally { if (alive && initial) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try { await pending.value(); if (alive) { pending.value = undefined; proposal.value = undefined; importConfirmed.value = false; invalidate(); await refresh() } }
  catch (cause) { if (alive) {
    if (/\[(INVALID_IPC_REQUEST|INVENTORY_CONFLICT|BAD_REQUEST)\]/u.test(cause instanceof Error ? cause.message : '')) { pending.value = undefined; proposal.value = undefined; invalidate(); error.value = '请求未接受。请重新核对文件、授权、实际 Marker 与版本。' }
    else error.value = '操作回执尚未确认。请重试原操作，不会重复保存或冻结。'
  } }
  finally { if (alive) { busy.value = false; phase.value = 'idle' } }
}
function mutate(operation: () => Promise<void>): void { if (busy.value || pending.value || pendingAbort.value) return; pending.value = operation; void retry() }
function choose(side: RenderSide): void {
  if (blocked.value || !workspace.value) return
  const request = { commandId: crypto.randomUUID(), preparationId: preparationId.value, side }
  mutate(async () => { const selected = await api.choosePreparedRender(request); if (alive) { if (selected) selectedIds.value[side] = selected.id; notice.value = selected ? '原始文件已选择；确认保存前不会复制。' : '已取消文件选择。' } })
}
function chooseDestination(): void { if (blocked.value) return; const id = crypto.randomUUID(); mutate(async () => { const d = await api.choosePreparationDestination(id); if (alive && d) destinationId.value = d.id }) }
function revokeSelection(id: string): void { const request = { commandId: crypto.randomUUID(), id }; mutate(async () => { await api.revokePreparedSelection(request); if (alive) notice.value = '文件读取授权已撤销，已保存的独立原始副本不会删除。' }) }
async function previewImport(): Promise<void> {
  if (blocked.value || !importReady.value) return
  const token = ++generation; loading.value = true; phase.value = 'import'; error.value = ''; proposal.value = undefined; importConfirmed.value = false
  try { const p = await api.previewPreparedImport({ preparationId: preparationId.value, destinationId: destinationId.value, selectionIds: layout.value!.timeline.sides.filter(s => s.tracks.length > 0).map(s => selectedIds.value[s.name]!) }); if (alive && generation === token) proposal.value = p }
  catch { if (alive) error.value = '无法核对原始 Render。请重新选择未改变的 WAV，并检查目标授权。' }
  finally { if (alive) { loading.value = false; phase.value = 'idle' } }
}
function startImport(): void {
  if (blocked.value || !proposal.value || !importConfirmed.value) return
  const p = proposal.value, request: StartPreparedImportRequest = { commandId: crypto.randomUUID(), preparationId: p.preparationId, destinationId: p.destinationId, selectionIds: [...p.selectionIds], proposalFingerprint: p.proposalFingerprint, userConfirmed: true }
  phase.value = 'import'; mutate(async () => { const job = await api.startPreparedImport(request); if (alive) notice.value = statusText(job) })
}
function cancelImport(): void { if (!running.value) return; const request = { commandId: crypto.randomUUID(), id: running.value.id }; mutate(async () => { const job = await api.cancelPreparedImport(request); if (alive) notice.value = statusText(job) }) }
function edited(marker: RenderMarker): void { marker.userConfirmed = false; marker.confirmationMethod = 'automatic-candidate'; invalidate() }
function confirmMarker(marker: RenderMarker): void { marker.confirmationMethod = marker.userConfirmed ? 'manual' : 'automatic-candidate'; invalidate() }
function makeReviewRequest(): ReviewPreparedRequest {
  const assets = imported.value!.assets!
  return JSON.parse(JSON.stringify({ importJobId: imported.value!.id, daw: daw.value.trim(), processingLineage: lineage.value.trim(), assessment: { contentIdentityChanged: contentChanged.value, structureChanged: structureChanged.value, acceptVariance: acceptVariance.value, varianceReason: varianceReason.value.trim(), timeline: { timebase: 'sample-frames', sides: layout.value!.timeline.sides.map(side => { const a = assets.find(a => a.side === side.name); if (!a) return { name: side.name, renderAssetId: null, renderFileHash: null, sampleRate: layout.value!.timeline.sampleRate, channelLayout: 'none', totalFrames: 0, markers: [] }; return { name: a.side, renderAssetId: a.id, renderFileHash: a.sha256, sampleRate: a.sampleRate, channelLayout: a.channelLayout, totalFrames: a.totalFrames, markers: (markers.value[a.side] ?? []).map((m, i, all) => ({ ...m, actualGapToNextFrames: all[i + 1] ? all[i + 1]!.actualStartFrame - m.actualEndFrame : 0 })) } }) } } })) as ReviewPreparedRequest
}
async function assess(): Promise<void> {
  if (blocked.value || !imported.value || !lineage.value.trim() || !daw.value.trim()) return
  loading.value = true; phase.value = 'review'; error.value = ''; invalidate()
  try { const result = await api.reviewPrepared(makeReviewRequest()); if (alive) review.value = result }
  catch { if (alive) error.value = '无法生成报告。请检查所有帧数是文件范围内的整数、曲目没有重叠，且保留原件和目标授权仍可用。' }
  finally { if (alive) { loading.value = false; phase.value = 'idle' } }
}
function freeze(): void {
  if (blocked.value || !freezeReady.value || !freezeConfirmed.value) return
  const request = { ...makeReviewRequest(), commandId: crypto.randomUUID(), proposalFingerprint: review.value!.proposalFingerprint, userConfirmed: true as const }
  phase.value = 'review'; mutate(async () => { const prep = await api.freezePrepared(request); if (alive) notice.value = `PREP ${prep.sequence} 已冻结。此状态不代表获得正式录音许可。` })
}
async function stopChecks(): Promise<void> {
  if (!alive || aborting.value) return
  if (!pendingAbort.value) {
    if (phase.value === 'import') {
      const selected = Object.entries(selectedIds.value).filter(([, id]) => id !== '')
      if (selected.length < 1 || selected.length > 3
        || selected.some(([side, id]) => !['A', 'B', 'Program'].includes(side) || !isCollectionId(id))
        || new Set(selected.map(([, id]) => id)).size !== selected.length) {
        error.value = '文件授权选择无效，请刷新并核对最多三份不同的原始 Render。'
        return
      }
      const requests = Object.freeze(selected.map(([, id]) => Object.freeze({ commandId: crypto.randomUUID(), id })))
      pendingAbort.value = async () => { await api.revokePreparedSelections(requests) }
    }
    else if (phase.value === 'review' && imported.value) { const r = { commandId: crypto.randomUUID(), id: imported.value.destinationId }; pendingAbort.value = async () => { await api.revokePreparationDestination(r) } }
    else return
  }
  aborting.value = true; error.value = ''
  try { await pendingAbort.value(); if (alive) { pendingAbort.value = undefined; notice.value = '相关授权已撤销，核对停止；已有文件和历史不会删除。'; await refresh() } }
  catch { if (alive) error.value = '撤权回执尚未确认，请重试原撤权操作。' }
  finally { if (alive) aborting.value = false }
}
const compatibility = (prep: FrozenPrepared): string => { const current = versions.value?.layouts[0]; return current?.masterVersionId !== prep.masterVersionId ? '与当前冻结母版不同' : current.id !== prep.layoutVersionId ? '与当前冻结布局不同' : '与当前冻结版本兼容' }
const percent = (value: number, total: number): number => Number.isFinite(value) ? Math.max(0, Math.min(100, value / total * 100)) : 0
function close(): void { if (!busy.value && !pending.value && !pendingAbort.value) { dialog.value?.close(); emit('close') } }
onMounted(async () => { await nextTick(); dialog.value?.showModal(); void refresh(true) })
onBeforeUnmount(() => { alive = false; ++generation; if (timer) clearTimeout(timer); dialog.value?.close() })
</script>
<template>
  <dialog ref="dialog" class="prepared-panel" aria-labelledby="prepared-title" @cancel.prevent="close">
    <header><div><p class="kicker">录音准备 · 05</p><h2 id="prepared-title">原始 Render 与 PREP</h2><p class="muted">{{ draft.title }}</p></div><button :disabled="busy || !!pending || !!pendingAbort" @click="close">关闭</button></header>
    <p class="intro">把 Logic 最终 WAV 保存为独立原件，再逐曲确认实际帧边界。文件名、总时长和工作区导出记录都不能证明曲目内容正确。</p>
    <section aria-label="原始 Render 导入">
      <h3>选择工作区与原始 WAV</h3>
      <div class="fields"><label>已完成的 Logic 工作区<select v-model="preparationId" :disabled="blocked"><option value="">请先生成 Logic 工作区</option><option v-for="w in preparations?.workspaces" :key="w.id" :value="w.id">L{{ versions?.layouts.find(l => l.id === w.layoutVersionId)?.sequence }} · {{ short(w.id) }}</option></select></label><label>原始 Render 保存目标<select v-model="destinationId" :disabled="blocked"><option value="">请选择保存目标</option><option v-for="d in destinations" :key="d.id" :value="d.id">{{ d.label }} · {{ short(d.id) }}{{ d.authorized ? '' : ' · 已撤权' }}</option></select></label></div>
      <div class="actions"><button :disabled="blocked" @click="chooseDestination">选择保存目标</button></div>
      <p v-if="layout && master" class="muted">母版 M{{ master.sequence }} · 布局 L{{ layout.sequence }} · {{ layout.spec.format === 'cassette' ? 'A / B 两面' : 'DAT 连续 Program' }}</p>
      <article v-for="side in layout?.timeline.sides.filter(s => s.tracks.length > 0)" :key="side.name" class="file-row"><div><strong>{{ side.name }} 面</strong><p class="muted">{{ selections.find(s => s.id === selectedIds[side.name])?.label ?? '尚未选择原始 WAV' }}</p></div><div class="actions"><button :disabled="blocked" @click="choose(side.name)">选择 {{ side.name }} 面 WAV</button><button v-if="selectedIds[side.name] && selections.some(s => s.id === selectedIds[side.name] && s.authorized)" :disabled="busy || !!pending" @click="revokeSelection(selectedIds[side.name]!)">撤销 {{ side.name }} 面授权</button></div></article>
      <p v-if="layout?.timeline.sides.some(s => !s.tracks.length)" class="muted">B 面没有内容，将保留零帧空面事实，不要求或生成占位 WAV。</p>
      <p class="muted">只读取你选择的文件，不扫描其所在目录。仅接受有完整帧数证据的单声道或立体声 WAV。</p>
      <button class="primary" :disabled="blocked || !importReady" @click="previewImport">核对原始 Render</button>
      <div v-if="proposal" class="proposal"><h3>确认独立保存原始 Render</h3><p>目标：{{ proposal.destinationLabel }} · 音频 {{ size(proposal.bytes) }}，另需少量清单空间。</p><p>将在目标内新建独占的 MusicBridge-OriginalRender-* 目录。原始 Render 与可编辑工作副本、未来执行派生文件分开保存，不覆盖已有文件，不自动清理。</p><ul><li v-for="a in proposal.assets" :key="a.id">{{ a.side }} · WAV · {{ a.sampleRate }} Hz · {{ a.channelLayout === 'stereo' ? '立体声' : '单声道' }} · {{ a.totalFrames.toLocaleString() }} 帧</li></ul><label class="check"><input v-model="importConfirmed" type="checkbox" :disabled="blocked">我确认在所选目标保存独立原始 Render；不覆盖源文件，也不作为执行派生文件</label><button class="primary" :disabled="blocked || !importConfirmed" @click="startImport">确认保存原始 Render</button></div>
    </section>
    <section v-if="running" aria-label="Render 后台导入"><h3>正在保存原始 Render</h3><progress :value="running.completedFiles" :max="running.totalFiles" aria-label="原始 Render 保存进度" /><p>{{ statusText(running) }}</p><p class="muted">关闭面板后任务继续。未完成复制在重启后不会自动重放。</p><button :disabled="busy || !!pending" @click="cancelImport">取消本次导入</button></section>
    <p v-if="loading || busy" role="status">{{ phase === 'idle' ? '正在读取状态或等待操作回执…' : '正在读取完整文件并核对 Hash，耗时取决于大小与设备速度…' }}</p>
    <div v-if="phase !== 'idle' || pendingAbort" class="actions"><button :disabled="aborting" @click="stopChecks">{{ pendingAbort ? '重试原撤权操作' : phase === 'import' ? '停止核对并撤销文件授权' : '停止核对并撤销保存目标授权' }}</button></div>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p><p v-if="error" role="alert" class="warning">{{ error }} <button v-if="pending" :disabled="busy" @click="retry">重试原操作</button><button v-else :disabled="busy || loading" @click="error = ''; refresh(true)">刷新 PREP</button></p>
    <section v-if="jobs.some(j => j.state === 'completed')" aria-label="实际 Render 时间线">
      <h3>确认实际曲目标记</h3><label>已保存的原始 Render<select v-model="importJobId" :disabled="blocked"><option v-for="j in jobs.filter(j => j.state === 'completed')" :key="j.id" :value="j.id">{{ short(j.id) }} · {{ j.totalFiles }} 份原始 WAV</option></select></label>
      <p class="muted">请在 Logic 中聆听最终 WAV，并在下方实际时间线上校正每曲的开始、结束帧。初始数值只是计划候选；修改后须再次确认。结束帧不包含在该曲范围内，Gap 由相邻边界计算。</p>
      <article v-for="asset in imported?.assets" :key="asset.id" class="side"><h4>{{ asset.side }} 面 · {{ asset.sampleRate }} Hz · {{ asset.totalFrames.toLocaleString() }} 帧</h4><div class="timeline" role="img" :aria-label="`${asset.side} 面实际曲目标记时间线，尚须人工确认`"><span v-for="(m, i) in markers[asset.side]" :key="m.trackId" :style="{ left: percent(m.actualStartFrame, asset.totalFrames) + '%', width: Math.max(0, percent(m.actualEndFrame, asset.totalFrames) - percent(m.actualStartFrame, asset.totalFrames)) + '%' }">{{ i + 1 }}</span></div>
        <div v-for="(m, i) in markers[asset.side]" :key="m.trackId" class="marker"><h5>{{ i + 1 }}. {{ master?.content.tracks.find(t => t.trackId === m.trackId)?.metadata.title }}</h5><p class="muted">计划：{{ layout?.timeline.sides.find(s => s.name === asset.side)?.tracks[i]?.startFrame }} – {{ layout?.timeline.sides.find(s => s.name === asset.side)?.tracks[i]?.endFrame }} 帧（{{ layout?.timeline.sampleRate }} Hz）</p><div class="fields"><label>实际开始帧<input v-model.number="m.actualStartFrame" type="number" min="0" :max="asset.totalFrames" step="1" :aria-label="`${asset.side} 面第 ${i + 1} 曲实际开始帧`" :disabled="blocked" @input="edited(m)"></label><label>实际结束帧<input v-model.number="m.actualEndFrame" type="number" min="1" :max="asset.totalFrames" step="1" :aria-label="`${asset.side} 面第 ${i + 1} 曲实际结束帧`" :disabled="blocked" @input="edited(m)"></label></div><p class="muted">至下一曲 Gap：{{ markers[asset.side]?.[i + 1] ? markers[asset.side]![i + 1]!.actualStartFrame - m.actualEndFrame : 0 }} 帧</p><label class="check"><input v-model="m.userConfirmed" type="checkbox" :disabled="blocked" @change="confirmMarker(m)">我已核对本曲、Exact Source 和实际帧边界（{{ asset.side }}-{{ i + 1 }}）</label><details><summary>Exact Source SHA-256</summary><code>{{ m.exactSourceSha256 }}</code></details></div>
      </article>
      <div class="fields"><label>DAW<input v-model="daw" maxlength="240" aria-label="DAW" :disabled="blocked"></label><label>处理谱系<input v-model="lineage" maxlength="240" aria-label="处理谱系" placeholder="记录剪辑、Fade、处理及人工确认方式" :disabled="blocked"></label></div>
      <label class="check"><input v-model="contentChanged" type="checkbox" :disabled="blocked">实际曲目、Exact Source 或全局曲序已改变（需要新母版）</label><label class="check"><input v-model="structureChanged" type="checkbox" :disabled="blocked">实际分面或 Lead-in / Tail 结构已改变（需要新布局）</label>
      <label class="check"><input v-model="acceptVariance" type="checkbox" :disabled="blocked">我明确接受保持曲目、源、曲序和分面的时间差异</label><label>差异原因<input v-model="varianceReason" maxlength="240" aria-label="差异原因" :disabled="blocked || !acceptVariance"></label>
      <p class="muted">MATCHED 容差：每个边界最多一 Render 帧，策略 one-render-frame-v1。容量边界不放宽。接受时间差异不能覆盖换曲、换源、换面或超容量。</p><button class="primary" :disabled="blocked || !imported || !daw.trim() || !lineage.trim()" @click="assess">生成 Conformance 报告</button>
      <div v-if="review" class="proposal"><h3 data-testid="conformance-status">{{ review.conformance.status }}</h3><p v-if="!review.conformance.reasons.length">逐曲身份、顺序、分面与帧边界符合当前策略，仍须最终确认。</p><ul v-else><li v-for="reason in review.conformance.reasons" :key="reason">{{ reasons[reason] }}</li></ul><template v-if="freezeReady"><label class="check"><input v-model="freezeConfirmed" type="checkbox" :disabled="blocked">我确认上述实际时间线，并冻结到此母版与布局；后续不得再次插入 Gap</label><button class="primary" :disabled="blocked || !freezeConfirmed" @click="freeze">冻结 PREP</button></template></div>
    </section>
    <section aria-label="PREP 历史"><h3>Frozen PREP 历史</h3><p v-if="history && !history.preps.length" class="muted">尚无 PREP。保存原始 Render 后，仍需人工确认实际时间线。</p><article v-for="prep in history?.preps" :key="prep.id" class="prep-history"><h4>PREP {{ prep.sequence }}</h4><p>始终适用于 M{{ versions?.masters.find(m => m.id === prep.masterVersionId)?.sequence }} / L{{ versions?.layouts.find(l => l.id === prep.layoutVersionId)?.sequence }} · {{ compatibility(prep) }}</p><p>{{ prep.conformance.status }} · {{ new Date(prep.createdAt).toLocaleString() }}</p><p class="muted">{{ prep.daw }} · {{ prep.processingLineage }}</p><p class="muted">Baked Into Render：实际时间线已包含间隔，后续不能再次插入 Gap。正式执行资产和录音许可仍待后续 Gate。</p><details><summary>查看不可变身份与原始 Render</summary><code>PREP {{ prep.id }}</code><code>Master {{ prep.masterVersionId }} / Layout {{ prep.layoutVersionId }}</code><code>Planned Timeline {{ prep.plannedTimelineHash }}</code><code>Render Timeline {{ prep.renderTimelineHash }}</code><div v-for="a in prep.assets" :key="a.id"><p>{{ a.side }} · {{ a.sampleRate }} Hz · {{ a.totalFrames }} 帧 · {{ a.channelLayout }} · {{ size(a.size) }}</p><code>SHA-256 {{ a.sha256 }}</code><p class="muted">{{ a.creationTimeEvidence === 'filesystem-birthtime' ? '文件系统创建时间' : '首次观察时间（文件系统未提供创建时间）' }}：{{ new Date(a.createdAt).toLocaleString() }}</p></div></details></article><details v-if="history?.jobs.length"><summary>导入任务记录（{{ history.jobs.length }}）</summary><p v-for="j in history.jobs" :key="j.id">{{ short(j.id) }} · {{ statusText(j) }}</p></details></section>
    <footer>不自动控制 Logic，不生成 Execution Derivative。失败或取消可能留下不完整目录，目录存在不代表保存成功；系统不会擅自清理。旧 PREP 对原版本继续有效，不随新布局全局失效。</footer>
  </dialog>
</template>
<style scoped>
.prepared-panel{box-sizing:border-box;width:min(960px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:28px;border:1px solid var(--mb-glass-border);border-radius:18px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;overflow:auto;overscroll-behavior:contain}.prepared-panel::backdrop{background:rgb(0 0 0 / .6)}header,.file-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.kicker{font-size:11px;letter-spacing:2px;color:var(--mb-text-secondary);margin:0 0 10px}h2{font-size:24px;margin:0}h3{font-size:18px;margin:0 0 16px}h4{font-size:16px;margin:0 0 12px}h5{font-size:14px;margin:0}p,li{font-size:13px;line-height:1.75;overflow-wrap:anywhere}.intro,.muted,footer{color:var(--mb-text-secondary)}section{border-top:1px solid var(--mb-divider);margin-top:24px;padding-top:24px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.6}select,input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;min-height:44px;padding:8px 10px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit}button{min-height:44px;padding:9px 15px;border:1px solid var(--mb-glass-border);border-radius:9px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:active:not(:disabled){background:var(--mb-bg-elevated)}button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}.primary{border-color:var(--mb-accent);color:var(--mb-accent)}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.proposal{padding:20px;margin-top:20px;border:1px solid var(--mb-glass-border);border-radius:12px}.check{flex-direction:row;align-items:center;min-height:44px;margin:16px 0}input[type=checkbox]{accent-color:var(--mb-accent);width:16px;height:16px;flex-shrink:0}.file-row,.prep-history{border-bottom:1px solid var(--mb-divider);padding:20px 0;min-width:0}.file-row>div{min-width:0}.file-row .actions{margin-top:0}.warning{padding:12px;border-left:3px solid var(--mb-accent)}.notice{font-weight:600;padding:12px 0}progress{width:100%;height:8px;accent-color:var(--mb-accent)}summary{min-height:44px;padding:12px 0;box-sizing:border-box;cursor:pointer;font-size:13px}code{display:block;font-size:12px;line-height:1.7;overflow-wrap:anywhere;color:var(--mb-text-secondary);margin-top:8px}.side{margin:24px 0;padding:20px;border:1px solid var(--mb-glass-border);border-radius:12px}.marker{padding:18px 0;border-bottom:1px solid var(--mb-divider)}.marker:last-child{border-bottom:0;padding-bottom:0}.timeline{position:relative;height:26px;border-radius:4px;overflow:hidden;background:var(--mb-bg-elevated);border:1px solid var(--mb-glass-border)}.timeline span{position:absolute;top:0;bottom:0;background:var(--mb-accent);color:var(--mb-bg-base);font-size:12px;line-height:26px;text-align:center;min-width:1px}footer{font-size:12px;line-height:1.8;margin-top:24px}@media(hover:hover) and (pointer:fine){button:hover:not(:disabled){border-color:var(--mb-accent)}}@media(max-width:760px){.prepared-panel{padding:20px}.fields{grid-template-columns:1fr}.file-row{flex-direction:column}h2{font-size:20px}.proposal,.side{padding:16px}}
</style>
