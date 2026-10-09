import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  MOBILE_CODEC_LIMITS, mobileCanonicalJson, mobileCommonRequestSnapshot,
  mobileCommonResponseSnapshot, parseMobileJson,
  type MobilePairingClaim, type MobileRefreshRequest, type MobileTokenPair,
} from '@music-bridge/contracts';
import {
  MOBILE_AUTH_MAX_DEVICES, MOBILE_AUTH_MAX_PAIRINGS, MOBILE_AUTH_MAX_RECEIPTS,
  MOBILE_AUTH_SEALED_MAX_BYTES, MOBILE_AUTH_STATE_MAX_BYTES,
  MobileAuthPersistenceError, MobileServiceError,
  type MobileAuthCrypto, type MobileAuthPersistence, type MobileAuthService,
  type MobilePrincipal, type MobileSealedState,
} from './types.js';

const STATE_SCHEMA = 'musicbridge.mobile001.auth-state.v1';
const PAIRING_MS = 300_000, ACCESS_MS = 900_000, REFRESH_MS = 2_592_000_000;
const DATE_MAX = 8_640_000_000_000_000;
const PRIVATE_LIMITS = { ...MOBILE_CODEC_LIMITS, depth: 16, nodes: 200_000 };
interface Device {
  deviceId: string; installationId: string; deviceName: string; createdAt: string;
  issuedAt: string; deviceEpoch: number; generation: number; revoked: boolean;
  accessHash: string; accessExpiresAt: string; refreshHash: string; refreshExpiresAt: string;
}
interface Permit { secretHash: string; issuedAt: string; expiresAt: string }
interface Receipt {
  operation: 'claimPairing' | 'refreshToken'; originHash: string; keyHash: string;
  fingerprint: string; deviceId: string; deviceEpoch: number; generation: number;
  issuedAt: string; commitId: string; tokenPair: MobileTokenPair;
}
interface State {
  schema: typeof STATE_SCHEMA; serverId: string; datasetId: string;
  revision: number; commitId: string | null; clockFloor: number;
  devices: Device[]; permits: Permit[]; receipts: Receipt[];
}
interface PrincipalBrand { deviceId: string; fence: number }
interface UnknownSave { state: State; plain: string }

export interface MobileAuthServiceOptions {
  persistence: MobileAuthPersistence; crypto: MobileAuthCrypto;
  serverId: string; datasetId: string; displayName: string;
  environment: 'development' | 'production'; now?: () => number; randomToken?: () => string;
}

const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const denied = (): never => { throw new MobileServiceError(401, 'UNAUTHORIZED'); };
const unavailable = (): never => { throw new MobileServiceError(503, 'BUSY'); };
const conflict = (): never => { throw new MobileServiceError(409, 'IDEMPOTENCY_CONFLICT'); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}(?![\s\S])/u.test(v);
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= min;
const hashText = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[0-9a-f]{64}$/u.test(v);
const text = (v: unknown, min: number, max: number): v is string => typeof v === 'string'
  && [...v].length >= min && [...v].length <= max && Buffer.from(v, 'utf8').toString('utf8') === v;
