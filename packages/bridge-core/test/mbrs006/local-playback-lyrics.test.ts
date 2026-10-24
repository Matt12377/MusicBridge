import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { constants, fstatSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { LyricsSnapshot } from '@music-bridge/contracts';
import { parseLocalPlaybackLrc } from '../../src/library/local-playback-lyrics.js';
import { closeRustMediaWorkerPool } from '../../src/library/rust-media-worker.js';
import { isLocalSourceLyricsSnapshot } from '../../src/collection/local-source-ticket-types.js';
import { LocalSourceFence, LocalFactsFenceBusy, withLocalFactsMutation } from '../../src/stream/local-source-fence.js';
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js';
import { BridgeController } from '../../src/application/bridge-controller.js';
import { createLyricsRequestContext } from '../../src/lyrics/coordinator.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { LocalFileSourcePool } from '../../src/stream/local-file-source.js';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import type { NeteasePort } from '../../src/netease/types.js';
import { catalogFixture } from './catalog-fixture.js';
import { adapterFixture, silentLogger, tick } from './adapter-fixture.js';
import { eventually } from '../mbrs005/fixture.js';

after(closeRustMediaWorkerPool);

const sourceText = '\ufeff[ar:合成作者]\r\n[offset:+100]\r\n[00:00.00]\r\n[00:01.00]第一行\r\n[00:02.00][00:03.00]后续行\r\n[00:04.00]\r\n';
const sidecar = (relative: string) => relative.slice(0, relative.lastIndexOf('.')) + '.lrc';
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const turns = async () => { for (let i = 0; i < 5; i++) await tick(); };

async function catalog(t: TestContext) {
  const f = await catalogFixture(t);
  // 复用原真实Source/扫描Root；工作台catalog角色不是LocalCatalogRootRole，不伪造新角色或移动端edition许可。
  for (const name of ['一.wav', '二.wav']) await fsp.writeFile(path.join(f.media, sidecar(name)), sourceText);
  return f;
}

/** 仅观察本测试拥有的真实FD；IO本体仍为Node真实只读open/read/close。 */
function observeFiles(t: TestContext, media: string, holdRelative?: string) {
  const opened: { relative: string; flags: string | number | undefined; fd: number; reads: number; bytes: number; closed: boolean }[] = [];
  const entered = deferred(), release = deferred(), originalOpen = fsp.open;
  let held = false;
  t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
    const handle = await originalOpen(...args), absolute = String(args[0]);
    if (!absolute.startsWith(media + path.sep)) return handle;
    const entry = { relative: path.relative(media, absolute), flags: args[1], fd: handle.fd, reads: 0, bytes: 0, closed: false };
    opened.push(entry);
    const read = handle.read.bind(handle) as (...values: any[]) => Promise<{ bytesRead: number; buffer: any }>;
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'read', async (...values: any[]) => {
      const result = await read(...values); entry.reads++; entry.bytes += result.bytesRead;
      if (!held && entry.relative === holdRelative) { held = true; entered.resolve(); await release.promise; }
      return result;
    });
    t.mock.method(handle, 'close', async () => { await close(); entry.closed = true; });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { release.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { opened, entered: entered.promise, release: () => release.resolve() };
}

function assertQuiet(entries: ReturnType<typeof observeFiles>['opened']) {
  assert.ok(entries.length > 0); assert.ok(entries.every(entry => entry.closed));
  for (const entry of entries) assert.throws(() => fstatSync(entry.fd), (error: any) => error.code === 'EBADF');
}

test('本地LRC：空同步起止行有界跳过，UTF8/offset/多时间戳完整保留且后续行可推进', () => {
  const result = parseLocalPlaybackLrc(Buffer.from(sourceText));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.lines, [
    { startMs: 1100, endMs: 2100, text: '第一行' },
    { startMs: 2100, endMs: 3100, text: '后续行' },
    { startMs: 3100, text: '后续行' },
  ]);
  assert.equal(result.source, undefined); assert.equal(result.activeLineIndex, -1); assert.equal(result.timingSource, 'static');
  assert.equal(isLocalSourceLyricsSnapshot(result), true);
  assert.equal(parseLocalPlaybackLrc(Buffer.from('[00:00.00]\n[00:02.00]')).status, 'unavailable');
  assert.equal(parseLocalPlaybackLrc(Buffer.from('[00:60.00]\n[00:01.00]正文')).status, 'unavailable');
});

