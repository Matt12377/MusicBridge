<script setup lang="ts">
import { desktopArtworkKey } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { computed, ref, watch } from 'vue'
import type { LocalAlbumArtworkState, LocalAlbumSummary, LocalAlbumTrackItem } from '../../../composables/application/local-library-browser/types.js'
import { localAlbumTrackPresentation } from '../../../composables/application/local-library-browser/presentation.js'
import TrackTable from '../../media/TrackTable.vue'
import LocalAlbumArtwork from './LocalAlbumArtwork.vue'
import { localAlbumIdentity, localAlbumIssueLabel, localAlbumWorkbenchRequest, type LocalAlbumWorkbenchRequest } from './presentation.js'

const props = withDefaults(defineProps<{
  album: LocalAlbumSummary
  tracks: readonly LocalAlbumTrackItem[]
  artwork?: LocalAlbumArtworkState
  total?: number
  hasMore?: boolean
  initialLoading?: boolean
  loadingMore?: boolean
  error?: string
  refreshError?: string
  loadMoreError?: string
  stale?: boolean
  playbackPending?: boolean
  readAvailable?: boolean
  managementAvailable?: boolean
  sourceUnavailable?: boolean
  sourceStatus?: string
}>(), {
  total: 0, hasMore: false, initialLoading: false, loadingMore: false, error: '', refreshError: '',
  loadMoreError: '', stale: false, playbackPending: false, readAvailable: true,
  managementAvailable: true, sourceUnavailable: false, sourceStatus: '目录状态暂未读取',
})
const emit = defineEmits<{
  back: []
  play: [trackId: string]
  queue: [trackId: string]
  'play-next': [trackId: string]
  'open-track': [trackId: string]
  retry: []
  'load-more': []
  'retry-artwork': [album: LocalAlbumSummary]
  workbench: [request: LocalAlbumWorkbenchRequest]
}>()
const heading = ref<HTMLElement | null>(null), imageFailed = ref(false), imageRetry = ref(0)
const playbackLocked = computed(() => props.playbackPending || props.initialLoading || props.sourceUnavailable || !props.readAvailable)
const itemsById = computed(() => new Map(props.tracks.map(item => [item.facts.track.id, item])))
const tracks = computed(() => props.tracks.map(item => {
  const summary = localAlbumTrackPresentation(item, props.album)
  const sequence = [item.disc ? `碟 ${item.disc}` : '', item.trackNumber ? `曲序 ${item.trackNumber}` : '', summary.version || ''].filter(Boolean).join(' · ')
  return { ...summary, ...(sequence ? { version: sequence } : {}), ...(props.artwork?.dataUrl ? { artworkUrl: props.artwork.dataUrl } : {}) }
}))
const playableTrackIds = computed<ReadonlySet<string>>(() => new Set(playbackLocked.value ? [] : props.tracks.filter(item => item.facts.track.segment === null).map(item => item.facts.track.id)))
const firstPlayableId = computed(() => props.tracks.find(item => playableTrackIds.value.has(item.facts.track.id))?.facts.track.id)
const hasCueSegments = computed(() => props.tracks.some(item => item.facts.track.segment !== null))
const artworkError = computed(() => imageFailed.value || props.artwork?.status === 'error')
const artworkCoverage = computed(() => props.album.artworkState ?? (props.album.artworkAvailable ? 'available' : 'missing'))
const canRetryArtwork = computed(() => props.readAvailable && props.artwork?.status !== 'loading' && (imageFailed.value || props.artwork?.canRetry))

watch(() => [props.artwork?.dataUrl, props.artwork?.status], () => { imageFailed.value = false })
function requestPlayback(action: 'play' | 'queue' | 'play-next', trackId: string | undefined): void {
  if (!trackId || !playableTrackIds.value.has(trackId)) return
  if (action === 'play') emit('play', trackId)
  else if (action === 'queue') emit('queue', trackId)
  else emit('play-next', trackId)
}
function openTrack(trackId: string): void { if (itemsById.value.has(trackId)) emit('open-track', trackId) }
function requestWorkbench(action: LocalAlbumWorkbenchRequest['action']): void {
  if (!props.managementAvailable) return
  emit('workbench', localAlbumWorkbenchRequest(props.album, action))
}
function retryArtwork(): void {
  if (!canRetryArtwork.value) return
  imageRetry.value++; imageFailed.value = false; emit('retry-artwork', props.album)
}
defineExpose({ focusHeading: () => heading.value?.focus({ preventScroll: true }) })
</script>

