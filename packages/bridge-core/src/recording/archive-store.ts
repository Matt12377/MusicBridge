import { createArchiveWorkflowStore } from './archive-workflow-store.js';
import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId, isStartArchiveRequest, isSourceAction, type StartArchiveRequest, type ExecutionAsset } from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { archiveManifest, archiveDigest, type ArchiveInput, type ArchiveLineage, type OwnedArchive, type OwnedArchiveOperation, type ArchiveFilePhase } from './archive-files.js';

export const archiveMigration = `
CREATE TABLE archive_roots(id TEXT PRIMARY KEY,data TEXT NOT NULL,authorized INTEGER NOT NULL CHECK(authorized IN (0,1))) STRICT;
CREATE TABLE archive_operations(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES archive_roots(id),asset_id TEXT NOT NULL REFERENCES execution_assets(id),fingerprint TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('REQUESTED','INTENT_WRITTEN','STAGED','VERIFIED','PROMOTED','DB_COMMITTED','FINALIZED')),data TEXT NOT NULL,issue TEXT CHECK(issue IS NULL OR issue IN ('ARCHIVE_RECOVERY_REQUIRED','ARCHIVE_ROOT_INVALID','ARCHIVE_DISK_FULL','CANCELLED'))) STRICT;
CREATE TABLE archive_objects(root_id TEXT NOT NULL REFERENCES archive_roots(id),sha256 TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>0),PRIMARY KEY(root_id,sha256)) STRICT;
CREATE TABLE archive_references(operation_id TEXT NOT NULL REFERENCES archive_operations(id),root_id TEXT NOT NULL,role TEXT NOT NULL,name TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(operation_id,role,name),FOREIGN KEY(root_id,sha256) REFERENCES archive_objects(root_id,sha256)) STRICT;
CREATE TRIGGER archive_roots_identity BEFORE UPDATE OF id,data ON archive_roots BEGIN SELECT RAISE(ABORT,'归档目录身份不可改写'); END;
CREATE TRIGGER archive_operations_identity BEFORE UPDATE OF id,root_id,asset_id,fingerprint ON archive_operations BEGIN SELECT RAISE(ABORT,'归档意图不可改写'); END;
CREATE TRIGGER archive_operations_data BEFORE UPDATE OF data ON archive_operations WHEN OLD.phase<>'REQUESTED' BEGIN SELECT RAISE(ABORT,'归档操作内容不可改写'); END;
CREATE TRIGGER archive_operations_no_delete BEFORE DELETE ON archive_operations BEGIN SELECT RAISE(ABORT,'归档历史不可删除'); END;
CREATE TRIGGER archive_objects_no_update BEFORE UPDATE ON archive_objects BEGIN SELECT RAISE(ABORT,'归档对象不可改写或删除'); END;
CREATE TRIGGER archive_objects_no_delete BEFORE DELETE ON archive_objects BEGIN SELECT RAISE(ABORT,'归档对象不可改写或删除'); END;
CREATE TRIGGER archive_references_no_update BEFORE UPDATE ON archive_references BEGIN SELECT RAISE(ABORT,'归档引用不可改写或删除'); END;
CREATE TRIGGER archive_references_no_delete BEFORE DELETE ON archive_references BEGIN SELECT RAISE(ABORT,'归档引用不可改写或删除'); END;
PRAGMA user_version=13;
`;
export interface ArchiveRequest {
  id: string; rootId: string; files: readonly ArchiveInput[]; lineage: ArchiveLineage; confirmed: boolean;
  workflow?: { request: StartArchiveRequest; createdAt: string };
}
export interface StoredArchiveOperation {
  request: ArchiveRequest; phase: 'REQUESTED' | ArchiveFilePhase; owned?: OwnedArchiveOperation;
  issue?: 'ARCHIVE_RECOVERY_REQUIRED' | 'ARCHIVE_ROOT_INVALID' | 'ARCHIVE_DISK_FULL' | 'CANCELLED';
}
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void }
export function createArchiveStore({ read, conflict, beforeCommit }: Access) {
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T { return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  function root(db: DatabaseSync, id: string): OwnedArchive {
    const row = db.prepare('SELECT data,authorized FROM archive_roots WHERE id=?').get(id);
    if (!row || row.authorized !== 1) return conflict('归档目录未授权或已撤销。');
    return JSON.parse(String(row.data)) as OwnedArchive;
  }
  function operation(db: DatabaseSync, id: string): StoredArchiveOperation | undefined {
    const row = db.prepare('SELECT data,phase,issue FROM archive_operations WHERE id=?').get(id); if (!row) return undefined;
    const value = JSON.parse(String(row.data)) as Pick<StoredArchiveOperation, 'request' | 'owned'>;
    return { ...value, phase: row.phase as StoredArchiveOperation['phase'], ...(row.issue ? { issue: row.issue as NonNullable<StoredArchiveOperation['issue']> } : {}) };
  }
  function required(db: DatabaseSync, id: string): StoredArchiveOperation { return operation(db, id) ?? conflict('归档操作不存在。'); }
  function receipt(db: DatabaseSync, commandId: string, fingerprint: string): string | undefined {
    const row = db.prepare('SELECT fingerprint,result_id FROM archive_workflow_ledger WHERE command_id=?').get(commandId);
    if (row && row.fingerprint !== fingerprint) return conflict('原归档命令不能用于不同请求。');
    return row ? String(row.result_id) : undefined;
  }
  function record(db: DatabaseSync, commandId: string, fingerprint: string, id: string): void {
    db.prepare('INSERT INTO archive_workflow_ledger VALUES (?,?,?,?)').run(commandId, fingerprint, id, new Date().toISOString());
  }
  function advance(db: DatabaseSync, id: string, previous: StoredArchiveOperation['phase'], next: ArchiveFilePhase): StoredArchiveOperation {
    const op = required(db, id); root(db, op.request.rootId);
    if (op.phase !== previous && op.phase !== next) return conflict('归档阶段不匹配，不能跳过文件或数据库验证。');
    db.prepare('UPDATE archive_operations SET phase=?,issue=NULL WHERE id=?').run(next, id); return required(db, id);
  }
  function registerRootInTransaction(db: DatabaseSync, archive: OwnedArchive): OwnedArchive {
    if (!isCollectionId(archive.id)) return conflict('归档目录标识无效。');
    const prior = db.prepare('SELECT data,authorized FROM archive_roots WHERE id=?').get(archive.id);
    if (prior) { if (prior.authorized !== 1 || mediaFingerprint(JSON.parse(String(prior.data))) !== mediaFingerprint(archive)) return conflict('原目录授权不能替换为另一目录。'); return root(db, archive.id); }
    if (Number(db.prepare('SELECT count(*) n FROM archive_roots').get()!.n) >= 16) return conflict('归档目录数量已达到上限。');
    db.prepare('INSERT INTO archive_roots VALUES (?,?,1)').run(archive.id, JSON.stringify(archive)); return root(db, archive.id);
  }
  return {
    ...createArchiveWorkflowStore({ read, conflict, registerRootInTransaction, ...(beforeCommit ? { beforeCommit } : {}) }),
    registerRoot: (archive: OwnedArchive) => transaction('register-archive-root', db => registerRootInTransaction(db, archive)),
    root: (id: string) => read(db => root(db, id)),
    revokeRoot: (id: string) => transaction('revoke-archive-root', db => { db.prepare('UPDATE archive_roots SET authorized=0 WHERE id=?').run(id); }),
    cached(request: StartArchiveRequest): StoredArchiveOperation | undefined {
      if (!isStartArchiveRequest(request)) return conflict('归档确认无效。');
      return read(db => { const id = receipt(db, request.commandId, mediaFingerprint(['start-archive', request])); return id ? required(db, id) : undefined; });
    },
    control(action: 'cancel' | 'resume', request: { commandId: string; id: string }): { operation: StoredArchiveOperation; replayed: boolean } {
      if (!isSourceAction(request) || !['cancel','resume'].includes(action)) return conflict('归档控制请求无效。');
      return transaction('control-archive', db => {
        const fingerprint = mediaFingerprint([`${action}-archive`, request.id]), prior = receipt(db, request.commandId, fingerprint);
        if (prior) return { operation: required(db, prior), replayed: true };
        const op = required(db, request.id); if (!op.request.workflow) return conflict('内核归档没有用户工作流确认。');
        if (action === 'resume') root(db, op.request.rootId);
        // 已提交的引用不能伪撤销；仅暂停尚未提交的复制与发布。
        if (op.phase !== 'DB_COMMITTED' && op.phase !== 'FINALIZED') db.prepare('UPDATE archive_operations SET issue=? WHERE id=?').run(action === 'cancel' ? 'CANCELLED' : null, request.id);
        record(db, request.commandId, fingerprint, request.id); return { operation: required(db, request.id), replayed: false };
      });
    },
    request(request: ArchiveRequest): StoredArchiveOperation {
      if (!request || request.confirmed !== true || !isCollectionId(request.id) || !isCollectionId(request.rootId) || Object.keys(request).sort().join(',') !== `confirmed,files,id,lineage,rootId${request.workflow ? ',workflow' : ''}`) return conflict('请明确确认归档请求。');
      archiveManifest(request.id, request.files, request.lineage);
      const workflow = request.workflow;
      if (workflow && (Object.keys(workflow).sort().join(',') !== 'createdAt,request' || !isStartArchiveRequest(workflow.request) || workflow.request.commandId !== request.id || workflow.request.rootId !== request.rootId || workflow.request.assetId !== request.lineage.executionAssetId || !Number.isFinite(Date.parse(workflow.createdAt)) || new Date(workflow.createdAt).toISOString() !== workflow.createdAt)) return conflict('归档用户确认与冻结谱系不一致。');
      return transaction('request-archive', db => {
        const fingerprint = mediaFingerprint(request), prior = db.prepare('SELECT fingerprint FROM archive_operations WHERE id=?').get(request.id);
        if (prior) { if (prior.fingerprint !== fingerprint) return conflict('原操作编号不能用于不同归档。'); return required(db, request.id); }
        if (workflow) receipt(db, request.id, mediaFingerprint(['start-archive', workflow.request]));
        root(db, request.rootId);
        const row = db.prepare('SELECT data FROM execution_assets WHERE id=?').get(request.lineage.executionAssetId);
        const asset = row ? JSON.parse(String(row.data)) as ExecutionAsset : undefined;
        if (!asset || asset.masterVersionId !== request.lineage.masterVersionId || asset.layoutVersionId !== request.lineage.layoutVersionId) return conflict('归档谱系与冻结执行资产不匹配。');
        if (Number(db.prepare('SELECT count(*) n FROM archive_operations').get()!.n) >= 10000) return conflict('归档操作数量已达到上限。');
        if (workflow && Number(db.prepare('SELECT count(*) n FROM archive_operations o JOIN execution_assets a ON o.asset_id=a.id WHERE a.draft_id=?').get(asset.draftId)!.n) >= 1000) return conflict('此草稿的归档历史已达到上限。');
        db.prepare("INSERT INTO archive_operations VALUES (?,?,?,?, 'REQUESTED',?,NULL)").run(request.id, request.rootId, asset.id, fingerprint, JSON.stringify({ request }));
        if (workflow) record(db, request.id, mediaFingerprint(['start-archive', workflow.request]), request.id);
        return required(db, request.id);
      });
    },
    operation: (id: string) => read(db => operation(db, id)),
    operations: () => read(db => db.prepare('SELECT id FROM archive_operations ORDER BY rowid').all().map(row => required(db, String(row.id)))),
    references: (id: string) => read(db => db.prepare('SELECT role,name,sha256,root_id FROM archive_references WHERE operation_id=? ORDER BY role,name').all(id)),
    attach(id: string, owned: OwnedArchiveOperation): StoredArchiveOperation {
      return transaction('archive-intent', db => {
        const op = required(db, id), request = op.request;
        if (owned.id !== id || mediaFingerprint(owned.archive) !== mediaFingerprint(root(db, request.rootId)) || mediaFingerprint(owned.files) !== mediaFingerprint(request.files) || mediaFingerprint(owned.lineage) !== mediaFingerprint(request.lineage) || owned.manifest !== archiveManifest(id, request.files, request.lineage)) return conflict('归档意图或目录身份不一致。');
        if (op.owned) { if (mediaFingerprint(op.owned) !== mediaFingerprint(owned)) return conflict('归档目录不能重新绑定。'); return op; }
        if (op.phase !== 'REQUESTED') return conflict('归档意图阶段无效。');
        db.prepare("UPDATE archive_operations SET data=?,phase='INTENT_WRITTEN',issue=NULL WHERE id=?").run(JSON.stringify({ request, owned }), id); return required(db, id);
      });
    },
    advance(id: string, next: 'STAGED' | 'VERIFIED' | 'PROMOTED'): StoredArchiveOperation {
      const previous = { STAGED: 'INTENT_WRITTEN', VERIFIED: 'STAGED', PROMOTED: 'VERIFIED' } as const;
      return transaction('advance-archive', db => advance(db, id, previous[next], next));
    },
    commit(id: string): StoredArchiveOperation {
      return transaction('commit-archive', db => {
        const op = required(db, id), request = op.request; root(db, request.rootId);
        if (op.phase === 'DB_COMMITTED' || op.phase === 'FINALIZED') return op;
        if (op.phase !== 'PROMOTED' || !op.owned || archiveDigest(op.owned.manifest) !== archiveDigest(archiveManifest(id, request.files, request.lineage))) return conflict('文件尚未验证发布，不能建立归档引用。');
        for (const file of request.files) {
          const prior = db.prepare('SELECT size FROM archive_objects WHERE root_id=? AND sha256=?').get(request.rootId, file.sha256);
          if (prior && prior.size !== file.size) return conflict('同 Hash 归档对象大小冲突。');
          db.prepare('INSERT INTO archive_objects VALUES (?,?,?) ON CONFLICT DO NOTHING').run(request.rootId, file.sha256, file.size);
          db.prepare('INSERT INTO archive_references VALUES (?,?,?,?,?)').run(id, request.rootId, file.role, file.name, file.sha256);
        }
        return advance(db, id, 'PROMOTED', 'DB_COMMITTED');
      });
    },
    finish: (id: string) => transaction('finalize-archive', db => advance(db, id, 'DB_COMMITTED', 'FINALIZED')),
    noteIssue: (id: string, issue?: StoredArchiveOperation['issue']) => transaction('archive-issue', db => { required(db, id); db.prepare('UPDATE archive_operations SET issue=? WHERE id=?').run(issue ?? null, id); }),
  };
}
export type ArchiveStore = ReturnType<typeof createArchiveStore>;
