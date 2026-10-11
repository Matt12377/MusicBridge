import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  MOBILE_CODEC_LIMITS, isMobileId, mobileCanonicalJson, mobileDataSnapshot,
  mobileInteger, mobileRecord, mobileUtf8Bytes, parseMobileJson,
} from '@music-bridge/contracts';
import type { MobileJsonValue } from '@music-bridge/contracts';
import {
  captureMobileContentScope, isMobileContentOperation,
} from './content-types.js';
import type { MobileContentPageScope } from './content-types.js';
import { MobileServiceError } from './types.js';

export const MOBILE_CONTENT_CURSOR_MAX_BYTES = 2048;
export const MOBILE_CONTENT_CURSOR_TTL_MS = 300_000;
const domain = 'MusicBridge:MBM004:CONTENT_CURSOR:1\0';
const queryDomain = 'MusicBridge:MBM004:CONTENT_QUERY:1\0';
const queryKeys = ['scope', 'operation', 'source', 'parentId', 'kind', 'filterHash', 'sort', 'limit'] as const;
const claimKeys = ['v', 'queryHash', 'revision', 'offset', 'issuedAtMs', 'expiresAtMs'] as const;
const limits = { ...MOBILE_CODEC_LIMITS, requestBytes: MOBILE_CONTENT_CURSOR_MAX_BYTES };
const closed = (value: Record<string, unknown>, names: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const invalid = (): never => { throw new MobileServiceError(409, 'CURSOR_INVALID'); };

export interface MobileContentCursorClaims {
  v: 1;
  queryHash: string;
  revision: string;
  offset: number;
  issuedAtMs: number;
  expiresAtMs: number;
}
export interface MobileContentCursorIssue {
  query: MobileContentPageScope;
  revision: string;
  offset: number;
}

/** 全部查询与当前权限围栏均入摘要；不在 token 中放账号和目录元数据。 */
export function captureMobileContentPageScope(raw: unknown): Readonly<MobileContentPageScope> {
  const captured = mobileDataSnapshot(raw, limits, 'request');
  if (!captured.ok || !mobileRecord(captured.value)) throw new MobileServiceError(400, 'INVALID_REQUEST');
  const value = captured.value;
  if (!closed(value, queryKeys) || !isMobileContentOperation(value.operation)
    || !['local', 'netease', 'all'].includes(String(value.source))
    || value.parentId !== null && !isMobileId(value.parentId)
    || value.kind !== null && value.kind !== 'playlist' && value.kind !== 'chart'
    || !hash(value.filterHash) || !isMobileId(value.sort) || !mobileInteger(value.limit, 1, 100)) {
    throw new MobileServiceError(400, 'INVALID_REQUEST');
  }
  const scope = captureMobileContentScope(value.scope);
  return Object.freeze({ ...value, scope } as unknown as MobileContentPageScope);
}

function queryHash(raw: unknown): string {
  const scope = captureMobileContentPageScope(raw);
  return createHash('sha256').update(queryDomain)
    .update(mobileCanonicalJson(scope as unknown as MobileJsonValue)).digest('hex');
}
function claims(raw: unknown): Readonly<MobileContentCursorClaims> {
  if (!mobileRecord(raw) || !closed(raw, claimKeys) || raw.v !== 1 || !hash(raw.queryHash)
    || !isMobileId(raw.revision) || !mobileInteger(raw.offset, 1)
    || !mobileInteger(raw.issuedAtMs) || !mobileInteger(raw.expiresAtMs)
    || raw.expiresAtMs - raw.issuedAtMs !== MOBILE_CONTENT_CURSOR_TTL_MS) return invalid();
  return Object.freeze(raw as unknown as MobileContentCursorClaims);
}

export function createMobileContentCursorCodec(options: { key: Uint8Array; now?: () => number }) {
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32
    || options.key.buffer instanceof SharedArrayBuffer) throw new MobileServiceError(400, 'INVALID_REQUEST');
  const key = Buffer.from(options.key), now = options.now ?? Date.now;
  let disposed = false;
  const signature = (payload: string): Buffer => createHmac('sha256', key).update(domain).update(payload).digest();
  function clock(): number { const value = now(); return mobileInteger(value) ? value : invalid(); }
  return {
    issue(facts: MobileContentCursorIssue): string {
      if (disposed) return invalid();
      const captured = mobileDataSnapshot(facts, MOBILE_CODEC_LIMITS, 'request');
      if (!captured.ok || !mobileRecord(captured.value) || !closed(captured.value, ['query', 'revision', 'offset'])
        || !isMobileId(captured.value.revision) || !mobileInteger(captured.value.offset, 1)) return invalid();
      const issuedAtMs = clock(), expiresAtMs = issuedAtMs + MOBILE_CONTENT_CURSOR_TTL_MS;
      if (!mobileInteger(expiresAtMs)) return invalid();
      const value = claims({ v: 1, queryHash: queryHash(captured.value.query), revision: captured.value.revision,
        offset: captured.value.offset, issuedAtMs, expiresAtMs });
      const payload = Buffer.from(mobileCanonicalJson(value as unknown as MobileJsonValue), 'utf8').toString('base64url');
      const token = `mc4.${payload}.${signature(payload).toString('base64url')}`;
      if (mobileUtf8Bytes(token) > MOBILE_CONTENT_CURSOR_MAX_BYTES) return invalid();
      return token;
    },
    open(token: string, expected: MobileContentPageScope): Readonly<MobileContentCursorClaims> {
      if (disposed) return invalid();
      if (typeof token !== 'string' || mobileUtf8Bytes(token) > MOBILE_CONTENT_CURSOR_MAX_BYTES) return invalid();
      const match = /^mc4\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token);
      if (!match) return invalid();
      const payload = match[1]!, encodedSignature = match[2]!;
      const decoded = Buffer.from(payload, 'base64url'), suppliedSignature = Buffer.from(encodedSignature, 'base64url');
      if (decoded.toString('base64url') !== payload || suppliedSignature.length !== 32
        || suppliedSignature.toString('base64url') !== encodedSignature
        || !timingSafeEqual(suppliedSignature, signature(payload))) return invalid();
      const parsed = parseMobileJson(decoded, limits, 'request');
      if (!parsed.ok) return invalid();
      const value = claims(parsed.value);
      let expectedHash: string;
      try { expectedHash = queryHash(expected); } catch { return invalid(); }
      if (value.queryHash !== expectedHash) return invalid();
      const current = clock();
      if (value.issuedAtMs > current || current >= value.expiresAtMs) return invalid();
      return value;
    },
    close(): void { disposed = true; key.fill(0); },
  };
}
