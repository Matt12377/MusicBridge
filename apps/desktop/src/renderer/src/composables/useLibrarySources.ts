import { ref } from 'vue'
import type { PlaylistSummary } from '@music-bridge/contracts'

export type PlaylistLoadState = 'loading' | 'ready' | 'error'

/** 只管理公开歌单列表与其加载状态，不保存账户或 Provider 会话资料。 */
export function useLibrarySources() {
  const playlists = ref<readonly PlaylistSummary[]>([])
  const playlistState = ref<PlaylistLoadState>('ready')
  const playlistError = ref<unknown | null>(null)
  let operation = 0

  async function loadPlaylists(): Promise<void> {
    const currentOperation = ++operation
    playlistState.value = 'loading'
    playlistError.value = null

    try {
      const result = await window.musicBridge.getUserPlaylists()
      if (currentOperation !== operation) return
      playlists.value = result
      playlistState.value = 'ready'
    } catch (error) {
      if (currentOperation !== operation) return
      playlistError.value = error
      playlistState.value = 'error'
    }
  }

  function reset(): void {
    operation += 1
    playlists.value = []
    playlistError.value = null
    playlistState.value = 'ready'
  }

  return {
    playlists,
    playlistState,
    playlistError,
    loadPlaylists,
    reset,
  }
}
