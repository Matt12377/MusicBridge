import { isMobileId } from './mobile-common.js';

/** Additive connection bootstrap/read-only extension; existing 0.1.0 operation DTOs are unchanged. */
export const MOBILE_CONNECTION_DEFAULT_PORT = 45391;
export const MOBILE_CONNECTION_IDENTIFY_PATH = '/mobile/v1/connection';
export const MOBILE_CONNECTION_PATHS_PATH = '/mobile/v1/connection/paths';
export const MOBILE_CONNECTION_MAX_BYTES = 32 * 1024;
export type MobileConnectionPathKind = 'lan' | 'tailscale';
export interface MobilePublicConnectionConfiguration {
  schemaVersion: 1;
  serverId: string;
  baseURL: string;
  certificatePEM: string;
  certificateSha256: string;
}
export interface MobileConnectionPath {
  kind: MobileConnectionPathKind;
  baseURL: string;
  certificatePEM: string;
  certificateSha256: string;
}
export interface MobileConnectionPathsReply {
  schemaVersion: 1;
  serverId: string;
  paths: readonly MobileConnectionPath[];
}

function closed(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}
/** Literal, canonical private IPv4 only. 100.64/10 is an address kind, never an authentication claim. */
export function mobileConnectionAddressKind(value: unknown): MobileConnectionPathKind | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255)) return null;
  const [a, b] = parts.map(Number);
  if (a === 100 && b! >= 64 && b! <= 127) return 'tailscale';
  return a === 127 || a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 ? 'lan' : null;
}
export function isMobileConnectionOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && mobileConnectionAddressKind(url.hostname) !== null;
  } catch { return false; }
}
function certificate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192
    && /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----(?:\r?\n)?$/u.test(value);
}
const fingerprint = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/u.test(value);
const invalid = (): never => { throw new TypeError('移动连接资料无效。'); };

/** Shape capture only: TLS/SAN/fingerprint and authenticated provenance must still be checked by each endpoint. */
export function mobilePublicConnectionSnapshot(value: unknown): MobilePublicConnectionConfiguration {
  if (!closed(value, ['schemaVersion', 'serverId', 'baseURL', 'certificatePEM', 'certificateSha256'])
    || value.schemaVersion !== 1 || !isMobileId(value.serverId) || !isMobileConnectionOrigin(value.baseURL)
    || !certificate(value.certificatePEM) || !fingerprint(value.certificateSha256)) return invalid();
  return Object.freeze({ schemaVersion: 1, serverId: value.serverId, baseURL: value.baseURL,
    certificatePEM: value.certificatePEM, certificateSha256: value.certificateSha256 });
}
export function mobileConnectionPathsSnapshot(value: unknown): MobileConnectionPathsReply {
  if (!closed(value, ['schemaVersion', 'serverId', 'paths']) || value.schemaVersion !== 1 || !isMobileId(value.serverId)
    || !Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 2) return invalid();
  if (Object.getPrototypeOf(value.paths) !== Array.prototype || Reflect.ownKeys(value.paths).length !== value.paths.length + 1) return invalid();
  const paths: MobileConnectionPath[] = [], origins = new Set<string>(), kinds = new Set<MobileConnectionPathKind>();
  for (let index = 0; index < value.paths.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.paths, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    const raw: unknown = descriptor.value;
    if (!closed(raw, ['kind', 'baseURL', 'certificatePEM', 'certificateSha256'])
      || raw.kind !== 'lan' && raw.kind !== 'tailscale' || !isMobileConnectionOrigin(raw.baseURL)
      || raw.kind !== mobileConnectionAddressKind(new URL(raw.baseURL).hostname)
      || !certificate(raw.certificatePEM) || !fingerprint(raw.certificateSha256)
      || origins.has(raw.baseURL) || kinds.has(raw.kind as MobileConnectionPathKind)) return invalid();
    origins.add(raw.baseURL); kinds.add(raw.kind as MobileConnectionPathKind);
    paths.push(Object.freeze({ kind: raw.kind as MobileConnectionPathKind, baseURL: raw.baseURL,
      certificatePEM: raw.certificatePEM, certificateSha256: raw.certificateSha256 }));
  }
  return Object.freeze({ schemaVersion: 1, serverId: value.serverId, paths: Object.freeze(paths) });
}
