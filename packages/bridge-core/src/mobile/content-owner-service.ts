import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  isMobileId, mobileCanonicalJson, mobileCatalogResponseSnapshot, mobileContentResponseSnapshot,
  mobileInteger, mobileTrackSelectionEquals,
} from '@music-bridge/contracts';
import type {
  LocalLibraryTrackDetail, MobileAddedAlbumRecord, MobileContentReadContext,
  MobileFavoriteAlbumRecord, MobileJsonValue, MobileRequestMap, MobileTrack,
  MobileTrackSelection, MobileUIAlbumRecord,
} from '@music-bridge/contracts';
import type { CollectionRepository } from '../collection/repository.js';
import { captureMobileContentReply } from './content-protocol.js';
import { createMobileContentCursorCodec } from './content-cursor.js';
import {
  applyMobileContentMutation, lookupMobileContentReceipt, mobileContentDomainSnapshot,
  type MobileContentDomainView, type MobileContentStoredReply,
} from './content-state.js';
import {
  createMobileContentOwnerStore, MobileContentPersistenceError,
  type MobileContentLoadedState, type MobileContentOwnerStore,
} from './content-owner-store.js';
import {
  captureMobileContentScope, isMobileContentMutation, type MobileContentMutationFacts,
  type MobileContentMutationInput, type MobileContentMutationOperation,
  type MobileContentPageScope, type MobileContentScope, type MobileContentStateLimits,
} from './content-types.js';
import {
  captureMobileContentOwnerRequest, isMobileContentOwnerResult,
  type MobileContentOwnerDispatch, type MobileContentOwnerOperation, type MobileContentOwnerReadPlan,
  type MobileContentOwnerRequest, type MobileContentOwnerResult, type MobileContentOwnerSnapshot,
} from './owner-content-protocol.js';
import { createMobileContentLocalLyrics, type MobileLocalLyricsSnapshot } from './content-local-lyrics.js';
import {
  MobileServiceError, type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult,
} from './types.js';

