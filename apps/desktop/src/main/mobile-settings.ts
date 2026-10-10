import { networkInterfaces } from 'node:os';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isMobileId } from '@music-bridge/contracts';
import { createMobileBackend } from './mobile-backend.js';
import { createMobileHttpsServer } from './mobile-https-server.js';
import { isMobilePrivateIPv4, loadOrCreateMobileIdentity, type MobileSecretProtector } from './mobile-tls-identity.js';
import { MobileServiceError, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobileConnectionSettings } from '../shared/mobile-settings.js';

const defaultPort = 45391;
type Preference = { schemaVersion: 1; enabled: boolean; host: string; port: number };
function closed(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every(name => { const d = Object.getOwnPropertyDescriptor(value, name); return d?.enumerable === true && Object.hasOwn(d, 'value'); });
}
function hosts(): string[] {
  return [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).filter(entry => entry.family === 'IPv4' && isMobilePrivateIPv4(entry.address)).map(entry => entry.address))])].slice(0, 64);
}
function preference(value: unknown): value is Preference {
  return closed(value, ['schemaVersion', 'enabled', 'host', 'port']) && value.schemaVersion === 1 && typeof value.enabled === 'boolean'
    && typeof value.host === 'string' && isMobilePrivateIPv4(value.host) && Number.isSafeInteger(value.port) && Number(value.port) >= 1024 && Number(value.port) <= 65535;
}
const busy = (): never => { throw new Error('移动连接当前未就绪，请刷新设置。'); };

