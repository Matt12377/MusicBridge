import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// 执行原 bootstrap 函数的受控依赖行为；不启动 Electron，不代替实际候选 App Gate。
function subject(candidate: boolean, fails = false) {
  const text = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bootstrap = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'bootstrap')!
  const compiled = ts.transpileModule(`${bootstrap.getText(source)}\nglobalThis.__run = bootstrap`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const calls: string[] = [], window = { kind: '真实依赖边界中的原window实例' }
  let onReady!: (client: unknown) => Promise<void>
  const supervisor = { status: 'ready', async start() { calls.push('start'); await onReady({}) }, request() { throw new Error('测试禁止任何业务请求') } }
  const probe = candidate ? { async run(actual: unknown) { assert.equal(actual, window); calls.push('run'); if (fails) throw new Error('合成失败') },
    emit(event: string, data: unknown) { assert.equal(event, 'main.probeFailed'); assert.deepEqual(JSON.parse(JSON.stringify(data)), { code: 'PROBE_FAILED' }); calls.push('failed') } } : undefined
  const context = {
    packagedRouteProbe: undefined, packagedRendererProbe: probe, coreSupervisor: undefined,
    collectionReadonlyProbe: undefined, collectionReadonlySettings: undefined,
    createCollectionReadonlySettings: () => ({ async restore() {} }),
    isUiE2e: true, isOfflineUiE2e: true, isStartupTest: false, isCredentialVaultGate: false, isCoreRestartCredentialRecoveryGate: false,
    isElectronColdStartGate: false, electronColdStartStage: undefined, isCoreCrashGate: false,
    APPLICATION_NAME: '合成应用', process: { platform: 'darwin', env: {} }, path: { join: (...parts: string[]) => parts.join('/') },
    syntheticUserDataDirectory: '/外置合成', session: { defaultSession: {} },
    app: { isPackaged: true, async whenReady() {}, setActivationPolicy(policy: string) { calls.push(`activation:${policy}`) }, setAboutPanelOptions() {}, quit() { calls.push('quit') }, on() { calls.push('activate-handler') } },
    lifecycleProbe: { mark() {} }, installApplicationMenu() {}, async installRendererProtocol() {}, installSessionSecurity() {}, installUiE2eNetworkGuard() { return {} },
    async prepareCoreDataDirectory() { return { dataDirectory: '/外置合成/data', credentialVault: { async save() {}, async delete() {} } } },
    createCoreSupervisor(_directory: unknown, options: { onReady: (client: unknown) => Promise<void> }) { calls.push('supervisor'); onReady = options.onReady; return supervisor },
    async startRecordingPrintWorker() { calls.push('print-worker') },
    async restoreProviderCredential() { calls.push('restore-credential') }, async provisionProviderCredential() { calls.push('provision-credential') },
    RoonDisplayConnection: class { async restore() { calls.push('roon-restore') } }, roonDisplayConnection: undefined,
    registerIpcHandlers() { calls.push('ipc') }, createWindow() { calls.push('window'); return window }, createTray() { calls.push('tray') },
    mainDiagnostics: { recordLifecycle() {} }, stopRecordingPrintWorker() {}, showMainWindow() {}, mainWindow: undefined,
    __run: undefined as undefined | (() => Promise<void>),
  }
  runInNewContext(compiled, context)
  return { calls, context, run: () => context.__run!(), readyAgain: () => onReady({}) }
}

test('候选执行原完整 bootstrap 和原窗口，首开及后续 onReady 不恢复凭据', async () => {
  const value = subject(true)
  await value.run(); await value.readyAgain()
  assert.deepEqual(value.calls, ['activation:regular', 'supervisor', 'start', 'print-worker', 'ipc', 'window', 'tray', 'run', 'quit', 'print-worker'])
  assert.ok(value.context.coreSupervisor)
})

test('默认 Node bootstrap 没有候选副作用，原凭据恢复与隐藏 UI 生命周期保持', async () => {
  const value = subject(false)
  await value.run(); await value.readyAgain()
  assert.deepEqual(value.calls, ['activation:accessory', 'supervisor', 'start', 'print-worker', 'provision-credential', 'ipc', 'window', 'tray', 'activate-handler', 'print-worker', 'restore-credential'])
})

test('候选原控件脚本失败只记固定失败，仍走原 app.quit 收口而不直调 exit', async () => {
  const value = subject(true, true)
  await value.run()
  assert.deepEqual(value.calls.slice(-3), ['run', 'failed', 'quit'])
})
