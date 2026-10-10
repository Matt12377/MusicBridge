import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import fsPromises, { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createLocalRelocationCoordinator } from '../src/collection/local-relocation-coordinator.js';
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js';
import { captureSourceNamespace } from '../src/stream/source-namespace-claims.js';
import { PhysicalResourceBusy, PhysicalResourceCoordinator } from '../src/stream/physical-resource-locks.js';

async function fixture(t: test.TestContext, inode: bigint) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mb-signed-stat-identity-'));
  const media = path.join(directory, 'media');
  await mkdir(media, { mode: 0o700 });
  await mkdir(path.join(media, 'album'), { mode: 0o700 });
  let observedInode = inode;
  const originalLstat = fsPromises.lstat;
  // 模拟平台实际返回的BigInt身份；许可、持久库和根登记仍使用原生产实现。
  const statMock = t.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof originalLstat>) => {
    const info = await originalLstat(...args);
    if (String(args[0]) === media && typeof info.ino === 'bigint') {
      Object.defineProperty(info, 'ino', { value: observedInode, enumerable: true, configurable: true });
    }
    return info;
  });
  syncBuiltinESMExports();
  const repository = createCollectionRepository({ filePath: path.join(directory, 'catalog.sqlite') });
  const service = createLocalRelocationCoordinator({ repository, assertCurrent() {} });
  t.after(async () => {
    service.close(); repository.close(); statMock.mock.restore(); syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  return { media, repository, service, source, observe(value: bigint) { observedInode = value; } };
}

test('本地库：真实有符号64位inode可登记，持久原回执与名称保护保持精确身份', async t => {
  const inode = -9_007_199_254_741_007n;
  const f = await fixture(t, inode);
  assert.equal(f.source.ino, String(inode));
  assert.equal(await sourceRootAvailability(f.source), 'ONLINE');
  const request = { commandId: randomUUID(), sourceRootId: f.source.id };
  const root = await f.service.registerRoot(request);
  assert.equal(root.sourceRootId, f.source.id);
  assert.deepEqual(await f.service.registerRoot(request), root, '同原command只读取持久登记回执');
  assert.equal(f.repository.localCatalog.roots().length, 1);
  assert.equal((await f.service.roots())[0]!.availability, 'ONLINE');
  const namespace = await captureSourceNamespace(f.source, 'album/song.flac');
  assert.ok(namespace, '只读源名称保护不能因有符号目录身份拒绝');
  assert.equal(f.repository.sources.root(f.source.id)!.ino, String(inode), '不能转Number或取绝对值');
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  assert.equal((await f.service.roots())[0]!.availability, 'REVOKED');
  assert.equal(f.repository.localCatalog.roots()[0]!.id, root.id, '撤权保留原音乐库');
});

test('本地库：正值高位inode不丢精度，改变符号后的物理根仍拒绝登记', async t => {
  const inode = 18_446_744_073_709_551_605n;
  const f = await fixture(t, inode);
  const request = { commandId: randomUUID(), sourceRootId: f.source.id };
  f.observe(-inode);
  assert.equal(await sourceRootAvailability(f.source), 'SOURCE_ROOT_OFFLINE');
  await assert.rejects(f.service.registerRoot(request));
  assert.equal(f.repository.localCatalog.roots().length, 0);
  f.observe(inode);
  const root = await f.service.registerRoot(request);
  assert.equal(root.sourceRootId, f.source.id);
  assert.equal(f.repository.sources.root(f.source.id)!.ino, String(inode));
});

test('本地库：非canonical身份及不安全Number不能注册或写入库根', async t => {
  const f = await fixture(t, 123n), originalRoot = f.repository.sources.root.bind(f.repository.sources);
  let malformed: unknown = '-0';
  t.mock.method(f.repository.sources, 'root', (id: string) => {
    const source = originalRoot(id);
    return source && id === f.source.id ? { ...source, ino: malformed as string } : source;
  });
  for (malformed of ['-0', '+1', '01', '-01', '1.0', '1e3', '0x1', '', ' 1', 9_007_199_254_741_008]) {
    await assert.rejects(f.service.registerRoot({ commandId: randomUUID(), sourceRootId: f.source.id }), /SourceStore根结构无效/);
    assert.equal(f.repository.localCatalog.roots().length, 0);
  }
});

test('物理读锁：负inode与高位身份跨同一SAB互斥，正负号保持不同物理身份', async () => {
  const coordinator = new PhysicalResourceCoordinator(), peer = new PhysicalResourceCoordinator(coordinator.buffer);
  const signed = { dev: '7', ino: '-9007199254741007' }, positive = { dev: '7', ino: '9007199254741007' };
  const read = coordinator.acquireRead([signed]);
  try {
    assert.throws(() => peer.acquireWrite([signed]), PhysicalResourceBusy);
    const different = peer.acquireWrite([positive]);
    await different.release();
  } finally { await read.release(); }
  const write = peer.acquireWrite([signed]);
  try { assert.throws(() => coordinator.acquireRead([signed]), PhysicalResourceBusy); }
  finally { await write.release(); }
  const high = coordinator.acquireRead([{ dev: '7', ino: '18446744073709551605' }]);
  await high.release();
});

test('物理读锁：非法身份别名不能通过BigInt归一化进入协调表', () => {
  const coordinator = new PhysicalResourceCoordinator();
  for (const malformed of ['-0', '+1', '01', '-01', '1.0', '1e3', '0x1', '', ' 1']) {
    assert.throws(() => coordinator.acquireRead([{ dev: '7', ino: malformed }]));
  }
});
