import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { startDeviceOutputRun } from '../src/recording/device-output-runner.js';
import type { PinnedDeviceOutputHelper } from '../src/recording/bundled-device-output-helper.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function event(runId: string, kind: number, sequence: number, supplied: number, consumed: number, zero: number,
  flags: { code?: number; eof?: boolean; drained?: boolean; stop?: boolean; destroy?: boolean; started?: boolean } = {}): Buffer {
  const bytes = Buffer.alloc(64); bytes.write('MBDE'); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(kind, 6);
  bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(flags.code ?? 0, 12);
  Buffer.from(runId.replaceAll('-', ''), 'hex').copy(bytes, 16);
  bytes.writeBigUInt64LE(BigInt(supplied), 32); bytes.writeBigUInt64LE(BigInt(consumed), 40); bytes.writeBigUInt64LE(BigInt(zero), 48);
  bytes[56] = Number(!!flags.eof); bytes[57] = Number(!!flags.drained); bytes[58] = Number(!!flags.stop);
  bytes[59] = Number(!!flags.destroy); bytes[61] = Number(!!flags.started); return bytes;
}
class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly pcm = new PassThrough(); readonly stdio = [this.stdin, this.stdout, this.stderr, this.pcm];
  readonly runId: string; private header = Buffer.alloc(0); private sequence = 0;
  private runRequested = false; private framesReceived = 0; private closed = false;
  constructor(runId: string, private readonly options: { prematureSuccess?: boolean; afterClose?: () => void } = {}) {
    super(); this.runId = runId;
    this.stdin.on('data', (chunk: Buffer) => {
      this.header = Buffer.concat([this.header, chunk]);
      if (this.header.length >= 320 && this.sequence === 0) {
        assert.equal(this.header.toString('ascii', 0, 4), 'MBOD');
        this.send(1, 0, 0, 0); this.send(2, 0, 0, 0);
        this.header = this.header.subarray(320);
      }
      if (this.header.length >= 32 && !this.runRequested) {
        assert.equal(this.header.toString('ascii', 0, 4), 'MBDC');
        assert.equal(this.header.readUInt16LE(6), 1); this.runRequested = true;
        if (this.options.prematureSuccess) {
          this.send(3, 8, 0, 0, { started: true });
          this.send(4, 8, 0, 0, { started: true, eof: true });
          this.send(5, 8, 8, 16, { started: true, eof: true, drained: true });
          this.send(6, 8, 8, 16, { started: true, eof: true, drained: true, stop: true, destroy: true });
          queueMicrotask(() => { this.closed = true; this.emit('close', 0); this.options.afterClose?.(); });
        }
      }
    });
    this.pcm.on('data', (bytes: Buffer) => {
      this.framesReceived += bytes.length / 4;
      if (this.runRequested && this.framesReceived === 8 && this.sequence === 2) this.send(3, 8, 0, 0, { started: true });
    });
    this.pcm.on('end', () => {
      assert.equal(this.framesReceived, 8);
      this.send(9, 8, 8, 16, { started: true });
      this.send(4, 8, 8, 16, { started: true, eof: true });
      this.send(5, 8, 8, 16, { started: true, eof: true, drained: true });
      this.send(6, 8, 8, 16, { started: true, eof: true, drained: true, stop: true, destroy: true });
      queueMicrotask(() => { this.closed = true; this.emit('close', 0); this.options.afterClose?.(); });
    });
  }
  private send(kind: number, supplied: number, consumed: number, zero: number,
    flags: { eof?: boolean; drained?: boolean; stop?: boolean; destroy?: boolean; started?: boolean } = {}) {
    this.stdout.write(event(this.runId, kind, ++this.sequence, supplied, consumed, zero, flags));
  }
  kill() { if (!this.closed) { this.closed = true; queueMicrotask(() => this.emit('close', null)); } return true; }
}

