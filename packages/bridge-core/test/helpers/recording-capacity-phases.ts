import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { readBackupIndex } from '../../src/recording/backup-index.js';
import { createArchiveBackup, verifyArchiveBackup } from '../../src/recording/backup-package.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { assertCapacitySpace, capacityProfile, createCapacityClone, finishCapacityClone, hashCapacityFile, type CapacityClone } from './recording-capacity-fixture.js';
import { isCapacityRequestId, runCapacityCold, runCapacityPrintWrite, runCapacityQueuedStop, runCapacityRecovery, type CapacityProcessResult, type CapacityPrintWriteReceipt, type CapacityQueuedStopReceipt } from './recording-capacity-process.js';

export const CAPACITY_PHASE_REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const CAPACITY_PHASE_LIMITS = { executionMs: 50_000, killGraceMs: 1_000, closeMs: 2_000, minimumFreeBytes: 10 * 1024 ** 3, maximumOwnedBytes: 16 * 1024 ** 3 } as const;
export type CapacityPhaseName = 'prepare-backup' | 'cold' | 'full-recovery' | 'queued-stop' | 'print-write';
export type CapacityPhaseProfile = 'history-small' | 'objects-small' | 'history-limit' | 'objects-limit' | 'joint';
const capacityPhaseProfiles: readonly CapacityPhaseProfile[] = ['history-small','objects-small','history-limit','objects-limit','joint'];
const smallPhaseProfiles: readonly CapacityPhaseProfile[] = ['history-small','objects-small'];
const queuedStopProfiles: readonly CapacityPhaseProfile[] = ['objects-small','history-limit','objects-limit','joint'];
export interface CapacityPhaseEffectiveOperationLimits {
  executionMs: number; killGraceMs: number; closeMs: number; admissionReserveMs: number;
}
export function capacityPhaseEffectiveOperationLimits(phase: CapacityPhaseName): CapacityPhaseEffectiveOperationLimits {
  const executionMs = phase === 'print-write' ? 25_000 : CAPACITY_PHASE_LIMITS.executionMs;
  const killGraceMs = CAPACITY_PHASE_LIMITS.killGraceMs, closeMs = CAPACITY_PHASE_LIMITS.closeMs;
  return { executionMs, killGraceMs, closeMs, admissionReserveMs: executionMs + killGraceMs + closeMs };
}
export interface CapacityPhaseArguments {
  phase: CapacityPhaseName; profile: CapacityPhaseProfile; label: string; seedLabel: string;
  windowPath: string; windowSha256: string; ownedRootsPath: string; ownedRootsSha256: string; backupLabel?: string;
}
export interface CapacityPhaseWindow {
  schemaVersion: 1; scope: 'musicbridge-capacity-phase-window'; owner: 'root'; id: string; state: 'approved';
  phase: CapacityPhaseName; profile: CapacityPhaseProfile; label: string; seed: { label: string; metadataSha256: string; snapshotSha256: string };
  n: 10 | 105; issuedAt: string; deadlineAt: string; limits: typeof CAPACITY_PHASE_LIMITS;
  ownedManifest: { file: 'owned-roots.json'; sha256: string }; sourceManifest: { file: 'source-pins.json'; sha256: string };
  backup?: { label: string; outputDirectory: string; receiptSha256: string };
}
export interface CapacityOwnedRoot {
  path: string; device: number; inode: number;
  marker: { relative: 'owner.json' | 'capacity-owner.json' | 'seed.json' | 'command.json' | 'r020-owner.json'; sha256: string };
}
export interface CapacityOwnedManifest {
  schemaVersion: 1; scope: 'musicbridge-capacity-owned-roots'; access: 'count-only'; windowId: string; roots: CapacityOwnedRoot[];
}
export interface CapacitySourceManifest { schemaVersion: 1; scope: 'musicbridge-capacity-source-pins'; files: Record<string, string> }
interface Seed { schema: number; profile: string; fixtureDirectory: string; snapshotSha256: string; marker: { id: string; scope: string }; nextPlanId: string; nextPlanHash: string; integrity: string; growth?: { state: string }; axes?: unknown }
export interface CapacityBackupInfo {
  id: string; backupPath: string; manifestHash: string; databaseSha256: string; databaseBytes: number;
  objectCount: number; objectBytes: number; manifestBytes: number; protectedRootPaths: string[]; preparationMs: number;
}
interface BackupReceipt extends CapacityBackupInfo {
  schemaVersion: 1; kind: 'capacity-full-backup'; state: 'verified'; mode: 'archive-content'; contentIncluded: true;
  seedLabel: string; seedSha256: string; profile: CapacityPhaseProfile; sourceManifestSha256: string;
}
interface PreparationInput { clone: CapacityClone; seed: Seed; seedDirectory: string; output: string; signal: AbortSignal; checkSpace: (planned: number) => unknown }
export interface CapacityPhaseOptions {
  /** 仅自然测试构造器可替换；CLI不读取任何等价环境开关。 */
  runtimeRoot?: string; now?: () => number; availableBytes?: (directory: string) => number;
  cold?: typeof runCapacityCold; queuedStop?: typeof runCapacityQueuedStop; printWrite?: typeof runCapacityPrintWrite; recovery?: typeof runCapacityRecovery;
  prepare?: (input: PreparationInput) => Promise<CapacityBackupInfo>;
}
export interface CapacityPhaseSummary {
  phase: CapacityPhaseName; profile: CapacityPhaseProfile; state: 'passed' | 'prepared' | 'failed' | 'incomplete';
  planned: 10 | 105; attempted: number; successes: number; failures: number; timeouts: number; unrun: number;
  minMs: number | null; medianMs: number | null; maxMs: number | null; p99: null;
  queuedStop?: CapacityQueuedStopSummary;
  printWrite?: CapacityPrintWriteSummary;
  failure?: string; deviceOpened: false; formalReady: false; gateB: 'NOT_RUN';
}
interface CapacityDistribution { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
interface CapacityMaxMetric extends CapacityDistribution { limitMax: number; passed: boolean }
interface CapacityDualMetric extends CapacityDistribution { limitP95: number; limitMax: number; passed: boolean }
export interface CapacityQueuedStopSummary {
  counts: { warmup: 5; formal: 100 };
  childProgressMs: CapacityDualMetric;
  stopReceivedToAbortMs: CapacityMaxMetric;
  stopReceivedToDriverStopInvokedMs: CapacityMaxMetric;
  stopReceivedToDriverStopAckMs: CapacityDistribution;
  stopReceivedToReceiptMs: CapacityDualMetric;
  parentSendStopToReceiptMs: CapacityMaxMetric;
  parentReceiptToChildCloseMs: CapacityDistribution;
  driverCloseInvokedMs: CapacityDistribution;
  driverCloseResolvedMs: CapacityMaxMetric;
  passed: boolean;
}
interface CapacityFormalMaxMetric extends CapacityDistribution { limitMax: 2000; passed: boolean | null }
export interface CapacityPrintWriteSummary {
  mode: 'pilot' | 'formal'; counts: { pilot: 10; warmup: 0; formal: 0 } | { pilot: 0; warmup: 5; formal: 100 };
  claimMs: CapacityFormalMaxMetric; completeMs: CapacityFormalMaxMetric; passed: boolean | null;
}
function invalid(code: string): never { throw new Error(`CAPACITY_PHASE_${code}`); }
const failCodes = ['INVALID_INPUT','WINDOW_INVALID','INVENTORY_INVALID','SOURCE_CHANGED','SEED_INVALID','BACKUP_INVALID','SPACE','DEADLINE','OPERATION_FAILED','PERSISTENCE_FAILED','THRESHOLD_FAILED'];
export const capacityPhaseFailureCode = (error: unknown): string => error instanceof Error && failCodes.some(code => error.message === `CAPACITY_PHASE_${code}`) ? error.message : 'CAPACITY_PHASE_OPERATION_FAILED';
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const label = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,64}$/u.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const inside = (parent: string, child: string) => parent === child || child.startsWith(parent + path.sep);
function exact(v: unknown, keys: string): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(','); }
const jointAxisKeys = 'attemptEvents,attemptBytes,recordBytes,printBytes,photoBytes,printObjectBytes';
function validJointAxes(v: unknown): boolean {
  if (!exact(v, 'targets,actual,reached') || !exact(v.targets, jointAxisKeys) || !exact(v.actual, jointAxisKeys) || !exact(v.reached, jointAxisKeys)) return false;
  const profile = capacityProfile('joint'), targets = { attemptEvents: profile.progressEvents, attemptBytes: profile.attemptBytes,
    recordBytes: profile.recordBytes, printBytes: profile.printBytes, photoBytes: profile.photoBytes, printObjectBytes: profile.printObjectBytes };
  return JSON.stringify(v.targets) === JSON.stringify(targets)
    && Object.entries(v.actual).every(([key, value]) => integer(value) && value >= targets[key as keyof typeof targets])
    && Object.values(v.reached).every(value => value === true);
}
function canonical(directory: string): void { if (!path.isAbsolute(directory) || realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) invalid('INVALID_INPUT'); }
function json(file: string, expected?: string, maximum = 2 * 1024 ** 2): unknown {
  const before = hashCapacityFile(file); if (expected && before !== expected) invalid('INVALID_INPUT');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let result: unknown;
  try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > maximum) invalid('INVALID_INPUT'); result = JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
  if (hashCapacityFile(file) !== before) invalid('INVALID_INPUT'); return result;
}
function syncDirectory(directory: string): void { const fd = openSync(directory, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durable(file: string, value: unknown): void {
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function raw(file: string, value: unknown): void {
  const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(path.dirname(file));
}
const pinFiles = ['package.json','pnpm-lock.yaml','packages/bridge-core/package.json','packages/contracts/package.json',
  'packages/bridge-core/test/benchmarks/recording-capacity.ts','packages/bridge-core/test/benchmarks/recording-capacity-process.ts'];
/** 包括真实运行加载的Core、测试helpers和合同dist，不以Git HEAD代替未提交文件身份。 */
export function capacityPhaseSourcePins(): CapacitySourceManifest {
  const names = [...pinFiles];
  function walk(relative: string, suffix: string) {
    for (const name of readdirSync(path.join(CAPACITY_PHASE_REPO_ROOT, relative)).sort()) {
      const file = path.join(relative, name), info = lstatSync(path.join(CAPACITY_PHASE_REPO_ROOT, file));
      if (info.isSymbolicLink()) invalid('SOURCE_CHANGED');
      if (info.isDirectory()) walk(file, suffix); else if (info.isFile() && name.endsWith(suffix)) names.push(file);
      if (names.length > 2048) invalid('SOURCE_CHANGED');
    }
  }
  walk('packages/bridge-core/src', '.ts'); walk('packages/bridge-core/test/helpers', '.ts'); walk('packages/contracts/src', '.ts'); walk('packages/contracts/dist', '.js');
  return { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: Object.fromEntries(names.sort().map(file => [file, hashCapacityFile(path.join(CAPACITY_PHASE_REPO_ROOT, file))])) };
}
export function parseCapacityPhaseArguments(argv: string[]): CapacityPhaseArguments {
  const map: Record<string, string> = {}, keys = ['phase','profile','label','seed-label','window','window-sha256','owned-roots','owned-roots-sha256','backup-label'];
  if (argv.length % 2) invalid('INVALID_INPUT');
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!.slice(2), value = argv[i + 1]!;
    if (!argv[i]!.startsWith('--') || !keys.includes(key) || key in map || !value) invalid('INVALID_INPUT'); map[key] = value;
  }
  const result = { phase: map.phase, profile: map.profile, label: map.label, seedLabel: map['seed-label'], windowPath: map.window,
    windowSha256: map['window-sha256'], ownedRootsPath: map['owned-roots'], ownedRootsSha256: map['owned-roots-sha256'], ...(map['backup-label'] ? { backupLabel: map['backup-label'] } : {}) };
  if (!validArguments(result)) invalid('INVALID_INPUT'); return result;
}
function validArguments(v: unknown): v is CapacityPhaseArguments {
  return exact(v, 'phase,profile,label,seedLabel,windowPath,windowSha256,ownedRootsPath,ownedRootsSha256' + (v && typeof v === 'object' && 'backupLabel' in v ? ',backupLabel' : ''))
    && ['prepare-backup','cold','full-recovery','queued-stop','print-write'].includes(String(v.phase)) && capacityPhaseProfiles.includes(v.profile as CapacityPhaseProfile)
    && typeof v.phase === 'string' && typeof v.profile === 'string' && label(v.label) && label(v.seedLabel) && typeof v.windowPath === 'string' && path.isAbsolute(v.windowPath)
    && typeof v.ownedRootsPath === 'string' && path.isAbsolute(v.ownedRootsPath) && sha(v.windowSha256) && sha(v.ownedRootsSha256)
    && (v.phase === 'queued-stop' ? queuedStopProfiles.includes(v.profile as CapacityPhaseProfile)
      : v.phase === 'print-write' ? v.profile === 'objects-small' : smallPhaseProfiles.includes(v.profile as CapacityPhaseProfile))
    && (v.phase === 'full-recovery' ? label(v.backupLabel) : v.backupLabel === undefined);
}
function validWindow(v: unknown): v is CapacityPhaseWindow {
  if (!exact(v, 'schemaVersion,scope,owner,id,state,phase,profile,label,seed,n,issuedAt,deadlineAt,limits,ownedManifest,sourceManifest' + (v && typeof v === 'object' && 'backup' in v ? ',backup' : ''))) return false;
  return v.schemaVersion === 1 && v.scope === 'musicbridge-capacity-phase-window' && v.owner === 'root' && isCapacityRequestId(v.id) && v.state === 'approved'
    && capacityPhaseProfiles.includes(v.profile as CapacityPhaseProfile)
    && ((v.phase === 'queued-stop' && queuedStopProfiles.includes(v.profile as CapacityPhaseProfile) && v.n === 105)
      || (v.phase === 'print-write' && v.profile === 'objects-small' && (v.n === 10 || v.n === 105))
      || (['prepare-backup','cold','full-recovery'].includes(String(v.phase)) && smallPhaseProfiles.includes(v.profile as CapacityPhaseProfile) && v.n === 10))
    && typeof v.issuedAt === 'string' && typeof v.deadlineAt === 'string' && exact(v.limits, Object.keys(CAPACITY_PHASE_LIMITS).join(','))
    && Object.entries(CAPACITY_PHASE_LIMITS).every(([key, value]) => (v.limits as Record<string, unknown>)[key] === value)
    && exact(v.seed, 'label,metadataSha256,snapshotSha256') && label(v.seed.label) && sha(v.seed.metadataSha256) && sha(v.seed.snapshotSha256)
    && exact(v.ownedManifest, 'file,sha256') && v.ownedManifest.file === 'owned-roots.json' && sha(v.ownedManifest.sha256)
    && exact(v.sourceManifest, 'file,sha256') && v.sourceManifest.file === 'source-pins.json' && sha(v.sourceManifest.sha256)
    && (v.phase === 'full-recovery' ? exact(v.backup, 'label,outputDirectory,receiptSha256') && label(v.backup.label) && typeof v.backup.outputDirectory === 'string' && sha(v.backup.receiptSha256) : v.backup === undefined);
}
function validInventory(v: unknown, windowId: string): v is CapacityOwnedManifest {
  return exact(v, 'schemaVersion,scope,access,windowId,roots') && v.schemaVersion === 1 && v.scope === 'musicbridge-capacity-owned-roots' && v.access === 'count-only' && v.windowId === windowId
    && Array.isArray(v.roots) && v.roots.length > 0 && v.roots.length <= 64 && v.roots.every(r => exact(r, 'path,device,inode,marker') && typeof r.path === 'string' && integer(r.device) && integer(r.inode)
      && exact(r.marker, 'relative,sha256') && ['owner.json','capacity-owner.json','seed.json','command.json','r020-owner.json'].includes(String(r.marker.relative)) && typeof r.marker.relative === 'string' && sha(r.marker.sha256));
}
function validBackup(v: unknown): v is BackupReceipt {
  return exact(v, 'id,backupPath,manifestHash,databaseSha256,databaseBytes,objectCount,objectBytes,manifestBytes,protectedRootPaths,preparationMs,schemaVersion,kind,state,mode,contentIncluded,seedLabel,seedSha256,profile,sourceManifestSha256')
    && v.schemaVersion === 1 && v.kind === 'capacity-full-backup' && v.state === 'verified' && v.mode === 'archive-content' && v.contentIncluded === true
    && isCapacityRequestId(v.id) && typeof v.backupPath === 'string' && path.isAbsolute(v.backupPath) && sha(v.manifestHash) && sha(v.databaseSha256) && sha(v.seedSha256) && sha(v.sourceManifestSha256)
    && [v.databaseBytes,v.objectCount,v.objectBytes,v.manifestBytes].every(integer) && Number(v.databaseBytes) > 0 && typeof v.preparationMs === 'number' && Number.isFinite(v.preparationMs) && v.preparationMs >= 0
    && Array.isArray(v.protectedRootPaths) && v.protectedRootPaths.length > 0 && v.protectedRootPaths.length <= 32 && v.protectedRootPaths.every(p => typeof p === 'string' && path.isAbsolute(p));
}
function minimalRoots(roots: string[]): string[] { return [...new Set(roots)].sort().filter(root => !roots.some(other => other !== root && inside(other, root))); }
async function prepareBackup(input: PreparationInput): Promise<CapacityBackupInfo> {
  const started = performance.now(), { clone, seed, signal } = input;
  const db = new DatabaseSync(clone.filePath, { readOnly: true, allowExtension: false });
  try { db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;'); if (db.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress' LIMIT 1").get()) invalid('SEED_INVALID'); } finally { db.close(); }
  const repository = createCollectionRepository({ filePath: clone.filePath });
  try {
    if (repository.recordingPlans.version({ id: seed.nextPlanId }).plan?.contentHash !== seed.nextPlanHash) invalid('SEED_INVALID');
    const roots = [...repository.sources.roots(), ...repository.preparations.destinations(), ...repository.archive.candidates().map(c => c.parent),
      ...repository.archive.operations().flatMap(op => op.owned ? [op.owned.archive.root] : [])].map(r => r.path);
    for (const p of roots) { canonical(p); if (!inside(seed.fixtureDirectory, p)) invalid('SEED_INVALID'); }
    // scratch clone随后会被安全清理，不能把它作为恢复时必须存在的历史保护根持久化。
    const protectedRootPaths = minimalRoots([...roots, seed.fixtureDirectory, input.seedDirectory]);
    if (protectedRootPaths.length > 32) invalid('SEED_INVALID');
    const { index } = readBackupIndex(clone.filePath), objectBytes = index.objects.reduce((n, o) => n + o.size, 0), manifestBytes = index.operations.reduce((n, o) => n + o.manifestSize, 0);
    if (index.incompleteOperationIds.length) invalid('BACKUP_INVALID');
    input.checkSpace(3 * lstatSync(clone.filePath).size + objectBytes + manifestBytes + 64 * 1024 ** 2);
    const target = path.join(input.output, 'backup'); mkdirSync(target); syncDirectory(input.output);
    const destination = { ...await authorizeSourceDirectory(target), id: randomUUID() };
    for (const p of [...protectedRootPaths, clone.directory]) if (inside(p, target) || inside(target, p)) invalid('BACKUP_INVALID');
    const result = await createArchiveBackup({ repository, destination, id: randomUUID(), mode: 'archive-content', userConfirmed: true, signal });
    const verified = await verifyArchiveBackup(result.directory, signal);
    if (verified.mode !== 'archive-content' || !verified.contentIncluded || verified.incompleteOperationIds.length || verified.id !== result.manifest.id) invalid('BACKUP_INVALID');
    return { id: verified.id, backupPath: result.directory.path, manifestHash: hashCapacityFile(path.join(result.directory.path, 'Backup.json')),
      databaseSha256: verified.database.sha256, databaseBytes: verified.database.size, objectCount: verified.objects.length,
      objectBytes: verified.objects.reduce((n, o) => n + o.size, 0), manifestBytes: verified.operations.reduce((n, o) => n + o.manifestSize, 0), protectedRootPaths,
      preparationMs: performance.now() - started };
  } finally { repository.close(); }
}

interface QueueMeasurement {
  childProgressMs: number; stopReceivedToAbortMs: number; stopReceivedToDriverStopInvokedMs: number;
  stopReceivedToDriverStopAckMs: number; stopReceivedToReceiptMs: number; parentSendStopToReceiptMs: number;
  parentReceiptToChildCloseMs: number; driverCloseInvokedMs: number; driverCloseResolvedMs: number;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function queuedStopMeasurement(result: CapacityProcessResult, planId: string, planHash: string): QueueMeasurement | undefined {
  const receipt = result.result;
  if (result.outcome !== 'ok' || !result.closed || result.code !== 0 || result.signal !== null || result.phase !== 'exited'
    || result.cleanup.termSent || result.cleanup.killSent || !Number.isSafeInteger(result.childPid) || result.childPid! <= 0 || result.childPid === process.pid
    || result.processGroup?.managed !== true || result.processGroup.pgid !== result.childPid || result.processGroup.groupEmpty !== true
    || result.timings.clock !== 'parent-relative' || !finite(result.timings.sendStopToReceiptMs) || !finite(result.timings.receiptToChildCloseMs)
    || receipt?.kind !== 'queue' || receipt.planId !== planId || receipt.planHash !== planHash) return undefined;
  const q = receipt as CapacityQueuedStopReceipt;
  if (!isCapacityRequestId(q.attemptId) || q.order.length !== 2 || q.order[0] !== 'progress' || q.order[1] !== 'stop' || q.progressFrames !== 1
    || !q.abortObserved || !q.driverStopInvoked || !q.driverStopAcknowledged || !q.driverCloseInvoked || !q.driverCloseResolved
    || q.clock !== 'child-relative' || q.deviceOpened || q.formalReady || q.gateB !== 'NOT_RUN'
    || ![q.fullAuditMs, q.beginMs, q.progressMs, q.stopReceivedToAbortMs, q.stopReceivedToDriverStopInvokedMs, q.stopReceivedToDriverStopAckMs,
      q.stopReceivedToReceiptMs, q.stopReceivedToDriverCloseInvokedMs, q.stopReceivedToDriverCloseResolvedMs, q.childMeasuredMs].every(finite)
    || q.stopReceivedToAbortMs > q.stopReceivedToDriverStopInvokedMs || q.stopReceivedToDriverStopInvokedMs > q.stopReceivedToDriverStopAckMs
    || q.stopReceivedToDriverStopAckMs > q.stopReceivedToReceiptMs || q.stopReceivedToReceiptMs > q.stopReceivedToDriverCloseInvokedMs
    || q.stopReceivedToDriverCloseInvokedMs > q.stopReceivedToDriverCloseResolvedMs || q.stopReceivedToDriverCloseResolvedMs > q.childMeasuredMs) return undefined;
  return { childProgressMs: q.progressMs, stopReceivedToAbortMs: q.stopReceivedToAbortMs,
    stopReceivedToDriverStopInvokedMs: q.stopReceivedToDriverStopInvokedMs, stopReceivedToDriverStopAckMs: q.stopReceivedToDriverStopAckMs,
    stopReceivedToReceiptMs: q.stopReceivedToReceiptMs, parentSendStopToReceiptMs: result.timings.sendStopToReceiptMs,
    parentReceiptToChildCloseMs: result.timings.receiptToChildCloseMs, driverCloseInvokedMs: q.stopReceivedToDriverCloseInvokedMs,
    driverCloseResolvedMs: q.stopReceivedToDriverCloseResolvedMs };
}
function distribution(values: number[]): CapacityDistribution {
  const sorted = [...values].sort((a, b) => a - b), rank = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return { n: sorted.length, p50: rank(.5), p95: rank(.95), p99: rank(.99), max: sorted.at(-1) ?? null };
}
function maxMetric(values: number[], limitMax: number): CapacityMaxMetric {
  const metric = distribution(values); return { ...metric, limitMax, passed: metric.n === 100 && metric.max !== null && metric.max <= limitMax };
}
function dualMetric(values: number[], limitP95: number, limitMax: number): CapacityDualMetric {
  const metric = distribution(values); return { ...metric, limitP95, limitMax,
    passed: metric.n === 100 && metric.p95 !== null && metric.p95 <= limitP95 && metric.max !== null && metric.max <= limitMax };
}
function queuedStopSummary(values: QueueMeasurement[]): CapacityQueuedStopSummary {
  const field = <K extends keyof QueueMeasurement>(key: K) => values.map(value => value[key]);
  const summary: CapacityQueuedStopSummary = { counts: { warmup: 5, formal: 100 },
    childProgressMs: dualMetric(field('childProgressMs'), 50, 100),
    stopReceivedToAbortMs: maxMetric(field('stopReceivedToAbortMs'), 100),
    stopReceivedToDriverStopInvokedMs: maxMetric(field('stopReceivedToDriverStopInvokedMs'), 100),
    stopReceivedToDriverStopAckMs: distribution(field('stopReceivedToDriverStopAckMs')),
    stopReceivedToReceiptMs: dualMetric(field('stopReceivedToReceiptMs'), 500, 2_000),
    parentSendStopToReceiptMs: maxMetric(field('parentSendStopToReceiptMs'), 2_000),
    parentReceiptToChildCloseMs: distribution(field('parentReceiptToChildCloseMs')),
    driverCloseInvokedMs: distribution(field('driverCloseInvokedMs')),
    driverCloseResolvedMs: maxMetric(field('driverCloseResolvedMs'), 250), passed: false };
  summary.passed = summary.childProgressMs.passed && summary.stopReceivedToAbortMs.passed && summary.stopReceivedToDriverStopInvokedMs.passed
    && summary.stopReceivedToReceiptMs.passed && summary.parentSendStopToReceiptMs.passed && summary.driverCloseResolvedMs.passed;
  return summary;
}
interface PrintWriteMeasurement { claimMs: number; completeMs: number }
function printWriteMeasurement(result: CapacityProcessResult, planId: string, planHash: string): PrintWriteMeasurement | undefined {
  const receipt = result.result;
  if (result.outcome !== 'ok' || !result.closed || result.code !== 0 || result.signal !== null || result.phase !== 'exited'
    || result.cleanup.termSent || result.cleanup.killSent || !Number.isSafeInteger(result.childPid) || result.childPid! <= 0 || result.childPid === process.pid
    || result.processGroup?.managed !== true || result.processGroup.pgid !== result.childPid || result.processGroup.groupEmpty !== true || result.processGroup.zombies.length
    || receipt?.kind !== 'print-write' || receipt.planId !== planId || receipt.planHash !== planHash
    || Buffer.byteLength(JSON.stringify(receipt)) > 16_384 || /base64|data:image/u.test(JSON.stringify(receipt))) return undefined;
  const r = receipt as CapacityPrintWriteReceipt;
  if (![r.attemptId,r.recordingId,r.jobId,r.requestId,r.lease.leaseId,r.lease.workerId,r.artifact.id].every(isCapacityRequestId)
    || !sha(r.inputHash) || r.events.length !== 3 || r.events.some((event, index) => event.revision !== index + 1 || event.kind !== ['create','claim','complete'][index])
    || r.lease.jobId !== r.jobId || r.lease.requestId !== r.requestId || r.lease.inputHash !== r.inputHash
    || r.job.id !== r.jobId || r.job.requestId !== r.requestId || r.job.inputHash !== r.inputHash || r.job.state !== 'ready' || r.job.revision !== 3 || r.job.artifactId !== r.artifact.id
    || r.artifact.requestId !== r.requestId || r.artifact.recordingId !== r.recordingId || r.artifact.inputHash !== r.inputHash
    || !sha(r.artifact.pdfSha256) || !sha(r.artifact.previewSha256) || !integer(r.artifact.size) || !integer(r.artifact.previewSize) || r.artifact.pageCount !== 1
    || r.completeReceipt.id !== `lease:${r.lease.leaseId}` || r.completeReceipt.kind !== 'complete' || !sha(r.completeReceipt.fingerprint)
    || r.pdf.sha256 !== r.artifact.pdfSha256 || r.pdf.size !== r.artifact.size || r.pdf.mime !== 'application/pdf' || r.pdf.width !== null || r.pdf.height !== null
    || r.preview.sha256 !== r.artifact.previewSha256 || r.preview.size !== r.artifact.previewSize || r.preview.mime !== 'image/jpeg' || r.preview.width !== 1 || r.preview.height !== 1
    || !r.idempotent || ![r.claimMs,r.completeMs,r.childMeasuredMs].every(finite) || r.claimMs + r.completeMs > r.childMeasuredMs + 1) return undefined;
  return { claimMs: r.claimMs, completeMs: r.completeMs };
}
function printWriteSummary(values: PrintWriteMeasurement[], formal: boolean): CapacityPrintWriteSummary {
  const metric = (field: keyof PrintWriteMeasurement): CapacityFormalMaxMetric => {
    const value = distribution(values.map(item => item[field]));
    return { ...value, limitMax: 2000, passed: formal ? value.n === 100 && value.max !== null && value.max <= 2000 : null };
  };
  const claimMs = metric('claimMs'), completeMs = metric('completeMs');
  return { mode: formal ? 'formal' : 'pilot', counts: formal ? { pilot: 0, warmup: 5, formal: 100 } : { pilot: 10, warmup: 0, formal: 0 },
    claimMs, completeMs, passed: formal ? claimMs.passed === true && completeMs.passed === true : null };
}

export async function runCapacityPhase(args: CapacityPhaseArguments, options: CapacityPhaseOptions = {}): Promise<CapacityPhaseSummary> {
  if (!validArguments(args)) invalid('INVALID_INPUT');
  const runtime = options.runtimeRoot ?? path.join(CAPACITY_PHASE_REPO_ROOT, 'reports/runtime/task-078-v3-acceptance'), now = options.now ?? Date.now;
  canonical(runtime); const windowRoot = path.dirname(args.windowPath); canonical(windowRoot);
  if (path.dirname(windowRoot) !== runtime || !label(path.basename(windowRoot)) || path.basename(args.windowPath) !== 'window.json') invalid('WINDOW_INVALID');
  const windowValue = json(args.windowPath, args.windowSha256); if (!validWindow(windowValue)) invalid('WINDOW_INVALID'); const w = windowValue;
  if (w.phase !== args.phase || w.profile !== args.profile || w.label !== args.label || w.seed.label !== args.seedLabel || w.backup?.label !== args.backupLabel
    || args.ownedRootsPath !== path.join(windowRoot, 'owned-roots.json') || args.ownedRootsSha256 !== w.ownedManifest.sha256) invalid('WINDOW_INVALID');
  const ownerPath = path.join(windowRoot, 'owner.json'), owner = json(ownerPath), ownerSha = hashCapacityFile(ownerPath), rootIdentity = lstatSync(windowRoot);
  if (!exact(owner, 'scope,owner,id') || owner.scope !== w.scope || owner.owner !== 'root' || owner.id !== w.id) invalid('WINDOW_INVALID');
  const issued = Date.parse(w.issuedAt), deadline = Date.parse(w.deadlineAt);
  if (!Number.isFinite(issued) || !Number.isFinite(deadline) || new Date(issued).toISOString() !== w.issuedAt || new Date(deadline).toISOString() !== w.deadlineAt
    || issued > now() || deadline <= issued || deadline - issued > 900_000
    || (w.phase === 'queued-stop' || w.phase === 'print-write' && w.n === 105) && deadline - issued !== 900_000) invalid('WINDOW_INVALID');
  function windowCheck(minimum = 0) {
    if (now() + minimum >= deadline) invalid('DEADLINE');
    const s = lstatSync(windowRoot); if (s.dev !== rootIdentity.dev || s.ino !== rootIdentity.ino || hashCapacityFile(ownerPath) !== ownerSha || hashCapacityFile(args.windowPath) !== args.windowSha256) invalid('WINDOW_INVALID');
  }
  const effectiveOperationLimits = capacityPhaseEffectiveOperationLimits(args.phase);
  windowCheck(effectiveOperationLimits.admissionReserveMs);
  const inventoryValue = json(args.ownedRootsPath, args.ownedRootsSha256); if (!validInventory(inventoryValue, w.id)) invalid('INVENTORY_INVALID'); const inventory = inventoryValue;
  const sourcePath = path.join(windowRoot, 'source-pins.json'), source = json(sourcePath, w.sourceManifest.sha256);
  if (!exact(source, 'schemaVersion,scope,files') || source.schemaVersion !== 1 || source.scope !== 'musicbridge-capacity-source-pins' || !source.files || typeof source.files !== 'object' || Array.isArray(source.files)) invalid('SOURCE_CHANGED');
  const sourceFiles = source.files as Record<string, unknown>;
  function sourceCheck() {
    if (hashCapacityFile(sourcePath) !== w.sourceManifest.sha256 || JSON.stringify(Object.entries(sourceFiles).sort()) !== JSON.stringify(Object.entries(capacityPhaseSourcePins().files).sort())) invalid('SOURCE_CHANGED');
  }
  sourceCheck();
  const seedDirectory = path.join(runtime, args.seedLabel); canonical(seedDirectory);
  const seedPath = path.join(seedDirectory, 'seed.sqlite'), metadataPath = path.join(seedDirectory, 'seed.json');
  const seed = json(metadataPath, w.seed.metadataSha256) as Seed;
  const largeQueued = args.phase === 'queued-stop' && args.profile !== 'objects-small';
  if (!seed || seed.schema !== 21 || seed.profile !== args.profile || seed.integrity !== 'passed'
    || (largeQueued ? seed.growth?.state !== 'target-reached' : seed.growth && seed.growth.state !== 'target-reached')
    || (args.profile === 'joint' && !validJointAxes(seed.axes))
    || !isCapacityRequestId(seed.nextPlanId) || !sha(seed.nextPlanHash) || seed.snapshotSha256 !== w.seed.snapshotSha256 || hashCapacityFile(seedPath) !== w.seed.snapshotSha256
    || typeof seed.fixtureDirectory !== 'string' || !/^musicbridge-version-[A-Za-z0-9]+$/u.test(path.basename(seed.fixtureDirectory))) invalid('SEED_INVALID');
  canonical(seed.fixtureDirectory);
  if (!exact(seed.marker, 'id,scope') || !isCapacityRequestId(seed.marker.id) || seed.marker.scope !== 'musicbridge-capacity-synthetic-only'
    || JSON.stringify(json(path.join(seed.fixtureDirectory, 'capacity-owner.json'))) !== JSON.stringify(seed.marker)
    || ['-wal','-shm','-journal'].some(suffix => existsSync(seedPath + suffix))) invalid('SEED_INVALID');
  const tempRoot = realpathSync(os.tmpdir()), seen = new Set<string>();
  for (const r of inventory.roots) {
    canonical(r.path); if (seen.has(r.path)) invalid('INVENTORY_INVALID'); seen.add(r.path);
    const inRuntime = inside(runtime, r.path) && r.path !== runtime;
    const fixture = path.dirname(r.path) === tempRoot && /^musicbridge-version-[A-Za-z0-9]+$/u.test(path.basename(r.path));
    const appClone = path.dirname(r.path) === tempRoot && /^musicbridge-ui-diagnostics-r021-[A-Za-z0-9]{6}$/u.test(path.basename(r.path));
    if (!inRuntime && !(fixture && r.marker.relative === 'capacity-owner.json') && !(appClone && r.marker.relative === 'r020-owner.json')) invalid('INVENTORY_INVALID');
  }
  const covered = (p: string) => inventory.roots.some(r => inside(r.path, p));
  if (!seen.has(windowRoot) || !covered(seedDirectory) || !covered(seed.fixtureDirectory)) invalid('INVENTORY_INVALID');
  let backupReceipt: BackupReceipt | undefined;
  if (w.backup) {
    canonical(w.backup.outputDirectory);
    if (!inside(runtime, w.backup.outputDirectory) || path.basename(w.backup.outputDirectory) !== args.backupLabel || !covered(w.backup.outputDirectory)) invalid('BACKUP_INVALID');
    const value = json(path.join(w.backup.outputDirectory, 'backup-receipt.json'), w.backup.receiptSha256); if (!validBackup(value)) invalid('BACKUP_INVALID'); backupReceipt = value;
    if (value.seedLabel !== args.seedLabel || value.seedSha256 !== w.seed.snapshotSha256 || value.profile !== args.profile || !inside(w.backup.outputDirectory, value.backupPath)
      || hashCapacityFile(path.join(value.backupPath, 'Backup.json')) !== value.manifestHash) invalid('BACKUP_INVALID');
  }
  function seedCheck() { if (hashCapacityFile(metadataPath) !== w.seed.metadataSha256 || hashCapacityFile(seedPath) !== w.seed.snapshotSha256) invalid('SEED_INVALID'); }
  function ownedBytes(): number {
    windowCheck(); if (hashCapacityFile(args.ownedRootsPath) !== args.ownedRootsSha256) invalid('INVENTORY_INVALID');
    for (const r of inventory.roots) { canonical(r.path); const s = lstatSync(r.path); if (s.dev !== r.device || s.ino !== r.inode || hashCapacityFile(path.join(r.path, r.marker.relative)) !== r.marker.sha256) invalid('INVENTORY_INVALID'); }
    let entries = 0;
    function size(directory: string, depth: number): number {
      if (++entries > 200_000 || depth > 32) invalid('INVENTORY_INVALID'); windowCheck();
      const s = lstatSync(directory); if (s.isSymbolicLink()) invalid('INVENTORY_INVALID');
      if (s.isFile()) return s.size; if (!s.isDirectory()) invalid('INVENTORY_INVALID');
      let total = 0; for (const name of readdirSync(directory)) { total += size(path.join(directory, name), depth + 1); if (!integer(total) || total > CAPACITY_PHASE_LIMITS.maximumOwnedBytes) invalid('SPACE'); } return total;
    }
    return minimalRoots(inventory.roots.map(r => r.path)).reduce((total, root) => total + size(root, 0), 0);
  }
  function space(planned: number) {
    const owned = ownedBytes(), stat = options.availableBytes ? undefined : statfsSync(windowRoot, { bigint: true });
    const available = options.availableBytes ? options.availableBytes(windowRoot) : Number(stat!.bavail * stat!.bsize);
    try { assertCapacitySpace({ availableBytes: available, plannedBytes: planned, ownedBytes: owned }); } catch { invalid('SPACE'); }
    return { availableBytes: available, plannedBytes: planned, ownedBytes: owned };
  }
  const planned = args.phase === 'queued-stop' ? 105 : args.phase === 'print-write' ? w.n : 10;
  const d = lstatSync(seedPath).size, restoreBound = backupReceipt ? 3 * backupReceipt.databaseBytes + backupReceipt.objectBytes + backupReceipt.manifestBytes + 64 * 1024 ** 2 : 0;
  const initialSpace = space(args.phase === 'full-recovery' ? 10 * restoreBound : 3 * d + 64 * 1024 ** 2);
  const output = path.join(windowRoot, args.label); mkdirSync(output); syncDirectory(windowRoot);
  durable(path.join(output, 'owner.json'), { scope: 'musicbridge-capacity-phase-output', id: randomUUID(), windowId: w.id, label: args.label });
  durable(path.join(output, 'input.json'), { args, windowId: w.id, seedSha256: w.seed.snapshotSha256, sourceManifestSha256: w.sourceManifest.sha256, initialSpace,
    effectiveOperationLimits,
    classification: 'software-only/exclusive-window', cache: 'OS cache未清；复制和hash已触页，不是物理冷盘', n: planned,
    ...(args.phase === 'queued-stop' ? { warmup: 5, formalSamples: 100, clocks: 'parent与child分栏，不跨进程相减', backend: 'private-immediate-fake' } : {}),
    ...(args.phase === 'print-write' ? { mode: planned === 10 ? 'pilot' : 'formal', pilotSamples: planned === 10 ? 10 : 0, warmup: planned === 105 ? 5 : 0,
      formalSamples: planned === 105 ? 100 : 0, claimLimitMaxMs: 2000, completeLimitMaxMs: 2000, backend: 'private-immediate-fake' } : {}),
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' });
  const rows: { outcome: string; durationMs: number }[] = [], queueMeasurements: QueueMeasurement[] = [], printMeasurements: PrintWriteMeasurement[] = [], childPids = new Set<number>(); let failure: string | undefined, prepared = false;
  try {
    if (args.phase === 'prepare-backup') {
      const clone = createCapacityClone(output, 'backup-source', seedPath), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - now()));
      let closed = false;
      try {
        const info = await (options.prepare ?? prepareBackup)({ clone, seed, seedDirectory, output, signal: controller.signal, checkSpace: space }); closed = true; windowCheck(); sourceCheck(); seedCheck();
        const receipt: BackupReceipt = { ...info, schemaVersion: 1, kind: 'capacity-full-backup', state: 'verified', mode: 'archive-content', contentIncluded: true,
          seedLabel: args.seedLabel, seedSha256: w.seed.snapshotSha256, profile: args.profile, sourceManifestSha256: w.sourceManifest.sha256 };
        if (!validBackup(receipt) || receipt.protectedRootPaths.some(p => inside(clone.directory, p) || !existsSync(p))) invalid('BACKUP_INVALID');
        raw(path.join(output, 'samples.jsonl'), { phase: args.phase, outcome: 'ok', receipt }); durable(path.join(output, 'backup-receipt.json'), receipt);
        finishCapacityClone(clone, { outcome: 'ok', resourcesClosed: true, samples: [receipt] }); prepared = true;
      } catch (error) {
        // 已知关闭仍失败也保留clone；未知关闭绝不调用删除路径。
        raw(path.join(output, 'samples.jsonl'), { phase: args.phase, outcome: 'failed', failure: capacityPhaseFailureCode(error), resourcesClosed: closed }); throw error;
      } finally { clearTimeout(timer); }
    } else {
      const recoveryOwner = { root: path.join(output, 'restores'), id: randomUUID() };
      if (args.phase === 'full-recovery') { mkdirSync(recoveryOwner.root); durable(path.join(recoveryOwner.root, 'owner.json'), { id: recoveryOwner.id, scope: 'musicbridge-capacity-recovery-only' }); }
      for (let index = 1; index <= planned; ++index) {
        windowCheck(effectiveOperationLimits.admissionReserveMs); seedCheck(); const beforeSpace = space(args.phase === 'full-recovery' ? (11 - index) * restoreBound : 3 * d + 64 * 1024 ** 2);
        const name = `sample-${String(index).padStart(args.phase === 'queued-stop' || args.phase === 'print-write' ? 3 : 2, '0')}`, preparedAt = performance.now(); let clone: CapacityClone | undefined, destinationPath: string | undefined;
        if (args.phase === 'cold' || args.phase === 'queued-stop' || args.phase === 'print-write') clone = createCapacityClone(output, name, seedPath);
        else { destinationPath = path.join(recoveryOwner.root, name); mkdirSync(destinationPath); syncDirectory(recoveryOwner.root); }
        durable(path.join(output, `${name}-intent.json`), { index, phase: args.phase, profile: args.profile, windowId: w.id, seedSha256: w.seed.snapshotSha256, state: 'operation-not-yet-returned' });
        const preparationMs = performance.now() - preparedAt, operationStarted = performance.now();
        let result: CapacityProcessResult;
        try {
          result = args.phase === 'cold'
            ? await (options.cold ?? runCapacityCold)({ clone: clone!, planId: seed.nextPlanId, planHash: seed.nextPlanHash })
            : args.phase === 'queued-stop'
              ? await (options.queuedStop ?? runCapacityQueuedStop)({ clone: clone!, planId: seed.nextPlanId, planHash: seed.nextPlanHash })
              : args.phase === 'print-write'
                ? await (options.printWrite ?? runCapacityPrintWrite)({ clone: clone!, planId: seed.nextPlanId, planHash: seed.nextPlanHash }, {
                    executionTimeoutMs: effectiveOperationLimits.executionMs, killGraceMs: effectiveOperationLimits.killGraceMs, closeTimeoutMs: effectiveOperationLimits.closeMs,
                  })
              : await (options.recovery ?? runCapacityRecovery)({ backupPath: backupReceipt!.backupPath, destinationPath: destinationPath!, expected: { id: backupReceipt!.id, manifestHash: backupReceipt!.manifestHash },
                protectedRootPaths: minimalRoots([...backupReceipt!.protectedRootPaths, seed.fixtureDirectory, seedDirectory, w.backup!.outputDirectory]), owner: recoveryOwner });
        } catch {
          const durationMs = performance.now() - operationStarted;
          rows.push({ outcome: 'failed', durationMs });
          const row = { index, phase: args.phase, profile: args.profile, preparationMs, outcome: 'failed', failure: 'CAPACITY_PHASE_OPERATION_FAILED', childIdentity: 'unknown', resourcesClosed: false, durationMs, beforeSpace };
          raw(path.join(output, 'samples.jsonl'), row); durable(path.join(output, `${name}.json`), row); invalid('OPERATION_FAILED');
        }
        let identityFailure: string | undefined;
        // 子进程关闭后、发布成功或清理clone前复核本次样本的完整输入身份。
        try { windowCheck(); sourceCheck(); seedCheck(); } catch (error) { identityFailure = capacityPhaseFailureCode(error); }
        const queueMeasurement = args.phase === 'queued-stop' ? queuedStopMeasurement(result, seed.nextPlanId, seed.nextPlanHash) : undefined;
        const printMeasurement = args.phase === 'print-write' ? printWriteMeasurement(result, seed.nextPlanId, seed.nextPlanHash) : undefined;
        const ok = !identityFailure && result.outcome === 'ok' && result.closed && result.code === 0 && result.signal === null && Number.isFinite(result.forkToCloseMs) && result.forkToCloseMs >= 0 && result.forkToCloseMs <= effectiveOperationLimits.executionMs
          && !result.cleanup.termSent && !result.cleanup.killSent
          && Number.isSafeInteger(result.childPid) && result.childPid! > 0 && result.childPid !== process.pid && !childPids.has(result.childPid!)
          && (args.phase === 'queued-stop' ? !!queueMeasurement : args.phase === 'print-write' ? !!printMeasurement : result.result?.kind === (args.phase === 'cold' ? 'cold' : 'restore'));
        if (result.childPid !== null) childPids.add(result.childPid);
        const outcome = ok ? 'ok' : result.outcome === 'timeout' ? 'timeout' : 'failed'; rows.push({ outcome, durationMs: result.forkToCloseMs });
        const facts = { ...result }; if (!ok) delete facts.result;
        const row = { index, phase: args.phase, profile: args.profile, ...(args.phase === 'queued-stop' ? { warmup: index <= 5 } : {}),
          ...(args.phase === 'print-write' ? { sampleClass: planned === 10 ? 'pilot' : index <= 5 ? 'warmup' : 'formal' } : {}), preparationMs, outcome, result: facts, beforeSpace,
          ...(identityFailure ? { failure: identityFailure } : {}) };
        try {
          if (args.phase === 'queued-stop' || args.phase === 'print-write') {
            const receiptPath = path.join(output, `${name}-raw-receipt.json`); durable(receiptPath, result);
            durable(path.join(output, `${name}-raw-receipt.sha256.json`), { sha256: hashCapacityFile(receiptPath) });
          }
          raw(path.join(output, 'samples.jsonl'), row); durable(path.join(output, `${name}.json`), row);
        } catch { invalid('PERSISTENCE_FAILED'); }
        if (identityFailure) throw new Error(identityFailure);
        if (queueMeasurement && index > 5) queueMeasurements.push(queueMeasurement);
        if (printMeasurement && (planned === 10 || index > 5)) printMeasurements.push(printMeasurement);
        const retentionSpace = space(args.phase === 'full-recovery' ? (10 - index) * restoreBound : 0);
        try {
          durable(path.join(output, `${name}-retention.json`), { retained: args.phase === 'full-recovery' || outcome !== 'ok', resourcesClosed: result.closed, space: retentionSpace });
        } catch { invalid('PERSISTENCE_FAILED'); }
        // retention 与空间证据先落盘；其后才允许清理成功 clone，任何碰撞或 fsync 失败都保留现场。
        if (clone && result.closed) finishCapacityClone(clone, { outcome, resourcesClosed: true, samples: [result] });
        if (!ok) invalid('OPERATION_FAILED');
      }
    }
    windowCheck(); sourceCheck(); seedCheck(); space(0);
  } catch (error) { failure = capacityPhaseFailureCode(error); }
  const queueSummary = args.phase === 'queued-stop' ? queuedStopSummary(queueMeasurements) : undefined;
  const printSummary = args.phase === 'print-write' ? printWriteSummary(printMeasurements, planned === 105) : undefined;
  if (!failure && queueSummary && !queueSummary.passed) failure = 'CAPACITY_PHASE_THRESHOLD_FAILED';
  if (!failure && printSummary?.passed === false) failure = 'CAPACITY_PHASE_THRESHOLD_FAILED';
  const values = rows.filter(r => r.outcome === 'ok').map(r => r.durationMs).sort((a,b) => a-b), attempts = rows.length;
  const summary: CapacityPhaseSummary = { phase: args.phase, profile: args.profile,
    state: failure ? attempts < planned && args.phase !== 'prepare-backup' ? 'incomplete' : 'failed' : prepared ? 'prepared' : attempts === planned ? 'passed' : 'incomplete',
    planned, attempted: attempts, successes: values.length, failures: rows.filter(r => r.outcome === 'failed').length, timeouts: rows.filter(r => r.outcome === 'timeout').length,
    unrun: args.phase === 'prepare-backup' ? 10 : planned - attempts, minMs: values[0] ?? null, medianMs: values.length ? (values[Math.floor((values.length - 1) / 2)]! + values[Math.ceil((values.length - 1) / 2)]!) / 2 : null,
    maxMs: values.at(-1) ?? null, p99: null, ...(queueSummary ? { queuedStop: queueSummary } : {}), ...(printSummary ? { printWrite: printSummary } : {}), ...(failure ? { failure } : {}), deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
  durable(path.join(output, 'summary.json'), summary); durable(path.join(output, 'exit.json'), { exit: summary.state === 'passed' || summary.state === 'prepared' ? 0 : 1 });
  return summary;
}
