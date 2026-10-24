<script setup lang="ts">
import { onMounted } from 'vue'
import type { LocalAiBackend } from '@music-bridge/contracts'
import type { LocalWorkbenchLibrary } from '../../composables/application/local-library-workbench/library.js'
const props = defineProps<{ model: LocalWorkbenchLibrary }>()
const backends = [{ id: 'ollama', label: '本地Ollama' }, { id: 'vllm', label: 'vLLM（OpenAI兼容）' }, { id: 'cloud', label: '云端OpenAI兼容' }] as const
function edit(backend: LocalAiBackend, field: 'endpoint' | 'model', value: string): void {
  const draft = props.model.settingsDraft.value
  if (draft) props.model.editName({ ...draft, [backend]: { ...draft[backend], [field]: value } })
}
function chooseBackend(event: Event): void {
  const backend = (event.target as HTMLSelectElement).value
  const draft = props.model.settingsDraft.value
  if (draft && backends.some(v => v.id === backend)) props.model.editName({ ...draft, backend: backend as LocalAiBackend })
}
onMounted(() => { void props.model.readNameSettings() })
</script>
<template>
  <article class="settings-card settings-glass-panel ai-settings" aria-label="智能名称解析设置">
    <header class="module-heading">
      <div><h3>智能名称解析</h3><p class="module-description">为音乐文件和文件夹名称选择解析服务。</p></div>
      <span class="status-badge" :class="{ 'is-warning': model.originalNameSave.value || model.nameDirty.value }" role="status">{{ model.originalNameSave.value ? '保存待确认' : model.nameDirty.value ? '有未保存更改' : model.settingsDraft.value ? '已读取' : '尚未读取' }}</span>
    </header>
    <div class="setting-row">
      <div class="row-copy"><h4>当前解析服务</h4><p>{{ model.settings.value ? { ollama: '本机模型', vllm: '自托管服务', cloud: '云端服务' }[model.settings.value.backend] : '设置尚未读取。' }}</p></div>
      <button type="button" class="secondary-button" :disabled="model.writing.value" @click="model.readNameSettings()">{{ model.originalNameSave.value ? '核对保存结果' : '刷新设置' }}</button>
    </div>
    <p v-if="!model.settingsDraft.value" class="feedback" role="status">模型配置尚未读取。</p>
    <p v-if="model.originalNameSave.value" class="feedback is-warning" role="status">上次保存结果尚未确认，请先重新读取设置核对。</p>
    <p v-if="model.locked.value && !model.originalNameSave.value" class="feedback" role="status">当前操作尚未结束，暂时无法修改解析配置。</p>
    <details class="settings-disclosure">
      <summary><span>服务与模型配置</span><span v-if="model.nameDirty.value" class="disclosure-hint">待保存</span></summary>
      <form v-if="model.settingsDraft.value" class="service-form" @submit.prevent="model.saveNameSettings()">
        <label>默认解析服务<select :value="model.settingsDraft.value.backend" :disabled="model.locked.value" @change="chooseBackend"><option v-for="backend in backends" :key="backend.id" :value="backend.id">{{ backend.label }}</option></select></label>
        <details v-for="backend in backends" :key="backend.id" class="backend-settings" :open="model.settingsDraft.value.backend === backend.id">
          <summary>{{ backend.label }}<span v-if="model.settingsDraft.value.backend === backend.id" class="disclosure-hint">当前选择</span></summary>
          <fieldset :disabled="model.locked.value"><legend class="visually-hidden">{{ backend.label }}连接参数</legend>
            <label>服务地址<input type="url" :aria-label="`${backend.label}服务端点`" :value="model.settingsDraft.value[backend.id].endpoint" autocomplete="off" spellcheck="false" @input="edit(backend.id, 'endpoint', ($event.target as HTMLInputElement).value)"></label>
            <label>模型名称<input type="text" :aria-label="`${backend.label}模型`" :value="model.settingsDraft.value[backend.id].model" maxlength="256" autocomplete="off" spellcheck="false" @input="edit(backend.id, 'model', ($event.target as HTMLInputElement).value)"></label>
          </fieldset>
        </details>
        <p class="detail-copy">服务地址不能包含凭据、查询参数或片段；云端地址须使用 HTTPS。</p>
        <div class="save-row"><p class="detail-copy">{{ model.nameDirty.value ? '配置已更改，保存后生效。' : '更改后需保存才会生效。' }}</p><button type="submit" class="primary-button" :disabled="model.locked.value || !model.nameDirty.value">保存配置</button></div>
      </form>
    </details>
    <details class="settings-disclosure credential-settings">
      <summary>云端访问密钥<span class="disclosure-hint">{{ !model.settings.value ? '尚未读取' : model.settings.value.cloud.keyConfigured ? '已配置' : '未配置' }}</span></summary>
      <div class="credential-row"><p class="detail-copy">通过本机安全输入配置，密钥保存在本地保险库。</p><button type="button" class="secondary-button" :disabled="model.locked.value" @click="model.configureCloudKey()">{{ model.settings.value?.cloud.keyConfigured ? '更新云端密钥' : '配置云端密钥' }}</button></div>
    </details>
    <p v-if="model.error.value" class="feedback is-error" role="alert">{{ model.error.value }}</p>
    <p v-if="model.notice.value" class="feedback" role="status">{{ model.notice.value }}</p>
  </article>
