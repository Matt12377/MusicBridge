import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRustResourceManifest, validateRustNativeDirectory } from '../../apps/desktop/scripts/rust-native-package.mjs'
import { runRustPackagedRouteCandidate } from '../../apps/desktop/scripts/rust-packaged-route-runtime.mjs'
import { treeIdentity } from './verify-rust-offline-candidate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const external = '/Volumes/LifeWeave/Developer/CommandLine'
const requireDesktop = createRequire(path.join(desktop, 'package.json'))
const kinds = ['default-node', 'node-diagnostic', 'rust-diagnostic', 'pin-rejected']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = async file => sha(await readFile(file))
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
let ownedOutput

function isolate() {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'DEV_BUILD_ROOT', 'DEV_CACHE_ROOT',
    'COREPACK_HOME', 'npm_config_cache', 'npm_config_store_dir', 'ELECTRON_CACHE', 'electron_config_cache', 'XDG_CACHE_HOME', 'NODE_COMPILE_CACHE', 'CARGO_HOME', 'CARGO_TARGET_DIR'])
  for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key]
  process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
}
function command(executable, argv) {
  const result = spawnSync(executable, argv, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  assert.equal(result.error, undefined); assert.equal(result.status, 0, `命令失败：${executable}`); assert.equal(result.signal, null)
  return (result.stdout ?? '') + (result.stderr ?? '')
}
async function runCheck(output, name, executable, argv, extraEnv = {}) {
  const log = path.join(output, name + '.log'), handle = await open(log, 'wx', 0o600), start = performance.now()
  let code, signal, failure = null, forcedCleanup = false, killTimer
  try {
    await handle.write(JSON.stringify({ executable, argv, cwd: root }) + '\n')
    const child = spawn(executable, argv, { cwd: root, env: { ...process.env, ...extraEnv }, shell: false, stdio: ['ignore', handle.fd, handle.fd] })
    child.once('error', error => { failure = error.message })
    const timer = setTimeout(() => { forcedCleanup = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 8000) }, 180_000)
    ;({ code, signal } = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))))
    clearTimeout(timer); clearTimeout(killTimer)
  } finally { await handle.close() }
  const receipt = { name, executable, argv, code, signal, failure, forcedCleanup, durationMs: performance.now() - start, log, logSha256: await digest(log) }
  await save(path.join(output, name + '.json'), receipt)
  assert.equal(code, 0, `检查失败：${name}`); assert.equal(signal, null); assert.equal(failure, null); assert.equal(forcedCleanup, false)
  return receipt
}
async function sourceIdentity() {
  const files = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps', 'packages', 'native/rust-core', 'scripts', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']).split('\0').filter(Boolean).sort()
  const entries = []
  for (const file of [...new Set(files)]) entries.push({ path: file, sha256: await digest(path.join(root, file)) })
  return { entries, sha256: sha(entries.map(item => item.path + '\0' + item.sha256 + '\n').join('')) }
}
async function preflight(output, binaryPath) {
  const raw = spawnSync('/usr/sbin/diskutil', ['info', '-plist', '/Volumes/LifeWeave'], { encoding: 'utf8' })
  assert.equal(raw.status, 0)
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: raw.stdout, encoding: 'utf8' })
  assert.equal(converted.status, 0)
  const disk = JSON.parse(converted.stdout)
  assert.equal(disk.MountPoint, '/Volumes/LifeWeave'); assert.equal(disk.Internal, false); assert.equal(disk.WritableVolume, true)
  assert.notEqual((await lstat('/Volumes/LifeWeave')).dev, (await lstat('/')).dev)
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.match(process.versions.node, /^22\./)
  for (const file of [output, binaryPath]) assert.ok(path.resolve(file) === file && file.startsWith(external + '/tmp/'))
  assert.equal(await realpath(path.dirname(output)), path.dirname(output)); assert.equal(await realpath(binaryPath), binaryPath)
  assert.ok((await lstat(binaryPath)).isFile()); assert.equal(process.env.TMPDIR, path.join(output, 'tmp'))
  await mkdir(output, { mode: 0o700 }); ownedOutput = output; await mkdir(path.join(output, 'tmp'), { mode: 0o700 })
  return { mount: disk.MountPoint, internal: disk.Internal, writable: disk.WritableVolume, device: disk.DeviceIdentifier }
}

