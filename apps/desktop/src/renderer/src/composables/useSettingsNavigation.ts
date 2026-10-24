import { computed, isRef, nextTick, ref, type Ref } from 'vue'

export const SETTINGS_CATEGORIES = ['application', 'library', 'playback', 'roon', 'account', 'advanced'] as const
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]
export type SettingsBuildMode = 'development' | 'production'
type SettingsBuildModeInput = SettingsBuildMode | Ref<SettingsBuildMode>

export const SETTINGS_CATEGORY_STORAGE_KEY = 'musicbridge.settings.category'

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): SettingsStorage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function visibleCategories(_buildMode: SettingsBuildMode): readonly SettingsCategory[] {
  return SETTINGS_CATEGORIES
}

function isVisibleCategory(category: string, buildMode: SettingsBuildMode): category is SettingsCategory {
  return visibleCategories(buildMode).includes(category as SettingsCategory)
}

export function nextSettingsCategory(
  current: SettingsCategory,
  key: string,
  buildMode: SettingsBuildMode,
): SettingsCategory {
  const categories = visibleCategories(buildMode)
  if (key === 'Home') return categories[0]
  if (key === 'End') return categories[categories.length - 1]
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return current
  const currentIndex = categories.indexOf(current)
  if (currentIndex < 0) return categories[0]
  const direction = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
  return categories[(currentIndex + direction + categories.length) % categories.length]
}

function readStoredCategory(buildMode: SettingsBuildMode, storage: SettingsStorage | undefined): SettingsCategory {
  try {
    const stored = storage?.getItem(SETTINGS_CATEGORY_STORAGE_KEY)
    if (stored && isVisibleCategory(stored, buildMode)) return stored
  } catch { /* 偏好读取不可用时仍可进入设置。 */ }
  return 'application'
}

export function createSettingsNavigation(
  buildMode: SettingsBuildModeInput,
  storage: SettingsStorage | undefined = browserStorage(),
) {
  const buildModeValue = computed(() => isRef(buildMode) ? buildMode.value : buildMode)
  const activeCategory = ref<SettingsCategory>(readStoredCategory(buildModeValue.value, storage))

  function selectCategory(category: SettingsCategory): void {
    if (!isVisibleCategory(category, buildModeValue.value)) return
    activeCategory.value = category
    try {
      storage?.setItem(SETTINGS_CATEGORY_STORAGE_KEY, category)
    } catch {
      // 本地偏好写入失败不阻断设置操作。
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    const next = nextSettingsCategory(activeCategory.value, event.key, buildModeValue.value)
    if (next === activeCategory.value) return
    event.preventDefault()
    selectCategory(next)
    const tabs = event.currentTarget as HTMLElement | null
    void nextTick(() => {
      if (activeCategory.value === next) tabs?.querySelector<HTMLButtonElement>(`[role="tab"][data-settings-category="${next}"]`)?.focus()
    })
  }

  return {
    activeCategory,
    selectCategory,
    onKeydown,
    visibleCategories: computed(() => visibleCategories(buildModeValue.value)),
  }
}
