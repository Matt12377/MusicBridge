import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeConverter } from '../scripts/native-converter-package.mjs'
import { captureNativeOutput } from '../scripts/native-output-package.mjs'
import { captureNativeOutputDevice } from '../scripts/native-output-device-package.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 参数只由签前构建工具使用，应用入口、路由和pin都是编译字面量。 */
export async function createPackagedRendererBuildConfiguration({ coreEntry, manifestPin, outDir }) {
  assert.ok(['packaged-renderer-node-core-entry.ts', 'packaged-renderer-rust-core-entry.ts'].includes(coreEntry))
  assert.ok(coreEntry === 'packaged-renderer-node-core-entry.ts' ? manifestPin === null : typeof manifestPin === 'string' && /^[a-f0-9]{64}$/u.test(manifestPin))
  assert.ok(typeof outDir === 'string' && path.resolve(outDir) === outDir && outDir.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const converterBuild = await captureNativeConverter(desktop)
  const outputBuild = await captureNativeOutput(desktop)
  const outputDeviceBuild = await captureNativeOutputDevice(desktop)
  return { main: { root: desktop, define: {
    __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__: 'false', __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__: 'true',
    __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: JSON.stringify(manifestPin), __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: 'false',
    __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: JSON.stringify(converterBuild.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: JSON.stringify(outputBuild.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: JSON.stringify(outputDeviceBuild.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: JSON.stringify(outputDeviceBuild.candidate),
  }, plugins: [{ name: 'fixed-packaged-renderer-native-build-identity', generateBundle() {
    for (const [fileName, receipt] of [['converter-build.json', converterBuild], ['output-build.json', outputBuild], ['output-device-build.json', outputDeviceBuild]]) this.emitFile({ type: 'asset', fileName, source: JSON.stringify(receipt) + '\n' })
  } }], build: { outDir, rollupOptions: { input: {
    index: path.join(desktop, 'src/main/index.ts'), core: path.join(desktop, 'src/main', coreEntry),
    'dataset-owner': path.join(desktop, 'src/main/dataset-owner-entry.ts'),
    'spreadsheet-worker': path.join(desktop, '../../packages/bridge-core/src/collection/spreadsheet-worker.ts'),
  }, output: { entryFileNames: '[name].js' } } } } }
}
