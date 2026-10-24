<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import SafeArtwork from '../SafeArtwork.vue'
import RoonArtwork from '../RoonArtwork.vue'
import { sidebarSearchKeyAction, type SidebarSearchSuggestion } from './sidebar-search-model.js'

const props = withDefaults(defineProps<{
  modelValue: string
  expanded: boolean
  label?: string
  suggestions?: readonly SidebarSearchSuggestion[]
  pending?: boolean
  message?: string
}>(), { label: '搜索歌曲、专辑或艺术家', suggestions: () => [], pending: false, message: '' })

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'clear-search': []
  'suggest-query': [query: string]
  'submit-query': [query: string]
  'select-suggestion': [item: SidebarSearchSuggestion]
  expand: []
}>()

const input = ref<HTMLInputElement | null>(null)
const root = ref<HTMLElement | null>(null)
const open = ref(false)
const composing = ref(false)
const highlighted = ref(-1)
const listId = 'sidebar-search-suggestions'
const visible = computed(() => props.expanded && open.value && !composing.value && !!props.modelValue.trim())
const activeId = computed(() => visible.value && highlighted.value >= 0 ? `${listId}-${highlighted.value}` : undefined)
const kindLabel = { artist: '艺术家', album: '专辑', track: '歌曲', keyword: '搜索建议' } as const
const sourceLabel = { local: '本地', netease: '网易云', roon: 'Roon' } as const
let timer: ReturnType<typeof setTimeout> | undefined

function stopTimer(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined }
function suggest(query: string): void {
  stopTimer()
  if (composing.value || !query.trim()) return
  timer = setTimeout(() => { timer = undefined; emit('suggest-query', query.trim()) }, 250)
}

function openSuggestions(): void {
  if (composing.value || !props.modelValue.trim() || open.value) return
  open.value = true; highlighted.value = -1
  // 完整搜索会撤销并清空父层预览；输入仍聚焦时也须重新请求同一关键词。
  suggest(props.modelValue)
}

function focusInput(): void {
  emit('expand')
  void nextTick(() => { input.value?.focus(); openSuggestions() })
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (composing.value || event.isComposing || event.keyCode === 229) return
  if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault()
    focusInput()
  }
}

