import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import {
  RELOCATION_LEDGER_ROW_BYTES, RELOCATION_PHASE_ROW_BYTES, relocationEvent, relocationFail, relocationHash,
  relocationLedgerRow, relocationPolicy, relocationRequestFingerprint, relocationUnresolvedResources,
  type RelocationEvent, type RelocationReadView, type RelocationStoredPlan, type RelocationWriteView,
} from './local-relocation-journal.js';

/** 唯一catalog作者提供短同步闭包；叶store无SQL、raw DB、第二连接或另一个writer。 */
export interface RelocationCatalogPort {
  privateRelocationRead<T>(read: (view: RelocationReadView) => T): T;
  privateRelocationTransaction<T>(write: (view: RelocationWriteView) => T): T;
}
interface Cursor {
  datasetId: string; scope: string; offset: number; highWater: number; fingerprint: string; expiresAt: number;
  eventCount: number; planItems: dto.LocalRelocationPlanHistoryItem[] | null;
}
const terminal = (state: dto.LocalRelocationPlanState): boolean => ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(state);
/** 每resource留1条最大location fact及7条有限phase，另外32条最大计划终结行；先留真实字节再I/O。 */
export const relocationTerminalReserveBytes = (resources: number): number => resources * (RELOCATION_LEDGER_ROW_BYTES
  + (dto.LOCAL_RELOCATION_PLAN_BUDGET.terminalReservedEventsPerResource - 1) * RELOCATION_PHASE_ROW_BYTES)
  + dto.LOCAL_RELOCATION_PLAN_BUDGET.terminalReservedEventsPerPlan * RELOCATION_LEDGER_ROW_BYTES;
