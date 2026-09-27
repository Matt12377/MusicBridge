import { defineConfig } from 'electron-vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeConverter } from '../scripts/native-converter-package.mjs'
import { captureNativeOutput } from '../scripts/native-output-package.mjs'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const converter = await captureNativeConverter(desktopRoot)
const output = await captureNativeOutput(desktopRoot)

/** 单独的隔离测试构建；不改正式 electron.vite.config.ts，也不输出到 dist/main。 */
export default defineConfig({
  main: {
    define: { __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: JSON.stringify(converter.manifestSha256),
      __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: JSON.stringify(output.manifestSha256) },
    build: {
      outDir: path.join(desktopRoot, '.tmp-test', 'private-core'),
      emptyOutDir: true,
      rollupOptions: {
        input: { 'plan-core': path.join(desktopRoot, 'e2e', 'private-plan-core-entry.ts'),
          'full-core': path.join(desktopRoot, 'e2e', 'private-full-core-entry.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
})
