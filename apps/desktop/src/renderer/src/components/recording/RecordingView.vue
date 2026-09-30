<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { CollectionCopyDetail, DraftProgramType, MasterDraft, MasterDraftResult, MasterDraftSummary, Page, AppendMasterDraftRequest, ExecutionMode, MediaPlan, MediaLayoutSpec, RecordingWorkspacePagePosition, RecordingWorkspaceSelection, RecordingWorkspaceStaleReason } from '@music-bridge/contracts'
import BackupRestorePanel from './BackupRestorePanel.vue'
import MediaPlanningPanel from './MediaPlanningPanel.vue'
import MasterVersionsPanel from './MasterVersionsPanel.vue'
import PreparationPanel from './PreparationPanel.vue'
import PreparedPanel from './PreparedPanel.vue'
import ExecutionPanel from './ExecutionPanel.vue'
import RecordingPlanPanel from './RecordingPlanPanel.vue'
import RecordingRecordsPanel from './RecordingRecordsPanel.vue'
import type { RecordingPlanContext } from './recording-plan-controller'
import SourceEvidencePanel from './SourceEvidencePanel.vue'
import RecordingNextStep from './RecordingNextStep.vue'
import { createRecordingWorkflowController, type RecordingWorkflowSelection } from './recording-workflow-controller'
import { getRecordingNextStep, sameRecordingFact, type RecordingNextAction } from './recording-next-step'
import MasterSourcePicker from './MasterSourcePicker.vue'
import { moveWorkbenchGroup, pruneRulesAfterTrackRemoval, type WorkbenchMove } from './recording-workbench-order.js'
import { projectWorkbenchSegment, releaseWorkbenchDistribution } from './recording-workbench-projection.js'
import { createRecordingWorkspaceController } from './recording-workspace-controller.js'
import type { RecordingPhysicalSelection, RecordingReservationNavigation } from '../collection/collection-recording-navigation'
const props = withDefaults(defineProps<{ reloadRequired?: boolean; initialPhysical?: RecordingPhysicalSelection; reservationNavigation?: RecordingReservationNavigation }>(), { reloadRequired: false })
const emit = defineEmits<{ 'open-collection': [physicalId?: string]; 'initial-physical-consumed': []; 'reservation-navigation-consumed': []; 'reload-required': [] }>()
type RecordingPage = 'my-work' | 'workbench' | 'source' | 'media' | 'versions' | 'logic' | 'prepared' | 'assets' | 'plan' | 'archive' | 'backup'
const page = ref<RecordingPage>('my-work')
const moveError = ref('')
const recordsOpen = ref(false), recordsTrigger = ref<HTMLButtonElement>()
type LeaveGuard = { canLeave(): boolean; leaveBlockReason(): string | null }
const recordsPanel = ref<LeaveGuard | null>(null), recordingPlanPanel = ref<LeaveGuard | null>(null)
function openRecords(): void { if (dirty.value || splitDirty.value) { discarding.value = true; return }; recordsOpen.value = true; recordPage('archive') }
function closeRecords(): void { if (recordsOpen.value && recordsPanel.value?.canLeave() !== true) { leaveGuardNotice.value = recordsPanel.value?.leaveBlockReason() ?? '录音档案中的设备运行尚未安全收口。'; return }; recordsOpen.value = false; recordPage(draft.value ? 'workbench' : 'my-work'); void nextTick(() => recordsTrigger.value?.focus({ preventScroll: true })) }
const backupRestore = ref(false), backupTrigger = ref<HTMLButtonElement>()
function openBackup(): void { if (dirty.value || splitDirty.value) { discarding.value = true; return }; backupRestore.value = true; recordPage('backup') }
const activatedHere = ref(false), reloading = ref(false), reloadTrigger = ref<HTMLButtonElement>()
const reloadRequired = computed(() => props.reloadRequired || activatedHere.value)
async function closeBackupRestore(): Promise<void> { backupRestore.value = false; recordPage(draft.value ? 'workbench' : 'my-work'); await nextTick(); backupTrigger.value?.focus() }
async function activatedDataset(): Promise<void> {
  if (!alive || reloadRequired.value) return
  activatedHere.value = true; emit('reload-required'); backupRestore.value = false; recordsOpen.value = false
  ++generation; draft.value = undefined; catalog.value = undefined; workflow.reset(); workspace.reset(); pending.value = undefined; pendingPhysicalIntent.value = undefined;
  confirmedSaveNeedsRefresh.value = false
  title.value = ''; trackIds.value = []; sourceTrackId.value = ''; picker.value = false; page.value = 'my-work';
  mediaPlanning.value = false; masterVersions.value = false; execution.value = false; prepared.value = false; preparation.value = false; recordingPlan.value = false; initialRecordingPlanContext.value = undefined;
  error.value = ''; notice.value = ''; loading.value = false
  await nextTick(); if (alive && reloadRequired.value) reloadTrigger.value?.focus()
}
function reloadWindow(): void {
  if (!alive || !reloadRequired.value || reloading.value) return
  reloading.value = true
  window.location.reload()
}
const api = window.musicBridge
const workspace = createRecordingWorkspaceController({ api, onChange: () => { workspaceState.value = { ...workspace.state } } })
const workspaceState = shallowRef({ ...workspace.state })
const pendingPhysicalIntent = ref(props.initialPhysical)
function cancelPhysicalIntent(): void { pendingPhysicalIntent.value = undefined; emit('initial-physical-consumed') }
const pendingReservationNavigation = shallowRef(props.reservationNavigation)
const reservationNavigationError = ref(''), reservationNavigationLoading = ref(false)
let reservationNavigationGeneration = 0, mounted = false
function cancelReservationNavigation(): void {
  if (!pendingReservationNavigation.value || reservationNavigationLoading.value) return
  ++reservationNavigationGeneration; pendingReservationNavigation.value = undefined; reservationNavigationError.value = ''
  emit('reservation-navigation-consumed')
}
const currentPhysicalId = computed(() => workspaceState.value.selection.selectedPhysicalId ?? pendingPhysicalIntent.value?.physicalId)
const workspaceUnsaved = computed(() => !!workspaceState.value.pending || workspaceState.value.writing)
const leaveGuardNotice = ref('')
function canLeave(): boolean {
  if (recordingPlan.value && recordingPlanPanel.value?.canLeave() !== true) { leaveGuardNotice.value = recordingPlanPanel.value?.leaveBlockReason() ?? '当前正式输出或命令回执尚未收口；请保留计划页。'; return false }
  if (recordsOpen.value && recordsPanel.value?.canLeave() !== true) { leaveGuardNotice.value = recordsPanel.value?.leaveBlockReason() ?? '录音档案中的设备运行尚未安全收口。'; return false }
  if (reloadRequired.value) return true
  if (reservationNavigationLoading.value) { leaveGuardNotice.value = '正在核对这盘磁带对应的制作，请等待读取完成后再离开。'; return false }
  if (loading.value) { leaveGuardNotice.value = '当前草稿或列表仍在读取，请等待读取完成后再离开。'; return false }
  if (confirmedSaveNeedsRefresh.value) { leaveGuardNotice.value = '草稿保存已确认，但当前草稿尚未重新读取；请先读取，避免把旧修订当作当前内容。'; return false }
  if (saving.value || pending.value || workspaceUnsaved.value) { leaveGuardNotice.value = '当前保存操作尚未取得明确回执。请先核对或重试原操作，再离开录音页。'; return false }
  if (dirty.value || splitDirty.value) { leaveGuardNotice.value = '当前标题、曲序或分面尚未保存。请先保存，或在工作台明确放弃修改。'; return false }
  if (picker.value || !['my-work', 'workbench'].includes(page.value)) { leaveGuardNotice.value = '请先关闭当前录音步骤，再切换侧栏页面；未保存表单会在步骤内提示。'; return false }
  leaveGuardNotice.value = ''
  return true
}
function navigationContextKey(): string {
  return JSON.stringify([generation, draft.value?.id ?? null, currentPhysicalId.value ?? null,
    workspaceState.value.selection.planId ?? null, workspaceState.value.context?.contextRevision ?? null, page.value])
}
defineExpose({ canLeave, navigationContextKey })
const staleFields = computed(() => workspaceState.value.context?.staleReasons ?? [])
const staleLabels: Record<RecordingWorkspaceStaleReason['reason'], string> = {
  'draft-changed': '草稿曲序或修订已变化', missing: '原引用暂时不可用', 'different-draft': '引用属于另一份制作',
  'plan-changed': '规划内容已变化', 'reservation-changed': '预留已变化', 'copy-unavailable': '实体磁带当前不可用',
}
function staleText(item: RecordingWorkspaceStaleReason): string { return `${item.field === 'draft' ? '当前草稿' : item.field === 'planId' ? '本次规划' : item.field === 'layoutId' ? '冻结布局' : item.field === 'selectedPhysicalId' ? '所选实体' : '本次版本引用'}：${staleLabels[item.reason]}；保留原身份，需明确复核。` }
function recordPage(target: RecordingWorkspacePagePosition): void { page.value = target; leaveGuardNotice.value = ''; if (draft.value) void workspace.navigate(target) }
const workflow = createRecordingWorkflowController({ api, onChange: () => { workflowState.value = { ...workflow.state } } })
const workflowState = shallowRef({ ...workflow.state })
const sourceSnapshot = computed(() => workflowState.value.status === 'ready' ? workflowState.value.facts?.sources : undefined)
const nextStep = computed(() => {
  const result = getRecordingNextStep({ draft: draft.value, pending: !!pending.value, dirty: dirty.value, busy: saving.value || loading.value, workflow: workflowState.value })
  if (confirmedSaveNeedsRefresh.value) return { ...result, title: '草稿保存已确认，等待重新读取', description: '请使用下方“重新读取”取得当前修订；不要重复提交旧保存命令。', disabled: true }
  if (!dirty.value && splitDirty.value) return { ...result, step: 2 as const, title: '先保存当前分面', description: '工作台分面与已存规划不同；请重新估算并保存，不能把旧规划当成本次结果。', label: '估算并保存分面', action: { type: 'media' as const }, disabled: blocked.value }
  return result.action.type === 'save-draft' && !title.value.trim() ? { ...result, disabled: true, description: '请先填写草稿标题，再保存当前修改。' } : result
})
const catalog = shallowRef<Page<MasterDraftSummary>>(), draft = shallowRef<MasterDraft>()
const loading = ref(false), saving = ref(false), picker = ref(false), error = ref(''), notice = ref(''), discarding = ref(false)
const mediaPlanning = ref(false), masterVersions = ref(false)
const initialMediaPlanId = ref<string>(), initialVersionPlanId = ref<string>()
const initialMediaSpec = shallowRef<MediaLayoutSpec>()
const recordingPlan = ref(false), recordingPlanTrigger = ref<HTMLButtonElement>()
const initialRecordingPlanContext = shallowRef<RecordingPlanContext>()
let recordingPlanOpener: HTMLElement | undefined
async function openRecordingPlan(context?: RecordingPlanContext): Promise<void> { if (dirty.value || splitDirty.value) return; const selected = context ?? selectedPlanContext(); if (!selected) { notice.value = '请先明确选择本次冻结布局与制作路径。'; return }; const opener = activeTrigger(); if (!await confirmCurrentWorkspaceSelection('计划与预检')) return; recordingPlanOpener = opener; initialRecordingPlanContext.value = selected; recordingPlan.value = true; recordPage('plan') }
async function closeRecordingPlan(): Promise<void> { if (recordingPlan.value && recordingPlanPanel.value?.canLeave() !== true) { leaveGuardNotice.value = recordingPlanPanel.value?.leaveBlockReason() ?? '当前正式输出或命令回执尚未收口；请保留计划页。'; return }; recordingPlan.value = false; recordPage('workbench'); await refreshAfterClose(recordingPlanOpener, () => recordingPlanTrigger.value) }
const initialExecutionContext = shallowRef<{ layoutId: string; mode: ExecutionMode; preparedId?: string }>()
let mediaOpener: HTMLElement | undefined, versionsOpener: HTMLElement | undefined, executionOpener: HTMLElement | undefined, preparationOpener: HTMLElement | undefined, preparedOpener: HTMLElement | undefined, sourceOpener: HTMLElement | undefined
const viewRoot = ref<HTMLElement>()
const focusCleanups = new Set<() => void>()
function activeTrigger(): HTMLElement | undefined { const target = document.activeElement; return target && 'focus' in target ? target as HTMLElement : undefined }
let pickerOpener: HTMLElement | undefined
function openPicker(): void { pickerOpener = activeTrigger(); picker.value = true }
async function closePicker(): Promise<void> {
  picker.value = false; error.value = ''
  await refreshAfterClose(pickerOpener, () => viewRoot.value?.querySelector<HTMLElement>(draft.value ? '[data-recording-return-focus="picker-add"]' : '[data-recording-return-focus="picker-new"]') ?? undefined)
}
function returnTarget(opener?: HTMLElement, fallback?: () => HTMLElement | undefined): HTMLElement | undefined {
  if (opener?.isConnected) return opener
  const key = opener?.dataset.recordingReturnFocus
  return key ? viewRoot.value?.querySelector<HTMLElement>(`[data-recording-return-focus="${key}"]`) ?? fallback?.() : fallback?.()
}
async function refreshAfterClose(opener?: HTMLElement, fallback?: () => HTMLElement | undefined): Promise<void> {
  const token = generation
  let interacted = false
  const cancelRestore = () => { interacted = true }
  const cleanup = () => { document.removeEventListener('pointerdown', cancelRestore); document.removeEventListener('keydown', cancelRestore); focusCleanups.delete(cleanup) }
  document.addEventListener('pointerdown', cancelRestore); document.addEventListener('keydown', cancelRestore); focusCleanups.add(cleanup)
  try {
    await refreshWorkflow(); await nextTick()
    if (!alive || token !== generation || interacted) return
    const target = returnTarget(opener, fallback)
    if (target?.isConnected && (document.activeElement === document.body || document.activeElement === target)) {
      const details = target.closest('details')
      if (details && !details.open) details.open = true
      target.focus({ preventScroll: true })
    }
  } finally { cleanup() }
}
function openMediaPlanning(planId?: string): void { if (dirty.value) { discarding.value = true; return }; mediaOpener = activeTrigger(); initialMediaPlanId.value = planId ?? workspaceState.value.selection.planId ?? ''; initialMediaSplitAfter.value = splitDirty.value ? workbenchSpec.value.splitAfter : undefined; initialMediaSpec.value = splitDirty.value ? cloneWorkbenchSpec() : undefined; mediaPlanning.value = true; recordPage('media') }
function openMasterVersions(planId?: string): void { if (dirty.value || splitDirty.value) return; versionsOpener = activeTrigger(); initialVersionPlanId.value = planId ?? workspaceState.value.selection.planId ?? ''; masterVersions.value = true; recordPage('versions') }
function selectedPlanContext(): RecordingPlanContext | undefined { const selection = workflowState.value.selection; return selection.layoutId && selection.path ? { layoutId: selection.layoutId, mode: selection.path === 'direct' ? 'direct' : 'prepared-reference', ...(selection.preparedId ? { preparedId: selection.preparedId } : {}) } : undefined }
async function openExecution(context?: { layoutId: string; mode: ExecutionMode; preparedId?: string }): Promise<void> { if (dirty.value || splitDirty.value) return; const selected = context?.layoutId ? context : selectedPlanContext(); if (!selected) { notice.value = '请先明确选择本次冻结布局与制作路径。'; return }; const opener = activeTrigger(); if (!await confirmCurrentWorkspaceSelection('执行资产')) return; executionOpener = opener; initialExecutionContext.value = selected; execution.value = true; recordPage('assets') }
const execution = ref(false), executionTrigger = ref<HTMLButtonElement>()
async function closeExecution(): Promise<void> { execution.value = false; recordPage('workbench'); await refreshAfterClose(executionOpener, () => executionTrigger.value) }
const prepared = ref(false), preparedId = ref(''), preparedTrigger = ref<HTMLButtonElement>()
async function openPrepared(id = ''): Promise<void> { if (dirty.value || splitDirty.value) return; const selectedId = id || workflowState.value.selection.preparationId; if (!selectedId) { notice.value = '请先明确选择本次 Logic 工作区。'; return }; const opener = activeTrigger(); if (!await confirmCurrentWorkspaceSelection('Render 与 PREP', { preparationId: selectedId })) return; preparedOpener = opener; preparation.value = false; preparedId.value = selectedId; prepared.value = true; recordPage('prepared') }
async function closePrepared(): Promise<void> { prepared.value = false; recordPage('workbench'); await refreshAfterClose(preparedOpener, () => preparedTrigger.value) }
const preparation = ref(false), preparationLayoutId = ref(''), preparationTrigger = ref<HTMLButtonElement>()
async function openPreparation(layoutId = ''): Promise<void> { if (dirty.value || splitDirty.value) return; const selectedId = layoutId || workflowState.value.selection.layoutId; if (!selectedId) { notice.value = '请先明确选择本次冻结布局。'; return }; const opener = activeTrigger(); if (!await confirmCurrentWorkspaceSelection('Logic 工作区', { layoutId: selectedId, path: 'logic' })) return; preparationOpener = opener; masterVersions.value = false; preparationLayoutId.value = selectedId; preparation.value = true; recordPage('logic') }
async function closePreparation(): Promise<void> { preparation.value = false; recordPage('workbench'); await refreshAfterClose(preparationOpener, () => preparationTrigger.value) }
const sourceTrackId = ref('')
function openSource(trackId: string): void { if (dirty.value || splitDirty.value) { discarding.value = true; return }; sourceOpener = activeTrigger(); sourceTrackId.value = trackId; recordPage('source') }
const pending = shallowRef<() => Promise<MasterDraftResult>>()
const confirmedSaveNeedsRefresh = ref(false)
const title = ref(''), programType = ref<DraftProgramType>('compilation'), trackIds = ref<string[]>([])
const workbenchSpec = ref<MediaLayoutSpec>({ format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } })
// MediaLayoutSpec 是纯 JSON 合同；ref 内层也可能含 Proxy，不能直接交给 structuredClone。
function cloneWorkbenchSpec(): MediaLayoutSpec { return JSON.parse(JSON.stringify(workbenchSpec.value)) as MediaLayoutSpec }
const workbenchBaselineSpec = ref('')
const initialMediaSplitAfter = ref<number>()
const blocked = computed(() => reloadRequired.value || saving.value || loading.value || !!pending.value || confirmedSaveNeedsRefresh.value)
const dirty = computed(() => !!draft.value && (title.value !== draft.value.title || programType.value !== draft.value.programType || JSON.stringify(trackIds.value) !== JSON.stringify(draft.value.tracks.map(t => t.id))))
const tracks = computed(() => trackIds.value.map(id => draft.value!.tracks.find(t => t.id === id)!))
const selectedPlan = computed(() => workflowState.value.facts?.plans.plans.find(plan => plan.id === workflowState.value.selection.planId))
const physicalDetails = shallowRef<Record<string, CollectionCopyDetail>>({})
const physicalRead = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
watch([currentPhysicalId, selectedPlan], async ([intendedId, plan], _old, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  const ids = [...new Set([intendedId, plan?.reservation?.physicalId].filter((id): id is string => !!id))]
  physicalDetails.value = {}
  if (!ids.length) { physicalRead.value = 'idle'; return }
  physicalRead.value = 'loading'
  try {
    const details = await Promise.all(ids.map(id => api.getCollectionCopy(id)))
    if (!alive || cancelled) return
    if (details.some((detail, index) => detail.copy.physicalId !== ids[index])) throw new Error('实体身份不一致')
    physicalDetails.value = Object.fromEntries(details.map((detail, index) => [ids[index]!, detail]))
    physicalRead.value = 'ready'
  } catch { if (alive && !cancelled) physicalRead.value = 'error' }
}, { flush: 'post' })
const reservedCopy = computed(() => {
  const reservation = selectedPlan.value?.reservation
  if (!reservation) return undefined
  const detail = physicalDetails.value[reservation.physicalId]
  const copy = detail?.copy
  return detail?.modelId === reservation.modelId && copy?.physicalId === reservation.physicalId && copy.skuId === reservation.skuId
    && copy.packaging === reservation.packaging && copy.usage === 'reserved' && copy.reservationOwner?.kind === 'recording-plan'
    && copy.reservationOwner.draftId === draft.value?.id && copy.reservationOwner.planId === selectedPlan.value?.id ? copy : undefined
})
const intendedCopy = computed(() => currentPhysicalId.value ? physicalDetails.value[currentPhysicalId.value]?.copy : undefined)
const workbenchProjection = computed(() => projectWorkbenchSegment(workbenchSpec.value, trackIds.value))
const visibleTracks = computed(() => workbenchProjection.value.trackIds.map(id => tracks.value.find(track => track.id === id)).filter((track): track is MasterDraft['tracks'][number] => !!track))
const sideA = computed(() => workbenchSpec.value.format === 'dat' ? visibleTracks.value : visibleTracks.value.slice(0, workbenchSpec.value.splitAfter))
const sideB = computed(() => workbenchSpec.value.format === 'dat' ? [] : visibleTracks.value.slice(workbenchSpec.value.splitAfter))
const workbenchSides = computed(() => workbenchSpec.value.format === 'dat' ? [{ name: 'Program', tracks: sideA.value }] : [{ name: 'A', tracks: sideA.value }, { name: 'B', tracks: sideB.value }])
function releaseDistribution(): void {
  if (!workbenchSpec.value.distribution || blocked.value) return
  workbenchSpec.value = releaseWorkbenchDistribution(cloneWorkbenchSpec(), trackIds.value.length)
  moveError.value = '已切回完整母版编辑稿；旧分盘规划、预留和冻结历史仍保留，但不能直接作为修改后的本次规划。请重新创建或明确选择有效规划。'
}
const splitDirty = computed(() => !!draft.value && !!workbenchBaselineSpec.value && JSON.stringify(workbenchSpec.value) !== workbenchBaselineSpec.value)
const planEstimateCurrent = computed(() => !!selectedPlan.value && !dirty.value && !splitDirty.value && !workbenchProjection.value.invalid && !selectedPlan.value.requiresReview && selectedPlan.value.draftRevision === draft.value?.revision && selectedPlan.value.sourceBasis !== 'unavailable' && JSON.stringify(selectedPlan.value.spec) === JSON.stringify(workbenchSpec.value))
function sideEstimate(name: string): string { return planEstimateCurrent.value ? duration(selectedPlan.value?.layout.sides.find(side => side.name === name)?.durationMs) : '待重新估算' }
function sideBudget(name: string): string {
  if (!planEstimateCurrent.value) return '容量未核算 · 请重新估算当前分面'
  const side = selectedPlan.value?.layout.sides.find(item => item.name === name)
  if (side?.durationMs === undefined) return '容量未核算 · 至少一首时长未知'
  const copy = selectedPlan.value?.reservation ? reservedCopy.value : intendedCopy.value?.available && ['blank', 'erased'].includes(intendedCopy.value.usage) ? intendedCopy.value : undefined
  if (!copy || copy.lengthMinutes === null) return '容量未核算 · 单盘容量或实时归属待确认'
  const capacityMs = copy.lengthMinutes * 60_000 / (selectedPlan.value?.spec.format === 'cassette' ? 2 : 1)
  const remainingMs = capacityMs - side.durationMs
  const basis = selectedPlan.value?.sourceBasis === 'roon-estimate' ? ' · Roon 约值，须核精确源' : ' · 已验证源时长'
  const reservation = selectedPlan.value?.reservation ? '' : ' · 尚未预留'
  return `容量 ${duration(capacityMs)} · 已占 ${duration(side.durationMs)} · ${remainingMs < 0 ? `超出 ${duration(-remainingMs)}` : `余量 ${duration(remainingMs)}`}${basis}${reservation}`
}
function physicalDescription(id: string): string {
  const copy = physicalDetails.value[id]?.copy
  if (!copy) return physicalRead.value === 'loading' ? '正在核对实时单盘资料' : '单盘资料未确认'
  return `${copy.lengthMinutes ?? '容量未知'} 分钟 · ${copy.packaging === 'opened' ? '已拆封' : copy.packaging === 'sealed' ? '未拆封' : '包装未知'} · ${copy.usage === 'reserved' ? '已预留' : copy.available ? '库存可用性仍需复核' : '当前不可用于新预留'}`
}
const types = { compilation: 'Compilation · 精选', concert: 'Concert · 演出', continuous: 'Continuous Program · 连续节目' }
const duration = (ms: number | undefined): string => ms === undefined ? '时长待核实' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
let alive = true, generation = 0
function resetSubpages(): void {
  recordsOpen.value = false; backupRestore.value = false; mediaPlanning.value = false; masterVersions.value = false
  preparation.value = false; prepared.value = false; execution.value = false; recordingPlan.value = false; sourceTrackId.value = ''
  initialMediaSpec.value = undefined; initialMediaSplitAfter.value = undefined
}
function restorePage(position: RecordingWorkspacePagePosition, raw: RecordingWorkspaceSelection): void {
  resetSubpages()
  const selected = workflow.state.selection
  page.value = 'workbench'
  if (position === 'source') { notice.value = '上次停留在源文件页；曲目身份未随页面位置保存，请在工作台明确选择要处理的曲目。'; return }
  if (position === 'media') { initialMediaPlanId.value = raw.planId ?? ''; mediaPlanning.value = true; page.value = 'media'; return }
  if (position === 'versions') { initialVersionPlanId.value = raw.planId ?? ''; masterVersions.value = true; page.value = 'versions'; return }
  if (position === 'logic' && selected.layoutId) { preparationLayoutId.value = selected.layoutId; preparation.value = true; page.value = 'logic'; return }
  if (position === 'prepared' && selected.preparationId) { preparedId.value = selected.preparationId; prepared.value = true; page.value = 'prepared'; return }
  if (position === 'assets' && selectedPlanContext()) { initialExecutionContext.value = selectedPlanContext(); execution.value = true; page.value = 'assets'; return }
  if (position === 'plan' && selectedPlanContext()) { initialRecordingPlanContext.value = selectedPlanContext(); recordingPlan.value = true; page.value = 'plan'; return }
  if (position === 'archive') { recordsOpen.value = true; page.value = 'archive'; return }
  if (position === 'backup') { backupRestore.value = true; page.value = 'backup'; return }
  if (['logic', 'prepared', 'assets', 'plan'].includes(position)) notice.value = '上次子页面关联的布局或版本已不可用于当前制作；原引用保留在工作上下文，请先在工作台明确复核。'
}
async function list(offset = 0): Promise<void> {
  const token = ++generation; loading.value = true
  try { const result = await api.listMasterDrafts({ offset, limit: 12 }); if (alive && token === generation) catalog.value = result }
  catch { if (alive && token === generation) error.value = '草稿列表暂时无法读取，已存内容不会被清空。' }
  finally { if (alive && token === generation) loading.value = false }
}
async function open(id: string, fromReservationNavigation = false): Promise<void> {
  if (!fromReservationNavigation) ++reservationNavigationGeneration
  const token = ++generation; loading.value = true; workflow.reset(); workspace.reset(); resetSubpages(); page.value = 'my-work'; notice.value = ''; error.value = ''
  try {
    const result = await api.getMasterDraft(id)
    if (alive && token === generation) {
      draft.value = result; title.value = result.title; programType.value = result.programType; trackIds.value = result.tracks.map(t => t.id); page.value = 'workbench'; moveError.value = ''
      confirmedSaveNeedsRefresh.value = false
      workbenchSpec.value = { format: 'cassette', splitAfter: Math.max(1, Math.ceil(result.tracks.length / 2)), leadInMs: 0, tailMs: 0, defaultGapMs: result.programType === 'compilation' ? 5000 : 0, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } }
      workflow.setDraft(result)
      await Promise.all([workflow.refresh(), workspace.open(result)])
      if (!alive || token !== generation) return
      if (!fromReservationNavigation && workspace.state.status === 'ready' && workflow.state.status === 'ready') workflow.select(workspace.state.selection)
      const currentPlan = workflow.state.facts?.plans.plans.find(plan => plan.id === workflow.state.selection.planId)
      if (currentPlan) {
        workbenchSpec.value = structuredClone(currentPlan.spec)
        const validIds = new Set(result.tracks.map(track => track.id))
        const originalIds = currentPlan.layout.sides.flatMap(side => side.tracks.map(track => track.trackId))
        for (const oldId of originalIds.filter(trackId => !validIds.has(trackId))) {
          workbenchSpec.value.rules = pruneRulesAfterTrackRemoval(originalIds, workbenchSpec.value.rules, oldId)
          originalIds.splice(originalIds.indexOf(oldId), 1)
        }
        workbenchSpec.value.rules = workbenchSpec.value.rules.filter(rule => validIds.has(rule.trackId))
        if (workbenchSpec.value.rules.length !== currentPlan.spec.rules.length) notice.value = '旧规划含已删曲目的逐曲规则；当前工作台已整理引用，请重新核对并保存分面。旧规划与冻结历史未改写。'
      }
      workbenchBaselineSpec.value = JSON.stringify(currentPlan?.spec ?? workbenchSpec.value)
      if (workspace.state.status === 'ready') {
        if (!fromReservationNavigation) restorePage(workspace.state.pagePosition, workspace.state.selection)
        if (!fromReservationNavigation && pendingPhysicalIntent.value) {
          if (workspace.state.selection.selectedPhysicalId !== pendingPhysicalIntent.value.physicalId) void workspace.choose({ selectedPhysicalId: pendingPhysicalIntent.value.physicalId })
          pendingPhysicalIntent.value = undefined
          emit('initial-physical-consumed')
        }
      }
    }
  } catch { if (alive && token === generation) error.value = '草稿详情暂时无法读取，请刷新后重试。' }
  finally { if (alive && token === generation) loading.value = false }
}
async function openReservationNavigation(target: RecordingReservationNavigation): Promise<void> {
  const token = ++reservationNavigationGeneration
  pendingReservationNavigation.value = target; reservationNavigationError.value = ''
  if (!canLeave()) { reservationNavigationError.value = '当前录音步骤尚不能离开；请先保存或关闭，再重试这盘的制作定位。'; return }
  reservationNavigationLoading.value = true
  try {
    await open(target.draftId, true)
    if (!alive || token !== reservationNavigationGeneration) return
    if (draft.value?.id !== target.draftId || workflow.state.status !== 'ready' || workspace.state.status !== 'ready') throw new Error('目标草稿或工作状态尚未读取成功')
    const [exactPlan, exactCopy] = await Promise.all([api.getMediaPlan(target.planId), api.getCollectionCopy(target.physicalId)])
    if (!alive || token !== reservationNavigationGeneration) return
    const listedPlan = workflow.state.facts?.plans.plans.find(plan => plan.id === target.planId)
    const owner = exactCopy.copy.reservationOwner
    if (exactPlan.id !== target.planId || exactPlan.draftId !== target.draftId
      || exactPlan.reservation?.physicalId !== target.physicalId || !listedPlan || !sameRecordingFact(listedPlan, exactPlan)
      || exactCopy.copy.physicalId !== target.physicalId || exactCopy.copy.usage !== 'reserved'
      || owner?.kind !== 'recording-plan' || owner.draftId !== target.draftId || owner.planId !== target.planId) {
      throw new Error('原预留与当前草稿、规划或实体归属已不一致')
    }
    workflow.select({ planId: target.planId })
    if (workflow.state.selection.planId !== target.planId) throw new Error('目标规划当前不可选')
    await workspace.choose({ planId: target.planId, selectedPhysicalId: target.physicalId })
    if (!alive || token !== reservationNavigationGeneration) return
    if (workspace.state.status !== 'ready' || workspace.state.context?.selection.planId !== target.planId
      || workspace.state.context.selection.selectedPhysicalId !== target.physicalId) throw new Error('目标选择尚未取得工作库保存回执')
    page.value = 'workbench'
    await workspace.navigate('workbench')
    if (!alive || token !== reservationNavigationGeneration) return
    if (workspace.state.status !== 'ready' || workspace.state.context?.pagePosition !== 'workbench') throw new Error('工作台位置尚未取得工作库保存回执')
    workbenchSpec.value = structuredClone(exactPlan.spec); workbenchBaselineSpec.value = JSON.stringify(exactPlan.spec)
    pendingReservationNavigation.value = undefined
    notice.value = `已打开 ${target.physicalId} 对应的确切制作规划；预留仍以当前工作库状态为准，不会在这里自动变更。`
    emit('reservation-navigation-consumed')
  } catch {
    if (alive && token === reservationNavigationGeneration) reservationNavigationError.value = `无法确认 ${target.physicalId} 仍由指定草稿与规划预留。原定位已保留；请重试读取或明确取消，不会改选其他规划或变更预留。`
  } finally {
    if (alive && token === reservationNavigationGeneration) reservationNavigationLoading.value = false
  }
}
watch(() => props.reservationNavigation, target => {
  if (!target) return
  pendingReservationNavigation.value = target
  if (mounted) void openReservationNavigation(target)
})
async function refreshWorkflow(): Promise<void> { if (draft.value) await workflow.refresh() }
const workspaceSelectionKeys = ['planId', 'layoutId', 'path', 'preparationId', 'preparedId'] as const
function workspaceSelectionConfirmed(expected: RecordingWorkspaceSelection, draftId: string): boolean {
  const state = workspace.state, stored = state.context
  return state.status === 'ready' && !state.pending && !state.writing && state.draftId === draftId
    && stored?.draftId === draftId && workspaceSelectionKeys.every(key => stored.selection[key] === expected[key])
}
async function confirmCurrentWorkspaceSelection(label: string, patch: Partial<RecordingWorkspaceSelection> = {}): Promise<boolean> {
  const draftId = draft.value?.id, token = generation
  if (!draftId || workspace.state.status !== 'ready' || workflow.state.status !== 'ready') {
    notice.value = `本次${label}的工作上下文尚未读取完成，请先重新读取。`; return false
  }
  if (patch.layoutId && !workflow.state.facts?.versions.layouts.some(item => item.id === patch.layoutId)
    || patch.preparationId && !workflow.state.facts?.preparations.workspaces.some(item => item.id === patch.preparationId)) await refreshWorkflow()
  if (!alive || token !== generation || draft.value?.id !== draftId || workflow.state.status !== 'ready') return false
  workflow.select(patch)
  if (Object.entries(patch).some(([key, value]) => workflow.state.selection[key as keyof RecordingWorkspaceSelection] !== value)) {
    notice.value = `本次${label}与当前草稿、规划或冻结谱系不匹配；不会自动换用其他版本。`; return false
  }
  const selection = workflow.state.selection
  if (!selection.planId || !selection.layoutId || !selection.path) {
    notice.value = `请先明确选择本次媒体规划、冻结布局和处理路径，再打开${label}。`; return false
  }
  const expected: RecordingWorkspaceSelection = { planId: selection.planId, layoutId: selection.layoutId, path: selection.path,
    preparationId: selection.preparationId, preparedId: selection.preparedId }
  await workspace.choose(expected)
  if (!alive || token !== generation || draft.value?.id !== draftId) return false
  if (!workspaceSelectionConfirmed(expected, draftId)) {
    notice.value = `本次${label}的选择尚未取得工作库持久回执；请重试原保存操作或重新读取，不能仅凭界面选中继续。`; return false
  }
  return true
}
async function closeSources(): Promise<void> { const trackId = sourceTrackId.value; sourceTrackId.value = ''; recordPage('workbench'); await refreshAfterClose(sourceOpener, () => viewRoot.value?.querySelector<HTMLElement>(`[data-recording-return-focus="source-${trackId}"]`) ?? undefined) }
async function closeMediaPlanning(): Promise<void> { mediaPlanning.value = false; recordPage('workbench'); await refreshAfterClose(mediaOpener, () => viewRoot.value?.querySelector<HTMLElement>('[data-recording-return-focus="media-main"]') ?? undefined) }
let mediaSelectionSequence = 0
async function mediaChanged(changed: MediaPlan): Promise<void> {
  if (changed.draftId !== draft.value?.id) return
  // 保存、预留或释放的回执明确指向本次操作的规划，连同工作上下文保存。
  await mediaSelected(changed.id)
}
async function mediaSelected(planId: string | null): Promise<void> {
  const draftId = draft.value?.id, draftRevision = draft.value?.revision, token = generation, sequence = ++mediaSelectionSequence
  const specAtStart = JSON.stringify(workbenchSpec.value)
  if (!draftId || workspace.state.status !== 'ready') return
  await refreshWorkflow()
  if (!alive || token !== generation || sequence !== mediaSelectionSequence || draft.value?.id !== draftId || workflow.state.status !== 'ready') return
  workflow.select({ planId: planId ?? undefined })
  if (workflow.state.selection.planId !== (planId ?? undefined)) {
    notice.value = '所选规划不属于当前制作或事实已变化；不会改选最新规划。'; return
  }
  await workspace.choose({ planId: planId ?? undefined })
  if (!alive || token !== generation || sequence !== mediaSelectionSequence || draft.value?.id !== draftId) return
  if (!workspaceSelectionConfirmed(workflow.state.selection, draftId)) {
    notice.value = '本次选盘尚未取得工作库持久回执；请重试原保存操作或重新读取。'; return
  }
  if (dirty.value || draft.value.revision !== draftRevision || JSON.stringify(workbenchSpec.value) !== specAtStart) {
    notice.value = '规划选择已保存；保留你刚修改的草稿和分面，请完成保存后再核对。'
    return
  }
  const plan = workflow.state.facts?.plans.plans.find(value => value.id === planId)
  if (plan) { workbenchSpec.value = structuredClone(plan.spec); workbenchBaselineSpec.value = JSON.stringify(plan.spec) }
}
async function closeMasterVersions(): Promise<void> { masterVersions.value = false; recordPage('workbench'); await refreshAfterClose(versionsOpener, () => viewRoot.value?.querySelector<HTMLElement>('[data-recording-return-focus="versions"]') ?? undefined) }
async function selectWorkflow(selection: Partial<RecordingWorkflowSelection>): Promise<void> {
  if (blocked.value || dirty.value || splitDirty.value || workspace.state.status !== 'ready') return
  ++mediaSelectionSequence
  const draftId = draft.value?.id, draftRevision = draft.value?.revision, token = generation
  workflow.select(selection)
  const accepted: Partial<RecordingWorkspaceSelection> = {}
  for (const key of Object.keys(selection) as (keyof RecordingWorkspaceSelection)[]) {
    if (workflow.state.selection[key] === selection[key]) Object.assign(accepted, { [key]: selection[key] })
  }
  if (!Object.keys(accepted).length || !draftId) return
  await workspace.choose(accepted)
  if (!alive || token !== generation || draft.value?.id !== draftId) return
  if (!workspaceSelectionConfirmed(workflow.state.selection, draftId)) {
    notice.value = '本次版本选择尚未取得工作库持久回执；请重试原保存操作或重新读取。'
    return
  }
  if (Object.hasOwn(accepted, 'planId') && accepted.planId && workflow.state.selection.planId === accepted.planId) {
    // 保存选择期间的新编辑仍归用户所有，迟到回执不能覆盖它们。
    if (dirty.value || splitDirty.value || draft.value.revision !== draftRevision) {
      notice.value = '规划选择已保存；保留你刚修改的草稿和分面，请完成保存后再核对。'
      return
    }
    const plan = workflow.state.facts?.plans.plans.find(value => value.id === accepted.planId)
    if (plan) { workbenchSpec.value = structuredClone(plan.spec); workbenchBaselineSpec.value = JSON.stringify(plan.spec) }
  }
}
async function nextAction(action: RecordingNextAction): Promise<void> {
  if (nextStep.value.disabled) return
  switch (action.type) {
    case 'retry-pending': await retry(); break
    case 'save-draft': save(); break
    case 'refresh': await refreshWorkflow(); break
    case 'pick-source': openPicker(); break
    case 'source': openSource(action.trackId); break
    case 'media': openMediaPlanning(workflowState.value.selection.planId); break
    case 'versions': openMasterVersions(workflowState.value.selection.planId ?? ''); break
    case 'preparation': await openPreparation(action.layoutId); break
    case 'prepared': await openPrepared(action.preparationId); break
    case 'execution': {
      const selection = workflowState.value.selection
      await openExecution({ layoutId: selection.layoutId ?? '', mode: selection.path === 'direct' ? 'direct' : 'prepared-reference', ...(selection.preparedId ? { preparedId: selection.preparedId } : {}) }); break
    }
    case 'recording-plan': {
      const selection = workflowState.value.selection
      await openRecordingPlan({ layoutId: selection.layoutId ?? '', mode: selection.path === 'direct' ? 'direct' : 'prepared-reference', ...(selection.preparedId ? { preparedId: selection.preparedId } : {}) }); break
    }
    case 'choose-context': break // 组件把焦点交给首个尚未选择的有效上下文。
  }
}
function sourceLabel(id: string): string {
  if (workflowState.value.status !== 'ready') return workflowState.value.status === 'error' ? '源状态读取失败' : '源状态尚未读取完成'
  const binding = sourceSnapshot.value?.tracks.find(t => t.trackId === id)?.binding
  if (!binding) return '仅有音乐引用 · 未绑定文件'
  if (binding.availability === 'SOURCE_ROOT_OFFLINE') return '源目录离线 · 绑定仍保留'
  if (binding.availability === 'CONTENT_CHANGED') return '文件内容已变化 · 锁定失效'
  if (binding.availability === 'MISSING') return '源文件缺失 · 不自动换同名文件'
  if (binding.availability === 'REVOKED') return '源授权已撤销'
  return binding.sourceLockEligible ? '精确源已验证' : '文件已绑定 · 待技术验证或人工确认'
}
function back(force = false): void {
  if (reloadRequired.value || loading.value || saving.value || pending.value || workspaceUnsaved.value || confirmedSaveNeedsRefresh.value || reservationNavigationLoading.value
    || picker.value || !['my-work', 'workbench'].includes(page.value)) { canLeave(); return }
  if ((dirty.value || splitDirty.value) && !force) { discarding.value = true; return }
  ++reservationNavigationGeneration; ++generation; draft.value = undefined; page.value = 'my-work'; workflow.reset(); workspace.reset(); resetSubpages(); trackIds.value = []; discarding.value = false; notice.value = ''; error.value = ''; void list()
}
async function retry(): Promise<void> {
  if (!pending.value || saving.value) return
  saving.value = true; error.value = ''; notice.value = ''
  let commandConfirmed = false
  try {
    const result = await pending.value()
    if (!alive) return
    commandConfirmed = true
    pending.value = undefined; picker.value = false
    const retainedSpec = cloneWorkbenchSpec()
    await list(); await open(result.draftId)
    if (error.value || draft.value?.id !== result.draftId) { confirmedSaveNeedsRefresh.value = true; error.value = '草稿保存已确认，但当前草稿未能重新读取。请刷新当前草稿；不要重复提交保存。'; return }
    if (alive && draft.value?.id === result.draftId) workbenchSpec.value = retainedSpec
    if (!notice.value) notice.value = '草稿已保存；分面改动仍需重新估算并保存规划。'
  } catch (cause) {
    if (alive) {
      if (commandConfirmed) { confirmedSaveNeedsRefresh.value = true; error.value = '草稿保存已确认，但工作台未能重新读取。请刷新当前草稿；不要重复提交保存。'; return }
      const message = cause instanceof Error ? cause.message : ''
      if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(message)) {
        pending.value = undefined
        if (draft.value) await open(draft.value.id)
        error.value = '本次修改未保存，草稿或 Roon 引用已变化。请重新浏览、编辑并确认。'
      } else error.value = '草稿保存结果尚未确认，请重试原操作；不会重复追加曲目。'
    }
  } finally { if (alive) saving.value = false }
}
function mutate(operation: () => Promise<MasterDraftResult>): void { if (blocked.value) return; pending.value = operation; void retry() }
function append(request: AppendMasterDraftRequest): void { mutate(() => api.appendMasterDraft(request)) }
function save(): void {
  if (!draft.value || !dirty.value || !title.value.trim()) return
  const request = { commandId: crypto.randomUUID(), draftId: draft.value.id, expectedRevision: draft.value.revision, title: title.value.trim(), programType: programType.value, trackIds: [...trackIds.value] }
  mutate(() => api.updateMasterDraft(request))
}
function move(index: number, delta: number): void {
  const trackId = trackIds.value[index]
  if (blocked.value || !trackId) return
  moveGroup(trackId, { direction: delta < 0 ? -1 : 1 })
}
function moveGroup(trackId: string, operation: WorkbenchMove): void {
  if (blocked.value) return
  if (workbenchSpec.value.distribution) { moveError.value = '请先明确退出分盘视图，再编辑完整母版曲序；旧分盘不会自动随之改变。'; return }
  const result = moveWorkbenchGroup({ trackIds: trackIds.value, splitAfter: workbenchSpec.value.splitAfter }, workbenchSpec.value, trackId, operation)
  if (!result.ok) { moveError.value = result.reason; return }
  trackIds.value = result.order.trackIds; workbenchSpec.value.splitAfter = result.order.splitAfter; moveError.value = ''
}
function removeTrack(trackId: string): void {
  if (blocked.value) return
  if (workbenchSpec.value.distribution) { moveError.value = '请先明确退出分盘视图，再从完整母版移除曲目；旧规划与预留不会自动改写。'; return }
  const index = trackIds.value.indexOf(trackId)
  if (index < 0) return
  const previousRules = workbenchSpec.value.rules
  workbenchSpec.value.rules = pruneRulesAfterTrackRemoval(trackIds.value, previousRules, trackId)
  trackIds.value = trackIds.value.filter(id => id !== trackId)
  if (workbenchSpec.value.format === 'cassette') workbenchSpec.value.splitAfter = Math.min(Math.max(1, workbenchSpec.value.splitAfter - (index < workbenchSpec.value.splitAfter ? 1 : 0)), trackIds.value.length || 1)
  moveError.value = `曲目移除后，请保存草稿并重新计算分面；${previousRules.length !== workbenchSpec.value.rules.length || previousRules.some((rule, ruleIndex) => rule !== workbenchSpec.value.rules[ruleIndex]) ? '已整理被删曲目及相邻连播规则，请复核首末曲与指定面约束；' : ''}旧版本和已完成录音不变。`
}
async function play(trackId: string): Promise<void> {
  if (!draft.value || blocked.value) return
  error.value = ''
  try {
    const current = await api.getMasterDraftTrackRuntime(draft.value.id, trackId)
    if (!current.reference) { error.value = '当前曲目链接待重新定位，已保存的草稿和曲序仍保留。'; return }
    const zone = (await api.listZones()).zones.find(z => z.selected)
    if (!zone) { error.value = '请先在现有播放设备菜单选择 Roon Zone。'; return }
    await api.playRoonTrack(current.reference, zone.zoneId)
  } catch { if (alive) error.value = '试听未能启动，请检查 Roon 和播放设备；没有开始正式录音。' }
}
onMounted(() => { mounted = true; if (!reloadRequired.value) { if (pendingReservationNavigation.value) void openReservationNavigation(pendingReservationNavigation.value); else void list() } })
onUnmounted(() => { mounted = false; alive = false; ++generation; ++reservationNavigationGeneration; workflow.dispose(); workspace.dispose(); for (const cleanup of focusCleanups) cleanup() })
</script>

