<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { CatalogItem } from '../../composables/catalog/catalog-presentation.js'
import SafeArtwork from '../SafeArtwork.vue'
import RoonArtwork from '../RoonArtwork.vue'

const props = defineProps<{ item: CatalogItem; circular?: boolean }>()
const root = ref<HTMLElement | null>(null), localUrl = ref<string>()
let generation = 0, disposed = false, visible = false, observer: IntersectionObserver | undefined
async function read(): Promise<void> {
  const item = props.item, identity = item.identity, current = ++generation
  localUrl.value = undefined
  if (!visible || identity.type !== 'local-album' || identity.value.artworkState === 'missing') return
  const album = identity.value
  try {
    const result = await window.musicBridge.getLocalAlbumArtwork({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
      representativeTrackId: album.representativeTrackId, revision: album.revision, variant: 'grid' })
    if (disposed || !visible || current !== generation || item !== props.item) return
    localUrl.value = result.grid?.dataUrl ?? result.image?.display.dataUrl
  } catch { /* 保留明确的无图占位，不把封面失败升级为内容或播放失败。 */ }
}
watch(() => props.item, () => { void read() })
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') { visible = true; void read(); return }
  observer = new IntersectionObserver(entries => {
    const next = entries.some(entry => entry.isIntersecting)
    if (next === visible) return
    visible = next
    if (visible) void read()
    else { generation++; localUrl.value = undefined }
  }, { rootMargin: '100px' })
  if (root.value) observer.observe(root.value)
})
onUnmounted(() => { disposed = true; generation++; observer?.disconnect(); localUrl.value = undefined })
</script>

<template>
  <span ref="root" class="catalog-artwork" :class="{ circular }">
    <RoonArtwork v-if="item.source === 'roon'" class="catalog-artwork-image" :reference="item.artworkReference" :alt="item.title" />
    <SafeArtwork v-else class="catalog-artwork-image" :src="item.artworkUrl ?? localUrl" :alt="item.title" :fallback="circular ? '♩' : '♪'" />
  </span>
</template>

<style scoped>
.catalog-artwork { display: block; aspect-ratio: 1; width: 100%; overflow: hidden; border-radius: 10px; background: var(--mb-glass-clear); }
.catalog-artwork.circular { border-radius: 50%; }
.catalog-artwork-image { display: block; width: 100%; height: 100%; }
</style>