test('本地LRC：输入/时间戳/单行/UTF8/异常正文均整体守界，不把坏内容报纯音乐', () => {
  const prefix = '[ar:', suffix = ']\n[00:01.00]边界';
  const exact = Buffer.from(prefix + 'x'.repeat(65536 - Buffer.byteLength(prefix + suffix)) + suffix);
  assert.equal(exact.byteLength, 65536); assert.equal(parseLocalPlaybackLrc(exact).status, 'ready');
  const bad = [Buffer.alloc(0), Buffer.concat([exact, Buffer.from('x')]), Buffer.from([0xff, 0xfe]),
    Buffer.from('[00:01.00]正文\u0000'), Buffer.from('[00:01.00]正文\n无时间戳内容'),
    Buffer.from('[00:01.00]' + 'x'.repeat(2049)), Buffer.from('[offset:-2000]\n[00:01.00]正文'),
    Buffer.from('[offset:1]\n[offset:2]\n[00:01.00]正文'),
    Buffer.from('[00:00.00]\n'.repeat(500) + '[00:01.00]正文')];
  for (const bytes of bad) { const result = parseLocalPlaybackLrc(bytes); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.lines, []); }
});

test('本地LRC私有回执：拒Provider/伪纯音乐/loading/正文错位/未知字段及超输出预算', () => {
  const valid = parseLocalPlaybackLrc(Buffer.from('[00:01.00]真实旁置内容'));
  for (const value of [{ ...valid, source: 'netease' }, { ...valid, source: 'roon-display' }, { ...valid, status: 'instrumental' },
    { ...valid, status: 'loading' }, { ...valid, activeLineIndex: 0 }, { ...valid, status: 'ready', lines: [] },
    { ...valid, status: 'unavailable' }, { ...valid, extra: true },
    { ...valid, lines: Array.from({ length: 500 }, (_, i) => ({ startMs: i, text: 'x'.repeat(2048) })) }]) assert.equal(isLocalSourceLyricsSnapshot(value), false);
});

test('真实Owner扫描票据读取：同stem正文、原Source签名、真实只读FD及闭集日志，音频内容读取为零', async t => {
  const f = await catalog(t), capture = f.tickets.capture(f.requests[0]!), fence = new LocalSourceFence(capture.buffer);
  assert.equal(capture.facts.root.role, 'library');
  const log: string[] = []; t.mock.method(console, 'info', (line: unknown) => { if (typeof line === 'string') log.push(line); });
  const files = observeFiles(t, f.media), before = await fsp.stat(path.join(f.media, capture.facts.relative), { bigint: true });
  const result = await f.tickets.readLyrics(capture.ticketId);
  assert.equal(result.status, 'ready'); assert.equal(result.lines[0]?.text, '第一行'); assert.equal(result.source, undefined);
  const audio = files.opened.filter(entry => entry.relative === capture.facts.relative), lrc = files.opened.filter(entry => entry.relative === sidecar(capture.facts.relative));
  assert.equal(audio.length, 1); assert.equal(audio[0]!.reads, 0); assert.equal(lrc.length, 1); assert.ok(lrc[0]!.reads > 0);
  assert.equal(lrc[0]!.bytes, Buffer.byteLength(sourceText)); assert.ok(lrc[0]!.bytes <= 65536);
  for (const entry of files.opened) { assert.equal(typeof entry.flags, 'number'); assert.equal(Number(entry.flags) & 3, constants.O_RDONLY); assert.ok(Number(entry.flags) & constants.O_NOFOLLOW); }
  assertQuiet(files.opened); assert.equal(fence.references, 0); assert.equal(fence.current, true);
  const after = await fsp.stat(path.join(f.media, capture.facts.relative), { bigint: true });
  assert.equal([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':'), [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':'));
  const events = log.map(readLibraryOperationLine).filter((value): value is NonNullable<typeof value> => value !== null);
  for (const action of ['lyrics.local.read', 'lyrics.local.audio-source', 'lyrics.local.sidecar-stat', 'lyrics.local.sidecar-read', 'lyrics.local.parse', 'lyrics.local.lease']) assert.ok(events.some(event => event.action === action && event.state === 'complete'), action);
  assert.ok(events.some(event => event.action === 'lyrics.local.lease' && event.state === 'complete' && event.active === 0));
  assert.ok(!log.join('').includes(f.media)); assert.ok(!log.join('').includes('第一行')); assert.ok(!log.join('').includes(capture.ticketId));
  f.tickets.release(capture.ticketId);
});

