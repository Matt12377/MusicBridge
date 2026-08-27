<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { DraftProgramType, MasterDraft, MasterDraftResult, MasterDraftSummary, Page, AppendMasterDraftRequest } from '@music-bridge/contracts'
import SourceEvidencePanel from './SourceEvidencePanel.vue'
import type { DraftSourceSnapshot } from '@music-bridge/contracts'
import MasterSourcePicker from './MasterSourcePicker.vue'
const emit = defineEmits<{ 'open-collection': [] }>()
const api = window.musicBridge
const catalog = shallowRef<Page<MasterDraftSummary>>(), draft = shallowRef<MasterDraft>()
const loading = ref(false), saving = ref(false), picker = ref(false), error = ref(''), notice = ref(''), discarding = ref(false)
const sourceTrackId = ref(''), sourceSnapshot = shallowRef<DraftSourceSnapshot>()
const pending = shallowRef<() => Promise<MasterDraftResult>>()
const title = ref(''), programType = ref<DraftProgramType>('compilation'), trackIds = ref<string[]>([])
const blocked = computed(() => saving.value || !!pending.value)
const dirty = computed(() => !!draft.value && (title.value !== draft.value.title || programType.value !== draft.value.programType || JSON.stringify(trackIds.value) !== JSON.stringify(draft.value.tracks.map(t => t.id))))
const tracks = computed(() => trackIds.value.map(id => draft.value!.tracks.find(t => t.id === id)!))
const types = { compilation: 'Compilation · 精选', concert: 'Concert · 演出', continuous: 'Continuous Program · 连续节目' }
const duration = (ms: number | undefined): string => ms === undefined ? '时长待核实' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
let alive = true, generation = 0
async function list(offset = 0): Promise<void> {
  const token = ++generation; loading.value = true
  try { const result = await api.listMasterDrafts({ offset, limit: 12 }); if (alive && token === generation) catalog.value = result }
  catch { if (alive && token === generation) error.value = '草稿列表暂时无法读取，已存内容不会被清空。' }
  finally { if (alive && token === generation) loading.value = false }
}
async function open(id: string): Promise<void> {
  const token = ++generation; loading.value = true
  try {
    const result = await api.getMasterDraft(id)
    const sources = await api.getDraftSources(id)
    if (alive && token === generation) { sourceSnapshot.value = sources; draft.value = result; title.value = result.title; programType.value = result.programType; trackIds.value = result.tracks.map(t => t.id) }
  } catch { if (alive && token === generation) error.value = '草稿详情暂时无法读取，请刷新后重试。' }
  finally { if (alive && token === generation) loading.value = false }
}
async function closeSources(): Promise<void> { sourceTrackId.value = ''; if (draft.value) { try { sourceSnapshot.value = await api.getDraftSources(draft.value.id) } catch { error.value = '源验证状态暂时无法读取，请刷新。' } } }
function sourceLabel(id: string): string { const binding = sourceSnapshot.value?.tracks.find(t => t.trackId === id)?.binding; return binding?.sourceLockEligible ? '源已验证' : binding ? '已绑定 · 待确认或重新校验' : '来源未验证' }
function back(force = false): void { if (dirty.value && !force) { discarding.value = true; return }; draft.value = undefined; trackIds.value = []; discarding.value = false; notice.value = ''; error.value = ''; void list() }
async function retry(): Promise<void> {
  if (!pending.value || saving.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const result = await pending.value()
    if (!alive) return
    pending.value = undefined; picker.value = false; notice.value = '草稿已保存'
    await list(); await open(result.draftId)
  } catch (cause) {
    if (alive) {
      const message = cause instanceof Error ? cause.message : ''
      if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(message)) {
        pending.value = undefined
        if (draft.value) await open(draft.value.id)
        error.value = '本次修改未保存，草稿或 Roon 引用已变化。请重新浏览、编辑并确认。'
      } else error.value = '草稿保存结果尚未确认，请重试原操作；不会重复追加曲目。'
    }
  } finally { if (alive) saving.value = false }
}
function mutate(operation: () => Promise<MasterDraftResult>): void { if (blocked.value) return; pending.value = operation; void retry() }
function append(request: AppendMasterDraftRequest): void { mutate(() => api.appendMasterDraft(request)) }
function save(): void {
  if (!draft.value || !dirty.value || !title.value.trim()) return
  const request = { commandId: crypto.randomUUID(), draftId: draft.value.id, expectedRevision: draft.value.revision, title: title.value.trim(), programType: programType.value, trackIds: [...trackIds.value] }
  mutate(() => api.updateMasterDraft(request))
}
function move(index: number, delta: number): void {
  const ids = [...trackIds.value], target = index + delta
  if (blocked.value || target < 0 || target >= ids.length) return
  ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]; trackIds.value = ids
}
async function play(trackId: string): Promise<void> {
  if (!draft.value || blocked.value) return
  error.value = ''
  try {
    const current = await api.getMasterDraftTrackRuntime(draft.value.id, trackId)
    if (!current.reference) { error.value = '当前曲目链接待重新定位，已保存的草稿和曲序仍保留。'; return }
    const zone = (await api.listZones()).zones.find(z => z.selected)
    if (!zone) { error.value = '请先在现有播放设备菜单选择 Roon Zone。'; return }
    await api.playRoonTrack(current.reference, zone.zoneId)
  } catch { if (alive) error.value = '试听未能启动，请检查 Roon 和播放设备；没有开始正式录音。' }
}
onMounted(() => { void list() })
onUnmounted(() => { alive = false; ++generation })
</script>

