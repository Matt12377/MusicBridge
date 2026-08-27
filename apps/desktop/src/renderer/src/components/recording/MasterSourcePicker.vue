<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { AppendMasterDraftRequest, DraftProgramType, MasterDraft, RoonLibraryItem, RoonLibraryPage } from '@music-bridge/contracts'
const props = defineProps<{ draft?: MasterDraft; busy: boolean; pending: boolean; error: string }>()
const emit = defineEmits<{ close: []; retry: []; confirm: [request: AppendMasterDraftRequest] }>()
const api = window.musicBridge
const dialog = ref<HTMLDialogElement>(), title = ref('我的录音精选'), programType = ref<DraftProgramType>('compilation'), query = ref(''), confirmed = ref(false)
const albums = shallowRef<RoonLibraryPage>(), tracks = shallowRef<RoonLibraryPage>(), album = shallowRef<RoonLibraryItem>(), selected = shallowRef<readonly RoonLibraryItem[]>([])
const loading = ref(false), readError = ref(''), blocked = computed(() => props.busy || props.pending)
let alive = true, generation = 0
async function loadAlbums(offset = 0): Promise<void> {
  const token = ++generation; loading.value = true; readError.value = ''; album.value = undefined; tracks.value = undefined
  try { const result = await api.searchPhysicalRoonAlbums(query.value, { offset, limit: 20 }); if (alive && token === generation) albums.value = result }
  catch { if (alive && token === generation) { albums.value = undefined; readError.value = 'Roon 专辑暂时不可用，请检查连接后重试。未确认选曲不会保存。' } }
  finally { if (alive && token === generation) loading.value = false }
}
async function loadTracks(item: RoonLibraryItem, offset = 0): Promise<void> {
  const token = ++generation; loading.value = true; readError.value = ''; album.value = item; tracks.value = undefined
  try { const result = await api.getRoonAlbumTracks(item.reference, { offset, limit: 30 }); if (alive && token === generation) tracks.value = result }
  catch { if (alive && token === generation) readError.value = '曲目无法读取，可能是 Roon 链接已失效。请重新浏览专辑。' }
  finally { if (alive && token === generation) loading.value = false }
}
function toggle(item: RoonLibraryItem, checked: boolean): void {
  if (blocked.value) return
  selected.value = checked ? [...selected.value.filter(t => t.reference !== item.reference), item] : selected.value.filter(t => t.reference !== item.reference)
}
function close(): void { if (!blocked.value) { dialog.value?.close(); emit('close') } }
function submit(): void {
  if (blocked.value || loading.value || !confirmed.value || !selected.value.length || selected.value.length > 100) return
  emit('confirm', { commandId: crypto.randomUUID(), references: selected.value.map(t => t.reference), userConfirmed: true, ...(props.draft ? { draftId: props.draft.id, expectedRevision: props.draft.revision } : { title: title.value.trim(), programType: programType.value }) })
}
watch([selected, title, programType], () => { confirmed.value = false })
watch(() => props.error, value => { if (value) confirmed.value = false })
onMounted(async () => { await nextTick(); dialog.value?.showModal(); void loadAlbums() })
onBeforeUnmount(() => dialog.value?.close())
onUnmounted(() => { alive = false; ++generation })
</script>
<template>
  <dialog ref="dialog" aria-label="从 Roon 选择曲目" @cancel.prevent="close">
    <header><div><p>私人录音草稿</p><h2>从 Roon 选择曲目</h2></div><button :disabled="blocked" @click="close">取消</button></header>
    <p>可跨专辑选择，按点击顺序加入。这里只保存草稿，尚未验证实际音频源，不开始录音。</p>
    <p v-if="error" role="alert">{{ error }} <button v-if="pending" :disabled="busy" @click="emit('retry')">重试原操作</button></p>
    <fieldset :disabled="blocked"><legend class="sr-only">草稿信息与选曲</legend>
      <div v-if="!draft" class="draft-fields"><label>草稿标题<input v-model="title" maxlength="240" required></label><label>节目类型<select v-model="programType"><option value="compilation">Compilation · 精选</option><option value="concert">Concert · 演出</option><option value="continuous">Continuous Program · 连续节目</option></select></label></div>
      <form v-if="!album" @submit.prevent="loadAlbums()"><label>搜索专辑<input v-model.trim="query" maxlength="240" placeholder="专辑或艺术家"></label><button :disabled="loading">搜索 / 浏览</button></form>
      <header v-else><button @click="loadAlbums(albums?.offset ?? 0)">返回专辑列表</button><h3>{{ album.title }}</h3></header>
      <p v-if="loading" role="status">正在读取 Roon 目录…</p><p v-if="readError" role="alert">{{ readError }}</p>
      <div v-if="!album" class="albums"><button v-for="item in albums?.items" :key="item.reference" class="album" :aria-label="`查看曲目 ${item.title}`" @click="loadTracks(item)"><strong>{{ item.title }}</strong><small>{{ [item.artist, item.year, item.version].filter(Boolean).join(' · ') || '版本待核实' }}</small></button></div>
      <div v-else class="tracks"><label v-for="item in tracks?.items" :key="item.reference" class="track"><input type="checkbox" :checked="selected.some(t => t.reference === item.reference)" :aria-label="`选择 ${item.title}`" :disabled="!selected.some(t => t.reference === item.reference) && selected.length >= 100" @change="toggle(item, ($event.target as HTMLInputElement).checked)"><span><strong>{{ item.title }}</strong><small>{{ item.artist || '艺术家待核实' }} · {{ item.durationMs ? `${Math.floor(item.durationMs / 60000)}:${String(Math.floor(item.durationMs / 1000) % 60).padStart(2, '0')}` : '时长待核实' }}</small></span></label></div>
      <p v-if="!loading && ((album && tracks && !tracks.items.length) || (!album && albums && !albums.items.length))">没有可选内容，不推测或自动补齐曲目。</p>
      <nav v-if="album && tracks" aria-label="选曲分页"><button :disabled="loading || !tracks.offset" @click="loadTracks(album, Math.max(0, tracks.offset - 30))">上一页</button><button :disabled="loading || !tracks.hasMore" @click="loadTracks(album, tracks.offset + 30)">下一页</button></nav>
      <nav v-else-if="albums" aria-label="选曲专辑分页"><button :disabled="loading || !albums.offset" @click="loadAlbums(Math.max(0, albums.offset - 20))">上一页</button><button :disabled="loading || !albums.hasMore" @click="loadAlbums(albums.offset + 20)">下一页</button></nav>
      <section class="selection" aria-label="本次已选曲目"><h3>本次已选 {{ selected.length }} / 100</h3><ol><li v-for="item in selected" :key="item.reference"><span>{{ item.title }}</span><button :aria-label="`取消选择 ${item.title}`" @click="toggle(item, false)">移除</button></li></ol></section>
      <label class="check"><input v-model="confirmed" type="checkbox">我确认将所选曲目按选择顺序加入草稿</label>
      <footer><button :disabled="loading || !selected.length || !confirmed || (!draft && !title.trim())" @click="submit">加入录音草稿</button></footer>
    </fieldset>
  </dialog>
