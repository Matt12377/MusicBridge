import { createHash, hkdfSync } from 'node:crypto';
import { mobileCanonicalJson, mobileRecord, mobileTrackSelectionEquals } from '@music-bridge/contracts';
import type { MobileContentReadContext, MobileJsonValue, MobileRequestMap, MobileResponseBody, MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import type { DatasetOwnerEndpoint } from '../collection/dataset-owner-protocol.js';
import { createActualMobileNeteasePorts } from '../netease/mobile-actual-ports.js';
import type { NeteaseMobileReadPort } from '../netease/types.js';
import type { GatewayFetch } from '../stream/upstream-policy.js';
import { createMobileContentRpcPort } from './content-rpc-port.js';
import type { MobileContentCoreResponse, MobileContentMainPrincipal } from './content-rpc.js';
import { createMobileContentService, sameMobileContentScope } from './content-service.js';
import { createMobileContentProviderService } from './content-provider-service.js';
import { createMobileContentLyricsPort } from './content-lyrics.js';
import { MobileContentPersistenceError } from './content-owner-store.js';
import { captureMobileContentScope, isMobileContentMutation, type MobileContentPort, type MobileContentScope,
  type MobileContentServiceInput, type MobileContentSnapshot } from './content-types.js';
import { createMobileNeteaseCatalogService } from './netease-catalog-service.js';
import { createMobileNeteaseSourceService } from './netease-source-service.js';
import type { MobileNeteaseSourceService } from './netease-source-types.js';
import { captureMobileContentOwnerRequest, isMobileContentOwnerResult,
  type MobileContentOwnerRequest, type MobileContentOwnerResult, type MobileContentOwnerOperation } from './owner-content-protocol.js';
import type { MobileContentMutationFacts } from './content-types.js';
import { isMobileOwnerSourceRequest, isMobileOwnerSourceResult,
  type MobileOwnerSourceRequest, type MobileOwnerSourceResult } from './source-protocol.js';
import type { MobilePlaybackSourcePort } from './source-types.js';
import { MobileServiceError, type MobileOwnerPrivateResult } from './types.js';

type ActualPorts = ReturnType<typeof createActualMobileNeteasePorts>;
type Scope = Readonly<MobileContentScope>;
interface SourceBinding {
  scope: Scope; source: 'local' | 'netease'; port: MobilePlaybackSourcePort | null;
  prepared: MobileOwnerSourceResult | null; releasing: boolean; quiet: Promise<void> | null;
}
export interface MobileContentRuntimeOptions {
  owner: DatasetOwnerEndpoint;
  netease: NeteaseMobileReadPort;
  streamFetch?: GatewayFetch;
  assertCurrent(): void;
}
export interface MobileContentRuntime {
  request(input: unknown, signal: AbortSignal): Promise<MobileContentCoreResponse>;
  /** 凭据切换完成前等待原Owner围栏及旧网络工作收口。 */
  providerChanged(): Promise<void>;
  close(): Promise<void>;
}
const busy = () => new MobileServiceError(503, 'BUSY');
const changed = () => new MobileServiceError(409, 'SOURCE_CHANGED');
const canonical = (value: unknown) => mobileCanonicalJson(value as MobileJsonValue);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const selectionOf = (track: MobileTrack): MobileTrackSelection => ({ trackId: track.id,
  source: track.source, versionId: track.versionId, contentRevision: track.contentRevision });

/** 使用原Owner与原网易云客户端；不打开第二份数据库或凭据存储。 */
export function createMobileContentRuntime(options: MobileContentRuntimeOptions): MobileContentRuntime {
  let identity: { serverId: string; datasetId: string; ownerEpoch: string } | null = null;
  let actual: ActualPorts | null = null, networkSources: MobileNeteaseSourceService | null = null;
  let content: ReturnType<typeof createMobileContentService> | null = null;
  let provider: ReturnType<typeof createMobileContentProviderService> | null = null;
  let lyrics: ReturnType<typeof createMobileContentLyricsPort> | null = null;
  let closed = false, closing: Promise<void> | null = null;
  let unregisterAccount: (() => void) | null = null;
  const keys: Uint8Array[] = [], scopes = new Map<string, Scope>();
  const revoked = new Map<string, number>(), registeredDevices = new Set<string>(), resources = new Map<string, SourceBinding>();
  let scopeTail: Promise<void> = Promise.resolve(), providerTail: Promise<void> = Promise.resolve();
  let providerFatal: unknown;
  function current(signal?: AbortSignal): void {
    if (closed || signal?.aborted || providerFatal !== undefined) throw busy();
    options.assertCurrent();
  }
  function ready(signal?: AbortSignal) {
    current(signal); if (!identity || !actual || !content || !networkSources) throw busy();
    return { identity, actual, content, networkSources };
  }
  async function serialScope<T>(task: () => Promise<T>): Promise<T> {
    const flight = scopeTail.then(task);
    scopeTail = flight.then(() => undefined, () => undefined); return flight;
  }
  async function owner(request: MobileContentOwnerRequest, signal?: AbortSignal): Promise<MobileContentOwnerResult> {
    current(signal);
    if (!identity || !options.owner.mobileMain) throw busy();
    const captured = captureMobileContentOwnerRequest(request);
    const result = await options.owner.mobileMain({ kind: 'content', datasetId: identity.datasetId, request: captured });
    current(signal);
    if (!isMobileContentOwnerResult(result, captured)) throw busy();
    if (result.kind === 'content-error') {
      if (result.outcome) throw new MobileContentPersistenceError(result.outcome, result.commitId);
      throw new MobileServiceError(result.status, result.code, false);
    }
    if (result.datasetId !== identity.datasetId || result.ownerEpoch !== identity.ownerEpoch) throw changed();
    return result;
  }
  async function result<K extends Exclude<MobileContentOwnerResult['kind'], 'content-error'>>(
    request: MobileContentOwnerRequest, kind: K, signal?: AbortSignal): Promise<Extract<MobileContentOwnerResult, { kind: K }>> {
    const captured = await owner(request, signal);
    if (captured.kind !== kind) throw busy();
    return captured as Extract<MobileContentOwnerResult, { kind: K }>;
  }
  function sameLease(a: Scope, b: Scope): boolean {
    return ['serverId', 'datasetId', 'deviceId', 'deviceEpoch', 'ownerEpoch', 'accountDomain', 'providerEpoch']
      .every(key => a[key as keyof Scope] === b[key as keyof Scope]);
  }
  function mirror(scope: Scope, stage: 'acquire' | 'lease'): void {
    current();
    const value = scopes.get(scope.deviceId);
    if (!identity || scope.serverId !== identity.serverId || scope.datasetId !== identity.datasetId
      || scope.ownerEpoch !== identity.ownerEpoch || (revoked.get(scope.deviceId) ?? 0) >= scope.deviceEpoch
      || !value || !(stage === 'acquire' ? sameMobileContentScope(scope, value) : sameLease(scope, value))) throw changed();
  }
  async function assertScope(scope: Scope, stage: 'acquire' | 'lease', signal: AbortSignal): Promise<void> {
    current(signal); mirror(scope, stage);
    const account = await ready(signal).actual.account.current(signal);
    current(signal); mirror(scope, stage);
    const accountDomain = account?.accountDomain ?? `local:${scope.datasetId}`;
    if (scope.accountDomain !== accountDomain || scope.providerEpoch !== (account?.providerEpoch ?? null)) throw changed();
  }
  const fence = async (scope: Scope, stage: 'acquire' | 'lease') => {
    await assertScope(scope, stage, new AbortController().signal);
  };
  async function resolveScope(principal: Readonly<MobileContentMainPrincipal>, signal: AbortSignal): Promise<Scope> {
    await providerTail; current(signal);
    const state = ready(signal);
    if (principal.serverId !== state.identity.serverId || principal.datasetId !== state.identity.datasetId) throw changed();
    const account = await state.actual.account.current(signal); current(signal);
    const scope = captureMobileContentScope({ ...principal, ownerEpoch: state.identity.ownerEpoch,
      accountDomain: account?.accountDomain ?? `local:${state.identity.datasetId}`,
      providerEpoch: account?.providerEpoch ?? null });
    await serialScope(async () => {
      current(signal);
      if ((revoked.get(scope.deviceId) ?? 0) >= scope.deviceEpoch) throw changed();
      const previous = scopes.get(scope.deviceId);
      if (previous && (previous.deviceEpoch > scope.deviceEpoch
        || previous.deviceEpoch === scope.deviceEpoch && previous.accessGeneration > scope.accessGeneration)) throw changed();
      if (!previous && scopes.size >= 32) throw new MobileServiceError(429, 'BUSY');
      const latest = await state.actual.account.current(signal); current(signal);
      if ((latest?.accountDomain ?? `local:${scope.datasetId}`) !== scope.accountDomain
        || (latest?.providerEpoch ?? null) !== scope.providerEpoch) throw changed();
      await result({ action: 'updateScope', scope }, 'content-scope-updated', signal);
      current(signal); scopes.set(scope.deviceId, scope); registeredDevices.add(scope.deviceId);
    });
    await assertScope(scope, 'acquire', signal); return scope;
  }
  async function localSource(scope: Scope, request: MobileOwnerSourceRequest, signal: AbortSignal): Promise<MobileOwnerSourceResult> {
    const cleanup = request.operation === 'release' || request.operation === 'close-read';
    if (!cleanup) current(signal);
    const raw: MobileOwnerPrivateResult = await options.owner.mobileMain!({ kind: 'media-source', datasetId: scope.datasetId, request });
    if (!cleanup) current(signal);
    if ('kind' in raw && raw.kind === 'mobile-error') throw new MobileServiceError(raw.status, raw.code, false);
    if (!isMobileOwnerSourceResult(raw, request)) throw busy(); return raw;
  }
  async function release(binding: SourceBinding, handle: string): Promise<void> {
    if (binding.quiet) return binding.quiet;
    binding.releasing = true;
    // 关闭可以在旧scope被撤销后完成；原有资源归属仍必须匹配。
    const flight = binding.source === 'netease'
      ? binding.port!.release(handle)
      : localSource(binding.scope, { operation: 'release', handle }, new AbortController().signal).then(() => undefined);
    binding.quiet = flight; return flight;
  }
  async function source(scope: Scope, request: MobileOwnerSourceRequest, signal: AbortSignal): Promise<{
    source: 'local' | 'netease'; result: MobileOwnerSourceResult;
  }> {
    if (!isMobileOwnerSourceRequest(request)) throw new MobileServiceError(400, 'INVALID_REQUEST');
    const cleanup = request.operation === 'release' || request.operation === 'close-read';
    const state = cleanup && identity && actual && content && networkSources
      ? { identity, actual, content, networkSources } : ready(signal);
    if (request.operation === 'capabilities') return { source: 'local', result: await localSource(scope, request, signal) };
    const handle = request.operation === 'prepare' ? request.selection.resourceId : request.handle;
    let binding = resources.get(handle);
    if (binding && !sameLease(binding.scope, scope)) throw new MobileServiceError(404, 'INVALID_REQUEST');
    if (request.operation === 'prepare') {
      await assertScope(scope, 'acquire', signal);
      if (binding?.releasing) throw new MobileServiceError(410, 'RESOURCE_RELEASED');
      if (!binding) {
        if (resources.size >= 2048 || [...resources.values()].filter(value => !value.releasing).length >= 8) throw new MobileServiceError(429, 'RESOURCE_BUSY');
        // 源前缀只决定候选作者；该作者仍核验完整原始selection及实际文件/账号。
        const selectedSource = request.selection.trackId.startsWith('lt:') ? 'local' : 'netease';
        binding = { scope, source: selectedSource, port: selectedSource === 'netease' ? state.networkSources.bind(scope) : null,
          prepared: null, releasing: false, quiet: null };
        resources.set(handle, binding);
      }
      const own = binding;
      try {
        if (own.source === 'netease') {
          await state.actual.resolveSelection(scope, { trackId: request.selection.trackId,
            versionId: request.selection.versionId, contentRevision: request.selection.contentRevision }, signal);
          const prepared = await own.port!.prepare(request.selection, signal);
          if ('preparing' in prepared) throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT');
          own.prepared = { kind: 'mobile-source-prepared', source: prepared };
        } else own.prepared = await localSource(scope, request, signal);
        await assertScope(scope, 'acquire', signal);
        if (own.releasing || resources.get(handle) !== own || !isMobileOwnerSourceResult(own.prepared, request)) throw changed();
        return { source: own.source, result: own.prepared };
      } catch (error) {
        // 即使prepare迟到，原resourceId仍留墓碑，不能复活或借新请求释放容量。
        void release(own, handle).catch(() => { providerFatal = busy(); }); throw error;
      }
    }
    if (!binding) {
      if (request.operation !== 'release') throw new MobileServiceError(404, 'INVALID_REQUEST');
      if (resources.size >= 2048) throw new MobileServiceError(429, 'RESOURCE_BUSY');
      // Main取消可先于Core收到prepare；只建立封闭墓碑，不打开任何源。
      binding = { scope, source: 'local', port: null, prepared: null, releasing: true, quiet: Promise.resolve() };
      resources.set(handle, binding);
    }
    if (request.operation === 'release') {
      await release(binding, handle);
      return { source: binding.source, result: { kind: 'mobile-source-ack', operation: 'release', handle, readId: null, quiet: true } };
    }
    if (request.operation !== 'close-read') {
      if (binding.releasing) throw new MobileServiceError(410, 'RESOURCE_RELEASED');
      await assertScope(binding.scope, 'lease', signal);
    }
    if (binding.source === 'local') return { source: 'local', result: await localSource(binding.scope, request, signal) };
    const port = binding.port!;
    if (request.operation === 'status') {
      if (!binding.prepared) throw busy(); await port.verify(handle);
      return { source: 'netease', result: binding.prepared };
    }
    if (request.operation === 'read') return { source: 'netease', result: { kind: 'mobile-source-read', handle,
      readId: request.readId, start: request.start, bytes: await port.read(handle, request.readId, request.start, request.maxBytes, signal) } };
    if (request.operation === 'close-read') await port.closeRead(handle, request.readId);
    else if (request.operation === 'verify') await port.verify(handle);
    else await port.renew(handle);
    return { source: 'netease', result: { kind: 'mobile-source-ack', operation: request.operation, handle,
      readId: request.operation === 'close-read' ? request.readId : null, quiet: true } };
  }
  async function invalidateDevice(input: { serverId: string; datasetId: string; deviceId: string; deviceEpoch: number }, signal: AbortSignal): Promise<void> {
    const state = ready(signal);
    if (input.serverId !== state.identity.serverId || input.datasetId !== state.identity.datasetId) throw changed();
    await serialScope(async () => {
      current(signal);
      if (!revoked.has(input.deviceId) && revoked.size >= 32) throw busy();
      revoked.set(input.deviceId, Math.max(revoked.get(input.deviceId) ?? 0, input.deviceEpoch));
      const scope = scopes.get(input.deviceId);
      if (scope && scope.deviceEpoch > input.deviceEpoch) return;
      scopes.delete(input.deviceId);
      if (registeredDevices.has(input.deviceId)) await result({ action: 'invalidateScope', kind: 'device', deviceId: input.deviceId }, 'content-scope-invalidated', signal);
    });
    await Promise.all([...resources].filter(([, value]) => value.scope.deviceId === input.deviceId && value.scope.deviceEpoch <= input.deviceEpoch)
      .map(([handle, value]) => release(value, handle)));
    current(signal);
  }
  function providerChanged(): Promise<void> {
    if (!identity || !actual) return Promise.resolve();
    const previous = [...scopes.values()];
    for (const scope of previous) if (scopes.get(scope.deviceId) === scope) scopes.delete(scope.deviceId);
    const oldResources = [...resources].filter(([, value]) => !value.releasing);
    const flight = providerTail.then(() => serialScope(async () => {
      current();
      for (const epoch of new Set(previous.map(value => value.providerEpoch).filter((value): value is string => value !== null))) {
        await result({ action: 'invalidateScope', kind: 'provider', providerEpoch: epoch }, 'content-scope-invalidated');
      }
      await Promise.all(oldResources.map(([handle, value]) => release(value, handle)));
    }));
    providerTail = flight.catch(error => { providerFatal = error; throw error; });
    void providerTail.catch(() => undefined); return providerTail;
  }
  async function netTrack(scope: Scope, selection: MobileTrackSelection, signal: AbortSignal): Promise<MobileTrack> {
    return (await ready(signal).actual.catalog.track(scope, selection, signal)).track;
  }
  async function exactPage(scope: Scope, selections: readonly MobileTrackSelection[], signal: AbortSignal): Promise<MobileTrack[]> {
    const items: MobileTrack[] = [];
    // 沿原HTTP两探测槽并行，保持Owner计划顺序，不扩大Provider或短请求预算。
    for (let offset = 0; offset < selections.length; offset += 2) {
      const pair = await Promise.all(selections.slice(offset, offset + 2).map(selection => netTrack(scope, selection, signal)));
      items.push(...pair);
    }
    return items;
  }
  async function providerFacts(input: MobileContentServiceInput): Promise<MobileContentMutationFacts | undefined> {
    const { operation, request, scope, signal } = input;
    const body: unknown = request.body;
    const state = ready(signal);
    if (operation === 'setAlbumFavorite' && mobileRecord(body) && body.source === 'netease') {
      return { album: (await state.actual.catalog.album(scope, request.pathParameters.albumId!, signal)).album };
    }
    let selection: MobileTrackSelection | null = null;
    if (operation === 'setTrackFavorite' && mobileRecord(body) && body.source === 'netease') selection = {
      trackId: request.pathParameters.trackId!, source: 'netease', versionId: body.versionId as string, contentRevision: body.contentRevision as string };
    else if (operation === 'addPersonalPlaylistTrack') selection = (request as MobileRequestMap['addPersonalPlaylistTrack']).body.selection;
    else if (operation === 'createPersonalPlaylist') selection = (request as MobileRequestMap['createPersonalPlaylist']).body.initialTrack ?? null;
    if (selection?.source !== 'netease') return undefined;
    const track = await netTrack(scope, selection, signal);
    if (operation === 'setTrackFavorite') return { track, album: (await state.actual.catalog.album(scope, track.albumId, signal)).album };
    return { track };
  }
  async function verifyFacts(scope: Scope, facts: MobileContentMutationFacts | undefined, signal: AbortSignal): Promise<void> {
    if (facts?.album) {
      const latest = (await ready(signal).actual.catalog.album(scope, facts.album.id, signal)).album;
      if (canonical(latest) !== canonical(facts.album)) throw changed();
    }
    if (facts?.track && canonical(await netTrack(scope, selectionOf(facts.track), signal)) !== canonical(facts.track)) throw changed();
  }
  const ownerPort: MobileContentPort = {
    async dispatch(input) {
      const { operation, scope, signal } = input;
      await assertScope(scope, 'acquire', signal);
      const state = ready(signal);
      if (isMobileContentMutation(operation)) {
        // 原完整意图的持久回执先于Provider查询；重试只读，不受后续媒体变化影响。
        let receipt: MobileContentOwnerResult;
        try { receipt = await owner({ action: 'lookup-receipt', operation, scope,
          request: input.request as MobileRequestMap[typeof operation] }, signal); }
        catch (error) {
          if (!(error instanceof MobileContentPersistenceError) || error.outcome !== 'unknown' || error.commitId === null) throw error;
          receipt = await result({ action: 'revalidate', scope, commitId: error.commitId, operation,
            request: input.request as MobileRequestMap[typeof operation] }, 'content-snapshot', signal);
        }
        if (receipt.kind === 'content-snapshot') return { operation, scope, reply: receipt.reply,
          context: receipt.context, beforeSend: async () => {
            await assertScope(scope, 'acquire', signal);
            await result({ action: 'revalidate', scope, snapshotId: receipt.snapshotId }, 'content-revalidated', signal);
            await assertScope(scope, 'acquire', signal);
          } } as MobileContentSnapshot<typeof operation>;
        if (receipt.kind !== 'content-receipt-not-found') throw busy();
      }
      const facts = await providerFacts(input);
      let page: import('./owner-content-protocol.js').MobileContentProviderPage | undefined;
      let favoritePage: { revision: string; total: number } | undefined;
      if (operation === 'listFavoriteAlbumTracks' && input.request.query.source === 'netease') {
        const request = input.request as MobileRequestMap['listFavoriteAlbumTracks'];
        const plan = await result({ action: 'plan-read', scope, operation, request }, 'content-read-plan', signal);
        if (plan.selections === null) {
          const raw = await state.actual.resolveAlbumTracks(scope, plan.albumId, { offset: plan.offset, limit: plan.limit }, signal);
          page = { planId: plan.planId, scope, album: raw.album, items: [...raw.items], offset: raw.offset,
            limit: raw.limit, total: raw.total, sourceRevision: raw.revision };
        } else {
          const album = (await state.actual.catalog.album(scope, plan.albumId, signal)).album;
          const items = await exactPage(scope, plan.selections, signal);
          favoritePage = { revision: plan.revision, total: plan.total! };
          page = { planId: plan.planId, scope, album, items, offset: plan.offset, limit: plan.limit,
            total: plan.total!, sourceRevision: `nfp:${hash([album, favoritePage.revision, favoritePage.total])}` };
        }
      }
      await assertScope(scope, 'acquire', signal);
      let response: Extract<MobileContentOwnerResult, { kind: 'content-snapshot' }>;
      try {
        response = await result({ action: 'dispatch', operation: operation as MobileContentOwnerOperation, scope,
          request: input.request as MobileRequestMap[MobileContentOwnerOperation],
          ...(facts ? { providerFacts: facts } : {}), ...(page ? { providerPage: page } : {}) }, 'content-snapshot', signal);
      } catch (error) {
        if (!(error instanceof MobileContentPersistenceError) || error.outcome !== 'unknown'
          || error.commitId === null || !isMobileContentMutation(operation)) throw error;
        // 只读取刚才原提交的同一意图；不再调用dispatch/save。
        response = await result({ action: 'revalidate', scope, commitId: error.commitId, operation,
          request: input.request as MobileRequestMap[typeof operation] }, 'content-snapshot', signal);
      }
      const storedNetTracks = operation === 'listPersonalPlaylistTracks'
        ? (response.reply.body as MobileResponseBody<'listPersonalPlaylistTracks'>).items.filter(track => track.source === 'netease')
        : operation === 'listPersonalPlaylists'
          ? Object.values(response.context.playlistFirstTracks ?? {}).filter((track): track is MobileTrack => track?.source === 'netease')
          : [];
      return { operation, scope, reply: response.reply, context: response.context, beforeSend: async () => {
        await assertScope(scope, 'acquire', signal); await verifyFacts(scope, facts, signal);
        if (storedNetTracks.length) {
          // 持久歌单保存原selection；发布其历史可播放/封面事实前，只读复核当前精确来源。
          const checked = await exactPage(scope, storedNetTracks.map(selectionOf), signal);
          if (storedNetTracks.some((track, index) => canonical(track) !== canonical(checked[index]!))) throw changed();
        }
        if (page) {
          const planItems = page.items;
          const checkedItems = await exactPage(scope, planItems.map(selectionOf), signal);
          if (planItems.some((track, index) => !mobileTrackSelectionEquals(selectionOf(track), selectionOf(checkedItems[index]!)))) throw changed();
          // 原专辑页的顺序、完整源revision及分页身份必须保持；只收藏单曲的页也核原metadata。
          const latestAlbum = (await state.actual.catalog.album(scope, page.album.id, signal)).album;
          if (canonical(latestAlbum) !== canonical(page.album)) throw changed();
          if (favoritePage) {
            if (`nfp:${hash([latestAlbum, favoritePage.revision, favoritePage.total])}` !== page.sourceRevision) throw changed();
          } else await state.actual.assertAlbumRevision(scope, page.album.id, page.sourceRevision, signal);
        }
        await result({ action: 'revalidate', scope, snapshotId: response.snapshotId }, 'content-revalidated', signal);
        await assertScope(scope, 'acquire', signal);
      } } as MobileContentSnapshot<typeof operation>;
    },
  };
  const localLyrics: MobileContentPort = {
    async dispatch(input) {
      if (input.operation !== 'getExactTrackLyrics') throw new MobileServiceError(400, 'INVALID_REQUEST');
      const { scope, signal, request } = input;
      const selection: MobileTrackSelection = { trackId: request.pathParameters.trackId!, source: 'local',
        versionId: request.query.versionId as string, contentRevision: request.query.contentRevision as string };
      const captured = await result({ action: 'local-lyrics', scope, selection }, 'content-lyrics', signal);
      const context: MobileContentReadContext = { serverId: scope.serverId, deviceId: scope.deviceId,
        accountDomain: scope.accountDomain, source: 'local', selection };
      return { operation: input.operation, scope, reply: { status: 200, category: 'success', body: captured.lyrics }, context,
        beforeSend: async () => {
          await assertScope(scope, 'acquire', signal);
          await result({ action: 'revalidate', scope, snapshotId: captured.snapshotId }, 'content-revalidated', signal);
          await assertScope(scope, 'acquire', signal);
        } } as MobileContentSnapshot<typeof input.operation>;
    },
  };
  const netLyrics: MobileContentPort = {
    async dispatch(input) {
      if (input.operation !== 'getExactTrackLyrics') throw new MobileServiceError(400, 'INVALID_REQUEST');
      const { scope, signal, request } = input;
      const selection: MobileTrackSelection = { trackId: request.pathParameters.trackId!, source: 'netease',
        versionId: request.query.versionId as string, contentRevision: request.query.contentRevision as string };
      const captured = await ready(signal).actual.resolveLyrics(scope, selection, signal);
      return { operation: input.operation, scope, reply: { status: 200, category: 'success', body: captured.body }, context: captured.context,
        beforeSend: async () => {
          await assertScope(scope, 'acquire', signal);
          const latest = await ready(signal).actual.resolveLyrics(scope, selection, signal);
          if (canonical(latest) !== canonical(captured)) throw changed();
          await assertScope(scope, 'acquire', signal);
        } } as MobileContentSnapshot<typeof input.operation>;
    },
  };
  const rpc = createMobileContentRpcPort({
    async initialize(input, signal) {
      current(signal);
      if (!options.owner.mobileMain) throw busy();
      const binding = await options.owner.prepare(); current(signal);
      if (binding.datasetId !== input.datasetId) throw changed();
      identity = { serverId: input.serverId, datasetId: binding.datasetId, ownerEpoch: binding.epoch };
      function child(label: string): Uint8Array {
        const value = new Uint8Array(hkdfSync('sha256', input.key, Buffer.alloc(0), `MusicBridge:MBM004:${label}:1`, 32));
        keys.push(value); return value;
      }
      await result({ action: 'initialize', serverId: input.serverId, datasetId: input.datasetId, key: child('OWNER_STORE') }, 'content-initialized', signal);
      actual = createActualMobileNeteasePorts({ client: options.netease, serverId: input.serverId,
        datasetId: input.datasetId, ownerEpoch: binding.epoch, identityKey32: child('PROVIDER_IDENTITY'), assertCurrent: fence,
        ...(options.streamFetch ? { fetch: options.streamFetch } : {}) });
      const catalog = createMobileNeteaseCatalogService({ port: actual.catalog,
        assertCurrent: scope => fence(scope, 'lease'), playbackQualified: () => actual?.qualified === true });
      networkSources = createMobileNeteaseSourceService({ catalog, account: actual.account, streams: actual.streams,
        assertCurrent: fence, isQualified: () => actual?.qualified === true });
      provider = createMobileContentProviderService({ provider: actual.provider, cursorKey: child('PROVIDER_CURSOR'),
        assertCurrent: scope => fence(scope, 'acquire') });
      lyrics = createMobileContentLyricsPort({ local: localLyrics, provider: netLyrics, assertCurrent: scope => fence(scope, 'acquire') });
      content = createMobileContentService({ owner: ownerPort, provider, lyrics, assertCurrent: scope => fence(scope, 'acquire') });
      unregisterAccount = actual.onAccountInvalidated(() => { void providerChanged().catch(() => undefined); });
      current(signal);
    },
    invalidateDevice, resolveScope, assertScope, source,
    content: { dispatch: input => ready(input.signal).content.dispatch(input) },
    neteasePlaybackQualified: async (scope, signal) => {
      await assertScope(scope, 'acquire', signal); const state = ready(signal);
      return scope.providerEpoch !== null && state.actual.qualified && state.networkSources.qualified;
    },
  });
  return {
    request: (input, signal) => rpc.request(input, signal), providerChanged,
    close() {
      if (closing) return closing;
      // 先封RPC输出与新工作，再排空实际网络和Owner资源，最后销毁私有派生key。
      unregisterAccount?.(); unregisterAccount = null;
      closing = (async () => {
        const results = await Promise.allSettled([rpc.close(), content?.close(), lyrics?.close(), providerTail,
          networkSources?.close(), ...[...resources].map(([handle, value]) => release(value, handle))]);
        if (results.some(value => value.status === 'rejected')) throw busy();
        await actual?.close(); provider?.close(); closed = true;
        for (const key of keys) key.fill(0); scopes.clear();
      })(); return closing;
    },
  };
}
