import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

export const RUST_RESOURCE_RELATIVE_ROOT = 'rust-core/darwin-arm64'
export const RUST_BINARY_RELATIVE_PATH = 'bin/musicbridge-rust-core'
const execute = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const commitHash = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, required, optional = []) => object(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && required.every(key => Object.hasOwn(value, key))
  && Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && [...required, ...optional].includes(key)
      && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
  })
const fail = category => { throw Object.assign(new Error(`Rust 资源${category}不符合固定准入。`), { code: 'RUST_RESOURCE_REJECTED' }) }
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode']
const same = (before, after) => fields.every(key => before[key] === after[key])
const validMode = info => (info.mode & 0o022n) === 0n && (info.mode & 0o7000n) === 0n
const absolute = file => typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file

function host(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'arm64' || process.platform !== 'darwin' || process.arch !== 'arm64') fail('平台或架构')
}
async function safeDirectory(directory) {
  if (!absolute(directory)) fail('路径')
  const before = await lstat(directory, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink() || !validMode(before) || await realpath(directory) !== directory) fail('路径或权限')
  return before
}
// 逐级拒绝可替换父路径；只检查最终 realpath 会漏掉无净位移的别名写法。
async function safeChain(directory) {
  const identities = []
  for (let current = directory;; current = path.dirname(current)) {
    identities.push({ path: current, identity: await safeDirectory(current) })
    if (current === path.dirname(current)) return identities
  }
}
async function recheckDirectories(identities, mutable = false) {
  for (const item of identities) {
    const now = await safeDirectory(item.path)
    if (mutable ? !['dev', 'ino', 'mode'].every(key => item.identity[key] === now[key]) : !same(item.identity, now)) fail('目录身份漂移')
  }
}
async function bytesAt(file, limit, executable = false) {
  if (!absolute(file) || await realpath(file) !== file) fail('路径')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit)
      || !validMode(before) || (executable && (before.mode & 0o100n) === 0n)) fail('文件或权限')
    const bytes = Buffer.alloc(Number(before.size)), deadline = performance.now() + 10_000
    for (let at = 0; at < bytes.length;) {
      if (performance.now() >= deadline) fail('读取期限')
      const { bytesRead } = await handle.read(bytes, at, Math.min(1024 * 1024, bytes.length - at), at)
      if (bytesRead < 1) fail('文件身份漂移')
      at += bytesRead
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    if (!named.isFile() || !same(before, after) || !same(before, named) || await realpath(file) !== file) fail('文件身份漂移')
    return { bytes, identity: before }
  } finally { await handle.close() }
}
async function recheckFile(file, observed, limit, executable = false) {
  const after = await bytesAt(file, limit, executable)
  if (!same(observed.identity, after.identity) || !observed.bytes.equals(after.bytes)) fail('文件身份漂移')
}
function thinArm64(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf
    || bytes.readUInt32LE(4) !== 0x0100000c || (bytes.readUInt32LE(8) & 0xffffff) !== 0
    || bytes.readUInt32LE(12) !== 2) fail('薄 Mach-O arm64 架构')
  const commands = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20)
  if (commands < 1 || commands > 4096 || commandBytes > bytes.length - 32) fail('Mach-O 结构')
  let at = 32, signatures = 0
  for (let index = 0; index < commands; index++) {
    if (at + 8 > 32 + commandBytes) fail('Mach-O 结构')
    const command = bytes.readUInt32LE(at), size = bytes.readUInt32LE(at + 4)
    if (size < 8 || size % 8 !== 0 || at + size > 32 + commandBytes) fail('Mach-O 结构')
    if (command === 0x1d) {
      if (size !== 16) fail('Mach-O 签名结构')
      const offset = bytes.readUInt32LE(at + 8), length = bytes.readUInt32LE(at + 12)
      if (offset < 32 + commandBytes || length < 1 || offset + length > bytes.length) fail('Mach-O 签名结构')
      signatures++
    }
    at += size
  }
  if (at !== 32 + commandBytes || signatures !== 1) fail('Mach-O 签名结构')
}
async function actualSignature(binaryPath) {
  try {
    const options = { timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }
    await execute('/usr/bin/codesign', ['--verify', '--strict', binaryPath], options)
    const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', binaryPath], options)
    const hashes = [...stderr.matchAll(/^CDHash=([a-f0-9]{40})$/gm)]
    if (!/^Signature=adhoc$/m.test(stderr) || !/^Format=Mach-O thin \(arm64\)$/m.test(stderr)
      || /^Authority=/m.test(stderr) || !/^TeamIdentifier=not set$/m.test(stderr) || hashes.length !== 1) fail('ad-hoc 签名')
    return hashes[0][1]
  } catch { return fail('实际签名') }
}
// JSON.parse 的后键覆盖不构成闭集：额外扫描各对象键，拒绝重复键。
function parseManifest(bytes) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) fail('清单编码')
  let at = 0
  const space = () => { while (at < text.length && /[ \t\r\n]/u.test(text[at])) at++ }
  const string = () => {
    const start = at++
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at))
    }
    fail('清单格式')
  }
  function scan(depth) {
    if (depth > 8) fail('清单格式')
    space()
    if (text[at] === '{') {
      at++; space(); const keys = new Set()
      if (text[at] === '}') { at++; return }
      while (true) {
        space(); if (text[at] !== '"') fail('清单格式')
        const key = string(); if (keys.has(key)) fail('清单重复键'); keys.add(key)
        space(); if (text[at++] !== ':') fail('清单格式')
        scan(depth + 1); space(); const separator = text[at++]
        if (separator === '}') return
        if (separator !== ',') fail('清单格式')
      }
    }
    if (text[at] === '[') {
      at++; space(); if (text[at] === ']') { at++; return }
      while (true) { scan(depth + 1); space(); const separator = text[at++]; if (separator === ']') return; if (separator !== ',') fail('清单格式') }
    }
    if (text[at] === '"') { string(); return }
    const start = at
    while (at < text.length && !/[,}\] \t\r\n]/u.test(text[at])) at++
    if (at === start) fail('清单格式')
  }
  try { const result = JSON.parse(text); scan(0); space(); if (at !== text.length) fail('清单格式'); return result }
  catch { return fail('清单格式') }
}
function manifestShape(manifest) {
  if (!exact(manifest, ['schemaVersion', 'kind', 'platform', 'arch', 'protocolVersion', 'source', 'binary'])
    || manifest.schemaVersion !== 1 || manifest.kind !== 'musicbridge-rust-readonly-resource'
    || manifest.platform !== 'darwin' || manifest.arch !== 'arm64' || manifest.protocolVersion !== 2
    || !exact(manifest.source, ['commit', 'sha256']) || !commitHash(manifest.source.commit) || !hash(manifest.source.sha256)
    || !exact(manifest.binary, ['relativePath', 'sha256', 'size', 'cdHash'])
    || manifest.binary.relativePath !== RUST_BINARY_RELATIVE_PATH || !hash(manifest.binary.sha256)
    || !Number.isSafeInteger(manifest.binary.size) || manifest.binary.size < 1 || manifest.binary.size > 64 * 1024 * 1024
    || !commitHash(manifest.binary.cdHash)) fail('清单闭集')
}
async function closedDirectory(directory, expected) {
  const names = (await readdir(directory)).sort()
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) fail('目录闭集')
}
async function protectedOperation(run) {
  try { return await run() } catch (error) {
    if (error?.code === 'RUST_RESOURCE_REJECTED') throw error
    return fail('文件或工具')
  }
}

