import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MobileTrackSelection } from '@music-bridge/contracts';
import { createMobileContentLocalLyrics, MOBILE_LOCAL_LYRICS_MAX_SOURCE_BYTES } from '../../src/mobile/content-local-lyrics.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';
import { ownerFixture } from './content-owner-fixture.js';

type Fixture = Awaited<ReturnType<typeof ownerFixture>>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sidecar = (f: Fixture) => path.join(f.disc, 'source.lrc');
const readerFor = (f: Fixture) => createMobileContentLocalLyrics({ collection: f.repository, datasetId: f.datasetId, assertCurrent: f.assertCurrent });
const read = (f: Fixture, signal = new AbortController().signal) => readerFor(f).read(f.selection, f.track, f.detail, signal);
function rejected(code: MobileServiceError['code'], status: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.code, code);
    assert.equal(error.status, status); assert.equal(error.retryable, false); return true;
  };
}
async function sourceUnchanged(f: Fixture): Promise<void> {
  assert.equal(hash(await readFile(f.file)), hash(f.original));
}

// 以下媒体由原 Scanner/fresh Worker 得到真实观察，.lrc 是夹具自己写的受控旁件。
// 同进程 FD/SQLite 证据不代表普通 App、真实用户歌词、账号或手机验收。
test('本地歌词：精确同stem完整LRC保留重复时间戳并按时间排序，源媒体不写入', async t => {
  const f = await ownerFixture(t), bytes = Buffer.from('[ar:自有夹具]\n[00:02.50]晚一句\n[00:00.00][00:01.25]早一句\n', 'utf8');
  await writeFile(sidecar(f), bytes, { flag: 'wx', mode: 0o600 });
  const baseline = physicalResourceLocks.combinedSnapshot(), proof = await read(f);
  assert.equal(proof.lyrics.status, 'ready'); assert.equal(proof.lyrics.synchronized, true);
  assert.deepEqual(proof.lyrics.lines.map(row => [row.startMs, row.text]), [[0, '早一句'], [1250, '早一句'], [2500, '晚一句']]);
  assert.equal(new Set(proof.lyrics.lines.map(row => row.id)).size, 3);
  await proof.beforeSend(); assert.deepEqual(await readFile(sidecar(f)), bytes); await sourceUnchanged(f);
  assert.deepEqual(physicalResourceLocks.combinedSnapshot(), baseline, '完整读和发送前重读均已释放真实物理/命名保护。');
});

test('本地歌词：plain歌词不造时间轴或instrumental，完整原bytes决定lyricRevision', async t => {
  const f = await ownerFixture(t), file = sidecar(f);
  await writeFile(file, '第一句\n第二句\n', { flag: 'wx', mode: 0o600 });
  const first = await read(f); assert.equal(first.lyrics.status, 'ready'); assert.equal(first.lyrics.synchronized, false);
  assert.deepEqual(first.lyrics.lines.map(row => row.text), ['第一句', '第二句']);
  assert.ok(first.lyrics.lines.every(row => row.startMs === undefined));
  if (first.lyrics.status !== 'ready') throw new Error('完整原歌词未返回 ready。');
  await writeFile(file, '第一句\r\n第二句\r\n');
  const second = await read(f); assert.equal(second.lyrics.status, 'ready');
  if (second.lyrics.status !== 'ready') throw new Error('完整新歌词未返回 ready。');
  assert.notEqual(first.lyrics.lyricRevision, second.lyrics.lyricRevision, '正文相同但完整侧车bytes不同，不能共用修订。');
  await assert.rejects(first.beforeSend(), rejected('SOURCE_CHANGED', 409)); await sourceUnchanged(f);
});

test('本地歌词：授权目录中精确旁件缺失才missing，其他同名或其他stem不作回填', async t => {
  const f = await ownerFixture(t);
  await writeFile(path.join(f.media, 'source.lrc'), '[00:00]错误目录的同名歌词', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(f.disc, 'other.lrc'), '[00:00]错误stem歌词', { flag: 'wx', mode: 0o600 });
  const baseline = physicalResourceLocks.combinedSnapshot(), missing = await read(f);
  assert.equal(missing.lyrics.status, 'missing'); assert.equal(missing.lyrics.synchronized, false);
  assert.deepEqual(missing.lyrics.lines, []); await missing.beforeSend();
  await writeFile(sidecar(f), '精确原件出现了', { flag: 'wx', mode: 0o600 });
  await assert.rejects(missing.beforeSend(), rejected('SOURCE_CHANGED', 409));
  assert.deepEqual(physicalResourceLocks.combinedSnapshot(), baseline); await sourceUnchanged(f);
});

