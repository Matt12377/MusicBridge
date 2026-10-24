import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker, MessageChannel } from 'node:worker_threads';
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import type { MobileOwnerCatalogRequest } from '../../src/mobile/types.js';
import { parseMobileTrackId } from '../../src/mobile/local-album-identity.js';
import type { MobileContentOwnerRequest, MobileContentOwnerResult } from '../../src/mobile/owner-content-protocol.js';
import type { MobileContentScope } from '../../src/mobile/content-types.js';

const query = (q = '不存在的合成检索'): MobileOwnerCatalogRequest => ({ operation: 'listAlbums', serverId: 'server:synthetic',
  offset: 0, limit: 10, q, albumId: null, itemId: null, expectedRevision: null });

async function fixture(t: test.TestContext, completeLibrary = false) {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'), '合成数据库只能写外置临时根。');
  const directory = await mkdtemp(path.join(temporary, 'mac72-mobile-sql-'));
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 7), gate = new Int32Array(buffer);
  const channel = new MessageChannel(), events: Array<{ type: string; [key: string]: unknown }> = [];
  const waiters = new Map<string, Array<() => void>>();
  channel.port1.on('message', value => {
    events.push(value);
    for (const resolve of waiters.get(value.type) ?? []) resolve();
    waiters.delete(value.type);
  });
  const event = (type: string) => events.some(value => value.type === type) ? Promise.resolve()
    : new Promise<void>(resolve => waiters.set(type, [...waiters.get(type) ?? [], resolve]));
  const revocation = createDatasetOwnerReadRevocation();
  const ownerSourceGate = new Int32Array(new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(new URL('../helpers/mobile-sql-owner-isolation-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory, gate: buffer, ownerSourceGate: ownerSourceGate.buffer, control: channel.port2, completeLibrary, readRevocation: revocation.buffer }, transferList: [channel.port2],
  });
  const fatal: string[] = [], client = createDatasetOwnerClient({ worker, onFatal: reason => fatal.push(reason) });
  assert.ok(client.mobileMain, '真实Owner必须提供移动入口。');
  const endpoint = Object.assign(client, { mobileMain: client.mobileMain.bind(client) });
  const release = () => { Atomics.store(gate, 2, 1); Atomics.notify(gate, 2); };
  let closed = false;
  const close = async () => { if (!closed) { await endpoint.close(); closed = true; } };
  const releaseOwnerSource = () => { Atomics.store(ownerSourceGate, 2, 1); Atomics.notify(ownerSourceGate, 2); };
  t.after(async () => { releaseOwnerSource(); release(); await close(); channel.port1.close(); await rm(directory, { recursive: true, force: true }); });
  const identity = await endpoint.prepare(); await endpoint.commitBoot();
  const catalog = () => endpoint.mobileMain({ kind: 'catalog', datasetId: identity.datasetId, request: query() });
  const arm = () => { Atomics.store(gate, 0, 1); };
  // 有界观测窗只判‘仍在途时能否响应’，不把生产期限改成测试期限；finally 一定放闸。
  const beforeRelease = async (pending: Promise<unknown>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 350); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  let sequence = 0;
  const control = async (type: string, payload: Record<string, unknown> = {}) => {
    const n = ++sequence, reply = `control.reply.${n}`;
    channel.port1.postMessage({ ...payload, type, sequence: n }); await event(reply);
    return events.find(value => value.type === reply)!;
  };
  const request = (request: MobileOwnerCatalogRequest) => endpoint.mobileMain({ kind: 'catalog', datasetId: identity.datasetId, request });
  return { endpoint, identity, events, event, channel, gate, release, arm, catalog, close, beforeRelease, fatal, control, request,
    ownerSourceGate, releaseOwnerSource, revokeRead: () => revocation.revoke() };
}

