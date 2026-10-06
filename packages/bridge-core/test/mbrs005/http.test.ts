import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { open, rename, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import test from 'node:test';
import { selectLocalBytes } from '../../src/stream/local-file-http.js';
import { physicalResourceLocks, PhysicalResourceBusy } from '../../src/stream/physical-resource-locks.js';
import { gatewayFixture, eventually, captureOwnedFileObservation } from './fixture.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('AT01/07 真实自有文件原字节GET/HEAD/重复seek，HTTP结束仍保留播放FD租约', async t => {
  const f = await gatewayFixture(t);
  const full = await fetch(f.url); assert.equal(full.status, 200); assert.equal(full.headers.get('content-length'), String(f.bytes.length));
  assert.equal(hash(new Uint8Array(await full.arrayBuffer())), hash(f.bytes));
  const head = await fetch(f.url, { method: 'HEAD', headers: { Range: 'bytes=0-3' } });
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=100000-', 100000, f.bytes.length - 1], ['bytes=-17', f.bytes.length - 17, f.bytes.length - 1], ['bytes=20-999999', 20, f.bytes.length - 1]] as const) {
    const response = await fetch(f.url, { headers: { Range: range } }); assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${f.bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(start, end + 1));
  }
  assert.equal(f.lease.state, 'PREPARED'); assert.deepEqual(f.lease.resourceSnapshot(), { activeRequests: 0, activeIo: 0, timer: 1 });
  assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy); assert.equal(f.fetches(), 0);
  const records = JSON.stringify(f.events); assert.equal(records.includes(f.token), false); assert.equal(records.includes(f.absolute), false); assert.equal(records.includes(f.descriptor.target.core_id), false);
});

