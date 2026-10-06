import type {MBQueueLoadResult} from './mb-queue-owner-types.js';
import type { DatabaseSync } from 'node:sqlite';
import { isMBQueueRecord, isMBQueueSaveRequest, type MBQueueRecord, type MBQueueSaveRequest } from '@music-bridge/contracts';

const table = 'CREATE TABLE mb_playback_queue(slot INTEGER PRIMARY KEY CHECK(slot=1),dataset_id TEXT NOT NULL,queue_id TEXT NOT NULL,revision TEXT NOT NULL,data TEXT NOT NULL) STRICT';
export const mbQueueMigration = table + '; PRAGMA user_version=33;';
export class MBQueueStoreError extends Error {
  constructor(readonly code: 'QUEUE_INVALID' | 'QUEUE_CONFLICT' | 'QUEUE_COMMIT_UNKNOWN') { super(code); }
}
export interface MBQueueStore { load(datasetId: string): MBQueueLoadResult; save(request: MBQueueSaveRequest): MBQueueRecord }
function readQueue(db: DatabaseSync): MBQueueRecord | null {
  const row = db.prepare('SELECT * FROM mb_playback_queue WHERE slot=1').get();
  if (!row) return null;
  let queue: unknown; try { queue = JSON.parse(String(row.data)); } catch { throw new MBQueueStoreError('QUEUE_INVALID'); }
  if (!isMBQueueRecord(queue) || queue.datasetId !== row.dataset_id || queue.queueId !== row.queue_id || queue.revision !== row.revision) throw new MBQueueStoreError('QUEUE_INVALID');
  return queue;
}
export function verifyMBQueueDatabase(db: DatabaseSync,verifyContent=true): void {
  if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mb_playback_queue'").get()?.sql !== table) throw new MBQueueStoreError('QUEUE_INVALID');
  if (db.prepare('SELECT slot FROM mb_playback_queue WHERE slot<>1 LIMIT 1').get()) throw new MBQueueStoreError('QUEUE_INVALID');
  if(verifyContent)readQueue(db);
}
/** 共享业务连接的独立CAS；队列写不撤销无关音频事实票据。 */
export function createMBQueueStore(options: { read: <T>(fn: (db: DatabaseSync) => T) => T; beforeCommit?: (operation: string) => void; onFatal: () => void }): MBQueueStore {
  return {
    load(datasetId) { return options.read(db => {
      let queue:MBQueueRecord|null;try{queue=readQueue(db);}catch(error){if(error instanceof MBQueueStoreError&&error.code==='QUEUE_INVALID')return {status:'UNAVAILABLE' as const};throw error;}if(!queue)return null;
      if(queue.datasetId!==datasetId)return {status:'NEEDS_REVIEW' as const,queueId:queue.queueId,revision:queue.revision};return queue;
    }); },
    save(request) {
      if (!isMBQueueSaveRequest(request)) throw new MBQueueStoreError('QUEUE_INVALID');
      return options.read(db => {
        db.exec('BEGIN IMMEDIATE'); let committing = false;
        try {
          const old = readQueue(db);
          if ((old?.revision ?? '0') !== request.expectedRevision || old && (old.datasetId !== request.queue.datasetId && old.queueId === request.queue.queueId)) throw new MBQueueStoreError('QUEUE_CONFLICT');
          db.prepare('INSERT INTO mb_playback_queue(slot,dataset_id,queue_id,revision,data) VALUES(1,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET dataset_id=excluded.dataset_id,queue_id=excluded.queue_id,revision=excluded.revision,data=excluded.data')
            .run(request.queue.datasetId, request.queue.queueId, request.queue.revision, JSON.stringify(request.queue));
          options.beforeCommit?.('save-mb-queue'); committing = true; db.exec('COMMIT');
          return structuredClone(request.queue);
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { options.onFatal(); throw new MBQueueStoreError('QUEUE_COMMIT_UNKNOWN'); }
          if (committing) { options.onFatal(); throw new MBQueueStoreError('QUEUE_COMMIT_UNKNOWN'); }
          throw error;
        }
      });
    },
  };
}
