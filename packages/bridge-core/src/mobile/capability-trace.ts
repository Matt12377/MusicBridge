import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { types } from 'node:util';

export const MOBILE_CAPABILITY_TRACE_PREFIX = 'MUSICBRIDGE_MOBILE_CAPABILITY_TRACE ';
export const MOBILE_CAPABILITY_TRACE_SCHEMA = 'mb.mobile-capability-trace.v1';
const discoveryNames = ['ui', 'artwork', 'tracks', 'daily', 'recommended', 'albums', 'charts', 'fm',
  'liked', 'liked-tracks', 'playlists', 'playlist-tracks', 'favorites', 'collection-tracks'] as const;
const discoveryStatuses = [200, 400, 401, 403, 404, 409, 410, 413, 429, 503, 'not-sent', 'failure-unknown'] as const;
export type MobileDiscoveryFailureStage = `http.discovery.${typeof discoveryNames[number]}.${typeof discoveryStatuses[number]}`;
const discoveryFailureStages = discoveryNames.flatMap(name => discoveryStatuses.map(status => `http.discovery.${name}.${status}` as MobileDiscoveryFailureStage));
const uiFeatureNames = ['addedAlbums', 'neteaseDailyRecommendations', 'lyrics', 'neteaseLikedPlaylist', 'personalFavorites',
  'personalPlaylists', 'neteaseRecommendedPlaylists', 'neteaseNewAlbums', 'neteaseCharts', 'neteasePersonalFM'] as const;
