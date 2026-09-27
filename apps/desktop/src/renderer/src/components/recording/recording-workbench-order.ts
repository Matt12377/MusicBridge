import type { MediaLayoutSpec, MediaTrackRule } from '@music-bridge/contracts'

export interface WorkbenchOrder {
  trackIds: string[]
  splitAfter: number
}

export type WorkbenchMove = { direction: -1 | 1 } | { side: 'A' | 'B' }
export type WorkbenchMoveResult = { ok: true; order: WorkbenchOrder } | { ok: false; reason: string }

/** 删除曲目只整理当前未保存的分面草稿；已存规划和冻结历史不回写。 */
export function pruneRulesAfterTrackRemoval(trackIds: readonly string[], rules: readonly MediaTrackRule[], removedTrackId: string): MediaTrackRule[] {
  const index = trackIds.indexOf(removedTrackId)
  if (index < 0) return [...rules]
  const previousTrackId = trackIds[index - 1]
  return rules.filter(rule => rule.trackId !== removedTrackId).map(rule => {
    if (rule.trackId !== previousTrackId || !rule.keepWithNext) return rule
    const { keepWithNext: _removed, ...rest } = rule
    return rest
  })
}

/** 分面边界只可落在连播组之间；整组排序不能悄悄拆开 Keep With Next。 */
export function moveWorkbenchGroup(order: WorkbenchOrder, spec: MediaLayoutSpec, trackId: string, move: WorkbenchMove): WorkbenchMoveResult {
  const invalid = (reason: string): WorkbenchMoveResult => ({ ok: false, reason })
  const cassette = spec.format === 'cassette'
  if (cassette && (order.splitAfter < 1 || order.splitAfter > order.trackIds.length)) return invalid('A 面至少需要一首曲目。')
  const keep = new Set(spec.rules.filter(rule => rule.keepWithNext).map(rule => rule.trackId))
  const groups: string[][] = []
  for (const id of order.trackIds) {
    if (groups.length && keep.has(groups[groups.length - 1]!.at(-1)!)) groups.at(-1)!.push(id)
    else groups.push([id])
  }
  const groupIndex = groups.findIndex(group => group.includes(trackId))
  if (groupIndex < 0) return invalid('曲目已变化，请重新读取制作。')
  const boundary = cassette ? groups.findIndex((_, index) => groups.slice(0, index).reduce((count, group) => count + group.length, 0) === order.splitAfter) : groups.length
  const sideBoundary = cassette && order.splitAfter === order.trackIds.length ? groups.length : boundary
  if (sideBoundary < 0) return invalid('连播组跨越 A/B 边界，请先调整分面约束。')
  const fromSide = groupIndex < sideBoundary ? 'A' : 'B'
  const checked = (result: WorkbenchOrder): WorkbenchMoveResult => {
    if (cassette && result.splitAfter < 1) return invalid('A 面至少需要一首曲目，不能把最后一组移到 B 面。')
    const sides = cassette ? [result.trackIds.slice(0, result.splitAfter), result.trackIds.slice(result.splitAfter)] : [result.trackIds]
    for (const side of sides) for (let index = 0; index < side.length; index++) {
      const rule = spec.rules.find(value => value.trackId === side[index])
      if (rule?.sideOpener && index !== 0 || rule?.sideCloser && index !== side.length - 1) return invalid('本面首曲或末曲约束不允许这次移动；请先调整高级分面约束。')
      if (cassette && rule?.forceSide && rule.forceSide !== (sides.indexOf(side) === 0 ? 'A' : 'B')) return invalid('指定面约束与这次移动冲突；请先调整高级分面约束。')
    }
    return { ok: true, order: result }
  }
  if ('direction' in move) {
    const target = groupIndex + move.direction
    if (target < 0 || target >= groups.length || cassette && (target < sideBoundary) !== (groupIndex < sideBoundary)) return invalid('这一组已在本段边缘；跨面请使用“移至另一面”。')
    ;[groups[groupIndex], groups[target]] = [groups[target]!, groups[groupIndex]!]
    return checked({ trackIds: groups.flat(), splitAfter: order.splitAfter })
  }
  if (!cassette) return invalid('DAT 是连续节目，没有 A/B 分面。')
  if (move.side === fromSide) return invalid('这一组已经在所选面。')
  const group = groups[groupIndex]!
  if (group.some(id => spec.rules.some(rule => rule.trackId === id && rule.forceSide && rule.forceSide !== move.side))) return invalid('指定面约束与这次移动冲突；请先调整高级分面约束。')
  groups.splice(groupIndex, 1)
  groups.splice(move.side === 'A' ? sideBoundary : sideBoundary - 1, 0, group)
  return checked({ trackIds: groups.flat(), splitAfter: order.splitAfter + (move.side === 'A' ? group.length : -group.length) })
}
