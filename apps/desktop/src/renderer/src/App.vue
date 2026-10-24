<script setup lang="ts">
import { LOCAL_ALBUM_TRACE_PREFIX, readLocalAlbumSafeMarker, copyLocalAlbumSafeTrace } from '../../shared/library-read-trace.js'
import { logLibraryOperation } from '../../../../../packages/bridge-core/src/shared/library-operation-log.js'

import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, shallowReactive, shallowRef, toRaw, watch } from 'vue'
import { restoreRemoteTarget, reconnectRemoteTarget } from './remote-core-preferences.js'

import type {
  PlaybackQualityPreference,
  PublicBridgeState,
  PublicRoonZone,
  RoonLibraryItem,
  RemoteCoreTunnelState,
  TrackSummary,
  LocalPlayAction, LocalPlayRequest, ArtistCatalogPlayRequest,
} from '@music-bridge/contracts'
import * as localWorkbenchDto from '@music-bridge/contracts'
import type { AppInfo } from '../../preload/api.js'
import AlbumAmbientBackground from './components/AlbumAmbientBackground.vue'
import BottomPlayer from './components/BottomPlayer.vue'
import HomeView from './components/HomeView.vue'
import SafeArtwork from './components/SafeArtwork.vue'
import NowPlayingView from './components/NowPlayingView.vue'
import DailyRecommendationsView from './components/views/DailyRecommendationsView.vue'
import SettingsView from './components/settings/SettingsView.vue'
import PlaybackInspector from './components/inspector/PlaybackInspector.vue'
import TrackTable from './components/media/TrackTable.vue'
import SearchEntities from './components/SearchEntities.vue'
import CatalogWorkspace from './components/catalog/CatalogWorkspace.vue'
import type { SidebarSearchSuggestion } from './components/sidebar/sidebar-search-model.js'
import { createCatalogDataAdapter } from './composables/catalog/catalog-data-adapter.js'
import { useCatalogExperience } from './composables/catalog/useCatalogExperience.js'
import { useCatalogAlbumNavigation } from './composables/catalog/useCatalogAlbumNavigation.js'
import type { CatalogItem, CatalogSource } from './composables/catalog/catalog-presentation.js'
import { readCatalogPlaybackPrefix, readCatalogRoonPlaybackPrefix } from './composables/catalog/catalog-playback-selection.js'
import { useCatalogPlaybackRecovery } from './composables/catalog/useCatalogPlaybackRecovery.js'
import LibraryRefreshNotice from './components/LibraryRefreshNotice.vue'
import { createLibraryPageCache } from './composables/libraryPageCache.js'
import { createPlaylistSnapshotLoader } from './composables/playlistSnapshotPagination.js'
import SearchTrackPreview from './components/SearchTrackPreview.vue'
import RoonAlbumGrid from './components/RoonAlbumGrid.vue'
import RoonEntityGrid from './components/RoonEntityGrid.vue'
import FavoriteEntityGrid from './components/FavoriteEntityGrid.vue'
import NeteasePlaylistGrid from './components/NeteasePlaylistGrid.vue'
import { nextRoonPageOffset } from './composables/roonLibraryPagination.js'
import RoonAlbumDetail from './components/RoonAlbumDetail.vue'
import RoonBrowseDetail from './components/RoonBrowseDetail.vue'
import MusicSidebar from './components/sidebar/MusicSidebar.vue'
import CommandOutboxPanel from './components/CommandOutboxPanel.vue'
import { shouldRefreshVisibleRoonCollection } from './roon-collection-lifecycle.js'
import { isCoreRuntimeStable } from './core-readiness.js'
import {
  readPublicIpcErrorCode,
  roonLibraryMessage as formatRoonLibraryMessage,
} from './roonLibraryMessages.js'
import { roonArtworkCache } from './roon-artwork-cache.js'
import type { SidebarSource } from './components/navigation.js'
import { createZoneRefreshCoordinator, resolveZoneLifecycleStatus } from './zone-lifecycle.js'
import { usePlaybackSession, type RoonPlaybackContext } from './composables/application/usePlaybackSession.js'
import { useLocalPlaybackArtwork } from './composables/application/useLocalPlaybackArtwork.js'
import { useAggregatedSearch } from './composables/application/useAggregatedSearch.js'
import { useRoonBrowse } from './composables/application/useRoonBrowse.js'
import { usePageJourney } from './composables/application/usePageJourney.js'
import { useNeteaseLibrary } from './composables/application/useNeteaseLibrary.js'
import { useRendererLifecycle } from './composables/application/useRendererLifecycle.js'
import CollectionView from './components/collection/CollectionView.vue'
import type { CollectionReservationEntry, CollectionReturnLocation, CollectionStartEntry, RecordingPhysicalSelection, RecordingReservationNavigation } from './components/collection/collection-recording-navigation'
import RecordingView from './components/recording/RecordingView.vue'
import LocalLibraryView from './components/library/LocalLibraryView.vue'
import LocalArtworkDialog from './components/library/LocalArtworkDialog.vue'
import LocalOrganizerDialog from './components/library/LocalOrganizerDialog.vue'
import { useLocalLibrary } from './composables/application/useLocalLibrary.js'
import CoverDropView from './components/library/CoverDropView.vue'
import LocalLibraryWorkbench from './components/library/local-workbench/LocalLibraryWorkbench.vue'
import LocalLibrarySettings from './components/settings/LocalLibrarySettings.vue'
import { createCoverDropPageEntry, useLocalAlbumBrowserPages, type CoverDropPageIntent } from './composables/application/local-library-browser/useLocalAlbumBrowser.js'
import { useLocalLibraryWorkbench } from './composables/application/local-library-workbench/controller.js'
import { createLocalWorkbenchRendererPorts, createLocalWorkbenchResultReaders } from './composables/application/local-library-workbench/ports.js'
import { useLocalWorkbenchLibrary } from './composables/application/local-library-workbench/library.js'
import { useLocalWorkbenchLyrics } from './composables/application/local-library-workbench/lyrics.js'
import { localWorkbenchLyricsResultKeyMatches, localWorkbenchLibraryResultKeyMatches, sameLocalWorkbenchLyricsResultKey } from './composables/application/local-library-workbench/types.js'
import type { LocalWorkbenchPorts, LocalWorkbenchExistingAction, LocalWorkbenchAlbumRef, LocalWorkbenchLyricsResultKey, LocalWorkbenchLibraryResultKey, LocalWorkbenchLibraryResultInspection } from './composables/application/local-library-workbench/types.js'
import type { LocalAlbumWorkbenchRequest, LocalAlbumWorkbenchBatchRequest, LocalAlbumWorkbenchBatchTarget } from './components/library/local-browser/presentation.js'


const appInfo = ref<AppInfo | null>(null)
const recordingReloadRequired = ref(false)
const recordingInitialPhysical = ref<RecordingPhysicalSelection>()
const recordingReservationNavigation = ref<RecordingReservationNavigation>()
const collectionReturnLocation = ref<CollectionReturnLocation>()
const recordingViewRef = ref<{ canLeave: () => boolean; navigationContextKey: () => string } | null>(null)
const collectionViewRef = ref<{ canLeave: () => boolean; leaveBlockReason: () => string | null } | null>(null)
const coreState = ref<PublicBridgeState | null>(null)
const coreError = ref(false)
const playback = usePlaybackSession({
  api: window.musicBridge,
  playLocalCatalogSelection: request => {
    if (!window.musicBridgeCatalog) return Promise.reject(Object.assign(new Error('本地艺术家播放入口尚未就绪。'), { outcome: 'not-sent' as const }))
    return window.musicBridgeCatalog.playLocalSelection(request)
  },
  getSelectedZone: () => selectedZone.value,
  getZoneLifecycleStatus: () => zoneLifecycleStatus.value,
  getSelectedQuality: () => selectedQuality.value,
  getMatchResult: trackId => matchResults.value[trackId],
  getPendingMatch: trackId => pendingMatchRequests.get(trackId),
  onMatchTracks: tracks => { void matchTracks(tracks) },
  getRoonPlaybackContext,
  resolveFavoriteDescriptor: item => browse.resolveFavoriteDescriptor(item),
  onEnterNowPlaying: () => journey.enterNowPlaying(),
  clearActionError: () => { actionError.value = null },
  onActionMessage: message => { actionError.value = message },
  onError: recordActionError,
  onToast: showToast,
})
const {
  playbackViewState: playbackState, playbackStartPending, playbackSource, nativeRoonHasNeteaseMatch,
  playbackSyncStatus, playbackClockIdentity,
  lyricsSnapshot, localLyricsMatchState, localLyricsMatchBusy, localLyricsMatchError,
  trackLikeState, localTrackFavoriteDescriptor, currentTrack: sourceCurrentTrack, recentTracks,
  refreshPlayback, selectLocalLyricsMatch, revokeLocalLyricsMatch,
  toggleTrackLike, playTrack, playRoonLibraryTrack, queueRoonLibraryTrack,
  appendTrack, insertTrackNext, replaceAndPlayCollection, appendCollection,
  invalidateCollectionOperation, playQueueItem, editQueueEntry, togglePlayback, stopPlayback,
  nextTrack, previousTrack, seekPlayback, cancelRoonPlaybackPreparation, retryLastPlaybackAction,
} = playback
const localLibrary = useLocalLibrary({ api: window.musicBridge, getSelectedZone: () => selectedZone.value, play: request => playback.playLocalLibrarySelection(request), readPlayReceipt: request => playback.readLocalLibraryPlayReceipt(request), getPlaybackSnapshot: () => playback.playbackState.value,
  getPlaybackAlbum: () => currentView.value === 'coverdrop' ? coverDropBrowser.selectedAlbum.value : currentView.value === 'local-library' && localLibraryViewMode.value === 'albums' ? albumBrowser.selectedAlbum.value : null })
const LocalRelocationDialog = localLibrary.relocationPlans.capable ? defineAsyncComponent(() => import('./components/library/LocalRelocationDialog.vue')) : null
const LocalSourceWritesDialog = localLibrary.sourceWrites.capable ? defineAsyncComponent(() => import('./components/library/LocalSourceWritesDialog.vue')) : null
/** 只读取Preload闭marker；原model错误提示、结果计数、代际与重试全部不变。 */
async function readLocalAlbumWithSafeTrace<T>(action: () => Promise<T>): Promise<T> {
  const startedAtMs = performance.now()
  try { return await action() } catch (error) {
    try {
      const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'message') : undefined
      const safe = descriptor && Object.hasOwn(descriptor, 'value') ? readLocalAlbumSafeMarker(descriptor.value) : null
      if (safe) { const received = copyLocalAlbumSafeTrace({ ...safe, stage: 'renderer.reject', elapsedMs: Math.max(0, performance.now() - startedAtMs) }); if (received) console.info(LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(received)) }
    } catch { /* 安全旁注不能改写原拒绝。 */ }
    throw error
  }
}
async function queryLocalAlbumsWithFlow(request: localWorkbenchDto.LocalAlbumQuery): Promise<localWorkbenchDto.LocalAlbumPage> {
  const started = performance.now()
  logLibraryOperation('ui', 'albums.page', 'start', { offset: request.offset })
  const entry = captureLocalAlbumPageEntry(request)
  try {
    if (!entry) throw new Error('原专辑页面读取已结束。')
    for (;;) {
      // 这里只等Renderer实际就绪，不发送IPC、不续后端期限，也不消费读取失败重试预算。
      await waitLocalAlbumPageReady(entry)
      if (!localAlbumPageEntryCurrent(entry)) throw new Error('原专辑页面读取已结束。')
      if (!localAlbumPageRuntimeReady()) continue
      const generation = localAlbumRecoveryGeneration, contextRead = captureInitialAlbumContextPage(request)
      let page: localWorkbenchDto.LocalAlbumPage
      try { page = await readLocalAlbumWithSafeTrace(() => window.musicBridge.queryLocalAlbums(request)) }
      catch (cause) {
        if (!localAlbumPageEntryCurrent(entry)) throw cause
        // 只舍弃真实换代/切换期间的旧纯读；同代就绪后的原失败仍直接交给model显示。
        if (generation !== localAlbumRecoveryGeneration || !localAlbumPageRuntimeReady()) continue
        throw cause
      }
      if (!localAlbumPageEntryCurrent(entry)) throw new Error('原专辑页面读取已结束。')
      if (generation !== localAlbumRecoveryGeneration || !localAlbumPageRuntimeReady()) continue
      acceptInitialAlbumContextPage(contextRead, request, page)
      logLibraryOperation('ui', 'albums.page', 'complete', { offset: request.offset, count: page.items.length, total: page.total, elapsedMs: Math.max(0, performance.now() - started) })
      return page
    }
  } catch (cause) {
    if (!entry || localAlbumPageEntryCurrent(entry)) logLibraryOperation('ui', 'albums.page', 'error', { offset: request.offset, elapsedMs: Math.max(0, performance.now() - started) })
    throw cause
  }
}
async function readLocalArtworkWithFlow(request: localWorkbenchDto.LocalAlbumArtworkRequest): Promise<localWorkbenchDto.LocalAlbumArtworkReply> {
  const started = performance.now()
  logLibraryOperation('ui', 'artwork.read', 'start')
  try {
    const reply = await readLocalAlbumWithSafeTrace(() => window.musicBridge.getLocalAlbumArtwork(request))
    logLibraryOperation('ui', 'artwork.read', reply.image ? 'complete' : reply.status === 'source-unavailable' ? 'error' : 'miss', { elapsedMs: Math.max(0, performance.now() - started), bytes: reply.grid?.bytes ?? reply.image?.display.bytes ?? 0 })
    return reply
  } catch (cause) {
    logLibraryOperation('ui', 'artwork.read', 'error', { elapsedMs: Math.max(0, performance.now() - started) })
    throw cause
  }
}
async function readLocalAlbumTracksWithFlow(request: localWorkbenchDto.LocalAlbumTrackQuery): Promise<localWorkbenchDto.LocalAlbumTrackPage> {
  const started = performance.now()
  logLibraryOperation('ui', 'albums.tracks', 'start', { offset: request.offset })
  try {
    const page = await readLocalAlbumWithSafeTrace(() => window.musicBridge.getLocalAlbumTracks(request))
    logLibraryOperation('ui', 'albums.tracks', 'complete', { offset: request.offset, count: page.items.length, total: page.total, elapsedMs: Math.max(0, performance.now() - started), slowAfterMs: 100 })
    return page
  } catch (cause) {
    logLibraryOperation('ui', 'albums.tracks', 'error', { offset: request.offset, elapsedMs: Math.max(0, performance.now() - started) })
    throw cause
  }
}
const { localLibrary: albumBrowser, coverDrop: coverDropBrowser } = useLocalAlbumBrowserPages({ api: { queryAlbums: queryLocalAlbumsWithFlow, queryAlbumTracks: readLocalAlbumTracksWithFlow, getArtwork: readLocalArtworkWithFlow } })
const workbenchLyrics = useLocalWorkbenchLyrics({ api: window.musicBridge, readOriginalResultEntry: (key, context) => resultReaders.readLyricsEntry(key, context) })
const workbenchLibrary = useLocalWorkbenchLibrary({ api: window.musicBridge, storage: window.localStorage, canChangeLibrary: () => !workbenchLyrics.pending.value && !localLibrary.maintenanceLocked.value, onChanged: () => { void refreshLocalLibraryFromWorkbench() } })
const { currentTrack } = useLocalPlaybackArtwork({
  getDatasetId: () => workbenchLibrary.state.value?.datasetId ?? localLibrary.displayDatasetId.value,
  isReadReady: () => coreState.value?.runtime === 'ready' && playbackSyncStatus.value === 'ready',
  getClockIdentity: () => playbackClockIdentity.value,
  getSnapshot: () => playback.playbackState.value,
  getTrack: () => sourceCurrentTrack.value,
  getOpenedAlbums: () => [albumBrowser, coverDropBrowser].map(browser => ({ album: browser.selectedAlbum.value, tracks: browser.tracks.value })),
  read: readLocalArtworkWithFlow,
})
const workbenchPorts = shallowReactive<LocalWorkbenchPorts>({})
const workbench = useLocalLibraryWorkbench({ ports: workbenchPorts, saveParticipants: [workbenchLibrary, workbenchLyrics, { pending: localLibrary.maintenanceLocked, locked: localLibrary.maintenanceLocked, save: async () => false, discard: () => !localLibrary.maintenanceLocked.value }] })
const localLibraryViewMode = ref<'albums' | 'tracks'>('albums'), workbenchEntryError = ref(''), workbenchOpening = ref(false)
const localLibrarySelectedTrackId = ref<string | null>(null)
const localLibraryViewRef = ref<{ returnMaintenanceFocus(): void } | null>(null), coverDropViewRef = ref<{ returnMaintenanceFocus(): void; openManagementPanel(action: string): void; isManagementOpen(): boolean } | null>(null)
let maintenanceUiGeneration = 0
let maintenanceUiOpened: { action: LocalWorkbenchExistingAction; datasetId: string; generation: number; albums: string; target: unknown } | null = null
const coverDropPageEntry = createCoverDropPageEntry({
  getView: () => journey.currentView.value,
  isWorkbenchOpen: () => workbench.isOpen.value,
  navigate: () => journey.navigateSource({ type: 'coverdrop' }),
  requestLeave: resume => workbench.requestLeave(resume),
  close: () => workbench.close(),
  open: intent => { void captureWorkbenchTargets(intent) },
})
const libraryResultInspection = shallowRef<LocalWorkbenchLibraryResultInspection | null>(null)
let inspectionGeneration=0,lyricsInspectionSequence=0,libraryInspectionSequence=0,inspectionDisposed=false
let lyricsInspectionController:AbortController|undefined,libraryInspectionController:AbortController|undefined
function lyricsResultKeyCurrent(key:LocalWorkbenchLyricsResultKey):boolean {
  if(inspectionDisposed||!workbench.isOpen.value||workbenchLibrary.state.value?.datasetId!==key.library.datasetId)return false
  if(localWorkbenchLyricsResultKeyMatches(key,workbenchLyrics.job.value,workbenchLyrics.originalJob.value))return true
  const history=workbenchLyrics.jobHistory.value.filter(value=>value.request.commandId===key.jobId)
  return history.length===1&&localWorkbenchLyricsResultKeyMatches(key,history[0]!.latestSnapshot??history[0]!.snapshot,history[0]!.request)
}
const resultReaders=createLocalWorkbenchResultReaders({api:window.musicBridge,datasetId:()=>workbenchLibrary.state.value?.datasetId??null,generation:()=>inspectionGeneration,
  lyricsKeyCurrent:lyricsResultKeyCurrent,libraryKeyCurrent:key=>!inspectionDisposed&&workbench.isOpen.value&&localWorkbenchLibraryResultKeyMatches(key,workbenchLibrary.job.value,workbenchLibrary.originalJob.value)})