const uiFeatureStates = ['ready', 'loginRequired', 'unavailable', 'unsupported'] as const;
type MobileUIFeatureStage = `http.ui.feature.${typeof uiFeatureNames[number]}.${typeof uiFeatureStates[number]}`;
const uiFeatureStages = uiFeatureNames.flatMap(feature => uiFeatureStates.map(state => `http.ui.feature.${feature}.${state}` as MobileUIFeatureStage));
const invalidHttpDateClasses = ['imf-shape', 'imf-parse', 'imf-negative', 'imf-weekday', 'imf-roundtrip', 'obsolete', 'iso', 'combined', 'other'] as const;
const invalidHttpDateStages = [
  ...invalidHttpDateClasses.map(date => `provider.audio-probe.reject.etag-date.invalid.date.${date}.valid` as const),
  ...invalidHttpDateClasses.map(modified => `provider.audio-probe.reject.etag-date.invalid.last-modified.valid.${modified}` as const),
  ...invalidHttpDateClasses.flatMap(date => invalidHttpDateClasses.map(modified =>
    `provider.audio-probe.reject.etag-date.invalid.both.${date}.${modified}` as const)),
];
export const MOBILE_RESOURCE_CAPACITY_STAGES = [
  'capacity.actor.receipts-full', 'capacity.actor.stored-resources-full', 'capacity.actor.live-resources-full',
  'capacity.actor.live-flights-full', 'capacity.actor.tickets-full', 'capacity.desktop.bindings-full',
  'capacity.core.stored-bindings-full', 'capacity.core.active-bindings-full',
  'capacity.provider.stored-resources-full', 'capacity.provider.live-resources-full',
  'capacity.provider.read-ids-full', 'capacity.provider.readers-full', 'capacity.provider.resource-readers-full', 'capacity.provider.read-pending',
  'capacity.http.leases-full', 'capacity.http.probes-full', 'capacity.http.read-ids-full',
  'capacity.http.readers-full', 'capacity.http.resource-readers-full', 'capacity.http.read-pending',
] as const;
export const MOBILE_CAPABILITY_STAGES = [
  ...MOBILE_RESOURCE_CAPACITY_STAGES,
  ...discoveryFailureStages,
  ...uiFeatureStages,
  ...invalidHttpDateStages,
  'provider.source.selection.exact.track-id', 'provider.source.selection.exact.source',
  'provider.source.selection.exact.version', 'provider.source.selection.exact.revision',
  'provider.source.selection.directory.track-id', 'provider.source.selection.directory.source',
  'provider.source.selection.directory.version', 'provider.source.selection.directory.revision',
  'provider.source.refresh.metadata', 'provider.source.refresh.media-base',
  'provider.source.open.cache-missing', 'provider.source.open.observed',
  'provider.source.prepare.scope', 'provider.source.prepare.catalog', 'provider.source.prepare.catalog-facts',
  'provider.source.prepare.current', 'provider.source.prepare.open', 'provider.source.prepare.capture-lease',
  'provider.source.prepare.verify-before', 'provider.source.prepare.audio-read', 'provider.source.prepare.audio-close',
  'provider.source.prepare.verify-after', 'provider.source.prepare.ready-current', 'provider.source.prepare.replay',
  'provider.source.prepare.trace-truncated',
  'provider.source.prepare.audio-facts.codec', 'provider.source.prepare.audio-facts.container',
  'provider.source.prepare.audio-facts.sample-rate', 'provider.source.prepare.audio-facts.bits',
  'provider.source.prepare.audio-facts.channels', 'provider.source.prepare.audio-facts.duration',
  'provider.audio-probe.reject.range.content-range', 'provider.audio-probe.reject.range.content-length',
  'provider.audio-probe.reject.range.encoding', 'provider.audio-probe.reject.vendor.status',
  'provider.audio-probe.reject.vendor.etag', 'provider.audio-probe.reject.vendor.digest',
  'provider.audio-probe.reject.vendor.identity', 'provider.audio-probe.reject.vendor.size',
  'provider.audio-probe.reject.vendor.multipart', 'provider.audio-probe.reject.strong-etag-changed',
  'provider.audio-probe.reject.body.chunk', 'provider.audio-probe.reject.body.length',
  'provider.audio-probe.validator.bare32hex.equal', 'provider.audio-probe.validator.bare32hex.mismatch',
  'provider.audio-probe.validator.bare32hex.not-comparable', 'provider.audio-probe.validator.unquotedother.not-comparable',
  'http.receive', 'http.send', 'http.failure', 'main.current', 'main.auth', 'main.initial-qualification', 'main.encode',
  'http.status.200', 'http.status.400', 'http.status.401', 'http.status.403', 'http.status.404',
  'http.status.409', 'http.status.410', 'http.status.413', 'http.status.429', 'http.status.503',
  'main.beforeSend.alive', 'main.beforeSend.qualification', 'main.beforeSend.auth',
  'content.initialize.cache', 'content.initialize.wait', 'content.rpc.initialize', 'content.rpc.scope', 'content.rpc.cancel', 'content.rpc.other',
  'content.rpc.dispatch', 'content.rpc.revalidate', 'content.rpc.artwork', 'content.rpc.source',
  'content.rpc.track.read', 'content.rpc.track.revalidate', 'main.track.revalidate.scope', 'preparation.http.track',
  'preparation.playback.codec.main-capture', 'preparation.playback.codec.worker-raw',
  'preparation.playback.codec.worker-state', 'preparation.playback.codec.terminal-logical',
  'preparation.playback.codec.v3-physical', 'preparation.playback.codec.terminal-v3-reserve',
  'preparation.playback.codec.v4-physical', 'preparation.playback.codec.terminal-v4-reserve',
  'core.track.read.scope.before', 'core.track.read.scope.after',
  'core.track.revalidate.scope.before', 'core.track.revalidate.scope.after',
  'core.track.revalidate.selection', 'core.track.revalidate.fingerprint',
  'core.track.revalidate.fingerprint.artwork-only', 'core.track.revalidate.fingerprint.other',
  'core.track.revalidate.fingerprint.baseline-missing',
  'core.dispatch.admission', 'core.dispatch.admission.active-full', 'core.dispatch.admission.snapshots-full',
  'core.dispatch.scope.before', 'core.dispatch.content', 'core.dispatch.scope.after', 'core.dispatch.snapshot.capture', 'core.dispatch.reply.capture',
  'core.content.failure', 'core.content.capture', 'core.provider.read', 'core.provider.capture',
  'main.catalog.tracks.owner', 'main.catalog.tracks.snapshot', 'main.catalog.tracks.read',
  'main.catalog.tracks.beforeSend', 'main.catalog.tracks.auth',
  'core.rpc.failure', 'core.rpc.initialize.cache', 'core.rpc.initialize.wait', 'core.rpc.scope.resolve',
  'core.rpc.scope.assert.before', 'core.rpc.scope.qualified', 'core.rpc.scope.assert.after',
  'core.initialize.owner.prepare', 'core.initialize.owner.initialize', 'core.initialize.assemble',
  'core.scope.provider-tail', 'core.scope.account.first', 'core.scope.queue', 'core.scope.account.second',
  'core.scope.owner.update', 'core.scope.assert', 'core.assert.account',
  'main.close.https', 'main.close.service', 'main.close.content-backend', 'main.close.playback',
  'main.close.revocations', 'main.close.content-port', 'main.close.auth',
  'main.close.content.active', 'main.close.content.cleanup', 'main.close.content.deadline',
  'provider.account.ready', 'provider.account.auth-expired', 'provider.account.not-configured',
  'provider.account.timeout', 'provider.account.shape', 'provider.account.unknown',
  'provider.content.feed', 'provider.content.mapping', 'provider.content.song-detail', 'provider.content.stream', 'provider.content.audio-probe',
  'provider.content.stream.batch.id-invalid', 'provider.content.stream.batch.unexpected-id',
  'provider.content.stream.batch.duplicate-id', 'provider.content.stream.batch.missing-id', 'provider.content.stream.item-status',
  'provider.content.mapping.song-id', 'provider.content.mapping.song-title',
  'provider.content.mapping.album-shape', 'provider.content.mapping.album-id', 'provider.content.mapping.album-name',
  'provider.content.mapping.artists-shape', 'provider.content.mapping.artist-id', 'provider.content.mapping.artist-name',
  'provider.content.mapping.duration', 'provider.content.mapping.edition',
  'provider.content.mapping.collection-identity', 'provider.content.mapping.collection-member-id',
  'provider.content.mapping.directory-snapshot', 'provider.content.mapping.track-dto',
  'provider.content.mapping.reply-dto', 'provider.content.mapping.revision-mismatch',
  'provider.content.liked.not-found', 'provider.content.liked.ambiguous', 'provider.content.liked.creator-mismatch',
  'provider.content.liked.marker-number', 'provider.content.liked.marker-string',
  'provider.content.collection.track-ids-missing', 'provider.content.collection.count-mismatch',
  'provider.content.collection.duplicate-ids', 'provider.content.collection.invalid-name',
  'provider.content.albums.total', 'provider.content.albums.page-length', 'provider.content.albums.duplicate-ids', 'provider.content.albums.anchor-changed',
  'provider.audio-probe.reject.non206', 'provider.audio-probe.reject.body-missing',
  'provider.audio-probe.reject.etag-missing', 'provider.audio-probe.reject.etag-weak', 'provider.audio-probe.reject.etag-invalid',
  'provider.audio-probe.reject.etag-invalid.bare32hex', 'provider.audio-probe.reject.etag-invalid.overlimit',
  'provider.audio-probe.reject.etag-invalid.malformedquoted', 'provider.audio-probe.reject.etag-invalid.unquotedother',
  'provider.audio-probe.reject.etag-invalid.unquotedother.after-strong',
  'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-eligible',
  'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-missing',
  'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-invalid',
  'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-future',
  'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-not-strong',
  'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-shape',
  'provider.audio-probe.reject.redirect-location-missing', 'provider.audio-probe.reject.redirect-limit',
  'provider.audio-probe.reject.redirect-policy', 'provider.audio-probe.reject.parser',
  'provider.artwork.scope', 'provider.artwork.identity', 'provider.artwork.signature', 'provider.artwork.generation',
  'provider.artwork.url-missing', 'provider.artwork.url-changed', 'provider.artwork.revision-changed',
  'provider.artwork.url-host-alias-changed',
  'provider.artwork.download.url', 'provider.artwork.download.transport', 'provider.artwork.download.response-url',
  'provider.artwork.download.redirect', 'provider.artwork.download.status', 'provider.artwork.download.body',
  'provider.artwork.download.type', 'provider.artwork.download.encoding', 'provider.artwork.download.length',
  'provider.artwork.download.type.missing', 'provider.artwork.download.type.webp', 'provider.artwork.download.type.svg',
  'provider.artwork.download.type.html', 'provider.artwork.download.type.other', 'provider.artwork.download.type.combined',
  'provider.audio-probe.reject.etag-date.missing', 'provider.audio-probe.reject.etag-date.invalid',
  'provider.audio-probe.reject.etag-date.future', 'provider.audio-probe.reject.etag-date.not-strong',
  'provider.audio-probe.reject.etag-date.shape', 'provider.audio-probe.reject.etag-date.conditional', 'provider.audio-probe.reject.etag-date.changed',
  'provider.artwork.download.limit', 'provider.artwork.download.chunk', 'provider.artwork.download.magic',
  'provider.artwork.download.magic.png.png', 'provider.artwork.download.magic.png.jpeg-soi-final-eoi',
  'provider.artwork.download.magic.png.jpeg-soi-tail-zero', 'provider.artwork.download.magic.png.jpeg-soi-tail-whitespace',
  'provider.artwork.download.magic.png.jpeg-soi-tail-other', 'provider.artwork.download.magic.png.jpeg-soi-no-eoi',
  'provider.artwork.download.magic.png.webp', 'provider.artwork.download.magic.png.other',
  'provider.artwork.download.magic.jpeg.png', 'provider.artwork.download.magic.jpeg.jpeg-soi-final-eoi',
  'provider.artwork.download.magic.jpeg.jpeg-soi-tail-zero', 'provider.artwork.download.magic.jpeg.jpeg-soi-tail-whitespace',
  'provider.artwork.download.magic.jpeg.jpeg-soi-tail-other', 'provider.artwork.download.magic.jpeg.jpeg-soi-no-eoi',
  'provider.artwork.download.magic.jpeg.webp', 'provider.artwork.download.magic.jpeg.other',
  'provider.artwork.download.magic.jpg.png', 'provider.artwork.download.magic.jpg.jpeg-soi-final-eoi',
  'provider.artwork.download.magic.jpg.jpeg-soi-tail-zero', 'provider.artwork.download.magic.jpg.jpeg-soi-tail-whitespace',
  'provider.artwork.download.magic.jpg.jpeg-soi-tail-other', 'provider.artwork.download.magic.jpg.jpeg-soi-no-eoi',
  'provider.artwork.download.magic.jpg.webp', 'provider.artwork.download.magic.jpg.other',
  'provider.artwork.download.magic.octet.png', 'provider.artwork.download.magic.octet.jpeg-soi-final-eoi',
  'provider.artwork.download.magic.octet.jpeg-soi-tail-zero', 'provider.artwork.download.magic.octet.jpeg-soi-tail-whitespace',
  'provider.artwork.download.magic.octet.jpeg-soi-tail-other', 'provider.artwork.download.magic.octet.jpeg-soi-no-eoi',
  'provider.artwork.download.magic.octet.webp', 'provider.artwork.download.magic.octet.other',
  'provider.artwork.transport.dns-failure', 'provider.artwork.transport.dns-answer', 'provider.artwork.transport.dns-address',
  'provider.artwork.transport.dns-empty', 'provider.artwork.transport.http-status', 'provider.artwork.transport.tls',
  'provider.artwork.transport.connection', 'provider.artwork.transport.body', 'provider.artwork.transport.headers',
  'provider.artwork.transport.request',
  'owner.rpc.link', 'owner.rpc.receive', 'owner.rpc.failure', 'owner.content.initialize',
  'owner.content.store.create', 'owner.content.store.load', 'owner.store.directory', 'owner.store.file.open',
  'owner.store.file.read', 'owner.store.envelope', 'owner.store.decrypt', 'owner.store.state', 'owner.store.read',
  'owner.store.file.close', 'owner.store.directory.close', 'owner.store.load.map',
  'preparation.http.identity', 'preparation.http.session', 'preparation.http.body', 'preparation.http.decode',
  'preparation.http.intent', 'preparation.http.resource', 'preparation.http.resource-capabilities',
  'preparation.http.dispatch', 'preparation.http.capture', 'preparation.http.beforeSend', 'preparation.http.terminal',
  'preparation.main.service', 'preparation.main.auth', 'preparation.main.control', 'preparation.main.encode',
  'preparation.main.beforeSend.current', 'preparation.main.beforeSend.auth', 'preparation.main.beforeSend.reply',
  'preparation.auth.admission', 'preparation.auth.queued-admission', 'preparation.auth.owner-load',
  'preparation.auth.envelope', 'preparation.auth.decrypt', 'preparation.auth.capture', 'preparation.auth.pending',
  'preparation.playback.open', 'preparation.playback.owner-load', 'preparation.playback.envelope',
  'preparation.playback.decrypt', 'preparation.playback.state', 'preparation.playback.pending',
  'preparation.playback.recovery-save', 'preparation.playback.expire-save', 'preparation.playback.session-save',
  'preparation.playback.save-admission', 'preparation.playback.candidate', 'preparation.playback.seal',
  'preparation.playback.owner-save', 'preparation.playback.ack', 'preparation.playback.published',
  'preparation.playback.device',
] as const;
export type MobileCapabilityStage = typeof MOBILE_CAPABILITY_STAGES[number];
export type MobileCapabilityRole = 'business' | 'cleanup';
export type MobileCapabilityComponent = 'main' | 'core' | 'owner';
export type MobileCapabilityIdKind = 'http' | 'content' | 'owner';
export type MobileCapabilityInitState = 'none' | 'new-pending' | 'reuse-pending' | 'reuse-fulfilled' | 'reuse-rejected' | 'fulfilled' | 'rejected';
const phases = ['begin', 'ok', 'reject', 'link', 'cache'] as const;
const states: readonly MobileCapabilityInitState[] = ['none', 'new-pending', 'reuse-pending', 'reuse-fulfilled', 'reuse-rejected', 'fulfilled', 'rejected'];
const codes = ['OK', 'UNKNOWN', 'BUSY', 'INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'SOURCE_CHANGED', 'RESOURCE_REVOKED',
  'CONTENT_LIMIT_EXCEEDED', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'CURSOR_INVALID', 'RESOURCE_BUSY', 'RESOURCE_RELEASED', 'DEVICE_REVOKED', 'SERVICE_RESTARTED',
  'UNSUPPORTED_FORMAT', 'NOT_READY', 'TIMEOUT', 'INVALID_IPC_RESPONSE', 'INTERNAL_ERROR', 'ABORT_ERR',
  'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EBADF', 'EMFILE', 'ENFILE', 'ERR_OSSL_BAD_DECRYPT',
  'NETEASE_REQUEST_FAILED', 'NETEASE_NOT_CONFIGURED', 'AUTH_EXPIRED'] as const;
const names = ['UNKNOWN', 'Error', 'TypeError', 'RangeError', 'AbortError', 'MobileServiceError', 'MobileAuthPersistenceError',
  'MobileContentPersistenceError', 'MobilePlaybackError', 'DatasetOwnerTransportError', 'DatasetOwnerDispatchError', 'CoreIpcError', 'BridgeError'] as const;
const fields = ['schema', 'component', 'requestSha256', 'parentSha256', 'relatedSha256', 'epochMs', 'elapsedMs',
  'stage', 'phase', 'role', 'name', 'code', 'outcome', 'aborted', 'initState'] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const choice = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T);
