<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { MasterDraft, VersionHistory, PreparationDestination, PreparationHistory, PreparationJob, PreparationProposal, StartPreparationRequest } from '@music-bridge/contracts'
const props = defineProps<{ draft: MasterDraft; initialLayoutId?: string }>()
const emit = defineEmits<{ close: []; 'import-render': [id: string] }>()
const api = window.musicBridge, dialog = ref<HTMLDialogElement>()
const versions = shallowRef<VersionHistory>(), history = shallowRef<PreparationHistory>(), destinations = shallowRef<readonly PreparationDestination[]>([])
const layoutId = ref(props.initialLayoutId ?? ''), destinationId = ref(''), proposal = shallowRef<PreparationProposal>(), confirmed = ref(false)
const loading = ref(false), busy = ref(false), error = ref(''), notice = ref(''), pending = shallowRef<() => Promise<void>>()
const running = computed(() => history.value?.jobs.find(j => j.state === 'running'))
const blocked = computed(() => loading.value || busy.value || !!pending.value || !!running.value)
const destination = computed(() => destinations.value.find(d => d.id === destinationId.value))
const layout = computed(() => versions.value?.layouts.find(l => l.id === layoutId.value))
const master = computed(() => versions.value?.masters.find(m => m.id === layout.value?.masterVersionId))
const ready = computed(() => !!layout.value && destination.value?.authorized === true)
const size = (bytes: number): string => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
const failure = { SOURCE_INVALID: '源文件已变化、离线或授权失效，请重新校验源。', DESTINATION_INVALID: '目标目录身份、归属或授权已失效，请重新选择目标。', IO_ERROR: '读取或保存失败，请检查源与目标目录。', DISK_FULL: '目标空间不足，请释放空间或选择其他目录。', CANCELLED: '本次复制已取消。' }
const jobLabel = (job: PreparationJob): string => job.state === 'completed' ? '工作区已生成。请在 Logic 中手动导入工作副本。' : job.state === 'running' ? `正在复制与复核：${job.completedTracks} / ${job.totalTracks} 首` : job.state === 'interrupted' ? '上次任务已中断，未自动重放复制；请检查已有目录并重新预览。' : job.failure ? failure[job.failure] : '工作区未完成，请刷新。'
let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
watch([layoutId, destinationId], () => { ++generation; proposal.value = undefined; confirmed.value = false })
async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true
  try {
    const [v, h, d] = await Promise.all([api.listMasterVersions(props.draft.id), api.listPreparations(props.draft.id), api.listPreparationDestinations()])
    if (!alive) return
    versions.value = v; history.value = h; destinations.value = d.destinations
    if (!layoutId.value) layoutId.value = v.layouts[0]?.id ?? ''
    if (!destinationId.value) destinationId.value = d.destinations.find(item => item.authorized)?.id ?? ''
    if (h.jobs[0]) notice.value = jobLabel(h.jobs[0])
    if (timer) clearTimeout(timer)
    if (h.jobs.some(j => j.state === 'running')) timer = setTimeout(() => { void refresh() }, 700)
  } catch { if (alive) error.value = '工作区状态暂时无法读取，已有历史不会被清空。请刷新。' }
  finally { if (alive && initial) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try { await pending.value(); if (alive) { pending.value = undefined; proposal.value = undefined; confirmed.value = false; await refresh() } }
  catch (cause) {
    if (alive) {
      if (/\[(INVALID_IPC_REQUEST|INVENTORY_CONFLICT)\]/u.test(cause instanceof Error ? cause.message : '')) { pending.value = undefined; proposal.value = undefined; confirmed.value = false; error.value = '请求未接受。请核对冻结布局、源授权及目标目录，再重新预览。' }
      else error.value = '操作回执尚未确认。请重试原操作，不会重复创建工作区。'
    }
  } finally { if (alive) busy.value = false }
}
function choose(): void {
  if (blocked.value) return
  const commandId = crypto.randomUUID()
  pending.value = async () => { const selected = await api.choosePreparationDestination(commandId); if (alive) { if (selected) destinationId.value = selected.id; notice.value = selected ? '目标目录已授权。确认前不会写入工作副本。' : '已取消目录选择。' } }
  void retry()
}
function revoke(): void {
  if (!destination.value?.authorized || busy.value || pending.value) return
  const request = { commandId: crypto.randomUUID(), id: destination.value.id }
  pending.value = async () => { await api.revokePreparationDestination(request); if (alive) notice.value = '目标目录授权已撤销，已有工作副本不会被删除。' }; void retry()
}
async function preview(): Promise<void> {
  if (blocked.value || !ready.value) return
  const token = ++generation; loading.value = true; error.value = ''; proposal.value = undefined; confirmed.value = false
  try { const result = await api.previewPreparation({ layoutVersionId: layoutId.value, destinationId: destinationId.value }); if (alive && token === generation) proposal.value = result }
  catch { if (alive && token === generation) error.value = '无法准备此工作区。请确认源仍可用且已授权，目标不在源目录内，并核对所选冻结布局。' }
  finally { if (alive) loading.value = false }
}
function start(): void {
  if (blocked.value || !proposal.value || !confirmed.value) return
  const request: StartPreparationRequest = { commandId: crypto.randomUUID(), layoutVersionId: proposal.value.layoutVersionId, destinationId: proposal.value.destinationId, proposalFingerprint: proposal.value.proposalFingerprint, userConfirmed: true }
  pending.value = async () => { const job = await api.startPreparation(request); if (alive) notice.value = jobLabel(job) }; void retry()
}
function cancel(): void {
  if (!running.value || busy.value || pending.value) return
  const request = { commandId: crypto.randomUUID(), id: running.value.id }
  pending.value = async () => { const job = await api.cancelPreparationJob(request); if (alive) notice.value = jobLabel(job) }; void retry()
}
async function open(id: string): Promise<void> {
  if (busy.value || pending.value) return
  busy.value = true; error.value = ''
  try { await api.openPreparationWorkspace(id) }
  catch { if (alive) error.value = '无法打开此工作区。请检查目标目录是否在线、仍有授权且归属未变。' }
  finally { if (alive) busy.value = false }
}
function close(): void { if (!busy.value && !pending.value) { dialog.value?.close(); emit('close') } }
onMounted(async () => { await nextTick(); dialog.value?.showModal(); void refresh(true) })
onBeforeUnmount(() => { alive = false; ++generation; if (timer) clearTimeout(timer); dialog.value?.close() })
</script>
<template>
  <dialog ref="dialog" class="preparation-panel" aria-labelledby="preparation-title" @cancel.prevent="close">
    <header><div><p class="kicker">录音准备 · 04</p><h2 id="preparation-title">Logic 工作区</h2><p class="muted">{{ draft.title }}</p></div><button :disabled="busy || !!pending" @click="close">关闭</button></header>
    <p class="intro">把冻结版本交给 Logic：生成独立音频副本、曲目表、源谱系与规划时间线。原件保持只读；声音处理由你在 Logic 中完成。</p>
    <section aria-labelledby="preparation-selection-title"><h3 id="preparation-selection-title">选择布局与目标</h3>
      <div class="fields">
        <label>冻结布局<select v-model="layoutId" aria-label="冻结布局" :disabled="blocked || !versions?.layouts.length"><option v-if="!versions?.layouts.length" value="">请先冻结母版与布局</option><option v-for="item in versions?.layouts" :key="item.id" :value="item.id">L{{ item.sequence }} · {{ item.spec.format === 'cassette' ? 'Cassette A/B' : 'DAT Program' }} · {{ item.reservation.physicalId }}</option></select></label>
        <label>工作区目标<select v-model="destinationId" aria-label="工作区目标" :disabled="blocked || !destinations.length"><option value="">请选择目标目录</option><option v-for="item in destinations" :key="item.id" :value="item.id">{{ item.label }} · {{ item.id.slice(0, 6) }}{{ item.authorized ? '' : ' · 已撤权' }}</option></select></label>
      </div>
      <div class="actions"><button :disabled="blocked" @click="choose">选择目标目录</button><button v-if="destination?.authorized" :disabled="busy || !!pending" @click="revoke">撤销目标授权</button></div>
      <p class="muted">每次创建独占子目录，不覆盖已有文件。目标不能是音乐库源目录；撤销授权会停止正在进行的复制，不会删除已导出的文件。</p>
      <p v-if="layout && master" class="version-line">母版 M{{ master.sequence }} · 布局 L{{ layout.sequence }} · {{ master.content.tracks.length }} 首 · {{ layout.spec.format === 'cassette' ? 'A / B 两面' : 'DAT 连续节目' }}</p>
      <button class="primary" :disabled="blocked || !ready" @click="preview">预览工作区</button>
      <div v-if="proposal" class="proposal">
        <h3>准备交给 Logic</h3><p>{{ proposal.trackCount }} 首独立工作副本 · 音频 {{ size(proposal.bytes) }}，另需少量清单空间</p>
        <ul><li>Sources：逐份读取源并校验副本 Hash</li><li>Tracklist / SourceLineage：冻结曲序与源绑定身份</li><li>Manifest：版本身份与 Planned Timeline</li><li>Bounce Targets：{{ layout?.spec.format === 'cassette' ? 'A、B 输出目录' : 'Program 输出目录' }}，由你在 Logic 中导出</li></ul>
        <p class="muted">这些是工作副本，不是已验证的 PREP、执行资产或归档。后续导回必须重新校验，不能凭文件名或本次导出记录直接录音。</p>
        <label class="check"><input v-model="confirmed" type="checkbox" :disabled="blocked">我确认生成独立工作副本；不修改源文件，不自动控制 Logic</label>
        <button class="primary" :disabled="blocked || !confirmed" @click="start">确认并生成工作副本</button>
      </div>
    </section>
    <section v-if="running" aria-label="工作区后台任务"><h3>正在生成工作副本</h3><progress :value="running.completedTracks" :max="running.totalTracks" aria-label="已校验曲目进度" /><p>{{ running.completedTracks }} / {{ running.totalTracks }} 首；全部文件和清单复核通过后才记为完成。</p><p class="muted">关闭面板后任务继续。应用退出后，未完成复制会中断；完整发布结果在冷启动时重新核验。</p><button :disabled="busy || !!pending" @click="cancel">取消本次复制</button></section>
    <p v-if="loading" role="status">正在读取工作区或核对提案…</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <p v-if="error" role="alert" class="warning">{{ error }} <button v-if="pending" :disabled="busy" @click="retry">重试原操作</button><button v-else :disabled="busy || loading" @click="error = ''; refresh(true)">刷新工作区</button></p>
    <section aria-labelledby="preparation-history-title"><h3 id="preparation-history-title">工作区历史</h3><p v-if="history && !history.workspaces.length" class="muted">尚无工作区。先选择冻结布局和目标目录。</p>
      <article v-for="item in history?.workspaces" :key="item.id" class="workspace-item">
        <div class="workspace-heading"><div><h4>工作副本 · L{{ versions?.layouts.find(l => l.id === item.layoutVersionId)?.sequence ?? '?' }}</h4><p class="muted">{{ new Date(item.createdAt).toLocaleString() }} · {{ item.trackCount }} 首 · {{ size(item.bytes) }}</p></div><span class="tag">已生成</span></div>
        <p class="muted">{{ destinations.find(d => d.id === item.destinationId)?.label ?? '目标目录' }} · {{ item.id.slice(0, 8) }}</p>
        <p>允许在 Logic 编辑；历史记录只证明导出时核验通过。</p>
        <button :disabled="busy || !!pending || !destinations.some(d => d.id === item.destinationId && d.authorized)" @click="open(item.id)">在 Finder 中打开</button>
        <button :disabled="busy || !!pending" @click="emit('import-render', item.id)">导入原始 Render</button>
        <details><summary>查看导出身份</summary><code>Master {{ item.masterVersionId }}</code><code>Layout {{ item.layoutVersionId }}</code><code>Manifest SHA-256 {{ item.manifestHash }}</code></details>
      </article>
      <details v-if="history?.jobs.length"><summary>任务记录（{{ history.jobs.length }}）</summary><ul class="jobs"><li v-for="job in history.jobs" :key="job.id">{{ job.id.slice(0, 8) }} · {{ jobLabel(job) }}</li></ul></details>
    </section>
    <footer>不自动启动或控制 Logic。失败、中断或取消后可能留下未完成目录，系统不会擅自删除；目录存在不代表导出成功。</footer>
  </dialog>
