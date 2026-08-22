<script setup lang="ts">
import type { LyricsSnapshot, PlaybackIssue, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'

const props = defineProps<{
  currentTrack?: TrackSummary
  playbackState: PlaybackSnapshot | null
  lyricsSnapshot: LyricsSnapshot
  qualityLabel: (quality: string | undefined) => string
  qualityNotice?: PlaybackIssue
  playbackIssueMessage: (issue: PlaybackIssue) => string
}>()

const emit = defineEmits<{
  previous: []
  stop: []
  next: []
}>()

function hideBrokenArtwork(event: Event): void {
  const image = event.currentTarget as HTMLImageElement
  image.hidden = true
}
</script>

<template>
  <section class="view now-playing-view" aria-labelledby="listening-heading">
    <div class="now-playing-immersive">
      <div class="now-playing-art"><span class="artwork-fallback" aria-hidden="true">♪</span><img v-if="props.currentTrack?.artworkUrl" :src="props.currentTrack.artworkUrl" :alt="`${props.currentTrack.title} 封面`" @error="hideBrokenArtwork" /></div>
      <div class="now-playing-copy">
        <p class="section-kicker">正在播放</p>
        <h2 id="listening-heading">{{ props.currentTrack?.title ?? '还没有正在播放的歌曲' }}</h2>
        <p class="artist-line">{{ props.currentTrack ? `${props.currentTrack.artists.join('、')} · ${props.currentTrack.album}` : '从歌曲列表选择内容开始。' }}</p>
        <p class="quality-line">请求 {{ props.qualityLabel(props.playbackState?.requestedQuality) }} · 实际 {{ props.qualityLabel(props.playbackState?.actualQuality) }} · {{ props.playbackState?.format ?? '—' }} · {{ props.playbackState?.bitrate ? `${Math.round(props.playbackState.bitrate / 1000)} kbps` : '—' }}</p>
        <div class="transport-controls">
          <button type="button" class="transport-button" :disabled="!props.playbackState?.canPrevious" @click="emit('previous')">上一首</button>
          <button type="button" class="transport-button stop-button" :disabled="!props.playbackState?.canStop" @click="emit('stop')">停止</button>
          <button type="button" class="transport-button" :disabled="!props.playbackState?.canNext" @click="emit('next')">下一首</button>
        </div>
      </div>
      <div class="now-playing-lyrics-preview" aria-label="同步歌词预览">
        <div class="panel-heading"><div><p class="section-kicker">歌词</p><h3>同步歌词</h3></div><span>打开右侧检查器查看全部</span></div>
        <div v-if="props.lyricsSnapshot.lines.length" class="lyrics-preview-lines">
          <p v-for="(line, index) in props.lyricsSnapshot.lines.slice(0, 7)" :key="`${line.startMs}-${index}`" class="lyrics-preview-line" :class="{ active: props.lyricsSnapshot.activeLineIndex === index }">{{ line.text }}<small v-if="line.translation">{{ line.translation }}</small></p>
        </div>
        <p v-else class="empty-copy">播放内容后，同步歌词会在这里出现。</p>
      </div>
    </div>

    <p v-if="props.qualityNotice" class="persistent-error">{{ props.playbackIssueMessage(props.qualityNotice) }}<span>诊断标识：{{ props.qualityNotice.diagnosticId }}</span></p>
  </section>
</template>
