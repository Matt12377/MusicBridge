import type {
  ArchiveOperationView, ExecutionAsset, ExecutionMode, LayoutVersion, RecordingPlansPublicApi, RecordingExecutionPublicApi, RecordingArchivePublicApi, MasterVersionsPublicApi,
  RecordingPlanProposal, RecordingPlanVersion, RecordingPreflightResult,
} from '@music-bridge/contracts'

export type RecordingPlanApi = RecordingPlansPublicApi
  & Pick<RecordingExecutionPublicApi, 'listExecutionAssets'>
  & Pick<RecordingArchivePublicApi, 'listArchives'>
  & Pick<MasterVersionsPublicApi, 'listMasterVersions'>
export interface RecordingPlanContext { layoutId: string; mode: ExecutionMode; preparedId?: string }
type FreezeRequest = Parameters<RecordingPlanApi['freezeRecordingPlan']>[0]
export interface RecordingPlanState {
  status: 'unread' | 'loading' | 'ready' | 'error'
  assets: readonly ExecutionAsset[]
  operations: readonly ArchiveOperationView[]
  layouts: readonly LayoutVersion[]
  versions: readonly RecordingPlanVersion[]
  assetId: string
  archiveOperationId: string
  proposal?: RecordingPlanProposal
  version?: RecordingPlanVersion
  preflight?: RecordingPreflightResult
  confirmed: boolean
  pending?: FreezeRequest
  sending: boolean
  readId: string
  reading: boolean
  cancelling: boolean
  error: string
  notice: string
}

