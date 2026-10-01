import { BridgeError } from '../shared/errors.js';
import { assertLibraryReadCurrent, currentLibraryRead, libraryReadCancelled, libraryReadTimeout, withLibraryRead, type LibraryReadLifetime } from '../shared/library-read-lifetime.js';

interface Subscriber {
  finish(error?: unknown, value?: unknown): void;
}
interface Flight {
  controller: AbortController;
  lifetime: LibraryReadLifetime;
  subscribers: Set<Subscriber>;
}

/** 共享只读工作拥有自己的期限；调用者只拥有各自的订阅。物理SDK预算仍在Client Proxy结算。 */
export class SnapshotReadFlights {
  private readonly flights = new Map<string, Flight>();
  private subscribers = 0;
  constructor(private readonly maximumFlights = 32, private readonly maximumSubscribers = 256, private readonly timeoutMs = 10_000) {}

  read<T>(key: string, isCurrent: () => boolean, operation: () => Promise<T>): Promise<T> {
    assertLibraryReadCurrent();
    if (!isCurrent()) return Promise.reject(libraryReadCancelled());
    if (this.subscribers >= this.maximumSubscribers) return Promise.reject(new BridgeError('NETEASE_REQUEST_FAILED', '读取订阅预算已满'));
    const parent = currentLibraryRead();
    let flight = this.flights.get(key);
    const fresh = !flight;
    if (!flight) {
      if (this.flights.size >= this.maximumFlights) return Promise.reject(new BridgeError('NETEASE_REQUEST_FAILED', '共享读取预算已满'));
      const controller = new AbortController(), now = parent?.now ?? Date.now;
      const owned: Flight = { controller, subscribers: new Set(), lifetime: { signal: controller.signal, now, deadlineAtMs: now() + this.timeoutMs,
        isCurrent: () => this.flights.get(key) === owned && isCurrent(),
        ...(parent?.cacheMode ? { cacheMode: parent.cacheMode } : {}),
      } };
      this.flights.set(key, owned); flight = owned;
    }
    const owned = flight;
    const deadline = Math.min(parent?.deadlineAtMs ?? owned.lifetime.deadlineAtMs, owned.lifetime.deadlineAtMs);
    this.subscribers++;
    const result = new Promise<T>((resolve, reject) => {
      const finish = (error?: unknown, value?: unknown): void => {
        if (!owned.subscribers.delete(subscriber)) return;
        clearTimeout(timer); parent?.signal.removeEventListener('abort', cancel); this.subscribers--;
        let outcome = error;
        if (!outcome) {
          try {
            if (parent) withLibraryRead(parent, assertLibraryReadCurrent);
            if (!isCurrent()) throw libraryReadCancelled();
            if (owned.lifetime.now() >= deadline) throw libraryReadTimeout();
          } catch (failure) { outcome = failure; }
        }
        if (outcome) reject(outcome); else resolve(value as T);
        if (!owned.subscribers.size) {
          if (this.flights.get(key) === owned) this.flights.delete(key);
          owned.controller.abort(outcome instanceof BridgeError ? outcome : libraryReadCancelled());
        }
      };
      const subscriber: Subscriber = { finish };
      const cancel = (): void => finish(parent?.signal.reason instanceof BridgeError ? parent.signal.reason : libraryReadCancelled());
      const timer = setTimeout(() => finish(libraryReadTimeout()), Math.max(0, deadline - owned.lifetime.now()));
      owned.subscribers.add(subscriber);
      parent?.signal.addEventListener('abort', cancel, { once: true });
      if (parent?.signal.aborted) cancel();
    });
    if (fresh) {
      void Promise.resolve().then(() => withLibraryRead(owned.lifetime, async () => {
        const value = await operation(); assertLibraryReadCurrent(); return value;
      })).then(value => { for (const subscriber of [...owned.subscribers]) subscriber.finish(undefined, value); }, error => {
        for (const subscriber of [...owned.subscribers]) subscriber.finish(error);
      }).finally(() => { if (this.flights.get(key) === owned) this.flights.delete(key); });
    }
    return result;
  }

  clear(): void {
    for (const flight of [...this.flights.values()]) {
      flight.controller.abort(libraryReadCancelled());
      for (const subscriber of [...flight.subscribers]) subscriber.finish(libraryReadCancelled());
    }
    this.flights.clear();
  }
}
