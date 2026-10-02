import { BridgeError } from '../shared/errors.js';
import type { NeteaseRequestOptions } from './types.js';

export const MAX_NETEASE_REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_ACTIVE_REQUESTS = 8;
const MAXIMUM_BACKGROUND_REQUESTS = 2;
const MAXIMUM_QUEUED_REQUESTS = 32;

export function boundedRequestTimeout(value: number | undefined, fallback = MAX_NETEASE_REQUEST_TIMEOUT_MS): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_NETEASE_REQUEST_TIMEOUT_MS)
    : fallback;
}

export function neteaseRequestCancelled(): BridgeError {
  return new BridgeError('READ_CANCELLED', '网易云请求已取消', { details: { reason: 'request-cancelled' } });
}

function requestTimeout(): BridgeError {
  return new BridgeError('NETEASE_REQUEST_FAILED', '网易云请求等待已超时', { httpStatus: 502, details: { reason: 'request-timeout' } });
}

function upstreamFailure(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return new BridgeError('NETEASE_REQUEST_FAILED', '网易云上游请求失败', {
    cause: error, httpStatus: 502,
    details: { reason: code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? 'request-timeout' : 'upstream-response' },
  });
}

export function assertNeteaseRequestCurrent(options: NeteaseRequestOptions, isCurrent: () => boolean): void {
  if (options.signal?.aborted || !isCurrent()) throw neteaseRequestCancelled();
}

/** 仅取消准备工作的本地等待；准备本身继续落定，不能据此声称底层网络已撤销。 */
export function waitNeteaseRequest<T>(work: Promise<T>, options: NeteaseRequestOptions, isCurrent: () => boolean, defaultTimeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown, value?: T): void => {
      if (finished) return;
      finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value as T);
    };
    const cancel = (): void => finish(neteaseRequestCancelled());
    const timer = setTimeout(() => finish(requestTimeout()), boundedRequestTimeout(options.timeoutMs, defaultTimeoutMs));
    options.signal?.addEventListener('abort', cancel, { once: true });
    work.then(value => {
      try { assertNeteaseRequestCurrent(options, isCurrent); finish(undefined, value); } catch (error) { finish(error); }
    }, error => finish(error));
    try { assertNeteaseRequestCurrent(options, isCurrent); } catch (error) { finish(error); }
  });
}

interface RequestJob {
  priority: 'playback' | 'background';
  deadlineAtMs: number;
  timeoutMs: number;
  options: NeteaseRequestOptions;
  isCurrent: () => boolean;
  operation: (timeoutMs: number) => Promise<unknown>;
  state: 'queued' | 'active' | 'done';
  waiting: boolean;
  startTimeout(): void;
  finish(error?: unknown, value?: unknown): void;
}

/** 播放与后台共用八个物理槽位；后台最多两个，库读取的独立三十二槽位不进入这里。 */
export class NeteaseRequestScheduler {
  private readonly queue: RequestJob[] = [];
  private readonly active = new Set<RequestJob>();
  private activeBackground = 0;
  readonly timeoutMs: number;
  private readonly maximumQueued: number;

  constructor(options: { maximumQueued?: number; timeoutMs?: number } = {}) {
    this.timeoutMs = boundedRequestTimeout(options.timeoutMs);
    this.maximumQueued = options.maximumQueued !== undefined && Number.isSafeInteger(options.maximumQueued) && options.maximumQueued > 0
      ? Math.min(options.maximumQueued, MAXIMUM_QUEUED_REQUESTS) : MAXIMUM_QUEUED_REQUESTS;
  }

