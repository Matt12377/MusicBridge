<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { DraftSourceSnapshot, SourceRoot, SourceAcquisition, SourceFailure, SourceCandidateScan, SourceCandidateStopReason } from '@music-bridge/contracts'
const props = defineProps<{ draftId: string; draftRevision: number; trackId: string; title: string; inline?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const api = window.musicBridge, dialog = ref<HTMLDialogElement>()
const LocalLegacyLinksPanel = defineAsyncComponent(() => import('../legacy/LocalLegacyLinksPanel.vue'))
const localLinksReady = computed(() => ['readLocalLegacyLinks', 'historyLocalLegacyLinks', 'previewLocalLegacyLink', 'confirmLocalLegacyLink', 'revokeLocalLegacyLink', 'undoLocalLegacyLink'].every(name => typeof (api as unknown as Record<string, unknown>)[name] === 'function'))
const roots = shallowRef<readonly SourceRoot[]>([]), snapshot = shallowRef<DraftSourceSnapshot>()
const rootId = ref(''), acquisition = ref<SourceAcquisition>('userFileBind'), confirmed = ref(false), busy = ref(false), error = ref(''), revokeId = ref('')
const scan = shallowRef<SourceCandidateScan>(), selectedCandidateId = ref(''), candidatePage = ref(0)
const pending = shallowRef<() => Promise<unknown>>()
const track = computed(() => snapshot.value?.tracks.find(t => t.trackId === props.trackId))
const binding = computed(() => track.value?.binding)
const running = computed(() => track.value?.jobs.some(job => job.state === 'running') === true)
const scanMatches = computed(() => scan.value?.rootId === rootId.value && scan.value?.draftId === props.draftId && scan.value?.trackId === props.trackId && scan.value?.expectedDraftRevision === props.draftRevision)
const scanSelectable = computed(() => scanMatches.value && (scan.value?.state === 'completed' || scan.value?.state === 'truncated'))
const candidatePages = computed(() => Math.max(1, Math.ceil((scan.value?.candidates.length ?? 0) / 20)))
const visibleCandidates = computed(() => scan.value?.candidates.slice(candidatePage.value * 20, (candidatePage.value + 1) * 20) ?? [])
const blocked = computed(() => busy.value || !!pending.value)
const availability = { ONLINE: '文件在线', SOURCE_ROOT_OFFLINE: '源目录离线', MISSING: '文件丢失', CONTENT_CHANGED: '内容已变化，旧校验失效', REVOKED: '目录授权已撤销' }
const states = { running: '正在只读校验', completed: '校验完成', failed: '校验失败', cancelled: '已取消', interrupted: '重启中断，请重新选择文件' }
const failures: Record<SourceFailure, string> = { SOURCE_ROOT_OFFLINE: '源目录离线', MISSING: '文件丢失', CONTENT_CHANGED: '读取期间或校验后文件已变化', REVOKED: '目录授权已撤销', OUTSIDE_ROOT: '路径越界或包含符号链接', UNSUPPORTED: '格式或技术参数暂不支持', LIMIT_EXCEEDED: '文件或读取时间超过限制', IO_ERROR: '文件读取或保存失败', CANCELLED: '用户取消', DRAFT_CHANGED: '草稿曲目或绑定已改变', HASH_MISMATCH: '文件 Hash 不同，不能作为原内容重新定位', CANDIDATE_CHANGED: '候选文件与扫描时不同，未建立绑定' }
const scanReasons: Record<SourceCandidateStopReason, string> = { ENTRY_LIMIT: '已达 3000 项读取上限', DEPTH_LIMIT: '已达 6 层目录上限', RESULT_LIMIT: '已达 200 个候选上限', TIME_LIMIT: '已达 5 秒扫描上限', IO_ERROR: '部分目录不可读取', ROOT_CHANGED: '源目录身份或授权已变化', DRAFT_CHANGED: '草稿修订或曲目已变化' }
let alive = true, timer: ReturnType<typeof setTimeout> | undefined, reading = false
async function refresh(): Promise<void> {
  if (reading || !alive) return
  reading = true
  try {
    const [nextRoots, nextSnapshot] = await Promise.all([api.listRecordingSourceRoots(), api.getDraftSources(props.draftId)])
    if (!alive) return
    const previous = binding.value
    roots.value = nextRoots.roots; snapshot.value = nextSnapshot
    if (!roots.value.some(root => root.id === rootId.value && root.availability === 'ONLINE')) rootId.value = roots.value.find(root => root.availability === 'ONLINE')?.id ?? ''
    if (previous?.id !== binding.value?.id || binding.value?.availability !== 'ONLINE') confirmed.value = false
  } catch { if (alive) error.value = '源资料暂时无法读取。原文件和已存证据不会被清空。' }
  finally { reading = false }
}
async function refreshScan(): Promise<void> {
  const id = scan.value?.id
  if (!id || !alive) return
  try {
    const result = await api.getRecordingSourceCandidateScan(id)
    if (!alive || scan.value?.id !== id) return
    if (result.scan) scan.value = result.scan
    else { scan.value = undefined; selectedCandidateId.value = ''; error.value = '候选扫描会话已过期或随应用重启失效，请重新扫描。已接受的完整校验可在下方记录中核对。' }
    if (candidatePage.value >= candidatePages.value) candidatePage.value = candidatePages.value - 1
  } catch { /* 保留上次扫描快照；下一轮继续查回执。 */ }
}
async function poll(): Promise<void> { await refresh(); await refreshScan(); if (alive) timer = setTimeout(() => { void poll() }, running.value || scan.value?.state === 'running' ? 800 : 3000) }
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try { await pending.value(); if (alive) { pending.value = undefined; confirmed.value = false; await refresh() } }
  catch (cause) {
    if (alive) {
      if (/\[(INVALID_IPC_REQUEST|INVENTORY_CONFLICT|NOT_READY)\]/u.test(cause instanceof Error ? cause.message : '')) { pending.value = undefined; error.value = '操作未接受，请检查目录、文件及草稿后重新选择。' }
      else error.value = '回执尚未确认。可重试原操作，或关闭后查看已保存的任务状态。'
    }
  } finally { if (alive) busy.value = false }
}
function mutate(operation: () => Promise<unknown>): void { if (blocked.value) return; pending.value = operation; void retry() }
function authorize(): void { const id = crypto.randomUUID(); mutate(() => api.chooseRecordingSourceRoot(id)) }
function choose(relocate = false): void {
  if (!rootId.value || running.value) return
  const request = { commandId: crypto.randomUUID(), draftId: props.draftId, trackId: props.trackId, rootId: rootId.value, acquisition: acquisition.value, ...(relocate && binding.value ? { relocateBindingId: binding.value.id } : {}) }
  mutate(() => api.chooseRecordingSource(request))
}
function startCandidateScan(): void {
  if (!rootId.value || blocked.value || running.value) return
  const request = { commandId: crypto.randomUUID(), rootId: rootId.value, draftId: props.draftId, trackId: props.trackId, expectedDraftRevision: props.draftRevision }
  selectedCandidateId.value = ''; candidatePage.value = 0
  mutate(async () => { const result = await api.startRecordingSourceCandidateScan(request); if (alive) scan.value = result; return result })
}
function cancelCandidateScan(): void {
  if (scan.value?.state !== 'running') return
  const request = { commandId: crypto.randomUUID(), id: scan.value.id }
  mutate(async () => { const result = await api.cancelRecordingSourceCandidateScan(request); if (alive) scan.value = result; return result })
}
function chooseCandidate(): void {
  if (!scanSelectable.value || !selectedCandidateId.value || running.value) return
  const request = { commandId: crypto.randomUUID(), draftId: props.draftId, trackId: props.trackId, rootId: rootId.value, acquisition: acquisition.value,
    candidate: { scanId: scan.value!.id, candidateId: selectedCandidateId.value, expectedDraftRevision: props.draftRevision } }
  mutate(() => api.selectRecordingSourceCandidate(request))
}
function confirm(): void {
  if (!confirmed.value || !binding.value) return
  const request = { commandId: crypto.randomUUID(), id: binding.value.id, draftId: props.draftId, trackId: props.trackId, userConfirmed: true as const }
  mutate(() => api.confirmRecordingSource(request))
}
function recheck(): void {
  if (!binding.value) return
  const request = { commandId: crypto.randomUUID(), id: binding.value.id, draftId: props.draftId, trackId: props.trackId, userConfirmed: true as const }
  mutate(() => api.recheckRecordingSource(request))
}
function revoke(): void { const request = { commandId: crypto.randomUUID(), id: revokeId.value }; mutate(() => api.revokeRecordingSourceRoot(request)); revokeId.value = '' }
function cancel(id: string): void { const request = { commandId: crypto.randomUUID(), id }; mutate(() => api.cancelRecordingSourceJob(request)) }
function close(): void { if (!busy.value) { if (!props.inline) dialog.value?.close(); emit('close') } }
onMounted(async () => { await nextTick(); if (!props.inline) dialog.value?.showModal(); void poll() })
onBeforeUnmount(() => { alive = false; if (timer) clearTimeout(timer); if (!props.inline) dialog.value?.close() })
</script>

