<script setup lang="ts">
import type { TrackSummary } from '@music-bridge/contracts'
import RoonArtwork from './RoonArtwork.vue'
import SafeArtwork from './SafeArtwork.vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  track?: TrackSummary
  alt?: string
  fallback?: string
  eager?: boolean
  width?: number
  height?: number
}>(), {
  alt: '',
  fallback: '♪',
  eager: false,
  width: 256,
  height: 256,
})
</script>

<template>
  <RoonArtwork
    v-if="props.track?.artworkReference"
    :class="$attrs.class"
    :reference="props.track.artworkReference"
    :alt="props.alt"
    :fallback="props.fallback"
    :width="props.width"
    :height="props.height"
    :eager="props.eager"
  />
  <SafeArtwork
    v-else
    :class="$attrs.class"
    :src="props.track?.artworkUrl"
    :alt="props.alt"
    :fallback="props.fallback"
    :loading="props.eager ? 'eager' : 'lazy'"
  />
</template>
