import assert from 'node:assert/strict';
import type test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads';
import type { RecordingPlanVersion, RecordingOutputSelection, IpcRequest } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { createTestDatasetDomain } from '../../src/collection/dataset-domain.js';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { createFormalDeviceAttemptProvider } from '../../src/recording/formal-device-attempt-provider.js';
import type { RecordingAttemptDriverRequest } from '../../src/recording/attempt-coordinator.js';
import type { GateBAdmission, GateBLiveObservation } from '../../src/recording/gate-b-admission.js';
import type { PinnedDeviceOutputHelper } from '../../src/recording/bundled-device-output-helper.js';
import { reconcileOutputRunRecovery } from '../../src/recording/output-run-recovery.js';
import { recordingPlanFixture } from './recording-plan-fixture.js';

const ROOT = os.tmpdir();
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export interface RecordingObserverEvent { event: string; at: number; [key: string]: unknown }
export interface RecordingWorkerData { fixture: 'dataset-owner-recording'; databaseFile: string; maintenanceFile: string; plan: RecordingPlanVersion; pin: PinnedDeviceOutputHelper; observer: MessagePort; auditFile: string }
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
function schema(db: DatabaseSync) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all(); }
const equal = (a: unknown, b: unknown): boolean => a instanceof Uint8Array && b instanceof Uint8Array ? Buffer.from(a).equals(Buffer.from(b)) : a === b;

