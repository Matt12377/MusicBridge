import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRustResourceManifest, validateRustNativeDirectory } from '../../apps/desktop/scripts/rust-native-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const external = '/Volumes/LifeWeave/Developer/CommandLine'
const requireDesktop = createRequire(path.join(desktop, 'package.json'))
let ownedOutput
const sha = value => createHash('sha256').update(value).digest('hex')
const digest = async file => sha(await readFile(file))
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })

function isolateToolEnvironment() {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
    'DEV_BUILD_ROOT', 'DEV_CACHE_ROOT', 'COREPACK_HOME', 'npm_config_cache', 'npm_config_store_dir',
    'ELECTRON_CACHE', 'electron_config_cache', 'ELECTRON_SKIP_BINARY_DOWNLOAD', 'XDG_CACHE_HOME',
    'NODE_COMPILE_CACHE', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_TOOLCHAIN'])
  for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key]
  process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
}

async function runGateCheck(output, name, executable, argv, extraEnvironment = {}) {
  const started = performance.now(), log = path.join(output, name + '.log')
  const { open } = await import('node:fs/promises')
  const handle = await open(log, 'wx', 0o600)
  let result
  try {
    await handle.write(JSON.stringify({ executable, argv, cwd: root }) + '\n')
    const child = spawn(executable, argv, { cwd: root, env: { ...process.env, ...extraEnvironment }, stdio: ['ignore', handle.fd, handle.fd], shell: false })
    let forcedCleanup = false, failure = null, killTimer
    child.once('error', error => { failure = error.message })
    const timer = setTimeout(() => { forcedCleanup = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 8000) }, 120_000)
    const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    clearTimeout(timer); clearTimeout(killTimer)
    result = { name, executable, argv, ...exit, forcedCleanup, failure, durationMs: performance.now() - started }
  } finally { await handle.close() }
  const receipt = { ...result, log, logSha256: await digest(log) }
  await save(path.join(output, name + '.json'), receipt)
  assert.equal(receipt.code, 0, `本期自动检查失败：${name}`); assert.equal(receipt.signal, null)
  assert.equal(receipt.failure, null); assert.equal(receipt.forcedCleanup, false)
  return receipt
}

function command(commandPath, argv) {
  const value = spawnSync(commandPath, argv, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  assert.equal(value.error, undefined, '验证命令没有正常执行')
  assert.equal(value.status, 0, `验证命令失败：${commandPath}`)
  assert.equal(value.signal, null, '验证命令被信号终止')
  return (value.stdout ?? '') + (value.stderr ?? '')
}

async function checkStorage(output, binaryPath) {
  // diskutil 的 plist 经 plutil 转为 JSON，不能把同名本机目录当外置卷。
  const diskutil = spawnSync('/usr/sbin/diskutil', ['info', '-plist', '/Volumes/LifeWeave'], { encoding: 'utf8' })
  assert.equal(diskutil.status, 0, '外置卷检查失败')
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: diskutil.stdout, encoding: 'utf8' })
  assert.equal(converted.status, 0, '外置卷信息解析失败')
  const disk = JSON.parse(converted.stdout)
  assert.equal(disk.MountPoint, '/Volumes/LifeWeave')
  assert.equal(disk.Internal, false, '不能使用本机同名目录')
  assert.equal(disk.WritableVolume, true, '外置卷不可写')
  assert.notEqual((await lstat('/Volumes/LifeWeave')).dev, (await lstat('/')).dev)
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
  assert.match(process.versions.node, /^22\./)
  assert.equal(path.resolve(output), output, '输出路径必须是规范绝对路径')
  assert.ok(output.startsWith(external + '/tmp/'), '输出必须位于外置任务临时根')
  assert.equal(await realpath(path.dirname(output)), path.dirname(output), '输出父目录不能为链接')
  assert.equal(path.resolve(binaryPath), binaryPath, '二进制必须是规范绝对路径')
  assert.ok(binaryPath.startsWith(external + '/tmp/'), '只准入外置任务构建二进制')
  assert.equal(await realpath(binaryPath), binaryPath, '二进制不能为链接')
  assert.ok((await lstat(binaryPath)).isFile())
  assert.equal(process.env.TMPDIR, path.join(output, 'tmp'), 'TMPDIR 必须显式指向本次外置任务')
  await mkdir(output, { mode: 0o700 }) // 已存在的结果不能被覆盖。
  ownedOutput = output
  await mkdir(path.join(output, 'tmp'), { mode: 0o700 })
  return { mount: disk.MountPoint, internal: disk.Internal, writable: disk.WritableVolume, device: disk.DeviceIdentifier }
}

