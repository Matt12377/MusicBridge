import { ref } from 'vue'

import type { SidebarSource } from '../components/navigation.js'

const SIDEBAR_EXPANDED_STORAGE_KEY = 'music-bridge.sidebar-expanded'

function readExpandedPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY)
    return stored === null ? true : stored === 'true'
  } catch {
    return true
  }
}

export function useSidebarState() {
  const expanded = ref(readExpandedPreference())
  const activeSource = ref<SidebarSource>({ type: 'home' })
  const sourceScrollTop = ref(0)

  function setExpanded(value: boolean): void {
    expanded.value = value
    try {
      window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, String(value))
    } catch {
      // Non-sensitive UI preference is best effort only.
    }
  }

  function toggleExpanded(): void {
    setExpanded(!expanded.value)
  }

  function setActiveSource(source: SidebarSource): void {
    activeSource.value = source
  }

  function setSourceScrollTop(value: number): void {
    sourceScrollTop.value = value
  }

  return {
    expanded,
    activeSource,
    sourceScrollTop,
    setExpanded,
    toggleExpanded,
    setActiveSource,
    setSourceScrollTop,
  }
}
