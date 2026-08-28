<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { CollectionPhoto, CollectionPhotoImage } from '@music-bridge/contracts'
const props = defineProps<{ photo: Pick<CollectionPhoto, 'id' | 'width' | 'height'>; alt: string; loadPhoto?: (id: string) => Promise<CollectionPhotoImage>; interactive?: boolean }>()
const element = ref<HTMLElement>(), source = ref(''), state = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
// 模板用事件对象绑定这一次回调，避免缓存包装器在旧img事件中读取新一代回调。
const imageError = shallowRef<() => void>(() => {})
let generation = 0, mounted = false, stopVisibility = () => {}
async function load(): Promise<void> {
  if (!mounted || !['idle', 'failed'].includes(state.value)) return
  stopVisibility()
  const current = ++generation, id = props.photo.id, loader = props.loadPhoto ?? window.musicBridge.getCollectionPhoto
  source.value = ''; state.value = 'loading'
  imageError.value = () => { if (mounted && current === generation && state.value === 'ready') { source.value = ''; state.value = 'failed' } }
  try {
    const image = await loader(id)
    if (mounted && current === generation) { source.value = image.dataUrl; state.value = 'ready' }
  } catch { if (mounted && current === generation) state.value = 'failed' }
}
function observe(): void {
  stopVisibility()
  const target = element.value, current = generation
  if (!mounted || !target) return
  const active = () => mounted && generation === current && state.value === 'idle'
  if (typeof window.IntersectionObserver === 'function') {
    try {
      const observer = new window.IntersectionObserver(entries => { if (active() && entries.some(entry => entry.target === target && entry.isIntersecting)) void load() }, { rootMargin: '200px' })
      stopVisibility = () => observer.disconnect()
      observer.observe(target)
      return
    } catch { stopVisibility() /* 降级仍检查位置，不能把缺少Observer解释为全部可见。 */ }
  }
  let frame: number | undefined
  const check = () => {
    frame = undefined
    if (!active()) return
    const bounds = target.getBoundingClientRect()
    if (bounds.width > 0 && bounds.height > 0 && bounds.bottom >= -200 && bounds.top <= window.innerHeight + 200 && bounds.right >= -200 && bounds.left <= window.innerWidth + 200) void load()
  }
  const schedule = () => { if (active() && frame === undefined) frame = window.requestAnimationFrame(check) }
  stopVisibility = () => {
    window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    frame = undefined
  }
  // 只有降级时按组件保留一组监听；每帧至多检查一次，命中或卸载即清理。
  window.addEventListener('scroll', schedule, { capture: true, passive: true }); window.addEventListener('resize', schedule, { passive: true })
  check()
}
watch([() => props.photo.id, () => props.loadPhoto], () => { ++generation; source.value = ''; state.value = 'idle'; observe() }, { flush: 'sync' })
onMounted(() => { mounted = true; observe() })
onUnmounted(() => { mounted = false; ++generation; stopVisibility() })
</script>
<template>
  <span ref="element" class="collection-photo" :data-photo-id="photo.id" :data-photo-state="state" :aria-busy="state === 'loading'">
    <img v-if="state === 'ready'" :src="source" :alt="alt" :width="photo.width" :height="photo.height" loading="lazy" decoding="async" v-on="{ error: imageError }">
    <span v-else-if="state === 'loading'" class="photo-message" role="status">正在读取照片…</span>
    <span v-else-if="state === 'idle'" class="photo-message">照片尚未读取</span>
    <span v-else class="photo-message"><span>照片读取失败{{ interactive ? '' : '，可打开大图重试' }}</span><button v-if="interactive" type="button" @click="load">重试此照片</button></span>
  </span>
</template>
<style scoped>
.collection-photo { display: flex; width: 100%; height: 100%; min-height: 80px; align-items: center; justify-content: center; background: var(--mb-bg-base); overflow: hidden; }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
.photo-message { color: var(--mb-text-secondary); font-size: 12px; padding: 18px; overflow-wrap: anywhere; }
.photo-message button { display: block; min-height: 44px; margin: 12px auto 0; padding: 8px 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; color: var(--mb-text-primary); background: var(--mb-glass-clear); font: inherit; }
</style>