function closeLyricsResultInspection():void {lyricsInspectionSequence++;lyricsInspectionController?.abort();lyricsInspectionController=undefined;workbenchLyrics.closeResultInspection()}
function closeLibraryResultInspection():void {libraryInspectionSequence++;libraryInspectionController?.abort();libraryInspectionController=undefined;libraryResultInspection.value=null}
function invalidateResultInspections():void {inspectionGeneration++;closeLyricsResultInspection();closeLibraryResultInspection()}
async function inspectLyricsResult(key:LocalWorkbenchLyricsResultKey):Promise<void> {
  closeLyricsResultInspection();const sequence=lyricsInspectionSequence,expected=structuredClone(toRaw(key)),epoch=inspectionGeneration
  const controller=new AbortController();lyricsInspectionController=controller
  const current=()=>!controller.signal.aborted&&!inspectionDisposed&&sequence===lyricsInspectionSequence&&epoch===inspectionGeneration&&lyricsResultKeyCurrent(expected)
  await workbenchLyrics.inspectOriginalResult(expected)
  if(!current())return
  const inspection=workbenchLyrics.resultInspection.value,entry=inspection?.originalEntry
  if(!inspection||!entry||!sameLocalWorkbenchLyricsResultKey(inspection.key,expected))return
  try {
    const facts=await resultReaders.readLyricsFacts(expected,entry,{signal:controller.signal})
    if(!current())return
    const latest=workbenchLyrics.resultInspection.value
    if(!latest||!sameLocalWorkbenchLyricsResultKey(latest.key,expected)||latest.originalEntry?.scope.captureId!==entry.scope.captureId)return
    // 只合并独立检查事实；原session/保存回执与当前pending由各自原模型保留。
    workbenchLyrics.resultInspection.value={...latest,...facts}
  } catch { if(current()&&workbenchLyrics.resultInspection.value)workbenchLyrics.resultInspection.value={...workbenchLyrics.resultInspection.value,error:'原根的专辑事实尚未核实；原会话和保存请求保留，可继续核对原回执。'} }
}
async function inspectLibraryResult(key:LocalWorkbenchLibraryResultKey):Promise<void> {
  closeLibraryResultInspection();const sequence=libraryInspectionSequence,expected=structuredClone(toRaw(key)),epoch=inspectionGeneration
  const controller=new AbortController();libraryInspectionController=controller
  libraryResultInspection.value={key:expected,phase:'loading',album:null,trackPage:null,capture:null,error:null}
  const current=()=>!controller.signal.aborted&&!inspectionDisposed&&sequence===libraryInspectionSequence&&epoch===inspectionGeneration
    &&workbench.isOpen.value&&localWorkbenchLibraryResultKeyMatches(expected,workbenchLibrary.job.value,workbenchLibrary.originalJob.value)
  try {const value=await resultReaders.readLibraryResult(expected,{signal:controller.signal});if(current())libraryResultInspection.value={key:expected,phase:'ready',...value,error:null}}
  catch {if(current())libraryResultInspection.value={key:expected,phase:'stale',album:null,trackPage:null,capture:null,error:'原任务专辑或捕获尚未核实，原UNKNOWN和回执继续保留。'}}
}
watch(()=>[workbench.isOpen.value,workbenchLibrary.state.value?.datasetId,workbenchLibrary.capture.value,workbenchLyrics.library.value,workbench.readback.value],invalidateResultInspections,{flush:'sync'})
watch(() => [workbench.isOpen.value, workbench.readback.value, workbench.focusedAlbumId.value, workbenchLibrary.state.value?.datasetId], () => { maintenanceUiGeneration++; maintenanceUiOpened = null }, { flush: 'sync' })
let workspaceLoading: Promise<boolean> | null = null, workbenchOpenGeneration = 0
// 首扫原任务观察开始：只读取已存在的任务，页面离开后不保留后台轮询。
type InitialScanJob = import('@music-bridge/contracts').ScanJobRecord
type InitialScanRoot = import('@music-bridge/contracts').LocalRootView['root']
type InitialScanObservation = {
  job: InitialScanJob; signature: string; snapshotBefore: string | null; observedSnapshot: string | null; completed: boolean
  settleAttempts: number; pendingAttempts: number; failures: number; finished: boolean
}
const initialScanObservations = new Map<string, InitialScanObservation>()
const initialScanJobs = shallowRef<readonly InitialScanJob[]>([]), initialScanStatusError = ref('')
function publishInitialScanJobs(): void { initialScanJobs.value = [...initialScanObservations.values()].map(value => value.job) }
const initialScanAttemptedRoots = new Set<string>(), initialScanReceiptCommands = new Set<string>()
const initialScanSnapshotBefore = new Map<string, string | null>()
const initialScanDiscoveryBudgets: { pages: number; rows: number; restarts: number }[] = []
const initialScanUnconfirmed = '扫描状态尚未确认，已保存的音乐与进度保留。请在设置中核对。'
let initialScanEpoch = 0, initialScanDisposed = false, initialScanClosing = false, initialScanDataset: string | undefined
let initialScanTimer: ReturnType<typeof setTimeout> | undefined, initialScanWork: Promise<void> | null = null
let initialScanRefreshQueued = false, initialScanDiscoverQueued = false, initialScanInspectQueued = false, initialScanTimerQueued = false
const initialScanProjectionIntervalMs = 5000
let initialScanProjectionDirty = false, initialScanProjectionAtMs: number | undefined
type LocalAlbumRecovery = {
  generation: number; epoch: number; datasetId: string | undefined; view: 'local-library' | 'coverdrop'
  browser: typeof albumBrowser; query: string; rootId: string | null; filter: localWorkbenchDto.LocalAlbumFilter
}
let localAlbumRecoveryGeneration = 0, localAlbumRecoveryRuntimeReady = false
let localAlbumRecoveryQueued: LocalAlbumRecovery | null = null, localAlbumRecoveryWork: Promise<void> | null = null
const localAlbumRecoveryAttempts = new Map<typeof albumBrowser, number>()
// 首次页面的原model Promise保持加载；真实Core/隧道就绪前不派专辑查询。
type LocalAlbumPageEntry = {
  view: 'local-library' | 'coverdrop'; epoch: number; browser: typeof albumBrowser
  query: string; rootId: string | null; filter: localWorkbenchDto.LocalAlbumFilter
}
function captureLocalAlbumPageEntry(request: localWorkbenchDto.LocalAlbumQuery): LocalAlbumPageEntry | null {
  const view = currentView.value
  if (view !== 'local-library' && view !== 'coverdrop') return null
  return { view, epoch: initialScanEpoch, browser: view === 'local-library' ? albumBrowser : coverDropBrowser,
    query: request.query, rootId: request.rootId, filter: request.filter }
}
function localAlbumPageEntryCurrent(entry: LocalAlbumPageEntry): boolean {
  const state = entry.browser.snapshot.value
  return !initialScanDisposed && !initialScanClosing && currentView.value === entry.view && initialScanEpoch === entry.epoch
    && state.active && state.query === entry.query && state.rootId === entry.rootId && state.filter === entry.filter
}
function localAlbumPageRuntimeReady(): boolean { return isCoreRuntimeStable(coreState.value?.runtime, remoteCoreState.value.status) }
function localAlbumPageRuntimeTerminal(): boolean {
  return (coreState.value?.runtime === 'failed' || coreState.value?.runtime === 'stopped')
    && !['checking', 'starting', 'reconnecting', 'stopping'].includes(remoteCoreState.value.status)
}
function waitLocalAlbumPageReady(entry: LocalAlbumPageEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined
    const inspect = () => {
      if (!localAlbumPageEntryCurrent(entry)) { stop?.(); reject(new Error('原专辑页面读取已结束。')) }
      else if (localAlbumPageRuntimeTerminal()) { stop?.(); reject(new Error('Core 已停止或启动失败，请检查连接后重试。')) }
      else if (localAlbumPageRuntimeReady()) { stop?.(); resolve() }
    }
    // 监听真实状态引用，core.ready即使runtime枚举仍为ready也会在原事件内更新代次。
    stop = watch([() => coreState.value, () => remoteCoreState.value, () => currentView.value, () => entry.browser.snapshot.value], inspect, { flush: 'sync' })
    inspect()
  })
}
// 首次目录/扫描观察排在同代真实专辑页之后；这里只安排纯读，不保存任何许可。
type InitialAlbumContextGate = {
  view: 'local-library' | 'coverdrop'; epoch: number; generation: number; readSerial: number
  pageReady: boolean; released: boolean; refreshRequested: boolean; itemsBefore: readonly unknown[] | null
}
let initialAlbumContextView: InitialAlbumContextGate['view'] | null = null
let initialAlbumContextGate: InitialAlbumContextGate | null = null, initialAlbumContextWarmGeneration = -1
let initialAlbumContextWork: Promise<void> | null = null
function initialAlbumContextCurrent(gate: InitialAlbumContextGate): boolean {
  return initialAlbumContextGate === gate && !initialScanDisposed && !initialScanClosing && currentView.value === gate.view
    && gate.epoch === initialScanEpoch && gate.generation === localAlbumRecoveryGeneration
}
function deferInitialAlbumContextReads(): boolean { return initialAlbumContextGate !== null && !initialAlbumContextGate.released }
function beginInitialAlbumContext(view: string, albumPage: boolean): void {
  initialAlbumContextView = albumPage && (view === 'local-library' || view === 'coverdrop') ? view : null
  initialAlbumContextGate = initialAlbumContextView !== null && initialAlbumContextWarmGeneration !== localAlbumRecoveryGeneration
    ? { view: initialAlbumContextView, epoch: initialScanEpoch, generation: localAlbumRecoveryGeneration, readSerial: 0,
      pageReady: false, released: false, refreshRequested: false, itemsBefore: null } : null
}
function captureInitialAlbumContextPage(request: localWorkbenchDto.LocalAlbumQuery): { gate: InitialAlbumContextGate; serial: number; itemsBefore: readonly unknown[] } | null {
  const gate = initialAlbumContextGate
  if (!gate || gate.released || !initialAlbumContextCurrent(gate) || request.offset !== 0) return null
  const state = (gate.view === 'local-library' ? albumBrowser : coverDropBrowser).snapshot.value
  if (!state.active || !state.initialLoading && !state.refreshing || state.query !== request.query || state.rootId !== request.rootId || state.filter !== request.filter) return null
  gate.pageReady = false
  return { gate, serial: ++gate.readSerial, itemsBefore: state.items }
}
function acceptInitialAlbumContextPage(read: ReturnType<typeof captureInitialAlbumContextPage>, request: localWorkbenchDto.LocalAlbumQuery, page: localWorkbenchDto.LocalAlbumPage): void {
  if (!read || !initialAlbumContextCurrent(read.gate) || read.serial !== read.gate.readSerial || !localWorkbenchDto.isLocalAlbumPage(page, request)) return
  read.gate.pageReady = true; read.gate.itemsBefore = read.itemsBefore
  // 真实model接受页后会发布新items；watch再启动读取，不能凭API回包或旧loaded直接放行。
}
function warmCachedInitialAlbumContext(): void {
  const gate = initialAlbumContextGate
  if (!gate || gate.released || gate.pageReady || gate.refreshRequested || !initialAlbumContextCurrent(gate) || !localAlbumRecoveryRuntimeReady) return
  const browser = gate.view === 'local-library' ? albumBrowser : coverDropBrowser, state = browser.snapshot.value
  if (!state.active || !state.loaded || state.initialLoading || state.refreshing || state.loadingMore) return
  gate.refreshRequested = true
  void browser.refresh()
}
function runInitialAlbumContext(): Promise<void> {
  if (initialAlbumContextWork) return initialAlbumContextWork
  const gate = initialAlbumContextGate
  if (!gate || gate.released || !gate.pageReady || !initialAlbumContextCurrent(gate)) return Promise.resolve()
  const state = (gate.view === 'local-library' ? albumBrowser : coverDropBrowser).snapshot.value
  const allowed = () => initialAlbumContextCurrent(gate) && !workbenchLibrary.pending.value && !workbenchLibrary.writing.value
    && !workbenchLibrary.addingLibrary.value && !workbenchLibrary.busy.value && !localLibrary.maintenanceLocked.value
  if (!state.active || !state.loaded || state.items === gate.itemsBefore || state.initialLoading || state.refreshing || state.loadingMore
    || state.error || state.refreshError || !allowed()) return Promise.resolve()
  let settledNormally = false
  const work = (async () => {
    await localLibrary.activate({ deferTrackReads: true })
    if (!allowed()) return
    await loadWorkspace()
    if (!allowed()) return
    gate.released = true; initialAlbumContextWarmGeneration = gate.generation
    await requestInitialScanRefresh(false)
  })().then(() => { settledNormally = true }).finally(() => {
    if (initialAlbumContextWork === work) initialAlbumContextWork = null
    if (settledNormally && initialAlbumContextGate?.pageReady && !initialAlbumContextGate.released) void runInitialAlbumContext()
  })
  initialAlbumContextWork = work
  return work
}
// 设置只补首次普通库读取；不消费任何未知写入或名称设置恢复。
type LocalSettingsReadRecovery = { generation: number; epoch: number }
let localSettingsReadRecoveryQueued: LocalSettingsReadRecovery | null = null, localSettingsReadRecoveryWork: Promise<void> | null = null
let localSettingsReadRecoveryAttempts = 0
// 扫描只读观察的恢复独立于封面墙loaded；每个真实Core代最多两次，不生成额外轮询或写入。
type InitialScanReadRecovery = { generation: number; epoch: number; datasetId: string | undefined; view: string }
let initialScanReadRecoveryAttempts = 0, initialScanReadFailureSerial = 0
let initialScanReadRecoveryQueued: InitialScanReadRecovery | null = null, initialScanReadRecoveryWork: Promise<void> | null = null
function initialScanReadRecoveryCurrent(read: InitialScanReadRecovery): boolean {
  return initialScanCurrent(read.epoch, read.datasetId) && read.generation === localAlbumRecoveryGeneration && localAlbumRecoveryRuntimeReady
    && currentView.value === read.view && workbenchLibrary.state.value?.datasetId === read.datasetId
}
function runInitialScanReadRecovery(): Promise<void> {
  if (initialScanReadRecoveryWork) return initialScanReadRecoveryWork
  const read = initialScanReadRecoveryQueued
  if (!read) return Promise.resolve()
  initialScanReadRecoveryQueued = null
  const allowed = () => initialScanReadRecoveryCurrent(read) && initialScanStatusError.value === initialScanUnconfirmed
    && !deferInitialAlbumContextReads() && !workbenchLibrary.pending.value && !workbenchLibrary.writing.value && !workbenchLibrary.addingLibrary.value && initialScanReadRecoveryAttempts < 2
  if (!allowed()) return Promise.resolve()
  const work = (async () => {
    // 先join原读取的真实尾部；health在途只留下一个令牌，不与原root/page/get并发。
    const previous = initialScanWork
    if (previous) await previous
    if (!allowed()) return
    initialScanReadRecoveryAttempts++
    await requestInitialScanRefresh(false)
  })().finally(() => {
    if (initialScanReadRecoveryWork === work) initialScanReadRecoveryWork = null
    if (initialScanReadRecoveryQueued) return runInitialScanReadRecovery()
  })
  initialScanReadRecoveryWork = work
  return work
}
function runLocalSettingsReadRecovery(): Promise<void> {
  if (localSettingsReadRecoveryWork) return localSettingsReadRecoveryWork
  const read = localSettingsReadRecoveryQueued
  if (!read) return Promise.resolve()
  if (!initialScanCurrent(read.epoch) || read.generation !== localAlbumRecoveryGeneration || !localAlbumRecoveryRuntimeReady || currentView.value !== 'settings'
    || workbenchLibrary.state.value !== null || !workbenchLibrary.readFailed.value || workbenchLibrary.pending.value || workbenchLibrary.writing.value || workbenchLibrary.addingLibrary.value
    || localSettingsReadRecoveryAttempts >= 2) { localSettingsReadRecoveryQueued = null; return Promise.resolve() }
  // 新Core事件在原read在途时只留下一个令牌；原busy解除后再核门禁，不轮询也不并发。
  if (workbenchLibrary.busy.value) return Promise.resolve()
  localSettingsReadRecoveryQueued = null; localSettingsReadRecoveryAttempts++
  const work = workbenchLibrary.read().then(() => undefined).finally(() => {
    if (localSettingsReadRecoveryWork === work) localSettingsReadRecoveryWork = null
    if (localSettingsReadRecoveryQueued) return runLocalSettingsReadRecovery()
  })
  localSettingsReadRecoveryWork = work
  return work
}
function localAlbumRecoveryCurrent(read: LocalAlbumRecovery): boolean {
  const state = read.browser.snapshot.value
  return initialScanCurrent(read.epoch) && read.generation === localAlbumRecoveryGeneration && localAlbumRecoveryRuntimeReady
    && currentView.value === read.view && workbenchLibrary.state.value?.datasetId === read.datasetId && state.active
    && state.query === read.query && state.rootId === read.rootId && state.filter === read.filter
}
function runLocalAlbumRecovery(): Promise<void> {
  if (localAlbumRecoveryWork) return localAlbumRecoveryWork
  localAlbumRecoveryWork = (async () => {
    while (localAlbumRecoveryQueued) {
      const read = localAlbumRecoveryQueued; localAlbumRecoveryQueued = null
      const state = read.browser.snapshot.value, attempts = localAlbumRecoveryAttempts.get(read.browser) ?? 0
      if (!localAlbumRecoveryCurrent(read) || attempts >= 2) continue
      if (state.loaded) {
        if (deferInitialAlbumContextReads() || !localLibrary.rootsError.value) continue
        // 专辑首屏成功不能遮住独立失败的目录读取；仍只消费真实Core事件和原每代预算。
        localAlbumRecoveryAttempts.set(read.browser, attempts + 1)
        await localLibrary.refreshContext()
        continue
      }
      if (state.status !== 'error' || state.initialLoading || state.refreshing || state.loadingMore) continue
      localAlbumRecoveryAttempts.set(read.browser, attempts + 1)
      // 只重读未成功的首屏；失败仍由原model保留错误，后续重试必须有新的真实Core事件。
      await read.browser.refresh()
      if (localAlbumRecoveryCurrent(read) && read.browser.snapshot.value.loaded && !deferInitialAlbumContextReads()) {
        if (localLibrary.error.value && !localLibrary.loaded.value) await localLibrary.refresh()
        else if (localLibrary.rootsError.value) await localLibrary.refreshContext()
      }
    }
  })().finally(() => {
    localAlbumRecoveryWork = null
    if (localAlbumRecoveryQueued) return runLocalAlbumRecovery()
  })
  return localAlbumRecoveryWork
}
function observeLocalAlbumCoreRecovery(event: 'core.ready' | 'core.health', runtimeReady: boolean): void {
  if (initialScanDisposed || initialScanClosing) return
  if (event === 'core.ready' || localAlbumRecoveryRuntimeReady && !runtimeReady) {
    localAlbumRecoveryGeneration++; localAlbumRecoveryAttempts.clear(); localAlbumRecoveryQueued = null
    initialAlbumContextWarmGeneration = -1
    if (initialAlbumContextView) { beginInitialAlbumContext(initialAlbumContextView, true); void localLibrary.activate({ deferTrackReads: true, deferContextReads: true }) }
    localSettingsReadRecoveryAttempts = 0; localSettingsReadRecoveryQueued = null
    initialScanReadRecoveryAttempts = 0; initialScanReadRecoveryQueued = null
  }
  localAlbumRecoveryRuntimeReady = runtimeReady
  if (runtimeReady) warmCachedInitialAlbumContext()
  if (!runtimeReady) {
    // 即使Renderer尚未见过ready，明确的未就绪事件也要撤销已捕获的旧页令牌。
    initialAlbumContextWarmGeneration = -1
    if (initialAlbumContextView) { beginInitialAlbumContext(initialAlbumContextView, true); void localLibrary.activate({ deferTrackReads: true, deferContextReads: true }) }
    localAlbumRecoveryQueued = null; localSettingsReadRecoveryQueued = null; initialScanReadRecoveryQueued = null; return
  }
  const view = currentView.value
  if (initialScanRelated(view) && initialScanStatusError.value === initialScanUnconfirmed) {
    initialScanReadRecoveryQueued = { generation: localAlbumRecoveryGeneration, epoch: initialScanEpoch,
      datasetId: workbenchLibrary.state.value?.datasetId, view }
    void runInitialScanReadRecovery()
  }
  if (view === 'settings') {
    if (workbenchLibrary.state.value === null && workbenchLibrary.readFailed.value) {
      localSettingsReadRecoveryQueued = { generation: localAlbumRecoveryGeneration, epoch: initialScanEpoch }
      void runLocalSettingsReadRecovery()
    }
    return
  }
  if (view !== 'local-library' && view !== 'coverdrop') return
  const browser = view === 'local-library' ? albumBrowser : coverDropBrowser, state = browser.snapshot.value
  localAlbumRecoveryQueued = { generation: localAlbumRecoveryGeneration, epoch: initialScanEpoch, datasetId: workbenchLibrary.state.value?.datasetId,
    view, browser, query: state.query, rootId: state.rootId, filter: state.filter }
  void runLocalAlbumRecovery()
}
function initialScanRelated(view: string | undefined): boolean { return view === 'local-library' || view === 'coverdrop' || view === 'settings' }
function initialScanCurrent(epoch: number, datasetId?: string): boolean {
  return !initialScanDisposed && !initialScanClosing && epoch === initialScanEpoch && initialScanRelated(currentView.value)
    && (datasetId === undefined || workbenchLibrary.state.value?.datasetId === datasetId && initialScanDataset === datasetId)
}
function initialScanRootKey(root: InitialScanRoot): string { return JSON.stringify([root.id, root.sourceRootId, root.revision]) }
function initialScanMatches(job: InitialScanJob, root: InitialScanRoot, datasetId: string): boolean {
  return job.datasetId === datasetId && job.libraryRootId === root.id && job.sourceRootId === root.sourceRootId && job.rootRevision === root.revision
}
function initialScanNotConfirmed(): void { initialScanReadFailureSerial++; initialScanStatusError.value = initialScanUnconfirmed; if (!workbenchLibrary.notice.value || workbenchLibrary.notice.value === initialScanUnconfirmed) workbenchLibrary.notice.value = initialScanUnconfirmed }
function stopInitialScanObservation(closing = false): void {
  localSettingsReadRecoveryQueued = null
  initialScanReadRecoveryQueued = null; initialScanReadRecoveryAttempts = 0
  initialScanEpoch++; initialScanClosing ||= closing
  if (initialAlbumContextView && initialScanRelated(currentView.value) && !initialScanClosing) {
    initialAlbumContextWarmGeneration = -1; beginInitialAlbumContext(initialAlbumContextView, true)
    void localLibrary.activate({ deferTrackReads: true, deferContextReads: true })
  } else initialAlbumContextGate = null
  clearTimeout(initialScanTimer); initialScanTimer = undefined; initialScanDataset = undefined
  localAlbumRecoveryQueued = null
  initialScanObservations.clear(); initialScanAttemptedRoots.clear(); initialScanReceiptCommands.clear(); initialScanSnapshotBefore.clear(); initialScanDiscoveryBudgets.length = 0
  initialScanJobs.value = []; initialScanStatusError.value = ''
  initialScanRefreshQueued = initialScanDiscoverQueued = initialScanInspectQueued = initialScanTimerQueued = false
  initialScanProjectionDirty = false; initialScanProjectionAtMs = undefined
}
async function readInitialScanLibrary(epoch: number, datasetId?: string): Promise<boolean> {
  if (!initialScanCurrent(epoch, datasetId) || deferInitialAlbumContextReads() || workbenchLibrary.busy.value) return false
  const before = workbenchLibrary.state.value
  // busy核对到原read同步受理之间没有await；另一旧read不能冒充本次新鲜读取。
  const reading = workbenchLibrary.read()
  await reading
  const next = workbenchLibrary.state.value
  return initialScanCurrent(epoch, datasetId) && next !== null && next !== before && !workbenchLibrary.error.value
    && (datasetId === undefined || next.datasetId === datasetId)
}
async function discoverInitialScanJobs(epoch: number, datasetId: string, roots: readonly InitialScanRoot[]): Promise<void> {
  const remember = (job: InitialScanJob, root: InitialScanRoot) => {
    if (!initialScanCurrent(epoch, datasetId) || !initialScanMatches(job, root, datasetId)) return
    const original = initialScanObservations.get(job.jobId)
    if (original) { if (job.jobRevision !== original.job.jobRevision || job.phase !== original.job.phase) original.finished = false; return }
    // 每个根只跟随最新扫描；旧终态不能遮住设置里刚启动或恢复的任务。
    for (const [id, observation] of initialScanObservations) if (observation.job.libraryRootId === root.id) initialScanObservations.delete(id)
    initialScanObservations.set(job.jobId, { job, signature: '', snapshotBefore: initialScanSnapshotBefore.get(root.id) ?? null, observedSnapshot: null,
      completed: false, settleAttempts: 0, pendingAttempts: 0, failures: 0, finished: false })
    publishInitialScanJobs()
  }
  // 这里只使用真正的导入原命令；AI/CUE的job/originalJob不属于扫描任务。
  for (const operation of workbenchLibrary.operations.value) {
    if (operation.kind !== 'library.import.confirm' || operation.state !== 'succeeded' || initialScanReceiptCommands.has(operation.commandId)
      || !workbenchLibrary.originals.value.some(value => value.command === 'library.import.confirm' && value.payload.commandId === operation.commandId)) continue
    initialScanReceiptCommands.add(operation.commandId)
    try {
      const receipt = await window.musicBridge.localLibraryScan('localScan.receipt', { commandId: operation.commandId })
      if (!initialScanCurrent(epoch, datasetId)) return
      if (!receipt || !localWorkbenchDto.isLocalScanReceipt(receipt) || receipt.commandId !== operation.commandId || receipt.operation !== 'start') continue
      const root = roots.find(value => operation.libraryIds.includes(value.id) && initialScanMatches(receipt.result, value, datasetId))
      if (root) remember(receipt.result, root)
    } catch { if (!initialScanCurrent(epoch, datasetId)) return }
  }
  const targets = roots.filter(root => !initialScanAttemptedRoots.has(initialScanRootKey(root))
    && ![...initialScanObservations.values()].some(value => !value.finished && initialScanMatches(value.job, root, datasetId)))
  if (!targets.length) return
  for (const root of targets) initialScanAttemptedRoots.add(initialScanRootKey(root))
  const budget = { pages: 0, rows: 0, restarts: 0 }; initialScanDiscoveryBudgets.push(budget)
  const page = async (offset: number, limit: number) => {
    if (!initialScanCurrent(epoch, datasetId) || budget.pages >= 50) throw new Error('扫描发现预算已结束。')
    budget.pages++
    const result = await window.musicBridge.localLibraryScan('localScan.page', { offset, limit })
    if (!initialScanCurrent(epoch, datasetId) || !localWorkbenchDto.isLocalScanPage(result) || result.offset !== offset || result.limit !== limit) throw new Error('扫描分页未确认。')
    budget.rows += result.items.length
    if (budget.rows > 10_000) throw new Error('扫描发现行数已结束。')
    return result
  }
  try {
    for (;;) {
      const head = await page(0, 1), total = head.total, found = new Map<string, InitialScanJob>(), seen = new Set<string>()
      let changed = false
      // 原page按rowid升序；从尾页向前查，不能把末200项当完整清单。
      for (let offset = total ? Math.floor((total - 1) / 200) * 200 : 0;; offset = Math.max(0, offset - 200)) {
        const current = await page(offset, 200)
        if (current.total !== total) { changed = true; break }
        for (const job of [...current.items].reverse()) {
          if (seen.has(job.jobId) || job.datasetId !== datasetId) throw new Error('扫描分页身份未确认。')
          seen.add(job.jobId)
          for (const root of targets) if (!found.has(root.id) && initialScanMatches(job, root, datasetId)) found.set(root.id, job)
        }
        if (found.size === targets.length || offset === 0) break
      }
      if (!changed) changed = (await page(0, 1)).total !== total
      if (changed) { if (budget.restarts >= 1) throw new Error('扫描清单持续变化。'); budget.restarts++; continue }
      for (const root of targets) {
        const job = found.get(root.id)
        if (job) remember(job, root)
        else { initialScanAttemptedRoots.delete(initialScanRootKey(root)); initialScanNotConfirmed() }
      }
      return
    }
  } catch {
    if (initialScanCurrent(epoch, datasetId)) {
      // 失败的只读发现没有资格封死此root；下次真实Core事件可重新取得原分页证明。
      for (const root of targets) initialScanAttemptedRoots.delete(initialScanRootKey(root))
      initialScanNotConfirmed()
    }
  }
}
function scheduleInitialScanObservation(): void {
  if (!initialScanCurrent(initialScanEpoch, initialScanDataset) || ![...initialScanObservations.values()].some(value => !value.finished)) {
    clearTimeout(initialScanTimer); initialScanTimer = undefined; return
  }
  if (initialScanTimer !== undefined) return
  const failures = Math.max(0, ...[...initialScanObservations.values()].filter(value => !value.finished).map(value => value.failures))
  const delay = Math.min(15_000, 1500 * 2 ** Math.min(4, failures))
  initialScanTimer = setTimeout(() => {
    initialScanTimer = undefined; initialScanInspectQueued = initialScanTimerQueued = true; void runInitialScanRefresh()
  }, initialScanProjectionDirty && initialScanProjectionAtMs !== undefined
    ? Math.min(delay, Math.max(1, initialScanProjectionAtMs + initialScanProjectionIntervalMs - Date.now())) : delay)
}
async function initialScanRefreshCycle(refresh: boolean, discover: boolean, inspect: boolean, timerTick: boolean): Promise<void> {
  if (initialScanDisposed || initialScanClosing || deferInitialAlbumContextReads()) return
  const epoch = initialScanEpoch, readGeneration = localAlbumRecoveryGeneration, failureSerial = initialScanReadFailureSerial
  if (!initialScanRelated(currentView.value)) return
  for (const library of workbenchLibrary.state.value?.libraries ?? []) if (!initialScanSnapshotBefore.has(library.libraryId)) initialScanSnapshotBefore.set(library.libraryId, library.latestSnapshotId)
  if (!initialScanDataset && !await readInitialScanLibrary(epoch)) {
    if (initialScanCurrent(epoch)) {
      // busy只表示本次还未取得新鲜计数；原read自己的error和页面stale继续保留。
      if (refresh) await Promise.all([albumBrowser.refresh(), coverDropBrowser.refresh(), localLibrary.refresh()])
    }
    return
  }
  const datasetId = initialScanDataset ?? workbenchLibrary.state.value?.datasetId
  if (!datasetId || !initialScanCurrent(epoch)) return
  initialScanDataset = datasetId
  let projectionImmediate = false
  let roots: readonly InitialScanRoot[] = []
  try {
    const views = await window.musicBridge.listLocalLibraryRoots()
    if (!initialScanCurrent(epoch, datasetId)) return
    if (views.length > 100 || !views.every(localWorkbenchDto.isLocalRootView)) throw new Error('目录身份未确认。')
    roots = views.filter(value => value.root.role === 'library').map(value => value.root)
    if (discover) await discoverInitialScanJobs(epoch, datasetId, roots)
  } catch {
    if (!initialScanCurrent(epoch, datasetId)) return
    for (const value of initialScanObservations.values()) if (!value.finished) value.failures++
    initialScanNotConfirmed(); return
  }
  if (!initialScanCurrent(epoch, datasetId)) return
  if (inspect || discover) for (const observation of initialScanObservations.values()) {
    if (observation.finished) continue
    const root = roots.find(value => initialScanMatches(observation.job, value, datasetId))
    if (!root) { observation.finished = true; initialScanNotConfirmed(); continue }
    try {
      const job = await window.musicBridge.localLibraryScan('localScan.get', { jobId: observation.job.jobId })
      if (!initialScanCurrent(epoch, datasetId)) return
      const currentRoots = await window.musicBridge.listLocalLibraryRoots()
      if (!initialScanCurrent(epoch, datasetId)) return
      if (!currentRoots.some(value => localWorkbenchDto.isLocalRootView(value) && initialScanMatches(observation.job, value.root, datasetId))) {
        observation.finished = true; initialScanNotConfirmed(); continue
      }
      if (!localWorkbenchDto.isScanJobRecord(job) || job.jobId !== observation.job.jobId || !initialScanMatches(job, root, datasetId)
        || observation.completed && job.phase !== 'completed') throw new Error('原扫描任务身份未确认。')
      const previousJob = observation.job
      observation.failures = 0; observation.job = job; publishInitialScanJobs()
      const signature = JSON.stringify([job.jobRevision, job.phase, job.progress, job.checkpointRef, job.failureCode])
      if (signature !== observation.signature) {
        observation.signature = signature
        // 首批与终态立即显示；扫描中间批次合并到五秒窗口，进度条仍使用每次真实观察。
        if (job.progress.accepted !== previousJob.progress.accepted || job.phase !== previousJob.phase) {
          initialScanProjectionDirty = true
          projectionImmediate ||= previousJob.progress.accepted === '0' && job.progress.accepted !== '0'
            || job.phase !== 'running' && job.phase !== 'pending'
        }
        const count = (value: string) => Math.min(Number.MAX_SAFE_INTEGER, Number(value))
        logLibraryOperation('ui', 'scan.updated', job.phase === 'failed' ? 'error' : job.phase === 'completed' ? 'complete' : job.phase === 'paused' ? 'paused' : job.phase === 'cancelled' ? 'cancelled' : 'progress',
          { visited: count(job.progress.visited), accepted: count(job.progress.accepted), rejected: count(job.progress.rejected), code: job.failureCode ?? job.phase.toUpperCase() })
      }
      if (job.phase === 'completed') {
        if (!observation.completed) observation.completed = true
        else if (timerTick) observation.settleAttempts++
      } else if (job.phase === 'pending') {
        if (timerTick) observation.pendingAttempts++
      } else if (job.phase !== 'running') { observation.finished = true; initialScanProjectionDirty = true; projectionImmediate = true }
    } catch { if (!initialScanCurrent(epoch, datasetId)) return; observation.failures++; initialScanNotConfirmed() }
  }
  if (!initialScanCurrent(epoch, datasetId)) return
  refresh ||= initialScanProjectionDirty && (projectionImmediate || initialScanProjectionAtMs === undefined
    || Date.now() - initialScanProjectionAtMs >= initialScanProjectionIntervalMs)
  // 完成后只补齐一次真实库读取；busy或失败可重试，不重复刷新已读过的专辑墙。
  const finalReadPending = [...initialScanObservations.values()].some(value => value.completed && !value.finished)
  const fresh = refresh || finalReadPending ? await readInitialScanLibrary(epoch, datasetId) : false
  if (!initialScanCurrent(epoch, datasetId)) return
  if (refresh) {
    initialScanProjectionDirty = false; initialScanProjectionAtMs = Date.now()
    await Promise.all([albumBrowser.refresh(), coverDropBrowser.refresh(), localLibrary.refresh()])
  }
  if (!initialScanCurrent(epoch, datasetId)) return
  for (const observation of initialScanObservations.values()) if (observation.completed && !observation.finished) {
    const library = fresh ? workbenchLibrary.state.value?.libraries.find(value => value.libraryId === observation.job.libraryRootId) : undefined
    // 公开ID仅指最后成功快照，即使变化也没有本次job对应，不能升级成本次ready。
    // 停止观察只表示完成态与本次读取已核实，不把最后成功ID冒充本job的完成快照。
    if (library) { observation.observedSnapshot = library.latestSnapshotId; observation.finished = true }
  }
  // 只在同Core代完整成功周期之后清本观察的提示；重试受理/部分读取不能暂时抹掉红字。
  if (initialScanCurrent(epoch, datasetId) && readGeneration === localAlbumRecoveryGeneration && failureSerial === initialScanReadFailureSerial
    && roots.every(root => [...initialScanObservations.values()].some(observation => initialScanMatches(observation.job, root, datasetId)))
    && [...initialScanObservations.values()].every(observation => observation.finished || observation.failures === 0)
    && (!(refresh || finalReadPending) || fresh)) {
    initialScanStatusError.value = ''
    if (workbenchLibrary.notice.value === initialScanUnconfirmed) workbenchLibrary.notice.value = ''
  }
}
function runInitialScanRefresh(): Promise<void> {
  if (initialScanWork) return initialScanWork
  initialScanWork = (async () => {
    while (initialScanRefreshQueued || initialScanDiscoverQueued || initialScanInspectQueued || initialScanTimerQueued) {
      const flags = [initialScanRefreshQueued, initialScanDiscoverQueued, initialScanInspectQueued, initialScanTimerQueued] as const
      initialScanRefreshQueued = initialScanDiscoverQueued = initialScanInspectQueued = initialScanTimerQueued = false
      try { await initialScanRefreshCycle(...flags) } catch { if (initialScanCurrent(initialScanEpoch, initialScanDataset)) initialScanNotConfirmed() }
    }
  })().finally(() => {
    initialScanWork = null
    if (initialScanRefreshQueued || initialScanDiscoverQueued || initialScanInspectQueued || initialScanTimerQueued) return runInitialScanRefresh()
    scheduleInitialScanObservation()
  })
  return initialScanWork
}
function requestInitialScanRefresh(refresh = true): Promise<void> {
  if (initialScanDisposed || initialScanClosing || deferInitialAlbumContextReads() || !initialScanRelated(currentView.value)) return Promise.resolve()
  initialScanAttemptedRoots.clear()
  initialScanRefreshQueued ||= refresh
  initialScanDiscoverQueued = true
  return runInitialScanRefresh()
}
async function refreshLocalLibraryFromWorkbench(): Promise<void> {
  // 已确认写入的原业务动作独立执行，不能被只读观察的离页/换代清空。
  await Promise.all([albumBrowser.invalidateArtwork(), coverDropBrowser.invalidateArtwork(), localLibrary.refresh()])
  await requestInitialScanRefresh()
}
async function refreshLocalBrowserViews(): Promise<void> { await requestInitialScanRefresh() }
function closeInitialScanObservation(): void { albumBrowser.deactivate(); coverDropBrowser.deactivate(); stopInitialScanObservation(true) }
function installInitialScanObservationLifecycle(): void {
  watch([() => albumBrowser.snapshot.value, () => coverDropBrowser.snapshot.value, () => workbenchLibrary.busy.value,
    () => workbenchLibrary.pending.value, () => workbenchLibrary.writing.value, () => workbenchLibrary.addingLibrary.value, () => localLibrary.maintenanceLocked.value], () => {
    warmCachedInitialAlbumContext(); void runInitialAlbumContext()
  }, { flush: 'post' })
  watch(() => workbenchLibrary.busy.value, busy => { if (!busy && localSettingsReadRecoveryQueued) void runLocalSettingsReadRecovery() }, { flush: 'sync' })
  watch([() => currentView.value, () => workbenchLibrary.state.value?.datasetId], ([view, datasetId]) => {
    if (!initialScanRelated(view)) { stopInitialScanObservation(); return }
    if (initialScanDataset !== undefined && datasetId !== initialScanDataset) stopInitialScanObservation()
    initialScanDataset = datasetId
    void requestInitialScanRefresh(false)
  }, { flush: 'sync' })
  onMounted(() => { window.addEventListener('pagehide', closeInitialScanObservation); if (initialScanRelated(currentView.value)) void requestInitialScanRefresh(false) })
  onUnmounted(() => { initialScanDisposed = true; closeInitialScanObservation(); window.removeEventListener('pagehide', closeInitialScanObservation) })
}
// 首扫原任务观察结束。
async function loadWorkspace(): Promise<boolean> {
  if (workspaceLoading) return workspaceLoading
  workspaceLoading = (async () => {
    try {
      const capabilities = await window.musicBridge.localWorkbenchCapabilities()
      const confirmed = await Promise.all([workbenchLibrary.read(), workbenchLibrary.readNameSettings()])
      if (!confirmed.every(value => value === true)) return false
      Object.assign(workbenchPorts, createLocalWorkbenchRendererPorts({ api: window.musicBridge, capabilities, openExistingAction: request => openOriginalMaintenance(request.action, request.albums), localExistingRoutes: {
        datasetId: () => workbenchLibrary.state.value?.datasetId ?? null,
        generation: () => maintenanceUiGeneration,
        current: () => currentView.value === 'coverdrop' && !!coverDropViewRef.value && workbench.isOpen.value
          && !!workbenchLibrary.state.value?.datasetId && (!workbench.readback.value || workbench.readback.value.datasetId === workbenchLibrary.state.value.datasetId),
        availability: localMaintenanceAvailability,
        opened: localMaintenanceOpened,
      } }))
      return true
    } catch { return false }
  })()
  try { return await workspaceLoading } finally { workspaceLoading = null }
}
async function captureWorkbenchTargets(intent: CoverDropPageIntent): Promise<void> {
  if (currentView.value !== 'coverdrop') return
  const { albums: targets, action } = intent
  const owner = ++workbenchOpenGeneration
  workbenchOpening.value = true; workbenchEntryError.value = ''
  const readFailureMessages = {
    initialization: '整理入口尚未就绪，尚未准备任何写入。请重新读取。',
    capture: '完整专辑捕获未获确认，尚未准备任何写入。请重新读取。',
    workspace: '专辑工作区打开未获确认，尚未准备任何写入。请重新读取。',
    context: '音乐库读取未获确认，尚未准备任何写入。请重新读取。',
  } as const
  let failureStage: keyof typeof readFailureMessages = 'initialization'
  try {
    if (!await loadWorkspace()) throw new Error('整理入口尚未就绪。')
    if (owner !== workbenchOpenGeneration || currentView.value !== 'coverdrop') return
    const datasetId = workbenchLibrary.state.value?.datasetId
    if (!datasetId) throw new Error('工作库读取尚未确认。')
    if (!targets.length) {
      failureStage = 'workspace'
      workbench.openLibrary()
      failureStage = 'context'
      const selected = workbenchLibrary.selectedLibraryIds.value.length > 0
      const capture = await workbenchLibrary.captureLibraries()
      if (owner !== workbenchOpenGeneration || currentView.value !== 'coverdrop') return
      if (workbenchLibrary.state.value?.datasetId !== datasetId || capture && capture.datasetId !== datasetId || selected && !capture) throw new Error('音乐库读取尚未确认。')
      if (capture?.lyricsLibraries.length === 1) workbenchLyrics.bind(null, capture.lyricsLibraries[0]!)
      return
    }
    // 每张专辑都由唯一Owner完整捕获；代表曲目与当前页不充作完整trackIds。
    const descriptors = targets.map(target => ({ albumId: target.albumKey, rootId: target.rootId, revision: target.revision }))
    failureStage = 'capture'
    const captured = descriptors.length === 1
      ? await window.musicBridge.localLibraryManagement('library.album.capture', descriptors[0]!)
      : await window.musicBridge.localLibraryManagement('library.albums.capture', { albums: descriptors })
    if (owner !== workbenchOpenGeneration || currentView.value !== 'coverdrop') return
    if (captured.datasetId !== datasetId || workbenchLibrary.state.value?.datasetId !== datasetId) throw new Error('完整专辑所属工作库已变化。')
    const albums = captured.albums.map(value => value.album)
    failureStage = 'workspace'
    await workbench.open({ action, albums }, captured)
    if (owner !== workbenchOpenGeneration || currentView.value !== 'coverdrop') return
    if (!workbench.isOpen.value || workbench.readback.value?.datasetId !== datasetId
      || workbench.readback.value.snapshotId !== captured.snapshotId) throw new Error('完整专辑读取尚未确认。')
    failureStage = 'context'
    if (workbenchLibrary.state.value?.datasetId !== datasetId) throw new Error('音乐库读取尚未确认。')
    // 专辑已有作者的完整readToken；打开它不预先捕获整个音乐库。
    bindWorkbenchLyrics()
  } catch { if (owner === workbenchOpenGeneration) {
    workbenchEntryError.value = readFailureMessages[failureStage]
    workbench.error.value = workbenchEntryError.value
  } } finally { if (owner === workbenchOpenGeneration) workbenchOpening.value = false }
}
function openAlbumWorkbench(request: LocalAlbumWorkbenchRequest): void {
  if (!request.albumId) {
    coverDropPageEntry.request({ action: request.action, albums: [] })
    return
  }
  const browser = currentView.value === 'coverdrop' ? coverDropBrowser : albumBrowser
  const album = browser.items.value.find(value => value.id === request.albumId) ?? (browser.selectedAlbum.value?.id === request.albumId ? browser.selectedAlbum.value : null)
  if (!album) { ++workbenchOpenGeneration; workbenchOpening.value = false; workbenchEntryError.value = '所选专辑当前不在读取结果中，请刷新后重新打开。'; return }
  coverDropPageEntry.request({ albums: [{ albumKey: album.id, rootId: album.rootId, revision: album.revision, kind: album.kind, title: album.title, artists: album.artists, editionId: album.editionId, representativeTrackId: album.representativeTrackId }], action: request.action, focusedAlbum: album })
}
function openAlbumWorkbenchBatch(request: LocalAlbumWorkbenchBatchRequest): void {
  const browser = currentView.value === 'coverdrop' ? coverDropBrowser : albumBrowser, first = request.albums[0]
  const focusedAlbum = browser.items.value.find(value => value.id === first?.albumKey && value.rootId === first.rootId && value.revision === first.revision)
  coverDropPageEntry.request({ albums: request.albums, action: request.action, ...(focusedAlbum ? { focusedAlbum } : {}) })
}
function bindWorkbenchLyrics(): void {
  const album = workbench.focusedAlbum.value, dataset = workbench.readback.value?.datasetId
  const capture = workbenchLibrary.capture.value
  const library = capture && capture.datasetId === dataset ? capture.lyricsLibraries.find(value => value.libraryId === album?.album.rootId) : undefined
  if (album?.album.rootId && dataset) workbenchLyrics.bind({ datasetId: dataset, libraryId: album.album.rootId, albumId: album.album.albumId, captureId: album.capture.readToken }, library ?? null)
}
watch(() => workbench.focusedAlbum.value, bindWorkbenchLyrics)
async function captureSelectedLyricsLibraries(): Promise<void> {
  if (currentView.value !== 'coverdrop' || !workbench.isOpen.value || workbench.action.value !== 'library'
    || workbenchOpening.value || workbenchLibrary.selectionLocked.value) return
  const owner = workbenchOpenGeneration, datasetId = workbenchLibrary.state.value?.datasetId
  const capture = await workbenchLibrary.captureLibraries()
  if (capture && owner === workbenchOpenGeneration && currentView.value === 'coverdrop' && workbench.isOpen.value
    && workbench.action.value === 'library' && workbenchLibrary.state.value?.datasetId === datasetId && capture.datasetId === datasetId) workbenchLyrics.setLibraries(capture.lyricsLibraries)
}
watch([() => workbenchLibrary.selectedLibraryIds.value, () => workbench.action.value], () => { void captureSelectedLyricsLibraries() })
watch(() => workbenchLibrary.capture.value, capture => { if (capture && capture.datasetId === workbenchLibrary.state.value?.datasetId) workbenchLyrics.setLibraries(capture.lyricsLibraries) })
let refreshedWorkbenchItems = new Set<string>(), refreshedLyricsCommands = new Set<string>()
const lyricsSessionScopes = new Map<string, import('@music-bridge/contracts').LocalLyricsScope>()
watch(() => workbenchLyrics.session.value, session => {
  if (session) lyricsSessionScopes.set(session.sessionId, { ...session.scope })
}, { flush: 'sync' })
watch(() => workbench.operations.value, operations => {
  const retained = new Set<string>(); let changed = false
  for (const operation of operations) for (const item of operation.receipt?.items ?? []) {
    const key = JSON.stringify([operation.request.datasetId, operation.request.commandId, item.itemId]); retained.add(key)
    if (operation.request.datasetId === workbenchLibrary.state.value?.datasetId && operation.state !== 'unknown'
      && item.state === 'applied' && !refreshedWorkbenchItems.has(key)) { refreshedWorkbenchItems.add(key); changed = true }
  }
  refreshedWorkbenchItems = new Set([...refreshedWorkbenchItems].filter(key => retained.has(key)))
  if (changed) void refreshLocalLibraryFromWorkbench()
})
watch(() => workbenchLyrics.saveOperations.value, operations => {
  const retained = new Set<string>(), sessions = new Set<string>(); let changed = false
  for (const operation of operations) {
    sessions.add(operation.receipt.sessionId)
    const scope = lyricsSessionScopes.get(operation.receipt.sessionId)
    if (!scope) continue
    const key = JSON.stringify([scope.datasetId, operation.receipt.commandId, scope.albumId]); retained.add(key)
    if (scope.datasetId === workbenchLibrary.state.value?.datasetId && ['complete', 'partial'].includes(operation.receipt.state)
      && (operation.receipt.cover === 'saved' || operation.receipt.tracks.some(track => track.lrc === 'saved' || track.embed === 'saved'))
      && !refreshedLyricsCommands.has(key)) { refreshedLyricsCommands.add(key); changed = true }
  }
  refreshedLyricsCommands = new Set([...refreshedLyricsCommands].filter(key => retained.has(key)))
  for (const id of lyricsSessionScopes.keys()) if (!sessions.has(id) && id !== workbenchLyrics.session.value?.sessionId) lyricsSessionScopes.delete(id)
  if (changed) void refreshLocalLibraryFromWorkbench()
})
function localMaintenanceAvailability(action: Exclude<LocalWorkbenchExistingAction, 'finder'>): localWorkbenchDto.LocalWorkbenchAvailability {
  const unavailable = (reason: string): localWorkbenchDto.LocalWorkbenchAvailability => ({ available: false, reason })
  if (!workbenchLibrary.state.value || currentView.value !== 'coverdrop' || !coverDropViewRef.value || !workbench.isOpen.value) return unavailable('原音乐库工作区尚未读取。')
  if (['libraries', 'scan-settings', 'ai-settings', 'scan-history', 'scan-refresh', 'organizer-history'].includes(action)) return { available: true }
  if (action === 'lyrics') return workbenchLyrics.scope.value || workbenchLyrics.library.value ? { available: true } : unavailable('原专辑或完整歌词库尚未绑定。')
  const albums = workbench.albums.value
  if (!albums.length || albums.some(album => !album.rootId || !album.revision || (album.trackCount ?? album.trackIds.length) < 1)) return unavailable('请先读取明确专辑的完整曲目范围。')
  const count = albums.reduce((total, album) => total + (album.trackCount ?? album.trackIds.length), 0)
  if (count > localWorkbenchDto.LOCAL_ORGANIZER_LIMIT) return unavailable('原具体源维护一次最多100首，不能截取当前页或代表曲目。')
  if ((action === 'source-tags' || action === 'source-cover') && !localLibrary.sourceWrites.capable) return unavailable('原源文件维护服务尚未装配。')
  if ((action === 'rename' || action === 'move') && !localLibrary.relocationPlans.capable) return unavailable('原搬迁预览服务尚未装配。')
  return { available: true }
}
function localMaintenanceOpened(action: Exclude<LocalWorkbenchExistingAction, 'finder'>, albums: readonly LocalWorkbenchAlbumRef[]): boolean {
  const binding = maintenanceUiOpened, datasetId = workbenchLibrary.state.value?.datasetId
  if (!binding || binding.action !== action || binding.datasetId !== datasetId || binding.generation !== maintenanceUiGeneration
    || binding.albums !== JSON.stringify(albums) || currentView.value !== 'coverdrop' || !workbench.isOpen.value || !coverDropViewRef.value) return false
  if (['libraries', 'scan-settings', 'ai-settings', 'scan-history', 'scan-refresh'].includes(action)) return coverDropViewRef.value.isManagementOpen()
  // setAction在原delegatedPane期间延后提交；同实际page host和同歌词scope存活，finally仍由原Controller切pane。
  if (action === 'lyrics') return !!workbenchLyrics.scope.value || !!workbenchLyrics.library.value
  if (action === 'organizer-history') return localLibrary.organizer.isOpen.value && localLibrary.organizer.view.value === 'history' && localLibrary.organizer.historyLoaded.value
  if (action === 'mb-info') return localLibrary.organizer.isOpen.value && localLibrary.organizer.view.value === 'edit' && localLibrary.organizer.target.value === binding.target && !localLibrary.organizer.datasetChanged.value && !localLibrary.organizer.error.value
  if (action === 'source-tags' || action === 'source-cover') return localLibrary.sourceWrites.isOpen.value && localLibrary.sourceWrites.view.value === 'edit' && localLibrary.sourceWrites.target.value === binding.target
    && localLibrary.sourceWrites.context.value?.datasetId === datasetId && !localLibrary.sourceWrites.contextFailed.value && !localLibrary.sourceWrites.datasetChanged.value
  return localLibrary.relocationPlans.isOpen.value && localLibrary.relocationPlans.view.value === 'edit' && localLibrary.relocationPlans.targets.value === binding.target
    && localLibrary.relocationPlans.mode.value === action && localLibrary.relocationPlans.context.value?.datasetId === datasetId && !localLibrary.relocationPlans.contextFailed.value && !localLibrary.relocationPlans.datasetChanged.value
}
async function openOriginalMaintenance(action: LocalWorkbenchExistingAction, albums: readonly LocalWorkbenchAlbumRef[]): Promise<{ opened: true } | { opened: false; reason: string }> {
  if (action === 'finder') return window.musicBridge.openLocalWorkbenchExisting({ action, albums })
  const datasetId = workbenchLibrary.state.value?.datasetId, owner = maintenanceUiGeneration, selection = JSON.stringify(albums)
  const current = () => !!datasetId && currentView.value === 'coverdrop' && workbench.isOpen.value && !!coverDropViewRef.value
    && maintenanceUiGeneration === owner && workbenchLibrary.state.value?.datasetId === datasetId && JSON.stringify(workbench.albums.value) === selection
  const stale = (): { opened: false; reason: string } => ({ opened: false, reason: '原工作库、维护页面或完整选择已变化。' })
  if (!current()) return stale()
  const availability = localMaintenanceAvailability(action)
  if (!availability.available) return { opened: false, reason: availability.reason }
  const overview = await window.musicBridge.getCommandOutbox()
  if (!current() || !localWorkbenchDto.isCommandOutboxOverview(overview) || overview.datasetId !== datasetId) return stale()
  let target: unknown = null
  if (action === 'lyrics') workbench.setAction('lyrics')
  else if (['libraries', 'scan-settings', 'scan-history', 'scan-refresh', 'ai-settings'].includes(action)) {
    if (action !== 'ai-settings') workbench.setAction('library')
    coverDropViewRef.value!.openManagementPanel(action)
  } else if (action === 'organizer-history') await localLibrary.organizer.openHistory()
  else {
    const trackIds: string[] = []
    for (const album of albums) {
      const count = album.trackCount ?? album.trackIds.length
      if (!album.rootId || !album.revision || count < 1 || count > localWorkbenchDto.LOCAL_ORGANIZER_LIMIT) return stale()
      if (album.trackIds.length === count) trackIds.push(...album.trackIds)
      else {
        // 只接受真实完整一页；超过旧源维护上限已在availability阻断，不按代表曲目缩组。
        const request = { albumKey: album.albumId, rootId: album.rootId, offset: 0, limit: 100 }
        const page = await window.musicBridge.getLocalAlbumTracks(request)
        if (!current() || !localWorkbenchDto.isLocalAlbumTrackPage(page, request, page.album) || page.album.revision !== album.revision || page.total !== count || page.hasMore || page.items.length !== count) return stale()
        trackIds.push(...page.items.map(value => value.facts.track.id))
      }
    }
    const ids = [...new Set(trackIds)]
    if (!current() || !ids.length || ids.length > localWorkbenchDto.LOCAL_ORGANIZER_LIMIT) return stale()
    const one = albums.length === 1 ? albums[0] : null
    const selected: localWorkbenchDto.LocalOrganizerTarget = one?.editionId ? { mode: 'edition', editionId: one.editionId }
      : ids.length === 1 ? { mode: 'single', trackId: ids[0]! } : { mode: 'batch', trackIds: ids }
    const label = one?.title ?? `明确选择的 ${ids.length} 首`
    if (action === 'mb-info') {
      const opening = localLibrary.organizer.open(selected, label); target = localLibrary.organizer.target.value; await opening
    } else if (action === 'source-tags' || action === 'source-cover') {
      const opening = localLibrary.sourceWrites.open(selected, label, action === 'source-tags' ? 'TAGS' : 'EMBEDDED_COVER', one?.editionId ?? '')
      target = localLibrary.sourceWrites.target.value; await opening
    } else if (action === 'rename' || action === 'move') {
      const previousTargets = localLibrary.relocationPlans.targets.value
      await localLibrary.openRelocationTracks(ids, action)
      if (localLibrary.relocationPlans.targets.value === previousTargets) return stale()
      target = localLibrary.relocationPlans.targets.value
    } else return stale()
  }
  if (!current()) return stale()
  maintenanceUiOpened = { action, datasetId: datasetId!, generation: owner, albums: selection, target }
  await nextTick()
  if (!localMaintenanceOpened(action, albums)) return { opened: false, reason: '原维护入口或对应读取尚未在当前工作区打开。' }
  return { opened: true }
}
function returnLocalMaintenanceFocus(): void { (currentView.value === 'coverdrop' ? coverDropViewRef.value : localLibraryViewRef.value)?.returnMaintenanceFocus() }
function sourceFromOrganizer(): void {
  const current = localLibrary.organizer.target.value
  if (current) void localLibrary.sourceWrites.open(current, localLibrary.organizer.targetLabel.value, 'TAGS')
}
function sourceFromArtwork(): void {
  const current = localLibrary.artwork.target.value, selection = localLibrary.artwork.context.value?.selection
  if (current && selection?.candidate) void localLibrary.sourceWrites.open({ mode: 'single', trackId: current.trackId }, '当前曲目已保存的 Mousa 封面', 'EMBEDDED_COVER', current.editionId)
}
function openSourceMbOnly(): void {
  const current = localLibrary.sourceWrites.target.value, detail = localLibrary.detail.value
  if (!current) return
  if (localLibrary.sourceWrites.range.value !== 'TAGS') {
    const chosenEdition = localLibrary.sourceWrites.editionId.value
    const exactTrackId = current.mode === 'single' ? current.trackId : detail && detail.editions.some(edition => edition.id === chosenEdition)
      && (current.mode === 'batch' ? current.trackIds.includes(detail.track.id) : current.editionId === chosenEdition) ? detail.track.id : null
    if (exactTrackId) { void localLibrary.artwork.open(exactTrackId, chosenEdition || null); return }
  }
  const exactDetail = current.mode === 'single' && detail?.track.id === current.trackId ? detail : null
  void localLibrary.organizer.open(current, localLibrary.sourceWrites.targetLabel.value, detail?.editions ?? [], exactDetail?.metadata.effective, exactDetail?.metadata.override?.annotations)
}
function reacquireSourceArtwork(): void {
  const current = localLibrary.detail.value, requested = localLibrary.sourceWrites.editionId.value
  if (!current || requested && !current.editions.some(edition => edition.id === requested)) { localLibrary.sourceWrites.error.value = '请从此具体发行的曲目详情进入原选图入口，保存 Mousa 封面后重新读取材料。'; return }
  localLibrary.sourceWrites.close(); void localLibrary.artwork.open(current.track.id, requested || null)
}
const zones = ref<readonly PublicRoonZone[]>([])
const zonesLoading = ref(false)
const zoneRefreshCoordinator = createZoneRefreshCoordinator({
  load: async () => (await window.musicBridge.listZones()).zones,
  onZones: (nextZones) => { zones.value = nextZones },
  onLoading: (loading) => { zonesLoading.value = loading },
  onError: (error) => recordActionError(error),
})
const selectedQuality = ref<PlaybackQualityPreference>('auto')
const remoteCoreState = ref<RemoteCoreTunnelState>({
  mode: 'local-core',
  status: 'idle',
  localStreamPort: 38502,
  remoteHealth: 'unavailable',
  autoReconnect: false,
})
const remoteAutoStart = ref(false)
const remoteSshTarget = ref('')
const inspectorOpen = ref(false)
const commandOutboxOpen = ref(false)
const commandOutboxTrigger = ref<HTMLButtonElement>()
async function closeCommandOutbox(): Promise<void> {
  commandOutboxOpen.value = false
  if (currentView.value === 'local-library' || currentView.value === 'coverdrop') void localLibrary.refresh()
  await nextTick()
  commandOutboxTrigger.value?.focus({ preventScroll: true })
}
const inspectorReturnFocus = ref<HTMLElement | null>(null)
const actionError = ref<string | null>(null)
const actionDiagnosticId = ref<string | null>(null)
const diagnosticNotice = ref<{ code: string; message?: string } | null>(null)
const diagnosticExportState = ref<'idle' | 'working' | 'done' | 'cancelled' | 'error'>('idle')
const toastMessage = ref<string | null>(null)

