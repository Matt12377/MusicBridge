<script setup lang="ts">
import { computed } from 'vue'
import type { AppInfo } from '../../../../preload/api.js'
import type { PlaybackQualityPreference, PublicAccountState, PublicAuthState, PublicRoonZone, RemoteCoreTunnelState } from '@music-bridge/contracts'
import { createSettingsNavigation, type SettingsCategory } from '../../composables/useSettingsNavigation.js'
import { zoneLifecycleLabel, type ZoneLifecycleStatus } from '../../zone-lifecycle.js'

const props = defineProps<{
  appInfo: AppInfo | null
  authState: PublicAuthState
  accountState: PublicAccountState
  zones: readonly PublicRoonZone[]
  selectedZone?: PublicRoonZone
  roonStatus: string
  zoneStatus: ZoneLifecycleStatus
  selectedQuality: PlaybackQualityPreference
  authError: boolean
  accountError?: string | null
  remoteCoreState: RemoteCoreTunnelState
  remoteAutoStart: boolean
  remoteSshTarget: string
}>()

const emit = defineEmits<{
  'begin-login': []
  'cancel-login': []
  logout: []
  'refresh-account': []
  'update:selectedQuality': [quality: PlaybackQualityPreference]
  'select-zone': [zoneId: string]
  'refresh-zones': []
  diagnostics: []
  'start-remote-core': []
  'stop-remote-core': []
  'reconnect-remote-core': []
  'update:remote-auto-start': [value: boolean]
  'update:remote-ssh-target': [value: string]
}>()

const settingsBuildMode = computed(() => props.appInfo?.buildMode ?? 'production')
const {
  activeCategory,
  selectCategory,
  onKeydown,
  visibleCategories,
} = createSettingsNavigation(settingsBuildMode)

const categoryLabels: Record<SettingsCategory, string> = {
  account: '账户',
  playback: '播放',
  roon: 'Roon',
  application: '应用',
  advanced: '高级',
}

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

function roonStatusLabel(status: string): string {
  return {
    ready: '已连接',
    paired: '已配对',
    discovering: '发现中',
    disconnected: '未连接',
    failed: '连接失败',
  }[status] ?? status
}

function paneId(category: SettingsCategory): string {
  return 'settings-pane-' + category
}
</script>

