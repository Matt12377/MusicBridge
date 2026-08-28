<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { MasterVersion, MasterDraft, MediaPlan, VersionHistory, VersionJob, VersionProposal, FreezeVersionsRequest } from '@music-bridge/contracts'
import VersionTimeline from './VersionTimeline.vue'
import MasterArtworkPanel from './MasterArtworkPanel.vue'
const props = defineProps<{ draft: MasterDraft; initialPlanId?: string }>()
const emit = defineEmits<{ close: []; prepare: [layoutId: string] }>()
const artworkMaster = shallowRef<MasterVersion>(), artworkTrigger = ref<HTMLElement>()
function openArtwork(masterId: string, event: MouseEvent): void { const master = history.value?.masters.find(item => item.id === masterId); if (master) { artworkTrigger.value = event.currentTarget as HTMLElement; artworkMaster.value = master } }
async function closeArtwork(): Promise<void> { artworkMaster.value = undefined; await nextTick(); artworkTrigger.value?.focus({ preventScroll: true }) }
const api = window.musicBridge, dialog = ref<HTMLDialogElement>()
const history = shallowRef<VersionHistory>(), plans = shallowRef<readonly MediaPlan[]>([]), proposal = shallowRef<VersionProposal>()
const planId = ref(''), sampleRate = ref(96000), confirmed = ref(false), loading = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const pending = shallowRef<() => Promise<VersionJob>>()
const running = computed(() => history.value?.jobs.find(j => j.state === 'running'))
const blocked = computed(() => loading.value || busy.value || !!pending.value || !!running.value)
const current = computed(() => plans.value.find(p => p.id === planId.value))
const ready = computed(() => !!current.value?.reservation && !current.value.requiresReview && current.value.sourceBasis === 'verified-sources')
const masterLabel = computed(() => proposal.value?.masterAction === 'reuse' ? '复用已有母版' : '创建新母版')
const failure = { SOURCE_INVALID: '源文件已变化、离线或授权失效，请重新校验。', INPUT_CHANGED: '草稿、分面或预留已改变，请重新预览。', IO_ERROR: '复核或保存失败，未生成部分版本。请检查状态后重新预览。', CANCELLED: '复核已取消，未创建版本。' }
const jobLabel = (job: VersionJob): string => job.state === 'running' ? '正在完整复核源文件…' : job.state === 'completed' ? '母版与布局已冻结；尚未开始录音。' : job.state === 'interrupted' ? '上次复核已中断，不会自动重播，请重新预览。' : job.failure ? failure[job.failure] : '任务未完成，请刷新。'
let alive = true, generation = 0, initialPlanApplied = false, timer: ReturnType<typeof setTimeout> | undefined
watch([planId, sampleRate], () => { ++generation; proposal.value = undefined; confirmed.value = false; notice.value = '' })
async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true
  try {
    const [versions, media] = await Promise.all([api.listMasterVersions(props.draft.id), api.listMediaPlans(props.draft.id)])
    if (!alive) return
    if (versions.draftId !== props.draft.id || media.draftId !== props.draft.id) throw new Error('版本或规划与当前草稿不一致')
    history.value = versions; plans.value = media.plans.filter(item => item.draftId === props.draft.id)
    if (props.initialPlanId !== undefined) {
      if (!initialPlanApplied) {
        planId.value = plans.value.find(item => item.id === props.initialPlanId)?.id ?? ''
        initialPlanApplied = true
        if (props.initialPlanId && !planId.value) error.value = '本次选择的规划已不可用，请明确重选；不会自动切换其他规划。'
      }
    } else if (!planId.value) planId.value = plans.value.find(p => p.reservation)?.id ?? plans.value[0]?.id ?? ''
    if (versions.jobs[0]) notice.value = jobLabel(versions.jobs[0])
    if (timer) clearTimeout(timer)
    if (versions.jobs.some(j => j.state === 'running')) timer = setTimeout(() => { void refresh() }, 800)
  } catch { if (alive) error.value = '版本或规划暂时无法读取，已有历史不会被清空。请刷新。' }
  finally { if (alive && initial) loading.value = false }
}
async function preview(): Promise<void> {
  if (blocked.value || !ready.value) return
  const token = ++generation; loading.value = true; error.value = ''; notice.value = ''; proposal.value = undefined; confirmed.value = false
  try { const result = await api.previewMasterVersions({ planId: planId.value, sampleRate: sampleRate.value }); if (alive && token === generation) proposal.value = result }
  catch { if (alive && token === generation) error.value = '不能冻结当前规划。请核对最新草稿、精确源帧证据、分面容量及预留后重新预览。' }
  finally { if (alive) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    const result = await pending.value()
    if (!alive) return
    pending.value = undefined; proposal.value = undefined; confirmed.value = false; notice.value = jobLabel(result)
    await refresh()
  } catch (cause) {
    if (alive) {
      const message = cause instanceof Error ? cause.message : ''
      if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(message)) { pending.value = undefined; proposal.value = undefined; confirmed.value = false; error.value = '请求未接受，输入或状态已变化。请刷新后重新预览。' }
      else error.value = '操作回执尚未确认。请重试原操作，不会重复冻结版本。'
    }
  } finally { if (alive) busy.value = false }
}
function freeze(): void {
  if (blocked.value || !proposal.value || !confirmed.value) return
  const request: FreezeVersionsRequest = { commandId: crypto.randomUUID(), planId: proposal.value.planId, sampleRate: proposal.value.timeline.sampleRate, proposalFingerprint: proposal.value.proposalFingerprint, userConfirmed: true }
  pending.value = () => api.freezeMasterVersions(request); void retry()
}
function cancel(): void {
  if (!running.value || busy.value || pending.value) return
  const request = { commandId: crypto.randomUUID(), id: running.value.id }
  pending.value = () => api.cancelMasterVersionJob(request); void retry()
}
function close(): void { if (!busy.value && !pending.value) { dialog.value?.close(); emit('close') } }
onMounted(async () => { await nextTick(); dialog.value?.showModal(); void refresh(true) })
onBeforeUnmount(() => { alive = false; ++generation; if (timer) clearTimeout(timer); dialog.value?.close() })
</script>
<template>
  <dialog ref="dialog" class="versions-panel" aria-labelledby="versions-title" @cancel.prevent="close">
    <header><div><p class="kicker">录音准备 · 03</p><h2 id="versions-title">母版与布局版本</h2><p class="muted">{{ draft.title }}</p></div><button :disabled="busy || !!pending" @click="close">关闭</button></header>
    <p class="intro">母版锁定曲目、曲序、实际源和曲间规则；布局锁定磁带分面与帧级时间线。只改分面会复用母版，历史不会被覆盖。</p>
    <section aria-labelledby="version-proposal-title"><h3 id="version-proposal-title">冻结提案</h3>
      <div class="fields"><label>已保存的规划<select aria-label="已保存的规划" v-model="planId" :disabled="blocked || !plans.length"><option value="">{{ plans.length ? '请选择已保存的规划' : '尚无规划' }}</option><option v-for="item in plans" :key="item.id" :value="item.id">{{ item.spec.format === 'cassette' ? 'Cassette A/B' : 'DAT Program' }} · {{ item.reservation?.physicalId ?? '未预留' }} · {{ item.id.slice(0, 8) }}</option></select></label><label>规划采样率<select aria-label="规划采样率" v-model.number="sampleRate" :disabled="blocked"><option :value="44100">44,100 Hz</option><option :value="48000">48,000 Hz</option><option :value="88200">88,200 Hz</option><option :value="96000">96,000 Hz</option><option :value="176400">176,400 Hz</option><option :value="192000">192,000 Hz</option></select></label></div>
      <p class="muted">采样率是此布局的显式规划时基，后续编译需验证精确帧数；它不是设备认证或输出格式选择。</p>
      <p v-if="!ready && !loading" class="warning">请先在“分面与选择磁带”保存最新规划并预留磁带，全部曲目需完成实际源校验和人工确认。</p>
      <button class="primary" :disabled="blocked || !ready" @click="preview">预览冻结提案</button>
      <div v-if="proposal" class="proposal">
        <h3>{{ masterLabel }}</h3><p v-if="proposal.masterAction === 'create'">{{ proposal.previousMasterId ? '内容、曲序、源或曲间规则与已有母版不同。确认后创建新母版，原版本保留。' : '这是这份草稿的首个母版版本。确认前不会写入冻结历史。' }}</p><p v-else>曲目、全局曲序、源内容和曲间规则相同。确认后只新增布局版本。</p>
        <p>{{ proposal.reservation.physicalId }} · {{ proposal.lengthMinutes }} 分钟 · {{ proposal.content.tracks.length }} 首</p>
        <VersionTimeline :timeline="proposal.timeline" :content="proposal.content" />
        <details><summary>核对锁定的源与曲间规则</summary><ol class="sources"><li v-for="track in proposal.content.tracks" :key="track.trackId"><strong>{{ track.metadata.title }}</strong><span>{{ track.metadata.artist ?? '艺术家待核实' }} · {{ track.metadata.album ?? '专辑待核实' }}</span><span>之后规则 {{ track.transitionAfterMs }} 毫秒 · {{ track.keepWithNext ? '与下一首保持相邻' : '可换面' }}</span><code>SHA-256 {{ track.source.sha256 }}</code></li></ol></details>
        <label class="check"><input v-model="confirmed" type="checkbox" :disabled="blocked">我确认曲目、源、曲间规则和此布局，冻结后保留历史版本</label><button class="primary" :disabled="blocked || !confirmed" @click="freeze">确认并复核冻结</button>
      </div>
    </section>
    <section v-if="running" class="job" aria-label="冻结后台任务"><h3>正在复核</h3><p>逐首重新读取已授权源文件，核对完整 Hash 与技术帧数。关闭面板后任务继续；应用重启会中断未完成任务，不会重播。</p><button :disabled="busy || !!pending" @click="cancel">取消本次复核</button></section>
    <p v-if="loading" role="status">正在读取版本或计算提案…</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <p v-if="error" role="alert" class="warning">{{ error }} <button v-if="pending" :disabled="busy" @click="retry">重试原操作</button><button v-else :disabled="busy || loading" @click="error = ''; refresh(true)">刷新版本</button></p>
    <section aria-labelledby="version-history-title"><h3 id="version-history-title">冻结历史</h3><p v-if="history && !history.layouts.length" class="muted">还没有冻结版本。</p>
      <article v-for="layout in history?.layouts" :key="layout.id" class="history-item">
        <h4>L{{ layout.sequence }} · M{{ history!.masters.find(m => m.id === layout.masterVersionId)?.sequence }} · {{ layout.reservation.physicalId }}</h4><p class="muted">{{ new Date(layout.createdAt).toLocaleString() }} · {{ layout.spec.format === 'cassette' ? 'Cassette A/B' : 'DAT Program' }}</p>
        <button type="button" :disabled="busy || !!pending" @click="openArtwork(layout.masterVersionId, $event)">管理母版 M{{ history!.masters.find(m => m.id === layout.masterVersionId)?.sequence }} Artwork</button>
        <button :disabled="busy || !!pending" @click="dialog?.close(); emit('prepare', layout.id)">为布局 L{{ layout.sequence }} 准备 Logic</button>
        <details><summary>查看布局 L{{ layout.sequence }}</summary><template v-for="master in history!.masters.filter(m => m.id === layout.masterVersionId)" :key="master.id"><p>{{ master.title }} · 母版 M{{ master.sequence }}{{ master.parentId ? ' · 从历史母版派生' : '' }}</p><VersionTimeline :timeline="layout.timeline" :content="master.content" /><details><summary>查看母版源身份</summary><ol class="sources"><li v-for="track in master.content.tracks" :key="track.trackId"><strong>{{ track.metadata.title }}</strong><code>SHA-256 {{ track.source.sha256 }}</code></li></ol></details></template><code>Planned Timeline SHA-256 {{ layout.timelineHash }}</code></details>
      </article>
      <details v-if="history?.jobs.length"><summary>复核任务记录（{{ history.jobs.length }}）</summary><ul class="jobs"><li v-for="job in history.jobs" :key="job.id"><span>{{ job.id.slice(0, 8) }}</span> · {{ jobLabel(job) }}</li></ul></details>
    </section>
    <MasterArtworkPanel v-if="artworkMaster" :key="artworkMaster.id" :master="artworkMaster" @close="closeArtwork" />
    <footer>这里只冻结内容与布局。Logic/PREP、执行资产、录音 Plan Freeze、输出认证和正式录音尚未完成。未复制或改写源音频。</footer>
  </dialog>
