import assert from 'node:assert/strict'
import test from 'node:test'
import type { RecordingAttempt, RecordingPlanVersion } from '@music-bridge/contracts'
import { datCueState } from '../src/renderer/src/components/recording/dat-cue-reminders.js'

const directRecipe = { schemaVersion: 1, mode: 'direct', side: 'Program', format: { sampleRate: 96000 }, segments: [
  { kind: 'source', trackId: 'one', startFrame: 0, endFrame: 96000 },
  { kind: 'source', trackId: 'two', startFrame: 96000, endFrame: 192000 },
] }
const directAudio = { recipe: directRecipe, recipeHash: 'c'.repeat(64), audio: { sha256: 'd'.repeat(64), pcmSha256: 'e'.repeat(64), frameCount: 192000 } }
const plan = {
  id: 'plan-exact', draftId: 'draft-exact', contentHash: 'a'.repeat(64),
  physicalCopy: { physicalId: 'MB-D-00001' },
  master: { id: 'master-exact', content: { tracks: [
    { trackId: 'one', metadata: { title: '开场' } }, { trackId: 'two', metadata: { title: '第二首' } },
  ] } },
  layout: { masterVersionId: 'master-exact', spec: { format: 'dat', cueReminders: true }, timeline: {
    sampleRate: 48000, sides: [{ name: 'Program', tracks: [{ trackId: 'one', startFrame: 4800 }, { trackId: 'two', startFrame: 52800 }] }],
  } },
  execution: { assetId: 'asset-exact', mode: 'direct', recipes: [directRecipe], audio: [directAudio] },
} as unknown as RecordingPlanVersion
const attempt = { kind: 'formal', physicalId: 'MB-D-00001', planVersionId: plan.id, planContentHash: plan.contentHash,
  draftId: plan.draftId, executionAssetId: plan.execution.assetId, status: 'in-progress', activeSide: 'Program',
  sides: [{ side: 'Program', phase: 'outputting', frameCount: 192000, recipeHash: directAudio.recipeHash,
    audioSha256: directAudio.audio.sha256, pcmSha256: directAudio.audio.pcmSha256, consumedFrames: 96000 }],
} as unknown as RecordingAttempt

test('Direct DAT Cue 使用与 Attempt 音频身份匹配的执行 source 段起点', () => {
  const initial = datCueState(plan)
  assert.deepEqual(initial?.cues.map(cue => cue.referenceMs), [0, 1000])
  assert.equal(initial?.basis, 'execution-receipt')
  assert.equal(initial?.activeIndex, null)
  assert.equal(initial?.observedFrames, null)
  const live = datCueState(plan, attempt)
  assert.deepEqual(live?.cues.map(cue => cue.referenceMs), [0, 1000])
  assert.equal(live?.basis, 'execution-receipt')
  assert.equal(live?.activeIndex, 1)
  assert.equal(live?.observedFrames, 96000)
  assert.equal(datCueState(plan, { ...attempt, planVersionId: 'other-plan' })?.activeIndex, null)
  assert.equal(datCueState(plan, { ...attempt, planContentHash: 'b'.repeat(64) })?.activeIndex, null)
  assert.equal(datCueState(plan, { ...attempt, physicalId: 'MB-D-00002' })?.activeIndex, null)
  assert.equal(datCueState(plan, { ...attempt, physicalId: 'MB-D-00002' })?.observedFrames, null)
  assert.equal(datCueState(plan, { ...attempt, executionAssetId: 'other-asset' })?.activeIndex, null)
  assert.equal(datCueState(plan, { ...attempt, sides: [{ ...attempt.sides[0]!, audioSha256: 'e'.repeat(64) }] })?.activeIndex, null)
  assert.equal(datCueState(plan, { ...attempt, sides: [{ ...attempt.sides[0]!, audioSha256: 'e'.repeat(64) }] })?.positionIssue, 'audio-receipt-missing')
  assert.equal(datCueState(plan, { ...attempt, sides: [{ ...attempt.sides[0]!, pcmSha256: 'f'.repeat(64) }] })?.activeIndex, null)
  assert.equal(datCueState(plan, { ...attempt, sides: [{ ...attempt.sides[0]!, pcmSha256: 'f'.repeat(64) }] })?.positionIssue, 'audio-receipt-missing')
  assert.equal(datCueState(plan, { ...attempt, sides: [{ ...attempt.sides[0]!, consumedFrames: 95999 }] })?.activeIndex, 0)
  assert.equal(datCueState(plan, { ...attempt, status: 'completed' })?.activeIndex, null)
  assert.equal(datCueState(plan, { ...attempt, sides: [{ ...attempt.sides[0]!, phase: 'complete' }] })?.activeIndex, null)
  const noReceipt = { ...plan, execution: { ...plan.execution, audio: [] } }
  assert.equal(datCueState(noReceipt, attempt)?.basis, 'planned-only')
  assert.equal(datCueState(noReceipt, attempt)?.positionIssue, 'audio-receipt-missing')
})

