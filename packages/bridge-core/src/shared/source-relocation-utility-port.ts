import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { localRelocationDataSnapshot, localRelocationMainRequestSnapshot, localRelocationMainResponseSnapshot, localRelocationRecord,
  type LocalRelocationMainCommand } from '@music-bridge/contracts';

export const LOCAL_RELOCATION_MAIN_PORT_BOOTSTRAP = 'local-relocation-main-port-v1' as const;
export interface RelocationUtilityPort {
  on(event: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): unknown;
  on(event: 'close' | 'messageerror', listener: () => void): unknown;
  off(event: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): unknown;
  off(event: 'close' | 'messageerror', listener: () => void): unknown;
  start(): void; postMessage(message: unknown): void; close(): void;
}
/** Electron端留在Utility；Owner只接新真实NodeMessageChannel，旧012channel不参与本域。 */
export function createUtilityRelocationBridge(parent: RelocationUtilityPort): { port: MessagePort; close(): void } {
  const channel = new MessageChannel(), delivered = channel.port2;
  let source: RelocationUtilityPort | undefined = parent, relay: MessagePort | undefined = channel.port1, undelivered: MessagePort | undefined = delivered;
  let closed = false, lastSequence = 0;
  const pending = new Map<string, { command: LocalRelocationMainCommand; sequence: number }>();
  function close(): void {
    if (closed) return; closed = true;
    const oldSource = source, oldRelay = relay, oldUndelivered = undelivered;
    source = undefined; relay = undefined; undelivered = undefined; pending.clear();
    for (const event of ['close', 'messageerror'] as const) {
      try { oldSource?.off(event, close); } catch { /* 继续关闭其它真实句柄。 */ }
      try { oldRelay?.off(event, close); } catch { /* 同上。 */ }
    }
    try { oldSource?.off('message', receiveUtility); } catch { /* 同上。 */ }
    try { oldRelay?.off('message', receiveOwner); } catch { /* 同上。 */ }
    try { oldSource?.close(); } catch { /* 不重建、不重放未知命令。 */ }
    try { oldRelay?.close(); } catch { /* actor对端撤销。 */ }
    try { oldUndelivered?.close(); } catch { /* 已转移端由Owner管理。 */ }
  }
  function receiveUtility(event: { data: unknown; ports?: readonly unknown[] }): void {
    if (closed) return;
    try {
      if (pending.size >= 4 || !event || typeof event !== 'object') throw new Error('本域专用通道超限。');
      const data = Object.getOwnPropertyDescriptor(event, 'data'), ports = Object.getOwnPropertyDescriptor(event, 'ports');
      if (!data || !Object.hasOwn(data, 'value') || ports && (!Object.hasOwn(ports, 'value') || !Array.isArray(ports.value) || ports.value.length)) throw new Error('本域请求不接受额外端口。');
      const request = localRelocationMainRequestSnapshot(data.value);
      if (request.sequence !== lastSequence + 1 || pending.has(request.requestId)) throw new Error('本域请求序号或身份重复。');
      lastSequence = request.sequence; pending.set(request.requestId, { command: request.command, sequence: request.sequence }); relay!.postMessage(request);
    } catch { close(); }
  }
  function receiveOwner(raw: unknown): void {
    if (closed) return;
    try {
      // Main五命令仅小回执和单一challenge；公开history/plan不经此通道，也不扩大请求G0预算。
      const captured = localRelocationDataSnapshot(raw, { maxBytes: 16_384, maxTextBytes: 16_384 });
      if (!localRelocationRecord(captured, ['version', 'type', 'requestId', 'sequence', 'ok'], ['result', 'failure']) || typeof captured.requestId !== 'string') throw new Error('本域回执封套无效。');
      const original = pending.get(captured.requestId);
      if (!original) throw new Error('本域回执没有原在途请求。');
      const response = localRelocationMainResponseSnapshot(captured, original.command);
      if (response.sequence !== original.sequence) throw new Error('本域回执序号不匹配。');
      pending.delete(response.requestId); source!.postMessage(response);
    } catch { close(); }
  }
  try {
    relay.on('message', receiveOwner); relay.on('close', close); relay.on('messageerror', close);
    source.on('message', receiveUtility); source.on('close', close); source.on('messageerror', close); relay.start(); source.start();
  } catch { close(); throw new Error('本域实际物理端口适配失败。'); }
  return { port: delivered, close };
}