async function observePackage(appPath, manifestSha256, compile) {
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const display = command('/usr/bin/codesign', ['--display', '--verbose=4', appPath]); assert.match(display, /^Signature=adhoc$/m)
  const resourcesDirectory = path.join(appPath, 'Contents/Resources')
  const native = await validateRustNativeDirectory({ directory: path.join(resourcesDirectory, 'rust-core/darwin-arm64'), expectedManifestSha256: manifestSha256 })
  assert.equal(command('/usr/bin/lipo', ['-archs', native.binaryPath]).trim(), 'arm64')
  const { getCurrentFuseWire } = requireDesktop(requireDesktop.resolve('@electron/fuses', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const asar = requireDesktop(requireDesktop.resolve('@electron/asar', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const asarPath = path.join(resourcesDirectory, 'app.asar'), plistPath = path.join(appPath, 'Contents/Info.plist')
  const headerSha256 = sha(asar.getRawHeader(asarPath).headerString)
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]))
  assert.deepEqual(plist.ElectronAsarIntegrity['Resources/app.asar'], { algorithm: 'SHA256', hash: headerSha256 })
  const executable = path.join(appPath, 'Contents/MacOS', plist.CFBundleExecutable)
  const candidateIdentity = { appPath, resourcesDirectory, executable, executableSha256: await digest(executable), manifestSha256, native,
    asar: { path: asarPath, sha256: await digest(asarPath), headerSha256, main: JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).main,
      defaultEntries: ['index.js', 'core.js'].map(name => ({ path: 'dist/main/' + name, sha256: sha(asar.extractFile(asarPath, 'dist/main/' + name)) })) },
    fuses: await getCurrentFuseWire(appPath), infoPlistSha256: await digest(plistPath), bundleCDHash: display.match(/^CDHash=([a-f0-9]{40})$/m)?.[1], bundleFiles: await treeIdentity(appPath) }
  assert.match(candidateIdentity.bundleCDHash, /^[a-f0-9]{40}$/)
  assert.deepEqual(candidateIdentity.fuses, { 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48, 8: 49, version: '1' })
  return { candidateIdentity, verification: { platform: 'darwin', arch: 'arm64', nativeSignature: { verified: true, adHoc: true, cdHash: native.cdHash },
    bundleSignature: { verified: true, adHoc: true, cdHash: candidateIdentity.bundleCDHash }, asarIntegrity: { algorithm: 'SHA256', hash: headerSha256 } }, compile }
}

