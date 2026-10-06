import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { MasterDraft, MediaLayoutSpec, SourceBinding } from '@music-bridge/contracts';
import type { MetadataReadResult, MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import { readonlySourceCandidateMetadata, probeReadonlySource, SourceFileError } from '../../src/recording/source-files.js';
import { planVersions } from '../../src/recording/version-planner.js';
import { audioFixture, coreAudioIds, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const { createMetadataReader } = await loadFreshMetadataReader();

type Fixture = Awaited<ReturnType<typeof audioFixture>>;
const ok = (result: MetadataReadResult): Extract<MetadataReadResult, { status: 'ok' }> => {
  assert.equal(result.status, 'ok', '真实reader必须产生成功事实');
  if (result.status !== 'ok') assert.fail('reader未产生成功事实');
  return result;
};
async function read(reader: MetadataReaderPort, f: Fixture, id: string): Promise<MetadataReadResult> {
  const relative = f.entry(id).file;
  const expectedSignature = (await readonlySourceCandidateMetadata(f.root, relative)).signature;
  return reader.read({ root: f.root, relative, expectedSignature });
}
const containers = ['FLAC', 'MPEG', 'MP4', 'MP4', 'WAVE', 'AIFF'] as const;
for (const [index, id] of coreAudioIds.entries()) {
  test(`MBRS003 reader真实读取 ${id}：标签与技术事实不依赖扩展名`, { timeout: 20_000 }, async t => {
    const f = await audioFixture(t), reader = createMetadataReader(); t.after(() => reader.close());
    const result = ok(await read(reader, f, id)), fixture = f.entry(id);
    assert.deepEqual(result.fields, fixture.expectedTags);
    assert.equal(result.technical.container, containers[index]);
    assert.equal(result.technical.codec.length > 0, true);
    assert.equal(result.technical.sampleRateHz, 44100); assert.equal(result.technical.channels, 2);
    assert.equal(result.technical.lossless, !['core-mp3', 'core-m4a-aac'].includes(id));
    assert.equal(result.technical.durationSeconds !== null && result.technical.durationSeconds >= 0.3 && result.technical.durationSeconds <= 0.55, true);
    assert.equal(result.technical.evidence, 'bounded-parser-reported');
    assert.equal(result.readEvidence.wholeAudioHash, false); assert.equal(result.readEvidence.wholeAudioDecode, false);
    assert.equal(result.readEvidence.readCalls > 0 && result.readEvidence.bytesRead > 0 && result.readEvidence.bytesRead <= 32 * 1024 * 1024, true);
    if (id === 'core-flac') assert.deepEqual(result.coverEvidence, [{ mime: 'image/png', bytes: 681,
      sha256: '243ddd560483dfae4f0ac0cce1e922a7828baab254b6df5d3402d0fec4f06e45', evidence: 'encoded-bytes-magic-and-digest' }]);
    else assert.deepEqual(result.coverEvidence, []);
    await f.assertUnchanged();
  });
}
test('MBRS003 reader错mp3扩展名仍按真实FLAC字节读取', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), reader = createMetadataReader(); t.after(() => reader.close());
  const source = ok(await read(reader, f, 'core-flac')), renamed = ok(await read(reader, f, 'wrong-extension'));
  assert.deepEqual(renamed.fields, source.fields); assert.deepEqual(renamed.technical, source.technical);
  assert.deepEqual(renamed.coverEvidence, source.coverEvidence); await f.assertUnchanged();
});
test('MBRS003 reader截断与假FLAC均不能产生成功，坏文件不阻止下一合法读取', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), reader = createMetadataReader(); t.after(() => reader.close());
  for (const id of ['truncated-flac', 'invalid-magic']) {
    const result = await read(reader, f, id); assert.equal(result.status, 'failure');
    if (result.status === 'failure') assert.equal(['PARSE_FAILED', 'UNSUPPORTED'].includes(result.code), true);
  }
  assert.equal(ok(await read(reader, f, 'core-flac')).technical.sampleRateHz, 44100); await f.assertUnchanged();
});
test('MBRS003 reader原始文本4096完整保留而4097拒绝，不冒公开catalog512字符准入', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), reader = createMetadataReader({ trustedBudget: { textFieldBytes: 4096 } }); t.after(() => reader.close());
  const result = ok(await read(reader, f, 'tag-limit'));
  assert.equal(result.fields.title, 'T'.repeat(4096)); assert.equal(Buffer.byteLength(result.fields.title!), 4096);
  // 这是私有raw标签边界，不能当LocalMetadata已导入或公开512字符合同通过。
  const over = await read(reader, f, 'tag-over'); assert.equal(over.status, 'failure');
  if (over.status === 'failure') assert.equal(over.code, 'BUDGET_EXCEEDED'); await f.assertUnchanged();
});
test('MBRS003 reader可信封面profile65536/65537按真实嵌图bytes判界，默认4MiB仍接受65537', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), limited = createMetadataReader({ trustedBudget: { coverBytes: 65536 } }); t.after(() => limited.close());
  const at = ok(await read(limited, f, 'cover-limit-flac'));
  assert.deepEqual(at.coverEvidence, [{ mime: 'image/png', bytes: 65536,
    sha256: '50a1b8b40470ebaaad40b59faf293cda7bb9735a27ccc57774c4f4d1e6035f97', evidence: 'encoded-bytes-magic-and-digest' }]);
  const over = await read(limited, f, 'cover-over-flac'); assert.equal(over.status, 'failure');
  if (over.status === 'failure') assert.equal(over.code, 'BUDGET_EXCEEDED');
  const normal = createMetadataReader(); t.after(() => normal.close());
  assert.deepEqual(ok(await read(normal, f, 'cover-over-flac')).coverEvidence, [{ mime: 'image/png', bytes: 65537,
    sha256: 'b3eae1e07aa423f998e2e7e05d2a6ab4f89a5ebcd97821987e6225c280d4584c', evidence: 'encoded-bytes-magic-and-digest' }]);
  await f.assertUnchanged();
});
test('MBRS003 reader实际读取预算越界拒绝且同源正常预算成功', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), limited = createMetadataReader({ trustedBudget: { totalReadBytes: 64 } }); t.after(() => limited.close());
  const result = await read(limited, f, 'core-flac'); assert.equal(result.status, 'failure');
  if (result.status === 'failure') {
    assert.equal(result.code, 'BUDGET_EXCEEDED'); assert.notEqual(result.readEvidence, null);
    assert.equal(result.readEvidence!.bytesRead <= 64, true);
  }
  const normal = createMetadataReader(); t.after(() => normal.close());
  assert.equal(ok(await read(normal, f, 'core-flac')).technical.container, 'FLAC'); await f.assertUnchanged();
});
test('MBRS003 reader可索引MP3但原录音严格probe仍拒绝；FLAC旧probe保留完整Hash', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), reader = createMetadataReader(); t.after(() => reader.close());
  assert.equal(ok(await read(reader, f, 'core-mp3')).technical.lossless, false);
  await assert.rejects(probeReadonlySource(f.root, f.entry('core-mp3').file, new AbortController().signal),
    error => error instanceof SourceFileError && error.code === 'UNSUPPORTED');
  const evidence = await probeReadonlySource(f.root, f.entry('core-flac').file, new AbortController().signal);
  assert.equal(evidence.sha256, f.entry('core-flac').sha256); assert.equal(evidence.size, f.entry('core-flac').bytes);
  assert.equal(evidence.technical.lossless, true); assert.equal(evidence.technical.frameEvidence, 'container-declared');
  assert.equal(evidence.technical.sampleFrames! > 0, true); await f.assertUnchanged();
});
test('MBRS003 普通metadata成功不取得SourceLock冻结资格，真实严格证据仍需显式确认', { timeout: 20_000 }, async t => {
  const f = await audioFixture(t), reader = createMetadataReader(); t.after(() => reader.close());
  const raw = ok(await read(reader, f, 'core-flac')), trackId = randomUUID();
  const draft: MasterDraft = { id: randomUUID(), title: '隔离SourceLock验证', programType: 'compilation', revision: 1,
    status: 'draft', sourceLockEligible: false, trackCount: 1, tracks: [{ id: trackId, source: 'roon', metadata: { title: raw.fields.title! } }] };
  const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 0, rules: [],
    compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true } };
  assert.throws(() => planVersions(draft, [{ trackId, jobs: [] }], spec, 44100, 1));
  const e = await probeReadonlySource(f.root, f.entry('core-flac').file, new AbortController().signal);
  const binding: SourceBinding = { id: randomUUID(), rootId: f.root.id, fileName: 'core-flac.flac', acquisition: 'userFileBind',
    verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability: 'ONLINE', sha256: e.sha256, size: e.size,
    modifiedAt: e.modifiedAt, verifiedAt: e.verifiedAt, technical: e.technical, userConfirmed: false, sourceLockEligible: false };
  assert.throws(() => planVersions(draft, [{ trackId, binding, jobs: [] }], spec, 44100, 1));
  const confirmed = { ...binding, userConfirmed: true, sourceLockEligible: true };
  const plan = planVersions(draft, [{ trackId, binding: confirmed, jobs: [] }], spec, 44100, 1);
  assert.equal(plan.content.tracks[0]!.source.sha256, f.entry('core-flac').sha256);
  assert.equal(plan.executionReady, false); await f.assertUnchanged();
});
