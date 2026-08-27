<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { isSaveReleaseRequest, isSaveLegacyRequest, type CommercialRelease, type MusicContent, type MusicDetail, type MusicTrack, type SaveReleaseRequest, type SaveLegacyRequest } from '@music-bridge/contracts'
const props = defineProps<{ detail?: MusicDetail; busy: boolean; error: string; retryable: boolean }>()
const emit = defineEmits<{ close: []; release: [request: SaveReleaseRequest]; legacy: [request: SaveLegacyRequest]; retry: [] }>()
const dialog = ref<HTMLDialogElement>()
const personal = !!props.detail && props.detail.entry.contentStatus !== 'commercial'
const draft = ref<CommercialRelease>(JSON.parse(JSON.stringify(props.detail?.release ?? { format: 'cd', title: props.detail?.recording?.title ?? '', artist: props.detail?.recording?.artist ?? '', quantity: 1, completeness: 'basic', ...(props.detail?.recording ?? {}), tracks: props.detail?.recording?.tracks ?? [] })))
const tracks = ref<MusicTrack[]>([...draft.value.tracks].map(t => ({ ...t })))
const year = ref<number | ''>(draft.value.year ?? '')
const validation = ref('')
const locked = computed(() => props.busy || props.retryable)
const title = props.detail ? personal ? '补录历史录音内容' : '编辑实体音乐' : '添加实体音乐'
const cassette = computed(() => personal ? props.detail?.entry.kind === 'personal-cassette' : draft.value.format === 'cassette')
const cd = computed(() => !personal && draft.value.format === 'cd')
const fields = [{ key: 'label', label: '厂牌' }, { key: 'catalogNumber', label: '目录号' }, { key: 'barcode', label: '条码' }, { key: 'region', label: '地区' }, { key: 'packaging', label: '包装' }, { key: 'condition', label: '整体品相' }, { key: 'purchaseInfo', label: '购买备注' }] as const
function addTrack(): void { tracks.value.push({ title: '', artist: '', position: 1, ...(cassette.value ? { side: 'A' as const } : cd.value ? { disc: 1 } : {}) }) }
function changeFormat(): void { tracks.value = []; validation.value = ''; draft.value.discCount = 1 }
function save(): void {
  const positions = new Map<string, number>()
  const normalized = tracks.value.map(t => {
    const key = `${cd.value ? t.disc ?? 1 : ''}:${cassette.value ? t.side ?? 'A' : ''}`, position = (positions.get(key) ?? 0) + 1; positions.set(key, position)
    return { title: t.title.trim(), artist: t.artist.trim(), position, ...(cd.value ? { disc: t.disc ?? 1 } : {}), ...(cassette.value ? { side: t.side ?? 'A' } : {}), ...(t.durationSeconds ? { durationSeconds: t.durationSeconds } : {}) }
  })
  const content: MusicContent = { title: draft.value.title.trim(), artist: draft.value.artist.trim(), tracks: normalized,
    ...(year.value !== '' ? { year: Number(year.value) } : {}), ...(draft.value.edition ? { edition: draft.value.edition } : {}), ...(draft.value.storage ? { storage: draft.value.storage } : {}), ...(draft.value.notes ? { notes: draft.value.notes } : {}) }
  if (personal) {
    const request = { commandId: crypto.randomUUID(), physicalId: props.detail!.entry.id, expectedRevision: props.detail!.entry.revision, content }
    if (!isSaveLegacyRequest(request)) { validation.value = '请填写标题、艺术家和有效曲目；每面分别按顺序编号。'; return }
    emit('legacy', request)
  } else {
    const release = JSON.parse(JSON.stringify({ ...draft.value, ...content })) as CommercialRelease
    if (year.value === '') delete release.year
    const request = { commandId: crypto.randomUUID(), release, ...(props.detail ? { id: props.detail.entry.id, expectedRevision: props.detail.entry.revision } : {}) }
    if (!isSaveReleaseRequest(request)) { validation.value = '请检查必填字段、数量和曲目。已核实发行版必须填写版次；曲目碟号不能超过碟数。'; return }
    emit('release', request)
  }
}
onMounted(() => dialog.value?.showModal())
</script>
<template>
  <dialog ref="dialog" class="music-editor" :aria-label="title" @cancel.prevent="!locked && emit('close')">
    <form @submit.prevent="save">
      <header><h2>{{ title }}</h2><button type="button" :disabled="locked" aria-label="关闭音乐录入" @click="emit('close')">关闭</button></header>
      <p>{{ personal ? '这是历史内容补录，不会新增磁带或生成正式录音完成证据。' : '先录入基础信息，再逐步补齐发行版、照片和曲目。' }}</p>
      <fieldset :disabled="locked">
        <div class="fields">
          <label v-if="!personal">介质<select v-model="draft.format" :disabled="!!detail" @change="changeFormat"><option value="cd">原版 CD</option><option value="cassette">原版磁带</option></select></label>
          <label>艺术家<input v-model.trim="draft.artist" required maxlength="240" autofocus></label>
          <label>专辑 / 录音标题<input v-model.trim="draft.title" required maxlength="240"></label>
          <label>版次<input v-model.trim="draft.edition" maxlength="240"></label>
          <label>年份<input v-model.number="year" type="number" min="1900" max="2200"></label>
          <label>存放位置<input v-model.trim="draft.storage" maxlength="240"></label>
          <label v-if="!personal">实物数量<input v-model.number="draft.quantity" required type="number" min="1" max="10000"></label>
          <label v-if="!personal">资料完整度<select v-model="draft.completeness"><option value="basic">基础资料</option><option value="partial">部分补齐</option><option value="verified">已由我核实发行版</option></select></label>
        </div>
        <details v-if="!personal"><summary>发行版与品相</summary><div class="fields details-fields">
          <label v-for="field in fields" :key="field.key">{{ field.label }}<input v-model.trim="draft[field.key]" maxlength="240"></label>
          <label v-if="cd">碟数<input v-model.number="draft.discCount" type="number" min="1" max="100" placeholder="1"></label>
          <template v-if="cassette"><label>磁带类型<select v-model="draft.tapeType"><option value="unknown">待确认</option><option v-for="kind in ['I', 'II', 'III', 'IV']" :key="kind" :value="kind">Type {{ kind }}</option></select></label><label>Dolby / NR<input v-model.trim="draft.noiseReduction" maxlength="240"></label><label>磁带品相<input v-model.trim="draft.tapeCondition" maxlength="240"></label><label>J-Card 品相<input v-model.trim="draft.jCardCondition" maxlength="240"></label><label>盒子品相<input v-model.trim="draft.caseCondition" maxlength="240"></label></template>
        </div></details>
        <details><summary>曲目（{{ tracks.length }} / 200）</summary>
          <p>每面 / 每张碟按输入顺序排列，时长可留空。</p>
          <article v-for="(track, index) in tracks" :key="index" class="track-fields" :aria-label="`曲目 ${index + 1}`">
            <label v-if="cassette">面<select v-model="track.side"><option value="A">A 面</option><option value="B">B 面</option></select></label>
            <label v-if="cd">碟号<input v-model.number="track.disc" type="number" min="1" max="100"></label>
            <label>曲名<input v-model.trim="track.title" required maxlength="240"></label><label>曲目艺术家<input v-model.trim="track.artist" maxlength="240"></label>
            <label>秒数<input v-model.number="track.durationSeconds" type="number" min="1" max="86400"></label><button type="button" :aria-label="`移除曲目 ${index + 1}`" @click="tracks.splice(index, 1)">移除</button>
          </article>
          <button type="button" :disabled="tracks.length >= 200" @click="addTrack">添加曲目</button>
        </details>
        <label class="notes">备注<input v-model.trim="draft.notes" maxlength="2000"></label>
      </fieldset>
      <p v-if="validation || error" role="alert">{{ validation || error }}</p>
      <footer><button v-if="retryable" type="button" :disabled="busy" @click="emit('retry')">重试原操作</button><button type="submit" :disabled="locked">{{ busy ? '正在保存…' : '保存音乐资料' }}</button></footer>
    </form>
  </dialog>
</template>
<style scoped>
.music-editor{box-sizing:border-box;width:min(760px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:26px;border:1px solid var(--mb-glass-border);border-radius:16px;background:var(--mb-bg-base);color:var(--mb-text-primary)}
dialog::backdrop{background:#000b}header,footer{display:flex;align-items:center;justify-content:space-between;gap:14px}footer{justify-content:flex-end;margin-top:24px}h2{font-size:22px;margin:0}p{font-size:13px;color:var(--mb-text-secondary);line-height:1.8}fieldset{border:0;padding:0;min-width:0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:grid;gap:7px;font-size:13px;min-width:0}input,select{box-sizing:border-box;width:100%;min-width:0;min-height:40px;padding:8px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit}button{min-height:40px;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-glass-clear);color:var(--mb-text-primary)}details{margin-top:22px}summary{cursor:pointer;padding:10px 0;font-size:14px}.details-fields{margin-top:14px}.track-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:14px 0;border-bottom:1px solid var(--mb-divider)}.notes{margin-top:20px}:disabled{opacity:.55;cursor:not-allowed}@media(max-width:600px){.fields{grid-template-columns:1fr}.music-editor{padding:20px}}
</style>
