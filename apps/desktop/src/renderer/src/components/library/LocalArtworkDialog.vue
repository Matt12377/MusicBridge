<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LocalArtworkCandidate, LocalArtworkOrigin, LocalArtworkSearchProvider } from '@music-bridge/contracts'
import SafeArtwork from '../SafeArtwork.vue'
import { localArtworkCandidatePresentation, type useLocalArtwork } from '../../composables/application/useLocalArtwork'

const props = defineProps<{ session: ReturnType<typeof useLocalArtwork> }>()
const emit = defineEmits<{ close: []; applied: [] }>()
const dialog = ref<HTMLDialogElement>(), dragDepth = ref(0), dropError = ref(''), expandedCreate = ref(false)
const context = computed(() => props.session.context.value), target = computed(() => props.session.target.value)
const busy = computed(() => props.session.busy.value), lookupBusy = computed(() => props.session.lookupBusy.value)
const unknown = computed(() => !!props.session.pendingApply.value || !!props.session.pendingEdition.value)
const locked = computed(() => busy.value || unknown.value)
const candidates = computed(() => props.session.filteredCandidates.value)
const compared = computed(() => props.session.comparisonCandidates.value)
const chosen = computed(() => props.session.selectedCandidate.value)
const error = computed(() => dropError.value || props.session.error.value), notice = computed(() => props.session.notice.value)
const query = computed({ get: () => props.session.query.value, set: value => props.session.filter(value) })
const remoteQuery = computed({ get: () => props.session.remoteQuery.value, set: value => { props.session.remoteQuery.value = value } })
const remoteEnabled = computed(() => props.session.remoteEnabled.value)
const remoteProvider = computed({ get: () => props.session.remoteProvider.value, set: (value: LocalArtworkSearchProvider) => { props.session.remoteProvider.value = value } })
const searchLabel = computed(() => remoteProvider.value === 'cover-art-archive-v1' ? '查找音乐封面' : '搜索 CC0 补充图库')
const origin = computed({ get: () => props.session.origin.value, set: (value: LocalArtworkOrigin | 'all') => props.session.filter(query.value, value) })
const editionTitle = computed({ get: () => props.session.editionTitle.value, set: value => { props.session.editionTitle.value = value } })
const selectionMode = computed(() => context.value?.selection?.mode === 'manual' ? '人工选图' : '本地默认封面')
let returnFocus: HTMLElement | null = null
const bytesLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
const presentation = localArtworkCandidatePresentation
const originLabel = (candidate: LocalArtworkCandidate) => presentation(candidate).origin
const isExpired = (candidate: LocalArtworkCandidate) => Date.parse(candidate.expiresAt) <= Date.now()

function close(): void { props.session.close(); emit('close') }
async function switchEdition(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  if (!context.value || !value || locked.value) return
  dropError.value = ''; expandedCreate.value = false
  await props.session.open(context.value.trackId, value)
}
async function drop(event: DragEvent): Promise<void> {
  dragDepth.value = 0; dropError.value = ''
  if (locked.value || !target.value) return
  const files = event.dataTransfer?.files
  if (!files || files.length !== 1) { dropError.value = '请每次拖入一张 PNG 或 JPEG 图片。'; return }
  const file = files.item(0)
  if (file) await props.session.drop(file)
}
function keydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !dialog.value) return
  const items = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'))
    .filter(element => !element.hidden && element.getClientRects().length > 0)
  if (items.length === 0) { event.preventDefault(); dialog.value.focus(); return }
  const first = items[0]!, last = items[items.length - 1]!, active = document.activeElement
  if (event.shiftKey && (active === first || active === dialog.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || active === dialog.value)) { event.preventDefault(); first.focus() }
}
watch(() => props.session.appliedCount.value, (value, previous) => { if (value > previous) emit('applied') })
onMounted(async () => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  await nextTick()
  dialog.value?.querySelector<HTMLButtonElement>('[data-dialog-close]')?.focus()
})
onBeforeUnmount(() => { dialog.value?.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }) })
</script>

