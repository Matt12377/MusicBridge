import { createHmac, hkdfSync } from 'node:crypto';
import { encodeMobileJsonReply, mobileCanonicalJson, type MobileJsonValue, type MobileCapabilities, type MobileDecodedRequest, type MobilePairingClaim, type MobileRefreshRequest, type MobileReplyMap, type MobileSearchQuery, type MobileUIContentCapabilities } from '@music-bridge/contracts';
import { createMobileAuthCrypto } from '../../../../packages/bridge-core/src/mobile/auth-crypto.js';
import { createMobileAuthService } from '../../../../packages/bridge-core/src/mobile/auth-service.js';
import { createMobileCatalogService } from '../../../../packages/bridge-core/src/mobile/catalog-service.js';
import { isMobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type Mobile001Backend, type Mobile001BackendReply, type MobileAuthPersistence, type MobileCatalogReadPort, type MobileOwnerArtworkSnapshot, type MobileOwnerCatalogSnapshot, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult, type MobilePrincipal } from '../../../../packages/bridge-core/src/mobile/types.js';
import { createMobilePlaybackBackend } from './mobile-playback-backend.js';
import type { MobileAuthService } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobileContentCoreRequest, MobileContentCoreResponse } from '../../../../packages/bridge-core/src/mobile/content-rpc.js';
import { createMainMobileContentPort } from './mobile-content-port.js';
import { createMobileContentBackend } from './mobile-content-backend.js';

export type Mobile003Operation = 'getUIContentCapabilities';
/** 可信Main单独挂载原有能力路由；不扩大旧001/002 dispatch闭集。 */
export interface Mobile003Backend {
  dispatch(input: { operation: Mobile003Operation; request: MobileDecodedRequest<unknown>; accessToken: string | null;
    signal: AbortSignal; origin: string }): Promise<Mobile001BackendReply>;
}

