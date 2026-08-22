<script setup lang="ts">
type IconName = 'chevron-down' | 'chevron-left' | 'chevron-right' | 'grid' | 'heart' | 'home' | 'list' | 'more' | 'music-note' | 'search' | 'speaker' | 'user'

withDefaults(defineProps<{
  name: IconName
  size?: number
}>(), {
  size: 16,
})
</script>

<template>
  <svg class="sidebar-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-if="name === 'home'" d="m3.5 10.8 8.5-7 8.5 7v8.7a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-8.7Z" />
    <path v-if="name === 'home'" d="M9 21v-6.5h6V21" />
    <path v-if="name === 'heart'" d="M20.8 8.8c0 5.2-8.8 10.2-8.8 10.2S3.2 14 3.2 8.8A4.6 4.6 0 0 1 12 6.3a4.6 4.6 0 0 1 8.8 2.5Z" />
    <path v-if="name === 'list'" d="M8 6h12M8 12h12M8 18h12" />
    <path v-if="name === 'list'" d="M3.5 6h.1M3.5 12h.1M3.5 18h.1" />
    <path v-if="name === 'grid'" d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
    <path v-if="name === 'search'" d="m20 20-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" />
    <path v-if="name === 'speaker'" d="M4 9.5v5h3.5l4.5 3.5V6L7.5 9.5H4ZM16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
    <path v-if="name === 'user'" d="M20 20a8 8 0 0 0-16 0M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
    <path v-if="name === 'music-note'" d="M9 18.5a3 3 0 1 1-3-3c1.1 0 2.1.6 2.6 1.5V5l9-2v11.5a3 3 0 1 1-3-3c1.1 0 2.1.6 2.6 1.5V7.4L9 9V18.5Z" />
    <path v-if="name === 'chevron-down'" d="m6 9 6 6 6-6" />
    <path v-if="name === 'chevron-left'" d="m15 18-6-6 6-6" />
    <path v-if="name === 'chevron-right'" d="m9 18 6-6-6-6" />
    <path v-if="name === 'more'" d="M5 12h.1M12 12h.1M19 12h.1" stroke-width="2.5" />
  </svg>
</template>
