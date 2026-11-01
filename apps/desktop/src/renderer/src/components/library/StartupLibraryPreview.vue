<script setup lang="ts">
import { onMounted } from 'vue'
import { logLibraryOperation } from '../../../../../../../packages/bridge-core/src/shared/library-operation-log.js'
import type { StartupLibraryPreview } from '../../composables/application/startup-library-preview.js'
const props = defineProps<{ preview: StartupLibraryPreview; failed: boolean }>()
onMounted(() => requestAnimationFrame(() => logLibraryOperation('ui', 'startup.library-preview', 'complete', { count: props.preview.albums.length })))
</script>

<template>
  <section class="view" aria-labelledby="startup-library-preview-title" data-startup-library-preview>
    <div class="view-heading"><div><p class="section-kicker">本地音乐</p><h2 id="startup-library-preview-title">上次浏览的专辑</h2>
      <p class="lede">{{ failed ? '当前连接未完成，下方保留上次浏览内容。' : '正在连接音乐库，完成后即可打开专辑和播放。' }}</p>
    </div></div>
    <div class="roon-album-grid startup-library-preview-grid" aria-label="上次浏览内容">
      <figure v-for="(album, index) in preview.albums" :key="index" class="roon-album-card startup-library-preview-card">
        <span class="roon-artwork roon-album-art"><img v-if="album.image" :src="album.image" :alt="`${album.title} 封面`" decoding="async"><i v-else class="bi bi-disc" aria-hidden="true"></i></span>
        <figcaption class="roon-album-copy"><strong>{{ album.title }}</strong><small>{{ album.artists }}</small><small>{{ album.edition }}</small></figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.startup-library-preview-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 24px 18px; }
.startup-library-preview-card { margin: 0; cursor: default; }
.startup-library-preview-card .roon-album-art { display: grid; place-items: center; aspect-ratio: 1; overflow: hidden; }
.startup-library-preview-card img { width: 100%; height: 100%; object-fit: cover; }
@media (max-width: 1100px) { .startup-library-preview-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 650px) { .startup-library-preview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
