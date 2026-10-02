import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeConverter } from './scripts/native-converter-package.mjs'
import { captureNativeOutput } from './scripts/native-output-package.mjs'
import { captureNativeOutputDevice } from './scripts/native-output-device-package.mjs'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const converterBuild = await captureNativeConverter(currentDirectory)
const outputBuild = await captureNativeOutput(currentDirectory)
const outputDeviceBuild = await captureNativeOutputDevice(currentDirectory)

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: JSON.stringify(mode === 'development'),
      __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: JSON.stringify(converterBuild.manifestSha256),
      __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: JSON.stringify(outputBuild.manifestSha256),
      __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: JSON.stringify(outputDeviceBuild.manifestSha256),
      __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: JSON.stringify(outputDeviceBuild.candidate),
    },
    plugins: [{
      name: 'fixed-converter-build-identity',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'converter-build.json', source: JSON.stringify(converterBuild) + '\n' })
        this.emitFile({ type: 'asset', fileName: 'output-build.json', source: JSON.stringify(outputBuild) + '\n' })
        this.emitFile({ type: 'asset', fileName: 'output-device-build.json', source: JSON.stringify(outputDeviceBuild) + '\n' })
      },
    }],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: path.join(currentDirectory, 'src/main/index.ts'),
          core: path.join(currentDirectory, 'src/main/core-entry.ts'),
          'dataset-owner': path.join(currentDirectory, 'src/main/dataset-owner-entry.ts'),
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
      // 沙盒只能 require Electron；纯合同诊断代码随 Preload 一起打包。
      externalizeDeps: { exclude: ['@music-bridge/contracts'] },
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
}))
