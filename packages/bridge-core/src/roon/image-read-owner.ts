import { BridgeError } from '../shared/errors.js';
import {
  assertLibraryReadCurrent, currentLibraryRead, libraryReadCancelled, libraryReadTimeout,
  withLibraryRead, type LibraryReadLifetime,
} from '../shared/library-read-lifetime.js';

interface Subscriber {
  failure(): unknown;
  finish(error?: unknown, value?: unknown): void;
}
interface ImageFlight {
  controller: AbortController;
  lifetime: LibraryReadLifetime;
  subscribers: Set<Subscriber>;
  timer: ReturnType<typeof setTimeout>;
}

/** 私有图片工作独占ALS；消费者仅拥有自己的等待，不拥有共享SDK调用。 */
export class RoonImageReadOwner {
  private readonly flights = new Map<string, ImageFlight>();
  private outstanding = 0;
  private subscribers = 0;
  constructor(private readonly now = Date.now, private readonly maximumFlights = 32,
    private readonly maximumSubscribers = 256, private readonly timeoutMs = 10_000) {}

  clear(): void {
    for (const flight of [...this.flights.values()]) this.abandon(flight, libraryReadCancelled());
    this.flights.clear();
  }

  private abandon(flight: ImageFlight, error: BridgeError): void {
    flight.controller.abort(error);
    clearTimeout(flight.timer);
    for (const subscriber of [...flight.subscribers]) subscriber.finish(error);
  }

  read<T>(key: string, isCurrent: () => boolean, operation: () => Promise<T>, subscriberDeadlineAtMs = Infinity): Promise<T> {
    assertLibraryReadCurrent();
    if (!isCurrent()) return Promise.reject(libraryReadCancelled());
    if (this.subscribers >= this.maximumSubscribers) return Promise.reject(this.busy());
    if (this.now() >= subscriberDeadlineAtMs) return Promise.reject(libraryReadTimeout());
    const parent = currentLibraryRead();
    let flight = this.flights.get(key);
    if (flight && !flight.lifetime.isCurrent()) {
      this.abandon(flight, libraryReadCancelled());
      if (this.flights.get(key) === flight) this.flights.delete(key);
      flight = undefined;
    }
    const fresh = !flight;
    if (!flight) {
      if (this.outstanding >= this.maximumFlights) return Promise.reject(this.busy());
      const controller = new AbortController(), born = this.now();
      const subscribers = new Set<Subscriber>();
      const lifetime: LibraryReadLifetime = {
        signal: controller.signal, deadlineAtMs: born + this.timeoutMs, now: this.now,
        isCurrent: () => {
          if (controller.signal.aborted || !isCurrent() || this.now() < born) return false;
          // 未发abort的期限/currentness变化也不能让无人拥有的结果进入缓存。
          for (const subscriber of [...subscribers]) {
            const failure = subscriber.failure();
            if (failure) subscriber.finish(failure);
          }
          return subscribers.size > 0 && !controller.signal.aborted;
        },
      };
      const timer = setTimeout(() => this.abandon(owned, libraryReadTimeout()), this.timeoutMs);
      const owned: ImageFlight = { controller, lifetime, subscribers, timer };
      flight = owned;
      this.flights.set(key, flight); this.outstanding++;
    }
    const owned = flight;
    this.subscribers++;
    const result = new Promise<T>((resolve, reject) => {
      const deadline = Math.min(parent?.deadlineAtMs ?? owned.lifetime.deadlineAtMs, owned.lifetime.deadlineAtMs, subscriberDeadlineAtMs);
      const parentFailure = (): unknown => {
        try {
          if (parent) withLibraryRead(parent, assertLibraryReadCurrent);
          if (!isCurrent()) return libraryReadCancelled();
          if (this.now() >= deadline) return libraryReadTimeout();
          return undefined;
        } catch (error) { return error; }
      };
      const finish = (error?: unknown, value?: unknown): void => {
        if (!owned.subscribers.delete(subscriber)) return;
        clearTimeout(timer); parent?.signal.removeEventListener('abort', cancel); this.subscribers--;
        let failure = error;
        if (!failure) {
          try {
            if (parent) withLibraryRead(parent, assertLibraryReadCurrent);
            if (!isCurrent() || owned.controller.signal.aborted) throw libraryReadCancelled();
            if (this.now() >= deadline) throw libraryReadTimeout();
          } catch (reason) { failure = reason; }
        }
        if (failure) reject(failure); else resolve(value as T);
        if (!owned.subscribers.size) {
          owned.controller.abort(libraryReadCancelled()); clearTimeout(owned.timer);
          if (this.flights.get(key) === owned) this.flights.delete(key);
        }
      };
      const cancel = (): void => finish(parent?.signal.reason instanceof BridgeError ? parent.signal.reason : libraryReadCancelled());
      const subscriber: Subscriber = { failure: parentFailure, finish };
      const timer = setTimeout(() => finish(libraryReadTimeout()), Math.max(0, deadline - this.now()));
      owned.subscribers.add(subscriber);
      parent?.signal.addEventListener('abort', cancel, { once: true });
      if (parent?.signal.aborted) cancel();
    });
    if (fresh) {
      let work: Promise<T>;
      try { work = withLibraryRead(owned.lifetime, async () => {
        const value = await operation(); assertLibraryReadCurrent(); return value;
      }); } catch (error) { work = Promise.reject(error); }
      const retire = (): void => {
        // 到此工作Promise确已结算；在回执前归还，允许artist resolver进入binary阶段。
        // 本地取消/超时不会走此路径；真实SDK预算仍由Service独立保留到callback。
        this.outstanding--; clearTimeout(owned.timer);
        if (this.flights.get(key) === owned) this.flights.delete(key);
      };
      void work.then(value => {
        retire();
        for (const subscriber of [...owned.subscribers]) subscriber.finish(undefined, value);
      }, error => {
        retire();
        for (const subscriber of [...owned.subscribers]) subscriber.finish(error);
      });
    }
    return result;
  }

  private busy(): BridgeError {
    return new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '图片读取预算已满，请稍后重试', { httpStatus: 503 });
  }
}