class FakeFailureProcess extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly pcm = new PassThrough(); readonly stdio = [this.stdin, this.stdout, this.stderr, this.pcm];
  private input = Buffer.alloc(0); private headerReceived = false; private sequence = 0; private closed = false;
  constructor(private readonly runId: string, private readonly outcome: 'cancel' | 'cancel-late-consumption' | 'route-failure' | 'missing-terminal') {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.input = Buffer.concat([this.input, chunk]);
      if (!this.headerReceived && this.input.length >= 320) {
        this.headerReceived = true; this.input = this.input.subarray(320);
        this.send(1); this.send(2);
      }
      while (this.headerReceived && this.input.length >= 32) {
        const control = this.input.subarray(0, 32); this.input = this.input.subarray(32);
        assert.equal(control.toString('ascii', 0, 4), 'MBDC');
        if (control.readUInt16LE(6) === 1) {
          this.send(3, { started: true });
          if (this.outcome === 'route-failure') setImmediate(() => {
            this.send(8, { code: 5, started: true, destroy: true }); this.closeWith(1);
          });
          else if (this.outcome === 'missing-terminal') setImmediate(() => this.closeWith(0));
        } else if (control.readUInt16LE(6) === 2 && (this.outcome === 'cancel' || this.outcome === 'cancel-late-consumption')) {
          this.send(7, { code: 11, started: true, stop: true, destroy: true },
            this.outcome === 'cancel-late-consumption' ? 8 : 0, this.outcome === 'cancel-late-consumption' ? 4 : 0);
          this.closeWith(2);
        }
      }
    });
  }
  private send(kind: number, flags: { code?: number; started?: boolean; stop?: boolean; destroy?: boolean } = {}, supplied = 0, consumed = 0) {
    this.stdout.write(event(this.runId, kind, ++this.sequence, supplied, consumed, 0, flags));
  }
  private closeWith(code: number | null) {
    if (this.closed) return;
    this.closed = true; queueMicrotask(() => this.emit('close', code));
  }
  kill() { this.closeWith(null); return true; }
}

async function makePin(): Promise<PinnedDeviceOutputHelper> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-device-runner-'));
  const helper = path.join(directory, 'helper'), manifest = path.join(directory, 'manifest.json');
  const helperBytes = Buffer.from('受控Fake文件，launch不会执行它'), manifestBytes = Buffer.from('{}');
  await writeFile(helper, helperBytes); await chmod(helper, 0o755); await writeFile(manifest, manifestBytes);
  return { path: helper, sha256: sha(helperBytes), manifestPath: manifest,
    manifestSha256: sha(manifestBytes), sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
}

const pcm = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const header = (runId: string) => ({ runId, uid: 'fake-device', sampleRate: 48000, channelCount: 2 as const,
  format: 'pcm-s16le' as const, bufferFrames: 16, capacityFrames: 32, frameCount: 8, tailFrames: 16,
  minimumZeroCallbacks: 2, scope: 'formal-recording' as const, recordSha256: 'b'.repeat(64), pcmSha256: sha(pcm) });
const reader = () => ({ descriptor: { dataOffset: 44, frameCount: 8, channelCount: 2 as const, sampleFormat: 'pcm-s16le' as const },
  async readFrames(start: number, frames: number) {
    assert.equal(start, 0); assert.equal(frames, 8); return { bytes: pcm, frames: 8, sourceEof: true };
  } });

test('Runner 只在 helper 终态+child.close+pin复核后发布完成，并从原生帧事实发布进度', async () => {
  const pin = await makePin(), runId = randomUUID();
  const progress: number[] = [], phases: string[] = [];
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const handle = await startDeviceOutputRun(pin, {
    header: header(runId), reader: reader(),
    signal: new AbortController().signal, checkOperation() {}, callbacks: {
      onProgress(value) { progress.push(value.consumedFrames); }, onSourceEof() { phases.push('eof'); },
      onDrainObserved() { phases.push('drain-candidate'); },
      onCleanup(facts) { assert.deepEqual(facts, { engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
        terminal: { kind: 'completed', suppliedFrames: 8, consumedFrames: 8 } }); phases.push('closed-cleanup'); },
      onComplete() { phases.push('closed-complete'); finish(); },
      onFailure(error) { assert.fail(`意外失败：${error.code}`); },
    },
  }, { launch: () => new FakeProcess(runId) as unknown as ChildProcess });
  await completed; await handle.close();
  assert.deepEqual(progress, [0, 8, 8, 8, 8]);
  assert.deepEqual(phases, ['eof', 'drain-candidate', 'closed-cleanup', 'closed-complete']);
});

