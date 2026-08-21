<script setup lang="ts">
import { onMounted, ref } from 'vue'

import type { AppInfo } from '../../preload/api.js'

const appInfo = ref<AppInfo | null>(null)

onMounted(async () => {
  appInfo.value = await window.musicBridge.getAppInfo()
})
</script>

<template>
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">安全桌面空壳</p>
      <h1>Music Bridge for Roon</h1>
      <p class="description">本地桌面控制面板占位，当前不提供登录、搜索或播放功能。</p>
    </header>

    <section class="info-card" aria-label="应用信息">
      <h2>应用信息</h2>
      <dl>
        <div><dt>App 版本</dt><dd>{{ appInfo?.version ?? '读取中' }}</dd></div>
        <div><dt>构建模式</dt><dd>{{ appInfo?.buildMode ?? '读取中' }}</dd></div>
        <div><dt>平台</dt><dd>{{ appInfo?.platform ?? '读取中' }}</dd></div>
      </dl>
    </section>

    <section class="status-grid" aria-label="运行状态占位">
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>Roon 状态</h2>
        <p>占位：TASK-012 接入 typed IPC 后显示。</p>
      </article>
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>网易云状态</h2>
        <p>占位：本任务不读取真实凭据。</p>
      </article>
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>Bridge Core 状态</h2>
        <p>占位：TASK-012 接入 utilityProcess 后显示。</p>
      </article>
    </section>
  </main>
</template>
