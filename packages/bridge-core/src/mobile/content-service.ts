import { mobileCanonicalJson, mobileDataSnapshot, mobileRecord } from '@music-bridge/contracts';
import type { MobileCodecLimits, MobileRequestMap } from '@music-bridge/contracts';
import { captureMobileContentReply, captureMobileContentRequest } from './content-protocol.js';
import {
  captureMobileContentScope, isMobileContentOperation, MOBILE_CONTENT_SCOPE_KEYS,
  type MobileContentOperation, type MobileContentPort, type MobileContentScope,
  type MobileContentServiceInput, type MobileContentSnapshot,
} from './content-types.js';
import { MobileServiceError } from './types.js';

export const MOBILE_CONTENT_OWNER_OPERATIONS = [
  'listRecentlyAddedAlbums', 'listFavoriteAlbums', 'getFavoriteAlbumState', 'setAlbumFavorite',
  'listFavoriteAlbumTracks', 'setTrackFavorite', 'listPersonalPlaylists', 'createPersonalPlaylist',
  'listPersonalPlaylistTracks', 'addPersonalPlaylistTrack',
] as const;
export const MOBILE_CONTENT_PROVIDER_OPERATIONS = [
  'getNeteaseDailyRecommendations', 'getNeteaseLikedPlaylist', 'listNeteaseLikedPlaylistTracks',
  'listNeteaseRecommendedPlaylists', 'listNeteaseNewAlbums', 'listNeteaseCharts',
  'getNeteaseDiscoveryCollectionTracks', 'getNeteasePersonalFM',
] as const;
const ownerOperations = new Set<string>(MOBILE_CONTENT_OWNER_OPERATIONS);
const providerOperations = new Set<string>(MOBILE_CONTENT_PROVIDER_OPERATIONS);
const SNAPSHOT_KEYS = ['operation', 'scope', 'reply', 'context', 'beforeSend'] as const;
export const MOBILE_CONTENT_SERVICE_BOUNDS = Object.freeze({ requestMs: 10_000, inflight: 16, closeMs: 10_000 });

export interface MobileContentService extends MobileContentPort { close(): Promise<void> }
export interface MobileContentServiceOptions {
  /** 最近添加也由原 Owner 的目录端口提供；这里不装载另一个数据库作者。 */
  owner: MobileContentPort;
  provider: MobileContentPort;
  lyrics: MobileContentPort;
  assertCurrent(scope: Readonly<MobileContentScope>): void | Promise<void>;
  limits?: MobileCodecLimits;
  /** 仅供更严格的宿主或局部测试下调，不能放宽原短请求边界。 */
  requestMs?: number;
  maxInflight?: number;
  closeMs?: number;
}

export function sameMobileContentScope(left: Readonly<MobileContentScope>, right: Readonly<MobileContentScope>): boolean {
  return MOBILE_CONTENT_SCOPE_KEYS.every(key => left[key] === right[key]);
}
export function safeMobileContentFailure(error: unknown): MobileServiceError {
  // 持久化 UNKNOWN 子类仍保留给私有组合层，不推断提交已撤回。
  return error instanceof MobileServiceError ? error : new MobileServiceError(503, 'BUSY');
}
/** 正文中的账号只用于比较，不能把外域请求交给 Owner 再靠回包发现错误。 */
export function assertMobileContentRequestScope<O extends MobileContentOperation>(operation: O,
  request: MobileRequestMap[O], scope: Readonly<MobileContentScope>): void {
  const bodyDomain = mobileRecord(request.body) ? request.body.accountDomain : undefined;
  if (bodyDomain !== undefined && bodyDomain !== scope.accountDomain
    || request.query.accountDomain !== undefined && request.query.accountDomain !== scope.accountDomain) {
    throw new MobileServiceError(409, 'SOURCE_CHANGED');
  }
}
function closedData(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
    return Reflect.ownKeys(raw).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
  } catch { return false; }
}
function bound(raw: number | undefined, maximum: number): number {
  const value = raw ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new MobileServiceError(400, 'INVALID_REQUEST');
  return value;
}

