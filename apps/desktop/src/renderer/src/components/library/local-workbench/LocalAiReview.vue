<script setup lang="ts">
import { computed } from 'vue'
import type { LocalAiBackend } from '../../../composables/application/local-library-workbench/types.js'
import { localWorkbenchFieldLabels, type LocalWorkbenchController } from '../../../composables/application/local-library-workbench/controller.js'
const props = defineProps<{ model: LocalWorkbenchController }>()
const backend = computed(() => props.model.backendOptions.value.find(value => value.id === props.model.aiBackend.value))
const albumTitle = (albumId: string) => props.model.albums.value.find(value => value.albumId === albumId)?.title || '此专辑'
const stateLabels = { queued: '等待解析', running: '正在解析', ready: '候选已返回', failed: '解析失败', cancelled: '已取消' }
const valueText = (value: string | null) => value === null ? '未提供' : value === '' ? '空值' : value
function changeBackend(event: Event): void { props.model.setAiBackend((event.target as HTMLSelectElement).value as LocalAiBackend) }
</script>

<template>
  <section class="workbench-section" aria-labelledby="local-ai-review-title">
    <h3 id="local-ai-review-title">名称智能解析</h3>
    <p class="workbench-muted">对明确选择的专辑生成名称候选，先核对理由与字段变化，再选择需要应用的建议。</p>
    <div class="workbench-controls">
      <label>解析后端
        <select :value="model.aiBackend.value" :disabled="model.mutationLocked.value" @change="changeBackend">
          <option v-for="option in model.backendOptions.value" :key="option.id" :value="option.id">
            {{ option.label }}{{ option.availability.available ? '' : ' · 暂不可用' }}
          </option>
        </select>
      </label>
      <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !backend?.availability.available || !model.readback.value" @click="model.requestAiSuggestions()">
        请求 {{ model.albums.value.length }} 张专辑的建议
      </button>
      <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.existingAvailability('ai-settings').available" @click="model.openExisting('ai-settings')">智能解析设置</button>
      <button v-if="model.suggesting.value" type="button" class="secondary-button" @click="model.cancelPreparation()">停止本次解析</button>
    </div>
    <p v-if="backend && !backend.availability.available" class="workbench-status" role="status">{{ backend.availability.reason }}</p>
    <p v-if="model.aiResults.value.length" class="workbench-muted" role="status">已处理 {{ model.aiCompleted.value }} / {{ model.aiResults.value.length }} 张；已选择 {{ model.selectedAiCount.value }} 张的候选。</p>
    <p v-else class="workbench-muted">尚未请求模型建议。</p>
    <article v-for="result in model.aiResults.value" :key="result.albumId" class="workbench-review-item" :data-album-id="result.albumId">
      <header class="workbench-inline-header"><h4>{{ albumTitle(result.albumId) }}</h4><span class="workbench-muted">{{ stateLabels[result.state] }}</span></header>
      <p v-if="result.message" :class="['workbench-status', { 'is-error': result.state === 'failed' }]" :role="result.state === 'failed' ? 'alert' : 'status'">{{ result.message }}</p>
      <fieldset v-if="result.candidates.length" class="workbench-candidates" :disabled="model.mutationLocked.value">
        <legend class="workbench-sr-only">选择 {{ albumTitle(result.albumId) }} 的实际名称候选</legend>
        <label v-for="candidate in result.candidates" :key="candidate.candidateId" class="workbench-ai-candidate">
          <span class="workbench-candidate-title"><input type="radio" :name="'local-ai-' + result.albumId" :checked="result.selectedCandidateId === candidate.candidateId" @change="model.selectAiCandidate(result.albumId, candidate.candidateId)" /><strong>{{ candidate.artist }} · {{ candidate.title }}</strong></span>
          <span class="workbench-muted">{{ candidate.reason }}</span>
          <span class="workbench-change-list">
            <span v-for="change in candidate.changes" :key="change.field" class="workbench-change">
              <strong>{{ localWorkbenchFieldLabels[change.field] }}</strong>
              <span>{{ valueText(change.before) }}</span><span aria-label="变更为">→</span><span>{{ valueText(change.after) }}</span>
              <small>{{ change.reason }}</small>
            </span>
          </span>
        </label>
        <button v-if="result.selectedCandidateId" type="button" class="secondary-button" @click="model.selectAiCandidate(result.albumId, null)">不采用此专辑建议</button>
      </fieldset>
    </article>
    <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.selectedAiCount.value || !model.availability('ai-preview').available" @click="model.previewAi()">预览选中建议的变化</button>
    <p v-if="!model.availability('ai-preview').available" class="workbench-muted">{{ model.availability('ai-preview').available === false ? '建议应用计划尚未接入；原字段保留。' : '' }}</p>
  </section>
</template>
