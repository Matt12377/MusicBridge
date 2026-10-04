import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
const MAX_REQUESTS = 4;
const READ_CHUNK_BYTES = 64 * 1024;
const ICON_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

/** 仅由隔离runner自建；不是公开文件选择或播放请求。 */
export interface SyntheticInputDescriptor {
  readonly kind: 'synthetic';
  readonly sampleAlias: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface Lease {
  input: SyntheticInputDescriptor;
  handle: FileHandle;
  identity: string;
  token: string;
  revoked: boolean;
  closed: boolean;
  refs: number;
  responses: Set<ServerResponse>;
  drained: Array<() => void>;
  closing?: Promise<void>;
}

export interface SyntheticFileHttp {
  readonly iconUrl: string;
  /** 能力URL只留在可信工具内存，不写报告或Renderer。 */
  readonly registrations: readonly { sampleAlias: string; mediaUrl: string }[];
  revoke(sampleAlias: string): Promise<void>;
  close(): Promise<void>;
  waitForRequestsDrained(): Promise<void>;
  resourceSnapshot(): { openFds: number; closedFds: number; activeRequestRefs: number; activeTokens: number };
  /** 关闭计数之外，实际调用已关闭FD的stat验证EBADF；不会重新打开路径。 */
  releasedHandlesRejectStat(): Promise<boolean>;
}

type ByteSelection = { status: 200 | 206; start: number; end: number }
  | { status: 400 | 416 };

/** 有界单Range；HEAD在调用之前忽略Range，If-Range只接受本文件强ETag。 */
function selectBytes(range: string | undefined, ifRange: string | undefined, size: number, etag: string): ByteSelection {
  const full = { status: 200, start: 0, end: size - 1 } as const;
  if (range === undefined || (ifRange !== undefined && ifRange !== etag)) return full;
  if (range.length > 128) return { status: 400 };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match || (!match[1] && !match[2])) return { status: 400 };
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  if ((start !== undefined && !Number.isSafeInteger(start)) || (end !== undefined && !Number.isSafeInteger(end))) return { status: 400 };
  if (start === undefined) {
    if (end === 0) return { status: 416 };
    return { status: 206, start: Math.max(0, size - end!), end: size - 1 };
  }
  if (end !== undefined && end < start) return { status: 400 };
  if (start >= size) return { status: 416 };
  return { status: 206, start, end: Math.min(end ?? size - 1, size - 1) };
}

