<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { MobileConnectionSettings } from '../../../../shared/mobile-settings.js'

const api = window.musicBridgeMobile
const capable = typeof api?.getMobileConnectionSettings === 'function' && typeof api?.configureMobileConnection === 'function'
const settings = ref<MobileConnectionSettings | null>(null), host = ref('127.0.0.1'), port = ref(45391)
const busy = ref(false), message = ref(''), permit = ref<{ pairingSecret: string; expiresAt: string } | null>(null)
const labels = { off: '已关闭', starting: '启动中', ready: '可配对', closing: '关闭中', failed: '连接未就绪' }
const connection = computed(() => settings.value?.connection ? JSON.stringify(settings.value.connection, null, 2) : '')
let active = true, generation = 0, expiry: ReturnType<typeof setTimeout> | undefined
function clearPermit() { clearTimeout(expiry); permit.value = null }
async function refresh() {
  const own = ++generation
  try {
    const value = await api!.getMobileConnectionSettings!()
    if (!active || own !== generation) return
    settings.value = value; host.value = value.host; port.value = value.port
    if (value.state !== 'ready') clearPermit()
  } catch { if (active && own === generation) message.value = '移动连接状态未能读取。' }
}
async function configure(enabled: boolean) {
  if (busy.value) return
  busy.value = true; message.value = ''; clearPermit(); const own = ++generation
  try {
    const value = await api!.configureMobileConnection!({ enabled, host: host.value, port: Number(port.value) })
    if (active && own === generation) { settings.value = value; if (value.state === 'failed') message.value = '服务未能启动，请检查地址、端口及安全存储。' }
  } catch { if (active && own === generation) message.value = '移动连接配置未获确认，请刷新状态。' }
  finally { if (active) busy.value = false }
}
async function issue() {
  if (busy.value || settings.value?.state !== 'ready') return
  busy.value = true; message.value = ''; clearPermit(); const own = ++generation
  try {
    const value = await api!.issueMobilePairing!()
    if (active && own === generation) { permit.value = value; expiry = setTimeout(clearPermit, Math.max(0, Date.parse(value.expiresAt) - Date.now())) }
  } catch { if (active && own === generation) message.value = '配对许可未能生成，请刷新连接状态。' }
  finally { if (active) busy.value = false }
}
async function revoke(deviceId: string) {
  if (busy.value) return
  busy.value = true; message.value = ''; const own = ++generation
  try { const value = await api!.revokeMobileDevice!(deviceId); if (active && own === generation) settings.value = value }
  catch { if (active && own === generation) message.value = '撤销结果未获确认，请刷新设备列表。' }
  finally { if (active) busy.value = false }
}
async function copy(value: string) { try { await navigator.clipboard.writeText(value); message.value = '已复制。' } catch { message.value = '复制未完成，可直接选择下面的文本。' } }
onMounted(() => { if (capable) void refresh() })
onUnmounted(() => { active = false; generation++; clearPermit() })
</script>

<template>
  <article class="settings-card settings-glass-panel" data-mobile-connection-settings>
    <div class="panel-heading"><div><p class="section-kicker">移动连接</p><h3>手机配对与只读音乐库</h3></div><span class="settings-status-pill">{{ settings ? labels[settings.state] : '尚未读取' }}</span></div>
    <p class="muted-copy">手机可浏览已有的独立发行、曲目和封面，并播放受支持的本地音频。</p>
    <p v-if="!capable" class="settings-note">移动连接服务尚未就绪。</p>
    <template v-else>
      <div class="mobile-connection-fields">
        <label>本机地址<select v-model="host" :disabled="busy || settings?.enabled" aria-label="移动连接地址"><option v-for="value in settings?.hosts ?? ['127.0.0.1']" :key="value" :value="value">{{ value }}{{ value === '127.0.0.1' ? '（仅本机）' : '' }}</option></select></label>
        <label>端口<input v-model.number="port" type="number" min="1024" max="65535" :disabled="busy || settings?.enabled" aria-label="移动连接端口" /></label>
      </div>
      <div class="button-row"><button type="button" class="secondary-button" :disabled="busy" @click="configure(!settings?.enabled)">{{ settings?.enabled ? '关闭移动连接' : '开启移动连接' }}</button><button type="button" class="text-button" :disabled="busy" @click="refresh">刷新状态</button></div>
      <template v-if="settings?.state === 'ready' && settings.connection">
        <p class="muted-copy">在手机中采纳本台服务器的连接资料及证书，再使用五分钟单次配对许可。</p>
        <div class="button-row"><button type="button" class="secondary-button" @click="copy(connection)">复制连接资料</button><button type="button" class="primary-button" :disabled="busy" @click="issue">生成配对许可</button></div>
        <details><summary>连接资料与公开证书</summary><textarea readonly :value="connection" aria-label="移动连接公开资料" rows="7" /></details>
        <div v-if="permit" class="mobile-pairing-permit"><label>本次配对许可<input readonly :value="permit.pairingSecret" aria-label="本次配对许可" /></label><p class="muted-copy">有效至 {{ new Date(permit.expiresAt).toLocaleTimeString() }}；使用后即失效。</p><button type="button" class="text-button" @click="copy(permit.pairingSecret)">复制配对许可</button></div>
        <ul v-if="settings.devices.length" class="mobile-paired-devices"><li v-for="device in settings.devices" :key="device.deviceId"><span>{{ device.deviceName }} · {{ device.revoked ? '已撤销' : '已配对' }}</span><button v-if="!device.revoked" type="button" class="text-button" :disabled="busy" @click="revoke(device.deviceId)">撤销此设备</button></li></ul>
        <p v-else class="muted-copy">尚无已配对设备。</p>
      </template>
      <p v-if="message" role="status" class="settings-note">{{ message }}</p>
    </template>
  </article>
</template>

<style scoped>
.mobile-connection-fields { display: flex; flex-wrap: wrap; gap: 16px; margin: 16px 0; }
.mobile-connection-fields label, .mobile-pairing-permit label { display: grid; gap: 8px; flex: 1; min-width: 160px; }
select, input, textarea { box-sizing: border-box; width: 100%; padding: 9px 12px; border: 1px solid var(--border-subtle); border-radius: 10px; background: transparent; color: inherit; }
textarea { margin-top: 10px; resize: vertical; font-family: monospace; }
.mobile-pairing-permit { margin-top: 18px; }
.mobile-paired-devices { padding: 0; list-style: none; }
.mobile-paired-devices li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }
details { margin-top: 12px; }
</style>
