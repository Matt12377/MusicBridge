import assert from 'node:assert/strict';
import type test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { constants, closeSync, copyFileSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recordingRecordFixture, freezeRerecordPlan } from './recording-record-fixture.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import { createSourceEvidenceService } from '../../src/recording/source-evidence.js';
import { createMediaPlanningCoordinator } from '../../src/recording/media-coordinator.js';
import { createMasterVersionsCoordinator } from '../../src/recording/versions-coordinator.js';
import { createPreparationCoordinator } from '../../src/recording/preparation-coordinator.js';
import { createExecutionCoordinator } from '../../src/recording/execution-coordinator.js';
import { createArchiveCoordinator } from '../../src/recording/archive-coordinator.js';
import { createRecordingPlanCoordinator } from '../../src/recording/plan-coordinator.js';
import type { RecordingPlanVersion } from '@music-bridge/contracts';
import { verifyRecordingAttemptDatabase } from '../../src/recording/attempt-integrity.js';
import { verifyRecordingRecordDatabase } from '../../src/recording/record-integrity.js';
import { verifyRecordingPlanDatabase } from '../../src/recording/plan-integrity.js';

export interface CapacitySample { durationMs: number; outcome: 'ok' | 'failed' | 'timeout' }
/** 分位仅针对成功样本；失败和删失样本始终计入attempts，并使complete为false。 */
export function summarizeCapacitySamples(samples: readonly CapacitySample[]) {
  if (!samples.length || samples.some(s => !Number.isFinite(s.durationMs) || s.durationMs < 0 || !['ok', 'failed', 'timeout'].includes(s.outcome))) throw new Error('容量样本无效');
  const values = samples.filter(s => s.outcome === 'ok').map(s => s.durationMs).sort((a, b) => a - b);
  const rank = (q: number) => values.length ? values[Math.ceil(values.length * q) - 1]! : null;
  return { attempts: samples.length, successes: values.length, failures: samples.filter(s => s.outcome === 'failed').length,
    timeouts: samples.filter(s => s.outcome === 'timeout').length, p50: rank(.5), p95: rank(.95), p99: values.length >= 100 ? rank(.99) : null,
    max: rank(1), complete: values.length === samples.length };
}

export interface CapacityBudget {
  attemptBytes: number; planBytes: number; recordBytes: number; printBytes: number; photoBytes: number; printObjectBytes: number;
  attempts: number; events: number; receipts: number; records: number; plans: number; printJobs: number; printReceipts: number;
}
/** 预算只作种子前置检查；不能替代完整生产核验。 */
export function assertCapacityBudget(value: CapacityBudget): void {
  for (const [key, n] of Object.entries(value)) {
    const limit = ['photoBytes', 'printObjectBytes'].includes(key) ? 1024 ** 3 : key.endsWith('Bytes') ? 128 * 1024 ** 2 : ['attempts', 'plans'].includes(key) ? 10000 : 100000;
    if (!Number.isSafeInteger(n) || n < 0 || n > limit) throw new Error('合成容量超过联合预算');
  }
}
export function readCapacityBudget(db: DatabaseSync): CapacityBudget {
  const bytes = (table: string, columns: readonly string[]) => Number(db.prepare(`SELECT coalesce(sum(${columns.map(c => `coalesce(length(cast(${c} AS BLOB)),0)`).join('+')}),0) n FROM ${table}`).get()!.n);
  const count = (table: string) => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  const attemptBytes = bytes('recording_attempts', ['data']) + bytes('recording_attempt_events', ['data']) + bytes('recording_attempt_receipts', ['request', 'result']);
  const recordBytes = ['recording_records', 'recording_record_current', 'recording_record_events', 'recording_record_permits'].reduce((n, table) => n + bytes(table, ['data']), 0) + bytes('recording_record_receipts', ['request', 'result']);
  const printBytes = bytes('master_artwork_versions', ['data']) + bytes('recording_print_requests', ['data', 'facts']) + bytes('recording_print_jobs', ['data', 'lease'])
    + bytes('recording_print_events', ['data']) + bytes('recording_print_artifacts', ['data']) + bytes('recording_print_receipts', ['request', 'result']);
  const result = { attemptBytes, recordBytes, printBytes, planBytes: bytes('recording_plan_versions', ['data']) + bytes('recording_plan_ledger', ['request']),
    photoBytes: bytes('recording_record_visuals', ['content']), printObjectBytes: bytes('recording_print_objects', ['content']),
    attempts: count('recording_attempts'), events: count('recording_attempt_events'), receipts: count('recording_attempt_receipts'), records: count('recording_records'),
    plans: count('recording_plan_versions'), printJobs: count('recording_print_jobs'), printReceipts: count('recording_print_receipts') };
  assertCapacityBudget(result); return result;
}

/** 一个完整baseline灰度JPEG：1×1，量化系数全1，DC=0/AC=EOB，像素为128。 */
export function capacityJpeg(options?: { bytes: number; id: string }): Buffer {
  const segment = (marker: number, body: Buffer) => { const header = Buffer.from([0xff, marker, 0, 0]); header.writeUInt16BE(body.length + 2, 2); return Buffer.concat([header, body]); };
  const lengths = Buffer.from([1, ...Array<number>(15).fill(0)]);
  const base = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])),
    segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    segment(0xc4, Buffer.concat([Buffer.from([0]), lengths, Buffer.from([0]), Buffer.from([0x10]), lengths, Buffer.from([0])])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x3f, 0xff, 0xd9])]);
  if (!options) return base;
  checkObjectOptions(options, 1024 ** 2);
  let remaining = options.bytes - base.length;
  if (remaining < options.id.length + 4) throw new Error('JPEG容量不足以容纳独立身份');
  const comments: Buffer[] = [];
  while (remaining) {
    let size = Math.min(65537, remaining);
    if (remaining > size && remaining - size < 4) size -= 4;
    const body = Buffer.alloc(size - 4, 0x20);
    body.write(options.id.slice(0, body.length), 'ascii');
    comments.push(segment(0xfe, body)); remaining -= size;
  }
  return Buffer.concat([base.subarray(0, 2), ...comments, base.subarray(2)]);
}
/** 合法单页PDF与真实xref；只作存储容量输入，不替代Electron排版证据。 */
export function capacityPdf(options?: { bytes: number; id: string }): Buffer {
  if (options) checkObjectOptions(options, 4 * 1024 ** 2);
  const build = (padding: number) => {
  const stream = 'BT /F1 10 Tf 20 250 Td (Synthetic capacity fixture) Tj ET\n' + (options ? `% ${options.id}\n${' '.repeat(padding)}\n` : '');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 292.5 288] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let document = '%PDF-1.7\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(document)); document += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(document);
  document += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(document);
  };
  let padding = 0, result = build(padding);
  if (!options) return result;
  if (result.length > options.bytes) throw new Error('PDF容量不足以容纳合法对象');
  for (let attempt = 0; attempt < 8 && result.length !== options.bytes; ++attempt) {
    padding += options.bytes - result.length;
    if (padding < 0) throw new Error('PDF容量无法精确构造');
    result = build(padding);
  }
  assert.equal(result.length, options.bytes); return result;
}

function checkObjectOptions(options: { bytes: number; id: string }, maximum: number): void {
  if (!Number.isSafeInteger(options.bytes) || options.bytes < 1 || options.bytes > maximum || !/^[a-zA-Z0-9-]{1,80}$/u.test(options.id)) throw new Error('容量对象参数越界');
}

