import { onMounted, onUnmounted, ref } from 'vue'

export type AccountMenuAction = 'login' | 'settings' | 'diagnostics' | 'logout'

/** 只管理账户菜单的可见性；具体账户动作仍由 App 的既有公开 API 处理。 */
export function useAccountMenu(onAction: (action: AccountMenuAction) => void) {
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

  function choose(action: AccountMenuAction): void {
    close()
    onAction(action)
  }

  onMounted(() => document.addEventListener('mousedown', closeOnOutside))
  onUnmounted(() => document.removeEventListener('mousedown', closeOnOutside))

  return { root, open, toggle, close, choose }
}
