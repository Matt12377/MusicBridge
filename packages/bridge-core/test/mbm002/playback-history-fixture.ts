import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { MobileDecodedRequest, MobileReadyResource, MobileResourceRequest, MobileSession } from '@music-bridge/contracts';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { decodePlaybackStorage, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import type { PlaybackState } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError, type MobilePlaybackControlOperation,
  type MobilePlaybackLimits, type MobilePlaybackPreparedSource, type MobilePlaybackService,
  type MobilePlaybackServiceOptions, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError, type MobileAuthCrypto, type MobileAuthPersistence,
  type MobilePrincipal, type MobileSealedSave, type MobileSealedState } from '../../src/mobile/types.js';

// 仅合成端口与真实认证加密；不接触真实账户、曲库、媒体或运行中的Owner。
export const HISTORY_SERVER = 'history.synthetic.server';
export const HISTORY_DATASET = '60000000-0000-4000-8000-000000000001';
export const HISTORY_ORIGIN = 'https://127.0.0.1:43123';
export const HISTORY_NOW = Date.parse('2026-10-23T00:00:00.000Z');
export function historyPrincipal(deviceId = 'history.synthetic.device', deviceEpoch = 1): MobilePrincipal {
  return { serverId: HISTORY_SERVER, datasetId: HISTORY_DATASET, accountDomain: `local:${HISTORY_DATASET}`,
    deviceId, deviceEpoch, generation: 1, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z' };
}
export function historyDeferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export type HistoryGate = ReturnType<typeof historyDeferred<void>>;
export async function historyUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, '有界等待未观察到真实端口事件。'); await delay(2); }
}
export function historyCrypto(): MobileAuthCrypto {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0); return crypto;
}
export const historyAad = (revision: number) => Buffer.from(JSON.stringify([
  'MBM002_PLAYBACK_STATE_V1', HISTORY_SERVER, HISTORY_DATASET, revision,
]));

