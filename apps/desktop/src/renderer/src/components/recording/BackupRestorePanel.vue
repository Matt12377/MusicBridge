<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { BackupOverview, BackupRootKind, BackupMode, BackupJobView, BackupJobIssue, BackupIndexIssueCode, BackupIndexMissingFact, StartBackupJob, RestoreActivationView } from '@music-bridge/contracts'
const emit = defineEmits<{ close: []; activated: [] }>()
const api = window.musicBridge, dialog = ref<HTMLDialogElement>()
const overview = shallowRef<BackupOverview>({ roots: [], jobs: [], activations: [] })
const busy = ref(false), loading = ref(true), error = ref('')
const pending = shallowRef<() => Promise<unknown>>()
const blocked = computed(() => busy.value || !!pending.value)
const backupRootId = ref(''), sourceRootId = ref(''), restoreRootId = ref(''), mode = ref<BackupMode | ''>('')
const backupConfirmed = ref(false), restoreConfirmed = ref(false), activationConfirmed = ref(false)
const activationRestoreId = ref(''), pendingActivation = ref(false)
const restoreCandidates = computed(() => overview.value.jobs.filter(job => job.kind === 'restore' && job.state === 'succeeded'))
const activationRunning = computed(() => overview.value.activations.some(item => ['preparing', 'prepared', 'activating'].includes(item.state)))
const selectedRestore = computed(() => restoreCandidates.value.find(job => job.id === activationRestoreId.value))
const canActivate = computed(() => !!selectedRestore.value && activationConfirmed.value && !blocked.value && !loading.value && !activationRunning.value && !overview.value.activations.some(item => item.restoreJobId === activationRestoreId.value && item.state === 'active'))
const activationLabels: Record<RestoreActivationView['state'], string> = {
  preparing: '正在复制为新的工作库；当前播放暂不改变。', prepared: '工作库副本已准备，等待停止播放并重启 Core。', activating: 'Core 正在核验并切换工作库，请稍候。',
  active: '已切换到恢复工作库；旧库保留，播放不会自动恢复。', superseded: '此工作库已被后续切换替代，旧库仍保留。',
  failed: '工作库准备失败；当前工作库未切换，不会自动重试。', 'rolled-back': '工作库切换未完成，已回滚到之前的工作库；播放不会自动恢复。',
}
const available = (kind: BackupRootKind) => overview.value.roots.filter(root => root.kind === kind && root.authorized)
const verified = computed(() => overview.value.jobs.find(job => job.kind === 'verify' && job.rootId === sourceRootId.value))
const canRestore = computed(() => verified.value?.state === 'succeeded' && !!restoreRootId.value && restoreConfirmed.value && !blocked.value)
const rootLabel = (id: string) => overview.value.roots.find(root => root.id === id)?.label ?? '目录不可用'
const active = (job: BackupJobView) => ['queued', 'running', 'cancelling'].includes(job.state)
const kinds = { backup: '备份', verify: '校验备份', restore: '隔离恢复', index: '重建基本索引' }
const issues: Record<BackupJobIssue, string> = {
  BACKUP_DESTINATION_INVALID: '目标目录不可用或与受保护目录重叠', BACKUP_INCOMPLETE: '归档或备份内容未完成', BACKUP_INVALID: '内容、清单或数据库校验不一致', BACKUP_IO_ERROR: '文件操作未完成，请检查目录和剩余空间', AUTHORIZATION_REVOKED: '目录授权已撤销', CANCELLED: '已取消；部分文件保留，不会自动覆盖重试', INTERRUPTED: '应用关闭或任务中断；不会自动续写',
}
const indexIssues: Record<BackupIndexIssueCode, string> = {
  MANIFEST_INVALID: '清单无效，无法纳入候选索引', OBJECT_MISSING: '引用对象缺失，归档候选需隔离检查', OBJECT_INVALID: '引用对象内容校验失败，归档候选需隔离检查',
}
const missingFacts: Record<BackupIndexMissingFact, string> = {
  'physical-recording-completion': '实体录音完成事实', 'inventory-and-ledger': '库存与账本', 'frozen-version-records': '冻结版本记录',
  'profile-snapshots-and-user-confirmations': '设备参数快照与用户确认', 'directory-authorizations': '目录授权',
}
function stateLabel(job: BackupJobView): string {
  if (job.issue) return issues[job.issue]
  if (job.state === 'queued') return '已接受确认，等待执行'
  if (job.state === 'running') return '正在处理文件，可取消'
  if (job.state === 'cancelling') return '正在取消，等待文件操作安全结束'
  if (job.kind === 'restore') return overview.value.activations.some(item => item.restoreJobId === job.id && item.state === 'active') ? '隔离恢复副本已用于当前工作库；原副本保留。' : '隔离恢复已完成；当前工作库未切换。'
  if (job.kind === 'verify') return '备份完整性核验通过'
  if (job.kind === 'index') return '基本索引已读取；历史事实仍需审核'
  return job.summary?.mode === 'metadata' ? '元数据备份已完成；不含音频字节' : '归档内容备份已完成'
}
let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
watch([backupRootId, mode], () => { backupConfirmed.value = false })
watch([sourceRootId, restoreRootId], () => { restoreConfirmed.value = false })
watch(activationRestoreId, () => { activationConfirmed.value = false })
async function refresh(): Promise<void> {
  const token = ++generation
  if (timer) clearTimeout(timer)
  try {
    const value = await api.getBackupOverview()
    if (!alive || token !== generation) return
    overview.value = value
    if (!restoreCandidates.value.some(job => job.id === activationRestoreId.value)) activationRestoreId.value = restoreCandidates.value[0]?.id ?? ''
    if (!available('backup-destination').some(root => root.id === backupRootId.value)) backupRootId.value = available('backup-destination')[0]?.id ?? ''
    if (!available('backup-source').some(root => root.id === sourceRootId.value)) sourceRootId.value = available('backup-source')[0]?.id ?? ''
    if (!available('restore-destination').some(root => root.id === restoreRootId.value)) restoreRootId.value = available('restore-destination')[0]?.id ?? ''
  } catch { if (alive && token === generation && !(busy.value && pendingActivation.value)) error.value = '状态暂时无法读取，已有记录仍保留；请刷新重试。' }
  finally {
    if (alive && token === generation) {
      loading.value = false
      if (overview.value.jobs.some(active) || activationRunning.value || busy.value && pendingActivation.value) timer = setTimeout(() => { void refresh() }, 700)
    }
  }
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''; if (pendingActivation.value) void refresh()
  try {
    await pending.value()
    if (alive) { pending.value = undefined; pendingActivation.value = false; backupConfirmed.value = false; restoreConfirmed.value = false; activationConfirmed.value = false; await refresh() }
  } catch (cause) {
    if (!alive) return
    if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(cause instanceof Error ? cause.message : '')) {
      pending.value = undefined; pendingActivation.value = false; backupConfirmed.value = false; restoreConfirmed.value = false; activationConfirmed.value = false
      error.value = '请求未被接受，请重新确认目录授权、备份范围和校验状态。'; await refresh()
    } else error.value = '操作回执尚未确认，请重试原操作；不会重复创建副本或再次切换已激活的工作库。'
  } finally { if (alive) busy.value = false }
}
function mutate(operation: () => Promise<unknown>): void { if (blocked.value) return; pending.value = operation; void retry() }
function choose(kind: BackupRootKind): void {
  const request = { commandId: crypto.randomUUID(), kind }
  mutate(async () => {
    const root = await api.chooseBackupRoot(request)
    if (!alive || !root) return
    if (kind === 'backup-destination') backupRootId.value = root.id
    else if (kind === 'backup-source') sourceRootId.value = root.id
    else restoreRootId.value = root.id
  })
}
function start(kind: 'backup' | 'verify' | 'restore' | 'index'): void {
  const base = { commandId: crypto.randomUUID(), rootId: kind === 'backup' ? backupRootId.value : sourceRootId.value, userConfirmed: true as const }
  let request: StartBackupJob
  if (kind === 'backup') { if (!backupConfirmed.value || !mode.value || !backupRootId.value) return; request = { ...base, kind, mode: mode.value } }
  else if (kind === 'restore') { if (!canRestore.value || !verified.value) return; request = { ...base, kind, destinationId: restoreRootId.value, verificationId: verified.value.id } }
  else { if (!sourceRootId.value) return; request = { ...base, kind } }
  mutate(() => api.startBackupJob(request))
}
function activate(): void {
  if (!canActivate.value) return
  const request = { commandId: crypto.randomUUID(), restoreJobId: activationRestoreId.value, expectedActiveId: overview.value.activations.find(item => item.state === 'active')?.id ?? null, userConfirmed: true as const, stopPlaybackConfirmed: true as const }
  pendingActivation.value = true
  mutate(async () => {
    const result = await api.activateRestoredDataset(request)
    if (alive && result.state === 'active') emit('activated')
  })
}
function cancel(id: string): void { const request = { commandId: crypto.randomUUID(), id }; mutate(() => api.cancelBackupJob(request)) }
function revoke(id: string): void { const request = { commandId: crypto.randomUUID(), id }; mutate(() => api.revokeBackupRoot(request)) }
function close(): void { if (blocked.value) return; dialog.value?.close(); emit('close') }
onMounted(async () => { await nextTick(); dialog.value?.showModal(); dialog.value?.querySelector<HTMLElement>('#backup-title')?.focus(); void refresh() })
onUnmounted(() => { alive = false; ++generation; if (timer) clearTimeout(timer); dialog.value?.close() })
</script>

