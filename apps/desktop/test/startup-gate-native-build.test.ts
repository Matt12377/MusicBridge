import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// 执行真实启动脚本控制流；原生包/进程替身只记录顺序，不接触真实用户资料或Electron。
async function startupGate(mode: 'development' | 'production', fails = '') {
  const text = readFileSync(new URL('../scripts/startup-gate.mjs', import.meta.url), 'utf8')
  const source = ts.createSourceFile('startup-gate.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const body = source.statements.filter(node => !ts.isImportDeclaration(node) && !(ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => value.name.getText(source) === 'desktopRoot'))).map(node => node.getText(source)).join('\n')
  const calls: string[] = [], childEnvironments: Record<string, string>[] = []
  const process = { argv: ['node', 'startup-gate.mjs', mode, '--keychain=mock'], env: { NETEASE_COOKIE: 'synthetic-only-never-forward' }, platform: 'darwin', exitCode: 0,
    exit() { assert.fail('合成Gate不应直接终止测试Host') } }
  const step = (name: string) => async (directory: string) => {
    assert.equal(directory, '/synthetic/desktop'); calls.push(name)
    if (fails === name) throw new Error('synthetic failure')
  }
  const result = runInNewContext(`(async () => { ${body}\nreturn process.exitCode })()`, {
    process, path, desktopRoot: '/synthetic/desktop', console: { log() {}, error() {} }, os: { tmpdir: () => '/synthetic/tmp' },
    mkdtemp: async (prefix: string) => { assert.match(prefix, /musicbridge-task036-startup-$/u); calls.push('profile'); return prefix + 'isolated' },
    verifiedElectronExecution: () => { calls.push('identity'); return { executablePath: '/synthetic/official-electron' } },
    parseTestKeychainMode: (args: string[]) => { assert.deepEqual(Array.from(args), ['--keychain=mock']); return 'mock' },
    testElectronArguments: (args: string[], keychain: string) => { assert.equal(keychain, 'mock'); return [...args, '--use-mock-keychain'] },
    captureNativeCue: step('capture-cue'), captureNativeLocalAudioTags: step('capture-tags'), captureNativeLibraryWatch: step('capture-watch'),
    sealNativeCueBuild: step('seal-cue'), sealNativeLocalAudioTagsBuild: step('seal-tags'), sealNativeLibraryWatchBuild: step('seal-watch'),
    runStartupProcess: async (command: string, args: string[], options: { env: Record<string, string>; outputLimitBytes?: number }) => {
      const kind = command === '/synthetic/official-electron' ? 'launch' : 'build'; calls.push(kind)
      if (kind === 'build') { assert.equal(command, '/synthetic/desktop/node_modules/.bin/electron-vite'); assert.deepEqual(Array.from(args), ['build', '--mode', mode]) }
      else {
        assert.deepEqual(Array.from(args), ['dist/main/index.js', '--use-mock-keychain']); childEnvironments.push(options.env)
        assert.equal(options.outputLimitBytes, 128 * 1024)
        assert.equal(options.env.MUSIC_BRIDGE_STARTUP_TEST, '1'); assert.equal(options.env.MUSIC_BRIDGE_CORE_TEST_MODE, '1')
        assert.equal(options.env.MUSIC_BRIDGE_STARTUP_USER_DATA_DIR, '/synthetic/tmp/musicbridge-task036-startup-isolated')
        assert.equal(Object.hasOwn(options.env, 'NETEASE_COOKIE'), false)
      }
      return { failure: fails === kind ? 'process-exit' : null, closed: true, code: fails === kind ? 1 : 0, signal: null, markerSeen: true }
    },
  }, { timeout: 1000 }) as Promise<number>
  return { code: await result, calls, childEnvironments }
}

const capture = ['identity', 'profile', 'capture-cue', 'capture-tags', 'capture-watch']
const build = [...capture, 'build']
const sealed = [...build, 'seal-cue', 'seal-tags', 'seal-watch']
for (const mode of ['development', 'production'] as const) test(`${mode}启动Gate在vite前捕获同原pin、成功后seal再启动隔离实例`, async () => {
  const value = await startupGate(mode)
  assert.equal(value.code, 0); assert.deepEqual(value.calls, [...sealed, 'launch']); assert.equal(value.childEnvironments.length, 1)
})

test('原生捕获拒绝时不构建、不seal、不启动', async () => {
  const value = await startupGate('production', 'capture-tags')
  assert.equal(value.code, 1); assert.deepEqual(value.calls, capture.slice(0, 4))
})

test('vite失败时不seal、不启动半成品', async () => {
  const value = await startupGate('production', 'build')
  assert.equal(value.code, 1); assert.deepEqual(value.calls, build)
})

test('seal不能确认原pin时不启动或重新捕获旁边的包', async () => {
  const value = await startupGate('development', 'seal-tags')
  assert.equal(value.code, 1); assert.deepEqual(value.calls, sealed.slice(0, -1))
})

test('完整构建后真实子进程失败仍报告失败而不变为成功', async () => {
  const value = await startupGate('development', 'launch')
  assert.equal(value.code, 1); assert.deepEqual(value.calls, [...sealed, 'launch'])
})
