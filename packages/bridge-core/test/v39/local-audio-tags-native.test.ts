import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { authorizeSourceDirectory, copyReadonlySource, withVerifiedReadonlySource } from '../../src/recording/source-files.js';
import { createCueNativeActor, loadBundledCueConverter } from '../../src/library/bundled-cue-converter.js';
import { createLocalAudioTagsActor, loadLocalAudioTagsBundle, type LocalAudioTagValues } from '../../src/library/local-audio-tags-actor.js';
import { createCueSyntheticWave, CUE_SYNTHETIC_ARTWORK, nativeEvidencePin, mergeNativeEvidence, rawReceipt } from '../../src/library/local-cue-format-qualification.js';

test('真实WAV和FLAC保护副本只嵌入所选歌词，保留原音频、未选标签和图片并闭合SourceFiles许可', { skip: process.platform !== 'darwin' }, async () => {
  const cueRoot = process.env.MB_V39_CUE_BUNDLE, tagsRoot = process.env.MB_V39_TAGS_BUNDLE, evidenceRoot = process.env.MB_V39_NATIVE_PROOF_DIR;
  assert.ok(cueRoot && tagsRoot && evidenceRoot, '当前Native包与独立证据根必须存在，不能缺失后跳过。');
  const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
  const cue = createCueNativeActor(await loadBundledCueConverter(cueRoot, process.env.MB_V39_CUE_MANIFEST_SHA256 ?? digest(await readFile(path.join(cueRoot, 'manifest.json')))));
  const tags = createLocalAudioTagsActor(await loadLocalAudioTagsBundle(tagsRoot, process.env.MB_V39_TAGS_MANIFEST_SHA256 ?? digest(await readFile(path.join(tagsRoot, 'manifest.json')))));
  const directory = path.join(evidenceRoot, 'tags'), sources = path.join(directory, 'sources');
  await mkdir(directory, { mode: 0o700 }); await mkdir(sources, { mode: 0o700 });
  const fixture = createCueSyntheticWave(), seedPath = path.join(directory, 'seed.wav');
  await writeFile(seedPath, fixture.wave, { flag: 'wx', mode: 0o600 });
  const closed: FileHandle[] = [], proof: Record<string, unknown> = {};
  let physicalReads = 0;
  const close = async (handle: FileHandle): Promise<void> => { await handle.close(); closed.push(handle); };
  try {
    for (const format of ['wav', 'flac'] as const) {
      const tagFormat = format === 'wav' ? 'pcm-wav' : 'flac', commandId = randomUUID(), claimId = randomUUID();
      const current = path.join(directory, format); await mkdir(current, { mode: 0o700 });
      const sourcePath = path.join(sources, '原始.' + format), source = await open(sourcePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const sourceCheck = async (): Promise<void> => { const value = await source.stat(); assert.equal(value.isFile(), true); assert.equal(value.nlink, 1); };
      try {
        if (format === 'wav') await source.writeFile(fixture.wave);
        else {
          const seed = await open(seedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const encoded = await cue.encode({ source: seed, target: source, demuxer: 'wav', format: 'flac', startFrame: 0, frameCount: fixture.frames,
              sampleRate: fixture.sampleRate, channels: fixture.channels, sourceClaim: { commandId, claimId, assertCurrent: async () => { await seed.stat(); } },
              targetClaim: { commandId, claimId, assertCurrent: sourceCheck } });
            await rawReceipt(current, 'seed-encode', encoded, evidenceRoot);
          } finally { await close(seed); }
        }
        const old: LocalAudioTagValues = { TITLE: '未选择的曲名：雪', ARTIST: '艺术家 Δ', ALBUM: '原始专辑', DATE: '2001', DISCNUMBER: '2', TRACKNUMBER: '3',
          LYRICS: '[00:00.00]原歌词\n', PICTURE: CUE_SYNTHETIC_ARTWORK };
        await rawReceipt(current, 'seed-tags', await tags.run({ fd: source.fd, commandId, claimId, assertCurrent: sourceCheck }, tagFormat, old), evidenceRoot);
      } finally { await close(source); }
      const input = await nativeEvidencePin(sourcePath, evidenceRoot), capability = { ...await authorizeSourceDirectory(sources), id: randomUUID() };
      const outputPath = path.join(current, '受保护副本.' + format), beforePath = path.join(current, 'before.s32le'), afterPath = path.join(current, 'after.s32le');
      const copy = await open(outputPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const before = await open(beforePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const after = await open(afterPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const copyIdentity = await copy.stat({ bigint: true });
      const assertOriginal = async (): Promise<void> => { assert.deepEqual(await nativeEvidencePin(sourcePath, evidenceRoot), input); };
      const assertCopy = async (): Promise<void> => { await assertOriginal(); const value = await copy.stat({ bigint: true });
        assert.equal(value.dev, copyIdentity.dev); assert.equal(value.ino, copyIdentity.ino); assert.equal(value.nlink, 1n); };
      try {
        await copyReadonlySource(capability, path.basename(sourcePath), { sha256: input.sha256, size: input.bytes }, copy, new AbortController().signal);
        await withVerifiedReadonlySource(capability, path.basename(sourcePath), { sha256: input.sha256, size: input.bytes }, new AbortController().signal, async (handle, check) => {
          physicalReads++; closed.push(handle);
          try { check(); await rawReceipt(current, 'decode-before', await cue.decode(handle, before, format, { commandId, claimId, assertCurrent: assertOriginal }), evidenceRoot); }
          finally { physicalReads--; }
        });
        const selected = '[00:00.00]所选歌词\n[00:00.25]日本語の歌詞\n';
        await rawReceipt(current, 'write-selected', await tags.run({ fd: copy.fd, commandId, claimId, assertCurrent: assertCopy }, tagFormat, { LYRICS: selected }), evidenceRoot);
        const readback = await tags.run({ fd: copy.fd, commandId, claimId, assertCurrent: assertCopy }, tagFormat, null);
        const raw = await rawReceipt(current, 'read-selected', readback, evidenceRoot);
        assert.deepEqual(readback.values, { TITLE: '未选择的曲名：雪', ARTIST: '艺术家 Δ', ALBUM: '原始专辑', DATE: '2001', DISCNUMBER: '2', TRACKNUMBER: '3',
          LYRICS: selected, PICTURE: digest(Buffer.from(CUE_SYNTHETIC_ARTWORK, 'base64')) });
        const reread = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await rawReceipt(current, 'decode-after', await cue.decode(reread, after, format, { commandId, claimId, assertCurrent: assertCopy }), evidenceRoot); }
        finally { await close(reread); }
        const previousPcm = await readFile(beforePath), currentPcm = await readFile(afterPath);
        assert.deepEqual(previousPcm, fixture.pcm); assert.deepEqual(currentPcm, previousPcm); await assertOriginal();
        proof[format] = { input, output: await nativeEvidencePin(outputPath, evidenceRoot), decodedBefore: await nativeEvidencePin(beforePath, evidenceRoot),
          decodedAfter: await nativeEvidencePin(afterPath, evidenceRoot), expectedFrames: fixture.frames, decodedFrames: currentPcm.length / (fixture.channels * 4),
          audioUnchanged: true, unselectedMetadataUnchanged: true, rereadVerified: true, sourceUnchanged: true, raw,
          selectedLyricsSha256: digest(Buffer.from(selected)), physicalClosure: { fdsClosed: true, processesClosed: true, claimsReleased: true } };
      } finally {
        await tags.join(commandId); await cue.join(commandId); await close(copy); await close(before); await close(after);
      }
    }
  } finally { await tags.close(); await cue.close(); }
  for (const handle of closed) await assert.rejects(handle.stat(), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
  assert.equal(physicalReads, 0); assert.equal(tags.inspect().running, 0); assert.equal(cue.inspect().running, 0);
  await mergeNativeEvidence(evidenceRoot, { lyricsProtectedCopy: proof });
});