/** 只复用闭合合成容量库；业务行逐值复制，私有序号/空ZIP会话保持最高代际，其他冲突须完全相同且schema不可改变。 */
export async function createDatasetOwnerRecordingFixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(ROOT, 'mbp-008-owner-recording-'));
  const seedDirectory = process.env.MBP008_RECORDING_CAPACITY_INPUT;
  const manifest = seedDirectory ? JSON.parse(await readFile(path.join(seedDirectory, 'fixture.json'), 'utf8')) as { totalDBReferenceSize: number; books: { bookId: string; revisionId: string; snapshotId: string; queriedCatalogSize: number }[] } : undefined;
  if (manifest) assert.equal(manifest.totalDBReferenceSize, 2000, '容量行为测试只复用调用方显式提供的2000闭合样本');
  const source = seedDirectory ? path.join(seedDirectory, 'synthetic.sqlite') : undefined;
  if (source) {
    const wal = await stat(`${source}-wal`).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    assert.equal(wal?.size ?? 0, 0, '只能复制闭合且没有未checkpoint内容的样本');
  }
  const sourceHash = source ? digest(await readFile(source)) : undefined;
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  const context = { after(callback: () => unknown | Promise<unknown>) { cleanup.push(callback); } } as unknown as test.TestContext;
  const small = await recordingPlanFixture(context, false, { format: 'dat', retainDirectory: true });
  const plan = await small.plans.freeze(await small.planRequest());
  for (const close of cleanup) await close();
  const baseFile = path.join(directory, 'closed-base.sqlite'); await copyFile(source ?? small.filePath, baseFile); await chmod(baseFile, 0o600);
  const target = new DatabaseSync(baseFile, { enableForeignKeyConstraints: true });
  const input = new DatabaseSync(small.filePath, { readOnly: true });
  const copied: Record<string, number> = {};
  const sequences: { format: string; targetNext: number; inputNext: number; mergedNext: number }[] = [];
  let zipSession: { targetEpoch: number; inputEpoch: number; mergedEpoch: number; emptyBoth: true } | undefined;
  try {
    assert.deepEqual(schema(target), schema(input));
    const before = digest(JSON.stringify(schema(target)));
    target.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
    try {
      for (const { name } of input.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()) {
        const table = String(name), rows = input.prepare(`SELECT * FROM ${quote(table)}`).all();
        if (!rows.length) continue;
        const fields = Object.keys(rows[0]!), keys = input.prepare(`PRAGMA table_info(${quote(table)})`).all().filter(field => Number(field.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(field => String(field.name));
        assert.ok(keys.length, `业务表${table}必须保留原主键身份`);
        const lookup = target.prepare(`SELECT * FROM ${quote(table)} WHERE ${keys.map(key => `${quote(key)}=?`).join(' AND ')}`);
        const insert = target.prepare(`INSERT INTO ${quote(table)} (${fields.map(quote).join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
        copied[table] = 0;
        for (const row of rows) {
          const previous = lookup.get(...keys.map(key => row[key] as SQLInputValue));
          if (previous) {
            if (table === 'physical_sequences') {
              // 只合并私有测试夹具的分格式计数，保留所有已分配copy身份，避免下一次接收碰撞。
              const targetNext = Number(previous.next_value), inputNext = Number(row.next_value), mergedNext = Math.max(targetNext, inputNext);
              assert.ok(Number.isSafeInteger(targetNext) && targetNext > 0 && Number.isSafeInteger(inputNext) && inputNext > 0);
              target.prepare('UPDATE physical_sequences SET next_value=? WHERE format=?').run(mergedNext, row.format as SQLInputValue);
              sequences.push({ format: String(row.format), targetNext, inputNext, mergedNext });
            } else if (table === 'preparation_zip_session') {
              // 两边都没有ZIP任务、回执或授权，才可合并空会话；绝不带入有效旧授权或降低代际。
              for (const zipTable of ['preparation_zip_jobs', 'preparation_zip_targets', 'preparation_zip_ledger']) {
                assert.equal(target.prepare(`SELECT count(*) AS n FROM ${quote(zipTable)}`).get()!.n, 0);
                assert.equal(input.prepare(`SELECT count(*) AS n FROM ${quote(zipTable)}`).get()!.n, 0);
              }
              const targetEpoch = Number(previous.epoch), inputEpoch = Number(row.epoch), mergedEpoch = Math.max(targetEpoch, inputEpoch);
              assert.ok(Number.isSafeInteger(targetEpoch) && targetEpoch >= 0 && Number.isSafeInteger(inputEpoch) && inputEpoch >= 0);
              target.prepare('UPDATE preparation_zip_session SET epoch=? WHERE id=1').run(mergedEpoch);
              zipSession = { targetEpoch, inputEpoch, mergedEpoch, emptyBoth: true };
            } else assert.ok(fields.every(field => equal(previous[field], row[field])), `${table}同主键行不能覆盖不同数据`);
            continue;
          }
          insert.run(...fields.map(field => row[field] as SQLInputValue)); ++copied[table]!;
        }
      }
      assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(), []);
      target.exec('COMMIT');
    } catch (error) { target.exec('ROLLBACK'); throw error; }
    assert.equal(digest(JSON.stringify(schema(target))), before);
    assert.equal(target.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    target.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally { input.close(); target.close(); }
  if (source) assert.equal(digest(await readFile(source)), sourceHash);
  const helper = path.join(directory, 'controlled-helper'), manifestFile = path.join(directory, 'controlled-manifest.json');
  const helperBytes = Buffer.from('仅controlled launch使用；不执行HAL或真实原生helper'), manifestBytes = Buffer.from('{}');
  await writeFile(helper, helperBytes, { mode: 0o700 }); await writeFile(manifestFile, manifestBytes, { mode: 0o600 });
  const pin: PinnedDeviceOutputHelper = { path: helper, sha256: digest(helperBytes), manifestPath: manifestFile, manifestSha256: digest(manifestBytes), sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
  await writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ source, sourceHash, count: manifest?.totalDBReferenceSize ?? 0, recordingSourceDirectory: small.directory, copied, sequences, zipSession, planId: plan.id, planHash: plan.contentHash, sourceSchemaUnchanged: true, devicesOpened: false }, null, 2));
  // 保留自建源与证据；失败时不能先移除仍被owner输入租期引用的文件。
  t.after(async () => { if (source) assert.equal(digest(await readFile(source)), sourceHash); });
  async function clone(name: string) { const folder = path.join(directory, name); await mkdir(folder); const databaseFile = path.join(folder, 'collection.v1.sqlite'); await copyFile(baseFile, databaseFile); await chmod(databaseFile, 0o600); return { databaseFile, maintenanceFile: path.join(folder, 'backup-maintenance.v1.sqlite'), auditFile: path.join(folder, 'worker-audit.json') }; }
  return { directory, clone, plan, pin, book: manifest?.books[0], sourceHash };
}

function nativeEvent(runId: string, sequence: number, kind: number, frames: number): Buffer {
  const bytes = Buffer.alloc(64); bytes.write('MBDE'); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(kind, 6); bytes.writeUInt32LE(sequence, 8);
  bytes.writeUInt32LE(kind === 7 ? 11 : 0, 12); Buffer.from(runId.replaceAll('-', ''), 'hex').copy(bytes, 16);
  bytes.writeBigUInt64LE(BigInt(frames), 32); bytes.writeBigUInt64LE(BigInt(frames), 40);
  if (kind === 7) { bytes[58] = 1; bytes[59] = 1; }
  if (kind === 3 || kind === 9 || kind === 7) bytes[61] = 1;
  return bytes;
}

/** 合成child遵守原事件/控制协议；真实Runner+供帧pump读取原只读FD，10ms受控sink不模拟HAL听感。 */
class ControlledNativeProcess extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly pcm: Writable; readonly stdio: readonly unknown[];
  private controls = Buffer.alloc(0); private header = false; private sequence = 0; private frames = 0;
  private timer: ReturnType<typeof setTimeout> | undefined; private pendingWrite: ((error?: Error | null) => void) | undefined;
  closed = false; readonly writes: { at: number; frames: number }[] = [];
  readonly scope: { runId: string; datasetId: string; attemptId: string; leaseFile: string }; private nativeFd: number;
  constructor(runId: string, datasetId: string, attemptId: string, databaseFile: string, private readonly frameBytes: number, private readonly observe: (event: string, payload?: Record<string, unknown>) => void) {
    super();
    const leaseFile = `${databaseFile}.output-run-${runId}.lease`;
    this.scope = { runId, datasetId, attemptId, leaseFile }; this.nativeFd = openSync(leaseFile, 'r+');
    const lease = Buffer.alloc(288); assert.equal(readSync(this.nativeFd, lease, 0, lease.length, 0), lease.length);
    assert.equal(lease.subarray(8, 24).toString('hex'), runId.replaceAll('-', '')); assert.equal(lease.subarray(80, 96).toString('hex'), datasetId.replaceAll('-', '')); assert.equal(lease.subarray(96, 112).toString('hex'), attemptId.replaceAll('-', ''));
    this.pcm = new Writable({ highWaterMark: 1024, write: (bytes: Buffer, _encoding, done) => {
      assert.equal(this.closed, false, 'native scope关闭后不得再供帧');
      this.writes.push({ at: performance.now(), frames: bytes.length / frameBytes }); this.observe('pcm-write', { runId, frames: bytes.length / frameBytes });
      this.pendingWrite = done;
      this.timer = setTimeout(() => { this.timer = undefined; this.pendingWrite = undefined; if (this.closed) { done(new Error('scope关闭')); return; } this.frames += bytes.length / frameBytes; this.send(9); done(); }, 10);
    } });
    this.stdio = [this.stdin, this.stdout, this.stderr, this.pcm];
    this.stdin.on('data', (chunk: Buffer) => {
      this.controls = Buffer.concat([this.controls, chunk]);
      if (!this.header && this.controls.length >= 320) {
        this.header = true; assert.equal(this.controls.toString('ascii', 0, 4), 'MBOD'); assert.equal(this.controls[256], 1, '必须是formal-recording测试scope'); this.controls = this.controls.subarray(320); this.send(1); this.send(2);
      }
      while (this.header && this.controls.length >= 32) {
        const control = this.controls.subarray(0, 32); this.controls = this.controls.subarray(32); assert.equal(control.toString('ascii', 0, 4), 'MBDC');
        if (control.readUInt16LE(6) === 1) this.send(3); else if (control.readUInt16LE(6) === 2) { this.observe('native-stop', { runId }); this.finish(); }
      }
    });
    this.pcm.on('finish', () => assert.fail('有界录音测试应先Stop/close，不应完整播放此计划'));
  }
  private send(kind: number) { this.stdout.write(nativeEvent(this.scope.runId, ++this.sequence, kind, this.frames)); }
  private finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const callback = this.pendingWrite; this.pendingWrite = undefined;
    // 模拟原生scope收口只写本次真实sidecar墓碑；不把此Fake当作原生排他锁或设备证据。
    writeSync(this.nativeFd, Buffer.from([2]), 0, 1, 6); fsyncSync(this.nativeFd); closeSync(this.nativeFd); this.nativeFd = -1;
    this.send(7); this.observe('native-close', { runId: this.scope.runId, writes: this.writes.length, tombstone: true });
    this.pcm.destroy(); callback?.(); queueMicrotask(() => this.emit('close', 2));
  }
  kill() { this.finish(); return true; }
}

function admissionFor(plan: RecordingPlanVersion, pin: PinnedDeviceOutputHelper) {
  const binding = plan.outputBinding!, format = plan.profileSnapshot.settings.format;
  const selection: RecordingOutputSelection = { endpointId: binding.endpointId, selectionGeneration: randomUUID() };
  const observed: GateBLiveObservation = { endpointId: binding.endpointId, uid: binding.deviceUid, sampleRate: format.sampleRate, channelCount: format.channelCount, format: format.outputSampleFormat, physicalFormat: format.outputSampleFormat, bufferFrames: binding.bufferFrames, backendId: binding.backendId, backendVersion: binding.backendVersion, configurationFingerprintSha256: binding.configurationFingerprintSha256, selectionGeneration: selection.selectionGeneration, alive: true, hasOutput: true };
  const admission: GateBAdmission = { recordSha256: 'b'.repeat(64), configurationFingerprintSha256: binding.configurationFingerprintSha256, endpointId: binding.endpointId, uid: binding.deviceUid, selectionGeneration: selection.selectionGeneration, validUntil: new Date(Date.now() + 60_000).toISOString(), helperSha256: pin.sha256, route: { endpointId: binding.endpointId, uid: binding.deviceUid, sampleRate: format.sampleRate, channelCount: format.channelCount, format: format.outputSampleFormat, physicalFormat: format.outputSampleFormat, bufferFrames: binding.bufferFrames }, drainAlgorithmId: pin.drainAlgorithmId, drain: { tailFrames: binding.bufferFrames, minimumZeroCallbacks: 2, capacityFrames: binding.bufferFrames * 2 } };
  return { selection, observed, admission };
}

async function runWorker(data: RecordingWorkerData) {
  assert.ok(parentPort);
  const events: RecordingObserverEvent[] = [], natives: ControlledNativeProcess[] = [], inputs: RecordingAttemptDriverRequest['input'][] = [];
  const observe = (event: string, payload: Record<string, unknown> = {}) => { const value = { event, at: performance.now(), ...payload }; events.push(value); data.observer.postMessage(value); };
  attachDatasetOwnerWorkerPort(parentPort, { async prepare() {
    const repository = createCollectionRepository({ filePath: data.databaseFile }); repository.list({ offset: 0, limit: 1 });
    const maintenance = createBackupWorkflowStore({ filePath: data.maintenanceFile }); const identity = maintenance.datasetIdentities.bind('default', data.databaseFile, true);
    const recovery = await reconcileOutputRunRecovery({ databaseFile: data.databaseFile, datasetId: identity.datasetId, rows: repository.recordingAttempts.outputRunRecoveryRows(), assertCurrent: identity.assertCurrent });
    const facts = admissionFor(data.plan, data.pin);
    const formal = createFormalDeviceAttemptProvider({ pin: data.pin, leaseScope: { databaseFile: data.databaseFile, datasetId: identity.datasetId }, deviceSelection: { current: () => facts.selection, async verify() { return facts.observed; } }, gateB: { async verify() { return facts.admission; } }, runnerOptions: { launch(_file, _args, options) {
      const current = inputs.at(-1)!; assert.ok(Array.isArray(options.stdio) && Number.isSafeInteger(options.stdio[4]), '真实租约fd必须由Formal传给受控launch');
      const descriptor = current.consumer.descriptor; const sampleBytes = descriptor.sampleFormat === 'pcm-s16le' ? 2 : descriptor.sampleFormat === 'pcm-s24le' ? 3 : 4;
      const request = activeRequest!;
      const child = new ControlledNativeProcess(request.runId, identity.datasetId, request.attempt.id, data.databaseFile, descriptor.channelCount * sampleBytes, observe); natives.push(child); return child as unknown as ChildProcess;
    } } });
    let activeRequest: RecordingAttemptDriverRequest | undefined;
    const domain = createTestDatasetDomain({ collectionRepository: repository, backupWorkflowStore: maintenance, collectionDatasetIdentity: identity, recordingAttemptAdmissionProvider: { authorize: formal.authorize, async start(request) {
      activeRequest = request; inputs.push(request.input); observe('provider-start', { attemptId: request.attempt.id, runId: request.runId });
      const reader = request.input.consumer;
      const instrumented = { ...request, input: { ...request.input, consumer: { descriptor: reader.descriptor, async readFrames(start: number, count: number) { observe('input-read-start', { start, count }); const value = await reader.readFrames(start, count); observe('input-read-end', { start, count: value.frames }); return value; } } } };
      return formal.start(instrumented);
    } } });
    observe('prepared', { datasetId: identity.datasetId, recovery, starts: inputs.length });
    return { ...domain,
      async dispatch(request: IpcRequest) {
        observe('dispatch-enter', { id: request.id, command: request.command });
        try {
          const value = await domain.dispatch(request);
          if (request.command === 'recordingAttempts.stop') {
            // 原accepted回执只提交停止终态，异步末核验/quiet由真实收口继续完成；观测不能增强原合同。
            observe('stop-state', { id: request.id, quiet: repository.recordingAttempts.outputRunRecoveryRows().every(row => row.quietPersisted) });
          }
          return value;
        } finally { observe('dispatch-leave', { id: request.id, command: request.command }); }
      },
      async close(beforeConnectionClose?: () => Promise<void>) {
        let quiet: unknown;
        await domain.close(async () => { await beforeConnectionClose?.(); quiet = repository.recordingAttempts.outputRunRecoveryRows(); });
        const writesAtClose = natives.map(native => native.writes.length); const inputErrors: string[] = [];
        for (const input of inputs) { try { await input.consumer.readFrames(0, 1); inputErrors.push('UNEXPECTED_READ'); } catch (error) { inputErrors.push(error instanceof Error && 'code' in error ? String(error.code) : 'unknown'); } }
        await new Promise<void>(done => setTimeout(done, 30));
        const writesAfterClose = natives.map(native => native.writes.length);
        const databaseClosed = (() => { try { repository.list({ offset: 0, limit: 1 }); return false; } catch { return true; } })();
        const maintenanceClosed = (() => { try { maintenance.overview(); return false; } catch { return true; } })();
        const audit = { classification: 'synthetic-worker-recording-behavior/no-device', datasetId: identity.datasetId, recovery, quiet, starts: inputs.length, inputErrors, databaseClosed, maintenanceClosed, writesAtClose, writesAfterClose, natives: natives.map(native => ({ scope: native.scope, closed: native.closed, writes: native.writes })), events };
        await writeFile(data.auditFile, JSON.stringify(audit, null, 2), { mode: 0o600 }); observe('closed', { auditFile: data.auditFile }); data.observer.close();
      },
    };
  } });
}
if (!isMainThread && (workerData as { fixture?: string }).fixture === 'dataset-owner-recording') await runWorker(workerData as RecordingWorkerData);
