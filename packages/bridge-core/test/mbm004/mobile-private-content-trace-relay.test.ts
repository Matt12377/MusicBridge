import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MOBILE_OPERATION_TABLE } from '@music-bridge/contracts';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { createMobileContentProviderService } from '../../src/mobile/content-provider-service.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import { createMobileCapabilityContext, withMobileCapabilityContext, createMobileContentSampleSelector, mobileCapabilitySync, mobileCapabilityReject, closeMobileCapabilityContext } from '../../src/mobile/capability-trace.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { NeteaseMobileReadPort, NeteaseMobileReadRequest, NeteaseMobileAccountInvalidation } from '../../src/netease/types.js';
import { createMobilePrivateContentTraceRelay, copyMobileCollectionTraceRecord, MOBILE_COLLECTION_TRACE_PREFIX } from '../../src/mobile/private-content-trace-relay.js';
import { createMobileCapabilityTraceReader, type MobileCapabilityTraceRecord } from '../../src/mobile/capability-trace.js';
import { projectMobileReadResponse } from '../../src/netease/mobile-read-response.js';

const signal = () => new AbortController().signal;
const changed = (e: unknown) => e instanceof MobileServiceError && e.code === 'SOURCE_CHANGED';
function request(operation: 'getNeteaseLikedPlaylist' | 'listNeteaseLikedPlaylistTracks', query: Record<string, string | number> = {}) {
  return captureMobileContentRequest(operation, { path: MOBILE_OPERATION_TABLE[operation].path, pathParameters: {}, query, body: null });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, diagnostics = false, memberCount = 121) {
  let clock = 1700000000000, accountId = '700', epoch = 'epoch1', revoked = false, detailQualified = true;
  let invalidSecondPage = false, invalidSong = '51';
  let marker: string | number = 5, owner = '700', updateTime: string | number = 1;
  let cover = 'https://p1.music.126.net/synthetic-cover.jpg', title = '合成红心';
  let members = Array.from({ length: memberCount }, (_, i) => String(i + 1));
  let gate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const calls: NeteaseMobileReadRequest[] = [], listeners = new Set<(event: NeteaseMobileAccountInvalidation) => void>();
  const client: NeteaseMobileReadPort = {
    get configured() { return true; },
    async mobileAccount() { return { accountId, providerEpoch: epoch }; },
    onMobileAccountInvalidated(f) { listeners.add(f); return () => listeners.delete(f); }, async awaitMobileQuiet() {},
    async mobileRead(r) {
      calls.push(r); let body: unknown;
      switch (r.operation) {
        case 'user-playlists': body = { code: 200, more: false, playlist: [{ id: '9', specialType: 5, creator: { userId: accountId } }] }; break;
        case 'playlist-detail':
          if (gate) { const hold = gate; gate = undefined; hold.entered.resolve(); await hold.release.promise; }
          body = { code: 200, playlist: { id: r.id, name: title, trackCount: members.length, trackIds: members.map(id => ({ id })),
            updateTime, coverImgUrl: cover, ...(detailQualified ? { specialType: marker, creator: { userId: owner } } : {}) } }; break;
        case 'song-detail': body = { code: 200, songs: r.ids.map(id => ({ id, name: '合成曲' + id,
          ar: [{ id: '1', name: '合成艺人' }], al: { id: '5', name: '合成专辑' }, dt: invalidSecondPage && id === invalidSong ? 0 : 1000, alia: [] })) }; break;
        case 'streams': body = { code: 200, data: r.ids.map(id => ({ id, code: 200, freeTrialInfo: null,
          md5: 'a'.repeat(32), size: 150000, expi: 300, url: 'https://synthetic.invalid/a.flac', level: 'hires', type: 'flac', br: 1000 })) }; break;
        default: throw new Error('未授权的合成操作');
      }
      // 经过与真实SDK相同的有限投影，证明资格字段确实可到达适配器。
      return { providerEpoch: epoch, response: projectMobileReadResponse({ body }, r.operation) };
    },
  };
  const actual = createActualMobileNeteasePorts({ client, serverId: 'server1', datasetId: 'dataset1', ownerEpoch: 'owner1',
    identityKey32: new Uint8Array(32).fill(23), now: () => clock, privateProviderDiagnostics: diagnostics,
    assertCurrent: async () => { if (revoked) throw new MobileServiceError(403, 'RESOURCE_REVOKED'); } });
  const account = await actual.account.current(signal()); assert.ok(account);
  const scope = { serverId: 'server1', datasetId: 'dataset1', ownerEpoch: 'owner1', deviceId: 'device1', deviceEpoch: 1, accessGeneration: 1, ...account };
  const provider = createMobileContentProviderService({ provider: actual.provider, cursorKey: new Uint8Array(32).fill(19), now: () => clock,
    assertCurrent: s => actual.assertCurrent(s, 'acquire', signal()) });
  t.after(async () => { gate?.release.resolve(); provider.close(); await actual.close(); });
  const summary = () => provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope, signal: signal() });
  const initial = await summary();
  const query = { playlistId: initial.reply.body.playlistId, playlistRevision: initial.reply.body.playlistRevision, accountDomain: scope.accountDomain, limit: 50 };
  const page = (cursor?: string, owned = signal()) => provider.dispatch({ operation: 'listNeteaseLikedPlaylistTracks',
    request: request('listNeteaseLikedPlaylistTracks', { ...query, ...(cursor ? { cursor } : {}) }), scope, signal: owned });
  return { actual, provider, scope, calls, page, initial, summary, invalidSecondPage: (id = '51') => { invalidSecondPage = true; invalidSong = id; },
    setTime: (v: number | string) => { updateTime = v; }, setCover: (v: string) => { cover = v; },
    setTitle: (v: string) => { title = v; }, setMembers: (v: string[]) => { members = v; },
    setQualification: (v: boolean) => { detailQualified = v; }, setOwner: (v: string) => { owner = v; }, setMarker: (v: string | number) => { marker = v; },
    revoke: () => { revoked = true; },
    accountChange: () => { epoch = 'epoch2'; accountId = '701'; clock += 10001; for (const f of listeners) f({ previousProviderEpoch: 'epoch1', nextProviderEpoch: epoch }); },
    block: () => { gate = { entered: deferred(), release: deferred() }; return gate; } };
}

