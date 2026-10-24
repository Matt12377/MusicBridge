<script setup lang="ts">
import { markRaw, onMounted, onUnmounted } from 'vue'
import { useLocalSourceWrites } from '../../composables/application/useLocalSourceWrites.js'
const session = markRaw(useLocalSourceWrites({ api: window.musicBridge }))
onMounted(() => { void session.open(null, '源文件写入设置') })
onUnmounted(() => session.dispose())
</script>
<template>
  <article class="settings-card settings-glass-panel source-write-settings" aria-labelledby="source-write-settings-heading" data-testid="source-write-settings">
    <header class="module-heading">
      <div><h3 id="source-write-settings-heading">源文件写入</h3><p class="module-description">允许将确认过的整理结果写回本地音乐文件。</p></div>
      <span class="status-badge" :class="{ 'is-warning': session.unknown.value || session.datasetChanged.value || session.context.value?.policy.draining, 'is-enabled': session.context.value?.policy.enabled }" role="status">{{ session.loading.value ? '读取中' : session.datasetChanged.value ? '工作库已切换' : session.unknown.value ? '操作待核对' : session.context.value?.policy.draining ? '正在收尾' : session.context.value ? session.context.value.policy.enabled ? '已允许' : '已关闭' : '尚未就绪' }}</span>
    </header>
    <div class="setting-row">
      <label v-if="session.context.value" class="policy-control"><span class="row-copy"><span class="row-title">允许修改源文件</span><span class="row-description">默认关闭。每次写入前仍需预览并确认。</span></span><input type="checkbox" :checked="session.context.value.policy.enabled" :disabled="session.busy.value || session.unknown.value || session.datasetChanged.value" aria-label="允许具体源文件写入" @change="session.setPolicy(($event.target as HTMLInputElement).checked)"></label>
      <div v-else class="row-copy"><h4>允许修改源文件</h4><p>读取设置后，可查看和更改写入权限。</p></div>
    </div>
    <p v-if="session.loading.value" class="feedback" role="status">正在读取源写设置…</p>
    <p v-if="session.context.value?.policy.draining" class="feedback is-warning" role="status">已阻止新写入；已有保全任务正在安全收尾。</p>
    <p v-if="session.unknown.value" class="feedback is-warning" role="status">有原操作尚未确认，请先核对状态；系统不会自动重发。</p>
    <p v-if="session.datasetChanged.value" class="feedback is-warning" role="status">工作库已切换，当前设置暂时不可修改。原操作记录仍然保留。</p>
    <p v-if="session.error.value" class="feedback is-error" role="alert">{{ session.error.value }}</p>
    <p v-if="session.notice.value" class="feedback" role="status">{{ session.notice.value }}</p>
    <div class="setting-actions"><button type="button" class="secondary-button" :disabled="session.busy.value" @click="session.reconcile()">{{ session.unknown.value ? '核对操作状态' : '刷新设置' }}</button></div>
    <details class="settings-disclosure"><summary>写入范围与保护</summary><div class="disclosure-copy"><p>开启此项只允许进入源文件写入流程，实际文件和修改内容以每次操作的预览为准。</p><p>只在 MB 内整理资料或选择封面时，结果仍保存在 MB，不会因此改写源文件。</p></div></details>
  </article>
</template>

<style scoped>
.source-write-settings.settings-card.settings-glass-panel { min-height: 0; color: var(--mb-text-primary); background: var(--mb-glass-clear); box-shadow: none; }
.module-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 8px; }
h3, h4, p { margin: 0; }
h3 { font-size: 16px; line-height: 1.4; font-weight: 650; }
h4, .row-title { font-size: 13px; line-height: 1.5; font-weight: 600; }
.module-description, .row-copy p, .row-description { margin-top: 5px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.65; }
.status-badge { flex-shrink: 0; padding: 4px 9px; border: 1px solid var(--mb-glass-border); border-radius: 999px; color: var(--mb-text-secondary); font-size: 11px; line-height: 1.4; }
.status-badge.is-enabled { color: var(--mb-accent); }
.is-warning, .status-badge.is-warning { color: var(--mb-warning); }
.is-error { color: var(--mb-danger); }
.setting-row { display: flex; align-items: center; min-height: 76px; padding: 16px 0; border-bottom: 1px solid var(--mb-glass-border); }
.policy-control { display: flex; align-items: center; justify-content: space-between; gap: 24px; width: 100%; cursor: pointer; }
.row-copy { display: grid; min-width: 0; }
.policy-control input { flex-shrink: 0; width: 18px; height: 18px; margin: 0 2px; accent-color: var(--mb-accent); cursor: pointer; }
.policy-control input:disabled { cursor: default; opacity: .5; }
.policy-control:has(input:disabled) { cursor: default; }
.feedback { margin-top: 12px; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.setting-actions { display: flex; margin-top: 16px; }
button { min-height: 36px; font: inherit; font-size: 12px; }
button:disabled { cursor: default; opacity: .5; }
.settings-disclosure { margin-top: 14px; }
summary { width: fit-content; min-height: 32px; padding: 5px 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.6; cursor: pointer; }
.settings-disclosure[open] > summary { color: var(--mb-text-primary); }
.disclosure-copy { display: grid; gap: 8px; margin-top: 8px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.7; }
input:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
@media (max-width: 560px) { .module-heading { flex-wrap: wrap; gap: 10px; } }
</style>
