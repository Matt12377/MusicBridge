<script setup lang="ts">
import { ref } from 'vue'
import type { LocalLyricsMatchSnapshot, LyricsSnapshot, TrackSummary } from '@music-bridge/contracts'
import LyricsLines from './LyricsLines.vue'
import LocalLyricsMatchDrawer from './LocalLyricsMatchDrawer.vue'

const props = defineProps<{
  currentTrack?: TrackSummary
  snapshot: LyricsSnapshot
  localLyricsMatchState: LocalLyricsMatchSnapshot
  localLyricsMatchBusy?: boolean
  localLyricsMatchError?: boolean
}>()

const emit = defineEmits<{
  'select-lyrics-match': [matchSessionId: string, candidateId: string]
  'revoke-lyrics-match': []
}>()
const lyricsMatchOpen = ref(false)
</script>

<template>
  <div class="lyrics-panel" aria-live="polite">
    <div class="panel-heading">
      <div><p class="section-kicker">歌词</p><h3>同步歌词</h3></div>
      <span>{{ { idle: '待播放', loading: '正在读取', ready: '已同步', instrumental: '纯音乐', unavailable: '暂无歌词', error: '歌词不可用' }[snapshot.status] }}</span>
    </div>
    <p class="empty-copy">歌词只在内存中处理。</p>
    <div v-if="snapshot.source === 'netease' || localLyricsMatchState.status !== 'hidden'" class="lyrics-panel-source-row">
      <span v-if="snapshot.source === 'netease'">歌词来源：网易云</span>
      <button v-if="localLyricsMatchState.status !== 'hidden'" type="button" class="text-button" aria-haspopup="dialog" :aria-expanded="lyricsMatchOpen" @click="lyricsMatchOpen = true">{{ localLyricsMatchState.status === 'needs-choice' ? '选择匹配歌词' : '歌词匹配' }}</button>
    </div>
    <p v-if="!currentTrack" class="empty-copy">播放内容后，歌词会在这里出现。</p>
    <p v-else-if="snapshot.status === 'loading'" class="empty-copy">歌词读取中…</p>
    <p v-else-if="snapshot.status === 'instrumental'" class="empty-copy">纯音乐，暂无歌词。</p>
    <p v-else-if="snapshot.status === 'unavailable'" class="empty-copy">暂无可用歌词。</p>
    <p v-else-if="snapshot.status === 'error'" class="empty-copy">歌词不可用。</p>
    <LyricsLines v-else :snapshot="snapshot" :track-id="currentTrack?.id" />
    <LocalLyricsMatchDrawer v-if="lyricsMatchOpen" :state="props.localLyricsMatchState" :busy="props.localLyricsMatchBusy" :error="props.localLyricsMatchError" @close="lyricsMatchOpen = false" @select="(sessionId, candidateId) => emit('select-lyrics-match', sessionId, candidateId)" @revoke="emit('revoke-lyrics-match')" />
  </div>
</template>
