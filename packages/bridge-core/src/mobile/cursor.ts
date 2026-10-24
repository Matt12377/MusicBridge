import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MOBILE_CODEC_LIMITS, isMobileId, mobileCanonicalJson, mobileDataSnapshot,
  mobileInteger, mobileRecord, mobileUtf8Bytes, parseMobileJson,
} from '@music-bridge/contracts';
import { MobileServiceError } from './types.js';

/** 仅本域服务器签发；不是公开查询结构或可重签的客户端读取事实。 */
export const MOBILE_CATALOG_CURSOR_MAX_BYTES = 2048;
export const MOBILE_CATALOG_CURSOR_TTL_MS = 300_000;
const domain = 'MusicBridge:MBM001:CATALOG_CURSOR:1\0';
const continuationDomain = 'MusicBridge:MBM001:CATALOG_CURSOR:2\0';
const queryKeys = ['operation', 'serverId', 'deviceId', 'datasetId', 'accountDomain',
  'deviceEpoch', 'generation', 'source', 'sort', 'filter', 'albumId', 'limit'] as const;
const claimKeys = [...queryKeys, 'v', 'ownerEpoch', 'libraryRevision', 'offset', 'issuedAtMs', 'expiresAtMs'] as const;

export interface MobileCatalogCursorQueryScope {
  operation: 'listAlbums' | 'listTracks';
  serverId: string; deviceId: string; datasetId: string; accountDomain: string;
  deviceEpoch: number; generation: number; source: 'local' | 'netease';
  sort: string; filter: string; albumId: string | null; limit: number;
}
export interface MobileCatalogCursorClaims extends MobileCatalogCursorQueryScope {
  v: 1 | 2; ownerEpoch: string; libraryRevision: string; offset: number;
  issuedAtMs: number; expiresAtMs: number;
}
export type MobileCatalogCursorIssue = MobileCatalogCursorQueryScope & {
  ownerEpoch: string; libraryRevision: string; offset: number;
};
const invalid = (): never => { throw new MobileServiceError(409, 'CURSOR_INVALID'); };
const closed = (value: Record<string, unknown>, names: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function queryScope(value: Record<string, unknown>): boolean {
  return (value.operation === 'listAlbums' || value.operation === 'listTracks')
    && ['serverId', 'deviceId', 'datasetId', 'accountDomain'].every(key => isMobileId(value[key]))
    && mobileInteger(value.deviceEpoch, 1) && mobileInteger(value.generation, 1)
    && (value.source === 'local' || value.source === 'netease') && isMobileId(value.sort)
    && typeof value.filter === 'string' && /^[a-f0-9]{64}$/u.test(value.filter)
    && (value.albumId === null || isMobileId(value.albumId))
    && mobileInteger(value.limit, 1, 100);
}
function readClaims(value: unknown, version: 1 | 2): MobileCatalogCursorClaims {
  if (!mobileRecord(value) || !closed(value, claimKeys) || !queryScope(value)
    || value.v !== version || !isMobileId(value.ownerEpoch) || !isMobileId(value.libraryRevision)
    || !mobileInteger(value.offset, 1) || !mobileInteger(value.issuedAtMs)
    || !mobileInteger(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs
    || value.expiresAtMs - value.issuedAtMs > MOBILE_CATALOG_CURSOR_TTL_MS) return invalid();
  return value as unknown as MobileCatalogCursorClaims;
}

export function createMobileCatalogCursorCodec(options: {
  key: Uint8Array; now?: () => number; version?: 1 | 2;
}) {
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32
    || options.version !== undefined && options.version !== 1 && options.version !== 2) {
    throw new MobileServiceError(400, 'INVALID_REQUEST');
  }
  const key = Buffer.from(options.key), now = options.now ?? Date.now, version = options.version ?? 1;
  let disposed = false;
  const limits = { ...MOBILE_CODEC_LIMITS, requestBytes: MOBILE_CATALOG_CURSOR_MAX_BYTES };
  const signature = (payload: string): Buffer => createHmac('sha256', key)
    .update(version === 1 ? domain : continuationDomain).update(payload).digest();
  function clock(): number { const value = now(); return mobileInteger(value) ? value : invalid(); }
  return {
    issue(facts: MobileCatalogCursorIssue): string {
      if (disposed) return invalid();
      const captured = mobileDataSnapshot(facts, limits, 'request');
      if (!captured.ok || !mobileRecord(captured.value)
        || !closed(captured.value, [...queryKeys, 'ownerEpoch', 'libraryRevision', 'offset'])) return invalid();
      const issuedAtMs = clock(), expiresAtMs = issuedAtMs + MOBILE_CATALOG_CURSOR_TTL_MS;
      if (!mobileInteger(expiresAtMs)) return invalid();
      const claims = readClaims({ ...captured.value, v: version, issuedAtMs, expiresAtMs }, version);
      const payload = Buffer.from(mobileCanonicalJson(claims as unknown as Parameters<typeof mobileCanonicalJson>[0]), 'utf8').toString('base64url');
      const token = `mc${version}.${payload}.${signature(payload).toString('base64url')}`;
      if (mobileUtf8Bytes(token) > MOBILE_CATALOG_CURSOR_MAX_BYTES) return invalid();
      return token;
    },
    open(token: string, expected: MobileCatalogCursorQueryScope): MobileCatalogCursorClaims {
      if (disposed) return invalid();
      if (typeof token !== 'string' || mobileUtf8Bytes(token) > MOBILE_CATALOG_CURSOR_MAX_BYTES) return invalid();
      const parts = (version === 1 ? /^mc1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u
        : /^mc2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u).exec(token);
      if (!parts) return invalid();
      const payload = parts[1]!, encodedSignature = parts[2]!;
      const decoded = Buffer.from(payload, 'base64url'), suppliedSignature = Buffer.from(encodedSignature, 'base64url');
      if (decoded.toString('base64url') !== payload || suppliedSignature.length !== 32
        || suppliedSignature.toString('base64url') !== encodedSignature
        || !timingSafeEqual(suppliedSignature, signature(payload))) return invalid();
      const parsed = parseMobileJson(decoded, limits, 'request');
      if (!parsed.ok) return invalid();
      const claims = readClaims(parsed.value, version), captured = mobileDataSnapshot(expected, limits, 'request');
      if (!captured.ok || !mobileRecord(captured.value) || !closed(captured.value, queryKeys)
        || !queryScope(captured.value)) return invalid();
      const expectedScope = captured.value;
      // mc1保留逐项相等；mc2只把generation作为签名审计下界，不允许未来授权借旧principal。
      // 真实品牌/令牌/撤销仍由每次Service读取前后及发送前的原assertCurrent处理。
      if (!queryKeys.every(name => version === 2 && name === 'generation'
        ? claims.generation <= Number(expectedScope.generation) : claims[name] === expectedScope[name])) return invalid();
      const current = clock();
      if (claims.issuedAtMs > current || current >= claims.expiresAtMs) return invalid();
      return claims;
    },
    close(): void { disposed = true; key.fill(0); },
  };
}