<template>
  <component :is="inline ? 'section' : 'dialog'" ref="dialog" class="source-panel" :class="{ 'is-inline': inline }" aria-labelledby="source-panel-title" @cancel.prevent="close">
    <header><div><p class="kicker">只读源验证</p><h2 id="source-panel-title">实际源文件</h2><p>{{ title }}</p></div><button :disabled="busy" @click="close">关闭</button></header>
    <p class="intro">Roon 信息用于选曲，不代表已取得音频。只读取你明确授权目录中的文件，不改写原件。</p>
    <section aria-labelledby="source-roots-heading"><div class="section-heading"><h3 id="source-roots-heading">源目录</h3><button :disabled="blocked" @click="authorize">授权一个源目录</button></div>
      <p v-if="!roots.length" class="muted">尚未授权任何目录。不会自动扫描音乐库。</p>
      <ul class="root-list"><li v-for="root in roots" :key="root.id"><div><strong>{{ root.label }}</strong><small>{{ availability[root.availability] }}</small></div><button v-if="root.authorized" :disabled="blocked" :aria-label="`撤销目录授权 ${root.label}`" @click="revokeId = root.id">撤销授权</button></li></ul>
      <div v-if="revokeId" class="confirmation"><p>撤销后停止该目录的校验。源文件、历史绑定和记录不会删除。</p><button :disabled="blocked" @click="revoke">确认撤销授权</button><button @click="revokeId = ''">保留授权</button></div>
      <fieldset :disabled="blocked || running"><legend class="visually-hidden">选择实际源文件</legend><div class="fields"><label>已授权源目录<select v-model="rootId"><option value="">请选择在线目录</option><option v-for="root in roots.filter(r => r.availability === 'ONLINE')" :key="root.id" :value="root.id">{{ root.label }}</option></select></label><label>文件取得方式<select v-model="acquisition"><option value="userFileBind">手动绑定本地文件</option><option value="roonDesktopExport">Roon 桌面导出后绑定</option></select></label></div>
      <p v-if="acquisition === 'roonDesktopExport'" class="muted">只校验这份导出文件，不证明它与 Roon 监视目录中的原件字节相同。</p>
      <div class="actions"><button :disabled="!rootId" @click="startCandidateScan">扫描此目录的候选文件</button><button :disabled="!rootId" @click="choose()">选择文件并校验</button><button v-if="binding" :disabled="!rootId" @click="choose(true)">重新定位相同内容</button></div></fieldset>
      <div v-if="scan" class="candidate-scan" aria-labelledby="candidate-scan-heading">
        <div class="section-heading"><h4 id="candidate-scan-heading">候选文件</h4><button v-if="scan.state === 'running'" :disabled="blocked" @click="cancelCandidateScan">取消扫描</button></div>
        <p v-if="scan.state === 'running'" role="status">正在只读列出文件名与大小，已查看 {{ scan.scannedEntries }} 项；还未校验任何音频内容。</p>
        <p v-else-if="scan.state === 'completed'" role="status">扫描完成，找到 {{ scan.candidates.length }} 个候选。候选只是文件线索，尚未完成 Hash、技术探测或曲目对应确认。</p>
        <p v-else-if="scan.state === 'truncated'" role="status">部分扫描：{{ scanReasons[scan.stopReason!] }}。以下 {{ scan.candidates.length }} 个候选仍可逐一选择；未列出的文件请手动选择或缩小目录后重扫。</p>
        <p v-else class="muted" role="status">{{ scan.state === 'cancelled' ? '扫描已取消，仅保留本次状态供回看。' : `扫描已失效：${scan.stopReason ? scanReasons[scan.stopReason] : '无法读取目录'}。` }}请重新扫描；旧候选不能继续选择。</p>
        <p v-if="!scanMatches" class="muted">此扫描不对应当前选择的目录或草稿修订，请重新扫描。</p>
        <template v-if="scanSelectable && scan.candidates.length">
          <ul class="candidate-list" aria-label="待人工比对的候选文件"><li v-for="candidate in visibleCandidates" :key="candidate.id"><label><input v-model="selectedCandidateId" type="radio" name="source-candidate" :value="candidate.id" :disabled="blocked || running"><span><strong>{{ candidate.relativeLabel }}</strong><small>{{ candidate.size.toLocaleString() }} 字节 · {{ new Date(candidate.modifiedAt).toLocaleString() }} · 编号 {{ candidate.id.slice(0, 8) }}</small></span></label></li></ul>
          <div v-if="candidatePages > 1" class="candidate-pagination"><button :disabled="candidatePage === 0" @click="candidatePage--">上一页</button><span>第 {{ candidatePage + 1 }} / {{ candidatePages }} 页</span><button :disabled="candidatePage + 1 >= candidatePages" @click="candidatePage++">下一页</button></div>
          <div class="actions"><button :disabled="blocked || running || !selectedCandidateId" @click="chooseCandidate">选择候选并开始完整校验</button></div>
          <p class="muted">请先比对文件名、路径线索、大小和时间。完整校验成功后仍须单独确认曲目对应；这里不会自动生成 Exact 或可冻结的源资格。</p>
        </template>
        <p v-else-if="scanSelectable" class="muted">此范围没有可列出的 WAV、FLAC 或 AIFF 候选，可继续手动选择文件。</p>
      </div>
      <p class="muted">当前支持 WAV、FLAC、AIFF 无损头部探测，最大 64 GiB、读取最长 15 分钟、头部最多 16 MiB。其他格式和 DSD 转换尚未支持；未进行逐帧解码验证。</p>
    </section>
    <section v-if="binding" class="evidence" aria-labelledby="source-binding-heading"><h3 id="source-binding-heading">文件证据</h3><strong>{{ binding.fileName }}</strong><p>{{ availability[binding.availability] }} · {{ binding.acquisition === 'roonDesktopExport' ? 'Roon 桌面导出' : '手动绑定' }} · 仅外部引用，未归档</p>
      <dl><div><dt>技术参数</dt><dd>{{ binding.technical.container }} / {{ binding.technical.codec }} · {{ binding.technical.sampleRate }} Hz · {{ binding.technical.bitsPerSample ?? '未知' }} bit · {{ binding.technical.channels }} 声道</dd></div><div><dt>实际时长</dt><dd>{{ (binding.technical.durationMs / 1000).toFixed(3) }} 秒</dd></div><div><dt>完整 SHA-256</dt><dd class="hash">{{ binding.sha256 }}</dd></div><div><dt>文件修改时间</dt><dd>{{ new Date(binding.modifiedAt).toLocaleString() }}</dd></div><div><dt>校验快照</dt><dd>{{ new Date(binding.verifiedAt).toLocaleString() }} · {{ binding.size.toLocaleString() }} 字节</dd></div></dl>
      <p v-if="binding.sourceLockEligible" class="verified" role="status">源验证条件已满足；冻结前还会重新校验。</p><p v-else class="muted">{{ binding.userConfirmed ? '已确认曲目对应，但当前文件不可用。' : '技术参数和 Hash 已记录，仍需人工确认曲目对应。' }}</p>
      <label v-if="!binding.userConfirmed" class="confirm-check"><input v-model="confirmed" type="checkbox" :disabled="blocked || running || binding.availability !== 'ONLINE'">我已核对这份文件对应「{{ title }}」</label>
      <div class="actions"><button v-if="!binding.userConfirmed" :disabled="blocked || running || !confirmed || binding.availability !== 'ONLINE'" @click="confirm">确认曲目对应</button><button :disabled="blocked || running || !roots.some(r => r.id === binding?.rootId && r.availability === 'ONLINE')" @click="recheck">重新完整校验</button></div>
    </section>
    <LocalLegacyLinksPanel v-if="binding && localLinksReady" :context="{ key: { kind: 'draft-source', draftId, draftTrackId: trackId, sourceBindingId: binding.id }, revision: draftRevision, title }" />
    <p v-else-if="binding" role="status">本地关联服务尚未就绪。已存源证据、原源文件入口和冻结历史仍保留。</p>
    <section v-if="track?.jobs.length" aria-labelledby="source-jobs-heading"><h3 id="source-jobs-heading">校验记录</h3><ul class="jobs"><li v-for="job in track.jobs" :key="job.id"><div><strong>{{ states[job.state] }}</strong><small v-if="job.failure">{{ failures[job.failure] }}</small><small>任务 {{ job.id }}</small></div><button v-if="job.state === 'running'" :disabled="blocked" @click="cancel(job.id)">取消校验</button></li></ul></section>
    <p v-if="error" class="error" role="alert">{{ error }} <button v-if="pending" :disabled="busy" @click="retry">重试原操作</button><button v-else :disabled="busy" @click="error = ''; refresh()">刷新源资料</button></p>
    <footer>文件绑定不会占用磁带、操作 Roon 播放或开始正式录音。关闭此面板后，后台校验继续。</footer>
  </component>