function onInput(value: string): void {
  emit('update:modelValue', value)
  highlighted.value = -1
  open.value = !!value.trim()
  suggest(value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Tab') { open.value = false; highlighted.value = -1; stopTimer(); return }
  const action = sidebarSearchKeyAction({ key: event.key, composing: composing.value || event.isComposing || event.keyCode === 229,
    open: visible.value, highlighted: highlighted.value, count: props.suggestions.length, query: props.modelValue })
  if (action.type === 'none') return
  event.preventDefault()
  if (action.type === 'close') {
    if (!open.value) input.value?.blur()
    open.value = false; highlighted.value = -1; stopTimer()
  } else if (action.type === 'highlight') {
    openSuggestions(); highlighted.value = action.index
    void nextTick(() => document.getElementById(`${listId}-${action.index}`)?.scrollIntoView({ block: 'nearest' }))
  } else if (action.type === 'select') select(props.suggestions[action.index]!)
  else submit()
}

function submit(): void {
  const query = props.modelValue.trim()
  if (!query || composing.value) return
  stopTimer(); open.value = false; highlighted.value = -1
  emit('submit-query', query)
}
function select(item: SidebarSearchSuggestion): void {
  stopTimer(); open.value = false; highlighted.value = -1
  emit('select-suggestion', item)
}
function onFocus(): void { openSuggestions() }
function onCompositionEnd(event: CompositionEvent): void {
  composing.value = false
  onInput((event.target as HTMLInputElement).value)
}
function clearDraft(): void { stopTimer(); highlighted.value = -1; open.value = false; emit('update:modelValue', ''); emit('clear-search'); input.value?.focus() }
function outside(event: PointerEvent): void { if (event.target instanceof Node && !root.value?.contains(event.target)) { open.value = false; highlighted.value = -1; stopTimer() } }
watch(() => props.suggestions, (items, previous) => {
  if (highlighted.value < 0) return
  if (highlighted.value === previous.length) { highlighted.value = items.length; return }
  const key = previous[highlighted.value]?.key
  highlighted.value = key ? items.findIndex(item => item.key === key) : -1
})
watch(() => props.expanded, value => { if (!value) open.value = false })
onMounted(() => { window.addEventListener('keydown', onGlobalKeydown); document.addEventListener('pointerdown', outside) })
onUnmounted(() => { stopTimer(); window.removeEventListener('keydown', onGlobalKeydown); document.removeEventListener('pointerdown', outside) })
</script>

<template>
  <div ref="root" class="sidebar-search" :class="{ 'is-collapsed': !expanded, 'has-suggestions': visible }">
    <button v-if="!expanded" type="button" class="sidebar-search-collapsed" :aria-label="`${label} (⌘L)`" :title="`${label} (⌘L)`" @click="focusInput">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="7.2" /><path d="m20 20-4.3-4.3" /></svg>
    </button>
    <label v-else class="sidebar-search-field">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="7.2" /><path d="m20 20-4.3-4.3" /></svg>
      <span class="visually-hidden">{{ label }}</span>
      <input ref="input" :value="modelValue" type="search" maxlength="200" :placeholder="label" :aria-label="label" role="combobox" aria-autocomplete="list" :aria-expanded="visible" :aria-controls="visible ? listId : undefined" :aria-activedescendant="activeId" autocomplete="off" @input="onInput(($event.target as HTMLInputElement).value)" @focus="onFocus" @click="openSuggestions" @keydown="onKeydown" @compositionstart="composing = true; stopTimer()" @compositionend="onCompositionEnd" />
      <button v-if="modelValue" type="button" class="search-draft-clear" aria-label="清除搜索草稿" @click.prevent="clearDraft">×</button>
      <kbd v-else aria-hidden="true">⌘L</kbd>
    </label>
    <div v-if="visible" class="sidebar-search-popover" @mousedown.prevent>
      <div class="search-popover-heading"><span>快速搜索</span><span v-if="pending" role="status">正在读取…</span></div>
      <div :id="listId" role="listbox" aria-label="搜索建议" class="search-suggestion-list">
        <button v-for="(item, index) in suggestions" :id="`${listId}-${index}`" :key="item.key" type="button" tabindex="-1" role="option" :aria-selected="highlighted === index" class="search-suggestion" :class="{ active: highlighted === index }" @pointermove="highlighted = index" @click="select(item)">
          <RoonArtwork v-if="item.source === 'roon'" class="search-suggestion-art" :class="{ circular: item.kind === 'artist' }" :reference="item.artworkReference" :alt="item.title" :width="80" :height="80" />
          <SafeArtwork v-else class="search-suggestion-art" :class="{ circular: item.kind === 'artist' }" :src="item.artworkUrl" :alt="item.title" :fallback="item.kind === 'artist' ? '♩' : '♪'" />
          <span class="search-suggestion-copy"><strong>{{ item.title }}</strong><small>{{ item.subtitle || kindLabel[item.kind] }}</small></span>
          <span class="search-suggestion-source">{{ sourceLabel[item.source] }}</span>
        </button>
        <p v-if="!pending && !suggestions.length" class="search-suggestion-empty">{{ message || '没有快速匹配，查看全部搜索结果' }}</p>
        <p v-else-if="message" class="search-suggestion-empty">{{ message }}</p>
        <button :id="`${listId}-${suggestions.length}`" type="button" tabindex="-1" role="option" :aria-selected="highlighted === suggestions.length" class="search-view-all" :class="{ active: highlighted === suggestions.length }" @pointermove="highlighted = suggestions.length" @click="submit"><span>查看“{{ modelValue.trim() }}”的全部结果</span><span aria-hidden="true">↵</span></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar-search { position: relative; z-index: 40; }
.search-draft-clear { flex: 0 0 20px; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--mb-text-secondary); font-size: 17px; cursor: pointer; }
.sidebar-search-popover { position: absolute; z-index: 90; top: calc(100% + 9px); left: 0; width: min(420px, calc(100vw - 90px)); border: 1px solid var(--mb-glass-border); border-radius: 16px; background: color-mix(in srgb, var(--mb-bg-elevated) 80%, transparent); backdrop-filter: blur(32px) saturate(1.2); -webkit-backdrop-filter: blur(32px) saturate(1.2); box-shadow: 0 18px 55px #11182730; color: var(--mb-text-primary); overflow: hidden; }
.search-popover-heading { display: flex; justify-content: space-between; padding: 13px 15px 8px; font-size: 11px; color: var(--mb-text-secondary); }
.search-suggestion-list { max-height: min(560px, 72vh); overflow-y: auto; padding: 4px 6px 6px; }
.search-suggestion { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 62px; padding: 8px; text-align: left; border: 0; border-radius: 9px; background: transparent; color: inherit; cursor: pointer; }
.search-suggestion.active, .search-view-all.active { background: color-mix(in srgb, var(--mb-accent) 13%, transparent); }
.search-suggestion-art { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 7px; overflow: hidden; }
.search-suggestion-art.circular { border-radius: 50%; }
.search-suggestion-copy { flex: 1; display: grid; gap: 4px; min-width: 0; }
.search-suggestion-copy strong, .search-suggestion-copy small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.search-suggestion-copy strong { font-size: 12px; font-weight: 600; }
.search-suggestion-copy small, .search-suggestion-source { font-size: 10px; color: var(--mb-text-secondary); }
.search-suggestion-empty { margin: 10px; color: var(--mb-text-secondary); font-size: 12px; }
.search-view-all { display: flex; justify-content: space-between; gap: 10px; width: 100%; padding: 13px 9px 10px; border: 0; border-top: 1px solid var(--mb-glass-border); border-radius: 0 0 8px 8px; background: transparent; color: inherit; text-align: left; font-size: 12px; cursor: pointer; }
.search-view-all span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input::-webkit-search-cancel-button { display: none; }
</style>
