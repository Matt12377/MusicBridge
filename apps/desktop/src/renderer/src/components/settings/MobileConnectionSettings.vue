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
    // 首次开启优先选可用局域网地址；仍可在高级选项指定网卡。
    const selectedHost = enabled && host.value === '127.0.0.1'
      ? settings.value?.hosts.find(value => value.startsWith('192.168.'))
        ?? settings.value?.hosts.find(value => value !== '127.0.0.1') ?? host.value : host.value
    const value = await api!.configureMobileConnection!({ enabled, host: selectedHost, port: Number(port.value) })
    host.value = value.host
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
  <article class="settings-card settings-glass-panel mobile-settings" data-mobile-connection-settings aria-labelledby="mobile-settings-heading">
    <header class="module-heading">
      <div><h3 id="mobile-settings-heading">手机连接</h3><p class="module-description">在手机上浏览音乐库，播放受支持的本地音乐。</p></div>
      <span class="status-badge" :class="{ 'is-ready': settings?.state === 'ready', 'is-warning': !capable || settings?.state === 'failed' }" role="status">{{ !capable ? '尚未就绪' : settings ? labels[settings.state] : '尚未读取' }}</span>
    </header>
    <p v-if="!capable" class="feedback is-warning" role="status">移动连接服务尚未就绪。</p>
    <template v-else>
      <div class="setting-row">
        <div class="row-copy"><h4>允许手机连接</h4><p>手机与这台电脑需要连接同一网络。</p></div>
        <div class="row-actions"><button type="button" :class="settings?.enabled ? 'secondary-button' : 'primary-button'" :disabled="busy" @click="configure(!settings?.enabled)">{{ busy ? '处理中…' : settings?.enabled ? '关闭连接' : '开启连接' }}</button><button type="button" class="text-button" :disabled="busy" @click="refresh">刷新状态</button></div>
      </div>
      <p v-if="settings?.state === 'failed'" class="feedback is-warning" role="status">连接未就绪，请检查连接选项后重新开启。</p>
      <p v-if="settings?.state === 'ready' && settings.host === '127.0.0.1'" class="feedback is-warning" role="status">当前地址仅供本机使用。要连接手机，请关闭连接，在下方选择局域网地址后重新开启。</p>
      <template v-if="settings?.state === 'ready' && settings.connection">
        <div class="setting-row">
          <div class="row-copy"><h4>配对新手机</h4><p>在 iPhone 的 Mousa 中打开“连接电脑”，选择这台 Mac 并点击配对。验证码会自动显示在这台电脑上。</p></div>
        </div>
        <details class="settings-disclosure">
          <summary>旧版客户端配对</summary>
          <p class="disclosure-copy">旧版客户端可继续导入连接资料，并使用一次性许可。</p>
          <div class="row-actions"><button type="button" class="secondary-button" :disabled="busy" @click="issue">生成配对许可</button><button type="button" class="secondary-button" @click="copy(connection)">复制连接资料</button></div>
        <div v-if="permit" class="mobile-pairing-permit">
          <label for="mobile-pairing-permit">本次配对许可</label><div class="permit-controls"><input id="mobile-pairing-permit" readonly :value="permit.pairingSecret" aria-label="本次配对许可" /><button type="button" class="secondary-button" @click="copy(permit.pairingSecret)">复制许可</button></div>
          <p>有效至 {{ new Date(permit.expiresAt).toLocaleTimeString() }}，使用后即失效。</p>
        </div>
        </details>
      </template>
      <section v-if="settings" class="paired-devices" aria-labelledby="mobile-devices-heading">
        <h4 id="mobile-devices-heading">已配对设备</h4>
        <ul v-if="settings.devices.some(device => !device.revoked)" class="mobile-paired-devices"><li v-for="device in settings.devices.filter(device => !device.revoked)" :key="device.deviceId"><div class="device-copy"><span>{{ device.deviceName }}</span><small>已配对</small></div><button type="button" class="text-button revoke-button" :disabled="busy || settings.state !== 'ready'" @click="revoke(device.deviceId)">撤销配对</button></li></ul>
        <p v-else class="module-description">尚无已配对设备。</p>
        <details v-if="settings.devices.some(device => device.revoked)" class="settings-disclosure"><summary>已撤销的设备</summary><ul class="mobile-paired-devices"><li v-for="device in settings.devices.filter(device => device.revoked)" :key="device.deviceId"><span>{{ device.deviceName }}</span><span class="device-history-state">已撤销</span></li></ul></details>
      </section>
      <details class="settings-disclosure connection-options">
        <summary>连接选项</summary>
        <p class="disclosure-copy">选择手机能访问的本机地址；连接开启时不能修改。</p>
        <div class="mobile-connection-fields">
          <label>本机地址<select v-model="host" :disabled="busy || settings?.enabled" aria-label="移动连接地址"><option v-for="value in settings?.hosts ?? ['127.0.0.1']" :key="value" :value="value">{{ value }}{{ value === '127.0.0.1' ? '（仅本机）' : '' }}</option></select></label>
          <label>端口<input v-model.number="port" type="number" min="1024" max="65535" :disabled="busy || settings?.enabled" aria-label="移动连接端口" /></label>
        </div>
      </details>
      <details v-if="settings?.state === 'ready' && settings.connection" class="settings-disclosure"><summary>连接资料与公开证书</summary><textarea readonly :value="connection" aria-label="移动连接公开资料" rows="7" /></details>
      <p v-if="message" role="status" class="feedback">{{ message }}</p>
    </template>
  </article>