function identity(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function validateDescriptor(input: SyntheticInputDescriptor): void {
  if (!input || input.kind !== 'synthetic'
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(input.sampleAlias)
    || typeof input.relativePath !== 'string' || input.relativePath.length > 128
    || path.isAbsolute(input.relativePath) || input.relativePath.includes('\0')
    || input.relativePath.split(path.sep).some(part => part === '' || part === '.' || part === '..')
    || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_SAMPLE_BYTES
    || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new Error('合成样本描述符不合法。');
  }
}

/** 全部输入先准入，再open或listen；不读取.env，也不访问任何上游服务。 */
export async function startSyntheticFileHttp(options: {
  fixtureDirectory: string;
  inputs: readonly SyntheticInputDescriptor[];
}): Promise<SyntheticFileHttp> {
  const storage = buildStoragePolicy();
  const fixtureDirectory = storage.check(options.fixtureDirectory, { mustExist: true });
  const rootInfo = await lstat(fixtureDirectory, { bigint: true });
  if ((rootInfo.mode & 0o777n) !== 0o700n
    || (process.getuid && rootInfo.uid !== BigInt(process.getuid()))) {
    throw new Error('合成样本目录必须为本次runner所有的0700私有目录。');
  }
  if (!Array.isArray(options.inputs) || options.inputs.length < 1 || options.inputs.length > 3) {
    throw new Error('隔离样本数量必须为1至3。');
  }
  const aliases = new Set<string>();
  const prepared: Array<{ input: SyntheticInputDescriptor; file: string; info: BigIntStats }> = [];
  for (const original of options.inputs) {
    validateDescriptor(original);
    const input = Object.freeze({ ...original });
    if (aliases.has(input.sampleAlias)) throw new Error('合成样本别名不能重复。');
    aliases.add(input.sampleAlias);
    const file = storage.check(path.join(fixtureDirectory, input.relativePath), { mustExist: true, kind: 'file' });
    const relative = path.relative(fixtureDirectory, file);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('合成样本必须位于本次私有目录。');
    }
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(input.sizeBytes)
      || info.dev !== rootInfo.dev || (process.getuid && info.uid !== BigInt(process.getuid()))) {
      throw new Error('合成样本文件身份不符合预核描述符。');
    }
    prepared.push({ input, file, info });
  }

  const leases: Lease[] = [];
  const tokens = new Map<string, Lease>();
  let activeRequestRefs = 0;
  let closing: Promise<void> | undefined;

  async function revokeLease(lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing;
    lease.revoked = true;
    tokens.delete(lease.token);
    lease.closing = (async () => {
      for (const response of lease.responses) response.destroy();
      if (lease.refs > 0) await new Promise<void>(resolve => lease.drained.push(resolve));
      await lease.handle.close();
      lease.closed = true;
    })();
    return lease.closing;
  }

  async function* readSlice(lease: Lease, start: number, end: number): AsyncGenerator<Buffer> {
    for (let position = start; position <= end;) {
      if (lease.revoked) throw new Error('合成媒体租约已撤销。');
      if (identity(await lease.handle.stat({ bigint: true })) !== lease.identity) {
        throw new Error('合成媒体文件身份已变化。');
      }
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - position + 1));
      const { bytesRead } = await lease.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead !== buffer.length) throw new Error('合成媒体读取长度不一致。');
      position += bytesRead;
      yield buffer;
    }
  }

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!closing && request.url === '/assets/icon.png' && (request.method === 'GET' || request.method === 'HEAD')) {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ICON_PNG.length, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : ICON_PNG); return;
    }
    // 只匹配能力表；请求URL从不变成filesystem路径。
    const match = /^\/sample\/([A-Za-z0-9_-]{43})$/u.exec(request.url ?? '');
    const lease = match ? tokens.get(match[1]!) : undefined;
    if (!lease || lease.revoked || closing || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404); response.end(); return;
    }
    if (activeRequestRefs >= MAX_REQUESTS) {
      response.writeHead(429); response.end(); return;
    }
    lease.refs += 1;
    activeRequestRefs += 1;
    lease.responses.add(response);
    try {
      if (identity(await lease.handle.stat({ bigint: true })) !== lease.identity) {
        throw new Error('合成媒体文件身份已变化。');
      }
      const etag = `"${lease.input.sha256}"`;
      const selection = request.method === 'HEAD'
        ? { status: 200, start: 0, end: lease.input.sizeBytes - 1 } as const
        : selectBytes(request.headers.range, typeof request.headers['if-range'] === 'string' ? request.headers['if-range'] : undefined, lease.input.sizeBytes, etag);
      if (!('start' in selection)) {
        response.writeHead(selection.status, { 'Content-Length': 0, 'Accept-Ranges': 'bytes',
          ...(selection.status === 416 ? { 'Content-Range': `bytes */${lease.input.sizeBytes}` } : {}) });
        response.end(); return;
      }
      response.writeHead(selection.status, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': selection.end - selection.start + 1,
        ...(selection.status === 206 ? { 'Content-Range': `bytes ${selection.start}-${selection.end}/${lease.input.sizeBytes}` } : {}),
        'Accept-Ranges': 'bytes', ETag: etag,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      // HEAD忽略Range，返回完整长度且不读取正文。
      if (request.method === 'HEAD') { response.end(); return; }
      await pipeline(Readable.from(readSlice(lease, selection.start, selection.end)), response);
    } catch {
      // 不公开原路径、能力token或内部错误。
      if (response.headersSent) response.destroy();
      else { response.writeHead(409); response.end(); }
    } finally {
      lease.responses.delete(response);
      lease.refs -= 1;
      activeRequestRefs -= 1;
      if (lease.refs === 0) for (const resolve of lease.drained.splice(0)) resolve();
    }
  }

  const server = createServer((request, response) => { void respond(request, response); });
  try {
    for (const { input, file, info } of prepared) {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const lease: Lease = { input, handle, identity: identity(info), token: randomBytes(32).toString('base64url'),
        revoked: false, closed: false, refs: 0, responses: new Set(), drained: [] };
      leases.push(lease);
      if (identity(await handle.stat({ bigint: true })) !== lease.identity) {
        throw new Error('打开后的合成文件身份与预核输入不一致。');
      }
      const hash = createHash('sha256');
      for await (const bytes of readSlice(lease, 0, input.sizeBytes - 1)) hash.update(bytes);
      if (hash.digest('hex') !== input.sha256) throw new Error('合成文件字节摘要与预核输入不一致。');
      if (identity(await handle.stat({ bigint: true })) !== lease.identity) {
        throw new Error('合成文件在预核期间发生变化。');
      }
      tokens.set(lease.token, lease);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    await Promise.all(leases.map(revokeLease));
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('隔离HTTP没有取得loopback端口。');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    iconUrl: `${baseUrl}/assets/icon.png`,
    registrations: Object.freeze(leases.map(lease => Object.freeze({
      sampleAlias: lease.input.sampleAlias, mediaUrl: `${baseUrl}/sample/${lease.token}`,
    }))),
    async revoke(sampleAlias) {
      const lease = leases.find(candidate => candidate.input.sampleAlias === sampleAlias);
      if (!lease) throw new Error('未知合成样本别名。');
      await revokeLease(lease);
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close(error => { if (error) reject(error); else resolve(); });
        });
        await Promise.all([serverClosed, ...leases.map(revokeLease)]);
      })();
      return closing;
    },
    resourceSnapshot() {
      return { openFds: leases.filter(lease => !lease.closed).length,
        closedFds: leases.filter(lease => lease.closed).length, activeRequestRefs, activeTokens: tokens.size };
    },
    async waitForRequestsDrained() {
      await Promise.all(leases.map(lease => lease.refs === 0 ? Promise.resolve()
        : new Promise<void>(resolve => lease.drained.push(resolve))));
    },
    async releasedHandlesRejectStat() {
      if (leases.some(lease => !lease.closed)) return false;
      for (const lease of leases) {
        try { await lease.handle.stat(); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') return false; }
      }
      return true;
    },
  };
}