<template>
  <dialog ref="dialog" class="local-artwork-dialog" aria-labelledby="local-artwork-title" aria-describedby="local-artwork-policy" tabindex="-1" @cancel.prevent="close" @keydown="keydown">
    <header>
      <div><p class="eyebrow">本地音乐库 · 独立发行</p><h2 id="local-artwork-title">选择封面</h2></div>
      <button type="button" data-dialog-close aria-label="关闭封面选图" @click="close">关闭</button>
    </header>
    <p id="local-artwork-policy" class="policy">音乐封面按 MusicBrainz 发行记录查找 Cover Art Archive 图片；CC0 补充图库需主动选择。远程请求仅在你点击搜索时进行。选图仅用于 MusicBridge 显示，不改写源文件，也不用于发行合并或音质判定。</p>

    <p v-if="session.loading.value" class="status" role="status">正在读取封面与独立发行…</p>
    <template v-if="context">
      <section class="edition-section" aria-label="独立发行选择">
        <label v-if="context.editions.length" class="edition-label">所属独立发行
          <select :value="target?.editionId ?? ''" :disabled="locked" @change="switchEdition">
            <option v-if="!target" value="" disabled>请明确选择发行</option>
            <option v-for="edition in context.editions" :key="edition.id" :value="edition.id" :title="`发行身份 ${edition.id}，修订 ${edition.revision}`">{{ edition.title }}{{ edition.edition ? ` · ${edition.edition}` : '' }} · {{ edition.id.slice(-8) }}</option>
          </select>
        </label>
        <p v-if="!target" class="muted">{{ context.editions.length ? '请从列表中选择封面的独立发行，同名条目保留各自身份。' : '此曲目尚无独立发行。先建立独立发行用于选图，名称相同也不会自动合并。' }}</p>
        <button v-if="context.editions.length" type="button" :disabled="locked" :aria-expanded="expandedCreate" @click="expandedCreate = !expandedCreate">建立另一独立发行</button>
        <form v-if="!context.editions.length || expandedCreate" class="create-edition" @submit.prevent="session.createEdition()">
          <label>独立发行名称<input v-model="editionTitle" maxlength="512" placeholder="按实际发行填写名称" :disabled="locked" required></label>
          <button type="submit" :disabled="locked || !editionTitle.trim()">{{ session.creating.value ? '正在建立…' : '建立独立发行用于选图' }}</button>
        </form>
      </section>

      <template v-if="target">
        <section class="current-selection" aria-label="当前已保存封面">
          <SafeArtwork class="current-artwork" :src="context.selection?.candidate?.display.dataUrl" alt="当前已保存的发行封面" loading="eager" />
          <div><h3>当前已保存 · {{ selectionMode }}</h3><p class="muted">{{ context.selection?.candidate ? presentation(context.selection.candidate).label : '尚无可显示封面，可查找候选或手选图片。' }}</p><p v-if="context.selection?.candidate?.origin === 'provider'" class="muted">{{ presentation(context.selection.candidate).origin }}<span class="source-page">{{ presentation(context.selection.candidate).notice }}</span></p><p class="muted">保存前继续使用当前封面。恢复默认会建立新的选择修订。</p></div>
        </section>

        <section class="candidate-section" aria-label="封面候选" :aria-busy="lookupBusy">
          <form class="remote-search" aria-label="查找音乐封面或CC0补充图片" @submit.prevent="dropError = ''; session.searchRemote()">
            <h3>远程候选来源</h3>
            <label class="provider-select">查找来源<select v-model="remoteProvider" :disabled="locked"><option v-for="provider in session.remoteProviders.value" :key="provider.value" :value="provider.value" :disabled="!provider.enabled">{{ provider.label }}{{ provider.enabled ? '' : '（当前不可用）' }}</option></select></label>
            <p class="muted">{{ remoteProvider === 'cover-art-archive-v1' ? '按发行与艺人查找音乐封面，同名不同发行会分别列出。CAA 审核不代表图片许可，封面权利状态仍未核实。' : 'Wikimedia Commons 是补充图库，仅显示逐文件通过 CC0 1.0 检查的图片。' }}输入或更改来源、关键词不会自动联网。</p>
            <div class="remote-controls"><label>{{ remoteProvider === 'cover-art-archive-v1' ? '发行 / 艺人关键词' : '补充图片关键词' }}<input v-model="remoteQuery" type="search" maxlength="80" autocomplete="off" :placeholder="remoteProvider === 'cover-art-archive-v1' ? '发行名称与艺人' : '补充图片关键词'" :disabled="locked || !remoteEnabled" required aria-describedby="remote-artwork-query-hint"></label><button type="submit" :disabled="locked || !remoteEnabled || !remoteQuery.trim()">{{ session.remoteSearching.value ? '正在查找…' : searchLabel }}</button></div>
            <p id="remote-artwork-query-hint" class="muted">最多 80 个字符，不接受网址。{{ remoteEnabled ? '搜索结果还需明确选中并保存。' : '当前远程查图尚未启用，可使用下方本地查找或手选图片。' }}</p>
          </form>
          <div class="actions">
            <button type="button" :disabled="locked" @click="dropError = ''; session.search()">{{ session.searching.value ? '正在查找本地候选…' : '查找本地候选' }}</button>
            <button type="button" :disabled="locked" @click="dropError = ''; session.pick()">{{ session.picking.value ? '等待文件选择…' : '选择 PNG / JPEG' }}</button>
            <button v-if="lookupBusy" type="button" @click="session.cancelLookup()">停止候选读取</button>
          </div>
          <p v-if="session.remoteSearching.value" class="status" role="status">正在读取 {{ session.providerLabels[remoteProvider] }}候选，当前封面保留…</p>
          <div class="drop-zone" :class="{ dragging: dragDepth > 0, unavailable: locked }" @dragenter.prevent="dragDepth++" @dragleave.prevent="dragDepth = Math.max(0, dragDepth - 1)" @dragover.prevent @drop.prevent="drop">
            <p>{{ session.importing.value ? '正在读取图片…' : '也可拖入一张图片，PNG / JPEG，最多 4 MiB' }}</p>
            <span>展示副本为 JPEG；原图与展示尺寸、Hash 分别列出。</span>
          </div>
          <p v-if="context.status === 'source-unavailable'" class="status">源目录当前不可用，已保存封面仍保留；可恢复目录后查找或手选图片。</p>
          <div class="filters">
            <label>筛选候选<input v-model="query" type="search" placeholder="来源名称或原图 Hash" aria-label="筛选封面候选"></label>
            <label>来源<select v-model="origin"><option value="all">全部来源</option><option value="local-independent">本地独立封面</option><option value="embedded">文件内嵌封面</option><option value="manual">手选图片</option><option value="provider">远程候选</option></select></label>
          </div>
          <p v-if="!candidates.length" class="muted">{{ context.candidates.length ? '没有符合当前筛选的候选。' : '尚无候选，可查找本地封面、主动查找远程候选或手选图片。' }}</p>
          <div class="candidate-grid">
            <article v-for="candidate in candidates" :key="candidate.id" class="candidate-card" :class="{ selected: candidate.id === session.selectedCandidateId.value }">
              <button type="button" class="candidate-choice" :aria-label="`选择${presentation(candidate).label}`" :aria-pressed="candidate.id === session.selectedCandidateId.value" :disabled="locked || isExpired(candidate)" @click="session.selectCandidate(candidate.id)">
                <SafeArtwork class="candidate-artwork" :src="candidate.display.dataUrl" :alt="presentation(candidate).label" loading="eager" />
                <strong>{{ presentation(candidate).label }}</strong><span>{{ originLabel(candidate) }}</span>
              </button>
              <p class="candidate-state">{{ isExpired(candidate) ? '候选已过期，请重新读取' : candidate.id === session.selectedCandidateId.value ? '待保存选图' : candidate.origin === 'provider' ? presentation(candidate).notice : '本地只读 · 用户提供' }}</p>
              <dl class="image-info"><div><dt>原图</dt><dd>{{ candidate.original.width }} × {{ candidate.original.height }} · {{ candidate.original.mime === 'image/png' ? 'PNG' : 'JPEG' }} · {{ bytesLabel(candidate.original.bytes) }}</dd></div><div><dt>展示副本</dt><dd>{{ candidate.display.width }} × {{ candidate.display.height }} · JPEG · {{ bytesLabel(candidate.display.bytes) }}</dd></div></dl>
              <details><summary>原图 / 展示 Hash</summary><p>原图 SHA-256 <code>{{ candidate.original.sha256 }}</code></p><p>展示 SHA-256 <code>{{ candidate.display.sha256 }}</code></p></details>
              <details v-if="candidate.origin === 'provider'" class="provider-source"><summary>候选来源与权利记录</summary><dl><div v-for="field in presentation(candidate).fields" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.text }}</dd></div></dl><p>{{ presentation(candidate).notice }}</p></details>
              <label class="compare-check"><input type="checkbox" :checked="session.comparisonIds.value.includes(candidate.id)" :disabled="!session.comparisonIds.value.includes(candidate.id) && session.comparisonIds.value.length >= 2" @change="session.toggleComparison(candidate.id)">加入比较</label>
            </article>
          </div>
        </section>

        <section v-if="compared.length" class="comparison" aria-label="候选图片比较">
          <h3>候选比较 · {{ compared.length }} / 2</h3>
          <div class="comparison-grid"><article v-for="candidate in compared" :key="candidate.id"><SafeArtwork class="comparison-artwork" :src="candidate.display.dataUrl" :alt="`比较：${presentation(candidate).label}`" loading="eager" /><strong>{{ presentation(candidate).label }}</strong><span>{{ originLabel(candidate) }} · 原图 {{ candidate.original.width }} × {{ candidate.original.height }}</span><span v-if="candidate.origin === 'provider'">{{ presentation(candidate).notice }}</span><code>{{ candidate.original.sha256 }}</code></article></div>
        </section>
      </template>
    </template>

    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message" role="status">{{ notice }}</p>
    <p v-if="unknown" class="muted">原操作结果尚未确认。关闭只结束本地等待，已派发的保存或建立发行无法在这里撤销。</p>
    <footer>
      <div class="footer-actions"><button v-if="unknown" type="button" :disabled="busy" @click="dropError = ''; session.reconcile()">重新读取核对</button><button v-else type="button" :disabled="busy" @click="dropError = ''; session.refresh()">重新读取</button><button v-if="target" type="button" :disabled="!session.canRestoreDefault.value" @click="session.restoreDefault()">恢复本地默认</button></div>
      <div class="footer-actions"><button type="button" @click="close">{{ unknown || session.applying.value || session.creating.value ? '关闭' : '取消' }}</button><button v-if="target" type="button" class="primary" :disabled="!session.canApply.value" :aria-label="chosen ? `保存选图：${chosen.sourceLabel}` : '保存选图'" @click="session.apply()">{{ session.applying.value ? '正在保存…' : '保存选图' }}</button></div>
    </footer>
  </dialog>
