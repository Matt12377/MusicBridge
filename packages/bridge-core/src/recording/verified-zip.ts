import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';

/** 中立容器只处理调用方已独占创建的文件句柄；不决定来源、目标、发布或完成语义。 */
export class VerifiedZipError extends Error {
  constructor(readonly code: 'ENTRY_INVALID' | 'BUDGET_EXCEEDED' | 'CONTENT_CHANGED' | 'ARCHIVE_INVALID' | 'CANCELLED') { super(code); }
}
export interface ZipBudget {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxArchiveBytes: number;
}
export interface ZipEntryDescription { name: string; kind: 'file' | 'directory'; size: number; sha256?: string }
export interface ZipEntrySource extends ZipEntryDescription { open?: () => Promise<Readable> }
export interface ZipEntryReceipt extends ZipEntryDescription { crc32?: number }
export interface ZipReceipt { size: number; sha256: string; entries: readonly ZipEntryReceipt[] }

const hashPattern = /^[a-f0-9]{64}$/u;
function fail(code: VerifiedZipError['code']): never { throw new VerifiedZipError(code); }
const safeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(previous: number, chunk: Buffer): number {
  let value = previous ^ 0xffffffff;
  for (const byte of chunk) value = crcTable[(value ^ byte) & 0xff]! ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) fail('CANCELLED'); }
