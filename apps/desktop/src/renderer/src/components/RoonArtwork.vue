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
}>(), {
  alt: '',
  fallback: '♫',
  width: 256,
  height: 256,
  eager: false,
})

const root = ref<HTMLElement | null>(null)
const imageUrl = ref<string | undefined>()
const loading = ref(false)
const errorState = ref<'unavailable' | 'request' | 'decode' | null>(null)
let visible = props.eager
let operation = 0
let observer: IntersectionObserver | undefined
let lease: RoonArtworkLease | undefined

function releaseImage(): void {
  imageUrl.value = undefined
  lease?.release()
  lease = undefined
}

async function acquireRoonArtwork(): Promise<void> {
  const current = ++operation
  releaseImage()
  if (!props.reference || !visible) {
    loading.value = false
    errorState.value = null
    return
  }
  loading.value = true
  errorState.value = null
  try {
    const acquired = await roonArtworkCache.acquire({
      reference: props.reference,
      width: props.width,
      height: props.height,
      scale: 'fit',
      format: 'image/jpeg',
    })
    if (current !== operation) {
      acquired.release()
      return
    }
    lease = acquired
    imageUrl.value = acquired.url
  } catch (error) {
    if (current === operation) {
      imageUrl.value = undefined
      const code = readPublicIpcErrorCode(error)
      errorState.value = code === 'ROON_IMAGE_UNAVAILABLE'
        ? 'unavailable'
        : code === 'ROON_IMAGE_DECODE_FAILED'
          ? 'decode'
          : 'request'
    }
  } finally {
    if (current === operation) loading.value = false
  }
}

function handleImageError(): void {
  operation += 1
  imageUrl.value = undefined
  errorState.value = 'decode'
  lease?.invalidate()
  lease = undefined
  loading.value = false
}

watch(
  () => [props.reference, props.width, props.height] as const,
  () => void acquireRoonArtwork(),
  { immediate: true },
)

onMounted(() => {
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
      :src="imageUrl"
      alt=""
      :loading="props.eager ? 'eager' : 'lazy'"
      decoding="async"
      @error="handleImageError"
    />
    <span v-if="errorState === 'unavailable'" class="roon-artwork-error" role="status">暂无封面</span>
    <span v-else-if="errorState === 'decode'" class="roon-artwork-error" role="status">封面解码失败</span>
    <span v-else-if="errorState === 'request'" class="roon-artwork-error" role="status">封面读取失败</span>
  </span>
</template>
