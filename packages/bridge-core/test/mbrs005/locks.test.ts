import assert from 'node:assert/strict';
import { link, mkdir, open, symlink, rename, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { LocalFileSourcePool } from '../../src/stream/local-file-source.js';
import { PhysicalResourceCoordinator, physicalResourceLocks, PhysicalResourceBusy, PHYSICAL_RESOURCE_BUFFER_BYTES } from '../../src/stream/physical-resource-locks.js';
import { authorizeSourceDirectory, openLocalPlaybackReadonlySource, readonlySourceCandidateMetadata, withCheckedReadonlyMetadataSource, withVerifiedReadonlySource, withVerifiedReadonlyReplicaSource, copyReadonlySource, probeReadonlySource } from '../../src/recording/source-files.js';
import { fixture, authority, eventually } from './fixture.js';

test('AT09/11 dev/ino跨根别名/硬链接/共享cover一致，原严格Scanner仍拒绝硬链接', async t => {
  const f = await fixture(t), alias = path.join(f.directory, 'cover-shared.jpg'); await link(f.absolute, alias);
  const nested = path.join(f.directory, '别名根'); await mkdir(nested); const alias2 = path.join(nested, '音乐.wav'); await link(f.absolute, alias2);
  const nestedRoot = { id: 'nested-source', ...await authorizeSourceDirectory(nested) };
  const a = await openLocalPlaybackReadonlySource(f.descriptor.facts.sourceRoot, f.descriptor.facts.relative);
  const b = await openLocalPlaybackReadonlySource(f.descriptor.facts.sourceRoot, path.basename(alias));
  const c = await openLocalPlaybackReadonlySource(nestedRoot, path.basename(alias2));
  assert.equal(physicalResourceLocks.snapshot().readers, 3); assert.equal(physicalResourceLocks.snapshot().resources, 1);
  assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  await assert.rejects(readonlySourceCandidateMetadata(f.descriptor.facts.sourceRoot, f.descriptor.facts.relative), /OUTSIDE_ROOT/u);
  await a.close(); await b.close(); assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy); await c.close();
  const writer = physicalResourceLocks.acquireWrite([f.resource]);
  await assert.rejects(openLocalPlaybackReadonlySource(nestedRoot, path.basename(alias2)), PhysicalResourceBusy); await writer.release();
});

test('AT09 原子全资源写准入不会因部分拒绝泄漏锁，有限容量/释放幂等', async () => {
  const locks = new PhysicalResourceCoordinator(), occupied = { dev: '1', ino: '2' }, free = { dev: '1', ino: '3' };
  const read = locks.acquireRead([occupied]); assert.throws(() => locks.acquireWrite([free, occupied]), PhysicalResourceBusy);
  assert.deepEqual(locks.snapshot(), { readers: 1, writers: 0, resources: 1 });
  const other = locks.acquireWrite([free]); await other.release(); await other.release(); await read.release();
  const guards = []; for (let i = 0; i < 16; i++) guards.push(locks.acquireWrite(Array.from({ length: 128 }, (_, j) => ({ dev: '1', ino: String(i * 128 + j + 10) }))));
  assert.equal(locks.snapshot().resources, 2048); assert.throws(() => locks.acquireRead([{ dev: '2', ino: '3' }]), PhysicalResourceBusy);
  await Promise.all(guards.map(guard => guard.release())); assert.deepEqual(locks.snapshot(), { readers: 0, writers: 0, resources: 0 });
  assert.throws(() => new PhysicalResourceCoordinator(new SharedArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES - 4)));
});

