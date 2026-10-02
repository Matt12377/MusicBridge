import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createOriginalMainStartupBarrier, createSessionController, evaluateMainScopeBoundary, installMainLifecycleObserver, installMainScopeBoundary, parseSessionArguments, parseTerminalCommand, parsePlaywrightSignalIdentity, verifyClosedSessionReceipt, verifyPlaywrightSignalIdentity, withElectronLaunchSignalOwnership, type ControlRecord, type LaunchSignalIdentity, type LaunchSignalEvidence } from '../../scripts/rust-collection-human-session.js'

const base = ['--manifest=/Volumes/LifeWeave/Developer/CommandLine/tmp/manifest.json', '--session-parent=/Volumes/LifeWeave/Developer/CommandLine/tmp/session-parent']
test('人工 CLI 默认仅选择静态 node100，四个明确模式逐一准入', () => {
  assert.equal(parseSessionArguments(base).mode, 'node100')
  for (const mode of ['node100', 'rust100', 'rust2000', 'rust5000']) assert.equal(parseSessionArguments([...base, `--mode=${mode}`]).mode, mode)
})
for (const [label, arguments_] of [
  ['未知模式', [...base, '--mode=rust']], ['任意二进制', [...base, '--binary=/bin/node']],
  ['预算覆盖', [...base, '--budget=1']], ['Owner 通过', [...base, '--accept']],
  ['重复模式', [...base, '--mode=node100', '--mode=rust100']], ['相对 manifest', ['--manifest=manifest.json', base[1]!]],
  ['缺父目录', [base[0]!]], ['参数拆分', ['--mode', 'rust100', ...base]],
] as const) test(`人工 CLI 拒绝${label}`, () => { assert.throws(() => parseSessionArguments(arguments_)) })

for (const line of ['status ', ' refresh', 'refresh now', 'quit; status', 'accept', 'oracle', 'invalidate', 'armExport', '', 'STATUS']) {
  test(`终端拒绝非精确或越权指令 ${JSON.stringify(line)}`, () => { assert.throws(() => parseTerminalCommand(line)) })
}
test('终端串行指令不会重复刷新，也不因失败自动重试', async () => {
  const records: ControlRecord[] = [], events: string[] = []
  let release!: () => void, refreshes = 0
  const waiting = new Promise<void>(resolve => { release = resolve })
  const controller = createSessionController({
    async status() { events.push('status'); return 'ready' },
    async refresh() { refreshes++; events.push('refresh-start'); await waiting; events.push('refresh-end'); throw new Error('原刷新拒绝') },
    async quit() { events.push('quit') }, onControl(record) { records.push(record) },
  })
  const first = controller.execute('refresh'), second = controller.execute('status')
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['refresh-start'])
  release(); await assert.rejects(first, /原刷新拒绝/); assert.equal(await second, 'ready')
  assert.equal(refreshes, 1); assert.deepEqual(events, ['refresh-start', 'refresh-end', 'status'])
  assert.deepEqual(records.map(x => [x.sequence, x.command, x.outcome]), [[1, 'refresh', 'rejected'], [2, 'status', 'success']])
})
test('退出排队后拒绝任何新指令，不能用隐藏窗口伪称 close 成功', async () => {
  let calls = 0, release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const records: ControlRecord[] = []
  const controller = createSessionController({ async status() {}, async refresh() { calls++ }, async quit() { await waiting; throw new Error('Owner/Core 尚未自然关闭') }, onControl(record) { records.push(record) } })
  const quitting = controller.execute('quit')
  assert.equal(controller.isClosing(), true)
  assert.throws(() => controller.execute('refresh')); assert.throws(() => controller.execute('quit'))
  release(); await assert.rejects(quitting, /尚未自然关闭/); assert.equal(calls, 0)
  assert.equal(records[0]!.outcome, 'rejected')
})

