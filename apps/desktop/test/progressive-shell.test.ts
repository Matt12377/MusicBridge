import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { isTrustedRendererSender } from '../src/main/security.js'

const nonce = 'a0000000-0000-4000-8000-000000000001'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void, reject!: (cause: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

for (const failure of [false, true]) test(`实际preload：曲库启动${failure ? '失败' : '未完成'}时静态信息与主题独立，业务不排队`, async t => {
  const source = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const bootstrap = source.slice(source.indexOf('// 偏好消息与DOM/module完成独立'), source.indexOf('const rendererPerformance'))
  const invoker = source.slice(source.indexOf('const invokePerformance: typeof ipcRenderer.invoke = (channel'), source.indexOf('const invokeScoped'))
  assert.ok(bootstrap && invoker)
  const ready = deferred(), calls: string[] = [], result: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> } = {}
  runInNewContext(ts.transpileModule(bootstrap + '\n' + invoker + '\nresult.invoke = invokePerformance', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    result, process: { argv: ['--music-bridge-startup-nonce=' + nonce] }, window: { localStorage: { getItem: () => null } },
    ipcRenderer: { invoke: async (channel: string) => { if (channel.endsWith('bootstrap-ready')) await ready.promise } },
    invokeObserved: async (channel: string) => { calls.push(channel); return channel },
  })
  t.after(() => ready.resolve())
  assert.equal(await Promise.race([result.invoke!('app:get-info'), turn().then(() => 'BLOCKED_BY_CORE')]), 'app:get-info')
  assert.equal(await Promise.race([result.invoke!('app:set-appearance-theme', 'dark'), turn().then(() => 'BLOCKED_BY_CORE')]), 'app:set-appearance-theme')
  const remote = result.invoke!('remote-core:get-state')
  let remoteSettled = false
  void remote.then(() => { remoteSettled = true }, () => { remoteSettled = true })
  for (const channel of ['playback:play', 'auth:begin-qr', 'mobile:configure', 'commandOutbox:submit', 'localWorkbench:management', 'unknown:read']) {
    await assert.rejects(result.invoke!(channel), /\[NOT_READY\]/u)
  }
  await turn()
  assert.equal(remoteSettled, false)
  assert.deepEqual(calls, ['app:get-info', 'app:set-appearance-theme'])
  if (failure) {
    ready.reject(new Error('合成启动未完成'))
    await assert.rejects(remote, /合成启动未完成/u)
    assert.equal(await result.invoke!('app:get-info'), 'app:get-info')
    assert.equal(await result.invoke!('app:set-appearance-theme', 'light'), 'app:set-appearance-theme')
  } else {
    ready.resolve()
    assert.equal(await remote, 'remote-core:get-state')
  }
  assert.equal(calls.some(channel => !['app:get-info', 'app:set-appearance-theme', 'remote-core:get-state'].includes(channel)), false)
})

test('实际Main应用壳仅注册两个独立IPC，先于窗口/Owner启动，复用当前窗口身份校验', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
  const shell = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerAppShellHandlers')
  assert.ok(shell, '必须将独立应用壳从依赖Core的IPC安装中分开')
  const start = source.indexOf('async function bootstrap(')
  const register = source.indexOf('  registerAppShellHandlers()', start)
  assert.ok(register > start && register < source.indexOf('    earlyWindow = createWindow(', start))
  assert.ok(register < source.indexOf('    await startup.activate(', start))
  const trusted = source.slice(source.indexOf('function requireTrustedRenderer('), source.indexOf('async function invokeCore'))
  const frame = { url: 'musicbridge://app/index.html' }, contents = { id: 17, mainFrame: frame }
  const effects: string[] = [], handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const info = { version: 'synthetic', buildMode: 'development', platform: 'darwin' }
  const nativeTheme = { themeSource: 'light' }
  runInNewContext(ts.transpileModule(trusted + shell.getText(parsed) + '\nregisterAppShellHandlers()', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    mainWindow: { isDestroyed: () => false, webContents: contents, setBackgroundColor: (value: string) => effects.push(value) },
    registerPerformanceHandler: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler),
    isTrustedRendererSender, publicIpcFailure: (code: string) => { throw new Error(code) }, nativeTheme, appInfo: () => info,
  })
  assert.deepEqual([...handlers.keys()].sort(), ['app:get-info', 'app:set-appearance-theme'])
  const valid = { sender: contents, senderFrame: frame }
  for (const event of [{ ...valid, sender: { ...contents } }, { ...valid, senderFrame: { ...frame } }, { ...valid, senderFrame: null }, { ...valid, senderFrame: { url: 'https://outside.invalid/' } }]) {
    for (const channel of handlers.keys()) assert.throws(() => handlers.get(channel)!(event, 'dark'), /NOT_READY/u)
  }
  for (const value of [undefined, null, {}, 'system', 'dark;anything']) assert.throws(() => handlers.get('app:set-appearance-theme')!(valid, value), /INVALID_IPC_REQUEST/u)
  assert.deepEqual(effects, [])
  assert.equal(handlers.get('app:get-info')!(valid), info)
  handlers.get('app:set-appearance-theme')!(valid, 'dark')
  assert.equal(nativeTheme.themeSource, 'dark')
  assert.deepEqual(effects, ['#3c4253'])
})
