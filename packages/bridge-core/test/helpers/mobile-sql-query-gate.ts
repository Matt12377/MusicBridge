import { DatabaseSync } from 'node:sqlite';
import type { MessagePort } from 'node:worker_threads';

/** 只供合成 Worker：闸门位于真实 SQLite 调用的 UDF 内，不用慢机器或大库碰运气。 */
export function installMobileSqlQueryGate(buffer: SharedArrayBuffer, port: Pick<MessagePort, 'postMessage'>, counter = 5,
  accept: (name: string, values: readonly unknown[]) => boolean = () => true): void {
  const gate = new Int32Array(buffer);
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'function')!;
  const original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(DatabaseSync.prototype, 'function', { ...descriptor, value: function (this: DatabaseSync, ...args: unknown[]) {
    const name = args[0], index = args.length - 1, callback = args[index];
    if (typeof name !== 'string' || !name.startsWith('mb_album_') || typeof callback !== 'function') {
      return Reflect.apply(original, this, args);
    }
    const wrapped = function (...values: unknown[]) {
      if (gate.length > counter) Atomics.add(gate, counter, 1);
      const result = Reflect.apply(callback, undefined, values);
      if (accept(name, values) && Atomics.compareExchange(gate, 0, 1, 0) === 1) {
        Atomics.store(gate, 1, 1);
        port.postMessage({ type: 'sql.entered', name });
        try {
          if (Atomics.wait(gate, 2, 0, 5_000) === 'timed-out') {
            Atomics.store(gate, 4, 1);
            throw new Error('合成 SQL 闸门未在固定上限内释放。');
          }
        } finally { Atomics.store(gate, 3, 1); }
      }
      return result;
    };
    // node:sqlite 从函数 arity 取得 SQL 参数数，装饰不能改变原 UDF 合同。
    Object.defineProperty(wrapped, 'length', { value: callback.length });
    args[index] = wrapped;
    return Reflect.apply(original, this, args);
  } });
}
