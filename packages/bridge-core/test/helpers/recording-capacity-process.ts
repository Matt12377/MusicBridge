import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCapacityBudget, hashCapacityFile, type CapacityBudget, type CapacityClone } from './recording-capacity-fixture.js';

export interface CapacityColdInput { clone: CapacityClone; planId: string; planHash: string }
export interface CapacityQueuedStopInput { clone: CapacityClone; planId: string; planHash: string }
export interface CapacityPrintWriteInput { clone: CapacityClone; planId: string; planHash: string }
export interface CapacityRecoveryInput {
  backupPath: string; destinationPath: string; expected: { id: string; manifestHash: string };
  protectedRootPaths: string[]; owner: { root: string; id: string };
}
export interface CapacityProcessOptions {
  executionTimeoutMs?: number; killGraceMs?: number; closeTimeoutMs?: number;
  /** 只供自然测试控制真实短进程；不进入child协议、环境或生产API。 */
  launch?: typeof fork;
  /** 自然测试可要求注入进程也遵守正式PGID fail-closed；正式fork始终隐式为true。 */
  requireManagedProcessGroup?: true;
}
interface Identity { device: number; inode: number }
export type CapacityChildTask =
  | ({ kind: 'cold'; databaseSha256: string } & CapacityColdInput)
  | ({ kind: 'queue'; databaseSha256: string } & CapacityQueuedStopInput)
  | ({ kind: 'print-write'; databaseSha256: string } & CapacityPrintWriteInput)
  | ({ kind: 'restore'; restoreId: string; rootIdentity: Identity; destinationIdentity: Identity } & CapacityRecoveryInput);