</template>

<style scoped>
.local-artwork-dialog { box-sizing: border-box; width: min(900px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 26px; border: 1px solid var(--mb-glass-border); border-radius: 20px; color: var(--mb-text-primary); background: var(--mb-glass-clear); backdrop-filter: blur(30px) saturate(1.2); -webkit-backdrop-filter: blur(30px) saturate(1.2); box-shadow: 0 24px 80px #0003; }
.local-artwork-dialog::backdrop { background: #10182866; }
header, footer, .actions, .footer-actions, .edition-section { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
header { margin-bottom: 18px; } h2 { margin: 0; font-size: 24px; } h3 { margin: 0 0 8px; font-size: 15px; }
.eyebrow { margin: 0 0 6px; font-size: 12px; color: var(--mb-text-secondary); }
.policy, .muted, .status { font-size: 13px; line-height: 1.8; color: var(--mb-text-secondary); }
.policy { margin-bottom: 22px; } .status { padding: 10px 12px; border: 1px solid var(--mb-glass-border); border-radius: 10px; }
.edition-section { padding: 16px 0; border-top: 1px solid var(--mb-glass-border); border-bottom: 1px solid var(--mb-glass-border); }
.edition-section > .muted { margin: 0; width: 100%; } .edition-label { flex: 1; min-width: min(320px, 100%); }
label { display: grid; gap: 7px; font-size: 12px; } input, select, button { color: var(--mb-text-primary); font: inherit; }
input:not([type=checkbox]), select { box-sizing: border-box; width: 100%; min-height: 42px; padding: 8px 10px; border: 1px solid var(--mb-glass-border); border-radius: 9px; background: var(--mb-glass-clear); }
select option { background: var(--mb-bg-base); color: var(--mb-text-primary); }
button { min-height: 42px; padding: 9px 14px; border: 1px solid var(--mb-glass-border); border-radius: 9px; background: var(--mb-glass-clear); font-size: 13px; cursor: pointer; transition: transform 140ms ease-out; }
button:active:not(:disabled) { transform: scale(.98); } button.primary { background: var(--mb-accent); color: var(--mb-on-accent); }
:disabled { opacity: .5; cursor: not-allowed; } :is(button, input, select, summary):focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
.create-edition { display: flex; align-items: end; gap: 12px; width: 100%; flex-wrap: wrap; } .create-edition label { flex: 1; min-width: min(240px, 100%); }
.current-selection { display: flex; align-items: center; gap: 18px; padding: 22px 0; } .current-selection p { margin: 5px 0; }
.current-artwork { width: 100px; height: 100px; flex: none; border-radius: 10px; }
.candidate-section { padding: 4px 0 18px; } .actions { justify-content: flex-start; }
.remote-search { margin-bottom: 18px; padding: 16px; border: 1px solid var(--mb-glass-border); border-radius: 12px; }
.remote-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; } .remote-controls label { flex: 1; min-width: min(240px, 100%); } .remote-search .muted { margin: 8px 0; }
.provider-select { max-width: 460px; margin: 12px 0; }
.source-page { display: block; overflow-wrap: anywhere; font-size: 11px; } .provider-source dl { display: grid; gap: 10px; }
.drop-zone { margin: 14px 0; padding: 15px; border: 1px dashed var(--mb-glass-border); border-radius: 11px; text-align: center; }
.drop-zone p { margin: 0 0 6px; font-size: 13px; } .drop-zone span { font-size: 12px; color: var(--mb-text-secondary); } .drop-zone.dragging:not(.unavailable) { border-color: var(--mb-accent); background: var(--mb-glass-clear); }
.filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, .5fr); gap: 12px; margin: 16px 0; }
.candidate-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.candidate-card { min-width: 0; padding: 14px; border: 1px solid var(--mb-glass-border); border-radius: 13px; } .candidate-card.selected { border-color: var(--mb-accent); box-shadow: inset 0 0 0 1px var(--mb-accent); }
.candidate-choice { display: grid; grid-template-columns: 90px minmax(0, 1fr); column-gap: 14px; width: 100%; padding: 0; text-align: left; border: 0; background: transparent; border-radius: 6px; }
.candidate-artwork { grid-row: 1 / 3; width: 90px; height: 90px; border-radius: 9px; } .candidate-choice strong { align-self: end; font-size: 13px; overflow-wrap: anywhere; } .candidate-choice > span:not(.safe-artwork) { align-self: start; margin-top: 8px; font-size: 12px; color: var(--mb-text-secondary); }
.candidate-state { font-size: 12px; color: var(--mb-text-secondary); margin: 13px 0; }
.image-info { display: grid; gap: 8px; font-size: 12px; } dt { color: var(--mb-text-secondary); } dd { margin: 3px 0 0; overflow-wrap: anywhere; }
details { font-size: 11px; line-height: 1.7; margin: 12px 0; } summary { cursor: pointer; color: var(--mb-text-secondary); } code { display: block; overflow-wrap: anywhere; word-break: break-all; font-size: 10px; user-select: text; }
.compare-check { display: flex; align-items: center; gap: 8px; } input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--mb-accent); }
.comparison { border-top: 1px solid var(--mb-glass-border); padding-top: 18px; } .comparison-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; } .comparison article { display: grid; gap: 8px; min-width: 0; font-size: 12px; } .comparison article > span:not(.safe-artwork) { color: var(--mb-text-secondary); }
.comparison-artwork { width: 100%; aspect-ratio: 1; max-height: 260px; border-radius: 12px; }
:deep(.safe-artwork) { position: relative; display: grid; place-items: center; overflow: hidden; background: var(--mb-glass-clear); } :deep(.safe-artwork img) { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; } :deep(.artwork-fallback) { color: var(--mb-text-secondary); font-size: 26px; }
.message { margin: 16px 0 0; padding: 12px 14px; border: 1px solid var(--mb-glass-border); border-radius: 10px; font-size: 13px; line-height: 1.8; } .error { border-color: var(--mb-accent); }
footer { position: sticky; bottom: -26px; margin: 20px -26px -26px; padding: 16px 26px; border-top: 1px solid var(--mb-glass-border); background: var(--mb-glass-clear); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); }
@media (hover: hover) and (pointer: fine) { button:not(:disabled):hover { border-color: var(--mb-accent); } }
@media (max-width: 600px) { .local-artwork-dialog { padding: 20px; } .candidate-grid { grid-template-columns: 1fr; } .filters { grid-template-columns: 1fr; } .current-artwork { width: 78px; height: 78px; } .comparison-grid { gap: 10px; } footer { position: static; margin: 20px -20px -20px; padding: 14px 20px; } .footer-actions { flex: 1; } .footer-actions button { flex: 1; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } button:active:not(:disabled) { transform: none; } }
</style>
