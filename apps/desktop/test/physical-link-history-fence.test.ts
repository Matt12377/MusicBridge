import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhysicalLinkHistoryFence } from '../src/renderer/src/components/collection/physical-link-history-fence.js'

test('迟到的历史分页不能覆盖刷新后的首页，更正时可失效所有旧读取', async () => {
  const fence = createPhysicalLinkHistoryFence(), displayed: string[] = []
  let resolveOld!: (value: string) => void
  const old = fence.read(() => new Promise<string>(resolve => { resolveOld = resolve }), value => displayed.push(value))
  const current = fence.read(async () => '更正后的首页', value => displayed.push(value))
  assert.equal(await current, true)
  resolveOld('迟到的旧分页')
  assert.equal(await old, false)
  assert.deepEqual(displayed, ['更正后的首页'])

  let resolveBeforeMutation!: (value: string) => void
  const beforeMutation = fence.read(() => new Promise<string>(resolve => { resolveBeforeMutation = resolve }), value => displayed.push(value))
  fence.invalidate()
  resolveBeforeMutation('更正前的关系')
  assert.equal(await beforeMutation, false)
  assert.deepEqual(displayed, ['更正后的首页'])
})

test('离开关系历史后，迟到失败不会在当前实物页显示错误', async () => {
  const fence = createPhysicalLinkHistoryFence()
  let rejectOld!: (error: Error) => void
  const pending = fence.read(() => new Promise<string>((_resolve, reject) => { rejectOld = reject }), () => assert.fail('不应发布旧历史'))
  fence.invalidate()
  rejectOld(new Error('旧历史请求失败'))
  assert.equal(await pending, false)
})
