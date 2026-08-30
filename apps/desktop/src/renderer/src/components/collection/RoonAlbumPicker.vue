<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { DigitalAlbum, Page, PhysicalRelation, RoonLibraryPage } from '@music-bridge/contracts'
const props = defineProps<{ mode: 'link' | 'register' | 'relocate'; cd?: boolean; busy: boolean; pending: boolean; error: string }>()
const emit = defineEmits<{ close: []; retry: []; confirm: [selection: { reference?: string; digitalId?: string; relation: PhysicalRelation; ripFromCdConfirmed: boolean; physicalAbsenceConfirmed: boolean }] }>()
const dialog = ref<HTMLDialogElement>(), source = ref<'roon' | 'saved'>('roon'), query = ref(''), selected = ref(''), confirmed = ref(false)
const relation = ref<PhysicalRelation>('probable'), rip = ref(false), absent = ref(false), loading = ref(false), readError = ref('')
const roon = shallowRef<RoonLibraryPage>(), saved = shallowRef<Page<DigitalAlbum>>()
const blocked = computed(() => props.busy || props.pending)
const currentPage = computed(() => source.value === 'roon' ? roon.value : saved.value)
const choices = computed(() => source.value === 'roon' ? (roon.value?.items ?? []).map(a => ({ id: a.reference, ...a })) : (saved.value?.items ?? []).map(a => ({ id: a.id, ...a.metadata })))
let alive = true, generation = 0
async function load(offset = 0): Promise<void> {
  const token = ++generation; loading.value = true; readError.value = ''; selected.value = ''; confirmed.value = false
  roon.value = undefined; saved.value = undefined
  try {
    if (source.value === 'roon') { const result = await window.musicBridge.searchPhysicalRoonAlbums(query.value, { offset, limit: 20 }); if (alive && token === generation) roon.value = result }
    else { const result = await window.musicBridge.listDigitalAlbums({ offset, limit: 20 }); if (alive && token === generation) saved.value = result }
  } catch { if (alive && token === generation) readError.value = '目录暂时无法读取。请检查 Roon 连接后重试；已有收藏不会改变。' }
  finally { if (alive && token === generation) loading.value = false }
}
function close(): void { if (!blocked.value) { dialog.value?.close(); emit('close') } }
function submit(): void {
  if (blocked.value || loading.value || !confirmed.value || !choices.value.some(a => a.id === selected.value)) return
  emit('confirm', { ...(source.value === 'roon' ? { reference: selected.value } : { digitalId: selected.value }), relation: relation.value, ripFromCdConfirmed: !!props.cd && relation.value === 'exact' && rip.value, physicalAbsenceConfirmed: absent.value })
}
watch(() => props.error, value => { if (value) confirmed.value = false })
watch(source, () => { void load() })
watch([selected, relation, rip, absent], () => { confirmed.value = false })
watch(relation, value => { if (value !== 'exact') rip.value = false })
onMounted(async () => { await nextTick(); dialog.value?.showModal(); void load() })
onBeforeUnmount(() => dialog.value?.close())
onUnmounted(() => { alive = false; ++generation })
</script>
<template>
  <dialog ref="dialog" class="relation-picker" aria-label="选择 Roon 专辑" @cancel.prevent="close">
    <header><div><p>实体与数字收藏</p><h2>选择 Roon 专辑</h2></div><button :disabled="blocked" @click="close">取消</button></header>
    <p>这是一条由你确认的目录关系，不是音频校验或正式录音来源证明。</p>
    <p v-if="mode === 'relocate'">请核对标题、艺术家、年份和版本。不同元数据不会覆盖原来的数字对象。</p>
    <p v-if="error" role="alert">{{ error }} <button v-if="pending" :disabled="busy" @click="emit('retry')">重试原操作</button></p>
    <fieldset :disabled="blocked"><legend class="sr-only">专辑选择与确认</legend>
      <label v-if="mode === 'link'">候选来源<select v-model="source"><option value="roon">当前 Roon 目录</option><option value="saved">已保存的数字对象（可离线关联）</option></select></label>
      <form @submit.prevent="load()"><label v-if="source === 'roon'">搜索 Roon 专辑<input v-model.trim="query" maxlength="240" placeholder="专辑或艺术家"></label><button :disabled="loading">{{ source === 'roon' ? '搜索 / 浏览' : '刷新已存对象' }}</button></form>
      <p v-if="loading" role="status">正在读取专辑…</p><p v-if="readError" role="alert">{{ readError }}</p>
      <div class="candidates"><label v-for="album in choices" :key="album.id" class="candidate"><input v-model="selected" type="radio" name="album" :value="album.id"><span><strong>{{ album.title }}</strong><small>{{ [album.artist, album.year, album.version].filter(Boolean).join(' · ') || '版本信息待核实' }}</small><small v-if="source === 'saved'">{{ album.id }}</small></span></label></div>
      <p v-if="currentPage && !choices.length && !loading">没有可选专辑。不会自动创建同名关联。</p>
      <nav v-if="currentPage" aria-label="候选专辑分页"><button :disabled="loading || !currentPage.offset" @click="load(Math.max(0, currentPage.offset - 20))">上一页</button><span>第 {{ Math.floor(currentPage.offset / 20) + 1 }} 页</span><button :disabled="loading || !currentPage.hasMore" @click="load(currentPage.offset + 20)">下一页</button></nav>
      <label v-if="mode === 'link'">关系类型<select v-model="relation"><option value="probable">Probable · 可能同版</option><option value="exact">Exact · 用户确认同版</option><option value="related">Related · 相关版本</option></select></label>
      <label v-if="mode === 'link' && cd && relation === 'exact'" class="check"><input v-model="rip" type="checkbox">确认此数字版本由这张原版 CD 抓轨</label>
      <label v-if="mode === 'register'" class="check"><input v-model="absent" type="checkbox">我确认尚未收藏此专辑的原版实物</label>
      <label class="check"><input v-model="confirmed" type="checkbox">我已核对候选信息并确认本次选择</label>
      <footer><button :disabled="!selected || !confirmed || loading" @click="submit">{{ mode === 'link' ? '确认关联' : mode === 'register' ? '保存数字对象' : '确认重新定位' }}</button></footer>
    </fieldset>
  </dialog>
