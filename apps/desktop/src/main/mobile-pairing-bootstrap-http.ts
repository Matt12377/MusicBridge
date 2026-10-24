import {
  MOBILE_CODEC_LIMITS, MOBILE_PAIRING_BOOTSTRAP_MAX_BODY_BYTES, parseMobileJson,
  parseMobilePairingBootstrapRoute, type MobileHeaderPairs,
} from '@music-bridge/contracts';
import type { createMobilePairingBootstrap } from '../../../../packages/bridge-core/src/mobile/pairing-bootstrap.js';
import { MobileServiceError, type Mobile001BackendReply } from '../../../../packages/bridge-core/src/mobile/types.js';

type Coordinator = ReturnType<typeof createMobilePairingBootstrap>;
export interface MobilePairingBootstrapHttpBackend {
  dispatch(input: {
    method: string; path: string; query: readonly (readonly [string, string])[];
    headers: MobileHeaderPairs; body: Uint8Array; remoteAddress: string;
    origin: string; certificateSha256: string; signal: AbortSignal;
  }): Promise<Mobile001BackendReply>;
}

/** 新引导路由单独解码，既有操作表与长许可 wire 保持原样。 */
export function createMobilePairingBootstrapHttp(options: {
  coordinator: Coordinator; serverId: string;
}): MobilePairingBootstrapHttpBackend {
  return {
    async dispatch(input) {
      const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
      input.signal.throwIfAborted();
      if (input.headers.some(([name]) => /^(authorization|cookie)$/iu.test(name))
        || input.body.byteLength > MOBILE_PAIRING_BOOTSTRAP_MAX_BODY_BYTES) return invalid();
      let body: unknown = null;
      if (input.method !== 'DELETE') {
        const contentTypes = input.headers.filter(([name]) => name.toLowerCase() === 'content-type');
        if (contentTypes.length !== 1 || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentTypes[0]![1])) return invalid();
        const decoded = parseMobileJson(input.body, { ...MOBILE_CODEC_LIMITS,
          requestBytes: MOBILE_PAIRING_BOOTSTRAP_MAX_BODY_BYTES, depth: 4, nodes: 64 }, 'request');
        if (!decoded.ok) return invalid();
        body = decoded.value;
      } else if (input.body.byteLength !== 0) return invalid();
      let route;
      try { route = parseMobilePairingBootstrapRoute({ method: input.method, path: input.path, query: input.query, body }); }
      catch { return invalid(); }
      const peer = { remoteAddress: input.remoteAddress, origin: input.origin,
        certificateSha256: input.certificateSha256, serverId: options.serverId };
      let result: unknown, status: number;
      switch (route.operation) {
        case 'begin': {
          const started = await options.coordinator.start(route.body, peer);
          // 请求在展示验证码后断开时，撤销的只是它自己的尝试。
          if (input.signal.aborted) { options.coordinator.cancel(started.requestId); input.signal.throwIfAborted(); }
          result = started; status = 201; break;
        }
        case 'exchange': result = await options.coordinator.exchange(route.requestId, route.body, peer); status = 200; break;
        case 'finish': result = await options.coordinator.finish(route.requestId, route.body, peer); status = 201; break;
        case 'cancel': await options.coordinator.cancelFromPeer(route.requestId, peer); status = 204; break;
      }
      input.signal.throwIfAborted();
      const bytes = status === 204 ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(result));
      if (bytes.byteLength > 32 * 1024) throw new MobileServiceError(503, 'BUSY');
      return { status, body: bytes, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]],
        ...(route.operation === 'finish' ? { beforeSend: () => options.coordinator.beforeSend(route.requestId, peer) } : {}) };
    },
  };
}
