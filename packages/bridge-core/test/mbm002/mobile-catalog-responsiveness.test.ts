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
import { mobileGroupHash } from '../../src/mobile/local-album-identity.js';
import type { MobileLocalAlbums } from '../../src/mobile/local-album-projection.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { MobileServiceError, type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult } from '../../src/mobile/types.js';
import { displayBatchParses, displayMemoFixture, displayReads } from '../v4/scan-display-page-memo-fixture.js';

const DATASET = '74000000-0000-4000-8000-000000000001';
const ROOT = '74000000-0000-4000-8000-000000000002';
const SOURCE = '74000000-0000-4000-8000-000000000003';
const JOB = '74000000-0000-4000-8000-000000000004';
const ALBUM = `directory-${'a'.repeat(64)}`;
const uuid = (n: number): string => `75000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const realOpen = fs.openSync, realClose = fs.closeSync;

/** 合成目录/事实端口只验证调度；物理资格仍实际打开外盘自建WAVE文件，绝不读取用户媒体。 */
function fixture(t: TestContext, count = 100) {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  const directory = fs.mkdtempSync(path.join(temporary, 'mac54-catalog-'));
  fs.chmodSync(directory, 0o700);
  const media = path.join(directory, 'media'), state = path.join(directory, 'state');
  fs.mkdirSync(media, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  const rootInfo = fs.lstatSync(media, { bigint: true });
  let revision = 'scope:1', active = true, authorized = true, frameActive = false, firstPhysical: (() => void) | undefined;
  let failCloseIndex: number | null = null;
  let failParameters = false;
  const counters = { detail: 0, parameters: 0, track: 0, locator: 0, root: 0, source: 0,
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
      summary: { track: structuredClone(detail.track), asset: structuredClone(detail.asset), metadata: { ...detail.metadata.effective }, versionTokens: [] },
      rawMetadata: { ...detail.metadata.raw }, hasArtwork: false, artworkRevision: null },
      disc: null, trackNumber: null, sequence: index + 1, editionLink: null, statuses: [] },
  } as unknown as LocalAlbumSqlMobileRow));
  const localAlbums = { privateMobile: { async refresh() { current(); }, revision: () => revision,
    current(request: LocalAlbumSqlMobileQuery) { current(); return { revision, total: count, items: rows().slice(request.offset, request.offset + request.limit) }; } },
    async getArtwork() { throw new Error('调度测试不读取封面。'); },
  } as unknown as MobileLocalAlbums;
  const owner = createMobileOwnerService({ collection, localAlbums, datasetId: DATASET, ownerEpoch: uuid(9999), assertCurrent: current });
  const request = (changes: Partial<MobileOwnerCatalogRequest> = {}): MobileOwnerPrivateRequest => ({ kind: 'catalog', datasetId: DATASET,
    request: { operation: 'listTracks', serverId: 'server.synthetic', offset: 0, limit: count, q: '', albumId: null,
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
  return { owner, request, counters, frame: () => frameActive, details, media,
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

test('M54公平性：第1行排入真实MessageChannel的auth读取必须在100行之间执行', async t => {
  const f = fixture(t), lines: string[] = []; let rowsAtMessage = -1;
  const message = channel(t, async () => {
    rowsAtMessage = f.counters.physicalOpen;
    assert.equal(f.frame(), false); assert.equal(f.counters.parameters, 100);
    const reply = await f.owner.dispatchMobile({ kind: 'load', datasetId: DATASET });
    assert.deepEqual(reply, { kind: 'missing', datasetId: DATASET, revision: 0 });
  });
  f.onFirstPhysical(message.send);
  const page = snapshot(await withCatalogTrace({ schema: 1, requestSha256: 'a'.repeat(64), nonceSha256: 'b'.repeat(64), offset: 0, limit: 100 },
    'owner', () => f.owner.dispatchMobile(f.request()), line => lines.push(line)));
  await message.received;
  assert.equal(page.items.length, 100); assert.equal(page.total, 100);
  assert.ok(rowsAtMessage >= 1 && rowsAtMessage < 100, `真实消息在第${rowsAtMessage}行后才执行，未给auth让出执行机会。`);
  t.diagnostic(JSON.stringify({ schema: 'mb.mac54.catalog-fairness.v1', rowsAtMessage, rows: page.items.length,
    memoFrames: f.counters.frames, physicalOpen: f.counters.physicalOpen, physicalClose: f.counters.physicalClose }));
  const records = lines.map(line => copyCatalogTraceRecord(JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length))));
  assert.ok(records.every(record => record !== null));
  assert.ok(records.length <= 58);
  assert.equal(records.find(record => record?.stage === 'owner.item.availability.calls')?.count, 100);
  assert.equal(records.find(record => record?.stage === 'owner.item.file-parameters.calls')?.count, 100);
});

test('M54差分：100行异步整页与原同步整页DTO哈希及所有fresh事实/FD调用数相同', async t => {
  const f = fixture(t), request = f.request();
  const before = snapshot(f.owner.dispatchCurrentCatalog(request));
  assert.ok(before.items.every(item => 'availability' in item && item.availability === 'available'));
  const original = { ...f.counters };
  const after = snapshot(await f.owner.dispatchMobile(request));
  assert.equal(digest(after), digest(before));
  for (const key of Object.keys(original) as (keyof typeof original)[]) assert.equal(f.counters[key], original[key] * 2, key);
  assert.equal(original.physicalOpen, 100); assert.equal(original.physicalClose, 100);
  assert.equal(original.track, 400); assert.equal(original.state, 400); assert.equal(original.currentState, 400);
  assert.equal(original.job, 400); assert.equal(original.frames, 1);
  t.diagnostic(JSON.stringify({ schema: 'mb.mac54.catalog-differential.v1', synchronousSha256: digest(before), asynchronousSha256: digest(after),
    rows: after.items.length, total: after.total, perPageCalls: original }));
});

test('M54围栏：行间撤销、Owner换代和事实改变整页拒绝，不能发布前缀', async t => {
  for (const kind of ['revoke', 'close', 'facts'] as const) await t.test(kind, async child => {
    const f = fixture(child);
    const message = channel(child, () => { if (kind === 'revoke') f.revoke(); else if (kind === 'close') f.close(); else f.changeFacts(); });
    f.onFirstPhysical(message.send);
    const reply = await f.owner.dispatchMobile(f.request()); await message.received;
    failure(reply, kind === 'close' ? 503 : 409, kind === 'close' ? 'BUSY' : 'SOURCE_CHANGED');
    assert.ok(f.counters.physicalOpen < 100, '变更后不能继续当作全部可播放行。');
  });
});

test('M54物理fresh：行间实际文件改变仍按原签名拒绝该文件，不复用上一行资格', async t => {
  const f = fixture(t), message = channel(t, f.changeFile); f.onFirstPhysical(message.send);
  const page = snapshot(await f.owner.dispatchMobile(f.request())); await message.received;
  assert.equal(page.items.length, 100);
  assert.ok('availability' in page.items[50]! && page.items[50]!.availability === 'unavailable');
  assert.equal(page.items.filter(item => 'availability' in item && item.availability === 'available').length, 99);
  assert.equal(f.counters.physicalOpen, 99); assert.equal(f.counters.physicalClose, 99);
});

test('M54关闭证明：行间注入真实FD close失败时整页BUSY且不发布部分DTO', async t => {
  const f = fixture(t), message = channel(t, () => f.failClose(5)); f.onFirstPhysical(message.send);
  const reply = await f.owner.dispatchMobile(f.request()); await message.received;
  failure(reply, 503, 'BUSY');
  assert.equal(f.counters.physicalOpen, 6); assert.equal(f.counters.physicalClose, 5);
});

test('M54同步合同：dispatchCurrentCatalog保持同步且不在原事务中处理行间消息', async t => {
  const f = fixture(t); let rowsAtMessage = -1;
  const message = channel(t, () => { rowsAtMessage = f.counters.physicalOpen; }); f.onFirstPhysical(message.send);
  const reply = f.owner.dispatchCurrentCatalog(f.request());
  assert.ok(!('then' in reply)); assert.equal(snapshot(reply).items.length, 100);
  assert.equal(rowsAtMessage, -1); await message.received; assert.equal(rowsAtMessage, 100);
});

test('M54原Store解析帧：异步百行仍逐次实读batch/origin/ledger，同文只解析一次且下页重核', async t => {
  const f = await displayMemoFixture(t, 100); await f.projection.refresh();
  const parses = displayBatchParses(t, f.batch.batchId), reads = displayReads(t, f.db);
  const request: MobileOwnerCatalogRequest = { operation: 'listTracks', serverId: 'server.synthetic-page', offset: 0, limit: 100,
    q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: false };
  const page = await f.projection.catalogAsync(request);
  assert.equal(page.items.length, 100); assert.equal(page.total, 100);
  assert.deepEqual(reads.counts, { batch: 100, origin: 100, ledger: 100 }); assert.equal(parses.count(), 1);
  await f.projection.catalogAsync(request);
  assert.deepEqual(reads.counts, { batch: 200, origin: 200, ledger: 200 }); assert.equal(parses.count(), 2);
});

const seed = (nonce: string) => ({ schema: 1, requestSha256: 'a'.repeat(64), nonceSha256: nonce.repeat(64), offset: 0, limit: 100 });
const traced = <T>(nonce: string, lines: string[], work: () => T) => withCatalogTrace(seed(nonce), 'owner', work, line => lines.push(line));
const fallbackRecords = (lines: string[]) => lines.map(line => copyCatalogTraceRecord(JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length))))
  .filter(record => record?.stage === 'owner.catalog.prepare-fallback');

test('M54准备预算：超2MiB回原完整同步整页，释放后下次仍可公平让出', async t => {
  const f = fixture(t), lines: string[] = []; f.setEditions(200);
  const original = snapshot(f.owner.dispatchCurrentCatalog(f.request()));
  const result = snapshot(await traced('c', lines, () => f.owner.dispatchMobile(f.request())));
  assert.equal(digest(result), digest(original)); assert.equal(result.items.length, 100);
  assert.equal(fallbackRecords(lines).length, 1);
  assert.equal(fallbackRecords(lines)[0]?.count, 1); assert.equal(fallbackRecords(lines)[0]?.matched, false);
  f.setEditions(0); const previous = f.counters.physicalOpen; let readAt = -1;
  const message = channel(t, () => { readAt = f.counters.physicalOpen - previous; }); f.onFirstPhysical(message.send);
  const nextLines: string[] = [];
  assert.equal(snapshot(await traced('d', nextLines, () => f.owner.dispatchMobile(f.request()))).items.length, 100);
  await message.received;
  assert.ok(readAt >= 1 && readAt < 100); assert.equal(fallbackRecords(nextLines).length, 0);
});

test('M54并发预算：同projection共用准备量，重叠请求fallback后成功与finally都释放', async t => {
  const f = fixture(t); f.setEditions(25);
  const firstLines: string[] = [], secondLines: string[] = []; let second: Promise<MobileOwnerPrivateResult> | undefined;
  const message = channel(t, () => { second = traced('f', secondLines, () => f.owner.dispatchMobile(f.request())); });
  f.onFirstPhysical(message.send);
  const first = snapshot(await traced('e', firstLines, () => f.owner.dispatchMobile(f.request()))); await message.received;
  assert.ok(second); const other = snapshot(await second);
  assert.equal(digest(first), digest(other)); assert.equal(first.items.length, 100);
  assert.equal(fallbackRecords(firstLines).length, 0); assert.equal(fallbackRecords(secondLines).length, 1);
  const afterLines: string[] = [];
  assert.equal(snapshot(await traced('a', afterLines, () => f.owner.dispatchMobile(f.request()))).items.length, 100);
  assert.equal(fallbackRecords(afterLines).length, 0, '完成/并发退出必须还清逻辑准备预算。');
});

test('M54异常预算：准备中异常、行间事实改变和close失败后同projection不残留准备量', async t => {
  for (const kind of ['prepare', 'facts', 'release'] as const) await t.test(kind, async child => {
    const f = fixture(child); f.setEditions(25);
    let message: ReturnType<typeof channel> | undefined;
    if (kind === 'prepare') f.failParameters();
    else {
      message = channel(child, () => { if (kind === 'facts') f.changeFacts(); else f.failClose(5); });
      f.onFirstPhysical(message.send);
    }
    const reply = await f.owner.dispatchMobile(f.request()); if (message) await message.received;
    failure(reply, kind === 'facts' ? 409 : 503, kind === 'facts' ? 'SOURCE_CHANGED' : 'BUSY');
    f.clearFailures(); const lines: string[] = [];
    assert.equal(snapshot(await traced('b', lines, () => f.owner.dispatchMobile(f.request()))).items.length, 100);
    assert.equal(fallbackRecords(lines).length, 0, '异常finally必须释放同projection的共享准备量。');
  });
});

test('M54准备旁注：TS与便携guard只收固定fallback闭集，不执行getter/Proxy或增加预算', async () => {
  const moduleUrl = new URL('../../../../scripts/diagnostics/mobile/catalog-private-record-guard.mjs', import.meta.url).href;
  const portable = await import(moduleUrl) as { copyCatalogPrivateRecord(raw: unknown): unknown };
  const base = { ...seed('a'), component: 'owner', sequence: 1, epochMs: 1, elapsedMs: 0,
    rowOrdinal: null, stage: 'owner.catalog.prepare-fallback', phase: 'ok', role: 'business', code: 'OK', matched: false, count: 1 };
  assert.ok(copyCatalogTraceRecord(base)); assert.ok(portable.copyCatalogPrivateRecord(base));
  for (const patch of [{ count: 0 }, { count: 2 }, { matched: true }, { matched: null }, { rowOrdinal: 1 },
    { phase: 'begin' }, { phase: 'reject' }, { role: 'cleanup' }, { component: 'main' }, { extra: 1 }, { stage: 'owner.catalog.prepare-fallback.raw' }]) {
    assert.equal(copyCatalogTraceRecord({ ...base, ...patch }), null);
    assert.equal(portable.copyCatalogPrivateRecord({ ...base, ...patch }), null);
  }
  let getter = 0, trap = 0;
  const accessor = Object.defineProperty({ ...base }, 'count', { enumerable: true, get() { getter++; return 1; } });
  const proxy = new Proxy(base, { ownKeys() { trap++; return Reflect.ownKeys(base); } });
  for (const guard of [copyCatalogTraceRecord, portable.copyCatalogPrivateRecord]) {
    assert.equal(guard(accessor), null); assert.equal(guard(proxy), null);
    assert.equal(guard({ ...base, [Symbol('合成额外键')]: 1 }), null);
  }
  assert.equal(getter, 0); assert.equal(trap, 0);
});
