import { ArchiveFileError, createArchiveOperation, stageArchiveOperation, verifyArchiveStaging, promoteArchiveOperation, verifyArchiveObjects, finalizeArchiveOperation, markArchivePhase, checkArchiveRoot, type ArchiveFilePhase } from './archive-files.js';
import type { ArchiveStore, StoredArchiveOperation } from './archive-store.js';
import type { copyReadonlySource } from './source-files.js';

// 同一 Core 中多个调用者共享 Root 串行队列；文件排他发布仍拒绝外部覆盖。
const rootTails = new Map<string, Promise<unknown>>();
interface Dependencies {
  store: ArchiveStore; copy?: typeof copyReadonlySource; availableBytes?: () => Promise<bigint>;
  afterPhase?: (phase: ArchiveFilePhase) => Promise<void>;
}
export function createArchiveTransactionRunner({ store, copy, availableBytes, afterPhase }: Dependencies) {
  async function execute(id: string, signal: AbortSignal): Promise<StoredArchiveOperation> {
    try {
      let op = store.operation(id); if (!op) throw new ArchiveFileError('ARCHIVE_INPUT_INVALID');
      signal.throwIfAborted(); await checkArchiveRoot(store.root(op.request.rootId));
      const checkpoint = async (phase: ArchiveFilePhase): Promise<void> => { signal.throwIfAborted(); store.root(op!.request.rootId); await afterPhase?.(phase); };
      if (op.phase === 'REQUESTED') {
        const owned = await createArchiveOperation(store.root(op.request.rootId), id, op.request.files, op.request.lineage);
        op = store.attach(id, owned); await checkpoint('INTENT_WRITTEN');
      }
      if (!op.owned) throw new ArchiveFileError('ARCHIVE_RECOVERY_REQUIRED');
      const owned = op.owned;
      if (op.phase === 'INTENT_WRITTEN') {
        await stageArchiveOperation(owned, signal, { ...(copy ? { copy } : {}), ...(availableBytes ? { availableBytes } : {}) });
        op = store.advance(id, 'STAGED'); await checkpoint('STAGED');
      }
      if (op.phase === 'STAGED') { await verifyArchiveStaging(owned, signal); op = store.advance(id, 'VERIFIED'); await checkpoint('VERIFIED'); }
      if (op.phase === 'VERIFIED') { await promoteArchiveOperation(owned, signal); op = store.advance(id, 'PROMOTED'); await checkpoint('PROMOTED'); }
      if (op.phase === 'PROMOTED') { await verifyArchiveObjects(owned, signal); signal.throwIfAborted(); op = store.commit(id); await markArchivePhase(owned, 'DB_COMMITTED'); await checkpoint('DB_COMMITTED'); }
      if (op.phase === 'DB_COMMITTED') { await markArchivePhase(owned, 'DB_COMMITTED'); await finalizeArchiveOperation(owned, signal); op = store.finish(id); await checkpoint('FINALIZED'); }
      // 历史 FINALIZED 不是“现在仍可用”的证明；恢复巡检必须重读所有引用对象。
      await verifyArchiveObjects(owned, signal); store.noteIssue(id); return store.operation(id)!;
    } catch (error) {
      const issue = signal.aborted ? 'CANCELLED' : error instanceof ArchiveFileError && (error.code === 'ARCHIVE_ROOT_INVALID' || error.code === 'ARCHIVE_DISK_FULL') ? error.code : 'ARCHIVE_RECOVERY_REQUIRED';
      try { store.noteIssue(id, issue); } catch { /* 留下最初故障；不伪称故障标记已提交。 */ }
      throw error;
    }
  }
  function run(id: string, signal: AbortSignal = new AbortController().signal): Promise<StoredArchiveOperation> {
    const op = store.operation(id); if (!op) return Promise.reject(new ArchiveFileError('ARCHIVE_INPUT_INVALID'));
    let key: string;
    try { key = store.root(op.request.rootId).root.path; }
    catch {
      try { store.noteIssue(id, 'ARCHIVE_ROOT_INVALID'); } catch { /* 不覆盖首次归档授权错误。 */ }
      return Promise.reject(new ArchiveFileError('ARCHIVE_ROOT_INVALID'));
    }
    const previous = rootTails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => execute(id, signal)); rootTails.set(key, task);
    void task.finally(() => { if (rootTails.get(key) === task) rootTails.delete(key); }).catch(() => undefined); return task;
  }
  return {
    run,
    async recover(): Promise<readonly { id: string; available: boolean }[]> {
      const results: { id: string; available: boolean }[] = [];
      for (const op of store.operations()) {
        if (op.issue === 'CANCELLED' && op.phase !== 'DB_COMMITTED' && op.phase !== 'FINALIZED') { results.push({ id: op.request.id, available: false }); continue; }
        try { await run(op.request.id); results.push({ id: op.request.id, available: true }); } catch { results.push({ id: op.request.id, available: false }); }
      }
      return results;
    },
  };
}
