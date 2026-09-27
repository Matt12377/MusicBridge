import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { ReadonlyAudioReader } from './readonly-audio-consumer.js';
import { pumpOutputDevicePcm } from './output-device-pump.js';
import { verifyPinnedDeviceOutputHelper, type PinnedDeviceOutputHelper } from './bundled-device-output-helper.js';
import {
  createDeviceOutputEventDecoder, encodeDeviceOutputControl, encodeDeviceOutputHeader,
  type DeviceOutputHeader, type DeviceOutputEvent,
} from './device-output-protocol.js';

export class DeviceOutputRunError extends Error {
  constructor(readonly code: 'CANCELLED' | 'TIMEOUT' | 'INPUT_CHANGED' | 'ROUTE_CHANGED' | 'PROTOCOL' | 'UNAVAILABLE' | 'BACKEND_FAILURE') {
    super(`正式设备输出未完成。 [${code}]`);
  }
}
/** 仅decoder.finish(exitCode)在child.close后验证通过才有值；普通进度不能代替终态消费游标。 */
export interface DeviceOutputTerminalFact {
  kind: 'completed' | 'cancelled' | 'failed'; suppliedFrames: number; consumedFrames: number;
}
export interface DeviceOutputRunCallbacks {
  onProgress(progress: { suppliedFrames: number; consumedFrames: number; zeroFilledFrames: number }): void;
  onSourceEof(): void;
  /** 仅记录HAL时间线候选；child.close及重新核pin前绝不通知领域层完成。 */
  onDrainObserved(): void;
  /** child.close与Core供帧任务静止后的独立收口事实；Stop ACK只取已验证原生终态。 */
  onCleanup(facts: { engineCutoff: true; stopAcknowledged: boolean; cleanupQuiescent: true;
    terminal: DeviceOutputTerminalFact | null }): void;
  onComplete(): void;
  onFailure(error: DeviceOutputRunError): void;
}
export interface DeviceOutputRunHandle {
  stop(): Promise<void>;
  /** 只在 child.close 且Core供帧任务已静止后resolve；失败也不能提前释放输入租期。 */
  close(): Promise<void>;
}
export interface DeviceOutputRunnerOptions {
  launch?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Formal专用：已fsync的精确run租约fd传至原生fd4，Runner接管父进程副本关闭。 */
  lease?: { readonly fd: number; close(): Promise<void> };
  readyTimeoutMs?: number; stopTimeoutMs?: number; checkIntervalMs?: number;
}
const err = (code: DeviceOutputRunError['code']) => new DeviceOutputRunError(code);
const safe = (error: unknown): DeviceOutputRunError => error instanceof DeviceOutputRunError ? error : err('BACKEND_FAILURE');
const bounded = (value: number | undefined, fallback: number, maximum = fallback): number => {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) throw err('PROTOCOL');
  return actual;
};
const nativeFailure = (event: DeviceOutputEvent): DeviceOutputRunError =>
  event.kind === 7 ? err('CANCELLED') : event.code === 5 ? err('ROUTE_CHANGED')
    : event.code === 8 || event.code === 9 ? err('INPUT_CHANGED')
      : event.code === 10 ? err('TIMEOUT') : event.code === 12 ? err('PROTOCOL') : err('BACKEND_FAILURE');

