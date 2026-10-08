<script setup lang="ts">
import { markRaw, onMounted, onUnmounted } from 'vue'
import { useLocalSourceWrites } from '../../composables/application/useLocalSourceWrites.js'
const session = markRaw(useLocalSourceWrites({ api: window.musicBridge }))
onMounted(() => { void session.open(null, '源文件写入设置') })
onUnmounted(() => session.dispose())
</script>
<template>
  <article class="settings-card settings-glass-panel" aria-labelledby="source-write-settings-heading" data-testid="source-write-settings"><div class="panel-heading"><div><p class="section-kicker">本地数字音乐</p><h3 id="source-write-settings-heading">源文件写入</h3></div></div>
    <p class="settings-note">默认关闭。开启后，每次仍须生成具体预览并确认；MB 信息整理与选图继续只保存到 MB。</p>
    <p v-if="session.loading.value" role="status">正在读取源写设置…</p>
    <label v-if="session.context.value"><input type="checkbox" :checked="session.context.value.policy.enabled" :disabled="session.busy.value || session.unknown.value || session.datasetChanged.value" aria-label="允许具体源文件写入" @change="session.setPolicy(($event.target as HTMLInputElement).checked)">允许具体源文件写入</label>
    <p v-if="session.context.value?.policy.draining" role="status">已阻止新写入；已有保全任务正在安全收尾。</p>
    <p v-if="session.error.value" role="alert">{{ session.error.value }}</p><p v-if="session.notice.value" role="status">{{ session.notice.value }}</p>
    <button type="button" :disabled="session.busy.value" @click="session.reconcile()">重新读取源写设置</button>
  </article>
</template>