<template>
  <section ref="viewRoot" class="recording-view" data-component="RecordingView" aria-labelledby="recording-heading">
    <header class="recording-heading">
      <div>
        <p class="recording-kicker">{{ page === 'workbench' && draft ? '当前制作' : '录音' }}</p>
        <h2 id="recording-heading">{{ page === 'workbench' && draft ? draft.title : '录音' }}</h2>
        <p class="recording-subtitle">{{ page === 'workbench' && draft ? `${draft.trackCount} 首 · ${types[draft.programType]} · 草稿修订 ${draft.revision}` : '从音乐、分面与这一盘磁带开始；每一步都能回到同一份制作。' }}</p>
      </div>
      <nav class="recording-topnav" aria-label="录音页面">
        <button type="button" :aria-current="page === 'my-work' ? 'page' : undefined" :disabled="blocked || workspaceUnsaved || picker || reservationNavigationLoading || !['my-work', 'workbench'].includes(page)" @click="back()">我的制作</button>
        <button v-if="draft" type="button" :aria-current="page === 'workbench' ? 'page' : undefined" :disabled="reloadRequired || picker || reservationNavigationLoading || page !== 'workbench' || dirty || splitDirty" @click="recordPage('workbench')">制作工作台</button>
        <button ref="recordsTrigger" type="button" :aria-current="page === 'archive' ? 'page' : undefined" :disabled="reloadRequired || picker || reservationNavigationLoading || !['my-work', 'workbench'].includes(page) || dirty || splitDirty" @click="openRecords">录音档案</button>
        <button ref="backupTrigger" type="button" :aria-current="page === 'backup' ? 'page' : undefined" :disabled="reloadRequired || picker || reservationNavigationLoading || !['my-work', 'workbench'].includes(page) || dirty || splitDirty" @click="openBackup">备份与恢复</button>
      </nav>
    </header>

    <section v-if="pendingReservationNavigation" class="workspace-message" aria-label="这盘的制作定位">
      <p v-if="reservationNavigationLoading" role="status">正在核对 {{ pendingReservationNavigation.physicalId }} 的草稿、规划与实时预留归属…</p>
      <p v-if="reservationNavigationError" role="alert">{{ reservationNavigationError }}</p>
      <button v-if="reservationNavigationError" type="button" :disabled="reservationNavigationLoading" @click="openReservationNavigation(pendingReservationNavigation)">重试确切制作定位</button>
      <button type="button" :disabled="reservationNavigationLoading" @click="cancelReservationNavigation">取消这次定位</button>
    </section>

    <section v-if="reloadRequired" class="dataset-reload" data-testid="dataset-reload-required" aria-labelledby="dataset-reload-title">
      <h3 id="dataset-reload-title">工作库已切换，需要重新加载窗口</h3>
      <p>旧窗口的录音上下文已停用，未保存的表单将被丢弃。旧工作库保留，已停止的播放不会恢复，未确认操作不会自动重放。</p>
      <button ref="reloadTrigger" class="recording-primary" type="button" :disabled="reloading" @click="reloadWindow">重新加载窗口</button>
      <p v-if="reloading" role="status">正在重新加载窗口…</p>
    </section>

    <template v-else>
      <p v-if="leaveGuardNotice" class="workspace-message error" role="alert">{{ leaveGuardNotice }}</p>
      <MasterSourcePicker v-if="picker" :draft="draft" :busy="saving" :pending="!!pending" :error="error" inline @close="closePicker" @confirm="append" @retry="retry" />

      <section v-else-if="page === 'my-work'" class="recording-home" aria-labelledby="my-work-title">
        <div v-if="pendingPhysicalIntent" class="physical-intent" role="status"><strong>已从实物收藏带入 {{ pendingPhysicalIntent.physicalId }}</strong><p>这只是本次想用的磁带；请先选一份制作，再核对实时库存、分面容量并明确预留。</p><button type="button" @click="cancelPhysicalIntent">取消本次选盘意图</button></div>
        <div class="page-intro">
          <div><p class="recording-kicker">MY WORK</p><h3 id="my-work-title">我的制作</h3><p>继续已有草稿，或从 Roon 选一张专辑、几首歌。选曲不会播放、预留磁带或启动录音。</p></div>
          <button class="recording-primary" data-recording-return-focus="picker-new" type="button" :disabled="blocked" @click="openPicker">新建制作</button>
        </div>
        <p v-if="loading" role="status">正在读取已保存的制作…</p>
        <div v-if="catalog?.items.length" class="draft-grid">
          <button v-for="item in catalog.items" :key="item.id" class="draft-card" type="button" :disabled="loading" @click="open(item.id)">
            <strong>{{ item.title }}</strong>
            <span>{{ item.trackCount }} 首 · {{ duration(item.estimatedDurationMs) }}</span>
            <small>{{ item.sourceLockEligible ? '精确源已验证' : '可先估算分面，源仍待核实' }}</small>
            <span class="card-action">继续制作 →</span>
          </button>
        </div>
        <p v-else-if="catalog && !loading" class="empty-note">还没有制作。先选音乐，后续可以随时回来继续。</p>
        <nav v-if="catalog && catalog.total > catalog.limit" class="pagination" aria-label="制作分页"><button :disabled="loading || !catalog.offset" @click="list(Math.max(0, catalog.offset - 12))">上一页</button><span>{{ catalog.offset + 1 }}–{{ catalog.offset + catalog.items.length }} / {{ catalog.total }}</span><button :disabled="loading || !catalog.hasMore" @click="list(catalog.offset + 12)">下一页</button></nav>
      </section>

      <section v-else-if="page === 'workbench' && draft" class="workbench" aria-labelledby="workbench-title">
        <h3 id="workbench-title" class="sr-only">{{ draft.title }}的制作工作台</h3>
        <p v-if="workspaceState.status === 'loading'" role="status" class="workspace-message">正在读取上次保存的工作位置与版本选择…</p>
        <div v-else-if="workspaceState.status === 'error'" role="alert" class="workspace-message error"><p>{{ workspaceState.error }}</p><button v-if="workspaceState.pending" type="button" :disabled="workspaceState.writing" @click="workspace.retry()">重试原保存操作</button><button type="button" :disabled="loading" @click="open(draft.id)">重新读取并放弃本地未保存选择</button></div>
        <p v-else-if="workspaceState.writing" role="status" class="workspace-message">正在保存本次选择与页面位置；尚未取得持久回执。</p>
        <div v-if="staleFields.length" class="workspace-message stale" role="status"><strong>已存引用需要复核</strong><ul><li v-for="(item, index) in staleFields" :key="item.field + index">{{ staleText(item) }}</li></ul></div>
        <div class="workbench-columns">
          <div class="workbench-main">
            <section class="workbench-card" aria-labelledby="music-sides-title">
              <div class="section-heading"><div><h4 id="music-sides-title">音乐与 {{ workbenchSpec.format === 'dat' ? '连续节目' : 'A/B 分面' }}</h4><p>按组调整曲序与分面，连播组一起移动。保存草稿后重新估算，旧冻结版本不会被改写。</p></div><button data-recording-return-focus="picker-add" type="button" :disabled="blocked || dirty || !!workbenchSpec.distribution" @click="openPicker">添加音乐</button></div>
              <fieldset :disabled="blocked" class="draft-fields"><legend class="sr-only">编辑制作信息</legend><label>制作标题<input v-model="title" maxlength="240" required></label><label>节目类型<select v-model="programType"><option v-for="(label, value) in types" :key="value" :value="value">{{ label }}</option></select></label></fieldset>
              <p class="estimate-note">草稿时长 {{ duration(draft.estimatedDurationMs) }}；未知时长不按零计算。{{ selectedPlan?.sourceBasis === 'verified-sources' ? '所选规划使用已验证源时长。' : '未锁源时仅为 Roon 约值，正式冻结仍须精确文件证据。' }}</p>
              <div v-if="workbenchSpec.distribution" class="workbench-distribution" role="status">
                <p v-if="workbenchProjection.invalid">旧分盘曲序与当前完整母版已不一致；下方展示完整母版，不把旧盘内容或容量当成当前事实。</p>
                <p v-else>当前只展示第 {{ (workbenchProjection.segmentIndex ?? 0) + 1 }} / {{ workbenchProjection.segmentCount }} 盘的 {{ workbenchProjection.trackIds.length }} 首；完整母版共 {{ tracks.length }} 首。旧组、其他盘、预留与冻结历史均未改变。</p>
                <details><summary>查看完整母版曲序（{{ tracks.length }} 首）</summary><ol><li v-for="(track, index) in tracks" :key="track.id">{{ index + 1 }}. {{ track.metadata.title }}</li></ol></details>
                <button type="button" :disabled="blocked" @click="releaseDistribution">退出分盘视图，编辑完整母版</button>
                <small>仅清除本机未保存编辑稿里的分盘和旧逐曲规则；原规划、库存预留及冻结版本保留。修改后须重新创建或明确选择有效规划。</small>
              </div>
              <p v-if="moveError" class="workbench-warning" role="status">{{ moveError }}</p>
              <div class="side-grid">
                <article v-for="side in workbenchSides" :key="side.name" class="side-card">
                  <header><div><span class="side-badge">{{ side.name }}</span><strong>{{ side.name === 'Program' ? '连续节目' : 'SIDE ' + side.name }}</strong></div><span>{{ sideEstimate(side.name) }}</span></header>
                  <p class="side-budget" :class="{ 'is-over': sideBudget(side.name).includes('超出') }">{{ sideBudget(side.name) }}</p>
                  <ol class="side-tracks">
                    <li v-for="(track, index) in side.tracks" :key="track.id">
                      <span class="track-index">{{ String(index + 1).padStart(2, '0') }}</span>
                      <div class="track-copy"><strong>{{ track.metadata.title }}</strong><small>{{ [track.metadata.artist, track.metadata.album, track.metadata.version].filter(Boolean).join(' · ') || '版本元数据待核实' }}</small><small>{{ sourceLabel(track.id) }} · {{ duration(track.metadata.durationMs) }}</small>
                        <div class="track-actions">
                          <button type="button" :disabled="blocked || !!workbenchSpec.distribution" :aria-label="'上移 ' + track.metadata.title" @click="moveGroup(track.id, { direction: -1 })">上移</button>
                          <button type="button" :disabled="blocked || !!workbenchSpec.distribution" :aria-label="'下移 ' + track.metadata.title" @click="moveGroup(track.id, { direction: 1 })">下移</button>
                          <button v-if="workbenchSpec.format === 'cassette'" type="button" :disabled="blocked || !!workbenchSpec.distribution" @click="moveGroup(track.id, { side: side.name === 'A' ? 'B' : 'A' })">移至 {{ side.name === 'A' ? 'B' : 'A' }} 面</button>
                          <button type="button" :data-recording-return-focus="'source-' + track.id" :disabled="blocked || dirty" @click="openSource(track.id)">处理源</button>
                          <button type="button" :disabled="blocked" @click="play(track.id)">试听</button>
                          <button type="button" :disabled="blocked || !!workbenchSpec.distribution" :aria-label="'移除 ' + track.metadata.title" @click="removeTrack(track.id)">移除</button>
                        </div>
                      </div>
                    </li>
                  </ol>
                  <p v-if="!side.tracks.length" class="empty-note">这一面还没有曲目。</p>
                </article>
              </div>
              <div class="workbench-actions"><button type="button" :disabled="blocked || !dirty || !title.trim()" @click="save">保存标题与曲序</button><button type="button" :disabled="blocked || !dirty" @click="open(draft.id)">撤销未保存的曲目修改</button><button type="button" class="recording-primary" data-recording-return-focus="media-main" :disabled="blocked || dirty || !draft.trackCount" @click="openMediaPlanning(workflowState.selection.planId)">估算分面与选带</button></div>
              <p v-if="dirty || splitDirty" role="status" class="estimate-note">当前工作台有未保存改动。{{ dirty ? '先保存标题与曲序；' : '' }}分面变化还需在“估算分面与选带”中由当前库存重新计算并保存。</p>
            </section>
          </div>
          <aside class="workbench-aside" aria-label="这次制作的状态">
            <RecordingNextStep :state="workflowState" :next-step="nextStep" :disabled="blocked || dirty || splitDirty || workspaceState.status !== 'ready'" @action="nextAction" @select="selectWorkflow" />
            <section class="context-card"><div class="section-heading"><h4>这盘实物</h4><button type="button" data-recording-return-focus="media-copy" :disabled="blocked || dirty" @click="openMediaPlanning(workflowState.selection.planId)">更换或预留</button></div><p v-if="currentPhysicalId">本次想用：<strong>{{ currentPhysicalId }}</strong><br>{{ physicalDescription(currentPhysicalId) }}；选择意图不是预留。</p><p v-if="selectedPlan?.reservation">规划已预留：<strong>{{ selectedPlan.reservation.physicalId }}</strong><br>{{ physicalDescription(selectedPlan.reservation.physicalId) }}；切换须先明确释放。</p><p v-else>尚未预留。先看逐面容量，再选择合规的现有库存。</p><p v-if="currentPhysicalId && selectedPlan?.reservation && currentPhysicalId !== selectedPlan.reservation.physicalId" class="workbench-warning">本次想用的磁带与规划现有预留不同；不会自动释放或换带。</p><button v-if="currentPhysicalId" type="button" :disabled="blocked || workspaceState.status !== 'ready'" @click="workspace.choose({ selectedPhysicalId: undefined })">清除本次选盘意图</button><small v-if="selectedPlan">{{ selectedPlan.sourceBasis === 'verified-sources' ? '基于已验证源时长' : selectedPlan.sourceBasis === 'roon-estimate' ? '基于 Roon 约值，须复算' : '源不可用，不能正式冻结' }} · 规划 {{ selectedPlan.id.slice(0, 8) }}</small></section>
            <section class="context-card"><h4>制作方式与设备</h4><p>{{ workflowState.selection.path === 'direct' ? '原音制作 / Direct' : workflowState.selection.path === 'logic' ? 'Logic 工作区' : workflowState.selection.path === 'prep' ? '使用已确认 PREP' : '选择冻结布局后再决定本次路径' }}</p><p>录音设备与本次参数在执行准备中核对；选曲与估算不会接管设备。</p><button type="button" data-recording-return-focus="execution-main" :disabled="blocked || dirty" @click="openExecution()">录音参数与执行资产</button></section>
            <details class="context-card extra-steps"><summary>版本、Logic 与计划</summary><div class="extra-actions"><button type="button" data-recording-return-focus="versions" :disabled="blocked || dirty" @click="openMasterVersions(workflowState.selection.planId)">母版与版本</button><button ref="preparationTrigger" type="button" data-recording-return-focus="logic" :disabled="blocked || dirty" @click="openPreparation(workflowState.selection.layoutId)">Logic 工作区</button><button ref="preparedTrigger" type="button" data-recording-return-focus="prepared" :disabled="blocked || dirty" @click="openPrepared(workflowState.selection.preparationId)">Render 与 PREP</button><button ref="executionTrigger" type="button" data-recording-return-focus="execution" :disabled="blocked || dirty" @click="openExecution()">执行资产</button><button ref="recordingPlanTrigger" type="button" data-recording-return-focus="plan" :disabled="blocked || dirty" @click="openRecordingPlan()">计划与预检</button></div></details>
          </aside>
        </div>
        <div v-if="discarding" class="discard"><p>离开会放弃当前未保存的标题、曲序或分面草稿；已保存的规划与历史版本不变。</p><button @click="back(true)">放弃未保存修改并返回我的制作</button><button @click="discarding = false">继续编辑</button></div>
      </section>

      <section v-else class="recording-subpage" aria-label="制作子页面">
        <div class="subpage-return"><strong>{{ draft ? '制作工作台 / 当前步骤' : '录音 / 当前步骤' }}</strong><span v-if="draft">{{ draft.title }}</span></div>
        <SourceEvidencePanel v-if="draft && page === 'source' && sourceTrackId" :draft-id="draft.id" :draft-revision="draft.revision" :track-id="sourceTrackId" :title="draft.tracks.find(t => t.id === sourceTrackId)?.metadata.title ?? '曲目'" inline @close="closeSources" />
        <MediaPlanningPanel v-if="draft && page === 'media' && mediaPlanning" :draft="draft" :initial-plan-id="initialMediaPlanId" :initial-split-after="initialMediaSplitAfter" :initial-spec="initialMediaSpec" :initial-physical-id="currentPhysicalId" inline @changed="mediaChanged" @selected="mediaSelected" @close="closeMediaPlanning" />
        <MasterVersionsPanel v-if="draft && page === 'versions' && masterVersions" :draft="draft" :initial-plan-id="initialVersionPlanId" inline @close="closeMasterVersions" @prepare="openPreparation" />
        <PreparationPanel v-if="draft && page === 'logic' && preparation" :draft="draft" :initial-layout-id="preparationLayoutId" inline @close="closePreparation" @import-render="openPrepared" />
        <PreparedPanel v-if="draft && page === 'prepared' && prepared" :draft="draft" :initial-preparation-id="preparedId" inline @close="closePrepared" />
        <ExecutionPanel v-if="draft && page === 'assets' && execution" :draft="draft" :initial-context="initialExecutionContext" inline @close="closeExecution" />
        <RecordingPlanPanel v-if="draft && page === 'plan' && recordingPlan" ref="recordingPlanPanel" :key="draft.id + ':' + draft.revision" :draft="draft" :initial-context="initialRecordingPlanContext" inline @close="closeRecordingPlan" />
        <RecordingRecordsPanel v-if="page === 'archive' && recordsOpen" ref="recordsPanel" :draft-id="draft?.id" inline @close="closeRecords" />
        <BackupRestorePanel v-if="page === 'backup' && backupRestore" inline @close="closeBackupRestore" @activated="activatedDataset" />
      </section>

      <p v-if="loading && page !== 'my-work'" role="status">正在读取制作…</p>
      <p v-if="notice" class="recording-feedback" role="status">{{ notice }}</p>
      <p v-if="error && !picker" class="recording-feedback error" role="alert">{{ error }} <button v-if="pending" :disabled="saving" @click="retry">重试原操作</button><button v-else :disabled="loading" @click="error = ''; draft ? open(draft.id) : list()">重新读取</button></p>
      <footer class="recording-footer"><p>选曲、估算和试听都不会开始正式录音。</p><button type="button" :disabled="reloadRequired || picker || !['my-work', 'workbench'].includes(page) || dirty || splitDirty || workspaceUnsaved" @click="emit('open-collection', currentPhysicalId)">查看实物收藏 →</button></footer>
    </template>
  </section>