test('Runner 拒绝 helper 伪终态：Core 供帧未完成时不得发布成功', async () => {
  const pin = await makePin(), runId = randomUUID();
  const failures: string[] = [], completed: string[] = [];
  let releaseReader!: () => void;
  const readerGate = new Promise<void>(resolve => { releaseReader = resolve; });
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const handle = await startDeviceOutputRun(pin, {
    header: header(runId), reader: { ...reader(), async readFrames() { await readerGate; return { bytes: pcm, frames: 8, sourceEof: true }; } },
    signal: new AbortController().signal, checkOperation() {}, callbacks: {
      onProgress() {}, onSourceEof() {}, onDrainObserved() {}, onCleanup() {},
      onComplete() { completed.push('complete'); settle(); },
      onFailure(error) { failures.push(error.code); settle(); },
    },
  }, { launch: () => new FakeProcess(runId, { prematureSuccess: true }) as unknown as ChildProcess });
  releaseReader();
  await settled; await handle.close();
  assert.deepEqual(completed, []);
  assert.equal(failures.length, 1);
});

test('Runner 在 child.close 后异步结算期间撤权，不能发布迟到成功', async () => {
  const pin = await makePin(), runId = randomUUID(), controller = new AbortController();
  const failures: string[] = [], completed: string[] = [];
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const handle = await startDeviceOutputRun(pin, {
    header: header(runId), reader: reader(), signal: controller.signal, checkOperation() {}, callbacks: {
      onProgress() {}, onSourceEof() {}, onDrainObserved() {}, onCleanup() {},
      onComplete() { completed.push('complete'); settle(); },
      onFailure(error) { failures.push(error.code); settle(); },
    },
  }, { launch: () => new FakeProcess(runId, { afterClose: () => controller.abort() }) as unknown as ChildProcess });
  await settled; await handle.close();
  assert.deepEqual(completed, []);
  assert.deepEqual(failures, ['CANCELLED']);
});

test('Runner 启动前失败只报告软件静止，不伪造原生Stop ACK、EOF或drain', async () => {
  const pin = await makePin(), events: string[] = [];
  await assert.rejects(startDeviceOutputRun(pin, {
    header: header(randomUUID()), reader: reader(), signal: new AbortController().signal, checkOperation() {},
    callbacks: {
      onProgress() { events.push('progress'); }, onSourceEof() { events.push('eof'); },
      onDrainObserved() { events.push('drain'); },
      onCleanup(facts) { assert.deepEqual(facts, { engineCutoff: true, stopAcknowledged: false, cleanupQuiescent: true,
        terminal: null }); events.push('cleanup'); },
      onComplete() { events.push('complete'); }, onFailure() { events.push('failure'); },
    },
  }, { launch() { throw new Error('受控启动失败'); } }), { code: 'UNAVAILABLE' });
  assert.deepEqual(events, ['cleanup']);
});

test('正式Runner无租约且无Fake launch时在spawn前阻断，原生入口不会被调用', async () => {
  const pin = await makePin(), events: string[] = [];
  await assert.rejects(startDeviceOutputRun(pin, {
    header: header(randomUUID()), reader: reader(), signal: new AbortController().signal, checkOperation() {},
    callbacks: { onProgress() { events.push('progress'); }, onSourceEof() { events.push('eof'); },
      onDrainObserved() { events.push('drain'); },
      onCleanup(facts) { assert.equal(facts.stopAcknowledged, false); events.push('cleanup'); },
      onComplete() { events.push('complete'); }, onFailure() { events.push('failure'); } },
  }), { code: 'UNAVAILABLE' });
  assert.deepEqual(events, ['cleanup']);
});

test('Runner 把已落盘Formal租约fd传给原生fd4，父进程只close一次', async () => {
  const pin = await makePin(), runId = randomUUID();
  let closes = 0, receivedFd: unknown, finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const handle = await startDeviceOutputRun(pin, {
    header: header(runId), reader: reader(), signal: new AbortController().signal, checkOperation() {}, callbacks: {
      onProgress() {}, onSourceEof() {}, onDrainObserved() {}, onCleanup() {},
      onComplete() { finish(); }, onFailure(error) { assert.fail(`意外失败：${error.code}`); },
    },
  }, { lease: { fd: 42, async close() { ++closes; } },
    launch(_file, _args, options) { receivedFd = (options.stdio as readonly unknown[])[4]; return new FakeProcess(runId) as unknown as ChildProcess; } });
  await completed; await handle.close();
  assert.equal(receivedFd, 42); assert.equal(closes, 1);
});

