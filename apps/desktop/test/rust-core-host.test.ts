import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Worker, WorkerOptions } from 'node:worker_threads'
import { runDesktopCoreHost, type DesktopCoreHostOptions } from '../src/main/core-host.js'
import { runCoreUtilityProcess, type UtilityPort } from '../../../packages/bridge-core/src/utility-main.js'
import type { DatasetOwnerProjectionResponse, DatasetOwnerRequest } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'

type UtilityArguments = Parameters<typeof runCoreUtilityProcess>
const env = { NODE_ENV: 'test', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: '/synthetic/data' }
const rust: NonNullable<DesktopCoreHostOptions['rustReadonlyCollection']> = {
  binary: { path: '/synthetic/pinned-rust', sha256: 'a'.repeat(64) }, snapshotProfile: 'v3-5000',
}

function capture() {
  const calls: UtilityArguments[] = []
  const run: typeof runCoreUtilityProcess = (...args) => { calls.push(args); return Promise.resolve() }
  return { calls, run }
}

class OwnerWorker extends EventEmitter {
  readonly requests: DatasetOwnerRequest[] = []
  readonly projectionResponses: DatasetOwnerProjectionResponse[] = []
  readonly datasetId = randomUUID()
  postMessage(request: DatasetOwnerRequest | DatasetOwnerProjectionResponse) {
    if (request.type === 'projection-response') { this.projectionResponses.push(request); return }
    this.requests.push(request)
    const result = request.operation === 'prepare' ? { epoch: request.epoch, datasetId: this.datasetId } : undefined
    queueMicrotask(() => {
      this.emit('message', { version: request.version, type: 'response', epoch: request.epoch,
        requestId: request.requestId, operation: request.operation, ok: true, result })
      if (request.operation === 'close') this.emit('exit', 0)
    })
  }
  asWorker() { return this as unknown as Worker }
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 2_000
  while (!check()) {
    if (performance.now() > deadline) throw new Error('受控桌面宿主未及时完成。')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

async function invalidStart(t: test.TestContext, options: DesktopCoreHostOptions, data: unknown = { type: 'musicbridge.core.port' }) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort'), previousExitCode = process.exitCode
  let listener!: (event: { data: unknown; ports: UtilityPort[] }) => void
  const exits: unknown[] = [], messages: unknown[] = [], workers: OwnerWorker[] = []
  t.mock.method(process, 'exit', ((code: unknown) => { exits.push(code) }) as typeof process.exit)
  Object.defineProperty(process, 'parentPort', { configurable: true, value: {
    once(_event: string, callback: typeof listener) { listener = callback },
  } })
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor)
    else Reflect.deleteProperty(process, 'parentPort')
    process.exitCode = previousExitCode
  })
  await runDesktopCoreHost({ ...options, env, dependencies: { createWorker() {
    const worker = new OwnerWorker(); workers.push(worker); return worker.asWorker()
  } } })
  const port: UtilityPort = { on() {}, start() {}, postMessage(message) { messages.push(message) } }
  listener({ data, ports: [port] })
  await until(() => exits.includes(1))
  // 一个测试可顺序核验多次拒绝；立即复原，后续场景不能继承前次退出状态。
  if (descriptor) Object.defineProperty(process, 'parentPort', descriptor)
  else Reflect.deleteProperty(process, 'parentPort')
  process.exitCode = previousExitCode
  return { exits, messages, workers }
}

