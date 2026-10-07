import { lstat } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import { CollectionError } from './repository.js';
import { readonlySourceCandidateMetadata, sourceRootAvailability } from '../recording/source-files.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { createLocalOrganizerStore, OrganizerConflict } from './local-organizer-store.js';
import { organizerEqual } from './local-organizer-journal.js';

/** 文件stat在事务外，MB覆盖在原同步事务内；取消在确认和提交之间重新检查。 */
interface OrganizerOptions { repository: CollectionRepository; datasetId: string; assertCurrent(): void }
interface ObservationPort { timeoutMs: number; observe(item: dto.LocalOrganizerItem, assertActive: () => void): Promise<dto.LocalOrganizerItem['sourceObservation']> }
function composeOrganizerService(options: OrganizerOptions, observationPort?: ObservationPort) {
  const repository = options.repository;
  const store = createLocalOrganizerStore({ catalog: repository.localCatalog, sources: repository.sources, datasetId: options.datasetId, assertCurrent: options.assertCurrent });
  let closed = false, fatal = false;
  const active = new Set<string>(), pending = new Set<Promise<unknown>>();
  const cancelObservers = new Set<() => void>();
  const physicalObservations = new Set<Promise<dto.LocalOrganizerItem['sourceObservation'][]>>();
  const check = (): void => { options.assertCurrent(); if (closed || fatal) throw new CollectionError('INVENTORY_UNAVAILABLE', '整理作者已停止，现有工作库保留。'); };
  function checked<C extends dto.LocalOrganizerCommand>(command: C, request: unknown): asserts request is dto.LocalOrganizerCommandPayloads[C] {
    check(); if (!dto.isLocalOrganizerCommandPayload(command, request)) throw new CollectionError('INVENTORY_CONFLICT', '整理请求字段或范围无效。');
  }
  function run<T>(commandId: string, operation: () => Promise<T>): Promise<T> {
    check(); if (active.has(commandId) || active.size >= 2) throw new CollectionError('INVENTORY_CONFLICT', '整理观察正在进行，请稍后重试当前操作。');
    active.add(commandId);
    const task = operation().catch(error => { if (error instanceof LocalFactsCommitFatal) fatal = true; throw error; }).finally(() => { active.delete(commandId); pending.delete(task); }); pending.add(task); return task;
  }
  async function observeOne(item: dto.LocalOrganizerItem, alive: () => void): Promise<dto.LocalOrganizerItem['sourceObservation']> {
      alive();
      const capability = repository.sources.root(item.permission.sourceRootId);
      let observation: dto.LocalOrganizerItem['sourceObservation'] = { status: 'unknown', fileSignature: null, permissionMode: null, rootPermissionMode: null, directoryIds: [] };
      try {
        const available = await sourceRootAvailability(capability); alive();
        if (available === 'ONLINE') {
          const before = await readonlySourceCandidateMetadata(capability, item.operation.source_relative_path); alive();
          const root = await lstat(capability.path, { bigint: true }); alive();
          const file = await lstat(path.join(capability.path, item.operation.source_relative_path), { bigint: true }); alive();
          const after = await readonlySourceCandidateMetadata(capability, item.operation.source_relative_path); alive();
          const signature = [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
          if (!file.isFile() || file.isSymbolicLink() || !root.isDirectory() || root.isSymbolicLink() || String(root.dev) !== capability.dev || String(root.ino) !== capability.ino || before.signature !== after.signature
            || after.signature !== signature || !organizerEqual(before.directoryIds, after.directoryIds)) throw new OrganizerConflict('SOURCE_CHANGED_DURING_OBSERVATION');
          observation = { status: 'observed', fileSignature: signature, permissionMode: String(file.mode), rootPermissionMode: String(root.mode), directoryIds: [...after.directoryIds] };
        }
      } catch (error) { if (error instanceof OrganizerConflict) throw error; /* 离线或不可读保留unknown；MB_ONLY不推断源写许可。 */ }
      alive(); return observation;
  }
  async function observe(items: readonly dto.LocalOrganizerItem[]): Promise<dto.LocalOrganizerItem['sourceObservation'][]> {
    if (physicalObservations.size >= 2) throw new OrganizerConflict('SOURCE_OBSERVATION_PENDING');
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const alive = (): void => { check(); if (stopped) throw new OrganizerConflict('SOURCE_OBSERVATION_TIMEOUT'); };
    const work = (async () => { const values: dto.LocalOrganizerItem['sourceObservation'][] = []; for (const item of items) { alive(); values.push(await (observationPort ? observationPort.observe(item, alive) : observeOne(item, alive))); alive(); } return values; })();
    // OS stat不能保证物理取消；围栏保证逻辑超时后不再发起下一观察或任何数据库动作。
    physicalObservations.add(work); void work.finally(() => physicalObservations.delete(work)).catch(() => undefined);
    let stop!: () => void;
    const bound = new Promise<never>((_resolve, reject) => {
      stop = () => { stopped = true; reject(new OrganizerConflict('SOURCE_OBSERVATION_TIMEOUT')); };
      cancelObservers.add(stop); timer = setTimeout(stop, observationPort?.timeoutMs ?? 15_000);
    });
    try { return await Promise.race([work, bound]); }
    finally { stopped = true; if (timer) clearTimeout(timer); cancelObservers.delete(stop); }
  }
  const times = (): [string, string] => { const now = Date.now(); return [new Date(now).toISOString(), new Date(now + 15 * 60_000).toISOString()]; };
  return {
    preview(request: dto.PreviewLocalOrganizer): Promise<dto.LocalOrganizerPlan> {
      checked('localOrganizer.preview', request); const captured = structuredClone(request), old = store.prior(captured.commandId, 'preview', captured); if (old) return Promise.resolve(old);
      return run(captured.commandId, async () => {
        const prepared = store.capturePreview(captured), observations = await observe(prepared.items);
        prepared.items.forEach((item, i) => { item.sourceObservation = observations[i]!; }); check();
        const [created, expires] = times(); return store.persistPreview(captured, prepared, created, expires);
      });
    },
    get(request: { planId: string }): dto.LocalOrganizerPlan { checked('localOrganizer.get', request); return store.get(request.planId, !active.has(request.planId)); },
    history(request: { offset: number; limit: number }): dto.LocalOrganizerCommandResults['localOrganizer.history'] { checked('localOrganizer.history', request); return store.history(request); },
    confirm(request: dto.ConfirmLocalOrganizer): Promise<dto.LocalOrganizerPlan> {
      checked('localOrganizer.confirm', request); const captured = structuredClone(request), old = store.prior(captured.commandId, 'confirm', captured); if (old) return Promise.resolve(store.get(old.planId, !active.has(old.planId)));
      const plan = store.prepareConfirm(captured);
      return run(plan.planId, async () => {
        const first = await observe(plan.items); check(); const confirmed = store.confirm(captured, first, Date.now()); if (confirmed.state !== 'CONFIRMED') return confirmed;
        try { const execution = await observe(confirmed.items); check(); return store.apply(captured, execution); }
        catch (error) {
          if (error instanceof LocalFactsCommitFatal) { fatal = true; throw error; }
          // privateBatch只有确认ROLLBACK成功才抛业务错误；未知COMMIT不落伪失败回执。
          check(); return store.failConfirmed(plan.planId, captured.commandId, error instanceof OrganizerConflict ? error.issue : 'MB_OVERRIDE_TRANSACTION_FAILED');
        }
      });
    },
    undo(request: dto.ChangeLocalOrganizer): Promise<dto.LocalOrganizerPlan> {
      checked('localOrganizer.undo', request); const captured = structuredClone(request), old = store.prior(captured.commandId, 'undo', captured); if (old) return Promise.resolve(old);
      return run(captured.commandId, async () => {
        const prepared = store.captureUndo(captured), observations = await observe(prepared.capture.items);
        prepared.capture.items.forEach((item, i) => { item.sourceObservation = observations[i]!; }); check(); const [created, expires] = times();
        return store.persistUndo(captured, prepared.capture, prepared.original, created, expires);
      });
    },
    cancel(request: dto.ChangeLocalOrganizer): dto.LocalOrganizerPlan { checked('localOrganizer.cancel', request); return store.cancel(structuredClone(request)); },
    async close(): Promise<void> { closed = true; for (const stop of cancelObservers) stop(); await Promise.allSettled([...pending]); if (fatal) throw new Error('整理提交结果未知，工作库连接保留。'); },
  };
}
export function createLocalOrganizerService(options: OrganizerOptions) { return composeOrganizerService(options); }
/** 受控故障端口只供合成测试，生产工厂不接受超时或观察替代。 */
export function createTestLocalOrganizerService(options: OrganizerOptions, port: ObservationPort) {
  if (!Number.isSafeInteger(port.timeoutMs) || port.timeoutMs < 1 || port.timeoutMs > 15_000) throw new Error('合成观察时限无效。');
  return composeOrganizerService(options, port);
}
export type LocalOrganizerService = ReturnType<typeof createLocalOrganizerService>;
