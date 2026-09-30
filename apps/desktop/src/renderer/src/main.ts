import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import './style.css'
import './assets/bootstrap-icons/icons.css'
import './sakura-theme.css'
import './appearance-theme.css'
import './open-library.css'
import './interaction-motion.css'
import { APPEARANCE_STORAGE_KEY, appearanceKey, createAppearancePreference } from './appearance.js'

// 键盘操作即时响应；只有指针操作触发装饰性的进入和按压动效。
const motionRoot = document.documentElement
const pointerMotion = () => { motionRoot.dataset.motionInput = 'pointer' }
const keyboardMotion = () => { motionRoot.dataset.motionInput = 'keyboard' }
const updateMotionVisibility = () => { motionRoot.dataset.motionPaused = String(document.hidden) }
document.addEventListener('pointerdown', pointerMotion, { capture: true, passive: true })
document.addEventListener('keydown', keyboardMotion, true)
document.addEventListener('visibilitychange', updateMotionVisibility)
updateMotionVisibility()
const appearance = createAppearancePreference({
  read: () => window.localStorage.getItem(APPEARANCE_STORAGE_KEY),
  write: theme => window.localStorage.setItem(APPEARANCE_STORAGE_KEY, theme),
  apply: theme => {
    const root = document.documentElement
    root.classList.add('appearance-changing')
    root.dataset.theme = theme
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('appearance-changing')))
    void window.musicBridge.setAppearanceTheme(theme).catch(() => { /* 原生标题栏不可用不阻断内容主题。 */ })
  },
})
const app = createApp(App).use(createPinia()).provide(appearanceKey, appearance)
app.onUnmount(() => {
  document.removeEventListener('pointerdown', pointerMotion, true)
  document.removeEventListener('keydown', keyboardMotion, true)
  document.removeEventListener('visibilitychange', updateMotionVisibility)
})
app.mount('#app')