function scopeFixture(visible = false) {
  const calls: string[] = [], map = new Map<string, (...args: any[]) => any>()
  for (const channel of ['collection:list', 'collection:detail', 'collection:photo', 'commandOutbox:submit', 'commandOutbox:context', 'commandOutbox:acknowledge', 'remote-core:start', 'library:read', 'collection:pick-photo', 'lyrics:display:configure', 'recordingPrint:submit', 'commandOutbox:retry']) {
    map.set(channel, (...args) => { calls.push(channel); return { original: channel, args } })
  }
  const electron = { ipcMain: { _invokeHandlers: map, handle(channel: string, handler: (...args: any[]) => any) { if (map.has(channel)) throw new Error('重复原 handler'); map.set(channel, handler) }, removeHandler(channel: string) { map.delete(channel) } },
    dialog: { showOpenDialog() { calls.push('open'); return 'unsafe' }, showSaveDialog() { calls.push('save'); return 'unsafe' } },
    BrowserWindow: { getAllWindows() { return [{ isVisible: () => visible }] } } }
  return { calls, map, electron }
}
test('合成 Main 全集硬边界保留收藏原函数/DTO，泛命令只放行一次原 policy', () => {
  const fixture = scopeFixture(), original = fixture.map.get('collection:list')!, event = { sender: '原事件' }, page = { offset: 0, limit: 24 }
  const expected = original(event, page); fixture.calls.length = 0
  const boundary = installMainScopeBoundary(fixture.electron, { sessionId: 'synthetic-test' })
  assert.equal(boundary.installedBeforeVisible, true); assert.equal(boundary.dialogBlocked, true)
  assert.deepEqual(fixture.map.get('collection:list')!(event, page), expected)
  const policy = { request: { command: 'collection.setPolicy', payload: { commandId: 'synthetic-only' } } }
  assert.deepEqual(fixture.map.get('commandOutbox:submit')!(event, policy), { original: 'commandOutbox:submit', args: [event, policy] })
  assert.deepEqual(fixture.calls, ['collection:list', 'commandOutbox:submit'])
  for (const command of ['recordingPrint.request', 'collection.add', 'collection.setpolicy', 'referenceCatalog.registerSource']) {
    assert.throws(() => fixture.map.get('commandOutbox:submit')!(event, { request: { command } }), /SYNTHETIC_SCOPE_DENIED/)
  }
  assert.throws(() => fixture.map.get('commandOutbox:submit')!(event, { ...policy, retryConfirmed: true }), /SYNTHETIC_SCOPE_DENIED/)
  assert.throws(() => fixture.map.get('commandOutbox:retry')!(event, {}), /SYNTHETIC_SCOPE_DENIED/)
  assert.deepEqual(fixture.calls, ['collection:list', 'commandOutbox:submit'])
})
test('范围外原 handler、后来新 handler和原生 picker 全拒绝，不触及真实服务', () => {
  const fixture = scopeFixture(); installMainScopeBoundary(fixture.electron, { sessionId: 'synthetic-test' })
  for (const channel of ['remote-core:start', 'library:read', 'collection:pick-photo', 'recordingPrint:submit']) {
    assert.throws(() => fixture.map.get(channel)!({}, {}), /SYNTHETIC_SCOPE_DENIED/)
  }
  fixture.electron.ipcMain.handle('future:unsafe', () => { fixture.calls.push('future'); return 'unsafe' })
  assert.throws(() => fixture.map.get('future:unsafe')!(), /SYNTHETIC_SCOPE_DENIED/)
  assert.throws(() => fixture.electron.dialog.showOpenDialog(), /SYNTHETIC_SCOPE_DENIED/)
  assert.throws(() => fixture.electron.dialog.showSaveDialog(), /SYNTHETIC_SCOPE_DENIED/)
  assert.throws(() => Object.assign(fixture.electron.ipcMain, { handle() {} }))
  assert.throws(() => Object.assign(fixture.electron.dialog, { showSaveDialog() {} }))
  assert.deepEqual(fixture.calls, [])
})
test('Main handler 全集缺失、非 Map或窗口已经显示都 fail-closed', () => {
  const missing = scopeFixture(); missing.map.delete('remote-core:start')
  assert.throws(() => installMainScopeBoundary(missing.electron, { sessionId: 'test' }), /缺少必要/)
  const bad = scopeFixture(); Object.assign(bad.electron.ipcMain, { _invokeHandlers: {} })
  assert.throws(() => installMainScopeBoundary(bad.electron, { sessionId: 'test' }), /无法验证/)
  assert.throws(() => installMainScopeBoundary(scopeFixture(true).electron, { sessionId: 'test' }), /显示之前/)
})
test('隔离序列化进入 Main 的边界不依赖 driver 的 tsx函数名闭包', () => {
  const fixture = scopeFixture()
  const boundary = evaluateMainScopeBoundary(fixture.electron, { sessionId: 'serialized-test', source: installMainScopeBoundary.toString() })
  assert.equal(boundary.sessionId, 'serialized-test')
  assert.equal(boundary.blockedAttempts.length, 7)
  assert.throws(() => fixture.map.get('remote-core:start')!(), /SYNTHETIC_SCOPE_DENIED/)
  assert.deepEqual(fixture.calls, [])
})
test('到期撤销积压但不打断当前操作，只按原预算结束后自然 quit 一次', async () => {
  const records: ControlRecord[] = [], events: string[] = []
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const controller = createSessionController({ async status() { events.push('status') }, async refresh() { events.push('refresh'); await waiting }, async quit(source) { events.push(`quit:${source}`) }, onControl(record) { records.push(record) } })
  const current = controller.execute('refresh')
  await new Promise(resolve => setImmediate(resolve))
  const queued = [controller.execute('status'), controller.execute('refresh')].map(pending => pending.then(() => 'success', () => 'rejected'))
  const expiring = controller.execute('quit', 'expiry')
  assert.throws(() => controller.execute('status')); assert.deepEqual(events, ['refresh'])
  release(); await current; await expiring
  assert.deepEqual(await Promise.all(queued), ['rejected', 'rejected'])
  assert.deepEqual(events, ['refresh', 'quit:expiry'])
  assert.deepEqual(records.map(record => [record.sequence, record.command, record.outcome]), [[1,'refresh','success'],[2,'status','rejected'],[3,'refresh','rejected'],[4,'quit','success']])
})
test('先排普通quit再到期也取消积压，共用同一次原app.quit', async () => {
  const records: ControlRecord[] = [], events: string[] = []
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const controller = createSessionController({ async status() { events.push('status') }, async refresh() { events.push('refresh'); await waiting }, async quit() { events.push('quit') }, onControl(record) { records.push(record) } })
  const current = controller.execute('refresh')
  await new Promise(resolve => setImmediate(resolve))
  const queued = controller.execute('status').then(() => 'success', () => 'rejected')
  const normalQuit = controller.execute('quit')
  let deadlineQuit!: Promise<unknown>
  assert.doesNotThrow(() => { deadlineQuit = controller.execute('quit', 'expiry') })
  assert.equal(deadlineQuit, normalQuit)
  release(); await current; await deadlineQuit
  assert.equal(await queued, 'rejected'); assert.deepEqual(events, ['refresh', 'quit'])
  assert.equal(records.filter(record => record.command === 'quit').length, 1)
})
test('真实子进程自然退出后验证失败仍落failed，稳定句柄保留PID/exit且不读取销毁包装器', async () => {
  const owned = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }), pid = owned.pid
  await new Promise<void>((resolve, reject) => { owned.once('error', reject); owned.once('close', () => resolve()) })
  assert.equal(owned.exitCode, 0); assert.equal(owned.signalCode, null)
  const destroyedWrapper = { process(): never { throw new Error('Playwright 包装器已销毁，不能读取') } }
  assert.throws(() => destroyedWrapper.process(), /已销毁/)
  const receipt: Record<string, any> = { state: 'closed', close: { electronExit: { code: 0, signal: null } } }, writes: Record<string, any>[] = []
  await assert.rejects(verifyClosedSessionReceipt(receipt, owned, { verify() { throw new Error('缺少 Rust close ACK') }, async persist() { writes.push(structuredClone(receipt)) } }), /缺少 Rust close ACK/)
  assert.equal(writes.length, 1); assert.equal(writes[0]!.state, 'failed')
  assert.deepEqual(writes[0]!.unclosedResources, { electronPid: pid, electronExitCode: 0, electronSignal: null })
  assert.equal(writes[0]!.failure.code, 'FINAL_EVIDENCE_REJECTED')
})
test('积压达到64项后拒绝继续入队，到期quit仍可撤销积压并且只调用一次', async () => {
  const records: ControlRecord[] = []
  let release!: () => void, quitCount = 0, statusCount = 0
  const waiting = new Promise<void>(resolve => { release = resolve })
  const controller = createSessionController({ async status() { statusCount++ }, async refresh() { await waiting }, async quit() { quitCount++ }, onControl(record) { records.push(record) } })
  const active = controller.execute('refresh')
  await new Promise(resolve => setImmediate(resolve))
  const queued = Array.from({ length: 63 }, () => controller.execute('status').catch(() => 'rejected'))
  assert.throws(() => controller.execute('status'), /积压已达上限/)
  const closing = controller.execute('quit', 'expiry')
  release(); await active; await closing; await Promise.all(queued)
  assert.equal(statusCount, 0); assert.equal(quitCount, 1)
  assert.equal(records.filter(record => record.outcome === 'rejected').length, 63)
})
test('Main同类VM无动态import回调会真实拒绝；内建模块监听仍写真实before-quit收据', async () => {
  await assert.rejects(runInNewContext('(async () => { await import("node:fs") })()'), /dynamic import callback/i)
  const temporaryRoot = process.env.TMPDIR
  assert.ok(temporaryRoot?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'), '生命周期VM验证只能写本轮外置tmp。')
  const directory = mkdtempSync(path.join(temporaryRoot!, 'human-builtin-lifecycle-')), file = path.join(directory, 'lifecycle.json')
  const boundary = { sessionId: 'vm-boundary', installedBeforeVisible: true }, app = new EventEmitter()
  const install = runInNewContext(`(${installMainLifecycleObserver.toString()})`, { process, __rust010ScopeBoundary: boundary })
  const result = install({ app }, { file, sessionId: 'vm-session' })
  assert.equal(result.capability, 'process.getBuiltinModule')
  assert.equal(result.nodeVersion, process.versions.node)
  app.emit('before-quit')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sessionId: 'vm-session', electronPid: process.pid, beforeQuitObserved: true, boundary })
})
test('VM缺少固定内建模块能力时拒绝安装，不寻找替代Electron或文件seam', () => {
  const app = new EventEmitter(), install = runInNewContext(`(${installMainLifecycleObserver.toString()})`, { process: { versions: { node: 'unsupported-test' } } })
  assert.throws(() => install({ app }, { file: 'never-created', sessionId: 'test' }), /缺少内建模块能力/)
  assert.equal(app.listenerCount('before-quit'), 0)
})

