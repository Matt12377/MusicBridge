import type { RecordingOutputCheckRequest, RecordingOutputCancelRequest, RecordingOutputStatus } from '@music-bridge/contracts';
import type { RecordingPlanStore } from './plan-store.js';
import { createRecordingOutputCoordinator } from './output-check.js';
import { createOutputHelperRunner } from './output-helper.js';
import { verifyPinnedOutputHelper, type PinnedOutputHelper } from './bundled-output-helper.js';
import { outputCheckFail } from './output-error.js';

export function createRecordingOutputService(options: { store?: RecordingPlanStore; helper?: PinnedOutputHelper }) {
  let closed = false; const statuses = new Set<Promise<RecordingOutputStatus>>();
  const coordinator = options.store && options.helper ? createRecordingOutputCoordinator({ store: options.store, runner: createOutputHelperRunner(options.helper) }) : undefined;
  function open() { if (closed) return outputCheckFail('CLOSED'); }
  return {
    async status(): Promise<RecordingOutputStatus> {
      open(); const promise = (async (): Promise<RecordingOutputStatus> => {
        let available = false;
        if (options.helper) { try { await verifyPinnedOutputHelper(options.helper); available = !!coordinator; } catch { /* 构建变化只禁用检查，不损坏其他播放服务。 */ } }
        open(); return { backend: { id: 'musicbridge-coreaudio-hal', version: '0.1.0', halAdapterCompiled: available }, syntheticCheck: { available, helperSha256: available ? options.helper!.sha256 : null, protocolVersion: 1 }, deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false };
      })();
      statuses.add(promise); try { return await promise; } finally { statuses.delete(promise); }
    },
    async check(request: RecordingOutputCheckRequest) { open(); if (!coordinator) return outputCheckFail('HELPER_UNAVAILABLE'); return coordinator.check(request); },
    cancel(request: RecordingOutputCancelRequest) { open(); if (!coordinator) return outputCheckFail('HELPER_UNAVAILABLE'); return coordinator.cancel(request); },
    async close() { closed = true; await coordinator?.close(); await Promise.allSettled(statuses); },
  };
}
export type RecordingOutputService = ReturnType<typeof createRecordingOutputService>;
