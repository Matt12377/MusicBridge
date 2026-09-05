<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PlaylistSummary } from '@music-bridge/contracts'
import type { SidebarSource } from '../navigation.js'
import SidebarHeader from './SidebarHeader.vue'
import SidebarSettingsFooter from './SidebarSettingsFooter.vue'
import SidebarNavRow from './SidebarNavRow.vue'
import SidebarPlaylistList from './SidebarPlaylistList.vue'
import SidebarSearch from './SidebarSearch.vue'

const props = defineProps<{
  expanded: boolean
  activeSource: SidebarSource
  searchQuery: string
  playlists: readonly PlaylistSummary[]
  playlistState: 'loading' | 'ready' | 'error'
  sourceScrollTop: number
  settingsActive: boolean
}>()

const emit = defineEmits<{
  toggle: []
  navigate: [source: SidebarSource]
  'update:searchQuery': [value: string]
  'clear-search': []
  'retry-playlists': []
  'scroll-source': [scrollTop: number]
  settings: []
}>()

const sourceScroll = ref<HTMLElement | null>(null)

function restoreSourceScroll(): void {
  void nextTick(() => {
    if (sourceScroll.value) sourceScroll.value.scrollTop = props.sourceScrollTop
  })
}

function isSourceSelected(type: SidebarSource['type']): boolean {
  if (type === 'roon-albums') {
    return props.activeSource.type === 'roon-albums' || props.activeSource.type === 'roon-album'
  }
  if (type === 'roon-artists') {
    return props.activeSource.type === 'roon-artists' || props.activeSource.type === 'roon-artist'
  }
  if (type === 'roon-genres') {
    return props.activeSource.type === 'roon-genres' || props.activeSource.type === 'roon-genre'
  }
  if (type === 'roon-playlists') {
    return props.activeSource.type === 'roon-playlists' || props.activeSource.type === 'roon-playlist'
  }
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
      <div class="sidebar-primary-navigation">
        <SidebarNavRow source="home" label="主页" icon="home" :expanded="expanded" :selected="isSourceSelected('home')" @select="selectSource({ type: 'home' })" />
        <SidebarNavRow source="roon-albums" label="专辑" icon="vinyl" :expanded="expanded" :selected="isSourceSelected('roon-albums')" @select="selectSource({ type: 'roon-albums' })" />
        <SidebarNavRow source="roon-artists" label="艺术家" icon="people" :expanded="expanded" :selected="isSourceSelected('roon-artists')" @select="selectSource({ type: 'roon-artists' })" />
        <SidebarNavRow source="roon-genres" label="流派" icon="collection" :expanded="expanded" :selected="isSourceSelected('roon-genres')" @select="selectSource({ type: 'roon-genres' })" />
        <SidebarNavRow source="roon-favorites" label="收藏" icon="bookmark" :expanded="expanded" :selected="isSourceSelected('roon-favorites')" @select="selectSource({ type: 'roon-favorites' })" />
        <SidebarNavRow source="collection" label="实物收藏" icon="cassette" :expanded="expanded" :selected="isSourceSelected('collection')" @select="selectSource({ type: 'collection' })" />
        <SidebarNavRow source="recording" label="录音" icon="record" :expanded="expanded" :selected="isSourceSelected('recording')" @select="selectSource({ type: 'recording' })" />
      </div>
      <SidebarPlaylistList :playlists="playlists" :expanded="expanded" :active-source="activeSource" @navigate="selectSource" :active-playlist-id="activeSource.type === 'playlist' ? activeSource.playlistId : undefined" :state="playlistState" @select="selectSource({ type: 'playlist', playlistId: $event })" @retry="emit('retry-playlists')" />
    </nav>
    <SidebarSettingsFooter :expanded="expanded" :active="settingsActive" @open="emit('settings')" />
  </aside>
</template>
