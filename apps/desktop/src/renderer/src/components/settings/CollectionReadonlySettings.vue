<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { createCollectionReadonlyPreference } from './collection-readonly-preference.js'
const preference = createCollectionReadonlyPreference(window.musicBridge)
const { settings, requested, error, saving } = preference
const statusText = computed(() => ({
  off: '使用标准库存查询。', enabling: '正在启用加速查询，库存仍可浏览。',
  ready: settings.value.mode === 'rust' ? '库存加速查询已就绪。' : '使用标准库存查询。',
  stale: '库存已更新，当前使用标准查询；刷新库存后会重新建立加速查询。',
  refreshing: '正在刷新库存查询。', failed: '加速查询暂不可用，当前使用标准库存查询。',
  blocked: '加速查询已停止，请重新打开应用；当前使用标准库存查询。', closing: '正在关闭加速查询，当前使用标准查询。',
})[settings.value.state])
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { void preference.reload(); timer = setInterval(() => { void preference.reload() }, 500) })
onUnmounted(() => { clearInterval(timer); preference.close() })
</script>

<template>
  <article class="settings-card settings-glass-panel collection-query-settings" aria-labelledby="collection-query-heading">
    <header class="module-heading">
      <div><h3 id="collection-query-heading">实体收藏查询</h3><p class="module-description">选择实体音乐与空白磁带库存的列表查询方式。</p></div>
      <span class="status-badge" :class="{ 'is-ready': settings.state === 'ready' && settings.mode === 'rust', 'is-warning': ['failed', 'blocked', 'stale'].includes(settings.state) }">{{ saving ? '保存中' : { off: '标准查询', enabling: '启用中', ready: settings.mode === 'rust' ? '加速已启用' : '标准查询', stale: '待刷新', refreshing: '刷新中', failed: '暂不可用', blocked: '已停止', closing: '关闭中' }[settings.state] }}</span>
    </header>
    <div class="setting-row"><label class="query-control"><span class="row-copy"><span class="row-title">加速库存列表</span><span class="row-description">默认关闭，只影响列表读取。</span></span><input type="checkbox" aria-label="Rust 收藏查询" :checked="requested" @change="preference.select(($event.target as HTMLInputElement).checked)"></label></div>
    <p class="feedback" :class="{ 'is-warning': ['failed', 'blocked', 'stale'].includes(settings.state) }" data-testid="collection-readonly-state" :data-state="settings.state" :data-mode="settings.mode" :data-enabled="settings.enabled" role="status">{{ saving ? '正在保存查询偏好…' : statusText }}</p>
    <p v-if="error" class="feedback is-error" role="alert">{{ error }}</p>
    <details class="settings-disclosure"><summary>查询引擎与诊断</summary><div class="disclosure-content"><dl><div><dt>当前引擎</dt><dd>{{ settings.mode === 'rust' ? 'Rust 只读查询' : '标准库存服务' }}</dd></div><div><dt>加速偏好</dt><dd>{{ settings.enabled ? '已开启' : '已关闭' }}</dd></div></dl><p>保存库存、编辑资料和查看型号详情仍由标准库存服务处理。</p></div></details>
  </article>
</template>

<style scoped>
.collection-query-settings.settings-card.settings-glass-panel { min-height: 0; color: var(--mb-text-primary); background: var(--mb-glass-clear); box-shadow: none; }
.module-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 8px; }
h3, p, dl, dd { margin: 0; }
h3 { font-size: 16px; line-height: 1.4; font-weight: 650; }
.module-description, .row-description { margin-top: 5px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.65; }
.status-badge { flex-shrink: 0; padding: 4px 9px; border: 1px solid var(--mb-glass-border); border-radius: 999px; color: var(--mb-text-secondary); font-size: 11px; line-height: 1.4; }
.status-badge.is-ready { color: var(--mb-success); border-color: color-mix(in srgb, var(--mb-success) 35%, transparent); }
.is-warning { color: var(--mb-warning); }
.is-error { color: var(--mb-danger); }
.setting-row { min-height: 76px; padding: 16px 0; border-bottom: 1px solid var(--mb-glass-border); }
.query-control { display: flex; align-items: center; justify-content: space-between; gap: 24px; width: 100%; cursor: pointer; }
.row-copy { display: grid; min-width: 0; }
.row-title { font-size: 13px; line-height: 1.5; font-weight: 600; }
.query-control input { flex-shrink: 0; width: 18px; height: 18px; margin: 0 2px; accent-color: var(--mb-accent); cursor: pointer; }
.feedback { margin-top: 12px; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.settings-disclosure { margin-top: 14px; }
summary { width: fit-content; min-height: 32px; padding: 5px 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.6; cursor: pointer; }
.settings-disclosure[open] > summary { color: var(--mb-text-primary); }
.disclosure-content { display: grid; gap: 12px; margin-top: 8px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.7; }
dl { display: grid; gap: 8px; }
dl > div { display: flex; justify-content: space-between; gap: 20px; }
dd { color: var(--mb-text-primary); }
input:focus-visible, summary:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
@media (max-width: 560px) { .module-heading { flex-wrap: wrap; gap: 10px; } }
</style>
