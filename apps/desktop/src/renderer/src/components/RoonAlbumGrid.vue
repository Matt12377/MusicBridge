<script setup lang="ts">
import type { RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts'
import RoonArtwork from './RoonArtwork.vue'

const props = withDefaults(defineProps<{
  page: RoonLibraryPage
  initialLoading?: boolean
  loadingMore?: boolean
  loadMoreError?: string | null
  error?: string | null
}>(), {
  initialLoading: false,
  loadingMore: false,
  loadMoreError: null,
  error: null,
})

const emit = defineEmits<{
  select: [album: RoonLibraryItem]
  retry: []
  'load-more': []
}>()
</script>

<template>
  <div v-if="props.error" class="empty-state roon-library-state">
    <span class="empty-glyph" aria-hidden="true">⌁</span>
    <h3>Roon 专辑暂时不可用</h3>
    <p>{{ props.error }}</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重试</button>
  </div>
  <div v-else-if="props.initialLoading && !props.page.items.length" class="empty-state roon-library-state">
    <span class="loading-line"></span>
    <p>正在读取 Roon 专辑…</p>
  </div>
  <div v-else-if="!props.page.items.length" class="empty-state roon-library-state">
    <span class="empty-glyph" aria-hidden="true">♫</span>
    <h3>还没有可显示的专辑</h3>
    <p>Roon Core 当前返回 0 张专辑。请在 Roon 中检查存储位置与资料库内容后重新读取。</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重新读取</button>
  </div>
  <template v-else>
    <div class="roon-album-grid" aria-label="Roon 专辑">
      <button v-for="album in props.page.items" :key="album.reference" type="button" class="roon-album-card" @click="emit('select', album)">
        <RoonArtwork class="roon-album-art" :reference="album.artworkReference" :alt="`${album.title} 封面`" :width="256" :height="256" />
        <span class="roon-album-copy"><strong>{{ album.title }}</strong><small>{{ album.artist || album.subtitle || 'Roon Library' }}</small><small v-if="album.year">{{ album.year }}</small></span>
      </button>
    </div>
    <div v-if="props.page.hasMore" class="roon-library-more">
      <span v-if="props.loadingMore" role="status">正在加载更多专辑…</span>
      <template v-else-if="props.loadMoreError">
        <span>{{ props.loadMoreError }}</span>
        <button type="button" class="text-button" @click="emit('load-more')">重试</button>
      </template>
      <button v-else type="button" class="text-button" @click="emit('load-more')">加载更多专辑</button>
      <span v-if="props.page.total">已显示 {{ props.page.items.length }} / {{ props.page.total }}</span>
    </div>
  </template>
</template>
