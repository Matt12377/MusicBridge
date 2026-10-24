import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { logLibraryOperation } from '../shared/library-operation-log.js';
import { DEFAULT_METADATA_READ_BUDGET, EMBEDDED_LYRICS_READ_BUDGET, RUST_MEDIA_METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION,
  type MetadataReadBudget, type MetadataReadEvidence, type MetadataReadFailure, type MetadataRawFields,
  type MetadataTechnical, type MetadataCoverEvidence, type MetadataEmbeddedLyricsCandidate } from './metadata-reader-types.js';
import type { RustImageVariant, RustMediaDiagnostic,
  RustMediaFailure, RustMediaPerformance, RustMediaReadonlyInput, RustMediaWorkerPool, RustMediaWorkerPoolOptions,
  RustMetadataReadInput, RustMetadataReadResult, RustProcessImageResult } from './rust-media-worker-types.js';

export type * from './rust-media-worker-types.js';

const PROTOCOL = 1;
const FRAME_BYTES = 12 * 1024 * 1024;
const RPC_BYTES = 64 * 1024;
const IMAGE_BYTES = 4 * 1024 * 1024;
const GRID_IMAGE_BYTES = 256 * 1024;
const STARTUP_TIMEOUT_MS = 3000;
const SLOW_THRESHOLD_MS = 750;
const EMBEDDED_BUDGET: Readonly<MetadataReadBudget> = Object.freeze({ ...DEFAULT_METADATA_READ_BUDGET,
  totalReadBytes: 12 * 1024 * 1024, singleReadBytes: RPC_BYTES });
const FAILURES = new Set<RustMediaFailure>(['BUDGET_EXCEEDED', 'PARSE_FAILED', 'UNSUPPORTED', 'TIMEOUT',
  'WORKER_START_TIMEOUT', 'CANCELLED', 'CLOSED', 'QUEUE_FULL', 'WORKER_FAILED', 'IO_ERROR']);
const safeInteger = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const failureCode = (v: unknown): RustMediaFailure => typeof v === 'string' && FAILURES.has(v as RustMediaFailure) ? v as RustMediaFailure : 'WORKER_FAILED';

export class RustMediaWorkerError extends Error {
  constructor(readonly code: RustMediaFailure) { super(`媒体处理未完成：${code}`); this.name = 'RustMediaWorkerError'; }
}

/** 只解析可信 Node 部署配置；可执行文件不能来自扫描文件名或 Renderer 请求。 */
export async function resolveRustMediaWorkerBinary(options: Pick<RustMediaWorkerPoolOptions, 'binaryPath' | 'binarySha256' | 'resourcesPath'> = {}): Promise<string> {
  const executable = process.platform === 'win32' ? 'musicbridge-media-worker.exe' : 'musicbridge-media-worker';
  const target = `${process.platform}-${process.arch}`;
  const resources = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const explicit = options.binaryPath ?? process.env['MB_MEDIA_WORKER_BINARY'];
  const expected = options.binarySha256 ?? process.env['MB_MEDIA_WORKER_BINARY_SHA256'];
  if (expected !== undefined && !/^[a-f0-9]{64}$/u.test(expected)) throw new RustMediaWorkerError('WORKER_FAILED');
  const candidates: string[] = [];
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new RustMediaWorkerError('WORKER_FAILED');
    candidates.push(explicit);
  } else {
    if (resources) candidates.push(path.join(resources, 'media-worker', target, 'bin', executable));
    // 同时覆盖 bridge-core/src、bridge-core/dist 和桌面打包前的工具入口。
    let directory = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      candidates.push(path.join(directory, 'native', 'media-worker', 'bin', target, executable));
      candidates.push(path.join(directory, 'apps', 'desktop', 'native', 'media-worker', target, 'bin', executable));
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
  }
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate), facts = await lstat(candidate);
      if (resolved !== path.resolve(candidate) || !facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1 || facts.mode & 0o022
        || facts.size < 1 || facts.size > 96 * 1024 * 1024) continue;
      let digest = expected;
      if (!digest) {
        const manifestPath = path.join(path.dirname(resolved), path.basename(path.dirname(resolved)) === 'bin' ? '../manifest.json' : 'manifest.json');
        const manifest = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await manifest.stat();
          if (!info.isFile() || info.size < 1 || info.size > 64 * 1024 || info.mode & 0o022) continue;
          const value: unknown = JSON.parse(await manifest.readFile('utf8'));
          if (!record(value) || value['protocolVersion'] !== PROTOCOL || value['parserVersion'] !== RUST_MEDIA_METADATA_PARSER_VERSION
            || !record(value['binary']) || typeof value['binary']['sha256'] !== 'string'
            || !/^[a-f0-9]{64}$/u.test(value['binary']['sha256']) || value['binary']['size'] !== facts.size) continue;
          digest = value['binary']['sha256'];
        } finally { await manifest.close(); }
      }
      await access(resolved, constants.X_OK);
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat(); if (!sameFile(facts, before)) continue;
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(RPC_BYTES);
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (bytesRead < 1) throw new RustMediaWorkerError('WORKER_FAILED');
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        if (hash.digest('hex') !== digest || !sameFile(before, await handle.stat()) || !sameFile(before, await lstat(resolved))) continue;
        return resolved;
      } finally { await handle.close(); }
    } catch { /* 候选缺失时继续；全部失败后保留固定私有错误。 */ }
  }
  throw new RustMediaWorkerError('WORKER_FAILED');
}
function sameFile(a: Stats, b: Stats): boolean {
  return b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && !(b.mode & 0o022) && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
}

