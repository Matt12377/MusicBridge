import { createHash } from 'node:crypto';
import {
  MOBILE_API_RESPONSE_MAX_BYTES, MOBILE_CATALOG_SCHEMAS, MOBILE_CODEC_LIMITS,
  isFileAudioParameters, isLocalLibraryTrackDetail, isMobileAudioInfo, isMobileId, mapLocalDetailToMobileTrack,
  mobileCanonicalJson, mobileCatalogRequestSnapshot, mobileCatalogResponseSnapshot,
  mobileDataSnapshot, mobileDateTime, mobileInteger, mobileProjectSchema, mobileRecord,
  mobileUtf8Bytes,
  type FileAudioParameters, type MobileAlbum, type MobileAlbumPage, type MobileAudioInfo, type MobileSearchQuery, type MobileTrack,
  type MobileTrackPage,
} from '@music-bridge/contracts';
import { createMobileCatalogCursorCodec, type MobileCatalogCursorQueryScope } from './cursor.js';
import {
  MobileServiceError, type MobileAuthService, type MobileCatalogReadPort,
  type MobileOwnerArtworkSnapshot,
  type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot,
  type MobileOwnerLocalTrackFacts, type MobilePrincipal,
} from './types.js';

const fail = (status: MobileServiceError['status'], code: MobileServiceError['code']): never => {
  throw new MobileServiceError(status, code);
};
const closed = (value: Record<string, unknown>, names: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const snapshotKeys = ['datasetId', 'ownerEpoch', 'libraryRevision', 'operation', 'offset', 'limit', 'total', 'items'] as const;
const principalKeys = ['serverId', 'deviceId', 'datasetId', 'accountDomain', 'deviceEpoch', 'generation', 'accessTokenHash', 'accessExpiresAt'] as const;
const limits = { ...MOBILE_CODEC_LIMITS, responseBytes: MOBILE_API_RESPONSE_MAX_BYTES };

/** 与当前 Source direct 白名单一致；可解析不等于已支持传输，PCM 还需核真实标准头。 */
export function mobileOwnerDirectPlaybackKind(parameters: FileAudioParameters): 'encoded' | 'WAVE' | 'AIFF' | null {
  if (!isFileAudioParameters(parameters) || parameters.durationMs === null) return null;
  const codec = parameters.codec.toLowerCase(), bits = parameters.bitsPerSample;
  let normalized: string, container: string, kind: 'encoded' | 'WAVE' | 'AIFF';
  if (parameters.container === 'FLAC' && codec === 'flac' && parameters.lossless === true && bits !== null) {
    normalized = 'flac'; container = 'flac'; kind = 'encoded';
  } else if (parameters.container === 'MP4' && /^(?:alac|apple lossless)$/u.test(codec) && parameters.lossless === true && bits !== null) {
    normalized = 'alac'; container = 'm4a'; kind = 'encoded';
  } else if (parameters.container === 'MPEG' && /^(?:mp3|mpeg (?:1|2|2\.5) layer (?:3|iii))$/u.test(codec) && parameters.lossless !== true) {
    normalized = 'mp3'; container = 'mp3'; kind = 'encoded';
  } else if (['WAVE', 'AIFF'].includes(parameters.container) && parameters.lossless === true && bits !== null && [8, 16, 24, 32].includes(bits)) {
    const expected = bits === 8 ? parameters.container === 'WAVE' ? 'pcm_u8' : 'pcm_s8'
      : `pcm_s${bits}${parameters.container === 'WAVE' ? 'le' : 'be'}`;
    if (codec !== 'pcm' && codec !== expected) return null;
    normalized = expected; container = parameters.container === 'WAVE' ? 'wav' : 'aiff';
    kind = parameters.container === 'WAVE' ? 'WAVE' : 'AIFF';
  } else return null;
  const source: MobileAudioInfo = { codec: normalized, container, sampleRateHz: parameters.sampleRateHz, channels: parameters.channels,
    ...(bits === null ? {} : { bitsPerSample: bits }) };
  return isMobileAudioInfo(source) ? kind : null;
}

/** 原Owner完整事实的纯投影；不能从位置、扩展名或未知发行补造可点播身份。 */
export function projectMobileOwnerLocalTrack(facts: MobileOwnerLocalTrackFacts): MobileTrack {
  const captured = mobileDataSnapshot(facts, limits);
  if (!captured.ok || !mobileRecord(captured.value) || !closed(captured.value, ['detail', 'binding', 'projection'])) return fail(503, 'BUSY');
  const value = captured.value as unknown as MobileOwnerLocalTrackFacts, { binding, projection } = value;
  let { detail } = value;
  if (!isLocalLibraryTrackDetail(detail) || !detail.fileParameters
    || !mobileRecord(binding) || !mobileRecord(projection)) return fail(503, 'BUSY');
  if (detail.fileParameters.codec.toLowerCase() === 'flac' && detail.fileParameters.bitsPerSample === null) return fail(503, 'BUSY');
  const segment = detail.track.segment;
  if (segment !== null) {
    const asset = detail.asset;
    if (asset.sampleFrames === null || asset.timebaseHz !== segment.timebaseHz
      || binding.segmentId !== segment.id) return fail(503, 'BUSY');
    const start = BigInt(segment.startFrame), end = BigInt(segment.endFrameExclusive), rate = BigInt(segment.timebaseHz);
    if (start >= end || end > BigInt(asset.sampleFrames)) return fail(503, 'BUSY');
    const duration = ((end - start) * 1000n + rate / 2n) / rate;
    if (duration > BigInt(Number.MAX_SAFE_INTEGER)) return fail(503, 'BUSY');
    detail = { ...detail, fileParameters: { ...detail.fileParameters, durationMs: Number(duration) } };
  }
  const mapped = mapLocalDetailToMobileTrack(detail, binding, projection);
  if (!mapped.ok) return fail(503, 'BUSY');
  return mapped.value;
}

/** 只消费真实Owner的同快照有限回包；签名与设备授权不来自HTTP自报事实。 */
export function createMobileCatalogService(options: {
  port: MobileCatalogReadPort; auth: MobileAuthService; serverId: string; datasetId: string;
  cursorKey: Uint8Array; now?: () => number;
}) {
  if (!isMobileId(options.serverId) || !isMobileId(options.datasetId)) return fail(400, 'INVALID_REQUEST');
  const now = options.now ?? Date.now;
  const cursor = createMobileCatalogCursorCodec({ key: options.cursorKey, now });
  let ownerEpoch: string | null = null;
  function principal(raw: MobilePrincipal): MobilePrincipal {
    const captured = mobileDataSnapshot(raw, limits, 'request');
    if (!captured.ok || !mobileRecord(captured.value) || !closed(captured.value, principalKeys)) return fail(401, 'UNAUTHORIZED');
    const p = captured.value as unknown as MobilePrincipal, time = now();
    if (![p.serverId, p.deviceId, p.datasetId, p.accountDomain].every(isMobileId)
      || p.serverId !== options.serverId || p.datasetId !== options.datasetId
      || !mobileInteger(p.deviceEpoch, 1) || !mobileInteger(p.generation, 1)
      || typeof p.accessTokenHash !== 'string' || !/^[a-f0-9]{64}$/u.test(p.accessTokenHash)
      || !mobileInteger(time) || !mobileDateTime(p.accessExpiresAt) || Date.parse(p.accessExpiresAt) <= time) return fail(401, 'UNAUTHORIZED');
    return p;
  }
  // 品牌只存在于原authenticate对象；值snapshot不能替代可信授权凭证。
  async function current(p: MobilePrincipal): Promise<void> { await options.auth.assertCurrent(p); }
  function header(datasetId: string, epoch: string, revision: string): void {
    if (datasetId !== options.datasetId || !isMobileId(epoch) || !isMobileId(revision)) return fail(409, 'SOURCE_CHANGED');
    if (ownerEpoch !== null && ownerEpoch !== epoch) return fail(409, 'SOURCE_CHANGED');
    ownerEpoch = epoch;
  }
  function snapshot(raw: MobileOwnerCatalogSnapshot, request: MobileOwnerCatalogRequest): MobileOwnerCatalogSnapshot {
    const captured = mobileDataSnapshot(raw, limits);
    if (!captured.ok) return fail(503, captured.issue.code === 'LIMIT_EXCEEDED' ? 'CONTENT_LIMIT_EXCEEDED' : 'BUSY');
    if (!mobileRecord(captured.value) || !closed(captured.value, snapshotKeys)) return fail(503, 'BUSY');
    const value = captured.value as unknown as MobileOwnerCatalogSnapshot;
    header(value.datasetId, value.ownerEpoch, value.libraryRevision);
    if (value.operation !== request.operation || value.offset !== request.offset || value.limit !== request.limit
      || !mobileInteger(value.total) || !Array.isArray(value.items) || value.offset > value.total
      || value.items.length !== Math.min(value.limit, value.total - value.offset)) return fail(409, 'SOURCE_CHANGED');
    if (request.expectedRevision !== null && value.libraryRevision !== request.expectedRevision) return fail(409, 'SOURCE_CHANGED');
    const isAlbum = request.operation === 'listAlbums' || request.operation === 'getAlbum';
    const items = value.items.map(rawItem => {
      const checked = mobileCatalogResponseSnapshot(isAlbum ? 'album' : 'track', rawItem);
      if (!checked.ok || checked.value.source !== 'local') return fail(503, 'BUSY');
      const item = mobileProjectSchema(MOBILE_CATALOG_SCHEMAS[isAlbum ? 'Album' : 'Track']!, checked.value as unknown as Parameters<typeof mobileProjectSchema>[1], MOBILE_CATALOG_SCHEMAS) as unknown as MobileAlbum | MobileTrack;
      if (request.albumId !== null && (isAlbum ? item.id !== request.albumId : (item as MobileTrack).albumId !== request.albumId)) return fail(409, 'SOURCE_CHANGED');
      if (request.itemId !== null && item.id !== request.itemId) return fail(409, 'SOURCE_CHANGED');
      return item;
    });
    if (new Set(items.map(item => item.id)).size !== items.length) return fail(409, 'SOURCE_CHANGED');
    return { ...value, items };
  }
  function search(raw: MobileSearchQuery, operation: 'listAlbums' | 'listTracks'): MobileSearchQuery {
    const checked = mobileCatalogRequestSnapshot('search', raw);
    if (!checked.ok || operation === 'listAlbums' && Object.hasOwn(checked.value, 'albumId')) return fail(400, 'INVALID_REQUEST');
    if (checked.value.source !== undefined && checked.value.source !== 'local') return fail(503, 'BUSY');
    return checked.value;
  }
  function queryScope(query: MobileSearchQuery, operation: 'listAlbums' | 'listTracks', p: MobilePrincipal): MobileCatalogCursorQueryScope {
    const q = (query.q ?? '').trim(), albumId = query.albumId ?? null;
    const filter = createHash('sha256').update(mobileCanonicalJson({ q, albumId, source: 'local', operation })).digest('hex');
    return { operation, serverId: p.serverId, deviceId: p.deviceId, datasetId: p.datasetId, accountDomain: p.accountDomain,
      deviceEpoch: p.deviceEpoch, generation: p.generation, source: 'local', sort: 'OWNER_LOCAL_ORDER_V1', filter, albumId, limit: query.limit ?? 50 };
  }
  async function page(operation: 'listAlbums' | 'listTracks', query: MobileSearchQuery, rawPrincipal: MobilePrincipal): Promise<MobileAlbumPage | MobileTrackPage> {
    const p = principal(rawPrincipal); await current(rawPrincipal);
    const selection = search(query, operation), scope = queryScope(selection, operation, p);
    const previous = selection.cursor === undefined ? null : cursor.open(selection.cursor, scope);
    const request: MobileOwnerCatalogRequest = { operation, serverId: options.serverId, offset: previous?.offset ?? 0, limit: scope.limit,
      q: (selection.q ?? '').trim(), albumId: scope.albumId, itemId: null, expectedRevision: previous?.libraryRevision ?? null };
    const value = snapshot(await options.port.read(request), request); await current(rawPrincipal);
    if (previous !== null && previous.ownerEpoch !== value.ownerEpoch) return fail(409, 'SOURCE_CHANGED');
    const nextOffset = value.offset + value.items.length;
    if (!mobileInteger(nextOffset)) return fail(503, 'CONTENT_LIMIT_EXCEEDED');
    const nextCursor = nextOffset < value.total ? cursor.issue({ ...scope, ownerEpoch: value.ownerEpoch, libraryRevision: value.libraryRevision, offset: nextOffset }) : null;
    const reply = { items: value.items, nextCursor, libraryRevision: value.libraryRevision };
    if (mobileUtf8Bytes(mobileCanonicalJson(reply as unknown as Parameters<typeof mobileCanonicalJson>[0])) > MOBILE_API_RESPONSE_MAX_BYTES) return fail(503, 'CONTENT_LIMIT_EXCEEDED');
    await current(rawPrincipal);
    return reply as MobileAlbumPage | MobileTrackPage;
  }
  async function detail(operation: 'getAlbum' | 'getTrack', id: string, rawPrincipal: MobilePrincipal): Promise<MobileAlbum | MobileTrack> {
    principal(rawPrincipal); await current(rawPrincipal);
    if (!isMobileId(id)) return fail(400, 'INVALID_REQUEST');
    const request: MobileOwnerCatalogRequest = { operation, serverId: options.serverId, offset: 0, limit: 1, q: '', albumId: null, itemId: id, expectedRevision: null };
    const value = snapshot(await options.port.read(request), request); await current(rawPrincipal);
    if (value.total === 0) return fail(404, 'SOURCE_CHANGED');
    if (value.total !== 1 || value.items.length !== 1) return fail(409, 'SOURCE_CHANGED');
    const item = value.items[0]!; await current(rawPrincipal); return item;
  }
  return {
    listAlbums: (query: MobileSearchQuery, p: MobilePrincipal) => page('listAlbums', query, p) as Promise<MobileAlbumPage>,
    getAlbum: (id: string, p: MobilePrincipal) => detail('getAlbum', id, p) as Promise<MobileAlbum>,
    listTracks: (query: MobileSearchQuery, p: MobilePrincipal) => page('listTracks', query, p) as Promise<MobileTrackPage>,
    getTrack: (id: string, p: MobilePrincipal) => detail('getTrack', id, p) as Promise<MobileTrack>,
    async artwork(id: string, rawPrincipal: MobilePrincipal): Promise<MobileOwnerArtworkSnapshot> {
      principal(rawPrincipal); await current(rawPrincipal);
      if (!isMobileId(id)) return fail(400, 'INVALID_REQUEST');
      const raw = await options.port.artwork({ serverId: options.serverId, artworkId: id });
      // binary单列捕获，JSON snapshot 不接受 typed-array；任何 getter/hidden/symbol都拒绝。
      if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
        || !closed(raw as unknown as Record<string, unknown>, ['datasetId', 'ownerEpoch', 'libraryRevision', 'artworkId', 'selectionRevision', 'contentType', 'bytes'])
        || Reflect.ownKeys(raw).some(name => { const d = Object.getOwnPropertyDescriptor(raw, name); return !d?.enumerable || !Object.hasOwn(d, 'value'); })) return fail(503, 'BUSY');
      const { datasetId, ownerEpoch: epoch, libraryRevision, artworkId, selectionRevision, contentType } = raw;
      header(datasetId, epoch, libraryRevision);
      if (artworkId !== id || !isMobileId(selectionRevision) || contentType !== 'image/jpeg'
        || !(raw.bytes instanceof Uint8Array)) return fail(409, 'SOURCE_CHANGED');
      // 直接读取 typed-array 内部槽；不触发对象自报的 byteLength、iterator 或 species。
      let byteLength: number;
      try { byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!.call(raw.bytes) as number; }
      catch { return fail(503, 'BUSY'); }
      if (!mobileInteger(byteLength, 4)) return fail(409, 'SOURCE_CHANGED');
      if (byteLength > MOBILE_API_RESPONSE_MAX_BYTES) return fail(503, 'CONTENT_LIMIT_EXCEEDED');
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(byteLength); Uint8Array.prototype.set.call(bytes, raw.bytes); } catch { return fail(503, 'BUSY'); }
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return fail(503, 'BUSY');
      await current(rawPrincipal);
      return { datasetId, ownerEpoch: epoch, libraryRevision, artworkId, selectionRevision, contentType, bytes };
    },
  };
}
