import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CollectionRepository } from './repository.js';
import { authorizeSourceDirectory, type RootCapability } from '../recording/source-files.js';
import { sourceFingerprint, type SourceRemountReauthorization } from '../recording/source-store.js';
import { sourceRemountProofMatchesRoot } from '../recording/source-remount-proof.js';
import { observeSourceSmbMountEvidence, isSourceSmbMountEvidence, type SourceSmbMountEvidence } from '../recording/source-smb-mount-evidence.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { captureLocalCatalogAuditState, restoreLocalCatalogAuditState, clearLocalCatalogAuditState,
  verifyLocalCatalogDatabase, commitLocalCatalogStartupAudit } from './local-catalog-store.js';
import { captureLocalScanAuditState, restoreLocalScanAuditState, clearLocalScanAuditState, verifyLocalScanDatabase } from './local-scan-store.js';
import { currentLocalAuditWritePoint } from './local-audit-write-observer.js';
import { currentScanOriginIndex, publishScanOriginIndex } from './local-scan-origin-index.js';

/** 仅Core自有合成目录测试注入kernel证据；不是公开IPC或环境中的授权入口。 */
export interface LocalLibrarySourceRemountRecoveryDependencies {
  observeMount?(root: RootCapability): Promise<SourceSmbMountEvidence>;
  verifyCatalog?: typeof verifyLocalCatalogDatabase;
  verifyScan?: typeof verifyLocalScanDatabase;
}
export interface LocalLibrarySourceRemountRecoveryResult {
  checked: number; recovered: number; skipped: number; failed: number;
  audit: 'unchanged' | 'reused' | 'rechecked';
}
function readPoint(db: DatabaseSync) {
  const point = { changes: db.prepare('SELECT total_changes() n').get()?.n,
    version: db.prepare('PRAGMA data_version').get()?.data_version, schema: db.prepare('PRAGMA schema_version').get()?.schema_version,
    tempSchema: db.prepare('PRAGMA temp.schema_version').get()?.schema_version,
    foreignKeys: db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, readonly: db.prepare('PRAGMA query_only').get()?.query_only };
  if (db.isTransaction || !Object.values(point).every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || point.foreignKeys !== 1 || point.readonly !== 0) throw new Error('共享盘冷恢复的数据库水位或写入约束已改变。');
  return point as { [K in keyof typeof point]: number };
}
function samePoint(before: ReturnType<typeof readPoint>, after: ReturnType<typeof readPoint>, writes = 0): boolean {
  return after.changes === before.changes + writes && after.version === before.version && after.schema === before.schema
    && after.tempSchema === before.tempSchema && after.foreignKeys === before.foreignKeys && after.readonly === before.readonly;
}

