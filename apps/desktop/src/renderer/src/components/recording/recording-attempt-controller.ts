import {
  isCollectionId, isRecordingAttempt, isRecordingAttemptsPage, MAX_RECORDING_ATTEMPT_PAGE_SIZE,
  type BeginRecordingAttemptSideRequest, type ConfirmRecordingAttemptRequest, type RecordingAttempt,
  type RecordingAttemptConfirmation, type RecordingAttemptsPage, type RecordingAttemptsPublicApi,
  type RecordingPlanVersion, type RenderSide, type StopRecordingAttemptRequest,
} from '@music-bridge/contracts'

type Operation = { kind: 'confirm'; request: ConfirmRecordingAttemptRequest } | { kind: 'beginSide'; request: BeginRecordingAttemptSideRequest } | { kind: 'stop'; request: StopRecordingAttemptRequest }
type Pending = Operation & { snapshot: RecordingAttempt }
export interface RecordingAttemptState {
  plan?: RecordingPlanVersion
  page?: RecordingAttemptsPage
  listPhase: 'unread' | 'loading' | 'ready' | 'error'
  listError: string
  selectedId: string
  stopId: string
  attempt?: RecordingAttempt
  reading: boolean
  detailError: string
  confirmed: boolean
  sending: boolean
  pending?: Pending
  operationError: string
  notice: string
}

