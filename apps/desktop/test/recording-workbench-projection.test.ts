import assert from 'node:assert/strict'
import test from 'node:test'
import type { MediaLayoutSpec } from '@music-bridge/contracts'
import { projectWorkbenchSegment, releaseWorkbenchDistribution } from '../src/renderer/src/components/recording/recording-workbench-projection.js'

const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000,
  rules: [{ trackId: 'b', sideOpener: true }], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: false },
  distribution: { schemaVersion: 1, groupId: 'group', segmentIndex: 1, segmentSpecs: [{ trackIds: ['a', 'b'] }, { trackIds: ['c', 'd'] }] } }

test('工作台第 2 盘只显示本盘曲序，完整母版或分盘漂移时不沿用错误投影', () => {
  assert.deepEqual(projectWorkbenchSegment(spec, ['a', 'b', 'c', 'd']), { trackIds: ['c', 'd'], segmentIndex: 1, segmentCount: 2, invalid: false })
  assert.deepEqual(projectWorkbenchSegment(spec, ['a', 'c', 'b', 'd']), { trackIds: ['a', 'c', 'b', 'd'], invalid: true })
  assert.deepEqual(projectWorkbenchSegment(spec, ['a', 'b', 'c', 'd', 'e']), { trackIds: ['a', 'b', 'c', 'd', 'e'], invalid: true })
})

test('显式退出分盘仅改当前编辑稿，不改旧规划对象或其规则', () => {
  const next = releaseWorkbenchDistribution(spec, 4)
  assert.equal(next.distribution, undefined)
  assert.equal(next.splitAfter, 2)
  assert.deepEqual(next.rules, [])
  assert.equal(spec.distribution?.segmentIndex, 1)
  assert.deepEqual(spec.rules, [{ trackId: 'b', sideOpener: true }])
})
