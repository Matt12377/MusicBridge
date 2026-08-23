<script setup lang="ts">
import type { DailyRecommendationTrack } from '@music-bridge/contracts'

const props = defineProps<{
  dayKey: string
  tracks: readonly DailyRecommendationTrack[]
  state: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  authenticated: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  play: [track: DailyRecommendationTrack]
  'play-all': []
  'view-all': []
  'open-settings': []
  retry: []
}>()

function hideBrokenArtwork(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.hidden = true
}

function formatDayKey(dayKey: string): string {
  const parts = dayKey.split('-')
  return parts.length === 3 ? parts[1] + '/' + parts[2] : dayKey
}
</script>

<template>
  <section class="home-media-section daily-recommendations-section" aria-labelledby="daily-recommendations-heading">
    <div class="home-section-heading">
      <div class="daily-heading-copy">
        <span class="daily-date-badge" aria-hidden="true"><strong>{{ formatDayKey(props.dayKey) }}</strong><small>今日</small></span>
        <div><p class="section-kicker">网易云音乐</p><h3 id="daily-recommendations-heading">每日推荐</h3><p class="daily-heading-note">根据你的听歌偏好，为今天挑选的歌曲</p></div>
      </div>
      <div class="home-section-actions">
        <button type="button" class="text-button" :disabled="props.state === 'loading'" @click="emit('view-all')">查看全部 →</button>
        <button type="button" class="text-button" :disabled="props.state === 'loading'" @click="emit('retry')">刷新</button>
      </div>
    </div>

    <div v-if="props.state === 'loading'" class="daily-recommendation-grid daily-recommendation-grid-loading" aria-label="正在读取每日推荐">
      <span v-for="index in 8" :key="index" class="daily-recommendation-skeleton"></span>
    </div>
    <div v-else-if="props.tracks.length" class="daily-recommendation-grid" aria-label="每日推荐歌曲">
      <button v-for="track in props.tracks.slice(0, 8)" :key="track.id" type="button" class="daily-recommendation-tile" :aria-label="'播放 ' + track.title" @click="emit('play', track)">
        <span class="daily-recommendation-art"><span class="artwork-fallback" aria-hidden="true">♪</span><img v-if="track.artworkUrl" :src="track.artworkUrl" :alt="track.title + ' 封面'" loading="lazy" @error="hideBrokenArtwork" /></span>
        <span class="daily-recommendation-copy"><strong>{{ track.title }}</strong><small>{{ track.artists.join('、') }}</small><em v-if="track.recommendationReason">{{ track.recommendationReason }}</em></span>
      </button>
    </div>
    <div v-else-if="props.state === 'error'" class="daily-recommendation-message">
      <div><strong>每日推荐暂时不可用</strong><p>{{ props.error ?? '请稍后重试，登录状态不会因此丢失。' }}</p></div>
      <button type="button" class="secondary-button" @click="emit('retry')">重试</button>
    </div>
    <div v-else-if="!props.authenticated" class="daily-recommendation-message">
      <div><strong>每日推荐需要网易云登录</strong><p>前往 Settings 完成登录后，这里会显示今天的推荐内容。</p></div>
      <button type="button" class="secondary-button" @click="emit('open-settings')">打开 Settings</button>
    </div>
    <div v-else class="daily-recommendation-message">
      <div><strong>今天还没有可显示的推荐</strong><p>网易云每日推荐为空时，这里会保持轻量空状态。</p></div>
      <button type="button" class="secondary-button" @click="emit('view-all')">打开每日推荐</button>
    </div>

    <div v-if="props.tracks.length" class="daily-recommendation-footer">
      <span>{{ props.tracks.length }} 首今日推荐</span>
      <button type="button" class="primary-button" @click="emit('play-all')">播放全部</button>
    </div>
  </section>
</template>
