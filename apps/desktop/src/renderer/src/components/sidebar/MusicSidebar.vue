<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PlaylistSummary, PublicAuthState, PublicRoonZone } from '@music-bridge/contracts'
import type { SidebarSource } from '../navigation.js'
import AccountButton from './SidebarAccountButton.vue'
import SidebarHeader from './SidebarHeader.vue'
import SidebarNavRow from './SidebarNavRow.vue'
import SidebarPlaylistList from './SidebarPlaylistList.vue'
import SidebarSearch from './SidebarSearch.vue'
import SidebarSection from './SidebarSection.vue'
import SidebarZoneButton from './SidebarZoneButton.vue'

const props = defineProps<{
  expanded: boolean
  activeSource: SidebarSource
  searchQuery: string
  playlists: readonly PlaylistSummary[]
  playlistState: 'loading' | 'ready' | 'error'
  sourceScrollTop: number
  selectedZone?: PublicRoonZone
  zones: readonly PublicRoonZone[]
  roonStatus: string
  authState: PublicAuthState
}>()

const emit = defineEmits<{
  toggle: []
  navigate: [source: SidebarSource]
  'update:searchQuery': [value: string]
  'clear-search': []
  'retry-playlists': []
  'select-zone': [zoneId: string]
  account: [action: 'login' | 'settings' | 'diagnostics' | 'logout']
  'scroll-source': [scrollTop: number]
}>()

const sourceScroll = ref<HTMLElement | null>(null)

function restoreSourceScroll(): void {
  void nextTick(() => {
    if (sourceScroll.value) sourceScroll.value.scrollTop = props.sourceScrollTop
  })
}

function isSourceSelected(type: 'home' | 'liked' | 'playlists'): boolean {
  return props.activeSource.type === type
}

function selectSource(source: SidebarSource): void {
  emit('navigate', source)
}

function requestExpand(): void {
  if (!props.expanded) emit('toggle')
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.metaKey && event.key === '\\') {
    event.preventDefault()
    emit('toggle')
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
watch(() => props.activeSource, restoreSourceScroll)
watch(() => props.expanded, restoreSourceScroll)
onMounted(restoreSourceScroll)
</script>

<template>
  <aside class="music-sidebar" :class="{ 'is-collapsed': !expanded }" data-component="MusicSidebar">
    <SidebarHeader :expanded="expanded" @toggle="emit('toggle')" />
    <SidebarSearch :model-value="searchQuery" :expanded="expanded" @update:model-value="emit('update:searchQuery', $event)" @clear-search="emit('clear-search')" @expand="requestExpand" />

    <nav ref="sourceScroll" class="sidebar-source-scroll" aria-label="音乐来源" @scroll="emit('scroll-source', ($event.target as HTMLElement).scrollTop)">
      <SidebarSection title="发现" :expanded="expanded">
        <SidebarNavRow source="home" label="主页" icon="home" :expanded="expanded" :selected="isSourceSelected('home')" @select="selectSource({ type: 'home' })" />
      </SidebarSection>

      <SidebarSection title="资料库" :expanded="expanded">
        <SidebarNavRow source="liked" label="我喜欢的音乐" icon="heart" :expanded="expanded" :selected="isSourceSelected('liked')" @select="selectSource({ type: 'liked' })" />
        <SidebarNavRow source="playlists" label="所有歌单" icon="grid" :expanded="expanded" :selected="isSourceSelected('playlists')" @select="selectSource({ type: 'playlists' })" />
      </SidebarSection>

      <SidebarPlaylistList :playlists="playlists" :expanded="expanded" :active-playlist-id="activeSource.type === 'playlist' ? activeSource.playlistId : undefined" :state="playlistState" @select="selectSource({ type: 'playlist', playlistId: $event })" @retry="emit('retry-playlists')" />
    </nav>

    <footer class="sidebar-footer">
      <SidebarZoneButton :zones="zones" :selected-zone="selectedZone" :roon-status="roonStatus" :expanded="expanded" @select="emit('select-zone', $event)" />
      <AccountButton :auth-state="authState" :expanded="expanded" @action="emit('account', $event)" />
    </footer>
  </aside>
</template>