export type CapacityProfileName = 'pilot' | 'history-small' | 'objects-small' | 'history-limit' | 'objects-limit' | 'joint';
export interface CapacityProfile {
  name: CapacityProfileName; records: number; recordBytes: number; printBytes: number; photoBytes: number; printObjectBytes: number;
  progressEvents: number; attemptBytes: number; generationLimitMs: number; maxRecords: number;
}
/** 这里只描述已批准数据轴；不修改任何性能门槛。 */
export function capacityProfile(name: CapacityProfileName): CapacityProfile {
  const base = { name, records: 1, recordBytes: 0, printBytes: 0, photoBytes: 0, printObjectBytes: 0,
    progressEvents: 0, attemptBytes: 0, generationLimitMs: 300_000, maxRecords: 1 };
  switch (name) {
    case 'pilot': return { ...base, progressEvents: 100, generationLimitMs: 60_000 };
    case 'history-small': return { ...base, progressEvents: 1000 };
    case 'objects-small': return { ...base, records: 25, maxRecords: 25, photoBytes: 32 * 1024 ** 2, printObjectBytes: 32 * 1024 ** 2 };
    case 'history-limit': return { ...base, progressEvents: 99_700, attemptBytes: Math.ceil(.9 * 128 * 1024 ** 2), generationLimitMs: 1_200_000 };
    case 'objects-limit': return { ...base, maxRecords: 220, photoBytes: Math.ceil(.9 * 1024 ** 3), printObjectBytes: Math.ceil(.9 * 1024 ** 3), generationLimitMs: 1_200_000 };
    case 'joint': return { ...base, maxRecords: 130, progressEvents: 50_000, attemptBytes: 64 * 1024 ** 2,
      recordBytes: 64 * 1024 ** 2, printBytes: 64 * 1024 ** 2, photoBytes: 512 * 1024 ** 2,
      printObjectBytes: 512 * 1024 ** 2, generationLimitMs: 1_200_000 };
    default: throw new Error('未批准容量profile');
  }
}
export function capacityHistoryReached(profile: CapacityProfile, budget: CapacityBudget, progressEvents = 0): boolean {
  const eventsReached = profile.progressEvents === 0 || progressEvents >= profile.progressEvents;
  const bytesReached = profile.attemptBytes === 0 || budget.attemptBytes >= profile.attemptBytes;
  return profile.name === 'history-limit' ? eventsReached || bytesReached : eventsReached && bytesReached;
}
export function capacityGrowth(profile: CapacityProfile, budget: CapacityBudget, progressEvents = 0) {
  assertCapacityBudget(budget);
  const reached = { attemptEvents: profile.progressEvents === 0 || progressEvents >= profile.progressEvents,
    attemptBytes: profile.attemptBytes === 0 || budget.attemptBytes >= profile.attemptBytes,
    recordBytes: profile.recordBytes === 0 || budget.recordBytes >= profile.recordBytes,
    printBytes: profile.printBytes === 0 || budget.printBytes >= profile.printBytes,
    photoBytes: profile.photoBytes === 0 || budget.photoBytes >= profile.photoBytes,
    printObjectBytes: profile.printObjectBytes === 0 || budget.printObjectBytes >= profile.printObjectBytes };
  const structural = { records: budget.records >= profile.records };
  const historyReached = capacityHistoryReached(profile, budget, progressEvents);
  const boundary = Object.entries(budget).filter(([key, n]) => {
    // 已达到所选轴不是阻断其它所选轴的理由；target为0的非目标轴仍受hard budget约束。
    if (key === 'events' && profile.progressEvents > 0 && (reached.attemptEvents || profile.name === 'history-limit' && historyReached)) return false;
    if (key === 'attemptBytes' && profile.attemptBytes > 0 && (reached.attemptBytes || profile.name === 'history-limit' && historyReached)) return false;
    if (key === 'recordBytes' && profile.recordBytes > 0 && reached.recordBytes) return false;
    if (key === 'printBytes' && profile.printBytes > 0 && reached.printBytes) return false;
    if (key === 'photoBytes' && profile.photoBytes > 0 && reached.photoBytes) return false;
    if (key === 'printObjectBytes' && profile.printObjectBytes > 0 && reached.printObjectBytes) return false;
    const maximum = ['photoBytes', 'printObjectBytes'].includes(key) ? 1024 ** 3 : key.endsWith('Bytes') ? 128 * 1024 ** 2 : ['attempts', 'plans'].includes(key) ? 10000 : 100000;
    return n >= Math.ceil(maximum * .9);
  }).map(([key]) => key);
  const targetReached = structural.records && historyReached && reached.recordBytes && reached.printBytes && reached.photoBytes && reached.printObjectBytes;
  return { state: boundary.length ? 'joint-boundary' as const : targetReached ? 'target-reached' as const : 'continue' as const,
    reached, structural, boundary };
}

export function capacityAxes(profile: CapacityProfile, budget: CapacityBudget, progressEvents = 0) {
  const growth = capacityGrowth(profile, budget, progressEvents);
  return {
    targets: { attemptEvents: profile.progressEvents, attemptBytes: profile.attemptBytes, recordBytes: profile.recordBytes,
      printBytes: profile.printBytes, photoBytes: profile.photoBytes, printObjectBytes: profile.printObjectBytes },
    actual: { attemptEvents: progressEvents, attemptBytes: budget.attemptBytes, recordBytes: budget.recordBytes,
      printBytes: budget.printBytes, photoBytes: budget.photoBytes, printObjectBytes: budget.printObjectBytes },
    reached: growth.reached,
  };
}

/** 已批准的空间硬门槛：写入预测后至少10GiB，自建活动数据最多16GiB。 */
export function assertCapacitySpace(value: { availableBytes: number; plannedBytes: number; ownedBytes: number }): void {
  if (Object.values(value).some(n => !Number.isSafeInteger(n) || n < 0) || value.availableBytes - value.plannedBytes < 10 * 1024 ** 3
    || value.ownedBytes + value.plannedBytes > 16 * 1024 ** 3) throw new Error('容量实验达到自建空间预算，保留证据并停止');
}
export function capacityDirectoryBytes(directory: string): number {
  const info = lstatSync(directory);
  if (info.isSymbolicLink()) throw new Error('容量目录不能含符号链接');
  if (info.isFile()) {
    if (info.nlink !== 1) throw new Error('容量目录不能含硬链接文件');
    return info.size;
  }
  if (!info.isDirectory()) throw new Error('容量目录包含非普通文件');
  return readdirSync(directory).reduce((total, name) => total + capacityDirectoryBytes(path.join(directory, name)), 0);
}
export function checkCapacitySpace(directory: string, plannedBytes: number, ownedBytes = capacityDirectoryBytes(directory)) {
  const space = statfsSync(directory, { bigint: true });
  const availableBytes = Number(space.bavail * space.bsize);
  assertCapacitySpace({ availableBytes, plannedBytes, ownedBytes }); return { availableBytes, plannedBytes, ownedBytes };
}
/** measure 的三个 group 严格串行；任一时刻最多保留一个完整 clone，并预留256MiB写增长。 */
export function capacityMeasureWorkingBytes(snapshotBytes: number): number {
  const planned = snapshotBytes + 256 * 1024 ** 2;
  if (!Number.isSafeInteger(snapshotBytes) || snapshotBytes <= 0 || !Number.isSafeInteger(planned)
    || planned > 16 * 1024 ** 3) throw new Error('容量measure写入计划无效');
  return planned;
}
/** 分块hash，避免大SQLite整文件进入Node堆；绑定同一只读普通inode。 */
export function hashCapacityFile(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); if (!before.isFile() || before.nlink !== 1) throw new Error('容量文件身份无效');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 ** 2); let position = 0;
    while (position < before.size) { const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position); if (!bytes) throw new Error('容量文件意外截短'); hash.update(buffer.subarray(0, bytes)); position += bytes; }
    const after = fstatSync(fd), named = lstatSync(file);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'] as const) if (before[key] !== after[key] || after[key] !== named[key]) throw new Error('容量文件读取期间变化');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
