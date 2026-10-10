import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendFixture, preparationWindow, ready, hash } from './fixture-helpers.js';

test('MBM003真实缓存共享：首waiter取消不关闭共享源，第二个完成后整bytes可读，新resource命中同产物', { timeout: 45_000 }, async t => {
  const f = await backendFixture(t), cache = await f.cache(), firstSource = await f.source(), secondSource = await f.source();
  const first = randomUUID(), second = randomUUID(), window = preparationWindow(), signal = new AbortController().signal;
  assert.ok('preparing' in await cache.begin({ resourceId: first, source: firstSource, window }, signal));
  assert.ok('preparing' in await cache.begin({ resourceId: second, source: secondSource, window }, signal)); assert.equal(cache.snapshot().jobs, 1);
  await cache.release(first);
  await assert.rejects(cache.status(first), error => error instanceof f.core.errors.MobileDsdError && error.code === 'RESOURCE_RELEASED');
  const secondFacts = await ready(cache, second); assert.equal(secondFacts.processing.fromPreparedCache, false);
  const parts: Uint8Array[] = []; let offset = 0;
  while (offset < secondFacts.size) { const bytes = await cache.read(second, offset, 64 * 1024, signal); assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024); parts.push(bytes); offset += bytes.length; }
  const full = Buffer.concat(parts); assert.equal(full.toString('ascii', 0, 4), 'fLaC'); assert.equal(full.length, secondFacts.size);
  const third = randomUUID(); await cache.begin({ resourceId: third, source: await f.source(), window: preparationWindow() }, signal);
  const thirdFacts = await ready(cache, third); assert.equal(thirdFacts.processing.fromPreparedCache, true); assert.equal(cache.snapshot().entries, 1);
  assert.deepEqual(await cache.read(third, 0, thirdFacts.size, signal), Uint8Array.from(full));
  await cache.release(second); await cache.release(third); assert.equal(cache.snapshot().active, 0); await f.unchanged(); await f.close();
});

test('MBM003缓存配额：等待槽有限，active产物不驱逐，释放后才允许独立新来源替换', { timeout: 45_000 }, async t => {
  const f = await backendFixture(t), cache = await f.cache({ waitingResources: 1, entries: 1, entryBytes: 16 * 1024, totalBytes: 16 * 1024 });
  const firstSource = await f.source(), waitingSource = await f.source('dff'), first = randomUUID(), signal = new AbortController().signal;
  await cache.begin({ resourceId: first, source: firstSource, window: preparationWindow() }, signal);
  await assert.rejects(cache.begin({ resourceId: randomUUID(), source: waitingSource, window: preparationWindow() }, signal), error => error instanceof f.core.errors.MobileDsdError && error.code === 'RESOURCE_BUSY');
  const original = await ready(cache, first), originalBytes = await cache.read(first, 0, original.size, signal);
  const blocked = randomUUID(); await cache.begin({ resourceId: blocked, source: waitingSource, window: preparationWindow() }, signal);
  await assert.rejects(ready(cache, blocked), error => error instanceof f.core.errors.MobileDsdError && error.code === 'RESOURCE_BUSY');
  assert.equal(cache.snapshot().entries, 1); assert.equal(cache.snapshot().active, 1); assert.deepEqual(await cache.read(first, 0, original.size, signal), originalBytes);
  await cache.release(blocked); await cache.release(first);
  const replacement = randomUUID(); await cache.begin({ resourceId: replacement, source: await f.source('dff'), window: preparationWindow() }, signal);
  assert.equal((await ready(cache, replacement)).processing.fromPreparedCache, false); assert.equal(cache.snapshot().entries, 1);
  await cache.release(replacement); await f.unchanged(); await f.close();
});

test('MBM003缓存冷重开：仅完整manifest与完整源Hash命中，被改输出拒绝，不自动把新FD当旧产物', { timeout: 45_000 }, async t => {
  const f = await backendFixture(t), signal = new AbortController().signal, firstCache = await f.cache(), first = randomUUID();
  await firstCache.begin({ resourceId: first, source: await f.source(), window: preparationWindow() }, signal);
  const old = await ready(firstCache, first), full = await firstCache.read(first, 0, old.size, signal); await firstCache.release(first); await firstCache.close();
  const secondCache = await f.cache(), second = randomUUID(); await secondCache.begin({ resourceId: second, source: await f.source(), window: preparationWindow() }, signal);
  const hit = await ready(secondCache, second); assert.equal(hit.processing.fromPreparedCache, true); assert.deepEqual(await secondCache.read(second, 0, hit.size, signal), full);
  await secondCache.release(second); await secondCache.close();
  const root = path.join(f.directory, 'mobile-dsd-cache'), entry = (await readdir(root))[0]!;
  const file = path.join(root, entry, 'audio.flac'), bytes = await readFile(file); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(file, bytes);
  const thirdCache = await f.cache(), third = randomUUID(); await thirdCache.begin({ resourceId: third, source: await f.source(), window: preparationWindow() }, signal);
  await assert.rejects(ready(thirdCache, third), error => error instanceof f.core.errors.MobileDsdError);
  await thirdCache.release(third); await f.unchanged(); await f.close();
});

