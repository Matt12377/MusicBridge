import {
  isCollectionId, isRecordingOutputCheckResult, isRecordingOutputStatus,
  type RecordingOutputCheckRequest, type RecordingOutputCheckResult, type RecordingOutputPublicApi,
  type RecordingOutputStatus, type RecordingPlanVersion, type RenderSide,
} from '@music-bridge/contracts'

export interface RecordingOutputState {
  plan?: RecordingPlanVersion
  side: RenderSide | ''
  statusPhase: 'unread' | 'loading' | 'ready' | 'error'
  status?: RecordingOutputStatus
  statusError: string
  phase: 'unchecked' | 'checking' | 'cancelling' | 'cancel-failed' | 'cancelled' | 'verified' | 'error'
  result?: RecordingOutputCheckResult
  error: string
  cancelSending: boolean
}
const hash = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/u.test(value)
interface Run { request: RecordingOutputCheckRequest; cancelled: boolean; cancelInFlight: boolean }

export function createRecordingOutputController(options: { api: RecordingOutputPublicApi; onChange?: () => void }) {
  const { api } = options
  const state: RecordingOutputState = { side: '', statusPhase: 'unread', statusError: '', phase: 'unchecked', error: '', cancelSending: false }
  let alive = true, generation = 0, statusGeneration = 0, active: Run | undefined
  const emit = () => { if (alive) options.onChange?.() }
  function sides(): RenderSide[] {
    const plan = state.plan
    if (!plan || plan.status !== 'frozen' || plan.formalReady !== false || !isCollectionId(plan.id) || !hash(plan.contentHash) || !Array.isArray(plan.execution?.audio)) return []
    return (['A', 'B', 'Program'] as const).filter(side => {
      const matches = plan.execution.audio.filter(receipt => receipt.recipe?.side === side)
      return matches.length === 1 && Number.isSafeInteger(matches[0]!.audio?.frameCount) && matches[0]!.audio.frameCount > 0 && hash(matches[0]!.audio.pcmSha256)
    })
  }
  const canCheck = () => alive && !active && state.statusPhase === 'ready' && state.status?.syntheticCheck.available === true && !!state.side && sides().includes(state.side)
  async function refreshStatus(): Promise<void> {
    if (!alive || active) return
    const token = ++statusGeneration
    state.result = undefined; state.phase = 'unchecked'; state.error = ''
    state.statusPhase = 'loading'; state.status = undefined; state.statusError = ''; emit()
    try {
      const value = await api.getRecordingOutputStatus()
      if (!alive || token !== statusGeneration) return
      if (!isRecordingOutputStatus(value)) throw new Error('无设备检查状态无效')
      state.status = structuredClone(value); state.statusPhase = 'ready'
    } catch {
      if (alive && token === statusGeneration) { state.statusPhase = 'error'; state.statusError = '无法读取无设备检查能力，请重试读取；不能视为检查通过。' }
    } finally { if (alive && token === statusGeneration) emit() }
  }
  function invalidate(): void {
    ++generation; state.result = undefined; state.error = ''
    if (active) void cancel()
    else state.phase = 'unchecked'
  }
  function setPlan(plan?: RecordingPlanVersion): void {
    if (!alive) return
    state.plan = plan ? structuredClone(plan) : undefined; state.side = ''; invalidate(); emit()
  }
  function selectSide(side: string): void {
    if (!alive) return
    const next = sides().find(item => item === side) ?? ''
    if (next === state.side) return
    state.side = next; invalidate(); emit()
  }
  async function check(): Promise<void> {
    if (!canCheck()) return
    const plan = state.plan!, side = state.side as RenderSide, token = generation
    const audio = plan.execution.audio.find(receipt => receipt.recipe.side === side)!.audio
    const helperSha256 = state.status!.syntheticCheck.helperSha256
    const run: Run = { request: { runId: crypto.randomUUID(), planVersionId: plan.id, side }, cancelled: false, cancelInFlight: false }
    active = run; state.result = undefined; state.error = ''; state.phase = 'checking'; emit()
    try {
      const value = await api.checkRecordingOutput(structuredClone(run.request))
      if (!alive || active !== run || token !== generation || run.cancelled) return
      if (!isRecordingOutputCheckResult(value) || value.runId !== run.request.runId || value.planVersionId !== plan.id || value.planContentHash !== plan.contentHash || value.side !== side
        || value.frameCount !== audio.frameCount || value.pcmSha256 !== audio.pcmSha256 || value.helperSha256 !== helperSha256) throw new Error('无设备检查回执不匹配')
      state.result = structuredClone(value); state.phase = 'verified'
    } catch {
      if (alive && active === run && token === generation && !run.cancelled) {
        state.phase = 'error'; state.error = '本次无设备检查未通过或回执未确认。请核对计划、文件和检查能力后重试；没有播放音频。'
      }
    } finally {
      if (active === run) {
        active = undefined
        if (alive) { state.cancelSending = false; if (run.cancelled) state.phase = 'cancelled'; emit() }
      }
    }
  }
  async function cancel(): Promise<void> {
    if (!alive || !active || active.cancelInFlight) return
    const run = active
    run.cancelled = true; run.cancelInFlight = true
    state.result = undefined; state.phase = 'cancelling'; state.cancelSending = true; state.error = ''; emit()
    try {
      const value = await api.cancelRecordingOutputCheck(run.request.runId)
      if (!value || value.cancelled !== true || Object.keys(value).length !== 1) throw new Error('取消请求回执无效')
      // cancelled只确认请求已接收，仍由原check的settle解除单运行限制。
    } catch {
      if (alive && active === run) { state.phase = 'cancel-failed'; state.error = '取消请求未确认，请重试取消；当前检查仍可能在运行。' }
    } finally {
      run.cancelInFlight = false
      if (alive && active === run) { state.cancelSending = false; emit() }
    }
  }
  function dispose(): void {
    if (!alive) return
    if (active && !active.cancelInFlight) void cancel()
    alive = false; ++generation; ++statusGeneration; state.result = undefined
  }
  return { state, sides, canCheck, refreshStatus, setPlan, selectSide, check, cancel, dispose }
}