const pageCache = createLibraryPageCache()
let pageCacheEpoch = 0
const roonGridScopeEpoch = ref(0)
function invalidatePageCaches(sources: readonly CatalogSource[] = ['local', 'netease', 'roon']): void {
  for (const source of sources) { catalog.invalidateSource(source); catalogData.cancelSource(source) }
  catalogActionGeneration++; catalogActionPending.value = false
  pageCacheEpoch++; pageCache.clear()
  roonGridScopeEpoch.value++
  roonArtworkCache.clear()
  // scope 已轮转：同步结束旧私有读取，保留当前目标供原恢复链续读。
  netease.resetAuthorizedLoadStarted()
}

const catalogData = createCatalogDataAdapter(window.musicBridge, () => window.musicBridgeCatalog)
const catalog = useCatalogExperience(catalogData.port)
const catalogActionPending = ref(false)
const catalogPlaybackRecovery = useCatalogPlaybackRecovery({
  readReceipt: request => playback.readLocalLibraryPlayReceipt(request), getSnapshot: () => playback.playbackState.value,
})
const catalogLocalUnconfirmed = catalogPlaybackRecovery.request
let catalogActionGeneration = 0, catalogRoonContext: RoonPlaybackContext | undefined

const search = useAggregatedSearch({
  cache: pageCache, getCacheScope: () => String(pageCacheEpoch),
  getProviderAuthorized: () => netease.authState.value.status === 'authorized',
  api: window.musicBridge,
  getZoneId: () => selectedZone.value?.zoneId,
  getScrollTop: () => journey.contentScroll.value?.scrollTop ?? 0,
  scrollTo: top => { void nextTick(() => journey.contentScroll.value?.scrollTo({ top })) },
  classifyError: searchErrorKind,
  onResetSearchOrigin: () => { journey.roonSearchOrigin.value = false },
  onInvalidateRoonDetails: () => browse.invalidateAlbumArtistRequests(),
})
const {
  searchQuery, searchCategory, searchSongsOpen, searchSongScrollTop,
  roonSearchAlbums, roonSearchArtists, roonSearchLoading, roonSearchError,
  searchPage, searchArtistsPage, searchAlbumsPage, searchArtistsState,
  searchAlbumsState, searchArtistsError, searchAlbumsError, searchDetail,
  searchDetailLoadingMore, searchDetailMoreError, searchScrollTop,
  searchInitialLoading, searchLoadingMore, searchLoadMoreError, searchError,
  matchStates, matchResults, pendingMatchRequests, selectSearchCategory,
  matchTracks,
  scheduleSearch, searchPageAt, loadMoreSearchEntities, openSearchSongs,
  openSearchDetail, loadMoreSearchDetail, closeSearchDetail,
} = search
const browse = useRoonBrowse({
  cache: pageCache, getCacheScope: () => JSON.stringify([pageCacheEpoch, selectedZone.value?.zoneId ?? null]),
  api: window.musicBridge,
  formatError: roonLibraryMessage,
  onError: recordActionError,
  onToast: showToast,
  getView: () => journey.currentView.value,
  isArtistPageActive: () => catalog.artistSource.value === 'roon',
  onDetailOpening: view => { journey.setDetailView(view) },
  onDetailReady: (view, source) => { journey.setDetailView(view, source) },
  onNavigateSource: source => journey.navigateSource(source),
  onPlayTrack: item => { void playRoonLibraryTrack(item) },
})
const {
  localAlbumQuery, setLocalAlbumQuery, roonAlbumsPage, roonAlbumsInitialLoading,
  roonAlbumsLoadingMore, roonAlbumsLoadMoreError, roonAlbumsError, loadRoonAlbums,
  loadMoreRoonAlbums, retryRoonAlbums, resetRoonAlbums,
  localArtistQuery, setLocalArtistQuery, roonArtistsPage, roonArtistsInitialLoading,
  roonArtistsLoadingMore, roonArtistsLoadMoreError, roonArtistsError, loadRoonArtists,
  loadMoreRoonArtists, retryRoonArtists, resetRoonArtists,
  roonGenresPage, roonGenresInitialLoading, roonGenresLoadingMore,
  roonGenresLoadMoreError, roonGenresError, loadRoonGenres, loadMoreRoonGenres,
  retryRoonGenres, resetRoonGenres,
  roonPlaylistsPage, roonPlaylistsInitialLoading, roonPlaylistsLoadingMore,
  roonPlaylistsLoadMoreError, roonPlaylistsError, loadRoonPlaylists,
  loadMoreRoonPlaylists, retryRoonPlaylists, resetRoonPlaylists,
  favoriteKind, favoriteResolutionEpoch, favoritesPage, favoritesInitialLoading,
  favoritesLoadingMore, favoritesLoadMoreError, favoritesError,
  selectedRoonAlbum, roonAlbumFavoriteState, selectedRoonAlbumPage,
  roonAlbumInitialLoading, roonAlbumLoadingMore, roonAlbumLoadMoreError, roonAlbumError,
  selectedRoonArtist, roonArtistFavoriteState, selectedRoonArtistPage,
  roonArtistInitialLoading, roonArtistLoadingMore, roonArtistLoadMoreError, roonArtistError,
  selectedRoonGenre, selectedRoonGenrePage, roonGenreInitialLoading,
  roonGenreLoadingMore, roonGenreLoadMoreError, roonGenreError,
  selectedRoonPlaylist, selectedRoonPlaylistPage, roonPlaylistInitialLoading,
  roonPlaylistLoadingMore, roonPlaylistLoadMoreError, roonPlaylistError,
  loadRoonAlbum, loadRoonArtist, loadRoonGenre, loadRoonPlaylist,
  roonAlbumPageAt, roonArtistPageAt, roonGenrePageAt, roonPlaylistPageAt,
  loadRoonEntityFavorite, toggleRoonEntityFavorite, loadFavorites,
  setFavoriteKind, openFavorite, removeFavorite, favoritesPageAt,
  retryFavorites, retryRoonAlbum, refreshVisibleRoonCollection,
} = browse
type SearchErrorKind = 'auth-required' | 'auth-expired' | 'generic'
type LibraryErrorKind = SearchErrorKind

