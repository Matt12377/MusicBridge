import assert from 'node:assert/strict'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { open } from 'node:fs/promises'
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import * as dto from '@music-bridge/contracts'
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js'
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js'
import { createLocalAlbumSqlReader, isCurrentLocalAlbumSqlReader } from '../../src/collection/local-album-browser/sql-read.js'
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js'
import { extractVersionTokens } from '../../src/library/local-name-rules.js'
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js'
import { responseFailure } from '../../src/shared/ipc-failure.js'
import type { LocalAlbumSqlCodec } from '../../src/collection/local-album-browser/sql-types.js'
import type { OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js'

if (!parentPort) throw new Error('撤销Gate必须运行在真实Worker中。')
const control = workerData.controlPort as MessagePort
const phase = String(workerData.phase)
const gate = new Int32Array(workerData.gate as SharedArrayBuffer)
const revoked = createDatasetOwnerReadRevocation(workerData.albumReadRevocationBuffer as SharedArrayBuffer)
const id = (n: number) => '33333333-3333-4333-8333-' + String(n).padStart(12, '0')
const rootId = id(1), sourceId = id(2), total = 96
const root: dto.LocalRootView = { root: { id: rootId, sourceRootId: sourceId, role: 'library', revision: '1' }, label: '合成撤销库', availability: 'ONLINE' }
const send = (type: string, value: Record<string, unknown> = {}) => control.postMessage({ type, ...value })
let releaseFd!: () => void
const fdRelease = new Promise<void>(resolve => { releaseFd = resolve })
control.on('message', value => { if (value?.type === 'release-fd') releaseFd() })

// 只有这份测试自有Worker可阻塞在确定性检查点；不需要真实库、NAS或CPU速度假设。
let held = false
function checkpoint(point: string): void {
  if (held) return
  held = true
  send('query.entered', { point })
  if (Atomics.wait(gate, 0, 0, 5000) === 'timed-out') throw new Error('合成SQL检查点未收到测试释放。')
}

const events: { action: string; code?: string }[] = []
const originalLog = console.info.bind(console)
console.info = (...args: unknown[]) => {
  const event = readLibraryOperationLine(args.map(String).join(' '))
  if (event) events.push(event)
  originalLog(...args)
}

// 在真实SQLite已产生若干compact行、JS尚未完成组装时置闩，覆盖缓存发布前的检查。
if (phase === 'publish') {
  const original = StatementSync.prototype.iterate
  const descriptor = Object.getOwnPropertyDescriptor(StatementSync.prototype, 'iterate')!
  Object.defineProperty(StatementSync.prototype, 'iterate', { ...descriptor, value: function (this: StatementSync, ...bindings: unknown[]) {
    const iterator = Reflect.apply(original, this, bindings) as IterableIterator<Record<string, unknown>>
    if (!this.sourceSQL.includes('mb_album_compact_groups')) return iterator
    const next = iterator.next.bind(iterator)
    let rows = 0
    Object.defineProperty(iterator, 'next', { configurable: true, value: (...args: [] | [unknown]) => {
      const result = Reflect.apply(next, iterator, args) as IteratorResult<Record<string, unknown>>
      if (!result.done && ++rows === 8) checkpoint('compact-row')
      return result
    } })
    return iterator
  } })
}

attachDatasetOwnerWorkerPort(parentPort, {
  async prepare(epoch) {
    const db = new DatabaseSync(String(workerData.databasePath))
    db.exec('CREATE TABLE local_catalog_tracks(id TEXT PRIMARY KEY,asset_id TEXT,data TEXT);' +
      'CREATE TABLE local_catalog_assets(id TEXT PRIMARY KEY,root_id TEXT,source_root_id TEXT,relative TEXT,sha256 TEXT,data TEXT);' +
      'CREATE TABLE local_catalog_editions(id TEXT PRIMARY KEY,data TEXT);' +
      'CREATE TABLE local_catalog_edition_tracks(id TEXT PRIMARY KEY,track_id TEXT,edition_id TEXT,data TEXT);' +
      'CREATE TABLE local_catalog_overrides(track_id TEXT PRIMARY KEY,data TEXT);' +
      'CREATE TABLE local_artwork_selections(edition_id TEXT PRIMARY KEY,data TEXT);' +
      'CREATE TABLE mutation_log(value TEXT);')
    const raw = new Map<string, { ordinal: number; fields: dto.LocalMetadata }>()
    for (let n = 0; n < total; n++) {
      const track: dto.LocalTrack = { id: id(1000 + n), assetId: id(2000 + n), selectionRevision: '1', segment: null }
      const asset: dto.AudioAsset = { id: track.assetId, libraryRootId: rootId, sourceRootId: sourceId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }
      assert.ok(dto.isLocalTrack(track)); assert.ok(dto.isAudioAsset(asset))
      db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(track.id, track.assetId, JSON.stringify(track))
      db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(asset.id, rootId, sourceId, 'album-' + n + '/song.flac', null, JSON.stringify(asset))
      raw.set(track.id, { ordinal: n + 1, fields: { title: '合成歌曲' + n, artist: '合成艺人', album: '合成专辑' + n } })
    }
    const fields = ['title', 'artist', 'album', 'year', 'disc', 'track'] as const
    const projectionSql = 'WITH source_full AS(SELECT json_extract(value,\'$.trackId\') track_id,json_extract(value,\'$.ordinal\') ordinal,json_extract(value,\'$.fields\') fields FROM json_each(@sourceRaw)),candidates AS (' +
      'SELECT t.rowid ordinal,t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,' +
      fields.flatMap(field => ['json_extract(sf.fields,\'$.' + field + '\') raw_' + field, 'coalesce(json_extract(v.data,\'$.fields.' + field + '\'),json_extract(sf.fields,\'$.' + field + '\')) effective_' + field]).join(',') +
      ' FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE @root IS NULL OR a.root_id=@root)'
    const seen = new Set<string>()
    const codec: LocalAlbumSqlCodec = {
      track(row) { const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isLocalTrack(value)); assert.equal(value.id, row.id); return value },
      asset(row) { const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isAudioAsset(value)); assert.equal(value.id, row.id); return value },
      boundedRow(row) { for (const value of Object.values(row)) if (typeof value === 'string') assert.ok(Buffer.byteLength(value) <= 65536) },
      versionTokens(value) { return (['title', 'artist', 'album'] as const).flatMap(field => value[field] ? extractVersionTokens(value[field]!, field) : []).slice(0, 64) },
      scanState() { return null }, cue() { throw new Error('合成撤销库没有CUE。') },
    }
    const inventory = {
      revision() {
        if (phase === 'barrier' && events.some(event => event.action === 'albums.compact-groups' && event.code === 'COMPACT_BUILT')) checkpoint('final-barrier')
        return 'resource-1'
      },
      read() { return 'unknown' as const },
    }
    const reader = createLocalAlbumSqlReader(db, { projectionSql, sourceLookup(trackId) {
      seen.add(trackId)
      if ((phase === 'codec' || phase === 'transaction' || phase === 'abort') && seen.size === 8) checkpoint('source-codec')
      // 只放大纯codec，不在正式SQL、Source或事务边界加入任何测试开关。
      const end = performance.now() + 1
      while (performance.now() < end) { /* 有界的合成解码耗时 */ }
      return raw.get(trackId)
    } }, codec, { revision: 'source-1', roots: [root], artworkInventory: inventory, assertReadActive: revoked.assertActive })
    const source = await open(String(workerData.sourcePath), 'r')
    let workbenchClose: Promise<void> | undefined, calls = 0, fdClosed = false
    const query = () => reader.queryAlbums({ query: '', filter: 'all', rootId, offset: 0, limit: 10 })
    const stats = () => ({ sourceRows: seen.size, readerCurrent: isCurrentLocalAlbumSqlReader(db, reader), inTransaction: db.isTransaction,
      committedMarkers: Number(db.prepare('SELECT count(*) n FROM mutation_log').get()!.n),
      compactPublished: events.filter(event => event.action === 'albums.compact-groups' && event.code === 'COMPACT_BUILT').length,
      fdClosed })
    const domain: OwnedDatasetDomain = {
      datasetId: String(workerData.datasetId), commitBoot() {}, async dispatch() { throw new Error('合成Gate不得派发公开写入。') },
      async workbenchContext() { return { epoch, datasetId: String(workerData.datasetId), ready: true } },
      async dispatchWorkbench() { throw new Error('合成Gate不得派发公开工作台命令。') },
      async dispatchWorkbenchOwner(request) {
        assert.equal(request.command, 'registry.operations'); calls++
        try {
          if (phase === 'transaction' && calls === 1) { db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO mutation_log VALUES(?)').run('before-read') }
          const page = query()
          if (db.isTransaction) { db.prepare('INSERT INTO mutation_log VALUES(?)').run('after-read'); db.exec('COMMIT') }
          send('query.outcome', { ok: true, total: page.total, ...stats() })
          return []
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK')
          send('query.outcome', { ok: false, code: error instanceof LocalAlbumReadError ? error.code : 'UNEXPECTED_ERROR', ...stats() })
          throw error
        }
      },
      closeWorkbench() {
        return workbenchClose ??= (async () => {
          assert.equal(fdClosed, false); assert.ok((await source.stat()).isFile())
          send('close.entered', { fdClosed })
          await fdRelease
          await source.close(); await assert.rejects(source.stat(), { code: 'EBADF' }); fdClosed = true
          send('fd.closed', { fdClosed })
        })()
      },
      async close(before) {
        await domain.closeWorkbench!(); await before?.(); assert.equal(fdClosed, true)
        assert.equal(db.isTransaction, false); db.close(); send('domain.closed', { fdClosed, databaseClosed: !db.isOpen }); control.close()
      },
      failureForError(id) { return responseFailure(id, 'INTERNAL_ERROR', '合成原Owner读取失败。') },
    }
    return domain
  },
})
