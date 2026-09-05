<script setup lang="ts">
import { computed } from 'vue'
import type { TrackSummary } from '@music-bridge/contracts'
import defaultScene from '../assets/ambient-default-scene.png'
import { decodeAmbientImage, useAmbientArtwork } from '../composables/ambientArtwork.js'
import { roonArtworkCache } from '../roon-artwork-cache.js'

const props = defineProps<{
  currentTrack?: TrackSummary
}>()

const source = computed(() => props.currentTrack?.artworkReference
  ? `roon:${props.currentTrack.artworkReference}`
  : props.currentTrack?.artworkUrl)
const artwork = useAmbientArtwork(source, defaultScene, async src => {
  if (!src.startsWith('roon:')) return decodeAmbientImage(src)
  const lease = await roonArtworkCache.acquire({ reference: src.slice(5), width: 768, height: 768, scale: 'fit', format: 'image/jpeg' })
  return { src: lease.url, release: () => lease.release() }
})
const releaseFrame = (element: Element) => artwork.releaseFrame(element.getAttribute('data-artwork-src') ?? '')
</script>

<template>
  <div class="album-ambient" :class="{ 'has-cover': artwork.isCover }" aria-hidden="true">
    <Transition name="ambient-cover" @after-leave="releaseFrame">
      <div
        :key="artwork.src"
        class="ambient-image-frame"
        :class="{ 'album-ambient-cover': artwork.isCover }"
        :data-artwork-src="artwork.src"
      >
        <img :src="artwork.src" alt="" />
      </div>
    </Transition>
    <div class="album-ambient-wash"></div>
  </div>
</template>
