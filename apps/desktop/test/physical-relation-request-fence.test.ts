import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhysicalRelationRequestFence } from '../src/renderer/src/components/collection/physical-relation-request-fence.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('返回同一实物后，迟到数字详情成功不能抢回数字页', async () => {
  const fence = createPhysicalRelationRequestFence(), shown: string[] = [], errors: string[] = []
  const digital = deferred<string>()
  const pending = fence.read(() => digital.promise, {
    success: value => shown.push(value), failure: () => errors.push('旧数字详情失败'),
  })
  fence.invalidate()
  const physical = await fence.read(async () => '当前实物页', {
    success: value => shown.push(value), failure: () => errors.push('实物读取失败'),
  })
  digital.resolve('迟到数字详情')
  assert.equal(await pending, false)
  assert.equal(physical, true)
  assert.deepEqual(shown, ['当前实物页'])
  assert.deepEqual(errors, [])
})

test('离线或重新定位后，迟到曲目失败不覆盖当前状态；新分页胜过旧分页', async () => {
  const fence = createPhysicalRelationRequestFence(), shown: string[] = [], errors: string[] = []
  const oldPage = deferred<string>()
  const old = fence.read(() => oldPage.promise, {
    success: value => shown.push(value), failure: () => errors.push('旧页错误'),
  })
  const next = await fence.read(async () => '当前第 2 页', {
    success: value => shown.push(value), failure: () => errors.push('新页错误'),
  })
  oldPage.resolve('迟到第 1 页')
  assert.equal(await old, false)
  assert.equal(next, true)
  assert.deepEqual(shown, ['当前第 2 页'])

  const pendingFailure = deferred<string>()
  const failed = fence.read(() => pendingFailure.promise, {
    success: value => shown.push(value), failure: () => errors.push('迟到错误'),
  })
  fence.invalidate()
  pendingFailure.reject(new Error('离线前的曲目请求失败'))
  assert.equal(await failed, false)
  assert.deepEqual(errors, [])
  assert.equal(fence.isCurrent(fence.version(), () => false), false)
})

test('当前请求失败仍提示错误，晚到后续调用必须重新取得身份', async () => {
  const fence = createPhysicalRelationRequestFence(), errors: string[] = []
  const token = fence.version()
  assert.equal(await fence.read(async () => { throw new Error('当前失败') }, {
    success: () => assert.fail('不应发布成功'), failure: error => errors.push((error as Error).message),
  }), false)
  assert.deepEqual(errors, ['当前失败'])
  assert.equal(fence.isCurrent(token), false)
})
