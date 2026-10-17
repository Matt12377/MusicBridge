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
  <article class="settings-card settings-glass-panel" aria-label="智能名称解析设置">
    <h3>智能名称解析</h3><p>Ollama支持流式解析与批次卸载；vLLM与云端走兼容接口。更改配置后明确保存。</p>
    <form v-if="model.settingsDraft.value" @submit.prevent="model.saveNameSettings()">
      <label>默认后端<select :value="model.settingsDraft.value.backend" :disabled="model.locked.value" @change="chooseBackend"><option v-for="backend in backends" :key="backend.id" :value="backend.id">{{ backend.label }}</option></select></label>
      <fieldset v-for="backend in backends" :key="backend.id" :disabled="model.locked.value"><legend>{{ backend.label }}</legend>
        <label>服务端点<input type="url" :aria-label="`${backend.label}服务端点`" :value="model.settingsDraft.value[backend.id].endpoint" autocomplete="off" @input="edit(backend.id, 'endpoint', ($event.target as HTMLInputElement).value)"></label>
        <label>模型<input type="text" :aria-label="`${backend.label}模型`" :value="model.settingsDraft.value[backend.id].model" maxlength="256" autocomplete="off" @input="edit(backend.id, 'model', ($event.target as HTMLInputElement).value)"></label>
      </fieldset>
      <p>端点不含凭据、query或fragment；云端使用HTTPS。密码与API密钥由Main的本地系统安全输入收取。</p>
      <button type="submit" :disabled="model.locked.value || !model.nameDirty.value">保存模型配置</button>
    </form>
    <p v-else role="status">模型配置尚未读取。</p>
    <p>云端密钥：{{ model.settings.value?.cloud.keyConfigured ? '已在本地保险库配置' : '未配置' }}</p>
    <button type="button" :disabled="model.locked.value" @click="model.configureCloudKey()">打开本地安全输入配置云端密钥</button>
    <button type="button" :disabled="model.writing.value" @click="model.readNameSettings()">重新读取模型设置</button>
    <p v-if="model.originalNameSave.value">上次保存结果未确认；读取实际设置核对，不能换ID重发。</p>
    <p v-if="model.error.value" role="alert">{{ model.error.value }}</p><p v-if="model.notice.value" role="status">{{ model.notice.value }}</p>
  </article>
</template>
<style scoped>
fieldset { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--mb-glass-border); border-radius: 8px; margin: 12px 0; }
label { display: grid; gap: 8px; } input, select { min-height: 44px; max-width: 100%; color: var(--mb-text-primary); background: var(--mb-glass-clear); border: 1px solid var(--mb-glass-border); border-radius: 8px; padding: 8px; }
</style>
