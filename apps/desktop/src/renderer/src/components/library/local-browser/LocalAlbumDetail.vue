<script setup lang="ts">
import { desktopArtworkKey } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { computed, ref, watch } from 'vue'
import type { LocalAlbumArtworkState, LocalAlbumSummary, LocalAlbumTrackItem } from '../../../composables/application/local-library-browser/types.js'
import { localAlbumTrackPresentation } from '../../../composables/application/local-library-browser/presentation.js'
import LocalAlbumTrackList from './LocalAlbumTrackList.vue'
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
  showManagementActions?: boolean
  sourceUnavailable?: boolean
  sourceStatus?: string
  backLabel?: string
}>(), {
  total: 0, hasMore: false, initialLoading: false, loadingMore: false, error: '', refreshError: '',
  loadMoreError: '', stale: false, playbackPending: false, readAvailable: true,
  managementAvailable: true, showManagementActions: true, sourceUnavailable: false, sourceStatus: '目录状态暂未读取', backLabel: '本地专辑',
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
  return { ...summary, ...(sequence ? { version: sequence } : {}) }
}))
const playableTrackIds = computed<ReadonlySet<string>>(() => new Set(playbackLocked.value ? [] : props.tracks.filter(item => item.facts.track.segment === null).map(item => item.facts.track.id)))
const firstPlayableId = computed(() => props.tracks.find(item => playableTrackIds.value.has(item.facts.track.id))?.facts.track.id)
const hasCueSegments = computed(() => props.tracks.some(item => item.facts.track.segment !== null))
const artworkError = computed(() => imageFailed.value || props.artwork?.status === 'error')
const artworkCoverage = computed(() => props.album.artworkState ?? (props.album.artworkAvailable ? 'available' : 'missing'))
const artworkIdentity = computed(() => JSON.stringify([props.album.id, props.album.rootId, props.album.editionId, props.album.representativeTrackId, props.album.revision]))
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
  if (!props.showManagementActions || !props.managementAvailable) return
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
    <button type="button" class="back-link" @click="emit('back')"><i class="bi bi-arrow-left" aria-hidden="true"></i> {{ props.backLabel }}</button>
    <div class="roon-album-detail-hero">
      <div class="local-album-detail-cover">
        <LocalAlbumArtwork :key="imageRetry" class="roon-artwork roon-album-detail-art" :artwork="props.artwork" :identity-key="artworkIdentity" :trace-key="desktopArtworkKey(artworkIdentity)" :source-state="artworkCoverage" :alt="`${props.album.title} 封面`" eager @image-error="imageFailed = true" />
        <button v-if="artworkError" type="button" class="secondary-button local-detail-cover-retry" :disabled="!canRetryArtwork" @click="retryArtwork">重试封面</button>
        <button v-else-if="props.showManagementActions && (artworkCoverage === 'missing' || artworkCoverage === 'unknown' || props.artwork?.status === 'missing')" type="button" class="secondary-button local-detail-cover-retry" :disabled="!props.managementAvailable" @click="requestWorkbench('artwork')">{{ artworkCoverage === 'unknown' ? '查找封面' : '选择封面' }}</button>
      </div>
      <div class="roon-album-detail-copy">
        <div class="local-album-detail-heading">
          <h2 id="local-album-detail-heading" ref="heading" tabindex="-1">{{ props.album.title }}</h2>
          <p class="lede">{{ props.album.artists.join('、') || '未提供专辑艺术家' }}</p>
          <p class="roon-album-detail-meta">{{ localAlbumIdentity(props.album) }} · {{ props.total || props.album.trackCount }} 首</p>
          <p class="local-album-source-status" role="status">{{ props.sourceStatus }}<span v-if="props.stale"> · 正在显示上次成功读取的详情</span></p>
        </div>
        <div class="local-album-detail-controls">
          <div class="button-row local-album-detail-actions">
            <button type="button" class="primary-button" :disabled="!firstPlayableId || props.initialLoading" @click="requestPlayback('play', firstPlayableId)"><i class="bi bi-play-fill" aria-hidden="true"></i> {{ props.playbackPending ? '正在准备播放…' : '播放首曲' }}</button>
            <button v-if="props.showManagementActions" type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('overview')"><i class="bi bi-sliders" aria-hidden="true"></i> 整理这张专辑</button>
          </div>
          <p v-if="props.sourceUnavailable" class="local-album-hint">源目录离线或许可已撤销，恢复目录后可播放原文件。</p>
          <p v-else-if="!props.readAvailable" class="local-album-hint">专辑读取服务尚未接入，播放资格暂不可确认。</p>
          <p v-if="hasCueSegments" class="local-album-hint">CUE 段落直送尚不支持，段落信息保留；可播放的完整音轨仍沿用原播放入口。</p>
          <p v-if="props.showManagementActions && !props.managementAvailable" class="local-album-hint">整理工作台尚未接入。</p>
        </div>
      </div>
    </div>

    <p v-if="props.error || props.refreshError" class="persistent-error" role="alert">{{ props.error || props.refreshError }} <button type="button" class="inline-action" :disabled="props.initialLoading" @click="emit('retry')">重试曲目读取</button></p>
    <LocalAlbumTrackList v-if="!props.error || props.tracks.length" :key="artworkIdentity" :tracks="tracks" :playable-track-ids="playableTrackIds" :busy="playbackLocked" :initial-loading="props.initialLoading" :loading-more="props.loadingMore" :has-more="props.hasMore" :total="props.total" :load-more-error="props.loadMoreError" @play="requestPlayback('play', $event.id)" @queue="requestPlayback('queue', $event.id)" @play-next="requestPlayback('play-next', $event.id)" @open-track="openTrack($event.id)" @load-more="emit('load-more')" />

    <details class="local-album-tools">
      <summary>{{ props.showManagementActions ? '版本、来源与整理工具' : '版本与来源' }}</summary>
      <dl class="local-album-facts"><div><dt>收录身份</dt><dd>{{ props.album.kind === 'edition' ? '独立发行' : '源目录中的专辑' }} · <code>{{ props.album.id }}</code></dd></div><div><dt>版本</dt><dd>{{ props.album.versionLabel || '未注明版本' }}<span v-if="props.album.editionId"> · 发行 <code>{{ props.album.editionId }}</code></span></dd></div><div><dt>来源</dt><dd>{{ props.album.sourceLabel || '本地原文件' }}</dd></div><div v-if="localAlbumIssueLabel(props.album.statuses)"><dt>待整理</dt><dd>{{ localAlbumIssueLabel(props.album.statuses) }}</dd></div></dl>
      <div v-if="props.showManagementActions" class="button-row"><button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('artwork')">选择封面</button><button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('ai')">AI 整理</button><button type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('organize')">整理信息</button><button v-if="props.album.statuses.includes('cue-unsplit') || hasCueSegments" type="button" class="secondary-button" :disabled="!props.managementAvailable" @click="requestWorkbench('cue')">CUE 分轨</button></div>
      <p v-if="props.showManagementActions" class="local-album-hint">进入工作台核对目标与计划后再执行整理。</p>
    </details>

  </section>
