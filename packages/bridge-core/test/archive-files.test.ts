import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, lstat, rm, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { preparationFixture } from './helpers/preparation-fixture.js';
import { copyReadonlySource } from '../src/recording/source-files.js';
import { previewArchiveRoot, initializeArchiveRoot, createArchiveOperation, stageArchiveOperation, verifyArchiveStaging, promoteArchiveOperation, verifyArchiveObjects, finalizeArchiveOperation, archiveObjectPath, markArchivePhase } from '../src/recording/archive-files.js';

async function setup(t: test.TestContext) {
  const f = await preparationFixture(t), parentPath = path.join(f.directory, '独立归档目标'); await mkdir(parentPath);
  const protectedRoots = [f.repository.sources.root(f.root.id)], parent = await previewArchiveRoot(parentPath, protectedRoots);
  const archive = await initializeArchiveRoot(parent, randomUUID(), protectedRoots, true);
  const source = protectedRoots[0]!, bytes = await readFile(f.file), sha256 = createHash('sha256').update(bytes).digest('hex');
  const input = { role: 'execution-audio' as const, name: 'A.execution.wav', source, relative: 'fixture.wav', sha256, size: bytes.length, media: 'audio' as const };
  const lineage = { masterVersionId: randomUUID(), layoutVersionId: randomUUID(), executionAssetId: randomUUID() };
  const operation = await createArchiveOperation(archive, randomUUID(), [input], lineage);
  return { ...f, parent, parentPath, archive, input, lineage, operation, bytes, signal: new AbortController().signal };
}

test('归档预览只读；明确初始化、独立目录及源 Root 双向隔离', async t => {
  const f = await preparationFixture(t), parentPath = path.join(f.directory, '归档'); await mkdir(parentPath);
  const roots = [f.repository.sources.root(f.root.id)];
  const parent = await previewArchiveRoot(parentPath, roots); assert.deepEqual(await readdir(parentPath), []);
  await assert.rejects(initializeArchiveRoot(parent, randomUUID(), roots, false)); assert.deepEqual(await readdir(parentPath), []);
  await assert.rejects(previewArchiveRoot(f.sourcePath, roots)); await assert.rejects(previewArchiveRoot(f.directory, roots));
  const alias = path.join(f.directory, '链接'); await symlink(parentPath, alias); await assert.rejects(previewArchiveRoot(alias, roots));
  const id = randomUUID(), archive = await initializeArchiveRoot(parent, id, roots, true);
  assert.deepEqual((await readdir(archive.root.path)).sort(), ['.musicbridge-owner.json', 'Objects', 'Operations']);
  await assert.rejects(initializeArchiveRoot(parent, id, roots, true));
  assert.equal((await lstat(archive.root.path)).mode & 0o777, 0o700);
});

test('完整阶段、只读源保护与原子对象发布；重复 Finalize 不删除对象', async t => {
  const f = await setup(t), op = f.operation, sourceBefore = await lstat(f.file, { bigint: true });
  assert.deepEqual(await readdir(f.archive.objects.path), []);
  await assert.rejects(promoteArchiveOperation(op, f.signal));
  await stageArchiveOperation(op, f.signal); await verifyArchiveStaging(op, f.signal); await promoteArchiveOperation(op, f.signal);
  const object = archiveObjectPath(f.archive, f.input.sha256); assert.deepEqual(await readFile(object), f.bytes);
  await verifyArchiveObjects(op, f.signal); await markArchivePhase(op, 'DB_COMMITTED'); await finalizeArchiveOperation(op, f.signal); await markArchivePhase(op, 'DB_COMMITTED'); await finalizeArchiveOperation(op, f.signal);
  assert.deepEqual(await readdir(op.staging.path), []); assert.equal((await lstat(object)).nlink, 1);
  assert.deepEqual(await readFile(f.file), f.bytes); const after = await lstat(f.file, { bigint: true });
  assert.equal(after.ino, sourceBefore.ino); assert.equal(after.mtimeNs, sourceBefore.mtimeNs); assert.equal(after.ctimeNs, sourceBefore.ctimeNs);
  const manifest = JSON.parse(op.manifest); assert.equal(manifest.formalRecording, false);
  assert.ok(!op.manifest.includes(f.sourcePath)); assert.ok(!op.manifest.includes('private-source'));
});

