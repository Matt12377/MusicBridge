import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRefreshVisibleRoonCollection } from '../src/renderer/src/roon-collection-lifecycle.js'

test('Roon 集合只在 Core 就绪或重新进入 ready 时刷新，不被 ready 状态快照重置到第一页', () => {
  assert.equal(shouldRefreshVisibleRoonCollection('core.ready', undefined, 'ready'), true)
  assert.equal(shouldRefreshVisibleRoonCollection('roon.changed', 'paired', 'ready'), true)
  assert.equal(shouldRefreshVisibleRoonCollection('roon.changed', 'ready', 'ready'), false)
  assert.equal(shouldRefreshVisibleRoonCollection('roon.changed', 'ready', 'paired'), false)
})
