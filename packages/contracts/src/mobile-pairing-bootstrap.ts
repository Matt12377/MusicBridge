import { MOBILE_CODEC_LIMITS, MOBILE_ID_SCHEMA, mobileDataSnapshot, mobileFailure,
  mobileSchemaSnapshot } from './mobile-common.js';
import type { MobileDecodeResult, MobileSchemaRegistry } from './mobile-common.js';

/** 独立配对引导层；不修改既有移动操作表、长许可或令牌合同。二进制字段统一小写十六进制。 */
export const MOBILE_PAIRING_BOOTSTRAP_VERSION = 1 as const;
export const MOBILE_PAIRING_BOOTSTRAP_SUITE = 'srp6a-3072-sha512' as const;
export const MOBILE_PAIRING_BOOTSTRAP_MAX_BODY_BYTES = 8192;
export const MOBILE_PAIRING_BOOTSTRAP_TOKEN_INFO = 'Mousa Pairing Bootstrap v1 token';
export const MOBILE_PAIRING_BOOTSTRAP_FINISH_INFO = 'Mousa Pairing Bootstrap v1 finish';

export interface MobilePairingBeginRequest {
  protocolVersion: 1; serverId: string; certificateSha256: string;
  installationId: string; deviceName: string; clientNonce: string; claimIdempotencyKey: string;
}
export interface MobilePairingBeginReply {
  protocolVersion: 1; requestId: string; serverId: string; origin: string; certificateSha256: string;
  serverNonce: string; salt: string; serverPublicKey: string; expiresAt: string;
}
export interface MobilePairingExchangeRequest { clientPublicKey: string; clientProof: string }
export interface MobilePairingExchangeReply { serverProof: string }
export interface MobilePairingFinishRequest { clientConfirmation: string }
export interface MobilePairingFinishReply { nonce: string; ciphertext: string; tag: string }
export type MobilePairingBootstrapRoute =
  | { operation: 'begin'; requestId: null; body: MobilePairingBeginRequest }
  | { operation: 'exchange'; requestId: string; body: MobilePairingExchangeRequest }
  | { operation: 'finish'; requestId: string; body: MobilePairingFinishRequest }
  | { operation: 'cancel'; requestId: string; body: null };

export interface MobilePairingBootstrapBinding {
  requestId: string; serverId: string; origin: string; certificateSha256: string;
  installationId: string; deviceName: string; clientNonce: string; serverNonce: string;
  claimIdempotencyKey: string; expiresAt: string;
}

const hex = (bytes: number) => ({ type: 'string', minLength: bytes * 2, maxLength: bytes * 2,
  pattern: `^[0-9a-f]{${bytes * 2}}(?![\\s\\S])` } as const);
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength } as const);
export const MOBILE_PAIRING_BOOTSTRAP_SCHEMAS: MobileSchemaRegistry = {
  BeginRequest: { type: 'object', additionalProperties: false,
    required: ['protocolVersion', 'serverId', 'certificateSha256', 'installationId', 'deviceName', 'clientNonce', 'claimIdempotencyKey'],
    properties: { protocolVersion: { type: 'integer', const: 1 }, serverId: MOBILE_ID_SCHEMA,
      certificateSha256: hex(32), installationId: MOBILE_ID_SCHEMA, deviceName: text(100),
      clientNonce: hex(32), claimIdempotencyKey: text(128) } },
  BeginReply: { type: 'object', additionalProperties: false,
    required: ['protocolVersion', 'requestId', 'serverId', 'origin', 'certificateSha256', 'serverNonce', 'salt', 'serverPublicKey', 'expiresAt'],
    properties: { protocolVersion: { type: 'integer', const: 1 }, requestId: text(160), serverId: MOBILE_ID_SCHEMA,
      origin: text(100), certificateSha256: hex(32), serverNonce: hex(32), salt: hex(32),
      serverPublicKey: hex(384), expiresAt: { type: 'string', format: 'date-time' } } },
  ExchangeRequest: { type: 'object', additionalProperties: false,
    required: ['clientPublicKey', 'clientProof'], properties: { clientPublicKey: hex(384), clientProof: hex(64) } },
  ExchangeReply: { type: 'object', additionalProperties: false,
    required: ['serverProof'], properties: { serverProof: hex(64) } },
  FinishRequest: { type: 'object', additionalProperties: false,
    required: ['clientConfirmation'], properties: { clientConfirmation: hex(32) } },
  FinishReply: { type: 'object', additionalProperties: false,
    required: ['nonce', 'ciphertext', 'tag'], properties: { nonce: hex(12), tag: hex(16),
      ciphertext: { type: 'string', minLength: 2, maxLength: 16384, pattern: '^(?:[0-9a-f]{2})+(?![\\s\\S])' } } },
};
const limits = { ...MOBILE_CODEC_LIMITS, requestBytes: MOBILE_PAIRING_BOOTSTRAP_MAX_BODY_BYTES };
const safeText = (value: string) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
export const isMobilePairingRequestId = (value: string): boolean => /^pair:[0-9a-f]{48}(?![\s\S])/u.test(value);

