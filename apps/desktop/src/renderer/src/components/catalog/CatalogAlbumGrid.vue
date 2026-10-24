<script setup lang="ts">
import { computed, ref } from 'vue'
import { catalogSourceLabel, type CatalogItem } from '../../composables/catalog/catalog-presentation.js'
import { useGridWindow } from '../../composables/useGridWindow.js'
import CatalogArtwork from './CatalogArtwork.vue'
const props = defineProps<{ items: readonly CatalogItem[]; preview?: boolean }>()
const emit = defineEmits<{ select: [item: CatalogItem] }>()
const root = ref<HTMLElement | null>(null)
const grid = useGridWindow(computed(() => props.items), root, { enabled: () => !props.preview })
</script>

<template>
  <div ref="root" class="catalog-album-grid" v-bind="grid.attrs.value" :style="grid.rootStyle.value" role="list" @focusin="grid.onFocusIn" @focusout="grid.onFocusOut" @keydown="grid.onKeydown">
    <div v-for="{ item, index, style } in grid.rendered.value" :key="item.key" :data-grid-index="index" :style="style" role="listitem">
      <button type="button" class="catalog-album-card" :aria-label="`${item.title} · ${catalogSourceLabel[item.source]}`" @click="emit('select', item)">
        <CatalogArtwork :item="item" />
        <strong>{{ item.title }}</strong><small>{{ item.subtitle }}</small><small class="catalog-album-source">{{ catalogSourceLabel[item.source] }}</small>
      </button>
    </div>
  </div>
</template>

<style scoped>
.catalog-album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 28px 24px; }
.catalog-album-card { display: flex; flex-direction: column; align-items: stretch; gap: 7px; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; text-align: left; color: inherit; cursor: pointer; }
.catalog-album-card .catalog-artwork { margin-bottom: 7px; }
.catalog-album-card strong, .catalog-album-card small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-album-card strong { font-size: 14px; font-weight: 600; }
.catalog-album-card small { color: var(--mb-text-secondary); font-size: 12px; }
.catalog-album-card .catalog-album-source { font-size: 10px; }
.catalog-album-card:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 4px; border-radius: 8px; }
@media (max-width: 800px) { .catalog-album-grid { grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); gap: 22px 16px; } }
</style>
