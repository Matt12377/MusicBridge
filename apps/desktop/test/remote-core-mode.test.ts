import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteCoreMode, RemoteCoreTunnelState } from '@music-bridge/contracts'

import { createRemoteCoreModeController, type RemoteCoreModeSnapshot } from '../src/main/remote-core-mode.js'

function state(sshTarget = 'core-mac', remoteStreamPort = 38512): RemoteCoreTunnelState {
  return {
    mode: 'remote-core-development', status: 'starting', sshTarget, remoteStreamPort,
    localStreamPort: 38502, remoteHealth: 'unavailable', autoReconnect: false,
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function harness(initial: RemoteCoreModeSnapshot = { mode: 'local-core', remoteStreamPort: undefined }) {
  let mode = { ...initial }
  const changes: RemoteCoreModeSnapshot[] = []
  const restarts: RemoteCoreModeSnapshot[] = []
  const pending: Array<() => Promise<void>> = []
  const setMode = (nextMode: RemoteCoreMode, remoteStreamPort: number | undefined) => {
    mode = { mode: nextMode, remoteStreamPort }
    changes.push({ ...mode })
  }
  const controller = createRemoteCoreModeController({
    readMode: () => mode,
    setMode,
    restart: async () => {
      restarts.push({ ...mode })
      await pending.shift()?.()
    },
  })
  return { controller, changes, restarts, pending, setMode, readMode: () => mode }
}

test('健康隧道绑定后按远程端口重启 Core，保持远程模式', async () => {
  const app = harness()
  await app.controller.bound(state())
  assert.deepEqual(app.readMode(), { mode: 'remote-core-development', remoteStreamPort: 38512 })
  assert.deepEqual(app.restarts, [{ mode: 'remote-core-development', remoteStreamPort: 38512 }])
})

test('当前绑定的健康检查失败恢复本地 Core，重复回调只重启一次', async () => {
  const app = harness()
  await app.controller.bound(state())
  await app.controller.unavailable(state())
  await app.controller.unavailable(state())
  assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
  assert.deepEqual(app.restarts, [
    { mode: 'remote-core-development', remoteStreamPort: 38512 },
    { mode: 'local-core', remoteStreamPort: undefined },
  ])
})

test('已就绪隧道断开也恢复本地 Core，不依赖失败状态枚举', async () => {
  const app = harness()
  await app.controller.bound(state())
  await app.controller.unavailable({ ...state(), status: 'disconnected', errorCode: 'TUNNEL_DISCONNECTED' })
  assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
  assert.equal(app.restarts.length, 2)
})

test('旧目标、旧端口或已经变更的当前模式不能触发回退', async () => {
  const app = harness()
  await app.controller.bound(state('core-old', 38512))
  await app.controller.bound(state('core-new', 38513))
  await app.controller.unavailable(state('core-old', 38513))
  await app.controller.unavailable(state('core-new', 38512))
  assert.equal(app.restarts.length, 2)
  assert.deepEqual(app.readMode(), { mode: 'remote-core-development', remoteStreamPort: 38513 })
  app.setMode('remote-core-development', 38514)
  await app.controller.unavailable(state('core-new', 38513))
  app.setMode('local-core', undefined)
  await app.controller.unavailable(state('core-new', 38513))
  assert.equal(app.restarts.length, 2)
})

test('更换目标与端口失败后恢复本地 Core，旧隧道已拆不能回到旧远程模式', async () => {
  const app = harness()
  await app.controller.bound(state('core-old', 38512))
  const failure = new Error('合成远程重启失败。')
  app.pending.push(async () => { throw failure })
  await assert.rejects(app.controller.bound(state('core-new', 38513)), error => error === failure)
  assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
  assert.deepEqual(app.restarts.slice(-2), [
    { mode: 'remote-core-development', remoteStreamPort: 38513 },
    { mode: 'local-core', remoteStreamPort: undefined },
  ])
  await app.controller.unavailable(state('core-new', 38513))
  assert.equal(app.restarts.length, 3)
  await app.controller.unavailable(state('core-old', 38512))
  assert.equal(app.restarts.length, 3)
  assert.equal(app.readMode().mode, 'local-core')
})

test('绑定与恢复重启都失败时保留两个错误，健康失败的本地重启错误也可观察', async () => {
  const app = harness()
  const original = new Error('合成远程重启失败。')
  const fallback = new Error('合成本地重启失败。')
  app.pending.push(async () => { throw original }, async () => { throw fallback })
  await assert.rejects(app.controller.bound(state()), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.cause, original)
    assert.deepEqual(error.errors, [original, fallback])
    return true
  })
  assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
  await app.controller.bound(state())
  app.pending.push(async () => { throw fallback })
  await assert.rejects(app.controller.unavailable(state()), error => error === fallback)
  assert.equal(app.readMode().mode, 'local-core')
})

