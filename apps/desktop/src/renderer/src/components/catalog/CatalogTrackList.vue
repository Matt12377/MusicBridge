<script setup lang="ts">
import { computed } from 'vue'
import type { TrackSummary } from '@music-bridge/contracts'
import { catalogSourceLabel, type CatalogItem } from '../../composables/catalog/catalog-presentation.js'
import TrackTable from '../media/TrackTable.vue'
const props = defineProps<{ items: readonly CatalogItem[]; pending?: boolean; hasMore?: boolean; total?: number; error?: string; refreshing?: boolean; refreshError?: string; busy?: boolean }>()
const emit = defineEmits<{ play: [item: CatalogItem]; queue: [item: CatalogItem]; next: [item: CatalogItem]; more: []; retry: [] }>()
const byKey = computed(() => new Map(props.items.map(item => [item.key, item])))
const tracks = computed<TrackSummary[]>(() => props.items.map(item => ({ id: item.key, title: item.title, artists: [item.subtitle], album: catalogSourceLabel[item.source], artworkUrl: item.artworkUrl,
  artworkReference: item.artworkReference, ...(item.identity.type === 'netease-track' ? { durationMs: item.identity.value.durationMs, version: item.identity.value.version } : {}) })))
function action(kind: 'play' | 'queue' | 'next', track: TrackSummary): void { const item = byKey.value.get(track.id); if (!item) return; if (kind === 'play') emit('play', item); else if (kind === 'queue') emit('queue', item); else emit('next', item) }
function canRequest(track: TrackSummary, action: 'play' | 'queue' | 'play-next'): boolean { return !props.busy && (action !== 'play-next' || byKey.value.get(track.id)?.source !== 'roon') }
</script>

<template>
  <p v-if="refreshing" role="status">正在刷新，保留已加载歌曲…</p>
  <p v-else-if="refreshError" class="catalog-refresh-error" role="status">刷新失败，保留已加载歌曲。{{ refreshError }} <button type="button" class="text-button" :disabled="pending" @click="emit('retry')">重新读取</button></p>
  <TrackTable :tracks="tracks" :busy="busy" :can-request-action="canRequest" :initial-loading="pending && !items.length" :loading-more="pending && !!items.length" :has-more="hasMore && !refreshing && !refreshError" :total="total" :load-more-error="error" empty-title="没有匹配的歌曲" empty-copy="可更换关键词或查看其它来源。" @play="action('play', $event)" @queue="action('queue', $event)" @play-next="action('next', $event)" @load-more="emit('more')" />
</template>