const netease = useNeteaseLibrary({
  cache: pageCache, getCacheScope: () => JSON.stringify([pageCacheEpoch, selectedZone.value?.zoneId ?? null]),
  api: window.musicBridge,
  getCoreRuntime: () => coreState.value?.runtime,
  getRemoteStatus: () => remoteCoreState.value.status,
  getView: () => journey.currentView.value,
  onMatchTracks: (tracks, visible) => { void matchTracks(tracks, visible) },
  onPlaylistSwitch: () => playback.invalidateCollectionOperation(),
  onPlaylistReady: playlistId => journey.setDetailView('playlist-detail', { type: 'playlist', playlistId }),
  onResetPrivate: () => {
    invalidatePageCaches(['netease'])
    journey.resetPrivatePath()
    search.resetSearch()
    search.invalidateAccountScope()
    playback.invalidateCollectionOperation()
    recentTracks.value = []
  },
  onError: recordActionError,
  accountMessage,
  dailyMessage,
  libraryErrorKind,
})
const {
  authState, authError, accountState, accountError,
  dailyRecommendations, dailyState, dailyError,
  likedPage, likedInitialLoading, likedLoadingMore, likedLoadMoreError, likedError, likedHomeState,
  playlists, playlistState, playlistError, selectedPlaylist, selectedPlaylistId,
  playlistContentScrollTop, playlistTableScrollTop, playlistInitialLoading, playlistLoadingMore,
  playlistLoadMoreError, playlistDetailError, homePlaylistTracks, homeRecommendationState,
  loadLiked, likedPageAt, loadAccountState, refreshAccountProfile,
  loadPlaylists, refreshHomeRecommendations, loadPlaylist, retryPlaylist, playlistPageAt,
  applyAuthState, applyAccountState, beginQrLogin, cancelQrLogin, logout,
  loadAuthorizedLibraryWhenReady, resetAuthorizedLoadStarted, applyInitialAuthState,
} = netease