<template>
  <section class="recording-view" data-component="RecordingView" aria-labelledby="recording-heading">
    <header class="recording-heading">
      <div>
        <p class="recording-kicker">个人录音</p>
        <h2 id="recording-heading">从喜欢的音乐开始。</h2>
        <p class="recording-subtitle">选好音乐，再为它找到一盘合适的磁带。</p>
      </div>
      <div class="recording-secondary" aria-label="录音资料">
        <button type="button" disabled aria-describedby="recording-secondary-status">母版</button>
        <button type="button" disabled aria-describedby="recording-secondary-status">录音记录</button>
        <span id="recording-secondary-status">尚未接入</span>
      </div>
    </header>

    <ol class="recording-steps" aria-label="录音准备步骤">
      <li aria-current="step"><span>01</span><strong>选择音乐</strong></li>
      <li><span>02</span><strong>选择磁带</strong></li>
      <li><span>03</span><strong>确认与预检</strong></li>
    </ol>

    <div v-if="!draft" class="recording-start">
      <div class="recording-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M9 18V6l10-2v12M9 10l10-2" /><ellipse cx="6" cy="18" rx="3" ry="2.5" /><ellipse cx="16" cy="16" rx="3" ry="2.5" /></svg>
      </div>
      <h3>这一盘，想录些什么？</h3>
      <p class="recording-description">从 Roon 中挑选一张专辑，或编排自己的精选。<br>曲目确定后，再根据空白磁带库存推荐合适的型号与时长。</p>
      <button class="recording-primary" type="button" :disabled="blocked" aria-describedby="recording-status" @click="picker = true">从 Roon 选择音乐</button>
      <p id="recording-status" class="recording-status">确认选曲后保存录音草稿。下一步可绑定实际源文件进行只读验证，选曲不会操作播放设备。</p>
    </div>

    <section v-else class="draft-detail" aria-label="录音草稿详情">
      <div class="draft-toolbar"><button :disabled="blocked" @click="back()">返回草稿列表</button><button :disabled="blocked || dirty" @click="picker = true">继续从 Roon 添加</button></div>
      <h3>{{ draft.title }}</h3><p class="draft-id">草稿编号 {{ draft.id }} · {{ draft.trackCount }} 首 · {{ types[draft.programType] }}</p>
      <p class="draft-evidence">{{ sourceSnapshot?.sourceLockEligible ? '全部曲目已满足源验证条件，最终布局及冻结仍待完成。' : 'Roon 信息仅用于选曲；需逐首绑定实际源文件、校验并确认，才能继续冻结。' }}</p>
      <fieldset :disabled="blocked"><legend class="sr-only">编辑录音草稿</legend>
        <div class="draft-fields"><label>草稿标题<input v-model="title" maxlength="240" required></label><label>节目类型<select v-model="programType"><option v-for="(label, value) in types" :key="value" :value="value">{{ label }}</option></select></label></div>
        <p class="draft-estimate">已保存草稿的初步时长：{{ duration(draft.estimatedDurationMs) }}。精选按相邻曲目额外 5 秒估算，不等于最终分面或执行时间线。</p>
        <ol class="draft-tracks"><li v-for="(track, index) in tracks" :key="track.id"><span class="position">{{ index + 1 }}</span><div class="track-title"><strong>{{ track.metadata.title }}</strong><small>{{ [track.metadata.artist, track.metadata.album, track.metadata.version].filter(Boolean).join(' · ') || '元数据待核实' }}</small><small>{{ sourceLabel(track.id) }} · {{ duration(track.metadata.durationMs) }}</small></div><div class="track-actions"><button :disabled="dirty" @click="sourceTrackId = track.id">绑定实际源文件</button><button :aria-label="`上移 ${track.metadata.title}`" :disabled="index === 0" @click="move(index, -1)">上移</button><button :aria-label="`下移 ${track.metadata.title}`" :disabled="index === tracks.length - 1" @click="move(index, 1)">下移</button><button :aria-label="`移除 ${track.metadata.title}`" @click="trackIds = trackIds.filter(id => id !== track.id)">移除</button><button @click="play(track.id)">试听 {{ track.metadata.title }}</button></div></li></ol>
        <p v-if="!tracks.length" class="draft-estimate">草稿还没有曲目。可先保存，再继续从 Roon 添加。</p>
        <div class="draft-toolbar"><button :disabled="!dirty || !title.trim()" @click="save">保存草稿修改</button><button :disabled="!dirty" @click="open(draft.id)">撤销未保存修改</button><button disabled aria-describedby="draft-freeze-status">冻结母版</button></div>
      </fieldset>
      <p id="draft-freeze-status" class="draft-estimate">冻结前需完成实际源文件验证及最终布局；当前只保存草稿。</p>
      <p v-if="dirty" class="draft-estimate" role="status">有未保存的修改；添加更多曲目前请先保存或撤销。</p>
      <div v-if="discarding" class="discard"><p>返回会放弃当前未保存的修改，已保存草稿不变。</p><button @click="back(true)">放弃未保存修改并返回</button><button @click="discarding = false">继续编辑</button></div>
    </section>
    <p v-if="loading" class="draft-message" role="status">正在读取草稿…</p><p v-if="notice" class="draft-message" role="status">{{ notice }}</p>
    <p v-if="error && !picker" class="draft-message" role="alert">{{ error }} <button v-if="pending" :disabled="saving" @click="retry">重试原操作</button><button v-else :disabled="loading" @click="error = ''; draft ? open(draft.id) : list()">刷新草稿</button></p>
    <section v-if="!draft && catalog?.items.length" class="draft-library" aria-label="已保存的录音草稿"><h3>继续一份草稿</h3><div class="draft-grid"><button v-for="item in catalog.items" :key="item.id" class="draft-card" @click="open(item.id)"><span>继续草稿 {{ item.title }}</span><small>{{ item.trackCount }} 首 · {{ duration(item.estimatedDurationMs) }} · {{ item.sourceLockEligible ? '源已验证' : '来源待验证' }}</small></button></div><nav v-if="catalog.total > catalog.limit" aria-label="草稿分页"><button :disabled="loading || !catalog.offset" @click="list(Math.max(0, catalog.offset - 12))">上一页</button><button :disabled="loading || !catalog.hasMore" @click="list(catalog.offset + 12)">下一页</button></nav></section>
    <SourceEvidencePanel v-if="draft && sourceTrackId" :draft-id="draft.id" :track-id="sourceTrackId" :title="draft.tracks.find(t => t.id === sourceTrackId)?.metadata.title ?? '曲目'" @close="closeSources" />
    <MasterSourcePicker v-if="picker" :draft="draft" :busy="saving" :pending="!!pending" :error="error" @close="picker = false; error = ''" @confirm="append" @retry="retry" />

    <footer class="recording-footer">
      <p>先整理收藏也可以，选曲前不需要预留磁带。</p>
      <button type="button" @click="emit('open-collection')">查看空白磁带收藏 <span aria-hidden="true">→</span></button>
    </footer>
  </section>
