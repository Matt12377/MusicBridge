<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { CollectionMatrixRow, DigitalAlbumDetail, DigitalRuntime, MusicEntry, Page, PhysicalDigitalLink, PhysicalLinkHistoryEvent, PhysicalLinkResult, PhysicalLinksSnapshot, PhysicalRelation, RoonLibraryPage } from '@music-bridge/contracts'
import { nextRoonPageOffset, readRoonDatasetPage, RoonPageCursorHistory } from '../../composables/roonLibraryPagination.js'
import RoonAlbumPicker from './RoonAlbumPicker.vue'
import { createPhysicalLinkHistoryFence } from './physical-link-history-fence'
import { createPhysicalRelationRequestFence } from './physical-relation-request-fence'
const props = defineProps<{ release?: MusicEntry }>()
const emit = defineEmits<{ physical: [id: string]; changed: []; busy: [busy: boolean] }>()
const api = window.musicBridge
const snapshot = shallowRef<PhysicalLinksSnapshot>(), history = shallowRef<Page<PhysicalLinkHistoryEvent>>(), digital = shallowRef<DigitalAlbumDetail>(), runtime = shallowRef<DigitalRuntime>(), matrix = shallowRef<Page<CollectionMatrixRow>>()
const loading = ref(false), saving = ref(false), error = ref(''), notice = ref(''), query = ref('')
const picker = ref<'link' | 'register' | 'relocate'>(), removing = shallowRef<PhysicalDigitalLink>(), removalReason = ref(''), absenceConfirm = ref(false)
const pending = shallowRef<() => Promise<PhysicalLinkResult>>(), tracks = shallowRef<RoonLibraryPage>(), playbackError = ref('')
const blocked = computed(() => saving.value || !!pending.value)
const relations: Record<PhysicalRelation, string> = { exact: 'Exact · 用户确认同版', probable: 'Probable · 可能同版', related: 'Related · 相关版本' }
const runtimeLabels = { available: '当前 Roon 链接可用', 'needs-resolution': '链接待重新定位，收藏关系已保留', unavailable: '当前 Roon 不可用，收藏关系已保留' }
let alive = true, lastReleaseId = props.release?.id
const historyFence = createPhysicalLinkHistoryFence()
const viewFence = createPhysicalRelationRequestFence(), tracksFence = createPhysicalRelationRequestFence()
const trackCursors = new RoonPageCursorHistory()
let trackRebases = 0
let unsubscribe: (() => void) | undefined
function clearTracks(): void { tracksFence.invalidate(); trackCursors.reset(); trackRebases = 0; tracks.value = undefined; playbackError.value = '' }
async function readView<T>(operation: () => Promise<T>, publish: (value: T) => void): Promise<boolean> {
  loading.value = true
  return viewFence.read(operation, {
    valid: () => alive,
    success: publish,
    failure: () => { error.value = '关联资料暂时无法读取，请刷新。已有关系不会被清空。' },
    settled: () => { loading.value = false },
  })
}
async function load(offset = 0): Promise<void> {
  historyFence.invalidate()
  if (digital.value) {
    const id = digital.value.album.id
    await readView(async () => ({ result: await api.getDigitalAlbum(id), state: await api.getDigitalRuntime(id) }), value => {
      const currentReference = runtime.value?.status === 'available' ? runtime.value.reference : undefined
      const nextReference = value.state.status === 'available' ? value.state.reference : undefined
      if (digital.value?.album.id !== value.result.album.id || !nextReference || currentReference !== nextReference) clearTracks()
      digital.value = value.result; runtime.value = value.state
    })
  } else if (props.release) {
    const releaseId = props.release.id
    const current = await readView(() => api.getPhysicalLinks(releaseId), result => { snapshot.value = result })
    if (current && props.release?.id === releaseId) await loadHistory(history.value?.offset ?? 0)
  } else {
    await readView(() => api.getCollectionMatrix({ offset, limit: 24 }, query.value), result => { matrix.value = result })
  }
}
async function loadHistory(offset: number): Promise<void> {
  if (!props.release) return
  try {
    await historyFence.read(() => api.getPhysicalLinkHistory(props.release!.id, { offset, limit: 20 }), events => { if (alive) history.value = events })
  } catch { if (alive) error.value = '关系历史暂时无法读取；当前关系仍保留。' }
}
async function openDigital(id: string): Promise<void> {
  historyFence.invalidate(); clearTracks(); error.value = ''
  await readView(async () => ({ result: await api.getDigitalAlbum(id), state: await api.getDigitalRuntime(id) }), value => {
    digital.value = value.result; runtime.value = value.state
  })
}
function showPhysical(id: string): void {
  viewFence.invalidate(); historyFence.invalidate(); clearTracks(); loading.value = false
  digital.value = undefined; runtime.value = undefined; history.value = undefined; error.value = ''; absenceConfirm.value = false
  emit('physical', id)
  // 父页面在同一发行版内切回实物时不会 remount，必须主动读取当前关系。
  if (props.release?.id === id) void load()
}
function back(): void {
  viewFence.invalidate(); historyFence.invalidate(); clearTracks(); loading.value = false
  digital.value = undefined; runtime.value = undefined; error.value = ''; absenceConfirm.value = false; void load()
}
async function retry(): Promise<void> {
  if (!pending.value || saving.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const result = await pending.value()
    if (!alive) return
    const mode = picker.value
    historyFence.invalidate(); pending.value = undefined; picker.value = undefined; removing.value = undefined; removalReason.value = ''; absenceConfirm.value = false; history.value = undefined
    notice.value = '关联资料已保存'
    if (mode === 'register' && result.digitalId) await openDigital(result.digitalId)
    else await load(matrix.value?.offset ?? 0)
    emit('changed')
  } catch (cause) {
    if (alive) {
      const message = cause instanceof Error ? cause.message : ''
      if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(message)) {
        // 明确拒绝发生在提交之前；刷新 revision 后允许重新核对，未知回执仍保留原命令。
        pending.value = undefined
        await load(matrix.value?.offset ?? 0)
        error.value = '本次操作未保存：候选或资料已变化，请重新核对后确认；不同版本需另建数字对象。'
      } else error.value = '操作结果尚未确认。请重试原操作；不会重复创建关系。'
    }
  }
  finally { if (alive) saving.value = false }
}
function mutate(operation: () => Promise<PhysicalLinkResult>): void { if (blocked.value) return; pending.value = operation; void retry() }
function confirm(selection: { reference?: string; digitalId?: string; relation: PhysicalRelation; ripFromCdConfirmed: boolean; physicalAbsenceConfirmed: boolean; reason: string }): void {
  const commandId = crypto.randomUUID()
  if (picker.value === 'link' && snapshot.value) {
    const request = { commandId, releaseId: snapshot.value.releaseId, expectedRevision: snapshot.value.revision, relation: selection.relation, ripFromCdConfirmed: selection.ripFromCdConfirmed, reason: selection.reason, userConfirmed: true as const, ...(selection.reference ? { reference: selection.reference } : { digitalId: selection.digitalId! }) }
    mutate(() => api.confirmPhysicalLink(request))
  } else if (picker.value === 'relocate' && digital.value && selection.reference) {
    const request = { commandId, digitalId: digital.value.album.id, expectedRevision: digital.value.album.revision, reference: selection.reference, userConfirmed: true as const }
    mutate(() => api.relocateDigitalAlbum(request))
  } else if (picker.value === 'register' && selection.reference) {
    const request = { commandId, reference: selection.reference, physicalAbsenceConfirmed: selection.physicalAbsenceConfirmed, userConfirmed: true as const }
    mutate(() => api.registerDigitalAlbum(request))
  }
}
function remove(): void { if (!removing.value || !removalReason.value.trim()) return; const request = { commandId: crypto.randomUUID(), linkId: removing.value.id, expectedRevision: removing.value.revision, reason: removalReason.value.trim(), userConfirmed: true as const }; mutate(() => api.removePhysicalLink(request)) }
function absence(): void {
  const current = digital.value?.album ?? snapshot.value
  if (!current || !absenceConfirm.value) return
  const absent = digital.value ? digital.value.album.physicalAbsenceConfirmed : snapshot.value!.digitalAbsenceConfirmed
  const request = { commandId: crypto.randomUUID(), id: digital.value?.album.id ?? snapshot.value!.releaseId, target: digital.value ? 'physical' as const : 'digital' as const, expectedRevision: current.revision, confirmedAbsent: !absent, userConfirmed: true as const }
  mutate(() => api.confirmPhysicalAbsence(request))
}
async function preview(offset = 0): Promise<void> {
  const reference = runtime.value?.status === 'available' ? runtime.value.reference : undefined, id = digital.value?.album.id
  if (!reference || !id) return
  const previous = tracks.value
  if (offset === 0) trackRebases = 0
  playbackError.value = ''
  const valid = () => alive && digital.value?.album.id === id && runtime.value?.status === 'available' && runtime.value.reference === reference
  let version = 0
  await tracksFence.read(async () => {
    version = tracksFence.version()
    const result = await readRoonDatasetPage(previous, { offset, limit: 20 }, page => api.getRoonAlbumTracks(reference, page),
      () => tracksFence.isCurrent(version, valid), trackRebases === 0 ? () => { trackRebases++ } : undefined)
    if (!result) throw new Error('关联曲目读取已取消')
    return result.page
  }, {
    valid: () => alive && digital.value?.album.id === id && runtime.value?.status === 'available' && runtime.value.reference === reference,
    success: result => { tracks.value = result; trackCursors.record(reference, result) },
    failure: () => { playbackError.value = '曲目暂时无法读取或上下文已变化，请重新读取；旧页不代表完整专辑。' },
  })
}
async function play(reference: string): Promise<void> {
  const id = digital.value?.album.id, runtimeReference = runtime.value?.status === 'available' ? runtime.value.reference : undefined
  const current = () => alive && !!id && digital.value?.album.id === id && runtime.value?.status === 'available'
    && runtime.value.reference === runtimeReference && !!tracks.value?.items.some(track => track.reference === reference)
  if (!runtimeReference || !current()) { playbackError.value = '当前 Roon 链接不可用，请重新定位后试听。'; return }
  const token = tracksFence.version()
  playbackError.value = ''
  try {
    const zone = (await api.listZones()).zones.find(z => z.selected)
    if (!tracksFence.isCurrent(token, current)) return
    if (!zone) { playbackError.value = '请先在现有播放设备菜单选择一个 Roon Zone。'; return }
    await api.playRoonTrack(reference, zone.zoneId)
  } catch { if (tracksFence.isCurrent(token, current)) playbackError.value = '试听未能启动，请检查 Roon 与播放设备；这不会开始正式录音。' }
}
watch(blocked, value => emit('busy', value))
watch(() => [props.release?.id, props.release?.revision] as const, ([id]) => {
  if (id !== lastReleaseId) { lastReleaseId = id; clearTracks(); snapshot.value = undefined; history.value = undefined }
  if (!blocked.value) void load()
})
onMounted(() => {
  void load()
  unsubscribe = api.onCoreEvent(event => {
    if (!alive || !digital.value || (event.event !== 'core.ready' && event.event !== 'roon.changed')) return
    if (event.payload.state.runtime !== 'ready' || !['paired', 'ready'].includes(event.payload.state.roon)) {
      viewFence.invalidate(); clearTracks(); loading.value = false; runtime.value = { status: 'unavailable' }
    } else if (!blocked.value) void load()
  })
})
onUnmounted(() => { alive = false; viewFence.invalidate(); clearTracks(); historyFence.invalidate(); unsubscribe?.(); emit('busy', false) })
</script>
<template>
  <section class="physical-relations" :aria-label="digital ? '数字关联详情' : release ? 'Roon 数字关联' : '收藏矩阵内容'">
    <p v-if="error && !picker" role="alert">{{ error }} <button v-if="pending" :disabled="saving" @click="retry">重试原操作</button><button v-else :disabled="loading" @click="error = ''; load()">刷新关联资料</button></p>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="loading" role="status">正在读取关联资料…</p>
    <template v-if="digital">
      <header><h3>数字关联详情</h3><button :disabled="blocked" @click="back">返回{{ release ? '实体关联' : '收藏矩阵' }}</button></header>
      <h4>{{ digital.album.metadata.title }}</h4><p>{{ [digital.album.metadata.artist, digital.album.metadata.year, digital.album.metadata.version].filter(Boolean).join(' · ') }}</p>
      <p class="identity">本地数字编号 {{ digital.album.id }}</p><p v-if="runtime" role="status">{{ runtimeLabels[runtime.status] }}</p>
      <div class="actions"><button :disabled="blocked" @click="picker = 'relocate'">重新定位 Roon 专辑</button><button :disabled="blocked || runtime?.status !== 'available'" @click="preview()">查看 Roon 曲目 / 试听</button></div>
      <p>元数据关联不代表音频已校验，也不代表取得了正式录音源。</p>
      <article v-for="item in digital.links" :key="item.link.id" class="link-card"><strong>{{ item.release.title }}</strong><p>{{ relations[item.link.relation] }} · {{ item.release.kind === 'cd' ? '原版 CD' : '原版磁带' }} × {{ item.release.quantity }}</p><p v-if="item.link.ripFromCdConfirmed">CD Rip · 用户单独确认</p><div class="actions"><button :disabled="blocked" @click="showPhysical(item.release.id)">查看关联实物</button><button :disabled="blocked" @click="removing = item.link">解除关联</button></div></article>
      <div v-if="!digital.links.length" class="absence"><p>{{ digital.album.physicalAbsenceConfirmed ? 'Digital Only · 已确认未收藏原版实物' : '原版实物尚未核实，不视为缺少' }}</p><label><input v-model="absenceConfirm" type="checkbox">{{ digital.album.physicalAbsenceConfirmed ? '确认撤销未收藏声明' : '我已核实尚未收藏原版实物' }}</label><button :disabled="blocked || !absenceConfirm" @click="absence">{{ digital.album.physicalAbsenceConfirmed ? '撤销未收藏声明' : '确认未收藏原版实物' }}</button></div>
      <p v-if="playbackError" role="alert">{{ playbackError }}</p>
      <section v-if="tracks" aria-label="关联专辑曲目"><ul><li v-for="track in tracks.items" :key="track.reference"><span>{{ track.title }} · {{ track.artist }}</span><button :disabled="blocked || runtime?.status !== 'available'" @click="play(track.reference)">试听 {{ track.title }}</button></li></ul><nav aria-label="关联曲目分页"><button :disabled="!tracks.offset" @click="preview(trackCursors.previous(tracks))">上一页</button><button :disabled="!tracks.hasMore" @click="preview(nextRoonPageOffset(tracks))">下一页</button></nav></section>
    </template>
    <template v-else-if="release">
      <header><h3>Roon 数字关联</h3><button :disabled="blocked || !snapshot" @click="picker = 'link'">关联 Roon 专辑</button></header>
      <p>同名不自动合并。选择专辑后，由你确认发行版关系。</p>
      <article v-for="item in snapshot?.links" :key="item.link.id" class="link-card"><strong>{{ item.album.metadata.title }}</strong><p>{{ [item.album.metadata.artist, item.album.metadata.year, item.album.metadata.version].filter(Boolean).join(' · ') }}</p><p>{{ relations[item.link.relation] }}</p><p v-if="item.link.ripFromCdConfirmed">CD Rip · 用户单独确认</p><div class="actions"><button :disabled="blocked" @click="openDigital(item.album.id)">查看数字关联详情</button><button :disabled="blocked" @click="removing = item.link">解除关联</button></div></article>
      <div v-if="snapshot && !snapshot.links.length" class="absence"><p>{{ snapshot.digitalAbsenceConfirmed ? 'Physical Only · 已确认没有数字版本' : '尚未关联，数字版本是否存在仍待核实' }}</p><label><input v-model="absenceConfirm" type="checkbox">{{ snapshot.digitalAbsenceConfirmed ? '确认撤销没有数字版声明' : '我已核实没有数字版本' }}</label><button :disabled="blocked || !absenceConfirm" @click="absence">{{ snapshot.digitalAbsenceConfirmed ? '撤销没有数字版声明' : '确认没有数字版本' }}</button></div>
      <section aria-label="数字关系历史" class="history"><h4>关系证据历史</h4><p v-if="!history?.items.length">尚无关系事件。旧账本不包含请求原文时，仅标记历史未知。</p><article v-for="event in history?.items" :key="event.id" class="link-card"><strong>{{ event.kind === 'historical-unknown' ? '旧历史：原始确认内容未知' : event.kind === 'confirmed' ? '确认关联' : event.kind === 'corrected' ? '更正关联' : '撤销关联' }}</strong><p v-if="event.occurredAt">{{ new Date(event.occurredAt).toLocaleString() }} · 关系 {{ event.linkId }}</p><p v-if="event.before">之前：{{ relations[event.before.relation] }}{{ event.before.ripFromCdConfirmed ? ' · CD Rip 已确认' : '' }}</p><p v-if="event.after">之后：{{ relations[event.after.relation] }}{{ event.after.ripFromCdConfirmed ? ' · CD Rip 已确认' : '' }}</p><p v-if="event.evidence">来源：{{ event.evidence.source === 'roon-candidate' ? '本次 Roon 候选' : event.evidence.source === 'existing-digital' ? '已保存数字对象' : '明确解除操作' }} · {{ event.evidence.metadata.title }}；理由：{{ event.evidence.reason }}</p><p v-else>旧账本缺少原始请求、理由和确认时间；不推测历史内容。</p></article><nav v-if="history && history.total > history.limit" aria-label="数字关系历史分页"><button :disabled="loading || !history.offset" @click="loadHistory(Math.max(0, history.offset - 20))">上一页</button><span>{{ history.offset + 1 }}–{{ history.offset + history.items.length }} / {{ history.total }}</span><button :disabled="loading || !history.hasMore" @click="loadHistory(history.offset + 20)">下一页</button></nav></section>
    </template>
    <template v-else>
      <header><div><h3>收藏矩阵</h3><p>按已确认关系查看收藏。未核实的缺少，不计为缺少。</p></div><button :disabled="blocked" @click="picker = 'register'">从 Roon 登记数字对象</button></header>
      <form @submit.prevent="load()"><label>搜索收藏矩阵<input v-model.trim="query" maxlength="240" placeholder="专辑或艺术家"></label><button :disabled="loading || blocked">筛选矩阵</button></form>
      <div class="matrix-grid"><article v-for="row in matrix?.items" :key="row.id" class="link-card"><h4>{{ row.title }}</h4><p>{{ row.artist }}</p><div class="counts"><span>CD {{ row.cd }}</span><span>磁带 {{ row.cassette }}</span><span v-if="row.uncertainRelations">待核实关系 {{ row.uncertainRelations }}</span></div><p>{{ row.digitalState === 'confirmed-missing' ? 'Physical Only · 已确认没有数字版本' : row.physicalState === 'confirmed-missing' ? 'Digital Only · 已确认未收藏原版实物' : row.digitalId ? '已登记数字对象' : '数字版本待核实' }}</p><button :disabled="blocked" @click="row.digitalId ? openDigital(row.digitalId) : showPhysical(row.releaseId!)">{{ row.digitalId ? '查看数字关联详情' : '查看关联实物' }}</button></article></div>
      <p v-if="matrix && !matrix.total && !loading">还没有符合条件的收藏记录。矩阵不会凭标题推测对应版本。</p>
      <p>数字对象下的 CD / 磁带数量只统计 Exact 关系；可能同版与相关版本单列。自录作品在实体音乐库查看，不计入原版数量。</p>
      <nav v-if="matrix && matrix.total > matrix.limit" aria-label="收藏矩阵分页"><button :disabled="blocked || loading || !matrix.offset" @click="load(Math.max(0, matrix.offset - 24))">上一页</button><span>{{ matrix.offset + 1 }}–{{ matrix.offset + matrix.items.length }} / {{ matrix.total }}</span><button :disabled="blocked || loading || !matrix.hasMore" @click="load(matrix.offset + 24)">下一页</button></nav>
    </template>
    <div v-if="removing" role="group" aria-label="确认解除关联" class="link-card"><p>仅解除双方关系，保留数字对象与实物记录，不自动声明缺少。撤销前的关系和这次理由会保存为不可变事件。</p><label class="reason">解除理由<textarea v-model.trim="removalReason" maxlength="240" rows="2" placeholder="写下核对依据"></textarea></label><button :disabled="blocked || !removalReason.trim()" @click="remove">确认解除关联</button><button :disabled="blocked" @click="removing = undefined; removalReason = ''">取消解除</button></div>
    <RoonAlbumPicker v-if="picker" :mode="picker" :cd="release?.kind === 'cd'" :busy="saving" :pending="!!pending" :error="error" @close="picker = undefined; error = ''" @confirm="confirm" @retry="retry" />
  </section>
