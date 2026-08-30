import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionAsset, ArchiveOperationView, LayoutVersion, RecordingPlanProposal, RecordingPlanVersion, RecordingPreflightResult } from '@music-bridge/contracts'
import type { RecordingPlanApi } from '../src/renderer/src/components/recording/recording-plan-controller.js'

const id = (n: number) => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = '2026-08-28T00:00:00.000Z', hash = 'a'.repeat(64)
function fixture() {
  // 这里只构造控制器读取的字段；完整计划的跨字段守恒由合同和真实Core测试覆盖。
  const assets = [1, 2].map(n => ({ id: id(n), draftId: id(10), layoutVersionId: id(11), masterVersionId: id(12), mode: 'direct', createdAt: stamp, manifestHash: hash } as ExecutionAsset))
  const operations = [1, 2].map(n => ({ id: id(n + 20), assetId: id(n), draftId: id(10), layoutVersionId: id(11), masterVersionId: id(12), phase: 'FINALIZED', active: false, createdAt: stamp } as ArchiveOperationView))
  const selection = { assetId: id(2), archiveOperationId: id(22) }
  const proposal = { draftId: id(10), selection, proposalFingerprint: hash, checkedAt: stamp, execution: { assetId: id(2) }, archive: { operationId: id(22) }, formalReady: false } as RecordingPlanProposal
  const version = { id: id(30), draftId: id(10), sequence: 1, createdAt: stamp, execution: { assetId: id(2) }, archive: { operationId: id(22) }, formalReady: false } as RecordingPlanVersion
  const preflight = { planVersionId: version.id, checkedAt: stamp, state: 'blocked', gateB: 'NOT_RUN', checks: [{ category: 'backend', state: 'not-run', code: 'BACKEND_NOT_CERTIFIED' }], formalReady: false } as RecordingPreflightResult
  const calls: { name: string; value?: unknown }[] = []
  const api: RecordingPlanApi = {
    async listExecutionAssets() { calls.push({ name: 'assets' }); return { draftId: id(10), assets, jobs: [] } },
    async listArchives() { calls.push({ name: 'archives' }); return { draftId: id(10), operations } },
    async listMasterVersions() { calls.push({ name: 'layouts' }); return { draftId: id(10), masters: [], layouts: [{ id: id(11), draftId: id(10), masterVersionId: id(12) } as LayoutVersion], jobs: [] } },
    async listRecordingPlans() { calls.push({ name: 'plans' }); return { draftId: id(10), versions: [version] } },
    async getRecordingPlanVersion(value) { calls.push({ name: 'version', value }); return { plan: version } },
    async previewRecordingPlan(value) { calls.push({ name: 'preview', value: structuredClone(value) }); return proposal },
    async freezeRecordingPlan(value) { calls.push({ name: 'freeze', value: structuredClone(value) }); return version },
    async preflightRecordingPlan(value) { calls.push({ name: 'preflight', value }); return preflight },
    async cancelRecordingPlanRead(value) { calls.push({ name: 'cancel', value }); return { cancelled: true } },
  }
  return { api, assets, operations, selection, proposal, version, preflight, calls }
}
async function controller(f = fixture(), initialContext?: { layoutId: string; mode: 'direct' | 'prepared-reference'; preparedId?: string }) {
  const module = await import('../src/renderer/src/components/recording/recording-plan-controller.js').catch(() => ({}))
  assert.ok('createRecordingPlanController' in module, '缺少明确选择、代际隔离的计划控制器')
  const create = (module as typeof import('../src/renderer/src/components/recording/recording-plan-controller.js')).createRecordingPlanController
  const c = create({ api: f.api, draftId: id(10), initialContext })
  return { ...f, c }
}
async function select(f: Awaited<ReturnType<typeof controller>>) {
  await f.c.refresh(); f.c.selectAsset(id(2)); f.c.selectArchive(id(22))
}