<template>
  <dialog ref="dialog" class="backup-panel" aria-labelledby="backup-title" @cancel.prevent="close">
    <header><div><p class="kicker">录音资料维护</p><h2 id="backup-title" tabindex="-1">备份与恢复</h2></div><button :disabled="blocked" @click="close">返回录音</button></header>
    <div class="boundary"><strong>文件由你确认后写入，已有文件不覆盖。</strong><p>仅备份所选范围；未归档的外部源文件、工作副本、账号凭据和 Roon 会话不包含在内。隔离恢复不会切换当前工作库，也不会恢复旧目录权限。</p></div>
    <div class="actions"><button :disabled="busy" @click="refresh">刷新备份恢复状态</button><span v-if="loading" role="status">正在读取维护记录…</span></div>
    <div v-if="error || pending" class="feedback" aria-live="polite"><p v-if="error" role="alert">{{ error }}</p><button v-if="pending && !busy" @click="retry">重试备份恢复原操作</button><p v-if="pending">当前确认尚未收到完整回执，请先重试原操作再关闭窗口。</p></div>
    <section aria-labelledby="backup-create-heading"><h3 id="backup-create-heading">创建备份</h3>
      <fieldset :disabled="blocked || loading"><legend class="sr-only">备份范围与目标</legend>
        <button @click="choose('backup-destination')">选择备份目标目录</button>
        <div class="fields"><label>备份目标<select v-model="backupRootId"><option value="">请选择目标</option><option v-for="root in available('backup-destination')" :key="root.id" :value="root.id">{{ root.label }} · {{ root.id.slice(0,8) }}</option></select></label>
          <label>备份范围<select v-model="mode"><option value="">请选择范围</option><option value="metadata">仅元数据与清单（不含音频）</option><option value="archive-content">元数据、清单与已归档音频</option></select></label></div>
        <p class="muted">完整内容范围只包含已成功归档的内容对象；不是整台电脑或所有原始音乐目录的备份。</p>
        <label class="check"><input v-model="backupConfirmed" type="checkbox">我确认备份所选范围到新建子目录，不覆盖已有文件</label>
        <button class="primary" :disabled="!backupRootId || !mode || !backupConfirmed" @click="start('backup')">确认并开始备份</button>
      </fieldset>
    </section>
    <section aria-labelledby="backup-restore-heading"><h3 id="backup-restore-heading">校验与隔离恢复</h3>
      <fieldset :disabled="blocked || loading"><legend class="sr-only">备份来源与恢复目标</legend>
        <button @click="choose('backup-source')">选择已有备份目录</button>
        <label>待检查备份<select v-model="sourceRootId"><option value="">请选择备份来源</option><option v-for="root in available('backup-source')" :key="root.id" :value="root.id">{{ root.label }} · {{ root.id.slice(0,8) }}</option></select></label>
        <div class="actions"><button :disabled="!sourceRootId" @click="start('verify')">校验所选备份</button><button :disabled="!sourceRootId" @click="start('index')">检查基本索引</button></div>
        <p class="muted">校验和索引检查只读取所选目录。缺少数据库时，基本索引不能还原库存账本、完成事实或历史确认。</p>
        <button @click="choose('restore-destination')">选择隔离恢复目标目录</button>
        <label>隔离恢复目标<select v-model="restoreRootId"><option value="">请选择恢复目标</option><option v-for="root in available('restore-destination')" :key="root.id" :value="root.id">{{ root.label }} · {{ root.id.slice(0,8) }}</option></select></label>
        <p v-if="verified?.state !== 'succeeded'" class="muted">请先成功校验所选备份，再确认恢复。</p>
        <label class="check"><input v-model="restoreConfirmed" type="checkbox">我确认创建隔离恢复副本，当前工作库保持不变</label>
        <button class="primary" :disabled="!canRestore" @click="start('restore')">确认并隔离恢复</button>
      </fieldset>
    </section>
    <section aria-labelledby="backup-activation-heading" :aria-busy="busy && pendingActivation"><h3 id="backup-activation-heading">切换到恢复工作库</h3>
      <p>这是隔离恢复之后的独立确认：复制一份新的收藏与录音工作库，再停止播放并重启 Core。旧工作库和隔离恢复包保留，不覆盖；旧目录权限不会恢复，账号和 Roon 继续沿用原安全配置。</p>
      <p class="muted">切换会丢弃未保存的录音编辑。完成后不会自动播放，请检查工作库和播放设备后再手动播放。</p>
      <fieldset :disabled="blocked || loading || activationRunning"><legend class="sr-only">工作库切换确认</legend>
        <label>待激活的隔离恢复<select v-model="activationRestoreId"><option value="">请选择已完成的隔离恢复</option><option v-for="job in restoreCandidates" :key="job.id" :value="job.id">{{ job.createdAt }} · {{ job.id.slice(0,8) }}</option></select></label>
        <p v-if="selectedRestore?.summary?.mode === 'metadata'" class="muted">此恢复仅含元数据与清单，不包含音频字节；切换工作库不会使缺失音频变为可用。</p>
        <label class="check"><input v-model="activationConfirmed" type="checkbox">我确认停止播放、重启 Core 并复制为新工作库；保留旧库，丢弃未保存的录音编辑</label>
        <button class="primary" :disabled="!canActivate" @click="activate">确认停止播放并切换工作库</button>
      </fieldset>
      <p v-if="busy && pendingActivation" role="status">正在准备工作库并等待 Core 安全重启，请勿关闭应用。大库核验可能需要较长时间。</p>
      <article v-for="activation in overview.activations" :key="activation.id" class="job"><h4>工作库切换 · {{ activation.id.slice(0,8) }}</h4>
        <p role="status">{{ activationLabels[activation.state] }}</p>
        <p v-if="activation.contentIncluded === false" class="muted">仅元数据与清单，不含音频字节。</p>
        <p v-if="activation.issue" class="muted">{{ activation.issue === 'PREPARATION_INTERRUPTED' || activation.issue === 'BOOT_INTERRUPTED' ? '上次操作被中断，未完成副本保留。' : '文件核验或启动未通过，请检查后重新明确确认。' }}</p>
      </article>
    </section>
    <section aria-labelledby="backup-history-heading"><h3 id="backup-history-heading">维护记录</h3><p v-if="!overview.jobs.length" class="muted">尚无备份或恢复任务。</p>
      <article v-for="job in overview.jobs" :key="job.id" class="job"><h4>{{ kinds[job.kind] }} · {{ rootLabel(job.rootId) }}</h4><p :role="active(job) ? 'status' : undefined">{{ stateLabel(job) }}</p><p class="muted">{{ job.createdAt }} · {{ job.id.slice(0,8) }}</p>
        <p v-if="job.summary">{{ job.summary.mode === 'metadata' ? '仅元数据，不含音频' : '包含归档内容' }} · {{ job.summary.operationCount }} 条归档 · {{ job.summary.objectCount }} 个引用对象</p>
        <p v-if="job.index">{{ job.index.operationCount }} 条候选 · {{ job.index.quarantinedCount }} 条待隔离检查 · {{ job.index.issueCount }} 个问题。历史与库存未重建。</p>
        <details v-if="job.index" class="index-details"><summary>查看索引问题与未知事实</summary>
          <p class="muted">隔离标记仅表示候选需检查；没有移动、删除或修复原文件。字节校验通过也不代表历史事实可信。</p>
          <p v-if="job.index.issueCount === 0">未发现清单或对象内容问题；以下历史事实仍然未知。</p>
          <p v-else>显示 {{ job.index.issueDetails.length }} / {{ job.index.issueCount }} 个问题<span v-if="job.index.issueDetailsOmittedCount">；明细已截断，另有 {{ job.index.issueDetailsOmittedCount }} 个问题未展示</span>。</p>
          <ol v-if="job.index.issueDetails.length" class="index-issues" aria-label="索引问题明细">
            <li v-for="(issue, position) in job.index.issueDetails" :key="position"><strong>{{ indexIssues[issue.code] }}</strong>
              <p>归档操作：<code v-if="issue.operationId">{{ issue.operationId }}</code><span v-else>未知，无法从清单确认</span></p>
              <p v-if="issue.sha256">对象 SHA-256：<code>{{ issue.sha256 }}</code></p>
            </li>
          </ol>
          <p><strong>仅凭基本索引无法重建：</strong></p><ul aria-label="基本索引无法重建的事实"><li v-for="fact in job.index.missingFacts" :key="fact">{{ missingFacts[fact] }}</li></ul>
        </details>
        <button v-if="active(job)" :disabled="blocked || job.state === 'cancelling'" @click="cancel(job.id)">取消此任务</button>
      </article>
    </section>
    <details><summary>已授权目录与撤权</summary><p class="muted">撤权会停止使用该目录的未完成任务；已写入文件保留，不自动清理。</p><div v-for="root in overview.roots" :key="root.id" class="root"><span>{{ root.label }} · {{ root.id.slice(0,8) }} · {{ root.authorized ? '已授权' : '已撤权' }}</span><button v-if="root.authorized" :disabled="blocked" @click="revoke(root.id)">撤销此目录授权</button></div></details>
  </dialog>
