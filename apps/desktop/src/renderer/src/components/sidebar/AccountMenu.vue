<script setup lang="ts">
import { ref } from 'vue'
import type { PublicAuthState } from '@music-bridge/contracts'

defineProps<{
  authState: PublicAuthState
}>()

const emit = defineEmits<{
  action: [action: 'login' | 'settings' | 'diagnostics' | 'logout']
  close: []
}>()

const logoutPending = ref(false)

function choose(action: 'login' | 'settings' | 'diagnostics'): void {
  logoutPending.value = false
  emit('action', action)
}

function requestLogout(): void {
  if (!logoutPending.value) {
    logoutPending.value = true
    return
  }
  emit('action', 'logout')
  logoutPending.value = false
}
</script>

<template>
  <div class="sidebar-popover account-menu" role="menu" aria-label="账户菜单" @keydown.esc="emit('close')">
    <p class="account-menu-label">账户状态</p>
    <button v-if="authState.status === 'authorized'" type="button" role="menuitem" @click="choose('login')">重新登录</button>
    <button v-else type="button" role="menuitem" @click="choose('login')">登录网易云</button>
    <button type="button" role="menuitem" @click="choose('settings')">设置</button>
    <button type="button" role="menuitem" @click="choose('diagnostics')">高级与诊断</button>
    <div class="popover-divider"></div>
    <template v-if="logoutPending">
      <p class="account-confirm-copy">确定退出网易云账户？</p>
      <div class="account-confirm-actions">
        <button type="button" role="menuitem" @click="logoutPending = false">取消</button>
        <button type="button" role="menuitem" class="destructive-menu-item" @click="requestLogout">确认退出</button>
      </div>
    </template>
    <button v-if="authState.status === 'authorized'" type="button" role="menuitem" class="destructive-menu-item" @click="requestLogout">退出登录</button>
  </div>
</template>
