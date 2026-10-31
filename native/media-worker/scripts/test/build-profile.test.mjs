import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { captureNativeMediaWorker } from '../../../../apps/desktop/scripts/native-media-worker-package.mjs';

function fixture(buildProfile) {
  const policy = buildStoragePolicy();
  const parent = policy.hosted ? policy.root : policy.check(process.env.TMPDIR, { mustExist: true });
  const app = fs.mkdtempSync(path.join(parent, 'musicbridge-media-profile-test-'));
  const root = path.join(app, 'native/media-worker', `${process.platform}-${process.arch}`);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const bytes = Buffer.from('合成媒体 Worker，仅验证构建资格');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(root, 'bin/musicbridge-media-worker'), bytes, { mode: 0o755 });
  const manifest = {
    schemaVersion: 1, protocolVersion: 1, parserVersion: 'musicbridge-rust-media/v1',
    platform: process.platform, arch: process.arch,
    binary: { relativePath: 'bin/musicbridge-media-worker', size: bytes.length, sha256 },
    ...(buildProfile === undefined ? {} : { buildProfile }),
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return { app, sha256, cleanup() { fs.rmSync(app, { recursive: true }); } };
}

test('Release 和历史媒体 Worker 保持正式构建资格', async () => {
  for (const profile of [undefined, 'release']) {
    const f = fixture(profile);
    try { assert.equal((await captureNativeMediaWorker(f.app)).binarySha256, f.sha256); }
    finally { f.cleanup(); }
  }
});

test('开发媒体 Worker 可用于开发构建，但正式打包必须拒绝', async () => {
  const f = fixture('development');
  try {
    assert.equal((await captureNativeMediaWorker(f.app, { requireRelease: false })).binarySha256, f.sha256);
    await assert.rejects(captureNativeMediaWorker(f.app), /开发.*正式安装包/u);
  } finally { f.cleanup(); }
});

test('未知媒体 Worker 构建档位不能被默认当成 Release', async () => {
  for (const profile of [null, 'debug', '']) {
    const f = fixture(profile);
    try { await assert.rejects(captureNativeMediaWorker(f.app, { requireRelease: false }), /缺失或与编译身份不一致/u); }
    finally { f.cleanup(); }
  }
});
