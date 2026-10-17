import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalLyricsService } from '../src/collection/local-library-lyrics/service.js'
import type { LocalLyricsPorts, LocalLyricsCapture, LocalLyricsSaveRecord, LocalLyricsJobRecord } from '../src/collection/local-library-lyrics/types.js'
const raw = (v: unknown): Uint8Array => Buffer.from(JSON.stringify(v))
function fixture() {
  const scope = { datasetId: 'dataset', libraryId: 'library', albumId: 'album', captureId: 'capture' }
  const capture: LocalLyricsCapture = { scope, authorityRef: {}, epoch: 'epoch', fingerprint: 'original-fingerprint', online: true, tracks: [{ trackId: 'track', title: '歌曲', artist: '艺人', album: '专辑', language: '', version: 'original', durationMs: 120000, wholeTrack: false, format: 'flac', rootRevision: 'root', fileRevision: 'file', locationRevision: 'location', metadataRevision: 'metadata', lrc: 'false', embedded: 'false' }] }
  const saves = new Map<string, LocalLyricsSaveRecord>(), jobs = new Map<string, LocalLyricsJobRecord>()
  const calls = { provider: 0, writer: 0, journal: 0, snapshot: 0, joined: 0 }
  const control = { current: true, accepting: true, failQq: false, delayed: false }
  const library = { datasetId: 'dataset', libraryId: 'library', captureId: 'library-capture' }
  const lc = { library, authorityRef: {}, watermark: 'watermark', deadlineAtMs: Date.now() + 60000 }
  const ports: LocalLyricsPorts = {
    capture: { async capture() { return capture }, async assertCurrent(c) { assert.equal(c, capture); if (!control.current) throw new Error('stale private path') }, async captureLibrary() { return lc }, async assertLibraryCurrent() {}, async libraryPage() { return { scopes: [scope], next: null, total: 1, watermark: lc.watermark } } },
    journal: { async pendingSaves(scope) { return structuredClone([...saves.values()].filter(r => r.intent.scope.datasetId === scope.datasetId && r.intent.scope.libraryId === scope.libraryId && r.intent.scope.albumId === scope.albumId && (r.receipt.state !== 'complete' || r.receipt.snapshot === 'failed' || r.receipt.snapshot === 'pending' || !r.physicalClosed))) }, async readSave(id) { return structuredClone(saves.get(id) ?? null) }, async save(r, expected) { assert.equal(saves.get(r.intent.request.commandId)?.revision ?? null, expected); calls.journal++; saves.set(r.intent.request.commandId, structuredClone(r)) }, async readJob(id) { return structuredClone(jobs.get(id) ?? null) }, async checkpoint(r, expected) { assert.equal(jobs.get(r.snapshot.jobId)?.snapshot.revision ?? null, expected); jobs.set(r.snapshot.jobId, structuredClone(r)) } },
    providers: { async request(source, _op, input, signal) { calls.provider++; if (control.delayed) return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }) }); if (source === 'qq' && control.failQq) throw new Error('https://private.invalid Cookie=secret'); const q = 'title' in input ? input : { title: '歌曲', artist: '艺人', album: '专辑' }; return raw(source === 'lrclib' ? [{ id: 1, trackName: q.title, artistName: q.artist, albumName: q.album, duration: 120, syncedLyrics: '[00:01.00]歌词' }] : source === 'netease' ? { result: { songs: [] } } : source === 'qq' ? { data: { song: { list: [] } } } : source === 'kugou' ? { data: { info: [] } } : { data: { list: [] } }) }, async join() { calls.joined++ } },
    writer: { async write(_kind, intent, selected) { assert.ok(saves.has(intent.request.commandId)); calls.writer++; return { state: 'saved', bodySha256: selected.sha256 } }, async retryFailed() { throw new Error('unexpected retry') }, async readOriginal() { return null }, async join() {} },
    cover: { async save() { return 'not-requested' }, async readOriginal() { return 'not-requested' }, async hasPending() { return false } },
    inventory: { async inspect(c) { return c.tracks.map(t => ({ trackId: t.trackId, fileRevision: t.fileRevision, lrc: t.lrc, embedded: t.embedded })) }, async persist() {}, async snapshot() { calls.snapshot++; return 'saved' }, async page() { return { total: 1, watermark: 'watermark', rows: [{ albumId: 'album', presence: 'false' }] } } },
    lifecycle: { assertAccepting() { if (!control.accepting) throw new Error('closed') }, now: () => Date.now(), async join() {} },
  }
  return { ports, scope, capture, saves, calls, control, service: new LocalLyricsService(ports) }
}