async function contentFixture(t: test.TestContext) {
  const f = await fixture(t, true), serverId = 'server:synthetic';
  const content = (request: MobileContentOwnerRequest) => f.endpoint.mobileMain({ kind: 'content',
    datasetId: f.identity.datasetId, request }) as Promise<MobileContentOwnerResult>;
  const initialized = await content({ action: 'initialize', datasetId: f.identity.datasetId, serverId, key: randomBytes(32) });
  assert.equal(initialized.kind, 'content-initialized');
  if (initialized.kind !== 'content-initialized') throw new Error('真实内容 Owner 未初始化。');
  const scope: MobileContentScope = { serverId, datasetId: f.identity.datasetId, ownerEpoch: initialized.ownerEpoch,
    deviceId: 'content.sql.device', deviceEpoch: 1, accessGeneration: 1,
    accountDomain: `local:${f.identity.datasetId}`, providerEpoch: null };
  assert.equal((await content({ action: 'updateScope', scope })).kind, 'content-scope-updated');
  return { ...f, content, scope, serverId };
}

test('MAC72 内容 context 只读同 Owner 目录水位，不执行整页 SQL', { timeout: 15_000 }, async t => {
  const f = await contentFixture(t), created = f.events.filter(value => value.type === 'sql.worker.created').length,
    jobs = f.events.filter(value => value.type === 'sql.stage.begun').length;
  await f.control('current.count'); f.arm();
  const context = f.content({ action: 'context', serverId: f.serverId });
  let responsive = false;
  try { responsive = await f.beforeRelease(context); }
  finally { f.release(); }
  assert.equal((await context).kind, 'content-context');
  const counts = await f.control('current.count');
  assert.equal(responsive, true, '内容水位读取不能为 listAlbums 执行同步全库结构 SQL。');
  assert.equal(counts.count, 0); assert.equal(counts.udfCalls, 0); assert.equal(counts.fallbackCalls, 0);
  assert.equal(f.events.filter(value => value.type === 'sql.worker.created').length, created, '轻量水位不得新增结构 Worker。');
  assert.equal(f.events.filter(value => value.type === 'sql.stage.begun').length, jobs, '轻量水位不得为闲置actor派发结构SQL作业。');
});

test('MAC72 内容专辑 SQL 在途时授权读仍响应且不回同步 current', { timeout: 20_000 }, async t => {
  const f = await contentFixture(t), albums = await f.request(query(''));
  assert.ok(!('kind' in albums) && 'items' in albums); const albumId = albums.items[0]!.id;
  await f.control('current.count'); f.arm();
  const album = f.content({ action: 'local-album', scope: f.scope, albumId });
  await f.event('sql.entered');
  const load = f.endpoint.mobileMain({ kind: 'load', datasetId: f.identity.datasetId });
  let responsive = false;
  try { responsive = await f.beforeRelease(load); }
  finally { f.release(); }
  const [result, loaded] = await Promise.all([album, load]);
  assert.equal(result.kind, 'content-album');
  if (result.kind === 'content-album') assert.equal(result.album.id, albumId);
  assert.ok('kind' in loaded && loaded.kind === 'missing');
  assert.equal(responsive, true, '内容专辑应使用已有隔离 SQL，不能堵住同 Owner 授权读。');
  assert.equal((await f.control('current.count')).count, 0);
  assert.equal(Atomics.load(f.gate, 4), 0); assert.deepEqual(f.fatal, []);
});

test('MAC72 内容隔离读取期间 Scope 撤销立即生效并拒绝旧结果', { timeout: 20_000 }, async t => {
  const f = await contentFixture(t), albums = await f.request(query(''));
  assert.ok(!('kind' in albums) && 'items' in albums); f.arm();
  const reading = f.content({ action: 'local-album', scope: f.scope, albumId: albums.items[0]!.id });
  await f.event('sql.entered');
  const invalidated = f.content({ action: 'invalidateScope', kind: 'device', deviceId: f.scope.deviceId });
  let responsive = false;
  try { responsive = await f.beforeRelease(invalidated); }
  finally { f.release(); }
  assert.equal((await invalidated).kind, 'content-scope-invalidated');
  const result = await reading;
  assert.equal(responsive, true, '撤销不能排在同步内容 SQL 之后。');
  assert.equal(result.kind, 'content-error');
  if (result.kind === 'content-error') { assert.equal(result.status, 401); assert.equal(result.code, 'UNAUTHORIZED'); }
});

