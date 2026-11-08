import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIPv4 } from 'node:net';
import { BridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

/** 由实际已配对的 Core socket 在同进程创建，不接受环境或 IPC 重建。 */
export interface TrustedRoonMediaPeer {
  readonly localAddress: string;
  readonly remoteAddress: string;
}
const trustedPeers = new WeakSet<object>();
export function isPrivateMediaAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31;
}
export function createTrustedRoonMediaPeer(input: TrustedRoonMediaPeer): TrustedRoonMediaPeer {
  if (!isPrivateMediaAddress(input.localAddress) || !isPrivateMediaAddress(input.remoteAddress)) {
    throw new BridgeError('CONFIG_INVALID', 'Roon 媒体连接必须使用明确的局域网地址');
  }
  const peer = Object.freeze({ localAddress: input.localAddress, remoteAddress: input.remoteAddress });
  trustedPeers.add(peer);
  return peer;
}

interface MediaActor {
  readonly peer: TrustedRoonMediaPeer;
  server?: Server;
  origin?: string;
}

/** 独立媒体监听只负责配对网络的生命周期，业务读取仍由原 Gateway 执行。 */
export class RoonMediaListener {
  private actor: MediaActor | undefined;
  private serial: Promise<void> = Promise.resolve();
  private readonly servers = new Set<Server>();

  constructor(private readonly options: {
    dispatch(request: IncomingMessage, response: ServerResponse): Promise<void>;
    logger: Logger;
  }) {}

  get required(): boolean { return this.actor !== undefined; }
  get origin(): string | undefined { return this.actor?.origin; }

  configure(peer?: TrustedRoonMediaPeer): Promise<void> {
    if (peer && !trustedPeers.has(peer)) return Promise.reject(new BridgeError('CONFIG_INVALID', 'Roon 媒体网络未经可信配对准入'));
    const current = this.actor;
    if (peer && current?.origin && current.peer.localAddress === peer.localAddress && current.peer.remoteAddress === peer.remoteAddress) return this.serial;
    // 先撤销旧公告和旧连接，迟到 listen 只能清理自己的 Server。
    const actor = peer ? { peer } as MediaActor : undefined;
    this.actor = actor;
    for (const server of this.servers) server.closeAllConnections();
    const work = this.serial.catch(() => undefined).then(async () => {
      await Promise.all([...this.servers].map(server => this.close(server)));
      if (!actor || this.actor !== actor) return;
      const server = createServer((request, response) => {
        const remote = request.socket.remoteAddress?.replace(/^::ffff:/u, '');
        if (this.actor !== actor || !actor.origin || remote !== actor.peer.remoteAddress) {
          if (this.actor === actor && actor.origin && remote !== actor.peer.remoteAddress) {
            try { this.options.logger.warn('roon_media_peer_rejected', {}); } catch { /* 只记录闭集分类，不信任代理头，也不开放该请求。 */ }
          }
          response.writeHead(404, { 'Content-Length': 0 }); response.end(); return;
        }
        void this.options.dispatch(request, response).catch(error => {
          const code = error instanceof BridgeError ? error.code : 'ROON_MEDIA_ERROR';
          try { this.options.logger.warn('roon_media_request_failed', { code }); } catch { /* 诊断失败仍结束原请求。 */ }
          const status = error instanceof BridgeError ? error.httpStatus : 502;
          if (!response.headersSent) { response.writeHead(status, { 'Content-Length': 0 }); response.end(); }
          else response.destroy();
        });
      });
      actor.server = server;
      this.servers.add(server);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, peer!.localAddress, () => { server.off('error', reject); resolve(); });
        });
        if (this.actor !== actor) { await this.close(server); return; }
        const address = server.address();
        if (!address || typeof address === 'string') throw new BridgeError('CONFIG_INVALID', 'Roon 媒体监听没有有效端口');
        actor.origin = `http://${actor.peer.localAddress}:${address.port}`;
        try { this.options.logger.info('roon_media_listener_ready', { host: actor.peer.localAddress, port: address.port }); } catch { /* 诊断不撤销已成功的监听。 */ }
      } catch (error) {
        await this.close(server);
        // 保留未就绪 actor，禁止将远端播放悄悄回退到 loopback URL。
        throw error;
      }
    });
    this.serial = work;
    return work;
  }

  private async close(server: Server): Promise<void> {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    this.servers.delete(server);
  }
}
