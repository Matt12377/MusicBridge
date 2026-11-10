import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { MOBILE_CONNECTION_DEFAULT_PORT, mobileConnectionAddressKind, mobilePublicConnectionSnapshot,
  type MobilePublicConnectionConfiguration } from '@music-bridge/contracts';
import { loadOrCreateMobileIdentity, type MobileSecretProtector, type MobileTlsIdentity } from './mobile-tls-identity.js';
import { detectMobileTailscaleAddress } from './mobile-tailscale-address.js';
import type { MobileHttpsServer } from './mobile-https-server.js';

/** One auxiliary listener only; it never owns another backend, auth service, queue or playback initialization. */
export function createMobileAuxiliaryListener(options: {
  primary: MobilePublicConnectionConfiguration;
  directory: string;
  protector: MobileSecretProtector;
  addresses(): readonly string[];
  probeTailscale?(addresses: readonly string[]): Promise<string | null>;
  loadRootIdentity(): Promise<MobileTlsIdentity>;
  assertCurrent(): void;
  createServer(input: { host: string; port: number; tls: { key: string; cert: string } }): MobileHttpsServer;
  add(connection: MobilePublicConnectionConfiguration): void;
  remove(connection: MobilePublicConnectionConfiguration): void;
}) {
  const primary = mobilePublicConnectionSnapshot(options.primary), primaryHost = new URL(primary.baseURL).hostname;
  const primaryKind = mobileConnectionAddressKind(primaryHost), probe = options.probeTailscale ?? detectMobileTailscaleAddress;
  let state: 'off' | 'unavailable' | 'ready' | 'failed' = 'off', closing = false;
  let active: { host: string; server: MobileHttpsServer; connection: MobilePublicConnectionConfiguration } | undefined;
  let flight: Promise<void> | undefined, retirement: Promise<void> | undefined, closeFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  function current(): void { if (closing) throw new Error('辅助连接已关闭。'); options.assertCurrent(); }
  async function retire(): Promise<void> {
    if (retirement) return retirement;
    const old = active; if (!old) return;
    active = undefined;
    const pending = (async () => {
      const failures: unknown[] = [];
      try { options.remove(old.connection); } catch (error) { failures.push(error); }
      try { await old.server.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, '辅助连接收尾尚未确认。');
    })();
    retirement = pending;
    await pending;
    if (retirement === pending) retirement = undefined;
  }
  async function perform(): Promise<void> {
    current();
    if (primaryHost.startsWith('127.') || !primaryKind) { await retire(); state = 'off'; return; }
    const addresses = [...new Set(options.addresses())].filter(address => mobileConnectionAddressKind(address) !== null).slice(0, 64);
    let host: string | null = null;
    if (primaryKind === 'tailscale') {
      host = active && mobileConnectionAddressKind(active.host) === 'lan' && addresses.includes(active.host) ? active.host
        : addresses.find(address => mobileConnectionAddressKind(address) === 'lan' && !address.startsWith('127.')) ?? null;
    } else {
      // A healthy already-verified address does not churn because an optional CLI probe is slow or disappears.
      host = active && mobileConnectionAddressKind(active.host) === 'tailscale' && addresses.includes(active.host) ? active.host : await probe(addresses);
      current();
      if (!host || mobileConnectionAddressKind(host) !== 'tailscale' || !addresses.includes(host)) host = null;
    }
    const tailReady = primaryKind === 'tailscale' ? addresses.includes(primaryHost) : host !== null;
    if (active?.host === host) { state = tailReady ? 'ready' : 'unavailable'; return; }
    await retire(); current();
    if (!host) { state = tailReady ? 'ready' : 'unavailable'; return; }
    let root: MobileTlsIdentity | undefined, endpoint: MobileTlsIdentity | undefined, server: MobileHttpsServer | undefined;
    try {
      root = await options.loadRootIdentity(); current();
      if (root.serverId !== primary.serverId || root.certificateSha256 !== primary.certificateSha256 || root.certificatePEM !== primary.certificatePEM) {
        throw new Error('原移动身份不一致。');
      }
      endpoint = new X509Certificate(root.certificatePEM).checkIP(host) ? root : await loadOrCreateMobileIdentity({
        directory: path.join(options.directory, host), hosts: [host], secretProtector: options.protector, sharedIdentity: root });
      current();
      const connection = mobilePublicConnectionSnapshot({ schemaVersion: 1, serverId: primary.serverId,
        baseURL: `https://${host}:${MOBILE_CONNECTION_DEFAULT_PORT}`, certificatePEM: endpoint.certificatePEM, certificateSha256: endpoint.certificateSha256 });
      server = options.createServer({ host, port: MOBILE_CONNECTION_DEFAULT_PORT, tls: { key: endpoint.privateKeyPEM, cert: endpoint.certificatePEM } });
      const listening = await server.start(); current();
      if (listening.baseUrl !== connection.baseURL || listening.certificateSha256 !== connection.certificateSha256) throw new Error('辅助监听身份不一致。');
      options.add(connection);
      active = { host, connection, server }; server = undefined;
      state = tailReady ? 'ready' : 'unavailable';
    } finally {
      endpoint?.authKey.fill(0); root?.authKey.fill(0);
      if (server) {
        const pending = server.close(); retirement = pending; await pending;
        if (retirement === pending) retirement = undefined;
      }
    }
  }
  function reconcile(): Promise<void> {
    if (closing) return Promise.resolve();
    if (flight) return flight;
    const pending = perform().catch(() => { state = closing ? 'off' : 'failed'; });
    flight = pending;
    void pending.then(() => { if (flight === pending) flight = undefined; });
    return pending;
  }
  return {
    get state() { return state; },
    get connection(): MobilePublicConnectionConfiguration | null { return active ? { ...active.connection } : null; },
    async start(): Promise<void> {
      await reconcile();
      if (!closing && !primaryHost.startsWith('127.') && !timer) {
        timer = setInterval(() => { void reconcile(); }, 15_000); timer.unref();
      }
    },
    reconcile,
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closing = true; if (timer) { clearInterval(timer); timer = undefined; }
      closeFlight = (async () => { await flight; await retirement; await retire(); state = 'off'; })();
      return closeFlight;
    },
  };
}
