<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { CommercialCopiesSnapshot, CommercialCopyDetails, MusicEntry, MusicPhoto, MusicMutationResult } from '@music-bridge/contracts'
import CollectionPhotoView from './CollectionPhoto.vue'

const props = defineProps<{ release: MusicEntry; photos: readonly MusicPhoto[] }>()
const emit = defineEmits<{ changed: []; busy: [value: boolean] }>()
const api = window.musicBridge
const snapshot = shallowRef<CommercialCopiesSnapshot>()
const loading = ref(false), saving = ref(false), error = ref(''), notice = ref(''), identifyConfirmed = ref(false)
const editing = ref<string>(), location = ref(''), condition = ref(''), purchaseInfo = ref('')
const selectedPhotoByCopy = ref<Record<string, string>>({})
const pending = shallowRef<() => Promise<MusicMutationResult>>()
const blocked = computed(() => saving.value || !!pending.value)
const availablePhotos = computed(() => props.photos.filter(photo => !snapshot.value?.photoAssignments.some(item => item.photoId === photo.id)))
function photoFor(id: string): MusicPhoto | undefined { return props.photos.find(photo => photo.id === id) }
function selectedPhotoFor(copyId: string): MusicPhoto | undefined { return availablePhotos.value.find(photo => photo.id === selectedPhotoByCopy.value[copyId]) }
let alive = true, generation = 0

async function load(offset = 0): Promise<void> {
  const token = ++generation; loading.value = true
  try {
    const result = await api.getCommercialCopies(props.release.id, { offset, limit: 20 })
    if (alive && token === generation) { snapshot.value = result; error.value = '' }
  } catch { if (alive && token === generation) error.value = '逐件资料暂时无法读取；发行数量及旧照片没有被改动。' }
  finally { if (alive && token === generation) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || saving.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try {
    await pending.value()
    if (!alive) return
    pending.value = undefined; editing.value = undefined; selectedPhotoByCopy.value = {}; identifyConfirmed.value = false
    notice.value = '逐件资料已保存'; emit('changed'); await load(snapshot.value?.copies.offset ?? 0)
  } catch (cause) {
    if (!alive) return
    const message = cause instanceof Error ? cause.message : ''
    if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(message)) {
      pending.value = undefined; await load(snapshot.value?.copies.offset ?? 0)
      error.value = '本次操作未保存：资料已变化或不符合当前数量，请重新核对。'
    } else error.value = '操作回执尚未确认；请重试原操作，不要给另一件重新分配身份。'
  } finally { if (alive) saving.value = false }
}
function mutate(operation: () => Promise<MusicMutationResult>): void { if (blocked.value) return; pending.value = operation; void retry() }
function materialize(): void {
  if (!snapshot.value || !identifyConfirmed.value || snapshot.value.poolCount < 1) return
  const request = { commandId: crypto.randomUUID(), releaseId: props.release.id, expectedRevision: props.release.revision, userConfirmed: true as const }
  mutate(() => api.materializeCommercialCopy(request))
}
function edit(copyId: string): void {
  const copy = snapshot.value?.copies.items.find(item => item.id === copyId)
  if (!copy || blocked.value) return
  editing.value = copyId; location.value = copy.details.location ?? ''; condition.value = copy.details.condition ?? ''; purchaseInfo.value = copy.details.purchaseInfo ?? ''
}
function saveDetails(copyId: string): void {
  const copy = snapshot.value?.copies.items.find(item => item.id === copyId)
  if (!copy || blocked.value) return
  const details: CommercialCopyDetails = {
    ...(location.value.trim() ? { location: location.value.trim() } : {}),
    ...(condition.value.trim() ? { condition: condition.value.trim() } : {}),
    ...(purchaseInfo.value.trim() ? { purchaseInfo: purchaseInfo.value.trim() } : {}),
  }
  const request = { commandId: crypto.randomUUID(), copyId, expectedRevision: copy.revision, details, userConfirmed: true as const }
  mutate(() => api.saveCommercialCopyDetails(request))
}
function assignPhoto(copyId: string, photoId: string, action: 'attach' | 'detach'): void {
  const copy = snapshot.value?.copies.items.find(item => item.id === copyId)
  if (!copy || !props.photos.some(photo => photo.id === photoId) || blocked.value) return
  if (action === 'attach' && (!availablePhotos.value.some(photo => photo.id === photoId) || selectedPhotoByCopy.value[copyId] !== photoId)) return
  const request = { commandId: crypto.randomUUID(), copyId, photoId, expectedRevision: copy.revision, action, userConfirmed: true as const }
  mutate(() => api.assignCommercialCopyPhoto(request))
}
watch(blocked, value => emit('busy', value))
watch(() => props.release.revision, () => { if (!blocked.value) void load(snapshot.value?.copies.offset ?? 0) })
onMounted(() => { void load() })
onUnmounted(() => { alive = false; ++generation; emit('busy', false) })
</script>