test('真实Owner：缺失/零字节/坏LRC/超64KiB均不可用，不读取邻曲或从Provider补正文', async t => {
  const f = await catalog(t), first = f.requests[0]!, relative = f.repository.localCatalog.privateAssetLocator(first.asset_id).relative;
  const absolute = path.join(f.media, sidecar(relative));
  for (const content of [null, Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('[99:99.99]坏时间'), Buffer.alloc(65537, 0x61)]) {
    await fsp.rm(absolute, { force: true }); if (content !== null) await fsp.writeFile(absolute, content);
    const capture = f.tickets.capture(first), result = await f.tickets.readLyrics(capture.ticketId);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.lines, []); assert.equal(result.source, undefined);
    assert.equal(new LocalSourceFence(capture.buffer).references, 0); f.tickets.release(capture.ticketId);
  }
});

for (const link of ['symlink', 'hardlink'] as const) test(`真实Owner：${link}旁置文件不继承原播放ticket的根内许可`, async t => {
  const f = await catalog(t), capture = f.tickets.capture(f.requests[0]!), absolute = path.join(f.media, sidecar(capture.facts.relative));
  const outside = path.join(f.directory, '未授权歌词.lrc'); await fsp.writeFile(outside, '[00:01.00]不能读取'); await fsp.rm(absolute);
  if (link === 'symlink') await fsp.symlink(outside, absolute); else await fsp.link(outside, absolute);
  const files = observeFiles(t, f.media), result = await f.tickets.readLyrics(capture.ticketId);
  assert.equal(result.status, 'unavailable'); assert.ok(files.opened.every(entry => entry.relative === capture.facts.relative)); assertQuiet(files.opened);
  f.tickets.release(capture.ticketId);
});

test('真实Owner：Source撤权与跨Owner ticket均零正文读取，不把旧票复活', async t => {
  const f = await catalog(t), capture = f.tickets.capture(f.requests[0]!);
  const files = observeFiles(t, f.media);
  assert.equal((await f.tickets.readLyrics(randomUUID())).status, 'unavailable');
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id });
  assert.equal((await f.tickets.readLyrics(capture.ticketId)).status, 'unavailable'); assert.equal(files.opened.length, 0);
  assert.equal(new LocalSourceFence(capture.buffer).current, false); f.tickets.release(capture.ticketId);
});

