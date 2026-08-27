<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { CollectionMatrixRow, DigitalAlbumDetail, DigitalRuntime, MusicEntry, Page, PhysicalDigitalLink, PhysicalLinkResult, PhysicalLinksSnapshot, PhysicalRelation, RoonLibraryPage } from '@music-bridge/contracts'
import RoonAlbumPicker from './RoonAlbumPicker.vue'
const props = defineProps<{ release?: MusicEntry }>()
const emit = defineEmits<{ physical: [id: string]; changed: []; busy: [busy: boolean] }>()
const api = window.musicBridge
const snapshot = shallowRef<PhysicalLinksSnapshot>(), digital = shallowRef<DigitalAlbumDetail>(), runtime = shallowRef<DigitalRuntime>(), matrix = shallowRef<Page<CollectionMatrixRow>>()
const loading = ref(false), saving = ref(false), error = ref(''), notice = ref(''), query = ref('')
const picker = ref<'link' | 'register' | 'relocate'>(), removing = shallowRef<PhysicalDigitalLink>(), absenceConfirm = ref(false)
const pending = shallowRef<() => Promise<PhysicalLinkResult>>(), tracks = shallowRef<RoonLibraryPage>(), playbackError = ref('')
const blocked = computed(() => saving.value || !!pending.value)
const relations: Record<PhysicalRelation, string> = { exact: 'Exact · 用户确认同版', probable: 'Probable · 可能同版', related: 'Related · 相关版本' }
const runtimeLabels = { available: '当前 Roon 链接可用', 'needs-resolution': '链接待重新定位，收藏关系已保留', unavailable: '当前 Roon 不可用，收藏关系已保留' }
let alive = true, generation = 0
let unsubscribe: (() => void) | undefined
async function read(operation: () => Promise<void>): Promise<void> {
  loading.value = true
  try { await operation() } catch { if (alive) error.value = '关联资料暂时无法读取，请刷新。已有关系不会被清空。' }
  finally { if (alive) loading.value = false }
}
async function load(offset = 0): Promise<void> {
  const token = ++generation
  await read(async () => {
    if (digital.value) {
      const id = digital.value.album.id
      const result = await api.getDigitalAlbum(id), state = await api.getDigitalRuntime(id)
      if (alive && token === generation) { digital.value = result; runtime.value = state }
    } else if (props.release) {
      const result = await api.getPhysicalLinks(props.release.id)
      if (alive && token === generation) snapshot.value = result
    } else {
      const result = await api.getCollectionMatrix({ offset, limit: 24 }, query.value)
      if (alive && token === generation) matrix.value = result
    }
  })
}
async function openDigital(id: string): Promise<void> {
  const token = ++generation; error.value = ''; tracks.value = undefined
  await read(async () => {
    const result = await api.getDigitalAlbum(id), state = await api.getDigitalRuntime(id)
    if (alive && token === generation) { digital.value = result; runtime.value = state }
  })
}
function showPhysical(id: string): void { digital.value = undefined; runtime.value = undefined; tracks.value = undefined; absenceConfirm.value = false; emit('physical', id) }
function back(): void { digital.value = undefined; runtime.value = undefined; tracks.value = undefined; error.value = ''; absenceConfirm.value = false; void load() }
async function retry(): Promise<void> {
  if (!pending.value || saving.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const result = await pending.value()
    if (!alive) return
    const mode = picker.value
    pending.value = undefined; picker.value = undefined; removing.value = undefined; absenceConfirm.value = false
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
function confirm(selection: { reference?: string; digitalId?: string; relation: PhysicalRelation; ripFromCdConfirmed: boolean; physicalAbsenceConfirmed: boolean }): void {
  const commandId = crypto.randomUUID()
  if (picker.value === 'link' && snapshot.value) {
    const request = { commandId, releaseId: snapshot.value.releaseId, expectedRevision: snapshot.value.revision, relation: selection.relation, ripFromCdConfirmed: selection.ripFromCdConfirmed, userConfirmed: true as const, ...(selection.reference ? { reference: selection.reference } : { digitalId: selection.digitalId! }) }
    mutate(() => api.confirmPhysicalLink(request))
  } else if (picker.value === 'relocate' && digital.value && selection.reference) {
    const request = { commandId, digitalId: digital.value.album.id, expectedRevision: digital.value.album.revision, reference: selection.reference, userConfirmed: true as const }
    mutate(() => api.relocateDigitalAlbum(request))
  } else if (picker.value === 'register' && selection.reference) {
    const request = { commandId, reference: selection.reference, physicalAbsenceConfirmed: selection.physicalAbsenceConfirmed, userConfirmed: true as const }
    mutate(() => api.registerDigitalAlbum(request))
  }
}
function remove(): void { if (!removing.value) return; const request = { commandId: crypto.randomUUID(), linkId: removing.value.id, expectedRevision: removing.value.revision }; mutate(() => api.removePhysicalLink(request)) }
function absence(): void {
  const current = digital.value?.album ?? snapshot.value
  if (!current || !absenceConfirm.value) return
  const absent = digital.value ? digital.value.album.physicalAbsenceConfirmed : snapshot.value!.digitalAbsenceConfirmed
  const request = { commandId: crypto.randomUUID(), id: digital.value?.album.id ?? snapshot.value!.releaseId, target: digital.value ? 'physical' as const : 'digital' as const, expectedRevision: current.revision, confirmedAbsent: !absent, userConfirmed: true as const }
  mutate(() => api.confirmPhysicalAbsence(request))
}
async function preview(offset = 0): Promise<void> {
  const reference = runtime.value?.reference, id = digital.value?.album.id
  if (!reference) return
  playbackError.value = ''
  try { const result = await api.getRoonAlbumTracks(reference, { offset, limit: 20 }); if (alive && digital.value?.album.id === id) tracks.value = result }
  catch { if (alive) playbackError.value = '曲目暂时无法读取，请检查 Roon 连接或重新定位。' }
}
async function play(reference: string): Promise<void> {
  playbackError.value = ''
  try {
    const zone = (await api.listZones()).zones.find(z => z.selected)
    if (!zone) { playbackError.value = '请先在现有播放设备菜单选择一个 Roon Zone。'; return }
    await api.playRoonTrack(reference, zone.zoneId)
  } catch { if (alive) playbackError.value = '试听未能启动，请检查 Roon 与播放设备；这不会开始正式录音。' }
}
watch(blocked, value => emit('busy', value))
watch(() => props.release?.revision, () => { if (!blocked.value) void load() })
onMounted(() => {
  void load()
  unsubscribe = api.onCoreEvent(event => {
    if (!alive || !digital.value || (event.event !== 'core.ready' && event.event !== 'roon.changed')) return
    if (event.payload.state.runtime !== 'ready' || !['paired', 'ready'].includes(event.payload.state.roon)) {
      ++generation; loading.value = false; runtime.value = { status: 'unavailable' }; tracks.value = undefined
    } else if (!blocked.value) void load()
  })
})
onUnmounted(() => { alive = false; ++generation; unsubscribe?.(); emit('busy', false) })
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
      <section v-if="tracks" aria-label="关联专辑曲目"><ul><li v-for="track in tracks.items" :key="track.reference"><span>{{ track.title }} · {{ track.artist }}</span><button :disabled="blocked" @click="play(track.reference)">试听 {{ track.title }}</button></li></ul><nav aria-label="关联曲目分页"><button :disabled="!tracks.offset" @click="preview(Math.max(0, tracks.offset - 20))">上一页</button><button :disabled="!tracks.hasMore" @click="preview(tracks.offset + 20)">下一页</button></nav></section>
    </template>
    <template v-else-if="release">
      <header><h3>Roon 数字关联</h3><button :disabled="blocked || !snapshot" @click="picker = 'link'">关联 Roon 专辑</button></header>
      <p>同名不自动合并。选择专辑后，由你确认发行版关系。</p>
      <article v-for="item in snapshot?.links" :key="item.link.id" class="link-card"><strong>{{ item.album.metadata.title }}</strong><p>{{ [item.album.metadata.artist, item.album.metadata.year, item.album.metadata.version].filter(Boolean).join(' · ') }}</p><p>{{ relations[item.link.relation] }}</p><p v-if="item.link.ripFromCdConfirmed">CD Rip · 用户单独确认</p><div class="actions"><button :disabled="blocked" @click="openDigital(item.album.id)">查看数字关联详情</button><button :disabled="blocked" @click="removing = item.link">解除关联</button></div></article>
      <div v-if="snapshot && !snapshot.links.length" class="absence"><p>{{ snapshot.digitalAbsenceConfirmed ? 'Physical Only · 已确认没有数字版本' : '尚未关联，数字版本是否存在仍待核实' }}</p><label><input v-model="absenceConfirm" type="checkbox">{{ snapshot.digitalAbsenceConfirmed ? '确认撤销没有数字版声明' : '我已核实没有数字版本' }}</label><button :disabled="blocked || !absenceConfirm" @click="absence">{{ snapshot.digitalAbsenceConfirmed ? '撤销没有数字版声明' : '确认没有数字版本' }}</button></div>
    </template>
    <template v-else>
      <header><div><h3>收藏矩阵</h3><p>按已确认关系查看收藏。未核实的缺少，不计为缺少。</p></div><button :disabled="blocked" @click="picker = 'register'">从 Roon 登记数字对象</button></header>
      <form @submit.prevent="load()"><label>搜索收藏矩阵<input v-model.trim="query" maxlength="240" placeholder="专辑或艺术家"></label><button :disabled="loading || blocked">筛选矩阵</button></form>
      <div class="matrix-grid"><article v-for="row in matrix?.items" :key="row.id" class="link-card"><h4>{{ row.title }}</h4><p>{{ row.artist }}</p><div class="counts"><span>CD {{ row.cd }}</span><span>磁带 {{ row.cassette }}</span><span v-if="row.uncertainRelations">待核实关系 {{ row.uncertainRelations }}</span></div><p>{{ row.digitalState === 'confirmed-missing' ? 'Physical Only · 已确认没有数字版本' : row.physicalState === 'confirmed-missing' ? 'Digital Only · 已确认未收藏原版实物' : row.digitalId ? '已登记数字对象' : '数字版本待核实' }}</p><button :disabled="blocked" @click="row.digitalId ? openDigital(row.digitalId) : showPhysical(row.releaseId!)">{{ row.digitalId ? '查看数字关联详情' : '查看关联实物' }}</button></article></div>
      <p v-if="matrix && !matrix.total && !loading">还没有符合条件的收藏记录。矩阵不会凭标题推测对应版本。</p>
      <p>数字对象下的 CD / 磁带数量只统计 Exact 关系；可能同版与相关版本单列。自录作品在实体音乐库查看，不计入原版数量。</p>
      <nav v-if="matrix && matrix.total > matrix.limit" aria-label="收藏矩阵分页"><button :disabled="blocked || loading || !matrix.offset" @click="load(Math.max(0, matrix.offset - 24))">上一页</button><span>{{ matrix.offset + 1 }}–{{ matrix.offset + matrix.items.length }} / {{ matrix.total }}</span><button :disabled="blocked || loading || !matrix.hasMore" @click="load(matrix.offset + 24)">下一页</button></nav>
    </template>
    <div v-if="removing" role="group" aria-label="确认解除关联" class="link-card"><p>仅解除双方关系，保留数字对象与实物记录，不自动声明缺少。</p><button :disabled="blocked" @click="remove">确认解除关联</button><button :disabled="blocked" @click="removing = undefined">取消解除</button></div>
    <RoonAlbumPicker v-if="picker" :mode="picker" :cd="release?.kind === 'cd'" :busy="saving" :pending="!!pending" :error="error" @close="picker = undefined; error = ''" @confirm="confirm" @retry="retry" />
  </section>
</template>
<style scoped>
.physical-relations{margin:28px 0;padding:24px;border:1px solid var(--mb-glass-border);border-radius:14px;background:var(--mb-bg-base);min-width:0}header,.actions,.counts,nav,form{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between}h3{font-size:19px;margin:0 0 8px}h4{font-size:17px;margin:0;overflow-wrap:anywhere}p{font-size:12px;line-height:1.8;color:var(--mb-text-secondary);overflow-wrap:anywhere}button,input{font:inherit;color:var(--mb-text-primary)}button,input:not([type]){min-height:40px;padding:8px 12px;box-sizing:border-box;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);font-size:13px;max-width:100%}button:disabled{opacity:.5;cursor:not-allowed}label{display:flex;align-items:center;gap:8px;font-size:13px;margin:14px 0}input[type=checkbox]{accent-color:var(--mb-accent);width:18px;height:18px}.link-card{padding:18px;border:1px solid var(--mb-glass-border);border-radius:12px;margin:16px 0;overflow-wrap:anywhere}.matrix-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}.counts{font-size:13px;color:var(--mb-accent)}.identity{font-size:11px}.absence{margin-top:16px}form label{display:grid;flex:1;min-width:150px}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;flex-wrap:wrap;font-size:13px}nav{justify-content:center;font-size:12px;margin-top:16px}@media(max-width:600px){.physical-relations{padding:16px}}
</style>
