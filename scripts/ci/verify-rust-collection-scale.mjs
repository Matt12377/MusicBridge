import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCollectionScaleCandidate } from '../../apps/desktop/scripts/collection-scale-runtime.mjs'
import { captureNativeRust, verifyNativeRustPackage } from '../../apps/desktop/scripts/native-rust-package.mjs'
import { validateRustNativeDirectory } from '../../apps/desktop/scripts/rust-native-package.mjs'
import { treeIdentity } from './verify-rust-offline-candidate.mjs'
import { sourceIdentity, observePackage, runCheck } from './verify-rust-collection-readonly.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const external = '/Volumes/LifeWeave/Developer/CommandLine'
const baseCommit = '906a3841df3424fff05b6071f4342f312d0c7de9'
const requireDesktop = createRequire(path.join(desktop, 'package.json'))
const amounts = [0, 100, 2000, 2001, 5000, 5001]
const kinds = ['default-node', ...amounts.map(value => `scale-${value}`)]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = async file => sha(await readFile(file))
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const artifact = async file => ({ path: file, sha256: await digest(file), bytes: (await lstat(file)).size })
const save = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
let ownedOutput

// 证据全图串改的测试进程单列预算；原应用、请求、关闭及通用检查的期限不变。
const behaviorDeadlineMs = 40 * 60 * 1000
async function runCollectionScaleBehaviorCheck(output, executable, argv, extraEnv = {}, cwd = root, deadlineMs = behaviorDeadlineMs) {
  assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= behaviorDeadlineMs)
  assert.ok(path.isAbsolute(output) && output.startsWith(external + '/tmp/'))
  assert.equal(await realpath(output), output)
  const name = 'collection-scale-behavior'
  const log = path.join(output, name + '.log'), handle = await open(log, 'wx', 0o600), start = performance.now()
  let code, signal, failure = null, timedOut = false, forcedCleanup = false, childPid = null, timer, killTimer
  try {
    await handle.write(JSON.stringify({ executable, argv, cwd, scope: 'complete-evidence-test-process-only', deadlineMs }) + '\n')
    const child = spawn(executable, argv, { cwd, env: { ...process.env, ...extraEnv }, shell: false, stdio: ['ignore', handle.fd, handle.fd] })
    childPid = child.pid ?? null
    child.once('error', error => { failure = error.message })
    timer = setTimeout(() => {
      timedOut = true; forcedCleanup = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 8000)
    }, deadlineMs)
    ;({ code, signal } = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))))
  } finally {
    clearTimeout(timer); clearTimeout(killTimer)
    await handle.close()
  }
  const receipt = { name, executable, argv, code, signal, failure, childPid, scope: 'complete-evidence-test-process-only',
    deadlineMs, timedOut, forcedCleanup, durationMs: performance.now() - start, log, logSha256: await digest(log) }
  await save(path.join(output, name + '.json'), receipt)
  assert.equal(code, 0, '完整证据测试进程必须自然退出0。')
  assert.equal(signal, null); assert.equal(failure, null); assert.equal(timedOut, false); assert.equal(forcedCleanup, false)
  const tap = await readFile(log, 'utf8')
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key =>
    [key, [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))].map(match => Number(match[1]))]))
  for (const key of Object.keys(counts)) assert.equal(counts[key].length, 1, '完整证据测试的最终TAP计数缺失或重复。')
  assert.ok(counts.tests[0] > 0); assert.equal(counts.pass[0], counts.tests[0])
  for (const key of ['fail', 'cancelled', 'skipped']) assert.equal(counts[key][0], 0, '完整证据测试不得失败、取消或跳过。')
  return receipt
}

