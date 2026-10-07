<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { LocalLegacyLink, LocalLegacyLinkTransition } from '@music-bridge/contracts'
import { localLegacyContextKey, useLocalLegacyLinks, type LocalLegacyUiContext } from '../../composables/application/useLocalLegacyLinks.js'

const props = defineProps<{ context: LocalLegacyUiContext }>()
const session = useLocalLegacyLinks(window.musicBridge)
const { readState, error, notice, page, roots, candidates, detail, selectedEditionId, reason, action, preview, history,
  reading, searching, selecting, previewing, saving, historyBusy, active, unknown, writeBlocked, sourceRangeKnown, canPreview, canConfirm } = session
const editor = ref(false), query = ref(''), rootId = ref(''), editorHeading = ref<HTMLElement>(), previewHeading = ref<HTMLElement>(), refreshButton = ref<HTMLElement>()
let opener: HTMLElement | null = null
const source = computed(() => props.context.key.kind === 'draft-source')
const regionName = computed(() => source.value ? '当前源关联' : '本地发行关联')
const operationName = computed(() => action.value === 'revoke' ? '解除本地关联' : action.value === 'undo' ? '撤销本地关系操作' : source.value ? '关联当前源' : '关联本地发行')
const previewName = computed(() => `预览${operationName.value}`)
const confirmationName = computed(() => `确认${operationName.value}`)
function targetName(link: Pick<LocalLegacyLink, 'endpoints'>): string {
  const e = link.endpoints
  return e.kind === 'legacy-edition' ? `${e.title} · ${e.edition || '未填写版本说明'} · 发行 ${e.localEditionId}` : `本地曲目 ${e.localTrackId} · 资产 ${e.assetId}`
}
async function openEditor(event?: Event): Promise<void> {
  opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
  editor.value = true; await nextTick(); editorHeading.value?.focus()
}
async function link(event: Event): Promise<void> { session.resetDraft(); await openEditor(event); await session.search(query.value, rootId.value || null) }
async function revoke(value: LocalLegacyLink, event: Event): Promise<void> { session.beginRevoke(value); await openEditor(event) }
async function undo(value: LocalLegacyLinkTransition, event: Event): Promise<void> { session.beginUndo(value); await openEditor(event) }
async function closeEditor(): Promise<void> { session.resetDraft(); editor.value = false; await nextTick(); if (opener?.isConnected) opener.focus(); else refreshButton.value?.focus(); opener = null }
function escape(event: KeyboardEvent): void { if (!editor.value) return; event.preventDefault(); event.stopPropagation(); void closeEditor() }
async function makePreview(): Promise<void> { await session.makePreview(); if (preview.value) { await nextTick(); previewHeading.value?.focus() } }
function search(offset = 0): void { session.invalidate(); void session.search(query.value, rootId.value || null, offset) }
function inputReason(event: Event): void { session.setReason((event.target as HTMLTextAreaElement).value) }
function editionChanged(event: Event): void { session.setEdition((event.target as HTMLSelectElement).value) }
function canUndo(value: LocalLegacyLinkTransition): boolean {
  return value.action !== 'undone' && page.value?.items.some(link => link.linkId === value.linkId && link.lastTransitionEventId === value.eventId) === true
}
watch([() => localLegacyContextKey(props.context.key), () => props.context.revision], () => { session.setContext(props.context); editor.value = false; opener = null; void session.read() }, { immediate: true })
onBeforeUnmount(() => session.dispose())
</script>