test('显式停止撤销绑定，迟到健康失败不会覆盖停止后的模式', async () => {
  const app = harness()
  await app.controller.bound(state())
  app.controller.reset()
  app.setMode('local-core', undefined)
  await app.controller.unavailable(state())
  assert.equal(app.restarts.length, 1)
  assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
})

test('旧绑定迟到失败不能恢复并覆盖新绑定', async () => {
  const app = harness()
  const oldRestart = deferred()
  const failure = new Error('合成旧重启迟到失败。')
  app.pending.push(() => oldRestart.promise)
  const oldBinding = app.controller.bound(state('core-old', 38512))
  const rejected = assert.rejects(oldBinding, error => error === failure)
  const newBinding = app.controller.bound(state('core-new', 38513))
  oldRestart.reject(failure)
  await rejected
  await newBinding
  await app.controller.unavailable(state('core-old', 38512))
  assert.deepEqual(app.readMode(), { mode: 'remote-core-development', remoteStreamPort: 38513 })
  assert.equal(app.restarts.length, 2)
  await app.controller.unavailable(state('core-new', 38513))
  assert.equal(app.readMode().mode, 'local-core')
})

test('停止撤销尚未完成的绑定，迟到重启错误不再触发回退', async () => {
  const app = harness()
  const restart = deferred()
  const failure = new Error('合成停止后迟到失败。')
  app.pending.push(() => restart.promise)
  const binding = app.controller.bound(state())
  const rejected = assert.rejects(binding, error => error === failure)
  app.controller.reset()
  app.setMode('local-core', undefined)
  restart.reject(failure)
  await rejected
  await app.controller.unavailable(state())
  assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
  assert.equal(app.restarts.length, 1)
})

test('本地回退重启尚未完成时，新绑定等待后再独立重启远程 Core', async () => {
  const app = harness()
  await app.controller.bound(state('core-old', 38512))
  const localRestart = deferred()
  const entered = deferred()
  app.pending.push(async () => { entered.resolve(); await localRestart.promise })
  const fallback = app.controller.unavailable(state('core-old', 38512))
  await entered.promise
  let bound = false
  const newBinding = app.controller.bound(state('core-new', 38513)).then(() => { bound = true })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(bound, false)
    assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
    assert.equal(app.restarts.length, 2, '本地回退完成前不能合并或启动远程重启。')
    localRestart.resolve()
    await fallback
    await newBinding
    assert.deepEqual(app.restarts, [
      { mode: 'remote-core-development', remoteStreamPort: 38512 },
      { mode: 'local-core', remoteStreamPort: undefined },
      { mode: 'remote-core-development', remoteStreamPort: 38513 },
    ])
    assert.deepEqual(app.readMode(), { mode: 'remote-core-development', remoteStreamPort: 38513 })
  } finally {
    localRestart.resolve()
    await Promise.allSettled([fallback, newBinding])
  }
})

test('新绑定排队等待本地回退时，显式停止取消迟到模式切换与重启', async () => {
  const app = harness()
  await app.controller.bound(state('core-old', 38512))
  const localRestart = deferred()
  const entered = deferred()
  app.pending.push(async () => { entered.resolve(); await localRestart.promise })
  const fallback = app.controller.unavailable(state('core-old', 38512))
  await entered.promise
  const newBinding = app.controller.bound(state('core-new', 38513))
  app.controller.reset()
  try {
    localRestart.resolve()
    await fallback
    await newBinding
    assert.deepEqual(app.readMode(), { mode: 'local-core', remoteStreamPort: undefined })
    assert.equal(app.restarts.length, 2)
    assert.deepEqual(app.changes, [
      { mode: 'remote-core-development', remoteStreamPort: 38512 },
      { mode: 'local-core', remoteStreamPort: undefined },
    ])
  } finally {
    localRestart.resolve()
    await Promise.allSettled([fallback, newBinding])
  }
})
