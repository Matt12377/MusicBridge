import { performance } from 'node:perf_hooks';
import {
  MOBILE_CONNECTION_IDENTIFY_PATH, MOBILE_CONNECTION_PATHS_PATH, MOBILE_CONNECTION_MAX_BYTES,
  mobilePublicConnectionSnapshot, mobileConnectionPathsSnapshot,
  type MobilePublicConnectionConfiguration, type MobileConnectionPathsReply, type MobileHeaderPairs,
} from '@music-bridge/contracts';
import { MobileServiceError, type Mobile001BackendReply, type MobileAuthService } from '../../../../packages/bridge-core/src/mobile/types.js';

export interface MobileConnectionHttpInput {
  method: string; path: string; query: readonly (readonly [string, string])[];
  headers: MobileHeaderPairs; body: Uint8Array; accessToken: string | null;
  remoteAddress: string; origin: string; certificateSha256: string; signal: AbortSignal;
}
export interface MobileConnectionHttpBackend {
  dispatch(input: MobileConnectionHttpInput): Promise<Mobile001BackendReply>;
}
export function isMobileConnectionHttpPath(path: string): boolean {
  return path === MOBILE_CONNECTION_IDENTIFY_PATH || path === MOBILE_CONNECTION_PATHS_PATH;
}
const failure = (status: 400 | 401 | 503, code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'BUSY'): never => {
  throw new MobileServiceError(status, code);
};

/** Only public candidate identity is unauthenticated. Trusted path adoption always uses the original auth instance. */
export function createMobileConnectionHttpBackend(options: {
  serverId: string;
  assertCurrent(): void;
  publicConnection(origin: string): MobilePublicConnectionConfiguration;
  connectionPaths(): MobileConnectionPathsReply;
  auth: Pick<MobileAuthService, 'authenticate' | 'assertCurrent'>;
  now?(): number;
}): MobileConnectionHttpBackend {
  const peers = new Map<string, number[]>();
  let starts: number[] = [];
  const now = options.now ?? (() => performance.now());
  function current(signal: AbortSignal): void { signal.throwIfAborted(); options.assertCurrent(); signal.throwIfAborted(); }
  function configuration(input: MobileConnectionHttpInput): MobilePublicConnectionConfiguration {
    let value: MobilePublicConnectionConfiguration;
    try { value = mobilePublicConnectionSnapshot(options.publicConnection(input.origin)); }
    catch { return failure(503, 'BUSY'); }
    if (value.serverId !== options.serverId || value.baseURL !== input.origin || value.certificateSha256 !== input.certificateSha256) return failure(503, 'BUSY');
    return value;
  }
  function admit(remoteAddress: string): void {
    const peer = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
    if (!/^[0-9]+(?:\.[0-9]+){3}$/u.test(peer) || peer.length > 64) return failure(400, 'INVALID_REQUEST');
    const at = now(); if (!Number.isFinite(at) || at < 0) return failure(503, 'BUSY');
    const cutoff = at - 60_000;
    starts = starts.filter(value => value > cutoff);
    for (const [key, values] of peers) { const kept = values.filter(value => value > cutoff); if (kept.length) peers.set(key, kept); else peers.delete(key); }
    const recent = peers.get(peer) ?? [];
    if (recent.length >= 12 || starts.length >= 64 || !peers.has(peer) && peers.size >= 64) throw new MobileServiceError(429, 'BUSY', true, 60_000);
    peers.set(peer, [...recent, at]); starts.push(at);
  }
  function reply(value: MobilePublicConnectionConfiguration | MobileConnectionPathsReply, beforeSend: () => Promise<void>): Mobile001BackendReply {
    const body = Buffer.from(JSON.stringify(value));
    if (body.byteLength > MOBILE_CONNECTION_MAX_BYTES) return failure(503, 'BUSY');
    return { status: 200, body, headers: [['Content-Type', 'application/json; charset=utf-8'], ['Content-Length', String(body.byteLength)],
      ['Cache-Control', 'private, no-store']], beforeSend };
  }
  return {
    async dispatch(input) {
      current(input.signal);
      if (!isMobileConnectionHttpPath(input.path) || input.method !== 'GET' || input.query.length || input.body.byteLength
        || input.headers.some(([name]) => name.toLowerCase() === 'cookie')) return failure(400, 'INVALID_REQUEST');
      const authorization = input.headers.filter(([name]) => name.toLowerCase() === 'authorization');
      if (input.path === MOBILE_CONNECTION_IDENTIFY_PATH) {
        if (authorization.length || input.accessToken !== null) return failure(400, 'INVALID_REQUEST');
        admit(input.remoteAddress);
        const value = configuration(input);
        return reply(value, async () => { current(input.signal); configuration(input); });
      }
      if (authorization.length > 1) return failure(400, 'INVALID_REQUEST');
      if (!input.accessToken || authorization.length !== 1 || authorization[0]![1] !== `Bearer ${input.accessToken}`) return failure(401, 'UNAUTHORIZED');
      const principal = await options.auth.authenticate(input.accessToken);
      current(input.signal); configuration(input);
      let value: MobileConnectionPathsReply;
      try { value = mobileConnectionPathsSnapshot(options.connectionPaths()); }
      catch { return failure(503, 'BUSY'); }
      if (value.serverId !== options.serverId || !value.paths.some(path => path.baseURL === input.origin && path.certificateSha256 === input.certificateSha256)) return failure(503, 'BUSY');
      return reply(value, async () => { current(input.signal); await options.auth.assertCurrent(principal); current(input.signal); configuration(input); });
    },
  };
}