test('计划读取不默认选择资产/归档/历史版本，不自动预检、冻结或播放', async () => {
  const f = await controller(); assert.equal(f.c.state.status, 'unread'); await f.c.refresh()
  assert.equal(f.c.state.status, 'ready'); assert.equal(f.c.state.assetId, ''); assert.equal(f.c.state.archiveOperationId, ''); assert.equal(f.c.state.version, undefined)
  assert.deepEqual(f.calls.map(x => x.name).sort(), ['archives', 'assets', 'layouts', 'plans']); f.c.dispose()
})
test('明确选择非首资产和同谱系FINALIZED归档，换资产清空下游而不猜最近记录', async () => {
  const f = await controller(); await select(f)
  assert.deepEqual(f.c.selection(), f.selection)
  f.c.selectArchive(id(21)); assert.equal(f.c.state.archiveOperationId, '')
  f.operations[1]!.phase = 'STAGED'; await f.c.refresh(); f.c.selectArchive(id(22)); assert.equal(f.c.state.archiveOperationId, '')
  f.c.selectAsset(id(1)); assert.equal(f.c.state.archiveOperationId, '')
  f.c.dispose()
})
test('明确无效布局/PREP上下文与跨草稿历史不得fallback到其他资产', async () => {
  for (const context of [{ layoutId: '', mode: 'direct' as const }, { layoutId: id(99), mode: 'direct' as const }, { layoutId: id(11), mode: 'prepared-reference' as const, preparedId: id(90) }]) {
    const f = await controller(fixture(), context); await f.c.refresh(); assert.equal(f.c.assets().length, 0); assert.equal(f.c.state.assetId, ''); f.c.dispose()
  }
  const f = await controller(); f.api.listArchives = async () => ({ draftId: id(99), operations: [] }); await f.c.refresh(); assert.equal(f.c.state.status, 'error'); assert.equal(f.c.selection(), undefined); f.c.dispose()
})
test('预览明确选择后仍需人工确认；冻结仅发送ID与提案指纹并选中新计划', async () => {
  const f = await controller(); await select(f); await f.c.preview(); await f.c.freeze()
  assert.equal(f.calls.filter(x => x.name === 'freeze').length, 0)
  f.c.confirm(true); await f.c.freeze()
  const sent = f.calls.find(x => x.name === 'freeze')!.value as Record<string, unknown>
  assert.deepEqual(Object.keys(sent).sort(), ['commandId', 'proposalFingerprint', 'selection', 'userConfirmed'])
  assert.deepEqual(sent.selection, f.selection); assert.equal(sent.proposalFingerprint, hash); assert.equal(sent.userConfirmed, true)
  assert.equal(f.c.state.version?.id, f.version.id); assert.equal(f.c.state.preflight, undefined); assert.equal(f.calls.some(x => x.name === 'preflight'), false); f.c.dispose()
})
test('未知冻结结果锁住原DTO，只有明确重试才发送相同commandId和body', async () => {
  const f = await controller(); await select(f); await f.c.preview(); f.c.confirm(true)
  const actual = f.api.freezeRecordingPlan; let fails = true
  f.api.freezeRecordingPlan = async request => { await actual(request); if (fails) throw new Error('未知回执'); return f.version }
  await f.c.freeze(); assert.ok(f.c.state.pending); f.c.selectAsset(id(1)); assert.deepEqual(f.c.selection(), f.selection)
  fails = false; await f.c.retry(); const calls = f.calls.filter(x => x.name === 'freeze')
  assert.equal(calls.length, 2); assert.deepEqual(calls[0]!.value, calls[1]!.value); assert.equal(f.c.state.pending, undefined); f.c.dispose()
})
test('明确冻结冲突清空提案和确认，不自动新建命令或保留旧成功预检', async () => {
  const f = await controller(); await select(f); await f.c.preview(); f.c.confirm(true)
  f.api.freezeRecordingPlan = async () => { throw new Error('[INVENTORY_CONFLICT] /private/synthetic') }
  await f.c.freeze(); assert.equal(f.c.state.pending, undefined); assert.equal(f.c.state.proposal, undefined); assert.equal(f.c.state.confirmed, false); assert.doesNotMatch(f.c.state.error, /private/u); f.c.dispose()
})
test('只对明确选择的计划读取预检，Gate B阻断不改写旧快照', async () => {
  const f = await controller(); await f.c.refresh(); await f.c.preflight(); assert.equal(f.calls.some(x => x.name === 'preflight'), false)
  await f.c.readVersion(id(30)); const before = JSON.stringify(f.c.state.version); await f.c.preflight()
  assert.equal(f.c.state.preflight?.gateB, 'NOT_RUN'); assert.equal(f.c.state.preflight?.formalReady, false); assert.equal(JSON.stringify(f.c.state.version), before)
  f.api.preflightRecordingPlan = async () => { throw new Error('private') }; await f.c.preflight(); assert.equal(f.c.state.preflight, undefined); assert.ok(f.c.state.error); f.c.dispose()
})
test('读取失败不伪装空历史，刷新先使旧提案和确认失效', async () => {
  const f = await controller(); await select(f); await f.c.preview(); f.c.confirm(true)
  f.api.listArchives = async () => { throw new Error('/private/source') }; await f.c.refresh()
  assert.equal(f.c.state.status, 'error'); assert.equal(f.c.state.proposal, undefined); assert.equal(f.c.state.confirmed, false); assert.equal(f.c.selection(), undefined); assert.doesNotMatch(f.c.state.error, /private/u); f.c.dispose()
})
test('取消与卸载使迟到预览失效，取消只读不发送冻结', async () => {
  for (const action of ['cancel', 'dispose'] as const) {
    const f = await controller(); await select(f)
    let resolve!: (value: RecordingPlanProposal) => void
    f.api.previewRecordingPlan = () => new Promise(done => { resolve = done })
    const loading = f.c.preview(); const readId = f.c.state.readId; assert.ok(readId)
    if (action === 'cancel') await f.c.cancelRead(); else f.c.dispose()
    resolve(f.proposal); await loading; assert.equal(f.c.state.proposal, undefined)
    assert.ok(f.calls.some(x => x.name === 'cancel' && x.value === readId)); assert.equal(f.calls.some(x => x.name === 'freeze'), false)
  }
})


test('读取历史版本清空未冻结提案；另选资产清空旧计划预检避免混用两个对象', async () => {
  const f = await controller(); await select(f); await f.c.preview(); f.c.confirm(true)
  await f.c.readVersion(id(30)); assert.equal(f.c.state.proposal, undefined); assert.equal(f.c.state.confirmed, false)
  await f.c.preflight(); assert.ok(f.c.state.preflight)
  f.c.selectAsset(id(1)); assert.equal(f.c.state.version, undefined); assert.equal(f.c.state.preflight, undefined); f.c.dispose()
})
