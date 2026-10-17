import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { createMobileContentOwnerStore, MobileContentPersistenceError } from '../../src/mobile/content-owner-store.js';
import {
  closeMobileCapabilityContext, copyMobileCapabilityTraceSnapshot, createMobileCapabilityContext,
  createMobileCapabilityTraceCollector, createMobileCapabilityTraceReader, mobileCapabilityRequestSha,
  withMobileCapabilityContext, type MobileCapabilityContext,
} from '../../src/mobile/capability-trace.js';
import type { MobileContentStateLimits } from '../../src/mobile/content-types.js';

// 真正只读合成文件；close故障在原OS close完成之后受控抛出，不冒实际系统close失败证据。
test('MBM能力私有诊断：真实内容Store首拒与两个close失败分别保留且原结果不变', { concurrency: false }, t => {
  const tmp = process.env.TMPDIR, hosted = process.env.RUNNER_TEMP;
  assert.ok(typeof tmp === 'string' && path.isAbsolute(tmp) && (tmp.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')
    || process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
      && typeof hosted === 'string' && path.isAbsolute(hosted) && tmp.startsWith(hosted + path.sep)));
  const directory = fs.mkdtempSync(path.join(tmp, 'mbm004-capability-store-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const serverId = 'server.synthetic.capability', datasetId = randomUUID();
  const limits: MobileContentStateLimits = { stateBytes: 1024 * 1024, receipts: 100, albums: 100, favoriteTracks: 100, playlists: 100, playlistTracks: 100 };
  let decrypts = 0;
  const store = createMobileContentOwnerStore({ directory, serverId, datasetId, limits,
    seal: value => new Uint8Array(value), open: value => { decrypts++; return new Uint8Array(value); }, assertCurrent() {} });
  assert.equal(store.load().revision, 0);
  const contentDirectory = path.join(directory, 'mobile-content'), file = path.join(contentDirectory, 'content-state.v1.sealed.json');
  const invalidEnvelope = Buffer.from('{"synthetic-private-content":', 'utf8');
  fs.writeFileSync(file, invalidEnvelope, { flag: 'wx', mode: 0o600 });
  const identity = fs.lstatSync(file, { bigint: true });
  const realOpen = fs.openSync, realClose = fs.closeSync;
  const owned = new Map<number, 'file' | 'directory'>();
  let closes = { file: 0, directory: 0 }, closed: number[] = [];
  const fileCloseError = Object.assign(new Error('受控文件close私密说明'), { code: 'EIO' });
  const directoryCloseError = Object.assign(new Error('受控目录close私密说明'), { code: 'EIO' });
  const opened = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(realOpen, fs, args) as number;
    if (args[0] === file || args[0] === contentDirectory) owned.set(fd, args[0] === file ? 'file' : 'directory');
    return fd;
  });
  const closing = t.mock.method(fs, 'closeSync', (fd: number) => {
    const kind = owned.get(fd);
    if (!kind) return realClose(fd);
    owned.delete(fd); closes[kind]++; realClose(fd); closed.push(fd);
    throw kind === 'file' ? fileCloseError : directoryCloseError;
  });
  const collector = createMobileCapabilityTraceCollector(), frames: string[] = [];
  const read = createMobileCapabilityTraceReader(row => collector.record(row));
  const requestId = randomUUID(), parentSha256 = '1'.repeat(64);
  const context = createMobileCapabilityContext(requestId, 'owner', 'owner', parentSha256, undefined, line => { frames.push(line); read(line); });
  assert.ok(context);
  function loadFailure(ctx?: MobileCapabilityContext) {
    closes = { file: 0, directory: 0 }; closed = [];
    let failure: unknown;
    try { withMobileCapabilityContext(ctx, () => store.load()); }
    catch (error) { failure = error; }
    assert.ok(failure instanceof MobileContentPersistenceError, '坏信封和close故障不能成功返回或换成其它异常。');
    assert.deepEqual(closes, { file: 1, directory: 1 }); assert.equal(owned.size, 0); assert.equal(closed.length, 2);
    for (const fd of closed) assert.throws(() => fs.fstatSync(fd), error => (error as NodeJS.ErrnoException).code === 'EBADF');
    assert.equal(failure.status, 503); assert.equal(failure.code, 'BUSY'); assert.equal(failure.outcome, 'not-sent'); assert.equal(failure.commitId, null);
    return { status: failure.status, code: failure.code, outcome: failure.outcome, commitId: failure.commitId };
  }
  try {
    syncBuiltinESMExports();
    const original = loadFailure(); assert.equal(frames.length, 0, '无私有诊断ctx时不生成记录。');
    const observed = loadFailure(context); assert.deepEqual(observed, original, '诊断不得替换原load映射结果或关闭次数。');
  } finally {
    closeMobileCapabilityContext(context);
    const errors: unknown[] = [];
    for (const restore of [() => closing.mock.restore(), () => opened.mock.restore(), () => syncBuiltinESMExports()]) {
      try { restore(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '合成fs观察未完全恢复。', { cause: errors[0] });
  }
  const snapshot = collector.snapshot(); assert.ok(copyMobileCapabilityTraceSnapshot(snapshot));
  assert.equal(snapshot.droppedRecords, 0); assert.equal(snapshot.firstBusinessFailures.length, 1); assert.equal(snapshot.cleanupFailures.length, 2);
  assert.equal(snapshot.firstBusinessFailures[0]!.stage, 'owner.store.envelope');
  assert.deepEqual(snapshot.cleanupFailures.map(row => row.stage), ['owner.store.file.close', 'owner.store.directory.close']);
  const rejects = snapshot.records.filter(row => row.phase === 'reject'), first = rejects.findIndex(row => row.stage === 'owner.store.envelope');
  const fileCleanup = rejects.findIndex(row => row.stage === 'owner.store.file.close'), directoryCleanup = rejects.findIndex(row => row.stage === 'owner.store.directory.close');
  assert.ok(first >= 0 && fileCleanup > first && directoryCleanup > fileCleanup, '首业务拒绝必须早于两个原finally的清理拒绝。');
  for (const row of snapshot.records) {
    assert.equal(row.component, 'owner'); assert.equal(row.requestSha256, mobileCapabilityRequestSha('owner', requestId)); assert.equal(row.parentSha256, parentSha256);
    assert.ok(Number.isSafeInteger(row.epochMs) && row.epochMs > 0); assert.ok(Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0);
  }
  assert.ok(snapshot.cleanupFailures.every(row => row.role === 'cleanup' && row.code === 'EIO'));
  const serialized = frames.join('');
  for (const privateText of [requestId, datasetId, serverId, directory, invalidEnvelope.toString('utf8'), fileCloseError.message, directoryCloseError.message]) assert.equal(serialized.includes(privateText), false);
  assert.equal(decrypts, 0, '坏信封应在实际decrypt之前首拒，不能为诊断继续读取状态。');
  assert.deepEqual(fs.readFileSync(file), invalidEnvelope);
  const after = fs.lstatSync(file, { bigint: true }), axes = (value: typeof identity) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs];
  assert.deepEqual(axes(after), axes(identity));
});
