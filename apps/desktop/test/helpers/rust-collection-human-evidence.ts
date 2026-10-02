import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export type SessionMode = 'node100' | 'rust100' | 'rust2000' | 'rust5000'
export type SessionState = 'preflight' | 'starting' | 'ready' | 'closing' | 'closed' | 'failed'
export interface FileIdentity { path: string; sha256: string; bytes?: number }
export interface ElectronEntry { path: string; kind: 'file' | 'symlink'; sha256?: string; bytes?: number; target?: string }
export interface ElectronManifest {
  schemaVersion: 1; task: 'RUST-010'; root: string; sourceRoot: string; entries: ElectronEntry[]; fileCount: number
  executable: { path: string; sha256: string; bytes: number }
  sourceDestinationAndSourceAfterEqual: boolean; implicitDownload: boolean; installerExecuted: boolean
}
export interface DriverManifest {
  schemaVersion: 1; task: 'RUST-010'; baseSha: string; sourceRoot: string; sources: FileIdentity[]; sourceAggregateSha256: string
  componentManifestPath: string; componentManifestSha256: string; electronManifestPath: string; electronManifestSha256: string
  binaryPath: string; binarySha256: string
  launcher: { path: string; sha256: string; bytes: number; mode: 448; sessionParent: string }
}
export interface ComponentManifest {
  schemaVersion: number; task: string; sourceSha: string; sources: FileIdentity[]; artifacts: FileIdentity[]; sourceAggregateSha256: string
  binaryPath: string; binarySha256: string; staticProfiles: { profile: string; maxModels: number; maxJsonBytes: number; binarySha256: string }[]
}
export interface HumanSessionIdentity {
  driverManifestPath: string; driverManifestSha256: string; driverManifest: DriverManifest
  componentManifest: ComponentManifest; electronManifest: ElectronManifest
  componentOutput: string; electronExecutablePath: string
  runtimeLinks: HumanRuntimeLinks
}
export interface HumanRuntimeLinks {
  outputNodeModules: { path: string; target: string; realPath: string }
  contracts: { path: string; target: string; realPath: string; resolvedEntry: string }
}
export interface SessionObservation { sequence: number; elapsedMs: number; event: string; [key: string]: unknown }
export interface RouterStatus {
  phase: string; generation: number; epoch: string; datasetId: string; snapshotId?: string; revision?: string
}
export interface SessionHostSnapshot {
  rustConfigured: boolean; configuredModels: number; observations: SessionObservation[]
  controller?: { phase: string; router?: RouterStatus }
}
export interface SessionControl {
  sequence: number; command: 'status' | 'refresh' | 'quit'; source: 'terminal' | 'automated-smoke' | 'expiry' | 'application-menu'
  startedMs: number; completedMs: number; outcome: 'success' | 'rejected'
}
export interface SessionBoundary {
  policy: string; sessionId: string; installedBeforeVisible: boolean; visibleBeforeInstallation: boolean
  dialogBlocked: boolean; futureRegistrationsGuarded: boolean; productionHandlersPreserved: boolean; trayPlayback: string
  registeredChannels: string[]; allowedChannels: string[]; conditionalChannels: string[]; conditionalOutboxCommands: string[]; blockedChannels: string[]
  blockedAttempts: { sequence: number; channel: string; code: string; requestCommand?: string }[]
}
export interface HumanSignalOwnership {
  dependencyPath: string; dependencySha256: string; version: string
  preservedAtStart: { SIGINT: number; SIGTERM: number; SIGHUP: number }
  suppressed: { signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'; name: string; sourceSha256: string }[]
  restored: boolean
}
export interface HumanSessionReceipt {
  schemaVersion: 1; task: 'RUST-010'; sessionId: string; state: SessionState; mode: SessionMode; identity: HumanSessionIdentity
  sessionRoot: string; profile: string; profileWasFresh: boolean
  seed: { models: number; writer: 'Node-before-Main'; closedBeforeLaunch: boolean; [key: string]: unknown }
  visibleWindow: { browserWindowId: number; electronPid: number; isVisible: boolean; isFocused: boolean; title: string; url: string; mounted: boolean; models: number }
  runtimeVersions: { node: string; electron: string; chrome: string }
  budget: { durationMs: number; kind: 'owner-session' | 'automated-smoke'; startedMs: number; deadlineMs: number }
  host: SessionHostSnapshot; main: { event: string; [key: string]: unknown }[]; controls: SessionControl[]; boundary: SessionBoundary; signalOwnership: HumanSignalOwnership
  ownerAcceptance: 'NOT_RUN'; productionDefault: 'Node'; realServices: 'NOT_RUN'; systemKeychain: 'NOT_RUN'; installedApplication: 'NOT_CHANGED'
  readinessReceiptPath?: string; readinessReceiptSha256?: string; coreExit?: number
  close?: { method: 'app.quit'; requestedBy: SessionControl['source']; electronPid: number; electronExit: { code: number | null; signal: string | null }; forcedCleanup: boolean; beforeQuitObserved: boolean; lifecyclePath: string; lifecycleSha256: string }
}

const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine'
const binaryPin = '03624a10a1c9314842907142fd0cfb3931dd68edcb88a5dff6ea645832124a14'
const electronPin = '1af684f056a8eb13e49fbd677072e437316086b076e3b9b92de3ddb343edc5b1'
const playwrightCorePin = '9393fa79e1c67c74edc26b610d65a4f7ed73d345a762465cc88340a33a2454ac'
const baseSha = '5fc369a46b37fec4ad50ebb909aa1f2c4bc09d09'
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const nodeExecutable = '/Users/yihe/.nvm/versions/node/v22.23.2/bin/node'
const driverInputs = ['apps/desktop/scripts/rust-collection-human-session.ts', 'apps/desktop/e2e/rust-collection-human.tsconfig.json',
  'apps/desktop/test/helpers/rust-collection-human-evidence.ts', 'apps/desktop/test/rust-core/rust-collection-human-session.test.ts',
  'apps/desktop/test/rust-core/rust-collection-human-evidence.test.ts', 'scripts/ci/verify-rust-human-session.mjs', 'package.json', 'pnpm-lock.yaml']
const allowedScopeChannels = [
  'app:get-info', 'app:set-appearance-theme', 'core:get-health', 'core:get-state', 'core:ping',
  'auth:get-state', 'account:get-state', 'playback:get-state', 'playback:get-stream-snapshot',
  'remote-core:get-state', 'roon:list-zones', 'lyrics:match:get',
  'commandOutbox:context', 'commandOutbox:overview', 'commandOutbox:acknowledge',
  'collection:list', 'collection:detail', 'collection:copy', 'collection:photo',
  'collectionProgress:wants', 'collectionProgress:wantHistory', 'collectionProgress:current',
  'collectionProgress:snapshots', 'collectionProgress:snapshot', 'collectionProgress:modelLengths',
  'referenceCatalog:sources', 'referenceCatalog:source', 'referenceCatalog:sourceZipReceipts',
  'referenceCatalog:history', 'referenceCatalog:revision', 'referenceCatalog:snapshot',
]
export const humanSessionFileSha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const aggregate = (entries: FileIdentity[]) => createHash('sha256').update(JSON.stringify(entries)).digest('hex')
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const events = (receipt: HumanSessionReceipt, name: string) => receipt.host.observations.filter(value => value.event === name)

/** 独立只读解析固定依赖与完整函数源码，不借driver验证器，也不加载依赖模块。 */
export function verifyHumanSignalOwnership(evidence: HumanSignalOwnership): void {
  assert.ok(evidence, '缺少实际launch信号所有权收据。')
  const fromHelper = createRequire(import.meta.url), testEntry = fromHelper.resolve('@playwright/test')
  const playwrightEntry = createRequire(testEntry).resolve('playwright')
  const coreEntry = createRequire(playwrightEntry).resolve('playwright-core'), coreRoot = path.dirname(coreEntry)
  const bundle = path.join(coreRoot, 'lib/coreBundle.js')
  for (const entry of [testEntry, playwrightEntry, coreEntry]) {
    assert.equal(JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version, '1.62.1', '实际Playwright版本漂移。')
  }
  assert.equal(humanSessionFileSha256(bundle), playwrightCorePin, '实际Playwright完整bundle身份漂移。')
  assert.equal(evidence.dependencyPath, bundle, '信号所有权dependency路径漂移。')
  assert.equal(evidence.dependencySha256, playwrightCorePin, '信号所有权bundle身份漂移。')
  assert.equal(evidence.version, '1.62.1', '信号所有权版本漂移。')
  assert.equal(evidence.restored, true, '信号注册方法没有恢复原身份。')
  const signals = { SIGINT: 'sigintHandler', SIGTERM: 'sigtermHandler', SIGHUP: 'sighupHandler' } as const
  assert.deepEqual(Object.keys(evidence.preservedAtStart).sort(), Object.keys(signals).sort(), '原信号监听器全集缺失。')
  for (const signal of Object.keys(signals) as (keyof typeof signals)[]) {
    assert.ok(positive(evidence.preservedAtStart[signal]), '驱动原信号监听器未保留：' + signal)
  }
  const source = readFileSync(bundle, 'utf8')
  const expected = Object.entries(signals).map(([signal, name]) => {
    // 固定bundle中的顶层函数以行首闭括号结束；嵌套闭括号缩进，不截断完整函数。
    const declarations = source.match(new RegExp('^function ' + name + '\\(\\) \\{[\\s\\S]*?^\\}', 'gm'))
    assert.equal(declarations?.length, 1, '固定信号完整函数声明不唯一：' + name)
    return { signal, name, sourceSha256: createHash('sha256').update(declarations![0]!).digest('hex') }
  })
  assert.equal(new Set(expected.map(value => value.sourceSha256)).size, 3, '完整信号函数源码身份不唯一。')
  assert.ok(Array.isArray(evidence.suppressed) && evidence.suppressed.length === 3, '信号抑制记录不完整。')
  assert.equal(new Set(evidence.suppressed.map(value => value.signal)).size, 3, '信号抑制记录重复。')
  const ordered = <T extends { signal: string }>(values: T[]) => [...values].sort((a, b) => a.signal.localeCompare(b.signal))
  assert.deepEqual(ordered(evidence.suppressed), ordered(expected), '信号抑制并非当前固定函数源码。')
}

function within(parent: string, file: string, label: string): string {
  assert.ok(path.isAbsolute(parent) && path.isAbsolute(file), label + '必须为绝对路径。')
  // 越界路径先作词法拒绝，不查询真实用户目录；范围内仍须防止链接逃逸。
  assert.ok(path.resolve(file).startsWith(path.resolve(parent) + path.sep), label + '词法路径越界。')
  const root = realpathSync(parent), resolved = realpathSync(file)
  assert.ok(resolved.startsWith(root + path.sep), label + '实际路径越界。')
  return resolved
}
function external(file: string, label: string): string { return within(externalRoot, file, label) }
function relative(parent: string, value: string): string {
  assert.ok(typeof value === 'string' && value && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), '身份清单相对路径越界。')
  return within(parent, path.join(parent, value), '身份清单')
}
function files(parent: string, entries: FileIdentity[], label: string): void {
  assert.ok(Array.isArray(entries) && entries.length > 0, label + '清单缺失。')
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length, label + '清单重复。')
  for (const entry of entries) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    const file = relative(parent, entry.path)
    assert.equal(humanSessionFileSha256(file), entry.sha256, label + '身份漂移：' + entry.path)
    if (entry.bytes !== undefined) assert.equal(statSync(file).size, entry.bytes, label + '长度漂移。')
  }
}
function treeFiles(root: string, directory: string, includeBytes: boolean): FileIdentity[] {
  const output: FileIdentity[] = []
  function walk(current: string): void {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name), details = lstatSync(file)
      assert.equal(details.isSymbolicLink(), false, '完整产物/编译模块库存不得含链接。')
      if (details.isDirectory()) walk(file)
      else {
        assert.ok(details.isFile())
        output.push({ path: path.relative(root, file), sha256: humanSessionFileSha256(file), ...(includeBytes ? { bytes: details.size } : {}) })
      }
    }
  }
  walk(directory)
  return output
}
/** 核实际Main解析依赖的链接本体与目标；不加载模块、不修改任何原链接。 */
export function verifyHumanRuntimeLinks(options: { sourceRoot: string; componentOutput: string }, expected?: HumanRuntimeLinks): HumanRuntimeLinks {
  const sourceRoot = realpathSync(options.sourceRoot), componentOutput = external(options.componentOutput, '隔离组件目录')
  assert.equal(sourceRoot, realpathSync(repository))
  const outputLink = path.join(componentOutput, 'node_modules'), desktopModules = path.join(sourceRoot, 'apps/desktop/node_modules')
  assert.equal(lstatSync(outputLink).isSymbolicLink(), true, '组件node_modules必须是冻结原链接。')
  assert.equal(readlinkSync(outputLink), desktopModules, '组件node_modules链接目标漂移。')
  assert.equal(realpathSync(outputLink), realpathSync(desktopModules), '组件node_modules实际指向漂移。')
  const contractsLink = path.join(desktopModules, '@music-bridge/contracts'), contractsRoot = path.join(sourceRoot, 'packages/contracts')
  assert.equal(lstatSync(contractsLink).isSymbolicLink(), true, 'contracts必须是当前工作树包链接。')
  assert.equal(readlinkSync(contractsLink), path.relative(path.dirname(contractsLink), contractsRoot), 'contracts链接本体目标漂移。')
  assert.equal(realpathSync(contractsLink), realpathSync(contractsRoot), 'contracts实际解析根漂移。')
  // 生产Main使用ESM import条件；contracts只导出import入口，不能使用require解析。
  // 两个调用位置的首个可用node_modules均已固定为同一个Desktop目录，拒绝更近的shadow。
  for (const candidate of [path.join(componentOutput, 'main/node_modules'), path.join(sourceRoot, 'apps/desktop/test/node_modules'),
    path.join(sourceRoot, 'apps/desktop/test/helpers/node_modules')]) {
    assert.equal(existsSync(candidate), false, 'Main/验收器存在更近的未绑定dependency入口。')
  }
  const resolvedEntry = fileURLToPath(import.meta.resolve('@music-bridge/contracts'))
  assert.equal(realpathSync(resolvedEntry), realpathSync(path.join(contractsRoot, 'dist/index.js')), 'Main解析了未绑定的contracts模块。')
  const actual: HumanRuntimeLinks = { outputNodeModules: { path: outputLink, target: readlinkSync(outputLink), realPath: realpathSync(outputLink) },
    contracts: { path: contractsLink, target: readlinkSync(contractsLink), realPath: realpathSync(contractsLink), resolvedEntry: realpathSync(resolvedEntry) } }
  if (expected) assert.deepEqual(expected, actual, '运行期dependency链接收据身份漂移。')
  return actual
}
/** 独立重算原009构建入口的完整输入闭包及实际输出；清单不能自行删减入口。 */
export function verifyHumanComponentManifest(component: ComponentManifest, options: { sourceRoot: string; componentOutput: string }): void {
  const { sourceRoot, componentOutput } = options
  assert.equal(realpathSync(sourceRoot), realpathSync(repository))
  external(componentOutput, '隔离组件目录')
  verifyHumanRuntimeLinks(options)
  const sourceScopes = ['apps/desktop/src', 'apps/desktop/e2e', 'apps/desktop/test', 'apps/desktop/electron-gate', 'apps/desktop/scripts',
    'packages/bridge-core/src', 'packages/bridge-core/test/helpers', 'packages/contracts/src',
    'scripts/ci/rust-collection-evidence.mjs', 'scripts/ci/test/rust-collection-evidence.test.mjs']
  const fromGit = execFileSync('git', ['-C', sourceRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...sourceScopes], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  const extra = ['apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'packages/bridge-core/package.json', 'packages/contracts/package.json', 'pnpm-lock.yaml']
  const sources = [...new Set([...fromGit, ...extra])].map(file => ({ path: file, sha256: humanSessionFileSha256(relative(sourceRoot, file)) }))
  sources.push(...treeFiles(sourceRoot, path.join(sourceRoot, 'packages/contracts/dist'), false))
  const ordered = (entries: FileIdentity[]) => [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  assert.deepEqual(ordered(component.sources), ordered(sources), '编译源码完整闭包清单不匹配。')
  assert.equal(aggregate(component.sources), component.sourceAggregateSha256, '组件聚合身份错误。')
  const artifacts = ['main', 'preload', 'renderer'].flatMap(name => treeFiles(componentOutput, path.join(componentOutput, name), true))
  const packageFile = path.join(componentOutput, 'package.json')
  artifacts.push({ path: 'package.json', sha256: humanSessionFileSha256(packageFile), bytes: statSync(packageFile).size })
  assert.deepEqual(ordered(component.artifacts), ordered(artifacts), '编译产物完整库存清单不匹配。')
  const required = ['main/index.js', 'main/dataset-owner.js', 'preload/index.cjs', 'renderer/index.html',
    'main/private-rust-collection-main-host-wrapper.mjs', 'main/private-rust-collection-node-main-wrapper.mjs',
    'main/private-rust-collection-node.js', ...[100, 2000, 5000].flatMap(models => [
      `main/private-rust-collection-main-${models}-wrapper.mjs`, `main/private-rust-collection-core-${models}.js`])]
  for (const entry of required) assert.ok(component.artifacts.some(value => value.path === entry), '静态模式必要入口缺失：' + entry)
  assert.equal(component.artifacts.filter(value => /^main\/private-rust-collection-host-[\w-]+\.js$/.test(value.path)).length, 1, '静态模式共享host编译入口缺失。')
}
function readJson<T>(file: string, expectedHash: string, label: string): T {
  assert.match(expectedHash, /^[a-f0-9]{64}$/)
  assert.equal(humanSessionFileSha256(file), expectedHash, label + 'manifest 身份漂移。')
  return JSON.parse(readFileSync(file, 'utf8')) as T
}
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
/** 固定可审阅启动脚本；参数只通过原严格CLI，不能选择自由命令。 */
export function humanSessionLauncherContents(options: { driverManifestPath: string; sourceRoot: string; sessionParent: string }): string {
  const gateRoot = path.dirname(options.driverManifestPath), cacheRoot = path.join(externalRoot, 'Caches')
  const environment: Record<string, string> = { TMPDIR: path.join(gateRoot, 'tmp'), DEV_BUILD_ROOT: externalRoot, DEV_CACHE_ROOT: cacheRoot,
    COREPACK_HOME: path.join(cacheRoot, 'corepack'), npm_config_cache: path.join(cacheRoot, 'npm'),
    ELECTRON_CACHE: path.join(cacheRoot, 'Electron'), electron_config_cache: path.join(cacheRoot, 'Electron'),
    XDG_CACHE_HOME: path.join(cacheRoot, 'XDG'), NODE_COMPILE_CACHE: path.join(cacheRoot, 'Node'), ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
  return ['#!/bin/zsh', 'set -eu', ...Object.entries(environment).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `exec ${shellQuote(nodeExecutable)} --import ${shellQuote(path.join(options.sourceRoot, 'apps/desktop/node_modules/tsx/dist/loader.mjs'))} ${shellQuote(path.join(options.sourceRoot, 'apps/desktop/scripts/rust-collection-human-session.ts'))} ${shellQuote('--manifest=' + options.driverManifestPath)} ${shellQuote('--session-parent=' + options.sessionParent)} "$@"`, ''].join('\n')
}
function electronTree(manifest: ElectronManifest): void {
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.task, 'RUST-010')
  assert.equal(manifest.sourceDestinationAndSourceAfterEqual, true)
  assert.equal(manifest.implicitDownload, false); assert.equal(manifest.installerExecuted, false)
  assert.ok(path.isAbsolute(manifest.root))
  const root = realpathSync(manifest.root)
  assert.ok(root.startsWith('/Volumes/LifeWeave/'), 'Electron必须在已核实外置卷。')
  assert.equal(manifest.entries.length, 275, '完整 Electron 文件/链接数量错误。'); assert.equal(manifest.fileCount, 275)
  assert.equal(new Set(manifest.entries.map(entry => entry.path)).size, manifest.entries.length)
  function collect(treeRoot: string): ElectronEntry[] {
    const actual: ElectronEntry[] = []
    function walk(directory: string): void {
      for (const name of readdirSync(directory).sort()) {
        const file = path.join(directory, name), details = lstatSync(file), relativePath = path.relative(treeRoot, file)
        if (details.isSymbolicLink()) {
          within(treeRoot, file, 'Electron链接')
          actual.push({ path: relativePath, kind: 'symlink', target: readlinkSync(file) })
        } else if (details.isDirectory()) walk(file)
        else {
          assert.ok(details.isFile(), 'Electron清单包含非普通文件。')
          actual.push({ path: relativePath, kind: 'file', sha256: humanSessionFileSha256(file), bytes: details.size })
        }
      }
    }
    walk(treeRoot)
    return actual
  }
  const order = (entries: ElectronEntry[]) => [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  assert.deepEqual(order(manifest.entries), order(collect(root)), '完整 Electron 文件/链接身份漂移。')
  assert.ok(realpathSync(manifest.sourceRoot).startsWith('/Volumes/LifeWeave/'), 'Electron复制源必须在外置卷。')
  assert.deepEqual(order(manifest.entries), order(collect(realpathSync(manifest.sourceRoot))), 'Electron复制源身份漂移。')
  within(root, manifest.executable.path, 'Electron executable')
  assert.equal(manifest.executable.sha256, electronPin, 'Electron固定pin错误。')
  assert.equal(humanSessionFileSha256(manifest.executable.path), electronPin, 'Electron executable身份漂移。')
  assert.equal(statSync(manifest.executable.path).size, manifest.executable.bytes)
}

/** 任一 seed/进程启动之前调用。仅读取已冻结清单，不生成或修复身份。 */
export function verifyHumanSessionIdentity(options: { driverManifestPath: string; driverManifestSha256?: string }): HumanSessionIdentity {
  assert.match(process.version, /^v22\./, '会话身份预检必须使用Node22。')
  const manifestPath = external(options.driverManifestPath, 'driver manifest')
  const sha256 = humanSessionFileSha256(manifestPath)
  if (options.driverManifestSha256 !== undefined) assert.equal(sha256, options.driverManifestSha256, 'driver manifest身份漂移。')
  const driver = JSON.parse(readFileSync(manifestPath, 'utf8')) as DriverManifest
  assert.equal(driver.schemaVersion, 1); assert.equal(driver.task, 'RUST-010'); assert.equal(driver.baseSha, baseSha)
  assert.ok(path.isAbsolute(driver.sourceRoot) && realpathSync(driver.sourceRoot).startsWith('/Volumes/LifeWeave/'), '源码根不在外置卷。')
  assert.equal(realpathSync(driver.sourceRoot), realpathSync(repository), 'manifest不是当前driver源码树。')
  assert.equal((JSON.parse(readFileSync(path.join(driver.sourceRoot, 'package.json'), 'utf8')) as { packageManager?: string }).packageManager, 'pnpm@10.17.1', '固定pnpm声明不符。')
  files(driver.sourceRoot, driver.sources, '新driver源码')
  for (const input of driverInputs) assert.ok(driver.sources.some(entry => entry.path === input), '本期driver输入未绑定：' + input)
  assert.equal(aggregate(driver.sources), driver.sourceAggregateSha256, 'driver聚合身份错误。')
  const componentPath = external(driver.componentManifestPath, '组件 manifest')
  const component = readJson<ComponentManifest>(componentPath, driver.componentManifestSha256, '组件')
  assert.equal(component.schemaVersion, 1); assert.equal(component.task, 'RUST-009')
  assert.match(component.sourceSha, /^[a-f0-9]{40}$/)
  verifyHumanComponentManifest(component, { sourceRoot: driver.sourceRoot, componentOutput: path.dirname(componentPath) })
  files(driver.sourceRoot, component.sources, '组件源码'); files(path.dirname(componentPath), component.artifacts, '编译产物')
  for (const input of ['main/index.js', 'main/dataset-owner.js', 'preload/index.cjs', 'renderer/index.html']) {
    assert.ok(component.artifacts.some(entry => entry.path === input), '实际Main/Owner/preload/Renderer产物未绑定：' + input)
  }
  assert.equal(driver.binarySha256, binaryPin); assert.equal(component.binarySha256, binaryPin)
  assert.equal(driver.binaryPath, component.binaryPath)
  external(driver.binaryPath, 'Rust binary'); assert.equal(humanSessionFileSha256(driver.binaryPath), binaryPin, 'Rust binary身份漂移。')
  assert.deepEqual(component.staticProfiles, [{ profile: 'default', maxModels: 2000, maxJsonBytes: 4194304, binarySha256: binaryPin },
    { profile: 'v3-5000', maxModels: 5000, maxJsonBytes: 8388608, binarySha256: binaryPin }], '静态Rust profile漂移。')
  const electronPath = external(driver.electronManifestPath, 'Electron manifest')
  const electron = readJson<ElectronManifest>(electronPath, driver.electronManifestSha256, 'Electron')
  electronTree(electron)
  assert.ok(driver.launcher, '正式准入缺少固定人工启动器。')
  {
    const launcher = driver.launcher, launcherPath = external(launcher.path, '人工启动器')
    assert.equal(lstatSync(launcher.path).isSymbolicLink(), false, '人工启动器不得是链接。')
    assert.equal(path.dirname(launcherPath), path.dirname(manifestPath), '人工启动器不在本轮Gate目录。')
    assert.equal(path.dirname(external(launcher.sessionParent, '人工会话父目录')), path.dirname(manifestPath))
    assert.equal(launcher.mode, 448); assert.equal(statSync(launcherPath).mode & 0o777, 448, '人工启动器权限不符。')
    assert.equal(humanSessionFileSha256(launcherPath), launcher.sha256, '人工启动器身份漂移。')
    assert.equal(statSync(launcherPath).size, launcher.bytes)
    assert.equal(readFileSync(launcherPath, 'utf8'), humanSessionLauncherContents({ driverManifestPath: manifestPath, sourceRoot: driver.sourceRoot, sessionParent: launcher.sessionParent }), '人工启动器contents不符合固定合同。')
  }
  return { driverManifestPath: manifestPath, driverManifestSha256: sha256, driverManifest: driver, componentManifest: component, electronManifest: electron,
    componentOutput: path.dirname(componentPath), electronExecutablePath: electron.executable.path,
    runtimeLinks: verifyHumanRuntimeLinks({ sourceRoot: driver.sourceRoot, componentOutput: path.dirname(componentPath) }) }
}

function modeModels(mode: SessionMode): number {
  assert.ok(['node100', 'rust100', 'rust2000', 'rust5000'].includes(mode), '会话模式不属于静态闭集。')
  return mode === 'rust5000' ? 5000 : mode === 'rust2000' ? 2000 : 100
}
function boundaryProof(receipt: HumanSessionReceipt): void {
  const boundary = receipt.boundary
  assert.ok(boundary, '缺少实际Main能力边界。')
  assert.equal(boundary.policy, 'synthetic-collection-only-v1'); assert.equal(boundary.sessionId, receipt.sessionId)
  for (const key of ['installedBeforeVisible', 'dialogBlocked', 'futureRegistrationsGuarded', 'productionHandlersPreserved'] as const) {
    assert.equal(boundary[key], true, '实际能力边界缺失：' + key)
  }
  assert.equal(boundary.visibleBeforeInstallation, false, '显示前未封闭范围外能力。')
  assert.equal(boundary.trayPlayback, 'original-Core-testmock-only')
  assert.deepEqual(boundary.conditionalChannels, ['commandOutbox:submit'])
  assert.deepEqual(boundary.conditionalOutboxCommands, ['collection.setPolicy'], '泛outbox绕过原policy闭集。')
  const registered = boundary.registeredChannels
  assert.ok(Array.isArray(registered) && registered.length > 0 && registered.every(value => typeof value === 'string' && value))
  assert.equal(new Set(registered).size, registered.length)
  assert.deepEqual([...registered].sort(), registered, 'Main注册全集未固定排序。')
  for (const channel of ['collection:list', 'collection:detail', 'collection:photo', 'commandOutbox:submit', 'commandOutbox:context', 'commandOutbox:acknowledge',
    'remote-core:start', 'library:read', 'collection:pick-photo', 'lyrics:display:configure']) assert.ok(registered.includes(channel), '原Main渠道未被审定：' + channel)
  assert.deepEqual(boundary.allowedChannels, allowedScopeChannels.filter(value => registered.includes(value)).sort(), 'Main开放渠道越过闭集。')
  assert.deepEqual(boundary.blockedChannels, registered.filter(value => !allowedScopeChannels.includes(value) && value !== 'commandOutbox:submit').sort(), 'Main拒绝渠道不覆盖全集。')
  assert.ok(Array.isArray(boundary.blockedAttempts))
  boundary.blockedAttempts.forEach((attempt, index) => {
    assert.equal(attempt.sequence, index + 1); assert.equal(attempt.code, 'SYNTHETIC_SCOPE_DENIED')
    assert.ok(!boundary.allowedChannels.includes(attempt.channel), '开放渠道伪称拒绝probe。')
  })
  for (const channel of ['remote-core:start', 'library:read', 'collection:pick-photo', 'lyrics:display:configure', 'native.showOpenDialog', 'native.showSaveDialog']) {
    assert.ok(boundary.blockedAttempts.some(value => value.channel === channel), '缺少真实范围外拒绝probe：' + channel)
  }
  assert.ok(boundary.blockedAttempts.some(value => value.channel === 'commandOutbox:submit' && value.requestCommand === 'collection.receive'), '缺少泛outbox非policy真实拒绝。')
}
function common(receipt: HumanSessionReceipt): void {
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.task, 'RUST-010')
  assert.equal(receipt.ownerAcceptance, 'NOT_RUN', '自动证据不能宣称Owner通过。')
  assert.equal(receipt.productionDefault, 'Node'); assert.equal(receipt.realServices, 'NOT_RUN')
  assert.equal(receipt.systemKeychain, 'NOT_RUN'); assert.equal(receipt.installedApplication, 'NOT_CHANGED')
  boundaryProof(receipt)
  verifyHumanSignalOwnership(receipt.signalOwnership)
  assert.match(receipt.sessionId, /^[a-f0-9]{8}-[a-f0-9-]{27}$/i)
  assert.deepEqual(verifyHumanSessionIdentity(receipt.identity), receipt.identity, '收据identity与本轮预检不同。')
  const sessionRoot = external(receipt.sessionRoot, '会话目录'), profile = within(sessionRoot, receipt.profile, '合成profile')
  assert.equal(lstatSync(receipt.profile).isSymbolicLink(), false, '合成profile不得是链接。')
  assert.equal(path.dirname(profile), sessionRoot); assert.match(path.basename(profile), /^musicbridge-ui-e2e-/)
  assert.equal(receipt.profileWasFresh, true, '合成profile不是全新创建。')
  const models = modeModels(receipt.mode)
  assert.equal(receipt.seed.models, models, 'seed规模与模式错配。'); assert.equal(receipt.seed.writer, 'Node-before-Main')
  assert.equal(receipt.seed.closedBeforeLaunch, true, 'seed必须在Main启动前自然关闭。')
  assert.equal(receipt.host.configuredModels, models); assert.equal(receipt.host.rustConfigured, receipt.mode !== 'node100')
  const window = receipt.visibleWindow
  assert.ok(positive(window.browserWindowId) && positive(window.electronPid), '真实窗口/进程身份缺失。')
  assert.equal(window.isVisible, true, '实际Main窗口不可见。'); assert.equal(window.isFocused, true, '实际Main窗口未focus。')
  assert.equal(window.mounted, true); assert.equal(window.models, models, '可见Vue页面规模错配。')
  assert.equal(window.url, 'musicbridge://app/index.html', '不是原生产Renderer。')
  assert.equal(window.title, `MusicBridge · 合成人工验收 · ${receipt.mode} · ${receipt.sessionId.slice(0, 8)}`, '合成窗口标题身份不匹配。')
  assert.ok(receipt.runtimeVersions.node && receipt.runtimeVersions.electron && receipt.runtimeVersions.chrome, '实际运行版本缺失。')
  const budget = receipt.budget
  assert.ok(finite(budget.startedMs) && finite(budget.deadlineMs) && positive(budget.durationMs) && budget.durationMs <= 1800000)
  assert.ok(Math.abs(budget.deadlineMs - budget.startedMs - budget.durationMs) < 0.01, '会话期限不一致。')
  assert.ok(['owner-session', 'automated-smoke'].includes(budget.kind))
  if (budget.kind === 'owner-session') assert.equal(budget.durationMs, 1800000, '人工入口必须使用30分钟预算。')
  assert.ok(Array.isArray(receipt.host.observations) && receipt.host.observations.length > 0)
  receipt.host.observations.forEach((value, index) => {
    assert.equal(value.sequence, index + 1, 'Host观察序号断裂。')
    assert.ok(finite(value.elapsedMs) && (!index || value.elapsedMs >= receipt.host.observations[index - 1]!.elapsedMs), 'Host观察时序错误。')
  })
  for (const event of ['node.spawn', 'node.prepare', 'node.boot', 'node.bootComplete']) assert.equal(events(receipt, event).length, 1, 'Node readiness缺失：' + event)
  const seeded = events(receipt, 'node.seeded')
  assert.equal(seeded.length, 1); assert.equal(seeded[0]!.models, models, '实际Owner boot库存规模错配。')
  const owner = events(receipt, 'node.spawn')[0]!
  assert.ok(positive(owner.hostPid) && positive(owner.threadId), '真实Node Owner身份缺失。')
  assert.equal(owner.nodeVersion, 'v' + receipt.runtimeVersions.node)
  assert.equal(events(receipt, 'node.fatal').length, 0, 'Node fatal不能通过会话验收。')
  for (const event of ['main.coreFork', 'main.coreSpawn']) assert.equal(receipt.main.filter(value => value.event === event).length, 1)
  assert.equal(receipt.main.find(value => value.event === 'main.coreSpawn')!.pid, owner.hostPid, 'Main/Core/Owner身份错配。')
  const replies = events(receipt, 'core.publicReply').filter(value => value.command === 'recordingPrintWorker.claim' && value.leaseNull === true && value.ok === true)
  assert.ok(replies.length >= 2, '缺少原1500ms工作器两次公开空claim。')
  for (const reply of replies) {
    const request = events(receipt, 'core.publicRequest').find(value => value.requestId === reply.requestId && value.command === 'recordingPrintWorker.claim')
    const dispatch = events(receipt, 'node.dispatch').find(value => value.requestId === reply.requestId && value.command === 'recordingPrintWorker.claim')
    const completed = events(receipt, 'node.claimComplete').find(value => value.requestId === reply.requestId && value.leaseNull === true)
    assert.ok(request && dispatch && completed && request.sequence < dispatch.sequence && dispatch.sequence < completed.sequence && completed.sequence < reply.sequence, '公开claim没有真实Node闭环。')
  }
  assert.ok(replies[1]!.elapsedMs - replies[0]!.elapsedMs >= 1000, '后台claim未覆盖原interval。')
  assert.ok(Array.isArray(receipt.controls))
  receipt.controls.forEach((control, index) => {
    assert.equal(control.sequence, index + 1); assert.ok(['status', 'refresh', 'quit'].includes(control.command), '非法terminal指令。')
    assert.ok(['terminal', 'automated-smoke', 'expiry', 'application-menu'].includes(control.source))
    assert.ok(finite(control.startedMs) && finite(control.completedMs) && control.completedMs >= control.startedMs)
    assert.ok(!index || control.startedMs >= receipt.controls[index - 1]!.completedMs, 'terminal控制未串行。')
    assert.ok(['success', 'rejected'].includes(control.outcome))
    if (control.source === 'automated-smoke') assert.equal(budget.kind, 'automated-smoke', '自动操作冒充人工动作。')
    if (['expiry', 'application-menu'].includes(control.source)) assert.equal(control.command, 'quit')
    if (index) assert.notEqual(receipt.controls[index - 1]!.command, 'quit', 'quit后仍接收指令。')
  })
  const refreshes = receipt.controls.filter(value => value.command === 'refresh')
  assert.ok(events(receipt, 'host.explicitRefresh').length >= refreshes.filter(value => value.outcome === 'success').length
    && events(receipt, 'host.explicitRefresh').length <= refreshes.length, '出现未记账的自动refresh或重放。')
  if (receipt.mode === 'node100') {
    assert.equal(receipt.host.controller, undefined, '默认Node不应有Rust controller。')
    assert.equal(events(receipt, 'rust.spawn').length, 0, '默认Node出现Rust child。')
    for (const event of ['node.export', 'node.exportLarge', 'node.exportPlain']) assert.equal(events(receipt, event).length, 0, '默认Node发生私有export。')
    assert.equal(events(receipt, 'host.explicitRefresh').length, 0)
  } else assert.ok(events(receipt, 'rust.spawn').length >= 1, '静态Rust模式缺少真实child。')
}

function rustChildren(receipt: HumanSessionReceipt, closed: boolean): void {
  const spawns = events(receipt, 'rust.spawn'), exits = events(receipt, 'rust.exit')
  if (closed) assert.equal(exits.length, spawns.length, 'Rust child退出证据不完整。')
  for (const [index, spawn] of spawns.entries()) {
    assert.ok(positive(spawn.pid)); assert.equal(spawn.liveChildren, 1, 'Rust child峰值超过一。')
    const frames = events(receipt, 'rust.frame').filter(value => value.pid === spawn.pid)
    const ack = (operation: string) => frames.filter(value => value.operation === operation && value.ok === true)
    for (const operation of ['prepare', 'commitBoot']) assert.equal(ack(operation).length, 1, '真实Rust ACK缺失：' + operation)
    assert.equal(ack('appendSnapshot').length, receipt.mode === 'rust5000' ? 40 : 0, '分块ACK与静态规模不符。')
    const boot = ack('commitBoot')[0]!
    assert.ok(spawn.sequence < ack('prepare')[0]!.sequence && ack('prepare')[0]!.sequence < boot.sequence)
    assert.ok(ack('appendSnapshot').every(value => value.sequence > ack('prepare')[0]!.sequence && value.sequence < boot.sequence))
    const exit = exits.find(value => value.pid === spawn.pid)
    if (closed || exit) {
      assert.equal(ack('close').length, 1, '真实Rust close ACK缺失。')
      assert.ok(exit && exit.code === 0 && exit.signal === null && exit.liveChildren === 0, 'Rust没有自然exit0。')
      assert.ok(boot.sequence < ack('close')[0]!.sequence && ack('close')[0]!.sequence < exit.sequence)
    }
    if (index) {
      const previousExit = exits.find(value => value.pid === spawns[index - 1]!.pid)
      assert.ok(previousExit && previousExit.sequence < spawn.sequence, '旧Rust child未退出即新建。')
    }
  }
}

/** 就绪只证明当前可见运行中状态；返回值明确不能当完整PASS。 */
export function verifyHumanSessionReadiness(receipt: HumanSessionReceipt): { phase: 'readiness'; complete: false; ownerAcceptance: 'NOT_RUN' } {
  assert.equal(receipt.state, 'ready', '进行中readiness要求ready阶段。')
  common(receipt)
  assert.equal(receipt.close, undefined, 'readiness不得伪造最终关闭。')
  for (const event of ['node.close', 'node.exit', 'node.closed']) assert.equal(events(receipt, event).length, 0, 'readiness时Owner已关闭。')
  assert.equal(receipt.main.filter(value => value.event === 'main.coreExit').length, 0, 'readiness时Core已退出。')
  assert.equal(receipt.coreExit, undefined)
  if (receipt.mode !== 'node100') {
    const router = receipt.host.controller?.router
    assert.equal(receipt.host.controller?.phase, 'ready'); assert.equal(router?.phase, 'rust')
    assert.ok(router && positive(router.generation) && [router.epoch, router.datasetId, router.snapshotId, router.revision]
      .every(value => typeof value === 'string' && value.length > 0), 'readiness scope/generation缺失。')
    const boots = events(receipt, 'rust.frame').filter(value => value.operation === 'commitBoot' && value.ok === true)
    assert.ok(boots.some(value => (value.scope as Record<string, unknown>)?.epoch === router.epoch
      && (value.scope as Record<string, unknown>)?.datasetId === router.datasetId && (value.scope as Record<string, unknown>)?.snapshotId === router.snapshotId
      && value.generation === router.generation), 'Rust boot ACK不属于实际发布scope。')
  }
  rustChildren(receipt, false)
  return { phase: 'readiness', complete: false, ownerAcceptance: 'NOT_RUN' }
}

/** 完整验收只接受已由原app.quit自然收口的会话，不提供Owner接受入口。 */
export function verifyHumanSessionEvidence(receipt: HumanSessionReceipt): { phase: 'closed'; complete: true; ownerAcceptance: 'NOT_RUN'; mode: SessionMode } {
  assert.equal(receipt.state, 'closed', '运行中或失败会话不能完整PASS。')
  common(receipt)
  assert.ok(receipt.readinessReceiptPath && receipt.readinessReceiptSha256, '缺少实际运行中readiness收据。')
  const readinessPath = within(receipt.sessionRoot, receipt.readinessReceiptPath, 'readiness收据')
  const readiness = readJson<HumanSessionReceipt>(readinessPath, receipt.readinessReceiptSha256, 'readiness')
  verifyHumanSessionReadiness(readiness)
  for (const key of ['sessionId', 'mode', 'sessionRoot', 'profile'] as const) assert.equal(readiness[key], receipt[key], 'readiness不是同一会话。')
  assert.deepEqual(readiness.identity, receipt.identity); assert.deepEqual(readiness.seed, receipt.seed)
  assert.deepEqual(readiness.signalOwnership, receipt.signalOwnership, '最终信号所有权改写了readiness历史。')
  assert.equal(readiness.visibleWindow.electronPid, receipt.visibleWindow.electronPid)
  assert.deepEqual(receipt.host.observations.slice(0, readiness.host.observations.length), readiness.host.observations, '最终Host观察改写了readiness历史。')
  const close = receipt.close
  assert.ok(close && close.method === 'app.quit', '必须经原app.quit收口。')
  assert.equal(close.beforeQuitObserved, true, '缺少实际Main before-quit观察。')
  const lifecyclePath = within(receipt.profile, close.lifecyclePath, 'Main生命周期收据')
  const lifecycle = readJson<{ sessionId: string; electronPid: number; beforeQuitObserved: boolean; boundary: SessionBoundary }>(lifecyclePath, close.lifecycleSha256, 'Main生命周期')
  assert.equal(lifecycle.sessionId, receipt.sessionId); assert.equal(lifecycle.electronPid, close.electronPid)
  assert.equal(lifecycle.beforeQuitObserved, true, 'Main生命周期未观察before-quit。')
  assert.deepEqual(lifecycle.boundary, receipt.boundary, '能力边界不是实际Main最终观测。')
  assert.deepEqual(receipt.boundary.blockedAttempts.slice(0, readiness.boundary.blockedAttempts.length), readiness.boundary.blockedAttempts, '最终拒绝观察改写了readiness历史。')
  assert.equal(close.forcedCleanup, false, 'forcedCleanup不能冒充自然退出。')
  assert.equal(close.electronPid, receipt.visibleWindow.electronPid)
  assert.deepEqual(close.electronExit, { code: 0, signal: null }, 'Electron没有自然exit0。')
  assert.equal(receipt.coreExit, 0, 'Core没有自然exit0。')
  const coreExit = receipt.main.filter(value => value.event === 'main.coreExit')
  assert.equal(coreExit.length, 1); assert.equal(coreExit[0]!.code, 0)
  // 原009 wrapper在exit回调读取UtilityProcess.pid；Electron此时可能已清空pid。
  // 同一Main的唯一fork/spawn/exit及spawn中的真实PID仍完整绑定，不能补造exit PID。
  const coreSpawn = receipt.main.find(value => value.event === 'main.coreSpawn')!
  assert.ok(typeof coreSpawn.sequence === 'number' && typeof coreExit[0]!.sequence === 'number'
    && coreSpawn.sequence < coreExit[0]!.sequence, 'Core退出不属于原spawn生命周期。')
  if (coreExit[0]!.pid !== undefined) assert.equal(coreExit[0]!.pid, events(receipt, 'node.spawn')[0]!.hostPid)
  for (const event of ['node.close', 'node.exit', 'node.closed']) assert.equal(events(receipt, event).length, 1, 'Owner关闭证据缺失：' + event)
  assert.equal(events(receipt, 'node.exit')[0]!.code, 0, 'Owner没有自然exit0。')
  assert.ok(events(receipt, 'node.close')[0]!.sequence < events(receipt, 'node.exit')[0]!.sequence
    && events(receipt, 'node.exit')[0]!.sequence < events(receipt, 'node.closed')[0]!.sequence, 'Owner close→exit→closed顺序错误。')
  rustChildren(receipt, true)
  if (receipt.mode !== 'node100') {
    assert.equal(receipt.host.controller?.phase, 'closed'); assert.equal(receipt.host.controller?.router?.phase, 'closed')
    const initial = readiness.host.controller!.router!
    for (const boot of events(receipt, 'rust.frame').filter(value => value.operation === 'commitBoot' && value.ok === true)) {
      const scope = boot.scope as Record<string, unknown>
      assert.equal(scope?.epoch, initial.epoch); assert.equal(scope?.datasetId, initial.datasetId)
      assert.ok(typeof scope?.snapshotId === 'string' && scope.snapshotId && positive(boot.generation), '真实Rust boot scope/generation缺失。')
    }
  }
  return { phase: 'closed', complete: true, ownerAcceptance: 'NOT_RUN', mode: receipt.mode }
}