const nullableSha = (value: unknown): value is string | null => value === null || typeof value === 'string' && sha.test(value);
export interface MobileCapabilityTraceRecord {
  schema: typeof MOBILE_CAPABILITY_TRACE_SCHEMA; component: MobileCapabilityComponent;
  requestSha256: string; parentSha256: string | null; relatedSha256: string | null;
  epochMs: number; elapsedMs: number; stage: MobileCapabilityStage; phase: typeof phases[number]; role: MobileCapabilityRole;
  name: typeof names[number]; code: typeof codes[number]; outcome: 'not-sent' | 'unknown' | null;
  aborted: boolean | null; initState: MobileCapabilityInitState;
}
export interface MobileCapabilityTraceSnapshot {
  schema: typeof MOBILE_CAPABILITY_TRACE_SCHEMA; records: MobileCapabilityTraceRecord[];
  firstBusinessFailures: MobileCapabilityTraceRecord[]; cleanupFailures: MobileCapabilityTraceRecord[]; droppedRecords: number;
}
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'));
  } catch { return false; }
}
/** 只接收数据属性及闭集分类；未知字段、代理、getter、正文或异常文本整条拒收。 */
export function copyMobileCapabilityTraceRecord(raw: unknown): MobileCapabilityTraceRecord | null {
  try {
    if (!closed(raw, fields) || raw.schema !== MOBILE_CAPABILITY_TRACE_SCHEMA || !choice(raw.component, ['main', 'core', 'owner'])
      || typeof raw.requestSha256 !== 'string' || !sha.test(raw.requestSha256) || !nullableSha(raw.parentSha256) || !nullableSha(raw.relatedSha256)
      || !integer(raw.epochMs) || !integer(raw.elapsedMs) || !choice(raw.stage, MOBILE_CAPABILITY_STAGES) || !choice(raw.phase, phases)
      || !choice(raw.role, ['business', 'cleanup']) || !choice(raw.name, names) || !choice(raw.code, codes)
      || raw.outcome !== null && !choice(raw.outcome, ['not-sent', 'unknown']) || raw.aborted !== null && typeof raw.aborted !== 'boolean'
      || !choice(raw.initState, states)) return null;
    if (raw.stage === 'provider.source.prepare.trace-truncated' && (raw.component !== 'core' || raw.phase !== 'cache'
      || raw.role !== 'business' || raw.code !== 'OK' || raw.outcome !== null || raw.relatedSha256 !== null || raw.initState !== 'none')) return null;
    return Object.freeze(Object.fromEntries(fields.map(key => [key, raw[key]]))) as unknown as MobileCapabilityTraceRecord;
  } catch { return null; }
}
export function createMobileCapabilityTraceCollector() {
  const records: MobileCapabilityTraceRecord[] = [], first = new Map<string, MobileCapabilityTraceRecord>(), cleanup = new Map<string, MobileCapabilityTraceRecord>();
  let droppedRecords = 0;
  function retain(map: Map<string, MobileCapabilityTraceRecord>, key: string, record: MobileCapabilityTraceRecord): void {
    if (map.has(key)) return;
    if (map.size >= 64) { map.delete(map.keys().next().value!); droppedRecords++; }
    map.set(key, record);
  }
  return {
    record(raw: unknown): void {
      const record = copyMobileCapabilityTraceRecord(raw); if (!record) { droppedRecords++; return; }
      // 此标记表示至少一批成功旁注被主动省略，不是精确丢行数或业务失败。
      if (record.stage === 'provider.source.prepare.trace-truncated' && record.phase === 'cache') droppedRecords++;
      records.push(record); if (records.length > 256) { records.shift(); droppedRecords++; }
      if (record.phase === 'reject') {
        const key = `${record.component}:${record.requestSha256}`;
        retain(record.role === 'business' ? first : cleanup, record.role === 'business' ? key : `${key}:${record.stage}`, record);
      }
    },
    snapshot(): MobileCapabilityTraceSnapshot {
      return { schema: MOBILE_CAPABILITY_TRACE_SCHEMA, records: records.map(row => ({ ...row })),
        firstBusinessFailures: [...first.values()].map(row => ({ ...row })), cleanupFailures: [...cleanup.values()].map(row => ({ ...row })), droppedRecords };
    },
  };
}
function copyCapabilityTraceSnapshot(raw: unknown, maximumRecords: number): MobileCapabilityTraceSnapshot | null {
  try {
    if (!closed(raw, ['schema', 'records', 'firstBusinessFailures', 'cleanupFailures', 'droppedRecords'])
      || raw.schema !== MOBILE_CAPABILITY_TRACE_SCHEMA || !integer(raw.droppedRecords)) return null;
    const read = (value: unknown, maximum: number): MobileCapabilityTraceRecord[] | null => {
      if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null;
      const rows: MobileCapabilityTraceRecord[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        const row = copyMobileCapabilityTraceRecord(descriptor.value); if (!row) return null; rows.push(row);
      }
      return rows;
    };
    const records = read(raw.records, maximumRecords), firstBusinessFailures = read(raw.firstBusinessFailures, 64), cleanupFailures = read(raw.cleanupFailures, 64);
    if (!records || !firstBusinessFailures || !cleanupFailures || firstBusinessFailures.some(row => row.role !== 'business' || row.phase !== 'reject')
      || cleanupFailures.some(row => row.role !== 'cleanup' || row.phase !== 'reject')) return null;
    return { schema: MOBILE_CAPABILITY_TRACE_SCHEMA, records, firstBusinessFailures, cleanupFailures, droppedRecords: raw.droppedRecords };
  } catch { return null; }
}
/** 普通全局trace维持256条；更大的额度只由已armed私有resource导出内部调用。 */
export function copyMobileCapabilityTraceSnapshot(raw: unknown): MobileCapabilityTraceSnapshot | null {
  return copyCapabilityTraceSnapshot(raw, 256);
}

