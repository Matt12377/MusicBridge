import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isCommandOutboxDatasetId, type CommandOutboxContext } from '@music-bridge/contracts';

export const datasetIdentitySchemaObjects = [
  'CREATE TABLE dataset_identities(slot TEXT PRIMARY KEY, dataset_id TEXT NOT NULL UNIQUE, dev TEXT NOT NULL, ino TEXT NOT NULL, birthtime_ns TEXT NOT NULL) STRICT',
] as const;
export interface DatasetIdentity { readonly datasetId: string; assertCurrent(): void }
export class DatasetScopeError extends Error {
  readonly code = 'OUTBOX_SCOPE_MISMATCH';
  constructor() { super('命令所属工作库与当前实际打开的数据库不一致，原操作保留待核对。'); }
}
const mismatch = (): never => { throw new DatasetScopeError(); };
interface FileIdentity { dev: string; ino: string; birthtime_ns: string }
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
  return {
    /** schema 2 首次升级尚无记录；已有激活身份则必须先匹配，不能先打开替换文件。 */
    assertKnown(slot: string, file: string): void { access.read(db => { const previous = stored(db, slot); if (previous && !same(previous, identify(file))) mismatch(); }); },
    bind(slot: string, file: string, allowReplacement: boolean): DatasetIdentity {
      const identity = identify(file);
      const datasetId = access.transaction(db => {
        const previous = stored(db, slot);
        if (previous && same(previous, identity)) return previous.dataset_id;
        if (previous && !allowReplacement) return mismatch();
        const id = randomUUID();
        db.prepare('INSERT INTO dataset_identities VALUES(?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET dataset_id=excluded.dataset_id,dev=excluded.dev,ino=excluded.ino,birthtime_ns=excluded.birthtime_ns')
          .run(slot, id, identity.dev, identity.ino, identity.birthtime_ns);
        return id;
      });
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