async function prepare(output, binaryPath) {
  const storage = await preflight(output, binaryPath), source = await sourceIdentity(), sourceCommit = command('git', ['rev-parse', 'HEAD']).trim()
  command('git', ['merge-base', '--is-ancestor', '13b2a14f03831ed7a98bdc5d1b9ab288644fc502', sourceCommit])
  assert.equal(command('git', ['branch', '--show-current']).trim(), 'codex/rust-core-012-packaged-readonly-route', '只能在本任务隔离分支运行')
  const pnpm = path.join(external, 'Caches/corepack/v1/pnpm/10.17.1/bin/pnpm.cjs')
  assert.equal(command(process.execPath, [pnpm, '--version']).trim(), '10.17.1')
  const productionBuild = await runCheck(output, 'fresh-production-build', process.execPath, [pnpm, 'run', 'build'])
  assert.deepEqual(await sourceIdentity(), source)
  const distIdentity = await treeIdentity(path.join(desktop, 'dist'))
  const rustInputs = source.entries.filter(item => item.path.startsWith('native/rust-core/'))
  const rustSourceSha256 = sha(rustInputs.map(item => item.path + '\0' + item.sha256 + '\n').join(''))
  const nativeDirectory = path.join(output, 'native-resource/darwin-arm64')
  await mkdir(path.join(nativeDirectory, 'bin'), { recursive: true, mode: 0o755 })
  const signedBinary = path.join(nativeDirectory, 'bin/musicbridge-rust-core')
  await copyFile(binaryPath, signedBinary); await chmod(signedBinary, 0o755)
  const signing = command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', signedBinary])
  await writeFile(path.join(output, 'native-signing.log'), signing, { flag: 'wx', mode: 0o600 })
  const manifest = await createRustResourceManifest({ binaryPath: signedBinary, sourceCommit, sourceSha256: rustSourceSha256 })
  await save(path.join(nativeDirectory, 'manifest.json'), manifest); await chmod(path.join(nativeDirectory, 'manifest.json'), 0o644)
  const manifestSha256 = await digest(path.join(nativeDirectory, 'manifest.json'))
  await validateRustNativeDirectory({ directory: nativeDirectory, expectedManifestSha256: manifestSha256 })
  const pkg = await json(path.join(desktop, 'package.json')), electronPackage = requireDesktop.resolve('electron/package.json')
  const electronDist = path.join(path.dirname(electronPackage), 'dist'), electronFiles = await treeIdentity(electronDist)
  assert.equal((await json(electronPackage)).version, '43.4.0'); assert.equal(electronFiles.length, 275)
  assert.equal((await json(requireDesktop.resolve('electron-builder/package.json'))).version, '26.15.3')
  const productionConfigurationSha256 = await digest(path.join(desktop, 'package.json'))
  const productionBeforePackSha256 = await digest(path.join(desktop, 'scripts/native-converter-package.mjs'))
  const packages = {}, compilations = [], { build, Platform, Arch } = requireDesktop('electron-builder')
  const asar = requireDesktop(requireDesktop.resolve('@electron/asar', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const originalMain = path.join(output, 'production-main-preserved')
  let mainPreserved = false
  try {
    for (const kind of kinds) {
      const dir = path.join(output, kind); await mkdir(dir, { mode: 0o700 })
      const compile = { diagnostics: kind !== 'default-node', coreEntry: kind === 'default-node' ? 'core-entry.ts' : kind === 'node-diagnostic' ? 'packaged-node-core-entry.ts' : 'packaged-rust-core-entry.ts',
        manifestPin: kind === 'rust-diagnostic' ? manifestSha256 : kind === 'pin-rejected' ? '0'.repeat(64) : null, snapshotProfile: ['rust-diagnostic', 'pin-rejected'].includes(kind) ? 'v2-2000' : null }
      if (compile.diagnostics) {
        const compiledMain = path.join(dir, 'compiled-main'), buildConfig = path.join(dir, 'literal-build-config.mjs')
        const configSource = `import { createPackagedRouteBuildConfiguration } from ${JSON.stringify(pathToFileURL(path.join(desktop, 'e2e/rust-packaged-route.vite.config.mjs')).href)};\nexport default await createPackagedRouteBuildConfiguration(${JSON.stringify({ coreEntry: compile.coreEntry, manifestPin: compile.manifestPin, outDir: compiledMain })});\n`
        await writeFile(buildConfig, configSource, { flag: 'wx', mode: 0o600 })
        const viteCli = path.join(path.dirname(requireDesktop.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
        const result = await runCheck(dir, 'compile-fixed-entry', process.execPath, [viteCli, 'build', '--config', buildConfig, '--mode', 'production'])
        compilations.push({ kind, compile, config: { path: buildConfig, sha256: await digest(buildConfig) }, result, files: await treeIdentity(compiledMain) })
        if (!mainPreserved) { await rename(path.join(desktop, 'dist/main'), originalMain); mainPreserved = true }
        await cp(compiledMain, path.join(desktop, 'dist/main'), { recursive: true, errorOnExist: true, force: false })
      }
      const packagedDist = await treeIdentity(path.join(desktop, 'dist'))
      const configuration = { extends: null, appId: 'com.musicbridge.rust.route.' + kind, productName: 'MusicBridge Rust Route ' + kind,
        electronVersion: '43.4.0', electronDist, directories: { output: path.join(dir, 'package'), buildResources: path.join(desktop, 'build') },
        files: pkg.build.files, asar: true, npmRebuild: false, nodeGypRebuild: false, mac: { ...pkg.build.mac, target: ['dir'], identity: null },
        electronFuses: pkg.build.electronFuses, extraResources: [{ from: nativeDirectory, to: 'rust-core/darwin-arm64', filter: ['manifest.json', 'bin/musicbridge-rust-core'] }] }
      await save(path.join(dir, 'configuration.json'), configuration)
      await build({ projectDir: desktop, config: { ...configuration, beforePack: async context => {
        assert.equal(context.electronPlatformName, 'darwin'); assert.equal(context.arch, Arch.arm64)
        await validateRustNativeDirectory({ directory: nativeDirectory, expectedManifestSha256: manifestSha256 })
      } }, targets: Platform.MAC.createTarget(['dir'], Arch.arm64) })
      const appPath = path.join(dir, 'package/mac-arm64', configuration.productName + '.app')
      const bundleLog = command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', path.join(desktop, 'build/entitlements.mac.plist'), appPath])
      await writeFile(path.join(dir, 'bundle-signing.log'), bundleLog, { flag: 'wx', mode: 0o600 })
      packages[kind] = await observePackage(appPath, manifestSha256, compile)
      const archive = packages[kind].candidateIdentity.asar.path
      for (const entry of packagedDist) {
        assert.equal(entry.kind, 'file')
        if (!entry.path.endsWith('.map')) assert.equal(sha(asar.extractFile(archive, 'dist/' + entry.path)), entry.sha256)
      }
      assert.equal(asar.listPackage(archive).some(file => /^\/(?:e2e|test|scripts)\//.test(file) || /private-rust.*wrapper|rust-collection-human-session/.test(file)), false)
      const mainText = packagedDist.filter(entry => entry.path.startsWith('main/') && entry.path.endsWith('.js'))
        .map(entry => asar.extractFile(archive, 'dist/' + entry.path).toString()).join('\n')
      assert.equal(mainText.includes('main.probeComplete'), compile.diagnostics, '默认诊断必须被编译删除，候选流程必须确实进入Main')
      await save(path.join(dir, 'packaged-dist.json'), packagedDist)
      if (compile.diagnostics) await rename(path.join(desktop, 'dist/main'), path.join(dir, 'packaged-main-staging'))
      assert.deepEqual(await treeIdentity(electronDist), electronFiles)
    }
  } finally {
    if (mainPreserved) {
      try { await lstat(path.join(desktop, 'dist/main')); throw new Error('候选构建失败时保留dist/main现场，未覆盖原生产构建。') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await rename(originalMain, path.join(desktop, 'dist/main'))
    }
  }
  assert.deepEqual(await treeIdentity(path.join(desktop, 'dist')), distIdentity)
  assert.equal(await digest(path.join(desktop, 'package.json')), productionConfigurationSha256)
  assert.equal(await digest(path.join(desktop, 'scripts/native-converter-package.mjs')), productionBeforePackSha256)
  assert.deepEqual(await sourceIdentity(), source)
  const preparation = { schemaVersion: 1, task: 'RUST-012', state: 'PREPARED_NOT_RUNTIME_PASS', sourceCommit, source, storage, productionBuild, distIdentity, rustInputs, rustSourceSha256,
    unsignedBinary: { path: binaryPath, sha256: await digest(binaryPath) }, manifestSha256, packages, compilations, electronFiles, productionConfigurationSha256, productionBeforePackSha256 }
  await save(path.join(output, 'preparation.json'), preparation)
  return preparation
}

async function gate(preparation, output) {
  const runs = {}, expectedPackages = {}, expectedRuns = {}
  for (const kind of kinds) {
    const before = preparation.packages[kind], evidenceDirectory = path.join(output, kind, 'runtime')
    const receipt = await runRustPackagedRouteCandidate({ executable: before.candidateIdentity.executable, expectedExecutableSha256: before.candidateIdentity.executableSha256, evidenceDirectory, kind })
    const evidence = { path: path.join(evidenceDirectory, 'runtime-evidence.json'), sha256: await digest(path.join(evidenceDirectory, 'runtime-evidence.json')) }
    runs[kind] = { receipt, evidence }
    assert.deepEqual(await json(evidence.path), receipt)
    expectedRuns[kind] = { path: evidence.path, sha256: await digest(evidence.path) }
    expectedPackages[kind] = await observePackage(before.candidateIdentity.appPath, preparation.manifestSha256, before.compile)
    assert.deepEqual(expectedPackages[kind], before)
  }
  assert.deepEqual(await sourceIdentity(), preparation.source)
  const expected = { sourceCommit: preparation.sourceCommit, sourceSha256: preparation.source.sha256, packages: expectedPackages, runs: expectedRuns }
  const report = { schemaVersion: 1, task: 'RUST-012', state: 'PASS', sourceCommit: preparation.sourceCommit, sourceSha256: preparation.source.sha256, packages: preparation.packages, runs,
    productionDefault: 'Node', soleDatabaseWriter: 'Node', candidateDiagnostics: 'COMPILE_TIME_ONLY', ownerAcceptance: 'NOT_RUN', rendererAcceptance: 'NOT_RUN', realServices: 'NOT_RUN', installation: 'NOT_RUN', push: 'NOT_RUN' }
  await save(path.join(output, 'expected-identity.json'), expected)
  await save(path.join(output, 'uncertified-input.json'), { state: 'UNACCEPTED_INPUT', report })
  const { tsImport } = await import(pathToFileURL(requireDesktop.resolve('tsx/esm/api')).href)
  const { acceptRustPackagedRouteEvidence } = await tsImport(pathToFileURL(path.join(desktop, 'test/helpers/rust-packaged-route-evidence.ts')).href, import.meta.url)
  acceptRustPackagedRouteEvidence(report, expected)
  const reportPath = path.join(output, 'route-report.json'); await save(reportPath, report)
  const typecheck = await runCheck(output, 'route-typecheck', process.execPath, [requireDesktop.resolve('vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', path.join(desktop, 'e2e/rust-packaged-route.tsconfig.json')])
  const tests = await runCheck(output, 'route-behavior', process.execPath, ['--import', path.join(desktop, 'node_modules/tsx/dist/loader.mjs'), '--test', '--test-concurrency=1',
    path.join(desktop, 'test/startup-test-config.test.ts'), path.join(desktop, 'test/rust-core-host.test.ts'), path.join(desktop, 'test/rust-core/packaged-rust-core-bootstrap.test.ts'),
    path.join(desktop, 'test/packaged-route-main-probe.test.ts'), path.join(desktop, 'test/packaged-route-core-observer.test.ts'),
    path.join(desktop, 'test/rust-core/rust-packaged-route-runtime.test.ts'), path.join(desktop, 'test/rust-core/rust-packaged-route-evidence.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-core-utility-options.test.ts'), path.join(root, 'packages/bridge-core/test/rust-core/sidecar-observation.test.ts')],
    { MUSIC_BRIDGE_RUST_RESOURCE_TEST_BINARY: preparation.unsignedBinary.path, MUSIC_BRIDGE_RUST_PACKAGED_ROUTE_REPORT: reportPath, MUSIC_BRIDGE_RUST_PACKAGED_ROUTE_EXPECTED_IDENTITY: path.join(output, 'expected-identity.json') })
  const tap = await readFile(tests.log, 'utf8'); assert.match(tap, /# fail 0\b/); assert.match(tap, /# skipped 0\b/); assert.match(tap, /# cancelled 0\b/)
  assert.deepEqual(await sourceIdentity(), preparation.source)
  for (const kind of kinds) assert.deepEqual(await observePackage(expectedPackages[kind].candidateIdentity.appPath, preparation.manifestSha256, expectedPackages[kind].compile), expectedPackages[kind])
  const result = { schemaVersion: 1, task: 'RUST-012', state: 'PASS', sourceSha256: preparation.source.sha256,
    report: { path: reportPath, sha256: await digest(reportPath) }, checks: [typecheck, tests], ownerAcceptance: 'NOT_RUN', rendererAcceptance: 'NOT_RUN', forcedCleanup: false }
  await save(path.join(output, 'gate-manifest.json'), result)
  return result
}
async function main() {
  const [output, binaryPath] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, '用法：node scripts/ci/verify-rust-packaged-route.mjs <全新外置输出目录> <外置Rust二进制>')
  isolate(); const prepared = await prepare(output, binaryPath)
  console.log(JSON.stringify(await gate(prepared, output)))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(`RUST-012_GATE_FAILED: ${error.message}`)
    if (ownedOutput) try { await save(path.join(ownedOutput, 'failure.json'), { schemaVersion: 1, task: 'RUST-012', state: 'FAIL', reason: error.message }) } catch { /* 保留原失败现场。 */ }
    process.exit(1)
  })
}
export { prepare, gate, sourceIdentity, observePackage }
