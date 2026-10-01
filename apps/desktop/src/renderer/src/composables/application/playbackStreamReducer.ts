import type { PlaybackSnapshot, PlaybackStreamSnapshot, PlaybackStreamStamp, PlaybackStateProjection, PlaybackQueueSnapshot } from '@music-bridge/contracts'

export type PlaybackStreamDelta =
  | { kind: 'state'; stamp: PlaybackStreamStamp; state: PlaybackStateProjection; queue?: PlaybackQueueSnapshot }
  | { kind: 'progress'; stamp: PlaybackStreamStamp; positionMs: number }
export interface PlaybackStreamApplication { kind: 'full' | 'progress'; snapshot: PlaybackSnapshot; stamp: PlaybackStreamStamp }
const STAGE_LIMIT = 8 * 1024 * 1024
function sameOwner(a: PlaybackStreamStamp, b: PlaybackStreamStamp): boolean {
  return a.generation === b.generation && a.selectedZoneId === b.selectedZoneId
    && a.trackId === b.trackId && a.source === b.source
}
function identityMatches(s: PlaybackStreamStamp, value: PlaybackStateProjection): boolean {
  return s.selectedZoneId === (value.selectedZoneId ?? null)
    && s.trackId === (value.currentTrack?.id ?? null) && s.source === (value.source ?? null)
}