const original = (r: { sessionId: string; commandId: string }): { sessionId: string; commandId: string } => ({ sessionId: r.sessionId, commandId: r.commandId })
async function prepare(f: ReturnType<typeof fixture>) {
  const accepted = await f.service.query({ scope: f.scope }); await f.service.wait(accepted.sessionId)
  const s = await f.service.readSession({ sessionId: accepted.sessionId })
  await f.service.select({ sessionId: s.sessionId, trackId: 'track', candidateId: s.candidates[0]!.candidateId })
  return { sessionId: s.sessionId, commandId: 'original-save', embed: true }
}
test('歌词共同Save先落原intent再cover LRC embed，物理join前不能离开', async t => {
  const f = fixture(); const order: string[] = []
  f.ports.cover.save = async () => { assert.ok(f.saves.has('original-save')); order.push('cover'); return 'saved' }
  f.ports.writer.write = async (kind, intent, selected) => { assert.equal(f.saves.get(intent.request.commandId)?.receipt.tracks[0]?.[kind], 'unknown'); order.push(kind); return { state: 'saved', bodySha256: selected.sha256 } }
  let release!: () => void, reached!: () => void
  const entered = new Promise<void>(r => { reached = r })
  const joined = new Promise<void>(r => { release = r }); t.after(async () => { release(); await f.service.close() })
  f.ports.writer.join = async () => { reached(); await joined; order.push('join') }
  const request = await prepare(f)
  await f.service.save(request); await entered
  assert.equal((await f.service.receipt(original(request)))?.state, 'running')
  assert.equal(await f.service.canLeave(request.sessionId), false)
  release(); await f.service.saves.wait(request.commandId)
  assert.deepEqual(order, ['cover', 'lrc', 'embed', 'join'])
  assert.equal((await f.service.receipt(original(request)))?.state, 'complete')
  assert.equal(await f.service.canLeave(request.sessionId), true)
})
test('歌词LRC成功embed明确失败仅原body受保护重试embed', async t => {
  const f = fixture(); t.after(() => f.service.close()); const writes: string[] = []
  f.ports.writer.write = async (kind, _intent, selected) => { writes.push(kind); return { state: kind === 'embed' ? 'failed' : 'saved', bodySha256: selected.sha256 } }
  f.ports.writer.readOriginal = async (kind, _intent, selected) => ({ state: kind === 'embed' ? 'failed' : 'saved', bodySha256: selected.sha256 })
  f.ports.writer.retryFailed = async (kind, intent, selected) => { assert.equal(kind, 'embed'); assert.equal(intent.selected[0]?.body, '[00:01.00]歌词'); writes.push('retry-embed'); return { state: 'saved', bodySha256: selected.sha256 } }
  const request = await prepare(f); await f.service.save(request); await f.service.saves.wait(request.commandId)
  assert.equal((await f.service.receipt(original(request)))?.state, 'partial'); assert.equal(await f.service.canLeave(request.sessionId), false)
  const providerCount = f.calls.provider
  await f.service.retrySave(original(request)); await f.service.saves.wait(request.commandId)
  assert.deepEqual(writes, ['lrc', 'embed', 'retry-embed']); assert.equal(f.calls.provider, providerCount)
  assert.equal((await f.service.receipt(original(request)))?.state, 'complete')
})
test('歌词UNKNOWN冷恢复仅查原id，late原回执不触发写源重发', async t => {
  const f = fixture(); t.after(() => f.service.close())
  let outcome: 'unknown' | 'saved' = 'unknown'
  f.ports.writer.write = async (_kind, _i, s) => { f.calls.writer++; return { state: outcome, bodySha256: s.sha256 } }
  f.ports.writer.readOriginal = async (_kind, _i, s) => outcome === 'unknown' ? null : { state: 'saved', bodySha256: s.sha256 }
  const request = { ...await prepare(f), embed: false }; await f.service.save(request); await f.service.saves.wait(request.commandId)
  const cold = new LocalLyricsService(f.ports); t.after(() => cold.close())
  assert.equal((await cold.receipt(original(request)))?.state, 'unknown'); await cold.retrySave(original(request)); await cold.receipt(original(request))
  assert.equal(f.calls.writer, 1)
  outcome = 'saved'; assert.equal((await cold.receipt(original(request)))?.state, 'complete'); assert.equal(f.calls.writer, 1)
})
test('歌词快照失败可独立retry且Provider LRC embed均零重执行', async t => {
  const f = fixture(); t.after(() => f.service.close()); let fail = true
  f.ports.inventory.snapshot = async () => { f.calls.snapshot++; return fail ? 'failed' : 'saved' }
  const request = await prepare(f); await f.service.save(request); await f.service.saves.wait(request.commandId)
  assert.equal((await f.service.receipt(original(request)))?.snapshot, 'failed'); assert.equal(await f.service.canLeave(request.sessionId), false)
  const before = [f.calls.provider, f.calls.writer]; fail = false
  await f.service.retrySnapshot(original(request))
  assert.deepEqual([f.calls.provider, f.calls.writer], before); assert.equal(f.calls.snapshot, 2)
  assert.equal(await f.service.canLeave(request.sessionId), true)
})
test('歌词cover未知或失败阻断全部歌词写入且保原pending', async t => {
  const f = fixture(); t.after(() => f.service.close())
  f.ports.cover.save = async () => 'unknown'; f.ports.cover.readOriginal = async () => null
  const request = await prepare(f); await f.service.save(request); await f.service.saves.wait(request.commandId)
  assert.equal((await f.service.receipt(original(request)))?.state, 'unknown'); assert.equal(f.calls.writer, 0)
  await f.service.retrySave(original(request)); assert.equal(f.calls.writer, 0); assert.equal(await f.service.canLeave(request.sessionId), false)
})
test('歌词同名外来LRC正文不同不得覆盖或继续embed', async t => {
  const f = fixture(); t.after(() => f.service.close()); const kinds: string[] = []
  f.ports.writer.write = async kind => { kinds.push(kind); return { state: 'existing', bodySha256: 'foreign-body' } }
  const request = await prepare(f); await f.service.save(request); await f.service.saves.wait(request.commandId)
  assert.deepEqual(kinds, ['lrc']); assert.equal((await f.service.receipt(original(request)))?.tracks[0]?.lrc, 'failed')
  assert.equal(await f.service.canLeave(request.sessionId), false)
})
test('歌词重复原请求及错误body不产生第二次write', async t => {
  const f = fixture(); t.after(() => f.service.close()); const request = await prepare(f)
  await Promise.all([f.service.save(request), f.service.save(request)]); await f.service.saves.wait(request.commandId)
  await f.service.save(request); assert.equal(f.calls.writer, 2)
  await assert.rejects(f.service.save({ ...request, embed: false }), /CONFLICT/u)
  await assert.rejects(f.service.receipt({ ...original(request), sessionId: 'foreign' }), /CONFLICT/u)
  assert.equal(f.calls.writer, 2)
})
test('歌词物理join失败保UNKNOWN，不能把文件saved冒充完整关闭', async t => {
  const f = fixture(); t.after(() => f.service.close())
  f.ports.writer.join = async () => { throw new Error('physical close failed') }
  const request = await prepare(f); await f.service.save(request); await f.service.saves.wait(request.commandId)
  assert.equal((await f.service.receipt(original(request)))?.state, 'unknown'); assert.equal(await f.service.canLeave(request.sessionId), false)
})
test('歌词持久UNKNOWN阻止新session新commandId绕过原pending', async t => {
  const f = fixture(); t.after(() => f.service.close())
  f.ports.writer.write = async (_k, _i, s) => { f.calls.writer++; return { state: 'unknown', bodySha256: s.sha256 } }
  const first = { ...await prepare(f), embed: false }; await f.service.save(first); await f.service.saves.wait(first.commandId)
  const second = { ...await prepare(f), commandId: 'new-save', embed: false }
  assert.equal((await f.service.readSession({ sessionId: second.sessionId })).pendingOperations?.[0]?.request.commandId, first.commandId)
  await assert.rejects(f.service.save(second), /IN_FLIGHT/u)
  await assert.rejects(f.service.discard({ sessionId: first.sessionId }), /IN_FLIGHT/u)
  assert.equal(f.calls.writer, 1); assert.equal(f.saves.has('new-save'), false)
})
test('歌词明确partial可在join后discard draft，保原回执与已存LRC', async t => {
  const f = fixture(); t.after(() => f.service.close())
  f.ports.writer.write = async (kind, _i, selected) => ({ state: kind === 'embed' ? 'failed' : 'saved', bodySha256: selected.sha256 })
  const request = await prepare(f); await f.service.save(request); await f.service.saves.wait(request.commandId)
  assert.equal((await f.service.receipt(original(request)))?.state, 'partial')
  await f.service.discard({ sessionId: request.sessionId })
  assert.equal(await f.service.canLeave(request.sessionId), true)
  assert.equal(f.saves.get(request.commandId)?.receipt.tracks[0]?.lrc, 'saved')
  assert.equal(f.saves.get(request.commandId)?.discarded, true)
  assert.equal(f.saves.get(request.commandId)?.intent.selected[0]?.body, '[00:01.00]歌词')
  await assert.rejects(f.service.retrySave(original(request)), /STALE/u)
})
test('歌词冷codec键排序保持原fingerprint，额外公开字段拒绝泄漏', async t => {
  const f = fixture(); t.after(() => f.service.close())
  const req = await prepare(f); await f.service.save(req); await f.service.saves.wait(req.commandId)
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, sort(val)])) : v
  const saved = f.saves.get(req.commandId)!
  f.saves.set(req.commandId, sort(saved) as LocalLyricsSaveRecord)
  const cold = new LocalLyricsService(f.ports); t.after(() => cold.close())
  assert.equal((await cold.receipt(original(req)))?.state, 'complete')
  const corrupt = f.saves.get(req.commandId)!.receipt as unknown as Record<string, unknown>; corrupt.url = 'https://private.invalid'
  await assert.rejects(cold.receipt(original(req)), /CONFLICT/u)
})
