<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { MusicDetail, MusicEntry, MusicFilter, MusicMutationResult, Page } from '@music-bridge/contracts'
import PhysicalMusicEditor from './PhysicalMusicEditor.vue'
import PhysicalRelations from './PhysicalRelations.vue'
import CommercialCopiesPanel from './CommercialCopiesPanel.vue'
import CollectionPhotoView from './CollectionPhoto.vue'
import RecordingRecordsPanel from '../recording/RecordingRecordsPanel.vue'
const props = defineProps<{ requestedId?: string; active: boolean }>()
const emit = defineEmits<{ model: [id: string] }>()
const recordsOpen = ref(false), recordsTrigger = ref<HTMLButtonElement>()
type LeaveGuard = { canLeave(): boolean; leaveBlockReason(): string | null }
const recordsPanel = ref<LeaveGuard | null>(null), leaveError = ref('')
const leaveBlockReason = (): string | null => recordsOpen.value && recordsPanel.value?.canLeave() !== true
  ? recordsPanel.value?.leaveBlockReason() ?? '录音档案中的设备运行尚未安全收口。' : null
const canLeave = (): boolean => leaveBlockReason() === null
function guardLeave(): boolean { if (canLeave()) { leaveError.value = ''; return true }; leaveError.value = leaveBlockReason()!; return false }
defineExpose({ canLeave, leaveBlockReason })
function closeRecords(): void { if (!guardLeave()) return; recordsOpen.value = false; void nextTick(() => recordsTrigger.value?.focus({ preventScroll: true })) }
const api = window.musicBridge
const catalog = shallowRef<Page<MusicEntry>>()
const matrixMode = ref(false), relationsBusy = ref(false), copiesBusy = ref(false)
const detail = shallowRef<MusicDetail>()
const loading = ref(false), saving = ref(false), error = ref(''), notice = ref(''), editing = ref(false)
const query = ref(''), kind = ref<MusicFilter['kind'] | ''>('')
const pending = shallowRef<() => Promise<MusicMutationResult>>()
const removing = ref<string>(), preview = shallowRef<MusicDetail['photos'][number]>(), viewer = ref<HTMLDialogElement>()
let active = true, generation = 0
const labels = { cd: '原版 CD', cassette: '原版磁带', 'personal-cassette': '自录磁带', 'personal-dat': '自录 DAT' }
const contentLabels: Record<MusicEntry['contentStatus'], string> = { commercial: '商业发行版', legacy: '历史补录', missing: '内容待补录', formal: '当前录音已确认', 'formal-current-unknown': '当前内容待核实' }
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
  if (!guardLeave()) return
  matrixMode.value = false
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
function back(): void { if (!guardLeave()) return; ++generation; detail.value = undefined; loading.value = false; notice.value = ''; void load(catalog.value?.offset ?? 0) }
function create(): void { if (!guardLeave()) return; detail.value = undefined; editing.value = true }
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
    <p v-if="leaveError" class="message" role="alert">{{ leaveError }}</p>
    <p v-if="error" class="message" role="alert">{{ error }} <button v-if="pending && !editing" :disabled="saving" @click="retry">重试原操作</button><button v-else-if="!pending" :disabled="loading" @click="detail ? open(detail.entry.id) : load()">刷新音乐库</button></p>
    <p v-if="notice" class="message" role="status">{{ notice }}</p><p v-if="loading" role="status">正在读取音乐资料…</p>
    <template v-if="detail">
      <button class="back" :disabled="saving || !!pending || relationsBusy || copiesBusy" @click="back">← 返回音乐库</button>
      <header class="page-head">
        <div><p class="eyebrow">实体音乐 / 藏品资料</p><h2>{{ detail.entry.title }}</h2><p>{{ detail.entry.artist || '艺术家待补充' }} · {{ labels[detail.entry.kind] }}</p></div>
        <div class="head-actions"><button v-if="!detail.formal" :aria-label="detail.release ? '编辑资料' : '补录录音内容'" :disabled="saving || !!pending || relationsBusy || copiesBusy" @click="editing = true">{{ detail.release ? '补充藏品信息' : '补录录音内容' }}</button><button v-if="detail.entry.kind === 'personal-cassette' || detail.entry.kind === 'personal-dat'" ref="recordsTrigger" type="button" @click="recordsOpen = true">档案与当前内容</button></div>
      </header>
      <div class="detail-layout">
        <section class="detail-panel" aria-label="藏品概况">
          <div class="detail-cover"><CollectionPhotoView v-if="detail.photos[0]" :photo="detail.photos[0]" :load-photo="api.getPhysicalMusicPhoto" :alt="`${detail.entry.title} 实物照片`" /><div v-else class="missing-photo"><span class="placeholder-mark" aria-hidden="true">{{ detail.entry.kind === 'cd' ? 'CD' : 'TAPE' }}</span><span>实物照片待添加</span></div><span class="photo-source">{{ detail.photos[0] ? '用户实物照片' : '无实物照片' }}</span></div>
          <div class="identity"><span class="badge">{{ labels[detail.entry.kind] }}{{ detail.release ? ` · ${completeness[detail.release.completeness]}` : '' }}</span><span class="badge">实物数量 {{ detail.entry.quantity }}</span><span v-if="!detail.release" class="badge status-badge">{{ contentLabels[detail.entry.contentStatus] }}</span></div>
          <p class="physical-id">编号：{{ detail.entry.id }}</p>
          <dl v-if="detail.release" class="metadata"><template v-for="field in releaseFields" :key="field.key"><div v-if="detail.release[field.key]"><dt>{{ field.label }}</dt><dd>{{ detail.release[field.key] }}</dd></div></template></dl>
          <p v-else-if="detail.recording?.storage">存放位置：{{ detail.recording.storage }}</p>
          <p v-if="(detail.release ?? detail.recording)?.notes" class="notes">{{ (detail.release ?? detail.recording)?.notes }}</p>
          <p v-if="detail.entry.modelId">本记录沿用原磁带编号，不增加库存。<button @click="emit('model', detail.entry.modelId!)">查看磁带型号与单盘</button></p>
          <p v-if="detail.formal" class="detail-help">正式档案只读；当前内容与处置请在“档案与当前内容”查看，不使用历史补录覆盖。</p><p v-else-if="!detail.release" class="detail-help">曲目源关系待后续补齐。历史补录不代表正式录音完成证据。</p>
        </section>
        <section class="detail-panel track-panel" aria-label="藏品曲目">
          <h3>{{ detail.formal ? '正式录音档案' : '曲目' }}</h3><p v-if="detail.formal">曲目与完成时配置保存在只读录音档案。</p><p v-else-if="!(detail.release ?? detail.recording)?.tracks.length">曲目待补录，不推测录音内容。</p>
          <ol class="track-list"><li v-for="(track, index) in (detail.release ?? detail.recording)?.tracks" :key="index"><span class="track-position">{{ track.side ? `${track.side} 面` : track.disc ? `CD ${track.disc}` : '' }} · {{ track.position }}</span><span>{{ track.title }}<small>{{ track.artist }}</small></span><span class="track-time">{{ track.durationSeconds ? `${Math.floor(track.durationSeconds / 60)}:${String(track.durationSeconds % 60).padStart(2, '0')}` : '时长待补录' }}</span></li></ol>
        </section>
      </div>
      <section v-if="detail.release" class="detail-panel photo-panel" aria-label="发行版实物照片">
        <header><div><h3>实物照片 · {{ detail.photos.length }} / 24</h3><p>用户添加的发行版照片；只保存展示副本，原文件保持不变。</p></div><button :disabled="saving || !!pending || relationsBusy || copiesBusy || detail.photos.length >= 24" @click="addPhoto">添加发行版照片</button></header>
        <p v-if="!detail.photos.length">尚未添加照片。</p>
        <div class="photos"><figure v-for="(photo, index) in detail.photos" :key="photo.id"><button class="photo" :aria-label="`查看发行版照片 ${index + 1}`" @click="showPhoto(photo)"><CollectionPhotoView :photo="photo" :load-photo="api.getPhysicalMusicPhoto" :alt="`${detail.entry.title} 实物照片 ${index + 1}`" /></button><figcaption>实物照片 {{ index + 1 }} <button :disabled="saving || !!pending || relationsBusy || copiesBusy" @click="removing = photo.id">移除</button></figcaption><div v-if="removing === photo.id" class="message"><p>仅移除保存的展示副本；若已归属逐件，也会解除该归属。原始文件不受影响。</p><button :disabled="saving || !!pending || relationsBusy || copiesBusy" @click="removePhoto(photo.id)">确认移除照片</button><button @click="removing = undefined">取消</button></div></figure></div>
      </section>
      <CommercialCopiesPanel v-if="detail.release" :key="detail.entry.id" :release="detail.entry" :photos="detail.photos" @changed="open(detail.entry.id)" @busy="copiesBusy = $event" />
      <PhysicalRelations v-if="detail.release" :key="detail.entry.id" :release="detail.entry" @physical="open" @changed="open(detail.entry.id)" @busy="relationsBusy = $event" />
    </template>
    <template v-else-if="matrixMode">
      <button class="back" :disabled="relationsBusy" @click="matrixMode = false; load()">← 返回音乐库</button>
      <header class="page-head"><div><p class="eyebrow">实体 / 数字收藏</p><h2>实体与数字收藏对照</h2><p>同名不等于同版；未建立关联，不表示没有对应的数字版本。</p></div></header>
      <PhysicalRelations @physical="open" @busy="relationsBusy = $event" />
    </template>
    <template v-else>
      <header class="page-head"><div><p class="eyebrow">实体音乐 / 收藏</p><h2>音乐，也有实体的一面。</h2><p>CD、商业原版与自录作品各自保留身份；自录内容引用同一盘库存，不再入库一次。</p></div><div class="music-header-tools">
      <form class="filters" aria-label="筛选实体音乐" @submit.prevent="load(0)"><label class="search-filter"><span class="sr-only">搜索音乐</span><input v-model.trim="query" maxlength="240" placeholder="搜索专辑或艺术家…"></label><label class="kind-filter"><span class="sr-only">介质类别</span><select v-model="kind"><option value="">全部实体音乐</option><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select></label><button :disabled="loading">筛选音乐</button></form>
        <button class="primary" aria-label="添加实体音乐" :disabled="saving || !!pending || relationsBusy || !catalog" @click="create"><span aria-hidden="true">＋</span> 添加实体音乐</button></div></header>

      <div class="library-tools"><button aria-label="收藏矩阵" :disabled="saving || !!pending" @click="matrixMode = true">实体 / 数字对照</button><span v-if="catalog" class="result-count">{{ catalog.total }} 条音乐记录</span></div>
      <div v-if="catalog?.items.length" class="music-grid"><article v-for="entry in catalog.items" :key="entry.id" class="music-card"><button class="card-open" :aria-label="`${labels[entry.kind]} · ${entry.quantity} ${entry.kind === 'cd' ? '张' : '盘'} ${entry.title} ${entry.artist || '艺术家待补充'}`" @click="open(entry.id)"><div class="cover"><CollectionPhotoView v-if="entry.photo" :photo="entry.photo" :load-photo="api.getPhysicalMusicPhoto" :alt="`${entry.title} 实物代表图`" /><div v-else class="missing-photo"><span class="placeholder-mark" aria-hidden="true">{{ entry.kind === 'cd' ? 'CD' : 'TAPE' }}</span><span>实物照片待添加</span></div><span class="photo-source">{{ entry.photo ? '用户实物照片' : '无实物照片' }}</span></div><div class="card-body"><div class="card-badges"><span class="badge card-kind">{{ labels[entry.kind] }}</span><span class="badge status-badge">{{ contentLabels[entry.contentStatus] }}</span></div><h3>{{ entry.title }}</h3><p class="card-artist">{{ entry.artist || '艺术家待补充' }}</p><div class="card-meta"><span class="badge">{{ entry.quantity }} {{ entry.kind === 'cd' ? '张' : '盘' }}</span><span class="physical-id">{{ entry.id }}</span></div></div></button><footer class="card-actions"><button :aria-label="`查看藏品详情：${entry.title}`" @click="open(entry.id)">查看藏品 →</button></footer></article></div>
      <div v-else-if="catalog && !loading && !error" class="empty"><h3>{{ query || kind ? '没有符合筛选的音乐' : '还没有实体音乐记录' }}</h3><p>添加原版 CD 或磁带；已登记的旧录音会自动出现在这里。</p></div>
      <p class="help-strip">商业发行版与自录内容分别记录；数字关联及逐件资料可在藏品详情中核对。</p>
      <nav v-if="catalog && catalog.total > catalog.limit" aria-label="实体音乐分页" class="pagination"><button :disabled="loading || catalog.offset === 0" @click="load(Math.max(0, catalog.offset - 24))">上一页</button><span>{{ catalog.offset + 1 }}–{{ catalog.offset + catalog.items.length }} / {{ catalog.total }}</span><button :disabled="loading || !catalog.hasMore" @click="load(catalog.offset + 24)">下一页</button></nav>
    </template>
    <RecordingRecordsPanel v-if="recordsOpen && detail" ref="recordsPanel" :physical-id="detail.entry.id" @close="closeRecords" @changed="open(detail.entry.id)" />
    <PhysicalMusicEditor v-if="editing && !detail?.formal" :detail="detail" :busy="saving" :error="error" :retryable="!!pending" @close="editing = false" @release="request => mutate(() => api.savePhysicalRelease(request))" @legacy="request => mutate(() => api.saveLegacyRecording(request))" @retry="retry" />
    <dialog ref="viewer" aria-label="发行版照片大图" @close="closePhoto"><button @click="viewer?.close()">关闭大图</button><div v-if="preview" class="preview"><CollectionPhotoView :photo="preview" :load-photo="api.getPhysicalMusicPhoto" alt="发行版实物照片大图" interactive /></div></dialog>
  </section>
