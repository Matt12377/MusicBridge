import { createHash, createHmac } from 'node:crypto';
import {
  MOBILE_CODEC_LIMITS, MOBILE_CATALOG_SCHEMAS, captureMobileArtist, captureMobileArtistPage,
  isMobileArtistSearchPath, parseMobileArtistSearchRoute, MobileArtistSearchContractError,
  mobileCanonicalJson, mobileCatalogResponseSnapshot, mobileDataSnapshot, mobileInteger,
  mobileProjectSchema, mobileRecord, isMobileId, parseMobileJson,
  type ArtistCatalogArtist, type ArtistSearchCatalogPublicApi, type LocalAlbumSummary,
  type LocalArtistTrackItem, type MobileAlbum, type MobileTrack, type MobileArtist,
  type MobileArtistSearchRoute, type MobileArtistSearchKind, type MobileHeaderPairs, type MobileJsonValue,
} from '@music-bridge/contracts';
import { createMobileCatalogCursorCodec, type MobileCatalogCursorQueryScope } from '../../../../packages/bridge-core/src/mobile/cursor.js';
import { mobileAlbumId, mobileGroupHash, mobileTrackId } from '../../../../packages/bridge-core/src/mobile/local-album-identity.js';
import { captureMobileDirectoryPage, type MobileDirectoryArtist, type MobileDirectoryPage,
  type MobileDirectoryQuery } from '../../../../packages/bridge-core/src/mobile/directory-rpc.js';
import { MobileServiceError, type Mobile001BackendReply, type MobileAuthService,
  type MobilePrincipal, type MobileCatalogSelectedQuery } from '../../../../packages/bridge-core/src/mobile/types.js';

