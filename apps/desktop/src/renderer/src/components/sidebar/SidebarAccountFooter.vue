<script setup lang="ts">
import type { PublicAccountState, PublicAuthState } from '@music-bridge/contracts'

const props = defineProps<{
  expanded: boolean
  accountState: PublicAccountState
  authState: PublicAuthState
}>()

const emit = defineEmits<{
  open: []
}>()

const statusLabels: Record<PublicAccountState['status'], string> = {
  missing: '未登录',
  loading: '读取账户…',
  ready: '网易云账户',
  unavailable: '账户信息不可用',
}

function statusLabel(): string {
  if (props.authState.status === 'expired') return '登录已过期'
  return statusLabels[props.accountState.status]
}

function hideBrokenAvatar(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.hidden = true
}
</script>

<template>
  <footer class="sidebar-account-footer" :class="{ 'is-collapsed': !props.expanded }">
    <button
      type="button"
      class="sidebar-account-button"
      aria-label="打开网易云账户设置"
      @click="emit('open')"
    >
      <span class="sidebar-account-avatar" :class="'is-' + props.accountState.status" aria-hidden="true">
        <span>{{ props.accountState.profile?.displayName?.slice(0, 1) ?? '♪' }}</span>
        <img v-if="props.accountState.profile?.avatarUrl" :src="props.accountState.profile.avatarUrl" alt="" @error="hideBrokenAvatar" />
      </span>
      <span v-if="props.expanded" class="sidebar-account-copy">
        <strong>{{ props.accountState.profile?.displayName ?? '网易云音乐' }}</strong>
        <small>{{ statusLabel() }}</small>
      </span>
      <span v-if="props.expanded" class="sidebar-account-chevron" aria-hidden="true">›</span>
    </button>
  </footer>
</template>
