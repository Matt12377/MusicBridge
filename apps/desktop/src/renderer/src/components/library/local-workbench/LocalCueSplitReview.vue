<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { localWorkbenchFieldLabels, type LocalWorkbenchController } from '../../../composables/application/local-library-workbench/controller.js'
import type { LocalWorkbenchLibrary } from '../../../composables/application/local-library-workbench/library.js'
const props = defineProps<{ model: LocalWorkbenchController; workspace?: LocalWorkbenchLibrary }>()
const preview = computed(() => props.model.plan.value?.kind === 'cue' ? props.model.plan.value : null)
const page = ref(0), pageSize = 100
const tracks = computed(() => preview.value?.tracks.slice(page.value * pageSize, (page.value + 1) * pageSize) ?? [])
watch(() => preview.value?.planId, () => { page.value = 0 })
function selectCue(albumId: string, event: Event): void { props.model.selectCue(albumId, (event.target as HTMLSelectElement).value) }
function formatTime(frame: number, sampleRate: number): string {
  const seconds = frame / sampleRate, minutes = Math.floor(seconds / 60)
  return String(minutes) + ':' + (seconds % 60).toFixed(3).padStart(6, '0')
}
</script>

<template>
  <section class="workbench-section" aria-labelledby="local-cue-review-title">
    <h3 id="local-cue-review-title">CUE 分轨</h3>
    <p class="workbench-muted">核对轨序与分段，分轨文件生成到独立输出目录。原整轨与 CUE 保留。</p>
    <div v-for="album in model.readback.value?.albums ?? []" :key="album.album.albumId" class="workbench-review-item">
      <h4>{{ album.album.title || '此专辑' }}</h4>
      <label v-if="album.cueSheets.length">CUE 文件
        <select :value="model.cueSelections.value[album.album.albumId] ?? ''" :disabled="model.mutationLocked.value || album.availability !== 'online'" @change="selectCue(album.album.albumId, $event)">
          <option value="">此次不分轨</option>
          <option v-for="cue in album.cueSheets" :key="cue.cueId" :value="cue.cueId" :disabled="!cue.eligible">{{ cue.label }}{{ cue.eligible ? '' : ' · 不可分轨' }}</option>
        </select>
      </label>
      <p v-else class="workbench-muted">当前已保存的读取事实中没有可用 CUE。</p>
      <p v-for="cue in album.cueSheets.filter(value => !value.eligible)" :key="cue.cueId" class="workbench-muted">{{ cue.label }}：{{ cue.reason || '分轨资格尚未确认。' }}</p>
      <p v-if="album.availability !== 'online'" class="workbench-status">来源离线或读取不可用，请恢复后重新读取。</p>
    </div>
    <div class="workbench-controls">
      <label>输出格式
        <select v-if="model.cueFormats.value.length" :value="model.cueFormat.value" :disabled="model.mutationLocked.value" @change="model.setCueFormat(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>选择合格格式</option>
          <option v-for="format in model.cueFormats.value" :key="format.id" :value="format.id" :disabled="!format.availability.available">{{ format.label }}{{ format.availability.available ? '' : ' · 不可用' }}</option>
        </select>
        <span v-else class="workbench-muted">输出格式服务尚未接入。</span>
      </label>
      <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.availability('cue-preview').available" @click="model.chooseCueTarget()">选择独立输出目录</button>
      <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.availability('cue-preview').available || !model.cueTarget.value || !model.cueFormat.value" @click="model.previewCue()">预览分轨计划</button>
    </div>
    <p v-if="model.cueTarget.value" class="workbench-status">输出到：{{ model.cueTarget.value.label }}</p>
    <section v-if="workspace" aria-label="整个音乐库分轨">
      <h4>整个选中库的未分轨专辑</h4><p>由Owner读取完整库捕获并分批处理，当前页面、筛选和100张多选不限制库范围。仍使用上方明确选择的格式与独立输出目录。</p>
      <button type="button" :disabled="workspace.pending.value || !!workspace.originalJob.value || !workspace.selectedLibraryIds.value.length || !model.cueTarget.value || !model.cueFormat.value || !model.availability('cue-preview').available" @click="workspace.startAllCue(model.cueFormat.value, model.cueTarget.value!)">为选中整个库的未分轨专辑生成分轨</button>
    </section>
    <p v-if="!model.availability('cue-preview').available" class="workbench-status">独立分轨服务尚未接入，当前只读内容与原文件保留。</p>
    <p v-for="format in model.cueFormats.value.filter(value => !value.availability.available)" :key="format.id" class="workbench-muted">{{ format.label }}：{{ !format.availability.available ? format.availability.reason : '' }}</p>
    <div v-if="preview" class="workbench-preview">
      <h4>分轨预览 · {{ preview.tracks.length }} 轨</h4>
      <p class="workbench-muted">独立输出：{{ preview.target.label }}</p>
      <div class="workbench-table-scroll">
        <table>
          <thead><tr><th scope="col">轨序</th><th scope="col">来源 / 分段</th><th scope="col">输出文件与格式</th></tr></thead>
          <tbody>
            <tr v-for="track in tracks" :key="track.itemId">
              <td>{{ track.sequence }}</td>
              <td>{{ track.sourceLabel }}<br /><span class="workbench-muted">{{ formatTime(track.startFrame, track.sampleRate) }} → {{ formatTime(track.startFrame + track.frameCount, track.sampleRate) }}</span><br /><small>{{ track.startFrame }} 起 · {{ track.frameCount }} 帧 · {{ track.sampleRate }} Hz</small></td>
              <td>{{ track.outputName }}<br /><span class="workbench-muted">{{ track.outputFormat }}</span>
                <details v-if="track.changes.length"><summary>生成文件的标签</summary><p v-for="change in track.changes" :key="change.field">{{ localWorkbenchFieldLabels[change.field] }}：{{ change.after ?? '未提供' }}</p></details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav v-if="preview.tracks.length > pageSize" class="workbench-controls" aria-label="分轨预览分页">
        <button type="button" class="secondary-button" :disabled="page === 0" @click="page--">上一页</button>
        <span>{{ page + 1 }} / {{ Math.ceil(preview.tracks.length / pageSize) }}</span>
        <button type="button" class="secondary-button" :disabled="(page + 1) * pageSize >= preview.tracks.length" @click="page++">下一页</button>
      </nav>
    </div>
  </section>
</template>
