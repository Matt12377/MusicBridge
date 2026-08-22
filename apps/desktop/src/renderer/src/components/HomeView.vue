<script setup lang="ts">
import type { LyricsSnapshot, PlaybackSnapshot, PublicRoonZone, TrackSummary } from '@music-bridge/contracts'
import type { ViewId } from './navigation.js'

defineProps<{
  currentTrack?: TrackSummary
  selectedZone?: PublicRoonZone
  playbackState: PlaybackSnapshot | null
  lyricsSnapshot: LyricsSnapshot
  currentLyricLine?: string
  resumeTracks: readonly TrackSummary[]
}>()

const emit = defineEmits<{
  navigate: [view: ViewId]
  play: [track: TrackSummary]
}>()
</script>

<template>
  <section class="view home-view" aria-labelledby="home-heading">
    <div class="home-hero">
      <div class="home-hero-copy">
        <p class="section-kicker">Local Hi-Fi console</p>
        <h2 id="home-heading">把音乐留在你选择的 Zone。</h2>
        <p class="lede">控制面板只负责清晰地表达状态与动作，Bridge Core 继续守住 Provider、Roon 和流媒体边界。</p>
        <div class="hero-actions">
          <button type="button" class="primary-button" @click="emit('navigate', 'liked')">打开我喜欢的音乐</button>
          <span class="hero-zone"><i class="status-led" :class="selectedZone ? 'ready' : 'disconnected'"></i>{{ selectedZone?.displayName ?? '尚未选择 Zone' }}</span>
        </div>
      </div>
      <div class="home-hero-art" aria-label="当前播放封面">
        <img v-if="currentTrack?.artworkUrl" :src="currentTrack.artworkUrl" :alt="`${currentTrack.title} 封面`" />
        <span v-else aria-hidden="true">MB</span>
        <small>{{ playbackState?.state === 'playing' ? 'NOW PLAYING' : 'READY WHEN YOU ARE' }}</small>
      </div>
    </div>

    <div class="home-section-heading">
      <div>
        <p class="section-kicker">Jump Back In</p>
        <h3>继续聆听</h3>
      </div>
      <button type="button" class="text-button" @click="emit('navigate', 'playlists')">打开所有歌单 →</button>
    </div>

    <div v-if="resumeTracks.length" class="jump-back-in" aria-label="最近内容">
      <button v-for="track in resumeTracks" :key="track.id" type="button" class="album-card" @click="emit('play', track)">
        <span class="album-art">
          <img v-if="track.artworkUrl" :src="track.artworkUrl" :alt="`${track.title} 封面`" loading="lazy" />
          <span v-else aria-hidden="true">♪</span>
        </span>
        <strong>{{ track.title }}</strong>
        <small>{{ track.artists.join('、') }}</small>
      </button>
    </div>
    <div v-else class="jump-back-in empty-collection">
      <span class="empty-glyph" aria-hidden="true">♫</span>
      <div><strong>你的下一首歌从这里开始</strong><p>完成一次搜索或播放后，最近内容会出现在这里。</p></div>
      <button type="button" class="secondary-button" @click="emit('navigate', 'search')">探索音乐</button>
    </div>

    <div class="overview-grid">
      <article class="feature-card feature-card-accent">
        <p class="section-kicker">Now Playing</p>
        <h3>{{ currentTrack?.title ?? '还没有正在播放的内容' }}</h3>
        <p>{{ currentTrack ? `${currentTrack.artists.join('、')} · ${currentTrack.album}` : '从 Search 或 Library 选择一首歌曲开始。' }}</p>
        <p class="home-card-footnote">从底部播放器打开详情</p>
      </article>
      <article class="feature-card">
        <p class="section-kicker">Queue</p>
        <h3>{{ playbackState?.queue.items.length ?? 0 }} 首待播</h3>
        <p>{{ selectedZone?.displayName ?? '尚未选择 Zone' }}</p>
        <p class="home-card-footnote">从底部播放器打开队列</p>
      </article>
      <article class="feature-card">
        <p class="section-kicker">Lyrics</p>
        <h3>{{ lyricsSnapshot.status === 'ready' ? '同步中' : '等待内容' }}</h3>
        <p>{{ currentLyricLine ?? '当前曲目歌词状态会显示在 Now Playing。' }}</p>
        <p class="home-card-footnote">从底部播放器打开歌词</p>
      </article>
    </div>
  </section>
</template>