export function createRecordingAttemptController(options: { api: RecordingAttemptsPublicApi; onChange?: () => void }) {
  const state: RecordingAttemptState = { listPhase: 'unread', listError: '', selectedId: '', stopId: '', reading: false, detailError: '', confirmed: false, sending: false, operationError: '', notice: '' }
  const { api } = options
  let alive = true, context = 0, listRead = 0, detailRead = 0, mutation = 0
  // 仅当前明确选择的记录保留最近可信身份：失败读取不可用于确认，但不能挡住stop。
  let observed: RecordingAttempt | undefined
  const emit = () => { if (alive) options.onChange?.() }
  function accept(value: RecordingAttempt): void {
    observed = structuredClone(value); state.attempt = structuredClone(value)
    state.stopId = value.status === 'in-progress' ? value.id : ''
  }
  const matchesPlan = (value: RecordingAttempt, plan = state.plan): boolean => !!plan && value.planVersionId === plan.id && value.planContentHash === plan.contentHash
    && value.draftId === plan.draftId && value.physicalId === plan.physicalCopy.physicalId && value.executionAssetId === plan.execution.assetId
    && value.sides.length === plan.execution.audio.length && value.sides.every((side, index) => {
      const receipt = plan.execution.audio[index]
      return !!receipt && side.side === receipt.recipe.side && side.recipeHash === receipt.recipeHash && side.audioSha256 === receipt.audio.sha256 && side.pcmSha256 === receipt.audio.pcmSha256 && side.frameCount === receipt.audio.frameCount
    })
  function setPlan(plan?: RecordingPlanVersion): void {
    if (!alive) return
    ++context; ++listRead; ++detailRead
    state.plan = plan?.status === 'frozen' && plan.formalReady === false && isCollectionId(plan.id) && isCollectionId(plan.draftId) && Array.isArray(plan.execution?.audio) ? structuredClone(plan) : undefined
    state.page = undefined; state.listPhase = 'unread'; state.listError = ''; state.selectedId = ''; state.stopId = ''; observed = undefined; state.attempt = undefined; state.reading = false; state.detailError = ''; state.confirmed = false; state.notice = ''
    // 未确认的命令只保留一份；换上下文不重放，回到原Attempt后才允许手动重试。
    emit()
  }
  async function refresh(offset = 0): Promise<void> {
    if (!alive || !state.plan || !Number.isSafeInteger(offset) || offset < 0 || offset % MAX_RECORDING_ATTEMPT_PAGE_SIZE !== 0) return
    const plan = state.plan, token = ++listRead, generation = context
    state.page = undefined; state.listPhase = 'loading'; state.listError = ''; emit()
    try {
      const value = await api.listRecordingAttempts({ planVersionId: plan.id, draftId: plan.draftId, page: { offset, limit: MAX_RECORDING_ATTEMPT_PAGE_SIZE } })
      if (!alive || generation !== context || token !== listRead) return
      if (!isRecordingAttemptsPage(value) || value.offset !== offset || value.limit !== MAX_RECORDING_ATTEMPT_PAGE_SIZE || !value.items.every(item => matchesPlan(item, plan))) throw new Error('历史回执不匹配')
      state.page = structuredClone(value); state.listPhase = 'ready'
    } catch {
      if (alive && generation === context && token === listRead) { state.listPhase = 'error'; state.listError = '录音尝试读取失败，请重试；不能据此判断没有历史记录。' }
    } finally { if (alive && generation === context && token === listRead) emit() }
  }
  async function readSelected(): Promise<void> {
    if (!alive || !state.plan || !state.selectedId) return
    const plan = state.plan, id = state.selectedId, token = ++detailRead, generation = context
    state.attempt = undefined; state.reading = true; state.detailError = ''; state.confirmed = false; state.notice = ''; emit()
    try {
      const response = await api.getRecordingAttempt(id)
      if (!alive || generation !== context || token !== detailRead) return
      const value = response?.attempt
      if (!response || Object.keys(response).length !== 1 || !isRecordingAttempt(value) || value.id !== id || !matchesPlan(value, plan) || observed && value.revision < observed.revision) throw new Error('录音事实回执不匹配')
      accept(value)
    } catch {
      if (alive && generation === context && token === detailRead) state.detailError = '本次录音事实读取失败或已不可用。请重新读取；不能沿用旧事实进行确认。'
    } finally { if (alive && generation === context && token === detailRead) { state.reading = false; emit() } }
  }
  async function select(id: string): Promise<void> {
    if (!alive || !state.page?.items.some(item => item.id === id)) return
    if (id !== state.selectedId) { observed = undefined; state.stopId = '' }
    ++detailRead; state.selectedId = id; state.attempt = undefined; state.confirmed = false
    await readSelected()
  }
  const canConfirm = (kind: RecordingAttemptConfirmation, side?: RenderSide): boolean => {
    const value = state.attempt
    if (!alive || !value || state.reading || state.sending || state.pending) return false
    if (kind === 'physical-stop') {
      const selected = value.sides.find(item => item.side === side)
      return !!selected?.runId && !selected.physicalStopConfirmedAt && (value.status !== 'in-progress' && value.status !== 'completed' || selected.phase === 'awaiting-physical-stop' && selected.engineStoppedSubmitting)
    }
    if (value.status !== 'in-progress') return false
    if (kind === 'flip') return value.phase === 'awaiting-flip' && !value.flipConfirmedAt
    if (kind === 'physical-recording') return value.phase === 'final-verification' && !value.physicalRecordingConfirmedAt
    return value.phase === 'final-verification' && !!value.physicalRecordingConfirmedAt && !value.finalVerificationCompleteAt
  }
  function setConfirmed(value: boolean): void { if (alive && !state.sending && !state.pending) { state.confirmed = value; emit() } }
  const canRetry = () => alive && !state.sending && !!state.pending && state.selectedId === state.pending.snapshot.id && matchesPlan(state.pending.snapshot)
  const canStop = () => alive && !!state.stopId && observed?.id === state.selectedId && observed.status === 'in-progress' && !(state.sending && state.pending?.kind === 'stop')
  async function send(pending: Pending): Promise<void> {
    const token = ++mutation, generation = context, selectedId = state.selectedId
    ++detailRead; state.reading = false; state.pending = pending; state.sending = true; state.confirmed = false; state.operationError = ''; state.notice = ''; emit()
    try {
      const value = pending.kind === 'confirm' ? await api.confirmRecordingAttempt(structuredClone(pending.request))
        : pending.kind === 'stop' ? await api.stopRecordingAttempt(structuredClone(pending.request)) : await api.beginRecordingAttemptSide(structuredClone(pending.request))
      if (!alive || token !== mutation) return
      const original = pending.snapshot
      if (!isRecordingAttempt(value) || value.id !== original.id || value.planVersionId !== original.planVersionId || value.planContentHash !== original.planContentHash
        || value.draftId !== original.draftId || value.physicalId !== original.physicalId || value.executionAssetId !== original.executionAssetId || value.createdAt !== original.createdAt
        || value.sides.length !== original.sides.length || !value.sides.every((side, index) => {
          const before = original.sides[index]!
          return side.side === before.side && side.recipeHash === before.recipeHash && side.audioSha256 === before.audioSha256 && side.pcmSha256 === before.pcmSha256 && side.frameCount === before.frameCount
        })) throw new Error('操作回执不匹配')
      if (value.revision < pending.snapshot.revision) throw new Error('操作回执版本回退')
      state.pending = undefined
      if (generation === context && selectedId === state.selectedId) {
        ++detailRead; state.reading = false
        if (!observed || value.revision >= observed.revision) accept(value)
        state.notice = '已收到本次操作回执；设备排空、资源静止和实体停止仍以各项事实为准。'
      }
    } catch {
      if (alive && token === mutation) state.operationError = '操作回执未确认，不能假定已停止或已完成。请手动重试原操作；不会自动重放。'
    } finally { if (alive && token === mutation) { state.sending = false; emit() } }
  }
  async function confirm(kind: RecordingAttemptConfirmation, side?: RenderSide): Promise<void> {
    if (!state.confirmed || !canConfirm(kind, side)) return
    const snapshot = structuredClone(state.attempt!), base = { commandId: crypto.randomUUID(), attemptId: snapshot.id, expectedRevision: snapshot.revision, userConfirmed: true as const }
    const request: ConfirmRecordingAttemptRequest = kind === 'physical-stop' ? { ...base, kind, side: side! } : { ...base, kind }
    await send({ kind: 'confirm', request, snapshot })
  }
  async function beginSide(): Promise<void> {
    // 本方法没有认证开关；生产UI始终禁用，Core对每个显式执行请求重新准入。
    if (!alive || !state.confirmed || state.sending || state.pending || state.attempt?.status !== 'in-progress' || state.attempt.phase !== 'awaiting-side-b') return
    const snapshot = structuredClone(state.attempt)
    await send({ kind: 'beginSide', snapshot, request: { commandId: crypto.randomUUID(), attemptId: snapshot.id, expectedRevision: snapshot.revision, side: 'B', userConfirmed: true } })
  }
  async function stop(): Promise<void> {
    if (!canStop()) return
    if (state.pending?.kind === 'stop' && state.pending.snapshot.id === observed!.id) { await send(state.pending); return }
    const snapshot = structuredClone(observed!)
    await send({ kind: 'stop', snapshot, request: { commandId: crypto.randomUUID(), attemptId: snapshot.id } })
  }
  async function retry(): Promise<void> { if (canRetry()) await send(state.pending!) }
  function dispose(): void { alive = false; ++context; ++listRead; ++detailRead; ++mutation; state.attempt = undefined; observed = undefined; state.stopId = '' }
  return { state, setPlan, refresh, select, readSelected, canConfirm, setConfirmed, canRetry, canStop, confirm, beginSide, stop, retry, dispose }
}