interface CapacityTreeEntry {
  relative: string; type: 'directory' | 'file'; device: number; inode: number; mode: number; size: number;
  mtimeMs: number; ctimeMs: number; contentSha256: string | null; contentSha256Verified: boolean;
}
function summarizeCapacityTree(root: string, excludeDatabaseContent: boolean) {
  if (!path.isAbsolute(root) || realpathSync(root) !== root) throw new Error('容量树根目录身份无效');
  const entries: CapacityTreeEntry[] = [], hash = createHash('sha256');
  const walk = (relative: string): void => {
    const absolute = relative ? path.join(root, relative) : root, info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('容量树包含异常对象');
    const database = excludeDatabaseContent && /(?:\.sqlite(?:-(?:wal|shm|journal))?|\.db(?:-(?:wal|shm|journal))?)$/u.test(relative);
    const entry: CapacityTreeEntry = { relative, type: info.isDirectory() ? 'directory' : 'file', device: info.dev, inode: info.ino,
      mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
      contentSha256: info.isFile() && !database ? hashCapacityFile(absolute) : null,
      contentSha256Verified: info.isFile() && !database };
    entries.push(entry); hash.update(JSON.stringify(entry));
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) walk(path.join(relative, name));
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  };
  walk('');
  return { root, entries, treeSha256: hash.digest('hex'), databaseContentSha256Verified: !excludeDatabaseContent,
    excludedDatabaseFiles: entries.filter(entry => entry.type === 'file' && !entry.contentSha256Verified).map(entry => entry.relative) };
}
/** 共享generation fixture只核身份和非DB内容；大SQLite明确不读、不hash。 */
export function summarizeCapacityFixtureTree(root: string) {
  return { scope: 'musicbridge-capacity-fixture-tree' as const, ...summarizeCapacityTree(root, true) };
}
function durableJson(file: string, value: unknown): void {
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(path.dirname(file), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
}
export interface CapacityClone {
  parent: string; label: string; directory: string; filePath: string; marker: { id: string; scope: string; label: string };
  device: number; inode: number; parentDevice: number; parentInode: number;
  aggregateGuard?: CapacityMeasureAggregateGuard;
}
export type CapacityMeasureGroup = 'progress' | 'stop' | 'read';
export type CapacityMeasurePhase = 'copy' | 'open-audit' | 'operation' | 'round-fsync' | 'final-hash' | 'cleanup';
export interface CapacityMeasureAggregateCheck {
  group?: CapacityMeasureGroup; checkpoint: string; plannedBytes?: number;
}
export interface CapacityMeasureAggregateGuard {
  readonly parent: string; readonly snapshotBytes: number; readonly limitBytes: number; readonly stopped: boolean;
  check(input: CapacityMeasureAggregateCheck): {
    sequence: number; outputBytesBefore: number; outputBytesAfter: number; plannedBytes: number; limitBytes: number;
  };
}
export interface CapacityMeasureSample extends CapacitySample {
  metric: string; warmup: boolean; details: unknown;
}
export interface CapacityStopRoundResult {
  attemptId: string; commandId: string; inProgressBefore: 0; inProgressAfter: 0;
  attemptStatus: 'aborted'; attemptReason: 'user-stop'; coordinatorClosed: true; repositoryOpen: true;
  samples: CapacityMeasureSample[];
}
export interface CapacityStopRoundReceipt extends CapacityStopRoundResult {
  schemaVersion: 1; scope: 'musicbridge-capacity-measure-stop-round'; group: 'stop';
  groupMarker: CapacityClone['marker']; roundIndex: number; sampleCount: 6; recordedAt: string;
}
const STOP_METRICS = ['signalAborted', 'driverStopInvoked', 'driverStopAck', 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled'] as const;
export function capacityMeasurePlan() {
  return { groups: ['progress', 'stop', 'read'] as CapacityMeasureGroup[], progressRounds: 105, stopRounds: 105,
    readOperations: 8, readRoundsPerOperation: 105, stopMetricsPerRound: 6,
    totalSamples: 1575, warmupPerSeries: 5, formalPerSeries: 100 };
}

/**
 * measure 的 S+256MiB 是 output 全树的逻辑字节硬上限，不只是磁盘余量预测。
 * 每次成功检查先持久化审计行；一旦越界或出现第二个clone，本guard不再写入，重复调用稳定停止并保留现场。
 */
export function createCapacityMeasureAggregateGuard(parent: string, snapshotBytes: number): CapacityMeasureAggregateGuard {
  if (!path.isAbsolute(parent) || realpathSync(parent) !== parent) throw new Error('容量measure aggregate目录身份无效');
  const limitBytes = capacityMeasureWorkingBytes(snapshotBytes), parentInfo = lstatSync(parent);
  const groupIdentities = new Map<CapacityMeasureGroup, { device: number; inode: number; owner: {
    device: number; inode: number; nlink: number; content: string;
  } }>();
  let sequence = 0, terminal: Error | undefined;
  const stop = (): never => {
    terminal ??= new Error('容量measure output aggregate预算超限或单clone约束失效，保留证据并停止');
    throw terminal;
  };
  const check = (input: CapacityMeasureAggregateCheck) => {
    if (terminal) throw terminal;
    const plannedBytes = input.plannedBytes ?? 0;
    if (!/^[a-z0-9][a-z0-9:-]{0,95}$/u.test(input.checkpoint) || !Number.isSafeInteger(plannedBytes) || plannedBytes < 0) return stop();
    let canonical: string;
    try { canonical = realpathSync(parent); } catch { return stop(); }
    const currentInfo = lstatSync(parent);
    if (canonical !== parent || !currentInfo.isDirectory() || currentInfo.isSymbolicLink()
      || currentInfo.dev !== parentInfo.dev || currentInfo.ino !== parentInfo.ino) return stop();
    let activeClones: Array<{ name: string; group: CapacityMeasureGroup; device: number; inode: number }>, outputBytesBefore: number;
    try {
      activeClones = readdirSync(parent).flatMap(name => {
        const matched = /^group-(progress|stop|read)$/u.exec(name); if (!matched) return [];
        const info = lstatSync(path.join(parent, name));
        if (!info.isDirectory() || info.isSymbolicLink()) return stop();
        return [{ name, group: matched[1] as CapacityMeasureGroup, device: info.dev, inode: info.ino }];
      });
      outputBytesBefore = capacityDirectoryBytes(parent);
    } catch { return stop(); }
    if (activeClones.length > 1 || input.group && activeClones.length === 1 && activeClones[0]!.group !== input.group) return stop();
    const activeClone = activeClones[0];
    if (activeClone) {
      let owner: { device: number; inode: number; nlink: number; content: string };
      try {
        const ownerPath = path.join(parent, activeClone.name, 'owner.json');
        if (realpathSync(ownerPath) !== ownerPath) return stop();
        const fd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = fstatSync(fd), content = readFileSync(fd, 'utf8'), after = fstatSync(fd), named = lstatSync(ownerPath);
          if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || named.isSymbolicLink() || !named.isFile()
            || ['dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]
              || after[key as keyof typeof after] !== named[key as keyof typeof named])) return stop();
          const marker = JSON.parse(content) as unknown;
          if (!marker || typeof marker !== 'object' || Array.isArray(marker)
            || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(['id', 'label', 'scope'])
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String((marker as { id?: unknown }).id))
            || (marker as { scope?: unknown }).scope !== 'musicbridge-capacity-clone-only'
            || (marker as { label?: unknown }).label !== activeClone.name) return stop();
          owner = { device: before.dev, inode: before.ino, nlink: before.nlink, content };
        } finally { closeSync(fd); }
        const directoryAfter = lstatSync(path.join(parent, activeClone.name));
        if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
          || directoryAfter.dev !== activeClone.device || directoryAfter.ino !== activeClone.inode) return stop();
      } catch { return stop(); }
      const bound = groupIdentities.get(activeClone.group);
      if (!bound && input.checkpoint !== 'clone-after-write') return stop();
      if (bound && (bound.device !== activeClone.device || bound.inode !== activeClone.inode
        || bound.owner.device !== owner.device || bound.owner.inode !== owner.inode || bound.owner.nlink !== owner.nlink
        || bound.owner.content !== owner.content)) return stop();
      groupIdentities.set(activeClone.group, { device: activeClone.device, inode: activeClone.inode, owner });
    }
    const expectedIdentity = input.group ? groupIdentities.get(input.group) : undefined;
    if (expectedIdentity && !activeClone && input.checkpoint !== 'clone-after-cleanup') return stop();
    if (outputBytesBefore > limitBytes || plannedBytes > limitBytes - outputBytesBefore) return stop();
    const row = { schemaVersion: 1, scope: 'musicbridge-capacity-measure-aggregate-budget', sequence: sequence + 1,
      checkpoint: input.checkpoint, group: input.group ?? null, activeClone: activeClone?.name ?? null,
      snapshotBytes, limitBytes, outputBytesBefore, plannedBytes, recordedAt: new Date().toISOString() };
    const line = JSON.stringify(row) + '\n', auditBytes = Buffer.byteLength(line);
    if (auditBytes > limitBytes - outputBytesBefore - plannedBytes) return stop();
    const file = path.join(parent, 'measure-aggregate-budget.jsonl');
    const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    let outputBytesAfter: number;
    try { outputBytesAfter = capacityDirectoryBytes(parent); } catch { return stop(); }
    if (outputBytesAfter > limitBytes || plannedBytes > limitBytes - outputBytesAfter) return stop();
    sequence += 1;
    return { sequence, outputBytesBefore, outputBytesAfter, plannedBytes, limitBytes };
  };
  return { parent, snapshotBytes, limitBytes, get stopped() { return terminal !== undefined; }, check };
}

