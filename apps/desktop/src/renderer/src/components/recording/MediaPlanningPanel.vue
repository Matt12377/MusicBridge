<script setup lang="ts">
import { collectionModelLabel } from '../collection/collection-display'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { CollectionCopy, CollectionDetail, MasterDraft, MediaCandidate, MediaCandidateReason, MediaLayoutSpec, MediaPlan, MediaPreview, ReserveMediaRequest } from '@music-bridge/contracts'
import CollectionPhoto from '../collection/CollectionPhoto.vue'
import { assignedTrackIds, distributionBoundaries, makeDistribution } from './media-distribution-editor'
const props = defineProps<{ draft: MasterDraft; initialPlanId?: string; initialSplitAfter?: number; initialSpec?: MediaLayoutSpec; initialPhysicalId?: string; inline?: boolean }>()
const emit = defineEmits<{ close: []; changed: [plan: MediaPlan]; selected: [planId: string | null] }>()
const api = window.musicBridge
const dialog = ref<HTMLDialogElement>(), plans = shallowRef<readonly MediaPlan[]>([]), plan = shallowRef<MediaPlan>()
const preview = shallowRef<MediaPreview>(), selected = shallowRef<MediaCandidate>()
const copyDetail = shallowRef<CollectionDetail>(), selectedCopy = shallowRef<CollectionCopy>()
const copyOffset = ref(0), copyLoading = ref(false), copyError = ref(''), initialCopy = shallowRef<CollectionCopy>()
const freshSpec = (): MediaLayoutSpec => ({ format: 'cassette', splitAfter: Math.max(1, Math.ceil(props.draft.tracks.length / 2)), leadInMs: 0, tailMs: 0, defaultGapMs: props.draft.programType === 'compilation' ? 5000 : 0, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } })
const spec = ref<MediaLayoutSpec>(props.initialSpec ? structuredClone(props.initialSpec) : { ...freshSpec(), splitAfter: props.initialSplitAfter ?? freshSpec().splitAfter })
const savedSpec = ref(JSON.stringify(spec.value))
const allTrackIds = computed(() => props.draft.tracks.map(track => track.id))
const currentTrackIds = computed(() => assignedTrackIds(spec.value, allTrackIds.value))
const currentTracks = computed(() => currentTrackIds.value.map(id => props.draft.tracks.find(track => track.id === id)!))
const boundaries = computed(() => spec.value.distribution ? distributionBoundaries(spec.value.distribution) : [])
const groupLocked = computed(() => !!spec.value.distribution && plans.value.some(item => item.spec.distribution?.groupId === spec.value.distribution?.groupId))
const groupPlans = computed(() => plans.value.filter(item => item.spec.distribution?.groupId === spec.value.distribution?.groupId))
const selectionPrompt = ref<string | null>(null)
const segmentPrompt = ref<number | null>(null)
const pending = shallowRef<() => Promise<MediaPlan>>()
const pendingKind = ref<'save' | 'reserve' | 'release'>()
const loading = ref(false), busy = ref(false), confirmed = ref(false), releasing = ref(false), discarding = ref(false), error = ref(''), notice = ref('')
const pendingLabel = ref(''), previewSpec = ref(''), planId = ref('')
const blocked = computed(() => loading.value || busy.value || !!pending.value)
const dirty = computed(() => !!plan.value && JSON.stringify(plan.value.spec) !== JSON.stringify(spec.value))
const unsavedSpec = computed(() => JSON.stringify(spec.value) !== savedSpec.value)
const canReserve = computed(() => !!plan.value && !plan.value.reservation && !plan.value.requiresReview && !dirty.value && plan.value.inputFingerprint === preview.value?.inputFingerprint)
const canReserveCopy = computed(() => !!selected.value && !!selectedCopy.value && selected.value.status === 'recommended'
  && selectedCopy.value.skuId === selected.value.skuId && selectedCopy.value.packaging === selected.value.packaging
  && selectedCopy.value.available && ['blank', 'erased'].includes(selectedCopy.value.usage))