<template>
  <section class="commercial-copies" aria-label="商业发行逐件身份">
    <header><div><h3>每一件实物</h3><p>原版发行的数量与逐件身份分开。旧存放位置、品相、购买备注和照片仍属发行版；不会猜成某一件。</p></div></header>
    <p v-if="error" role="alert">{{ error }} <button v-if="pending" :disabled="saving" @click="retry">重试原操作</button><button v-else :disabled="loading" @click="load(snapshot?.copies.offset ?? 0)">刷新逐件资料</button></p>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="loading" role="status">正在读取逐件资料…</p>
    <template v-if="snapshot">
      <p>发行数量 {{ snapshot.quantity }} · 已有逐件编号 {{ snapshot.assignedCount }} · 未逐件识别 Pool {{ snapshot.poolCount }}</p>
      <div v-if="snapshot.poolCount" class="assign">
        <label><input v-model="identifyConfirmed" type="checkbox" :disabled="blocked">我正在核对手上的一件实物，为它分配永久编号；不会增加发行总数</label>
        <button :disabled="blocked || !identifyConfirmed" @click="materialize">给这一件分配永久编号</button>
      </div>
      <p v-else>当前发行数量已全部逐件识别；需要增加数量时先编辑发行版，不会重复复用已有编号。</p>
      <article v-for="copy in snapshot.copies.items" :key="copy.id" class="copy-card">
        <header><div><strong>实物 {{ copy.id }}</strong><small>永久身份 · {{ new Date(copy.assignedAt).toLocaleString() }} · 修订 {{ copy.revision }}</small></div><button :disabled="blocked" @click="edit(copy.id)">编辑这一件</button></header>
        <dl><div><dt>存放位置</dt><dd>{{ copy.details.location || '未逐件记录' }}</dd></div><div><dt>品相</dt><dd>{{ copy.details.condition || '未逐件记录' }}</dd></div><div><dt>购买信息</dt><dd>{{ copy.details.purchaseInfo || '未逐件记录' }}</dd></div></dl>
        <form v-if="editing === copy.id" @submit.prevent="saveDetails(copy.id)">
          <label>这件的存放位置<input v-model="location" maxlength="240" placeholder="只填写已经核对的事实"></label>
          <label>这件的品相<input v-model="condition" maxlength="240" placeholder="不从发行版批量字段继承"></label>
          <label>这件的购买信息<textarea v-model="purchaseInfo" maxlength="1000" rows="2" placeholder="只填写该件的来源或购买记录"></textarea></label>
          <div class="actions"><button :disabled="blocked">保存这件资料</button><button type="button" :disabled="blocked" @click="editing = undefined">取消编辑</button></div>
        </form>
        <div class="copy-photos"><strong>明确归属这件的照片</strong><p v-if="!copy.photoIds.length">尚无逐件照片；上方发行版照片不自动归给它。</p>
          <div v-for="photoId in copy.photoIds" :key="photoId" class="photo-row"><CollectionPhotoView v-if="photoFor(photoId)" :photo="photoFor(photoId)!" :load-photo="api.getPhysicalMusicPhoto" :alt="`明确归属实物 ${copy.id} 的照片`" /><span>{{ photoId }}</span><button :disabled="blocked" @click="assignPhoto(copy.id, photoId, 'detach')">取消这件的照片归属</button></div>
          <div v-if="availablePhotos.length" class="photo-selector"><label>选择发行版照片<select v-model="selectedPhotoByCopy[copy.id]" :disabled="blocked"><option value="">请选择已核对的照片</option><option v-for="photo in availablePhotos" :key="photo.id" :value="photo.id">发行版照片 {{ props.photos.indexOf(photo) + 1 }} · {{ photo.id }}</option></select></label><div v-if="selectedPhotoFor(copy.id)" class="selected-photo"><CollectionPhotoView :photo="selectedPhotoFor(copy.id)!" :load-photo="api.getPhysicalMusicPhoto" :alt="`待确认归属实物 ${copy.id} 的照片`" /><span>待确认照片 {{ selectedPhotoByCopy[copy.id] }}</span></div><button :disabled="blocked || !selectedPhotoFor(copy.id)" @click="assignPhoto(copy.id, selectedPhotoByCopy[copy.id] ?? '', 'attach')">确认归属这件</button></div>
        </div>
      </article>
      <nav v-if="snapshot.copies.total > snapshot.copies.limit" aria-label="商业逐件分页"><button :disabled="loading || blocked || !snapshot.copies.offset" @click="load(Math.max(0, snapshot.copies.offset - 20))">上一页</button><span>{{ snapshot.copies.offset + 1 }}–{{ snapshot.copies.offset + snapshot.copies.items.length }} / {{ snapshot.copies.total }}</span><button :disabled="loading || blocked || !snapshot.copies.hasMore" @click="load(snapshot.copies.offset + 20)">下一页</button></nav>
    </template>
  </section>