</template>

<style scoped>
.source-panel{width:min(780px,calc(100vw - 32px));max-height:calc(100dvh - 32px);box-sizing:border-box;padding:26px;border:1px solid var(--mb-glass-border);border-radius:18px;background:var(--mb-bg-base);color:var(--mb-text-primary);overflow:auto;box-shadow:0 24px 90px #0005}.source-panel::backdrop{background:#0008}.source-panel header,.section-heading,.root-list li,.jobs li{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.source-panel header>div,.root-list li>div,.jobs li>div{min-width:0}.kicker{font-size:11px;letter-spacing:.16em;color:var(--mb-text-secondary);margin:0 0 8px}h2{font-size:25px;margin:0}h3{font-size:15px;margin:0 0 12px}.source-panel p{line-height:1.6;overflow-wrap:anywhere}.source-panel header p:last-child{margin-bottom:0}.intro,.muted,footer,small{color:var(--mb-text-secondary);font-size:12px}.source-panel section{border-top:1px solid var(--mb-glass-border);padding-top:20px;margin-top:20px}.source-panel button{min-height:36px;border:1px solid var(--mb-glass-border);border-radius:8px;padding:7px 12px;background:var(--mb-glass-clear);color:var(--mb-text-primary);font:inherit;font-size:12px;cursor:pointer}.source-panel button:disabled{opacity:.5;cursor:default}.source-panel button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}.root-list,.jobs{list-style:none;padding:0;margin:10px 0}.root-list li,.jobs li{padding:12px 0;border-bottom:1px solid var(--mb-glass-border)}strong,small{display:block;overflow-wrap:anywhere}small{margin-top:5px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{font-size:12px}.fields label{display:grid;gap:7px;min-width:0}select{width:100%;min-width:0;min-height:38px;background:var(--mb-glass-clear);border:1px solid var(--mb-glass-border);color:var(--mb-text-primary);border-radius:7px;padding:6px}fieldset{padding:0;margin:15px 0;border:0;min-width:0}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.confirmation{padding:12px;background:var(--mb-glass-clear);border-radius:10px}.confirmation button{margin-right:8px}dl{font-size:12px}dl>div{display:grid;grid-template-columns:90px 1fr;gap:12px;margin:12px 0}dt{color:var(--mb-text-secondary)}dd{margin:0;overflow-wrap:anywhere}.hash{font-family:monospace;line-height:1.6}.verified{color:var(--mb-text-primary);font-weight:600}.confirm-check{display:flex;align-items:flex-start;gap:8px;line-height:1.6}.error{color:var(--mb-text-primary);border-left:3px solid #b55a43;padding:10px}footer{margin-top:20px;border-top:1px solid var(--mb-glass-border);padding-top:16px;line-height:1.6}@media(max-width:600px){.source-panel{padding:18px}.fields{grid-template-columns:1fr}dl>div{grid-template-columns:1fr;gap:5px}.section-heading{align-items:center}.root-list li,.jobs li{flex-wrap:wrap}}
.source-panel.is-inline{position:static;display:block;box-sizing:border-box;width:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:transparent;overflow:visible}
.candidate-scan{padding:14px;border:1px solid var(--mb-glass-border);border-radius:12px;background:var(--mb-glass-clear)}.candidate-scan h4{margin:0;font-size:14px}.candidate-list{list-style:none;padding:0;margin:12px 0;max-height:360px;overflow:auto}.candidate-list li{border-top:1px solid var(--mb-glass-border)}.candidate-list label{display:flex;align-items:flex-start;gap:10px;padding:10px 4px;cursor:pointer}.candidate-list input{margin-top:4px;accent-color:var(--mb-accent)}.candidate-list span{min-width:0}.candidate-pagination{display:flex;align-items:center;justify-content:flex-end;gap:12px;font-size:12px;color:var(--mb-text-secondary)}
</style>
