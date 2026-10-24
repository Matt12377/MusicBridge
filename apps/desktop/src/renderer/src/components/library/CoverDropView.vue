<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { LocalAlbumTrackItem, LocalLibraryManagedRoot, PlaybackSnapshot } from '@music-bridge/contracts'
import type { TrustedDirectoryDropEvent } from '../../../../preload/local-workbench-client.js'
import type { useLocalLibrary } from '../../composables/application/useLocalLibrary.js'
import type { useLocalAlbumBrowser } from '../../composables/application/local-library-browser/useLocalAlbumBrowser.js'
import type { LocalAlbumArtworkWindow, LocalAlbumFilter, LocalAlbumSummary } from '../../composables/application/local-library-browser/types.js'
import type { LocalWorkbenchLibrary } from '../../composables/application/local-library-workbench/library.js'
import type { LocalWorkbenchLyrics } from '../../composables/application/local-library-workbench/lyrics.js'
import type { LocalWorkbenchController } from '../../composables/application/local-library-workbench/controller.js'
import type { LocalWorkbenchLyricsResultKey, LocalWorkbenchLyricsResultInspection, LocalWorkbenchLibraryResultKey, LocalWorkbenchLibraryResultInspection } from '../../composables/application/local-library-workbench/types.js'
import { localAlbumWorkbenchRequest, localAlbumWorkbenchBatchRequest, type LocalAlbumWorkbenchRequest, type LocalAlbumWorkbenchBatchRequest } from './local-browser/presentation.js'
import LocalAlbumGrid from './local-browser/LocalAlbumGrid.vue'
import SafeArtwork from '../SafeArtwork.vue'
import LocalLibraryWorkbench from './local-workbench/LocalLibraryWorkbench.vue'
import LocalLibrarySettings from '../settings/LocalLibrarySettings.vue'
import LocalAiSettings from '../settings/LocalAiSettings.vue'
import LocalLyricsReview from './local-workbench/LocalLyricsReview.vue'

const props = defineProps<{ session: ReturnType<typeof useLocalLibrary>; browser: ReturnType<typeof useLocalAlbumBrowser>; workspace: LocalWorkbenchLibrary; model: LocalWorkbenchController; lyrics: LocalWorkbenchLyrics; playbackState: PlaybackSnapshot | null; lyricsInspection?: LocalWorkbenchLyricsResultInspection | null; libraryInspection?: LocalWorkbenchLibraryResultInspection | null; workbenchEntryError?: string; workbenchOpening?: boolean }>()
const emit = defineEmits<{ 'open-queue': []; 'open-outbox': []; workbench: [request: LocalAlbumWorkbenchRequest]; 'workbench-batch': [request: LocalAlbumWorkbenchBatchRequest]; updated: []; 'inspect-lyrics-result': [key: LocalWorkbenchLyricsResultKey]; 'close-lyrics-inspection': []; 'inspect-library-result': [key: LocalWorkbenchLibraryResultKey]; 'close-library-inspection': [] }>()
const state = computed(() => props.browser.snapshot.value), libraries = computed(() => props.workspace.state.value?.libraries ?? [])
const focusedLibraryId = ref<string | null>(state.value.rootId && props.workspace.selectedLibraryIds.value.includes(state.value.rootId)
  && libraries.value.some(value => value.libraryId === state.value.rootId) ? state.value.rootId : null)
const focusedLibrary = computed(() => libraries.value.find(value => value.libraryId === focusedLibraryId.value) ?? null)
const heading = ref<HTMLElement | null>(null), wall = ref<HTMLElement | null>(null), detailHeading = ref<HTMLElement | null>(null)
const grid = ref<InstanceType<typeof LocalAlbumGrid> | null>(null), settings = ref<{ scanLibrary(request: { libraryRootId: string; expectedRootRevision: string }): Promise<void> } | null>(null)
const managementVisible = ref(false), searchExpanded = ref(false), queryDraft = ref(state.value.query)
const managementPane = ref<'scan' | 'ai'>('scan'), lyricsTrackId = ref<string | null>(null), lyricsSummaryVisible = ref(false)
const menu = shallowRef<{ libraryId: string; ids: readonly string[]; datasetId: string; left: number; top: number } | null>(null)
const renameTarget = shallowRef<LocalLibraryManagedRoot | null>(null), renameDraft = ref(''), removalIds = shallowRef<readonly string[]>([])
const uiError = ref(''), copyNotice = ref('')
let albumAnchor: string | null = null, active = false, generation = 0
const filters: readonly { id: LocalAlbumFilter; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'missing-artwork', label: '缺封面' }, { id: 'missing-lyrics', label: '缺少歌词' },
  { id: 'cue-unsplit', label: '未分轨' }, { id: 'metadata-issue', label: '标签异常' }, { id: 'track-named-audio', label: 'track音轨' },
  { id: 'has-artwork', label: '已有封面' }, { id: 'parse-failed', label: '解析失败' }, { id: 'loose-audio', label: '散落音频' },
]
const roleLabels = { catalog: '音乐库', artist: '歌手目录', album: '单张专辑', container: '包含多个音乐库' }
const scanLabels = { idle: '空闲', queued: '等待扫描', running: '扫描中', paused: '已暂停', complete: '空闲', failed: '扫描未完成', cancelled: '扫描已取消', offline: '目录离线' }
const focused = computed(() => props.model.focusedAlbum.value)
const selectedAlbumIds = computed(() => new Set(state.value.selectedAlbumIds ?? []))
const selectedAlbums = computed(() => state.value.items.filter(value => selectedAlbumIds.value.has(value.id)))
const matchingTracks = computed(() => {
  const captured = focused.value?.album, selected = state.value.selectedAlbum
  return captured && selected?.id === captured.albumId && selected.rootId === captured.rootId && selected.revision === captured.revision ? state.value.tracks : []
})
const detailCover = computed(() => {
  const selected = state.value.selectedAlbum, current = focused.value
  return props.model.selectedArtwork.value?.previewUrl ?? current?.currentArtwork?.previewUrl
    ?? (selected && current && selected.id === current.album.albumId ? state.value.artwork[selected.id]?.dataUrl : null) ?? undefined
})
const searchNames = computed(() => focused.value?.searchNames)
const displayQuery = computed(() => [searchNames.value?.cleaned.artist ?? focused.value?.album.artist, searchNames.value?.cleaned.title ?? focused.value?.album.title].filter(Boolean).join(' '))
const aiAvailable = computed(() => props.model.backendOptions.value.some(value => value.id === props.workspace.settings.value?.backend && value.availability.available))
const contextLibrary = computed(() => libraries.value.find(value => value.libraryId === menu.value?.libraryId) ?? null)
const originalAiRunning = computed(() => props.workspace.originalJob.value?.command === 'library.ai.start' && ['queued', 'running'].includes(props.workspace.job.value?.state ?? '')
  && props.workspace.originalJob.value.payload.captureId === props.workspace.capture.value?.captureId
  && !!menu.value && menu.value.ids.length === 1 && !!props.workspace.capture.value?.libraryIds.includes(menu.value.ids[0]!))
const finderReason = computed(() => { const value = props.model.existingAvailability('finder'); return value.available ? '' : value.reason })
const lyricsTracks = computed(() => {
  const scope = props.lyrics.scope.value, session = props.lyrics.session.value, album = focused.value?.album
  return scope && session && album && scope.albumId === album.albumId && scope.libraryId === album.rootId
    && session.scope.datasetId === scope.datasetId && session.scope.libraryId === scope.libraryId
    && session.scope.albumId === scope.albumId && session.scope.captureId === scope.captureId ? session.tracks : []
})
const lyricsCounts = computed(() => ({ existing: lyricsTracks.value.filter(value => value.presence === 'true').length,
  selected: lyricsTracks.value.filter(value => value.selectedCandidateId !== null).length,
  unknown: lyricsTracks.value.filter(value => value.presence === 'unknown').length }))

