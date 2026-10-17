<script setup lang="ts">
import { computed } from 'vue'
import type { LocalWorkbenchLyrics } from '../../../composables/application/local-library-workbench/lyrics.js'
import type { LocalWorkbenchLyricsResultInspection } from '../../../composables/application/local-library-workbench/types.js'
const props = defineProps<{ model: LocalWorkbenchLyrics; inspection?: LocalWorkbenchLyricsResultInspection | null }>()
const sources = { netease: '网易云', qq: 'QQ音乐', kugou: '酷狗', kuwo: '酷我', lrclib: 'LRCLIB' }
const presence = { unknown: '本地状态未知', false: '本地缺词', true: '已有本地歌词' }
const states = { 'not-requested': '未请求', pending: '处理中', saved: '已保存', existing: '原文件已存在', failed: '失败', unknown: '未确认', cancelled: '已取消' }
const matches = { existing: '保留已有歌词', 'whole-track': '整轨不查询', recommended: '建议匹配，请核对', review: '有歧义，请选择', 'not-found': '未找到候选', failed: '查询失败', unknown: '匹配未确认' }
const versions = { original: '原版', live: '现场版', remix: '混音版', instrumental: '纯音乐版', unknown: '版本未确认' }
const saves = { running: '正在保存', complete: '已确认完成', partial: '部分完成', unknown: '原结果未确认', cancelled: '已取消', failed: '失败' }
const reads = { idle: '尚未读取', loading: '正在只读读取', ready: '原读取已返回', 'not-found': '原记录尚未查到', stale: '原引用已陈旧', error: '原读取尚未确认' }
const nonempty = (value: string) => value.trim().length > 0
const resultActionsAvailable = computed(() => !!props.inspection && !!props.model.resultInspection.value
  && props.inspection.phase !== 'stale' && props.model.resultInspection.value.phase !== 'stale'
  && props.model.isOriginalResultKey(props.inspection.key) && props.model.sameResultKey(props.inspection.key, props.model.resultInspection.value.key))