export interface MobileArtistSearchBackendInput {
  method: string; requestTarget: string; headerPairs: MobileHeaderPairs; body: Uint8Array; signal: AbortSignal;
}
export interface MobileArtistSearchBackend {
  dispatch(input: MobileArtistSearchBackendInput): Promise<Mobile001BackendReply>;
  close(): Promise<void>;
}
export interface MobileArtistSearchBackendOptions {
  auth: Pick<MobileAuthService, 'authenticate' | 'assertCurrent'>;
  catalog: {
    getAlbum(id: string, principal: MobilePrincipal): Promise<MobileAlbum>;
    getTrack(id: string, principal: MobilePrincipal): Promise<MobileTrack>;
    selected?(query: MobileCatalogSelectedQuery, principal: MobilePrincipal, signal?: AbortSignal): Promise<readonly (MobileAlbum | MobileTrack)[]>;
  };
  artists: ArtistSearchCatalogPublicApi;
  /** 组合根核对当前工作库及Artist API实例；切库不能借用旧principal继续读取。 */
  assertCatalogCurrent(principal: MobilePrincipal, signal: AbortSignal): void | Promise<void>;
  providerDirectory(principal: MobilePrincipal, query: MobileDirectoryQuery, signal: AbortSignal): Promise<{
    page: MobileDirectoryPage; beforeSend(): Promise<void>;
  }>;
  cursorKey: Uint8Array;
  assertCurrent?(): void;
  now?: () => number;
  requestMs?: number;
  maxInflight?: number;
  closeMs?: number;
}
interface LocalPage<T> {
  items: readonly T[]; offset: number; limit: number; total: number; hasMore: boolean; revision: string;
}
interface ResultPage { items: (MobileArtist | MobileAlbum | MobileTrack)[]; nextOffset: number | null; revision: string }
type SendCheck = (signal: AbortSignal) => Promise<void>;
const fail = (status: ConstructorParameters<typeof MobileServiceError>[0], code: ConstructorParameters<typeof MobileServiceError>[1]): never => {
  throw new MobileServiceError(status, code);
};
const hash = (value: unknown) => createHash('sha256').update(mobileCanonicalJson(value as MobileJsonValue)).digest('hex');
const bounds = { requestMs: 10_000, maxInflight: 16, closeMs: 10_000 } as const;
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,31}$/u.test(value);
function bound(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  return mobileInteger(result, 1, maximum) ? result : fail(400, 'INVALID_REQUEST');
}
function captured<T>(raw: unknown): T {
  const value = mobileDataSnapshot(raw);
  return value.ok ? value.value as unknown as T : fail(503, 'BUSY');
}
function localPage<T>(raw: unknown, offset: number, limit: number, revision: string): LocalPage<T> {
  const value = captured<LocalPage<T>>(raw);
  if (!value || !Array.isArray(value.items) || value.offset !== offset || value.limit !== limit
    || !mobileInteger(value.total, 0, 300_000) || value.items.length > limit
    || value.items.length !== Math.min(limit, Math.max(0, value.total - offset))
    || value.hasMore !== (offset + value.items.length < value.total) || !isMobileId(value.revision)) return fail(503, 'BUSY');
  if (value.revision !== revision) return fail(409, 'SOURCE_CHANGED');
  return value;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
function safeFailure(error: unknown): MobileServiceError {
  if (error instanceof MobileServiceError) return error;
  if (error instanceof MobileArtistSearchContractError) return new MobileServiceError(400, 'INVALID_REQUEST');
  if (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ARTIST_INDEX_PREPARING') {
    return new MobileServiceError(503, 'ARTIST_INDEX_PREPARING', true);
  }
  if (error instanceof Error && error.name === 'LocalArtistSearchError') {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (code === 'INVALID_REQUEST') return new MobileServiceError(400, 'INVALID_REQUEST');
    if (code === 'NOT_FOUND') return new MobileServiceError(404, 'RESOURCE_REVOKED');
    if (code === 'SNAPSHOT_CHANGED') return new MobileServiceError(409, 'SOURCE_CHANGED');
  }
  return new MobileServiceError(503, 'BUSY');
}
function target(raw: string): URL {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 8192
    || /[\u0000-\u0020\u007f#]/u.test(raw)) return fail(400, 'INVALID_REQUEST');
  let value: URL;
  try { value = new URL(raw, 'https://mobile.invalid'); } catch { return fail(400, 'INVALID_REQUEST'); }
  if (value.origin !== 'https://mobile.invalid' || value.pathname !== raw.split('?', 1)[0]) return fail(400, 'INVALID_REQUEST');
  return value;
}
export function isMobileArtistSearchRequestTarget(raw: string): boolean {
  try { return isMobileArtistSearchPath(target(raw).pathname); } catch { return false; }
}
function headers(raw: MobileHeaderPairs): Map<string, string> {
  const value = mobileDataSnapshot(raw, MOBILE_CODEC_LIMITS, 'request');
  if (!value.ok || !Array.isArray(value.value) || value.value.length > 64) return fail(400, 'INVALID_REQUEST');
  const result = new Map<string, string>();
  for (const entry of value.value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(entry[0]) || /[\r\n\u0000]/u.test(entry[1])) return fail(400, 'INVALID_REQUEST');
    const name = entry[0].toLowerCase();
    if (['authorization', 'content-type', 'content-length'].includes(name) && result.has(name)) return fail(400, 'INVALID_REQUEST');
    result.set(name, entry[1]);
  }
  return result;
}
function coreArtist(value: ArtistCatalogArtist): MobileArtist {
  const result: MobileArtist = {
    id: value.id, name: value.name, source: value.source, albumCount: value.albumCount, trackCount: value.trackCount,
    ...(value.linkedNeteaseId === undefined ? {} : { linkedNeteaseId: value.linkedNeteaseId }),
    ...(value.linkState === undefined ? {} : { linkState: value.linkState }),
  };
  const checked = captureMobileArtist(result);
  return checked.ok ? checked.value : fail(503, 'BUSY');
}
function cleanCatalog<T extends MobileAlbum | MobileTrack>(raw: T, kind: 'albums' | 'tracks', source: 'local' | 'netease'): T {
  const checked = mobileCatalogResponseSnapshot(kind === 'tracks' ? 'track' : 'album', raw);
  if (!checked.ok || checked.value.source !== source) return fail(503, 'BUSY');
  return mobileProjectSchema(MOBILE_CATALOG_SCHEMAS[kind === 'tracks' ? 'Track' : 'Album']!,
    checked.value as unknown as MobileJsonValue, MOBILE_CATALOG_SCHEMAS) as unknown as T;
}

/** 可注入的HTTP门面；不创建凭据、Provider、索引或第二套本地音乐namespace。 */
export function createMobileArtistSearchBackend(options: MobileArtistSearchBackendOptions): MobileArtistSearchBackend {
  if (!(options.cursorKey instanceof Uint8Array) || options.cursorKey.byteLength !== 32
    || typeof options.assertCatalogCurrent !== 'function' || typeof options.providerDirectory !== 'function') return fail(400, 'INVALID_REQUEST');
  const requestMs = bound(options.requestMs, bounds.requestMs), maxInflight = bound(options.maxInflight, bounds.maxInflight);
  const closeMs = bound(options.closeMs, bounds.closeMs);
  const domainKey = createHmac('sha256', options.cursorKey).update('Mousa:4.1:ARTIST_SEARCH_CURSOR:1').digest();
  const cursor = createMobileCatalogCursorCodec({ key: domainKey, version: 2, ...(options.now ? { now: options.now } : {}) });
  domainKey.fill(0);
  const lifecycle = new AbortController(), active = new Set<Promise<unknown>>(), controllers = new Set<AbortController>();
  let closing = false, closeFlight: Promise<void> | undefined;
  function current(signal: AbortSignal): void {
    if (closing || signal.aborted) return fail(503, 'BUSY');
    options.assertCurrent?.();
  }
  async function assert(principal: MobilePrincipal, signal: AbortSignal): Promise<void> {
    current(signal); await options.auth.assertCurrent(principal); current(signal);
    await options.assertCatalogCurrent(principal, signal); current(signal);
  }
  async function owned<T>(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closing || parent.aborted || active.size >= maxInflight) return fail(503, 'BUSY');
    const controller = new AbortController(); controllers.add(controller);
    const cancel = () => controller.abort();
    parent.addEventListener('abort', cancel, { once: true });
    if (parent.aborted) cancel();
    const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
    const timer = setTimeout(cancel, requestMs);
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new MobileServiceError(503, 'BUSY'));
    signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    const flight = Promise.resolve().then(() => { current(signal); return operation(signal); });
    active.add(flight);
    void flight.then(() => active.delete(flight), () => active.delete(flight));
    try { return await Promise.race([flight, aborted]); }
    catch (error) { throw safeFailure(error); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); parent.removeEventListener('abort', cancel); controllers.delete(controller); }
  }
  async function revision(principal: MobilePrincipal, signal: AbortSignal): Promise<string> {
    await assert(principal, signal);
    const page = captured<LocalPage<ArtistCatalogArtist>>(await options.artists.listArtists({ query: '', offset: 0, limit: 1 }));
    current(signal);
    if (!isMobileId(page.revision)) return fail(503, 'BUSY');
    localPage(page, 0, 1, page.revision);
    return page.revision;
  }
  function scope(route: MobileArtistSearchRoute, principal: MobilePrincipal): MobileCatalogCursorQueryScope {
    return {
      operation: route.kind === 'tracks' ? 'listTracks' : 'listAlbums',
      serverId: principal.serverId, deviceId: principal.deviceId, datasetId: principal.datasetId, accountDomain: principal.accountDomain,
      deviceEpoch: principal.deviceEpoch, generation: principal.generation, source: route.source,
      sort: 'MOUSA_41_ARTIST_SEARCH_V1', albumId: route.artistId, limit: route.limit,
      filter: hash({ operation: route.operation, kind: route.kind, source: route.source, query: route.query,
        artistId: route.artistId, relation: route.relation }),
    };
  }
  async function directory(principal: MobilePrincipal, query: MobileDirectoryQuery, signal: AbortSignal,
                           sendChecks: SendCheck[]): Promise<MobileDirectoryPage> {
    await assert(principal, signal);
    const result = await options.providerDirectory(principal, query, signal); current(signal);
    if (!result || typeof result.beforeSend !== 'function') return fail(503, 'BUSY');
    const raw = captured<MobileDirectoryPage>(result.page);
    if (query.expectedRevision !== null && raw.revision !== query.expectedRevision) return fail(409, 'SOURCE_CHANGED');
    let page: MobileDirectoryPage;
    try { page = captureMobileDirectoryPage(raw, query); } catch { return fail(503, 'BUSY'); }
    const beforeSend = result.beforeSend;
    sendChecks.push(async () => { await beforeSend(); });
    await assert(principal, signal);
    return page;
  }
  function checkArtistPage(page: LocalPage<ArtistCatalogArtist>, query: string, sendChecks: SendCheck[]): void {
    const original = hash(page.items.map(coreArtist));
    sendChecks.push(async signal => {
      // listArtists只读取本地索引和已缓存关联；getArtist会按需联网匹配，不能用于列表复核。
      const latest = localPage<ArtistCatalogArtist>(await options.artists.listArtists({ query, offset: page.offset,
        limit: page.limit }), page.offset, page.limit, page.revision);
      current(signal);
      if (latest.total !== page.total || hash(latest.items.map(coreArtist)) !== original) return fail(409, 'SOURCE_CHANGED');
    });
  }
  function checkArtist(raw: ArtistCatalogArtist, stamp: string, sendChecks: SendCheck[]): void {
    const value = coreArtist(captured<ArtistCatalogArtist>(raw)), original = hash(value);
    const query = [...value.name].slice(0, 256).join('');
    sendChecks.push(async signal => {
      let offset = 0;
      do {
        current(signal);
        const page = localPage<ArtistCatalogArtist>(await options.artists.listArtists({ query, offset, limit: 200 }), offset, 200, stamp);
        current(signal);
        const selected = page.items.find(item => item.id === value.id);
        if (selected) {
          if (hash(coreArtist(selected)) !== original) return fail(409, 'SOURCE_CHANGED');
          return;
        }
        if (!page.hasMore) return fail(409, 'SOURCE_CHANGED');
        offset += page.items.length;
      } while (true);
    });
  }
  async function album(item: LocalAlbumSummary, principal: MobilePrincipal, signal: AbortSignal): Promise<MobileAlbum> {
    current(signal);
    const id = mobileAlbumId(principal.datasetId, item.rootId, item.id);
    const value = cleanCatalog(await options.catalog.getAlbum(id, principal), 'albums', 'local'); current(signal);
    if (value.id !== id) return fail(409, 'SOURCE_CHANGED');
    return value;
  }
  async function track(item: LocalArtistTrackItem, principal: MobilePrincipal, signal: AbortSignal): Promise<MobileTrack> {
    current(signal);
    const id = mobileTrackId(principal.datasetId, item.track.id, mobileGroupHash(item.rootId, item.albumKey));
    const value = cleanCatalog(await options.catalog.getTrack(id, principal), 'tracks', 'local'); current(signal);
    if (value.id !== id || value.albumId !== mobileAlbumId(principal.datasetId, item.rootId, item.albumKey)) return fail(409, 'SOURCE_CHANGED');
    return value;
  }
  async function selectedWorks(kind: 'albums' | 'tracks', rows: readonly (LocalAlbumSummary | LocalArtistTrackItem)[],
    stamp: string, principal: MobilePrincipal, signal: AbortSignal, sendChecks: SendCheck[]): Promise<Array<MobileAlbum | MobileTrack>> {
    const select = options.catalog.selected;
    // 保留旧注入端口；正式组合根始终提供受限整页读取。
    if (!select) return kind === 'albums'
      ? mapBounded(rows as LocalAlbumSummary[], item => album(item, principal, signal))
      : mapBounded(rows as LocalArtistTrackItem[], item => track(item, principal, signal));
    const ids = Object.freeze(rows.map(item => kind === 'albums'
      ? mobileAlbumId(principal.datasetId, item.rootId, (item as LocalAlbumSummary).id)
      : mobileTrackId(principal.datasetId, (item as LocalArtistTrackItem).track.id,
        mobileGroupHash(item.rootId, (item as LocalArtistTrackItem).albumKey))));
    const query: MobileCatalogSelectedQuery = Object.freeze({ kind, ids, sourceRevision: stamp });
    async function read(currentSignal: AbortSignal): Promise<Array<MobileAlbum | MobileTrack>> {
      current(currentSignal);
      const raw = captured<readonly (MobileAlbum | MobileTrack)[]>(await select!(query, principal, currentSignal));
      current(currentSignal);
      if (!Array.isArray(raw) || raw.length !== ids.length) return fail(409, 'SOURCE_CHANGED');
      return raw.map((item, index) => {
        const value = cleanCatalog(item, kind, 'local');
        if (value.id !== ids[index] || kind === 'tracks' && (value as MobileTrack).albumId !== mobileAlbumId(principal.datasetId,
          rows[index]!.rootId, (rows[index] as LocalArtistTrackItem).albumKey)) return fail(409, 'SOURCE_CHANGED');
        return value;
      });
    }
    const items = await read(signal), original = hash(items);
    sendChecks.push(async sendSignal => { if (hash(await read(sendSignal)) !== original) return fail(409, 'SOURCE_CHANGED'); });
    return items;
  }
  async function artist(raw: ArtistCatalogArtist, principal: MobilePrincipal, signal: AbortSignal,
                        sendChecks: SendCheck[], enrich: boolean): Promise<MobileArtist> {
    const value = coreArtist(captured<ArtistCatalogArtist>(raw));
    if (value.source !== 'local') return fail(503, 'BUSY');
    // 代表专辑只贡献原有封面引用；不由人物名字生成另一套封面或音乐身份。
    try {
      const albums = captured<LocalPage<LocalAlbumSummary>>(await options.artists.listArtistAlbums({ artistId: value.id, relation: 'albums', offset: 0, limit: 1 }));
      if (albums.items[0]) {
        const representative = await album(albums.items[0], principal, signal);
        if (representative.artworkId !== undefined) value.artworkId = representative.artworkId;
      }
    } catch (error) { if (signal.aborted || error instanceof MobileServiceError && [401, 403, 409].includes(error.status)) throw error; }
    if (enrich && value.linkedNeteaseId !== undefined) {
      try {
        const page = await directory(principal, { kind: 'artists', query: '', artistId: value.linkedNeteaseId,
          offset: 0, limit: 1, expectedRevision: null }, signal, sendChecks);
        const profile = page.items[0] as MobileDirectoryArtist | undefined;
        if (profile && profile.id === value.linkedNeteaseId) {
          if (profile.artworkId !== undefined) value.artworkId = profile.artworkId;
          if (profile.biography !== undefined) value.biography = profile.biography;
          value.credit = profile.credit ?? '人物资料来自网易云';
        }
      } catch (error) {
        // 人物资料失败不抹掉本地曲目；认证/切库失败仍必须阻止发送。
        if (signal.aborted || error instanceof MobileServiceError && [401, 403, 409].includes(error.status)) throw error;
      }
    }
    const checked = captureMobileArtist(value);
    return checked.ok ? checked.value : fail(503, 'BUSY');
  }
  async function mapBounded<T, U>(items: readonly T[], transform: (item: T) => Promise<U>): Promise<U[]> {
    const output: U[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) { const index = next++; output[index] = await transform(items[index]!); }
    }));
    return output;
  }
  function matches(item: LocalAlbumSummary | LocalArtistTrackItem, query: string): boolean {
    if (!query) return true;
    const fields = 'metadata' in item ? [item.metadata.title ?? '', item.metadata.artist ?? '', item.metadata.album ?? '',
      ...(item.metadata.artists ?? []), ...(item.metadata.albumArtists ?? [])] : [item.title, ...item.artists];
    const haystack = fields.join(' ').normalize('NFKC').toLocaleLowerCase('und');
    return query.normalize('NFKC').toLocaleLowerCase('und').split(/\s+/u).every(word => haystack.includes(word));
  }
  async function localWorks(route: MobileArtistSearchRoute, offset: number, stamp: string, principal: MobilePrincipal,
                            signal: AbortSignal, sendChecks: SendCheck[]): Promise<ResultPage> {
    const rows: (LocalAlbumSummary | LocalArtistTrackItem)[] = [];
    let position = offset, nextOffset: number | null = null;
    // 带查询的作品页按原索引稳定顺序扫描；签名游标保存原行位置，不能把已过滤页的长度当成offset。
    do {
      await assert(principal, signal);
      const limit = route.query ? 100 : route.limit;
      const raw = route.kind === 'albums'
        ? await options.artists.listArtistAlbums({ artistId: route.artistId!, relation: route.relation, offset: position, limit })
        : await options.artists.listArtistTracks({ artistId: route.artistId!, offset: position, limit });
      const page = localPage<LocalAlbumSummary | LocalArtistTrackItem>(raw, position, limit, stamp);
      for (let index = 0; index < page.items.length; index++) {
        const item = page.items[index]!;
        if (matches(item, route.query)) rows.push(item);
        position = page.offset + index + 1;
        if (rows.length === route.limit) {
          nextOffset = position < page.total ? position : null;
          break;
        }
      }
      if (rows.length === route.limit || !page.hasMore) break;
      if (page.items.length === 0 || position > 300_000) return fail(503, 'BUSY');
    } while (true);
    const items = await selectedWorks(route.kind as 'albums' | 'tracks', rows, stamp, principal, signal, sendChecks);
    return { items, nextOffset, revision: stamp };
  }
  const backend: MobileArtistSearchBackend = {
    async dispatch(input) {
      if (!input || typeof input !== 'object'
        || Reflect.ownKeys(input).length !== 5
        || !['method', 'requestTarget', 'headerPairs', 'body', 'signal'].every(key => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
        }) || !(input.signal instanceof AbortSignal) || !(input.body instanceof Uint8Array)) return fail(400, 'INVALID_REQUEST');
      const url = target(input.requestTarget), header = headers(input.headerPairs);
      const length = header.get('content-length');
      if (length !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) !== input.body.byteLength)
        || header.has('transfer-encoding') || header.has('content-encoding') && header.get('content-encoding') !== 'identity') return fail(400, 'INVALID_REQUEST');
      const authorization = header.get('authorization');
      const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_.~-]{1,4096})$/u)?.[1];
      if (!bearer) return fail(401, 'UNAUTHORIZED');
      if (input.body.byteLength > 4096) return fail(413, 'INVALID_REQUEST');
      let body: unknown = null;
      if (input.body.byteLength > 0) {
        if (input.method !== 'PUT' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(header.get('content-type') ?? '')) return fail(400, 'INVALID_REQUEST');
        const parsed = parseMobileJson(input.body, { ...MOBILE_CODEC_LIMITS, requestBytes: 4096 }, 'request');
        if (!parsed.ok) return fail(400, 'INVALID_REQUEST'); body = parsed.value;
      }
      let route: MobileArtistSearchRoute;
      try { route = parseMobileArtistSearchRoute({ method: input.method, path: url.pathname, query: [...url.searchParams], body }); }
      catch (error) { throw safeFailure(error); }
      const parent = input.signal;
      return owned(parent, async signal => {
        const principal = await options.auth.authenticate(bearer);
        await assert(principal, signal);
        const sendChecks: SendCheck[] = [];
        let localStamp: string | null = null;
        if (route.source === 'local') localStamp = await revision(principal, signal);
        if (route.operation === 'listLibraryArtistMatches' && !route.query) {
          const selected = coreArtist(captured<ArtistCatalogArtist>(await options.artists.getArtist({ artistId: route.artistId! })));
          route = { ...route, query: selected.name };
        }
        const queryScope = scope(route, principal);
        const previous = route.cursor === null ? null : cursor.open(route.cursor, queryScope);
        const offset = previous?.offset ?? 0;
        let response: unknown;
        if (route.operation === 'getLibraryArtist' || route.operation === 'setLibraryArtistLink') {
          if (route.source === 'local') {
            const selected = route.operation === 'setLibraryArtistLink'
              ? await options.artists.bindArtist({ artistId: route.artistId!, neteaseArtistId: route.neteaseArtistId })
              : await options.artists.getArtist({ artistId: route.artistId! });
            if (selected.id !== route.artistId || selected.source !== 'local'
              || route.operation === 'setLibraryArtistLink' && (selected.linkedNeteaseId ?? null) !== route.neteaseArtistId) return fail(409, 'SOURCE_CHANGED');
            checkArtist(selected, localStamp!, sendChecks);
            response = await artist(selected, principal, signal, sendChecks, true);
          } else {
            const page = await directory(principal, { kind: 'artists', artistId: route.artistId,
              query: '', offset: 0, limit: 1, expectedRevision: null }, signal, sendChecks);
            if (page.items.length !== 1 || page.items[0]!.id !== route.artistId) return fail(404, 'RESOURCE_REVOKED');
            const selected = captureMobileArtist(page.items[0]);
            if (!selected.ok) return fail(503, 'BUSY'); response = selected.value;
          }
        } else {
          let result: ResultPage;
          const remote = route.source === 'netease' || route.operation === 'listLibraryArtistMatches';
          if (remote) {
            const page = await directory(principal, { kind: route.kind, query: route.query,
              artistId: route.operation === 'listLibraryArtistMatches' ? null : route.artistId,
              offset, limit: route.limit, expectedRevision: previous?.libraryRevision ?? null }, signal, sendChecks);
            result = { items: page.items, nextOffset: page.nextOffset, revision: page.revision };
          } else if (route.artistId !== null) {
            result = await localWorks(route, offset, localStamp!, principal, signal, sendChecks);
          } else if (route.operation === 'listLibraryArtists') {
            const page = localPage<ArtistCatalogArtist>(await options.artists.listArtists({ query: route.query, offset, limit: route.limit }), offset, route.limit, localStamp!);
            checkArtistPage(page, route.query, sendChecks);
            result = { items: await mapBounded(page.items, item => artist(item, principal, signal, sendChecks, false)),
              nextOffset: page.hasMore ? offset + page.items.length : null, revision: page.revision };
          } else {
            const searched = captured<Awaited<ReturnType<ArtistSearchCatalogPublicApi['search']>>>(await options.artists.search({ query: route.query, offset, limit: route.limit }));
            if (searched.query !== route.query || searched.revision !== localStamp) return fail(409, 'SOURCE_CHANGED');
            if (route.kind === 'artists') {
              const page = localPage<ArtistCatalogArtist>(searched.artists, offset, route.limit, localStamp!);
              checkArtistPage(page, route.query, sendChecks);
              result = { items: await mapBounded(page.items, item => artist(item, principal, signal, sendChecks, false)),
                nextOffset: page.hasMore ? offset + page.items.length : null, revision: page.revision };
            } else if (route.kind === 'albums') {
              const page = localPage<LocalAlbumSummary>(searched.albums, offset, route.limit, localStamp!);
              result = { items: await selectedWorks('albums', page.items, localStamp!, principal, signal, sendChecks),
                nextOffset: page.hasMore ? offset + page.items.length : null, revision: page.revision };
            } else {
              const page = localPage<LocalArtistTrackItem>(searched.tracks, offset, route.limit, localStamp!);
              result = { items: await selectedWorks('tracks', page.items, localStamp!, principal, signal, sendChecks),
                nextOffset: page.hasMore ? offset + page.items.length : null, revision: page.revision };
            }
          }
          if (!isMobileId(result.revision) || previous !== null && previous.libraryRevision !== result.revision) return fail(409, 'SOURCE_CHANGED');
          const nextCursor = result.nextOffset === null ? null : cursor.issue({ ...queryScope, offset: result.nextOffset,
            ownerEpoch: hash([principal.datasetId, result.revision]), libraryRevision: result.revision });
          response = { items: result.items, nextCursor, libraryRevision: result.revision };
          if (route.kind === 'artists') {
            const checked = captureMobileArtistPage(response, remote ? 'netease' : 'local');
            if (!checked.ok) return fail(503, 'BUSY'); response = checked.value;
          } else {
            const checked = mobileCatalogResponseSnapshot(route.kind === 'tracks' ? 'trackPage' : 'albumPage', response);
            if (!checked.ok || checked.value.items.some(item => item.source !== route.source)
              || new Set(checked.value.items.map(item => item.id)).size !== checked.value.items.length) return fail(503, 'BUSY');
            response = checked.value;
          }
        }
        await assert(principal, signal);
        if (localStamp !== null && await revision(principal, signal) !== localStamp) return fail(409, 'SOURCE_CHANGED');
        const snapshot = mobileDataSnapshot(response);
        if (!snapshot.ok) return fail(503, 'BUSY');
        const bytes = new TextEncoder().encode(mobileCanonicalJson(snapshot.value));
        if (bytes.byteLength > MOBILE_CODEC_LIMITS.responseBytes) return fail(503, 'CONTENT_LIMIT_EXCEEDED');
        const original = new Uint8Array(bytes);
        return { status: 200,
          headers: [['Content-Type', 'application/json; charset=utf-8'], ['Cache-Control', 'private, no-store'], ['Content-Length', String(bytes.byteLength)]],
          body: bytes,
          beforeSend: () => owned(parent, async sendSignal => {
            await assert(principal, sendSignal);
            for (const check of sendChecks) { await check(sendSignal); current(sendSignal); }
            if (localStamp !== null && await revision(principal, sendSignal) !== localStamp) return fail(409, 'SOURCE_CHANGED');
            await assert(principal, sendSignal);
            if (!sameBytes(bytes, original)) return fail(503, 'BUSY');
          }),
        };
      });
    },
    close() {
      if (closeFlight) return closeFlight;
      closing = true; lifecycle.abort(); controllers.forEach(controller => controller.abort()); cursor.close();
      closeFlight = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new MobileServiceError(503, 'BUSY')), closeMs);
        void Promise.allSettled([...active]).then(() => { clearTimeout(timer); resolve(); });
      });
      return closeFlight;
    },
  };
  return backend;
}
