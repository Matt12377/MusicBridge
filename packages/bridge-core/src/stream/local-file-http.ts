import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AssetLease, LocalFileLeaseError } from './local-file-source.js';
import type { RoonGatewayStage } from '../roon/types.js';
export type LocalByteSelection = { status: 200 | 206; start: number; end: number } | { status: 400 | 416 };
/** 弱stat证据不接受If-Range强校验；多Range固定400，所有整数/文本有界。 */
export function selectLocalBytes(range: string | undefined, ifRange: string | undefined, size: number): LocalByteSelection {
  const full = { status: 200, start: 0, end: size - 1 } as const;
  if (range === undefined || ifRange !== undefined) return full;
  if (range.length > 128) return { status: 400 };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match || !match[1] && !match[2]) return { status: 400 };
  const first = match[1] ? Number(match[1]) : undefined, last = match[2] ? Number(match[2]) : undefined;
  if (first !== undefined && !Number.isSafeInteger(first) || last !== undefined && !Number.isSafeInteger(last)) return { status: 400 };
  if (first === undefined) return last === 0 ? { status: 416 } : { status: 206, start: Math.max(0, size - last!), end: size - 1 };
  if (last !== undefined && last < first) return { status: 400 };
  if (first >= size) return { status: 416 };
  return { status: 206, start: first, end: Math.min(last ?? size - 1, size - 1) };
}
export async function serveLocalFile(lease: AssetLease, request: IncomingMessage, response: ServerResponse, contentType = 'application/octet-stream', onStage?:(stage:RoonGatewayStage)=>void): Promise<void> {
  const stage=(value:RoonGatewayStage):void=>{try{onStage?.(value);}catch{/* 诊断不改变原字节传输。 */}};
  let release: (() => void) | undefined;
  const controller = new AbortController(), abort = (): void => { controller.abort(); };
  const close = (): void => { if (!response.writableFinished) abort(); };
  request.once('aborted', abort); response.once('close', close); lease.signal.addEventListener('abort', abort, { once: true });
  try {
    // 首次身份失败在还未归属租约的response上返回安全409；已发送的流则主动断开。
    await lease.verify(); controller.signal.throwIfAborted(); release = lease.attachResponse(response);
    const selection = request.method === 'HEAD' ? { status: 200, start: 0, end: lease.size - 1 } as const
      : selectLocalBytes(request.headers.range, typeof request.headers['if-range'] === 'string' ? request.headers['if-range'] : undefined, lease.size);
    if (!('start' in selection)) { stage('error'); response.writeHead(selection.status, { 'Content-Length': 0, ...(selection.status === 416 ? { 'Content-Range': `bytes */${lease.size}` } : {}) }); response.end(); return; }
    response.writeHead(selection.status, { 'Content-Type': contentType, 'Content-Length': selection.end - selection.start + 1,
      ...(selection.status === 206 ? { 'Content-Range': `bytes ${selection.start}-${selection.end}/${lease.size}` } : {}),
      'Accept-Ranges': 'bytes', ETag: lease.weakEtag, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    stage('headers');
    if (request.method === 'HEAD') { response.end(); return; }
    const start=selection.start,end=selection.end;
    async function* observedBytes() {
      let first=true;
      for await(const chunk of lease.readSlice(start, end, controller.signal)){
        if(first){first=false;stage('streaming');}yield chunk;
      }
    }
    await pipeline(Readable.from(observedBytes(), { objectMode: false, highWaterMark: 64 * 1024 }), response, { signal: controller.signal });
    stage('completed');
  } catch (error) {
    stage(controller.signal.aborted?'aborted':'error');
    if (response.headersSent) response.destroy();
    else { response.writeHead(error instanceof LocalFileLeaseError && error.code === 'CAPACITY' ? 429 : 409, { 'Content-Length': 0, 'Cache-Control': 'no-store' }); response.end(); }
  } finally { request.off('aborted', abort); response.off('close', close); lease.signal.removeEventListener('abort', abort); release?.(); }
}