</template>

<style scoped>
.mobile-settings.settings-card.settings-glass-panel { min-height: 0; color: var(--mb-text-primary); background: var(--mb-glass-clear); box-shadow: none; }
.module-heading, .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.module-heading { margin-bottom: 8px; align-items: flex-start; }
h3, h4, p { margin: 0; }
h3 { font-size: 16px; line-height: 1.4; font-weight: 650; }
h4 { font-size: 13px; line-height: 1.5; font-weight: 600; }
.module-description, .row-copy p, .disclosure-copy, .mobile-pairing-permit p { margin-top: 5px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.65; }
.status-badge { flex-shrink: 0; padding: 4px 9px; border: 1px solid var(--mb-glass-border); border-radius: 999px; color: var(--mb-text-secondary); font-size: 11px; line-height: 1.4; }
.status-badge.is-ready { color: var(--mb-success); border-color: color-mix(in srgb, var(--mb-success) 35%, transparent); }
.status-badge.is-warning, .is-warning { color: var(--mb-warning); }
.setting-row { min-height: 78px; padding: 16px 0; border-bottom: 1px solid var(--mb-glass-border); }
.row-copy { min-width: 0; max-width: 440px; }
.row-actions { display: flex; flex-shrink: 0; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; opacity: 1; }
button { min-height: 36px; font: inherit; font-size: 12px; }
button:disabled { cursor: default; opacity: .5; }
.mobile-connection-fields { display: grid; grid-template-columns: minmax(0, 2fr) minmax(110px, 1fr); gap: 16px; margin-top: 14px; }
.mobile-connection-fields label { display: grid; gap: 8px; min-width: 0; color: var(--mb-text-secondary); font-size: 12px; }
select, input, textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; padding: 9px 12px; border: 1px solid var(--mb-glass-border); border-radius: 9px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; font-size: 13px; }
select:focus-visible, input:focus-visible, textarea:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
textarea { margin-top: 12px; resize: vertical; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.6; }
.mobile-pairing-permit { margin: 16px 0; padding: 14px; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: var(--mb-glass-clear); }
.mobile-pairing-permit > label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; }
.permit-controls { display: flex; align-items: center; gap: 12px; }
.permit-controls input { font-family: ui-monospace, monospace; }
.permit-controls button { flex-shrink: 0; }
.paired-devices { padding-top: 16px; }
.mobile-paired-devices { padding: 0; list-style: none; }
.mobile-paired-devices li { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 48px; padding: 8px 0; border-bottom: 1px solid var(--mb-glass-border); font-size: 13px; }
.device-copy { display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
.device-copy small, .device-history-state { color: var(--mb-text-secondary); font-size: 11px; }
.revoke-button { flex-shrink: 0; }
.revoke-button:hover:not(:disabled) { color: var(--mb-danger); }
.settings-disclosure { margin-top: 14px; }
.settings-disclosure summary { width: fit-content; min-height: 32px; padding: 5px 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.6; cursor: pointer; }
.settings-disclosure[open] > summary { color: var(--mb-text-primary); }
.feedback { margin-top: 12px; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .setting-row { align-items: flex-start; flex-direction: column; gap: 12px; }
  .row-actions { justify-content: flex-start; }
}
@media (max-width: 440px) {
  .module-heading { gap: 12px; }
  .mobile-connection-fields { grid-template-columns: minmax(0, 1fr); }
  .permit-controls { align-items: stretch; flex-direction: column; }
}
</style>