export interface MobileCapabilityTraceBranchDetails {
  readonly records: readonly MobileCapabilityTraceRecord[];
  readonly omittedRecords: number;
  readonly sourceDroppedRecords: number;
}
/** 只沿原HTTP父链和明确RPC/cache边选旁注；相近时间、任意related和Owner同SHA都不能建立关联。 */
export function selectMobileCapabilityTraceBranchDetails(snapshot: unknown, rootSha256: string,
  mode: 'http' | 'close' = 'http'): Readonly<MobileCapabilityTraceBranchDetails> {
  const empty = (): Readonly<MobileCapabilityTraceBranchDetails> => Object.freeze({ records: Object.freeze([]), omittedRecords: 0, sourceDroppedRecords: 0 });
  try {
    if (typeof rootSha256 !== 'string' || rootSha256.length !== 64 || !sha.test(rootSha256)
      || mode !== 'http' && mode !== 'close') return empty();
    const captured = copyMobileCapabilityTraceSnapshot(snapshot); if (!captured) return empty();
    const key = (row: MobileCapabilityTraceRecord): string => JSON.stringify(row);
    const unique = new Map<string, MobileCapabilityTraceRecord>();
    for (const row of [...captured.records, ...captured.firstBusinessFailures, ...captured.cleanupFailures]) unique.set(key(row), row);
    const rows = [...unique.values()], main = new Set([rootSha256]), core = new Set<string>(), owner = new Set<string>();
    const initializeLink = (row: MobileCapabilityTraceRecord): boolean => row.phase === 'cache'
      && row.initState !== 'none' && row.relatedSha256 !== null
      && (row.component === 'main' && row.stage === 'content.initialize.cache'
        || row.component === 'core' && row.stage === 'core.rpc.initialize.cache');
    const ownerLink = (row: MobileCapabilityTraceRecord): boolean => row.component === 'core'
      && row.stage === 'owner.rpc.link' && row.phase === 'link' && row.relatedSha256 !== null;
    let changed = true;
    const add = (set: Set<string>, value: string): void => { if (!set.has(value)) { set.add(value); changed = true; } };
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.component === 'main' && row.parentSha256 !== null && main.has(row.parentSha256)) {
          add(main, row.requestSha256); add(core, row.requestSha256);
        }
        const linked = row.component === 'main' ? main.has(row.requestSha256)
          : row.component === 'core' ? core.has(row.requestSha256) : owner.has(row.requestSha256);
        if (!linked) continue;
        if (initializeLink(row)) { add(main, row.relatedSha256!); add(core, row.relatedSha256!); }
        if (ownerLink(row)) add(owner, row.relatedSha256!);
      }
    }
    const inBranch = (row: MobileCapabilityTraceRecord): boolean => row.component === 'main' ? main.has(row.requestSha256)
      : row.component === 'core' ? core.has(row.requestSha256) : owner.has(row.requestSha256);
    const branch = rows.filter(inBranch);
    const first = new Set([...captured.firstBusinessFailures, ...captured.cleanupFailures].map(key));
    const links = new Set<string>(), seenEdges = new Set<string>();
    for (const row of branch) {
      const edge = row.component === 'main' && row.parentSha256 !== null && main.has(row.parentSha256)
        ? `parent:${row.requestSha256}:${row.parentSha256}` : initializeLink(row)
          ? `initialize:${row.component}:${row.requestSha256}:${row.relatedSha256}` : ownerLink(row)
            ? `owner:${row.requestSha256}:${row.relatedSha256}` : null;
      if (edge && !seenEdges.has(edge)) { seenEdges.add(edge); links.add(key(row)); }
    }
    const latest = new Map<string, { row: MobileCapabilityTraceRecord; index: number }>();
    // 只用原环的发生顺序归并阶段；去重和首错补表不能把较早终态变成最后一次调用。
    for (let index = 0; index < captured.records.length; index++) {
      const row = captured.records[index]!; if (!inBranch(row)) continue;
      const stage = JSON.stringify([row.component, row.requestSha256, row.stage, row.role]), previous = latest.get(stage);
      if (!previous || row.elapsedMs >= previous.row.elapsedMs) latest.set(stage, { row, index });
    }
    const unfinished = new Set([...latest.values()].filter(value => value.row.phase === 'begin').map(value => key(value.row)));
    const pendingByRequest = new Map<string, { row: MobileCapabilityTraceRecord; index: number }>();
    for (const { row, index } of latest.values()) {
      if (row.phase !== 'begin') continue;
      const request = JSON.stringify([row.component, row.requestSha256, row.role]), previous = pendingByRequest.get(request);
      // 只比较同进程、同请求的原elapsed；毫秒相同时用该collector的原记录顺序。
      // 这表示最后观察到的未落定阶段，不将缺失settle推断为资源死锁。
      if (!previous || row.elapsedMs > previous.row.elapsedMs || row.elapsedMs === previous.row.elapsedMs && index > previous.index) {
        pendingByRequest.set(request, { row, index });
      }
    }
    const pendingHeads = new Set([...pendingByRequest.values()].map(value => key(value.row)));
    const priority = (row: MobileCapabilityTraceRecord): number => mode === 'close'
      && row.component === 'main' && row.stage.startsWith('main.close.') ? row.phase === 'reject' ? 0 : 1
      : first.has(key(row)) ? 2 : links.has(key(row)) ? 3 : pendingHeads.has(key(row)) ? 4
        : row.phase === 'reject' ? 5 : unfinished.has(key(row)) ? 6 : 7;
    const ordered = branch.map((row, index) => ({ row, index, priority: priority(row) }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index);
    return Object.freeze({ records: Object.freeze(ordered.slice(0, 64).map(value => value.row)),
      omittedRecords: Math.max(0, ordered.length - 64), sourceDroppedRecords: captured.droppedRecords });
  } catch { return empty(); }
}
export function selectMobileCapabilityTraceBranch(snapshot: unknown, rootSha256: string,
  mode: 'http' | 'close' = 'http'): readonly MobileCapabilityTraceRecord[] {
  return selectMobileCapabilityTraceBranchDetails(snapshot, rootSha256, mode).records;
}
/** 每个原child独立保半行；不转发其他stdout，过长行丢到下一换行，不保无界缓存。 */
export function createMobileCapabilityTraceReader(accept: (record: MobileCapabilityTraceRecord) => void): (chunk: string) => void {
  let partial = '', discarding = false;
  return chunk => {
    try {
      if (typeof chunk !== 'string' || chunk.length > 1024 * 1024) { partial = ''; discarding = true; return; }
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf('\n', offset), end = newline < 0 ? chunk.length : newline, segment = chunk.slice(offset, end);
        if (!discarding) {
          if (Buffer.byteLength(partial) + Buffer.byteLength(segment) > 4096) { partial = ''; discarding = true; }
          else partial += segment;
        }
        if (newline < 0) return;
        if (!discarding && partial.startsWith(MOBILE_CAPABILITY_TRACE_PREFIX)) {
          try {
            const raw: unknown = JSON.parse(partial.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)), record = copyMobileCapabilityTraceRecord(raw);
            if (record) { try { accept(record); } catch { /* 诊断接收失败不影响原stdout和业务。 */ } }
          } catch { /* 单行损坏只丢本行，同chunk后续闭集记录继续读取。 */ }
        }
        partial = ''; discarding = false; offset = newline + 1;
      }
    } catch { partial = ''; discarding = false; }
  };
}
const processCollector = createMobileCapabilityTraceCollector();
export function collectMobileCapabilityTrace(raw: unknown): void { try { processCollector.record(raw); } catch { /* 私有旁注不影响原请求。 */ } }
export const snapshotMobileCapabilityTrace = (): MobileCapabilityTraceSnapshot => processCollector.snapshot();
export interface MobileCapabilityContext {
  readonly requestSha256: string; readonly parentSha256: string | null; readonly component: MobileCapabilityComponent;
  readonly startedAtMs: number; readonly signal?: AbortSignal; readonly sink: (line: string) => void;
  records: number; closed: boolean; firstBusiness: boolean; firstCleanup: boolean;
  /** 仅私有HTTP探针使用；总量仍64，给HTTP终态留下16槽。成功feed的旁注不入全局环。 */
  httpTerminalReserve?: boolean; deferredRecords?: MobileCapabilityTraceRecord[];
  /** 仅可信私有诊断组合根设置，不序列化到HTTP或RPC。 */
  privateContentDiagnostic?: true;
  preparation?: boolean; droppedRecords?: number; clockFault?: boolean;
  preparationLimit?: 64 | 192 | 512;
  resourcePreparation?: true;
  trackPreparation?: true;
  preparationIntentSha256?: string;
  lastAtMs?: number;
  pendingOperations?: number; closeRequested?: boolean;
  now?: () => number; epochNow?: () => number;
}
const storage = new AsyncLocalStorage<MobileCapabilityContext>();
const sourcePreparationStages = new Set<MobileCapabilityStage>([
  'provider.source.prepare.scope', 'provider.source.prepare.catalog', 'provider.source.prepare.current',
  'provider.source.prepare.open', 'provider.source.prepare.capture-lease', 'provider.source.prepare.verify-before',
  'provider.source.prepare.audio-read', 'provider.source.prepare.audio-close', 'provider.source.prepare.verify-after',
  'provider.source.prepare.ready-current', 'provider.source.prepare.replay',
]);
// 只由下方真实Source步骤登记；不序列化、不新增请求身份，也不改变原64条总预算。
const sourcePreparationDiagnostics = new WeakMap<MobileCapabilityContext, { accountCalls: number; omitted: boolean }>();
function sourcePreparationOmitted(context: MobileCapabilityContext): void {
  try {
    const budget = sourcePreparationDiagnostics.get(context);
    if (!budget || budget.omitted || context.closed) return;
    budget.omitted = true;
    context.droppedRecords = (context.droppedRecords ?? 0) + 1;
    withMobileCapabilityContext(context, () => emit('provider.source.prepare.trace-truncated', 'cache'));
  } catch { /* 诊断旁注失败不能阻止原授权或清理。 */ }
}
export const captureMobileCapabilityContext = (): MobileCapabilityContext | undefined => storage.getStore();
/** ID只来自原受控信封；分域散列不包含身份/账号/路径，也不生成新nonce。 */
export function mobileCapabilityRequestSha(kind: MobileCapabilityIdKind, id: string): string | null {
  try { return choice(kind, ['http', 'content', 'owner']) && typeof id === 'string' && uuid.test(id)
    ? createHash('sha256').update(`MusicBridge:capability:${kind}:1\0${id}`, 'utf8').digest('hex') : null; }
  catch { return null; }
}
export function createMobileCapabilityContext(id: string, component: MobileCapabilityComponent, kind: MobileCapabilityIdKind,
  parentSha256: string | null = storage.getStore()?.requestSha256 ?? null, signal?: AbortSignal,
  sink: (line: string) => void = line => { writeSync(1, line); },
  clock?: { now?: () => number; epochNow?: () => number }): MobileCapabilityContext | undefined {
  try {
    const requestSha256 = mobileCapabilityRequestSha(kind, id);
    if (!requestSha256 || !choice(component, ['main', 'core', 'owner']) || !nullableSha(parentSha256)) return undefined;
    const startedAtMs = clock?.now ? clock.now() : performance.now();
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0) return undefined;
    return { requestSha256, parentSha256, component, startedAtMs, ...(signal ? { signal } : {}), sink,
      ...(clock?.now ? { now: clock.now } : {}), ...(clock?.epochNow ? { epochNow: clock.epochNow } : {}),
      records: 0, closed: false, firstBusiness: false, firstCleanup: false };
  } catch { return undefined; }
}
/** 即使ALS本身失败，原工作最多执行一次；已有原返回/异常不被诊断重放替换。 */
export function withMobileCapabilityContext<T>(context: MobileCapabilityContext | undefined, work: () => T): T {
  if (!context) return work();
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const once = (): T => {
    if (result) { if (result.ok) return result.value; throw result.error; }
    try { const value = work(); result = { ok: true, value }; return value; }
    catch (error) { result = { ok: false, error }; throw error; }
  };
  try { return storage.run(context, once); } catch { return once(); }
}
function own(error: unknown, key: string): unknown {
  try {
    if (!error || typeof error !== 'object' || types.isProxy(error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function emit(stage: MobileCapabilityStage, phase: MobileCapabilityTraceRecord['phase'], role: MobileCapabilityRole = 'business', error?: unknown,
  relatedSha256: string | null = null, initState: MobileCapabilityInitState = 'none'): void {
  try {
    const context = storage.getStore(); if (!context || context.closed && role !== 'cleanup') return;
    const first = phase === 'reject' && (role === 'business' ? !context.firstBusiness : !context.firstCleanup);
    // 准备链保留原多次认证的完整顺序；两种旁注均为首拒预留四槽。
    const originalMaximum = context.preparationLimit ?? 64;
    const linkedPreparation = context.resourcePreparation === true || context.trackPreparation === true;
    const resourceTerminal = linkedPreparation
      && (stage === 'preparation.http.terminal' || stage === 'http.send' || stage.startsWith('http.status.'));
    const maximum = context.httpTerminalReserve && !stage.startsWith('http.') ? Math.min(48, originalMaximum)
      : linkedPreparation && !resourceTerminal && !first && !(phase === 'reject' && role === 'cleanup')
        ? Math.min(context.resourcePreparation === true ? MOBILE_PREPARATION_EVIDENCE_LIMITS.resourceNormalRecords : 176, originalMaximum) : originalMaximum;
    const sourcePriority = sourcePreparationStages.has(stage) || stage === 'provider.source.prepare.trace-truncated'
      || stage === 'core.provider.read' && phase !== 'begin' || stage === 'core.dispatch.reply.capture';
    // Source子链保留高价值步骤及父层落定空间；首业务/清理拒绝仍走原独立预留。
    if (sourcePreparationDiagnostics.has(context) && !sourcePriority && !first && phase !== 'reject' && context.records >= 32) {
      sourcePreparationOmitted(context); return;
    }
    if (context.records >= maximum || context.records >= maximum - 4 && !first && !resourceTerminal && !(phase === 'reject' && role === 'cleanup')) {
      if (context.preparation) context.droppedRecords = (context.droppedRecords ?? 0) + 1;
      return;
    }
    const code = own(error, 'code'), name = own(error, 'name'), outcome = own(error, 'outcome');
    let at: number, epoch: number;
    try {
      at = context.now ? context.now() : performance.now(); epoch = context.epochNow ? context.epochNow() : Date.now();
      if (!Number.isFinite(at) || at < (context.lastAtMs ?? context.startedAtMs) || !integer(epoch)) throw new Error();
      context.lastAtMs = at;
    } catch {
      if (context.preparation) { context.clockFault = true; context.droppedRecords = (context.droppedRecords ?? 0) + 1; }
      return;
    }
    const record = copyMobileCapabilityTraceRecord({ schema: MOBILE_CAPABILITY_TRACE_SCHEMA, component: context.component,
      requestSha256: context.requestSha256, parentSha256: context.parentSha256,
      relatedSha256: relatedSha256 ?? context.preparationIntentSha256 ?? null,
      epochMs: epoch, elapsedMs: Math.floor(at - context.startedAtMs), stage, phase, role,
      name: choice(name, names) ? name : 'UNKNOWN', code: phase !== 'reject' ? 'OK' : choice(code, codes) ? code : 'UNKNOWN',
      outcome: choice(outcome, ['not-sent', 'unknown']) ? outcome : null,
      aborted: context.signal ? context.signal.aborted : null, initState });
    if (!record) return;
    if (phase === 'reject') { if (role === 'business') context.firstBusiness = true; else context.firstCleanup = true; }
    context.records++;
    if (context.deferredRecords) { if (context.deferredRecords.length < 64) context.deferredRecords.push(record); return; }
    collectMobileCapabilityTrace(record);
    const line = MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) <= 4096) context.sink(line);
  } catch { /* 白名单提取、sink或计时失败都不能替换原返回/异常，不能读取私密异常正文。 */ }
}
/** 红心全量分页最多512次，其余类八次；只保首个代表成功和首个失败，成功不消耗失败槽。 */
export function createMobileContentSampleSelector() {
  const names = { getUIContentCapabilities: 'ui', getArtwork: 'artwork', listTracks: 'tracks', getNeteaseDailyRecommendations: 'daily',
    listNeteaseRecommendedPlaylists: 'recommended', listNeteaseNewAlbums: 'albums', listNeteaseCharts: 'charts', getNeteasePersonalFM: 'fm',
    getNeteaseLikedPlaylist: 'liked', listNeteaseLikedPlaylistTracks: 'liked-tracks', listPersonalPlaylists: 'playlists',
    listPersonalPlaylistTracks: 'playlist-tracks', listFavoriteAlbums: 'favorites',
    getNeteaseDiscoveryCollectionTracks: 'collection-tracks' } as const;
  const states = new Map<string, { attempts: number; completed: number; success: boolean; failure: boolean; exhausted: boolean }>();
  return { claim(operation: string) {
    if (!Object.hasOwn(names, operation)) return undefined;
    const name = names[operation as keyof typeof names];
    const state = states.get(name) ?? { attempts: 0, completed: 0, success: false, failure: false, exhausted: false };
    states.set(name, state);
    const maximumAttempts = operation === 'listNeteaseLikedPlaylistTracks' ? 512 : 8;
    if (state.attempts >= maximumAttempts || state.success && state.failure) return undefined;
    state.attempts++; let settled = false;
    return { finish(context: MobileCapabilityContext | undefined, status: number | undefined, failed: boolean, finished: boolean): void {
      if (settled) return; settled = true; state.completed++;
      const isFailure = failed || !finished || status !== 200 || context?.firstBusiness === true;
      const publish = isFailure ? !state.failure : !state.success;
      if (isFailure) state.failure = true; else state.success = true;
      const unknown = state.completed >= maximumAttempts && !state.failure && !state.exhausted;
      if (unknown) state.exhausted = true;
      const value = typeof status === 'number' && [200,400,401,403,404,409,410,413,429,503].includes(status) ? status : 'not-sent';
      publishMobileDiscoveryFailure(context, `http.discovery.${name}.${value}` as MobileDiscoveryFailureStage, publish, isFailure,
        unknown ? `http.discovery.${name}.failure-unknown` : undefined);
    } };
  } };
}
/** 发布时仍不超过原64条，保原首错及HTTP末段；未捕获失败明确为UNKNOWN。 */
export function publishMobileDiscoveryFailure(context: MobileCapabilityContext | undefined, stage: MobileDiscoveryFailureStage,
  publish = true, failed = true, unknownStage?: MobileDiscoveryFailureStage): void {
  try {
    if (!context?.deferredRecords) return;
    const rows = context.deferredRecords; delete context.deferredRecords;
    const first = rows.find(row => row.phase === 'reject' && row.role === 'business');
    const representative = failed ? first ?? rows.at(-1) : rows.at(-1);
    if (!representative) return;
    const summary = publish ? copyMobileCapabilityTraceRecord({ ...representative, stage,
      ...(failed && !first ? { phase: 'reject', code: 'UNKNOWN', outcome: 'unknown' } : {}) }) : null;
    const unknown = unknownStage ? copyMobileCapabilityTraceRecord({ ...representative, stage: unknownStage, phase: 'cache', code: 'UNKNOWN', outcome: 'unknown' }) : null;
    const prefix = [...(summary ? [summary] : []), ...(unknown ? [unknown] : []), ...(publish && first ? [first] : [])];
    if (!prefix.length) return;
    const output = [...prefix, ...(publish ? rows.slice(-(64 - prefix.length)) : [])];
    for (const raw of output) {
      const row = copyMobileCapabilityTraceRecord(raw); if (!row) continue;
      collectMobileCapabilityTrace(row); const line = MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line) <= 4096) { try { context.sink(line); } catch { /* 旁注不改变原请求。 */ } }
    }
  } catch { /* 发布/校验失败不替换原异常，也不重演HTTP请求。 */ }
}
export function mobileCapabilityReject(stage: MobileCapabilityStage, error: unknown, role: MobileCapabilityRole = 'business'): void { emit(stage, 'reject', role, error); }
/** 旁观不替换同步值、原生Promise或异常；任意thenable不会被读取或同化，诊断失败也不重放work。 */
export function observeMobileCapabilityTrace<T>(stage: MobileCapabilityStage, work: () => T, role: MobileCapabilityRole = 'business'): T {
  let context: MobileCapabilityContext | undefined;
  try { context = storage.getStore(); } catch { /* 缺失诊断上下文时直接执行原工作。 */ }
  if (!context) return work();
  const note = (phase: 'begin' | 'ok' | 'reject', error?: unknown): void => {
    try { withMobileCapabilityContext(context, () => emit(stage, phase, role, error)); } catch { /* 旁注不改变原结果。 */ }
  };
  note('begin');
  let value: T;
  try { value = work(); } catch (error) { note('reject', error); throw error; }
  try {
    if (types.isPromise(value)) {
      try {
        const observed = Promise.prototype.then.call(value, () => note('ok'), (error: unknown) => note('reject', error));
        if (types.isPromise(observed)) Promise.prototype.then.call(observed, () => undefined, () => undefined);
      } catch { /* 无法旁观时不读取then、不重发工作，也不假报完成。 */ }
      return value;
    }
  } catch { return value; }
  note('ok'); return value;
}
/** 仅获准Source.prepare的闭集步骤成功计时；原分类首拒与Proxy异常规则保留。 */
export function observeMobileSourcePreparationTrace<T>(stage: MobileCapabilityStage, work: () => T): T {
  let context: MobileCapabilityContext | undefined;
  let enabled = false;
  try {
    context = storage.getStore();
    if (context && context.component === 'core' && context.privateContentDiagnostic === true && !context.closed
      && !context.firstBusiness && sourcePreparationStages.has(stage)) {
      if (!sourcePreparationDiagnostics.has(context)) sourcePreparationDiagnostics.set(context, { accountCalls: 0, omitted: false });
      enabled = true;
    }
  } catch { /* 无法建立旁注时直接执行原工作一次。 */ }
  if (!enabled || !context) return work();
  const captured = context;
  const note = (phase: 'begin' | 'ok' | 'reject', error?: unknown): void => {
    try {
      // 既有Source分类器已记首拒时不重复覆盖；不读取Proxy错误属性。
      if (phase === 'reject' && (captured.firstBusiness || types.isProxy(error))) return;
      withMobileCapabilityContext(captured, () => emit(stage, phase, 'business', error));
    } catch { /* 旁注不能替换原工作、返回或异常。 */ }
  };
  note('begin');
  let value: T;
  try { value = work(); } catch (error) { note('reject', error); throw error; }
  if (types.isPromise(value)) {
    try {
      const observed = Promise.prototype.then.call(value, () => note('ok'), (error: unknown) => note('reject', error));
      if (types.isPromise(observed)) Promise.prototype.then.call(observed, () => undefined, () => undefined);
    } catch { /* 旁观失败不读then、不重发原工作。 */ }
    return value;
  }
  note('ok'); return value;
}
/** 新内容旁注必须同时有可信开关所建上下文；缺省直接执行原工作一次。 */
function privateContentDiagnosticEnabled(): boolean {
  try { return storage.getStore()?.privateContentDiagnostic === true; } catch { return false; }
}
export function mobileContentDiagnosticSync<T>(stage: MobileCapabilityStage, work: () => T): T {
  return privateContentDiagnosticEnabled() ? mobileCapabilitySync(stage, work) : work();
}
export function mobileContentDiagnosticAsync<T>(stage: MobileCapabilityStage, work: () => Promise<T>): Promise<T> {
  return privateContentDiagnosticEnabled() ? mobileCapabilityAsync(stage, work) : work();
}
export function mobileContentDiagnosticReject(stage: MobileCapabilityStage, error: unknown): void {
  if (privateContentDiagnosticEnabled()) mobileCapabilityReject(stage, error);
}
/** 仅在已有私有请求上下文记录合同枚举；未知值不转换、不读取正文或身份。 */
export function noteMobileUIFeature(feature: unknown, state: unknown): void {
  if (!choice(feature, uiFeatureNames) || !choice(state, uiFeatureStates)) return;
  emit(`http.ui.feature.${feature}.${state}`, 'cache');
}
export function mobileCapabilitySync<T>(stage: MobileCapabilityStage, work: () => T, role: MobileCapabilityRole = 'business'): T {
  emit(stage, 'begin', role);
  try { const value = work(); emit(stage, 'ok', role); return value; }
  catch (error) { mobileCapabilityReject(stage, error, role); throw error; }
}
export async function mobileCapabilityAsync<T>(stage: MobileCapabilityStage, work: () => Promise<T>, role: MobileCapabilityRole = 'business'): Promise<T> {
  let context: MobileCapabilityContext | undefined, source: { accountCalls: number; omitted: boolean } | undefined;
  try {
    context = stage === 'core.assert.account' && role === 'business' ? storage.getStore() : undefined;
    source = context && !context.closed ? sourcePreparationDiagnostics.get(context) : undefined;
  } catch { /* 旁注状态异常仍执行原授权。 */ }
  if (source && source.accountCalls++ >= 4) {
    sourcePreparationOmitted(context!);
    try { return await work(); }
    catch (error) { mobileCapabilityReject(stage, error, role); throw error; }
  }
  emit(stage, 'begin', role);
  try { const value = await work(); emit(stage, 'ok', role); return value; }
  catch (error) { mobileCapabilityReject(stage, error, role); throw error; }
}
export function mobileCapabilityCache(stage: MobileCapabilityStage, state: MobileCapabilityInitState, relatedSha256: string | null): void {
  emit(stage, 'cache', 'business', undefined, relatedSha256, state);
}
export function mobileCapabilityLink(kind: MobileCapabilityIdKind, id: string, stage: MobileCapabilityStage): string | null {
  const hash = mobileCapabilityRequestSha(kind, id); if (hash) emit(stage, 'link', 'business', undefined, hash); return hash;
}
export function closeMobileCapabilityContext(context: MobileCapabilityContext | undefined): void {
  if (!context) return;
  if (context.preparation && (context.pendingOperations ?? 0) > 0) context.closeRequested = true;
  else context.closed = true;
}