<template>
  <section class="roon-album-detail-view local-album-detail" aria-labelledby="local-album-detail-heading" @keydown.esc.stop.prevent="emit('back')">
    <button type="button" class="back-link" @click="emit('back')"><i class="bi bi-arrow-left" aria-hidden="true"></i> 本地专辑</button>
    <div class="roon-album-detail-hero">
      <div class="local-album-detail-cover">
        <LocalAlbumArtwork :key="imageRetry" class="roon-artwork roon-album-detail-art" :artwork="props.artwork" :trace-key="desktopArtworkKey(JSON.stringify([props.album.id, props.album.rootId, props.album.editionId, props.album.representativeTrackId, props.album.revision]))" :source-state="artworkCoverage" :alt="`${props.album.title} 封面`" eager @image-error="imageFailed = true" />
        <button v-if="artworkError" type="button" class="secondary-button local-detail-cover-retry" :disabled="!canRetryArtwork" @click="retryArtwork">重试封面</button>
        <button v-else-if="artworkCoverage === 'missing' || artworkCoverage === 'unknown' || props.artwork?.status === 'missing'" type="button" class="secondary-button local-detail-cover-retry" :disabled="!props.managementAvailable" @click="requestWorkbench('artwork')">{{ artworkCoverage === 'unknown' ? '查找封面' : '选择封面' }}</button>
      </div>
      <div class="roon-album-detail-copy">
        <p class="section-kicker">本地专辑 · {{ props.album.kind === 'edition' ? '独立发行' : '源目录' }}</p>
        <h2 id="local-album-detail-heading" ref="heading" tabindex="-1">{{ props.album.title }}</h2>
        <p class="lede">{{ props.album.artists.join('、') || '未提供专辑艺术家' }}</p>
        <p class="roon-album-detail-meta">{{ localAlbumIdentity(props.album) }} · {{ props.total || props.album.trackCount }} 首</p>
        <p class="local-album-source-status" role="status">{{ props.sourceStatus }}<span v-if="props.stale"> · 正在显示上次成功读取的详情</span></p>
        <div class="button-row local-album-detail-actions">
          <button type="button" class="primary-button" :disabled="!firstPlayableId || props.initialLoading" @click="requestPlayback('play', firstPlayableId)"><i class="bi bi-play-fill" aria-hidden="true"></i> {{ props.playbackPending ? '正在准备播放…' : '播放首曲' }}</button>
          <button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('overview')"><i class="bi bi-sliders" aria-hidden="true"></i> 整理这张专辑</button>
        </div>
        <p v-if="props.sourceUnavailable" class="local-album-hint">源目录离线或许可已撤销，恢复目录后可播放原文件。</p>
        <p v-else-if="!props.readAvailable" class="local-album-hint">专辑读取服务尚未接入，播放资格暂不可确认。</p>
        <p v-if="hasCueSegments" class="local-album-hint">CUE 段落直送尚不支持，段落信息保留；可播放的完整音轨仍沿用原播放入口。</p>
        <p v-if="!props.managementAvailable" class="local-album-hint">整理工作台尚未接入。</p>
      </div>
    </div>

    <details class="local-album-tools">
      <summary>版本、来源与整理工具</summary>
      <dl class="local-album-facts"><div><dt>收录身份</dt><dd>{{ props.album.kind === 'edition' ? '独立发行' : '源目录中的专辑' }} · <code>{{ props.album.id }}</code></dd></div><div><dt>版本</dt><dd>{{ props.album.versionLabel || '未注明版本' }}<span v-if="props.album.editionId"> · 发行 <code>{{ props.album.editionId }}</code></span></dd></div><div><dt>来源</dt><dd>{{ props.album.sourceLabel || '本地原文件' }}</dd></div><div v-if="localAlbumIssueLabel(props.album.statuses)"><dt>待整理</dt><dd>{{ localAlbumIssueLabel(props.album.statuses) }}</dd></div></dl>
      <div class="button-row"><button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('artwork')">选择封面</button><button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('ai')">AI 整理</button><button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('organize')">整理信息</button><button v-if="props.album.statuses.includes('cue-unsplit') || hasCueSegments" type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('cue')">CUE 分轨</button></div>
      <p class="local-album-hint">进入工作台核对目标与计划后再执行整理。</p>
    </details>
    <p v-if="props.error || props.refreshError" class="persistent-error" role="alert">{{ props.error || props.refreshError }} <button type="button" class="inline-action" :disabled="props.initialLoading" @click="emit('retry')">重试曲目读取</button></p>
    <TrackTable v-if="!props.error || props.tracks.length" :tracks="tracks" :playable-track-ids="playableTrackIds" :busy="playbackLocked" :initial-loading="props.initialLoading" :loading-more="props.loadingMore" :has-more="props.hasMore" :total="props.total" :load-more-error="props.loadMoreError" empty-title="这张专辑没有可显示的曲目" empty-copy="本次读取未返回曲目，可重新读取或在整理工作台检查来源。" @play="requestPlayback('play', $event.id)" @queue="requestPlayback('queue', $event.id)" @play-next="requestPlayback('play-next', $event.id)" @load-more="emit('load-more')">
      <template #row-detail="{ track }"><button type="button" class="row-action local-album-track-detail" :aria-label="`查看 ${track.title} 的版本与文件详情`" @click.stop="openTrack(track.id)">详情</button></template>
    </TrackTable>
  </section>