/** 两个既有操作共用 schema，但不能把榜单作为推荐歌单返回。 */
export function assertMobileContentOperationKind(operation: MobileContentOperation, body: unknown): void {
  if (operation !== 'listNeteaseRecommendedPlaylists' && operation !== 'listNeteaseCharts') return;
  const kind = operation === 'listNeteaseCharts' ? 'chart' : 'playlist';
  if (!mobileRecord(body) || !Array.isArray(body.items)
    || body.items.some(item => !mobileRecord(item) || item.kind !== kind)) throw new MobileServiceError(503, 'BUSY');
}
function fingerprint(reply: unknown, context: unknown, limits: MobileCodecLimits | undefined): string {
  const captured = mobileDataSnapshot({ reply, context }, limits);
  if (!captured.ok) throw new MobileServiceError(503, 'BUSY');
  return mobileCanonicalJson(captured.value);
}
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** 只有分流和当前身份围栏；写入、CAS、回执和 UNKNOWN 处理仍由唯一 Owner 承担。 */
export function createMobileContentService(options: MobileContentServiceOptions): MobileContentService {
  const requestMs = bound(options.requestMs, MOBILE_CONTENT_SERVICE_BOUNDS.requestMs);
  const maxInflight = bound(options.maxInflight, MOBILE_CONTENT_SERVICE_BOUNDS.inflight);
  const closeMs = bound(options.closeMs, MOBILE_CONTENT_SERVICE_BOUNDS.closeMs);
  const codecOptions = options.limits === undefined ? {} : { limits: options.limits };
  const active = new Set<Promise<unknown>>(), controllers = new Set<AbortController>();
  let closing = false, closeFlight: Promise<void> | undefined;
  const busy = () => new MobileServiceError(503, 'BUSY');

  async function current(scope: Readonly<MobileContentScope>, signal: AbortSignal): Promise<void> {
    if (closing || signal.aborted) throw busy();
    await options.assertCurrent(scope);
    if (closing || signal.aborted) throw busy();
  }
  async function run<T>(scope: Readonly<MobileContentScope>, parentSignal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closing || parentSignal.aborted || active.size >= maxInflight) throw busy();
    const controller = new AbortController(); controllers.add(controller);
    const cancel = () => { controller.abort(busy()); };
    parentSignal.addEventListener('abort', cancel, { once: true });
    if (parentSignal.aborted) cancel();
    const timer = setTimeout(cancel, requestMs);
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(busy());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const flight = Promise.resolve().then(async () => {
      await current(scope, controller.signal);
      const result = await task(controller.signal);
      await current(scope, controller.signal);
      return result;
    });
    active.add(flight);
    // 超时只终止本次输出；原端口真实收口之前仍占用槽位并供 close 等待。
    void flight.then(() => active.delete(flight), () => active.delete(flight));
    try { return await Promise.race([flight, aborted]); }
    catch (error) { throw safeMobileContentFailure(error); }
    finally {
      clearTimeout(timer); parentSignal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort); controllers.delete(controller);
    }
  }

  const service: MobileContentService = {
    async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>): Promise<MobileContentSnapshot<O>> {
      if (!closedData(input, ['operation', 'request', 'scope', 'signal'])
        || !isMobileContentOperation(input.operation) || !(input.signal instanceof AbortSignal)) {
        throw new MobileServiceError(400, 'INVALID_REQUEST');
      }
      const operation = input.operation, parentSignal = input.signal;
      const scope = captureMobileContentScope(input.scope);
      const request = freezeData(captureMobileContentRequest(operation, input.request, codecOptions));
      assertMobileContentRequestScope(operation, request, scope);
      const port = ownerOperations.has(operation) ? options.owner
        : providerOperations.has(operation) ? options.provider : options.lyrics;
      return run(scope, parentSignal, async signal => {
        const raw = await port.dispatch({ operation, request, scope, signal });
        const capture = () => {
          if (!closedData(raw, SNAPSHOT_KEYS) || raw.operation !== operation
            || typeof raw.beforeSend !== 'function' || !sameMobileContentScope(scope, captureMobileContentScope(raw.scope))) throw busy();
          const result = captureMobileContentReply(operation, request, scope, raw.reply, raw.context, codecOptions);
          assertMobileContentOperationKind(operation, result.reply.body);
          return result;
        };
        const captured = capture(), original = fingerprint(captured.reply, captured.context, options.limits);
        const beforeSend = raw.beforeSend;
        const verify = () => {
          const latest = capture();
          if (raw.beforeSend !== beforeSend || fingerprint(latest.reply, latest.context, options.limits) !== original) throw busy();
        };
        return Object.freeze({ operation, scope, reply: freezeData(captured.reply), context: freezeData(captured.context),
          beforeSend: async () => {
            await run(scope, parentSignal, async innerSignal => {
              verify(); await beforeSend(); await current(scope, innerSignal); verify();
            });
          } });
      });
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true;
      for (const controller of controllers) controller.abort(busy());
      const quiet = Promise.allSettled([...active]).then(() => undefined);
      closeFlight = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(busy()), closeMs);
        void quiet.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(busy()); });
      });
      return closeFlight;
    },
  };
  return service;
}