</template>
<style scoped>
.ai-settings.settings-card.settings-glass-panel { min-height: 0; color: var(--mb-text-primary); background: var(--mb-glass-clear); box-shadow: none; }
.module-heading, .setting-row, .save-row, .credential-row { display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.module-heading { align-items: flex-start; margin-bottom: 8px; }
h3, h4, p { margin: 0; }
h3 { font-size: 16px; line-height: 1.4; font-weight: 650; }
h4 { font-size: 13px; line-height: 1.5; font-weight: 600; }
.module-description, .row-copy p, .detail-copy { margin-top: 5px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.65; }
.status-badge { flex-shrink: 0; padding: 4px 9px; border: 1px solid var(--mb-glass-border); border-radius: 999px; color: var(--mb-text-secondary); font-size: 11px; line-height: 1.4; }
.is-warning { color: var(--mb-warning); }
.is-error { color: var(--mb-danger); }
.setting-row { min-height: 72px; padding: 16px 0; border-bottom: 1px solid var(--mb-glass-border); }
.row-copy { min-width: 0; }
button { flex-shrink: 0; min-height: 36px; font: inherit; font-size: 12px; }
button:disabled { cursor: default; opacity: .5; }
.settings-disclosure { margin-top: 14px; }
summary { min-height: 32px; padding: 6px 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.6; cursor: pointer; }
.settings-disclosure[open] > summary { color: var(--mb-text-primary); }
.disclosure-hint { margin-left: 12px; color: var(--mb-text-secondary); font-size: 11px; }
.service-form { display: grid; gap: 16px; margin-top: 12px; }
label { display: grid; gap: 8px; min-width: 0; color: var(--mb-text-secondary); font-size: 12px; }
input, select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; color: var(--mb-text-primary); background: var(--mb-glass-clear); border: 1px solid var(--mb-glass-border); border-radius: 9px; padding: 9px 12px; font: inherit; font-size: 13px; }
.backend-settings { padding: 0 14px; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: transparent; }
.backend-settings > summary { padding: 10px 0; color: var(--mb-text-primary); }
fieldset { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 14px; min-width: 0; margin: 0; padding: 4px 0 16px; border: 0; }
.save-row { padding-top: 14px; border-top: 1px solid var(--mb-glass-border); }
.credential-row { margin-top: 10px; }
.feedback { margin-top: 12px; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
@media (max-width: 640px) {
  .module-heading { flex-wrap: wrap; gap: 10px; }
  fieldset { grid-template-columns: minmax(0, 1fr); }
  .credential-row, .save-row { align-items: flex-start; flex-direction: column; gap: 12px; }
}
</style>
