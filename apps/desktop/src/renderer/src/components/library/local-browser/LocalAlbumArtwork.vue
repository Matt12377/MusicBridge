<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { emitRendererArtwork, desktopArtworkStarted, desktopArtworkElapsed } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import type { LocalAlbumArtworkState, LocalAlbumSummary } from '../../../composables/application/local-library-browser/types.js'
import SafeArtwork from '../../SafeArtwork.vue'

const props = withDefaults(defineProps<{
  artwork?: LocalAlbumArtworkState
  sourceState?: LocalAlbumSummary['artworkState']
  alt?: string
  eager?: boolean
  traceKey?: string | null
}>(), { alt: '', eager: false })
const emit = defineEmits<{ 'image-error': [] }>()
const decodeFailed = ref(false)
let loadStarted = 0
watch(() => props.artwork?.dataUrl, () => { loadStarted = desktopArtworkStarted() }, { immediate: true })
function onImageLoad(event: Event): void {
  const image = event.target as HTMLImageElement | null
  if (image?.tagName !== 'IMG' || image.getAttribute('src') !== props.artwork?.dataUrl) return
  emitRendererArtwork('img-load', props.traceKey ?? null, { elapsedMs: desktopArtworkElapsed(loadStarted), decodedBytes: image.naturalWidth * image.naturalHeight * 4 })
}
const isLoading = computed(() => props.artwork?.status === 'loading')
const hasError = computed(() => decodeFailed.value || props.artwork?.status === 'error')
const placeholder = computed(() => {
  if (props.artwork?.dataUrl && !hasError.value) return ''
  if (props.sourceState === 'source-unavailable') return '来源不可用，封面未读取'
  if (hasError.value) return '封面暂未读取'
  if (props.artwork?.status === 'missing' || props.sourceState === 'missing') return '未找到封面'
  return props.sourceState === 'available' ? '封面待加载' : '封面尚未探测'
})

watch(() => [props.artwork?.dataUrl, props.artwork?.status], () => { decodeFailed.value = false })
function onImageError(event: Event): void {
  const image = event.target as HTMLImageElement | null
  if (image?.tagName !== 'IMG' || image.getAttribute('src') !== props.artwork?.dataUrl) return
  emitRendererArtwork('img-error', props.traceKey ?? null, { elapsedMs: desktopArtworkElapsed(loadStarted), reason: 'error' })
  decodeFailed.value = true
  emit('image-error')
}
</script>

<template>
  <span class="local-album-artwork" :class="{ 'is-loading': isLoading, 'has-error': hasError }" @error.capture="onImageError" @load.capture="onImageLoad">
    <SafeArtwork :key="props.artwork?.status || 'idle'" class="local-album-safe-artwork" :src="props.artwork?.dataUrl || undefined" :alt="props.alt" :loading="props.eager ? 'eager' : 'lazy'" />
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