test('Direct-converted DAT Cue 使用转换回执逐段起点，而非按 Layout 比例推测', () => {
  const recipe = { schemaVersion: 2, mode: 'direct', side: 'Program', format: { sampleRate: 96000 }, segments: [
    { kind: 'silence', reason: 'lead-in', frames: 9600 }, { kind: 'source', trackId: 'one' },
    { kind: 'silence', reason: 'gap', frames: 4800 }, { kind: 'source', trackId: 'two' },
  ] }
  const audio = { recipe, recipeHash: 'f'.repeat(64), audio: { sha256: '1'.repeat(64), pcmSha256: '2'.repeat(64), frameCount: 200000 },
    segments: [{ startFrame: 0, endFrame: 9600 }, { startFrame: 9600, endFrame: 105600 },
      { startFrame: 105600, endFrame: 110400 }, { startFrame: 110400, endFrame: 200000 }] }
  const converted = { ...plan, execution: { ...plan.execution, mode: 'direct-converted' as const, recipes: [recipe], audio: [audio] } } as unknown as RecordingPlanVersion
  const running = { ...attempt, sides: [{ ...attempt.sides[0]!, recipeHash: audio.recipeHash,
    audioSha256: audio.audio.sha256, pcmSha256: audio.audio.pcmSha256, frameCount: audio.audio.frameCount, consumedFrames: 107000 }] }
  assert.deepEqual(datCueState(converted, running)?.cues.map(cue => cue.referenceMs), [100, 1150])
  assert.equal(datCueState(converted, running)?.basis, 'converted-receipt')
  assert.deepEqual(datCueState(converted)?.cues.map(cue => cue.referenceMs), [100, 1150])
  assert.equal(datCueState(converted)?.activeIndex, null)
  assert.equal(datCueState(converted, running)?.activeIndex, 0)
  assert.equal(datCueState(converted, { ...running, sides: [{ ...running.sides[0]!, consumedFrames: 110400 }] })?.activeIndex, 1)
})

test('Prepared ACCEPTED_VARIANCE 使用冻结 Render Marker；派生转换不动态高亮', () => {
  const prepared = { id: 'prepared-exact', renderTimelineHash: '2'.repeat(64), renderTimeline: { sides: [{ name: 'Program',
    sampleRate: 48000, markers: [{ trackId: 'one', actualStartFrame: 0, userConfirmed: true, confirmationMethod: 'manual' },
      { trackId: 'two', actualStartFrame: 60000, userConfirmed: true, confirmationMethod: 'manual' }] }] },
    conformance: { status: 'ACCEPTED_VARIANCE' } }
  const recipe = { schemaVersion: 1, mode: 'prepared-reference', side: 'Program', format: { sampleRate: 48000 },
    prepared: { id: prepared.id, renderTimelineHash: prepared.renderTimelineHash } }
  const audio = { recipe, recipeHash: '3'.repeat(64), audio: { sha256: '4'.repeat(64), pcmSha256: '5'.repeat(64), frameCount: 120000 } }
  const reference = { ...plan, prepared, execution: { ...plan.execution, mode: 'prepared-reference' as const,
    recipes: [recipe], audio: [audio] } } as unknown as RecordingPlanVersion
  const running = { ...attempt, sides: [{ ...attempt.sides[0]!, frameCount: 120000, recipeHash: audio.recipeHash,
    audioSha256: audio.audio.sha256, pcmSha256: audio.audio.pcmSha256, consumedFrames: 55000 }] }
  assert.deepEqual(datCueState(reference, running)?.cues.map(cue => cue.referenceMs), [0, 1250])
  assert.equal(datCueState(reference, running)?.basis, 'render-marker')
  assert.equal(datCueState(reference, running)?.activeIndex, 0)
  assert.equal(datCueState(reference, { ...running, sides: [{ ...running.sides[0]!, consumedFrames: 60000 }] })?.activeIndex, 1)

  const derivativeRecipe = { schemaVersion: 2, mode: 'prepared-derivative', side: 'Program', format: { sampleRate: 96000 },
    prepared: recipe.prepared }
  const derivative = { ...reference, execution: { ...reference.execution, mode: 'prepared-derivative' as const,
    recipes: [derivativeRecipe], audio: [] } } as unknown as RecordingPlanVersion
  assert.equal(datCueState(derivative, running)?.basis, 'render-marker-derived')
  assert.deepEqual(datCueState(derivative, running)?.cues.map(cue => cue.referenceMs), [0, 1250])
  assert.equal(datCueState(derivative, running)?.activeIndex, null)
})

test('没有人工 Cue 选择或不是 DAT Program，不渲染提示', () => {
  assert.equal(datCueState({ ...plan, layout: { ...plan.layout, spec: { ...plan.layout.spec, cueReminders: undefined } } }), null)
  assert.equal(datCueState({ ...plan, layout: { ...plan.layout, spec: { ...plan.layout.spec, format: 'cassette' } } }), null)
})
