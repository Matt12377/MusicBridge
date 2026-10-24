<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CatalogArtistCard, CatalogItem } from '../../composables/catalog/catalog-presentation.js'
import { catalogSourceLabel } from '../../composables/catalog/catalog-presentation.js'
import { useGridWindow } from '../../composables/useGridWindow.js'
import CatalogArtwork from './CatalogArtwork.vue'

const props = defineProps<{ cards: readonly CatalogArtistCard[]; preview?: boolean }>()
const emit = defineEmits<{ select: [item: CatalogItem] }>()
const root = ref<HTMLElement | null>(null)
const grid = useGridWindow(computed(() => props.cards), root, {
  profile: card => card.localAlbumCount === undefined ? `remote:${card.entries.length}` : `local:${String(card.localAlbumCount).length}:${String(card.localTrackCount).length}:${card.entries.length}`,
  prepareProbe: (element, card) => {
    const count = element.querySelector<HTMLElement>('.catalog-local-count')
    if (count) { count.style.display = card.localAlbumCount === undefined ? 'none' : ''; count.textContent = `${card.localAlbumCount} 张本地专辑 · ${card.localTrackCount} 首参与歌曲` }
    const sources = element.querySelector<HTMLElement>('.catalog-card-sources'), button = sources?.querySelector<HTMLButtonElement>('button')
    if (sources && button) sources.replaceChildren(...card.entries.map(entry => { const copy = button.cloneNode(false) as HTMLButtonElement; copy.textContent = catalogSourceLabel[entry.source]; return copy }))
  },
  enabled: () => !props.preview,
})
function artwork(card: CatalogArtistCard): CatalogItem { return { ...card.entries[0]!, artworkUrl: card.artworkUrl, artworkReference: card.artworkReference } }
</script>

<template>
  <div ref="root" class="catalog-artist-grid" :class="{ preview }" v-bind="grid.attrs.value" :style="grid.rootStyle.value" role="list" @focusin="grid.onFocusIn" @focusout="grid.onFocusOut" @keydown="grid.onKeydown">
    <article v-for="{ item: card, index, style } in grid.rendered.value" :key="card.key" :data-grid-index="index" :style="style" class="catalog-artist-card" role="listitem">
      <button type="button" class="catalog-artist-main" :aria-label="`打开 ${card.name} 的艺术家详情`" @click="emit('select', card.entries[0]!)">
        <CatalogArtwork :item="artwork(card)" circular />
        <strong>{{ card.name }}</strong>
      </button>
      <small v-show="card.localAlbumCount !== undefined" class="catalog-local-count">{{ card.localAlbumCount }} 张本地专辑 · {{ card.localTrackCount }} 首参与歌曲</small>
      <div class="catalog-card-sources" aria-label="艺术家来源">
        <button v-for="entry in card.entries" :key="entry.key" type="button" class="catalog-source-button" :aria-label="`${card.name} · ${catalogSourceLabel[entry.source]}详情`" @click="emit('select', entry)">{{ catalogSourceLabel[entry.source] }}</button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.catalog-artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 28px 26px; }
.catalog-artist-card { min-width: 0; text-align: center; display: flex; flex-direction: column; gap: 9px; }
.catalog-artist-main { display: flex; flex-direction: column; gap: 15px; align-items: center; width: 100%; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
.catalog-artist-main .catalog-artwork { width: min(100%, 172px); }
.catalog-artist-main strong { max-width: 100%; font-size: 15px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.catalog-local-count { color: var(--mb-text-secondary); font-size: 11px; }
.catalog-card-sources { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; }
.catalog-source-button { padding: 3px 8px; border: 1px solid var(--mb-glass-border); border-radius: 12px; background: var(--mb-glass-clear); color: var(--mb-text-secondary); font-size: 10px; cursor: pointer; }
.catalog-source-button:focus-visible, .catalog-artist-main:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 4px; }
@media (max-width: 800px) { .catalog-artist-grid { grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 24px 18px; } }
</style>