function signalFixture(identity: LaunchSignalIdentity) {
  const calls: string[] = []
  const handlers = Object.fromEntries(Object.entries(identity.signatures).map(([signal, source]) => [signal, runInNewContext(`(${source})`, {
    gracefullyCloseAll: async () => { calls.push('Playwright.close') }, isUnderTest: () => false,
    process: { exit: (code: number) => { calls.push(`Playwright.exit:${code}`) }, off() {} }, sigintHandlerCalled: false, killSet: new Set(),
  }) as () => void]))
  const evidence: LaunchSignalEvidence = { dependencyPath: identity.file, dependencySha256: identity.sha256, version: identity.version,
    preservedAtStart: { SIGINT: 0, SIGTERM: 0, SIGHUP: 0 }, suppressed: [], restored: false }
  return { handlers, calls, evidence }
}
test('固定Playwright完整源或版本漂移会在launch之前失败，真实依赖保持只读', async () => {
  const identity = await verifyPlaywrightSignalIdentity(), source = readFileSync(identity.file, 'utf8')
  assert.deepEqual(parsePlaywrightSignalIdentity(identity.file, source, '1.62.1'), identity)
  assert.throws(() => parsePlaywrightSignalIdentity(identity.file, source + '\n', '1.62.1'), /实现发生漂移/)
  assert.throws(() => parsePlaywrightSignalIdentity(identity.file, source, '1.62.2'), /实现发生漂移/)
})
test('原固定PW回调确会抢占close/130；隔离后保留既有与并发无关监听器，三个信号由driver处理', async () => {
  const identity = await verifyPlaywrightSignalIdentity(), fixture = signalFixture(identity), target = new EventEmitter()
  target.on('SIGINT', fixture.handlers.SIGINT!); target.emit('SIGINT')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.calls, ['Playwright.close', 'Playwright.exit:130'])
  target.removeListener('SIGINT', fixture.handlers.SIGINT!); fixture.calls.length = 0
  const observed: string[] = [], existing = () => { observed.push('existing') }, driver = () => { observed.push('driver') }
  target.on('SIGINT', existing); target.on('SIGINT', driver)
  const originalOn = target.on, descriptor = Object.getOwnPropertyDescriptor(target, 'on')
  let release!: () => void, registered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), registrations = new Promise<void>(resolve => { registered = resolve })
  const launched = withElectronLaunchSignalOwnership(identity, fixture.evidence, async () => {
    for (const [signal, handler] of Object.entries(fixture.handlers)) target.on(signal, handler)
    registered(); await waiting
    return 'owned-app'
  }, target)
  await registrations
  // 本次launch上下文以外的并发调用仍注册原监听器，包括同名但不同源码的函数。
  const unrelated = function sigintHandler() { observed.push('unrelated') }
  target.on('SIGINT', unrelated); target.on('SIGTERM', driver); target.on('SIGHUP', driver)
  target.emit('SIGINT'); target.emit('SIGTERM'); target.emit('SIGHUP')
  release(); assert.equal(await launched, 'owned-app')
  assert.deepEqual(observed, ['existing', 'driver', 'unrelated', 'driver', 'driver'])
  assert.deepEqual(fixture.calls, []); assert.equal(target.on, originalOn)
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'on'), descriptor)
  assert.deepEqual(target.listeners('SIGINT'), [existing, driver, unrelated])
  assert.equal(fixture.evidence.restored, true); assert.equal(fixture.evidence.suppressed.length, 3)
})
test('启动前已有PW监听器时拒绝新launch，绝不撤销其他会话的监听', async () => {
  const identity = await verifyPlaywrightSignalIdentity(), fixture = signalFixture(identity), target = new EventEmitter()
  target.on('SIGINT', fixture.handlers.SIGINT!)
  let launches = 0
  await assert.rejects(withElectronLaunchSignalOwnership(identity, fixture.evidence, async () => { launches++ }, target), /已有 Playwright 会话/)
  assert.equal(launches, 0); assert.deepEqual(target.listeners('SIGINT'), [fixture.handlers.SIGINT])
})
test('本次launch内未知PW签名拒绝而不宽过滤，launch失败也恢复原注册方法', async () => {
  const identity = await verifyPlaywrightSignalIdentity(), fixture = signalFixture(identity), target = new EventEmitter(), original = target.on
  await assert.rejects(withElectronLaunchSignalOwnership(identity, fixture.evidence, async () => {
    target.on('SIGINT', function sigintHandler() { throw new Error('不是固定依赖回调') })
  }, target), /签名未知/)
  assert.equal(target.on, original); assert.equal(fixture.evidence.restored, true); assert.equal(target.listenerCount('SIGINT'), 0)
  await assert.rejects(withElectronLaunchSignalOwnership(identity, fixture.evidence, async () => { throw new Error('launch原错误') }, target), /launch原错误/)
  assert.equal(target.on, original)
})
test('临时注册方法被其他调用方接管时拒绝覆盖，单次launch竞争同样拒绝', async () => {
  const identity = await verifyPlaywrightSignalIdentity(), fixture = signalFixture(identity), target = new EventEmitter(), replacement = target.on.bind(target)
  await assert.rejects(withElectronLaunchSignalOwnership(identity, fixture.evidence, async () => {
    await assert.rejects(withElectronLaunchSignalOwnership(identity, signalFixture(identity).evidence, async () => {}, target), /不能竞争/)
    for (const [signal, handler] of Object.entries(fixture.handlers)) target.on(signal, handler)
    target.on = replacement
  }, target), /拒绝覆盖其所有权/)
  assert.equal(target.on, replacement); assert.equal(fixture.evidence.restored, false)
})
test('launch及原Main启动等待窗口的真实OS SIGINT保留原监听并落failed，只在稳定后受控quit一次', async () => {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory = mkdtempSync(path.join(process.env.TMPDIR!, 'human-launch-signal-')), script = path.join(directory, 'signal-test.mjs'), receiptPath = path.join(directory, 'failed.json')
  const driverUrl = new URL('../../scripts/rust-collection-human-session.ts', import.meta.url).href
  writeFileSync(script, `import assert from 'node:assert/strict';import{runInNewContext}from'node:vm';import{writeFileSync}from'node:fs';
import{createOriginalMainStartupBarrier,verifyPlaywrightSignalIdentity,withElectronLaunchSignalOwnership}from ${JSON.stringify(driverUrl)};
const identity=await verifyPlaywrightSignalIdentity();const evidence={dependencyPath:identity.file,dependencySha256:identity.sha256,version:identity.version,preservedAtStart:{},suppressed:[],restored:false};
let interrupted=false,existingCalls=0,unrelatedCalls=0,quitCalls=0,pwCalls=0,originalStartupPending=false,originalStartupStable=false;
const signalDeadline=setTimeout(()=>{process.stderr.write('受控OS信号未到达');process.exitCode=2;release();releaseStartup()},5000);
const existing=()=>{existingCalls++},driver=()=>{interrupted=true};process.on('SIGINT',existing);process.on('SIGINT',driver);
let release,releaseStartup;const wait=new Promise(resolve=>{release=resolve}),originalStartup=new Promise(resolve=>{releaseStartup=resolve});const original=process.on;
const launched=withElectronLaunchSignalOwnership(identity,evidence,async()=>{
 for(const[signal,source]of Object.entries(identity.signatures)){const listener=runInNewContext('('+source+')',{gracefullyCloseAll:async()=>{pwCalls++},isUnderTest:()=>false,process:{exit:()=>{pwCalls++},off(){}},sigintHandlerCalled:false,killSet:new Set()});process.on(signal,listener)}
 process.stdout.write('launch-pending\\n');await wait;return{quit:async()=>{quitCalls++}};
});
process.on('SIGINT',()=>{unrelatedCalls++;setTimeout(originalStartupPending?releaseStartup:release,20)});
const app=await launched;assert.equal(interrupted,true);
const barrier=createOriginalMainStartupBarrier({waitForWindow:async()=>{originalStartupPending=true;process.stdout.write('original-startup-pending\\n');await originalStartup;originalStartupStable=true;return'production-page'},quit:async()=>{assert.equal(originalStartupStable,true);await app.quit()}});
const firstClose=barrier.quit(),catchClose=barrier.quit();assert.equal(firstClose,catchClose);assert.equal(quitCalls,0);await firstClose;clearTimeout(signalDeadline);
assert.equal(process.on,original);assert.deepEqual(process.listeners('SIGINT').slice(0,2),[existing,driver]);
writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify({layer:'controlled-Node-signal-ownership',state:'failed',failure:{code:'SESSION_INTERRUPTED'},readyPublished:false,originalStartupStable,quitCalls,pwCalls,existingCalls,unrelatedCalls,evidence}));process.exitCode=1;
`, { mode: 0o600 })
  const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = '', sent = false, sentStarting = false
  child.stdout!.on('data', chunk => {
    output += chunk
    if (!sent && output.includes('launch-pending\n')) { sent = true; child.kill('SIGINT') }
    if (!sentStarting && output.includes('original-startup-pending\n')) { sentStarting = true; child.kill('SIGINT') }
  })
  child.stderr!.on('data', chunk => { errors += chunk })
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()) })
  assert.equal(sent, true, errors); assert.equal(sentStarting, true, errors); assert.equal(child.exitCode, 1, errors); assert.equal(child.signalCode, null)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.readyPublished, false)
  assert.equal(receipt.originalStartupStable, true); assert.equal(receipt.quitCalls, 1); assert.equal(receipt.pwCalls, 0); assert.equal(receipt.existingCalls, 2); assert.equal(receipt.unrelatedCalls, 2)
  assert.equal(receipt.evidence.suppressed.length, 3); assert.equal(receipt.evidence.restored, true)
})

