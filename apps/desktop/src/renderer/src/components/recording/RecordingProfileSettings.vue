<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  effectiveRecordingSettings,
  isRecordingProfileContent,
  isRecordingSessionOverrides,
  type RecordingProfileContent,
  type RecordingProfileVersion,
  type RecordingSessionOverrides,
  type RecordingSessionSettings,
  type RecordingChainStep,
} from '@music-bridge/contracts'
import RecordingChainEditor from './RecordingChainEditor.vue'

const props = defineProps<{ draftId: string; disabled: boolean }>()
const emit = defineEmits<{
  session: [value: RecordingSessionSettings | null]
  state: [value: { busy: boolean; dirty: boolean }]
}>()
const api = window.musicBridge
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const profiles = shallowRef<readonly RecordingProfileVersion[]>([])
const historic = shallowRef<readonly RecordingProfileVersion[]>([])
const session = shallowRef<RecordingSessionSettings | null>(null)
const selectedId = ref('')
const editing = ref(false), editingVersion = shallowRef<RecordingProfileVersion>()
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('')
const pending = shallowRef<() => Promise<void>>()
const profileConfirmed = ref(false), sessionConfirmed = ref(false)
const preRollSeconds = ref(0)
const overrideFields = [
  { key: 'noiseReduction', label: '降噪' },
  { key: 'calibration', label: '校准' },
  { key: 'recordLevel', label: '电平' },
] as const
type NoteKey = typeof overrideFields[number]['key']
type OverrideMode = 'inherit' | 'unset' | 'custom'
const choices = ref<Record<NoteKey, OverrideMode>>({ noiseReduction: 'inherit', calibration: 'inherit', recordLevel: 'inherit' })
const notes = ref<Record<NoteKey, string>>({ noiseReduction: '', calibration: '', recordLevel: '' })
const temporaryChain = ref(false), chain = ref<RecordingChainStep[]>([])
const tapeTypes = ['I','II','III','IV'] as const
function blank(): RecordingProfileContent {
  return {
    name: '', signalChain: [{ id: crypto.randomUUID(), kind: 'audio-interface', label: '' }],
    defaults: { noiseReduction: null, calibration: null, recordLevel: null, preRollMs: 0 },
    compatibility: { confirmed: false, cassetteTypes: [], dat: false },
    executionFormat: {
      sampleRate: 44100, channelCount: 2, channelLayout: 'stereo',
      internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le',
      resamplerImplementation: 'none', resamplerVersion: 'not-applied',
      ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: '', version: '' },
    },
  }
}
const form = ref<RecordingProfileContent>(blank())
const versions = computed(() => [...new Map([...profiles.value, ...historic.value].map(p => [p.id,p])).values()])
const selected = computed(() => versions.value.find(p => p.id === selectedId.value))
const locked = computed(() => props.disabled || loading.value || busy.value || !!pending.value)
const overrides = computed<RecordingSessionOverrides>(() => {
  const result: RecordingSessionOverrides = {}
  for (const { key } of overrideFields) {
    if (choices.value[key] === 'unset') result[key] = null
    else if (choices.value[key] === 'custom') result[key] = notes.value[key].trim()
  }
  if (temporaryChain.value) result.signalChain = copy(chain.value)
  return result
})
const effective = computed(() => selected.value ? effectiveRecordingSettings(copy(selected.value), copy(overrides.value)) : undefined)
const sessionDirty = computed(() => !!selected.value && (selectedId.value !== session.value?.profileVersionId || JSON.stringify(overrides.value) !== JSON.stringify(session.value?.overrides ?? {})))
const normalizedForm = computed(() => {
  const value = copy(form.value)
  value.name = value.name.trim()
  value.signalChain = value.signalChain.map(step => ({ ...step, label: step.label.trim() }))
  for (const { key } of overrideFields) value.defaults[key] = value.defaults[key]?.trim() || null
  value.defaults.preRollMs = Math.round(preRollSeconds.value * 1000)
  value.executionFormat.channelLayout = value.executionFormat.channelCount === 1 ? 'mono' : 'stereo'
  return value
})
const validProfile = computed(() => Number.isFinite(preRollSeconds.value) && isRecordingProfileContent(normalizedForm.value))
const validSession = computed(() => !!selected.value && isRecordingSessionOverrides(overrides.value))
let alive = true
watch([form, preRollSeconds], () => { profileConfirmed.value = false }, { deep: true })
watch([selectedId, overrides], () => { sessionConfirmed.value = false })
watch([loading,busy,pending,editing,sessionDirty], () => emit('state', { busy: loading.value || busy.value || !!pending.value, dirty: editing.value || sessionDirty.value }), { immediate: true })
watch(selected, value => { if (value && !temporaryChain.value) chain.value = copy([...value.content.signalChain]) })
function setSession(value: RecordingSessionSettings | null): void {
  session.value = value
  selectedId.value = value?.profileVersionId ?? ''
  for (const { key } of overrideFields) {
    const note = value?.overrides[key]
    choices.value[key] = note === undefined ? 'inherit' : note === null ? 'unset' : 'custom'
    notes.value[key] = note ?? ''
  }
  temporaryChain.value = !!value?.overrides.signalChain
  if (value?.overrides.signalChain) chain.value = copy([...value.overrides.signalChain])
  emit('session', value)
}
async function refresh(): Promise<void> {
  const preserveEdits = editing.value || sessionDirty.value
  const selectedBeforeRefresh = selected.value
  loading.value = true
  try {
    const [list, current] = await Promise.all([api.listRecordingProfiles(), api.getRecordingSession(props.draftId)])
    const old = current.session && !list.profiles.some(p => p.id === current.session!.profileVersionId)
      ? await api.getRecordingProfileVersion(current.session.profileVersionId) : undefined
    if (!alive) return
    profiles.value = list.profiles
    historic.value = [...new Map([...(old ? [old] : []), ...(preserveEdits && selectedBeforeRefresh ? [selectedBeforeRefresh] : [])].map(p => [p.id,p])).values()]
    if (preserveEdits) {
      session.value = current.session
      emit('session', current.session)
      sessionConfirmed.value = false
      profileConfirmed.value = false
      notice.value = '已刷新保存状态；未保存的编辑仍保留，请重新核对并确认。'
    } else setSession(current.session)
  } catch { if (alive) error.value = '参数读取失败，原有设置仍保留。请刷新后重试。' }
  finally { if (alive) loading.value = false }
}
function beginEdit(version?: RecordingProfileVersion): void {
  if (locked.value) return
  editingVersion.value = version
  form.value = version ? copy(version.content) : blank()
  preRollSeconds.value = form.value.defaults.preRollMs / 1000
  profileConfirmed.value = false
  editing.value = true
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try { await pending.value(); if (alive) pending.value = undefined }
  catch (cause) {
    if (!alive) return
    if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST|BAD_REQUEST)\]/u.test(cause instanceof Error ? cause.message : '')) {
      pending.value = undefined
      error.value = '请求未接受，版本或参数已改变。请保留编辑内容，刷新版本后重新确认。'
    } else error.value = '保存回执尚未确认，请重试原操作；不会创建重复版本。'
  } finally { if (alive) busy.value = false }
}
function saveProfile(): void {
  if (locked.value || !validProfile.value || !profileConfirmed.value) return
  const previous = editingVersion.value
  const request = { commandId: crypto.randomUUID(), content: normalizedForm.value, userConfirmed: true as const,
    ...(previous ? { profileId: previous.profileId, expectedVersionId: previous.id } : {}) }
  pending.value = async () => {
    const saved = await api.saveRecordingProfile(request)
    if (!alive) return
    profiles.value = [saved, ...profiles.value.filter(p => p.profileId !== saved.profileId)]
    if (previous) historic.value = [...historic.value.filter(p => p.id !== previous.id), previous]
    selectedId.value = saved.id; editing.value = false
    notice.value = 'Profile 版本已保存；请确认是否用于本次录音。'
  }
  void retry()
}
function saveSession(): void {
  if (locked.value || !validSession.value || !sessionConfirmed.value || editing.value) return
  const request = { commandId: crypto.randomUUID(), draftId: props.draftId, expectedRevision: session.value?.revision ?? 0,
    profileVersionId: selectedId.value, overrides: copy(overrides.value), userConfirmed: true as const }
  pending.value = async () => {
    const saved = await api.saveRecordingSession(request)
    if (alive) { setSession(saved); sessionConfirmed.value = false; notice.value = '本次参数已保存' }
  }
  void retry()
}
async function loadHistory(): Promise<void> {
  if (!selected.value || locked.value) return
  loading.value = true
  try { const h = await api.getRecordingProfileHistory(selected.value.profileId); if (alive) historic.value = h.versions }
  catch { if (alive) error.value = '版本历史暂时无法读取。' }
  finally { if (alive) loading.value = false }
}
onMounted(() => { void refresh() })
onBeforeUnmount(() => { alive = false })
</script>
<template>
  <section class="profile-settings" aria-labelledby="profile-settings-title">
    <div class="section-heading">
      <div><p class="kicker">01 · 录音参数</p><h3 id="profile-settings-title">沿用习惯，只改这一次的不同。</h3></div>
      <button :disabled="locked || editing" @click="beginEdit()">新建 Profile</button>
    </div>
    <p class="muted">Profile 保存设备链、默认值和计划格式。参数保存不会连接设备，也不代表通过输出认证。</p>
    <label>所选 Profile 版本
      <select v-model="selectedId" :disabled="locked || editing">
        <option value="">选择已保存的 Profile</option>
        <option v-for="version in versions" :key="version.id" :value="version.id">{{ version.content.name }} · v{{ version.sequence }} · {{ version.id.slice(0,8) }}</option>
      </select>
    </label>
    <div v-if="selected" class="actions">
      <button :disabled="locked || editing || !profiles.some(p => p.id === selectedId)" @click="beginEdit(selected)">编辑默认值并建立新版本</button>
      <button :disabled="locked || editing" @click="loadHistory">查看旧版本</button>
    </div>
    <p v-if="selected && !profiles.some(p => p.id === selectedId)" class="muted">当前选用历史版本。要修改默认值，请先选择模板的最新版本；旧资产保持原参数。</p>

    <form v-if="editing" class="editor" aria-label="Profile 编辑" @submit.prevent="saveProfile">
      <h4>{{ editingVersion ? `编辑 ${editingVersion.content.name}` : '建立可复用 Profile' }}</h4>
      <fieldset :disabled="locked">
        <label>模板名称<input v-model="form.name" maxlength="240" required autocomplete="off"></label>
        <h4>有序设备与连接链</h4>
        <RecordingChainEditor v-model="form.signalChain" :disabled="locked" />
        <div class="fields">
          <label>默认降噪<input v-model="form.defaults.noiseReduction" maxlength="240" placeholder="例如 Off；留空表示未设定"></label>
          <label>默认校准<input v-model="form.defaults.calibration" maxlength="240" placeholder="记录常用校准习惯"></label>
          <label>默认录音电平<input v-model="form.defaults.recordLevel" maxlength="240" placeholder="可在本次参数中覆盖"></label>
          <label>手动预卷（秒）<input v-model.number="preRollSeconds" type="number" min="0" max="600" step="0.001"></label>
        </div>
        <p class="muted">手动预卷用于操作准备，不额外写入音频；已冻结的 Lead-in 和 Render 不重复加静音。</p>
        <fieldset class="compatibility"><legend>介质兼容性</legend>
          <div class="choices"><label v-for="type in tapeTypes" :key="type" class="check"><input v-model="form.compatibility.cassetteTypes" type="checkbox" :value="type" :aria-label="`兼容 Type ${type}`">Type {{ type }}</label><label class="check"><input v-model="form.compatibility.dat" type="checkbox">兼容 DAT</label></div>
          <label class="check"><input v-model="form.compatibility.confirmed" type="checkbox">我已确认上述介质兼容性</label>
        </fieldset>
        <h4>计划执行格式</h4>
        <div class="fields">
          <label>采样率（Hz）<input v-model.number="form.executionFormat.sampleRate" type="number" min="8000" max="384000" step="1" required></label>
          <label>声道<select v-model="form.executionFormat.channelCount"><option :value="1">单声道</option><option :value="2">立体声</option></select></label>
          <label>输出样本格式<select v-model="form.executionFormat.outputSampleFormat"><option value="pcm-s16le">整数 PCM · 16 bit</option><option value="pcm-s24le">整数 PCM · 24 bit</option><option value="pcm-s32le">整数 PCM · 32 bit</option><option value="pcm-f32le">浮点 PCM · 32 bit（转换待接入）</option></select></label>
          <label>内部精度<select v-model="form.executionFormat.internalProcessingPrecision"><option value="integer-bit-copy">整数位复制</option><option value="float32">Float 32（待接入）</option><option value="float64">Float 64（待接入）</option></select></label>
          <label>计划后端标识<input v-model="form.executionFormat.outputBackend.id" maxlength="80" required placeholder="填写计划使用的后端标识"></label>
          <label>计划后端版本<input v-model="form.executionFormat.outputBackend.version" maxlength="80" required placeholder="填写明确版本"></label>
        </div>
        <p class="muted">后端标识是计划参数，不是设备 ID 或认证结果。当前只编译同格式整数 PCM；需要转换时明确阻断，不自动改格式。</p>
        <details><summary>转换与声道策略</summary><div class="fields">
          <label>重采样器标识<input v-model="form.executionFormat.resamplerImplementation" maxlength="80" required></label>
          <label>重采样器版本<input v-model="form.executionFormat.resamplerVersion" maxlength="80" required></label>
          <label>Dither<select v-model="form.executionFormat.ditherPolicy"><option value="none">不施加</option><option value="tpdf">TPDF（待接入）</option></select></label>
          <label>声道映射<select v-model="form.executionFormat.channelMapping"><option value="identity">保持原声道</option><option value="mono-to-stereo">单声道转立体声（待接入）</option><option value="stereo-to-mono">立体声转单声道（待接入）</option></select></label>
        </div></details>
        <label class="check"><input v-model="profileConfirmed" type="checkbox">我确认保存 Profile；这些参数不构成设备认证</label>
        <p v-if="!validProfile" class="muted">请填写名称、完整设备链和后端版本，并检查格式参数。空白默认降噪、校准及电平会保存为“未设定”。</p>
        <div class="actions"><button type="submit" class="primary" :disabled="!validProfile || !profileConfirmed">保存 Profile 版本</button><button type="button" @click="editing = false">取消编辑</button></div>
      </fieldset>
    </form>

    <div v-if="selected && !editing" class="session-editor">
      <div class="profile-summary"><strong>{{ selected.content.name }} · v{{ selected.sequence }}</strong><p>{{ selected.content.signalChain.map(s => s.label).join(' → ') }}</p><p>{{ selected.content.executionFormat.sampleRate.toLocaleString() }} Hz · {{ selected.content.executionFormat.channelCount === 2 ? '立体声' : '单声道' }} · {{ selected.content.executionFormat.outputSampleFormat }}</p></div>
      <h4>本次覆盖</h4><p class="muted">“继承”沿用所选版本；“未设定”明确清空该项。无需重复填写固定参数。</p>
      <fieldset :disabled="locked">
        <div class="fields">
          <div v-for="field in overrideFields" :key="field.key" class="override-field">
            <label>{{ `本次${field.label}选择` }}<select v-model="choices[field.key]"><option value="inherit">继承：{{ selected.content.defaults[field.key] ?? '未设定' }}</option><option value="unset">未设定</option><option value="custom">本次另填</option></select></label>
            <label v-if="choices[field.key] === 'custom'">{{ `本次${field.label}` }}<input v-model="notes[field.key]" maxlength="240" required></label>
          </div>
        </div>
        <label class="check"><input v-model="temporaryChain" type="checkbox">本次使用临时设备链</label>
        <RecordingChainEditor v-if="temporaryChain" v-model="chain" prefix="临时" :disabled="locked" />
        <p class="muted">有效参数：降噪 {{ effective?.noiseReduction ?? '未设定' }} · 校准 {{ effective?.calibration ?? '未设定' }} · 电平 {{ effective?.recordLevel ?? '未设定' }} · 手动预卷 {{ (effective?.preRollMs ?? 0) / 1000 }} 秒。</p>
        <label v-if="sessionDirty" class="check"><input v-model="sessionConfirmed" type="checkbox">我确认本次参数；后续修改模板不改写此版本</label>
        <button v-if="sessionDirty" class="primary" :disabled="!validSession || !sessionConfirmed" @click="saveSession">保存本次参数</button>
        <p v-else class="muted">已保存修订 {{ session?.revision }}。执行资产会保留当次完整参数，正式录音 Snapshot 仍在后续 Plan Freeze 建立。</p>
      </fieldset>
    </div>
    <p v-if="loading || busy" role="status">正在读取参数或等待保存回执…</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <div v-if="error" role="alert" class="warning"><p>{{ error }}</p><button v-if="pending" :disabled="busy" @click="retry">重试原操作</button><button v-else :disabled="busy" @click="error = ''; refresh()">刷新参数</button></div>
  </section>
