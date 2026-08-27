<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type {
  MasterDraft, VersionHistory, PreparedHistory, PreparationDestination,
  ExecutionHistory, ExecutionJob, ExecutionProposal, ExecutionAssetCheck,
  RecordingSessionSettings, StartExecutionRequest,
} from '@music-bridge/contracts'
import RecordingProfileSettings from './RecordingProfileSettings.vue'

const props = defineProps<{ draft: MasterDraft }>()
const emit = defineEmits<{ close: [] }>()
const api = window.musicBridge, dialog = ref<HTMLDialogElement>()
const versions = shallowRef<VersionHistory>(), prepared = shallowRef<PreparedHistory>()
const history = shallowRef<ExecutionHistory>()
const destinations = shallowRef<readonly PreparationDestination[]>([])
const session = shallowRef<RecordingSessionSettings | null>(null)
const layoutId = ref(''), destinationId = ref(''), preparedId = ref('')
const mode = ref<'direct' | 'prepared-reference'>('direct')
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('')
const profileState = ref({ busy: true, dirty: false })
const pending = shallowRef<() => Promise<void>>()
const proposal = shallowRef<ExecutionProposal>(), confirmed = ref(false)
const checks = ref<Record<string, ExecutionAssetCheck>>({})
const readId = ref(''), readPurpose = ref(''), aborting = ref(false), discarding = ref(false)
const layout = computed(() => versions.value?.layouts.find(v => v.id === layoutId.value))
const destination = computed(() => destinations.value.find(d => d.id === destinationId.value))
const compatiblePreps = computed(() => prepared.value?.preps.filter(p => p.layoutVersionId === layoutId.value && p.masterVersionId === layout.value?.masterVersionId) ?? [])
const running = computed(() => history.value?.jobs.filter(j => j.state === 'running') ?? [])
const externalBusy = computed(() => loading.value || busy.value || !!pending.value || !!readId.value)
const blocked = computed(() => externalBusy.value || profileState.value.busy)
const canPreview = computed(() => !blocked.value && !profileState.value.dirty && !!session.value && !!layout.value && !!destination.value?.authorized && (mode.value === 'direct' || compatiblePreps.value.some(p => p.id === preparedId.value)))
const closeBlocked = computed(() => busy.value || !!pending.value || profileState.value.busy || !!readId.value)
const size = (bytes: number): string => bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
const short = (id: string): string => id.slice(0,8)
const failures: Record<NonNullable<ExecutionJob['failure']>, string> = {
  SOURCE_INVALID: '源文件或读取授权失效', DESTINATION_INVALID: '目标或保留原件授权失效',
  INPUT_CHANGED: '输入内容已改变', CONVERSION_REQUIRED: '需要尚未接入的格式转换',
  IO_ERROR: '读取、写入或总体时限检查失败', DISK_FULL: '目标磁盘空间不足',
  CANCELLED: '已取消', ASSET_INVALID: '发布文件或原始 Render 完整性验证失败',
}
function statusText(job: ExecutionJob): string {
  if (job.state === 'completed') return '执行资产已发布；尚未获得正式录音许可。'
  if (job.state === 'running') return `正在准备并校验 ${job.completedSides} / ${job.totalSides} 面`
  if (job.state === 'interrupted') return '任务中断；重启只验证完整产物，不重编译。请检查保留目录后再决定是否新建任务。'
  return job.failure ? failures[job.failure] : '任务未完成'
}
let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
function invalidate(): void { proposal.value = undefined; confirmed.value = false }
watch([layoutId,destinationId,preparedId,mode,session], invalidate)
watch(layoutId, () => { preparedId.value = '' })
watch(() => profileState.value.dirty, dirty => { if (dirty) invalidate() })
async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true
  try {
    const [v,p,h,d] = await Promise.all([
      api.listMasterVersions(props.draft.id), api.listPrepared(props.draft.id),
      api.listExecutionAssets(props.draft.id), api.listPreparationDestinations(),
    ])
    if (!alive) return
    versions.value = v; prepared.value = p; history.value = h; destinations.value = d.destinations
    if (!layoutId.value) layoutId.value = v.layouts[0]?.id ?? ''
    if (!destinationId.value) destinationId.value = d.destinations.find(x => x.authorized)?.id ?? ''
    if (timer) clearTimeout(timer)
    if (h.jobs.some(j => j.state === 'running')) timer = setTimeout(() => { void refresh() }, 700)
  } catch { if (alive) error.value = '执行状态暂时无法读取，已存资产不会被清空。请刷新。' }
  finally { if (alive && initial) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    await pending.value()
    if (alive) { pending.value = undefined; invalidate(); await refresh() }
  } catch (cause) {
    if (!alive) return
    if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST|BAD_REQUEST)\]/u.test(cause instanceof Error ? cause.message : '')) {
      pending.value = undefined; invalidate()
      error.value = '请求未接受。请重新核对源文件、参数修订、介质预留和目录授权，再预览确认。'
    } else error.value = '操作回执尚未确认，请重试原操作；不会重复编译或发布。'
  } finally { if (alive) busy.value = false }
}
function mutate(operation: () => Promise<void>): void {
  if (busy.value || pending.value || profileState.value.busy) return
  pending.value = operation; void retry()
}
function chooseDestination(): void {
  if (blocked.value) return
  const commandId = crypto.randomUUID()
  mutate(async () => {
    const result = await api.choosePreparationDestination(commandId)
    if (alive) { if (result) destinationId.value = result.id; notice.value = result ? '目标目录已授权；确认准备前不写文件。' : '已取消目录选择。' }
  })
}
function revokeDestination(): void {
  if (!destination.value?.authorized || busy.value || pending.value) return
  const request = { commandId: crypto.randomUUID(), id: destination.value.id }
  mutate(async () => { await api.revokePreparationDestination(request); if (alive) notice.value = '目录授权已撤销；已保存文件不会删除。' })
}
async function preview(): Promise<void> {
  if (!canPreview.value || !session.value) return
  const id = crypto.randomUUID(), token = ++generation
  readId.value = id; readPurpose.value = '正在完整读取并核对源音频'; error.value = ''; notice.value = ''; invalidate()
  const request = { readId: id, layoutVersionId: layoutId.value, destinationId: destinationId.value, mode: mode.value,
    sessionRevision: session.value.revision, ...(mode.value === 'prepared-reference' ? { preparedVersionId: preparedId.value } : {}) }
  try { const result = await api.previewExecutionAsset(request); if (alive && token === generation) proposal.value = result }
  catch { if (alive && token === generation) error.value = '无法准备此格式。请检查源音频与 Profile 的采样率、声道和位深是否一致，以及预留和目录授权是否有效；当前不做隐式格式转换。' }
  finally { if (alive && readId.value === id) readId.value = '' }
}
function start(): void {
  if (!canPreview.value || !proposal.value || !confirmed.value) return
  const p = proposal.value
  const request: StartExecutionRequest = {
    commandId: crypto.randomUUID(), layoutVersionId: p.layoutVersionId, destinationId: p.destinationId,
    mode: p.mode, sessionRevision: p.sessionRevision, proposalFingerprint: p.proposalFingerprint,
    ...(p.preparedVersionId ? { preparedVersionId: p.preparedVersionId } : {}), userConfirmed: true,
  }
  mutate(async () => { const job = await api.startExecutionAsset(request); if (alive) notice.value = job.state === 'running' ? '执行请求已接受；当前进度见任务记录。' : statusText(job) })
}
function cancel(job: ExecutionJob): void {
  const request = { commandId: crypto.randomUUID(), id: job.id }
  mutate(async () => { const result = await api.cancelExecutionJob(request); if (alive) notice.value = statusText(result) })
}
async function verify(assetId: string): Promise<void> {
  if (blocked.value) return
  const id = crypto.randomUUID(), token = ++generation
  readId.value = id; readPurpose.value = '正在重新验证已发布文件'; error.value = ''
  delete checks.value[assetId]
  try { const result = await api.verifyExecutionAsset({ assetId, readId: id }); if (alive && token === generation) checks.value[assetId] = result }
  catch { if (alive && token === generation) error.value = '资产核验未完成，请检查目录后重试；历史发布记录仍保留。' }
  finally { if (alive && readId.value === id) readId.value = '' }
}
async function stopRead(): Promise<void> {
  if (!readId.value || aborting.value) return
  const id = readId.value; aborting.value = true
  try { await api.cancelExecutionRead(id); if (alive) { ++generation; readId.value = ''; notice.value = '本次读取已取消；没有撤销目录授权。' } }
  catch { if (alive) error.value = '取消读取的回执尚未确认，请重试取消。' }
  finally { if (alive) aborting.value = false }
}
function close(force = false): void {
  if (closeBlocked.value) return
  if (profileState.value.dirty && !force) { discarding.value = true; return }
  dialog.value?.close(); emit('close')
}
onMounted(async () => { await nextTick(); dialog.value?.showModal(); void refresh(true) })
onBeforeUnmount(() => {
  alive = false; ++generation; if (timer) clearTimeout(timer)
  if (readId.value) void api.cancelExecutionRead(readId.value).catch(() => undefined)
  dialog.value?.close()
})
</script>
<template>
  <dialog ref="dialog" class="execution-panel" aria-labelledby="execution-title" @cancel.prevent="close()">
    <header>
      <div><p class="kicker">录音准备 · 06</p><h2 id="execution-title">录音参数与执行资产</h2><p class="muted">{{ draft.title }}</p></div>
      <button :disabled="closeBlocked" @click="close()">关闭</button>
    </header>
    <div class="boundary"><strong>准备音频，尚不开始录音。</strong><p>F-01 保留政策、归档规则、输出认证与正式预检仍待完成。本阶段不操作设备，不自动删除执行文件，也不承诺永久归档。</p></div>
    <RecordingProfileSettings :draft-id="draft.id" :disabled="externalBusy" @session="session = $event" @state="profileState = $event" />

    <section aria-labelledby="execution-source-title">
      <p class="kicker">02 · 执行来源</p><h3 id="execution-source-title">选择已冻结的版本</h3>
      <fieldset :disabled="blocked">
        <div class="fields">
          <label>冻结布局<select v-model="layoutId"><option value="">先冻结母版与布局</option><option v-for="item in versions?.layouts" :key="item.id" :value="item.id">M{{ versions?.masters.find(m => m.id === item.masterVersionId)?.sequence }} · L{{ item.sequence }} · {{ item.spec.format === 'cassette' ? 'A / B' : 'DAT Program' }} · {{ short(item.id) }}</option></select></label>
          <label>执行来源<select v-model="mode"><option value="direct">Direct · 从冻结源文件编译</option><option value="prepared-reference">Prepared · 引用原始 Render</option></select></label>
          <label v-if="mode === 'prepared-reference'">兼容 PREP<select v-model="preparedId"><option value="">选择此布局的 Frozen PREP</option><option v-for="item in compatiblePreps" :key="item.id" :value="item.id">PREP {{ item.sequence }} · {{ item.conformance.status }} · {{ short(item.id) }}</option></select></label>
          <label>执行目标<select v-model="destinationId"><option value="">选择保存目录</option><option v-for="item in destinations" :key="item.id" :value="item.id">{{ item.label }} · {{ short(item.id) }}{{ item.authorized ? '' : ' · 已撤权' }}</option></select></label>
        </div>
        <div class="actions"><button @click="chooseDestination">选择执行目标</button><button class="primary" :disabled="!canPreview || running.length >= 2" @click="preview">预览执行资产</button></div>
      </fieldset>
      <p v-if="!session || profileState.dirty" class="muted">请先保存并确认本次参数；未保存的编辑不会参与编译。</p>
      <p v-if="mode === 'direct'" class="muted">Direct 写入新的逐面 PCM 音频，按执行采样率计算冻结的留白。当前仅支持同格式整数 PCM，不改变原文件。</p>
      <p v-else class="muted">Prepared 完整验证保留的原始 Render，并保存引用清单；不二次复制，不再次插入 Gap。没有兼容 PREP 时不能继续。</p>
      <button v-if="destination?.authorized" :disabled="busy || !!pending || profileState.busy" @click="revokeDestination">撤销此目录授权（不删文件）</button>
    </section>

    <section v-if="proposal" class="proposal" aria-labelledby="execution-confirm-title">
      <p class="kicker">03 · 明确确认</p><h3 id="execution-confirm-title">确认执行资产</h3>
      <dl class="summary-grid">
        <div><dt>Profile 版本</dt><dd>{{ proposal.settings.profile.content.name }} · v{{ proposal.settings.profile.sequence }}<small>{{ proposal.settings.profile.id }}</small></dd></div>
        <div><dt>本次参数修订</dt><dd>{{ proposal.sessionRevision }} · 降噪 {{ proposal.settings.effective.noiseReduction ?? '未设定' }} · 电平 {{ proposal.settings.effective.recordLevel ?? '未设定' }}</dd></div>
        <div><dt>音频格式</dt><dd>{{ proposal.settings.format.sampleRate.toLocaleString() }} Hz · {{ proposal.settings.format.channelLayout }} · {{ proposal.settings.format.outputSampleFormat }}</dd></div>
        <div><dt>计划后端（未认证）</dt><dd>{{ proposal.settings.format.outputBackend.id }} · {{ proposal.settings.format.outputBackend.version }}</dd></div>
        <div><dt>精度 / 重采样 / Dither</dt><dd>{{ proposal.settings.format.internalProcessingPrecision }} · {{ proposal.settings.format.resamplerImplementation }} / {{ proposal.settings.format.resamplerVersion }} · {{ proposal.settings.format.ditherPolicy }}</dd></div>
        <div><dt>目标与空间</dt><dd>{{ proposal.destinationLabel }} · 新写音频 {{ size(proposal.audioBytesToWrite) }} · 引用原件 {{ size(proposal.referencedAudioBytes) }}<small>另需少量清单空间；发布前再次检查。</small></dd></div>
      </dl>
      <div class="side-list"><article v-for="recipe in proposal.recipes" :key="recipe.side"><strong>{{ recipe.side }} {{ recipe.totalFrames ? '' : '· 空面，不生成文件' }}</strong><p>{{ recipe.totalFrames.toLocaleString() }} / {{ recipe.capacityFrames.toLocaleString() }} 帧</p><p v-if="recipe.totalFrames">{{ (recipe.totalFrames / recipe.format.sampleRate).toFixed(3) }} 秒 · {{ recipe.segments.filter(s => s.kind === 'silence' && s.reason === 'gap').length }} 段 Gap</p></article></div>
      <p class="muted">手动预卷 {{ proposal.settings.effective.preRollMs / 1000 }} 秒不写入音频。校准：{{ proposal.settings.effective.calibration ?? '未设定' }}。链路：{{ proposal.settings.effective.signalChain.map(s => s.label).join(' → ') }}。</p>
      <label class="check"><input v-model="confirmed" type="checkbox" :disabled="blocked">我确认准备上述执行资产；不开始录音，不自动删除文件</label>
      <button class="primary" :disabled="!confirmed || !canPreview || running.length >= 2" @click="start">确认并准备执行资产</button>
    </section>

    <div v-if="readId" class="read-progress" role="status"><p>{{ readPurpose }}…耗时取决于文件大小和存储速度。</p><button :disabled="aborting" @click="stopRead">{{ aborting ? '正在取消读取…' : '取消本次读取' }}</button></div>
    <p v-if="loading || busy" role="status">正在读取状态或等待操作回执…</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <div v-if="error" role="alert" class="warning"><p>{{ error }}</p><button v-if="pending" :disabled="busy" @click="retry">重试原操作</button><button v-else :disabled="blocked" @click="error = ''; refresh(true)">刷新执行状态</button></div>

    <section aria-labelledby="execution-history-title">
      <p class="kicker">04 · 已保存的执行事实</p><h3 id="execution-history-title">执行资产历史</h3>
      <p class="muted">历史保留发布时使用的版本与参数。文件此刻是否仍可用，需要重新验证；验证通过也不解锁正式录音。</p>
      <p v-if="history && !history.assets.length" class="muted">尚无已发布执行资产。</p>
      <article v-for="(asset,i) in history?.assets" :key="asset.id" class="asset">
        <div class="asset-heading"><h4>执行资产 {{ (history?.assets.length ?? 0) - i }}</h4><span>{{ asset.mode === 'direct' ? 'Direct 编译' : 'Prepared 原件引用' }}</span></div>
        <p>{{ asset.settings.profile.content.name }} · v{{ asset.settings.profile.sequence }} · {{ asset.settings.format.sampleRate.toLocaleString() }} Hz · {{ asset.settings.format.outputSampleFormat }}</p>
        <p class="muted">{{ new Date(asset.createdAt).toLocaleString() }} · M {{ short(asset.masterVersionId) }} / L {{ short(asset.layoutVersionId) }} · {{ asset.audio.length }} 份非空音频</p>
        <p class="muted">降噪 {{ asset.settings.effective.noiseReduction ?? '未设定' }} · 校准 {{ asset.settings.effective.calibration ?? '未设定' }} · 电平 {{ asset.settings.effective.recordLevel ?? '未设定' }} · 手动预卷 {{ asset.settings.effective.preRollMs / 1000 }} 秒</p>
        <details><summary>逐面音频与谱系</summary><p class="muted">链路：{{ asset.settings.effective.signalChain.map(s => s.label).join(' → ') }}</p><p class="muted">计划后端：{{ asset.settings.format.outputBackend.id }} / {{ asset.settings.format.outputBackend.version }}（未认证）</p><div v-for="audio in asset.audio" :key="audio.recipe.side" class="audio-detail"><strong>{{ audio.recipe.side }} · {{ audio.audio.frameCount.toLocaleString() }} 帧 · {{ size(audio.audio.size) }}</strong><p>SHA-256</p><code>{{ audio.audio.sha256 }}</code><p>PCM SHA-256</p><code>{{ audio.audio.pcmSha256 }}</code></div><p>Manifest SHA-256</p><code>{{ asset.manifestHash }}</code></details>
        <button :disabled="blocked" @click="verify(asset.id)">重新验证此资产</button>
        <p v-if="checks[asset.id]" role="status" class="check-result">{{ checks[asset.id]!.state === 'verified' ? '本次文件验证通过' : '文件不可用或完整性验证未通过' }}</p>
        <p v-if="checks[asset.id]" class="muted">核验时间：{{ new Date(checks[asset.id]!.checkedAt).toLocaleString() }}。仍未正式就绪。</p>
      </article>
      <details v-if="history?.jobs.length" :open="running.length > 0" class="job-history"><summary>任务记录（{{ history.jobs.length }}）</summary>
        <article v-for="job in history.jobs" :key="job.id" class="job"><strong>{{ short(job.id) }} · {{ statusText(job) }}</strong><progress v-if="job.state === 'running'" :value="job.completedSides" :max="job.totalSides" aria-label="执行资产逐面进度"/><p v-if="job.state === 'running'" class="muted">关闭面板后继续；重启不会重放编译。失败或取消的文件保留，不自动清理。</p><button v-if="job.state === 'running' || job.state === 'interrupted'" :disabled="busy || !!pending || profileState.busy" @click="cancel(job)">取消此执行任务</button></article>
      </details>
    </section>
    <div v-if="discarding" class="warning" role="alert"><p>关闭会放弃尚未保存的参数编辑，已保存版本与执行任务保持不变。</p><div class="actions"><button @click="close(true)">放弃未保存编辑并关闭</button><button @click="discarding = false">继续编辑</button></div></div>
  </dialog>
