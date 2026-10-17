<script setup lang="ts">
import { computed } from 'vue'
import LocalLyricsReview from './LocalLyricsReview.vue'
import type { LocalWorkbenchLyrics } from '../../../composables/application/local-library-workbench/lyrics.js'
import type { LocalWorkbenchLyricsResultKey, LocalWorkbenchLyricsResultInspection } from '../../../composables/application/local-library-workbench/types.js'
import type { LocalLyricsJobSnapshot, LocalLyricsJobStartRequest } from '@music-bridge/contracts'
const props = defineProps<{ model: LocalWorkbenchLyrics; libraryNames?: Readonly<Record<string, string>>; inspection?: LocalWorkbenchLyricsResultInspection | null }>()
const emit = defineEmits<{ inspect: [key: LocalWorkbenchLyricsResultKey]; 'close-inspection': [] }>()
const states = { queued: '排队', running: '正在保存', stopped: '已停止，可恢复', complete: '已完成', partial: '部分完成', unknown: '原结果未确认', failed: '失败' }
const categories = [{ id: 'review', label: '待选择的原专辑', state: '待核对' }, { id: 'failed', label: '已失败的原专辑', state: '该项失败' }, { id: 'unknown', label: '未确认的原专辑', state: '原结果未确认' }] as const
const phases = { idle: '尚未读取', loading: '正在只读检查原结果', ready: '只读检查已返回，不代表已保存', stale: '原检查已陈旧', error: '原检查尚未确认' }
const groups = computed(() => {
  const jobs: { snapshot: LocalLyricsJobSnapshot; request: LocalLyricsJobStartRequest; history: boolean }[] = []
  if (props.model.job.value && props.model.originalJob.value) jobs.push({ snapshot: props.model.job.value, request: props.model.originalJob.value, history: false })
  for (const entry of props.model.jobHistory.value) jobs.push({ snapshot: entry.latestSnapshot ?? entry.snapshot, request: entry.request, history: true })
  return jobs.flatMap(job => categories.map(category => {
    const ids = category.id === 'review' ? job.snapshot.reviewAlbumIds : category.id === 'failed' ? job.snapshot.failedAlbumIds : job.snapshot.unknownAlbumIds
    const rows = ids.map(albumId => ({ jobId: job.snapshot.jobId, jobRevision: job.snapshot.revision, library: { ...job.request.library }, albumId, category: category.id }))
      .filter(key => props.model.resultKeyMatches(key, job.snapshot, job.request))
    return { ...category, jobId: job.snapshot.jobId, history: job.history, rows }
  }))
})
const currentInspection = computed(() => props.inspection === undefined ? props.model.resultInspection.value : props.inspection)
const inspectionCurrent = computed(() => !!currentInspection.value && props.model.isOriginalResultKey(currentInspection.value.key) && groups.value.some(group => group.rows.some(key => props.model.sameResultKey(key, currentInspection.value!.key))))
const inspectedAlbum = computed(() => { const value = currentInspection.value; return inspectionCurrent.value && value && value.album?.id === value.key.albumId ? value.album : null })
const inspectedTrackPage = computed(() => { const value = currentInspection.value; return inspectionCurrent.value && value && value.trackPage?.albumKey === value.key.albumId ? value.trackPage : null })
function title(key: LocalWorkbenchLyricsResultKey): string { return inspectedAlbum.value && currentInspection.value && props.model.sameResultKey(key, currentInspection.value.key) ? inspectedAlbum.value.title || key.albumId : key.albumId }
function inspect(key: LocalWorkbenchLyricsResultKey): void {
  if (props.model.isOriginalResultKey(key) && groups.value.some(group => group.rows.some(row => props.model.sameResultKey(row, key)))) emit('inspect', { ...key, library: { ...key.library } })
}
</script>
<template>
  <section class="workbench-section" aria-label="全库歌词批次">
    <h3>整个音乐库的缺词</h3><p>任务涵盖明确库的所有已扫描专辑，搜索、筛选与当前页不会缩小范围。已有歌词及整轨跳过，歧义保留待核对。</p>
    <label v-if="model.availableLibraries.value.length">歌词批次的完整库<select :value="model.library.value?.libraryId ?? ''" :disabled="model.pending.value || !!model.originalJob.value && !model.canNewBatch.value" @change="model.chooseLibrary(($event.target as HTMLSelectElement).value)"><option value="" disabled>明确选择一个库</option><option v-for="library in model.availableLibraries.value" :key="library.libraryId" :value="library.libraryId">{{ libraryNames?.[library.libraryId] ?? '所选音乐库' }}</option></select></label>
    <button type="button" :disabled="!model.library.value || model.batchBusy.value || model.pending.value || !!model.originalJob.value" @click="model.startBatch()">获取并保存全库缺词</button>
    <button v-if="model.originalJob.value" type="button" :disabled="model.batchBusy.value" @click="model.batchAction('read')">查询原批次</button>
    <template v-if="model.job.value">
      <p role="status">{{ states[model.job.value.state] }} · 已处理 {{ model.job.value.processedAlbums }} / {{ model.job.value.totalAlbums }} 张 · 已保存 {{ model.job.value.savedAlbums }} 张 · LRC {{ model.job.value.sidecars }} · 内嵌 {{ model.job.value.embedded }}</p>
      <button v-if="model.job.value.state === 'running' || model.job.value.state === 'queued'" type="button" :disabled="model.batchBusy.value" @click="model.batchAction('stop')">停止全库批次</button>
      <button v-if="model.job.value.state === 'stopped'" type="button" :disabled="model.batchBusy.value" @click="model.batchAction('resume')">从原断点恢复</button>
      <button v-if="model.job.value.failedAlbumIds.length" type="button" :disabled="model.batchBusy.value || model.job.value.state === 'running' || model.job.value.state === 'unknown'" @click="model.batchAction('retry')">重试原批次失败项（{{ model.job.value.failedAlbumIds.length }}）</button>
      <p>待选择 {{ model.job.value.reviewAlbumIds.length }} · 已失败 {{ model.job.value.failedAlbumIds.length }} · 未确认 {{ model.job.value.unknownAlbumIds.length }} · 读取失败 {{ model.job.value.inspectionFailures }}</p>
      <button v-if="model.canNewBatch.value" type="button" :disabled="model.locked.value" @click="model.newBatch()">准备下一次明确歌词批次</button>
    </template>
    <section v-if="model.jobHistory.value.length" aria-label="已结束的原歌词批次">
      <h4>已结束原批次</h4><ul><li v-for="entry in model.jobHistory.value" :key="entry.request.commandId">
        {{ libraryNames?.[entry.request.library.libraryId] ?? '原音乐库' }} · {{ entry.request.commandId }} · {{ states[entry.latestSnapshot?.state ?? entry.snapshot.state] }}
        <button type="button" :disabled="model.batchBusy.value" @click="model.readJobHistory(entry.request.commandId)">只查询已结束原批次</button>
        <section v-for="group in groups.filter(value => value.history && value.jobId === entry.request.commandId)" :key="group.id" :aria-label="`历史${group.label}`">
          <h4>{{ group.label }}</h4><ul><li v-for="key in group.rows" :key="JSON.stringify([key.jobId, key.jobRevision, key.library.datasetId, key.library.libraryId, key.library.captureId, key.albumId, key.category])" class="workbench-result-row">
            {{ title(key) }} · {{ group.state }} <button type="button" class="secondary-button workbench-result-button" :aria-label="`查看原歌词结果 ${key.jobId} ${key.category} ${key.albumId}`" @click="inspect(key)">查看原结果</button>
          </li></ul><p v-if="!group.rows.length">此类没有原结果条目。</p>
        </section>
      </li></ul>
    </section>
    <section v-for="group in groups.filter(value => !value.history)" :key="`${group.jobId}:${group.id}`" :aria-label="`当前${group.label}`">
      <h4>{{ group.history ? '历史批次 · ' : '' }}{{ group.label }}</h4><p>{{ group.jobId }}</p>
      <ul><li v-for="key in group.rows" :key="JSON.stringify([key.jobId, key.jobRevision, key.library.datasetId, key.library.libraryId, key.library.captureId, key.albumId, key.category])" class="workbench-result-row">
        {{ title(key) }} · {{ group.state }} <button type="button" class="secondary-button workbench-result-button" :aria-label="`查看原歌词结果 ${key.jobId} ${key.category} ${key.albumId}`" @click="inspect(key)">查看原结果</button>
      </li></ul><p v-if="!group.rows.length">此类没有原结果条目。</p>
    </section>
    <section v-if="currentInspection" aria-label="原歌词批次逐项只读检查">
      <h4>{{ inspectedAlbum?.title || currentInspection.key.albumId }}</h4>
      <p>{{ currentInspection.key.jobId }} · 修订 {{ currentInspection.key.jobRevision }} · {{ currentInspection.key.category === 'failed' ? '该项失败' : currentInspection.key.category === 'unknown' ? '原结果未确认' : '待核对' }}</p>
      <p role="status">{{ inspectionCurrent ? phases[currentInspection.phase] : phases.stale }}</p>
      <p v-if="currentInspection.error" role="alert">{{ currentInspection.error }}</p>
      <p v-if="inspectedAlbum">{{ inspectedAlbum.artists.join(' / ') }} · {{ inspectedAlbum.trackCount }} 首来源曲目</p>
      <p v-if="inspectionCurrent && currentInspection.capture?.albumId === currentInspection.key.albumId">已取得作者的原只读捕获引用。</p>
      <template v-if="inspectedTrackPage"><p>这里只显示已读取的曲目页：{{ inspectedTrackPage.items.length }} / {{ inspectedTrackPage.total }} 首。</p><ul><li v-for="track in inspectedTrackPage.items" :key="track.facts.track.id">{{ track.facts.metadata.effective.title || track.facts.track.id }}</li></ul></template>
      <LocalLyricsReview v-if="inspectionCurrent" :model="model" :inspection="currentInspection" />
      <button type="button" class="secondary-button workbench-result-button" @click="emit('close-inspection')">关闭原结果检查</button>
    </section>
    <h4>本地歌词事实</h4>
    <button type="button" @click="model.readInventory('all', 0)">全部歌词状态</button><button type="button" @click="model.readInventory('missingLyrics', 0)">缺词状态</button>
    <p v-if="model.inventory.value">{{ model.inventory.value.total }} 张 · 离线或无法读取保留未知，不当作缺词。</p>
    <ul><li v-for="row in model.inventory.value?.rows ?? []" :key="row.albumId">{{ row.albumId }} · {{ row.presence === 'true' ? '已有歌词' : row.presence === 'false' ? '缺歌词' : '未知' }}</li></ul>
    <div v-if="model.inventory.value" class="workbench-controls"><button type="button" :disabled="model.inventoryOffset.value === 0" @click="model.readInventory(model.inventoryFilter.value, Math.max(0, model.inventoryOffset.value - 200))">上一页库存</button><button type="button" :disabled="model.inventoryOffset.value + model.inventory.value.rows.length >= model.inventory.value.total" @click="model.readInventory(model.inventoryFilter.value, model.inventoryOffset.value + 200)">下一页库存</button></div>
    <p v-if="model.error.value" role="alert">{{ model.error.value }}</p>
  </section>
</template>
<style scoped>
.workbench-section .workbench-result-button { min-height: 44px; }
.workbench-result-row { overflow-wrap: anywhere; }
</style>
