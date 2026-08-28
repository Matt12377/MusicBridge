import type { ReplicaIssue, ReplicaRunReason } from '@music-bridge/contracts';

export type RecordingReplicaErrorCode = ReplicaIssue | ReplicaRunReason | 'INVALID_REQUEST' | 'RUN_CONFLICT' | 'RUN_LIMIT' | 'READ_CONFLICT' | 'READ_LIMIT' | 'NOT_FOUND';

/** 只携带有限领域码；不把路径、原生异常或内部栈当作公开错误。 */
export class RecordingReplicaError extends Error {
  constructor(readonly code: RecordingReplicaErrorCode) { super(`历史音频操作未完成，请核实原档案与授权。[${code}]`); }
}
export function replicaFail(code: RecordingReplicaErrorCode): never { throw new RecordingReplicaError(code); }
