import { Worker, type WorkerOptions } from 'node:worker_threads';
import { AsyncResource } from 'node:async_hooks';
import { lstatSync } from 'node:fs';
import { LocalAlbumReadError } from './grouping.js';
import type { LocalAlbumSqlMobileQuery, LocalAlbumSqlScope } from './sql-types.js';
import { isMobileStructurePage, type MobileStructurePage } from './mobile-structure.js';
import { isArtistIndexCandidatePage, type ArtistIndexCandidatePage } from './artist-index-candidates.js';
import { isCommandOutboxDatasetId } from '@music-bridge/contracts';
import { catalogTraceEvent } from '../../mobile/catalog-private-trace.js';

export interface MobileSqlWorkerOptions {
  databaseFile: string;
  /** 桌面打包入口显式指定相邻产物；普通Core编译仍使用本模块相邻.js。 */
  entry?: URL;
  /** 只由可信组合或测试提供，不来自环境或移动请求。 */
  workerFactory?: (options: WorkerOptions) => Worker;
  /** 可信原Owner的队列连续链作者；不从请求、配置或环境接收。 */
  queueAudit?: { capture(scope: LocalAlbumSqlScope): object | undefined; continues(before: object, after: object): boolean };
}
export function mobileSqlFileIdentity(file: string): string {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new LocalAlbumReadError('UNAVAILABLE', '移动只读工作库身份无效。');
  return [stat.dev, stat.ino].join(':');
}
const fail = () => new LocalAlbumReadError('UNAVAILABLE', '移动目录的只读查询尚未确认收尾。');
const changed = () => new LocalAlbumReadError('SNAPSHOT_CHANGED', '移动目录原来源或读取作用域已改变。');
const codes = ['INVALID_REQUEST', 'SNAPSHOT_CHANGED', 'CONTENT_LIMIT_EXCEEDED', 'UNAVAILABLE'] as const;
type Code = typeof codes[number];
type SqlPage = MobileStructurePage | ArtistIndexCandidatePage;
export const MOBILE_SQL_WORKER_STAGES = ['opened', 'begun', 'audit-begin', 'audit-catalog', 'audit-scan', 'entered', 'rollback', 'closed'] as const;
type Job = {
  id: number; kind: 'prepare' | 'read'; scope: LocalAlbumSqlScope; cancellation: Int32Array;
  begun: boolean; entered: boolean; rolledBack: boolean; auditPhase: number; terminal: boolean;
  failure?: Error; page?: SqlPage; queueToken?: object; poll: ReturnType<typeof setInterval> | undefined;
  done(): void; assertCurrent(): void;
};
type Actor = {
  worker: Worker; cancellation: Int32Array; fileIdentity: string; opened: boolean; hasAudited: boolean;
  closedAck: boolean; neverOpened: boolean; closeSent: boolean; exited: boolean;
  exit: Promise<void>; finishExit(): void;
};
const keys = (value: object, expected: readonly string[]): boolean => Reflect.ownKeys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key));

