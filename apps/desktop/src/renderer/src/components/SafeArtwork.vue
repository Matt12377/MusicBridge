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

watch(() => props.src, () => {
  failed.value = false
})

function onError(): void {
  failed.value = true
}
</script>

<template>
  <span class="safe-artwork" :class="$attrs.class">
    <span class="artwork-fallback" aria-hidden="true">{{ props.fallback }}</span>
    <img v-if="props.src && !failed" :src="props.src" :alt="props.alt" :loading="props.loading" @error="onError" />
  </span>
</template>