</template>

<style scoped>
.commercial-copies{margin:28px 0;padding:24px;border:1px solid var(--mb-glass-border);border-radius:14px;background:var(--mb-bg-base);min-width:0}header,.actions,.assign,nav,.photo-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h3{font-size:19px;margin:0 0 8px}p,small{font-size:12px;line-height:1.7;color:var(--mb-text-secondary);overflow-wrap:anywhere}button,input,select,textarea{font:inherit;color:var(--mb-text-primary)}button,input:not([type]),select,textarea{box-sizing:border-box;min-height:40px;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-glass-clear);max-width:100%;font-size:13px}button:disabled{opacity:.5;cursor:not-allowed}input[type=checkbox]{accent-color:var(--mb-accent);width:18px;height:18px;flex:none}.assign,.copy-card{padding:18px;border:1px solid var(--mb-glass-border);border-radius:12px;margin:16px 0}.assign label{display:flex;align-items:center;gap:8px;max-width:680px;font-size:13px}.copy-card strong{overflow-wrap:anywhere;font-size:13px}.copy-card small{display:block;margin-top:6px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:14px;margin:16px 0}dt{font-size:12px;color:var(--mb-text-secondary)}dd{margin:4px 0 0;font-size:13px;overflow-wrap:anywhere}form label,.copy-photos label,.photo-selector label{display:grid;gap:8px;font-size:12px;flex:1;min-width:min(220px,100%)}form{display:grid;gap:12px}input:not([type]),select,textarea{width:100%}.copy-photos{border-top:1px solid var(--mb-divider);padding-top:12px}.photo-row span,.selected-photo span{font-size:11px;overflow-wrap:anywhere}.photo-row .collection-photo,.selected-photo .collection-photo{width:120px;height:90px;border-radius:8px}.photo-selector{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin-top:12px}.selected-photo{display:grid;gap:6px}nav{justify-content:center;font-size:12px;margin-top:18px}@media(max-width:600px){.commercial-copies{padding:16px}.assign button{width:100%}}
</style>