export const MOBILE_CONTENT_OWNER_SNAPSHOT_LIMIT = 16;
export const MOBILE_CONTENT_OWNER_SNAPSHOT_TTL_MS = 15_000;
const registeredScopeLimit = 64;
const deviceLimit = 32;
const providerInvalidationLimit = 128;
const json = (v: unknown): string => mobileCanonicalJson(v as MobileJsonValue);
const hash = (v: unknown): string => createHash('sha256').update(json(v)).digest('hex');
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
const unavailable = (): never => { throw new MobileServiceError(503, 'BUSY'); };
const changed = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
const denied = (): never => { throw new MobileServiceError(401, 'UNAUTHORIZED'); };
const limited = (): never => { throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED'); };
const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const scopeKey = (s: Readonly<MobileContentScope>): string => json([s.deviceId, s.accountDomain]);
const pick = (t: MobileTrack): MobileTrackSelection => ({ trackId: t.id, source: t.source, versionId: t.versionId, contentRevision: t.contentRevision });
function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
interface PageFields { source?: 'local' | 'netease'; accountDomain?: string; limit?: number; cursor?: string;
  favoritesRevision?: string; playlistRevision?: string }
// 原 HTTP codec 已核全部 query 类型；这里只恢复当前十操作的静态字段视图。
const fields = (request: { query: unknown }): PageFields => request.query as PageFields;
interface ReadFence {
  domainRevision: string | null; libraryRevision: string | null;
  check?: () => Promise<void>;
}
interface HeldSnapshot extends ReadFence {
  expiresAt: number; scope: Readonly<MobileContentScope>; operation: MobileContentOwnerOperation | 'getExactTrackLyrics';
  request: MobileRequestMap[MobileContentOwnerOperation] | MobileRequestMap['getExactTrackLyrics'];
  result: MobileContentOwnerResult;
  mutation: MobileContentMutationInput | null;
}
interface HeldPlan {
  expiresAt: number; scope: Readonly<MobileContentScope>; request: MobileRequestMap['listFavoriteAlbumTracks'];
  requestHash: string; plan: MobileContentOwnerReadPlan; query: MobileContentPageScope;
}
export interface MobileContentOwnerServiceOptions {
  collection: CollectionRepository; datasetId: string; ownerEpoch: string; assertCurrent(): void;
  /** 原唯一 Owner 的目录投影；复用同一个连接与许可，不创建第二目录作者。 */
  catalog: { dispatch(input: MobileOwnerPrivateRequest): MobileOwnerPrivateResult };
  limits: MobileContentStateLimits; now?: () => number;
}

/** 唯一 Owner 内的内容 actor。Provider 异步读取发生在 plan-read 与 dispatch 之间。 */
export function createMobileContentOwnerService(options: MobileContentOwnerServiceOptions) {
  const { collection, datasetId, ownerEpoch, catalog } = options;
  const assertCurrent = options.assertCurrent, now = options.now ?? Date.now;
  const limits = Object.freeze({ ...options.limits });
  if (!isMobileId(datasetId) || !isMobileId(ownerEpoch) || typeof assertCurrent !== 'function') return invalid();
  let closed = false, serverId: string | undefined, key: Buffer | undefined, store: MobileContentOwnerStore | undefined;
  let cursor: ReturnType<typeof createMobileContentCursorCodec> | undefined;
  const scopes = new Map<string, Readonly<MobileContentScope>>();
  const devices = new Map<string, { epoch: number; generation: number; invalidated: boolean }>();
  const invalidProviders = new Set<string>();
  const snapshots = new Map<string, HeldSnapshot>(), plans = new Map<string, HeldPlan>();
  const active = new Set<Promise<MobileContentOwnerResult>>(), controllers = new Set<AbortController>();
  let pending: { commitId: string; input: MobileContentMutationInput } | undefined;
  function clock(): number { const v = now(); if (!mobileInteger(v)) return unavailable(); return v; }
  function current(): void { if (closed) return unavailable(); assertCurrent(); }
  function initialized(): MobileContentOwnerStore { current(); if (!serverId || !key || !store || !cursor) return unavailable(); return store; }
  function checkScope(scope: Readonly<MobileContentScope>): void {
    initialized();
    if (scope.serverId !== serverId || scope.datasetId !== datasetId || scope.ownerEpoch !== ownerEpoch) return changed();
    const registered = scopes.get(scopeKey(scope));
    if (!registered || !same(registered, scope) || scope.providerEpoch !== null && invalidProviders.has(scope.providerEpoch)) return denied();
  }
  function prune(): void {
    const t = clock();
    for (const [id, v] of snapshots) if (v.expiresAt <= t) snapshots.delete(id);
    for (const [id, v] of plans) if (v.expiresAt <= t) plans.delete(id);
  }
  function reserveSlot(): void { prune(); if (snapshots.size + plans.size + controllers.size >= MOBILE_CONTENT_OWNER_SNAPSHOT_LIMIT) return unavailable(); }
  function updateScope(raw: Readonly<MobileContentScope>): Readonly<MobileContentScope> {
    initialized(); const s = captureMobileContentScope(raw);
    if (s.serverId !== serverId || s.datasetId !== datasetId || s.ownerEpoch !== ownerEpoch) return changed();
    if (s.providerEpoch !== null && invalidProviders.has(s.providerEpoch)) return denied();
    const previous = devices.get(s.deviceId);
    if (!previous && devices.size >= deviceLimit) return unavailable();
    if (previous && (s.deviceEpoch < previous.epoch || s.deviceEpoch === previous.epoch
      && (s.accessGeneration < previous.generation || previous.invalidated))) return denied();
    const replaced = [...scopes.values()].filter(old => old.deviceId === s.deviceId && !same(old, s)).length;
    if (!scopes.has(scopeKey(s)) && scopes.size - replaced >= registeredScopeLimit) return unavailable();
    // 每个设备只有最新完整 Scope；账号或 Provider 切换不能留下旧镜像。
    for (const [id, old] of scopes) if (old.deviceId === s.deviceId && !same(old, s)) scopes.delete(id);
    devices.set(s.deviceId, { epoch: s.deviceEpoch, generation: s.accessGeneration, invalidated: false });
    scopes.set(scopeKey(s), s); return s;
  }
  function invalidate(req: Extract<MobileContentOwnerRequest, { action: 'invalidateScope' }>): void {
    initialized();
    if (req.kind === 'device') {
      const previous = devices.get(req.deviceId);
      if (!previous) return invalid();
      devices.set(req.deviceId, { ...previous, invalidated: true });
      for (const [id, scope] of scopes) if (scope.deviceId === req.deviceId) scopes.delete(id);
    } else {
      if (!invalidProviders.has(req.providerEpoch) && invalidProviders.size >= providerInvalidationLimit) return unavailable();
      invalidProviders.add(req.providerEpoch);
      for (const [id, scope] of scopes) if (scope.providerEpoch === req.providerEpoch) scopes.delete(id);
    }
    // 已签快照仍保留身份，发送前 currentness 拒绝；不会删已提交的持久回执。
  }
  function initialize(req: Extract<MobileContentOwnerRequest, { action: 'initialize' }>): MobileContentOwnerResult {
    current();
    try {
      if (req.datasetId !== datasetId) return changed();
      if (key) {
        if (serverId !== req.serverId || !timingSafeEqual(key, Buffer.from(req.key))) throw new MobileContentPersistenceError('unknown');
      } else {
        const directory = collection.privateMobileDataDirectory?.(); if (!directory) return unavailable();
        const nextKey = Buffer.from(req.key), aad = Buffer.from(json(['MusicBridge:MBM004:CONTENT_STATE:1', req.serverId, datasetId]));
        const seal = (plain: Uint8Array): Uint8Array => {
          current(); const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', nextKey, nonce); cipher.setAAD(aad);
          const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
          return new Uint8Array(Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
        };
        const open = (sealed: Uint8Array): Uint8Array => {
          current(); if (sealed.length < 28) return unavailable();
          const bytes = Buffer.from(sealed), decipher = createDecipheriv('aes-256-gcm', nextKey, bytes.subarray(0, 12));
          decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28));
          return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
        };
        try {
          const nextStore = createMobileContentOwnerStore({ directory, serverId: req.serverId, datasetId, limits,
            seal, open, assertCurrent: current });
          nextStore.load();
          const cursorKey = createHmac('sha256', nextKey).update('MusicBridge:MBM004:CONTENT_CURSOR_KEY:1\0').digest();
          cursor = createMobileContentCursorCodec({ key: cursorKey, now }); cursorKey.fill(0);
          key = nextKey; serverId = req.serverId; store = nextStore;
        } catch (error) { nextKey.fill(0); throw error; }
      }
      return { kind: 'content-initialized', serverId: req.serverId, datasetId, ownerEpoch };
    } finally { req.key.fill(0); }
  }
  function catalogRead(request: Omit<MobileOwnerCatalogRequest, 'serverId' | 'catalogPlaybackEnabled'>): MobileOwnerCatalogSnapshot {
    initialized();
    const result = catalog.dispatch({ kind: 'catalog', datasetId,
      request: { ...request, serverId: serverId!, catalogPlaybackEnabled: true } });
    if ('kind' in result) {
      if (result.kind === 'mobile-error') throw new MobileServiceError(result.status, result.code, result.retryable);
      return unavailable();
    }
    if (!('operation' in result) || result.datasetId !== datasetId || result.ownerEpoch !== ownerEpoch) return unavailable();
    return result;
  }
  function libraryRevision(): string {
    return catalogRead({ operation: 'listAlbums', offset: 0, limit: 1, q: '', albumId: null, itemId: null, expectedRevision: null }).libraryRevision;
  }
  function localAlbum(id: string): { album: MobileUIAlbumRecord; revision: string } {
    const result = catalogRead({ operation: 'getAlbum', offset: 0, limit: 1, q: '', albumId: null, itemId: id, expectedRevision: null });
    const found = mobileContentResponseSnapshot('uiAlbum', result.items[0]);
    if (!found.ok || found.value.source !== 'local' || found.value.id !== id) return changed();
    return { album: found.value, revision: result.libraryRevision };
  }
  function localTrack(selected: MobileTrackSelection): { track: MobileTrack; detail: LocalLibraryTrackDetail; revision: string } {
    if (selected.source !== 'local') return changed();
    const result = catalogRead({ operation: 'getTrack', offset: 0, limit: 1, q: '', albumId: null,
      itemId: selected.trackId, expectedRevision: null });
    const parsed = mobileCatalogResponseSnapshot('track', result.items[0]);
    if (!parsed.ok || !mobileTrackSelectionEquals(pick(parsed.value), selected)) return changed();
    const parts = selected.trackId.split(':');
    if (parts.length !== 4 || parts[0] !== 'lt' || parts[1] !== datasetId) return changed();
    const original = collection.localCatalog.trackDetail(parts[2]!);
    const detail = { ...original, fileParameters: collection.localScan.privateDisplayFileParameters(original.track.id, original.asset, 'mobile-catalog') };
    current(); if (libraryRevision() !== result.libraryRevision) return changed();
    return { track: parsed.value, detail, revision: result.libraryRevision };
  }
  function domain(scope: Readonly<MobileContentScope>): { loaded: MobileContentLoadedState; value: MobileContentDomainView } {
    checkScope(scope); const loaded = initialized().load();
    return { loaded, value: mobileContentDomainSnapshot(loaded.state, scope, limits) };
  }
  function baseContext(scope: Readonly<MobileContentScope>): MobileContentReadContext {
    return { serverId: scope.serverId, deviceId: scope.deviceId, accountDomain: scope.accountDomain };
  }
  function pageQuery(operation: MobileContentOwnerOperation, request: MobileRequestMap[MobileContentOwnerOperation],
    scope: Readonly<MobileContentScope>): MobileContentPageScope {
    const withoutCursor = Object.fromEntries(Object.entries(request.query).filter(([name]) => name !== 'cursor'));
    return { scope, operation, source: operation === 'listRecentlyAddedAlbums' ? 'local' : fields(request).source ?? 'all',
      parentId: request.pathParameters.albumId ?? request.pathParameters.playlistId ?? null, kind: null,
      filterHash: hash(withoutCursor), sort: operation === 'listRecentlyAddedAlbums' ? 'registered-desc' : 'stored-order',
      limit: fields(request).limit ?? 50 };
  }
  function pageOffset(query: MobileContentPageScope, token: string | undefined, revision: string): number {
    if (token === undefined) return 0;
    const claim = cursor!.open(token, query); if (claim.revision !== revision) return changed(); return claim.offset;
  }
  function pageContext(scope: Readonly<MobileContentScope>, query: MobileContentPageScope, revision: string,
    offset: number, token?: string): MobileContentReadContext {
    return { ...baseContext(scope), ...(query.source === 'all' ? {} : { source: query.source }),
      ...(query.parentId ? query.operation === 'listFavoriteAlbumTracks' ? { albumId: query.parentId } : { playlistId: query.parentId } : {}),
      revision, limit: query.limit, pageOffset: offset, sort: query.sort,
      previousCursors: token ? [token] : [], cursorFacts: { serverId: scope.serverId, deviceId: scope.deviceId,
        accountDomain: scope.accountDomain, revision, sort: query.sort, parentId: query.parentId, source: query.source } };
  }
  function nextCursor(query: MobileContentPageScope, offset: number, count: number, total: number, revision: string): string | null {
    if (!mobileInteger(total, 0, 300000) || offset > total || count !== Math.min(query.limit, total - offset)) return changed();
    return offset + count < total ? cursor!.issue({ query, revision, offset: offset + count }) : null;
  }
  function snapshot(req: MobileContentOwnerDispatch, rawReply: unknown, context: MobileContentReadContext,
    fence: ReadFence, mutation: MobileContentMutationInput | null = null): MobileContentOwnerSnapshot {
    checkScope(req.scope); reserveSlot();
    const captured = captureMobileContentReply(req.operation, req.request, req.scope, rawReply, context);
    const snapshotId = randomUUID();
    const result: MobileContentOwnerSnapshot = freeze({ kind: 'content-snapshot', datasetId, ownerEpoch, snapshotId,
      operation: req.operation, scope: req.scope, ...captured });
    snapshots.set(snapshotId, { ...fence, expiresAt: clock() + MOBILE_CONTENT_OWNER_SNAPSHOT_TTL_MS,
      scope: req.scope, operation: req.operation, request: req.request, result, mutation });
    return result;
  }
  function favorite(v: MobileContentDomainView, source: string, albumId: string): MobileFavoriteAlbumRecord | null {
    return v.favorites.find(f => f.album.id === albumId && f.album.source === source) ?? null;
  }
  function assertAccount(req: MobileContentOwnerDispatch): void {
    const body = req.request.body as unknown as { accountDomain?: string } | null;
    if (fields(req.request).accountDomain !== undefined && fields(req.request).accountDomain !== req.scope.accountDomain
      || body?.accountDomain !== undefined && body.accountDomain !== req.scope.accountDomain) return changed();
    const source = fields(req.request).source ?? (body as { source?: string } | null)?.source;
    if (source === 'netease' && req.scope.providerEpoch === null) throw new MobileServiceError(401, 'UNAUTHORIZED');
  }
  function requestHash(req: { scope: Readonly<MobileContentScope>; operation: string; request: unknown }): string {
    return hash([req.scope, req.operation, req.request]);
  }
  function factsFor(req: MobileContentOwnerDispatch): MobileContentMutationFacts {
    const body = req.request.body as unknown as { source?: 'local' | 'netease'; albumId?: string;
      versionId?: string; contentRevision?: string; selection?: MobileTrackSelection; initialTrack?: MobileTrackSelection | null };
    let albumId: string | undefined, selection: MobileTrackSelection | undefined;
    if (req.operation === 'setAlbumFavorite') albumId = req.request.pathParameters.albumId;
    if (req.operation === 'setTrackFavorite') {
      albumId = body.albumId;
      selection = { trackId: req.request.pathParameters.trackId!, source: body.source!, versionId: body.versionId!, contentRevision: body.contentRevision! };
    }
    if (req.operation === 'addPersonalPlaylistTrack') selection = body.selection;
    if (req.operation === 'createPersonalPlaylist') selection = body.initialTrack ?? undefined;
    const source = selection?.source ?? body.source;
    if (source === undefined) {
      if (req.providerFacts !== undefined) return invalid(); return {};
    }
    if (source === 'local') {
      if (req.providerFacts !== undefined) return invalid();
      const facts: MobileContentMutationFacts = {};
      if (albumId) facts.album = localAlbum(albumId).album;
      if (selection) facts.track = localTrack(selection).track;
      return facts;
    }
    if (req.scope.providerEpoch === null || !req.providerFacts) return unavailable();
    const facts = req.providerFacts;
    if (albumId && (!facts.album || facts.album.source !== 'netease' || facts.album.id !== albumId)
      || selection && (!facts.track || !mobileTrackSelectionEquals(pick(facts.track), selection))) return changed();
    return facts;
  }
  function mutationContext(req: MobileContentOwnerDispatch, reply: MobileContentStoredReply): MobileContentReadContext {
    const body = reply.body, context = baseContext(req.scope);
    if ('favoritesRevision' in body) {
      const requestBody = req.request.body as unknown as { source: 'local' | 'netease'; albumId?: string; versionId?: string; contentRevision?: string };
      return { ...context, revision: body.favoritesRevision, source: body.identity.source, albumId: body.identity.albumId,
        ...(req.operation === 'setTrackFavorite' ? { selection: { trackId: req.request.pathParameters.trackId!,
          source: requestBody.source, versionId: requestBody.versionId!, contentRevision: requestBody.contentRevision! } } : {}) };
    }
    const result: MobileContentReadContext = { ...context, revision: body.collectionRevision, playlistId: body.playlist.playlistId };
    if (req.operation === 'addPersonalPlaylistTrack') result.selection = (req.request.body as unknown as { selection: MobileTrackSelection }).selection;
    return result;
  }
  function mutate(req: MobileContentOwnerDispatch): MobileContentOwnerSnapshot {
    if (!isMobileContentMutation(req.operation) || req.providerPage) return invalid();
    reserveSlot();
    const { loaded } = domain(req.scope);
    const input: MobileContentMutationInput = { operation: req.operation,
      request: req.request as MobileRequestMap[MobileContentMutationOperation], scope: req.scope };
    const receipt = lookupMobileContentReceipt(loaded.state, input, limits);
    if (receipt) return snapshot(req, receipt, mutationContext(req, receipt), { domainRevision: null, libraryRevision: null }, input);
    const library = libraryRevision(), facts = factsFor(req);
    const result = applyMobileContentMutation(loaded.state, input, facts, { limits,
      ...(req.operation === 'createPersonalPlaylist' ? { newPlaylistId: randomUUID() } : {}) });
    const commitId = randomUUID();
    try {
      const saved = initialized().save({ expectedRevision: loaded.revision, commitId, state: result.state,
        guard: () => { checkScope(req.scope); if (libraryRevision() !== library) return changed(); } });
      if (saved.kind === 'conflict') throw new MobileServiceError(409, 'REVISION_CONFLICT');
    } catch (error) {
      if (error instanceof MobileContentPersistenceError && error.outcome === 'unknown') pending = { commitId, input };
      throw error;
    }
    return snapshot(req, result.reply, mutationContext(req, result.reply), { domainRevision: null, libraryRevision: null }, input);
  }
  function lookupReceipt(req: Extract<MobileContentOwnerRequest, { action: 'lookup-receipt' }>): MobileContentOwnerResult {
    const dispatch: MobileContentOwnerDispatch = { ...req, action: 'dispatch' }; assertAccount(dispatch);
    const input: MobileContentMutationInput = { operation: req.operation, request: req.request, scope: req.scope };
    const receipt = lookupMobileContentReceipt(domain(req.scope).loaded.state, input, limits);
    if (!receipt) return { kind: 'content-receipt-not-found', datasetId, ownerEpoch };
    // 只读原回执，不读取最新 Provider 元数据、不比较当前 CAS，也不调用 save。
    return snapshot(dispatch, receipt, mutationContext(dispatch, receipt), { domainRevision: null, libraryRevision: null }, input);
  }
  function recentlyAdded(req: MobileContentOwnerDispatch): MobileContentOwnerSnapshot {
    const revision = libraryRevision(), query = pageQuery(req.operation, req.request, req.scope);
    const offset = pageOffset(query, fields(req.request).cursor, revision);
    if (!collection.privateMobileCatalogAccess) return unavailable();
    // 入库时间取原 create-edition 账本，不猜文件时间、扫描完成时间或手机 lastSeen。
    const ordered = collection.privateMobileCatalogAccess(db => {
      const candidates = db.prepare("SELECT id FROM local_catalog_editions ORDER BY id").iterate();
      const rows: { id: string; addedAt: string }[] = [];
      let visited = 0;
      for (const row of candidates) {
        if (++visited > 300000 || typeof row.id !== 'string') return limited();
        const available = collection.localCatalog.privateMobileCandidates({ kind: 'tracks', offset: 0, limit: 1,
          query: '', editionId: row.id, trackId: null });
        if (!available.total) continue;
        const receipt = db.prepare("SELECT created_at FROM local_catalog_ledger WHERE operation='create-edition' AND json_extract(result,'$.id')=? ORDER BY rowid LIMIT 1").get(row.id);
        if (!receipt || typeof receipt.created_at !== 'string' || !Number.isFinite(Date.parse(receipt.created_at))) return unavailable();
        rows.push({ id: row.id, addedAt: receipt.created_at });
      }
      return rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
    const items: MobileAddedAlbumRecord[] = ordered.slice(offset, offset + query.limit).map(row => ({
      ...localAlbum(`la:${datasetId}:${row.id}`).album, source: 'local', addedAt: row.addedAt,
    }));
    if (libraryRevision() !== revision) return changed();
    return snapshot(req, { status: 200, category: 'success', body: { items, libraryRevision: revision,
      nextCursor: nextCursor(query, offset, items.length, ordered.length, revision) } },
    pageContext(req.scope, query, revision, offset, fields(req.request).cursor), { domainRevision: null, libraryRevision: revision });
  }
  function planRead(req: Extract<MobileContentOwnerRequest, { action: 'plan-read' }>): MobileContentOwnerReadPlan {
    checkScope(req.scope); reserveSlot();
    const dispatch: MobileContentOwnerDispatch = { ...req, action: 'dispatch' }; assertAccount(dispatch);
    const { value } = domain(req.scope);
    if (fields(req.request).favoritesRevision !== value.favoritesRevision) return changed();
    const query = pageQuery(req.operation, req.request, req.scope), token = fields(req.request).cursor;
    const claim = token ? cursor!.open(token, query) : null;
    const offset = claim?.offset ?? 0, f = favorite(value, 'netease', req.request.pathParameters.albumId!);
    if (!f) throw new MobileServiceError(404, 'SOURCE_CHANGED');
    const planId = randomUUID(), selections = f.albumFavorite ? null : f.favoriteTracks.slice(offset, offset + query.limit);
    const result: MobileContentOwnerReadPlan = freeze({ kind: 'content-read-plan', datasetId, ownerEpoch, planId,
      scope: req.scope, operation: req.operation, requestHash: requestHash(req), albumId: req.request.pathParameters.albumId!,
      offset, limit: query.limit, revision: value.favoritesRevision, expectedRevision: claim?.revision ?? null,
      selections, total: f.albumFavorite ? null : f.favoriteTracks.length });
    plans.set(planId, { expiresAt: clock() + MOBILE_CONTENT_OWNER_SNAPSHOT_TTL_MS, scope: req.scope,
      request: req.request, requestHash: result.requestHash, plan: result, query });
    return result;
  }
  function providerFavoriteTracks(req: MobileContentOwnerDispatch, value: MobileContentDomainView,
    library: string): MobileContentOwnerSnapshot {
    const page = req.providerPage; prune(); const held = page && plans.get(page.planId);
    if (!held || !page || !same(held.scope, req.scope) || held.requestHash !== requestHash(req)
      || held.plan.revision !== value.favoritesRevision || page.offset !== held.plan.offset || page.limit !== held.plan.limit) return changed();
    checkScope(req.scope);
    const f = favorite(value, 'netease', held.plan.albumId); if (!f) return changed();
    if (held.plan.selections !== null && (page.total !== held.plan.total
      || page.items.some((item, i) => !mobileTrackSelectionEquals(pick(item), held.plan.selections![i]!)))) return changed();
    if (f.albumFavorite && page.album.trackCount !== page.total) return changed();
    const revision = `mp:${hash([value.favoritesRevision, page.sourceRevision])}`;
    if (held.plan.expectedRevision !== null && held.plan.expectedRevision !== revision) return changed();
    const next = nextCursor(held.query, page.offset, page.items.length, page.total, revision);
    plans.delete(page.planId);
    return snapshot(req, { status: 200, category: 'success', body: { accountDomain: req.scope.accountDomain,
      favoritesRevision: value.favoritesRevision, favorite: f, identity: { source: 'netease', albumId: held.plan.albumId },
      items: page.items, nextCursor: next } }, pageContext(req.scope, held.query, value.favoritesRevision,
      page.offset, fields(req.request).cursor), { domainRevision: value.favoritesRevision, libraryRevision: library });
  }
  function read(req: MobileContentOwnerDispatch): MobileContentOwnerSnapshot {
    checkScope(req.scope); assertAccount(req); if (req.providerFacts) return invalid();
    if (req.operation === 'listRecentlyAddedAlbums') { if (req.providerPage) return invalid(); return recentlyAdded(req); }
    const { value } = domain(req.scope), library = libraryRevision();
    const query = pageQuery(req.operation, req.request, req.scope);
    if (req.operation === 'getFavoriteAlbumState') {
      if (req.providerPage) return invalid();
      const source = fields(req.request).source!, albumId = req.request.pathParameters.albumId!;
      const f = favorite(value, source, albumId);
      return snapshot(req, { status: 200, category: 'success', body: { accountDomain: req.scope.accountDomain,
        favoritesRevision: value.favoritesRevision, identity: { albumId, source }, favorite: f } },
      { ...baseContext(req.scope), source, albumId, revision: value.favoritesRevision },
      { domainRevision: value.favoritesRevision, libraryRevision: library });
    }
    if (req.operation === 'listFavoriteAlbumTracks') {
      if (fields(req.request).favoritesRevision !== value.favoritesRevision) return changed();
      if (fields(req.request).source === 'netease') return providerFavoriteTracks(req, value, library);
      if (req.providerPage) return invalid();
      const albumId = req.request.pathParameters.albumId!, f = favorite(value, 'local', albumId);
      const cursorRevision = `mp:${hash([value.favoritesRevision, library])}`;
      const offset = pageOffset(query, fields(req.request).cursor, cursorRevision);
      let items: MobileTrack[], total: number;
      if (f?.albumFavorite) {
        const page = catalogRead({ operation: 'listTracks', offset, limit: query.limit, q: '', albumId,
          itemId: null, expectedRevision: library });
        items = page.items.map(item => { const result = mobileCatalogResponseSnapshot('track', item); if (!result.ok) return unavailable(); return result.value; }); total = page.total;
      } else {
        const favorites = f?.favoriteTracks ?? []; total = favorites.length;
        items = favorites.slice(offset, offset + query.limit).map(selection => localTrack(selection).track);
      }
      if (libraryRevision() !== library) return changed();
      return snapshot(req, { status: 200, category: 'success', body: { accountDomain: req.scope.accountDomain,
        favoritesRevision: value.favoritesRevision, identity: { source: 'local', albumId }, favorite: f,
        items, nextCursor: nextCursor(query, offset, items.length, total, cursorRevision) } },
      pageContext(req.scope, query, value.favoritesRevision, offset, fields(req.request).cursor),
      { domainRevision: value.favoritesRevision, libraryRevision: library });
    }
    if (req.providerPage) return invalid();
    if (req.operation === 'listFavoriteAlbums') {
      const all = value.favorites.filter(f => query.source === 'all' || f.album.source === query.source);
      const offset = pageOffset(query, fields(req.request).cursor, value.favoritesRevision), items = all.slice(offset, offset + query.limit);
      return snapshot(req, { status: 200, category: 'success', body: { accountDomain: req.scope.accountDomain,
        favoritesRevision: value.favoritesRevision, items, nextCursor: nextCursor(query, offset, items.length, all.length, value.favoritesRevision) } },
      pageContext(req.scope, query, value.favoritesRevision, offset, fields(req.request).cursor),
      { domainRevision: value.favoritesRevision, libraryRevision: library });
    }
    if (req.operation === 'listPersonalPlaylists') {
      const offset = pageOffset(query, fields(req.request).cursor, value.collectionRevision), page = value.playlists.slice(offset, offset + query.limit);
      const first = Object.fromEntries(page.map(p => [p.playlist.playlistId, p.tracks[0] ?? null]));
      return snapshot(req, { status: 200, category: 'success', body: { accountDomain: req.scope.accountDomain,
        collectionRevision: value.collectionRevision, items: page.map(p => p.playlist),
        nextCursor: nextCursor(query, offset, page.length, value.playlists.length, value.collectionRevision) } },
      { ...pageContext(req.scope, query, value.collectionRevision, offset, fields(req.request).cursor), playlistFirstTracks: first },
      { domainRevision: value.collectionRevision, libraryRevision: library });
    }
    if (req.operation === 'listPersonalPlaylistTracks') {
      const p = value.playlists.find(p => p.playlist.playlistId === req.request.pathParameters.playlistId);
      if (!p) throw new MobileServiceError(404, 'SOURCE_CHANGED');
      if (fields(req.request).playlistRevision !== p.playlist.playlistRevision) return changed();
      const cursorRevision = `mp:${hash([p.playlist.playlistRevision, library])}`;
      const offset = pageOffset(query, fields(req.request).cursor, cursorRevision);
      const items = p.tracks.slice(offset, offset + query.limit).map(t => t.source === 'local' ? localTrack(pick(t)).track : t);
      if (libraryRevision() !== library) return changed();
      return snapshot(req, { status: 200, category: 'success', body: { accountDomain: req.scope.accountDomain,
        playlist: p.playlist, items, nextCursor: nextCursor(query, offset, items.length, p.tracks.length, cursorRevision) } },
      { ...pageContext(req.scope, query, p.playlist.playlistRevision, offset, fields(req.request).cursor),
        playlistFirstTracks: { [p.playlist.playlistId]: p.tracks[0] ?? null } },
      { domainRevision: p.playlist.playlistRevision, libraryRevision: library });
    }
    return invalid();
  }
  async function revalidate(req: Extract<MobileContentOwnerRequest, { action: 'revalidate' }>): Promise<MobileContentOwnerResult> {
    checkScope(req.scope);
    if ('commitId' in req) {
      const input: MobileContentMutationInput = { operation: req.operation, request: req.request, scope: req.scope };
      const stable = (value: MobileContentMutationInput) => [value.operation, value.request, value.scope.serverId,
        value.scope.datasetId, value.scope.deviceId, value.scope.deviceEpoch, value.scope.accountDomain];
      if (pending && (pending.commitId !== req.commitId || !same(stable(pending.input), stable(input)))) {
        throw new MobileContentPersistenceError('unknown', pending.commitId);
      }
      // 冷 Owner 没有本代 pending 内存；显式查询仍须核磁盘原 commit，不能凭 key 重新保存。
      const loaded = pending ? initialized().resolve(req.commitId) : initialized().load();
      if (loaded.commitId !== req.commitId) throw new MobileContentPersistenceError('unknown', req.commitId);
      const receipt = lookupMobileContentReceipt(loaded.state, input, limits);
      if (!receipt) throw new MobileContentPersistenceError('unknown', req.commitId);
      pending = undefined;
      const dispatch: MobileContentOwnerDispatch = { action: 'dispatch', operation: req.operation, request: req.request, scope: req.scope };
      return snapshot(dispatch, receipt, mutationContext(dispatch, receipt), { domainRevision: null, libraryRevision: null }, input);
    }
    prune(); const held = snapshots.get(req.snapshotId);
    if (!held || !same(held.scope, req.scope)) return changed();
    if (held.mutation) {
      const loaded = initialized().load(), receipt = lookupMobileContentReceipt(loaded.state, held.mutation, limits);
      if (!receipt || !('reply' in held.result) || !same(held.result.reply, receipt)) return changed();
    } else {
      if (held.domainRevision !== null) {
        const value = domain(req.scope).value;
        const revision = held.operation === 'listPersonalPlaylistTracks'
          ? value.playlists.find(p => p.playlist.playlistId === held.request.pathParameters.playlistId)?.playlist.playlistRevision
          : held.operation === 'listPersonalPlaylists' ? value.collectionRevision : value.favoritesRevision;
        if (held.domainRevision !== revision) return changed();
      }
      if (held.libraryRevision !== null && libraryRevision() !== held.libraryRevision) return changed();
      await held.check?.();
    }
    checkScope(req.scope);
    return { kind: 'content-revalidated', datasetId, ownerEpoch, snapshotId: req.snapshotId };
  }
  async function lyrics(req: Extract<MobileContentOwnerRequest, { action: 'local-lyrics' }>): Promise<MobileContentOwnerResult> {
    checkScope(req.scope); reserveSlot();
    const selected = localTrack(req.selection), revision = selected.revision;
    const controller = new AbortController(); controllers.add(controller);
    try {
      const reader = createMobileContentLocalLyrics({ collection, datasetId, assertCurrent: () => checkScope(req.scope) });
      const proof: MobileLocalLyricsSnapshot = await reader.read(req.selection, selected.track, selected.detail, controller.signal);
      checkScope(req.scope); if (libraryRevision() !== revision) return changed();
      controllers.delete(controller); reserveSlot(); const snapshotId = randomUUID();
      const result: MobileContentOwnerResult = freeze({ kind: 'content-lyrics', datasetId, ownerEpoch,
        libraryRevision: revision, lyrics: proof.lyrics, snapshotId });
      const request = { path: `/mobile/v1/ui/tracks/${encodeURIComponent(req.selection.trackId)}/lyrics`, pathParameters: { trackId: req.selection.trackId },
        query: { source: 'local', versionId: req.selection.versionId, contentRevision: req.selection.contentRevision }, body: null } as MobileRequestMap['getExactTrackLyrics'];
      snapshots.set(snapshotId, { domainRevision: null, libraryRevision: revision, check: proof.beforeSend,
        expiresAt: clock() + MOBILE_CONTENT_OWNER_SNAPSHOT_TTL_MS, scope: req.scope,
        operation: 'getExactTrackLyrics', request, result, mutation: null });
      return result;
    } finally { controllers.delete(controller); }
  }
  function sync(req: MobileContentOwnerRequest): MobileContentOwnerResult {
    current();
    if (req.action === 'initialize') return initialize(req);
    initialized();
    if (req.action === 'context') {
      if (req.serverId !== serverId) return changed();
      return { kind: 'content-context', serverId: serverId!, datasetId, ownerEpoch, libraryRevision: libraryRevision() };
    }
    if (req.action === 'updateScope') return { kind: 'content-scope-updated', datasetId, ownerEpoch, scope: updateScope(req.scope) };
    if (req.action === 'invalidateScope') { invalidate(req); return { kind: 'content-scope-invalidated', datasetId, ownerEpoch, scopeKind: req.kind }; }
    checkScope(req.scope);
    if (req.action === 'lookup-receipt') return lookupReceipt(req);
    if (req.action === 'plan-read') return planRead(req);
    if (req.action === 'local-track') {
      const selected = localTrack(req.selection); checkScope(req.scope);
      return { kind: 'content-track', datasetId, ownerEpoch, libraryRevision: selected.revision, track: selected.track, detail: selected.detail };
    }
    if (req.action === 'local-album') {
      const selected = localAlbum(req.albumId); checkScope(req.scope);
      return { kind: 'content-album', datasetId, ownerEpoch, libraryRevision: selected.revision, album: selected.album };
    }
    if (req.action !== 'dispatch') return invalid();
    assertAccount(req); return isMobileContentMutation(req.operation) ? mutate(req) : read(req);
  }
  function failure(error: unknown): MobileContentOwnerResult {
    return { kind: 'content-error', status: error instanceof MobileServiceError ? error.status : 503,
      code: error instanceof MobileServiceError ? error.code : 'BUSY', retryable: false,
      outcome: error instanceof MobileContentPersistenceError ? error.outcome : null,
      commitId: error instanceof MobileContentPersistenceError ? error.commitId : null };
  }
  return {
    dispatch(raw: MobileContentOwnerRequest): Promise<MobileContentOwnerResult> {
      let flight: Promise<MobileContentOwnerResult>;
      const run = async (): Promise<MobileContentOwnerResult> => {
        let req: MobileContentOwnerRequest;
        try {
          req = captureMobileContentOwnerRequest(raw); current();
          const result = req.action === 'local-lyrics' ? await lyrics(req)
            : req.action === 'revalidate' ? await revalidate(req) : sync(req);
          current(); if (!isMobileContentOwnerResult(result, req)) return unavailable();
          return result;
        } catch (error) { return failure(error); }
      };
      // 同步 mutation 到 rename/fsync 不 yield；仅真正侧车读取和 beforeSend 可以等待。
      flight = run(); active.add(flight); void flight.finally(() => active.delete(flight)); return flight;
    },
    async close(): Promise<void> {
      if (closed) { await Promise.all([...active]); return; }
      closed = true; for (const controller of controllers) controller.abort();
      await Promise.all([...active]); scopes.clear(); snapshots.clear(); plans.clear();
      devices.clear(); invalidProviders.clear(); pending = undefined;
      cursor?.close(); key?.fill(0); key = undefined; serverId = undefined; store = undefined; cursor = undefined;
    },
  };
}