test('MAC72 内容隔离读取关闭须等真实 SQL 回滚退出且不发布旧结果', { timeout: 20_000 }, async t => {
  const f = await contentFixture(t), albums = await f.request(query(''));
  assert.ok(!('kind' in albums) && 'items' in albums); f.arm();
  const reading = f.content({ action: 'local-album', scope: f.scope, albumId: albums.items[0]!.id }).then(value => ({ value }), error => ({ error }));
  await f.event('sql.entered');
  const stopping = f.close();
  let responsive = false, quiet = false;
  try {
    responsive = await f.beforeRelease(f.event('owner.close.entered'));
    quiet = await f.beforeRelease(stopping);
  } finally { f.release(); }
  const result = await reading; await stopping;
  assert.equal(responsive, true, '正常关闭入口必须能在内容结构 SQL 在途时受理。');
  assert.equal(quiet, false, '真实结构 Worker 收尾前不能回报关闭成功。');
  assert.ok('error' in result || result.value.kind === 'content-error');
  assert.ok(f.events.some(value => value.type === 'sql.stage.rollback'));
  assert.ok(f.events.some(value => value.type === 'sql.stage.closed'));
  assert.ok(f.events.some(value => value.type === 'sql.worker.exit' && value.code === 0));
  assert.equal(Atomics.load(f.gate, 4), 0); assert.deepEqual(f.fatal, []);
});

test('MAC72 合成真实 Owner 的授权与目录基线可正常关闭', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const loaded = await f.endpoint.mobileMain({ kind: 'load', datasetId: f.identity.datasetId });
  assert.ok('kind' in loaded);
  assert.equal(loaded.kind, 'missing');
  const page = await f.catalog();
  assert.ok((!('kind' in page) && 'total' in page && 'items' in page), '真实目录不能靠 BUSY/空错误替身证明隔离。');
  assert.equal(page.total, 0);
  assert.equal(f.gate[1], 0);
  await f.close();
  assert.deepEqual(f.fatal, []);
});

for (const kind of ['load', 'playback-load'] as const) {
  test(`MAC72 真实 SQL 在途时 Owner ${kind} 不等待 SQL 放闸`, { timeout: 15_000 }, async t => {
    const f = await fixture(t); f.arm();
    const catalog = f.catalog();
    await f.event('sql.entered');
    const load = f.endpoint.mobileMain({ kind, datasetId: f.identity.datasetId });
    let responsive = false;
    try { responsive = await f.beforeRelease(load); assert.equal(Atomics.load(f.gate, 2), 0); }
    finally { f.release(); }
    const loaded = await load, page = await catalog;
    assert.ok('kind' in loaded);
    assert.equal(loaded.kind, 'missing'); assert.ok((!('kind' in page) && 'total' in page && 'items' in page));
    assert.equal(Atomics.load(f.gate, 3), 1); assert.equal(Atomics.load(f.gate, 4), 0);
    assert.equal(responsive, true, '同一真实 Owner 的独立授权读必须在结构 SQL 仍在途时完成。');
  });
}

test('MAC72 真实 SQL 在途时 Owner 能进入正常关闭且最终只用真实收尾', { timeout: 15_000 }, async t => {
  const f = await fixture(t); f.arm();
  const catalog = f.catalog().then(value => ({ value }), error => ({ error }));
  await f.event('sql.entered');
  const closing = f.close();
  let responsive = false;
  try { responsive = await f.beforeRelease(f.event('owner.close.entered')); }
  finally { f.release(); }
  await catalog; await closing;
  assert.ok(f.events.some(value => value.type === 'owner.close.completed'));
  assert.equal(Atomics.load(f.gate, 3), 1); assert.equal(Atomics.load(f.gate, 4), 0);
  assert.equal(responsive, true, '关闭入口不能被同线程同步 SQL 饿死。');
});

