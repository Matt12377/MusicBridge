import { isSourceWorkbenchDirectoryWire, captureSourceWorkbenchDirectoryRequest, captureSourceWorkbenchDirectoryReply, assertSourceWorkbenchDirectoryReplyForRequest, captureSourceWorkbenchDirectoryRegistrationRequest, captureSourceWorkbenchDirectoryRegistrationReply, assertSourceWorkbenchDirectoryRegistrationReplyForRequest, type SourceWorkbenchDirectoryRequest, type SourceWorkbenchDirectoryRegistrationRequest } from '../collection/source-writes-authority.js';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import {
  LOCAL_SOURCE_WRITES_BUDGET,
  localSourceWritesDataSnapshot,
  localSourceWritesMainRequestSnapshot,
  localSourceWritesMainResponseSnapshot,
  localSourceWritesRecord,
  type LocalSourceWritesPrivateCommand,
} from '@music-bridge/contracts';
import { isSourceWritesLyricsGrantWire, captureSourceWritesLyricsGrantRequest, captureSourceWritesLyricsGrantReply, assertSourceWritesLyricsGrantReplyForRequest,
  isSourceWritesLyricsVerifyWire,captureSourceWritesLyricsVerifyRequest,captureSourceWritesLyricsVerifyReply,assertSourceWritesLyricsVerifyReplyForRequest,
  type SourceWritesLyricsGrantRequest,type SourceWritesLyricsVerifyRequest } from '../collection/source-writes-authority.js';