const visibleCopies = computed(() => copyDetail.value?.copies.items.filter(copy => copy.skuId === selected.value?.skuId && copy.packaging === selected.value?.packaging) ?? [])
const basis = { 'roon-estimate': 'Roon 估算', 'verified-sources': '已验证源时长', unavailable: '源不可用' }
const reasons: Record<MediaCandidateReason, string> = { 'capacity-unknown': '介质容量待确认', 'duration-unknown': '曲目时长未知', 'too-short': '至少一面容量不足', 'compatibility-unknown': '设备兼容性待确认', incompatible: '不兼容所选设备', 'collector-protected': '仅收藏，不用于录音', 'sealed-protected': '保留未拆封', 'minimum-reserve': '已到最低未拆保留量', 'source-unavailable': '已绑定源不可用或未确认', 'layout-conflict': '曲目分面约束冲突' }
const duration = (ms?: number): string => ms === undefined ? '时长未知' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
const cloneSpec = (): MediaLayoutSpec => JSON.parse(JSON.stringify(spec.value)) as MediaLayoutSpec
const trackTitle = (id: string): string => props.draft.tracks.find(t => t.id === id)?.metadata.title ?? '草稿曲目'
let alive = true, generation = 0, copyGeneration = 0, initialPlanApplied = false, initialPhysicalApplied = false
watch(spec, () => { ++generation; ++copyGeneration; preview.value = undefined; selected.value = undefined; selectedCopy.value = undefined; copyDetail.value = undefined; confirmed.value = false; initialPhysicalApplied = false; notice.value = '' }, { deep: true, flush: 'sync' })
function changeFormat(): void {
  if (groupLocked.value) return
  spec.value.splitAfter = spec.value.format === 'dat' ? 0 : Math.max(1, Math.ceil(currentTracks.value.length / 2))
  if (spec.value.format === 'dat') spec.value.rules = spec.value.rules.map(({ forceSide: _side, ...rule }) => rule)
  else delete spec.value.cueReminders
}
function setRule(id: string, key: 'keepWithNext' | 'sideOpener' | 'sideCloser' | 'forceSide' | 'gapAfterMs', value: unknown): void {
  if (groupLocked.value) return
  if (key === 'keepWithNext' && value === true && boundaries.value.includes(allTrackIds.value.indexOf(id) + 1)) {
    error.value = '此曲之后已有分盘边界。请先移除边界，再设置“与下一首保持相邻”。'
    return
  }
  const rules = spec.value.rules.filter(r => r.trackId !== id)
  const rule = { ...spec.value.rules.find(r => r.trackId === id), trackId: id, [key]: value }
  if (value === undefined || value === '') delete rule[key]
  spec.value.rules = [...rules, rule]
}
function beginDistribution(): void {
  if (blocked.value || allTrackIds.value.length < 2) return
  const legal = allTrackIds.value.slice(0, -1).map((id, index) => index + 1)
    .filter(index => !spec.value.rules.some(rule => rule.trackId === allTrackIds.value[index - 1] && rule.keepWithNext))
  if (!legal.length) { error.value = '所有相邻曲目都要求保持在同一盘，当前不能分盘。'; return }
  const midpoint = Math.ceil(allTrackIds.value.length / 2)
  const nearest = legal.reduce((best, index) => Math.abs(index - midpoint) < Math.abs(best - midpoint) ? index : best)
  const split = makeDistribution(allTrackIds.value, [nearest], crypto.randomUUID())
  if (!split) return
  plan.value = undefined; planId.value = ''; spec.value = { ...cloneSpec(), distribution: split,
    splitAfter: spec.value.format === 'dat' ? 0 : Math.max(1, Math.ceil(split.segmentSpecs[0]!.trackIds.length / 2)) }
  preview.value = undefined; savedSpec.value = JSON.stringify(freshSpec()); selectionPrompt.value = null
  emit('selected', null)
}
function toggleBoundary(after: number): void {
  const current = spec.value.distribution
  if (!current || groupLocked.value || blocked.value) return
  if (spec.value.rules.some(rule => rule.trackId === allTrackIds.value[after - 1] && rule.keepWithNext)) {
    error.value = '“与下一首保持相邻”的两曲不能跨盘。'; return
  }
  const points = boundaries.value.includes(after) ? boundaries.value.filter(value => value !== after) : [...boundaries.value, after].sort((a, b) => a - b)
  const next = makeDistribution(allTrackIds.value, points, current.groupId)
  if (!next) { error.value = '分盘至少需要两盘，最多二十盘，且每盘至少一首。'; return }
  spec.value.distribution = next
  if (spec.value.format === 'cassette') spec.value.splitAfter = Math.max(1, Math.ceil(next.segmentSpecs[0]!.trackIds.length / 2))
  error.value = ''
}
function resetToSinglePlan(): void {
  if (blocked.value) return
  plan.value = undefined; planId.value = ''; spec.value = freshSpec(); savedSpec.value = JSON.stringify(spec.value)
  preview.value = undefined; selectionPrompt.value = null; emit('selected', null)
}
function prepareNewSegment(index: number): void {
  const distribution = spec.value.distribution
  if (!distribution || blocked.value || index < 0 || index >= distribution.segmentSpecs.length) return
  const next = { ...cloneSpec(), distribution: { ...distribution, segmentIndex: index } }
  next.splitAfter = next.format === 'dat' ? 0 : Math.max(1, Math.ceil(distribution.segmentSpecs[index]!.trackIds.length / 2))
  plan.value = undefined; planId.value = ''; spec.value = next; savedSpec.value = JSON.stringify(freshSpec())
  preview.value = undefined; selectionPrompt.value = null; emit('selected', null)
  void calculate()
}
function requestNewSegment(index: number): void {
  if (unsavedSpec.value) { segmentPrompt.value = index; return }
  prepareNewSegment(index)
}
async function calculate(offset = 0): Promise<void> {
  if (busy.value || pending.value) return
  const token = ++generation, requestSpec = cloneSpec(); loading.value = true; error.value = ''; selected.value = undefined; selectedCopy.value = undefined; copyDetail.value = undefined; confirmed.value = false
  try {
    const result = await api.previewMediaPlan({ draftId: props.draft.id, spec: requestSpec, page: { offset, limit: 12 } })
    const current = plan.value ? await api.getMediaPlan(plan.value.id) : undefined
    if (alive && token === generation) { preview.value = result; previewSpec.value = JSON.stringify(requestSpec); if (current) plan.value = current }
  } catch { if (alive && token === generation) { preview.value = undefined; error.value = '无法计算当前分面。请核对曲目约束、时长或源文件状态后重试。' } }
  finally { if (alive) loading.value = false }
  if (alive && token === generation && preview.value && props.initialPhysicalId && !initialPhysicalApplied) await resolveInitialPhysical()
}
async function loadCopies(candidate: MediaCandidate, offset = 0): Promise<void> {
  const token = ++copyGeneration
  copyLoading.value = true; copyError.value = ''
  try {
    const result = await api.getCollectionModel(candidate.model.id, { offset, limit: 20 })
    if (!alive || token !== copyGeneration) return
    if (result.model.id !== candidate.model.id) throw new Error('库存型号身份不一致')
    copyDetail.value = result; copyOffset.value = offset
  } catch { if (alive && token === copyGeneration) copyError.value = '具体副本读取失败，不能据此判断没有磁带；请刷新库存详情。' }
  finally { if (alive && token === copyGeneration) copyLoading.value = false }
}
function chooseCandidate(candidate: MediaCandidate): void {
  selected.value = candidate; selectedCopy.value = undefined; confirmed.value = false
  void loadCopies(candidate)
}
function chooseCopy(copy: CollectionCopy): void {
  if (!selected.value || copy.skuId !== selected.value.skuId || copy.packaging !== selected.value.packaging || !copy.available || !['blank', 'erased'].includes(copy.usage)) return
  selectedCopy.value = copy; confirmed.value = false
}
async function resolveInitialPhysical(): Promise<void> {
  const physicalId = props.initialPhysicalId
  if (!physicalId || !preview.value || initialPhysicalApplied) return
  initialPhysicalApplied = true
  const token = ++copyGeneration; copyLoading.value = true; copyError.value = ''
  try {
    const exact = await api.getCollectionCopy(physicalId)
    if (!alive || token !== copyGeneration) return
    if (exact.copy.physicalId !== physicalId) throw new Error('单盘身份不一致')
    initialCopy.value = exact.copy
    if (!exact.copy.available || !['blank', 'erased'].includes(exact.copy.usage) || exact.copy.packaging === 'unknown') {
      copyError.value = '带入的单盘当前已不可用于新预留；原编号保留，请返回收藏核对。'
      return
    }
    let page = preview.value
    let candidate = page.candidates.items.find(item => item.skuId === exact.copy.skuId && item.packaging === exact.copy.packaging && item.model.id === exact.modelId)
    // 候选按型号分页，带入的永久 ID 可能不在首页；只读逐页查找，不改选其他磁带。
    for (let offset = page.candidates.limit; !candidate && offset < page.candidates.total; offset += 100) {
      page = await api.previewMediaPlan({ draftId: props.draft.id, spec: cloneSpec(), page: { offset, limit: 100 } })
      if (!alive || token !== copyGeneration || page.inputFingerprint !== preview.value?.inputFingerprint) return
      candidate = page.candidates.items.find(item => item.skuId === exact.copy.skuId && item.packaging === exact.copy.packaging && item.model.id === exact.modelId)
    }
    if (!candidate) { copyError.value = '带入的单盘不在当前分面与库存候选中；不会改用其他磁带。请核对容量、状态和保护策略。'; return }
    selected.value = candidate
    selectedCopy.value = exact.copy
    if (candidate.status !== 'recommended') copyError.value = '带入的单盘尚不满足当前分面或保护条件，不能预留。'
    await loadCopies(candidate)
  } catch { if (alive && token === copyGeneration) copyError.value = '带入的单盘实时资料读取失败，不能按旧修订预留；请返回收藏或重试。' }
  finally { if (alive && token === copyGeneration) copyLoading.value = false }
}
async function selectPlan(id: string, explicit = false): Promise<void> {
  if (busy.value || pending.value) return
  if (!id) {
    planId.value = ''; plan.value = undefined; preview.value = undefined; selected.value = undefined; selectedCopy.value = undefined; confirmed.value = false
    if (explicit) { spec.value = freshSpec(); savedSpec.value = JSON.stringify(spec.value); emit('selected', null) }
    initialPlanApplied = true; await calculate(); return
  }
  loading.value = true; error.value = ''
  try {
    const current = await api.getMediaPlan(id)
    if (!alive) return
    if (current.id !== id || current.draftId !== props.draft.id) throw new Error('规划与当前草稿不一致')
    plan.value = current; planId.value = current.id; spec.value = JSON.parse(JSON.stringify(current.spec)) as MediaLayoutSpec; savedSpec.value = JSON.stringify(current.spec)
    if (!explicit && !initialPlanApplied && props.initialSpec) {
      if (!current.spec.distribution) spec.value = structuredClone(props.initialSpec)
      else notice.value = '工作台未保存的分面未套用于已存分盘组，组边界保持原样；如需重新分盘，请新建组与规划。'
    } else if (!explicit && !initialPlanApplied && !current.spec.distribution && props.initialSplitAfter !== undefined && current.spec.format === 'cassette') spec.value.splitAfter = props.initialSplitAfter
    initialPlanApplied = true
    if (explicit) emit('selected', current.id)
    await calculate()
  } catch { if (alive) error.value = '已存规划暂时无法读取，请关闭后重试。' }
  finally { if (alive) loading.value = false }
}
function requestSelectPlan(id: string): void {
  if (blocked.value) return
  if (unsavedSpec.value) { selectionPrompt.value = id; return }
  void selectPlan(id, true)
}
function confirmSelection(): void {
  const id = selectionPrompt.value
  selectionPrompt.value = null
  if (id !== null) void selectPlan(id, true)
}
async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await api.listMediaPlans(props.draft.id)
    if (!alive) return
    if (result.draftId !== props.draft.id) throw new Error('规划列表与当前草稿不一致')
    plans.value = result.plans.filter(item => item.draftId === props.draft.id)
    const requested = initialPlanApplied ? planId.value : props.initialPlanId
    if (requested && plans.value.some(item => item.id === requested)) await selectPlan(requested)
    else {
      planId.value = ''; plan.value = undefined; initialPlanApplied = true; await calculate()
      if (requested) error.value = '本次选择的规划已不可用，请明确重选；不会自动切换其他规划。'
    }
  } catch { if (alive) error.value = '规划列表无法读取，不会把读取失败当成空列表。请重试。' }
  finally { if (alive) loading.value = false }
  if (alive && preview.value) await resolveInitialPhysical()
}
async function balance(): Promise<void> {
  if (blocked.value) return
  loading.value = true; error.value = ''
  try { const result = await api.balanceMediaPlan(props.draft.id, cloneSpec()); if (alive) { spec.value.splitAfter = result.splitAfter; await calculate() } }
  catch { if (alive) error.value = '无法找到满足当前约束的 A/B 分界。可手动调整，未知曲长需先核实。' }
  finally { if (alive) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    const result = await pending.value()
    if (!alive) return
    const savedPlan = pendingKind.value === 'save'
    pending.value = undefined; pendingKind.value = undefined; plan.value = result; planId.value = result.id; selected.value = undefined; selectedCopy.value = undefined; copyDetail.value = undefined; confirmed.value = false; releasing.value = false
    if (savedPlan) savedSpec.value = JSON.stringify(result.spec)
    if (savedPlan && props.initialPhysicalId) initialPhysicalApplied = false
    plans.value = [result, ...plans.value.filter(p => p.id !== result.id)]; notice.value = pendingLabel.value; emit('changed', result)
  } catch (cause) {
    if (alive) {
      const message = cause instanceof Error ? cause.message : ''
      if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST)\]/u.test(message)) { pending.value = undefined; selected.value = undefined; selectedCopy.value = undefined; copyDetail.value = undefined; confirmed.value = false; preview.value = undefined; error.value = '规划、源文件或库存已改变，本次操作未接受。请重新计算并重新选择同一盘；不会自动换带。' }
      else error.value = '操作回执尚未确认。请重试原操作，不会重复分配实体磁带。'
    }
  } finally { if (alive) busy.value = false }
  if (alive && !pending.value && !error.value) { await calculate(); if (pendingKind.value === undefined && props.initialPhysicalId && !initialPhysicalApplied) await resolveInitialPhysical() }
}
function mutate(operation: () => Promise<MediaPlan>, label: string, kind: 'save' | 'reserve' | 'release'): void { if (blocked.value) return; pending.value = operation; pendingLabel.value = label; pendingKind.value = kind; void retry() }
function save(): void {
  if (!preview.value || previewSpec.value !== JSON.stringify(spec.value)) return
  const request = { commandId: crypto.randomUUID(), draftId: props.draft.id, expectedDraftRevision: preview.value.draftRevision, inputFingerprint: preview.value.inputFingerprint, spec: cloneSpec(), ...(plan.value ? { planId: plan.value.id, expectedRevision: plan.value.revision } : {}) }
  mutate(() => api.saveMediaPlan(request), '规划已保存；尚未冻结或开始录音。', 'save')
}
function reserve(): void {
  if (!plan.value || !selected.value || !confirmed.value || !canReserve.value || selected.value.status !== 'recommended' || selectedCopy.value && !canReserveCopy.value) return
  const request: ReserveMediaRequest = { commandId: crypto.randomUUID(), planId: plan.value.id, expectedRevision: plan.value.revision, skuId: selected.value.skuId, packaging: selected.value.packaging,
    ...(selectedCopy.value ? { physicalId: selectedCopy.value.physicalId, expectedPhysicalRevision: selectedCopy.value.revision } : {}), userConfirmed: true }
  mutate(() => api.reserveMediaPlan(request), '已预留一盘；没有开始录音。', 'reserve')
}
function release(): void {
  if (!plan.value?.reservation || !releasing.value) return
  const request = { commandId: crypto.randomUUID(), planId: plan.value.id, expectedRevision: plan.value.revision, userConfirmed: true as const }
  mutate(() => api.releaseMediaPlan(request), '预留已取消，实体编号保留。', 'release')
}
function close(force = false): void {
  if (busy.value || pending.value) return
  if (unsavedSpec.value && !force) { discarding.value = true; return }
  if (!props.inline) dialog.value?.close()
  emit('close')
}
onMounted(async () => { await nextTick(); if (!props.inline) dialog.value?.showModal(); void load() })
onBeforeUnmount(() => { alive = false; ++generation; ++copyGeneration; if (!props.inline) dialog.value?.close() })
</script>