test('MAC72 查询在途时 Owner 写入先完成并拒绝发布旧结构页', { timeout: 15_000 }, async t => {
  const f = await fixture(t); f.arm();
  const catalog = f.catalog().then(value => ({ value }), error => ({ error }));
  await f.event('sql.entered');
  f.channel.port1.postMessage({ type: 'metadata.change' });
  let responsive = false;
  try { responsive = await f.beforeRelease(f.event('metadata.changed')); }
  finally { f.release(); }
  const result = await catalog;
  assert.equal(responsive, true, 'Owner 唯写事务必须能在结构查询仍在途时完成。');
  assert.ok('error' in result || 'kind' in result.value, '结构查询开始后来源事实已改变，不能发布旧页。');
});


test('MAC72 四种移动目录操作与原同步闭集 DTO 一致且不回同步重查询', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true);
  const albums = await f.request(query(''));
  assert.ok((!('kind' in albums) && 'total' in albums && 'items' in albums)); assert.equal(albums.total, 1); assert.equal(albums.items.length, 1);
  const albumId = albums.items[0]!.id;
  const tracks = await f.request({ ...query(''), operation: 'listTracks', albumId });
  assert.ok((!('kind' in tracks) && 'total' in tracks && 'items' in tracks)); assert.equal(tracks.total, 2);
  const requests: MobileOwnerCatalogRequest[] = [query(''), { ...query(''), operation: 'getAlbum', limit: 1, itemId: albumId },
    { ...query(''), operation: 'listTracks', albumId }, { ...query(''), operation: 'getTrack', limit: 1, itemId: tracks.items[0]!.id }, query('合成曲目2')];
  for (const request of requests) {
    const oracle = await f.control('catalog.parent', { request });
    assert.ok(oracle.result && typeof oracle.result === 'object' && !('kind' in oracle.result), `差分基线必须为真实非错误目录：${request.operation}/${JSON.stringify(oracle.result)}`);
    await f.control('current.count');
    const actual = await f.request(request);
    assert.deepEqual(actual, oracle.result);
    assert.equal((await f.control('current.count')).count, 0, '外部四种操作不能冷回旧 current/full fallback。');
  }
  assert.deepEqual(f.fatal, []);
});

test('MAC72 重结构 SQL 在途时同 Owner 的真实文件 read 与 quiet close-read 仍可完成', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true);
  const tracks = await f.request({ ...query(''), operation: 'listTracks' });
  assert.ok((!('kind' in tracks) && 'total' in tracks && 'items' in tracks)); assert.equal(tracks.total, 2);
  const selected = tracks.items[0]!;
  assert.ok('versionId' in selected && 'contentRevision' in selected);
  const source = (request: import('../../src/mobile/source-protocol.js').MobileOwnerSourceRequest) =>
    f.endpoint.mobileMain({ kind: 'media-source', datasetId: f.identity.datasetId, request });
  const prepared = await source({ operation: 'prepare', selection: { resourceId: randomUUID(), trackId: selected.id,
    versionId: selected.versionId, contentRevision: selected.contentRevision } });
  assert.ok('kind' in prepared && prepared.kind === 'mobile-source-prepared');
  const handle = prepared.source.handle, readId = randomUUID();
  f.arm(); const catalog = f.catalog(); await f.event('sql.entered');
  const reading = source({ operation: 'read', handle, readId, start: 0, maxBytes: 64 });
  let responsive = false;
  try { responsive = await f.beforeRelease(reading); }
  finally { f.release(); }
  const read = await reading; await catalog;
  assert.ok('kind' in read && read.kind === 'mobile-source-read'); assert.equal(read.bytes.byteLength, 64);
  assert.equal(Buffer.from(read.bytes).toString('ascii', 0, 4), 'RIFF');
  assert.equal(responsive, true, '物理 FD/read 不应等待另一线程的重 SQL 放闸。');
  const closed = await source({ operation: 'close-read', handle, readId });
  assert.ok('kind' in closed && closed.kind === 'mobile-source-ack'); assert.equal(closed.quiet, true);
  const released = await source({ operation: 'release', handle });
  assert.ok('kind' in released && released.kind === 'mobile-source-ack'); assert.equal(released.quiet, true);
});


