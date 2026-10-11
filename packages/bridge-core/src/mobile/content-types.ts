import {
  isMobileId, mobileDataSnapshot, mobileInteger, mobileRecord,
} from '@music-bridge/contracts';
import type {
  MobileCodecLimits, MobileContentReadContext, MobileRequestMap, MobileResponseBody, MobileSource,
  MobileTrack, MobileUIAlbumRecord,
} from '@music-bridge/contracts';
import { MobileServiceError } from './content-errors.js';

/** 只列既有十九操作；真实装载及能力声明留给可信组合根。 */
export const MOBILE_CONTENT_OPERATIONS = [
  'listRecentlyAddedAlbums', 'getNeteaseDailyRecommendations', 'getExactTrackLyrics',
  'getNeteaseLikedPlaylist', 'listNeteaseLikedPlaylistTracks', 'listFavoriteAlbums',
  'getFavoriteAlbumState', 'setAlbumFavorite', 'listFavoriteAlbumTracks', 'setTrackFavorite',
  'listPersonalPlaylists', 'createPersonalPlaylist', 'listPersonalPlaylistTracks',
  'addPersonalPlaylistTrack', 'listNeteaseRecommendedPlaylists', 'listNeteaseNewAlbums',
  'listNeteaseCharts', 'getNeteaseDiscoveryCollectionTracks', 'getNeteasePersonalFM',
] as const;
export type MobileContentOperation = typeof MOBILE_CONTENT_OPERATIONS[number];
export const MOBILE_CONTENT_MUTATIONS = [
  'setAlbumFavorite', 'setTrackFavorite', 'createPersonalPlaylist', 'addPersonalPlaylistTrack',
] as const;
export type MobileContentMutationOperation = typeof MOBILE_CONTENT_MUTATIONS[number];

/** 这是私有数据围栏，不能替代 Main 原有的 branded auth principal。 */
export interface MobileContentScope {
  serverId: string;
  datasetId: string;
  deviceId: string;
  deviceEpoch: number;
  accessGeneration: number;
  ownerEpoch: string;
  accountDomain: string;
  providerEpoch: string | null;
}
export const MOBILE_CONTENT_SCOPE_KEYS = [
  'serverId', 'datasetId', 'deviceId', 'deviceEpoch', 'accessGeneration',
  'ownerEpoch', 'accountDomain', 'providerEpoch',
] as const;

export function captureMobileContentScope(raw: unknown): Readonly<MobileContentScope> {
  const result = mobileDataSnapshot(raw);
  if (!result.ok || !mobileRecord(result.value)) throw new MobileServiceError(400, 'INVALID_REQUEST');
  const value = result.value;
  if (Reflect.ownKeys(value).length !== MOBILE_CONTENT_SCOPE_KEYS.length
    || !MOBILE_CONTENT_SCOPE_KEYS.every(key => Object.hasOwn(value, key))
    || !['serverId', 'datasetId', 'deviceId', 'ownerEpoch', 'accountDomain'].every(key => isMobileId(value[key]))
    || !mobileInteger(value.deviceEpoch, 1) || !mobileInteger(value.accessGeneration, 1)
    || value.providerEpoch !== null && !isMobileId(value.providerEpoch)) {
    throw new MobileServiceError(400, 'INVALID_REQUEST');
  }
  return Object.freeze(value as unknown as MobileContentScope);
}

export function isMobileContentOperation(value: unknown): value is MobileContentOperation {
  return typeof value === 'string' && (MOBILE_CONTENT_OPERATIONS as readonly string[]).includes(value);
}
export function isMobileContentMutation(value: unknown): value is MobileContentMutationOperation {
  return typeof value === 'string' && (MOBILE_CONTENT_MUTATIONS as readonly string[]).includes(value);
}

export interface MobileContentPageScope {
  scope: Readonly<MobileContentScope>;
  operation: MobileContentOperation;
  source: MobileSource | 'all';
  parentId: string | null;
  kind: 'playlist' | 'chart' | null;
  filterHash: string;
  sort: string;
  limit: number;
}
export interface MobileContentServiceInput<O extends MobileContentOperation = MobileContentOperation> {
  operation: O;
  request: MobileRequestMap[O];
  scope: Readonly<MobileContentScope>;
  signal: AbortSignal;
}
export type MobileContentSuccessReply<O extends MobileContentOperation> =
  { status: number; category: 'success'; body: MobileResponseBody<O> };
export interface MobileContentSnapshot<O extends MobileContentOperation = MobileContentOperation> {
  operation: O;
  scope: Readonly<MobileContentScope>;
  reply: MobileContentSuccessReply<O>;
  /** 上下文由可信端口给出，不能从 reply.body 自行签发。 */
  context: MobileContentReadContext;
  beforeSend(): Promise<void>;
}
export interface MobileContentPort {
  dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>): Promise<MobileContentSnapshot<O>>;
}
export interface MobileContentMutationInput<O extends MobileContentMutationOperation = MobileContentMutationOperation> {
  operation: O;
  request: MobileRequestMap[O];
  scope: Readonly<MobileContentScope>;
}
/** 必须在原精确来源端口核验过的元数据；纯状态模块不猜所属专辑。 */
export interface MobileContentMutationFacts {
  album?: MobileUIAlbumRecord;
  track?: MobileTrack;
}
/** 内部容量显式注入，避免把客户端分页上限当作后端库上限。 */
export interface MobileContentStateLimits {
  stateBytes: number;
  receipts: number;
  albums: number;
  favoriteTracks: number;
  playlists: number;
  playlistTracks: number;
}

export interface MobileContentCodecOptions {
  limits?: MobileCodecLimits;
}
