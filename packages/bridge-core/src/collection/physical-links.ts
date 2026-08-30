import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isCollectionId, isDigitalAlbum, isDigitalAlbumMetadata, isPhysicalLinksSnapshot, isDigitalAlbumDetail, isMusicEntry, isPhysicalLinkResult, isCollectionMatrixRow,
  type DigitalAlbum, type DigitalAlbumMetadata, type DigitalAlbumDetail, type PhysicalLinksSnapshot, type PhysicalDigitalLink, type PhysicalLinkResult, type PhysicalRelation, type ConfirmAbsenceRequest, type RemovePhysicalLinkRequest, type CollectionMatrixRow, type Page, type PageRequest } from '@music-bridge/contracts';
import type { PhysicalMusicRepository } from './physical-music.js';

export const physicalLinksMigration = `
CREATE TABLE digital_albums (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), physical_absent INTEGER NOT NULL DEFAULT 0 CHECK(physical_absent IN (0,1))) STRICT;
CREATE TABLE physical_digital_links (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), digital_id TEXT NOT NULL REFERENCES digital_albums(id), relation TEXT NOT NULL CHECK(relation IN ('exact','probable','related')), rip_confirmed INTEGER NOT NULL CHECK(rip_confirmed IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0), UNIQUE(release_id,digital_id)) STRICT;
CREATE TABLE physical_digital_absence (release_id TEXT PRIMARY KEY REFERENCES music_releases(id), confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1))) STRICT;
CREATE TABLE physical_links_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER links_ledger_no_update BEFORE UPDATE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER links_ledger_no_delete BEFORE DELETE ON physical_links_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=4;
`;
export interface LinkCommit { commandId: string; fingerprint: string; releaseId: string; expectedRevision: number; relation: PhysicalRelation; ripFromCdConfirmed: boolean; digitalId?: string; metadata?: DigitalAlbumMetadata }
export interface PhysicalLinksRepository {
  digitalList(page: PageRequest): Page<DigitalAlbum>;
  digitalDetail(id: string): DigitalAlbumDetail;
  physical(releaseId: string): PhysicalLinksSnapshot;
  cached(commandId: string, fingerprint: string): PhysicalLinkResult | undefined;
  link(request: LinkCommit): PhysicalLinkResult;
  register(commandId: string, fingerprint: string, metadata: DigitalAlbumMetadata, absent: boolean): PhysicalLinkResult;
  relocate(commandId: string, fingerprint: string, id: string, expectedRevision: number, metadata: DigitalAlbumMetadata): PhysicalLinkResult;
  remove(request: RemovePhysicalLinkRequest, fingerprint: string): PhysicalLinkResult;
  absence(request: ConfirmAbsenceRequest, fingerprint: string): PhysicalLinkResult;
  matrix(page: PageRequest, query?: string): Page<CollectionMatrixRow>;
}
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; unavailable(): never; music: PhysicalMusicRepository; beforeCommit?: (action: string) => void }
const pageValid = (p: PageRequest): boolean => Number.isSafeInteger(p?.offset) && p.offset >= 0 && p.offset <= 1_000_000 && Number.isSafeInteger(p?.limit) && p.limit >= 1 && p.limit <= 100;
const toLink = (r: Record<string, unknown>): PhysicalDigitalLink => ({ id: String(r.id), releaseId: String(r.release_id), digitalId: String(r.digital_id), relation: r.relation as PhysicalRelation, ripFromCdConfirmed: r.rip_confirmed === 1, revision: Number(r.revision) });
export function createPhysicalLinksRepository(access: Access): PhysicalLinksRepository {
  const { read, conflict, unavailable, music } = access;
  function album(db: DatabaseSync, id: string): DigitalAlbum {
    const row = db.prepare('SELECT * FROM digital_albums WHERE id=?').get(id);
    if (!row) return conflict('数字关联对象不存在，请刷新。');
    const result = { id, metadata: JSON.parse(String(row.metadata)) as DigitalAlbumMetadata, revision: Number(row.revision), physicalAbsenceConfirmed: row.physical_absent === 1 };
    if (!isDigitalAlbum(result)) return unavailable(); return result;
  }
  function receipt(db: DatabaseSync, commandId: string, fingerprint: string): PhysicalLinkResult | undefined {
    if (!isCollectionId(commandId) || !/^[0-9a-f]{64}$/u.test(fingerprint)) return conflict('关联操作编号无效。');
    const row = db.prepare('SELECT fingerprint,result FROM physical_links_ledger WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同关联内容。');
    const result: unknown = JSON.parse(String(row.result)); if (!isPhysicalLinkResult(result)) return unavailable(); return result;
  }
  function transaction(commandId: string, fingerprint: string, action: string, fn: (db: DatabaseSync) => PhysicalLinkResult): PhysicalLinkResult {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try {
      const prior = receipt(db, commandId, fingerprint); if (prior) { db.exec('COMMIT'); return prior; }
      const result = fn(db); if (!isPhysicalLinkResult(result)) return unavailable();
      db.prepare('INSERT INTO physical_links_ledger VALUES (?,?,?,?)').run(commandId, fingerprint, JSON.stringify(result), new Date().toISOString());
      access.beforeCommit?.(action); db.exec('COMMIT'); return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 不自动清库或更换操作编号。 */ } throw error; } });
  }
  function createAlbum(db: DatabaseSync, metadata: DigitalAlbumMetadata, absent: boolean): string {
    if (!isDigitalAlbumMetadata(metadata)) return conflict('Roon 专辑信息不完整或过长，无法保存关联。');
    const id = randomUUID(); db.prepare('INSERT INTO digital_albums VALUES (?,?,1,?)').run(id, JSON.stringify(metadata), absent ? 1 : 0); return id;
  }
  function physical(db: DatabaseSync, releaseId: string): PhysicalLinksSnapshot {
    const current = music.detail(releaseId); if (!current.release) return conflict('自录内容不能建立商业原版发行关系。');
    const result = { releaseId, revision: current.entry.revision, digitalAbsenceConfirmed: db.prepare('SELECT confirmed FROM physical_digital_absence WHERE release_id=?').get(releaseId)?.confirmed === 1,
      links: db.prepare('SELECT * FROM physical_digital_links WHERE release_id=? ORDER BY rowid').all(releaseId).map(row => ({ link: toLink(row), album: album(db, String(row.digital_id)) })) };
    if (!isPhysicalLinksSnapshot(result)) return unavailable(); return result;
  }
  return {
    cached(commandId, fingerprint) { return read(db => receipt(db, commandId, fingerprint)); },
    digitalList(page) { if (!pageValid(page)) return conflict('分页无效。'); return read(db => { const total = Number(db.prepare('SELECT COUNT(*) n FROM digital_albums').get()?.n); const items = db.prepare('SELECT id FROM digital_albums ORDER BY rowid DESC LIMIT ? OFFSET ?').all(page.limit, page.offset).map(r => album(db, String(r.id))); return { items, ...page, total, hasMore: page.offset + items.length < total }; }); },
    digitalDetail(id) { if (!isCollectionId(id)) return conflict('数字对象编号无效。'); return read(db => { const result = { album: album(db, id), links: db.prepare('SELECT * FROM physical_digital_links WHERE digital_id=? ORDER BY rowid').all(id).map(row => ({ link: toLink(row), release: music.detail(String(row.release_id)).entry })) }; if (!isDigitalAlbumDetail(result, isMusicEntry)) return unavailable(); return result; }); },
    physical(id) { if (!isCollectionId(id)) return conflict('发行版编号无效。'); return read(db => physical(db, id)); },
    link(request) {
      return transaction(request.commandId, request.fingerprint, 'confirm-physical-link', db => {
        const current = physical(db, request.releaseId);
        if (current.revision !== request.expectedRevision) return conflict('实体资料已改变，请刷新后确认关联。');
        const release = music.detail(request.releaseId).release!;
        if (request.ripFromCdConfirmed && (release.format !== 'cd' || request.relation !== 'exact')) return conflict('CD Rip 来源只能由用户明确确认相同发行版的原版 CD。');
        const digitalId = request.digitalId ?? createAlbum(db, request.metadata!, false); album(db, digitalId);
        const prior = db.prepare('SELECT * FROM physical_digital_links WHERE release_id=? AND digital_id=?').get(request.releaseId, digitalId);
        if (!prior && (current.links.length >= 20 || Number(db.prepare('SELECT COUNT(*) n FROM physical_digital_links WHERE digital_id=?').get(digitalId)?.n) >= 100)) return conflict('关联数量已达上限，请先整理现有关系。');
        const linkId = prior ? String(prior.id) : randomUUID();
        if (prior) db.prepare('UPDATE physical_digital_links SET relation=?,rip_confirmed=?,revision=revision+1 WHERE id=?').run(request.relation, request.ripFromCdConfirmed ? 1 : 0, linkId);
        else db.prepare('INSERT INTO physical_digital_links VALUES (?,?,?,?,?,1)').run(linkId, request.releaseId, digitalId, request.relation, request.ripFromCdConfirmed ? 1 : 0);
        db.prepare('INSERT INTO physical_digital_absence VALUES (?,0) ON CONFLICT(release_id) DO UPDATE SET confirmed=0').run(request.releaseId);
        db.prepare('UPDATE music_releases SET revision=revision+1 WHERE id=?').run(request.releaseId);
        db.prepare('UPDATE digital_albums SET physical_absent=0,revision=revision+1 WHERE id=?').run(digitalId);
        return { id: request.releaseId, digitalId, linkId };
      });
    },
    register(commandId, fingerprint, metadata, absent) { return transaction(commandId, fingerprint, 'register-digital-album', db => { const id = createAlbum(db, metadata, absent); return { id, digitalId: id }; }); },
    relocate(commandId, fingerprint, id, expectedRevision, metadata) {
      return transaction(commandId, fingerprint, 'relocate-digital-album', db => {
        const current = album(db, id); if (current.revision !== expectedRevision) return conflict('数字关联对象已改变，请刷新后重新定位。');
        if (!isDigitalAlbumMetadata(metadata) || ['title', 'artist', 'year', 'version'].some(k => current.metadata[k as keyof DigitalAlbumMetadata] !== metadata[k as keyof DigitalAlbumMetadata])) return conflict('候选专辑元数据已改变，请另建数字关联对象，不覆盖原有关系。');
        db.prepare('UPDATE digital_albums SET revision=revision+1 WHERE id=?').run(id); return { id, digitalId: id };
      });
    },
    remove(request, fingerprint) {
      return transaction(request.commandId, fingerprint, 'remove-physical-link', db => {
        const row = db.prepare('SELECT * FROM physical_digital_links WHERE id=?').get(request.linkId);
        if (!row || row.revision !== request.expectedRevision) return conflict('关联已改变，请刷新。');
        db.prepare('DELETE FROM physical_digital_links WHERE id=?').run(request.linkId);
        db.prepare('UPDATE music_releases SET revision=revision+1 WHERE id=?').run(String(row.release_id));
        db.prepare('UPDATE digital_albums SET revision=revision+1 WHERE id=?').run(String(row.digital_id));
        return { id: String(row.release_id), digitalId: String(row.digital_id), linkId: request.linkId };
      });
    },
    absence(request, fingerprint) {
      return transaction(request.commandId, fingerprint, 'confirm-physical-digital-absence', db => {
        if (request.target === 'digital') {
          const current = physical(db, request.id); if (current.revision !== request.expectedRevision) return conflict('实体资料已改变，请刷新。');
          if (request.confirmedAbsent && current.links.length) return conflict('仍有数字关联，不能同时确认没有数字版。');
          db.prepare('INSERT INTO physical_digital_absence VALUES (?,?) ON CONFLICT(release_id) DO UPDATE SET confirmed=excluded.confirmed').run(request.id, request.confirmedAbsent ? 1 : 0);
          db.prepare('UPDATE music_releases SET revision=revision+1 WHERE id=?').run(request.id);
        } else {
          const current = album(db, request.id); if (current.revision !== request.expectedRevision) return conflict('数字资料已改变，请刷新。');
          if (request.confirmedAbsent && Number(db.prepare('SELECT COUNT(*) n FROM physical_digital_links WHERE digital_id=?').get(request.id)?.n)) return conflict('仍有关联的原版实物，不能确认没有原版收藏。');
          db.prepare('UPDATE digital_albums SET physical_absent=?,revision=revision+1 WHERE id=?').run(request.confirmedAbsent ? 1 : 0, request.id);
        }
        return { id: request.id };
      });
    },
    matrix(page, query = '') {
      if (!pageValid(page) || query.length > 240) return conflict('矩阵查询无效。');
      return read(db => {
        // 只按已确认的关系聚合。Probable/Related 单列，不算确认拥有同一发行版。
        const source = `SELECT d.id,json_extract(d.metadata,'$.title') title,json_extract(d.metadata,'$.artist') artist,d.id digitalId,NULL releaseId,COALESCE(SUM(CASE WHEN l.relation='exact' AND json_extract(r.data,'$.format')='cd' THEN json_extract(r.data,'$.quantity') ELSE 0 END),0) cd,COALESCE(SUM(CASE WHEN l.relation='exact' AND json_extract(r.data,'$.format')='cassette' THEN json_extract(r.data,'$.quantity') ELSE 0 END),0) cassette,SUM(CASE WHEN l.relation<>'exact' THEN 1 ELSE 0 END) uncertainRelations,'linked' digitalState,CASE WHEN COUNT(l.id)>0 THEN 'owned' WHEN d.physical_absent=1 THEN 'confirmed-missing' ELSE 'unchecked' END physicalState FROM digital_albums d LEFT JOIN physical_digital_links l ON l.digital_id=d.id LEFT JOIN music_releases r ON r.id=l.release_id GROUP BY d.id UNION ALL SELECT r.id,json_extract(r.data,'$.title'),json_extract(r.data,'$.artist'),NULL,r.id,CASE WHEN json_extract(r.data,'$.format')='cd' THEN json_extract(r.data,'$.quantity') ELSE 0 END,CASE WHEN json_extract(r.data,'$.format')='cassette' THEN json_extract(r.data,'$.quantity') ELSE 0 END,0,CASE WHEN a.confirmed=1 THEN 'confirmed-missing' ELSE 'unchecked' END,'owned' FROM music_releases r LEFT JOIN physical_digital_absence a ON a.release_id=r.id WHERE NOT EXISTS(SELECT 1 FROM physical_digital_links l WHERE l.release_id=r.id)`;
        const from = `FROM (${source}) WHERE instr(lower(title || ' ' || COALESCE(artist,'')),?)>0`;
        const values: SQLInputValue[] = [query.trim().toLowerCase()];
        const total = Number(db.prepare(`SELECT COUNT(*) n ${from}`).get(...values)?.n);
        const items = db.prepare(`SELECT * ${from} ORDER BY title,id LIMIT ? OFFSET ?`).all(...values, page.limit, page.offset).map(row => {
          const result = { id: String(row.id), title: String(row.title), ...(row.artist !== null ? { artist: String(row.artist) } : {}), ...(row.digitalId ? { digitalId: String(row.digitalId) } : { releaseId: String(row.releaseId) }), cd: Number(row.cd), cassette: Number(row.cassette), uncertainRelations: Number(row.uncertainRelations), digitalState: row.digitalState, physicalState: row.physicalState };
          if (!isCollectionMatrixRow(result)) return unavailable(); return result;
        }); return { items, ...page, total, hasMore: page.offset + items.length < total };
      });
    },
  };
}