test('MAC72 后台页在途时前台详情和搜索在原有界容量内等待而非立即 BUSY', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true);
  const tracks = await f.request({ ...query(''), operation: 'listTracks' });
  assert.ok((!('kind' in tracks) && 'total' in tracks && 'items' in tracks)); assert.equal(tracks.total, 2);
  f.arm(); const background = f.request({ ...query(''), operation: 'listTracks', offset: 1, limit: 1 }); await f.event('sql.entered');
  const detail = f.request({ ...query(''), operation: 'getTrack', limit: 1, itemId: tracks.items[0]!.id });
  const search = f.request(query('合成艺人'));
  let early = false;
  try { early = await f.beforeRelease(Promise.all([detail, search])); }
  finally { f.release(); }
  const [page, track, found] = await Promise.all([background, detail, search]);
  assert.ok((!('kind' in page) && 'total' in page && 'items' in page)); assert.ok((!('kind' in track) && 'total' in track && 'items' in track)); assert.ok((!('kind' in found) && 'total' in found && 'items' in found));
  assert.equal(track.total, 1); assert.equal(found.total, 1);
  assert.equal(early, false, '前台应等待同一物理 Worker 真收尾后受理，不是立即拒绝。');
});


test('MAC72 原 Owner 撤销闩取消活动及等待目录，最终关闭仍等待真实actor退出', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true); f.arm();
  const first = f.catalog().then(value => ({ value }), error => ({ error })); await f.event('sql.entered');
  const waiting = f.request(query('合成艺人')).then(value => ({ value }), error => ({ error }));
  f.revokeRead();
  assert.equal(await f.beforeRelease(waiting), true, '尚未发送 Worker 的等待请求应按原撤销闩安全结算。');
  assert.equal(f.events.some(value => value.type === 'sql.worker.exit'), false, '活动查询尚未真退出。');
  f.release();
  const [active, queued] = await Promise.all([first, waiting]);
  assert.ok('error' in active || 'kind' in active.value); assert.ok('error' in queued || 'kind' in queued.value);
  await f.close(); await f.event('sql.worker.exit');
  assert.ok(f.events.some(value => value.type === 'sql.stage.rollback'));
  assert.ok(f.events.some(value => value.type === 'sql.stage.closed'));
  assert.equal(f.events.find(value => value.type === 'sql.worker.exit')!.code, 0);
});

test('MAC72 结构查询期间真实来源撤权拒绝旧页及后续源读取', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true); f.arm();
  const first = f.catalog().then(value => ({ value }), error => ({ error })); await f.event('sql.entered');
  let responsive = false;
  try { responsive = await f.beforeRelease(f.control('source.revoke')); }
  finally { f.release(); }
  const result = await first;
  assert.equal(responsive, true); assert.ok('error' in result || 'kind' in result.value);
  const request: MobileOwnerCatalogRequest = { ...query(''), operation: 'listTracks', catalogPlaybackEnabled: true };
  const oracle = await f.control('catalog.parent', { request });
  const after = await f.request(request);
  assert.deepEqual(after, oracle.result, '撤权后的原拒绝或不可用语义必须逐字保留。');
});

test('MAC72 Owner 换代关闭拒绝旧页，新 Owner 使用独立激活库和新水位', { timeout: 25_000 }, async t => {
  const old = await fixture(t, true); old.arm();
  const pending = old.catalog().then(value => ({ value }), error => ({ error })); await old.event('sql.entered');
  const stopping = old.close(); await old.event('owner.close.entered'); old.release();
  const result = await pending; await stopping;
  assert.ok('error' in result || 'kind' in result.value);
  const next = await fixture(t, true), page = await next.request(query(''));
  assert.notEqual(next.identity.datasetId, old.identity.datasetId); assert.notEqual(next.identity.epoch, old.identity.epoch);
  assert.ok((!('kind' in page) && 'total' in page && 'items' in page)); assert.equal(page.total, 1); assert.equal(page.datasetId, next.identity.datasetId);
  assert.ok(next.events.some(value => value.type === 'sql.stage.audit-begin'));
  assert.ok(next.events.some(value => value.type === 'sql.stage.audit-catalog'));
  assert.ok(next.events.some(value => value.type === 'sql.stage.audit-scan'));
});


