import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { writeSourceTagRegion, type SourceRegionChange } from '../../src/collection/source-write-format.js';
import { observeSourceWriteFile, verifySourceWriteResult, type SourceWriteFileObservation } from '../../src/collection/source-write-verify.js';
import { readSourceFullRaw } from '../../src/collection/source-write-metadata.js';
import type { ScanReadFacts } from '../../src/collection/local-scan-facts.js';

const fixtures = new URL('../fixtures/mbrs012-source/', import.meta.url);
async function fixture(file: string): Promise<Buffer> {
  const manifestBytes = await readFile(new URL('manifest.json', fixtures));
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), '5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    synthetic: boolean; allContentOwned: boolean; realLibraryUsed: boolean;
    files: { file: string; bytes: number; sha256: string }[];
  };
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.allContentOwned, true);
  assert.equal(manifest.realLibraryUsed, false);
  const entry = manifest.files.find(value => value.file === file);
  assert.ok(entry);
  const bytes = await readFile(new URL(file, fixtures));
  assert.equal(bytes.length, entry.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  return bytes;
}

async function observe(file: string): Promise<SourceWriteFileObservation> {
  const handle = await open(file, 'r');
  try { return await observeSourceWriteFile(handle); }
  finally { await handle.close(); }
}

async function owned(file: string) {
  const storage = buildStoragePolicy();
  const temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'mbrs012-metadata-'));
  storage.check(directory, { mustExist: true });
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o777, 0o700);
  const bytes = await fixture(file);
  const beforeFile = path.join(directory, `before-${file}`);
  await writeFile(beforeFile, bytes, { flag: 'wx', mode: 0o600 });
  const before = await observe(beforeFile);
  // 此合成先前 facts 仅验证纯解析函数的保留语义；不代表真实扫描或 Owner 事务。
  const prior: ScanReadFacts = {
    technical: {
      container: file.endsWith('.flac') ? 'FLAC' : 'MPEG',
      codec: file.endsWith('.flac') ? 'FLAC' : 'MPEG 1 Layer 3',
      lossless: file.endsWith('.flac'), sampleRateHz: 48000, channels: 2,
      bitsPerSample: file.endsWith('.flac') ? 16 : null, durationSeconds: 1,
      evidence: 'bounded-parser-reported',
    },
    coverEvidence: [],
    readEvidence: {
      bytesRead: 0, readCalls: 0, maxReadBytes: 0, allocationBytes: 0, elapsedMs: 0,
      wholeAudioHash: false, wholeAudioDecode: false,
    },
  };
  let ordinal = 0;
  async function change(previous: SourceWriteFileObservation, originalBytes: Buffer, value: SourceRegionChange) {
    const region = writeSourceTagRegion(previous.prefix, previous.bytes, value);
    const afterFile = path.join(directory, `after-${++ordinal}-${file}`);
    const written = Buffer.concat([region.bytes, originalBytes.subarray(previous.audioStart)]);
    await writeFile(afterFile, written, { flag: 'wx', mode: 0o600 });
    const after = await observe(afterFile);
    verifySourceWriteResult(previous, after, value);
    assert.equal(after.audioStart, previous.audioStart);
    assert.equal(after.audioPayloadSha256, previous.audioPayloadSha256);
    return { after, written, afterFile };
  }
  return { directory, bytes, before, prior, change };
}

for (const file of ['owned-stereo-fixed-tags.flac', 'owned-stereo-id3v240.mp3']) {
  const format = file.endsWith('.flac') ? 'FLAC' : 'MP3';
  test(`012 ${format} 实际写后前区回读保留六字段与合法碟号0，显式移除后不复活原字段`, async t => {
    const input = await owned(file);
    const fields = {
      title: { action: 'set', value: '完整字段新标题' },
      artist: { action: 'set', value: '新艺人' },
      album: { action: 'set', value: '新专辑' },
      year: { action: 'set', value: '2024' },
      disc: { action: 'set', value: '0' },
      track: { action: 'set', value: '100000' },
    } as const;
    const changed = await input.change(input.before, input.bytes, { fields });
    const actual = await readSourceFullRaw(changed.after, input.prior);
    assert.deepEqual(actual.fullRaw, { title: '完整字段新标题', artist: '新艺人', album: '新专辑', year: '2024', disc: '0', track: '100000' });
    assert.deepEqual(actual.readFacts.technical, input.prior.technical);
    assert.deepEqual(actual.readFacts.readEvidence, input.prior.readEvidence);
    assert.notEqual(actual.readFacts.technical, input.prior.technical);
    const removed = await input.change(changed.after, changed.written, {
      fields: { title: { action: 'remove' }, artist: { action: 'remove' }, album: { action: 'remove' }, year: { action: 'remove' }, disc: { action: 'remove' }, track: { action: 'remove' } },
    });
    assert.deepEqual((await readSourceFullRaw(removed.after, actual.readFacts)).fullRaw, {});
    t.diagnostic(`实际前区及原payload保留：${input.directory}`);
  });

  test(`012 ${format} 合法碟号/曲号0及四位年份前导零不被第三方归一化为缺失`, async () => {
    const input = await owned(file);
    const changed = await input.change(input.before, input.bytes, {
      fields: { year: { action: 'set', value: '0000' }, disc: { action: 'set', value: '0' }, track: { action: 'set', value: '0' } },
    });
    const { fullRaw } = await readSourceFullRaw(changed.after, input.prior);
    assert.equal(fullRaw.year, '0000');
    assert.equal(fullRaw.disc, '0');
    assert.equal(fullRaw.track, '0');
    assert.equal(fullRaw.title, '合成写回样本');
    assert.equal(fullRaw.artist, '测试艺人');
    assert.equal(fullRaw.album, '有限写回测试');
  });

  for (const [imageFile, mime] of [['owned-cover-16.png', 'image/png'], ['owned-cover-16.jpg', 'image/jpeg']] as const) {
    test(`012 ${format} 原始${mime}封面前区回读保留实际Hash/字节和未选标签`, async () => {
      const input = await owned(file), bytes = await fixture(imageFile);
      const changed = await input.change(input.before, input.bytes, { frontImage: { mime, width: 16, height: 16, depth: 24, bytes } });
      const { fullRaw, readFacts } = await readSourceFullRaw(changed.after, input.prior);
      assert.deepEqual(fullRaw, { title: '合成写回样本', artist: '测试艺人', album: '有限写回测试', year: '2026', disc: '1', track: '2' });
      assert.deepEqual(readFacts.coverEvidence, [{ mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), evidence: 'encoded-bytes-magic-and-digest' }]);
      assert.deepEqual(input.prior.coverEvidence, []);
    });
  }
}