function boundedBudget(value: Partial<MetadataReadBudget>, limits: Readonly<MetadataReadBudget>): MetadataReadBudget {
  const result = { ...limits };
  for (const key of Object.keys(limits) as (keyof MetadataReadBudget)[]) {
    const n = value[key] ?? limits[key];
    if (!safeInteger(n) || n < 1 || n > limits[key]) throw new RustMediaWorkerError('BUDGET_EXCEEDED');
    result[key] = n;
  }
  return result;
}
function checkedSource(input: RustMediaReadonlyInput): void {
  if (!safeInteger(input.size) || input.size < 1 || typeof input.read !== 'function') throw new RustMediaWorkerError('PARSE_FAILED');
}
function checkedPerformance(value: unknown, queueWaitMs: number): RustMediaPerformance {
  if (!record(value) || !exactKeys(value, ['readMs', 'parseMs']) || ![value['readMs'], value['parseMs']].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 60_000)) throw new RustMediaWorkerError('WORKER_FAILED');
  return { readMs: value['readMs'] as number, parseMs: value['parseMs'] as number, queueWaitMs };
}
function checkedEvidence(value: unknown, budget: MetadataReadBudget): MetadataReadEvidence {
  if (!record(value) || !exactKeys(value, ['bytesRead', 'readCalls', 'maxReadBytes', 'allocationBytes', 'elapsedMs', 'wholeAudioHash', 'wholeAudioDecode'])
    || ![value['bytesRead'], value['readCalls'], value['maxReadBytes'], value['allocationBytes']].every(safeInteger)
    || typeof value['elapsedMs'] !== 'number' || !Number.isFinite(value['elapsedMs']) || value['elapsedMs'] < 0
    || (value['bytesRead'] as number) > budget.totalReadBytes || (value['readCalls'] as number) > 16_384 || (value['maxReadBytes'] as number) > Math.min(RPC_BYTES, budget.singleReadBytes)
    || (value['allocationBytes'] as number) > budget.totalAllocationBytes
    || value['wholeAudioHash'] !== false || value['wholeAudioDecode'] !== false) throw new RustMediaWorkerError('WORKER_FAILED');
  return { bytesRead: value['bytesRead'] as number, readCalls: value['readCalls'] as number,
    maxReadBytes: value['maxReadBytes'] as number, allocationBytes: value['allocationBytes'] as number,
    elapsedMs: value['elapsedMs'], wholeAudioHash: false, wholeAudioDecode: false };
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const found = Object.keys(value); return found.length === keys.length && found.every(key => keys.includes(key));
}
const CONTAINERS = ['FLAC', 'MPEG', 'MP4', 'WAVE', 'AIFF', 'DSF', 'DFF', 'OGG', 'WAVPACK', 'APE', 'TTA', 'MPC', 'TAK'] as const;
function checkedMetadata(value: unknown, input: RustMetadataReadInput, budget: MetadataReadBudget): RustMetadataReadResult {
  if (!record(value) || !exactKeys(value, ['status', 'parserVersion', 'fields', 'technical', 'coverEvidence', 'readEvidence'])
    || value['status'] !== 'ok' || !record(value['fields']) || !record(value['technical']) || !Array.isArray(value['coverEvidence'])) throw new RustMediaWorkerError('WORKER_FAILED');
  const raw = value['fields'], facts = value['technical'];
  let totalText = 0; const fields: MetadataRawFields = {};
  for (const [key, text] of Object.entries(raw)) {
    if (key === 'artists' || key === 'albumArtists') {
      if (!Array.isArray(text) || text.length > 64 || text.some(value => typeof value !== 'string'
        || Buffer.byteLength(value) > budget.textFieldBytes || (totalText += Buffer.byteLength(value)) > budget.totalTextBytes)
        || new Set(text).size !== text.length) throw new RustMediaWorkerError('WORKER_FAILED');
      fields[key] = [...text] as string[];
    } else {
      if (!['title', 'artist', 'album', 'year', 'disc', 'track', 'albumArtist'].includes(key) || typeof text !== 'string'
        || Buffer.byteLength(text) > budget.textFieldBytes || (totalText += Buffer.byteLength(text)) > budget.totalTextBytes) throw new RustMediaWorkerError('WORKER_FAILED');
      fields[key as 'title' | 'artist' | 'album' | 'year' | 'disc' | 'track' | 'albumArtist'] = text;
    }
  }
  if (!exactKeys(facts, ['container', 'codec', 'lossless', 'sampleRateHz', 'channels', 'bitsPerSample', 'durationSeconds', 'evidence'])
    || !CONTAINERS.includes(facts['container'] as typeof CONTAINERS[number])
    || typeof facts['codec'] !== 'string' || Buffer.byteLength(facts['codec']) < 1 || Buffer.byteLength(facts['codec']) > 256
    || facts['lossless'] !== null && typeof facts['lossless'] !== 'boolean'
    || !safeInteger(facts['sampleRateHz']) || facts['sampleRateHz'] < 1 || facts['sampleRateHz'] > 1_000_000_000
    || !safeInteger(facts['channels']) || facts['channels'] < 1 || facts['channels'] > 64
    || facts['bitsPerSample'] !== null && (!safeInteger(facts['bitsPerSample']) || facts['bitsPerSample'] < 1 || facts['bitsPerSample'] > 64)
    || facts['durationSeconds'] !== null && (typeof facts['durationSeconds'] !== 'number' || !Number.isFinite(facts['durationSeconds']) || facts['durationSeconds'] < 0 || facts['durationSeconds'] > Number.MAX_SAFE_INTEGER)
    || facts['evidence'] !== 'bounded-parser-reported') throw new RustMediaWorkerError('WORKER_FAILED');
  const container = facts['container'] as MetadataTechnical['container'];
  if (['DSF', 'DFF'].includes(container) && (!input.dsdMetadataEnabled || facts['codec'] !== 'DSD' || facts['bitsPerSample'] !== 1 || facts['lossless'] !== true)
    || ['OGG', 'WAVPACK', 'APE', 'TTA', 'MPC', 'TAK'].includes(container) && !input.cueInputMetadataEnabled) throw new RustMediaWorkerError('WORKER_FAILED');
  const headerOnly = container === 'TTA' || container === 'TAK';
  if (value['parserVersion'] !== (headerOnly ? CUE_HEADER_METADATA_PARSER_VERSION : RUST_MEDIA_METADATA_PARSER_VERSION)
    || headerOnly && (Object.keys(raw).length !== 0 || value['coverEvidence'].length !== 0)) throw new RustMediaWorkerError('WORKER_FAILED');
  let coverTotal = 0;
  if (value['coverEvidence'].length > 8 || input.includeEmbeddedArtwork === false && value['coverEvidence'].length !== 0) throw new RustMediaWorkerError('WORKER_FAILED');
  const covers: MetadataCoverEvidence[] = value['coverEvidence'].map((item: unknown) => {
    if (!record(item) || !exactKeys(item, ['mime', 'bytes', 'sha256', 'evidence']) || !['image/jpeg', 'image/png'].includes(String(item['mime']))
      || !safeInteger(item['bytes']) || item['bytes'] < 1 || item['bytes'] > budget.coverBytes
      || (coverTotal += item['bytes']) > budget.coverBytes || typeof item['sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(item['sha256'])
      || item['evidence'] !== 'encoded-bytes-magic-and-digest') throw new RustMediaWorkerError('WORKER_FAILED');
    return { mime: item['mime'] as MetadataCoverEvidence['mime'], bytes: item['bytes'], sha256: item['sha256'], evidence: 'encoded-bytes-magic-and-digest' };
  });
  return { status: 'ok', parserVersion: headerOnly ? CUE_HEADER_METADATA_PARSER_VERSION : RUST_MEDIA_METADATA_PARSER_VERSION, fields,
    technical: { container, codec: facts['codec'], lossless: facts['lossless'] as boolean | null, sampleRateHz: facts['sampleRateHz'], channels: facts['channels'],
      bitsPerSample: facts['bitsPerSample'] as number | null, durationSeconds: facts['durationSeconds'] as number | null, evidence: 'bounded-parser-reported' },
    coverEvidence: covers, readEvidence: checkedEvidence(value['readEvidence'], budget) };
}
function decodeBytes(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length < 4 || value.length > Math.ceil(maximum / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new RustMediaWorkerError('WORKER_FAILED');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > maximum || bytes.toString('base64') !== value) throw new RustMediaWorkerError('WORKER_FAILED');
  return bytes;
}
function jpegVariant(value: unknown, maximum: number, maxEdge: number): RustImageVariant {
  if (!record(value) || !safeInteger(value['width']) || !safeInteger(value['height']) || value['width'] < 1 || value['height'] < 1
        || value['width'] > maxEdge || value['height'] > maxEdge || value['mime'] !== 'image/jpeg') throw new RustMediaWorkerError('WORKER_FAILED');
  const bytes = decodeBytes(value['base64'], maximum);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new RustMediaWorkerError('WORKER_FAILED');
  return { bytes, mime: 'image/jpeg', width: value['width'], height: value['height'] };
}

interface WireResult { value: unknown; performance: RustMediaPerformance; deadline: number }
interface ActiveTask {
  jobId: string; startedAt: number; queueWaitMs: number; budget: MetadataReadBudget;
  source: RustMediaReadonlyInput | undefined;
  reads: number; bytesRead: number; nextRequest: number;
  inflight: Promise<void> | undefined;
  terminal: boolean; finishing: boolean;
  startupDeadline: number; readDeadline: number | undefined; absoluteDeadline: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  removeAbort(): void;
  resolve(value: WireResult): void; reject(error: RustMediaWorkerError): void;
}

/** 一个进程只执行一个任务；终态即撤销回调，失败销毁后才允许调用者关句柄。 */
class MediaProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: RustMediaWorkerError) => void;
  private readyObserved = false;
  private didClose = false;
  private killed = false;
  private active: ActiveTask | undefined;
  private chunks: Buffer[] = [];
  private frameBytes = 0;
  private stderrRemainder = '';
  readonly usable = (): boolean => !this.didClose && !this.killed;

  constructor(binary: string, private readonly diagnostic: (event: RustMediaDiagnostic) => void) {
    // 不继承凭据、Provider 配置、动态链接注入、Node 参数或源路径。
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      cwd: path.dirname(binary), env: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' } });
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => undefined);
    this.closed = new Promise<void>(resolve => {
      this.child.once('close', code => {
        this.didClose = true; this.readyReject(new RustMediaWorkerError('WORKER_FAILED'));
        resolve();
        const task = this.active; if (task && !task.terminal) void this.fail(task, code === 86 ? 'BUDGET_EXCEEDED' : 'WORKER_FAILED');
      });
    });
    this.child.once('error', () => { this.readyReject(new RustMediaWorkerError('WORKER_FAILED')); this.kill(); });
    this.child.stdin.on('error', () => { const task = this.active; if (task) void this.fail(task, 'WORKER_FAILED'); else this.kill(); });
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.consumeStderr(chunk));
  }

  private kill(): void { this.killed = true; if (!this.didClose) this.child.kill('SIGKILL'); }
  async close(): Promise<void> { this.kill(); await this.closed; await this.active?.inflight; }
  private emit(task: ActiveTask, stage: string, message: string, extra: Partial<RustMediaDiagnostic> = {}): void {
    const elapsedMs = Math.max(0, performance.now() - task.startedAt);
    this.diagnostic({ jobId: task.jobId, stage, elapsedMs, queueWaitMs: task.queueWaitMs,
      slowThresholdMs: SLOW_THRESHOLD_MS, slow: elapsedMs >= SLOW_THRESHOLD_MS, message, ...extra });
  }
  private consumeStderr(chunk: Buffer): void {
    // 子进程 stderr 是诊断数据，重新核对固定字段后再输出，不能直转任意内容。
    this.stderrRemainder += chunk.toString('utf8');
    if (this.stderrRemainder.length > 16 * 1024) { this.stderrRemainder = ''; return; }
    let index: number;
    while ((index = this.stderrRemainder.indexOf('\n')) >= 0) {
      const line = this.stderrRemainder.slice(0, index); this.stderrRemainder = this.stderrRemainder.slice(index + 1);
      const task = this.active; if (!task || task.terminal) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!record(value) || value['jobId'] !== task.jobId || typeof value['stage'] !== 'string'
          || !/^[a-z-]{1,48}$/u.test(value['stage'])) continue;
        const stage = value['stage'];
        this.emit(task, stage, stage === 'parse' ? '正在解析媒体标签' : stage === 'decode' ? '正在解码封面' : stage === 'encode' ? '正在生成封面缓存' : '媒体任务检查点');
      } catch { /* 不把第三方错误或媒体标签写入终端。 */ }
    }
  }
  private consume(chunk: Buffer): void {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index); this.frameBytes += part.length;
      if (this.frameBytes > FRAME_BYTES) { this.protocolFailure(); return; }
      this.chunks.push(part);
      const line = Buffer.concat(this.chunks, this.frameBytes).toString('utf8'); this.chunks = []; this.frameBytes = 0; start = index + 1;
      try { this.message(JSON.parse(line) as unknown); } catch { this.protocolFailure(); return; }
    }
    if (start < chunk.length) { const part = chunk.subarray(start); this.frameBytes += part.length; this.chunks.push(part); }
    if (this.frameBytes > FRAME_BYTES) this.protocolFailure();
  }
  private protocolFailure(): void {
    const task = this.active; if (task) void this.fail(task, 'WORKER_FAILED'); else this.kill();
  }
  private message(value: unknown): void {
    if (!record(value)) { this.protocolFailure(); return; }
    if (value['kind'] === 'ready') {
      if (this.readyObserved || value['protocol'] !== PROTOCOL || value['parserVersion'] !== RUST_MEDIA_METADATA_PARSER_VERSION) { this.protocolFailure(); return; }
      this.readyObserved = true; this.readyResolve(); return;
    }
    const task = this.active;
    if (!this.readyObserved || !task || task.terminal || value['jobId'] !== task.jobId) { this.protocolFailure(); return; }
    if (!this.withinDeadline(task)) return;
    if (value['kind'] === 'read') { this.read(task, value); return; }
    if (value['kind'] !== 'result' || task.inflight !== undefined || typeof value['ok'] !== 'boolean') { this.protocolFailure(); return; }
    if (!value['ok']) {
      const code = failureCode(value['code']);
      if (code === 'TIMEOUT' || code === 'CANCELLED' || code === 'WORKER_FAILED') { void this.fail(task, code); return; }
      this.finish(task); this.emit(task, 'complete', '媒体任务已收口', { code }); task.reject(new RustMediaWorkerError(code)); return;
    }
    const timing = checkedPerformance(value['performance'], task.queueWaitMs);
    const deadline = task.readDeadline!;
    this.finish(task); this.emit(task, 'complete', '媒体任务已完成', timing); task.resolve({ value: value['value'], performance: timing, deadline });
  }
  private write(value: unknown): void {
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) > FRAME_BYTES || !this.usable()) throw new RustMediaWorkerError('WORKER_FAILED');
    this.child.stdin.write(frame);
  }
  private read(task: ActiveTask, value: Record<string, unknown>): void {
    const at = value['offset'], count = value['length'], requestId = value['requestId'];
    if (task.inflight !== undefined || !task.source || !safeInteger(requestId) || requestId !== task.nextRequest++
      || !safeInteger(at) || !safeInteger(count) || count < 1 || count > Math.min(RPC_BYTES, task.budget.singleReadBytes)
      || at > task.source.size - count || task.bytesRead + count > task.budget.totalReadBytes || ++task.reads > 16_384) {
      void this.fail(task, 'BUDGET_EXCEEDED'); return;
    }
    // 先预留请求预算，截断或失败也不退回；防止反复短读放大 I/O。
    task.bytesRead += count;
    const read = task.source.read;
    task.inflight = (async () => {
      try {
        if (task.terminal) return;
        const bytes = await read(at, count);
        if (task.terminal) return;
        if (!this.withinDeadline(task)) return;
        if (!(bytes instanceof Uint8Array) || bytes.length > count) throw new RustMediaWorkerError('IO_ERROR');
        this.write({ kind: 'read-result', jobId: task.jobId, requestId, base64: Buffer.from(bytes).toString('base64') });
      } catch { if (!task.terminal) void this.fail(task, 'IO_ERROR'); }
      finally { task.inflight = undefined; }
    })();
  }
  private withinDeadline(task: ActiveTask): boolean {
    const deadline = task.readDeadline ?? task.startupDeadline;
    if (performance.now() < deadline) return true;
    void this.fail(task, task.absoluteDeadline !== undefined && performance.now() >= task.absoluteDeadline ? 'TIMEOUT' : task.readDeadline === undefined ? 'WORKER_START_TIMEOUT' : 'TIMEOUT'); return false;
  }
  private armDeadline(task: ActiveTask): void {
    clearTimeout(task.timer);
    const check = (): void => {
      if (task.terminal || !this.withinDeadline(task)) return;
      task.timer = setTimeout(check, Math.max(1, Math.ceil((task.readDeadline ?? task.startupDeadline) - performance.now())));
    };
    check();
  }
  private finish(task: ActiveTask): void {
    task.terminal = true; clearTimeout(task.timer); task.removeAbort(); task.source = undefined;
    if (this.active === task) this.active = undefined;
  }
  private async fail(task: ActiveTask, code: RustMediaFailure): Promise<void> {
    if (task.terminal || task.finishing) return;
    task.finishing = true; task.terminal = true; clearTimeout(task.timer); task.removeAbort();
    this.kill();
    // kill 请求不是退出；回调必须完成后调用者才能结束来源 FD 与 claim。
    await this.closed; await task.inflight;
    this.finish(task); this.emit(task, code === 'TIMEOUT' ? 'timeout' : 'stopped', '媒体任务已停止并收口', { code });
    task.reject(new RustMediaWorkerError(code));
  }
  run(payload: Record<string, unknown>, source: RustMediaReadonlyInput | undefined, budget: MetadataReadBudget,
    signal: AbortSignal, jobId: string, queueWaitMs: number, absoluteDeadline?: number): Promise<WireResult> {
    if (this.active || !this.usable()) return Promise.reject(new RustMediaWorkerError('WORKER_FAILED'));
    return new Promise<WireResult>((resolve, reject) => {
      const abort = (): void => { void this.fail(task, 'CANCELLED'); };
      const task: ActiveTask = { jobId, startedAt: performance.now(), queueWaitMs, budget, source,
        reads: 0, bytesRead: 0, nextRequest: 1, inflight: undefined, terminal: false, finishing: false, timer: undefined,
        startupDeadline: Math.min(performance.now() + STARTUP_TIMEOUT_MS, absoluteDeadline ?? Infinity), readDeadline: undefined, absoluteDeadline,
        removeAbort: () => signal.removeEventListener('abort', abort), resolve, reject };
      this.active = task; signal.addEventListener('abort', abort, { once: true });
      this.armDeadline(task);
      this.emit(task, 'dispatch', '媒体任务已分派');
      if (signal.aborted) { abort(); return; }
      void this.ready.then(() => {
        if (task.terminal || !this.withinDeadline(task)) return;
        task.readDeadline = Math.min(performance.now() + budget.timeoutMs, absoluteDeadline ?? Infinity);
        this.armDeadline(task);
        this.write({ kind: 'job', protocol: PROTOCOL, jobId, queueWaitMs, slowThresholdMs: SLOW_THRESHOLD_MS, ...payload });
      }).catch(() => { if (!task.terminal) void this.fail(task, 'WORKER_FAILED'); });
    });
  }
}

