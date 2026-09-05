import { readonly, ref, type InjectionKey } from 'vue'

export type AppearanceTheme = 'light' | 'dark'
export const APPEARANCE_STORAGE_KEY = 'musicbridge.appearanceTheme'

/** 主题只改变外观，不读取或操作播放状态。启动时同步恢复，避免先绘制错误配色。 */
export function createAppearancePreference(deps: {
  read: () => string | null
  write: (theme: AppearanceTheme) => void
  apply: (theme: AppearanceTheme) => void
}) {
  let initial: AppearanceTheme = 'light'
  try { if (deps.read() === 'dark') initial = 'dark' } catch { /* 存储不可读时保留浅色默认。 */ }
  const theme = ref<AppearanceTheme>(initial)
  deps.apply(initial)
  return {
    theme: readonly(theme),
    select(value: AppearanceTheme) {
      if ((value !== 'light' && value !== 'dark') || value === theme.value) return
      theme.value = value
      deps.apply(value)
      try { deps.write(value) } catch { /* 存储不可写仍允许本次会话切换。 */ }
    },
  }
}
export const appearanceKey: InjectionKey<ReturnType<typeof createAppearancePreference>> = Symbol('appearance')