export class HistoryLegacyPersistence implements MobileAuthPersistence {
  value: MobileSealedState = { kind: 'missing', datasetId: HISTORY_DATASET, revision: 0 };
  loads = 0; saves = 0;
  fault: 'none' | 'not-sent' | 'lost-ack-committed' | 'unknown-no-commit' = 'none';
  async load(datasetId: string): Promise<MobileSealedState> {
    assert.equal(datasetId, HISTORY_DATASET); this.loads++; return structuredClone(this.value);
  }
  async save(request: MobileSealedSave) {
    assert.equal(request.datasetId, HISTORY_DATASET); this.saves++;
    const fault = this.fault; this.fault = 'none';
    if (fault === 'not-sent') throw new MobileAuthPersistenceError('not-sent');
    if (fault === 'unknown-no-commit') throw new MobileAuthPersistenceError('unknown');
    if (request.expectedRevision !== this.value.revision)
      return { kind: 'conflict' as const, datasetId: HISTORY_DATASET, currentRevision: this.value.revision };
    this.value = { kind: 'sealed', datasetId: HISTORY_DATASET, revision: request.expectedRevision + 1,
      commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
    if (fault === 'lost-ack-committed') throw new MobileAuthPersistenceError('unknown');
    return { kind: 'saved' as const, datasetId: HISTORY_DATASET, revision: this.value.revision, commitId: this.value.commitId };
  }
  seed(state: PlaybackState, crypto: MobileAuthCrypto, limits: Readonly<MobilePlaybackLimits> = MOBILE_PLAYBACK_DEFAULT_LIMITS): void {
    assert.ok(state.commitId); const encoded = encodePlaybackStorage(state, HISTORY_SERVER, HISTORY_DATASET, HISTORY_ORIGIN, limits);
    try { this.value = { kind: 'sealed', datasetId: HISTORY_DATASET, revision: state.revision, commitId: state.commitId,
      sealed: crypto.seal(encoded.bytes, historyAad(state.revision)) }; }
    finally { encoded.bytes.fill(0); }
  }
  state(crypto: MobileAuthCrypto, limits: Readonly<MobilePlaybackLimits> = MOBILE_PLAYBACK_DEFAULT_LIMITS): PlaybackState {
    assert.equal(this.value.kind, 'sealed'); if (this.value.kind !== 'sealed') throw new Error('合成状态尚未提交。');
    const plain = crypto.open(this.value.sealed, historyAad(this.value.revision));
    try { return decodePlaybackStorage(plain, HISTORY_SERVER, HISTORY_DATASET, HISTORY_ORIGIN, limits).state; }
    finally { plain.fill(0); }
  }
}

export class HistorySources implements MobilePlaybackSourcePort {
  readonly handles = new Map<string, MobilePlaybackPreparedSource>();
  readonly readers = new Map<string, string>();
  prepares = 0; verifies = 0; renews = 0; releases = 0; reads = 0;
  prepareGate: HistoryGate | undefined;
  verifyGate: HistoryGate | undefined;
  readGate: HistoryGate | undefined;
  closeReadGate: HistoryGate | undefined;
  releaseGate: HistoryGate | undefined;
  failure: unknown;
  netease = false;
  async prepare(request: Parameters<MobilePlaybackSourcePort['prepare']>[0]): Promise<MobilePlaybackPreparedSource> {
    this.prepares++; if (this.failure !== undefined) throw this.failure;
    const audio = { codec: 'flac', container: 'flac', sampleRateHz: 48_000, bitsPerSample: 24, channels: 2 };
    const value: MobilePlaybackPreparedSource = { handle: `history.handle.${request.resourceId}`, sourceAudio: audio,
      actualAudio: { ...audio }, processing: { mode: 'direct', reason: '合成端口原字节', fromPreparedCache: false },
      contentType: 'audio/flac', size: 4_096, durationMs: 180_000, seekable: true,
      ...(this.netease ? { catalogSource: 'netease' as const, providerBinding: {
        accountDomain: 'netease:history.synthetic.account', providerEpoch: 'history.provider.1', ownerEpoch: 'history.owner.1',
      } } : {}) };
    this.handles.set(value.handle, value);
    // 故意允许取消后迟回，真实quiet必须等待该promise及真实release结束。
    await this.prepareGate?.promise; return structuredClone(value);
  }
  async verify(handle: string): Promise<void> {
    this.verifies++; await this.verifyGate?.promise;
    if (!this.handles.has(handle)) throw new MobilePlaybackError(409, 'SOURCE_CHANGED');
  }
  async renew(handle: string): Promise<void> { assert.ok(this.handles.has(handle)); this.renews++; }
  async read(handle: string, readId: string, start: number, maxBytes: number): Promise<Uint8Array> {
    assert.ok(this.handles.has(handle)); assert.ok(maxBytes >= 1 && maxBytes <= 65_536); this.reads++;
    this.readers.set(readId, handle); await this.readGate?.promise;
    return Uint8Array.from({ length: Math.min(maxBytes, 4_096 - start) }, (_, index) => (start + index) % 251);
  }
  async closeRead(handle: string, readId: string): Promise<void> {
    await this.closeReadGate?.promise;
    const prior = this.readers.get(readId); if (prior !== undefined) assert.equal(prior, handle); this.readers.delete(readId);
  }
  async release(handle: string): Promise<void> {
    await this.releaseGate?.promise; assert.ok(![...this.readers.values()].includes(handle));
    if (this.handles.delete(handle)) this.releases++;
  }
  unblock(): void { this.prepareGate?.resolve(); this.verifyGate?.resolve(); this.readGate?.resolve(); this.closeReadGate?.resolve(); this.releaseGate?.resolve(); }
}

export function historyFixture(t: TestContext, limits: Partial<MobilePlaybackLimits> = {}, extra: Partial<MobilePlaybackServiceOptions> = {}) {
  let now = HISTORY_NOW;
  const crypto = historyCrypto(), persistence = new HistoryLegacyPersistence(), sources = new HistorySources();
  const devices = new Map([[historyPrincipal().deviceId, 1], ['history.other.device', 1]]), actors: MobilePlaybackService[] = [];
  const afterActors: (() => void | Promise<void>)[] = [];
  const create = (overrides: Partial<MobilePlaybackServiceOptions> = {}) => {
    const actor = createMobilePlaybackService({ serverId: HISTORY_SERVER, datasetId: HISTORY_DATASET, responseOrigin: HISTORY_ORIGIN,
      persistence, crypto, sourcePort: sources, nowMs: () => now, limits,
      auth: { async assertDeviceCurrent(deviceId, epoch) {
        if (devices.get(deviceId) !== epoch) throw new MobilePlaybackError(401, 'DEVICE_REVOKED');
      } }, ...extra, ...overrides });
    actors.push(actor); return actor;
  };
  t.after(async () => { sources.unblock(); try { for (const actor of actors) await actor.close(); }
    finally { for (const cleanup of afterActors) await cleanup(); }
    assert.equal(sources.handles.size, 0); assert.equal(sources.readers.size, 0); });
  return { crypto, persistence, sources, devices, create, afterActors, now: () => now, advance(ms: number) { now += ms; } };
}
export const historyResourceRequest = (trackId = 'history.synthetic.track'): MobileResourceRequest => ({
  trackId, versionId: 'history.synthetic.version', contentRevision: 'history.synthetic.content',
  quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
  formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48_000, maxBitsPerSample: 24, maxChannels: 2 }],
});
export function historyRequest(operation: MobilePlaybackControlOperation, body: unknown = null,
  sessionId?: string, resourceId?: string, key?: string): MobileDecodedRequest<unknown> {
  const base = '/mobile/v1/sessions';
  const path = operation === 'createSession' ? base : operation === 'reportObservation' ? `${base}/${sessionId}/observation`
    : operation === 'createResource' ? `${base}/${sessionId}/resources`
      : ['getResource', 'releaseResource', 'renewResource'].includes(operation)
        ? `${base}/${sessionId}/resources/${resourceId}${operation === 'renewResource' ? '/renew' : ''}` : `${base}/${sessionId}`;
  const pathParameters: Record<string, string> = operation === 'createSession' ? {} : ['getResource', 'releaseResource', 'renewResource'].includes(operation)
    ? { sessionId: sessionId!, resourceId: resourceId! } : { sessionId: sessionId! };
  return { path, pathParameters, query: {}, body, ...(key ? { idempotencyKey: key } : {}) };
}
export const historyCall = (service: MobilePlaybackService, operation: MobilePlaybackControlOperation,
  request: MobileDecodedRequest<unknown>, principal = historyPrincipal(), signal = new AbortController().signal) =>
  service.control(operation, request, principal, signal);
export async function historyCreateSession(service: MobilePlaybackService, key: string, principal = historyPrincipal()): Promise<MobileSession> {
  const reply = await historyCall(service, 'createSession', historyRequest('createSession', { clientInstanceId: `history.client.${principal.deviceId}` },
    undefined, undefined, key), principal);
  assert.equal(reply.status, 201); await reply.beforeSend(); return reply.body as MobileSession;
}
export async function historyReady(service: MobilePlaybackService, session: MobileSession, key: string): Promise<MobileReadyResource> {
  const reply = await historyCall(service, 'createResource', historyRequest('createResource', historyResourceRequest(), session.id, undefined, key));
  assert.equal(reply.status, 201); await reply.beforeSend(); return reply.body as MobileReadyResource;
}
export function historyCode(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  return assert.rejects(promise, value => value instanceof MobilePlaybackError && value.code === code && value.status === status);
}
