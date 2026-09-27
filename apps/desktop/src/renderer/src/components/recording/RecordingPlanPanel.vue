<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { MasterDraft, RecordingPreflightCheck, RecordingSessionOverrides } from '@music-bridge/contracts'
import { createRecordingPlanController, type RecordingPlanContext } from './recording-plan-controller'
import RecordingOutputPanel from './RecordingOutputPanel.vue'
import RecordingAttemptPanel from './RecordingAttemptPanel.vue'

const props = defineProps<{ draft: MasterDraft; initialContext?: RecordingPlanContext; inline?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>(), historyPage = ref(0)
const attemptPanel = ref<{ canLeave(): boolean; leaveBlockReason(): string | null }>()
const attemptLeave = ref<{ canLeave: boolean; reason: string | null }>({ canLeave: true, reason: null })
const leaveError = ref('')
const controller = createRecordingPlanController({ api: window.musicBridge, draftId: props.draft.id, initialContext: props.initialContext, onChange: () => { state.value = { ...controller.state } } })
const state = shallowRef({ ...controller.state })
const blocked = computed(() => state.value.status === 'loading' || state.value.reading || state.value.sending || state.value.selectingDevice || !!state.value.pending || !attemptLeave.value.canLeave)
const closeBlocked = computed(() => state.value.sending || !!state.value.pending || !attemptLeave.value.canLeave)
const assets = computed(() => { void state.value; return controller.assets() })
const archives = computed(() => { void state.value; return controller.archives() })
const canPreview = computed(() => { void state.value; return !blocked.value && !!controller.selection() })
const shown = computed(() => state.value.proposal ?? state.value.version)
const settings = computed(() => shown.value?.profileSnapshot.settings)
const history = computed(() => state.value.versions.slice(historyPage.value * 12, (historyPage.value + 1) * 12))
const modes = { direct: 'Direct 编译', 'direct-converted': 'Direct 转换', 'prepared-reference': 'PREP 原件引用', 'prepared-derivative': 'PREP 独立派生' }
const categories: Record<RecordingPreflightCheck['category'], string> = { versions: '母版与布局版本', sources: '实际源文件', execution: '执行资产', archive: '归档完整性', 'physical-copy': '实体副本与预留', capacity: '时间线与容量', profile: '参数与设备兼容', backend: '输出后端 Gate B' }
const reasons: Record<string, string> = {
  VERSION_MISMATCH: '冻结版本或谱系不一致', SOURCE_INVALID: '实际源文件或授权不可用', EXECUTION_INVALID: '执行资产完整性未通过', ARCHIVE_INVALID: '归档文件或授权不可用', COPY_UNAVAILABLE: '实体副本或预留不可用', CAPACITY_EXCEEDED: '容量不足', PROFILE_MISMATCH: '参数或格式不一致', COMPATIBILITY_UNCONFIRMED: '设备兼容尚未确认', BACKEND_NOT_CERTIFIED: '输出后端尚未获得 Gate B 认证', NOT_CHECKED: '本项尚未核验', READ_FAILED: '本项读取失败',
}
const short = (value: string) => value.slice(-8)
const sourcePolicy = (value: string) => value === 'preserve-exact-sources' ? '已明确复制精确曲目源' : '曲目源仍依赖外部引用'
const valueText = (value: string | number | null | undefined) => value == null ? '未设置' : String(value)
function overrideText(key: keyof RecordingSessionOverrides): string {
  const value = settings.value?.overrides[key]
  return value === undefined ? '继承此版本默认值' : value === null ? '本次明确未设置' : Array.isArray(value) ? value.map(step => step.label).join(' → ') : String(value)
}
function selectAsset(event: Event): void { controller.selectAsset((event.target as HTMLSelectElement).value) }
function selectArchive(event: Event): void { controller.selectArchive((event.target as HTMLSelectElement).value) }
function selectDevice(event: Event): void { void controller.selectDevice((event.target as HTMLSelectElement).value) }
function confirm(event: Event): void { controller.confirm((event.target as HTMLInputElement).checked) }
function onAttemptLeave(value: { canLeave: boolean; reason: string | null }): void {
  attemptLeave.value = value
  if (value.canLeave) leaveError.value = ''
}
function canLeaveAttempt(): boolean {
  if (typeof attemptPanel.value?.canLeave !== 'function' || attemptPanel.value.canLeave()) return true
  leaveError.value = attemptPanel.value.leaveBlockReason() ?? '当前正式输出或命令回执尚未收口；请先核对并停止本次运行。'
  return false
}
function readVersion(id: string): void { if (canLeaveAttempt() && !blocked.value) void controller.readVersion(id) }
function close(): void {
  if (!canLeaveAttempt() || closeBlocked.value) return
  if (!props.inline) dialog.value?.close(); emit('close')
}
defineExpose({ canLeave: () => !closeBlocked.value && canLeaveAttempt(), leaveBlockReason: () => attemptLeave.value.reason ?? (state.value.sending || state.value.pending ? '计划冻结回执尚未确认；请保留本页核对原操作。' : null) })
onMounted(async () => { await nextTick(); if (!props.inline) dialog.value?.showModal(); void controller.refresh() })
onBeforeUnmount(() => { controller.dispose(); if (!props.inline) dialog.value?.close() })
</script>

<template>
  <component :is="inline ? 'section' : 'dialog'" ref="dialog" class="recording-plan-panel" :class="{ 'is-inline': inline }" data-testid="recording-plan-panel" aria-labelledby="recording-plan-title" @cancel.prevent="close">
    <header class="heading"><div><p class="kicker">{{ draft.title }} · 计划身份与只读预检</p><h3 id="recording-plan-title">计划与预检</h3></div><button type="button" :disabled="closeBlocked" @click="close">关闭计划与预检</button></header>
    <p v-if="!attemptLeave.canLeave" role="alert">{{ attemptLeave.reason ?? '当前正式输出或命令回执尚未收口，请保留本页核对。' }}</p>
    <div class="boundary" role="note"><strong>计划冻结不等于正式输出资格。</strong><p>冻结只保存本次计划身份和参数快照，不开始录音、不播放、不改变库存使用状态。设备选择与预检均需针对当前事实；开始正式输出时 Core 会再次核验 Gate B。</p></div>
    <details class="retention"><summary>已确认的 F-01 保留政策</summary><p>成功的实际执行音频及谱系永久保留，PREP 原始 Render 永久保留。原始曲目源按明确的归档政策处理；失败或取消不自动删除文件。完整备份包含归档音频；缺少依赖时不承诺能够重建。</p><p>旧记录仍保留当时的事实，本次计划记录 f01-permanent-execution-v1。</p></details>
    <fieldset :disabled="blocked">
      <legend>1 · 明确选择本次输出设备</legend>
      <p class="muted">只读候选由当前 Core 枚举；不会自动选默认设备。重新选择会产生新的内存代际，已有提案与预检须重新核对。</p>
      <p v-if="state.deviceStatus === 'unread' || state.deviceStatus === 'loading'" role="status">正在读取输出设备候选；尚未打开设备。</p>
      <p v-else-if="state.deviceStatus === 'error'" role="alert">{{ state.deviceError }}</p>
      <template v-else-if="state.deviceCandidates">
        <p v-if="state.deviceCandidates.blockedReason" role="status">设备候选暂不可用：{{ state.deviceCandidates.blockedReason }}；没有自动改用默认输出。</p>
        <label for="plan-output-device">本次输出端点</label>
        <select id="plan-output-device" :value="state.outputSelection?.endpointId ?? ''" :disabled="state.selectingDevice || !state.deviceCandidates.candidates.some(item => item.available)" @change="selectDevice"><option value="">请明确选择一个可用端点</option><option v-for="candidate in state.deviceCandidates.candidates" :key="candidate.endpointId" :value="candidate.endpointId" :disabled="!candidate.available">{{ candidate.label }}{{ candidate.available ? '' : '（当前不可用）' }}</option></select>
        <p v-if="state.outputSelection" class="muted">本次选择 {{ state.outputSelection.endpointId }} · 代际 {{ short(state.outputSelection.selectionGeneration) }}。此选择本身不代表 Gate B 已认证。</p>
      </template>
      <p v-if="state.deviceError && state.deviceStatus !== 'error'" role="alert">{{ state.deviceError }}</p>
      <button type="button" :disabled="state.selectingDevice" @click="controller.refreshDevice">重新读取设备候选</button>
    </fieldset>
    <fieldset :disabled="blocked || state.status !== 'ready'">
      <legend>2 · 明确选择本次执行资产与归档</legend>
      <p class="muted">不会自动挑选首条或最近一条。这里只列出本草稿中符合明确布局与路径的资产；归档必须属于所选资产并已 FINALIZED。历史状态不代表文件此刻仍然可读。</p>
      <label for="plan-asset">本次执行资产</label><select id="plan-asset" :value="state.assetId" @change="selectAsset"><option value="">请明确选择一个执行资产</option><option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ modes[asset.mode] }} · L {{ short(asset.layoutVersionId) }} · 资产 {{ short(asset.id) }} · {{ asset.createdAt }}</option></select>
      <label for="plan-archive">本次 FINALIZED 归档</label><select id="plan-archive" :value="state.archiveOperationId" :disabled="!state.assetId" @change="selectArchive"><option value="">请明确选择此资产的一份归档</option><option v-for="operation in archives" :key="operation.id" :value="operation.id">归档 {{ short(operation.id) }} · {{ sourcePolicy(operation.sourcePolicy) }}</option></select>
      <p v-if="state.status === 'ready' && !assets.length" class="muted">当前上下文没有可选执行资产。请先回到“录音参数与执行资产”核对布局、参数与资产，不会改用其他历史。</p>
      <p v-if="state.assetId && !archives.length" class="muted">所选资产尚无已完成的归档。请在执行资产工具中明确归档并核验。</p>
      <button type="button" :disabled="!canPreview" @click="controller.preview">核对设备、资产与归档</button>
    </fieldset>
    <section v-if="shown && settings" class="snapshot" aria-labelledby="plan-snapshot-title">
      <h4 id="plan-snapshot-title">{{ state.proposal ? '3 · 核对本次冻结提案' : '已冻结的计划与参数快照' }}</h4>
      <p v-if="state.proposal">提案核验时间：{{ state.proposal.checkedAt }}。确认时 Core 会重新核验完整输入；读取失败或内容改变不能沿用旧提案。</p>
      <p v-else-if="state.version">计划第 {{ state.version.sequence }} 版 · {{ state.version.id }} · {{ state.version.createdAt }}</p>
      <dl><dt>母版 / 布局</dt><dd>M{{ shown.master.sequence }} {{ shown.master.title }} / L{{ shown.layout.sequence }}</dd><dt>执行资产</dt><dd>{{ shown.execution.assetId }} · {{ modes[shown.execution.mode] }}</dd><dt>精确归档</dt><dd>{{ shown.archive.operationId }} · {{ sourcePolicy(shown.archive.sourcePolicy) }}</dd><dt>实体副本</dt><dd>{{ shown.physicalCopy.physicalId }} · {{ valueText(shown.physicalCopy.lengthMinutes) }} 分钟 · {{ shown.physicalCopy.packaging === 'sealed' ? '未开封' : '已开封' }} · 冻结时已预留</dd><dt>Profile 版本</dt><dd>{{ settings.profile.content.name }} · 第 {{ settings.profile.sequence }} 版 · {{ settings.profile.id }}</dd><dt>本次参数版本</dt><dd>{{ shown.profileSnapshot.sessionRevision }}</dd></dl>
      <h5>固定执行格式与后端</h5>
      <p>{{ settings.format.sampleRate }} Hz · {{ settings.format.channelCount }} 声道 / {{ settings.format.channelLayout }} · {{ settings.format.outputSampleFormat }}</p>
      <p>内部精度 {{ settings.format.internalProcessingPrecision }} · 重采样 {{ settings.format.resamplerImplementation }} / {{ settings.format.resamplerVersion }} · Dither {{ settings.format.ditherPolicy }} · 声道映射 {{ settings.format.channelMapping }}</p>
      <p>后端 {{ settings.format.outputBackend.id }} / {{ settings.format.outputBackend.version }} · 输出 Profile {{ settings.format.outputProfileVersion }}。这些是计划参数，不是认证证据。</p>
      <p v-if="shown.outputBinding">冻结输出端点 {{ shown.outputBinding.endpointId }} · 后端 {{ shown.outputBinding.backendId }} / {{ shown.outputBinding.backendVersion }}。设备 UID 与配置指纹保存在计划中，预检和开始时重新核对。</p><p v-else class="muted">旧计划没有冻结输出设备身份；不能从当前选择反填历史计划。</p>
      <h5>本次有效参数与 Overrides</h5>
      <dl><dt>降噪</dt><dd>{{ valueText(settings.effective.noiseReduction) }} · {{ overrideText('noiseReduction') }}</dd><dt>校准</dt><dd>{{ valueText(settings.effective.calibration) }} · {{ overrideText('calibration') }}</dd><dt>录音电平</dt><dd>{{ valueText(settings.effective.recordLevel) }} · {{ overrideText('recordLevel') }}</dd><dt>前置等待</dt><dd>{{ settings.effective.preRollMs }} ms</dd><dt>有效设备链</dt><dd>{{ settings.effective.signalChain.map(step => step.label).join(' → ') || '未设置' }} · {{ overrideText('signalChain') }}</dd></dl>
      <details><summary>查看时间线与完整性摘要</summary><p>规划时间线 Hash <code>{{ shown.layout.timelineHash }}</code></p><p v-for="side in shown.layout.timeline.sides" :key="side.name">{{ side.name }} · {{ side.totalFrames }} / {{ side.capacityFrames }} 帧</p><p v-if="shown.prepared">PREP {{ shown.prepared.id }} · {{ shown.prepared.conformance.status }} · Render Timeline <code>{{ shown.prepared.renderTimelineHash }}</code></p><p>执行 Manifest <code>{{ shown.execution.manifestHash }}</code></p><p>归档 Manifest <code>{{ shown.archive.manifestHash }}</code> · {{ shown.archive.objectCount }} 个内容对象 · {{ shown.archive.copyBytes }} 字节</p><p>本次参数指纹 <code>{{ settings.fingerprint }}</code></p><p v-if="state.version && !state.proposal">计划 Hash <code>{{ state.version.contentHash }}</code></p><p v-if="state.proposal">提案指纹 <code>{{ state.proposal.proposalFingerprint }}</code></p></details>
      <div v-if="state.proposal" class="confirmation"><label class="check" for="plan-confirm"><input id="plan-confirm" type="checkbox" :checked="state.confirmed" :disabled="blocked" @change="confirm">我已核对资产、归档、实体副本与完整参数；确认冻结此计划，不开始录音</label><button type="button" class="primary" :disabled="blocked || !state.confirmed" @click="controller.freeze">确认并冻结计划</button></div>
      <p v-else class="muted">此快照永久属于本次计划。之后更改默认参数或本次会话不会修改历史快照；变更执行内容、格式或后端必须重新冻结新计划。</p>
    </section>
    <section v-if="state.version" class="preflight" aria-labelledby="plan-preflight-title">
      <h4 id="plan-preflight-title">4 · 只读预检</h4><p>当前选择：计划第 {{ state.version.sequence }} 版 · {{ state.version.id }}。每次检查当前文件、授权、实体预留与兼容事实，不改写冻结快照。</p>
      <button type="button" :disabled="blocked" @click="controller.preflight">重新执行只读预检</button>
      <p v-if="!state.preflight">需预检；尚无本次正式输出资格事实。</p>
      <div v-else role="status"><p><strong>{{ state.preflight.formalReady ? '本次预检就绪；开始时仍须复核' : '本次预检阻断正式输出' }}</strong> · Gate B {{ state.preflight.gateB }} · 核验时间 {{ state.preflight.checkedAt }}</p><ul class="checks"><li v-for="check in state.preflight.checks" :key="check.category"><strong>{{ categories[check.category] }}</strong>：{{ check.state === 'passed' ? '本次核验通过' : check.state === 'blocked' ? '阻断' : '尚未完成' }}<span v-if="check.code"> · {{ reasons[check.code] ?? check.code }}（{{ check.code }}）</span></li></ul></div>
    </section>
    <RecordingOutputPanel :plan="state.version" />
    <RecordingAttemptPanel ref="attemptPanel" :plan="state.version" @leave-state="onAttemptLeave" />
    <p v-if="leaveError" role="alert">{{ leaveError }}</p>
    <div v-if="state.reading" role="status"><p>正在只读核验计划资料；完整文件核验可能需要一些时间。</p><button v-if="state.readId" type="button" :disabled="state.cancelling" @click="controller.cancelRead">{{ state.cancelling ? '正在取消读取…' : '取消本次只读核验' }}</button></div>
    <p v-if="state.status === 'loading' || state.sending" role="status">{{ state.sending ? '正在等待冻结回执…' : '正在读取计划资料…' }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <div v-if="state.error" role="alert"><p>{{ state.error }}</p><button v-if="state.pending" type="button" :disabled="state.sending" @click="controller.retry">重试原冻结操作</button></div>
    <button type="button" :disabled="blocked" @click="controller.refresh">刷新计划资料</button>
    <section class="history" aria-labelledby="recording-plan-history-title"><h4 id="recording-plan-history-title">已冻结计划历史</h4><p class="muted">历史不会自动选中、预检、再次冻结或播放。</p><p v-if="state.status === 'ready' && !state.versions.length">尚无已冻结计划。</p><ol><li v-for="version in history" :key="version.id"><p>第 {{ version.sequence }} 版 · {{ version.createdAt }} · {{ short(version.id) }}</p><button type="button" :disabled="blocked" @click="readVersion(version.id)">查看计划第 {{ version.sequence }} 版</button></li></ol><nav v-if="state.versions.length > 12" aria-label="计划历史分页"><button type="button" :disabled="blocked || !historyPage" @click="historyPage--">上一页</button><button type="button" :disabled="blocked || (historyPage + 1) * 12 >= state.versions.length" @click="historyPage++">下一页</button></nav></section>
  </component>
</template>

<style scoped>
.recording-plan-panel{box-sizing:border-box;width:min(860px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px;border:1px solid var(--mb-glass-border);border-radius:16px;background:var(--mb-bg-base);color:var(--mb-text-primary)}.recording-plan-panel::backdrop{background:rgb(0 0 0 / .55)}.heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.kicker,.muted{color:var(--mb-text-secondary);font-size:13px}h3{margin:0;font-size:24px}h4{font-size:18px;margin:0 0 12px}h5{font-size:15px;margin:20px 0 8px}p,dd,li{font-size:14px;line-height:1.75;overflow-wrap:anywhere}.boundary,.snapshot,.preflight{padding:18px;border:1px solid var(--mb-glass-border);border-radius:10px;margin:20px 0}.boundary{border-left:3px solid var(--mb-accent)}fieldset{border:0;border-top:1px solid var(--mb-glass-border);padding:20px 0;min-width:0;margin:22px 0}legend{font-size:16px;font-weight:600}label{font-size:14px;display:block;margin-top:14px}select,button{box-sizing:border-box;min-width:0;max-width:100%;min-height:44px;padding:10px 12px;background:var(--mb-bg-base);color:var(--mb-text-primary);border:1px solid var(--mb-glass-border);border-radius:8px;font:inherit;font-size:14px}select{width:100%;margin:8px 0 14px}button,summary{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}.primary{background:var(--mb-accent);color:var(--mb-on-accent);font-weight:600}.check{display:flex;align-items:flex-start;gap:12px;min-height:44px;line-height:1.7;margin:20px 0}.check input{width:18px;height:18px;margin-top:3px;flex-shrink:0;accent-color:var(--mb-accent)}dl{display:grid;grid-template-columns:130px minmax(0,1fr);gap:10px}dt{font-size:13px;color:var(--mb-text-secondary);line-height:1.75}dd{margin:0}code{font-size:12px;overflow-wrap:anywhere;white-space:normal}summary{min-height:44px;padding:12px 0;box-sizing:border-box;font-size:14px;line-height:1.7}.history{border-top:1px solid var(--mb-glass-border);padding-top:24px;margin-top:24px}.history ol{padding-left:24px}.history li{padding-bottom:16px}.checks{padding-left:20px}.checks li{padding:6px 0}nav{display:flex;gap:12px}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}button:not(:disabled):active{transform:scale(.97)}@media(hover:hover) and (pointer:fine){button:not(:disabled):hover{border-color:var(--mb-accent)}}@media(max-width:600px){.recording-plan-panel{padding:16px}.heading{flex-wrap:wrap}.boundary,.snapshot,.preflight{padding:14px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:8px}}
.recording-plan-panel.is-inline{position:static;display:block;box-sizing:border-box;width:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:transparent;overflow:visible}
</style>
