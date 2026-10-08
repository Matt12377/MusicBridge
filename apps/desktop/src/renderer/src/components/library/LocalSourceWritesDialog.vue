<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { LocalSourceWritesField, LocalSourceWritesRange, LocalSourceWritesRestoration } from '@music-bridge/contracts'
import type { useLocalSourceWrites } from '../../composables/application/useLocalSourceWrites.js'
const props = defineProps<{ session: ReturnType<typeof useLocalSourceWrites> }>()
const emit = defineEmits<{ 'open-outbox': []; 'return-focus': []; 'mb-only': []; reacquire: [] }>()
const dialog = ref<HTMLDialogElement>(), heading = ref<HTMLElement>()
const plan = computed(() => props.session.plan.value), locked = computed(() => props.session.locked.value)
const fields: { key: LocalSourceWritesField; label: string }[] = [{ key: 'title', label: '标题' }, { key: 'artist', label: '艺术家' }, { key: 'album', label: '专辑' }, { key: 'year', label: '年份' }, { key: 'disc', label: '碟号' }, { key: 'track', label: '曲序' }]
const resultLabel = { planned: '尚未写入', applied: '已写入并核对', 'not-written': '未写入', unknown: '结果未知' }
const phaseLabel = { PLANNED: '待处理', BACKUP: '保全备份', STAGED: '核验新文件', CAPTURE_INTENT: '准备捕获原文件', CAPTURED: '原文件已保全', PUBLISH_INTENT: '准备发布', PUBLISHED: '已发布，等待核验', CLEANUP: '安全收尾', VERIFIED: '文件已核验', FACTS_COMMITTED: '本地事实已提交', QUIET: '保护已释放', TERMINAL: '处理已结束', UNKNOWN: '阶段未知' }
const verificationLabel = { 'not-applicable': '不适用', pending: '待核验', verified: '已核验', unknown: '未知' }
const text = (event: Event) => (event.target as HTMLInputElement | HTMLSelectElement).value
const values = (value: string[] | null) => value === null ? '未提供' : value.length ? value[0] === '' ? '空值' : value[0] : '已移除'
const restorationLabel = (value: LocalSourceWritesRestoration) => value.kind === 'remove-new-directory-cover' ? '恢复原无目录封面状态；移除本次新增的封面。' : value.kind === 'restore-directory-cover' ? '从已核验备份恢复原目录封面。' : '从已核验备份恢复原音频文件，包括原标签与封面。'
let returnFocus: HTMLElement | null = null
function close(): void { props.session.close() }
function changeRange(event: Event): void { const value = text(event); if (value === 'MB_ONLY') { emit('mb-only'); close() } else props.session.setRange(value as LocalSourceWritesRange) }
function keydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !dialog.value) return
  const elements = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')).filter(item => item.getClientRects().length > 0)
  const first = elements[0], last = elements.at(-1)
  if (!first) { event.preventDefault(); heading.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (document.activeElement === last || !dialog.value.contains(document.activeElement))) { event.preventDefault(); first.focus() }
}
onMounted(async () => { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; await nextTick(); dialog.value?.showModal(); heading.value?.focus() })
onBeforeUnmount(() => { dialog.value?.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); else emit('return-focus') })
</script>
<template>
  <dialog ref="dialog" class="source-writes-dialog" aria-labelledby="source-writes-heading" aria-describedby="source-writes-boundary" @cancel.prevent="close" @keydown="keydown">
    <header><div><p class="muted">本地音乐 · 具体计划</p><h2 id="source-writes-heading" ref="heading" tabindex="-1">源文件写入</h2></div><button type="button" aria-label="关闭源文件写入" @click="close">关闭</button></header>
    <p id="source-writes-boundary" class="muted">写入采用非原子保全发布：先核验备份与新文件，再发布并逐项回读；中断时保留可核对的恢复材料。</p>
    <p v-if="session.targetLabel.value">{{ session.targetLabel.value }}</p>
    <p v-if="session.context.value" class="muted">源写开关：{{ session.context.value.policy.enabled ? '已开启' : '已关闭' }}{{ session.context.value.policy.draining ? ' · 已有任务正在安全收尾' : '' }}。关闭仍可读取历史与结果。</p>
    <p v-if="session.loading.value" role="status">正在读取持久计划与结果…</p>
    <form v-if="session.view.value === 'edit' && session.target.value" aria-label="具体源文件写入内容" @submit.prevent="session.preview()">
      <label>保存范围<select aria-label="保存范围" :value="session.range.value" :disabled="locked" @change="changeRange"><option value="MB_ONLY">只保存 MB 信息与封面</option><option value="TAGS">写回源标签</option><option value="EMBEDDED_COVER">写回音频内嵌封面</option><option value="DIRECTORY_COVER">写回目录封面</option></select></label>
      <template v-if="session.range.value === 'TAGS'">
        <p id="source-tags-hint" class="muted">保持不会改动此字段；设值须有内容，移除才会删除源标签。年份用四位数，碟号和曲序用 0..100000 的整数。空值与清除人工更正、版本说明和分组建议仍从原 MB 信息入口保存。</p>
        <div v-for="field in fields" :key="field.key" class="field"><strong>{{ field.label }}</strong><select :aria-label="`${field.label}源标签操作`" :value="session.fields[field.key].action" :disabled="locked" @change="session.setAction(field.key, text($event) as 'keep' | 'set' | 'remove')"><option value="keep">保持</option><option value="set">设为</option><option value="remove">移除源标签</option></select><input v-if="session.fields[field.key].action === 'set'" :aria-label="`${field.label}源标签值`" :value="session.fields[field.key].value" :disabled="locked" maxlength="512" autocomplete="off" @input="session.setValue(field.key, text($event))"><span v-else class="muted">{{ session.fields[field.key].action === 'remove' ? '移除此字段的源标签' : '保留原标签' }}</span></div>
      </template>
      <template v-else>
        <label>具体已选封面发行<select aria-label="源写封面发行" :value="session.editionId.value" :disabled="locked" @change="session.setEdition(text($event))"><option value="">选择具体发行</option><option v-for="material in session.context.value?.materials ?? []" :key="material.editionId" :value="material.editionId">发行 {{ material.editionId.slice(-8) }} · {{ material.availability === 'available' ? '原图已留存' : material.availability === 'reacquire-required' ? '需要重新取得原图' : '原图暂不可用' }}</option></select></label>
        <p v-if="!session.selectedMaterial.value" class="muted">展示图不能代替原图。请从原选图、检索或拖入入口重新取得图片并保存 MB 封面，再重新读取材料。<button type="button" :disabled="locked" @click="emit('reacquire')">重新选择并保存 MB 封面</button></p>
        <p v-else class="muted">将使用与当前选择、候选及修订绑定的真实原图。</p>
        <label v-if="session.range.value === 'DIRECTORY_COVER'">目录封面名称<select aria-label="目录封面名称" :value="session.fileName.value" :disabled="locked" @change="session.setFileName(text($event) as 'cover.jpg' | 'cover.png')"><option value="cover.jpg">cover.jpg</option><option value="cover.png">cover.png</option></select></label>
      </template>
      <button type="submit" :disabled="!session.canPreview.value">{{ session.previewing.value ? '正在受理预览…' : '预览具体源写计划' }}</button>
    </form>
    <section v-if="session.view.value === 'history'" aria-label="源写持久历史"><p v-if="session.historyLoaded.value && !session.history.value.length && !session.loading.value">还没有源写计划。</p><ul><li v-for="entry in session.history.value" :key="entry.planId" :data-source-plan-id="entry.planId"><span>{{ session.rangeLabel(entry.range) }} · {{ entry.operations }} 项 · {{ session.stateLabel(entry.state) }}</span><button type="button" :aria-label="`查看 ${entry.operations} 项源写计划`" :disabled="session.loading.value" @click="session.loadPlan(entry.planId)">查看计划</button></li></ul><button v-if="session.historyCursor.value" type="button" :disabled="session.loading.value" @click="session.loadHistory(true)">更多源写历史</button></section>
    <section v-if="session.view.value === 'plan' && plan" aria-label="源写具体预览与逐项结果">
      <header><h3>{{ plan.undoOf ? '撤销预览' : plan.recoveryOf ? '恢复预览' : session.rangeLabel(plan.range) }} · {{ plan.items.length }} 项</h3><strong role="status">{{ session.stateLabel(plan.state) }}</strong></header>
      <p>{{ plan.summary }}</p><p v-if="plan.undoOf || plan.recoveryOf" class="muted">这是新预览；再次确认这份具体计划才会处理文件。</p>
      <p v-if="session.planExpired.value" role="status">此预览已过期，请重新生成具体计划。</p>
      <p class="muted">涉及 {{ plan.resourceSummary.resources }} 个文件资源、{{ plan.resourceSummary.sharedTargets }} 个共享目标；空间{{ plan.resourceSummary.spaceVerified ? '已核验' : '尚未核实' }}，保护{{ plan.resourceSummary.protection === 'verified' ? '已核验' : plan.resourceSummary.protection === 'blocked' ? '阻止写入' : '尚未核实' }}。</p>
      <p v-for="issue in plan.issues" :key="issue" role="alert">{{ session.issue(issue) }}</p>
      <article v-for="item in plan.items" :key="item.operationId" class="item"><h4>{{ item.label }}</h4><p>{{ resultLabel[item.state] }} · {{ phaseLabel[item.phase] }}<span v-if="item.issue"> · {{ session.issue(item.issue) }}</span></p>
        <p v-if="item.restoration">{{ restorationLabel(item.restoration) }}</p>
        <div v-if="item.changes.length" class="table-wrap"><table><caption>原源标签与待写入内容</caption><thead><tr><th>字段</th><th>原标签</th><th>具体操作</th><th>待写入</th></tr></thead><tbody><tr v-for="change in item.changes" :key="change.field"><th>{{ fields.find(field => field.key === change.field)?.label }}</th><td><ul v-if="change.before && change.before.length > 1"><li v-for="(value, index) in change.before" :key="index">{{ values([value]) }}</li></ul><template v-else>{{ values(change.before) }}</template></td><td>{{ item.restoration ? change.action === 'remove' ? '恢复原无标签状态' : '恢复原标签' : change.action === 'remove' ? '移除源标签' : '设为' }}</td><td><ul v-if="change.after && change.after.length > 1"><li v-for="(value, index) in change.after" :key="index">{{ values([value]) }}</li></ul><template v-else>{{ values(change.after) }}</template></td></tr></tbody></table></div>
        <p v-if="item.artwork">{{ item.artwork.slot === 'front' ? '音频正面内嵌封面' : '目录封面' }} · {{ item.artwork.mime === 'image/png' ? 'PNG' : 'JPEG' }} · {{ item.artwork.width }} × {{ item.artwork.height }} · {{ item.artwork.bytes }} 字节原图</p>
        <p class="muted">备份：{{ item.backup.state === 'verified' ? '已核验' : item.backup.state === 'retained' ? '已保留' : item.backup.state === 'unknown' ? '未知' : '尚未创建' }}；内容{{ verificationLabel[item.verification.content] }}，音频{{ verificationLabel[item.verification.audio] }}，未选元数据{{ verificationLabel[item.verification.unselectedMetadata] }}，独立回读{{ verificationLabel[item.verification.reread] }}。</p>
      </article>
      <p v-if="plan.items.some(item => item.state === 'applied')" class="muted">源文件结果已按上方逐项状态更新；Roon/native 显示信息可能仍未刷新，原文件直送入口继续可用。</p>
      <div v-if="plan.recoveryChoices.length" aria-label="明确恢复选择"><button v-for="choice in plan.recoveryChoices" :key="choice.choiceId" type="button" :disabled="session.busy.value || session.unknown.value" @click="session.previewRecovery(choice)">预览恢复：{{ choice.label }}</button></div>
      <details @toggle="($event.target as HTMLDetailsElement).open && !session.eventsLoaded.value && session.loadEvents()"><summary>具体处理历史</summary><ol><li v-for="event in session.events.value" :key="event.eventId">{{ event.label }} · {{ phaseLabel[event.phase] }}<span v-if="event.issue"> · {{ session.issue(event.issue) }}</span></li></ol><button v-if="session.eventCursor.value" type="button" :disabled="session.loading.value" @click="session.loadEvents(true)">更多处理历史</button></details>
    </section>
    <p v-if="session.error.value" role="alert">{{ session.error.value }}</p><p v-if="session.notice.value" role="status">{{ session.notice.value }}</p>
    <p v-if="session.unknown.value" class="muted">原请求结果未知，关闭只结束此处等待；不会重发或重新授权。</p>
    <footer><button type="button" :disabled="session.loading.value" @click="session.reconcile()">重新读取源写结果</button><button type="button" :disabled="session.busy.value" @click="session.loadHistory()">源写历史</button><button type="button" @click="emit('open-outbox')">打开未确认操作</button><button v-if="session.canCancel.value" type="button" @click="session.cancel()">取消此源写计划</button><button v-if="session.canUndo.value" type="button" @click="session.previewUndo()">预览源写撤销</button><button v-if="plan?.state === 'READY' && session.target.value" type="button" :disabled="locked" @click="session.edit()">返回源写编辑</button><button v-if="plan" type="button" class="primary" :disabled="!session.canConfirm.value" @click="session.confirm()">{{ session.confirming.value ? '正在提交具体确认…' : '确认这份源写计划' }}</button></footer>
  </dialog>
