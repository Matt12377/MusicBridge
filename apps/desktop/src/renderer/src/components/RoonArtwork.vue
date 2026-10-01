<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  roonArtworkCache,
  type RoonArtworkLease,
} from '../roon-artwork-cache.js'
import { readPublicIpcErrorCode } from '../roonLibraryMessages.js'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  reference?: string
  alt?: string
  fallback?: string
  width?: number
  height?: number
  eager?: boolean
  externalRetry?: boolean
}>(), {
  alt: '',
  fallback: '♫',
  width: 256,
  height: 256,
  eager: false,
  externalRetry: false,
})
const emit = defineEmits<{ (event: 'retry-action', action: (() => void) | undefined): void }>()

const root = ref<HTMLElement | null>(null)
const imageElement = ref<HTMLImageElement | null>(null)
const imageUrl = ref<string | undefined>()
const loading = ref(false)
const errorState = ref<'unavailable' | 'request' | 'decode' | 'busy' | null>(null)
let visible = props.eager
let operation = 0
let observer: IntersectionObserver | undefined
let lease: RoonArtworkLease | undefined
let controller: AbortController | undefined
let removeInvalidationListener: (() => void) | undefined

function releaseImage(): void {
  imageUrl.value = undefined
  lease?.release()
  lease = undefined
}

async function retryDelay(delay: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('封面等待已取消')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function acquireRoonArtwork(): Promise<void> {
  const current = ++operation
  controller?.abort()
  controller = undefined
  releaseImage()
  if (!props.reference || !visible) {
    loading.value = false
    errorState.value = null
    return
  }
  loading.value = true
  errorState.value = null
  const owned = new AbortController()
  controller = owned
  const deadline = Date.now() + 10000
  const timer = setTimeout(() => owned.abort(), 10000)
  try {
    let acquired: RoonArtworkLease | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        acquired = await roonArtworkCache.acquire({
          reference: props.reference,
          width: props.width,
          height: props.height,
          scale: 'fit',
          format: 'image/jpeg',
        }, { signal: owned.signal, priority: props.eager ? 'playing' : 'visible' })
        break
      } catch (error) {
        if (readPublicIpcErrorCode(error) !== 'ARTWORK_BUSY' || attempt >= 2 || Date.now() + (attempt === 0 ? 150 : 450) >= deadline) throw error
        await retryDelay(attempt === 0 ? 150 : 450, owned.signal)
        if (current !== operation || owned.signal.aborted) return
      }
    }
    if (!acquired) return
    if (current !== operation || owned.signal.aborted) { acquired.release(); return }
    lease = acquired
    imageUrl.value = acquired.url
  } catch (error) {
    if (current === operation) {
      imageUrl.value = undefined
      const code = readPublicIpcErrorCode(error)
      errorState.value = code === 'ROON_IMAGE_UNAVAILABLE' ? 'unavailable'
        : code === 'ROON_IMAGE_DECODE_FAILED' ? 'decode'
          : code === 'ARTWORK_BUSY' ? 'busy' : 'request'
    }
  } finally {
    clearTimeout(timer)
    if (controller === owned) controller = undefined
    if (current === operation) loading.value = false
  }
}

function handleImageError(event: Event): void {
  if (event.currentTarget !== imageElement.value || !lease || lease.url !== imageUrl.value || imageElement.value?.getAttribute('src') !== imageUrl.value) return
  operation += 1
  controller?.abort()
  controller = undefined
  imageUrl.value = undefined
  errorState.value = 'decode'
  lease?.invalidate()
  lease = undefined
  loading.value = false
}

watch(() => [errorState.value, props.externalRetry] as const, () => {
  if (errorState.value !== 'busy' || !props.externalRetry) { emit('retry-action', undefined); return }
  const ticket = operation, reference = props.reference
  emit('retry-action', () => {
    if (ticket === operation && reference === props.reference && errorState.value === 'busy') void acquireRoonArtwork()
  })
}, { flush: 'sync' })

watch(
  () => [props.reference, props.width, props.height] as const,
  () => void acquireRoonArtwork(),
  { immediate: true },
)

onMounted(() => {
  removeInvalidationListener = roonArtworkCache.subscribeInvalidation(() => {
    operation += 1
    controller?.abort()
    controller = undefined
    releaseImage()
    loading.value = false
    errorState.value = null
  })
  if (visible) return
  if (typeof IntersectionObserver === 'undefined') {
    visible = true
    void acquireRoonArtwork()
    return
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return
    visible = true
    observer?.disconnect()
    observer = undefined
    void acquireRoonArtwork()
  }, { rootMargin: '160px' })
  if (root.value) observer.observe(root.value)
})

onUnmounted(() => {
  operation += 1
  controller?.abort()
  controller = undefined
  removeInvalidationListener?.()
  removeInvalidationListener = undefined
  emit('retry-action', undefined)
  observer?.disconnect()
  observer = undefined
  releaseImage()
})
</script>

<template>
  <span
    ref="root"
    class="roon-artwork"
    :class="[$attrs.class, { 'is-loading': loading }]"
    :role="props.alt ? 'img' : undefined"
    :aria-label="props.alt || undefined"
  >
    <span class="artwork-fallback" aria-hidden="true">{{ props.fallback }}</span>
    <img
      v-if="imageUrl"
      :key="imageUrl"
      ref="imageElement"
      :src="imageUrl"
      alt=""
      :loading="props.eager ? 'eager' : 'lazy'"
      decoding="async"
      @error="handleImageError"
    />
    <span v-if="errorState === 'unavailable'" class="roon-artwork-error" role="status">暂无封面</span>
    <span v-else-if="errorState === 'decode'" class="roon-artwork-error" role="status">封面解码失败</span>
    <span v-else-if="errorState === 'busy' && props.externalRetry" class="roon-artwork-error" role="status">封面暂不可读，请重试</span>
    <button v-else-if="errorState === 'busy'" class="roon-artwork-error" type="button" @click.stop="acquireRoonArtwork">重试封面</button>
    <span v-else-if="errorState === 'request'" class="roon-artwork-error" role="status">封面读取失败</span>
  </span>
</template>
