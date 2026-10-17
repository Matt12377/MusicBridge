import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalLyricsInventory } from '../src/collection/local-library-lyrics/inventory.js'
import type { LocalLyricsPorts, LocalLyricsCapture, LocalLyricsInventoryObservation } from '../src/collection/local-library-lyrics/types.js'
function fixture() {
  const scope = { datasetId: 'd', libraryId: 'l', albumId: 'a', captureId: 'c' }, library = { datasetId: 'd', libraryId: 'l', captureId: 'lc' }
  const c: LocalLyricsCapture = { scope, authorityRef: {}, epoch: 'e', fingerprint: 'f', online: true, tracks: ['false', 'unknown'].map((lrc, i) => ({ trackId: `t${i}`, title: '歌', artist: '人', album: '辑', language: '', version: 'original', durationMs: 1, wholeTrack: false, format: 'flac', rootRevision: 'r', fileRevision: 'f', locationRevision: 'l', metadataRevision: 'm', lrc: lrc as 'false' | 'unknown', embedded: 'false' })) }
  const facts: LocalLyricsInventoryObservation[] = c.tracks.map(t => ({ trackId: t.trackId, lrc: t.lrc, embedded: t.embedded, fileRevision: t.fileRevision }))
  const control = { deleted: false, persisted: 0, changeOnRead: false, wrongWatermark: false }
  const ports: LocalLyricsPorts = {
    capture: { async capture() { return c }, async assertCurrent() { if (control.deleted) throw new Error('deleted') }, async captureLibrary() { return { library, authorityRef: {}, watermark: 'w', deadlineAtMs: Date.now() + 60000 } }, async assertLibraryCurrent() { if (control.deleted) throw new Error('deleted') }, async libraryPage() { throw new Error('unused') } },
    providers: { async request() { throw new Error('unused') }, async join() {} },
    journal: { async pendingSaves() { return [] }, async readSave() { return null }, async save() { throw new Error('unused') }, async readJob() { return null }, async checkpoint() { throw new Error('unused') } },
    writer: { async write() { throw new Error('unused') }, async retryFailed() { throw new Error('unused') }, async readOriginal() { return null }, async join() {} },
    cover: { async save() { throw new Error('unused') }, async readOriginal() { return null }, async hasPending() { return false } },
    inventory: { async inspect() { if (control.changeOnRead) control.deleted = true; return structuredClone(facts) }, async persist() { assert.equal(control.deleted, false); control.persisted++ }, async snapshot() { throw new Error('unused') }, async page(_l, filter, offset, limit) { const all = [{ albumId: 'missing', presence: 'false' as const }, { albumId: 'unknown', presence: 'unknown' as const }, { albumId: 'present', presence: 'true' as const }].filter(x => filter === 'all' || x.presence === 'false'); return { total: all.length, watermark: control.wrongWatermark ? 'foreign' : 'w', rows: all.slice(offset, offset + limit) } } },
    lifecycle: { assertAccepting() {}, now: Date.now, async join() {} },
  }
  return { inventory: new LocalLyricsInventory(ports), scope, library, facts, control, ports }
}
test('歌词库存持久真实unknown false true而不是候选命中事实', async () => {
  const f = fixture()
  assert.equal(await f.inventory.observe(f.scope), 'unknown'); assert.equal(f.control.persisted, 1)
  f.facts[1]!.lrc = 'false'; assert.equal(await f.inventory.observe(f.scope), 'false')
  f.facts.forEach(r => { r.embedded = 'true' }); assert.equal(await f.inventory.observe(f.scope), 'true')
})
test('歌词缺词筛选只含false并保全计数尾页和空页', async () => {
  const f = fixture()
  const missing = await f.inventory.page({ library: f.library, filter: 'missingLyrics', offset: 0, limit: 200 })
  assert.equal(missing.total, 1); assert.deepEqual(missing.rows.map(r => r.albumId), ['missing'])
  assert.equal((await f.inventory.page({ library: f.library, filter: 'all', offset: 2, limit: 200 })).rows[0]?.albumId, 'present')
  assert.deepEqual((await f.inventory.page({ library: f.library, filter: 'all', offset: 100, limit: 200 })).rows, [])
})
test('歌词库存旧修订与遗漏完整成员不能持久化', async () => {
  const f = fixture(); f.facts[0]!.fileRevision = 'changed'
  await assert.rejects(f.inventory.observe(f.scope)); assert.equal(f.control.persisted, 0)
  f.facts[0]!.fileRevision = 'f'; f.facts.pop()
  await assert.rejects(f.inventory.observe(f.scope)); assert.equal(f.control.persisted, 0)
})
test('歌词库删除时迟到inspect不能创建或复活原库', async () => {
  const f = fixture(); f.control.changeOnRead = true
  await assert.rejects(f.inventory.observe(f.scope)); assert.equal(f.control.persisted, 0)
})
test('歌词库存page必须连续绑定本库watermark且查询不调用writer', async () => {
  const f = fixture(); f.control.wrongWatermark = true
  await assert.rejects(f.inventory.page({ library: f.library, filter: 'all', offset: 0, limit: 2 }))
  const signal = AbortSignal.abort(); await assert.rejects(f.inventory.observe(f.scope, signal)); assert.equal(f.control.persisted, 0)
})