function capability(phase: 'ok' | 'reject' = 'ok', ordinal = 1): MobileCapabilityTraceRecord {
  return { schema: 'mb.mobile-capability-trace.v1', component: 'core', requestSha256: ordinal.toString(16).padStart(64, '0'),
    parentSha256: null, relatedSha256: null, epochMs: 1, elapsedMs: 0, stage: 'provider.content.mapping.duration', phase,
    role: 'business', name: phase === 'reject' ? 'MobileServiceError' : 'UNKNOWN', code: phase === 'reject' ? 'SOURCE_CHANGED' : 'OK',
    outcome: null, aborted: null, initState: 'none' };
}
function collection() {
  return { schema: 'mb.mobile-collection-trace.v1', requestSha256: 'a'.repeat(64), epochMs: 1, stage: 'liked.revision.compare',
    baselinePresent: true, expectedPresent: true, revisionEqual: true, accountDomainEqual: true, ownerEpochEqual: true,
    providerEpochEqual: true, collectionIdEqual: true, trackIdsEqual: true, titleEqual: true, artworkIdentityEqual: true,
    updateTimeEqual: false, firstOffset: 0, offset: 50 };
}

test('M23 默认关闭零输出；仅重新捕获的闭集Core记录进入普通feed出口', () => {
  for (const enabled of [false, true]) {
    const lines: string[] = [], relay = createMobilePrivateContentTraceRelay({ enabled, sink: line => lines.push(line) });
    relay.capability(capability()); relay.collection(MOBILE_COLLECTION_TRACE_PREFIX + JSON.stringify(collection()) + '\n');
    relay.capability({ ...capability(), url: 'https://must-not-pass.invalid' } as MobileCapabilityTraceRecord);
    relay.capability({ ...capability(), component: 'main' });
    relay.collection('arbitrary-private-output\n'); assert.equal(lines.length, enabled ? 2 : 0);
  }
});

test('M23 collection reader严格闭集，坏行/过长行后继续，分块接收且不调用getter/proxy', () => {
  let evaluated = 0;
  const getter = { ...collection() }; Object.defineProperty(getter, 'offset', { enumerable: true, get() { evaluated++; return 50; } });
  assert.equal(copyMobileCollectionTraceRecord(getter), null);
  assert.equal(copyMobileCollectionTraceRecord(new Proxy(collection(), { get() { evaluated++; return 'private'; } })), null);
  assert.equal(evaluated, 0);
  for (const raw of [{ ...collection(), url: 'private' }, { ...collection(), trackIdsEqual: 'private' },
    { ...collection(), offset: 10001 }, { ...collection(), firstOffset: -1 }, { ...collection(), schema: 'other' },
    { ...collection(), requestSha256: 'private' }, { ...collection(), stage: 'unknown' }]) assert.equal(copyMobileCollectionTraceRecord(raw), null);
  const lines: string[] = [], relay = createMobilePrivateContentTraceRelay({ enabled: true, sink: line => lines.push(line) });
  relay.collection('x'.repeat(5000) + '\n' + MOBILE_COLLECTION_TRACE_PREFIX + '{bad-json}\n');
  const valid = MOBILE_COLLECTION_TRACE_PREFIX + JSON.stringify(collection()) + '\n';
  relay.collection(valid.slice(0, 33)); assert.equal(lines.length, 0); relay.collection(valid.slice(33));
  assert.equal(lines.length, 1); assert.deepEqual(JSON.parse(lines[0]!.slice(MOBILE_COLLECTION_TRACE_PREFIX.length)), collection());
});