</template>
<style scoped>
.versions-panel{box-sizing:border-box;width:min(960px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:28px;border:1px solid var(--mb-glass-border);border-radius:18px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;overflow:auto;overscroll-behavior:contain}.versions-panel::backdrop{background:rgb(0 0 0 / .6)}header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.kicker{font-size:11px;letter-spacing:2px;color:var(--mb-text-secondary);margin:0 0 10px}h2{font-size:24px;margin:0}h3{font-size:17px;margin:0 0 16px}h4{font-size:15px;margin:0}p{font-size:13px;line-height:1.75;overflow-wrap:anywhere}.intro,.muted,footer{color:var(--mb-text-secondary)}section{border-top:1px solid var(--mb-divider);margin-top:24px;padding-top:24px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.6}select{box-sizing:border-box;width:100%;min-width:0;min-height:44px;padding:8px 10px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit}button{min-height:44px;padding:9px 15px;border:1px solid var(--mb-glass-border);border-radius:9px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:active:not(:disabled){background:var(--mb-bg-elevated)}button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}.primary{border-color:var(--mb-accent);color:var(--mb-accent)}.proposal,.history-item{padding:20px;margin-top:20px;border:1px solid var(--mb-glass-border);border-radius:12px;min-width:0}.check{flex-direction:row;align-items:center;min-height:44px;margin:16px 0}input{accent-color:var(--mb-accent);width:16px;height:16px;flex-shrink:0}.warning{padding:12px;border-left:3px solid var(--mb-accent)}.notice{padding:12px 0;font-weight:600}summary{min-height:44px;padding:12px 0;box-sizing:border-box;cursor:pointer;font-size:13px}code{display:block;font-size:12px;line-height:1.7;overflow-wrap:anywhere;color:var(--mb-text-secondary);margin-top:12px}.sources,.jobs{padding-left:20px;font-size:13px;line-height:1.7}.sources li{margin:16px 0;overflow-wrap:anywhere}.sources span{display:block;color:var(--mb-text-secondary)}footer{font-size:12px;line-height:1.8;margin-top:24px}@media(hover:hover) and (pointer:fine){button:hover:not(:disabled){border-color:var(--mb-accent)}}@media(max-width:760px){.versions-panel{padding:20px}.fields{grid-template-columns:1fr}h2{font-size:20px}.proposal,.history-item{padding:16px}}
</style>
