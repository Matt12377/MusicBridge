import { createHash } from 'node:crypto';
import {
  MOBILE_CATALOG_SCHEMAS, MOBILE_CONTENT_SCHEMAS, encodeMobileRequest, isMobileId,
  mapMobilePersonalPlaylistDraft, mobileCanonicalJson, mobileCatalogResponseSnapshot,
  mobileContentResponseSnapshot, mobileDataSnapshot, mobileInteger, mobileProjectSchema,
  mobileRecord, mobileTrackIdentity, mobileTrackSelectionEquals,
} from '@music-bridge/contracts';
import type {
  MobileFavoriteAlbumRecord, MobileFavoriteAlbumState, MobileJsonValue,
  MobilePersonalPlaylistReceipt, MobilePersonalPlaylistRecord, MobileTrack,
  MobileTrackSelection, MobileUIAlbumRecord,
} from '@music-bridge/contracts';
import {
  captureMobileContentScope, isMobileContentMutation,
  type MobileContentMutationFacts, type MobileContentMutationInput,
  type MobileContentMutationOperation, type MobileContentScope, type MobileContentStateLimits,
} from './content-types.js';
import { MobileServiceError } from './types.js';

export const MOBILE_CONTENT_STATE_SCHEMA = 'musicbridge.mobile-content-state.v1' as const;
export interface MobileContentStoredReply {
  status: 200 | 201;
  category: 'success';
  body: MobileFavoriteAlbumState | MobilePersonalPlaylistReceipt;
}
export interface MobileContentReceipt {
  deviceId: string; deviceEpoch: number; accountDomain: string; key: string;
  operation: MobileContentMutationOperation; path: string; bodyHash: string;
  reply: MobileContentStoredReply;
}
export interface MobileContentPlaylistState {
  version: number; playlist: MobilePersonalPlaylistRecord; tracks: MobileTrack[];
}
export interface MobileContentDomainState {
  accountDomain: string; favoritesVersion: number; collectionVersion: number;
  favorites: MobileFavoriteAlbumRecord[]; playlists: MobileContentPlaylistState[];
}
export interface MobileContentState {
  schema: typeof MOBILE_CONTENT_STATE_SCHEMA; serverId: string; datasetId: string;
  revision: number; domains: MobileContentDomainState[]; receipts: MobileContentReceipt[];
}
export interface MobileContentDomainView {
  accountDomain: string; favoritesRevision: string; collectionRevision: string;
  favorites: MobileFavoriteAlbumRecord[];
  playlists: { playlist: MobilePersonalPlaylistRecord; tracks: MobileTrack[] }[];
}
export interface MobileContentMutationResult {
  state: MobileContentState; reply: MobileContentStoredReply; replayed: boolean; changed: boolean;
}

