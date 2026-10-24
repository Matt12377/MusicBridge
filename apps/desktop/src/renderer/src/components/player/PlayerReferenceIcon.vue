<script setup lang="ts">
withDefaults(defineProps<{
  name: 'queue' | 'airplay' | 'volume' | 'previous' | 'next' | 'play' | 'pause' | 'shuffle' | 'repeat'
  size?: number
}>(), { size: 44 })
</script>

<template>
  <svg class="player-reference-icon" :width="size" :height="size" viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
    <g v-if="name === 'queue'" fill="currentColor">
      <circle cx="6" cy="10" r="2.1" /><circle cx="6" cy="22" r="2.1" /><circle cx="6" cy="34" r="2.1" />
      <path d="M16 10h22M16 22h22M16 34h22" stroke="currentColor" stroke-width="3.3" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'airplay'" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 33a17 17 0 1 1 24 0M14 29a11.5 11.5 0 1 1 16 0M18 25a6 6 0 1 1 8 0" />
      <path d="m22 27-10.5 13h21L22 27Z" />
    </g>
    <g v-else-if="name === 'volume'">
      <path d="M4 15h7.2L20 7.7c1.3-1.1 3-.2 3 1.4v25.8c0 1.6-1.7 2.5-3 1.4L11.2 29H4a2 2 0 0 1-2-2V17a2 2 0 0 1 2-2Z" fill="currentColor" />
      <path d="M28.5 14a12 12 0 0 1 0 16M34 9a19 19 0 0 1 0 26" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'previous' || name === 'next'" :transform="name === 'next' ? 'translate(44 0) scale(-1 1)' : undefined" fill="currentColor">
      <path d="M20 10.4c0-1.7-1.8-2.7-3.2-1.8L2.9 20.2a2.2 2.2 0 0 0 0 3.6l13.9 11.6c1.4.9 3.2-.1 3.2-1.8V10.4Z" />
      <path d="M41 10.4c0-1.7-1.8-2.7-3.2-1.8L23.9 20.2a2.2 2.2 0 0 0 0 3.6l13.9 11.6c1.4.9 3.2-.1 3.2-1.8V10.4Z" />
    </g>
    <path v-else-if="name === 'play'" d="M10 5.7c0-2.1 2.3-3.3 4-2.1l24 16a2.9 2.9 0 0 1 0 4.8l-24 16c-1.7 1.2-4 0-4-2.1V5.7Z" fill="currentColor" />
    <g v-else-if="name === 'pause'" fill="currentColor"><rect x="10" y="6" width="9" height="32" rx="2" /><rect x="25" y="6" width="9" height="32" rx="2" /></g>
    <g v-else-if="name === 'shuffle'" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 11h5c9 0 14 22 23 22h6m-6-6 6 6-6 6M5 33h5c3 0 6-4 8-8m8-9c3-4 4-5 7-5h6m-6-6 6 6-6 6" />
    </g>
    <g v-else-if="name === 'repeat'" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 27v-9a6 6 0 0 1 6-6h21m-6-6 6 6-6 6M35 17v9a6 6 0 0 1-6 6H8m6-6-6 6 6 6" />
    </g>
  </svg>
</template>

<style scoped>
.player-reference-icon { display: block; flex: 0 0 auto; overflow: visible; }
</style>
