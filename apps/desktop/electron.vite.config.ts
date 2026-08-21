import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: path.join(currentDirectory, 'src/main/index.ts'),
          core: path.join(currentDirectory, 'src/main/core-entry.ts'),
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
