import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isCommandOutboxDatasetId, type CommandOutboxContext } from '@music-bridge/contracts';
import { isDatasetVolumeUUID, withDatasetVolumeIdentity, type DatasetFileIdentity } from './dataset-volume-identity.js';

export const datasetIdentitySchemaObjects = [
  'CREATE TABLE dataset_identities(slot TEXT PRIMARY KEY, dataset_id TEXT NOT NULL UNIQUE, dev TEXT NOT NULL, ino TEXT NOT NULL, birthtime_ns TEXT NOT NULL) STRICT',
] as const;
export const datasetVolumeIdentitySchemaObjects = [
  'CREATE TABLE dataset_volume_identities(slot TEXT PRIMARY KEY, dataset_id TEXT NOT NULL UNIQUE, volume_uuid TEXT NOT NULL, ino TEXT NOT NULL, birthtime_ns TEXT NOT NULL) STRICT',
] as const;
export interface DatasetIdentity { readonly datasetId: string; assertCurrent(): void }
export class DatasetScopeError extends Error {
  readonly code = 'OUTBOX_SCOPE_MISMATCH';
  constructor() { super('命令所属工作库与当前实际打开的数据库不一致，原操作保留待核对。'); }
}
const mismatch = (): never => { throw new DatasetScopeError(); };
type FileIdentity = DatasetFileIdentity;
function identify(file: string): FileIdentity {
  try {
    const info = lstatSync(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || realpathSync(file) !== file) return mismatch();
    return { dev: String(info.dev), ino: String(info.ino), birthtime_ns: String(info.birthtimeNs) };
  } catch { return mismatch(); }
}
const same = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtime_ns === b.birthtime_ns;
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; transaction<T>(fn: (db: DatabaseSync) => T): T }
export function createDatasetIdentityStore(access: Access) {
  function stored(db: DatabaseSync, slot: string): (FileIdentity & { dataset_id: string }) | undefined {
    if (slot !== 'default' && !/^activation:[0-9a-f-]{36}$/u.test(slot)) return mismatch();
    const row = db.prepare('SELECT dataset_id,dev,ino,birthtime_ns FROM dataset_identities WHERE slot=?').get(slot);
    if (!row) return undefined;
    if (!isCommandOutboxDatasetId(row.dataset_id) || ![row.dev, row.ino, row.birthtime_ns].every(v => typeof v === 'string' && /^\d+$/u.test(v))) return mismatch();
    return row as unknown as FileIdentity & { dataset_id: string };
  }
  function volumeBinding(db: DatabaseSync, slot: string, previous: ReturnType<typeof stored>) {
    const row = db.prepare('SELECT dataset_id,volume_uuid,ino,birthtime_ns FROM dataset_volume_identities WHERE slot=?').get(slot);
    if (!row) return undefined;
    if (!previous || row.dataset_id !== previous.dataset_id || row.ino !== previous.ino || row.birthtime_ns !== previous.birthtime_ns || !isDatasetVolumeUUID(row.volume_uuid)) return mismatch();
    return { volumeUUID: row.volume_uuid };
  }
  const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.ino === b.ino && a.birthtime_ns === b.birthtime_ns;
  function matching(db: DatabaseSync, slot: string, previous: ReturnType<typeof stored>, identity: FileIdentity, volumeUUID: string | undefined): boolean {
    if (volumeUUID === undefined) return previous !== undefined && same(previous, identity);
    const anchor = volumeBinding(db, slot, previous);
    if (!previous) return false;
    if (anchor) return anchor.volumeUUID === volumeUUID && sameFile(previous, identity);
    // v3没有稳定卷锚点时，dev-only漂移不能授予同库资格，也不能覆盖旧UUID证据。
    if (!same(previous, identity) && sameFile(previous, identity)) return mismatch();
    return same(previous, identity);
  }
  function anchor(db: DatabaseSync, slot: string, datasetId: string, identity: FileIdentity, volumeUUID: string | undefined): void {
    if (volumeUUID === undefined) { db.prepare('DELETE FROM dataset_volume_identities WHERE slot=?').run(slot); return; }
    db.prepare('INSERT INTO dataset_volume_identities VALUES(?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET dataset_id=excluded.dataset_id,volume_uuid=excluded.volume_uuid,ino=excluded.ino,birthtime_ns=excluded.birthtime_ns')
      .run(slot, datasetId, volumeUUID, identity.ino, identity.birthtime_ns);
  }
  return {
    /** schema 2 首次升级尚无记录；已有激活身份则必须先匹配，不能先打开替换文件。 */
    assertKnown(slot: string, file: string): void {
      const identity = identify(file);
      access.read(db => withDatasetVolumeIdentity(file, identity, volumeUUID => {
        const previous = stored(db, slot);
        if (previous && !matching(db, slot, previous, identity, volumeUUID)) mismatch();
      }));
    },
    bind(slot: string, file: string, allowReplacement: boolean): DatasetIdentity {
      const identity = identify(file);
      const datasetId = access.transaction(db => withDatasetVolumeIdentity(file, identity, volumeUUID => {
        const previous = stored(db, slot);
        if (matching(db, slot, previous, identity, volumeUUID)) {
          db.prepare('UPDATE dataset_identities SET dev=? WHERE slot=?').run(identity.dev, slot);
          if (volumeUUID !== undefined) anchor(db, slot, previous!.dataset_id, identity, volumeUUID);
          return previous!.dataset_id;
        }
        if (previous && !allowReplacement) return mismatch();
        const id = randomUUID();
        db.prepare('INSERT INTO dataset_identities VALUES(?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET dataset_id=excluded.dataset_id,dev=excluded.dev,ino=excluded.ino,birthtime_ns=excluded.birthtime_ns')
          .run(slot, id, identity.dev, identity.ino, identity.birthtime_ns);
        anchor(db, slot, id, identity, volumeUUID);
        return id;
      }));
      return { datasetId, assertCurrent() { if (!same(identity, identify(file))) mismatch(); } };
    },
  };
}

/** 作用域来自实际已打开的 repository；收到请求后不得用当前 ID 覆盖旧 ID。 */
export function createDatasetCommandBoundary(identity: DatasetIdentity) {
  const datasetId = identity.datasetId;
  if (!isCommandOutboxDatasetId(datasetId)) return mismatch();
  return {
    context(): CommandOutboxContext { identity.assertCurrent(); return { datasetId }; },
    assertScope(expected: string): void { if (expected !== datasetId) mismatch(); identity.assertCurrent(); },
  };
}
