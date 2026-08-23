<script setup lang="ts">
import type { DailyRecommendationTrack } from '@music-bridge/contracts'
import TrackTable from '../media/TrackTable.vue'

const props = defineProps<{
  dayKey: string
  tracks: readonly DailyRecommendationTrack[]
  state: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  error?: string | null
}>()

const emit = defineEmits<{
  back: []
  play: [track: DailyRecommendationTrack]
  queue: [track: DailyRecommendationTrack]
  retry: []
  'play-all': []
}>()
</script>

<template>
  <section class="view daily-recommendations-view" aria-labelledby="daily-view-heading">
    <button type="button" class="back-link" aria-label="返回主页" @click="emit('back')">← 返回主页</button>
    <div class="view-heading">
      <div><p class="section-kicker">网易云音乐 · {{ props.dayKey }}</p><h2 id="daily-view-heading">每日推荐</h2><p class="lede">今天为你准备的歌曲，保持连续列表阅读，也保留封面识别。</p></div>
      <div class="button-row"><button type="button" class="secondary-button" :disabled="props.state === 'loading'" @click="emit('retry')">刷新推荐</button><button type="button" class="primary-button" :disabled="!props.tracks.length" @click="emit('play-all')">播放全部</button></div>
    </div>
    <p v-if="props.state === 'error'" class="persistent-error">{{ props.error ?? '每日推荐暂时不可用。' }}</p>
    <TrackTable :tracks="props.tracks" :busy="props.state === 'loading'" :total="props.tracks.length" :has-more="false" empty-title="今天没有推荐歌曲" empty-copy="每日推荐为空时，这里不会伪造内容。" empty-glyph="✦" @play="emit('play', $event)" @queue="emit('queue', $event)" @play-next="emit('queue', $event)" />
  </section>
</template>
