import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { installLocalOrganizerHandlers } from '../src/main/local-organizer-ipc.js';
import { createLocalOrganizerClient } from '../src/preload/local-organizer-client.js';
import { createCommandOutboxClient } from '../src/preload/command-outbox-client.js';
import { createCommandOutboxExecutor } from '../src/main/command-outbox-executor.js';
import { createCommandOutboxStore } from '../src/main/command-outbox-store.js';
import { createCommandOutboxService } from '../src/main/command-outbox-service.js';
import { installCommandOutboxIpc } from '../src/main/command-outbox-ipc.js';
import { CoreIpcError } from '../src/main/core-supervisor.js';
import { organizerPlanFixture } from '../../../packages/contracts/test/mbrs011/fixture.js';
import { catalogFixture } from '../../../packages/bridge-core/test/mbrs006/catalog-fixture.js';
import { createCollectionRepository } from '../../../packages/bridge-core/src/collection/repository.js';
import { createTestDatasetDomain } from '../../../packages/bridge-core/src/collection/dataset-domain.js';
import type { IpcCommand, LocalOrganizerPlan } from '@music-bridge/contracts';

test('011Main固定四命令闭集，confirm/undo不穿普通channel，getter零执行，私有失败不外泄', async () => {
  const plan = organizerPlanFixture(), handlers = new Map<string, (event: { trusted: boolean }, value: unknown) => unknown>(); let calls = 0;
  installLocalOrganizerHandlers({ handle: (channel, fn) => handlers.set(channel, fn), requireTrusted: (event: { trusted: boolean }) => { if (!event.trusted) throw new Error('不可信窗口'); }, supervisor: { request: async () => { calls++; return plan; } } as any });
  const handler = handlers.get('localOrganizer:request')!, request = { datasetId: plan.datasetId, command: 'localOrganizer.get', payload: { planId: plan.planId } };
  assert.deepEqual(await handler({ trusted: true }, request), plan);
  for (const command of ['localOrganizer.confirm', 'localOrganizer.undo', 'localCatalog.overrideMetadata', 'playback.play']) await assert.rejects(async () => handler({ trusted: true }, { ...request, command }));
  await assert.rejects(async () => handler({ trusted: false }, request)); await assert.rejects(async () => handler({ trusted: true }, { ...request, absolutePath: '/禁止' }));
  let getterCalls = 0; const bad = { ...request }; Object.defineProperty(bad, 'payload', { enumerable: true, get() { getterCalls++; return request.payload; } }); await assert.rejects(async () => handler({ trusted: true }, bad));
  assert.equal(getterCalls, 0); assert.equal(calls, 1);
  installLocalOrganizerHandlers({ handle: (channel, fn) => handlers.set(channel, fn), requireTrusted() {}, supervisor: { request: async () => { throw new CoreIpcError('INVENTORY_UNAVAILABLE', '/合成私密/路径 token-secret'); } } as any });
  await assert.rejects(async () => handlers.get('localOrganizer:request')!({ trusted: true }, request), error => error instanceof Error && error.message.includes('现有音乐库保留') && !error.message.includes('token-secret') && !error.message.includes('/合成私密'));
});
test('011preload先校验再clone，六具名方法固定scope，confirm/undo仅调用原outbox适配器', async () => {
  const plan = organizerPlanFixture(), invokes: unknown[] = [], writes: string[] = [];
  const client = createLocalOrganizerClient(async (_channel, value) => { invokes.push(value); return plan; }, async () => plan.datasetId, {
    confirm: async () => { writes.push('confirm'); return { ...plan, state: 'COMPLETED' }; }, undo: async request => { writes.push('undo'); return { ...plan, planId: request.commandId, undoOf: request.planId }; },
  });
  await client.getLocalOrganizerPlan({ planId: plan.planId });
  await client.confirmLocalOrganizer({ commandId: randomUUID(), planId: plan.planId, expectedRevision: plan.revision, scope: plan.scope, planHash: plan.planHash, contextFingerprint: plan.contextFingerprint });
  await client.undoLocalOrganizer({ commandId: randomUUID(), planId: plan.planId, expectedRevision: plan.revision }); assert.deepEqual(writes, ['confirm', 'undo']); assert.equal(invokes.length, 1);
  let getterCalls = 0; const bad = Object.defineProperty({ commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'single', trackId: randomUUID() } }, 'patch', { enumerable: true, get() { getterCalls++; return { fields: {} }; } });
  await assert.rejects(async () => client.previewLocalOrganizer(bad as any)); assert.equal(getterCalls, 0); assert.equal(invokes.length, 1);
  const wrongScope = createLocalOrganizerClient(async () => ({ ...plan, datasetId: randomUUID() }), async () => plan.datasetId, { confirm: async () => plan, undo: async () => plan }); await assert.rejects(() => wrongScope.getLocalOrganizerPlan({ planId: plan.planId }));
});
test('011真实Main outbox→Dataset原Node SQLite作者→preload确认/撤销回执，未启动Electron或Provider', async t => {
  const f = await catalogFixture(t); f.repository.close(); const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') }), domain = createTestDatasetDomain({ collectionRepository: repository, collectionDatasetIdentity: { datasetId: f.datasetId, assertCurrent() {} } });
  const handlers = new Map<string, (event: object, value?: unknown) => unknown>(), calls: string[] = [], handle = (channel: string, fn: (event: object, value?: unknown) => unknown) => handlers.set(channel, fn);
  const supervisor = { request: async (command: IpcCommand, payload: unknown, expectedDatasetId?: string) => { calls.push(command); return domain.dispatch({ version: 1, id: randomUUID(), command, payload, ...(expectedDatasetId ? { expectedDatasetId } : {}) }); }, requestInternal: async () => { throw new Error('不得进入内部源写'); }, activateRestoredDataset: async () => { throw new Error('不得激活库'); } };
  const store = createCommandOutboxStore({ filePath: path.join(f.directory, 'organizer-outbox.sqlite') }), executor = createCommandOutboxExecutor({ supervisor: supervisor as any, pick: async () => { throw new Error('整理没有picker'); } });
  const outbox = createCommandOutboxService({ store, currentDataset: async () => f.datasetId, ...executor });
  installCommandOutboxIpc({ handle, requireTrusted() {}, context: async () => ({ datasetId: f.datasetId }), service: outbox, store }); installLocalOrganizerHandlers({ handle, requireTrusted() {}, supervisor: supervisor as any });
  const invoke = async (channel: string, value?: unknown) => handlers.get(channel)!({}, value), write = createCommandOutboxClient(invoke, async () => f.datasetId);
  const client = createLocalOrganizerClient(invoke, async () => f.datasetId, { confirm: request => write.submit('localOrganizer.confirm', request), undo: request => write.submit('localOrganizer.undo', request) });
  try {
    const preview = await client.previewLocalOrganizer({ commandId: randomUUID(), scope: 'MB_ONLY', target: { mode: 'batch', trackIds: f.tracks.map(track => track.id) }, patch: { fields: { title: { action: 'set', value: '真实原作者的合成确认' } } } });
    const confirm = (plan: LocalOrganizerPlan) => ({ commandId: randomUUID(), planId: plan.planId, expectedRevision: plan.revision, scope: plan.scope, planHash: plan.planHash, contextFingerprint: plan.contextFingerprint });
    const confirmed = await client.confirmLocalOrganizer(confirm(preview)); assert.equal(confirmed.state, 'COMPLETED'); assert.ok(f.tracks.every(track => repository.localCatalog.metadata(track.id).effective.title === '真实原作者的合成确认'));
    const inverse = await client.undoLocalOrganizer({ commandId: randomUUID(), planId: confirmed.planId, expectedRevision: confirmed.revision }); assert.equal(inverse.state, 'DRAFT');
    const undone = await client.confirmLocalOrganizer(confirm(inverse)); assert.equal(undone.state, 'COMPLETED'); assert.equal((await client.getLocalOrganizerPlan({ planId: confirmed.planId })).state, 'ROLLED_BACK');
    const history = await client.listLocalOrganizerHistory({ offset: 0, limit: 10 }); assert.equal(history.total, 2);
    assert.equal(calls.filter(command => command === 'commandOutbox.execute').length, 3); assert.equal(calls.filter(command => command === 'localCatalog.overrideMetadata').length, 0);
    assert.equal(store.list().filter(entry => ['localOrganizer.confirm', 'localOrganizer.undo'].includes(entry.command)).length, 3);
  } finally { await outbox.close(); await domain.close(); }
});
