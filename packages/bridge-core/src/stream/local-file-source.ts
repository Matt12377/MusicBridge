import type { PreparedLocalSource } from '../application/local-source-resolver.js';
import { openLocalPlaybackReadonlySource } from '../recording/source-files.js';
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export class LocalFileLeaseError extends Error {
  constructor(readonly code: 'INVALID_DESCRIPTOR' | 'CAPACITY' | 'STALE_ATTEMPT' | 'NOT_CONFIRMED' | 'EXPIRED' | 'SOURCE_CHANGED' | 'CLOSED') { super(`本地文件租约拒绝：${code}`); }
}
export type LocalLeaseState = 'PREPARED' | 'ACTIVE' | 'PAUSED' | 'CLOSING' | 'CLOSED';
export interface LocalLeaseAuthority { ownerId: string; attempt: number; isCurrent(): boolean }
export interface ConfirmedLocalSession { attempt: number; sessionId: string; isConfirmed(): boolean }
/** 固定事实的最小只读描述符；原 Roon 描述符仍满足此合同。 */
export type ReadonlyLocalFileDescriptor = Pick<PreparedLocalSource, 'source_kind' | 'status' | 'facts'>;
type OpenedSource = Awaited<ReturnType<typeof openLocalPlaybackReadonlySource>>;
export class AssetLease {
  private stateValue: LocalLeaseState = 'PREPARED';
  private readonly controller = new AbortController();
  private sessionId: string | undefined;
  private readonly started: number;
  private expires: number;
  private timer: ReturnType<typeof setInterval>;
  private watching: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private failureCodeValue: LocalFileLeaseError['code'] | null = null;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly responses = new Set<ServerResponse>();
  private readonly drained: (() => void)[] = [];
  readonly size: number;
  readonly weakEtag: string;
  readonly revisions: Readonly<{ assetId: string; assetRevision: string; rootRevision: string; locationRevision: string; selectionRevision: string }>;
  constructor(private readonly file: OpenedSource, descriptor: ReadonlyLocalFileDescriptor, private readonly authority: LocalLeaseAuthority,
    private readonly currentAttempt: () => boolean, private readonly releaseSlot: () => void, private readonly now: () => number = () => performance.now()) {
    this.size = file.size; this.started = now(); this.expires = this.started + 30_000;
    this.weakEtag = `W/"${createHash('sha256').update(file.signature).digest('hex')}"`;
    this.revisions = Object.freeze({ assetId: descriptor.facts.asset.id, assetRevision: descriptor.facts.asset.fileRevision, rootRevision: descriptor.facts.root.revision,
      locationRevision: descriptor.facts.asset.locationRevision, selectionRevision: descriptor.facts.track.selectionRevision });
    this.timer = setInterval(() => {
      if (!this.watching) this.watching = this.verify().catch(() => undefined).finally(() => { this.watching = undefined; });
    }, 1000);
    this.timer.unref();
  }
  get state(): LocalLeaseState { return this.stateValue; }
  get signal(): AbortSignal { return this.controller.signal; }
  get failureCode(): LocalFileLeaseError['code'] | null { return this.failureCodeValue; }
  private assertCurrent(): void {
    if (this.controller.signal.aborted || this.stateValue === 'CLOSING' || this.stateValue === 'CLOSED') throw new LocalFileLeaseError('CLOSED');
    if (!this.currentAttempt() || this.authority.isCurrent() !== true) throw new LocalFileLeaseError('STALE_ATTEMPT');
    if (this.now() >= this.expires || this.now() - this.started >= 12 * 60 * 60_000) throw new LocalFileLeaseError('EXPIRED');
  }
  confirmSession(session: ConfirmedLocalSession): void {
    this.assertCurrent();
    if (session.attempt !== this.authority.attempt || !/^[A-Za-z0-9_-]{1,128}$/u.test(session.sessionId) || session.isConfirmed() !== true
      || this.sessionId !== undefined && this.sessionId !== session.sessionId) throw new LocalFileLeaseError('NOT_CONFIRMED');
    this.sessionId = session.sessionId; this.stateValue = 'ACTIVE'; this.expires = this.now() + 5 * 60_000;
  }
  pause(session: ConfirmedLocalSession): void { this.renew(session); this.stateValue = 'PAUSED'; }
  renew(session: ConfirmedLocalSession): void {
    this.assertCurrent();
    if (this.sessionId === undefined || this.sessionId !== session.sessionId || session.attempt !== this.authority.attempt || session.isConfirmed() !== true) throw new LocalFileLeaseError('NOT_CONFIRMED');
    this.expires = this.now() + 5 * 60_000;
  }
  private async operation<T>(run: () => Promise<T>): Promise<T> {
    this.assertCurrent(); const task = run(); this.operations.add(task);
    try { return await task; } finally { this.operations.delete(task); }
  }
  async verify(): Promise<void> {
    try { await this.operation(async () => { await this.file.verify(); this.assertCurrent(); }); }
    catch (error) {
      const failure = error instanceof LocalFileLeaseError ? error : new LocalFileLeaseError('SOURCE_CHANGED');
      // 先封存原失败码，再触发abort；后台退休的监听方不得把源变化误记为显式释放。
      this.failureCodeValue ??= failure.code;
      void this.close().catch(() => undefined); throw failure;
    }
  }
  attachResponse(response: ServerResponse): () => void {
    this.assertCurrent(); if (this.responses.size >= 4) throw new LocalFileLeaseError('CAPACITY');
    this.responses.add(response); let released = false;
    return () => { if (released) return; released = true; this.responses.delete(response); if (!this.responses.size) for (const resolve of this.drained.splice(0)) resolve(); };
  }
  async *readSlice(start: number, end: number, signal: AbortSignal): AsyncGenerator<Buffer> {
    try {
      for (let position = start; position <= end;) {
        signal.throwIfAborted(); await this.verify();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position + 1));
        const { bytesRead } = await this.operation(() => this.file.handle.read(buffer, 0, buffer.length, position));
        // stat/命名身份后核在yield前，检测到变化的块绝不进入HTTP。
        await this.verify(); signal.throwIfAborted();
        if (bytesRead !== buffer.length) throw new LocalFileLeaseError('SOURCE_CHANGED');
        position += bytesRead; yield buffer;
      }
    } catch (error) {
      // 正常HTTP断连只退出request；实际源read错误必须撤销能力。
      if (!signal.aborted) void this.close().catch(() => undefined);
      throw error;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stateValue = 'CLOSING'; this.controller.abort(); clearInterval(this.timer);
    this.closing = (async () => {
      for (const response of this.responses) response.destroy();
      if (this.responses.size) await new Promise<void>(resolve => this.drained.push(resolve));
      while (this.operations.size) await Promise.allSettled([...this.operations]);
      await this.file.close(); this.stateValue = 'CLOSED'; this.releaseSlot();
    })();
    return this.closing;
  }
  resourceSnapshot(): { activeRequests: number; activeIo: number; timer: number } { return { activeRequests: this.responses.size, activeIo: this.operations.size, timer: this.stateValue === 'CLOSING' || this.stateValue === 'CLOSED' ? 0 : 1 }; }
}