const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const changedSource = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
const staleRevision = (): never => { throw new MobileServiceError(409, 'REVISION_CONFLICT'); };
const capacity = (): never => { throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED'); };
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const json = (value: unknown): string => mobileCanonicalJson(value as MobileJsonValue);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  mobileRecord(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function limitsSnapshot(raw: MobileContentStateLimits): MobileContentStateLimits {
  const keys = ['stateBytes', 'receipts', 'albums', 'favoriteTracks', 'playlists', 'playlistTracks'] as const;
  try {
    if (raw === null || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
      || Reflect.ownKeys(raw).length !== keys.length) return invalid();
    const result = Object.create(null) as MobileContentStateLimits;
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(raw, key);
      if (!d?.enumerable || !Object.hasOwn(d, 'value') || !mobileInteger(d.value, key === 'stateBytes' ? 1 : 0)) return invalid();
      result[key] = d.value;
    }
    return result;
  } catch { return invalid(); }
}

/** 私有状态容量独立于公开单个 HTTP body；捕获不调用 getter/toJSON。 */
function captureData(raw: unknown, limits: MobileContentStateLimits): MobileJsonValue {
  let nodes = 0; const active = new Set<object>();
  const visit = (value: unknown, depth: number): MobileJsonValue => {
    if (++nodes > limits.stateBytes || depth > 64) return capacity();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (!wellFormed(value)) return invalid();
      if (Buffer.byteLength(value, 'utf8') > limits.stateBytes) return capacity();
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value) || Object.is(value, -0)) return invalid();
      return value;
    }
    if (typeof value !== 'object' || active.has(value)) return invalid();
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) return invalid();
    active.add(value);
    try {
      if (array) {
        const length = descriptors.length?.value as unknown;
        if (!mobileInteger(length) || length > limits.stateBytes || keys.length !== length + 1) return invalid();
        const result: MobileJsonValue[] = [];
        for (let i = 0; i < length; i++) {
          const d = descriptors[String(i)];
          if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid();
          result.push(visit(d.value, depth + 1));
        }
        return result;
      }
      const result = Object.create(null) as Record<string, MobileJsonValue>;
      for (const key of keys as string[]) {
        const d = descriptors[key];
        if (!wellFormed(key) || !d?.enumerable || !Object.hasOwn(d, 'value')) return invalid();
        result[key] = visit(d.value, depth + 1);
      }
      return result;
    } finally { active.delete(value); }
  };
  try {
    const value = visit(raw, 0);
    if (Buffer.byteLength(json(value), 'utf8') > limits.stateBytes) return capacity();
    return value;
  } catch (error) { if (error instanceof MobileServiceError) throw error; return invalid(); }
}
function revision(state: Pick<MobileContentState, 'serverId' | 'datasetId'>, domain: string,
  kind: 'favorites' | 'collection' | 'playlist', version: number, playlistId: string | null = null): string {
  return `mc:${hash(json([state.serverId, state.datasetId, domain, kind, playlistId, version]))}`;
}
function emptyDomain(accountDomain: string): MobileContentDomainState {
  return { accountDomain, favoritesVersion: 0, collectionVersion: 0, favorites: [], playlists: [] };
}
function projectedAlbum(raw: unknown): MobileUIAlbumRecord {
  const result = mobileContentResponseSnapshot('uiAlbum', raw);
  if (!result.ok) return changedSource();
  return mobileProjectSchema(MOBILE_CONTENT_SCHEMAS.UIAlbumRecord!, result.value as unknown as MobileJsonValue,
    MOBILE_CONTENT_SCHEMAS) as unknown as MobileUIAlbumRecord;
}
function projectedTrack(raw: unknown): MobileTrack {
  const result = mobileCatalogResponseSnapshot('track', raw);
  if (!result.ok) return changedSource();
  return mobileProjectSchema(MOBILE_CATALOG_SCHEMAS.Track!, result.value as unknown as MobileJsonValue,
    MOBILE_CATALOG_SCHEMAS) as unknown as MobileTrack;
}
function assertReply(raw: unknown, operation: MobileContentMutationOperation, domain: string): MobileContentStoredReply {
  if (!exact(raw, ['status', 'category', 'body']) || raw.category !== 'success'
    || raw.status !== (operation === 'createPersonalPlaylist' ? 201 : 200)) return invalid();
  const result = operation === 'setAlbumFavorite' || operation === 'setTrackFavorite'
    ? mobileContentResponseSnapshot('favoriteAlbumState', raw.body)
    : mobileContentResponseSnapshot('personalPlaylistReceipt', raw.body);
  if (!result.ok || result.value.accountDomain !== domain || json(raw.body) !== json(result.value)) return invalid();
  return raw as unknown as MobileContentStoredReply;
}
function validateState(raw: MobileJsonValue, limits: MobileContentStateLimits): MobileContentState {
  if (!exact(raw, ['schema', 'serverId', 'datasetId', 'revision', 'domains', 'receipts'])
    || raw.schema !== MOBILE_CONTENT_STATE_SCHEMA || !isMobileId(raw.serverId) || !isMobileId(raw.datasetId)
    || !mobileInteger(raw.revision) || !Array.isArray(raw.domains) || !Array.isArray(raw.receipts)) return invalid();
  const state = raw as unknown as MobileContentState;
  if (state.receipts.length > limits.receipts) return capacity();
  if (state.receipts.length !== state.revision) return invalid();
  let albumCount = 0, trackCount = 0, playlistCount = 0, playlistTracks = 0;
  const domainIds = new Set<string>(), allPlaylistIds = new Set<string>();
  for (const domain of state.domains) {
    if (!exact(domain, ['accountDomain', 'favoritesVersion', 'collectionVersion', 'favorites', 'playlists'])
      || !isMobileId(domain.accountDomain) || domainIds.has(domain.accountDomain)
      || !mobileInteger(domain.favoritesVersion, 0, state.revision) || !mobileInteger(domain.collectionVersion, 0, state.revision)
      || !Array.isArray(domain.favorites) || !Array.isArray(domain.playlists)) return invalid();
    domainIds.add(domain.accountDomain); const albums = new Set<string>(), playlists = new Set<string>();
    albumCount += domain.favorites.length; playlistCount += domain.playlists.length;
    for (const favorite of domain.favorites) {
      const result = mobileContentResponseSnapshot('favoriteAlbumRecord', favorite);
      if (!result.ok || json(projectedAlbum(favorite.album)) !== json(favorite.album)) return invalid();
      if (domain.favoritesVersion === 0) return invalid();
      const id = json([favorite.album.source, favorite.album.id]);
      if (albums.has(id)) return invalid(); albums.add(id); trackCount += favorite.favoriteTracks.length;
    }
    for (const item of domain.playlists) {
      if (!exact(item, ['version', 'playlist', 'tracks']) || !mobileInteger(item.version, 1, state.revision)
        || !Array.isArray(item.tracks)) return invalid();
      const p = mobileContentResponseSnapshot('personalPlaylist', item.playlist);
      if (!p.ok || domain.collectionVersion === 0 || playlists.has(item.playlist.playlistId)
        || allPlaylistIds.has(item.playlist.playlistId) || item.playlist.trackCount !== item.tracks.length
        || item.playlist.playlistRevision !== revision(state, domain.accountDomain, 'playlist', item.version, item.playlist.playlistId)
        || item.playlist.coverArtworkId !== (item.tracks[0]?.artworkId ?? null)) return invalid();
      playlists.add(item.playlist.playlistId); allPlaylistIds.add(item.playlist.playlistId); const ids = new Set<string>();
      for (const t of item.tracks) {
        if (json(projectedTrack(t)) !== json(t) || ids.has(mobileTrackIdentity(t))) return invalid();
        ids.add(mobileTrackIdentity(t));
      }
      playlistTracks += item.tracks.length;
    }
  }
  if (albumCount > limits.albums || trackCount > limits.favoriteTracks || playlistCount > limits.playlists
    || playlistTracks > limits.playlistTracks) return capacity();
  const receiptIds = new Set<string>();
  for (const receipt of state.receipts) {
    if (!exact(receipt, ['deviceId', 'deviceEpoch', 'accountDomain', 'key', 'operation', 'path', 'bodyHash', 'reply'])
      || !isMobileId(receipt.deviceId) || !mobileInteger(receipt.deviceEpoch, 1) || !isMobileId(receipt.accountDomain)
      || !domainIds.has(receipt.accountDomain) || typeof receipt.key !== 'string' || [...receipt.key].length < 1
      || [...receipt.key].length > 128 || /[\u0000-\u001f\u007f]/u.test(receipt.key)
      || !isMobileContentMutation(receipt.operation) || typeof receipt.path !== 'string'
      || !validReceiptPath(receipt.operation, receipt.path) || !/^[a-f0-9]{64}$/u.test(receipt.bodyHash)) return invalid();
    const id = json([receipt.deviceId, receipt.deviceEpoch, receipt.accountDomain, receipt.key]);
    if (receiptIds.has(id)) return invalid(); receiptIds.add(id);
    assertReply(receipt.reply, receipt.operation, receipt.accountDomain);
  }
  return state;
}
function validReceiptPath(operation: MobileContentMutationOperation, pathname: string): boolean {
  if (operation === 'createPersonalPlaylist') return pathname === '/mobile/v1/ui/playlists';
  const regex = operation === 'setAlbumFavorite' ? /^\/mobile\/v1\/ui\/favorites\/albums\/([^/]+)$/u
    : operation === 'setTrackFavorite' ? /^\/mobile\/v1\/ui\/favorites\/tracks\/([^/]+)$/u
      : /^\/mobile\/v1\/ui\/playlists\/([^/]+)\/tracks$/u;
  try { const match = regex.exec(pathname); return match !== null && isMobileId(decodeURIComponent(match[1]!)); }
  catch { return false; }
}

