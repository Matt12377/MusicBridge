import assert from 'node:assert/strict'
import test from 'node:test'
import { isScanJobRecord, type LocalLibraryPublicApi, type ScanJobRecord } from '@music-bridge/contracts'
import { controlLocalLibraryScan } from '../src/renderer/src/composables/application/local-library-browser/scan-control.js'

type ScanApi = Pick<LocalLibraryPublicApi, 'localLibraryScan'>
const id = (value: number): string => `88888888-8888-4888-8888-${String(value).padStart(12, '0')}`
const commandId = id(100)
function job(overrides: Partial<ScanJobRecord> = {}): ScanJobRecord {
  return { schemaVersion: '1.2', jobId: id(1), datasetId: id(2), libraryRootId: id(3), sourceRootId: id(4),
    rootRevision: '1', jobRevision: '10', checkpointRef: null, phase: 'running',
    progress: { visited: '1', accepted: '1', rejected: '0' }, failureCode: null, ...overrides }
}
function port(read: () => unknown | Promise<unknown>, mutate: () => unknown | Promise<unknown> = () => job()) {
  const calls: { command: string; payload: unknown }[] = []
  const api: ScanApi = { async localLibraryScan(command, payload) {
    calls.push({ command, payload: structuredClone(payload) })
    if (command === 'localScan.get') return await read() as never
    assert.ok(['localScan.pause', 'localScan.resume', 'localScan.cancel'].includes(command), '禁止额外查询或新增其它mutation')
    return await mutate() as never
  } }
  return { api, calls }
}

for (const operation of ['pause', 'resume', 'cancel'] as const) {
  test(`扫描控制${operation}：旧UI修订先读同job最新状态，原commandId只发送一次且不修改输入`, async () => {
    const observed = job({ jobRevision: '1', phase: operation === 'resume' ? 'paused' : 'running' }), before = structuredClone(observed)
    Object.freeze(observed.progress); Object.freeze(observed)
    const latest = job({ jobRevision: '56', phase: observed.phase, checkpointRef: id(6), progress: { visited: '60', accepted: '60', rejected: '0' } })
    assert.ok(isScanJobRecord(latest))
    const result = job({ jobRevision: '57', phase: operation === 'resume' ? 'running' : operation === 'pause' ? 'paused' : 'cancelled' })
    const f = port(() => structuredClone(latest), () => result)
    assert.equal(await controlLocalLibraryScan(f.api, observed, operation, commandId), result)
    assert.deepEqual(f.calls, [
      { command: 'localScan.get', payload: { jobId: observed.jobId } },
      { command: `localScan.${operation}`, payload: { commandId, jobId: observed.jobId, expectedRevision: '56' } },
    ])
    assert.deepEqual(observed, before)
  })
}

for (const field of ['jobId', 'datasetId', 'libraryRootId', 'sourceRootId', 'rootRevision'] as const) {
  test(`扫描控制：最新${field}改变不得发送mutation`, async () => {
    const observed = job(), latest = job()
    if (field === 'rootRevision') latest.rootRevision = '2'
    else latest[field] = id(999)
    assert.ok(isScanJobRecord(latest))
    const f = port(() => latest, () => { assert.fail('身份变化不得控制任何任务') })
    await assert.rejects(controlLocalLibraryScan(f.api, observed, 'cancel', commandId), /\[INVENTORY_CONFLICT\]/u)
    assert.deepEqual(f.calls, [{ command: 'localScan.get', payload: { jobId: observed.jobId } }])
    assert.deepEqual(observed, job())
  })
}

for (const [label, latest] of [
  ['null', null], ['坏修订', job({ jobRevision: '00' })],
  ['坏进度', job({ progress: { visited: '1', accepted: '2', rejected: '0' } })],
  ['额外字段', { ...job(), unsupported: true }],
] as const) {
  test(`扫描控制：get返回${label}未通过ScanJobRecord校验不得mutation`, async () => {
    assert.equal(isScanJobRecord(latest), false)
    const f = port(() => latest, () => { assert.fail('无效读回不得mutation') })
    await assert.rejects(controlLocalLibraryScan(f.api, job(), 'pause', commandId), /\[INVENTORY_CONFLICT\]/u)
    assert.equal(f.calls.length, 1)
  })
}

test('扫描控制：get失败保留原错误且不得mutation或重试get', async () => {
  const failure = new Error('合成读回失败'), f = port(() => { throw failure }, () => { assert.fail('get失败不得mutation') })
  await assert.rejects(controlLocalLibraryScan(f.api, job(), 'cancel', commandId), cause => cause === failure)
  assert.deepEqual(f.calls, [{ command: 'localScan.get', payload: { jobId: id(1) } }])
})

for (const message of ['[INVENTORY_CONFLICT] 合成最新CAS再次变化', 'TIMEOUT：合成控制结果未知', '合成网络拒绝']) {
  test(`扫描控制：mutation拒绝“${message}”只发送一次，不重读或变参重试`, async () => {
    const observed = job({ jobRevision: '1' }), before = structuredClone(observed), latest = job({ jobRevision: '60' })
    const failure = new Error(message), f = port(() => structuredClone(latest), () => { latest.jobRevision = '99'; throw failure })
    await assert.rejects(controlLocalLibraryScan(f.api, observed, 'cancel', commandId), cause => cause === failure)
    assert.deepEqual(f.calls, [
      { command: 'localScan.get', payload: { jobId: observed.jobId } },
      { command: 'localScan.cancel', payload: { commandId, jobId: observed.jobId, expectedRevision: '60' } },
    ])
    assert.deepEqual(observed, before)
  })
}
