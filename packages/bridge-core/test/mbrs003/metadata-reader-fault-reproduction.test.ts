import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { MetadataReaderLifecycle, MetadataReadInput } from '../../src/library/metadata-reader-types.js';
import { readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

// 新独立leaf须由root批准后在独立test进程运行；不与原20case共享built-in mock。
async function request(f: Awaited<ReturnType<typeof audioFixture>>, relative: string): Promise<MetadataReadInput> {
  return { root: f.root, relative, expectedSignature: (await readonlySourceCandidateMetadata(f.root, relative)).signature };
}
function ebadf(fd: number): boolean {
  try { fstatSync(fd); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EBADF'; }
}
test('MBRS003 fault完整FLAC metadata加仅两音频sync字节不得假成功', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), { createMetadataReader } = await loadFreshMetadataReader();
  const source = await f.bytes('core-flac');
  assert.equal(source.subarray(0, 4).toString('ascii'), 'fLaC', '夹具必须是真实FLAC');
  let offset = 4, last = false;
  while (!last) {
    assert.equal(offset + 4 <= source.length, true, '派生准备必须完整保留metadata');
    last = (source[offset]! & 0x80) !== 0;
    const length = source.readUIntBE(offset + 1, 3);
    assert.equal(offset + 4 + length <= source.length, true);
    offset += 4 + length;
  }
  assert.equal(offset + 2 < source.length, true, '原件必须有完整音频帧后继字节');
  assert.equal(source[offset], 0xff); assert.equal((source[offset + 1]! & 0xfe) === 0xf8, true);
  const derived = source.subarray(0, offset + 2), relative = 'fixtures/derived-flac-metadata-two-sync-only.flac';
  const target = path.join(f.directory, relative);
  await fsPromises.writeFile(target, derived, { flag: 'wx', mode: 0o600 });
  const info = await fsPromises.lstat(target); assert.equal(info.nlink, 1); assert.equal(info.mode & 0o777, 0o600);
  assert.equal(derived.length - offset, 2); assert.equal(derived.subarray(0, offset).equals(source.subarray(0, offset)), true);
  const reader = createMetadataReader(); t.after(() => reader.close());
  const control = await reader.read(await request(f, f.entry('core-flac').file)); assert.equal(control.status, 'ok');
  const result = await reader.read(await request(f, relative));
  assert.equal(result.status, 'failure', '完整标签头不能代替完整音频frame可读性');
  if (result.status === 'failure') assert.equal(['PARSE_FAILED', 'UNSUPPORTED'].includes(result.code), true);
  assert.equal((await fsPromises.readFile(target)).equals(derived), true); await f.assertUnchanged();
});
test('MBRS003 fault父FD关闭前EIO必须使close拒绝，不能已完成但仍留开FD', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), target = f.file('core-flac'), input = await request(f, f.entry('core-flac').file);
  const events: MetadataReaderLifecycle[] = [];
  let ownedHandle: FileHandle | undefined, realClose: (() => Promise<void>) | undefined, injected = 0;
  const originalOpen = fsPromises.open;
  const openMock = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target) {
      assert.equal(ownedHandle, undefined, '只允许目标reader原FD被注入一次');
      ownedHandle = handle; realClose = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        ++injected;
        const error = new Error('合成FD关闭前EIO');
        Object.assign(error, { code: 'EIO' }); throw error;
      });
    }
    return handle;
  });
  // Node built-in命名导出绑定同步；若该版本不支持则注入计数为0，必须归准备失败，不冒产品RED。
  syncBuiltinESMExports();
  let reader: ReturnType<(typeof import('../../src/library/metadata-reader.js'))['createMetadataReader']> | undefined;
  try {
    const { createMetadataReader } = await loadFreshMetadataReader();
    reader = createMetadataReader({ onLifecycle: event => events.push(event) });
    const result = await reader.read(input);
    assert.equal(injected, 1, 'PREPARATION_FAILED: 必须实际命中目标FileHandle.close前注入');
    assert.ok(ownedHandle); const fd = ownedHandle.fd;
    assert.equal(result.status, 'failure'); if (result.status === 'failure') assert.equal(result.code, 'LEASE_RELEASE_FAILED');
    assert.equal(events.some(event => event.type === 'worker-exit' && event.fd === fd), true);
    assert.equal(fstatSync(fd).isFile(), true, '控制EIO发生在真实close前：原FD必须仍有效');
    assert.equal(ebadf(fd), false);
    let rejected = false;
    try { await reader.close(); } catch { rejected = true; }
    assert.equal(rejected, true, 'close必须保留lease释放失败fatal，不可假称全部已关闭');
  } finally {
    // 不让合成故障真的泄漏FD：绕过mock，调用原FileHandle.close并立即核EBADF。
    if (ownedHandle && realClose) {
      const fd = ownedHandle.fd; await realClose(); assert.equal(ebadf(fd), true, '结束时必须真实关闭目标FD');
    }
    openMock.mock.restore(); syncBuiltinESMExports();
    if (reader) await reader.close().catch(() => undefined);
  }
  await f.assertUnchanged();
});