</template>

<style scoped>
.recording-view{box-sizing:border-box;max-width:1440px;min-width:0;margin:0 auto;padding:20px 32px;color:var(--mb-text-primary);--mb-accent:#277449;--mb-accent-hover:#1b603b;--mb-accent-soft:rgba(39,116,73,.14);--mb-on-accent:#fff;--recording-card-bg:rgba(255,253,250,.88)}
:global(:root[data-theme='dark'] .recording-view){--mb-accent:#93d7b0;--mb-accent-hover:#b6e5ca;--mb-accent-soft:rgba(147,215,176,.17);--mb-on-accent:#183325;--recording-card-bg:rgba(42,49,54,.88)}
.recording-heading,.page-intro,.section-heading,.subpage-return,.side-card>header,.recording-footer{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.recording-heading{align-items:center;padding-bottom:16px;border-bottom:1px solid var(--mb-glass-border)}
.recording-heading>div{min-width:0;max-width:100%}
.recording-kicker{margin:0 0 5px;color:var(--mb-accent);font-size:11px;font-weight:700;letter-spacing:.08em}
h2{margin:0;font-size:clamp(24px,2.4vw,32px);line-height:1.25;overflow-wrap:anywhere}
h3{margin:0;font-size:clamp(22px,2.2vw,30px);line-height:1.3}
h4{margin:0;font-size:17px;line-height:1.4}
p{line-height:1.65;overflow-wrap:anywhere}
.recording-subtitle,.page-intro p,.section-heading p,.estimate-note,.empty-note,.context-card p,.recording-footer p{color:var(--mb-text-secondary);font-size:13px}
.page-intro{align-items:center;margin:26px 0 22px}
.page-intro p{margin:7px 0 0}
.recording-topnav{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
button{box-sizing:border-box;min-height:42px;padding:8px 13px;border:1px solid var(--mb-glass-border);border-radius:9px;background:var(--mb-glass-clear);color:var(--mb-text-primary);font:inherit;font-size:13px;cursor:pointer}
button:hover:not(:disabled){border-color:var(--mb-accent);color:var(--mb-accent)}
button:active:not(:disabled){transform:scale(.985)}
button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}
.recording-topnav button{border-color:transparent;background:transparent}
.recording-topnav button[aria-current=page]{color:var(--mb-accent);background:var(--mb-accent-soft);border-color:var(--mb-glass-border)}
.recording-primary{border-color:var(--mb-accent);background:var(--mb-accent);color:var(--mb-on-accent);font-weight:650}
.recording-primary:hover:not(:disabled){color:var(--mb-on-accent);filter:brightness(1.08)}
.recording-home,.workbench,.recording-subpage{min-width:0}
.draft-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr));gap:15px}
.draft-card{display:flex;min-width:0;min-height:170px;align-items:flex-start;flex-direction:column;gap:9px;padding:20px;text-align:left;background:var(--mb-glass-clear);backdrop-filter:blur(14px)}
.draft-card strong{font-size:17px;overflow-wrap:anywhere}
.draft-card span,.draft-card small{font-size:12px;color:var(--mb-text-secondary)}
.draft-card .card-action{margin-top:auto;color:var(--mb-accent);font-weight:650}
.pagination,.workbench-actions,.track-actions,.extra-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pagination{justify-content:center;margin-top:22px}
.pagination span{color:var(--mb-text-secondary);font-size:12px}
.workbench-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(255px,300px);align-items:start;gap:22px}
.workbench-main,.workbench-aside{min-width:0}
.workbench-card,.context-card,.recording-subpage{min-width:0;padding:22px;border:1px solid var(--mb-glass-border);border-radius:15px;background:var(--recording-card-bg);backdrop-filter:blur(14px)}
.workbench{padding-top:18px}
.workbench-aside{display:grid;gap:14px}
.workbench-aside :deep(.recording-next-step){margin:0}
.section-heading{align-items:flex-start;margin-bottom:16px}
.section-heading p{margin:5px 0 0}
.section-heading button{flex:none}
.draft-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:0;margin:15px 0;border:0}
.draft-fields label{display:grid;min-width:0;gap:7px;font-size:12px}
.draft-fields input,.draft-fields select{box-sizing:border-box;width:100%;min-height:42px;min-width:0;padding:8px 10px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit}
.estimate-note{margin:10px 0 18px}
.workbench-distribution{margin:12px 0 18px;padding:13px 15px;border:1px solid var(--mb-glass-border);border-radius:11px;background:var(--mb-glass-clear);font-size:13px}
.workbench-distribution p{margin:0 0 8px}.workbench-distribution summary{min-height:44px;padding:12px 0;cursor:pointer}.workbench-distribution ol{margin:0 0 12px;padding-left:24px}.workbench-distribution li{padding:3px 0;overflow-wrap:anywhere}.workbench-distribution small{display:block;margin-top:8px;color:var(--mb-text-secondary);line-height:1.6}
.side-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.side-card{display:flex;min-width:0;flex-direction:column;border:1px solid var(--mb-glass-border);border-radius:13px;background:var(--mb-bg-base)}
.side-card>header{align-items:center;padding:15px;border-bottom:1px solid var(--mb-divider);font-size:13px}
.side-card>header>div{display:flex;align-items:center;gap:9px}
.side-card>header>span{color:var(--mb-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.side-budget{margin:0;padding:10px 15px;border-bottom:1px solid var(--mb-divider);color:var(--mb-text-secondary);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.side-budget.is-over{color:var(--mb-danger);font-weight:650}
.side-badge{display:inline-grid;min-width:30px;height:30px;place-items:center;padding:0 4px;border-radius:7px;background:var(--mb-accent-soft);color:var(--mb-accent);font-size:13px;font-weight:700}
.side-tracks{list-style:none;min-height:84px;margin:0;padding:0}
.side-tracks li{display:flex;min-width:0;gap:11px;padding:16px 13px;border-bottom:1px solid var(--mb-divider)}
.side-tracks li:last-child{border-bottom:0}
.track-index{flex:none;color:var(--mb-text-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.track-copy{min-width:0;flex:1}
.track-copy strong,.track-copy small{display:block;overflow-wrap:anywhere}
.track-copy strong{font-size:14px}
.track-copy small{margin-top:4px;color:var(--mb-text-secondary);font-size:11px;line-height:1.5}
.track-actions{margin-top:9px;gap:4px}
.track-actions button{min-height:30px;padding:4px 7px;border-color:transparent;background:transparent;color:var(--mb-accent);font-size:11px}
.track-actions button:hover:not(:disabled){border-color:var(--mb-glass-border)}
.workbench-actions{margin-top:18px}
.workbench-warning,.recording-feedback.error{padding:11px 13px;border-left:3px solid var(--mb-accent);background:var(--mb-bg-base);font-size:13px}
.workspace-message,.physical-intent{margin:16px 0;padding:12px 15px;border:1px solid var(--mb-glass-border);border-radius:10px;background:var(--mb-glass-clear);font-size:13px}
.workspace-message.error,.workspace-message.stale{border-left:3px solid var(--mb-accent)}
.workspace-message p,.physical-intent p{margin:4px 0 10px}.workspace-message ul{margin:8px 0 0;padding-left:20px}
.context-card h4{font-size:14px}
.context-card p{margin:9px 0}
.context-card strong{color:var(--mb-text-primary)}
.context-card small{font-size:11px;color:var(--mb-text-secondary);overflow-wrap:anywhere}
.context-card .section-heading{align-items:center;margin:0}
.context-card .section-heading button{min-height:32px;padding:4px 7px;font-size:11px}
.extra-steps{padding:0}
.extra-steps summary{min-height:44px;padding:14px 20px;font-size:13px;font-weight:650;cursor:pointer}
.extra-actions{padding:0 20px 18px}
.extra-actions button{min-height:34px;font-size:11px}
.subpage-return{align-items:center;margin:0 0 20px}
.subpage-return span{font-size:12px;color:var(--mb-text-secondary);overflow-wrap:anywhere}
.recording-subpage{margin-top:24px;backdrop-filter:blur(14px)}
.recording-feedback{margin-top:16px;font-size:13px}
.recording-footer{align-items:center;margin-top:26px;padding-top:16px;border-top:1px solid var(--mb-glass-border)}
.recording-footer p{margin:0}
.recording-footer button{background:transparent;border-color:transparent;color:var(--mb-accent)}
.dataset-reload,.discard{margin:24px 0;padding:20px;border:1px solid var(--mb-accent);border-radius:12px;background:var(--mb-bg-base)}
.dataset-reload p,.discard p{color:var(--mb-text-secondary);font-size:14px;line-height:1.75}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media(max-width:1180px){.workbench-columns{grid-template-columns:minmax(0,1fr) 260px}.side-grid{grid-template-columns:1fr}}
@media(max-width:850px){.recording-view{padding:22px 18px}.recording-heading,.page-intro{align-items:flex-start;flex-direction:column}.workbench-columns{grid-template-columns:1fr}.workbench-aside{grid-template-columns:repeat(2,minmax(0,1fr))}.workbench-aside :deep(.recording-next-step){grid-column:1/-1}}
@media(max-width:600px){.workbench-card,.context-card,.recording-subpage{padding:16px}.workbench-aside,.draft-fields{grid-template-columns:1fr}.side-grid{grid-template-columns:1fr}.recording-topnav{width:100%}.recording-topnav button{flex:1 1 auto}.recording-footer{align-items:flex-start;flex-direction:column}}
@media(prefers-reduced-motion:reduce){button:active:not(:disabled){transform:none}}
</style>