async function treeIdentity(directory) {
  const entries = []
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), relative = path.relative(directory, file).replaceAll(path.sep, '/')
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) {
        assert.ok((await realpath(file)).startsWith(directory + '/'), '候选链接越界')
        const { readlink } = await import('node:fs/promises')
        entries.push({ path: relative, kind: 'symlink', target: await readlink(file) })
      } else if (stat.isDirectory()) await visit(file)
      else { assert.ok(stat.isFile()); entries.push({ path: relative, kind: 'file', sha256: await digest(file), bytes: stat.size, mode: stat.mode & 0o777 }) }
    }
  }
  await visit(directory)
  return entries
}

async function sourceIdentity() {
  const paths = new Set(command('git', ['ls-files', '-z', 'apps', 'packages', 'native/rust-core', 'scripts', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']).trim().split('\0').filter(Boolean))
  for (const dir of ['apps/desktop/scripts', 'apps/desktop/src/main', 'apps/desktop/test/helpers', 'apps/desktop/test/rust-core', 'apps/desktop/e2e', 'scripts/ci']) {
    for (const name of await readdir(path.join(root, dir))) if (/rust-(?:native-package|core-resource|offline-candidate)/.test(name)) paths.add(dir + '/' + name)
  }
  const entries = []
  for (const file of [...paths].sort()) entries.push({ path: file, sha256: await digest(path.join(root, file)) })
  return { entries, sha256: sha(entries.map(value => value.path + '\0' + value.sha256 + '\n').join('')) }
}

async function prepareCandidate(output, binaryPath) {
  const storage = await checkStorage(output, binaryPath)
  const source = await sourceIdentity()
  const sourceCommit = command('git', ['rev-parse', 'HEAD']).trim()
  const pnpm = path.join(external, 'Caches/corepack/v1/pnpm/10.17.1/bin/pnpm.cjs')
  assert.equal(command(process.execPath, [pnpm, '--version']).trim(), '10.17.1')
  const productionBuild = await runGateCheck(output, 'fresh-production-build', process.execPath, [pnpm, 'run', 'build'])
  assert.deepEqual(await sourceIdentity(), source, '新鲜生产构建期间程序输入不能变化')
  const distIdentity = await treeIdentity(path.join(desktop, 'dist'))
  const rustFiles = command('git', ['ls-files', '-z', 'native/rust-core']).trim().split('\0').filter(Boolean).sort()
  const rustInputs = await Promise.all(rustFiles.map(async file => ({ path: file, sha256: await digest(path.join(root, file)) })))
  const sourceSha256 = sha(rustInputs.map(value => value.path + '\0' + value.sha256 + '\n').join(''))
  const nativeDirectory = path.join(output, 'native-resource/darwin-arm64')
  await mkdir(path.join(nativeDirectory, 'bin'), { recursive: true, mode: 0o755 })
  const signedBinary = path.join(nativeDirectory, 'bin/musicbridge-rust-core')
  await copyFile(binaryPath, signedBinary); await chmod(signedBinary, 0o755)
  const unsignedBinary = { path: binaryPath, sha256: await digest(binaryPath) }
  const nativeSigning = command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', signedBinary])
  await writeFile(path.join(output, 'native-signing.log'), nativeSigning, { flag: 'wx' })
  const manifest = await createRustResourceManifest({ binaryPath: signedBinary, sourceCommit, sourceSha256 })
  await save(path.join(nativeDirectory, 'manifest.json'), manifest)
  await chmod(path.join(nativeDirectory, 'manifest.json'), 0o644)
  const expectedManifestSha256 = await digest(path.join(nativeDirectory, 'manifest.json'))
  const nativeBefore = await validateRustNativeDirectory({ directory: nativeDirectory, expectedManifestSha256 })
  const pkg = await json(path.join(desktop, 'package.json'))
  const electronPackage = requireDesktop.resolve('electron/package.json')
  const electronDist = path.join(path.dirname(electronPackage), 'dist')
  assert.equal((await json(electronPackage)).version, '43.4.0')
  assert.equal((await json(requireDesktop.resolve('electron-builder/package.json'))).version, '26.15.3')
  assert.equal(await realpath(electronDist), electronDist)
  const electronBefore = await treeIdentity(electronDist)
  assert.equal(electronBefore.length, 275, '必须使用已核对的完整 Electron 缓存')
  const { getCurrentFuseWire } = requireDesktop(requireDesktop.resolve('@electron/fuses', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const baselineFuses = await getCurrentFuseWire(path.join(electronDist, 'Electron.app'))
  const productionConfigurationSha256 = await digest(path.join(desktop, 'package.json'))
  const productionBeforePackSha256 = await digest(path.join(desktop, 'scripts/native-converter-package.mjs'))
  const configuration = {
    extends: null,
    appId: 'com.musicbridge.rust.resource-candidate', productName: 'MusicBridge Rust Resource Candidate',
    electronVersion: '43.4.0', electronDist,
    directories: { output: path.join(output, 'package'), buildResources: path.join(desktop, 'build') },
    files: pkg.build.files, asar: true, npmRebuild: false, nodeGypRebuild: false,
    mac: { ...pkg.build.mac, target: ['dir'], identity: null },
    electronFuses: pkg.build.electronFuses,
    extraResources: [{ from: nativeDirectory, to: 'rust-core/darwin-arm64', filter: ['manifest.json', 'bin/musicbridge-rust-core'] }],
  }
  await save(path.join(output, 'candidate-configuration.json'), configuration)
  const { build, Platform, Arch } = requireDesktop('electron-builder')
  // 候选自身的资源门禁独立于生产音频资源 beforePack。
  await build({ projectDir: desktop, config: { ...configuration, beforePack: async context => {
    assert.equal(context.electronPlatformName, 'darwin'); assert.equal(context.arch, Arch.arm64)
    await validateRustNativeDirectory({ directory: nativeDirectory, expectedManifestSha256 })
  } }, targets: Platform.MAC.createTarget(['dir'], Arch.arm64) })
  const appPath = path.join(output, 'package/mac-arm64/MusicBridge Rust Resource Candidate.app')
  const resourcesDirectory = path.join(appPath, 'Contents/Resources')
  const nativeFinal = await validateRustNativeDirectory({ directory: path.join(resourcesDirectory, 'rust-core/darwin-arm64'), expectedManifestSha256 })
  assert.deepEqual(nativeFinal.manifest, nativeBefore.manifest, 'Fuse 签名步骤不能改变固定 native pin')
  const outerSigning = command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', path.join(desktop, 'build/entitlements.mac.plist'), appPath])
  const bundleVerification = command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const bundleDisplay = command('/usr/bin/codesign', ['--display', '--verbose=4', appPath])
  assert.match(bundleDisplay, /Signature=adhoc/)
  await writeFile(path.join(output, 'bundle-signature.log'), outerSigning + bundleVerification + bundleDisplay, { flag: 'wx' })
  const nativeAfterSeal = await validateRustNativeDirectory({ directory: path.join(resourcesDirectory, 'rust-core/darwin-arm64'), expectedManifestSha256 })
  assert.deepEqual(nativeAfterSeal, nativeFinal, '外层 seal 不得改变 native 身份')
  const finalFuses = await getCurrentFuseWire(appPath)
  const expectedFuses = { ...baselineFuses, 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 7: 48 }
  assert.deepEqual(finalFuses, expectedFuses, '最终实际 Fuse 值必须保持原安全配置')
  const asarPath = path.join(resourcesDirectory, 'app.asar')
  const asar = requireDesktop(requireDesktop.resolve('@electron/asar', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const { headerString } = asar.getRawHeader(asarPath)
  const asarHeaderSha256 = sha(headerString)
  const plistPath = path.join(appPath, 'Contents/Info.plist')
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]))
  assert.deepEqual(plist.ElectronAsarIntegrity['Resources/app.asar'], { algorithm: 'SHA256', hash: asarHeaderSha256 })
  assert.equal(plist.CFBundleIdentifier, configuration.appId)
  const asarPackage = JSON.parse(asar.extractFile(asarPath, 'package.json').toString())
  assert.equal(asarPackage.main, 'dist/main/index.js')
  const defaultEntries = []
  for (const name of ['index.js', 'core.js']) {
    const relative = 'dist/main/' + name, content = asar.extractFile(asarPath, relative)
    assert.equal(sha(content), await digest(path.join(desktop, relative)), 'ASAR 必须保留原默认入口')
    defaultEntries.push({ path: relative, sha256: sha(content) })
  }
  for (const entry of distIdentity) {
    assert.equal(entry.kind, 'file', '正式 dist 只准入普通构建文件')
    if (!entry.path.endsWith('.map')) assert.equal(sha(asar.extractFile(asarPath, 'dist/' + entry.path)), entry.sha256, '完整正式 dist 必须与实际 ASAR 内容一致')
  }
  const archiveFiles = asar.listPackage(asarPath)
  assert.equal(archiveFiles.some(file => /^\/(?:e2e|test|scripts)\//.test(file) || /private-rust.*wrapper|rust-collection-human-session/.test(file)), false, '候选不得包含私有测试主入口')
  assert.deepEqual(await treeIdentity(electronDist), electronBefore, '打包不能改变 Electron 来源缓存')
  assert.equal(await digest(path.join(desktop, 'package.json')), productionConfigurationSha256)
  assert.equal(await digest(path.join(desktop, 'scripts/native-converter-package.mjs')), productionBeforePackSha256)
  const executable = path.join(appPath, 'Contents/MacOS', plist.CFBundleExecutable)
  const candidateIdentity = { appPath, resourcesDirectory, executable, executableSha256: await digest(executable),
    manifestSha256: expectedManifestSha256, native: nativeAfterSeal,
    asar: { path: asarPath, sha256: await digest(asarPath), headerSha256: asarHeaderSha256, main: asarPackage.main, defaultEntries },
    fuses: finalFuses, infoPlistSha256: await digest(plistPath), bundleCDHash: bundleDisplay.match(/^CDHash=([a-f0-9]{40})$/m)?.[1],
    bundleFiles: await treeIdentity(appPath) }
  assert.match(candidateIdentity.bundleCDHash, /^[a-f0-9]{40}$/)
  assert.deepEqual(await sourceIdentity(), source, '候选构建期间程序输入不能变化')
  const preparation = { schemaVersion: 1, task: 'RUST-011', state: 'PREPARED_NOT_RUNTIME_PASS', storage, sourceCommit, source, productionBuild, distIdentity,
    fuseIdentity: { baseline: baselineFuses, expected: expectedFuses, final: finalFuses, policy: '原七项配置翻转；第6与第8位保留实际缓存值' },
    rustInputs, rustSourceSha256: sourceSha256, unsignedBinary, electronFiles: electronBefore, productionConfigurationSha256,
    productionBeforePackSha256, candidateIdentity, ownerAcceptance: 'NOT_RUN', packagedRustMainCoreRoute: 'NOT_IN_SCOPE',
    productionDefault: 'Node', installation: 'NOT_RUN', realServices: 'NOT_RUN', implicitDownload: false }
  await save(path.join(output, 'candidate-preparation.json'), preparation)
  return preparation
}

async function runPackagedDefault(preparation, output) {
  const { executable, executableSha256 } = preparation.candidateIdentity
  assert.equal(await digest(executable), executableSha256)
  const profileDirectory = await mkdtemp(path.join(output, 'tmp/musicbridge-task036-startup-'))
  assert.deepEqual(await readdir(profileDirectory), [], '只准入本次新建空 profile')
  const environment = {}
  for (const key of ['HOME', 'USER', 'LOGNAME']) if (process.env[key]) environment[key] = process.env[key]
  Object.assign(environment, {
    PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: path.join(output, 'tmp'),
    MUSIC_BRIDGE_STARTUP_TEST: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E: '1',
    MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: profileDirectory,
  })
  const argv = ['--use-mock-keychain'], startedAt = Date.now()
  let stdout = '', stderr = '', forcedCleanup = false, spawnError = null, closed = false
  const child = spawn(executable, argv, { cwd: profileDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  child.stdout.on('data', bytes => { stdout += bytes.toString() })
  child.stderr.on('data', bytes => { stderr += bytes.toString() })
  child.on('error', error => { spawnError = error.message })
  const rustChildrenObserved = new Set()
  const observeDescendants = () => {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
    assert.equal(result.status, 0, '默认候选后代进程观察失败')
    const rows = result.stdout.split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3] }] : []
    })
    const descendants = new Set([child.pid])
    for (let changed = true; changed;) {
      changed = false
      for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true }
    }
    for (const row of rows) if (descendants.has(row.pid) && path.basename(row.executable) === 'musicbridge-rust-core') rustChildrenObserved.add(row.pid)
  }
  // 进程观察是补充；原 Core 字节与零选项入口仍单独绑定，不能将采样冒称完整跟踪。
  let observationError = null
  const interval = setInterval(() => { try { observeDescendants() } catch (error) { observationError = error.message } }, 50)
  let killTimer
  const timer = setTimeout(() => {
    forcedCleanup = true; child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 8000)
  }, 45_000)
  const exit = await new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) }))
  clearTimeout(timer); clearTimeout(killTimer); clearInterval(interval)
  const log = path.join(output, 'packaged-default-node.log')
  await writeFile(log, stdout + '\n--- STDERR ---\n' + stderr, { flag: 'wx', mode: 0o600 })
  const lifecycle = stdout.split('\n').flatMap(line => line.startsWith('TASK078_LIFECYCLE ') ? [JSON.parse(line.slice('TASK078_LIFECYCLE '.length))] : [])
  const report = { kind: 'packaged-default-node', executable, executableSha256, argv, cwd: profileDirectory, profileDirectory,
    profileWasFresh: true, environmentKeys: Object.keys(environment).sort(), environmentFlags: Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith('MUSIC_BRIDGE_'))),
    readyMarkerCount: stdout.split('\n').filter(line => line.trim() === 'DESKTOP_STARTUP_READY').length,
    failureMarkerCount: (stdout.match(/DESKTOP_STARTUP_FAIL/g) ?? []).length,
    lifecycle, electronExit: { ...exit, closed }, forcedCleanup, spawnError, observationError,
    observedRustChildCount: rustChildrenObserved.size, processObservation: 'bounded-50ms-ps-sampling-plus-default-entry-identity',
    ownerWorkerExit: 'NOT_INDEPENDENTLY_OBSERVED', durationMs: Date.now() - startedAt, log: { path: log, sha256: await digest(log) } }
  await save(path.join(output, 'packaged-default-node.json'), report)
  assert.equal(spawnError, null); assert.equal(observationError, null); assert.equal(closed, true)
  assert.deepEqual(exit, { code: 0, signal: null }); assert.equal(forcedCleanup, false)
  assert.equal(report.readyMarkerCount, 1); assert.equal(report.failureMarkerCount, 0)
  assert.equal(rustChildrenObserved.size, 0)
  const phase = name => lifecycle.findIndex(event => event.phase === name)
  for (const name of ['bootstrap-start', 'data-prepared', 'core-spawn', 'core-ready-received', 'onready-complete', 'supervisor-ready', 'ui-loaded', 'before-quit', 'core-shutdown-start', 'core-exit', 'core-shutdown-end', 'app-quit-reissued', 'will-quit']) assert.ok(phase(name) >= 0, `缺少默认候选生命周期：${name}`)
  assert.deepEqual(lifecycle.filter(event => event.phase === 'core-exit').map(event => event.exitCode), [0])
  assert.equal(phase('outbox-close-timeout'), -1)
  assert.ok(phase('core-shutdown-start') < phase('core-exit') && phase('core-exit') < phase('core-shutdown-end') && phase('core-shutdown-end') < phase('will-quit'))
  assert.equal(await digest(executable), executableSha256)
  return report
}

