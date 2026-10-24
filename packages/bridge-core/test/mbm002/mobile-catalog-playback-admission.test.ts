import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import type { LocalLibraryTrackDetail, ScanJobRecord } from '@music-bridge/contracts';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { LocalAlbumSqlMobileQuery, LocalAlbumSqlMobileRow } from '../../src/collection/local-album-browser/sql-types.js';
import { withCatalogTrace, copyCatalogTraceRecord, MOBILE_CATALOG_TRACE_PREFIX } from '../../src/mobile/catalog-private-trace.js';
import { mobileAlbumId, mobileGroupHash } from '../../src/mobile/local-album-identity.js';
import type { MobileLocalAlbums } from '../../src/mobile/local-album-projection.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js';
import { createTestDatasetDomain } from '../../src/collection/dataset-domain.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { MobileServiceError, type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult } from '../../src/mobile/types.js';

const DATASET = '74000000-0000-4000-8000-000000000001';
const ROOT = '74000000-0000-4000-8000-000000000002';
const SOURCE = '74000000-0000-4000-8000-000000000003';
const JOB = '74000000-0000-4000-8000-000000000004';
const ALBUM = `directory-${'a'.repeat(64)}`;
const uuid = (n: number): string => `75000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const realOpen = fs.openSync, realClose = fs.closeSync;

/** 合成目录/事实端口只验证调度；物理资格仍实际打开外盘自建WAVE文件，绝不读取用户媒体。 */
function fixture(t: TestContext, count = 101) {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  const directory = fs.mkdtempSync(path.join(temporary, 'mac60-catalog-'));
  fs.chmodSync(directory, 0o700);
  const media = path.join(directory, 'media'), state = path.join(directory, 'state');
  fs.mkdirSync(media, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  const rootInfo = fs.lstatSync(media, { bigint: true });
  let revision = 'scope:1', active = true, authorized = true, frameActive = false, firstPhysical: (() => void) | undefined;
  let failCloseIndex: number | null = null;
  let playbackBusy = false, busyReads = 0, afterParameters: (() => void) | undefined;
  let failParameters = false, afterSql: (() => void) | undefined;
  const counters = { sql: 0, detail: 0, parameters: 0, track: 0, locator: 0, root: 0, source: 0,
    state: 0, currentState: 0, job: 0, physicalOpen: 0, physicalClose: 0, frames: 0 };
  const root = { id: ROOT, sourceRootId: SOURCE, role: 'library' as const, revision: '1' };
  const source = () => ({ id: SOURCE, path: media, dev: String(rootInfo.dev), ino: String(rootInfo.ino), authorized, label: '合成测试根' });
  const parameters = { container: 'WAVE', codec: 'pcm_s16le', lossless: true, sampleRateHz: 48000,
    channels: 2, bitsPerSample: 16, durationMs: 1000, evidence: 'bounded-parser-reported' } as const;
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36, 4); header.write('WAVE', 8);
  const details: LocalLibraryTrackDetail[] = [];
  const relatives: string[] = [], signatures: string[] = [];
  const files = new Map<string, number>();
  for (let index = 0; index < count; index++) {
    const relative = `合成曲目${index + 1}.wav`, filename = path.join(media, relative);
    fs.writeFileSync(filename, header, { mode: 0o600 });
    const info = fs.lstatSync(filename, { bigint: true });
    relatives.push(relative); signatures.push([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'));
    files.set(filename, index);
    const fields = { title: `合成曲目${index + 1}`, artist: '合成作者' };
    details.push({ track: { id: uuid(index + 1), assetId: uuid(index + 1001), selectionRevision: '1', segment: null },
      asset: { id: uuid(index + 1001), libraryRootId: ROOT, sourceRootId: SOURCE, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
      metadata: { raw: fields, override: null, effective: fields }, versionTokens: [], editions: [], fileParameters: parameters });
  }
  const byTrack = (id: string) => { const index = details.findIndex(v => v.track.id === id); assert.ok(index >= 0); return index; };
  const byAsset = (id: string) => { const index = details.findIndex(v => v.asset.id === id); assert.ok(index >= 0); return index; };
  const scan = (index: number) => ({ libraryRootId: ROOT, relative: relatives[index]!, signature: signatures[index]!,
    parserVersion: 'synthetic-reader', outcome: 'accepted' as const, assetId: details[index]!.asset.id,
    trackId: details[index]!.track.id, failureCode: null, readFacts: null });
  const job: ScanJobRecord = { schemaVersion: '1.2', jobId: JOB, datasetId: DATASET, libraryRootId: ROOT,
    sourceRootId: SOURCE, rootRevision: '1', jobRevision: '1', checkpointRef: null,
    phase: 'completed', failureCode: null, progress: { visited: String(count), accepted: String(count), rejected: '0' } };
  const current = () => { if (!active) throw new MobileServiceError(503, 'BUSY'); };
  const collection = { privateMobileDataDirectory: () => state,
    localCatalog: {
      trackDetail(id: string) { counters.detail++; return structuredClone(details[byTrack(id)]!); },
      track(id: string) { counters.track++; return structuredClone(details[byTrack(id)]!.track); },
      privateAssetLocator(id: string) { counters.locator++; const index = byAsset(id); return { asset: structuredClone(details[index]!.asset), relative: relatives[index]! }; },
      root() { counters.root++; return { ...root }; },
    }, sources: { root() { counters.source++; return source(); } },
    localScan: {
      privateDisplayFileParameters(id: string) { counters.parameters++; assert.equal(frameActive, true);
        if (afterParameters) { const action = afterParameters; afterParameters = undefined; action(); }
        return failParameters && byTrack(id) === 50 ? null : { ...parameters }; },
      privateWithDisplayFileParametersRead<T>(read: () => T): T {
        assert.equal(frameActive, false); frameActive = true; counters.frames++;
        try {
          const value = read();
          assert.ok(value === null || typeof value !== 'object' || !('then' in value), '同步解析帧不得跨await。');
          return value;
        } finally { frameActive = false; }
      },
      privateFileState(_root: string, relative: string) { counters.state++; return { jobId: JOB, value: scan(relatives.indexOf(relative)) }; },
      privateCurrentFileState(_root: string, relative: string) { counters.currentState++; return { jobId: JOB, value: scan(relatives.indexOf(relative)) }; },
      get() { counters.job++; return structuredClone(job); },
    },
  } as unknown as CollectionRepository;
  const groupHash = mobileGroupHash(ROOT, ALBUM);
  const rows = (): LocalAlbumSqlMobileRow[] => details.map((detail, index) => ({
    album: { id: ALBUM, rootId: ROOT, title: '合成专辑', artists: [], versionLabel: null, trackCount: count, artworkState: 'missing' },
    groupHash, artworkSourceRevision: 'a'.repeat(64), member: { fact: { relative: relatives[index]!,
      summary: { track: structuredClone(detail.track), asset: structuredClone(detail.asset), metadata: { ...detail.metadata.effective }, versionTokens: structuredClone(detail.versionTokens) },
      rawMetadata: { ...detail.metadata.raw }, hasArtwork: false, artworkRevision: null },
      disc: null, trackNumber: null, sequence: index + 1, editionLink: null, statuses: [] },
  } as unknown as LocalAlbumSqlMobileRow));
  const localAlbums = { privateMobile: { async refresh() { current(); }, revision: () => revision,
    current(request: LocalAlbumSqlMobileQuery) { current(); counters.sql++;
      const page = request.kind === 'groups' ? { revision, total: 1, items: rows().slice(0, 1) }
        : { revision, total: count, items: rows().slice(request.offset, request.offset + request.limit) };
      if (afterSql) { const action = afterSql; afterSql = undefined; action(); }
      return page; } },
    async getArtwork() { throw new Error('调度测试不读取封面。'); },
  } as unknown as MobileLocalAlbums;
  const owner = createMobileOwnerService({ collection, localAlbums, datasetId: DATASET, ownerEpoch: uuid(9999), assertCurrent: current, isPlaybackBusy: () => { busyReads++; return playbackBusy; } });
  const request = (changes: Partial<MobileOwnerCatalogRequest> = {}): MobileOwnerPrivateRequest => ({ kind: 'catalog', datasetId: DATASET,
    request: { operation: 'listTracks', serverId: 'server.synthetic', offset: 1, limit: 100, q: '', albumId: null,
      itemId: null, expectedRevision: null, catalogPlaybackEnabled: true, ...changes } });
  const opened = new Map<number, number>(), failedDescriptors = new Set<number>();
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = realOpen(...args), index = typeof args[1] === 'number'
      && (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0 ? files.get(String(args[0])) : undefined;
    if (index !== undefined) {
      opened.set(fd, index); counters.physicalOpen++;
      if (firstPhysical) { const callback = firstPhysical; firstPhysical = undefined; callback(); }
    }
    return fd;
  });
  t.mock.method(fs, 'closeSync', (fd: number) => {
    const index = opened.get(fd);
    if (index !== undefined) {
      if (index === failCloseIndex) { failedDescriptors.add(fd); throw new Error('合成close失败'); }
      counters.physicalClose++; opened.delete(fd);
    }
    realClose(fd);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const fd of failedDescriptors) realClose(fd);
    assert.equal(frameActive, false, '退出后必须释放同步解析帧。');
    fs.rmSync(directory, { recursive: true });
  });
  return { owner, request, counters,
    busyReads: () => busyReads, setBusy(value: boolean) { playbackBusy = value; },
    onSql(action: () => void) { afterSql = action; },
    onParameters(action: () => void) { afterParameters = action; },
    setTokens(count: number) { for (const detail of details) detail.versionTokens = Array.from({ length: count }, () => ({
      raw: '合'.repeat(500), source: 'album' as const, kind: 'edition' as const, start: 0, end: 500 })); },
    frame: () => frameActive, details, media,
    onFirstPhysical(callback: () => void) { firstPhysical = callback; },
    revoke() { authorized = false; revision = 'scope:2'; }, close() { active = false; },
    changeFacts() { details[50] = { ...details[50]!, asset: { ...details[50]!.asset, fileRevision: '2' } }; revision = 'scope:2'; },
    changeFile() { fs.writeFileSync(path.join(media, relatives[50]!), Buffer.alloc(50, 1)); },
    failClose(index: number) { failCloseIndex = index; },
    setEditions(count: number) { for (const detail of details) detail.editions = Array.from({ length: count }, (_, index) => ({
      id: uuid(index + 10000), title: '合'.repeat(60), edition: '成'.repeat(60), revision: '1' })); },
    failParameters() { failParameters = true; },
    clearFailures() {
      failParameters = false; failCloseIndex = null;
      for (const fd of failedDescriptors) { realClose(fd); opened.delete(fd); }
      failedDescriptors.clear();
    },
  };
}

function snapshot(value: MobileOwnerPrivateResult): MobileOwnerCatalogSnapshot {
  assert.ok('items' in value, '完整目录成功应返回整页，不能把BUSY当作通过。');
  return value as MobileOwnerCatalogSnapshot;
}
function failure(value: MobileOwnerPrivateResult, status: number, code: string): void {
  assert.ok('kind' in value && value.kind === 'mobile-error');
  assert.equal(value.status, status); assert.equal(value.code, code); assert.ok(!('items' in value), '失败不能发布已准备的前缀。');
}
function channel(t: TestContext, action: () => unknown | Promise<unknown>) {
  const { port1, port2 } = new MessageChannel();
  const received = new Promise<unknown>((resolve, reject) => {
    port1.once('message', () => { Promise.resolve().then(action).then(resolve, reject); });
  });
  t.after(() => { port1.close(); port2.close(); });
  return { received, send() { port2.postMessage({ kind: 'synthetic-owner-read' }); } };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function entered(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 1500;
  while (!check()) { assert.ok(performance.now() < deadline, '必须实际进入被保持的等待点'); await turn(); }
}

test('M60准入RED：真实播放活动中不进后台后页SQL，MessageChannel认证仍可执行', async t => {
  const f = fixture(t); f.setBusy(true);
  const pending = f.owner.dispatchMobile(f.request());
  try {
    const message = channel(t, async () => {
      assert.equal(f.counters.sql, 0, '活动中后台后页不能进入SQL');
      assert.equal(f.frame(), false);
      return f.owner.dispatchMobile({ kind: 'load', datasetId: DATASET });
    });
    message.send();
    assert.deepEqual(await message.received, { kind: 'missing', datasetId: DATASET, revision: 0 });
  } finally { f.setBusy(false); await pending; }
  assert.equal(f.counters.sql, 1);
  assert.equal(f.counters.physicalOpen, 100); assert.equal(f.counters.physicalClose, 100);
});

test('M60暂停SQL后同步prepare，原Owner认证消息可在等待中执行', async t => {
  const f = fixture(t);
  const message = channel(t, async () => {
    assert.equal(f.counters.sql, 1); assert.equal(f.counters.parameters, 0); assert.equal(f.frame(), false);
    assert.deepEqual(await f.owner.dispatchMobile({ kind: 'load', datasetId: DATASET }), { kind: 'missing', datasetId: DATASET, revision: 0 });
    f.setBusy(false);
  });
  f.onSql(() => { f.setBusy(true); message.send(); });
  const page = snapshot(await f.owner.dispatchMobile(f.request())); await message.received;
  assert.equal(page.items.length, 100); assert.equal(f.counters.parameters, 100);
  assert.equal(f.counters.physicalOpen, 100); assert.equal(f.counters.physicalClose, 100);
});

test('M60行间新活动阻止下一行资格，原FD自然关闭后才等且解析帧已退出', async t => {
  const f = fixture(t);
  const message = channel(t, async () => {
    assert.equal(f.frame(), false); assert.equal(f.counters.physicalOpen, 1); assert.equal(f.counters.physicalClose, 1);
    await pause(25);
    assert.equal(f.counters.physicalOpen, 1, 'busy期间不能继续下一行FD资格');
    assert.deepEqual(await f.owner.dispatchMobile({ kind: 'load', datasetId: DATASET }), { kind: 'missing', datasetId: DATASET, revision: 0 });
    f.setBusy(false);
  });
  f.onFirstPhysical(() => { f.setBusy(true); message.send(); });
  const page = snapshot(await f.owner.dispatchMobile(f.request())); await message.received;
  assert.equal(page.items.length, 100); assert.equal(f.counters.physicalOpen, f.counters.physicalClose);
});

test('M60完整差分：quiet后DTO和每项全部fresh事实及FD计数保持相同', async t => {
  const f = fixture(t), request = f.request();
  const original = snapshot(f.owner.dispatchCurrentCatalog(request)); const counts = { ...f.counters };
  f.setBusy(true);
  const message = channel(t, () => { assert.equal(f.counters.sql, counts.sql); f.setBusy(false); });
  const pending = f.owner.dispatchMobile(request); message.send();
  const actual = snapshot(await pending); await message.received;
  assert.equal(digest(actual), digest(original));
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) assert.equal(f.counters[key], counts[key] * 2, key);
  assert.equal(counts.physicalOpen, 100); assert.equal(counts.track, 400);
});

test('M60 scope：首屏、搜索、专辑曲目与同步投影不进入后台播放等待', async t => {
  for (const changes of [{ offset: 0, limit: 100 }, { q: '合成' }, { albumId: mobileAlbumId(DATASET, ROOT, ALBUM) }]) {
    const f = fixture(t); f.setBusy(true); const request = f.request(changes);
    assert.equal(snapshot(await f.owner.dispatchMobile(request)).items.length, 100);
    assert.equal(f.busyReads(), 0, '不相关scope连busy callback都不应读取');
  }
  const f = fixture(t); f.setBusy(true);
  assert.equal(snapshot(f.owner.dispatchCurrentCatalog(f.request())).items.length, 100);
  assert.equal(f.busyReads(), 0, 'source.resolveTrack/内容事务同步路径绝不等待自己的播放token');
});

test('M60持续播放：整页累计仅等2秒，到期仍原完整处理且不额外BUSY', async t => {
  const f = fixture(t); f.setBusy(true); const began = performance.now();
  const page = snapshot(await f.owner.dispatchMobile(f.request()));
  const elapsed = performance.now() - began;
  assert.ok(elapsed >= 1950 && elapsed < 4500, `整页累计等待需有界，不能100行分别等2s：${elapsed}`);
  assert.equal(page.items.length, 100); assert.equal(f.counters.sql, 1); assert.equal(f.counters.physicalOpen, 100);
  assert.ok(f.busyReads() < 130, '预算耗尽后本页后续检查点不再重复等待');
  t.diagnostic(JSON.stringify({ schema: 'mb.mac60.gate-bounded.synthetic.v1', elapsedMs: elapsed, busyChecks: f.busyReads(), rows: page.items.length }));
});

test('M60 Owner关闭：下一短tick退出，不进SQL也不遗留解析帧', async t => {
  const f = fixture(t); f.setBusy(true); const pending = f.owner.dispatchMobile(f.request());
  await entered(() => f.busyReads() > 0); f.close();
  failure(await pending, 503, 'BUSY'); assert.equal(f.counters.sql, 0); assert.equal(f.counters.parameters, 0);
  assert.equal(f.frame(), false); assert.equal(f.counters.physicalOpen, 0);
});

test('M60等待时来源撤销：恢复后仍用原fresh revision拒绝整页不发布前缀', async t => {
  const f = fixture(t); const first = snapshot(f.owner.dispatchCurrentCatalog(f.request({ offset: 0, limit: 1 })));
  const before = { ...f.counters }; f.setBusy(true);
  const pending = f.owner.dispatchMobile(f.request({ expectedRevision: first.libraryRevision }));
  await entered(() => f.busyReads() > 0); f.revoke(); f.setBusy(false);
  failure(await pending, 409, 'SOURCE_CHANGED'); assert.deepEqual(f.counters, before);
});

test('M60准备超界：先释放2MiB临时量，fallback仍服从播放gate且保持原DTO', async t => {
  const f = fixture(t); f.setEditions(200);
  const original = snapshot(f.owner.dispatchCurrentCatalog(f.request()));
  const baseline = { ...f.counters }, lines: string[] = [];
  const message = channel(t, () => {
    assert.equal(f.counters.sql, baseline.sql + 1); assert.equal(f.counters.frames, baseline.frames + 1);
    assert.equal(f.counters.physicalOpen, baseline.physicalOpen); assert.equal(f.frame(), false);
    f.setBusy(false);
  });
  f.onParameters(() => { f.setBusy(true); message.send(); });
  const actual = snapshot(await withCatalogTrace({ schema: 1, requestSha256: 'a'.repeat(64), nonceSha256: 'c'.repeat(64), offset: 1, limit: 100 },
    'owner', () => f.owner.dispatchMobile(f.request()), line => lines.push(line)));
  await message.received; assert.equal(digest(actual), digest(original));
  const records = lines.map(line => copyCatalogTraceRecord(JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length))));
  assert.equal(records.filter(r => r?.stage === 'owner.catalog.prepare-fallback').length, 1);
  f.setEditions(0); let rowsAtMessage = -1;
  const after = channel(t, () => { rowsAtMessage = f.counters.physicalOpen; }); f.onFirstPhysical(after.send);
  const start = f.counters.physicalOpen; snapshot(await f.owner.dispatchMobile(f.request())); await after.received;
  assert.ok(rowsAtMessage > start && rowsAtMessage < start + 100, 'fallback结束归还临时量，后页重新公平让出');
});

test('M60 runtime：playback独立计数，general current/revision不自锁，幂等A不清B及100ms quiet', async t => {
  const repository = createCollectionRepository({ filePath: ':memory:' });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const runtime = createLocalAlbumOwnerRuntime({ repository, assertCurrent() {}, async readRootViews() { return [] } });
  t.after(async () => { await runtime.close(); repository.close(); });
  await runtime.localAlbums.privateMobile.refresh();
  const general = runtime.beginMobileActivity();
  runtime.localAlbums.privateMobile.revision();
  assert.equal(runtime.isPlaybackBusy(), false); general(); assert.equal(runtime.isPlaybackBusy(), false);
  const a = runtime.beginMobilePlaybackActivity(), b = runtime.beginMobilePlaybackActivity();
  assert.equal(runtime.isPlaybackBusy(), true); a(); a(); now += 101; assert.equal(runtime.isPlaybackBusy(), true);
  b(); assert.equal(runtime.isPlaybackBusy(), true); now += 101; assert.equal(runtime.isPlaybackBusy(), false);
  const control = runtime.beginMobileControlActivity(); assert.ok(control); assert.equal(runtime.isPlaybackBusy(), true);
  runtime.endMobileControlActivity(control); runtime.endMobileControlActivity(control); now += 101;
  assert.equal(runtime.isPlaybackBusy(), false);
});

test('M60真实Dataset接线：control活动让后台后页等quiet，auth load不被同Owner等待挡住', async t => {
  const repository = createCollectionRepository({ filePath: ':memory:' });
  const domain = createTestDatasetDomain({ collectionRepository: repository,
    collectionDatasetIdentity: { datasetId: DATASET, assertCurrent() {} }, localSourceEpoch: uuid(9999) });
  t.after(() => domain.close());
  const dispatch = domain.mobileMain; assert.ok(dispatch);
  const authBaseline = await dispatch({ kind: 'load', datasetId: DATASET });
  const begin = await dispatch({ kind: 'playback-activity', datasetId: DATASET, request: { operation: 'begin' } });
  assert.ok('kind' in begin && begin.kind === 'playback-activity' && begin.leaseId);
  if (!('kind' in begin) || begin.kind !== 'playback-activity' || !begin.leaseId) throw new Error('必须取得真实活动');
  const records: string[] = [], request: MobileOwnerPrivateRequest = { kind: 'catalog', datasetId: DATASET,
    request: { operation: 'listTracks', serverId: 'server.synthetic', offset: 1, limit: 100, q: '', albumId: null,
      itemId: null, expectedRevision: null, catalogPlaybackEnabled: false } };
  const pending = withCatalogTrace({ schema: 1, requestSha256: 'd'.repeat(64), nonceSha256: 'e'.repeat(64), offset: 1, limit: 100 },
    'owner', () => dispatch(request), line => records.push(line));
  const message = channel(t, async () => {
    const stages = records.map(line => JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length)).stage);
    assert.equal(stages.includes('owner.sql-page'), false, '真实Dataset必须把独立busy callback接到projection');
    assert.deepEqual(await dispatch({ kind: 'load', datasetId: DATASET }), authBaseline, '内存Domain无持久目录仍应保持原not-sent回复，不能因等待卡住');
    await dispatch({ kind: 'playback-activity', datasetId: DATASET, request: {
      operation: 'end', ownerEpoch: begin.ownerEpoch, leaseId: begin.leaseId! } });
  });
  message.send(); await message.received;
  const result = await pending; assert.ok('items' in result); assert.equal(result.items.length, 0);
  assert.ok(records.some(line => JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length)).stage === 'owner.sql-page'));
});

test('M60 poll准入RED：先到MessagePort的播放活动先落地，再看busy进入SQL', async t => {
  const f = fixture(t); let observed = false;
  const activity = channel(t, async () => {
    observed = true; f.setBusy(true);
    assert.equal(f.counters.sql, 0, '不能在Owner尚未接收播放活动消息时抢先进入SQL');
    assert.equal(f.frame(), false);
    assert.deepEqual(await f.owner.dispatchMobile({ kind: 'load', datasetId: DATASET }), { kind: 'missing', datasetId: DATASET, revision: 0 });
    await pause(25); assert.equal(f.counters.sql, 0);
    f.setBusy(false);
  });
  activity.send();
  const pending = f.owner.dispatchMobile(f.request());
  try { await activity.received; assert.equal(observed, true); }
  finally { f.setBusy(false); await pending; }
  assert.equal(f.counters.sql, 1); assert.equal(f.counters.physicalOpen, 100);
});