test('MAC72 新增向量合法同步基线先固定请求与拒绝语义', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true);
  const sync = async (request: MobileOwnerCatalogRequest) => (await f.control('catalog.parent', { request })).result as Awaited<ReturnType<typeof f.request>>;
  const albums = await sync(query('')); assert.ok((!('kind' in albums) && 'total' in albums && 'items' in albums)); assert.equal(albums.total, 1);
  const albumId = albums.items[0]!.id;
  const trackRequest: MobileOwnerCatalogRequest = { ...query(''), operation: 'listTracks', albumId };
  const tracks = await sync(trackRequest); assert.ok((!('kind' in tracks) && 'total' in tracks && 'items' in tracks)); assert.equal(tracks.total, 2);
  const vectors: Array<{ request: MobileOwnerCatalogRequest; total: number }> = [
    { request: query('合成艺人'), total: 1 }, { request: query('合成曲目2'), total: 0 },
    { request: { ...query(''), operation: 'getAlbum', limit: 1, itemId: albumId }, total: 1 },
    { request: { ...query(''), operation: 'getTrack', limit: 1, itemId: tracks.items[0]!.id }, total: 1 },
    { request: trackRequest, total: 2 },
    { request: { ...trackRequest, offset: 1, limit: 1, albumId: null }, total: 2 },
  ];
  for (const vector of vectors) {
    const page = await sync(vector.request); assert.ok((!('kind' in page) && 'total' in page && 'items' in page)); assert.equal(page.total, vector.total);
    console.log(JSON.stringify({ 事件: '新增向量合法同步基线', 操作: vector.request.operation, 限额: vector.request.limit, 总数: page.total, 结果: '通过' }));
  }
  await f.control('source.revoke');
  const revoked = await sync({ ...query(''), operation: 'listTracks', catalogPlaybackEnabled: true });
  assert.ok(!('fixtureFailure' in revoked));
  console.log(JSON.stringify({ 事件: '新增向量合法同步基线', 操作: 'listTracks', 阶段: '真实来源撤权后', ...('kind' in revoked && revoked.kind === 'mobile-error' ? { 状态: revoked.status, 分类: revoked.code } : (!('kind' in revoked) && 'total' in revoked && 'items' in revoked) ? { 总数: revoked.total } : {}), 结果: '记录原外层语义' }));
  assert.equal(Atomics.load(f.gate, 1), 0, '基线没有打开 SQL 闸门。');
});

test('MAC72 新prepare与renew合法非并发基线记录原同步查询', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true);
  const tracks = await f.request({ ...query(''), operation: 'listTracks' });
  assert.ok((!('kind' in tracks) && 'total' in tracks && 'items' in tracks)); assert.equal(tracks.total, 2);
  const selected = tracks.items[0]!; assert.ok('versionId' in selected && 'contentRevision' in selected);
  const detail = await f.request({ ...query(''), operation: 'getTrack', limit: 1, itemId: selected.id });
  assert.ok((!('kind' in detail) && 'total' in detail && 'items' in detail)); assert.equal(detail.total, 1);
  const before = await f.control('current.count');
  assert.equal(before.count, 0, '异步结构列表和详情不能预热原Owner current/compact。');
  assert.equal(before.fallbackCalls, 0, '隔离Worker的完整查询不得混入Owner冷域计数。');
  const source = (request: import('../../src/mobile/source-protocol.js').MobileOwnerSourceRequest) =>
    f.endpoint.mobileMain({ kind: 'media-source', datasetId: f.identity.datasetId, request });
  await f.control('current.count');
  const prepared = await source({ operation: 'prepare', selection: { resourceId: randomUUID(), trackId: selected.id,
    versionId: selected.versionId, contentRevision: selected.contentRevision } });
  assert.ok('kind' in prepared && prepared.kind === 'mobile-source-prepared');
  const prepare = await f.control('current.count');
  const readId = randomUUID();
  const read = await source({ operation: 'read', handle: prepared.source.handle, readId, start: 0, maxBytes: 64 });
  assert.ok('kind' in read && read.kind === 'mobile-source-read');
  const reading = await f.control('current.count');
  const renewed = await source({ operation: 'renew', handle: prepared.source.handle });
  assert.ok('kind' in renewed && renewed.kind === 'mobile-source-ack' && renewed.quiet === true);
  const renew = await f.control('current.count');
  console.log(JSON.stringify({ 事件: '源生命周期原同步基线', 阶段: 'prepare', 原current调用: prepare.count, Owner字段调用: prepare.udfCalls, Owner完整回退: prepare.fallbackCalls }));
  console.log(JSON.stringify({ 事件: '源生命周期原同步基线', 阶段: 'read', 原current调用: reading.count, Owner字段调用: reading.udfCalls, Owner完整回退: reading.fallbackCalls }));
  console.log(JSON.stringify({ 事件: '源生命周期原同步基线', 阶段: 'renew', 原current调用: renew.count, Owner字段调用: renew.udfCalls, Owner完整回退: renew.fallbackCalls }));
  const closed = await source({ operation: 'close-read', handle: prepared.source.handle, readId });
  assert.ok('kind' in closed && closed.kind === 'mobile-source-ack' && closed.quiet === true);
  const released = await source({ operation: 'release', handle: prepared.source.handle });
  assert.ok('kind' in released && released.kind === 'mobile-source-ack' && released.quiet === true);
  assert.equal(Atomics.load(f.gate, 1), 0, '源准备基线未arm。');
});