interface QueuedTask {
  id: string; queuedAt: number; controller: AbortController; started: boolean;
  run(process: MediaProcess): Promise<void>; cancelQueued(code: RustMediaFailure): void; done: Promise<void>;
  dispatching(): void;
}

export function createRustMediaWorkerPool(options: RustMediaWorkerPoolOptions = {}): RustMediaWorkerPool {
  const concurrency = options.concurrency ?? 2, maxPending = options.maxPending ?? 32;
  if (![1, 2, 8].includes(concurrency) || !safeInteger(maxPending) || maxPending > 128) throw new RustMediaWorkerError('BUDGET_EXCEEDED');
  const queue: QueuedTask[] = [], jobs = new Set<QueuedTask>(), workers = new Set<MediaProcess>(), idle: MediaProcess[] = [];
  let closed = false, active = 0, closing: Promise<void> | undefined;
  const diagnostic = (event: RustMediaDiagnostic): void => {
    logLibraryOperation('worker', `media.${event.stage}`, event.stage === 'complete' ? event.code ? 'error' : 'complete'
      : event.code === 'CANCELLED' ? 'cancelled' : event.code ? 'error' : event.stage === 'dispatch' ? 'start' : 'progress', {
      id: event.jobId, elapsedMs: event.elapsedMs, queueWaitMs: event.queueWaitMs, slowAfterMs: event.slowThresholdMs,
      ...(event.code ? { code: event.code } : {}), ...(event.readMs === undefined ? {} : { readMs: event.readMs }), ...(event.parseMs === undefined ? {} : { parseMs: event.parseMs }),
    });
    try { options.onDiagnostic?.(event); } catch { /* 诊断观察者不取得任务生命周期控制权。 */ }
  };
  const acquire = async (): Promise<MediaProcess> => {
    while (idle.length) { const worker = idle.pop()!; if (worker.usable()) return worker; workers.delete(worker); }
    const binary = await resolveRustMediaWorkerBinary(options);
    if (closed) throw new RustMediaWorkerError('CLOSED');
    const worker = new MediaProcess(binary, diagnostic); workers.add(worker); return worker;
  };
  const pump = (): void => {
    while (!closed && active < concurrency && queue.length) {
      const job = queue.shift()!; if (!jobs.has(job)) continue;
      job.started = true; active++;
      void (async () => {
        let worker: MediaProcess | undefined;
        try { worker = await acquire(); job.dispatching(); await job.run(worker); }
        catch { job.cancelQueued(closed ? 'CLOSED' : 'WORKER_FAILED'); }
        finally {
          if (worker) { if (!closed && worker.usable()) idle.push(worker); else { await worker.close(); workers.delete(worker); } }
          active--; pump();
        }
      })();
    }
  };
  const enqueue = <T>(payload: Record<string, unknown>, source: RustMediaReadonlyInput | undefined, budget: MetadataReadBudget,
    decode: (result: WireResult) => T, signal?: AbortSignal, deadlineAtMs?: number): Promise<T> => {
    if (closed) return Promise.reject(new RustMediaWorkerError('CLOSED'));
    if (signal?.aborted) return Promise.reject(new RustMediaWorkerError('CANCELLED'));
    if (deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) return Promise.reject(new RustMediaWorkerError('TIMEOUT'));
    if (active >= concurrency && queue.length >= maxPending) return Promise.reject(new RustMediaWorkerError('QUEUE_FULL'));
    const controller = new AbortController(); let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    let complete = false;
    return new Promise<T>((resolve, reject) => {
      let queueTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result?: T, error?: RustMediaWorkerError): void => {
        if (complete) return; complete = true; clearTimeout(queueTimer); signal?.removeEventListener('abort', forward); jobs.delete(job); settle();
        if (error) reject(error); else resolve(result!);
      };
      const forward = (): void => { controller.abort(); if (!job.started) job.cancelQueued('CANCELLED'); };
      const job: QueuedTask = { id: randomUUID(), queuedAt: performance.now(), controller, started: false, done,
        async run(worker) {
          if (controller.signal.aborted) { finish(undefined, new RustMediaWorkerError('CANCELLED')); return; }
          let result: WireResult;
          try { result = await worker.run(payload, source, budget, controller.signal, job.id, Math.max(0, performance.now() - job.queuedAt), deadlineAtMs); }
          catch (error) { finish(undefined, error instanceof RustMediaWorkerError ? error : new RustMediaWorkerError('WORKER_FAILED')); return; }
          try {
            const output = decode(result);
            if (performance.now() >= result.deadline) { await worker.close(); finish(undefined, new RustMediaWorkerError('TIMEOUT')); return; }
            finish(output);
          }
          catch { await worker.close(); finish(undefined, new RustMediaWorkerError('WORKER_FAILED')); }
        },
        dispatching() {
          clearTimeout(queueTimer);
          if (performance.now() >= Math.min(job.queuedAt + budget.timeoutMs, deadlineAtMs ?? Infinity)) { controller.abort(); job.cancelQueued('TIMEOUT'); }
        },
        cancelQueued(code) {
          const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
          if (!complete) {
            const elapsedMs = Math.max(0, performance.now() - job.queuedAt);
            diagnostic({ jobId: job.id, stage: 'queue-stopped', elapsedMs, queueWaitMs: elapsedMs,
              slowThresholdMs: SLOW_THRESHOLD_MS, slow: elapsedMs >= SLOW_THRESHOLD_MS, message: '排队媒体任务已收口', code });
          }
          finish(undefined, new RustMediaWorkerError(code));
        },
      };
      queueTimer = setTimeout(() => { controller.abort(); job.cancelQueued('TIMEOUT'); }, Math.max(1, Math.ceil(Math.min(budget.timeoutMs, (deadlineAtMs ?? Infinity) - performance.now()))));
      signal?.addEventListener('abort', forward, { once: true }); jobs.add(job); queue.push(job); pump();
    });
  };
  const port: RustMediaWorkerPool = {
    async readMetadata(input, signal) {
      try {
        checkedSource(input); const budget = boundedBudget(input.budget, DEFAULT_METADATA_READ_BUDGET);
        return await enqueue({ operation: 'metadata', size: input.size, budget,
          dsdMetadataEnabled: input.dsdMetadataEnabled === true, cueInputMetadataEnabled: input.cueInputMetadataEnabled === true,
          includeEmbeddedArtwork: input.includeEmbeddedArtwork !== false }, input, budget,
        result => {
          return { ...checkedMetadata(result.value, input, budget), performance: result.performance };
        }, signal);
      } catch (error) {
        const code: MetadataReadFailure = error instanceof RustMediaWorkerError ? error.code : 'WORKER_FAILED';
        return { status: 'failure', code, readEvidence: null };
      }
    },
    async readEmbeddedArtwork(input, signal) {
      checkedSource(input); const budget = boundedBudget(input.budget ?? {}, EMBEDDED_BUDGET);
      return enqueue({ operation: 'embedded-artwork', size: input.size, budget }, input, budget, result => {
        const value = result.value;
        if (!record(value) || !Array.isArray(value['items']) || value['items'].length > 3) throw new RustMediaWorkerError('WORKER_FAILED');
        let total = 0;
        const items = value['items'].map((item: unknown, index: number) => {
          if (!record(item) || item['pictureIndex'] !== index || !['image/jpeg', 'image/png'].includes(String(item['mime']))) throw new RustMediaWorkerError('WORKER_FAILED');
          const bytes = decodeBytes(item['base64'], IMAGE_BYTES); total += bytes.length;
          if (total > 8 * 1024 * 1024) throw new RustMediaWorkerError('BUDGET_EXCEEDED');
          return { bytes, pictureIndex: index, mime: item['mime'] as 'image/jpeg' | 'image/png' };
        });
        return { items, readEvidence: checkedEvidence(value['readEvidence'], budget), performance: result.performance };
      }, signal);
    },
    async readEmbeddedLyrics(input, signal) {
      checkedSource(input);
      if (typeof input.deadlineAtMs !== 'number' || !Number.isFinite(input.deadlineAtMs)) throw new RustMediaWorkerError('BUDGET_EXCEEDED');
      const deadline = Math.min(input.deadlineAtMs, performance.now() + EMBEDDED_LYRICS_READ_BUDGET.timeoutMs);
      if (performance.now() >= deadline) throw new RustMediaWorkerError('TIMEOUT');
      const budget = boundedBudget(input.budget ?? {}, EMBEDDED_LYRICS_READ_BUDGET);
      budget.timeoutMs = Math.max(1, Math.min(budget.timeoutMs, Math.floor(deadline - performance.now())));
      return enqueue({ operation: 'embedded-lyrics', size: input.size, budget, includeEmbeddedArtwork: false }, input, budget, result => {
        const value = result.value;
        if (!record(value) || !exactKeys(value, ['items', 'readEvidence']) || !Array.isArray(value['items']) || value['items'].length > 8) throw new RustMediaWorkerError('WORKER_FAILED');
        let total = 0;
        const text = (value: unknown): value is string => {
          if (typeof value !== 'string' || value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) return false;
          total += Buffer.byteLength(value, 'utf8'); return total <= budget.totalTextBytes;
        };
        const items = value['items'].map((item: unknown): MetadataEmbeddedLyricsCandidate => {
          if (!record(item)) throw new RustMediaWorkerError('WORKER_FAILED');
          if (item['kind'] === 'uslt' && exactKeys(item, ['kind', 'text']) && text(item['text']) && item['text'].length > 0) return { kind: 'uslt', text: item['text'] };
          if (item['kind'] !== 'sylt' || !exactKeys(item, ['kind', 'lines']) || !Array.isArray(item['lines']) || item['lines'].length < 1 || item['lines'].length > 500) throw new RustMediaWorkerError('WORKER_FAILED');
          let previous = -1;
          const lines = item['lines'].map((line: unknown) => {
            if (!record(line) || !exactKeys(line, ['startMs', 'text']) || !safeInteger(line['startMs']) || line['startMs'] > 86_400_000 || line['startMs'] < previous
              || !text(line['text']) || line['text'].length > 2048 || /[\u0000-\u001f\u007f]/u.test(line['text'])) throw new RustMediaWorkerError('WORKER_FAILED');
            previous = line['startMs']; return { startMs: line['startMs'], text: line['text'] };
          });
          return { kind: 'sylt', lines };
        });
        return { items, readEvidence: checkedEvidence(value['readEvidence'], budget), performance: result.performance };
      }, signal, deadline);
    },
    async processImage(input, signal) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.length < 1 || input.bytes.length > IMAGE_BYTES
        || !safeInteger(input.maxEdge) || input.maxEdge < 1 || input.maxEdge > 4096
        || !safeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > IMAGE_BYTES
        || input.gridSize !== false && input.gridSize !== undefined && (!safeInteger(input.gridSize) || input.gridSize < 1 || input.gridSize > 4096)) throw new RustMediaWorkerError('BUDGET_EXCEEDED');
      const gridSize = input.gridSize === false ? 0 : input.gridSize ?? 336;
      return enqueue({ operation: 'process-image', base64: Buffer.from(input.bytes).toString('base64'),
        maxEdge: input.maxEdge, maxOutputBytes: input.maxOutputBytes, gridSize }, undefined, DEFAULT_METADATA_READ_BUDGET, result => {
        const value = result.value;
        if (!record(value) || !record(value['original'])) throw new RustMediaWorkerError('WORKER_FAILED');
        const original = value['original'];
        if (!safeInteger(original['width']) || !safeInteger(original['height']) || original['width'] < 1 || original['height'] < 1
          || original['width'] > 4096 || original['height'] > 4096 || original['width'] * original['height'] > 16 * 1024 * 1024
          || !['image/jpeg', 'image/png', 'image/tiff', 'image/webp'].includes(String(original['mime']))) throw new RustMediaWorkerError('WORKER_FAILED');
        const variant = jpegVariant(value, input.maxOutputBytes, input.maxEdge);
        const output: RustProcessImageResult = { ...variant,
          original: { width: original['width'], height: original['height'], mime: original['mime'] as RustProcessImageResult['original']['mime'] }, performance: result.performance };
        if (original['mime'] === 'image/tiff' || original['mime'] === 'image/webp') {
          output.compatible = jpegVariant(value['compatible'], IMAGE_BYTES, 4096);
          const compatible = output.compatible;
          if (!(compatible.width === original['width'] && compatible.height === original['height'])
            && !(compatible.width === original['height'] && compatible.height === original['width'])) throw new RustMediaWorkerError('WORKER_FAILED');
        }
        if (gridSize) output.grid = jpegVariant(value['grid'], Math.min(GRID_IMAGE_BYTES, input.maxOutputBytes), gridSize);
        return output;
      }, signal);
    },
    close() {
      if (!closing) {
        closed = true; const pending = [...jobs];
        for (const job of pending) { job.controller.abort(); if (!job.started) job.cancelQueued('CLOSED'); }
        closing = Promise.all(pending.map(job => job.done)).then(async () => {
          await Promise.all([...workers].map(worker => worker.close())); workers.clear(); idle.length = 0;
        });
      }
      return closing;
    },
  };
  return port;
}

