import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { isLocalCatalogReceipt, type IpcRequest, type IpcCommand, type LocalCatalogOperation } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../../../packages/bridge-core/src/collection/dataset-owner-client.js';
import { createCollectionRepository } from '../../../../packages/bridge-core/src/collection/repository.js';
import { createCommandOutboxStore } from '../../src/main/command-outbox-store.js';
import { createCommandOutboxService } from '../../src/main/command-outbox-service.js';
import { buildStoragePolicy } from '../../scripts/build-storage-root.mjs';

const cleanupOwners = new Map<string, Array<() => Promise<void>>>();
async function directory(t: test.TestContext): Promise<string> {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, {mustExist:true});
  const value = await mkdtemp(path.join(temporary,'musicbridge-local-owner-')); storage.check(value,{mustExist:true});
  t.after(async () => { for (const close of cleanupOwners.get(value) ?? []) await close(); cleanupOwners.delete(value); await rm(value,{recursive:true,force:true}); }); return value;
}
function request(command: IpcCommand, payload: unknown, datasetId?: string): IpcRequest {
  return {version:1,id:randomUUID(),command,payload,...(datasetId === undefined ? {} : {expectedDatasetId:datasetId})};
}
function owner(t: test.TestContext, dataDirectory: string, crashAfterLocalCommand?: string) {
  const worker = new Worker(new URL('../../../../packages/bridge-core/test/helpers/dataset-owner-domain-fixture.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory,...(crashAfterLocalCommand ? {crashAfterLocalCommand} : {})}});
  const fatal: string[] = [], endpoint = createDatasetOwnerClient({worker,onFatal: reason => fatal.push(reason)});
  const close = async () => { if (worker.threadId !== -1) await endpoint.close().catch(() => worker.terminate()); };
  const handlers = cleanupOwners.get(dataDirectory) ?? []; handlers.push(close); cleanupOwners.set(dataDirectory,handlers);
  t.after(close);
  return {worker,endpoint,fatal};
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function fingerprint(operation: LocalCatalogOperation, payload: unknown): string { return createHash('sha256').update(canonical([operation,payload])).digest('hex'); }
test('MBRS002 B2 outbox：真实Main账本到owner提交断回执，冷恢复零发送且显式retry复用完整请求', {timeout:40_000}, async t => {
  const parent = await directory(t), f = owner(t,parent,'localCatalog.createEdition'), identity = await f.endpoint.prepare();
  const filePath = path.join(parent,'main-outbox.sqlite'); let store = createCommandOutboxStore({filePath});
  const input = {datasetId:identity.datasetId,command:'localCatalog.createEdition' as const,payload:{commandId:randomUUID(),title:'UNKNOWN合成',edition:'甲'}};
  const sent: unknown[] = [];
  let service = createCommandOutboxService({store,currentDataset:async () => identity.datasetId,execute:async entry => { const body = {datasetId:entry.datasetId,command:entry.command,payload:entry.payload}; sent.push(structuredClone(body)); const result = await f.endpoint.dispatch(request('commandOutbox.execute',body,entry.datasetId)) as {result:unknown}; return result.result; }});
  await assert.rejects(service.submit(input),{code:'OUTBOX_RESULT_UNKNOWN'});
  assert.equal(sent.length,1); const entry = store.list()[0]!; assert.equal(store.get(entry.id).state,'uncertain'); assert.deepEqual(store.get(entry.id).payload,input.payload);
  if (f.worker.threadId !== -1) await once(f.worker,'exit');
  assert.equal(f.worker.threadId,-1); await service.close();
  const fresh = owner(t,parent), freshIdentity = await fresh.endpoint.prepare(); assert.equal(freshIdentity.datasetId,identity.datasetId);
  const receiptRequest = {commandId:input.payload.commandId,operation:'create-edition' as const,fingerprint:fingerprint('create-edition',input.payload)};
  const receipt = await fresh.endpoint.dispatch(request('localCatalog.receipt',receiptRequest,identity.datasetId)); assert.ok(isLocalCatalogReceipt(receipt));
  store = createCommandOutboxStore({filePath});
  service = createCommandOutboxService({store,currentDataset:async () => freshIdentity.datasetId,execute:async persisted => { const body = {datasetId:persisted.datasetId,command:persisted.command,payload:persisted.payload}; sent.push(structuredClone(body)); const result = await fresh.endpoint.dispatch(request('commandOutbox.execute',body,persisted.datasetId)) as {result:unknown}; return result.result; }});
  assert.equal((await service.list()).entries.length,1); assert.equal(sent.length,1); assert.equal(store.get(entry.id).state,'uncertain');
  await assert.rejects(service.retry({id:entry.id} as never)); assert.equal(sent.length,1);
  const retried = await service.retry({id:entry.id,userConfirmed:true}); assert.deepEqual(retried.result,receipt.result); assert.equal(sent.length,2); assert.deepEqual(sent[0],input); assert.deepEqual(sent[1],sent[0]);
  assert.equal(store.get(entry.id).state,'succeeded'); assert.deepEqual(store.get(entry.id).payload,input.payload);
  await service.close(); await fresh.endpoint.close();
  const cold = createCollectionRepository({filePath:path.join(parent,'collection.v1.sqlite')});
  try { assert.deepEqual(cold.localCatalog.receipt(input.payload.commandId),receipt); }
  finally { cold.close(); }
  const db = new DatabaseSync(path.join(parent,'collection.v1.sqlite'),{readOnly:true});
  try { assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_editions').get()!.n,1); assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()!.n,1); }
  finally { db.close(); }
  // 两个独立DB：业务receipt确认不等Main回执落盘，全链在显式retry后才共同可观测。
});


test('MBRS002 B2 outbox：业务已提交而Main成功回执落盘失败保留UNKNOWN，两库不冒充全局事务', {timeout:30_000}, async t => {
  const parent = await directory(t), f = owner(t,parent), identity = await f.endpoint.prepare();
  const filePath = path.join(parent,'main-outbox.sqlite'); let store = createCommandOutboxStore({filePath});
  const input = {datasetId:identity.datasetId,command:'localCatalog.createEdition' as const,payload:{commandId:randomUUID(),title:'Main落盘故障',edition:''}};
  let sent = 0; const sentBodies: unknown[] = [];
  let service = createCommandOutboxService({store,currentDataset:async () => identity.datasetId,execute:async entry => {
    const body = {datasetId:entry.datasetId,command:entry.command,payload:entry.payload};
    sent++; sentBodies.push(structuredClone(body));
    const result = await f.endpoint.dispatch(request('commandOutbox.execute',body,entry.datasetId)) as {result:unknown}; return result.result;
  }});
  const fault = t.mock.method(store,'succeed',() => { throw new Error('合成Main成功回执落盘故障'); });
  await assert.rejects(service.submit(input),{code:'OUTBOX_RESULT_UNKNOWN'}); const entry = store.list()[0]!; assert.equal(store.get(entry.id).state,'uncertain');
  const receiptRequest = {commandId:input.payload.commandId,operation:'create-edition' as const,fingerprint:fingerprint('create-edition',input.payload)};
  const receipt = await f.endpoint.dispatch(request('localCatalog.receipt',receiptRequest,identity.datasetId)); assert.ok(isLocalCatalogReceipt(receipt));
  assert.equal(sent,1); assert.deepEqual(store.get(entry.id).payload,input.payload); fault.mock.restore();
  await service.close(); await f.endpoint.close();
  // 业务已提交而Main回执未落盘：三个对象都冷重建，不能借旧service内存确认成功。
  const fresh = owner(t,parent), freshIdentity = await fresh.endpoint.prepare(); assert.equal(freshIdentity.datasetId,identity.datasetId);
  store = createCommandOutboxStore({filePath});
  service = createCommandOutboxService({store,currentDataset:async () => freshIdentity.datasetId,execute:async persisted => {
    const body = {datasetId:persisted.datasetId,command:persisted.command,payload:persisted.payload};
    sent++; sentBodies.push(structuredClone(body));
    const result = await fresh.endpoint.dispatch(request('commandOutbox.execute',body,persisted.datasetId)) as {result:unknown}; return result.result;
  }});
  const overview = await service.list(); assert.equal(overview.entries.length,1); assert.equal(overview.entries[0]!.state,'uncertain');
  assert.equal(store.get(entry.id).state,'uncertain'); assert.deepEqual(store.get(entry.id).payload,input.payload); assert.equal(sent,1);
  assert.deepEqual(await fresh.endpoint.dispatch(request('localCatalog.receipt',receiptRequest,freshIdentity.datasetId)),receipt); assert.equal(sent,1);
  await assert.rejects(service.retry({id:entry.id} as never)); assert.equal(sent,1);
  const retried = await service.retry({id:entry.id,userConfirmed:true}); assert.deepEqual(retried.result,receipt.result); assert.equal(sent,2);
  assert.deepEqual(sentBodies[0],input); assert.deepEqual(sentBodies[1],sentBodies[0]);
  assert.equal(store.get(entry.id).state,'succeeded'); assert.deepEqual(store.get(entry.id).payload,input.payload);
  await service.close(); await fresh.endpoint.close();
  const db = new DatabaseSync(path.join(parent,'collection.v1.sqlite'),{readOnly:true});
  try { assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_editions').get()!.n,1); assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()!.n,1); }
  finally { db.close(); }
});