let toastTimer: ReturnType<typeof setTimeout> | undefined

const journey = usePageJourney({
  search,
  browse,
  localArtistsEnabled: true,
  library: {
    hasLikedItems: () => likedPage.value.items.length > 0,
    isPlaylistReady: () => playlistState.value === 'ready',
    getPlaylistScrollTop: () => playlistContentScrollTop.value,
    setPlaylistScrollTop: top => { playlistContentScrollTop.value = top },
    loadLiked,
    loadPlaylists,
    loadPlaylist: playlistId => loadPlaylist(playlistId),
    cancelPageReads: netease.cancelPageReads,
    resumePageReads: netease.resumePageReads,
  },
  onPlayRoonTrack: item => { void playRoonLibraryTrack(item) },
  onCloseInspector: () => { inspectorOpen.value = false },
  onClearActionError: () => {
    actionError.value = null
    actionDiagnosticId.value = null
  },
  canLeaveRecording: () => recordingViewRef.value?.canLeave() ?? false,
  canLeaveCollection: () => collectionViewRef.value?.canLeave() ?? false,
  beforeLeave: (destination, resume) => coverDropPageEntry.beforeLeave(destination, resume),
})
const {
  currentView, sidebar, roonSearchOrigin,
  contentScroll, collectionView, localSearchScope,
  sidebarSearchQuery, sidebarSearchLabel, roonDetailBackLabel,
  isImmersiveNowPlaying, enterNowPlaying, exitNowPlaying, navigate, navigateSource,
  openTapeCollection, clearSearch, updateSearchQuery, returnFromRoonDetail,
  returnToSearch, selectAggregatedRoonItem: selectAggregatedRoonItemInJourney,
} = journey

const catalogAlbumNavigation = useCatalogAlbumNavigation({ journey, catalog, browser: albumBrowser,
  selectAlbumView: () => { localLibraryViewMode.value = 'albums' } })

function updateCatalogDraft(value: string): void { catalog.invalidatePreview(value) }
function submitCatalogSearch(value: string): void {
  if (!value.trim()) return
  catalogAlbumNavigation.clear()
  navigate('search', false)
  if (currentView.value !== 'search') return
  catalogActionGeneration++; catalogActionPending.value = false
  void catalog.search(value)
  void nextTick(() => contentScroll.value?.scrollTo({ top: 0 }))
}
function navigateCatalogSource(source: SidebarSource): void {
  catalogAlbumNavigation.clear()
  navigateSource(source)
  if (source.type === 'roon-artists' && currentView.value === 'roon-artists') { catalog.artistSource.value = 'local'; catalog.closeDetail() }
}
function selectCatalogSuggestion(suggestion: SidebarSearchSuggestion): void {
  if (suggestion.kind === 'keyword') { submitCatalogSearch(suggestion.title); return }
  const item = catalog.previewItem(suggestion.key), query = catalog.draft.value.trim()
  if (!item) return
  if (item.kind === 'tracks') { void playCatalogItem(item, 'PLAY_NOW', query); return }
  if (catalog.query.value !== query) submitCatalogSearch(query)
  else navigate('search', false)
  if (currentView.value === 'search') void openCatalogItem(item)
}
async function openCatalogItem(item: CatalogItem): Promise<void> {
  if (item.kind === 'tracks') { await playCatalogItem(item); return }
  if (item.identity.type === 'roon') { openRoonLibraryItem(item.identity.value); return }
  if (item.identity.type === 'local-album') {
    await catalogAlbumNavigation.open(item.identity.value)
    return
  }
  await catalog.openDetail(item)
  void nextTick(() => contentScroll.value?.scrollTo({ top: 0 }))
}
async function playCatalogItem(item: CatalogItem, action: LocalPlayAction = 'PLAY_NOW', explicitQuery?: string): Promise<void> {
  if (catalogActionPending.value || playbackStartPending.value) return
  if (catalogLocalUnconfirmed.value) { recordActionError(new Error('原本地点播的结果尚未确认，请使用“核对播放请求”；不会重复提交。')); return }
  const generation = ++catalogActionGeneration, query = explicitQuery ?? catalog.query.value
  const current = () => generation === catalogActionGeneration
  catalogActionPending.value = true
  try {
    if (item.identity.type === 'netease-track') {
      if (action === 'APPEND_MB_QUEUE') { await appendTrack(item.identity.value, 'netease'); return }
      if (action === 'PLAY_NEXT_MB_QUEUE') { await insertTrackNext(item.identity.value, 'netease'); return }
      const loader = catalogData.neteaseLoader(query, explicitQuery === undefined ? catalog.detail.value?.item : undefined)
      const initial = await readCatalogPlaybackPrefix(loader, item.identity.value.id, current)
      if (current()) await replaceAndPlayCollection(loader, item.identity.value.id, initial, true, 'netease')
    } else if (item.identity.type === 'roon') {
      if (action === 'APPEND_MB_QUEUE') { await queueRoonLibraryTrack(item.identity.value); return }
      if (action === 'PLAY_NEXT_MB_QUEUE') return
      const load = (page: import('@music-bridge/contracts').PageRequest) => window.musicBridge.searchRoonLibrary(query, page, 'track')
      const initial = await readCatalogRoonPlaybackPrefix(load, item.identity.value.reference, current)
      if (!current()) return
      catalogRoonContext = { page: initial, reference: query, load: (_reference, page) => load(page) }
      try { await playRoonLibraryTrack(item.identity.value) } finally { catalogRoonContext = undefined }
    } else if (item.identity.type === 'local-track') {
      const selected = item.identity.value, context = catalog.localPlaybackContext(item, query)
      if (action === 'PLAY_NOW' && !context) throw new Error('原搜索或艺术家资料已变化，请重新读取后选择歌曲。')
      const target = await window.musicBridge.getLocalLibraryPlaybackTarget()
      if (!current()) return
      if (!target || selectedZone.value?.zoneId !== target.zone_id) throw new Error('请先在原播放器中选择可用的 Roon Zone。')
      const original: LocalPlayRequest = { schema_version: '1.2', request_id: crypto.randomUUID(), route: 'roon_audio_input', source_kind: 'local_file', local_track_id: selected.track.id,
        asset_id: selected.asset.id, expected_asset_revision: selected.asset.fileRevision, target: { ...target }, action,
        ...(action === 'PLAY_NOW' && context ? { context: { ...context } } : {}) }
      if (action === 'PLAY_NOW') catalogPlaybackRecovery.begin(original)
      const request: ArtistCatalogPlayRequest | undefined = context ? { requestId: original.request_id, context, startTrackId: selected.track.id, target: { ...target }, action } : undefined
      let result: import('@music-bridge/contracts').LocalPlayAccepted | import('@music-bridge/contracts').LocalSourceUnsupported
      try { result = action === 'PLAY_NOW' && request ? await playback.playLocalCatalogSelection(request) : await playback.playLocalLibrarySelection(original) }
      catch (error) { if (action === 'PLAY_NOW') catalogPlaybackRecovery.fail(error, original); throw error }
      if (action === 'PLAY_NOW') catalogPlaybackRecovery.accept(result, original)
      if (result.status === 'unsupported') { showToast('当前播放目标暂不支持此本地来源。'); return }
      if (action === 'PLAY_NOW') {
        if (current()) enterNowPlaying()
      } else showToast(action === 'APPEND_MB_QUEUE' ? '已加入播放队列' : '已加入下一首播放')
    }
  } catch (error) { if (current()) recordActionError(error) }
  finally { if (current()) catalogActionPending.value = false }
}
watch(() => playback.playbackState.value, snapshot => {
  catalogPlaybackRecovery.observe(snapshot)
})
watch([() => catalog.detail.value?.item.key, catalog.artistSource], () => {
  catalogActionGeneration++; catalogActionPending.value = false
}, { flush: 'sync' })

// 点击时携带的描述符比旧根列表或详情缓存更新；导航仍沿原父页与搜索链。
function seedCurrentRoonDescriptor(item: RoonLibraryItem): void {
  if (item.kind === 'album') browse.selectedRoonAlbum.value = item
  else if (item.kind === 'artist') browse.selectedRoonArtist.value = item
  else if (item.kind === 'genre') browse.selectedRoonGenre.value = item
  else if (item.kind === 'playlist') browse.selectedRoonPlaylist.value = item
}

function openRoonLibraryItem(item: RoonLibraryItem): void {
  seedCurrentRoonDescriptor(item)
  if (item.kind === 'album') navigateSource({ type: 'roon-album', reference: item.reference })
  else if (item.kind === 'artist') navigateSource({ type: 'roon-artist', reference: item.reference })
  else if (item.kind === 'genre') navigateSource({ type: 'roon-genre', reference: item.reference })
  else if (item.kind === 'playlist') navigateSource({ type: 'roon-playlist', reference: item.reference })
}

function selectAggregatedRoonItem(item: RoonLibraryItem): void {
  // 搜索父页先由journey保存，再沿原顺序seed；普通详情跳转补齐点击事实。
  if (currentView.value !== 'search' && !roonSearchOrigin.value) seedCurrentRoonDescriptor(item)
  selectAggregatedRoonItemInJourney(item)
}

