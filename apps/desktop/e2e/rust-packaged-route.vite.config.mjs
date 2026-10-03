import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeConverter } from '../scripts/native-converter-package.mjs'
import { captureNativeOutput } from '../scripts/native-output-package.mjs'
import { captureNativeOutputDevice } from '../scripts/native-output-device-package.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 仅构建工具调用；每份外置编译配置将参数写成固定字面量，应用运行时不读取这些参数。 */
export async function createPackagedRouteBuildConfiguration({ coreEntry, manifestPin, outDir }) {
  assert.ok(['packaged-node-core-entry.ts', 'packaged-rust-core-entry.ts'].includes(coreEntry))
  assert.ok(coreEntry === 'packaged-node-core-entry.ts' ? manifestPin === null : /^[a-f0-9]{64}$/.test(manifestPin))
  assert.ok(path.resolve(outDir) === outDir && outDir.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const converterBuild = await captureNativeConverter(desktop)
  const outputBuild = await captureNativeOutput(desktop)
  const outputDeviceBuild = await captureNativeOutputDevice(desktop)
  return {
    main: {
      root: desktop,
      define: {
        __MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__: 'false', __MUSIC_BRIDGE_COLLECTION_READONLY_PROBE_EXPECTATION__: 'null', __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__: 'false',
        __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__: 'true',
        __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: JSON.stringify(manifestPin),
        __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: 'false',
        __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: JSON.stringify(converterBuild.manifestSha256),
        __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: JSON.stringify(outputBuild.manifestSha256),
        __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: JSON.stringify(outputDeviceBuild.manifestSha256),
        __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: JSON.stringify(outputDeviceBuild.candidate),
      },
      plugins: [{
        name: 'fixed-packaged-route-native-build-identity',
        generateBundle() {
          for (const [fileName, receipt] of [['converter-build.json', converterBuild], ['output-build.json', outputBuild], ['output-device-build.json', outputDeviceBuild]]) {
            this.emitFile({ type: 'asset', fileName, source: JSON.stringify(receipt) + '\n' })
          }
        },
      }],
      build: {
        outDir,
        rollupOptions: {
          input: {
            index: path.join(desktop, 'src/main/index.ts'),
            core: path.join(desktop, 'src/main', coreEntry),
            'dataset-owner': path.join(desktop, 'src/main/dataset-owner-entry.ts'),
            'spreadsheet-worker': path.join(desktop, '../../packages/bridge-core/src/collection/spreadsheet-worker.ts'),
          },
          output: { entryFileNames: '[name].js' },
        },
      },
    },
  }
}
