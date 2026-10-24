import { defineConfig } from 'electron-vite'
import { createRendererConfig } from './electron.renderer.config.js'

export default defineConfig(({ mode }) => {
  if (mode !== 'development') throw new Error('仅界面构建只允许用于开发模式。')
  return { renderer: createRendererConfig() }
})
