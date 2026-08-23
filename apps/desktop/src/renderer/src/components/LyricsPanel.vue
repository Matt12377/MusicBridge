<script setup lang="ts">
import type { LyricsSnapshot, TrackSummary } from '@music-bridge/contracts'
import LyricsLines from './LyricsLines.vue'

defineProps<{
  currentTrack?: TrackSummary
  snapshot: LyricsSnapshot
}>()
</script>

<template>
  <div class="lyrics-panel" aria-live="polite">
    <div class="panel-heading">
      <div><p class="section-kicker">歌词</p><h3>同步歌词</h3></div>
      <span>{{ { idle: '待播放', loading: '正在读取', ready: '已同步', instrumental: '纯音乐', unavailable: '暂无歌词', error: '歌词不可用' }[snapshot.status] }}</span>
    </div>
    <p class="empty-copy">歌词只在内存中处理。</p>
    <p v-if="!currentTrack" class="empty-copy">播放内容后，歌词会在这里出现。</p>
    <p v-else-if="snapshot.status === 'loading'" class="empty-copy">歌词读取中…</p>
    <p v-else-if="snapshot.status === 'instrumental'" class="empty-copy">纯音乐，暂无歌词。</p>
    <p v-else-if="snapshot.status === 'unavailable'" class="empty-copy">暂无可用歌词。</p>
    <p v-else-if="snapshot.status === 'error'" class="empty-copy">歌词不可用。</p>
    <LyricsLines v-else :snapshot="snapshot" :track-id="currentTrack?.id" />
  </div>
</template>
