import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { verifyPinnedOutputHelper, type PinnedOutputHelper } from './bundled-output-helper.js';
import type { RecordingOutputRunner } from './output-input.js';
import { OutputCheckError, outputCheckFail } from './output-error.js';
import { createOutputEventDecoder, encodeOutputControl, encodeOutputHeader } from './output-protocol.js';

export interface OutputHelperRunnerOptions {
  acceptedTimeoutMs?: number;
  operationTimeoutMs?: number;
  stopTimeoutMs?: number;
  checkIntervalMs?: number;
  /** 只供可信测试注入，公开DTO没有启动参数或进程工厂。 */
  launch?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
}
const bounded = (value: number | undefined, fallback: number, maximum = fallback): number => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) return outputCheckFail('INVALID_REQUEST');
  return n;
};
const safeError = (error: unknown): OutputCheckError => error instanceof OutputCheckError ? error : new OutputCheckError('HELPER_UNAVAILABLE');

/** 唯一启动目标为已pin的合成helper；FD租期由调用者持有，任何终态都必须等child close。 */
export function createOutputHelperRunner(pin: PinnedOutputHelper, options: OutputHelperRunnerOptions = {}): RecordingOutputRunner {
  const acceptedMs = bounded(options.acceptedTimeoutMs, 5000), operationMs = bounded(options.operationTimeoutMs, 15 * 60_000);
  const stopMs = bounded(options.stopTimeoutMs, 1000), checkMs = bounded(options.checkIntervalMs, 50, 100);
  const launch = options.launch ?? spawn;
  // 防止可信调用方意外改变对象，使一次运行前后的pin指向不同构建。
  const pinned = Object.freeze({ ...pin });
  return {
    async run(input) {
      const deadline = performance.now() + operationMs;
      const check = (): void => {
        if (input.signal.aborted) throw input.signal.reason instanceof OutputCheckError ? input.signal.reason : new OutputCheckError('CANCELLED');
        if (performance.now() >= deadline) return outputCheckFail('TIMEOUT');
        try { input.checkOperation(); } catch (error) { throw safeError(error); }
      };
      check();
      const header = encodeOutputHeader(input);
      await verifyPinnedOutputHelper(pinned); check();
      const decoder = createOutputEventDecoder({ runId: input.identity.runId, frameCount: input.audio.frameCount, pcmSha256: input.audio.pcmSha256 });
      let child: ChildProcess;
      try {
        child = launch(pinned.path, [], { shell: false, env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe', input.handle.fd] });
      } catch { return outputCheckFail('HELPER_UNAVAILABLE'); }
      return new Promise<Awaited<ReturnType<RecordingOutputRunner['run']>>>((resolve, reject) => {
        let failure: OutputCheckError | undefined, closed = false, killed = false, stopping = false, runSent = false, accepted = false, stderrBytes = 0, stdoutBytes = 0;
        let acceptedTimer: ReturnType<typeof setTimeout> | undefined, operationTimer: ReturnType<typeof setTimeout> | undefined;
        let stopTimer: ReturnType<typeof setTimeout> | undefined, checkTimer: ReturnType<typeof setInterval> | undefined;
        const kill = (): void => {
          if (closed || killed) return; killed = true;
          try { child.kill('SIGKILL'); } catch { /* 即使kill失败也不提前释放FD；close才是子进程租期终点。 */ }
        };
        const write = (bytes: Buffer): void => {
          try { child.stdin?.write(bytes, error => { if (error) fail(new OutputCheckError('HELPER_UNAVAILABLE'), true); }); }
          catch { fail(new OutputCheckError('HELPER_UNAVAILABLE'), true); }
        };
        const fail = (error: unknown, immediate = false): void => {
          if (closed) return;
          failure ??= safeError(error);
          if (immediate) { kill(); return; }
          if (stopping || killed) return;
          stopping = true;
          write(encodeOutputControl(input.identity.runId, 'stop', runSent ? 2 : 1));
          stopTimer = setTimeout(kill, stopMs);
        };
        const onAbort = (): void => {
          fail(input.signal.reason instanceof OutputCheckError ? input.signal.reason : new OutputCheckError('CANCELLED'));
        };
        const onError = (): void => fail(new OutputCheckError('HELPER_UNAVAILABLE'), true);
        const onStdout = (chunk: Buffer): void => {
          if (closed) return;
          stdoutBytes += chunk.length;
          if (stdoutBytes > 1024) { fail(new OutputCheckError('HELPER_PROTOCOL'), true); return; }
          if (failure) return;
          try {
            check();
            const events = decoder.push(chunk);
            // 同一已收到的数据块不可能响应尚未发出的RUN，防止一次伪造整条成功序列。
            if (!runSent && events.some(event => event.kind >= 3 && event.kind <= 5)) return fail(new OutputCheckError('HELPER_PROTOCOL'), true);
            for (const event of events) {
              if (event.kind === 1) { accepted = true; clearTimeout(acceptedTimer); }
              if (event.kind === 2 && !runSent && !stopping) {
                check(); runSent = true; write(encodeOutputControl(input.identity.runId, 'run', 1));
              }
            }
          } catch (error) { fail(error, true); }
        };
        const onStderr = (chunk: Buffer): void => {
          stderrBytes += chunk.length;
          if (stderrBytes > 16 * 1024) fail(new OutputCheckError('HELPER_PROTOCOL'), true);
        };
        const cleanup = (): void => {
          clearTimeout(acceptedTimer); clearTimeout(operationTimer); clearTimeout(stopTimer); clearInterval(checkTimer);
          input.signal.removeEventListener('abort', onAbort);
          child.stdout?.off('data', onStdout); child.stderr?.off('data', onStderr);
          child.stdout?.off('error', onError); child.stderr?.off('error', onError); child.stdin?.off('error', onError);
          child.off('error', onError);
        };
        const onClose = (code: number | null): void => {
          if (closed) return; closed = true; cleanup();
          // exit不代表stdio关闭；只有close之后才验终态和构建身份，随后交还外层FD租期。
          void (async () => {
            if (failure) throw failure;
            const result = decoder.finish(code); check();
            await verifyPinnedOutputHelper(pinned); check();
            return { ...result, helperSha256: pinned.sha256 };
          })().then(resolve, error => reject(safeError(error)));
        };
        child.once('close', onClose); child.on('error', onError);
        child.stdin?.on('error', onError); child.stdout?.on('error', onError); child.stderr?.on('error', onError);
        child.stdout?.on('data', onStdout); child.stderr?.on('data', onStderr);
        input.signal.addEventListener('abort', onAbort, { once: true });
        acceptedTimer = setTimeout(() => { if (!accepted) fail(new OutputCheckError('TIMEOUT')); }, acceptedMs);
        operationTimer = setTimeout(() => fail(new OutputCheckError('TIMEOUT')), Math.max(1, deadline - performance.now()));
        checkTimer = setInterval(() => { try { check(); } catch (error) { fail(error); } }, checkMs);
        if (!child.stdin || !child.stdout || !child.stderr) { fail(new OutputCheckError('HELPER_UNAVAILABLE'), true); return; }
        write(header);
        // 添加监听器前后取消均有效，首header先于STOP，且绝不在取消后发送RUN。
        try { check(); } catch (error) { fail(error); }
      });
    },
  };
}
