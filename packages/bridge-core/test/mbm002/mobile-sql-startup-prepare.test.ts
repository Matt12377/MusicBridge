import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker, MessageChannel } from 'node:worker_threads';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js';
import { DatasetOwnerDispatchError } from '../../src/collection/dataset-owner-protocol.js';
import type { MobileOwnerCatalogRequest } from '../../src/mobile/types.js';
import type { MobileContentOwnerRequest, MobileContentOwnerResult } from '../../src/mobile/owner-content-protocol.js';

type Observation = { type: string; [key: string]: unknown };
const query: MobileOwnerCatalogRequest = { operation: 'listAlbums', serverId: 'server:startup.synthetic',
  offset: 0, limit: 10, q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: true };

/** 复用真实 Owner、合成扫描批与真实 SQLite UDF 闸门；本夹具刻意在 prepare 后不自动 commitBoot。 */
async function fixture(t: test.TestContext) {
  const temporary = process.env.TMPDIR;
  if (typeof temporary !== 'string' || !temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) {
    throw new Error('合成启动库只能写外置临时根。');
  }
  const directory = await mkdtemp(path.join(temporary, 'mobile-sql-startup-'));
  const gate = new Int32Array(new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT));
  const revocation = createDatasetOwnerReadRevocation(), channel = new MessageChannel();
  const events: Observation[] = [], waiters = new Map<string, Set<() => void>>();
  channel.port1.on('message', (value: Observation) => {
    events.push(value);
    for (const wake of [...waiters.get(value.type) ?? []]) wake();
  });
  const event = (type: string): Promise<void> => {
    if (events.some(value => value.type === type)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); waiters.get(type)?.delete(wake); };
      const wake = () => { cleanup(); resolve(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`未观察到真实启动阶段：${type}`)); }, 3000);
      const listeners = waiters.get(type) ?? new Set<() => void>(); listeners.add(wake); waiters.set(type, listeners);
    });
  };
  const fatal: string[] = [], ownerExits: number[] = [];
  const worker = new Worker(new URL('../helpers/mobile-sql-owner-isolation-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory, gate: gate.buffer,
      control: channel.port2, completeLibrary: true, readRevocation: revocation.buffer }, transferList: [channel.port2],
  });
  worker.on('exit', code => ownerExits.push(code));
  const endpoint = createDatasetOwnerClient({ worker, albumReadRevocationBuffer: revocation.buffer,
    onFatal: reason => fatal.push(reason) });
  assert.ok(endpoint.mobileMain, '真实 Owner 必须提供原移动入口。');
  let closure: Promise<void> | undefined, sequence = 0;
  const release = () => { Atomics.store(gate, 2, 1); Atomics.notify(gate, 2); };
  const close = () => closure ??= endpoint.close();
  t.after(async () => {
    release();
    try { await close(); }
    finally { channel.port1.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const identity = await endpoint.prepare();
  const arm = () => { Atomics.store(gate, 0, 1); Atomics.store(gate, 2, 0); };
  const beforeRelease = async (pending: Promise<unknown>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending.then(() => true, () => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 350); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const control = async (type: string) => {
    const reply = `control.reply.${++sequence}`;
    channel.port1.postMessage({ type, sequence }); await event(reply);
    return events.find(value => value.type === reply)!;
  };
  const mobile = endpoint.mobileMain.bind(endpoint);
  const catalog = () => mobile({ kind: 'catalog', datasetId: identity.datasetId, request: query });
  const content = (request: MobileContentOwnerRequest) => mobile({ kind: 'content', datasetId: identity.datasetId, request }) as Promise<MobileContentOwnerResult>;
  const scanPage = () => endpoint.dispatch({ version: 1, id: randomUUID(), command: 'localScan.page',
    expectedDatasetId: identity.datasetId, payload: { offset: 0, limit: 10 } });
  const changeMetadata = async () => { channel.port1.postMessage({ type: 'metadata.change' }); await event('metadata.changed'); };
  return { endpoint, identity, events, event, gate, revocation, arm, release, beforeRelease, close,
    fatal, ownerExits, worker, catalog, mobile, content, control, scanPage, changeMetadata };
}

function assertClosed(f: Awaited<ReturnType<typeof fixture>>): void {
  assert.ok(f.events.some(value => value.type === 'sql.stage.rollback'), '作业必须有真实 ROLLBACK。');
  assert.ok(f.events.some(value => value.type === 'sql.stage.closed'), '连接必须有真实 close 确认。');
  assert.ok(f.events.some(value => value.type === 'sql.worker.exit' && value.code === 0), '持久 SQL actor 必须自然 exit0。');
  assert.deepEqual(f.ownerExits, [0]); assert.equal(f.worker.threadId, -1);
  assert.equal(Atomics.load(f.gate, 4), 0, '不能借闸门超时冒充取消收尾。');
  assert.deepEqual(f.fatal, []);
}

test('启动准备：真实审计和全库预热未回滚前不确认 boot，移动与普通扫描入口均拒绝抢跑', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.arm();
  const committing = f.endpoint.commitBoot();
  await f.event('sql.entered');
  try {
    assert.equal(await f.beforeRelease(committing), false, 'boot ACK 必须等待真实 SQL 准备完成。');
    assert.equal(f.events.some(value => value.type === 'sql.stage.rollback'), false);
    await assert.rejects(f.mobile({ kind: 'load', datasetId: f.identity.datasetId }));
    await assert.rejects(f.scanPage(), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'NOT_READY',
      '内部启动读准入不能提前开放普通 dispatch。');
  } finally { f.release(); }
  await committing; await f.event('sql.stage.rollback');
  const stages = f.events.filter(value => value.type.startsWith('sql.stage.')).map(value => value.type);
  assert.deepEqual(stages.slice(0, 7), ['sql.stage.opened', 'sql.stage.begun', 'sql.stage.audit-begin',
    'sql.stage.audit-catalog', 'sql.stage.audit-scan', 'sql.stage.entered', 'sql.stage.rollback']);
  const page = await f.catalog();
  assert.ok(!('kind' in page) && 'items' in page && 'total' in page); assert.equal(page.total, 1);
  const scan = await f.scanPage() as { total: number }; assert.equal(scan.total, 1);
  assert.equal(f.events.filter(value => value.type === 'sql.stage.audit-begin').length, 1, '首个页面应复用启动时已认证的原连接。');
  await f.close(); await f.event('sql.worker.exit'); assertClosed(f);
});

test('启动准备：读取撤销拒绝 boot，仍等真实回滚后才结束并完整关闭原 actor', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.arm();
  const committing = f.endpoint.commitBoot().then(() => ({ ok: true }), () => ({ ok: false }));
  await f.event('sql.entered'); f.revocation.revoke();
  try {
    assert.equal(await f.beforeRelease(committing), false, '撤销只取消作业，不能提前当作事务已关闭。');
    await assert.rejects(f.mobile({ kind: 'load', datasetId: f.identity.datasetId }));
  } finally { f.release(); }
  assert.deepEqual(await committing, { ok: false }); await f.event('sql.stage.rollback');
  await assert.rejects(f.scanPage(), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'NOT_READY');
  await f.close(); await f.event('sql.worker.exit'); assertClosed(f);
});

test('启动准备：关闭可在真实 SQL 在途时受理，boot 和 close 都等待原事务及自然退出', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.arm();
  const committing = f.endpoint.commitBoot().then(() => ({ ok: true }), () => ({ ok: false }));
  await f.event('sql.entered'); const closing = f.close();
  await f.event('owner.close.entered');
  try {
    assert.equal(Atomics.load(new Int32Array(f.revocation.buffer), 0), 1, 'close 必须同步封原撤销闩。');
    assert.equal(await f.beforeRelease(committing), false);
    assert.equal(await f.beforeRelease(closing), false, '关闭不能绕过仍在途的真实准备作业。');
    assert.equal(f.events.some(value => value.type === 'sql.worker.exit'), false);
  } finally { f.release(); }
  assert.deepEqual(await committing, { ok: false }); await closing; await f.event('sql.worker.exit'); assertClosed(f);
});