test('M23 独立collection 64行64KiB预算及Core2048普通行后首拒保留，sink失败不扩大预算', () => {
  const lines: string[] = [], relay = createMobilePrivateContentTraceRelay({ enabled: true, sink: line => lines.push(line) });
  const valid = MOBILE_COLLECTION_TRACE_PREFIX + JSON.stringify(collection()) + '\n';
  for (let i = 0; i < 70; i++) relay.collection(valid);
  assert.equal(lines.length, 64); assert.ok(Buffer.byteLength(lines.join('')) <= 64 * 1024);
  for (let i = 0; i < 2050; i++) relay.capability(capability());
  assert.equal(lines.length, 64 + 2048);
  for (let i = 0; i < 130; i++) relay.capability(capability('reject', i + 2));
  assert.equal(lines.length, 64 + 2048 + 128);
  let attempts = 0; const failed = createMobilePrivateContentTraceRelay({ enabled: true, sink() { attempts++; throw new Error('合成写失败'); } });
  for (let i = 0; i < 70; i++) failed.collection(valid); assert.equal(attempts, 64);
});

test('M23 正式红心50+cursor第二页同码409：revision相等时真实映射首拒可穿过安全reader', async t => {
  const f = await fixture(t, true), forwarded: string[] = [];
  const relay = createMobilePrivateContentTraceRelay({ enabled: true, sink: line => forwarded.push(line) });
  const capabilityReader = createMobileCapabilityTraceReader(row => relay.capability(row));
  const observe = <T>(work: () => Promise<T>) => {
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { capabilityReader(line); relay.collection(line); })!;
    context.privateContentDiagnostic = true; return withMobileCapabilityContext(context, work);
  };
  await observe(() => f.summary()); const first = await observe(() => f.page()); assert.equal(first.reply.body.items.length, 50);
  f.invalidSecondPage(); await assert.rejects(observe(() => f.page(first.reply.body.nextCursor!)), changed);
  const records = forwarded.filter(line => line.startsWith('MUSICBRIDGE_MOBILE_CAPABILITY_TRACE ')).map(line => JSON.parse(line.slice('MUSICBRIDGE_MOBILE_CAPABILITY_TRACE '.length)));
  assert.ok(records.some(r => r.stage === 'provider.content.mapping.duration' && r.phase === 'reject' && r.code === 'SOURCE_CHANGED'));
  const compared = forwarded.filter(line => line.startsWith(MOBILE_COLLECTION_TRACE_PREFIX)).map(line => JSON.parse(line.slice(MOBILE_COLLECTION_TRACE_PREFIX.length)));
  assert.ok(compared.some(r => r.offset === 50 && r.revisionEqual === true && r.trackIdsEqual === true));
  assert.doesNotMatch(forwarded.join(''), /synthetic-cover|nc:|https?:|owner1|epoch1/);
});

test('M23 正式红心第二页真实集合变化：闭集revision比较false与mapping首拒都能转发', async t => {
  const f = await fixture(t, true), lines: string[] = [];
  const relay = createMobilePrivateContentTraceRelay({ enabled: true, sink: line => lines.push(line) });
  const reader = createMobileCapabilityTraceReader(row => relay.capability(row));
  const observe = <T>(work: () => Promise<T>) => { const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => { reader(line); relay.collection(line); })!;
    context.privateContentDiagnostic = true; return withMobileCapabilityContext(context, work); };
  await observe(() => f.summary()); const first = await observe(() => f.page()); f.setTitle('合成真实改名');
  await assert.rejects(observe(() => f.page(first.reply.body.nextCursor!)), changed);
  assert.ok(lines.some(line => line.includes('"stage":"provider.content.mapping.revision-mismatch"') && line.includes('"phase":"reject"')));
  const compared = lines.filter(line => line.startsWith(MOBILE_COLLECTION_TRACE_PREFIX)).map(line => JSON.parse(line.slice(MOBILE_COLLECTION_TRACE_PREFIX.length)));
  assert.ok(compared.some(r => r.offset === 50 && r.revisionEqual === false && r.titleEqual === false));
});