function isolate() {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'DEV_BUILD_ROOT', 'DEV_CACHE_ROOT',
    'COREPACK_HOME', 'npm_config_cache', 'npm_config_store_dir', 'ELECTRON_CACHE', 'electron_config_cache', 'XDG_CACHE_HOME',
    'NODE_COMPILE_CACHE', 'CARGO_HOME', 'CARGO_TARGET_DIR'])
  for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key]
  process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
}
function command(executable, argv) {
  const result = spawnSync(executable, argv, { cwd: root, encoding: 'utf8', timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  assert.equal(result.error, undefined); assert.equal(result.status, 0, `命令失败：${executable}`); assert.equal(result.signal, null)
  return (result.stdout ?? '') + (result.stderr ?? '')
}
async function preflight(output, binaryPath) {
  const diskXml = command('/usr/sbin/diskutil', ['info', '-plist', '/Volumes/LifeWeave'])
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: diskXml, encoding: 'utf8' })
  assert.equal(converted.status, 0)
  const disk = JSON.parse(converted.stdout)
  assert.equal(disk.MountPoint, '/Volumes/LifeWeave'); assert.equal(disk.Internal, false); assert.equal(disk.WritableVolume, true)
  assert.notEqual((await lstat('/Volumes/LifeWeave')).dev, (await lstat('/')).dev)
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.match(process.versions.node, /^22\./)
  for (const file of [output, binaryPath]) assert.ok(path.resolve(file) === file && file.startsWith(external + '/tmp/'))
  assert.equal(await realpath(path.dirname(output)), path.dirname(output)); assert.equal(await realpath(binaryPath), binaryPath)
  assert.ok((await lstat(binaryPath)).isFile())
  await mkdir(output, { mode: 0o700 }); ownedOutput = output
  await mkdir(path.join(output, 'tmp'), { mode: 0o700 }); process.env.TMPDIR = path.join(output, 'tmp')
  return { mount: disk.MountPoint, internal: disk.Internal, writable: disk.WritableVolume, device: disk.DeviceIdentifier }
}

