import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const gitHash = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const object = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key))
const bundleRoot = appDirectory => path.join(appDirectory, 'native/output-device/darwin-arm64')
const invalid = () => { throw new Error('固定正式输出包或应用构建身份不一致；正式设备输出保持禁用。') }
const candidateKeys = ['commit', 'tree', 'sourceSha256', 'manifestSha256', 'helperSha256']
const validCandidate = value => keys(value, candidateKeys) && gitHash(value.commit) && gitHash(value.tree)
  && hash(value.sourceSha256) && hash(value.manifestSha256) && hash(value.helperSha256)

async function regularBytes(file, limit, executable = false) {
  if (!path.isAbsolute(file) || await realpath(file) !== file) return invalid()
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true }), deadline = performance.now() + 10_000
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit)
      || (before.mode & 0o022n) !== 0n || (executable && (before.mode & 0o100n) === 0n)) return invalid()
    const bytes = Buffer.alloc(Number(before.size))
    for (let position = 0; position < bytes.length;) {
      if (performance.now() > deadline) return invalid()
      const { bytesRead } = await handle.read(bytes, position, Math.min(bytes.length - position, 1024 * 1024), position)
      if (!bytesRead) return invalid()
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    if (!named.isFile() || await realpath(file) !== file
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].some(key => before[key] !== after[key] || before[key] !== named[key])) return invalid()
    return bytes
  } finally { await handle.close() }
}

async function inspectPackage(appDirectory) {
  const root = bundleRoot(appDirectory), bytes = await regularBytes(path.join(root, 'manifest.json'), 64 * 1024)
  const manifest = JSON.parse(bytes)
  if (!keys(manifest, ['schemaVersion', 'platform', 'arch', 'protocolVersion', 'backendId', 'backendVersion', 'mode', 'drainAlgorithmId', 'sourceSha256', 'files'])
    || manifest.schemaVersion !== 1 || manifest.platform !== 'darwin' || manifest.arch !== 'arm64'
    || manifest.protocolVersion !== 1 || manifest.backendId !== 'musicbridge-coreaudio-hal'
    || manifest.backendVersion !== '0.2.0' || manifest.mode !== 'device'
    || manifest.drainAlgorithmId !== 'hal-sample-zero-cover-v1' || !hash(manifest.sourceSha256)
    || !keys(manifest.files, ['helper']) || !keys(manifest.files.helper, ['path', 'sha256'])
    || manifest.files.helper.path !== 'bin/output-device-helper' || !hash(manifest.files.helper.sha256)
    || digest(await regularBytes(path.join(root, manifest.files.helper.path), 16 * 1024 * 1024, true)) !== manifest.files.helper.sha256) return invalid()
  return { root, manifest, manifestSha256: digest(bytes) }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: null, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
  return result.status === 0 && !result.error ? result.stdout : null
}

/** 只用当前源码真实字节与已提交Git树构造候选；dirty树的普通Replica包仍可使用。 */
async function candidateFor(appDirectory, identity) {
  try {
    const root = path.resolve(appDirectory, '../..')
    if (path.join(root, 'apps/desktop') !== appDirectory || await realpath(root) !== root) return null
    const sourceFiles = [
      'native/output-helper/frame-pump.cpp', 'native/output-helper/frame-pump.hpp',
      ...(await readdir(path.join(root, 'native/output-device'))).filter(name => /\.(?:cpp|hpp)$/u.test(name)).map(name => `native/output-device/${name}`),
      'scripts/build-output-device-helper.mjs',
    ].sort()
    const sourceBytes = await Promise.all(sourceFiles.map(name => readFile(path.join(root, name))))
    const sourceSha256 = digest(sourceFiles.map((name, index) => `${name}\0${digest(sourceBytes[index])}\n`).join(''))
    if (sourceSha256 !== identity.manifest.sourceSha256) return null
    const top = git(root, ['rev-parse', '--show-toplevel'])?.toString().trim()
    const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    const commit = git(root, ['rev-parse', 'HEAD'])?.toString().trim()
    const tree = git(root, ['rev-parse', 'HEAD^{tree}'])?.toString().trim()
    if (top !== root || !status || status.length || !gitHash(commit) || !gitHash(tree)) return null
    for (let index = 0; index < sourceFiles.length; index++) {
      const committed = git(root, ['show', `HEAD:${sourceFiles[index]}`])
      if (!committed || !committed.equals(sourceBytes[index])) return null
    }
    return { commit, tree, sourceSha256, manifestSha256: identity.manifestSha256,
      helperSha256: identity.manifest.files.helper.sha256 }
  } catch { return null }
}

/** 缺包只在构建当刻记录null；候选身份必须来自干净Git树和当前源码。 */
export async function captureNativeOutputDevice(appDirectory) {
  try {
    const identity = await inspectPackage(appDirectory)
    return { schemaVersion: 1, manifestSha256: identity.manifestSha256,
      candidate: await candidateFor(appDirectory, identity) }
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, manifestSha256: null, candidate: null }
    return invalid()
  }
}

/** 打包前复核独立v0.2设备包；旧0.1 synthetic-only 包绝不能混用。 */
export async function verifyNativeOutputDevicePackage(appDirectory) {
  try {
    const metadata = JSON.parse(await regularBytes(path.join(appDirectory, 'dist/main/output-device-build.json'), 1024))
    if (!keys(metadata, ['schemaVersion', 'manifestSha256', 'candidate']) || metadata.schemaVersion !== 1
      || !(metadata.manifestSha256 === null || hash(metadata.manifestSha256))
      || !(metadata.candidate === null || validCandidate(metadata.candidate))) return invalid()
    const root = bundleRoot(appDirectory)
    if (metadata.manifestSha256 === null) {
      if (metadata.candidate !== null) return invalid()
      try { await lstat(root) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
      return invalid()
    }
    const identity = await inspectPackage(appDirectory)
    if (identity.manifestSha256 !== metadata.manifestSha256) return invalid()
    if (metadata.candidate && (metadata.candidate.manifestSha256 !== identity.manifestSha256
      || metadata.candidate.sourceSha256 !== identity.manifest.sourceSha256
      || metadata.candidate.helperSha256 !== identity.manifest.files.helper.sha256)) return invalid()
    return root
  } catch { return invalid() }
}
