import { isMobileConnectionSettings, type MobileConnectionPublicApi } from '../shared/mobile-settings.js';

function closed(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).length === fields.length && fields.every(name => { const d = Object.getOwnPropertyDescriptor(value, name); return d?.enumerable === true && Object.hasOwn(d, 'value'); });
  } catch { return false; }
}
export function createMobileConnectionClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): MobileConnectionPublicApi {
  const settings = async (work: Promise<unknown>) => { const value = await work; if (!isMobileConnectionSettings(value)) throw new Error('移动连接回执无效。'); return value; };
  return {
    getMobileConnectionSettings: () => settings(invoke('mobile:settings')),
    configureMobileConnection: value => {
      if (!closed(value, ['enabled', 'host', 'port']) || typeof value.enabled !== 'boolean' || typeof value.host !== 'string' || !Number.isSafeInteger(value.port)) throw new Error('移动连接参数无效。');
      return settings(invoke('mobile:configure', { enabled: value.enabled, host: value.host, port: value.port }));
    },
    async issueMobilePairing() {
      const value = await invoke('mobile:pairing');
      if (!closed(value, ['pairingSecret', 'expiresAt'])) throw new Error('配对许可回执无效。');
      const permit = value as { pairingSecret: string; expiresAt: string };
      if (typeof permit.pairingSecret !== 'string' || permit.pairingSecret.length < 16 || permit.pairingSecret.length > 512
        || typeof permit.expiresAt !== 'string' || !Number.isFinite(Date.parse(permit.expiresAt))) throw new Error('配对许可回执无效。');
      return { pairingSecret: permit.pairingSecret, expiresAt: permit.expiresAt };
    },
    revokeMobileDevice: deviceId => { if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(deviceId)) throw new Error('移动设备身份无效。'); return settings(invoke('mobile:revoke-device', deviceId)); },
  };
}
