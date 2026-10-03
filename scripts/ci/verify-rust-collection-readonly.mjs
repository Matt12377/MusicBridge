import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRustResourceManifest, validateRustNativeDirectory, stageRustNativeResource } from '../../apps/desktop/scripts/rust-native-package.mjs'
import { runCollectionReadonlyCandidate } from '../../apps/desktop/scripts/collection-readonly-runtime.mjs'
import { captureNativeRust, verifyNativeRustPackage } from '../../apps/desktop/scripts/native-rust-package.mjs'
import { treeIdentity } from './verify-rust-offline-candidate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const external = '/Volumes/LifeWeave/Developer/CommandLine'
const requireDesktop = createRequire(path.join(desktop, 'package.json'))
const kinds = ['default-node', 'node-controls', 'rust-controls', 'pin-rejected']
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
async function runCheck(output, name, executable, argv, extraEnv = {}, cwd = root) {
  const log = path.join(output, name + '.log'), handle = await open(log, 'wx', 0o600), start = performance.now()
  let code, signal, failure = null, forcedCleanup = false, killTimer
  try {
    await handle.write(JSON.stringify({ executable, argv, cwd }) + '\n')
    const child = spawn(executable, argv, { cwd, env: { ...process.env, ...extraEnv }, shell: false, stdio: ['ignore', handle.fd, handle.fd] })
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
  const files = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps', 'packages', 'native/rust-core', 'scripts', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.gitignore']).split('\0').filter(Boolean).sort()
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
  const originalAssets = await originalAssetIdentity(asar, asarPath)
  return { originalAssets, candidateIdentity, verification: { platform: 'darwin', arch: 'arm64', nativeSignature: { verified: true, adHoc: true, cdHash: native.cdHash },
    bundleSignature: { verified: true, adHoc: true, cdHash: candidateIdentity.bundleCDHash }, asarIntegrity: { algorithm: 'SHA256', hash: headerSha256 } }, compile }
}

