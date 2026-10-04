import { isCollectionId } from './collection.js';
import {
  isLocalCatalogRevision,
  isLocalCatalogText,
  isLocalExactInteger,
  isLocalTrackSegment,
  type LocalCatalogRevision,
  type LocalTrackSegment,
} from './local-catalog.js';

/** 持久记录合同；不创建服务、写命令或第二份实体权威。 */
export type ScanJobPhase = 'pending' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
export type ScanJobFailureCode = 'ROOT_UNAVAILABLE' | 'ROOT_REVISION_CHANGED' | 'SCAN_READ_FAILED' | 'CHECKPOINT_INVALID';
export interface ScanJobProgress {
  /** 已访问候选数；运行中允许尚未分类的候选。 */
  visited: string;
  accepted: string;
  rejected: string;
}
export interface ScanJobRecord {
  schemaVersion: '1.2';
  jobId: string;
  datasetId: string;
  libraryRootId: string;
  sourceRootId: string;
  rootRevision: LocalCatalogRevision;
  jobRevision: LocalCatalogRevision;
  /** 指向 owner 私有 checkpoint 的 opaque UUID，不是路径或恢复授权。 */
  checkpointRef: string | null;
  progress: ScanJobProgress;
  phase: ScanJobPhase;
  failureCode: ScanJobFailureCode | null;
}

export interface LocalQueueSourceSnapshot {
  sourceKind: 'local_file';
  trackId: string;
  assetId: string;
  libraryRootId: string;
  sourceRootId: string;
  rootRevision: LocalCatalogRevision;
  fileRevision: LocalCatalogRevision;
  locationRevision: LocalCatalogRevision;
  selectionRevision: LocalCatalogRevision;
  segment: LocalTrackSegment | null;
}
/** Core/Zone 的持久目标意图；不代表当前选中对象、权限或会话确认。 */
export interface LocalQueueTargetIntent { coreId: string; zoneId: string }
export interface LocalQueueRestartPolicy { reResolve: true; autoplay: false }
export interface LocalMBQueueEntryRecord {
  schemaVersion: '1.2';
  datasetId: string;
  /** 三种身份分别分配；entryId 不从 trackId 或原生 Roon queue ID 推导。 */
  entryId: string;
  queueId: string;
  queueRevision: LocalCatalogRevision;
  entryRevision: LocalCatalogRevision;
  /** 无损的零基顺序槽位；重排由原 owner 更新修订，不在 DTO 中分配 counter。 */
  orderIndex: string;
  localSourceSnapshot: LocalQueueSourceSnapshot;
  target: LocalQueueTargetIntent | null;
  restartPolicy: LocalQueueRestartPolicy;
}

/** 原任务语义名的明确对应；此别名只覆盖本地条目，不替换旧远端队列合同。 */
export type ScanJob = ScanJobRecord;
export type LocalMBQueueEntry = LocalMBQueueEntryRecord;
export type MBQueueEntry = LocalMBQueueEntryRecord;

const record = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
};
const closed = (v: Record<string, unknown>, required: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(v);
  return actual.length === required.length
    && actual.every(k => typeof k === 'string' && required.includes(k)
      && Object.prototype.propertyIsEnumerable.call(v, k))
    && required.every(k => Object.hasOwn(v, k));
};
const phase = (v: unknown): v is ScanJobPhase =>
  v === 'pending' || v === 'running' || v === 'paused' || v === 'cancelled' || v === 'completed' || v === 'failed';
const failure = (v: unknown): v is ScanJobFailureCode =>
  v === 'ROOT_UNAVAILABLE' || v === 'ROOT_REVISION_CHANGED' || v === 'SCAN_READ_FAILED' || v === 'CHECKPOINT_INVALID';