</template>
<style scoped>
.relation-picker{width:min(680px,calc(100vw - 32px));max-height:calc(100dvh - 32px);box-sizing:border-box;padding:24px;border:1px solid var(--mb-glass-border);border-radius:16px;color:var(--mb-text-primary);background:var(--mb-bg-base)}dialog::backdrop{background:#000b}header,form,nav{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}h2{font-size:23px;margin:4px 0 12px}p,small{font-size:12px;line-height:1.8;color:var(--mb-text-secondary)}fieldset{border:0;padding:0;min-width:0}label{display:grid;gap:8px;margin:14px 0;font-size:13px}form label{flex:1;min-width:160px}button,input,select{font:inherit;color:var(--mb-text-primary)}button,input:not([type]),select{box-sizing:border-box;min-height:40px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);padding:8px 12px;max-width:100%}input:not([type]),select{width:100%}button:disabled,fieldset:disabled{opacity:.55}input[type=checkbox],input[type=radio]{accent-color:var(--mb-accent);width:18px;height:18px;flex:none}.candidate,.check{display:flex;align-items:center;gap:12px;cursor:pointer}.candidate{border:1px solid var(--mb-glass-border);border-radius:10px;padding:14px}.candidate:has(input:checked){border-color:var(--mb-accent);background:var(--mb-glass-clear)}.candidate span{min-width:0;overflow-wrap:anywhere}.candidate small{display:block;margin-top:4px}nav{font-size:12px;margin:18px 0}footer{margin-top:20px;display:flex;justify-content:flex-end}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
</style>
