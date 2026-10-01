<script setup lang="ts">
import { ref, watch } from 'vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  src?: string
  alt?: string
  fallback?: string
  loading?: 'eager' | 'lazy'
}>(), {
  alt: '',
  fallback: '♪',
  loading: 'lazy',
})

const failed = ref(false)
const imageElement = ref<HTMLImageElement | null>(null)

watch(() => props.src, () => {
  failed.value = false
})

function onError(event: Event): void {
  if (event.currentTarget !== imageElement.value || imageElement.value?.getAttribute('src') !== props.src) return
  failed.value = true
}
</script>

<template>
  <span class="safe-artwork" :class="$attrs.class">
    <span class="artwork-fallback" aria-hidden="true">{{ props.fallback }}</span>
    <img v-if="props.src && !failed" :key="props.src" ref="imageElement" :src="props.src" :alt="props.alt" :loading="props.loading" @error="onError" />
  </span>
</template>
