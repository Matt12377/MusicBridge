<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import SidebarIcon from '../sidebar/SidebarIcon.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import CollectionReadonlySettings from './CollectionReadonlySettings.vue'
import LocalLibrarySettings from './LocalLibrarySettings.vue'
import LocalAiSettings from './LocalAiSettings.vue'
import type { LocalWorkbenchLibrary } from '../../composables/application/local-library-workbench/library.js'
import type { useLocalRelocationPlans } from '../../composables/application/useLocalRelocationPlans.js'
import MobileConnectionSettings from './MobileConnectionSettings.vue'
const SourceWritesSettings = typeof window.musicBridge?.getLocalSourceWrites === 'function' ? defineAsyncComponent(() => import('./LocalSourceWritesSettings.vue')) : null
import RoonDisplaySettings from './RoonDisplaySettings.vue'
import type { AppInfo } from '../../../../preload/api.js'
import type { PlaybackQualityPreference, PublicAccountState, PublicAuthState, PublicRoonZone, RemoteCoreTunnelState } from '@music-bridge/contracts'
import { createSettingsNavigation, type SettingsCategory } from '../../composables/useSettingsNavigation.js'
import { zoneLifecycleLabel, type ZoneLifecycleStatus } from '../../zone-lifecycle.js'

const props = defineProps<{
  workbenchLibrary?: LocalWorkbenchLibrary
  localRelocationSession?: ReturnType<typeof useLocalRelocationPlans>
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
  updated: []
  'scan-observed': []
  'organize-library': []
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
  application: '通用', library: '音乐库', playback: '播放', roon: '设备与连接', account: '账户', advanced: '高级',
}
const categoryDescriptions: Record<SettingsCategory, string> = {
  application: '外观与应用信息', library: '文件夹、扫描与资料整理', playback: '音质与歌词',
  roon: '播放设备与手机连接', account: '音乐服务与登录', advanced: '整理权限与故障排查',
}
const categoryIcons = { application: 'settings', library: 'collection', playback: 'play', roon: 'speaker', account: 'user', advanced: 'more' } as const
const librarySummary = computed(() => {
  const libraries = props.workbenchLibrary?.state.value?.libraries
  return libraries ? `${libraries.length} 个音乐库 · ${libraries.reduce((count, library) => count + library.totalAlbums, 0)} 张专辑` : '添加文件夹，管理本地音乐'
})
const advancedPanels = ref({ ai: false, source: false, inventory: false, remote: false })
const aiSettingsState = computed(() => props.workbenchLibrary?.originalNameSave?.value ? '待核对'
  : props.workbenchLibrary?.nameDirty?.value ? '未保存' : '')
function openAiSettings(): void { advancedPanels.value.ai = true; selectCategory('advanced') }
function toggleAdvanced(key: keyof typeof advancedPanels.value, event: Event): void {
  advancedPanels.value[key] = (event.currentTarget as HTMLDetailsElement).open
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
  }[status] ?? '状态待确认'
}

function paneId(category: SettingsCategory): string {
  return 'settings-pane-' + category
}
</script>

