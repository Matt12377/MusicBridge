import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { mkdtemp, writeFile, stat, symlink } from 'node:fs/promises'
import { createCollectionReadonlySettings, readCollectionReadonlyPreference, writeCollectionReadonlyPreference, installCollectionReadonlyHandlers, type CollectionReadonlyControl } from '../src/main/collection-readonly-settings.js'
import { isCollectionReadonlySettings, isCollectionRefreshResult, type CollectionReadonlySettings } from '@music-bridge/contracts'
const off: CollectionReadonlySettings = { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' }
const ready: CollectionReadonlySettings = { schemaVersion: 1, enabled: true, mode: 'rust', state: 'ready' }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const control = (overrides: Partial<CollectionReadonlyControl> = {}): CollectionReadonlyControl => ({ getStatus: async () => off, setEnabled: async enabled => enabled ? ready : off, refresh: async () => ({ refreshed: false, status: off }), close() {}, ...overrides })

test('公共回执闭集拒绝内部selector/getter及伪刷新', () => {
  let invoked = 0
  const getter = Object.defineProperty({ ...off }, 'mode', { enumerable: true, get() { invoked++; return 'node' } })
  for (const bad of [{ ...off, pin: 'secret' }, { ...off, enabled: 'false' }, { ...off, mode: { toString() { invoked++; return 'node' } } }, getter, { ...off, errorCode: undefined }]) assert.equal(isCollectionReadonlySettings(bad), false)
  assert.equal(invoked, 0)
  assert.equal(isCollectionReadonlySettings(ready), true)
  assert.equal(isCollectionRefreshResult({ schemaVersion: 1, refreshed: true, settings: off }), false)
})

test('Main真实原子偏好0600与坏/缺/超限/链接安全默认', async () => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'readonly-preference-'))
  const file = path.join(directory, 'collection-readonly.json')
  assert.equal(await readCollectionReadonlyPreference(file), false)
  await writeCollectionReadonlyPreference(file, true)
  assert.equal(await readCollectionReadonlyPreference(file), true)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  for (const invalid of ['{', JSON.stringify({ schemaVersion: 1, enabled: 'true' }), JSON.stringify({ schemaVersion: 1, enabled: true, path: '/private' }), ' '.repeat(4097)]) {
    await writeFile(file, invalid); assert.equal(await readCollectionReadonlyPreference(file), false)
  }
  const valid = path.join(directory, 'valid'); await writeCollectionReadonlyPreference(valid, true)
  const link = path.join(directory, 'linked'); await symlink(valid, link); assert.equal(await readCollectionReadonlyPreference(link), false)
})

test('默认OFF零启用/刷新调用，保存失败不改持久意图', async () => {
  let enabledCalls = 0, fail = false
  const service = createCollectionReadonlySettings({ file: 'fixture', read: async () => false, write: async () => { if (fail) throw new Error('受控写盘失败') } })
  await service.restore(); service.attach(control({ setEnabled: async enabled => { enabledCalls++; return enabled ? ready : off } }))
  assert.equal(enabledCalls, 0); assert.deepEqual(await service.get(), off)
  await service.set(true); fail = true
  await assert.rejects(service.set(false)); assert.equal(service.snapshot().enabled, true); assert.equal(enabledCalls, 1)
})

test('OFF越过等待中ON，旧回执不得覆盖最后成功保存', async () => {
  const on = deferred<CollectionReadonlySettings>(), calls: boolean[] = [], saved: boolean[] = []
  const service = createCollectionReadonlySettings({ file: 'fixture', write: async (_file, enabled) => { saved.push(enabled) } })
  service.attach(control({ setEnabled: enabled => { calls.push(enabled); return enabled ? on.promise : Promise.resolve(off) } }))
  const first = service.set(true); await tick(); assert.deepEqual(calls, [true])
  assert.deepEqual(await service.set(false), off); assert.deepEqual(calls, [true, false]); assert.deepEqual(saved, [true, false])
  on.resolve(ready); assert.deepEqual(await first, off)
})

test('旧Core状态与旧刷新不能越detach或新意图', async () => {
  const reply = deferred<CollectionReadonlySettings>(), refresh = deferred<{ refreshed: boolean; status: CollectionReadonlySettings }>()
  const service = createCollectionReadonlySettings({ file: 'fixture', write: async () => {} })
  service.attach(control({ getStatus: () => reply.promise, refresh: () => refresh.promise }))
  const oldStatus = service.get(); await service.set(true)
  const oldRefresh = service.refresh(); service.detach(); service.attach(control({ setEnabled: async () => ({ ...ready, mode: 'node', state: 'failed' }) }))
  reply.resolve(ready); refresh.resolve({ refreshed: true, status: ready })
  assert.equal((await oldStatus).mode, 'node'); assert.equal((await oldRefresh).refreshed, false)
})

test('可信sender/闭集参数拒绝在全部副作用前', async () => {
  const handlers = new Map<string, (event: boolean, ...args: unknown[]) => unknown>(); let effects = 0
  installCollectionReadonlyHandlers({ handle: (key, handler) => handlers.set(key, handler), requireTrusted: trusted => { if (!trusted) throw new Error('拒绝sender') }, reject: () => { throw new Error('拒绝参数') }, settings: { get: async () => { effects++; return off }, set: async () => { effects++; return off }, refresh: async () => { effects++; return { schemaVersion: 1, refreshed: false, settings: off } } } })
  for (const [key, args] of [['collection:readonly-settings', []], ['collection:set-readonly-enabled', [true]], ['collection:refresh', []]] as const) assert.throws(() => handlers.get(key)!(false, ...args))
  for (const args of [[], ['true'], [{ enabled: true }], [true, '/path']]) assert.throws(() => handlers.get('collection:set-readonly-enabled')!(true, ...args))
  assert.throws(() => handlers.get('collection:readonly-settings')!(true, undefined)); assert.throws(() => handlers.get('collection:refresh')!(true, {})); assert.equal(effects, 0)
  await handlers.get('collection:set-readonly-enabled')!(true, false); assert.equal(effects, 1)
})

test('状态轮询不抢走真实刷新完成；迟到旧状态不能覆盖新控制回执', async () => {
  const refresh = deferred<{ refreshed: boolean; status: CollectionReadonlySettings }>(), read = deferred<CollectionReadonlySettings>()
  const service = createCollectionReadonlySettings({ file: 'fixture', write: async () => {} })
  service.attach(control({ refresh: () => refresh.promise, getStatus: () => read.promise }))
  await service.set(true)
  const flight = service.refresh(), poll = service.get()
  refresh.resolve({ refreshed: true, status: ready }); assert.equal((await flight).refreshed, true)
  read.resolve({ ...ready, mode: 'node', state: 'refreshing' }); assert.equal((await poll).mode, 'rust')
})

test('Main普通刷新也是单航班，不生成第二Core操作', async () => {
  const reply = deferred<{ refreshed: boolean; status: CollectionReadonlySettings }>(); let calls = 0
  const service = createCollectionReadonlySettings({ file: 'fixture', write: async () => {} })
  service.attach(control({ refresh: () => { calls++; return reply.promise } })); await service.set(true)
  const first = service.refresh(), second = service.refresh(); assert.equal(first, second); assert.equal(calls, 1)
  reply.resolve({ refreshed: true, status: ready }); assert.equal((await second).refreshed, true)
})
