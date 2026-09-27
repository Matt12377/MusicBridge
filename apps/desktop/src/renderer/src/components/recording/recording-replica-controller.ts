import {
  executionFrameLimit,
  isRecordingReplicaInspection, isRecordingReplicaReadCancellation, isRecordingReplicaRun,
  isRecordingReplicaRunIdRequest, isRecordingReplicaStatus,
  type RecordingRecordDetail, type RecordingReplicaInspection, type RecordingReplicaPublicApi,
  type RecordingReplicaRun, type RecordingReplicaStatus, type ReplicaDeviceControlRequest, type ReplicaDeviceStartRequest,
  type ReplicaIssue, type ReplicaTargetView,
  type ReplicaTarget, type RenderSide,
} from '@music-bridge/contracts'

export const replicaIssueLabels: Record<ReplicaIssue, string> = {
  ARCHIVE_UNAVAILABLE: '历史归档不可用', ARCHIVE_CHANGED: '归档身份已变化', RESTORE_UNAVAILABLE: '恢复后的音频尚不可用',
  AUTHORIZATION_REVOKED: '本地读取授权已撤销', AUDIO_UNAVAILABLE: '历史音频缺失或不可读取', AUDIO_CHANGED: '历史音频内容已变化',
  UNSUPPORTED_FORMAT: '历史音频格式不受支持', IDENTITY_MISMATCH: '历史谱系身份不一致', DEPENDENCY_UNAVAILABLE: '历史依赖缺失', DURATION_LIMIT: '音频超过本次支持的时长上限',
}
export interface RecordingReplicaState {
  statusPhase: 'unread' | 'loading' | 'ready' | 'error'; status?: RecordingReplicaStatus; statusError: string;
  phase: 'unread' | 'checking' | 'ready' | 'error' | 'cancelling' | 'cancel-failed' | 'cancelled';
  inspection?: RecordingReplicaInspection; target: ReplicaTarget | ''; side: RenderSide | ''; error: string;
  cancelSending: boolean; closeRequested: boolean; runId: string | null; run?: RecordingReplicaRun;
  runSending: boolean; runReading: boolean; controlSending: boolean; runError: string;
}
interface Read { readId: string; settled: boolean; cancelled: boolean; accepted: boolean; sending: boolean; failed: boolean }
const runTerminal = (run: RecordingReplicaRun): boolean =>
  (run.state === 'finished' || run.state === 'cancelled' || run.state === 'failed') && run.cleanupQuiescent;

/** 只接受当前明确历史谱系；不读取当前Session，也不从名称或时间挑选音频。 */
function matches(inspection: RecordingReplicaInspection, detail: RecordingRecordDetail): boolean {
  const { record, plan } = detail
  if (inspection.recordingId !== record.id || inspection.recordingContentHash !== record.contentHash || inspection.planVersionId !== plan.id
    || inspection.planContentHash !== plan.contentHash || inspection.archiveOperationId !== plan.archive.operationId || inspection.archiveManifestHash !== plan.archive.manifestHash) return false
  const expected = plan.execution.recipes.map(r => ({ target: 'actual-execution', side: r.side, frames: executionFrameLimit(r) }))
  if (plan.prepared) expected.push(...plan.prepared.renderTimeline.sides.map(s => ({ target: 'original-render', side: s.name, frames: s.totalFrames })))
  if (inspection.targets.length !== expected.length) return false
  return inspection.targets.every((item, index) => {
    const basis = expected[index]!
    if (item.target !== basis.target || item.side !== basis.side || (item.state === 'empty') !== (basis.frames === 0)) return false
    if (item.state !== 'verified') return true
    const audio = item.audio
    if (audio.target === 'actual-execution') {
      const receipt = plan.execution.audio.find(r => r.recipe.side === item.side)
      return !!receipt && audio.executionAssetId === plan.execution.assetId && audio.recipeHash === receipt.recipeHash
        && audio.fileSha256 === receipt.audio.sha256 && audio.pcmSha256 === receipt.audio.pcmSha256 && audio.size === receipt.audio.size && audio.frameCount === receipt.audio.frameCount
        && audio.format.sampleRate === receipt.recipe.format.sampleRate && audio.format.channelCount === receipt.recipe.format.channelCount && audio.format.sampleFormat === receipt.recipe.format.outputSampleFormat
    }
    const raw = plan.prepared?.assets.find(a => a.side === item.side)
    return !!raw && audio.preparedVersionId === plan.prepared?.id && audio.renderAssetId === raw.id && audio.fileSha256 === raw.sha256 && audio.size === raw.size
      && audio.frameCount === raw.totalFrames && audio.format.sampleRate === raw.sampleRate && audio.format.channelCount === (raw.channelLayout === 'mono' ? 1 : 2)
  })
}

