import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { MobileDsdConverter, MobileDsdSourceAccess } from '../../src/mobile/prepared-cache-types.js';
import { MobileDsdError } from '../../src/mobile/prepared-cache-types.js';

// 仅隔离固定converter端口；真实cache队列、作业收口、写FD由生产实现执行。
const sources = new WeakMap<MobileDsdSourceAccess, { signature: string; closed: boolean; close?: () => Promise<void> }>();
const converterModule = process.env.MB_ACTIVITY_CACHE_MODULE ? new URL('dsd-converter.ts', process.env.MB_ACTIVITY_CACHE_MODULE).href : new URL('../../src/mobile/dsd-converter.ts', import.meta.url).href;
mock.module(converterModule, { namedExports: {
  isQualifiedMobileDsdConverter: () => true,
  mobileDsdSourceIdentity(source: MobileDsdSourceAccess) { const record = sources.get(source)!; return { identity: source.identity, signature: record.signature, size: 64, samples: 4, fullHash: null }; },
  async hashMobileDsdSource(_source: MobileDsdSourceAccess, check: () => void) { check(); return 'a'.repeat(64); },
  async verifyMobileDsdSource(source: MobileDsdSourceAccess) { if (sources.get(source)!.closed) throw new MobileDsdError('RESOURCE_RELEASED'); },
  async closeMobileDsdSource(source: MobileDsdSourceAccess) { const record = sources.get(source)!; await record.close?.(); record.closed = true; },
} });
const cacheModule = process.env.MB_ACTIVITY_CACHE_MODULE ?? new URL('../../src/mobile/prepared-cache.js', import.meta.url).href;
const { createMobilePreparedCache } = await import(cacheModule) as typeof import('../../src/mobile/prepared-cache.js');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, unknownQuiet = false, succeeds = false) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const dir = await mkdtemp(path.join(process.env.TMPDIR!, 'mobile-dsd-priority-')), entered = deferred(), finish = deferred(), released = deferred();
  let count = 0, begins = 0, writer: FileHandle | undefined;
  const outputBytes = Buffer.alloc(64, 7);
  const converter: MobileDsdConverter = { identity: 'b'.repeat(64), async convert(_source, output) {
    writer = output; entered.resolve(); await finish.promise;
    if (succeeds) { await output.writeFile(outputBytes); return; }
    throw new MobileDsdError('UNSUPPORTED_FORMAT', !unknownQuiet);
  }, async verifyOutput() {
    if (!succeeds) throw new Error('失败转换不得校验输出。');
    return { size: outputBytes.length, sha256: createHash('sha256').update(outputBytes).digest('hex'), samples: 4,
      actualAudio: { codec: 'flac', container: 'flac', sampleRateHz: 48000, bitsPerSample: 24, channels: 2 } };
  } };
  const cache = await createMobilePreparedCache({ directory: path.join(dir, 'mobile-dsd-cache'), datasetId: randomUUID(), ownerEpoch: randomUUID(), converter, assertCurrent() {} });
  t.after(async () => { finish.resolve(); if (unknownQuiet) { await assert.rejects(cache.close(), MobileDsdError); await writer?.close(); } else await cache.close(); await rm(dir, { recursive: true }); });
  const source = (identity = 'c'.repeat(64), close?: () => Promise<void>): MobileDsdSourceAccess => {
    const value = { identity, sourceAudio: { codec: 'dsd', container: 'dsf', sampleRateHz: 2822400, bitsPerSample: 1, channels: 2 }, durationMs: 1000 };
    sources.set(value, { signature: 'same', closed: false, ...(close ? { close } : {}) }); return value;
  };
  const beginActivity = () => { count++; begins++; let done = false; return () => { if (!done) { done = true; count--; if (count === 0) released.resolve(); } }; };
  const now = Date.now(), window = { resourceCreatedAtMs: now, resourceExpiresAtMs: now + 240000, sessionExpiresAtMs: now + 300000, remainingPreparationMs: 240000 };
  const begin = (id: string, value = source(), armed = true) => cache.begin({ resourceId: id, source: value, window, ...(armed ? { beginActivity } : {}) }, new AbortController().signal);
  return { cache, source, begin, entered, finish, released, count: () => count, begins: () => begins };
}

test('DSD 202之后真实job仍持token，共享job一token、首waiter取消不清其它工作，普通失败quiet自然归还', { timeout: 8000 }, async t => {
  const f = await fixture(t), first = randomUUID(), second = randomUUID();
  assert.ok('preparing' in await f.begin(first)); await f.entered.promise; await f.begin(second);
  try { assert.equal(f.count(), 1); assert.equal(f.begins(), 1); await f.cache.release(first); assert.equal(f.count(), 1); } finally { f.finish.resolve(); }
  await f.released.promise; assert.equal(f.count(), 0, '必须由job真正结束归还，不依赖status轮询或资源release。');
  await f.cache.release(second); assert.equal(f.count(), 0);
});

test('DSD排队共享job取消必须等源真实close，旧token归还不清活动job', { timeout: 8000 }, async t => {
  const f = await fixture(t), active = randomUUID(), a = randomUUID(), b = randomUUID(), closeEntered = deferred(), closeFinish = deferred();
  await f.begin(active); await f.entered.promise;
  await f.begin(a, f.source('d'.repeat(64), async () => { closeEntered.resolve(); await closeFinish.promise; }));
  await f.begin(b, f.source('d'.repeat(64))); assert.equal(f.count(), 2); assert.equal(f.begins(), 2);
  await f.cache.release(a); assert.equal(f.count(), 2);
  let done = false; const release = f.cache.release(b).then(() => { done = true; }); await closeEntered.promise;
  try { assert.equal(done, false); assert.equal(f.count(), 2); } finally { closeFinish.resolve(); }
  await release; assert.equal(f.count(), 1); f.finish.resolve(); await f.released.promise; assert.equal(f.count(), 0);
});

test('DSD cleanup quiet未确认保留token，不以job拒绝或202当空闲', { timeout: 8000 }, async t => {
  const f = await fixture(t, true), id = randomUUID(); await f.begin(id); await f.entered.promise;
  try { assert.equal(f.count(), 1); } finally { f.finish.resolve(); }
  await assert.rejects(f.cache.release(id), MobileDsdError); assert.equal(f.count(), 1);
});

test('未接活动回调保持原202/释放语义，早期拒绝不制造token', { timeout: 8000 }, async t => {
  const f = await fixture(t), id = randomUUID(); await f.begin(id, f.source(), false); await f.entered.promise;
  assert.equal(f.count(), 0); assert.equal(f.begins(), 0); f.finish.resolve(); await f.cache.release(id); assert.equal(f.count(), 0);
});


test('DSD成功准备无需status轮询便归还job token，仍存活缓存/lease不饿死后台', { timeout: 8000 }, async t => {
  const f = await fixture(t, false, true), id = randomUUID();
  assert.ok('preparing' in await f.begin(id)); await f.entered.promise;
  try { assert.equal(f.count(), 1); } finally { f.finish.resolve(); }
  await f.released.promise; assert.equal(f.count(), 0); assert.equal(f.cache.snapshot().active, 1);
  assert.equal('preparing' in await f.cache.status(id), false);
  await f.cache.release(id); assert.equal(f.count(), 0);
});
