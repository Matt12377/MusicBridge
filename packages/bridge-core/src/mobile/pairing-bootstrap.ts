import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SRP, SrpServer } from 'fast-srp-hap';
import {
  captureMobilePairingBeginRequest, captureMobilePairingExchangeRequest, captureMobilePairingFinishRequest,
  isMobilePairingRequestId, mobileCommonResponseSnapshot, mobilePairingCanonicalBinding,
  MOBILE_PAIRING_BOOTSTRAP_FINISH_INFO, MOBILE_PAIRING_BOOTSTRAP_TOKEN_INFO,
  type MobilePairingBeginReply, type MobilePairingBeginRequest, type MobilePairingBootstrapBinding,
  type MobilePairingExchangeReply, type MobilePairingExchangeRequest,
  type MobilePairingFinishReply, type MobilePairingFinishRequest, type MobilePairingClaim, type MobileTokenPair,
} from '@music-bridge/contracts';
import { MobileServiceError, type MobileAuthService, type MobilePairingPermit } from './types.js';

/** 短码只存在于可信 Main 回调；公开路由、持久鉴权状态和 Bonjour 均不包含它。 */
export interface MobilePairingBootstrapPrompt {
  requestId: string; deviceName: string; code: string; expiresAtMs: number;
}
export interface MobilePairingBootstrapPeer {
  remoteAddress: string; origin: string; certificateSha256: string; serverId: string;
}
export interface MobilePairingBootstrapOptions {
  auth: Pick<MobileAuthService, 'issuePairing' | 'claim'>;
  serverId: string; origin: string; certificateSha256: string;
  assertCurrent(): void;
  onRequest(prompt: MobilePairingBootstrapPrompt): void | Promise<void>;
  onEnded?(requestId: string): void;
  /** 只供受控合成测试注入，不接受普通配置、环境变量或 HTTP 参数。 */
  now?: () => number; monotonicNow?: () => number;
}
export const MOBILE_PAIRING_BOOTSTRAP_LIMITS = Object.freeze({
  lifetimeMs: 120_000, maximumRequests: 8, maximumProofAttempts: 1,
  rateWindowMs: 60_000, maximumStartsPerPeer: 5, maximumStartsGlobal: 16, maximumRecentPeers: 64,
});

