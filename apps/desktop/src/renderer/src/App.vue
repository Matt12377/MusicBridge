<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import type { PublicAuthState, PublicBridgeState } from '@music-bridge/contracts'
import type { AppInfo } from '../../preload/api.js'

const appInfo = ref<AppInfo | null>(null)
const coreState = ref<PublicBridgeState | null>(null)
const authState = ref<PublicAuthState>({ status: 'idle' })
const coreError = ref(false)
const authError = ref(false)
let removeCoreListener: (() => void) | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let authOperation = 0
let pollInFlight = false

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

function acceptsPolling(state: PublicAuthState): boolean {
  return state.status === 'waiting' || state.status === 'scanned'
}

function applyAuthState(state: PublicAuthState, operation = authOperation): void {
  if (operation !== authOperation) return
  authState.value = state
  if (!acceptsPolling(state)) stopPolling()
}

async function pollQr(operation: number): Promise<void> {
  const challengeId = authState.value.challengeId
  if (!challengeId || pollInFlight || operation !== authOperation) return
  pollInFlight = true
  try {
    const state = await window.musicBridge.pollQrLogin(challengeId)
    applyAuthState(state, operation)
  } catch {
    if (operation === authOperation) authError.value = true
    stopPolling()
  } finally {
    pollInFlight = false
  }
}

function startPolling(): void {
  stopPolling()
  const operation = authOperation
  pollTimer = setInterval(() => {
    void pollQr(operation)
  }, 2_000)
  void pollQr(operation)
}

async function beginQrLogin(): Promise<void> {
  authOperation += 1
  authError.value = false
  stopPolling()
  try {
    const state = await window.musicBridge.beginQrLogin()
    applyAuthState(state)
    if (acceptsPolling(state)) startPolling()
  } catch {
    authError.value = true
  }
}

async function cancelQrLogin(): Promise<void> {
  const challengeId = authState.value.challengeId
  if (!challengeId) return
  authOperation += 1
  stopPolling()
  try {
    applyAuthState(await window.musicBridge.cancelQrLogin(challengeId))
  } catch {
    authError.value = true
  }
}

async function logout(): Promise<void> {
  authOperation += 1
  authError.value = false
  stopPolling()
  try {
    applyAuthState(await window.musicBridge.logout())
  } catch {
    authError.value = true
  }
}

onMounted(async () => {
  removeCoreListener = window.musicBridge.onCoreEvent((event) => {
    if (event.event === 'core.ready' || event.event === 'core.health' || event.event === 'roon.changed') {
      coreState.value = event.payload.state
    }
    if (event.event === 'auth.changed') {
      applyAuthState(event.payload.state)
    }
  })
  try {
    appInfo.value = await window.musicBridge.getAppInfo()
    coreState.value = await window.musicBridge.getCoreHealth()
    applyAuthState(await window.musicBridge.getAuthState())
  } catch {
    coreError.value = true
  }
})

onUnmounted(() => {
  removeCoreListener?.()
  stopPolling()
})
</script>

<template>
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">安全桌面空壳</p>
      <h1>Music Bridge for Roon</h1>
      <p class="description">本地桌面控制面板占位，当前不提供登录、搜索或播放功能。</p>
    </header>

    <section class="info-card" aria-label="应用信息">
      <h2>应用信息</h2>
      <dl>
        <div><dt>App 版本</dt><dd>{{ appInfo?.version ?? '读取中' }}</dd></div>
        <div><dt>构建模式</dt><dd>{{ appInfo?.buildMode ?? '读取中' }}</dd></div>
        <div><dt>平台</dt><dd>{{ appInfo?.platform ?? '读取中' }}</dd></div>
      </dl>
    </section>

    <section class="auth-card" aria-label="Provider 登录">
      <div class="auth-copy">
        <p class="eyebrow">Provider</p>
        <h2>扫码登录</h2>
        <p>二维码只在本地窗口显示，登录状态由桌面主进程安全保存。</p>
      </div>
      <div v-if="authState.qrImage" class="qr-frame">
        <img :src="authState.qrImage" alt="Provider 登录二维码" />
      </div>
      <p class="auth-status">当前状态：{{ authState.status }}</p>
      <div class="auth-actions">
        <button
          type="button"
          :disabled="authState.status === 'creating' || acceptsPolling(authState)"
          @click="beginQrLogin"
        >
          {{ authState.status === 'creating' ? '生成中…' : '显示二维码' }}
        </button>
        <button
          v-if="acceptsPolling(authState)"
          type="button"
          class="secondary"
          @click="cancelQrLogin"
        >
          取消
        </button>
        <button
          v-if="authState.status === 'authorized'"
          type="button"
          class="secondary"
          @click="logout"
        >
          退出登录
        </button>
      </div>
      <p v-if="authState.status === 'expired'" class="auth-hint">二维码已过期，请重新生成。</p>
      <p v-if="authError" class="auth-hint">登录操作暂时不可用，请稍后重试。</p>
    </section>

    <section class="status-grid" aria-label="运行状态占位">
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>Roon 状态</h2>
        <p>{{ coreState?.roon ?? '读取中' }}</p>
      </article>
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>网易云状态</h2>
        <p>{{ coreState?.provider ?? (coreError ? '不可用' : '读取中') }}</p>
      </article>
      <article class="status-card">
        <span class="status-dot" aria-hidden="true"></span>
        <h2>Bridge Core 状态</h2>
        <p>{{ coreState?.runtime ?? (coreError ? '不可用' : '读取中') }}</p>
        <small v-if="coreState">活动流：{{ coreState.activeStreamCount }}</small>
      </article>
    </section>
  </main>
</template>
