import { createHash, randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs'

export const volumeRoot = '/Volumes/LifeWeave'
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const within = (value, root) => value === root || value.startsWith(root + path.sep)
const hostedFlags = () => process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
function hostedPolicy() {
  if (!hostedFlags()) return undefined
  const workspace = process.env.GITHUB_WORKSPACE
  if (!workspace || !path.isAbsolute(workspace) || realpathSync(workspace) !== repositoryRoot || realpathSync(repositoryRoot) !== repositoryRoot) throw new Error('Hosted工作区身份与媒体 Worker 源码不一致。')
  return buildStoragePolicy()
}
function directoryChain(target, anchor) {
  const device = statSync(anchor).dev
  let current = anchor
  for (const part of path.relative(anchor, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (!info) continue
    if (info.isSymbolicLink() || info.dev !== device || !info.isDirectory() || realpathSync(current) !== current) throw new Error('媒体 Worker 路径含链接或跨卷目录。')
  }
}
export function storageLocations() {
  const hosted = hostedPolicy()
  if (hosted) return { hosted: true, commandRoot: hosted.check(path.join(hosted.root, 'musicbridge-media-worker')) }
  requireExternalVolume()
  return { hosted: false, commandRoot: path.join(volumeRoot, 'Developer/CommandLine') }
}
export function requireExternalVolume() {
  if (!existsSync(volumeRoot) || realpathSync(volumeRoot) !== volumeRoot || statSync(volumeRoot).dev === statSync('/Volumes').dev) throw new Error('LifeWeave 外置卷未挂载，操作已停止。')
  accessSync(volumeRoot, constants.W_OK)
  return statSync(volumeRoot).dev
}
export function assertExternalPath(target) {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) throw new Error('媒体 Worker 输出必须使用普通规范绝对路径。')
  const hosted = hostedPolicy()
  if (hosted) {
    const permitted = [path.join(repositoryRoot, 'native/media-worker/bin'), path.join(repositoryRoot, 'apps/desktop/native/media-worker')]
    if (permitted.some(root => within(target, root))) { directoryChain(target, repositoryRoot); return }
    hosted.check(target); return
  }
  requireExternalVolume()
  if (!target.startsWith(volumeRoot + '/')) throw new Error('媒体 Worker 输出必须位于已挂载 LifeWeave 卷。')
  directoryChain(target, volumeRoot)
}
export function sourceIdentity(sourceRoot) {
  if (sourceRoot !== path.join(repositoryRoot, 'native/media-worker')) throw new Error('媒体 Worker 源码根不符合当前工作树身份。')
  if (hostedPolicy()) directoryChain(sourceRoot, repositoryRoot)
  else assertExternalPath(sourceRoot)
  const real = realpathSync(sourceRoot), facts = statSync(real)
  return createHash('sha256').update(JSON.stringify([real, facts.dev, facts.ino])).digest('hex')
}
export function ensureOwnedOutput(target, sourceId, purpose, permitted) {
  assertExternalPath(target)
  if (existsSync(target)) {
    const entries = readdirSync(target)
    if (entries.some(name => ![...permitted, '.media-worker-output.json'].includes(name))) throw new Error('媒体 Worker 输出目录含其他文件，已停止。')
    if (entries.length) {
      const markerPath = path.join(target, '.media-worker-output.json')
      if (!existsSync(markerPath)) throw new Error('媒体 Worker 现有输出缺少归属标记，已停止。')
      assertRegularOutput(markerPath)
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      if (marker.schemaVersion !== 1 || marker.sourceIdentity !== sourceId || marker.purpose !== purpose) throw new Error('媒体 Worker 输出属于其他工作树，已停止。')
    }
  }
  mkdirSync(target, { recursive: true })
  const markerPath = path.join(target, '.media-worker-output.json')
  assertRegularOutput(markerPath)
  writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, sourceIdentity: sourceId, purpose }) + '\n', { mode: 0o644 })
}
export function assertRegularOutput(target) {
  assertExternalPath(path.dirname(target))
  const facts = lstatSync(target, { throwIfNoEntry: false })
  if (!facts) return
  if (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1 || facts.dev !== statSync(path.dirname(target)).dev || facts.mode & 0o022) throw new Error('媒体 Worker 输出文件身份、链接数或权限不符合要求。')
}

// 可执行文件不能原位覆写：macOS 可能继续使用旧 inode 的执行签名缓存。
// 同目录新建并完整写入后替换，使已打开的旧文件与新启动的文件各自保持完整。
export function publishOutputBytes(target, bytes, mode = 0o644) {
  assertRegularOutput(target)
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  let descriptor
  let created = false
  try {
    descriptor = openSync(temporary, 'wx', mode)
    created = true
    writeFileSync(descriptor, bytes)
    fchmodSync(descriptor, mode)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    assertRegularOutput(target)
    renameSync(temporary, target)
    created = false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (created) unlinkSync(temporary)
  }
}
