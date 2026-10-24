import { mobileResourceCapacityFailure } from './resource-capacity-trace.js';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { mobilePreparationAsync, mobilePreparationSync, withoutMobilePreparationContext } from './capability-trace.js';
import { mobileRangeWindowObserve, mobileRangeWindowQueued, withoutMobileRangeWindowContext } from './range-window-observer.js';
import { decodePlaybackStorage, encodePlaybackStorage, type DecodedPlaybackStorage, type EncodedPlaybackStorage, capturePlaybackStorageBase, capturePlaybackStoragePatch, type PlaybackStoragePatchReply, type PlaybackStorageBase, type PlaybackStoragePatch, type IncrementalPlaybackStateCodecPort } from './playback-state-codec.js';
import { allocateOwnedSealedBytes, ownedSealedByteLength } from './owned-sealed-bytes.js';
import { captureMobileMediaReadBudget } from './media-read-budget.js';
import { createPlaybackHistoryPersistence } from './playback-history.js';
import {
  MOBILE_OPERATION_TABLE, decodeMobileRequest, encodeMobileRequest, mobileDataSnapshot,
  mobileResourceCommandSnapshot, validateMobileReadyAudio, validateMobileGetResourceReply, isMobileDsdSourceAudio, MOBILE_DSD_PCM_PROCESSING_REASON,
  type MobileDecodedRequest, type MobileErrorEnvelope, type MobileJsonValue, type MobileObservation,
  type MobileProcessing, type MobileRequestMap, type MobileResource, type MobileResourceRequest,
  type MobileResourceSemanticContext, type MobileSession,
} from '@music-bridge/contracts';
import { selectLocalBytes } from '../stream/local-file-http.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobilePrincipal, type MobileSealedState } from './types.js';
import {
  MOBILE002_CONTROL_OPERATIONS, MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_NON_DIRECT_READY_WAIT_MS, MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET, MobilePlaybackError,
  type MobilePlaybackControlOperation, type MobilePlaybackControlReply, type MobilePlaybackErrorCode,
  type MobilePlaybackLimits, type MobilePlaybackMediaOperation, type MobilePlaybackMediaReply,
  type MobilePlaybackPreparedSource, type MobilePlaybackPreparingSource, type MobilePlaybackReader, type MobilePlaybackService, type MobilePlaybackServiceOptions,
  type MobilePlaybackAuthPort, type MobilePlaybackSourcePort, type MobilePlaybackReadComposition, type MobilePlaybackReadComposer,
} from './playback-types.js';
import {
  PLAYBACK_STATE_SCHEMA, capturePlaybackSource, capturePlaybackPreparingSource, playbackReadyFacts, playbackCanonical,
  playbackClosed, playbackCopy, playbackFailure, playbackInteger, playbackResourceContext,
  type PlaybackSourceFacts, type PlaybackState, type StoredPlaybackReceipt,
  type StoredPlaybackResource, type StoredPlaybackSession,
} from './playback-state.js';

const CHUNK_BYTES = 64 * 1024, ASSET = 'source';
const readCompositions = new WeakMap<object, { auth: MobilePlaybackAuthPort; source: MobilePlaybackSourcePort; read: MobilePlaybackReadComposer }>();
/** 品牌只证明可信组合端口的归属；每片仍执行两次完整freshAuth，不缓存授权结果。 */
export function createMobilePlaybackReadComposition(auth: MobilePlaybackAuthPort, source: MobilePlaybackSourcePort,
  read: MobilePlaybackReadComposer): MobilePlaybackReadComposition {
  if(typeof read!=='function'||types.isProxy(read))throw new MobilePlaybackError(503,'BUSY');
  const token=Object.freeze(Object.create(null)) as MobilePlaybackReadComposition;
  readCompositions.set(token,{auth,source,read});return token;
}
const DATE_MAX = 8_640_000_000_000_000;
export interface MobilePlaybackCloseFailure {
  stage: 'drain' | 'codec-close'; status: MobilePlaybackError['status']; code: MobilePlaybackErrorCode;
}
const closeFailures = new WeakMap<MobilePlaybackService, readonly MobilePlaybackCloseFailure[]>();
/** 仅可信Main/QA的内存闭集快照；无错误对象、stack、自由文本或公开HTTP出口。 */
export function readMobilePlaybackCloseFailures(service: MobilePlaybackService): readonly MobilePlaybackCloseFailure[] {
  return Object.freeze((closeFailures.get(service) ?? []).map(value => Object.freeze({ ...value })));
}
interface RuntimeResource {
  id: string; source: MobilePlaybackPreparedSource; controller: AbortController;
  readers: Map<string, MobilePlaybackReader>; lastActivityAt: number;
  releaseFlight?: Promise<void>; releasing: boolean;
}
interface Preparation {
  resourceId: string; receiptId: string; controller: AbortController;
  reply: Promise<MobilePlaybackControlReply>; resolve(value: MobilePlaybackControlReply): void;
  reject(error: unknown): void; finished: Promise<void>; delivered: boolean;
}
interface PendingCommit { candidate: PlaybackState; plain: string; previousRevision: number }
interface MediaPublication { settled: Promise<void>; resolve(): void }
interface MediaOpen {
  resourceId: string; reserved: boolean; controller: AbortController; quiet: Promise<void>; resolveQuiet(): void;
  work: Set<Promise<unknown>>;
}
interface MediaBinding {
  r: StoredPlaybackResource; runtime: RuntimeResource; resourceSignal: AbortSignal;
  ticket: { expiresAt: number; runtimeEpoch: string };
}
const stamp = (n: number): string => new Date(n).toISOString();
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}(?![\s\S])/u.test(v);
const bytes = (v: unknown, max: number, allowEmpty = false): Uint8Array => {
  if (!(v instanceof Uint8Array) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(v))
    || !(v.buffer instanceof ArrayBuffer) || v.byteLength > max || !allowEmpty && v.byteLength < 1) return playbackFailure(503, 'BUSY');
  return new Uint8Array(v);
};
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const equalHash = (a: string, b: string): boolean => /^[0-9a-f]{64}$/u.test(a) && /^[0-9a-f]{64}$/u.test(b)
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const messages: Record<MobilePlaybackErrorCode, string> = {
  INVALID_REQUEST: '请求无法识别。', UNAUTHORIZED: '设备认证已失效。', IDEMPOTENCY_CONFLICT: '原操作身份不一致。',
  REVISION_CONFLICT: '原状态已变化，请查询原记录。', BUSY: '服务暂时无法完成请求，请查询原记录。',
  SESSION_EXPIRED: '原会话已到期。', SESSION_CLOSED: '原会话已关闭。', RESOURCE_EXPIRED: '原资源已到期。',
  RESOURCE_RELEASED: '原资源已释放。', RESOURCE_REVOKED: '原资源已撤销。', DEVICE_REVOKED: '设备授权已撤销。',
  TICKET_EXPIRED: '媒体票据已到期。', TICKET_INVALID: '媒体票据无效。', TICKET_REVOKED: '媒体票据已撤销。',
  SERVICE_RESTARTED: '服务已重启，原媒体资源已失效。', RESOURCE_BUSY: '资源仍在准备或释放，请稍后查询。',
  SOURCE_CHANGED: '来源内容或选择已变化，请刷新。', UNSUPPORTED_FORMAT: '当前文件链无法提供所请求的格式。',
};
function safeError(error: unknown): MobilePlaybackError {
  if (error instanceof MobilePlaybackError && Object.hasOwn(messages, error.code)
    && [400, 401, 403, 404, 409, 410, 429, 503].includes(error.status) && typeof error.retryable === 'boolean'
    && (error.retryAfterMs === undefined || playbackInteger(error.retryAfterMs))) return error;
  if (error instanceof MobileServiceError) {
    if (error.code === 'SOURCE_CHANGED' || error.code === 'UNSUPPORTED_FORMAT') return new MobilePlaybackError(409, error.code);
    if (error.code === 'INVALID_REQUEST') return new MobilePlaybackError(400, error.code);
  }
  return new MobilePlaybackError(503, 'BUSY', true, 1_000);
}
function codeError(code: MobilePlaybackErrorCode): MobilePlaybackError {
  if (code === 'SERVICE_RESTARTED' || code === 'BUSY') return new MobilePlaybackError(503, code, true, 1_000);
  if (code === 'RESOURCE_BUSY') return new MobilePlaybackError(429, code, true, 1_000);
  if (code === 'DEVICE_REVOKED') return new MobilePlaybackError(403, code);
  if (code.startsWith('TICKET_')) return new MobilePlaybackError(401, code);
  if (code === 'SOURCE_CHANGED' || code === 'UNSUPPORTED_FORMAT') return new MobilePlaybackError(409, code);
  return new MobilePlaybackError(410, code);
}
function failureBody(error: MobilePlaybackError): MobileErrorEnvelope {
  return { error: { code: error.code, message: messages[error.code], requestId: randomUUID(), retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) } };
}
function terminalFailureBudget(): typeof MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET {
  const jsonBytes = (value: string | number): number => Buffer.byteLength(JSON.stringify(value));
  const actual = {
    codeJsonBytes: Math.max(...Object.keys(messages).map(jsonBytes)),
    messageJsonBytes: Math.max(...Object.values(messages).map(jsonBytes)),
    requestIdJsonBytes: jsonBytes(randomUUID()),
    retryAfterJsonBytes: jsonBytes(Number.MAX_SAFE_INTEGER),
  };
  // 上界来自本文件实际可产生的闭集；固定策略由私有codec再次精确校验，不能由调用方缩小。
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
    if (actual[key] > MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET[key]) throw new MobilePlaybackError(503, 'BUSY', true, 1_000);
  }
  return MOBILE_PLAYBACK_TERMINAL_FAILURE_BUDGET;
}
function resolveLimits(raw: MobilePlaybackServiceOptions['limits']): Readonly<MobilePlaybackLimits> {
  const limits = { ...MOBILE_PLAYBACK_DEFAULT_LIMITS };
  if (raw !== undefined) {
    if (!playbackClosed(raw, Object.keys(raw)) || Object.keys(raw).some(k => !Object.hasOwn(limits, k))) return playbackFailure(400, 'INVALID_REQUEST');
    for (const key of Object.keys(raw) as (keyof MobilePlaybackLimits)[]) {
      const value = raw[key];
      if (!playbackInteger(value, key === 'readyWaitMs' ? 0 : 1, MOBILE_PLAYBACK_DEFAULT_LIMITS[key])) return playbackFailure(400, 'INVALID_REQUEST');
      limits[key] = value;
    }
  }
  if (limits.ticketTtlMs > limits.resourceTtlMs || limits.maxReadsPerResource > limits.maxReads
    || limits.maxLiveResources > limits.maxStoredResources || limits.maxLiveSessions > limits.maxStoredSessions) return playbackFailure(400, 'INVALID_REQUEST');
  return Object.freeze(limits);
}

