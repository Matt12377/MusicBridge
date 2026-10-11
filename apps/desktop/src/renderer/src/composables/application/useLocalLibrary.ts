import { useLocalArtwork } from './useLocalArtwork.js'
import { useLocalOrganizer } from './useLocalOrganizer.js'
import { useLocalSourceWrites } from './useLocalSourceWrites.js'
import { useLocalRelocationPlans } from './useLocalRelocationPlans.js'
import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import { LOCAL_ORGANIZER_LIMIT, isCollectionId, isCommandOutboxOverview, isLocalArtworkContext, isLocalCatalogText, isLocalLibraryQueryPage, isLocalLibraryTrackDetail, isLocalPlayTarget, type LocalArtworkContext } from '@music-bridge/contracts'
import type { CommandOutboxOverview, CommandOutboxPublicApi, LocalLibraryPublicApi, LocalLibraryQueryPage, LocalLibraryTrackSummary, LocalLibraryTrackDetail, LocalMetadata, LocalPlayAccepted, LocalPlayAction, LocalPlayRequest, LocalPlayTarget, LocalSourceUnsupported, LocalRootView, LocalRelocationSelection, LocalRelocationCandidates, LocalRelocationConfirm, LocalCatalogCommandPayloads, PublicRoonZone, TrackSummary } from '@music-bridge/contracts'
import { localPlaybackSubmissionUnconfirmed, localPlaySubmissionResolved, type LocalLibraryPlayReceipt } from '../../components/player/details.js'
import { isLocalPlayReceipt, type LocalPlayReceipt, type LocalPlayRejection } from '@music-bridge/contracts'

export const LOCAL_LIBRARY_PAGE_SIZE = 100
export const LOCAL_LIBRARY_CACHE_PAGES = 6
export interface LocalLibraryOptions {
  api: LocalLibraryPublicApi & Partial<import('@music-bridge/contracts').LocalArtworkPublicApi> & Partial<import('@music-bridge/contracts').LocalOrganizerPublicApi> & Partial<import('@music-bridge/contracts').LocalSourceWritesPublicApi> & Partial<import('@music-bridge/contracts').LocalRelocationPlanPublicApi> & Partial<Pick<CommandOutboxPublicApi, 'getCommandOutbox'>>
  getSelectedZone: () => PublicRoonZone | undefined
  play: (request: LocalPlayRequest) => Promise<LocalPlayAccepted | LocalSourceUnsupported>
  readPlayReceipt?: (request:LocalPlayRequest) => Promise<LocalPlayReceipt>
  getPlaybackSnapshot?: () => import('@music-bridge/contracts').PlaybackSnapshot | null
}
export function localLibraryTrackPresentation(item: LocalLibraryTrackSummary): TrackSummary {
  return { id: item.track.id, title: item.metadata.title || '来源未提供标题', artists: item.metadata.artist ? [item.metadata.artist] : [], album: item.metadata.album || '',
    ...(item.versionTokens.length ? { version: [...new Set(item.versionTokens.map(token => token.raw))].join(' · ') } : {}) }
}

