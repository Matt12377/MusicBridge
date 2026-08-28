import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parseBuffer } from 'music-metadata';
import { isSourceTechnical, type SourceTechnical, type SourceFailure, type SourceAvailability } from '@music-bridge/contracts';

export class SourceFileError extends Error { constructor(readonly code: SourceFailure) { super(code); } }
export interface RootCapability { id: string; path: string; dev: string; ino: string; authorized: boolean; label: string }
export interface FileEvidence { sha256: string; size: number; signature: string; modifiedAt: string; verifiedAt: string; technical: SourceTechnical }
const fail = (code: SourceFailure): never => { throw new SourceFileError(code); };
const signature = (s: BigIntStats): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
/** 只把有界的技术块交给探测器；封面、标签及任意文本块不进入解析器。 */
function technicalHeader(prefix: Buffer, size: number): { bytes: Buffer; mimeType: string; virtualSize: number; sampleFrames: number; durationMs?: number } {
  const magic = prefix.subarray(0, 4).toString('ascii');
  if (magic === 'fLaC') {
    if (prefix.length < 42 || (prefix[4]! & 0x7f) !== 0 || prefix.readUIntBE(5, 3) !== 34) return fail('UNSUPPORTED');
    let offset = 4, blocks = 0;
    while (offset + 4 <= prefix.length && ++blocks <= 2048) {
      const length = prefix.readUIntBE(offset + 1, 3), last = (prefix[offset]! & 0x80) !== 0;
      offset += 4 + length;
      if (offset >= size) return fail('UNSUPPORTED');
      if (last) { const bytes = Buffer.from(prefix.subarray(0, 42)); bytes[4] = 0x80; return { bytes, mimeType: 'audio/flac', virtualSize: size, sampleFrames: Number(prefix.readBigUInt64BE(18) & 0xfffffffffn) }; }
    }
    return fail('LIMIT_EXCEEDED');
  }
  const wav = magic === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WAVE';
  const aiff = magic === 'FORM' && prefix.subarray(8, 12).toString('ascii') === 'AIFF';
  if (!wav && !aiff || prefix.length < 12) return fail('UNSUPPORTED');
  const readSize = (at: number): number => wav ? prefix.readUInt32LE(at) : prefix.readUInt32BE(at);
  const end = readSize(4) + 8;
  if (end > size || end < 20) return fail('UNSUPPORTED');
  let format: Buffer | undefined, offset = 12, blocks = 0;
  while (offset + 8 <= prefix.length && ++blocks <= 2048) {
    const id = prefix.subarray(offset, offset + 4).toString('ascii'), length = readSize(offset + 4);
    if (offset + 8 + length > end) return fail('UNSUPPORTED');
    if (id === (wav ? 'fmt ' : 'COMM')) {
      if (format || (wav ? length < 16 || length > 40 : length !== 18) || offset + 8 + length > prefix.length) return fail('UNSUPPORTED');
      format = Buffer.from(prefix.subarray(offset, offset + 8 + length));
      if (wav && ![1, 3].includes(format.readUInt16LE(8))) return fail('UNSUPPORTED');
      // IEEE 浮点只支持 32/64 位；标签解析器不会替我们排除不存在的 16 位格式。
      if (wav && format.readUInt16LE(8) === 3 && ![32, 64].includes(format.readUInt16LE(22))) return fail('UNSUPPORTED');
    } else if (id === (wav ? 'data' : 'SSND')) {
      if (!format || length <= (wav ? 0 : 8)) return fail('UNSUPPORTED');
      if (wav) {
        const channels = format.readUInt16LE(10), bits = format.readUInt16LE(22), align = format.readUInt16LE(20), rate = format.readUInt32LE(12);
        if (!align || !rate || align !== channels * bits / 8 || length % align !== 0 || format.readUInt32LE(16) !== rate * align) return fail('UNSUPPORTED');
      } else {
        if (offset + 16 > prefix.length) return fail('LIMIT_EXCEEDED');
        const frames = format.readUInt32BE(10), channels = format.readUInt16BE(8), bits = format.readUInt16BE(14), dataOffset = prefix.readUInt32BE(offset + 8);
        if (!frames || !channels || !bits || frames * channels * Math.ceil(bits / 8) > length - 8 - dataOffset) return fail('UNSUPPORTED');
      }
      const bytes = Buffer.concat([prefix.subarray(0, 12), format, prefix.subarray(offset, offset + 8)]);
      const virtualSize = bytes.length + length;
      if (wav) bytes.writeUInt32LE(virtualSize - 8, 4); else bytes.writeUInt32BE(virtualSize - 8, 4);
      return { bytes, sampleFrames: wav ? length / format.readUInt16LE(20) : format.readUInt32BE(10), mimeType: wav ? 'audio/wav' : 'audio/aiff', virtualSize, ...(wav ? { durationMs: Math.round(length / format.readUInt16LE(20) / format.readUInt32LE(12) * 1000) } : {}) };
    }
    offset += 8 + length + (length % 2);
  }
  return fail('LIMIT_EXCEEDED');
}
export async function authorizeSourceDirectory(absolutePath: string): Promise<Omit<RootCapability, 'id'>> {
  if (!path.isAbsolute(absolutePath) || absolutePath.includes('\0') || absolutePath.split(path.sep).some(part => part === '..' || part === '.')) return fail('OUTSIDE_ROOT');
  try {
    const canonical = await realpath(absolutePath), info = await lstat(canonical, { bigint: true });
    if (!info.isDirectory() || canonical === path.parse(canonical).root) return fail('OUTSIDE_ROOT');
    return { path: canonical, dev: String(info.dev), ino: String(info.ino), authorized: true, label: path.basename(canonical).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240) || '源目录' };
  } catch (error) { if (error instanceof SourceFileError) throw error; return fail('SOURCE_ROOT_OFFLINE'); }
}
export async function sourceRootAvailability(root: RootCapability): Promise<'ONLINE' | 'SOURCE_ROOT_OFFLINE' | 'REVOKED'> {
  if (!root.authorized) return 'REVOKED';
  try { const info = await lstat(root.path, { bigint: true }); return info.isDirectory() && String(info.dev) === root.dev && String(info.ino) === root.ino && await realpath(root.path) === root.path ? 'ONLINE' : 'SOURCE_ROOT_OFFLINE'; }
  catch { return 'SOURCE_ROOT_OFFLINE'; }
}
export function sourceRelativePath(root: RootCapability, absolutePath: string): string {
  if (!path.isAbsolute(absolutePath) || absolutePath.includes('\0') || absolutePath.split(path.sep).some(part => part === '..' || part === '.')) return fail('OUTSIDE_ROOT');
  const relative = path.relative(root.path, absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail('OUTSIDE_ROOT');
  return relative;
}
async function checkedFile(root: RootCapability, relative: string): Promise<{ absolute: string; info: BigIntStats }> {
  const available = await sourceRootAvailability(root); if (available !== 'ONLINE') return fail(available);
  if (path.isAbsolute(relative) || relative.split(path.sep).some(p => p === '..' || p === '.' || !p)) return fail('OUTSIDE_ROOT');
  const parts = relative.split(path.sep); let current = root.path;
  try {
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return fail('OUTSIDE_ROOT');
      if (index === parts.length - 1) {
        if (await realpath(current) !== current) return fail('OUTSIDE_ROOT');
        return { absolute: current, info };
      }
    }
  } catch (error) { if (error instanceof SourceFileError) throw error; return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'IO_ERROR'); }
  return fail('OUTSIDE_ROOT');
}
export async function sourceFileAvailability(root: RootCapability, relative: string, expected: string): Promise<SourceAvailability> {
  try { return signature((await checkedFile(root, relative)).info) === expected ? 'ONLINE' : 'CONTENT_CHANGED'; }
  catch (error) { const code = error instanceof SourceFileError ? error.code : 'IO_ERROR'; return code === 'REVOKED' || code === 'SOURCE_ROOT_OFFLINE' || code === 'MISSING' ? code : 'CONTENT_CHANGED'; }
}
/** Core 内部只读句柄租期：完整 Hash 后读取，结束时重核文件与授权身份；不公开句柄或路径。 */
export async function withVerifiedReadonlySource<T>(root: RootCapability, relative: string, expected: { sha256: string; size: number }, signal: AbortSignal, consume: (handle: FileHandle, check: () => void) => Promise<T>, checkOperation: () => void = () => undefined): Promise<T> {
  const deadline = Date.now() + 15 * 60_000;
  const check = (): void => { checkOperation(); if (signal.aborted) fail('CANCELLED'); if (Date.now() > deadline) fail('LIMIT_EXCEEDED'); };
  check(); const first = await checkedFile(root, relative);
  if (!/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 68_719_476_736 || first.info.size !== BigInt(expected.size)) return fail('CONTENT_CHANGED');
  const handle = await open(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('IO_ERROR'));
  try {
    const before = await handle.stat({ bigint: true });
    if (signature(before) !== signature(first.info) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < expected.size) {
      check(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset);
      if (!bytesRead) return fail('CONTENT_CHANGED'); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (hash.digest('hex') !== expected.sha256) return fail('HASH_MISMATCH');
    if (signature(await handle.stat({ bigint: true })) !== signature(before)) return fail('CONTENT_CHANGED');
    check(); const result = await consume(handle, check); check();
    if (signature(await handle.stat({ bigint: true })) !== signature(before) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    return result;
  } finally { await handle.close(); }
}
export interface ReplicaSourceLeaseOptions {
  /** 必须由冻结帧数/采样率计算；公开请求没有时长或期限参数。 */
  durationMs: number;
  preparationTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  watchIntervalMs?: number;
  /** 只供可信测试注入单调时钟，不改变生产上限。 */
  now?: () => number;
  /** 同FD格式/PCM核验属于准备阶段，不能挤占消费余量。 */
  verify?: (handle: FileHandle, check: () => void, signal: AbortSignal) => Promise<void>;
  finalize?: (handle: FileHandle, check: () => void, signal: AbortSignal) => Promise<void>;
}
/** Replica独立有限租期；旧源/编译调用的15分钟默认完全不变。 */
export async function withVerifiedReadonlyReplicaSource<T>(root: RootCapability, relative: string, expected: { sha256: string; size: number }, signal: AbortSignal,
  consume: (handle: FileHandle, check: () => void, signal: AbortSignal) => Promise<T>, checkOperation: () => void, options: ReplicaSourceLeaseOptions): Promise<T> {
  const limit = (value: number | undefined, maximum: number): number => { const n = value ?? maximum; if (!Number.isSafeInteger(n) || n < 1 || n > maximum) return fail('LIMIT_EXCEEDED'); return n; };
  const duration = limit(options.durationMs, 6 * 60 * 60_000), preparation = limit(options.preparationTimeoutMs, 15 * 60_000), finalization = limit(options.finalizationTimeoutMs, 15 * 60_000);
  const watchMs = limit(options.watchIntervalMs, 1000), now = options.now ?? (() => performance.now());
  const controller = new AbortController(), started = now(), totalDeadline = started + preparation + duration + 120_000 + finalization;
  let deadline = started + preparation;
  const abort = (error: unknown) => { if (!controller.signal.aborted) controller.abort(error); };
  const forwarded = () => abort(signal.reason instanceof Error ? signal.reason : new SourceFileError('CANCELLED'));
  signal.addEventListener('abort', forwarded, { once: true }); if (signal.aborted) forwarded();
  const check = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason;
    try { checkOperation(); if (now() > Math.min(deadline, totalDeadline)) fail('LIMIT_EXCEEDED'); }
    catch (error) { abort(error); throw error; }
  };
  let handle: FileHandle | undefined, control: ReturnType<typeof setInterval> | undefined, watcher: ReturnType<typeof setInterval> | undefined, watching: Promise<void> | undefined;
  try {
    check(); const first = await checkedFile(root, relative);
    if (!/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 68_719_476_736 || first.info.size !== BigInt(expected.size) || first.info.nlink !== 1n) return fail('CONTENT_CHANGED');
    handle = await open(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('IO_ERROR'));
    const opened = handle, before = await opened.stat({ bigint: true });
    const verifyIdentity = async () => { check(); const current = await opened.stat({ bigint: true }), named = (await checkedFile(root, relative)).info; check(); if (current.nlink !== 1n || named.nlink !== 1n || signature(current) !== signature(before) || signature(named) !== signature(before)) fail('CONTENT_CHANGED'); };
    if (signature(before) !== signature(first.info)) return fail('CONTENT_CHANGED');
    const hashFile = async () => {
      const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
      while (offset < expected.size) { check(); const { bytesRead } = await opened.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset); if (!bytesRead) fail('CONTENT_CHANGED'); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead; }
      check(); if (hash.digest('hex') !== expected.sha256) fail('HASH_MISMATCH');
    };
    control = setInterval(() => { try { check(); } catch (error) { abort(error); } }, 50);
    await verifyIdentity(); await hashFile(); await options.verify?.(opened, check, controller.signal); await verifyIdentity();
    deadline = Math.min(totalDeadline - finalization, now() + duration + 120_000);
    watcher = setInterval(() => { if (!watching) watching = verifyIdentity().catch(abort).finally(() => { watching = undefined; }); }, watchMs);
    // consume必须等待其持有者真正close；超时只撤销signal，绝不race后释放仍在使用的FD。
    const result = await consume(opened, check, controller.signal);
    check(); clearInterval(watcher); if (watching) await watching; check();
    deadline = Math.min(totalDeadline, now() + finalization);
    await verifyIdentity(); await hashFile(); await options.finalize?.(opened, check, controller.signal); await verifyIdentity(); check(); return result;
  } finally {
    clearInterval(control); clearInterval(watcher); signal.removeEventListener('abort', forwarded);
    if (watching) await watching;
    if (handle) await handle.close();
  }
}
/** 目标句柄由工作区层排他创建；这里不接收目标路径，也不修改原件属性。 */
export async function copyReadonlySource(root: RootCapability, relative: string, expected: { sha256: string; size: number }, destination: FileHandle, signal: AbortSignal): Promise<{ sha256: string; size: number }> {
  const checkAbort = (): void => { if (signal.aborted) fail('CANCELLED'); };
  checkAbort(); const first = await checkedFile(root, relative);
  if (!Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 68_719_476_736 || first.info.size !== BigInt(expected.size)) return fail('CONTENT_CHANGED');
  const source = await open(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await source.stat({ bigint: true }), target = await destination.stat({ bigint: true });
    if (signature(before) !== signature(first.info) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    if (!target.isFile() || target.size !== 0n || (target.dev === before.dev && target.ino === before.ino)) return fail('IO_ERROR');
    const inputHash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024), deadline = Date.now() + 15 * 60_000;
    let offset = 0;
    while (offset < expected.size) {
      checkAbort(); if (Date.now() > deadline) return fail('LIMIT_EXCEEDED');
      const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset);
      if (!bytesRead) return fail('CONTENT_CHANGED');
      inputHash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        checkAbort();
        const { bytesWritten } = await destination.write(chunk, written, bytesRead - written, offset + written);
        if (!bytesWritten) return fail('IO_ERROR');
        written += bytesWritten;
      }
      offset += bytesRead;
    }
    checkAbort();
    if (signature(await source.stat({ bigint: true })) !== signature(before) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    if (inputHash.digest('hex') !== expected.sha256) return fail('HASH_MISMATCH');
    await destination.sync();
    const outputHash = createHash('sha256'); offset = 0;
    while (offset < expected.size) {
      checkAbort();
      const { bytesRead } = await destination.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset);
      if (!bytesRead) return fail('HASH_MISMATCH');
      outputHash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    checkAbort();
    if ((await destination.stat()).size !== expected.size || outputHash.digest('hex') !== expected.sha256) return fail('HASH_MISMATCH');
    if (signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    return { sha256: expected.sha256, size: expected.size };
  } finally { await source.close(); }
}
/** 原件始终只读；完整 Hash 与头部技术探测是独立证据，不宣称音频逐帧解码通过。 */
export async function probeReadonlySource(root: RootCapability, relative: string, signal: AbortSignal): Promise<FileEvidence> {
  const checkAbort = (): void => { if (signal.aborted) fail('CANCELLED'); };
  checkAbort(); const first = await checkedFile(root, relative);
  if (first.info.size <= 0n || first.info.size > 68_719_476_736n) return fail('LIMIT_EXCEEDED');
  const handle = await open(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('IO_ERROR'));
  try {
    const before = await handle.stat({ bigint: true });
    if (signature(before) !== signature(first.info) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
    // 探测最多取前 16 MiB；超大头部或需要文件尾才能探测的格式明确拒绝。
    const prefix = Buffer.alloc(Math.min(Number(before.size), 16 * 1024 * 1024));
    let offset = 0; const deadline = Date.now() + 15 * 60_000;
    while (offset < Number(before.size)) {
      checkAbort(); if (Date.now() > deadline) return fail('LIMIT_EXCEEDED');
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      if (!bytesRead) return fail('CONTENT_CHANGED');
      hash.update(chunk.subarray(0, bytesRead));
      if (offset < prefix.length) chunk.copy(prefix, offset, 0, Math.min(bytesRead, prefix.length - offset));
      offset += bytesRead;
    }
    checkAbort();
    const header = technicalHeader(prefix, Number(before.size));
    const metadata = await parseBuffer(header.bytes, { mimeType: header.mimeType, size: header.virtualSize }, { skipCovers: true, skipPostHeaders: true }).catch(() => fail('UNSUPPORTED'));
    const f = metadata.format;
    const technical = { container: f.container, codec: f.codec, sampleRate: f.sampleRate, channels: f.numberOfChannels,
      durationMs: f.sampleRate === undefined ? undefined : Math.round(header.sampleFrames / f.sampleRate * 1000), lossless: f.lossless, sampleFrames: header.sampleFrames, frameEvidence: 'container-declared',
      ...(f.bitsPerSample ? { bitsPerSample: f.bitsPerSample } : {}) };
    if (!isSourceTechnical(technical) || !technical.lossless) return fail('UNSUPPORTED');
    checkAbort();
    if (signature(await handle.stat({ bigint: true })) !== signature(before) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    return { sha256: hash.digest('hex'), size: Number(before.size), signature: signature(before), modifiedAt: new Date(Number(before.mtimeNs / 1_000_000n)).toISOString(), verifiedAt: new Date().toISOString(), technical };
  } finally { await handle.close(); }
}