test('MBM003当前来源变化：真实源被修改后缓存read与renew都拒绝，旧产物不替换原源', { timeout: 30_000 }, async t => {
  const f = await backendFixture(t), cache = await f.cache(), id = randomUUID(), signal = new AbortController().signal;
  await cache.begin({ resourceId: id, source: await f.source(), window: preparationWindow() }, signal); const facts = await ready(cache, id);
  const cachedBefore = await cache.read(id, 0, facts.size, signal), sourcePath = path.join(f.media, 'source.dsf'), before = await readFile(sourcePath);
  const changed = Buffer.from(before); changed[100] = changed[100]! ^ 0xff; await writeFile(sourcePath, changed);
  const sourceChanged = (error: unknown) => error instanceof f.core.errors.MobileDsdError && error.code === 'SOURCE_CHANGED'
    || error instanceof f.core.files.SourceFileError && error.code === 'CONTENT_CHANGED';
  await assert.rejects(cache.read(id, 0, 16, signal), sourceChanged);
  await assert.rejects(cache.renew(id), sourceChanged); assert.deepEqual(await readFile(sourcePath), changed);
  assert.notEqual(hash(changed), hash(before)); const root = path.join(f.directory, 'mobile-dsd-cache'), entry = (await readdir(root))[0]!;
  assert.deepEqual(await readFile(path.join(root, entry, 'audio.flac')), Buffer.from(cachedBefore));
  await cache.release(id); await f.close();
});

test('MBM003准备预算：旧createdAt的耗尽窗口与重复begin都不能重新获得240秒或新作业', { timeout: 20_000 }, async t => {
  const f = await backendFixture(t), cache = await f.cache(), now = Date.now(), window = { resourceCreatedAtMs: now - 239_999,
    resourceExpiresAtMs: now + 60_001, sessionExpiresAtMs: now + 1_000_000, remainingPreparationMs: 240_000 };
  for (let i = 0; i < 2; i++) await assert.rejects(cache.begin({ resourceId: randomUUID(), source: await f.source(), window }, new AbortController().signal),
    error => error instanceof f.core.errors.MobileDsdError && error.code === 'RESOURCE_BUSY');
  assert.deepEqual(cache.snapshot(), { jobs: 0, waitingResources: 0, entries: 0, bytes: 0, active: 0, closing: false });
  await f.unchanged(); await f.close();
});

test('MBM003ready租期：已完成产物跨原240秒仍可renew/read，原准备窗不被重分配', { timeout: 30_000 }, async t => {
  const f = await backendFixture(t), cache = await f.cache(), id = randomUUID(), window = preparationWindow(), signal = new AbortController().signal;
  await cache.begin({ resourceId: id, source: await f.source(), window }, signal); const facts = await ready(cache, id);
  const full = await cache.read(id, 0, facts.size, signal), actualNow = Date.now();
  t.mock.method(Date, 'now', () => actualNow + 240_001); t.after(() => t.mock.restoreAll());
  await cache.renew(id); assert.deepEqual(await cache.read(id, 0, facts.size, signal), full);
  assert.equal((await cache.status(id)).processing.mode, 'dsd_to_pcm'); await cache.release(id); await f.close(); await f.unchanged();
});

test('MBM003真实缓存关闭未核：完整Hash拒绝后精确FD保留，资格与后续作业封闭，release与close拒绝quiet', { timeout: 45_000 }, async t => {
  // 未核实的原 guard 必须保留；单独进程隔离此负例，不重置锁或改变前六例的零资源断言。
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./cache-close-unverified-child.ts', import.meta.url))], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, closed = false, timedOut = false, overflow = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 35_000);
  const capture = (parts: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length; if (bytes > 64 * 1024) { overflow = true; child.kill('SIGKILL'); return; } parts.push(Buffer.from(chunk));
  };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  t.after(() => { clearTimeout(timer); if (!closed) child.kill('SIGKILL'); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { closed = true; clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(timedOut, false); assert.equal(overflow, false); assert.equal(result.signal, null);
  assert.equal(result.code, 0, Buffer.concat(stderr).toString('utf8'));
  assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString('utf8')), {
    schema: 'mbm003.cache-close-unverified-controlled-native-negative.v1',
    actualConvertedCache: true, exactReadonlyFdCloseRefused: true, fullHashMismatch: true,
    qualified: false, retainedCapacityAndFiles: true, retainedPhysicalAndNamespaceClaims: true,
    releaseAndCloseQuietFalse: true, laterBeginRefused: true, sourceUnchanged: true,
    testFdClosedByOriginalMethod: true, productQuietClaimed: false,
  });
});
