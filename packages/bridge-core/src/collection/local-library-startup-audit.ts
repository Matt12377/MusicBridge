import type { DatabaseSync } from 'node:sqlite';
import { clearLocalCatalogAuditState, verifyLocalCatalogDatabase } from './local-catalog-store.js';
import { clearLocalScanAuditState, verifyLocalScanStartupTransaction } from './local-scan-store.js';
import { restoreLocalAlbumStartupState } from './local-album-browser/sql-read.js';
import { restoreLocalStartupAuditCache, type PreparedLocalStartupAudit } from './local-startup-audit-cache.js';

type Stage = <T>(name: 'catalog' | 'scan', operation: () => T) => T;

/**
 * 原 Owner 启动事务内的成对历史核验。恢复缓存必须先由原内容/实现身份读口
 * 取得候选；miss 则完整核验两域。这里不提交、不恢复Source许可、不宣告Core
 * 就绪；关键恢复、原事务COMMIT与Owner交付仍由repository原启动作者负责。
 */
export function runLocalLibraryStartupAudit(options: {
  db: DatabaseSync;
  filePath: string;
  candidate?: PreparedLocalStartupAudit;
  stage?: Stage;
}): boolean {
  const { db, filePath, candidate } = options;
  const stage: Stage = options.stage ?? ((_name, operation) => operation());
  try {
    if (!db.isTransaction) throw new Error('启动历史核验缺少原保护事务。');
    if (restoreLocalStartupAuditCache(db, filePath, candidate)) return true;
    stage('catalog', () => verifyLocalCatalogDatabase(db));
    stage('scan', () => verifyLocalScanStartupTransaction(db));
    return false;
  } catch (error) {
    // 不能把“目录已核、扫描历史失败”暴露为部分就绪；清除两域的派生证明。
    clearLocalCatalogAuditState(db);
    clearLocalScanAuditState(db);
    restoreLocalAlbumStartupState(db, undefined);
    throw error;
  }
}
