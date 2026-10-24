import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { setImmediate as yieldOwner } from 'node:timers/promises';
import { pinyin } from 'pinyin-pro';
import {
  isArtistQuery, isLocalArtistAlbumsQuery, isLocalArtistTracksQuery, isLocalArtistId,
  isLocalArtistSummary, isLocalArtistPage, isLocalArtistAlbumsPage, isLocalArtistTracksPage,
  isLocalArtistSearchResult, isLocalArtistTrackItem, isLocalLibraryTrackSummary, isLocalAlbumSummary,
  type ArtistQuery, type LocalArtistSummary, type LocalArtistPage, type LocalArtistAlbumsQuery, type LocalArtistAlbumsPage,
  type LocalArtistTracksQuery, type LocalArtistTracksPage, type LocalArtistTrackItem, type LocalArtistTrackMembership,
  type LocalArtistSearchResult, type LocalLibraryTrackSummary, type LocalAlbumSummary,
} from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import type { LocalAlbumOwnerService } from './local-album-browser/owner-port.js';
import type { LocalAlbumSqlMobilePage, LocalAlbumSqlMobileQuery, LocalAlbumSqlMobileRow } from './local-album-browser/sql-types.js';
import { LocalAlbumReadError } from './local-album-browser/grouping.js';
import { localMetadataArtists } from '../library/local-artist-fields.js';

export class LocalArtistSearchError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'SNAPSHOT_CHANGED' | 'UNAVAILABLE' | 'CLOSED' | 'PREPARING') {
    super(code === 'NOT_FOUND' ? '本地艺人或曲目已不存在。' : code === 'SNAPSHOT_CHANGED' ? '音乐库已变化，请重新读取。' : '本地艺人索引暂时无法读取。');
    this.name = 'LocalArtistSearchError';
  }
}
const fail = (code: LocalArtistSearchError['code']): never => { throw new LocalArtistSearchError(code); };
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const normalizeLocalArtistName = (name: string): string => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
export const localArtistId = (name: string): string => `local-artist:${digest(normalizeLocalArtistName(name))}`;
const fold = (value: string): string => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
const albumIdentity = (rootId: string, albumKey: string) => JSON.stringify([rootId, albumKey]);
type Row = Record<string, unknown>;
interface SourceMark { revision: string; highWater: number }
interface SearchForms { original: string; full: string; initials: string }
/** 转写只发生于文档变更；查询仅访问已持久化的原文、全拼和首字母。 */
export function localArtistSearchForms(values: readonly string[]): SearchForms {
  const originals: string[] = [], full: string[] = [], initials: string[] = [];
  for (const value of values) {
    if (!value.trim()) continue;
    originals.push(fold(value));
    const syllables = pinyin(value, { toneType: 'none', type: 'array' });
    const normalized = syllables.map(fold).filter(Boolean);
    full.push(normalized.join(' '), normalized.join(''));
    initials.push(normalized.map(part => [...part][0] ?? '').join(''));
  }
  return { original: originals.join(' '), full: full.join(' '), initials: initials.join(' ') };
}
const mobileQuery = (patch: Partial<LocalAlbumSqlMobileQuery> = {}): LocalAlbumSqlMobileQuery => ({
  kind: 'members', offset: 0, limit: 100, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null, ...patch,
});
const APP_ID = 0x4d424153;
const INDEX_WORK_SLICE_MS = 10;
const schema = `
CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE tracks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,performers TEXT NOT NULL,album_artists TEXT NOT NULL) STRICT;
CREATE TABLE albums(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,album_key TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
CREATE TABLE members(album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,PRIMARY KEY(album_id,track_id)) STRICT;
CREATE INDEX members_track ON members(track_id,album_id);
CREATE TABLE track_artists(track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,artist_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(track_id,artist_id)) STRICT;
CREATE INDEX track_artists_artist ON track_artists(artist_id,track_id);
CREATE TABLE artist_albums(artist_id TEXT NOT NULL,album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,relation TEXT NOT NULL CHECK(relation IN('albums','appearsOn')),name TEXT NOT NULL,PRIMARY KEY(artist_id,album_id,relation)) STRICT;
CREATE INDEX artist_albums_album ON artist_albums(album_id,artist_id);
CREATE TABLE artists(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_key TEXT NOT NULL,album_count INTEGER NOT NULL,track_count INTEGER NOT NULL) STRICT;
CREATE TABLE documents(rowid INTEGER PRIMARY KEY,kind TEXT NOT NULL,id TEXT NOT NULL,original TEXT NOT NULL,full TEXT NOT NULL,initials TEXT NOT NULL,UNIQUE(kind,id)) STRICT;
CREATE VIRTUAL TABLE documents_fts USING fts5(original,full,initials,content='documents',content_rowid='rowid',tokenize='trigram');
PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`;