test('启动准备：ready 后内容水位仍使用原轻量修订，来源变化不触发结构 SQL 或旧 current 回退', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.endpoint.commitBoot();
  const page = await f.catalog(); assert.ok(!('kind' in page) && 'libraryRevision' in page);
  assert.equal((await f.content({ action: 'initialize', datasetId: f.identity.datasetId, serverId: query.serverId, key: randomBytes(32) })).kind, 'content-initialized');
  const jobs = f.events.filter(value => value.type === 'sql.stage.begun').length;
  const actors = f.events.filter(value => value.type === 'sql.worker.created').length;
  await f.control('current.count'); f.arm();
  const reading = f.content({ action: 'context', serverId: query.serverId });
  try { assert.equal(await f.beforeRelease(reading), true, '内容修订不能占用结构 SQL 作业。'); }
  finally { f.release(); }
  const context = await reading;
  assert.equal(context.kind, 'content-context');
  if (context.kind !== 'content-context') throw new Error('内容水位未返回原闭集结果。');
  assert.equal(context.libraryRevision, page.libraryRevision);
  Atomics.store(f.gate, 0, 0); await f.changeMetadata();
  const changed = await f.content({ action: 'context', serverId: query.serverId });
  assert.equal(changed.kind, 'content-context');
  if (changed.kind === 'content-context') assert.notEqual(changed.libraryRevision, context.libraryRevision);
  const counts = await f.control('current.count');
  assert.equal(counts.count, 0); assert.equal(counts.udfCalls, 0); assert.equal(counts.fallbackCalls, 0);
  assert.equal(f.events.filter(value => value.type === 'sql.stage.begun').length, jobs);
  assert.equal(f.events.filter(value => value.type === 'sql.worker.created').length, actors);
  await f.close(); await f.event('sql.worker.exit'); assertClosed(f);
});