function closed(stream: Readable): Promise<void> {
  return stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve));
}
function checkBudget(budget: ZipBudget): void {
  if (![budget.maxEntries, budget.maxEntryBytes, budget.maxTotalBytes, budget.maxArchiveBytes].every(v => safeInteger(v) && v > 0) || budget.maxEntryBytes > budget.maxTotalBytes || budget.maxTotalBytes > Number.MAX_SAFE_INTEGER) fail('BUDGET_EXCEEDED');
}
function checkName(entry: ZipEntryDescription): string {
  const { name, kind } = entry;
  if (typeof name !== 'string' || !name || name !== name.normalize('NFC') || Buffer.byteLength(name) > 1024 || name.startsWith('/') || name.includes('\\') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return fail('ENTRY_INVALID');
  if (kind !== 'file' && kind !== 'directory' || name.endsWith('/') !== (kind === 'directory')) return fail('ENTRY_INVALID');
  const segments = (kind === 'directory' ? name.slice(0, -1) : name).split('/');
  if (segments.length > 16) return fail('ENTRY_INVALID');
  const canonical = segments.map(segment => {
    // NFKC 后再次检查组件，使兼容全角点、斜线、反斜线和冒号不能绕过路径规则。
    const compatible = segment.normalize('NFKC');
    if (!compatible || compatible === '.' || compatible === '..' || /[/\\:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(compatible) || /[. ]$/u.test(compatible) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(compatible)) return fail('ENTRY_INVALID');
    return compatible.toUpperCase().normalize('NFKC');
  });
  return canonical.join('/');
}
function checkEntries(entries: readonly ZipEntryDescription[], budget: ZipBudget): void {
  checkBudget(budget);
  if (!entries.length || entries.length > budget.maxEntries) fail('BUDGET_EXCEEDED');
  const nodes = new Map<string, 'file' | 'directory'>();
  let total = 0;
  for (const entry of entries) {
    const canonical = checkName(entry);
    if (!safeInteger(entry.size) || entry.kind === 'directory' && (entry.size !== 0 || entry.sha256 !== undefined) || entry.kind === 'file' && !hashPattern.test(entry.sha256 ?? '')) fail('ENTRY_INVALID');
    if (entry.size > budget.maxEntryBytes) fail('BUDGET_EXCEEDED');
    if (nodes.has(canonical)) fail('ENTRY_INVALID');
    nodes.set(canonical, entry.kind);
    total += entry.size;
    if (!safeInteger(total) || total > budget.maxTotalBytes) fail('BUDGET_EXCEEDED');
  }
  for (const [name] of nodes) {
    const segments = name.split('/');
    for (let i = 1; i < segments.length; i++) if (nodes.get(segments.slice(0, i).join('/')) === 'file') fail('ENTRY_INVALID');
  }
}
/** yazl 以 lazy stream 串行读取来源；写入句柄须由领域层在 owned staging 中 O_EXCL 创建。 */
export async function writeVerifiedZip(handle: FileHandle, sources: readonly ZipEntrySource[], budget: ZipBudget, signal: AbortSignal, options: { forceZip64?: boolean } = {}): Promise<ZipReceipt> {
  checkAbort(signal);
  checkEntries(sources, budget);
  if (sources.some(source => source.kind === 'file' ? typeof source.open !== 'function' : source.open !== undefined)) fail('ENTRY_INVALID');
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size !== 0n) fail('ARCHIVE_INVALID');
  const zip = new yazl.ZipFile();
  const zipOutput = zip.outputStream;
  if (!(zipOutput instanceof Readable)) fail('ARCHIVE_INVALID');
  const digest = createHash('sha256');
  let size = 0;
  let closing = false;
  const active = new Set<Readable>();
  const sourceTasks: Promise<void>[] = [];
  const writeTasks = new Set<Promise<void>>();
  function stopSources(error: Error): void { closing = true; for (const stream of active) stream.destroy(error); }
  function sourceStream(source: ZipEntrySource, callback: (error: Error | null, stream?: Readable) => void): void {
    const task = (async () => {
      let delivered = false;
      let original: Readable | undefined;
      let guard: Transform | undefined;
      let sourceClosed: Promise<void> = Promise.resolve();
      let guardClosed: Promise<void> = Promise.resolve();
      try {
        checkAbort(signal);
        original = await source.open!();
        sourceClosed = closed(original);
        if (closing || signal.aborted) { original.destroy(); await sourceClosed; fail('CANCELLED'); }
        active.add(original);
        let readSize = 0;
        const hash = createHash('sha256');
        guard = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            try {
              checkAbort(signal);
              readSize += chunk.length;
              if (!safeInteger(readSize) || readSize > source.size) return done(new VerifiedZipError('CONTENT_CHANGED'));
              hash.update(chunk); done(null, chunk);
            } catch (error) { done(error as Error); }
          },
          flush(done) { done(readSize === source.size && hash.digest('hex') === source.sha256 ? null : new VerifiedZipError('CONTENT_CHANGED')); },
        });
        active.add(guard);
        guardClosed = closed(guard);
        original.once('error', error => guard?.destroy(error));
        guard.once('error', error => original?.destroy(error));
        // yazl 3.3.1 不向 ZipFile 传播输入 readStream 的 error；必须主动终止输出管道。
        guard.once('error', error => zip.emit('error', error));
        delivered = true; callback(null, guard);
        original.pipe(guard);
        await guardClosed;
      } catch (error) {
        if (!delivered) callback(error as Error);
        else guard?.destroy(error as Error);
      } finally {
        if (guard && !guard.destroyed) guard.destroy();
        if (original && !original.destroyed) original.destroy();
        await Promise.all([sourceClosed, guardClosed]);
        if (guard) active.delete(guard);
        if (original) active.delete(original);
      }
    })();
    sourceTasks.push(task);
  }
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const task = (async () => {
        checkAbort(signal);
        if (!safeInteger(size + chunk.length) || size + chunk.length > budget.maxArchiveBytes) fail('BUDGET_EXCEEDED');
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset, size + offset);
          if (!result.bytesWritten) fail('ARCHIVE_INVALID');
          offset += result.bytesWritten;
        }
        size += chunk.length; digest.update(chunk);
      })();
      writeTasks.add(task);
      void task.then(() => done(), error => done(error as Error)).finally(() => writeTasks.delete(task));
    },
  });
  const abort = (): void => { const error = new VerifiedZipError('CANCELLED'); stopSources(error); zipOutput.destroy(error); output.destroy(error); };
  signal.addEventListener('abort', abort, { once: true });
  zip.on('error', error => zipOutput.destroy(error));
  const piped = pipeline(zipOutput, output);
  try {
    for (const source of sources) {
      checkAbort(signal);
      if (source.kind === 'directory') zip.addEmptyDirectory(source.name, { mode: 0o40700 });
      else zip.addReadStreamLazy(source.name, { mode: 0o100600, size: source.size, compress: false, forceZip64Format: options.forceZip64 === true }, callback => {
        // yazl 3.3.1 在 error 非空时不读取第二参数；类型声明将它误标为必填。
        const runtimeCallback = callback as (error: Error | null, stream?: NodeJS.ReadableStream) => void;
        sourceStream(source, runtimeCallback);
      });
    }
    zip.end({ forceZip64Format: options.forceZip64 === true, comment: '' });
    await piped;
    await Promise.all(sourceTasks);
    await Promise.all(writeTasks);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== BigInt(size)) fail('ARCHIVE_INVALID');
    checkAbort(signal);
    return { size, sha256: digest.digest('hex'), entries: sources.map(({ name, kind, size: entrySize, sha256 }) => ({ name, kind, size: entrySize, ...(sha256 ? { sha256 } : {}) })) };
  } catch (error) {
    stopSources(error as Error); zipOutput.destroy(); output.destroy();
    await piped.catch(() => undefined);
    await Promise.allSettled(sourceTasks);
    await Promise.allSettled(writeTasks);
    throw error;
  } finally { signal.removeEventListener('abort', abort); }
}