test('本地歌词：坏UTF8空文件混合行坏时间戳与取消整体失败，绝不伪missing', async t => {
  const f = await ownerFixture(t), file = sidecar(f), baseline = physicalResourceLocks.combinedSnapshot();
  const invalid = [Buffer.from([0xc3, 0x28]), Buffer.alloc(0), Buffer.from('[00:00]一句\n无时间戳的下一句'),
    Buffer.from('[00:60]错误秒数'), Buffer.from('[unknown:value]'), Buffer.from('[ar:只有元数据]'), Buffer.from('正文\u0000坏控制字符')];
  for (const bytes of invalid) {
    await writeFile(file, bytes, { mode: 0o600 });
    await assert.rejects(read(f), rejected('BUSY', 503));
    assert.deepEqual(physicalResourceLocks.combinedSnapshot(), baseline, '失败不能残留上一轮原件FD的读保护。');
  }
  await writeFile(file, '可读但已经取消'); const controller = new AbortController(); controller.abort();
  await assert.rejects(read(f, controller.signal), rejected('BUSY', 503));
  assert.deepEqual(physicalResourceLocks.combinedSnapshot(), baseline); await sourceUnchanged(f);
});

test('本地歌词：UTF8单行4096与2000行及整件1MiB边界各自执行，超界不截断', async t => {
  const f = await ownerFixture(t), file = sidecar(f), baseline = physicalResourceLocks.combinedSnapshot();
  const exactLine = '词'.repeat(1365) + 'a'; assert.equal(Buffer.byteLength(exactLine), 4096);
  await writeFile(file, exactLine, { flag: 'wx', mode: 0o600 });
  assert.equal((await read(f)).lyrics.lines[0]?.text, exactLine);
  await writeFile(file, exactLine + 'a'); await assert.rejects(read(f), rejected('CONTENT_LIMIT_EXCEEDED', 503));
  await writeFile(file, Array.from({ length: 2000 }, (_, i) => `原词${i}`).join('\n'));
  assert.equal((await read(f)).lyrics.lines.length, 2000);
  await writeFile(file, Array.from({ length: 2001 }, (_, i) => `原词${i}`).join('\n'));
  await assert.rejects(read(f), rejected('CONTENT_LIMIT_EXCEEDED', 503));
  const base = '[ar:]\n原词', exact = `[ar:${'a'.repeat(MOBILE_LOCAL_LYRICS_MAX_SOURCE_BYTES - Buffer.byteLength(base))}]\n原词`;
  assert.equal(Buffer.byteLength(exact), MOBILE_LOCAL_LYRICS_MAX_SOURCE_BYTES);
  await writeFile(file, exact); assert.deepEqual((await read(f)).lyrics.lines.map(row => row.text), ['原词']);
  await writeFile(file, exact + '\n'); await assert.rejects(read(f), rejected('CONTENT_LIMIT_EXCEEDED', 503));
  assert.deepEqual(physicalResourceLocks.combinedSnapshot(), baseline); await sourceUnchanged(f);
});

test('本地歌词：符号链接硬链接与父目录替换拒绝，复原后可读且原保护quiet', async t => {
  const f = await ownerFixture(t), file = sidecar(f), candidate = path.join(f.directory, 'self-owned.lrc');
  const baseline = physicalResourceLocks.combinedSnapshot();
  await writeFile(candidate, '自有精确歌词', { flag: 'wx', mode: 0o600 });
  await symlink(candidate, file); await assert.rejects(read(f), rejected('BUSY', 503)); await rm(file);
  await link(candidate, file); await assert.rejects(read(f), rejected('BUSY', 503)); await rm(file);
  await writeFile(file, '真正独立旁件', { flag: 'wx', mode: 0o600 });
  const proof = await read(f), moved = path.join(f.media, 'disc-retained');
  await rename(f.disc, moved);
  try {
    await mkdir(f.disc, { mode: 0o700 }); await writeFile(f.file, f.original, { flag: 'wx', mode: 0o600 });
    await writeFile(file, '替换目录的新旁件', { flag: 'wx', mode: 0o600 });
    await assert.rejects(proof.beforeSend(), rejected('SOURCE_CHANGED', 409));
  } finally { await rm(f.disc, { recursive: true }); await rename(moved, f.disc); }
  // rename会改变某些平台的文件ctime；此处只核原源bytes与全部实际保护已quiet，不据恢复路径造扫描资格。
  assert.deepEqual(physicalResourceLocks.combinedSnapshot(), baseline); await sourceUnchanged(f);
});

