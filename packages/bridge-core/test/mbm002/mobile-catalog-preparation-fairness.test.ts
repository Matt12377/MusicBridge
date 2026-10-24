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
  const directory = fs.mkdtempSync(path.join(temporary, 'mac59-catalog-'));
  fs.chmodSync(directory, 0o700);
  const media = path.join(directory, 'media'), state = path.join(directory, 'state');
  fs.mkdirSync(media, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  const rootInfo = fs.lstatSync(media, { bigint: true });
  let revision = 'scope:1', active = true, authorized = true, frameActive = false, firstPhysical: (() => void) | undefined;
  let failCloseIndex: number | null = null;
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
      const page = { revision, total: count, items: rows().slice(request.offset, request.offset + request.limit) };
      if (afterSql) { const action = afterSql; afterSql = undefined; action(); }
      return page; } },
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
  return { owner, request, counters,
    onSql(action: () => void) { afterSql = action; },
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

const seed = (nonce: string) => ({ schema: 1, requestSha256: 'a'.repeat(64), nonceSha256: nonce.repeat(64), offset: 0, limit: 100 });
const traced = <T>(nonce: string, lines: string[], work: () => T) => withCatalogTrace(seed(nonce), 'owner', work, line => lines.push(line));
const fallbacks = (lines: string[]) => lines.map(line => copyCatalogTraceRecord(JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length))))
  .filter(record => record?.stage === 'owner.catalog.prepare-fallback');

test('M59公平性：SQL中已排入的真实授权消息必须先于首行同步准备执行', async t => {
  const f = fixture(t); let detailAtMessage = -1, parametersAtMessage = -1;
  const message = channel(t, async () => {
    detailAtMessage = f.counters.detail; parametersAtMessage = f.counters.parameters;
    assert.equal(f.frame(), false, '让出时不能保留同步解析帧。');
    assert.deepEqual(await f.owner.dispatchMobile({ kind: 'load', datasetId: DATASET }),
      { kind: 'missing', datasetId: DATASET, revision: 0 });
  });
  f.onSql(message.send);
  const page = snapshot(await f.owner.dispatchMobile(f.request())); await message.received;
  assert.equal(detailAtMessage, 0, 'SQL后仍连续准备整页，授权消息到首行准备之后才执行。');
  assert.equal(parametersAtMessage, 0);
  assert.equal(page.items.length, 100); assert.equal(f.counters.physicalOpen, 100); assert.equal(f.counters.physicalClose, 100);
  t.diagnostic(JSON.stringify({ schema: 'mb.mac59.prepare-fairness.v1', detailAtMessage, parametersAtMessage,
    rows: page.items.length, frames: f.counters.frames }));
});

test('M59差分：百行完整DTO及逐行Source/Scan/真实FD次数保持原同步合同', async t => {
  const f = fixture(t), request = f.request();
  const expected = snapshot(f.owner.dispatchCurrentCatalog(request)), counts = { ...f.counters };
  const actual = snapshot(await f.owner.dispatchMobile(request));
  assert.equal(digest(actual), digest(expected)); assert.equal(actual.items.length, 100);
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) assert.equal(f.counters[key], counts[key] * 2, key);
  assert.equal(counts.physicalOpen, 100); assert.equal(counts.physicalClose, 100);
  assert.equal(counts.track, 400); assert.equal(counts.state, 400); assert.equal(counts.currentState, 400); assert.equal(counts.job, 400);
  assert.equal(counts.parameters, 100); assert.equal(counts.frames, 1);
  t.diagnostic(JSON.stringify({ schema: 'mb.mac59.prepare-differential.v1', rows: 100,
    synchronousSha256: digest(expected), asynchronousSha256: digest(actual), perPageCounts: counts }));
});

test('M59等待围栏：SQL后换代、撤销或事实改变时整页拒绝，不发布前缀', async t => {
  for (const kind of ['close', 'revoke', 'facts'] as const) await t.test(kind, async child => {
    const f = fixture(child), message = channel(child, () => {
      if (kind === 'close') f.close(); else if (kind === 'revoke') f.revoke(); else f.changeFacts();
    });
    f.onSql(message.send);
    const reply = await f.owner.dispatchMobile(f.request()); await message.received;
    failure(reply, kind === 'close' ? 503 : 409, kind === 'close' ? 'BUSY' : 'SOURCE_CHANGED');
    assert.ok(f.counters.physicalOpen < 100);
    assert.equal(f.frame(), false);
  });
});

test('M59物理fresh：SQL后文件变化仍逐文件重核，不能借准备页授予旧资格', async t => {
  const f = fixture(t), message = channel(t, f.changeFile); f.onSql(message.send);
  const page = snapshot(await f.owner.dispatchMobile(f.request())); await message.received;
  assert.equal(page.items.length, 100);
  assert.equal(page.items.filter(item => 'availability' in item && item.availability === 'available').length, 99);
  assert.equal(f.counters.physicalOpen, 99); assert.equal(f.counters.physicalClose, 99);
});

