import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, realpath, open, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-output-pin-')));
  await mkdir(path.join(root, 'bin')); await mkdir(path.join(root, 'build'));
  const helper = path.join(root, 'bin/output-helper'), hal = path.join(root, 'build/core-audio-adapter.o');
  await writeFile(helper, '仅供固定构建验证的合成字节', { mode: 0o700 }); await writeFile(hal, '合成object字节', { mode: 0o600 });
  const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.1.0', mode: 'synthetic-only', files: { helper: { path: 'bin/output-helper', sha256: sha(await readFile(helper)) }, halAdapter: { path: 'build/core-audio-adapter.o', sha256: sha(await readFile(hal)) } }, sourceSha256: 'a'.repeat(64) };
  const manifestPath = path.join(root, 'manifest.json'); const bytes = JSON.stringify(manifest); await writeFile(manifestPath, bytes, { mode: 0o600 });
  return { root, helper, hal, manifest, manifestPath, pin: sha(bytes) };
}
const load = () => import('../src/recording/bundled-output-helper.js');
test('固定输出包只接受应用编译期清单pin，加载不执行helper', async () => {
  const { loadBundledOutputHelper, verifyPinnedOutputHelper } = await load(); const f = await fixture();
  assert.equal(await loadBundledOutputHelper(f.root, null), undefined);
  const pin = await loadBundledOutputHelper(f.root, f.pin); assert.ok(pin); assert.equal(pin.sha256, f.manifest.files.helper.sha256); assert.equal(pin.path, f.helper); await verifyPinnedOutputHelper(pin);
});
test('旁边清单与binary同时改写不能自证新构建，已加载pin每次运行前复核', async () => {
  const { loadBundledOutputHelper, verifyPinnedOutputHelper } = await load(); const f = await fixture(); const pin = (await loadBundledOutputHelper(f.root, f.pin))!;
  await writeFile(f.helper, '被替换的合成helper'); f.manifest.files.helper.sha256 = sha(await readFile(f.helper)); await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(loadBundledOutputHelper(f.root, f.pin)); await assert.rejects(verifyPinnedOutputHelper(pin));
});
test('HAL object缺失或变化、非固定文件路径、symlink和可写权限均拒绝', async () => {
  const { loadBundledOutputHelper } = await load();
  const modified = await fixture(); await writeFile(modified.hal, '改变'); await assert.rejects(loadBundledOutputHelper(modified.root, modified.pin));
  const traversal = await fixture(); traversal.manifest.files.helper.path = '../other'; const bytes = JSON.stringify(traversal.manifest); await writeFile(traversal.manifestPath, bytes); await assert.rejects(loadBundledOutputHelper(traversal.root, sha(bytes)));
  const permissions = await fixture(); await chmod(permissions.helper, 0o777); await assert.rejects(loadBundledOutputHelper(permissions.root, permissions.pin));
  const linked = await fixture(); const link = linked.root + '-link'; await symlink(linked.root, link); await assert.rejects(loadBundledOutputHelper(link, linked.pin));
});
test('读取期间父目录被替换时，旧FD内容正确也不能认证同名新helper', async (t) => {
  const { loadBundledOutputHelper } = await load(); const f = await fixture();
  const originalBytes = await readFile(f.helper); const probe = await open(f.helper, 'r');
  const prototype = Object.getPrototypeOf(probe) as typeof probe;
  const originalRead = prototype.read; await probe.close(); let swapped = false;
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: Parameters<typeof originalRead>) {
    const result = await Reflect.apply(originalRead, this, args);
    if (!swapped && result.buffer.subarray(0, result.bytesRead).equals(originalBytes)) {
      swapped = true;
      await rename(path.join(f.root, 'bin'), path.join(f.root, 'old-bin'));
      await mkdir(path.join(f.root, 'bin'));
      await writeFile(f.helper, '同路径未认证的新helper', { mode: 0o700 });
    }
    return result;
  });
  await assert.rejects(loadBundledOutputHelper(f.root, f.pin));
  assert.equal(swapped, true);
});
