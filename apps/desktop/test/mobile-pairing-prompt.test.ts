import assert from 'node:assert/strict'
import test from 'node:test'
import type { MessageBoxOptions } from 'electron'
import { createMobilePairingPromptCoordinator } from '../src/main/mobile-pairing-prompt.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(options: { holdAbort?: boolean; failFirst?: boolean } = {}) {
  let destroyed = false, clock = 1000
  const cancels: string[] = [], shows: { options: MessageBoxOptions; resolve(value: { response: number }): void; reject(error: Error): void }[] = []
  const parent = { isDestroyed: () => destroyed, isMinimized: () => false, isVisible: () => true,
    restore() {}, show() {}, focus() {} }
  const coordinator = createMobilePairingPromptCoordinator({ getWindow: () => parent, now: () => clock,
    showMessageBox(_window, value) {
      return new Promise<{ response: number }>((resolve, reject) => {
        shows.push({ options: value, resolve, reject })
        value.signal!.addEventListener('abort', () => { if (!options.holdAbort) resolve({ response: 0 }) }, { once: true })
        if (options.failFirst && shows.length === 1) reject(new Error('合成私密显示错误'))
      })
    } })
  const request = (requestId: string, code = '123456', expiresAtMs = 6000) => ({ requestId, code, deviceName: '合成 iPhone ' + requestId,
    expiresAtMs, onCancel: (id: string) => { cancels.push(id) } })
  return { coordinator, shows, cancels, request, destroy: () => { destroyed = true }, setNow: (value: number) => { clock = value } }
}

test('配对原生提示：show仅等登记，用户仍未关闭时HTTP调用方即可继续', async () => {
  const f = fixture(); await f.coordinator.show(f.request('request-a'))
  assert.equal(f.shows.length, 1); assert.ok(f.shows[0]!.options.detail!.includes('123456'))
  assert.deepEqual(f.shows[0]!.options.buttons, ['取消配对']); assert.equal(f.shows[0]!.options.cancelId, 0)
  assert.deepEqual(f.cancels, []); await f.coordinator.stop(); assert.deepEqual(f.cancels, [])
})

test('配对原生提示：多设备独立排队，成功dismiss只关闭该请求并展示下一台', async () => {
  const f = fixture(); await f.coordinator.show(f.request('request-a', '123456')); await f.coordinator.show(f.request('request-b', '654321'))
  assert.equal(f.shows.length, 1); f.coordinator.dismiss('request-a'); await turn()
  assert.equal(f.shows.length, 2); assert.ok(f.shows[1]!.options.detail!.includes('654321'))
  assert.ok(!f.shows[1]!.options.detail!.includes('123456')); assert.deepEqual(f.cancels, [])
  f.shows[1]!.resolve({ response: 0 }); await turn(); assert.deepEqual(f.cancels, ['request-b']); await f.coordinator.stop()
})

test('配对原生提示：用户取消仅通知原请求，迟到的第一请求响应不取消第二请求', async () => {
  const f = fixture(); await f.coordinator.show(f.request('request-a')); await f.coordinator.show(f.request('request-b'))
  f.shows[0]!.resolve({ response: 0 }); await turn(); assert.deepEqual(f.cancels, ['request-a']); assert.equal(f.shows.length, 2)
  f.shows[0]!.resolve({ response: 0 }); await turn(); assert.deepEqual(f.cancels, ['request-a'])
  await f.coordinator.stop(); assert.deepEqual(f.cancels, ['request-a'])
})

test('配对原生提示：各自原截止独立到期，不因排队重置验证码有效期', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset())
  const f = fixture(); await f.coordinator.show(f.request('request-a', '123456', 4000)); await f.coordinator.show(f.request('request-b', '654321', 2000))
  f.setNow(2000); t.mock.timers.tick(1000); await turn(); assert.deepEqual(f.cancels, ['request-b']); assert.equal(f.shows.length, 1)
  f.coordinator.dismiss('request-a'); await turn(); assert.equal(f.shows.length, 1); await f.coordinator.stop()
})

test('配对原生提示：到期关闭可见sheet只回调一次，原生取消回执不重复取消', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset())
  const f = fixture(); await f.coordinator.show(f.request('request-a', '123456', 2000))
  f.setNow(2000); t.mock.timers.tick(1000); await turn(); assert.deepEqual(f.cancels, ['request-a'])
  assert.equal(f.shows[0]!.options.signal!.aborted, true); await f.coordinator.stop(); assert.deepEqual(f.cancels, ['request-a'])
})

test('配对原生提示：stop撤销所有请求并join原生结束，不能提前声称已关闭', async () => {
  const f = fixture({ holdAbort: true }); await f.coordinator.show(f.request('request-a')); await f.coordinator.show(f.request('request-b'))
  let finished = false; const stopped = f.coordinator.stop().then(() => { finished = true }); await turn()
  assert.equal(finished, false); assert.equal(f.shows[0]!.options.signal!.aborted, true)
  f.shows[0]!.resolve({ response: 0 }); await stopped
  assert.equal(finished, true); assert.equal(f.shows.length, 1); assert.deepEqual(f.cancels, [])
  await assert.rejects(f.coordinator.show(f.request('request-c')))
})

test('配对原生提示：异步原生展示失败取消精确请求，后续设备仍可正常展示', async () => {
  const f = fixture({ failFirst: true }); await f.coordinator.show(f.request('request-a')); await f.coordinator.show(f.request('request-b')); await turn()
  assert.deepEqual(f.cancels, ['request-a']); assert.equal(f.shows.length, 2)
  f.coordinator.dismiss('request-b'); await f.coordinator.stop(); assert.deepEqual(f.cancels, ['request-a'])
})

test('配对原生提示：缺窗口、无效或重复请求拒绝登记，不触碰其他请求', async () => {
  const f = fixture(); await f.coordinator.show(f.request('request-a'))
  for (const value of [f.request('request-a'), f.request('request-b', '12345'), f.request('request-b', 'abcdef'),
    f.request('request-b', '123456', 999), { ...f.request('request-b'), deviceName: '伪造\n另一设备' }]) await assert.rejects(f.coordinator.show(value))
  assert.equal(f.shows.length, 1); assert.deepEqual(f.cancels, []); await f.coordinator.stop()
  const noWindow = createMobilePairingPromptCoordinator({ getWindow: () => undefined })
  await assert.rejects(noWindow.show({ ...f.request('request-c'), expiresAtMs: Date.now() + 1000 })); await noWindow.stop()
})

test('配对原生提示：排队期间父窗口销毁时只取消待显示请求，不创建无主同步弹框', async () => {
  const f = fixture(); await f.coordinator.show(f.request('request-a')); await f.coordinator.show(f.request('request-b'))
  f.destroy(); f.coordinator.dismiss('request-a'); await turn()
  assert.equal(f.shows.length, 1); assert.deepEqual(f.cancels, ['request-b']); await f.coordinator.stop()
})
