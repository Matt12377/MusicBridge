<script setup lang="ts">
import { computed } from 'vue'
import type { DailyRecommendationTrack, TrackSummary } from '@music-bridge/contracts'
import type { HomeRecommendationState } from '../composables/homeRecommendations.js'
import type { ViewId } from './navigation.js'
import DailyRecommendationsSection from './home/DailyRecommendationsSection.vue'
import SafeArtwork from './SafeArtwork.vue'

const props = defineProps<{
  currentTrack?: TrackSummary
  likedTracks: readonly TrackSummary[]
  recentTracks: readonly TrackSummary[]
  likedState: 'unauthorized' | 'loading' | 'ready' | 'empty' | 'error'
  likedError?: string | null
  playlistTracks: readonly TrackSummary[]
  playlistRecommendationsState: HomeRecommendationState
  dailyDayKey: string
  dailyTracks: readonly DailyRecommendationTrack[]
  dailyState: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  dailyAuthenticated: boolean
  dailyError?: string | null
  greeting: string
}>()

const emit = defineEmits<{
  navigate: [view: ViewId]
  play: [track: TrackSummary]
  refreshPlaylists: []
  'play-daily': [track: DailyRecommendationTrack]
  'play-all-daily': []
  'view-all-daily': []
  'open-settings': []
  'retry-daily': []
}>()

const playlistCoverTracks = computed(() => props.playlistTracks)

</script>

<template>
  <section class="view home-view" aria-labelledby="home-heading">
    <header class="home-browse-header">
      <div>
        <p class="section-kicker">Music Bridge</p>
        <h2 id="home-heading">{{ props.greeting }}</h2>
        <p class="lede">从你的收藏和歌单继续聆听。</p>
      </div>
    </header>

    <DailyRecommendationsSection
      :day-key="props.dailyDayKey"
      :tracks="props.dailyTracks"
      :state="props.dailyState"
      :authenticated="props.dailyAuthenticated"
      :error="props.dailyError"
      @play="emit('play-daily', $event)"
      @play-all="emit('play-all-daily')"
      @view-all="emit('view-all-daily')"
      @open-settings="emit('open-settings')"
      @retry="emit('retry-daily')"
    />

    <section v-if="props.currentTrack" class="home-continue-hero" aria-labelledby="continue-heading">
      <SafeArtwork class="home-continue-art" :src="props.currentTrack.artworkUrl" :alt="`${props.currentTrack.title} 封面`" loading="eager" />
      <div class="home-continue-copy">
        <p class="section-kicker">继续聆听</p>
        <h3 id="continue-heading">{{ props.currentTrack.title }}</h3>
        <p>{{ props.currentTrack.artists.join('、') }} · {{ props.currentTrack.album }}</p>
        <button type="button" class="secondary-button" @click="emit('play', props.currentTrack)">重新播放</button>
      </div>
    </section>

    <section class="home-media-section" aria-labelledby="liked-home-heading">
      <div class="home-section-heading">
        <div><p class="section-kicker">资料库</p><h3 id="liked-home-heading">我喜欢的音乐</h3></div>
        <button type="button" class="text-button" @click="emit('navigate', 'liked')">查看全部 →</button>
      </div>
      <div v-if="props.likedState === 'loading'" class="home-cover-wall home-cover-wall-loading" aria-label="正在读取收藏" aria-busy="true"><span v-for="index in 6" :key="index" class="home-cover-skeleton"></span></div>
      <div v-else-if="props.likedState === 'ready' && props.likedTracks.length" class="home-cover-wall" aria-label="我喜欢的音乐封面">
        <button v-for="track in props.likedTracks.slice(0, 12)" :key="track.id" type="button" class="home-cover-card" :aria-label="`播放 ${track.title}`" @click="emit('play', track)">
          <SafeArtwork class="home-cover-art" :src="track.artworkUrl" :alt="`${track.title} 封面`" />
          <span class="home-cover-copy"><strong>{{ track.title }}</strong><small>{{ track.artists.join('、') }}</small></span>
        </button>
      </div>
      <div v-else-if="props.likedState === 'unauthorized'" class="empty-collection"><span class="empty-glyph" aria-hidden="true">♫</span><div><strong>登录后查看收藏</strong><p>登录网易云后，你喜欢的音乐会出现在这里。</p></div><button type="button" class="secondary-button" @click="emit('open-settings')">去登录</button></div>
      <div v-else-if="props.likedState === 'error'" class="empty-collection"><span class="empty-glyph" aria-hidden="true">!</span><div><strong>收藏暂时不可用</strong><p>{{ props.likedError || '请稍后重试。' }}</p></div><button type="button" class="secondary-button" @click="emit('navigate', 'liked')">重试</button></div>
      <div v-else class="empty-collection"><span class="empty-glyph" aria-hidden="true">♫</span><div><strong>还没有收藏歌曲</strong><p>你喜欢的音乐会出现在这里。</p></div><button type="button" class="secondary-button" @click="emit('navigate', 'liked')">打开收藏</button></div>
    </section>

    <section class="home-media-section" aria-labelledby="playlist-home-heading">
      <div class="home-section-heading">
        <div><p class="section-kicker">歌单</p><h3 id="playlist-home-heading">来自我的歌单</h3></div>
        <div class="home-section-actions"><span v-if="playlistCoverTracks.length" class="home-section-note">{{ playlistCoverTracks.length }} 首随机内容</span><button type="button" class="text-button" :disabled="props.playlistRecommendationsState === 'loading'" @click="emit('refreshPlaylists')">换一批 ↻</button><button type="button" class="text-button" @click="emit('navigate', 'playlists')">查看全部 →</button></div>
      </div>
      <div v-if="props.playlistRecommendationsState === 'loading'" class="home-cover-wall home-cover-wall-loading" aria-label="正在读取歌单歌曲"><span v-for="index in 12" :key="index" class="home-cover-skeleton"></span></div>
      <div v-else-if="playlistCoverTracks.length" class="home-cover-wall" aria-label="我的歌单随机歌曲">
        <button v-for="track in playlistCoverTracks.slice(0, 12)" :key="track.id" type="button" class="home-cover-card" :aria-label="`播放 ${track.title}`" @click="emit('play', track)">
          <SafeArtwork class="home-cover-art" :src="track.artworkUrl" :alt="`${track.title} 封面`" />
          <span class="home-cover-copy"><strong>{{ track.title }}</strong><small>{{ track.artists.join('、') }}</small></span>
        </button>
      </div>
      <div v-else class="empty-collection"><span class="empty-glyph" aria-hidden="true">♫</span><div><strong>歌单暂时没有可展示的歌曲</strong><p>稍后再刷新一次，主页会从你的歌单中随机抽取内容。</p></div><button type="button" class="secondary-button" @click="emit('refreshPlaylists')">重新读取</button></div>
    </section>

    <section v-if="props.recentTracks.length" class="home-recent-section" aria-labelledby="recent-heading">
      <div class="home-section-heading"><div><p class="section-kicker">最近</p><h3 id="recent-heading">最近听过</h3></div></div>
      <div class="home-recent-list">
        <button v-for="track in props.recentTracks" :key="track.id" type="button" class="home-recent-row" @click="emit('play', track)"><SafeArtwork class="home-recent-art" :src="track.artworkUrl" :alt="`${track.title} 封面`" /><span><strong>{{ track.title }}</strong><small>{{ track.artists.join('、') }} · {{ track.album }}</small></span><span class="home-recent-play" aria-hidden="true">▶</span></button>
      </div>
    </section>
  </section>
</template>
