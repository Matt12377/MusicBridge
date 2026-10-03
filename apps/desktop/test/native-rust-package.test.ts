import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { captureNativeRust, verifyNativeRustPackage } from '../scripts/native-rust-package.mjs'

async function appFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-native-rust-build-'))
  await mkdir(path.join(directory, 'dist/main'), { recursive: true })
  return directory
}
const save = (directory: string, metadata: unknown) => writeFile(path.join(directory, 'dist/main/rust-core-build.json'), JSON.stringify(metadata) + '\n', { mode: 0o600 })

test('缺固定Rust资源可构建默认关闭身份，签前不凭空接受后来资源', async () => {
  const directory = await appFixture()
  const metadata = await captureNativeRust(directory)
  assert.deepEqual(metadata, { schemaVersion: 1, manifestSha256: null })
  await save(directory, metadata)
  assert.equal(await verifyNativeRustPackage(directory), false)
  await mkdir(path.join(directory, 'native/rust-core/darwin-arm64'), { recursive: true })
  await assert.rejects(verifyNativeRustPackage(directory), /固定编译身份/u)
  await assert.rejects(captureNativeRust(directory), '存在但损坏的资源不能冒充缺包')
})

test('签前拒绝坏构建回执、重复键、额外字段与缺失已pin资源', async () => {
  const directory = await appFixture()
  for (const metadata of [null, [], { schemaVersion: 1 }, { schemaVersion: 1, manifestSha256: true },
    { schemaVersion: 2, manifestSha256: null }, { schemaVersion: 1, manifestSha256: null, path: '/能力不进入回执' }]) {
    await save(directory, metadata)
    await assert.rejects(verifyNativeRustPackage(directory), /固定编译身份/u)
  }
  await writeFile(path.join(directory, 'dist/main/rust-core-build.json'), '{"schemaVersion":1,"schemaVersion":1,"manifestSha256":null}\n')
  await assert.rejects(verifyNativeRustPackage(directory), /固定编译身份/u)
  await save(directory, { schemaVersion: 1, manifestSha256: 'a'.repeat(64) })
  await assert.rejects(verifyNativeRustPackage(directory), '已编入pin却无资源必须阻断打包')
})

test('构建回执与资源清单不接受链接别名或不安全模式', async () => {
  const directory = await appFixture(), other = await appFixture()
  await save(other, { schemaVersion: 1, manifestSha256: null })
  await symlink(path.join(other, 'dist/main/rust-core-build.json'), path.join(directory, 'dist/main/rust-core-build.json'))
  await assert.rejects(verifyNativeRustPackage(directory), /固定编译身份/u)
  await assert.rejects(captureNativeRust(directory + '/.'), /固定编译身份/u)
  const resource = path.join(other, 'native/rust-core/darwin-arm64')
  await mkdir(resource, { recursive: true })
  await writeFile(path.join(resource, 'manifest.json'), '{}\n', { mode: 0o666 })
  await assert.rejects(captureNativeRust(other))
})
