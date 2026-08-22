<script setup lang="ts">
import type { LyricsSnapshot, TrackSummary } from '@music-bridge/contracts'

defineProps<{
  currentTrack?: TrackSummary
  snapshot: LyricsSnapshot
}>()
</script>

<template>
  <div class="lyrics-panel" aria-live="polite">
    <div class="panel-heading">
      <div><p class="section-kicker">Synchronized</p><h3>同步歌词 / 歌词</h3></div>
      <span>{{ snapshot.status }}</span>
    </div>
    <p class="empty-copy">歌词只在内存中处理。</p>
    <p v-if="!currentTrack" class="empty-copy">播放内容后，歌词会在这里出现。</p>
    <p v-else-if="snapshot.status === 'loading'" class="empty-copy">歌词读取中…</p>
    <p v-else-if="snapshot.status === 'instrumental'" class="empty-copy">纯音乐，暂无歌词。</p>
    <p v-else-if="snapshot.status === 'unavailable'" class="empty-copy">暂无可用歌词。</p>
    <p v-else-if="snapshot.status === 'error'" class="empty-copy">歌词暂时不可用。</p>
    <div v-else class="lyrics-lines">
      <p v-for="(line, lineIndex) in snapshot.lines" :key="`${line.startMs}-${lineIndex}`" :class="{ active: snapshot.activeLineIndex === lineIndex }" class="lyrics-line">
        <span v-if="line.words?.length" class="lyrics-words">
          <span v-for="(word, wordIndex) in line.words" :key="`${word.startMs}-${wordIndex}`" :class="{ 'word-active': snapshot.activeLineIndex === lineIndex && snapshot.activeWordIndex === wordIndex }">{{ word.text }}</span>
        </span>
        <span v-else>{{ line.text }}</span>
        <small v-if="line.translation">{{ line.translation }}</small>
        <small v-if="line.romanization">{{ line.romanization }}</small>
      </p>
    </div>
  </div>
</template>