test('同一 operation_id 只能重用相同意图；同内容不同角色只占一个对象', async t => {
  const f = await setup(t);
  assert.deepEqual(await createArchiveOperation(f.archive, f.operation.id, [f.input], f.lineage), f.operation);
  await assert.rejects(createArchiveOperation(f.archive, f.operation.id, [{ ...f.input, name: 'changed.wav' }], f.lineage));
  for (const op of [f.operation, await createArchiveOperation(f.archive, randomUUID(), [f.input, { ...f.input, role: 'raw-render', name: 'Original.wav' }], f.lineage)]) {
    await stageArchiveOperation(op, f.signal); await verifyArchiveStaging(op, f.signal); await promoteArchiveOperation(op, f.signal); await markArchivePhase(op, 'DB_COMMITTED'); await finalizeArchiveOperation(op, f.signal);
  }
  assert.deepEqual(await readdir(f.archive.objects.path), [f.input.sha256]);
});

test('部分复制失败保留现场；同一意图恢复不覆盖半成品或重新写原件', async t => {
  const f = await setup(t); let partial = '';
  await assert.rejects(stageArchiveOperation(f.operation, f.signal, { copy: async (_root, _relative, _expected, target) => {
    await target.writeFile('partial'); partial = (await readdir(f.operation.staging.path))[0]!; throw Object.assign(new Error('合成磁盘满'), { code: 'ENOSPC' });
  } }));
  assert.deepEqual(await readdir(f.archive.objects.path), []); assert.equal(await readFile(path.join(f.operation.staging.path, partial), 'utf8'), 'partial');
  await stageArchiveOperation(f.operation, f.signal); await verifyArchiveStaging(f.operation, f.signal); await promoteArchiveOperation(f.operation, f.signal); await markArchivePhase(f.operation, 'DB_COMMITTED'); await finalizeArchiveOperation(f.operation, f.signal);
  assert.equal(await readFile(path.join(f.operation.staging.path, partial), 'utf8'), 'partial');
});

test('Hash 或格式错误不发布；损坏的已有对象不会被新副本覆盖', async t => {
  const f = await setup(t);
  const wrong = await createArchiveOperation(f.archive, randomUUID(), [{ ...f.input, sha256: 'a'.repeat(64) }], f.lineage);
  await assert.rejects(stageArchiveOperation(wrong, f.signal)); assert.deepEqual(await readdir(f.archive.objects.path), []);
  const nonAudio = Buffer.from('not audio'), nonAudioFile = path.join(f.sourcePath, 'not.wav'); await writeFile(nonAudioFile, nonAudio);
  const invalid = await createArchiveOperation(f.archive, randomUUID(), [{ ...f.input, relative: 'not.wav', sha256: createHash('sha256').update(nonAudio).digest('hex'), size: nonAudio.length }], f.lineage);
  await stageArchiveOperation(invalid, f.signal); await assert.rejects(verifyArchiveStaging(invalid, f.signal));
  await stageArchiveOperation(f.operation, f.signal); await verifyArchiveStaging(f.operation, f.signal);
  const object = archiveObjectPath(f.archive, f.input.sha256), corrupt = Buffer.from(f.bytes); corrupt[44] = 99; await writeFile(object, corrupt);
  await assert.rejects(promoteArchiveOperation(f.operation, f.signal)); assert.deepEqual(await readFile(object), corrupt);
});