/** 单个只读连接串行受理作业；作业回滚与整个actor关闭/真实退出分别确认。 */
export function createMobileSqlWorker(options: MobileSqlWorkerOptions) {
  return createSqlWorker<MobileStructurePage>(options);
}
/** 与移动结构使用不同连接、队列和摘要作者；仅复用已核验的作业/收尾框架。 */
export function createArtistIndexSqlWorker(options: MobileSqlWorkerOptions, datasetId: string) {
  if (!isCommandOutboxDatasetId(datasetId)) throw fail();
  const actor = createSqlWorker<ArtistIndexCandidatePage>(options, datasetId);
  return { read: actor.read, close: actor.close };
}
function createSqlWorker<Page extends SqlPage>(options: MobileSqlWorkerOptions, indexDatasetId?: string) {
  const isExpectedPage = (value: unknown): value is SqlPage => indexDatasetId ? isArtistIndexCandidatePage(value) : isMobileStructurePage(value);
  let closed = false, fatal: Error | undefined, actor: Actor | undefined, active: Job | undefined;
  let sequence = 0, closeFlight: Promise<void> | undefined, reserved = false;
  const waiters: Array<{ start(): void; reject(error: unknown): void }> = [];
  let completedAudit: { actor: Actor; jobId: number; token: object } | undefined;
  const idle: Array<() => void> = [];
  const notifyIdle = () => { if (!reserved && waiters.length === 0) while (idle.length) idle.shift()!(); };
  const pump = () => { if (!reserved && !closed && !fatal) waiters.shift()?.start(); notifyIdle(); };
  const reserve = (assertCurrent: () => void): Promise<() => void> => new Promise((resolve, reject) => {
    if (closed || fatal || waiters.length + Number(reserved) >= 15) { reject(fatal ?? fail()); return; }
    let timer: ReturnType<typeof setInterval> | undefined;
    const remove = () => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); if (timer) clearInterval(timer); };
    const waiter = {
      start() { remove(); reserved = true; let released = false; resolve(() => { if (released) return; released = true; reserved = false; pump(); }); },
      reject(error: unknown) { remove(); reject(error); notifyIdle(); },
    };
    waiters.push(waiter);
    timer = setInterval(() => { try { assertCurrent(); } catch (error) { waiter.reject(error); } }, 25);
    pump();
  });
  function requestClose(): void {
    if (!actor || actor.exited || actor.closeSent) return;
    actor.closeSent = true; Atomics.store(actor.cancellation, 0, 1);
    try { actor.worker.postMessage({ type: 'close' }); } catch { fatal ??= fail(); }
  }
  function rejectActor(): void {
    fatal ??= fail();
    for (const waiter of [...waiters]) waiter.reject(fatal);
    if (active && !active.terminal) { active.failure ??= fatal; Atomics.store(active.cancellation, 0, 1); }
    requestClose();
  }
  function finishJob(job: Job): void {
    job.terminal = true;
    if (job.poll) clearInterval(job.poll);
    job.done();
  }
  function receive(value: unknown): void {
    const current = actor;
    if (!current || !value || typeof value !== 'object' || current.exited) { rejectActor(); return; }
    const message = value as { type?: unknown; stage?: unknown; jobId?: unknown; page?: unknown; code?: unknown };
    if (keys(value, ['type', 'stage']) && message.type === 'stage') {
      if (message.stage === 'opened' && !current.opened && !current.neverOpened && !current.closedAck) { current.opened = true; return; }
      if (message.stage === 'closed' && current.opened && !current.closedAck && current.closeSent && (!active || active.terminal || fatal)) {
        current.closedAck = true; catalogTraceEvent('owner.sql.connection-close', 'ok', { role: 'cleanup' }); return;
      }
      rejectActor(); return;
    }
    if (keys(value, ['type', 'code']) && message.type === 'never-opened' && message.code === 'SNAPSHOT_CHANGED'
      && current.closeSent && Atomics.load(current.cancellation, 0) !== 0 && !current.opened && !current.closedAck && !current.neverOpened) {
      current.neverOpened = true; return;
    }
    if (keys(value, ['type', 'code']) && message.type === 'fatal' && message.code === 'UNAVAILABLE') { rejectActor(); return; }
    const job = active;
    if (fatal || !job || job.terminal || message.jobId !== job.id || !current.opened || current.closedAck) { rejectActor(); return; }
    if (keys(value, ['type', 'jobId', 'stage']) && message.type === 'stage') {
      if (message.stage === 'begun' && !job.begun && !job.entered && !job.rolledBack && job.auditPhase === 0) { job.begun = true; return; }
      const audit = ['audit-begin', 'audit-catalog', 'audit-scan'].indexOf(String(message.stage));
      if (audit >= 0 && job.begun && !job.entered && !job.rolledBack && job.auditPhase === audit) {
        job.auditPhase++;
        if (audit === 0) current.hasAudited = false;
        if (audit === 2) current.hasAudited = true;
        catalogTraceEvent(audit === 0 ? 'owner.sql.audit' : audit === 1 ? 'owner.sql.audit-catalog' : 'owner.sql.audit-scan', audit === 0 ? 'begin' : 'ok'); return;
      }
      if (message.stage === 'entered' && job.begun && !job.entered && !job.rolledBack
        && (job.auditPhase === 3 || job.auditPhase === 0 && current.hasAudited)) {
        job.entered = true; catalogTraceEvent('owner.sql.worker', 'begin'); return;
      }
      if (message.stage === 'rollback' && job.begun && !job.rolledBack) {
        job.rolledBack = true; catalogTraceEvent('owner.sql.rollback', 'ok', { role: 'cleanup' }); return;
      }
      rejectActor(); return;
    }
    if (keys(value, ['type', 'jobId', 'code']) && message.type === 'job-skipped' && message.code === 'SNAPSHOT_CHANGED'
      && !job.begun && Atomics.load(job.cancellation, 0) !== 0) {
      job.failure ??= changed(); finishJob(job); return;
    }
    if (!job.begun || !job.rolledBack) { rejectActor(); return; }
    if (keys(value, ['type', 'jobId', 'code']) && message.type === 'failure' && codes.includes(message.code as Code)) {
      job.failure ??= new LocalAlbumReadError(message.code as Code, '移动目录结构作者安全拒绝。'); finishJob(job); return;
    }
    if (job.entered && job.kind === 'prepare' && keys(value, ['type', 'jobId']) && message.type === 'prepared') { finishJob(job); return; }
    if (job.entered && job.kind === 'read' && keys(value, ['type', 'jobId', 'page']) && message.type === 'result'
      && isExpectedPage(message.page) && message.page.revision === job.scope.revision
      && message.page.items.every(row => job.scope.roots.some(view => view.root.id === row.album.rootId))) {
      job.page = message.page; finishJob(job); return;
    }
    rejectActor();
  }
  function ensureActor(): Actor {
    if (actor) return actor;
    const fileIdentity = mobileSqlFileIdentity(options.databaseFile), buffer = new SharedArrayBuffer(4);
    const env = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const settings: WorkerOptions = { env, workerData: { databaseFile: options.databaseFile, fileIdentity, cancellation: buffer,
      ...(indexDatasetId ? { purpose: 'artist-index', datasetId: indexDatasetId } : {}) } };
    const worker = options.workerFactory ? options.workerFactory(settings)
      : new Worker(options.entry ?? new URL('./mobile-sql-worker-entry.js', import.meta.url), settings);
    let finishExit!: () => void;
    actor = { worker, cancellation: new Int32Array(buffer), fileIdentity, opened: false, hasAudited: false, closedAck: false, neverOpened: false,
      closeSent: false, exited: false, exit: new Promise<void>(resolve => { finishExit = resolve; }), finishExit: () => finishExit() };
    const current = actor;
    worker.on('message', AsyncResource.bind(receive));
    worker.once('error', rejectActor);
    worker.once('messageerror', rejectActor);
    worker.once('exit', AsyncResource.bind(code => {
      current.exited = true;
      const physicallyClosed = current.opened ? current.closedAck && !current.neverOpened : current.neverOpened && !current.closedAck;
      if (code !== 0 || !current.closeSent || !physicallyClosed || active && !active.terminal && !current.neverOpened) fatal ??= fail();
      catalogTraceEvent('owner.sql.worker-exit', !fatal && code === 0 && physicallyClosed ? 'ok' : 'reject', { role: 'cleanup', count: 0 });
      if (active && !active.terminal) { active.failure ??= fatal ?? changed(); finishJob(active); }
      for (const waiter of [...waiters]) waiter.reject(fatal ?? changed());
      current.finishExit();
    }));
    return current;
  }
  async function execute(kind: 'prepare' | 'read', scope: LocalAlbumSqlScope, assertCurrent: () => void, request?: LocalAlbumSqlMobileQuery): Promise<Page | undefined> {
    catalogTraceEvent('owner.sql.admission', 'begin', { count: waiters.length + Number(reserved) });
    const release = await reserve(assertCurrent);
    let job: Job | undefined;
    let successful = false;
    try {
      if (closed || fatal) throw fatal ?? fail();
      assertCurrent();
      if (indexDatasetId && !scope.lyricsInventory) throw fail();
      const plainScope = { revision: scope.revision, roots: scope.roots, nameEnhancements: scope.nameEnhancements ?? [], libraryOrganizations: scope.libraryOrganizations ?? [],
        ...(indexDatasetId ? { lyricsRevision: scope.lyricsInventory!.revision() } : {}) };
      if (Buffer.byteLength(JSON.stringify({ request: request ?? null, scope: plainScope })) > 2 * 1024 * 1024) throw new LocalAlbumReadError('CONTENT_LIMIT_EXCEEDED', '移动目录的结构作用域超过原信封预算。');
      let done!: () => void;
      const completed = new Promise<void>(resolve => { done = resolve; });
      job = { id: ++sequence, kind, scope, cancellation: new Int32Array(new SharedArrayBuffer(4)), begun: false, entered: false,
        rolledBack: false, auditPhase: 0, terminal: false, poll: undefined, done, assertCurrent };
      active = job;
      const currentJob = job;
      currentJob.poll = setInterval(() => { try { assertCurrent(); } catch { currentJob.failure ??= changed(); Atomics.store(currentJob.cancellation, 0, 1); } }, 25);
      try {
        const current = ensureActor();
        if (current.exited || mobileSqlFileIdentity(options.databaseFile) !== current.fileIdentity) throw fail();
        const queueToken = options.queueAudit?.capture(scope);
        const previous = completedAudit;
        const queueFromJob = queueToken && previous?.actor === current && options.queueAudit?.continues(previous.token, queueToken)
          ? previous.jobId : null;
        completedAudit = undefined;
        // 令牌仅留在Owner；wire只关联该Actor上一项已成功完成且未撤销的作业。
        if (queueToken) job.queueToken = queueToken;
        catalogTraceEvent('owner.sql.admission', 'ok', { count: 1 });
        current.worker.postMessage({ type: 'job', jobId: job.id, kind, scope: plainScope, request: request ?? null, cancellation: job.cancellation.buffer, queueFromJob });
      } catch {
        rejectActor();
        if (!actor) { job.failure ??= fatal ?? fail(); finishJob(job); }
      }
      await completed;
      if (fatal) throw fatal;
      if (job.failure) throw job.failure;
      if (closed || Atomics.load(job.cancellation, 0) !== 0) throw changed();
      assertCurrent();
      if (!actor || mobileSqlFileIdentity(options.databaseFile) !== actor.fileIdentity) throw changed();
      if (kind === 'read' && !job.page) throw fail();
      if (job.queueToken) completedAudit = { actor, jobId: job.id, token: job.queueToken };
      successful = true;
      catalogTraceEvent('owner.sql.worker', 'ok', { count: job.page?.items.length ?? 0 });
      return job.page as Page | undefined;
    } finally {
      if (!successful) { completedAudit = undefined; if (job) Atomics.store(job.cancellation, 0, 1); }
      if (job?.poll) clearInterval(job.poll);
      if (active === job) active = undefined;
      release();
    }
  }
  return {
    /** 启动准入等待完整审计、全scope摘要预热与本作业真实回滚。 */
    async prepare(scope: LocalAlbumSqlScope, assertCurrent: () => void): Promise<void> { await execute('prepare', scope, assertCurrent); },
    async read(request: LocalAlbumSqlMobileQuery, scope: LocalAlbumSqlScope, assertCurrent: () => void): Promise<Page> {
      return (await execute('read', scope, assertCurrent, request))!;
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      closed = true;
      if (active && !active.terminal) { active.failure ??= changed(); Atomics.store(active.cancellation, 0, 1); }
      for (const waiter of [...waiters]) waiter.reject(changed());
      requestClose();
      const allIdle = reserved ? new Promise<void>(resolve => idle.push(resolve)) : Promise.resolve();
      closeFlight = (async () => { await allIdle; if (actor) await actor.exit; if (fatal) throw fatal; })();
      return closeFlight;
    },
  };
}