test('MAC72 冷Source生命周期与fresh授权在背景SQL真实在途时不读取无关Source成员', { timeout: 25_000 }, async t => {
  const f = await fixture(t, true);
  assert.ok(f.endpoint.mobileMain);
  const mobileMain = f.endpoint.mobileMain.bind(f.endpoint);
  const tracks = await f.request({ ...query(''), operation: 'listTracks' });
  assert.ok((!('kind' in tracks) && 'total' in tracks && 'items' in tracks) && 'items' in tracks); assert.equal(tracks.total, 2);
  const selected = tracks.items[0]!; assert.ok('versionId' in selected && 'contentRevision' in selected);
  const detail = await f.request({ ...query(''), operation: 'getTrack', limit: 1, itemId: selected.id });
  assert.ok((!('kind' in detail) && 'total' in detail && 'items' in detail) && 'total' in detail); assert.equal(detail.total, 1);
  const untouched = await f.control('current.count'); assert.equal(untouched.count, 0); assert.equal(untouched.fallbackCalls, 0);
  const identity = parseMobileTrackId(selected.id, f.identity.datasetId); assert.ok(identity);
  await f.control('source.target', { trackId: identity.trackId });
  // 两个独立物理闸门：Child仍执行重SQL；Owner只在越界读取另一track来源字段时停住。
  // 后者不按耗时或current实现细节决定成败；旧完整回退真实阻塞Owner的fresh授权消息。
  Atomics.store(f.ownerSourceGate, 0, 1); f.arm();
  const background = f.request({ ...query(''), operation: 'listTracks', offset: 1, limit: 1 });
  await f.event('sql.entered');
  const source = (request: import('../../src/mobile/source-protocol.js').MobileOwnerSourceRequest) =>
    mobileMain({ kind: 'media-source', datasetId: f.identity.datasetId, request });
  const preparation = source({ operation: 'prepare', selection: { resourceId: randomUUID(), trackId: selected.id,
    versionId: selected.versionId, contentRevision: selected.contentRevision } });
  let preparedInFlight = false, authInFlight = false, readInFlight = false, renewInFlight = false, quietInFlight = false;
  let authorization: ReturnType<typeof mobileMain> | undefined;
  try {
    preparedInFlight = await f.beforeRelease(preparation);
    authorization = mobileMain({ kind: 'load', datasetId: f.identity.datasetId });
    authInFlight = await f.beforeRelease(authorization);
    if (preparedInFlight) {
      const prepared = await preparation;
      assert.ok('kind' in prepared && prepared.kind === 'mobile-source-prepared');
      const readId = randomUUID(), handle = prepared.source.handle;
      const reading = source({ operation: 'read', handle, readId, start: 0, maxBytes: 64 });
      readInFlight = await f.beforeRelease(reading);
      assert.equal(readInFlight, true, '未在观测窗内完成read，先放双闸再报告。');
      const read = await reading; assert.ok('kind' in read && read.kind === 'mobile-source-read');
      assert.equal(Buffer.from(read.bytes).toString('ascii', 0, 4), 'RIFF');
      const renewal = source({ operation: 'renew', handle }); renewInFlight = await f.beforeRelease(renewal);
      assert.equal(renewInFlight, true, '未在观测窗内完成renew，先放双闸再报告。');
      const renewed = await renewal; assert.ok('kind' in renewed && renewed.kind === 'mobile-source-ack' && renewed.quiet);
      const closing = source({ operation: 'close-read', handle, readId }); quietInFlight = await f.beforeRelease(closing);
      assert.equal(quietInFlight, true, '未在观测窗内完成close-read，先放双闸再报告。');
      const closed = await closing; assert.ok('kind' in closed && closed.kind === 'mobile-source-ack' && closed.quiet);
      const releasing = source({ operation: 'release', handle });
      assert.equal(await f.beforeRelease(releasing), true, '未在观测窗内完成release，先放双闸再报告。');
      const released = await releasing;
      assert.ok('kind' in released && released.kind === 'mobile-source-ack' && released.quiet);
    }
    assert.equal(Atomics.load(f.gate, 2), 0, '生命周期及fresh授权完成前，背景SQL不能已被放闸。');
  } finally {
    t.diagnostic(JSON.stringify({ 事件: 'Source在途双闸观测', Owner哨兵进入: Atomics.load(f.ownerSourceGate, 1),
      Owner闸门自身超时: Atomics.load(f.ownerSourceGate, 4), Child进入: Atomics.load(f.gate, 1),
      preparedInFlight, authInFlight, readInFlight, renewInFlight, quietInFlight }));
    f.releaseOwnerSource(); f.release();
  }
  const prepared = await preparation; assert.ok('kind' in prepared && prepared.kind === 'mobile-source-prepared');
  const loaded = await authorization!; assert.ok('kind' in loaded && loaded.kind === 'missing');
  const page = await background; assert.ok((!('kind' in page) && 'total' in page && 'items' in page) && 'total' in page); assert.equal(page.total, 2);
  if (!preparedInFlight) await source({ operation: 'release', handle: prepared.source.handle });
  assert.equal(Atomics.load(f.ownerSourceGate, 4), 0, '不借闸门自身超时解除阻塞。');
  assert.equal(preparedInFlight, true, '冷Source prepare必须在背景SQL仍在途时完成。');
  assert.equal(authInFlight, true, '同一真实Owner的fresh授权不得被Source完整回退挡住。');
  assert.equal(readInFlight && renewInFlight && quietInFlight, true, '真实FD/read、renew及quiet close-read必须全部在背景SQL放闸前完成。');
  assert.equal(Atomics.load(f.ownerSourceGate, 1), 0, '单成员Source证明不能去解码另一track的Source来源。');
});

