<script setup lang="ts">
// 复用已认可 HTML 的 Bootstrap Icons；保持既有组件的名称与尺寸接口。
const icons = {
  'chevron-down': 'chevron-down', 'chevron-left': 'chevron-left', 'chevron-right': 'chevron-right',
  grid: 'grid', heart: 'heart', home: 'house-door', list: 'list-ul', more: 'three-dots',
  'music-note': 'music-note-beamed', next: 'skip-end-fill', pause: 'pause-fill', play: 'play-fill',
  previous: 'skip-start-fill', search: 'search', speaker: 'speaker', user: 'person',
  cassette: 'cassette', record: 'record-circle', settings: 'sliders', refresh: 'arrow-clockwise',
  vinyl: 'vinyl', people: 'people', collection: 'collection', bookmark: 'bookmark-heart',
  'music-list': 'music-note-list',
} as const
withDefaults(defineProps<{ name: keyof typeof icons; size?: number }>(), { size: 16 })
</script>

<template>
  <i class="sidebar-icon bi" :class="`bi-${icons[name]}`" :style="{ fontSize: `${size}px`, width: `${size}px`, height: `${size}px` }" aria-hidden="true"></i>
</template>

<style scoped>
.sidebar-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; line-height: 1; }
</style>