interface Evidence { childMeasuredMs: number; clock: 'child-relative'; deviceOpened: false; formalReady: false; gateB: 'NOT_RUN' }
export interface CapacityColdReceipt extends Evidence {
  kind: 'cold'; planId: string; planHash: string; budget: CapacityBudget;
  repositoryOpenMs: number; fullAuditMs: number; databaseCloseMs: number;
}
export interface CapacityRecoveryReceipt extends Evidence {
  kind: 'restore'; id: string; sourceBackupId: string; sourceManifestHash: string;
  state: 'isolated-pending-activation'; contentIncluded: true; objectCount: number; objectBytes: number; databaseSha256: string;
  verifyBackupMs: number; restoreMs: number; verifyRestoredMs: number;
}
export interface CapacityQueuedStopReceipt extends Evidence {
  kind: 'queue'; planId: string; planHash: string; attemptId: string; order: ['progress', 'stop']; progressFrames: 1;
  fullAuditMs: number; beginMs: number; progressMs: number; abortObserved: true; driverStopInvoked: true; driverStopAcknowledged: true;
  stopReceivedToAbortMs: number; stopReceivedToDriverStopInvokedMs: number; stopReceivedToDriverStopAckMs: number; stopReceivedToReceiptMs: number;
  driverCloseInvoked: true; driverCloseResolved: true; stopReceivedToDriverCloseInvokedMs: number; stopReceivedToDriverCloseResolvedMs: number;
}
interface CapacityPrintObjectReceipt { sha256: string; size: number; mime: 'application/pdf' | 'image/jpeg'; width: number | null; height: number | null }
export interface CapacityPrintWriteReceipt extends Evidence {
  kind: 'print-write'; planId: string; planHash: string; attemptId: string; recordingId: string; jobId: string; requestId: string; inputHash: string;
  events: [{ revision: 1; kind: 'create' }, { revision: 2; kind: 'claim' }, { revision: 3; kind: 'complete' }];
  lease: { leaseId: string; workerId: string; jobId: string; requestId: string; inputHash: string };
  job: { id: string; requestId: string; inputHash: string; state: 'ready'; revision: 3; artifactId: string };
  artifact: { id: string; requestId: string; recordingId: string; inputHash: string; pdfSha256: string; previewSha256: string; size: number; previewSize: number; pageCount: 1 };
  completeReceipt: { id: string; kind: 'complete'; fingerprint: string };
  pdf: CapacityPrintObjectReceipt & { mime: 'application/pdf'; width: null; height: null };
  preview: CapacityPrintObjectReceipt & { mime: 'image/jpeg'; width: 1; height: 1 };
  claimMs: number; completeMs: number; idempotent: true;
}
type CapacityQueuedStopReceiptStage = Omit<CapacityQueuedStopReceipt, 'driverCloseInvoked' | 'driverCloseResolved' | 'stopReceivedToDriverCloseInvokedMs' | 'stopReceivedToDriverCloseResolvedMs'>;
type CapacityQueuedStopCleanup = Pick<CapacityQueuedStopReceipt, 'driverCloseInvoked' | 'driverCloseResolved' | 'stopReceivedToDriverCloseInvokedMs' | 'stopReceivedToDriverCloseResolvedMs'>;
export type CapacityChildReceipt = CapacityColdReceipt | CapacityRecoveryReceipt | CapacityQueuedStopReceipt | CapacityPrintWriteReceipt;
export type CapacityFailure = 'INPUT_INVALID' | 'INVALID_PROTOCOL' | 'SPAWN_FAILED' | 'AUDIT_FAILED' | 'RESTORE_FAILED' | 'QUEUE_FAILED' | 'PRINT_WRITE_FAILED' | 'CLEANUP_FAILED' | 'PROCESS_EXIT' | 'LEFTOVER_PROCESSES' | 'PROCESS_GROUP_UNKNOWN' | 'TIMEOUT' | 'CLOSE_TIMEOUT' | 'OUTPUT_LIMIT';
export type CapacityPhase = 'preflight' | 'spawned' | 'ready' | 'receipt' | 'exited';
export type CapacityChildPhase = 'protocol' | 'open' | 'audit' | 'begin' | 'progress' | 'stop' | 'record-complete' | 'claim' | 'complete' | 'close' | 'verify-backup' | 'restore' | 'verify-restored';
export interface CapacityProcessResult {
  outcome: 'ok' | 'failed' | 'timeout'; requestId: string; childPid: number | null; code: number | null; signal: NodeJS.Signals | null;
  closed: boolean; cleanup: { termSent: boolean; killSent: boolean }; forkToCloseMs: number;
  phase: CapacityPhase; timings: { clock?: 'parent-relative'; readyMs?: number; receiptMs?: number; exitMs?: number; sendStopToReceiptMs?: number; receiptToChildCloseMs?: number };
  /** launch注入可能是旧式非detached短进程；正式fork路径始终managed=true。 */
  processGroup?: { pgid: number | null; managed: boolean; groupEmpty: boolean; zombies: number[] };
  childFailure?: { phase: CapacityChildPhase; elapsedMs: number }; failure?: CapacityFailure; result?: CapacityChildReceipt;
}

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const absolute = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096 && !v.includes('\0') && path.isAbsolute(v) && path.normalize(v) === v;
function exact(v: unknown, names: string): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
}
function identity(v: unknown): v is Identity { return exact(v, 'device,inode') && integer(v.device) && integer(v.inode); }
function directory(root: string): Identity {
  if (!absolute(root) || realpathSync(root) !== root) throw new Error('容量目录身份无效');
  const s = lstatSync(root); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('容量目录身份无效');
  return { device: s.dev, inode: s.ino };
}
function equalIdentity(actual: Identity, expected: Identity): void {
  if (actual.device !== expected.device || actual.inode !== expected.inode) throw new Error('容量目录身份变化');
}
function ownerJson(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); if (!before.isFile() || before.nlink !== 1 || before.size > 1024) throw new Error('容量owner无效');
    const data: unknown = JSON.parse(readFileSync(fd, 'utf8')), after = fstatSync(fd), named = lstatSync(file);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'] as const) if (before[key] !== after[key] || after[key] !== named[key]) throw new Error('容量owner变化');
    return data;
  } finally { closeSync(fd); }
}
function cloneShape(v: unknown): v is CapacityClone {
  return exact(v, 'parent,label,directory,filePath,marker,device,inode,parentDevice,parentInode') && absolute(v.parent) && absolute(v.directory) && absolute(v.filePath)
    && typeof v.label === 'string' && /^[a-z0-9-]{1,64}$/u.test(v.label) && exact(v.marker, 'id,scope,label') && uuid(v.marker.id)
    && v.marker.scope === 'musicbridge-capacity-clone-only' && v.marker.label === v.label && [v.device, v.inode, v.parentDevice, v.parentInode].every(integer);
}
function recoveryShape(v: Record<string, unknown>): boolean {
  return absolute(v.backupPath) && absolute(v.destinationPath) && exact(v.expected, 'id,manifestHash') && uuid(v.expected.id) && hash(v.expected.manifestHash)
    && exact(v.owner, 'root,id') && absolute(v.owner.root) && uuid(v.owner.id) && Array.isArray(v.protectedRootPaths) && v.protectedRootPaths.length <= 32
    && v.protectedRootPaths.every(absolute) && new Set(v.protectedRootPaths).size === v.protectedRootPaths.length;
}
/** 父与child均验证相同固定私有协议，不能将未知字段当作新能力。 */
export function isCapacityChildTask(v: unknown): v is CapacityChildTask {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (t.kind === 'cold' || t.kind === 'queue' || t.kind === 'print-write') return exact(t, 'kind,clone,planId,planHash,databaseSha256') && cloneShape(t.clone) && uuid(t.planId) && hash(t.planHash) && hash(t.databaseSha256);
  return t.kind === 'restore' && exact(t, 'kind,backupPath,destinationPath,expected,protectedRootPaths,owner,restoreId,rootIdentity,destinationIdentity')
    && recoveryShape(t) && uuid(t.restoreId) && identity(t.rootIdentity) && identity(t.destinationIdentity);
}
export function verifyCapacityTaskPaths(task: CapacityChildTask): void {
  if (task.kind === 'cold' || task.kind === 'queue' || task.kind === 'print-write') {
    const c = task.clone;
    if (path.join(c.parent, c.label) !== c.directory || path.join(c.directory, 'sample.sqlite') !== c.filePath) throw new Error('容量clone位置无效');
    equalIdentity(directory(c.parent), { device: c.parentDevice, inode: c.parentInode });
    equalIdentity(directory(c.directory), { device: c.device, inode: c.inode });
    const marker = ownerJson(path.join(c.directory, 'owner.json'));
    if (!exact(marker, 'id,scope,label') || marker.id !== c.marker.id || marker.scope !== c.marker.scope || marker.label !== c.marker.label) throw new Error('容量clone owner不符');
    if (readdirSync(c.directory).sort().join(',') !== 'owner.json,sample.sqlite' || hashCapacityFile(c.filePath) !== task.databaseSha256) throw new Error('容量clone不是固定关闭快照');
    return;
  }
  equalIdentity(directory(task.owner.root), task.rootIdentity); equalIdentity(directory(task.destinationPath), task.destinationIdentity);
  const marker = ownerJson(path.join(task.owner.root, 'owner.json'));
  if (!exact(marker, 'id,scope') || marker.id !== task.owner.id || marker.scope !== 'musicbridge-capacity-recovery-only'
    || path.dirname(task.destinationPath) !== task.owner.root || readdirSync(task.destinationPath).length) throw new Error('容量恢复目标不是本轮空目录');
  directory(task.backupPath); for (const p of task.protectedRootPaths) directory(p);
  if (hashCapacityFile(path.join(task.backupPath, 'Backup.json')) !== task.expected.manifestHash) throw new Error('容量备份身份变化');
  for (const p of [task.backupPath, ...task.protectedRootPaths]) {
    const inside = (a: string, b: string) => a === b || b.startsWith(a + path.sep);
    if (inside(p, task.owner.root) || inside(task.owner.root, p)) throw new Error('容量恢复目标与保护根重叠');
  }
}
const budgetKeys = 'attemptBytes,planBytes,recordBytes,printBytes,photoBytes,printObjectBytes,attempts,events,receipts,records,plans,printJobs,printReceipts';
function validReceipt(v: unknown, task: CapacityChildTask): v is CapacityColdReceipt | CapacityRecoveryReceipt | CapacityQueuedStopReceiptStage | CapacityPrintWriteReceipt {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>, evidence = 'childMeasuredMs,clock,deviceOpened,formalReady,gateB';
  if (r.clock !== 'child-relative' || r.deviceOpened !== false || r.formalReady !== false || r.gateB !== 'NOT_RUN' || !number(r.childMeasuredMs)) return false;
  if (task.kind === 'cold') {
    if (!exact(r, evidence + ',kind,planId,planHash,budget,repositoryOpenMs,fullAuditMs,databaseCloseMs') || r.kind !== 'cold' || r.planId !== task.planId || r.planHash !== task.planHash
      || !exact(r.budget, budgetKeys) || !Object.values(r.budget).every(integer) || ![r.repositoryOpenMs, r.fullAuditMs, r.databaseCloseMs].every(number)) return false;
    try { assertCapacityBudget(r.budget as unknown as CapacityBudget); } catch { return false; }
    return (r.repositoryOpenMs as number) + (r.fullAuditMs as number) + (r.databaseCloseMs as number) <= r.childMeasuredMs + 1;
  }
  if (task.kind === 'queue') return validQueueReceiptStage(v, task);
  if (task.kind === 'print-write') return validPrintWriteReceipt(v, task);
  return exact(r, evidence + ',kind,id,sourceBackupId,sourceManifestHash,state,contentIncluded,objectCount,objectBytes,databaseSha256,verifyBackupMs,restoreMs,verifyRestoredMs')
    && r.kind === 'restore' && r.id === task.restoreId && r.sourceBackupId === task.expected.id && r.sourceManifestHash === task.expected.manifestHash
    && r.state === 'isolated-pending-activation' && r.contentIncluded === true && integer(r.objectCount) && integer(r.objectBytes) && hash(r.databaseSha256)
    && [r.verifyBackupMs, r.restoreMs, r.verifyRestoredMs].every(number)
    && (r.verifyBackupMs as number) + (r.restoreMs as number) + (r.verifyRestoredMs as number) <= r.childMeasuredMs + 1;
}
function validPrintWriteReceipt(v: unknown, task: Extract<CapacityChildTask, { kind: 'print-write' }>): v is CapacityPrintWriteReceipt {
  if (!v || typeof v !== 'object' || capacityMessageBytes(v) > 16_384 || /base64|data:image/u.test(JSON.stringify(v))) return false;
  const r = v as Record<string, unknown>, evidence = 'childMeasuredMs,clock,deviceOpened,formalReady,gateB';
  const keys = `${evidence},kind,planId,planHash,attemptId,recordingId,jobId,requestId,inputHash,events,lease,job,artifact,completeReceipt,pdf,preview,claimMs,completeMs,idempotent`;
  if (!exact(r, keys) || r.kind !== 'print-write' || r.planId !== task.planId || r.planHash !== task.planHash || ![r.attemptId,r.recordingId,r.jobId,r.requestId].every(uuid)
    || !hash(r.inputHash) || r.clock !== 'child-relative' || r.deviceOpened !== false || r.formalReady !== false || r.gateB !== 'NOT_RUN'
    || ![r.childMeasuredMs,r.claimMs,r.completeMs].every(number) || r.idempotent !== true) return false;
  if (!Array.isArray(r.events) || r.events.length !== 3 || !r.events.every((event, index) => exact(event, 'revision,kind') && event.revision === index + 1 && event.kind === ['create','claim','complete'][index])) return false;
  const lease = r.lease as Record<string, unknown>, job = r.job as Record<string, unknown>, artifact = r.artifact as Record<string, unknown>;
  if (!exact(lease, 'leaseId,workerId,jobId,requestId,inputHash') || ![lease.leaseId,lease.workerId].every(uuid) || lease.jobId !== r.jobId || lease.requestId !== r.requestId || lease.inputHash !== r.inputHash) return false;
  if (!exact(job, 'id,requestId,inputHash,state,revision,artifactId') || job.id !== r.jobId || job.requestId !== r.requestId || job.inputHash !== r.inputHash || job.state !== 'ready' || job.revision !== 3 || !uuid(job.artifactId)) return false;
  if (!exact(artifact, 'id,requestId,recordingId,inputHash,pdfSha256,previewSha256,size,previewSize,pageCount') || artifact.id !== job.artifactId || artifact.requestId !== r.requestId
    || artifact.recordingId !== r.recordingId || artifact.inputHash !== r.inputHash || !hash(artifact.pdfSha256) || !hash(artifact.previewSha256)
    || !integer(artifact.size) || !integer(artifact.previewSize) || artifact.pageCount !== 1) return false;
  const complete = r.completeReceipt as Record<string, unknown>;
  if (!exact(complete, 'id,kind,fingerprint') || complete.id !== `lease:${String(lease.leaseId)}` || complete.kind !== 'complete' || !hash(complete.fingerprint)) return false;
  const object = (value: unknown, mime: string, width: number | null, height: number | null, sha256: unknown, size: unknown) => exact(value, 'sha256,size,mime,width,height')
    && value.sha256 === sha256 && value.size === size && value.mime === mime && value.width === width && value.height === height;
  return object(r.pdf, 'application/pdf', null, null, artifact.pdfSha256, artifact.size)
    && object(r.preview, 'image/jpeg', 1, 1, artifact.previewSha256, artifact.previewSize)
    && (r.claimMs as number) + (r.completeMs as number) <= (r.childMeasuredMs as number) + 1;
}
function validQueueReceiptStage(v: unknown, task: Extract<CapacityChildTask, { kind: 'queue' }>): v is CapacityQueuedStopReceiptStage {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const keys = 'kind,planId,planHash,attemptId,order,progressFrames,fullAuditMs,beginMs,progressMs,abortObserved,driverStopInvoked,driverStopAcknowledged,stopReceivedToAbortMs,stopReceivedToDriverStopInvokedMs,stopReceivedToDriverStopAckMs,stopReceivedToReceiptMs,childMeasuredMs,clock,deviceOpened,formalReady,gateB';
  return exact(r, keys) && r.kind === 'queue' && r.planId === task.planId && r.planHash === task.planHash && uuid(r.attemptId)
    && Array.isArray(r.order) && r.order.length === 2 && r.order[0] === 'progress' && r.order[1] === 'stop' && r.progressFrames === 1
    && r.abortObserved === true && r.driverStopInvoked === true && r.driverStopAcknowledged === true
    && r.clock === 'child-relative' && r.deviceOpened === false && r.formalReady === false && r.gateB === 'NOT_RUN'
    && [r.fullAuditMs, r.beginMs, r.progressMs, r.stopReceivedToAbortMs, r.stopReceivedToDriverStopInvokedMs, r.stopReceivedToDriverStopAckMs, r.stopReceivedToReceiptMs, r.childMeasuredMs].every(number)
    && (r.stopReceivedToAbortMs as number) <= (r.stopReceivedToDriverStopInvokedMs as number)
    && (r.stopReceivedToDriverStopInvokedMs as number) <= (r.stopReceivedToDriverStopAckMs as number)
    && (r.stopReceivedToDriverStopAckMs as number) <= (r.stopReceivedToReceiptMs as number)
    && (r.stopReceivedToReceiptMs as number) <= (r.childMeasuredMs as number);
}
function validQueueCleanup(v: unknown, receipt: CapacityQueuedStopReceiptStage): v is CapacityQueuedStopCleanup {
  if (!exact(v, 'driverCloseInvoked,driverCloseResolved,stopReceivedToDriverCloseInvokedMs,stopReceivedToDriverCloseResolvedMs')) return false;
  return v.driverCloseInvoked === true && v.driverCloseResolved === true && number(v.stopReceivedToDriverCloseInvokedMs) && number(v.stopReceivedToDriverCloseResolvedMs)
    && receipt.stopReceivedToReceiptMs <= v.stopReceivedToDriverCloseInvokedMs
    && v.stopReceivedToDriverCloseInvokedMs <= v.stopReceivedToDriverCloseResolvedMs;
}
export function isCapacityInit(v: unknown, requestId: string): v is { version: 1; requestId: string; type: 'init'; task: CapacityChildTask } {
  return exact(v, 'version,requestId,type,task') && v.version === 1 && v.requestId === requestId && v.type === 'init' && isCapacityChildTask(v.task);
}
export function isCapacityQueueProgress(v: unknown, requestId: string): v is { version: 1; requestId: string; type: 'progress'; sequence: 1; frames: 1 } {
  return exact(v, 'version,requestId,type,sequence,frames') && v.version === 1 && v.requestId === requestId && v.type === 'progress' && v.sequence === 1 && v.frames === 1;
}
export function isCapacityQueueStop(v: unknown, requestId: string): v is { version: 1; requestId: string; type: 'stop'; sequence: 2; commandId: string } {
  return exact(v, 'version,requestId,type,sequence,commandId') && v.version === 1 && v.requestId === requestId && v.type === 'stop' && v.sequence === 2 && uuid(v.commandId);
}
export const isCapacityRequestId = uuid;
export function capacityMessageBytes(v: unknown): number { try { return Buffer.byteLength(JSON.stringify(v)); } catch { return Infinity; } }