test('MAC72 只读审计两条合成媒体量级按真实阶段记录', {timeout:15_000}, async t=>{
  const f=await fixture(t,true);
  const page=await f.request({...query(''),operation:'listTracks'});
  assert.ok(!('kind' in page)&&'total' in page);assert.equal(page.total,2);
  await f.close(); await f.event('sql.worker.exit');
  const at=(stage:string)=>{
    const event=f.events.find(value=>value.type===`sql.stage.${stage}`);
    assert.ok(event&&typeof event.atMs==='number'&&Number.isFinite(event.atMs));return event.atMs;
  };
  const begin=at('audit-begin'),catalog=at('audit-catalog'),scan=at('audit-scan'),rollback=at('rollback'),closed=at('closed');
  assert.ok(begin<=catalog&&catalog<=scan&&scan<=rollback&&rollback<=closed);
  t.diagnostic(JSON.stringify({事件:'只读审计非空合成量级',轨道数:2,根数:1,
    catalog阶段观察毫秒:catalog-begin,scan阶段观察毫秒:scan-catalog,
    口径:'Owner接收真实Worker阶段的单调时钟差；不是大库保证或SQL纯执行时间。',
    取消边界:'审计同步调用内部不可SAB打断；作业完成须实际ROLLBACK，整个actor关闭另须连接close及自然exit。'}));
});