<template>
  <component :is="inline ? 'section' : 'dialog'" ref="dialog" class="media-panel" :class="{ 'is-inline': inline }" aria-labelledby="media-panel-title" @cancel.prevent="close()">
    <header><div><p class="kicker">录音准备 · 02</p><h2 id="media-panel-title">分面与选择磁带</h2><p>{{ draft.title }}</p></div><button :disabled="busy || !!pending" @click="close()">关闭</button></header>
    <p class="intro">先按曲长规划，再从现有库存中选择。浏览不占库存，明确预留才分配一盘；此处不冻结母版，也不操作录音设备。</p>
    <div v-if="initialPhysicalId" class="physical-intent" role="status"><strong>本次想用的单盘 {{ initialPhysicalId }}</strong><p>{{ initialCopy ? `实时状态：${initialCopy.available && ['blank', 'erased'].includes(initialCopy.usage) ? '可参与候选核对' : '目前不可用于新预留'} · 副本修订 ${initialCopy.revision}` : '正在核对永久 ID 与当前副本状态；旧页面的修订不作为预留依据。' }}</p><p v-if="plan?.reservation && plan.reservation.physicalId !== initialPhysicalId" class="warning">这份规划已预留 {{ plan.reservation.physicalId }}；不会自动释放或改用带入的单盘。</p><button type="button" :disabled="blocked || !preview || copyLoading" @click="initialPhysicalApplied = false; resolveInitialPhysical()">重新核对这盘</button></div>
    <label v-if="plans.length">已存规划<select :value="planId" :disabled="blocked" @change="requestSelectPlan(($event.target as HTMLSelectElement).value)"><option value="">未选已存规划；清空选择会计算单盘新规划</option><option v-for="item in plans" :key="item.id" :value="item.id">{{ item.spec.distribution ? `组 ${item.spec.distribution.groupId.slice(0, 8)} · 第 ${item.spec.distribution.segmentIndex + 1} 盘` : '单盘' }} · {{ item.id.slice(0, 8) }} · {{ item.reservation?.physicalId ?? '未预留' }}</option></select></label>
    <button v-if="plan" type="button" :disabled="blocked" @click="requestSelectPlan(plan.id)">将这份已存规划明确设为当前盘</button>
    <div v-if="selectionPrompt !== null" class="confirmation" role="alert"><p>当前设置尚未保存。切换只放弃页面草稿，不修改或释放原规划。</p><button type="button" :disabled="blocked" @click="confirmSelection">放弃未保存设置并切换</button><button type="button" :disabled="blocked" @click="selectionPrompt = null">继续编辑</button></div>
    <section aria-labelledby="media-distribution-title"><h3 id="media-distribution-title">分盘组</h3>
      <p class="muted">完整母版保持 {{ draft.tracks.length }} 首与原曲序；每盘单独规划、选带和保存。切换盘不自动保存、预留、释放或开始录音。</p>
      <button v-if="!spec.distribution && draft.tracks.length > 1" type="button" :disabled="blocked" @click="beginDistribution">新建多盘分配</button>
      <div v-if="spec.distribution"><p class="muted">组 {{ spec.distribution.groupId.slice(0, 8) }} · 当前第 {{ spec.distribution.segmentIndex + 1 }} / {{ spec.distribution.segmentSpecs.length }} 盘 · 本盘 {{ currentTracks.length }} 首。{{ groupLocked ? '此组已有已存规划：分盘边界与全局过渡规则已锁定。' : '尚未保存分盘组，可调整边界。' }}</p>
        <ol class="disk-list"><li v-for="(segment, index) in spec.distribution.segmentSpecs" :key="index"><strong>第 {{ index + 1 }} 盘 · {{ segment.trackIds.length }} 首</strong><small>{{ segment.trackIds.map(trackTitle).join(' → ') }}</small><span v-if="index === spec.distribution.segmentIndex" class="fit">当前编辑盘</span><div class="disk-actions"><button v-for="item in groupPlans.filter(value => value.spec.distribution?.segmentIndex === index)" :key="item.id" type="button" :disabled="blocked" @click="requestSelectPlan(item.id)">明确选择已存 {{ item.id.slice(0, 8) }}{{ item.reservation ? ` · ${item.reservation.physicalId}` : '' }}</button><button type="button" :disabled="blocked" @click="requestNewSegment(index)">拟新规划</button></div></li></ol>
        <div v-if="segmentPrompt !== null" class="confirmation" role="alert"><p>当前盘设置尚未保存。切到另一盘只保留组边界，当前盘个别设置将放弃；已存规划不变。</p><button type="button" :disabled="blocked" @click="prepareNewSegment(segmentPrompt!); segmentPrompt = null">放弃当前盘未保存设置</button><button type="button" :disabled="blocked" @click="segmentPrompt = null">继续编辑</button></div>
        <div v-if="!groupLocked" class="boundary-list" aria-label="分盘边界"><label v-for="(track, index) in draft.tracks.slice(0, -1)" :key="track.id" class="check"><input type="checkbox" :checked="boundaries.includes(index + 1)" :disabled="blocked || !!spec.rules.find(rule => rule.trackId === track.id)?.keepWithNext || boundaries.includes(index + 1) && boundaries.length === 1" @change="toggleBoundary(index + 1)">在第 {{ index + 1 }} 首《{{ track.metadata.title }}》之后分盘</label></div>
        <div class="actions"><button type="button" :disabled="blocked" @click="beginDistribution">重新分盘为新组和新规划</button><button type="button" :disabled="blocked" @click="resetToSinglePlan">放弃当前编辑，改为单盘新规划</button></div>
      </div>
    </section>
    <section aria-labelledby="media-layout-title"><h3 id="media-layout-title">分面规划</h3>
      <fieldset :disabled="blocked"><legend class="sr-only">分面设置</legend><div class="fields">
        <label>介质格式<select aria-label="介质格式" v-model="spec.format" :disabled="groupLocked" @change="changeFormat"><option value="cassette">Cassette · A/B 面</option><option value="dat">DAT · 连续 Program</option></select></label>
        <label v-if="spec.format === 'cassette'">A 面最后一首<select aria-label="A 面最后一首" v-model.number="spec.splitAfter"><option v-for="(track, index) in currentTracks" :key="track.id" :value="index + 1">{{ index + 1 }} · {{ track.metadata.title }}</option></select></label>
        <label>每面开头留白（毫秒）<input v-model.number="spec.leadInMs" type="number" min="0" max="600000" step="1000"></label>
        <label>每面结尾留白（毫秒）<input v-model.number="spec.tailMs" type="number" min="0" max="600000" step="1000"></label>
        <label>默认曲间间隔（毫秒）<input v-model.number="spec.defaultGapMs" type="number" min="0" max="60000" step="1000" :disabled="groupLocked"></label>
      </div><p class="muted">Compilation 默认 5 秒，演出与连续节目默认 0 秒；只在同面相邻曲目间添加，空面不添加留白。</p>
      <fieldset :disabled="groupLocked"><details class="rules"><summary>逐曲间隔与分面约束{{ groupLocked ? ' · 已锁定' : '' }}</summary><div v-for="(track, index) in currentTracks" :key="track.id" class="track-rule"><strong>{{ index + 1 }} · {{ track.metadata.title }}</strong><div class="rule-controls">
        <label v-if="allTrackIds.indexOf(track.id) < allTrackIds.length - 1"><input type="checkbox" :checked="spec.rules.find(r => r.trackId === track.id)?.keepWithNext ?? false" @change="setRule(track.id, 'keepWithNext', ($event.target as HTMLInputElement).checked)">与下一首保持相邻</label>
        <label><input type="checkbox" :checked="spec.rules.find(r => r.trackId === track.id)?.sideOpener ?? false" @change="setRule(track.id, 'sideOpener', ($event.target as HTMLInputElement).checked)">本面首曲</label>
        <label><input type="checkbox" :checked="spec.rules.find(r => r.trackId === track.id)?.sideCloser ?? false" @change="setRule(track.id, 'sideCloser', ($event.target as HTMLInputElement).checked)">本面末曲</label>
        <label v-if="spec.format === 'cassette'">指定面<select :value="spec.rules.find(r => r.trackId === track.id)?.forceSide ?? ''" @change="setRule(track.id, 'forceSide', ($event.target as HTMLSelectElement).value)"><option value="">不指定</option><option value="A">A 面</option><option value="B">B 面</option></select></label>
        <label>本曲之后间隔（毫秒，留空用默认）<input type="number" min="0" max="60000" step="1000" :value="spec.rules.find(r => r.trackId === track.id)?.gapAfterMs ?? ''" @input="setRule(track.id, 'gapAfterMs', ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"></label>
      </div></div></details></fieldset>
      <label v-if="spec.format === 'dat'" class="check cue-option"><input type="checkbox" :checked="spec.cueReminders === true" @change="spec.cueReminders = ($event.target as HTMLInputElement).checked ? true : undefined">显示人工 DAT Cue 时间提醒（不写 Track ID）</label>
      <div class="compatibility"><label class="check"><input v-model="spec.compatibility.confirmed" type="checkbox">确认所选设备支持这些介质</label><p class="muted">这是你的兼容性声明，不代表已通过声卡输出或设备实测。</p><div class="type-options"><label v-for="kind in (['I', 'II', 'III', 'IV'] as const)" v-show="spec.format === 'cassette'" :key="kind"><input v-model="spec.compatibility.cassetteTypes" type="checkbox" :value="kind">Type {{ kind }}</label><label v-if="spec.format === 'dat'"><input v-model="spec.compatibility.dat" type="checkbox">DAT</label></div></div>
      </fieldset>
      <div class="actions"><button :disabled="blocked" @click="calculate()">重新计算</button><button v-if="spec.format === 'cassette'" :disabled="blocked" @click="balance">辅助平衡 A/B</button><button class="primary" :disabled="blocked || !preview" @click="save">保存分面规划</button></div>
      <p v-if="!preview && !loading" class="muted">设置有变化或未完成计算，请重新计算；已选磁带不会自动更换。</p>
      <p v-if="plan?.requiresReview || dirty" class="warning" role="status">规划或输入已变化，需要重新计算并保存确认。原预留保留，不自动换带。</p>
    </section>
    <section v-if="preview" aria-labelledby="media-preview-title"><div class="section-heading"><h3 id="media-preview-title">逐面时长</h3><span class="basis">{{ basis[preview.sourceBasis] }}</span></div><p class="muted">{{ preview.sourceBasis === 'roon-estimate' ? '仍有曲目使用 Roon 元数据估算。绑定实际文件后须重新计算。' : preview.sourceBasis === 'verified-sources' ? '使用当前已验证文件的时长，正式冻结前仍需复核。' : '已有源不可用或映射未确认，不能用旧估算绕过。' }} 当前为毫秒规划，非执行帧时间线。</p>
      <div class="sides"><article v-for="side in preview.layout.sides" :key="side.name"><div class="section-heading"><h4>{{ side.name === 'Program' ? 'Program' : `${side.name} 面` }}</h4><strong class="time">{{ duration(side.durationMs) }}</strong></div><p class="muted">音乐 {{ duration(side.musicMs) }} · 间隔 {{ duration(side.gapMs) }} · 开头/结尾 {{ duration(side.leadInMs) }} / {{ duration(side.tailMs) }}</p><ol><li v-for="track in side.tracks" :key="track.trackId"><span>{{ trackTitle(track.trackId) }}</span><small>{{ duration(track.startMs) }} → {{ duration(track.endMs) }}</small></li></ol><p v-if="!side.tracks.length" class="muted">空面，无额外留白</p></article></div>
      <ul v-if="preview.layout.constraints.length" class="warning"><li v-for="constraint in preview.layout.constraints" :key="constraint">{{ constraint }}</li></ul>
    </section>
    <section v-if="plan?.reservation" class="reservation" aria-labelledby="media-reservation-title"><h3 id="media-reservation-title">这份规划的预留</h3><strong>{{ plan.reservation.physicalId }}</strong><p>已关联永久实体编号。保存新设置不会自动更换这盘磁带。</p><button :disabled="blocked" @click="releasing = true">取消这盘预留</button><div v-if="releasing" class="confirmation"><p>取消后恢复这盘原来的空白或已擦除状态，保留实体编号；不会返池或增加拥有总数。</p><button :disabled="blocked" @click="release">确认取消预留</button><button :disabled="blocked" @click="releasing = false">保留预留</button></div></section>
    <section v-if="preview" aria-labelledby="media-stock-title"><h3 id="media-stock-title">现有库存</h3><p class="muted">优先已拆空白，遵守封存保护与型号最低保留量。容量按磁带标称时长逐面估算，正式录音仍需容量和设备预检。</p><p v-if="!plan" class="muted">先保存分面规划，再选择磁带预留。</p><p v-if="!preview.candidates.items.length">当前没有这种格式的可用空白或已擦除库存。</p>
      <div class="candidates"><article v-for="item in preview.candidates.items" :key="`${item.skuId}-${item.packaging}`" :data-media-packaging="item.packaging" class="candidate"><div class="photo"><CollectionPhoto v-if="item.model.featuredPhoto" :photo="item.model.featuredPhoto" :alt="`${collectionModelLabel(item.model)} 实物照片`" interactive /><span v-else>尚无实物照片</span></div><div class="candidate-body"><h4>{{ collectionModelLabel(item.model) }}</h4><p>{{ item.model.edition }} · {{ item.model.year ?? '年份未知' }} · {{ item.model.tapeType }} · {{ item.lengthMinutes ?? '时长未知' }}{{ item.lengthMinutes ? ' 分钟' : '' }}</p><p>{{ item.packaging === 'opened' ? '已拆空白 / 已擦除' : '未拆封空白' }} · 可用 {{ item.availableCount }} · 可预留 {{ item.reservableCount }}</p><p :class="item.status === 'recommended' ? 'fit' : 'muted'">{{ item.status === 'recommended' ? '逐面适配 · 待正式预检' : item.status === 'pending' ? '待确认' : '不满足当前条件' }}</p><ul v-if="item.reasons.length" class="muted"><li v-for="reason in item.reasons" :key="reason">{{ reasons[reason] }}</li></ul><button :disabled="blocked" @click="chooseCandidate(item)">查看这类磁带与单盘</button></div></article></div>
      <nav v-if="preview.candidates.total > preview.candidates.limit" aria-label="库存推荐分页"><button :disabled="blocked || !preview.candidates.offset" @click="calculate(Math.max(0, preview.candidates.offset - 12))">上一页</button><span>{{ preview.candidates.offset + 1 }}–{{ preview.candidates.offset + preview.candidates.items.length }} / {{ preview.candidates.total }}</span><button :disabled="blocked || !preview.candidates.hasMore" @click="calculate(preview.candidates.offset + 12)">下一页</button></nav>
      <div v-if="selected" class="confirmation"><h4>选择 {{ collectionModelLabel(selected.model) }}</h4><p>{{ selected.lengthMinutes ?? '时长未知' }} 分钟 · {{ selected.packaging === 'opened' ? '已拆' : '未拆' }}。具体副本使用当前修订提交；自动分配则在事务中优先选已有编号的可用副本，必要时才从未编号库存建立一盘。</p>
        <p v-if="copyLoading" role="status">正在读取具体副本…</p><p v-if="copyError" class="warning" role="alert">{{ copyError }}</p>
        <div v-if="selectedCopy" class="selected-copy" role="status"><strong>本次指定 {{ selectedCopy.physicalId }}</strong><span>修订 {{ selectedCopy.revision }} · {{ selectedCopy.available ? '可用' : '不可用' }} · {{ selectedCopy.usage }}</span></div>
        <div v-if="visibleCopies.length" class="copy-list" aria-label="这一类的具体副本"><article v-for="copy in visibleCopies" :key="copy.physicalId"><div><strong>{{ copy.physicalId }}</strong><small>修订 {{ copy.revision }} · {{ copy.lengthMinutes ?? '未知' }} 分钟 · {{ copy.usage }}{{ copy.available ? '' : ' · 不可用' }}</small></div><button type="button" :disabled="blocked || !canReserve || selected.status !== 'recommended' || !copy.available || !['blank', 'erased'].includes(copy.usage)" @click="chooseCopy(copy)">指定这盘</button></article></div>
        <p v-else-if="copyDetail && !copyLoading" class="muted">本页没有符合这一规格的具体副本；若仍有可预留数量，可明确选择自动分配可用库存。</p>
        <nav v-if="copyDetail && copyDetail.copies.total > 20" aria-label="具体副本分页"><button type="button" :disabled="copyLoading || copyOffset === 0" @click="loadCopies(selected, Math.max(0, copyOffset - 20))">上一页</button><span>{{ copyOffset + 1 }}–{{ copyOffset + copyDetail.copies.items.length }} / {{ copyDetail.copies.total }}</span><button type="button" :disabled="copyLoading || copyOffset + 20 >= copyDetail.copies.total" @click="loadCopies(selected, copyOffset + 20)">下一页</button></nav>
        <button type="button" :disabled="blocked || !canReserve || selected.status !== 'recommended' || selected.reservableCount < 1" @click="selectedCopy = undefined; confirmed = false">改为自动分配可用库存</button>
        <label class="check"><input v-model="confirmed" type="checkbox" :disabled="blocked || !canReserve || selected.status !== 'recommended' || !!selectedCopy && !canReserveCopy">我确认{{ selectedCopy ? `预留指定的 ${selectedCopy.physicalId}` : '自动分配并预留一盘可用库存' }}，暂不开始录音</label><div class="actions"><button class="primary" :disabled="blocked || !confirmed || !canReserve || selected.status !== 'recommended' || !!selectedCopy && !canReserveCopy" @click="reserve">{{ selectedCopy ? '确认预留这盘' : '确认自动分配预留' }}</button><button :disabled="blocked" @click="selected = undefined; selectedCopy = undefined; confirmed = false">取消选择</button></div></div>
    </section>
    <div v-if="discarding" class="confirmation" role="alert"><p>当前分面设置尚未保存。离开只放弃页面草稿，不删除已存规划或预留。</p><button type="button" @click="close(true)">放弃未保存分面并返回工作台</button><button type="button" @click="discarding = false">继续编辑</button></div>
    <p v-if="loading" role="status">正在核对分面和库存…</p><p v-if="notice" class="fit" role="status">{{ notice }}</p><p v-if="error" class="warning" role="alert">{{ error }} <button v-if="pending" :disabled="busy" @click="retry">重试原操作</button><button v-else :disabled="blocked" @click="plan ? calculate() : load()">重试读取</button></p>
    <footer>未保存的设置离开后放弃，已保存规划与预留保留。估算和预留都不等于版本冻结或输出许可；帧级编译在执行准备中处理，正式输出取决于当前真实准入检查。</footer>
  </component>
