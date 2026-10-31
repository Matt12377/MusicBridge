import { constants } from 'node:fs';
import { lstat, open, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import cueBeforePack from './native-cue-package.mjs';

const fail = () => { throw new Error('Rust媒体处理资源缺失或与编译身份不一致，请重新构建开发版。'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'nlink'];
async function regular(file, limit) {
  const named = await lstat(file, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size < 1n || named.size > BigInt(limit)
    || (named.mode & 0o7022n) !== 0n || await realpath(file) !== file) fail();
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    if (identity.some(key => before[key] !== named[key])) fail();
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) { const next = await fd.read(bytes, offset, bytes.length - offset, offset); if (!next.bytesRead) fail(); offset += next.bytesRead; }
    const after = await fd.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (identity.some(key => before[key] !== after[key] || before[key] !== current[key])) fail();
    return bytes;
  } finally { await fd.close(); }
}
export async function captureNativeMediaWorker(appDirectory, { requireRelease = true } = {}) {
  const root = path.join(appDirectory, 'native', 'media-worker', `${process.platform}-${process.arch}`);
  const manifest = JSON.parse((await regular(path.join(root, 'manifest.json'), 16 * 1024)).toString('utf8'));
  const binary = manifest?.binary;
  const buildProfile = manifest.buildProfile === undefined ? 'release' : manifest.buildProfile;
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1 || manifest.parserVersion !== 'musicbridge-rust-media/v1'
    || !['release', 'development'].includes(buildProfile)
    || manifest.platform !== process.platform || manifest.arch !== process.arch || binary?.relativePath !== 'bin/musicbridge-media-worker'
    || typeof binary.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(binary.sha256) || !Number.isSafeInteger(binary.size)) fail();
  const bytes = await regular(path.join(root, binary.relativePath), 96 * 1024 * 1024);
  if (bytes.length !== binary.size || digest(bytes) !== binary.sha256) fail();
  if (requireRelease && buildProfile !== 'release') throw new Error('开发版媒体 Worker 不能进入正式安装包，请先执行正式构建。');
  return { schemaVersion: 1, protocolVersion: 1, binarySha256: binary.sha256, platform: process.platform, arch: process.arch };
}
export default async function beforePack(context) {
  await cueBeforePack(context);
  const directory = await realpath(context.packager.info.appDir), actual = await captureNativeMediaWorker(directory);
  const compiled = JSON.parse(await readFile(path.join(directory, 'dist', 'main', 'media-worker-build.json'), 'utf8'));
  if (JSON.stringify(compiled) !== JSON.stringify(actual)) fail();
}