</template>
<style scoped>
.music-library{padding:24px 0;color:var(--collection-text,var(--mb-text-primary));container-type:inline-size}
header,.head-actions{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}header{margin-bottom:18px}.page-head{align-items:flex-start;margin-bottom:24px}.page-head>div:first-child{flex:1;min-width:200px}.page-head h2{margin:5px 0 10px;font-size:28px;letter-spacing:-.5px;line-height:1.4;overflow-wrap:anywhere}.page-head p{max-width:750px;margin:0}h3{font-size:15px;margin:0 0 10px;overflow-wrap:anywhere}p{font-size:13px;line-height:1.8;color:var(--collection-muted,var(--mb-text-secondary));overflow-wrap:anywhere}.music-library .eyebrow{color:var(--collection-accent,var(--mb-accent));font-size:11px;font-weight:700;letter-spacing:1.8px}
button{min-height:36px;padding:8px 12px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:8px;color:var(--collection-text,var(--mb-text-primary));background:var(--collection-surface,var(--mb-glass-clear));font-size:12px;font-weight:600;line-height:1.4;cursor:pointer}button:hover{border-color:var(--collection-accent,var(--mb-accent));background:var(--collection-subtle,var(--mb-glass-clear))}button:disabled{opacity:.5;cursor:not-allowed}button.primary{background:var(--collection-accent,var(--mb-accent));border-color:var(--collection-accent,var(--mb-accent));color:var(--mb-on-accent,#fff);min-height:40px}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--collection-accent,var(--mb-accent));outline-offset:3px}.back{margin-bottom:18px;background:transparent;border-color:transparent;padding-left:0}
.music-header-tools{display:flex;flex-direction:column;align-items:flex-end;gap:12px;flex:0 1 600px;min-width:0;max-width:100%}.filters{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;width:100%;gap:10px;margin:0}.filters label{min-width:0}.search-filter{grid-column:1/-1}.filters button{min-height:40px}input,select{min-height:40px;box-sizing:border-box;width:100%;padding:9px 11px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:7px;color:var(--collection-text,var(--mb-text-primary));background:var(--collection-surface,var(--mb-bg-base));font:inherit;font-size:13px}.library-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 18px}.result-count{font-size:12px;color:var(--collection-muted,var(--mb-text-secondary))}
.music-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:28px}.music-library .music-card{display:flex;flex-direction:column;min-width:0;padding:0;overflow:hidden;text-align:left;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:13px;background:var(--collection-surface,var(--mb-bg-base))}.music-library .music-card:hover{border-color:var(--collection-accent,var(--mb-accent))}.card-open{display:block;width:100%;border:0;border-radius:0;padding:0;background:transparent!important;text-align:left;font-weight:400}.card-open:focus-visible{outline-offset:-4px}.music-library .cover,.detail-cover{height:170px;position:relative;display:flex;align-items:center;justify-content:center;background:var(--collection-media,var(--mb-glass-clear));box-sizing:border-box;padding:12px}.cover:deep(.collection-photo),.detail-cover:deep(.collection-photo){width:100%;height:100%}.missing-photo{display:grid;justify-items:center;gap:10px;font-size:12px;color:var(--collection-muted,var(--mb-text-secondary))}.placeholder-mark{display:grid;place-items:center;width:82px;height:58px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:9px;font-size:20px;font-weight:500;letter-spacing:2px;opacity:.6}.photo-source{position:absolute;right:9px;bottom:7px;padding:2px 6px;border-radius:4px;background:var(--collection-surface,var(--mb-bg-base));font-size:10px;color:var(--collection-muted,var(--mb-text-secondary))}.card-body{padding:17px 18px 12px}.card-badges,.card-meta,.identity{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.card-badges{justify-content:space-between}.badge{display:inline-flex;padding:3px 8px;border-radius:5px;background:var(--collection-subtle,var(--mb-glass-clear));color:var(--collection-muted,var(--mb-text-secondary));font-size:11px;font-weight:600;line-height:1.55;overflow-wrap:anywhere}.music-library .music-card .card-kind{padding:3px 8px;color:var(--collection-accent,var(--mb-accent))}.status-badge{color:var(--collection-accent,var(--mb-accent))}.music-card h3{margin:9px 0 6px;font-size:19px;letter-spacing:-.2px;line-height:1.4}.music-library .music-card .card-artist{padding:0;margin:0 0 10px;font-size:12px;color:var(--collection-muted,var(--mb-text-secondary))}.card-meta{align-items:flex-start}.physical-id{font:11px/1.6 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere;min-width:0;color:var(--collection-muted,var(--mb-text-secondary))}.card-meta .physical-id{flex:1;padding:3px 0}.card-actions{padding:0 18px 16px;margin-top:auto}.card-actions button{padding:6px 9px;min-height:32px}.help-strip,.message,.detail-help{padding:12px 14px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:9px;background:var(--collection-subtle,var(--mb-glass-clear));font-size:12px}.help-strip{margin:16px 0 0}
.detail-layout{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:22px;margin-bottom:22px}.detail-panel{min-width:0;padding:21px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:12px;background:var(--collection-surface,var(--mb-bg-base))}.detail-cover{height:220px;border-radius:9px;overflow:hidden}.identity{padding:18px 0 8px}.metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}dt{font-size:12px;color:var(--collection-muted,var(--mb-text-secondary))}dd{margin:5px 0 0;font-size:14px;overflow-wrap:anywhere}.notes{white-space:pre-wrap}.photo-panel{margin-bottom:22px}.photo-panel header p{margin:4px 0 0}.photo-panel header h3{margin:0}.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:18px}figure{min-width:0;margin:0}.photo{width:100%;aspect-ratio:1.6;padding:8px;background:var(--collection-media,var(--mb-glass-clear))}.photo:deep(.collection-photo){height:100%}figcaption{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;margin-top:8px}.track-list{list-style:none;padding:0;margin:0}.track-list li{display:grid;grid-template-columns:60px minmax(0,1fr) auto;gap:12px;align-items:start;padding:14px 0;border-bottom:1px solid var(--collection-line,var(--mb-divider));font-size:13px;overflow-wrap:anywhere}.track-position,small,.track-time{color:var(--collection-muted,var(--mb-text-secondary));font-size:11px}small{display:block;margin-top:5px}.track-time{font-variant-numeric:tabular-nums}.empty{padding:50px 20px;text-align:center;border:1px dashed var(--collection-line,var(--mb-glass-border));border-radius:12px;background:var(--collection-surface,var(--mb-bg-base))}.pagination{display:flex;gap:18px;justify-content:center;align-items:center;flex-wrap:wrap;margin-top:24px;font-size:13px}dialog{box-sizing:border-box;width:min(900px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:18px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:14px;color:var(--collection-text,var(--mb-text-primary));background:var(--collection-surface,var(--mb-bg-base))}dialog::backdrop{background:#000b}dialog>button{display:block;margin:0 0 14px auto}.preview{height:min(65dvh,650px)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@container(max-width:900px){.music-header-tools{flex-basis:100%}.music-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.detail-layout{grid-template-columns:1fr}.page-head h2{font-size:25px}}
@container(max-width:520px){.music-grid{grid-template-columns:1fr}.page-head h2{font-size:23px}.page-head>div:first-child{min-width:0;flex-basis:100%}.card-body{padding:14px}.card-actions{padding:0 14px 14px}.detail-panel{padding:16px}.track-list li{grid-template-columns:50px minmax(0,1fr)}.track-time{grid-column:2}.metadata{gap:12px}}
</style>