</template>
<style scoped>
dialog{box-sizing:border-box;width:min(780px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid var(--mb-glass-border);border-radius:16px;color:var(--mb-text-primary);background:var(--mb-bg-base)}dialog::backdrop{background:#000b}header,form,nav,footer,li{display:flex;align-items:center;gap:14px;flex-wrap:wrap}header,li{justify-content:space-between}h2{font-size:23px;margin:4px 0 12px}h3{font-size:15px;margin:14px 0}p,small{font-size:12px;line-height:1.8;color:var(--mb-text-secondary)}fieldset{border:0;padding:0;min-width:0}.draft-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px}label{display:grid;gap:8px;margin:14px 0;font-size:13px}form label{flex:1;min-width:160px}input,select,button{font:inherit;color:var(--mb-text-primary)}button,input:not([type]),select{box-sizing:border-box;min-height:40px;max-width:100%;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base)}input:not([type]),select{width:100%}button:disabled,fieldset:disabled{opacity:.5}input[type=checkbox]{accent-color:var(--mb-accent);width:18px;height:18px;flex:none}.albums{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px}.album{display:flex;flex-direction:column;gap:8px;text-align:left;padding:18px}.album:hover{border-color:var(--mb-accent)}strong,small{overflow-wrap:anywhere}.track,.check{display:flex;align-items:center;gap:12px}.track{padding:14px;border:1px solid var(--mb-glass-border);border-radius:10px}.track small{display:block;margin-top:4px}.selection{margin-top:22px;border-top:1px solid var(--mb-divider)}ol{padding-left:0;list-style:none}li{font-size:13px;padding:5px 0}nav,footer{justify-content:flex-end;margin:18px 0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(max-width:600px){.draft-fields{grid-template-columns:1fr;gap:0}}
</style>