/** 只在Owner交付前、任何Source服务/FD构造前调用；原根身份和全部目录历史保留。 */
export async function recoverLocalLibrarySourceRemounts(collection: CollectionRepository, assertCurrent: () => void,
  dependencies: LocalLibrarySourceRemountRecoveryDependencies = {}): Promise<LocalLibrarySourceRemountRecoveryResult> {
  assertCurrent();
  const db = collection.localCatalog.privateRead(database => database), roots = collection.localCatalog.roots().filter(root => root.role === 'library');
  const result: LocalLibrarySourceRemountRecoveryResult = { checked: roots.length, recovered: 0, skipped: 0, failed: 0, audit: 'unchanged' };
  const candidates: SourceRemountReauthorization[] = [], seen = new Set<string>();
  for (const root of roots) {
    assertCurrent();
    try {
      if (seen.has(root.sourceRootId)) { result.skipped++; continue; }
      seen.add(root.sourceRootId);
      const captured = collection.sources.root(root.sourceRootId);
      if (!captured.authorized || captured.id !== root.sourceRootId
        || captured.readonlyRemountProof !== undefined && !sourceRemountProofMatchesRoot(captured)) { result.skipped++; continue; }
      const directory = await authorizeSourceDirectory(captured.path); assertCurrent();
      // 显示名不是目录物理身份；恢复保留原授权的自定义label，不以basename覆盖。
      const current: RootCapability = { ...directory, id: captured.id, label: captured.label };
      if (current.path !== captured.path || current.ino !== captured.ino || current.dev === captured.dev) { result.skipped++; continue; }
      const evidence = await (dependencies.observeMount ?? observeSourceSmbMountEvidence)(current); assertCurrent();
      if (!isSourceSmbMountEvidence(evidence) || captured.readonlyRemountProof?.version === 2
        && captured.readonlyRemountProof.mountSourceSha256 !== evidence.mountSourceSha256) { result.skipped++; continue; }
      const checked = await authorizeSourceDirectory(captured.path); assertCurrent();
      if (sourceFingerprint(checked) !== sourceFingerprint(directory)) { result.skipped++; continue; }
      const actualRoot = collection.localCatalog.root(root.id);
      if (actualRoot.role !== 'library' || actualRoot.revision !== root.revision || actualRoot.sourceRootId !== root.sourceRootId) { result.skipped++; continue; }
      candidates.push({ commandId: randomUUID(), captured, current, evidenceSha256: evidence.mountEvidenceSha256, mountSourceSha256: evidence.mountSourceSha256 });
    } catch { assertCurrent(); result.failed++; }
  }
  if (!candidates.length) return result;
  assertCurrent();
  const before = readPoint(db), catalog = captureLocalCatalogAuditState(db), scan = captureLocalScanAuditState(db);
  const catalogWrites = currentLocalAuditWritePoint(db, 'catalog'), scanWrites = currentLocalAuditWritePoint(db, 'scan');
  const captured = !!catalog && !!scan && !!catalogWrites && !!scanWrites && samePoint(before, readPoint(db));
  const completed: Array<{ candidate: SourceRemountReauthorization; root: RootCapability }> = [];
  // 以下区间没有await：只有原SourceStore两行事务，任何额外SQL变化都会使纯审计续接失败。
  for (const candidate of candidates) {
    assertCurrent();
    try {
      const root = collection.sources.privateReauthorizeRemounts([candidate])[0];
      if (!root) throw new Error('原Source恢复事务缺少原根回执。');
      completed.push({ candidate, root }); result.recovered++;
    }
    catch (error) { if (error instanceof LocalFactsCommitFatal) throw error; assertCurrent(); result.failed++; }
  }
  const after = readPoint(db), currentCatalogWrites = currentLocalAuditWritePoint(db, 'catalog'), currentScanWrites = currentLocalAuditWritePoint(db, 'scan');
  const writes = result.recovered * 2;
  const sourceRowsMatch = completed.every(({ candidate, root }) => {
    const row = db.prepare('SELECT fingerprint,result FROM source_ledger WHERE command_id=?').get(candidate.commandId);
    return sourceFingerprint(collection.sources.root(root.id)) === sourceFingerprint(root) && row?.result === root.id
      && row.fingerprint === sourceFingerprint(['reauthorize-remount', candidate.captured, root]);
  });
  const unchangedDomains = captured && samePoint(before, after, writes)
    && sourceRowsMatch && !!currentCatalogWrites && !!currentScanWrites
    && currentCatalogWrites.owner === catalogWrites!.owner && currentCatalogWrites.writes === catalogWrites!.writes + writes
    && currentScanWrites.owner === scanWrites!.owner && currentScanWrites.writes === scanWrites!.writes;
  if (unchangedDomains && restoreLocalCatalogAuditState(db, catalog) && restoreLocalScanAuditState(db, scan)
    && samePoint(after, readPoint(db))) { result.audit = 'reused'; return result; }
  // 未知前缀、额外触发器/写入、回滚或版本变化只能重走完整核验，不能借Source事务洗白。
  clearLocalCatalogAuditState(db); clearLocalScanAuditState(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    (dependencies.verifyCatalog ?? verifyLocalCatalogDatabase)(db, assertCurrent);
    (dependencies.verifyScan ?? verifyLocalScanDatabase)(db, assertCurrent);
    const origins = currentScanOriginIndex(db, true);
    commitLocalCatalogStartupAudit(db);
    if (origins) publishScanOriginIndex(db, origins);
    result.audit = 'rechecked';
    return result;
  } catch (error) {
    clearLocalCatalogAuditState(db); clearLocalScanAuditState(db);
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
