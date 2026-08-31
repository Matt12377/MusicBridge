import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { readStartupTestConfiguration } from '../src/main/startup-test-config.js'
import * as startupConfiguration from '../src/main/startup-test-config.js'

// 执行 Main 的原始顶层配置与 bootstrap；Host 不打开 Electron 或真实默认目录。
function mainStartupHost(environment: NodeJS.ProcessEnv, options: {
  ready?: boolean
  alreadyReady?: boolean
  failPath?: string
  writes?: Array<[string, string]>
} = {}) {
  const sourceText = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const configStart = source.statements.findIndex(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'startupTestConfiguration'))
  const configEnd = source.statements.findIndex(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'mainWindow'))
  assert.ok(configStart >= 0 && configEnd > configStart)
  const functions = ['bootstrap', 'installRendererProtocol', 'installSessionSecurity'].map(name => {
    const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    assert.ok(declaration, `必须执行现有 Main 函数 ${name}`)
    return declaration.getText(source)
  })
  const compiled = ts.transpileModule([
    ...source.statements.slice(configStart, configEnd).map(statement => statement.getText(source)),
    ...functions,
    '({ bootstrap })',
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const paths: Record<string, string> = { userData: 'default-user-data', sessionData: 'default-session-data' }
  const writes = options.writes ?? []
  const atReady: Array<{ userData: string; sessionData: string }> = []
  const sessionPaths: string[] = []
  const stopped = new Error('Host 在业务数据准备前停止')
  const defaultSession = {
    protocol: { handle() {} },
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onHeadersReceived() {} },
  }
  const session = { get defaultSession() { sessionPaths.push(paths.sessionData!); return defaultSession } }
  let ready = options.alreadyReady ?? false
  const entry = runInNewContext(compiled, {
    ...startupConfiguration,
    readStartupTestConfiguration: () => readStartupTestConfiguration(environment),
    process: { env: environment, platform: 'darwin' },
    app: {
      isReady: () => ready,
      setPath(name: string, value: string) {
        writes.push([name, value])
        if (options.failPath === name) throw new Error('Host 路径绑定失败')
        paths[name] = value
      },
      getPath() { throw new Error('早期隔离不应取得默认用户目录') },
      whenReady() {
        atReady.push({ userData: paths.userData!, sessionData: paths.sessionData! })
        if (!options.ready) return new Promise<void>(() => {})
        ready = true
        return Promise.resolve()
      },
      setAboutPanelOptions() {}, setActivationPolicy() {},
    },
    path, currentDirectory: '/synthetic/main', APPLICATION_NAME: 'Synthetic',
    RENDERER_SCHEME: 'musicbridge', realpath: async (value: string) => value,
    protocol: { handle: () => session.defaultSession.protocol.handle() }, session,
    buildContentSecurityPolicy: () => 'default-src none',
    createLifecycleProbe: () => ({ mark() {} }), installApplicationMenu() {},
    prepareCoreDataDirectory: async () => { throw stopped },
  }) as { bootstrap(): Promise<void> }
  return { ...entry, paths, writes, atReady, sessionPaths, stopped }
}

for (const mode of ['startup', 'ui'] as const) {
  test(`${mode}实际Main在首次whenReady前已绑定userData和sessionData`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), mode === 'startup' ? 'musicbridge-task036-startup-' : 'musicbridge-ui-e2e-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const environment = mode === 'startup'
      ? { MUSIC_BRIDGE_STARTUP_TEST: '1', MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: directory }
      : { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory }
    const host = mainStartupHost(environment)
    void host.bootstrap()
    const canonical = realpathSync(directory)
    assert.deepEqual(host.atReady, [{ userData: canonical, sessionData: canonical }])
    assert.deepEqual(host.writes, [['userData', canonical], ['sessionData', canonical]])
  })
}

test('实际protocol.handle与defaultSession首次获取均使用已隔离路径', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-diagnostics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const host = mainStartupHost({ MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory }, { ready: true })
  await assert.rejects(host.bootstrap(), error => error === host.stopped)
  assert.deepEqual(host.sessionPaths, [realpathSync(directory), realpathSync(directory)])
})