</template>
<style scoped>
.execution-panel{box-sizing:border-box;width:min(940px,calc(100vw - 40px));max-height:calc(100dvh - 36px);padding:28px;border:1px solid var(--mb-glass-border);border-radius:18px;background:var(--mb-bg-base);color:var(--mb-text-primary);overflow:auto;overscroll-behavior:contain}.execution-panel::backdrop{background:rgb(0 0 0 / .66)}header,.actions,.asset-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}header{align-items:flex-start;margin-bottom:20px}.actions{justify-content:flex-start;margin:16px 0}h2{font-size:24px;line-height:1.35;letter-spacing:-.02em;margin:0}h3{font-size:19px;line-height:1.5;margin:0 0 12px}h4{font-size:16px;margin:0}.kicker{font-size:12px;color:var(--mb-accent);margin:0 0 8px}p{font-size:14px;line-height:1.75;overflow-wrap:anywhere}.muted{font-size:13px;color:var(--mb-text-secondary)}.boundary{padding:16px 18px;border-left:3px solid var(--mb-accent);background:var(--mb-glass-clear);margin:0 0 28px}.boundary p{margin:6px 0 0;font-size:13px}section{padding-top:26px;margin-top:26px;border-top:1px solid var(--mb-glass-border)}.fields,.summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.summary-grid{margin:20px 0}.summary-grid div{min-width:0}dt{font-size:12px;color:var(--mb-text-secondary);margin-bottom:7px}dd{margin:0;font-size:13px;line-height:1.75;overflow-wrap:anywhere}small{display:block;color:var(--mb-text-secondary);font-size:12px}label{display:grid;gap:8px;margin:12px 0;font-size:13px;min-width:0}.check{display:flex;gap:10px;align-items:flex-start;min-height:44px;line-height:1.7;cursor:pointer}.check input{width:18px;height:18px;min-height:0;margin:2px 0;flex-shrink:0;accent-color:var(--mb-accent)}select,button{box-sizing:border-box;min-height:44px;padding:9px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px;min-width:0}select{width:100%}button{cursor:pointer;overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:not-allowed}.primary{background:var(--mb-accent);color:var(--mb-bg-deep);border-color:var(--mb-accent);font-weight:600}fieldset{min-width:0;border:0;padding:0}.proposal{padding:22px;border:1px solid var(--mb-accent);border-radius:12px}.side-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.side-list article{padding:14px;border:1px solid var(--mb-glass-border);border-radius:8px;font-size:14px}.side-list p{font-size:13px;margin:7px 0 0;font-variant-numeric:tabular-nums}.asset{margin:18px 0;padding:18px;border:1px solid var(--mb-glass-border);border-radius:12px}.asset-heading span{font-size:12px;color:var(--mb-text-secondary)}.asset p{font-size:13px}.audio-detail{padding:14px 0;border-block:1px solid var(--mb-glass-border)}code{display:block;font-size:12px;line-height:1.75;overflow-wrap:anywhere;white-space:normal}summary{cursor:pointer;min-height:44px;line-height:1.7;padding:12px 0;box-sizing:border-box;font-size:13px}.job{padding:14px 0;border-top:1px solid var(--mb-glass-border);font-size:13px;line-height:1.75;overflow-wrap:anywhere}progress{display:block;width:100%;margin:12px 0;accent-color:var(--mb-accent)}.warning,.read-progress{padding:16px;border:1px solid var(--mb-glass-border);border-radius:10px;margin:18px 0}.warning p,.read-progress p{margin:0 0 10px}.notice,.check-result{color:var(--mb-accent)}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}@media(max-width:600px){.execution-panel{padding:20px;width:calc(100vw - 24px);max-height:calc(100dvh - 24px)}.fields,.summary-grid,.side-list{grid-template-columns:1fr;gap:10px}.proposal{padding:16px}h2{font-size:22px}.asset{padding:14px}}@media(hover:hover) and (pointer:fine){button:not(:disabled):hover{border-color:var(--mb-accent)}}button:not(:disabled):active{transform:scale(.98)}@media(prefers-reduced-motion:reduce){button:not(:disabled):active{transform:none}}
</style>