/** 可信 Main 的逻辑作者。FD、物理锁和真正释放只由原 Dataset Owner sourcePort 持有。 */
export function createMobilePlaybackService(options: MobilePlaybackServiceOptions): MobilePlaybackService {
  const { serverId, datasetId, responseOrigin, auth, crypto, sourcePort } = options;
  const suppliedComposition=options.readComposition;
  const qualifiedComposition=suppliedComposition&&typeof suppliedComposition==='object'&&!types.isProxy(suppliedComposition)
    ?readCompositions.get(suppliedComposition):undefined;
  const readComposition=qualifiedComposition?.auth===auth&&qualifiedComposition.source===sourcePort?qualifiedComposition.read:undefined;
  if (!id(serverId) || !id(datasetId)) return playbackFailure(400, 'INVALID_REQUEST');
  try { const origin = new URL(responseOrigin); if (origin.protocol !== 'https:' || origin.origin !== responseOrigin || origin.username || origin.password) return playbackFailure(400, 'INVALID_REQUEST'); }
  catch { return playbackFailure(400, 'INVALID_REQUEST'); }
  const limits = resolveLimits(options.limits), clock = options.nowMs ?? Date.now;
  const failureBudget = terminalFailureBudget();
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  const runtimeEpoch = randomUUID(), signingKey = randomBytes(32);
  let state: PlaybackState | undefined, pending: PendingCommit | undefined;
  let stateBase: { value: PlaybackStorageBase; generation: string } | undefined;
  const incremental = options.stateCodec as Partial<IncrementalPlaybackStateCodecPort> | undefined;
  const frozenSnapshots = new WeakSet<object>();
  function freezeSnapshot(value: unknown): void {
    if (!value || typeof value !== 'object' || frozenSnapshots.has(value)) return;
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value); frozenSnapshots.add(value);
  }
  function resultBase(result: DecodedPlaybackStorage, generation: string): typeof stateBase {
    if (typeof incremental?.derive !== 'function' || !Object.hasOwn(result,'base')) return undefined;
    const value = capturePlaybackStorageBase((result as unknown as {base:unknown}).base);
    if (value.revision !== result.state.revision || value.commitId !== result.state.commitId) return playbackFailure(503,'BUSY');
    return {value,generation};
  }
  type StateEdit = { kind:'createResource'|'publishResource';resourceId:string;receiptId:string } | {kind:'createSession';sessionId:string;receiptId:string};
  function resourceCandidate(resourceId?: string, receiptId?: string): PlaybackState {
    if (!stateBase) return playbackCopy(state!);
    // 旧片段只读；仅闭集目标复制为可写值，复杂操作仍走原整树副本。
    return {...state!,resources:state!.resources.map(row=>row.id===resourceId?playbackCopy(row):row),
      receipts:state!.receipts.map(row=>row.id===receiptId?playbackCopy(row):row)};
  }
  function sharedResult(result: PlaybackState, edit: StateEdit): PlaybackState {
    if(edit.kind==='createSession'){const session=result.sessions.find(row=>row.id===edit.sessionId),receipt=result.receipts.find(row=>row.id===edit.receiptId);
      if(!session||!receipt)return playbackFailure(503,'BUSY');
      return {...result,resources:state!.resources,sessions:[...state!.sessions,session],receipts:[...state!.receipts,receipt]};}
    const resource=result.resources.find(row=>row.id===edit.resourceId),receipt=result.receipts.find(row=>row.id===edit.receiptId);
    if(!resource||!receipt)return playbackFailure(503,'BUSY');
    return {...result,sessions:state!.sessions,
      resources:edit.kind==='createResource'?[...state!.resources,resource]:state!.resources.map(row=>row.id===resource.id?resource:row),
      receipts:edit.kind==='createResource'?[...state!.receipts,receipt]:state!.receipts.map(row=>row.id===receipt.id?receipt:row)};
  }
  function patchResult(result: PlaybackStoragePatchReply, expected: PlaybackStoragePatch, base: PlaybackStorageBase,
    generation: string, revision: number, commitId: string): EncodedPlaybackStorage & {base:PlaybackStorageBase} {
    if(!state || !frozenSnapshots.has(state) || !stateBase || stateBase.generation!==generation
      || playbackCanonical(stateBase.value)!==playbackCanonical(base)
      || types.isProxy(result) || !playbackClosed(result,['canonical','format','bytes','base','previousBase','patch']))return playbackFailure(503,'BUSY');
    const previous=capturePlaybackStorageBase(result.previousBase),next=capturePlaybackStorageBase(result.base);
    if(playbackCanonical(previous)!==playbackCanonical(base)||next.revision!==revision||next.commitId!==commitId
      || typeof result.canonical!=='string'||Buffer.byteLength(result.canonical)>limits.stateBytes
      || !['v1','v2','v3','v4','v5','v6'].includes(result.format))return playbackFailure(503,'BUSY');
    const patch=capturePlaybackStoragePatch(result.patch,codecContext(revision,commitId,generation));
    if(playbackCanonical(patch)!==playbackCanonical(expected))return playbackFailure(503,'BUSY');
    const nextState:PlaybackState={...state,revision,commitId,clockFloor:patch.clockFloor,
      ...(patch.kind==='createSession'?{sessions:[...state.sessions,patch.session]}:
        {resources:patch.kind==='createResource'?[...state.resources,patch.resource]:state.resources.map(row=>row.id===patch.resource.id?patch.resource:row)}),
      receipts:patch.kind==='publishResource'?state.receipts.map(row=>row.id===patch.receipt.id?patch.receipt:row):[...state.receipts,patch.receipt]};
    return {state:nextState,canonical:result.canonical,format:result.format,bytes:result.bytes,base:next};
  }
  let mediaInitialized = false, publication: MediaPublication | undefined;
  const mediaOpens = new Set<MediaOpen>();
  const terminalMedia = new Map<string, { count: number; settled: Promise<void>; resolve(): void }>();
  let codecFence = 0;
  const codecInvalidations = new WeakSet<object>();
  let floor = 0, closing = false, fatal = false, tail: Promise<void> = Promise.resolve(), closeFlight: Promise<void> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let initialization: Promise<void> | undefined;
  const runtimes = new Map<string, RuntimeResource>(), preparations = new Map<string, Preparation>();
  const unresolvedPreparations = new Set<Promise<MobilePlaybackPreparedSource | MobilePlaybackPreparingSource>>();
  const sourceFlights = new Map<string, { raw: Promise<MobilePlaybackPreparedSource | MobilePlaybackPreparingSource>; lateRelease?: Promise<void> }>();
  const background = new Set<Promise<void>>();
  const aad = (revision: number): Uint8Array => Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', serverId, datasetId, revision]));
  const digest = (domain: string, value: unknown): string => hash(playbackCanonical(['MBM002_PLAYBACK_V1', serverId, datasetId, domain, value]));
  const trackBackground = (operation: Promise<void>): void => {
    background.add(operation); void operation.catch(() => { fatal = true; }).finally(() => { background.delete(operation); });
  };
  function now(): number {
    const value = clock(); if (!playbackInteger(value, 0, DATE_MAX - limits.maximumResourceLifetimeMs)) return playbackFailure(503, 'BUSY');
    floor = Math.max(floor, state?.clockFloor ?? 0, value); return floor;
  }
  function open(): void { if (closing || fatal) return playbackFailure(503, 'SERVICE_RESTARTED'); }
  const codecGeneration = (): string => `${runtimeEpoch}:${codecFence}`;
  function codecCurrent(generation: string): void {
    open();
    if (generation !== codecGeneration()) {
      const error = new MobilePlaybackError(503, 'BUSY', true, 1_000);
      codecInvalidations.add(error); throw error;
    }
  }
  const codecContext = (revision: number, commitId: string | null, generation: string) =>
    ({ serverId, datasetId, responseOrigin, generation, revision, commitId, limits, terminalFailureBudget: failureBudget });
  const history = options.history ? createPlaybackHistoryPersistence({ serverId, datasetId, responseOrigin, limits,
    port: options.history, crypto, ...(options.stateCodec ? { codec: options.stateCodec } : {}),
    context: (revision, commitId) => codecContext(revision, commitId, codecGeneration()), current: open }) : undefined;
  const persistence = history?.persistence ?? options.persistence;
  function enqueue<T>(operation: () => Promise<T> | T, kind: string = 'control-other'): Promise<T> {
    const flight = tail.then(mobileRangeWindowQueued('open', kind, operation)); tail = flight.then(() => undefined, () => undefined); return flight;
  }
  function deadline<T>(operation: Promise<T>, ms: number, error: MobilePlaybackError, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(error); }, ms); })])
      .finally(() => { if (timer) clearTimeout(timer); });
  }
  function pauseReaders(): void { for (const runtime of runtimes.values()) runtime.controller.abort(); }
  function restoreRuntimeFences(): void {
    for (const runtime of runtimes.values()) {
      const r = state?.resources.find(v => v.id === runtime.id);
      if (r && ['preparing', 'ready'].includes(r.state) && !runtime.releasing && runtime.controller.signal.aborted) runtime.controller = new AbortController();
    }
  }
  async function readPersisted(): Promise<DecodedPlaybackStorage> {
    const generation = codecGeneration();
    const value: MobileSealedState = await mobilePreparationAsync('preparation.playback.owner-load', () => persistence.load(datasetId));
    codecCurrent(generation);
    if (value.kind === 'missing') {
      const captured = mobilePreparationSync<DecodedPlaybackStorage>('preparation.playback.envelope', () => {
        if (!playbackClosed(value, ['kind', 'datasetId', 'revision']) || value.datasetId !== datasetId || value.revision !== 0) return playbackFailure(503, 'BUSY');
        const state: PlaybackState = { schema: PLAYBACK_STATE_SCHEMA, serverId, datasetId, revision: 0, commitId: null, clockFloor: 0, sessions: [], resources: [], receipts: [] };
        return { state, canonical: playbackCanonical(state), format: 'v1' };
      });
      await history?.ensureActivated(captured.canonical); codecCurrent(generation); return captured;
    }
    const sealed = mobilePreparationSync('preparation.playback.envelope', () => {
      if (!playbackClosed(value, ['kind', 'datasetId', 'revision', 'commitId', 'sealed']) || value.kind !== 'sealed'
        || value.datasetId !== datasetId || !playbackInteger(value.revision, 1) || !id(value.commitId)) return playbackFailure(503, 'BUSY');
      return bytes(value.sealed, limits.sealedBytes);
    });
    let plain: Uint8Array | undefined;
    try {
      plain = mobilePreparationSync('preparation.playback.decrypt', () => bytes(crypto.open(sealed, aad(value.revision)), limits.stateBytes));
      const captured = options.stateCodec
        ? await mobilePreparationAsync('preparation.playback.state', () => options.stateCodec!.decode(plain!, codecContext(value.revision, value.commitId, generation)))
        : mobilePreparationSync('preparation.playback.state', () => decodePlaybackStorage(plain!, serverId, datasetId, responseOrigin, limits));
      codecCurrent(generation);
      if (captured.state.revision !== value.revision || captured.state.commitId !== value.commitId) return playbackFailure(503, 'BUSY');
      await history?.ensureActivated(captured.canonical); codecCurrent(generation);
      return captured;
    } finally { sealed.fill(0); plain?.fill(0); }
  }
  async function save(candidate: PlaybackState, edit?: StateEdit, skipUnsentPreparing?: () => boolean): Promise<void> {
    const previousRevision = mobilePreparationSync('preparation.playback.save-admission', () => {
      if (!state || pending || fatal) return playbackFailure(503, 'BUSY');
      const previousRevision = state.revision;
      if (previousRevision === Number.MAX_SAFE_INTEGER) return playbackFailure(503, 'BUSY');
      return previousRevision;
    });
    candidate.revision = previousRevision + 1; candidate.commitId = randomUUID(); candidate.clockFloor = now();
    const generation = codecGeneration();
    const useDelta = edit && stateBase && stateBase.generation===generation && stateBase.value.revision===state!.revision
      && stateBase.value.commitId===state!.commitId && typeof incremental?.derive==='function';
    const base = useDelta ? stateBase!.value : undefined;
    // 全量资格变化/失败不保留旧handle；下一次可重新全量建证，不以缓存命中决定接受性。
    if (!useDelta) stateBase=undefined;
    const patch = useDelta ? capturePlaybackStoragePatch({kind:edit!.kind,clockFloor:candidate.clockFloor,
        ...(edit!.kind==='createSession'?{session:candidate.sessions.find(row=>row.id===(edit as Extract<StateEdit,{kind:'createSession'}>).sessionId)!}
          :{resource:candidate.resources.find(row=>row.id===(edit as Exclude<StateEdit,{kind:'createSession'}>).resourceId)!}),
        receipt:candidate.receipts.find(row=>row.id===edit!.receiptId)!},codecContext(candidate.revision,candidate.commitId,generation)) : undefined;
    const expectedPatch=patch?playbackCopy(patch):undefined;
    let encoded:EncodedPlaybackStorage;
    if(useDelta&&typeof incremental?.derivePatch==='function'){
      const result=await mobilePreparationAsync('preparation.playback.candidate',()=>incremental.derivePatch!(base!,patch!,codecContext(candidate.revision,candidate.commitId,generation)));
      try {codecCurrent(generation);encoded=patchResult(result,expectedPatch!,base!,generation,candidate.revision,candidate.commitId!);}
      catch(error){
        // 拒绝路径仅清零真实自有字节，不执行未知回包的getter、Proxy或覆盖方法。
        try {if(result&&typeof result==='object'&&!types.isProxy(result)){
          const descriptor=Object.getOwnPropertyDescriptor(result,'bytes');
          if(descriptor&&Object.hasOwn(descriptor,'value')&&types.isUint8Array(descriptor.value))Uint8Array.prototype.fill.call(descriptor.value,0);
        }}catch{/* 清零失败不能覆盖原拒绝原因。 */}
        throw error;
      }
    }else encoded=useDelta
      ? await mobilePreparationAsync('preparation.playback.candidate',()=>incremental!.derive!(base!,patch!,codecContext(candidate.revision,candidate.commitId,generation)))
      : options.stateCodec
        ? await mobilePreparationAsync('preparation.playback.candidate', () => options.stateCodec!.encode(candidate, codecContext(candidate.revision, candidate.commitId, generation)))
        : mobilePreparationSync('preparation.playback.candidate', () => encodePlaybackStorage(candidate, serverId, datasetId, responseOrigin, limits, failureBudget));
    const plainText = encoded.canonical, plain = encoded.bytes;
    // 此前未发Owner写，失效计算不能转成UNKNOWN或新增持久化操作。
    try { codecCurrent(generation); } catch (error) { plain.fill(0); throw error; }
    let nextBase: typeof stateBase;
    try { candidate = useDelta ? sharedResult(encoded.state,edit!) : encoded.state; nextBase = resultBase(encoded,generation); }
    catch(error) { plain.fill(0); throw error; }
    // 仅prepare分支可撤去尚未seal/发送的纯202候选；UNKNOWN及已ACK base仍为原状态。
    // 完整verify+renew若在codec期间已成功，继续原ready提交，不增加等待窗口或重写旧回执。
    if (skipUnsentPreparing?.()) { plain.fill(0); return; }
    let sealed: Uint8Array | undefined;
    let publishing: MediaPublication | undefined;
    try {
      sealed = mobilePreparationSync('preparation.playback.seal', () => {
        const raw = crypto.seal(plain, aad(candidate.revision)), length = ownedSealedByteLength(raw, limits.sealedBytes);
        if (length === null) return bytes(raw, limits.sealedBytes);
        // 仅复制原seal生产者已具资格的专属输出；未知注入crypto仍走原bytes路径。
        const copy = allocateOwnedSealedBytes(length); Uint8Array.prototype.set.call(copy, raw); return copy;
      });
      let resolve!: () => void;
      publishing = { settled: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
      publication = publishing;
      const result = await mobilePreparationAsync('preparation.playback.owner-save', () => persistence.save({ datasetId, expectedRevision: previousRevision, commitId: candidate.commitId!, sealed: sealed! }));
      mobilePreparationSync('preparation.playback.ack', () => {
        if (result.kind === 'conflict' && playbackClosed(result, ['kind', 'datasetId', 'currentRevision']) && result.datasetId === datasetId
          && playbackInteger(result.currentRevision)) { fatal = true; pauseReaders(); return playbackFailure(409, 'REVISION_CONFLICT'); }
        if (!playbackClosed(result, ['kind', 'datasetId', 'revision', 'commitId']) || result.kind !== 'saved' || result.datasetId !== datasetId
          || result.revision !== candidate.revision || result.commitId !== candidate.commitId) {
          pending = { candidate, plain: plainText, previousRevision }; pauseReaders(); return playbackFailure(503, 'BUSY');
        }
      });
      mobilePreparationSync('preparation.playback.published', () => { if(nextBase)freezeSnapshot(candidate);state = candidate;stateBase=nextBase; });
    } catch (error) {
      if (error instanceof MobilePlaybackError && error.code === 'REVISION_CONFLICT') throw error;
      if (error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent') throw new MobilePlaybackError(503, 'BUSY', true, 1_000);
      pending = { candidate, plain: plainText, previousRevision }; pauseReaders(); throw new MobilePlaybackError(503, 'BUSY', true, 1_000);
    } finally {
      plain.fill(0); sealed?.fill(0);
      if (publication === publishing) publication = undefined;
      publishing?.resolve();
    }
  }
  /** 只移走完整、已ACK且真实静止的终态组；不在作者队列等待会回到此队列的finalize。 */
  async function compactHistory(): Promise<void> {
    if (!history || !state || pending || publication || closing || fatal) return;
    const eligible = state.sessions.filter(session => session.terminal
      && !terminalMedia.has(`session:${session.id}`)
      && state!.resources.filter(resource => resource.sessionId === session.id).every(resource =>
        resource.state === 'terminal' && !runtimes.has(resource.id) && !preparations.has(resource.id)
        && !sourceFlights.has(resource.id) && !terminalMedia.has(`resource:${resource.id}`)
        && ![...mediaOpens].some(entry => entry.resourceId === resource.id))).map(session => session.id);
    if (!eligible.length) return;
    const ids = new Set(eligible), candidate = playbackCopy(state);
    candidate.sessions = candidate.sessions.filter(row => !ids.has(row.id));
    candidate.resources = candidate.resources.filter(row => !ids.has(row.sessionId));
    candidate.receipts = candidate.receipts.filter(row => !ids.has(row.sessionId));
    try { await history.prepareArchive(state, eligible); await save(candidate); }
    catch (error) { history.abandonArchive(); throw error; }
  }
  async function loaded(): Promise<PlaybackState> {
    mobilePreparationSync('preparation.playback.open', open);
    if (pending) {
      const observed = await readPersisted();
      mobilePreparationSync('preparation.playback.pending', () => {
        if (observed.state.revision !== pending!.candidate.revision || observed.state.commitId !== pending!.candidate.commitId
          || observed.canonical !== pending!.plain) return playbackFailure(503, 'BUSY');
        stateBase=resultBase(observed,codecGeneration());if(stateBase)freezeSnapshot(observed.state);state = observed.state; pending = undefined; restoreRuntimeFences();
      });
    }
    if (!state) {
      const observed=await readPersisted();stateBase=resultBase(observed,codecGeneration());if(stateBase)freezeSnapshot(observed.state);state = observed.state; floor = Math.max(floor, state.clockFloor);
      // 旧已终态组先腾出热预算；含准备/ready资源的组仍须先完成原恢复提交与ACK。
      await compactHistory();
      const candidate = playbackCopy(state); let changed = false;
      for (const r of candidate.resources) if (['preparing', 'ready'].includes(r.state)) {
        r.state = 'terminal'; r.failure = 'SERVICE_RESTARTED'; r.media = null; changed = true;
      }
      try {if (changed) await mobilePreparationAsync('preparation.playback.recovery-save', () => save(candidate));}
      catch(error){if(!pending){state=undefined;stateBase=undefined;}throw error;}
      await compactHistory();
      if(!closing)sweepTimer = withoutMobileRangeWindowContext(() => withoutMobilePreparationContext(() => setInterval(() => {
        if (closing || fatal || pending) return;
        trackBackground(enqueue(async () => {
          try { if (state && !closing) { await expire(); await compactHistory(); } }
          catch (error) {
            // 只退出本service品牌认证的未写入失效tick；外来BUSY及真正后台失败照常fatal。
            if (error !== null && typeof error === 'object' && codecInvalidations.has(error)) return;
            throw error;
          }
        }, 'expire'));
      }, 1_000))); sweepTimer?.unref();
    }
    mediaInitialized = true; return state;
  }
  function principal(raw: MobilePrincipal): MobilePrincipal {
    if (!playbackClosed(raw, ['serverId', 'deviceId', 'datasetId', 'accountDomain', 'deviceEpoch', 'generation', 'accessTokenHash', 'accessExpiresAt'])
      || raw.serverId !== serverId || raw.datasetId !== datasetId || raw.accountDomain !== `local:${datasetId}`
      || !id(raw.deviceId) || !playbackInteger(raw.deviceEpoch, 1) || !playbackInteger(raw.generation, 1)
      || typeof raw.accessTokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(raw.accessTokenHash)
      || typeof raw.accessExpiresAt !== 'string' || !Number.isFinite(Date.parse(raw.accessExpiresAt))) return playbackFailure(401, 'UNAUTHORIZED');
    // 原品牌由可信 Main authenticate/assertCurrent 保持；此端口只核设备 epoch，不因 refresh 退票。
    return playbackCopy(raw);
  }
  async function deviceCurrent(deviceId: string, deviceEpoch: number): Promise<void> {
    try { await mobilePreparationAsync('preparation.playback.device', () => auth.assertDeviceCurrent(deviceId, deviceEpoch)); }
    catch (error) {
      // 明确的只读授权暂错不是设备撤销；其它未确认或终止故障仍沿原拒绝路径。
      if (error instanceof MobileServiceError && error.status === 503 && error.code === 'BUSY' && error.retryable === true) throw error;
      throw new MobilePlaybackError(403, 'DEVICE_REVOKED');
    }
  }
  function capturedRequest(operation: MobilePlaybackControlOperation | MobilePlaybackMediaOperation, request: MobileDecodedRequest<unknown>,
    p?: MobilePrincipal, dsd=false): MobileDecodedRequest<unknown> {
    const snapshot = mobileDataSnapshot(request);
    if (!snapshot.ok || snapshot.value === null || typeof snapshot.value !== 'object' || !playbackClosed(snapshot.value, ['path', 'pathParameters', 'query', 'body',
      ...(Object.hasOwn(snapshot.value, 'idempotencyKey') ? ['idempotencyKey'] : [])])) return playbackFailure(400, 'INVALID_REQUEST');
    request = snapshot.value as unknown as MobileDecodedRequest<unknown>;
    const sessionId = typeof request?.pathParameters?.sessionId === 'string' ? request.pathParameters.sessionId : 'new-session';
    const context = { responseOrigin, requestPath: request?.path,
      resourceCapabilities: { scope: { serverId, deviceId: p?.deviceId ?? 'media-device', sessionId },
        capabilitySnapshotIdentity: `mbm002:${serverId}`, responseOrigin, now: stamp(now()),
        resourceFormatBitDepth: true, resourceDsdToPcm:dsd, capabilityVersion: '1.0.0' as const } };
    const encoded = encodeMobileRequest(operation, request as MobileRequestMap[typeof operation], context);
    if (!encoded.ok) return playbackFailure(400, 'INVALID_REQUEST');
    const decoded = decodeMobileRequest(operation, encoded.value, context);
    if (!decoded.ok) return playbackFailure(400, 'INVALID_REQUEST'); return playbackCopy(decoded.value);
  }
  async function session(idValue: string | undefined, p: MobilePrincipal): Promise<StoredPlaybackSession> {
    let value = state?.sessions.find(v => v.id === idValue);
    if (!value && idValue && history) {
      const archived = await history.lookup('session', { id: idValue });
      value = archived?.group.sessions.find(row => row.id === archived.locator.recordId);
    }
    if (!value || value.deviceId !== p.deviceId) return playbackFailure(404, 'INVALID_REQUEST');
    if (value.deviceEpoch !== p.deviceEpoch) throw codeError('DEVICE_REVOKED');
    return value;
  }
  async function resource(idValue: string | undefined, s: StoredPlaybackSession): Promise<StoredPlaybackResource> {
    let value = state?.resources.find(v => v.id === idValue);
    if (!value && idValue && history) {
      const archived = await history.lookup('resource', { id: idValue });
      value = archived?.group.resources.find(row => row.id === archived.locator.recordId);
    }
    if (!value || value.sessionId !== s.id || value.deviceId !== s.deviceId || value.deviceEpoch !== s.deviceEpoch) return playbackFailure(404, 'INVALID_REQUEST'); return value;
  }
  function liveSession(s: StoredPlaybackSession): void {
    if (s.terminal) throw codeError(s.terminal); if (now() >= s.expiresAt) throw codeError('SESSION_EXPIRED');
  }
  function liveResource(r: StoredPlaybackResource): void {
    if (r.state === 'terminal') throw codeError(r.failure!);
    if (now() >= r.expiresAt || now() >= r.hardExpiresAt) throw codeError('RESOURCE_EXPIRED');
  }
  function sessionBody(s: StoredPlaybackSession): MobileSession {
    return { id: s.id, deviceId: s.deviceId, createdAt: stamp(s.createdAt), expiresAt: stamp(s.expiresAt) };
  }
  function resourceBody(r: StoredPlaybackResource): MobileResource {
    if (!r.source) throw codeError(r.failure ?? 'RESOURCE_BUSY');
    const identity = { id: r.id, sessionId: r.sessionId, trackId: r.request.trackId, versionId: r.request.versionId,
      contentRevision: r.request.contentRevision, sourceAudio: playbackCopy(r.source.sourceAudio), processing: playbackCopy(r.source.processing) };
    if (r.state === 'ready' && r.media) return { ...identity, state: 'ready', media: playbackCopy(r.media) };
    if (r.state === 'preparing') return { ...identity, state: 'preparing', retryAfterMs: 100 };
    return { ...identity, state: 'failed', failure: failureBody(codeError(r.failure ?? 'SOURCE_CHANGED')) };
  }
  function reply(status: MobilePlaybackControlReply['status'], body: MobilePlaybackControlReply['body'], p: MobilePrincipal,
    resourceContext?: MobileResourceSemanticContext): MobilePlaybackControlReply {
    return { status, headers: [['Cache-Control', 'no-store']], body: playbackCopy(body),
      ...(resourceContext ? { resourceContext: playbackCopy(resourceContext) } : {}),
      async beforeSend() {
        open(); if (pending) return playbackFailure(503, 'BUSY'); await deviceCurrent(p.deviceId, p.deviceEpoch);
        if (resourceContext?.source === 'netease') {
          const live = resourceContext.expectedResourceId === null ? undefined : runtimes.get(resourceContext.expectedResourceId);
          if (!live || live.releasing) return playbackFailure(409, 'SOURCE_CHANGED');
          await sourcePort.verify(live.source.handle); await deviceCurrent(p.deviceId, p.deviceEpoch);
        }
        open();
      } };
  }
  function original(receipt: StoredPlaybackReceipt, p: MobilePrincipal): MobilePlaybackControlReply {
    if (receipt.state !== 'RECORDED' || !receipt.reply) return playbackFailure(503, 'RESOURCE_BUSY');
    return reply(receipt.reply.status as MobilePlaybackControlReply['status'], receipt.reply.body, p, receipt.resourceContext ?? undefined);
  }
  function receiptIdentity(operation: StoredPlaybackReceipt['operation'], request: MobileDecodedRequest<unknown>, p: MobilePrincipal) {
    if (request.idempotencyKey === undefined) return playbackFailure(400, 'INVALID_REQUEST');
    const keyHash = digest('key', [p.deviceId, p.deviceEpoch, request.idempotencyKey]);
    const scopeHash = digest('scope', [p.deviceId, p.deviceEpoch, operation, MOBILE_OPERATION_TABLE[operation].method, request.path]);
    const fingerprint = digest('request', [scopeHash, request.body]); return { keyHash, scopeHash, fingerprint };
  }
  async function findReceipt(identity: ReturnType<typeof receiptIdentity>, p: MobilePrincipal): Promise<StoredPlaybackReceipt | undefined> {
    let r = state?.receipts.find(v => v.deviceId === p.deviceId && v.deviceEpoch === p.deviceEpoch && equalHash(v.keyHash, identity.keyHash));
    if (!r && history) {
      const archived = await history.lookup('receipt', { deviceId: p.deviceId, deviceEpoch: p.deviceEpoch, keyHash: identity.keyHash });
      r = archived?.group.receipts.find(row => row.id === archived.locator.recordId);
    }
    if (r && (!equalHash(r.fingerprint, identity.fingerprint) || !equalHash(r.scopeHash, identity.scopeHash))) return playbackFailure(409, 'IDEMPOTENCY_CONFLICT');
    return r;
  }
  function room(): void {
    if (!state) return playbackFailure(429, 'RESOURCE_BUSY');
    if (state.receipts.length >= limits.maxReceipts) return mobileResourceCapacityFailure('capacity.actor.receipts-full', () => playbackFailure(429, 'RESOURCE_BUSY'));
  }
  function addReceipt(candidate: PlaybackState, operation: StoredPlaybackReceipt['operation'], request: MobileDecodedRequest<unknown>,
    p: MobilePrincipal, sessionId: string, resourceId: string | null): StoredPlaybackReceipt {
    const r: StoredPlaybackReceipt = { id: randomUUID(), operation, deviceId: p.deviceId, deviceEpoch: p.deviceEpoch,
      ...receiptIdentity(operation, request, p), request: playbackCopy(request), createdAt: now(), sessionId, resourceId, state: 'UNKNOWN', reply: null, resourceContext: null };
    candidate.receipts.push(r); return r;
  }
  function installTicket(r: StoredPlaybackResource): void {
    if (!playbackReadyFacts(r.source)) return playbackFailure(503, 'RESOURCE_BUSY');
    const expiresAt = Math.min(now() + limits.ticketTtlMs, r.expiresAt, r.hardExpiresAt);
    if (expiresAt <= now()) throw codeError('RESOURCE_EXPIRED');
    const nonce = randomToken(); if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) return playbackFailure(503, 'BUSY');
    const payload = Buffer.from(JSON.stringify([runtimeEpoch, r.id, expiresAt, nonce])).toString('base64url');
    const signature = createHmac('sha256', signingKey).update(playbackCanonical([serverId, datasetId, r.deviceId, r.deviceEpoch, r.sessionId, ASSET, payload])).digest('base64url');
    const token = `v1.${payload}.${signature}`;
    if (token.length > 512 || r.tickets.some(v => equalHash(v.hash, hash(token)))) return playbackFailure(429, 'RESOURCE_BUSY');
    if (r.tickets.length >= limits.maxReceipts + limits.maxStoredResources) return mobileResourceCapacityFailure('capacity.actor.tickets-full', () => playbackFailure(429, 'RESOURCE_BUSY'));
    r.tickets.push({ hash: hash(token), expiresAt, runtimeEpoch });
    r.media = { url: `${responseOrigin}/mobile/v1/media/${r.id}/${ASSET}?ticket=${token}`, transport: 'file',
      expiresAt: stamp(expiresAt), durationMs: r.source.durationMs, seekable: r.source.seekable, actualAudio: playbackCopy(r.source.actualAudio) };
  }
  async function releaseRuntime(idValue: string, fromPreparation = false): Promise<void> {
    const task = preparations.get(idValue); task?.controller.abort();
    if (task && !fromPreparation) await deadline(task.finished, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
    if (!fromPreparation) {
      const sourceFlight = sourceFlights.get(idValue);
      if (sourceFlight) {
        await deadline(sourceFlight.raw.catch(() => undefined), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
        if (sourceFlight.lateRelease) await deadline(sourceFlight.lateRelease, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
      }
    }
    const runtime = runtimes.get(idValue); if (!runtime) return;
    runtime.controller.abort(); if (runtime.releaseFlight) return deadline(runtime.releaseFlight, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
    runtime.releasing = true;
    const actual = (async () => {
      await Promise.all([...runtime.readers.values()].map(r => r.close()));
      await sourcePort.release(runtime.source.handle); runtimes.delete(idValue);
    })();
    runtime.releaseFlight = actual;
    try { await deadline(actual, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY')); }
    catch (error) { throw safeError(error); }
  }
  function markTerminal(candidate: PlaybackState, ids: readonly string[], reason: MobilePlaybackErrorCode): void {
    for (const idValue of ids) {
      preparations.get(idValue)?.controller.abort(); runtimes.get(idValue)?.controller.abort();
      const r = candidate.resources.find(v => v.id === idValue);
      if (r && r.state !== 'terminal') { r.state = 'terminal'; r.failure = reason; r.media = null; }
    }
  }
  async function expire(): Promise<void> {
    if (!state || pending || closing) return;
    const at = now();
    const expiredSession = (s: StoredPlaybackSession): boolean => !s.terminal && at >= s.expiresAt;
    const expiredResource = (r: StoredPlaybackResource): boolean => ['preparing', 'ready'].includes(r.state)
      && (at >= r.expiresAt || at >= r.hardExpiresAt || at >= (runtimes.get(r.id)?.lastActivityAt ?? r.lastActivityAt) + limits.orphanResourceMs);
    // 同一时间快照内先只读判断；无到期变更时不复制整本历史，期间不引入异步窗口。
    if (!state.sessions.some(expiredSession) && !state.resources.some(expiredResource)) return;
    const candidate = playbackCopy(state), ids: string[] = []; let changed = false;
    for (const s of candidate.sessions) if (expiredSession(s)) {
      s.terminal = 'SESSION_EXPIRED'; const owned = candidate.resources.filter(r => r.sessionId === s.id && r.state !== 'terminal').map(r => r.id);
      markTerminal(candidate, owned, 'SESSION_EXPIRED'); ids.push(...owned); changed = true;
    }
    for (const r of candidate.resources) if (expiredResource(r)) {
      markTerminal(candidate, [r.id], 'RESOURCE_EXPIRED'); ids.push(r.id); changed = true;
    }
    if (changed) { await mobilePreparationAsync('preparation.playback.expire-save', () => save(candidate)); trackBackground(Promise.all(ids.map(v => releaseRuntime(v))).then(() => undefined)); }
  }
  async function checkRuntime(r: StoredPlaybackResource, runtime: RuntimeResource): Promise<void> {
    open(); if (pending) return playbackFailure(503, 'BUSY'); liveResource(r);
    const s = state?.sessions.find(v => v.id === r.sessionId); if (!s) return playbackFailure(404, 'INVALID_REQUEST'); liveSession(s);
    if (r.runtimeEpoch !== runtimeEpoch || runtime.releasing || runtime.controller.signal.aborted) throw codeError('RESOURCE_REVOKED');
    await deviceCurrent(r.deviceId, r.deviceEpoch);
    open(); if (pending || runtime.controller.signal.aborted || runtime.releasing) return playbackFailure(401, 'TICKET_REVOKED');
    const current = state?.resources.find(v => v.id === r.id); if (!current) return playbackFailure(404, 'INVALID_REQUEST'); liveResource(current);
  }
  async function recordPreparationFailure(task: Preparation, error: unknown, p: MobilePrincipal,
    facts?:NonNullable<StoredPlaybackResource['source']>): Promise<void> {
    const failure = safeError(error);
    await enqueue(async () => {
      if (!state || pending || closing || fatal) throw failure;
      const failedCandidate=(includeFacts:boolean):PlaybackState=>{
        const candidate=playbackCopy(state!),r=candidate.resources.find(v=>v.id===task.resourceId),receipt=candidate.receipts.find(v=>v.id===task.receiptId);
        if(!r||!receipt)throw failure;
        if(includeFacts&&facts)r.source=playbackCopy(facts);
        if(r.state!=='terminal'){r.state='failed';r.failure=failure.code;r.media=null;}
        if(receipt.state==='UNKNOWN'){receipt.state='RECORDED';receipt.reply={status:failure.status,body:failureBody(failure)};receipt.resourceContext=null;}
        return candidate;
      };
      try{await save(failedCandidate(true));}catch(error){
        // 只在未送Owner的容量拒绝后使用原UNKNOWN预留；丢ACK、冲突和关闭不重写。
        if(!facts||pending||fatal||closing||!(error instanceof MobilePlaybackError)||error.status!==429||error.code!=='RESOURCE_BUSY')throw error;
        await save(failedCandidate(false));
      }
      if (!task.delivered) { task.delivered = true; task.resolve(original(state!.receipts.find(v => v.id === task.receiptId)!, p)); }
    }, 'createResource');
  }
  function capturePrepared(raw:unknown):MobilePlaybackPreparedSource | MobilePlaybackPreparingSource{
    return raw && typeof raw==='object' && Object.hasOwn(raw,'preparing') ? capturePlaybackPreparingSource(raw) : capturePlaybackSource(raw);
  }
  function dsdTarget(request:MobileResourceRequest):Readonly<{maxChannels:number;accepts24Bit48KhzFlac:boolean}>{
    const formats=request.formats.filter(f=>f.codec==='flac' && f.container==='flac' && f.maxSampleRateHz>=48000
      && (f.maxBitsPerSample===undefined || f.maxBitsPerSample>=24));
    const allowed=request.quality.profile==='auto' && !request.quality.allowLossyFallback && request.quality.preferredTransport==='file' && formats.length>0;
    return {maxChannels:allowed?Math.max(...formats.map(f=>f.maxChannels)):0,accepts24Bit48KhzFlac:allowed};
  }
  function preparationDeadline(resource:StoredPlaybackResource,session:StoredPlaybackSession):number{
    return Math.min(resource.createdAt+240_000,resource.expiresAt,session.expiresAt);
  }
  async function publishPreparing(task:Preparation,p:MobilePrincipal,facts:NonNullable<StoredPlaybackResource['source']>,verified?:()=>boolean):Promise<void>{
    await enqueue(async()=>{
      open();await loaded();await deviceCurrent(p.deviceId,p.deviceEpoch);task.controller.signal.throwIfAborted();
      const current=state!.resources.find(v=>v.id===task.resourceId)!,sessionValue=state!.sessions.find(v=>v.id===current.sessionId)!;
      liveSession(sessionValue);liveResource(current);
      // 只在候选尚未构造时观察完整verify+renew成功；真正DSD preparing没有此捷径。
      if(verified?.())return;
      const candidate=resourceCandidate(task.resourceId,task.receiptId),r=candidate.resources.find(v=>v.id===task.resourceId)!,receipt=candidate.receipts.find(v=>v.id===task.receiptId)!;
      const s=candidate.sessions.find(v=>v.id===r.sessionId)!;
      r.source=playbackCopy(facts);
      const body=resourceBody(r),context=playbackResourceContext(serverId,responseOrigin,s,r,now());
      if(body.state!=='preparing'||!validateMobileGetResourceReply(200,body,context).ok)throw codeError('UNSUPPORTED_FORMAT');
      if(receipt.state==='UNKNOWN'){
        receipt.state='RECORDED';receipt.reply={status:202,body};receipt.resourceContext=context;
        let superseded=false;
        await save(candidate,{kind:'publishResource',resourceId:task.resourceId,receiptId:task.receiptId},verified?()=>{
          superseded=verified();return superseded;
        }:undefined);
        if(superseded)return;
      }
      if(!task.delivered){task.delivered=true;task.resolve(original(state!.receipts.find(v=>v.id===receipt.id)!,p));}
    }, 'createResource');
  }
  async function prepareResource(task: Preparation, p: MobilePrincipal): Promise<void> {
    let prepared: MobilePlaybackPreparedSource | MobilePlaybackPreparingSource | undefined;
    try {
      const r = state!.resources.find(v => v.id === task.resourceId)!, s=state!.sessions.find(v=>v.id===r.sessionId)!;
      const accepts=r.resourceDsdToPcm===true && r.request.acceptedProcessingModes?.[0]==='dsd_to_pcm';
      const at=now(), remaining=Math.max(0,preparationDeadline(r,s)-at);
      const sourceRequest = {resourceId:r.id,trackId:r.request.trackId,versionId:r.request.versionId,contentRevision:r.request.contentRevision,
        ...(accepts?{acceptedProcessingModes:['dsd_to_pcm'] as const,preparationWindow:{resourceCreatedAtMs:r.createdAt,resourceExpiresAtMs:r.expiresAt,sessionExpiresAtMs:s.expiresAt,remainingPreparationMs:remaining},dsdTarget:dsdTarget(r.request)}:{})};
      const actual = sourcePort.prepareBound
        ? sourcePort.prepareBound(sourceRequest, Object.freeze({ deviceId: p.deviceId, deviceEpoch: p.deviceEpoch, accessGeneration: p.generation }), task.controller.signal)
        : sourcePort.prepare(sourceRequest,task.controller.signal);
      const sourceFlight: { raw: Promise<MobilePlaybackPreparedSource | MobilePlaybackPreparingSource>; lateRelease?: Promise<void> } = { raw: actual };
      sourceFlights.set(task.resourceId, sourceFlight); unresolvedPreparations.add(actual);
      void actual.then(value => {
        if (task.controller.signal.aborted && !runtimes.has(task.resourceId)) {
          sourceFlight.lateRelease = sourcePort.release(capturePrepared(value).handle); trackBackground(sourceFlight.lateRelease);
        }
      }, () => undefined).finally(() => {
        unresolvedPreparations.delete(actual);
        if (sourceFlight.lateRelease) void sourceFlight.lateRelease.then(() => sourceFlights.delete(task.resourceId), () => { fatal = true; });
        else sourceFlights.delete(task.resourceId);
      }).catch(() => { fatal = true; });
      prepared=capturePrepared(await deadline(actual,limits.prepareTimeoutMs,codeError('RESOURCE_BUSY'),()=>task.controller.abort()));
      task.controller.signal.throwIfAborted();
      if('preparing' in prepared){
        if(!accepts || !sourcePort.status || prepared.processing.mode!=='dsd_to_pcm' || !isMobileDsdSourceAudio(prepared.sourceAudio))throw codeError('UNSUPPORTED_FORMAT');
        const captured=prepared;
        await publishPreparing(task,p,{sourceAudio:captured.sourceAudio,processing:captured.processing,
          durationMs:captured.durationMs,seekable:captured.seekable});
        while('preparing' in prepared){
          const originalDeadline=preparationDeadline(r,s),budget=originalDeadline-now()-10_000;
          if(budget<=0)throw codeError('RESOURCE_BUSY');
          // 每次 status 只查原handle，仍独立原10秒RPC，不重发 begin/扩准备窗口。
          prepared=capturePrepared(await deadline(sourcePort.status(captured.handle,task.controller.signal),Math.min(limits.prepareTimeoutMs,budget),codeError('RESOURCE_BUSY'),()=>task.controller.abort()));
          task.controller.signal.throwIfAborted();
          if(prepared.handle!==captured.handle || playbackCanonical(prepared.sourceAudio)!==playbackCanonical(captured.sourceAudio)
            || prepared.processing.mode!=='dsd_to_pcm' || prepared.processing.reason!==captured.processing.reason
            || prepared.durationMs!==captured.durationMs || prepared.seekable!==captured.seekable)throw codeError('SOURCE_CHANGED');
          if('preparing' in prepared)await new Promise<void>((resolve,reject)=>{
            const aborted=():void=>{clearTimeout(timer);task.controller.signal.removeEventListener('abort',aborted);reject(codeError('RESOURCE_RELEASED'));};
            const timer=setTimeout(()=>{task.controller.signal.removeEventListener('abort',aborted);resolve();},Math.min(100,budget));
            task.controller.signal.addEventListener('abort',aborted,{once:true});if(task.controller.signal.aborted)aborted();
          });
        }
      }
      if ('preparing' in prepared) throw codeError('RESOURCE_BUSY');
      const readySource=prepared;
      runtimes.set(task.resourceId,{id:task.resourceId,source:readySource,controller:task.controller,readers:new Map(),lastActivityAt:now(),releasing:false});
      const {handle:_handle,...facts}=readySource;
      const direct=readySource.processing.mode==='direct'&&!readySource.processing.fromPreparedCache
        && playbackCanonical(readySource.sourceAudio)===playbackCanonical(readySource.actualAudio);
      let verified=false;
      const verification=deadline((async()=>{await sourcePort.verify(readySource.handle);task.controller.signal.throwIfAborted();
        await sourcePort.renew(readySource.handle);task.controller.signal.throwIfAborted();})(),limits.prepareTimeoutMs,codeError('RESOURCE_BUSY'),()=>task.controller.abort()).then(()=>{verified=true;});
      const waitMs=direct?limits.readyWaitMs:Math.min(limits.readyWaitMs,MOBILE_PLAYBACK_NON_DIRECT_READY_WAIT_MS);
      let waitTimer:ReturnType<typeof setTimeout>|undefined,abortWait:(()=>void)|undefined;
      const quick=await Promise.race([verification.then(()=>true),new Promise<false>(resolve=>{waitTimer=setTimeout(()=>resolve(false),waitMs);}),
        new Promise<never>((_resolve,reject)=>{abortWait=()=>{try{task.controller.signal.throwIfAborted();}catch(error){reject(error);}};
          task.controller.signal.addEventListener('abort',abortWait,{once:true});if(task.controller.signal.aborted)abortWait();})])
        .finally(()=>{if(waitTimer)clearTimeout(waitTimer);if(abortWait)task.controller.signal.removeEventListener('abort',abortWait);});
      if(!quick&&!task.delivered)await publishPreparing(task,p,facts,()=>verified);
      await verification;
      await enqueue(async()=>{open();await loaded();await deviceCurrent(p.deviceId,p.deviceEpoch);task.controller.signal.throwIfAborted();
        const candidate=resourceCandidate(task.resourceId,task.receiptId),value=candidate.resources.find(v=>v.id===task.resourceId)!,receipt=candidate.receipts.find(v=>v.id===task.receiptId)!;
        const sessionValue=candidate.sessions.find(v=>v.id===value.sessionId)!;liveSession(sessionValue);liveResource(value);
        // 外部副作用前的UNKNOWN已落盘；完整事实与公开终态共用一次ACK。
        value.source=playbackCopy(facts);
        value.state='ready';value.failure=null;installTicket(value);
        const body=resourceBody(value),context=playbackResourceContext(serverId,responseOrigin,sessionValue,value,now());
        const dsd=accepts&&readySource.processing.mode==='dsd_to_pcm'&&readySource.processing.reason===MOBILE_DSD_PCM_PROCESSING_REASON;
        if(body.state!=='ready'||!validateMobileReadyAudio(body,value.request,context).ok||(!direct&&!dsd)||value.request.quality.preferredTransport==='hls')throw codeError('UNSUPPORTED_FORMAT');
        if(receipt.state==='UNKNOWN'){receipt.state='RECORDED';receipt.reply={status:201,body};receipt.resourceContext=context;}
        await save(candidate,{kind:'publishResource',resourceId:task.resourceId,receiptId:task.receiptId});if(!task.delivered){task.delivered=true;task.resolve(original(state!.receipts.find(v=>v.id===receipt.id)!,p));}
      }, 'createResource');
    }catch(error){
      const facts=prepared?('preparing' in prepared
        ?{sourceAudio:prepared.sourceAudio,processing:prepared.processing,durationMs:prepared.durationMs,seekable:prepared.seekable}
        :(({handle:_handle,...value})=>value)(prepared)):undefined;
      try{await recordPreparationFailure(task,error,p,facts);}catch(failure){if(!task.delivered){task.delivered=true;task.reject(safeError(failure));}}
      if(runtimes.has(task.resourceId)){try{await releaseRuntime(task.resourceId,true);}catch{fatal=true;}}
      else if(prepared){try{await(sourceFlightFor(task.resourceId)?.lateRelease??sourcePort.release(prepared.handle));}catch{fatal=true;}}
    }finally{preparations.delete(task.resourceId);}
  }
  function sourceFlightFor(resourceId: string) { return sourceFlights.get(resourceId); }
  function startPreparation(resourceId: string, receiptId: string, p: MobilePrincipal): Preparation {
    let resolve!: Preparation['resolve'], reject!: Preparation['reject'];
    const result = new Promise<MobilePlaybackControlReply>((yes, no) => { resolve = yes; reject = no; });
    const task: Preparation = { resourceId, receiptId, controller: new AbortController(), reply: result, resolve, reject, finished: Promise.resolve(), delivered: false };
    preparations.set(resourceId, task); task.finished = prepareResource(task, p); void task.finished.catch(() => { fatal = true; });
    return task;
  }
  async function handleControl(operation: MobilePlaybackControlOperation, request: MobileDecodedRequest<unknown>, p: MobilePrincipal, dsd=false): Promise<
    { value: MobilePlaybackControlReply } | { wait: Promise<MobilePlaybackControlReply> }> {
    await loaded(); await deviceCurrent(p.deviceId, p.deviceEpoch); await expire();
    if (['createSession', 'createResource', 'renewResource'].includes(operation)) {
      const prior = await findReceipt(receiptIdentity(operation as StoredPlaybackReceipt['operation'], request, p), p);
      if (prior) {
        if (prior.state === 'RECORDED') return { value: original(prior, p) };
        const task = prior.resourceId ? preparations.get(prior.resourceId) : undefined;
        if (task && task.receiptId === prior.id) return { wait: task.reply };
        return playbackFailure(503, 'RESOURCE_BUSY');
      }
    }
    await compactHistory();
    if (operation === 'createSession') {
      room();
      const live = state!.sessions.filter(v => !v.terminal && v.expiresAt > now());
      if (state!.sessions.length >= limits.maxStoredSessions || live.length >= limits.maxLiveSessions
        || live.filter(v => v.deviceId === p.deviceId).length >= limits.maxSessionsPerDevice) return playbackFailure(429, 'RESOURCE_BUSY');
      const body = mobileResourceCommandSnapshot('sessionRequest', request.body); if (!body.ok) return playbackFailure(400, 'INVALID_REQUEST');
      const candidate = stateBase ? {...state!,sessions:[...state!.sessions],receipts:[...state!.receipts]} : playbackCopy(state!), at = now(), s: StoredPlaybackSession = { id: randomUUID(), deviceId: p.deviceId,
        deviceEpoch: p.deviceEpoch, clientInstanceId: body.value.clientInstanceId, createdAt: at, expiresAt: at + limits.sessionTtlMs,
        terminal: null, lastSequence: 0, playerGeneration: null, currentQueueItemId: null, currentResourceId: null, observation: null };
      candidate.sessions.push(s); const receipt = addReceipt(candidate, operation, request, p, s.id, null);
      receipt.state = 'RECORDED'; receipt.reply = { status: 201, body: sessionBody(s) }; await mobilePreparationAsync('preparation.playback.session-save', () => save(candidate,{kind:'createSession',sessionId:s.id,receiptId:receipt.id}));
      return { value: original(state!.receipts.find(v => v.id === receipt.id)!, p) };
    }
    const s = await session(request.pathParameters.sessionId, p);
    if (operation === 'closeSession') {
      if (!s.terminal) { const candidate = playbackCopy(state!); candidate.sessions.find(v => v.id === s.id)!.terminal = 'SESSION_CLOSED';
        markTerminal(candidate, candidate.resources.filter(v => v.sessionId === s.id).map(v => v.id), 'SESSION_CLOSED'); await save(candidate); }
      const ids = state!.resources.filter(v => v.sessionId === s.id).map(v => v.id);
      return { wait: Promise.all(ids.map(v => releaseRuntime(v))).then(() => reply(204, null, p)) };
    }
    if (operation === 'releaseResource') {
      const r = await resource(request.pathParameters.resourceId, s);
      if (r.state !== 'terminal') { const candidate = playbackCopy(state!); markTerminal(candidate, [r.id], 'RESOURCE_RELEASED'); await save(candidate); }
      return { wait: releaseRuntime(r.id).then(() => reply(204, null, p)) };
    }
    liveSession(s);
    if (operation === 'getSession') return { value: reply(200, sessionBody(s), p) };
    if (operation === 'createResource') {
      if((request.body as MobileResourceRequest).acceptedProcessingModes?.length && !dsd)throw codeError('UNSUPPORTED_FORMAT');
      room();
      const live = state!.resources.filter(v => ['preparing', 'ready'].includes(v.state));
      if (state!.resources.length >= limits.maxStoredResources) return mobileResourceCapacityFailure('capacity.actor.stored-resources-full', () => playbackFailure(429, 'RESOURCE_BUSY'));
      if (live.length >= limits.maxLiveResources) return mobileResourceCapacityFailure('capacity.actor.live-resources-full', () => playbackFailure(429, 'RESOURCE_BUSY'));
      if (new Set([...runtimes.keys(), ...preparations.keys(), ...sourceFlights.keys()]).size >= limits.maxLiveResources) return mobileResourceCapacityFailure('capacity.actor.live-flights-full', () => playbackFailure(429, 'RESOURCE_BUSY'));
      const candidate = resourceCandidate(), at = now(), resourceId = randomUUID();
      const body = request.body as MobileResourceRequest;
      const r: StoredPlaybackResource = { id: resourceId, sessionId: s.id, deviceId: p.deviceId, deviceEpoch: p.deviceEpoch,
        request: playbackCopy(body), createdAt: at, expiresAt: Math.min(at + limits.resourceTtlMs, s.expiresAt),
        hardExpiresAt: Math.min(at + limits.maximumResourceLifetimeMs, s.expiresAt), lastActivityAt: at,
        state: 'preparing', failure: null, source: null, media: null, runtimeEpoch, tickets: [],resourceDsdToPcm:dsd };
      candidate.resources.push(r); const receipt = addReceipt(candidate, operation, request, p, s.id, resourceId); await save(candidate,{kind:'createResource',resourceId,receiptId:receipt.id});
      const task = startPreparation(resourceId, receipt.id, p); return { wait: task.reply };
    }
    if (operation === 'reportObservation') {
      const checked = mobileResourceCommandSnapshot('observation', request.body); if (!checked.ok) return playbackFailure(400, 'INVALID_REQUEST');
      const observation: MobileObservation = checked.value, r = await resource(observation.resourceId, s); liveResource(r);
      if (r.request.trackId !== observation.trackId) return playbackFailure(404, 'INVALID_REQUEST');
      const stale = observation.sequence <= s.lastSequence || s.playerGeneration !== null && observation.playerGeneration < s.playerGeneration
        || observation.playerGeneration === s.playerGeneration && (observation.resourceId !== s.currentResourceId || observation.queueItemId !== s.currentQueueItemId)
        || s.observation !== null && ['ended', 'failed'].includes(s.observation.state) && observation.playerGeneration === s.playerGeneration;
      if (stale) return { value: reply(200, { acceptedSequence: Math.max(1, s.lastSequence), accepted: false }, p) };
      if (r.state !== 'ready') return playbackFailure(429, 'RESOURCE_BUSY');
      const candidate = playbackCopy(state!), current = candidate.sessions.find(v => v.id === s.id)!;
      current.lastSequence = observation.sequence; current.playerGeneration = observation.playerGeneration;
      current.currentQueueItemId = observation.queueItemId; current.currentResourceId = observation.resourceId; current.observation = playbackCopy(observation);
      candidate.resources.find(v => v.id === r.id)!.lastActivityAt = now(); await save(candidate);
      const runtime = runtimes.get(r.id); if (runtime) runtime.lastActivityAt = now();
      return { value: reply(200, { acceptedSequence: observation.sequence, accepted: true }, p) };
    }
    const r = await resource(request.pathParameters.resourceId, s);
    liveResource(r);
    if (operation === 'getResource') {
      const runtime = runtimes.get(r.id);
      if (r.state === 'ready' && !runtime) throw codeError('SERVICE_RESTARTED');
      if (r.state === 'ready' && runtime) { await checkRuntime(r, runtime); await sourcePort.verify(runtime.source.handle); await checkRuntime(r, runtime); }
      const current = resourceBody(r);
      const body: MobileResource = current.state === 'ready' && Date.parse(current.media.expiresAt) <= now()
        ? { id: current.id, sessionId: current.sessionId, trackId: current.trackId, versionId: current.versionId,
          contentRevision: current.contentRevision, sourceAudio: current.sourceAudio, processing: current.processing,
          state: 'failed', failure: failureBody(codeError('TICKET_EXPIRED')) } : current;
      return { value: reply(200, body, p, r.source ? playbackResourceContext(serverId, responseOrigin, s, r, now()) : undefined) };
    }
    room(); if (r.state !== 'ready') return playbackFailure(429, 'RESOURCE_BUSY');
    const runtime = runtimes.get(r.id); if (!runtime) throw codeError('SERVICE_RESTARTED');
    await checkRuntime(r, runtime);
    if(runtime.source.processing.mode==='dsd_to_pcm' && sourcePort.status){
      const observed=capturePrepared(await deadline(sourcePort.status(runtime.source.handle,runtime.controller.signal),limits.prepareTimeoutMs,codeError('RESOURCE_BUSY')));
      if('preparing' in observed){
        // ready-only renew 不受240秒限制；意外 preparing 永远不获第二个窗口。
        if(now()>=preparationDeadline(r,s)-10_000){const candidate=playbackCopy(state!);markTerminal(candidate,[r.id],'RESOURCE_EXPIRED');await save(candidate);
          await releaseRuntime(r.id);throw codeError('RESOURCE_EXPIRED');}
        throw codeError('RESOURCE_BUSY');
      }
      if(observed.handle!==runtime.source.handle || playbackCanonical(observed.sourceAudio)!==playbackCanonical(runtime.source.sourceAudio)
        || playbackCanonical(observed.actualAudio)!==playbackCanonical(runtime.source.actualAudio) || observed.durationMs!==runtime.source.durationMs
        || observed.seekable!==runtime.source.seekable || observed.size!==runtime.source.size || observed.processing.mode!==runtime.source.processing.mode
        || observed.processing.reason!==runtime.source.processing.reason)throw codeError('SOURCE_CHANGED');
    }
    await sourcePort.verify(runtime.source.handle);await sourcePort.renew(runtime.source.handle);await checkRuntime(r,runtime);
    const candidate = playbackCopy(state!), current = candidate.resources.find(v => v.id === r.id)!;
    current.expiresAt = Math.min(now() + limits.resourceTtlMs, current.hardExpiresAt, s.expiresAt); current.lastActivityAt = now();
    installTicket(current); const receipt = addReceipt(candidate, 'renewResource', request, p, s.id, r.id);
    receipt.state = 'RECORDED'; receipt.reply = { status: 200, body: resourceBody(current) };
    receipt.resourceContext = playbackResourceContext(serverId, responseOrigin, s, current, now()); await save(candidate); runtime.lastActivityAt = now();
    return { value: original(state!.receipts.find(v => v.id === receipt.id)!, p) };
  }
  function mediaTicket(r: StoredPlaybackResource, token: string): { expiresAt: number; runtimeEpoch: string } {
    const found = r.tickets.find(v => equalHash(v.hash, hash(token)));
    if (!found) return playbackFailure(401, 'TICKET_INVALID');
    if (found.runtimeEpoch !== runtimeEpoch || r.runtimeEpoch !== runtimeEpoch) throw codeError('SERVICE_RESTARTED');
    const pieces = token.split('.');
    if (pieces.length !== 3 || pieces[0] !== 'v1') return playbackFailure(401, 'TICKET_INVALID');
    const expected = createHmac('sha256', signingKey).update(playbackCanonical([serverId, datasetId, r.deviceId, r.deviceEpoch, r.sessionId, ASSET, pieces[1]!])).digest('base64url');
    if (!equalHash(hash(expected), hash(pieces[2]!))) return playbackFailure(401, 'TICKET_INVALID'); return found;
  }
  /** 终止请求在入原作者队列前占住对应scope；不提前改变其持久化结果。 */
  function holdTerminalMedia(operation: MobilePlaybackControlOperation, request: MobileDecodedRequest<unknown>, p: MobilePrincipal): () => void {
    if (operation !== 'closeSession' && operation !== 'releaseResource') return () => undefined;
    const s = state?.sessions.find(v => v.id === request.pathParameters.sessionId && v.deviceId === p.deviceId && v.deviceEpoch === p.deviceEpoch);
    if (!s) return () => undefined;
    const r = operation === 'releaseResource' ? state?.resources.find(v => v.id === request.pathParameters.resourceId && v.sessionId === s.id) : undefined;
    if (operation === 'releaseResource' && !r) return () => undefined;
    // scope在preparing期间也存在；不能把将来finalize的ready资源漏在枚举之外。
    const key = operation === 'closeSession' ? `session:${s.id}` : `resource:${r!.id}`;
    let entry = terminalMedia.get(key);
    if (!entry) {
      let resolve!: () => void;
      entry = { count: 0, settled: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
      terminalMedia.set(key, entry);
    }
    if (!Number.isSafeInteger(entry.count) || entry.count === Number.MAX_SAFE_INTEGER) throw codeError('RESOURCE_BUSY');
    const held = entry; held.count++;
    return () => { if (--held.count === 0) { if (terminalMedia.get(key) === held) terminalMedia.delete(key); held.resolve(); } };
  }
  function mediaTerminalScopes(r: StoredPlaybackResource): Promise<void>[] {
    return [terminalMedia.get(`session:${r.sessionId}`)?.settled, terminalMedia.get(`resource:${r.id}`)?.settled]
      .filter((value): value is Promise<void> => value !== undefined);
  }
  /** 只读原ACK发布的state；candidate、冷恢复及UNKNOWN从不授予媒体资格。 */
  function publishedMedia(request: MobileDecodedRequest<unknown>, signal: AbortSignal, previous?: MediaBinding, waiting = false): MediaBinding {
    open(); signal.throwIfAborted();
    if (!mediaInitialized || !state || pending) return playbackFailure(503, 'BUSY');
    if (previous?.resourceSignal.aborted) throw codeError('RESOURCE_REVOKED');
    const r = state.resources.find(v => v.id === request.pathParameters.resourceId);
    if (!r || request.pathParameters.asset !== ASSET || typeof request.query.ticket !== 'string') return playbackFailure(401, 'TICKET_INVALID');
    const ticket = mediaTicket(r, request.query.ticket), s = state.sessions.find(v => v.id === r.sessionId);
    if (!s) return playbackFailure(401, 'TICKET_INVALID'); liveSession(s); liveResource(r);
    if (now() >= ticket.expiresAt) throw codeError('TICKET_EXPIRED');
    const runtime = runtimes.get(r.id);
    if (!runtime || r.state !== 'ready' || !playbackReadyFacts(r.source) || runtime.releasing || runtime.controller.signal.aborted) throw codeError('RESOURCE_REVOKED');
    if (now() >= runtime.lastActivityAt + limits.orphanResourceMs) throw codeError('RESOURCE_EXPIRED');
    if (!waiting && mediaTerminalScopes(r).length) throw codeError('RESOURCE_REVOKED');
    if (previous && (previous.runtime !== runtime || previous.resourceSignal !== runtime.controller.signal
      || previous.r.sessionId !== r.sessionId || previous.r.deviceId !== r.deviceId || previous.r.deviceEpoch !== r.deviceEpoch
      || previous.ticket.expiresAt !== ticket.expiresAt || previous.ticket.runtimeEpoch !== ticket.runtimeEpoch
      || playbackCanonical(previous.r.source) !== playbackCanonical(r.source))) throw codeError('RESOURCE_REVOKED');
    return { r, runtime, resourceSignal: previous?.resourceSignal ?? runtime.controller.signal, ticket };
  }
  function waitMediaOpen<T>(entry: MediaOpen, start: () => Promise<T>, remaining: number): Promise<T> {
    if (remaining <= 0) return Promise.reject(codeError('RESOURCE_BUSY'));
    entry.controller.signal.throwIfAborted();
    const work = start(); entry.work.add(work); void work.then(() => entry.work.delete(work), () => entry.work.delete(work));
    const bounded = deadline(work, remaining, codeError('RESOURCE_BUSY'));
    return new Promise<T>((resolve, reject) => {
      const aborted = () => { entry.controller.signal.removeEventListener('abort', aborted); reject(codeError('RESOURCE_REVOKED')); };
      entry.controller.signal.addEventListener('abort', aborted, { once: true });
      void bounded.then(value => { entry.controller.signal.removeEventListener('abort', aborted); resolve(value); }, error => {
        entry.controller.signal.removeEventListener('abort', aborted); reject(error);
      });
      if (entry.controller.signal.aborted) aborted();
    });
  }
  async function mediaBoundary(entry: MediaOpen, request: MobileDecodedRequest<unknown>, signal: AbortSignal, binding: MediaBinding, end: number): Promise<void> {
    for (;;) {
      captureMobileMediaReadBudget()?.assertCurrent();
      publishedMedia(request, signal, binding, true); entry.controller.signal.throwIfAborted();
      const blockers = [publication?.settled, ...mediaTerminalScopes(binding.r)].filter((v): v is Promise<void> => v !== undefined);
      if (!blockers.length) return;
      await waitMediaOpen(entry, () => Promise.all(blockers), end - performance.now());
    }
  }
  function reservedMedia(resourceId?: string): number {
    let count = 0; for (const entry of mediaOpens) if (entry.reserved && (resourceId === undefined || entry.resourceId === resourceId)) count++; return count;
  }
  function beginMediaOpen<T>(binding: MediaBinding, signal: AbortSignal, reserveReader: boolean, work: (entry: MediaOpen) => Promise<T>): Promise<T> {
    const readers = [...runtimes.values()].reduce((n, value) => n + value.readers.size, 0);
    if (mediaOpens.size >= limits.maxReads || reserveReader && (readers + reservedMedia() >= limits.maxReads
      || binding.runtime.readers.size + reservedMedia(binding.r.id) >= limits.maxReadsPerResource)) throw codeError('RESOURCE_BUSY');
    let resolveQuiet!: () => void;
    const entry: MediaOpen = { resourceId: binding.r.id, reserved: reserveReader, controller: new AbortController(),
      quiet: new Promise<void>(resolve => { resolveQuiet = resolve; }), resolveQuiet: () => resolveQuiet(), work: new Set() };
    const abort = () => entry.controller.abort();
    signal.addEventListener('abort', abort, { once: true }); binding.resourceSignal.addEventListener('abort', abort, { once: true });
    mediaOpens.add(entry); if (signal.aborted || binding.resourceSignal.aborted) abort();
    const actual = Promise.resolve().then(() => work(entry));
    const finish = () => {
      signal.removeEventListener('abort', abort); binding.resourceSignal.removeEventListener('abort', abort);
      // HTTP等待超时也不释放仍在Owner校验中的准入槽；close须等这条原Promise实际静止。
      const quiet = Promise.allSettled([...entry.work]);
      void quiet.then(() => { mediaOpens.delete(entry); entry.reserved = false; entry.resolveQuiet(); });
    };
    void actual.then(finish, finish); return actual;
  }
  const readerAuthorities = new WeakMap<MobilePlaybackReader, (work: () => Promise<void>) => Promise<void>>();
  async function createReader(r: StoredPlaybackResource, runtime: RuntimeResource, start: number, end: number,
    expiresAt: number, signal: AbortSignal): Promise<MobilePlaybackReader> {
    const total = [...runtimes.values()].reduce((n, v) => n + v.readers.size, 0);
    if (total + reservedMedia() >= limits.maxReads || runtime.readers.size + reservedMedia(r.id) >= limits.maxReadsPerResource) throw codeError('RESOURCE_BUSY');
    const readId = randomUUID(), controller = new AbortController(), resourceSignal = runtime.controller.signal,
      mediaBudget = captureMobileMediaReadBudget();
    let offset = start, inFlight: Promise<Uint8Array> | undefined, sourceReadFlight: Promise<Uint8Array> | undefined,
      authorityFlight: Promise<void> | undefined, closeReadFlight: Promise<void> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined, ticketTimer: ReturnType<typeof setTimeout> | undefined, iterated = false;
    const abort = (): void => { controller.abort(); void closeRead().catch(() => { fatal = true; }); };
    const pauseIdle = (): void => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
    const armIdle = (): void => { pauseIdle(); if (controller.signal.aborted || inFlight || authorityFlight) return;
      idleTimer = setTimeout(abort, limits.mediaIdleMs); idleTimer.unref(); };
    signal.addEventListener('abort', abort, { once: true }); resourceSignal.addEventListener('abort', abort, { once: true });
    ticketTimer = setTimeout(abort, Math.max(0, expiresAt - now())); ticketTimer.unref(); armIdle();
    async function closeRead(): Promise<void> {
      controller.abort(); if (idleTimer) clearTimeout(idleTimer); if (ticketTimer) clearTimeout(ticketTimer);
      signal.removeEventListener('abort', abort); resourceSignal.removeEventListener('abort', abort);
      if (closeReadFlight) return mobileRangeWindowObserve('reader.close.wait', () => deadline(closeReadFlight!, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY')), 'cleanup');
      const actual = mobileRangeWindowObserve('reader.close', async () => {
        // 先关闭原 readId 的 Owner 能力；超时包装结束并不等于原 I/O 已静止。
        const quiet = sourcePort.closeRead(runtime.source.handle, readId);
        await Promise.all([quiet, sourceReadFlight?.catch(() => undefined), inFlight?.catch(() => undefined), authorityFlight?.catch(() => undefined)]);
        runtime.readers.delete(readId); readerAuthorities.delete(reader);
      }, 'cleanup');
      closeReadFlight = actual; return mobileRangeWindowObserve('reader.close.wait', () => deadline(actual, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY')), 'cleanup');
    }
    const reader: MobilePlaybackReader = {
      readId,
      async read(maxBytes = CHUNK_BYTES) {
        if (!playbackInteger(maxBytes, 1, CHUNK_BYTES)) return playbackFailure(400, 'INVALID_REQUEST');
        if (controller.signal.aborted || signal.aborted || resourceSignal.aborted) return playbackFailure(401, 'TICKET_REVOKED');
        mediaBudget?.assertCurrent();
        if (now() >= expiresAt) { abort(); throw codeError('TICKET_EXPIRED'); }
        if (inFlight || authorityFlight) throw codeError('RESOURCE_BUSY');
        if (offset > end) { await closeRead(); return new Uint8Array(); }
        const count = Math.min(maxBytes, end - offset + 1), currentOffset = offset;
        if (mediaBudget) pauseIdle(); else armIdle();
        const operation = (async () => {
          if(!readComposition){await mobileRangeWindowObserve('read.authority.before', () => checkRuntime(r, runtime));controller.signal.throwIfAborted();}
          const sourceRead = mobileRangeWindowObserve('source.read.composite', () => readComposition?(async()=>{
            let phase=0,active=true,invalid=false;const boundaryWork:Promise<void>[]=[];
            const boundary=(expected:number,next:number,stage:'read.authority.before'|'read.authority.after'):Promise<void>=>{
              const work=(async()=>{if(!active||phase!==expected){invalid=true;throw codeError('RESOURCE_BUSY');}phase=expected+1;
                controller.signal.throwIfAborted();signal.throwIfAborted();resourceSignal.throwIfAborted();
                await mobileRangeWindowObserve(stage,()=>checkRuntime(r,runtime));
                controller.signal.throwIfAborted();signal.throwIfAborted();resourceSignal.throwIfAborted();
                if(now()>=expiresAt)throw codeError('TICKET_EXPIRED');phase=next;})();
              boundaryWork.push(work);void work.catch(()=>{invalid=true;});return work;
            };
            let raw:Uint8Array|undefined,failed=false,failure:unknown;
            try{raw=await readComposition(Object.freeze({serverId,datasetId,deviceId:r.deviceId,deviceEpoch:r.deviceEpoch,
              handle:runtime.source.handle,readId,start:currentOffset,maxBytes:count,signal:controller.signal}),Object.freeze({
                before:()=>boundary(0,2,'read.authority.before'),after:()=>boundary(2,4,'read.authority.after')}));}
            catch(error){failed=true;failure=error;}
            finally{active=false;await Promise.allSettled(boundaryWork);}
            // 未await的边界工作也必须真实静止；漏调/乱序不能借品牌成为成功字节。
            if(failed)throw failure;if(invalid||phase!==4)throw codeError('RESOURCE_BUSY');return raw!;
          })():sourcePort.read(runtime.source.handle, readId, currentOffset, count, controller.signal));
          sourceReadFlight = sourceRead;
          void sourceRead.then(() => { if (sourceReadFlight === sourceRead) sourceReadFlight = undefined; },
            () => { if (sourceReadFlight === sourceRead) sourceReadFlight = undefined; });
          const raw = await deadline(sourceRead, mediaBudget && readComposition ? mediaBudget.remainingMs() : limits.mediaIdleMs,
            codeError('RESOURCE_BUSY'), () => controller.abort());
          const chunk = bytes(raw, count);if(!readComposition)await mobileRangeWindowObserve('read.authority.after', () => checkRuntime(r, runtime));
          controller.signal.throwIfAborted(); signal.throwIfAborted(); resourceSignal.throwIfAborted();
          mediaBudget?.assertCurrent();
          if (now() >= expiresAt) throw codeError('TICKET_EXPIRED');
          offset += chunk.byteLength; runtime.lastActivityAt = now(); armIdle(); return chunk;
        })();
        inFlight = operation;
        try { return await operation; } catch (error) { controller.abort(); throw safeError(error); }
        finally { inFlight = undefined; if (controller.signal.aborted) void closeRead().catch(() => { fatal = true; }); else armIdle(); }
      },
      close: closeRead,
      async *[Symbol.asyncIterator]() {
        if (iterated) return playbackFailure(400, 'INVALID_REQUEST'); iterated = true;
        try { while (offset <= end) yield await reader.read(); } finally { await reader.close(); }
      },
    };
    readerAuthorities.set(reader, async work => {
      controller.signal.throwIfAborted(); signal.throwIfAborted(); resourceSignal.throwIfAborted();
      mediaBudget?.assertCurrent();
      if (inFlight || authorityFlight) throw codeError('RESOURCE_BUSY');
      pauseIdle();
      const actual = (async () => {
        await work();
        controller.signal.throwIfAborted(); signal.throwIfAborted(); resourceSignal.throwIfAborted();
        mediaBudget?.assertCurrent();
        if (now() >= expiresAt) throw codeError('TICKET_EXPIRED');
      })();
      authorityFlight = actual;
      try { await actual; }
      finally {
        if (authorityFlight === actual) authorityFlight = undefined;
        if (controller.signal.aborted) void closeRead().catch(() => { fatal = true; }); else armIdle();
      }
    });
    runtime.readers.set(readId, reader); if (signal.aborted || resourceSignal.aborted) abort(); return reader;
  }
  async function mediaReply(operation: MobilePlaybackMediaOperation, request: MobileDecodedRequest<unknown>, signal: AbortSignal,
    headers: Readonly<{ range?: string; ifRange?: string }>, captured: MediaBinding, entry?: MediaOpen, end = 0): Promise<MobilePlaybackMediaReply> {
    let binding = captured;
    if (entry) {
      // 只等当前真实发布及该scope的终止请求；不排尚在编码或尚未执行的无关控制。
      do {
        await mediaBoundary(entry, request, signal, binding, end);
        binding = publishedMedia(request, signal, binding);
      } while (publication);
    }
    const { r, runtime, ticket, resourceSignal } = binding, source = r.source!;
    if (!playbackReadyFacts(source)) throw codeError('RESOURCE_REVOKED');
    const selection = operation === 'headMediaAsset' ? { status: 200, start: 0, end: source.size - 1 } as const
      : selectLocalBytes(headers.range, headers.ifRange, source.size);
    const selected = 'start' in selection;
    const responseHeaders: [string, string][] = [['Cache-Control', 'no-store'], ['Accept-Ranges', 'bytes'],
      ['Content-Length', selected ? String(selection.end - selection.start + 1) : '0']];
    if (selected) responseHeaders.push(['Content-Type', source.contentType]);
    if (selection.status === 206 && selected) responseHeaders.push(['Content-Range', `bytes ${selection.start}-${selection.end}/${source.size}`]);
    if (selection.status === 416) responseHeaders.push(['Content-Range', `bytes */${source.size}`]);
    // 同步把预留槽交给原reader；其间不yield，也不扩大总数或每资源上限。
    if (entry) entry.reserved = false;
    const reader = selected && operation === 'getMediaAsset' ? await createReader(r, runtime, selection.start, selection.end, ticket.expiresAt, signal) : null;
    try { if (entry) publishedMedia(request, signal, binding); }
    catch (error) { await reader?.close(); throw error; }
    return { status: selection.status, headers: responseHeaders, totalBytes: source.size,
      start: selected ? selection.start : null, end: selected ? selection.end : null,
      ticketExpiresAtMs: ticket.expiresAt, resourceAbortSignal: resourceSignal, reader,
      async beforeSend() {
        signal.throwIfAborted(); open();
        const authorize = async () => {
          signal.throwIfAborted(); if (entry) publishedMedia(request, signal, binding);
          await checkRuntime(r, runtime);
          if (entry) publishedMedia(request, signal, binding);
          if (now() >= ticket.expiresAt) throw codeError('TICKET_EXPIRED');
        };
        if (!reader) return authorize();
        const tracked = readerAuthorities.get(reader); if (!tracked) throw codeError('RESOURCE_REVOKED');
        await tracked(authorize);
      },
      async close() { await reader?.close(); } };
  }
  const service: MobilePlaybackService = {
    initialize() {
      if(!initialization)initialization=enqueue(async()=>{open();await loaded();});
      return initialization;
    },
    async control(operation, raw, rawPrincipal, signal) {
      if (!MOBILE002_CONTROL_OPERATIONS.includes(operation)) return playbackFailure(400, 'INVALID_REQUEST');
      signal.throwIfAborted(); const p=principal(rawPrincipal);
      let dsd=false;
      if(operation==='createResource'&&sourcePort.capabilities){const capabilities=await deadline(sourcePort.capabilities(),limits.prepareTimeoutMs,codeError('RESOURCE_BUSY'));
        if(!playbackClosed(capabilities,['resourceDsdToPcm'])||typeof capabilities.resourceDsdToPcm!=='boolean')throw codeError('SOURCE_CHANGED');dsd=capabilities.resourceDsdToPcm;}
      // 仅解析旧原正文以查 immutable 回执；新intent的能力仍在 handleControl 以真实Owner dsd值核验。
      const declares=raw.body!==null&&typeof raw.body==='object'&&Object.hasOwn(raw.body,'acceptedProcessingModes');
      const request=capturedRequest(operation,raw,p,dsd||declares);
      const releaseMedia = holdTerminalMedia(operation, request, p);
      try {
        const result=await enqueue(()=>handleControl(operation,request,p,dsd),operation);
        const value = 'wait' in result ? await result.wait : result.value; signal.throwIfAborted(); return value;
      } finally { releaseMedia(); }
    },
    async openMedia(operation, raw, signal, headers = {}) {
      if (!['getMediaAsset', 'headMediaAsset'].includes(operation) || !playbackClosed(headers, Object.keys(headers))
        || Object.keys(headers).some(k => !['range', 'ifRange'].includes(k))
        || headers.range !== undefined && typeof headers.range !== 'string' || headers.ifRange !== undefined && typeof headers.ifRange !== 'string') return playbackFailure(400, 'INVALID_REQUEST');
      signal.throwIfAborted(); const request = capturedRequest(operation, raw);
      if (mediaInitialized && state && !pending && state.resources.some(row => row.id === request.pathParameters.resourceId)) {
        const binding = publishedMedia(request, signal, undefined, true);
        const reserveReader = operation === 'getMediaAsset' && 'start' in selectLocalBytes(headers.range, headers.ifRange, binding.runtime.source.size);
        return mobileRangeWindowObserve('main.open.task', () => beginMediaOpen(binding, signal, reserveReader, async entry => {
          const budget = captureMobileMediaReadBudget(); budget?.assertCurrent();
          const end = budget?.deadlineAtMs ?? performance.now() + limits.mediaEstablishmentMs;
          await mediaBoundary(entry, request, signal, binding, end); publishedMedia(request, signal, binding, true);
          await waitMediaOpen(entry, () => deviceCurrent(binding.r.deviceId, binding.r.deviceEpoch), end - performance.now());
          publishedMedia(request, signal, binding, true);
          await mediaBoundary(entry, request, signal, binding, end); publishedMedia(request, signal, binding, true);
          await waitMediaOpen(entry, () => sourcePort.verify(binding.runtime.source.handle), end - performance.now());
          publishedMedia(request, signal, binding, true);
          await mediaBoundary(entry, request, signal, binding, end); publishedMedia(request, signal, binding, true);
          await waitMediaOpen(entry, () => checkRuntime(binding.r, binding.runtime), end - performance.now());
          publishedMedia(request, signal, binding, true);
          return mediaReply(operation, request, signal, headers, binding, entry, end);
        }), 'business', operation);
      }
      const captured = await mobileRangeWindowObserve('main.open.task', () => enqueue(async () => {
        await loaded(); await expire();
        let r = state!.resources.find(v => v.id === request.pathParameters.resourceId);
        let s = r ? state!.sessions.find(v => v.id === r!.sessionId) : undefined;
        if (!r && history) {
          const archived = await history.lookup('resource', { id: request.pathParameters.resourceId });
          r = archived?.group.resources.find(row => row.id === archived.locator.recordId);
          s = archived?.group.sessions[0];
        }
        if (!r || request.pathParameters.asset !== ASSET || typeof request.query.ticket !== 'string') return playbackFailure(401, 'TICKET_INVALID');
        const ticket = mediaTicket(r, request.query.ticket); await deviceCurrent(r.deviceId, r.deviceEpoch);
        if (!s) return playbackFailure(401, 'TICKET_INVALID'); liveSession(s); liveResource(r);
        if (now() >= ticket.expiresAt) throw codeError('TICKET_EXPIRED');
        const runtime = runtimes.get(r.id); if (!runtime || r.state !== 'ready' || !r.source) throw codeError('RESOURCE_REVOKED');
        await deadline(sourcePort.verify(runtime.source.handle), captureMobileMediaReadBudget()?.remainingMs() ?? limits.mediaEstablishmentMs, codeError('RESOURCE_BUSY'));
        await checkRuntime(r, runtime); signal.throwIfAborted();
        if (now() >= ticket.expiresAt) throw codeError('TICKET_EXPIRED');
        return { r, runtime, ticket, resourceSignal: runtime.controller.signal };
      }, operation), 'business', operation);
      return mediaReply(operation, request, signal, headers, captured);
    },
    async revokeDevice(deviceId) {
      if (!id(deviceId)) return playbackFailure(400, 'INVALID_REQUEST');
      codecFence++;
      for (const r of state?.resources ?? []) if (r.deviceId === deviceId) { preparations.get(r.id)?.controller.abort(); runtimes.get(r.id)?.controller.abort(); }
      const ids = await enqueue(async () => {
        await loaded(); const candidate = playbackCopy(state!);
        for (const s of candidate.sessions) if (s.deviceId === deviceId && !s.terminal) s.terminal = 'DEVICE_REVOKED';
        const ids = candidate.resources.filter(v => v.deviceId === deviceId).map(v => v.id); markTerminal(candidate, ids, 'DEVICE_REVOKED');
        await save(candidate); return ids;
      });
      await Promise.all(ids.map(v => releaseRuntime(v)));
    },
    close() {
      if (closeFlight) return closeFlight;
      closing = true; codecFence++; if (sweepTimer) clearInterval(sweepTimer); for (const task of preparations.values()) task.controller.abort(); pauseReaders();
      for (const entry of mediaOpens) entry.controller.abort();
      closeFlight = (async () => {
        let failed = false, first: unknown = undefined;
        const failures: MobilePlaybackCloseFailure[] = [];
        const remember = (stage: MobilePlaybackCloseFailure['stage'], error: unknown): void => {
          if (!failed) { failed = true; first = error; }
          let facts: MobilePlaybackCloseFailure = { stage, status: 503, code: 'BUSY' };
          try {
            const safe = safeError(error);
            if (Object.hasOwn(messages, safe.code) && [400, 401, 403, 404, 409, 410, 429, 503].includes(safe.status)) facts = { stage, status: safe.status, code: safe.code };
          } catch { /* 错误快照自身失败不覆盖实际首因。 */ }
          failures.push(facts); closeFailures.set(service, failures);
        };
        try {
          await deadline(tail, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
          await deadline(Promise.all([...mediaOpens].map(entry => entry.quiet)), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
          await deadline(Promise.all([...preparations.values()].map(v => v.finished)), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
          await Promise.all([...runtimes.keys()].map(v => releaseRuntime(v)));
          await deadline(Promise.all([...unresolvedPreparations]), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
          await deadline(Promise.all([...sourceFlights.values()].map(v => v.lateRelease ?? v.raw.then(() => undefined))), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
          await deadline(Promise.all([...background]), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
          if (runtimes.size || unresolvedPreparations.size || sourceFlights.size) throw codeError('RESOURCE_BUSY'); signingKey.fill(0);
        } catch (error) { remember('drain', error); }
        try { await options.stateCodec?.close(); } catch (error) { remember('codec-close', error); }
        if (failed) throw first;
      })(); return closeFlight;
    },
    resourceSnapshot() {
      const at = now(); return { liveSessions: closing || fatal ? 0 : state?.sessions.filter(v => !v.terminal && v.expiresAt > at).length ?? 0,
        liveResources: runtimes.size, preparing: Math.max(preparations.size, unresolvedPreparations.size),
        readers: [...runtimes.values()].reduce((n, v) => n + v.readers.size, 0),
        releasing: [...runtimes.values()].filter(v => v.releasing).length + [...sourceFlights.values()].filter(v => v.lateRelease !== undefined).length,
        receipts: state?.receipts.length ?? 0,
        pendingPersistence: pending !== undefined, closing };
    },
  };
  return service;
}
