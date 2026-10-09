import { createHash } from 'node:crypto';
import {
  MOBILE_CODEC_LIMITS, MOBILE_OPERATION_TABLE, isMobileId, mobileCanonicalJson, mobileCommonResponseSnapshot,
  mobileDataSnapshot, mobileResourceCommandSnapshot, mobileResourceRequestSnapshot, mobileResourceResponseSnapshot,
  validateMobileCreateResourceReply, validateMobileGetResourceReply,
  parseMobileJson, type MobileAudioInfo, type MobileDecodedRequest, type MobileErrorEnvelope,
  type MobileJsonValue, type MobileMedia, type MobileObservation, type MobileProcessing,
  type MobileResourceRequest, type MobileResourceSemanticContext, type MobileSession,
} from '@music-bridge/contracts';
import { MobilePlaybackError, type MobilePlaybackErrorCode, type MobilePlaybackLimits,
  type MobilePlaybackPreparedSource } from './playback-types.js';

export const PLAYBACK_STATE_SCHEMA = 'musicbridge.mobile002.playback-state.v1';
export interface PlaybackSourceFacts {
  sourceAudio: MobileAudioInfo; actualAudio: MobileAudioInfo; processing: MobileProcessing;
  contentType: string; size: number; durationMs: number; seekable: boolean;
}
export interface StoredPlaybackSession {
  id: string; deviceId: string; deviceEpoch: number; clientInstanceId: string;
  createdAt: number; expiresAt: number; terminal: MobilePlaybackErrorCode | null;
  lastSequence: number; playerGeneration: number | null;
  currentQueueItemId: string | null; currentResourceId: string | null; observation: MobileObservation | null;
}
export interface StoredPlaybackResource {
  id: string; sessionId: string; deviceId: string; deviceEpoch: number;
  request: MobileResourceRequest; createdAt: number; expiresAt: number; hardExpiresAt: number; lastActivityAt: number;
  state: 'preparing' | 'ready' | 'failed' | 'terminal'; failure: MobilePlaybackErrorCode | null;
  source: PlaybackSourceFacts | null; media: MobileMedia | null; runtimeEpoch: string;
  tickets: { hash: string; expiresAt: number; runtimeEpoch: string }[];
}
export interface StoredPlaybackReply {
  status: number; body: MobileSession | import('@music-bridge/contracts').MobileResource | MobileErrorEnvelope;
}
export interface StoredPlaybackReceipt {
  id: string; operation: 'createSession' | 'createResource' | 'renewResource';
  deviceId: string; deviceEpoch: number; keyHash: string; fingerprint: string; scopeHash: string;
  request: MobileDecodedRequest<unknown>; createdAt: number; sessionId: string; resourceId: string | null;
  state: 'UNKNOWN' | 'RECORDED'; reply: StoredPlaybackReply | null; resourceContext: MobileResourceSemanticContext | null;
}
export interface PlaybackState {
  schema: typeof PLAYBACK_STATE_SCHEMA; serverId: string; datasetId: string;
  revision: number; commitId: string | null; clockFloor: number;
  sessions: StoredPlaybackSession[]; resources: StoredPlaybackResource[]; receipts: StoredPlaybackReceipt[];
}
const codes: readonly MobilePlaybackErrorCode[] = [
  'INVALID_REQUEST', 'UNAUTHORIZED', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'BUSY',
  'SESSION_EXPIRED', 'SESSION_CLOSED', 'RESOURCE_EXPIRED', 'RESOURCE_RELEASED', 'RESOURCE_REVOKED',
  'DEVICE_REVOKED', 'TICKET_EXPIRED', 'TICKET_INVALID', 'TICKET_REVOKED', 'SERVICE_RESTARTED',
  'RESOURCE_BUSY', 'SOURCE_CHANGED', 'UNSUPPORTED_FORMAT',
];
export const playbackFailure = (status: MobilePlaybackError['status'], code: MobilePlaybackErrorCode): never => {
  throw new MobilePlaybackError(status, code, ['BUSY', 'RESOURCE_BUSY', 'SERVICE_RESTARTED'].includes(code),
    ['BUSY', 'RESOURCE_BUSY', 'SERVICE_RESTARTED'].includes(code) ? 1_000 : undefined);
};
export const playbackInteger = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= min && v <= max;
export const playbackRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export function playbackClosed(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!playbackRecord(v)) return false;
  const own = Reflect.ownKeys(v);
  return own.length === keys.length && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k); return d?.enumerable === true && Object.hasOwn(d, 'value');
  });
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const code = (v: unknown): v is MobilePlaybackErrorCode => typeof v === 'string' && codes.includes(v as MobilePlaybackErrorCode);
const stamp = (n: number): string => new Date(n).toISOString();
const ms = (v: unknown): v is number => playbackInteger(v, 0, 8_640_000_000_000_000);
const maybeId = (v: unknown): v is string | null => v === null || isMobileId(v);
const maybeCode = (v: unknown): v is MobilePlaybackErrorCode | null => v === null || code(v);
export function playbackCopy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function playbackCanonical(value: unknown): string {
  const captured = mobileDataSnapshot(value, { ...MOBILE_CODEC_LIMITS, responseBytes: 2 * 1024 * 1024, nodes: 200_000, depth: 24 });
  if (!captured.ok) return playbackFailure(503, 'BUSY');
  return mobileCanonicalJson(captured.value);
}
export function capturePlaybackSource(raw: unknown): MobilePlaybackPreparedSource {
  if (!playbackClosed(raw, ['handle', 'sourceAudio', 'actualAudio', 'processing', 'contentType', 'size', 'durationMs', 'seekable'])
    || !isMobileId(raw.handle)) return playbackFailure(409, 'SOURCE_CHANGED');
  const source = captureSourceFacts({ sourceAudio: raw.sourceAudio, actualAudio: raw.actualAudio, processing: raw.processing,
    contentType: raw.contentType, size: raw.size, durationMs: raw.durationMs, seekable: raw.seekable });
  return { handle: raw.handle, ...source };
}
function captureAudio(raw: unknown): MobileAudioInfo {
  const required = ['codec', 'container'], optional = ['sampleRateHz', 'bitsPerSample', 'channels', 'bitrateKbps'];
  if (!playbackRecord(raw) || !playbackClosed(raw, [...required, ...optional.filter(k => Object.hasOwn(raw, k))])) return playbackFailure(503, 'BUSY');
  const captured = mobileCommonResponseSnapshot('audioInfo', raw);
  if (!captured.ok) return playbackFailure(503, 'BUSY'); return playbackCopy(captured.value);
}
export function captureSourceFacts(raw: unknown): PlaybackSourceFacts {
  if (!playbackClosed(raw, ['sourceAudio', 'actualAudio', 'processing', 'contentType', 'size', 'durationMs', 'seekable'])
    || !playbackInteger(raw.size, 1, 64 * 1024 * 1024 * 1024) || !playbackInteger(raw.durationMs)
    || typeof raw.seekable !== 'boolean' || typeof raw.contentType !== 'string'
    || !['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aiff', 'audio/x-aiff', 'audio/flac', 'audio/x-flac', 'application/octet-stream'].includes(raw.contentType)
    || !playbackClosed(raw.processing, ['mode', 'reason', 'fromPreparedCache'])) return playbackFailure(503, 'BUSY');
  const sourceAudio = captureAudio(raw.sourceAudio), actualAudio = captureAudio(raw.actualAudio);
  const processing = mobileCommonResponseSnapshot('processing', raw.processing);
  if (!processing.ok) return playbackFailure(503, 'BUSY');
  return { sourceAudio, actualAudio, processing: playbackCopy(processing.value), contentType: raw.contentType,
    size: raw.size, durationMs: raw.durationMs, seekable: raw.seekable };
}
export function playbackResourceContext(serverId: string, origin: string, session: StoredPlaybackSession,
  resource: StoredPlaybackResource, at: number): MobileResourceSemanticContext {
  if (!resource.source) return playbackFailure(503, 'RESOURCE_BUSY');
  return { scope: { serverId, deviceId: session.deviceId, sessionId: session.id },
    capabilitySnapshotIdentity: `mbm002:${serverId}`, responseOrigin: origin, now: stamp(at),
    resourceFormatBitDepth: true, capabilityVersion: '1.0.0', request: playbackCopy(resource.request),
    source: 'local', sourceAudio: playbackCopy(resource.source.sourceAudio), expectedResourceId: resource.id, hlsAllowed: false };
}
function dense(v: unknown, max: number): v is unknown[] {
  return Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= max
    && Reflect.ownKeys(v).length === v.length + 1 && Array.from(v).every((_, i) => Object.hasOwn(v, i));
}
function captureSession(raw: unknown): StoredPlaybackSession {
  if (!playbackClosed(raw, ['id', 'deviceId', 'deviceEpoch', 'clientInstanceId', 'createdAt', 'expiresAt', 'terminal',
    'lastSequence', 'playerGeneration', 'currentQueueItemId', 'currentResourceId', 'observation'])
    || ![raw.id, raw.deviceId, raw.clientInstanceId].every(isMobileId) || !playbackInteger(raw.deviceEpoch, 1)
    || !ms(raw.createdAt) || !ms(raw.expiresAt) || raw.expiresAt <= raw.createdAt || !maybeCode(raw.terminal)
    || !playbackInteger(raw.lastSequence) || !(raw.playerGeneration === null || playbackInteger(raw.playerGeneration))
    || !maybeId(raw.currentQueueItemId) || !maybeId(raw.currentResourceId)) return playbackFailure(503, 'BUSY');
  if (raw.observation !== null) {
    const observation = mobileResourceCommandSnapshot('observation', raw.observation);
    if (!observation.ok || observation.value.sequence !== raw.lastSequence || observation.value.playerGeneration !== raw.playerGeneration
      || observation.value.queueItemId !== raw.currentQueueItemId || observation.value.resourceId !== raw.currentResourceId) return playbackFailure(503, 'BUSY');
  } else if (raw.lastSequence !== 0 || raw.playerGeneration !== null || raw.currentQueueItemId !== null || raw.currentResourceId !== null) return playbackFailure(503, 'BUSY');
  return playbackCopy(raw as unknown as StoredPlaybackSession);
}
function captureResource(raw: unknown, serverId: string, origin: string): StoredPlaybackResource {
  if (!playbackClosed(raw, ['id', 'sessionId', 'deviceId', 'deviceEpoch', 'request', 'createdAt', 'expiresAt', 'hardExpiresAt',
    'lastActivityAt', 'state', 'failure', 'source', 'media', 'runtimeEpoch', 'tickets'])
    || ![raw.id, raw.sessionId, raw.deviceId, raw.runtimeEpoch].every(isMobileId) || !playbackInteger(raw.deviceEpoch, 1)
    || !ms(raw.createdAt) || !ms(raw.expiresAt) || !ms(raw.hardExpiresAt) || !ms(raw.lastActivityAt)
    || raw.expiresAt < raw.createdAt || raw.hardExpiresAt < raw.expiresAt || raw.lastActivityAt < raw.createdAt
    || !['preparing', 'ready', 'failed', 'terminal'].includes(String(raw.state)) || !maybeCode(raw.failure)
    || !dense(raw.tickets, 6_144)) return playbackFailure(503, 'BUSY');
  for (const ticket of raw.tickets) if (!playbackClosed(ticket, ['hash', 'expiresAt', 'runtimeEpoch'])
    || !hash(ticket.hash) || !ms(ticket.expiresAt) || !isMobileId(ticket.runtimeEpoch)
    || ticket.expiresAt > raw.hardExpiresAt) return playbackFailure(503, 'BUSY');
  if (new Set(raw.tickets.map(t => (t as { hash: string }).hash)).size !== raw.tickets.length) return playbackFailure(503, 'BUSY');
  const request = mobileResourceRequestSnapshot(raw.request, { scope: { serverId, deviceId: String(raw.deviceId), sessionId: String(raw.sessionId) },
    capabilitySnapshotIdentity: `mbm002:${serverId}`, responseOrigin: origin, now: stamp(raw.createdAt), resourceFormatBitDepth: true, capabilityVersion: '1.0.0' });
  if (!request.ok) return playbackFailure(503, 'BUSY');
  const source = raw.source === null ? null : captureSourceFacts(raw.source);
  const value = { ...playbackCopy(raw as unknown as StoredPlaybackResource), request: playbackCopy(request.value), source };
  if ((value.state === 'ready') !== (value.media !== null) || ['failed', 'terminal'].includes(value.state) !== (value.failure !== null)
    || value.state === 'ready' && !source) return playbackFailure(503, 'BUSY');
  if (value.media !== null) {
    const checked = mobileResourceResponseSnapshot({ id: value.id, sessionId: value.sessionId, trackId: value.request.trackId,
      versionId: value.request.versionId, contentRevision: value.request.contentRevision, state: 'ready',
      sourceAudio: source!.sourceAudio, processing: source!.processing, media: value.media });
    if (!checked.ok || checked.value.state !== 'ready' || !playbackClosed(value.media, ['url', 'transport', 'expiresAt', 'durationMs', 'seekable', 'actualAudio'])
      || value.media.transport !== 'file' || value.media.durationMs !== source!.durationMs || value.media.seekable !== source!.seekable
      || playbackCanonical(value.media.actualAudio) !== playbackCanonical(source!.actualAudio)) return playbackFailure(503, 'BUSY');
    const url = new URL(value.media.url);
    if (url.protocol !== 'https:' || url.pathname !== `/mobile/v1/media/${value.id}/source` || url.username || url.password || url.hash
      || [...url.searchParams.keys()].join(',') !== 'ticket' || Date.parse(value.media.expiresAt) > value.expiresAt) return playbackFailure(503, 'BUSY');
  }
  return value;
}
function captureReceipt(raw: unknown, serverId: string, origin: string): StoredPlaybackReceipt {
  if (!playbackClosed(raw, ['id', 'operation', 'deviceId', 'deviceEpoch', 'keyHash', 'fingerprint', 'scopeHash', 'request',
    'createdAt', 'sessionId', 'resourceId', 'state', 'reply', 'resourceContext']) || ![raw.id, raw.deviceId, raw.sessionId].every(isMobileId)
    || !playbackInteger(raw.deviceEpoch, 1) || ![raw.keyHash, raw.fingerprint, raw.scopeHash].every(hash) || !ms(raw.createdAt)
    || !['createSession', 'createResource', 'renewResource'].includes(String(raw.operation)) || !maybeId(raw.resourceId)
    || !['UNKNOWN', 'RECORDED'].includes(String(raw.state)) || (raw.state === 'UNKNOWN') !== (raw.reply === null)
    || !playbackClosed(raw.request, ['path', 'pathParameters', 'query', 'body', 'idempotencyKey'])
    || typeof raw.request.path !== 'string' || !playbackRecord(raw.request.pathParameters) || !playbackRecord(raw.request.query)
    || typeof raw.request.idempotencyKey !== 'string' || raw.request.idempotencyKey.length < 1 || [...raw.request.idempotencyKey].length > 128) return playbackFailure(503, 'BUSY');
  const operation = raw.operation as StoredPlaybackReceipt['operation'];
  const expectedPath = operation === 'createSession' ? '/mobile/v1/sessions'
    : `/mobile/v1/sessions/${String(raw.sessionId)}/resources${operation === 'renewResource' ? `/${String(raw.resourceId)}/renew` : ''}`;
  const expectedParameters = operation === 'createSession' ? {} : operation === 'createResource'
    ? { sessionId: raw.sessionId } : { sessionId: raw.sessionId, resourceId: raw.resourceId };
  if (raw.request.path !== expectedPath || playbackCanonical(raw.request.pathParameters) !== playbackCanonical(expectedParameters)
    || !playbackClosed(raw.request.query, [])) return playbackFailure(503, 'BUSY');
  const body = operation === 'createResource' ? mobileResourceRequestSnapshot(raw.request.body, {
    scope: { serverId, deviceId: String(raw.deviceId), sessionId: String(raw.sessionId) }, responseOrigin: origin,
    now: stamp(raw.createdAt), capabilitySnapshotIdentity: `mbm002:${serverId}`, resourceFormatBitDepth: true, capabilityVersion: '1.0.0',
  }) : mobileResourceCommandSnapshot(operation === 'createSession' ? 'sessionRequest' : 'empty', raw.request.body);
  if (!body.ok) return playbackFailure(503, 'BUSY');
  if (raw.resourceContext !== null && (!playbackClosed(raw.resourceContext, ['scope', 'capabilitySnapshotIdentity', 'responseOrigin', 'now',
    'resourceFormatBitDepth', 'capabilityVersion', 'request', 'source', 'sourceAudio', 'expectedResourceId', 'hlsAllowed'])
    || !playbackClosed(raw.resourceContext.scope, ['serverId', 'deviceId', 'sessionId']))) return playbackFailure(503, 'BUSY');
  if (raw.reply !== null) {
    if (!playbackClosed(raw.reply, ['status', 'body']) || !playbackInteger(raw.reply.status, 200, 599)) return playbackFailure(503, 'BUSY');
    if (raw.reply.status >= 400) {
      if (![400, 401, 403, 404, 409, 410, 429, 503].includes(raw.reply.status)) return playbackFailure(503, 'BUSY');
      const error = mobileCommonResponseSnapshot('error', raw.reply.body);
      if (!error.ok || !playbackClosed(raw.reply.body, ['error']) || !playbackClosed(error.value.error,
        ['code', 'message', 'requestId', 'retryable', ...(error.value.error.retryAfterMs === undefined ? [] : ['retryAfterMs'])])
        || !code(error.value.error.code)) return playbackFailure(503, 'BUSY');
    } else if (raw.operation === 'createSession') {
      if (raw.reply.status !== 201 || !playbackClosed(raw.reply.body, ['id', 'deviceId', 'createdAt', 'expiresAt'])
        || raw.reply.body.id !== raw.sessionId || raw.reply.body.deviceId !== raw.deviceId) return playbackFailure(503, 'BUSY');
    } else {
      const resource = mobileResourceResponseSnapshot(raw.reply.body);
      if (!resource.ok || resource.value.id !== raw.resourceId || resource.value.sessionId !== raw.sessionId
        || raw.operation === 'createResource' && ![201, 202].includes(raw.reply.status)
        || raw.operation === 'renewResource' && raw.reply.status !== 200
        || raw.reply.status === 202 && resource.value.state !== 'preparing'
        || raw.reply.status !== 202 && resource.value.state !== 'ready') return playbackFailure(503, 'BUSY');
    }
  }
  return playbackCopy(raw as unknown as StoredPlaybackReceipt);
}
export function capturePlaybackState(raw: unknown, serverId: string, datasetId: string, origin: string,
  limits: Readonly<MobilePlaybackLimits>): PlaybackState {
  if (!playbackClosed(raw, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'sessions', 'resources', 'receipts'])
    || raw.schema !== PLAYBACK_STATE_SCHEMA || raw.serverId !== serverId || raw.datasetId !== datasetId
    || !playbackInteger(raw.revision) || !(raw.revision === 0 ? raw.commitId === null : isMobileId(raw.commitId))
    || !ms(raw.clockFloor) || !dense(raw.sessions, limits.maxStoredSessions) || !dense(raw.resources, limits.maxStoredResources)
    || !dense(raw.receipts, limits.maxReceipts)) return playbackFailure(503, 'BUSY');
  const sessions = raw.sessions.map(captureSession), resources = raw.resources.map(v => captureResource(v, serverId, origin)),
    receipts = raw.receipts.map(v => captureReceipt(v, serverId, origin));
  for (const list of [sessions, resources, receipts]) if (new Set(list.map(v => v.id)).size !== list.length) return playbackFailure(503, 'BUSY');
  const bySession = new Map(sessions.map(v => [v.id, v])), byResource = new Map(resources.map(v => [v.id, v]));
  for (const r of resources) {
    const s = bySession.get(r.sessionId);
    if (!s || r.deviceId !== s.deviceId || r.deviceEpoch !== s.deviceEpoch || r.createdAt < s.createdAt || r.expiresAt > s.expiresAt) return playbackFailure(503, 'BUSY');
  }
  for (const s of sessions) if (s.observation !== null) {
    const r = byResource.get(s.observation.resourceId);
    if (!r || r.sessionId !== s.id || r.request.trackId !== s.observation.trackId) return playbackFailure(503, 'BUSY');
  }
  const keys = new Set<string>();
  for (const r of receipts) {
    const key = `${r.deviceId}:${r.deviceEpoch}:${r.keyHash}`, s = bySession.get(r.sessionId), resource = r.resourceId === null ? null : byResource.get(r.resourceId);
    if (keys.has(key) || !s || s.deviceId !== r.deviceId || s.deviceEpoch !== r.deviceEpoch
      || r.operation !== 'createSession' && (!resource || resource.sessionId !== s.id)
      || r.operation === 'createSession' && r.resourceId !== null) return playbackFailure(503, 'BUSY');
    const digest = (domain: string, value: unknown) => createHash('sha256')
      .update(playbackCanonical(['MBM002_PLAYBACK_V1', serverId, datasetId, domain, value])).digest('hex');
    const scopeHash = digest('scope', [r.deviceId, r.deviceEpoch, r.operation, MOBILE_OPERATION_TABLE[r.operation].method, r.request.path]);
    if (r.keyHash !== digest('key', [r.deviceId, r.deviceEpoch, r.request.idempotencyKey]) || r.scopeHash !== scopeHash
      || r.fingerprint !== digest('request', [scopeHash, r.request.body])) return playbackFailure(503, 'BUSY');
    if (r.operation === 'createSession' && playbackCanonical(r.request.body) !== playbackCanonical({ clientInstanceId: s.clientInstanceId })
      || r.operation === 'createResource' && resource && playbackCanonical(r.request.body) !== playbackCanonical(resource.request)) return playbackFailure(503, 'BUSY');
    if (r.reply && r.reply.status < 400 && r.operation !== 'createSession') {
      const replyResource = r.reply.body as import('@music-bridge/contracts').MobileResource;
      if (!resource?.source || replyResource.trackId !== resource.request.trackId || replyResource.versionId !== resource.request.versionId
        || replyResource.contentRevision !== resource.request.contentRevision
        || playbackCanonical(replyResource.sourceAudio) !== playbackCanonical(resource.source.sourceAudio)
        || playbackCanonical(replyResource.processing) !== playbackCanonical(resource.source.processing)) return playbackFailure(503, 'BUSY');
      if (!r.resourceContext || r.resourceContext.scope.serverId !== serverId || r.resourceContext.scope.deviceId !== r.deviceId
        || r.resourceContext.scope.sessionId !== r.sessionId || r.resourceContext.expectedResourceId !== r.resourceId
        || playbackCanonical(r.resourceContext.request) !== playbackCanonical(resource.request)
        || playbackCanonical(r.resourceContext.sourceAudio) !== playbackCanonical(resource.source.sourceAudio)
        || !(r.operation === 'createResource' ? validateMobileCreateResourceReply(r.reply.status, r.reply.body, r.resourceContext)
          : validateMobileGetResourceReply(r.reply.status, r.reply.body, r.resourceContext)).ok) return playbackFailure(503, 'BUSY');
    } else if (r.resourceContext !== null) return playbackFailure(503, 'BUSY');
    if (r.reply && r.reply.status === 201 && r.operation === 'createSession') {
      const originalSession = r.reply.body as MobileSession;
      if (originalSession.createdAt !== stamp(s.createdAt) || originalSession.expiresAt !== stamp(s.expiresAt)) return playbackFailure(503, 'BUSY');
    }
    keys.add(key);
  }
  return { schema: PLAYBACK_STATE_SCHEMA, serverId, datasetId, revision: raw.revision, commitId: raw.commitId as string | null,
    clockFloor: raw.clockFloor, sessions, resources, receipts };
}
export function decodePlaybackState(plain: Uint8Array, serverId: string, datasetId: string, origin: string,
  limits: Readonly<MobilePlaybackLimits>): PlaybackState {
  if (plain.byteLength < 1 || plain.byteLength > limits.stateBytes) return playbackFailure(503, 'BUSY');
  const parsed = parseMobileJson(plain, { ...MOBILE_CODEC_LIMITS, responseBytes: limits.stateBytes, nodes: 200_000, depth: 24 });
  if (!parsed.ok) return playbackFailure(503, 'BUSY');
  return capturePlaybackState(parsed.value as MobileJsonValue, serverId, datasetId, origin, limits);
}
