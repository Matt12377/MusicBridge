import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import './style.css'
import './assets/bootstrap-icons/icons.css'
import './sakura-theme.css'
import './appearance-theme.css'
import { APPEARANCE_STORAGE_KEY, appearanceKey, createAppearancePreference } from './appearance.js'

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
createApp(App).use(createPinia()).provide(appearanceKey, appearance).mount('#app')
