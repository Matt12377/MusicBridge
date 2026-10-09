import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  MOBILE_OPERATION_TABLE, decodeMobileRequest, encodeMobileRequest, mobileDataSnapshot,
  mobileResourceCommandSnapshot, validateMobileReadyAudio,
  type MobileDecodedRequest, type MobileErrorEnvelope, type MobileJsonValue, type MobileObservation,
  type MobileProcessing, type MobileRequestMap, type MobileResource, type MobileResourceRequest,
  type MobileResourceSemanticContext, type MobileSession,
} from '@music-bridge/contracts';
import { selectLocalBytes } from '../stream/local-file-http.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobilePrincipal, type MobileSealedState } from './types.js';
import {
  MOBILE002_CONTROL_OPERATIONS, MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError,
  type MobilePlaybackControlOperation, type MobilePlaybackControlReply, type MobilePlaybackErrorCode,
  type MobilePlaybackLimits, type MobilePlaybackMediaOperation, type MobilePlaybackMediaReply,
  type MobilePlaybackPreparedSource, type MobilePlaybackReader, type MobilePlaybackService, type MobilePlaybackServiceOptions,
} from './playback-types.js';
import {
  PLAYBACK_STATE_SCHEMA, capturePlaybackSource, capturePlaybackState, decodePlaybackState, playbackCanonical,
  playbackClosed, playbackCopy, playbackFailure, playbackInteger, playbackResourceContext,
  type PlaybackSourceFacts, type PlaybackState, type StoredPlaybackReceipt,
  type StoredPlaybackResource, type StoredPlaybackSession,
} from './playback-state.js';