<template>
  <section class="local-legacy-links" :aria-label="regionName" @keydown.esc="escape">
    <header><h3>{{ regionName }}</h3><button ref="refreshButton" :disabled="reading" @click="session.read()">重新读取本地关联</button></header>
    <p v-if="reading" role="status">正在读取本地关联…</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="unknown" role="status">原本地关系操作结果尚未确认。请重新读取关系和历史；原操作不会自动重发。</p>
    <p v-if="readState === 'loaded' && !active" class="unlinked">未建立本地关联。{{ source ? '已存源证据和冻结历史仍保留。' : '原有 Roon 与数字对象入口仍可使用。' }}</p>
    <article v-if="active" class="local-legacy-current" aria-label="已保存本地关联">
      <strong>{{ targetName(active) }}</strong>
      <p v-if="active.evidence.kind === 'manual-edition'">人工确认的发行关系。</p>
      <template v-else><p>已核对完整文件 · {{ active.evidence.size }} 字节 · {{ active.evidence.coverage.mode === 'whole-file' ? '整文件' : '具有真实帧证据的完整文件范围' }}</p><p class="hash">SHA-256 {{ active.evidence.sha256 }}</p></template>
      <button :disabled="writeBlocked" @click="revoke(active, $event)">解除本地关联</button>
    </article>
    <button v-if="readState === 'loaded' && !active" :disabled="writeBlocked || editor" @click="link($event)">{{ source ? '关联当前源到本地曲目' : '关联本地发行' }}</button>

    <section v-if="editor" class="local-legacy-editor" aria-label="本地关联编辑">
      <header><h4 ref="editorHeading" tabindex="-1">{{ operationName }}</h4><button @click="closeEditor">关闭本地关联编辑</button></header>
      <p>对象：{{ context.title }}</p>
      <template v-if="action === 'link'">
        <form @submit.prevent="search()"><label>查询本地候选<input v-model="query" type="search" maxlength="240" @input="session.invalidate()"></label>
          <label>本地候选目录<select v-model="rootId" @change="session.invalidate()"><option value="">全部已加入目录</option><option v-for="root in roots" :key="root.root.id" :value="root.root.id">{{ root.label }}</option></select></label>
          <button :disabled="searching || writeBlocked">查询本地候选</button>
        </form>
        <p v-if="searching" role="status">正在读取本地候选…</p>
        <p v-if="candidates && !candidates.items.length">没有符合条件的本地候选，请先通过本地音乐库加入目录并完成扫描。</p>
        <ul v-if="candidates" class="local-legacy-candidates"><li v-for="item in candidates.items" :key="item.track.id"><span>{{ item.metadata.title || '未提供标题' }} · {{ item.metadata.artist || '未提供艺术家' }}<small>曲目 {{ item.track.id }}</small></span><button :disabled="selecting || writeBlocked" :aria-label="`查看本地候选 ${item.track.id}`" @click="session.selectTrack(item.track.id)">查看候选</button></li></ul>
        <nav v-if="candidates" aria-label="本地候选分页"><button :disabled="searching || !candidates.offset" @click="search(Math.max(0, candidates.offset - 20))">上一页本地候选</button><span>{{ candidates.total }} 首</span><button :disabled="searching || !candidates.hasMore" @click="search(candidates.offset + 20)">下一页本地候选</button></nav>
        <p v-if="selecting" role="status">正在核对所选曲目与修订…</p>
        <section v-if="detail" aria-label="所选本地候选" class="selected-candidate">
          <strong>{{ detail.metadata.effective.title || '未提供标题' }}</strong><p>曲目 {{ detail.track.id }} · 资产 {{ detail.asset.id }}</p>
          <template v-if="source"><p v-if="sourceRangeKnown">{{ detail.track.segment ? '使用资产已有完整文件帧范围证据。' : '使用所选整文件；预览时由服务端重新核对两端完整字节。' }}</p><p v-else role="alert">当前曲段没有可核对的完整文件范围证据，不能建立关联。</p></template>
          <template v-else><label>具体本地发行<select :value="selectedEditionId" :disabled="writeBlocked" @change="editionChanged"><option value="">请选择一个明确发行</option><option v-for="edition in detail.editions" :key="edition.id" :value="edition.id">{{ edition.title }} · {{ edition.edition || '未填写版本说明' }} · {{ edition.id }}</option></select></label><p v-if="!detail.editions.length">此曲目尚无明确本地发行，请通过原封面入口建立独立发行后重新选择。</p></template>
        </section>
      </template>
      <label>{{ action === 'revoke' ? '解除理由' : action === 'undo' ? '撤销理由' : '关联理由' }}<textarea :value="reason" maxlength="240" rows="2" :disabled="writeBlocked" @input="inputReason"></textarea></label>
      <button :disabled="!canPreview" @click="makePreview">{{ previewName }}</button><p v-if="previewing" role="status">正在核对具体关联预览…</p>
      <section v-if="preview" class="local-legacy-preview" role="group" aria-label="本地关联具体预览">
        <h4 ref="previewHeading" tabindex="-1">{{ previewName }}</h4>
        <dl><div><dt>当前关系</dt><dd>{{ preview.body.before ? `${targetName(preview.body.before)} · ${preview.body.before.state === 'active' ? '已关联' : '已解除'}` : '未建立本地关联' }}</dd></div><div><dt>确认后的关系</dt><dd>{{ targetName({ endpoints: preview.body.endpoints }) }} · {{ preview.body.intent.action === 'revoke' || preview.body.intent.action === 'undo' && preview.body.before?.state === 'active' ? '解除' : '关联' }}</dd></div><div><dt>理由</dt><dd>{{ preview.body.reason }}</dd></div></dl>
        <p v-if="preview.body.evidence.kind === 'manual-edition'">仅保存人工发行对应；不证明文件内容相同，不合并对象。</p>
        <template v-else><p>完整文件 {{ preview.body.evidence.size }} 字节 · {{ preview.body.evidence.coverage.mode === 'whole-file' ? '整文件' : '真实帧证据的完整文件范围' }}</p><p class="hash">SHA-256 {{ preview.body.evidence.sha256 }}</p></template>
        <p>确认只保存本地关系。原照片、录音准入和冻结历史保留。</p>
        <button :disabled="!canConfirm" @click="session.confirm()">{{ confirmationName }}</button><button :disabled="saving" @click="session.invalidate()">取消本地关联预览</button>
      </section>
      <p v-if="saving" role="status">正在保存已确认的本地关系…</p>
    </section>

    <section v-if="page?.items.length" class="local-legacy-history" aria-label="本地关系历史">
      <h4>本地关系历史</h4><ul><li v-for="item in page.items" :key="item.linkId"><span>{{ targetName(item) }} · {{ item.state === 'active' ? '已关联' : '已解除' }}</span><button :disabled="historyBusy" :aria-label="`读取本地关系历史 ${item.linkId}`" @click="session.readHistory(item.linkId)">查看本地关系历史</button></li></ul>
      <button v-if="page.hasMore" :disabled="reading" @click="session.read(true)">读取更多本地关系</button>
      <p v-if="historyBusy" role="status">正在读取持久关系历史…</p>
      <ul v-if="history" class="local-legacy-events"><li v-for="event in history.items" :key="event.eventId"><div><strong>{{ event.action === 'confirmed' ? '已确认关联' : event.action === 'revoked' ? '已解除关联' : '已撤销关系操作' }}</strong><p>{{ new Date(event.occurredAt).toLocaleString() }} · {{ event.reason }}</p><p>此前：{{ event.before ? event.before.state === 'active' ? '已关联' : '已解除' : '未关联' }}；之后：{{ event.after.state === 'active' ? '已关联' : '已解除' }}</p></div><button v-if="canUndo(event)" :disabled="writeBlocked" :aria-label="`准备撤销本地关系操作 ${event.eventId}`" @click="undo(event, $event)">撤销这次关系操作</button></li></ul>
      <button v-if="history?.hasMore" :disabled="historyBusy" @click="session.readHistory(history.linkId, true)">读取更多本地关系历史</button>
    </section>
  </section>
