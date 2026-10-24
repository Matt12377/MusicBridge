import { writeSync } from 'node:fs';
import {
  MOBILE_CAPABILITY_TRACE_PREFIX, MOBILE_RESOURCE_CAPACITY_STAGES, captureMobileCapabilityContext,
  copyMobileCapabilityTraceRecord, createMobileCapabilityContext, mobileCapabilityReject,
  type MobileCapabilityComponent, type MobileCapabilityContext, type MobileCapabilityIdKind,
} from './capability-trace.js';

export const MOBILE_RESOURCE_CAPACITY_FLAG = '--mb-private-resource-capacity-trace';
export type MobileResourceCapacityStage = typeof MOBILE_RESOURCE_CAPACITY_STAGES[number];
const stages = new Set<string>(MOBILE_RESOURCE_CAPACITY_STAGES);
const contexts = new WeakSet<MobileCapabilityContext>();

/** 独立的稀疏旁注，不进入原两次 preparation snapshot 或公开合同。 */
export function createMobileResourceCapacityProbe(options: {
  enabled?: boolean; sink?: (line: string) => void;
} = {}) {
  let claimed = 0;
  return {
    claim(id: string, component: MobileCapabilityComponent, kind: MobileCapabilityIdKind,
      signal?: AbortSignal, existing?: MobileCapabilityContext): MobileCapabilityContext | undefined {
      try {
        if (options.enabled !== true || claimed >= 128) return undefined;
        let emitted = false, links = 0;
        const sink = (line: string): void => {
          try {
            if (typeof line !== 'string' || !line.startsWith(MOBILE_CAPABILITY_TRACE_PREFIX) || Buffer.byteLength(line) > 4096) return;
            const row = copyMobileCapabilityTraceRecord(JSON.parse(line.slice(MOBILE_CAPABILITY_TRACE_PREFIX.length)));
            if (!row) return;
            const rejection = row.phase === 'reject' && (stages.has(row.stage) || row.stage.startsWith('preparation.playback.codec.'));
            const link = row.component === 'main' && row.parentSha256 !== null && row.stage === 'content.rpc.source' && row.phase === 'begin';
            if (rejection ? emitted : !link || links >= 4) return;
            if (rejection) emitted = true; else links++;
            (options.sink ?? (value => { writeSync(1, value); }))(MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(row) + '\n');
          } catch { /* 旁注出口和解析失败不改变原工作。 */ }
        };
        const context = existing ?? createMobileCapabilityContext(id, component, kind, null, signal, sink);
        if (!context) return undefined;
        claimed++; contexts.add(context);
        // 只让既有 codec 拒绝边界可以旁注；不增加原 snapshot 的 scope。
        if (!existing) context.preparation = true;
        return context;
      } catch { return undefined; }
    },
  };
}

/** 原失败工作恰执行一次，原错误对象不改；仅标记已经命中的准确容量守门。 */
export function mobileResourceCapacityFailure<T>(stage: MobileResourceCapacityStage, work: () => T): T {
  try { return work(); }
  catch (error) {
    try {
      const context = captureMobileCapabilityContext();
      if (context && contexts.has(context) && stages.has(stage)) mobileCapabilityReject(stage, error);
    } catch { /* 取证失败不替换原拒绝。 */ }
    throw error;
  }
}
