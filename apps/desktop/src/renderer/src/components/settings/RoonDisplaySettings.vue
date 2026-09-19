<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { normalizeRoonDisplayUrl, type RoonDisplaySettings } from '@music-bridge/contracts'

const state = ref<RoonDisplaySettings>({ url: '', status: 'disabled' })
const draft = ref('')
const busy = ref(false)
const error = ref('')
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
let revision = 0
const labels: Record<RoonDisplaySettings['status'], string> = {
  disabled: '未启用', connecting: '正在连接', connected: '已连接', disconnected: '连接中断，自动重连中', error: '连接不可用',
}
async function refresh(initial = false): Promise<void> {
  const requestRevision = revision
  const previousDraft = draft.value
  try {
    const next = await window.musicBridge.getRoonDisplaySettings()
    if (disposed) return
    if (requestRevision === revision && !busy.value) {
      state.value = next
      if (initial && draft.value === previousDraft) draft.value = next.url
    }
  } catch { if (!disposed) error.value = '无法读取歌词连接状态，请稍后重新进入设置。' }
  if (!disposed) timer = setTimeout(() => { void refresh() }, 2500)
}
async function save(disable = false): Promise<void> {
  if (busy.value) return
  error.value = ''
  let url: string
  try { url = normalizeRoonDisplayUrl(disable ? '' : draft.value) } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '请检查地址。'
    return
  }
  busy.value = true
  revision++
  try {
    const next = await window.musicBridge.configureRoonDisplay(url)
    if (!disposed) { state.value = next; draft.value = next.url }
  } catch { if (!disposed) error.value = '保存未成功，请检查地址后重试。原设置保持不变。' }
  finally { busy.value = false }
}
onMounted(() => { void refresh(true) })
onUnmounted(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <article class="settings-card settings-glass-panel roon-display-settings">
    <div class="panel-heading"><div><p class="section-kicker">歌词来源</p><h3>Roon Web Display</h3></div><span role="status">{{ labels[state.status] }}</span></div>
    <p class="muted-copy">本地歌曲读取 Roon 正在显示的歌词，不再自动匹配网易云；网易云歌曲的歌词保持不变。</p>
    <form @submit.prevent="save()">
      <label class="field-label" for="roon-display-url">Web Display 地址</label>
      <input id="roon-display-url" v-model="draft" type="url" autocomplete="off" spellcheck="false" :disabled="busy" :aria-invalid="!!error" aria-describedby="roon-display-help roon-display-error" placeholder="http://局域网地址:9330/display/">
      <p id="roon-display-help" class="muted-copy">地址位于 Roon 设置 → Displays。要使用内嵌 LRC，请在 Roon 导入设置中将歌词和同步歌词设为“优先文件”。</p>
      <p v-if="error" id="roon-display-error" class="display-error" role="alert">{{ error }}</p>
      <div class="display-actions">
        <button class="secondary-button" type="submit" :disabled="busy || !draft.trim()">{{ busy ? '保存中…' : '保存并连接' }}</button>
        <button class="text-button" type="button" :disabled="busy || !state.url" @click="save(true)">停用，恢复网易云匹配</button>
      </div>
    </form>
    <p class="muted-copy">只处理内存中的歌词，不修改音乐文件。连接中断时清除旧歌词并自动重连，不影响音频播放。</p>
  </article>
</template>

<style scoped>
.roon-display-settings { margin-bottom: 20px; }
form { display: grid; gap: 12px; min-width: 0; }
input { width: 100%; min-width: 0; box-sizing: border-box; padding: 12px; color: var(--mb-text-primary); background: var(--mb-glass-clear, transparent); border: 1px solid var(--mb-glass-border); border-radius: 10px; font: inherit; }
input:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 2px; }
.display-actions { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
.display-actions button { color: var(--mb-text-primary); }
.display-error { color: var(--mb-danger); margin: 0; }
.panel-heading { flex-wrap: wrap; gap: 8px; }
</style>