</template>
<style scoped>
.preparation-panel{box-sizing:border-box;width:min(880px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:28px;border:1px solid var(--mb-glass-border);border-radius:18px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;overflow:auto;overscroll-behavior:contain}.preparation-panel::backdrop{background:rgb(0 0 0 / .6)}header,.workspace-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.kicker{font-size:11px;letter-spacing:2px;color:var(--mb-text-secondary);margin:0 0 10px}h2{font-size:24px;margin:0}h3{font-size:17px;margin:0 0 16px}h4{font-size:15px;margin:0}p,li{font-size:13px;line-height:1.75;overflow-wrap:anywhere}.muted,.intro,footer{color:var(--mb-text-secondary)}section{border-top:1px solid var(--mb-divider);margin-top:24px;padding-top:24px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.6}select{box-sizing:border-box;width:100%;min-width:0;min-height:44px;padding:8px 10px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit}button{min-height:44px;padding:9px 15px;border:1px solid var(--mb-glass-border);border-radius:9px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:active:not(:disabled){background:var(--mb-bg-elevated)}button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}.primary{border-color:var(--mb-accent);color:var(--mb-accent)}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.proposal{padding:20px;margin-top:20px;border:1px solid var(--mb-glass-border);border-radius:12px}.check{flex-direction:row;align-items:center;min-height:44px;margin:16px 0}input{accent-color:var(--mb-accent);width:16px;height:16px;flex-shrink:0}.workspace-item{border-bottom:1px solid var(--mb-divider);padding:20px 0;min-width:0}.workspace-item:first-of-type{padding-top:0}.tag{border:1px solid var(--mb-glass-border);padding:4px 8px;border-radius:6px;font-size:12px;white-space:nowrap}.warning{padding:12px;border-left:3px solid var(--mb-accent)}.notice{font-weight:600;padding:12px 0}progress{width:100%;height:8px;accent-color:var(--mb-accent)}summary{min-height:44px;padding:12px 0;box-sizing:border-box;cursor:pointer;font-size:13px}code{display:block;font-size:12px;line-height:1.7;overflow-wrap:anywhere;color:var(--mb-text-secondary);margin-top:8px}.jobs{padding-left:20px}footer{font-size:12px;line-height:1.8;margin-top:24px}@media(hover:hover) and (pointer:fine){button:hover:not(:disabled){border-color:var(--mb-accent)}}@media(max-width:760px){.preparation-panel{padding:20px}.fields{grid-template-columns:1fr}h2{font-size:20px}.proposal{padding:16px}}
</style>