class HandleReader extends yauzl.RandomAccessReader {
  private readonly reads = new Set<Promise<unknown>>();
  constructor(private readonly handle: FileHandle) { super(); }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.reads.add(operation);
    void operation.then(() => this.reads.delete(operation), () => this.reads.delete(operation));
    return operation;
  }
  override _readStreamForRange(start: number, end: number): Readable {
    const reader = this;
    async function* chunks(): AsyncGenerator<Buffer> {
      let offset = start;
      while (offset < end) {
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, end - offset));
        const { bytesRead } = await reader.track(reader.handle.read(buffer, 0, buffer.length, offset));
        if (!bytesRead) fail('ARCHIVE_INVALID');
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    }
    return Readable.from(chunks(), { objectMode: false });
  }
  override read(buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | null) => void): void {
    void this.track(this.handle.read(buffer, offset, length, position)).then(
      result => (callback as (error: Error | null, bytesRead: number) => void)(null, result.bytesRead),
      error => callback(error as Error),
    );
  }
  override close(callback: (error: Error | null) => void): void { setImmediate(() => callback(null)); }
  async settle(): Promise<void> { while (this.reads.size) await Promise.allSettled([...this.reads]); }
}
function openZip(reader: HandleReader, size: number): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromRandomAccessReader(reader, size, { autoClose: true, lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : zip ? resolve(zip) : reject(new VerifiedZipError('ARCHIVE_INVALID'))));
}
function nextEntry(zip: yauzl.ZipFile, signal: AbortSignal): Promise<yauzl.Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { zip.off('entry', entry); zip.off('end', end); zip.off('error', error); zip.off('close', close); signal.removeEventListener('abort', abort); };
    const entry = (value: yauzl.Entry): void => { cleanup(); resolve(value); };
    const end = (): void => { cleanup(); resolve(undefined); };
    const error = (reason: Error): void => { cleanup(); reject(reason); };
    const abort = (): void => { zip.close(); };
    const close = (): void => { cleanup(); reject(new VerifiedZipError(signal.aborted ? 'CANCELLED' : 'ARCHIVE_INVALID')); };
    zip.once('entry', entry); zip.once('end', end); zip.once('error', error); signal.addEventListener('abort', abort, { once: true });
    zip.once('close', close);
    if (signal.aborted) abort(); else {
      try { zip.readEntry(); } catch (reason) { cleanup(); reject(reason); }
    }
  });
}
function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, signal: AbortSignal): Promise<Readable> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = (): void => { aborted = true; zip.close(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); signal.removeEventListener('abort', abort); reject(new VerifiedZipError('CANCELLED')); return; }
    const callback = (error: Error | null, stream?: Readable): void => {
      signal.removeEventListener('abort', abort);
      if (aborted || signal.aborted) {
        if (!stream) { reject(new VerifiedZipError('CANCELLED')); return; }
        const streamClosed = closed(stream);
        stream.destroy();
        void streamClosed.then(() => reject(new VerifiedZipError('CANCELLED')));
      } else if (error) reject(error);
      else if (stream) resolve(stream);
      else reject(new VerifiedZipError('ARCHIVE_INVALID'));
    };
    try { zip.openReadStream(entry, callback); }
    catch (error) { signal.removeEventListener('abort', abort); reject(error); }
  });
}
function checkEntryKind(entry: yauzl.Entry): 'file' | 'directory' {
  const directory = entry.fileName.endsWith('/');
  const unix = entry.versionMadeBy >>> 8 === 3;
  const mode = entry.externalFileAttributes >>> 16;
  const fileType = mode & 0o170000;
  if (unix && fileType !== (directory ? 0o040000 : 0o100000)) fail('ENTRY_INVALID');
  if (!unix && Boolean(entry.externalFileAttributes & 0x10) !== directory) fail('ENTRY_INVALID');
  if (entry.generalPurposeBitFlag & 1 || entry.compressionMethod !== 0 && entry.compressionMethod !== 8) fail('ENTRY_INVALID');
  return directory ? 'directory' : 'file';
}
async function hashHandle(handle: FileHandle, size: number, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (!bytesRead) fail('ARCHIVE_INVALID');
    hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
  }
  return hash.digest('hex');
}
/** 全量读取每个条目（包括调用方不需要提取的条目），逐项检查 CRC、SHA、尺寸和容器预算。 */
export async function verifyVerifiedZip(handle: FileHandle, expected: readonly ZipEntryDescription[], budget: ZipBudget, signal: AbortSignal): Promise<ZipReceipt> {
  checkAbort(signal);
  checkEntries(expected, budget);
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > BigInt(budget.maxArchiveBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('BUDGET_EXCEEDED');
  const reader = new HandleReader(handle);
  let zip: yauzl.ZipFile;
  try { zip = await openZip(reader, Number(before.size)); }
  catch (error) { await reader.settle(); throw error; }
  const receipts: ZipEntryReceipt[] = [];
  let declaredTotal = 0, actualTotal = 0;
  const expectedByName = new Map(expected.map(item => [item.name, item]));
  let activeStream: Readable | undefined;
  const onZipError = (error: Error): void => { activeStream?.destroy(error); };
  zip.on('error', onZipError);
  try {
    if (zip.entryCount !== expected.length || zip.entryCount > budget.maxEntries) fail('ENTRY_INVALID');
    const seen = new Set<string>();
    for (;;) {
      checkAbort(signal);
      const entry = await nextEntry(zip, signal);
      if (!entry) break;
      const kind = checkEntryKind(entry), name = entry.fileName;
      const canonical = checkName({ name, kind, size: entry.uncompressedSize });
      if (seen.has(canonical)) fail('ENTRY_INVALID');
      seen.add(canonical);
      if (!safeInteger(entry.uncompressedSize) || entry.uncompressedSize > budget.maxEntryBytes || !safeInteger(entry.compressedSize) || entry.compressedSize > budget.maxArchiveBytes || kind === 'directory' && entry.uncompressedSize !== 0) fail('BUDGET_EXCEEDED');
      declaredTotal += entry.uncompressedSize;
      if (!safeInteger(declaredTotal) || declaredTotal > budget.maxTotalBytes) fail('BUDGET_EXCEEDED');
      const wanted = expectedByName.get(name);
      if (!wanted) fail('ENTRY_INVALID');
      if (wanted.size !== entry.uncompressedSize) fail('ENTRY_INVALID');
      const stream = await openEntry(zip, entry, signal);
      activeStream = stream;
      const streamClosed = closed(stream);
      const abortRead = (): void => { stream.destroy(new VerifiedZipError('CANCELLED')); };
      signal.addEventListener('abort', abortRead, { once: true });
      const hash = createHash('sha256');
      let size = 0, crc = 0;
      try {
        for await (const raw of stream) {
          checkAbort(signal);
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          size += chunk.length; actualTotal += chunk.length;
          if (!safeInteger(size) || size > entry.uncompressedSize || !safeInteger(actualTotal) || actualTotal > budget.maxTotalBytes) fail('BUDGET_EXCEEDED');
          hash.update(chunk); crc = crc32(crc, chunk);
        }
      } finally { signal.removeEventListener('abort', abortRead); activeStream = undefined; stream.destroy(); await streamClosed; }
      const sha256 = hash.digest('hex');
      if (size !== entry.uncompressedSize || crc !== entry.crc32 || kind === 'file' && sha256 !== wanted.sha256 || kind === 'directory' && (size !== 0 || entry.crc32 !== 0)) fail('CONTENT_CHANGED');
      receipts.push({ name, kind, size, ...(kind === 'file' ? { sha256 } : {}), crc32: crc });
    }
    checkEntries(receipts, budget);
    const sha256 = await hashHandle(handle, Number(before.size), signal);
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('CONTENT_CHANGED');
    checkAbort(signal);
    return { size: Number(before.size), sha256, entries: receipts };
  } catch (error) {
    if (signal.aborted) fail('CANCELLED');
    if (error instanceof VerifiedZipError) throw error;
    return fail('ARCHIVE_INVALID');
  } finally { zip.close(); await reader.settle(); zip.off('error', onZipError); }
}

/** 中立读端：只交付已规范化的条目名和流式字节；调用方自行决定是否写入私有目标。 */
export async function readVerifiedZipEntries(
  handle: FileHandle,
  budget: ZipBudget,
  signal: AbortSignal,
  consume: (entry: ZipEntryDescription, chunks: AsyncIterable<Buffer>) => Promise<void>,
): Promise<ZipReceipt> {
  checkAbort(signal);
  checkBudget(budget);
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > BigInt(budget.maxArchiveBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('BUDGET_EXCEEDED');
  const reader = new HandleReader(handle);
  let zip: yauzl.ZipFile;
  try { zip = await openZip(reader, Number(before.size)); }
  catch (error) {
    await reader.settle();
    if (signal.aborted) fail('CANCELLED');
    if (error instanceof VerifiedZipError) throw error;
    return fail('ARCHIVE_INVALID');
  }
  const receipts: ZipEntryReceipt[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0, actualTotal = 0;
  let activeStream: Readable | undefined, consumerFailed = false;
  const onZipError = (error: Error): void => { activeStream?.destroy(error); };
  zip.on('error', onZipError);
  try {
    if (zip.entryCount < 1 || zip.entryCount > budget.maxEntries) fail('BUDGET_EXCEEDED');
    for (;;) {
      checkAbort(signal);
      const entry = await nextEntry(zip, signal);
      if (!entry) break;
      const kind = checkEntryKind(entry), name = entry.fileName;
      const canonical = checkName({ name, kind, size: entry.uncompressedSize });
      if (seen.has(canonical)) fail('ENTRY_INVALID');
      seen.add(canonical);
      if (!safeInteger(entry.uncompressedSize) || entry.uncompressedSize > budget.maxEntryBytes || !safeInteger(entry.compressedSize) || entry.compressedSize > budget.maxArchiveBytes || kind === 'directory' && entry.uncompressedSize !== 0) fail('BUDGET_EXCEEDED');
      declaredTotal += entry.uncompressedSize;
      if (!safeInteger(declaredTotal) || declaredTotal > budget.maxTotalBytes) fail('BUDGET_EXCEEDED');
      const stream = await openEntry(zip, entry, signal);
      activeStream = stream;
      const streamClosed = closed(stream);
      const abortRead = (): void => { stream.destroy(new VerifiedZipError('CANCELLED')); };
      signal.addEventListener('abort', abortRead, { once: true });
      const hash = createHash('sha256');
      const declaredSize = entry.uncompressedSize;
      let size = 0, crc = 0, exhausted = false;
      async function* chunks(): AsyncGenerator<Buffer> {
        for await (const raw of stream) {
          checkAbort(signal);
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          size += chunk.length; actualTotal += chunk.length;
          if (!safeInteger(size) || size > declaredSize || !safeInteger(actualTotal) || actualTotal > budget.maxTotalBytes) fail('BUDGET_EXCEEDED');
          hash.update(chunk); crc = crc32(crc, chunk);
          yield chunk;
        }
        exhausted = true;
      }
      const iterator = chunks();
      try {
        try { await consume({ name, kind, size: entry.uncompressedSize }, iterator); }
        catch (error) { consumerFailed = true; throw error; }
        // 空目录允许回调只创建目录；文件回调必须消费到 EOF，不能凭声明尺寸伪造成功。
        if (kind === 'directory' && !exhausted) for await (const _ of iterator) { /* 空条目仍走完整 CRC 路径。 */ }
        if (!exhausted) fail('ARCHIVE_INVALID');
      } finally { signal.removeEventListener('abort', abortRead); activeStream = undefined; stream.destroy(); await streamClosed; }
      const sha256 = hash.digest('hex');
      if (size !== entry.uncompressedSize || crc !== entry.crc32 || kind === 'directory' && (size !== 0 || crc !== 0)) fail('CONTENT_CHANGED');
      receipts.push({ name, kind, size, ...(kind === 'file' ? { sha256 } : {}), crc32: crc });
    }
    if (receipts.length !== zip.entryCount) fail('ENTRY_INVALID');
    checkEntries(receipts, budget);
    const sha256 = await hashHandle(handle, Number(before.size), signal);
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('CONTENT_CHANGED');
    checkAbort(signal);
    return { size: Number(before.size), sha256, entries: receipts };
  } catch (error) {
    if (signal.aborted) fail('CANCELLED');
    if (consumerFailed || error instanceof VerifiedZipError) throw error;
    return fail('ARCHIVE_INVALID');
  } finally { zip.close(); await reader.settle(); zip.off('error', onZipError); }
}