  run<T>(operation: (timeoutMs: number) => Promise<T>, options: NeteaseRequestOptions, isCurrent: () => boolean): Promise<T> {
    try { assertNeteaseRequestCurrent(options, isCurrent); } catch (error) { return Promise.reject(error); }
    const priority = options.priority ?? 'background';
    const immediate = this.canStart(priority) && !this.queue.some(job => job.priority === 'playback');
    // 当前曲目的元数据和音频URL各预留一个等待位置；后台不能把整个等待队列填满。
    const queueLimit = priority === 'background' ? Math.max(0, this.maximumQueued - 2) : this.maximumQueued;
    if (!immediate && this.queue.length >= queueLimit) return Promise.reject(new BridgeError('NETEASE_REQUEST_FAILED', '网易云请求等待预算已满', { httpStatus: 502, details: { reason: 'request-budget' } }));
    const timeoutMs = boundedRequestTimeout(options.timeoutMs, this.timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const job: RequestJob = {
        priority, options, isCurrent, operation, timeoutMs,
        deadlineAtMs: Date.now() + timeoutMs, state: 'queued', waiting: true,
        startTimeout: (): void => {
          // 排队期限与SDK请求期限分别有界；旧请求等到超时才释放时，新播放仍有完整请求窗口。
          clearTimeout(timer); job.deadlineAtMs = Date.now() + timeoutMs;
          timer = setTimeout(() => job.finish(requestTimeout()), timeoutMs);
        },
        finish: (error, value): void => {
          if (!job.waiting) return;
          job.waiting = false; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
          if (job.state === 'queued') {
            const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
            job.state = 'done';
          }
          if (error) reject(error); else resolve(value as T);
        },
      };
      const cancel = (): void => job.finish(neteaseRequestCancelled());
      let timer = setTimeout(() => job.finish(requestTimeout()), timeoutMs);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (immediate) this.start(job); else this.queue.push(job);
      if (options.signal?.aborted) cancel();
      this.drain();
    });
  }

  /** 账户换代只撤等待与排队；实际请求结束前仍保留其物理槽位。 */
  cancelAll(): void {
    for (const job of [...this.queue, ...this.active]) job.finish(neteaseRequestCancelled());
  }

  private canStart(priority: RequestJob['priority']): boolean {
    return this.active.size < MAXIMUM_ACTIVE_REQUESTS && (priority === 'playback' || this.activeBackground < MAXIMUM_BACKGROUND_REQUESTS);
  }

  private drain(): void {
    while (this.queue.length && this.active.size < MAXIMUM_ACTIVE_REQUESTS) {
      const playback = this.queue.findIndex(job => job.priority === 'playback');
      const index = playback >= 0 ? playback : 0;
      const job = this.queue[index]!;
      if (!this.canStart(job.priority)) return;
      this.queue.splice(index, 1); this.start(job);
    }
  }

  private start(job: RequestJob): void {
    if (!job.waiting) return;
    try { assertNeteaseRequestCurrent(job.options, job.isCurrent); } catch (error) { job.finish(error); return; }
    if (Date.now() >= job.deadlineAtMs) { job.finish(requestTimeout()); return; }
    job.state = 'active'; this.active.add(job);
    if (job.priority === 'background') this.activeBackground++;
    const settle = (error?: unknown, value?: unknown): void => {
      // 只有原始SDK Promise实际落定才释放，不在abort或本地等待超时时扣减。
      this.active.delete(job); if (job.priority === 'background') this.activeBackground--;
      job.state = 'done';
      try {
        assertNeteaseRequestCurrent(job.options, job.isCurrent);
        if (Date.now() >= job.deadlineAtMs) throw requestTimeout();
        job.finish(error === undefined ? undefined : upstreamFailure(error), value);
      } catch (failure) { job.finish(failure); }
      this.drain();
    };
    void Promise.resolve().then(() => {
      assertNeteaseRequestCurrent(job.options, job.isCurrent);
      if (!job.waiting || Date.now() >= job.deadlineAtMs) throw requestTimeout();
      job.startTimeout();
      return job.operation(Math.max(1, Math.min(job.timeoutMs, job.deadlineAtMs - Date.now())));
    }).then(value => settle(undefined, value), error => settle(error));
  }
}