test('AT02 单Range边界、后缀、越界、逆序、多Range和超安全整数', async t => {
  const f = await gatewayFixture(t);
  for (const range of ['bytes=1-0', 'bytes=0-1,3-4', 'bytes=-', 'items=0-1', 'bytes=9007199254740993-', 'bytes=' + '1'.repeat(130) + '-']) {
    const response = await fetch(f.url, { headers: { Range: range } }); assert.equal(response.status, 400, range); assert.equal(await response.text(), '');
  }
  for (const range of [`bytes=${f.bytes.length}-`, 'bytes=-0']) {
    const response = await fetch(f.url, { headers: { Range: range } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${f.bytes.length}`);
  }
  assert.deepEqual(selectLocalBytes('bytes=-999999', undefined, 10), { status: 206, start: 0, end: 9 });
});

test('AT03 stat仅产生弱ETag，弱/假强/日期If-Range均回原始完整200', async t => {
  const f = await gatewayFixture(t);
  const head = await fetch(f.url, { method: 'HEAD' }); assert.match(head.headers.get('etag')!, /^W\/"[a-f0-9]{64}"$/u); assert.equal(head.headers.get('last-modified'), null);
  for (const validator of [head.headers.get('etag')!, head.headers.get('etag')!.slice(2), 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    const response = await fetch(f.url, { headers: { Range: 'bytes=0-3', 'If-Range': validator } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-range'), null); assert.equal(hash(new Uint8Array(await response.arrayBuffer())), hash(f.bytes));
  }
});

test('AT04/05 HTTP只接受内存secret，不接收path/URL/session，Host不参与公告地址', async t => {
  const f = await gatewayFixture(t), base = f.gateway.localBaseUrl();
  for (const suffix of ['/local-stream/' + 'A'.repeat(43), '/local-stream/' + f.token + '?path=' + encodeURIComponent(f.absolute), '/local-stream/' + f.token + '?url=http://127.0.0.1', '/local-stream/' + f.token + '?session_id=x', '/local-stream/%2e%2e/file', '/local-stream/' + f.token + '/extra']) {
    assert.equal((await fetch(base + suffix)).status, 404, suffix);
  }
  assert.equal((await fetch(f.url, { method: 'POST', body: JSON.stringify({ path: f.absolute }) })).status, 404);
  const head = await fetch(f.url, { method: 'HEAD', headers: { Host: 'untrusted.invalid:1234' } }); assert.equal(head.status, 200);
  assert.equal(f.gateway.localStreamUrl(f.token), f.url); assert.equal(f.fetches(), 0);
  await f.registry.revokeLocal(f.token); assert.equal((await fetch(f.url)).status, 404);
});

for (const mutation of ['replace', 'truncate', 'rename'] as const) test(`AT08 可观察${mutation}使租约失效，不能从新路径继续输出`, async t => {
  const f = await gatewayFixture(t);
  if (mutation === 'replace') { await rename(f.absolute, f.absolute + '.old'); await writeFile(f.absolute, Buffer.alloc(f.bytes.length, 255)); }
  if (mutation === 'truncate') await truncate(f.absolute, 4);
  if (mutation === 'rename') await rename(f.absolute, f.absolute + '.moved');
  const response = await fetch(f.url); assert.ok([404, 409].includes(response.status)); assert.equal(await response.text(), ''); await f.lease.close();
  assert.equal(f.lease.state, 'CLOSED'); assert.deepEqual(f.lease.resourceSnapshot(), { activeRequests: 0, activeIo: 0, timer: 0 });
  const guard = physicalResourceLocks.acquireWrite([f.resource]); await guard.release();
});

test('AT08 无HTTP时后台身份监测也撤销可观察替换，关闭timer与FD', async t => {
  const f = await gatewayFixture(t); await truncate(f.absolute, 3);
  await eventually(() => f.lease.state === 'CLOSED', '观察到截断后租约应主动关闭'); assert.equal(f.registry.getLocal(f.token), undefined);
});

test('AT08/10 128MiB稀疏文件只按64KiB读取，客户端背压/断连后request退出而lease仍在', async t => {
  const f = await gatewayFixture(t); await f.registry.revokeLocal(f.token);
  const file = await open(f.absolute, 'r+'); await file.truncate(128 * 1024 * 1024); await file.close();
  f.descriptor.facts.asset.fileRevision = '3'; await captureOwnedFileObservation(f.descriptor, f.absolute);
  const registration = await f.registry.registerLocalSource(f.descriptor, { ownerId: 'synthetic-large', attempt: 1, isCurrent: () => true });
  const lease = registration.lease, fixed = (lease as unknown as { file: { handle: FileHandle } }).file.handle;
  const original = fixed.read.bind(fixed); let readCalls = 0, largest = 0;
  fixed.read = ((buffer: Buffer, offset: number, length: number, position: number) => { readCalls++; largest = Math.max(largest, length); return original(buffer, offset, length, position); }) as FileHandle['read'];
  const url = f.gateway.localStreamUrl(registration.token);
  const suffix = await fetch(url, { headers: { Range: 'bytes=-17' } }); assert.equal(suffix.status, 206); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), Buffer.alloc(17)); assert.equal(readCalls, 1);
  await new Promise<void>((resolve, reject) => {
    const req = request(url, response => {
      response.pause();
      setTimeout(() => { try { assert.ok(readCalls < 256, `背压期间读取${readCalls}块，应有界`); assert.ok(largest <= 65536); response.destroy(); resolve(); } catch (error) { reject(error); } }, 100);
    }); req.on('error', reject); req.end();
  });
  await eventually(() => lease.resourceSnapshot().activeRequests === 0 && lease.resourceSnapshot().activeIo === 0, '断连应退出HTTP读取');
  assert.equal(lease.state, 'PREPARED'); assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  await f.gateway.stop(); assert.equal(lease.state, 'CLOSED'); assert.deepEqual(lease.resourceSnapshot(), { activeRequests: 0, activeIo: 0, timer: 0 });
});

test('AT08 受控NAS式read错误撤销租约并关闭实际FD，不能留可复用旧secret', async t => {
  const f = await gatewayFixture(t), handle = (f.lease as unknown as { file: { handle: FileHandle } }).file.handle;
  handle.read = (async () => { throw Object.assign(new Error('合成NAS读取故障'), { code: 'EIO' }); }) as FileHandle['read'];
  await assert.rejects(fetch(f.url));
  await eventually(() => f.lease.state === 'CLOSED', 'read故障后旧租约必须失效');
  assert.equal(handle.fd, -1); assert.equal(f.registry.getLocal(f.token), undefined);
});

test('AT08 每块post-read核验丢弃已改变的块，真实HTTP只能收到旧文件前缀', async t => {
  const f = await gatewayFixture(t), handle = (f.lease as unknown as { file: { handle: FileHandle } }).file.handle, original = handle.read.bind(handle);
  let reads = 0;
  handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
    const result = await original(buffer, offset, length, position);
    if (++reads === 2) await writeFile(f.absolute, Buffer.alloc(f.bytes.length, 255));
    return result;
  }) as FileHandle['read'];
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => { const req = request(f.url, response => {
    response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('aborted', resolve); response.once('end', resolve); response.once('error', () => resolve());
  }); req.once('error', () => resolve()); req.end(); setTimeout(() => reject(new Error('受控变化HTTP未退出')), 3000).unref(); });
  const bytes = Buffer.concat(chunks); assert.ok(bytes.length <= 65536); assert.deepEqual(bytes, f.bytes.subarray(0, bytes.length));
  await f.lease.close(); assert.equal(f.lease.state, 'CLOSED');
});

test('AT07/10 每lease四请求/全局八请求背压准入，Gateway.stop join所有实际FD read后释放', async t => {
  const resumes: (() => void)[] = []; t.after(() => { for (const resume of resumes) resume(); });
  const f = await gatewayFixture(t), second = await f.registry.registerLocalSource(f.descriptor, { ownerId: 'second-owner', attempt: 1, isCurrent: () => true }),
    third = await f.registry.registerLocalSource(f.descriptor, { ownerId: 'third-owner', attempt: 1, isCurrent: () => true });
  let entered = 0;
  for (const lease of [f.lease, second.lease]) {
    const handle = (lease as unknown as { file: { handle: FileHandle } }).file.handle, original = handle.read.bind(handle);
    const blocked = new Promise<void>(resolve => { resumes.push(resolve); });
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => { entered++; await blocked; return original(buffer, offset, length, position); }) as FileHandle['read'];
  }
  const clients: ReturnType<typeof request>[] = [];
  const start = (token: string) => { const req = request(f.gateway.localStreamUrl(token), response => { response.resume(); response.on('error', () => undefined); }); req.on('error', () => undefined); req.end(); clients.push(req); };
  for (let i = 0; i < 4; i++) start(f.token);
  await eventually(() => entered === 4, '四个同租约read实际进入阻塞');
  assert.equal((await fetch(f.url)).status, 429); assert.equal(f.lease.resourceSnapshot().activeRequests, 4);
  for (let i = 0; i < 4; i++) start(second.token);
  await eventually(() => entered === 8, '八个全局read实际进入阻塞');
  assert.equal((await fetch(f.gateway.localStreamUrl(third.token))).status, 429); assert.equal(f.gateway.getActiveMediaReadCount(), 8);
  let stopped = false; const stop = f.gateway.stop().then(() => { stopped = true; }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stopped, false); assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  for (const resume of resumes) resume(); await stop; for (const client of clients) client.destroy();
  assert.equal(stopped, true); for (const lease of [f.lease, second.lease, third.lease]) assert.equal(lease.state, 'CLOSED');
  assert.equal(f.gateway.getActiveMediaReadCount(), 0); const writer = physicalResourceLocks.acquireWrite([f.resource]); await writer.release();
});
