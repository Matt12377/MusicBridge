<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { PublicAuthState, PublicBridgeState, PublicRoonZone } from '@music-bridge/contracts'
import SidebarIcon from './sidebar/SidebarIcon.vue'

const props = defineProps<{
  coreState: PublicBridgeState | null
  authState: PublicAuthState
  selectedZone?: PublicRoonZone
}>()

const emit = defineEmits<{
  diagnostics: []
}>()

const root = ref<HTMLElement | null>(null)
const open = ref(false)
const connectionLabel = computed(() => {
  if (props.coreState?.runtime === 'failed' || props.coreState?.roon === 'disconnected') return '未连接'
  if (props.coreState?.runtime === 'ready' && props.coreState.roon === 'ready') return '已连接'
  return '连接中'
})

function closeOnOutside(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'ready':
    case 'configured':
    case 'authorized':
      return status === 'configured' || status === 'authorized' ? '已登录' : '已就绪'
    case 'paired':
      return '已连接'
    case 'missing':
      return '未配置'
    case 'disconnected':
      return '未连接'
    default:
      return status ?? '读取中'
  }
}

function close(): void {
  open.value = false
}

onMounted(() => document.addEventListener('mousedown', closeOnOutside))
onUnmounted(() => document.removeEventListener('mousedown', closeOnOutside))
</script>

<template>
  <div ref="root" class="toolbar-status-wrap">
    <button type="button" class="toolbar-status-button" aria-label="查看连接状态" :aria-expanded="open" aria-haspopup="dialog" @click="open = !open">
      <i class="status-led" :class="coreState?.runtime ?? 'starting'"></i>
      <span>{{ connectionLabel }}</span>
      <SidebarIcon name="chevron-down" :size="14" />
    </button>
    <div v-if="open" class="toolbar-status-popover" role="dialog" aria-label="连接状态" @keydown.esc="close">
      <div class="popover-heading"><strong>连接状态</strong><button type="button" class="popover-close" aria-label="关闭连接状态" @click="close">×</button></div>
      <dl class="toolbar-status-list">
        <div><dt>Music Bridge Core</dt><dd><i class="status-led" :class="coreState?.runtime ?? 'starting'"></i>{{ statusLabel(coreState?.runtime) }}</dd></div>
        <div><dt>Roon</dt><dd><i class="status-led" :class="coreState?.roon ?? 'disconnected'"></i>{{ coreState?.roon === 'ready' ? '已连接' : statusLabel(coreState?.roon) }}</dd></div>
        <div><dt>网易云</dt><dd><i class="status-led" :class="authState.status === 'authorized' ? 'authorized' : 'missing'"></i>{{ authState.status === 'authorized' ? '已登录' : '未登录' }}</dd></div>
        <div><dt>当前播放设备</dt><dd>{{ selectedZone?.displayName ?? '未选择' }}</dd></div>
      </dl>
      <button type="button" class="toolbar-diagnostics-link" @click="emit('diagnostics'); close()">打开诊断</button>
    </div>
  </div>
</template>