/** 只管理权威播放基准；暂存两条payload，连续覆盖证据保持常量空间。 */
export function createPlaybackStreamReducer() {
  let instance: string | undefined
  let snapshot: PlaybackSnapshot | null = null
  let stamp: PlaybackStreamStamp | undefined
  let desynced = true, seeding = false
  let stageInstance: string | undefined
  let state: Extract<PlaybackStreamDelta, { kind: 'state' }> | undefined
  let progress: Extract<PlaybackStreamDelta, { kind: 'progress' }> | undefined
  let start = 0, highwater = 0, blockedThrough = 0, stateBytes = 0
  function clearStage(): void { state = undefined; progress = undefined; stageInstance = undefined; start = highwater = blockedThrough = stateBytes = 0 }
  function authorize(id: string, bootstrap = false): void {
    if (id === instance) return
    const preserve = bootstrap && instance === undefined && stageInstance === id
    instance = id; stamp = undefined; snapshot = null; desynced = true
    if (!preserve) { seeding = false; clearStage() }
  }
  function full(envelope: PlaybackStreamSnapshot): PlaybackStreamApplication | undefined {
    const next = envelope.stamp
    if (next.coreInstanceId !== instance || (stamp && next.sequence <= stamp.sequence)) return
    if (!identityMatches(next, envelope.snapshot) || (stamp && (next.generation < stamp.generation || next.queueRevision < stamp.queueRevision))) {
      desynced = true; return
    }
    snapshot = envelope.snapshot; stamp = next; desynced = false
    return { kind: 'full', snapshot, stamp }
  }
  function apply(delta: PlaybackStreamDelta, covered = false): PlaybackStreamApplication | undefined {
    const next = delta.stamp
    if (next.coreInstanceId !== instance || (stamp && next.sequence <= stamp.sequence)) return
    if (!stamp || !snapshot || desynced || (!covered && next.sequence !== stamp.sequence + 1)
      || next.generation < stamp.generation || next.queueRevision < stamp.queueRevision) { desynced = true; return }
    if (delta.kind === 'progress') {
      if (!sameOwner(next, stamp) || next.queueRevision !== stamp.queueRevision) { desynced = true; return }
      // 不触碰queue.items；同位置仅推进协议序号，UI引用也不变。
      if (snapshot.positionMs !== delta.positionMs) snapshot = { ...snapshot, positionMs: delta.positionMs }
      stamp = next
      return { kind: 'progress', snapshot, stamp }
    }
    if (!identityMatches(next, delta.state) || (!delta.queue && next.queueRevision !== stamp.queueRevision)) { desynced = true; return }
    snapshot = { ...delta.state, queue: delta.queue ?? snapshot.queue }
    stamp = next
    return { kind: 'full', snapshot, stamp }
  }
  function stage(delta: PlaybackStreamDelta): void {
    const next = delta.stamp
    if (instance !== undefined && next.coreInstanceId !== instance) return
    if (stageInstance !== undefined && next.coreInstanceId !== stageInstance) return
    if (next.sequence <= Math.max(stamp?.sequence ?? 0, highwater)) return
    stageInstance = next.coreInstanceId
    if (!start) start = next.sequence
    const previousSequence = highwater || stamp?.sequence || 0
    if (previousSequence && next.sequence !== previousSequence + 1) blockedThrough = Math.max(blockedThrough, next.sequence - 1)
    highwater = next.sequence
    if (delta.kind === 'state') {
      if (state && ((state.queue && !delta.queue) || !sameOwner(state.stamp, next))) blockedThrough = Math.max(blockedThrough, state.stamp.sequence)
      state = delta; progress = undefined
      // 只在低频state估算暂存字节；full/UI本身不受此预算限制。
      stateBytes = new TextEncoder().encode(JSON.stringify(delta)).byteLength
      if (stateBytes > STAGE_LIMIT) { state = undefined; progress = undefined; stateBytes = 0; blockedThrough = highwater }
    } else {
      const previousOwner = progress?.stamp ?? state?.stamp ?? stamp
      if (previousOwner && (!sameOwner(previousOwner, next) || previousOwner.queueRevision !== next.queueRevision)) blockedThrough = Math.max(blockedThrough, highwater)
      progress = delta
      if (stateBytes + new TextEncoder().encode(JSON.stringify(delta)).byteLength > STAGE_LIMIT) {
        state = undefined; progress = undefined; stateBytes = 0; blockedThrough = highwater
      }
    }
  }
  function delta(value: PlaybackStreamDelta): PlaybackStreamApplication | undefined {
    if (seeding) { stage(value); return }
    return apply(value)
  }
  function beginSeed(): void { seeding = true; clearStage() }
  function endSeed(envelope: PlaybackStreamSnapshot): PlaybackStreamApplication | undefined {
    if (envelope.stamp.coreInstanceId !== instance) { desynced = true; seeding = false; clearStage(); return }
    // 更晚full事件已经建基准时，旧只读回复不能把它回退或重新置失步。
    if (stamp && envelope.stamp.sequence < stamp.sequence) { seeding = false; clearStage(); return }
    let result = full(envelope)
    if (stamp && stamp.sequence === envelope.stamp.sequence && identityMatches(stamp, envelope.snapshot)) desynced = false
    if (!stamp || desynced) { seeding = false; clearStage(); return result }
    const baseSequence = stamp.sequence
    if (blockedThrough > baseSequence || (highwater > baseSequence && start > baseSequence + 1)) desynced = true
    else {
      if (state && state.stamp.sequence > baseSequence) result = apply(state, true) ?? result
      if (!desynced && progress && progress.stamp.sequence > (stamp?.sequence ?? 0)) {
        const hadFull = result?.kind === 'full'
        const applied = apply(progress, true)
        if (applied) result = hadFull ? { ...applied, kind: 'full' } : applied
      }
      if (highwater > (stamp?.sequence ?? 0)) desynced = true
    }
    seeding = false; clearStage()
    return result
  }
  function acceptFull(envelope: PlaybackStreamSnapshot): PlaybackStreamApplication | undefined {
    const result = full(envelope)
    if (result) { seeding = false; clearStage() }
    return result
  }
  return { authorize, full: acceptFull, delta, beginSeed, endSeed,
    failSeed: () => { seeding = false; clearStage(); desynced = true },
    markDesynced: () => { desynced = true },
    suspend: () => { instance = undefined; stamp = undefined; snapshot = null; desynced = true; seeding = false; clearStage() },
    get snapshot() { return snapshot }, get stamp() { return stamp }, get instance() { return instance }, get desynced() { return desynced },
  }
}
