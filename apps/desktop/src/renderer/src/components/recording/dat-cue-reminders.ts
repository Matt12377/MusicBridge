import type { ConvertedExecutionReceipt, ExecutionAssetAudio, RecordingAttempt, RecordingPlanVersion } from '@music-bridge/contracts'

export type DatCueBasis = 'planned-only' | 'execution-receipt' | 'converted-receipt' | 'render-marker' | 'render-marker-derived'
export interface DatCueReminder { trackId: string; title: string; startFrame: number; referenceMs: number }
export interface DatCueState {
  cues: readonly DatCueReminder[]; basis: DatCueBasis; activeIndex: number | null; observedFrames: number | null
  positionIssue: 'audio-receipt-missing' | 'cue-position-mismatch' | null
}

const safeFrame = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
const safeRate = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const milliseconds = (frame: number, rate: number): number =>
  Number((BigInt(frame) * 1000n + BigInt(rate) / 2n) / BigInt(rate))
const convertedReceipt = (value: ExecutionAssetAudio): value is ConvertedExecutionReceipt => value.recipe.schemaVersion === 2

/** Cue 是只读人工提示；只有实际音频回执与正式 Attempt 身份吻合，才高亮当前段。 */
export function datCueState(plan: RecordingPlanVersion, attempt?: RecordingAttempt): DatCueState | null {
  const timeline = plan.layout.timeline
  const side = timeline.sides[0]
  if (plan.layout.spec.format !== 'dat' || plan.layout.spec.cueReminders !== true
    || timeline.sides.length !== 1 || side?.name !== 'Program'
    || plan.layout.masterVersionId !== plan.master.id || !safeRate(timeline.sampleRate)
    || side.tracks.some(track => !safeFrame(track.startFrame))) return null

  const program = attempt?.sides.find(item => item.side === 'Program')
  const matchingAttempt = attempt?.kind === 'formal' && attempt.planVersionId === plan.id
    && attempt.planContentHash === plan.contentHash && attempt.draftId === plan.draftId
    && attempt.physicalId === plan.physicalCopy.physicalId
    && attempt.executionAssetId === plan.execution.assetId && program
    && safeFrame(program.consumedFrames)
  const observedFrames = matchingAttempt ? program.consumedFrames : null
  const receipt = plan.execution.audio.find(item => item.recipe.side === 'Program')
  const receiptMatchesAttempt = Boolean(matchingAttempt && receipt
    && receipt.recipeHash === program.recipeHash && receipt.audio.sha256 === program.audioSha256
    && receipt.audio.pcmSha256 === program.pcmSha256
    && receipt.audio.frameCount === program.frameCount)
  const recipe = plan.execution.recipes.find(item => item.side === 'Program')
  let starts = side.tracks.map(track => track.startFrame)
  let rate = timeline.sampleRate
  let basis: DatCueBasis = 'planned-only'
  let canFollowAttempt = false
  let positionIssue: DatCueState['positionIssue'] = matchingAttempt && !receiptMatchesAttempt ? 'audio-receipt-missing' : null

  if (recipe && receipt && receipt.recipe.schemaVersion === 1 && receipt.recipe.mode === 'direct'
    && recipe.schemaVersion === 1 && recipe.mode === 'direct' && plan.execution.mode === 'direct'
    && safeRate(receipt.recipe.format.sampleRate)) {
    const sourceSegments = receipt.recipe.segments.filter(segment => segment.kind === 'source')
    if (sourceSegments.length === side.tracks.length && sourceSegments.every((segment, index) =>
      segment.trackId === side.tracks[index]?.trackId && safeFrame(segment.startFrame))) {
      starts = sourceSegments.map(segment => segment.startFrame)
      rate = receipt.recipe.format.sampleRate
      basis = 'execution-receipt'
      canFollowAttempt = receiptMatchesAttempt
    } else positionIssue = 'cue-position-mismatch'
  } else if (recipe && receipt && convertedReceipt(receipt) && receipt.recipe.mode === 'direct'
    && recipe.schemaVersion === 2 && recipe.mode === 'direct' && plan.execution.mode === 'direct-converted'
    && receipt.segments.length === receipt.recipe.segments.length && safeRate(receipt.recipe.format.sampleRate)) {
    const sourceStarts = receipt.recipe.segments.flatMap((segment, index) => segment.kind === 'source'
      ? [{ trackId: segment.trackId, startFrame: receipt.segments[index]?.startFrame }] : [])
    if (sourceStarts.length === side.tracks.length && sourceStarts.every((segment, index) =>
      segment.trackId === side.tracks[index]?.trackId && segment.startFrame !== undefined && safeFrame(segment.startFrame))) {
      starts = sourceStarts.map(segment => segment.startFrame!)
      rate = receipt.recipe.format.sampleRate
      basis = 'converted-receipt'
      canFollowAttempt = receiptMatchesAttempt
    } else positionIssue = 'cue-position-mismatch'
  } else if (plan.prepared && (plan.execution.mode === 'prepared-reference' || plan.execution.mode === 'prepared-derivative')) {
    const render = plan.prepared.renderTimeline.sides.find(item => item.name === 'Program')
    const samePrepared = recipe?.prepared?.id === plan.prepared.id
      && recipe.prepared.renderTimelineHash === plan.prepared.renderTimelineHash
    if (samePrepared && render && safeRate(render.sampleRate) && render.markers.length === side.tracks.length
      && render.markers.every((marker, index) => marker.trackId === side.tracks[index]?.trackId
        && marker.userConfirmed && marker.confirmationMethod === 'manual' && safeFrame(marker.actualStartFrame))) {
      starts = render.markers.map(marker => marker.actualStartFrame)
      rate = render.sampleRate
      basis = plan.execution.mode === 'prepared-reference' ? 'render-marker' : 'render-marker-derived'
      // 派生 Render 的采样率转换可能改变 Marker 在输出中的精确帧位；不可按比例伪造实时位置。
      canFollowAttempt = receiptMatchesAttempt && basis === 'render-marker' && receipt?.recipe.schemaVersion === 1
        && receipt.recipe.mode === 'prepared-reference' && receipt.recipe.format.sampleRate === render.sampleRate
        && receipt.recipe.prepared?.id === plan.prepared.id
        && receipt.recipe.prepared.renderTimelineHash === plan.prepared.renderTimelineHash
      if (basis === 'render-marker' && matchingAttempt && !canFollowAttempt && receiptMatchesAttempt) positionIssue = 'cue-position-mismatch'
    } else positionIssue = 'cue-position-mismatch'
  }

  const cues = side.tracks.map((track, index) => ({ trackId: track.trackId,
    title: plan.master.content.tracks.find(item => item.trackId === track.trackId)?.metadata.title ?? '曲目',
    startFrame: starts[index]!, referenceMs: milliseconds(starts[index]!, rate) }))
  let activeIndex: number | null = null
  if (canFollowAttempt && observedFrames !== null && attempt?.status === 'in-progress'
    && attempt.activeSide === 'Program' && (program?.phase === 'outputting' || program?.phase === 'draining')) {
    for (const [index, start] of starts.entries()) if (observedFrames >= start) activeIndex = index
  }
  if (matchingAttempt && basis === 'planned-only' && receiptMatchesAttempt && positionIssue === null) positionIssue = 'cue-position-mismatch'
  return { cues, basis, activeIndex, observedFrames, positionIssue }
}
