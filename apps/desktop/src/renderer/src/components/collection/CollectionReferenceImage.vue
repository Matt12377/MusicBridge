<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CanonicalReference } from '@music-bridge/contracts'
import { referenceImageUrl } from './reference-images'
const props = defineProps<{ reference: CanonicalReference }>()
const failed = ref(false)
const url = computed(() => referenceImageUrl(props.reference))
watch(() => props.reference, () => { failed.value = false })
</script>
<template>
  <span class="reference-image">
    <img v-if="url && !failed" :src="url" :alt="`${reference.brand} ${reference.model} ${reference.edition} 原书资料参考图，非我的实物照片`" loading="lazy" @error="failed = true">
    <span v-else>{{ failed ? '参考图读取失败，请重新读取目录' : '主图尚缺 · 资料条目保留' }}</span>
  </span>
</template>
<style scoped>
.reference-image { display: flex; width: 100%; height: 100%; min-height: 100px; align-items: center; justify-content: center; overflow: hidden; background: var(--mb-bg-base); }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
.reference-image > span { padding: 16px; font-size: 12px; color: var(--mb-text-secondary); }
</style>