test('M59同步入口：原同步目录没有新增让出或中途处理消息', async t => {
  const f = fixture(t); let parametersAtMessage = -1;
  const message = channel(t, () => { parametersAtMessage = f.counters.parameters; }); f.onSql(message.send);
  const result = f.owner.dispatchCurrentCatalog(f.request()); assert.ok(!('then' in result));
  assert.equal(snapshot(result).items.length, 100); assert.equal(parametersAtMessage, -1);
  await message.received; assert.equal(parametersAtMessage, 100);
});

test('M59页预算：合法大SQL页超原共享2MiB时完整同步fallback，释放后可再次公平准备', async t => {
  const f = fixture(t), lines: string[] = []; f.setTokens(32);
  const expected = snapshot(f.owner.dispatchCurrentCatalog(f.request()));
  const before = { parameters: f.counters.parameters, sql: f.counters.sql };
  const actual = snapshot(await traced('b', lines, () => f.owner.dispatchMobile(f.request())));
  assert.equal(digest(actual), digest(expected)); assert.equal(actual.items.length, 100);
  assert.equal(f.counters.parameters - before.parameters, 100, 'SQL页超界必须在准备前回退，不能先额外准备一段。');
  assert.equal(f.counters.sql - before.sql, 2, '回退仍按原同步入口重新读取整页。');
  assert.equal(fallbacks(lines).length, 1); assert.equal(fallbacks(lines)[0]?.count, 1); assert.equal(fallbacks(lines)[0]?.matched, false);
  f.setTokens(0); let at = -1; const nextLines: string[] = [];
  const message = channel(t, () => { at = f.counters.parameters; }); f.onSql(message.send);
  const previous = f.counters.parameters;
  assert.equal(snapshot(await traced('c', nextLines, () => f.owner.dispatchMobile(f.request()))).items.length, 100);
  await message.received; assert.equal(at, previous); assert.equal(fallbacks(nextLines).length, 0);
});

test('M59临时页并发：仅各自可容纳的SQL页同时跨yield也必须共用预算，不能藏在闭包计费之外', async t => {
  const f = fixture(t); f.setTokens(5);
  const isolatedLines: string[] = [];
  const expected = snapshot(await traced('a', isolatedLines, () => f.owner.dispatchMobile(f.request())));
  assert.equal(fallbacks(isolatedLines).length, 0, '合成单页应确实具备公平准备资格。');
  const firstLines: string[] = [], otherLines: string[] = [];
  let other: Promise<MobileOwnerPrivateResult> | undefined;
  const message = channel(t, () => { other = traced('c', otherLines, () => f.owner.dispatchMobile(f.request())); });
  f.onSql(message.send);
  const first = snapshot(await traced('b', firstLines, () => f.owner.dispatchMobile(f.request()))); await message.received;
  assert.ok(other); const second = snapshot(await other);
  assert.equal(digest(first), digest(expected)); assert.equal(digest(second), digest(expected));
  assert.equal(fallbacks(firstLines).length + fallbacks(otherLines).length, 1, 'SQL暂持页也须计入共享2MiB。');
  const afterLines: string[] = [];
  assert.equal(digest(snapshot(await traced('d', afterLines, () => f.owner.dispatchMobile(f.request())))), digest(expected));
  assert.equal(fallbacks(afterLines).length, 0, '并发fallback后临时页与闭包预算都必须归还。');
});

test('M59并发预算：临时SQL页与已准备闭包共用上限，fallback不妨碍其他请求及后续恢复', async t => {
  const f = fixture(t); f.setEditions(25);
  const firstLines: string[] = [], otherLines: string[] = [];
  let other: Promise<MobileOwnerPrivateResult> | undefined;
  const message = channel(t, () => { other = traced('e', otherLines, () => f.owner.dispatchMobile(f.request())); });
  f.onFirstPhysical(message.send);
  const first = snapshot(await traced('d', firstLines, () => f.owner.dispatchMobile(f.request()))); await message.received;
  assert.ok(other); const second = snapshot(await other);
  assert.equal(digest(first), digest(second)); assert.equal(first.items.length, 100);
  assert.equal(fallbacks(firstLines).length, 0); assert.equal(fallbacks(otherLines).length, 1);
  const after: string[] = [];
  assert.equal(snapshot(await traced('f', after, () => f.owner.dispatchMobile(f.request()))).items.length, 100);
  assert.equal(fallbacks(after).length, 0);
});

test('M59退出预算：prepare异常、等待期事实变化和真实close失败后预算全部释放', async t => {
  for (const kind of ['prepare', 'facts', 'release'] as const) await t.test(kind, async child => {
    const f = fixture(child); f.setEditions(25);
    let message: ReturnType<typeof channel> | undefined;
    if (kind === 'prepare') f.failParameters();
    else {
      message = channel(child, () => { if (kind === 'facts') f.changeFacts(); else f.failClose(5); });
      if (kind === 'facts') f.onSql(message.send); else f.onFirstPhysical(message.send);
    }
    const reply = await f.owner.dispatchMobile(f.request()); if (message) await message.received;
    failure(reply, kind === 'facts' ? 409 : 503, kind === 'facts' ? 'SOURCE_CHANGED' : 'BUSY');
    f.clearFailures(); const lines: string[] = [];
    assert.equal(snapshot(await traced('a', lines, () => f.owner.dispatchMobile(f.request()))).items.length, 100);
    assert.equal(fallbacks(lines).length, 0, '全部finally必须归还同projection共享预算。');
  });
});
