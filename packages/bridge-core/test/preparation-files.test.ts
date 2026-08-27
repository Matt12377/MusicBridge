import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, open, rm, stat, symlink, rename, realpath, chmod } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as sourceFiles from '../src/recording/source-files.js';
import * as workspaceFiles from '../src/recording/preparation-files.js';
import { randomUUID } from 'node:crypto';

type Copy = (root: sourceFiles.RootCapability, relative: string, expected: { sha256: string; size: number }, destination: FileHandle, signal: AbortSignal) => Promise<{ sha256: string; size: number }>;
function copier(): Copy { const candidate = (sourceFiles as unknown as { copyReadonlySource?: Copy }).copyReadonlySource; assert.equal(typeof candidate, 'function', '必须通过有界只读源复制器生成工作副本'); return candidate!; }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-preparation-copy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); await mkdir(source);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 53), file = path.join(source, 'track.wav'); await writeFile(file, bytes);
  const root = { ...await sourceFiles.authorizeSourceDirectory(source), id: 'root' };
  const target = path.join(dir, 'working.wav'), output = await open(target, 'wx+'); t.after(() => output.close());
  return { root, file, bytes, output, target, expected: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } };
}
test('Preparation 复制独立字节、重读输出 Hash，原件内容和修改属性保持不变', async t => {
  const copy = copier(), f = await fixture(t), before = await stat(f.file, { bigint: true });
  assert.deepEqual(await copy(f.root, 'track.wav', f.expected, f.output, new AbortController().signal), f.expected);
  assert.deepEqual(await readFile(f.target), f.bytes); assert.deepEqual(await readFile(f.file), f.bytes);
  const after = await stat(f.file, { bigint: true }), target = await stat(f.target, { bigint: true });
  assert.equal(before.mtimeNs, after.mtimeNs); assert.equal(before.ctimeNs, after.ctimeNs); assert.notEqual(target.ino, before.ino);
  await f.output.write(Buffer.from('editable'), 0, 8, 0); assert.deepEqual(await readFile(f.file), f.bytes);
});