</template>

<style scoped>
.index-details{border-top:1px solid var(--mb-glass-border);margin-top:12px;padding-top:8px}.index-details ul,.index-issues{padding-left:24px;font-size:13px;line-height:1.75}.index-issues li{padding:8px 0;overflow-wrap:anywhere}.index-issues code{font-size:12px;overflow-wrap:anywhere;white-space:normal}
.backup-panel{box-sizing:border-box;width:min(900px,calc(100vw - 40px));max-height:calc(100dvh - 36px);padding:28px;border:1px solid var(--mb-glass-border);border-radius:18px;background:var(--mb-bg-base);color:var(--mb-text-primary);overflow:auto;overscroll-behavior:contain}.backup-panel::backdrop{background:rgb(0 0 0 / .66)}header,.actions,.root{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}header{align-items:flex-start;margin-bottom:20px}.actions{justify-content:flex-start;margin:16px 0}.kicker{font-size:12px;color:var(--mb-accent);margin:0 0 8px}h2{font-size:24px;line-height:1.35;margin:0}h3{font-size:19px;margin:0 0 16px}h4{font-size:15px;margin:0;overflow-wrap:anywhere}p{font-size:14px;line-height:1.75;overflow-wrap:anywhere}.muted{font-size:13px;color:var(--mb-text-secondary)}.boundary{padding:16px 18px;border-left:3px solid var(--mb-accent);background:var(--mb-glass-clear)}.boundary p{margin:8px 0 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}section{border-top:1px solid var(--mb-glass-border);padding-top:24px;margin-top:24px}fieldset{border:0;min-width:0;padding:0}label{display:grid;gap:8px;font-size:13px;min-width:0;margin:12px 0}.check{display:flex;align-items:flex-start;gap:10px;line-height:1.75;min-height:44px;cursor:pointer}.check input{width:18px;height:18px;flex-shrink:0;margin-top:3px;accent-color:var(--mb-accent)}button,select{box-sizing:border-box;min-height:44px;padding:9px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px;min-width:0}select{width:100%}button{cursor:pointer;overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:not-allowed}.primary{background:var(--mb-accent);color:var(--mb-bg-deep);border-color:var(--mb-accent);font-weight:600}.feedback{padding:16px;border:1px solid var(--mb-glass-border);border-radius:10px}.job{padding:16px;margin:16px 0;border:1px solid var(--mb-glass-border);border-radius:10px}.job p{margin:8px 0}.root{margin:12px 0;font-size:13px;overflow-wrap:anywhere}summary{cursor:pointer;min-height:44px;line-height:44px;font-size:14px}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}@media(max-width:600px){.backup-panel{width:calc(100vw - 24px);padding:20px}.fields{grid-template-columns:1fr;gap:8px}}@media(hover:hover) and (pointer:fine){button:not(:disabled):hover{border-color:var(--mb-accent)}}
</style>