test('Runner 原生取消ACK与child.close/供帧静止分开；不补造EOF或drain', async () => {
  const pin = await makePin(), runId = randomUUID(), events: string[] = [];
  let leaseCloses = 0, inheritedFd: unknown;
  let releaseReader!: () => void, finish!: () => void;
  const readerGate = new Promise<void>(resolve => { releaseReader = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const handle = await startDeviceOutputRun(pin, {
    header: header(runId), reader: { ...reader(), async readFrames() { await readerGate; return { bytes: pcm, frames: 8, sourceEof: true }; } },
    signal: new AbortController().signal, checkOperation() {}, callbacks: {
      onProgress() { events.push('progress'); }, onSourceEof() { events.push('eof'); },
      onDrainObserved() { events.push('drain'); },
      onCleanup(facts) { assert.deepEqual(facts, { engineCutoff: true, stopAcknowledged: true, cleanupQuiescent: true,
        terminal: { kind: 'cancelled', suppliedFrames: 0, consumedFrames: 0 } }); events.push('cleanup'); },
      onComplete() { events.push('complete'); }, onFailure(error) { events.push(error.code); finish(); },
    },
  }, { lease: { fd: 43, async close() { ++leaseCloses; } },
    launch(_file, _args, options) { inheritedFd = (options.stdio as readonly unknown[])[4];
      return new FakeFailureProcess(runId, 'cancel') as unknown as ChildProcess; } });
  await handle.stop();
  assert.equal(events.includes('cleanup'), false, '供帧Promise未静止前不得回报cleanup');
  releaseReader(); await finished; await handle.close();
  assert.equal(inheritedFd, 43); assert.equal(leaseCloses, 1);
  assert.deepEqual(events, ['progress', 'cleanup', 'CANCELLED']);
});

for (const outcome of ['route-failure', 'missing-terminal'] as const) {
  test(`Runner ${outcome} 关闭后只回报cutoff/quiescent，不伪造原生ACK或drain`, async () => {
    const pin = await makePin(), runId = randomUUID(), events: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const handle = await startDeviceOutputRun(pin, {
      header: header(runId), reader: reader(), signal: new AbortController().signal, checkOperation() {}, callbacks: {
        onProgress() { events.push('progress'); }, onSourceEof() { events.push('eof'); },
        onDrainObserved() { events.push('drain'); },
        onCleanup(facts) { assert.deepEqual(facts, { engineCutoff: true, stopAcknowledged: false, cleanupQuiescent: true,
          terminal: outcome === 'route-failure' ? { kind: 'failed', suppliedFrames: 0, consumedFrames: 0 } : null }); events.push('cleanup'); },
        onComplete() { events.push('complete'); }, onFailure(error) { events.push(error.code); finish(); },
      },
    }, { launch: () => new FakeFailureProcess(runId, outcome) as unknown as ChildProcess });
    await finished; await handle.close();
    assert.deepEqual(events, ['progress', 'cleanup', outcome === 'route-failure' ? 'ROUTE_CHANGED' : 'PROTOCOL']);
  });
}

test('Runner取消后迟到消费只在验证终态中交给会话，普通进度不回放', async () => {
  const pin = await makePin(), runId = randomUUID(), progress: number[] = [];
  let terminalConsumed: number | undefined, finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const handle = await startDeviceOutputRun(pin, {
    header: header(runId), reader: reader(), signal: new AbortController().signal, checkOperation() {}, callbacks: {
      onProgress(value) { progress.push(value.consumedFrames); }, onSourceEof() { assert.fail('取消不能伪造EOF'); },
      onDrainObserved() { assert.fail('取消不能伪造drain'); },
      onCleanup(facts) {
        assert.equal(facts.stopAcknowledged, true);
        assert.deepEqual(facts.terminal, { kind: 'cancelled', suppliedFrames: 8, consumedFrames: 4 });
        terminalConsumed = facts.terminal?.consumedFrames;
      },
      onComplete() { assert.fail('取消不能完成'); }, onFailure(error) { assert.equal(error.code, 'CANCELLED'); finish(); },
    },
  }, { launch: () => new FakeFailureProcess(runId, 'cancel-late-consumption') as unknown as ChildProcess });
  await handle.stop(); await finished; await handle.close();
  assert.deepEqual(progress, [0]);
  assert.equal(terminalConsumed, 4);
});
