<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { PreparationWorkspace, PreparationZipHistory, PreparationZipJob, PreparationZipProposal, PreparationZipReceiptRequest, PreparationZipTarget, StartPreparationZipRequest } from '@music-bridge/contracts'
import { clearPendingPreparationZip, isPreparationZipRejection, loadPendingPreparationZip, savePendingPreparationZip, zipWindowEpoch, type PendingPreparationZipOperation } from './preparation-zip-recovery.js'

const props = defineProps<{ draftId: string; workspaces: readonly PreparationWorkspace[] }>()
const emit = defineEmits<{ uncertain: [value: boolean] }>()
const api = window.musicBridge
const workspaceId = ref(''), target = shallowRef<PreparationZipTarget>(), proposal = shallowRef<PreparationZipProposal>()
const history = shallowRef<PreparationZipHistory>(), confirmed = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const pendingStart = shallowRef<StartPreparationZipRequest>(), pendingCancel = shallowRef<{ commandId: string; id: string }>()
const pendingStartScope = shallowRef<{ draftId: string; workspaceId: string }>(), pendingCancelScope = shallowRef<{ draftId: string; workspaceId: string }>()
const datasetId = ref(''), windowEpoch = ref(''), recoveryReady = ref(false), restoredFromOtherWindow = ref(false)
const uncertain = computed(() => !recoveryReady.value || !!pendingStart.value || !!pendingCancel.value)
watch(uncertain, value => emit('uncertain', value), { immediate: true, flush: 'sync' })
const noticeJobId = ref('')
const selected = computed(() => props.workspaces.find(workspace => workspace.id === workspaceId.value))
const jobs = computed(() => history.value?.jobs.filter(job => job.workspaceId === workspaceId.value) ?? [])
const running = computed(() => jobs.value.find(job => job.state === 'running' || job.state === 'cancelling'))
const size = (bytes: number): string => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
const issue: Record<string, string> = {
  WORKSPACE_INVALID: '原工作区或授权已失效，请重新核验。', TARGET_INVALID: '另存目标已失效或已存在同名文件，请重新选择。',
  CONTENT_CHANGED: '工作区内容已变化，请重新预览。', DISK_FULL: '目标空间不足。', IO_ERROR: 'ZIP 写入或校验失败。',
  CANCELLED: '已取消；不会覆盖同名文件。', RECOVERY_REQUIRED: '发布状态需要人工核验；请保留目标与任务记录。',
}
function label(job: PreparationZipJob): string {
  if (job.state === 'completed') return `ZIP 已核验并导出 · ${size(job.zipBytes ?? 0)}`
  if (job.state === 'running') return `正在打包与复核 · ${job.completedFiles} / ${job.fileCount} 项`
  if (job.state === 'cancelling') return '正在取消；若已发布，将先核验目标。'
  if (job.state === 'interrupted') return '上次操作已中断，不会自动续写。'
  return issue[job.failure ?? ''] ?? 'ZIP 操作未完成，请检查任务记录。'
}
let alive = true, generation = 0, refreshSequence = 0, recoverySequence = 0, timer: ReturnType<typeof setTimeout> | undefined
function pendingOperation(): PendingPreparationZipOperation | undefined {
  if (pendingStart.value && pendingStartScope.value) return { kind: 'start', request: pendingStart.value, ...pendingStartScope.value, windowEpoch: windowEpoch.value }
  if (pendingCancel.value && pendingCancelScope.value) return { kind: 'cancel', request: pendingCancel.value, ...pendingCancelScope.value, windowEpoch: windowEpoch.value }
  return undefined
}
function clearPending(draftId: string): void {
  clearPendingPreparationZip(window.localStorage, datasetId.value, draftId)
  pendingStart.value = undefined; pendingStartScope.value = undefined
  pendingCancel.value = undefined; pendingCancelScope.value = undefined
  restoredFromOtherWindow.value = false
}
async function checkOriginalReceipt(rejected = false): Promise<void> {
  const operation = pendingOperation()
  if (!operation) return
  const receipt: PreparationZipReceiptRequest = operation.kind === 'start'
    ? { kind: 'start', request: operation.request } : { kind: 'cancel', request: operation.request }
  try {
    const result = await api.getPreparationZipReceipt(receipt)
    if (!alive || pendingOperation()?.request !== operation.request) return
    if (result.status === 'accepted') {
      if (result.job.draftId !== operation.draftId || result.job.workspaceId !== operation.workspaceId) throw new Error('ZIP 回执范围不匹配。')
      clearPending(operation.draftId)
      if (props.draftId === operation.draftId && workspaceId.value === operation.workspaceId) {
        noticeJobId.value = result.job.id
        notice.value = `原操作 ${operation.request.commandId.slice(0, 8)} 的账本回执已核对：${label(result.job)}`
        error.value = ''
        await refresh()
      } else error.value = '原工作区 ZIP 操作已取得精确账本回执；请返回原工作区刷新任务记录。'
    } else if (result.status === 'not-accepted' || rejected) {
      const expired = result.status === 'not-accepted'
      clearPending(operation.draftId)
      error.value = expired
        ? `原操作 ${operation.request.commandId.slice(0, 8)} 未被 Core 接受，旧目标已失效且不会再提交；请重新选择 ZIP 目标与预览。`
        : `原操作 ${operation.request.commandId.slice(0, 8)} 已被明确拒绝且账本无回执；请重新选择 ZIP 目标与预览。`
    } else {
      error.value = restoredFromOtherWindow.value
        ? `旧窗口的原操作 ${operation.request.commandId.slice(0, 8)} 暂无账本回执；旧请求是否仍在途未知，保留原编号，不会重发失效目标或启动新导出。`
        : `原操作 ${operation.request.commandId.slice(0, 8)} 的回执仍未知；当前账本未见接受记录，不能据此新建同目标操作。可核对或重试原编号。`
    }
  } catch {
    if (alive && pendingOperation()?.request === operation.request) error.value = `原操作 ${operation.request.commandId.slice(0, 8)} 的账本暂时无法核对；保留原编号，不启动新导出。`
  }
}
async function restorePending(): Promise<void> {
  const sequence = ++recoverySequence, draftId = props.draftId
  recoveryReady.value = false
  try {
    const overview = await api.getCommandOutbox()
    const epoch = zipWindowEpoch(window.sessionStorage, () => crypto.randomUUID())
    const stored = loadPendingPreparationZip(window.localStorage, overview.datasetId, draftId)
    if (!alive || sequence !== recoverySequence || props.draftId !== draftId) return
    datasetId.value = overview.datasetId; windowEpoch.value = epoch
    if (stored) {
      if (props.workspaces.some(workspace => workspace.id === stored.workspaceId)) workspaceId.value = stored.workspaceId
      restoredFromOtherWindow.value = stored.windowEpoch !== epoch
      if (stored.kind === 'start') { pendingStart.value = stored.request; pendingStartScope.value = { draftId, workspaceId: stored.workspaceId } }
      else { pendingCancel.value = stored.request; pendingCancelScope.value = { draftId, workspaceId: stored.workspaceId } }
      error.value = `已找回原操作 ${stored.request.commandId.slice(0, 8)}；先按完整请求核对 Core 账本。`
    }
    recoveryReady.value = true
    if (stored) await checkOriginalReceipt()
  } catch {
    if (alive && sequence === recoverySequence && props.draftId === draftId) error.value = 'ZIP 原命令或工作库身份暂时无法核验；本页已阻止新的导出，请重试恢复核对。'
  }
}
function clearSelection(): void {
  ++generation; ++refreshSequence
  if (timer) clearTimeout(timer)
  timer = undefined
  target.value = undefined; proposal.value = undefined; confirmed.value = false
  noticeJobId.value = ''; notice.value = ''
  error.value = uncertain.value ? '原工作区的 ZIP 操作回执仍未确认。请保留原操作编号并重试，不能在此状态启动新导出。' : ''
  if (!uncertain.value) busy.value = false
}
function current(token: number, draftId: string, selectedId: string): boolean {
  return alive && token === generation && props.draftId === draftId && workspaceId.value === selectedId
}
watch(workspaceId, () => { clearSelection(); void refresh() })
watch(() => props.draftId, () => {
  ++recoverySequence; pendingStart.value = undefined; pendingStartScope.value = undefined
  pendingCancel.value = undefined; pendingCancelScope.value = undefined; recoveryReady.value = false
  clearSelection(); history.value = undefined; workspaceId.value = ''; void refresh(); void restorePending()
})
watch(() => props.workspaces, workspaces => { if (workspaceId.value && !workspaces.some(workspace => workspace.id === workspaceId.value)) workspaceId.value = '' })
async function refresh(): Promise<void> {
  const draftId = props.draftId, selectedId = workspaceId.value, sequence = ++refreshSequence
  try {
    const result = await api.listPreparationZips(draftId)
    if (!alive || sequence !== refreshSequence || props.draftId !== draftId || workspaceId.value !== selectedId) return
    history.value = result
    if (noticeJobId.value) {
      const job = result.jobs.find(item => item.id === noticeJobId.value && item.workspaceId === selectedId)
      if (job) notice.value = label(job)
    }
    if (timer) clearTimeout(timer)
    if (result.jobs.some(job => job.state === 'running' || job.state === 'cancelling')) timer = setTimeout(() => { void refresh() }, 750)
  } catch { if (alive && sequence === refreshSequence && props.draftId === draftId && workspaceId.value === selectedId) error.value = 'ZIP 任务记录暂时无法读取；已有导出不会因此消失，请刷新。' }
}
async function choose(): Promise<void> {
  if (!selected.value || busy.value || running.value || uncertain.value) return
  const token = ++generation, draftId = props.draftId, selectedId = selected.value.id
  busy.value = true; error.value = ''; noticeJobId.value = ''; target.value = undefined; proposal.value = undefined; confirmed.value = false
  try {
    const result = await api.choosePreparationZipTarget(selectedId)
    if (current(token, draftId, selectedId)) { target.value = result ?? undefined; notice.value = result ? `已选择 ${result.label}；确认前不会写入 ZIP。` : '已取消另存选择。' }
  } catch { if (current(token, draftId, selectedId)) error.value = '另存目标未获授权；请选新的 .zip 文件名，并确认目标目录在线且可写。' }
  finally { if (current(token, draftId, selectedId)) busy.value = false }
}
async function preview(): Promise<void> {
  if (!selected.value || !target.value || busy.value || running.value || uncertain.value) return
  const token = ++generation, draftId = props.draftId, selectedId = selected.value.id
  busy.value = true; error.value = ''; proposal.value = undefined; confirmed.value = false
  try {
    const result = await api.previewPreparationZip({ workspaceId: selectedId, targetId: target.value.id })
    if (current(token, draftId, selectedId)) proposal.value = result
  } catch { if (current(token, draftId, selectedId)) error.value = 'ZIP 预览失败：工作区、原字节或另存目标可能已变化，请重新选择并核验。' }
  finally { if (current(token, draftId, selectedId)) busy.value = false }
}
async function submitStart(): Promise<void> {
  const request = pendingStart.value, scope = pendingStartScope.value
  if (!request || !scope || busy.value || !recoveryReady.value || restoredFromOtherWindow.value) return
  const token = ++generation, draftId = scope.draftId, selectedId = scope.workspaceId
  busy.value = true; error.value = ''
  try {
    const job = await api.startPreparationZip(request)
    if (pendingStart.value !== request) return
    clearPending(draftId)
    if (current(token, draftId, selectedId)) {
      proposal.value = undefined; confirmed.value = false; noticeJobId.value = job.id; notice.value = label(job)
      await refresh()
    } else error.value = '原工作区 ZIP 操作已取得回执；请返回原工作区刷新任务记录。'
  } catch (failure) {
    if (pendingStart.value === request) {
      error.value = '启动回执未确认。正在核对原操作编号；不会自动覆盖目标文件。'
      await checkOriginalReceipt(isPreparationZipRejection(failure))
    }
  }
  finally { if (pendingStart.value === request || !uncertain.value) busy.value = false }
}
function start(): void {
  if (!proposal.value || !confirmed.value || busy.value || running.value || uncertain.value) return
  const request: StartPreparationZipRequest = { commandId: crypto.randomUUID(), workspaceId: proposal.value.workspaceId, targetId: proposal.value.targetId, proposalFingerprint: proposal.value.proposalFingerprint, userConfirmed: true }
  const scope = { draftId: props.draftId, workspaceId: proposal.value.workspaceId }
  try { savePendingPreparationZip(window.localStorage, datasetId.value, { kind: 'start', request, ...scope, windowEpoch: windowEpoch.value }) }
  catch { error.value = '原操作编号无法安全保存；本次没有启动 ZIP 导出。'; return }
  pendingStart.value = request; pendingStartScope.value = scope
  void submitStart()
}
async function submitCancel(): Promise<void> {
  const request = pendingCancel.value, scope = pendingCancelScope.value
  if (!request || !scope || busy.value || !recoveryReady.value || restoredFromOtherWindow.value) return
  const token = ++generation, draftId = scope.draftId, selectedId = scope.workspaceId
  busy.value = true; error.value = ''
  try {
    const job = await api.cancelPreparationZipJob(request)
    if (pendingCancel.value !== request || job.workspaceId !== selectedId) return
    clearPending(draftId)
    if (current(token, draftId, selectedId)) { noticeJobId.value = job.id; notice.value = label(job); await refresh() }
    else error.value = '原工作区 ZIP 取消已取得回执；请返回原工作区刷新任务记录。'
  } catch (failure) {
    if (pendingCancel.value === request) {
      error.value = '取消回执未确认。正在核对原取消编号；不会自动重发其他操作。'
      await checkOriginalReceipt(isPreparationZipRejection(failure))
    }
  }
  finally { if (pendingCancel.value === request || !uncertain.value) busy.value = false }
}
function cancel(): void {
  if (!running.value || busy.value || uncertain.value) return
  const request = { commandId: crypto.randomUUID(), id: running.value.id }
  const scope = { draftId: props.draftId, workspaceId: workspaceId.value }
  try { savePendingPreparationZip(window.localStorage, datasetId.value, { kind: 'cancel', request, ...scope, windowEpoch: windowEpoch.value }) }
  catch { error.value = '原取消编号无法安全保存；本次没有发送取消操作。'; return }
  pendingCancel.value = request; pendingCancelScope.value = scope
  void submitCancel()
}
onMounted(() => { void refresh(); void restorePending() })
onBeforeUnmount(() => { alive = false; ++generation; ++refreshSequence; ++recoverySequence; if (timer) clearTimeout(timer) })
</script>

