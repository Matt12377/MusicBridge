<script setup lang="ts">
import type { AppInfo } from '../../../../preload/api.js'
import type { PlaybackQuality, PublicAccountState, PublicAuthState, PublicRoonZone, RemoteCoreTunnelState } from '@music-bridge/contracts'

const props = defineProps<{
  appInfo: AppInfo | null
  authState: PublicAuthState
  accountState: PublicAccountState
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  selectedQuality: PlaybackQuality
  authError: boolean
  accountError?: string | null
  remoteCoreState: RemoteCoreTunnelState
  remoteAutoStart: boolean
}>()

const emit = defineEmits<{
  'begin-login': []
  'cancel-login': []
  logout: []
  'refresh-account': []
  'update:selectedQuality': [quality: PlaybackQuality]
  'select-zone': [zoneId: string]
  diagnostics: []
  'start-remote-core': []
  'stop-remote-core': []
  'reconnect-remote-core': []
  'update:remote-auto-start': [value: boolean]
}>()

function acceptsPolling(state: PublicAuthState): boolean {
  return state.status === 'waiting' || state.status === 'scanned'
}

function accountStatusLabel(status: PublicAccountState['status'], authStatus: PublicAuthState['status']): string {
  if (authStatus === 'expired') return '登录已过期'
  if (status === 'unavailable' && authStatus === 'authorized') return '资料暂不可用 · 登录仍然有效'
  return { missing: '未登录', loading: '读取中', ready: '已连接', unavailable: '资料暂不可用' }[status]
}

function hideBrokenAvatar(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.hidden = true
}

function remoteStatusLabel(status: RemoteCoreTunnelState['status']): string {
  return {
    idle: '未启动',
    checking: '检查中',
    starting: '启动中',
    ready: '已就绪',
    reconnecting: '重连中',
    stopping: '停止中',
    disconnected: '已断开',
    failed: '失败',
  }[status]
}
</script>

