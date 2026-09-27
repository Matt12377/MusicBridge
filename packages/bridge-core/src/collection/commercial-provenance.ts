import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId, isCommercialCopyDetails, isCommercialRelease, isPhysicalLinkHistoryEvent, type PhysicalLinkHistoryEvent } from '@music-bridge/contracts';

/** v24 只加独立事实，不改写旧发行 JSON、数量、关系表或旧账本原文。 */
export function migrateCommercialProvenance(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE commercial_release_copies (
  id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id),
  assigned_at TEXT NOT NULL
) STRICT;
CREATE INDEX commercial_release_copies_release ON commercial_release_copies(release_id);
CREATE TABLE commercial_copy_details (
  copy_id TEXT PRIMARY KEY REFERENCES commercial_release_copies(id),
  data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;
CREATE TABLE commercial_copy_photos (
  photo_id TEXT PRIMARY KEY REFERENCES music_photos(id) ON DELETE CASCADE,
  copy_id TEXT NOT NULL REFERENCES commercial_release_copies(id)
) STRICT;
CREATE INDEX commercial_copy_photos_copy ON commercial_copy_photos(copy_id);
CREATE TABLE physical_link_history (
  id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES music_releases(id),
  event_json TEXT NOT NULL
) STRICT;
CREATE INDEX physical_link_history_release ON physical_link_history(release_id);
CREATE TRIGGER commercial_release_copies_no_update BEFORE UPDATE ON commercial_release_copies BEGIN SELECT RAISE(ABORT,'immutable commercial copy'); END;
CREATE TRIGGER commercial_release_copies_no_delete BEFORE DELETE ON commercial_release_copies BEGIN SELECT RAISE(ABORT,'immutable commercial copy'); END;
CREATE TRIGGER physical_link_history_no_update BEFORE UPDATE ON physical_link_history BEGIN SELECT RAISE(ABORT,'immutable relation history'); END;
CREATE TRIGGER physical_link_history_no_delete BEFORE DELETE ON physical_link_history BEGIN SELECT RAISE(ABORT,'immutable relation history'); END;
PRAGMA user_version=24;
`);
  const releaseIds = new Set<string>();
  for (const row of db.prepare('SELECT DISTINCT release_id FROM physical_digital_links').all()) releaseIds.add(String(row.release_id));
  // 旧账本只有结果，没有请求原文。它可能代表一条已撤销的关系；只标记未知历史，不重构事件或伪造日期。
  for (const row of db.prepare('SELECT result FROM physical_links_ledger').all()) {
    let result: unknown;
    try { result = JSON.parse(String(row.result)); } catch { throw new Error('旧关系账本结果损坏'); }
    if (typeof result === 'object' && result !== null && 'id' in result && isCollectionId(result.id)
      && db.prepare('SELECT 1 FROM music_releases WHERE id=?').get(result.id)) releaseIds.add(result.id);
  }
  const insert = db.prepare('INSERT INTO physical_link_history(id,release_id,event_json) VALUES (?,?,?)');
  for (const releaseId of releaseIds) {
    const event: PhysicalLinkHistoryEvent = { id: randomUUID(), releaseId, kind: 'historical-unknown', occurredAt: null };
    insert.run(event.id, releaseId, JSON.stringify(event));
  }
}

/** 备份与恢复激活前核对逐件守恒及事件身份；不把旧账本解释成确认原文。 */
export function verifyCommercialProvenanceDatabase(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT id,data FROM music_releases').all()) {
    const release = JSON.parse(String(row.data)) as unknown;
    if (!isCommercialRelease(release)) throw new Error('商业发行数据无效');
    const count = Number(db.prepare('SELECT COUNT(*) n FROM commercial_release_copies WHERE release_id=?').get(String(row.id))?.n);
    if (count > release.quantity) throw new Error('商业逐件数量超出发行库存');
  }
  for (const row of db.prepare('SELECT c.id,c.release_id,c.assigned_at,d.data,d.revision FROM commercial_release_copies c LEFT JOIN commercial_copy_details d ON d.copy_id=c.id').all()) {
    let details: unknown;
    try { details = JSON.parse(String(row.data)); } catch { throw new Error('商业逐件详情损坏'); }
    if (!isCollectionId(row.id) || !isCollectionId(row.release_id) || typeof row.assigned_at !== 'string' || Number.isNaN(Date.parse(row.assigned_at))
      || !isCommercialCopyDetails(details) || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('商业逐件身份无效');
  }
  if (db.prepare('SELECT 1 FROM commercial_copy_details d LEFT JOIN commercial_release_copies c ON c.id=d.copy_id WHERE c.id IS NULL LIMIT 1').get()) throw new Error('商业逐件详情失配');
  if (db.prepare('SELECT 1 FROM commercial_copy_photos x JOIN commercial_release_copies c ON c.id=x.copy_id JOIN music_photos p ON p.id=x.photo_id WHERE c.release_id<>p.release_id LIMIT 1').get()) throw new Error('商业逐件照片归属失配');
  for (const row of db.prepare('SELECT * FROM physical_link_history').all()) {
    const event: unknown = JSON.parse(String(row.event_json));
    if (!isPhysicalLinkHistoryEvent(event) || event.id !== row.id || event.releaseId !== row.release_id) throw new Error('数字关系历史无效');
  }
}