export function isScanJobRecord(v: unknown): v is ScanJobRecord {
  if (!record(v) || !closed(v, ['schemaVersion', 'jobId', 'datasetId', 'libraryRootId', 'sourceRootId',
    'rootRevision', 'jobRevision', 'checkpointRef', 'progress', 'phase', 'failureCode'])
    || v.schemaVersion !== '1.2' || !isCollectionId(v.jobId) || !isCollectionId(v.datasetId)
    || !isCollectionId(v.libraryRootId) || !isCollectionId(v.sourceRootId)
    || !isLocalCatalogRevision(v.rootRevision) || !isLocalCatalogRevision(v.jobRevision)
    || !(v.checkpointRef === null || isCollectionId(v.checkpointRef)) || !phase(v.phase)
    || !record(v.progress) || !closed(v.progress, ['visited', 'accepted', 'rejected'])
    || !isLocalExactInteger(v.progress.visited) || !isLocalExactInteger(v.progress.accepted)
    || !isLocalExactInteger(v.progress.rejected)) return false;
  const visited = BigInt(v.progress.visited);
  const classified = BigInt(v.progress.accepted) + BigInt(v.progress.rejected);
  if (classified > visited) return false;
  if (v.phase === 'pending' && (visited !== 0n || v.checkpointRef !== null)) return false;
  if (v.phase === 'completed' && classified !== visited) return false;
  return v.phase === 'failed' ? failure(v.failureCode) : v.failureCode === null;
}

/** 先限制 UTF-16 长度，再处理 Unicode；不接受 locator 或凭据形式的文本。 */
const targetId = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 512) return false;
  if (!isLocalCatalogText(v) || v !== v.trim() || /[\/\\]/u.test(v)) return false;
  const points = Array.from(v);
  return points.length <= 256 && points.every(p => {
    const cp = p.codePointAt(0)!;
    return cp < 0xd800 || cp > 0xdfff;
  });
};
export function isLocalQueueTargetIntent(v: unknown): v is LocalQueueTargetIntent {
  return record(v) && closed(v, ['coreId', 'zoneId']) && targetId(v.coreId) && targetId(v.zoneId);
}
export function isLocalQueueSourceSnapshot(v: unknown): v is LocalQueueSourceSnapshot {
  return record(v) && closed(v, ['sourceKind', 'trackId', 'assetId', 'libraryRootId', 'sourceRootId',
    'rootRevision', 'fileRevision', 'locationRevision', 'selectionRevision', 'segment'])
    && v.sourceKind === 'local_file' && isCollectionId(v.trackId) && isCollectionId(v.assetId)
    && isCollectionId(v.libraryRootId) && isCollectionId(v.sourceRootId)
    && isLocalCatalogRevision(v.rootRevision) && isLocalCatalogRevision(v.fileRevision)
    && isLocalCatalogRevision(v.locationRevision) && isLocalCatalogRevision(v.selectionRevision)
    && (v.segment === null || record(v.segment) && closed(v.segment, ['id', 'startFrame', 'endFrameExclusive', 'timebaseHz'])
      && isLocalTrackSegment(v.segment));
}
export function isLocalMBQueueEntryRecord(v: unknown): v is LocalMBQueueEntryRecord {
  return record(v) && closed(v, ['schemaVersion', 'datasetId', 'entryId', 'queueId', 'queueRevision',
    'entryRevision', 'orderIndex', 'localSourceSnapshot', 'target', 'restartPolicy'])
    && v.schemaVersion === '1.2' && isCollectionId(v.datasetId) && isCollectionId(v.entryId)
    && isCollectionId(v.queueId) && isLocalCatalogRevision(v.queueRevision)
    && isLocalCatalogRevision(v.entryRevision) && isLocalExactInteger(v.orderIndex)
    && isLocalQueueSourceSnapshot(v.localSourceSnapshot)
    && (v.target === null || isLocalQueueTargetIntent(v.target))
    && record(v.restartPolicy) && closed(v.restartPolicy, ['reResolve', 'autoplay'])
    && v.restartPolicy.reResolve === true && v.restartPolicy.autoplay === false;
}
export const isScanJob = isScanJobRecord;
export const isLocalMBQueueEntry = isLocalMBQueueEntryRecord;
export const isMBQueueEntry = isLocalMBQueueEntryRecord;
