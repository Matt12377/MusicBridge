import assert from 'node:assert/strict'
import test from 'node:test'
import { createPackagedRendererBuildConfiguration, type PackagedRendererBuildOptions } from '../../e2e/rust-packaged-renderer.vite.config.mjs'

test('签前配置拒绝任意Core入口、Node pin覆盖、非字面量pin和本机输出', async () => {
  const options: PackagedRendererBuildOptions = { coreEntry: 'packaged-renderer-rust-core-entry.ts', manifestPin: 'a'.repeat(64), outDir: '/Volumes/LifeWeave/Developer/CommandLine/tmp/rust013-build-fixture' }
  // 负例有意跨过静态类型边界，验证真实模块仍拒绝非法运行时输入。
  for (const value of [{ ...options, coreEntry: '/outside/core.js' }, { ...options, coreEntry: 'packaged-renderer-node-core-entry.ts' }, { ...options, manifestPin: '$ENV_PIN' }, { ...options, outDir: '/tmp/rust013' }, { ...options, outDir: options.outDir + '/../escape' }]) await assert.rejects(createPackagedRendererBuildConfiguration(value as unknown as PackagedRendererBuildOptions))
})
