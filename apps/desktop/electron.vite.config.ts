import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeConverter } from './scripts/native-converter-package.mjs'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const converterBuild = await captureNativeConverter(currentDirectory)

export default defineConfig({
  main: {
    define: { __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: JSON.stringify(converterBuild.manifestSha256) },
    plugins: [{
      name: 'fixed-converter-build-identity',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'converter-build.json', source: JSON.stringify(converterBuild) + '\n' })
      },
    }],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: path.join(currentDirectory, 'src/main/index.ts'),
          core: path.join(currentDirectory, 'src/main/core-entry.ts'),
          'spreadsheet-worker': path.join(currentDirectory, '../../packages/bridge-core/src/collection/spreadsheet-worker.ts'),
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    build: {
      outDir: 'dist/renderer',
    },
    plugins: [vue()],
  },
})
