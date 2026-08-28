import { isSaveWantEntryRequest, isCancelWantEntryRequest, type CollectionProgressPublicApi, type ReferenceCatalogPublicApi, type WantEntry, type WantEntryView, type WantPriority } from '@music-bridge/contracts'

type Api = CollectionProgressPublicApi & Pick<ReferenceCatalogPublicApi, 'listReferenceSources' | 'getCatalogHistory' | 'getCatalogRevision' | 'getCatalogSnapshot'>
type Result<K extends keyof Api> = Awaited<ReturnType<Api[K]>>
export interface WantDraft {
  id: string | null; expectedVersion: number; referenceId: string; priority: WantPriority
  preferredCondition: string; notes: string; targetLength: string; packagingTarget: string; currency: string; amount: string
  previousTarget?: string
}
export interface CollectionProgressState {
  section: 'progress' | 'wants' | 'history'; bookId: string; revisionId: string; intentRevision: number
  sources?: Result<'listReferenceSources'>; catalogHistory?: Result<'getCatalogHistory'>; catalog?: Result<'getCatalogRevision'>
  sourcesLoading: boolean; sourcesError: string; wantsLoading: boolean; wantsError: string
  progress?: Result<'getCollectionProgress'>; progressFresh: boolean
  wants?: Result<'listWantEntries'>; wantHistory?: Result<'getWantEntryHistory'>; wantHistoryId?: string
  snapshots?: Result<'listCollectionProgressSnapshots'>; snapshotPreviousOffset?: number; snapshot?: Result<'getCollectionProgressSnapshot'>; legacySnapshot?: Result<'getCatalogSnapshot'>
  draft?: WantDraft; savedWant?: WantEntry; captured?: Result<'captureCollectionProgress'>
  busy: boolean; pendingLabel?: string; error: string; notice: string
}
const page = (offset = 0) => ({ offset, limit: 25 })
const emptyDraft = (referenceId = ''): WantDraft => ({ id: null, expectedVersion: 0, referenceId, priority: 'normal', preferredCondition: '', notes: '', targetLength: '', packagingTarget: '', currency: '', amount: '' })
function publicError(failure: unknown): string {
  const text = failure instanceof Error ? failure.message : ''
  if (/CONFLICT|STALE|FINGERPRINT|VERSION/u.test(text)) return '目录或求购版本已变化。请先核对原操作结果，再重新读取；不会替换原版本强行提交。'
  if (/OUTBOX|TIMEOUT|UNAVAILABLE|DISCONNECTED/u.test(text)) return '暂未取得明确结果。已有资料不会被当作空数据；写操作保留原命令，请恢复后明确重试。'
  return '操作未完成，请检查当前目录和输入。原目标与历史不会被自动修改。'
}
export function createCollectionProgressController(options: { api: Api; onChange?: () => void }) {
  const { api } = options
  const state: CollectionProgressState = { section: 'progress', bookId: '', revisionId: '', intentRevision: 0, progressFresh: false, sourcesLoading: false, sourcesError: '', wantsLoading: false, wantsError: '', busy: false, error: '', notice: '' }
  let alive = true, pending: (() => Promise<void>) | undefined
  let snapshotOffsets: number[] = []
  const changed = () => { if (alive) options.onChange?.() }
  const exclusiveBlocked = () => !alive || state.busy || !!pending
  const listingsLoading = () => state.sourcesLoading || state.wantsLoading
  const blocked = () => exclusiveBlocked() || listingsLoading()
  const error = (message: string) => { if (alive) { state.error = message; changed() } }
  const clearTarget = () => { if (state.draft) state.draft.referenceId = ''; state.intentRevision++ }
  const currentTarget = () => state.progressFresh && state.progress?.isCurrentRevision && state.progress.revisionId === state.revisionId && state.catalog?.revision.id === state.revisionId
  async function read<T>(send: () => Promise<T>, accept: (value: T) => void): Promise<void> {
    if (blocked()) return
    state.busy = true; state.error = ''; changed()
    try { const value = await send(); if (alive) accept(value) }
    catch (failure) { if (alive) state.error = publicError(failure) }
    finally { if (alive) { state.busy = false; changed() } }
  }
  /** 仅两个无目录依赖的列表并行；目录选择、其它读取与写命令仍互斥。 */
  async function readListing<T>(kind: 'sources' | 'wants', send: () => Promise<T>, accept: (value: T) => void): Promise<void> {
    const loading = kind === 'sources' ? 'sourcesLoading' : 'wantsLoading'
    const resourceError = kind === 'sources' ? 'sourcesError' : 'wantsError'
    if (exclusiveBlocked() || state[loading]) return
    state[loading] = true; state[resourceError] = ''; changed()
    try { const value = await send(); if (alive) accept(value) }
    catch { if (alive) state[resourceError] = `${kind === 'sources' ? '参考来源' : '求购清单'}读取失败，请重试；已有资料不会被当作空列表。` }
    finally { if (alive) { state[loading] = false; changed() } }
  }
  const loadSources = (offset = 0) => readListing('sources', () => api.listReferenceSources(page(offset)), value => { state.sources = value })
  const loadWants = (offset = 0) => readListing('wants', () => api.listWantEntries({ page: page(offset) }), value => { state.wants = value })
  function resetSnapshotPages(): void {
    snapshotOffsets = []; state.snapshotPreviousOffset = undefined; state.snapshots = undefined
  }
  async function readSnapshotPage(offset: number, previousOffsets: readonly number[]): Promise<void> {
    const bookId = state.bookId
    await read(() => api.listCollectionProgressSnapshots({ ...(bookId ? { bookId } : {}), page: page(offset) }), value => {
      // 预算可能缩小每页长度；只在读取成功后提交实际访问路径。
      state.snapshots = value; snapshotOffsets = [...previousOffsets, value.offset]; state.snapshotPreviousOffset = snapshotOffsets.at(-2)
    })
  }
  async function retry(confirmed: boolean): Promise<void> {
    if (!alive || !confirmed || state.busy || listingsLoading() || !pending) return
    state.busy = true; state.error = ''; changed()
    try { await pending(); if (alive) { pending = undefined; state.pendingLabel = undefined } }
    catch (failure) { if (alive) state.error = publicError(failure) }
    finally { if (alive) { state.busy = false; changed() } }
  }
  async function write<T>(label: string, send: () => Promise<T>, accept: (value: T) => void): Promise<void> {
    if (blocked()) return
    pending = async () => { const value = await send(); if (alive) accept(value) }
    state.pendingLabel = label; await retry(true)
  }
  function wantSaved(value: WantEntry): void {
    state.savedWant = value; state.draft = undefined; state.wants = undefined; state.progress = undefined; state.progressFresh = false; state.intentRevision++
    state.notice = value.active ? '求购目标已保存，库存未改变。请刷新求购清单与当前完成度。' : '求购已取消，库存未改变。此记录不能复活；以后需要时可新建独立目标。'
  }
  return {
    state,
    async start() { await Promise.all([loadSources(), loadWants()]) },
    setSection(section: CollectionProgressState['section']) { if (!exclusiveBlocked()) { state.section = section; changed() } },
    loadSources,
    async selectBook(bookId: string) {
      if (blocked()) return
      state.bookId = bookId; state.revisionId = ''; state.catalogHistory = undefined; state.catalog = undefined; state.progress = undefined; state.progressFresh = false; state.snapshot = undefined; resetSnapshotPages(); state.legacySnapshot = undefined; state.captured = undefined; clearTarget(); changed()
      if (bookId) await read(() => api.getCatalogHistory({ bookId, ...page() }), value => { state.catalogHistory = value })
    },
    async loadCatalogHistory(offset = 0) {
      const bookId = state.bookId
      if (bookId) await read(() => api.getCatalogHistory({ bookId, ...page(offset) }), value => {
        state.catalogHistory = value
        if (state.progress?.isCurrentRevision && value.currentRevisionId !== state.progress.revisionId) { state.progressFresh = false; clearTarget() }
      })
    },
    async selectRevision(revisionId: string) {
      if (blocked()) return
      state.revisionId = revisionId; state.catalog = undefined; state.progress = undefined; state.progressFresh = false; clearTarget(); changed()
      if (revisionId) await read(() => Promise.all([api.getCatalogRevision({ id: revisionId }), api.getCollectionProgress({ revisionId, page: page() })]), ([catalog, progress]) => { state.catalog = catalog; state.progress = progress; state.progressFresh = true })
    },
    async loadProgress(offset = 0) {
      if (blocked() || !state.revisionId) return
      state.progressFresh = false; state.intentRevision++; changed()
      const revisionId = state.revisionId
      await read(() => api.getCollectionProgress({ revisionId, page: page(offset) }), value => { state.progress = value; state.progressFresh = true })
    },
    loadWants,
    newWant(referenceId = '') {
      if (blocked()) return
      state.draft = emptyDraft(currentTarget() ? referenceId : ''); state.savedWant = undefined; state.section = 'wants'; state.error = ''; state.intentRevision++; changed()
    },
    editWant(view: WantEntryView) {
      if (blocked()) return
      if (!view.entry.active) { state.draft = undefined; error('已取消记录不能再次编辑，请新建独立求购目标。'); return }
      const entry = view.entry
      state.draft = { id: entry.id, expectedVersion: entry.version, referenceId: '', priority: entry.priority, preferredCondition: entry.preferredCondition, notes: entry.notes, targetLength: entry.targetLengthMinutes === null ? '' : String(entry.targetLengthMinutes), packagingTarget: entry.packagingTarget, currency: entry.priceTarget?.currency ?? '', amount: entry.priceTarget?.amount ?? '', previousTarget: `${entry.brand} ${entry.model} · ${entry.edition || '版次未标注'} · ${entry.referenceId}` }
      state.savedWant = undefined; state.section = 'wants'; state.error = ''; state.intentRevision++; changed()
    },
    setDraft(patch: Partial<Pick<WantDraft, 'referenceId' | 'priority' | 'preferredCondition' | 'notes' | 'targetLength' | 'packagingTarget' | 'currency' | 'amount'>>) {
      if (!blocked() && state.draft) { Object.assign(state.draft, structuredClone(patch)); state.intentRevision++; state.error = ''; changed() }
    },
    abandonDraft() { if (!blocked()) { state.draft = undefined; state.intentRevision++; changed() } },
    async saveWant(confirmed: boolean) {
      if (blocked() || !confirmed || !state.draft) return
      const draft = state.draft
      if (!currentTarget() || !state.catalog?.revision.items.some(item => item.referenceId === draft.referenceId)) { error('请明确选择当前目录修订和目标参考项。旧目标不会自动迁移或复制。'); return }
      if (draft.targetLength && !/^[1-9][0-9]{0,2}$/u.test(draft.targetLength)) { error('目标长度须为 1–360 的整数分钟，或留空表示不限定。'); return }
      const request = { commandId: crypto.randomUUID(), id: draft.id, expectedVersion: draft.expectedVersion, revisionId: state.revisionId, referenceId: draft.referenceId, priority: draft.priority, preferredCondition: draft.preferredCondition, notes: draft.notes, targetLengthMinutes: draft.targetLength ? Number(draft.targetLength) : null, packagingTarget: draft.packagingTarget, priceTarget: draft.amount || draft.currency ? { currency: draft.currency, amount: draft.amount } : null, userConfirmed: true as const }
      if (!isSaveWantEntryRequest(request)) { error('请核对文字长度与求购目标。价格需要三位大写币种和正十进制金额（最多12位整数、4位小数），不接受指数或浮点转换。'); return }
      const original = structuredClone(request)
      await write('保存求购目标', () => api.saveWantEntry(original), wantSaved)
    },
    async cancelWant(entry: WantEntry, confirmed: boolean) {
      if (blocked() || !confirmed || !entry.active) return
      const request = { commandId: crypto.randomUUID(), id: entry.id, expectedVersion: entry.version, userConfirmed: true as const }
      if (!isCancelWantEntryRequest(request)) { error('求购版本无效，请重新读取清单。'); return }
      await write('取消求购目标', () => api.cancelWantEntry(request), wantSaved)
    },
    async loadWantHistory(id: string, offset = 0) { await read(() => api.getWantEntryHistory({ id, page: page(offset) }), value => { state.wantHistory = value; state.wantHistoryId = id; state.section = 'history' }) },
    async capture(confirmed: boolean) {
      if (blocked() || !confirmed) return
      if (!currentTarget() || !state.progress) { error('只有重新读取后的当前目录可以采集快照；旧目录的当前事实不是历史快照。'); return }
      const request = { commandId: crypto.randomUUID(), revisionId: state.revisionId, expectedFingerprint: state.progress.fingerprint, userConfirmed: true as const }
      await write('采集完成度快照', () => api.captureCollectionProgress(request), value => { state.captured = value; resetSnapshotPages(); state.section = 'history'; state.intentRevision++; state.notice = '完成度快照已持久保存。请读取快照详情；后续库存与求购变化不会回填此历史。' })
    },
    async loadSnapshots(offset = 0) { await readSnapshotPage(offset, []) },
    async nextSnapshots() {
      const current = state.snapshots
      if (blocked() || !current?.hasMore || !current.items.length) return
      await readSnapshotPage(current.offset + current.items.length, snapshotOffsets)
    },
    async previousSnapshots() {
      const offset = state.snapshotPreviousOffset
      if (blocked() || offset === undefined) return
      await readSnapshotPage(offset, snapshotOffsets.slice(0, -2))
    },
    async loadSnapshot(id: string, offset = 0) { await read(() => api.getCollectionProgressSnapshot({ id, page: page(offset) }), value => { state.snapshot = value; state.legacySnapshot = undefined; state.section = 'history' }) },
    async loadLegacySnapshot(id: string) { await read(() => api.getCatalogSnapshot({ id }), value => { state.legacySnapshot = value; state.snapshot = undefined; state.section = 'history' }) },
    retry,
    releasePending(confirmed: boolean) {
      if (!confirmed || !alive || state.busy || !pending) return
      pending = undefined; state.pendingLabel = undefined; state.progressFresh = false; state.intentRevision++
      state.notice = '仅退出面板重试。原命令仍在全局未确认操作中，不撤销业务；请核对结果后重新读取。'; changed()
    },
    dispose() { alive = false },
  }
}