/** 新旁注只在获准的准备窗口工作；普通能力诊断及默认构建保留原调用。 */
function preparationContext(): MobileCapabilityContext | undefined {
  try { const context = storage.getStore(); return context?.preparation && !context.closed ? context : undefined; }
  catch { return undefined; }
}
/** 原后台timer仅脱离准备旁注；普通能力上下文及原work执行次数不变。 */
export function withoutMobilePreparationContext<T>(work: () => T): T {
  let preparation = false;
  try { preparation = storage.getStore()?.preparation === true; } catch { /* 无诊断上下文时执行原work。 */ }
  if (!preparation) return work();
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const once = (): T => {
    if (result) { if (result.ok) return result.value; throw result.error; }
    try { const value = work(); result = { ok: true, value }; return value; }
    catch (error) { result = { ok: false, error }; throw error; }
  };
  try { return storage.exit(once); } catch { return once(); }
}
export function mobilePreparationSync<T>(stage: MobileCapabilityStage, work: () => T): T {
  return preparationContext() ? mobileCapabilitySync(stage, work) : work();
}
export function mobilePreparationAsync<T>(stage: MobileCapabilityStage, work: () => Promise<T>): Promise<T> {
  const context = preparationContext(); if (!context) return work();
  context.pendingOperations = (context.pendingOperations ?? 0) + 1;
  const settled = () => {
    context.pendingOperations = (context.pendingOperations ?? 1) - 1;
    if (context.closeRequested && context.pendingOperations === 0) context.closed = true;
  };
  return mobileCapabilityAsync(stage, work).then(value => { settled(); return value; }, error => { settled(); throw error; });
}

