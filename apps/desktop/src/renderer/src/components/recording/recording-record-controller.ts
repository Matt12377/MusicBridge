import {
  isCollectionId, isPhysicalId, isListRecordingRecordsRequest, isRecordingRecordsPage,
  isRecordingRecordDetail, isPhysicalRecordingHistory, isRecordingVisualResult,
  isPreviewPhysicalRecordingDispositionRequest, isPhysicalRecordingDispositionProposal,
  isApplyPhysicalRecordingDispositionResult, isMediaPlan,
  type RecordingRecordsPublicApi, type RecordingRecordFilter, type RecordingRecordsPage,
  type RecordingRecordDetail, type PhysicalRecordingHistory, type PhysicalRecordingState,
  type RecordingVisualResult, type PhysicalRecordingDispositionIntent,
  type PhysicalRecordingDispositionProposal, type ApplyPhysicalRecordingDispositionRequest,
  type MediaPlanningPublicApi, type MediaPlan,
} from '@music-bridge/contracts'

type Phase = 'unread' | 'loading' | 'ready' | 'error'
export type RecordingRecordApi = RecordingRecordsPublicApi & Partial<Pick<MediaPlanningPublicApi, 'listMediaPlans'>>
export interface RecordingRecordState {
  filter: RecordingRecordFilter; page?: RecordingRecordsPage; listPhase: Phase; listError: string
  selectedId: string; physicalId: string; detail?: RecordingRecordDetail; reading: boolean; detailError: string
  current?: PhysicalRecordingState; history?: PhysicalRecordingHistory; historyPhase: Phase; historyError: string
  visualId: string; visual?: RecordingVisualResult; visualPhase: Phase; visualError: string
  proposal?: PhysicalRecordingDispositionProposal; previewing: boolean; confirmed: boolean
  pending?: ApplyPhysicalRecordingDispositionRequest; sending: boolean; operationError: string; notice: string
  plans: readonly MediaPlan[]; plansPhase: Phase; plansError: string
}
export function normalizeRecordingPhysicalId(value: string, medium: '' | 'C' | 'D'): string {
  const text = value.trim().toUpperCase(), match = /^(?:MB-)?([CD])-([0-9]{1,9})$/u.exec(text)
  const type = match?.[1] ?? medium, digits = match?.[2] ?? (/^[0-9]{1,9}$/u.test(text) ? text : '')
  if (!type || !digits || Number(digits) === 0) return ''
  const result = `MB-${type}-${String(Number(digits)).padStart(5, '0')}`
  return isPhysicalId(result) ? result : ''
}
// 比较有限DTO而非对象属性插入顺序；不接受回执把原意图或CAS换成另一项。
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
export function createRecordingRecordController(options: { api: RecordingRecordApi; draftId?: string; onChange?: () => void }) {
  const state: RecordingRecordState = { filter: {}, listPhase: 'unread', listError: '', selectedId: '', physicalId: '', reading: false, detailError: '', historyPhase: 'unread', historyError: '', visualId: '', visualPhase: 'unread', visualError: '', previewing: false, confirmed: false, sending: false, operationError: '', notice: '', plans: [], plansPhase: 'unread', plansError: '' }
  const { api } = options
  let alive = true, context = 0, listToken = 0, detailToken = 0, historyToken = 0, visualToken = 0, previewToken = 0, planToken = 0
  // 仅保留最近一次成功写入的版本下界，防止同实体切换档案时读回写前状态。
  let lastApplied: PhysicalRecordingState | undefined
  const emit = () => { if (alive) options.onChange?.() }
  const valid = (generation: number) => alive && generation === context
  function invalidateProposal(): void { ++previewToken; state.proposal = undefined; state.previewing = false; state.confirmed = false }
  function clearSelection(): void {
    ++context; ++listToken; ++detailToken; ++historyToken; ++visualToken; invalidateProposal()
    state.selectedId = ''; state.physicalId = ''; state.detail = undefined; state.current = undefined; state.history = undefined
    state.reading = false; state.detailError = ''; state.historyPhase = 'unread'; state.historyError = ''
    state.visualId = ''; state.visual = undefined; state.visualPhase = 'unread'; state.visualError = ''; state.notice = ''
    if (state.listPhase === 'loading') state.listPhase = 'unread'
  }
  function acceptCurrent(value: PhysicalRecordingState): void {
    if (lastApplied?.physicalId === value.physicalId && (value.revision < lastApplied.revision || value.physicalRevision < lastApplied.physicalRevision)) throw new Error('回执早于已确认写入')
    if (state.current?.physicalId === value.physicalId && (value.revision < state.current.revision || value.physicalRevision < state.current.physicalRevision)) throw new Error('回执版本陈旧')
    state.current = structuredClone(value)
    if (state.detail?.record.completion.physicalId === value.physicalId) state.detail = { ...state.detail, current: structuredClone(value) }
  }
  async function refresh(offset = 0): Promise<void> {
    const request = { page: { offset, limit: 25 }, filter: structuredClone(state.filter) }
    if (!alive || !isListRecordingRecordsRequest(request)) return
    const token = ++listToken, generation = context
    state.page = undefined; state.listPhase = 'loading'; state.listError = ''; emit()
    try {
      const result = await api.listRecordingRecords(request)
      if (!valid(generation) || token !== listToken) return
      if (!isRecordingRecordsPage(result) || result.offset !== offset || result.limit !== 25 || request.filter.physicalId && !result.items.every(item => item.physicalId === request.filter.physicalId)) throw new Error('列表不匹配')
      state.page = structuredClone(result); state.listPhase = 'ready'
    } catch { if (valid(generation) && token === listToken) { state.listPhase = 'error'; state.listError = '档案读取失败，请重试；不能据此判断没有档案。' } }
    finally { if (valid(generation) && token === listToken) emit() }
  }
  async function search(filter: RecordingRecordFilter): Promise<void> {
    if (!alive || !isListRecordingRecordsRequest({ page: { offset: 0, limit: 25 }, filter })) { state.listError = '筛选条件无效，请检查日期范围与字段长度。'; emit(); return }
    clearSelection(); state.filter = structuredClone(filter); await refresh()
  }
  async function history(offset = 0): Promise<void> {
    if (!alive || !isPhysicalId(state.physicalId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return
    const physicalId = state.physicalId, token = ++historyToken, generation = context
    invalidateProposal(); state.history = undefined; state.historyPhase = 'loading'; state.historyError = ''; emit()
    try {
      const result = await api.getPhysicalRecordingHistory({ physicalId, page: { offset, limit: 25 } })
      if (!valid(generation) || token !== historyToken) return
      if (!isPhysicalRecordingHistory(result) || result.state.physicalId !== physicalId || result.entries.offset !== offset || result.entries.limit !== 25) throw new Error('历史不匹配')
      acceptCurrent(result.state); state.history = structuredClone(result); state.historyPhase = 'ready'
    } catch { if (valid(generation) && token === historyToken) { state.historyPhase = 'error'; state.historyError = '实体历史或当前状态无法读取；请重试，不能确认处置。' } }
    finally { if (valid(generation) && token === historyToken) emit() }
  }
  async function openPhysical(physicalId: string): Promise<void> {
    if (!alive || !isPhysicalId(physicalId)) return
    clearSelection(); state.physicalId = physicalId; emit(); await history()
  }
  async function select(id: string): Promise<void> {
    if (!alive || !isCollectionId(id)) return
    clearSelection(); state.selectedId = id; state.reading = true; const token = ++detailToken, generation = context; emit()
    try {
      const result = await api.getRecordingRecord(id)
      if (!valid(generation) || token !== detailToken) return
      if (!result || Object.keys(result).length !== 1 || !isRecordingRecordDetail(result.record) || result.record.record.id !== id) throw new Error('档案不存在或回执不匹配')
      acceptCurrent(result.record.current); state.detail = structuredClone(result.record); state.physicalId = result.record.record.completion.physicalId
      state.reading = false; emit(); await history()
    } catch { if (valid(generation) && token === detailToken) state.detailError = '此档案无法读取或已不可用；未沿用旧详情。' }
    finally { if (valid(generation) && token === detailToken) { state.reading = false; emit() } }
  }
  async function loadVisual(id: string): Promise<void> {
    const photos = state.detail?.record.visuals.photos, attachment = photos?.state === 'captured' ? photos.attachments.find(photo => photo.id === id) : undefined
    if (!alive || !attachment) return
    const token = ++visualToken, generation = context; state.visualId = id; state.visual = undefined; state.visualPhase = 'loading'; state.visualError = ''; emit()
    try {
      const value = await api.getRecordingRecordVisual({ recordingId: attachment.recordingId, attachmentId: id })
      if (!valid(generation) || token !== visualToken) return
      if (!isRecordingVisualResult(value) || value.recordingId !== attachment.recordingId || value.attachmentId !== id || value.sha256 !== attachment.sha256 || value.image.width !== attachment.width || value.image.height !== attachment.height) throw new Error('照片回执不匹配')
      state.visual = structuredClone(value); state.visualPhase = 'ready'
    } catch { if (valid(generation) && token === visualToken) { state.visualPhase = 'error'; state.visualError = '此张历史照片读取失败，请单独重试；不会用型号照片替代。' } }
    finally { if (valid(generation) && token === visualToken) emit() }
  }
  function imageFailed(): void { if (state.visualPhase === 'ready') { state.visual = undefined; state.visualPhase = 'error'; state.visualError = '此张历史照片无法显示，请单独重试。'; emit() } }
  const canPreview = () => alive && !!state.current && state.historyPhase === 'ready' && !state.sending && !state.pending && !state.previewing
  async function preview(intent: PhysicalRecordingDispositionIntent): Promise<void> {
    if (!canPreview() || !state.current) return
    const before = state.current, request = { physicalId: before.physicalId, expectedPhysicalRevision: before.physicalRevision, expectedContentRevision: before.revision, expectedAttempt: before.latestAttempt ? { id: before.latestAttempt.id, revision: before.latestAttempt.revision } : null, intent: structuredClone(intent) }
    invalidateProposal(); state.operationError = ''; state.notice = ''
    if (!isPreviewPhysicalRecordingDispositionRequest(request)) { state.operationError = '请选择完整的处置目标和修订。'; emit(); return }
    const token = ++previewToken, generation = context; state.previewing = true; emit()
    try {
      const result = await api.previewPhysicalRecordingDisposition(request)
      if (!valid(generation) || token !== previewToken) return
      if (!isPhysicalRecordingDispositionProposal(result) || stable(result.request) !== stable(request)) throw new Error('提案与请求不匹配')
      state.proposal = structuredClone(result)
    } catch { if (valid(generation) && token === previewToken) state.operationError = '处置预览被阻断或当前状态已变化，请重新读取实体历史后再预览。' }
    finally { if (valid(generation) && token === previewToken) { state.previewing = false; emit() } }
  }
  function changeIntent(): void { if (alive && !state.sending) { invalidateProposal(); emit() } }
  function setConfirmed(value: boolean): void { if (alive && state.proposal && !state.sending && !state.pending) { state.confirmed = value; emit() } }
  const canRetry = () => alive && !!state.pending && !state.sending && state.physicalId === state.pending.physicalId
  async function retry(): Promise<void> {
    if (!canRetry() || !state.pending) return
    const request = state.pending, generation = context; state.sending = true; state.confirmed = false; state.operationError = ''; emit()
    try {
      const result = await api.applyPhysicalRecordingDisposition(structuredClone(request))
      if (!alive) return
      if (!isApplyPhysicalRecordingDispositionResult(result) || result.disposition.physicalId !== request.physicalId || result.disposition.beforeContentRevision !== request.expectedContentRevision || result.disposition.beforePhysicalRevision !== request.expectedPhysicalRevision || stable(result.disposition.intent) !== stable(request.intent) || stable(result.disposition.observedAttempt) !== stable(request.expectedAttempt)) throw new Error('回执不匹配')
      lastApplied = structuredClone(result.state); state.pending = undefined
      if (valid(generation)) {
        ++historyToken; ++detailToken; invalidateProposal(); acceptCurrent(result.state)
        state.history = undefined; state.historyPhase = 'unread'; state.reading = false
        state.notice = '处置已应用。历史档案未改写；请刷新实体历史查看完整记录。'
      }
    } catch { if (alive) state.operationError = '处置结果尚未确认。请在原实体手动重试原处置；不会自动重放，也不能据此认为未写入。' }
    finally { if (alive) { state.sending = false; emit() } }
  }
  async function apply(): Promise<void> {
    if (!alive || !state.proposal || !state.confirmed || state.pending || state.sending || state.previewing) return
    state.pending = { ...structuredClone(state.proposal.request), commandId: crypto.randomUUID(), proposalFingerprint: state.proposal.proposalFingerprint, userConfirmed: true }
    await retry()
  }
  function abandonRetry(): void {
    if (!alive || state.sending) return
    state.pending = undefined; state.operationError = ''; invalidateProposal(); state.historyPhase = 'unread'
    state.notice = '已停止本地重试；原处置可能已生效，请重新读取实体历史。'; emit()
  }
  async function loadPlans(): Promise<void> {
    if (!alive || !options.draftId || !isCollectionId(options.draftId) || !api.listMediaPlans) return
    const token = ++planToken; state.plans = []; state.plansPhase = 'loading'; state.plansError = ''; emit()
    try {
      const value = await api.listMediaPlans(options.draftId)
      if (!alive || token !== planToken) return
      if (!value || Object.keys(value).some(key => key !== 'draftId' && key !== 'plans') || value.draftId !== options.draftId || !Array.isArray(value.plans) || value.plans.length > 100 || !value.plans.every(plan => isMediaPlan(plan) && plan.draftId === options.draftId) || new Set(value.plans.map(plan => plan.id)).size !== value.plans.length) throw new Error('候选计划不匹配')
      state.plans = structuredClone(value.plans); state.plansPhase = 'ready'
    } catch { if (alive && token === planToken) { state.plansPhase = 'error'; state.plansError = '目标计划无法读取，请刷新；不会自动新建计划。' } }
    finally { if (alive && token === planToken) emit() }
  }
  return { state, refresh, search, openPhysical, select, history, loadVisual, imageFailed, preview, changeIntent, setConfirmed, apply, retry, abandonRetry, canPreview, canRetry, loadPlans, dispose() { alive = false; ++context; ++planToken } }
}