test('UI未给目录时顶层同步创建自有临时目录，重复bootstrap不再次创建或切路径', async t => {
  const host = mainStartupHost({ MUSIC_BRIDGE_UI_E2E: '1' })
  const directory = host.paths.userData!
  if (/^musicbridge-ui-e2e-[A-Za-z0-9._-]+$/.test(path.basename(directory))) {
    t.after(() => rm(directory, { recursive: true, force: true }))
  }
  assert.match(path.basename(directory), /^musicbridge-ui-e2e-[A-Za-z0-9._-]+$/)
  assert.equal(path.dirname(realpathSync(directory)), realpathSync(os.tmpdir()))
  void host.bootstrap()
  void host.bootstrap()
  assert.deepEqual(host.atReady, [
    { userData: directory, sessionData: directory },
    { userData: directory, sessionData: directory },
  ])
  assert.deepEqual(host.writes, [['userData', directory], ['sessionData', directory]])
})

test('普通Main启动不创建测试目录、不读取或修改默认路径', () => {
  const host = mainStartupHost({})
  void host.bootstrap()
  assert.deepEqual(host.writes, [])
  assert.deepEqual(host.atReady, [{ userData: 'default-user-data', sessionData: 'default-session-data' }])
})

test('非法测试目录在任何路径切换与ready调用前拒绝', () => {
  const writes: Array<[string, string]> = []
  assert.throws(() => mainStartupHost({ MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: '/Users/Shared' }, { writes }), /temporary directory name/u)
  assert.throws(() => mainStartupHost({ MUSIC_BRIDGE_STARTUP_TEST: '1' }, { writes }), /required/u)
  assert.deepEqual(writes, [])
})

test('测试路径初始化过晚或任一路径绑定失败时拒绝继续启动', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const environment = { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory }
  const writes: Array<[string, string]> = []
  assert.throws(() => mainStartupHost(environment, { alreadyReady: true, writes }), /ready/u)
  assert.deepEqual(writes, [])
  for (const failPath of ['userData', 'sessionData']) {
    assert.throws(() => mainStartupHost(environment, { failPath }), /路径绑定失败/u)
  }
})

test('具有合法临时名称的普通文件不是测试目录，不得发生部分路径切换', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'musicbridge-ui-e2e-file')
  await writeFile(file, 'synthetic')
  const writes: Array<[string, string]> = []
  assert.throws(() => mainStartupHost({ MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: file }, { writes }), /directory/u)
  assert.deepEqual(writes, [])
})

test('V3 UI 测试的持久库存只使用独立临时目录，普通启动不接受测试路径', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-'))
  try {
    const environment = { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory }
    assert.equal((readStartupTestConfiguration(environment) as { uiE2eUserDataDirectory?: string }).uiE2eUserDataDirectory, realpathSync(directory))
    assert.throws(() => readStartupTestConfiguration({ MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory }), /UI 测试/u)
    assert.throws(() => readStartupTestConfiguration({ ...environment, MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: '/Users/Shared' }), /temporary directory name/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('startup configuration accepts a bounded cold-start stage and temporary userData directory', async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'musicbridge-task036-cold-start-'),
  )
  try {
    assert.deepEqual(
      readStartupTestConfiguration({
        MUSIC_BRIDGE_STARTUP_TEST: '1',
        MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: userDataDirectory,
        MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE: 'restore',
      }),
      {
        isStartupTest: true,
        userDataDirectory: realpathSync(userDataDirectory),
        coreCrashGate: false,
        credentialVaultGate: false,
        coreRestartCredentialRecoveryGate: false,
        electronColdStartStage: 'restore',
      },
    )
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true })
  }
})

test('startup configuration rejects an unbounded userData path and an invalid stage', async () => {
  assert.throws(
    () =>
      readStartupTestConfiguration({
        MUSIC_BRIDGE_STARTUP_TEST: '1',
        MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: path.join(os.tmpdir(), 'musicbridge-task036-invalid'),
      }),
    /invalid temporary directory name/,
  )
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'musicbridge-task036-startup-'),
  )
  try {
    assert.throws(
      () =>
        readStartupTestConfiguration({
          MUSIC_BRIDGE_STARTUP_TEST: '1',
          MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: userDataDirectory,
          MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE: 'unknown',
        }),
      /must be seed or restore/,
    )
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true })
  }
})

test('startup configuration rejects startup-only variables outside startup test mode', () => {
  assert.throws(
    () =>
      readStartupTestConfiguration({
        MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE: '1',
      }),
    /require MUSIC_BRIDGE_STARTUP_TEST=1/,
  )
  assert.throws(
    () => readStartupTestConfiguration({ MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE: '1' }),
    /obsolete/,
  )
})