watch(currentView, (view, previous) => {
  if (view !== previous) { catalogActionGeneration++; catalogActionPending.value = false }
  const localPage = view === 'local-library' || view === 'coverdrop', previousLocalPage = previous === 'local-library' || previous === 'coverdrop'
  beginInitialAlbumContext(view, view === 'coverdrop' || view === 'local-library' && localLibraryViewMode.value === 'albums')
  if (view === 'settings' || localPage && !deferInitialAlbumContextReads()) void loadWorkspace()
  if (localPage) void localLibrary.activate({ deferTrackReads: view === 'coverdrop' || localLibraryViewMode.value === 'albums' || !!localLibrarySelectedTrackId.value, deferContextReads: deferInitialAlbumContextReads() })
  else if (!localPage && previousLocalPage) localLibrary.suspend()
  if (view !== 'local-library') albumBrowser.deactivate()
  if (view !== 'coverdrop') coverDropBrowser.deactivate()
  if (previous !== view) {workbenchOpenGeneration++;maintenanceUiGeneration++;maintenanceUiOpened=null;workbenchOpening.value=false;workbenchEntryError.value='';invalidateResultInspections()}
  if (previous === 'recording' && view !== 'recording') {
    recordingInitialPhysical.value = undefined
    recordingReservationNavigation.value = undefined
  }
}, { flush: 'sync' })

watch(localLibraryViewMode, () => {
  if (currentView.value !== 'local-library') return
  beginInitialAlbumContext('local-library', localLibraryViewMode.value === 'albums')
  if (!deferInitialAlbumContextReads()) { void localLibrary.activate({ deferTrackReads: localLibraryViewMode.value === 'albums' || !!localLibrarySelectedTrackId.value }); void loadWorkspace(); void requestInitialScanRefresh(false) }
}, { flush: 'sync' })

installInitialScanObservationLifecycle()

function startRecordingFromCollection(entry: CollectionStartEntry): void {
  const { returnOffset, ...selection } = entry
  collectionReturnLocation.value = { physicalId: entry.physicalId, modelId: entry.modelId, returnOffset }
  recordingReservationNavigation.value = undefined
  recordingInitialPhysical.value = selection
  navigateSource({ type: 'recording' })
}
function openReservationFromCollection(entry: CollectionReservationEntry): void {
  collectionReturnLocation.value = { physicalId: entry.physicalId, modelId: entry.modelId, returnOffset: entry.returnOffset }
  recordingInitialPhysical.value = undefined
  recordingReservationNavigation.value = { physicalId: entry.physicalId, draftId: entry.draftId, planId: entry.planId }
  navigateSource({ type: 'recording' })
}
let collectionReturnRead = 0
async function openCollectionFromRecording(physicalId?: string): Promise<void> {
  if (currentView.value === 'recording' && !(recordingViewRef.value?.canLeave() ?? false)) return
  const read = ++collectionReturnRead
  const contextKey = recordingViewRef.value?.navigationContextKey()
  if (physicalId) {
    try {
      const result = await window.musicBridge.getCollectionCopy(physicalId)
      if (read !== collectionReturnRead || currentView.value !== 'recording' || recordingViewRef.value?.navigationContextKey() !== contextKey) return
      if (result.copy.physicalId !== physicalId || result.copyIndex === undefined) {
        showToast('无法确认这盘磁带在收藏中的当前位置，请刷新后重试返回。')
        return
      }
      collectionReturnLocation.value = { physicalId, modelId: result.modelId, returnOffset: Math.floor(result.copyIndex / 20) * 20 }
    } catch {
      if (read === collectionReturnRead && currentView.value === 'recording' && recordingViewRef.value?.navigationContextKey() === contextKey) showToast('暂时无法读取这盘磁带的收藏位置；仍留在录音页，请稍后重试。')
      return
    }
  }
  if (currentView.value === 'recording' && !(recordingViewRef.value?.canLeave() ?? false)) return
  openTapeCollection()
}

const homeTracks = computed(() => recentTracks.value)
const selectedZone = computed(() => {
  const selectedId = playbackState.value?.selectedZoneId
  return zones.value.find((zone) => zone.zoneId === selectedId) ?? zones.value.find((zone) => zone.selected)
})
watch(() => selectedZone.value?.zoneId, (next, previous) => {
  if (next === previous) return
  invalidatePageCaches(['roon'])
  search.invalidateScope()
  if (journey.currentView.value === 'search') search.resume()
  browse.resetSession()
  journey.resetRoonPath()
  loadAuthorizedLibraryWhenReady()
  void browse.resumePageReads(currentView.value)
  refreshVisibleRoonCollection()
}, { flush: 'sync' })
const zoneLifecycleStatus = computed(() => resolveZoneLifecycleStatus({
  roonStatus: coreState.value?.roon ?? 'disconnected',
  loading: zonesLoading.value,
  zoneCount: zones.value.length,
  selected: selectedZone.value !== undefined,
}))
watch(() => [selectedZone.value?.zoneId, coreState.value?.roon], () => {
  if ((currentView.value === 'local-library' || currentView.value === 'coverdrop') && !deferInitialAlbumContextReads()) void localLibrary.refreshContext()
})
const hasPlaybackIssue = computed(() => Boolean(playbackState.value?.lastIssue || actionError.value))
const greeting = computed(() => {
  const hour = new Date().getHours()
  return hour >= 5 && hour < 12 ? '早上好' : hour >= 12 && hour < 18 ? '下午好' : '晚上好'
})
function resetRoonRuntimeReferences(): void {
  invalidatePageCaches(['roon'])
  browse.resetSession()
  journey.resetRoonPath()
  playback.resetRoonSession()
  search.invalidateRoonScope()
}

function publicErrorCode(error: unknown): string | undefined {
  const code = readPublicIpcErrorCode(error)
  if (code) return code
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : undefined
  if (message === 'Provider login required') return 'AUTH_REQUIRED'
  if (message === 'Provider session expired') return 'AUTH_EXPIRED'
  return undefined
}

function accountMessage(error: unknown): string {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请重新登录。'
    case 'ACCOUNT_PROFILE_UNAVAILABLE':
      return '账户资料暂时不可用，登录状态仍然保留。'
    default:
      return '账户资料暂时不可用，请稍后重试。'
  }
}

function dailyMessage(error: unknown): string {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请到设置重新登录。'
    default:
      return '每日推荐暂时不可用，请稍后重试。'
  }
}

function actionableMessage(error: unknown): string {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
      return '音乐服务登录已失效，请到设置重新登录。'
    case 'ROON_NOT_PAIRED':
    case 'ROON_CORE_NOT_CONNECTED':
      return 'Roon 尚未配对，请先确认 Roon Core 正在运行。'
    case 'ROON_ZONE_NOT_SELECTED':
      return '请先在设置选择播放设备。'
    case 'QUALITY_DOWNGRADED':
      return '当前请求质量已被安全降级，实际质量以 Signal Path 为准。'
    case 'ROON_ZONE_LOST':
      return '播放 Zone 暂时不可用，请检查 Roon 状态后重试。'
    case 'ROON_TIMEOUT':
      return 'Roon 未确认真实播放状态，请检查设备后重试。'
    case 'ROON_LIBRARY_UNAVAILABLE':
    case 'NOT_READY':
      return 'Roon Library 暂时不可用，请确认 Core 已配对并重试。'
    case 'ROON_LIBRARY_REQUEST_FAILED':
      return 'Roon Library 请求失败，请检查 Core 连接后重试。'
    case 'ROON_IMAGE_DECODE_FAILED':
      return 'Roon 封面解码失败，请重新打开页面。'
    case 'ROON_ALBUM_HIERARCHY_INVALID':
      return 'Roon 返回的专辑层级无效，请返回列表后重试。'
    case 'ROON_TRACK_ACTION_UNAVAILABLE':
      return '这首曲目的 Roon 播放操作不可用。'
    case 'ROON_LIBRARY_INVALID_REFERENCE':
    case 'INVALID_IPC_REQUEST':
      return '这个 Roon 条目已过期，请返回专辑列表后重新打开。'
    default:
      return '操作暂时不可用，请稍后重试。'
  }
}

function playbackIssueMessage(issue: { code: string; message: string }): string {
  return issue.code === 'QUALITY_DOWNGRADED' ? actionableMessage(issue) : issue.message
}

function recordActionError(error: unknown): void {
  actionError.value = actionableMessage(error)
  actionDiagnosticId.value =
    typeof error === 'object' && error !== null && 'diagnosticId' in error && typeof error.diagnosticId === 'string'
      ? error.diagnosticId
      : null
  showToast(actionError.value)
}

function libraryErrorKind(error: unknown): LibraryErrorKind {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
      return 'auth-required'
    case 'AUTH_EXPIRED':
      return 'auth-expired'
    default:
      return 'generic'
  }
}

function searchErrorKind(error: unknown): SearchErrorKind {
  switch (publicErrorCode(error)) {
    case 'AUTH_REQUIRED':
      return 'auth-required'
    case 'AUTH_EXPIRED':
      return 'auth-expired'
    default:
      return 'generic'
  }
}

function roonLibraryMessage(error: unknown): string {
  return formatRoonLibraryMessage(error, {
    roonStatus: coreState.value?.roon,
    remoteCoreDevelopment: remoteCoreState.value.mode === 'remote-core-development',
  })
}

async function exportDiagnostics(): Promise<void> {
  diagnosticExportState.value = 'working'
  try {
    const result = await window.musicBridge.exportDiagnostics()
    diagnosticExportState.value = result.exported ? 'done' : 'cancelled'
  } catch (error) {
    diagnosticExportState.value = 'error'
    recordActionError(error)
  }
}

function showToast(message: string): void {
  toastMessage.value = message
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = null
    toastTimer = undefined
  }, 2_400)
}

function getRoonPlaybackContext(): RoonPlaybackContext | undefined {
  if (catalogRoonContext) return catalogRoonContext
  if (currentView.value === 'roon-album-detail' && selectedRoonAlbum.value) {
    return { page: selectedRoonAlbumPage.value, reference: selectedRoonAlbum.value.reference, load: window.musicBridge.getRoonAlbumTracks }
  }
  if (currentView.value === 'roon-playlist-detail' && selectedRoonPlaylist.value) {
    return { page: selectedRoonPlaylistPage.value, reference: selectedRoonPlaylist.value.reference, load: window.musicBridge.getRoonPlaylistTracks }
  }
  if (currentView.value === 'roon-genre-detail' && selectedRoonGenre.value) {
    return { page: selectedRoonGenrePage.value, reference: selectedRoonGenre.value.reference, load: window.musicBridge.getRoonGenreItems }
  }
  return undefined
}

function playAllLiked(): void {
  void replaceAndPlayCollection(
    (page) => window.musicBridge.getLikedTracks(page),
    undefined,
    likedPage.value.items.length > 0 ? likedPage.value : undefined,
  )
}

function appendAllLiked(): void {
  void appendCollection((page) => window.musicBridge.getLikedTracks(page))
}

function playPlaylistTrack(track: TrackSummary): void {
  const playlistId = selectedPlaylistId.value
  if (!playlistId) return
  void replaceAndPlayCollection(
    createPlaylistSnapshotLoader(page => window.musicBridge.getPlaylist(playlistId, page), selectedPlaylist.value ?? undefined),
    track.id,
    selectedPlaylist.value?.tracks.items.length ? selectedPlaylist.value.tracks : undefined,
    false,
  )
}

function playAllPlaylist(): void {
  const playlistId = selectedPlaylistId.value
  if (!playlistId) return
  void replaceAndPlayCollection(
    createPlaylistSnapshotLoader(page => window.musicBridge.getPlaylist(playlistId, page), selectedPlaylist.value ?? undefined),
    undefined,
    selectedPlaylist.value?.tracks.items.length ? selectedPlaylist.value.tracks : undefined,
  )
}

function appendAllPlaylist(): void {
  const playlistId = selectedPlaylistId.value
  if (!playlistId) return
  void appendCollection(
    createPlaylistSnapshotLoader(page => window.musicBridge.getPlaylist(playlistId, page)),
  )
}

async function playAllDailyRecommendations(): Promise<void> {
  await playback.playTracks(dailyRecommendations.value.tracks)
}

async function loadZones(): Promise<void> {
  await zoneRefreshCoordinator.refreshNow()
}

async function selectZone(zoneId: string): Promise<void> {
  cancelRoonPlaybackPreparation()
  try {
    coreState.value = await window.musicBridge.selectZone(zoneId)
    await loadZones()
    await refreshPlayback()
  } catch (error) {
    recordActionError(error)
  }
}

function updateRemoteAutoStart(value: boolean): void {
  remoteAutoStart.value = value
  window.localStorage.setItem('musicbridge.remoteCore.autoStart', value ? '1' : '0')
}

function updateRemoteSshTarget(value: string): void {
  if (value.length > 255) return
  remoteSshTarget.value = value
  window.localStorage.setItem('musicbridge.remoteCore.sshTarget', value)
}

async function startRemoteCore(): Promise<void> {
  actionError.value = null
  try {
    const state = await window.musicBridge.startRemoteCore(remoteSshTarget.value)
    if (lifecycle.isActive()) remoteCoreState.value = state
  } catch (error) {
    if (lifecycle.isActive()) recordActionError(error)
  }
}

async function stopRemoteCore(): Promise<void> {
  cancelRoonPlaybackPreparation()
  actionError.value = null
  try {
    const state = await window.musicBridge.stopRemoteCore()
    if (lifecycle.isActive()) remoteCoreState.value = state
  } catch (error) {
    if (lifecycle.isActive()) recordActionError(error)
  }
}

async function reconnectRemoteCore(): Promise<void> {
  actionError.value = null
  try {
    const state = await reconnectRemoteTarget(window.musicBridge, remoteCoreState.value, remoteSshTarget.value)
    if (lifecycle.isActive()) remoteCoreState.value = state
  } catch (error) {
    if (lifecycle.isActive()) recordActionError(error)
  }
}

function rememberInspectorFocus(): void {
  const active = document.activeElement
  inspectorReturnFocus.value = active instanceof HTMLElement && !active.closest('.playback-inspector')
    ? active
    : null
}

function openInspector(): void {
  rememberInspectorFocus()
  if (isImmersiveNowPlaying.value) exitNowPlaying()
  inspectorOpen.value = true
  void nextTick(() => document.querySelector<HTMLElement>('.playback-inspector .inspector-close')?.focus({ preventScroll: true }))
}

function openQueue(): void {
  openInspector()
}

function closeInspector(): void {
  inspectorOpen.value = false
  const target = inspectorReturnFocus.value
  inspectorReturnFocus.value = null
  if (target?.isConnected) void nextTick(() => target.focus({ preventScroll: true }))
}

function openNowPlaying(): void {
  enterNowPlaying()
}

function navigateShortcut(source: SidebarSource): void {
  navigateSource(source)
}

function navigateCollection(view: 'tapes' | 'music'): void {
  if (currentView.value === 'collection' && collectionView.value === view) return
  if (currentView.value === 'collection' && collectionViewRef.value?.canLeave() !== true) {
    showToast(collectionViewRef.value?.leaveBlockReason() ?? '当前收藏中的设备运行尚未安全收口。')
    return
  }
  navigateSource({ type: 'collection' })
  if (currentView.value === 'collection') collectionView.value = view
}

function onGlobalShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (event.key === 'Escape' && isImmersiveNowPlaying.value) {
    event.preventDefault()
    exitNowPlaying()
    return
  }
  if (event.key === 'Escape' && inspectorOpen.value) {
    event.preventDefault()
    closeInspector()
    return
  }
  if (!event.metaKey || event.altKey || event.ctrlKey) return

  const key = event.key.toLowerCase()
  if (event.shiftKey && key === 'l') {
    event.preventDefault()
    enterNowPlaying()
    return
  }
  if (event.shiftKey && key === 'q') {
    event.preventDefault()
    openQueue()
    return
  }
  if (event.shiftKey) return

  if (key === '1') {
    event.preventDefault()
    navigateShortcut({ type: 'home' })
  } else if (key === '2') {
    event.preventDefault()
    navigateShortcut({ type: 'liked' })
  } else if (key === '3') {
    event.preventDefault()
    navigateShortcut({ type: 'playlists' })
  }
}

async function retryAction(): Promise<void> {
  if (playbackSyncStatus.value === 'error') { await playback.retryPlaybackSync(); return }
  await retryLastPlaybackAction()
}

function qualityLabel(quality: string | undefined): string {
  if (!quality) return '—'
  if (quality === 'auto') return '自动（当前歌曲最高）'
  if (quality === 'unknown') return '未知（以 Roon Signal Path 为准）'
  return quality === 'hires' ? 'Hi-Res' : quality[0].toUpperCase() + quality.slice(1)
}

function setSelectedQuality(preference: PlaybackQualityPreference): void {
  selectedQuality.value = preference
  window.localStorage.setItem('musicbridge.qualityPreference', preference)
}