export const MOBILE_PREPARATION_EVIDENCE_LIMITS = Object.freeze({ resourceRecords: 512, resourceNormalRecords: 496,
  identityRecords: 64, sessionRecords: 192, trackRecords: 192, children: 16, serializedBytes: 4 * 1024 * 1024 });
const RESOURCE_PREPARATION_CHILDREN = MOBILE_PREPARATION_EVIDENCE_LIMITS.children;
/** HTTP槽只沿实际Main child边、同content请求Core记录及明确Owner边收集；不查询全局环。 */
function createResourcePreparationCollector(rootSha256: string, maximumRecords: 192 | 512) {
  const main = new Set([rootSha256]), core = new Set<string>(), owner = new Set<string>();
  const parents = new Map<string, string>();
  const records: MobileCapabilityTraceRecord[] = [], protectedRows = new Set<MobileCapabilityTraceRecord>();
  const first = new Map<string, MobileCapabilityTraceRecord>(), cleanup = new Map<string, MobileCapabilityTraceRecord>();
  const edges = new Set<string>();
  let droppedRecords = 0;
  const drop = (): void => { droppedRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedRecords + 1); };
  const add = (set: Set<string>, value: string, maximum: number): boolean => {
    if (set.has(value)) return true;
    if (set.size >= maximum) { drop(); return false; }
    set.add(value); return true;
  };
  return {
    record(raw: unknown): void {
      const row = copyMobileCapabilityTraceRecord(raw); if (!row) { drop(); return; }
      // 关联边与首错只在该记录实际入槽后发布；极限丢弃不能留下没有证据的幽灵父链。
      const nextMain = new Set(main), nextCore = new Set(core), nextOwner = new Set(owner);
      let parent: string | null = null;
      let edge: string | null = null;
      if (row.component === 'main') {
        if (row.requestSha256 === rootSha256) { if (row.parentSha256 !== null) { drop(); return; } }
        else if (row.parentSha256 !== null && main.has(row.parentSha256)) {
          if (parents.has(row.requestSha256) && parents.get(row.requestSha256) !== row.parentSha256) { drop(); return; }
          if (!add(nextMain, row.requestSha256, RESOURCE_PREPARATION_CHILDREN + 1)
            || !add(nextCore, row.requestSha256, RESOURCE_PREPARATION_CHILDREN)) return;
          parent = row.parentSha256;
          edge = `main:${row.requestSha256}:${row.parentSha256}`;
        } else return;
      } else if (row.component === 'core') { if (!core.has(row.requestSha256) || row.parentSha256 !== null) return; }
      else if (!owner.has(row.requestSha256) || row.parentSha256 !== null) return;
      if (row.relatedSha256 !== null) {
        if (row.phase === 'cache' && row.initState !== 'none'
          && (row.component === 'main' && row.stage === 'content.initialize.cache'
            || row.component === 'core' && row.stage === 'core.rpc.initialize.cache')) {
          if (!add(nextMain, row.relatedSha256, RESOURCE_PREPARATION_CHILDREN + 1)
            || !add(nextCore, row.relatedSha256, RESOURCE_PREPARATION_CHILDREN)) return;
          edge = `initialize:${row.component}:${row.relatedSha256}`;
        } else if (row.component === 'core' && row.stage === 'owner.rpc.link' && row.phase === 'link') {
          if (!add(nextOwner, row.relatedSha256, RESOURCE_PREPARATION_CHILDREN)) return;
          edge = `owner:${row.relatedSha256}`;
        } else { drop(); return; }
      }
      const failures = row.role === 'business' ? first : cleanup;
      const failureKey = `${row.component}:${row.requestSha256}${row.role === 'cleanup' ? ':' + row.stage : ''}`;
      const newFailure = row.phase === 'reject' && !failures.has(failureKey);
      const newEdge = edge !== null && !edges.has(edge);
      const protect = newFailure || newEdge || row.component === 'main' && row.requestSha256 === rootSha256
        && (row.stage === 'preparation.http.terminal' || row.stage === 'http.send' || row.stage.startsWith('http.status.'));
      if (records.length >= maximumRecords) {
        drop(); if (!protect) return;
        const index = records.findIndex(value => !protectedRows.has(value)); if (index < 0) return;
        records.splice(index, 1);
      }
      records.push(row); if (protect) protectedRows.add(row);
      if (row.stage === 'provider.source.prepare.trace-truncated' && row.phase === 'cache') drop();
      for (const hash of nextMain) main.add(hash);
      for (const hash of nextCore) core.add(hash);
      for (const hash of nextOwner) owner.add(hash);
      if (parent !== null) parents.set(row.requestSha256, parent);
      if (newEdge) edges.add(edge!);
      if (newFailure) { if (failures.size >= 64) drop(); else failures.set(failureKey, row); }
    },
    snapshot(): MobileCapabilityTraceSnapshot {
      return { schema: MOBILE_CAPABILITY_TRACE_SCHEMA, records: records.map(row => ({ ...row })),
        firstBusinessFailures: [...first.values()].map(row => ({ ...row })),
        cleanupFailures: [...cleanup.values()].map(row => ({ ...row })), droppedRecords };
    },
  };
}
/** 闭集导出重新验证整条显式父链；Owner同SHA、任意related及时间接近都不算关联。 */
function validResourcePreparationTrace(trace: MobileCapabilityTraceSnapshot, rootSha256: string, maximumRecords: number): boolean {
  if (trace.records.length > maximumRecords) return false;
  const rows = [...trace.records, ...trace.firstBusinessFailures, ...trace.cleanupFailures];
  const keys = new Set(trace.records.map(row => JSON.stringify(row)));
  if ([...trace.firstBusinessFailures, ...trace.cleanupFailures].some(row => !keys.has(JSON.stringify(row)))) return false;
  const parents = new Map<string, string>();
  for (const row of rows) if (row.component === 'main' && row.requestSha256 !== rootSha256 && row.parentSha256 !== null) {
    if (parents.has(row.requestSha256) && parents.get(row.requestSha256) !== row.parentSha256) return false;
    parents.set(row.requestSha256, row.parentSha256);
  }
  const main = new Set([rootSha256]), core = new Set<string>(), owner = new Set<string>();
  let changed = true;
  const add = (set: Set<string>, value: string): void => { if (!set.has(value)) { set.add(value); changed = true; } };
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.component === 'main' && row.parentSha256 !== null && main.has(row.parentSha256)) {
        add(main, row.requestSha256); add(core, row.requestSha256);
      }
      const linked = row.component === 'main' ? main.has(row.requestSha256)
        : row.component === 'core' ? core.has(row.requestSha256) : owner.has(row.requestSha256);
      if (!linked || row.relatedSha256 === null) continue;
      if (row.phase === 'cache' && row.initState !== 'none'
        && (row.component === 'main' && row.stage === 'content.initialize.cache'
          || row.component === 'core' && row.stage === 'core.rpc.initialize.cache')) {
        add(main, row.relatedSha256); add(core, row.relatedSha256);
      } else if (row.component === 'core' && row.stage === 'owner.rpc.link' && row.phase === 'link') add(owner, row.relatedSha256);
    }
    if (main.size > RESOURCE_PREPARATION_CHILDREN + 1 || core.size > RESOURCE_PREPARATION_CHILDREN || owner.size > RESOURCE_PREPARATION_CHILDREN) return false;
  }
  return rows.every(row => {
    if (row.relatedSha256 !== null && !(row.phase === 'cache' && row.initState !== 'none'
      && (row.component === 'main' && row.stage === 'content.initialize.cache'
        || row.component === 'core' && row.stage === 'core.rpc.initialize.cache'))
      && !(row.component === 'core' && row.stage === 'owner.rpc.link' && row.phase === 'link')) return false;
    return row.component === 'main' ? row.requestSha256 === rootSha256 ? row.parentSha256 === null
      : row.parentSha256 !== null && main.has(row.parentSha256) && main.has(row.requestSha256)
      : row.parentSha256 === null && (row.component === 'core' ? core : owner).has(row.requestSha256);
  });
}
function resourcePreparationWorkPending(trace: MobileCapabilityTraceSnapshot): boolean {
  const latest = new Map<string, MobileCapabilityTraceRecord>();
  for (const row of trace.records) {
    const key = `${row.component}:${row.requestSha256}:${row.role}:${row.stage}`, previous = latest.get(key);
    if (!previous || row.elapsedMs >= previous.elapsedMs) latest.set(key, row);
  }
  return [...latest.values()].some(row => row.phase === 'begin');
}
const PREPARATION_SCHEMA = 'mb.mobile-preparation-evidence.v3' as const;
type PreparationOperation = 'getServer' | 'createSession';
interface PreparationScope {
  operation: PreparationOperation | 'createResource' | 'getTrack'; requestSha256: string; intentSha256: string | null;
  terminal: 'pending' | 'ok' | 'reject' | 'incomplete' | 'intermediate';
  httpStatus: number | null; responseFinished: boolean; clockFault: boolean; workPending: boolean; trace: MobileCapabilityTraceSnapshot;
}
export interface MobilePreparationSnapshot {
  schema: typeof PREPARATION_SCHEMA; armed: boolean; identityClaims: number; identityDropped: number;
  identitiesStopped: boolean; sessionClaimed: boolean; sessionClaims: number; sessionDropped: number; sessionIntentSha256: string | null;
  discardedScopes: number; contextFaults: number; truncated: boolean; scopes: PreparationScope[];
  resourceClaims: number; resourceDropped: number; resourceContextFaults: number; resourceScopes: PreparationScope[];
  trackClaims: number; trackDropped: number; trackContextFaults: number; trackScopes: PreparationScope[];
}
export interface MobilePreparationProbe {
  arm(): void;
  claim(operation: string, requestId: string, signal: AbortSignal): MobileCapabilityContext | undefined;
  associateSession(context: MobileCapabilityContext | undefined, key: unknown): void;
  /** 只由当前Core child的既有闭集reader供给；不接公共IPC或原始stdout。 */
  acceptCoreTrace(record: MobileCapabilityTraceRecord): void;
  finish(context: MobileCapabilityContext | undefined, result: { failed: boolean; finished: boolean; httpStatus: number | null }): void;
  snapshot(): MobilePreparationSnapshot;
}
/** 八个原身份确认及同一会话意图最多两次原HTTP；401刷新重放不生成新业务。 */
export function createMobilePreparationProbe(options: {
  enabled?: boolean; now?: () => number; epochNow?: () => number; sink?: (record: Readonly<MobileCapabilityTraceRecord>) => void;
} = {}): MobilePreparationProbe {
  let armed = false, identityClaims = 0, identityDropped = 0, identitiesStopped = false, sessionClaims = 0, contextFaults = 0;
  let sessionDropped = 0, sessionIntentSha256: string | null = null, discardedScopes = 0, sessionStopped = false, retryEligible = false;
  let resourceClaims = 0, resourceDropped = 0, resourceContextFaults = 0;
  let trackClaims = 0, trackDropped = 0, trackContextFaults = 0;
  const scopes = new Map<MobileCapabilityContext, { scope: PreparationScope; collector: ReturnType<typeof createMobileCapabilityTraceCollector> }>();
  return {
    arm() { try { if (options.enabled === true) armed = true; } catch { /* 诊断选项不影响原回包。 */ } },
    claim(operation, requestId, signal) {
      let resourceAdmitted = false, trackAdmitted = false;
      try {
        if (options.enabled !== true || !armed || operation !== 'getServer' && operation !== 'createSession'
          && operation !== 'createResource' && operation !== 'getTrack') return undefined;
        if (operation === 'getServer') {
          if (identitiesStopped || identityClaims >= 8) { identityDropped = Math.min(Number.MAX_SAFE_INTEGER, identityDropped + 1); return undefined; }
          identityClaims++;
        } else if (operation === 'createSession') {
          if (sessionStopped || sessionClaims >= 2 || sessionClaims === 1 && !retryEligible) {
            sessionDropped = Math.min(Number.MAX_SAFE_INTEGER, sessionDropped + 1); return undefined;
          }
          sessionClaims++; retryEligible = false;
        } else if (operation === 'getTrack') {
          const hash = mobileCapabilityRequestSha('http', requestId);
          if (trackClaims >= 2 || hash !== null && [...scopes.values()].some(entry => entry.scope.requestSha256 === hash)) {
            trackDropped = Math.min(Number.MAX_SAFE_INTEGER, trackDropped + 1); return undefined;
          }
          trackClaims++; trackAdmitted = true;
        } else {
          const hash = mobileCapabilityRequestSha('http', requestId);
          if (resourceClaims >= 2 || hash !== null && [...scopes.values()].some(entry => entry.scope.requestSha256 === hash)) {
            resourceDropped = Math.min(Number.MAX_SAFE_INTEGER, resourceDropped + 1); return undefined;
          }
          resourceClaims++; resourceAdmitted = true;
        }
        let collector = createMobileCapabilityTraceCollector();
        const reader = createMobileCapabilityTraceReader(record => { collector.record(record); options.sink?.(record); });
        const context = createMobileCapabilityContext(requestId, 'main', 'http', null, signal, reader, options);
        if (!context) {
          if (operation === 'createResource') resourceContextFaults++; else if (operation === 'getTrack') trackContextFaults++; else contextFaults++;
          return undefined;
        }
        if (operation === 'createResource' || operation === 'getTrack') collector = createResourcePreparationCollector(context.requestSha256,
          operation === 'createResource' ? MOBILE_PREPARATION_EVIDENCE_LIMITS.resourceRecords : MOBILE_PREPARATION_EVIDENCE_LIMITS.trackRecords);
        context.preparation = true; context.preparationLimit = operation === 'getServer' ? 64
          : operation === 'createResource' ? MOBILE_PREPARATION_EVIDENCE_LIMITS.resourceRecords : 192;
        if (operation === 'createResource') { context.privateContentDiagnostic = true; context.resourcePreparation = true; }
        if (operation === 'getTrack') { context.privateContentDiagnostic = true; context.trackPreparation = true; }
        context.droppedRecords = 0; context.clockFault = false;
        scopes.set(context, { collector, scope: { operation, requestSha256: context.requestSha256, intentSha256: null, terminal: 'pending',
          httpStatus: null, responseFinished: false, clockFault: false, workPending: false, trace: collector.snapshot() } });
        return context;
      } catch {
        if (operation === 'createResource') { if (resourceAdmitted) resourceContextFaults = Math.min(2, resourceContextFaults + 1); }
        else if (operation === 'getTrack') { if (trackAdmitted) trackContextFaults = Math.min(2, trackContextFaults + 1); }
        else contextFaults = Math.min(10, contextFaults + 1);
        return undefined;
      }
    },
    acceptCoreTrace(raw) {
      try {
        const record = copyMobileCapabilityTraceRecord(raw); if (!record || record.component === 'main') return;
        for (const { scope, collector } of scopes.values()) if (scope.operation === 'createResource' || scope.operation === 'getTrack') collector.record(record);
      } catch { /* 只读分发失败不影响原Core消息、HTTP或清理。 */ }
    },
    associateSession(context, key) {
      try {
        if (!context) return;
        const entry = scopes.get(context); if (!entry || entry.scope.operation !== 'createSession') return;
        if (typeof key !== 'string' || key.length < 1 || key.length > 256) {
          contextFaults++; scopes.delete(context); sessionStopped = true; closeMobileCapabilityContext(context); return;
        }
        const hash = createHash('sha256').update(`MusicBridge:preparation:session-intent:1\0${key}`, 'utf8').digest('hex');
        if (sessionIntentSha256 !== null && hash !== sessionIntentSha256) {
          discardedScopes++; sessionDropped++; scopes.delete(context); sessionStopped = true;
          closeMobileCapabilityContext(context); return;
        }
        sessionIntentSha256 = hash; entry.scope.intentSha256 = hash; context.preparationIntentSha256 = hash;
        withMobileCapabilityContext(context, () => emit('preparation.http.intent', 'link', 'business', undefined, hash));
      } catch {
        if (context && scopes.delete(context)) { contextFaults++; sessionStopped = true; closeMobileCapabilityContext(context); }
      }
    },
    finish(context, result) {
      try {
        if (!context) return;
        const entry = scopes.get(context); if (!entry || entry.scope.terminal !== 'pending') return;
        withMobileCapabilityContext(context, () => mobileCapabilitySync('preparation.http.terminal', () => undefined));
        const intermediate = result.finished && entry.scope.operation === 'createSession' && result.httpStatus === 401
          && sessionClaims === 1 && entry.scope.intentSha256 !== null;
        entry.scope.terminal = !result.finished ? 'incomplete' : intermediate ? 'intermediate' : result.failed ? 'reject' : 'ok';
        entry.scope.httpStatus = result.httpStatus;
        entry.scope.responseFinished = result.finished;
        if (entry.scope.operation === 'createSession') { retryEligible = intermediate; sessionStopped = !intermediate; }
        if (entry.scope.operation === 'getServer' && result.failed || entry.scope.operation === 'createSession' && !intermediate) identitiesStopped = true;
      } catch { /* 领取及落定均是旁注，不改变原业务。 */ }
    },
    snapshot() {
      const captured = [...scopes.entries()].map(([context, { scope, collector }]) => {
        const trace = collector.snapshot(); trace.droppedRecords += context.droppedRecords ?? 0;
        return { ...scope, clockFault: context.clockFault === true,
          workPending: (context.pendingOperations ?? 0) > 0
            || (scope.operation === 'createResource' || scope.operation === 'getTrack') && resourcePreparationWorkPending(trace), trace };
      });
      const ordinary = captured.filter(row => row.operation === 'getServer' || row.operation === 'createSession');
      const resources = captured.filter(row => row.operation === 'createResource'), tracks = captured.filter(row => row.operation === 'getTrack');
      return { schema: PREPARATION_SCHEMA, armed, identityClaims, identityDropped, identitiesStopped, sessionClaimed: sessionClaims > 0,
        sessionClaims, sessionDropped, sessionIntentSha256, discardedScopes, contextFaults,
        resourceClaims, resourceDropped, resourceContextFaults, trackClaims, trackDropped, trackContextFaults,
        truncated: identityDropped > 0 || sessionDropped > 0 || contextFaults > 0 || resourceDropped > 0 || resourceContextFaults > 0
          || trackDropped > 0 || trackContextFaults > 0 || captured.some(row => row.clockFault || row.trace.droppedRecords > 0),
        scopes: ordinary, resourceScopes: resources, trackScopes: tracks };
    },
  };
}
/** 仅复制有界闭集和安全分类；不执行访问器，也不接受正文或未知字段。 */
export function copyMobilePreparationSnapshot(raw: unknown): MobilePreparationSnapshot | null {
  try {
    if (!closed(raw, ['schema', 'armed', 'identityClaims', 'identityDropped', 'identitiesStopped', 'sessionClaimed',
      'sessionClaims', 'sessionDropped', 'sessionIntentSha256', 'discardedScopes', 'contextFaults', 'truncated', 'scopes',
      'resourceClaims', 'resourceDropped', 'resourceContextFaults', 'resourceScopes',
      'trackClaims', 'trackDropped', 'trackContextFaults', 'trackScopes'])
      || raw.schema !== PREPARATION_SCHEMA || typeof raw.armed !== 'boolean' || !integer(raw.identityClaims) || raw.identityClaims > 8
      || !integer(raw.identityDropped) || typeof raw.identitiesStopped !== 'boolean' || typeof raw.sessionClaimed !== 'boolean'
      || !integer(raw.sessionClaims) || raw.sessionClaims > 2 || raw.sessionClaimed !== (raw.sessionClaims > 0)
      || !integer(raw.sessionDropped) || !nullableSha(raw.sessionIntentSha256) || !integer(raw.discardedScopes) || raw.discardedScopes > 1
      || !integer(raw.contextFaults) || raw.contextFaults > 10 || typeof raw.truncated !== 'boolean'
      || !integer(raw.resourceClaims) || raw.resourceClaims > 2 || !integer(raw.resourceDropped)
      || !integer(raw.resourceContextFaults) || raw.resourceContextFaults > 2
      || !integer(raw.trackClaims) || raw.trackClaims > 2 || !integer(raw.trackDropped)
      || !integer(raw.trackContextFaults) || raw.trackContextFaults > 2
      || !Array.isArray(raw.scopes) || types.isProxy(raw.scopes) || raw.scopes.length > 10
      || Reflect.ownKeys(raw.scopes).length !== raw.scopes.length + 1
      || !Array.isArray(raw.resourceScopes) || types.isProxy(raw.resourceScopes) || raw.resourceScopes.length > 2
      || Reflect.ownKeys(raw.resourceScopes).length !== raw.resourceScopes.length + 1
      || !Array.isArray(raw.trackScopes) || types.isProxy(raw.trackScopes) || raw.trackScopes.length > 2
      || Reflect.ownKeys(raw.trackScopes).length !== raw.trackScopes.length + 1) return null;
    const scopes: PreparationScope[] = [], resourceScopes: PreparationScope[] = [], trackScopes: PreparationScope[] = [], hashes = new Set<string>();
    for (const group of [{ values: raw.scopes, linked: false, operations: ['getServer', 'createSession'], output: scopes },
      { values: raw.resourceScopes, linked: true, operations: ['createResource'], output: resourceScopes },
      { values: raw.trackScopes, linked: true, operations: ['getTrack'], output: trackScopes }]) {
      for (let index = 0; index < group.values.length; index++) {
        const field = Object.getOwnPropertyDescriptor(group.values, String(index));
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) return null;
        const row: unknown = field.value;
        if (!closed(row, ['operation', 'requestSha256', 'intentSha256', 'terminal', 'httpStatus', 'responseFinished', 'clockFault', 'workPending', 'trace'])
          || !choice(row.operation, group.operations)
          || typeof row.requestSha256 !== 'string' || !sha.test(row.requestSha256) || hashes.has(row.requestSha256) || !nullableSha(row.intentSha256)
          || row.intentSha256 !== null && (row.operation !== 'createSession' || row.intentSha256 !== raw.sessionIntentSha256)
          || !choice(row.terminal, ['pending', 'ok', 'reject', 'incomplete', 'intermediate'])
          || row.httpStatus !== null && (!integer(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599)
          || typeof row.responseFinished !== 'boolean' || typeof row.clockFault !== 'boolean' || typeof row.workPending !== 'boolean') return null;
        if (row.terminal === 'intermediate' && (row.operation !== 'createSession' || row.httpStatus !== 401 || row.intentSha256 === null)) return null;
        const maximumRecords = row.operation === 'getServer' ? 64 : row.operation === 'createResource' ? MOBILE_PREPARATION_EVIDENCE_LIMITS.resourceRecords : 192;
        const trace = copyCapabilityTraceSnapshot(row.trace, row.operation === 'createResource' ? maximumRecords : 256);
        if (!trace || trace.records.length > maximumRecords) return null;
        if (group.linked) {
          if (!validResourcePreparationTrace(trace, row.requestSha256, maximumRecords)) return null;
        } else if (trace.firstBusinessFailures.length > 1
          || [...trace.records, ...trace.firstBusinessFailures, ...trace.cleanupFailures].some(record =>
            record.component !== 'main' || record.requestSha256 !== row.requestSha256 || record.parentSha256 !== null
            || record.relatedSha256 !== null && record.relatedSha256 !== row.intentSha256)) return null;
        hashes.add(row.requestSha256);
        group.output.push({ operation: row.operation as PreparationScope['operation'], requestSha256: row.requestSha256,
          intentSha256: row.intentSha256 as string | null, terminal: row.terminal, httpStatus: row.httpStatus as number | null,
          responseFinished: row.responseFinished, clockFault: row.clockFault, workPending: row.workPending, trace });
      }
    }
    if (scopes.filter(row => row.operation === 'getServer').length > raw.identityClaims
      || scopes.filter(row => row.operation === 'createSession').length > raw.sessionClaims
      || scopes.length + raw.contextFaults + raw.discardedScopes !== raw.identityClaims + raw.sessionClaims
      || resourceScopes.length + raw.resourceContextFaults !== raw.resourceClaims
      || trackScopes.length + raw.trackContextFaults !== raw.trackClaims
      || raw.truncated !== (raw.identityDropped > 0 || raw.sessionDropped > 0 || raw.contextFaults > 0 || raw.resourceDropped > 0
        || raw.resourceContextFaults > 0 || raw.trackDropped > 0 || raw.trackContextFaults > 0
        || [...scopes, ...resourceScopes, ...trackScopes].some(row => row.clockFault || row.trace.droppedRecords > 0))
      || !raw.armed && (raw.identityClaims !== 0 || raw.sessionClaimed || raw.contextFaults !== 0 || raw.identityDropped !== 0
        || raw.identitiesStopped || raw.sessionDropped !== 0 || raw.resourceClaims !== 0 || raw.resourceDropped !== 0 || raw.resourceContextFaults !== 0
        || raw.trackClaims !== 0 || raw.trackDropped !== 0 || raw.trackContextFaults !== 0)) return null;
    const snapshot: MobilePreparationSnapshot = { schema: PREPARATION_SCHEMA, armed: raw.armed, identityClaims: raw.identityClaims, identityDropped: raw.identityDropped,
      identitiesStopped: raw.identitiesStopped, sessionClaimed: raw.sessionClaimed, sessionClaims: raw.sessionClaims, sessionDropped: raw.sessionDropped,
      sessionIntentSha256: raw.sessionIntentSha256 as string | null, discardedScopes: raw.discardedScopes,
      contextFaults: raw.contextFaults, truncated: raw.truncated, scopes, resourceClaims: raw.resourceClaims, resourceDropped: raw.resourceDropped,
      resourceContextFaults: raw.resourceContextFaults, resourceScopes,
      trackClaims: raw.trackClaims, trackDropped: raw.trackDropped, trackContextFaults: raw.trackContextFaults, trackScopes };
    // 只限制本机已验证私有子树；不提高公开报告、业务HTTP或IPC原有预算。
    if (Buffer.byteLength(JSON.stringify({ privateEvidence: { mobilePreparation: snapshot } }, null, 2), 'utf8') > MOBILE_PREPARATION_EVIDENCE_LIMITS.serializedBytes) return null;
    return snapshot;
  } catch { return null; }
}
