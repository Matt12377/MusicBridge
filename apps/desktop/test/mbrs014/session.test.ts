import assert from 'node:assert/strict'
import test from 'node:test'
import * as dto from '@music-bridge/contracts'
import { useLocalLegacyLinks } from '../../src/renderer/src/composables/application/useLocalLegacyLinks.js'
import { copy, dataset, deferred, digital, editionId, fixture, id, otherEditionId, physical, source, trackId } from './fixture.js'
async function ready(context = physical()) { const f = fixture(), session = useLocalLegacyLinks(f.api); session.setContext(context); await session.read(); await session.selectTrack(trackId); if (context.key.kind !== 'draft-source') session.setEdition(editionId); session.setReason('已逐项核对明确对象与源证据'); return { ...f, session } }

test('014读取成功空态与失败分开，失败保留上次真实关系', async () => {
  const f = await ready(); assert.equal(f.session.readState.value, 'loaded'); assert.equal(f.session.active.value, null); await f.session.makePreview(); await f.session.confirm(); const saved = copy(f.session.page.value)
  f.api.readLocalLegacyLinks = async () => { throw new Error('合成读取失败') }; await f.session.read(); assert.equal(f.session.readState.value, 'failed'); assert.deepEqual(f.session.page.value, saved); assert.equal(f.session.canPreview.value, false)
})
test('014实体与数字各自保留旧身份和实际修订，无Roon前置', async () => {
  for (const context of [physical(), digital()]) { const f = await ready(context); await f.session.makePreview(); assert.equal(f.writes.length, 0); const choice = f.previewRequests[0]!.intent; assert.equal(choice.action, 'link'); if (choice.action === 'link' && choice.choice.kind === 'legacy-edition') { assert.equal(choice.choice.subject.kind, context.key.kind); assert.equal(choice.choice.subject.expectedRevision, context.revision) }; await f.session.confirm(); assert.equal(f.session.active.value?.evidence.kind, 'manual-edition') }
})
test('014同名发行必须明确选ID及revision，候选不自动选中', async () => {
  const f = await ready(); await f.session.selectTrack(trackId); assert.equal(f.session.selectedEditionId.value, ''); assert.equal(f.session.canPreview.value, false); f.session.setEdition(otherEditionId); await f.session.makePreview(); const intent = f.previewRequests[0]!.intent
  assert.equal(intent.action === 'link' && intent.choice.kind === 'legacy-edition' && intent.choice.localEditionId, otherEditionId); assert.equal(intent.action === 'link' && intent.choice.kind === 'legacy-edition' && intent.choice.expectedEditionRevision, '11')
})
test('014候选详情错identity拒绝，失败不保留旧选择用于保存', async () => {
  const f = await ready(); f.api.getLocalLibraryTrackDetail = async () => ({ ...copy(f.detail), track: { ...f.detail.track, id: id(999) } }); await f.session.selectTrack(trackId); assert.equal(f.session.detail.value, null); assert.equal(f.session.canPreview.value, false); assert.equal(f.writes.length, 0)
})
test('014当前源整文件精确track/asset/各修订，真实范围外片段拒绝', async () => {
  const f = await ready(source()); await f.session.makePreview(); const intent = f.previewRequests[0]!.intent
  assert.equal(intent.action, 'link'); if (intent.action === 'link' && intent.choice.kind === 'draft-source-track') { assert.equal(intent.choice.localTrackId, trackId); assert.equal(intent.choice.assetId, f.detail.asset.id); assert.equal(intent.choice.expectedDraftRevision, 7); assert.equal(intent.choice.expectedLibraryRootRevision, '13'); assert.equal(intent.choice.expectedFileRevision, '8'); assert.equal(intent.choice.expectedLocationRevision, '9'); assert.equal(intent.choice.expectedSegment, null) }
  f.detail.track.segment = { id: id(20), startFrame: '1', endFrameExclusive: '44100', timebaseHz: 44100 }; await f.session.selectTrack(trackId); assert.equal(f.session.sourceRangeKnown.value, false); assert.equal(f.session.canPreview.value, false); assert.equal(f.writes.length, 0)
})
test('014只预览零保存，输入改变使迟到预览失效', async () => {
  const f = await ready(), waiting = deferred<dto.LocalLegacyLinkPreview>(), original = f.api.previewLocalLegacyLink; f.api.previewLocalLegacyLink = async request => { await original(request); return waiting.promise }
  const task = f.session.makePreview(); await new Promise(resolve => setImmediate(resolve)); f.session.setReason('新核对理由'); waiting.resolve([...f.previews.values()][0]!); await task; assert.equal(f.session.preview.value, null); assert.equal(f.writes.length, 0)
})
test('014切换旧主体迟到读取零覆盖，新读取最新胜出', async () => {
  const f = fixture(), waiting = deferred<dto.LocalLegacyLinksReadPage>(), original = f.api.readLocalLegacyLinks; let first = true
  f.api.readLocalLegacyLinks = request => first ? (first = false, waiting.promise) : original(request)
  const s = useLocalLegacyLinks(f.api); s.setContext(physical()); const old = s.read(); await new Promise(resolve => setImmediate(resolve)); s.setContext(digital()); await s.read(); const before = copy(s.page.value); waiting.resolve(await original({ datasetId: dataset, selector: { by: 'legacy', key: physical().key }, state: 'all', cursor: null, limit: 20 })); await old; assert.deepEqual(s.page.value, before); assert.equal(s.context.value?.key.kind, 'digital-album')
})
test('014双击确认只派发一次，结果由真实回执与持久读取显示', async () => {
  const f = await ready(); await f.session.makePreview(); await Promise.all([f.session.confirm(), f.session.confirm()]); assert.equal(f.writes.length, 1); assert.equal(f.events.length, 1); assert.equal(f.session.active.value?.state, 'active'); assert.equal(f.session.pending.value, null)
})
test('014UNKNOWN与ACK隐藏仅读恢复历史，零自动重发', async () => {
  const f = await ready(), original = f.api.confirmLocalLegacyLink; f.api.confirmLocalLegacyLink = async request => { await original(request); throw new Error('合成ACK丢失') }
  await f.session.makePreview(); await f.session.confirm(); assert.equal(f.session.unknown.value, true); assert.equal(f.writes.length, 1); await f.session.read(); assert.equal(f.session.pending.value, null); assert.equal(f.session.active.value?.state, 'active'); assert.equal(f.writes.length, 1)
})
test('014关闭时迟到保存不更新已销毁界面、不派发新命令', async () => {
  const f = await ready(), waiting = deferred<dto.LocalLegacyLinkReceipt>(), original = f.api.confirmLocalLegacyLink; f.api.confirmLocalLegacyLink = async request => { const result = await original(request); await waiting.promise; return result }
  await f.session.makePreview(); const task = f.session.confirm(); await new Promise(resolve => setImmediate(resolve)); const before = copy(f.session.page.value); f.session.dispose(); waiting.resolve({} as dto.LocalLegacyLinkReceipt); await task; assert.deepEqual(f.session.page.value, before); assert.equal(f.writes.length, 1)
})
test('014重建会话持久读取关系与历史，零新增保存', async () => {
  const f = await ready(); await f.session.makePreview(); await f.session.confirm(); f.session.dispose(); const s = useLocalLegacyLinks(f.api); s.setContext(physical()); await s.read(); await s.readHistory(s.active.value!.linkId); assert.equal(s.active.value?.state, 'active'); assert.equal(s.history.value?.items.length, 1); assert.equal(f.writes.length, 1)
})
test('014解除与CAS撤销先get当前revision、生成预览后才明确undo', async () => {
  const f = await ready(); await f.session.makePreview(); await f.session.confirm(); const link = f.session.active.value!; f.session.beginRevoke(link); f.session.setReason('解除理由'); await f.session.makePreview(); assert.equal(f.writes.length, 1); await f.session.confirm(); assert.equal(f.session.active.value, null); const event = f.events.at(-1)!; f.session.beginUndo(event); f.session.setReason('撤销解除操作'); await f.session.makePreview(); const intent = f.previewRequests.at(-1)!.intent
  assert.equal(intent.action === 'undo' && intent.expectedLinkRevision, '2'); assert.equal(intent.action === 'undo' && intent.undoTransitionEventId, event.eventId); assert.equal(f.readRequests.at(-1)!.selector.by, 'link'); assert.equal(f.writes.length, 2); await f.session.confirm(); assert.equal(f.session.page.value?.items.find(link => link.state === 'active')?.revision, '3'); assert.equal(f.events.at(-1)?.action, 'undone'); assert.equal(f.writes.length, 3)
})
test('014CAS拒绝不假装关联成功，重新读取保留原状态', async () => {
  const f = await ready(); f.api.confirmLocalLegacyLink = async request => { f.writes.push(request); return { datasetId: dataset, commandId: request.commandId, action: 'confirm', previewId: request.previewId, outcome: 'rejected', link: null, transitionEventId: null, issue: 'LEFT_SLOT_CHANGED' } }; await f.session.makePreview(); await f.session.confirm(); assert.equal(f.session.active.value, null); assert.equal(f.session.notice.value, ''); assert.match(f.session.error.value, /已改变/u); assert.equal(f.writes.length, 1)
})
test('014切库确认前零派发，原公开outbox UNKNOWN不会自动重发', async () => {
  const f = await ready(); await f.session.makePreview(); f.setDataset(id(99)); await f.session.confirm(); assert.equal(f.writes.length, 0); assert.match(f.session.error.value, /工作库已改变/u)
  const g = await ready(); g.setOutbox([{ id: id(91), commandId: id(92), command: 'localLegacyLinks.confirm', datasetId: dataset, state: 'uncertain', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), acknowledged: false, canRetry: true }]); await g.session.read(); assert.equal(g.session.unknown.value, true); await g.session.makePreview(); assert.equal(g.writes.length, 0)
})
test('014迟到确认按各自Pending归属，新对象saving不被旧finally清掉', async () => {
  const f = await ready(), first = deferred<dto.LocalLegacyLinkReceipt>(), second = deferred<dto.LocalLegacyLinkReceipt>(), original = f.api.confirmLocalLegacyLink; let calls = 0
  f.api.confirmLocalLegacyLink = async request => { const result = await original(request); await (++calls === 1 ? first.promise : second.promise); return result }
  await f.session.makePreview(); const old = f.session.confirm(); await new Promise(resolve => setImmediate(resolve)); f.session.setContext(digital()); await f.session.read(); await f.session.selectTrack(trackId); f.session.setEdition(editionId); f.session.setReason('核对另一个明确数字对象'); await f.session.makePreview(); const newer = f.session.confirm(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.session.saving.value, true)
  first.resolve({} as dto.LocalLegacyLinkReceipt); await old; assert.equal(f.session.saving.value, true); assert.equal(f.session.notice.value, ''); second.resolve({} as dto.LocalLegacyLinkReceipt); await newer; assert.equal(f.session.saving.value, false); assert.equal(f.session.active.value?.endpoints.kind === 'legacy-edition' && f.session.active.value.endpoints.subject.kind, 'digital-album'); assert.equal(f.writes.length, 2)
})
test('014历史超过100条与关系后续cursor页，明确更多读取恢复UNKNOWN且零重派', async () => {
  const f = await ready(), original = f.api.confirmLocalLegacyLink; f.api.confirmLocalLegacyLink = async request => { await original(request); throw new Error('合成ACK隐藏') }; await f.session.makePreview(); await f.session.confirm(); const actual = copy(f.events[0]!), link = copy(f.links.values().next().value!)
  const prior = Array.from({ length: 105 }, (_, n) => ({ ...copy(actual), eventId: id(2000 + n), commandId: id(3000 + n), previewId: id(4000 + n), after: { ...copy(actual.after), lastTransitionEventId: id(2000 + n) } })), all = [...prior, actual]
  f.api.historyLocalLegacyLinks = async request => { const offset = request.cursor ? Number(request.cursor.split('_')[1]) : 0, selected = all.slice(offset, offset + request.limit), hasMore = offset + request.limit < all.length; return { datasetId: dataset, linkId: link.linkId, snapshotFingerprint: 'c'.repeat(64), limit: request.limit, items: selected, cursor: hasMore ? `cursor_${offset + request.limit}` : null, hasMore } }
  f.api.readLocalLegacyLinks = async request => ({ datasetId: dataset, selectorFingerprint: 'a'.repeat(64), snapshotFingerprint: 'b'.repeat(64), limit: request.limit, items: request.cursor ? [link] : [], slot: request.selector.by === 'legacy' ? { activeLinkId: link.linkId, lastTransitionEventId: link.lastTransitionEventId } : null, cursor: request.cursor ? null : 'more-links', hasMore: !request.cursor })
  await f.session.read(); assert.equal(f.session.unknown.value, true); await f.session.read(true); assert.equal(f.session.unknown.value, true); await f.session.readHistory(link.linkId); for (let n = 0; n < 5; n++) await f.session.readHistory(link.linkId, true); assert.equal(f.session.pending.value, null); assert.equal(f.session.unknown.value, false); assert.equal(f.writes.length, 1)
})
