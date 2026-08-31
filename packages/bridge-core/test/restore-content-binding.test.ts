import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { archiveBackupFixture } from './helpers/archive-backup-fixture.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { restoreArchiveBackup, verifyRestoredArchive } from '../src/recording/restore-package.js';
import { prepareRestoredDataset } from '../src/recording/restore-activation-files.js';
import { createCollectionRepository } from '../src/collection/repository.js';

async function fixture(t: test.TestContext, mode: 'metadata' | 'archive-content' = 'archive-content') {
  const f = await archiveBackupFixture(t), backup = await f.api.createArchiveBackup({ ...f.backupRequest, mode });
  const capability = async (name: string) => {
    const absolute = path.join(f.directory, name); await mkdir(absolute);
    return { ...await authorizeSourceDirectory(absolute), id: randomUUID() };
  };
  const restored = await restoreArchiveBackup({ backup: backup.directory, destination: await capability('恢复副本'), protectedRoots: [], id: randomUUID(), userConfirmed: true, signal: new AbortController().signal });
  const prepared = await prepareRestoredDataset({ id: randomUUID(), source: restored.directory, destination: await capability('工作库集合'), userConfirmed: true, signal: new AbortController().signal });
  const repository = createCollectionRepository({ filePath: path.join(prepared.database.path, 'collection.sqlite') });
  t.after(() => repository.close());
  const module = await import('../src/recording/restore-content-binding.js').catch(() => ({}));
  assert.ok('createRestoredContentBinding' in module, '缺少恢复位置内容绑定解析器');
  const create = (module as typeof import('../src/recording/restore-content-binding.js')).createRestoredContentBinding;
  const binding = create(prepared), destination = await capability('再次备份');
  const request = { repository, destination, id: randomUUID(), mode: 'archive-content' as const, userConfirmed: true, signal: new AbortController().signal, contentBinding: binding };
  return { ...f, originalRepository: f.repository, repository, restored, prepared, create, binding, request, capability };
}

test('历史权限与操作不改写，绑定仅解析恢复包内相同操作与清单身份', async t => {
  const f = await fixture(t), op = f.repository.archive.operation(f.archiveRequest.commandId)!.owned!;
  const before = structuredClone(op), session = await f.binding.open(f.request.signal);
  assert.equal(session.resolve(op)?.path, path.join(f.restored.directory.path, 'objects'));
  assert.equal(session.resolve({ ...op, id: randomUUID() }), undefined);
  assert.throws(() => session.resolve({ ...op, manifest: op.manifest + ' ' }));
  assert.throws(() => session.resolve({ ...op, archive: { ...op.archive, id: randomUUID() } }));
  assert.throws(() => session.resolve({ ...op, files: [] }));
  await assert.rejects(f.create({ ...f.prepared, restoreId: randomUUID() }).open(f.request.signal));
  await assert.rejects(f.create({ ...f.prepared, restoreManifestHash: 'f'.repeat(64) }).open(f.request.signal));
  assert.deepEqual(f.repository.archive.operation(op.id)!.owned, before);
  assert.throws(() => f.repository.archive.root(op.archive.id));
  assert.ok(f.repository.archive.candidates().every(root => !root.authorized));
});

test('原归档离线后从恢复对象再次全内容备份，复核与再次隔离恢复成功', async t => {
  const f = await fixture(t), before = structuredClone(f.repository.archive.operation(f.archiveRequest.commandId));
  await rm(f.root.root.path, { recursive: true });
  const result = await f.api.createArchiveBackup(f.request);
  const verified = await f.api.verifyArchiveBackup(result.directory, f.request.signal);
  assert.equal(verified.contentIncluded, true); assert.deepEqual(verified.objects, f.restored.manifest.objects);
  const again = await restoreArchiveBackup({ backup: result.directory, destination: await f.capability('再次恢复'), protectedRoots: [], id: randomUUID(), userConfirmed: true, signal: f.request.signal });
  assert.equal((await verifyRestoredArchive(again.directory, f.request.signal)).contentIncluded, true);
  assert.deepEqual(f.repository.archive.operation(f.archiveRequest.commandId), before);
  assert.throws(() => f.repository.archive.root(f.root.id));
  for (const object of verified.objects) assert.deepEqual(await readFile(path.join(result.directory.path, 'objects', object.sha256)), await readFile(path.join(f.restored.directory.path, 'objects', object.sha256)));
});