test('原Main启动仍pending时signal与catch共用稳定屏障，未完成前不quit/show/ready，完成后单次退出', async () => {
  const signalHost = new EventEmitter(), events: string[] = []
  let interrupted = false, release!: () => void, waits = 0, quits = 0, originalBootstrapComplete = false
  const pendingOriginalStartup = new Promise<void>(resolve => { release = resolve })
  const barrier = createOriginalMainStartupBarrier({
    async waitForWindow() { waits++; events.push('original-bootstrap-pending'); await pendingOriginalStartup; originalBootstrapComplete = true; events.push('production-window-DOMContentLoaded'); return 'production-page' },
    async quit() { assert.equal(originalBootstrapComplete, true, '提前quit会触发原bootstrap失败'); quits++; events.push('app.quit') },
  })
  const waiting = barrier.wait()
  signalHost.on('SIGINT', () => { interrupted = true })
  await new Promise(resolve => setImmediate(resolve)); signalHost.emit('SIGINT')
  // 原启动中断检查和catch都可以到达关闭路径，必须共享屏障，不能竞态重发quit。
  const firstClose = barrier.quit(), catchClose = barrier.quit()
  assert.equal(firstClose, catchClose); assert.equal(quits, 0); assert.equal(interrupted, true)
  assert.deepEqual(events, ['original-bootstrap-pending'])
  release(); assert.equal(await waiting, 'production-page'); await firstClose
  let ready = false
  if (!interrupted) { events.push('show'); ready = true }
  assert.equal(ready, false); assert.equal(waits, 1); assert.equal(quits, 1)
  assert.deepEqual(events, ['original-bootstrap-pending', 'production-window-DOMContentLoaded', 'app.quit'])
})
test('原Main窗口未稳定且超时或子进程已退出时拒绝伪close，不重启bootstrap或重发quit', async () => {
  for (const hasExited of [false, true]) {
    let quits = 0, waits = 0
    const barrier = createOriginalMainStartupBarrier({ async waitForWindow() { waits++; return await new Promise<never>(() => {}) }, async quit() { quits++ }, hasExited: () => hasExited }, 10)
    const first = barrier.quit(), second = barrier.quit()
    assert.equal(first, second)
    await assert.rejects(first, hasExited ? /已退出/ : /等待超时/)
    await assert.rejects(barrier.wait())
    assert.equal(waits, 1); assert.equal(quits, 0)
  }
})
