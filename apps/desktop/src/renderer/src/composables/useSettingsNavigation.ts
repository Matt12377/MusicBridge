import { computed, isRef, ref, type Ref } from 'vue'

export const SETTINGS_CATEGORIES = ['account', 'playback', 'roon', 'application', 'advanced'] as const
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

function visibleCategories(buildMode: SettingsBuildMode): readonly SettingsCategory[] {
  return buildMode === 'development' ? SETTINGS_CATEGORIES : SETTINGS_CATEGORIES.filter((category) => category !== 'advanced')
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
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return current
  const currentIndex = categories.indexOf(current)
  if (currentIndex < 0) return categories[0]
  const direction = key === 'ArrowRight' ? 1 : -1
  return categories[(currentIndex + direction + categories.length) % categories.length]
}

function readStoredCategory(buildMode: SettingsBuildMode, storage: SettingsStorage | undefined): SettingsCategory {
  const stored = storage?.getItem(SETTINGS_CATEGORY_STORAGE_KEY)
  return stored && isVisibleCategory(stored, buildMode) ? stored : 'account'
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
      // UI-only preference is best effort and never blocks Settings.
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    const next = nextSettingsCategory(activeCategory.value, event.key, buildModeValue.value)
    if (next === activeCategory.value) return
    event.preventDefault()
    selectCategory(next)
  }

  return {
    activeCategory,
    selectCategory,
    onKeydown,
    visibleCategories: computed(() => visibleCategories(buildModeValue.value)),
  }
}
