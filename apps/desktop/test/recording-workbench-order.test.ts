import assert from 'node:assert/strict'
import test from 'node:test'
import type { MediaLayoutSpec } from '@music-bridge/contracts'
import { moveWorkbenchGroup, pruneRulesAfterTrackRemoval } from '../src/renderer/src/components/recording/recording-workbench-order.js'

const cassette = (rules: MediaLayoutSpec['rules'] = []): MediaLayoutSpec => ({ format: 'cassette', splitAfter: 2, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules, compatibility: { confirmed: false, cassetteTypes: [], dat: false } })
const reason = (result: ReturnType<typeof moveWorkbenchGroup>): string => result.ok ? '' : result.reason

test('连播组按整体排序及跨面，A 面不能变空', () => {
  const spec = cassette([{ trackId: 'a', keepWithNext: true }])
  assert.deepEqual(moveWorkbenchGroup({ trackIds: ['a', 'b', 'c', 'd'], splitAfter: 2 }, spec, 'b', { side: 'B' }), { ok: false, reason: 'A 面至少需要一首曲目，不能把最后一组移到 B 面。' })
  assert.deepEqual(moveWorkbenchGroup({ trackIds: ['a', 'b', 'c', 'd'], splitAfter: 2 }, spec, 'c', { side: 'A' }), { ok: true, order: { trackIds: ['a', 'b', 'c', 'd'], splitAfter: 3 } })
  assert.deepEqual(moveWorkbenchGroup({ trackIds: ['a', 'b', 'c', 'd'], splitAfter: 2 }, spec, 'b', { direction: 1 }), { ok: false, reason: '这一组已在本段边缘；跨面请使用“移至另一面”。' })
})

test('DAT 连续节目可整组排序，但不能移面', () => {
  const spec: MediaLayoutSpec = { ...cassette([{ trackId: 'a', keepWithNext: true }]), format: 'dat', splitAfter: 0 }
  assert.deepEqual(moveWorkbenchGroup({ trackIds: ['a', 'b', 'c'], splitAfter: 0 }, spec, 'a', { direction: 1 }), { ok: true, order: { trackIds: ['c', 'a', 'b'], splitAfter: 0 } })
  assert.match(reason(moveWorkbenchGroup({ trackIds: ['a', 'b', 'c'], splitAfter: 0 }, spec, 'c', { side: 'A' })), /DAT/u)
})

test('指定面和首末曲规则冲突明确拒绝', () => {
  const order = { trackIds: ['a', 'b', 'c'], splitAfter: 2 }
  assert.match(reason(moveWorkbenchGroup(order, cassette([{ trackId: 'c', forceSide: 'B' }]), 'c', { side: 'A' })), /指定面/u)
  assert.match(reason(moveWorkbenchGroup(order, cassette([{ trackId: 'b', sideCloser: true }]), 'a', { direction: 1 })), /末曲/u)
})

test('删曲整理旧逐曲规则，原连播关系不误绑到新邻曲', () => {
  const rules = [{ trackId: 'a', keepWithNext: true, forceSide: 'A' as const }, { trackId: 'b', keepWithNext: true, sideCloser: true, forceSide: 'A' as const }, { trackId: 'c', forceSide: 'B' as const }]
  assert.deepEqual(pruneRulesAfterTrackRemoval(['a', 'b', 'c'], rules, 'b'), [{ trackId: 'a', forceSide: 'A' }, { trackId: 'c', forceSide: 'B' }])
  assert.deepEqual(rules[0], { trackId: 'a', keepWithNext: true, forceSide: 'A' }, '已存规则输入不得原地改写')
})
