import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker, MessageChannel } from 'node:worker_threads';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js';
import type { MobileOwnerCatalogRequest } from '../../src/mobile/types.js';
import type { MobileContentOwnerRequest, MobileContentOwnerResult } from '../../src/mobile/owner-content-protocol.js';

type Observation = { type: string; [key: string]: unknown };
const query: MobileOwnerCatalogRequest = { operation: 'listAlbums', serverId: 'server:startup.synthetic',
  offset: 0, limit: 10, q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: true };

/** 复用真实 Owner、合成扫描批与真实 SQLite UDF 闸门；本夹具刻意在 prepare 后不自动 commitBoot。 */
async function fixture(t: test.TestContext, fault?: 'audit' | 'snapshot-without-change', seedContentEdition = false,
  auditPause?: 'catalog-ledger' | 'scan-file-state') {
  const temporary = process.env.TMPDIR;
  if (typeof temporary !== 'string' || !temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) {
    throw new Error('合成启动库只能写外置临时根。');
  }
  const directory = await mkdtemp(path.join(temporary, 'mobile-sql-startup-'));
  const gate = new Int32Array(new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT));
  const revocation = createDatasetOwnerReadRevocation(), channel = new MessageChannel();
  const events: Observation[] = [], waiters = new Map<string, Set<() => void>>();
  const observe = (value: Observation) => {
    events.push(value);
    for (const wake of [...waiters.get(value.type) ?? []]) wake();
  };
  channel.port1.on('message', observe);
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
      control: channel.port2, completeLibrary: true, backgroundWarm: true, startupSqlFault: fault, seedContentEdition, auditPause,
      readRevocation: revocation.buffer }, transferList: [channel.port2],
  });
  worker.on('exit', code => ownerExits.push(code));
  const endpoint = createDatasetOwnerClient({ worker, albumReadRevocationBuffer: revocation.buffer,
    onFatal: reason => { fatal.push(reason); observe({ type: 'owner.fatal', reason }); } });
  assert.ok(endpoint.mobileMain, '真实 Owner 必须提供原移动入口。');
  let closure: Promise<void> | undefined, sequence = 0;
  const release = () => { Atomics.store(gate, 2, 1); Atomics.notify(gate, 2); };
  const close = () => closure ??= endpoint.close();
  t.after(async () => {
    release();
    try { await close(); }
    catch (error) { if (!fault) throw error; }
    finally {
      // fatal 门禁故意保留未静止的 Owner；只在合成夹具清理中释放该线程，不冒充正常关闭。
      if (fault && worker.threadId !== -1) await worker.terminate();
      channel.port1.close(); await rm(directory, { recursive: true, force: true });
    }
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

test('启动预热：原 Owner 已核验后即确认 boot，移动结构立即返回准备状态且普通读取不等热分组', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.arm();
  const committing = f.endpoint.commitBoot();
  await f.event('sql.entered');
  try {
    assert.equal(await f.beforeRelease(committing), true, '独立结构预热不能阻塞已核验 Owner 的 boot ACK。');
    assert.equal(f.events.some(value => value.type === 'sql.stage.rollback'), false);
    assert.equal(await f.beforeRelease(f.mobile({ kind: 'load', datasetId: f.identity.datasetId })), true);
    const scanning = f.scanPage(); assert.equal(await f.beforeRelease(scanning), true);
    assert.equal((await scanning as { total: number }).total, 1);
    const reads = Promise.all(Array.from({ length: 16 }, () => f.catalog()));
    assert.equal(await f.beforeRelease(reads), true, '预热期目录必须立即拒绝，不能排进 Actor 的十五项队列。');
    for (const reply of await reads) assert.deepEqual(reply, { kind: 'mobile-error', status: 503, code: 'ARTIST_INDEX_PREPARING', retryable: false, outcome: null });
    assert.equal(f.events.filter(value => value.type === 'sql.stage.begun').length, 1);
  } finally { f.release(); }
  await committing; await f.event('warm.complete');
  const stages = f.events.filter(value => value.type.startsWith('sql.stage.')).map(value => value.type);
  assert.deepEqual(stages.slice(0, 7), ['sql.stage.opened', 'sql.stage.begun', 'sql.stage.audit-begin',
    'sql.stage.audit-catalog', 'sql.stage.audit-scan', 'sql.stage.entered', 'sql.stage.rollback']);
  const page = await f.catalog();
  assert.ok(!('kind' in page) && 'items' in page && 'total' in page); assert.equal(page.total, 1);
  const scan = await f.scanPage() as { total: number }; assert.equal(scan.total, 1);
  assert.equal(f.events.filter(value => value.type === 'sql.stage.audit-begin').length, 1, '首个页面应复用启动时已认证的原连接。');
  await f.close(); await f.event('sql.worker.exit'); assertClosed(f);
});

test('启动预热：内容服务嵌套的最近添加目录立即返回准备状态，不进入结构 Actor 等待队列', { timeout: 20_000 }, async t => {
  const f = await fixture(t, undefined, true); f.arm(); await f.endpoint.commitBoot(); await f.event('sql.entered');
  let request!: MobileContentOwnerRequest;
  try {
    const initialized = await f.content({ action: 'initialize', datasetId: f.identity.datasetId, serverId: query.serverId, key: randomBytes(32) });
    assert.equal(initialized.kind, 'content-initialized');
    if (initialized.kind !== 'content-initialized') throw new Error('合成内容 Owner 未完成初始化。');
    const scope = { serverId: query.serverId, datasetId: f.identity.datasetId, ownerEpoch: initialized.ownerEpoch,
      deviceId: 'startup.content.synthetic', deviceEpoch: 1, accessGeneration: 1,
      accountDomain: `local:${f.identity.datasetId}`, providerEpoch: null };
    assert.equal((await f.content({ action: 'updateScope', scope })).kind, 'content-scope-updated');
    request = { action: 'dispatch', operation: 'listRecentlyAddedAlbums', scope,
      request: { path: '/mobile/v1/ui/home/added-albums', pathParameters: {}, query: { limit: 10 }, body: null } };
    const reading = f.content(request);
    assert.equal(await f.beforeRelease(reading), true, '嵌套目录必须立即给准备状态，不能等待预热或进入十五项 SQL 队列。');
    assert.deepEqual(await reading, { kind: 'content-error', status: 503, code: 'ARTIST_INDEX_PREPARING',
      retryable: false, outcome: null, commitId: null });
    assert.equal(f.events.filter(value => value.type === 'sql.stage.begun').length, 1);
    assert.equal(f.events.some(value => value.type === 'sql.stage.rollback'), false);
  } finally { f.release(); }
  await f.event('warm.complete');
  const page = await f.content(request);
  assert.equal(page.kind, 'content-snapshot');
  if (page.kind !== 'content-snapshot') throw new Error('预热后最近添加目录未返回原内容快照。');
  assert.equal((page.reply.body as { items: unknown[] }).items.length, 1);
  assert.equal(f.events.filter(value => value.type === 'sql.stage.audit-begin').length, 1);
  await f.close(); await f.event('sql.worker.exit'); assertClosed(f);
});

test('启动预热：读取资格撤销并关闭后不重试，仍等真实回滚与原 Actor 自然退出', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.arm();
  await f.endpoint.commitBoot();
  await f.event('sql.entered'); f.revocation.revoke(); const closing = f.close();
  try {
    assert.equal(await f.beforeRelease(closing), false, '撤销只取消作业，不能提前当作事务已关闭。');
    await assert.rejects(f.mobile({ kind: 'load', datasetId: f.identity.datasetId }));
  } finally { f.release(); }
  await closing; await f.event('sql.worker.exit');
  assert.equal(f.events.filter(value => value.type === 'sql.stage.begun').length, 1);
  assert.equal(f.events.some(value => value.type === 'warm.complete'), false); assertClosed(f);
});

