import { createMobileArtistSearchBackend } from './mobile-artist-search-backend.js';
import type { ArtistSearchCatalogPublicApi } from '@music-bridge/contracts';
import { observeMobileOwnerLoadTrace } from '../../../../packages/bridge-core/src/mobile/owner-load-trace.js';
import { createHmac, hkdfSync } from 'node:crypto';
import { mobileCapabilityAsync, mobileCapabilitySync, mobileContentDiagnosticAsync, noteMobileUIFeature, withMobileCapabilityContext, observeMobileCapabilityTrace, type MobileCapabilityStage } from '../../../../packages/bridge-core/src/mobile/capability-trace.js';
import { encodeMobileJsonReply, mobileCanonicalJson, type MobileJsonValue, type MobileCapabilities, type MobileDecodedRequest, type MobilePairingClaim, type MobileRefreshRequest, type MobileReplyMap, type MobileSearchQuery, type MobileUIContentCapabilities } from '@music-bridge/contracts';
import { createMobileAuthCrypto } from '../../../../packages/bridge-core/src/mobile/auth-crypto.js';
import { createMobileAuthService } from '../../../../packages/bridge-core/src/mobile/auth-service.js';
import { createMobileCatalogService } from '../../../../packages/bridge-core/src/mobile/catalog-service.js';
import { isMobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type Mobile001Backend, type Mobile001BackendReply, type MobileAuthPersistence, type MobileCatalogReadPort, type MobileOwnerArtworkSnapshot, type MobileOwnerCatalogSnapshot, type MobileOwnerCatalogSelectedSnapshot, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult, type MobilePrincipal } from '../../../../packages/bridge-core/src/mobile/types.js';
import { createMobilePlaybackBackend } from './mobile-playback-backend.js';
import type { MobileAuthService } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobileContentCoreRequest, MobileContentCoreResponse } from '../../../../packages/bridge-core/src/mobile/content-rpc.js';
import { createMainMobileContentPort, type MobileContentCancelRecheck } from './mobile-content-port.js';
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
  resizeArtwork(bytes: Uint8Array, size: 96 | 256 | 512, providerInput?: true): Uint8Array;
  artists?: ArtistSearchCatalogPublicApi;
  enablePlayback?: boolean;
  enableDsd?: boolean;
  enableContent?: boolean;
  privateProviderDiagnostics?: boolean;
  privateCloseDiagnostics?: boolean;
  requestContentRpc?(request: MobileContentCoreRequest, signal: AbortSignal, recheck?: MobileContentCancelRecheck): Promise<MobileContentCoreResponse>;
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
      key: derived, requestRpc: options.requestContentRpc, assertCurrent: current,
      privateProviderDiagnostics: options.privateProviderDiagnostics === true, privateCloseDiagnostics: options.privateCloseDiagnostics === true }); }
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
    selected: async request => await owner({ kind: 'catalog-selected', datasetId: options.datasetId,
      request: { ...request, ...(playback?.enabled === true ? { catalogPlaybackEnabled: true } : {}) } }) as MobileOwnerCatalogSelectedSnapshot,
    artwork: async request => await owner({ kind: 'artwork', datasetId: options.datasetId, request }) as MobileOwnerArtworkSnapshot,
  };
  const catalog = createMobileCatalogService({ port, auth, serverId: options.serverId, datasetId: options.datasetId,
    privateDiagnostics: options.privateProviderDiagnostics === true,
    cursorKey: new Uint8Array(createHmac('sha256', options.authKey).update('musicbridge-mobile-cursor-v1').digest()) });
  const artistSearchBackend = options.artists ? createMobileArtistSearchBackend({ auth, catalog, artists: options.artists,
    cursorKey: new Uint8Array(createHmac('sha256', options.authKey).update('musicbridge-mobile-artist-search-v1').digest()),
    assertCurrent: current,
    assertCatalogCurrent: async (principal, signal) => {
      current(); signal.throwIfAborted();
      if (principal.datasetId !== options.datasetId || principal.serverId !== options.serverId) throw new MobileServiceError(409, 'SOURCE_CHANGED');
      await auth.assertCurrent(principal); await owner({ kind: 'load', datasetId: options.datasetId });
      current(); signal.throwIfAborted();
    },
    providerDirectory: async (principal, query, signal) => {
      if (!contentPort) throw new MobileServiceError(403, 'RESOURCE_REVOKED');
      return contentPort.directory(principal, query, signal);
    } }) : undefined;
  const capabilities: MobileCapabilities = { contractVersion: '0.1.0', localPlayback: false, neteasePlayback: false, transcoding: false,
    hls: false, preparedVariants: false, qualityProfiles: [], maxConcurrentSessions: 2 };
  const alive = async (): Promise<void> => { await observeMobileOwnerLoadTrace('main', 'http.before-send.alive', () => owner({ kind: 'load', datasetId: options.datasetId })); };
  const backend: Mobile001Backend = {
    async dispatch(input): Promise<Mobile001BackendReply> {
      let releaseTrackActivity: (() => void) | undefined;
      try {
      mobileCapabilitySync('main.current', () => { current(); if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY'); });
      const { operation, request } = input;
      let principal: MobilePrincipal | null = null, body: unknown = null, status = 200, neteasePlayback = false;
      let providerTrackBeforeSend: (()=>Promise<void>) | undefined;
      let providerAlbumBeforeSend: (()=>Promise<void>) | undefined;
      if (!['getServer', 'claimPairing', 'refreshToken'].includes(operation)) {
        principal = await observeMobileOwnerLoadTrace('main', 'main.auth', () => mobileCapabilityAsync('main.auth', () => {
          if (!input.accessToken) throw new MobileServiceError(401, 'UNAUTHORIZED');
          return auth.authenticate(input.accessToken);
        }));
      }
      switch (operation) {
        case 'getServer': body = await auth.serverInfo(); break;
        case 'claimPairing': body = await auth.claim(request.body as MobilePairingClaim, request.idempotencyKey!); status = 201; break;
        case 'refreshToken': body = await auth.refresh(request.body as MobileRefreshRequest, request.idempotencyKey!); break;
        case 'logout': await auth.logout(principal!); status = 204; break;
        case 'getCapabilities':
          neteasePlayback = playback?.enabled && contentPort ? await observeMobileOwnerLoadTrace('main', 'main.initial-qualification', () => mobileCapabilityAsync('main.initial-qualification', () => contentPort.neteasePlaybackQualified(principal!, input.signal))) : false;
          body = playback?.enabled ? { ...capabilities, localPlayback: true, neteasePlayback, qualityProfiles: ['auto', 'lossless'] } : capabilities; break;
        case 'listAlbums': body = await catalog.listAlbums(request.query as MobileSearchQuery, principal!); break;
        case 'getAlbum': {
          const albumId = request.pathParameters.albumId!;
          if (albumId.startsWith('na:')) {
            if (!contentPort) throw new MobileServiceError(404, 'RESOURCE_REVOKED');
            const selected = await contentPort.album(principal!, albumId, input.signal);
            body = selected.album; providerAlbumBeforeSend = selected.beforeSend;
          } else body = await catalog.getAlbum(albumId, principal!);
          break;
        }
        case 'listTracks': {
          const query = request.query as MobileSearchQuery;
          if (query.source === 'netease' && query.albumId?.startsWith('na:')) {
            if (!contentPort) throw new MobileServiceError(404, 'RESOURCE_REVOKED');
            const selected = await contentPort.albumTracks(principal!, query, input.signal);
            body = playback?.enabled === true ? selected.page : { ...selected.page,
              items: selected.page.items.map(track => track.availability === 'available' ? { ...track, availability: 'unavailable' as const } : track) };
            providerAlbumBeforeSend = selected.beforeSend;
          } else body = await (options.privateProviderDiagnostics === true
          ? mobileContentDiagnosticAsync('main.catalog.tracks.read', () => catalog.listTracks(request.query as MobileSearchQuery, principal!))
          : catalog.listTracks(request.query as MobileSearchQuery, principal!));
          break;
        }
        case 'getTrack': {
          const trackId=request.pathParameters.trackId!;
          if(trackId.startsWith('nt:')){
            if(!contentPort)throw new MobileServiceError(404,'RESOURCE_REVOKED');
            // 精确音频参数属于播放前台；提示覆盖同一次GET的读取和发送前原复验。
            if(playback?.enabled)releaseTrackActivity=await playback.acquireControlActivity(input.signal);
            const selected=await contentPort.track(principal!,trackId,input.signal);providerTrackBeforeSend=selected.beforeSend;
            // 详情可显示真实音频；正式播放后端未激活时仍不授予可播资格。
            body=selected.track.availability==='available'&&playback?.enabled!==true?{...selected.track,availability:'unavailable'}:selected.track;
          }else body=await catalog.getTrack(trackId,principal!);
          break;
        }
        case 'getArtwork': {
          if (request.pathParameters.artworkId!.startsWith('naw:')) {
            if (!contentPort) throw new MobileServiceError(404, 'RESOURCE_REVOKED');
            const selected = await contentPort.artwork(principal!, request.pathParameters.artworkId!, input.signal);
            const size = Number(request.query.size ?? '256') as 96 | 256 | 512;
            const bytes = options.resizeArtwork(selected.bytes, size, true);
            if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > 1024 * 1024
              || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)
              throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
            return { status: 200, headers: [['Content-Type', 'image/jpeg'], ['Content-Length', String(bytes.length)],
              ['Cache-Control', 'private, no-store']], body: new Uint8Array(bytes), beforeSend: async () => {
                current(); input.signal.throwIfAborted(); await auth.assertCurrent(principal!);
                await selected.beforeSend(); await auth.assertCurrent(principal!); current(); input.signal.throwIfAborted();
              } };
          }
          const selected = await catalog.artwork(request.pathParameters.artworkId!, principal!), size = Number(request.query.size ?? '256') as 96 | 256 | 512;
          const bytes = options.resizeArtwork(selected.bytes, size);
          if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 2 * 1024 * 1024) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
          return { status: 200, headers: [['Content-Type', 'image/jpeg'], ['Content-Length', String(bytes.length)], ['Cache-Control', 'private, no-store']], body: new Uint8Array(bytes),
            beforeSend: async () => { current(); const latest = await catalog.artwork(selected.artworkId, principal!);
              if (latest.libraryRevision !== selected.libraryRevision || latest.selectionRevision !== selected.selectionRevision) throw new MobileServiceError(409, 'SOURCE_CHANGED');
              await auth.assertCurrent(principal!); if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY'); current(); } };
        }
      }
      mobileCapabilitySync('main.current', () => { current(); if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY'); });
      const reply = observeMobileOwnerLoadTrace('main', 'main.encode', () => mobileCapabilitySync('main.encode', () => {
        const encoded = encodeMobileJsonReply(operation, { status, category: status === 204 ? 'empty' : 'success', body } as MobileReplyMap[typeof operation],
          { responseOrigin, requestPath: request.path, ...(request.catalogFeatures === 'unknown-duration-v1' ? { catalogFeatures: request.catalogFeatures } : {}) });
        if (!encoded.ok) throw new MobileServiceError(503, encoded.issue.code === 'LIMIT_EXCEEDED' ? 'CONTENT_LIMIT_EXCEEDED' : 'BUSY');
        return encoded;
      }));
      return { ...reply.value, headers: [...reply.value.headers, ['Cache-Control', 'private, no-store']], beforeSend: async () => {
        try {
        await mobileCapabilityAsync('main.beforeSend.alive', alive);
        if (operation === 'getCapabilities' && contentPort && playback?.enabled) await observeMobileOwnerLoadTrace('main', 'main.before-send.qualification', () => mobileCapabilityAsync('main.beforeSend.qualification', async () => {
          if (await contentPort.neteasePlaybackQualified(principal!, input.signal) !== neteasePlayback) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        }));
        if (operation === 'listAlbums' && body && typeof body === 'object' && 'libraryRevision' in body) {
          await owner({ kind: 'catalog', datasetId: options.datasetId, request: { operation: 'listAlbums', serverId: options.serverId,
            offset: 0, limit: 1, q: '', albumId: null, itemId: null, expectedRevision: String(body.libraryRevision),
            ...(playback?.enabled === true ? { catalogPlaybackEnabled: true } : {}) } });
        }
        if (operation === 'listTracks' && !providerAlbumBeforeSend) {
          // 外部文件变化可能不改数据库修订，重核原查询同一页的实际可用性。
          const latest = await (options.privateProviderDiagnostics === true
            ? mobileContentDiagnosticAsync('main.catalog.tracks.beforeSend', () => catalog.listTracks(request.query as MobileSearchQuery, principal!))
            : catalog.listTracks(request.query as MobileSearchQuery, principal!));
          const previous = body as typeof latest;
          if (!same({ items: latest.items, libraryRevision: latest.libraryRevision, hasNext: latest.nextCursor !== null },
            { items: previous.items, libraryRevision: previous.libraryRevision, hasNext: previous.nextCursor !== null })) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        }
        if(providerTrackBeforeSend)await providerTrackBeforeSend();
        if(providerAlbumBeforeSend)await providerAlbumBeforeSend();
        if (operation === 'getAlbum'&&!providerAlbumBeforeSend || operation === 'getTrack'&&!providerTrackBeforeSend) {
          const latest = operation === 'getAlbum' ? await catalog.getAlbum(request.pathParameters.albumId!, principal!) : await catalog.getTrack(request.pathParameters.trackId!, principal!);
          if (!same(latest, body)) throw new MobileServiceError(409, 'SOURCE_CHANGED');
        }
        // 已持久确认的同 key/body 只核原回执；撤销或后续轮换不能晚发旧 token。
        if (operation === 'claimPairing' || operation === 'refreshToken') {
          const original = operation === 'claimPairing' ? await auth.claim(request.body as MobilePairingClaim, request.idempotencyKey!) : await auth.refresh(request.body as MobileRefreshRequest, request.idempotencyKey!);
          if (!same(original, body)) throw new MobileServiceError(401, 'UNAUTHORIZED');
        }
        if (principal && operation !== 'logout') await observeMobileOwnerLoadTrace('main', 'main.before-send.auth', () => mobileCapabilityAsync('main.beforeSend.auth', () => auth.assertCurrent(principal!)));
        mobileCapabilitySync('main.current', () => { if (input.signal.aborted) throw new MobileServiceError(503, 'BUSY'); current(); });
        } finally { releaseTrackActivity?.(); releaseTrackActivity = undefined; }
      } };
      } catch (error) { releaseTrackActivity?.(); throw error; }
    },
  };
  const dsdBackend: Mobile003Backend | undefined = options.enableDsd === true || contentPort || artistSearchBackend ? {
    async dispatch(input) {
      current(); input.signal.throwIfAborted();
      if (input.operation !== 'getUIContentCapabilities' || input.request.path !== '/mobile/v1/ui/capabilities') throw new MobileServiceError(400, 'INVALID_REQUEST');
      if (!input.accessToken) throw new MobileServiceError(401, 'UNAUTHORIZED');
      const principal = await mobileCapabilityAsync('main.auth', () => auth.authenticate(input.accessToken!));
      const activePlayback = playback;
      if (options.enableDsd === true && !activePlayback?.enabled) throw new MobileServiceError(503, 'BUSY');
      const qualified = options.enableDsd === true && activePlayback ? await activePlayback.dsdCapabilities(input.origin, input.signal) : { resourceDsdToPcm: false };
      let contentScope: Awaited<ReturnType<NonNullable<typeof contentPort>['resolveScope']>> | undefined;
      let providerState: 'ready' | 'loginRequired' | 'unavailable' = 'ready';
      if (contentPort) {
        try { contentScope = await contentPort.resolveScope(principal, input.signal); }
        catch (error) {
          if (!(error instanceof MobileServiceError) || error.status !== 503 || error.code !== 'BUSY') throw error;
          // BUSY没有Provider/Owner来源证明：只宣布暂不可用，不伪造本地scope或登录缺失。
          providerState = 'unavailable';
        }
        if (contentScope?.providerEpoch === null) providerState = 'loginRequired';
      }
      const contentState = contentPort ? contentScope ? 'ready' as const : 'unavailable' as const : 'unsupported' as const;
      const body: MobileUIContentCapabilities = { version: '1.0.0', addedAlbums: contentState,
        ...(artistSearchBackend ? { sourceSearch: 'ready', localArtists: 'ready', artistIdentityLink: contentPort ? providerState : 'unsupported' } as const : {}),
        neteaseDailyRecommendations: contentPort ? providerState : 'unsupported', lyrics: contentState,
        resourceFormatBitDepth: activePlayback?.enabled === true, resourceDsdToPcm: qualified.resourceDsdToPcm,
        ...(contentScope && contentScope.providerEpoch !== null && providerState === 'ready'
          ? { neteaseAccountDomain: contentScope.accountDomain } : {}),
        ...(contentPort ? { neteaseLikedPlaylist: providerState, personalFavorites: contentState, personalPlaylists: contentState,
          neteaseRecommendedPlaylists: providerState, neteaseNewAlbums: providerState, neteaseCharts: providerState, neteasePersonalFM: providerState } as const : {}) };
      for (const feature of ['addedAlbums', 'neteaseDailyRecommendations', 'lyrics', 'neteaseLikedPlaylist', 'personalFavorites',
        'personalPlaylists', 'neteaseRecommendedPlaylists', 'neteaseNewAlbums', 'neteaseCharts', 'neteasePersonalFM'] as const) {
        noteMobileUIFeature(feature, body[feature] ?? 'unsupported');
      }
      const reply = mobileCapabilitySync('main.encode', () => {
        const encoded = encodeMobileJsonReply('getUIContentCapabilities', { status: 200, category: 'success', body },
          { responseOrigin: input.origin, requestPath: input.request.path });
        if (!encoded.ok) throw new MobileServiceError(503, 'BUSY'); return encoded;
      });
      return { ...reply.value, headers: [...reply.value.headers, ['Cache-Control', 'private, no-store']], beforeSend: async () => {
        current(); input.signal.throwIfAborted(); await auth.assertCurrent(principal);
        const latest = options.enableDsd === true && activePlayback ? await activePlayback.dsdCapabilities(input.origin, input.signal) : { resourceDsdToPcm: false };
        if (latest.resourceDsdToPcm !== qualified.resourceDsdToPcm) throw new MobileServiceError(503, 'BUSY');
        if (contentPort && contentScope) await contentPort.assertScope(contentScope);
        await auth.assertCurrent(principal);
        current(); input.signal.throwIfAborted();
      } };
    },
  } : undefined;
  return { backend, auth, playbackBackend: playback?.backend, dsdBackend, contentBackend, artistSearchBackend,
    activatePlayback(origin: string): void { if (!playback) throw new MobileServiceError(400, 'INVALID_REQUEST'); playback.activate(origin); responseOrigin = origin; },
    playbackSnapshot: () => playback?.snapshot(),
    getCloseDiagnosticContext: () => contentPort?.getCloseDiagnosticContext(),
    close(): Promise<void> {
      if (!closeFlight) {
        closed = true;
        closeFlight = (async () => {
          const failures: unknown[] = [];
          try { await artistSearchBackend?.close(); } catch (error) { failures.push(error); }
          const stages: ReadonlyArray<readonly [MobileCapabilityStage, () => unknown]> = [
            ['main.close.content-backend', () => contentBackend?.close()], ['main.close.playback', () => playback?.close()],
            ['main.close.revocations', () => Promise.all([...revocations.values()].flatMap(set => [...set]))],
            ['main.close.content-port', () => contentPort?.close()], ['main.close.auth', () => rawAuth.close()],
          ];
          for (const [stage, close] of stages) {
            try {
              await withMobileCapabilityContext(contentPort?.getCloseDiagnosticContext(), () => observeMobileCapabilityTrace(stage, close, 'cleanup'));
            } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, '移动服务收尾尚未确认。');
        })();
      }
      return closeFlight;
    },
  };
}
