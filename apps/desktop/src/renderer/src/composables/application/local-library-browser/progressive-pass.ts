import { isLocalAlbumVersionedPage, type LocalAlbumFilterCounts, type LocalAlbumQuery, type LocalAlbumSummary } from '@music-bridge/contracts'

type Scope = Pick<LocalAlbumQuery, 'query' | 'rootId' | 'filter'>
const sameScope = (left: Scope, right: Scope): boolean => left.query === right.query && left.rootId === right.rootId && left.filter === right.filter
function sameMembershipCounts(left: LocalAlbumFilterCounts, right: LocalAlbumFilterCounts, filter: Scope['filter']): boolean {
  return (Object.keys(left) as (keyof LocalAlbumFilterCounts)[]).every(key =>
    filter !== 'has-artwork' && filter !== 'missing-artwork' && (key === 'has-artwork' || key === 'missing-artwork') || left[key] === right[key])
}

/**
 * 单个有界分页轮：只保留顺序ID与修订，不保存第二份整库DTO或后端事务。
 * 每页都是独立、已提交的Owner事实。修订漂移时立即合并可见项，完整稳定轮才删项/重排。
 */
export function createProgressiveAlbumPass(scope: Scope, retainUntilComplete: boolean) {
  const captured = { ...scope }, orderedIds: string[] = [], seen = new Set<string>(), currentRevisionIds = new Set<string>()
  let offset = 0, firstRevision: string | undefined, lastRevision: string | undefined
  let lastCounts: LocalAlbumFilterCounts | undefined, lastTotal = 0
  let changed = false, invalidated = false, complete = false
  return {
    get offset() { return offset },
    get complete() { return complete },
    get needsReconciliation() { return changed || invalidated },
    invalidate() { invalidated = true },
    accept(request: LocalAlbumQuery, value: unknown, previous: readonly LocalAlbumSummary[]) {
      if (complete || request.offset !== offset || !sameScope(captured, request) || !isLocalAlbumVersionedPage(value, request)) throw new Error('无效渐进专辑页')
      const { page, revision } = value, nextChanged = changed || firstRevision !== undefined && revision !== firstRevision
      if (lastRevision === revision && (lastTotal !== page.total || !sameMembershipCounts(lastCounts!, page.counts, captured.filter))) throw new Error('同一专辑修订的成员计数不一致')
      const visible = new Map(previous.map(album => [album.id, album]))
      // 先完整核验，再推进任何游标/顺序状态；失败的单页不会污染下一次重试。
      for (const album of page.items) {
        if (lastRevision === revision && currentRevisionIds.has(album.id)) throw new Error('同一专辑修订的身份重复')
        const old = visible.get(album.id)
        if (old && old.rootId !== album.rootId) throw new Error('专辑的原根身份已改变')
      }
      if (lastRevision !== revision) currentRevisionIds.clear()
      for (const album of page.items) {
        currentRevisionIds.add(album.id)
        if (!seen.has(album.id)) { seen.add(album.id); orderedIds.push(album.id) }
        visible.set(album.id, album)
      }
      firstRevision ??= revision; lastRevision = revision; lastCounts = page.counts; lastTotal = page.total
      changed = nextChanged; offset = request.offset + page.items.length; complete = !page.hasMore
      const canonical = complete && !changed && !invalidated
      // canonical仍复用当前显示对象，避免末页把此前已观察到的封面状态倒灌回旧页快照。
      const items = Object.freeze(canonical ? orderedIds.map(id => visible.get(id)!) : [...visible.values()])
      return { items, total: page.total, hasMore: page.hasMore, counts: page.counts,
        reconciling: changed || invalidated || retainUntilComplete && !complete }
    },
  }
}
export type ProgressiveAlbumPass = ReturnType<typeof createProgressiveAlbumPass>