/**
 * Stop量测不能重放同一实体。在正式计时前用公开Core路径准备独立库存、分面、冻结版本、
 * 执行资产、归档与Recording Plan；每个plan绑定不同physical copy，Attempt保护不需要permit或特例。
 */
export interface CapacityStopWorkspace {
  path: string; marker: { id: string; scope: 'musicbridge-capacity-stop-workspace' };
  device: number; inode: number; parentDevice: number; parentInode: number;
}
export interface CapacityPreparedStopPlans { plans: RecordingPlanVersion[]; workspace: CapacityStopWorkspace }
function capacityStopWav(): Buffer {
  const value = Buffer.alloc(44 + 44101 * 4); value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(44100, 24);
  value.writeUInt32LE(176400, 28); value.writeUInt16LE(4, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(value.length - 44, 40);
  return value;
}
function createCapacityStopWorkspace(workspacePath: string): CapacityStopWorkspace {
  const parent = path.dirname(workspacePath);
  if (!path.isAbsolute(workspacePath) || realpathSync(parent) !== parent || path.basename(workspacePath) !== 'group-stop-workspace') throw new Error('Stop workspace路径无效');
  mkdirSync(workspacePath);
  const marker = { id: randomUUID(), scope: 'musicbridge-capacity-stop-workspace' as const };
  durableJson(path.join(workspacePath, 'owner.json'), marker);
  for (const name of ['source', 'execution', 'archive']) mkdirSync(path.join(workspacePath, name));
  const source = path.join(workspacePath, 'source', 'fixture.wav'), fd = openSync(source, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, capacityStopWav()); fsyncSync(fd); } finally { closeSync(fd); }
  for (const directory of [path.join(workspacePath, 'source'), workspacePath, parent]) {
    const directoryFd = openSync(directory, constants.O_RDONLY); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  const info = lstatSync(workspacePath), parentInfo = lstatSync(parent);
  return { path: workspacePath, marker, device: info.dev, inode: info.ino, parentDevice: parentInfo.dev, parentInode: parentInfo.ino };
}
function checkCapacityStopWorkspace(workspace: CapacityStopWorkspace, clone: CapacityClone) {
  const parent = path.dirname(workspace.path), info = lstatSync(workspace.path), parentInfo = lstatSync(parent);
  if (parent !== clone.directory || realpathSync(workspace.path) !== workspace.path || path.basename(workspace.path) !== 'group-stop-workspace'
    || info.dev !== workspace.device || info.ino !== workspace.inode || parentInfo.dev !== workspace.parentDevice || parentInfo.ino !== workspace.parentInode
    || JSON.stringify(JSON.parse(readFileSync(path.join(workspace.path, 'owner.json'), 'utf8'))) !== JSON.stringify(workspace.marker)) throw new Error('Stop workspace身份变化');
  const tree = summarizeCapacityTree(workspace.path, false);
  return { marker: workspace.marker, directories: tree.entries.filter(value => value.type === 'directory').length,
    files: tree.entries.filter(value => value.type === 'file').length,
    bytes: tree.entries.filter(value => value.type === 'file').reduce((sum, value) => sum + value.size, 0),
    treeSha256: tree.treeSha256, entries: tree.entries };
}
export async function prepareCapacityStopPlans(repository: CollectionRepository, template: RecordingPlanVersion, count: number, workspacePath: string): Promise<CapacityPreparedStopPlans> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 105) throw new Error('Stop plan数量无效');
  if (template.layout.spec.format !== 'cassette') throw new Error('Stop plan模板与objects-limit不匹配');
  const workspace = createCapacityStopWorkspace(workspacePath);
  const sourceFile = path.join(workspace.path, 'source', 'fixture.wav');
  repository.receive({ commandId: randomUUID(), model: { brand: 'TDK', name: 'SA', edition: '合成', year: 1990,
    format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60,
    quantities: { openedBlank: count, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
  const media = createMediaPlanningCoordinator({ store: repository.media, drafts: repository.drafts, sources });
  const versions = createMasterVersionsCoordinator({ store: repository.versions, mediaStore: repository.media, media,
    drafts: repository.drafts, sourceStore: repository.sources, sources });
  const preparation = createPreparationCoordinator({ store: repository.preparations, sourceStore: repository.sources, sources });
  const execution = createExecutionCoordinator({ store: repository.execution, profiles: repository.recordingProfiles,
    preparationStore: repository.preparations, preparedStore: repository.prepared, mediaStore: repository.media,
    sourceStore: repository.sources, sources, preparation });
  const archive = createArchiveCoordinator({ store: repository.archive, executionStore: repository.execution,
    preparationStore: repository.preparations, sourceStore: repository.sources, sources, preparation });
  const plans = createRecordingPlanCoordinator({ store: repository.recordingPlans });
  const result: RecordingPlanVersion[] = [];
  try {
    const sourceRoot = await sources.authorize(randomUUID(), path.join(workspace.path, 'source'));
    const destination = await preparation.authorize(randomUUID(), path.join(workspace.path, 'execution'));
    const selectedArchive = await archive.authorize(randomUUID(), path.join(workspace.path, 'archive'));
    const archiveRoot = await archive.initialize({ commandId: randomUUID(), id: selectedArchive.id, userConfirmed: true });
    if (archiveRoot.state !== 'ready') throw new Error('Stop workspace归档授权未就绪');
    for (let index = 1; index <= count; index += 1) {
      const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: createHash('sha256').update(`capacity-stop-${index}-${randomUUID()}`).digest('hex'),
        title: `Stop容量合成录音第${index}册`, programType: 'compilation', metadata: [1, 2, 3].map(track => ({ title: `Stop合成曲目 ${index}-${track}` })) });
      for (const trackId of draft.trackIds) {
        const job = sources.start({ commandId: randomUUID(), draftId: draft.draftId, trackId, rootId: sourceRoot.id, acquisition: 'userFileBind' }, sourceFile);
        await sources.idle();
        if (sources.job(job.id).job?.state !== 'completed') throw new Error('Stop plan源绑定未完成');
        const binding = repository.sources.linked(draft.draftId, trackId)!;
        await sources.confirm({ commandId: randomUUID(), id: binding.id, draftId: draft.draftId, trackId, userConfirmed: true });
      }
      const mediaPreview = await media.preview({ draftId: draft.draftId, spec: template.layout.spec, page: { offset: 0, limit: 25 } });
      const saved = await media.save({ commandId: randomUUID(), draftId: draft.draftId, expectedDraftRevision: mediaPreview.draftRevision,
        inputFingerprint: mediaPreview.inputFingerprint, spec: template.layout.spec });
      const reserved = await media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision,
        skuId: template.layout.reservation.skuId, packaging: 'opened', userConfirmed: true });
      const versionPreview = await versions.preview({ planId: reserved.id, sampleRate: 96000 });
      const version = await versions.freeze({ commandId: randomUUID(), planId: reserved.id, sampleRate: 96000,
        proposalFingerprint: versionPreview.proposalFingerprint, userConfirmed: true });
      await versions.idle();
      const layoutVersionId = versions.job(version.id).job?.layoutVersionId;
      if (!layoutVersionId) throw new Error('Stop plan布局冻结未完成');
      const session = repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 0,
        profileVersionId: template.profileSnapshot.settings.profile.id, overrides: { recordLevel: 'Stop容量合成人工电平' }, userConfirmed: true });
      const executionSelection = { layoutVersionId, destinationId: destination.id, mode: 'direct' as const, sessionRevision: session.revision };
      const executionPreview = await execution.preview({ ...executionSelection, readId: randomUUID() });
      const executionJob = await execution.start({ ...executionSelection, commandId: randomUUID(),
        proposalFingerprint: executionPreview.proposalFingerprint, userConfirmed: true });
      await execution.idle();
      if (execution.job(executionJob.id).job?.state !== 'completed') throw new Error('Stop plan执行资产未完成');
      const archiveSelection = { rootId: archiveRoot.id, assetId: executionJob.id, sourcePolicy: 'preserve-exact-sources' as const };
      const archivePreview = await archive.preview({ ...archiveSelection, readId: randomUUID() });
      const archiveRequest = { ...archiveSelection, commandId: randomUUID(), proposalFingerprint: archivePreview.proposalFingerprint, userConfirmed: true as const };
      await archive.start(archiveRequest); await archive.idle();
      if (repository.archive.operation(archiveRequest.commandId)?.phase !== 'FINALIZED') throw new Error('Stop plan归档未完成');
      const selection = { assetId: executionJob.id, archiveOperationId: archiveRequest.commandId };
      const planPreview = await plans.preview({ selection, readId: randomUUID() });
      result.push(await plans.freeze({ commandId: randomUUID(), selection, proposalFingerprint: planPreview.proposalFingerprint, userConfirmed: true }));
    }
    if (new Set(result.map(value => value.physicalCopy.physicalId)).size !== count) throw new Error('Stop plan未绑定独立实体');
    return { plans: result, workspace };
  } finally {
    await plans.close(); await archive.close(); await execution.close(); await preparation.close(); await versions.close(); await sources.close();
  }
}
export function appendCapacityMeasureStage(parent: string, group: CapacityMeasureGroup, phase: CapacityMeasurePhase, details: unknown,
  aggregateGuard?: CapacityMeasureAggregateGuard): void {
  if (realpathSync(parent) !== parent) throw new Error('容量measure阶段目录身份无效');
  const file = path.join(parent, 'measure-stages.jsonl');
  const line = JSON.stringify({ schemaVersion: 1, scope: 'musicbridge-capacity-measure-stage', group, phase,
    recordedAt: new Date().toISOString(), details }) + '\n';
  // 写前同时为写后审计预留固定空间；checkpoint/details都有界，审计行不会超过1KiB。
  aggregateGuard?.check({ group, checkpoint: `stage-${phase}-before-write`, plannedBytes: Buffer.byteLength(line) + 1024 });
  const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, line);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const directory = openSync(parent, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
  aggregateGuard?.check({ group, checkpoint: `stage-${phase}-after-write` });
}
export async function runCapacityStopRounds(
  clone: CapacityClone, rounds: number, execute: (roundIndex: number) => Promise<CapacityStopRoundResult>,
  onDurableReceipt?: (receipt: CapacityStopRoundReceipt) => void | Promise<void>,
): Promise<CapacityStopRoundReceipt[]> {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 105) throw new Error('Stop round数量无效');
  const receipts: CapacityStopRoundReceipt[] = [], attempts = new Set<string>(), commands = new Set<string>();
  appendCapacityMeasureStage(clone.parent, 'stop', 'operation', { rounds }, clone.aggregateGuard);
  try {
    for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
      const result = await execute(roundIndex);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.attemptId)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.commandId)
        || attempts.has(result.attemptId) || commands.has(result.commandId)
        || result.inProgressBefore !== 0 || result.inProgressAfter !== 0 || result.attemptStatus !== 'aborted'
        || result.attemptReason !== 'user-stop' || result.coordinatorClosed !== true || result.repositoryOpen !== true
        || !Array.isArray(result.samples) || result.samples.length !== STOP_METRICS.length
        || result.samples.some((sample, index) => sample.metric !== STOP_METRICS[index]
          || !Number.isFinite(sample.durationMs) || sample.durationMs < 0 || sample.warmup !== (roundIndex <= 5)
          || !['ok', 'failed', 'timeout'].includes(sample.outcome))) throw new Error('Stop round事实无效');
      attempts.add(result.attemptId); commands.add(result.commandId);
      const receipt: CapacityStopRoundReceipt = { schemaVersion: 1, scope: 'musicbridge-capacity-measure-stop-round',
        group: 'stop', groupMarker: clone.marker, roundIndex, ...result, sampleCount: 6, recordedAt: new Date().toISOString() };
      const receiptFile = path.join(clone.parent, `${clone.label}.round-${String(roundIndex).padStart(3, '0')}.receipt.json`);
      const receiptBytes = Buffer.byteLength(JSON.stringify(receipt, null, 2) + '\n');
      clone.aggregateGuard?.check({ group: 'stop', checkpoint: 'stop-round-receipt-before-write', plannedBytes: receiptBytes + 1024 });
      durableJson(receiptFile, receipt);
      clone.aggregateGuard?.check({ group: 'stop', checkpoint: 'stop-round-receipt-after-write' });
      receipts.push(receipt);
      await onDurableReceipt?.(receipt);
    }
  } finally {
    appendCapacityMeasureStage(clone.parent, 'stop', 'round-fsync', { requestedRounds: rounds, completedRounds: receipts.length,
      lastReceipt: receipts.length ? `${clone.label}.round-${String(receipts.length).padStart(3, '0')}.receipt.json` : null }, clone.aggregateGuard);
  }
  return receipts;
}
export function createCapacityClone(parent: string, label: string, seed: string, plannedBytes?: number,
  aggregateGuard?: CapacityMeasureAggregateGuard): CapacityClone {
  if (realpathSync(parent) !== parent || !/^[a-z0-9-]{1,64}$/u.test(label)) throw new Error('容量clone父目录或label无效');
  const info = lstatSync(seed); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('种子不是独占普通文件');
  checkCapacitySpace(parent, plannedBytes ?? info.size * 3 + 64 * 1024 ** 2);
  const group = /^group-(progress|stop|read)$/u.exec(label)?.[1] as CapacityMeasureGroup | undefined;
  if (aggregateGuard && (!group || aggregateGuard.parent !== parent || aggregateGuard.snapshotBytes !== info.size
    || plannedBytes !== aggregateGuard.limitBytes)) throw new Error('容量measure aggregate clone参数无效');
  const marker = { id: randomUUID(), scope: 'musicbridge-capacity-clone-only', label };
  aggregateGuard?.check({ group: group!, checkpoint: 'clone-before-write',
    plannedBytes: info.size + Buffer.byteLength(JSON.stringify(marker, null, 2) + '\n') + 1024 });
  const directory = path.join(parent, label); mkdirSync(directory);
  durableJson(path.join(directory, 'owner.json'), marker);
  const filePath = path.join(directory, 'sample.sqlite'); copyFileSync(seed, filePath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const stat = lstatSync(directory), parentStat = lstatSync(parent);
  aggregateGuard?.check({ group: group!, checkpoint: 'clone-after-write' });
  return { parent, label, directory, filePath, marker, device: stat.dev, inode: stat.ino, parentDevice: parentStat.dev,
    parentInode: parentStat.ino, ...(aggregateGuard ? { aggregateGuard } : {}) };
}
export function finishCapacityClone(clone: CapacityClone, result: { outcome: CapacitySample['outcome']; resourcesClosed: boolean; samples: unknown;
  ownedWorkspace?: CapacityStopWorkspace; onPhase?: (phase: 'final-hash' | 'cleanup', details: unknown) => void }): string {
  const group = /^group-(progress|stop|read)$/u.exec(clone.label)?.[1] as CapacityMeasureGroup | undefined;
  if (clone.aggregateGuard && !group) throw new Error('容量measure aggregate clone身份无效');
  const durableAggregateJson = (file: string, value: unknown, checkpoint: string) => {
    const bytes = Buffer.byteLength(JSON.stringify(value, null, 2) + '\n');
    clone.aggregateGuard?.check({ group: group!, checkpoint: `${checkpoint}-before-write`, plannedBytes: bytes + 1024 });
    durableJson(file, value);
    clone.aggregateGuard?.check({ group: group!, checkpoint: `${checkpoint}-after-write` });
  };
  const check = () => {
    if (!result.resourcesClosed || realpathSync(clone.parent) !== clone.parent || realpathSync(clone.directory) !== clone.directory || path.dirname(clone.directory) !== clone.parent || path.basename(clone.directory) !== clone.label) throw new Error('容量clone未关闭或路径身份变化');
    const info = lstatSync(clone.directory), parentInfo = lstatSync(clone.parent);
    if (info.dev !== clone.device || info.ino !== clone.inode || parentInfo.dev !== clone.parentDevice || parentInfo.ino !== clone.parentInode) throw new Error('容量clone目录身份变化');
    assert.deepEqual(JSON.parse(readFileSync(path.join(clone.directory, 'owner.json'), 'utf8')), clone.marker);
    const files = ['owner.json', 'sample.sqlite', 'sample.sqlite-wal', 'sample.sqlite-shm', 'sample.sqlite-journal'];
    for (const name of readdirSync(clone.directory)) {
      const value = lstatSync(path.join(clone.directory, name));
      if (result.ownedWorkspace && name === 'group-stop-workspace') {
        if (clone.label !== 'group-stop' || result.ownedWorkspace.path !== path.join(clone.directory, name) || !value.isDirectory() || value.isSymbolicLink()) throw new Error('容量clone的Stop workspace无效');
      } else if (!files.includes(name) || !value.isFile() || value.isSymbolicLink()) throw new Error('容量clone包含非预期对象');
    }
    if (result.ownedWorkspace && !readdirSync(clone.directory).includes('group-stop-workspace')) throw new Error('容量clone缺少Stop workspace');
  };
  check();
  const workspaceTree = result.ownedWorkspace ? checkCapacityStopWorkspace(result.ownedWorkspace, clone) : null;
  const workspaceReceipt = workspaceTree ? path.join(clone.parent, `${clone.label}.workspace.receipt.json`) : null;
  if (workspaceReceipt) durableAggregateJson(workspaceReceipt, { schemaVersion: 1, scope: 'musicbridge-capacity-stop-workspace-tree',
    groupMarker: clone.marker, workspace: workspaceTree, recordedAt: new Date().toISOString() }, 'workspace-receipt');
  const receipt = path.join(clone.parent, `${clone.label}.receipt.json`);
  const sqliteSha256 = hashCapacityFile(clone.filePath), retained = result.outcome !== 'ok';
  const { onPhase, ownedWorkspace: _ownedWorkspace, ...receiptResult } = result;
  const receiptValue = { ...receiptResult, marker: clone.marker, sqliteSha256, retained,
    workspaceReceipt: workspaceReceipt ? path.basename(workspaceReceipt) : null,
    workspaceTreeSha256: workspaceTree?.treeSha256 ?? null };
  durableAggregateJson(receipt, receiptValue, 'group-receipt');
  onPhase?.('final-hash', { receipt: path.basename(receipt), sqliteSha256, retained,
    workspaceReceipt: workspaceReceipt ? path.basename(workspaceReceipt) : null, workspaceTreeSha256: workspaceTree?.treeSha256 ?? null });
  if (result.outcome === 'ok') {
    check(); // 持久receipt完成后再复核，失败/超时永不删。
    if (result.ownedWorkspace) assert.deepEqual(checkCapacityStopWorkspace(result.ownedWorkspace, clone), workspaceTree,
      'Stop workspace在封存与清理之间发生变化');
    // cleanup事实也必须先持久化；此后只做删除，避免“已删clone但阶段receipt写失败”。
    onPhase?.('cleanup', { receipt: path.basename(receipt), retained: false, action: 'delete-after-stage' });
    // group可包含自建workspace；只有最终receipt与cleanup阶段都持久化后才整体递归删除。
    rmSync(clone.directory, { recursive: true });
    clone.aggregateGuard?.check({ group: group!, checkpoint: 'clone-after-cleanup' });
  } else onPhase?.('cleanup', { receipt: path.basename(receipt), retained: true, action: 'retain' });
  return receipt;
}

/** 此入口只跑已批准小pilot；没有提高预算或注入生产认证的开关。 */
export async function createCapacityPilot(t: test.TestContext, options: { retainDirectory?: boolean } = {}) {
  return createCapacitySeed(t, { ...options, profile: 'pilot' });
}
export async function createCapacitySeed(t: test.TestContext, options: { profile: CapacityProfileName; retainDirectory?: boolean; checkpoint?: (value: unknown) => void }) {
  if (options.profile !== 'pilot' && options.profile !== 'history-small') return createCapacityObjects(t, capacityProfile(options.profile), options);
  const started = performance.now();
  const progressEvents = options.profile === 'pilot' ? 100 : 1000, generationLimit = options.profile === 'pilot' ? 60000 : 300000;
  const checkpoint = () => { if (performance.now() - started > generationLimit) throw new Error('容量种子生成超过预定期限，不扩大规模或冒称性能通过'); };
  const f = await recordingRecordFixture(t, 'cassette', options); checkpoint();
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const image = { dataUrl: `data:image/jpeg;base64,${capacityJpeg().toString('base64')}`, width: 1, height: 1 };
  f.repository.addPhoto({ commandId: randomUUID(), modelId: f.frozenPlan.layout.reservation.modelId, physicalId: f.frozenPlan.physicalCopy.physicalId, image });
  let completed = await f.attempts.begin(f.beginRequest());
  const firstDriver = f.starts.at(-1)!;
  assert.ok(completed.sides[0]!.frameCount > progressEvents);
  for (let frame = 1; frame <= progressEvents; ++frame) {
    firstDriver.onEvent({ type: 'progress', side: firstDriver.side, runId: firstDriver.runId, at: new Date().toISOString(), sourceFramesRead: frame, submittedFrames: frame, consumedFrames: frame }); checkpoint();
  }
  assert.equal(f.attempts.get({ attemptId: completed.id }).attempt!.revision, completed.revision + progressEvents);
  // 仅为插入真实单调进度复用原fixture的完成顺序；实体确认与翻面仍各为独立命令。
  for (let index = 0; index < completed.sides.length; ++index) {
    const side = completed.sides[index]!, driver = f.starts.at(-1)!, at = new Date().toISOString();
    driver.onEvent({ type: 'progress', side: side.side, runId: driver.runId, at, sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
    for (const type of ['source-eof', 'engine-cutoff', 'cleanup-quiescent', 'backend-drained'] as const) driver.onEvent({ type, side: side.side, runId: driver.runId, at });
    await new Promise<void>(resolve => setImmediate(resolve));
    completed = f.attempts.get({ attemptId: completed.id }).attempt!;
    completed = await f.attempts.confirm({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, kind: 'physical-stop', side: side.side, userConfirmed: true });
    if (index + 1 < completed.sides.length) {
      completed = await f.attempts.confirm({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, kind: 'flip', userConfirmed: true });
      completed = await f.attempts.beginSide({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, side: 'B', userConfirmed: true });
    }
  }
  for (const kind of ['physical-recording', 'final-verification'] as const) completed = await f.attempts.confirm({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, kind, userConfirmed: true });
  assert.equal(completed.status, 'completed'); checkpoint();
  const prints = f.repository.recordingPrints, lease = prints.claim({ workerId: randomUUID() }).lease!;
  const pdf = capacityPdf(), pdfSha256 = createHash('sha256').update(pdf).digest('hex');
  prints.complete({ jobId: lease.jobId, leaseId: lease.leaseId, workerId: lease.workerId, inputHash: lease.inputHash, pdfBase64: pdf.toString('base64'), pdfSha256,
    preview: image, pageCount: 1, rendererVersion: 'capacity-fixture-1' });
  // 使用同一已锁曲序的新媒体规划，预留另一实体；旧Completed与旧预留均不改。
  const preview = await f.media.preview({ draftId: f.draft.draftId, spec: f.layout.spec, page: { offset: 0, limit: 25 } });
  const saved = await f.media.save({ commandId: randomUUID(), draftId: f.draft.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const reserved = await f.media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision, skuId: f.frozenPlan.layout.reservation.skuId, packaging: 'opened', userConfirmed: true });
  const nextPlan = await freezeRerecordPlan(f, reserved.id); checkpoint();
  assert.notEqual(nextPlan.physicalCopy.physicalId, completed.physicalId);
  f.attempts.assertExecutionIdle();
  verifyRecordingPlanDatabase(db); verifyRecordingAttemptDatabase(db); verifyRecordingRecordDatabase(db); checkpoint();
  const budget = readCapacityBudget(db);
  assert.ok(budget.photoBytes + budget.printObjectBytes <= 4 * 1024 ** 2);
  const manifest = { schema: 21, classification: options.profile === 'pilot' ? 'functional-pilot/non-performance' : 'capacity-seed/non-performance', profile: options.profile, budget, progressEvents,
    completedPhysicalId: completed.physicalId, nextPhysicalId: nextPlan.physicalCopy.physicalId, nextPlanId: nextPlan.id, completedAttemptId: completed.id,
    integrity: 'passed' as const, generationMs: performance.now() - started, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    pdfSha256, jpegSha256: createHash('sha256').update(capacityJpeg()).digest('hex') };
  return { ...f, db, nextPlan, completed, manifest };
}

type CapacityFixture = Awaited<ReturnType<typeof recordingRecordFixture>>;
type CapacityPlan = CapacityFixture['frozenPlan'];
/** 新draft避免每draft的100个Plan上限；所有事实经原公开Core方法生成。 */
async function newCapacityPlan(f: CapacityFixture, index: number): Promise<CapacityPlan> {
  const draft = f.repository.drafts.append({ commandId: randomUUID(), fingerprint: createHash('sha256').update(`capacity-${index}`).digest('hex'),
    title: `容量合成录音第${index}册 ${'长中文曲序及归档检索'.repeat(5)}`, programType: 'compilation', metadata: [1, 2, 3].map(i => ({ title: `合成曲目 ${index}-${i}` })) });
  const root = f.repository.sources.roots().find(value => value.path === f.sourcePath)!;
  for (const trackId of draft.trackIds) {
    const job = f.sources.start({ commandId: randomUUID(), draftId: draft.draftId, trackId, rootId: root.id, acquisition: 'userFileBind' }, f.file);
    await f.sources.idle(); assert.equal(f.sources.job(job.id).job!.state, 'completed');
    const binding = f.repository.sources.linked(draft.draftId, trackId)!;
    await f.sources.confirm({ commandId: randomUUID(), id: binding.id, draftId: draft.draftId, trackId, userConfirmed: true });
  }
  const session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: draft.draftId, expectedRevision: 0,
    profileVersionId: f.profile.id, overrides: { recordLevel: '容量合成人工电平' }, userConfirmed: true });
  const preview = await f.media.preview({ draftId: draft.draftId, spec: f.layout.spec, page: { offset: 0, limit: 25 } });
  const saved = await f.media.save({ commandId: randomUUID(), draftId: draft.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec });
  const reserved = await f.media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision, skuId: f.frozenPlan.layout.reservation.skuId, packaging: 'opened', userConfirmed: true });
  return freezeRerecordPlan({ ...f, draft, session }, reserved.id);
}

