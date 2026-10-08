<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { LocalOrganizerItem, LocalOrganizerState } from '@music-bridge/contracts'
import type { OrganizerDraftAction, useLocalOrganizer } from '../../composables/application/useLocalOrganizer.js'

const props = defineProps<{ session: ReturnType<typeof useLocalOrganizer>; sourceWritesAvailable?: boolean }>()
const { effectiveValue: organizerEffective, issueMessage: organizerIssueMessage, stateLabels: organizerStateLabels, formatValue: organizerValue } = props.session
const emit = defineEmits<{ 'open-outbox': []; 'return-focus': []; 'source-writes': [] }>()
const dialog = ref<HTMLDialogElement>(), heading = ref<HTMLElement>(), groupingEdition = ref(''), groupingReason = ref(''), groupingError = ref('')
const plan = computed(() => props.session.plan.value), locked = computed(() => props.session.draftLocked.value)
const fields = [{ key: 'title', label: '标题' }, { key: 'artist', label: '艺术家' }, { key: 'album', label: '专辑' }, { key: 'year', label: '年份' }, { key: 'disc', label: '碟号' }, { key: 'track', label: '曲序' }] as const
const stateLabel = (state: LocalOrganizerState) => organizerStateLabels[state]
const resultLabel = { planned: '尚未保存', applied: '已保存', 'not-written': '未写入', unknown: '结果未知' }
let returnFocus: HTMLElement | null = null
const action = (event: Event) => (event.target as HTMLSelectElement).value as OrganizerDraftAction
const input = (event: Event) => (event.target as HTMLInputElement | HTMLTextAreaElement).value
const title = (item: LocalOrganizerItem) => organizerValue(organizerEffective(item, 'title'), '未提供标题')
const versionValue = (value: string | undefined) => organizerValue(value, '未添加说明')
const groupingValue = (item: LocalOrganizerItem, after = false) => {
  const values = (after ? item.after : item.before).annotations.groupingSuggestions
  return values?.length ? values.map(value => `${props.session.editions.value.find(edition => edition.id === value.editionId)?.title ?? '独立发行'} · ${value.editionId.slice(-8)}：${value.reason}`).join('；') : '未添加建议'
}
function addGrouping(): void {
  const edition = props.session.editions.value.find(value => value.id === groupingEdition.value), reason = groupingReason.value.trim()
  if (!edition || !reason) { groupingError.value = '请选择具体发行并填写建议理由。'; return }
  const previous = props.session.annotations.groupingSuggestions
  if (previous.some(value => value.editionId === edition.id)) { groupingError.value = '这个发行已有建议，可先移除原建议再修改。'; return }
  if (previous.length >= 8) { groupingError.value = '每次最多保留 8 个发行分组建议。'; return }
  props.session.setGroupingSuggestions([...previous, { editionId: edition.id, expectedRevision: edition.revision, reason }]); groupingReason.value = ''; groupingError.value = ''
}
function close(): void { props.session.close() }
function sourceWrites(): void {
  if (!props.sourceWritesAvailable || !props.session.target.value || props.session.draftLocked.value) return
  emit('source-writes'); close()
}
function keydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !dialog.value) return
  const items = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'))
    .filter(element => !element.hidden && element.getClientRects().length > 0)
  if (!items.length) { event.preventDefault(); dialog.value.focus(); return }
  const first = items[0]!, last = items[items.length - 1]!, active = document.activeElement
  if (event.shiftKey && (active === first || active === dialog.value || active === heading.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || active === dialog.value)) { event.preventDefault(); first.focus() }
}
onMounted(async () => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal(); await nextTick(); heading.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => { dialog.value?.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); else emit('return-focus') })
</script>

