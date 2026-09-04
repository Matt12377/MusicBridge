<script setup lang="ts">
import { ref, watch } from 'vue'
import type { IllustratedReference } from './reference-images'
const props = defineProps<{ reference: IllustratedReference }>()
const failed = ref(false)
watch(() => props.reference, () => { failed.value = false })
</script>
<template>
  <span class="reference-image">
    <img v-if="!failed" :src="reference.image.image.dataUrl" :width="reference.image.image.width" :height="reference.image.image.height" :alt="`${reference.brand} ${reference.model} ${reference.edition} 书籍参考图，非实物照片`" loading="lazy" @error="failed = true">
    <span v-else>参考图读取失败，请重新读取目录</span>
  </span>
</template>
<style scoped>
.reference-image { display: flex; width: 100%; height: 100%; min-height: 100px; align-items: center; justify-content: center; overflow: hidden; background: var(--mb-bg-base); }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
.reference-image > span { padding: 16px; font-size: 12px; color: var(--mb-text-secondary); }
</style>