const CHUNK_BYTES = 64 * 1024, ASSET = 'source';
const DATE_MAX = 8_640_000_000_000_000;
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
  if (error instanceof MobilePlaybackError) return error;
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
  const { serverId, datasetId, responseOrigin, auth, persistence, crypto, sourcePort } = options;
  if (!id(serverId) || !id(datasetId)) return playbackFailure(400, 'INVALID_REQUEST');
  try { const origin = new URL(responseOrigin); if (origin.protocol !== 'https:' || origin.origin !== responseOrigin || origin.username || origin.password) return playbackFailure(400, 'INVALID_REQUEST'); }
  catch { return playbackFailure(400, 'INVALID_REQUEST'); }
  const limits = resolveLimits(options.limits), clock = options.nowMs ?? Date.now;
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  const runtimeEpoch = randomUUID(), signingKey = randomBytes(32);
  let state: PlaybackState | undefined, pending: PendingCommit | undefined;
  let floor = 0, closing = false, fatal = false, tail: Promise<void> = Promise.resolve(), closeFlight: Promise<void> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const runtimes = new Map<string, RuntimeResource>(), preparations = new Map<string, Preparation>();
  const unresolvedPreparations = new Set<Promise<MobilePlaybackPreparedSource>>();
  const sourceFlights = new Map<string, { raw: Promise<MobilePlaybackPreparedSource>; lateRelease?: Promise<void> }>();
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
  function enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const flight = tail.then(operation); tail = flight.then(() => undefined, () => undefined); return flight;
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
  async function readPersisted(): Promise<PlaybackState> {
    const value: MobileSealedState = await persistence.load(datasetId);
    if (value.kind === 'missing') {
      if (!playbackClosed(value, ['kind', 'datasetId', 'revision']) || value.datasetId !== datasetId || value.revision !== 0) return playbackFailure(503, 'BUSY');
      return { schema: PLAYBACK_STATE_SCHEMA, serverId, datasetId, revision: 0, commitId: null, clockFloor: 0, sessions: [], resources: [], receipts: [] };
    }
    if (!playbackClosed(value, ['kind', 'datasetId', 'revision', 'commitId', 'sealed']) || value.kind !== 'sealed'
      || value.datasetId !== datasetId || !playbackInteger(value.revision, 1) || !id(value.commitId)) return playbackFailure(503, 'BUSY');
    const sealed = bytes(value.sealed, limits.sealedBytes); let plain: Uint8Array | undefined;
    try {
      plain = bytes(crypto.open(sealed, aad(value.revision)), limits.stateBytes);
      const captured = decodePlaybackState(plain, serverId, datasetId, responseOrigin, limits);
      if (captured.revision !== value.revision || captured.commitId !== value.commitId) return playbackFailure(503, 'BUSY');
      return captured;
    } finally { sealed.fill(0); plain?.fill(0); }
  }
  async function save(candidate: PlaybackState): Promise<void> {
    if (!state || pending || fatal) return playbackFailure(503, 'BUSY');
    const previousRevision = state.revision;
    if (previousRevision === Number.MAX_SAFE_INTEGER) return playbackFailure(503, 'BUSY');
    candidate.revision = previousRevision + 1; candidate.commitId = randomUUID(); candidate.clockFloor = now();
    candidate = capturePlaybackState(candidate, serverId, datasetId, responseOrigin, limits);
    const plainText = playbackCanonical(candidate), plain = Buffer.from(plainText);
    if (plain.byteLength > limits.stateBytes) return playbackFailure(429, 'RESOURCE_BUSY');
    let sealed: Uint8Array | undefined;
    try {
      sealed = bytes(crypto.seal(plain, aad(candidate.revision)), limits.sealedBytes);
      const result = await persistence.save({ datasetId, expectedRevision: previousRevision, commitId: candidate.commitId!, sealed });
      if (result.kind === 'conflict' && playbackClosed(result, ['kind', 'datasetId', 'currentRevision']) && result.datasetId === datasetId
        && playbackInteger(result.currentRevision)) { fatal = true; pauseReaders(); return playbackFailure(409, 'REVISION_CONFLICT'); }
      if (!playbackClosed(result, ['kind', 'datasetId', 'revision', 'commitId']) || result.kind !== 'saved' || result.datasetId !== datasetId
        || result.revision !== candidate.revision || result.commitId !== candidate.commitId) {
        pending = { candidate, plain: plainText, previousRevision }; pauseReaders(); return playbackFailure(503, 'BUSY');
      }
      state = candidate;
    } catch (error) {
      if (error instanceof MobilePlaybackError && error.code === 'REVISION_CONFLICT') throw error;
      if (error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent') throw new MobilePlaybackError(503, 'BUSY', true, 1_000);
      pending = { candidate, plain: plainText, previousRevision }; pauseReaders(); throw new MobilePlaybackError(503, 'BUSY', true, 1_000);
    } finally { plain.fill(0); sealed?.fill(0); }
  }
  async function loaded(): Promise<PlaybackState> {
    open();
    if (pending) {
      const observed = await readPersisted();
      if (observed.revision !== pending.candidate.revision || observed.commitId !== pending.candidate.commitId
        || playbackCanonical(observed) !== pending.plain) return playbackFailure(503, 'BUSY');
      state = observed; pending = undefined; restoreRuntimeFences();
    }
    if (!state) {
      state = await readPersisted(); floor = Math.max(floor, state.clockFloor);
      const candidate = playbackCopy(state); let changed = false;
      for (const r of candidate.resources) if (['preparing', 'ready'].includes(r.state)) {
        r.state = 'terminal'; r.failure = 'SERVICE_RESTARTED'; r.media = null; changed = true;
      }
      if (changed) await save(candidate);
      sweepTimer = setInterval(() => {
        if (closing || fatal || pending) return;
        trackBackground(enqueue(async () => { if (state && !closing) await expire(); }));
      }, 1_000); sweepTimer.unref();
    }
    return state;
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
    try { await auth.assertDeviceCurrent(deviceId, deviceEpoch); }
    catch { throw new MobilePlaybackError(403, 'DEVICE_REVOKED'); }
  }
  function capturedRequest(operation: MobilePlaybackControlOperation | MobilePlaybackMediaOperation, request: MobileDecodedRequest<unknown>,
    p?: MobilePrincipal): MobileDecodedRequest<unknown> {
    const snapshot = mobileDataSnapshot(request);
    if (!snapshot.ok || snapshot.value === null || typeof snapshot.value !== 'object' || !playbackClosed(snapshot.value, ['path', 'pathParameters', 'query', 'body',
      ...(Object.hasOwn(snapshot.value, 'idempotencyKey') ? ['idempotencyKey'] : [])])) return playbackFailure(400, 'INVALID_REQUEST');
    request = snapshot.value as unknown as MobileDecodedRequest<unknown>;
    const sessionId = typeof request?.pathParameters?.sessionId === 'string' ? request.pathParameters.sessionId : 'new-session';
    const context = { responseOrigin, requestPath: request?.path,
      resourceCapabilities: { scope: { serverId, deviceId: p?.deviceId ?? 'media-device', sessionId },
        capabilitySnapshotIdentity: `mbm002:${serverId}`, responseOrigin, now: stamp(now()),
        resourceFormatBitDepth: true, capabilityVersion: '1.0.0' as const } };
    const encoded = encodeMobileRequest(operation, request as MobileRequestMap[typeof operation], context);
    if (!encoded.ok) return playbackFailure(400, 'INVALID_REQUEST');
    const decoded = decodeMobileRequest(operation, encoded.value, context);
    if (!decoded.ok) return playbackFailure(400, 'INVALID_REQUEST'); return playbackCopy(decoded.value);
  }
  function session(idValue: string | undefined, p: MobilePrincipal): StoredPlaybackSession {
    const value = state?.sessions.find(v => v.id === idValue);
    if (!value || value.deviceId !== p.deviceId) return playbackFailure(404, 'INVALID_REQUEST');
    if (value.deviceEpoch !== p.deviceEpoch) throw codeError('DEVICE_REVOKED');
    return value;
  }
  function resource(idValue: string | undefined, s: StoredPlaybackSession): StoredPlaybackResource {
    const value = state?.resources.find(v => v.id === idValue);
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
      async beforeSend() { open(); if (pending) return playbackFailure(503, 'BUSY'); await deviceCurrent(p.deviceId, p.deviceEpoch); open(); } };
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
  function findReceipt(identity: ReturnType<typeof receiptIdentity>, p: MobilePrincipal): StoredPlaybackReceipt | undefined {
    const r = state?.receipts.find(v => v.deviceId === p.deviceId && v.deviceEpoch === p.deviceEpoch && equalHash(v.keyHash, identity.keyHash));
    if (r && (!equalHash(r.fingerprint, identity.fingerprint) || !equalHash(r.scopeHash, identity.scopeHash))) return playbackFailure(409, 'IDEMPOTENCY_CONFLICT');
    return r;
  }
  function room(): void {
    if (!state || state.receipts.length >= limits.maxReceipts) return playbackFailure(429, 'RESOURCE_BUSY');
  }
  function addReceipt(candidate: PlaybackState, operation: StoredPlaybackReceipt['operation'], request: MobileDecodedRequest<unknown>,
    p: MobilePrincipal, sessionId: string, resourceId: string | null): StoredPlaybackReceipt {
    const r: StoredPlaybackReceipt = { id: randomUUID(), operation, deviceId: p.deviceId, deviceEpoch: p.deviceEpoch,
      ...receiptIdentity(operation, request, p), request: playbackCopy(request), createdAt: now(), sessionId, resourceId, state: 'UNKNOWN', reply: null, resourceContext: null };
    candidate.receipts.push(r); return r;
  }
  function installTicket(r: StoredPlaybackResource): void {
    if (!r.source) return playbackFailure(503, 'RESOURCE_BUSY');
    const expiresAt = Math.min(now() + limits.ticketTtlMs, r.expiresAt, r.hardExpiresAt);
    if (expiresAt <= now()) throw codeError('RESOURCE_EXPIRED');
    const nonce = randomToken(); if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) return playbackFailure(503, 'BUSY');
    const payload = Buffer.from(JSON.stringify([runtimeEpoch, r.id, expiresAt, nonce])).toString('base64url');
    const signature = createHmac('sha256', signingKey).update(playbackCanonical([serverId, datasetId, r.deviceId, r.deviceEpoch, r.sessionId, ASSET, payload])).digest('base64url');
    const token = `v1.${payload}.${signature}`;
    if (token.length > 512 || r.tickets.some(v => equalHash(v.hash, hash(token))) || r.tickets.length >= limits.maxReceipts + limits.maxStoredResources) return playbackFailure(429, 'RESOURCE_BUSY');
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
    const candidate = playbackCopy(state), ids: string[] = []; let changed = false; const at = now();
    for (const s of candidate.sessions) if (!s.terminal && at >= s.expiresAt) {
      s.terminal = 'SESSION_EXPIRED'; const owned = candidate.resources.filter(r => r.sessionId === s.id && r.state !== 'terminal').map(r => r.id);
      markTerminal(candidate, owned, 'SESSION_EXPIRED'); ids.push(...owned); changed = true;
    }
    for (const r of candidate.resources) if (['preparing', 'ready'].includes(r.state)
      && (at >= r.expiresAt || at >= r.hardExpiresAt || at >= (runtimes.get(r.id)?.lastActivityAt ?? r.lastActivityAt) + limits.orphanResourceMs)) {
      markTerminal(candidate, [r.id], 'RESOURCE_EXPIRED'); ids.push(r.id); changed = true;
    }
    if (changed) { await save(candidate); trackBackground(Promise.all(ids.map(v => releaseRuntime(v))).then(() => undefined)); }
  }
  async function checkRuntime(r: StoredPlaybackResource, runtime: RuntimeResource): Promise<void> {
    open(); if (pending) return playbackFailure(503, 'BUSY'); liveResource(r);
    const s = state?.sessions.find(v => v.id === r.sessionId); if (!s) return playbackFailure(404, 'INVALID_REQUEST'); liveSession(s);
    if (r.runtimeEpoch !== runtimeEpoch || runtime.releasing || runtime.controller.signal.aborted) throw codeError('RESOURCE_REVOKED');
    await deviceCurrent(r.deviceId, r.deviceEpoch);
    open(); if (pending || runtime.controller.signal.aborted || runtime.releasing) return playbackFailure(401, 'TICKET_REVOKED');
    const current = state?.resources.find(v => v.id === r.id); if (!current) return playbackFailure(404, 'INVALID_REQUEST'); liveResource(current);
  }
  async function recordPreparationFailure(task: Preparation, error: unknown, p: MobilePrincipal): Promise<void> {
    const failure = safeError(error);
    await enqueue(async () => {
      if (!state || pending || closing || fatal) throw failure;
      const candidate = playbackCopy(state), r = candidate.resources.find(v => v.id === task.resourceId), receipt = candidate.receipts.find(v => v.id === task.receiptId);
      if (!r || !receipt) throw failure;
      if (r.state !== 'terminal') { r.state = 'failed'; r.failure = failure.code; r.media = null; }
      if (receipt.state === 'UNKNOWN') { receipt.state = 'RECORDED'; receipt.reply = { status: failure.status, body: failureBody(failure) }; receipt.resourceContext = null; }
      await save(candidate); if (!task.delivered) { task.delivered = true; task.resolve(original(state!.receipts.find(v => v.id === receipt.id)!, p)); }
    });
  }
  async function prepareResource(task: Preparation, p: MobilePrincipal): Promise<void> {
    let prepared: MobilePlaybackPreparedSource | undefined;
    try {
      const r = state!.resources.find(v => v.id === task.resourceId)!;
      const actual = sourcePort.prepare({ resourceId: r.id, trackId: r.request.trackId, versionId: r.request.versionId, contentRevision: r.request.contentRevision }, task.controller.signal);
      const sourceFlight: { raw: Promise<MobilePlaybackPreparedSource>; lateRelease?: Promise<void> } = { raw: actual };
      sourceFlights.set(task.resourceId, sourceFlight);
      unresolvedPreparations.add(actual);
      void actual.then(value => {
        if (task.controller.signal.aborted && !runtimes.has(task.resourceId)) {
          sourceFlight.lateRelease = sourcePort.release(capturePlaybackSource(value).handle); trackBackground(sourceFlight.lateRelease);
        }
      }, () => undefined).finally(() => {
        unresolvedPreparations.delete(actual);
        if (sourceFlight.lateRelease) void sourceFlight.lateRelease.then(() => sourceFlights.delete(task.resourceId), () => { fatal = true; });
        else sourceFlights.delete(task.resourceId);
      }).catch(() => { fatal = true; });
      prepared = capturePlaybackSource(await deadline(actual, limits.prepareTimeoutMs, codeError('RESOURCE_BUSY'), () => task.controller.abort()));
      runtimes.set(task.resourceId, { id: task.resourceId, source: prepared, controller: task.controller, readers: new Map(), lastActivityAt: now(), releasing: false });
      task.controller.signal.throwIfAborted();
      const { handle: _handle, ...facts } = prepared;
      await enqueue(async () => {
        open(); await loaded(); await deviceCurrent(p.deviceId, p.deviceEpoch);
        const candidate = playbackCopy(state!), resourceValue = candidate.resources.find(v => v.id === task.resourceId)!;
        liveSession(candidate.sessions.find(v => v.id === resourceValue.sessionId)!); liveResource(resourceValue); task.controller.signal.throwIfAborted();
        resourceValue.source = playbackCopy(facts); await save(candidate);
      });
      const verification = deadline((async () => { await sourcePort.verify(prepared!.handle); task.controller.signal.throwIfAborted();
        await sourcePort.renew(prepared!.handle); task.controller.signal.throwIfAborted(); })(), limits.prepareTimeoutMs, codeError('RESOURCE_BUSY'), () => task.controller.abort());
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const quick = await Promise.race([verification.then(() => true), new Promise<false>(resolve => { waitTimer = setTimeout(() => resolve(false), limits.readyWaitMs); })])
        .finally(() => { if (waitTimer) clearTimeout(waitTimer); });
      if (!quick) await enqueue(async () => {
        open(); await loaded(); await deviceCurrent(p.deviceId, p.deviceEpoch); task.controller.signal.throwIfAborted();
        const candidate = playbackCopy(state!), resourceValue = candidate.resources.find(v => v.id === task.resourceId)!, receipt = candidate.receipts.find(v => v.id === task.receiptId)!;
        liveSession(candidate.sessions.find(v => v.id === resourceValue.sessionId)!); liveResource(resourceValue);
        receipt.state = 'RECORDED'; receipt.reply = { status: 202, body: resourceBody(resourceValue) };
        receipt.resourceContext = playbackResourceContext(serverId, responseOrigin, candidate.sessions.find(v => v.id === resourceValue.sessionId)!, resourceValue, now());
        await save(candidate); task.delivered = true; task.resolve(original(state!.receipts.find(v => v.id === receipt.id)!, p));
      });
      await verification;
      await enqueue(async () => {
        open(); await loaded(); await deviceCurrent(p.deviceId, p.deviceEpoch); task.controller.signal.throwIfAborted();
        const candidate = playbackCopy(state!), resourceValue = candidate.resources.find(v => v.id === task.resourceId)!, receipt = candidate.receipts.find(v => v.id === task.receiptId)!;
        const s = candidate.sessions.find(v => v.id === resourceValue.sessionId)!; liveSession(s); liveResource(resourceValue);
        resourceValue.state = 'ready'; resourceValue.failure = null; installTicket(resourceValue);
        const currentBody = resourceBody(resourceValue), context = playbackResourceContext(serverId, responseOrigin, s, resourceValue, now());
        if (currentBody.state !== 'ready' || !validateMobileReadyAudio(currentBody, resourceValue.request, context).ok
          || resourceValue.source!.processing.mode !== 'direct' || resourceValue.source!.processing.fromPreparedCache
          || playbackCanonical(resourceValue.source!.sourceAudio) !== playbackCanonical(resourceValue.source!.actualAudio)
          || resourceValue.request.quality.preferredTransport === 'hls') throw codeError('UNSUPPORTED_FORMAT');
        if (receipt.state === 'UNKNOWN') { receipt.state = 'RECORDED'; receipt.reply = { status: 201, body: currentBody }; receipt.resourceContext = context; }
        await save(candidate); if (!task.delivered) { task.delivered = true; task.resolve(original(state!.receipts.find(v => v.id === receipt.id)!, p)); }
      });
    } catch (error) {
      try { await recordPreparationFailure(task, error, p); } catch (failure) { if (!task.delivered) { task.delivered = true; task.reject(safeError(failure)); } }
      if (runtimes.has(task.resourceId)) { try { await releaseRuntime(task.resourceId, true); } catch { fatal = true; } }
      else if (prepared) { try { await (sourceFlightFor(task.resourceId)?.lateRelease ?? sourcePort.release(prepared.handle)); } catch { fatal = true; } }
    } finally { preparations.delete(task.resourceId); }
  }
  function sourceFlightFor(resourceId: string) { return sourceFlights.get(resourceId); }
  function startPreparation(resourceId: string, receiptId: string, p: MobilePrincipal): Preparation {
    let resolve!: Preparation['resolve'], reject!: Preparation['reject'];
    const result = new Promise<MobilePlaybackControlReply>((yes, no) => { resolve = yes; reject = no; });
    const task: Preparation = { resourceId, receiptId, controller: new AbortController(), reply: result, resolve, reject, finished: Promise.resolve(), delivered: false };
    preparations.set(resourceId, task); task.finished = prepareResource(task, p); void task.finished.catch(() => { fatal = true; });
    return task;
  }
  async function handleControl(operation: MobilePlaybackControlOperation, request: MobileDecodedRequest<unknown>, p: MobilePrincipal): Promise<
    { value: MobilePlaybackControlReply } | { wait: Promise<MobilePlaybackControlReply> }> {
    await loaded(); await deviceCurrent(p.deviceId, p.deviceEpoch); await expire();
    if (['createSession', 'createResource', 'renewResource'].includes(operation)) {
      const prior = findReceipt(receiptIdentity(operation as StoredPlaybackReceipt['operation'], request, p), p);
      if (prior) {
        if (prior.state === 'RECORDED') return { value: original(prior, p) };
        const task = prior.resourceId ? preparations.get(prior.resourceId) : undefined;
        if (task && task.receiptId === prior.id) return { wait: task.reply };
        return playbackFailure(503, 'RESOURCE_BUSY');
      }
    }
    if (operation === 'createSession') {
      room();
      const live = state!.sessions.filter(v => !v.terminal && v.expiresAt > now());
      if (state!.sessions.length >= limits.maxStoredSessions || live.length >= limits.maxLiveSessions
        || live.filter(v => v.deviceId === p.deviceId).length >= limits.maxSessionsPerDevice) return playbackFailure(429, 'RESOURCE_BUSY');
      const body = mobileResourceCommandSnapshot('sessionRequest', request.body); if (!body.ok) return playbackFailure(400, 'INVALID_REQUEST');
      const candidate = playbackCopy(state!), at = now(), s: StoredPlaybackSession = { id: randomUUID(), deviceId: p.deviceId,
        deviceEpoch: p.deviceEpoch, clientInstanceId: body.value.clientInstanceId, createdAt: at, expiresAt: at + limits.sessionTtlMs,
        terminal: null, lastSequence: 0, playerGeneration: null, currentQueueItemId: null, currentResourceId: null, observation: null };
      candidate.sessions.push(s); const receipt = addReceipt(candidate, operation, request, p, s.id, null);
      receipt.state = 'RECORDED'; receipt.reply = { status: 201, body: sessionBody(s) }; await save(candidate);
      return { value: original(state!.receipts.find(v => v.id === receipt.id)!, p) };
    }
    const s = session(request.pathParameters.sessionId, p);
    if (operation === 'closeSession') {
      if (!s.terminal) { const candidate = playbackCopy(state!); candidate.sessions.find(v => v.id === s.id)!.terminal = 'SESSION_CLOSED';
        markTerminal(candidate, candidate.resources.filter(v => v.sessionId === s.id).map(v => v.id), 'SESSION_CLOSED'); await save(candidate); }
      const ids = state!.resources.filter(v => v.sessionId === s.id).map(v => v.id);
      return { wait: Promise.all(ids.map(v => releaseRuntime(v))).then(() => reply(204, null, p)) };
    }
    if (operation === 'releaseResource') {
      const r = resource(request.pathParameters.resourceId, s);
      if (r.state !== 'terminal') { const candidate = playbackCopy(state!); markTerminal(candidate, [r.id], 'RESOURCE_RELEASED'); await save(candidate); }
      return { wait: releaseRuntime(r.id).then(() => reply(204, null, p)) };
    }
    liveSession(s);
    if (operation === 'getSession') return { value: reply(200, sessionBody(s), p) };
    if (operation === 'createResource') {
      room();
      const live = state!.resources.filter(v => ['preparing', 'ready'].includes(v.state));
      if (state!.resources.length >= limits.maxStoredResources || live.length >= limits.maxLiveResources
        || new Set([...runtimes.keys(), ...preparations.keys(), ...sourceFlights.keys()]).size >= limits.maxLiveResources) return playbackFailure(429, 'RESOURCE_BUSY');
      const candidate = playbackCopy(state!), at = now(), resourceId = randomUUID();
      const body = request.body as MobileResourceRequest;
      const r: StoredPlaybackResource = { id: resourceId, sessionId: s.id, deviceId: p.deviceId, deviceEpoch: p.deviceEpoch,
        request: playbackCopy(body), createdAt: at, expiresAt: Math.min(at + limits.resourceTtlMs, s.expiresAt),
        hardExpiresAt: Math.min(at + limits.maximumResourceLifetimeMs, s.expiresAt), lastActivityAt: at,
        state: 'preparing', failure: null, source: null, media: null, runtimeEpoch, tickets: [] };
      candidate.resources.push(r); const receipt = addReceipt(candidate, operation, request, p, s.id, resourceId); await save(candidate);
      const task = startPreparation(resourceId, receipt.id, p); return { wait: task.reply };
    }
    if (operation === 'reportObservation') {
      const checked = mobileResourceCommandSnapshot('observation', request.body); if (!checked.ok) return playbackFailure(400, 'INVALID_REQUEST');
      const observation: MobileObservation = checked.value, r = resource(observation.resourceId, s); liveResource(r);
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
    const r = resource(request.pathParameters.resourceId, s);
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
    await checkRuntime(r, runtime); await sourcePort.verify(runtime.source.handle); await sourcePort.renew(runtime.source.handle); await checkRuntime(r, runtime);
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
  async function createReader(r: StoredPlaybackResource, runtime: RuntimeResource, start: number, end: number,
    expiresAt: number, signal: AbortSignal): Promise<MobilePlaybackReader> {
    const total = [...runtimes.values()].reduce((n, v) => n + v.readers.size, 0);
    if (total >= limits.maxReads || runtime.readers.size >= limits.maxReadsPerResource) throw codeError('RESOURCE_BUSY');
    const readId = randomUUID(), controller = new AbortController(), resourceSignal = runtime.controller.signal;
    let offset = start, inFlight: Promise<Uint8Array> | undefined, sourceReadFlight: Promise<Uint8Array> | undefined,
      closeReadFlight: Promise<void> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined, ticketTimer: ReturnType<typeof setTimeout> | undefined, iterated = false;
    const abort = (): void => { controller.abort(); void closeRead().catch(() => { fatal = true; }); };
    const armIdle = (): void => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(abort, limits.mediaIdleMs); idleTimer.unref(); };
    signal.addEventListener('abort', abort, { once: true }); resourceSignal.addEventListener('abort', abort, { once: true });
    ticketTimer = setTimeout(abort, Math.max(0, expiresAt - now())); ticketTimer.unref(); armIdle();
    async function closeRead(): Promise<void> {
      controller.abort(); if (idleTimer) clearTimeout(idleTimer); if (ticketTimer) clearTimeout(ticketTimer);
      signal.removeEventListener('abort', abort); resourceSignal.removeEventListener('abort', abort);
      if (closeReadFlight) return deadline(closeReadFlight, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
      const actual = (async () => {
        // 先关闭原 readId 的 Owner 能力；超时包装结束并不等于原 I/O 已静止。
        const quiet = sourcePort.closeRead(runtime.source.handle, readId);
        await Promise.all([quiet, sourceReadFlight?.catch(() => undefined), inFlight?.catch(() => undefined)]);
        runtime.readers.delete(readId);
      })();
      closeReadFlight = actual; return deadline(actual, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
    }
    const reader: MobilePlaybackReader = {
      readId,
      async read(maxBytes = CHUNK_BYTES) {
        if (!playbackInteger(maxBytes, 1, CHUNK_BYTES)) return playbackFailure(400, 'INVALID_REQUEST');
        if (controller.signal.aborted || signal.aborted || resourceSignal.aborted) return playbackFailure(401, 'TICKET_REVOKED');
        if (now() >= expiresAt) { abort(); throw codeError('TICKET_EXPIRED'); }
        if (inFlight) throw codeError('RESOURCE_BUSY');
        if (offset > end) { await closeRead(); return new Uint8Array(); }
        const count = Math.min(maxBytes, end - offset + 1), currentOffset = offset; armIdle();
        const operation = (async () => {
          await checkRuntime(r, runtime); controller.signal.throwIfAborted();
          const sourceRead = sourcePort.read(runtime.source.handle, readId, currentOffset, count, controller.signal);
          sourceReadFlight = sourceRead;
          void sourceRead.then(() => { if (sourceReadFlight === sourceRead) sourceReadFlight = undefined; },
            () => { if (sourceReadFlight === sourceRead) sourceReadFlight = undefined; });
          const raw = await deadline(sourceRead, limits.mediaIdleMs,
            codeError('RESOURCE_BUSY'), () => controller.abort());
          const chunk = bytes(raw, count); await checkRuntime(r, runtime);
          controller.signal.throwIfAborted(); signal.throwIfAborted(); resourceSignal.throwIfAborted();
          if (now() >= expiresAt) throw codeError('TICKET_EXPIRED');
          offset += chunk.byteLength; runtime.lastActivityAt = now(); armIdle(); return chunk;
        })();
        inFlight = operation;
        try { return await operation; } catch (error) { controller.abort(); throw safeError(error); }
        finally { inFlight = undefined; if (controller.signal.aborted) void closeRead().catch(() => { fatal = true; }); }
      },
      close: closeRead,
      async *[Symbol.asyncIterator]() {
        if (iterated) return playbackFailure(400, 'INVALID_REQUEST'); iterated = true;
        try { while (offset <= end) yield await reader.read(); } finally { await reader.close(); }
      },
    };
    runtime.readers.set(readId, reader); if (signal.aborted || resourceSignal.aborted) abort(); return reader;
  }
  const service: MobilePlaybackService = {
    async control(operation, raw, rawPrincipal, signal) {
      if (!MOBILE002_CONTROL_OPERATIONS.includes(operation)) return playbackFailure(400, 'INVALID_REQUEST');
      signal.throwIfAborted(); const p = principal(rawPrincipal), request = capturedRequest(operation, raw, p);
      const result = await enqueue(() => handleControl(operation, request, p));
      const value = 'wait' in result ? await result.wait : result.value; signal.throwIfAborted(); return value;
    },
    async openMedia(operation, raw, signal, headers = {}) {
      if (!['getMediaAsset', 'headMediaAsset'].includes(operation) || !playbackClosed(headers, Object.keys(headers))
        || Object.keys(headers).some(k => !['range', 'ifRange'].includes(k))
        || headers.range !== undefined && typeof headers.range !== 'string' || headers.ifRange !== undefined && typeof headers.ifRange !== 'string') return playbackFailure(400, 'INVALID_REQUEST');
      signal.throwIfAborted(); const request = capturedRequest(operation, raw);
      const captured = await enqueue(async () => {
        await loaded(); await expire(); const r = state!.resources.find(v => v.id === request.pathParameters.resourceId);
        if (!r || request.pathParameters.asset !== ASSET || typeof request.query.ticket !== 'string') return playbackFailure(401, 'TICKET_INVALID');
        const ticket = mediaTicket(r, request.query.ticket); await deviceCurrent(r.deviceId, r.deviceEpoch);
        const s = state!.sessions.find(v => v.id === r.sessionId)!; liveSession(s); liveResource(r);
        if (now() >= ticket.expiresAt) throw codeError('TICKET_EXPIRED');
        const runtime = runtimes.get(r.id); if (!runtime || r.state !== 'ready' || !r.source) throw codeError('RESOURCE_REVOKED');
        await deadline(sourcePort.verify(runtime.source.handle), limits.mediaEstablishmentMs, codeError('RESOURCE_BUSY'));
        await checkRuntime(r, runtime); signal.throwIfAborted();
        if (now() >= ticket.expiresAt) throw codeError('TICKET_EXPIRED');
        return { r, runtime, ticket };
      });
      const { r, runtime, ticket } = captured, source = r.source!;
      const selection = operation === 'headMediaAsset' ? { status: 200, start: 0, end: source.size - 1 } as const
        : selectLocalBytes(headers.range, headers.ifRange, source.size);
      const selected = 'start' in selection;
      const responseHeaders: [string, string][] = [['Cache-Control', 'no-store'], ['Accept-Ranges', 'bytes'],
        ['Content-Length', selected ? String(selection.end - selection.start + 1) : '0']];
      if (selected) responseHeaders.push(['Content-Type', source.contentType]);
      if (selection.status === 206 && selected) responseHeaders.push(['Content-Range', `bytes ${selection.start}-${selection.end}/${source.size}`]);
      if (selection.status === 416) responseHeaders.push(['Content-Range', `bytes */${source.size}`]);
      const reader = selected && operation === 'getMediaAsset' ? await createReader(r, runtime, selection.start, selection.end, ticket.expiresAt, signal) : null;
      const result: MobilePlaybackMediaReply = { status: selection.status, headers: responseHeaders, totalBytes: source.size,
        start: selected ? selection.start : null, end: selected ? selection.end : null,
        ticketExpiresAtMs: ticket.expiresAt, resourceAbortSignal: runtime.controller.signal, reader,
        async beforeSend() { signal.throwIfAborted(); await checkRuntime(r, runtime); if (now() >= ticket.expiresAt) throw codeError('TICKET_EXPIRED'); },
        async close() { await reader?.close(); } };
      return result;
    },
    async revokeDevice(deviceId) {
      if (!id(deviceId)) return playbackFailure(400, 'INVALID_REQUEST');
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
      closing = true; if (sweepTimer) clearInterval(sweepTimer); for (const task of preparations.values()) task.controller.abort(); pauseReaders();
      closeFlight = (async () => {
        await deadline(tail, limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
        await deadline(Promise.all([...preparations.values()].map(v => v.finished)), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
        await Promise.all([...runtimes.keys()].map(v => releaseRuntime(v)));
        await deadline(Promise.all([...unresolvedPreparations]), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
        await deadline(Promise.all([...sourceFlights.values()].map(v => v.lateRelease ?? v.raw.then(() => undefined))), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
        await deadline(Promise.all([...background]), limits.releaseConfirmationMs, codeError('RESOURCE_BUSY'));
        if (runtimes.size || unresolvedPreparations.size || sourceFlights.size) throw codeError('RESOURCE_BUSY'); signingKey.fill(0);
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
