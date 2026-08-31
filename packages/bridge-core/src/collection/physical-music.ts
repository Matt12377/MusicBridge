import { formalRecordingMusicSelect, getRecordingCopyProjection } from '../recording/record-projections.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isMusicId, isMusicFilter, isSaveReleaseRequest, isSaveLegacyRequest, isMusicMutationResult, isMusicDetail, isAddMusicPhotoRequest, isRemoveMusicPhotoRequest, isCollectionPhotoImage, isCollectionId,
  type MusicEntry, type MusicDetail, type MusicFilter, type CommercialRelease, type MusicContent, type MusicPhoto, type SaveReleaseRequest, type SaveLegacyRequest, type MusicMutationResult, type AddMusicPhotoRequest, type RemoveMusicPhotoRequest, type CollectionPhotoImage, type Page, type PageRequest } from '@music-bridge/contracts';

export const physicalMusicMigration = `
CREATE TABLE music_releases (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE legacy_recording_content (physical_id TEXT PRIMARY KEY REFERENCES physical_copies(physical_id), data TEXT NOT NULL) STRICT;
CREATE TABLE music_photos (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id), content BLOB NOT NULL CHECK(length(content) BETWEEN 4 AND 1048576), content_hash TEXT NOT NULL, width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1200), height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1200), UNIQUE(release_id,content_hash)) STRICT;
CREATE TABLE music_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER music_ledger_no_update BEFORE UPDATE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER music_ledger_no_delete BEFORE DELETE ON music_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=3;
`;
export interface PhysicalMusicRepository {
  list(page: PageRequest, filter?: MusicFilter): Page<MusicEntry>;
  detail(id: string): MusicDetail;
  saveRelease(request: SaveReleaseRequest): MusicMutationResult;
  saveLegacy(request: SaveLegacyRequest): MusicMutationResult;
  addPhoto(request: AddMusicPhotoRequest): MusicMutationResult;
  photo(id: string): CollectionPhotoImage;
  removePhoto(request: RemoveMusicPhotoRequest): MusicMutationResult;
}
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; unavailable(): never; beforeCommit?: (action: string) => void }
function canonical(v: unknown): string { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : typeof v === 'object' && v !== null ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}` : JSON.stringify(v); }
function photo(row: Record<string, unknown>): MusicPhoto { return { id: String(row.id), releaseId: String(row.release_id), width: Number(row.width), height: Number(row.height), source: 'user-photo' }; }
const personalSelect = `SELECT c.physical_id,c.revision,c.origin,c.usage,s.model_id,m.descriptor,r.data FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id JOIN collection_models m ON m.id=s.model_id LEFT JOIN legacy_recording_content r ON r.physical_id=c.physical_id`;
export function createPhysicalMusicRepository(access: Access): PhysicalMusicRepository {
  const { read, conflict, unavailable } = access;
  function detail(db: DatabaseSync, id: string): MusicDetail {
    const release = db.prepare('SELECT * FROM music_releases WHERE id=?').get(id);
    let result: MusicDetail;
    if (release) {
      const data = JSON.parse(String(release.data)) as CommercialRelease;
      const photos = db.prepare('SELECT id,release_id,width,height FROM music_photos WHERE release_id=? ORDER BY rowid').all(id).map(photo);
      result = { entry: { id, kind: data.format, title: data.title, artist: data.artist, quantity: data.quantity, revision: Number(release.revision), contentStatus: 'commercial', ...(photos[0] ? { photo: photos[0] } : {}) }, release: data, photos };
    } else {
      const projection = getRecordingCopyProjection(db, id);
      const row = db.prepare(`${personalSelect} WHERE c.physical_id=?${projection ? '' : " AND c.usage='recorded' AND c.origin='legacy-registration'"}`).get(id);
      if (!row) return conflict('音乐实物不存在，请刷新收藏。');
      const model = JSON.parse(String(row.descriptor)) as { format: string };
      const recording = row.data ? JSON.parse(String(row.data)) as MusicContent : undefined;
      if (projection) {
        const entry = db.prepare(`SELECT title,artist FROM (${formalRecordingMusicSelect}) WHERE id=?`).get(id);
        if (!entry) return unavailable();
        result = { entry: { id, kind: model.format === 'dat' ? 'personal-dat' : 'personal-cassette', title: String(entry.title), artist: String(entry.artist), quantity: 1, revision: Number(row.revision),
          contentStatus: projection.recordingState.state === 'confirmed-recording' ? 'formal' : 'formal-current-unknown', modelId: String(row.model_id), recordingState: projection.recordingState }, formal: projection.recordingState, photos: [] };
      } else {
        result = { entry: { id, kind: model.format === 'dat' ? 'personal-dat' : 'personal-cassette', title: recording?.title ?? '已录音，内容待补录', artist: recording?.artist ?? '艺术家待补录', quantity: 1, revision: Number(row.revision), contentStatus: recording ? 'legacy' : 'missing', modelId: String(row.model_id) }, ...(recording ? { recording } : {}), photos: [] };
      }
    }
    if (!isMusicDetail(result)) return unavailable();
    return result;
  }
  function transaction(action: string, request: { commandId: string }, valid: boolean, fn: (db: DatabaseSync) => MusicMutationResult): MusicMutationResult {
    if (!valid) return conflict('音乐资料请求无效，请检查字段、曲目和编号。');
    return read(db => {
      const fingerprint = createHash('sha256').update(canonical({ action, request })).digest('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db.prepare('SELECT fingerprint,result FROM music_ledger WHERE command_id=?').get(request.commandId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同内容。');
          const result: unknown = JSON.parse(String(prior.result));
          if (!isMusicMutationResult(result)) return unavailable();
          db.exec('COMMIT'); return result;
        }
        const result = fn(db);
        db.prepare('INSERT INTO music_ledger VALUES (?,?,?,?,?)').run(request.commandId, fingerprint, action, JSON.stringify(result), new Date().toISOString());
        access.beforeCommit?.(action); db.exec('COMMIT'); return result;
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 保留原故障，不自动更换命令。 */ } throw error; }
    });
  }
  return {
    list(page, filter = {}) {
      if (!Number.isSafeInteger(page?.offset) || page.offset < 0 || page.offset > 1_000_000 || !Number.isSafeInteger(page?.limit) || page.limit < 1 || page.limit > 100 || !isMusicFilter(filter)) return conflict('音乐库分页或筛选无效。');
      return read(db => {
        const union = `SELECT id,json_extract(data,'$.title') title,json_extract(data,'$.artist') artist,json_extract(data,'$.format') kind FROM music_releases UNION ALL SELECT c.physical_id,COALESCE(json_extract(r.data,'$.title'),'已录音，内容待补录'),COALESCE(json_extract(r.data,'$.artist'),'艺术家待补录'),CASE WHEN json_extract(m.descriptor,'$.format')='dat' THEN 'personal-dat' ELSE 'personal-cassette' END FROM physical_copies c JOIN inventory_lots l ON l.id=c.lot_id JOIN collection_skus s ON s.id=l.sku_id JOIN collection_models m ON m.id=s.model_id LEFT JOIN legacy_recording_content r ON r.physical_id=c.physical_id WHERE c.usage='recorded' AND c.origin='legacy-registration' AND NOT EXISTS(SELECT 1 FROM recording_record_current h WHERE h.physical_id=c.physical_id) UNION ALL ${formalRecordingMusicSelect}`;
        const conditions: string[] = [], values: SQLInputValue[] = [];
        if (filter.query?.trim()) { conditions.push("instr(lower(title || ' ' || artist),?)>0"); values.push(filter.query.trim().toLowerCase()); }
        if (filter.kind) { conditions.push('kind=?'); values.push(filter.kind); }
        const source = `FROM (${union})${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`;
        const total = Number(db.prepare(`SELECT COUNT(*) n ${source}`).get(...values)?.n);
        const items = db.prepare(`SELECT id ${source} ORDER BY title,id LIMIT ? OFFSET ?`).all(...values, page.limit, page.offset).map(row => detail(db, String(row.id)).entry);
        return { items, ...page, total, hasMore: page.offset + items.length < total };
      });
    },
    detail(id) { if (!isMusicId(id)) return conflict('音乐实物编号无效。'); return read(db => detail(db, id)); },
    saveRelease(request) {
      return transaction('save-release', request, isSaveReleaseRequest(request), db => {
        const id = request.id ?? randomUUID();
        if (request.id) {
          const current = detail(db, id);
          if (!current.release || current.entry.revision !== request.expectedRevision) return conflict('音乐资料已改变，请刷新后重试。');
          if (current.release.format !== request.release.format) return conflict('已有实物不能改成另一种介质，请分别登记。');
          db.prepare('UPDATE music_releases SET data=?,revision=revision+1 WHERE id=?').run(JSON.stringify(request.release), id);
        } else db.prepare('INSERT INTO music_releases VALUES (?,?,1)').run(id, JSON.stringify(request.release));
        detail(db, id); return { id };
      });
    },
    saveLegacy(request) {
      return transaction('save-legacy', request, isSaveLegacyRequest(request), db => {
        const row = db.prepare(`${personalSelect} WHERE c.physical_id=?`).get(request.physicalId);
        if (!row || row.usage !== 'recorded' || row.origin !== 'legacy-registration' || getRecordingCopyProjection(db, request.physicalId)) return conflict('只能补录已经登记的旧录音，不能把空白磁带直接标记为录音完成。');
        if (Number(row.revision) !== request.expectedRevision) return conflict('单盘资料已改变，请刷新后重试。');
        const format = (JSON.parse(String(row.descriptor)) as { format: string }).format;
        if (request.content.tracks.some(t => format === 'cassette' ? t.side === undefined || t.disc !== undefined : t.side !== undefined || t.disc !== undefined)) return conflict('旧录音曲目分面与介质不一致。');
        db.prepare('INSERT INTO legacy_recording_content VALUES (?,?) ON CONFLICT(physical_id) DO UPDATE SET data=excluded.data').run(request.physicalId, JSON.stringify(request.content));
        db.prepare('UPDATE physical_copies SET revision=revision+1 WHERE physical_id=?').run(request.physicalId);
        return { id: request.physicalId };
      });
    },
    addPhoto(request) {
      return transaction('add-music-photo', request, isAddMusicPhotoRequest(request), db => {
        const current = detail(db, request.id);
        if (!current.release) return conflict('自录磁带照片请在原型号或单盘下添加。');
        const bytes = Buffer.from(request.image.dataUrl.slice(23), 'base64');
        if (bytes.length > 1048576 || bytes.toString('base64') !== request.image.dataUrl.slice(23) || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return conflict('照片内容无效。');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const prior = db.prepare('SELECT id FROM music_photos WHERE release_id=? AND content_hash=?').get(request.id, hash);
        if (prior) return { id: request.id, photoId: String(prior.id) };
        if (current.photos.length >= 24) return conflict('每个发行版最多保存 24 张实物照片。');
        const id = randomUUID(); db.prepare('INSERT INTO music_photos VALUES (?,?,?,?,?,?)').run(id, request.id, bytes, hash, request.image.width, request.image.height);
        db.prepare('UPDATE music_releases SET revision=revision+1 WHERE id=?').run(request.id);
        return { id: request.id, photoId: id };
      });
    },
    photo(id) {
      if (!isCollectionId(id)) return conflict('照片编号无效。');
      return read(db => {
        const row = db.prepare('SELECT * FROM music_photos WHERE id=?').get(id);
        if (!row) return conflict('照片不存在或已移除。');
        const bytes = Buffer.from(row.content as Uint8Array);
        if (createHash('sha256').update(bytes).digest('hex') !== row.content_hash) return unavailable();
        const result = { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, width: Number(row.width), height: Number(row.height) };
        if (!isCollectionPhotoImage(result)) return unavailable(); return result;
      });
    },
    removePhoto(request) {
      return transaction('remove-music-photo', request, isRemoveMusicPhotoRequest(request), db => {
        const current = detail(db, request.id);
        if (current.entry.revision !== request.expectedRevision) return conflict('音乐资料已改变，请刷新后重试。');
        if (!current.photos.some(p => p.id === request.photoId)) return conflict('照片不属于此发行版。');
        db.prepare('DELETE FROM music_photos WHERE id=?').run(request.photoId);
        db.prepare('UPDATE music_releases SET revision=revision+1 WHERE id=?').run(request.id);
        return { id: request.id, photoId: request.photoId };
      });
    },
  };
}
