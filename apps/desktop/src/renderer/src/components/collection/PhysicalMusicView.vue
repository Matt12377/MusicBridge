<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { MusicDetail, MusicEntry, MusicFilter, MusicMutationResult, Page } from '@music-bridge/contracts'
import PhysicalMusicEditor from './PhysicalMusicEditor.vue'
import CollectionPhotoView from './CollectionPhoto.vue'
const props = defineProps<{ requestedId?: string; active: boolean }>()
const emit = defineEmits<{ model: [id: string] }>()
const api = window.musicBridge
const catalog = shallowRef<Page<MusicEntry>>()
const detail = shallowRef<MusicDetail>()
const loading = ref(false), saving = ref(false), error = ref(''), notice = ref(''), editing = ref(false)
const query = ref(''), kind = ref<MusicFilter['kind'] | ''>('')
const pending = shallowRef<() => Promise<MusicMutationResult>>()
const removing = ref<string>(), preview = shallowRef<MusicDetail['photos'][number]>(), viewer = ref<HTMLDialogElement>()
let active = true, generation = 0
const labels = { cd: '原版 CD', cassette: '原版磁带', 'personal-cassette': '自录磁带', 'personal-dat': '自录 DAT' }
const completeness = { basic: '基础资料', partial: '部分补齐', verified: '已由用户核实发行版' }
const releaseFields = [{ key: 'year', label: '年份' }, { key: 'edition', label: '版次' }, { key: 'label', label: '厂牌' }, { key: 'catalogNumber', label: '目录号' }, { key: 'barcode', label: '条码' }, { key: 'region', label: '地区' }, { key: 'discCount', label: '碟数' }, { key: 'packaging', label: '包装' }, { key: 'condition', label: '整体品相' }, { key: 'storage', label: '存放位置' }, { key: 'purchaseInfo', label: '购买备注' }, { key: 'tapeType', label: '磁带类型' }, { key: 'noiseReduction', label: 'Dolby / NR' }, { key: 'tapeCondition', label: '磁带品相' }, { key: 'jCardCondition', label: 'J-Card 品相' }, { key: 'caseCondition', label: '盒子品相' }] as const
async function load(offset = 0): Promise<void> {
  const current = ++generation; loading.value = true
  try {
    const result = await api.listPhysicalMusic({ offset, limit: 24 }, { query: query.value, ...(kind.value ? { kind: kind.value } : {}) })
    if (active && generation === current) { catalog.value = result; if (!pending.value) error.value = '' }
  } catch { if (active && generation === current) error.value = '音乐库暂时无法读取，现有收藏不会被清空。' }
  finally { if (active && generation === current) loading.value = false }
}
async function open(id: string): Promise<void> {
  const current = ++generation; loading.value = true
  try { const result = await api.getPhysicalMusic(id); if (active && generation === current) { detail.value = result; error.value = '' } }
  catch { if (active && generation === current) error.value = '音乐资料无法读取，请刷新后重试。' }
  finally { if (active && generation === current) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || saving.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const result = await pending.value()
    if (!active) return
    pending.value = undefined; editing.value = false; removing.value = undefined
    notice.value = '音乐资料已保存'; await load(catalog.value?.offset ?? 0); await open(result.id)
  } catch { if (active) error.value = '保存结果尚未确认，请重试原操作；不会重复新增实物。' }
  finally { saving.value = false }
}
function mutate(operation: () => Promise<MusicMutationResult>): void { if (saving.value || pending.value) return; pending.value = operation; void retry() }
function back(): void { ++generation; detail.value = undefined; loading.value = false; notice.value = ''; void load(catalog.value?.offset ?? 0) }
function create(): void { detail.value = undefined; editing.value = true }
async function addPhoto(): Promise<void> {
  if (!detail.value || saving.value || pending.value) return
  const id = detail.value.entry.id; saving.value = true
  try { const image = await api.pickCollectionPhoto(); saving.value = false; if (image && active) { const request = { commandId: crypto.randomUUID(), id, image }; mutate(() => api.addPhysicalMusicPhoto(request)) } }
  catch { error.value = '照片未导入，请选择有效 PNG / JPEG 普通文件。' }
  finally { if (!pending.value) saving.value = false }
}
function removePhoto(photoId: string): void { if (!detail.value) return; const request = { commandId: crypto.randomUUID(), id: detail.value.entry.id, photoId, expectedRevision: detail.value.entry.revision }; mutate(() => api.removePhysicalMusicPhoto(request)) }
async function showPhoto(photo: MusicDetail['photos'][number]): Promise<void> { preview.value = photo; await nextTick(); viewer.value?.showModal() }
function closePhoto(): void { if (!viewer.value?.open) preview.value = undefined }
watch(() => props.requestedId, id => { if (id) void open(id) })
watch(() => props.active, value => { if (value && !detail.value) void load() })
onMounted(() => { if (props.requestedId) void open(props.requestedId); else if (props.active) void load() })
onUnmounted(() => { active = false; ++generation })
</script>
<template>
  <section class="music-library" aria-label="实体音乐库内容">
    <p v-if="error" role="alert">{{ error }} <button v-if="pending && !editing" :disabled="saving" @click="retry">重试原操作</button><button v-else-if="!pending" :disabled="loading" @click="detail ? open(detail.entry.id) : load()">刷新音乐库</button></p>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="loading" role="status">正在读取音乐资料…</p>
    <template v-if="detail">
      <header><button :disabled="saving || !!pending" @click="back">← 返回音乐库</button><button :disabled="saving || !!pending" @click="editing = true">{{ detail.release ? '编辑资料' : '补录录音内容' }}</button></header>
      <p class="accent">{{ labels[detail.entry.kind] }} · {{ detail.release ? completeness[detail.release.completeness] : detail.recording ? '历史补录，非正式录音证据' : '已录音，内容待补录' }}</p>
      <h2>{{ detail.entry.title }}</h2><p>{{ detail.entry.artist }}</p>
      <div class="identity"><span>实物数量 {{ detail.entry.quantity }}</span><span>{{ detail.entry.id }}</span><span>Roon 尚未关联</span></div>
      <p v-if="detail.entry.modelId">本记录沿用原磁带编号，不增加库存。<button @click="emit('model', detail.entry.modelId!)">查看磁带型号与单盘</button></p>
      <dl v-if="detail.release" class="metadata"><template v-for="field in releaseFields" :key="field.key"><div v-if="detail.release[field.key]"><dt>{{ field.label }}</dt><dd>{{ detail.release[field.key] }}</dd></div></template></dl>
      <p v-else-if="detail.recording?.storage">存放位置：{{ detail.recording.storage }}</p>
      <p v-if="(detail.release ?? detail.recording)?.notes">{{ (detail.release ?? detail.recording)?.notes }}</p>
      <section v-if="detail.release" aria-label="发行版实物照片">
        <header><h3>实物照片 · {{ detail.photos.length }} / 24</h3><button :disabled="saving || !!pending || detail.photos.length >= 24" @click="addPhoto">添加发行版照片</button></header>
        <p v-if="!detail.photos.length">尚未添加照片。只保存展示副本，原文件保持不变。</p>
        <div class="photos"><figure v-for="(photo, index) in detail.photos" :key="photo.id"><button class="photo" :aria-label="`查看发行版照片 ${index + 1}`" @click="showPhoto(photo)"><CollectionPhotoView :photo="photo" :load-photo="api.getPhysicalMusicPhoto" :alt="`${detail.entry.title} 实物照片 ${index + 1}`" /></button><figcaption>实物照片 {{ index + 1 }} <button :disabled="saving || !!pending" @click="removing = photo.id">移除</button></figcaption><div v-if="removing === photo.id"><p>仅移除展示副本。</p><button :disabled="saving || !!pending" @click="removePhoto(photo.id)">确认移除照片</button><button @click="removing = undefined">取消</button></div></figure></div>
      </section>
      <h3>曲目</h3><p v-if="!(detail.release ?? detail.recording)?.tracks.length">曲目待补录，不推测录音内容。</p>
      <ol class="track-list"><li v-for="(track, index) in (detail.release ?? detail.recording)?.tracks" :key="index"><span class="track-position">{{ track.side ? `${track.side} 面` : track.disc ? `CD ${track.disc}` : '' }} · {{ track.position }}</span><span>{{ track.title }}<small>{{ track.artist }}</small></span><span>{{ track.durationSeconds ? `${Math.floor(track.durationSeconds / 60)}:${String(track.durationSeconds % 60).padStart(2, '0')}` : '时长待补录' }}</span></li></ol>
    </template>
    <template v-else>
      <header><div><p class="accent">音乐与实物</p><h2>让音乐，有一个实体位置。</h2><p>原版 CD、原版磁带与自录作品，分别记录，共同收藏。</p></div><button :disabled="saving || !!pending || !catalog" @click="create">添加实体音乐</button></header>
      <form class="filters" aria-label="筛选实体音乐" @submit.prevent="load(0)"><label>搜索音乐<input v-model.trim="query" maxlength="240" placeholder="专辑或艺术家"></label><label>介质类别<select v-model="kind"><option value="">全部</option><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select></label><button :disabled="loading">筛选音乐</button></form>
      <div v-if="catalog?.items.length" class="music-grid"><button v-for="entry in catalog.items" :key="entry.id" class="music-card" @click="open(entry.id)"><div class="cover"><CollectionPhotoView v-if="entry.photo" :photo="entry.photo" :load-photo="api.getPhysicalMusicPhoto" :alt="`${entry.title} 实物代表图`" /><span v-else class="missing-photo">实物照片待添加</span></div><span class="card-kind">{{ labels[entry.kind] }} · {{ entry.quantity }} {{ entry.kind === 'cd' ? '张' : '盘' }}</span><strong>{{ entry.title }}</strong><span class="card-artist">{{ entry.artist }}</span><span v-if="entry.contentStatus !== 'commercial'" class="card-note">{{ entry.contentStatus === 'missing' ? '内容待补录' : '历史录音' }} · {{ entry.id }}</span></button></div>
      <div v-else-if="catalog && !loading && !error" class="empty"><h3>{{ query || kind ? '没有符合筛选的音乐' : '还没有实体音乐记录' }}</h3><p>添加原版 CD 或磁带；已登记的旧录音会自动出现在这里。</p></div>
      <nav v-if="catalog && catalog.total > catalog.limit" aria-label="实体音乐分页" class="pagination"><button :disabled="loading || catalog.offset === 0" @click="load(Math.max(0, catalog.offset - 24))">上一页</button><span>{{ catalog.offset + 1 }}–{{ catalog.offset + catalog.items.length }} / {{ catalog.total }}</span><button :disabled="loading || !catalog.hasMore" @click="load(catalog.offset + 24)">下一页</button></nav>
    </template>
    <PhysicalMusicEditor v-if="editing" :detail="detail" :busy="saving" :error="error" :retryable="!!pending" @close="editing = false" @release="request => mutate(() => api.savePhysicalRelease(request))" @legacy="request => mutate(() => api.saveLegacyRecording(request))" @retry="retry" />
    <dialog ref="viewer" aria-label="发行版照片大图" @close="closePhoto"><button @click="viewer?.close()">关闭大图</button><div v-if="preview" class="preview"><CollectionPhotoView :photo="preview" :load-photo="api.getPhysicalMusicPhoto" alt="发行版实物照片大图" /></div></dialog>
  </section>