import { lyricsPhysicalDigest } from '../library/lyrics-source-format.js';
import { isSourceWorkbenchReadersWire, captureSourceWorkbenchReadersRequest, captureSourceWorkbenchReadersReply, assertSourceWorkbenchReadersReplyForRequest, type SourceWorkbenchReadersRequest } from '../collection/source-writes-authority.js';

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
  // Owner→Main的唯一有限反向请求；不改变原Main→Owner命令序号与capture逻辑。
  const lyricsPending = new Map<string, SourceWritesLyricsGrantRequest>();
  const readersPending=new Map<string,SourceWorkbenchReadersRequest>();let lastReadersSequence=0;
  const directoryPending=new Map<string,SourceWorkbenchDirectoryRequest>(),directoryRegistrations=new Map<string,SourceWorkbenchDirectoryRegistrationRequest>();
  let lastDirectorySequence=0,lastDirectoryRegistrationSequence=0;
  let lastLyricsSequence = 0;
  let lastLyricsVerifySequence = 0;
  const lyricsVerifications = new Map<string,SourceWritesLyricsVerifyRequest>();

  function close(): void {
    if (closed) return;
    closed = true;
    const oldSource = source, oldRelay = relay, oldUndelivered = undelivered;
    source = undefined; relay = undefined; undelivered = undefined;
    pending.clear();
    readersPending.clear();
    directoryPending.clear();directoryRegistrations.clear();
    lyricsPending.clear();
    lyricsVerifications.clear();
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
      if (typeof event !== 'object' || event === null) throw new Error('源写物理通道已超限或无效。');
      const data = Object.getOwnPropertyDescriptor(event, 'data'), ports = Object.getOwnPropertyDescriptor(event, 'ports');
      if (!data || !Object.hasOwn(data, 'value') || ports && (!Object.hasOwn(ports, 'value') || !Array.isArray(ports.value) || ports.value.length !== 0)) throw new Error('源写物理通道不接收额外端口。');
      if(isSourceWorkbenchReadersWire(data.value,'reply')){
        const r=captureSourceWorkbenchReadersReply(data.value),q=readersPending.get(r.requestId);if(!q)throw Error('按库读取回包没有原请求。');
        assertSourceWorkbenchReadersReplyForRequest(r,q);readersPending.delete(r.requestId);relay!.postMessage(r);return;
      }
      if(isSourceWorkbenchDirectoryWire(data.value,'registration-request')){
        const q=captureSourceWorkbenchDirectoryRegistrationRequest(data.value);if(q.sequence!==lastDirectoryRegistrationSequence+1||directoryRegistrations.size>=4||directoryRegistrations.has(q.requestId)||q.expiresAtMs<=Date.now()||q.expiresAtMs>Date.now()+2000)throw Error('目录登记原请求无效。');lastDirectoryRegistrationSequence=q.sequence;directoryRegistrations.set(q.requestId,q);relay!.postMessage(q);return;
      }
      if(isSourceWorkbenchDirectoryWire(data.value,'reply')){
        const r=captureSourceWorkbenchDirectoryReply(data.value),q=directoryPending.get(r.requestId);if(!q||Date.now()>=q.expiresAtMs)throw Error('目录许可回包没有原请求。');assertSourceWorkbenchDirectoryReplyForRequest(r,q);directoryPending.delete(r.requestId);relay!.postMessage(r);return;
      }
      if(isSourceWritesLyricsVerifyWire(data.value,'request')){
        const request=captureSourceWritesLyricsVerifyRequest(data.value),original=lyricsPending.get(request.grantRequest.requestId);
        if(!original||lyricsPhysicalDigest(original)!==lyricsPhysicalDigest(request.grantRequest)||request.sequence!==lastLyricsVerifySequence+1
          ||lyricsVerifications.size>=4||lyricsVerifications.has(request.requestId)||Date.now()>=original.expiresAtMs)throw new Error('歌词只读验证没有原在途grant。');
        lastLyricsVerifySequence=request.sequence;lyricsVerifications.set(request.requestId,request);relay!.postMessage(request);return;
      }
      if (isSourceWritesLyricsGrantWire(data.value, 'reply')) {
        const response = captureSourceWritesLyricsGrantReply(data.value), original = lyricsPending.get(response.requestId);
        if (!original || Date.now() >= original.expiresAtMs) throw new Error('歌词许可回包没有当前原请求。');
        assertSourceWritesLyricsGrantReplyForRequest(response, original);
        lyricsPending.delete(response.requestId); relay!.postMessage(response); return;
      }
      if (pending.size >= 4) throw new Error('源写物理通道已超限。');
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
      if(isSourceWorkbenchReadersWire(raw,'request')){
        const q=captureSourceWorkbenchReadersRequest(raw);if(q.sequence!==lastReadersSequence+1||readersPending.size>=4||readersPending.has(q.requestId)||q.expiresAtMs<=Date.now()||q.expiresAtMs>Date.now()+2000)throw Error('按库读取原fence序号或期限无效。');
        lastReadersSequence=q.sequence;readersPending.set(q.requestId,q);source!.postMessage(q);return;
      }
      if(isSourceWorkbenchDirectoryWire(raw,'registration-reply')){
        const r=captureSourceWorkbenchDirectoryRegistrationReply(raw),q=directoryRegistrations.get(r.requestId);if(!q||Date.now()>=q.expiresAtMs)throw Error('目录登记回包没有原请求。');assertSourceWorkbenchDirectoryRegistrationReplyForRequest(r,q);directoryRegistrations.delete(r.requestId);source!.postMessage(r);return;
      }
      if(isSourceWorkbenchDirectoryWire(raw,'request')){
        const q=captureSourceWorkbenchDirectoryRequest(raw);if(q.sequence!==lastDirectorySequence+1||directoryPending.size>=4||directoryPending.has(q.requestId)||q.expiresAtMs<=Date.now()||q.expiresAtMs>Date.now()+2000)throw Error('目录许可原请求无效。');lastDirectorySequence=q.sequence;directoryPending.set(q.requestId,q);source!.postMessage(q);return;
      }
      if(isSourceWritesLyricsVerifyWire(raw,'reply')){
        const response=captureSourceWritesLyricsVerifyReply(raw),request=lyricsVerifications.get(response.requestId);
        if(!request||Date.now()>=request.grantRequest.expiresAtMs)throw new Error('歌词只读回包没有原请求。');
        assertSourceWritesLyricsVerifyReplyForRequest(response,request);lyricsVerifications.delete(response.requestId);source!.postMessage(response);return;
      }
      if (isSourceWritesLyricsGrantWire(raw, 'request')) {
        const request = captureSourceWritesLyricsGrantRequest(raw);
        if (lyricsPending.size >= 4 || request.sequence !== lastLyricsSequence + 1 || lyricsPending.has(request.requestId)
          || request.expiresAtMs <= Date.now() || request.expiresAtMs > Date.now() + 2000) throw new Error('歌词原请求序号或期限无效。');
        lastLyricsSequence = request.sequence; lyricsPending.set(request.requestId, request); source!.postMessage(request); return;
      }
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
