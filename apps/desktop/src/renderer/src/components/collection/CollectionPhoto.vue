<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import type { CollectionPhoto } from '@music-bridge/contracts'
const props = defineProps<{ photo: CollectionPhoto; alt: string }>()
const source = ref(''), failed = ref(false), loading = ref(false)
let generation = 0
async function load(): Promise<void> {
  const current = ++generation
  source.value = ''; failed.value = false; loading.value = true
  try {
    const image = await window.musicBridge.getCollectionPhoto(props.photo.id)
    if (current === generation) source.value = image.dataUrl
  } catch { if (current === generation) failed.value = true }
  finally { if (current === generation) loading.value = false }
}
watch(() => props.photo.id, () => { void load() }, { immediate: true })
onUnmounted(() => { ++generation })
</script>
<template>
  <span class="collection-photo" :aria-busy="loading">
    <img v-if="source && !failed" :src="source" :alt="alt" :width="photo.width" :height="photo.height" loading="lazy" decoding="async" @error="failed = true">
    <span v-else-if="loading" class="photo-message" role="status">正在读取照片…</span>
    <span v-else class="photo-message">照片暂不可用</span>
  </span>
</template>
<style scoped>
.collection-photo { display: flex; width: 100%; height: 100%; min-height: 80px; align-items: center; justify-content: center; background: var(--mb-bg-base); overflow: hidden; }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
.photo-message { color: var(--mb-text-secondary); font-size: 12px; padding: 18px; }
</style>
