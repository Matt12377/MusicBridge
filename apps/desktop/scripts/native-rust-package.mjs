import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import converterBeforePack from './native-converter-package.mjs'
import { validateRustNativeDirectory } from './rust-native-package.mjs'

export const NATIVE_RUST_BUILD_ROOT = 'native/rust-core/darwin-arm64'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const fail = () => { throw new Error('Rust 构建资源与固定编译身份不一致。') }
const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink']

async function appRoot(appDirectory) {
  if (typeof appDirectory !== 'string' || !path.isAbsolute(appDirectory) || path.resolve(appDirectory) !== appDirectory) fail()
  const info = await lstat(appDirectory)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(appDirectory) !== appDirectory || (info.mode & 0o022) !== 0) fail()
  return appDirectory
}
async function regularBytes(file, limit) {
  const named = await lstat(file, { bigint: true })
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size < 1n || named.size > BigInt(limit)
    || (named.mode & 0o7022n) !== 0n || await realpath(file) !== file) fail()
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (fields.some(key => before[key] !== named[key])) fail()
    const bytes = Buffer.alloc(Number(before.size)), deadline = performance.now() + 10_000
    for (let offset = 0; offset < bytes.length;) {
      if (performance.now() >= deadline) fail()
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead < 1) fail()
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true })
    if (bytes.length !== Number(before.size) || fields.some(key => before[key] !== after[key] || before[key] !== current[key])
      || await realpath(file) !== file) fail()
    return bytes
  } finally { await handle.close() }
}
async function missingRoot(directory) {
  try { await lstat(directory); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

/** 固定构建资源已签名才捕获；缺包只允许默认关闭的开发构建。 */
export async function captureNativeRust(appDirectory) {
  const directory = path.join(await appRoot(appDirectory), NATIVE_RUST_BUILD_ROOT)
  if (await missingRoot(directory)) return { schemaVersion: 1, manifestSha256: null }
  const manifestSha256 = digest(await regularBytes(path.join(directory, 'manifest.json'), 64 * 1024))
  await validateRustNativeDirectory({ directory, expectedManifestSha256: manifestSha256 })
  return { schemaVersion: 1, manifestSha256 }
}

/** 签前只接受构建时捕获的pin；旁边的新清单不能自行取得准入。 */
export async function verifyNativeRustPackage(appDirectory) {
  const directory = path.join(await appRoot(appDirectory), NATIVE_RUST_BUILD_ROOT)
  const bytes = await regularBytes(path.join(appDirectory, 'dist/main/rust-core-build.json'), 1024)
  let metadata
  try { metadata = JSON.parse(bytes.toString('utf8')) } catch { return fail() }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).length !== 2 || metadata.schemaVersion !== 1
    || !(metadata.manifestSha256 === null || hash(metadata.manifestSha256))
    || !bytes.equals(Buffer.from(JSON.stringify({ schemaVersion: 1, manifestSha256: metadata.manifestSha256 }) + '\n'))) fail()
  if (metadata.manifestSha256 === null) {
    if (!await missingRoot(directory)) fail()
    return false
  }
  await validateRustNativeDirectory({ directory, expectedManifestSha256: metadata.manifestSha256 })
  return directory
}

export default async function beforePack(context) {
  await converterBeforePack(context)
  await verifyNativeRustPackage(await realpath(context.packager.info.appDir))
}