test('正式入口使用固定可选manager，导入 adapter 本身不启动 Core', async () => {
  const entry = await readFile(new URL('../src/main/core-entry.ts', import.meta.url), 'utf8')
  assert.match(entry, /void runDesktopCoreHost\(\{ optionalReadonlyManager: manager/u)
  assert.match(entry, /__MUSIC_BRIDGE_COLLECTION_READONLY_DIAGNOSTICS__ === true/u)
  assert.match(entry, /createOptions: async/u)
  assert.doesNotMatch(entry, /process\.env|rustReadonlyCollection|onRustReadonlyCoreController|new Worker/u)
})

test('默认 Node 保留六参数与原环境，Rust 环境变量不能选入能力', async () => {
  const { calls, run } = capture()
  const source = { ...env, MUSIC_BRIDGE_RUST_ENABLED: '1', MUSIC_BRIDGE_RUST_BINARY: '/synthetic/untrusted',
    MUSIC_BRIDGE_RUST_SHA256: 'b'.repeat(64), MUSIC_BRIDGE_RUST_SNAPSHOT_PROFILE: 'v3-5000' }
  await runDesktopCoreHost({ env: source, dependencies: { runCoreUtilityProcess: run } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.length, 6)
  assert.equal(calls[0]![0], source)
  assert.deepEqual(calls[0]!.slice(1, 5), [undefined, undefined, undefined, null])
  assert.equal(typeof calls[0]![5], 'function')
})

test('未指定环境保留 process.env，可信配置和同步 callback 原身份转交第七八参数', async () => {
  const { calls, run } = capture()
  const callback: NonNullable<DesktopCoreHostOptions['onRustReadonlyCoreController']> = () => {}
  await runDesktopCoreHost({ rustReadonlyCollection: rust, onRustReadonlyCoreController: callback,
    dependencies: { runCoreUtilityProcess: run } })
  assert.equal(calls[0]![0], process.env)
  assert.equal(calls[0]!.length, 8)
  assert.equal(calls[0]![6], rust)
  assert.equal(calls[0]![7], callback)
  assert.deepEqual(calls[0]!.slice(1, 5), [undefined, undefined, undefined, null])
})

test('只指定 Rust 配置保留既有第七参数行为，不要求主机 callback', async () => {
  const { calls, run } = capture()
  await runDesktopCoreHost({ env, rustReadonlyCollection: rust, dependencies: { runCoreUtilityProcess: run } })
  assert.equal(calls[0]![6], rust)
  assert.equal(calls[0]![7], undefined)
})

test('Worker 使用固定 Owner 文件、名称、两键身份和有限环境；原 Client 准备启动关闭各一次', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/synthetic/resources' })
  t.after(() => { if (descriptor) Object.defineProperty(process, 'resourcesPath', descriptor); else Reflect.deleteProperty(process, 'resourcesPath') })
  const { calls, run } = capture(), worker = new OwnerWorker()
  const creations: { entry: URL; options: WorkerOptions }[] = []
  const allowed = { NODE_ENV: 'test', TMPDIR: '/synthetic/tmp', DEV_BUILD_ROOT: '/synthetic/build', DEV_CACHE_ROOT: '/synthetic/cache',
    NODE_COMPILE_CACHE: '/synthetic/compile', LANG: 'zh_CN.UTF-8', LC_ALL: 'C', TZ: 'Asia/Shanghai',
    MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1', MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1' }
  const source = { ...allowed, MUSIC_BRIDGE_DATA_DIRECTORY: '/synthetic/data', NETEASE_COOKIE: '合成不可转交值',
    ROON_SESSION_ID: '合成不可转交值', NODE_OPTIONS: '--inspect', HOME: '/synthetic/home',
    MUSIC_BRIDGE_RUST_BINARY: rust.binary.path, MUSIC_BRIDGE_RUST_SHA256: rust.binary.sha256 }
  await runDesktopCoreHost({ env: source, dependencies: { runCoreUtilityProcess: run,
    createWorker(entry, options) { creations.push({ entry, options }); return worker.asWorker() } } })
  assert.equal(creations.length, 0, 'Core 在 factory 调用前不能抢先创建 Owner')
  let fatal: unknown
  const owner = calls[0]![5]!({ projection: async () => { throw new Error('本场景不投影') }, onFatal: reason => { fatal = reason } })
  assert.equal(creations.length, 1)
  assert.equal(creations[0]!.entry.href, new URL('../src/main/dataset-owner.js', import.meta.url).href)
  assert.equal(creations[0]!.options.name, 'MusicBridge Dataset Owner')
  assert.deepEqual(creations[0]!.options.workerData, { dataDirectory: '/synthetic/data', resourcesDirectory: '/synthetic/resources' })
  assert.deepEqual(creations[0]!.options.env, allowed)
  const identity = await owner.prepare()
  assert.equal(identity.datasetId, worker.datasetId)
  await owner.commitBoot()
  await owner.close()
  assert.deepEqual(worker.requests.map(request => request.operation), ['prepare', 'commitBoot', 'close'])
  assert.equal(fatal, undefined)
})

test('原 fatal 回调继续由 Client 上报，无自动重建 Owner', async () => {
  const { calls, run } = capture(), worker = new OwnerWorker()
  let creations = 0, fatal: unknown
  await runDesktopCoreHost({ env, dependencies: { runCoreUtilityProcess: run, createWorker() { creations++; return worker.asWorker() } } })
  const owner = calls[0]![5]!({ projection: async () => { throw new Error('本场景不投影') }, onFatal: reason => { fatal = reason } })
  worker.emit('error', new Error('合成线程故障'))
  assert.equal(fatal, 'worker-error')
  await assert.rejects(owner.prepare())
  assert.equal(creations, 1)
  assert.equal(worker.requests.length, 0)
})

test('原 projection 回调继续接收固定 Client 身份和原载荷，结果从原线程端口返回', async () => {
  const { calls, run } = capture(), worker = new OwnerWorker()
  const projections: unknown[][] = []
  await runDesktopCoreHost({ env, dependencies: { runCoreUtilityProcess: run, createWorker: () => worker.asWorker() } })
  const owner = calls[0]![5]!({ projection: async (...args) => { projections.push(args); throw new Error('合成投影错误') }, onFatal: () => {} })
  const identity = await owner.prepare()
  const payload = { scope: 'synthetic', projectionId: randomUUID(), permitId: randomUUID() }
  const projectionRequestId = randomUUID()
  worker.emit('message', { version: 1, type: 'projection', epoch: identity.epoch, projectionRequestId, command: 'releasePermit', payload })
  await until(() => worker.projectionResponses.length === 1)
  assert.deepEqual(projections, [['releasePermit', payload, identity]])
  assert.equal(projections[0]![1], payload)
  assert.equal(worker.projectionResponses[0]!.projectionRequestId, projectionRequestId)
  assert.equal(worker.projectionResponses[0]!.ok, false)
  await owner.close()
})

test('utility 启动返回的 Promise 和原错误不被 adapter 改写或重试', async () => {
  const failure = new Error('合成 utility 启动失败')
  const result = Promise.reject(failure)
  let calls = 0
  const actual = runDesktopCoreHost({ dependencies: { runCoreUtilityProcess: () => { calls++; return result } } })
  assert.equal(actual, result)
  await assert.rejects(actual, error => error === failure)
  assert.equal(calls, 1)
})

test('真实 utility 拒绝缺配置或坏类型 callback，Owner 尚未创建', async t => {
  for (const options of [
    { onRustReadonlyCoreController: () => {} },
    { rustReadonlyCollection: rust, onRustReadonlyCoreController: true as unknown as DesktopCoreHostOptions['onRustReadonlyCoreController'] },
  ]) {
    const result = await invalidStart(t, options)
    assert.equal(result.workers.length, 0)
    assert.deepEqual(result.messages, [])
  }
})

test('真实 utility 保留严格父启动合同，额外 Rust 字段不能准入', async t => {
  const result = await invalidStart(t, {}, { type: 'musicbridge.core.port', rustReadonlyCollection: rust })
  assert.equal(result.workers.length, 0)
  assert.deepEqual(result.messages, [])
})

test('真实 utility 拒绝非法 profile 后关闭原 Owner Client 并等待受控线程回执', async t => {
  const result = await invalidStart(t, { rustReadonlyCollection: { ...rust, snapshotProfile: '未准入' as typeof rust.snapshotProfile } })
  assert.equal(result.workers.length, 1)
  assert.deepEqual(result.workers[0]!.requests.map(request => request.operation), ['close'])
  assert.deepEqual(result.messages, [])
})


test('可信资源工厂精确位于第九参数，原控制回调保持第八参数', async () => {
  const { calls, run } = capture();
  const factory = async () => rust;
  const callback: NonNullable<DesktopCoreHostOptions['onRustReadonlyCoreController']> = () => {};
  await runDesktopCoreHost({ env, createRustReadonlyCollection: factory, onRustReadonlyCoreController: callback,
    dependencies: { runCoreUtilityProcess: run } } as DesktopCoreHostOptions);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.length, 9);
  assert.equal(calls[0]![6], undefined); assert.equal(calls[0]![7], callback);
  assert.equal((calls[0] as unknown[])[8], factory);
});

test('可信 Owner 装饰只在原工厂创建后调用，原身份/prepare/boot/close保持', async () => {
  const { calls, run } = capture(), worker = new OwnerWorker();
  let decorated = 0;
  await runDesktopCoreHost({ env, dependencies: { runCoreUtilityProcess: run, createWorker: () => worker.asWorker(),
    decorateDatasetOwner(owner: import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetOwnerEndpoint) {
      decorated++; return owner;
    } } } as DesktopCoreHostOptions);
  assert.equal(decorated, 0);
  const owner = calls[0]![5]!({ projection: async () => { throw new Error('不投影'); }, onFatal: () => {} });
  assert.equal(decorated, 1);
  await owner.prepare(); await owner.commitBoot(); await owner.close();
  assert.deepEqual(worker.requests.map(request => request.operation), ['prepare', 'commitBoot', 'close']);
});

for (const mode of ['throw', 'invalid'] as const) {
  test(`可信 Owner 装饰 ${mode} 仍保留原作者的可等待清理端点`, async () => {
    const { calls, run } = capture(), worker = new OwnerWorker();
    await runDesktopCoreHost({ env, dependencies: { runCoreUtilityProcess: run, createWorker: () => worker.asWorker(),
      decorateDatasetOwner() { if (mode === 'throw') throw new Error('合成装饰失败'); return null as unknown as import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetOwnerEndpoint; } } });
    const owner = calls[0]![5]!({ projection: async () => { throw new Error('不投影'); }, onFatal: () => {} });
    await assert.rejects(owner.prepare()); await owner.close();
    assert.deepEqual(worker.requests.map(request => request.operation), ['close']);
  });
}


test('可选manager装饰仅借用原Owner，普通utility始终六参数且OFF零资源', async () => {
  const { createOptionalRustReadonlyManager } = await import('../../../packages/bridge-core/src/rust-core/optional-readonly-manager.js')
  let factories = 0
  const manager = createOptionalRustReadonlyManager({ createOptions: async () => { factories++; throw new Error('OFF不准许能力解析') } })
  const { calls, run } = capture(), worker = new OwnerWorker()
  let observers = 0
  await runDesktopCoreHost({ env, optionalReadonlyManager: manager, dependencies: { runCoreUtilityProcess: run,
    createWorker: () => worker.asWorker(), decorateDatasetOwner(owner) { observers++; return owner } } })
  assert.equal(calls.length, 1); assert.equal(calls[0]!.length, 6)
  const owner = calls[0]![5]!({ projection: async () => { throw new Error('本场景不投影') }, onFatal: () => {} })
  await owner.prepare(); await owner.commitBoot(); const close = owner.close(); assert.equal(close, owner.close()); await close
  assert.equal(factories, 0); assert.equal(observers, 1)
  assert.deepEqual(worker.requests.map(request => request.operation), ['prepare', 'commitBoot', 'close'])
})
