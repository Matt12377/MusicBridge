import type { MobileSealedState } from './types.js';

/** 仅现有Main/Owner/codec私有端口使用；不增加公开HTTP或Renderer合同。 */
export const PLAYBACK_HISTORY_HEAD_SCHEMA = 'musicbridge.playback-history-head.v1';
export const PLAYBACK_HISTORY_LOCATOR_SCHEMA = 'musicbridge.playback-history-locator.v1';
export const PLAYBACK_HISTORY_MAX_PROOF_NODES = 257;
export const PLAYBACK_HISTORY_MAX_PROOF_BYTES = 128 * 1024;
export const PLAYBACK_HISTORY_MAX_STAGE_BYTES = 256 * 1024;
export const PLAYBACK_HISTORY_MAX_STAGE_NODES = 256;
export const PLAYBACK_HISTORY_MAX_STAGE_LOCATORS = 64;

export type PlaybackHistoryRecordKind = 'receipt' | 'session' | 'resource';
/** 所有digest均为64位小写hex；null只表示经过认证的空树。 */
export type PlaybackHistoryRoot = string | null;
export type PlaybackHistoryNode =
  | Readonly<{ kind: 'leaf'; key: string; valueHash: string }>
  | Readonly<{ kind: 'branch'; bit: number; zero: string; one: string }>;
export interface PlaybackHistoryNodeRecord { readonly hash: string; readonly node: PlaybackHistoryNode }

/** token只是CAS围栏；Main必须另开AEAD head核验其中全部字段。 */
export interface PlaybackHistoryHeadToken {
  readonly authority: 'legacy' | 'journal';
  readonly storeId: string | null;
  readonly revision: number;
  readonly commitId: string | null;
  readonly hotSha256: string | null;
  readonly headSha256: string | null;
  readonly indexRoot: PlaybackHistoryRoot;
}
export interface PlaybackHistoryAuthenticatedHead {
  readonly schema: typeof PLAYBACK_HISTORY_HEAD_SCHEMA;
  readonly serverId: string;
  readonly datasetId: string;
  readonly storeId: string;
  readonly revision: number;
  readonly commitId: string | null;
  readonly hotSha256: string;
  readonly indexRoot: PlaybackHistoryRoot;
  /** 原sealed文件的整文件SHA；原件只读保留，不能作为新作者的自动回退。 */
  readonly legacyFileSha256: string | null;
}
export interface PlaybackHistorySnapshotIdentity {
  readonly revision: number;
  readonly commitId: string;
  readonly hotSha256: string;
}
export interface PlaybackHistoryAuthenticatedLocator {
  readonly schema: typeof PLAYBACK_HISTORY_LOCATOR_SCHEMA;
  readonly serverId: string;
  readonly datasetId: string;
  readonly kind: PlaybackHistoryRecordKind;
  readonly key: string;
  readonly archiveId: string;
  readonly snapshot: PlaybackHistorySnapshotIdentity;
  readonly sessionId: string;
  readonly recordId: string;
}
/** Owner只持密文及非授权hint；Main开locator后必须交叉核对archiveId。 */
export interface PlaybackHistorySealedLocator {
  readonly valueHash: string;
  readonly archiveId: string;
  readonly sealed: Uint8Array;
}
export interface PlaybackHistoryArchive {
  readonly id: string;
  readonly snapshot: PlaybackHistorySnapshotIdentity;
  /** 原已ACK热密文原字节，不重组或恢复其中其他session组。 */
  readonly sealed: Uint8Array;
}
export interface PlaybackHistoryArchiveCurrent {
  readonly id: string;
  readonly snapshot: PlaybackHistorySnapshotIdentity;
  readonly sessionIds: readonly string[];
}
export interface PlaybackHistoryNextHead {
  readonly token: PlaybackHistoryHeadToken;
  readonly sealedHead: Uint8Array;
  readonly hot: Readonly<{ kind: 'reuse-current' }> | Readonly<{ kind: 'sealed'; sealed: Uint8Array }>;
}
/** 新journal可认证revision0空热状态；不放宽原legacy sealed文件的revision>=1规则。 */
export type PlaybackHistoryHotState = MobileSealedState
  | Readonly<{ kind: 'sealed'; datasetId: string; revision: 0; commitId: null; sealed: Uint8Array }>;
interface PlaybackHistoryRequestScope { readonly serverId: string; readonly datasetId: string }
export type PlaybackHistoryRequest = PlaybackHistoryRequestScope & (
  | Readonly<{ op: 'load' }>
  | Readonly<{ op: 'lookup'; expected: PlaybackHistoryHeadToken; key: string }>
  | Readonly<{ op: 'stage'; expected: PlaybackHistoryHeadToken; attemptId: string;
      nodes: readonly PlaybackHistoryNodeRecord[]; locators: readonly PlaybackHistorySealedLocator[] }>
  | Readonly<{ op: 'commit'; expected: PlaybackHistoryHeadToken; attemptId: string;
      mode: 'activate' | 'advance'; next: PlaybackHistoryNextHead; archiveCurrent: PlaybackHistoryArchiveCurrent | null }>
  | Readonly<{ op: 'read-commit'; expected: PlaybackHistoryHeadToken; attemptId: string; next: PlaybackHistoryHeadToken }>
);
export type PlaybackHistoryReply =
  | Readonly<{ kind: 'loaded'; token: PlaybackHistoryHeadToken; hot: PlaybackHistoryHotState;
      sealedHead: Uint8Array | null; legacyFileSha256: string | null }>
  | Readonly<{ kind: 'proof'; token: PlaybackHistoryHeadToken; key: string;
      proof: readonly PlaybackHistoryNodeRecord[];
      locator: PlaybackHistorySealedLocator | null; archive: PlaybackHistoryArchive | null }>
  | Readonly<{ kind: 'staged'; token: PlaybackHistoryHeadToken; attemptId: string }>
  | Readonly<{ kind: 'committed'; token: PlaybackHistoryHeadToken; attemptId: string }>
  | Readonly<{ kind: 'unconfirmed'; token: PlaybackHistoryHeadToken; attemptId: string }>
  | Readonly<{ kind: 'conflict'; token: PlaybackHistoryHeadToken }>;

/** 任意异常都不得解释成absence；丢ACK仅用原attempt的read-commit对账。 */
export interface MobilePlaybackHistoryPort {
  dispatch(request: Readonly<PlaybackHistoryRequest>): Promise<PlaybackHistoryReply>;
}