async function observeFinalIdentity(preparation) {
  const before = preparation.candidateIdentity, { appPath, resourcesDirectory } = before
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const signature = command('/usr/bin/codesign', ['--display', '--verbose=4', appPath])
  assert.match(signature, /^Signature=adhoc$/m)
  const native = await validateRustNativeDirectory({ directory: path.join(resourcesDirectory, 'rust-core/darwin-arm64'), expectedManifestSha256: before.manifestSha256 })
  assert.equal(command('/usr/bin/lipo', ['-archs', native.binaryPath]).trim(), 'arm64')
  const { getCurrentFuseWire } = requireDesktop(requireDesktop.resolve('@electron/fuses', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const asar = requireDesktop(requireDesktop.resolve('@electron/asar', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const asarPath = path.join(resourcesDirectory, 'app.asar'), plistPath = path.join(appPath, 'Contents/Info.plist')
  const headerSha256 = sha(asar.getRawHeader(asarPath).headerString)
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]))
  assert.deepEqual(plist.ElectronAsarIntegrity['Resources/app.asar'], { algorithm: 'SHA256', hash: headerSha256 })
  const candidateIdentity = { appPath, resourcesDirectory, executable: before.executable,
    executableSha256: await digest(before.executable), manifestSha256: await digest(path.join(resourcesDirectory, 'rust-core/darwin-arm64/manifest.json')), native,
    asar: { path: asarPath, sha256: await digest(asarPath), headerSha256,
      main: JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).main,
      defaultEntries: ['index.js', 'core.js'].map(name => ({ path: 'dist/main/' + name, sha256: sha(asar.extractFile(asarPath, 'dist/main/' + name)) })) },
    fuses: await getCurrentFuseWire(appPath), infoPlistSha256: await digest(plistPath),
    bundleCDHash: signature.match(/^CDHash=([a-f0-9]{40})$/m)?.[1], bundleFiles: await treeIdentity(appPath) }
  assert.deepEqual(candidateIdentity, before, '独立最终观察必须与构建资源身份完全一致')
  const source = await sourceIdentity()
  assert.deepEqual(source, preparation.source, '实际运行后源码不能漂移')
  return { sourceCommit: preparation.sourceCommit, sourceSha256: source.sha256, candidateIdentity,
    verification: { platform: 'darwin', arch: 'arm64', nativeSignature: { verified: true, adHoc: true, cdHash: native.cdHash },
      bundleSignature: { verified: true, adHoc: true, cdHash: candidateIdentity.bundleCDHash },
      asarIntegrity: { algorithm: 'SHA256', hash: headerSha256 } } }
}

