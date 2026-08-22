import { onMounted, onUnmounted, ref } from 'vue'

/** 只管理 Zone Popover 的打开/关闭，不改变现有 Zone 选择语义。 */
export function useZoneSelection(onSelect: (zoneId: string) => void) {
  const root = ref<HTMLElement | null>(null)
  const open = ref(false)

  function closeOnOutside(event: MouseEvent): void {
    if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
  }

  function toggle(): void {
    open.value = !open.value
  }

  function close(): void {
    open.value = false
  }

  function selectZone(zoneId: string): void {
    close()
    onSelect(zoneId)
  }

  onMounted(() => document.addEventListener('mousedown', closeOnOutside))
  onUnmounted(() => document.removeEventListener('mousedown', closeOnOutside))

  return { root, open, toggle, close, selectZone }
}
