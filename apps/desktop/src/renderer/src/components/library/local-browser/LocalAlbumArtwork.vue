<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { emitRendererArtwork, desktopArtworkStarted, desktopArtworkElapsed } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { logLibraryOperation } from '../../../../../../../../packages/bridge-core/src/shared/library-operation-log.js'
import type { LocalAlbumArtworkState, LocalAlbumSummary } from '../../../composables/application/local-library-browser/types.js'
import SafeArtwork from '../../SafeArtwork.vue'

const props = withDefaults(defineProps<{
  artwork?: LocalAlbumArtworkState
  sourceState?: LocalAlbumSummary['artworkState']
  alt?: string
  eager?: boolean
  /** 产品身份独立于诊断开关；同album.id的来源或修订变化也必须隔离旧图。 */
  identityKey?: string
  traceKey?: string | null
}>(), { alt: '', eager: false })
type DisplayedImageEvent = Readonly<{ identityKey: string | undefined; src: string }>
const emit = defineEmits<{ 'image-error': [image: DisplayedImageEvent]; 'image-load': [image: DisplayedImageEvent] }>()
const artworkElement = ref<HTMLElement | null>(null)
const decodeFailed = ref(false)
// 只随挂载的虚拟卡片持有成功引用；同身份刷新期间保留画面，离窗即随组件释放。
const loadedSource = ref<string | null>(null)
const displayedSource = computed(() => props.artwork?.dataUrl || (!decodeFailed.value && (props.artwork?.status === 'loading' || props.artwork?.status === 'idle') ? loadedSource.value : null))
let loadStarted = 0, imageStarted = 0
watch(() => props.identityKey, () => { loadedSource.value = null; decodeFailed.value = false }, { flush: 'sync' })
watch(() => props.artwork?.status, status => { if (status === 'missing' || status === 'error') loadedSource.value = null }, { flush: 'sync' })
watch([() => props.identityKey, displayedSource], ([, value]) => {
  loadStarted = desktopArtworkStarted(); imageStarted = performance.now()
  decodeFailed.value = false
  if (value) logLibraryOperation('ui', 'artwork.image', 'start')
}, { immediate: true })
function currentImage(event: Event): { image: HTMLImageElement; src: string } | null {
  const image = event.target as HTMLImageElement | null
  const src = displayedSource.value
  // 同URL也可能属于旧身份或已替换节点，必须仍是本组件当前的实际IMG。
  return src && image?.tagName === 'IMG' && artworkElement.value?.querySelector('img') === image
    && image.getAttribute('src') === src ? { image, src } : null
}
function onImageLoad(event: Event): void {
  const current = currentImage(event)
  if (!current) return
  const { image, src } = current
  decodeFailed.value = false
  loadedSource.value = src
  logLibraryOperation('ui', 'artwork.image', 'complete', { elapsedMs: Math.max(0, performance.now() - imageStarted), width: image.naturalWidth, height: image.naturalHeight })
  emitRendererArtwork('img-load', props.traceKey ?? null, { elapsedMs: desktopArtworkElapsed(loadStarted), decodedBytes: image.naturalWidth * image.naturalHeight * 4 })
  emit('image-load', { identityKey: props.identityKey, src })
}
const isLoading = computed(() => props.artwork?.status === 'loading')
const hasError = computed(() => decodeFailed.value || props.artwork?.status === 'error')
const placeholder = computed(() => {
  if (displayedSource.value && !hasError.value) return ''
  if (props.sourceState === 'source-unavailable') return '来源不可用，封面未读取'
  if (hasError.value) return '封面暂未读取'
  if (props.artwork?.status === 'missing' || props.sourceState === 'missing') return '未找到封面'
  return props.sourceState === 'available' ? '封面待加载' : '封面尚未探测'
})

function onImageError(event: Event): void {
  const current = currentImage(event)
  if (!current) return
  logLibraryOperation('ui', 'artwork.image', 'error', { elapsedMs: Math.max(0, performance.now() - imageStarted) })
  emitRendererArtwork('img-error', props.traceKey ?? null, { elapsedMs: desktopArtworkElapsed(loadStarted), reason: 'error' })
  decodeFailed.value = true
  loadedSource.value = null
  emit('image-error', { identityKey: props.identityKey, src: current.src })
}
</script>

<template>
  <span ref="artworkElement" class="local-album-artwork" :class="{ 'is-loading': isLoading, 'has-error': hasError }" @error.capture="onImageError" @load.capture="onImageLoad">
    <SafeArtwork :key="props.identityKey" class="local-album-safe-artwork" :src="displayedSource || undefined" :alt="props.alt" :loading="props.eager ? 'eager' : 'lazy'" />
    <span v-if="isLoading" class="visually-hidden">正在读取封面</span>
    <span v-else-if="placeholder" class="local-album-artwork-error">{{ placeholder }}</span>
  </span>
</template>

<style scoped>
.local-album-artwork { position: relative; display: grid; width: 100%; min-width: 0; aspect-ratio: 1; overflow: hidden; color: var(--mb-text-tertiary); background: var(--mb-glass-clear); }
.local-album-safe-artwork { width: 100%; height: 100%; overflow: hidden; }
.local-album-artwork.is-loading::after { position: absolute; z-index: 2; right: 12px; bottom: 12px; left: 12px; height: 2px; border-radius: 2px; background: var(--mb-accent); animation: pulse 1.1s ease-in-out infinite alternate; content: ''; }
.local-album-artwork-error { position: absolute; right: 8px; bottom: 8px; left: 8px; padding: 5px 7px; border: 1px solid var(--mb-glass-border); border-radius: 7px; color: var(--mb-text-primary); background: var(--mb-glass-strong); text-align: center; font-size: 11px; }
@media (prefers-reduced-motion: reduce) { .local-album-artwork.is-loading::after { animation: none; } }
</style>