test('启动预热：boot 已确认后关闭仍可取消在途 SQL，close 等原事务和自然退出', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.arm();
  const committing = f.endpoint.commitBoot().then(() => ({ ok: true }), () => ({ ok: false }));
  await f.event('sql.entered'); const closing = f.close();
  await f.event('owner.close.entered');
  try {
    assert.equal(Atomics.load(new Int32Array(f.revocation.buffer), 0), 1, 'close 必须同步封原撤销闩。');
    assert.equal(await f.beforeRelease(committing), true);
    assert.equal(await f.beforeRelease(closing), false, '关闭不能绕过仍在途的真实准备作业。');
    assert.equal(f.events.some(value => value.type === 'sql.worker.exit'), false);
  } finally { f.release(); }
  assert.deepEqual(await committing, { ok: true }); await closing; await f.event('sql.worker.exit'); assertClosed(f);
});

for (const auditPause of ['catalog-ledger', 'scan-file-state'] as const) test(`启动预热：${auditPause} 全核逐行途中关闭停止余下核验，真实回滚并自然退出`, { timeout: 20_000 }, async t => {
  const f = await fixture(t, undefined, false, auditPause); f.arm();
  await f.endpoint.commitBoot(); await f.event('sql.audit.row');
  const closing = f.close();
  try {
    await f.event('sql.audit.cancel-seen');
    assert.equal(await f.beforeRelease(closing), false, '当前真实迭代尚未归还，不能提前回执关闭。');
    assert.equal(f.events.some(value => value.type === 'sql.stage.rollback' || value.type === 'sql.worker.exit'), false);
  } finally { f.release(); }
  await closing; await f.event('sql.worker.exit');
  assert.equal(Atomics.load(f.gate, 6), 1, '取消后不能继续迭代剩余全核行。');
  assert.ok(f.events.some(value => value.type === 'sql.audit.iterator-returned'), '中断迭代必须归还真实 SQLite 游标。');
  assert.equal(f.events.some(value => value.type === 'sql.audit.exhausted'), false, '不能等遍历完整库后才承认取消。');
  assert.equal(f.events.some(value => value.type === 'sql.stage.audit-scan' || value.type === 'sql.stage.entered' || value.type === 'warm.complete'), false);
  assert.equal(f.events.some(value => value.type === 'sql.stage.audit-catalog'), auditPause === 'scan-file-state');
  const stage = (type: string) => f.events.findIndex(value => value.type === type);
  assert.ok(stage('sql.stage.rollback') < stage('sql.stage.closed'));
  assert.ok(stage('sql.stage.closed') < stage('sql.worker.exit'));
  assertClosed(f);
});