const token = (v: unknown): v is string => text(v, 16, 512);
const stamp = (ms: number): string => new Date(ms).toISOString();
function date(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const ms = Date.parse(v);
  return integer(ms) && ms <= DATE_MAX && stamp(ms) === v;
}
function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}
function closed(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!record(v)) return false;
  const own = Reflect.ownKeys(v);
  return own.length === keys.length && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    return d?.enumerable === true && Object.hasOwn(d, 'value');
  });
}
function bytes(raw: unknown, max: number): Uint8Array {
  if (!(raw instanceof Uint8Array) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw))
    || !(raw.buffer instanceof ArrayBuffer) || raw.byteLength < 1 || raw.byteLength > max) return unavailable();
  return new Uint8Array(raw);
}
function sameHash(a: string, b: string): boolean {
  return hashText(a) && hashText(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function captureDevice(raw: unknown): Device {
  if (!closed(raw, ['deviceId', 'installationId', 'deviceName', 'createdAt', 'issuedAt', 'deviceEpoch', 'generation', 'revoked', 'accessHash', 'accessExpiresAt', 'refreshHash', 'refreshExpiresAt'])
    || !id(raw.deviceId) || !id(raw.installationId) || !text(raw.deviceName, 1, 100)
    || !date(raw.createdAt) || !date(raw.issuedAt) || !integer(raw.deviceEpoch, 1) || !integer(raw.generation, 1)
    || typeof raw.revoked !== 'boolean' || !hashText(raw.accessHash) || !hashText(raw.refreshHash)
    || !date(raw.accessExpiresAt) || !date(raw.refreshExpiresAt)
    || Date.parse(raw.createdAt) > Date.parse(raw.issuedAt)
    || Date.parse(raw.accessExpiresAt) !== Date.parse(raw.issuedAt) + ACCESS_MS
    || Date.parse(raw.refreshExpiresAt) !== Date.parse(raw.issuedAt) + REFRESH_MS) return unavailable();
  return raw as unknown as Device;
}
function capturePermit(raw: unknown): Permit {
  if (!closed(raw, ['secretHash', 'issuedAt', 'expiresAt']) || !hashText(raw.secretHash)
    || !date(raw.issuedAt) || !date(raw.expiresAt)
    || Date.parse(raw.expiresAt) !== Date.parse(raw.issuedAt) + PAIRING_MS) return unavailable();
  return raw as unknown as Permit;
}
function captureReceipt(raw: unknown, serverId: string): Receipt {
  if (!closed(raw, ['operation', 'originHash', 'keyHash', 'fingerprint', 'deviceId', 'deviceEpoch', 'generation', 'issuedAt', 'commitId', 'tokenPair'])
    || (raw.operation !== 'claimPairing' && raw.operation !== 'refreshToken') || !hashText(raw.originHash)
    || !hashText(raw.keyHash) || !hashText(raw.fingerprint) || !id(raw.deviceId)
    || !integer(raw.deviceEpoch, 1) || !integer(raw.generation, 1) || !date(raw.issuedAt) || !id(raw.commitId)
    || !closed(raw.tokenPair, ['deviceId', 'accessToken', 'accessExpiresAt', 'refreshToken', 'refreshExpiresAt', 'serverId'])) return unavailable();
  const pair = mobileCommonResponseSnapshot('tokenPair', raw.tokenPair);
  if (!pair.ok || pair.value.deviceId !== raw.deviceId || pair.value.serverId !== serverId
    || !token(pair.value.accessToken) || !token(pair.value.refreshToken) || pair.value.accessToken === pair.value.refreshToken
    || !date(pair.value.accessExpiresAt) || !date(pair.value.refreshExpiresAt)
    || Date.parse(pair.value.accessExpiresAt) !== Date.parse(raw.issuedAt) + ACCESS_MS
    || Date.parse(pair.value.refreshExpiresAt) !== Date.parse(raw.issuedAt) + REFRESH_MS) return unavailable();
  return { ...(raw as unknown as Receipt), tokenPair: pair.value };
}

/** Main 内存中的唯一鉴权实例；文件、SQLite 与真正持久提交由原 Owner 端口负责。 */
export function createMobileAuthService(options: MobileAuthServiceOptions): MobileAuthService {
  const { persistence, crypto, serverId, datasetId, displayName, environment } = options;
  if (!id(serverId) || !id(datasetId) || !text(displayName, 1, 1024)
    || !['development', 'production'].includes(environment)) return invalid();
  const readClock = options.now ?? Date.now;
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  let floor = 0, observedRevision = 0, closing = false, fatal = false, pending: UnknownSave | undefined;
  let tail: Promise<void> = Promise.resolve(), closingFlight: Promise<void> | undefined;
  let principals = new WeakMap<MobilePrincipal, PrincipalBrand>();
  const fences = new Map<string, number>();
  const digest = (domain: string, value: string) => createHash('sha256')
    .update(JSON.stringify(['MBM001_AUTH_V1', serverId, datasetId, domain, value])).digest('hex');
  const aad = (revision: number) => Buffer.from(JSON.stringify(['MBM001_AUTH_STATE_V1', serverId, datasetId, revision]));
  const encode = (state: State) => JSON.stringify(state);
  function now(state: State): number {
    const v = readClock();
    if (!integer(v) || v > DATE_MAX - REFRESH_MS) return unavailable();
    floor = Math.max(floor, state.clockFloor, v);
    return floor;
  }
  function empty(): State {
    return { schema: STATE_SCHEMA, serverId, datasetId, revision: 0, commitId: null,
      clockFloor: 0, devices: [], permits: [], receipts: [] };
  }
  function captureState(raw: Uint8Array, revision: number, commitId: string): State {
    if (raw.byteLength > MOBILE_AUTH_STATE_MAX_BYTES) return unavailable();
    const parsed = parseMobileJson(raw, PRIVATE_LIMITS);
    if (!parsed.ok || !closed(parsed.value, ['schema', 'serverId', 'datasetId', 'revision', 'commitId', 'clockFloor', 'devices', 'permits', 'receipts'])) return unavailable();
    const v = parsed.value;
    if (v.schema !== STATE_SCHEMA || v.serverId !== serverId || v.datasetId !== datasetId
      || v.revision !== revision || v.commitId !== commitId || !integer(v.clockFloor) || v.clockFloor > DATE_MAX - REFRESH_MS
      || !Array.isArray(v.devices) || v.devices.length > MOBILE_AUTH_MAX_DEVICES
      || !Array.isArray(v.permits) || v.permits.length > MOBILE_AUTH_MAX_PAIRINGS
      || !Array.isArray(v.receipts) || v.receipts.length > MOBILE_AUTH_MAX_RECEIPTS) return unavailable();
    const devices = v.devices.map(captureDevice), permits = v.permits.map(capturePermit);
    const receipts = v.receipts.map(item => captureReceipt(item, serverId));
    if (new Set(devices.map(d => d.deviceId)).size !== devices.length
      || new Set(devices.map(d => d.installationId)).size !== devices.length
      || new Set(devices.map(d => d.accessHash)).size !== devices.length
      || new Set(devices.map(d => d.refreshHash)).size !== devices.length
      || new Set(permits.map(p => p.secretHash)).size !== permits.length
      || new Set(receipts.map(r => `${r.operation}:${r.deviceId}:${r.keyHash}`)).size !== receipts.length) return unavailable();
    for (const d of devices) if (Date.parse(d.issuedAt) > v.clockFloor) return unavailable();
    for (const p of permits) if (Date.parse(p.issuedAt) > v.clockFloor) return unavailable();
    for (const r of receipts) {
      const d = devices.find(candidate => candidate.deviceId === r.deviceId);
      if (!d || r.deviceEpoch > d.deviceEpoch || r.generation > d.generation
        || Date.parse(r.issuedAt) < Date.parse(d.createdAt) || Date.parse(r.issuedAt) > v.clockFloor) return unavailable();
      if (r.deviceEpoch === d.deviceEpoch && r.generation === d.generation
        && (!sameHash(d.accessHash, digest('access', r.tokenPair.accessToken))
          || !sameHash(d.refreshHash, digest('refresh', r.tokenPair.refreshToken))
          || d.accessExpiresAt !== r.tokenPair.accessExpiresAt || d.refreshExpiresAt !== r.tokenPair.refreshExpiresAt)) return unavailable();
    }
    return { schema: STATE_SCHEMA, serverId, datasetId, revision, commitId, clockFloor: v.clockFloor, devices, permits, receipts };
  }
  async function load(): Promise<State> {
    let raw: MobileSealedState;
    try { raw = await persistence.load(datasetId); }
    catch { if (!pending) fatal = true; return unavailable(); }
    try {
      if (closed(raw, ['kind', 'datasetId', 'revision']) && raw.kind === 'missing'
        && raw.datasetId === datasetId && raw.revision === 0) {
        if (pending || observedRevision !== 0) return unavailable();
        return empty();
      }
      if (!closed(raw, ['kind', 'datasetId', 'revision', 'commitId', 'sealed']) || raw.kind !== 'sealed'
        || raw.datasetId !== datasetId || !integer(raw.revision, 1) || raw.revision < observedRevision || !id(raw.commitId)) return unavailable();
      const sealed = bytes(raw.sealed, MOBILE_AUTH_SEALED_MAX_BYTES);
      let plain: Uint8Array;
      try { plain = bytes(crypto.open(sealed, aad(raw.revision)), MOBILE_AUTH_STATE_MAX_BYTES); }
      finally { sealed.fill(0); }
      let state: State;
      try { state = captureState(plain, raw.revision, raw.commitId); }
      finally { plain.fill(0); }
      if (pending) {
        // 不确定提交只核同一份真实原记录；缺记录、别的revision不能触发补发。
        if (state.commitId !== pending.state.commitId || state.revision !== pending.state.revision
          || encode(state) !== pending.plain) return unavailable();
        pending = undefined;
      }
      observedRevision = state.revision;
      return state;
    } catch {
      if (!pending) fatal = true;
      return unavailable();
    }
  }
  function run<T>(operation: (state: State) => T | Promise<T>): Promise<T> {
    if (closing || fatal) return Promise.reject(new MobileServiceError(503, 'BUSY'));
    const result = tail.then(async () => {
      if (fatal) return unavailable();
      return operation(await load());
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  function bump(deviceId: string): void {
    const previous = fences.get(deviceId) ?? 0;
    if (!integer(previous) || previous === Number.MAX_SAFE_INTEGER) return unavailable();
    fences.set(deviceId, previous + 1);
  }
  function prune(state: State, at: number): void {
    state.permits = state.permits.filter(p => Date.parse(p.expiresAt) > at);
    // 仅已到refresh期限的确定终态回执可移除；UNKNOWN实例不会进入此处。
    state.receipts = state.receipts.filter(r => Date.parse(r.tokenPair.refreshExpiresAt) > at);
  }
  function availableReceipt(state: State): void {
    if (state.receipts.length >= MOBILE_AUTH_MAX_RECEIPTS) return unavailable();
  }
  function mint(state: State, additional: readonly string[] = []): string {
    for (let attempt = 0; attempt < 4; attempt++) {
      const value = randomToken();
      if (!token(value)) return unavailable();
      if (additional.includes(value)
        || state.permits.some(p => sameHash(p.secretHash, digest('pairing', value)))
        || state.devices.some(d => sameHash(d.accessHash, digest('access', value)) || sameHash(d.refreshHash, digest('refresh', value)))
        || state.receipts.some(r => r.tokenPair.accessToken === value || r.tokenPair.refreshToken === value
          || sameHash(r.originHash, digest(r.operation === 'claimPairing' ? 'pairing' : 'refresh', value)))) continue;
      return value;
    }
    return unavailable();
  }
  function key(value: string): string {
    if (!text(value, 1, 128) || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
    return digest('idempotency-key', value);
  }
  function fingerprint(operation: Receipt['operation'], body: MobilePairingClaim | MobileRefreshRequest): string {
    const captured = operation === 'claimPairing'
      ? mobileCommonRequestSnapshot('pairingClaim', body) : mobileCommonRequestSnapshot('refresh', body);
    if (!captured.ok) return invalid();
    return digest(`body:${operation}`, mobileCanonicalJson(captured.value as unknown as import('@music-bridge/contracts').MobileJsonValue));
  }
  function replay(state: State, receipt: Receipt, bodyHash: string, at: number): MobileTokenPair {
    if (!sameHash(receipt.fingerprint, bodyHash)) return conflict();
    const d = state.devices.find(device => device.deviceId === receipt.deviceId);
    if (!d || d.revoked || d.deviceEpoch !== receipt.deviceEpoch || d.generation !== receipt.generation
      || Date.parse(receipt.tokenPair.refreshExpiresAt) <= at) return denied();
    return { ...receipt.tokenPair };
  }
  function tokens(state: State, deviceId: string, at: number): MobileTokenPair {
    const accessToken = mint(state), refreshToken = mint(state, [accessToken]);
    return { deviceId, accessToken, accessExpiresAt: stamp(at + ACCESS_MS), refreshToken,
      refreshExpiresAt: stamp(at + REFRESH_MS), serverId };
  }
  async function save(state: State): Promise<void> {
    if (pending || !integer(state.revision) || state.revision === Number.MAX_SAFE_INTEGER) return unavailable();
    const previousRevision = state.revision;
    state.revision++;
    state.commitId = randomUUID();
    const latest = state.receipts.at(-1);
    if (latest && latest.commitId === '') latest.commitId = state.commitId;
    const plainText = encode(state), plain = Buffer.from(plainText);
    if (plain.byteLength > MOBILE_AUTH_STATE_MAX_BYTES) { plain.fill(0); return unavailable(); }
    let sealed: Uint8Array;
    try {
      // 自己即将保存的内容也走完整冷核，不以类型声明代替身份认证。
      captureState(plain, state.revision, state.commitId);
      sealed = bytes(crypto.seal(plain, aad(state.revision)), MOBILE_AUTH_SEALED_MAX_BYTES);
    } catch { return unavailable(); }
    finally { plain.fill(0); }
    const candidate: UnknownSave = { state, plain: plainText };
    try {
      const result = await persistence.save({ datasetId, expectedRevision: previousRevision, commitId: state.commitId, sealed });
      if (closed(result, ['kind', 'datasetId', 'currentRevision']) && result.kind === 'conflict'
        && result.datasetId === datasetId && integer(result.currentRevision)
        && result.currentRevision > previousRevision) throw new MobileServiceError(409, 'REVISION_CONFLICT');
      if (!closed(result, ['kind', 'datasetId', 'revision', 'commitId']) || result.kind !== 'saved'
        || result.datasetId !== datasetId || result.revision !== state.revision || result.commitId !== state.commitId) {
        pending = candidate; return unavailable();
      }
      observedRevision = state.revision;
    } catch (error) {
      if (error instanceof MobileServiceError && error.code === 'REVISION_CONFLICT') throw error;
      if (!(error instanceof MobileAuthPersistenceError) || error.outcome !== 'not-sent') pending = candidate;
      return unavailable();
    } finally { sealed.fill(0); }
  }
  function current(state: State, principal: MobilePrincipal, at: number): Device {
    const brand = principal !== null && typeof principal === 'object' ? principals.get(principal) : undefined;
    if (!brand || closing || fatal || pending) return denied();
    const d = state.devices.find(device => device.deviceId === brand.deviceId);
    if (!d || d.revoked || (fences.get(d.deviceId) ?? 0) !== brand.fence
      || principal.serverId !== serverId || principal.datasetId !== datasetId || principal.accountDomain !== `local:${datasetId}`
      || principal.deviceId !== d.deviceId || principal.deviceEpoch !== d.deviceEpoch || principal.generation !== d.generation
      || !sameHash(principal.accessTokenHash, d.accessHash) || principal.accessExpiresAt !== d.accessExpiresAt
      || Date.parse(d.accessExpiresAt) <= at) return denied();
    return d;
  }
  function advance(value: number): number {
    if (!integer(value, 1) || value === Number.MAX_SAFE_INTEGER) return unavailable();
    return value + 1;
  }
  const service: MobileAuthService = {
    serverInfo: () => run(() => ({ serverId, displayName, contractVersion: '0.1.0' as const, environment })),
    issuePairing: () => run(async state => {
      const at = now(state); prune(state, at);
      if (state.permits.length >= MOBILE_AUTH_MAX_PAIRINGS) return unavailable();
      const pairingSecret = mint(state), expiresAt = stamp(at + PAIRING_MS);
      state.permits.push({ secretHash: digest('pairing', pairingSecret), issuedAt: stamp(at), expiresAt });
      state.clockFloor = at;
      await save(state);
      return { pairingSecret, expiresAt };
    }),
    devices: () => run(state => state.devices.map(d => Object.freeze({ deviceId: d.deviceId, deviceName: d.deviceName, createdAt: d.createdAt, revoked: d.revoked }))),
    revokeDevice: deviceId => run(async state => {
      if (!id(deviceId)) return invalid();
      const d = state.devices.find(device => device.deviceId === deviceId);
      if (!d) throw new MobileServiceError(404, 'INVALID_REQUEST');
      if (d.revoked) return;
      const at = now(state); prune(state, at); bump(d.deviceId);
      d.deviceEpoch = advance(d.deviceEpoch); d.revoked = true; state.clockFloor = at;
      await save(state);
    }),
    claim: (body, idempotencyKey) => run(async state => {
      const captured = mobileCommonRequestSnapshot('pairingClaim', body);
      if (!captured.ok) return invalid();
      const incoming = captured.value, keyHash = key(idempotencyKey), bodyHash = fingerprint('claimPairing', incoming);
      const originHash = digest('pairing', incoming.pairingSecret), at = now(state);
      const prior = state.receipts.find(r => r.operation === 'claimPairing' && sameHash(r.originHash, originHash) && sameHash(r.keyHash, keyHash));
      if (prior) return replay(state, prior, bodyHash, at);
      const permit = state.permits.find(p => sameHash(p.secretHash, originHash));
      if (!permit || Date.parse(permit.expiresAt) <= at) return denied();
      let d = state.devices.find(device => device.installationId === incoming.installationId);
      const previousDeviceId = d?.deviceId;
      if (previousDeviceId && state.receipts.some(r => r.operation === 'claimPairing' && r.deviceId === previousDeviceId && sameHash(r.keyHash, keyHash))) return conflict();
      prune(state, at); availableReceipt(state);
      if (!d && state.devices.length >= MOBILE_AUTH_MAX_DEVICES) return unavailable();
      const deviceId = d?.deviceId ?? randomUUID(), pair = tokens(state, deviceId, at);
      if (d) {
        bump(d.deviceId); d.deviceEpoch = advance(d.deviceEpoch); d.generation = advance(d.generation);
        d.deviceName = incoming.deviceName;
      } else {
        d = { deviceId, installationId: incoming.installationId, deviceName: incoming.deviceName,
          createdAt: stamp(at), issuedAt: stamp(at), deviceEpoch: 1, generation: 1, revoked: false,
          accessHash: '', accessExpiresAt: pair.accessExpiresAt, refreshHash: '', refreshExpiresAt: pair.refreshExpiresAt };
        state.devices.push(d);
      }
      d.revoked = false; d.issuedAt = stamp(at); d.accessHash = digest('access', pair.accessToken);
      d.refreshHash = digest('refresh', pair.refreshToken); d.accessExpiresAt = pair.accessExpiresAt; d.refreshExpiresAt = pair.refreshExpiresAt;
      state.permits = state.permits.filter(p => !sameHash(p.secretHash, originHash));
      state.receipts.push({ operation: 'claimPairing', originHash, keyHash, fingerprint: bodyHash,
        deviceId, deviceEpoch: d.deviceEpoch, generation: d.generation, issuedAt: stamp(at), commitId: '', tokenPair: pair });
      state.clockFloor = at;
      await save(state);
      return { ...pair };
    }),
    refresh: (body, idempotencyKey) => run(async state => {
      const captured = mobileCommonRequestSnapshot('refresh', body);
      if (!captured.ok) return invalid();
      const incoming = captured.value, keyHash = key(idempotencyKey), bodyHash = fingerprint('refreshToken', incoming);
      const originHash = digest('refresh', incoming.refreshToken), at = now(state);
      const prior = state.receipts.find(r => r.operation === 'refreshToken' && sameHash(r.originHash, originHash) && sameHash(r.keyHash, keyHash));
      if (prior) return replay(state, prior, bodyHash, at);
      const d = state.devices.find(device => sameHash(device.refreshHash, originHash));
      if (!d || d.revoked || Date.parse(d.refreshExpiresAt) <= at) return denied();
      if (state.receipts.some(r => r.operation === 'refreshToken' && r.deviceId === d.deviceId && sameHash(r.keyHash, keyHash))) return conflict();
      prune(state, at); availableReceipt(state);
      const pair = tokens(state, d.deviceId, at);
      bump(d.deviceId); d.generation = advance(d.generation); d.issuedAt = stamp(at);
      d.accessHash = digest('access', pair.accessToken); d.refreshHash = digest('refresh', pair.refreshToken);
      d.accessExpiresAt = pair.accessExpiresAt; d.refreshExpiresAt = pair.refreshExpiresAt;
      state.receipts.push({ operation: 'refreshToken', originHash, keyHash, fingerprint: bodyHash,
        deviceId: d.deviceId, deviceEpoch: d.deviceEpoch, generation: d.generation, issuedAt: stamp(at), commitId: '', tokenPair: pair });
      state.clockFloor = at;
      await save(state);
      return { ...pair };
    }),
    authenticate: accessToken => run(state => {
      if (!token(accessToken)) return denied();
      const at = now(state), hash = digest('access', accessToken);
      const d = state.devices.find(device => !device.revoked && sameHash(device.accessHash, hash));
      if (!d || Date.parse(d.accessExpiresAt) <= at || closing) return denied();
      const principal = Object.freeze({ serverId, datasetId, deviceId: d.deviceId, accountDomain: `local:${datasetId}`,
        deviceEpoch: d.deviceEpoch, generation: d.generation, accessTokenHash: d.accessHash, accessExpiresAt: d.accessExpiresAt });
      principals.set(principal, { deviceId: d.deviceId, fence: fences.get(d.deviceId) ?? 0 });
      return principal;
    }),
    assertCurrent: principal => run(state => { current(state, principal, now(state)); }),
    logout: principal => run(async state => {
      const at = now(state), d = current(state, principal, at);
      prune(state, at); bump(d.deviceId);
      d.deviceEpoch = advance(d.deviceEpoch); d.revoked = true; state.clockFloor = at;
      await save(state);
    }),
    close() {
      if (closingFlight) return closingFlight;
      closing = true;
      closingFlight = tail.then(() => { principals = new WeakMap(); fences.clear(); pending = undefined; });
      return closingFlight;
    },
  };
  return service;
}
