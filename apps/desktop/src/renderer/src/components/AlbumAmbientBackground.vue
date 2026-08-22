<script setup lang="ts">
import type { TrackSummary } from '@music-bridge/contracts'

defineProps<{
  currentTrack?: TrackSummary
}>()
</script>

<template>
  <div class="album-ambient" aria-hidden="true">
    <Transition name="ambient-cover" mode="out-in">
      <div
        v-if="currentTrack?.artworkUrl"
        :key="`${currentTrack.id}:${currentTrack.artworkUrl}`"
        class="album-ambient-cover"
      >
        <img :src="currentTrack.artworkUrl" alt="" />
      </div>
    </Transition>
    <div class="album-ambient-wash"></div>
    <div class="album-ambient-vignette"></div>
  </div>
</template>