export function createMobileContentState(identity: { serverId: string; datasetId: string }): MobileContentState {
  const value = mobileDataSnapshot(identity);
  if (!value.ok || !exact(value.value, ['serverId', 'datasetId']) || !isMobileId(value.value.serverId)
    || !isMobileId(value.value.datasetId)) return invalid();
  return freeze(Object.assign(Object.create(null) as MobileContentState, { schema: MOBILE_CONTENT_STATE_SCHEMA,
    serverId: value.value.serverId, datasetId: value.value.datasetId, revision: 0, domains: [], receipts: [] }));
}
export function captureMobileContentState(raw: unknown, rawLimits: MobileContentStateLimits): MobileContentState {
  const limits = limitsSnapshot(rawLimits);
  return freeze(validateState(captureData(raw, limits), limits));
}
export function encodeMobileContentState(raw: MobileContentState, limits: MobileContentStateLimits): Uint8Array {
  return new Uint8Array(Buffer.from(json(captureMobileContentState(raw, limits)), 'utf8'));
}
export function decodeMobileContentState(raw: Uint8Array, rawLimits: MobileContentStateLimits): MobileContentState {
  const limits = limitsSnapshot(rawLimits);
  try {
    if (!(raw instanceof Uint8Array) || raw.buffer instanceof SharedArrayBuffer || raw.byteLength > limits.stateBytes) return capacity();
    const bytes = new Uint8Array(raw), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const state = captureMobileContentState(JSON.parse(text) as unknown, limits);
    if (!Buffer.from(bytes).equals(Buffer.from(json(state), 'utf8'))) return invalid();
    return state;
  } catch (error) { if (error instanceof MobileServiceError) throw error; return invalid(); }
}
function scopeFor(state: MobileContentState, raw: Readonly<MobileContentScope>): Readonly<MobileContentScope> {
  const scope = captureMobileContentScope(raw);
  if (scope.serverId !== state.serverId || scope.datasetId !== state.datasetId) return changedSource();
  return scope;
}
export function mobileContentDomainSnapshot(raw: MobileContentState, rawScope: Readonly<MobileContentScope>,
  limits: MobileContentStateLimits): MobileContentDomainView {
  const state = captureMobileContentState(raw, limits), scope = scopeFor(state, rawScope);
  const domain = state.domains.find(item => item.accountDomain === scope.accountDomain) ?? emptyDomain(scope.accountDomain);
  return freeze({ accountDomain: domain.accountDomain, favoritesRevision: revision(state, domain.accountDomain, 'favorites', domain.favoritesVersion),
    collectionRevision: revision(state, domain.accountDomain, 'collection', domain.collectionVersion), favorites: domain.favorites,
    playlists: domain.playlists.map(item => ({ playlist: item.playlist, tracks: item.tracks })) });
}
function captureInput(raw: MobileContentMutationInput, state: MobileContentState): MobileContentMutationInput {
  const capture = mobileDataSnapshot(raw);
  if (!capture.ok || !exact(capture.value, ['operation', 'request', 'scope']) || !isMobileContentMutation(capture.value.operation)) return invalid();
  const input = capture.value as unknown as MobileContentMutationInput;
  scopeFor(state, input.scope);
  // 此处只消费原 HTTP 形状 codec；该解析上下文不签发网络或鉴权能力。
  const encoded = encodeMobileRequest(input.operation, input.request,
    { responseOrigin: 'https://mobile-content.invalid', requestPath: input.request.path });
  if (!encoded.ok || input.request.idempotencyKey === undefined) return invalid();
  if (input.request.body.accountDomain !== input.scope.accountDomain) return changedSource();
  return input;
}
function receiptFor(state: MobileContentState, input: MobileContentMutationInput): MobileContentStoredReply | null {
  const stored = state.receipts.find(r => r.deviceId === input.scope.deviceId && r.deviceEpoch === input.scope.deviceEpoch
    && r.accountDomain === input.scope.accountDomain && r.key === input.request.idempotencyKey);
  if (!stored) return null;
  if (stored.operation !== input.operation || stored.path !== input.request.path || stored.bodyHash !== hash(json(input.request.body))) {
    throw new MobileServiceError(409, 'IDEMPOTENCY_CONFLICT');
  }
  return stored.reply;
}
export function lookupMobileContentReceipt(raw: MobileContentState, input: MobileContentMutationInput,
  limits: MobileContentStateLimits): MobileContentStoredReply | null {
  const state = captureMobileContentState(raw, limits);
  return receiptFor(state, captureInput(input, state));
}
function selected(raw: unknown, selection: MobileTrackSelection, albumId?: string): MobileTrack {
  const track = projectedTrack(raw);
  if (!mobileTrackSelectionEquals({ trackId: track.id, source: track.source, versionId: track.versionId,
    contentRevision: track.contentRevision }, selection) || albumId !== undefined && track.albumId !== albumId) return changedSource();
  return track;
}
function next(value: number): number { if (value >= Number.MAX_SAFE_INTEGER) return capacity(); return value + 1; }