type Phase = 'pending' | 'proved' | 'claiming' | 'claimed';
interface Pending {
  begin: MobilePairingBeginRequest; challenge: MobilePairingBeginReply; peer: MobilePairingBootstrapPeer;
  binding: Buffer; deadline: number; phase: Phase; srp?: SrpServer; timer?: NodeJS.Timeout;
  registration?: Promise<void>;
  exchangeFingerprint?: string; serverProof?: string; finishKey?: Buffer; tokenKey?: Buffer; aad?: Buffer;
  permit?: MobilePairingPermit; claimBody?: MobilePairingClaim; pair?: MobileTokenPair;
  envelope?: MobilePairingFinishReply; flight?: Promise<MobilePairingFinishReply>; ended: boolean;
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest();
const sha512 = (...values: readonly Uint8Array[]) => {
  const digest = createHash('sha512'); for (const value of values) digest.update(value); return digest.digest();
};
const denied = (): never => { throw new MobileServiceError(401, 'UNAUTHORIZED'); };
const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const busy = (): never => { throw new MobileServiceError(503, 'BUSY', true); };
const conflict = (): never => { throw new MobileServiceError(409, 'IDEMPOTENCY_CONFLICT'); };
const limited = (): never => { throw new MobileServiceError(429, 'BUSY', true, 60_000); };
const normalizePeer = (value: string) => value.startsWith('::ffff:') ? value.slice(7) : value;
function safeFailure(error: unknown): MobileServiceError {
  return error instanceof MobileServiceError ? error : new MobileServiceError(503, 'BUSY', true);
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
function samePair(a: MobileTokenPair, b: MobileTokenPair): boolean {
  return a.deviceId === b.deviceId && a.serverId === b.serverId && a.accessToken === b.accessToken
    && a.refreshToken === b.refreshToken && a.accessExpiresAt === b.accessExpiresAt && a.refreshExpiresAt === b.refreshExpiresAt;
}
function sameBegin(a: MobilePairingBeginRequest, b: MobilePairingBeginRequest): boolean {
  return a.protocolVersion === b.protocolVersion && a.serverId === b.serverId
    && a.certificateSha256 === b.certificateSha256 && a.installationId === b.installationId
    && a.deviceName === b.deviceName && a.clientNonce === b.clientNonce
    && a.claimIdempotencyKey === b.claimIdempotencyKey;
}

/**
 * SRP-6a 仍由成熟库计算大整数与共享密钥。这里采用 Swift SRP 2.3.0 的标准 padded-g 证明，
 * 避免 fast-srp-hap 内置 H(g最短字节) 与 Swift H(PAD(g)) 的互操作差异，不修改任一库。
 */
function paddedProof(username: Buffer, salt: Buffer, clientPublic: Buffer, serverPublic: Buffer, key: Buffer) {
  const n = SRP.params.hap.N.toBuffer(384), g = SRP.params.hap.g.toBuffer(384);
  const groupHash = sha512(n), generatorHash = sha512(g);
  for (let index = 0; index < groupHash.length; index++) groupHash[index] = groupHash[index]! ^ generatorHash[index]!;
  const m1 = sha512(groupHash, sha512(username), salt, clientPublic, serverPublic, key);
  return { m1, m2: sha512(clientPublic, m1, key) };
}

/** 新的临时引导只包装原许可及 claim；真实设备授权仍由原唯一鉴权实例和 Owner 提交。 */
export function createMobilePairingBootstrap(options: MobilePairingBootstrapOptions) {
  if (!/^https:\/\/[0-9]+(?:\.[0-9]+){3}(?::[1-9][0-9]{0,4})?(?![\s\S])/u.test(options.origin)
    || !/^[0-9a-f]{64}(?![\s\S])/u.test(options.certificateSha256)) return invalid();
  const records = new Map<string, Pending>(), inFlight = new Set<Promise<unknown>>();
  const peerStarts = new Map<string, number[]>(); let globalStarts: number[] = [];
  const readWall = options.now ?? Date.now, readMonotonic = options.monotonicNow ?? (() => performance.now());
  let closing = false, closeFlight: Promise<void> | undefined;
  function current(): void {
    if (closing) return busy();
    try { options.assertCurrent(); } catch (error) { throw safeFailure(error); }
  }
  function clock(): number {
    const value = readMonotonic(); if (!Number.isFinite(value) || value < 0) return busy(); return value;
  }
  function capturePeer(peer: MobilePairingBootstrapPeer): MobilePairingBootstrapPeer {
    const remoteAddress = normalizePeer(peer.remoteAddress);
    if (!/^[0-9]+(?:\.[0-9]+){3}(?![\s\S])/u.test(remoteAddress)
      || peer.origin !== options.origin || peer.certificateSha256 !== options.certificateSha256
      || peer.serverId !== options.serverId) return denied();
    return { remoteAddress, origin: peer.origin, certificateSha256: peer.certificateSha256, serverId: peer.serverId };
  }
  function end(record: Pending): void {
    if (record.ended) return; record.ended = true;
    try { options.onEnded?.(record.challenge.requestId); } catch { /* 展示关闭不能更改原授权提交。 */ }
  }
  function erase(record: Pending): void {
    records.delete(record.challenge.requestId); if (record.timer) clearTimeout(record.timer);
    delete record.timer; delete record.srp;
    record.finishKey?.fill(0); record.tokenKey?.fill(0); record.aad?.fill(0); record.binding.fill(0);
    delete record.finishKey; delete record.tokenKey; delete record.aad;
    delete record.permit; delete record.claimBody; delete record.pair; delete record.envelope;
    end(record);
  }
  function alive(record: Pending): void {
    current();
    if (records.get(record.challenge.requestId) !== record) return denied();
    if (clock() >= record.deadline) { erase(record); return denied(); }
  }
  function find(requestId: string, peer: MobilePairingBootstrapPeer): Pending {
    current(); if (!isMobilePairingRequestId(requestId)) return invalid();
    const record = records.get(requestId), captured = capturePeer(peer);
    if (!record || record.peer.remoteAddress !== captured.remoteAddress) return denied();
    alive(record); return record;
  }
  function admit(peer: string, at: number): void {
    const cutoff = at - MOBILE_PAIRING_BOOTSTRAP_LIMITS.rateWindowMs;
    globalStarts = globalStarts.filter(value => value > cutoff);
    for (const [key, values] of peerStarts) {
      const recent = values.filter(value => value > cutoff);
      if (recent.length) peerStarts.set(key, recent); else peerStarts.delete(key);
    }
    const recent = peerStarts.get(peer) ?? [];
    if (globalStarts.length >= MOBILE_PAIRING_BOOTSTRAP_LIMITS.maximumStartsGlobal
      || recent.length >= MOBILE_PAIRING_BOOTSTRAP_LIMITS.maximumStartsPerPeer
      || !peerStarts.has(peer) && peerStarts.size >= MOBILE_PAIRING_BOOTSTRAP_LIMITS.maximumRecentPeers) return limited();
    globalStarts.push(at); peerStarts.set(peer, [...recent, at]);
  }
  function remember<T>(flight: Promise<T>): Promise<T> {
    inFlight.add(flight); void flight.finally(() => inFlight.delete(flight)).catch(() => {}); return flight;
  }
  async function beforeSend(requestId: string, peer: MobilePairingBootstrapPeer): Promise<void> {
    const record = find(requestId, peer);
    if (record.phase !== 'claimed' || !record.claimBody || !record.pair) return denied();
    const expected = record.pair, body = record.claimBody;
    const checked = await options.auth.claim(body, record.begin.claimIdempotencyKey);
    alive(record); if (!samePair(checked, expected)) return denied();
  }
  const coordinator = {
    async start(raw: unknown, peer: MobilePairingBootstrapPeer): Promise<MobilePairingBeginReply> {
      current(); const body = captureMobilePairingBeginRequest(raw); if (!body.ok) return invalid();
      const captured = capturePeer(peer), begin = body.value, at = clock();
      if (begin.serverId !== options.serverId || begin.certificateSha256 !== options.certificateSha256) return denied();
      for (const candidate of [...records.values()]) if (at >= candidate.deadline) erase(candidate);
      for (const candidate of records.values()) if (candidate.begin.installationId === begin.installationId) {
        const previous = candidate.begin;
        if (previous.clientNonce === begin.clientNonce && previous.claimIdempotencyKey === begin.claimIdempotencyKey) {
          if (candidate.peer.remoteAddress !== captured.remoteAddress || !sameBegin(previous, begin)) return conflict();
          // 重试也须等原Mac提示登记，不能抢先发布随后会被拒绝的挑战。
          try { await candidate.registration; } catch (error) { throw safeFailure(error); }
          alive(candidate);
          return { ...candidate.challenge };
        }
        if (candidate.phase !== 'claimed') return conflict();
      }
      if (records.size >= MOBILE_PAIRING_BOOTSTRAP_LIMITS.maximumRequests) return busy();
      admit(captured.remoteAddress, at);
      const wall = readWall(); if (!Number.isSafeInteger(wall) || wall < 0 || wall > 8_640_000_000_000_000 - 120_000) return busy();
      const requestId = 'pair:' + randomBytes(24).toString('hex');
      const serverNonce = randomBytes(32).toString('hex'), salt = randomBytes(32);
      const expiresAtMs = wall + MOBILE_PAIRING_BOOTSTRAP_LIMITS.lifetimeMs, expiresAt = new Date(expiresAtMs).toISOString();
      const fields: MobilePairingBootstrapBinding = { requestId, serverId: options.serverId, origin: options.origin,
        certificateSha256: options.certificateSha256, installationId: begin.installationId, deviceName: begin.deviceName,
        clientNonce: begin.clientNonce, serverNonce, claimIdempotencyKey: begin.claimIdempotencyKey, expiresAt };
      const binding = Buffer.from(mobilePairingCanonicalBinding(fields)), username = Buffer.from('mousa-pair:' + hash(binding).toString('hex'));
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0'), password = Buffer.from(code), privateKey = randomBytes(32);
      let srp: SrpServer;
      try { srp = new SrpServer(SRP.params.hap, salt, username, password, privateKey); }
      catch { binding.fill(0); return busy(); }
      finally { password.fill(0); privateKey.fill(0); }
      const challenge: MobilePairingBeginReply = { protocolVersion: 1, requestId, serverId: options.serverId,
        origin: options.origin, certificateSha256: options.certificateSha256, serverNonce, salt: salt.toString('hex'),
        serverPublicKey: srp.computeB().toString('hex'), expiresAt };
      const record: Pending = { begin, challenge, peer: captured, binding, deadline: at + MOBILE_PAIRING_BOOTSTRAP_LIMITS.lifetimeMs,
        phase: 'pending', srp, ended: false };
      records.set(requestId, record);
      record.timer = setTimeout(() => erase(record), MOBILE_PAIRING_BOOTSTRAP_LIMITS.lifetimeMs); record.timer.unref();
      record.registration = remember(Promise.resolve().then(() => {
        alive(record); return options.onRequest({ requestId, deviceName: begin.deviceName, code, expiresAtMs });
      }));
      try { alive(record); await record.registration; alive(record); }
      catch (error) { erase(record); throw safeFailure(error); }
      finally { delete record.registration; }
      return { ...challenge };
    },
    async exchange(requestId: string, raw: unknown, peer: MobilePairingBootstrapPeer): Promise<MobilePairingExchangeReply> {
      const body = captureMobilePairingExchangeRequest(raw); if (!body.ok) return invalid();
      const record = find(requestId, peer), incoming: MobilePairingExchangeRequest = body.value;
      const fingerprint = incoming.clientPublicKey + incoming.clientProof;
      if (record.exchangeFingerprint) {
        if (record.exchangeFingerprint !== fingerprint) return conflict();
        if (!record.serverProof) return denied(); return { serverProof: record.serverProof };
      }
      if (record.phase !== 'pending' || !record.srp) return denied();
      // 每个请求只接受一次独立证明；输错需重新申请，新请求重新生成盐、b和短码，避免复用SRP临时值。
      record.exchangeFingerprint = fingerprint;
      const clientPublic = Buffer.from(incoming.clientPublicKey, 'hex');
      let key: Buffer | undefined;
      try {
        record.srp.setA(clientPublic); key = Buffer.from(record.srp.computeK());
        const username = Buffer.from('mousa-pair:' + hash(record.binding).toString('hex'));
        const proofs = paddedProof(username, Buffer.from(record.challenge.salt, 'hex'), clientPublic,
          Buffer.from(record.challenge.serverPublicKey, 'hex'), key);
        if (!equal(proofs.m1, Buffer.from(incoming.clientProof, 'hex'))) { erase(record); return denied(); }
        const salt = hash(record.binding);
        record.tokenKey = Buffer.from(hkdfSync('sha256', key, salt, MOBILE_PAIRING_BOOTSTRAP_TOKEN_INFO, 32));
        record.finishKey = Buffer.from(hkdfSync('sha256', key, salt, MOBILE_PAIRING_BOOTSTRAP_FINISH_INFO, 32));
        record.aad = Buffer.concat([record.binding, proofs.m1, proofs.m2]);
        record.serverProof = proofs.m2.toString('hex'); record.phase = 'proved'; delete record.srp;
        alive(record); return { serverProof: record.serverProof };
      } catch (error) { erase(record); if (error instanceof MobileServiceError) throw error; return denied(); }
      finally { key?.fill(0); }
    },
    async finish(requestId: string, raw: unknown, peer: MobilePairingBootstrapPeer): Promise<MobilePairingFinishReply> {
      const body = captureMobilePairingFinishRequest(raw); if (!body.ok) return invalid();
      const incoming: MobilePairingFinishRequest = body.value, record = find(requestId, peer);
      if (!record.finishKey || !record.tokenKey || !record.aad) return denied();
      const expected = createHmac('sha256', record.finishKey).update(record.aad).digest();
      if (!equal(expected, Buffer.from(incoming.clientConfirmation, 'hex'))) { erase(record); return denied(); }
      if (record.envelope) { await remember(beforeSend(requestId, peer)); return { ...record.envelope }; }
      if (record.flight) return { ...await record.flight };
      const work = (async (): Promise<MobilePairingFinishReply> => {
        alive(record); record.phase = 'claiming';
        if (!record.permit) {
          try { record.permit = await options.auth.issuePairing(); }
          catch (error) {
            // issuePairing 未返回许可时不能重造同一意图；原鉴权实例独立保留其 UNKNOWN 围栏。
            erase(record); throw safeFailure(error);
          }
          alive(record);
          record.claimBody = { pairingSecret: record.permit.pairingSecret,
            installationId: record.begin.installationId, deviceName: record.begin.deviceName };
        }
        if (!record.claimBody) return busy();
        // claim 的暂错/UNKNOWN 保留同一许可、完整body和key；下一次finish只核原回执。
        const pair = await options.auth.claim(record.claimBody, record.begin.claimIdempotencyKey);
        alive(record);
        const captured = mobileCommonResponseSnapshot('tokenPair', pair);
        if (!captured.ok || captured.value.serverId !== options.serverId) return busy();
        record.pair = captured.value;
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', record.tokenKey!, nonce);
        cipher.setAAD(record.aad!);
        const plaintext = Buffer.from(JSON.stringify(record.pair));
        let ciphertext: Buffer;
        try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
        finally { plaintext.fill(0); }
        record.envelope = { nonce: nonce.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
        record.phase = 'claimed'; end(record); return { ...record.envelope };
      })();
      record.flight = remember(work);
      try { return { ...await record.flight }; }
      catch (error) { throw safeFailure(error); }
      finally { if (record.flight === work) delete record.flight; }
    },
    beforeSend: (requestId: string, peer: MobilePairingBootstrapPeer) => remember(beforeSend(requestId, peer)).catch(error => { throw safeFailure(error); }),
    cancel(requestId: string): void { const record = records.get(requestId); if (record) erase(record); },
    async cancelFromPeer(requestId: string, peer: MobilePairingBootstrapPeer): Promise<void> {
      const record = find(requestId, peer);
      if (record.phase === 'claiming' || record.phase === 'claimed') return conflict();
      erase(record);
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true; for (const record of [...records.values()]) erase(record);
      peerStarts.clear(); globalStarts = [];
      closeFlight = (async () => { await Promise.allSettled([...inFlight]); })(); return closeFlight;
    },
  };
  return coordinator;
}
