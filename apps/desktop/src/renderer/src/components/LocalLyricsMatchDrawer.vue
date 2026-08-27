<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LocalLyricsMatchCandidate, LocalLyricsMatchSnapshot } from '@music-bridge/contracts'

const props = defineProps<{
  state: LocalLyricsMatchSnapshot
  busy?: boolean
  error?: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [matchSessionId: string, candidateId: string]
  revoke: []
}>()

const drawer = ref<HTMLElement>()
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '时长未知'
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function choose(candidate: LocalLyricsMatchCandidate): void {
  if (!props.state.matchSessionId || props.busy) return
  emit('select', props.state.matchSessionId, candidate.candidateId)
}

function focusableElements(): HTMLElement[] {
  if (!drawer.value) return []
  return [...drawer.value.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
}

function keepFocusInside(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const items = focusableElements()
  const first = items[0]
  const last = items.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  await nextTick()
  focusableElements()[0]?.focus()
})

watch(() => [props.state.status, props.state.matchSessionId, props.busy], () => {
  if (drawer.value && !drawer.value.contains(document.activeElement)) {
    focusableElements()[0]?.focus()
  }
}, { flush: 'post' })

onUnmounted(() => previousFocus?.focus())
</script>

<template>
  <Teleport to="body">
    <div class="lyrics-match-backdrop" aria-hidden="false" @click.self="emit('close')">
      <section
        ref="drawer"
        class="sidebar-popover lyrics-match-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lyrics-match-heading"
        @keydown.esc.stop.prevent="emit('close')"
        @keydown="keepFocusInside"
      >
      <div class="popover-heading">
        <div><small>本地音乐歌词</small><strong id="lyrics-match-heading">候选歌曲</strong></div>
        <button type="button" class="popover-close" aria-label="关闭歌词匹配" @click="emit('close')">×</button>
      </div>

      <p class="lyrics-match-help">选择与当前本地录音一致的网易云歌曲。只会更换歌词来源，不会重新播放音乐。</p>
      <p v-if="error" class="lyrics-match-message is-error" role="alert">操作失败，请稍后重试。</p>
      <p v-else-if="state.status === 'searching'" class="lyrics-match-message" role="status">正在查找可用歌词…</p>
      <p v-else-if="state.status === 'no-match'" class="lyrics-match-message">没有找到可用候选。</p>
      <p v-else-if="state.status === 'no-lyrics'" class="lyrics-match-message">已匹配歌曲，但网易云暂无歌词。</p>
      <p v-else-if="state.status === 'provider-unavailable'" class="lyrics-match-message">网易云尚未登录，请先完成账户登录。</p>
      <p v-else-if="state.status === 'network-error'" class="lyrics-match-message">网易云暂时不可用，请检查网络后重试。</p>
      <p v-else-if="state.status === 'matched'" class="lyrics-match-message">当前歌词已经匹配。</p>

      <ul v-if="state.status === 'needs-choice'" class="lyrics-match-list" aria-label="歌词候选歌曲">
        <li
          v-for="candidate in state.candidates"
          :key="candidate.candidateId"
        ><button
          type="button"
          class="zone-option lyrics-match-option"
          :disabled="busy"
          :aria-label="`选择 ${candidate.title}，${candidate.artists.join('、')}`"
          @click="choose(candidate)"
        >
          <span><strong>{{ candidate.title }}</strong><small>{{ candidate.artists.join('、') }} · {{ candidate.album || '专辑未知' }}</small></span>
          <time>{{ formatDuration(candidate.durationMs) }}</time>
        </button></li>
      </ul>
      <div class="popover-divider"></div>
      <div class="lyrics-match-actions">
        <button v-if="state.canRevoke" type="button" class="text-button lyrics-match-revoke" :disabled="busy" @click="emit('revoke')">取消匹配</button>
        <button type="button" class="secondary-button" @click="emit('close')">关闭</button>
      </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lyrics-match-backdrop {
  position: fixed;
  z-index: 40;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  padding: 18px;
  overflow: hidden;
  background: rgba(3, 6, 10, .54);
  backdrop-filter: blur(8px);
}

.lyrics-match-drawer {
  display: flex;
  box-sizing: border-box;
  width: min(390px, calc(100vw - 36px));
  max-width: 100vw;
  max-height: calc(100dvh - 36px);
  flex-direction: column;
  align-self: stretch;
  padding: 14px;
  overflow: hidden;
  animation: lyrics-drawer-enter 180ms ease-out;
}

.lyrics-match-backdrop > .lyrics-match-drawer { position: relative; }

.popover-heading > div { display: grid; gap: 3px; }
.popover-heading small { color: var(--mb-text-tertiary); font-size: 9px; }
.lyrics-match-help { margin: 2px 5px 12px; color: var(--mb-text-secondary); font-size: 11px; line-height: 1.55; }
.lyrics-match-message { margin: 8px 5px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.5; }
.lyrics-match-message.is-error { color: var(--mb-danger); }
.lyrics-match-list { display: grid; gap: 3px; min-height: 0; margin: 0; padding: 0; list-style: none; overflow: auto; overscroll-behavior: contain; }
.lyrics-match-option { min-height: 58px; gap: 12px; padding: 8px 9px; }
.lyrics-match-option > span:first-child { display: grid; min-width: 0; gap: 3px; }
.lyrics-match-option strong, .lyrics-match-option small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lyrics-match-option strong { color: var(--mb-text-primary); font-size: 12px; }
.lyrics-match-option small { color: var(--mb-text-tertiary); font-size: 10px; }
.lyrics-match-option time { flex: 0 0 auto; color: var(--mb-text-tertiary); font-size: 10px; }
.lyrics-match-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.lyrics-match-revoke { margin-right: auto; color: var(--mb-danger); }
.lyrics-match-option:focus-visible, .lyrics-match-actions button:focus-visible, .popover-close:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 2px; }

@keyframes lyrics-drawer-enter {
  from { opacity: 0; transform: translateX(18px); }
  to { opacity: 1; transform: translateX(0); }
}

@media (max-width: 760px) {
  .lyrics-match-backdrop { align-items: flex-end; padding: 0; }
  .lyrics-match-drawer { align-self: flex-end; width: 100%; max-height: min(78dvh, 620px); border-radius: 18px 18px 0 0; }
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-match-drawer { animation: none; }
}
</style>
