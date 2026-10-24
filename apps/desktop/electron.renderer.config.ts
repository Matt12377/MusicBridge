import vue from '@vitejs/plugin-vue'
import type { UserConfig } from 'vite'

/** 完整构建与仅界面构建共用配置，避免两条入口的功能开关漂移。 */
export function createRendererConfig(): UserConfig {
  return {
    define: {
      __MUSIC_BRIDGE_PRIVATE_DESKTOP_ARTWORK__: JSON.stringify(process.env.MUSIC_BRIDGE_PRIVATE_DESKTOP_ARTWORK_BUILD === 'once'),
      __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: 'false',
      __MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__: 'null',
    },
    build: { outDir: 'dist/renderer' },
    plugins: [vue()],
  }
}