/** 页缓存只保存公开投影；搜索、详情和动作各有独立代际，离页不会制造播放状态。 */
export function useLocalLibrary(options: LocalLibraryOptions) {
  const artworkUnavailable=async():Promise<never>=>{throw new Error('封面服务暂不可用，原选择保留。')}
  const artwork=markRaw(useLocalArtwork({api:{getLocalArtworkContext:options.api.getLocalArtworkContext??artworkUnavailable,findLocalArtworkCandidates:options.api.findLocalArtworkCandidates??artworkUnavailable,searchLocalArtworkCandidates:options.api.searchLocalArtworkCandidates??artworkUnavailable,chooseLocalArtworkFile:options.api.chooseLocalArtworkFile??artworkUnavailable,importLocalArtworkBytes:options.api.importLocalArtworkBytes??artworkUnavailable,applyLocalArtworkSelection:options.api.applyLocalArtworkSelection??artworkUnavailable,createLocalArtworkEdition:options.api.createLocalArtworkEdition??artworkUnavailable,cancelLocalArtworkLookup:options.api.cancelLocalArtworkLookup??artworkUnavailable,...(options.api.getCommandOutbox?{getCommandOutbox:options.api.getCommandOutbox}:{})},onApplied:()=>{if(selectedId.value)void selectTrack(selectedId.value,true)}}))
  const organizerUnavailable = async (): Promise<never> => { throw new Error('整理服务暂不可用，原信息保留。') }
  const organizer = markRaw(useLocalOrganizer({ api: {
    previewLocalOrganizer: options.api.previewLocalOrganizer ?? organizerUnavailable,
    getLocalOrganizerPlan: options.api.getLocalOrganizerPlan ?? organizerUnavailable,
    listLocalOrganizerHistory: options.api.listLocalOrganizerHistory ?? organizerUnavailable,
    confirmLocalOrganizer: options.api.confirmLocalOrganizer ?? organizerUnavailable,
    undoLocalOrganizer: options.api.undoLocalOrganizer ?? organizerUnavailable,
    cancelLocalOrganizer: options.api.cancelLocalOrganizer ?? organizerUnavailable,
    ...(options.api.getCommandOutbox ? { getCommandOutbox: options.api.getCommandOutbox } : {}),
  }, onApplied: () => { if (active && !disposed) void refreshBusiness() } }))
  const selectionMode = ref(false), selectedTrackIds = shallowRef<string[]>([]), selectionError = ref('')
  const sourceWrites = markRaw(useLocalSourceWrites({ api: options.api, onApplied: () => { if (active && !disposed) void refreshBusiness() } }))
  const relocationPlans = markRaw(useLocalRelocationPlans({ api: options.api, onApplied: () => { if (active && !disposed) void refreshBusiness() } }))
  const query = ref(''), rootId = ref<string | null>(null), total = ref(0), scrollTop = ref(0)
  const loaded = ref(false), loading = ref(false), stale = ref(false), error = ref(''), detailError = ref(''), actionError = ref('')
  const roots = shallowRef<LocalRootView[]>([]), target = shallowRef<LocalPlayTarget | null>(null)
  const selectedId = ref<string | null>(null), detail = shallowRef<LocalLibraryTrackDetail | null>(null), detailLoading = ref(false), detailStale = ref(false)
  const detailArtwork = shallowRef<LocalArtworkContext|null>(null)
  const detailReturnTarget = shallowRef<{ trackId: string; index: number; scrollTop: number; query: string; rootId: string | null } | null>(null)
  const actionBusy = ref(false), titleDraft = ref(''), candidates = shallowRef<LocalRelocationCandidates | null>(null)
  const relocationSelection = shallowRef<LocalRelocationSelection | null>(null), relocationConfirmed = ref(false), relocationUnknown = ref(false)
  const pendingOverride = shallowRef<LocalCatalogCommandPayloads['localCatalog.overrideMetadata'] | null>(null)
  const lastPlay = shallowRef<LocalLibraryPlayReceipt | null>(null)
  const unconfirmedPlay = shallowRef<LocalPlayRequest | null>(null)
  let resolvedPlay: LocalPlayRequest | null = null
  const canReadOriginalPlay=computed(()=>!!lastPlay.value && (typeof options.readPlayReceipt==='function' || typeof options.api.getLocalLibraryPlayReceipt==='function'))
  const rejectionMessage:Record<LocalPlayRejection,string>={REQUEST_REJECTED:'原点播请求已拒绝，请刷新曲目与播放目标后核对。',TARGET_UNAVAILABLE:'原请求的 Roon 播放目标不可用，请核对连接与设备选择。',SOURCE_UNAVAILABLE:'原请求的来源准备失败，请核对目录与具体曲目。',MEDIA_ERROR:'Roon 已报告原媒体错误，请查看本次诊断。',ROON_TIMEOUT:'原启动请求已超时，请查看本次 Roon 阶段诊断。',INTERNAL_ERROR:'原请求处理失败，请导出本次诊断。'}
  type Pending<R> = { request: R; datasetId: string | null; generation: number; trackId: string | null; confirmed: 'succeeded' | 'rejected' | null }
  let overrideBinding: Pending<LocalCatalogCommandPayloads['localCatalog.overrideMetadata']> | null = null
  const pendingRelocation = shallowRef<Pending<LocalRelocationConfirm> | null>(null)
  const overrideUnknownMessage = '显示更正结果未确认。同一请求已保留，请到“未确认操作”核对；暂不重复更正。'
  const relocationUnknownMessage = '重新定位结果未确认，请在“未确认操作”核对原候选请求；不会更换请求或删除曲目与收藏。'
  let mutationGeneration = 0, outboxGeneration = 0, actionErrorCommandId: string | null = null, sessionDatasetId: string | undefined
  const cacheVersion = ref(0), pages = new Map<number, LocalLibraryQueryPage>()
  const refreshPages = new Set<number>()
  let active = false, disposed = false, queryGeneration = 0, detailGeneration = 0, contextGeneration = 0, actionGeneration = 0
  let pumping: Promise<void> | undefined
  // 立即消费真实闭合观察；随后切来源不会把已结束的原意图重新变成未知。
  const stopPlaybackObservation = options.getPlaybackSnapshot
    ? watch(options.getPlaybackSnapshot, consumePlaybackObservation, { flush: 'sync', immediate: true }) : undefined
  let wantedStart = 0, wantedEnd = 24
  const rangeWindow = computed(() => {
    void cacheVersion.value
    const entries = [...pages].flatMap(([pageIndex, page]) => page.items.map((item, offset) => ({ index: pageIndex * LOCAL_LIBRARY_PAGE_SIZE + offset, track: localLibraryTrackPresentation(item) })))
    return { total: total.value, entries }
  })
  const tracks = computed(() => rangeWindow.value.entries.map(entry => entry.track))
  const cachePageCount = computed(() => { void cacheVersion.value; return pages.size })
  const selectedRoot = computed(() => detail.value ? roots.value.find(root => root.root.id === detail.value!.asset.libraryRootId) : undefined)
  const targetLabel = computed(() => {
    const zone = options.getSelectedZone()
    return target.value && zone?.zoneId === target.value.zone_id ? zone.displayName : '尚未选择可用的 Roon 播放目标'
  })

  function desiredPages(): number[] {
    if (!loaded.value) return [0]
    if (total.value === 0) return refreshPages.has(0) ? [0] : []
    const start = Math.min(Math.max(0, wantedStart), total.value - 1), end = Math.min(total.value, Math.max(start + 1, wantedEnd), start + 200)
    const first = Math.floor(start / LOCAL_LIBRARY_PAGE_SIZE), last = Math.floor((end - 1) / LOCAL_LIBRARY_PAGE_SIZE)
    return Array.from({ length: Math.min(3, last - first + 1) }, (_, offset) => first + offset)
  }
  function evictPages(): void {
    const protectedPages = new Set(desiredPages())
    for (const page of pages.keys()) {
      if (pages.size <= LOCAL_LIBRARY_CACHE_PAGES) break
      if (!protectedPages.has(page)) { pages.delete(page); refreshPages.delete(page) }
    }
    cacheVersion.value++
  }
  function pump(): Promise<void> {
    if (pumping) return pumping
    if (!active || disposed) return Promise.resolve()
    pumping = (async () => {
      while (active && !disposed) {
        const wanted = desiredPages()
        const pageIndex = wanted.find(index => !pages.has(index) || refreshPages.has(index))
        if (pageIndex === undefined) return
        const generation = queryGeneration, request = { query: query.value, rootId: rootId.value, offset: pageIndex * LOCAL_LIBRARY_PAGE_SIZE, limit: LOCAL_LIBRARY_PAGE_SIZE }
        loading.value = true
        try {
          const page = await options.api.queryLocalLibraryTracks(request)
          if (!active || disposed || generation !== queryGeneration) continue
          if (!isLocalLibraryQueryPage(page) || page.query !== request.query || page.rootId !== request.rootId || page.offset !== request.offset || page.limit !== request.limit) throw new Error('查询身份不一致')
          const changed = loaded.value && page.total !== total.value
          if (changed) { pages.clear(); refreshPages.clear() }
          pages.delete(pageIndex); pages.set(pageIndex, page); total.value = page.total; loaded.value = true; error.value = ''
          refreshPages.delete(pageIndex); stale.value = desiredPages().some(index => refreshPages.has(index))
          evictPages()
        } catch {
          if (active && !disposed && generation === queryGeneration) { stale.value = pages.size > 0; error.value = stale.value ? '刷新暂未完成，保留上次成功读取的结果。音乐库与收藏保留，请重试读取。' : '这一页暂时无法读取。音乐库与收藏保留，请重试读取。'; return }
        } finally { if (generation === queryGeneration) loading.value = false }
      }
    })().finally(() => { pumping = undefined; loading.value = false })
    return pumping
  }
  function ensureRange(start: number, end: number): Promise<void> {
    wantedStart = Math.max(0, Math.floor(start)); wantedEnd = Math.max(wantedStart + 1, Math.floor(end))
    for (const page of desiredPages()) { const cached = pages.get(page); if (cached) { pages.delete(page); pages.set(page, cached) } }
    stale.value = error.value !== '' && pages.size > 0 || desiredPages().some(index => refreshPages.has(index))
    return pump()
  }
  function resetQuery(preserveScroll: boolean): Promise<void> {
    queryGeneration++; error.value = ''
    if (preserveScroll) { for (const page of pages.keys()) refreshPages.add(page); stale.value = pages.size > 0 }
    else { pages.clear(); refreshPages.clear(); cacheVersion.value++; loaded.value = false; total.value = 0; stale.value = false; scrollTop.value = 0; wantedStart = 0; wantedEnd = 24 }
    return pump()
  }
  async function search(text: string, root: string | null = rootId.value): Promise<void> {
    if (!isLocalCatalogText(text, true) || Array.from(text).length > 256) { error.value = '搜索最多输入 256 个字符，请缩短后再试。'; return }
    if (text === query.value && root === rootId.value && loaded.value) return
    query.value = text; rootId.value = root; closeDetail(); await resetQuery(false)
  }
  async function refreshContext(): Promise<void> {
    const generation = ++contextGeneration
    const [nextRoots, nextTarget] = await Promise.allSettled([options.api.listLocalLibraryRoots(), options.api.getLocalLibraryPlaybackTarget()])
    if (!active || disposed || generation !== contextGeneration) return
    if (nextRoots.status === 'fulfilled') roots.value = nextRoots.value
    if (nextTarget.status === 'fulfilled' && (nextTarget.value === null || isLocalPlayTarget(nextTarget.value))) target.value = nextTarget.value
    else target.value = null
  }
  async function selectTrack(trackId: string, preserveCurrent = false): Promise<void> {
    const keep = preserveCurrent && detail.value?.track.id === trackId
    selectedId.value = trackId; if (!keep) { detail.value = null; detailArtwork.value = null }
    detailStale.value = keep; detailError.value = ''; detailLoading.value = true
    if (!keep) { candidates.value = null; relocationSelection.value = null; relocationConfirmed.value = false }
    const generation = ++detailGeneration
    try {
      const result = await options.api.getLocalLibraryTrackDetail(trackId)
      if (!active || disposed || generation !== detailGeneration || selectedId.value !== trackId) return
      if (!isLocalLibraryTrackDetail(result) || result.track.id !== trackId) throw new Error('详情身份不一致')
      detail.value = result; detailStale.value = false; titleDraft.value = result.metadata.effective.title || ''
      if (options.api.getLocalArtworkContext) {
        try {
          const chosen=artwork.context.value?.trackId===trackId ? artwork.context.value.target?.editionId??null : null;
          const saved=await options.api.getLocalArtworkContext({trackId,editionId:chosen});
          if (active && !disposed && generation===detailGeneration && selectedId.value===trackId && isLocalArtworkContext(saved) && saved.trackId===trackId) detailArtwork.value=saved;
        } catch { /* 封面投影失败不会清掉已读取的曲目详情或阻断直送。 */ }
      }
    } catch { if (active && !disposed && generation === detailGeneration) detailError.value = keep ? '详情刷新暂未完成，保留上次成功读取的信息；曲目与收藏保留。' : '详情暂时无法读取，请重试；已保存的曲目与收藏保留。' }
    finally { if (generation === detailGeneration) detailLoading.value = false }
  }
  function closeDetail(): void { artwork.close(); detailGeneration++; selectedId.value = null; detail.value = null; detailArtwork.value=null; detailLoading.value = false; detailStale.value = false; detailError.value = ''; detailReturnTarget.value = null; candidates.value = null; relocationSelection.value = null; relocationConfirmed.value = false }
  async function refreshBusiness(): Promise<void> {
    await Promise.all([refreshContext(), resetQuery(true), selectedId.value ? selectTrack(selectedId.value, true) : Promise.resolve()])
  }
  function applyOutbox(overview: CommandOutboxOverview, originalOverride = overrideBinding, originalRelocation = pendingRelocation.value): boolean {
    if (!active || disposed || !isCommandOutboxOverview(overview)) return false
    // 首次公开工作库身份固定在本页会话；切库不为原页面意图改绑身份。
    sessionDatasetId ??= overview.datasetId
    if (overview.datasetId !== sessionDatasetId) return false
    const terminal = (binding: Pending<{ commandId: string }> | null, command: 'localCatalog.overrideMetadata' | 'localRelocation.confirm') => {
      if (!binding?.datasetId || overview.datasetId !== binding.datasetId) return undefined
      const entry = overview.entries.find(item => item.datasetId === binding.datasetId && item.commandId === binding.request.commandId && item.command === command)
      if (entry) return entry.state === 'succeeded' || entry.state === 'rejected' ? entry.state : undefined
      return binding.confirmed ?? undefined
    }
    let changed = false
    const overrideState = terminal(originalOverride, 'localCatalog.overrideMetadata')
    if (overrideState && originalOverride && overrideBinding === originalOverride && originalOverride.generation === overrideBinding.generation && pendingOverride.value === originalOverride.request) {
      pendingOverride.value = null; overrideBinding = null; changed = true
      if (actionErrorCommandId === originalOverride.request.commandId) { actionError.value = overrideState === 'rejected' ? '原显示更正已拒绝，请核对最新信息后再编辑；没有重发原请求。' : ''; actionErrorCommandId = null }
    }
    const relocationState = terminal(originalRelocation, 'localRelocation.confirm')
    if (relocationState && originalRelocation && pendingRelocation.value === originalRelocation && originalRelocation.generation === pendingRelocation.value.generation) {
      pendingRelocation.value = null; relocationUnknown.value = false; candidates.value = null; relocationSelection.value = null; relocationConfirmed.value = false; changed = true
      if (actionErrorCommandId === originalRelocation.request.commandId) { actionError.value = relocationState === 'rejected' ? '原重新定位请求已拒绝，请核对最新文件位置后重新选择；没有重发原候选。' : ''; actionErrorCommandId = null }
    }
    if (changed) { for (const index of pages.keys()) refreshPages.add(index); stale.value = pages.size > 0 }
    return changed
  }
  async function refreshOutbox(): Promise<boolean> {
    if (!active || disposed || !options.api.getCommandOutbox) return false
    const generation = ++outboxGeneration, originalOverride = overrideBinding, originalRelocation = pendingRelocation.value
    try {
      const overview = await options.api.getCommandOutbox()
      if (active && !disposed && generation === outboxGeneration) return applyOutbox(overview, originalOverride, originalRelocation)
    } catch { /* 读取失败不改变未知业务动作，也不重发。 */ }
    return false
  }
  function observeOutbox(overview: CommandOutboxOverview): void {
    artwork.observeOutbox(overview);
    organizer.observeOutbox(overview)
    sourceWrites.observeOutbox(overview)
    relocationPlans.observeOutbox(overview)
    if (disposed || !isCommandOutboxOverview(overview) || overview.datasetId !== sessionDatasetId) return
    const originalOverride = overrideBinding, originalRelocation = pendingRelocation.value
    const confirmed = (binding: Pending<{ commandId: string }> | null, command: 'localCatalog.overrideMetadata' | 'localRelocation.confirm') => {
      if (!binding?.datasetId || binding.datasetId !== overview.datasetId) return null
      const entry = overview.entries.find(item => item.datasetId === binding.datasetId && item.command === command && item.commandId === binding.request.commandId)
      return entry?.state === 'succeeded' || entry?.state === 'rejected' ? entry.state : null
    }
    const overrideState = confirmed(originalOverride, 'localCatalog.overrideMetadata'), relocationState = confirmed(originalRelocation, 'localRelocation.confirm')
    if (overrideState && originalOverride && overrideBinding === originalOverride && pendingOverride.value === originalOverride.request && overrideBinding.generation === originalOverride.generation) originalOverride.confirmed = overrideState
    if (relocationState && originalRelocation && pendingRelocation.value === originalRelocation && pendingRelocation.value.generation === originalRelocation.generation) originalRelocation.confirmed = relocationState
    // 离页只记下原面板收到的同身份终态；返回后仍须读取确认当前工作库。
    if (!active) return
    outboxGeneration++
    if (applyOutbox(overview, originalOverride, originalRelocation)) void refreshBusiness()
  }
  async function captureDataset(): Promise<string | null> {
    if (!options.api.getCommandOutbox) return null
    const overview = await options.api.getCommandOutbox()
    if (!isCommandOutboxOverview(overview)) throw new Error('工作库身份未确认')
    sessionDatasetId ??= overview.datasetId
    if (overview.datasetId !== sessionDatasetId) throw new Error('工作库已变化')
    return overview.datasetId
  }
  async function refresh(): Promise<void> { await refreshOutbox(); if (active && !disposed) await refreshBusiness() }
  async function activate(): Promise<void> {
    if (disposed) return
    active = true
    const [reconciled] = await Promise.all([refreshOutbox(), refreshContext(), pump(), selectedId.value ? selectTrack(selectedId.value, true) : Promise.resolve()])
    if (reconciled && active && !disposed) await refreshBusiness()
  }
  function suspend(): void { artwork.close(); organizer.close(); sourceWrites.close(); relocationPlans.close(); active = false; queryGeneration++; detailGeneration++; contextGeneration++; actionGeneration++; outboxGeneration++; loading.value = false; detailLoading.value = false; target.value = null }
  function dispose(): void { stopPlaybackObservation?.(); artwork.dispose(); organizer.dispose(); sourceWrites.dispose(); relocationPlans.dispose(); suspend(); disposed = true; pages.clear(); cacheVersion.value++ }
  function toggleTrackSelection(trackId: string): void {
    if (!isCollectionId(trackId)) return
    selectionError.value = ''
    if (selectedTrackIds.value.includes(trackId)) selectedTrackIds.value = selectedTrackIds.value.filter(value => value !== trackId)
    else if (selectedTrackIds.value.length >= LOCAL_ORGANIZER_LIMIT) selectionError.value = '每次最多选择 100 首，请先整理当前选择。'
    else selectedTrackIds.value = [...selectedTrackIds.value, trackId]
  }
  function clearTrackSelection(): void { selectedTrackIds.value = []; selectionError.value = '' }

  async function openRelocationTracks(trackIds: string[], initialMode: 'rename' | 'move'): Promise<void> {
    if (actionBusy.value || !active || disposed || !relocationPlans.capable || trackIds.length < 1 || trackIds.length > LOCAL_ORGANIZER_LIMIT || new Set(trackIds).size !== trackIds.length || trackIds.some(id => !isCollectionId(id))) return
    const ids = [...trackIds], generation = ++actionGeneration
    actionBusy.value = true; actionError.value = ''; actionErrorCommandId = null
    try {
      const currentRoots = await options.api.listLocalLibraryRoots(), selections = new Map<string, import('@music-bridge/contracts').LocalRelocationPlanSelection>()
      let label = `明确选择的 ${ids.length} 首`
      for (const trackId of ids) {
        const current = await options.api.getLocalLibraryTrackDetail(trackId)
        if (!active || disposed || generation !== actionGeneration) return
        if (!isLocalLibraryTrackDetail(current) || current.track.id !== trackId) throw new Error('搬迁曲目身份未核实')
        const root = currentRoots.find(value => value.root.id === current.asset.libraryRootId)
        if (!root || root.root.revision !== current.asset.rootRevision || root.root.sourceRootId !== current.asset.sourceRootId) throw new Error('搬迁目录关联已变化')
        const selection = { assetId: current.asset.id, expectedFileRevision: current.asset.fileRevision, expectedLocationRevision: current.asset.locationRevision, expectedRootRevision: root.root.revision }
        const previous = selections.get(selection.assetId)
        if (previous && (previous.expectedFileRevision !== selection.expectedFileRevision || previous.expectedLocationRevision !== selection.expectedLocationRevision || previous.expectedRootRevision !== selection.expectedRootRevision)) throw new Error('共享源修订未核实')
        // 多段曲目指向同一实际源时只选择一次源，全部段落与伴随闭集由Core作者核对。
        selections.set(selection.assetId, selection)
        if (ids.length === 1) label = current.metadata.effective.title ?? '当前曲目源文件'
      }
      if (active && !disposed && generation === actionGeneration) await relocationPlans.open([...selections.values()], label, initialMode)
    } catch { if (active && !disposed && generation === actionGeneration) actionError.value = '具体源文件与目录修订尚未核实，请先刷新；尚未派发搬迁计划。' }
    finally { actionBusy.value = false }
  }
  async function openRelocationTrack(initialMode: 'rename' | 'move' = 'move'): Promise<void> { if (detail.value) await openRelocationTracks([detail.value.track.id], initialMode) }
  async function openRelocationBatch(): Promise<void> { await openRelocationTracks([...selectedTrackIds.value], 'move') }

  async function playTrack(trackId: string, action: LocalPlayAction = 'PLAY_NOW'): Promise<void> {
    if (actionBusy.value || !active) return
    if (playSubmissionBlocked(action)) return
    actionBusy.value = true; actionError.value = ''; actionErrorCommandId = null
    const generation = ++actionGeneration
    let dispatchedRequest: LocalPlayRequest | null = null
    try {
      const [current, currentTarget, currentRoots] = await Promise.all([options.api.getLocalLibraryTrackDetail(trackId), options.api.getLocalLibraryPlaybackTarget(), options.api.listLocalLibraryRoots()])
      if (!active || disposed || generation !== actionGeneration) return
      if (!isLocalLibraryTrackDetail(current) || current.track.id !== trackId) throw new Error('曲目选择失效')
      roots.value = currentRoots; target.value = currentTarget
      const zone = options.getSelectedZone(), root = currentRoots.find(v => v.root.id === current.asset.libraryRootId)
      if (!currentTarget || !isLocalPlayTarget(currentTarget) || !zone || zone.zoneId !== currentTarget.zone_id) { actionError.value = '请先在原播放器中选择可用的 Roon Zone，再明确点播。'; return }
      if (!root || root.availability !== 'ONLINE') { actionError.value = '源目录离线或许可已撤销，请先恢复或重新关联目录；曲目与收藏保留。'; return }
      if (root.root.revision !== current.asset.rootRevision || root.root.sourceRootId !== current.asset.sourceRootId) { actionError.value = '目录关联已改变，请先完成增量扫描再点播。'; return }
      if (current.track.segment !== null) { actionError.value = '当前 CUE 段落尚不支持原文件直送，曲目保留。'; return }
      if (playSubmissionBlocked(action)) return
      const request: LocalPlayRequest = { schema_version: '1.2', request_id: crypto.randomUUID(), route: 'roon_audio_input', source_kind: 'local_file', local_track_id: current.track.id, asset_id: current.asset.id, expected_asset_revision: current.asset.fileRevision, target: { ...currentTarget }, action }
      dispatchedRequest = request
      resolvedPlay = null
      lastPlay.value = { request, result: null, outcome: 'pending' }
      const result = await options.play(request)
      if (disposed || lastPlay.value?.request.request_id !== request.request_id) return
      if (result.status === 'accepted' && (result.request_id !== request.request_id || result.action !== request.action)) throw new Error('受理身份不一致')
      lastPlay.value = { request, result, outcome: 'received' }
      consumePlaybackObservation(options.getPlaybackSnapshot?.() ?? null)
      if (request.action === 'PLAY_NOW' && result.status === 'accepted' && options.getPlaybackSnapshot
        && !hasResolvedPlay(request)) unconfirmedPlay.value = request
      if (active && generation === actionGeneration && result.status === 'unsupported') actionError.value = result.reason === 'LOCAL_SEGMENT_UNSUPPORTED' ? '当前段落尚不支持原文件直送。' : '当前连接尚不支持本地原文件直送，请检查 Roon 目标与播放连接。'
    } catch (error) {
      const rejected=error instanceof Error && /^\[(?:LOCAL_PLAY_REJECTED|INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(error.message)
      if (!disposed && dispatchedRequest && lastPlay.value?.request.request_id === dispatchedRequest.request_id && lastPlay.value.outcome === 'pending') lastPlay.value = { ...lastPlay.value, outcome: rejected?'rejected':'unknown',...(rejected?{failure:'REQUEST_REJECTED' as const}:{}) }
      if (!disposed && dispatchedRequest?.action === 'PLAY_NOW' && !rejected && !hasResolvedPlay(dispatchedRequest)) unconfirmedPlay.value = dispatchedRequest
      if (!disposed && active && generation === actionGeneration) actionError.value = !dispatchedRequest?'点播尚未派发，曲目或目录信息读取失败，请刷新后核对。':rejected?rejectionMessage.REQUEST_REJECTED:'点播结果未获确认，请使用“核对原点播”读取原回执，并查看原播放器与队列状态。'
    }
    finally { actionBusy.value = false }
  }
  function hasResolvedPlay(request: LocalPlayRequest): boolean {
    return resolvedPlay !== null && JSON.stringify(resolvedPlay) === JSON.stringify(request)
  }
  function consumePlaybackObservation(snapshot: import('@music-bridge/contracts').PlaybackSnapshot | null): void {
    const original = unconfirmedPlay.value ?? lastPlay.value?.request
    if (disposed || !original || !localPlaySubmissionResolved(snapshot, original)) return
    resolvedPlay = structuredClone(original)
    if (unconfirmedPlay.value?.request_id === original.request_id) unconfirmedPlay.value = null
  }
  function playSubmissionBlocked(action: LocalPlayAction): boolean {
    const snapshot = options.getPlaybackSnapshot?.() ?? null
    consumePlaybackObservation(snapshot)
    const unresolvedReceipt = lastPlay.value?.outcome === 'unknown'
      && !hasResolvedPlay(lastPlay.value.request)
    if (unconfirmedPlay.value || unresolvedReceipt || action === 'PLAY_NOW' && localPlaybackSubmissionUnconfirmed(snapshot)) {
      actionError.value = '原点播受理与播放确认尚未闭合，请使用“核对原点播”读取原回执并核对 Roon；暂不新增点播。'
      return true
    }
    return false
  }
  async function readOriginalPlay():Promise<void>{
    const binding=lastPlay.value, read=options.readPlayReceipt ?? options.api.getLocalLibraryPlayReceipt
    if(!binding || !read || actionBusy.value || !active || disposed)return
    const generation=++actionGeneration
    actionBusy.value=true;actionError.value=''
    try{
      const request=structuredClone(binding.request),receipt=await read(request)
      if(disposed || lastPlay.value!==binding)return
      if(!isLocalPlayReceipt(receipt) || receipt.request_id!==request.request_id || receipt.action!==request.action)throw new Error('原回执身份无效')
      if(receipt.status==='received') {
        lastPlay.value={request:binding.request,result:receipt.result,outcome:'received'}
        consumePlaybackObservation(options.getPlaybackSnapshot?.() ?? null)
        if (binding.request.action === 'PLAY_NOW') {
          if (receipt.result.status === 'unsupported' || hasResolvedPlay(binding.request)) unconfirmedPlay.value = null
          else if (unconfirmedPlay.value || options.getPlaybackSnapshot) unconfirmedPlay.value = binding.request
        }
      } else if(receipt.status==='rejected') {
        lastPlay.value={request:binding.request,result:null,outcome:'rejected',failure:receipt.reason}
        if (unconfirmedPlay.value?.request_id === binding.request.request_id) unconfirmedPlay.value = null
      }
      if(active && generation===actionGeneration)actionError.value=receipt.status==='missing'?'当前服务没有原提交的回执，原结果仍未确认；请导出诊断核对，不会重发。':receipt.status==='pending'?'原提交仍在处理，请稍后再次核对；不会新增或重发点播。':receipt.status==='rejected'?rejectionMessage[receipt.reason]:''
    }catch{
      if(!disposed && active && generation===actionGeneration && lastPlay.value===binding)actionError.value='原回执暂时无法读取，原请求和未确认状态保留，请查看诊断。'
    }finally{actionBusy.value=false}
  }
  async function saveTitle(): Promise<void> {
    if (actionBusy.value || pendingOverride.value || !detail.value || !active) return
    const current = detail.value, title = titleDraft.value.trim()
    if (!isLocalCatalogText(title)) { actionError.value = '显示名称需要 1 至 512 个字符。'; return }
    const fields: LocalMetadata = { ...current.metadata.override?.fields, title }
    actionBusy.value = true; actionError.value = ''; actionErrorCommandId = null
    const generation = ++actionGeneration
    let binding: Pending<LocalCatalogCommandPayloads['localCatalog.overrideMetadata']> | null = null
    try {
      const datasetId = await captureDataset()
      if (!active || disposed || generation !== actionGeneration) return
      const request = { commandId: crypto.randomUUID(), trackId: current.track.id, expectedRevision: current.metadata.override?.revision ?? null, fields }
      binding = { request, datasetId, generation: ++mutationGeneration, trackId: request.trackId, confirmed: null }; overrideBinding = binding; pendingOverride.value = request
      await options.api.overrideLocalLibraryMetadata(request)
      if (overrideBinding !== binding || disposed) return
      binding.confirmed = 'succeeded'
      if (!active || generation !== actionGeneration) return
      if (datasetId) await refreshOutbox()
      else { pendingOverride.value = null; overrideBinding = null }
      await refreshBusiness()
    } catch {
      if (!disposed && binding && overrideBinding === binding) { actionError.value = overrideUnknownMessage; actionErrorCommandId = binding.request.commandId }
      else if (!binding && active && generation === actionGeneration) actionError.value = '当前工作库暂时无法核对，请先刷新；尚未派发显示更正。'
    }
    finally { actionBusy.value = false }
  }
  async function locateSelected(): Promise<void> {
    if (actionBusy.value || pendingRelocation.value || relocationUnknown.value || !detail.value || !active) return
    actionBusy.value = true; actionError.value = ''; actionErrorCommandId = null
    const trackId = detail.value.track.id, generation = ++detailGeneration
    try {
      const [current, currentRoots] = await Promise.all([options.api.getLocalLibraryTrackDetail(trackId), options.api.listLocalLibraryRoots()])
      if (!active || generation !== detailGeneration || selectedId.value !== trackId) return
      const root = currentRoots.find(v => v.root.id === current.asset.libraryRootId)
      if (!root || current.track.segment !== null) throw new Error('重新定位选择无效')
      const selection = { assetId: current.asset.id, expectedFileRevision: current.asset.fileRevision, expectedLocationRevision: current.asset.locationRevision, expectedRootRevision: root.root.revision }
      const result = await options.api.chooseLocalRelocationCandidates(selection)
      if (!active || generation !== detailGeneration || selectedId.value !== trackId) return
      relocationSelection.value = selection; candidates.value = result; relocationConfirmed.value = false
    } catch { if (active && generation === detailGeneration) actionError.value = '候选暂时无法读取，请恢复目录或检查授权；原曲目与收藏保留。' }
    finally { actionBusy.value = false }
  }
  async function confirmCandidate(candidateId: string): Promise<void> {
    if (actionBusy.value || pendingRelocation.value || relocationUnknown.value || !relocationConfirmed.value || !relocationSelection.value || !candidates.value?.candidates.some(v => v.id === candidateId)) return
    const request = { ...relocationSelection.value, commandId: candidateId, userConfirmed: true as const }, trackId = selectedId.value
    actionBusy.value = true; actionError.value = ''; actionErrorCommandId = null
    const generation = ++actionGeneration
    let binding: Pending<LocalRelocationConfirm> | null = null
    try {
      const datasetId = await captureDataset()
      if (!active || disposed || generation !== actionGeneration) return
      binding = { request, datasetId, generation: ++mutationGeneration, trackId, confirmed: null }; pendingRelocation.value = binding
      await options.api.confirmLocalRelocation(request)
      if (pendingRelocation.value !== binding || disposed) return
      binding.confirmed = 'succeeded'
      if (!active || generation !== actionGeneration) return
      if (datasetId) await refreshOutbox()
      else { pendingRelocation.value = null; candidates.value = null; relocationSelection.value = null; relocationConfirmed.value = false }
      await refreshBusiness()
    } catch {
      if (!disposed && binding && pendingRelocation.value === binding) { relocationUnknown.value = true; actionError.value = relocationUnknownMessage; actionErrorCommandId = request.commandId }
      else if (!binding && active && generation === actionGeneration) actionError.value = '当前工作库暂时无法核对，请先刷新；尚未派发重新定位。'
    }
    finally { actionBusy.value = false }
  }
  return { query, rootId, total, scrollTop, loaded, loading, stale, error, roots, target, targetLabel, rangeWindow, tracks, cachePageCount,
    selectedId, detail, detailLoading, detailStale, detailError, detailReturnTarget, selectedRoot, actionBusy, actionError, titleDraft, pendingOverride, lastPlay,canReadOriginalPlay,readOriginalPlay,
    candidates, relocationSelection, relocationConfirmed, relocationUnknown, pendingRelocation,
    artwork, detailArtwork, organizer, sourceWrites, relocationPlans, selectionMode, selectedTrackIds, selectionError, toggleTrackSelection, clearTrackSelection, openRelocationTrack, openRelocationBatch,
    activate, suspend, dispose, refresh, refreshContext, observeOutbox, search, ensureRange, selectTrack, closeDetail, playTrack, saveTitle, locateSelected, confirmCandidate }
}
