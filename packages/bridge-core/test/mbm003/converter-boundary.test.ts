import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { constants } from 'node:fs';
import { open, writeFile, readFile } from 'node:fs/promises';
import { backendFixture, hash } from './fixture-helpers.js';

test('MBM003实际最高DSD时钟与六声道：DSF两种packing均完整转换为同六声道24/48，来源仍1-bit', { timeout: 45_000 }, async t => {
  const f = await backendFixture(t);
  for (const packing of [1, 8]) {
    const bytes = Buffer.alloc(92 + 16_384 * 6, 0x69);
    f.originals.get('dsf')!.copy(bytes, 0, 0, 92);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 12);
    bytes.writeUInt32LE(7, 48); bytes.writeUInt32LE(6, 52);
    bytes.writeUInt32LE(24_576_000, 56); bytes.writeUInt32LE(packing, 60);
    bytes.writeBigUInt64LE(131_072n, 64); bytes.writeBigUInt64LE(BigInt(bytes.length - 80), 84);
    const relative = `six-${packing}.dsf`, sourcePath = path.join(f.media, relative);
    await writeFile(sourcePath, bytes, { flag: 'wx', mode: 0o600 });
    const observed = await f.core.files.readonlySourceCandidateMetadata(f.root, relative);
    const source = await f.core.converter.openMobileDsdSource({ root: f.root, relative, signature: observed.signature,
      datasetId: f.datasetId, identity: hash(bytes), assertCurrent: f.assertCurrent,
      sourceAudio: { codec: 'dsd', container: 'dsf', sampleRateHz: 24_576_000, bitsPerSample: 1, channels: 6 } }, new AbortController().signal);
    f.onClose(() => f.core.converter.closeMobileDsdSource(source));
    const target = path.join(f.directory, `six-${packing}.flac`);
    const writer = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { await f.converter.convert(source, writer, f.assertCurrent, 128 * 1024); await writer.sync(); } finally { await writer.close(); }
    const reader = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const result = await f.converter.verifyOutput(reader, source, f.assertCurrent, 128 * 1024);
      assert.deepEqual(result.actualAudio, { codec: 'flac', container: 'flac', sampleRateHz: 48_000, bitsPerSample: 24, channels: 6 });
      assert.ok(result.samples >= 256 && result.samples <= 257);
      assert.equal(source.sourceAudio.bitsPerSample, 1);
    } finally { await reader.close(); }
    assert.deepEqual(await readFile(sourcePath), bytes);
  }
  await f.unchanged(); await f.close();
});