</template>
<style scoped>
.reason{display:grid;gap:8px}.reason textarea{box-sizing:border-box;width:100%;min-height:70px;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;resize:vertical}.history{margin-top:22px;padding-top:12px;border-top:1px solid var(--mb-divider)}
.physical-relations{margin:28px 0;padding:24px;border:1px solid var(--mb-glass-border);border-radius:14px;background:var(--mb-bg-base);min-width:0}header,.actions,.counts,nav,form{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between}h3{font-size:19px;margin:0 0 8px}h4{font-size:17px;margin:0;overflow-wrap:anywhere}p{font-size:12px;line-height:1.8;color:var(--mb-text-secondary);overflow-wrap:anywhere}button,input{font:inherit;color:var(--mb-text-primary)}button,input:not([type]){min-height:40px;padding:8px 12px;box-sizing:border-box;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);font-size:13px;max-width:100%}button:disabled{opacity:.5;cursor:not-allowed}label{display:flex;align-items:center;gap:8px;font-size:13px;margin:14px 0}input[type=checkbox]{accent-color:var(--mb-accent);width:18px;height:18px}.link-card{padding:18px;border:1px solid var(--mb-glass-border);border-radius:12px;margin:16px 0;overflow-wrap:anywhere}.matrix-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}.counts{font-size:13px;color:var(--mb-accent)}.identity{font-size:11px}.absence{margin-top:16px}form label{display:grid;flex:1;min-width:150px}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;flex-wrap:wrap;font-size:13px}nav{justify-content:center;font-size:12px;margin-top:16px}@media(max-width:600px){.physical-relations{padding:16px}}
</style>