<template>
  <section class="preparation-zip-panel" aria-labelledby="preparation-zip-title">
    <h3 id="preparation-zip-title">导出 Logic ZIP</h3>
    <p class="muted">将已完成的工作区原字节打包成独立 ZIP，包含 Sources、曲目表、谱系、Manifest 与空的 Bounce Targets。ZIP 不会启动 Logic，也不是 PREP 或正式录音资产。</p>
    <label>选择已完成的工作区
      <select v-model="workspaceId" aria-label="选择 ZIP 工作区" :disabled="busy || !!running || uncertain">
        <option value="">请明确选择工作区</option>
        <option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.id.slice(0, 8) }} · {{ workspace.trackCount }} 首 · {{ new Date(workspace.createdAt).toLocaleString() }}</option>
      </select>
    </label>
    <div v-if="selected" class="zip-actions">
      <button type="button" :disabled="busy || !!running || uncertain" @click="choose">选择 ZIP 另存位置</button>
      <span v-if="target" class="muted">{{ target.label }} · {{ new Date(target.expiresAt).toLocaleTimeString() }} 前有效</span>
      <button type="button" :disabled="busy || !target || !!running || uncertain" @click="preview">预览 ZIP 内容</button>
    </div>
    <div v-if="proposal" class="zip-proposal">
      <p>{{ proposal.fileCount }} 项 · 来源 {{ size(proposal.sourceBytes) }} · 目标 {{ proposal.targetLabel }}</p>
      <p class="muted">工作区 Manifest SHA-256：<code>{{ proposal.manifestHash }}</code></p>
      <label class="zip-check"><input v-model="confirmed" type="checkbox" :disabled="busy">我确认将此工作区打包另存为 ZIP；不覆盖已有文件、不自动处理音频</label>
      <button type="button" class="primary" :disabled="busy || !confirmed || !!running || uncertain" @click="start">确认并生成 ZIP</button>
    </div>
    <p v-if="running" role="status">{{ label(running) }} <button type="button" :disabled="busy || uncertain" @click="cancel">取消导出</button></p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert" class="warning">{{ error }}
      <button v-if="!recoveryReady" type="button" :disabled="busy" @click="restorePending">重试恢复核对</button>
      <template v-else-if="pendingStart || pendingCancel">
        <button type="button" :disabled="busy" @click="checkOriginalReceipt()">核对原操作编号</button>
        <button v-if="pendingStart && !restoredFromOtherWindow" type="button" :disabled="busy" @click="submitStart">重试原启动操作</button>
        <button v-if="pendingCancel && !restoredFromOtherWindow" type="button" :disabled="busy" @click="submitCancel">重试原取消操作</button>
      </template>
      <button v-else type="button" :disabled="busy" @click="refresh">刷新任务记录</button>
    </p>
    <details v-if="jobs.length"><summary>ZIP 导出记录（{{ jobs.length }}）</summary>
      <ul><li v-for="job in jobs" :key="job.id">{{ job.targetLabel }} · {{ label(job) }}<code v-if="job.zipSha256">SHA-256 {{ job.zipSha256 }}</code></li></ul>
    </details>
  </section>
</template>

<style scoped>
.preparation-zip-panel{border-top:1px solid var(--mb-divider);margin-top:24px;padding-top:24px}.preparation-zip-panel h3{font-size:17px;margin:0 0 16px}.preparation-zip-panel p,.preparation-zip-panel li{font-size:13px;line-height:1.75;overflow-wrap:anywhere}.muted{color:var(--mb-text-secondary)}label{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.6}select{box-sizing:border-box;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit}.zip-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:16px 0}.zip-proposal{border:1px solid var(--mb-glass-border);border-radius:12px;padding:16px;margin-top:16px}.zip-check{flex-direction:row;align-items:center;min-height:44px;margin:16px 0}input{accent-color:var(--mb-accent);width:16px;height:16px;flex-shrink:0}button{min-height:44px;padding:9px 15px;border:1px solid var(--mb-glass-border);border-radius:9px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.primary{border-color:var(--mb-accent);color:var(--mb-accent)}button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}.warning{padding:12px;border-left:3px solid var(--mb-accent)}code{display:block;font-size:12px;overflow-wrap:anywhere;color:var(--mb-text-secondary)}summary{min-height:44px;padding:12px 0;box-sizing:border-box;cursor:pointer}
</style>