/** 只有可信Core组合层能打开descriptor；外部HTTP只查Registry secret。 */
export class LocalFileSourcePool {
  private readonly leases = new Set<AssetLease>();
  private readonly attempts = new Map<string, number>();
  private reservations = 0;
  private readonly preparations = new Set<Promise<AssetLease>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly options: { maxLeases?: number; now?: () => number } = {}) {
    if (options.maxLeases !== undefined && (!Number.isSafeInteger(options.maxLeases) || options.maxLeases < 1 || options.maxLeases > 16)) throw new LocalFileLeaseError('CAPACITY');
  }
  async prepare(descriptor: ReadonlyLocalFileDescriptor, authority: LocalLeaseAuthority): Promise<AssetLease> {
    const pending = this.prepareInternal(structuredClone(descriptor), { ...authority }); this.preparations.add(pending);
    try { return await pending; } finally { this.preparations.delete(pending); }
  }
  private async prepareInternal(descriptor: ReadonlyLocalFileDescriptor, authority: LocalLeaseAuthority): Promise<AssetLease> {
    if (this.closing) throw new LocalFileLeaseError('CLOSED');
    if (!descriptor || descriptor.source_kind !== 'local_file' || descriptor.status !== 'prepared_descriptor' || !descriptor.facts
      || descriptor.facts.track.assetId !== descriptor.facts.asset.id || descriptor.facts.asset.rootRevision !== descriptor.facts.root.revision
      || descriptor.facts.asset.libraryRootId !== descriptor.facts.root.id || descriptor.facts.root.sourceRootId !== descriptor.facts.sourceRoot.id
      || descriptor.facts.asset.sourceRootId !== descriptor.facts.sourceRoot.id || descriptor.facts.track.segment !== null) throw new LocalFileLeaseError('INVALID_DESCRIPTOR');
    const { observation, asset, track, root, sourceRoot } = descriptor.facts;
    if (!observation || typeof observation.signature !== 'string' || observation.signature.length > 256
      || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):\d+:-?\d+:-?\d+$/u.test(observation.signature) || observation.assetId !== asset.id || observation.trackId !== track.id
      || observation.libraryRootId !== root.id || observation.sourceRootId !== sourceRoot.id || observation.fileRevision !== asset.fileRevision
      || observation.rootRevision !== root.revision || observation.locationRevision !== asset.locationRevision || observation.selectionRevision !== track.selectionRevision) throw new LocalFileLeaseError('INVALID_DESCRIPTOR');
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(authority.ownerId) || !Number.isSafeInteger(authority.attempt) || authority.attempt < 1 || authority.isCurrent() !== true) throw new LocalFileLeaseError('STALE_ATTEMPT');
    const previous = this.attempts.get(authority.ownerId);
    // attempt只消费一次；关闭或失败后的同一attempt不能再取得新能力。
    if (previous !== undefined && authority.attempt <= previous || previous === undefined && this.attempts.size >= 16) throw new LocalFileLeaseError('STALE_ATTEMPT');
    if (this.reservations >= (this.options.maxLeases ?? 8)) throw new LocalFileLeaseError('CAPACITY');
    this.attempts.set(authority.ownerId, authority.attempt); this.reservations++;
    let file: OpenedSource | undefined;
    const current = (): boolean => !this.closing && this.attempts.get(authority.ownerId) === authority.attempt;
    try {
      file = await openLocalPlaybackReadonlySource({ ...descriptor.facts.sourceRoot }, descriptor.facts.relative, observation.signature);
      if (!current() || authority.isCurrent() !== true) throw new LocalFileLeaseError('STALE_ATTEMPT');
      let lease!: AssetLease;
      lease = new AssetLease(file, descriptor, { ...authority }, current, () => { this.leases.delete(lease); this.reservations--; }, this.options.now);
      this.leases.add(lease); return lease;
    } catch (error) { if (file) await file.close(); this.reservations--; throw error; }
  }
  close(): Promise<void> { return this.closing ??= (async () => { await Promise.allSettled([...this.preparations]); await Promise.all([...this.leases].map(lease => lease.close())); })(); }
  resourceSnapshot(): { openLeases: number; reservations: number } { return { openLeases: this.leases.size, reservations: this.reservations }; }
}