async function runFullCandidateGate(preparation, output) {
  const { tsImport } = await import(pathToFileURL(requireDesktop.resolve('tsx/esm/api')).href)
  const { runRustOfflineCandidateProtocol } = await tsImport(pathToFileURL(path.join(desktop, 'test/helpers/rust-offline-candidate-protocol.ts')).href, import.meta.url)
  const protocol = await runRustOfflineCandidateProtocol({ resourcesDirectory: preparation.candidateIdentity.resourcesDirectory,
    expectedManifestSha256: preparation.candidateIdentity.manifestSha256, evidenceDirectory: path.join(output, 'protocol') })
  const rawDefault = await runPackagedDefault(preparation, output)
  const expectedIdentity = await observeFinalIdentity(preparation)
  const defaultNode = { executable: rawDefault.executable, args: rawDefault.argv, profileDirectory: rawDefault.profileDirectory,
    flags: { startupTest: true, coreTestMode: true, uiE2e: true, offline: true }, keychain: 'mock', ready: rawDefault.readyMarkerCount === 1,
    lifecycle: rawDefault.lifecycle, exit: { code: rawDefault.electronExit.code, signal: rawDefault.electronExit.signal },
    forcedCleanup: rawDefault.forcedCleanup, log: rawDefault.log,
    observation: { path: path.join(output, 'packaged-default-node.json'), sha256: await digest(path.join(output, 'packaged-default-node.json')) } }
  const report = { schemaVersion: 1, task: 'RUST-011', state: 'PASS', sourceCommit: preparation.sourceCommit,
    sourceSha256: preparation.source.sha256, candidateIdentity: preparation.candidateIdentity, verification: expectedIdentity.verification,
    protocol, defaultNode, ownerAcceptance: 'NOT_RUN', packagedRustMainCoreRoute: 'NOT_IN_SCOPE', productionDefault: 'Node',
    installation: 'NOT_RUN', realServices: 'NOT_RUN', implicitDownload: false }
  const { acceptRustOfflineCandidateEvidence } = await tsImport(pathToFileURL(path.join(desktop, 'test/helpers/rust-offline-candidate-evidence.ts')).href, import.meta.url)
  await save(path.join(output, 'candidate-expected-identity.json'), expectedIdentity)
  await save(path.join(output, 'candidate-uncertified-input.json'), { state: 'UNACCEPTED_INPUT', report })
  // 先验收真实输入，再落最终PASS；失败不补写成功收据。
  acceptRustOfflineCandidateEvidence(report, expectedIdentity)
  const reportPath = path.join(output, 'candidate-report.json')
  await save(reportPath, report)
  const typecheck = await runGateCheck(output, 'candidate-typecheck', process.execPath,
    [requireDesktop.resolve('typescript/bin/tsc'), '--noEmit', '-p', path.join(desktop, 'e2e/rust-offline-candidate.tsconfig.json')])
  const tests = await runGateCheck(output, 'candidate-behavior', process.execPath,
    ['--import', path.join(desktop, 'node_modules/tsx/dist/loader.mjs'), '--test', '--test-concurrency=1',
      path.join(desktop, 'test/rust-core/rust-native-package.test.ts'), path.join(desktop, 'test/rust-core/rust-core-resource.test.ts'),
      path.join(desktop, 'test/rust-core/rust-offline-candidate-protocol.test.ts'), path.join(desktop, 'test/rust-core/rust-offline-candidate-evidence.test.ts')],
    { MUSIC_BRIDGE_RUST_RESOURCE_TEST_BINARY: preparation.unsignedBinary.path,
      MUSIC_BRIDGE_RUST_OFFLINE_CANDIDATE_REPORT: reportPath,
      MUSIC_BRIDGE_RUST_OFFLINE_CANDIDATE_EXPECTED_IDENTITY: path.join(output, 'candidate-expected-identity.json') })
  const content = await readFile(tests.log, 'utf8')
  assert.match(content, /# fail 0\b/); assert.match(content, /# skipped 0\b/); assert.match(content, /# cancelled 0\b/)
  assert.deepEqual(await sourceIdentity(), preparation.source)
  const finalIdentity = await observeFinalIdentity(preparation)
  assert.deepEqual(finalIdentity, expectedIdentity)
  const gate = { schemaVersion: 1, task: 'RUST-011', state: 'PASS', report: { path: reportPath, sha256: await digest(reportPath) },
    sourceSha256: preparation.source.sha256, checks: [typecheck, tests], ownerAcceptance: 'NOT_RUN', forcedCleanup: false }
  await save(path.join(output, 'candidate-gate-manifest.json'), gate)
  return { reportPath, reportSha256: await digest(reportPath), expectedIdentityPath: path.join(output, 'candidate-expected-identity.json'),
    gateManifestPath: path.join(output, 'candidate-gate-manifest.json'), gateManifestSha256: await digest(path.join(output, 'candidate-gate-manifest.json')) }
}

async function main() {
  const [output, binaryPath, mode] = process.argv.slice(2)
  assert.ok(output && binaryPath && (mode === undefined && process.argv.length === 4 || mode === '--prepare-only' && process.argv.length === 5),
    '用法：node scripts/ci/verify-rust-offline-candidate.mjs <全新外置输出目录> <外置Rust构建二进制> [--prepare-only]')
  isolateToolEnvironment()
  const prepared = await prepareCandidate(output, binaryPath)
  if (mode === '--prepare-only') console.log(JSON.stringify({ state: prepared.state, evidence: path.join(output, 'candidate-preparation.json'), candidate: prepared.candidateIdentity.appPath }))
  else console.log(JSON.stringify({ state: 'PASS', ...await runFullCandidateGate(prepared, output), candidate: prepared.candidateIdentity.appPath }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(`RUST-011_GATE_FAILED: ${error.message}`)
    if (ownedOutput) {
      try { await save(path.join(ownedOutput, 'candidate-failure.json'), { schemaVersion: 1, task: 'RUST-011', state: 'FAIL',
        reason: error.message, ownerAcceptance: 'NOT_RUN', packagedRustMainCoreRoute: 'NOT_IN_SCOPE' }) } catch { /* 原证据不覆盖。 */ }
    }
    // 构建工具会注册自己的退出处理，显式失败码不能被库改回零。
    process.exit(1)
  })
}

export { prepareCandidate, runPackagedDefault, observeFinalIdentity, runFullCandidateGate, sourceIdentity, treeIdentity }
