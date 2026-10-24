import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createMobileSqlWorker } from '../../src/collection/local-album-browser/mobile-sql-worker.js';
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js';
import type { LocalAlbumSqlScope, LocalAlbumSqlMobileQuery } from '../../src/collection/local-album-browser/sql-types.js';
import { localAlbumSqlScopeFingerprint } from '../../src/collection/local-album-browser/sql-read.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';

const query: LocalAlbumSqlMobileQuery = { kind: 'members', offset: 0, limit: 10, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null };
async function fixture(t: test.TestContext, fault = 'normal') {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'mobile-sql-actor-')), databaseFile = path.join(directory, 'catalog.sqlite');
  const repository = createCollectionRepository({ filePath: databaseFile }), datasetId = randomUUID();
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '受控来源'));
  const scope = (): LocalAlbumSqlScope => {
    const roots: LocalAlbumSqlScope['roots'] = [{ root: repository.localCatalog.root(seeded.rootId), label: '受控来源', availability: 'ONLINE' }];
    const revision = createHash('sha256').update(JSON.stringify([repository.localCatalog.privateAlbumBrowserRevision(), repository.localScan.privateAlbumBrowserRevision(), roots, null, null])).digest('hex');
    const value = { revision, roots }; assert.doesNotThrow(() => localAlbumSqlScopeFingerprint(value)); return value;
  };
  const events: string[] = [], ports: MessagePort[] = [], listeners = new Map<string, Array<() => void>>();
  const stats = { created: 0, live: 0, maxLive: 0, results: 0, exits: [] as number[], stages: [] as string[], logs: [] as NonNullable<ReturnType<typeof readLibraryOperationLine>>[] };
  const gate = new Int32Array(new SharedArrayBuffer(7 * 4));
  let controller: MessagePort | undefined, actorCancellation: Int32Array | undefined, cancellation: Int32Array | undefined;
  const event = (name: string) => events.includes(name) ? Promise.resolve() : new Promise<void>(resolve => listeners.set(name, [...listeners.get(name) ?? [], resolve]));
  const driver = createMobileSqlWorker({ databaseFile, workerFactory(options) {
    const channel = new MessageChannel(); ports.push(channel.port1); controller = channel.port1;
    const record = (name: string) => { events.push(name); for (const resolve of listeners.get(name) ?? []) resolve(); listeners.delete(name); };
    channel.port1.on('message', value => record(value.type));
    actorCancellation = new Int32Array(options.workerData.cancellation);
    const worker = new Worker(new URL('../helpers/mobile-sql-lifecycle-worker-fixture.ts', import.meta.url), { ...options, stdout: true, execArgv: ['--import', 'tsx'],
      workerData: { ...options.workerData, testLifecycleFault: fault, testLifecycleControl: channel.port2, testLifecycleGate: gate.buffer }, transferList: [channel.port2] });
    let tail = '';
    worker.stdout!.on('data', chunk => { tail += String(chunk); const lines = tail.split('\n'); tail = lines.pop() ?? ''; for (const line of lines) { const record = readLibraryOperationLine(line); if (record) stats.logs.push(record); } });
    if (fault === 'missing-entire-audit') {
      // 数据库仍由真实入口核验；这里只丢弃整段证明帧，验证首作业不能靠缓存分支蒙混过关。
      const emit = worker.emit.bind(worker);
      worker.emit = ((name: string | symbol, ...args: unknown[]) => {
        const value = args[0] as { type?: string; stage?: string } | undefined;
        if (name === 'message' && value?.type === 'stage' && value.stage?.startsWith('audit-')) return false;
        return Reflect.apply(emit, worker, [name, ...args]);
      }) as Worker['emit'];
    }
    worker.on('message', value => {
      if (value?.type === 'stage') stats.stages.push(value.stage);
      if (value?.type === 'result' && ++stats.results === 2) record('protocol.second-result');
    });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: unknown, ...rest: unknown[]) => {
      const value = message as { type?: string; cancellation?: SharedArrayBuffer };
      if (value.type === 'job' && value.cancellation) cancellation = new Int32Array(value.cancellation);
      Reflect.apply(post, worker, [message, ...rest]);
    }) as Worker['postMessage'];
    stats.created++; stats.live++; stats.maxLive = Math.max(stats.maxLive, stats.live);
    worker.on('exit', code => { stats.live--; stats.exits.push(code); }); return worker;
  } });
  const release = () => { controller?.postMessage('释放受控闸门'); Atomics.store(gate, 2, 1); Atomics.notify(gate, 2); };
  const arm = () => { Atomics.store(gate, 0, 1); Atomics.store(gate, 2, 0); };
  t.after(async () => { release(); await driver.close().catch(() => {}); assert.equal(stats.live, 0); for (const port of ports) port.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { driver, scope, event, events, stats, release, arm, gate, cancellation: () => cancellation, actorCancellation: () => actorCancellation,
    changeMetadata() { repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: seeded.trackIds[0]!, source: 'synthetic', parserVersion: 'actor-change-v1', fields: { title: '已改变曲目', artist: '受控艺人', album: '受控专辑' } }); } };
}
const outcome = async (promise: Promise<unknown>) => { try { return { ok: true as const, value: await promise }; } catch (error) { assert.ok(error instanceof LocalAlbumReadError); return { ok: false as const, code: error.code }; } };
const waitCancelled = async (read: () => Int32Array | undefined) => { for (let n = 0; n < 50 && (!read() || Atomics.load(read()!, 0) === 0); n++) await delay(10); assert.equal(Atomics.load(read()!, 0), 1); };

