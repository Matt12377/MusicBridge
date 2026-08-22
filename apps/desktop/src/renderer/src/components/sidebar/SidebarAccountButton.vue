<script setup lang="ts">
import type { PublicAuthState } from '@music-bridge/contracts'
import { useAccountMenu } from '../../composables/useAccountMenu.js'
import AccountMenu from './AccountMenu.vue'
import SidebarIcon from './SidebarIcon.vue'

const props = defineProps<{
  authState: PublicAuthState
  expanded: boolean
}>()

const emit = defineEmits<{
  action: [action: 'login' | 'settings' | 'diagnostics' | 'logout']
}>()

const accountLabel = () => props.authState.status === 'authorized' ? '网易云已登录' : '登录网易云'
const { root, open, toggle, close, choose } = useAccountMenu((action) => emit('action', action))
</script>

<template>
  <div ref="root" class="sidebar-account-control">
    <button type="button" class="sidebar-footer-row" :aria-expanded="open" aria-haspopup="menu" :aria-label="accountLabel()" :title="expanded ? undefined : accountLabel()" @click="toggle">
      <span class="sidebar-account-avatar" aria-hidden="true"><SidebarIcon name="user" :size="15" /></span>
      <span v-if="expanded" class="sidebar-footer-copy"><strong>{{ accountLabel() }}</strong><small>{{ authState.status === 'authorized' ? 'Provider' : '需要登录' }}</small></span>
      <SidebarIcon v-if="expanded" name="more" :size="16" />
    </button>
    <AccountMenu v-if="open" :auth-state="authState" @action="choose" @close="close" />
  </div>
</template>