export function captureMobilePairingBeginRequest(raw: unknown): MobileDecodeResult<MobilePairingBeginRequest> {
  const result = mobileSchemaSnapshot<MobilePairingBeginRequest>(MOBILE_PAIRING_BOOTSTRAP_SCHEMAS.BeginRequest!, raw,
    MOBILE_PAIRING_BOOTSTRAP_SCHEMAS, limits, 'request');
  return !result.ok ? result : safeText(result.value.deviceName) && safeText(result.value.claimIdempotencyKey)
    ? result : mobileFailure('INVALID_REQUEST', 'request');
}
export function captureMobilePairingExchangeRequest(raw: unknown): MobileDecodeResult<MobilePairingExchangeRequest> {
  return mobileSchemaSnapshot(MOBILE_PAIRING_BOOTSTRAP_SCHEMAS.ExchangeRequest!, raw, MOBILE_PAIRING_BOOTSTRAP_SCHEMAS, limits, 'request');
}
export function captureMobilePairingFinishRequest(raw: unknown): MobileDecodeResult<MobilePairingFinishRequest> {
  return mobileSchemaSnapshot(MOBILE_PAIRING_BOOTSTRAP_SCHEMAS.FinishRequest!, raw, MOBILE_PAIRING_BOOTSTRAP_SCHEMAS, limits, 'request');
}
export function captureMobilePairingBeginReply(raw: unknown): MobileDecodeResult<MobilePairingBeginReply> {
  const result = mobileSchemaSnapshot<MobilePairingBeginReply>(MOBILE_PAIRING_BOOTSTRAP_SCHEMAS.BeginReply!, raw,
    MOBILE_PAIRING_BOOTSTRAP_SCHEMAS);
  return !result.ok ? result : isMobilePairingRequestId(result.value.requestId)
    && /^https:\/\/[0-9]+(?:\.[0-9]+){3}(?::[1-9][0-9]{0,4})?(?![\s\S])/u.test(result.value.origin)
    ? result : mobileFailure('INVALID_RESPONSE', 'response');
}
export function captureMobilePairingExchangeReply(raw: unknown): MobileDecodeResult<MobilePairingExchangeReply> {
  return mobileSchemaSnapshot(MOBILE_PAIRING_BOOTSTRAP_SCHEMAS.ExchangeReply!, raw, MOBILE_PAIRING_BOOTSTRAP_SCHEMAS);
}
export function captureMobilePairingFinishReply(raw: unknown): MobileDecodeResult<MobilePairingFinishReply> {
  return mobileSchemaSnapshot(MOBILE_PAIRING_BOOTSTRAP_SCHEMAS.FinishReply!, raw, MOBILE_PAIRING_BOOTSTRAP_SCHEMAS);
}

export function isMobilePairingBootstrapPath(path: string): boolean {
  return /^\/mobile\/v1\/pairing-requests(?:\/[^/]+(?:\/(?:exchange|finish))?)?(?![\s\S])/u.test(path);
}
export class MobilePairingBootstrapContractError extends Error {
  constructor() { super('配对请求不符合合同。'); this.name = 'MobilePairingBootstrapContractError'; }
}
export function parseMobilePairingBootstrapRoute(input: {
  method: string; path: string; query: readonly (readonly [string, string])[]; body: unknown;
}): MobilePairingBootstrapRoute {
  const invalid = (): never => { throw new MobilePairingBootstrapContractError(); };
  const query = mobileDataSnapshot(input.query, limits, 'request');
  if (!['POST', 'DELETE'].includes(input.method) || !query.ok || !Array.isArray(query.value) || query.value.length !== 0
    || !isMobilePairingBootstrapPath(input.path)) return invalid();
  if (input.path === '/mobile/v1/pairing-requests') {
    if (input.method !== 'POST') return invalid();
    const body = captureMobilePairingBeginRequest(input.body);
    return body.ok ? { operation: 'begin', requestId: null, body: body.value } : invalid();
  }
  const match = /^\/mobile\/v1\/pairing-requests\/([^/]+)(?:\/(exchange|finish))?(?![\s\S])/u.exec(input.path);
  if (!match) return invalid();
  let requestId: string;
  try { requestId = decodeURIComponent(match[1]!); } catch { return invalid(); }
  if (!isMobilePairingRequestId(requestId)) return invalid();
  if (!match[2]) return input.method === 'DELETE' && input.body === null
    ? { operation: 'cancel', requestId, body: null } : invalid();
  if (input.method !== 'POST') return invalid();
  if (match[2] === 'exchange') {
    const body = captureMobilePairingExchangeRequest(input.body);
    return body.ok ? { operation: 'exchange', requestId, body: body.value } : invalid();
  }
  const body = captureMobilePairingFinishRequest(input.body);
  return body.ok ? { operation: 'finish', requestId, body: body.value } : invalid();
}

/** 固定顺序的长度前缀 UTF-8，避免 JSON 转义、语言区域与字典顺序差异。 */
export function mobilePairingCanonicalBinding(value: MobilePairingBootstrapBinding): Uint8Array {
  const fields = ['MOUSA_PAIRING_BOOTSTRAP_V1', MOBILE_PAIRING_BOOTSTRAP_SUITE,
    value.requestId, value.serverId, value.origin, value.certificateSha256, value.installationId,
    value.deviceName, value.clientNonce, value.serverNonce, value.claimIdempotencyKey, value.expiresAt];
  const encoded = fields.map(field => new TextEncoder().encode(field));
  const bytes = new Uint8Array(encoded.reduce((size, field) => size + 4 + field.byteLength, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  for (const field of encoded) { view.setUint32(offset, field.byteLength, false); offset += 4;
    bytes.set(field, offset); offset += field.byteLength; }
  return bytes;
}