test('目录离线、替换和符号链接失效；越界输入不能写意图', async t => {
  const f = await setup(t);
  await assert.rejects(createArchiveOperation(f.archive, randomUUID(), [{ ...f.input, relative: '../outside.wav' }], f.lineage));
  await assert.rejects(createArchiveOperation(f.archive, '../outside', [f.input], f.lineage));
  await assert.rejects(createArchiveOperation(f.archive, randomUUID(), [{ ...f.input, name: '/private/path.wav' }], f.lineage));
  const moved = f.archive.root.path + '.offline'; await rename(f.archive.root.path, moved);
  await assert.rejects(stageArchiveOperation(f.operation, f.signal)); await mkdir(f.archive.root.path);
  await assert.rejects(stageArchiveOperation(f.operation, f.signal)); await rm(f.archive.root.path, { recursive: true }); await rename(moved, f.archive.root.path);
  const stage = f.operation.staging.path; await rename(stage, stage + '.saved'); await symlink(stage + '.saved', stage);
  await assert.rejects(stageArchiveOperation(f.operation, f.signal));
});

test('空间不足、取消不创建暂存；复制时源被替换不会晋级', async t => {
  const f = await setup(t);
  await assert.rejects(stageArchiveOperation(f.operation, f.signal, { availableBytes: async () => 0n })); assert.deepEqual(await readdir(f.operation.staging.path), []);
  await assert.rejects(stageArchiveOperation(f.operation, AbortSignal.abort())); assert.deepEqual(await readdir(f.operation.staging.path), []);
  await assert.rejects(stageArchiveOperation(f.operation, f.signal, { copy: async (...args) => {
    const result = await copyReadonlySource(...args); await writeFile(f.file, Buffer.alloc(f.bytes.length)); return result;
  } })); assert.deepEqual(await readdir(f.archive.objects.path), []);
});

test('尚未 DB_COMMITTED 的发布不能删除暂存或 Finalize', async t => {
  const f = await setup(t); await stageArchiveOperation(f.operation, f.signal); await verifyArchiveStaging(f.operation, f.signal); await promoteArchiveOperation(f.operation, f.signal);
  await assert.rejects(finalizeArchiveOperation(f.operation, f.signal)); assert.deepEqual(await readdir(f.operation.staging.path), [f.input.sha256]);
});

test('暂存 link 后进程中断：恢复只移除同 inode 的成功副本别名，保留失败半成品', async t => {
  const f = await setup(t); await stageArchiveOperation(f.operation, f.signal);
  const { link } = await import('node:fs/promises');
  const alias = `${f.input.sha256}.partial-${randomUUID()}`;
  await link(path.join(f.operation.staging.path, f.input.sha256), path.join(f.operation.staging.path, alias));
  await stageArchiveOperation(f.operation, f.signal); await verifyArchiveStaging(f.operation, f.signal); await promoteArchiveOperation(f.operation, f.signal);
  await markArchivePhase(f.operation, 'DB_COMMITTED'); await finalizeArchiveOperation(f.operation, f.signal);
  assert.deepEqual(await readdir(f.operation.staging.path), []); assert.equal((await lstat(archiveObjectPath(f.archive, f.input.sha256))).nlink, 1);
});

test('JSON 元数据与音频采用相同事务；无效 JSON 不会进入 VERIFIED', async t => {
  const f = await setup(t);
  for (const valid of [true, false]) {
    const bytes = Buffer.from(valid ? '{"version":1,"formalRecording":false}' : '{invalid'), file = valid ? 'metadata.json' : 'invalid.json';
    await writeFile(path.join(f.sourcePath, file), bytes);
    const input = { ...f.input, role: 'metadata' as const, media: 'json' as const, name: file, relative: file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    const op = await createArchiveOperation(f.archive, randomUUID(), [f.input, input], f.lineage); await stageArchiveOperation(op, f.signal);
    if (!valid) { await assert.rejects(verifyArchiveStaging(op, f.signal)); continue; }
    await verifyArchiveStaging(op, f.signal); await promoteArchiveOperation(op, f.signal); await markArchivePhase(op, 'DB_COMMITTED'); await finalizeArchiveOperation(op, f.signal);
    assert.deepEqual(await readFile(archiveObjectPath(f.archive, input.sha256)), bytes);
  }
});