const lifecycle = useRendererLifecycle({
  api: window.musicBridge,
  keyTarget: window,
  onKeydown: onGlobalShortcut,
  onAppCommand: command => {
    if (command === 'show-queue') openQueue()
  },
  onRemoteCoreEvent: state => {
    const previousStatus = remoteCoreState.value.status
    remoteCoreState.value = state
    if (state.sshTarget) updateRemoteSshTarget(state.sshTarget)
    if (previousStatus === 'ready' && state.status !== 'ready') { invalidateResultInspections();playback.suspendPlaybackStream(); resetRoonRuntimeReferences() }
    if (previousStatus === 'ready' && state.status !== 'ready') invalidatePageCaches(['local'])
    if (previousStatus === 'ready' && state.status !== 'ready') search.invalidateScope()
    if (state.status !== 'ready' && coreState.value) {
      coreState.value = { ...coreState.value, roon: 'disconnected' }
    }
    zoneRefreshCoordinator.handleRemoteCoreState(state.status)
    if (['checking', 'starting', 'reconnecting', 'stopping'].includes(state.status)) {
      resetAuthorizedLoadStarted()
    } else {
      loadAuthorizedLibraryWhenReady()
      if (state.status === 'ready' && currentView.value === 'search') search.resume()
    }
  },
  onCoreEvent: event => {
    const previousRoonStatus = coreState.value?.roon
    const previousRuntime = coreState.value?.runtime
    if (event.event === 'core.ready' || event.event === 'core.health' && previousRuntime === 'ready' && event.payload.state.runtime !== 'ready') invalidatePageCaches(['local'])
    if(event.event==='core.ready'||event.event==='core.health'&&event.payload.state.runtime!=='ready')invalidateResultInspections()
    if (event.event === 'core.ready') playback.acceptPlaybackReady(event.payload.playbackEvents)
    if (event.event === 'core.health' && event.payload.state.runtime !== 'ready') playback.suspendPlaybackStream()
    if (event.event === 'playback.snapshot' || event.event === 'playback.state' || event.event === 'playback.progress') playback.acceptPlaybackStreamEvent(event)
    if (
      event.event === 'core.ready'
      || (event.event === 'roon.changed'
        && previousRoonStatus === 'ready'
        && event.payload.state.roon !== 'ready')
    ) {
      resetRoonRuntimeReferences()
    }
    if (event.event === 'core.ready' || event.event === 'core.health' || event.event === 'roon.changed') {
      if (event.event === 'core.ready' || (previousRuntime === 'ready' && event.payload.state.runtime !== 'ready')) search.invalidateScope()
      coreState.value = event.payload.state
      if (event.payload.state.runtime !== 'ready') resetAuthorizedLoadStarted()
    }
    // 本地专辑首读恢复事件开始。
    if (event.event === 'core.ready' || event.event === 'core.health') observeLocalAlbumCoreRecovery(event.event, event.payload.state.runtime === 'ready')
    // 本地专辑首读恢复事件结束。
    if (event.event === 'core.ready') {
      resetAuthorizedLoadStarted()
      loadAuthorizedLibraryWhenReady()
      if (currentView.value === 'roon-artists' && catalog.artistSource.value === 'local') void catalog.loadArtists()
      if (currentView.value === 'search' && catalog.query.value) for (const kind of ['artists', 'albums', 'tracks'] as const) void catalog.readSearch('local', kind)
    }
    if (
      (event.event === 'core.ready' || event.event === 'roon.changed')
      && isCoreRuntimeStable(event.payload.state.runtime, remoteCoreState.value.status)
    ) {
      loadAuthorizedLibraryWhenReady()
      zoneRefreshCoordinator.handleCoreEvent(event.event, event.payload.state.roon)
      if (currentView.value === 'search') search.resume()
    }
    if (
      (event.event === 'core.ready' || event.event === 'roon.changed')
      && isCoreRuntimeStable(event.payload.state.runtime, remoteCoreState.value.status)
      && shouldRefreshVisibleRoonCollection(
        event.event,
        previousRoonStatus,
        event.payload.state.roon,
      )
    ) {
      refreshVisibleRoonCollection()
    }
    if (event.event === 'auth.changed') {
      invalidatePageCaches(['netease'])
      applyAuthState(event.payload.state)
      loadAuthorizedLibraryWhenReady()
    }
    if (event.event === 'account.changed') {
      invalidatePageCaches(['netease'])
      netease.resetPrivateLibraryState(false)
      journey.resetPrivatePath()
      playback.invalidateCollectionOperation()
      recentTracks.value = []
      applyAccountState(event.payload.state)
      netease.loadAuthorizedLibraryWhenReady({ accountStateCurrent: true })
      search.invalidateAccountScope()
      if (currentView.value === 'search') search.resume()
    }
    if (event.event === 'playback.changed') {
      playback.acceptPlaybackEvent(event.payload.state)
    }
    if (event.event === 'lyrics.changed') playback.onLyricsChanged(event.payload.state)
    if (event.event === 'lyrics.match.changed') playback.onLocalMatchChanged(event.payload.state)
    if (event.event === 'diagnostic.notice') diagnosticNotice.value = event.payload
  },
  initialize: async read => {
    void playback.initializeLocalLyricsMatch()
    const appInfoResult = await read(() => window.musicBridge.getAppInfo())
    if (!appInfoResult.active) return
    appInfo.value = appInfoResult.value
    const storedQuality = window.localStorage.getItem('musicbridge.qualityPreference')
    if (['auto', 'standard', 'exhigh', 'lossless', 'hires'].includes(storedQuality ?? '')) {
      selectedQuality.value = storedQuality as PlaybackQualityPreference
    }
    const remoteResult = await read(() => window.musicBridge.getRemoteCoreState())
    if (!remoteResult.active) return
    remoteCoreState.value = remoteResult.value
    remoteSshTarget.value = restoreRemoteTarget(remoteCoreState.value.sshTarget, window.localStorage)
    remoteAutoStart.value = window.localStorage.getItem('musicbridge.remoteCore.autoStart') === '1'
    // 首次自动连接由Main在首代Core之前完成；此处只恢复设置显示。
    const coreResult = await read(() => window.musicBridge.getCoreHealth())
    if (!coreResult.active) return
    coreState.value = coreResult.value
    const authResult = await read(() => window.musicBridge.getAuthState())
    if (!authResult.active) return
    applyInitialAuthState(authResult.value)
    if (authResult.value.status !== 'authorized') {
      const accountResult = await read(loadAccountState)
      if (!accountResult.active) return
    }
    if (isCoreRuntimeStable(coreState.value.runtime, remoteCoreState.value.status)) {
      const playbackResult = await read(() => playback.initializePlaybackStream())
      if (!playbackResult.active) return
      await read(loadZones)
    }
  },
  onInitializationError: error => {
    coreError.value = true
    recordActionError(error)
  },
})

onMounted(() => lifecycle.start())

onUnmounted(() => {
  catalogActionGeneration++; catalogAlbumNavigation.dispose(); catalog.dispose(); catalogData.dispose()
  inspectionDisposed=true;invalidateResultInspections()
  pageCache.dispose()
  lifecycle.dispose()
  zoneRefreshCoordinator.dispose()
  journey.dispose()
  netease.dispose()
  search.dispose()
  browse.dispose()
  playback.dispose()
  coverDropPageEntry.dispose()
  workbench.dispose(); workbenchLibrary.dispose(); workbenchLyrics.dispose(); albumBrowser.dispose(); coverDropBrowser.dispose()
  localLibrary.dispose()
  roonArtworkCache.clear()
  inspectorReturnFocus.value = null
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})
</script>