/** 捕获已签名资源；这里不签名，也不接受运行期选择来源。 */
export async function createRustResourceManifest(input) {
  return protectedOperation(async () => {
    host()
    if (!exact(input, ['binaryPath', 'sourceCommit', 'sourceSha256'])
      || !commitHash(input.sourceCommit) || !hash(input.sourceSha256)) fail('参数')
    input = { ...input }
    const chain = await safeChain(path.dirname(input.binaryPath))
    const binary = await bytesAt(input.binaryPath, 64 * 1024 * 1024, true)
    thinArm64(binary.bytes); const cdHash = await actualSignature(input.binaryPath)
    await recheckFile(input.binaryPath, binary, 64 * 1024 * 1024, true); await recheckDirectories(chain)
    return { schemaVersion: 1, kind: 'musicbridge-rust-readonly-resource', platform: 'darwin', arch: 'arm64', protocolVersion: 2,
      source: { commit: input.sourceCommit, sha256: input.sourceSha256 },
      binary: { relativePath: RUST_BINARY_RELATIVE_PATH, sha256: digest(binary.bytes), size: binary.bytes.length, cdHash } }
  })
}

/** 独立构建 pin 是信任根，旁边的新清单永远不能自行取得准入。 */
export async function validateRustNativeDirectory(input) {
  return protectedOperation(async () => {
    if (!exact(input, ['directory', 'expectedManifestSha256'], ['platform', 'arch']) || !hash(input.expectedManifestSha256)) fail('参数')
    input = { ...input }
    host(input.platform, input.arch)
    const chain = await safeChain(input.directory), binDirectory = path.join(input.directory, 'bin')
    const binIdentity = await safeDirectory(binDirectory)
    await closedDirectory(input.directory, ['manifest.json', 'bin']); await closedDirectory(binDirectory, ['musicbridge-rust-core'])
    const manifestPath = path.join(input.directory, 'manifest.json'), metadata = await bytesAt(manifestPath, 64 * 1024)
    const manifestSha256 = digest(metadata.bytes)
    if (manifestSha256 !== input.expectedManifestSha256) fail('清单身份')
    const manifest = parseManifest(metadata.bytes); manifestShape(manifest)
    const binaryPath = path.join(input.directory, RUST_BINARY_RELATIVE_PATH), binary = await bytesAt(binaryPath, 64 * 1024 * 1024, true)
    const binarySha256 = digest(binary.bytes)
    if (binarySha256 !== manifest.binary.sha256 || binary.bytes.length !== manifest.binary.size) fail('二进制身份')
    thinArm64(binary.bytes); const cdHash = await actualSignature(binaryPath)
    if (cdHash !== manifest.binary.cdHash) fail('CDHash 身份')
    await recheckFile(manifestPath, metadata, 64 * 1024); await recheckFile(binaryPath, binary, 64 * 1024 * 1024, true)
    await closedDirectory(input.directory, ['manifest.json', 'bin']); await closedDirectory(binDirectory, ['musicbridge-rust-core'])
    await recheckDirectories([...chain, { path: binDirectory, identity: binIdentity }])
    return { manifest, manifestSha256, binaryPath, binarySha256, cdHash }
  })
}

