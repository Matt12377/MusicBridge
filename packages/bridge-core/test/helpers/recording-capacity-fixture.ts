import assert from 'node:assert/strict';
import type test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { constants, closeSync, copyFileSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmdirSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recordingRecordFixture, freezeRerecordPlan } from './recording-record-fixture.js';
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
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) throw new Error('容量目录包含非普通文件');
  return readdirSync(directory).reduce((total, name) => total + capacityDirectoryBytes(path.join(directory, name)), 0);
}
export function checkCapacitySpace(directory: string, plannedBytes: number, ownedBytes = capacityDirectoryBytes(directory)) {
  const space = statfsSync(directory, { bigint: true });
  const availableBytes = Number(space.bavail * space.bsize);
  assertCapacitySpace({ availableBytes, plannedBytes, ownedBytes }); return { availableBytes, plannedBytes, ownedBytes };
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
function durableJson(file: string, value: unknown): void {
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(path.dirname(file), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
}
export interface CapacityClone {
  parent: string; label: string; directory: string; filePath: string; marker: { id: string; scope: string; label: string };
  device: number; inode: number; parentDevice: number; parentInode: number;
}
export type CapacityMeasureGroup = 'progress' | 'stop' | 'read';
export type CapacityMeasurePhase = 'copy' | 'open-audit' | 'operation' | 'round-fsync' | 'final-hash' | 'cleanup';
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
export function appendCapacityMeasureStage(parent: string, group: CapacityMeasureGroup, phase: CapacityMeasurePhase, details: unknown): void {
  if (realpathSync(parent) !== parent) throw new Error('容量measure阶段目录身份无效');
  const file = path.join(parent, 'measure-stages.jsonl');
  const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, scope: 'musicbridge-capacity-measure-stage', group, phase,
      recordedAt: new Date().toISOString(), details }) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const directory = openSync(parent, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
}
export async function runCapacityStopRounds(
  clone: CapacityClone, rounds: number, execute: (roundIndex: number) => Promise<CapacityStopRoundResult>,
  onDurableReceipt?: (receipt: CapacityStopRoundReceipt) => void | Promise<void>,
): Promise<CapacityStopRoundReceipt[]> {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 105) throw new Error('Stop round数量无效');
  const receipts: CapacityStopRoundReceipt[] = [], attempts = new Set<string>(), commands = new Set<string>();
  appendCapacityMeasureStage(clone.parent, 'stop', 'operation', { rounds });
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
      durableJson(path.join(clone.parent, `${clone.label}.round-${String(roundIndex).padStart(3, '0')}.receipt.json`), receipt);
      receipts.push(receipt);
      await onDurableReceipt?.(receipt);
    }
  } finally {
    appendCapacityMeasureStage(clone.parent, 'stop', 'round-fsync', { requestedRounds: rounds, completedRounds: receipts.length,
      lastReceipt: receipts.length ? `${clone.label}.round-${String(receipts.length).padStart(3, '0')}.receipt.json` : null });
  }
  return receipts;
}
export function createCapacityClone(parent: string, label: string, seed: string): CapacityClone {
  if (realpathSync(parent) !== parent || !/^[a-z0-9-]{1,64}$/u.test(label)) throw new Error('容量clone父目录或label无效');
  const info = lstatSync(seed); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('种子不是独占普通文件');
  checkCapacitySpace(parent, info.size * 3 + 64 * 1024 ** 2);
  const directory = path.join(parent, label); mkdirSync(directory);
  const marker = { id: randomUUID(), scope: 'musicbridge-capacity-clone-only', label };
  durableJson(path.join(directory, 'owner.json'), marker);
  const filePath = path.join(directory, 'sample.sqlite'); copyFileSync(seed, filePath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const stat = lstatSync(directory), parentStat = lstatSync(parent);
  return { parent, label, directory, filePath, marker, device: stat.dev, inode: stat.ino, parentDevice: parentStat.dev, parentInode: parentStat.ino };
}
export function finishCapacityClone(clone: CapacityClone, result: { outcome: CapacitySample['outcome']; resourcesClosed: boolean; samples: unknown;
  onPhase?: (phase: 'final-hash' | 'cleanup', details: unknown) => void }): string {
  const check = () => {
    if (!result.resourcesClosed || realpathSync(clone.parent) !== clone.parent || realpathSync(clone.directory) !== clone.directory || path.dirname(clone.directory) !== clone.parent || path.basename(clone.directory) !== clone.label) throw new Error('容量clone未关闭或路径身份变化');
    const info = lstatSync(clone.directory), parentInfo = lstatSync(clone.parent);
    if (info.dev !== clone.device || info.ino !== clone.inode || parentInfo.dev !== clone.parentDevice || parentInfo.ino !== clone.parentInode) throw new Error('容量clone目录身份变化');
    assert.deepEqual(JSON.parse(readFileSync(path.join(clone.directory, 'owner.json'), 'utf8')), clone.marker);
    for (const name of readdirSync(clone.directory)) if (!['owner.json', 'sample.sqlite', 'sample.sqlite-wal', 'sample.sqlite-shm', 'sample.sqlite-journal'].includes(name) || !lstatSync(path.join(clone.directory, name)).isFile() || lstatSync(path.join(clone.directory, name)).isSymbolicLink()) throw new Error('容量clone包含非预期对象');
  };
  check();
  const receipt = path.join(clone.parent, `${clone.label}.receipt.json`);
  const sqliteSha256 = hashCapacityFile(clone.filePath), retained = result.outcome !== 'ok';
  const { onPhase, ...receiptResult } = result;
  durableJson(receipt, { ...receiptResult, marker: clone.marker, sqliteSha256, retained });
  onPhase?.('final-hash', { receipt: path.basename(receipt), sqliteSha256, retained });
  if (result.outcome === 'ok') {
    check(); // 持久receipt完成后再复核，失败/超时永不删。
    // cleanup事实也必须先持久化；此后只做删除，避免“已删clone但阶段receipt写失败”。
    onPhase?.('cleanup', { receipt: path.basename(receipt), retained: false, action: 'delete-after-stage' });
    for (const name of readdirSync(clone.directory)) unlinkSync(path.join(clone.directory, name));
    rmdirSync(clone.directory);
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