/** 新回执和集合变化组成一个候选状态；这里只计算，不接触 Owner 或文件。 */
export function applyMobileContentMutation(raw: MobileContentState, rawInput: MobileContentMutationInput,
  facts: MobileContentMutationFacts, options: { limits: MobileContentStateLimits; newPlaylistId?: string }): MobileContentMutationResult {
  const limits = limitsSnapshot(options.limits), state = captureMobileContentState(raw, limits), input = captureInput(rawInput, state);
  const previous = receiptFor(state, input);
  if (previous) return freeze({ state, reply: previous, replayed: true, changed: false });
  if (state.receipts.length >= limits.receipts) return capacity();
  const capturedFacts = mobileDataSnapshot(facts);
  if (!capturedFacts.ok || !mobileRecord(capturedFacts.value)
    || Reflect.ownKeys(capturedFacts.value).some(key => key !== 'album' && key !== 'track')) return changedSource();
  const trusted = capturedFacts.value as unknown as MobileContentMutationFacts;
  const working = captureData(state, limits) as unknown as MobileContentState;
  let domain = working.domains.find(value => value.accountDomain === input.scope.accountDomain);
  if (!domain) { domain = emptyDomain(input.scope.accountDomain); working.domains.push(domain); }
  let changed = false; let reply: MobileContentStoredReply;
  if (input.operation === 'setAlbumFavorite' || input.operation === 'setTrackFavorite') {
    const body = input.request.body;
    if (!('expectedRevision' in body) || body.expectedRevision !== revision(state, domain.accountDomain, 'favorites', domain.favoritesVersion)) return staleRevision();
    const albumId = input.operation === 'setAlbumFavorite' ? input.request.pathParameters.albumId : 'albumId' in body ? body.albumId : undefined;
    const source = 'source' in body ? body.source : undefined;
    const album = projectedAlbum(trusted.album);
    if (album.id !== albumId || album.source !== source || !('isFavorite' in body)) return changedSource();
    const index = domain.favorites.findIndex(f => f.album.id === album.id && f.album.source === album.source);
    const favorite: MobileFavoriteAlbumRecord = index < 0 ? { album, albumFavorite: false, favoriteTracks: [] } : domain.favorites[index]!;
    if (input.operation === 'setAlbumFavorite') {
      if (favorite.albumFavorite !== body.isFavorite) { favorite.albumFavorite = body.isFavorite; changed = true; }
    } else {
      if (!('versionId' in body) || !('contentRevision' in body) || !isMobileId(input.request.pathParameters.trackId)) return invalid();
      const pick: MobileTrackSelection = { trackId: input.request.pathParameters.trackId, source: album.source,
        versionId: body.versionId, contentRevision: body.contentRevision };
      selected(trusted.track, pick, album.id);
      const position = favorite.favoriteTracks.findIndex(t => mobileTrackSelectionEquals(t, pick));
      if (body.isFavorite && position < 0) { favorite.favoriteTracks.push(pick); changed = true; }
      else if (!body.isFavorite && position >= 0) { favorite.favoriteTracks.splice(position, 1); changed = true; }
    }
    if (favorite.albumFavorite || favorite.favoriteTracks.length > 0) {
      if (index < 0) domain.favorites.push(favorite);
    } else if (index >= 0) domain.favorites.splice(index, 1);
    if (changed) domain.favoritesVersion = next(domain.favoritesVersion);
    const value = { accountDomain: domain.accountDomain, favoritesRevision: revision(state, domain.accountDomain, 'favorites', domain.favoritesVersion),
      identity: { albumId: album.id, source: album.source }, favorite: domain.favorites.find(f => f.album.id === album.id && f.album.source === album.source) ?? null };
    const valid = mobileContentResponseSnapshot('favoriteAlbumState', value); if (!valid.ok) return capacity();
    reply = { status: 200, category: 'success', body: valid.value };
  } else {
    let item: MobileContentPlaylistState;
    if (input.operation === 'createPersonalPlaylist') {
      const body = input.request.body;
      if (!('draft' in body) || body.expectedCollectionRevision !== revision(state, domain.accountDomain, 'collection', domain.collectionVersion)) return staleRevision();
      if (!isMobileId(options.newPlaylistId) || working.domains.some(d => d.playlists.some(p => p.playlist.playlistId === options.newPlaylistId))) return invalid();
      const draft = mapMobilePersonalPlaylistDraft(body.draft); if (!draft.ok) return invalid();
      const tracks = body.initialTrack == null ? [] : [selected(trusted.track, body.initialTrack)];
      item = { version: 1, tracks, playlist: { playlistId: options.newPlaylistId, ...draft.value,
        trackCount: tracks.length, playlistRevision: revision(state, domain.accountDomain, 'playlist', 1, options.newPlaylistId),
        coverArtworkId: tracks[0]?.artworkId ?? null } };
      domain.playlists.push(item); changed = true;
    } else {
      const body = input.request.body;
      item = domain.playlists.find(p => p.playlist.playlistId === input.request.pathParameters.playlistId)!;
      if (!item) throw new MobileServiceError(404, 'SOURCE_CHANGED');
      if (!('selection' in body) || body.expectedRevision !== item.playlist.playlistRevision) return staleRevision();
      const track = selected(trusted.track, body.selection);
      if (!item.tracks.some(t => mobileTrackIdentity(t) === mobileTrackIdentity(track))) {
        item.tracks.push(track); item.version = next(item.version);
        item.playlist.trackCount = item.tracks.length;
        item.playlist.playlistRevision = revision(state, domain.accountDomain, 'playlist', item.version, item.playlist.playlistId);
        item.playlist.coverArtworkId = item.tracks[0]?.artworkId ?? null; changed = true;
      }
    }
    if (changed) domain.collectionVersion = next(domain.collectionVersion);
    const valid = mobileContentResponseSnapshot('personalPlaylistReceipt', { accountDomain: domain.accountDomain,
      collectionRevision: revision(state, domain.accountDomain, 'collection', domain.collectionVersion), playlist: item.playlist });
    if (!valid.ok) return capacity();
    reply = { status: input.operation === 'createPersonalPlaylist' ? 201 : 200, category: 'success', body: valid.value };
  }
  working.revision = next(working.revision);
  working.receipts.push({ deviceId: input.scope.deviceId, deviceEpoch: input.scope.deviceEpoch,
    accountDomain: input.scope.accountDomain, key: input.request.idempotencyKey!, operation: input.operation,
    path: input.request.path, bodyHash: hash(json(input.request.body)), reply });
  const result = captureMobileContentState(working, limits);
  return freeze({ state: result, reply: result.receipts[result.receipts.length - 1]!.reply, replayed: false, changed });
}