/** 单run单进程；调用方必须先按header scope完成正式Gate B或普通Playback独立准入。 */
export async function startDeviceOutputRun(pin: PinnedDeviceOutputHelper, input: {
  header: DeviceOutputHeader; reader: ReadonlyAudioReader; signal: AbortSignal; checkOperation(): void; callbacks: DeviceOutputRunCallbacks;
}, options: DeviceOutputRunnerOptions = {}): Promise<DeviceOutputRunHandle> {
  const pinned = Object.freeze({ ...pin });
  const { header, reader, signal, checkOperation, callbacks } = input;
  let leaseClosed = false;
  const closeLease = async () => {
    if (leaseClosed || !options.lease) return;
    leaseClosed = true; await options.lease.close();
  };
  let readyMs: number, stopMs: number, checkMs: number, durationMs: number, bytes: Buffer;
  let decoder: ReturnType<typeof createDeviceOutputEventDecoder>, child: ChildProcess;
  try {
    readyMs = bounded(options.readyTimeoutMs, 15_000); stopMs = bounded(options.stopTimeoutMs, 1_000);
    checkMs = bounded(options.checkIntervalMs, 50, 100);
    durationMs = Math.ceil(header.frameCount * 1000 / header.sampleRate);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 6 * 60 * 60_000
      || reader.descriptor.frameCount !== header.frameCount || reader.descriptor.channelCount !== header.channelCount
      || reader.descriptor.sampleFormat !== header.format) throw err('PROTOCOL');
    bytes = encodeDeviceOutputHeader(header);
    if (header.scope === 'formal-recording' && !options.launch && (!options.lease || !Number.isSafeInteger(options.lease.fd)
      || options.lease.fd < 0)) throw err('UNAVAILABLE');
    if (signal.aborted) throw err('CANCELLED');
    checkOperation(); await verifyPinnedDeviceOutputHelper(pinned);
    if (signal.aborted) throw err('CANCELLED');
    checkOperation();
    decoder = createDeviceOutputEventDecoder({ runId: header.runId, frameCount: header.frameCount, tailFrames: header.tailFrames });
    try { child = (options.launch ?? spawn)(pinned.path, [], { shell: false, env: { LANG: 'C', LC_ALL: 'C' },
      stdio: options.lease ? ['pipe', 'pipe', 'pipe', 'pipe', options.lease.fd] : ['pipe', 'pipe', 'pipe', 'pipe'] }); }
    catch { throw err('UNAVAILABLE'); }
  } catch (cause) {
    try { await closeLease(); } catch { /* 无子进程，保留原失败并阻断新输出。 */ }
    // 从未创建子进程：没有软件输出可继续提交，也没有可伪造的原生Stop ACK。
    try { callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: false, cleanupQuiescent: true,
      terminal: null }); } catch { /* 保留原失败。 */ }
    throw cause;
  }
  let resolveReady!: (handle: DeviceOutputRunHandle) => void, rejectReady!: (error: DeviceOutputRunError) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<DeviceOutputRunHandle>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  const pcm = child.stdio[3] as Writable | null;
  let readyResolved = false, childClosed = false, stopping = false, runSent = false, terminal: DeviceOutputEvent | undefined;
  let failure: DeviceOutputRunError | undefined, pumpFailure: DeviceOutputRunError | undefined;
  let pumpReceipt: { suppliedFrames: number; suppliedPcmSha256: string } | undefined;
  let stdoutBytes = 0, stderrBytes = 0, pump: Promise<unknown> = Promise.resolve();
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineMs = durationMs + 60_000;
  const kill = () => { if (!childClosed) { try { child.kill('SIGKILL'); } catch { /* 只有close能释放租期。 */ } } };
  const writeControl = (operation: 'run' | 'cancel'): void => {
    try { child.stdin?.write(encodeDeviceOutputControl(header.runId, operation, operation === 'run' ? 1 : runSent ? 2 : 1), error => {
      if (error) fail(err('PROTOCOL'), true);
    }); } catch { fail(err('PROTOCOL'), true); }
  };
  const fail = (cause: unknown, immediate = false): void => {
    if (childClosed) return;
    failure ??= safe(cause); local.abort(failure);
    if (immediate) { kill(); return; }
    if (stopping) return;
    stopping = true; writeControl('cancel'); stopTimer = setTimeout(kill, stopMs);
  };
  // spawn已把同一打开文件描述继承给子进程；父副本仅close，绝不LOCK_UN。
  void closeLease().catch(() => fail(err('UNAVAILABLE'), true));
  const handle: DeviceOutputRunHandle = {
    async stop() { if (!childClosed && !terminal) fail(err('CANCELLED')); },
    async close() { if (!childClosed && !terminal) fail(err('CANCELLED')); await closed; },
  };
  const progress = (event: DeviceOutputEvent): void => callbacks.onProgress({ suppliedFrames: event.suppliedFrames,
    consumedFrames: event.consumedFrames, zeroFilledFrames: event.zeroFilledFrames });
  const writePcm = (chunk: Buffer): Promise<void> => new Promise((resolve, reject) => {
    if (!pcm || pcm.destroyed || combined.aborted) { reject(err('CANCELLED')); return; }
    const onClosed = () => { cleanup(); reject(err('UNAVAILABLE')); };
    const cleanup = () => { pcm.off('close', onClosed); };
    pcm.once('close', onClosed);
    try { pcm.write(chunk, error => { cleanup(); error ? reject(err('UNAVAILABLE')) : resolve(); }); }
    catch { cleanup(); reject(err('UNAVAILABLE')); }
  });
  const onStdout = (chunk: Buffer) => {
    if (childClosed) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > 20 * 1024 * 1024) { fail(err('PROTOCOL'), true); return; }
    try {
      const events = decoder.push(chunk);
      for (const event of events) {
        // 取消后仍需验证原生终态，才能区分真实Stop ACK与仅child.close的静止。
        // 失败路径不再发布可能迟到的进度、EOF或候选drain。
        if (failure) {
          if (event.kind === 6 || event.kind === 7 || event.kind === 8) terminal = event;
          continue;
        }
        if (event.kind === 2) {
          runSent = true; writeControl('run');
          pump = pumpOutputDevicePcm({ reader, expectedPcmSha256: header.pcmSha256, signal: combined,
            checkOperation, writeChunk: writePcm }).then(receipt => {
            pumpReceipt = receipt; pcm?.end();
          }, cause => {
            pumpFailure = cause instanceof Error && 'code' in cause && cause.code === 'INPUT_CHANGED' ? err('INPUT_CHANGED') : safe(cause);
            failure ??= pumpFailure; fail(pumpFailure);
          });
        } else if (event.kind === 3) {
          progress(event); readyResolved = true; resolveReady(handle);
        } else if (event.kind === 9) progress(event);
        else if (event.kind === 4) { progress(event); callbacks.onSourceEof(); }
        else if (event.kind === 5) { progress(event); callbacks.onDrainObserved(); }
        else if (event.kind === 6 || event.kind === 7 || event.kind === 8) terminal = event;
      }
    } catch (cause) { fail(cause instanceof DeviceOutputRunError ? cause : err('PROTOCOL'), true); }
  };
  const onError = () => fail(err('UNAVAILABLE'), true);
  const onStderr = (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16 * 1024) fail(err('PROTOCOL'), true); };
  const onAbort = () => fail(err('CANCELLED'));
  const readyTimer = setTimeout(() => { if (!readyResolved) fail(err('TIMEOUT')); }, readyMs);
  const operationTimer = setTimeout(() => fail(err('TIMEOUT')), deadlineMs);
  const checkTimer = setInterval(() => {
    try { if (signal.aborted) fail(err('CANCELLED')); else checkOperation(); }
    catch { fail(err('BACKEND_FAILURE')); }
  }, checkMs);
  child.once('close', code => {
    if (childClosed) return; childClosed = true; local.abort(err('CANCELLED')); pcm?.destroy();
    clearTimeout(readyTimer); clearTimeout(operationTimer); clearTimeout(stopTimer); clearInterval(checkTimer);
    signal.removeEventListener('abort', onAbort);
    child.stdout?.off('data', onStdout); child.stderr?.off('data', onStderr);
    child.stdout?.off('error', onError); child.stderr?.off('error', onError);
    child.stdin?.off('error', onError); pcm?.off('error', onError); child.off('error', onError);
    void (async () => {
      try { await pump; } catch { failure ??= err('INPUT_CHANGED'); }
      failure ??= pumpFailure;
      if (!pumpReceipt || pumpReceipt.suppliedFrames !== header.frameCount || pumpReceipt.suppliedPcmSha256 !== header.pcmSha256)
        failure ??= err('INPUT_CHANGED');
      let final: DeviceOutputEvent | undefined;
      try {
        final = decoder.finish(code);
        if (final.kind !== 6) failure ??= nativeFailure(final);
        else if (failure) { /* 已取消或范围失效，旧成功帧不得覆盖失败。 */ }
        else await verifyPinnedDeviceOutputHelper(pinned);
      } catch { failure ??= err('PROTOCOL'); }
      if (signal.aborted) failure ??= err('CANCELLED');
      if (!failure) { try { checkOperation(); } catch { failure = err('BACKEND_FAILURE'); } }
      // 只以进程退出+供帧任务静止发布cutoff/quiescent；ACK必须来自协议验证后的原生终态。
      const terminalFact: DeviceOutputTerminalFact | null = final ? {
        kind: final.kind === 6 ? 'completed' : final.kind === 7 ? 'cancelled' : 'failed',
        suppliedFrames: final.suppliedFrames, consumedFrames: final.consumedFrames,
      } : null;
      try { callbacks.onCleanup({ engineCutoff: true, stopAcknowledged: final?.stopAcknowledged === true,
        cleanupQuiescent: true, terminal: terminalFact }); } catch { failure ??= err('BACKEND_FAILURE'); }
      resolveClosed();
      if (!readyResolved) rejectReady(failure ?? err('PROTOCOL'));
      else queueMicrotask(() => {
        if (signal.aborted) failure ??= err('CANCELLED');
        if (!failure) { try { checkOperation(); } catch { failure = err('BACKEND_FAILURE'); } }
        if (failure) callbacks.onFailure(failure);
        else { callbacks.onProgress({ suppliedFrames: header.frameCount, consumedFrames: header.frameCount,
          zeroFilledFrames: terminal?.zeroFilledFrames ?? 0 }); callbacks.onComplete(); }
      });
    })();
  });
  child.on('error', onError); child.stdin?.on('error', onError); child.stdout?.on('error', onError);
  child.stderr?.on('error', onError); pcm?.on('error', onError);
  child.stdout?.on('data', onStdout); child.stderr?.on('data', onStderr);
  signal.addEventListener('abort', onAbort, { once: true });
  if (!child.stdin || !child.stdout || !child.stderr || !pcm) fail(err('UNAVAILABLE'), true);
  else {
    try { child.stdin.write(bytes, error => { if (error) fail(err('PROTOCOL'), true); }); }
    catch { fail(err('UNAVAILABLE'), true); }
  }
  if (signal.aborted) onAbort();
  return ready;
}