test('metadata恢复绑定不提供音频位置，仍可再次元数据备份而不能声称全内容可用', async t => {
  const f = await fixture(t, 'metadata'), op = f.repository.archive.operation(f.archiveRequest.commandId)!.owned!;
  assert.equal((await f.binding.open(f.request.signal)).resolve(op), undefined);
  await rm(f.root.root.path, { recursive: true });
  await assert.rejects(f.api.createArchiveBackup(f.request));
  const result = await f.api.createArchiveBackup({ ...f.request, id: randomUUID(), mode: 'metadata' });
  assert.equal((await f.api.verifyArchiveBackup(result.directory, f.request.signal)).contentIncluded, false);
  assert.deepEqual(await readdir(path.join(result.directory.path, 'objects')), []);
});

test('已打开绑定后恢复对象变化仍拒绝校验与再次备份，不发布完成收据', async t => {
  const f = await fixture(t), object = f.restored.manifest.objects[0]!, session = await f.binding.open(f.request.signal);
  await writeFile(path.join(f.restored.directory.path, 'objects', object.sha256), '合成损坏对象');
  await assert.rejects(session.verify(f.request.signal));
  await assert.rejects(f.api.createArchiveBackup(f.request));
  assert.deepEqual(await readdir(f.request.destination.path), []);
});

test('备份过程中的恢复对象篡改被拒绝，源恢复目录不得成为备份目标', async t => {
  const f = await fixture(t), before = await readdir(f.restored.directory.path), object = f.restored.manifest.objects[0]!;
  await assert.rejects(f.api.createArchiveBackup({ ...f.request, destination: f.restored.directory }));
  assert.deepEqual(await readdir(f.restored.directory.path), before);
  await assert.rejects(f.api.createArchiveBackup({ ...f.request, afterSnapshot: async () => { await writeFile(path.join(f.restored.directory.path, 'objects', object.sha256), '复制期间的合成损坏'); } }));
  assert.ok(!(await readdir(path.join(f.request.destination.path, f.request.id))).includes('Complete.json'));
});

test('恢复包未绑定的新归档仍从原授权根核验，撤权不能借绑定绕过', async t => {
  const f = await fixture(t), parent = await f.capability('后续归档');
  const root = await f.archive.authorize(randomUUID(), parent.path);
  await f.archive.initialize({ commandId: randomUUID(), id: root.id, userConfirmed: true });
  const selection = { rootId: root.id, assetId: f.archiveRequest.assetId, sourcePolicy: 'preserve-exact-sources' as const };
  const preview = await f.archive.preview({ ...selection, readId: randomUUID() });
  const request = { ...selection, commandId: randomUUID(), proposalFingerprint: preview.proposalFingerprint, userConfirmed: true as const };
  await f.archive.start(request); await f.archive.idle();
  assert.equal(f.originalRepository.archive.operation(request.commandId)?.phase, 'FINALIZED');
  await rm(f.root.root.path, { recursive: true });
  const result = await f.api.createArchiveBackup({ ...f.request, repository: f.originalRepository });
  assert.equal((await f.api.verifyArchiveBackup(result.directory, f.request.signal)).operations.length, 2);
  await f.archive.revoke({ commandId: randomUUID(), id: root.id });
  await assert.rejects(f.api.createArchiveBackup({ ...f.request, repository: f.originalRepository, id: randomUUID() }));
});

test('恢复内容绑定在open、resolve与verify边界实时检查授权，不重授已撤权能力', async t => {
  const f = await fixture(t), op = f.repository.archive.operation(f.archiveRequest.commandId)!.owned!;
  let authorized = true;
  const binding = f.create(f.prepared, { isAuthorized: () => authorized });
  const session = await binding.open(f.request.signal);
  assert.equal(session.resolve(op)?.path, path.join(f.restored.directory.path, 'objects'));
  authorized = false;
  assert.throws(() => session.resolve(op), '撤权后的已打开会话不得再返回对象能力');
  await assert.rejects(session.verify(f.request.signal));
  await assert.rejects(binding.open(f.request.signal));
});
