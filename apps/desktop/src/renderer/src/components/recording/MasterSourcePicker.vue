<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { AppendMasterDraftRequest, DraftProgramType, MasterDraft, RoonLibraryItem } from '@music-bridge/contracts'
import SourcePickerRelations from './SourcePickerRelations.vue'
import { SourcePickerController, sourceRoonAvailability, sourceTabForKey, type SourceTab, type SourcePickerState } from './source-picker-controller'
const props = defineProps<{ draft?: MasterDraft; busy: boolean; pending: boolean; error: string }>()
const emit = defineEmits<{ close: []; retry: []; confirm: [request: AppendMasterDraftRequest] }>()
const api = window.musicBridge
const dialog = ref<HTMLDialogElement>(), title = ref('我的录音精选'), programType = ref<DraftProgramType>('compilation'), query = ref(''), relationQuery = ref(''), confirmed = ref(false)
const controller = new SourcePickerController(api, value => { state.value = value })
const state = shallowRef<SourcePickerState>(controller.state)
const submitting = ref(false), blocked = computed(() => props.busy || props.pending || submitting.value)
const selected = computed(() => state.value.selected), hasStaleSelection = computed(() => selected.value.some(item => item.stale))
const tabs: readonly { id: SourceTab; label: string }[] = [{ id: 'roon', label: 'Roon 浏览' }, { id: 'relations', label: '已登记收藏关系' }]
let alive = true, trigger: HTMLElement | null = null, unsubscribe: (() => void) | undefined, lastDigitalId = ''
function focus(selector: string): void { if (alive) dialog.value?.querySelector<HTMLElement>(selector)?.focus() }
async function loadAlbums(offset = 0): Promise<void> {
  if (!blocked.value) await controller.loadAlbums(query.value, offset)
}
async function loadTracks(item: RoonLibraryItem, offset = 0): Promise<void> {
  if (blocked.value) return
  await controller.loadRoonTracks(item, offset)
  await nextTick()
  if (state.value.tab === 'roon' && state.value.album?.reference === item.reference) focus('[data-tracks-heading]')
}
async function loadMatrix(offset = 0): Promise<void> { if (!blocked.value) await controller.loadMatrix(relationQuery.value.trim(), offset) }
async function openDigital(id: string): Promise<void> {
  if (blocked.value) return
  lastDigitalId = id
  await controller.openDigital(id)
  await nextTick()
  if (state.value.tab === 'relations' && state.value.digital?.album.id === id) focus('[data-relation-heading]')
}
async function relationTracks(offset = 0): Promise<void> {
  if (blocked.value) return
  await controller.loadRelationTracks(offset)
  await nextTick()
  if (state.value.tab === 'relations' && state.value.album) focus('[data-tracks-heading]')
}
async function changeTab(tab: SourceTab): Promise<void> {
  if (blocked.value) return
  controller.setTab(tab)
  if (tab === 'relations' && !state.value.matrix && !state.value.digital) void loadMatrix()
  else if (tab === 'roon' && !state.value.albums) void loadAlbums()
}
function tabKey(event: KeyboardEvent): void {
  const tab = sourceTabForKey(state.value.tab, event.key)
  if (!tab || blocked.value) return
  event.preventDefault()
  void changeTab(tab)
  focus(`#source-tab-${tab}`)
}
async function backFromTracks(): Promise<void> {
  if (blocked.value) return
  const reference = state.value.album?.reference
  controller.backFromTracks()
  await nextTick()
  if (state.value.tab === 'relations') focus(state.value.runtime?.status === 'available' ? '[data-relation-tracks]' : '[data-relation-heading]')
  else if (reference && state.value.albums) focus(`[data-album-reference="${CSS.escape(reference)}"]`)
  else focus('#source-tab-roon')
}
async function backToMatrix(): Promise<void> {
  if (blocked.value) return
  controller.backToMatrix()
  await nextTick()
  focus(`[data-digital-id="${CSS.escape(lastDigitalId)}"]`)
}
function toggle(item: RoonLibraryItem, checked: boolean): void {
  if (blocked.value) return
  controller.toggle(item, checked)
}
function close(): void { if (!blocked.value) { dialog.value?.close(); emit('close') } }
async function submit(): Promise<void> {
  if (blocked.value || state.value.loading || !confirmed.value || !selected.value.length || hasStaleSelection.value || (!props.draft && !title.value.trim())) return
  submitting.value = true
  if (!await controller.validateSelection() || !alive) { submitting.value = false; confirmed.value = false; return }
  const references = controller.selectedReferences()
  if (!references.length || references.length > 100) { submitting.value = false; confirmed.value = false; return }
  // 父组件继续拥有原 append/outbox；本次确认只发一次，未知回执仍重试原操作。
  emit('confirm', { commandId: crypto.randomUUID(), references, userConfirmed: true, ...(props.draft ? { draftId: props.draft.id, expectedRevision: props.draft.revision } : { title: title.value.trim(), programType: programType.value }) })
}
watch([() => selected.value.map(entry => `${entry.item.reference}:${entry.stale}`).join('|'), title, programType], () => { confirmed.value = false })
watch(() => props.error, value => { if (value) { confirmed.value = false; submitting.value = false } })
onMounted(async () => {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick(); dialog.value?.showModal()
  unsubscribe = api.onCoreEvent(event => {
    if (!alive) return
    const available = sourceRoonAvailability(event)
    if (available !== undefined) controller.setRoonAvailable(available)
  })
  void loadAlbums()
})
onBeforeUnmount(() => { alive = false; controller.dispose(); unsubscribe?.(); dialog.value?.close(); if (trigger?.isConnected) trigger.focus() })
onUnmounted(() => { unsubscribe = undefined })
</script>
<template>
  <dialog ref="dialog" aria-label="从 Roon 选择曲目" @cancel.prevent="close">
    <header><div><p>私人录音草稿</p><h2>从 Roon 选择曲目</h2></div><button :disabled="blocked" @click="close">取消</button></header>
    <p>可跨专辑选择，按点击顺序加入。这里只保存草稿，尚未验证实际音频源，不开始录音。</p>
    <p v-if="error" role="alert">{{ error }} <button v-if="pending" :disabled="busy" @click="emit('retry')">重试原操作</button></p>
    <fieldset :disabled="blocked"><legend class="sr-only">草稿信息与选曲</legend>
      <div v-if="!draft" class="draft-fields"><label>草稿标题<input v-model="title" maxlength="240" required></label><label>节目类型<select v-model="programType"><option value="compilation">Compilation · 精选</option><option value="concert">Concert · 演出</option><option value="continuous">Continuous Program · 连续节目</option></select></label></div>
      <div class="source-tabs" role="tablist" aria-label="曲目来源" @keydown="tabKey"><button v-for="tab in tabs" :id="`source-tab-${tab.id}`" :key="tab.id" role="tab" type="button" :aria-selected="state.tab === tab.id" :aria-controls="`source-panel-${tab.id}`" :tabindex="state.tab === tab.id ? 0 : -1" @click="changeTab(tab.id)">{{ tab.label }}</button></div>
      <p v-if="state.loading" role="status">{{ submitting ? '正在核对所选曲目的当前 Roon 引用…' : state.tab === 'relations' ? '正在读取收藏关系或关联曲目…' : '正在读取 Roon 目录…' }}</p>
      <p v-if="state.error" role="alert">{{ state.error }}</p>
      <section v-for="tab in tabs" v-show="state.tab === tab.id" :id="`source-panel-${tab.id}`" :key="tab.id" role="tabpanel" :aria-labelledby="`source-tab-${tab.id}`">
        <template v-if="state.tab === tab.id">
          <SourcePickerRelations v-if="tab.id === 'relations' && !state.album" v-model:query="relationQuery" :state="state" :blocked="blocked" @load="loadMatrix" @open="openDigital" @tracks="relationTracks()" @back="backToMatrix" @refresh="state.digital && openDigital(state.digital.album.id)" />
          <template v-else-if="!state.album">
            <form @submit.prevent="loadAlbums()"><label>搜索专辑<input v-model.trim="query" maxlength="240" placeholder="专辑或艺术家"></label><button :disabled="state.loading">搜索 / 浏览</button></form>
            <div class="albums"><button v-for="item in state.albums?.items" :key="item.reference" class="album" :data-album-reference="item.reference" :aria-label="`查看曲目 ${item.title}`" @click="loadTracks(item)"><strong>{{ item.title }}</strong><small>{{ [item.artist, item.year, item.version].filter(Boolean).join(' · ') || '版本待核实' }}</small></button></div>
            <p v-if="!state.loading && state.albums && !state.albums.items.length">没有可选内容，不推测或自动补齐曲目。</p>
            <nav v-if="state.albums" aria-label="选曲专辑分页"><button :disabled="state.loading || !state.albums.offset" @click="loadAlbums(Math.max(0, state.albums.offset - 20))">上一页</button><button :disabled="state.loading || !state.albums.hasMore" @click="loadAlbums(state.albums.offset + 20)">下一页</button></nav>
          </template>
          <template v-else>
            <header><button @click="backFromTracks">{{ tab.id === 'relations' ? '返回数字关联详情' : '返回专辑列表' }}</button><h3 tabindex="-1" data-tracks-heading>{{ state.album.title }}</h3></header>
            <div class="tracks"><label v-for="item in state.tracks?.items" :key="item.reference" class="track"><input type="checkbox" :checked="selected.some(t => t.item.reference === item.reference && !t.stale)" :aria-label="`选择 ${item.title}`" :disabled="state.loading || state.offline || (!selected.some(t => t.item.reference === item.reference) && selected.length >= 100)" @change="toggle(item, ($event.target as HTMLInputElement).checked)"><span><strong>{{ item.title }}</strong><small>{{ item.artist || '艺术家待核实' }} · {{ item.durationMs ? `${Math.floor(item.durationMs / 60000)}:${String(Math.floor(item.durationMs / 1000) % 60).padStart(2, '0')}` : '时长待核实' }}</small></span></label></div>
            <p v-if="!state.loading && state.tracks && !state.tracks.items.length">没有可选内容，不推测或自动补齐曲目。</p>
            <nav v-if="state.tracks" aria-label="选曲分页"><button :disabled="state.loading || !state.tracks.offset" @click="tab.id === 'relations' ? relationTracks(Math.max(0, state.tracks.offset - 30)) : loadTracks(state.album, Math.max(0, state.tracks.offset - 30))">上一页</button><button :disabled="state.loading || !state.tracks.hasMore" @click="tab.id === 'relations' ? relationTracks(state.tracks.offset + 30) : loadTracks(state.album, state.tracks.offset + 30)">下一页</button></nav>
          </template>
        </template>
      </section>
      <section class="selection" aria-label="本次已选曲目"><h3>本次已选 {{ selected.length }} / 100</h3><p v-if="hasStaleSelection" role="status">含失效选择。请重新读取并勾选，或移除后再确认；恢复连接不会自动恢复旧选择。</p><ol><li v-for="entry in selected" :key="entry.item.reference"><span>{{ entry.item.title }}<small v-if="entry.stale"> · 已失效，需重新选择</small></span><button :aria-label="`取消选择 ${entry.item.title}`" @click="toggle(entry.item, false)">移除</button></li></ol></section>
      <label class="check"><input v-model="confirmed" type="checkbox">我确认将所选曲目按选择顺序加入草稿</label>
      <footer><button :disabled="state.loading || state.offline || hasStaleSelection || !selected.length || !confirmed || (!draft && !title.trim())" @click="submit">加入录音草稿</button></footer>
    </fieldset>
  </dialog>
