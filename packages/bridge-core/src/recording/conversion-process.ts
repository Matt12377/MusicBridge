import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export type ConversionFailure = 'INVALID_INPUT' | 'BACKEND_UNAVAILABLE' | 'BACKEND_CHANGED' | 'UNSUPPORTED_CONVERSION' | 'DECODE_FAILED' | 'CONVERSION_FAILED' | 'FRAME_MISMATCH' | 'INPUT_CHANGED' | 'SOURCE_UNAVAILABLE' | 'HASH_MISMATCH' | 'INVALID_OUTPUT' | 'IO_ERROR' | 'DISK_FULL' | 'CANCELLED' | 'LIMIT_EXCEEDED';
export class AudioConversionError extends Error { constructor(readonly code: ConversionFailure) { super(code); } }
export const conversionFail = (code: ConversionFailure): never => { throw new AudioConversionError(code); };
export interface ConverterFilePin { path: string; sha256: string }

/** 所有路径均来自 Core 的固定构建清单，不接受 Renderer 命令或 PATH 搜索。 */
export async function verifyConverterFile(pin: ConverterFilePin, check: () => void): Promise<void> {
  check();
  if (!path.isAbsolute(pin.path) || !/^[a-f0-9]{64}$/u.test(pin.sha256)) return conversionFail('INVALID_INPUT');
  try {
    if (await realpath(pin.path) !== pin.path) return conversionFail('BACKEND_CHANGED');
    const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > 512n * 1024n * 1024n || (before.mode & 0o022n) !== 0n) return conversionFail('BACKEND_CHANGED');
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < Number(before.size)) {
        check(); const result = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
        if (!result.bytesRead) return conversionFail('BACKEND_CHANGED');
        hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true }); check();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || hash.digest('hex') !== pin.sha256 || await realpath(pin.path) !== pin.path) return conversionFail('BACKEND_CHANGED');
      const named = await lstat(pin.path, { bigint: true });
      if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size || named.mtimeNs !== before.mtimeNs || named.ctimeNs !== before.ctimeNs) return conversionFail('BACKEND_CHANGED');
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof AudioConversionError) throw error;
    return conversionFail('BACKEND_UNAVAILABLE');
  }
}

/** 不保留 stderr 原文。等待进程关闭后才返回，取消或超时不能留下后台写者。 */
export async function runConverterProcess(executable: string, args: readonly string[], descriptors: readonly number[], check: () => void, failure: ConversionFailure, onLine?: (line: string) => void): Promise<string> {
  check();
  const child = spawn(executable, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe', ...descriptors], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  let output = '', pending = '', stderrBytes = 0, error: unknown;
  const stop = (reason: unknown): void => { error ??= reason; child.kill('SIGKILL'); };
  const guarded = (action: () => void): void => { try { check(); action(); } catch (reason) { stop(reason); } };
  const timer = setInterval(() => guarded(() => undefined), 25);
  child.stdout?.on('data', (bytes: Buffer) => guarded(() => {
    if (!onLine) {
      if (Buffer.byteLength(output) + bytes.length > 256 * 1024) return conversionFail('LIMIT_EXCEEDED');
      output += bytes.toString('utf8'); return;
    }
    pending += bytes.toString('utf8');
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      check(); if (newline > 4096) return conversionFail('LIMIT_EXCEEDED');
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (line) onLine(line);
    }
    if (pending.length > 4096) return conversionFail('LIMIT_EXCEEDED');
  }));
  child.stderr?.on('data', (bytes: Buffer) => guarded(() => {
    stderrBytes += bytes.length;
    if (stderrBytes > 64 * 1024) return conversionFail('LIMIT_EXCEEDED');
  }));
  try {
    const code = await new Promise<number | null>(resolve => {
      child.once('error', () => stop(new AudioConversionError('BACKEND_UNAVAILABLE')));
      child.once('close', resolve);
    });
    if (error) throw error;
    check(); if (code !== 0 || stderrBytes > 0) return conversionFail(failure);
    if (pending) { if (!onLine) return conversionFail(failure); onLine(pending); }
    return output;
  } finally { clearInterval(timer); }
}
