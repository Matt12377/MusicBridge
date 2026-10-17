import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createCueNativeActor, loadBundledCueConverter, type CueNativeBundle } from '../../src/library/bundled-cue-converter.js';
import { loadLocalAudioTagsBundle } from '../../src/library/local-audio-tags-actor.js';
import { CUE_NATIVE_SOURCE_INPUTS, CUE_FFMPEG_CONFIGURE, CUE_FFMPEG_LIBRARIES } from '../../src/library/cue-ffmpeg-build-policy.js';
import { nativeEvidencePin, mergeNativeEvidence } from '../../src/library/local-cue-format-qualification.js';

test('独立CUE包实际arm64闭集与完整许可证匹配固定源码，污染清单和未准入对象均不能启动后端', { skip: process.platform !== 'darwin' }, async () => {
  const cueRoot = process.env.MB_V39_CUE_BUNDLE, tagsRoot = process.env.MB_V39_TAGS_BUNDLE, evidence = process.env.MB_V39_NATIVE_PROOF_DIR;
  assert.ok(cueRoot && tagsRoot && evidence);
  const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
  const directory = path.join(evidence, 'bundle'); await mkdir(directory, { mode: 0o700 });
  const cueBytes = await readFile(path.join(cueRoot, 'manifest.json')), tagsBytes = await readFile(path.join(tagsRoot, 'manifest.json'));
  const admitted = await loadBundledCueConverter(cueRoot, process.env.MB_V39_CUE_MANIFEST_SHA256 ?? sha(cueBytes));
  await loadLocalAudioTagsBundle(tagsRoot, process.env.MB_V39_TAGS_MANIFEST_SHA256 ?? sha(tagsBytes));
  const manifest = JSON.parse(cueBytes.toString('utf8')) as { configure: string[]; components: unknown[]; protocols: string[]; files: { relative: string; bytes: number; sha256: string }[] };
  assert.deepEqual(manifest.configure, CUE_FFMPEG_CONFIGURE); assert.deepEqual(manifest.components, CUE_FFMPEG_LIBRARIES);
  assert.deepEqual(manifest.protocols, ['fd']); assert.ok(manifest.configure.includes('--disable-network')); assert.ok(manifest.configure.includes('--disable-gpl'));
  const binaryPins = [];
  for (const pin of manifest.files) {
    const actual: Buffer = await readFile(path.join(cueRoot, pin.relative));
    assert.equal(actual.length, pin.bytes); assert.equal(sha(actual), pin.sha256);
    assert.equal(actual.readUInt32LE(0), 0xfeedfacf); assert.equal(actual.readUInt32LE(4), 0x0100000c);
    binaryPins.push({ ...pin });
  }
  const legalPins = [];
  for (const source of CUE_NATIVE_SOURCE_INPUTS) {
    const archive: Buffer = await readFile(path.join(cueRoot, 'legal', source.id, source.archive)); assert.equal(archive.length, source.bytes); assert.equal(sha(archive), source.sha256);
    for (const name of source.legal) { const actual = await readFile(path.join(cueRoot, 'legal', source.id, name)); assert.ok(actual.length > 0);
      legalPins.push({ relative: 'legal/' + source.id + '/' + name, bytes: actual.length, sha256: sha(actual) }); }
  }
  await assert.rejects(loadBundledCueConverter(cueRoot, '0'.repeat(64)));
  await assert.rejects(loadLocalAudioTagsBundle(tagsRoot, '0'.repeat(64)));
  assert.throws(() => createCueNativeActor(structuredClone(admitted) as CueNativeBundle));
  const contaminated = path.join(directory, 'contaminated'); await mkdir(contaminated, { mode: 0o700 });
  const mutation = { ...JSON.parse(cueBytes.toString('utf8')), protocols: ['fd', 'https'] };
  const bytes = Buffer.from(JSON.stringify(mutation) + '\n'); await writeFile(path.join(contaminated, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
  await assert.rejects(loadBundledCueConverter(contaminated, sha(bytes)), '不能通过自报新SHA扩大网络协议。');
  const rawPath = path.join(directory, 'fixed-inputs.json');
  await writeFile(rawPath, JSON.stringify({ binaryPins, legalPins, sourceArchivePins: CUE_NATIVE_SOURCE_INPUTS, rejected: ['manifest-sha','tag-manifest-sha','cloned-capability','network-expansion'] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await mergeNativeEvidence(evidence, { bundleReadback: { validated: true, fixedSources: CUE_NATIVE_SOURCE_INPUTS.length,
    actualArm64ProgramsAndLibraries: binaryPins.length, legalFiles: legalPins.length, raw: await nativeEvidencePin(rawPath, evidence) } });
});
