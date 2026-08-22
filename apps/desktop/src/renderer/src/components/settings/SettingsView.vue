<script setup lang="ts">
import type { AppInfo } from '../../../../preload/api.js'
import type { PlaybackQuality, PublicAccountState, PublicAuthState, PublicRoonZone } from '@music-bridge/contracts'

const props = defineProps<{
  appInfo: AppInfo | null
  authState: PublicAuthState
  accountState: PublicAccountState
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  selectedQuality: PlaybackQuality
  authError: boolean
  accountError?: string | null
}>()

const emit = defineEmits<{
  'begin-login': []
  'cancel-login': []
  logout: []
  'refresh-account': []
  'update:selectedQuality': [quality: PlaybackQuality]
  'select-zone': [zoneId: string]
  diagnostics: []
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
    </div>
  </section>
</template>