</template>

<style scoped>
.media-panel{box-sizing:border-box;width:min(960px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:28px;border:1px solid var(--mb-glass-border);border-radius:18px;color:var(--mb-text-primary);background:var(--mb-bg-base);font:inherit;overflow:auto;overscroll-behavior:contain}.media-panel::backdrop{background:rgb(0 0 0 / .6)}header,.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}header{align-items:flex-start}.kicker{font-size:11px;letter-spacing:2px;color:var(--mb-text-secondary);margin:0 0 10px}h2{font-size:24px;margin:0}h3{font-size:17px;margin:0 0 16px}h4{font-size:14px;margin:0}p{font-size:13px;line-height:1.7;overflow-wrap:anywhere}.intro,.muted,footer{color:var(--mb-text-secondary)}section{border-top:1px solid var(--mb-divider);margin-top:24px;padding-top:24px}fieldset{border:0;padding:0;margin:0;min-width:0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:1.6}input:not([type=checkbox]),select{box-sizing:border-box;min-width:0;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit}input[type=checkbox]{accent-color:var(--mb-accent);width:16px;height:16px;margin:0;flex-shrink:0}button{min-height:44px;padding:9px 15px;border:1px solid var(--mb-glass-border);border-radius:9px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:12px;cursor:pointer}button:hover:not(:disabled){border-color:var(--mb-accent)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}.primary{border-color:var(--mb-accent);color:var(--mb-accent)}.actions,.type-options,.rule-controls,nav{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:16px}.check,.type-options label,.rule-controls label:has(input[type=checkbox]){flex-direction:row;align-items:center;min-height:44px}.compatibility,.rules{margin-top:20px;padding-top:16px;border-top:1px solid var(--mb-divider)}summary{padding:12px 0;font-size:13px;cursor:pointer}.track-rule{padding:16px 0;border-bottom:1px solid var(--mb-divider);font-size:13px;overflow-wrap:anywhere}.rule-controls label{flex:1;min-width:140px}.sides,.candidates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.sides article,.candidate,.reservation,.confirmation{padding:18px;border:1px solid var(--mb-glass-border);border-radius:12px;background:var(--mb-bg-base);min-width:0}.sides ol{padding-left:20px;font-size:13px;line-height:1.6}.sides li{margin:12px 0;overflow-wrap:anywhere}small{display:block;font-size:11px;color:var(--mb-text-secondary);font-variant-numeric:tabular-nums}.time{font-size:16px;font-variant-numeric:tabular-nums;white-space:nowrap}.basis{font-size:12px;color:var(--mb-text-secondary)}.candidate{padding:0;overflow:hidden}.photo{height:155px;background:var(--mb-bg-elevated);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--mb-text-secondary)}.candidate-body{padding:18px}.candidate-body p{margin:8px 0}.candidate-body ul{padding-left:18px;font-size:12px;line-height:1.7}.candidate-body button{margin-top:12px}.fit{color:var(--mb-text-primary)}.warning{color:var(--mb-text-primary);font-size:13px;line-height:1.8;background:var(--mb-bg-base);padding:12px;border-left:3px solid var(--mb-accent)}.confirmation{margin-top:18px}nav{justify-content:center;font-size:12px}footer{margin-top:24px;font-size:12px;line-height:1.8}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(max-width:760px){.media-panel{padding:20px}.fields,.sides,.candidates{grid-template-columns:1fr}h2{font-size:20px}.section-heading{flex-wrap:wrap}}
.media-panel.is-inline{position:static;display:block;box-sizing:border-box;width:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:transparent;overflow:visible}
.disk-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0;list-style:none}.disk-list li{min-width:0;padding:14px;border:1px solid var(--mb-glass-border);border-radius:10px}.disk-list strong,.disk-list small{display:block}.disk-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.disk-actions button{min-height:44px}.boundary-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 16px;margin-top:16px}.boundary-list .check,.cue-option{flex-direction:row;align-items:center;min-height:44px}.cue-option{margin-top:16px}@media(max-width:760px){.disk-list,.boundary-list{grid-template-columns:1fr}}
</style>
