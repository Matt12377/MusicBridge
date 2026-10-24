import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertExternalPath, assertRegularOutput, ensureOwnedOutput, publishOutputBytes, storageLocations, sourceIdentity } from './storage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceRoot = path.join(root, 'native/media-worker')
const args = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1]
  if (!['--target', '--output-root'].includes(key) || !value || options.has(key)) throw new Error('媒体 Worker 构建参数无效。')
  options.set(key, value)
}
const targets = new Map([
  ['aarch64-apple-darwin', ['darwin', 'arm64']], ['x86_64-apple-darwin', ['darwin', 'x64']],
  ['x86_64-unknown-linux-gnu', ['linux', 'x64']], ['aarch64-unknown-linux-gnu', ['linux', 'arm64']],
  ['x86_64-pc-windows-msvc', ['win32', 'x64']], ['aarch64-pc-windows-msvc', ['win32', 'arm64']],
])
const requestedTarget = options.get('--target')
if (requestedTarget && !targets.has(requestedTarget)) throw new Error('媒体 Worker 构建目标尚未准入。')
const [platform, arch] = requestedTarget ? targets.get(requestedTarget) : [process.platform, process.arch]
const outputRoot = options.get('--output-root') ?? path.join(sourceRoot, 'bin', `${platform}-${arch}`)
if (!path.isAbsolute(outputRoot)) throw new Error('媒体 Worker 输出目录必须是绝对路径。')

const storage = storageLocations()
assertExternalPath(outputRoot)
const identity = sourceIdentity(sourceRoot)
const commandRoot = storage.commandRoot, tempRoot = path.join(commandRoot, 'tmp')
const cargoHome = path.join(commandRoot, 'Caches/Cargo')
assertExternalPath(tempRoot); assertExternalPath(cargoHome)
mkdirSync(tempRoot, { recursive: true }); mkdirSync(cargoHome, { recursive: true })
const work = mkdtempSync(path.join(tempRoot, 'mb-media-worker-build-'))
const targetKey = requestedTarget ?? [...targets].find(([, value]) => value[0] === platform && value[1] === arch)?.[0] ?? `${platform}-${arch}`
const targetRoot = path.join(commandRoot, 'Caches/CargoTargets', `musicbridge-media-${identity.slice(0, 24)}`, targetKey), logPath = path.join(work, 'build.log')
assertExternalPath(targetRoot); mkdirSync(targetRoot, { recursive: true })
const log = openSync(logPath, 'wx', 0o600)
if (!existsSync(path.join(sourceRoot, 'Cargo.lock'))) throw new Error('媒体 Worker 缺少 Cargo.lock；先锁定依赖再构建。')
const cargoArgs = ['build', '--locked', '--release', '--manifest-path', path.join(sourceRoot, 'Cargo.toml'), '--target-dir', targetRoot]
if (requestedTarget) cargoArgs.push('--target', requestedTarget)
try {
  await new Promise((resolve, reject) => {
    const child = spawn('cargo', cargoArgs, { cwd: sourceRoot, stdio: ['ignore', log, log], shell: false,
      env: { ...process.env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: targetRoot, DEV_BUILD_ROOT: commandRoot,
        DEV_CACHE_ROOT: path.join(commandRoot, 'Caches'), TMPDIR: tempRoot + '/' } })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`媒体 Worker 构建失败；日志：${logPath}`)))
  })
} finally { closeSync(log) }
const executable = platform === 'win32' ? 'musicbridge-media-worker.exe' : 'musicbridge-media-worker'
const built = path.join(targetRoot, ...(requestedTarget ? [requestedTarget] : []), 'release', executable)
ensureOwnedOutput(outputRoot, identity, `build-${platform}-${arch}`, [executable, 'manifest.json'])
const binaryPath = path.join(outputRoot, executable)
assertRegularOutput(binaryPath); assertRegularOutput(path.join(outputRoot, 'manifest.json'))
const bytes = readFileSync(built)
publishOutputBytes(binaryPath, bytes, 0o755)
const manifest = { schemaVersion: 1, protocolVersion: 1, parserVersion: 'musicbridge-rust-media/v1', platform, arch,
  sourceIdentity: identity,
  target: requestedTarget ?? [...targets].find(([, value]) => value[0] === platform && value[1] === arch)?.[0] ?? `${platform}-${arch}`,
  binary: { relativePath: executable, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
  dependencies: { lofty: '0.22.4', image: '0.25.9' } }
publishOutputBytes(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.info(JSON.stringify({ message: '媒体 Worker 构建完成', binaryPath, manifest: path.join(outputRoot, 'manifest.json'), logPath }))
