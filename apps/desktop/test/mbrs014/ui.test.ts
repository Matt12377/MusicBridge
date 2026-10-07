import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { editionId, fixture, id, physical, source, trackId } from './fixture.js'
import { mounted } from './ui-host.js'
const root = path.resolve(import.meta.dirname, '../../src/renderer/src/components'), file = path.join(root, 'legacy/LocalLegacyLinksPanel.vue')
type Ui = Awaited<ReturnType<typeof mounted>>
const button = (ui: Ui, label: string) => ui.all().find(el => el.type === 'button' && ui.text(el) === label)
const named = (ui: Ui, label: string) => ui.all().find(el => el.props['aria-label'] === label)
async function select(ui: Ui, context = physical()) {
  await ui.click(button(ui, context.key.kind === 'draft-source' ? '关联当前源到本地曲目' : '关联本地发行'))
  await ui.click(named(ui, `查看本地候选 ${trackId}`)); if (context.key.kind !== 'draft-source') await ui.change(ui.all().find(el => el.type === 'select' && ui.text(el.parent!).includes('具体本地发行')), editionId)
  await ui.input(ui.all().find(el => el.type === 'textarea'), '核对明确旧对象与本地候选')
}
test('014真实新面板六API存在时可选具体发行、只预览后确认，关闭返回焦点', async t => {
  const f = fixture(), ui = await mounted(t, file, { context: physical() }, f.api); assert.match(ui.text(), /未建立本地关联/u)
  const opener = button(ui, '关联本地发行')!; await select(ui); await ui.click(button(ui, '预览关联本地发行')); assert.equal(f.writes.length, 0); assert.equal(ui.text(ui.active()!), '预览关联本地发行'); assert.doesNotMatch(ui.text(), /previewHash|contextFingerprint|[de]{64}/u)
  const region = named(ui, '本地发行关联')!; region.props.onKeydown(ui.event(region, 'Escape')); await ui.settle(); assert.equal(ui.active() === opener, true); assert.equal(f.writes.length, 0)
  await select(ui); await ui.click(button(ui, '预览关联本地发行')); await ui.click(button(ui, '确认关联本地发行')); assert.equal(f.writes.length, 1); assert.match(ui.text(), /本地关联已保存/u); await ui.click(button(ui, '关闭本地关联编辑')); assert.equal(ui.active() === button(ui, '重新读取本地关联'), true)
})
test('014面板读取失败不显示未关联；UNKNOWN只提供读恢复，不派发第二次', async t => {
  const f = fixture(); f.api.readLocalLegacyLinks = async () => { throw new Error('合成读取失败') }; const ui = await mounted(t, file, { context: physical() }, f.api); assert.doesNotMatch(ui.text(), /未建立本地关联/u); assert.equal(button(ui, '关联本地发行'), undefined); assert.equal(f.writes.length, 0)
})
test('014当前源完整闭环确认、解除、历史CAS撤销，不触动旧源证据', async t => {
  const f = fixture(), ui = await mounted(t, file, { context: source() }, f.api); await select(ui, source()); await ui.click(button(ui, '预览关联当前源')); assert.match(ui.text(), /完整文件.*SHA-256/u); await ui.click(button(ui, '确认关联当前源')); assert.equal(f.writes.length, 1)
  await ui.click(button(ui, '解除本地关联')); await ui.input(ui.all().find(el => el.type === 'textarea'), '保留旧证据，解除本地关系'); await ui.click(button(ui, '预览解除本地关联')); assert.equal(f.writes.length, 1); await ui.click(button(ui, '确认解除本地关联')); assert.equal(f.writes.length, 2)
  await ui.click(button(ui, '关闭本地关联编辑')); await ui.click(button(ui, '查看本地关系历史')); await ui.click(button(ui, '撤销这次关系操作')); await ui.input(ui.all().find(el => el.type === 'textarea'), '撤销这次解除'); await ui.click(button(ui, '预览撤销本地关系操作')); assert.equal(f.writes.length, 2); await ui.click(button(ui, '确认撤销本地关系操作')); assert.equal(f.writes.length, 3); assert.equal(f.events.at(-1)?.action, 'undone'); assert.equal(f.links.values().next().value?.endpoints.kind, 'draft-source-track')
})
test('014原PhysicalRelations在生产六方法存在时自然异步加载，旧Roon入口保留', async t => {
  const f = fixture(), api = { ...f.api, onCoreEvent: () => () => {}, getPhysicalLinks: async () => ({ releaseId: id(6), revision: 3, digitalAbsenceConfirmed: false, links: [] }), getPhysicalLinkHistory: async () => ({ offset: 0, limit: 20, total: 0, hasMore: false, items: [] }) }
  const ui = await mounted(t, path.join(root, 'collection/PhysicalRelations.vue'), { release: { id: id(6), kind: 'cd', title: '原实体发行', artist: '原作者', quantity: 1, revision: 3, contentStatus: 'commercial' } }, api)
  assert.ok(button(ui, '关联 Roon 专辑')); assert.ok(button(ui, '关联本地发行')); await select(ui); await ui.click(button(ui, '预览关联本地发行')); assert.equal(f.previewRequests.length, 1)
})
test('014原SourceEvidencePanel六方法存在时加载完整当前源区域，旧文件入口继续可用', async t => {
  const f = fixture(), binding = { id: id(10), rootId: id(12), draftId: id(8), trackId: id(9), fileName: 'fixture.wav', size: 88244, sha256: 'f'.repeat(64), acquisition: 'userFileBind', availability: 'ONLINE', technical: { container: 'WAV', codec: 'PCM', sampleRate: 44100, bitsPerSample: 16, channels: 2, durationMs: 1000 }, modifiedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), userConfirmed: true, sourceLockEligible: true }
  const ui = await mounted(t, path.join(root, 'recording/SourceEvidencePanel.vue'), { draftId: id(8), draftRevision: 7, trackId: id(9), title: '旧源曲目', inline: true }, { ...f.api, listRecordingSourceRoots: async () => ({ roots: [{ id: id(12), label: '已有源目录', availability: 'ONLINE', authorized: true }] }), getDraftSources: async () => ({ draftId: id(8), sourceLockEligible: true, tracks: [{ trackId: id(9), binding, jobs: [] }] }) })
  assert.ok(button(ui, '选择文件并校验')); assert.ok(button(ui, '重新完整校验')); assert.ok(button(ui, '关联当前源到本地曲目')); await select(ui, source()); await ui.click(button(ui, '预览关联当前源')); assert.equal(f.previewRequests.length, 1); assert.equal(f.writes.length, 0)
})
