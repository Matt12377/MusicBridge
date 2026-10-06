import assert from 'node:assert/strict';
import test from 'node:test';
import { fstatSync } from 'node:fs';
import type { MetadataReaderLifecycle, MetadataReadResult, MetadataReadInput } from '../../src/library/metadata-reader-types.js';
import { readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const { createMetadataReader } = await loadFreshMetadataReader();

type Fixture = Awaited<ReturnType<typeof audioFixture>>;
async function input(f: Fixture, id = 'core-flac'): Promise<MetadataReadInput> {
  const relative = f.entry(id).file;
  return { root: f.root, relative, expectedSignature: (await readonlySourceCandidateMetadata(f.root, relative)).signature };
}
function closedFd(fd: number): boolean {
  try { fstatSync(fd); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EBADF'; }
}
function completed(events: MetadataReaderLifecycle[], result: MetadataReadResult): void {
  const starts = events.filter((e): e is Extract<MetadataReaderLifecycle, { type: 'worker-start' | 'worker-online' }> => e.type === 'worker-start');
  assert.equal(starts.length, 1, '必须是真实启动过的Worker');
  const start = starts[0]!;
  const exited = events.findIndex(e => e.type === 'worker-exit' && e.threadId === start.threadId);
  const released = events.findIndex(e => e.type === 'lease-released' && e.fd === start.fd);
  const done = events.findIndex(e => e.type === 'read-complete');
  assert.equal(exited >= 0 && released > exited && done > released, true, 'actual exit→FD release→complete顺序');
  assert.equal(closedFd(start.fd), true, '完成时原FD必须实际EBADF');
  const completion = events[done]!;
  assert.equal(completion.type === 'read-complete' && completion.status === result.status, true);
}
function failure(result: MetadataReadResult, code: string): void {
  assert.equal(result.status, 'failure'); if (result.status === 'failure') assert.equal(result.code, code);
}

test('MBRS003 reader成功也等待真实Worker exit与FD EBADF后返回', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), events: MetadataReaderLifecycle[] = [];
  const reader = createMetadataReader({ onLifecycle: e => events.push(e) }); t.after(() => reader.close());
  const result = await reader.read(await input(f)); assert.equal(result.status, 'ok'); completed(events, result);
  assert.equal(events.some(e => e.type === 'worker-online'), true); await f.assertUnchanged();
});
test('MBRS003 reader在真实Worker online取消，返回前actual exit且原FD EBADF', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), events: MetadataReaderLifecycle[] = [], abort = new AbortController();
  const reader = createMetadataReader({ onLifecycle: e => { events.push(e); if (e.type === 'worker-online') abort.abort(); } }); t.after(() => reader.close());
  const result = await reader.read(await input(f), abort.signal); failure(result, 'CANCELLED'); completed(events, result);
  assert.equal(events.some(e => e.type === 'worker-online'), true); await f.assertUnchanged();
});
test('MBRS003 reader取得FD后start即取消，也join真实Worker并释放原FD', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), events: MetadataReaderLifecycle[] = [], abort = new AbortController();
  const reader = createMetadataReader({ onLifecycle: e => { events.push(e); if (e.type === 'worker-start') abort.abort(); } }); t.after(() => reader.close());
  const result = await reader.read(await input(f), abort.signal); failure(result, 'CANCELLED'); completed(events, result);
  await f.assertUnchanged();
});
test('MBRS003 reader从实际online计1ms超时，不能以preflight拒绝代替Worker退出', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), events: MetadataReaderLifecycle[] = [];
  const reader = createMetadataReader({ trustedBudget: { timeoutMs: 1 }, onLifecycle: e => events.push(e) }); t.after(() => reader.close());
  const result = await reader.read(await input(f, 'cover-over-flac')); failure(result, 'TIMEOUT');
  assert.equal(events.some(e => e.type === 'worker-online'), true); completed(events, result); await f.assertUnchanged();
});
test('MBRS003 reader close取消active与queued且实际join，不重新启动排队job', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), events: MetadataReaderLifecycle[] = [];
  const requests = await Promise.all(['core-flac', 'core-mp3', 'core-wav'].map(id => input(f, id)));
  let closing: Promise<void> | undefined;
  const reader = createMetadataReader({ concurrency: 1, onLifecycle: e => {
    events.push(e); if (e.type === 'worker-online' && !closing) closing = reader.close();
  } }); t.after(() => reader.close());
  const results = await Promise.all(requests.map(request => reader.read(request)));
  assert.notEqual(closing, undefined); await closing;
  assert.equal(results.every(r => r.status === 'failure' && ['CANCELLED', 'CLOSED'].includes(r.code)), true);
  const starts = events.filter(e => e.type === 'worker-start'); assert.equal(starts.length, 1);
  for (const start of starts) if (start.type === 'worker-start') {
    assert.equal(events.some(e => e.type === 'worker-exit' && e.threadId === start.threadId), true);
    assert.equal(events.some(e => e.type === 'lease-released' && e.fd === start.fd), true);
    assert.equal(closedFd(start.fd), true);
  }
  failure(await reader.read(requests[0]!), 'CLOSED'); await f.assertUnchanged();
});
test('MBRS003 reader真实并发受限且全部Worker退出，源字节保持', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t);
  for (const concurrency of [1, 2] as const) {
    const active = new Set<number>(), started = new Set<number>(), exited = new Set<number>();
    let maximum = 0;
    const reader = createMetadataReader({ concurrency, onLifecycle: e => {
      if (e.type === 'worker-start') { active.add(e.threadId); started.add(e.threadId); maximum = Math.max(maximum, active.size); }
      if (e.type === 'worker-exit') { active.delete(e.threadId); exited.add(e.threadId); }
    } });
    try {
      const requests = await Promise.all(['core-flac', 'core-mp3', 'core-wav'].map(id => input(f, id)));
      const results = await Promise.all(requests.map(request => reader.read(request)));
      assert.equal(results.every(r => r.status === 'ok'), true);
      assert.equal(started.size, 3); assert.equal(exited.size, 3); assert.equal(active.size, 0);
      assert.equal(maximum >= 1 && maximum <= concurrency, true);
    } finally { await reader.close(); }
  }
  await f.assertUnchanged();
});
test('MBRS003 reader可信准入被持有时不取FD，排队取消不抢许可，释放后真实读并归还', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), request = await input(f), events: MetadataReaderLifecycle[] = [];
  let unblock!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  const seen = new Promise<void>(resolve => { entered = resolve; });
  let releaseCount = 0;
  // 合成准入正负控制只证明reader尊重原permit端口，不冒充已接生产媒体调度。
  const reader = createMetadataReader({ onLifecycle: e => events.push(e), readAdmission: {
    async acquire(signal) {
      entered();
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new Error('合成准入取消'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
        void held.then(() => { signal.removeEventListener('abort', aborted); resolve(); });
      });
      return () => { ++releaseCount; };
    },
  } }); t.after(() => reader.close());
  const abort = new AbortController(), pending = reader.read(request, abort.signal);
  await seen; assert.equal(events.some(e => e.type === 'lease-acquired' || e.type === 'worker-start'), false);
  abort.abort(); failure(await pending, 'CANCELLED'); assert.equal(releaseCount, 0);
  unblock(); const result = await reader.read(request); assert.equal(result.status, 'ok'); assert.equal(releaseCount, 1);
  assert.equal(events.some(e => e.type === 'worker-exit'), true);
  for (const e of events) if (e.type === 'lease-released') assert.equal(closedFd(e.fd), true);
  await f.assertUnchanged();
});
