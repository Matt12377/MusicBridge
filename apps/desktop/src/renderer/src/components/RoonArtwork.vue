<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  reference?: string
  alt?: string
  fallback?: string
  width?: number
  height?: number
}>(), {
  alt: '',
  fallback: '♫',
  width: 512,
  height: 512,
})

const imageUrl = ref<string | undefined>()
const loading = ref(false)
let operation = 0

function revokeImage(): void {
  if (!imageUrl.value) return
  URL.revokeObjectURL(imageUrl.value)
  imageUrl.value = undefined
}

async function loadImage(reference: string | undefined): Promise<void> {
  const current = ++operation
  revokeImage()
  if (!reference) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await window.musicBridge.getRoonImage(reference, {
      width: props.width,
      height: props.height,
      scale: 'fit',
      format: 'image/jpeg',
    })
    if (current !== operation) return
    const body = Uint8Array.from(result.body)
    imageUrl.value = URL.createObjectURL(new Blob([body], { type: result.contentType }))
  } catch {
    if (current === operation) imageUrl.value = undefined
  } finally {
    if (current === operation) loading.value = false
  }
}

watch(() => props.reference, (reference) => void loadImage(reference), { immediate: true })
onUnmounted(() => {
  operation += 1
  revokeImage()
})
</script>

<template>
  <span class="roon-artwork" :class="[$attrs.class, { 'is-loading': loading }]">
    <span class="artwork-fallback" aria-hidden="true">{{ props.fallback }}</span>
    <img v-if="imageUrl" :src="imageUrl" :alt="props.alt" />
  </span>
</template>
