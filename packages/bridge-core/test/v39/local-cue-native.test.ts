import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { qualifyCueEightFormats, readCueQualifiedFormats, mergeNativeEvidence, nativeEvidencePin, CUE_SYNTHETIC_ARTWORK, type NativeEvidencePin } from '../../src/library/local-cue-format-qualification.js';

test('CUE八族实际编码、Unicode标签与图片、无损等值及有损质量、完整解码EOF和物理关闭', { skip: process.platform !== 'darwin' }, async () => {
  const cueRoot = process.env.MB_V39_CUE_BUNDLE, tagsRoot = process.env.MB_V39_TAGS_BUNDLE, evidenceRoot = process.env.MB_V39_NATIVE_PROOF_DIR;
  assert.ok(cueRoot && tagsRoot && evidenceRoot, 'Native域必须给出当前实际包和新证据根，不允许缺失后跳过。');
  for (const root of [cueRoot, tagsRoot, evidenceRoot]) { assert.ok(path.isAbsolute(root)); assert.equal(await realpath(root), root); assert.ok((await lstat(root)).isDirectory()); }
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const cueManifestSha256 = process.env.MB_V39_CUE_MANIFEST_SHA256 ?? digest(await readFile(path.join(cueRoot, 'manifest.json')));
  const tagsManifestSha256 = process.env.MB_V39_TAGS_MANIFEST_SHA256 ?? digest(await readFile(path.join(tagsRoot, 'manifest.json')));
  const result = await qualifyCueEightFormats({ cueRoot, cueManifestSha256, tagsRoot, tagsManifestSha256, evidenceRoot });
  assert.equal(result.formats.length, 8); assert.equal(result.formats.reduce((count, format) => count + format.variants.length + 1, 0), 14);
  for (const format of result.formats.flatMap(item => [item, ...item.variants])) {
    assert.equal(format.expectedFrames, format.decodedFrames); assert.equal(format.eof, true); assert.equal(format.sourceUnchanged, true);
    assert.equal(format.encode.exitCode, 0); assert.equal(format.decode.exitCode, 0); assert.equal(format.physicalClosure.fdsClosed, true);
    assert.deepEqual(format.tagsActual, format.tagsExpected);
  }
  const ordinaryPcm = 'bbbf3baab8a5dc22f0ccabe9c9e753a0ec5a58713d6eab66ea37813498a1625a', mpcPcm = '34f5b6601130398b4dd9a44a820c92a954f343cb6eac3deb37661cee6d79b16a';
  const rareExpected = [
    ['ape', 'ape', 'ape', 's16p', 88200, 92, 'b4d4e23ee608da258989f3e70c4be37f7a31aa181cadd9acbf916d0947aad817', ordinaryPcm],
    ['tta', 'tta', 'tta', 's16', 88200, 22340, 'ca8d9aeb8dc9263b3626f92889b9b83bb717a04de736df9bcf54df89d2e44ff1', ordinaryPcm],
    ['mpc7', 'mpc', 'musepack7', 's16p', 88704, 296, 'c29d774d9b41a528e18d97f8fe93ee0f1cd3491a44be01a2c945212eb788ca53', mpcPcm],
    ['mpc8', 'mpc8', 'musepack8', 's16p', 88704, 329, '21a69cd960c73dd700fbb84dfd6fbf68d6483bb733fcdadea6626b2c5319d1bf', mpcPcm],
    ['tak', 'tak', 'tak', 's16p', 88200, 702, '7f75925778cc641df2e94d40c030d59a08957a932bcd3bffcaf8fc3c9b85b0d2', ordinaryPcm],
  ] as const;
  const labels = ['source-probe', 'source-decode', 'flac-encode', 'tags-write', 'tags-read', 'flac-probe', 'flac-decode'];
  const expectedTags = { TITLE: '合成冷门编码静音：雪と花', ARTIST: '合成艺术家 Δ', ALBUM: '独立FLAC回退：测试', DATE: '2026', DISCNUMBER: '2', TRACKNUMBER: '3',
    LYRICS: '[00:00.00]中文歌词\n[00:00.25]日本語の歌詞\n', PICTURE: digest(Buffer.from(CUE_SYNTHETIC_ARTWORK, 'base64')) };
  const checkPin = async (pin: NativeEvidencePin): Promise<Buffer> => {
    assert.equal(path.isAbsolute(pin.path), false); assert.ok(pin.path.startsWith('cue/rare-inputs/')); assert.ok(!pin.path.split('/').includes('..'));
    assert.deepEqual(await nativeEvidencePin(path.join(evidenceRoot, pin.path), evidenceRoot), { path: pin.path, bytes: pin.bytes, sha256: pin.sha256 });
    return readFile(path.join(evidenceRoot, pin.path));
  };
  assert.equal(result.rareInputs.length, 5); assert.deepEqual(result.rareInputs.map(row => row.id), rareExpected.map(row => row[0]));
  for (let index = 0; index < rareExpected.length; index++) {
    const row = result.rareInputs[index]!, [id, demuxer, codec, sampleFormat, frames, bytes, sourceSha, pcmSha] = rareExpected[index]!;
    assert.deepEqual([row.id, row.demuxer, row.codec, row.sampleFormat, row.bitsPerSample], [id, demuxer, codec, sampleFormat, 16]);
    assert.equal(row.sampleRate, 44100); assert.equal(row.channels, 2); assert.equal(row.expectedFrames, frames); assert.equal(row.decodedFrames, frames);
    assert.equal(row.eof, true); assert.equal(row.exactPcm, true); assert.equal(row.sourceUnchanged, true);
    assert.equal(row.input.bytes, bytes); assert.equal(row.input.sha256, sourceSha); assert.deepEqual(row.inputAfter, row.input);
    assert.deepEqual(row.sourceStatAfter, row.sourceStatBefore); assert.deepEqual(Object.keys(row.sourceStatBefore).sort(), ['dev','ino','size','mode','nlink','uid','gid','mtimeNs','ctimeNs'].sort());
    assert.equal(BigInt(row.sourceStatBefore.mode) & 0o777n, 0o600n); assert.equal(row.sourceStatBefore.nlink, '1');
    assert.equal(row.sourceStatBefore.size, String(bytes)); await checkPin(row.input);
    assert.equal(row.oracle.encoding, 's32le'); assert.equal(row.oracle.origin, 'mathematical-synthetic-zero-pcm'); assert.equal(row.oracle.nativeDecoded, false);
    const oracle = await checkPin(row.oracle), decoded = await checkPin(row.decoded), outputDecoded = await checkPin(row.outputDecoded);
    for (const pin of [row.oracle, row.decoded, row.outputDecoded]) { assert.equal(pin.bytes, frames * 2 * 4); assert.equal(pin.sha256, pcmSha); }
    assert.ok(oracle.every(value => value === 0)); assert.deepEqual(decoded, oracle); assert.deepEqual(outputDecoded, decoded);
    assert.notEqual(row.oracle.path, row.decoded.path); assert.notEqual(row.decoded.path, row.outputDecoded.path); assert.notEqual(row.output.path, row.input.path);
    assert.equal(path.extname(row.output.path), '.flac'); await checkPin(row.output);
    assert.deepEqual(row.flac, { format: 'flac', profile: 's24', codec: 'flac', sampleFormat: 's32', bitsPerSample: 24,
      frames, decodedFrames: frames, sampleRate: 44100, channels: 2, eof: true, exactPcm: true });
    assert.deepEqual(row.tagsExpected, expectedTags); assert.deepEqual(row.tagsActual, expectedTags);
    assert.equal(Object.keys(row.tagsActual).length, 8); assert.deepEqual(row.operations.map(op => op.label), labels);
    for (const operation of row.operations) {
      assert.equal(operation.exitCode, 0); assert.equal(operation.signal, null); assert.equal(operation.pidClosed, true); assert.equal(operation.pidObservedAbsent, true);
      assert.equal(operation.freshSourceFd, true); assert.equal(operation.sourceFdClosed, true);
      assert.equal(operation.actorFdsClosed, operation.label.startsWith('tags-') ? true : null);
      const raw = JSON.parse((await checkPin(operation.raw)).toString('utf8')) as Record<string, unknown>;
      assert.deepEqual(raw, { exitCode: 0, signal: null, pid: operation.pid, pidClosed: true, stdout: operation.raw.stdout, stderr: operation.raw.stderr });
      const stdout = await checkPin(operation.raw.stdout); await checkPin(operation.raw.stderr); await checkPin(operation.sourceBefore); await checkPin(operation.sourceAfter);
      if (operation.label !== 'tags-write') { assert.deepEqual(operation.sourceAfter, operation.sourceBefore); assert.deepEqual(operation.sourceStatAfter, operation.sourceStatBefore); }
      else { assert.equal(path.basename(operation.sourceBefore.path), 'flac-before-tags.flac'); assert.equal(operation.sourceAfter.path, row.output.path); }
      if (['source-probe', 'source-decode', 'flac-encode'].includes(operation.label)) assert.deepEqual(operation.sourceBefore, row.input);
      if (operation.label.endsWith('-probe')) {
        const lines = stdout.toString('utf8').split('\n').filter(Boolean), stream = lines.filter(line => line.startsWith('stream|'));
        assert.equal(stream.length, 1); assert.ok(stream[0]!.includes('codec_name=' + (operation.label === 'source-probe' ? codec : 'flac') + '|'));
        assert.equal(lines.filter(line => line.startsWith('frame|')).reduce((count, line) => count + Number(/(?:^|\|)nb_samples=(\d+)(?:\||$)/u.exec(line)?.[1]), 0), frames);
      }
      for (const pid of [operation.pid, -operation.pid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    const closure = row.physicalClosure; assert.equal(closure.fdsClosed, true); assert.equal(closure.processesClosed, true); assert.equal(closure.claimsReleased, true);
    assert.equal(closure.revokedClaimsRejected, true); assert.equal(closure.observedPidsAbsent, 7); assert.equal(closure.fdChecks.length, 11);
    assert.deepEqual(closure.fdChecks.map(fd => fd.label).sort(), [...labels.map(label => label + '-source'), 'source-anchor', 'source-decoded-target', 'flac-target', 'flac-decoded-target'].sort());
    assert.ok(closure.fdChecks.every(fd => fd.error === 'EBADF' && Number.isSafeInteger(fd.fd) && fd.fd >= 0));
    for (const actor of Object.values(closure.actorSnapshots)) { assert.equal(actor.running, 0); assert.equal(actor.unverified, 0); assert.deepEqual(actor.pids, []); }
    const { raw: closureRaw, ...closureBody } = closure; assert.deepEqual(JSON.parse((await checkPin(closureRaw)).toString('utf8')), closureBody);
    const { raw: rowRaw, ...rowBody } = row; assert.deepEqual(JSON.parse((await checkPin(rowRaw)).toString('utf8')), { schema: 'musicbridge.v39.cue-rare-input.evidence.v1', ...rowBody });
  }
  // 数学 oracle、复制 proof 或缺一个输入族的普通对象都不能取得原 WeakSet 品牌。
  assert.throws(() => readCueQualifiedFormats({ ...result, rareInputs: result.rareInputs.slice(0, 4) }), /必须先取得/u);
  assert.throws(() => readCueQualifiedFormats(structuredClone(result)), /必须先取得/u);

  const capabilities = readCueQualifiedFormats(result); assert.equal(capabilities.length, 8); assert.ok(capabilities.every(format => format.available));
  const sourceSha = process.env.MB_V39_SOURCE_SHA, scopeSha256 = process.env.MB_V39_SCOPE_SHA256;
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u); assert.match(scopeSha256 ?? '', /^[a-f0-9]{64}$/u);
  await mergeNativeEvidence(evidenceRoot, { schema: 'musicbridge.v39.integration002.native-proof.v1', task: 'V39-INTEGRATION-002', sourceSha, scopeSha256,
    platform: process.platform, architecture: process.arch, bundles: result.bundles, formats: result.formats, rareInputs: result.rareInputs, physicalClosure: result.physicalClosure });
});