interface CapacityGroupMember { pid: number; state: string }
function capacityGroupMembers(pgid: number): { known: boolean; members: CapacityGroupMember[] } {
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,state='], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const members: CapacityGroupMember[] = [];
    for (const line of output.split('\n')) {
      const fields = line.trim().split(/\s+/u); if (fields.length < 3) continue;
      const pid = Number(fields[0]), group = Number(fields[1]);
      if (Number.isSafeInteger(pid) && pid > 0 && group === pgid) members.push({ pid, state: fields[2]! });
    }
    return { known: true, members };
  } catch { return { known: false, members: [] }; }
}

async function run(taskFactory: () => CapacityChildTask, options: CapacityProcessOptions): Promise<CapacityProcessResult> {
  const execution = options.executionTimeoutMs ?? 50_000, grace = options.killGraceMs ?? 1_000, closeBudget = options.closeTimeoutMs ?? 2_000;
  const managedRequired = options.launch === undefined || options.requireManagedProcessGroup === true;
  if ([[execution, 50_000], [grace, 1_000], [closeBudget, 2_000]].some(([v, max]) => !Number.isSafeInteger(v) || v! < 1 || v! > max!)) throw new Error('容量子进程期限只能收紧');
  const requestId = randomUUID(); let task: CapacityChildTask;
  try { task = taskFactory(); if (!isCapacityChildTask(task)) throw new Error(); verifyCapacityTaskPaths(task); }
  catch { return { outcome: 'failed', requestId, childPid: null, code: null, signal: null, closed: false, cleanup: { termSent: false, killSent: false }, forkToCloseMs: 0, phase: 'preflight', timings: {}, failure: 'INPUT_INVALID' }; }
  return new Promise(resolve => {
    const started = performance.now(), timings: CapacityProcessResult['timings'] = {}, cleanup = { termSent: false, killSent: false };
    let child: ChildProcess | undefined, settled = false, exited = false, closedEvent = false, ready = false, messages = 0, bytes = 0, sendStopAt: number | undefined;
    let code: number | null = null, signal: NodeJS.Signals | null = null, failure: CapacityFailure | undefined, result: CapacityChildReceipt | undefined;
    let queueReceipt: CapacityQueuedStopReceiptStage | undefined;
    let pgid: number | null = null, groupManaged = false, groupEmpty = false, zombies: number[] = [], cleanupEndsAt: number | undefined;
    let phase: CapacityPhase = 'spawned', childFailure: CapacityProcessResult['childFailure'];
    let deadline: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined, cleanupDeadline: NodeJS.Timeout | undefined, closeDeadline: NodeJS.Timeout | undefined, cleanupPoll: NodeJS.Timeout | undefined;
    const elapsed = () => performance.now() - started;
    function group() {
      if (!groupManaged || pgid === null) return { known: true, live: [] as CapacityGroupMember[] };
      const current = capacityGroupMembers(pgid);
      zombies = current.members.filter(member => member.state.startsWith('Z')).map(member => member.pid);
      const live = current.members.filter(member => !member.state.startsWith('Z'));
      groupEmpty = current.known && live.length === 0;
      return { known: current.known, live };
    }
    function finish(closed: boolean) {
      if (settled) return; settled = true;
      for (const timer of [deadline, escalation, cleanupDeadline, closeDeadline, cleanupPoll]) clearTimeout(timer);
      const duration = elapsed();
      const finalGroup = group();
      if (groupManaged && !finalGroup.known) { failure = 'PROCESS_GROUP_UNKNOWN'; closed = false; }
      else if (groupManaged && finalGroup.live.length) { failure = 'CLOSE_TIMEOUT'; closed = false; }
      if (timings.receiptMs !== undefined) timings.receiptToChildCloseMs = Math.max(0, duration - timings.receiptMs);
      if (!failure) failure = duration > execution ? 'TIMEOUT' : !closed ? 'CLOSE_TIMEOUT' : code !== 0 || signal !== null ? 'PROCESS_EXIT' : !result ? 'INVALID_PROTOCOL' : undefined;
      if (!closed) {
        child?.stdout?.destroy(); child?.stderr?.destroy();
        try { if (child?.connected) child.disconnect(); } catch { /* 清理失败仍保留closed=false。 */ }
        child?.channel?.unref(); child?.unref();
      }
      child?.removeListener('message', onMessage); child?.removeListener('error', onError); child?.removeListener('exit', onExit); child?.removeListener('close', onClose);
      child?.stdout?.removeListener('data', consume); child?.stderr?.removeListener('data', consume);
      // 本地释放后仍可能有迟到的Node错误，不能制造未处理异常。
      if (!closed) child?.on('error', () => {});
      resolve({ outcome: failure === 'TIMEOUT' ? 'timeout' : failure ? 'failed' : 'ok', requestId, childPid: child?.pid ?? null, code, signal, closed,
        cleanup, forkToCloseMs: duration, phase, timings, processGroup: { pgid, managed: groupManaged, groupEmpty: groupManaged ? groupEmpty : managedRequired ? false : closed, zombies },
        ...(childFailure ? { childFailure } : {}), ...(failure ? { failure } : { result: result! }) });
    }
    function signalOwned(which: 'SIGTERM' | 'SIGKILL') {
      const key = which === 'SIGTERM' ? 'termSent' : 'killSent';
      if (groupManaged && pgid !== null) {
        const current = group(); if (!current.known || !current.live.length) return;
        try { process.kill(-pgid, which); cleanup[key] = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= 'PROCESS_GROUP_UNKNOWN';
        }
        return;
      }
      if (!exited && child?.pid && child.exitCode === null && child.signalCode === null) {
        try { if (child.kill(which)) cleanup[key] = true; } catch { /* launch测试注入仅信号本次child。 */ }
      }
    }
    function pollCleanup() {
      if (settled || cleanupEndsAt === undefined) return;
      const current = group();
      if (closedEvent && (!groupManaged || current.known && current.live.length === 0)) { finish(true); return; }
      const remaining = cleanupEndsAt - performance.now();
      if (remaining <= 0) { if (groupManaged && (!current.known || current.live.length)) failure = 'CLOSE_TIMEOUT'; finish(false); return; }
      cleanupPoll = setTimeout(pollCleanup, Math.min(20, remaining));
    }
    function beginCleanup() {
      if (settled || cleanupEndsAt !== undefined) return;
      clearTimeout(deadline); clearTimeout(closeDeadline);
      cleanupEndsAt = performance.now() + closeBudget;
      signalOwned('SIGTERM');
      escalation = setTimeout(() => { signalOwned('SIGKILL'); pollCleanup(); }, Math.min(grace, Math.max(0, cleanupEndsAt! - performance.now())));
      cleanupDeadline = setTimeout(() => pollCleanup(), Math.max(0, cleanupEndsAt - performance.now()));
      pollCleanup();
    }
    function fail(reason: CapacityFailure) {
      if (settled || failure) return; failure = reason;
      if (!child) { finish(false); return; }
      beginCleanup();
    }
    function consume(chunk: Buffer) { bytes += chunk.length; if (bytes > 16_384) fail('OUTPUT_LIMIT'); }
    function onError() { fail('SPAWN_FAILED'); }
    function onExit(c: number | null, s: NodeJS.Signals | null) {
      exited = true; code = c; signal = s; phase = 'exited'; timings.exitMs = elapsed();
      const current = group();
      if (groupManaged && !current.known) { failure ??= 'PROCESS_GROUP_UNKNOWN'; beginCleanup(); return; }
      if (groupManaged && current.live.length) { failure ??= 'LEFTOVER_PROCESSES'; beginCleanup(); return; }
      if (code !== 0 || signal !== null) failure ??= 'PROCESS_EXIT';
      if (!settled && cleanupEndsAt === undefined) closeDeadline = setTimeout(() => { failure ??= 'CLOSE_TIMEOUT'; finish(false); }, closeBudget);
    }
    function onClose(c: number | null, s: NodeJS.Signals | null) {
      code = c; signal = s; closedEvent = true;
      const current = group();
      if (groupManaged && !current.known) { failure ??= 'PROCESS_GROUP_UNKNOWN'; beginCleanup(); return; }
      if (groupManaged && current.live.length) { failure ??= 'LEFTOVER_PROCESSES'; beginCleanup(); return; }
      finish(true);
    }
    function onMessage(v: unknown) {
      if (settled || failure) return;
      if (++messages > 8 || capacityMessageBytes(v) > 65_536 || !v || typeof v !== 'object') { fail('INVALID_PROTOCOL'); return; }
      const m = v as Record<string, unknown>;
      if (m.version !== 1 || m.requestId !== requestId || m.childPid !== child?.pid || result) { fail('INVALID_PROTOCOL'); return; }
      if (m.type === 'ready' && !ready && exact(m, 'version,requestId,type,childPid')) {
        ready = true; phase = 'ready'; timings.readyMs = elapsed();
        if (task.kind === 'queue') {
          timings.clock = 'parent-relative';
          const commandId = randomUUID();
          try {
            child!.send({ version: 1, requestId, type: 'progress', sequence: 1, frames: 1 }, error => { if (error) fail('SPAWN_FAILED'); });
            sendStopAt = performance.now();
            child!.send({ version: 1, requestId, type: 'stop', sequence: 2, commandId }, error => { if (error) fail('SPAWN_FAILED'); });
          } catch { fail('SPAWN_FAILED'); }
        }
        return;
      }
      if (m.type === 'receipt' && ready && exact(m, 'version,requestId,type,childPid,result') && validReceipt(m.result, task)) {
        phase = 'receipt'; timings.receiptMs = elapsed();
        if (task.kind === 'queue') {
          queueReceipt = m.result as CapacityQueuedStopReceiptStage;
          if (sendStopAt === undefined) { fail('INVALID_PROTOCOL'); return; }
          timings.sendStopToReceiptMs = Math.max(0, performance.now() - sendStopAt);
        } else result = m.result as CapacityColdReceipt | CapacityRecoveryReceipt | CapacityPrintWriteReceipt;
        return;
      }
      if (m.type === 'cleanup' && task.kind === 'queue' && queueReceipt && exact(m, 'version,requestId,type,childPid,result') && validQueueCleanup(m.result, queueReceipt)) {
        result = { ...queueReceipt, ...m.result }; return;
      }
      if (m.type === 'failed' && exact(m, 'version,requestId,type,childPid,code,phase,elapsedMs') && typeof m.code === 'string'
        && ['INVALID_PROTOCOL', 'AUDIT_FAILED', 'RESTORE_FAILED', 'QUEUE_FAILED', 'PRINT_WRITE_FAILED', 'CLEANUP_FAILED'].includes(m.code) && typeof m.phase === 'string'
        && ['protocol', 'open', 'audit', 'begin', 'progress', 'stop', 'record-complete', 'claim', 'complete', 'close', 'verify-backup', 'restore', 'verify-restored'].includes(m.phase) && number(m.elapsedMs)) {
        childFailure = { phase: m.phase as CapacityChildPhase, elapsedMs: m.elapsedMs }; fail(m.code as CapacityFailure); return;
      }
      fail('INVALID_PROTOCOL');
    }
    try {
      child = (options.launch ?? fork)(new URL('./recording-capacity-child.ts', import.meta.url), ['--capacity-child', requestId], {
        execPath: process.execPath, execArgv: ['--import', 'tsx'], cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { PATH: path.dirname(process.execPath), LANG: 'C', LC_ALL: 'C' }, serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
      });
      pgid = child.pid ?? null;
      if (pgid !== null) {
        const initial = capacityGroupMembers(pgid);
        groupManaged = initial.known && initial.members.some(member => member.pid === pgid);
        groupEmpty = false;
      }
      child.stdout?.on('data', consume); child.stderr?.on('data', consume);
      child.on('message', onMessage); child.on('error', onError); child.once('exit', onExit); child.once('close', onClose);
      deadline = setTimeout(() => fail('TIMEOUT'), execution);
      if (managedRequired && !groupManaged) { fail('PROCESS_GROUP_UNKNOWN'); return; }
      child.send({ version: 1, requestId, type: 'init', task }, error => { if (error) fail('SPAWN_FAILED'); });
    } catch { fail('SPAWN_FAILED'); if (!child) finish(false); }
  });
}
export const runCapacityCold = (input: CapacityColdInput, options: CapacityProcessOptions = {}) => run(() => ({ kind: 'cold', ...input, databaseSha256: hashCapacityFile(input.clone.filePath) }), options);
export const runCapacityQueuedStop = (input: CapacityQueuedStopInput, options: CapacityProcessOptions = {}) => run(() => ({ kind: 'queue', ...input, databaseSha256: hashCapacityFile(input.clone.filePath) }), options);
export const runCapacityPrintWrite = (input: CapacityPrintWriteInput, options: CapacityProcessOptions = {}) => run(() => ({ kind: 'print-write', ...input, databaseSha256: hashCapacityFile(input.clone.filePath) }), options);
export const runCapacityRecovery = (input: CapacityRecoveryInput, options: CapacityProcessOptions = {}) => run(() => ({ kind: 'restore', ...input, restoreId: randomUUID(), rootIdentity: directory(input.owner.root), destinationIdentity: directory(input.destinationPath) }), options);