async function prepare(output, binaryPath) {
  const storage = await preflight(output, binaryPath), source = await sourceIdentity()
  const sourceCommit = command('git', ['rev-parse', 'HEAD']).trim()
  command('git', ['merge-base', '--is-ancestor', baseCommit, sourceCommit])
  assert.equal(command('git', ['branch', '--show-current']).trim(), 'codex/rust-core-015-capacity-cost-validation')
  const pnpm = path.join(external, 'Caches/corepack/v1/pnpm/10.17.1/bin/pnpm.cjs')
  assert.equal(command(process.execPath, [pnpm, '--version']).trim(), '10.17.1')
  const rustInputs = source.entries.filter(item => item.path.startsWith('native/rust-core/'))
  const rustSourceSha256 = sha(rustInputs.map(item => item.path + '\0' + item.sha256 + '\n').join(''))
  const fixedNative = path.join(desktop, 'native/rust-core/darwin-arm64')
  const captured = await captureNativeRust(desktop), manifestSha256 = captured.manifestSha256
  assert.match(manifestSha256 ?? '', /^[0-9a-f]{64}$/)
  const inheritedNative = await validateRustNativeDirectory({ directory: fixedNative, expectedManifestSha256: manifestSha256 })
  assert.equal(inheritedNative.manifest.source.sha256, rustSourceSha256, '复用native必须匹配当前未改Rust源码。')
  command('git', ['merge-base', '--is-ancestor', inheritedNative.manifest.source.commit, sourceCommit])
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
  const originalDist = path.join(output, 'production-dist-preserved')
  let productionPreserved = false
  try {
    for (const kind of kinds) {
      const dir = path.join(output, kind); await mkdir(dir, { mode: 0o700 })
      const compile = { diagnostics: kind !== 'default-node', rendererDiagnostics: kind !== 'default-node', coreEntry: 'core-entry.ts',
        manifestPin: manifestSha256, snapshotProfile: 'v2-2000', defaultEnabled: false,
        modelCount: kind === 'default-node' ? null : Number(kind.slice('scale-'.length)) }
      if (compile.diagnostics) {
        const compiledMain = path.join(dir, 'compiled-main'), compiledRenderer = path.join(dir, 'compiled-renderer')
        const buildConfig = path.join(dir, 'literal-build-config.mjs')
        const configSource = `import { createCollectionScaleBuildConfiguration } from ${JSON.stringify(pathToFileURL(path.join(desktop, 'e2e/collection-scale.vite.config.mjs')).href)};\nexport default await createCollectionScaleBuildConfiguration(${JSON.stringify({ modelCount: compile.modelCount, manifestPin: manifestSha256, mainOutDir: compiledMain, rendererOutDir: compiledRenderer })});\n`
        await writeFile(buildConfig, configSource, { flag: 'wx', mode: 0o600 })
        const viteCli = path.join(path.dirname(requireDesktop.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
        const result = await runCheck(dir, 'compile-fixed-entry', process.execPath, [viteCli, 'build', '--config', buildConfig, '--mode', 'production'], {}, desktop)
        compilations.push({ kind, compile, config: await artifact(buildConfig), result,
          mainFiles: await treeIdentity(compiledMain), rendererFiles: await treeIdentity(compiledRenderer) })
        if (!productionPreserved) { await rename(path.join(desktop, 'dist'), originalDist); productionPreserved = true }
        await cp(originalDist, path.join(desktop, 'dist'), { recursive: true, errorOnExist: true, force: false })
        await rename(path.join(desktop, 'dist/main'), path.join(dir, 'production-main-copy'))
        await rename(path.join(desktop, 'dist/renderer'), path.join(dir, 'production-renderer-copy'))
        await cp(compiledMain, path.join(desktop, 'dist/main'), { recursive: true, errorOnExist: true, force: false })
        await cp(compiledRenderer, path.join(desktop, 'dist/renderer'), { recursive: true, errorOnExist: true, force: false })
      }
      const packagedDist = await treeIdentity(path.join(desktop, 'dist'))
      const configuration = { extends: null, appId: 'com.musicbridge.rust.scale.' + kind, productName: 'MusicBridge Rust Scale ' + kind,
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
      const signing = command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', path.join(desktop, 'build/entitlements.mac.plist'), appPath])
      await writeFile(path.join(dir, 'bundle-signing.log'), signing, { flag: 'wx', mode: 0o600 })
      packages[kind] = await observePackage(appPath, manifestSha256, compile)
      if (compile.diagnostics) {
        assert.deepEqual(packages[kind].originalAssets.sources, packages['default-node'].originalAssets.sources)
        const preload = files => files.filter(file => file.path.startsWith('dist/preload/'))
        assert.deepEqual(preload(packages[kind].originalAssets.asar), preload(packages['default-node'].originalAssets.asar))
      }
      const archive = packages[kind].candidateIdentity.asar.path
      for (const entry of packagedDist) {
        assert.equal(entry.kind, 'file')
        if (!entry.path.endsWith('.map')) assert.equal(sha(asar.extractFile(archive, 'dist/' + entry.path)), entry.sha256)
      }
      assert.equal(asar.listPackage(archive).some(file => /^\/(?:e2e|test|scripts)\//.test(file) || /private-rust.*wrapper|rust-collection-human-session/.test(file)), false)
      const textFor = prefix => packagedDist.filter(entry => entry.path.startsWith(prefix) && entry.path.endsWith('.js'))
        .map(entry => asar.extractFile(archive, 'dist/' + entry.path).toString()).join('\n')
      assert.equal(textFor('main/').includes('RUST015_EVIDENCE '), compile.diagnostics, '默认Main不得包含诊断producer。')
      assert.equal(textFor('renderer/').includes('RUST015_EVIDENCE '), compile.rendererDiagnostics, '默认Renderer不得包含诊断producer。')
      assert.equal(textFor('main/').includes('RUST014_EVIDENCE '), false, '旧26型号诊断driver须编译关闭。')
      await save(path.join(dir, 'packaged-dist.json'), packagedDist)
      if (compile.diagnostics) await rename(path.join(desktop, 'dist'), path.join(dir, 'packaged-dist-staging'))
      assert.deepEqual(await treeIdentity(electronDist), electronFiles)
    }
  } finally {
    if (productionPreserved) {
      try { await lstat(path.join(desktop, 'dist')); await rename(path.join(desktop, 'dist'), path.join(output, 'failed-dist-staging')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await rename(originalDist, path.join(desktop, 'dist'))
    }
  }
  assert.deepEqual(await treeIdentity(path.join(desktop, 'dist')), distIdentity)
  assert.equal(await digest(path.join(desktop, 'package.json')), productionConfigurationSha256)
  assert.equal(await digest(path.join(desktop, 'scripts/native-rust-package.mjs')), productionBeforePackSha256)
  assert.deepEqual(await sourceIdentity(), source)
  const preparation = { schemaVersion: 1, task: 'RUST-015', state: 'PREPARED_NOT_RUNTIME_PASS', baseCommit, sourceCommit, source,
    storage, productionBuild, distIdentity, rustInputs, rustSourceSha256, unsignedCompilerInput: await artifact(binaryPath),
    nativeCompiler: 'NOT_RERUN_UNCHANGED_SOURCE', inheritedNativeSourceCommit: inheritedNative.manifest.source.commit,
    inheritedNative, manifestSha256, packages, compilations, electronFiles, productionConfigurationSha256, productionBeforePackSha256 }
  await save(path.join(output, 'preparation.json'), preparation)
  return preparation
}

async function captureClosedSqlite(runKey, evidenceDirectory, evidence) {
  const directory = path.join(evidenceDirectory, 'closed-sqlite')
  const check = await runCheck(evidenceDirectory, 'closed-sqlite-reference', '/usr/bin/python3', [
    path.join(desktop, 'scripts/collection-scale-sqlite.py'), evidence.path, runKey, directory])
  return { check, value: await json(path.join(directory, 'reference.json')) }
}
function assertCollectionScaleRunClosed(runKey, kind, receipt) {
  assert.deepEqual(receipt.mainExit, { code: 0, signal: null }, `${runKey} 必须自然退出，失败后不能启动下一候选。`)
  assert.equal(receipt.completion, 'closed'); assert.equal(receipt.timedOut, false); assert.equal(receipt.forceKilled, false)
  assert.equal(receipt.parseErrors, 0); assert.equal(receipt.startupFailed, false)
  const events = receipt.events, lifecycle = receipt.lifecycle
  assert.ok(Array.isArray(events) && Array.isArray(lifecycle), `${runKey} 缺少原轮次事件。`)
  // 完整行可能在输出异常时静默缺失；下一轮前先核每个actor自己的序号和clock。
  const actors = new Map()
  for (const event of events) {
    assert.ok(['main', 'core', 'renderer'].includes(event.actor) && Number.isSafeInteger(event.pid) && event.pid > 0,
      `${runKey} 原件actor身份不完整。`)
    const key = `${event.actor}:${event.pid}`, previous = actors.get(key) ?? { sequence: 0, elapsedMs: 0 }
    assert.equal(event.sequence, previous.sequence + 1, `${runKey} 原件actor序号不连续。`)
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= previous.elapsedMs,
      `${runKey} 原件actor本地clock不单调。`)
    actors.set(key, { sequence: event.sequence, elapsedMs: event.elapsedMs })
  }
  const fatal = new Set(['main.probeFailed', 'node.closeRejected', 'rust.kill-request', 'main.coreKill'])
  assert.equal(events.some(event => fatal.has(event.event) || /(?:Rejected|Failed|Overflow)$/.test(event.event)), false,
    `${runKey} 关闭或证据失败后不能启动下一候选。`)
  assert.equal(lifecycle.some(event => ['outbox-close-timeout', 'print-stop-failed'].includes(event.phase)), false)
  for (const event of events.filter(event => ['node.exit', 'main.coreExit'].includes(event.event))) assert.equal(event.data.code, 0)
  for (const event of events.filter(event => event.event === 'rust.exit')) {
    assert.equal(event.data.code, 0); assert.equal(event.data.signal, null)
    assert.equal(event.data.closeAcknowledged, true); assert.equal(event.data.pendingRequests, 0)
  }
  if (kind === 'default-node') {
    assert.equal(receipt.startupReady, true); assert.equal(events.length, 0)
    return // 原默认入口没有额外Node/Core/outbox ACK观察，不补造该证据。
  }
  const one = name => { const matching = events.filter(event => event.event === name); assert.equal(matching.length, 1, `${runKey} 缺少唯一 ${name}。`); return matching[0] }
  const completedProbe = one('main.rendererProbeComplete'), drained = one('main.rendererIpcDrained')
  one('main.coreExit')
  assert.deepEqual(Object.keys(drained.data).sort(), ['scope', 'pendingCount', 'requestCount', 'replyCount', 'rejectedCount'].sort())
  assert.equal(drained.actor, 'main'); assert.equal(drained.data.scope, 'before-original-quit')
  assert.equal(drained.data.pendingCount, 0); assert.equal(drained.data.rejectedCount, 0)
  assert.ok(Number.isSafeInteger(drained.data.requestCount) && drained.data.requestCount > 0)
  const ipcRequests = events.filter(event => event.actor === 'main' && event.event === 'main.ipcRequest')
  const ipcReplies = events.filter(event => event.actor === 'main' && event.event === 'main.ipcReply')
  assert.equal(drained.data.requestCount, ipcRequests.length); assert.equal(drained.data.replyCount, ipcReplies.length)
  assert.equal(ipcRequests.length, ipcReplies.length)
  const invokeIds = new Set()
  for (const request of ipcRequests) {
    const { invokeId, channel } = request.data
    assert.ok(typeof invokeId === 'string' && invokeId.length > 0 && !invokeIds.has(invokeId))
    invokeIds.add(invokeId)
    const replies = ipcReplies.filter(event => event.data.invokeId === invokeId)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].data.channel, channel); assert.equal(replies[0].pid, request.pid)
    assert.ok(request.sequence < replies[0].sequence && replies[0].sequence < drained.sequence,
      `${runKey} 原UI IPC尚未收口即声明排空。`)
  }
  // 周期打印领取没有UI invoke，不要求它永远全局零；原退出负责其停止。
  for (const request of events.filter(event => event.actor === 'main' && event.event === 'main.request' && event.data.invokeId !== null)) {
    assert.ok(invokeIds.has(request.data.invokeId))
    const replies = events.filter(event => event.actor === 'main' && event.event === 'main.response'
      && event.data.invokeId === request.data.invokeId && event.data.requestId === request.data.request?.id)
    assert.equal(replies.length, 1); assert.equal(replies[0].data.reply?.ok, true)
    assert.ok(request.sequence < replies[0].sequence && replies[0].sequence < drained.sequence)
  }
  const quitting = events.filter(event => event.actor === 'main' && event.event === 'main.beforeQuit')
  assert.ok(quitting.length > 0 && drained.sequence < completedProbe.sequence && quitting.every(event => completedProbe.sequence < event.sequence),
    `${runKey} 所有原UI IPC排空前不能完成probe或开始原退出。`)
  const started = one('node.closeStarted'), exited = one('node.exit'), completed = one('node.closeCompleted'), closed = one('core.closedStatus')
  assert.equal([started, exited, completed, closed].every(event => event.actor === 'core'), true)
  assert.ok(started.sequence < exited.sequence && exited.sequence < completed.sequence && completed.sequence < closed.sequence)
  const rustSpawns = events.filter(event => event.event === 'rust.spawn'), rustExits = events.filter(event => event.event === 'rust.exit')
  assert.equal(rustExits.length, rustSpawns.length, `${runKey} 每个native必须具备本代自然退出ACK。`)
  assert.equal(new Set(rustSpawns.map(event => event.data.pid)).size, rustSpawns.length)
  for (const spawn of rustSpawns) {
    assert.equal(spawn.actor, 'core'); assert.ok(Number.isSafeInteger(spawn.data.pid) && spawn.data.pid > 0)
    const exits = rustExits.filter(event => event.data.pid === spawn.data.pid)
    assert.equal(exits.length, 1)
    assert.equal(exits[0].actor, 'core'); assert.ok(spawn.sequence < exits[0].sequence && exits[0].sequence < closed.sequence)
  }
  for (const phase of ['core-shutdown-start', 'core-shutdown-end', 'outbox-close-start', 'outbox-close-end', 'will-quit']) assert.ok(lifecycle.some(event => event.phase === phase), `${runKey} 缺少原 ${phase} 收口。`)
  const coreExits = lifecycle.filter(event => event.phase === 'core-exit')
  assert.equal(coreExits.length, 1); assert.equal(coreExits[0].exitCode, 0)
}
async function gate(preparation, output) {
  const runs = {}, expectedRuns = {}, sqliteStages = {}, checks = [], expectedPackages = {}
  const plan = [{ key: 'default-node', kind: 'default-node' }]
  for (const kind of kinds.slice(1)) {
    plan.push({ key: kind + '-fresh', kind }, { key: kind + '-cold', kind, prior: kind + '-fresh' })
    sqliteStages[kind] = []
  }
  for (const run of plan) {
    const packaged = preparation.packages[run.kind], evidenceDirectory = path.join(output, 'runs', run.key)
    const launch = run.prior ? { type: 'cold', priorReceiptPath: runs[run.prior].evidence.path,
      priorReceiptSha256: runs[run.prior].evidence.sha256 } : { type: 'fresh' }
    const receipt = await runCollectionScaleCandidate({ executable: packaged.candidateIdentity.executable,
      expectedExecutableSha256: packaged.candidateIdentity.executableSha256, evidenceDirectory, kind: run.kind, launch })
    const file = path.join(evidenceDirectory, 'runtime-evidence.json'), evidence = await artifact(file)
    assert.deepEqual(await json(file), receipt)
    runs[run.key] = { receipt, evidence }; expectedRuns[run.key] = evidence
    assertCollectionScaleRunClosed(run.key, run.kind, receipt)
    if (run.kind !== 'default-node') {
      const reference = await captureClosedSqlite(run.key, evidenceDirectory, evidence)
      sqliteStages[run.kind].push(reference.value); checks.push(reference.check)
    }
    assert.deepEqual(await observePackage(packaged.candidateIdentity.appPath, preparation.manifestSha256, packaged.compile), packaged)
  }
  const sqliteReferences = {}
  for (const kind of kinds.slice(1)) {
    const file = path.join(output, kind + '-closed-sqlite-reference.json')
    await save(file, { schemaVersion: 1, task: 'RUST-015', kind, stages: sqliteStages[kind] })
    sqliteReferences[kind] = await artifact(file)
  }
  for (const kind of kinds) {
    expectedPackages[kind] = await observePackage(preparation.packages[kind].candidateIdentity.appPath, preparation.manifestSha256, preparation.packages[kind].compile)
    assert.deepEqual(expectedPackages[kind], preparation.packages[kind])
  }
  assert.deepEqual(await sourceIdentity(), preparation.source)
  const { tsImport } = await import(pathToFileURL(requireDesktop.resolve('tsx/esm/api')).href)
  const helper = await tsImport(pathToFileURL(path.join(desktop, 'test/helpers/collection-scale-evidence.ts')).href, import.meta.url)
  const cost = helper.deriveCollectionScaleCostEvidence(runs), costPath = path.join(output, 'collection-scale-cost.json')
  await save(costPath, cost)
  const costEvidence = await artifact(costPath)
  const report = { schemaVersion: 1, task: 'RUST-015', state: 'PASS', baseCommit, sourceCommit: preparation.sourceCommit,
    sourceSha256: preparation.source.sha256, packages: preparation.packages, runs, sqliteReferences, costEvidence,
    productionDefault: 'Node', businessDatabaseWriter: 'Node', mainOutboxWriter: 'Main',
    rendererFullDtoObservation: 'PASSIVE_RENDERER_COMMIT_FULL_DTO_AND_PAINT_OPPORTUNITY', ownerAcceptance: 'NOT_RUN', realServices: 'NOT_RUN', installation: 'NOT_RUN', push: 'NOT_RUN' }
  const expected = { baseCommit, sourceCommit: report.sourceCommit, sourceSha256: report.sourceSha256,
    packages: expectedPackages, runs: expectedRuns, sqliteReferences, costEvidence }
  await save(path.join(output, 'expected-identity.json'), expected)
  await save(path.join(output, 'uncertified-input.json'), { state: 'UNACCEPTED_INPUT', report })
  helper.acceptCollectionScaleEvidence(report, expected)
  const reportPath = path.join(output, 'collection-scale-report.json'); await save(reportPath, report)
  const typecheck = await runCheck(output, 'collection-scale-typecheck', process.execPath, [
    requireDesktop.resolve('vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', path.join(desktop, 'e2e/collection-scale.tsconfig.json')])
  const testFiles = [path.join(desktop, 'test/startup-test-config.test.ts'), path.join(desktop, 'test/native-rust-package.test.ts'),
    path.join(desktop, 'test/native-output-device-package.test.ts')]
  for (const directory of [path.join(desktop, 'test'), path.join(desktop, 'test/rust-core'), path.join(root, 'packages/bridge-core/test/rust-core')]) {
    for (const file of (await readdir(directory)).sort()) if (/^(?:collection-scale-|optional-scale-).*\.test\.ts$/.test(file)) testFiles.push(path.join(directory, file))
  }
  assert.ok(testFiles.some(file => file.includes('collection-scale-')) && testFiles.some(file => file.includes('optional-scale-')), '三个角色专项不得漏入Gate。')
  const tests = await runCollectionScaleBehaviorCheck(output, process.execPath, [
    '--import', path.join(desktop, 'node_modules/tsx/dist/loader.mjs'), '--test', '--test-concurrency=1', ...testFiles], {
    MUSIC_BRIDGE_COLLECTION_SCALE_REPORT: reportPath,
    MUSIC_BRIDGE_COLLECTION_SCALE_EXPECTED_IDENTITY: path.join(output, 'expected-identity.json'),
    MUSIC_BRIDGE_RUST_RESOURCE_TEST_BINARY: preparation.packages['default-node'].candidateIdentity.native.binaryPath,
    MUSIC_BRIDGE_RUST_BINARY: preparation.packages['default-node'].candidateIdentity.native.binaryPath,
    MUSIC_BRIDGE_RUST_SHA256: preparation.packages['default-node'].candidateIdentity.native.binarySha256,
  }, desktop)
  const tap = await readFile(tests.log, 'utf8')
  assert.match(tap, /# fail 0\b/); assert.match(tap, /# skipped 0\b/); assert.match(tap, /# cancelled 0\b/)
  assert.deepEqual(await sourceIdentity(), preparation.source)
  for (const kind of kinds) assert.deepEqual(await observePackage(expectedPackages[kind].candidateIdentity.appPath, preparation.manifestSha256, expectedPackages[kind].compile), expectedPackages[kind])
  const result = { schemaVersion: 1, task: 'RUST-015', state: 'PASS', sourceSha256: preparation.source.sha256,
    report: await artifact(reportPath), costEvidence, sqliteReferences, checks: [...checks, typecheck, tests],
    ownerAcceptance: 'NOT_RUN', rendererFullDtoObservation: report.rendererFullDtoObservation, forcedCleanup: false }
  await save(path.join(output, 'gate-manifest.json'), result)
  return result
}
async function main() {
  const [output, binaryPath] = process.argv.slice(2)
  assert.equal(process.argv.length, 4, '用法：node scripts/ci/verify-rust-collection-scale.mjs <全新外置目录> <已验证外置Rust编译输入>')
  isolate()
  const prepared = await prepare(output, binaryPath)
  console.log(JSON.stringify(await gate(prepared, output)))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async error => {
  console.error(`RUST-015_GATE_FAILED: ${error.message}`)
  if (ownedOutput) try { await save(path.join(ownedOutput, 'failure.json'), { schemaVersion: 1, task: 'RUST-015', state: 'FAIL', reason: error.message }) }
  catch { /* 失败原件保留，不覆盖。 */ }
  process.exit(1)
})
export { prepare, gate, sourceIdentity, captureClosedSqlite, assertCollectionScaleRunClosed, runCollectionScaleBehaviorCheck }