<template>
  <dialog ref="dialog" class="local-organizer-dialog" aria-labelledby="local-organizer-title" aria-describedby="local-organizer-boundary" tabindex="-1" @cancel.prevent="close" @keydown="keydown">
    <header class="organizer-header"><div><p class="organizer-kicker">本地音乐 · 信息整理</p><h2 id="local-organizer-title" ref="heading" tabindex="-1">{{ session.view.value === 'history' ? '整理历史' : plan?.undoOf ? ['DRAFT', 'RECOVERY_REQUIRED'].includes(plan.state) ? '预览撤销更正' : '撤销更正结果' : '整理 MB 信息' }}</h2></div><button type="button" aria-label="关闭信息整理" @click="close">关闭</button></header>
    <p id="local-organizer-boundary" class="organizer-muted">只保存到 MB，音频文件与源标签保留。</p>
    <p v-if="session.targetLabel.value" class="organizer-target">{{ session.targetLabel.value }}</p>
    <p v-if="session.loading.value" role="status">正在读取已保存的计划与结果…</p>

    <form v-if="session.view.value === 'edit'" class="organizer-editor" aria-label="具体信息更正" @submit.prevent="session.preview()">
      <p class="organizer-muted">选择需要更正的字段；保持不会改动现有信息。设为空值与清除人工更正分别预览。</p>
      <div class="organizer-fields">
        <div v-for="field in fields" :key="field.key" class="organizer-field">
          <label :for="`organizer-${field.key}-action`">{{ field.label }}</label>
          <select :id="`organizer-${field.key}-action`" :value="session.fields[field.key].action" :disabled="locked" :aria-label="`${field.label}更正方式`" @change="session.setFieldAction(field.key, action($event))"><option value="keep">保持</option><option value="set">设为</option><option value="clear">清除人工更正</option></select>
          <input v-if="session.fields[field.key].action === 'set'" :id="`organizer-${field.key}-value`" :value="session.fields[field.key].value" :disabled="locked" :aria-label="`${field.label}更正值`" maxlength="512" autocomplete="off" placeholder="允许设为空值" @input="session.setFieldValue(field.key, input($event))">
          <span v-else class="organizer-muted">{{ session.fields[field.key].action === 'clear' ? '恢复原始标签' : '保留当前信息' }}</span>
        </div>
      </div>
      <section class="organizer-annotations" aria-label="MB 版本说明与分组建议">
        <h3>版本说明</h3><label for="organizer-version-action" class="organizer-sr-only">版本说明更正方式</label><select id="organizer-version-action" :value="session.annotations.versionAction" :disabled="locked" @change="session.setVersionAction(action($event))"><option value="keep">保持说明</option><option value="set">设置说明</option><option value="clear">清除说明</option></select>
        <textarea v-if="session.annotations.versionAction === 'set'" id="organizer-version-value" :value="session.annotations.versionDescription" :disabled="locked" aria-label="版本说明内容" maxlength="512" rows="3" placeholder="例如发行年份、混音或版本备注" @input="session.setVersionDescription(input($event))"></textarea>
        <p class="organizer-muted">说明帮助辨认版本，不改变独立发行身份。</p>
        <h3>分组建议</h3><label for="organizer-grouping-action" class="organizer-sr-only">分组建议更正方式</label><select id="organizer-grouping-action" :value="session.annotations.groupingAction" :disabled="locked" @change="session.setGroupingAction(action($event))"><option value="keep">保持建议</option><option value="set">设置建议</option><option value="clear">清除建议</option></select>
        <template v-if="session.annotations.groupingAction === 'set'">
          <div v-if="session.editions.value.length" class="organizer-grouping-controls"><label>具体发行<select v-model="groupingEdition" :disabled="locked" aria-label="具体发行"><option value="">选择已有发行</option><option v-for="edition in session.editions.value" :key="edition.id" :value="edition.id">{{ edition.title }}{{ edition.edition ? ` · ${edition.edition}` : '' }} · {{ edition.id.slice(-8) }}</option></select></label><label>建议理由<input v-model="groupingReason" :disabled="locked" aria-label="建议理由" maxlength="512" autocomplete="off"></label><button type="button" :disabled="locked" @click="addGrouping">加入建议</button></div>
          <p v-else class="organizer-muted">此处尚未读取可选发行。可从带有发行关系的曲目详情读取具体发行，再用于当前选择。</p>
          <ul v-if="session.annotations.groupingSuggestions.length" class="organizer-suggestions"><li v-for="suggestion in session.annotations.groupingSuggestions" :key="suggestion.editionId"><span>{{ session.editions.value.find(edition => edition.id === suggestion.editionId)?.title ?? '独立发行' }} · {{ suggestion.editionId.slice(-8) }}：{{ suggestion.reason }}</span><button type="button" :disabled="locked" aria-label="移除这条分组建议" @click="session.setGroupingSuggestions(session.annotations.groupingSuggestions.filter(value => value.editionId !== suggestion.editionId))">移除</button></li></ul>
          <p v-if="groupingError" role="alert" class="organizer-error">{{ groupingError }}</p>
        </template>
        <p class="organizer-muted">这里只保存建议，不合并发行或删除关联。</p>
      </section>
      <button type="submit" class="organizer-primary" :disabled="!session.canPreview.value">{{ session.previewing.value ? '正在生成预览…' : '预览更正' }}</button>
    </form>

    <section v-if="session.view.value === 'history'" class="organizer-history" aria-label="已保存的整理历史">
      <p v-if="!session.loading.value && session.historyLoaded.value && !session.history.value.total" class="organizer-muted">还没有整理记录。</p>
      <ul v-else><li v-for="entry in session.history.value.items" :key="entry.planId"><div><strong>{{ entry.count }} 首 · {{ stateLabel(entry.state) }}</strong><span>{{ new Date(entry.createdAt).toLocaleString('zh-CN') }}{{ entry.scope === 'MB_ONLY' ? ' · MB 信息' : ' · 文件计划' }}</span><p v-if="entry.issue">{{ organizerIssueMessage(entry.issue) }}</p></div><button type="button" :disabled="session.loading.value" :aria-label="`查看 ${entry.count} 首的整理记录`" @click="session.loadPlan(entry.planId)">查看记录</button></li></ul>
      <div class="organizer-history-actions"><button type="button" :disabled="session.loading.value || session.history.value.offset === 0" @click="session.loadHistory(Math.max(0, session.history.value.offset - 20))">上一页</button><span>{{ session.history.value.total }} 条记录</span><button type="button" :disabled="session.loading.value || session.history.value.offset + session.history.value.items.length >= session.history.value.total" @click="session.loadHistory(session.history.value.offset + 20)">下一页</button></div>
    </section>

    <section v-if="session.view.value === 'preview' && plan" class="organizer-preview" aria-label="具体更正预览与逐项结果">
      <div class="organizer-preview-heading"><h3>{{ plan.undoOf ? '撤销更正' : '具体更正' }} · {{ plan.items.length }} 首</h3><strong role="status">{{ stateLabel(plan.state) }}</strong></div>
      <p class="organizer-muted">此处保留计划生成时的对照；最新显示信息可回曲目详情查看。</p>
      <p v-if="plan.undoOf && ['DRAFT', 'RECOVERY_REQUIRED'].includes(plan.state)" class="organizer-muted">这是反向预览，明确保存后才执行撤销。</p>
      <article v-for="(item, index) in plan.items" :key="item.operation.operation_id" class="organizer-preview-item"><h4>{{ index + 1 }}. {{ title(item) }}</h4><p class="organizer-item-result">{{ resultLabel[plan.results[index]!.state] }}<span v-if="plan.results[index]!.issue"> · {{ organizerIssueMessage(plan.results[index]!.issue) }}</span></p>
        <div class="organizer-table-wrap"><table><caption>原始信息与本次具体更正</caption><thead><tr><th scope="col">字段</th><th scope="col">原始标签</th><th scope="col">当前人工更正</th><th scope="col">当前生效值</th><th scope="col">待保存生效值</th></tr></thead><tbody><tr v-for="field in fields" :key="field.key"><th scope="row">{{ field.label }}</th><td>{{ organizerValue(item.raw[field.key]) }}</td><td>{{ organizerValue(item.before.fields[field.key], '无人工更正') }}</td><td>{{ organizerValue(organizerEffective(item, field.key)) }}</td><td>{{ organizerValue(organizerEffective(item, field.key, true)) }}<span v-if="Object.hasOwn(item.before.fields, field.key) && !Object.hasOwn(item.after.fields, field.key)" class="organizer-clear-note">恢复原始标签</span></td></tr></tbody></table></div>
        <dl class="organizer-annotation-preview"><div><dt>当前版本说明</dt><dd>{{ versionValue(item.before.annotations.versionDescription) }}</dd></div><div><dt>待保存版本说明</dt><dd>{{ versionValue(item.after.annotations.versionDescription) }}</dd></div><div><dt>当前分组建议</dt><dd>{{ groupingValue(item) }}</dd></div><div><dt>待保存分组建议</dt><dd>{{ groupingValue(item, true) }}</dd></div></dl>
      </article>
    </section>

    <p v-if="session.error.value" class="organizer-error" role="alert">{{ session.error.value }}</p><p v-if="session.notice.value" class="organizer-notice" role="status">{{ session.notice.value }}</p>
    <p v-if="session.pending.value.length" class="organizer-muted">原请求仍保留；关闭只结束此处等待。</p>
    <footer class="organizer-footer"><div class="organizer-footer-actions"><button type="button" :disabled="session.loading.value || session.cancelling.value" @click="session.view.value === 'history' ? session.loadHistory(session.history.value.offset) : session.reconcile()">重新读取核对</button><button v-if="session.pending.value.length" type="button" @click="emit('open-outbox'); close()">查看未确认操作</button><button v-if="plan && session.canCancel.value" type="button" @click="session.cancelPlan()">取消此计划</button><button v-if="plan && session.canUndo.value" type="button" @click="session.previewUndo()">预览撤销</button><button v-if="sourceWritesAvailable && session.target.value" type="button" :disabled="session.draftLocked.value" @click="sourceWrites">预览源标签写回</button></div><div class="organizer-footer-actions"><button v-if="session.view.value === 'preview' && session.target.value && !session.draftLocked.value" type="button" @click="session.edit()">返回编辑</button><button v-if="session.view.value !== 'history'" type="button" :disabled="session.busy.value" @click="session.loadHistory()">整理历史</button><button v-if="session.view.value === 'preview' && plan" type="button" class="organizer-primary" :disabled="!session.canConfirm.value" @click="session.save()">{{ session.confirming.value ? '正在保存…' : '保存这些更正' }}</button></div></footer>
  </dialog>