export function createRecordingReplicaController(options: { api: RecordingReplicaPublicApi; detail: RecordingRecordDetail; onChange?: () => void }) {
  const { api } = options, detail = structuredClone(options.detail)
  const state: RecordingReplicaState = { statusPhase: 'unread', statusError: '', phase: 'unread', target: '', side: '', error: '',
    cancelSending: false, closeRequested: false, runId: null, runSending: false, runReading: false, controlSending: false, runError: '' }
  let disposed = false, active: Read | undefined, statusGeneration = 0
  let pendingControl: ReplicaDeviceControlRequest | undefined
  let startedRequest: ReplicaDeviceStartRequest | undefined
  const changed = () => { if (!disposed) options.onChange?.() }
  const hasLiveRun = () => !!state.runId && (!state.run || !runTerminal(state.run))
  const canClose = () => !active && !hasLiveRun()
  function finish(read: Read): void {
    if (disposed || active !== read || !read.settled || read.cancelled && !read.accepted) return
    if (read.cancelled) state.phase = read.failed ? 'error' : 'cancelled'
    active = undefined; state.cancelSending = false; changed()
  }
  async function refreshStatus(): Promise<void> {
    if (disposed) return
    const generation = ++statusGeneration; state.statusPhase = 'loading'; state.status = undefined; state.statusError = ''; changed()
    try {
      const result = await api.getRecordingReplicaStatus()
      if (disposed || generation !== statusGeneration) return
      if (!isRecordingReplicaStatus(result)) throw new Error('INVALID_STATUS')
      state.status = result; state.statusPhase = 'ready'
    } catch { if (!disposed && generation === statusGeneration) { state.statusPhase = 'error'; state.statusError = '播放后端状态读取失败；未获得播放许可，请明确重试。' } }
    changed()
  }
  async function cancel(): Promise<void> {
    const read = active
    if (!read || read.sending || disposed) return
    read.cancelled = true; state.inspection = undefined; state.target = ''; state.side = ''
    if (read.accepted) { finish(read); return }
    read.sending = true; state.cancelSending = true; state.phase = 'cancelling'; changed()
    try {
      const result = await api.cancelRecordingReplicaRead(read.readId)
      if (disposed || active !== read) return
      if (!isRecordingReplicaReadCancellation(result) || result.readId !== read.readId) throw new Error('INVALID_CANCEL')
      read.accepted = true
      state.error = read.failed ? '历史音频核验失败；没有采用本次结果。请确认归档与读取授权后明确重试。' : ''
    } catch {
      if (!disposed && active === read) { state.phase = 'cancel-failed'; state.error = '取消请求尚未确认；本次结果不会采用，请重试取消核验。尚不能确认读取已收口。' }
    } finally {
      read.sending = false
      if (!disposed && active === read) { state.cancelSending = false; finish(read); changed() }
    }
  }
  async function inspect(): Promise<void> {
    if (disposed || active || state.closeRequested || hasLiveRun()) return
    const read: Read = { readId: crypto.randomUUID(), settled: false, cancelled: false, accepted: false, sending: false, failed: false }
    active = read; state.inspection = undefined; state.target = ''; state.side = ''; state.phase = 'checking'; state.error = ''; changed()
    try {
      const result = await api.inspectRecordingReplica({ readId: read.readId, recordingId: detail.record.id })
      if (disposed || active !== read || read.cancelled) return
      if (!isRecordingReplicaInspection(result) || result.readId !== read.readId || !matches(result, detail)) throw new Error('INVALID_INSPECTION')
      state.inspection = result; state.phase = 'ready'
    } catch {
      if (!disposed && active === read && !read.cancelled) { read.failed = true; state.error = '历史音频核验失败；没有采用本次结果。请确认归档与读取授权后明确重试。' }
    } finally {
      read.settled = true
      // IPC异常不证明Core已停止；先发送同一readId的取消，再放开重试。
      if (!disposed && active === read && read.failed && !read.cancelled) await cancel()
      finish(read); changed()
    }
  }
  function selectTarget(value: string): void {
    if (disposed || active || hasLiveRun()) return
    state.target = state.inspection?.targets.some(t => t.target === value) ? value as ReplicaTarget : ''; state.side = ''; changed()
  }
  function selectSide(value: string): void {
    if (disposed || active || hasLiveRun()) return
    state.side = state.inspection?.targets.some(t => t.target === state.target && t.side === value && t.state !== 'empty') ? value as RenderSide : ''; changed()
  }
  const selected = (): ReplicaTargetView | undefined => state.inspection?.targets.find(t => t.target === state.target && t.side === state.side)
  function acceptRun(value: unknown, runId: string): void {
    const request = startedRequest
    if (!isRecordingReplicaRun(value) || value.runId !== runId || !request) throw new Error('INVALID_RUN')
    if (value.kind === 'cancelled-before-start') {
      if (state.run?.kind === 'device-session' && state.run.started) throw new Error('INVALID_RUN')
      state.run = value; return
    }
    if (value.kind !== 'device-session' || JSON.stringify(value.request) !== JSON.stringify(request)) throw new Error('INVALID_RUN')
    if (value.identity) {
      const selectedAudio = state.inspection?.targets.find(item => item.target === request.target && item.side === request.side)
      if (selectedAudio?.state !== 'verified' || value.identity.fingerprint !== request.expectedFingerprint
        || JSON.stringify(value.identity.audio) !== JSON.stringify(selectedAudio.audio)) throw new Error('INVALID_RUN')
    }
    const previous = state.run
    if (previous && runTerminal(previous)) return
    if (previous?.kind === 'device-session' && (value.revision < previous.revision
      || value.controlRevision < previous.controlRevision || runTerminal(previous) && !runTerminal(value))) return
    state.run = value
  }
  async function getRun(runId = state.runId ?? ''): Promise<void> {
    if (disposed || runId !== state.runId || !isRecordingReplicaRunIdRequest({ runId }) || state.runReading) return
    state.runReading = true; changed()
    try {
      const value = (await api.getRecordingReplicaRun(runId)).run
      if (disposed || runId !== state.runId) return
      // null并不是启动或停止未受理证明；最后可信run和ID均须保留。
      if (value === null) throw new Error('RUN_UNKNOWN')
      acceptRun(value, runId); state.runError = ''
    } catch {
      if (!disposed && runId === state.runId) state.runError = '会话状态未确认；保留本次运行编号，请重试读取。'
    } finally { state.runReading = false; changed() }
  }
  async function sendStart(request: ReplicaDeviceStartRequest): Promise<void> {
    state.runSending = true; state.runError = ''; changed()
    try {
      const result = await api.startRecordingReplica(request)
      if (disposed || state.runId !== request.runId) return
      acceptRun(result, request.runId)
    } catch {
      if (!disposed && state.runId === request.runId) state.runError = '启动回执未确认；已保留精确运行编号，请读取状态并停止后再离开。'
    } finally {
      state.runSending = false; changed()
      if (!disposed && state.closeRequested && state.runId === request.runId) void stopRun(request.runId)
    }
  }
  async function start(): Promise<void> {
    if (disposed || active || state.closeRequested || state.runSending || hasLiveRun()) return
    const status = state.status, inspection = state.inspection, view = selected()
    if (status?.playback !== 'ready' || !inspection || !matches(inspection, detail) || view?.state !== 'verified'
      || view.target !== state.target || view.side !== state.side) {
      state.runError = '播放条件尚未满足：请核验历史音频、明确选择非空面及本机输出设备。'; changed(); return
    }
    const request: ReplicaDeviceStartRequest = { mode: 'device-output', runId: crypto.randomUUID(), recordingId: detail.record.id,
      target: view.target, side: view.side, expectedFingerprint: inspection.fingerprint,
      userConfirmed: true, outputSelection: status.outputSelection }
    startedRequest = request; pendingControl = undefined; state.runId = request.runId; state.run = undefined
    await sendStart(request)
  }
  async function retryStart(): Promise<void> {
    if (disposed || state.closeRequested || !startedRequest || state.runId !== startedRequest.runId
      || state.run || state.runSending) return
    await sendStart(startedRequest)
  }
  async function control(operation: 'pause' | 'resume' | 'stop' | 'seek', frame?: number): Promise<void> {
    if (disposed || state.closeRequested || !state.runId || !state.run || state.run.kind !== 'device-session'
      || state.controlSending || runTerminal(state.run)) return
    if (pendingControl && (pendingControl.operation !== operation || pendingControl.operation === 'seek' && pendingControl.frame !== frame)) {
      state.runError = '上一控制命令回执尚未确认；请先重试该命令。'; changed(); return
    }
    if (!pendingControl) {
      const base = { runId: state.runId, commandId: crypto.randomUUID(), expectedControlRevision: state.run.controlRevision }
      pendingControl = operation === 'seek' ? { ...base, operation, frame: frame! } : { ...base, operation }
    }
    const request = pendingControl
    state.controlSending = true; state.runError = ''; changed()
    try {
      const result = await api.controlRecordingReplica(request)
      if (disposed || state.runId !== request.runId) return
      acceptRun(result, request.runId); pendingControl = undefined
    } catch {
      if (!disposed && state.runId === request.runId) state.runError = '控制回执未确认；命令编号已保留，重试不会重复派发。'
    } finally { state.controlSending = false; changed() }
  }
  async function stopRun(runId = state.runId ?? ''): Promise<void> {
    if (disposed || runId !== state.runId || !isRecordingReplicaRunIdRequest({ runId })
      || state.run && runTerminal(state.run)) return
    state.controlSending = true; state.runError = ''; changed()
    try {
      const result = await api.stopRecordingReplica(runId)
      if (disposed || runId !== state.runId) return
      acceptRun(result, runId); pendingControl = undefined
    } catch {
      if (!disposed && runId === state.runId) state.runError = '精确 Stop 回执未确认；运行编号已保留，可按同一编号重试。'
    } finally { state.controlSending = false; changed() }
  }
  async function requestClose(): Promise<boolean> {
    if (disposed) return false
    state.closeRequested = true; changed()
    await Promise.allSettled([...(active ? [cancel()] : []), ...(state.runId && hasLiveRun() ? [stopRun(state.runId)] : [])])
    return canClose()
  }
  async function retryControl(): Promise<void> {
    if (pendingControl) await control(pendingControl.operation, pendingControl.operation === 'seek' ? pendingControl.frame : undefined)
  }
  function dispose(): boolean {
    if (disposed) return true
    if (!canClose()) { void requestClose(); return false }
    disposed = true; statusGeneration++
    return true
  }
  return { state, refreshStatus, inspect, cancel, selectTarget, selectSide, selected, requestClose, canClose, start, retryStart,
    getRun, stopRun, pause: () => control('pause'), resume: () => control('resume'), seek: (frame: number) => control('seek', frame),
    retryControl, dispose }
}