</template>
<style scoped>
.source-tabs{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.source-tabs [aria-selected=true]{border-color:var(--mb-accent);color:var(--mb-accent)}
h3,.track>span,.selection li>span{min-width:0;overflow-wrap:anywhere}
dialog{box-sizing:border-box;width:min(780px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid var(--mb-glass-border);border-radius:16px;color:var(--mb-text-primary);background:var(--mb-bg-base)}dialog::backdrop{background:#000b}header,form,nav,footer,li{display:flex;align-items:center;gap:14px;flex-wrap:wrap}header,li{justify-content:space-between}h2{font-size:23px;margin:4px 0 12px}h3{font-size:15px;margin:14px 0}p,small{font-size:12px;line-height:1.8;color:var(--mb-text-secondary)}fieldset{border:0;padding:0;min-width:0}.draft-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px}label{display:grid;gap:8px;margin:14px 0;font-size:13px}form label{flex:1;min-width:160px}input,select,button{font:inherit;color:var(--mb-text-primary)}button,input:not([type]),select{box-sizing:border-box;min-height:40px;max-width:100%;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base)}input:not([type]),select{width:100%}button:disabled,fieldset:disabled{opacity:.5}input[type=checkbox]{accent-color:var(--mb-accent);width:18px;height:18px;flex:none}.albums{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px}.album{display:flex;flex-direction:column;gap:8px;text-align:left;padding:18px}.album:hover{border-color:var(--mb-accent)}strong,small{overflow-wrap:anywhere}.track,.check{display:flex;align-items:center;gap:12px}.track{padding:14px;border:1px solid var(--mb-glass-border);border-radius:10px}.track small{display:block;margin-top:4px}.selection{margin-top:22px;border-top:1px solid var(--mb-divider)}ol{padding-left:0;list-style:none}li{font-size:13px;padding:5px 0}nav,footer{justify-content:flex-end;margin:18px 0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(max-width:600px){.draft-fields{grid-template-columns:1fr;gap:0}}
</style>
