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

import { LocalLyricsJob } from '../src/collection/local-library-lyrics/job.js'
function jobFixture() {
  const f = fixture(), library = { datasetId: 'dataset', libraryId: 'library', captureId: 'library-capture' }
  const c = { library, authorityRef: {}, watermark: 'watermark', deadlineAtMs: Date.now() + 60000 }
  const scopes = ['a', 'b', 'c'].map(albumId => ({ ...f.scope, albumId, captureId: 'capture-' + albumId }))
  const captured = new Map(scopes.map(s => [s.albumId, { ...f.capture, scope: s, tracks: f.capture.tracks.map(t => ({ ...t, trackId: 'track-' + s.albumId })) }]))
  let pages = 0
  const control = { omit: false, failB: false }
  f.ports.capture.capture = async s => { const cap = captured.get(s.albumId); if (!cap) throw new Error('foreign'); return cap }
  f.ports.capture.assertCurrent = async cap => { assert.equal(captured.get(cap.scope.albumId), cap); if (!f.control.current) throw new Error('stale') }
  f.ports.capture.captureLibrary = async () => c
  f.ports.capture.libraryPage = async (_cap, cursor) => { pages++; return cursor === null ? { scopes: [scopes[0]!], next: 'page-2', total: 3, watermark: c.watermark } : { scopes: control.omit ? [scopes[1]!] : scopes.slice(1), next: null, total: 3, watermark: c.watermark } }
  const original = f.ports.providers.request
  f.ports.providers.request = async (...args) => { if (control.failB && 'title' in args[2] && args[2].title === 'bad') throw new Error('provider failed'); return original(...args) }
  const jobs = new LocalLyricsJob(f.ports, f.service)
  return { ...f, jobs, library, c, scopes, captured, jobControl: control, pages: () => pages }
}
test('歌词全库批次遍历全部已扫描专辑而非当前filter或第一页', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() })
  const start = await f.jobs.start({ commandId: 'whole-job', library: f.library, embed: true })
  assert.equal(start.jobId, 'whole-job'); await f.jobs.wait(start.jobId)
  const result = await f.jobs.read(start.jobId)
  assert.equal(result?.totalAlbums, 3); assert.equal(result?.processedAlbums, 3); assert.equal(result?.savedAlbums, 3)
  assert.equal(result?.sidecars, 3); assert.equal(result?.embedded, 3); assert.equal(f.pages(), 2)
})
test('歌词job丢响应使用原commandId只读，错误原body拒绝', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() })
  const req = { commandId: 'original-job', library: f.library, embed: false }
  await f.jobs.start(req); await f.jobs.wait(req.commandId)
  const before = [f.calls.provider, f.calls.writer, f.pages()]
  await f.jobs.start(req); await f.jobs.read(req.commandId)
  assert.deepEqual([f.calls.provider, f.calls.writer, f.pages()], before)
  await assert.rejects(f.jobs.start({ ...req, embed: true }), /CONFLICT/u)
})
test('歌词job停止实际abort并join在途请求且保完整checkpoint', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() }); f.control.delayed = true
  const accepted = await f.jobs.start({ commandId: 'stop-job', library: f.library, embed: false })
  const waiting = new Promise<void>(resolve => { const prior = f.ports.providers.request; f.ports.providers.request = (...args) => { resolve(); return prior(...args) } })
  await waiting
  const result = await f.jobs.stop(accepted.jobId)
  assert.equal(result.state, 'stopped'); assert.equal(result.totalAlbums, 3); assert.equal(f.calls.writer, 0); assert.equal(f.calls.joined, 5)
})
test('歌词job原UNKNOWN跨cold resume只查原写入id不重新Provider或writer', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() })
  f.ports.writer.write = async (_k, _i, s) => { f.calls.writer++; return { state: 'unknown', bodySha256: s.sha256 } }
  await f.jobs.start({ commandId: 'unknown-job', library: f.library, embed: false }); await f.jobs.wait('unknown-job')
  const before = [f.calls.provider, f.calls.writer]
  const cold = new LocalLyricsJob(f.ports, f.service); t.after(() => cold.close())
  await cold.resume('unknown-job'); await cold.wait('unknown-job')
  assert.deepEqual([f.calls.provider, f.calls.writer], before); assert.equal((await cold.read('unknown-job'))?.unknownAlbumIds.length, 3)
  await assert.rejects(cold.retry({ jobId: 'unknown-job', albumIds: ['a'] }), /INVALID/u)
})
test('歌词job明确失败只重试指定原专辑而不重跑已保存专辑', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() })
  f.captured.get('b')!.tracks = f.captured.get('b')!.tracks.map(t => ({ ...t, title: 'bad' })); f.jobControl.failB = true
  await f.jobs.start({ commandId: 'retry-job', library: f.library, embed: false }); await f.jobs.wait('retry-job')
  assert.deepEqual((await f.jobs.read('retry-job'))?.failedAlbumIds, ['b'])
  const before = f.calls.writer; f.jobControl.failB = false
  await f.jobs.retry({ jobId: 'retry-job', albumIds: ['b'] }); await f.jobs.wait('retry-job')
  assert.equal(f.calls.writer, before + 1); assert.equal((await f.jobs.read('retry-job'))?.savedAlbums, 3)
})
test('歌词全库枚举遗漏尾页不得伪造完成或开始Provider', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() }); f.jobControl.omit = true
  await f.jobs.start({ commandId: 'omitted', library: f.library, embed: false }); await f.jobs.wait('omitted')
  assert.equal((await f.jobs.read('omitted'))?.state, 'failed'); assert.equal(f.calls.provider, 0)
  f.jobControl.omit = false
  await f.jobs.resume('omitted'); await f.jobs.wait('omitted')
  assert.equal((await f.jobs.read('omitted'))?.totalAlbums, 3); assert.equal((await f.jobs.read('omitted'))?.savedAlbums, 3)
})
test('歌词job迟到成功回执保未选曲review与每专辑计数不重复', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() })
  for (const c of f.captured.values()) c.tracks = [...c.tracks, { ...c.tracks[0]!, trackId: c.tracks[0]!.trackId + '-missing', title: 'missing' }]
  const previous = f.ports.providers.request
  f.ports.providers.request = async (...args) => args[0] === 'lrclib' && 'title' in args[2] && args[2].title === 'missing' ? raw([]) : previous(...args)
  f.ports.writer.write = async (_k, _i, s) => { f.calls.writer++; return { state: 'unknown', bodySha256: s.sha256 } }
  await f.jobs.start({ commandId: 'late-job', library: f.library, embed: false }); await f.jobs.wait('late-job')
  f.ports.writer.readOriginal = async (_k, _i, s) => ({ state: 'saved', bodySha256: s.sha256 })
  const before = [f.calls.provider, f.calls.writer]
  await f.jobs.resume('late-job'); await f.jobs.wait('late-job')
  const result = await f.jobs.read('late-job')
  assert.equal(result?.savedAlbums, 0); assert.equal(result?.sidecars, 3)
  assert.deepEqual([f.calls.provider, f.calls.writer], before)
  await f.jobs.resume('late-job'); await f.jobs.wait('late-job')
  assert.equal((await f.jobs.read('late-job'))?.sidecars, 3)
})
test('歌词job原整体期限与watermark不因resume重置', async t => {
  const f = jobFixture(); t.after(async () => { await f.jobs.close(); await f.service.close() })
  await f.jobs.start({ commandId: 'deadline', library: f.library, embed: false }); await f.jobs.wait('deadline')
  f.c.deadlineAtMs += 1000
  await assert.rejects(f.jobs.resume('deadline'), /STALE/u)
  f.c.deadlineAtMs -= 1000; f.c.watermark = 'foreign'
  await assert.rejects(f.jobs.resume('deadline'), /STALE/u)
})


