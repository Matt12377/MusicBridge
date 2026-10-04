import vue from '@vitejs/plugin-vue'
import { buildStoragePolicy } from '../scripts/build-storage-root.mjs'
import { defineConfig } from 'electron-vite'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = process.env.MUSIC_BRIDGE_RUST_MAIN_HOST_BUILD_ROOT ?? ''
const binary = process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256 = process.env.MUSIC_BRIDGE_RUST_SHA256 ?? ''
if (!path.isAbsolute(output) || !path.isAbsolute(binary) || !/^[a-f0-9]{64}$/.test(sha256)
  || createHash('sha256').update(readFileSync(binary)).digest('hex') !== sha256) throw new Error('隔离编译必须给出外置输出与真实固定 pin。')
const storage = buildStoragePolicy()
storage.check(output)
storage.check(process.env.TMPDIR ?? '', { mustExist: true })
if (process.env.DEV_CACHE_ROOT) storage.check(process.env.DEV_CACHE_ROOT)
const entry = (name: string) => path.join(desktop, name)
// 编译时固化 pin；运行中的 Main/Core 不解析这些环境变量。
const define = { __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: 'false', __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: 'null', __MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__: 'null', __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__: 'false', __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__: 'false', __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: 'false', __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: 'null',
  __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: 'null', __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: 'null', __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: 'null',
  __RUST_MAIN_HOST_BINARY__: JSON.stringify(binary), __RUST_MAIN_HOST_SHA256__: JSON.stringify(sha256) }
export default defineConfig({
  main: { define, build: { outDir: path.join(output, 'main'), emptyOutDir: true,
    rollupOptions: { input: {
      index: entry('src/main/index.ts'), core: entry('src/main/core-entry.ts'), 'dataset-owner': entry('src/main/dataset-owner-entry.ts'),
      'spreadsheet-worker': entry('../../packages/bridge-core/src/collection/spreadsheet-worker.ts'),
      'private-rust-core': entry('e2e/private-rust-core-entry.ts'), 'private-rust-node': entry('e2e/private-rust-node-entry.ts'),
      'private-rust-core-2000': entry('e2e/private-rust-core-2000-entry.ts'), 'private-rust-core-5000': entry('e2e/private-rust-core-5000-entry.ts'),
    // 多入口共享 core-host 的 import.meta.url 仍与生产 Owner 入口同目录。
    }, output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' } } } },
  preload: { build: { externalizeDeps: { exclude: ['@music-bridge/contracts'] }, outDir: path.join(output, 'preload'),
    rollupOptions: { input: entry('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { root: entry('src/renderer'), build: { outDir: path.join(output, 'renderer') }, plugins: [vue()] },
})
