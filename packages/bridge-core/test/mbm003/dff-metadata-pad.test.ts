import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import type { MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

// 受控合成容器经过真实新鲜 Reader/Worker 与只读 FD；不代表转换、真实曲库或听感验收。
const { createMetadataReader } = await loadFreshMetadataReader();
const fixtureDirectory = new URL('../fixtures/mbrs003/dsd/', import.meta.url);
const manifestSha256 = '8495dfc424211245b50c556eb3890a3ffd91168097ba321445acdcf28b70b7ee';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** DSDIFF ckDataSize 不计末尾零 pad；奇数 payload 必须实际占用下一字节。 */
function chunk(id: string, payload: Uint8Array): Buffer {
  assert.equal(id.length, 4);
  const header = Buffer.alloc(12);
  header.write(id, 0, 'ascii');
  header.writeBigUInt64BE(BigInt(payload.byteLength), 4);
  return Buffer.concat([header, payload, ...(payload.byteLength % 2 === 0 ? [] : [Buffer.from([0])])]);
}

function paddedVariant(base: Buffer, kind: 'compression' | 'unknown'): Buffer {
  // 输入是下方整份 manifest 锁定的旧合成原件，只复制它的原 FVER/FS/CHNL 和完整音频字节。
  assert.equal(base.subarray(0, 4).toString('ascii'), 'FRM8');
  assert.equal(base.readBigUInt64BE(4), BigInt(base.length - 12));
  assert.equal(base.subarray(12, 16).toString('ascii'), 'DSD ');
  assert.equal(base.subarray(16, 20).toString('ascii'), 'FVER');
  assert.equal(base.readBigUInt64BE(20), 4n);
  assert.equal(base.subarray(32, 36).toString('ascii'), 'PROP');
  assert.equal(base.readBigUInt64BE(36), 62n);
  assert.equal(base.subarray(44, 48).toString('ascii'), 'SND ');
  assert.equal(base.subarray(48, 52).toString('ascii'), 'FS  ');
  assert.equal(base.readBigUInt64BE(52), 4n);
  assert.equal(base.subarray(64, 68).toString('ascii'), 'CHNL');
  assert.equal(base.readBigUInt64BE(68), 10n);
  assert.equal(base.subarray(86, 90).toString('ascii'), 'CMPR');
  assert.equal(base.readBigUInt64BE(90), 8n);
  assert.equal(base.subarray(106, 110).toString('ascii'), 'DSD ');
  assert.equal(base.readBigUInt64BE(110), 8192n);
  assert.equal(base.length, 8310);

  const compressionName = Buffer.from('not compressed', 'ascii');
  assert.equal(compressionName.length, 14);
  const compressionPayload = Buffer.concat([Buffer.from('DSD ', 'ascii'), Buffer.from([14]), compressionName]);
  assert.equal(compressionPayload.length, 19);
  const compression = chunk('CMPR', compressionPayload);
  assert.equal(compression.length, 32);
  assert.equal(compression.readBigUInt64BE(4), 19n);
  assert.equal(compression[compression.length - 1], 0);
  const property = kind === 'compression'
    ? chunk('PROP', Buffer.concat([base.subarray(44, 86), compression]))
    : base.subarray(32, 106);
  const unknown = chunk('JUNK', Buffer.from('odd', 'ascii'));
  assert.equal(unknown.readBigUInt64BE(4), 3n);
  assert.equal(unknown.length, 16);
  const body = Buffer.concat([base.subarray(12, 32), property,
    ...(kind === 'unknown' ? [unknown] : []), base.subarray(106)]);
  const result = chunk('FRM8', body);
  assert.equal(result.length, base.length + (kind === 'compression' ? 12 : 16));
  assert.notEqual(sha256(result), sha256(base), '回归输入必须确实包含新奇数块，不能退回原偶数夹具。');
  assert.deepEqual(result.subarray(result.length - 8192), base.subarray(base.length - 8192), '音频 payload 原字节完整保留。');
  return result;
}

async function readPaddedVariant(t: TestContext, kind: 'compression' | 'unknown'): Promise<void> {
  const manifestUrl = new URL('manifest.json', fixtureDirectory);
  const manifestBytes = await readFile(manifestUrl);
  assert.equal(sha256(manifestBytes), manifestSha256);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    schema: string; synthetic: boolean; files: { file: string; bytes: number; sha256: string }[];
  };
  assert.equal(manifest.schema, 'mbrs003.synthetic-dsd-portable.v1');
  assert.equal(manifest.synthetic, true);
  const fixture = manifest.files.find(entry => entry.file === 'synthetic-balanced-dsd64.dff');
  assert(fixture);
  const original = new URL(fixture.file, fixtureDirectory), originalStat = await lstat(original);
  assert.equal(originalStat.isFile() && !originalStat.isSymbolicLink(), true);
  const base = await readFile(original);
  assert.equal(base.length, fixture.bytes);
  assert.equal(sha256(base), fixture.sha256);
  const bytes = paddedVariant(base, kind), digest = sha256(bytes);

  const temporary = process.env.TMPDIR;
  assert.equal(typeof temporary === 'string' && path.isAbsolute(temporary), true, 'Root 须提供批准的外置或 Hosted 私有 TMPDIR。');
  const storage = buildStoragePolicy(), parent = storage.check(temporary!, { mustExist: true });
  const parentStat = await lstat(parent);
  assert.equal(parentStat.isDirectory() && !parentStat.isSymbolicLink(), true);
  assert.equal(await realpath(parent), parent);
  assert.equal(parentStat.mode & 0o777, 0o700);
  assert.equal(typeof process.getuid, 'function');
  assert.equal(parentStat.uid, process.getuid!());
  const own = await mkdtemp(path.join(parent, 'musicbridge-mbm003-dff-pad-'));
  await chmod(own, 0o700);
  storage.check(own, { mustExist: true });
  const relative = `${kind}.dff`, file = path.join(own, relative);
  await writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
  const copied = await lstat(file);
  assert.equal(copied.nlink, 1);
  assert.equal(copied.mode & 0o777, 0o400);
  const root = { ...await authorizeSourceDirectory(own), id: randomUUID() };
  const before = await readonlySourceCandidateMetadata(root, relative), events: MetadataReaderLifecycle[] = [];
  const reader = createMetadataReader({ dsdMetadataEnabled: true, onLifecycle: event => events.push(event) });
  t.after(async () => {
    await reader.close();
    assert.equal(sha256(await readFile(file)), digest, '真实 Worker 不得更改奇数块源文件的完整字节。');
    assert.equal((await readonlySourceCandidateMetadata(root, relative)).signature, before.signature);
    assert.equal(sha256(await readFile(original)), fixture.sha256, '原冻结 DFF 不得改写。');
    assert.equal(sha256(await readFile(manifestUrl)), manifestSha256);
  });

  const result = await reader.read({ root, relative, expectedSignature: before.signature });
  assert.equal(result.status, 'ok', '合法 pad 必须经过真实解析器成功，不能以失败或裁剪标签替代。');
  if (result.status !== 'ok') throw new Error('真实 DFF Reader 未取得成功结果。');
  assert.deepEqual(result.technical, { container: 'DFF', codec: 'DSD', lossless: true, sampleRateHz: 2822400,
    channels: 2, bitsPerSample: 1, durationSeconds: 32768 / 2822400, evidence: 'bounded-parser-reported' });
  assert.equal(result.readEvidence.wholeAudioHash, false);
  assert.equal(result.readEvidence.wholeAudioDecode, false);
  assert(result.readEvidence.bytesRead < 1024, '元数据读取不得扫完整音频 payload。');
  const starts = events.filter(event => event.type === 'worker-start');
  assert.equal(starts.length, 1);
  const start = starts[0];
  assert(start && start.type === 'worker-start');
  const exited = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
  const released = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
  const completed = events.findIndex(event => event.type === 'read-complete');
  assert.equal(exited >= 0 && released > exited && completed > released, true, '真实 Worker exit 后才关闭 FD 和完成回执。');
  assert.throws(() => fstatSync(start.fd), error => (error as NodeJS.ErrnoException).code === 'EBADF');
  await reader.close();
}

test('MBM003真实DFF Worker：奇数CMPR名称与零pad保留clock、声道、时长及只读源', { timeout: 20_000 }, async t => {
  await readPaddedVariant(t, 'compression');
});

test('MBM003真实DFF Worker：奇数未知顶层chunk按物理pad跳过且完整音频事实不变', { timeout: 20_000 }, async t => {
  await readPaddedVariant(t, 'unknown');
});
