import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeConverter } from '../scripts/native-converter-package.mjs'
import { captureNativeOutput } from '../scripts/native-output-package.mjs'
import { captureNativeOutputDevice } from '../scripts/native-output-device-package.mjs'
import { captureNativeRust } from '../scripts/native-rust-package.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 仅签前工程工具选择静态动作期待，应用能力仍由正常用户boolean控制。 */
export async function createCollectionReadonlyBuildConfiguration({ probeExpectation, manifestPin, outDir }) {
  assert.ok(['node', 'rust', 'pin'].includes(probeExpectation))
  assert.ok(typeof manifestPin === 'string' && /^[a-f0-9]{64}$/u.test(manifestPin))
  assert.ok(typeof outDir === 'string' && path.resolve(outDir) === outDir && outDir.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const converter = await captureNativeConverter(desktop), output = await captureNativeOutput(desktop)
  const outputDevice = await captureNativeOutputDevice(desktop), rust = await captureNativeRust(desktop)
  assert.ok(rust.manifestSha256, '受控候选必须准备固定Rust资源，不以缺包代替普通开关验证。')
  assert.equal(probeExpectation === 'pin' ? manifestPin !== rust.manifestSha256 : manifestPin === rust.manifestSha256, true)
  return { main: { root: desktop, define: {
    __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: 'true',
    __MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__: JSON.stringify(probeExpectation),
    __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__: 'false',
    __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__: 'false',
    __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: JSON.stringify(manifestPin),
    __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: 'false',
    __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: JSON.stringify(converter.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: JSON.stringify(output.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: JSON.stringify(outputDevice.manifestSha256),
    __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: JSON.stringify(outputDevice.candidate),
  }, plugins: [{ name: 'fixed-collection-readonly-build-identity', generateBundle() {
    for (const [fileName, receipt] of [['converter-build.json', converter], ['output-build.json', output],
      ['output-device-build.json', outputDevice], ['rust-core-build.json', rust]]) {
      this.emitFile({ type: 'asset', fileName, source: JSON.stringify(receipt) + '\n' })
    }
  } }], build: { outDir, rollupOptions: { input: {
    index: path.join(desktop, 'src/main/index.ts'), core: path.join(desktop, 'src/main/core-entry.ts'),
    'dataset-owner': path.join(desktop, 'src/main/dataset-owner-entry.ts'),
    'spreadsheet-worker': path.join(desktop, '../../packages/bridge-core/src/collection/spreadsheet-worker.ts'),
  }, output: { entryFileNames: '[name].js' } } } } }
}