</template>

<style scoped>
.local-album-detail { --local-album-cover-size: clamp(280px, 22cqw, 480px); width: 100%; max-width: none; min-width: 0; }
.local-album-detail .roon-album-detail-hero { grid-template-columns: var(--local-album-cover-size) minmax(0, 1fr); gap: 36px; align-items: stretch; margin: 20px 0 24px; padding: 0; border: 0; }
.local-album-detail-cover { position: relative; width: 100%; min-width: 0; align-self: start; }
.local-album-detail .roon-album-detail-art { width: 100%; border-radius: 12px; }
.local-detail-cover-retry { position: absolute; top: 8px; right: 8px; min-height: 44px; }
.local-album-detail .roon-album-detail-copy { display: flex; flex-direction: column; justify-content: space-between; min-width: 0; min-height: var(--local-album-cover-size); gap: 24px; padding-top: 38px; }
.local-album-detail .roon-album-detail-copy h2 { width: fit-content; max-width: 100%; margin: 0 0 6px; color: var(--mb-text-primary); font-size: clamp(28px, 2.2vw, 36px); line-height: 1.2; letter-spacing: -.025em; overflow-wrap: anywhere; outline: none; }
.local-album-detail .roon-album-detail-copy h2:focus:not(:focus-visible) { outline: none; }
.local-album-detail .roon-album-detail-copy .lede { max-width: none; margin: 0 0 8px; color: var(--mb-accent); font-size: clamp(22px, 1.7vw, 28px); line-height: 1.25; overflow-wrap: anywhere; }
.local-album-detail .roon-album-detail-meta { margin: 0; font-size: 12px; line-height: 1.6; }
.local-album-detail-actions { margin: 0; gap: 12px; }
.local-album-detail-actions button { min-height: 44px; border-radius: 999px; }
.local-album-detail-actions .primary-button { min-width: 148px; justify-content: center; }
.local-album-source-status, .local-album-hint { color: var(--mb-text-secondary); font-size: 12px; line-height: 1.6; }
.local-album-source-status { margin: 6px 0 0; }
.local-album-hint { margin: 10px 0 0; }
.local-album-tools { margin: 24px 0 0; border-top: 1px solid var(--mb-divider); }
.local-album-tools summary { min-height: 44px; line-height: 44px; color: var(--mb-text-secondary); cursor: pointer; }
.local-album-facts { display: grid; gap: 10px; margin: 0 0 16px; font-size: 12px; }
.local-album-facts > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; }
.local-album-facts dt { color: var(--mb-text-secondary); }
.local-album-facts dd { margin: 0; overflow-wrap: anywhere; }
.local-album-facts code { font-size: 11px; }
.local-album-detail button:focus-visible, .local-album-detail summary:focus-visible, .local-album-detail .roon-album-detail-copy h2:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; border-radius: 6px; }
@container (max-width: 760px) { .local-album-detail { --local-album-cover-size: 240px; } .local-album-detail .roon-album-detail-hero { gap: 24px; } .local-album-detail .roon-album-detail-copy { padding-top: 12px; } }
@container (max-width: 560px) { .local-album-detail { --local-album-cover-size: 180px; } .local-album-detail .roon-album-detail-hero { grid-template-columns: minmax(0, 1fr); gap: 18px; } .local-album-detail-cover { width: var(--local-album-cover-size); } .local-album-detail .roon-album-detail-copy { min-height: 0; gap: 20px; padding-top: 0; } }
</style>
