import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statfsSync, writeFileSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { readBackupIndex } from '../../src/recording/backup-index.js';
import { createArchiveBackup, verifyArchiveBackup } from '../../src/recording/backup-package.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { assertCapacitySpace, capacityDirectoryBytes, capacityGenerationPlan, capacityMeasureWorkingBytes, capacityProfile, createCapacityClone,
  createCapacityQueuedStopAggregateGuard, finishCapacityClone, hashCapacityFile, type CapacityClone,
  type CapacityMeasureAggregateGuard } from './recording-capacity-fixture.js';
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
  schemaVersion: 1; scope: 'musicbridge-capacity-phase-window' | 'musicbridge-capacity-queued-stop-window'; owner: 'root'; id: string; state: 'approved';
  phase: CapacityPhaseName; profile: CapacityPhaseProfile; label: string; seedLabel?: string;
  issuerFailureCarryoverCount?: number;
  prechildFailureCarryoverCount?: number;
  processFailureCarryoverCount?: number;
  seed: { label: string; metadataSha256: string; snapshotSha256: string; fixtureOwnerSha256?: string };
  n: 10 | 105; issuedAt: string; deadlineAt: string; limits: typeof CAPACITY_PHASE_LIMITS;
  ownedManifest: { file: 'owned-roots.json'; sha256: string }; sourceManifest: { file: 'source-pins.json'; sha256: string };
  backup?: { label: string; outputDirectory: string; receiptSha256: string };
  queuedStopPlan?: { warmupCount: 5; formalCount: 100; sampleCount: 105; activeCloneMaximum: 1;
    snapshotBytes: number; evidenceAllowanceBytes: number; plannedBytes: number;
    model: 'serial-single-clone-plus-bounded-growth-v1'; aggregateAudit: 'queued-stop-aggregate-budget.jsonl' };
  supervisor?: { path: string; sha256: string };
  candidateRepository?: { root: string; branch: string; head: string };
  toolchain?: { node: { path: string; sha256: string }; tsxLoader: { path: string; sha256: string };
    consumerPython: { path: string; sha256: string } };
  issuer?: { path: string; sha256: string; fact: { path: string; sha256: string } };
  measureCarryover?: unknown;
}
export interface CapacityOwnedRoot {
  path: string; device: number; inode: number;
  marker: { relative: 'owner.json' | 'capacity-owner.json' | 'seed.json' | 'command.json' | 'r020-owner.json'; sha256: string };
}
export interface CapacityOwnedManifest {
  schemaVersion: 1; scope: 'musicbridge-capacity-owned-roots'; access: 'count-only'; windowId: string; roots: CapacityOwnedRoot[];
}
export interface CapacitySourceManifest { schemaVersion: 1; scope: 'musicbridge-capacity-source-pins'; files: Record<string, string> }
interface Seed { schema: number; profile: string; fixtureDirectory: string; snapshotSha256: string; marker: { id: string; scope: string }; nextPlanId: string; nextPlanHash: string; integrity: string; growth?: { state: string }; axes?: unknown; generationPlan?: unknown }
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
const utcMillisecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|\+00:00)$/u;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}(?:Z|\+00:00)$/u;
function utcInstant(value: unknown, millisecondsOnly: boolean): number | undefined {
  if (typeof value !== 'string' || !(millisecondsOnly ? utcMillisecondPattern : utcTimestampPattern).test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = value.replace(/\+00:00$/u, 'Z');
  if (millisecondsOnly && new Date(parsed).toISOString() !== normalized) return undefined;
  return parsed;
}
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
function validJointGenerationPlan(v: unknown): boolean {
  if (!exact(v, 'model,activeOutputMaximum,finalAxisBytes,activeOutputBytes,activeRecordWorkspaceBytes,evidenceAllowanceBytes,plannedBytes')) return false;
  return Object.entries(capacityGenerationPlan(capacityProfile('joint'))).every(([key, value]) => v[key] === value);
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
  'packages/contracts/capacity-process-failure-lineage-v1.json','scripts/ci/capacity_process_failure_lineage.py',
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

interface ProcessFailureLineageContract {
  schemaVersion: 1; scope: 'musicbridge-capacity-process-failure-lineage-contract'; failure: 'PROCESS_EXIT';
  maximumReachableDepth: number; exactDirectHeadCount: 1; ordering: 'head-to-leaf';
  fieldSemantics: { processFailureCarryoverCount: 'directHeadCount'; processFailureCount: 'predecessorReachableDepth' };
  verdicts: string[];
}
interface ProcessFailureLineageNode {
  id: string; predecessorIds: string[]; predecessorRootIdentities: string[];
  issuedAt: string; deadlineAt: string; closedAt: string; pid: number; pgid: number;
  supervisionPid: number; closePid: number; rootIdentity: string; authorityReachableDepth: number | null;
}
export interface ProcessFailureLineageCase { directRootIds: string[]; nodes: ProcessFailureLineageNode[] }
export interface ProcessFailureLineageResult {
  verdict: string; directHeadCount: number; reachableDepth: number; orderedDirectRoots: string[];
  billingRoots: string[]; failure: string | null;
}
export function evaluateProcessFailureLineage(value: ProcessFailureLineageCase, contract: ProcessFailureLineageContract): ProcessFailureLineageResult {
  const direct = value.directRootIds, byId = new Map(value.nodes.map(node => [node.id, node]));
  const result = (billingRoots: string[], failure: string | null): ProcessFailureLineageResult => ({
    verdict: failure ?? 'PASS', directHeadCount: direct.length, reachableDepth: billingRoots.length,
    orderedDirectRoots: direct, billingRoots, failure,
  });
  if (direct.length !== contract.exactDirectHeadCount) return result([], 'DIRECT_HEAD_COUNT');
  const billing: string[] = [], seen = new Set<string>(); let currentId = direct[0]!;
  for (;;) {
    if (seen.has(currentId)) return result(billing, 'CYCLE');
    const node = byId.get(currentId); if (!node) return result(billing, 'ORPHAN');
    seen.add(currentId); billing.push(currentId);
    if (billing.length > contract.maximumReachableDepth) return result(billing, 'DEPTH_LIMIT');
    if (node.predecessorIds.length > 1) return result(billing, 'FORK');
    if (!node.predecessorIds.length) break;
    currentId = node.predecessorIds[0]!;
  }
  const instant = (text: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text) ? Date.parse(text) : Number.NaN;
  for (const [index, id] of billing.entries()) {
    const node = byId.get(id)!;
    const issued = instant(node.issuedAt), deadline = instant(node.deadlineAt), closed = instant(node.closedAt);
    if (![issued, deadline, closed].every(Number.isFinite) || issued > closed || closed > deadline) return result(billing, 'TIME_ORDER');
    if (!Number.isSafeInteger(node.pid) || node.pid <= 0
      || [node.pgid,node.supervisionPid,node.closePid].some(pid => pid !== node.pid)) return result(billing, 'PID_MISMATCH');
    if (node.predecessorRootIdentities.length !== node.predecessorIds.length) return result(billing, 'IDENTITY_MISMATCH');
    if (node.predecessorIds.length) {
      const predecessor = byId.get(node.predecessorIds[0]!); if (!predecessor) return result(billing, 'ORPHAN');
      if (node.predecessorRootIdentities[0] !== predecessor.rootIdentity) return result(billing, 'IDENTITY_MISMATCH');
      if (instant(predecessor.closedAt) > issued) return result(billing, 'TIME_ORDER');
      if (node.authorityReachableDepth !== billing.length - index - 1) return result(billing, 'AUTHORITY_DEPTH_MISMATCH');
    } else if (node.authorityReachableDepth !== null) return result(billing, 'AUTHORITY_DEPTH_MISMATCH');
  }
  return result(billing, null);
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
  const successor = !!v && typeof v === 'object' && !Array.isArray(v)
    && (v as { scope?: unknown }).scope === 'musicbridge-capacity-queued-stop-window';
  const jointSuccessor = successor && (v as { profile?: unknown }).profile === 'joint';
  const keys = successor
    ? 'schemaVersion,scope,owner,id,state,phase,profile,label,seedLabel,seed,n,'
      + (jointSuccessor ? '' : 'issuerFailureCarryoverCount,prechildFailureCarryoverCount,processFailureCarryoverCount,')
      + 'issuedAt,deadlineAt,limits,ownedManifest,sourceManifest,queuedStopPlan,supervisor,candidateRepository,toolchain,issuer,measureCarryover'
    : 'schemaVersion,scope,owner,id,state,phase,profile,label,seed,n,issuedAt,deadlineAt,limits,ownedManifest,sourceManifest' + (v && typeof v === 'object' && 'backup' in v ? ',backup' : '');
  if (!exact(v, keys)) return false;
  const seedKeys = successor ? 'label,metadataSha256,snapshotSha256,fixtureOwnerSha256' : 'label,metadataSha256,snapshotSha256';
  const plan = v.queuedStopPlan, supervisor = v.supervisor, candidate = v.candidateRepository;
  const toolchain = v.toolchain, issuer = v.issuer;
  const carryover = v.measureCarryover as Record<string, unknown> | undefined;
  const bound = (value: unknown, extra = '') => exact(value, `path,sha256${extra}`)
    && typeof value.path === 'string' && path.isAbsolute(value.path) && sha(value.sha256);
  const carryoverValid = !successor || exact(carryover, jointSuccessor
    ? 'window,close,ownedManifest,sourceManifest,supervision,supervisor,output'
    : 'window,close,ownedManifest,sourceManifest,supervision,supervisor,output,measureRootRecovery')
    && bound(carryover.window, ',id') && isCapacityRequestId((carryover.window as Record<string, unknown>).id)
    && bound(carryover.close) && bound(carryover.ownedManifest) && bound(carryover.sourceManifest)
    && bound(carryover.supervision) && bound(carryover.supervisor)
    && (jointSuccessor || bound(carryover.measureRootRecovery))
    && exact(carryover.output, 'path,label,commandSha256') && typeof carryover.output.path === 'string'
    && path.isAbsolute(carryover.output.path) && label(carryover.output.label) && sha(carryover.output.commandSha256);
  return v.schemaVersion === 1 && (successor || v.scope === 'musicbridge-capacity-phase-window') && v.owner === 'root' && isCapacityRequestId(v.id) && v.state === 'approved'
    && capacityPhaseProfiles.includes(v.profile as CapacityPhaseProfile)
    && ((v.phase === 'queued-stop' && queuedStopProfiles.includes(v.profile as CapacityPhaseProfile) && v.n === 105)
      || (v.phase === 'print-write' && v.profile === 'objects-small' && (v.n === 10 || v.n === 105))
      || (['prepare-backup','cold','full-recovery'].includes(String(v.phase)) && smallPhaseProfiles.includes(v.profile as CapacityPhaseProfile) && v.n === 10))
    && typeof v.issuedAt === 'string' && typeof v.deadlineAt === 'string' && exact(v.limits, Object.keys(CAPACITY_PHASE_LIMITS).join(','))
    && Object.entries(CAPACITY_PHASE_LIMITS).every(([key, value]) => (v.limits as Record<string, unknown>)[key] === value)
    && exact(v.seed, seedKeys) && label(v.seed.label) && sha(v.seed.metadataSha256) && sha(v.seed.snapshotSha256)
    && exact(v.ownedManifest, 'file,sha256') && v.ownedManifest.file === 'owned-roots.json' && sha(v.ownedManifest.sha256)
    && exact(v.sourceManifest, 'file,sha256') && v.sourceManifest.file === 'source-pins.json' && sha(v.sourceManifest.sha256)
    && (v.phase === 'full-recovery' ? exact(v.backup, 'label,outputDirectory,receiptSha256') && label(v.backup.label) && typeof v.backup.outputDirectory === 'string' && sha(v.backup.receiptSha256) : v.backup === undefined)
    && (!successor || v.phase === 'queued-stop' && (v.profile === 'objects-limit' || v.profile === 'joint') && v.seedLabel === v.seed.label
      && (jointSuccessor || integer(v.issuerFailureCarryoverCount) && v.issuerFailureCarryoverCount >= 1
        && v.issuerFailureCarryoverCount <= 64
        && integer(v.prechildFailureCarryoverCount) && v.prechildFailureCarryoverCount >= 1
        && v.prechildFailureCarryoverCount <= 64
        && v.processFailureCarryoverCount === 1)
      && sha(v.seed.fixtureOwnerSha256) && exact(plan, 'warmupCount,formalCount,sampleCount,activeCloneMaximum,snapshotBytes,evidenceAllowanceBytes,plannedBytes,model,aggregateAudit')
      && plan.warmupCount === 5 && plan.formalCount === 100 && plan.sampleCount === 105 && plan.activeCloneMaximum === 1
      && integer(plan.snapshotBytes) && plan.snapshotBytes > 0 && plan.evidenceAllowanceBytes === 256 * 1024 ** 2
      && plan.plannedBytes === plan.snapshotBytes + plan.evidenceAllowanceBytes
      && plan.model === 'serial-single-clone-plus-bounded-growth-v1' && plan.aggregateAudit === 'queued-stop-aggregate-budget.jsonl'
      && exact(supervisor, 'path,sha256') && typeof supervisor.path === 'string' && path.isAbsolute(supervisor.path) && sha(supervisor.sha256)
      && exact(candidate, 'root,branch,head') && typeof candidate.root === 'string' && path.isAbsolute(candidate.root)
      && typeof candidate.branch === 'string' && candidate.branch.length > 0 && candidate.branch.length <= 255
      && typeof candidate.head === 'string' && /^[a-f0-9]{40}$/u.test(candidate.head)
      && exact(toolchain, 'node,tsxLoader,consumerPython') && bound(toolchain.node) && bound(toolchain.tsxLoader) && bound(toolchain.consumerPython)
      && exact(issuer, 'path,sha256,fact') && typeof issuer.path === 'string' && path.isAbsolute(issuer.path) && sha(issuer.sha256)
      && bound(issuer.fact) && carryoverValid);
}
function validInventory(v: unknown, windowId: string, exactRootCount?: number): v is CapacityOwnedManifest {
  return exact(v, 'schemaVersion,scope,access,windowId,roots') && v.schemaVersion === 1 && v.scope === 'musicbridge-capacity-owned-roots' && v.access === 'count-only' && v.windowId === windowId
    && Array.isArray(v.roots) && (exactRootCount === undefined ? v.roots.length > 0 && v.roots.length <= 64 : v.roots.length === exactRootCount)
    && v.roots.every(r => exact(r, 'path,device,inode,marker') && typeof r.path === 'string' && integer(r.device) && integer(r.inode)
      && exact(r.marker, 'relative,sha256') && ['owner.json','capacity-owner.json','seed.json','command.json','r020-owner.json'].includes(String(r.marker.relative)) && typeof r.marker.relative === 'string' && sha(r.marker.sha256));
}

function missingPath(value: string): boolean {
  try { lstatSync(value); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

interface RecoveryRootRow { path: string; device: number; inode: number; marker: { relative: string; sha256: string } }
interface RecoveryReplacementRoot extends RecoveryRootRow { role: 'historical-control-only' }
interface RecoveryMapping { historicalRoot: RecoveryRootRow; state: 'LOST'; recovered: false; replacementRoot: RecoveryReplacementRoot }
interface RootRecoveryReceipt {
  mappings: RecoveryMapping[]; activeBenchmarkInput: { model: 'durable-seed-snapshot'; path: string; sha256: string };
  liveDeviceRemap: { mode: 'UNCHANGED' | 'REMAPPED'; historicalDevice: number; currentDevice: number; liveRootCount: number };
  liveRootRemap?: { mode: 'PREFIX_RELOCATION'; historicalRuntime: string; currentRuntime: string; liveRootCount: number;
    mappings: Array<{ historicalRoot: RecoveryRootRow; currentRoot: RecoveryRootRow }> };
}
const recoveryToolRelative = 'scripts/ci/create-v3-capacity-measure-root-recovery.py';
const recoveryHistoricalRootCount = 70, recoveryLostRootCount = 7, recoveryLiveRootCount = 63;

function validRecoveryRoot(value: unknown, replacement: false): value is RecoveryRootRow;
function validRecoveryRoot(value: unknown, replacement: true): value is RecoveryReplacementRoot;
function validRecoveryRoot(value: unknown, replacement: boolean): value is RecoveryRootRow | RecoveryReplacementRoot {
  const keys = replacement ? 'path,device,inode,marker,role' : 'path,device,inode,marker';
  if (!exact(value, keys) || typeof value.path !== 'string' || !path.isAbsolute(value.path)
    || path.normalize(value.path) !== value.path
    || !integer(value.device) || !integer(value.inode) || !exact(value.marker, 'relative,sha256')
    || !sha(value.marker.sha256)) return false;
  return replacement
    ? value.role === 'historical-control-only' && value.marker.relative === 'owner.json'
    : value.marker.relative === 'capacity-owner.json';
}

function validRelocationRoot(value: unknown): value is RecoveryRootRow {
  return exact(value, 'path,device,inode,marker') && typeof value.path === 'string'
    && path.isAbsolute(value.path) && path.normalize(value.path) === value.path
    && integer(value.device) && integer(value.inode) && exact(value.marker, 'relative,sha256')
    && typeof value.marker.relative === 'string'
    && ['owner.json','capacity-owner.json','seed.json','command.json','r020-owner.json'].includes(value.marker.relative)
    && sha(value.marker.sha256);
}

function directRegularFile(file: string): boolean {
  try { const info = lstatSync(file); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1; }
  catch { return false; }
}

function stableRecoveryRoot(root: RecoveryRootRow, expectedDevice: number): void {
  canonical(root.path);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const directoryFd = openSync(root.path, flags);
  try {
    const before = fstatSync(directoryFd), namedBefore = lstatSync(root.path);
    type DirectoryIdentity = { dev: number; ino: number; mode: number; nlink: number; mtimeMs: number; ctimeMs: number };
    const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity) =>
      left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
      && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
    if (!before.isDirectory() || before.dev !== expectedDevice || before.ino !== root.inode
      || !sameDirectory(before, namedBefore)) invalid('INVENTORY_INVALID');
    const markerPath = path.join(root.path, root.marker.relative);
    const markerFd = openSync(markerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const markerBefore = fstatSync(markerFd);
      if (!markerBefore.isFile() || markerBefore.nlink !== 1 || markerBefore.size > 8 * 1024 ** 2) invalid('INVENTORY_INVALID');
      const bytes = readFileSync(markerFd), markerAfter = fstatSync(markerFd), markerNamed = lstatSync(markerPath);
      if (markerBefore.dev !== markerAfter.dev || markerBefore.ino !== markerAfter.ino
        || markerBefore.size !== markerAfter.size || markerAfter.dev !== markerNamed.dev
        || markerAfter.ino !== markerNamed.ino || markerAfter.size !== markerNamed.size
        || markerAfter.mtimeMs !== markerNamed.mtimeMs || markerAfter.ctimeMs !== markerNamed.ctimeMs
        || markerAfter.nlink !== markerNamed.nlink
        || createHash('sha256').update(bytes).digest('hex') !== root.marker.sha256) invalid('INVENTORY_INVALID');
    } finally { closeSync(markerFd); }
    const after = fstatSync(directoryFd), namedAfter = lstatSync(root.path);
    canonical(root.path);
    if (!sameDirectory(before, after) || !sameDirectory(after, namedAfter)) invalid('INVENTORY_INVALID');
  } finally { closeSync(directoryFd); }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
}

function gitText(root: string, args: string[]): string {
  try { return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', env: gitEnvironment(), timeout: 15_000, maxBuffer: 4 * 1024 ** 2,
    stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { invalid('WINDOW_INVALID'); }
}

function gitRawText(root: string, args: string[]): string {
  try { return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', env: gitEnvironment(), timeout: 15_000, maxBuffer: 4 * 1024 ** 2,
    stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { invalid('WINDOW_INVALID'); }
}

function gitBytes(root: string, args: string[]): Buffer {
  try { return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'buffer', env: gitEnvironment(), timeout: 15_000, maxBuffer: 4 * 1024 ** 2,
    stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { invalid('WINDOW_INVALID'); }
}

function sameRecoveryRow(left: RecoveryRootRow, right: RecoveryRootRow): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface SuccessorRecoveryValidation { check: () => void; processRoots: string[] }
function successorRecoveryValidator(window: CapacityPhaseWindow, runtime: string, windowRoot: string, seedPath: string, seed: Seed,
  inventory: CapacityOwnedManifest): SuccessorRecoveryValidation {
  const carryover = window.measureCarryover as Record<string, Record<string, unknown>>;
  const binding = carryover.measureRootRecovery!, receiptPath = String(binding.path), recoveryRoot = path.dirname(receiptPath);
  if (path.dirname(recoveryRoot) !== runtime || path.basename(receiptPath) !== 'recovery.json'
    || !directRegularFile(receiptPath) || (lstatSync(recoveryRoot).mode & 0o777) !== 0o700
    || (lstatSync(receiptPath).mode & 0o777) !== 0o400) invalid('WINDOW_INVALID');
  const receiptValue = json(receiptPath, String(binding.sha256));
  const relocationReceipt = typeof receiptValue === 'object' && receiptValue !== null
    && (receiptValue as Record<string, unknown>).model === 'exact75-v3-runtime-relocation-closure';
  const keys = `schemaVersion,scope,access,state,model,windowId,historicalManifest,repository,recoveryTool,mappings,activeBenchmarkInput,liveDeviceRemap${relocationReceipt ? ',liveRootRemap' : ''},contentRecovered,historicalManifestRewritten,deviceOpened,formalReady,gateB`;
  if (!exact(receiptValue, keys) || receiptValue.schemaVersion !== 1 || receiptValue.scope !== 'musicbridge-capacity-measure-root-recovery'
    || receiptValue.access !== 'read-only' || receiptValue.state !== 'PUBLISHED'
    || !['exact75-v2-replacement-closure','exact75-v3-runtime-relocation-closure'].includes(String(receiptValue.model))
    || receiptValue.windowId !== carryover.window!.id
    || !exact(receiptValue.historicalManifest, 'path,sha256')
    || receiptValue.historicalManifest.path !== carryover.ownedManifest!.path
    || receiptValue.historicalManifest.sha256 !== carryover.ownedManifest!.sha256
    || hashCapacityFile(String(receiptValue.historicalManifest.path)) !== receiptValue.historicalManifest.sha256
    || !exact(receiptValue.repository, 'root,branch,head,clean,pushedHead')
    || receiptValue.repository.root !== window.candidateRepository?.root || receiptValue.repository.branch !== window.candidateRepository?.branch
    || receiptValue.repository.head !== window.candidateRepository?.head || receiptValue.repository.clean !== true || receiptValue.repository.pushedHead !== true
    || !exact(receiptValue.recoveryTool, 'path,relativePath,workingSha256,gitBlobSha256')
    || receiptValue.recoveryTool.relativePath !== recoveryToolRelative
    || receiptValue.recoveryTool.path !== path.join(String(receiptValue.repository.root), String(receiptValue.recoveryTool.relativePath))
    || !sha(receiptValue.recoveryTool.workingSha256) || receiptValue.recoveryTool.workingSha256 !== receiptValue.recoveryTool.gitBlobSha256
    || hashCapacityFile(String(receiptValue.recoveryTool.path)) !== receiptValue.recoveryTool.workingSha256
    || !exact(receiptValue.activeBenchmarkInput, 'model,path,sha256')
    || receiptValue.activeBenchmarkInput.model !== 'durable-seed-snapshot' || receiptValue.activeBenchmarkInput.path !== seedPath
    || receiptValue.activeBenchmarkInput.sha256 !== window.seed.snapshotSha256
    || !exact(receiptValue.liveDeviceRemap, 'mode,historicalDevice,currentDevice,liveRootCount')
    || !['UNCHANGED', 'REMAPPED'].includes(String(receiptValue.liveDeviceRemap.mode))
    || !integer(receiptValue.liveDeviceRemap.historicalDevice) || !integer(receiptValue.liveDeviceRemap.currentDevice)
    || receiptValue.liveDeviceRemap.liveRootCount !== recoveryLiveRootCount
    || (receiptValue.liveDeviceRemap.mode === 'UNCHANGED') !== (receiptValue.liveDeviceRemap.historicalDevice === receiptValue.liveDeviceRemap.currentDevice)
    || lstatSync(runtime).dev !== receiptValue.liveDeviceRemap.currentDevice
    || receiptValue.contentRecovered !== false || receiptValue.historicalManifestRewritten !== false
    || receiptValue.deviceOpened !== false || receiptValue.formalReady !== false || receiptValue.gateB !== 'NOT_RUN'
    || !Array.isArray(receiptValue.mappings) || receiptValue.mappings.length !== 7) invalid('WINDOW_INVALID');
  const receipt = receiptValue as unknown as RootRecoveryReceipt;
  const remap = receipt.liveDeviceRemap;
  const rootRelocation = receipt.liveRootRemap;
  const relocationByHistorical = new Map<string, { historicalRoot: RecoveryRootRow; currentRoot: RecoveryRootRow }>();
  if (relocationReceipt) {
    if (!exact(rootRelocation, 'mode,historicalRuntime,currentRuntime,liveRootCount,mappings')
      || rootRelocation.mode !== 'PREFIX_RELOCATION' || rootRelocation.currentRuntime !== runtime
      || rootRelocation.historicalRuntime === runtime || !path.isAbsolute(rootRelocation.historicalRuntime)
      || path.normalize(rootRelocation.historicalRuntime) !== rootRelocation.historicalRuntime
      || rootRelocation.liveRootCount !== recoveryLiveRootCount || !Array.isArray(rootRelocation.mappings)
      || rootRelocation.mappings.length !== recoveryLiveRootCount) invalid('WINDOW_INVALID');
    for (const value of rootRelocation.mappings) {
      if (!exact(value, 'historicalRoot,currentRoot') || !validRelocationRoot(value.historicalRoot)
        || !validRelocationRoot(value.currentRoot)) invalid('WINDOW_INVALID');
      const relative = path.relative(rootRelocation.historicalRuntime, value.historicalRoot.path);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || path.join(runtime, relative) !== value.currentRoot.path
        || value.historicalRoot.marker.sha256 !== value.currentRoot.marker.sha256
        || relocationByHistorical.has(value.historicalRoot.path)) invalid('WINDOW_INVALID');
      stableRecoveryRoot(value.currentRoot, remap.currentDevice);
      relocationByHistorical.set(value.historicalRoot.path, value);
    }
  } else if (rootRelocation !== undefined) invalid('WINDOW_INVALID');
  const relocateRuntimeString = (value: string): string => {
    if (!rootRelocation) return value;
    const relative = path.relative(rootRelocation.historicalRuntime, value);
    return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.join(runtime, relative) : value;
  };
  const relocateRuntimeValue = (value: unknown, preserveHistoricalRoot = false): unknown => {
    if (!rootRelocation) return value;
    if (typeof value === 'string') return preserveHistoricalRoot ? value : relocateRuntimeString(value);
    if (Array.isArray(value)) return value.map(item => relocateRuntimeValue(item, preserveHistoricalRoot));
    if (!value || typeof value !== 'object') return value;
    const source = value as Record<string, unknown>;
    const relocated = Object.fromEntries(Object.entries(source).map(([key, item]) => [key,
      relocateRuntimeValue(item, preserveHistoricalRoot || key === 'historicalRoot' || key === 'historicalRuntime')]));
    if (!preserveHistoricalRoot && (validRelocationRoot(source) || validRecoveryRoot(source, true))) {
      const currentPath = relocateRuntimeString(source.path);
      if (currentPath !== source.path) {
        let info: Stats;
        try { info = lstatSync(currentPath); }
        catch { invalid('WINDOW_INVALID'); }
        const currentRoot = { ...source, path: currentPath, device: info.dev, inode: info.ino } as RecoveryRootRow;
        stableRecoveryRoot(currentRoot, remap.currentDevice);
        return currentRoot;
      }
    }
    return relocated;
  };
  const historicalValue = json(String(receiptValue.historicalManifest.path), String(receiptValue.historicalManifest.sha256));
  if (!exact(historicalValue, 'schemaVersion,scope,access,windowId,roots,futureRoots') || historicalValue.schemaVersion !== 1
    || historicalValue.scope !== 'musicbridge-capacity-owned-roots' || historicalValue.access !== 'count-only'
    || historicalValue.windowId !== receiptValue.windowId || !Array.isArray(historicalValue.roots)
    || historicalValue.roots.length !== recoveryHistoricalRootCount || !Array.isArray(historicalValue.futureRoots)
    || historicalValue.futureRoots.length !== 1 || typeof historicalValue.futureRoots[0] !== 'string'
    || !path.isAbsolute(historicalValue.futureRoots[0]) || path.normalize(historicalValue.futureRoots[0]) !== historicalValue.futureRoots[0]) invalid('WINDOW_INVALID');
  let historicalFutureRoot = historicalValue.futureRoots[0];
  if (rootRelocation) {
    const relative = path.relative(rootRelocation.historicalRuntime, historicalFutureRoot);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid('WINDOW_INVALID');
    historicalFutureRoot = path.join(runtime, relative);
  } else if (!inside(runtime, historicalFutureRoot) || historicalFutureRoot === runtime) invalid('WINDOW_INVALID');
  const historicalRows = historicalValue.roots as RecoveryRootRow[], historicalPaths = new Set<string>();
  const liveRoots: RecoveryRootRow[] = [], absentRoots: RecoveryRootRow[] = [];
  for (const root of historicalRows) {
    if (!validInventory({ schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
      windowId: String(historicalValue.windowId), roots: [root] }, String(historicalValue.windowId))) invalid('WINDOW_INVALID');
    if (!path.isAbsolute(root.path) || path.normalize(root.path) !== root.path || historicalPaths.has(root.path)) invalid('WINDOW_INVALID');
    if (root.device !== remap.historicalDevice) invalid('WINDOW_INVALID');
    historicalPaths.add(root.path);
    const relocated = relocationByHistorical.get(root.path);
    if (relocated) {
      if (!sameRecoveryRow(relocated.historicalRoot, root)) invalid('WINDOW_INVALID');
      liveRoots.push(relocated.currentRoot);
    } else if (missingPath(root.path)) {
      if (root.marker.relative !== 'capacity-owner.json') invalid('WINDOW_INVALID');
      absentRoots.push(root);
    } else {
      try { stableRecoveryRoot(root, remap.currentDevice); }
      catch { invalid('WINDOW_INVALID'); }
      liveRoots.push(root);
    }
  }
  if (liveRoots.length !== recoveryLiveRootCount || absentRoots.length !== recoveryLostRootCount
    || relocationByHistorical.size !== (rootRelocation ? recoveryLiveRootCount : 0)) invalid('WINDOW_INVALID');
  const historical = new Set<string>(), replacements = new Set<string>();
  for (const [index, value] of receipt.mappings.entries()) {
    if (!exact(value, 'historicalRoot,state,recovered,replacementRoot') || value.state !== 'LOST' || value.recovered !== false
      || !validRecoveryRoot(value.historicalRoot, false) || !validRecoveryRoot(value.replacementRoot, true)) invalid('WINDOW_INVALID');
    const original = value.historicalRoot, replacement = value.replacementRoot;
    if (!sameRecoveryRow(original, absentRoots[index]!)) invalid('WINDOW_INVALID');
    if (historical.has(String(original.path)) || replacements.has(String(replacement.path))) invalid('WINDOW_INVALID');
    if (!missingPath(String(original.path)) || !inside(runtime, String(replacement.path))) invalid('WINDOW_INVALID');
    if (path.dirname(String(replacement.path)) !== recoveryRoot || String(original.path) === String(replacement.path)) invalid('WINDOW_INVALID');
    if (original.marker.sha256 === replacement.marker.sha256) invalid('WINDOW_INVALID');
    canonical(String(replacement.path));
    if ((lstatSync(String(replacement.path)).mode & 0o777) !== 0o700
      || (lstatSync(path.join(String(replacement.path), 'owner.json')).mode & 0o777) !== 0o400) invalid('WINDOW_INVALID');
    const owner = json(path.join(String(replacement.path), 'owner.json'));
    if (!exact(owner, 'schemaVersion,scope,id,role,recovered,historicalRoot') || owner.schemaVersion !== 1
      || owner.scope !== 'musicbridge-capacity-historical-control-only' || !isCapacityRequestId(owner.id)
      || owner.role !== 'historical-control-only' || owner.recovered !== false
      || JSON.stringify(owner.historicalRoot) !== JSON.stringify(original)) invalid('WINDOW_INVALID');
    const info = lstatSync(String(replacement.path));
    if (replacement.device !== remap.currentDevice || info.dev !== replacement.device || info.ino !== replacement.inode
      || hashCapacityFile(path.join(String(replacement.path), 'owner.json')) !== replacement.marker.sha256
      || !inventory.roots.some(root => root.path === replacement.path && root.device === replacement.device
        && root.inode === replacement.inode && root.marker.relative === 'owner.json'
        && root.marker.sha256 === replacement.marker.sha256)) invalid('INVENTORY_INVALID');
    historical.add(String(original.path)); replacements.add(String(replacement.path));
  }
  if (JSON.stringify(readdirSync(recoveryRoot).sort()) !== JSON.stringify([
    'recovery.json', ...[...replacements].map(value => path.basename(value))].sort())) invalid('WINDOW_INVALID');
  const originalFixture = receipt.mappings.find(
    value => value.historicalRoot.path === seed.fixtureDirectory);
  if (!originalFixture || originalFixture.historicalRoot.marker.sha256 !== window.seed.fixtureOwnerSha256
    || inventory.roots.some(root => historical.has(root.path))) invalid('SEED_INVALID');
  const output = carryover.output!, outputPath = String(output.path), outputMarker = path.join(outputPath, 'command.json');
  canonical(outputPath);
  if (historicalFutureRoot !== outputPath || historicalPaths.has(outputPath)
    || !directRegularFile(outputMarker) || hashCapacityFile(outputMarker) !== output.commandSha256) invalid('INVENTORY_INVALID');
  const issuerFactBinding = window.issuer!.fact, issuerFactPath = issuerFactBinding.path;
  if (!directRegularFile(issuerFactPath) || hashCapacityFile(issuerFactPath) !== issuerFactBinding.sha256
    || issuerFactPath !== path.join(windowRoot, 'issuer-identity', 'owner.json')) invalid('WINDOW_INVALID');
  const issuerIdentity = path.dirname(issuerFactPath); canonical(issuerIdentity);
  if ((lstatSync(windowRoot).mode & 0o777) !== 0o700 || (lstatSync(issuerIdentity).mode & 0o777) !== 0o700) invalid('WINDOW_INVALID');
  const issuerFact = json(issuerFactPath, issuerFactBinding.sha256) as Record<string, unknown>;
  if (!exact(issuerFact, 'schemaVersion,scope,windowId,issuerRepository,candidateRepository,supervisorSource,toolchain,buildHelper,buildToolchain,build,issuerFailureCarryover,prechildFailureCarryover,processFailureCarryover,measureCarryover')
    || issuerFact.schemaVersion !== 1 || issuerFact.scope !== 'musicbridge-capacity-queued-stop-authority-issuer'
    || issuerFact.windowId !== window.id || JSON.stringify(issuerFact.candidateRepository) !== JSON.stringify(window.candidateRepository)
    || JSON.stringify(issuerFact.measureCarryover) !== JSON.stringify(window.measureCarryover)) invalid('WINDOW_INVALID');
  const carryoverRoots = [issuerFact.issuerFailureCarryover, issuerFact.prechildFailureCarryover].flatMap((value, index) => {
    const expectedCount = [window.issuerFailureCarryoverCount, window.prechildFailureCarryoverCount][index];
    if (!Array.isArray(value) || value.length !== expectedCount) invalid('WINDOW_INVALID');
    return value.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof (row as Record<string, unknown>).root !== 'string') invalid('WINDOW_INVALID');
      return String((row as Record<string, unknown>).root);
    });
  });
  const processValue = issuerFact.processFailureCarryover;
  if (!Array.isArray(processValue) || processValue.length !== window.processFailureCarryoverCount) invalid('WINDOW_INVALID');
  const processFileRelatives = {
    owner: 'owner.json', supervisor: 'supervisor.py', issuerFact: 'issuer-identity/owner.json',
    sourceManifest: 'source-pins.json', ownedManifest: 'owned-roots.json', window: 'window.json', close: 'close.json',
    supervision: 'supervision/supervisor.json', supervisorStart: 'supervision/supervisor-start.json',
    stdout: 'supervision/stdout.log', stderr: 'supervision/stderr.log',
  } as const;
  const baseOwnedRoots = inventory.roots.slice(0, 73), reachableProcessRoots: string[] = [];
  const declaredProcessCloses = new Set<string>(), seenProcessRoots = new Set<string>();
  const seenProcessIds = new Set<string>(), seenProcessDirs = new Set<string>(), seenProcessLabels = new Set<string>();
  const processStableChecks: Array<() => void> = [], lineageNodes: ProcessFailureLineageNode[] = [];
  const rowKeys = 'root,windowId,windowDirName,label,failure,code,sampleCount,deviceOpened,formalReady,gateB,files';
  const leafWindowKeys = 'schemaVersion,scope,owner,id,state,phase,profile,label,seedLabel,seed,n,issuerFailureCarryoverCount,prechildFailureCarryoverCount,issuedAt,deadlineAt,limits,ownedManifest,sourceManifest,queuedStopPlan,supervisor,candidateRepository,toolchain,issuer,measureCarryover';
  const leafFactKeys = 'schemaVersion,scope,windowId,issuerRepository,candidateRepository,supervisorSource,toolchain,buildHelper,buildToolchain,build,issuerFailureCarryover,prechildFailureCarryover,measureCarryover';
  const queuedKeys = 'outputDirectory,verifiedComplete,verifiedPassed,fileCount,sampleCount,uniqueChildPids,aggregateBudgetValid,unexpectedEntries';
  const supervisionKeys = 'passed,failure,pid,pgid,code,exitSignal,signals,groupEmpty,zombies,elapsedMs,managedProcessGroup,stdout,stderr,queuedStop';
  const startKeys = 'pid,pgid,command,managedProcessGroup,startedMonotonic,deadlineMonotonic,cwd,environmentKeys,environment,stdin,stdout,stderr';
  const closeKeys = 'schemaVersion,scope,windowId,profile,label,seedLabel,closedAt,state,failure,pid,pgid,managedProcessGroup,code,exitSignal,signals,groupEmpty,zombies,elapsedMs,windowSha256,sourceManifestSha256,ownedManifestSha256,seed,measureCarryover,authorityAdmission,authorityTerminal,queuedStop,supervisorSha256,stdout,stderr,deviceOpened,formalReady,gateB,replayPolicy';
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const expectedBasePaths = [...liveRoots.map(root => root.path), ...receipt.mappings.map(value => value.replacementRoot.path),
    outputPath, ...carryoverRoots];
  if (!same(baseOwnedRoots.map(root => root.path), expectedBasePaths)) invalid('INVENTORY_INVALID');
  const withoutRole = (value: RecoveryReplacementRoot): RecoveryRootRow => ({ path: value.path, device: value.device,
    inode: value.inode, marker: value.marker });
  function processRecoveryLineage(measure: unknown, inherited: unknown[]): void {
    if (!exact(measure, 'window,close,ownedManifest,sourceManifest,supervision,supervisor,output,measureRootRecovery')
      || !exact(measure.measureRootRecovery, 'path,sha256') || typeof measure.measureRootRecovery.path !== 'string'
      || !sha(measure.measureRootRecovery.sha256)) invalid('WINDOW_INVALID');
    if (same(measure.measureRootRecovery, carryover.measureRootRecovery)) {
      if (!same(inherited, baseOwnedRoots)) invalid('WINDOW_INVALID');
      return;
    }
    const oldReceiptValue = relocateRuntimeValue(
      json(measure.measureRootRecovery.path, measure.measureRootRecovery.sha256, 4 * 1024 ** 2));
    const oldReceiptKeys = 'schemaVersion,scope,access,state,model,windowId,historicalManifest,repository,recoveryTool,mappings,activeBenchmarkInput,liveDeviceRemap,contentRecovered,historicalManifestRewritten,deviceOpened,formalReady,gateB';
    const oldHistoricalManifest = exact(oldReceiptValue, oldReceiptKeys) && exact(oldReceiptValue.historicalManifest, 'path,sha256')
      ? oldReceiptValue.historicalManifest : undefined;
    if (!exact(oldReceiptValue, oldReceiptKeys) || oldReceiptValue.model !== 'exact75-v2-replacement-closure'
      || !Array.isArray(oldReceiptValue.mappings) || oldReceiptValue.mappings.length !== 7
      || !oldHistoricalManifest || !exact(measure.ownedManifest, 'path,sha256')
      || oldHistoricalManifest.path !== measure.ownedManifest.path
      || oldHistoricalManifest.sha256 !== measure.ownedManifest.sha256) invalid('WINDOW_INVALID');
    const oldMappings = oldReceiptValue.mappings as RecoveryMapping[];
    if (oldMappings.some(value => !exact(value, 'historicalRoot,state,recovered,replacementRoot')
      || !validRecoveryRoot(value.historicalRoot, false) || !validRecoveryRoot(value.replacementRoot, true))) invalid('WINDOW_INVALID');
    const oldHistorical = oldMappings.map(value => value.historicalRoot);
    const currentHistorical = receipt.mappings.map(value => value.historicalRoot);
    const oldReplacements = oldMappings.map(value => withoutRole(value.replacementRoot));
    const currentReplacements = receipt.mappings.map(value => withoutRole(value.replacementRoot));
    if (!same(inherited.slice(0, 63), baseOwnedRoots.slice(0, 63))
      || !same(inherited.slice(63, 70), oldReplacements)
      || !same(baseOwnedRoots.slice(63, 70), currentReplacements)
      || !same(oldHistorical, currentHistorical)
      || !same(inherited.slice(70), baseOwnedRoots.slice(70))) invalid('WINDOW_INVALID');
  }
  function validateProcessRow(value: unknown, successorIssuedAt: number): { root: string; device: number; inode: number; ownerSha256: string } {
    if (!exact(value, rowKeys) || typeof value.root !== 'string' || !path.isAbsolute(value.root)
      || path.normalize(value.root) !== value.root || path.dirname(value.root) !== runtime
      || path.basename(value.root) !== value.windowDirName || !isCapacityRequestId(value.windowId)
      || !label(value.windowDirName) || !label(value.label) || value.failure !== 'PROCESS_EXIT' || value.code !== 1
      || value.sampleCount !== 0 || value.deviceOpened !== false || value.formalReady !== false
      || value.gateB !== 'NOT_RUN' || !exact(value.files, Object.keys(processFileRelatives).join(','))) invalid('WINDOW_INVALID');
    const root = value.root, windowId = value.windowId, windowDirName = value.windowDirName, processLabel = value.label;
    if (seenProcessRoots.has(root) || seenProcessIds.has(windowId) || seenProcessDirs.has(windowDirName)
      || seenProcessLabels.has(processLabel) || seenProcessRoots.size >= 64) invalid('WINDOW_INVALID');
    canonical(root);
    const rootInfo = lstatSync(root), issuerDirectory = path.join(root, 'issuer-identity');
    const supervisionDirectory = path.join(root, 'supervision'); canonical(issuerDirectory); canonical(supervisionDirectory);
    const issuerInfo = lstatSync(issuerDirectory), supervisionInfo = lstatSync(supervisionDirectory);
    const directoryIdentity = (info: Stats) => [info.dev, info.ino, info.mode, info.nlink, info.mtimeMs, info.ctimeMs];
    const rootDirectoryIdentity = directoryIdentity(rootInfo), issuerDirectoryIdentity = directoryIdentity(issuerInfo);
    const supervisionDirectoryIdentity = directoryIdentity(supervisionInfo);
    const expectedRootEntries = ['close.json','issuer-identity','owned-roots.json','owner.json','source-pins.json','supervision','supervisor.py','window.json'];
    const expectedSupervisionEntries = ['stderr.log','stdout.log','supervisor-start.json','supervisor.json'];
    if (!same(readdirSync(root).sort(), expectedRootEntries) || !same(readdirSync(issuerDirectory).sort(), ['owner.json'])
      || !same(readdirSync(supervisionDirectory).sort(), expectedSupervisionEntries)) invalid('WINDOW_INVALID');
    const files = value.files as Record<string, unknown>, fileHashes = new Map<string, string>();
    for (const [role, relative] of Object.entries(processFileRelatives)) {
      const file = files[role], maximum = ['stdout','stderr'].includes(role) ? 64 * 1024
        : ['owner','issuerFact'].includes(role) ? 1024 * 1024 : 32 * 1024 * 1024;
      if (!exact(file, 'path,sha256') || file.path !== path.join(root, relative) || !sha(file.sha256)
        || !directRegularFile(file.path) || lstatSync(file.path).size > maximum
        || hashCapacityFile(file.path) !== file.sha256) invalid('WINDOW_INVALID');
      fileHashes.set(file.path, file.sha256);
    }
    type ProcessBinding = { path: string; sha256: string };
    const binding = (role: keyof typeof processFileRelatives): ProcessBinding => files[role] as ProcessBinding;
    const owner = relocateRuntimeValue(json(binding('owner').path, binding('owner').sha256));
    const fact = relocateRuntimeValue(json(binding('issuerFact').path, binding('issuerFact').sha256)) as Record<string, unknown>;
    const source = relocateRuntimeValue(json(binding('sourceManifest').path, binding('sourceManifest').sha256)) as Record<string, unknown>;
    const owned = relocateRuntimeValue(json(binding('ownedManifest').path, binding('ownedManifest').sha256)) as Record<string, unknown>;
    const nodeWindow = relocateRuntimeValue(json(binding('window').path, binding('window').sha256)) as Record<string, unknown>;
    const close = relocateRuntimeValue(json(binding('close').path, binding('close').sha256)) as Record<string, unknown>;
    const supervision = relocateRuntimeValue(json(binding('supervision').path, binding('supervision').sha256)) as Record<string, unknown>;
    const start = relocateRuntimeValue(json(binding('supervisorStart').path, binding('supervisorStart').sha256)) as Record<string, unknown>;
    const processCarryover = fact.processFailureCarryover;
    const leaf = !('processFailureCarryover' in fact) && !('processFailureCarryoverCount' in nodeWindow);
    const linked = exact(fact, `${leafFactKeys},processFailureCarryover`) && exact(nodeWindow, `${leafWindowKeys},processFailureCarryoverCount`)
      && nodeWindow.processFailureCarryoverCount === 1 && Array.isArray(processCarryover) && processCarryover.length === 1;
    if (!(leaf && exact(fact, leafFactKeys) && exact(nodeWindow, leafWindowKeys)) && !linked) invalid('WINDOW_INVALID');
    const issuedAt = utcInstant(nodeWindow.issuedAt, true), deadlineAt = utcInstant(nodeWindow.deadlineAt, true);
    const closedAt = utcInstant(close.closedAt, false), expectedOwnedCount = linked ? 76 : 75;
    if (!same(owner, { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: windowId })
      || nodeWindow.schemaVersion !== 1 || nodeWindow.scope !== 'musicbridge-capacity-queued-stop-window'
      || nodeWindow.owner !== 'root' || nodeWindow.id !== windowId || nodeWindow.state !== 'approved'
      || nodeWindow.phase !== 'queued-stop' || nodeWindow.profile !== 'objects-limit' || nodeWindow.label !== processLabel
      || nodeWindow.n !== 105 || nodeWindow.issuerFailureCarryoverCount !== 1 || nodeWindow.prechildFailureCarryoverCount !== 1
      || !same(nodeWindow.limits, CAPACITY_PHASE_LIMITS) || !same(nodeWindow.queuedStopPlan, window.queuedStopPlan)
      || issuedAt === undefined || deadlineAt === undefined || closedAt === undefined || deadlineAt - issuedAt !== 900_000
      || closedAt < issuedAt || closedAt > deadlineAt || closedAt > successorIssuedAt
      || !exact(nodeWindow.sourceManifest, 'file,sha256') || nodeWindow.sourceManifest.file !== 'source-pins.json'
      || nodeWindow.sourceManifest.sha256 !== binding('sourceManifest').sha256
      || !exact(nodeWindow.ownedManifest, 'file,sha256') || nodeWindow.ownedManifest.file !== 'owned-roots.json'
      || nodeWindow.ownedManifest.sha256 !== binding('ownedManifest').sha256
      || !exact(nodeWindow.supervisor, 'path,sha256') || nodeWindow.supervisor.path !== binding('supervisor').path
      || nodeWindow.supervisor.sha256 !== binding('supervisor').sha256
      || !exact(nodeWindow.issuer, 'path,sha256,fact') || !same(nodeWindow.issuer.fact, binding('issuerFact'))
      || fact.schemaVersion !== 1 || fact.scope !== 'musicbridge-capacity-queued-stop-authority-issuer'
      || fact.windowId !== windowId || !same(fact.candidateRepository, nodeWindow.candidateRepository)
      || !same(fact.toolchain, nodeWindow.toolchain) || !same(fact.measureCarryover, nodeWindow.measureCarryover)
      || !Array.isArray(fact.issuerFailureCarryover) || fact.issuerFailureCarryover.length !== 1
      || !Array.isArray(fact.prechildFailureCarryover) || fact.prechildFailureCarryover.length !== 1
      || !exact(source, 'schemaVersion,scope,files') || source.schemaVersion !== 1
      || source.scope !== 'musicbridge-capacity-source-pins' || !source.files || typeof source.files !== 'object'
      || Array.isArray(source.files) || Object.keys(source.files).length === 0
      || Object.entries(source.files as Record<string, unknown>).some(([relative, digest]) => path.isAbsolute(relative)
        || relative.split(path.sep).includes('..') || !sha(digest))
      || !exact(owned, 'schemaVersion,scope,access,windowId,roots') || owned.schemaVersion !== 1
      || owned.scope !== 'musicbridge-capacity-owned-roots' || owned.access !== 'count-only'
      || owned.windowId !== windowId || !Array.isArray(owned.roots) || owned.roots.length !== expectedOwnedCount) invalid('WINDOW_INVALID');
    const inherited = owned.roots.slice(0, 73) as unknown[];
    processRecoveryLineage(nodeWindow.measureCarryover, inherited);
    const ownerRoot = { path: root, device: rootInfo.dev, inode: rootInfo.ino,
      marker: { relative: 'owner.json', sha256: binding('owner').sha256 } };
    const issuerRoot = { path: issuerDirectory, device: issuerInfo.dev, inode: issuerInfo.ino,
      marker: { relative: 'owner.json', sha256: binding('issuerFact').sha256 } };
    let predecessorRoot: RecoveryRootRow | undefined;
    if (linked) {
      const predecessor = processCarryover[0]! as Record<string, unknown>;
      if (!exact(predecessor, rowKeys) || typeof predecessor.root !== 'string' || !exact(predecessor.files, Object.keys(processFileRelatives).join(','))) invalid('WINDOW_INVALID');
      const predecessorOwner = (predecessor.files as Record<string, Record<string, unknown>>).owner;
      if (!exact(predecessorOwner, 'path,sha256') || predecessorOwner.path !== path.join(predecessor.root, 'owner.json')
        || !sha(predecessorOwner.sha256)) invalid('WINDOW_INVALID');
      const predecessorInfo = lstatSync(predecessor.root);
      predecessorRoot = { path: predecessor.root, device: predecessorInfo.dev, inode: predecessorInfo.ino,
        marker: { relative: 'owner.json', sha256: predecessorOwner.sha256 } };
    }
    const expectedOwned = [...inherited, ...(predecessorRoot ? [predecessorRoot] : []), ownerRoot, issuerRoot];
    if (!same(owned.roots, expectedOwned)) invalid('INVENTORY_INVALID');
    const outputDirectory = path.join(root, processLabel), queued = supervision.queuedStop;
    const stdoutBytes = readFileSync(binding('stdout').path, 'utf8');
    const stderrBytes = readFileSync(binding('stderr').path, 'utf8');
    const pid = supervision.pid;
    const logFact = (role: 'stdout' | 'stderr') => ({ path: binding(role).path, exists: true,
      size: lstatSync(binding(role).path).size, sha256: binding(role).sha256 });
    const stdoutFact = logFact('stdout'), stderrFact = logFact('stderr');
    if (!exact(queued, queuedKeys) || !same(queued, { outputDirectory, verifiedComplete: false, verifiedPassed: false,
      fileCount: 0, sampleCount: 0, uniqueChildPids: 0, aggregateBudgetValid: false, unexpectedEntries: [] })
      || existsSync(outputDirectory) || stdoutBytes !== '' || !integer(pid) || pid <= 0
      || stderrBytes !== `CAPACITY_PHASE_OPERATION_FAILED\n(node:${pid}) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n`
      || !exact(supervision, supervisionKeys) || supervision.passed !== false || supervision.failure !== 'PROCESS_EXIT'
      || supervision.pgid !== pid || supervision.code !== 1 || supervision.exitSignal !== null
      || !same(supervision.signals, []) || supervision.groupEmpty !== true || !same(supervision.zombies, [])
      || supervision.managedProcessGroup !== true || typeof supervision.elapsedMs !== 'number'
      || !Number.isFinite(supervision.elapsedMs) || supervision.elapsedMs < 0
      || !same(supervision.stdout, stdoutFact) || !same(supervision.stderr, stderrFact)) invalid('WINDOW_INVALID');
    const candidate = nodeWindow.candidateRepository as Record<string, unknown>;
    const toolchain = nodeWindow.toolchain as Record<string, Record<string, unknown>>;
    const expectedCommand = [toolchain.node?.path, '--import', toolchain.tsxLoader?.path,
      path.join(String(candidate.root), 'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'),
      '--phase','queued-stop','--profile','objects-limit','--label',processLabel,'--seed-label',nodeWindow.seedLabel,
      '--window',binding('window').path,'--window-sha256',binding('window').sha256,
      '--owned-roots',binding('ownedManifest').path,'--owned-roots-sha256',binding('ownedManifest').sha256];
    const environment = start.environment as Record<string, unknown>;
    if (!exact(start, startKeys) || start.pid !== pid || start.pgid !== pid || !same(start.command, expectedCommand)
      || start.managedProcessGroup !== true || typeof start.startedMonotonic !== 'number'
      || typeof start.deadlineMonotonic !== 'number' || start.deadlineMonotonic <= start.startedMonotonic
      || start.cwd !== candidate.root || !exact(environment, 'CI,LANG,LC_ALL,PATH,TMPDIR,TZ')
      || environment.PATH !== '/usr/bin:/bin:/usr/sbin:/sbin' || environment.LANG !== 'C'
      || environment.LC_ALL !== 'C' || environment.TZ !== 'UTC' || environment.CI !== '1'
      || typeof environment.TMPDIR !== 'string' || !path.isAbsolute(environment.TMPDIR)
      || !same(start.environmentKeys, Object.keys(environment).sort()) || start.stdin !== 'DEVNULL'
      || start.stdout !== binding('stdout').path || start.stderr !== binding('stderr').path) invalid('WINDOW_INVALID');
    const admission = close.authorityAdmission as Record<string, unknown>;
    const terminal = close.authorityTerminal as Record<string, unknown>;
    const authorityDepth = linked ? admission?.processFailureCount : null;
    if (linked && (!Number.isSafeInteger(authorityDepth) || Number(authorityDepth) < 1
      || authorityDepth !== terminal?.processFailureCount)) invalid('WINDOW_INVALID');
    if (!exact(close, closeKeys) || close.schemaVersion !== 1
      || close.scope !== 'musicbridge-capacity-queued-stop-window-close' || close.windowId !== windowId
      || close.profile !== 'objects-limit' || close.label !== processLabel || close.seedLabel !== nodeWindow.seedLabel
      || close.state !== 'failed' || close.failure !== 'PROCESS_EXIT' || close.pid !== pid || close.pgid !== pid
      || close.managedProcessGroup !== true || close.code !== 1 || close.exitSignal !== null
      || !same(close.signals, []) || close.groupEmpty !== true || !same(close.zombies, [])
      || close.elapsedMs !== supervision.elapsedMs || close.windowSha256 !== binding('window').sha256
      || close.sourceManifestSha256 !== binding('sourceManifest').sha256
      || close.ownedManifestSha256 !== binding('ownedManifest').sha256 || !same(close.seed, nodeWindow.seed)
      || !same(close.measureCarryover, nodeWindow.measureCarryover) || !same(close.queuedStop, queued)
      || close.supervisorSha256 !== binding('supervision').sha256 || !same(close.stdout, stdoutFact)
      || !same(close.stderr, stderrFact) || close.deviceOpened !== false || close.formalReady !== false
      || close.gateB !== 'NOT_RUN' || close.replayPolicy !== 'terminal-window-id-and-label-never-reuse'
      || !close.authorityAdmission || typeof close.authorityAdmission !== 'object' || Array.isArray(close.authorityAdmission)
      || !close.authorityTerminal || typeof close.authorityTerminal !== 'object' || Array.isArray(close.authorityTerminal)) invalid('WINDOW_INVALID');
    seenProcessRoots.add(root); seenProcessIds.add(windowId); seenProcessDirs.add(windowDirName); seenProcessLabels.add(processLabel);
    reachableProcessRoots.push(root); declaredProcessCloses.add(binding('close').path);
    lineageNodes.push({
      id: windowId,
      predecessorIds: linked ? [String((processCarryover[0] as Record<string, unknown>).windowId)] : [],
      predecessorRootIdentities: predecessorRoot ? [JSON.stringify(predecessorRoot)] : [],
      issuedAt: new Date(issuedAt).toISOString(), deadlineAt: new Date(deadlineAt).toISOString(),
      closedAt: new Date(closedAt).toISOString(), pid: Number(pid), pgid: Number(supervision.pgid),
      supervisionPid: Number(supervision.pid), closePid: Number(close.pid),
      rootIdentity: JSON.stringify(ownerRoot), authorityReachableDepth: linked ? Number(authorityDepth) : null,
    });
    processStableChecks.push(() => {
      if (!same(readdirSync(root).sort(), expectedRootEntries) || !same(readdirSync(issuerDirectory).sort(), ['owner.json'])
        || !same(readdirSync(supervisionDirectory).sort(), expectedSupervisionEntries)
        || !same(directoryIdentity(lstatSync(root)), rootDirectoryIdentity)
        || !same(directoryIdentity(lstatSync(issuerDirectory)), issuerDirectoryIdentity)
        || !same(directoryIdentity(lstatSync(supervisionDirectory)), supervisionDirectoryIdentity)
        || [...fileHashes].some(([file, digest]) => !directRegularFile(file) || hashCapacityFile(file) !== digest)) invalid('WINDOW_INVALID');
    });
    if (linked) validateProcessRow(processCarryover[0]!, issuedAt);
    return { root, device: rootInfo.dev, inode: rootInfo.ino, ownerSha256: binding('owner').sha256 };
  }
  const outerIssuedAt = utcInstant(window.issuedAt, true);
  if (outerIssuedAt === undefined) invalid('WINDOW_INVALID');
  const processRoots = processValue.map(value => validateProcessRow(value, outerIssuedAt));
  const contract = JSON.parse(readFileSync(path.join(CAPACITY_PHASE_REPO_ROOT,
    'packages/contracts/capacity-process-failure-lineage-v1.json'), 'utf8')) as ProcessFailureLineageContract;
  const lineage = evaluateProcessFailureLineage({
    directRootIds: processValue.map(value => String((value as Record<string, unknown>).windowId)),
    nodes: lineageNodes,
  }, contract);
  if (lineage.verdict !== 'PASS') invalid('WINDOW_INVALID');
  function auditProcessCloses(): void {
    const discovered = new Set<string>();
    for (const entry of readdirSync(runtime).sort()) {
      const root = path.join(runtime, entry), closePath = path.join(root, 'close.json');
      const info = lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        if (existsSync(closePath)) invalid('WINDOW_INVALID');
        continue;
      }
      if (!existsSync(closePath)) continue;
      if (!directRegularFile(closePath)) invalid('WINDOW_INVALID');
      let candidate: Record<string, unknown>;
      try { candidate = JSON.parse(readFileSync(closePath, 'utf8')) as Record<string, unknown>; }
      catch { invalid('WINDOW_INVALID'); }
      if (candidate.scope === 'musicbridge-capacity-queued-stop-window-close'
        && candidate.state === 'failed' && candidate.failure === 'PROCESS_EXIT') discovered.add(closePath);
    }
    if (!same([...discovered].sort(), [...declaredProcessCloses].sort())) invalid('WINDOW_INVALID');
  }
  auditProcessCloses();
  carryoverRoots.push(...processRoots.map(value => value.root));
  const expectedInventoryOrder = [...baseOwnedRoots.map(root => root.path), ...processRoots.map(value => value.root),
    path.dirname(issuerIdentity), issuerIdentity];
  if (!same(inventory.roots.map(root => root.path), expectedInventoryOrder)) invalid('INVENTORY_INVALID');
  const expectedPaths = new Set([...liveRoots.map(root => root.path), ...replacements, outputPath, ...carryoverRoots,
    path.dirname(issuerIdentity), issuerIdentity]);
  const inventoryPaths = new Set(inventory.roots.map(root => root.path));
  for (const root of liveRoots) {
    const current = inventory.roots.find(value => value.path === root.path);
    if (!current || current.device !== remap.currentDevice || current.inode !== root.inode
      || current.marker.relative !== root.marker.relative || current.marker.sha256 !== root.marker.sha256) invalid('INVENTORY_INVALID');
  }
  for (const processRoot of processRoots) {
    const current = inventory.roots.find(value => value.path === processRoot.root);
    if (!current || current.device !== processRoot.device || current.inode !== processRoot.inode
      || current.marker.relative !== 'owner.json' || current.marker.sha256 !== processRoot.ownerSha256) invalid('INVENTORY_INVALID');
  }
  if (expectedPaths.size !== 76 || inventoryPaths.size !== 76 || inventoryPaths.size !== inventory.roots.length
    || inventory.roots.some(root => root.device !== remap.currentDevice)
    || [...expectedPaths].some(value => !inventoryPaths.has(value)) || [...inventoryPaths].some(value => !expectedPaths.has(value))) invalid('INVENTORY_INVALID');
  const repository = receiptValue.repository as Record<string, unknown>, tool = receiptValue.recoveryTool as Record<string, unknown>;
  const repositoryRoot = String(repository.root), repositoryHead = String(repository.head), repositoryBranch = String(repository.branch);
  canonical(repositoryRoot);
  const upstreamName = gitText(repositoryRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  function repositoryStable() {
    const refs = gitText(repositoryRoot, ['rev-parse', '--show-toplevel', 'HEAD^{commit}', '@{upstream}^{commit}']).split(/\r?\n/u);
    if (JSON.stringify(refs) !== JSON.stringify([repositoryRoot, repositoryHead, repositoryHead])
      || gitRawText(repositoryRoot, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
        !== `## ${repositoryBranch}...${upstreamName}\0`) invalid('WINDOW_INVALID');
    const toolPath = String(tool.path);
    if (!directRegularFile(toolPath) || hashCapacityFile(toolPath) !== tool.workingSha256
      || hashCapacityFile(toolPath) !== tool.gitBlobSha256
      || createHash('sha256').update(gitBytes(repositoryRoot, ['show', `${repositoryHead}:${recoveryToolRelative}`])).digest('hex') !== tool.gitBlobSha256) invalid('WINDOW_INVALID');
  }
  const recoveryEntries = ['recovery.json', ...[...replacements].map(value => path.basename(value))].sort();
  const stable = () => {
    repositoryStable();
    if (lstatSync(runtime).dev !== remap.currentDevice
      || !directRegularFile(receiptPath) || (lstatSync(receiptPath).mode & 0o777) !== 0o400
      || (lstatSync(recoveryRoot).mode & 0o777) !== 0o700
      || JSON.stringify(readdirSync(recoveryRoot).sort()) !== JSON.stringify(recoveryEntries)
      || hashCapacityFile(receiptPath) !== binding.sha256
      || hashCapacityFile(String((receiptValue.historicalManifest as Record<string, unknown>).path)) !== (receiptValue.historicalManifest as Record<string, unknown>).sha256
      || hashCapacityFile(seedPath) !== receipt.activeBenchmarkInput.sha256) invalid('WINDOW_INVALID');
    for (const root of liveRoots) {
      stableRecoveryRoot(root, remap.currentDevice);
    }
    for (const value of receipt.mappings) {
      const original = value.historicalRoot, replacement = value.replacementRoot;
      if (!missingPath(String(original.path))) invalid('WINDOW_INVALID');
      canonical(String(replacement.path)); const info = lstatSync(String(replacement.path));
      const ownerPath = path.join(String(replacement.path), 'owner.json');
      if (info.dev !== replacement.device || info.ino !== replacement.inode || (info.mode & 0o777) !== 0o700
        || !directRegularFile(ownerPath) || (lstatSync(ownerPath).mode & 0o777) !== 0o400
        || hashCapacityFile(ownerPath) !== replacement.marker.sha256) invalid('INVENTORY_INVALID');
    }
    for (const check of processStableChecks) check();
    auditProcessCloses();
  };
  stable(); return { check: stable, processRoots: reachableProcessRoots };
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

export interface CapacityQueuedStopMeasurement {
  childProgressMs: number; stopReceivedToAbortMs: number; stopReceivedToDriverStopInvokedMs: number;
  stopReceivedToDriverStopAckMs: number; stopReceivedToReceiptMs: number; parentSendStopToReceiptMs: number;
  parentReceiptToChildCloseMs: number; driverCloseInvokedMs: number; driverCloseResolvedMs: number;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function capacityQueuedStopMeasurement(result: CapacityProcessResult, planId: string, planHash: string): CapacityQueuedStopMeasurement | undefined {
  const receipt = result.result;
  if (result.outcome !== 'ok' || !result.closed || result.code !== 0 || result.signal !== null || result.phase !== 'exited'
    || result.cleanup.termSent || result.cleanup.killSent || !Number.isSafeInteger(result.childPid) || result.childPid! <= 0 || result.childPid === process.pid
    || result.processGroup?.managed !== true || result.processGroup.pgid !== result.childPid || result.processGroup.groupEmpty !== true || result.processGroup.zombies.length
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
export function capacityQueuedStopSummary(values: CapacityQueuedStopMeasurement[]): CapacityQueuedStopSummary {
  const field = <K extends keyof CapacityQueuedStopMeasurement>(key: K) => values.map(value => value[key]);
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
  const windowRoot = path.dirname(args.windowPath);
  const runtime = options.runtimeRoot ?? path.dirname(windowRoot), now = options.now ?? Date.now;
  canonical(runtime); canonical(windowRoot);
  if (path.dirname(windowRoot) !== runtime || !label(path.basename(windowRoot)) || path.basename(args.windowPath) !== 'window.json') invalid('WINDOW_INVALID');
  const windowValue = json(args.windowPath, args.windowSha256); if (!validWindow(windowValue)) invalid('WINDOW_INVALID'); const w = windowValue;
  if (w.phase !== args.phase || w.profile !== args.profile || w.label !== args.label || w.seed.label !== args.seedLabel || w.backup?.label !== args.backupLabel
    || args.ownedRootsPath !== path.join(windowRoot, 'owned-roots.json') || args.ownedRootsSha256 !== w.ownedManifest.sha256) invalid('WINDOW_INVALID');
  const ownerPath = path.join(windowRoot, 'owner.json'), owner = json(ownerPath), ownerSha = hashCapacityFile(ownerPath), rootIdentity = lstatSync(windowRoot);
  if (!exact(owner, 'scope,owner,id') || owner.scope !== w.scope || owner.owner !== 'root' || owner.id !== w.id) invalid('WINDOW_INVALID');
  const issued = utcInstant(w.issuedAt, true), deadline = utcInstant(w.deadlineAt, true);
  if (issued === undefined || deadline === undefined
    || issued > now() || deadline <= issued || deadline - issued > 900_000
    || (w.phase === 'queued-stop' || w.phase === 'print-write' && w.n === 105) && deadline - issued !== 900_000) invalid('WINDOW_INVALID');
  const effectiveDeadline = deadline;
  let recoveryCheck = () => {}, processBillingRoots: string[] = [];
  function windowEnvelopeCheck(minimum = 0) {
    if (now() + minimum >= effectiveDeadline) invalid('DEADLINE');
    const s = lstatSync(windowRoot); if (s.dev !== rootIdentity.dev || s.ino !== rootIdentity.ino || hashCapacityFile(ownerPath) !== ownerSha || hashCapacityFile(args.windowPath) !== args.windowSha256) invalid('WINDOW_INVALID');
  }
  function windowCheck(minimum = 0) {
    windowEnvelopeCheck(minimum);
    recoveryCheck();
  }
  const effectiveOperationLimits = capacityPhaseEffectiveOperationLimits(args.phase);
  windowCheck(effectiveOperationLimits.admissionReserveMs);
  const inventoryValue = json(args.ownedRootsPath, args.ownedRootsSha256);
  if (!validInventory(inventoryValue, w.id, w.scope === 'musicbridge-capacity-queued-stop-window' && w.profile === 'objects-limit'
    ? 73 + (w.issuerFailureCarryoverCount ?? 0) + (w.prechildFailureCarryoverCount ?? 0)
      + (w.processFailureCarryoverCount ?? 0) : undefined)) invalid('INVENTORY_INVALID');
  const inventory = inventoryValue;
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
  const successorQueuedStop = w.scope === 'musicbridge-capacity-queued-stop-window';
  const jointSuccessorQueuedStop = successorQueuedStop && w.profile === 'joint';
  const largeQueued = args.phase === 'queued-stop' && args.profile !== 'objects-small';
  if (!seed || seed.schema !== 21 || seed.profile !== args.profile || seed.integrity !== 'passed'
    || (largeQueued ? seed.growth?.state !== 'target-reached' : seed.growth && seed.growth.state !== 'target-reached')
    || (args.profile === 'joint' && (!validJointGenerationPlan(seed.generationPlan) || !validJointAxes(seed.axes)))
    || !isCapacityRequestId(seed.nextPlanId) || !sha(seed.nextPlanHash) || seed.snapshotSha256 !== w.seed.snapshotSha256 || hashCapacityFile(seedPath) !== w.seed.snapshotSha256
    || typeof seed.fixtureDirectory !== 'string' || !/^musicbridge-version-[A-Za-z0-9]+$/u.test(path.basename(seed.fixtureDirectory))) invalid('SEED_INVALID');
  if (!successorQueuedStop || jointSuccessorQueuedStop) canonical(seed.fixtureDirectory);
  if (!exact(seed.marker, 'id,scope') || !isCapacityRequestId(seed.marker.id) || seed.marker.scope !== 'musicbridge-capacity-synthetic-only'
    || (!successorQueuedStop || jointSuccessorQueuedStop)
      && JSON.stringify(json(path.join(seed.fixtureDirectory, 'capacity-owner.json'))) !== JSON.stringify(seed.marker)
    || ['-wal','-shm','-journal'].some(suffix => existsSync(seedPath + suffix))) invalid('SEED_INVALID');
  if (successorQueuedStop && !jointSuccessorQueuedStop) {
    const recoveryValidation = successorRecoveryValidator(w, runtime, windowRoot, seedPath, seed, inventory);
    recoveryCheck = recoveryValidation.check; processBillingRoots = recoveryValidation.processRoots;
  }
  const tempRoot = realpathSync(os.tmpdir()), seen = new Set<string>();
  for (const r of inventory.roots) {
    canonical(r.path); if (seen.has(r.path)) invalid('INVENTORY_INVALID'); seen.add(r.path);
    const inRuntime = inside(runtime, r.path) && r.path !== runtime;
    const fixture = path.dirname(r.path) === tempRoot && /^musicbridge-version-[A-Za-z0-9]+$/u.test(path.basename(r.path));
    const appClone = path.dirname(r.path) === tempRoot && /^musicbridge-ui-diagnostics-r021-[A-Za-z0-9]{6}$/u.test(path.basename(r.path));
    if (!inRuntime && !(fixture && r.marker.relative === 'capacity-owner.json') && !(appClone && r.marker.relative === 'r020-owner.json')) invalid('INVENTORY_INVALID');
  }
  const covered = (p: string) => inventory.roots.some(r => inside(r.path, p));
  if (!seen.has(windowRoot) || !covered(seedDirectory)
    || (!successorQueuedStop || jointSuccessorQueuedStop) && !covered(seed.fixtureDirectory)) invalid('INVENTORY_INVALID');
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
    // 调用方在空间检查前后已有完整windowCheck；递归计量期间继续复核窗口包络，避免为每个条目重复启动Git进程。
    windowEnvelopeCheck(); if (hashCapacityFile(args.ownedRootsPath) !== args.ownedRootsSha256) invalid('INVENTORY_INVALID');
    for (const r of inventory.roots) { canonical(r.path); const s = lstatSync(r.path); if (s.dev !== r.device || s.ino !== r.inode || hashCapacityFile(path.join(r.path, r.marker.relative)) !== r.marker.sha256) invalid('INVENTORY_INVALID'); }
    let entries = 0;
    function size(directory: string, depth: number): number {
      if (++entries > 200_000 || depth > 32) invalid('INVENTORY_INVALID'); windowEnvelopeCheck();
      const s = lstatSync(directory); if (s.isSymbolicLink()) invalid('INVENTORY_INVALID');
      if (s.isFile()) return s.size; if (!s.isDirectory()) invalid('INVENTORY_INVALID');
      let total = 0; for (const name of readdirSync(directory)) { total += size(path.join(directory, name), depth + 1); if (!integer(total) || total > CAPACITY_PHASE_LIMITS.maximumOwnedBytes) invalid('SPACE'); } return total;
    }
    return minimalRoots([...inventory.roots.map(r => r.path), ...processBillingRoots])
      .reduce((total, root) => total + size(root, 0), 0);
  }
  function space(planned: number) {
    const owned = ownedBytes(), stat = options.availableBytes ? undefined : statfsSync(windowRoot, { bigint: true });
    const available = options.availableBytes ? options.availableBytes(windowRoot) : Number(stat!.bavail * stat!.bsize);
    try { assertCapacitySpace({ availableBytes: available, plannedBytes: planned, ownedBytes: owned }); } catch { invalid('SPACE'); }
    return { availableBytes: available, plannedBytes: planned, ownedBytes: owned };
  }
  const planned = args.phase === 'queued-stop' ? 105 : args.phase === 'print-write' ? w.n : 10;
  const d = lstatSync(seedPath).size;
  const queuedStopWorkingBytes = successorQueuedStop ? capacityMeasureWorkingBytes(d) : 3 * d + 64 * 1024 ** 2;
  if (successorQueuedStop
    && (w.queuedStopPlan?.snapshotBytes !== d || w.queuedStopPlan.plannedBytes !== queuedStopWorkingBytes)) invalid('WINDOW_INVALID');
  const restoreBound = backupReceipt ? 3 * backupReceipt.databaseBytes + backupReceipt.objectBytes + backupReceipt.manifestBytes + 64 * 1024 ** 2 : 0;
  const initialSpace = space(args.phase === 'full-recovery' ? 10 * restoreBound
    : successorQueuedStop ? queuedStopWorkingBytes : 3 * d + 64 * 1024 ** 2);
  const output = path.join(windowRoot, args.label); mkdirSync(output); syncDirectory(windowRoot);
  const queuedStopAggregate: CapacityMeasureAggregateGuard | undefined = successorQueuedStop
    ? createCapacityQueuedStopAggregateGuard(output, d) : undefined;
  queuedStopAggregate?.check({ checkpoint: 'output-created' });
  durable(path.join(output, 'owner.json'), { scope: 'musicbridge-capacity-phase-output', id: randomUUID(), windowId: w.id, label: args.label });
  durable(path.join(output, 'input.json'), { args, windowId: w.id, seedSha256: w.seed.snapshotSha256, sourceManifestSha256: w.sourceManifest.sha256, initialSpace,
    effectiveOperationLimits,
    classification: 'software-only/exclusive-window', cache: 'OS cache未清；复制和hash已触页，不是物理冷盘', n: planned,
    ...(args.phase === 'queued-stop' ? { warmup: 5, formalSamples: 100, clocks: 'parent与child分栏，不跨进程相减', backend: 'private-immediate-fake' } : {}),
    ...(args.phase === 'print-write' ? { mode: planned === 10 ? 'pilot' : 'formal', pilotSamples: planned === 10 ? 10 : 0, warmup: planned === 105 ? 5 : 0,
      formalSamples: planned === 105 ? 100 : 0, claimLimitMaxMs: 2000, completeLimitMaxMs: 2000, backend: 'private-immediate-fake' } : {}),
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' });
  queuedStopAggregate?.check({ checkpoint: 'input-written' });
  const rows: { outcome: string; durationMs: number }[] = [], queueMeasurements: CapacityQueuedStopMeasurement[] = [], printMeasurements: PrintWriteMeasurement[] = [], childPids = new Set<number>(); let failure: string | undefined, prepared = false;
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
        windowCheck(effectiveOperationLimits.admissionReserveMs); seedCheck();
        const beforeSpace = space(args.phase === 'full-recovery' ? (11 - index) * restoreBound
          : successorQueuedStop ? Math.max(0, queuedStopWorkingBytes - capacityDirectoryBytes(output)) : 3 * d + 64 * 1024 ** 2);
        const name = `sample-${String(index).padStart(args.phase === 'queued-stop' || args.phase === 'print-write' ? 3 : 2, '0')}`, preparedAt = performance.now(); let clone: CapacityClone | undefined, destinationPath: string | undefined;
        if (args.phase === 'cold' || args.phase === 'print-write' || args.phase === 'queued-stop' && !successorQueuedStop) clone = createCapacityClone(output, name, seedPath);
        else if (successorQueuedStop) clone = createCapacityClone(output, name, seedPath, queuedStopWorkingBytes, queuedStopAggregate);
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
        queuedStopAggregate?.check({ group: name, checkpoint: 'operation-returned' });
        let identityFailure: string | undefined;
        // 子进程关闭后、发布成功或清理clone前复核本次样本的完整输入身份。
        try { windowCheck(); sourceCheck(); seedCheck(); } catch (error) { identityFailure = capacityPhaseFailureCode(error); }
        const queueMeasurement = args.phase === 'queued-stop' ? capacityQueuedStopMeasurement(result, seed.nextPlanId, seed.nextPlanHash) : undefined;
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
        queuedStopAggregate?.check({ group: name, checkpoint: 'sample-evidence-written' });
        if (identityFailure) throw new Error(identityFailure);
        if (queueMeasurement && index > 5) queueMeasurements.push(queueMeasurement);
        if (printMeasurement && (planned === 10 || index > 5)) printMeasurements.push(printMeasurement);
        const retentionSpace = space(args.phase === 'full-recovery' ? (10 - index) * restoreBound : 0);
        try {
          durable(path.join(output, `${name}-retention.json`), { retained: args.phase === 'full-recovery' || outcome !== 'ok', resourcesClosed: result.closed, space: retentionSpace });
        } catch { invalid('PERSISTENCE_FAILED'); }
        queuedStopAggregate?.check({ group: name, checkpoint: 'retention-written' });
        // retention 与空间证据先落盘；其后才允许清理成功 clone，任何碰撞或 fsync 失败都保留现场。
        if (clone && result.closed) finishCapacityClone(clone, { outcome, resourcesClosed: true, samples: [result] });
        if (!ok) invalid('OPERATION_FAILED');
      }
    }
    windowCheck(); sourceCheck(); seedCheck(); space(0);
  } catch (error) { failure = capacityPhaseFailureCode(error); }
  const queueSummary = args.phase === 'queued-stop' ? capacityQueuedStopSummary(queueMeasurements) : undefined;
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
  queuedStopAggregate?.check({ checkpoint: 'terminal-written' });
  return summary;
}