/** 只显示Owner回读的曲序与文件事实，不从标题、文件名或列表位置猜测。 */
function trackOrder(item: LocalAlbumTrackItem): string {
  return [item.disc === null ? '盘号未知' : `盘号 ${item.disc}`,
    item.trackNumber === null ? '曲序未知' : `曲序 ${item.trackNumber}`].join(' · ')
}
function trackFormat(item: LocalAlbumTrackItem): string {
  const parameters = item.facts.fileParameters
  if (!parameters) return '格式未确认'
  const format = parameters.container === parameters.codec ? parameters.container : `${parameters.container} / ${parameters.codec}`
  return [format, parameters.lossless === null ? '无损状态未知' : parameters.lossless ? '无损' : '有损',
    parameters.bitsPerSample === null ? '位深未知' : `${parameters.bitsPerSample} bit`,
    `${parameters.sampleRateHz.toLocaleString('zh-CN')} Hz`, `${parameters.channels} 声道`].join(' · ')
}
function trackDuration(item: LocalAlbumTrackItem): string {
  const segment = item.facts.track.segment, parameters = item.facts.fileParameters, asset = item.facts.asset
  // CUE只计算原段落的精确帧差，不能显示其整轨文件时长；帧号不经Number丢精度。
  const seconds = segment ? (BigInt(segment.endFrameExclusive) - BigInt(segment.startFrame)) / BigInt(segment.timebaseHz)
    : parameters?.durationMs !== null && parameters?.durationMs !== undefined ? BigInt(Math.floor(parameters.durationMs / 1000))
    : asset.sampleFrames !== null && asset.timebaseHz !== null ? BigInt(asset.sampleFrames) / BigInt(asset.timebaseHz) : null
  if (seconds === null) return '时长未知'
  const hours = seconds / 3600n, minutes = seconds / 60n % 60n, remainder = String(seconds % 60n).padStart(2, '0')
  return hours > 0n ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`
}

function returnMaintenanceFocus(): void { (detailHeading.value ?? heading.value)?.focus({ preventScroll: true }) }
function openManagementPanel(action: string): void { managementPane.value = action === 'ai-settings' ? 'ai' : 'scan'; managementVisible.value = true }
function isManagementOpen(): boolean { return active && managementVisible.value }
defineExpose({ returnMaintenanceFocus, openManagementPanel, isManagementOpen })
function openLyrics(trackId: string): void {
  if (!matchingTracks.value.some(value => value.facts.track.id === trackId) || props.model.mutationLocked.value) return
  lyricsTrackId.value = trackId; props.model.setAction('lyrics')
}
function libraryKeys(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !props.workspace.selectionLocked.value) {
    event.preventDefault(); props.workspace.selectLibraries(libraries.value.map(value => value.libraryId))
  }
}
function chooseLibrary(library: LocalLibraryManagedRoot, modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}): void {
  const id = library.libraryId, expected = props.workspace.state.value?.datasetId
  const choose = () => {
    if (!active || expected !== props.workspace.state.value?.datasetId || !libraries.value.some(value => value.libraryId === id) || props.workspace.selectionLocked.value || !props.model.close()) return
    if (modifiers.shiftKey) props.workspace.selectLibraryAt(id, true)
    else if (modifiers.metaKey || modifiers.ctrlKey) props.workspace.selectLibraryAt(id, false)
    else props.workspace.selectLibraries([id])
    focusedLibraryId.value = props.workspace.selectedLibraryIds.value.includes(id) ? id : props.workspace.selectedLibraryIds.value[0] ?? null
  }
  if (props.model.requestLeave(choose)) choose()
}
function showMenu(library: LocalLibraryManagedRoot, event: MouseEvent): void {
  event.preventDefault(); uiError.value = ''
  const datasetId = props.workspace.state.value?.datasetId
  if (!datasetId) return
  const ids = props.workspace.selectedLibraryIds.value.includes(library.libraryId) ? [...props.workspace.selectedLibraryIds.value] : [library.libraryId]
  menu.value = { libraryId: library.libraryId, ids: Object.freeze(ids), datasetId, left: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)), top: Math.max(8, Math.min(event.clientY, window.innerHeight - 330)) }
}
async function libraryAction(action: 'all' | 'scan' | 'snapshot' | 'retry-snapshot' | 'ai' | 'stop-ai' | 'rename' | 'remove'): Promise<void> {
  const current = menu.value
  if (!current || current.datasetId !== props.workspace.state.value?.datasetId || !current.ids.every(id => libraries.value.some(value => value.libraryId === id))) { menu.value = null; return }
  if (action !== 'stop-ai' && !props.model.requestLeave(() => { menu.value = current; void libraryAction(action) })) { menu.value = null; return }
  if (action !== 'stop-ai' && !props.model.close()) return
  const library = contextLibrary.value, ids = [...current.ids], stopOriginalAi = originalAiRunning.value
  menu.value = null
  if (action === 'all') { props.workspace.selectLibraries(libraries.value.map(value => value.libraryId)); return }
  if (!library || action !== 'stop-ai' && props.workspace.locked.value) return
  if (action === 'remove') { removalIds.value = ids; return }
  if (ids.length !== 1) return
  if (!props.workspace.selectedLibraryIds.value.includes(library.libraryId)) props.workspace.selectLibraries([library.libraryId])
  focusedLibraryId.value = library.libraryId
  if (action === 'rename') { renameTarget.value = library; renameDraft.value = library.label; return }
  if (action === 'scan') {
    const source = props.session.roots.value.find(value => value.root.id === library.libraryId)
    if (!source || source.availability !== 'ONLINE' || !settings.value) { uiError.value = '当前目录尚未核实，请先刷新库状态。'; return }
    await settings.value.scanLibrary({ libraryRootId: source.root.id, expectedRootRevision: source.root.revision })
  } else if (action === 'snapshot' || action === 'retry-snapshot') await props.workspace.snapshot(library.libraryId, action === 'snapshot' ? 'load' : 'retry')
  else if (action === 'ai' && aiAvailable.value && props.workspace.settings.value) await props.workspace.startAi(props.workspace.settings.value.backend)
  else if (action === 'stop-ai' && stopOriginalAi) await props.workspace.jobAction('stop')
  emit('updated')
}
async function renameLibrary(): Promise<void> { const target = renameTarget.value; if (target && await props.workspace.rename(target.libraryId, renameDraft.value)) renameTarget.value = null }
async function removeLibraries(): Promise<void> { const ids = [...removalIds.value]; if (ids.length && await props.workspace.remove(ids)) { removalIds.value = []; emit('updated') } }
function toggleAlbum(album: LocalAlbumSummary, event: MouseEvent): void {
  const ids = new Set(selectedAlbumIds.value), index = state.value.items.findIndex(value => value.id === album.id), anchor = state.value.items.findIndex(value => value.id === albumAnchor)
  if (event.shiftKey && anchor >= 0) for (const value of state.value.items.slice(Math.min(index, anchor), Math.max(index, anchor) + 1)) ids.add(value.id)
  else { if (ids.has(album.id)) ids.delete(album.id); else ids.add(album.id); albumAnchor = album.id }
  if (ids.size > 100) { uiError.value = '一次最多明确选择 100 张专辑；整个库请使用原全库任务。'; return }
  props.browser.setSelectedAlbums([...ids]); uiError.value = ''
}
function openAlbum(album: LocalAlbumSummary, event: MouseEvent): void {
  if (event.shiftKey || event.metaKey || event.ctrlKey) { toggleAlbum(album, event); return }
  props.browser.setScrollTop(wall.value?.scrollTop ?? state.value.scrollTop)
  emit('workbench', localAlbumWorkbenchRequest(album, 'overview'))
}
function openBatch(): void { if (selectedAlbums.value.length) emit('workbench-batch', localAlbumWorkbenchBatchRequest(selectedAlbums.value)) }
function startWholeLibraryAi(): void {
  const datasetId = props.workspace.state.value?.datasetId, backend = props.workspace.settings.value?.backend
  const ids = [...props.workspace.selectedLibraryIds.value]
  const start = () => {
    if (!active || !datasetId || !backend || !ids.length || props.workspace.state.value?.datasetId !== datasetId
      || props.workspace.settings.value?.backend !== backend || props.workspace.locked.value || props.workspace.originalJob.value
      || !aiAvailable.value || props.model.leaveLocked.value || ids.length !== props.workspace.selectedLibraryIds.value.length
      || ids.some((id, index) => id !== props.workspace.selectedLibraryIds.value[index] || !libraries.value.some(value => value.libraryId === id))) return
    props.model.openLibrary()
    void props.workspace.startAi(backend)
  }
  if (props.model.requestLeave(start)) start()
}
function returnFromArtworkSearch(): void {
  if (props.model.busy.value) return
  props.model.setAction('overview')
  void nextTick(() => detailHeading.value?.focus({ preventScroll: true }))
}
function closeDetail(): void {
  if (props.model.action.value === 'artwork') { returnFromArtworkSearch(); return }
  if (!props.model.requestLeave(closeDetail) || !props.model.close()) return
  props.browser.closeAlbum()
  void nextTick(() => { if (wall.value) wall.value.scrollTop = state.value.scrollTop; grid.value?.refresh(); returnMaintenanceFocus() })
}
function submitSearch(): void { void props.browser.setScope({ query: queryDraft.value, rootId: state.value.rootId, filter: state.value.filter }) }
function setFilter(filter: LocalAlbumFilter): void { searchExpanded.value = false; void props.browser.setScope({ query: state.value.query, rootId: state.value.rootId, filter }) }
function playTrack(trackId: string, action: 'PLAY_NOW' | 'APPEND_MB_QUEUE' | 'PLAY_NEXT_MB_QUEUE' = 'PLAY_NOW'): void {
  const track = matchingTracks.value.find(value => value.facts.track.id === trackId)
  if (!track || track.facts.track.segment !== null || props.session.actionBusy.value || focused.value?.availability !== 'online') return
  void props.session.playTrack(trackId, action)
}
async function copySearchQuery(): Promise<void> {
  const original = focused.value, value = displayQuery.value, owner = generation
  if (!original || !value) return
  try { await navigator.clipboard.writeText(value); if (active && owner === generation && focused.value === original && value === displayQuery.value) copyNotice.value = '搜索词已复制。' }
  catch { if (active && owner === generation && focused.value === original) copyNotice.value = '复制未完成，搜索词保留。' }
}
function updateArtworkWindow(window: LocalAlbumArtworkWindow): void {
  const selected = state.value.selectedAlbum, captured = focused.value?.album
  const matching = props.model.isOpen.value && selected && captured && selected.id === captured.albumId && selected.rootId === captured.rootId && selected.revision === captured.revision
  props.browser.setArtworkWindow(matching && selected ? { visible: [selected], nearby: [] } : window)
}
function retryDetail(revalidateArtwork = false): void {
  const album = focused.value?.album
  if (!album?.rootId || !album.revision) return
  const selected = state.value.selectedAlbum
  if (revalidateArtwork && selected?.id === album.albumId && selected.rootId === album.rootId && selected.revision === album.revision) { void props.browser.refreshAlbum(true); return }
  const opening = props.browser.openAlbumReference({ albumKey: album.albumId, rootId: album.rootId, revision: album.revision })
  if (revalidateArtwork) void opening.then(() => {
    const latest = state.value.selectedAlbum
    if (!active || focused.value?.album !== album || !latest || latest.id !== album.albumId || latest.rootId !== album.rootId || latest.revision !== album.revision) return
    updateArtworkWindow({ visible: [latest], nearby: [] }); return props.browser.retryArtwork(latest)
  })
}
function dismissMenu(event: Event): void { if (menu.value && !(event.target instanceof HTMLElement && event.target.closest('[data-coverdrop-library-menu]'))) menu.value = null }
watch(() => props.workspace.selectedLibraryIds.value, ids => { if (!focusedLibraryId.value || !ids.includes(focusedLibraryId.value)) focusedLibraryId.value = ids.find(id => libraries.value.some(value => value.libraryId === id)) ?? null }, { immediate: true })
watch(focusedLibraryId, id => { if (active) void props.browser.setScope({ query: state.value.query, rootId: id, filter: state.value.filter }) })
watch(() => state.value.query, value => { queryDraft.value = value })
watch(() => state.value.selectedAlbumIds, ids => { if (!ids?.length) albumAnchor = null })
watch(() => state.value.scrollTop, (top, previous) => {
  if (top !== 0 || previous === 0 || props.model.isOpen.value) return
  if (wall.value) wall.value.scrollTop = 0
  void nextTick(() => grid.value?.refresh())
})
watch(() => [state.value.active, props.model.isOpen.value, state.value.selectedAlbum ? JSON.stringify([state.value.selectedAlbum.id, state.value.selectedAlbum.rootId,
  state.value.selectedAlbum.editionId, state.value.selectedAlbum.representativeTrackId, state.value.selectedAlbum.revision]) : null,
  state.value.artworkInvalidation?.albumKey === null || state.value.artworkInvalidation?.albumKey === state.value.selectedAlbum?.id ? state.value.artworkInvalidation?.epoch : 0], () => {
  const selected = state.value.selectedAlbum, captured = focused.value?.album
  if (!state.value.active || !props.model.isOpen.value || !selected || !captured || selected.id !== captured.albumId || selected.rootId !== captured.rootId || selected.revision !== captured.revision) return
  updateArtworkWindow({ visible: [selected], nearby: [] })
  const status = state.value.artwork[selected.id]?.status ?? 'idle'
  if (status === 'idle' || status === 'ready') void props.browser.ensureArtwork(selected)
})
watch(() => focused.value?.album.albumId, () => { lyricsTrackId.value = null; lyricsSummaryVisible.value = false })
watch(() => props.model.action.value, value => { if (value !== 'lyrics') lyricsTrackId.value = null })
watch(() => [props.model.isOpen.value, focused.value?.capture.readToken], () => {
  const album = focused.value?.album, selected = state.value.selectedAlbum
  if (!active || !props.model.isOpen.value || !album?.rootId || !album.revision) return
  if (selected?.id !== album.albumId || selected.rootId !== album.rootId || selected.revision !== album.revision) retryDetail()
  void nextTick(() => detailHeading.value?.focus({ preventScroll: true }))
})
const directoryDragging=ref(false),nativeDropError=ref('')
const nativeImports=new Map<number,NonNullable<ReturnType<LocalWorkbenchLibrary['beginNativeImport']>>>()
let stopDirectoryDrop:(()=>void)|undefined
function receiveNativeDirectoryDrop(event:TrustedDirectoryDropEvent):boolean {
  directoryDragging.value=false
  if(event.phase==='start'){
    if(!active||props.model.mutationLocked.value||props.workbenchOpening)return false
    const finish=props.workspace.beginNativeImport();if(!finish)return false
    nativeImports.set(event.id,finish);nativeDropError.value='';managementVisible.value=true;managementPane.value='scan';return true
  }
  const finish=nativeImports.get(event.id);nativeImports.delete(event.id)
  if(!finish){if(active&&event.phase==='error')nativeDropError.value=event.message;return false}
  if(!active){finish(null);return false}
  if(event.phase==='error'){finish(null,true);nativeDropError.value=event.message;return false}
  return finish(event.choice)
}
onMounted(() => {
  active = true
  const native=(window as Window&{musicBridgeNative?:{subscribeDirectoryDrop(listener:(event:TrustedDirectoryDropEvent)=>boolean|void):()=>void}}).musicBridgeNative
  stopDirectoryDrop=native?.subscribeDirectoryDrop(receiveNativeDirectoryDrop)
  if (focusedLibraryId.value !== state.value.rootId) void props.browser.setScope({ query: state.value.query, rootId: focusedLibraryId.value, filter: state.value.filter })
  void props.browser.activate()
  void nextTick(() => { if (wall.value) wall.value.scrollTop = state.value.scrollTop; if (props.model.isOpen.value) retryDetail() })
  document.addEventListener('pointerdown', dismissMenu)
})
onUnmounted(() => { active = false; generation++; stopDirectoryDrop?.(); for(const finish of nativeImports.values())finish(null); nativeImports.clear(); props.browser.deactivate(); document.removeEventListener('pointerdown', dismissMenu) })
</script>

<template>
  <section class="coverdrop-workspace" data-testid="coverdrop-workspace" aria-labelledby="coverdrop-heading" @keydown.esc.stop="menu ? menu = null : model.isOpen.value ? closeDetail() : undefined">
    <aside class="coverdrop-libraries" :class="{ 'is-native-directory-drag': directoryDragging }" data-musicbridge-native-directory-drop :data-musicbridge-native-directory-available="!workspace.pending.value && !workspace.busy.value && !workspace.selectionLocked.value && !model.mutationLocked.value && !workbenchOpening" aria-label="CoverDrop 音乐库" @keydown="libraryKeys" @dragover="directoryDragging = !workspace.pending.value && !workspace.busy.value && !!$event.dataTransfer?.types.includes('Files')" @dragleave="directoryDragging = false">
      <p v-if="nativeDropError" class="coverdrop-native-drop-error" role="alert">{{ nativeDropError }}</p>
      <h1 id="coverdrop-heading" ref="heading" tabindex="-1"><i class="bi bi-music-note" aria-hidden="true"></i> CoverDrop</h1><p class="coverdrop-kicker">MUSIC LIBRARY</p>
      <div class="coverdrop-library-list" role="group" aria-label="持久音乐库选择">
        <button v-for="(library, index) in libraries" :key="library.libraryId" type="button" class="coverdrop-library" :class="{ 'is-selected': workspace.selectedLibraryIds.value.includes(library.libraryId) }" :aria-pressed="workspace.selectedLibraryIds.value.includes(library.libraryId)" :disabled="workspace.selectionLocked.value" @click="chooseLibrary(library, { shiftKey: $event.shiftKey, metaKey: $event.metaKey, ctrlKey: $event.ctrlKey })" @contextmenu="showMenu(library, $event)">
          <span class="coverdrop-library-dot" :style="{ background: ['#0a84ff','#30d158','#ff9f0a','#bf5af2','#5e5ce6'][index % 5] }"></span><i class="bi bi-folder-fill" aria-hidden="true"></i><span><strong>{{ library.label }}</strong><small>{{ roleLabels[library.role] }}</small></span><span v-if="library.latestSnapshotId" class="coverdrop-library-count">{{ library.totalAlbums.toLocaleString() }}</span>
        </button>
        <p v-if="!libraries.length && workspace.busy.value" role="status">正在读取音乐库…</p><p v-else-if="!libraries.length">尚未加入音乐库</p>
      </div>
      <footer class="coverdrop-sidebar-footer"><button type="button" aria-label="音乐库与解析设置" :aria-expanded="managementVisible" @click="managementVisible = !managementVisible"><i class="bi bi-gear" aria-hidden="true"></i></button><button type="button" aria-label="加入音乐文件夹" :disabled="workspace.pending.value || workspace.busy.value" @click="workspace.prepareImport(); managementVisible = true"><i class="bi bi-folder-plus" aria-hidden="true"></i></button></footer>
    </aside>
    <main class="coverdrop-main">
      <header class="coverdrop-library-header"><div><h2>{{ focusedLibrary?.label || '未选择音乐库' }}</h2><p>{{ focusedLibrary ? roleLabels[focusedLibrary.role] : '从左侧选择音乐库' }}</p><p>{{ focusedLibrary ? scanLabels[focusedLibrary.scanState] : '尚未扫描音乐库' }}<span v-if="focusedLibrary && !focusedLibrary.online"> · 源目录离线</span></p><p class="coverdrop-stat">{{ state.filter === 'all' ? '专辑数量' : filters.find(value => value.id === state.filter)?.label }} <strong>{{ state.loaded ? state.total.toLocaleString() : '—' }}</strong></p></div><div class="coverdrop-header-actions"><button type="button" aria-label="刷新 CoverDrop 专辑与封面" :disabled="!state.active || state.initialLoading || state.refreshing || workbenchOpening || model.isOpen.value || model.leavePrompt.value" @click="browser.refresh(true)"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> {{ state.refreshing ? '正在刷新…' : '刷新' }}</button><button type="button" aria-label="对完整所选音乐库智能解析" :disabled="workspace.locked.value || !!workspace.originalJob.value || !workspace.selectedLibraryIds.value.length || !aiAvailable || model.leaveLocked.value" @click="startWholeLibraryAi"><i class="bi bi-stars" aria-hidden="true"></i> 智能解析所选音乐库</button><button type="button" :disabled="workspace.pending.value || !workspace.selectedLibraryIds.value.length" @click="emit('workbench', { action: 'overview' })"><i class="bi bi-music-note-list" aria-hidden="true"></i> 批量获取歌词</button><small>先读取完整库，核对后保存</small><button v-if="selectedAlbums.length" type="button" @click="openBatch">整理明确选择的 {{ selectedAlbums.length }} 张</button><button type="button" @click="emit('open-queue')">播放队列</button></div></header>
      <p v-if="workbenchOpening" class="coverdrop-status" role="status">正在读取完整专辑范围…</p><p v-if="workbenchEntryError || uiError || workspace.error.value" class="coverdrop-error" role="alert">{{ workbenchEntryError || uiError || workspace.error.value }}</p><p v-if="workspace.notice.value" class="coverdrop-status" role="status">{{ workspace.notice.value }}</p>
      <p v-if="state.refreshError || state.stale && state.refreshing" class="coverdrop-error" role="alert">{{ state.refreshError || '正在重新读取专辑…' }} <button type="button" class="inline-action" :disabled="state.refreshing" @click="browser.refresh(true)">重试读取</button></p>
      <div ref="wall" class="coverdrop-wall content-scroll" @scroll="browser.setScrollTop(($event.target as HTMLElement).scrollTop)">
        <p v-if="!focusedLibrary && !state.rootId && !state.query" class="coverdrop-no-library">尚未扫描音乐库</p>
        <LocalAlbumGrid v-else ref="grid" :albums="state.items" :artwork="state.artwork" :artwork-invalidation="state.artworkInvalidation" :selected-album-ids="selectedAlbumIds" :active="state.active && !model.isOpen.value" :loaded="state.loaded" :initial-loading="state.initialLoading" :loading-more="state.loadingMore" :has-more="state.hasMore" :total="state.total" :error="state.error" :load-more-error="state.loadMoreError" :searching="!!state.query" :filtering="state.filter !== 'all'" :management-available="!!workspace.state.value" @select="openAlbum" @toggle-selection="toggleAlbum" @retry="browser.refresh(true)" @load-more="browser.loadMore()" @artwork-window="updateArtworkWindow" @ensure-artwork="browser.ensureArtwork($event)" @retry-artwork="browser.retryArtwork($event)" @workbench="emit('workbench', $event)" />
      </div>
      <form class="coverdrop-filter-bar" role="search" aria-label="CoverDrop 专辑筛选和搜索" @submit.prevent="submitSearch"><div class="coverdrop-filter-tabs" role="group" aria-label="CoverDrop 九种专辑筛选"><button v-for="filter in filters" :key="filter.id" type="button" :aria-pressed="state.filter === filter.id" :class="{ 'is-selected': state.filter === filter.id }" @click="setFilter(filter.id)">{{ filter.label }}</button></div><label v-if="searchExpanded" class="coverdrop-search"><span class="visually-hidden">CoverDrop 搜索</span><input v-model="queryDraft" type="search" maxlength="256" autocomplete="off" placeholder="搜索专辑、艺术家或版本"><button type="submit" aria-label="提交 CoverDrop 搜索"><i class="bi bi-search" aria-hidden="true"></i></button></label><button v-else type="button" class="coverdrop-search-toggle" aria-label="展开 CoverDrop 搜索" @click="searchExpanded = true"><i class="bi bi-search" aria-hidden="true"></i></button></form>
      <section v-show="managementVisible || !!workspace.importChoice.value" class="coverdrop-management-host" aria-label="音乐库与解析设置"><nav aria-label="CoverDrop 设置"><button type="button" class="coverdrop-management-close" @click="managementVisible = false">返回音乐库</button><button type="button" :aria-pressed="managementPane === 'scan'" @click="managementPane = 'scan'">扫描设置</button><button type="button" :aria-pressed="managementPane === 'ai'" @click="managementPane = 'ai'">智能解析</button></nav><div class="coverdrop-settings-content"><LocalLibrarySettings v-show="managementPane === 'scan' || !!workspace.importChoice.value" ref="settings" management-only :workspace="workspace" :relocation-session="session.relocationPlans" @updated="emit('updated')" @organize="managementVisible = false; emit('workbench', { action: 'overview' })" /><LocalAiSettings v-if="managementPane === 'ai' && !workspace.importChoice.value" :model="workspace" /></div></section>
      <div v-if="model.isOpen.value || model.leavePrompt.value" class="coverdrop-detail-backdrop" :class="{ 'is-leave-gate': model.leavePrompt.value }" @click.self="closeDetail">
        <section class="coverdrop-detail" :class="{ 'is-artwork-search': model.action.value === 'artwork' }" role="dialog" aria-modal="true" aria-labelledby="local-workbench-title">
          <LocalLibraryWorkbench presentation="page" artwork-source-presentation="original-tabs" :model="model" :lyrics="lyrics" :workspace="workspace" :lyrics-inspection="lyricsInspection" :library-inspection="libraryInspection" @inspect-lyrics-result="emit('inspect-lyrics-result', $event)" @close-lyrics-inspection="emit('close-lyrics-inspection')" @inspect-library-result="emit('inspect-library-result', $event)" @close-library-inspection="emit('close-library-inspection')">
            <template #header><header class="coverdrop-album-header"><SafeArtwork v-if="focused" :src="detailCover" :alt="focused.album.title + ' 封面'" class="coverdrop-album-cover" /><div class="coverdrop-album-information"><div class="coverdrop-album-title-row"><h2 id="local-workbench-title" ref="detailHeading" tabindex="-1">{{ focused?.album.title || (model.albums.value.length > 1 ? '明确选择的专辑' : '音乐库工作区') }}</h2><button type="button" :disabled="model.mutationLocked.value || !focused" @click="model.setAction('artwork')"><i class="bi bi-search" aria-hidden="true"></i> 搜索封面</button></div><div v-if="focused" class="coverdrop-pills"><span>{{ focused.album.trackCount ?? focused.album.trackIds.length }} 个音频</span><span v-if="focused.cueSheets.length">{{ focused.cueSheets.length }} 个 CUE</span><span>{{ focused.currentArtwork ? '已保存封面' : '封面待核对' }}</span></div><div v-if="focused" class="coverdrop-search-facts"><span>搜索词</span><strong>{{ displayQuery || '未提供' }}</strong><button type="button" aria-label="查询此专辑歌词" :disabled="model.mutationLocked.value" @click="model.setAction('lyrics')"><i class="bi bi-music-note" aria-hidden="true"></i></button><button type="button" aria-label="智能解析此专辑名称" :disabled="model.mutationLocked.value" @click="model.setAction('ai')"><i class="bi bi-stars" aria-hidden="true"></i></button><button type="button" aria-label="复制当前专辑搜索词" :disabled="!displayQuery" @click="copySearchQuery"><i class="bi bi-copy" aria-hidden="true"></i></button><span>原始名称</span><span class="coverdrop-original-name">{{ searchNames ? [searchNames.original.artist, searchNames.original.title].filter(Boolean).join(' / ') : focused.album.title }}</span><span>来源</span><span class="coverdrop-source-name">{{ focused.album.artist || '来源未提供艺术家' }} · {{ libraries.find(value => value.libraryId === focused?.album.rootId)?.label || '原捕获目录' }}</span></div><p v-if="copyNotice" role="status">{{ copyNotice }}</p><select v-if="model.albums.value.length > 1" :value="model.focusedAlbumId.value" aria-label="当前完整捕获专辑" :disabled="model.busy.value" @change="model.focusAlbum(($event.target as HTMLSelectElement).value)"><option v-for="album in model.albums.value" :key="album.albumId" :value="album.albumId">{{ album.artist }} · {{ album.title }}</option></select></div><button type="button" class="coverdrop-detail-close" :aria-label="model.action.value === 'artwork' ? '关闭封面搜索' : '关闭专辑详情'" @click="closeDetail"><i class="bi bi-x-lg" aria-hidden="true"></i></button></header></template>
            <template #navigation><nav class="coverdrop-detail-tools" aria-label="原整理功能"><button v-for="pane in [{ id: 'overview', label: '曲目' }, { id: 'artwork', label: '封面' }, { id: 'lyrics', label: '歌词' }, { id: 'ai', label: '智能解析' }, { id: 'cue', label: 'CUE 分轨' }, { id: 'organize', label: '信息与文件整理' }, { id: 'library', label: '整个音乐库' }] as const" :key="pane.id" type="button" :aria-pressed="model.action.value === pane.id" :disabled="model.busy.value" @click="model.setAction(pane.id)">{{ pane.label }}</button></nav></template>
            <template #overview><section class="coverdrop-track-section" aria-label="原捕获的曲目读取"><h3>曲目</h3><p v-if="state.detailLoading" role="status">正在读取此专辑曲目…</p><p v-if="state.detailError" role="alert">{{ state.detailError }} <button type="button" @click="retryDetail(true)">重试读取</button></p><ul><li v-for="track in matchingTracks" :key="track.facts.track.id"><button type="button" class="coverdrop-track-lyrics" aria-label="读取此曲目歌词与候选" :disabled="model.mutationLocked.value" @click="openLyrics(track.facts.track.id)"><i class="bi bi-music-note" aria-hidden="true"></i></button><div><strong>{{ track.facts.metadata.effective.title || '来源未提供曲名' }}</strong><small class="coverdrop-track-order">{{ trackOrder(track) }} · {{ track.facts.track.segment ? 'CUE 段落' : '整轨文件' }}<span v-if="track.statuses.includes('missing-lyrics')"> · 缺少歌词</span></small><small class="coverdrop-track-format">{{ trackFormat(track) }}</small></div><span class="coverdrop-track-duration" :aria-label="track.facts.track.segment ? 'CUE 段落时长' : '源文件时长'">{{ trackDuration(track) }}</span><div class="coverdrop-track-actions"><button type="button" :disabled="session.actionBusy.value || track.facts.track.segment !== null || focused?.availability !== 'online'" @click="playTrack(track.facts.track.id)">播放</button><button type="button" :disabled="session.actionBusy.value || track.facts.track.segment !== null || focused?.availability !== 'online'" @click="playTrack(track.facts.track.id, 'APPEND_MB_QUEUE')">入队</button><button type="button" :disabled="session.actionBusy.value || track.facts.track.segment !== null || focused?.availability !== 'online'" @click="playTrack(track.facts.track.id, 'PLAY_NEXT_MB_QUEUE')">下一首</button></div></li></ul><button v-if="state.tracksHasMore" type="button" :disabled="state.detailLoadingMore" @click="browser.loadMoreTracks()">读取更多原曲目</button></section></template>
            <template #lyrics><section class="coverdrop-lyrics-popover" :class="{ 'is-track-focused': !!lyricsTrackId }" aria-label="原专辑歌词与曲目候选"><header><h3>{{ matchingTracks.find(value => value.facts.track.id === lyricsTrackId)?.facts.metadata.effective.title || '此专辑歌词' }}</h3><button type="button" @click="model.setAction('overview')">返回曲目</button></header><LocalLyricsReview :model="lyrics" /></section></template>
            <template #library><p>当前完整库选择与原任务保留。</p><button type="button" :disabled="workspace.locked.value" @click="managementVisible = true">打开音乐库与解析设置</button></template>
            <template #artwork-search-return>
              <footer class="coverdrop-artwork-search-return" aria-label="封面搜索返回详情">
                <button type="button" :disabled="model.busy.value" @click="returnFromArtworkSearch">关闭</button>
                <button type="button" class="coverdrop-artwork-search-primary" :disabled="model.busy.value" @click="returnFromArtworkSearch"><i class="bi bi-arrow-left" aria-hidden="true"></i> 返回详情保存</button>
              </footer>
            </template>
            <template #footer>
              <div v-if="model.action.value === 'artwork'" hidden aria-hidden="true"></div>
              <footer v-else class="coverdrop-detail-footer"><button type="button" :disabled="model.mutationLocked.value || !model.existingAvailability('finder').available" :title="finderReason" @click="model.openExisting('finder')"><i class="bi bi-folder" aria-hidden="true"></i> 在 Finder 中显示</button><button type="button" class="coverdrop-lyrics-count" :aria-expanded="lyricsSummaryVisible" @click="lyricsSummaryVisible = !lyricsSummaryVisible">{{ lyricsTracks.length ? lyricsCounts.existing + ' / ' + lyricsTracks.length + ' 首已有歌词' : '歌词状态尚未读取' }}</button><section v-if="lyricsSummaryVisible" class="coverdrop-lyrics-summary" aria-label="原歌词命中统计"><h3>歌词命中统计</h3><p v-if="!lyricsTracks.length">原歌词会话尚未读取，候选与已读取曲目不充作本地命中。</p><template v-else><p>已有本地歌词 {{ lyricsCounts.existing }} 首 · 待保存选择 {{ lyricsCounts.selected }} 首 · 本地状态未知 {{ lyricsCounts.unknown }} 首</p><ul><li v-for="track in lyricsTracks" :key="track.trackId">{{ track.title }} · {{ track.presence === 'true' ? '已有歌词' : track.presence === 'false' ? '本地缺词' : '本地状态未知' }}</li></ul></template></section><button type="button" class="coverdrop-save" :disabled="!model.hasPendingChanges.value || model.leaveLocked.value" @click="model.savePending()">{{ model.savingAll.value ? '保存中…' : '保存' }}</button></footer></template>
          </LocalLibraryWorkbench>
        </section>
      </div>
    </main>
    <div v-if="menu" data-coverdrop-library-menu class="coverdrop-library-menu" role="menu" aria-label="音乐库操作" :style="{ left: menu.left + 'px', top: menu.top + 'px' }"><button type="button" role="menuitem" :disabled="workspace.selectionLocked.value" @click="libraryAction('all')">全选</button><button type="button" role="menuitem" :disabled="workspace.locked.value || menu.ids.length !== 1 || !contextLibrary?.online" @click="libraryAction('scan')">{{ contextLibrary?.latestSnapshotId ? '重新扫描' : '扫描' }}</button><button type="button" role="menuitem" :disabled="workspace.locked.value || menu.ids.length !== 1 || !contextLibrary?.latestSnapshotId" @click="libraryAction('snapshot')">加载上次扫描</button><button type="button" role="menuitem" :disabled="workspace.pending.value || menu.ids.length !== 1 || !contextLibrary?.latestSnapshotId || !aiAvailable" @click="libraryAction('ai')">智能解析</button><button type="button" role="menuitem" :disabled="menu.ids.length !== 1 || !originalAiRunning || workspace.writing.value" @click="libraryAction('stop-ai')">停止解析</button><button type="button" role="menuitem" :disabled="workspace.locked.value || menu.ids.length !== 1" @click="libraryAction('rename')">重命名</button><hr><button type="button" role="menuitem" class="coverdrop-destructive" :disabled="workspace.locked.value || !menu.ids.length" @click="libraryAction('remove')">移除</button></div>
    <div v-if="renameTarget" class="coverdrop-confirm-backdrop"><form class="coverdrop-confirm" role="dialog" aria-modal="true" aria-labelledby="coverdrop-rename-title" @submit.prevent="renameLibrary"><h2 id="coverdrop-rename-title">重命名音乐库</h2><label>本地显示名称<input v-model="renameDraft" maxlength="256" :disabled="workspace.locked.value"></label><button type="button" :disabled="workspace.locked.value" @click="renameTarget = null">取消</button><button type="submit" :disabled="workspace.locked.value || !renameDraft.trim()">保存</button></form></div>
    <div v-if="removalIds.length" class="coverdrop-confirm-backdrop"><section class="coverdrop-confirm" role="dialog" aria-modal="true" aria-labelledby="coverdrop-remove-title"><h2 id="coverdrop-remove-title">从 CoverDrop 移除 {{ removalIds.length }} 个音乐库？</h2><p>只删除本地记录、扫描快照和无引用缓存。源音乐、已保存封面/LRC及其他库引用保留。</p><button type="button" :disabled="workspace.locked.value" @click="removalIds = []">取消</button><button type="button" class="coverdrop-destructive" :disabled="workspace.locked.value" @click="removeLibraries">删除记录及缓存</button></section></div>
  </section>
</template>

<style scoped>
.coverdrop-libraries.is-native-directory-drag { outline:2px solid var(--accent-color); outline-offset:-3px; }
.coverdrop-native-drop-error { padding:8px; font-size:12px; color:var(--text-primary); overflow-wrap:anywhere; }
.coverdrop-workspace { --cd-bg:var(--mb-glass-strong); --cd-sidebar:var(--mb-glass-clear); --cd-raised:var(--mb-glass-clear); --cd-hover:var(--mb-accent-soft); --cd-text:var(--mb-text-primary); --cd-secondary:var(--mb-text-secondary); --cd-tertiary:var(--mb-text-tertiary); --cd-accent:var(--mb-accent); display:grid; grid-template-columns:220px minmax(0,1fr); min-width:0; min-height:0; width:100%; height:100%; flex:1; margin:0; position:relative; background:var(--cd-bg); color:var(--cd-text); border-radius:12px; overflow:hidden; }
.coverdrop-workspace button { font:inherit; color:inherit; cursor:pointer; }
.coverdrop-workspace button:disabled { opacity:.45; cursor:default; }
.coverdrop-workspace button:focus-visible,.coverdrop-workspace input:focus-visible,.coverdrop-workspace select:focus-visible,.coverdrop-workspace h1:focus-visible,.coverdrop-workspace h2:focus-visible { outline:2px solid var(--cd-accent); outline-offset:3px; }
.coverdrop-libraries { display:flex; flex-direction:column; min-height:0; padding:16px 10px 10px; background:var(--cd-sidebar); border-right:1px solid var(--mb-glass-border); }
.coverdrop-libraries h1 { display:flex; align-items:center; gap:8px; margin:0 6px 18px; font-size:16px; }
.coverdrop-libraries h1 i { color:var(--cd-accent); background:rgb(10 132 255 / .12); width:24px; height:24px; display:grid; place-content:center; border-radius:7px; }
.coverdrop-kicker { margin:0 6px 8px; font-size:11px; font-weight:600; color:var(--cd-tertiary); letter-spacing:.5px; }
.coverdrop-library-list { overflow:auto; flex:1; }
.coverdrop-library { display:flex; align-items:center; gap:8px; width:100%; min-height:40px; padding:5px 8px; margin:0 0 4px; border:0; border-radius:6px; background:transparent; text-align:left; }
.coverdrop-library.is-selected { color:var(--cd-accent); background:rgb(10 132 255 / .12); }
.coverdrop-library > span:has(strong) { display:grid; min-width:0; gap:2px; flex:1; }
.coverdrop-library strong { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:12px; }
.coverdrop-library small { color:var(--cd-secondary); font-size:10px; }
.coverdrop-library-dot { width:5px; height:5px; border-radius:50%; flex:none; }
.coverdrop-library-count { font-size:10px; font-variant-numeric:tabular-nums; padding:2px 5px; border-radius:4px; background:rgb(10 132 255 / .12); }
.coverdrop-sidebar-footer { display:flex; justify-content:space-between; padding-top:12px; padding-bottom:var(--mb-player-clearance); }
.coverdrop-sidebar-footer button { border:1px solid var(--mb-glass-border); border-radius:50%; width:32px; height:32px; background:var(--cd-raised); color:var(--cd-secondary); }
.coverdrop-main { position:relative; display:flex; flex-direction:column; min-width:0; min-height:0; }
.coverdrop-library-header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding:18px 20px 14px; border-bottom:1px solid var(--mb-divider); }
.coverdrop-library-header > div:first-child { min-width:0; }
.coverdrop-library-header h2 { margin:0; font-size:22px; font-weight:600; overflow-wrap:anywhere; }
.coverdrop-library-header p { margin:6px 0 0; font-size:11px; color:var(--cd-secondary); }
.coverdrop-library-header p.coverdrop-stat { margin-top:12px; }
.coverdrop-stat strong { margin-left:8px; color:var(--cd-text); font-size:16px; font-variant-numeric:tabular-nums; }
.coverdrop-header-actions { display:flex; flex-direction:column; align-items:flex-end; gap:6px; max-width:52%; min-width:0; flex-shrink:0; }
.coverdrop-header-actions button { max-width:100%; overflow-wrap:anywhere; min-height:28px; padding:5px 10px; border:1px solid var(--mb-glass-border); border-radius:6px; background:var(--cd-raised); font-size:11px; }
.coverdrop-header-actions small { color:var(--cd-tertiary); font-size:10px; }
.coverdrop-status,.coverdrop-error { padding:8px 20px; margin:0; font-size:12px; }
.coverdrop-error { color:var(--mb-warning,#ff9f0a); }
.coverdrop-workspace .coverdrop-wall.content-scroll { min-height:0; flex:1; overflow:auto; padding:16px 20px; scroll-padding-bottom:16px; position:relative; }
.coverdrop-no-library { position:absolute; inset:0; display:grid; place-content:center; color:var(--cd-tertiary); font-size:12px; }
.coverdrop-wall :deep(.local-album-grid.roon-album-grid) { display:grid; grid-template-columns:repeat(auto-fill,168px); justify-content:start; gap:16px; }
.coverdrop-wall :deep(.local-album-grid-entry) { width:168px; min-height:272px; }
.coverdrop-wall :deep(.roon-album-card) { padding:0; overflow:hidden; background:var(--cd-raised); border:1px solid var(--mb-glass-border); border-radius:12px; text-align:left; }
.coverdrop-wall :deep(.roon-album-art) { width:168px; height:168px; aspect-ratio:1; border-radius:0; box-shadow:none; }
.coverdrop-wall :deep(.roon-album-copy) { display:grid; min-height:104px; align-content:start; gap:6px; padding:8px; }
.coverdrop-wall :deep(.roon-album-copy strong) { font-size:12px; height:30px; line-height:15px; }
.coverdrop-wall :deep(.roon-album-copy small) { font-size:10px; color:var(--cd-secondary); }
.coverdrop-wall :deep(.local-album-select-action) { width:28px; height:28px; min-height:28px; top:4px; left:4px; background:var(--cd-raised); border-radius:6px; }
.coverdrop-wall :deep(.local-album-cover-action) { min-height:28px; padding:3px 6px; font-size:10px; background:var(--cd-raised); }
.coverdrop-filter-bar { position:relative; align-self:center; flex:0 0 auto; z-index:5; display:flex; flex-wrap:nowrap; align-items:center; gap:10px; width:max-content; max-width:calc(100% - 40px); margin:16px 20px calc(var(--mb-player-clearance) + 16px); padding:5px; border:1px solid var(--mb-glass-border); border-radius:28px; background:var(--mb-glass-strong); backdrop-filter:blur(24px); box-shadow:0 7px 16px rgb(0 0 0 / .2); }
.coverdrop-filter-tabs { min-width:0; flex:1 1 auto; display:flex; align-items:center; gap:3px; padding:3px; overflow:auto; white-space:nowrap; }
.coverdrop-filter-tabs button { flex:0 0 auto; min-height:34px; border:0; border-radius:20px; background:transparent; padding:0 12px; color:var(--cd-secondary); font-size:12px; }
.coverdrop-filter-tabs button.is-selected { color:var(--mb-on-accent); background:var(--cd-accent); box-shadow:inset 0 0 0 1px rgb(255 255 255 / .2); }
.coverdrop-search-toggle,.coverdrop-search button { border:1px solid var(--mb-glass-border); border-radius:50%; background:transparent; width:34px; height:34px; flex:none; }
.coverdrop-search { display:flex; align-items:center; gap:4px; }
.coverdrop-search input { min-width:120px; width:320px; max-width:28vw; border:0; border-radius:16px; background:var(--mb-glass-clear); color:var(--cd-text); padding:8px 10px; font:inherit; font-size:12px; }
.coverdrop-management-host { position:absolute; inset:0; overflow:auto; padding:16px 16px calc(var(--mb-player-clearance) + 16px); scroll-padding-bottom:calc(var(--mb-player-clearance) + 16px); background:var(--cd-bg); z-index:20; backdrop-filter:blur(24px); }
.coverdrop-management-host { display:grid; grid-template-columns:160px minmax(0,1fr); gap:24px; }
.coverdrop-management-host nav { display:flex; flex-direction:column; align-items:stretch; gap:8px; }
.coverdrop-management-host nav button { border:0; background:transparent; text-align:left; padding:8px; }
.coverdrop-management-host nav button[aria-pressed=true] { background:var(--cd-hover); color:var(--cd-accent); }
.coverdrop-settings-content { min-width:0; width:min(720px,100%); margin-inline:auto; }
.coverdrop-management-host :deep(.panel-heading) { flex-wrap:wrap; }
.coverdrop-management-host :deep(input:not([type=checkbox])),.coverdrop-management-host :deep(select) { max-width:100%; }
.coverdrop-management-close { min-height:32px; margin-bottom:12px; border:0; background:transparent; color:var(--cd-secondary); }
.coverdrop-management-host :deep(.settings-card) { background:var(--cd-raised); color:var(--cd-text); border-color:var(--mb-glass-border); box-shadow:none; }
.coverdrop-management-host :deep(button) { min-height:32px; border-radius:6px; }
.coverdrop-detail-backdrop { position:absolute; inset:0 0 var(--mb-player-clearance); display:grid; place-items:center; padding:18px; background:rgb(0 0 0 / .45); z-index:10; }
.coverdrop-detail-backdrop.is-leave-gate { z-index:40; }
.coverdrop-detail { width:min(816px,100%); max-height:min(624px,100%); overflow:auto; border:1px solid var(--mb-glass-border); border-radius:12px; background:var(--mb-glass-strong); backdrop-filter:blur(30px); box-shadow:0 10px 24px rgb(0 0 0 / .35); color:var(--cd-text); }
.coverdrop-detail.is-artwork-search { width:min(1100px,100%); max-height:min(700px,100%); }
.coverdrop-detail.is-artwork-search :deep(.workbench-artwork-layout) { align-items:stretch; }
.coverdrop-detail.is-artwork-search :deep(.workbench-artwork-sidebar) { display:flex; flex-direction:column; }
.coverdrop-detail :deep(.workbench-muted) { color:var(--cd-secondary); }
.coverdrop-detail :deep(.workbench-section) { padding:12px 24px; }
.coverdrop-detail :deep(.workbench-current-artwork) { width:160px; height:160px; }
.coverdrop-detail :deep(.workbench-leave-gate) { margin:12px; }
.coverdrop-album-header { display:flex; align-items:flex-start; gap:22px; padding:24px; position:relative; border-bottom:1px solid var(--mb-divider); }
.coverdrop-album-cover { width:200px; height:200px; flex:none; border-radius:8px; overflow:hidden; }
.coverdrop-album-information { flex:1; min-width:0; }
.coverdrop-album-title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.coverdrop-album-title-row h2 { font-size:18px; margin:0; line-height:1.4; overflow-wrap:anywhere; }
.coverdrop-album-title-row button { min-height:32px; border:1px solid var(--mb-glass-border); border-radius:8px; padding:0 12px; background:var(--cd-raised); color:var(--cd-secondary); font-size:12px; flex:none; }
.coverdrop-pills { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 12px; }
.coverdrop-pills span { padding:4px 7px; border-radius:12px; background:rgb(10 132 255 / .12); color:var(--cd-accent); font-size:10px; }
.coverdrop-search-facts { display:grid; grid-template-columns:auto minmax(0,1fr) repeat(3,28px); gap:10px; align-items:center; padding:12px 0; border-top:1px solid var(--mb-divider); border-bottom:1px solid var(--mb-divider); font-size:11px; color:var(--cd-secondary); }
.coverdrop-search-facts strong { min-width:0; font-weight:400; }
.coverdrop-search-facts button { width:28px; height:28px; border:0; background:transparent; color:var(--cd-secondary); }
.coverdrop-original-name,.coverdrop-source-name { grid-column:span 4; overflow-wrap:anywhere; }
.coverdrop-detail-close { position:absolute; top:6px; right:6px; border:0; background:transparent; color:var(--cd-tertiary); font-size:10px; }
.coverdrop-detail-tools { display:flex; gap:4px; overflow:auto; padding:8px 24px; border-bottom:1px solid var(--mb-divider); }
.coverdrop-detail-tools button { white-space:nowrap; border:0; background:transparent; min-height:28px; padding:3px 8px; font-size:11px; color:var(--cd-secondary); border-radius:6px; }
.coverdrop-detail-tools button[aria-pressed=true] { color:var(--cd-accent); background:rgb(10 132 255 / .12); }
.coverdrop-track-section h3 { margin:0 0 10px; color:var(--cd-tertiary); font-size:12px; }
.coverdrop-track-section ul { list-style:none; padding:0; margin:0; display:grid; gap:6px; }
.coverdrop-track-section li { display:flex; gap:10px; align-items:center; min-height:58px; padding:8px; border-radius:6px; background:var(--cd-raised); }
.coverdrop-track-section .coverdrop-track-lyrics { border:0; width:32px; height:32px; display:grid; place-content:center; border-radius:6px; background:var(--cd-hover); color:var(--cd-secondary); }
.coverdrop-track-section li > div:first-of-type { display:grid; gap:3px; min-width:0; flex:1; }
.coverdrop-track-section strong { font-size:12px; overflow-wrap:anywhere; }
.coverdrop-track-section small,.coverdrop-track-section li > span { color:var(--cd-tertiary); font-size:10px; }
.coverdrop-track-format { overflow-wrap:anywhere; }
.coverdrop-track-duration { flex:none; min-width:48px; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.coverdrop-track-actions { display:flex; gap:2px; }
.coverdrop-track-actions button { min-height:28px; border:0; border-radius:4px; background:transparent; color:var(--cd-secondary); padding:4px; font-size:10px; }
.coverdrop-artwork-search-return { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:auto; padding-top:12px; flex:0 0 auto; }
.coverdrop-artwork-search-return button { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:34px; padding:0 12px; border:1px solid var(--mb-glass-border); border-radius:6px; background:var(--cd-raised); color:var(--cd-text); font-size:12px; }
.coverdrop-artwork-search-return button.coverdrop-artwork-search-primary { border-color:var(--cd-accent); background:var(--cd-accent); color:var(--mb-on-accent); font-weight:600; }
.coverdrop-detail-footer { display:flex; gap:12px; align-items:center; position:sticky; bottom:0; padding:10px 12px; background:var(--mb-glass-strong); border-top:1px solid var(--mb-divider); z-index:2; font-size:11px; color:var(--cd-secondary); }
.coverdrop-lyrics-popover { width:min(760px,100%); max-height:480px; overflow:auto; padding:12px; }
.coverdrop-lyrics-popover > header { display:flex; justify-content:space-between; gap:12px; align-items:center; }
.coverdrop-lyrics-popover :deep(.workbench-lyrics-body) { max-height:280px; }
.coverdrop-lyrics-count { white-space:nowrap; }
.coverdrop-lyrics-summary { position:absolute; right:76px; bottom:48px; width:min(340px,calc(100% - 24px)); max-height:360px; overflow:auto; padding:16px; border:1px solid var(--mb-glass-border); border-radius:12px; background:var(--mb-glass-strong); backdrop-filter:blur(24px); box-shadow:0 8px 24px rgb(0 0 0 / .25); }
.coverdrop-lyrics-summary h3 { margin:0 0 8px; font-size:13px; }
.coverdrop-lyrics-summary ul { list-style:none; padding:0; display:grid; gap:8px; }
.coverdrop-detail-footer button { min-height:30px; border:0; background:transparent; }
.coverdrop-detail-footer button.coverdrop-save { margin-left:auto; padding:0 12px; border-radius:6px; background:var(--cd-accent); color:var(--mb-on-accent); font-weight:600; }
.coverdrop-library-menu { position:fixed; z-index:50; width:190px; padding:5px; border:1px solid var(--mb-glass-border); border-radius:8px; background:var(--mb-glass-strong); backdrop-filter:blur(20px); box-shadow:0 8px 24px rgb(0 0 0 / .3); }
.coverdrop-library-menu button { width:100%; min-height:28px; padding:4px 10px; text-align:left; border:0; border-radius:4px; background:transparent; font-size:12px; }
.coverdrop-library-menu hr { margin:4px 8px; border:0; border-top:1px solid var(--mb-divider); }
.coverdrop-confirm-backdrop { position:absolute; inset:0; display:grid; place-items:center; background:rgb(0 0 0 / .55); z-index:30; }
.coverdrop-confirm { width:min(420px,calc(100% - 32px)); padding:20px; border:1px solid var(--mb-glass-border); border-radius:12px; background:var(--mb-glass-strong); backdrop-filter:blur(20px); }
.coverdrop-confirm h2 { font-size:16px; }
.coverdrop-confirm label { display:grid; gap:8px; }
.coverdrop-confirm input { min-height:32px; padding:4px 8px; background:var(--mb-glass-clear); border:1px solid var(--mb-glass-border); color:var(--cd-text); }
.coverdrop-confirm button { margin:12px 8px 0 0; min-height:32px; padding:4px 10px; border:0; border-radius:6px; background:var(--cd-raised); }
.coverdrop-destructive { color:var(--mb-danger) !important; }
@media (hover:hover) and (pointer:fine) { .coverdrop-library:hover,.coverdrop-library-menu button:not(:disabled):hover,.coverdrop-detail-tools button:not(:disabled):hover { background:var(--cd-hover); } }
@media (max-width:1050px) { .coverdrop-workspace { grid-template-columns:180px minmax(0,1fr); } .coverdrop-header-actions small { max-width:160px; text-align:right; } .coverdrop-management-host { grid-template-columns:120px minmax(0,1fr); gap:12px; } }
@media (max-width:760px) { .coverdrop-workspace { grid-template-columns:140px minmax(0,1fr); margin:0; } .coverdrop-album-header { flex-wrap:wrap; padding:16px; } .coverdrop-album-cover { width:140px; height:140px; } .coverdrop-track-actions { flex-direction:column; } }
@media (prefers-reduced-motion:reduce) { .coverdrop-workspace :deep(*) { scroll-behavior:auto; transition:none; animation:none; } }
</style>