test('本地歌词：Owner发送前重核原侧车与媒体signature，关闭后不能输出旧歌词', async t => {
  const f = await ownerFixture(t), file = sidecar(f);
  await writeFile(file, '[00:00]初始完整歌词', { flag: 'wx', mode: 0o600 });
  const first = await f.dispatch({ action: 'local-lyrics', scope: f.scope, selection: f.selection });
  assert.equal(first.kind, 'content-lyrics'); if (first.kind !== 'content-lyrics') throw new Error('缺少真实Owner歌词快照。');
  await writeFile(file, '[00:00]侧车改变');
  const changed = await f.dispatch({ action: 'revalidate', scope: f.scope, snapshotId: first.snapshotId });
  assert.equal(changed.kind, 'content-error'); if (changed.kind === 'content-error') assert.equal(changed.code, 'SOURCE_CHANGED');
  const proof = await read(f), altered = Buffer.from(f.original); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  await writeFile(f.file, altered);
  try { await assert.rejects(proof.beforeSend(), rejected('SOURCE_CHANGED', 409)); }
  finally { await writeFile(f.file, f.original); }
  await f.service.close();
  const closed = await f.dispatch({ action: 'local-lyrics', scope: f.scope, selection: f.selection });
  assert.equal(closed.kind, 'content-error'); if (closed.kind === 'content-error') assert.equal(closed.code, 'BUSY');
  await sourceUnchanged(f);
});

test('本地歌词：真实登记但未扫描的分段不借整文件stem歌词，选错contentRevision也拒绝', async t => {
  const f = await ownerFixture(t), file = sidecar(f);
  await writeFile(file, '[00:00]整文件歌词', { flag: 'wx', mode: 0o600 });
  const stale: MobileTrackSelection = { ...f.selection, contentRevision: 'lc:other' };
  await assert.rejects(readerFor(f).read(stale, f.track, f.detail, new AbortController().signal), rejected('SOURCE_CHANGED', 409));
  // 原 Scanner 的 asset 帧轴为 null；用自有 WAV 原 fmt/data 证明新分段声明，绝不补假 scan observation。
  assert.equal(f.original.subarray(0, 4).toString('ascii'), 'RIFF'); assert.equal(f.original.subarray(8, 12).toString('ascii'), 'WAVE');
  let blockAlign = 0, timebaseHz = 0, dataBytes = 0;
  for (let at = 12; at + 8 <= f.original.length;) {
    const kind = f.original.subarray(at, at + 4).toString('ascii'), bytes = f.original.readUInt32LE(at + 4);
    assert.ok(at + 8 + bytes <= f.original.length);
    if (kind === 'fmt ') { assert.equal(f.original.readUInt16LE(at + 8), 1); blockAlign = f.original.readUInt16LE(at + 20); timebaseHz = f.original.readUInt32LE(at + 12); }
    if (kind === 'data') dataBytes += bytes; at += 8 + bytes + bytes % 2;
  }
  assert.ok(blockAlign > 0 && dataBytes >= blockAlign * 128); assert.equal(dataBytes % blockAlign, 0);
  await writeFile(path.join(f.media, 'segment.wav'), f.original, { flag: 'wx', mode: 0o600 });
  const asset = f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    relative: 'segment.wav', sha256: hash(f.original), sampleFrames: String(dataBytes / blockAlign), timebaseHz });
  const track = f.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id,
    segment: { startFrame: '0', endFrameExclusive: '128', timebaseHz } });
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), trackId: track.id, editionId: f.edition.id, disc: 1, trackNumber: 2, sequence: 2 });
  const identity = hash(Buffer.from(JSON.stringify([f.datasetId, asset.id, asset.fileRevision, track.selectionRevision, track.segment])));
  const selection: MobileTrackSelection = { source: 'local', trackId: `lt:${f.datasetId}:${track.id}:${f.edition.id}`,
    versionId: `lv:${identity}`, contentRevision: `lc:${identity}` };
  const result = await f.dispatch({ action: 'local-lyrics', scope: f.scope, selection });
  assert.equal(result.kind, 'content-error'); if (result.kind === 'content-error') assert.equal(result.code, 'BUSY');
  await sourceUnchanged(f);
});
