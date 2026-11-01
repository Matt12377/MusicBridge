import { computed, ref } from 'vue'
import type { PlaybackEventProtocolAck } from '@music-bridge/contracts'

const preparingMessage = '正在准备音乐库，你可以先切换页面；就绪后会读取当前页面。'
const failedMessage = '音乐库准备未完成，已保存的资料保留。请查看诊断信息，或退出后重试。'
const preparationCodes = new Set(['STARTUP_PREPARING', 'STARTUP_VERIFYING', 'STARTUP_FAILED'])

/** 只保存启动状态和最新播放代次；不保存用户操作或待发送业务。 */
export function useRendererPreparation() {
  const ready = ref(false), failed = ref(false), detail = ref(preparingMessage)
  let pendingPlaybackReady: { ack?: PlaybackEventProtocolAck } | undefined

  function acceptPlaybackReady(ack: PlaybackEventProtocolAck | undefined, accept: (ack?: PlaybackEventProtocolAck) => void): void {
    if (failed.value) return
    if (ready.value) accept(ack)
    else pendingPlaybackReady = { ack }
  }

  function release(accept: (ack?: PlaybackEventProtocolAck) => void): boolean {
    if (ready.value || failed.value) return false
    flushPlaybackReady(accept)
    ready.value = true
    return true
  }

  function flushPlaybackReady(accept: (ack?: PlaybackEventProtocolAck) => void): void {
    if (failed.value) return
    const pending = pendingPlaybackReady
    pendingPlaybackReady = undefined
    if (pending) accept(pending.ack)
  }

  function fail(): void {
    ready.value = false; failed.value = true; pendingPlaybackReady = undefined
    detail.value = failedMessage
  }

  function observeNotice(notice: { code: string; message?: string }): void {
    if (!preparationCodes.has(notice.code) || ready.value || failed.value) return
    if (notice.code === 'STARTUP_FAILED') { fail(); return }
    if (notice.message) detail.value = notice.message
  }

  return { ready, failed, message: computed(() => failed.value ? failedMessage : detail.value), acceptPlaybackReady, flushPlaybackReady, release, fail, observeNotice }
}