</template>
<style scoped>
.music-library{padding:30px 0}header{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:22px;flex-wrap:wrap}h2{margin:0;font-size:clamp(22px,2.4vw,30px);line-height:1.35;overflow-wrap:anywhere}h3{font-size:17px;margin:24px 0 14px}p{font-size:13px;line-height:1.8;color:var(--mb-text-secondary);overflow-wrap:anywhere}.accent{color:var(--mb-accent)}button{min-height:40px;padding:8px 14px;border:1px solid var(--mb-glass-border);border-radius:8px;color:var(--mb-text-primary);background:var(--mb-glass-clear);font-size:13px}button:disabled{opacity:.5;cursor:not-allowed}.filters{display:flex;align-items:end;gap:14px;flex-wrap:wrap;margin:24px 0}.filters label{display:grid;gap:8px;font-size:12px;min-width:140px;flex:1}input,select{min-height:40px;box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--mb-glass-border);border-radius:8px;color:var(--mb-text-primary);background:var(--mb-bg-base)}.music-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(230px,100%),1fr));gap:22px}.music-card{display:flex;flex-direction:column;min-width:0;padding:0;overflow:hidden;text-align:left;border-radius:14px;background:var(--mb-bg-base)}.music-card:hover{border-color:var(--mb-accent)}.cover{width:100%;aspect-ratio:1.35;display:flex;align-items:center;justify-content:center;background:var(--mb-glass-clear);box-sizing:border-box;padding:12px}.missing-photo{font-size:12px;color:var(--mb-text-secondary)}.card-kind{padding:18px 18px 8px;font-size:12px;color:var(--mb-accent)}strong{padding:0 18px;font-size:18px;overflow-wrap:anywhere}.card-artist{padding:10px 18px 18px;color:var(--mb-text-secondary);overflow-wrap:anywhere}.card-note{padding:0 18px 18px;font-size:12px;color:var(--mb-text-secondary)}.identity{display:flex;flex-wrap:wrap;gap:14px;color:var(--mb-text-secondary);font-size:12px;padding:18px 0;overflow-wrap:anywhere}.metadata{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin:24px 0}dt{font-size:12px;color:var(--mb-text-secondary)}dd{margin:6px 0 0;font-size:14px;overflow-wrap:anywhere}.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr));gap:18px}figure{min-width:0;margin:0}.photo{width:100%;aspect-ratio:1.6;padding:8px}.photo:deep(.collection-photo){height:100%}figcaption{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;margin-top:8px}.track-list{list-style:none;padding:0}.track-list li{display:grid;grid-template-columns:90px 1fr auto;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid var(--mb-divider);font-size:13px;overflow-wrap:anywhere}.track-position,small{color:var(--mb-text-secondary);font-size:12px}small{display:block;margin-top:5px}.empty{padding:70px 24px;text-align:center;border:1px solid var(--mb-glass-border);border-radius:16px;background:var(--mb-bg-base)}.pagination{display:flex;gap:18px;justify-content:center;align-items:center;margin-top:28px;font-size:13px}dialog{box-sizing:border-box;width:min(900px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:18px;border:1px solid var(--mb-glass-border);border-radius:14px;color:var(--mb-text-primary);background:var(--mb-bg-base)}dialog::backdrop{background:#000b}dialog>button{display:block;margin:0 0 14px auto}.preview{height:min(65dvh,650px)}@media(max-width:600px){.track-list li{grid-template-columns:65px 1fr}.track-list li>span:last-child{grid-column:2}}
</style>