function previewResult(candidateId: string): void { if (resultActionsAvailable.value) void props.model.previewResultCandidate(candidateId) }
function readResult(commandId: string): void { if (resultActionsAvailable.value) void props.model.readResultReceipt(commandId) }
</script>
<template>
  <section v-if="inspection" class="workbench-section" aria-label="原歌词会话只读检查">
    <h4>原歌词会话与持久操作</h4><p>这里只读原候选和原回执，不改变当前选择或保存请求。</p>
    <p v-if="inspection.originalEntry">{{ inspection.originalEntry.sessionId || '原entry没有会话ID' }} · {{ inspection.originalEntry.scope.albumId }}</p>
    <p role="status">原会话：{{ reads[inspection.sessionPhase] }}</p>
    <p v-if="inspection.sessionPhase === 'not-found'">原会话不存在或已结束；已知原保存请求仍可读取。</p>
    <p v-if="inspection.session">原查询状态：{{ inspection.session.state === 'ready' ? '原候选已返回' : inspection.session.state === 'querying' ? '原查询仍在处理' : inspection.session.state === 'stale' ? '原会话已陈旧' : '原查询已停止' }}</p>
    <article v-for="track in inspection.session?.tracks ?? []" :key="track.trackId" class="workbench-review-item">
      <h4>{{ track.title || track.trackId }}</h4><p>{{ presence[track.presence] }} · {{ matches[track.match] }}</p>
      <ul aria-label="原会话独立歌词来源结果"><li v-for="source in track.sources" :key="source.source">{{ sources[source.source] }} · {{ source.state === 'ok' ? '已返回' : source.state === 'failed' ? '失败' : source.state === 'budget' ? '超出读取限制' : source.state === 'cancelled' ? '已停止' : '暂不可用' }}</li></ul>
      <div v-for="candidate in inspection.session?.candidates.filter(value => value.trackId === track.trackId) ?? []" :key="candidate.candidateId" class="workbench-controls">
        <span>{{ sources[candidate.source] }} · {{ candidate.title }}<span v-if="nonempty(candidate.artist)"> · {{ candidate.artist }}</span><span v-if="nonempty(candidate.album)"> · {{ candidate.album }}</span> · {{ versions[candidate.version] }}<span v-if="candidate.durationMs !== null"> · {{ Math.round(candidate.durationMs / 1000) }} 秒</span></span>
        <button type="button" class="secondary-button workbench-result-button" :aria-label="`只读原候选正文 ${candidate.title}`" :disabled="!resultActionsAvailable || inspection.session?.state !== 'ready'" @click="previewResult(candidate.candidateId)">只读原候选正文</button>
      </div>
    </article>
    <p v-if="inspection.detailPhase !== 'idle'" role="status">原正文：{{ reads[inspection.detailPhase] }}</p>
    <section v-if="inspection.detail" aria-label="原候选歌词正文"><h4>{{ inspection.detail.candidate.title }} · {{ sources[inspection.detail.candidate.source] }}</h4><p><span v-if="nonempty(inspection.detail.candidate.artist)">{{ inspection.detail.candidate.artist }}</span><span v-if="nonempty(inspection.detail.candidate.album)"> · {{ inspection.detail.candidate.album }}</span><span v-if="inspection.detail.candidate.durationMs !== null"> · {{ Math.round(inspection.detail.candidate.durationMs / 1000) }} 秒</span></p><pre :key="JSON.stringify([inspection.session?.sessionId ?? inspection.originalEntry?.sessionId ?? inspection.originalEntry?.saveRequest?.sessionId, inspection.detail.candidate.candidateId])" class="workbench-lyrics-body">{{ inspection.detail.body }}</pre></section>
    <ul aria-label="检查中的原歌词持久操作"><li v-for="operation in inspection.operations" :key="`${operation.request.sessionId}:${operation.request.commandId}`">
      <p>{{ operation.request.sessionId }} · {{ operation.request.commandId }} · {{ operation.request.embed ? '原请求：LRC与内嵌' : '原请求：仅LRC' }} · {{ reads[operation.phase ?? 'idle'] }}</p>
      <p v-if="operation.error" role="alert">{{ operation.error }}</p>
      <template v-if="operation.receipt"><p>上次原回执：{{ saves[operation.receipt.state] }} · 封面 {{ states[operation.receipt.cover] }} · 快照 {{ operation.receipt.snapshot === 'saved' ? '已保存' : operation.receipt.snapshot === 'failed' ? '保存失败' : operation.receipt.snapshot === 'pending' ? '保存中' : '未请求' }}</p><ul><li v-for="track in operation.receipt.tracks" :key="track.trackId">{{ inspection.session?.tracks.find(row => row.trackId === track.trackId)?.title || track.trackId }} · LRC {{ states[track.lrc] }} · 内嵌 {{ states[track.embed] }}</li></ul></template>
      <p v-else>{{ operation.phase === 'not-found' ? '原回执未查到，原请求保留。' : '原回执尚未读取确认。' }}</p>
      <button type="button" class="secondary-button workbench-result-button" :aria-label="`只读检查中的原回执 ${operation.request.commandId}`" :disabled="!resultActionsAvailable || operation.phase === 'loading'" @click="readResult(operation.request.commandId)">只读检查中的原回执</button>
    </li></ul><p v-if="!inspection.operations.length">尚无作者回显的原保存请求；不会自行生成请求。</p>
  </section>
  <section v-else class="workbench-section" aria-label="专辑歌词工作台">
    <h3>查询与选择歌词</h3>
    <p>候选不代表本地已有歌词。选择后明确保存同名LRC；WAV/FLAC可同时嵌入受保护副本，原标签、图片与音频保持。</p>
    <div class="workbench-controls">
      <button type="button" :disabled="!model.scope.value || model.busy.value || model.pending.value" @click="model.query()">查询此专辑缺词</button>
      <button v-if="model.session.value?.state === 'querying'" type="button" :disabled="model.locked.value" @click="model.cancelQuery()">停止查询</button>
      <button v-if="model.session.value" type="button" :disabled="model.busy.value" @click="model.refreshSession()">读取查询状态</button>
      <label><input v-model="model.embed.value" type="checkbox" :disabled="model.locked.value || !!model.originalSave.value">保存LRC后嵌入WAV/FLAC歌词</label>
    </div>
    <p v-if="model.error.value" role="alert">{{ model.error.value }}</p><p v-if="model.notice.value" role="status">{{ model.notice.value }}</p>
    <p v-if="model.session.value?.state === 'querying'" role="status">正在读取五来源候选…</p>
    <article v-for="track in model.session.value?.tracks ?? []" :key="track.trackId" class="workbench-review-item">
      <h4>{{ track.title }}</h4><p>{{ presence[track.presence] }} · {{ matches[track.match] }}</p>
      <ul aria-label="独立歌词来源结果"><li v-for="source in track.sources" :key="source.source">{{ sources[source.source] }} · {{ source.state === 'ok' ? '已返回' : source.state === 'failed' ? '失败' : source.state === 'budget' ? '超出读取限制' : source.state === 'cancelled' ? '已停止' : '暂不可用' }}</li></ul>
      <div v-for="candidate in model.session.value?.candidates.filter(value => value.trackId === track.trackId) ?? []" :key="candidate.candidateId" class="workbench-controls">
        <label><input type="radio" :name="`lyrics-${track.trackId}`" :checked="track.selectedCandidateId === candidate.candidateId" :disabled="model.locked.value || model.busy.value || !!model.originalSave.value" @change="model.select(track.trackId, candidate.candidateId)">{{ sources[candidate.source] }} · {{ candidate.title }}<span v-if="nonempty(candidate.artist)"> · {{ candidate.artist }}</span><span v-if="nonempty(candidate.album)"> · {{ candidate.album }}</span> · {{ versions[candidate.version] }} · {{ candidate.language }}<span v-if="candidate.durationMs !== null"> · {{ Math.round(candidate.durationMs / 1000) }} 秒</span></label>
        <button type="button" @click="model.preview(candidate.candidateId)">预览正文</button>
      </div>
      <button v-if="track.selectedCandidateId" type="button" :disabled="model.locked.value || !!model.originalSave.value" @click="model.select(track.trackId, null)">撤销此曲目选择</button>
    </article>
    <section v-if="model.detail.value" aria-label="歌词正文预览"><h4>{{ model.detail.value.candidate.title }} · {{ sources[model.detail.value.candidate.source] }}</h4><p><span v-if="nonempty(model.detail.value.candidate.artist)">{{ model.detail.value.candidate.artist }}</span><span v-if="nonempty(model.detail.value.candidate.album)"> · {{ model.detail.value.candidate.album }}</span><span v-if="model.detail.value.candidate.durationMs !== null"> · {{ Math.round(model.detail.value.candidate.durationMs / 1000) }} 秒</span></p><pre :key="JSON.stringify([model.session.value?.sessionId, model.detail.value.candidate.candidateId])" class="workbench-lyrics-body">{{ model.detail.value.body }}</pre></section>
    <p v-if="model.selectedCount.value">已明确选择 {{ model.selectedCount.value }} 首；已有同名LRC不会被覆盖。</p>
    <ul v-if="model.saveOperations.value.length" aria-label="原歌词持久操作">
      <li v-for="operation in model.saveOperations.value" :key="operation.request.commandId">
        {{ operation.request.sessionId }} · {{ operation.request.commandId }} · {{ operation.request.embed ? 'LRC与内嵌' : '仅LRC' }} · {{ saves[operation.receipt.state] }}
        <button type="button" :disabled="model.writing.value" @click="model.selectOriginal(operation.request.commandId)">查看此原操作</button>
        <button type="button" :disabled="model.writing.value" @click="model.readOriginal(operation.request.commandId)">只查询此原回执</button>
      </li>
    </ul>
    <button v-if="model.originalSave.value" type="button" :disabled="model.writing.value" @click="model.readOriginal()">查询全部原歌词保存回执</button>
    <button v-if="model.receipt.value?.state === 'partial' || model.receipt.value?.state === 'failed'" type="button" :disabled="model.locked.value" @click="model.retryFailed()">恢复原已失败写入</button>
    <section v-if="model.receipt.value" aria-label="歌词逐项保存结果">
      <p>原请求：{{ model.receipt.value.commandId }} · {{ saves[model.receipt.value.state] }}</p><p>封面：{{ states[model.receipt.value.cover] }} · 快照：{{ model.receipt.value.snapshot === 'saved' ? '已保存' : model.receipt.value.snapshot === 'failed' ? '保存失败' : model.receipt.value.snapshot === 'pending' ? '保存中' : '未请求' }}</p>
      <ul><li v-for="item in model.receipt.value.tracks" :key="item.trackId">{{ model.session.value?.tracks.find(track => track.trackId === item.trackId)?.title || item.trackId }} · LRC {{ states[item.lrc] }} · 内嵌 {{ states[item.embed] }}</li></ul>
      <button v-if="model.receipt.value.snapshot === 'failed'" type="button" :disabled="model.locked.value" @click="model.retrySnapshot()">只重试快照保存</button>
    </section>
  </section>
</template>
<style scoped>
.workbench-section .workbench-result-button { min-height: 44px; }
.workbench-lyrics-body { max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; padding: 16px; border: 1px solid var(--mb-glass-border); border-radius: 8px; }
</style>