<template>
  <main class="app-shell" :class="{ 'is-now-playing': isImmersiveNowPlaying }" data-ui-reference="simple-music-player-2">
    <AlbumAmbientBackground :current-track="currentTrack" />
    <div class="app-main">
      <MusicSidebar
        v-if="!isImmersiveNowPlaying"
        :expanded="sidebar.expanded.value"
        :active-source="sidebar.activeSource.value"
        :search-query="catalog.draft.value"
        search-label="搜索歌曲、专辑或艺术家"
        :search-suggestions="catalog.suggestions.value"
        :search-pending="catalog.previewPending.value > 0"
        :search-message="catalog.previewMessage.value"
        :playlists="playlists"
        :playlist-state="playlistState"
        :source-scroll-top="sidebar.sourceScrollTop.value"
        :settings-active="currentView === 'settings'"
        :collection-view="collectionView"
        @toggle="sidebar.toggleExpanded"
        @navigate="navigateCatalogSource"
        @navigate-collection="navigateCollection"
        @update:search-query="updateCatalogDraft"
        @suggest-query="catalog.preview"
        @submit-query="submitCatalogSearch"
        @select-suggestion="selectCatalogSuggestion"
        @clear-search="updateCatalogDraft('')"
        @retry-playlists="loadPlaylists"
        @scroll-source="sidebar.setSourceScrollTop"
        @settings="navigate('settings')"
      />

      <section class="workspace" :class="{ 'is-immersive': isImmersiveNowPlaying }">
      <div class="workspace-body" :class="{ 'is-immersive': isImmersiveNowPlaying }">
      <div ref="contentScroll" class="content-scroll" :class="{ 'is-immersive': isImmersiveNowPlaying, 'is-coverdrop': currentView === 'coverdrop' }">
        <HomeView
          v-if="currentView === 'home'"
          :liked-tracks="likedPage.items"
          :recent-tracks="homeTracks"
          :liked-state="likedHomeState"
          :liked-error="likedError"
          :playlist-tracks="homePlaylistTracks"
          :playlist-recommendations-state="homeRecommendationState"
          :daily-day-key="dailyRecommendations.dayKey"
          :daily-tracks="dailyRecommendations.tracks"
          :daily-state="dailyState"
          :daily-authenticated="authState.status === 'authorized'"
          :daily-error="dailyError"
          :greeting="greeting"
          @navigate="navigate"
          @play="playTrack"
          @refresh-playlists="refreshHomeRecommendations"
          @play-daily="playTrack"
          @play-all-daily="playAllDailyRecommendations"
          @view-all-daily="navigate('daily-recommendations')"
          @open-settings="navigate('settings')"
          @retry-daily="refreshAccountProfile"
        />

        <LocalLibraryView @open-settings="navigate('settings')" :scan-jobs="initialScanJobs" :scan-status-error="initialScanStatusError" @updated="refreshLocalBrowserViews" v-else-if="currentView === 'local-library'" ref="localLibraryViewRef" v-model:view-mode="localLibraryViewMode" v-model:selected-track-id="localLibrarySelectedTrackId" :album-back-label="catalogAlbumNavigation.backLabel.value" @back-album="catalogAlbumNavigation.back" @select-album="catalogAlbumNavigation.clear" :workbench-entry-error="workbenchEntryError" :workbench-opening="workbenchOpening" external-relocation-dialog external-maintenance-dialogs external-session-lifecycle :browser="albumBrowser" :workspace="workbenchLibrary" @workbench="openAlbumWorkbench" @workbench-batch="openAlbumWorkbenchBatch" :session="localLibrary" :playback-state="playbackState" @open-queue="openQueue" @open-outbox="commandOutboxOpen = true" />

        <CoverDropView v-else-if="currentView === 'coverdrop'" ref="coverDropViewRef" :workbench-entry-error="workbenchEntryError" :workbench-opening="workbenchOpening" :session="localLibrary" :browser="coverDropBrowser" :workspace="workbenchLibrary" :model="workbench" :lyrics="workbenchLyrics" :lyrics-inspection="workbenchLyrics.resultInspection.value" :library-inspection="libraryResultInspection" :playback-state="playbackState" @open-queue="openQueue" @open-outbox="commandOutboxOpen = true" @workbench="openAlbumWorkbench" @workbench-batch="openAlbumWorkbenchBatch" @inspect-lyrics-result="inspectLyricsResult" @close-lyrics-inspection="closeLyricsResultInspection" @inspect-library-result="inspectLibraryResult" @close-library-inspection="closeLibraryResultInspection" @updated="refreshLocalBrowserViews" />

        <CollectionView
          v-else-if="currentView === 'collection'"
          ref="collectionViewRef"
          v-model="collectionView"
          :return-location="collectionReturnLocation"
          @start-recording="startRecordingFromCollection"
          @open-reservation="openReservationFromCollection"
        />

        <RecordingView
          v-else-if="currentView === 'recording'"
          ref="recordingViewRef"
          :reload-required="recordingReloadRequired"
          :initial-physical="recordingInitialPhysical"
          :reservation-navigation="recordingReservationNavigation"
          @initial-physical-consumed="recordingInitialPhysical = undefined"
          @reservation-navigation-consumed="recordingReservationNavigation = undefined"
          @reload-required="recordingReloadRequired = true"
          @open-collection="openCollectionFromRecording"
        />

        <DailyRecommendationsView
          v-else-if="currentView === 'daily-recommendations'"
          :day-key="dailyRecommendations.dayKey"
          :tracks="dailyRecommendations.tracks"
          :state="dailyState"
          :error="dailyError"
          @back="navigate('home')"
          @play="playTrack"
          @queue="appendTrack"
          @play-all="playAllDailyRecommendations"
          @retry="refreshAccountProfile"
        />

        <section v-else-if="currentView === 'roon-albums'" class="view" aria-labelledby="roon-albums-heading">
          <div class="view-heading">
            <div><p class="section-kicker">本地音乐库</p><h2 id="roon-albums-heading">专辑</h2><p class="lede">在本地专辑中搜索，不包含网易云结果。</p></div>
          </div>
          <p v-if="localAlbumQuery.trim()" class="local-search-summary">“{{ localAlbumQuery.trim() }}”的本地专辑 <button type="button" class="text-button" @click="setLocalAlbumQuery('')">清除搜索</button></p>
          <LibraryRefreshNotice :message="browse.roonAlbumsRefreshError.value" @retry="retryRoonAlbums" />
          <RoonAlbumGrid
            :searching="!!localAlbumQuery.trim()"
            :page="roonAlbumsPage"
            :initial-loading="roonAlbumsInitialLoading"
            :loading-more="roonAlbumsLoadingMore"
            :load-more-error="roonAlbumsLoadMoreError"
            :error="roonAlbumsError"
            @select="openRoonLibraryItem"
            @retry="retryRoonAlbums"
            @load-more="loadMoreRoonAlbums"
          />
        </section>

        <section v-else-if="currentView === 'roon-artists'" class="view" aria-label="艺术家">
          <CatalogWorkspace :model="catalog" mode="artists" :busy="playbackStartPending || catalogActionPending || !!catalogLocalUnconfirmed" @select="openCatalogItem" @play="playCatalogItem($event)" @queue="playCatalogItem($event, 'APPEND_MB_QUEUE')" @next="playCatalogItem($event, 'PLAY_NEXT_MB_QUEUE')" @load-roon="loadRoonArtists()">
            <template #roon>
              <label class="catalog-roon-search"><span class="visually-hidden">搜索 Roon 艺术家</span><input type="search" :value="localArtistQuery" placeholder="搜索 Roon 艺术家" maxlength="200" @input="!($event as InputEvent).isComposing && setLocalArtistQuery(($event.target as HTMLInputElement).value)" @compositionend="setLocalArtistQuery(($event.target as HTMLInputElement).value)" /></label>
              <LibraryRefreshNotice :message="browse.roonArtistsRefreshError.value" @retry="retryRoonArtists" />
              <RoonEntityGrid :page="roonArtistsPage" entity-label="艺术家" :empty-title="localArtistQuery.trim() ? '没有匹配的 Roon 艺术家' : '还没有可显示的 Roon 艺术家'" :empty-copy="localArtistQuery.trim() ? '换一个关键词，或清除搜索查看全部艺术家。' : 'Roon Core 当前返回 0 位艺术家。'" :initial-loading="roonArtistsInitialLoading" :loading-more="roonArtistsLoadingMore" :load-more-error="roonArtistsLoadMoreError" :error="roonArtistsError" @select="openRoonLibraryItem" @retry="retryRoonArtists" @load-more="loadMoreRoonArtists" />
            </template>
          </CatalogWorkspace>
        </section>

        <section v-else-if="currentView === 'roon-genres'" class="view" aria-labelledby="roon-genres-heading">
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-genres-heading">流派</h2><p class="lede">选择流派后读取其中真实的专辑与曲目。</p></div></div>
          <LibraryRefreshNotice :message="browse.roonGenresRefreshError.value" @retry="retryRoonGenres" />
          <RoonEntityGrid
            :page="roonGenresPage"
            entity-label="流派"
            empty-title="还没有可显示的流派"
            empty-copy="Roon Core 当前返回 0 个流派。请在 Roon 中检查存储位置与资料库内容后重新读取。"
            :initial-loading="roonGenresInitialLoading"
            :loading-more="roonGenresLoadingMore"
            :load-more-error="roonGenresLoadMoreError"
            :error="roonGenresError"
            @select="openRoonLibraryItem"
            @retry="retryRoonGenres"
            @load-more="loadMoreRoonGenres"
          />
        </section>

        <section v-else-if="currentView === 'roon-playlists'" class="view" aria-labelledby="roon-playlists-heading">
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-playlists-heading">Roon 歌单</h2><p class="lede">选择歌单后读取真实 Roon Playlist 曲目。</p></div></div>
          <LibraryRefreshNotice :message="browse.roonPlaylistsRefreshError.value" @retry="retryRoonPlaylists" />
          <RoonEntityGrid
            :page="roonPlaylistsPage"
            entity-label="歌单"
            empty-title="还没有可显示的 Roon 歌单"
            empty-copy="Roon Core 当前返回 0 个歌单。请在 Roon 中检查存储位置与资料库内容后重新读取。"
            :initial-loading="roonPlaylistsInitialLoading"
            :loading-more="roonPlaylistsLoadingMore"
            :load-more-error="roonPlaylistsLoadMoreError"
            :error="roonPlaylistsError"
            @select="openRoonLibraryItem"
            @retry="retryRoonPlaylists"
            @load-more="loadMoreRoonPlaylists"
          />
        </section>

        <section v-else-if="currentView === 'roon-favorites'" class="view" aria-labelledby="roon-favorites-heading">
          <div class="view-heading"><div><p class="section-kicker">本地音乐库</p><h2 id="roon-favorites-heading">收藏</h2><p class="lede">收藏关系由 Mousa 本地保存，不会删除或移动 Roon Library 媒体。</p></div></div>
          <div class="button-row favorite-kind-tabs" role="tablist" aria-label="本地收藏分类">
            <button type="button" class="secondary-button" :class="{ 'is-selected': favoriteKind === 'track' }" role="tab" :aria-selected="favoriteKind === 'track'" @click="setFavoriteKind('track')">喜欢的歌曲</button>
            <button type="button" class="secondary-button" :class="{ 'is-selected': favoriteKind === 'album' }" role="tab" :aria-selected="favoriteKind === 'album'" @click="setFavoriteKind('album')">喜欢的专辑</button>
            <button type="button" class="secondary-button" :class="{ 'is-selected': favoriteKind === 'artist' }" role="tab" :aria-selected="favoriteKind === 'artist'" @click="setFavoriteKind('artist')">喜欢的艺术家</button>
          </div>
          <FavoriteEntityGrid
            :key="favoriteResolutionEpoch"
            :scope-key="String(roonGridScopeEpoch)"
            :page="favoritesPage"
            :kind="favoriteKind"
            :initial-loading="favoritesInitialLoading"
            :loading-more="favoritesLoadingMore"
            :load-more-error="favoritesLoadMoreError"
            :error="favoritesError"
            @select="openFavorite"
            @remove="removeFavorite"
            @retry="retryFavorites"
            @load-more="favoritesPageAt(favoritesPage.offset + favoritesPage.limit)"
          />
        </section>

        <section v-else-if="currentView === 'roon-artist-detail' && selectedRoonArtist" class="view" aria-labelledby="roon-artist-heading">
          <button type="button" class="back-link" @click="returnFromRoonDetail('artist')">← {{ roonDetailBackLabel }}</button>
          <div class="view-heading"><div><p class="section-kicker">Roon 艺术家</p><h2 id="roon-artist-heading">{{ selectedRoonArtist.title }}</h2><p class="lede">只显示该艺术家在 Roon Library 中的真实专辑。</p><button type="button" class="secondary-button detail-favorite-button" :disabled="roonArtistFavoriteState === 'loading'" :aria-pressed="roonArtistFavoriteState === 'liked'" @click="toggleRoonEntityFavorite('artist')">{{ roonArtistFavoriteState === 'liked' ? '♥ 已收藏' : '♡ 收藏艺术家' }}</button></div></div>
          <LibraryRefreshNotice :message="browse.detailRefreshErrors.value.artist" @retry="loadRoonArtist(selectedRoonArtist.reference, undefined, false, true)" />
          <RoonAlbumGrid
            :page="selectedRoonArtistPage"
            :initial-loading="roonArtistInitialLoading"
            :loading-more="roonArtistLoadingMore"
            :load-more-error="roonArtistLoadMoreError"
            :error="roonArtistError"
            @select="roonSearchOrigin ? selectAggregatedRoonItem($event) : openRoonLibraryItem($event)"
            @retry="loadRoonArtist(selectedRoonArtist.reference)"
            @load-more="roonArtistPageAt(nextRoonPageOffset(selectedRoonArtistPage))"
          />
        </section>

        <template v-else-if="currentView === 'roon-album-detail' && selectedRoonAlbum">
          <LibraryRefreshNotice :message="browse.detailRefreshErrors.value.album" @retry="retryRoonAlbum" />
          <RoonAlbumDetail
            :album="selectedRoonAlbum"
            :back-label="roonDetailBackLabel"
            :page="selectedRoonAlbumPage"
            :initial-loading="roonAlbumInitialLoading"
            :loading-more="roonAlbumLoadingMore"
            :load-more-error="roonAlbumLoadMoreError"
            :error="roonAlbumError"
            :favorite-state="roonAlbumFavoriteState"
            :playback-pending="playbackStartPending"
            @play-all="selectedRoonAlbumPage.items[0] && playRoonLibraryTrack(selectedRoonAlbumPage.items[0])"
            @back="returnFromRoonDetail('album')"
            @play="playRoonLibraryTrack"
            @queue="queueRoonLibraryTrack"
            @toggle-favorite="toggleRoonEntityFavorite('album')"
            @retry="retryRoonAlbum"
            @load-more="roonAlbumPageAt(nextRoonPageOffset(selectedRoonAlbumPage))"
          />
        </template>

        <section v-else-if="currentView === 'roon-album-detail' || currentView === 'roon-artist-detail'" class="view">
          <button type="button" class="back-link" @click="returnFromRoonDetail(currentView === 'roon-artist-detail' ? 'artist' : 'album')">← {{ roonDetailBackLabel }}</button>
          <p v-if="roonAlbumInitialLoading || roonArtistInitialLoading" role="status">正在读取详情资料…</p>
          <p v-else role="status">{{ roonAlbumError || roonArtistError || '详情身份尚未确认，请返回列表重新选择。' }}</p>
          <button v-if="currentView === 'roon-album-detail' && roonAlbumError" type="button" @click="retryRoonAlbum">重试读取详情</button>
        </section>

        <template v-else-if="currentView === 'roon-genre-detail' && selectedRoonGenre">
          <LibraryRefreshNotice :message="browse.detailRefreshErrors.value.genre" @retry="loadRoonGenre(selectedRoonGenre.reference, undefined, false, true)" />
          <RoonBrowseDetail
            :entity="selectedRoonGenre"
            :page="selectedRoonGenrePage"
            mode="genre"
            :initial-loading="roonGenreInitialLoading"
            :loading-more="roonGenreLoadingMore"
            :load-more-error="roonGenreLoadMoreError"
            :error="roonGenreError"
            @back="navigateSource({ type: 'roon-genres' })"
            @album="selectAggregatedRoonItem"
            @play="playRoonLibraryTrack"
            @queue="queueRoonLibraryTrack"
            @retry="loadRoonGenre(selectedRoonGenre.reference)"
            @load-more="roonGenrePageAt(nextRoonPageOffset(selectedRoonGenrePage))"
          />
        </template>

        <template v-else-if="currentView === 'roon-playlist-detail' && selectedRoonPlaylist">
          <LibraryRefreshNotice :message="browse.detailRefreshErrors.value.playlist" @retry="loadRoonPlaylist(selectedRoonPlaylist.reference, undefined, false, true)" />
          <RoonBrowseDetail
            :entity="selectedRoonPlaylist"
            :page="selectedRoonPlaylistPage"
            mode="playlist"
            :initial-loading="roonPlaylistInitialLoading"
            :loading-more="roonPlaylistLoadingMore"
            :load-more-error="roonPlaylistLoadMoreError"
            :error="roonPlaylistError"
            @back="navigateSource({ type: 'roon-playlists' })"
            @play="playRoonLibraryTrack"
            @queue="queueRoonLibraryTrack"
            @retry="loadRoonPlaylist(selectedRoonPlaylist.reference)"
            @load-more="roonPlaylistPageAt(nextRoonPageOffset(selectedRoonPlaylistPage))"
          />
        </template>

        <section v-else-if="currentView === 'search'" class="view view-search" aria-label="搜索结果">
          <CatalogWorkspace :model="catalog" mode="search" :busy="playbackStartPending || catalogActionPending || !!catalogLocalUnconfirmed" @select="openCatalogItem" @play="playCatalogItem($event)" @queue="playCatalogItem($event, 'APPEND_MB_QUEUE')" @next="playCatalogItem($event, 'PLAY_NEXT_MB_QUEUE')" />
        </section>

        <section v-else-if="currentView === 'liked'" class="view view-library view-liked" aria-labelledby="liked-heading">
          <div class="liked-hero">
            <div class="view-heading"><div><p class="section-kicker">Mousa</p><h2 id="liked-heading">我喜欢的音乐</h2><p class="lede">{{ likedPage.total }} 首歌曲</p></div><div class="button-row"><button type="button" class="primary-button" :disabled="!likedPage.items.length" @click="playAllLiked">播放全部</button><button type="button" class="secondary-button" :disabled="!likedPage.items.length" @click="appendAllLiked">加入队列</button></div></div>
          </div>
          <p v-if="likedError" class="persistent-error">{{ likedError === 'auth-required' ? '请先登录音乐服务，再打开我喜欢的音乐。' : likedError === 'auth-expired' ? '登录已过期，请从侧栏账户菜单重新登录。' : '我喜欢的音乐暂时不可用，请稍后重试。' }}<button type="button" class="inline-action" @click="loadLiked()">重试</button></p>
          <LibraryRefreshNotice :message="netease.likedRefreshError.value" @retry="loadLiked" />
          <TrackTable :tracks="likedPage.items" :initial-loading="likedInitialLoading" :loading-more="likedLoadingMore" :load-more-error="likedLoadMoreError" :total="likedPage.total" :has-more="likedPage.hasMore" empty-title="还没有喜欢的内容" empty-copy="登录网易云后，这里会显示你的收藏。" @play="playTrack" @queue="appendTrack" @play-next="insertTrackNext" @load-more="likedPageAt(likedPage.offset + likedPage.limit)" />
        </section>

        <section v-else-if="currentView === 'playlists'" class="view view-library" aria-labelledby="playlists-heading">
          <div class="view-heading"><div><p class="section-kicker">资料库</p><h2 id="playlists-heading">所有歌单</h2><p class="lede">你的网易云歌单直接来自当前 Provider 数据。</p></div></div>
          <p v-if="playlistState === 'error'" class="persistent-error">歌单暂时无法加载，请从侧栏歌单区域重试。</p>
          <LibraryRefreshNotice :message="netease.playlistListRefreshError.value" @retry="netease.loadPlaylists()" />
          <NeteasePlaylistGrid :playlists="playlists" :loading="playlistState === 'loading'" @select="playlist => navigateSource({ type: 'playlist', playlistId: playlist.id })" />
        </section>

        <section v-else-if="currentView === 'playlist-detail'" class="view view-playlist" aria-labelledby="playlist-heading">
          <button type="button" class="back-link" @click="navigateSource({ type: 'playlists' })">← 所有歌单</button>
          <p v-if="playlistDetailError === 'auth-required'" class="persistent-error">请先登录音乐服务，再打开歌单。</p>
          <p v-else-if="playlistDetailError === 'auth-expired'" class="persistent-error">登录已过期，请从侧栏账户菜单重新登录。</p>
          <p v-else-if="playlistDetailError === 'generic'" class="persistent-error">歌单暂时无法加载，请稍后重试。</p>
          <div v-if="playlistInitialLoading && !selectedPlaylist" class="empty-state"><span class="loading-line"></span><p>正在读取歌单…</p></div>
          <template v-else-if="selectedPlaylist">
            <div class="playlist-detail-hero">
              <SafeArtwork class="playlist-detail-art" :src="selectedPlaylist.artworkUrl" alt="" fallback="♫" />
              <div class="playlist-detail-copy"><p class="section-kicker">歌单</p><h2 id="playlist-heading">{{ selectedPlaylist.name }}</h2><p class="lede">{{ selectedPlaylist.description || '来自你的音乐收藏。' }}</p><span class="playlist-count">{{ selectedPlaylist.trackCount }} 首歌曲</span><div class="button-row"><button type="button" class="primary-button" :disabled="!selectedPlaylist.tracks.items.length" @click="playAllPlaylist">播放全部</button><button type="button" class="secondary-button" :disabled="!selectedPlaylist.tracks.items.length" @click="appendAllPlaylist">加入队列</button></div></div>
            </div>
            <LibraryRefreshNotice :message="netease.playlistRefreshError.value" :legacy="!selectedPlaylist.snapshotVersion" :pending="playlistInitialLoading" @retry="retryPlaylist" />
            <TrackTable v-model:scroll-top="playlistTableScrollTop" :tracks="selectedPlaylist.tracks.items" :initial-loading="playlistInitialLoading" :loading-more="playlistLoadingMore" :load-more-error="playlistLoadMoreError" :total="selectedPlaylist.tracks.total" :has-more="selectedPlaylist.tracks.hasMore" empty-title="歌单为空" empty-copy="这个歌单暂时没有可显示的歌曲。" @play="playPlaylistTrack" @queue="appendTrack" @play-next="insertTrackNext" @load-more="playlistPageAt(selectedPlaylist.tracks.offset + selectedPlaylist.tracks.limit)" />
          </template>
          <div v-else-if="playlistDetailError === null" class="empty-state"><p>选择一个歌单查看内容。</p></div>
          <button v-if="playlistDetailError" type="button" class="secondary-button" @click="retryPlaylist">重试</button>
        </section>

        <NowPlayingView
          v-else-if="currentView === 'now-playing'"
          :current-track="currentTrack"
          :playback-state="playbackState"
          :clock-identity="playbackClockIdentity"
          :lyrics-snapshot="lyricsSnapshot"
          :local-lyrics-match-state="localLyricsMatchState"
          :local-lyrics-match-busy="localLyricsMatchBusy"
          :local-lyrics-match-error="localLyricsMatchError"
          :quality-label="qualityLabel"
          :quality-notice="playbackState?.qualityNotice"
          :playback-issue-message="playbackIssueMessage"
          :track-like-state="trackLikeState"
          :track-like-available="playbackSource === 'netease' || nativeRoonHasNeteaseMatch || localTrackFavoriteDescriptor !== null"
          :playback-source="playbackSource"
          :seek-allowed="selectedZone?.seekAllowed === true && playbackSyncStatus === 'ready'"
          @back="exitNowPlaying"
          @previous="previousTrack"
          @toggle-playback="togglePlayback"
          @next="nextTrack"
          @toggle-like="toggleTrackLike"
          @seek="seekPlayback"
          @select-lyrics-match="selectLocalLyricsMatch"
          @revoke-lyrics-match="revokeLocalLyricsMatch"
        />

        <SettingsView
          v-else-if="currentView === 'settings'"
          :app-info="appInfo"
          :workbench-library="workbenchLibrary"
          :local-relocation-session="localLibrary.relocationPlans"
          @updated="refreshLocalBrowserViews"
          @scan-observed="requestInitialScanRefresh(false)"
          @organize-library="openAlbumWorkbench({ action: 'overview' })"
          :auth-state="authState"
          :account-state="accountState"
          :zones="zones"
          :selected-zone="selectedZone"
          :roon-status="coreState?.roon ?? 'disconnected'"
          :zone-status="zoneLifecycleStatus"
          :selected-quality="selectedQuality"
          :auth-error="authError"
          :account-error="accountError"
          :remote-core-state="remoteCoreState"
          :remote-auto-start="remoteAutoStart"
          :remote-ssh-target="remoteSshTarget"
          @begin-login="beginQrLogin"
          @cancel-login="cancelQrLogin"
          @logout="logout"
          @refresh-account="refreshAccountProfile"
          @update:selected-quality="setSelectedQuality($event)"
          @select-zone="selectZone"
          @refresh-zones="loadZones"
          @diagnostics="navigate('diagnostics')"
          @start-remote-core="startRemoteCore"
          @stop-remote-core="stopRemoteCore"
          @reconnect-remote-core="reconnectRemoteCore"
          @update:remote-auto-start="updateRemoteAutoStart"
          @update:remote-ssh-target="updateRemoteSshTarget"
        >
          <template #application-tools>
            <button ref="commandOutboxTrigger" type="button" class="command-outbox-entry" aria-haspopup="dialog" @click="commandOutboxOpen = true">未确认操作</button>
          </template>
        </SettingsView>

        <section v-else class="view view-diagnostics" aria-labelledby="diagnostics-heading">
          <div class="view-heading"><div><p class="section-kicker">Read-only signal</p><h2 id="diagnostics-heading">Diagnostics</h2><p class="lede">这里只展示公开状态、可操作建议和诊断标识，不导出 Provider 原始内容。</p></div><div class="button-row"><button type="button" class="secondary-button" @click="refreshPlayback">刷新状态</button><button type="button" class="secondary-button" :disabled="diagnosticExportState === 'working'" @click="exportDiagnostics">{{ diagnosticExportState === 'working' ? '导出中…' : '导出诊断文件' }}</button></div></div>
          <p v-if="diagnosticExportState === 'done'" class="notice-card">诊断文件已导出，仅包含脱敏运行信息。</p>
          <p v-else-if="diagnosticExportState === 'cancelled'" class="notice-card">已取消诊断文件导出。</p>
          <p v-if="hasPlaybackIssue" class="persistent-error">{{ actionError ?? playbackState?.lastIssue?.message }}<span v-if="actionDiagnosticId ?? playbackState?.lastIssue?.diagnosticId">诊断标识：{{ actionDiagnosticId ?? playbackState?.lastIssue?.diagnosticId }}</span><button v-if="playbackState?.lastIssue?.retryable || actionError" type="button" class="inline-action" @click="retryAction">重试</button></p>
          <p v-if="diagnosticNotice" class="notice-card">{{ diagnosticNotice.code }}<span v-if="diagnosticNotice.message">{{ diagnosticNotice.message }}</span></p>
          <div class="diagnostic-grid"><article class="diagnostic-card"><span>Bridge Core</span><strong>{{ coreState?.runtime ?? 'starting' }}</strong><small>活动流 {{ coreState?.activeStreamCount ?? 0 }}</small></article><article class="diagnostic-card"><span>Roon</span><strong>{{ coreState?.roon ?? 'disconnected' }}</strong><small>{{ selectedZone?.displayName ?? '未选择 Zone' }}</small></article><article class="diagnostic-card"><span>Provider</span><strong>{{ coreState?.provider ?? 'missing' }}</strong><small>凭据状态仅显示公开枚举</small></article><article class="diagnostic-card"><span>Playback</span><strong>{{ playbackState?.state ?? 'idle' }}</strong><small>{{ coreState?.activePlaybackPresent ? '活动播放存在' : '无活动播放' }}</small></article></div>
          <div class="diagnostic-checks"><h3>安全边界</h3><ul><li>Renderer 无 Node / Electron 访问</li><li>导航与新窗口默认拒绝</li><li>控制与流端口保持 loopback-only</li><li>歌词只在内存中处理</li></ul></div>
        </section>
      </div>
      <PlaybackInspector
        v-if="inspectorOpen && !isImmersiveNowPlaying"
        :current-track="currentTrack"
        :playback-state="playbackState"
        :quality-label="qualityLabel"
        @close="closeInspector"
        @play-queue-item="playQueueItem"
        @edit-queue-entry="editQueueEntry"
      />
      </div>

      </section>
    </div>

    <BottomPlayer
      :clock-identity="playbackClockIdentity"
      :playback-ready="playbackSyncStatus === 'ready'"
      v-if="!isImmersiveNowPlaying"
      :current-track="currentTrack"
      :playback-state="playbackState"
      :zones="zones"
      :selected-zone="selectedZone"
      :roon-status="coreState?.roon ?? 'disconnected'"
      :zone-status="zoneLifecycleStatus"
      :selected-quality="selectedQuality"
      @seek="seekPlayback"
      @previous="previousTrack"
      @toggle-playback="togglePlayback"
      @next="nextTrack"
      @open-now-playing="openNowPlaying"
      @open-queue="openQueue"
      @select-zone="selectZone"
      @update:selected-quality="setSelectedQuality($event)"
    />

    <div v-if="toastMessage" class="toast" role="status" aria-live="polite">{{ toastMessage }}</div>
    <aside v-if="catalogPlaybackRecovery.message.value" class="catalog-playback-notice" role="status" aria-live="polite" aria-label="播放请求状态">
      <span>{{ catalogPlaybackRecovery.message.value }}</span>
      <button v-if="catalogLocalUnconfirmed" type="button" class="text-button" :disabled="catalogPlaybackRecovery.checking.value || playbackStartPending" @click="catalogPlaybackRecovery.check">{{ catalogPlaybackRecovery.checking.value ? '正在核对…' : '核对播放请求' }}</button>
      <button v-else type="button" class="text-button" aria-label="关闭播放请求提示" @click="catalogPlaybackRecovery.message.value = ''">关闭</button>
    </aside>
    <LocalLibraryWorkbench v-if="currentView !== 'coverdrop' && (workbench.isOpen.value || workbench.leavePrompt.value)" :model="workbench" :lyrics="workbenchLyrics" :workspace="workbenchLibrary" :lyrics-inspection="workbenchLyrics.resultInspection.value" :library-inspection="libraryResultInspection"
      @inspect-lyrics-result="inspectLyricsResult" @close-lyrics-inspection="closeLyricsResultInspection" @inspect-library-result="inspectLibraryResult" @close-library-inspection="closeLibraryResultInspection">
      <template #library><LocalLibrarySettings :workspace="workbenchLibrary" :relocation-session="localLibrary.relocationPlans" management-only @updated="refreshLocalBrowserViews" @scan-observed="requestInitialScanRefresh(false)" @organize="openAlbumWorkbench({ action: 'overview' })" /><section aria-label="全库智能名称解析"><button type="button" :disabled="workbenchLibrary.pending.value || !!workbenchLibrary.originalJob.value || !workbenchLibrary.selectedLibraryIds.value.length" @click="workbenchLibrary.startAi(workbenchLibrary.settings.value?.backend ?? 'ollama')">为选中整个库的缺封面专辑批量解析名称</button></section></template>
    </LocalLibraryWorkbench>
    <LocalArtworkDialog v-if="localLibrary.artwork.isOpen.value" :session="localLibrary.artwork" :source-writes-available="localLibrary.sourceWrites.capable" @source-writes="sourceFromArtwork" />
    <LocalOrganizerDialog v-if="localLibrary.organizer.isOpen.value" :session="localLibrary.organizer" :source-writes-available="localLibrary.sourceWrites.capable" @open-outbox="commandOutboxOpen = true" @return-focus="returnLocalMaintenanceFocus" @source-writes="sourceFromOrganizer" />
    <LocalSourceWritesDialog v-if="LocalSourceWritesDialog && localLibrary.sourceWrites.isOpen.value" :session="localLibrary.sourceWrites" @open-outbox="commandOutboxOpen = true" @return-focus="returnLocalMaintenanceFocus" @mb-only="openSourceMbOnly" @reacquire="reacquireSourceArtwork" />
    <LocalRelocationDialog v-if="LocalRelocationDialog && localLibrary.relocationPlans.isOpen.value" :session="localLibrary.relocationPlans" />
    <CommandOutboxPanel v-if="commandOutboxOpen" @close="closeCommandOutbox" @overview="localLibrary.observeOutbox" />

  </main>
</template>

<style scoped>
/* 独立页由实际主内容尺寸承载，播放器避让留在其内部滚动区。 */
.app-shell:not(.is-now-playing) .content-scroll.is-coverdrop { display: flex; overflow: hidden; padding: 0; scroll-padding-bottom: 0; }
.command-outbox-entry { min-height: 44px; padding: 8px 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; font-size: 13px; cursor: pointer; }
.command-outbox-entry:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
.catalog-roon-search { display: block; margin: 0 0 26px; }
.catalog-roon-search input { width: min(300px, 100%); padding: 10px 14px; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; font-size: 13px; }
.catalog-playback-notice { position: fixed; z-index: 45; top: 70px; right: 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; max-width: min(430px, calc(100vw - 32px)); padding: 14px 18px; border: 1px solid var(--mb-glass-border); border-radius: 14px; background: var(--mb-glass-strong); backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px); box-shadow: var(--mb-glass-shadow); color: var(--mb-text-primary); font-size: 12px; }
.catalog-playback-notice span { flex: 1 1 220px; line-height: 1.6; }
@media (hover: hover) and (pointer: fine) { .command-outbox-entry:hover { border-color: var(--mb-accent); } }
</style>