let shared: RustMediaWorkerPool | undefined;
let sharedClosing: Promise<void> | undefined;
let sharedConcurrency: 1 | 2 | 8 = 2, sharedConfigured = false, sharedCreated = false;
/** 仅可信 Owner 入口在开始接收请求前固定本模块环境的容量；不启动进程，也不热扩已有池。 */
export function configureSharedRustMediaWorkerPool(concurrency: 1 | 2 | 8): void {
  if (![1, 2, 8].includes(concurrency) || sharedClosing || (sharedConfigured || sharedCreated) && sharedConcurrency !== concurrency)
    throw new RustMediaWorkerError('BUDGET_EXCEEDED');
  sharedConcurrency = concurrency; sharedConfigured = true;
}
export function getRustMediaWorkerPool(): RustMediaWorkerPool {
  sharedCreated = true;
  return shared ??= createRustMediaWorkerPool({ concurrency: sharedConcurrency });
}
/** 由可信主进程 shutdown 调用；普通 Reader.close 不关闭其他使用者的共享池。 */
export function closeRustMediaWorkerPool(): Promise<void> {
  if (sharedClosing) return sharedClosing;
  if (!shared) return Promise.resolve();
  const current = shared;
  sharedClosing = current.close().finally(() => { if (shared === current) shared = undefined; sharedClosing = undefined; });
  return sharedClosing;
}