</template>

<style scoped>
.recording-view { max-width: 1120px; margin: 0 auto; padding: 32px 36px 40px; }
.recording-heading { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.recording-kicker { margin: 0 0 10px; color: var(--mb-accent); font-size: 12px; letter-spacing: .08em; }
h2 { margin: 0; font-size: clamp(22px, 2.4vw, 30px); letter-spacing: -.035em; line-height: 1.3; }
.recording-subtitle { margin: 12px 0 0; color: var(--mb-text-secondary); font-size: 13px; line-height: 1.7; }
.recording-secondary { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 10px; }
.recording-secondary button { min-height: 34px; padding: 0 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; color: var(--mb-text-primary); background: transparent; font-size: 12px; }
.recording-secondary span { color: var(--mb-text-secondary); font-size: 11px; }
.recording-steps { display: flex; gap: 20px; margin: 32px 0 24px; padding: 0; list-style: none; }
.recording-steps li { display: flex; flex: 1; align-items: center; gap: 10px; padding: 0 0 16px; border-bottom: 1px solid var(--mb-glass-border); color: var(--mb-text-secondary); }
.recording-steps li[aria-current="step"] { border-color: var(--mb-accent); color: var(--mb-accent); }
.recording-steps span { font-size: 11px; font-variant-numeric: tabular-nums; }
.recording-steps strong { font-size: 13px; font-weight: 500; }
.recording-start { display: flex; min-height: 320px; align-items: center; flex-direction: column; justify-content: center; padding: 36px 24px; border: 1px solid var(--mb-glass-border); border-radius: 18px; background: var(--mb-bg-base); text-align: center; }
.recording-symbol { display: grid; width: 62px; height: 62px; place-items: center; margin-bottom: 22px; border: 1px solid var(--mb-glass-border); border-radius: 16px; color: var(--mb-accent); background: var(--mb-accent-soft); }
.recording-symbol svg { width: 29px; height: 29px; }
h3 { margin: 0; font-size: 22px; font-weight: 550; letter-spacing: -.02em; }
.recording-description { max-width: 410px; margin: 16px 0 24px; color: var(--mb-text-secondary); font-size: 13px; line-height: 1.9; }
.recording-primary { min-height: 40px; padding: 0 22px; border-radius: 9px; color: var(--mb-bg-deep); background: var(--mb-accent); font-size: 13px; font-weight: 600; }
.recording-status { margin: 20px 0 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.8; }
.recording-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 22px; }
.recording-footer p { margin: 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.8; }
.recording-footer button { min-height: 36px; padding: 0; color: var(--mb-accent); background: transparent; font-size: 12px; }
.recording-footer button:hover { color: var(--mb-accent-hover); }
@media (max-width: 900px) {
  .recording-view { padding: 24px 20px; }
  .recording-heading { flex-wrap: wrap; gap: 20px; }
  .recording-steps { gap: 12px; }
  .recording-start { padding: 28px 18px; }
}
.draft-detail,.draft-library{margin-top:24px;padding:24px;border:1px solid var(--mb-glass-border);border-radius:16px;background:var(--mb-bg-base)}.draft-toolbar,.track-actions,nav{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.draft-toolbar{margin:16px 0 24px}.draft-detail button,.draft-message button,.draft-library button{min-height:40px;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;color:var(--mb-text-primary);background:var(--mb-bg-base);font-size:13px}button:disabled{opacity:.5;cursor:not-allowed}.draft-id,.draft-estimate,.draft-evidence,.draft-message{font-size:12px;line-height:1.8;color:var(--mb-text-secondary);overflow-wrap:anywhere}.draft-evidence{padding:14px;border-left:2px solid var(--mb-accent);background:var(--mb-glass-clear)}fieldset{border:0;padding:0;min-width:0}.draft-fields{display:grid;grid-template-columns:1fr 1fr;gap:18px}.draft-fields label{display:grid;gap:8px;font-size:12px;margin:14px 0}.draft-fields input,.draft-fields select{box-sizing:border-box;width:100%;min-height:40px;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;color:var(--mb-text-primary);background:var(--mb-bg-base);font:inherit}.draft-tracks{list-style:none;padding:0}.draft-tracks li{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--mb-divider);padding:18px 0;font-size:13px;flex-wrap:wrap}.position{width:24px;font-variant-numeric:tabular-nums;color:var(--mb-text-secondary)}.track-title{flex:1;min-width:150px;overflow-wrap:anywhere}small{display:block;margin-top:8px;font-size:12px;line-height:1.6;color:var(--mb-text-secondary);overflow-wrap:anywhere}.draft-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:14px;margin-top:22px}.draft-library .draft-card{padding:18px;text-align:left}.draft-card span{font-size:15px;overflow-wrap:anywhere}.draft-card:hover{border-color:var(--mb-accent)}nav{justify-content:center;margin-top:20px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(max-width:700px){.draft-fields{grid-template-columns:1fr;gap:0}.draft-detail{padding:16px}.track-actions{width:100%;padding-left:38px}}
</style>