export function createMobileBackend(options: {
  serverId: string; datasetId: string; authKey: Uint8Array; displayName: string; environment: 'development' | 'production';
  requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult>;
  assertCurrent(): void;
  resizeArtwork(bytes: Uint8Array, size: 96 | 256 | 512): Uint8Array;
  enablePlayback?: boolean;
  enableDsd?: boolean;
  enableContent?: boolean;
  requestContentRpc?(request: MobileContentCoreRequest, signal: AbortSignal): Promise<MobileContentCoreResponse>;
}) {
  if (options.enableDsd === true && options.enablePlayback !== true) throw new MobileServiceError(400, 'INVALID_REQUEST');
  if (options.enableContent === true && typeof options.requestContentRpc !== 'function') throw new MobileServiceError(400, 'INVALID_REQUEST');
  let closed = false;
  let closeFlight: Promise<void> | undefined;
  let responseOrigin = 'https://127.0.0.1';
  let playback: ReturnType<typeof createMobilePlaybackBackend> | undefined;
  const revocations = new Map<string, Set<Promise<void>>>();
  const same = (a: unknown, b: unknown): boolean => mobileCanonicalJson(a as MobileJsonValue) === mobileCanonicalJson(b as MobileJsonValue);
  const current = (): void => { if (closed) throw new MobileServiceError(503, 'BUSY'); options.assertCurrent(); };
  const contentPort = (() => {
    if (options.enableContent !== true || !options.requestContentRpc) return undefined;
    const derived = new Uint8Array(hkdfSync('sha256', options.authKey, new Uint8Array(), 'MusicBridge:MBM004:CONTENT_ROOT:1', 32));
    try { return createMainMobileContentPort({ serverId: options.serverId, datasetId: options.datasetId,
      key: derived, requestRpc: options.requestContentRpc, assertCurrent: current }); }
    finally { derived.fill(0); }
  })();
  async function owner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    current(); const result = await options.requestOwner(request); current();
    if (!isMobileOwnerPrivateResult(result, request)) throw new MobileAuthPersistenceError('unknown');
    if ('kind' in result && result.kind === 'mobile-error') {
      if (result.outcome) throw new MobileAuthPersistenceError(result.outcome);
      throw new MobileServiceError(result.status, result.code, result.retryable);
    }
    return result;
  }
  const persistence: MobileAuthPersistence = {
    load: async datasetId => { const request = { kind: 'load' as const, datasetId }; return await owner(request) as Awaited<ReturnType<MobileAuthPersistence['load']>>; },
    save: async request => await owner({ kind: 'save', datasetId: options.datasetId, request }) as Awaited<ReturnType<MobileAuthPersistence['save']>>,
  };
  const rawAuth = createMobileAuthService({ persistence, crypto: createMobileAuthCrypto(options.authKey), serverId: options.serverId,
    datasetId: options.datasetId, displayName: options.displayName, environment: options.environment,
    onDeviceEpochRevoked: deviceId => {
      if (!playback && !contentPort) return;
      const task = Promise.all([playback?.revokeDevice(deviceId), contentPort?.invalidateDevice(deviceId)]).then(() => undefined);
      const pending = revocations.get(deviceId) ?? new Set<Promise<void>>();
      pending.add(task); revocations.set(deviceId, pending);
      void task.then(() => { pending.delete(task); if (!pending.size) revocations.delete(deviceId); }, () => {});
    } });
  const awaitRevocation = async (deviceId: string): Promise<void> => { await Promise.all([...(revocations.get(deviceId) ?? [])]); };
  const auth: MobileAuthService = { ...rawAuth,
    claim: async (body, key) => { const result = await rawAuth.claim(body, key); await awaitRevocation(result.deviceId); return result; },
    revokeDevice: async deviceId => { try { await rawAuth.revokeDevice(deviceId); } finally { await awaitRevocation(deviceId); } },
    logout: async principal => { try { await rawAuth.logout(principal); } finally { await awaitRevocation(principal.deviceId); } },
  };
  if (options.enablePlayback) playback = createMobilePlaybackBackend({ serverId: options.serverId, datasetId: options.datasetId,
    authKey: options.authKey, auth: rawAuth, requestOwner: options.requestOwner, assertCurrent: options.assertCurrent,
    ...(contentPort ? { contentPort } : {}),
    ...(options.enableDsd === true ? { enableDsd: true } : {}) });
  const contentBackend = contentPort ? createMobileContentBackend({ auth: rawAuth, content: contentPort.content,
    resolveScope: contentPort.resolveScope, assertScope: contentPort.assertScope, assertCurrent: current }) : undefined;
  const port: MobileCatalogReadPort = {
    // 只在正式播放端已激活后申请目录资格；是否可播仍由原 Owner 核当前源事实。
    read: async request => await owner({ kind: 'catalog', datasetId: options.datasetId,
      request: { ...request, ...(playback?.enabled === true ? { catalogPlaybackEnabled: true } : {}) } }) as MobileOwnerCatalogSnapshot,
    artwork: async request => await owner({ kind: 'artwork', datasetId: options.datasetId, request }) as MobileOwnerArtworkSnapshot,
  };
  const catalog = createMobileCatalogService({ port, auth, serverId: options.serverId, datasetId: options.datasetId,
    cursorKey: new Uint8Array(createHmac('sha256', options.authKey).update('musicbridge-mobile-cursor-v1').digest()) });
  const capabilities: MobileCapabilities = { contractVersion: '0.1.0', localPlayback: false, neteasePlayback: false, transcoding: false,
    hls: false, preparedVariants: false, qualityProfiles: [], maxConcurrentSessions: 2 };
  const alive = async (): Promise<void> => { await owner({ kind: 'load', datasetId: options.datasetId }); };
  const backend: Mobile001Backend = {
    async dispatch(input): Promise<Mobile001BackendReply> {
      current(); if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY');
      const { operation, request } = input;
      let principal: MobilePrincipal | null = null, body: unknown = null, status = 200, neteasePlayback = false;
      if (!['getServer', 'claimPairing', 'refreshToken'].includes(operation)) {
        if (!input.accessToken) throw new MobileServiceError(401, 'UNAUTHORIZED');
        principal = await auth.authenticate(input.accessToken);
      }
      switch (operation) {
        case 'getServer': body = await auth.serverInfo(); break;
        case 'claimPairing': body = await auth.claim(request.body as MobilePairingClaim, request.idempotencyKey!); status = 201; break;
        case 'refreshToken': body = await auth.refresh(request.body as MobileRefreshRequest, request.idempotencyKey!); break;
        case 'logout': await auth.logout(principal!); status = 204; break;
        case 'getCapabilities':
          neteasePlayback = playback?.enabled && contentPort ? await contentPort.neteasePlaybackQualified(principal!, input.signal) : false;
          body = playback?.enabled ? { ...capabilities, localPlayback: true, neteasePlayback, qualityProfiles: ['auto', 'lossless'] } : capabilities; break;
        case 'listAlbums': body = await catalog.listAlbums(request.query as MobileSearchQuery, principal!); break;
        case 'getAlbum': body = await catalog.getAlbum(request.pathParameters.albumId!, principal!); break;
        case 'listTracks': body = await catalog.listTracks(request.query as MobileSearchQuery, principal!); break;
        case 'getTrack': body = await catalog.getTrack(request.pathParameters.trackId!, principal!); break;
        case 'getArtwork': {
          const selected = await catalog.artwork(request.pathParameters.artworkId!, principal!), size = Number(request.query.size ?? '256') as 96 | 256 | 512;
          const bytes = options.resizeArtwork(selected.bytes, size);
          if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 2 * 1024 * 1024) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
          return { status: 200, headers: [['Content-Type', 'image/jpeg'], ['Content-Length', String(bytes.length)], ['Cache-Control', 'private, no-store']], body: new Uint8Array(bytes),
            beforeSend: async () => { current(); const latest = await catalog.artwork(selected.artworkId, principal!);
              if (latest.libraryRevision !== selected.libraryRevision || latest.selectionRevision !== selected.selectionRevision) throw new MobileServiceError(409, 'SOURCE_CHANGED');
              await auth.assertCurrent(principal!); if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY'); current(); } };
        }
      }
      current(); if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY');
      const reply = encodeMobileJsonReply(operation, { status, category: status === 204 ? 'empty' : 'success', body } as MobileReplyMap[typeof operation],
        { responseOrigin, requestPath: request.path });
      if (!reply.ok) throw new MobileServiceError(503, reply.issue.code === 'LIMIT_EXCEEDED' ? 'CONTENT_LIMIT_EXCEEDED' : 'BUSY');
      return { ...reply.value, headers: [...reply.value.headers, ['Cache-Control', 'private, no-store']], beforeSend: async () => {
        await alive();
        if (operation === 'getCapabilities' && contentPort && playback?.enabled
          && await contentPort.neteasePlaybackQualified(principal!, input.signal) !== neteasePlayback) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        if (operation === 'listAlbums' && body && typeof body === 'object' && 'libraryRevision' in body) {
          await owner({ kind: 'catalog', datasetId: options.datasetId, request: { operation: 'listAlbums', serverId: options.serverId,
            offset: 0, limit: 1, q: '', albumId: null, itemId: null, expectedRevision: String(body.libraryRevision),
            ...(playback?.enabled === true ? { catalogPlaybackEnabled: true } : {}) } });
        }
        if (operation === 'listTracks') {
          // 外部文件变化可能不改数据库修订，重核原查询同一页的实际可用性。
          const latest = await catalog.listTracks(request.query as MobileSearchQuery, principal!);
          const previous = body as typeof latest;
          if (!same({ items: latest.items, libraryRevision: latest.libraryRevision, hasNext: latest.nextCursor !== null },
            { items: previous.items, libraryRevision: previous.libraryRevision, hasNext: previous.nextCursor !== null })) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        }
        if (operation === 'getAlbum' || operation === 'getTrack') {
          const latest = operation === 'getAlbum' ? await catalog.getAlbum(request.pathParameters.albumId!, principal!) : await catalog.getTrack(request.pathParameters.trackId!, principal!);
          if (!same(latest, body)) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        }
        // 已持久确认的同 key/body 只核原回执；撤销或后续轮换不能晚发旧 token。
        if (operation === 'claimPairing' || operation === 'refreshToken') {
          const original = operation === 'claimPairing' ? await auth.claim(request.body as MobilePairingClaim, request.idempotencyKey!) : await auth.refresh(request.body as MobileRefreshRequest, request.idempotencyKey!);
          if (!same(original, body)) throw new MobileServiceError(401, 'UNAUTHORIZED');
        }
        if (principal && operation !== 'logout') await auth.assertCurrent(principal);
        if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY'); current();
      } };
    },
  };
  const dsdBackend: Mobile003Backend | undefined = options.enableDsd === true || contentPort ? {
    async dispatch(input) {
      current(); input.signal.throwIfAborted();
      if (input.operation !== 'getUIContentCapabilities' || input.request.path !== '/mobile/v1/ui/capabilities') throw new MobileServiceError(400, 'INVALID_REQUEST');
      if (!input.accessToken) throw new MobileServiceError(401, 'UNAUTHORIZED');
      const principal = await auth.authenticate(input.accessToken);
      const activePlayback = playback;
      if (options.enableDsd === true && !activePlayback?.enabled) throw new MobileServiceError(503, 'BUSY');
      const qualified = options.enableDsd === true && activePlayback ? await activePlayback.dsdCapabilities(input.origin, input.signal) : { resourceDsdToPcm: false };
      const contentScope = contentPort ? await contentPort.resolveScope(principal, input.signal) : undefined;
      const providerState = contentScope?.providerEpoch === null ? 'loginRequired' as const : 'ready' as const;
      const body: MobileUIContentCapabilities = { version: '1.0.0', addedAlbums: contentPort ? 'ready' : 'unsupported',
        neteaseDailyRecommendations: contentPort ? providerState : 'unsupported', lyrics: contentPort ? 'ready' : 'unsupported',
        resourceFormatBitDepth: activePlayback?.enabled === true, resourceDsdToPcm: qualified.resourceDsdToPcm,
        ...(contentPort ? { neteaseLikedPlaylist: providerState, personalFavorites: 'ready', personalPlaylists: 'ready',
          neteaseRecommendedPlaylists: providerState, neteaseNewAlbums: providerState, neteaseCharts: providerState, neteasePersonalFM: providerState } as const : {}) };
      const reply = encodeMobileJsonReply('getUIContentCapabilities', { status: 200, category: 'success', body },
        { responseOrigin: input.origin, requestPath: input.request.path });
      if (!reply.ok) throw new MobileServiceError(503, 'BUSY');
      return { ...reply.value, headers: [...reply.value.headers, ['Cache-Control', 'private, no-store']], beforeSend: async () => {
        current(); input.signal.throwIfAborted(); await auth.assertCurrent(principal);
        const latest = options.enableDsd === true && activePlayback ? await activePlayback.dsdCapabilities(input.origin, input.signal) : { resourceDsdToPcm: false };
        if (latest.resourceDsdToPcm !== qualified.resourceDsdToPcm) throw new MobileServiceError(503, 'BUSY');
        if (contentPort && contentScope) await contentPort.assertScope(contentScope);
        current(); input.signal.throwIfAborted();
      } };
    },
  } : undefined;
  return { backend, auth, playbackBackend: playback?.backend, dsdBackend, contentBackend,
    activatePlayback(origin: string): void { if (!playback) throw new MobileServiceError(400, 'INVALID_REQUEST'); playback.activate(origin); responseOrigin = origin; },
    playbackSnapshot: () => playback?.snapshot(),
    close(): Promise<void> {
      if (!closeFlight) {
        closed = true;
        closeFlight = (async () => {
          const failures: unknown[] = [];
          for (const close of [() => contentBackend?.close(), () => playback?.close(),
            () => Promise.all([...revocations.values()].flatMap(set => [...set])), () => contentPort?.close(), () => rawAuth.close()]) {
            try { await close(); } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, '移动服务收尾尚未确认。');
        })();
      }
      return closeFlight;
    },
  };
}