</template>
<style scoped>
.profile-settings{min-width:0}.section-heading,.actions,.choices{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.section-heading{justify-content:space-between}.kicker{font-size:12px;color:var(--mb-accent);margin:0 0 8px}h3{font-size:19px;margin:0;line-height:1.5}h4{font-size:15px;margin:24px 0 12px}p{line-height:1.7;overflow-wrap:anywhere}.muted{color:var(--mb-text-secondary);font-size:13px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.actions{margin-top:12px}label{display:grid;gap:7px;margin:12px 0;font-size:13px;min-width:0}.check{display:flex;gap:10px;align-items:flex-start;line-height:1.7;min-height:44px;cursor:pointer}.check input{flex:0 0 auto;width:18px;height:18px;min-height:0;margin:2px 0 0;accent-color:var(--mb-accent)}input,select,button{min-height:44px;box-sizing:border-box;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);padding:8px 12px;font:inherit;min-width:0}input,select{width:100%}button{cursor:pointer;font-size:13px}button:disabled,fieldset:disabled{opacity:.55}button:disabled{cursor:not-allowed}.primary{background:var(--mb-accent);color:var(--mb-bg-deep);font-weight:600;border-color:var(--mb-accent)}fieldset{border:0;padding:0;min-width:0}.compatibility{border-block:1px solid var(--mb-glass-border);margin-top:20px;padding-top:14px}.compatibility legend{font-size:14px;padding:0 8px 0 0}.editor{margin-top:22px;padding:20px;border:1px solid var(--mb-glass-border);border-radius:12px}.editor h4:first-child{margin-top:0}.profile-summary{margin:18px 0;padding:16px;background:var(--mb-glass-clear);border-left:2px solid var(--mb-accent);font-size:13px}.profile-summary p{margin:8px 0 0}.warning,.notice{font-size:13px;line-height:1.7}.warning{padding:14px;border:1px solid var(--mb-glass-border);border-radius:8px}.notice{color:var(--mb-accent)}summary{min-height:44px;cursor:pointer;font-size:13px;line-height:44px}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}@media(max-width:600px){.fields{grid-template-columns:1fr;gap:4px}.editor{padding:14px}.section-heading{align-items:flex-start}.choices{gap:8px 16px}}@media(hover:hover) and (pointer:fine){button:not(:disabled):hover{border-color:var(--mb-accent)}}button:not(:disabled):active{transform:scale(.98)}@media(prefers-reduced-motion:reduce){button:not(:disabled):active{transform:none}}
</style>