/** 本地明确启停的独立 HTTPS 服务；默认 OFF。原 loopback 服务不变。 */
export function createMobileConnectionSettings(options: {
  directory: string; protector: MobileSecretProtector;
  currentDataset(): Promise<string>;
  requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult>;
  isCoreReady(): boolean;
  resizeArtwork(bytes: Uint8Array, size: 96 | 256 | 512): Uint8Array;
  environment: 'development' | 'production';
}) {
  if (!path.isAbsolute(options.directory) || options.directory.includes('\0')) throw new Error('移动连接存储位置无效。');
  let pref: Preference = { schemaVersion: 1, enabled: false, host: '127.0.0.1', port: defaultPort };
  let state: MobileConnectionSettings['state'] = 'off', epoch = 0, closing = false, queued = 0;
  let serial = Promise.resolve(), closeFlight: Promise<void> | undefined;
  let active: { epoch: number; server: ReturnType<typeof createMobileHttpsServer>; service: ReturnType<typeof createMobileBackend>; connection: NonNullable<MobileConnectionSettings['connection']> } | undefined;
  const file = path.join(options.directory, 'connection.json');
  const snapshot = (devices: MobileConnectionSettings['devices'] = []): MobileConnectionSettings => ({ schemaVersion: 1, enabled: pref.enabled, state,
    host: pref.host, port: pref.port, hosts: hosts(), connection: active ? { ...active.connection } : null, devices });
  async function stop(): Promise<void> {
    const old = active; active = undefined; epoch++;
    if (!old) return;
    try { await old.server.close(); } finally { await old.service.close(); }
  }
  async function start(): Promise<void> {
    if (closing || !pref.enabled || !options.isCoreReady() || !hosts().includes(pref.host)) return busy();
    const generation = ++epoch; state = 'starting';
    const datasetId = await options.currentDataset();
    if (!isMobileId(datasetId) || generation !== epoch || closing || !options.isCoreReady()) return busy();
    const identity = await loadOrCreateMobileIdentity({ directory: path.join(options.directory, 'identity'), secretProtector: options.protector, hosts: hosts() });
    if (generation !== epoch || closing || !options.isCoreReady()) return busy();
    let starting = true;
    const service = createMobileBackend({ serverId: identity.serverId, datasetId, authKey: identity.authKey, displayName: 'Music Bridge', environment: options.environment,
      requestOwner: options.requestOwner, resizeArtwork: options.resizeArtwork, enablePlayback: true, enableDsd: true,
      assertCurrent: () => { if (closing || epoch !== generation || !options.isCoreReady() || !starting && active?.epoch !== generation) throw new MobileServiceError(503, 'BUSY'); } });
    const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: pref.host, port: pref.port,
      backend: service.backend, ...(service.playbackBackend ? { playback: service.playbackBackend } : {}),
      ...(service.dsdBackend ? { dsd: service.dsdBackend } : {}) });
    try {
      const listening = await server.start();
      if (generation !== epoch || closing || !options.isCoreReady()) return busy();
      service.activatePlayback(listening.baseUrl);
      active = { epoch: generation, server, service, connection: { schemaVersion: 1, serverId: identity.serverId, baseURL: listening.baseUrl,
        certificatePEM: identity.certificatePEM, certificateSha256: identity.certificateSha256 } };
      starting = false; state = 'ready';
    } catch { starting = false; await server.close(); await service.close(); if (generation === epoch) state = 'failed'; return busy(); }
    finally { identity.authKey.fill(0); }
  }
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (queued >= 8) return Promise.reject(new Error('移动连接设置请求过多，请稍后刷新。'));
    queued++;
    const pending = serial.catch(() => {}).then(work);
    serial = pending.then(() => {}, () => {});
    return pending.finally(() => { queued--; });
  }
  async function privateDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(options.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error('移动连接存储不可用。');
  }
  async function save(value: Preference): Promise<void> {
    await privateDirectory(true);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('移动连接偏好不可用。');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = file + '.' + randomUUID() + '.pending'; let handle: Awaited<ReturnType<typeof open>> | undefined, created = false;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true; await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, file);
      const directory = await open(options.directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle?.close().catch(() => {}); if (created) await unlink(temporary).catch(() => {}); }
  }
  return {
    get: async (): Promise<MobileConnectionSettings> => {
      const own = active;
      if (!own || state !== 'ready') return snapshot();
      try { const devices = await own.service.auth.devices(); return active === own && !closing ? snapshot([...devices]) : snapshot(); }
      catch { if (active === own) state = 'failed'; return snapshot(); }
    },
    configure(value: unknown): Promise<MobileConnectionSettings> {
      if (!closed(value, ['enabled', 'host', 'port']) || !preference({ schemaVersion: 1, ...value }) || !hosts().includes(String(value.host))) return Promise.reject(new Error('请选择本机私有地址和有效端口。'));
      const intent = { schemaVersion: 1, enabled: value.enabled, host: value.host, port: value.port } as Preference;
      return exclusive(async () => {
        if (closing) return busy(); state = 'closing'; await stop();
        try { await save(intent); } catch { state = 'failed'; return busy(); } pref = intent;
        if (!pref.enabled) { state = 'off'; return snapshot(); }
        try { await start(); } catch { state = 'failed'; }
        return snapshot();
      });
    },
    issuePairing: async () => {
      const own = active; if (!own || state !== 'ready' || closing) return busy();
      const permit = await own.service.auth.issuePairing(); if (own !== active || closing) return busy(); return permit;
    },
    revokeDevice: async (deviceId: string): Promise<MobileConnectionSettings> => {
      const own = active; if (!isMobileId(deviceId) || !own || state !== 'ready' || closing) return busy();
      await own.service.auth.revokeDevice(deviceId); if (own !== active || closing) return busy();
      return snapshot([...await own.service.auth.devices()]);
    },
    restore(): Promise<void> {
      return exclusive(async () => {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          await privateDirectory(false);
          handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('偏好无效。');
          const bytes = await handle.readFile('utf8'), after = await handle.stat(), named = await lstat(file);
          if (['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].some(key => info[key as keyof typeof info] !== after[key as keyof typeof after] || info[key as keyof typeof info] !== named[key as keyof typeof named])) throw new Error('偏好读取中变化。');
          const value: unknown = JSON.parse(bytes); if (!preference(value)) throw new Error('偏好无效。'); pref = value;
        } catch { pref = { schemaVersion: 1, enabled: false, host: '127.0.0.1', port: defaultPort }; }
        finally { await handle?.close().catch(() => {}); }
        if (pref.enabled) { try { await start(); } catch { state = 'failed'; } }
      });
    },
    suspend(): void {
      // 同步封住旧请求；随后关闭自有 listener/Auth。只恢复原明确信任偏好。
      epoch++; state = pref.enabled ? 'failed' : 'off'; void exclusive(stop).catch(() => {});
    },
    resume(): void { if (pref.enabled && !closing) void exclusive(async () => { await stop(); try { await start(); } catch { state = 'failed'; } }).catch(() => {}); },
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true; epoch++; state = 'closing';
      // 关闭不占普通请求额度，必须等待已接纳的设置操作并回收同一组资源。
      closeFlight = serial.catch(() => {}).then(async () => { await stop(); state = 'off'; });
      return closeFlight;
    },
  };
}

/** 完整 sender/主框架与闭集参数先于任何许可或网络副作用。配对许可不经诊断包装。 */
export function installMobileConnectionHandlers<Event>(options: {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
  requireTrusted(event: Event): void;
  settings: ReturnType<typeof createMobileConnectionSettings>;
}) {
  const reject = (): never => { throw new Error('移动连接请求无效。'); };
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch { throw new Error('移动连接操作未完成，请刷新设置查看状态。'); }
  };
  options.handle('mobile:settings', (event, ...args) => { options.requireTrusted(event); if (args.length) return reject(); return safe(() => options.settings.get()); });
  options.handle('mobile:configure', (event, ...args) => { options.requireTrusted(event); if (args.length !== 1) return reject(); return safe(() => options.settings.configure(args[0])); });
  options.handle('mobile:pairing', (event, ...args) => { options.requireTrusted(event); if (args.length) return reject(); return safe(() => options.settings.issuePairing()); });
  options.handle('mobile:revoke-device', (event, ...args) => { options.requireTrusted(event); if (args.length !== 1 || !isMobileId(args[0])) return reject(); return safe(() => options.settings.revokeDevice(args[0] as string)); });
}
