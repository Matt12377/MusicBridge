import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateVirtualWindow } from '../src/renderer/src/composables/virtualWindow.js'

test('virtual window keeps a bounded render range for a thousand rows', () => {
  const window = calculateVirtualWindow(1_000, 5_000, 620, 58, 8)
  assert.equal(window.totalHeight, 58_000)
  assert.equal(window.start, 78)
  assert.equal(window.end, 105)
  assert.equal(window.bottomSpacer, 51_910)
  assert.equal(window.end - window.start, 27)
})

test('virtual window clamps at collection boundaries', () => {
  assert.deepEqual(calculateVirtualWindow(5, 99_999, 620, 58, 8), {
    start: 0,
    end: 5,
    topSpacer: 0,
    bottomSpacer: 0,
    totalHeight: 290,
  })
})
