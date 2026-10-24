<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { TrackSummary } from '@music-bridge/contracts'
import { calculateVirtualWindow } from '../../../composables/virtualWindow.js'

const props = withDefaults(defineProps<{
  tracks: readonly TrackSummary[]
  playableTrackIds: ReadonlySet<string>
  busy?: boolean
  initialLoading?: boolean
  loadingMore?: boolean
  hasMore?: boolean
  total?: number
  loadMoreError?: string
}>(), { busy: false, initialLoading: false, loadingMore: false, hasMore: false, total: 0, loadMoreError: '' })
const emit = defineEmits<{
  play: [track: TrackSummary]
  queue: [track: TrackSummary]
  'play-next': [track: TrackSummary]
  'open-track': [track: TrackSummary]
  'load-more': []
}>()
// 本地专辑专用实高；不改变公共TrackTable的84px虚拟滚动合同。
const ROW_HEIGHT = 54
const viewport = ref<HTMLElement | null>(null), sentinel = ref<HTMLElement | null>(null)
const scrollTop = ref(0), viewportHeight = ref(620)
const isVirtualized = computed(() => props.total > 200 || props.tracks.length > 200)
const virtualWindow = computed(() => calculateVirtualWindow(props.tracks.length,scrollTop.value,viewportHeight.value,ROW_HEIGHT))
const rows = computed(() => {
  const start = isVirtualized.value ? virtualWindow.value.start : 0, end = isVirtualized.value ? virtualWindow.value.end : props.tracks.length
  return props.tracks.slice(start,end).map((track,index) => ({track,index:start+index}))
})
const contextTrackId = ref<string | null>(null)
const contextTrack = computed(() => props.tracks.find(track => track.id === contextTrackId.value) ?? null)
const contextMenu = ref<HTMLElement | null>(null), contextPosition = ref({x:0,y:0})
let contextTrigger: HTMLElement | null = null, observer: IntersectionObserver | undefined, resizeObserver: ResizeObserver | undefined, disposed = false
const canRequest = (track:TrackSummary): boolean => !props.busy && props.playableTrackIds.has(track.id)
function duration(milliseconds: number | undefined): string {
  if (!milliseconds || milliseconds < 0) return '—'
  const seconds = Math.floor(milliseconds/1000)
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`
}
function closeMenu(restoreFocus = false): void {
  contextTrackId.value = null
  if (restoreFocus && contextTrigger?.isConnected) contextTrigger.focus()
  contextTrigger = null
}
const dismissMenu = (): void => closeMenu()
function request(action:'play'|'queue'|'play-next'|'open-track',track:TrackSummary): void {
  if (action !== 'open-track' && !canRequest(track)) return
  closeMenu()
  if (action === 'play') emit('play',track)
  else if (action === 'queue') emit('queue',track)
  else if (action === 'play-next') emit('play-next',track)
  else emit('open-track',track)
}
function positionMenu(track:TrackSummary,trigger:HTMLElement,x:number,y:number): void {
  contextTrigger=trigger;contextTrackId.value=track.id
  contextPosition.value={x:Math.max(8,Math.min(x,window.innerWidth-236)),y:Math.max(8,Math.min(y,window.innerHeight-252))}
  void nextTick(()=>contextMenu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
}
function openMenu(event:MouseEvent,track:TrackSummary):void {
  event.preventDefault()
  const trigger=event.currentTarget as HTMLElement,box=trigger.getBoundingClientRect()
  positionMenu(track,trigger,event.type==='contextmenu'?event.clientX:box.right-228,event.type==='contextmenu'?event.clientY:box.bottom+4)
}
function rowKey(event:KeyboardEvent,track:TrackSummary):void {
  if(event.target!==event.currentTarget)return
  if(event.key==='Enter'){event.preventDefault();request('play',track)}
  else if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){
    event.preventDefault();const trigger=event.currentTarget as HTMLElement,box=trigger.getBoundingClientRect();positionMenu(track,trigger,box.right-228,box.top+ROW_HEIGHT)
  }
}
function escape(event:KeyboardEvent):void {
  if(!contextTrackId.value)return
  event.stopPropagation();event.preventDefault();closeMenu(true)
}
function menuKey(event:KeyboardEvent):void {
  if(event.key==='Escape'){escape(event);return}
  if(event.key==='Tab'){closeMenu(true);return}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
  event.preventDefault()
  const buttons=Array.from(contextMenu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[])
  if(!buttons.length)return
  const current=buttons.findIndex(button=>button===document.activeElement)
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowUp'?(current+buttons.length-1)%buttons.length:(current+1)%buttons.length
  buttons[next]?.focus()
}
function onScroll(event:Event):void {
  const target=event.currentTarget as HTMLElement
  scrollTop.value=target.scrollTop;viewportHeight.value=target.clientHeight||viewportHeight.value;dismissMenu()
}
function observe():void {
  if(disposed)return
  observer?.disconnect();resizeObserver?.disconnect()
  observer=undefined;resizeObserver=undefined
  if(viewport.value){
    viewportHeight.value=viewport.value.clientHeight||viewportHeight.value
    if(typeof ResizeObserver!=='undefined'){
      resizeObserver=new ResizeObserver(()=>{if(viewport.value)viewportHeight.value=viewport.value.clientHeight||viewportHeight.value})
      resizeObserver.observe(viewport.value)
    }
  }
  if(!props.hasMore||props.loadMoreError||!sentinel.value||typeof IntersectionObserver==='undefined')return
  observer=new IntersectionObserver(entries=>{
    if(entries.some(entry=>entry.isIntersecting)&&!props.loadingMore&&!props.busy&&!props.initialLoading)emit('load-more')
  },{root:isVirtualized.value?viewport.value:null,rootMargin:'240px 0px'})
  observer.observe(sentinel.value)
}
onMounted(()=>{
  document.addEventListener('click',dismissMenu);window.addEventListener('resize',dismissMenu);window.addEventListener('blur',dismissMenu);window.addEventListener('scroll',dismissMenu,true)
  void nextTick(observe)
})
watch(()=>[props.tracks.length,props.hasMore,props.loadMoreError,props.loadingMore,props.busy,props.initialLoading,isVirtualized.value],()=>void nextTick(observe))
watch(()=>props.tracks,()=>{if(contextTrackId.value&&!contextTrack.value)closeMenu()})
onUnmounted(()=>{
  disposed=true;observer?.disconnect();resizeObserver?.disconnect()
  document.removeEventListener('click',dismissMenu);window.removeEventListener('resize',dismissMenu);window.removeEventListener('blur',dismissMenu);window.removeEventListener('scroll',dismissMenu,true)
})
</script>

<template>
  <div class="local-album-track-list" :style="{ '--local-track-row-height': `${ROW_HEIGHT}px` }" @keydown.esc="escape">
    <div v-if="props.initialLoading && !props.tracks.length" class="empty-state local-album-track-state" role="status"><span class="loading-line"></span><p>正在读取歌曲…</p></div>
    <div v-else-if="!props.tracks.length" class="empty-state local-album-track-state"><i class="bi bi-music-note-list" aria-hidden="true"></i><h3>这张专辑没有可显示的曲目</h3><p>本次读取未返回曲目，可重新读取或在整理工作台检查来源。</p></div>
    <div v-else ref="viewport" class="local-album-track-table" :class="{ 'is-virtualized': isVirtualized }" role="table" aria-label="专辑歌曲列表" :aria-colcount="4" :aria-rowcount="(props.total || props.tracks.length) + 1" @scroll="onScroll">
      <div class="visually-hidden" role="row"><span role="columnheader">曲序</span><span role="columnheader">歌曲</span><span role="columnheader">时长</span><span role="columnheader">更多操作</span></div>
      <div v-if="isVirtualized" aria-hidden="true" :style="{ height: `${virtualWindow.topSpacer}px` }"></div>
      <div v-for="entry in rows" :key="entry.track.id" class="local-album-track-row" :class="{ 'is-playable': canRequest(entry.track) }" role="row" :aria-rowindex="entry.index + 2" :tabindex="props.busy ? -1 : 0" :aria-disabled="props.busy ? 'true' : undefined" @dblclick="request('play', entry.track)" @keydown="rowKey($event, entry.track)" @contextmenu="openMenu($event, entry.track)">
        <span class="local-album-track-number" role="cell" :title="entry.track.version"><span>{{ entry.index + 1 }}</span><button type="button" class="local-album-track-play" :disabled="!canRequest(entry.track)" :aria-label="`播放 ${entry.track.title}`" @click.stop="request('play', entry.track)" @dblclick.stop><i class="bi bi-play-fill" aria-hidden="true"></i></button></span>
        <span class="local-album-track-title" role="cell" :title="[entry.track.title,entry.track.version].filter(Boolean).join(' · ')">{{ entry.track.title }}</span>
        <span class="local-album-track-duration" role="cell">{{ duration(entry.track.durationMs) }}</span>
        <span class="local-album-track-controls" role="cell"><button type="button" class="row-action row-action-more local-album-track-more" :aria-label="`打开 ${entry.track.title} 的更多操作`" aria-haspopup="menu" :aria-expanded="contextTrackId === entry.track.id" @click.stop="openMenu($event, entry.track)" @dblclick.stop><i class="bi bi-three-dots" aria-hidden="true"></i></button></span>
      </div>
      <div v-if="isVirtualized" aria-hidden="true" :style="{ height: `${virtualWindow.bottomSpacer}px` }"></div>
      <div v-if="props.hasMore" ref="sentinel" class="local-album-track-more-pages" role="row"><div role="cell" :aria-colspan="4">
        <span v-if="props.loadingMore" role="status" aria-live="polite">正在加载更多…</span>
        <template v-else-if="props.loadMoreError"><span class="load-more-error" role="status">{{ props.loadMoreError }}</span><button type="button" class="text-button" @click="emit('load-more')">重试</button></template>
        <button v-else type="button" class="text-button" :disabled="props.busy" @click="emit('load-more')">加载更多歌曲</button>
        <span v-if="props.total">已显示 {{ props.tracks.length }} / {{ props.total }}</span>
      </div></div>
    </div>
    <Teleport v-if="contextTrack" to="body">
      <div ref="contextMenu" class="track-context-menu local-album-track-menu" role="menu" aria-label="歌曲操作" :style="{ left: `${contextPosition.x}px`, top: `${contextPosition.y}px` }" @click.stop @keydown="menuKey">
        <strong>{{ contextTrack.title }}</strong>
        <button type="button" role="menuitem" :disabled="!canRequest(contextTrack)" @click="request('play', contextTrack)"><i class="bi bi-play-fill" aria-hidden="true"></i> 播放</button>
        <button type="button" role="menuitem" :disabled="!canRequest(contextTrack)" @click="request('play-next', contextTrack)"><i class="bi bi-skip-end" aria-hidden="true"></i> 下一首播放</button>
        <button type="button" role="menuitem" :disabled="!canRequest(contextTrack)" @click="request('queue', contextTrack)"><i class="bi bi-list-ul" aria-hidden="true"></i> 加入队列</button>
        <button type="button" class="local-album-track-detail" role="menuitem" :aria-label="`查看 ${contextTrack.title} 的版本与文件详情`" @click="request('open-track', contextTrack)"><i class="bi bi-info-circle" aria-hidden="true"></i> 版本与文件详情</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.local-album-track-list { width: 100%; min-width: 0; }
.local-album-track-table { width: 100%; min-width: 0; }
.local-album-track-table.is-virtualized { height: min(65vh, 648px); min-height: 216px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.local-album-track-row { display: grid; grid-template-columns: 32px minmax(0, 1fr) 64px 44px; align-items: center; gap: 12px; height: var(--local-track-row-height); min-height: var(--local-track-row-height); padding: 0 4px; border-bottom: 1px solid var(--mb-divider); color: var(--mb-text-primary); }
.local-album-track-row:hover, .local-album-track-row:focus-within { background: var(--mb-glass-clear); }
.local-album-track-number { position: relative; color: var(--mb-text-secondary); text-align: center; font-size: 13px; font-variant-numeric: tabular-nums; }
.local-album-track-play { position: absolute; inset: 50% auto auto 50%; transform: translate(-50%, -50%); display: inline-flex; width: 32px; min-height: 44px; align-items: center; justify-content: center; opacity: 0; color: var(--mb-accent); background: transparent; font-size: 20px; }
.local-album-track-row.is-playable:is(:hover,:focus-visible) .local-album-track-number > span { display: none; }
.local-album-track-row.is-playable:is(:hover,:focus-within) .local-album-track-play { opacity: 1; }
.local-album-track-play:focus-visible { outline: 2px solid var(--mb-accent); border-radius: 6px; }
.local-album-track-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 20px; }
.local-album-track-duration { color: var(--mb-text-secondary); text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
.local-album-track-controls { display: flex; justify-content: center; }
.local-album-track-more { display: inline-flex; width: 44px; min-width: 44px; height: 44px; min-height: 44px; padding: 0; align-items: center; justify-content: center; color: var(--mb-text-secondary); background: transparent; font-size: 20px; }
.local-album-track-more-pages > div { display: flex; min-height: 56px; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: center; padding: 8px 0; color: var(--mb-text-secondary); font-size: 12px; }
.local-album-track-state { min-height: 180px; }
.local-album-track-state > i { font-size: 28px; }
.local-album-track-menu { width: 228px; max-width: calc(100vw - 16px); }
.local-album-track-menu button { display: flex; min-height: 44px; gap: 9px; align-items: center; }
.local-album-track-more:focus-visible, .local-album-track-menu button:focus-visible, .local-album-track-row:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: -2px; border-radius: 6px; }
@container (max-width: 560px) { .local-album-track-row { grid-template-columns: 28px minmax(0, 1fr) 52px 44px; gap: 8px; } }
</style>