export function reserveRelocationJournal(view: RelocationReadView, resources = 0, extraBytes = 0): void {
  if (!Number.isSafeInteger(resources) || resources < 0 || resources > dto.LOCAL_RELOCATION_PLAN_BUDGET.closedResources || !Number.isSafeInteger(extraBytes) || extraBytes < 0) relocationFail('OVER_BUDGET');
  let required = view.projection.bytes + extraBytes + (resources ? relocationTerminalReserveBytes(resources) : 0);
  for (const stored of view.projection.plans.values()) if (!terminal(stored.plan.state) || relocationUnresolvedResources(stored).length) {
    required += relocationTerminalReserveBytes(Math.max(stored.resources.length, 1));
  }
  if (required > dto.LOCAL_RELOCATION_PLAN_BUDGET.journalProjectionBytes) relocationFail('OVER_BUDGET');
}
export function appendRelocationInView(view: RelocationWriteView, event: RelocationEvent, terminalEvent = false): void {
  if (!terminalEvent) {
    const bytes = Object.values(relocationLedgerRow(event)).reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
    reserveRelocationJournal(view, event.kind === 'receipt' && event.header ? 1 : 0, bytes);
    const stored = event.planId ? view.projection.plans.get(event.planId) : undefined;
    if (stored) {
      if (stored.events.length >= dto.LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerPlan - dto.LOCAL_RELOCATION_PLAN_BUDGET.terminalReservedEventsPerPlan
          - Math.max(stored.resources.length, 1) * dto.LOCAL_RELOCATION_PLAN_BUDGET.terminalReservedEventsPerResource) relocationFail('OVER_BUDGET');
      if (event.kind === 'phase' && (stored.phaseCounts.get(event.fact.resourceId) ?? 0) >= dto.LOCAL_RELOCATION_PLAN_BUDGET.phaseEventsPerResource
          - dto.LOCAL_RELOCATION_PLAN_BUDGET.terminalReservedEventsPerResource) relocationFail('OVER_BUDGET');
    }
  }
  view.append(event);
}
export function createLocalRelocationStore(catalog: RelocationCatalogPort, now: () => number = Date.now) {
  const cursors = new Map<string, Cursor>();
  let cursorBytes = 0;
  const cursorSize = (cursor: Cursor): number => Buffer.byteLength(JSON.stringify(cursor), 'utf8');
  const plan = (view: RelocationReadView, datasetId: string, planId: string): RelocationStoredPlan => {
    const stored = view.projection.plans.get(planId);
    if (!stored || stored.plan.datasetId !== datasetId) return relocationFail('NOT_FOUND');
    return stored;
  };
  const cache = <C extends dto.LocalRelocationPlanReceiptCommand>(view: RelocationReadView, command: C, request: dto.LocalRelocationPlanCommandPayloads[C]): dto.LocalRelocationPlanReceipt | null => {
    const event = view.receipt(request.commandId, relocationRequestFingerprint(command, request));
    if (!event) return null;
    if (event.command !== command || event.datasetId !== request.datasetId) return relocationFail('INVALID_REQUEST');
    return structuredClone(event.receipt);
  };
  const publicEvent = (event: RelocationEvent, sequence: number): dto.LocalRelocationPlanEvent => ({
    eventId: event.eventId, planId: event.planId!, journalSequence: String(sequence),
    operationId: event.kind === 'phase' || event.kind === 'location-facts' ? event.fact.operationId : null,
    resourceId: event.kind === 'phase' || event.kind === 'location-facts' ? event.fact.resourceId : null,
    phase: event.kind === 'phase' ? event.fact.phase : event.kind === 'location-facts' || event.kind === 'root-facts' ? 'REGISTERED'
      : event.kind === 'ready' ? 'PLANNED' : event.kind === 'capability' || event.kind === 'capability-consumed' ? 'RESERVED' : 'TERMINAL',
    occurredAt: event.occurredAt, label: event.kind === 'phase' ? '真实文件阶段已记录' : event.kind === 'location-facts' || event.kind === 'root-facts'
      ? '稳定身份的新位置和实际扫描事实已登记' : '位置计划历史已记录', issue: event.kind === 'state' ? event.issues[0] ?? null : null,
  });
  return {
    read<T>(read: (view: RelocationReadView) => T): T { return catalog.privateRelocationRead(read); },
    transaction<T>(write: (view: RelocationWriteView) => T): T { return catalog.privateRelocationTransaction(write); },
    policy(datasetId: string): dto.LocalRelocationPlanPolicy { return catalog.privateRelocationRead(view => relocationPolicy(view.projection, datasetId)); },
    plan(datasetId: string, planId: string): RelocationStoredPlan { return catalog.privateRelocationRead(view => structuredClone(plan(view, datasetId, planId))); },
    receipt<C extends dto.LocalRelocationPlanReceiptCommand>(command: C, request: dto.LocalRelocationPlanCommandPayloads[C]): dto.LocalRelocationPlanReceipt | null {
      return catalog.privateRelocationRead(view => cache(view, command, request));
    },
    capacity(resources: number, extraBytes = 0): void { catalog.privateRelocationRead(view => reserveRelocationJournal(view, resources, extraBytes)); },
    append(event: RelocationEvent, terminalEvent = false): void { catalog.privateRelocationTransaction(view => appendRelocationInView(view, event, terminalEvent)); },
    state(datasetId: string, planId: string, state: dto.LocalRelocationPlanState, issues: dto.LocalRelocationPlanIssue[] = [], terminalEvent = false,
      cleanup?: dto.LocalRelocationPlanCleanupView, recoveryChoices?: dto.LocalRelocationPlanRecoveryChoice[]): void {
      catalog.privateRelocationTransaction(view => {
        const stored = plan(view, datasetId, planId);
        appendRelocationInView(view, relocationEvent({ version: 1, eventId: randomUUID(), datasetId, planId, occurredAt: new Date(now()).toISOString(), kind: 'state',
          state, issues, cleanup: cleanup ?? stored.plan.cleanup, recoveryChoices: recoveryChoices ?? stored.plan.recoveryChoices }), terminalEvent);
      });
    },
    commandReceipt(datasetId: string, commandId: string, expectedCommand: dto.LocalRelocationPlanReceiptCommand, fingerprint: string): dto.LocalRelocationPlanReceipt | null {
      return catalog.privateRelocationRead(view => {
        const event = view.receipt(commandId, fingerprint);
        if (!event) return null;
        if (event.datasetId !== datasetId || event.command !== expectedCommand) return relocationFail('INVALID_REQUEST');
        return structuredClone(event.receipt);
      });
    },
    history(request: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.history']): dto.LocalRelocationPlanHistory {
      return catalog.privateRelocationRead(view => {
        const timestamp = now(); for (const [key, cursor] of cursors) if (cursor.expiresAt <= timestamp) { cursorBytes -= cursorSize(cursor); cursors.delete(key); }
        const scope = relocationHash({ datasetId: request.datasetId, selector: request.selector, limit: request.limit });
        let cursor: Cursor;
        if (request.cursor === null) {
          cursor = { datasetId: request.datasetId, scope, offset: 0, highWater: view.projection.highWater, fingerprint: view.projection.fingerprint,
            eventCount: view.projection.events.length, expiresAt: timestamp + 600_000, planItems: null };
          if (request.selector.kind === 'plans') {
            const items = [...view.projection.plans.values()].filter(value => value.plan.datasetId === request.datasetId).map(value => ({ planId: value.plan.planId, jobId: value.plan.jobId,
              viewRevision: value.plan.viewRevision, state: value.plan.state, createdAt: value.plan.createdAt, operations: value.operations.length, issue: value.plan.issues[0] ?? null }));
            // 计划摘要在首请求完整捕获；超过完整数据预算就拒绝，不截断历史快照。
            cursor.planItems = dto.localRelocationDataSnapshot(items) as dto.LocalRelocationPlanHistoryItem[];
          }
        } else {
          const original = cursors.get(request.cursor);
          if (!original || original.scope !== scope || original.datasetId !== request.datasetId) return relocationFail('STALE_VIEW');
          cursor = original;
        }
        let values: dto.LocalRelocationPlanHistoryItem[] | dto.LocalRelocationPlanEvent[];
        if (request.selector.kind === 'plans') values = cursor.planItems ?? [];
        else {
          plan(view, request.datasetId, request.selector.planId);
          // 事件不可变，首次水位固定后只读原前缀；后续写入不会改变这一页或借用新事件。
          const selectedPlanId = request.selector.planId;
          values = view.projection.events.slice(0, cursor.eventCount).filter(event => event.datasetId === request.datasetId && event.planId === selectedPlanId)
            .map((event, index) => publicEvent(event, index + 1));
        }
        const items = structuredClone(values.slice(cursor.offset, cursor.offset + request.limit)), hasMore = cursor.offset + items.length < values.length;
        let next: string | null = null;
        if (hasMore) {
          const value = { ...cursor, offset: cursor.offset + items.length }, bytes = cursorSize(value);
          if (cursors.size >= 100 || cursorBytes + bytes > dto.LOCAL_RELOCATION_PLAN_BUDGET.completePlanBodyContextBytes) return relocationFail('OVER_BUDGET');
          next = randomUUID(); cursors.set(next, value); cursorBytes += bytes;
        }
        const common = { datasetId: request.datasetId, snapshotFingerprint: cursor.fingerprint, limit: request.limit, cursor: next, hasMore };
        return request.selector.kind === 'plans' ? { ...common, kind: 'plans', items: items as dto.LocalRelocationPlanHistoryItem[] }
          : { ...common, kind: 'events', planId: request.selector.planId, items: items as dto.LocalRelocationPlanEvent[] };
      });
    },
    close(): void { cursors.clear(); cursorBytes = 0; },
  };
}
export type LocalRelocationStore = ReturnType<typeof createLocalRelocationStore>;
