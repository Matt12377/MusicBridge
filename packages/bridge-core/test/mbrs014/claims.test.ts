import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhysicalResourceCoordinator, PhysicalResourceBusy, physicalResourceLocks, type PhysicalResourceGuard } from '../../src/stream/physical-resource-locks.js';
import { acquirePhysicalReadClaims, PhysicalClaimsUnverified } from '../../src/stream/physical-resource-claims.js';
import { authorizeSourceDirectory, withReadonlySourcePublicationClaims } from '../../src/recording/source-files.js';

const resources = (count: number) => Array.from({ length: count }, (_, i) => ({ dev: '1', ino: String(i + 1) }));

for (const count of [129, 200, 2048]) test(`014 分组 claims：${count} 个资源保留原容量，全持有后才准入`, async () => {
  const locks = new PhysicalResourceCoordinator(), selected = resources(count);
  const claims = await acquirePhysicalReadClaims(selected, locks);
  assert.deepEqual(locks.snapshot(), { readers: count, writers: 0, resources: count });
  assert.throws(() => locks.acquireWrite([selected[0]!, selected[count - 1]!]), PhysicalResourceBusy);
  await claims.release(); await claims.release();
  assert.equal(claims.state, 'released');
  assert.deepEqual(locks.snapshot(), { readers: 0, writers: 0, resources: 0 });
});

test('014 后组冲突：已取得的前128个资源全部回收，不留下半个发布保护', async () => {
  const locks = new PhysicalResourceCoordinator(), selected = resources(200), busy = locks.acquireWrite([selected[128]!]);
  await assert.rejects(acquirePhysicalReadClaims(selected, locks), PhysicalResourceBusy);
  assert.deepEqual(locks.snapshot(), { readers: 0, writers: 1, resources: 1 });
  await busy.release();
});

test('014 释放未核：不冒充已释放，也不自动重发底层release', async () => {
  const held: PhysicalResourceGuard[] = []; let failedReleaseCalls = 0;
  class FailingCoordinator extends PhysicalResourceCoordinator {
    override acquireRead(selected: Parameters<PhysicalResourceCoordinator['acquireRead']>[0]) {
      const guard = super.acquireRead(selected); held.push(guard);
      return held.length === 1 ? { release: async () => { failedReleaseCalls++; throw new Error('合成释放故障'); } } : guard;
    }
  }
  const locks = new FailingCoordinator(), claims = await acquirePhysicalReadClaims(resources(200), locks);
  await assert.rejects(claims.release(), PhysicalClaimsUnverified);
  assert.equal(claims.state, 'unverified');
  assert.deepEqual(locks.snapshot(), { readers: 128, writers: 0, resources: 128 });
  await assert.rejects(claims.release(), PhysicalClaimsUnverified);
  assert.equal(failedReleaseCalls, 1);
  // 仅本测试移除故障后明确收回自身底层guard，生产不会自动做这一步。
  await held[0]!.release();
});

test('014 真实200个FD/fstat发布集合：第二组实际inode也受保护，callback收口后才释放', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-mbrs014-claims-'))), sourcePath = path.join(directory, 'sources');
  await mkdir(sourcePath); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = { ...await authorizeSourceDirectory(sourcePath), id: randomUUID() }, names = Array.from({ length: 200 }, (_, i) => `${i}.wav`);
  for (const name of names) await writeFile(path.join(sourcePath, name), Buffer.from('合成物理资源'));
  const info = await lstat(path.join(sourcePath, names[128]!), { bigint: true }), resource = { dev: String(info.dev), ino: String(info.ino) };
  let entered!: () => void, release!: () => void, settled = false;
  const began = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = withReadonlySourcePublicationClaims(names.map(relative => ({ root, relative })), controller.signal, async verify => {
    await verify(); entered(); await resume;
  }).finally(() => { settled = true; });
  await began;
  assert.equal(physicalResourceLocks.snapshot().readers, 200);
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.throws(() => physicalResourceLocks.acquireWrite([resource]), PhysicalResourceBusy);
  release(); await pending;
  assert.deepEqual(physicalResourceLocks.snapshot(), { readers: 0, writers: 0, resources: 0 });
  const after = physicalResourceLocks.acquireWrite([resource]); await after.release();
});