test('UI04原entry：同实际DatasetIdentity与SQLite原job冷回读只投影指定专辑且UNKNOWN不启动工作', async () => {
  const [{ mkdtemp, realpath, writeFile, readFile }, path, { createCollectionRepository }, { createBackupWorkflowStore }] = await Promise.all([
    import('node:fs/promises'), import('node:path'), import('../src/collection/repository.js'), import('../src/recording/backup-workflow-store.js'),
  ])
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary) && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'))
  const directory = await mkdtemp(path.join(await realpath(temporary), 'ui04-lyrics-original-')), file = path.join(directory, 'catalog.sqlite'), stateFile = path.join(directory, 'identity.sqlite')
  let repository = createCollectionRepository({ filePath: file }), state = createBackupWorkflowStore({ filePath: stateFile })
  repository.localCatalog.roots(); let identity = state.datasetIdentities.bind('default', file, false); repository.localCatalog.privateBindWorkbenchDataset(identity)
  const f = fixture(), job = new LocalLyricsJob(f.ports, f.service), library = { datasetId: identity.datasetId, libraryId: 'library-not-source-root', captureId: 'original-library-capture' }
  const entries: LocalLyricsJobRecord['entries'] = [
    { scope: { ...library, albumId: 'review-album', captureId: 'original-review-capture' }, state: 'review', sessionId: 'original-review-session', saveRequest: null, unresolved: 'review', sidecars: 0, embedded: 0 },
    { scope: { ...library, albumId: 'failed-album', captureId: 'original-failed-capture' }, state: 'failed', sessionId: 'original-failed-session', saveRequest: { sessionId: 'original-failed-session', commandId: 'original-failed-save', embed: false }, unresolved: 'failed', sidecars: 0, embedded: 0 },
    { scope: { ...library, albumId: 'unknown-album', captureId: 'original-unknown-capture' }, state: 'unknown', sessionId: 'original-unknown-session', saveRequest: { sessionId: 'original-unknown-session', commandId: 'original-unknown-save', embed: true }, unresolved: 'unknown', sidecars: 0, embedded: 0 },
  ]
  const record: LocalLyricsJobRecord = { snapshot: { jobId: 'ui04-original-job', library, state: 'unknown', totalAlbums: 3, processedAlbums: 3, savedAlbums: 0, reviewAlbumIds: ['review-album'], failedAlbumIds: ['failed-album'], unknownAlbumIds: ['unknown-album'], sidecars: 0, embedded: 0, inspectionFailures: 1, revision: 0 }, embed: true, watermark: 'original-watermark', deadlineAtMs: Date.now() + 60000, enumerationComplete: true, entries }
  let nonReadCalls = 0
  const unexpected = async (): Promise<never> => { nonReadCalls++; throw new Error('只读定位不得开始新工作。') }
  f.ports.capture.capture = unexpected; f.ports.capture.captureLibrary = unexpected; f.ports.capture.libraryPage = unexpected; f.ports.journal.checkpoint = unexpected
  f.ports.journal.readJob = async id => { identity.assertCurrent(); const value = repository.localCatalog.privateLyricsRecord(identity.datasetId, 'job', id); identity.assertCurrent(); if (value !== null && !('entries' in value && 'snapshot' in value)) throw new Error('原job种类不符。'); return value }
  const changeCount = () => { assert.ok(repository.privateMobileCatalogAccess); return repository.privateMobileCatalogAccess(db => Number(db.prepare('SELECT total_changes() AS n').get()!.n)) }
  const readAll = async () => {
    const baseline = JSON.stringify(repository.localCatalog.privateLyricsRecord(identity.datasetId, 'job', record.snapshot.jobId)), changes = changeCount()
    assert.deepEqual(await job.read(record.snapshot.jobId), record.snapshot)
    assert.equal(Object.hasOwn((await job.read(record.snapshot.jobId))!, 'originalEntry'), false)
    for (const entry of entries) {
      const projected = await job.read(record.snapshot.jobId, entry.scope.albumId)
      assert.deepEqual(projected, { ...record.snapshot, originalEntry: { scope: entry.scope, sessionId: entry.sessionId, saveRequest: entry.saveRequest } })
      assert.notEqual(projected!.originalEntry!.scope.captureId, projected!.library.captureId)
      assert.deepEqual(Object.keys(projected!.originalEntry!).sort(), ['saveRequest', 'scope', 'sessionId'])
      assert.ok(Buffer.byteLength(JSON.stringify(projected!.originalEntry)) < 2048)
    }
    assert.deepEqual(await job.read(record.snapshot.jobId, 'missing-album'), { ...record.snapshot, originalEntry: null })
    assert.equal(await job.read('missing-job', 'review-album'), null)
    assert.equal(JSON.stringify(repository.localCatalog.privateLyricsRecord(identity.datasetId, 'job', record.snapshot.jobId)), baseline)
    assert.equal(changeCount(), changes); assert.equal(nonReadCalls, 0); assert.deepEqual([f.calls.provider, f.calls.writer, f.calls.journal, f.calls.snapshot], [0, 0, 0, 0])
  }
  try {
    repository.localCatalog.privateLyricsCompareAndSwap(identity.datasetId, 'job', record, null)
    await readAll(); const originalId = identity.datasetId
    repository.close(); state.close()
    repository = createCollectionRepository({ filePath: file }); state = createBackupWorkflowStore({ filePath: stateFile }); repository.localCatalog.roots(); identity = state.datasetIdentities.bind('default', file, false); repository.localCatalog.privateBindWorkbenchDataset(identity)
    assert.equal(identity.datasetId, originalId); await readAll()
    // 冷会话不存在时只报告原引用，不能借定位创建新的query/session。
    await assert.rejects(f.service.readSession({ sessionId: 'original-review-session' }), /NOT_FOUND/u)
    const receipt = { schema: 'musicbridge.ui04.original-entry.isolated-sql-readback.v1', qualifiedSource: false, datasetId: identity.datasetId, originalRecord: record, afterReadRecord: repository.localCatalog.privateLyricsRecord(identity.datasetId, 'job', record.snapshot.jobId), nonReadCalls, providerCalls: f.calls.provider, writerCalls: f.calls.writer, sameColdDatasetId: true }
    await writeFile(path.join(directory, 'readback.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'readback.json'), 'utf8')), receipt)
  } finally { await job.close(); await f.service.close(); repository.close(); state.close() }
})