async function finishCapacityAttempt(f: CapacityFixture, plan: CapacityPlan, progressEvents: number, checkpoint: (progress: number) => boolean) {
  let completed = await f.attempts.begin({ commandId: randomUUID(), planVersionId: plan.id, planContentHash: plan.contentHash, userConfirmed: true });
  const driver = f.starts.at(-1)!; let actualProgress = 0;
  assert.ok(completed.sides[0]!.frameCount > progressEvents);
  for (let frame = 1; frame <= progressEvents; ++frame) {
    driver.onEvent({ type: 'progress', side: driver.side, runId: driver.runId, at: new Date().toISOString(), sourceFramesRead: frame, submittedFrames: frame, consumedFrames: frame });
    actualProgress = frame;
    if (frame % 100 === 0 && checkpoint(frame)) break;
  }
  for (let index = 0; index < completed.sides.length; ++index) {
    const side = completed.sides[index]!, active = f.starts.at(-1)!, at = new Date().toISOString();
    active.onEvent({ type: 'progress', side: side.side, runId: active.runId, at, sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
    for (const type of ['source-eof', 'engine-cutoff', 'cleanup-quiescent', 'backend-drained'] as const) active.onEvent({ type, side: side.side, runId: active.runId, at });
    await new Promise<void>(resolve => setImmediate(resolve));
    completed = f.attempts.get({ attemptId: completed.id }).attempt!;
    completed = await f.attempts.confirm({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, kind: 'physical-stop', side: side.side, userConfirmed: true });
    if (index + 1 < completed.sides.length) {
      completed = await f.attempts.confirm({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, kind: 'flip', userConfirmed: true });
      completed = await f.attempts.beginSide({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, side: 'B', userConfirmed: true });
    }
  }
  for (const kind of ['physical-recording', 'final-verification'] as const) completed = await f.attempts.confirm({ commandId: randomUUID(), attemptId: completed.id, expectedRevision: completed.revision, kind, userConfirmed: true });
  assert.equal(completed.status, 'completed'); return { completed, actualProgress };
}

/** 只下调正式objects-small的数据轴，证明生成/删源照片的语义，不产生容量成绩。 */
export async function createCapacityObjectProbe(t: test.TestContext, options: { retainDirectory?: boolean } = {}) {
  return createCapacityObjects(t, { ...capacityProfile('objects-small'), records: 2, maxRecords: 2, photoBytes: 4096, printObjectBytes: 8192,
    progressEvents: 4, generationLimitMs: 60_000 }, options, 'object');
}

/** 缩小六轴只验证joint manifest与增长语义，不提供正式规模成绩。 */
export async function createCapacityJointProbe(t: test.TestContext, options: { retainDirectory?: boolean } = {}) {
  return createCapacityObjects(t, { ...capacityProfile('joint'), records: 2, maxRecords: 2, recordBytes: 1, printBytes: 1,
    photoBytes: 4096, printObjectBytes: 8192, progressEvents: 4, attemptBytes: 0, generationLimitMs: 60_000 }, options, 'joint');
}

/** 非正式阶梯仅验证对象热路径增长曲线；不写正式R023结果，也不改变objects-limit门槛。 */
export async function createCapacityObjectLadder(t:test.TestContext,records:3|10|25|50,options:{retainDirectory?:boolean}={}){
  if(![3,10,25,50].includes(records))throw new Error('对象阶梯规模未批准');
  return createCapacityObjects(t,{...capacityProfile('objects-small'),records,maxRecords:records,photoBytes:0,
    printObjectBytes:records*(4*1024**2+256),progressEvents:0,attemptBytes:0,generationLimitMs:300_000},options,'object');
}

async function createCapacityObjects(t: test.TestContext, profile: CapacityProfile,
  options: { retainDirectory?: boolean; checkpoint?: (value: unknown) => void }, functional?: 'object' | 'joint') {
  const started = performance.now();
  // SQLite/WAL/备份副本+执行工作文件的保守自建上界；不预分配这些字节。
  const estimatedBytes = (profile.photoBytes + profile.printObjectBytes + profile.attemptBytes + profile.recordBytes + profile.printBytes) * 3
    + profile.maxRecords * 16 * 1024 ** 2 + 128 * 1024 ** 2;
  checkCapacitySpace(realpathSync(os.tmpdir()), estimatedBytes, 0);
  const f = await recordingRecordFixture(t, 'cassette', { ...options, stockQuantities: { openedBlank: profile.maxRecords + 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  let progressEvents = 0, removedSourcePhotos = 0, budget = readCapacityBudget(db);
  const checkpoint = () => {
    budget = readCapacityBudget(db);
    checkCapacitySpace(f.directory, 64 * 1024 ** 2);
    options.checkpoint?.({ fixtureDirectory: f.directory, generationMs: performance.now() - started, profile, budget, progressEvents, partial: true });
    if (performance.now() - started > profile.generationLimitMs) throw new Error('容量种子生成达到已批准期限，保留partial且未达到目标');
  };
  // 只预建达到对象/结构目标所需的计划及一个next plan；不为maxRecords上界制造永远不用的预留。
  const photoRecords=profile.photoBytes===0?0:Math.ceil(profile.photoBytes/(profile.name==='objects-small'?Math.ceil(profile.photoBytes/profile.records):24*1024**2));
  const printRecords=profile.printObjectBytes===0?0:Math.ceil(profile.printObjectBytes/(profile.name==='objects-small'?Math.ceil(profile.printObjectBytes/profile.records):5*1024**2));
  const preparedRecords=profile.name==='joint'?profile.maxRecords:Math.min(profile.maxRecords,Math.max(profile.records,photoRecords,printRecords));
  const plans:CapacityPlan[]=[f.frozenPlan];
  for(let index=1;index<=preparedRecords;++index){plans.push(await newCapacityPlan(f,index+1));checkpoint();}
  const planPreparation={strategy:'prebuilt-before-object-growth' as const,prepared:plans.length,beforeFirstAttempt:true as const};
  let completed: Awaited<ReturnType<typeof finishCapacityAttempt>>['completed'] | undefined;
  let firstCompleted: typeof completed;
  let pdfSha256 = '', jpegSha256 = '';
  for (let index = 0; index < profile.maxRecords; ++index) {
    checkpoint();
    const plan=plans[index]!;
    const modelId = plan.layout.reservation.modelId, physicalId = plan.physicalCopy.physicalId;
    const perRecordPhoto = profile.name === 'objects-small' ? Math.ceil(profile.photoBytes / profile.records) : Math.min(24 * 1024 ** 2, Math.max(0, profile.photoBytes - budget.photoBytes));
    const photoIds: string[] = [];
    for (let remaining = Math.max(index === 0 ? 137 : 0, perRecordPhoto), photo = 0; remaining > 0; ++photo) {
      const bytes = Math.min(1024 ** 2, remaining), size = Math.max(256, bytes);
      const imageBytes = capacityJpeg({ bytes: size, id: `record-${index}-photo-${photo}` }); jpegSha256 = createHash('sha256').update(imageBytes).digest('hex');
      const uploaded = f.repository.addPhoto({ commandId: randomUUID(), modelId, physicalId, image: { dataUrl: `data:image/jpeg;base64,${imageBytes.toString('base64')}`, width: 1, height: 1 } });
      assert.ok(uploaded.photoId); photoIds.push(uploaded.photoId);
      remaining -= bytes;
    }
    const finished = await finishCapacityAttempt(f, plan, index ? 0 : profile.progressEvents, count => {
      progressEvents = count; checkpoint();
      return capacityHistoryReached(profile, budget, count);
    });
    completed = finished.completed; progressEvents += index ? 0 : finished.actualProgress - progressEvents;
    firstCompleted ??= completed;
    const raw = db.prepare('SELECT id,data FROM recording_records WHERE attempt_id=?').get(completed.id)!;
    const recordData = String(raw.data), record = JSON.parse(recordData) as { visuals: { photos: { state: string; attachments: { sha256: string; sourcePhotoId: string }[] } } };
    assert.equal(record.visuals.photos.state, photoIds.length ? 'captured' : 'not-captured');
    const captured = record.visuals.photos.attachments ?? [];
    const capturedBytes = captured.map(a => ({ attachment: a, bytes: Buffer.from(db.prepare('SELECT content FROM recording_record_visuals WHERE sha256=?').get(a.sha256)!.content as Uint8Array) }));
    const perRecordPrint = profile.name === 'objects-small' ? Math.ceil(profile.printObjectBytes / profile.records) : Math.min(5 * 1024 ** 2, Math.max(1024, profile.printObjectBytes - budget.printObjectBytes));
    const previewSize = profile.name === 'objects-small' ? 256 : Math.min(1024 ** 2, Math.max(256, perRecordPrint - 4 * 1024 ** 2));
    const pdf = capacityPdf({ bytes: Math.min(4 * 1024 ** 2, Math.max(1024, perRecordPrint - previewSize)), id: `record-${index}-pdf` });
    const preview = capacityJpeg({ bytes: previewSize, id: `record-${index}-preview` }); pdfSha256 = createHash('sha256').update(pdf).digest('hex');
    const lease = f.repository.recordingPrints.claim({ workerId: randomUUID() }).lease!; assert.ok(lease);
    f.repository.recordingPrints.complete({ jobId: lease.jobId, leaseId: lease.leaseId, workerId: lease.workerId, inputHash: lease.inputHash,
      pdfBase64: pdf.toString('base64'), pdfSha256, preview: { dataUrl: `data:image/jpeg;base64,${preview.toString('base64')}`, width: 1, height: 1 }, pageCount: 1, rendererVersion: 'capacity-fixture-1' });
    // 仅移除本轮刚加入的source附件；不可变Record与独立BLOB、source引用必须逐个保持。
    for (const photoId of photoIds) {
      f.repository.changePhoto({ commandId: randomUUID(), modelId, photoId, expectedRevision: f.repository.detail(modelId, { offset: 0, limit: 25 }).model.revision, action: 'remove' });
      ++removedSourcePhotos;
    }
    assert.equal(db.prepare('SELECT data FROM recording_records WHERE id=?').get(String(raw.id))!.data, recordData);
    for (const captured of capturedBytes) {
      assert.ok(photoIds.includes(captured.attachment.sourcePhotoId));
      assert.deepEqual(Buffer.from(db.prepare('SELECT content FROM recording_record_visuals WHERE sha256=?').get(captured.attachment.sha256)!.content as Uint8Array), captured.bytes);
    }
    checkpoint();
    const growth = capacityGrowth(profile, budget, progressEvents);
    if (growth.state !== 'continue') break;
  }
  assert.ok(completed && firstCompleted);
  checkpoint();
  const growth = capacityGrowth(profile, budget, progressEvents);
  const nextPlan=plans[budget.records]!;
  f.attempts.assertExecutionIdle(); verifyRecordingPlanDatabase(db); verifyRecordingAttemptDatabase(db); verifyRecordingRecordDatabase(db); checkpoint();
  const classification = functional === 'object' ? 'functional-object-probe/non-performance' : functional === 'joint'
    ? 'functional-joint-probe/non-performance' : 'capacity-seed/non-performance';
  const axes = capacityAxes(profile, budget, progressEvents);
  const structural = { records: { target: profile.records, actual: budget.records, reached: growth.structural.records } };
  const manifest = { schema: 21, classification, profile: profile.name,
    budget, progressEvents, completedPhysicalId: firstCompleted.physicalId, nextPhysicalId: nextPlan.physicalCopy.physicalId, nextPlanId: nextPlan.id,
    completedAttemptId: firstCompleted.id, integrity: 'passed' as const, generationMs: performance.now() - started, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    pdfSha256, jpegSha256, growth, axes, structural, targets: profile, removedSourcePhotos, planPreparation };
  return { ...f, db, nextPlan, completed: firstCompleted, manifest };
}
