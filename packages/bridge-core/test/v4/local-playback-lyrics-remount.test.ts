import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseLocalPlaybackLrc, readLocalPlaybackLyrics } from '../../src/library/local-playback-lyrics.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { sourcePlaybackExpectedSignature } from '../../src/recording/source-remount-proof.js';
import { catalogFixture, parserVersion, readFacts } from '../mbrs006/catalog-fixture.js';
import type { ScanPreparedBatch } from '../../src/collection/local-scan-store.js';

const lrc = '[00:01.00]合成第一行\n[00:03.00]合成第二行';
test('LRC常见id/length/language/tool元信息不应使整份同步正文失效', () => {
  for (const header of ['[id:$00000000]', '[ID:synthetic]', '[length:03:30]', '[language:zh-Hans]', '[tool:synthetic]']) {
    const snapshot = parseLocalPlaybackLrc(Buffer.from(`${header}\n[ti:合成曲目]\n${lrc}`));
    assert.equal(snapshot.status, 'ready', header); assert.equal(snapshot.lines.length, 2); assert.equal(snapshot.source, undefined);
  }
});
test('LRC元信息兼容不放宽坏offset/时间戳/纯文本/编码/控制符或来源身份', () => {
  for (const body of ['[offset:not-a-number]\n'+lrc, '[offset:1]\n[offset:2]\n'+lrc, '[00:60.00]错误', '[00:01.00]正常\n无时间戳正文', '[source:netease]\n'+lrc, '[id:x]\n只有纯文本', '[id:x]\n[00:01.00]坏\0正文']) {
    assert.equal(parseLocalPlaybackLrc(Buffer.from(body)).status, 'unavailable');
  }
  assert.equal(parseLocalPlaybackLrc(Buffer.from([0xff, 0xfe, 0x61])).status, 'unavailable');
  const shifted = parseLocalPlaybackLrc(Buffer.from(`[id:x]\n[offset:+125]\n${lrc}`));
  assert.equal(shifted.status, 'ready'); assert.equal(shifted.lines[0]?.startMs, 1125); assert.equal(shifted.source, undefined);
});

async function remounted(t: TestContext, version: 1 | 2) {
  const original = await catalogFixture(t), media = path.join(original.directory, '合成重挂载媒体');
  await mkdir(media); await writeFile(path.join(media, '一.wav'), original.bytes);
  const f = { ...original, media }, actual = await authorizeSourceDirectory(media);
  const source = f.repository.sources.authorize(randomUUID(), { ...actual, dev: (BigInt(actual.dev)+19n).toString() });
  const root = f.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const relative = '一.wav', file = path.join(f.media, relative), stat = await lstat(file, { bigint: true });
  const signature = [source.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const started = f.repository.localScan.start({ commandId: randomUUID(), datasetId: f.datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job;
  const job = f.repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision });
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
    items: [{ relative, signature, parserVersion, outcome: 'accepted', fields: { title: '合成重挂载曲目', artist: '合成作者' }, failureCode: null, reused: false, readFacts }], frontier: [], completed: true };
  f.repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch });
  f.repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision });
  f.repository.sources.privateReauthorizeRemount(randomUUID(), source, { ...source, dev: actual.dev }, 'a'.repeat(64), version === 2 ? 'b'.repeat(64) : undefined);
  const track = f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items.find(track => f.repository.localCatalog.asset(track.assetId).libraryRootId === root.id)!;
  const request = { ...f.requests[0]!, request_id: randomUUID(), local_track_id: track.id, asset_id: track.assetId, expected_asset_revision: f.repository.localCatalog.asset(track.assetId).fileRevision };
  await writeFile(path.join(f.media, '一.lrc'), lrc);
  const captured = f.tickets.capture(request);
  return { ...f, captured, file, signature };
}
for (const version of [1, 2] as const) test(`原Owner票据在SMB重挂载v${version}后仍优先旁置歌词，保留历史签名且不读音频正文`, async t => {
  const f = await remounted(t, version), facts = structuredClone(f.captured.facts), before = await readFile(f.file);
  assert.notEqual(sourcePlaybackExpectedSignature(facts.sourceRoot, f.signature), f.signature);
  const result = await f.tickets.readLyrics(f.captured.ticketId);
  assert.equal(result.status, 'ready'); assert.equal(result.lines.length, 2); assert.equal(result.source, undefined);
  assert.deepEqual(f.captured.facts, facts, '不可改写Owner原观察或历史签名'); assert.deepEqual(await readFile(f.file), before);
  f.tickets.release(f.captured.ticketId);
});
test('歌词重挂载只复用有效原证明，不能放宽剩余四字段、根绑定、撤权或过期票据', async t => {
  const f = await remounted(t, 2), original = f.captured.facts;
  for (const index of [1, 2, 3, 4]) {
    const facts = structuredClone(original), pieces = facts.observation!.signature.split(':'); pieces[index] = (BigInt(pieces[index]!)+1n).toString(); facts.observation!.signature = pieces.join(':');
    assert.equal((await readLocalPlaybackLyrics(facts, new AbortController().signal, () => {})).status, 'unavailable');
  }
  for (const key of ['id', 'path', 'ino'] as const) {
    const facts = structuredClone(original); facts.sourceRoot[key] += '-other';
    assert.equal((await readLocalPlaybackLyrics(facts, new AbortController().signal, () => {})).status, 'unavailable');
  }
  const unproved = structuredClone(original); delete unproved.sourceRoot.readonlyRemountProof;
  assert.equal((await readLocalPlaybackLyrics(unproved, new AbortController().signal, () => {})).status, 'unavailable');
  const revoked = structuredClone(original); revoked.sourceRoot.authorized = false;
  assert.equal((await readLocalPlaybackLyrics(revoked, new AbortController().signal, () => {})).status, 'unavailable');
  assert.equal((await readLocalPlaybackLyrics(original, new AbortController().signal, () => { throw new Error('stale'); })).status, 'unavailable');
  await writeFile(f.file, Buffer.from('changed synthetic file'));
  assert.equal((await f.tickets.readLyrics(f.captured.ticketId)).status, 'unavailable');
  f.tickets.release(f.captured.ticketId);
});
