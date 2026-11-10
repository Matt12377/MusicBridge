import { mobileConnectionPathsSnapshot, type MobileConnectionPathsReply } from '@music-bridge/contracts';

/** 桌面可信 Main/preload 专用设置；不扩展冻结的移动 wire 字段。 */
export interface MobilePublicConnection {
  schemaVersion: 1; serverId: string; baseURL: string; certificateSha256: string; certificatePEM: string;
}
export interface MobileConnectionSettings {
  schemaVersion: 1; enabled: boolean; state: 'off' | 'starting' | 'ready' | 'closing' | 'failed';
  host: string; port: number; hosts: string[]; connection: MobilePublicConnection | null;
  devices: { deviceId: string; deviceName: string; createdAt: string; revoked: boolean }[];
  /** Additive Main/preload capability; old single-endpoint snapshots remain valid. */
  connectionPaths?: MobileConnectionPathsReply | null;
  tailscaleState?: 'off' | 'unavailable' | 'ready' | 'failed';
}
export interface MobileConnectionPublicApi {
  getMobileConnectionSettings(): Promise<MobileConnectionSettings>;
  configureMobileConnection(value: { enabled: boolean; host: string; port: number }): Promise<MobileConnectionSettings>;
  issueMobilePairing(): Promise<{ pairingSecret: string; expiresAt: string }>;
  revokeMobileDevice(deviceId: string): Promise<MobileConnectionSettings>;
}
function closed(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.length && fields.every(name => { const d = Object.getOwnPropertyDescriptor(value, name); return d?.enumerable === true && Object.hasOwn(d, 'value'); });
  } catch { return false; }
}
function dense(value: unknown, maximum: number): value is unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false; }
    return true;
  } catch { return false; }
}
export function isMobileConnectionSettings(value: unknown): value is MobileConnectionSettings {
  const fields = ['schemaVersion', 'enabled', 'state', 'host', 'port', 'hosts', 'connection', 'devices'];
  try {
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value, 'connectionPaths')) fields.push('connectionPaths');
      if (Object.hasOwn(value, 'tailscaleState')) fields.push('tailscaleState');
    }
  } catch { return false; }
  if (!closed(value, fields)) return false;
  const v = value;
  const basic = v.schemaVersion === 1 && typeof v.enabled === 'boolean' && typeof v.state === 'string' && ['off', 'starting', 'ready', 'closing', 'failed'].includes(v.state)
    && typeof v.host === 'string' && typeof v.port === 'number' && Number.isSafeInteger(v.port) && v.port >= 1 && v.port <= 65535
    && dense(v.hosts, 64) && v.hosts.every(h => typeof h === 'string')
    && (v.connection === null || closed(v.connection, ['schemaVersion', 'serverId', 'baseURL', 'certificateSha256', 'certificatePEM']) && v.connection.schemaVersion === 1 && typeof v.connection.serverId === 'string'
      && typeof v.connection.baseURL === 'string' && /^https:\/\/[0-9.]+:[0-9]+$/u.test(v.connection.baseURL)
      && typeof v.connection.certificateSha256 === 'string' && /^[0-9a-f]{64}$/u.test(v.connection.certificateSha256) && typeof v.connection.certificatePEM === 'string' && v.connection.certificatePEM.length <= 65536)
    && dense(v.devices, 32) && v.devices.every(d => closed(d, ['deviceId', 'deviceName', 'createdAt', 'revoked']) && typeof d.deviceId === 'string' && typeof d.deviceName === 'string' && typeof d.createdAt === 'string' && typeof d.revoked === 'boolean');
  if (!basic) return false;
  if (Object.hasOwn(v, 'tailscaleState') && (typeof v.tailscaleState !== 'string' || !['off', 'unavailable', 'ready', 'failed'].includes(v.tailscaleState))) return false;
  if (Object.hasOwn(v, 'connectionPaths')) {
    const connection = v.connection as MobilePublicConnection | null;
    if (v.connectionPaths === null) return connection === null;
    try {
      const paths = mobileConnectionPathsSnapshot(v.connectionPaths);
      if (!connection || paths.serverId !== connection.serverId || !paths.paths.some(path => path.baseURL === connection.baseURL
        && path.certificateSha256 === connection.certificateSha256 && path.certificatePEM === connection.certificatePEM)) return false;
    } catch { return false; }
  }
  return true;
}
