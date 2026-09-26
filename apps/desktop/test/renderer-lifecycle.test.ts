import assert from 'node:assert/strict'
import test from 'node:test'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useRendererLifecycle } from '../src/renderer/src/composables/application/useRendererLifecycle.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

test('卸载后，迟到的启动查询不回写页面、不继续读取资料库，订阅也不再投递', async () => {
  const firstRead = deferred<string>()
  const calls = { nextRead: 0, commits: 0, events: 0, errors: 0, removed: 0 }
  const listeners: { command?: (command: 'show-queue') => void } = {}
  const api = {
    onAppCommand: (listener: (command: 'show-queue') => void) => {
      listeners.command = listener
      return () => { calls.removed += 1 }
    },
    onRemoteCoreEvent: () => () => { calls.removed += 1 },
    onCoreEvent: () => () => { calls.removed += 1 },
  } as unknown as MusicBridgePublicApi
  const keyTarget = {
    addEventListener: () => undefined,
    removeEventListener: () => { calls.removed += 1 },
  } as unknown as Window

  const lifecycle = useRendererLifecycle({
    api, keyTarget,
    onKeydown: () => undefined,
    onCoreEvent: () => { calls.events += 1 },
    onRemoteCoreEvent: () => { calls.events += 1 },
    onAppCommand: () => { calls.events += 1 },
    initialize: async read => {
      const first = await read(() => firstRead.promise)
      if (!first.active) return
      calls.commits += 1
      const next = await read(async () => { calls.nextRead += 1; return 'private-library' })
      if (next.active) calls.commits += 1
    },
    onInitializationError: () => { calls.errors += 1 },
  })

  lifecycle.start()
  lifecycle.dispose()
  firstRead.resolve('late')
  listeners.command?.('show-queue')
  await new Promise<void>(resolve => setImmediate(resolve))

  assert.deepEqual(calls, { nextRead: 0, commits: 0, events: 0, errors: 0, removed: 4 })
  assert.equal(lifecycle.isActive(), false)
})

test('卸载后的启动查询失败不显示错误，也不能重新启动', async () => {
  const pending = deferred<string>()
  let errors = 0
  let starts = 0
  const api = {
    onAppCommand: () => () => undefined,
    onRemoteCoreEvent: () => () => undefined,
    onCoreEvent: () => () => undefined,
  } as unknown as MusicBridgePublicApi
  const lifecycle = useRendererLifecycle({
    api,
    keyTarget: { addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Window,
    onKeydown: () => undefined,
    onCoreEvent: () => undefined,
    onRemoteCoreEvent: () => undefined,
    onAppCommand: () => undefined,
    initialize: async read => { starts += 1; await read(() => pending.promise) },
    onInitializationError: () => { errors += 1 },
  })

  lifecycle.start()
  lifecycle.dispose()
  pending.reject(new Error('迟到的失败'))
  await new Promise<void>(resolve => setImmediate(resolve))
  lifecycle.start()
  assert.equal(starts, 1)
  assert.equal(errors, 0)
})