for (const failingPage of [9, 20]) test(`M25 第${failingPage}页真实合成mapping首拒在Core普通2048饱和后仍传到Main`, async t => {
  const f = await fixture(t, true, 1251), lines: string[] = [];
  const selector = createMobileContentSampleSelector();
  const relay = createMobilePrivateContentTraceRelay({ enabled: true, sink: line => lines.push(line) });
  const coreReader = createMobileCapabilityTraceReader(row => relay.capability(row));
  for (let i = 0; i < 2048; i++) relay.capability(capability('ok', i + 1));
  const baseline = lines.length;
  let cursor: string | undefined;
  for (let page = 1; page <= failingPage; page++) {
    const sample = selector.claim('listNeteaseLikedPlaylistTracks');
    assert.ok(sample, `第${page}页必须仍建立HTTP诊断上下文`);
    const main = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, signal(), line => lines.push(line))!;
    main.deferredRecords = []; main.httpTerminalReserve = true; main.privateContentDiagnostic = true;
    const core = createMobileCapabilityContext(randomUUID(), 'core', 'content', main.requestSha256, signal(), line => coreReader(line))!;
    core.privateContentDiagnostic = main.privateContentDiagnostic;
    if (page === failingPage) f.invalidSecondPage(String((page - 1) * 50 + 1));
    try {
      const result = await withMobileCapabilityContext(core, () => f.page(cursor));
      cursor = result.reply.body.nextCursor ?? undefined;
      withMobileCapabilityContext(main, () => mobileCapabilitySync('http.send', () => undefined));
      sample.finish(main, 200, false, true);
      assert.notEqual(page, failingPage, '真实映射错误必须拒绝整页，不能只伪造诊断行');
    } catch (error) {
      assert.equal(page, failingPage); assert.ok(changed(error));
      withMobileCapabilityContext(main, () => mobileCapabilityReject('preparation.http.dispatch', error));
      sample.finish(main, 409, true, true);
    } finally { closeMobileCapabilityContext(core); closeMobileCapabilityContext(main); }
  }
  const rows: MobileCapabilityTraceRecord[] = [];
  const read = createMobileCapabilityTraceReader(row => rows.push(row));
  lines.slice(baseline).forEach(read);
  assert.ok(rows.some(row => row.component === 'core' && row.stage === 'provider.content.mapping.duration' && row.phase === 'reject' && row.code === 'SOURCE_CHANGED'));
  assert.ok(rows.some(row => row.component === 'main' && row.stage === 'http.discovery.liked-tracks.409' && row.phase === 'reject' && row.code === 'SOURCE_CHANGED'));
  assert.equal(rows.some(row => row.stage === 'http.discovery.liked-tracks.failure-unknown'), false);
});

test('M25 红心固定512次有限窗口，只有首代表成功和首失败；其他分页操作仍八次', () => {
  const selector = createMobileContentSampleSelector(), lines: string[] = [];
  for (let page = 1; page <= 512; page++) {
    const sample = selector.claim('listNeteaseLikedPlaylistTracks'); assert.ok(sample);
    const context = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, signal(), line => lines.push(line))!;
    context.deferredRecords = [];
    withMobileCapabilityContext(context, () => mobileCapabilitySync('http.send', () => undefined));
    sample.finish(context, 200, false, true); closeMobileCapabilityContext(context);
    if (page < 512) assert.equal(lines.some(line => line.includes('failure-unknown')), false);
  }
  assert.equal(selector.claim('listNeteaseLikedPlaylistTracks'), undefined);
  const rows: MobileCapabilityTraceRecord[] = []; const read = createMobileCapabilityTraceReader(row => rows.push(row)); lines.forEach(read);
  assert.equal(rows.filter(row => row.stage === 'http.discovery.liked-tracks.200').length, 1);
  assert.equal(rows.filter(row => row.stage === 'http.discovery.liked-tracks.failure-unknown' && row.phase === 'cache').length, 1);
  assert.ok(rows.length <= 65, '一次首成功最多64条，加一条固定耗尽旁注；不随512个成功页无限落盘');
  for (const operation of ['listPersonalPlaylists', 'listNeteaseRecommendedPlaylists', 'getNeteaseDiscoveryCollectionTracks']) {
    for (let i = 0; i < 8; i++) assert.ok(selector.claim(operation));
    assert.equal(selector.claim(operation), undefined);
  }
});