<template>
  <section class="view view-settings settings-view settings-redesign" aria-labelledby="settings-heading">
    <header class="settings-page-heading"><div><p class="section-kicker">Mousa</p><h2 id="settings-heading">设置</h2></div><span class="settings-version" v-if="props.appInfo">{{ props.appInfo.version }}<span v-if="settingsBuildMode === 'development'"> · 开发版</span></span></header>
    <div class="settings-shell">
      <aside class="settings-navigation">
        <nav class="settings-category-tabs" role="tablist" aria-label="设置分类" aria-orientation="vertical" @keydown="onKeydown">
          <button v-for="category in visibleCategories" :id="'settings-tab-' + category" :key="category" type="button" role="tab"
            :data-settings-category="category" :aria-selected="activeCategory === category" :aria-controls="paneId(category)"
            :tabindex="activeCategory === category ? 0 : -1" :class="{ selected: activeCategory === category }" @click="selectCategory(category)">
            <span class="settings-nav-icon"><SidebarIcon :name="categoryIcons[category]" :size="17" /></span><span class="settings-nav-copy"><strong>{{ categoryLabels[category] }}</strong><small>{{ categoryDescriptions[category] }}</small></span>
          </button>
        </nav>
      </aside>
      <div class="settings-content">
        <header class="settings-pane-heading"><h3>{{ categoryLabels[activeCategory] }}</h3><p>{{ categoryDescriptions[activeCategory] }}</p></header>
        <div v-if="aiSettingsState" class="settings-attention" role="status"><span>{{ aiSettingsState === '待核对' ? '智能整理配置的保存结果待核对。' : '智能整理配置还有未保存的更改。' }}</span><button type="button" class="text-button" @click="openAiSettings">查看设置</button></div>

        <div v-if="activeCategory === 'application'" id="settings-pane-application" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-application">
          <AppearanceSettings />
          <section class="settings-group" aria-label="音乐与设备">
            <h4 class="settings-group-title">音乐与设备</h4>
            <div class="settings-glass-panel settings-link-list">
              <button type="button" class="settings-destination" @click="selectCategory('library')"><span class="settings-destination-icon"><SidebarIcon name="collection" :size="20" /></span><span><strong>管理音乐库</strong><small>{{ librarySummary }}</small></span><SidebarIcon name="chevron-right" :size="15" /></button>
              <button type="button" class="settings-destination" @click="selectCategory('roon')"><span class="settings-destination-icon"><SidebarIcon name="speaker" :size="20" /></span><span><strong>连接播放设备</strong><small>{{ props.selectedZone?.displayName ?? '选择音响，或连接手机' }}</small></span><SidebarIcon name="chevron-right" :size="15" /></button>
            </div>
          </section>
          <article class="settings-card settings-glass-panel settings-about">
            <div class="settings-row"><div class="settings-row-copy"><h4>Mousa</h4><p>{{ props.appInfo?.version ?? '正在读取版本' }}<span v-if="props.appInfo"> · {{ props.appInfo.platform === 'darwin' ? 'macOS' : props.appInfo.platform === 'win32' ? 'Windows' : props.appInfo.platform }}</span></p></div><span v-if="props.appInfo" class="settings-subtle-badge">{{ settingsBuildMode === 'development' ? '开发版' : '正式版' }}</span></div>
            <details class="settings-inline-details"><summary>许可与组件</summary><p class="muted-copy">音频转换组件：FFmpeg 8.1.2，按 LGPL 2.1 或更高版本许可。随应用原生组件提供对应源码、许可证和构建选项（Contents/Resources/ffmpeg/darwin-arm64/legal）。转换构建通过校验不代表设备或听感认证。</p></details>
          </article>
        </div>

        <div v-else-if="activeCategory === 'library'" id="settings-pane-library" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-library">
          <LocalLibrarySettings :workspace="props.workbenchLibrary" :relocation-session="props.localRelocationSession" @updated="emit('updated')" @scan-observed="emit('scan-observed')" @organize="emit('organize-library')" />
        </div>

        <div v-else-if="activeCategory === 'playback'" id="settings-pane-playback" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-playback">
          <article class="settings-card settings-glass-panel">
            <div class="settings-row"><div class="settings-row-copy"><label class="settings-row-title" for="quality-select">音质偏好</label><p>在下一次开始播放时应用</p></div><select id="quality-select" :value="props.selectedQuality" @change="emit('update:selectedQuality', ($event.target as HTMLSelectElement).value as PlaybackQualityPreference)"><option value="auto">自动 · 最高可用音质</option><option value="standard">标准</option><option value="exhigh">超高</option><option value="lossless">无损</option><option value="hires">Hi-Res</option></select></div>
            <p class="settings-footnote">当前歌曲不会重新开始，实际音质可在播放栏查看。</p>
          </article>
          <RoonDisplaySettings />
        </div>

        <div v-else-if="activeCategory === 'roon'" id="settings-pane-roon" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-roon">
          <article class="settings-card settings-glass-panel">
            <div class="panel-heading"><div><h4>Roon 播放设备</h4><p>选择音乐要播放到哪里</p></div><span class="settings-status-pill" :class="'is-' + props.roonStatus">{{ roonStatusLabel(props.roonStatus) }}</span></div>
            <div class="settings-row"><div class="settings-row-copy"><label class="settings-row-title" for="zone-select">当前设备</label><p>{{ props.selectedZone?.displayName ?? zoneLifecycleLabel(props.zoneStatus) }}</p></div><select id="zone-select" :value="props.selectedZone?.zoneId ?? ''" :disabled="props.zoneStatus === 'core-disconnected' || props.zoneStatus === 'loading' || props.zoneStatus === 'empty'" @change="emit('select-zone', ($event.target as HTMLSelectElement).value)"><option value="" disabled>{{ zoneLifecycleLabel(props.zoneStatus) }}</option><option v-for="zone in props.zones" :key="zone.zoneId" :value="zone.zoneId">{{ zone.displayName }}</option></select></div>
            <div class="settings-card-footer"><span class="settings-footnote">设备由 Roon Core 提供</span><button type="button" class="text-button" :disabled="props.zoneStatus === 'core-disconnected' || props.zoneStatus === 'loading'" @click="emit('refresh-zones')">刷新设备</button></div>
          </article>
          <MobileConnectionSettings />
        </div>

        <div v-else-if="activeCategory === 'account'" id="settings-pane-account" class="settings-pane settings-pane-account" role="tabpanel" aria-labelledby="settings-tab-account">
          <article class="account-settings-hero settings-glass-panel">
            <div class="account-settings-avatar" :class="'is-' + props.accountState.status"><span>{{ props.accountState.profile?.displayName?.slice(0, 1) ?? '♪' }}</span><img v-if="props.accountState.profile?.avatarUrl" :src="props.accountState.profile.avatarUrl" alt="" @error="hideBrokenAvatar" /></div>
            <div class="account-settings-copy"><p class="section-kicker">网易云音乐</p><h3>{{ props.accountState.profile?.displayName ?? '连接你的音乐账户' }}</h3><p>{{ accountStatusLabel(props.accountState.status, props.authState.status) }}</p></div>
            <div class="account-settings-actions"><button type="button" class="secondary-button" :disabled="props.accountState.status === 'loading'" @click="emit('refresh-account')">刷新账户</button><button v-if="props.authState.status === 'authorized'" type="button" class="destructive-button" @click="emit('logout')">退出登录</button><button v-else type="button" class="primary-button" :disabled="props.authState.status === 'creating' || acceptsPolling(props.authState)" @click="emit('begin-login')">{{ props.authState.status === 'expired' ? '重新扫码' : props.authState.status === 'creating' ? '生成中…' : '扫码登录' }}</button></div>
            <div v-if="props.authState.qrImage" class="account-qr-frame"><img :src="props.authState.qrImage" alt="网易云登录二维码" /></div>
            <div v-if="acceptsPolling(props.authState)" class="account-login-actions"><span>请使用网易云音乐扫码确认</span><button type="button" class="secondary-button" @click="emit('cancel-login')">取消</button></div>
            <p v-if="props.accountError" class="persistent-error" role="alert">{{ props.accountError }}</p><p v-if="props.authError" class="persistent-error" role="alert">登录暂时不可用，请稍后重试。</p>
          </article>
        </div>

        <div v-else-if="activeCategory === 'advanced'" id="settings-pane-advanced" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-advanced">
          <p v-if="props.workbenchLibrary?.error?.value" class="persistent-error" role="alert">{{ props.workbenchLibrary.error.value }}</p>
          <section class="settings-group" aria-label="资料整理"><h4 class="settings-group-title">资料整理</h4><div class="settings-disclosure-list settings-glass-panel">
            <details :open="advancedPanels.ai" @toggle="toggleAdvanced('ai', $event)"><summary><span><strong>智能整理服务</strong><small>名称识别使用的模型与服务</small></span><span v-if="aiSettingsState || !props.workbenchLibrary" class="settings-summary-status" role="status">{{ aiSettingsState || '未就绪' }}</span><SidebarIcon name="chevron-right" :size="15" /></summary><div class="settings-disclosure-content"><LocalAiSettings v-if="props.workbenchLibrary && advancedPanels.ai" :model="props.workbenchLibrary" /><p v-else-if="!props.workbenchLibrary" class="settings-note">音乐库服务尚未就绪，请稍后重新进入设置。</p></div></details>
            <details :open="advancedPanels.source" @toggle="toggleAdvanced('source', $event)"><summary><span><strong>音乐文件写入</strong><small>管理标签与封面的写入权限</small></span><span v-if="!SourceWritesSettings" class="settings-summary-status" role="status">未就绪</span><SidebarIcon name="chevron-right" :size="15" /></summary><div class="settings-disclosure-content"><SourceWritesSettings v-if="SourceWritesSettings && advancedPanels.source" /><p v-else-if="!SourceWritesSettings" class="settings-note">文件写入暂不可用，音乐库内的资料整理仍可使用。</p></div></details>
            <details :open="advancedPanels.inventory" @toggle="toggleAdvanced('inventory', $event)"><summary><span><strong>实物收藏查询</strong><small>可选的库存查询加速</small></span><SidebarIcon name="chevron-right" :size="15" /></summary><div class="settings-disclosure-content"><CollectionReadonlySettings v-if="advancedPanels.inventory" /></div></details>
          </div></section>
          <section class="settings-group" aria-label="连接与诊断"><h4 class="settings-group-title">连接与诊断</h4><div class="settings-disclosure-list settings-glass-panel"><details :open="advancedPanels.remote" @toggle="toggleAdvanced('remote', $event)"><summary><span><strong>远程 Core</strong><small>{{ props.remoteSshTarget || '连接另一台电脑上的 Core' }} · {{ remoteStatusLabel(props.remoteCoreState.status) }}</small></span><SidebarIcon name="chevron-right" :size="15" /></summary><div v-if="advancedPanels.remote" class="settings-disclosure-content">
      <article class="settings-card settings-glass-panel remote-core-settings" data-remote-core-settings>
        <div class="panel-heading"><div><p class="section-kicker">高级</p><h3>Remote Core 开发</h3></div><span class="settings-status-pill" :class="'is-' + props.remoteCoreState.status">{{ remoteStatusLabel(props.remoteCoreState.status) }}</span></div>
        <p class="muted-copy">连接另一台电脑上的 Core，使用已有 SSH 配置建立连接。</p>
        <label class="field-label" for="remote-ssh-target">SSH 目标</label>
        <input id="remote-ssh-target" :value="props.remoteSshTarget" type="text" maxlength="255" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="macmini 或 user@host" :disabled="props.remoteCoreState.status === 'checking' || props.remoteCoreState.status === 'starting' || props.remoteCoreState.status === 'ready' || props.remoteCoreState.status === 'reconnecting' || props.remoteCoreState.status === 'stopping'" @input="emit('update:remote-ssh-target', ($event.target as HTMLInputElement).value)" />
        <p class="muted-copy">仅允许已配置的SSH别名或user@host；密码不会在应用中读取、保存或传递，SSH 必须使用已有 key 与 known_hosts。</p>
        <dl class="detail-list remote-core-details"><div><dt>当前目标</dt><dd>{{ props.remoteCoreState.sshTarget || '尚未连接' }}</dd></div><div><dt>远程端口</dt><dd>{{ props.remoteCoreState.remoteStreamPort ?? '—' }}</dd></div><div><dt>本地 Gateway</dt><dd>127.0.0.1:{{ props.remoteCoreState.localStreamPort }}</dd></div><div><dt>健康检查</dt><dd>{{ props.remoteCoreState.remoteHealth === 'available' ? '可用' : '未确认' }}</dd></div></dl>
        <label class="settings-toggle"><input type="checkbox" :checked="props.remoteAutoStart" @change="emit('update:remote-auto-start', ($event.target as HTMLInputElement).checked)" /><span>启动应用时自动连接</span></label>
        <p v-if="props.remoteCoreState.failure" class="persistent-error remote-core-failure"><span>{{ props.remoteCoreState.failure.message }}</span><span>错误码：{{ props.remoteCoreState.failure.code }}</span></p>
        <div class="button-row remote-core-actions"><button v-if="props.remoteCoreState.status === 'idle' || props.remoteCoreState.status === 'failed' || props.remoteCoreState.status === 'disconnected'" type="button" class="primary-button" :disabled="!props.remoteSshTarget" @click="emit('start-remote-core')">启动远程 Core</button><button v-else type="button" class="secondary-button" :disabled="props.remoteCoreState.status === 'stopping'" @click="emit('stop-remote-core')">停止远程 Core</button><button type="button" class="secondary-button" :disabled="!props.remoteSshTarget.trim() || props.remoteCoreState.status === 'checking' || props.remoteCoreState.status === 'starting' || props.remoteCoreState.status === 'reconnecting' || props.remoteCoreState.status === 'stopping'" @click="emit('reconnect-remote-core')">重连</button></div>
      </article>
          </div></details></div><p v-if="props.remoteCoreState.failure && !advancedPanels.remote" class="persistent-error" role="alert">{{ props.remoteCoreState.failure.message }}</p></section>
          <article class="settings-card settings-glass-panel settings-support"><div class="settings-row"><div class="settings-row-copy"><h4>操作记录与诊断</h4><p>核对未确认的操作，或排查使用中遇到的问题</p></div><button type="button" class="secondary-button settings-diagnostics-link" @click="emit('diagnostics')">打开诊断</button></div><div class="settings-support-actions"><slot name="application-tools" /></div></article>
        </div>
      </div>
    </div>
  </section>
</template>
