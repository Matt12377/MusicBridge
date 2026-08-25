import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createZoneRefreshCoordinator,
  resolveZoneLifecycleStatus,
  zoneLifecycleLabel,
} from '../src/renderer/src/zone-lifecycle.js'

test('Zone lifecycle 区分 Core、加载、空列表、未选择和已选择', () => {
  assert.equal(resolveZoneLifecycleStatus({ roonStatus: 'disconnected', loading: false, zoneCount: 0, selected: false }), 'core-disconnected')
  assert.equal(resolveZoneLifecycleStatus({ roonStatus: 'discovering', loading: true, zoneCount: 0, selected: false }), 'core-disconnected')
  assert.equal(resolveZoneLifecycleStatus({ roonStatus: 'paired', loading: true, zoneCount: 0, selected: false }), 'loading')
  assert.equal(resolveZoneLifecycleStatus({ roonStatus: 'ready', loading: false, zoneCount: 0, selected: false }), 'empty')
  assert.equal(resolveZoneLifecycleStatus({ roonStatus: 'ready', loading: false, zoneCount: 2, selected: false }), 'unselected')
  assert.equal(resolveZoneLifecycleStatus({ roonStatus: 'ready', loading: false, zoneCount: 2, selected: true }), 'selected')
})

test('Zone lifecycle 为每个公开状态提供明确文案', () => {
  assert.equal(zoneLifecycleLabel('core-disconnected'), 'Core 已断开')
  assert.equal(zoneLifecycleLabel('loading'), '正在读取播放设备')
  assert.equal(zoneLifecycleLabel('empty'), '没有可用播放设备')
  assert.equal(zoneLifecycleLabel('unselected'), '尚未选择播放设备')
  assert.equal(zoneLifecycleLabel('selected'), '播放设备已选择')
})

test('Zone refresh coordinator 合并 Core 与 Remote ready 的突发刷新', async () => {
  let loads = 0
  const snapshots: readonly string[][] = []
  const mutableSnapshots = snapshots as string[][]
  const coordinator = createZoneRefreshCoordinator({
    debounceMs: 1,
    load: async () => {
      loads += 1
      return [{ zoneId: 'zone-1', displayName: 'Zone 1', selected: false }]
    },
    onZones: (zones) => mutableSnapshots.push(zones.map((zone) => zone.zoneId)),
    onLoading: () => undefined,
    onError: (error) => assert.fail(String(error)),
  })

  coordinator.handleCoreEvent('core.ready', 'paired')
  coordinator.handleCoreEvent('roon.changed', 'ready')
  coordinator.handleRemoteCoreState('ready')
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(loads, 1)
  assert.deepEqual(snapshots, [['zone-1']])
  coordinator.dispose()
})

test('Zone refresh coordinator 只提交最后启动的响应', async () => {
  const resolvers: Array<(zones: readonly { zoneId: string; displayName: string; selected: boolean }[]) => void> = []
  const snapshots: readonly string[][] = []
  const mutableSnapshots = snapshots as string[][]
  const coordinator = createZoneRefreshCoordinator({
    load: () => new Promise((resolve) => resolvers.push(resolve)),
    onZones: (zones) => mutableSnapshots.push(zones.map((zone) => zone.zoneId)),
    onLoading: () => undefined,
    onError: (error) => assert.fail(String(error)),
  })

  const older = coordinator.refreshNow()
  const newer = coordinator.refreshNow()
  resolvers[1]?.([{ zoneId: 'latest-zone', displayName: 'Latest Zone', selected: false }])
  await newer
  resolvers[0]?.([])
  await older

  assert.deepEqual(snapshots, [['latest-zone']])
  coordinator.dispose()
})

test('Zone refresh coordinator 在 Core 断连时清空并失效进行中的请求', async () => {
  let resolveLoad: ((zones: readonly { zoneId: string; displayName: string; selected: boolean }[]) => void) | undefined
  const snapshots: readonly string[][] = []
  const mutableSnapshots = snapshots as string[][]
  const loading: boolean[] = []
  const coordinator = createZoneRefreshCoordinator({
    load: () => new Promise((resolve) => { resolveLoad = resolve }),
    onZones: (zones) => mutableSnapshots.push(zones.map((zone) => zone.zoneId)),
    onLoading: (value) => loading.push(value),
    onError: (error) => assert.fail(String(error)),
  })

  const pending = coordinator.refreshNow()
  coordinator.handleCoreEvent('roon.changed', 'disconnected')
  resolveLoad?.([{ zoneId: 'stale-zone', displayName: 'Stale Zone', selected: false }])
  await pending

  assert.deepEqual(snapshots, [[]])
  assert.equal(loading.at(-1), false)
  coordinator.dispose()
})

test('Zone refresh coordinator 在 Remote Core 停止时立即清空陈旧 Zone', async () => {
  const snapshots: readonly string[][] = []
  const mutableSnapshots = snapshots as string[][]
  const coordinator = createZoneRefreshCoordinator({
    load: async () => [{ zoneId: 'stale-zone', displayName: 'Stale Zone', selected: true }],
    onZones: (zones) => mutableSnapshots.push(zones.map((zone) => zone.zoneId)),
    onLoading: () => undefined,
    onError: (error) => assert.fail(String(error)),
  })

  await coordinator.refreshNow()
  coordinator.handleRemoteCoreState('stopping')

  assert.deepEqual(snapshots, [['stale-zone'], []])
  coordinator.dispose()
})