</template>
<style scoped>
.source-writes-dialog{box-sizing:border-box;width:min(980px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:26px;border:1px solid var(--mb-glass-border);border-radius:20px;background:var(--mb-glass-clear);color:var(--mb-text-primary);backdrop-filter:blur(30px);overflow:auto;overscroll-behavior:contain}.source-writes-dialog::backdrop{background:#10182866}header,footer{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}header h2{margin:0}.muted{color:var(--mb-text-secondary);line-height:1.6}form{display:grid;gap:16px}label{display:grid;gap:8px}.field{display:grid;grid-template-columns:80px 160px minmax(0,1fr);gap:12px;align-items:center}input,select,button{box-sizing:border-box;min-height:44px;min-width:44px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-glass-clear);color:inherit;padding:8px 12px;font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,h2:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}.primary{background:var(--mb-accent);color:var(--mb-text-on-accent,#fff)}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;gap:12px;padding:12px 0}.item{border-bottom:1px solid var(--mb-divider);padding:12px 0}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px 8px;text-align:left;vertical-align:top;border-bottom:1px solid var(--mb-divider);overflow-wrap:anywhere}caption{text-align:left;color:var(--mb-text-secondary)}footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--mb-divider)}@media(max-width:640px){.field{grid-template-columns:1fr}.source-writes-dialog{padding:18px}}
</style>