for (const change of ['queue.change', 'metadata.change']) test(`启动预热：同 Owner 的 ${change} 推进实际水位后重新全核，不误报 fatal`, { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.arm(); await f.endpoint.commitBoot(); await f.event('sql.entered');
  try {
    await f.control(change);
    assert.deepEqual(await f.catalog(), { kind: 'mobile-error', status: 503, code: 'ARTIST_INDEX_PREPARING', retryable: false, outcome: null });
  } finally { f.release(); }
  await f.event('warm.complete');
  const page = await f.catalog(); assert.ok('total' in page); assert.ok('items' in page);
  // metadata.change 只改两首中的第一首，真实专辑应拆成新旧两组，不能沿用旧分组。
  assert.equal(page.total, change === 'metadata.change' ? 2 : 1);
  assert.deepEqual(Object.fromEntries(page.items.map(item => [item.title,
    { artists: item.artists, trackCount: 'trackCount' in item ? item.trackCount : null }])),
    change === 'metadata.change'
      ? { '合成专辑': { artists: ['合成艺人'], trackCount: 1 }, '已改变专辑': { artists: ['已改变艺人'], trackCount: 1 } }
      : { '合成专辑': { artists: ['合成艺人'], trackCount: 2 } });
  assert.equal(f.events.filter(value => value.type === 'sql.stage.audit-begin').length, 2, '原作业已撤销，新的 scope 必须再次完整审计。');
  assert.equal(f.events.filter(value => value.type === 'sql.worker.created').length, 1, '不能新建替代 Actor 绕开原生命周期。');
  await f.close(); await f.event('sql.worker.exit'); assertClosed(f);
});

for (const fault of ['audit', 'snapshot-without-change'] as const) test(`启动预热：${fault} 失败进入原 Owner fatal，不当成功或盲重试`, { timeout: 20_000 }, async t => {
  const f = await fixture(t, fault); await f.endpoint.commitBoot();
  await f.event('owner.fatal'); await f.event('sql.worker.exit');
  assert.ok(f.fatal.includes('protocol-failure'));
  assert.equal(f.events.some(value => value.type === 'warm.complete'), false);
  assert.ok(f.events.some(value => value.type === 'warm.error'));
  assert.equal(f.events.filter(value => value.type === 'sql.stage.audit-begin').length, 1);
  assert.equal(f.events.filter(value => value.type === 'sql.worker.created').length, 1);
  assert.ok(f.events.some(value => value.type === 'sql.stage.rollback'));
  assert.ok(f.events.some(value => value.type === 'sql.stage.closed'));
  await assert.rejects(f.catalog());
});

test('启动准备：ready 后内容水位仍使用原轻量修订，来源变化不触发结构 SQL 或旧 current 回退', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.endpoint.commitBoot();
  await f.event('warm.complete');
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
