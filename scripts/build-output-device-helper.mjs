import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const volume = '/Volumes/LifeWeave'
const temporaryRoot = `${volume}/Developer/CommandLine/tmp`
const target = path.join(root, 'apps/desktop/native/output-device/darwin-arm64')
const source = path.join(root, 'native/output-device')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(message) }

if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('正式设备 helper 构建只支持 darwin-arm64。')
const disk = spawnSync('diskutil', ['info', volume], { encoding: 'utf8' })
if (disk.status !== 0 || !/Mounted:\s+Yes/u.test(disk.stdout) || !/Mount Point:\s+\/Volumes\/LifeWeave(?:\s|$)/u.test(disk.stdout)
  || !/Device Location:\s+External/u.test(disk.stdout) || !/Volume Read-Only:\s+No/u.test(disk.stdout)) fail('LifeWeave 外置卷未按要求挂载且可写。')
accessSync(temporaryRoot, constants.W_OK)
if (existsSync(target)) fail('正式设备包目标已经存在；不覆盖已有构建或清单。')

const work = mkdtempSync(path.join(temporaryRoot, 'musicbridge-output-device-'))
const stage = path.join(work, 'stage'), binary = path.join(stage, 'bin/output-device-helper')
mkdirSync(path.dirname(binary), { recursive: true })
const listSourceFiles = () => [
  'native/output-helper/frame-pump.cpp', 'native/output-helper/frame-pump.hpp',
  ...readdirSync(source).filter(name => /\.(?:cpp|hpp)$/u.test(name)).map(name => `native/output-device/${name}`),
  'scripts/build-output-device-helper.mjs',
].sort()
const sourceFiles = listSourceFiles()
const sourceDigest = () => sha(sourceFiles.map(name => `${name}\0${sha(readFileSync(path.join(root, name)))}\n`).join(''))
const sourceSha256 = sourceDigest()
const environment = { ...process.env, TMPDIR: temporaryRoot, CLANG_MODULE_CACHE_PATH: path.join(work, 'module-cache') }
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: 'utf8' })
  if (result.status !== 0) fail(`正式设备 helper 构建失败：${result.stderr || result.error || result.status}`)
  return result.stdout
}
const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim()
const flags = ['-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror', '-pthread', '-arch', 'arm64', '-mmacosx-version-min=13.0', '-isysroot', sdk]
const units = [
  'native/output-helper/frame-pump.cpp',
  'native/output-device/drain-observer.cpp',
  'native/output-device/core-audio-driver.cpp',
  'native/output-device/device-session.cpp',
  'native/output-device/system-device-probe.cpp',
  'native/output-device/device-catalog-inspector.cpp',
  'native/output-device/output-run-lease.cpp',
  'native/output-device/device-helper-main.cpp',
]
run('xcrun', ['clang++', ...flags, ...units.map(item => path.join(root, item)), '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-o', binary])
const dependencies = run('otool', ['-L', binary])
if (!/CoreAudio\.framework/u.test(dependencies) || !/CoreFoundation\.framework/u.test(dependencies)) fail('正式设备 helper 链接依赖不完整。')
if (listSourceFiles().join('\0') !== sourceFiles.join('\0') || sourceDigest() !== sourceSha256)
  fail('编译期间原生源码或构建器发生变化；拒绝给二进制签发错误的sourceSha256。')
const helperSha256 = sha(readFileSync(binary))
const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1,
  backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', mode: 'device',
  drainAlgorithmId: 'hal-sample-zero-cover-v1', sourceSha256,
  files: { helper: { path: 'bin/output-device-helper', sha256: helperSha256 } } }
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(path.join(stage, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 })
// mkdir排他认领此前不存在的目标，再以同APFS卷rename将完整stage原子替换自建空目录。
// 失败时保留work和空占位供审计，不删除任何已有包。
mkdirSync(path.dirname(target), { recursive: true })
if (statSync(stage).dev !== statSync(path.dirname(target)).dev) fail('构建stage与包目标不在同一外置文件系统，拒绝非原子发布。')
mkdirSync(target)
renameSync(stage, target)
console.log(JSON.stringify({ manifestSha256: sha(manifestBytes), sourceSha256, helperSha256,
  path: target, gateB: 'NOT_RUN', formalReady: false }))
