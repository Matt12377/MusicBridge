import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/u.test(value)
const object = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key))
const bundleRoot = appDirectory => path.join(appDirectory, 'native/output/darwin-arm64')
const invalid = () => { throw new Error('固定输出包或应用构建身份不一致；无设备检查保持禁用。') }

async function regularBytes(file, limit, executable = false) {
  if (!path.isAbsolute(file) || await realpath(file) !== file) return invalid()
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true }), deadline = performance.now() + 10_000
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit) || (before.mode & 0o022n) !== 0n || (executable && !(before.mode & 0o100n))) return invalid()
    const bytes = Buffer.alloc(Number(before.size)); let position = 0
    while (position < bytes.length) {
      if (performance.now() > deadline) return invalid()
      const { bytesRead } = await handle.read(bytes, position, Math.min(1024 * 1024, bytes.length - position), position)
      if (!bytesRead) return invalid()
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    if (!named.isFile() || await realpath(file) !== file || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].some(key => before[key] !== after[key] || before[key] !== named[key])) return invalid()
    return bytes
  } finally { await handle.close() }
}

/** 只捕获固定清单身份；缺清单明确编译为禁用，不能从环境变量另找包。 */
export async function captureNativeOutput(appDirectory) {
  try { return { schemaVersion: 1, manifestSha256: digest(await regularBytes(path.join(bundleRoot(appDirectory), 'manifest.json'), 64 * 1024)) } }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, manifestSha256: null }; return invalid() }
}

/** null编译pin仅允许完全无包；缺构建metadata或后来加入的包不能自行取得准入。 */
export async function verifyNativeOutputPackage(appDirectory) {
  try {
    const metadata = JSON.parse(await regularBytes(path.join(appDirectory, 'dist/main/output-build.json'), 1024))
    if (!keys(metadata, ['schemaVersion', 'manifestSha256']) || metadata.schemaVersion !== 1 || !(metadata.manifestSha256 === null || hash(metadata.manifestSha256))) return invalid()
    const root = bundleRoot(appDirectory)
    if (metadata.manifestSha256 === null) {
      try { await lstat(root) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
      return invalid()
    }
    const bytes = await regularBytes(path.join(root, 'manifest.json'), 64 * 1024)
    if (digest(bytes) !== metadata.manifestSha256) return invalid()
    const manifest = JSON.parse(bytes)
    if (!keys(manifest, ['schemaVersion', 'platform', 'arch', 'protocolVersion', 'backendId', 'backendVersion', 'mode', 'files', 'sourceSha256'])
      || manifest.schemaVersion !== 1 || manifest.platform !== 'darwin' || manifest.arch !== 'arm64' || manifest.protocolVersion !== 1
      || manifest.backendId !== 'musicbridge-coreaudio-hal' || manifest.backendVersion !== '0.1.0' || manifest.mode !== 'synthetic-only'
      || !hash(manifest.sourceSha256) || !keys(manifest.files, ['helper', 'halAdapter'])) return invalid()
    for (const [name, expectedPath, executable] of [['helper', 'bin/output-helper', true], ['halAdapter', 'build/core-audio-adapter.o', false]]) {
      const pin = manifest.files[name]
      if (!keys(pin, ['path', 'sha256']) || pin.path !== expectedPath || !hash(pin.sha256)
        || digest(await regularBytes(path.join(root, pin.path), 16 * 1024 * 1024, executable)) !== pin.sha256) return invalid()
    }
    return root
  } catch { return invalid() }
}