async function originalAssetIdentity(asar, archive) {
  const assets = asar.listPackage(archive).map(file => file.replace(/^\//, ''))
    .filter(file => /^(?:dist\/preload|dist\/renderer)\//.test(file))
  const files = []
  for (const file of assets.sort()) {
    const stat = asar.statFile(archive, file)
    if (!stat.files) files.push({ path: file, sha256: sha(asar.extractFile(archive, file)) })
  }
  const tracked = ['apps/desktop/src/main/command-outbox-service.ts', 'apps/desktop/src/main/command-outbox-store.ts',
    'apps/desktop/src/main/command-outbox-ipc.ts', 'apps/desktop/src/main/command-outbox-executor.ts',
    'apps/desktop/src/main/dataset-owner-entry.ts', 'apps/desktop/src/main/dataset-owner-bootstrap.ts',
    'packages/bridge-core/src/collection/dataset-owner-worker.ts', 'packages/bridge-core/src/collection/dataset-owner-client.ts',
    'packages/bridge-core/src/collection/dataset-owner-protocol.ts', 'packages/bridge-core/src/collection/dataset-domain.ts'].sort()
  const sources = []
  for (const file of tracked) {
    const blob = spawnSync('git', ['show', 'e35ad579ef276075d09d0b52fc6bb8158c418b26:' + file], { cwd: root, encoding: null, maxBuffer: 32 * 1024 * 1024 })
    assert.equal(blob.status, 0); assert.equal(blob.error, undefined)
    const sourceSha256 = await digest(path.join(root, file))
    assert.equal(sourceSha256, sha(blob.stdout), '原Node作者与Main outbox源码不得随可选读取改变')
    sources.push({ path: file, sha256: sourceSha256 })
  }
  return { sources, asar: files }
}

async function prepare(output, binaryPath) {
  const storage = await preflight(output, binaryPath), source = await sourceIdentity(), sourceCommit = command('git', ['rev-parse', 'HEAD']).trim()
  command('git', ['merge-base', '--is-ancestor', 'e35ad579ef276075d09d0b52fc6bb8158c418b26', sourceCommit])
  assert.equal(command('git', ['branch', '--show-current']).trim(), 'codex/rust-core-014-user-optional-readonly-controls', '只能在本任务隔离分支运行')
  const pnpm = path.join(external, 'Caches/corepack/v1/pnpm/10.17.1/bin/pnpm.cjs')
  assert.equal(command(process.execPath, [pnpm, '--version']).trim(), '10.17.1')
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
  const fixedNative = path.join(desktop, 'native/rust-core/darwin-arm64')
  await mkdir(path.join(desktop, 'native'), { recursive: true, mode: 0o755 })
  try {
    await lstat(fixedNative)
    await validateRustNativeDirectory({ directory: fixedNative, expectedManifestSha256: manifestSha256 })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await stageRustNativeResource({ sourceDirectory: nativeDirectory, resourcesDirectory: path.join(desktop, 'native'), expectedManifestSha256: manifestSha256 })
  }
  assert.equal((await captureNativeRust(desktop)).manifestSha256, manifestSha256)
  const productionBuild = await runCheck(output, 'fresh-production-build', process.execPath, [pnpm, 'run', 'build'])
  assert.deepEqual(await sourceIdentity(), source)
  const distIdentity = await treeIdentity(path.join(desktop, 'dist'))
  const pkg = await json(path.join(desktop, 'package.json')), electronPackage = requireDesktop.resolve('electron/package.json')
  const electronDist = path.join(path.dirname(electronPackage), 'dist'), electronFiles = await treeIdentity(electronDist)
  assert.equal((await json(electronPackage)).version, '43.4.0'); assert.equal(electronFiles.length, 275)
  assert.equal((await json(requireDesktop.resolve('electron-builder/package.json'))).version, '26.15.3')
  const productionConfigurationSha256 = await digest(path.join(desktop, 'package.json'))
  const productionBeforePackSha256 = await digest(path.join(desktop, 'scripts/native-rust-package.mjs'))
  const packages = {}, compilations = [], { build, Platform, Arch } = requireDesktop('electron-builder')
  const asar = requireDesktop(requireDesktop.resolve('@electron/asar', { paths: [path.dirname(requireDesktop.resolve('electron-builder'))] }))
  const originalMain = path.join(output, 'production-main-preserved')
  let mainPreserved = false
  try {
    for (const kind of kinds) {
      const dir = path.join(output, kind); await mkdir(dir, { mode: 0o700 })
      const compile = { diagnostics: kind !== 'default-node', coreEntry: 'core-entry.ts',
        manifestPin: kind === 'pin-rejected' ? '0'.repeat(64) : manifestSha256,
        snapshotProfile: 'v2-2000', defaultEnabled: false,
        probeExpectation: kind === 'default-node' ? null : kind === 'node-controls' ? 'node' : kind === 'rust-controls' ? 'rust' : 'pin' }
      if (compile.diagnostics) {
        const compiledMain = path.join(dir, 'compiled-main'), buildConfig = path.join(dir, 'literal-build-config.mjs')
        const configSource = `import { createCollectionReadonlyBuildConfiguration } from ${JSON.stringify(pathToFileURL(path.join(desktop, 'e2e/collection-readonly.vite.config.mjs')).href)};\nexport default await createCollectionReadonlyBuildConfiguration(${JSON.stringify({ probeExpectation: compile.probeExpectation, manifestPin: compile.manifestPin, outDir: compiledMain })});\n`
        await writeFile(buildConfig, configSource, { flag: 'wx', mode: 0o600 })
        const viteCli = path.join(path.dirname(requireDesktop.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
        const result = await runCheck(dir, 'compile-fixed-entry', process.execPath, [viteCli, 'build', '--config', buildConfig, '--mode', 'production'])
        compilations.push({ kind, compile, config: { path: buildConfig, sha256: await digest(buildConfig) }, result, files: await treeIdentity(compiledMain) })
        if (!mainPreserved) { await rename(path.join(desktop, 'dist/main'), originalMain); mainPreserved = true }
        await cp(compiledMain, path.join(desktop, 'dist/main'), { recursive: true, errorOnExist: true, force: false })
      }
      const packagedDist = await treeIdentity(path.join(desktop, 'dist'))
      const configuration = { extends: null, appId: 'com.musicbridge.rust.controls.' + kind, productName: 'MusicBridge Rust Controls ' + kind,
        electronVersion: '43.4.0', electronDist, directories: { output: path.join(dir, 'package'), buildResources: path.join(desktop, 'build') },
        files: pkg.build.files, asar: true, npmRebuild: false, nodeGypRebuild: false, mac: { ...pkg.build.mac, target: ['dir'], identity: null },
        electronFuses: pkg.build.electronFuses, extraResources: [{ from: fixedNative, to: 'rust-core/darwin-arm64', filter: ['manifest.json', 'bin/musicbridge-rust-core'] }] }
      await save(path.join(dir, 'configuration.json'), configuration)
      await build({ projectDir: desktop, config: { ...configuration, beforePack: async context => {
        assert.equal(context.electronPlatformName, 'darwin'); assert.equal(context.arch, Arch.arm64)
        assert.equal(await verifyNativeRustPackage(desktop), fixedNative)
        await validateRustNativeDirectory({ directory: fixedNative, expectedManifestSha256: manifestSha256 })
      } }, targets: Platform.MAC.createTarget(['dir'], Arch.arm64) })
      const appPath = path.join(dir, 'package/mac-arm64', configuration.productName + '.app')
      const bundleLog = command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', path.join(desktop, 'build/entitlements.mac.plist'), appPath])
      await writeFile(path.join(dir, 'bundle-signing.log'), bundleLog, { flag: 'wx', mode: 0o600 })
      packages[kind] = await observePackage(appPath, manifestSha256, compile)
      if (kind !== 'default-node') assert.deepEqual(packages[kind].originalAssets, packages['default-node'].originalAssets, '候选全部原Renderer/preload/outbox资产须保持默认身份')
      const archive = packages[kind].candidateIdentity.asar.path
      for (const entry of packagedDist) {
        assert.equal(entry.kind, 'file')
        if (!entry.path.endsWith('.map')) assert.equal(sha(asar.extractFile(archive, 'dist/' + entry.path)), entry.sha256)
      }
      assert.equal(asar.listPackage(archive).some(file => /^\/(?:e2e|test|scripts)\//.test(file) || /private-rust.*wrapper|rust-collection-human-session/.test(file)), false)
      const mainText = packagedDist.filter(entry => entry.path.startsWith('main/') && entry.path.endsWith('.js'))
        .map(entry => asar.extractFile(archive, 'dist/' + entry.path).toString()).join('\n')
      assert.equal(mainText.includes('RUST014_EVIDENCE '), compile.diagnostics, '默认诊断必须被编译删除，候选流程必须确实进入Main')
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
  assert.equal(await digest(path.join(desktop, 'scripts/native-rust-package.mjs')), productionBeforePackSha256)
  assert.deepEqual(await sourceIdentity(), source)
  const preparation = { schemaVersion: 1, task: 'RUST-014', state: 'PREPARED_NOT_RUNTIME_PASS', sourceCommit, source, storage, productionBuild, distIdentity, rustInputs, rustSourceSha256,
    unsignedBinary: { path: binaryPath, sha256: await digest(binaryPath) }, manifestSha256, packages, compilations, electronFiles, productionConfigurationSha256, productionBeforePackSha256 }
  await save(path.join(output, 'preparation.json'), preparation)
  return preparation
}


async function captureClosedSqlite(runKey, evidenceDirectory, evidence) {
  const directory = path.join(evidenceDirectory, 'closed-sqlite')
  const check = await runCheck(evidenceDirectory, 'closed-sqlite-reference', '/usr/bin/python3', [
    path.join(desktop, 'scripts/collection-readonly-sqlite.py'), evidence.path, runKey, directory,
  ])
  const referencePath = path.join(directory, 'reference.json')
  const value = await json(referencePath)
  assert.equal(value.runKey, runKey)
  assert.equal(value.runtimeEvidence.sha256, evidence.sha256)
  return { artifact: { path: referencePath, sha256: await digest(referencePath), bytes: (await lstat(referencePath)).size }, value, check }
}
async function gate(preparation, output) {
  const runs = {}, expectedRuns = {}, expectedPackages = {}, sqlStages = { node: [], rust: [] }, sqlChecks = []
  const specifications = [
    { key: 'default-node', kind: 'default-node' },
    { key: 'node-fresh', kind: 'node-controls' }, { key: 'node-cold', kind: 'node-controls', prior: 'node-fresh' },
    { key: 'rust-fresh', kind: 'rust-controls' }, { key: 'rust-cold', kind: 'rust-controls', prior: 'rust-fresh' },
    { key: 'pin-rejected', kind: 'pin-rejected' },
  ]
  for (const run of specifications) {
    const packaged = preparation.packages[run.kind]
    const evidenceDirectory = path.join(output, 'runs', run.key)
    const launch = run.prior ? { type: 'cold', priorReceiptPath: runs[run.prior].evidence.path, priorReceiptSha256: runs[run.prior].evidence.sha256 } : { type: 'fresh' }
    const receipt = await runCollectionReadonlyCandidate({ executable: packaged.candidateIdentity.executable,
      expectedExecutableSha256: packaged.candidateIdentity.executableSha256, evidenceDirectory, kind: run.kind, launch })
    const file = path.join(evidenceDirectory, 'runtime-evidence.json')
    const evidence = { path: file, sha256: await digest(file), bytes: (await lstat(file)).size }
    assert.deepEqual(await json(file), receipt)
    runs[run.key] = { receipt, evidence }; expectedRuns[run.key] = evidence
    if (run.key.startsWith('node-') || run.key.startsWith('rust-')) {
      const reference = await captureClosedSqlite(run.key, evidenceDirectory, evidence)
      sqlStages[run.key.startsWith('node-') ? 'node' : 'rust'].push(reference.value)
      sqlChecks.push(reference.check)
    }
    const current = await observePackage(packaged.candidateIdentity.appPath, preparation.manifestSha256, packaged.compile)
    assert.deepEqual(current, packaged)
  }
  const sqliteReferences = {}
  for (const kind of ['node', 'rust']) {
    const file = path.join(output, kind + '-closed-sqlite-reference.json')
    await save(file, { schemaVersion: 1, task: 'RUST-014', kind, stages: sqlStages[kind] })
    sqliteReferences[kind] = { path: file, sha256: await digest(file), bytes: (await lstat(file)).size }
  }
  for (const kind of kinds) {
    expectedPackages[kind] = await observePackage(preparation.packages[kind].candidateIdentity.appPath, preparation.manifestSha256, preparation.packages[kind].compile)
    assert.deepEqual(expectedPackages[kind], preparation.packages[kind])
  }
  assert.deepEqual(await sourceIdentity(), preparation.source)
  const { tsImport } = await import(pathToFileURL(requireDesktop.resolve('tsx/esm/api')).href)
  const report = { schemaVersion: 1, task: 'RUST-014', state: 'PASS', baseCommit: 'e35ad579ef276075d09d0b52fc6bb8158c418b26',
    sourceCommit: preparation.sourceCommit, sourceSha256: preparation.source.sha256, packages: preparation.packages, runs, sqliteReferences,
    productionDefault: 'Node', businessDatabaseWriter: 'Node', mainOutboxWriter: 'Main', rendererFullDtoObservation: 'NOT_INDEPENDENTLY_OBSERVED',
    ownerAcceptance: 'NOT_RUN', realServices: 'NOT_RUN', installation: 'NOT_RUN', push: 'NOT_RUN' }
  const expected = { baseCommit: report.baseCommit, sourceCommit: report.sourceCommit, sourceSha256: report.sourceSha256,
    packages: expectedPackages, runs: expectedRuns, sqliteReferences }
  await save(path.join(output, 'expected-identity.json'), expected)
  await save(path.join(output, 'uncertified-input.json'), { state: 'UNACCEPTED_INPUT', report })
  const evidenceHelper = await tsImport(pathToFileURL(path.join(desktop, 'test/helpers/collection-readonly-evidence.ts')).href, import.meta.url)
  evidenceHelper.acceptCollectionReadonlyEvidence(report, expected)
  const reportPath = path.join(output, 'collection-readonly-report.json'); await save(reportPath, report)
  const typecheck = await runCheck(output, 'collection-readonly-typecheck', process.execPath,
    [requireDesktop.resolve('vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', path.join(desktop, 'e2e/collection-readonly.tsconfig.json')])
  const testFiles = [path.join(desktop, 'test/startup-test-config.test.ts'), path.join(desktop, 'test/native-rust-package.test.ts'), path.join(desktop, 'test/native-output-device-package.test.ts')]
  for (const directory of [path.join(desktop,'test'),path.join(desktop,'test/rust-core')]) {
    for (const file of (await readdir(directory)).sort()) {
      if (/^(?:collection-readonly-).*\.test\.ts$/.test(file)) testFiles.push(path.join(directory, file))
    }
  }
  assert.ok(testFiles.length >= 7, '作者专项不得漏入实际Gate')
  const tests = await runCheck(output, 'collection-readonly-behavior', process.execPath, ['--import', path.join(desktop, 'node_modules/tsx/dist/loader.mjs'), '--test', '--test-concurrency=1', ...testFiles], {
    MUSIC_BRIDGE_COLLECTION_READONLY_REPORT: reportPath,
    MUSIC_BRIDGE_COLLECTION_READONLY_EXPECTED_IDENTITY: path.join(output, 'expected-identity.json'),
  }, desktop)
  const tap = await readFile(tests.log, 'utf8')
  assert.match(tap, /# fail 0\b/); assert.match(tap, /# skipped 0\b/); assert.match(tap, /# cancelled 0\b/)
  assert.deepEqual(await sourceIdentity(), preparation.source)
  for (const kind of kinds) assert.deepEqual(await observePackage(expectedPackages[kind].candidateIdentity.appPath, preparation.manifestSha256, expectedPackages[kind].compile), expectedPackages[kind])
  const result = { schemaVersion: 1, task: 'RUST-014', state: 'PASS', sourceSha256: preparation.source.sha256,
    report: { path: reportPath, sha256: await digest(reportPath), bytes: (await lstat(reportPath)).size }, sqliteReferences,
    checks: [...sqlChecks, typecheck, tests], ownerAcceptance: 'NOT_RUN', rendererFullDtoObservation: 'NOT_INDEPENDENTLY_OBSERVED', forcedCleanup: false }
  await save(path.join(output, 'gate-manifest.json'), result)
  return result
}
async function main() {
  const [output, binaryPath] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, '用法：node scripts/ci/verify-rust-collection-readonly.mjs <全新外置目录> <外置Rust二进制>')
  isolate()
  const prepared = await prepare(output, binaryPath)
  console.log(JSON.stringify(await gate(prepared, output)))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(`RUST-014_GATE_FAILED: ${error.message}`)
    if (ownedOutput) try { await save(path.join(ownedOutput, 'failure.json'), { schemaVersion: 1, task: 'RUST-014', state: 'FAIL', reason: error.message }) } catch { /* 旧失败现场保留。 */ }
    process.exit(1)
  })
}
export { prepare, gate, sourceIdentity, observePackage, runCheck, originalAssetIdentity }