for (const stop of ['seal', 'deadline'] as const) test(`真实FD ${stop}：到期/关闭只标记撤销，全部在途settled后才quiet`, { timeout: 10_000 }, async t => {
  const f = await catalog(t), capture = f.tickets.capture(f.requests[0]!), fence = new LocalSourceFence(capture.buffer);
  const files = observeFiles(t, f.media, sidecar(capture.facts.relative));
  if (stop === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
  const read = f.tickets.readLyrics(capture.ticketId); let settled = false, joined = false;
  void read.then(() => { settled = true; });
  try {
    await files.entered; assert.equal(f.tickets.readLyrics(capture.ticketId), read, '同票单flight，不另开FD');
    assert.equal(fence.references, 1); assert.equal(files.opened.length, 2);
    if (stop === 'seal') f.tickets.seal(); else t.mock.timers.tick(2000);
    const join = f.tickets.joinLyrics().then(() => { joined = true; });
    await turns(); assert.equal(settled, false); assert.equal(joined, false); assert.equal(fence.references, 1); assert.ok(files.opened.every(entry => !entry.closed));
    files.release(); assert.equal((await read).status, 'unavailable'); await join;
    assert.equal(fence.references, 0); assertQuiet(files.opened); f.tickets.release(capture.ticketId);
  } finally { files.release(); await read.catch(() => undefined); if (stop === 'deadline') t.mock.timers.reset(); }
});

test('真实扫描/Source事实提交：在途歌词阻止相关COMMIT，撤销后等原FD关闭再重试', async t => {
  const f = await catalog(t), capture = f.tickets.capture(f.requests[0]!), fence = new LocalSourceFence(capture.buffer), track = capture.facts.track;
  const files = observeFiles(t, f.media, sidecar(capture.facts.relative)), read = f.tickets.readLyrics(capture.ticketId);
  const request = { commandId: randomUUID(), trackId: track.id, expectedSelectionRevision: track.selectionRevision, assetId: track.assetId };
  try {
    await files.entered;
    assert.throws(() => f.repository.localCatalog.selectAsset(request), LocalFactsFenceBusy);
    assert.equal(fence.current, false); assert.equal(fence.references, 1); assert.deepEqual(f.repository.localCatalog.track(track.id), track);
    files.release(); assert.equal((await read).status, 'unavailable'); assertQuiet(files.opened);
    await withLocalFactsMutation(() => f.repository.localCatalog.selectAsset(request));
    assert.equal(fence.references, 0); assert.equal(f.tickets.revalidate(capture.ticketId), false); f.tickets.release(capture.ticketId);
  } finally { files.release(); await read.catch(() => undefined); }
});

for (const changed of ['audio', 'sidecar'] as const) test(`真实FD ${changed}内容变化：最终签名重核拒绝已读正文`, async t => {
  const f = await catalog(t), capture = f.tickets.capture(f.requests[0]!), files = observeFiles(t, f.media, sidecar(capture.facts.relative)), read = f.tickets.readLyrics(capture.ticketId);
  try {
    await files.entered;
    await fsp.writeFile(path.join(f.media, changed === 'audio' ? capture.facts.relative : sidecar(capture.facts.relative)), Buffer.from(changed === 'audio' ? '改变后的合成音频字节' : '[00:01.00]后改正文'));
    files.release(); const result = await read; assert.equal(result.status, 'unavailable'); assert.deepEqual(result.lines, []); assertQuiet(files.opened);
    f.tickets.release(capture.ticketId);
  } finally { files.release(); await read.catch(() => undefined); }
});

test('真实Controller：当前UUID/asset/attempt歌词可读；shutdown先撤票并join真实FD，再释放ticket与播放资源', { timeout: 15_000 }, async t => {
  const f = await catalog(t), pool = new LocalFileSourcePool(), registry = new StreamRegistry({ localSourcePool: pool });
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger: silentLogger });
  await gateway.start(); const sdk = await adapterFixture(500, Number(new URL(gateway.iconUrl()).port));
  let alive = true, releases = 0;
  const localSources: DatasetOwnerEndpoint = { prepare: async () => ({ epoch: f.epoch, datasetId: f.datasetId }), dispatch: async () => undefined, commitBoot: async () => {}, close: async () => {},
    isLocalSourceCurrent: () => alive, sealLocalSources() { alive = false; f.tickets.seal(); },
    captureLocalSource: async request => f.tickets.capture(request), revalidateLocalSource: async id => f.tickets.revalidate(id),
    readLocalSourceLyrics: id => f.tickets.readLyrics(id), releaseLocalSource: async id => { releases++; f.tickets.release(id); } };
  const controller = new BridgeController({ roon: sdk.adapter, registry, gateway, logger: silentLogger, localSources,
    netease: new Proxy({ configured: true }, { get(_target, key) { return key === 'configured' ? true : () => { throw new Error('本地歌词禁止云查询'); }; } }) as NeteasePort });
  try {
    const playing = controller.playLocal(f.requests[0]!); await eventually(() => sdk.sessions.length === 1, '真实本地begin已发起'); sdk.sessions[0]!('SessionBegan', { session_id: 'controlled-lyrics' }); await playing;
    const context = createLyricsRequestContext(controller.getPlaybackState(), controller.getPlaybackGeneration()); assert.equal(context?.kind, 'local-file'); if (context?.kind !== 'local-file') throw new Error('未生成真实本地歌词上下文');
    assert.equal(controller.isCurrentLocalLyrics(context), true); assert.equal(controller.isCurrentLocalLyrics({ ...context, attemptId: 'old-attempt' }), false);
    assert.equal(controller.isCurrentLocalLyrics({ ...context, assetRevision: '999' }), false);
    assert.equal((await controller.readLocalLyrics(context)).status, 'ready');
    const relative = f.repository.localCatalog.privateAssetLocator(context.assetId).relative, files = observeFiles(t, f.media, sidecar(relative));
    const read: Promise<LyricsSnapshot> = controller.readLocalLyrics(context); let shutdownDone = false;
    try {
      await files.entered; const before = releases, closing = controller.shutdown().then(() => { shutdownDone = true; });
      await turns(); assert.equal(shutdownDone, false); assert.equal(releases, before); assert.equal(controller.isCurrentLocalLyrics(context), false);
      assert.ok(files.opened.every(entry => !entry.closed));
      files.release(); assert.equal((await read).status, 'unavailable'); await closing;
      assertQuiet(files.opened); assert.ok(releases > before); assert.equal(f.tickets.size, 0); assert.equal(pool.resourceSnapshot().openLeases, 0);
    } finally { files.release(); await read.catch(() => undefined); }
  } finally { await controller.shutdown(); await sdk.adapter.shutdown(); await gateway.stop(); }
});