/** 独立派生库不改主库schema或账本；任何失败保留原库事实，下次可重新建立。 */
export function createLocalArtistSearchService(options: {
  collection: Pick<CollectionRepository, 'localCatalog'>;
  localAlbums: Pick<LocalAlbumOwnerService, 'privateMobile'>;
  directory: string | null;
  assertCurrent(): void;
  beforeRefresh?(): Promise<void>;
  afterRefresh?(): void;
}) {
  let database: DatabaseSync | undefined, closed = false, refreshTask: Promise<void> | null = null;
  const lifetime = new AbortController();
  let refreshReadiness: Promise<'ready' | 'preparing'> | null = null;
  let preparationFailure: { error: unknown; revision: string | null } | null = null;
  const assertCurrent = () => { if (closed) fail('CLOSED'); options.assertCurrent(); };
  function open(): DatabaseSync {
    assertCurrent(); if (database) return database;
    let file = ':memory:';
    if (options.directory !== null) {
      if (!path.isAbsolute(options.directory)) return fail('UNAVAILABLE');
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(options.directory).isDirectory() || lstatSync(options.directory).isSymbolicLink()) return fail('UNAVAILABLE');
      file = path.join(options.directory, 'catalog.sqlite');
      for (const suffix of ['', '-wal', '-shm']) {
        try { const stat = lstatSync(file + suffix); if (!stat.isFile() || stat.isSymbolicLink()) return fail('UNAVAILABLE'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    }
    let db: DatabaseSync;
    try { db = new DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false }); }
    catch { return fail('UNAVAILABLE'); }
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version === 0 && Number(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n) === 0) db.exec(schema);
      else if (version !== 1 || db.prepare('PRAGMA application_id').get()?.application_id !== APP_ID) return fail('UNAVAILABLE');
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) return fail('UNAVAILABLE');
      database = db; return db;
    } catch (error) { db.close(); throw error; }
  }
  function sourceMark(db: DatabaseSync): SourceMark | null {
    const row = db.prepare("SELECT value FROM state WHERE key='source'").get();
    if (!row) return null;
    try {
      const value = JSON.parse(String(row.value)) as SourceMark;
      return typeof value.revision === 'string' && Number.isSafeInteger(value.highWater) && value.highWater >= 0 ? value : null;
    } catch { return null; }
  }
  function document(db: DatabaseSync, kind: 'artist' | 'album' | 'track', id: string, values: string[]): void {
    const forms = localArtistSearchForms(values);
    const previous = db.prepare('SELECT rowid,original,full,initials FROM documents WHERE kind=? AND id=?').get(kind, id);
    if (previous && previous.original === forms.original && previous.full === forms.full && previous.initials === forms.initials) return;
    if (previous) db.prepare("INSERT INTO documents_fts(documents_fts,rowid,original,full,initials) VALUES('delete',?,?,?,?)")
      .run(previous.rowid!, previous.original!, previous.full!, previous.initials!);
    db.prepare(`INSERT INTO documents(kind,id,original,full,initials) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET
      original=excluded.original,full=excluded.full,initials=excluded.initials`)
      .run(kind, id, forms.original, forms.full, forms.initials);
    const ordinal = db.prepare('SELECT rowid FROM documents WHERE kind=? AND id=?').get(kind, id)!.rowid!;
    db.prepare('INSERT INTO documents_fts(rowid,original,full,initials) VALUES(?,?,?,?)').run(ordinal, forms.original, forms.full, forms.initials);
  }
  function forgetDocument(db: DatabaseSync, kind: string, id: string): void {
    const previous = db.prepare('SELECT rowid,original,full,initials FROM documents WHERE kind=? AND id=?').get(kind, id);
    if (!previous) return;
    db.prepare("INSERT INTO documents_fts(documents_fts,rowid,original,full,initials) VALUES('delete',?,?,?,?)")
      .run(previous.rowid!, previous.original!, previous.full!, previous.initials!);
    db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id);
  }
  function putTrack(db: DatabaseSync, row: LocalAlbumSqlMobileRow, touchedAlbums: Set<string>, touchedArtists: Set<string>): void {
    if (!row.member || !isLocalAlbumSummary(row.album) || !isLocalLibraryTrackSummary(row.member.fact.summary)) return fail('UNAVAILABLE');
    const facts = row.member.fact.summary, performers = localMetadataArtists(facts.metadata), albumArtists = localMetadataArtists(facts.metadata, 'album');
    const albumId = albumIdentity(row.album.rootId, row.album.id);
    if (facts.asset.libraryRootId !== row.album.rootId) return fail('SNAPSHOT_CHANGED');
    db.prepare('INSERT INTO tracks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,performers=excluded.performers,album_artists=excluded.album_artists')
      .run(facts.track.id, JSON.stringify(facts), JSON.stringify(performers), JSON.stringify(albumArtists));
    db.prepare('INSERT INTO albums VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(albumId, row.album.rootId, row.album.id, JSON.stringify(row.album));
    db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(albumId, facts.track.id);
    for (const name of performers) {
      const id = localArtistId(name); touchedArtists.add(id);
      db.prepare('INSERT OR REPLACE INTO track_artists VALUES(?,?,?)').run(facts.track.id, id, name);
    }
    for (const name of albumArtists) touchedArtists.add(localArtistId(name));
    touchedAlbums.add(albumId);
    document(db, 'track', facts.track.id, [facts.metadata.title ?? '', facts.metadata.album ?? '', facts.metadata.year ?? '', ...performers, ...albumArtists]);
  }
  function forgetTrack(db: DatabaseSync, id: string, touchedAlbums: Set<string>, touchedArtists: Set<string>): void {
    for (const row of db.prepare('SELECT album_id FROM members WHERE track_id=?').all(id)) touchedAlbums.add(String(row.album_id));
    for (const row of db.prepare('SELECT artist_id FROM track_artists WHERE track_id=?').all(id)) touchedArtists.add(String(row.artist_id));
    forgetDocument(db, 'track', id);
    db.prepare('DELETE FROM tracks WHERE id=?').run(id);
  }
  function rebuildAlbum(db: DatabaseSync, id: string, touchedArtists: Set<string>): void {
    for (const row of db.prepare('SELECT artist_id FROM artist_albums WHERE album_id=?').all(id)) touchedArtists.add(String(row.artist_id));
    db.prepare('DELETE FROM artist_albums WHERE album_id=?').run(id);
    const row = db.prepare('SELECT payload FROM albums WHERE id=?').get(id);
    if (!row) return;
    const album = JSON.parse(String(row.payload)) as LocalAlbumSummary;
    const members = db.prepare('SELECT t.performers,t.album_artists FROM members m JOIN tracks t ON t.id=m.track_id WHERE m.album_id=?').all(id);
    if (!members.length && album.trackCount !== 0) {
      forgetDocument(db, 'album', id);
      db.prepare('DELETE FROM albums WHERE id=?').run(id); return;
    }
    const performers = new Map<string, string>(), explicitOwners = new Map<string, string>();
    const sets = new Set<string>();
    for (const member of members) {
      const names = JSON.parse(String(member.performers)) as string[], owners = JSON.parse(String(member.album_artists)) as string[];
      sets.add(JSON.stringify(names.map(normalizeLocalArtistName).sort()));
      for (const name of names) performers.set(localArtistId(name), name);
      for (const name of owners) explicitOwners.set(localArtistId(name), name);
    }
    // 缺专辑艺人时，只对整组一致的歌曲艺人回退；合辑不被分配给每位参与者。
    const owners = explicitOwners.size ? explicitOwners : sets.size === 1 ? performers : new Map<string, string>();
    const relation = db.prepare('INSERT INTO artist_albums VALUES(?,?,?,?)');
    for (const [artistId, name] of owners) { relation.run(artistId, id, 'albums', name); touchedArtists.add(artistId); }
    for (const [artistId, name] of performers) if (!owners.has(artistId)) { relation.run(artistId, id, 'appearsOn', name); touchedArtists.add(artistId); }
    document(db, 'album', id, [album.title, ...owners.values(), ...performers.values(), album.versionLabel ?? '', album.year ?? '', album.sourceLabel ?? '']);
  }
  function rebuildArtist(db: DatabaseSync, id: string): void {
    const name = db.prepare(`SELECT name FROM (SELECT name FROM track_artists WHERE artist_id=? UNION ALL SELECT name FROM artist_albums WHERE artist_id=?) ORDER BY name LIMIT 1`).get(id, id)?.name;
    if (typeof name !== 'string') {
      db.prepare('DELETE FROM artists WHERE id=?').run(id); forgetDocument(db, 'artist', id); return;
    }
    const tracks = Number(db.prepare('SELECT count(*) n FROM track_artists WHERE artist_id=?').get(id)!.n);
    const albums = Number(db.prepare("SELECT count(*) n FROM artist_albums WHERE artist_id=? AND relation='albums'").get(id)!.n);
    const forms = localArtistSearchForms([name]);
    db.prepare('INSERT INTO artists VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_key=excluded.sort_key,album_count=excluded.album_count,track_count=excluded.track_count')
      .run(id, name, forms.full, albums, tracks);
    document(db, 'artist', id, [name]);
  }
  async function update(preparing: () => void): Promise<void> {
    assertCurrent(); await options.localAlbums.privateMobile.refresh(); assertCurrent();
    const revision = options.localAlbums.privateMobile.revision(), db = open(), previous = sourceMark(db);
    if (previous?.revision === revision) return;
    const changes = options.collection.localCatalog.privateArtistSearchChanges(previous?.highWater ?? 0);
    const rebuild = !previous || changes.rebuild || changes.highWater === previous.highWater;
    const touchedAlbums = new Set<string>(), touchedArtists = new Set<string>();
    const check = () => { assertCurrent(); if (options.localAlbums.privateMobile.revision() !== revision) fail('SNAPSHOT_CHANGED'); };
    const readPage = async (query: LocalAlbumSqlMobileQuery): Promise<LocalAlbumSqlMobilePage> => {
      check();
      try {
        const port = options.localAlbums.privateMobile;
        const page = port.indexRead ? await port.indexRead(query, lifetime.signal) : port.current(query);
        check(); return page;
      } catch (error) { check(); throw error; }
    };
    let sliceDeadline = performance.now() + INDEX_WORK_SLICE_MS;
    const yieldSlice = (force = false): Promise<void> | undefined => {
      if (!force && performance.now() < sliceDeadline) return;
      // 只让出本 Owner 的执行时间，不提交派生事务或发布部分水位；恢复后仍核原作用域。
      return yieldOwner().then(() => { check(); sliceDeadline = performance.now() + INDEX_WORK_SLICE_MS; });
    };
    // 先把明确的准备状态送回各读取者，再开始共享索引；不让短请求等待整个事务。
    preparing(); await yieldSlice(true);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (rebuild) {
        db.exec("DELETE FROM artist_albums; DELETE FROM track_artists; DELETE FROM members; DELETE FROM albums; DELETE FROM tracks; DELETE FROM artists; INSERT INTO documents_fts(documents_fts) VALUES('delete-all'); DELETE FROM documents");
        // 先由原作者建立目录摘要。成员分页借用同屏障的目录计划，避免冷态每页整库物化。
        // 无成员专辑同样保留；名称不会制造曲目或发行关系。
        for (let offset = 0; ; offset += 100) {
          const page = await readPage(mobileQuery({ kind: 'groups', offset }));
          if (page.revision !== revision) return fail('SNAPSHOT_CHANGED');
          for (const row of page.items) {
            const id = albumIdentity(row.album.rootId, row.album.id);
            db.prepare('INSERT INTO albums VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id, row.album.rootId, row.album.id, JSON.stringify(row.album));
            touchedAlbums.add(id);
            const pause = yieldSlice(); if (pause) await pause;
          }
          if (offset + page.items.length >= page.total) break;
          if (!page.items.length) return fail('UNAVAILABLE');
          await yieldSlice(true);
        }
        let total: number | null = null;
        for (let offset = 0; ; offset += 100) {
          const page = await readPage(mobileQuery({ offset }));
          if (page.revision !== revision || total !== null && page.total !== total || page.total > 1_200_000) return fail('SNAPSHOT_CHANGED');
          total = page.total;
          for (const row of page.items) {
            putTrack(db, row, touchedAlbums, touchedArtists);
            const pause = yieldSlice(); if (pause) await pause;
          }
          if (offset + page.items.length >= page.total) break;
          if (!page.items.length) return fail('UNAVAILABLE');
          await yieldSlice(true);
        }
      } else {
        for (const trackId of changes.trackIds) {
          check(); forgetTrack(db, trackId, touchedAlbums, touchedArtists);
          for (let offset = 0; ; offset += 100) {
            const page = await readPage(mobileQuery({ trackId, offset }));
            if (page.revision !== revision) return fail('SNAPSHOT_CHANGED');
            for (const row of page.items) {
              putTrack(db, row, touchedAlbums, touchedArtists);
              const pause = yieldSlice(); if (pause) await pause;
            }
            if (offset + page.items.length >= page.total) break;
            if (!page.items.length) return fail('UNAVAILABLE');
          }
          await yieldSlice(true);
        }
        for (const id of touchedAlbums) {
          check();
          const [rootId, albumKey] = JSON.parse(id) as [string, string];
          const page = await readPage(mobileQuery({ kind: 'groups', rootId, albumKey, limit: 1 }));
          if (page.revision !== revision || page.total > 1) return fail('SNAPSHOT_CHANGED');
          if (page.items[0]) db.prepare('UPDATE albums SET payload=? WHERE id=?').run(JSON.stringify(page.items[0].album), id);
          const pause = yieldSlice(); if (pause) await pause;
        }
      }
      let processed = 0;
      for (const id of touchedAlbums) {
        check(); rebuildAlbum(db, id, touchedArtists);
        const pause = yieldSlice(++processed % 100 === 0); if (pause) await pause;
      }
      for (const id of touchedArtists) {
        check(); rebuildArtist(db, id);
        const pause = yieldSlice(++processed % 100 === 0); if (pause) await pause;
      }
      check();
      if (options.collection.localCatalog.privateArtistSearchChanges(changes.highWater).highWater !== changes.highWater) return fail('SNAPSHOT_CHANGED');
      db.prepare("INSERT OR REPLACE INTO state VALUES('source',?)").run(JSON.stringify({ revision, highWater: changes.highWater }));
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  function beginRefresh(): { task: Promise<void>; readiness: Promise<'ready' | 'preparing'> } {
    assertCurrent();
    if (!refreshTask) {
      let resolveReadiness!: (state: 'ready' | 'preparing') => void, rejectReadiness!: (error: unknown) => void;
      let announced = false;
      const readiness = new Promise<'ready' | 'preparing'>((resolve, reject) => { resolveReadiness = resolve; rejectReadiness = reject; });
      void readiness.catch(() => undefined);
      const preparing = () => { announced = true; resolveReadiness('preparing'); };
      // 没有成功水位时，即便原 Owner 正在核对根目录，也可立即报告首次准备。
      if (!sourceMark(open())) preparing();
      const task = (async () => {
        await options.beforeRefresh?.();
        try { await update(preparing); } finally { options.afterRefresh?.(); }
      })();
      refreshTask = task; refreshReadiness = readiness;
      void task.then(() => { preparationFailure = null; resolveReadiness('ready'); }, error => {
        if ((error instanceof LocalArtistSearchError || error instanceof LocalAlbumReadError) && error.code === 'SNAPSHOT_CHANGED') {
          // 撤销只结束旧快照；下一轮交互重新核权，不能把旧失败冻结到新修订。
          preparationFailure = null;
        } else if (announced) {
          let revision: string | null = null;
          try { revision = options.localAlbums.privateMobile.revision(); } catch { /* 失败时没有可靠的新修订。 */ }
          preparationFailure = { error, revision };
        }
        rejectReadiness(error);
      });
      void task.finally(() => { if (refreshTask === task) { refreshTask = null; refreshReadiness = null; } }).catch(() => undefined);
    }
    return { task: refreshTask, readiness: refreshReadiness! };
  }
  async function refresh(): Promise<void> {
    // 内部明确刷新可重试失败；公开轮询不能由第一个读者消费其他设备的失败状态。
    if (!refreshTask) preparationFailure = null;
    await beginRefresh().task; assertCurrent();
  }
  async function refreshForRead(mode: 'wait' | 'interactive'): Promise<void> {
    assertCurrent();
    if (mode === 'wait') return refresh();
    if (preparationFailure !== null) {
      const failure = preparationFailure;
      let revision: string | null = null;
      try { revision = options.localAlbums.privateMobile.revision(); } catch { /* 保留原准备失败。 */ }
      if (revision !== null && failure.revision !== null && revision !== failure.revision) preparationFailure = null;
      else {
        if (failure.error instanceof LocalArtistSearchError) throw failure.error;
        return fail('UNAVAILABLE');
      }
    }
    const flight = beginRefresh();
    if (await flight.readiness === 'preparing') return fail('PREPARING');
    await flight.task; assertCurrent();
  }
  function current() {
    assertCurrent(); const db = open(), source = sourceMark(db);
    if (!source || source.revision !== options.localAlbums.privateMobile.revision()) return fail('SNAPSHOT_CHANGED');
    return { db, revision: source.revision };
  }
  function artistRow(row: Row): LocalArtistSummary {
    const result = { id: String(row.id), name: String(row.name), source: 'local' as const, albumCount: Number(row.album_count), trackCount: Number(row.track_count) };
    if (!isLocalArtistSummary(result)) return fail('UNAVAILABLE'); return result;
  }
  function artistExists(db: DatabaseSync, artistId: string): Row {
    if (!isLocalArtistId(artistId)) return fail('INVALID_REQUEST');
    return db.prepare('SELECT * FROM artists WHERE id=?').get(artistId) ?? fail('NOT_FOUND');
  }
  function searchWhere(query: string): { sql: string; orderPrefix: string; values: Record<string, SQLInputValue> } {
    const tokens = fold(query).split(/\s+/u).filter(Boolean);
    const values: Record<string, SQLInputValue> = {};
    const conditions = tokens.map((token, index) => {
      values[`q${index}`] = token;
      return `(instr(d.original,@q${index})>0 OR instr(d.full,@q${index})>0 OR instr(d.initials,@q${index})>0)`;
    });
    // 三字以上走持久trigram候选；短词继续同一原文/拼音精确子串语义，不截断召回。
    const indexed = tokens.filter(token => [...token].length >= 3);
    if (indexed.length) {
      values.match = indexed.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ');
      conditions.unshift('d.rowid IN(SELECT rowid FROM documents_fts WHERE documents_fts MATCH @match)');
    }
    // 每个词可来自不同原文字段；全部原文命中优先，其余沿用原有稳定顺序。
    const original = tokens.map((_, index) => `instr(d.original,@q${index})>0`).join(' AND ');
    return { sql: conditions.length ? conditions.join(' AND ') : '1',
      orderPrefix: tokens.length ? `CASE WHEN ${original} THEN 0 ELSE 1 END,` : '', values };
  }
  function trackItem(db: DatabaseSync, row: Row): LocalArtistTrackItem {
    const facts = JSON.parse(String(row.payload)) as LocalLibraryTrackSummary;
    const member = db.prepare('SELECT a.root_id,a.album_key FROM members m JOIN albums a ON a.id=m.album_id WHERE m.track_id=? ORDER BY a.root_id,a.album_key LIMIT 1').get(String(row.id));
    if (!member) return fail('UNAVAILABLE');
    const item = { ...facts, rootId: String(member.root_id), albumKey: String(member.album_key) };
    if (!isLocalArtistTrackItem(item)) return fail('UNAVAILABLE'); return item;
  }
  const page = <T>(offset: number, limit: number, total: number, revision: string, items: T[]) => ({ offset, limit, total, revision, hasMore: offset + items.length < total, items });
  function findArtists(request: ArtistQuery): LocalArtistPage {
    const { db, revision } = current(), where = searchWhere(request.query);
    const from = `FROM artists a JOIN documents d ON d.kind='artist' AND d.id=a.id WHERE ${where.sql}`;
    const total = Number(db.prepare(`SELECT count(*) n ${from}`).get(where.values)!.n);
    // 原文匹配层仍优先；同层完整原名、全拼或首字母优先，不拆复合名或改变分词召回。
    // 艺人 full 存同一姓名的带空格及紧凑全拼；去空格后须与完整紧凑拼音的两份全等。
    const exact = fold(request.query), exactOrder = exact ? `CASE WHEN d.original=@artistExact
      OR replace(d.full,' ','')=(@artistCompact||@artistCompact) OR d.initials=@artistExact THEN 0 ELSE 1 END,` : '';
    const items = db.prepare(`SELECT a.* ${from} ORDER BY ${where.orderPrefix}${exactOrder}a.sort_key,a.name,a.id LIMIT @limit OFFSET @offset`)
      .all({ ...where.values, ...(exact ? { artistExact: exact, artistCompact: exact.replaceAll(' ', '') } : {}), limit: request.limit, offset: request.offset }).map(artistRow);
    const result = { query: request.query, ...page(request.offset, request.limit, total, revision, items) };
    if (!isLocalArtistPage(result)) return fail('UNAVAILABLE'); return result;
  }
  function findAlbums(request: ArtistQuery) {
    const { db, revision } = current(), where = searchWhere(request.query);
    const from = `FROM albums a JOIN documents d ON d.kind='album' AND d.id=a.id WHERE ${where.sql}`;
    const total = Number(db.prepare(`SELECT count(*) n ${from}`).get(where.values)!.n);
    const items = db.prepare(`SELECT a.payload ${from} ORDER BY ${where.orderPrefix}json_extract(a.payload,'$.title'),a.id LIMIT @limit OFFSET @offset`).all({ ...where.values, limit: request.limit, offset: request.offset }).map(row => {
      const album: unknown = JSON.parse(String(row.payload)); if (!isLocalAlbumSummary(album)) return fail('UNAVAILABLE'); return album;
    });
    return { query: request.query, ...page(request.offset, request.limit, total, revision, items) };
  }
  function findTracks(request: ArtistQuery) {
    const { db, revision } = current(), where = searchWhere(request.query);
    const from = `FROM tracks t JOIN documents d ON d.kind='track' AND d.id=t.id WHERE ${where.sql}`;
    const total = Number(db.prepare(`SELECT count(*) n ${from}`).get(where.values)!.n);
    const items = db.prepare(`SELECT t.id,t.payload ${from} ORDER BY ${where.orderPrefix}json_extract(t.payload,'$.metadata.title'),t.id LIMIT @limit OFFSET @offset`).all({ ...where.values, limit: request.limit, offset: request.offset }).map(row => trackItem(db, row));
    return { query: request.query, ...page(request.offset, request.limit, total, revision, items) };
  }
  return {
    refresh,
    get preparing(): boolean { return refreshTask !== null; },
    async revision(): Promise<string> { await refresh(); return current().revision; },
    /** 只撤销派生水位；下一次原作者快照完整替换索引，主库和旧资料不变。 */
    async rebuild(): Promise<void> {
      await refreshTask?.catch(() => undefined); assertCurrent();
      open().prepare("DELETE FROM state WHERE key='source'").run(); await refresh();
    },
    async queryArtists(request: ArtistQuery, mode: 'wait' | 'interactive' = 'wait'): Promise<LocalArtistPage> {
      if (!isArtistQuery(request)) return fail('INVALID_REQUEST'); await refreshForRead(mode); return findArtists(request);
    },
    async querySearchTracks(request: ArtistQuery) {
      if (!isArtistQuery(request)) return fail('INVALID_REQUEST'); await refresh(); return findTracks(request);
    },
    async artist(artistId: string, mode: 'wait' | 'interactive' = 'wait'): Promise<LocalArtistSummary> {
      if (!isLocalArtistId(artistId)) return fail('INVALID_REQUEST');
      await refreshForRead(mode); const { db } = current(); return artistRow(artistExists(db, artistId));
    },
    async queryArtistAlbums(request: LocalArtistAlbumsQuery, mode: 'wait' | 'interactive' = 'wait'): Promise<LocalArtistAlbumsPage> {
      if (!isLocalArtistAlbumsQuery(request)) return fail('INVALID_REQUEST'); await refreshForRead(mode); const { db, revision } = current(); artistExists(db, request.artistId);
      const values = { artist: request.artistId, relation: request.relation }, from = 'FROM artist_albums r JOIN albums a ON a.id=r.album_id WHERE r.artist_id=@artist AND r.relation=@relation';
      const total = Number(db.prepare(`SELECT count(*) n ${from}`).get(values)!.n);
      const items = db.prepare(`SELECT a.payload ${from} ORDER BY json_extract(a.payload,'$.year') DESC,json_extract(a.payload,'$.title'),a.id LIMIT @limit OFFSET @offset`)
        .all({ ...values, limit: request.limit, offset: request.offset }).map(row => JSON.parse(String(row.payload)) as LocalAlbumSummary);
      const result = { ...request, ...page(request.offset, request.limit, total, revision, items) };
      if (!isLocalArtistAlbumsPage(result)) return fail('UNAVAILABLE'); return result;
    },
    async queryArtistTracks(request: LocalArtistTracksQuery, mode: 'wait' | 'interactive' = 'wait'): Promise<LocalArtistTracksPage> {
      if (!isLocalArtistTracksQuery(request)) return fail('INVALID_REQUEST'); await refreshForRead(mode); const { db, revision } = current(); artistExists(db, request.artistId);
      const from = 'FROM track_artists r JOIN tracks t ON t.id=r.track_id WHERE r.artist_id=@artist', values = { artist: request.artistId };
      const total = Number(db.prepare(`SELECT count(*) n ${from}`).get(values)!.n);
      const items = db.prepare(`SELECT t.id,t.payload ${from} ORDER BY json_extract(t.payload,'$.metadata.title'),t.id LIMIT @limit OFFSET @offset`)
        .all({ ...values, limit: request.limit, offset: request.offset }).map(row => trackItem(db, row));
      const result = { ...request, ...page(request.offset, request.limit, total, revision, items) };
      if (!isLocalArtistTracksPage(result)) return fail('UNAVAILABLE'); return result;
    },
    async search(request: ArtistQuery, mode: 'wait' | 'interactive' = 'wait'): Promise<LocalArtistSearchResult> {
      if (!isArtistQuery(request)) return fail('INVALID_REQUEST'); await refreshForRead(mode); const { revision } = current();
      const result = { query: request.query, revision, artists: findArtists(request), albums: findAlbums(request), tracks: findTracks(request) };
      if (!isLocalArtistSearchResult(result)) return fail('UNAVAILABLE'); return result;
    },
    async trackMemberships(trackId: string): Promise<readonly LocalArtistTrackMembership[]> {
      await refresh(); const { db } = current();
      return db.prepare('SELECT a.root_id,a.album_key FROM members m JOIN albums a ON a.id=m.album_id WHERE m.track_id=? ORDER BY a.root_id,a.album_key').all(trackId)
        .map(row => ({ rootId: String(row.root_id), albumKey: String(row.album_key) }));
    },
    async close(): Promise<void> {
      if (closed) return; closed = true; lifetime.abort();
      await refreshTask?.catch(() => undefined); database?.close(); database = undefined;
    },
  };
}
export type LocalArtistSearchService = ReturnType<typeof createLocalArtistSearchService>;
