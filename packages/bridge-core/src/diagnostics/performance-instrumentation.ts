import type { DatabaseSync } from 'node:sqlite';
import { currentPerformanceContext, readPerformanceTime } from './performance-trace.js';

/** 不记录调用参数、SQL、路径或返回数据；原调用对象与异常保持不变。 */
function measureCall<T>(operation: 'provider' | 'sql', call: () => T): T {
  const trace = currentPerformanceContext();
  if (!trace) return call();
  const started = readPerformanceTime();
  const span = trace.recorder.start(operation, trace.context,
    operation === 'sql' ? { sqlCount: 1 } : { providerCallCount: 1 });
  if (operation === 'provider') trace.recorder.mark('provider', 'provider-dispatch', trace.context);
  const complete = (outcome: 'ok' | 'error'): void => {
    const ended = started === undefined ? undefined : readPerformanceTime();
    const duration = started !== undefined && ended !== undefined ? Math.max(0, ended - started) : undefined;
    // 时钟失效时保留计数与落定结果，不把未知耗时当作实际零耗时。
    span.end(outcome, duration === undefined ? {} : operation === 'sql' ? { sqlDurationMs: duration } : { providerDurationMs: duration });
    if (operation === 'provider') trace.recorder.mark('provider', 'provider-response', trace.context);
  };
  try {
    const result = call();
    if (result instanceof Promise) return result.then(value => { complete('ok'); return value; }, error => { complete('error'); throw error; }) as T;
    complete('ok');
    return result;
  } catch (error) { complete('error'); throw error; }
}

export function traceProviderApi<T extends object>(api: T): T {
  const functions = new Map<PropertyKey, unknown>();
  return new Proxy(api, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!functions.has(key)) functions.set(key, (...args: unknown[]) => measureCall('provider', () => Reflect.apply(value, target, args)));
      return functions.get(key);
    },
  });
}

/** 连接和事务仍由原所有者持有；仅给语句执行计数，不改变同步语义。 */
export function traceDatabase(database: DatabaseSync): DatabaseSync {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(database, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!methods.has(key)) methods.set(key, key === 'prepare'
        ? (...args: unknown[]) => {
          const statement = Reflect.apply(value, target, args) as object;
          return new Proxy(statement, {
            get(owner, method) {
              const execute: unknown = Reflect.get(owner, method, owner);
              if (typeof execute !== 'function') return execute;
              if (['get', 'all', 'run'].includes(String(method))) return (...bindings: unknown[]) => measureCall('sql', () => Reflect.apply(execute, owner, bindings));
              return execute.bind(owner);
            },
          });
        }
        : key === 'exec'
          ? (...args: unknown[]) => measureCall('sql', () => Reflect.apply(value, target, args))
          : value.bind(target));
      return methods.get(key);
    },
  });
}