<template>
  <section class="view settings-view" aria-labelledby="settings-heading">
    <div class="view-heading"><div><p class="section-kicker">Apple Liquid Glass</p><h2 id="settings-heading">Settings</h2><p class="lede">账户、播放偏好与本地诊断集中在这里；Provider 会话仍由主进程安全管理。</p></div></div>

    <div class="settings-layout">
      <article class="account-settings-hero settings-glass-panel">
        <div class="account-settings-avatar" :class="'is-' + props.accountState.status"><span>{{ props.accountState.profile?.displayName?.slice(0, 1) ?? '♪' }}</span><img v-if="props.accountState.profile?.avatarUrl" :src="props.accountState.profile.avatarUrl" alt="" @error="hideBrokenAvatar" /></div>
        <div class="account-settings-copy"><p class="section-kicker">NetEase Cloud Music</p><h3>{{ props.accountState.profile?.displayName ?? '网易云音乐账户' }}</h3><p>{{ accountStatusLabel(props.accountState.status, props.authState.status) }}<span v-if="props.authState.status !== 'expired' && !(props.accountState.status === 'unavailable' && props.authState.status === 'authorized')"> · 公开资料只包含昵称和头像</span></p></div>
        <div class="account-settings-actions"><button type="button" class="secondary-button" :disabled="props.accountState.status === 'loading'" @click="emit('refresh-account')">重新读取</button><button v-if="props.authState.status === 'authorized'" type="button" class="destructive-button" @click="emit('logout')">退出登录</button><button v-else type="button" class="primary-button" :disabled="props.authState.status === 'creating' || acceptsPolling(props.authState)" @click="emit('begin-login')">{{ props.authState.status === 'expired' ? '重新扫码' : props.authState.status === 'creating' ? '生成中…' : '扫码登录' }}</button></div>
        <div v-if="props.authState.qrImage" class="account-qr-frame"><img :src="props.authState.qrImage" alt="Provider 登录二维码" /></div>
        <div v-if="acceptsPolling(props.authState)" class="account-login-actions"><span>请使用网易云音乐扫码确认</span><button type="button" class="secondary-button" @click="emit('cancel-login')">取消</button></div>
        <p v-if="props.accountError" class="persistent-error">{{ props.accountError }}</p>
        <p v-if="props.authError" class="persistent-error">登录操作暂时不可用，请打开 Diagnostics 查看状态。</p>
      </article>

      <article class="settings-card settings-glass-panel"><div class="panel-heading"><div><p class="section-kicker">Playback</p><h3>播放偏好</h3></div></div><label class="field-label" for="quality-select">请求质量</label><select id="quality-select" :value="props.selectedQuality" @change="emit('update:selectedQuality', ($event.target as HTMLSelectElement).value as PlaybackQuality)"><option value="standard">Standard</option><option value="exhigh">Exhigh</option><option value="lossless">Lossless</option><option value="hires">Hi-Res</option></select><p class="muted-copy">实际质量由 Provider、Roon 和 Signal Path 共同决定。</p><label class="field-label" for="zone-select">播放 Zone</label><select id="zone-select" :value="props.selectedZone?.zoneId ?? ''" @change="emit('select-zone', ($event.target as HTMLSelectElement).value)"><option value="" disabled>选择 Zone</option><option v-for="zone in props.zones" :key="zone.zoneId" :value="zone.zoneId">{{ zone.displayName }}</option></select><p class="muted-copy">控制与流端口继续只绑定本机 loopback。</p></article>

      <article class="settings-card settings-glass-panel"><div class="panel-heading"><div><p class="section-kicker">Application</p><h3>应用信息</h3></div></div><dl class="detail-list"><div><dt>版本</dt><dd>{{ props.appInfo?.version ?? '读取中' }}</dd></div><div><dt>构建模式</dt><dd>{{ props.appInfo?.buildMode ?? '读取中' }}</dd></div><div><dt>平台</dt><dd>{{ props.appInfo?.platform ?? '读取中' }}</dd></div></dl><button type="button" class="text-button settings-diagnostics-link" @click="emit('diagnostics')">打开 Diagnostics →</button></article>

      <article v-if="props.appInfo?.buildMode === 'development'" class="settings-card settings-glass-panel remote-core-settings" data-remote-core-settings>
        <div class="panel-heading"><div><p class="section-kicker">Developer Mode</p><h3>Remote Core Development</h3></div><span class="settings-status-pill" :class="'is-' + props.remoteCoreState.status">{{ remoteStatusLabel(props.remoteCoreState.status) }}</span></div>
        <p class="muted-copy">仅开发构建可用。应用仍运行在本机，SSH 只建立回环反向隧道；不会修改正式 Extension、Provider 或播放语义。</p>
        <dl class="detail-list remote-core-details"><div><dt>目标</dt><dd>{{ props.remoteCoreState.sshTarget ?? '由 CORE_SSH_TARGET 提供' }}</dd></div><div><dt>远程端口</dt><dd>{{ props.remoteCoreState.remoteStreamPort ?? '—' }}</dd></div><div><dt>本地 Gateway</dt><dd>127.0.0.1:{{ props.remoteCoreState.localStreamPort }}</dd></div><div><dt>健康检查</dt><dd>{{ props.remoteCoreState.remoteHealth === 'available' ? '可用' : '未确认' }}</dd></div></dl>
        <label class="settings-toggle"><input type="checkbox" :checked="props.remoteAutoStart" @change="emit('update:remote-auto-start', ($event.target as HTMLInputElement).checked)" /><span>开发启动时自动连接（默认关闭）</span></label>
        <p v-if="props.remoteCoreState.failure" class="persistent-error remote-core-failure">
          <span>{{ props.remoteCoreState.failure.message }}</span>
          <span>阶段：{{ props.remoteCoreState.failure.phase }} · 错误码：{{ props.remoteCoreState.failure.code }}</span>
        </p>
        <div class="button-row remote-core-actions"><button v-if="props.remoteCoreState.status === 'idle' || props.remoteCoreState.status === 'failed' || props.remoteCoreState.status === 'disconnected'" type="button" class="primary-button" @click="emit('start-remote-core')">启动远程 Core</button><button v-else type="button" class="secondary-button" :disabled="props.remoteCoreState.status === 'stopping'" @click="emit('stop-remote-core')">停止远程 Core</button><button type="button" class="secondary-button" :disabled="props.remoteCoreState.status === 'checking' || props.remoteCoreState.status === 'starting' || props.remoteCoreState.status === 'reconnecting' || props.remoteCoreState.status === 'stopping'" @click="emit('reconnect-remote-core')">重连</button></div>
      </article>
    </div>
  </section>
</template>
