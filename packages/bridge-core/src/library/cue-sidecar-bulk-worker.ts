import { parentPort } from 'node:worker_threads';
import { readSync } from 'node:fs';

const port = parentPort;
if (!port) throw new Error('CUE批量读取必须由可信Owner创建。');
let busy = false;
type Reply = { kind: 'settled'; protocol: 1; requestId: string; borrowedFdReleased: true }
  & ({ status: 'ok'; bytes: Uint8Array; readCalls: number } | { status: 'failure'; code: 'BUDGET_EXCEEDED' | 'IO_ERROR' });

/** FD只存在于本次同步调用的栈；返回值不含FD，也不保存下一次可读的句柄。 */
function consume(value: unknown): Reply {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('CUE读取帧无效。');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 5 || !['kind','protocol','requestId','fd','size'].every(key => Object.hasOwn(v, key))
    || v.kind !== 'read' || v.protocol !== 1 || typeof v.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(v.requestId)
    || !Number.isSafeInteger(v.fd) || Number(v.fd) < 0 || !Number.isSafeInteger(v.size) || Number(v.size) < 1 || Number(v.size) > 65_536)
    throw new Error('CUE读取帧预算无效。');
  const base = { kind: 'settled' as const, protocol: 1 as const, requestId: v.requestId, borrowedFdReleased: true as const };
  try {
    const bytes = new Uint8Array(Number(v.size));
    let offset = 0, calls = 0;
    while (offset < bytes.length) {
      if (calls >= 64) return { ...base, status: 'failure', code: 'BUDGET_EXCEEDED' };
      const count = readSync(Number(v.fd), bytes, offset, Math.min(8192, bytes.length - offset), offset);
      ++calls;
      if (count < 1) return { ...base, status: 'failure', code: 'IO_ERROR' };
      offset += count;
    }
    return { ...base, status: 'ok', bytes, readCalls: calls };
  } catch { return { ...base, status: 'failure', code: 'IO_ERROR' }; }
}

port.on('message', value => {
  if (busy) throw new Error('单个CUE Worker不能同时借用两个FD。');
  busy = true;
  const reply = consume(value);
  // 下一轮才回settled：当前读取栈和含FD的输入帧已退出，闭包仅持有有限结果字节。
  setImmediate(() => {
    busy = false;
    if (reply.status === 'ok') port.postMessage(reply, [reply.bytes.buffer as ArrayBuffer]);
    else port.postMessage(reply);
  });
});
port.postMessage({ kind: 'ready', protocol: 1 });