/** 只复制已经准入的固定字节；目的根必须全新，失败现场保留。 */
export async function stageRustNativeResource(input) {
  return protectedOperation(async () => {
    if (!exact(input, ['sourceDirectory', 'resourcesDirectory', 'expectedManifestSha256'])) fail('参数')
    input = { ...input }
    const source = await validateRustNativeDirectory({ directory: input.sourceDirectory, expectedManifestSha256: input.expectedManifestSha256 })
    const destinationChain = await safeChain(input.resourcesDirectory)
    const relative = path.relative(input.sourceDirectory, input.resourcesDirectory)
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) fail('暂存范围')
    const metadata = await bytesAt(path.join(input.sourceDirectory, 'manifest.json'), 64 * 1024)
    const binary = await bytesAt(source.binaryPath, 64 * 1024 * 1024, true)
    if (digest(metadata.bytes) !== input.expectedManifestSha256 || digest(binary.bytes) !== source.binarySha256) fail('暂存源身份')
    const parent = path.join(input.resourcesDirectory, 'rust-core'), directory = path.join(input.resourcesDirectory, RUST_RESOURCE_RELATIVE_ROOT)
    try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await safeDirectory(parent); await recheckDirectories(destinationChain, true)
    // 不用 recursive、不覆盖；已有目标（含链接）一律拒绝。
    await mkdir(directory, { mode: 0o700 })
    const bin = path.join(directory, 'bin'); await mkdir(bin, { mode: 0o700 })
    await writeFile(path.join(directory, 'manifest.json'), metadata.bytes, { flag: 'wx', mode: 0o600 })
    await writeFile(path.join(directory, RUST_BINARY_RELATIVE_PATH), binary.bytes, { flag: 'wx', mode: 0o700 })
    await recheckDirectories(destinationChain, true)
    await validateRustNativeDirectory({ directory: input.sourceDirectory, expectedManifestSha256: input.expectedManifestSha256 })
    return validateRustNativeDirectory({ directory, expectedManifestSha256: input.expectedManifestSha256 })
  })
}