</template>

<style scoped>
.local-album-detail { min-width: 0; }
.local-album-detail-cover { position: relative; width: min(100%, 220px); min-width: 0; }
.local-detail-cover-retry { position: absolute; top: 8px; right: 8px; min-height: 44px; }
.local-album-detail .roon-album-detail-copy h2 { overflow-wrap: anywhere; }
.local-album-detail-actions { margin-top: 16px; }
.local-album-source-status, .local-album-hint { color: var(--mb-text-secondary); font-size: 12px; line-height: 1.6; }
.local-album-source-status { margin: 10px 0 0; }
.local-album-hint { margin: 10px 0; }
.local-album-tools { margin: 0 0 22px; border-bottom: 1px solid var(--mb-divider); }
.local-album-tools summary { min-height: 44px; line-height: 44px; color: var(--mb-text-secondary); cursor: pointer; }
.local-album-facts { display: grid; gap: 10px; margin: 0 0 16px; font-size: 12px; }
.local-album-facts > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; }
.local-album-facts dt { color: var(--mb-text-secondary); }
.local-album-facts dd { margin: 0; overflow-wrap: anywhere; }
.local-album-facts code { font-size: 11px; }
.local-album-detail :deep(.track-table .track-row) { grid-template-columns: 24px 64px minmax(0, 1fr) 60px 142px; }
.local-album-detail :deep(.track-table .row-actions) { width: 142px; gap: 5px; opacity: 1; grid-column: auto; }
.local-album-detail :deep(.track-table .row-actions button) { display: inline-flex; flex: 0 0 44px; width: 44px; min-width: 44px; min-height: 44px; padding-inline: 0; align-items: center; justify-content: center; }
.local-album-detail :deep(.track-table.is-virtualized) { height: min(65vh, 720px); min-height: 252px; overflow: auto; }
.local-album-detail :deep(.local-album-track-detail) { min-width: 44px; font-size: 11px; }
.local-album-detail button:focus-visible, .local-album-detail summary:focus-visible, .local-album-detail h2:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; border-radius: 6px; }
@container (max-width: 620px) { .local-album-detail .roon-album-detail-hero { grid-template-columns: minmax(120px, 160px) minmax(0, 1fr); gap: 20px; } }
@container (max-width: 440px) { .local-album-detail .roon-album-detail-hero { grid-template-columns: minmax(0, 1fr); } .local-album-detail-cover { width: 160px; } }
@media (max-width: 800px) { .local-album-detail :deep(.track-table .track-row) { grid-template-columns: 64px minmax(0, 1fr) 40px 142px; } }
</style>