test('移动SQL prepare与连续读取只审计一次、复用同Compact并保持真实actor存活', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.driver.prepare(f.scope(), () => {});
  const first = await f.driver.read(query, f.scope(), () => {}), second = await f.driver.read(query, f.scope(), () => {});
  assert.equal(first.total, 2); assert.deepEqual(second, first); assert.equal(f.stats.created, 1); assert.equal(f.stats.live, 1); assert.deepEqual(f.stats.exits, []);
  assert.equal(f.stats.stages.filter(name => name === 'audit-begin').length, 1);
  assert.equal(f.stats.stages.filter(name => name === 'rollback').length, 3);
  await f.driver.close(); assert.deepEqual(f.stats.exits, [0]); assert.equal(f.stats.live, 0);
  assert.equal(f.stats.logs.filter(row => row.action === 'albums.compact-groups' && row.code === 'COMPACT_BUILT').length, 1);
  assert.ok(f.stats.logs.some(row => row.action === 'albums.mobile-members' && row.code === 'DIRECTORY_FAST'));
});
test('移动SQL外部合法写入后同连接重新完整审计，不沿用旧Compact', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.driver.prepare(f.scope(), () => {}); const before = await f.driver.read(query, f.scope(), () => {});
  f.changeMetadata(); const after = await f.driver.read(query, f.scope(), () => {});
  assert.notEqual(after.revision, before.revision); assert.ok(after.items.some(row => row.member?.fact.summary.track.id && row.member.fact.summary.metadata.title === '已改变曲目'));
  assert.equal(f.stats.stages.filter(name => name === 'audit-begin').length, 2); assert.equal(f.stats.created, 1);
  await f.driver.close();
  assert.equal(f.stats.logs.filter(row => row.action === 'albums.compact-groups' && row.code === 'COMPACT_BUILT').length, 2);
});
test('移动SQL已排队但未进事务的撤销不关闭actor，后续独立读取仍完整核验', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'startup-hold'); let current = true;
  const reading = outcome(f.driver.read(query, f.scope(), () => { if (!current) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '受控撤销。'); }));
  await f.event('lifecycle.startup-held'); current = false; await waitCancelled(f.cancellation); f.release();
  assert.deepEqual(await reading, { ok: false, code: 'SNAPSHOT_CHANGED' });
  assert.equal((await f.driver.read(query, f.scope(), () => {})).total, 2); assert.equal(f.stats.created, 1); assert.equal(f.stats.live, 1);
});
test('移动SQL在途撤销待真实回滚后才结束，连接可以安全复用', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'sql-hold'); await f.driver.prepare(f.scope(), () => {}); f.arm(); let current = true, settled = false;
  const reading = outcome(f.driver.read(query, f.scope(), () => { if (!current) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '受控撤销。'); })).finally(() => { settled = true; });
  await f.event('sql.entered'); current = false; await waitCancelled(f.cancellation); await delay(50); assert.equal(settled, false); f.release();
  assert.deepEqual(await reading, { ok: false, code: 'SNAPSHOT_CHANGED' });
  assert.equal((await f.driver.read(query, f.scope(), () => {})).total, 2); assert.equal(f.stats.created, 1); assert.equal(f.stats.live, 1);
});
test('移动SQL事务期间外部写入拒绝旧页，下作业重新审计当前水位', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'sql-hold'); await f.driver.prepare(f.scope(), () => {}); f.arm();
  const reading = outcome(f.driver.read(query, f.scope(), () => {})); await f.event('sql.entered'); f.changeMetadata(); f.release();
  assert.deepEqual(await reading, { ok: false, code: 'SNAPSHOT_CHANGED' });
  assert.equal((await f.driver.read(query, f.scope(), () => {})).total, 2); assert.equal(f.stats.stages.filter(name => name === 'audit-begin').length, 2);
});
test('移动SQL最终close收到连接关闭ACK后仍等待自然exit', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'exit-hold'); await f.driver.prepare(f.scope(), () => {}); let quiet = false;
  const closing = f.driver.close().then(() => { quiet = true; }); await f.event('lifecycle.exit-held');
  await delay(75); assert.equal(quiet, false); assert.equal(f.stats.live, 1); assert.ok(f.events.includes('lifecycle.closed'));
  f.release(); await closing; assert.equal(f.stats.live, 0); assert.deepEqual(f.stats.exits, [0]);
});
test('移动SQL总受理十五、排队撤销及活动close都不提前交还真实actor', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'sql-hold'); await f.driver.prepare(f.scope(), () => {}); f.arm();
  const first = outcome(f.driver.read(query, f.scope(), () => {})); await f.event('sql.entered');
  const current = Array.from({ length: 14 }, () => true), queued = current.map((_, index) => outcome(f.driver.read(query, f.scope(), () => { if (!current[index]) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '排队撤销。'); })));
  assert.deepEqual(await outcome(f.driver.read(query, f.scope(), () => {})), { ok: false, code: 'UNAVAILABLE' });
  current[5] = false; assert.deepEqual(await queued[5], { ok: false, code: 'SNAPSHOT_CHANGED' });
  const replacement = outcome(f.driver.read(query, f.scope(), () => {})); let quiet = false;
  const closing = f.driver.close().then(() => { quiet = true; }); await delay(75); assert.equal(quiet, false); assert.equal(f.stats.live, 1);
  f.release(); await closing; assert.deepEqual(await first, { ok: false, code: 'SNAPSHOT_CHANGED' });
  for (const result of await Promise.all([...queued, replacement])) assert.deepEqual(result, { ok: false, code: 'SNAPSHOT_CHANGED' });
  assert.equal(f.stats.created, 1); assert.equal(f.stats.maxLive, 1); assert.equal(f.stats.live, 0); assert.deepEqual(f.stats.exits, [0]); assert.equal(Atomics.load(f.gate, 4), 0);
});
for (const fault of ['missing-rollback', 'missing-audit', 'missing-entire-audit', 'wrong-job', 'duplicate-result', 'forged-never-opened', 'partial-constructor']) {
  test(`移动SQL ${fault} 异常保持sticky fatal且不能复用actor`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, fault), first = await outcome(f.driver.read(query, f.scope(), () => {}));
    // 第一份合法页可先结算；后到的重复帧必须撤销整个actor，不能归给下一作业。
    if (fault === 'duplicate-result') await f.event('protocol.second-result'); else assert.equal(first.ok, false);
    assert.equal((await outcome(f.driver.read(query, f.scope(), () => {}))).ok, false); await assert.rejects(f.driver.close());
    assert.equal(f.stats.created, 1); assert.equal(f.stats.live, 0);
    if (fault === 'partial-constructor') assert.ok(f.events.includes('lifecycle.constructor-opened'));
  });
}
test('移动SQL prepare的原信封预算包含实际传输的request null，超限不创建actor', { timeout: 20_000 }, async t => {
  const f = await fixture(t), original = f.scope(), roots = original.roots.map(view => ({ ...view, label: '' }));
  const scope = { ...original, roots }, plainScope = { ...scope, nameEnhancements: [], libraryOrganizations: [] };
  const budget = 2 * 1024 * 1024;
  roots[0]!.label = 'x'.repeat(budget - Buffer.byteLength(JSON.stringify({ request: null, scope: plainScope })) + 1);
  assert.equal(Buffer.byteLength(JSON.stringify({ request: null, scope: plainScope })), budget + 1);
  assert.ok(Buffer.byteLength(JSON.stringify({ scope: plainScope })) <= budget);
  assert.deepEqual(await outcome(f.driver.prepare(scope, () => {})), { ok: false, code: 'CONTENT_LIMIT_EXCEEDED' });
  assert.equal(f.stats.created, 0); assert.equal(f.stats.live, 0);
});
test('移动SQL最终缺少closed消息即使exit0也不声称quiet', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'missing-closed'); await f.driver.prepare(f.scope(), () => {}); await assert.rejects(f.driver.close());
  assert.deepEqual(f.stats.exits, [0]); assert.equal(f.stats.live, 0); assert.equal((await outcome(f.driver.read(query, f.scope(), () => {}))).ok, false);
});
for (const fault of ['missing-never-opened', 'duplicate-never-opened', 'never-opened-mixed-stage']) {
  test(`移动SQL关闭前未打开证明 ${fault} 不能冒充quiet`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, fault), reading = outcome(f.driver.read(query, f.scope(), () => {})); await f.event('lifecycle.startup-held');
    const closing = f.driver.close(); await waitCancelled(f.actorCancellation); f.release();
    await assert.rejects(closing); assert.equal((await reading).ok, false); assert.equal(f.stats.live, 0);
  });
}
test('移动SQL已确认未打开仍等真实exit，close不创建替代actor', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'startup-and-exit-hold'), reading = outcome(f.driver.read(query, f.scope(), () => {})); await f.event('lifecycle.startup-held');
  let quiet = false; const closing = f.driver.close().then(() => { quiet = true; }); await waitCancelled(f.actorCancellation); f.release(); await f.event('lifecycle.exit-held');
  await delay(75); assert.equal(quiet, false); assert.equal(f.stats.live, 1); assert.ok(f.events.includes('lifecycle.never-opened'));
  f.release(); await closing; assert.deepEqual(await reading, { ok: false, code: 'SNAPSHOT_CHANGED' }); assert.equal(f.stats.created, 1); assert.deepEqual(f.stats.exits, [0]);
});