</template>

<style scoped>
.local-legacy-links{margin-top:22px;padding-top:18px;border-top:1px solid var(--mb-divider);min-width:0}header,form,nav,li{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between}h3{font-size:18px;margin:0}h4{font-size:15px;margin:0}p,small,dt{color:var(--mb-text-secondary);font-size:12px;line-height:1.8}p,dd,strong,span{overflow-wrap:anywhere}.local-legacy-current,.local-legacy-editor,.local-legacy-preview,.selected-candidate{margin:14px 0;padding:14px;border:1px solid var(--mb-glass-border);border-radius:10px;background:var(--mb-glass-clear)}button,input,select,textarea{box-sizing:border-box;min-height:40px;max-width:100%;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px}button:disabled{opacity:.5;cursor:not-allowed}button{margin:4px 6px 4px 0}label{display:grid;gap:7px;margin:12px 0;min-width:0;font-size:13px}form label{flex:1}textarea{width:100%;resize:vertical}ul{list-style:none;padding:0;margin:10px 0}li{justify-content:space-between;border-bottom:1px solid var(--mb-divider);padding:10px 0}li>span,li>div{flex:1;min-width:150px}small{display:block}.local-legacy-candidates{max-height:360px;overflow:auto}.hash{font-family:monospace;overflow-wrap:anywhere}.local-legacy-events{font-size:13px}dl>div{display:grid;grid-template-columns:110px 1fr;gap:12px;margin:10px 0}dd{margin:0;font-size:13px}nav{justify-content:flex-end;font-size:12px}@media(max-width:600px){dl>div{grid-template-columns:1fr;gap:4px}form{display:block}}
</style>
