<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { catalogKindLabel, catalogKinds, catalogSourceLabel, type CatalogCategory, type CatalogItem, type CatalogKind } from '../../composables/catalog/catalog-presentation.js'
import type { CatalogSection, useCatalogExperience } from '../../composables/catalog/useCatalogExperience.js'
import CatalogArtwork from './CatalogArtwork.vue'
import CatalogArtistGrid from './CatalogArtistGrid.vue'
import CatalogAlbumGrid from './CatalogAlbumGrid.vue'
import CatalogTrackList from './CatalogTrackList.vue'

const props = defineProps<{ model: ReturnType<typeof useCatalogExperience>; mode: 'artists' | 'search'; busy?: boolean }>()
const emit = defineEmits<{ select: [item: CatalogItem]; play: [item: CatalogItem]; queue: [item: CatalogItem]; next: [item: CatalogItem]; 'load-roon': [] }>()
const artistSource = props.model.artistSource
const artistDraft = ref(props.model.artistQuery.value)
const bindingRoot = ref<HTMLElement | null>(null), bindingInput = ref<HTMLInputElement | null>(null)
const workspaceToken = Symbol('catalog-workspace')
let artistTimer: ReturnType<typeof setTimeout> | undefined, returnFocus: HTMLElement | null = null
const selected = computed(() => props.model.detail.value)
const categories: readonly { id: CatalogCategory; label: string }[] = [{ id: 'all', label: '综合' }, { id: 'tracks', label: '歌曲' }, { id: 'albums', label: '专辑' }, { id: 'artists', label: '艺术家' }]
const shownKinds = computed(() => props.model.category.value === 'all' ? catalogKinds : [props.model.category.value])
const localDetail = computed(() => selected.value?.item.identity.type === 'local-artist')
const artistProfile = computed(() => selected.value?.profile)
function pending(kind: CatalogKind): boolean { return props.model.selectedSources.value.some(source => props.model.searchSections[source][kind].loading) }
function sourceArtist(value: 'local' | 'roon'): void {
  artistSource.value = value; props.model.closeDetail()
  if (value === 'roon') { props.model.stopArtists(); emit('load-roon') }
  else if (!props.model.library.items.length && !props.model.library.loading) void props.model.loadArtists(artistDraft.value)
}
function changeArtistQuery(value: string): void {
  artistDraft.value = value
  props.model.stopArtists()
  if (artistTimer !== undefined) clearTimeout(artistTimer)
  artistTimer = setTimeout(() => { artistTimer = undefined; void props.model.loadArtists(value) }, 250)
}
function more(section: CatalogSection, action: () => void): void { if (!section.loading) action() }
function bindCandidate(item: CatalogItem): void { if (item.identity.type === 'netease-artist') void props.model.bind(item.identity.value.id) }
function bindingKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.model.closeBinding(); return }
  if (event.key !== 'Tab') return
  const entries = [...(bindingRoot.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') ?? [])]
  const first = entries[0], last = entries.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
watch(() => props.model.bindingOpen.value, value => {
  if (value) { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; void nextTick(() => bindingInput.value?.focus()) }
  else { returnFocus?.focus(); returnFocus = null }
})
watch(() => props.mode, mode => {
  props.model.activateWorkspace(mode, workspaceToken)
  if (mode === 'artists' && artistSource.value === 'local' && !props.model.library.items.length && !props.model.library.loading) void props.model.loadArtists()
  if (mode === 'search') props.model.resumeSearch()
}, { immediate: true })
onUnmounted(() => { if (artistTimer !== undefined) clearTimeout(artistTimer); props.model.suspendWorkspace(props.mode, workspaceToken) })
</script>

<template>
  <div class="catalog-workspace" :class="{ 'catalog-search': mode === 'search' }">
    <template v-if="selected">
      <button type="button" class="back-link" @click="model.closeDetail">← 返回{{ mode === 'artists' ? '艺术家' : '搜索结果' }}</button>
      <header class="catalog-detail-hero">
        <CatalogArtwork :item="selected.item" :circular="selected.item.kind === 'artists'" />
        <div class="catalog-detail-title"><p class="section-kicker">{{ catalogSourceLabel[selected.item.source] }} · {{ selected.item.kind === 'artists' ? '艺术家' : '专辑' }}</p><h2>{{ selected.item.title }}</h2><p class="lede">{{ selected.item.subtitle }}</p>
          <button v-if="localDetail" type="button" class="text-button catalog-link-action" @click="model.openBinding">{{ artistProfile?.artist.linkedNeteaseId ? '更正资料关联' : '关联艺术家资料' }}</button>
        </div>
      </header>
      <section v-if="localDetail" class="catalog-profile" aria-label="艺术家资料">
        <h3>艺术家资料</h3>
        <p v-if="selected.profileLoading" role="status">{{ selected.profilePreparing ? model.preparationMessage : '正在读取艺术家资料…' }}</p>
        <p v-if="selected.profileError" class="catalog-source-error">{{ selected.profileError }}</p>
        <p v-if="artistProfile?.biography" class="catalog-biography">{{ artistProfile.biography }}</p>
        <p v-else-if="!selected.profileLoading" class="lede">{{ artistProfile?.artist.linkedNeteaseId ? '已关联艺术家资料，暂无可显示的介绍。' : '尚未关联外部人物资料，可按真实人物选择资料来源。' }}</p>
        <small v-if="artistProfile?.credit" class="catalog-profile-credit">{{ artistProfile.credit }}</small>
      </section>
      <template v-if="localDetail">
        <section v-for="relation in (['albums', 'appearsOn'] as const)" :key="relation" class="catalog-result-section">
          <div class="catalog-section-heading"><h3>{{ relation === 'albums' ? '本地专辑' : '参与合辑' }}</h3><span v-if="selected[relation].total !== undefined">{{ selected[relation].total }} 张</span></div>
          <p v-if="selected[relation].error" class="catalog-source-error">{{ selected[relation].error }} <button class="text-button" type="button" @click="model.readDetailSection(relation)">重试</button></p>
          <CatalogAlbumGrid :items="selected[relation].items" @select="emit('select', $event)" />
          <p v-if="selected[relation].loading" role="status" class="catalog-section-status">{{ selected[relation].preparing ? model.preparationMessage : '正在读取专辑…' }}</p>
          <p v-else-if="!selected[relation].items.length && !selected[relation].error" class="lede">暂无{{ relation === 'albums' ? '本地专辑' : '参与合辑' }}</p>
          <button v-if="selected[relation].hasMore" type="button" class="text-button catalog-more" :disabled="selected[relation].loading" @click="model.readDetailSection(relation, true)">加载更多专辑</button>
        </section>
      </template>
      <section class="catalog-result-section">
        <div class="catalog-section-heading"><h3>{{ localDetail ? '参与歌曲' : '歌曲' }}</h3><span v-if="selected.tracks.total !== undefined">{{ selected.tracks.total }} 首</span></div>
        <p v-if="selected.tracks.error && !selected.tracks.items.length" class="catalog-source-error">{{ selected.tracks.error }} <button type="button" class="text-button" @click="model.readDetailSection('tracks')">重试</button></p>
        <p v-if="selected.tracks.preparing" role="status" class="catalog-section-status">{{ model.preparationMessage }}</p>
        <CatalogTrackList :items="selected.tracks.items" :pending="selected.tracks.loading" :has-more="selected.tracks.hasMore" :total="selected.tracks.total"
          :refreshing="!!selected.tracks.items.length && selected.tracks.loading && selected.tracks.readOperation !== 'append'"
          :refresh-error="selected.tracks.items.length && selected.tracks.readOperation !== 'append' ? selected.tracks.error : ''"
          :error="selected.tracks.readOperation === 'append' ? selected.tracks.error : ''" :busy="busy"
          @play="emit('play', $event)" @queue="emit('queue', $event)" @next="emit('next', $event)" @retry="model.readDetailSection('tracks')" @more="model.readDetailSection('tracks', true)" />
      </section>
    </template>
    <template v-else-if="mode === 'artists'">
      <div class="view-heading catalog-page-heading"><div><p class="section-kicker">音乐库</p><h2>艺术家</h2></div><nav class="catalog-source-switch" aria-label="艺术家音乐库"><button type="button" :aria-pressed="artistSource === 'local'" @click="sourceArtist('local')">本地</button><button type="button" :aria-pressed="artistSource === 'roon'" @click="sourceArtist('roon')">Roon</button></nav></div>
      <slot v-if="artistSource === 'roon'" name="roon" />
      <template v-else>
        <div class="catalog-library-toolbar"><label><span class="visually-hidden">搜索本地艺术家</span><input type="search" :value="artistDraft" placeholder="搜索本地艺术家" maxlength="200" @input="!($event as InputEvent).isComposing && changeArtistQuery(($event.target as HTMLInputElement).value)" @compositionend="changeArtistQuery(($event.target as HTMLInputElement).value)" /></label><span v-if="model.library.total !== undefined">{{ model.library.total }} 位艺术家</span></div>
        <p v-if="model.library.error" class="catalog-source-error">{{ model.library.error }} <button type="button" class="text-button" @click="model.loadArtists(artistDraft)">重试</button></p>
        <CatalogArtistGrid :cards="model.libraryCards.value" @select="emit('select', $event)" />
        <p v-if="model.library.loading" role="status" class="catalog-section-status">{{ model.library.preparing ? model.preparationMessage : '正在读取本地艺术家…' }}</p>
        <div v-else-if="!model.library.items.length && !model.library.error" class="empty-state"><h3>{{ artistDraft.trim() ? '没有匹配的本地艺术家' : '暂无本地艺术家' }}</h3><p>本地音乐中的艺术家会显示在这里。</p></div>
        <button v-if="model.library.hasMore" type="button" class="text-button catalog-more" :disabled="model.library.loading" @click="model.loadArtists(model.artistQuery.value, true)">加载更多艺术家</button>
      </template>
    </template>
    <template v-else>
      <div class="view-heading"><div><p class="section-kicker">搜索</p><h2>{{ model.query.value }}</h2></div></div>
      <nav class="search-category-tabs" aria-label="搜索分类"><button v-for="item in categories" :key="item.id" type="button" :class="{ active: model.category.value === item.id }" :aria-current="model.category.value === item.id ? 'page' : undefined" @click="model.category.value = item.id">{{ item.label }}</button></nav>
      <nav class="catalog-source-filters" aria-label="搜索来源"><button type="button" :aria-pressed="model.sourceFilter.value === 'all'" @click="model.selectSource('all')">全部来源</button><button v-for="source in (['local', 'netease', 'roon'] as const)" :key="source" type="button" :aria-pressed="model.sourceFilter.value === source" @click="model.selectSource(source)">{{ catalogSourceLabel[source] }}</button></nav>
      <section v-for="kind in shownKinds" :key="kind" class="catalog-result-section">
        <div class="catalog-section-heading"><h3>{{ catalogKindLabel[kind] }}</h3><button v-if="model.category.value === 'all'" type="button" class="text-button" @click="model.category.value = kind">查看全部 →</button></div>
        <div class="catalog-source-status" aria-live="polite"><template v-for="source in model.selectedSources.value" :key="source"><span v-if="model.searchSections[source][kind].loading" role="status">{{ model.searchSections[source][kind].preparing ? model.preparationMessage : `${catalogSourceLabel[source]}正在读取…` }}</span><span v-else-if="model.searchSections[source][kind].error" class="catalog-source-error">{{ catalogSourceLabel[source] }}：{{ model.searchSections[source][kind].error }} <button type="button" class="text-button" @click="model.readSearch(source, kind)">重试</button></span></template></div>
        <template v-if="kind === 'artists'"><CatalogArtistGrid :cards="model.category.value === 'all' ? model.artistCards.value.slice(0, 6) : model.artistCards.value" :preview="model.category.value === 'all'" @select="emit('select', $event)" /><p v-if="!model.artistCards.value.length && !pending(kind)" class="lede">没有可显示的艺术家</p></template>
        <template v-else-if="kind === 'albums'"><CatalogAlbumGrid :items="model.category.value === 'all' ? model.albumItems.value.slice(0, 8) : model.albumItems.value" :preview="model.category.value === 'all'" @select="emit('select', $event)" /><p v-if="!model.albumItems.value.length && !pending(kind)" class="lede">没有可显示的专辑</p></template>
        <CatalogTrackList v-else :items="model.category.value === 'all' ? model.trackItems.value.slice(0, 6) : model.trackItems.value" :pending="pending(kind)" :busy="busy" @play="emit('play', $event)" @queue="emit('queue', $event)" @next="emit('next', $event)" />
        <div v-if="model.category.value !== 'all'" class="catalog-source-more"><button v-for="source in model.selectedSources.value" :key="source" v-show="model.searchSections[source][kind].hasMore" type="button" class="text-button" :disabled="model.searchSections[source][kind].loading" @click="more(model.searchSections[source][kind], () => model.readSearch(source, kind, true))">加载更多{{ catalogSourceLabel[source] }}{{ catalogKindLabel[kind] }}</button></div>
      </section>
    </template>
    <Teleport to="body">
      <div v-if="model.bindingOpen.value" class="catalog-binding-backdrop" @click.self="model.closeBinding">
        <section ref="bindingRoot" class="catalog-binding-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-binding-title" @keydown="bindingKeys">
          <div class="catalog-section-heading"><div><h2 id="catalog-binding-title">关联艺术家资料</h2><p class="lede">{{ selected?.item.title }} · 选择对应的网易云艺术家</p></div><button type="button" class="text-button" :disabled="model.bindingBusy.value" aria-label="关闭资料关联" @click="model.closeBinding">关闭</button></div>
          <form class="catalog-binding-search" @submit.prevent="model.loadMatches()"><input ref="bindingInput" v-model="model.matchQuery.value" type="search" aria-label="搜索艺术家资料" maxlength="200" /><button type="submit" class="secondary-button" :disabled="model.matchesLoading.value || model.bindingBusy.value">搜索</button></form>
          <p class="lede">关联只补充人物资料，不改写本地音乐标签。</p>
          <p v-if="model.matchesLoading.value" role="status">{{ model.matchesPreparing.value ? model.preparationMessage : '正在读取候选艺术家…' }}</p><p v-if="model.matchError.value" class="catalog-source-error">{{ model.matchError.value }}</p>
          <div class="catalog-binding-candidates"><article v-for="item in model.matches.value" :key="item.key" class="catalog-binding-candidate"><CatalogArtwork :item="item" circular /><div><strong>{{ item.title }}</strong><small>{{ item.subtitle }}</small></div><button type="button" class="secondary-button" :disabled="model.bindingBusy.value || !!model.bindingError.value" @click="bindCandidate(item)">关联此艺术家</button></article></div>
          <p v-if="!model.matchesLoading.value && !model.matches.value.length && !model.matchError.value" class="lede">没有找到候选，可更换名称搜索。</p>
          <p v-if="model.bindingError.value" class="catalog-source-error" role="alert">{{ model.bindingError.value }} <button type="button" class="text-button" :disabled="selected?.profileLoading" @click="model.refreshProfile">重新读取资料</button></p>
          <div class="catalog-binding-footer"><button v-if="artistProfile?.artist.linkedNeteaseId" type="button" class="text-button" :disabled="model.bindingBusy.value || !!model.bindingError.value" @click="model.bind(null)">解除当前资料关联</button><span v-if="model.bindingBusy.value" role="status">正在保存关联…</span></div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.catalog-workspace { padding-bottom: 30px; }
.catalog-page-heading, .catalog-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.catalog-section-heading { margin-bottom: 22px; }
.catalog-section-heading h3 { margin: 0; font-size: 20px; }
.catalog-section-heading > span, .catalog-library-toolbar > span { color: var(--mb-text-secondary); font-size: 12px; }
.catalog-source-switch, .catalog-source-filters { display: flex; gap: 5px; }
.catalog-source-switch { padding: 4px; border: 1px solid var(--mb-glass-border); border-radius: 18px; background: var(--mb-glass-clear); }
.catalog-source-switch button, .catalog-source-filters button { border: 0; border-radius: 15px; padding: 7px 16px; background: transparent; color: var(--mb-text-secondary); cursor: pointer; font-size: 12px; }
.catalog-source-switch button[aria-pressed='true'], .catalog-source-filters button[aria-pressed='true'] { background: var(--mb-glass-strong); color: var(--mb-text-primary); box-shadow: 0 2px 8px #1118270b; }
.catalog-source-filters { margin: 20px 0 30px; flex-wrap: wrap; }
.catalog-library-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 0 0 28px; }
.catalog-library-toolbar input, .catalog-binding-search input { box-sizing: border-box; width: min(300px, 100%); padding: 10px 14px; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; font-size: 13px; }
.catalog-result-section { margin: 30px 0 42px; }
.catalog-source-status { display: flex; flex-wrap: wrap; gap: 14px; margin: -9px 0 14px; min-height: 0; font-size: 12px; color: var(--mb-text-secondary); }
.catalog-source-status:empty { display: none; }
.catalog-source-error { font-size: 12px; color: var(--mb-text-secondary); }
.catalog-source-more { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 20px; }
.catalog-section-status, .catalog-more { margin-top: 20px; }
.catalog-detail-hero { display: flex; align-items: center; gap: 34px; margin: 28px 0 34px; }
.catalog-detail-hero > .catalog-artwork { flex: 0 0 190px; width: 190px; }
.catalog-detail-title { min-width: 0; }
.catalog-detail-title h2 { margin: 8px 0 14px; font-size: clamp(28px, 4vw, 48px); font-weight: 600; overflow-wrap: anywhere; }
.catalog-link-action { margin-top: 5px; }
.catalog-profile { max-width: 850px; margin: 0 0 36px; }
.catalog-profile h3 { font-size: 17px; }
.catalog-biography { white-space: pre-line; line-height: 1.8; font-size: 13px; color: var(--mb-text-secondary); }
.catalog-profile-credit { display: block; margin-top: 16px; color: var(--mb-text-secondary); font-size: 11px; }
.catalog-binding-backdrop { position: fixed; inset: 0; z-index: 1500; display: grid; place-items: center; padding: 26px; background: #11182745; backdrop-filter: blur(8px); }
.catalog-binding-dialog { width: min(650px, calc(100vw - 52px)); max-height: calc(100vh - 80px); overflow-y: auto; padding: 28px; border: 1px solid var(--mb-glass-border); border-radius: 22px; background: color-mix(in srgb, var(--mb-bg-elevated) 88%, transparent); backdrop-filter: blur(32px); color: var(--mb-text-primary); box-shadow: 0 20px 80px #11182730; }
.catalog-binding-dialog h2 { margin: 0; font-size: 22px; }
.catalog-binding-search { display: flex; gap: 12px; }
.catalog-binding-search input { flex: 1; width: auto; }
.catalog-binding-candidates { display: grid; gap: 12px; margin: 20px 0; }
.catalog-binding-candidate { display: flex; align-items: center; gap: 14px; }
.catalog-binding-candidate > .catalog-artwork { width: 52px; flex: 0 0 52px; }
.catalog-binding-candidate > div { flex: 1; min-width: 0; display: grid; gap: 6px; }
.catalog-binding-candidate small { font-size: 11px; color: var(--mb-text-secondary); }
.catalog-binding-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; font-size: 12px; }
@media (max-width: 800px) { .catalog-detail-hero { gap: 20px; } .catalog-detail-hero > .catalog-artwork { flex-basis: 120px; width: 120px; } .catalog-library-toolbar { align-items: flex-start; flex-direction: column; gap: 12px; } }
</style>