<template>
  <section class="view view-settings settings-view" aria-labelledby="settings-heading">
    <div class="view-heading">
      <div>
        <p class="section-kicker">应用设置</p>
        <h2 id="settings-heading">设置</h2>
        <p class="lede">账户、播放、Roon 与应用信息分开管理，页面只保留当前需要的内容。</p>
      </div>
    </div>

    <nav class="settings-category-tabs" role="tablist" aria-label="设置分类" @keydown="onKeydown">
      <button
        v-for="category in visibleCategories"
        :id="'settings-tab-' + category"
        :key="category"
        type="button"
        role="tab"
        :aria-selected="activeCategory === category"
        :aria-controls="paneId(category)"
        :tabindex="activeCategory === category ? 0 : -1"
        :class="{ selected: activeCategory === category }"
        @click="selectCategory(category)"
      >{{ categoryLabels[category] }}</button>
    </nav>

    <div v-if="activeCategory === 'account'" id="settings-pane-account" class="settings-pane settings-pane-account" role="tabpanel" aria-labelledby="settings-tab-account">
      <article class="account-settings-hero settings-glass-panel">
        <div class="account-settings-avatar" :class="'is-' + props.accountState.status"><span>{{ props.accountState.profile?.displayName?.slice(0, 1) ?? '♪' }}</span><img v-if="props.accountState.profile?.avatarUrl" :src="props.accountState.profile.avatarUrl" alt="" @error="hideBrokenAvatar" /></div>
        <div class="account-settings-copy"><p class="section-kicker">网易云音乐</p><h3>{{ props.accountState.profile?.displayName ?? '网易云音乐账户' }}</h3><p>{{ accountStatusLabel(props.accountState.status, props.authState.status) }}<span v-if="props.authState.status !== 'expired' && !(props.accountState.status === 'unavailable' && props.authState.status === 'authorized')"> · 公开资料只包含昵称和头像</span></p></div>
        <div class="account-settings-actions"><button type="button" class="secondary-button" :disabled="props.accountState.status === 'loading'" @click="emit('refresh-account')">刷新账户</button><button v-if="props.authState.status === 'authorized'" type="button" class="destructive-button" @click="emit('logout')">退出登录</button><button v-else type="button" class="primary-button" :disabled="props.authState.status === 'creating' || acceptsPolling(props.authState)" @click="emit('begin-login')">{{ props.authState.status === 'expired' ? '重新扫码' : props.authState.status === 'creating' ? '生成中…' : '扫码登录' }}</button></div>
        <div v-if="props.authState.qrImage" class="account-qr-frame"><img :src="props.authState.qrImage" alt="网易云登录二维码" /></div>
        <div v-if="acceptsPolling(props.authState)" class="account-login-actions"><span>请使用网易云音乐扫码确认</span><button type="button" class="secondary-button" @click="emit('cancel-login')">取消</button></div>
        <p v-if="props.accountError" class="persistent-error">{{ props.accountError }}</p>
        <p v-if="props.authError" class="persistent-error">登录操作暂时不可用，请打开诊断查看状态。</p>
      </article>
    </div>

    <div v-else-if="activeCategory === 'playback'" id="settings-pane-playback" class="settings-pane settings-pane-playback" role="tabpanel" aria-labelledby="settings-tab-playback">
      <article class="settings-card settings-glass-panel">
        <div class="panel-heading"><div><p class="section-kicker">播放</p><h3>播放偏好</h3></div></div>
        <label class="field-label" for="quality-select">下次播放音质</label>
        <select id="quality-select" :value="props.selectedQuality" @change="emit('update:selectedQuality', ($event.target as HTMLSelectElement).value as PlaybackQualityPreference)">
          <option value="auto">自动（当前歌曲最高）</option>
          <option value="standard">标准</option>
          <option value="exhigh">超高</option>
          <option value="lossless">无损</option>
          <option value="hires">Hi-Res</option>
        </select>
        <p class="muted-copy">偏好只作用于下一次开始播放，当前歌曲不会重启；实际音质以播放区返回的状态为准。</p>
      </article>
    </div>

    <div v-else-if="activeCategory === 'roon'" id="settings-pane-roon" class="settings-pane settings-pane-roon" role="tabpanel" aria-labelledby="settings-tab-roon">
      <article class="settings-card settings-glass-panel">
        <div class="panel-heading"><div><p class="section-kicker">Roon</p><h3>Roon Core 与播放设备</h3></div><span class="settings-status-pill" :class="'is-' + props.roonStatus">{{ roonStatusLabel(props.roonStatus) }}</span></div>
        <dl class="detail-list"><div><dt>Core 状态</dt><dd>{{ roonStatusLabel(props.roonStatus) }}</dd></div><div><dt>当前设备</dt><dd>{{ props.selectedZone?.displayName ?? zoneLifecycleLabel(props.zoneStatus) }}</dd></div></dl>
        <label class="field-label" for="zone-select">播放设备</label>
        <select id="zone-select" :value="props.selectedZone?.zoneId ?? ''" :disabled="props.zoneStatus === 'core-disconnected' || props.zoneStatus === 'loading' || props.zoneStatus === 'empty'" @change="emit('select-zone', ($event.target as HTMLSelectElement).value)">
          <option value="" disabled>{{ zoneLifecycleLabel(props.zoneStatus) }}</option>
          <option v-for="zone in props.zones" :key="zone.zoneId" :value="zone.zoneId">{{ zone.displayName }}</option>
        </select>
        <button type="button" class="secondary-button" :disabled="props.zoneStatus === 'core-disconnected' || props.zoneStatus === 'loading'" @click="emit('refresh-zones')">刷新播放设备</button>
        <p class="muted-copy">设备名称以 Roon Core 返回为准；切换失败时不会在界面伪造新设备。控制与流端口继续只绑定本机。</p>
      </article>
    </div>

    <div v-else-if="activeCategory === 'application'" id="settings-pane-application" class="settings-pane settings-pane-application" role="tabpanel" aria-labelledby="settings-tab-application">
      <article class="settings-card settings-glass-panel">
        <div class="panel-heading"><div><p class="section-kicker">应用</p><h3>应用信息</h3></div></div>
        <dl class="detail-list"><div><dt>版本</dt><dd>{{ props.appInfo?.version ?? '读取中' }}</dd></div><div><dt>构建模式</dt><dd>{{ props.appInfo?.buildMode === 'development' ? '开发' : '生产' }}</dd></div><div><dt>平台</dt><dd>{{ props.appInfo?.platform ?? '读取中' }}</dd></div></dl>
        <p class="muted-copy">音频转换组件：FFmpeg 8.1.2，按 LGPL 2.1 或更高版本许可。随应用原生组件提供对应源码、许可证和构建选项（Contents/Resources/ffmpeg/darwin-arm64/legal）。转换构建通过校验不代表设备或听感认证。</p>
        <button type="button" class="text-button settings-diagnostics-link" @click="emit('diagnostics')">打开诊断 →</button>
      </article>
    </div>

    <div v-else-if="activeCategory === 'advanced'" id="settings-pane-advanced" class="settings-pane settings-pane-advanced" role="tabpanel" aria-labelledby="settings-tab-advanced">
      <article class="settings-card settings-glass-panel remote-core-settings" data-remote-core-settings>
        <div class="panel-heading"><div><p class="section-kicker">高级</p><h3>Remote Core 开发</h3></div><span class="settings-status-pill" :class="'is-' + props.remoteCoreState.status">{{ remoteStatusLabel(props.remoteCoreState.status) }}</span></div>
        <p class="muted-copy">本地开发构建和验收包均可用，默认关闭。SSH 只建立受控回环隧道；不会修改正式 Extension、Provider 或播放语义。</p>
        <label class="field-label" for="remote-ssh-target">SSH 目标</label>
        <input id="remote-ssh-target" :value="props.remoteSshTarget" type="text" maxlength="255" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="macmini 或 user@host" :disabled="props.remoteCoreState.status === 'checking' || props.remoteCoreState.status === 'starting' || props.remoteCoreState.status === 'ready' || props.remoteCoreState.status === 'reconnecting' || props.remoteCoreState.status === 'stopping'" @input="emit('update:remote-ssh-target', ($event.target as HTMLInputElement).value)" />
        <p class="muted-copy">仅允许已配置的SSH别名或user@host；密码不会在应用中读取、保存或传递，SSH 必须使用已有 key 与 known_hosts。</p>
        <dl class="detail-list remote-core-details"><div><dt>当前目标</dt><dd>{{ props.remoteCoreState.sshTarget ?? '尚未连接' }}</dd></div><div><dt>远程端口</dt><dd>{{ props.remoteCoreState.remoteStreamPort ?? '—' }}</dd></div><div><dt>本地 Gateway</dt><dd>127.0.0.1:{{ props.remoteCoreState.localStreamPort }}</dd></div><div><dt>健康检查</dt><dd>{{ props.remoteCoreState.remoteHealth === 'available' ? '可用' : '未确认' }}</dd></div></dl>
        <label class="settings-toggle"><input type="checkbox" :checked="props.remoteAutoStart" @change="emit('update:remote-auto-start', ($event.target as HTMLInputElement).checked)" /><span>开发启动时自动连接（默认关闭）</span></label>
        <p v-if="props.remoteCoreState.failure" class="persistent-error remote-core-failure"><span>{{ props.remoteCoreState.failure.message }}</span><span>阶段：{{ props.remoteCoreState.failure.phase }} · 错误码：{{ props.remoteCoreState.failure.code }}</span></p>
        <div class="button-row remote-core-actions"><button v-if="props.remoteCoreState.status === 'idle' || props.remoteCoreState.status === 'failed' || props.remoteCoreState.status === 'disconnected'" type="button" class="primary-button" :disabled="!props.remoteSshTarget" @click="emit('start-remote-core')">启动远程 Core</button><button v-else type="button" class="secondary-button" :disabled="props.remoteCoreState.status === 'stopping'" @click="emit('stop-remote-core')">停止远程 Core</button><button type="button" class="secondary-button" :disabled="props.remoteCoreState.status === 'checking' || props.remoteCoreState.status === 'starting' || props.remoteCoreState.status === 'reconnecting' || props.remoteCoreState.status === 'stopping'" @click="emit('reconnect-remote-core')">重连</button></div>
      </article>
    </div>
  </section>
</template>
