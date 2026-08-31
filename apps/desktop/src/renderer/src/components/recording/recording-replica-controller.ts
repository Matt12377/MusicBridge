import {
  executionFrameLimit,
  isRecordingReplicaInspection, isRecordingReplicaReadCancellation, isRecordingReplicaRun,
  isRecordingReplicaRunIdRequest, isRecordingReplicaStatus,
  type RecordingRecordDetail, type RecordingReplicaInspection, type RecordingReplicaPublicApi,
  type RecordingReplicaRun, type RecordingReplicaStatus, type ReplicaIssue, type ReplicaTargetView,
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
  cancelSending: boolean; closeRequested: boolean; run?: RecordingReplicaRun; runError: string;
}
interface Read { readId: string; settled: boolean; cancelled: boolean; accepted: boolean; sending: boolean; failed: boolean }

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
  const state: RecordingReplicaState = { statusPhase: 'unread', statusError: '', phase: 'unread', target: '', side: '', error: '', cancelSending: false, closeRequested: false, runError: '' }
  let disposed = false, active: Read | undefined, statusGeneration = 0, runGeneration = 0
  const changed = () => { if (!disposed) options.onChange?.() }
  const canClose = () => !active
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
    if (disposed || active || state.closeRequested) return
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
    if (disposed || active) return
    state.target = state.inspection?.targets.some(t => t.target === value) ? value as ReplicaTarget : ''; state.side = ''; changed()
  }
  function selectSide(value: string): void {
    if (disposed || active) return
    state.side = state.inspection?.targets.some(t => t.target === state.target && t.side === value && t.state !== 'empty') ? value as RenderSide : ''; changed()
  }
  const selected = (): ReplicaTargetView | undefined => state.inspection?.targets.find(t => t.target === state.target && t.side === state.side)
  async function requestClose(): Promise<boolean> { state.closeRequested = true; changed(); if (active) await cancel(); return canClose() }
  // 当前合同没有可播放后端分支；保留显式会话操作面，不把合成检查升级成播放授权。
  async function start(): Promise<void> { if (!disposed) { state.runError = '播放后端不可用；未发起播放。'; changed() } }
  function acceptRun(value: unknown, runId: string): value is RecordingReplicaRun {
    if (!isRecordingReplicaRun(value) || value.runId !== runId) return false
    if (value.kind === 'session') {
      if (value.request.recordingId !== detail.record.id) return false
      if (value.identity && (!state.inspection || value.identity.fingerprint !== state.inspection.fingerprint || !matches({ ...state.inspection, ...value.identity }, detail))) return false
    }
    return state.run?.runId !== runId || state.run.kind !== 'session' || value.kind === 'session' && value.revision >= state.run.revision
  }
  async function sessionRead(runId: string, stop: boolean): Promise<void> {
    if (disposed || !isRecordingReplicaRunIdRequest({ runId })) return
    const generation = ++runGeneration; state.runError = ''
    try {
      const value = stop ? await api.stopRecordingReplica(runId) : (await api.getRecordingReplicaRun(runId)).run
      if (disposed || generation !== runGeneration) return
      if (value === null && !stop) state.run = undefined
      else if (acceptRun(value, runId)) state.run = value
      else throw new Error('INVALID_RUN')
    } catch { if (!disposed && generation === runGeneration) state.runError = '会话状态未确认；不会推断播放或停止已完成。' }
    changed()
  }
  function dispose(): void {
    if (disposed) return
    const read = active; disposed = true; statusGeneration++; runGeneration++
    if (read && !read.accepted && !read.sending) { read.cancelled = true; void api.cancelRecordingReplicaRead(read.readId).catch(() => undefined) }
  }
  return { state, refreshStatus, inspect, cancel, selectTarget, selectSide, selected, requestClose, canClose, start,
    getRun: (runId: string) => sessionRead(runId, false), stopRun: (runId: string) => sessionRead(runId, true), dispose }
}