test('AT09 真Worker元数据reader与Core共享表，取消后仍等consume/FD quiet才允许独占', async t => {
  const f = await fixture(t);
  const worker = new Worker(new URL('./physical-worker.mjs', import.meta.url), { workerData: { buffer: physicalResourceLocks.buffer, root: f.descriptor.facts.sourceRoot, relative: f.descriptor.facts.relative } });
  t.after(() => worker.terminate());
  const [held] = await once(worker, 'message'); assert.equal(held.status, 'held'); assert.deepEqual(held.bytes, [...f.bytes.subarray(0, 4)]);
  assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  worker.postMessage('cancel'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  const done = once(worker, 'message'); worker.postMessage('release'); const [released] = await done; assert.deepEqual(released, { status: 'rejected', code: 'CANCELLED' });
  await once(worker, 'exit'); const writer = physicalResourceLocks.acquireWrite([f.resource]); await writer.release();
});

test('AT09 Core独占时真Worker reader拒绝，Gateway播放reader时真Worker独占拒绝', async t => {
  const f = await fixture(t); const guard = physicalResourceLocks.acquireWrite([f.resource]);
  const readWorker = new Worker(new URL('./physical-worker.mjs', import.meta.url), { workerData: { buffer: physicalResourceLocks.buffer, root: f.descriptor.facts.sourceRoot, relative: f.descriptor.facts.relative } });
  const [deniedRead] = await once(readWorker, 'message'); assert.equal(deniedRead.status, 'rejected'); assert.equal(deniedRead.code, 'Error'); await once(readWorker, 'exit'); await guard.release();
  const pool = new LocalFileSourcePool(); t.after(() => pool.close()); const lease = await pool.prepare(f.descriptor, authority());
  const writeWorker = new Worker(new URL('./physical-worker.mjs', import.meta.url), { workerData: { buffer: physicalResourceLocks.buffer, mode: 'write', absolute: f.absolute } });
  const [deniedWrite] = await once(writeWorker, 'message'); assert.equal(deniedWrite.status, 'rejected'); await once(writeWorker, 'exit'); await lease.close();
  const admitted = new Worker(new URL('./physical-worker.mjs', import.meta.url), { workerData: { buffer: physicalResourceLocks.buffer, mode: 'write', absolute: f.absolute } });
  const [held] = await once(admitted, 'message'); assert.equal(held.status, 'held'); await assert.rejects(pool.prepare(f.descriptor, authority(2)), PhysicalResourceBusy);
  const done = once(admitted, 'message'); admitted.postMessage('release'); assert.equal((await done)[0].status, 'released'); await once(admitted, 'exit');
});

test('AT08/09 人工阻塞真实FD read时，close不能先释放保护，quiet后FD确实关闭', async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  const lease = await pool.prepare(f.descriptor, authority()), handle = (lease as unknown as { file: { handle: FileHandle } }).file.handle;
  const original = handle.read.bind(handle); let resume!: () => void, entered = false;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => { entered = true; await wait; return original(buffer, offset, length, position); }) as FileHandle['read'];
  const iterator = lease.readSlice(0, 3, new AbortController().signal); const pending = iterator.next().catch(error => error);
  await eventually(() => entered, '受控FD读取已进入等待');
  let closed = false; const close = lease.close().then(() => { closed = true; }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, false); assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  resume(); await pending; await close; assert.equal(handle.fd, -1); assert.equal(closed, true);
  const writer = physicalResourceLocks.acquireWrite([f.resource]); await writer.release();
});

test('AT04 根撤销、越界、末级/中间符号链接与目录替换均拒绝，不读取授权根外文件', async t => {
  const f = await fixture(t), root = f.descriptor.facts.sourceRoot;
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'x'), 'secret');
  await symlink(path.join(outside, 'x'), path.join(f.directory, 'symlink')); await symlink(outside, path.join(f.directory, 'linked-dir'));
  for (const relative of ['../x', f.absolute, 'symlink', 'linked-dir/x', '\0', 'a/../x']) await assert.rejects(openLocalPlaybackReadonlySource(root, relative));
  await assert.rejects(openLocalPlaybackReadonlySource({ ...root, authorized: false }, f.descriptor.facts.relative), /REVOKED/u);
  const inner = path.join(f.directory, 'inner'); await mkdir(inner); await writeFile(path.join(inner, 'x'), '1234');
  const opened = await openLocalPlaybackReadonlySource(root, 'inner/x'); await rename(inner, inner + '-old'); await mkdir(inner); await writeFile(path.join(inner, 'x'), '1234');
  await assert.rejects(opened.verify(), /CONTENT_CHANGED/u); await opened.close();
});

test('AT09 五个现有严格读入口全部拒绝独占资源，原Hash失败仍捕获', async t => {
  const f = await fixture(t), root = f.descriptor.facts.sourceRoot, relative = f.descriptor.facts.relative;
  const signature = (await readonlySourceCandidateMetadata(root, relative)).signature;
  const output = await open(path.join(f.directory, 'copy'), 'wx'); t.after(() => output.close());
  const expected = { sha256: '0'.repeat(64), size: f.bytes.length }, signal = new AbortController().signal;
  const guard = physicalResourceLocks.acquireWrite([f.resource]);
  await assert.rejects(withCheckedReadonlyMetadataSource(root, relative, signature, signal, async () => undefined), PhysicalResourceBusy);
  await assert.rejects(withVerifiedReadonlySource(root, relative, expected, signal, async () => undefined), PhysicalResourceBusy);
  await assert.rejects(withVerifiedReadonlyReplicaSource(root, relative, expected, signal, async () => undefined, () => undefined, { durationMs: 1000 }), PhysicalResourceBusy);
  await assert.rejects(copyReadonlySource(root, relative, expected, output, signal), PhysicalResourceBusy);
  await assert.rejects(probeReadonlySource(root, relative, signal), PhysicalResourceBusy); await guard.release();
  await assert.rejects(withVerifiedReadonlySource(root, relative, expected, signal, async () => undefined), /HASH_MISMATCH/u);
});
