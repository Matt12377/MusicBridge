<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { createCollectionReadonlyPreference } from './collection-readonly-preference.js'
const preference = createCollectionReadonlyPreference(window.musicBridge)
const { settings, requested, error, saving } = preference
const statusText = computed(() => ({
  off: '已关闭，使用标准库存查询。', enabling: '正在启用；标准库存查询仍可使用。',
  ready: settings.value.mode === 'rust' ? 'Rust 收藏查询已就绪。' : '使用标准库存查询。',
  stale: '库存已更新，当前使用标准查询；刷新库存后重新建立 Rust 查询。',
  refreshing: '正在刷新库存查询。', failed: 'Rust 查询暂不可用，标准库存查询仍可使用。',
  blocked: 'Rust 查询已停止；请重新打开应用。标准库存查询仍可使用。', closing: '正在关闭 Rust 查询，当前使用标准查询。',
})[settings.value.state])
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { void preference.reload(); timer = setInterval(() => { void preference.reload() }, 500) })
onUnmounted(() => { clearInterval(timer); preference.close() })
</script>

<template>
  <article class="settings-card settings-glass-panel">
    <div class="panel-heading"><div><p class="section-kicker">收藏</p><h3>Rust 收藏查询</h3></div></div>
    <label><input type="checkbox" aria-label="Rust 收藏查询" :checked="requested" @change="preference.select(($event.target as HTMLInputElement).checked)"> 使用可选 Rust 库存列表查询</label>
    <p class="settings-note">默认关闭。只影响库存列表读取；保存、型号详情仍使用标准库存服务。</p>
    <p data-testid="collection-readonly-state" :data-state="settings.state" :data-mode="settings.mode" :data-enabled="settings.enabled" role="status">{{ saving ? '正在保存查询偏好…' : statusText }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </article>
</template>
