import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { registerHooks } from 'node:module';
import { installMobileSqlQueryGate } from './mobile-sql-query-gate.js';

/** 仅注入闭集协议故障；生产入口仍实际打开、审计、查询、回滚与关闭合成库。 */
const fault = workerData.testLifecycleFault as string;
const control = workerData.testLifecycleControl as MessagePort;
const gate = workerData.testLifecycleGate as SharedArrayBuffer;
delete workerData.testLifecycleFault; delete workerData.testLifecycleControl; delete workerData.testLifecycleGate;
const released = () => new Promise<void>(resolve => control.once('message', () => resolve()));
const originalSend = parentPort!.postMessage.bind(parentPort!);
parentPort!.postMessage = ((message: unknown, ...rest: unknown[]) => {
  const value = message as { type?: string; stage?: string; jobId?: number };
  if (value?.type === 'stage') control.postMessage({ type: `lifecycle.${value.stage}` });
  if (value?.type === 'never-opened') control.postMessage({ type: 'lifecycle.never-opened' });
  if (fault === 'forged-never-opened' && value?.type === 'stage' && value.stage === 'audit-begin') originalSend({ type: 'never-opened', code: 'SNAPSHOT_CHANGED' });
  if (value?.type === 'stage' && (fault === 'missing-closed' && value.stage === 'closed'
    || fault === 'missing-rollback' && value.stage === 'rollback' || fault === 'missing-audit' && value.stage === 'audit-catalog')) return;
  if (fault === 'wrong-job' && value?.type === 'stage' && value.stage === 'rollback') {
    originalSend({ ...value, jobId: value.jobId! + 1 }); return;
  }
  if (value?.type === 'never-opened' && fault === 'missing-never-opened') return;
  Reflect.apply(originalSend, parentPort, [message, ...rest]);
  if (value?.type === 'result' && fault === 'duplicate-result') originalSend(message);
  if (value?.type === 'never-opened' && fault === 'duplicate-never-opened') originalSend(message);
  if (value?.type === 'never-opened' && fault === 'never-opened-mixed-stage') originalSend({ type: 'stage', stage: 'closed' });
}) as NonNullable<typeof parentPort>['postMessage'];
const partialState: { handle?: { close(): void }; opened: boolean } = { opened: false };
let hooks: ReturnType<typeof registerHooks> | undefined;
const partialKey = Symbol.for('mb.mobile.sql.test.partial-sqlite');
if (fault === 'partial-constructor') {
  Reflect.set(globalThis, partialKey, partialState);
  const shim = `import { DatabaseSync as Original } from 'node:sqlite'; export * from 'node:sqlite';
    export class DatabaseSync extends Original { constructor(...args) { super(...args);
      const state=globalThis[Symbol.for('mb.mobile.sql.test.partial-sqlite')];state.handle=this;state.opened=true;throw new Error('受控构造中途异常。'); } }`;
  const url = 'data:text/javascript,' + encodeURIComponent(shim);
  hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === 'node:sqlite' && context.parentURL !== url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  } });
}
if (fault === 'sql-hold') installMobileSqlQueryGate(gate, control);
if (['startup-hold', 'startup-and-exit-hold', 'missing-never-opened', 'duplicate-never-opened', 'never-opened-mixed-stage'].includes(fault)) {
  control.postMessage({ type: 'lifecycle.startup-held' }); await released();
}
try { await import('../../src/collection/local-album-browser/mobile-sql-worker-entry.js'); }
finally {
  hooks?.deregister();
  if (partialState.opened) control.postMessage({ type: 'lifecycle.constructor-opened' });
  partialState.handle?.close(); Reflect.deleteProperty(globalThis, partialKey);
  if (['exit-hold', 'startup-and-exit-hold'].includes(fault)) { control.postMessage({ type: 'lifecycle.exit-held' }); await released(); }
  control.close();
}
