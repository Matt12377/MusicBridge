import { MessageChannel, type MessagePort } from 'node:worker_threads';
import {
  LOCAL_SOURCE_WRITES_BUDGET,
  localSourceWritesDataSnapshot,
  localSourceWritesMainRequestSnapshot,
  localSourceWritesMainResponseSnapshot,
  localSourceWritesRecord,
  type LocalSourceWritesPrivateCommand,
} from '@music-bridge/contracts';

/** 只由可信父 bootstrap 交付；消息载荷不能构造这条物理通道。 */
export interface SourceWritesUtilityPort {
  on(event: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): unknown;
  on(event: 'close' | 'messageerror', listener: () => void): unknown;
  off(event: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): unknown;
  off(event: 'close' | 'messageerror', listener: () => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

/** Electron 端留在 Utility；仅返回新建的真实 Node 端供 Owner transferList 使用。 */
export function createUtilitySourceWritesBridge(parent: SourceWritesUtilityPort): { port: MessagePort; close(): void } {
  const channel = new MessageChannel();
  const deliveredPort = channel.port2;
  let source: SourceWritesUtilityPort | undefined = parent;
  let relay: MessagePort | undefined = channel.port1;
  let undelivered: MessagePort | undefined = deliveredPort;
  let closed = false, lastSequence = 0;
  const pending = new Map<string, { command: LocalSourceWritesPrivateCommand; sequence: number }>();

  function close(): void {
    if (closed) return;
    closed = true;
    const oldSource = source, oldRelay = relay, oldUndelivered = undelivered;
    source = undefined; relay = undefined; undelivered = undefined;
    pending.clear();
    // 固定数量的监听与句柄；先拆回调，关闭事件不能再次转发或递归关闭。
    try { oldSource?.off('message', receiveUtility); } catch { /* 故障端口仍继续释放其余句柄。 */ }
    try { oldSource?.off('close', close); } catch { /* 同上。 */ }
    try { oldSource?.off('messageerror', close); } catch { /* 同上。 */ }
    try { oldRelay?.off('message', receiveOwner); } catch { /* 同上。 */ }
    try { oldRelay?.off('close', close); } catch { /* 同上。 */ }
    try { oldRelay?.off('messageerror', close); } catch { /* 同上。 */ }
    try { oldSource?.close(); } catch { /* 一端故障不能阻止撤销 Node actor 对端。 */ }
    try { oldRelay?.close(); } catch { /* 不重建、不重放。 */ }
    try { oldUndelivered?.close(); } catch { /* 已转移的句柄由 Owner 接收；其对端已关闭。 */ }
  }

  function receiveUtility(event: { data: unknown; ports?: readonly unknown[] }): void {
    if (closed) return;
    try {
      if (pending.size >= 4 || typeof event !== 'object' || event === null) throw new Error('源写物理通道已超限或无效。');
      const data = Object.getOwnPropertyDescriptor(event, 'data'), ports = Object.getOwnPropertyDescriptor(event, 'ports');
      if (!data || !Object.hasOwn(data, 'value') || ports && (!Object.hasOwn(ports, 'value') || !Array.isArray(ports.value) || ports.value.length !== 0)) throw new Error('源写物理通道不接收额外端口。');
      // 原图走专用二进制 capture，不枚举字节、不经过通用 JSON 快照。
      const request = localSourceWritesMainRequestSnapshot(data.value);
      if (request.sequence !== lastSequence + 1 || pending.has(request.requestId)) throw new Error('源写请求序号或在途身份重复。');
      lastSequence = request.sequence;
      pending.set(request.requestId, { command: request.command, sequence: request.sequence });
      relay!.postMessage(request);
    } catch { close(); }
  }

  function receiveOwner(raw: unknown): void {
    if (closed) return;
    try {
      // 先受限捕获完整回执，再读取 id 查表；不执行原对象 getter。
      const captured = localSourceWritesDataSnapshot(raw, LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes);
      if (!localSourceWritesRecord(captured, ['version', 'type', 'requestId', 'sequence', 'ok'], ['result', 'failure']) || typeof captured.requestId !== 'string') throw new Error('源写回执封套无效。');
      const original = pending.get(captured.requestId);
      if (!original) throw new Error('源写回执没有对应在途请求。');
      const response = localSourceWritesMainResponseSnapshot(captured, original.command);
      if (response.sequence !== original.sequence) throw new Error('源写回执不属于原请求序号。');
      pending.delete(response.requestId);
      source!.postMessage(response);
    } catch { close(); }
  }

  try {
    relay.on('message', receiveOwner);
    relay.on('close', close);
    relay.on('messageerror', close);
    source.on('message', receiveUtility);
    source.on('close', close);
    source.on('messageerror', close);
    relay.start();
    source.start();
  } catch {
    close();
    throw new Error('源写专用物理通道适配失败。');
  }
  return { port: deliveredPort, close };
}
