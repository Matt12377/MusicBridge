import { onUnmounted, ref, watch, type Ref } from 'vue'
/** 回调仅属于当前窗口的组件实例；旧unmount不能删除同key的新实例重试。 */
export function useGridArtworkRetry<T>(items: Readonly<Ref<readonly T[]>>, key: (item: T) => string) {
  type Slot = { action?: () => void; handler: (action: (() => void) | undefined) => void }
  const slots = new Map<string, Slot>(), version = ref(0)
  function synchronize(): void {
    const wanted = new Set(items.value.map(key))
    for (const id of slots.keys()) if (!wanted.has(id)) slots.delete(id)
    version.value++
  }
  function handler(item: T): Slot['handler'] {
    const id = key(item), existing = slots.get(id); if (existing) return existing.handler
    const slot: Slot = { handler: action => { if (slots.get(id) !== slot) return; slot.action = action; version.value++ } }; slots.set(id, slot); return slot.handler
  }
  function available(item: T): boolean { void version.value; return slots.get(key(item))?.action !== undefined }
  function run(item: T, event: MouseEvent): void {
    event.preventDefault(); event.stopPropagation()
    const slot = slots.get(key(item)), action = slot?.action
    if (!slot || !action) return
    slot.action = undefined; version.value++; action()
  }
  watch(() => items.value.map(key), synchronize, { immediate: true, flush: 'sync' })
  onUnmounted(() => slots.clear())
  return { handler, available, run }
}
