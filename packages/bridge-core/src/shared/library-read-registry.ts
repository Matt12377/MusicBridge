import { isLibraryReadCommand, type IpcRequest, type IpcCommand } from '@music-bridge/contracts';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.js';
import { libraryReadCancelled, libraryReadTimeout, withLibraryRead } from './library-read-lifetime.js';
import { emitLibraryReadTrace, libraryReadScopeChanges, libraryReadTraceFailure, type LibraryReadTraceReason, type LibraryReadTraceSink } from './library-read-trace.js';

interface Subscriber { finish(error?: unknown, value?: unknown): void }
interface Flight {
  key: string; controller: AbortController; subscribers: Map<string, Subscriber>;
  deadlineAtMs: number; scope: string; command: IpcCommand;
  cacheMode?: 'reload';
  id: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** 同 flight 共享工作，各 IPC ID 独占回执、期限和取消权。 */
export class LibraryReadRegistry {
  private readonly flights = new Map<string, Flight>();
  private readonly subscribers = new Map<string, Flight>();
  private outstanding = 0;
  constructor(private readonly scope: (command: IpcCommand) => string, private readonly now = Date.now,
    private readonly maximumFlights = 64, private readonly maximumSubscribers = 256, private readonly trace?: LibraryReadTraceSink) {}
  read(request: IpcRequest, operation: () => Promise<unknown>): Promise<unknown> {
    const command = isLibraryReadCommand(request.command) ? request.command : undefined;
    const emit = (stage: string, fields: Record<string, unknown> = {}): void => emitLibraryReadTrace(this.trace, { stage, coreReadId: request.id, ...(command ? { command } : {}), ...fields });
    emit('core.receive');
    const reject = (error: unknown): Promise<never> => { emit('core.finish', libraryReadTraceFailure(error)); return Promise.reject(error); };
    const now = this.now();
    const deadlineAtMs = Math.min(request.readContext?.deadlineAtMs ?? now + 10_000, now + 10_000);
    if (deadlineAtMs <= now) return reject(libraryReadTimeout());
    if (this.subscribers.has(request.id)) return reject(new BridgeError('BAD_REQUEST', '读取 ID 已在使用'));
    if (this.subscribers.size >= this.maximumSubscribers) return reject(new BridgeError('BAD_REQUEST', '读取订阅预算已满'));
    const scope = this.scope(request.command);
    const cacheMode = request.readContext?.cacheMode;
    const key = canonical([scope, request.command, request.payload, cacheMode ?? 'default']);
    let flight = this.flights.get(key);
    const fresh = !flight;
    if (!flight) {
      if (this.outstanding >= this.maximumFlights) return reject(new BridgeError('BAD_REQUEST', '未返回读取预算已满'));
      flight = { key, scope, command: request.command, controller: new AbortController(), subscribers: new Map(), deadlineAtMs: now + 10_000,
        id: randomUUID(), ...(cacheMode ? { cacheMode } : {}) };
      this.flights.set(key, flight); this.outstanding++;
    }
    const owned = flight;
    const result = new Promise<unknown>((resolve, reject) => {
      const finish = (error?: unknown, value?: unknown): void => {
        if (!owned.subscribers.has(request.id)) return;
        clearTimeout(timer); owned.subscribers.delete(request.id); this.subscribers.delete(request.id);
        const outcome = error ?? (this.now() >= Math.min(deadlineAtMs, owned.deadlineAtMs) ? libraryReadTimeout() : undefined);
        emit('core.finish', { flightId: owned.id, subscriberCount: owned.subscribers.size, ...(outcome ? libraryReadTraceFailure(outcome) : { outcome: 'ok' }) });
        if (outcome) reject(outcome); else resolve(value);
        if (!owned.subscribers.size) {
          emit('core.flight.close', { flightId: owned.id, subscriberCount: 0, ...(outcome ? libraryReadTraceFailure(outcome) : { outcome: 'ok', reason: 'last-subscriber-release' }) });
          owned.controller.abort(outcome instanceof BridgeError ? outcome : libraryReadCancelled('last-subscriber-release'));
          if (this.flights.get(key) === owned) this.flights.delete(key);
        }
      };
      const timer = setTimeout(() => finish(libraryReadTimeout()), Math.max(0, Math.min(deadlineAtMs, owned.deadlineAtMs) - this.now()));
      owned.subscribers.set(request.id, { finish }); this.subscribers.set(request.id, owned);
      emit(fresh ? 'core.flight.start' : 'core.flight.join', { flightId: owned.id, subscriberCount: owned.subscribers.size });
    });
    if (fresh) {
      let scopeChanged = false;
      const isCurrent = (): boolean => {
        const current = this.scope(owned.command);
        if (current === owned.scope) return true;
        if (!scopeChanged) { scopeChanged = true; emit('core.scope', { flightId: owned.id, reason: 'scope-changed', ...libraryReadScopeChanges(owned.command, owned.scope, current) }); }
        return false;
      };
      Promise.resolve().then(() => withLibraryRead({ signal: owned.controller.signal,
        deadlineAtMs: owned.deadlineAtMs, now: this.now, isCurrent,
        ...(this.trace && command ? { trace: { coreReadId: request.id, flightId: owned.id, command, emit: this.trace } } : {}),
        ...(owned.cacheMode ? { cacheMode: owned.cacheMode } : {}) }, operation))
        .then(value => {
          if (this.now() >= owned.deadlineAtMs) throw libraryReadTimeout();
          if (!isCurrent()) throw libraryReadCancelled('scope-changed');
          for (const sub of [...owned.subscribers.values()]) sub.finish(undefined, value);
        }, error => { for (const sub of [...owned.subscribers.values()]) sub.finish(error); })
        .catch(error => { for (const sub of [...owned.subscribers.values()]) sub.finish(error); })
        .finally(() => { this.outstanding--; if (this.flights.get(key) === owned) this.flights.delete(key); });
    }
    return result;
  }
  cancel(id: string, source: LibraryReadTraceReason = 'main-cancel'): void { this.subscribers.get(id)?.subscribers.get(id)?.finish(libraryReadCancelled(source)); }
  cancelWhere(predicate: (command: IpcCommand) => boolean, source: LibraryReadTraceReason = 'scope-changed'): void {
    for (const [id, flight] of [...this.subscribers]) if (predicate(flight.command)) this.cancel(id, source);
  }
  cancelAll(source: LibraryReadTraceReason = 'shutdown'): void { for (const id of [...this.subscribers.keys()]) this.cancel(id, source); }
}