export function createRecordingPlanController(options: {
  api: RecordingPlanApi; draftId: string; initialContext?: RecordingPlanContext; onChange?: () => void
}) {
  const { api, draftId, initialContext } = options
  const state: RecordingPlanState = { status: 'unread', assets: [], operations: [], layouts: [], versions: [], assetId: '', archiveOperationId: '', confirmed: false, sending: false, readId: '', reading: false, cancelling: false, error: '', notice: '' }
  let alive = true, generation = 0
  const emit = () => { if (alive) options.onChange?.() }
  const locked = () => !alive || state.status === 'loading' || state.reading || state.sending || !!state.pending
  const invalidate = () => { state.proposal = undefined; state.confirmed = false; state.preflight = undefined }
  function assets(): readonly ExecutionAsset[] {
    if (state.status !== 'ready') return []
    return state.assets.filter(asset => asset.draftId === draftId && state.layouts.some(layout => layout.id === asset.layoutVersionId && layout.draftId === draftId && layout.masterVersionId === asset.masterVersionId)
      && (!initialContext || asset.layoutVersionId === initialContext.layoutId
        && (initialContext.mode.startsWith('direct') ? asset.mode.startsWith('direct') : asset.mode.startsWith('prepared'))
        && asset.preparedVersionId === initialContext.preparedId))
  }
  function archives(): readonly ArchiveOperationView[] {
    const asset = assets().find(item => item.id === state.assetId)
    return asset ? state.operations.filter(op => op.assetId === asset.id && op.draftId === draftId && op.masterVersionId === asset.masterVersionId && op.layoutVersionId === asset.layoutVersionId && op.phase === 'FINALIZED' && !op.active) : []
  }
  function selection() {
    return assets().some(item => item.id === state.assetId) && archives().some(item => item.id === state.archiveOperationId)
      ? { assetId: state.assetId, archiveOperationId: state.archiveOperationId } : undefined
  }
  async function refresh(): Promise<void> {
    if (locked()) return
    const token = ++generation; invalidate(); state.status = 'loading'; state.error = ''; emit()
    try {
      const [execution, archive, versions, plans] = await Promise.all([api.listExecutionAssets(draftId), api.listArchives(draftId), api.listMasterVersions(draftId), api.listRecordingPlans(draftId)])
      if (!alive || token !== generation) return
      if ([execution, archive, versions, plans].some(value => value.draftId !== draftId)) throw new Error('计划资料所属草稿不一致')
      state.assets = execution.assets; state.operations = archive.operations; state.layouts = versions.layouts; state.versions = plans.versions; state.status = 'ready'
      if (!assets().some(item => item.id === state.assetId)) state.assetId = ''
      if (!archives().some(item => item.id === state.archiveOperationId)) state.archiveOperationId = ''
      if (initialContext && !state.layouts.some(item => item.id === initialContext.layoutId)) state.error = '原先明确选择的布局已不可用；没有自动选择其他版本。'
    } catch { if (alive && token === generation) { state.status = 'error'; state.error = '计划资料读取失败，请重试；已有资产、归档和计划不会被当作空列表。' } }
    finally { if (alive && token === generation) emit() }
  }
  function selectAsset(id: string): void {
    if (locked()) return
    state.assetId = assets().some(item => item.id === id) ? id : ''; state.archiveOperationId = ''; state.version = undefined; invalidate(); state.notice = ''; emit()
  }
  function selectArchive(id: string): void {
    if (locked()) return
    state.archiveOperationId = archives().some(item => item.id === id) ? id : ''; state.version = undefined; invalidate(); state.notice = ''; emit()
  }
  async function read(operation: (readId: string) => Promise<void>, failure: string, cancellable = true): Promise<void> {
    const token = ++generation, id = crypto.randomUUID(); state.reading = true; state.readId = cancellable ? id : ''; state.error = ''; state.notice = ''; emit()
    // operation只能在同一代际提交结果；取消/卸载不回填迟到事实。
    currentRead = { token, id }
    try { await operation(id) }
    catch { if (alive && token === generation) state.error = failure }
    finally { if (alive && token === generation) { state.reading = false; state.readId = ''; emit() } }
  }
  let currentRead = { token: 0, id: '' }
  const current = (id: string) => alive && currentRead.id === id && currentRead.token === generation
  async function preview(): Promise<void> {
    const chosen = selection(); if (locked() || !chosen) return
    invalidate(); state.version = undefined
    await read(async id => {
      const result = await api.previewRecordingPlan({ readId: id, selection: chosen })
      if (!current(id)) return
      if (result.draftId !== draftId || result.selection.assetId !== chosen.assetId || result.selection.archiveOperationId !== chosen.archiveOperationId) throw new Error('提案上下文不一致')
      state.proposal = result
    }, '计划预览未通过。请核对当前参数、实体预留、执行资产和归档文件后重新预览；未冻结计划。')
  }
  function confirm(value: boolean): void { if (!locked() && state.proposal) { state.confirmed = value; emit() } }
  async function retry(): Promise<void> {
    if (!alive || !state.pending || state.sending) return
    const request = state.pending, token = ++generation; state.sending = true; state.error = ''; emit()
    try {
      const result = await api.freezeRecordingPlan(structuredClone(request))
      if (!alive || token !== generation) return
      if (result.draftId !== draftId || result.execution.assetId !== request.selection.assetId || result.archive.operationId !== request.selection.archiveOperationId) throw new Error('冻结回执上下文不一致')
      state.pending = undefined; invalidate(); state.version = result
      state.versions = [result, ...state.versions.filter(item => item.id !== result.id)]
      state.notice = '计划身份与参数快照已冻结；没有开始录音。请显式运行只读预检，Gate B 尚未认证。'
    } catch (cause) {
      if (!alive || token !== generation) return
      if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST|OUTBOX_SCOPE_MISMATCH)\]/u.test(cause instanceof Error ? cause.message : '')) {
        state.pending = undefined; invalidate(); state.error = '冻结请求未接受，当前事实或工作库已变化。请刷新、重新预览并确认。'
      } else state.error = '冻结回执尚未确认。请重试原操作；会保留同一命令与选择，不自动创建第二份计划。'
    } finally { if (alive && token === generation) { state.sending = false; emit() } }
  }
  async function freeze(): Promise<void> {
    const chosen = selection(), proposal = state.proposal
    if (locked() || !chosen || !proposal || !state.confirmed) return
    state.pending = { commandId: crypto.randomUUID(), selection: structuredClone(chosen), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true }
    await retry()
  }
  async function readVersion(versionId: string): Promise<void> {
    if (locked() || !state.versions.some(item => item.id === versionId)) return
    state.version = undefined; invalidate()
    await read(async id => {
      const result = await api.getRecordingPlanVersion(versionId)
      if (!current(id)) return
      if (!result.plan || result.plan.id !== versionId || result.plan.draftId !== draftId) throw new Error('计划不存在或上下文不一致')
      state.version = result.plan
    }, '所选计划版本读取失败；没有改选其他历史版本。', false)
  }
  async function preflight(): Promise<void> {
    if (locked() || !state.version) return
    const planVersionId = state.version.id; state.preflight = undefined
    await read(async id => {
      const result = await api.preflightRecordingPlan({ readId: id, planVersionId })
      if (!current(id)) return
      if (result.planVersionId !== planVersionId || result.formalReady !== false || result.gateB !== 'NOT_RUN') throw new Error('预检结果与当前边界不一致')
      state.preflight = result
    }, '本次预检读取失败，不能视为通过。已冻结的计划和参数快照保持不变。')
  }
  async function cancelRead(): Promise<void> {
    if (!alive || !state.readId || state.cancelling) return
    const id = state.readId; ++generation; state.cancelling = true; emit()
    try {
      await api.cancelRecordingPlanRead(id)
      if (alive) { state.readId = ''; state.reading = false; state.notice = '已取消本次只读核验；不会冻结计划或开始录音。' }
    } catch { if (alive) state.error = '取消读取的回执尚未确认，请重试取消。' }
    finally { if (alive) { state.cancelling = false; emit() } }
  }
  function dispose(): void {
    alive = false; ++generation
    if (state.readId) void api.cancelRecordingPlanRead(state.readId).catch(() => undefined)
  }
  return { state, assets, archives, selection, locked, refresh, selectAsset, selectArchive, preview, confirm, freeze, retry, readVersion, preflight, cancelRead, dispose }
}
