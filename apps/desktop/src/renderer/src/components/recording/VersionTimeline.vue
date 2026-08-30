<script setup lang="ts">
import type { MasterContent, VersionTimeline } from '@music-bridge/contracts'
defineProps<{ timeline: VersionTimeline; content: MasterContent }>()
const number = (value: number): string => value.toLocaleString('en-US')
</script>
<template>
  <div class="version-timeline">
    <p class="timebase">{{ number(timeline.sampleRate) }} Hz · 整数采样帧 · 最近整数，半帧向上取整</p>
    <div class="sides">
      <article v-for="side in timeline.sides" :key="side.name">
        <h4>{{ side.name === 'Program' ? '连续 Program' : `${side.name} 面` }}</h4>
        <p class="total">{{ number(side.totalFrames) }} <span>帧 / {{ number(side.capacityFrames) }} 帧容量</span></p>
        <p class="muted">开头 {{ number(side.leadInFrames) }} 帧 · 结尾 {{ number(side.tailFrames) }} 帧</p>
        <p class="muted">{{ number(side.tracks.reduce((sum, track) => sum + track.gapAfterFrames, 0)) }} 帧曲间静音</p>
        <ol v-if="side.tracks.length"><li v-for="track in side.tracks" :key="track.trackId">
          <strong>{{ content.tracks.find(t => t.trackId === track.trackId)?.metadata.title ?? '历史曲目' }}</strong>
          <span>{{ number(track.startFrame) }} → {{ number(track.endFrame) }} 帧</span>
          <small>源 {{ number(track.sourceFrames) }} 帧 @ {{ number(track.sourceSampleRate) }} Hz · 之后静音 {{ number(track.gapAfterFrames) }} 帧</small>
        </li></ol><p v-else class="muted">空面，不添加留白</p>
      </article>
    </div>
  </div>
</template>
<style scoped>
.timebase,.muted,small{color:var(--mb-text-secondary)}.timebase{margin:16px 0}.sides{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.sides article{padding:16px;border:1px solid var(--mb-glass-border);border-radius:12px;min-width:0}h4{font-size:16px;margin:0 0 12px}p{font-size:13px;line-height:1.7;margin:8px 0}.total{font-size:18px;font-variant-numeric:tabular-nums}.total span{font-size:12px;color:var(--mb-text-secondary)}ol{padding-left:20px;margin:16px 0 0}li{margin:14px 0;font-size:13px;line-height:1.7;overflow-wrap:anywhere}li span,small{display:block;font-variant-numeric:tabular-nums}small{font-size:12px}@media(max-width:760px){.sides{grid-template-columns:1fr}}
</style>
