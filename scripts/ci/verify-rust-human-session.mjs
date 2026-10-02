import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, existsSync, readFileSync, statSync } from 'node:fs'
import { access, chmod, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url)), desktop = path.join(root, 'apps/desktop')
const external = '/Volumes/LifeWeave/Developer/CommandLine', baseSha = '5fc369a46b37fec4ad50ebb909aa1f2c4bc09d09'
const args = new Map()
for (const value of process.argv.slice(2)) {
  const match = /^--(output|component|electron-manifest|mode)=(.+)$/.exec(value)
  assert.ok(match && !args.has(match[1]), 'Gate参数无效或重复。')
  args.set(match[1], match[2])
}
const output = args.get('output'), component = args.get('component'), electronManifestPath = args.get('electron-manifest'), mode = args.get('mode') ?? 'all'
assert.ok([output, component, electronManifestPath].every(value => typeof value === 'string' && path.isAbsolute(value)), 'Gate需要output/component/electron-manifest三个外置绝对路径。')
assert.ok(['build', 'smoke', 'acceptance', 'all'].includes(mode), 'Gate模式无效。')
assert.equal(process.platform, 'darwin', '本Gate只验证已准入的本机macOS。')
assert.match(process.version, /^v22\./, '本Gate使用Node22。')
const disk = execFileSync('diskutil', ['info', '-plist', '/Volumes/LifeWeave'], { encoding: 'utf8' })
for (const pattern of [/<key>MountPoint<\/key>\s*<string>\/Volumes\/LifeWeave<\/string>/, /<key>Internal<\/key>\s*<false\/>/, /<key>WritableVolume<\/key>\s*<true\/>/]) assert.match(disk, pattern)
assert.notEqual(statSync('/Volumes/LifeWeave').dev, statSync('/').dev, '外置卷必须真实挂载。')
for (const directory of [path.dirname(output), path.dirname(component), path.dirname(electronManifestPath), process.env.TMPDIR ?? '']) {
  const resolved = await realpath(directory)
  assert.equal(resolved, path.resolve(directory), 'Gate路径不能通过链接改向。')
  assert.ok(resolved.startsWith(external + '/'), 'Gate构建、缓存与临时目录只在外置工作根。')
  await access(resolved, constants.W_OK)
}
const cache = path.join(external, 'Caches'), loader = path.join(desktop, 'node_modules/tsx/dist/loader.mjs')
const cachedPnpm = path.join(cache, 'corepack/v1/pnpm/10.17.1/bin/pnpm.cjs')
assert.equal(await realpath(cachedPnpm), cachedPnpm, '固定pnpm必须已在外置缓存中，不能隐式下载。')
assert.equal(JSON.parse(await readFile(path.join(path.dirname(cachedPnpm), '../package.json'), 'utf8')).version, '10.17.1')
const env = { ...process.env, DEV_BUILD_ROOT: external, DEV_CACHE_ROOT: cache,
  COREPACK_HOME: path.join(cache, 'corepack'), npm_config_cache: path.join(cache, 'npm'),
  ELECTRON_CACHE: path.join(cache, 'Electron'), electron_config_cache: path.join(cache, 'Electron'),
  XDG_CACHE_HOME: path.join(cache, 'XDG'), NODE_COMPILE_CACHE: path.join(cache, 'Node'), ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => hash(readFileSync(file))
const save = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const inputs = ['apps/desktop/scripts/rust-collection-human-session.ts', 'apps/desktop/e2e/rust-collection-human.tsconfig.json',
  'apps/desktop/test/helpers/rust-collection-human-evidence.ts', 'apps/desktop/test/rust-core/rust-collection-human-session.test.ts',
  'apps/desktop/test/rust-core/rust-collection-human-evidence.test.ts', 'scripts/ci/verify-rust-human-session.mjs', 'package.json', 'pnpm-lock.yaml']
const sourceIdentity = () => inputs.toSorted().map(file => ({ path: file, sha256: fileHash(path.join(root, file)), bytes: statSync(path.join(root, file)).size }))
const manifestPath = path.join(output, 'driver-manifest.json'), sessionParent = path.join(output, 'owner-sessions')
const runs = []
async function run(name, argv, cwd = root, extraEnv = {}) {
  const logPath = path.join(output, name + '.log'), started = performance.now()
  const chunks = [Buffer.from(JSON.stringify({ argv, cwd }) + '\n')]
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', value => chunks.push(value)); child.stderr.on('data', value => chunks.push(value))
  const closed = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  await writeFile(logPath, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 })
  const record = { name, argv, cwd, exitCode: closed.code, signal: closed.signal, durationMs: performance.now() - started, log: logPath, sha256: fileHash(logPath) }
  runs.push(record); await save(path.join(output, name + '.json'), record)
  assert.ok(closed.code === 0 && closed.signal === null, '合成人工Gate步骤失败：' + name + '；保留完整日志。')
  return Buffer.concat(chunks).toString('utf8')
}
const evidence = await import(pathToFileURL(path.join(desktop, 'test/helpers/rust-collection-human-evidence.ts')).href)
try {
  if (mode === 'build' || mode === 'all') {
    assert.equal(existsSync(output), false, '构建采用新Gate目录，保留旧结果。')
    assert.equal(existsSync(component), false, '组件采用新隔离目录，保留旧结果。')
    await mkdir(output); await mkdir(path.join(output, 'tmp')); await mkdir(sessionParent)
    env.TMPDIR = path.join(output, 'tmp')
    const sources = sourceIdentity()
    await run('gate-syntax', [process.execPath, '--check', path.join(root, 'scripts/ci/verify-rust-human-session.mjs')])
    await run('human-typecheck', [process.execPath, path.join(desktop, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'e2e/rust-collection-human.tsconfig.json'], desktop)
    await run('human-behavior', [process.execPath, '--import', loader, '--test', '--test-concurrency=1', 'test/rust-core/rust-collection-human-session.test.ts'], desktop)
    const pnpm = await run('fixed-pnpm-version', [process.execPath, cachedPnpm, '--version'])
    assert.equal(pnpm.trim().split('\n').at(-1), '10.17.1', '固定pnpm版本不符。')
    await run('component-build', [process.execPath, path.join(desktop, 'scripts/rust-collection-host-gate.mjs'), '--mode=build', '--output=' + component])
    const componentManifestPath = path.join(component, 'artifact-manifest.json'), componentManifest = JSON.parse(await readFile(componentManifestPath, 'utf8'))
    const launcherPath = path.join(output, 'start-synthetic-owner.command')
    const contents = evidence.humanSessionLauncherContents({ driverManifestPath: manifestPath, sourceRoot: root.replace(/\/$/, ''), sessionParent })
    await writeFile(launcherPath, contents, { flag: 'wx', mode: 0o700 }); await chmod(launcherPath, 0o700)
    await run('launcher-syntax', ['/bin/zsh', '-n', launcherPath])
    assert.deepEqual(sourceIdentity(), sources, '构建期间新driver输入发生变化。')
    await save(manifestPath, { schemaVersion: 1, task: 'RUST-010', baseSha, sourceRoot: root.replace(/\/$/, ''), sources,
      sourceAggregateSha256: hash(JSON.stringify(sources)), componentManifestPath, componentManifestSha256: fileHash(componentManifestPath),
      electronManifestPath, electronManifestSha256: fileHash(electronManifestPath), binaryPath: componentManifest.binaryPath, binarySha256: componentManifest.binarySha256,
      launcher: { path: launcherPath, sha256: fileHash(launcherPath), bytes: statSync(launcherPath).size, mode: 448, sessionParent },
      tools: { node: process.version, pnpm: '10.17.1', pnpmExecutable: cachedPnpm, pnpmExecutableSha256: fileHash(cachedPnpm), pnpmVersionReceipt: path.join(output, 'fixed-pnpm-version.json') },
      ownerAcceptance: 'NOT_RUN', productionDefault: 'Node', installedApplication: 'NOT_CHANGED' })
    evidence.verifyHumanSessionIdentity({ driverManifestPath: manifestPath })
    await save(path.join(output, 'build-result.json'), { phase: 'build', sourceStable: true, sources, runs, driverManifestPath: manifestPath, driverManifestSha256: fileHash(manifestPath), ownerAcceptance: 'NOT_RUN' })
    console.log('RUST_HUMAN_BUILD_PASS=' + manifestPath)
  }
  if (mode === 'smoke' || mode === 'all') {
    env.TMPDIR = path.join(output, 'tmp')
    evidence.verifyHumanSessionIdentity({ driverManifestPath: manifestPath })
    const { runHumanSession } = await import(pathToFileURL(path.join(desktop, 'scripts/rust-collection-human-session.ts')).href)
    const scenarios = []
    for (const sessionMode of ['node100', 'rust100', 'rust2000', 'rust5000']) {
      const actions = [], started = performance.now()
      const receipt = await runHumanSession({ driverManifestPath: manifestPath, sessionParent, mode: sessionMode }, {
        testBudgetMs: sessionMode === 'node100' ? 5000 : 60000,
        async onReady({ page, control, receipt }) {
          const rejected = await page.evaluate(async () => {
            const results = []
            for (const operation of ['startRemoteCore', 'beginQrLogin', 'pickCollectionPhoto']) {
              try {
                if (operation === 'startRemoteCore') await window.musicBridge.startRemoteCore('synthetic-denied@127.0.0.1')
                else if (operation === 'beginQrLogin') await window.musicBridge.beginQrLogin()
                else await window.musicBridge.pickCollectionPhoto()
                results.push({ operation, denied: false })
              } catch (error) { results.push({ operation, denied: String(error).includes('SYNTHETIC_SCOPE_DENIED') }) }
            }
            return results
          })
          assert.ok(rejected.every(value => value.denied), '原preload范围外请求必须在实际Main明确拒绝。')
          actions.push({ action: 'original-preload-scope-rejections', probes: rejected })
          const collection = page.locator('[data-component="CollectionView"]')
          await page.locator('[data-sidebar-source="collection"]').click()
          await collection.locator('.inventory-card').first().waitFor()
          assert.match(await collection.innerText(), new RegExp(`${receipt.seed.models} 个型号`))
          await page.screenshot({ path: path.join(receipt.sessionRoot, 'visible-collection.png') })
          actions.push({ action: 'original-collection-navigation', screenshot: { path: path.join(receipt.sessionRoot, 'visible-collection.png'), sha256: fileHash(path.join(receipt.sessionRoot, 'visible-collection.png')) } })
          if (sessionMode === 'node100') { await assert.rejects(() => control('refresh')); return }
          await collection.locator('.inventory-card').first().click()
          const detail = page.locator('.model-detail')
          await detail.waitFor(); await detail.getByText('收藏保护设置', { exact: true }).click()
          await detail.getByLabel('收藏策略').selectOption('collector')
          await detail.getByLabel('最低未开封保留数量').fill('1')
          await page.getByRole('button', { name: '保存保护设置', exact: true }).click()
          let state
          const deadline = performance.now() + 10000
          do {
            state = await control('status')
            if (state.phase === 'stale') break
            await new Promise(resolve => setTimeout(resolve, 50))
          } while (performance.now() < deadline)
          assert.equal(state.phase, 'stale', '原policy写后必须撤回Rust并使用Node。')
          actions.push({ action: 'original-policy-form', phase: state.phase, generation: state.generation })
          await page.getByRole('button', { name: '← 返回收藏', exact: true }).click()
          const pagination = page.getByRole('navigation', { name: '收藏分页' })
          await pagination.getByRole('button', { name: '下一页', exact: true }).click()
          await pagination.getByRole('button', { name: '上一页', exact: true }).click()
          const refreshed = await control('refresh')
          assert.equal(refreshed.phase, 'rust', '一次显式刷新必须恢复Rust。')
          actions.push({ action: 'single-explicit-refresh', phase: refreshed.phase, generation: refreshed.generation })
          await page.screenshot({ path: path.join(receipt.sessionRoot, 'after-explicit-refresh.png') })
          actions.push({ action: 'refreshed-original-collection', screenshot: { path: path.join(receipt.sessionRoot, 'after-explicit-refresh.png'), sha256: fileHash(path.join(receipt.sessionRoot, 'after-explicit-refresh.png')) } })
          await control('quit')
        },
      })
      const result = evidence.verifyHumanSessionEvidence(receipt)
      if (sessionMode !== 'node100') {
        const { DatabaseSync } = await import('node:sqlite')
        const database = new DatabaseSync(path.join(receipt.profile, 'data/command-outbox.v1.sqlite'), { readOnly: true })
        try {
          const rows = database.prepare('SELECT e.command_id,s.state,s.acknowledged,s.result_json FROM outbox_entries e JOIN outbox_states s ON s.id=e.id').all()
          assert.equal(rows.length, 1); assert.equal(rows[0].state, 'succeeded'); assert.equal(rows[0].acknowledged, 1)
          assert.ok(JSON.parse(String(rows[0].result_json)))
          actions.push({ action: 'readonly-durable-outbox-check', rowCount: rows.length, state: rows[0].state, acknowledged: rows[0].acknowledged })
        } finally { database.close() }
      }
      scenarios.push({ mode: sessionMode, result, receiptPath: path.join(receipt.sessionRoot, 'session.json'), receiptSha256: fileHash(path.join(receipt.sessionRoot, 'session.json')), actions, durationMs: performance.now() - started })
    }
    // 实际启动生成的CLI脚本；输入来自受控测试，不是Owner操作或接受。
    const launcherLog = path.join(output, 'launcher-runtime.log'), launcherChunks = [], child = spawn(path.join(output, 'start-synthetic-owner.command'), [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let sent = false, stdout = ''
    child.stdout.on('data', value => { launcherChunks.push(value); stdout += value.toString(); if (!sent && stdout.includes('Owner 验收：NOT_RUN')) { sent = true; child.stdin.end('status\nquit\n') } })
    child.stderr.on('data', value => launcherChunks.push(value))
    const closed = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
    await writeFile(launcherLog, Buffer.concat(launcherChunks), { flag: 'wx', mode: 0o600 })
    assert.equal(sent, true, '启动器未到达真实readiness。'); assert.deepEqual(closed, { code: 0, signal: null }, '实际CLI未自然结束。')
    const receiptPath = stdout.match(/会话自然关闭：([^\n]+)/)?.[1]
    assert.ok(receiptPath && path.isAbsolute(receiptPath), '实际CLI缺最终收据路径。')
    const launcherReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    evidence.verifyHumanSessionEvidence(launcherReceipt); assert.equal(launcherReceipt.mode, 'node100'); assert.equal(launcherReceipt.budget.durationMs, 1800000)
    // 向启动器发送受控中断，Electron仍由driver通过原app.quit收口。
    const beforeInterrupted = new Set(await readdir(sessionParent)), interruptedChunks = []
    const interrupted = spawn(path.join(output, 'start-synthetic-owner.command'), [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    interrupted.stdout.on('data', value => interruptedChunks.push(value)); interrupted.stderr.on('data', value => interruptedChunks.push(value))
    let interruptedReceiptPath, signalSent = false, polling = false, fallbackQuitSent = false, pollingError
    const signalDeadline = performance.now() + 30000
    const poll = setInterval(async () => {
      if (polling || signalSent) return
      if (performance.now() > signalDeadline) {
        if (!fallbackQuitSent) { fallbackQuitSent = true; interrupted.stdin.end('quit\n') }
        return
      }
      polling = true
      try {
        for (const directory of await readdir(sessionParent)) {
          if (beforeInterrupted.has(directory)) continue
          const file = path.join(sessionParent, directory, 'session.json')
          if (!existsSync(file)) continue
          let receipt
          try { receipt = JSON.parse(await readFile(file, 'utf8')) } catch { continue }
          if (receipt.state === 'starting' && Number.isSafeInteger(receipt.electronPid) && receipt.electronPid > 0) {
            interruptedReceiptPath = file; signalSent = interrupted.kill('SIGINT'); return
          }
        }
      } catch (error) { pollingError = String(error) } finally { polling = false }
    }, 20)
    let interruptedExit
    try { interruptedExit = await new Promise((resolve, reject) => { interrupted.once('error', reject); interrupted.once('close', (code, signal) => resolve({ code, signal })) }) }
    finally { clearInterval(poll) }
    const interruptedLog = path.join(output, 'launcher-startup-interruption.log')
    await writeFile(interruptedLog, Buffer.concat(interruptedChunks), { flag: 'wx', mode: 0o600 })
    assert.equal(pollingError, undefined, '启动中断观察失败，保留实际日志。')
    assert.equal(signalSent, true, '未捕获实际启动阶段，不能声明启动中断测试通过。')
    assert.deepEqual(interruptedExit, { code: 1, signal: null }, 'driver必须记录中断失败后自行结束。')
    const failedReceipt = JSON.parse(await readFile(interruptedReceiptPath, 'utf8'))
    assert.equal(failedReceipt.state, 'failed'); assert.equal(failedReceipt.ownerAcceptance, 'NOT_RUN')
    assert.equal(existsSync(path.join(failedReceipt.sessionRoot, 'readiness.json')), false, '中断启动不能留下ready收据。')
    assert.equal(Buffer.concat(interruptedChunks).toString('utf8').includes('合成人工验收会话已显示'), false, '中断启动不能宣告就绪。')
    assert.equal(failedReceipt.unclosedResources.electronExitCode, 0); assert.equal(failedReceipt.unclosedResources.electronSignal, null)
    evidence.verifyHumanSignalOwnership(failedReceipt.signalOwnership)
    assert.equal(failedReceipt.coreExit, 0, '启动中断后原Core必须完整收口。')
    const interruptedObservations = failedReceipt.host?.observations
    assert.ok(Array.isArray(interruptedObservations), '启动中断缺少原Owner资源现场。')
    const ownerClose = interruptedObservations.filter(value => value.event === 'node.close')
    const ownerExit = interruptedObservations.filter(value => value.event === 'node.exit')
    const ownerClosed = interruptedObservations.filter(value => value.event === 'node.closed')
    assert.equal(ownerClose.length, 1); assert.equal(ownerExit.length, 1); assert.equal(ownerClosed.length, 1)
    assert.equal(ownerExit[0].code, 0)
    assert.ok(ownerClose[0].sequence < ownerExit[0].sequence && ownerExit[0].sequence < ownerClosed[0].sequence, '启动中断仍须保留Owner close→exit→closed。')
    assert.equal(interruptedObservations.filter(value => value.event === 'rust.spawn' || /^node\.export/.test(value.event)).length, 0, '默认启动中断不得创建Rust或导出快照。')
    const interruptedLifecyclePath = path.join(failedReceipt.profile, 'human-lifecycle.json')
    const interruptedLifecycle = JSON.parse(await readFile(interruptedLifecyclePath, 'utf8'))
    assert.equal(interruptedLifecycle.sessionId, failedReceipt.sessionId)
    assert.equal(interruptedLifecycle.electronPid, failedReceipt.electronPid)
    assert.equal(interruptedLifecycle.beforeQuitObserved, true, '启动中断必须走原Main before-quit。')
    const result = { phase: 'automated-visible-smoke', driverManifestPath: manifestPath, driverManifestSha256: fileHash(manifestPath), scenarios,
      launcher: { classification: 'scripted-cli-verification', receiptPath, receiptSha256: fileHash(receiptPath), log: launcherLog, logSha256: fileHash(launcherLog), ...closed },
      startupInterruption: { classification: 'controlled-driver-SIGINT-before-readiness', receiptPath: interruptedReceiptPath,
        receiptSha256: fileHash(interruptedReceiptPath), log: interruptedLog, logSha256: fileHash(interruptedLog), driverExit: interruptedExit, electronExit: { code: 0, signal: null },
        coreExit: 0, nodeOwnerExit: 0, beforeQuitObserved: true, lifecyclePath: interruptedLifecyclePath, lifecycleSha256: fileHash(interruptedLifecyclePath), state: 'failed', readinessCreated: false },
      ownerAcceptance: 'NOT_RUN', realServices: 'NOT_RUN', installedApplication: 'NOT_CHANGED' }
    await save(path.join(output, 'smoke-result.json'), result)
    console.log('RUST_HUMAN_SMOKE_PASS=' + path.join(output, 'smoke-result.json'))
  }
  if (mode === 'acceptance' || mode === 'all') {
    const smoke = JSON.parse(await readFile(path.join(output, 'smoke-result.json'), 'utf8'))
    const reports = smoke.scenarios.map(value => value.receiptPath)
    for (const scenario of smoke.scenarios) assert.equal(fileHash(scenario.receiptPath), scenario.receiptSha256, '真实session报告身份漂移。')
    assert.deepEqual(smoke.scenarios.map(value => value.mode), ['node100', 'rust100', 'rust2000', 'rust5000'])
    await run('human-evidence-acceptance', [process.execPath, '--import', loader, '--test', '--test-concurrency=1', 'test/rust-core/rust-collection-human-evidence.test.ts'], desktop,
      { MUSIC_BRIDGE_RUST_HUMAN_SESSION_REPORTS: JSON.stringify(reports) })
    await save(path.join(output, 'acceptance-result.json'), { phase: 'strict-actual-session-acceptance', runs, reportPaths: reports, ownerAcceptance: 'NOT_RUN' })
    console.log('RUST_HUMAN_ACCEPTANCE_PASS=' + path.join(output, 'acceptance-result.json'))
  }
} catch (error) {
  if (existsSync(output) && !existsSync(path.join(output, `failure-${mode}.json`))) await save(path.join(output, `failure-${mode}.json`), {
    task: 'RUST-010', phase: mode, complete: false, runs, error: String(error), ownerAcceptance: 'NOT_RUN' })
  throw error
}
