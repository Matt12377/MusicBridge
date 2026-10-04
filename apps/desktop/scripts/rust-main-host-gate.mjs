import assert from 'node:assert/strict'
import { buildStoragePolicy } from './build-storage-root.mjs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { hostGateSources } from '../../../scripts/ci/rust-gate-inputs.mjs'
import { copyFile, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repository = path.resolve(desktop, '../..')
const values = process.argv.slice(2), outputArgument = values.find(value => value.startsWith('--output=')), modeArgument = values.find(value => value.startsWith('--mode='))
assert.ok(outputArgument && values.every(value => value === outputArgument || value === modeArgument), '用法：node scripts/rust-main-host-gate.mjs --output=<外置绝对目录> --mode=build|components|electron')
const output = outputArgument.slice('--output='.length), mode = modeArgument?.slice('--mode='.length) ?? 'build'
assert.ok(path.isAbsolute(output) && ['build', 'components', 'electron'].includes(mode))
const storage = buildStoragePolicy()
storage.check(output)
storage.check(process.env.TMPDIR ?? '', { mustExist: true })
const cacheRoot = process.env.DEV_CACHE_ROOT ?? (storage.hosted ? path.join(storage.root, 'musicbridge-electron/cache') : path.join(storage.root, 'Caches'))
storage.check(cacheRoot)
const env = { ...process.env, MUSIC_BRIDGE_RUST_MAIN_HOST_BUILD_ROOT: output, ELECTRON_CACHE: path.join(cacheRoot, 'Electron'),
  electron_config_cache: path.join(cacheRoot, 'Electron'), XDG_CACHE_HOME: cacheRoot, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function run(argv, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: desktop, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
    let stdout = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 && signal === null ? resolve(stdout) : reject(new Error(`隔离宿主步骤失败：${path.basename(argv[0])} exit=${code} signal=${signal}`)))
  })
}
const manifestPath = path.join(output, 'artifact-manifest.json')
if (mode === 'build') {
  assert.equal(existsSync(output), false, '保留旧产物，新的隔离构建必须采用新目录。')
  await mkdir(output)
  await run([process.execPath, path.join(desktop, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'e2e/rust-main-host.tsconfig.json'])
  const binaryPath = process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', binarySha256 = process.env.MUSIC_BRIDGE_RUST_SHA256 ?? ''
  assert.ok(path.isAbsolute(binaryPath) && /^[a-f0-9]{64}$/.test(binarySha256))
  assert.equal(hash(await readFile(binaryPath)), binarySha256)
  const sourceSha = (await run(['git', 'rev-parse', 'HEAD'], true)).trim()
  const sources = hostGateSources(repository, 'RUST-008')
  await run([path.join(desktop, 'node_modules/.bin/electron-vite'), 'build', '--config', 'e2e/rust-main-host.vite.config.ts', '--mode', 'production'])
  for (const name of ['private-rust-main-wrapper.mjs', 'private-rust-node-main-wrapper.mjs', 'private-rust-main-host-wrapper.mjs']) {
    await copyFile(path.join(desktop, 'e2e', name), path.join(output, 'main', name))
  }
  await writeFile(path.join(output, 'package.json'), '{"type":"module","private":true}\n')
  await symlink(path.join(desktop, 'node_modules'), path.join(output, 'node_modules'), 'dir')
  const artifacts = []
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await collect(file)
      else if (entry.isFile()) { const bytes = await readFile(file); artifacts.push({ path: path.relative(output, file), sha256: hash(bytes), bytes: bytes.length }) }
    }
  }
  for (const name of ['main', 'preload', 'renderer']) await collect(path.join(output, name))
  artifacts.push({ path: 'package.json', sha256: hash(await readFile(path.join(output, 'package.json'))), bytes: (await stat(path.join(output, 'package.json'))).size })
  for (const source of sources) assert.equal(hash(await readFile(path.join(repository, source.path))), source.sha256, `构建期间源发生变化：${source.path}`)
  const sourceAggregateSha256 = hash(JSON.stringify(sources))
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, task: 'RUST-008', sourceSha, sourceShaMeaning: 'git HEAD基线，WIP完整身份另由sourceAggregateSha256绑定', sourceAggregateSha256, binaryPath, binarySha256, sources, artifacts,
    compiledRustConfiguration: '静态编译pin/profile；运行时环境和父消息不能选择Rust', defaultCore: '零options默认Node', output, realServices: 'NOT_RUN' }, null, 2) + '\n')
  console.log(`RUST_MAIN_HOST_BUILD_PASS=${manifestPath}`)
}
if (mode === 'components') {
  assert.ok(existsSync(manifestPath), '组件测试必须使用本轮完整编译manifest。')
  env.MUSIC_BRIDGE_RUST_MAIN_COMPONENT_REPORT = process.env.MUSIC_BRIDGE_RUST_MAIN_COMPONENT_REPORT ?? path.join(output, 'main-component-report.json')
  await run([process.execPath, '--import', 'tsx', '--test', '--test-concurrency=1', 'test/rust-core/runtime-main-background.test.ts'])
  console.log(`RUST_MAIN_COMPONENT_PASS=${env.MUSIC_BRIDGE_RUST_MAIN_COMPONENT_REPORT}`)
}
if (mode === 'electron') {
  assert.ok(existsSync(manifestPath), '真实Electron必须使用本轮完整编译manifest。')
  env.MUSIC_BRIDGE_RUST_ELECTRON_REPORT = process.env.MUSIC_BRIDGE_RUST_ELECTRON_REPORT ?? path.join(output, 'electron-report.json')
  await run([process.execPath, '--import', 'tsx', '--test', '--test-concurrency=1', 'electron-gate/rust-main-host.test.ts'])
  console.log(`RUST_MAIN_ELECTRON_PASS=${env.MUSIC_BRIDGE_RUST_ELECTRON_REPORT}`)
}