type Owned = workspaceFiles.OwnedPreparation;
type Output = { relative: string; sha256: string; size: number };
type WorkspaceFiles = {
  authorizePreparationDestination(p: string, roots: readonly sourceFiles.RootCapability[]): Promise<Omit<sourceFiles.RootCapability, 'id'>>;
  createPreparationDirectory(destination: sourceFiles.RootCapability, id: string, format: 'cassette' | 'dat'): Promise<Owned>;
  writePreparationFile(owned: Owned, relative: string, bytes: Buffer): Promise<Output>;
  copyPreparationFile(owned: Owned, relative: string, root: sourceFiles.RootCapability, source: string, expected: { sha256: string; size: number }, signal: AbortSignal): Promise<Output>;
  publishPreparation(owned: Owned, files: readonly Output[], manifest: Buffer, signal: AbortSignal): Promise<string>;
  verifyPublishedPreparation(owned: Owned, files: readonly Output[], manifestHash: string): Promise<boolean>;
};
function workspace(): WorkspaceFiles { const candidate = workspaceFiles as unknown as WorkspaceFiles; assert.equal(typeof candidate.createPreparationDirectory, 'function', '必须实现操作独占工作目录与发布验证'); return candidate; }
test('Preparation 目标授权拒绝源目录、符号链接及目录身份置换；已有工作目录不覆盖', async t => {
  const api = workspace(), f = await fixture(t), base = await realpath(path.dirname(f.root.path));
  await assert.rejects(api.authorizePreparationDestination(f.root.path, [f.root]));
  await mkdir(path.join(f.root.path, 'inside'));
  await assert.rejects(api.authorizePreparationDestination(path.join(f.root.path, 'inside'), [f.root]));
  await symlink(base, path.join(base, 'alias')); await assert.rejects(api.authorizePreparationDestination(path.join(base, 'alias'), []));
  const destination = { ...await api.authorizePreparationDestination(base, [f.root]), id: randomUUID() }, id = randomUUID();
  const owned = await api.createPreparationDirectory(destination, id, 'cassette');
  await assert.rejects(api.createPreparationDirectory(destination, id, 'cassette'));
  await assert.rejects(api.writePreparationFile(owned, '../escape', Buffer.from('x')));
  await assert.rejects(api.writePreparationFile(owned, 'Sources/../../escape', Buffer.from('x')));
  await rename(owned.root.path, owned.root.path + '-moved'); await mkdir(owned.root.path);
  await assert.rejects(api.writePreparationFile(owned, 'Tracklist.tsv', Buffer.from('x')));
  assert.equal(await stat(owned.root.path).then(s => s.isDirectory()), true);
});
test('Preparation 发布复核所有工作副本与清单，断点恢复不依赖文件名，编辑后不再冒充原始 Hash', async t => {
  const api = workspace(), f = await fixture(t), base = await realpath(path.dirname(f.root.path));
  const destination = { ...await api.authorizePreparationDestination(base, [f.root]), id: randomUUID() };
  const owned = await api.createPreparationDirectory(destination, randomUUID(), 'cassette');
  const copy = await api.copyPreparationFile(owned, 'Sources/001.wav', f.root, 'track.wav', f.expected, new AbortController().signal);
  const tracklist = await api.writePreparationFile(owned, 'Tracklist.tsv', Buffer.from('曲目\n合成测试\n'));
  await assert.rejects(api.writePreparationFile(owned, 'Tracklist.tsv', Buffer.from('覆盖')));
  const manifest = Buffer.from(JSON.stringify({ format: 1, operationId: owned.id, files: [copy, tracklist] }));
  const hash = createHash('sha256').update(manifest).digest('hex');
  assert.equal(await api.verifyPublishedPreparation(owned, [copy, tracklist], hash), false);
  assert.equal(await api.publishPreparation(owned, [copy, tracklist], manifest, new AbortController().signal), hash);
  assert.equal(await api.verifyPublishedPreparation(owned, [copy, tracklist], hash), true);
  assert.ok((await stat(path.join(owned.root.path, 'Bounce Targets', 'A'))).isDirectory());
  await writeFile(path.join(owned.root.path, copy.relative), '用户 Logic 编辑');
  assert.equal(await api.verifyPublishedPreparation(owned, [copy, tracklist], hash), false);
  assert.deepEqual(await readFile(f.file), f.bytes);
});
test('Preparation 子目录替换为外部符号链接后立即拒绝写入，不修改链接目标', async t => {
  const api = workspace(), f = await fixture(t), base = await realpath(path.dirname(f.root.path));
  const owned = await api.createPreparationDirectory({ ...await api.authorizePreparationDestination(base, [f.root]), id: randomUUID() }, randomUUID(), 'dat');
  await rename(path.join(owned.root.path, 'Sources'), path.join(owned.root.path, 'Sources-original'));
  await symlink(f.root.path, path.join(owned.root.path, 'Sources'));
  await assert.rejects(api.copyPreparationFile(owned, 'Sources/001.wav', f.root, 'track.wav', f.expected, new AbortController().signal));
  await assert.rejects(stat(path.join(f.root.path, '001.wav')), { code: 'ENOENT' });
});
test('Preparation 实际目标目录权限失效时拒绝发布，不改写源', async t => {
  const api = workspace(), f = await fixture(t), base = await realpath(path.dirname(f.root.path));
  const owned = await api.createPreparationDirectory({ ...await api.authorizePreparationDestination(base, [f.root]), id: randomUUID() }, randomUUID(), 'dat');
  await chmod(owned.root.path, 0o000);
  try {
    await assert.rejects(api.copyPreparationFile(owned, 'Sources/001.wav', f.root, 'track.wav', f.expected, new AbortController().signal));
    assert.equal(await api.verifyPublishedPreparation(owned, [{ relative: 'Sources/001.wav', ...f.expected }], 'a'.repeat(64)), false);
    assert.deepEqual(await readFile(f.file), f.bytes);
  } finally { await chmod(owned.root.path, 0o700); }
});
test('Preparation 不接受 Hash 漂移、符号链接、外部路径、取消和已撤销源', async t => {
  const copy = copier(), f = await fixture(t);
  await assert.rejects(copy(f.root, 'track.wav', { ...f.expected, sha256: 'a'.repeat(64) }, f.output, new AbortController().signal), { code: 'HASH_MISMATCH' });
  await symlink(f.file, path.join(f.root.path, 'link.wav'));
  await assert.rejects(copy(f.root, 'link.wav', f.expected, f.output, new AbortController().signal), { code: 'OUTSIDE_ROOT' });
  await assert.rejects(copy(f.root, '../working.wav', f.expected, f.output, new AbortController().signal), { code: 'OUTSIDE_ROOT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(copy(f.root, 'track.wav', f.expected, f.output, controller.signal), { code: 'CANCELLED' });
  await assert.rejects(copy({ ...f.root, authorized: false }, 'track.wav', f.expected, f.output, new AbortController().signal), { code: 'REVOKED' });
});
test('Preparation 写入 ENOSPC、复制中取消及输出内容被篡改均不能报告已验证', async t => {
  const copy = copier(), f = await fixture(t);
  const fullDisk = new Proxy(f.output, { get(target, key) { if (key === 'write') return async () => { throw Object.assign(new Error('合成磁盘已满'), { code: 'ENOSPC' }); }; const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  await assert.rejects(copy(f.root, 'track.wav', f.expected, fullDisk, new AbortController().signal), { code: 'ENOSPC' });
  const controller = new AbortController();
  const cancelOutput = new Proxy(f.output, { get(target, key) { if (key === 'write') return async (...args: Parameters<FileHandle['write']>) => { controller.abort(); return (target.write as (...a: unknown[]) => unknown)(...args); }; const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  await assert.rejects(copy(f.root, 'track.wav', f.expected, cancelOutput, controller.signal), { code: 'CANCELLED' });
  await f.output.truncate(0);
  const corrupt = new Proxy(f.output, { get(target, key) { if (key === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => { const result = await target.read(buffer, offset, length, position); buffer[offset] = buffer[offset]! ^ 1; return result; }; const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  await assert.rejects(copy(f.root, 'track.wav', f.expected, corrupt, new AbortController().signal), { code: 'HASH_MISMATCH' });
});
