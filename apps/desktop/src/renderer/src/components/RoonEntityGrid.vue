<script setup lang="ts">
import type { RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts'
import RoonArtwork from './RoonArtwork.vue'

const props = withDefaults(defineProps<{
  page: RoonLibraryPage
  entityLabel: string
  emptyTitle: string
  emptyCopy: string
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
  select: [item: RoonLibraryItem]
  retry: []
  'load-more': []
}>()
</script>

<template>
  <div v-if="props.error" class="empty-state roon-library-state">
    <span class="empty-glyph" aria-hidden="true">⌁</span>
    <h3>{{ props.entityLabel }}暂时不可用</h3>
    <p>{{ props.error }}</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重试</button>
  </div>
  <div v-else-if="props.initialLoading && !props.page.items.length" class="empty-state roon-library-state">
    <span class="loading-line"></span>
    <p>正在读取 Roon {{ props.entityLabel }}…</p>
  </div>
  <div v-else-if="!props.page.items.length" class="empty-state roon-library-state">
    <span class="empty-glyph" aria-hidden="true">♫</span>
    <h3>{{ props.emptyTitle }}</h3>
    <p>{{ props.emptyCopy }}</p>
    <button type="button" class="secondary-button" @click="emit('retry')">重新读取</button>
  </div>
  <template v-else>
    <div class="roon-album-grid" :aria-label="`Roon ${props.entityLabel}`">
      <button v-for="item in props.page.items" :key="item.reference" type="button" class="roon-album-card" @click="emit('select', item)">
        <RoonArtwork class="roon-album-art" :reference="item.artworkReference" :alt="`${item.title} 封面`" />
        <span class="roon-album-copy"><strong>{{ item.title }}</strong><small>{{ item.artist || item.subtitle || 'Roon Library' }}</small><small v-if="item.year">{{ item.year }}</small></span>
      </button>
    </div>
    <div v-if="props.page.hasMore" class="roon-library-more">
      <span v-if="props.loadingMore" role="status">正在加载更多{{ props.entityLabel }}…</span>
      <template v-else-if="props.loadMoreError">
        <span>{{ props.loadMoreError }}</span>
        <button type="button" class="text-button" @click="emit('load-more')">重试</button>
      </template>
      <button v-else type="button" class="text-button" @click="emit('load-more')">加载更多{{ props.entityLabel }}</button>
      <span v-if="props.page.total">已显示 {{ props.page.items.length }} / {{ props.page.total }}</span>
    </div>
  </template>
</template>
