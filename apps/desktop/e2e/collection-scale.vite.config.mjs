import vue from '@vitejs/plugin-vue'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeConverter } from '../scripts/native-converter-package.mjs'
import { captureNativeOutput } from '../scripts/native-output-package.mjs'
import { captureNativeOutputDevice } from '../scripts/native-output-device-package.mjs'
import { captureNativeRust } from '../scripts/native-rust-package.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 仅签前工程工具选择静态动作期待，应用能力仍由正常用户boolean控制。 */
export async function createCollectionScaleBuildConfiguration({ modelCount, manifestPin, mainOutDir, rendererOutDir }) {
  assert.ok([0,100,2000,2001,5000,5001].includes(modelCount))
  assert.ok(typeof manifestPin === 'string' && /^[a-f0-9]{64}$/u.test(manifestPin))
  for (const outDir of [mainOutDir,rendererOutDir]) assert.ok(typeof outDir === 'string' && path.resolve(outDir) === outDir && outDir.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  assert.notEqual(mainOutDir, rendererOutDir)
  const converter = await captureNativeConverter(desktop), output = await captureNativeOutput(desktop)
  const outputDevice = await captureNativeOutputDevice(desktop), rust = await captureNativeRust(desktop)
  assert.ok(rust.manifestSha256, '受控候选必须准备固定Rust资源，不以缺包代替普通开关验证。')
  assert.equal(manifestPin, rust.manifestSha256)
  return { main: { root: desktop, define: {
    __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: 'false',
    __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: 'true',
    __MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__: JSON.stringify(modelCount),
    __MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__: 'null',
    __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__: 'false',
    __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__: 'false',
    __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: JSON.stringify(manifestPin),
    __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: 'false',
    __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: JSON.stringify(converter.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: JSON.stringify(output.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: JSON.stringify(outputDevice.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: JSON.stringify(outputDevice.candidate),
  }, plugins: [{ name: 'fixed-collection-scale-build-identity', generateBundle() {
    for (const [fileName, receipt] of [['converter-build.json', converter], ['output-build.json', output],
      ['output-device-build.json', outputDevice], ['rust-core-build.json', rust]]) {
      this.emitFile({ type: 'asset', fileName, source: JSON.stringify(receipt) + '\n' })
    }
  } }], build: { outDir: mainOutDir, rollupOptions: { input: {
    index: path.join(desktop, 'src/main/index.ts'), core: path.join(desktop, 'src/main/core-entry.ts'),
    'dataset-owner': path.join(desktop, 'src/main/dataset-owner-entry.ts'),
    'spreadsheet-worker': path.join(desktop, '../../packages/bridge-core/src/collection/spreadsheet-worker.ts'),
  }, output: { entryFileNames: '[name].js' } } } }, renderer: {
    root: path.join(desktop, 'src/renderer'),
    define: { __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: 'true', __MUSIC_BRIDGE_COLLECTION_SCALE_MODELS__: 'null' },
    plugins: [vue()], build: { outDir: rendererOutDir, emptyOutDir: true },
  } }
}
