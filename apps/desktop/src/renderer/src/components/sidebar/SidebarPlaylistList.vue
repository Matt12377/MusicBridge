<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PlaylistSummary } from '@music-bridge/contracts'
import SidebarIcon from './SidebarIcon.vue'
import SidebarPlaylistRow from './SidebarPlaylistRow.vue'

const props = defineProps<{
  playlists: readonly PlaylistSummary[]
  expanded: boolean
  activePlaylistId?: string
  state: 'loading' | 'ready' | 'error'
}>()

const emit = defineEmits<{
  select: [playlistId: string]
  retry: []
}>()

const root = ref<HTMLElement | null>(null)
const popup = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const popupStyle = ref<Record<string, string>>({})
const open = ref(false)
const listExpanded = ref(true)

async function toggle(): Promise<void> {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const height = Math.min(420, window.innerHeight - 32)
  popupStyle.value = {
    top: `${Math.max(16, Math.min(rect.top, window.innerHeight - height - 16))}px`,
    left: `${Math.max(16, Math.min(rect.right + 8, window.innerWidth - 248))}px`,
    maxHeight: `${height}px`,
  }
  open.value = !open.value
  if (open.value) { await nextTick(); popup.value?.focus() }
}

function closeOnOutside(event: MouseEvent): void {
  if (open.value && !root.value?.contains(event.target as Node) && !popup.value?.contains(event.target as Node)) open.value = false
}

function close(): void { open.value = false }
function closeWithFocus(): void { close(); trigger.value?.focus() }
function selectPlaylist(playlistId: string): void {
  closeWithFocus()
  emit('select', playlistId)
}

watch(() => [props.expanded, props.state], close)
onMounted(() => {
  document.addEventListener('mousedown', closeOnOutside)
  window.addEventListener('resize', close)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', closeOnOutside)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <section class="sidebar-playlist-section" aria-label="歌单" :data-sidebar-playlist-state="state">
    <h2 v-if="expanded" class="sidebar-playlist-heading">
      <button type="button" class="sidebar-playlist-toggle" aria-label="网易云歌单" :aria-expanded="listExpanded" aria-controls="sidebar-netease-playlists" :title="listExpanded ? '收起网易云歌单' : '展开网易云歌单'" @click="listExpanded = !listExpanded">
        <span>网易云歌单</span>
        <SidebarIcon :name="listExpanded ? 'chevron-down' : 'chevron-right'" :size="14" />
      </button>
    </h2>
    <h2 v-else class="sidebar-section-title">网易云歌单</h2>
    <div id="sidebar-netease-playlists">
      <template v-if="!expanded || listExpanded">
        <div v-if="state === 'loading'" class="sidebar-playlist-list" aria-label="歌单加载中" aria-busy="true">
          <span v-for="index in 4" :key="index" class="sidebar-playlist-skeleton"><i></i><b></b></span>
        </div>
        <div v-else-if="state === 'error'" class="sidebar-playlist-error" role="status">
          <span v-if="expanded">歌单暂时无法加载</span>
          <button type="button" class="sidebar-retry-button" @click="emit('retry')">重试</button>
        </div>
        <div v-else-if="playlists.length && expanded" class="sidebar-playlist-list">
          <SidebarPlaylistRow v-for="playlist in playlists" :key="playlist.id" :playlist="playlist" :expanded="expanded" :selected="activePlaylistId === playlist.id" @select="emit('select', playlist.id)" />
        </div>
        <div v-else-if="playlists.length" ref="root" class="sidebar-collapsed-playlist-control">
          <button ref="trigger" type="button" class="sidebar-collapsed-source-button" :aria-expanded="open" aria-haspopup="dialog" aria-label="歌单" title="歌单" @click="toggle">
            <SidebarIcon name="music-note" />
          </button>
          <Teleport to="body">
            <div v-if="open" ref="popup" class="sidebar-popover sidebar-playlist-popover" :style="popupStyle" tabindex="-1" role="dialog" aria-label="歌单" @keydown.esc="closeWithFocus">
              <strong>歌单</strong>
              <div class="sidebar-playlist-list">
                <SidebarPlaylistRow v-for="playlist in playlists" :key="playlist.id" :playlist="playlist" :expanded="true" :selected="activePlaylistId === playlist.id" @select="selectPlaylist(playlist.id)" />
              </div>
            </div>
          </Teleport>
        </div>
        <p v-else-if="expanded" class="sidebar-empty-playlists">暂无歌单</p>
      </template>
    </div>
  </section>
</template>