</template>

<style scoped>
.local-organizer-dialog { box-sizing:border-box; width:min(980px, calc(100vw - 32px)); max-height:calc(100dvh - 32px); padding:26px; border:1px solid var(--mb-glass-border); border-radius:20px; color:var(--mb-text-primary); background:var(--mb-glass-clear); backdrop-filter:blur(30px) saturate(1.2); -webkit-backdrop-filter:blur(30px) saturate(1.2); box-shadow:0 24px 80px #0003; overflow:auto; overscroll-behavior:contain; }
.local-organizer-dialog::backdrop { background:#10182866; }
.organizer-header, .organizer-preview-heading, .organizer-footer, .organizer-footer-actions, .organizer-history-actions { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.organizer-header { align-items:flex-start; }
.organizer-header h2 { margin:0; font-size:24px; }
.organizer-kicker { margin:0 0 6px; font-size:12px; color:var(--mb-text-secondary); }
.organizer-muted, .organizer-history span { color:var(--mb-text-secondary); line-height:1.6; }
.organizer-target { font-weight:600; overflow-wrap:anywhere; }
.organizer-editor { display:grid; gap:20px; }
.organizer-fields { display:grid; gap:12px; }
.organizer-field { display:grid; grid-template-columns:90px 160px minmax(0, 1fr); align-items:center; gap:12px; }
.local-organizer-dialog input, .local-organizer-dialog select, .local-organizer-dialog textarea { box-sizing:border-box; min-height:44px; padding:8px 12px; min-width:0; border:1px solid var(--mb-glass-border); border-radius:8px; background:var(--mb-glass-clear); color:var(--mb-text-primary); font:inherit; }
.local-organizer-dialog button { min-width:44px; min-height:44px; padding:8px 12px; border:1px solid var(--mb-glass-border); border-radius:8px; background:var(--mb-glass-clear); color:var(--mb-text-primary); font:inherit; cursor:pointer; }
.local-organizer-dialog button:disabled { opacity:.5; cursor:default; }
.local-organizer-dialog button:not(:disabled):active { transform:scale(.97); }
.local-organizer-dialog button:focus-visible, .local-organizer-dialog input:focus-visible, .local-organizer-dialog select:focus-visible, .local-organizer-dialog textarea:focus-visible, .organizer-header h2:focus-visible { outline:2px solid var(--mb-accent); outline-offset:3px; }
.local-organizer-dialog .organizer-primary { background:var(--mb-accent); color:var(--mb-text-on-accent, #fff); border-color:var(--mb-accent); }
.organizer-annotations { padding-top:4px; border-top:1px solid var(--mb-divider); }
.organizer-annotations textarea { width:100%; margin-top:12px; resize:vertical; }
.organizer-grouping-controls { display:flex; gap:12px; align-items:end; flex-wrap:wrap; margin-top:12px; }
.organizer-grouping-controls label { display:grid; gap:6px; flex:1 1 180px; }
.organizer-suggestions, .organizer-history ul { list-style:none; padding:0; }
.organizer-suggestions li, .organizer-history li { display:flex; gap:16px; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--mb-divider); }
.organizer-history li div { display:grid; gap:6px; }
.organizer-history li p { margin:0; }
.organizer-preview-item { padding:12px 0 20px; border-bottom:1px solid var(--mb-divider); }
.organizer-preview-item h4 { margin:12px 0; overflow-wrap:anywhere; }
.organizer-table-wrap { overflow-x:auto; }
.organizer-table-wrap table { width:100%; border-collapse:collapse; font-size:12px; }
.organizer-table-wrap caption { text-align:left; padding:8px 0; color:var(--mb-text-secondary); }
.organizer-table-wrap th, .organizer-table-wrap td { padding:10px 8px; text-align:left; vertical-align:top; border-bottom:1px solid var(--mb-divider); overflow-wrap:anywhere; min-width:86px; }
.organizer-table-wrap th:first-child { min-width:42px; }
.organizer-clear-note { display:block; color:var(--mb-text-secondary); margin-top:4px; }
.organizer-annotation-preview { display:grid; grid-template-columns:1fr 1fr; gap:12px; font-size:13px; }
.organizer-annotation-preview dt { color:var(--mb-text-secondary); margin-bottom:4px; }
.organizer-annotation-preview dd { margin:0; overflow-wrap:anywhere; }
.organizer-footer { margin-top:24px; padding-top:18px; border-top:1px solid var(--mb-divider); align-items:flex-start; }
.organizer-footer-actions { justify-content:flex-start; }
.organizer-error { color:var(--mb-danger); line-height:1.6; }
.organizer-notice, .organizer-item-result { line-height:1.6; }
.organizer-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); border:0; white-space:nowrap; }
@media (max-width:680px) { .local-organizer-dialog { padding:18px; } .organizer-field { grid-template-columns:1fr 1fr; gap:8px; } .organizer-field input, .organizer-field > span { grid-column:1 / -1; } .organizer-annotation-preview { grid-template-columns:1fr; } }
@media (hover:hover) and (pointer:fine) { .local-organizer-dialog button:not(:disabled):hover { border-color:var(--mb-accent); } }
@media (prefers-reduced-motion:reduce) { .local-organizer-dialog button:not(:disabled):active { transform:none; } }
</style>
