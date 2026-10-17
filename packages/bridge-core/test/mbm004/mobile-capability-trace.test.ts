import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOBILE_CAPABILITY_TRACE_PREFIX, captureMobileCapabilityContext, closeMobileCapabilityContext,
  copyMobileCapabilityTraceRecord, copyMobileCapabilityTraceSnapshot, createMobileCapabilityContext,
  createMobileCapabilityTraceCollector, createMobileCapabilityTraceReader, createMobileContentSampleSelector, mobileCapabilityAsync,
  mobileCapabilityReject, mobileCapabilityRequestSha, mobileCapabilitySync, withMobileCapabilityContext,
  type MobileCapabilityTraceRecord,
} from '../../src/mobile/capability-trace.js';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const failure = () => Object.assign(new Error('私密正文不能进入旁注'), { name: 'MobileServiceError', code: 'BUSY', outcome: 'not-sent' });
const decode = (lines: string[]): MobileCapabilityTraceRecord[] => {
  const rows: MobileCapabilityTraceRecord[] = [];
  const read = createMobileCapabilityTraceReader(row => { rows.push(row); });
  for (const line of lines) read(line);
  return rows;
};

test('私有HTTP首成功不耗尽后续图片首错，普通旁注饱和仍保安全码与发送终态且每批不超过64', () => {
  const selector = createMobileContentSampleSelector(), lines: string[] = [];
  const sample = (failed: boolean) => {
    const claim = selector.claim('getArtwork'); assert.ok(claim);
    const context = createMobileCapabilityContext(firstId, 'main', 'http', null, undefined, line => { lines.push(line); }); assert.ok(context);
    context.deferredRecords = []; context.httpTerminalReserve = true;
    withMobileCapabilityContext(context, () => {
      for (let index = 0; index < 100; index++) mobileCapabilitySync('main.current', () => undefined);
      if (failed) mobileCapabilityReject('http.failure', failure());
      mobileCapabilitySync(failed ? 'http.status.503' : 'http.status.200', () => undefined);
      mobileCapabilitySync('http.send', () => undefined);
    });
    const start = lines.length; claim.finish(context, failed ? 503 : 200, failed, true);
    claim.finish(context, 401, true, true); // 同一需求的迟到收尾不能重复发布。
    const rows = decode(lines.slice(start)); assert.ok(rows.length <= 64);
    assert.ok(rows.some(row => row.stage === 'http.send' && row.phase === 'ok'));
    closeMobileCapabilityContext(context); return rows;
  };
  assert.ok(sample(false).some(row => row.stage === 'http.discovery.artwork.200' && row.phase === 'ok'));
  const failed = sample(true);
  assert.ok(failed.some(row => row.stage === 'http.discovery.artwork.503' && row.phase === 'reject' && row.code === 'BUSY'));
  assert.ok(failed.some(row => row.stage === 'http.failure' && row.phase === 'reject'));
  assert.equal(selector.claim('getArtwork'), undefined);
  assert.equal(selector.claim('getMediaAsset'), undefined);
  assert.doesNotMatch(lines.join(''), /私密正文|message|stack|https?:|artworkId/u);
});

test('私有HTTP探针八次未捕获失败明确UNKNOWN，五种发现和UI各有独立首错槽', () => {
  const selector = createMobileContentSampleSelector(), lines: string[] = [];
  for (let index = 0; index < 8; index++) {
    const claim = selector.claim('getArtwork'); assert.ok(claim);
    const context = createMobileCapabilityContext(secondId, 'main', 'http', null, undefined, line => { lines.push(line); }); assert.ok(context);
    context.deferredRecords = []; context.httpTerminalReserve = true;
    withMobileCapabilityContext(context, () => mobileCapabilitySync('http.send', () => undefined));
    claim.finish(context, 200, false, true); closeMobileCapabilityContext(context);
  }
  assert.equal(selector.claim('getArtwork'), undefined);
  const rows = decode(lines);
  assert.equal(rows.filter(row => row.stage === 'http.discovery.artwork.200').length, 1);
  assert.ok(rows.some(row => row.stage === 'http.discovery.artwork.failure-unknown' && row.code === 'UNKNOWN' && row.outcome === 'unknown'));
  for (const [operation, name] of [['getUIContentCapabilities','ui'], ['listTracks','tracks'], ['getNeteaseDailyRecommendations','daily'],
    ['listNeteaseRecommendedPlaylists','recommended'], ['listNeteaseNewAlbums','albums'], ['listNeteaseCharts','charts'], ['getNeteasePersonalFM','fm']]) {
    const claim = selector.claim(operation!); assert.ok(claim);
    const context = createMobileCapabilityContext(firstId, 'main', 'http', null, undefined, line => { lines.push(line); }); assert.ok(context);
    context.deferredRecords = [];
    withMobileCapabilityContext(context, () => mobileCapabilityReject('main.encode', failure()));
    claim.finish(context, 503, true, true); closeMobileCapabilityContext(context);
    assert.ok(decode(lines).some(row => row.stage === `http.discovery.${name}.503` && row.code === 'BUSY'));
  }
});

test('能力旁注闭集拒绝私密字段、访问器和代理，损坏帧不吞后续合法帧，首拒独立于有界环', () => {
  assert.equal(mobileCapabilityRequestSha('http', firstId), mobileCapabilityRequestSha('http', firstId));
  assert.notEqual(mobileCapabilityRequestSha('http', firstId), mobileCapabilityRequestSha('content', firstId));
  assert.equal(mobileCapabilityRequestSha('http', '非原信封UUID'), null);
  const lines: string[] = [];
  const context = createMobileCapabilityContext(firstId, 'main', 'http', null, undefined, line => { lines.push(line); });
  assert.ok(context);
  withMobileCapabilityContext(context, () => { assert.throws(() => mobileCapabilitySync('main.auth', () => { throw failure(); })); });
  const rows = decode(lines), rejection = rows.find(row => row.phase === 'reject');
  assert.ok(rejection);
  assert.equal(rejection.code, 'BUSY');
  assert.doesNotMatch(lines.join(''), /私密正文|11111111|message|stack|https?:|token|authKey/u);
  assert.equal(copyMobileCapabilityTraceRecord({ ...rejection, token: '拒收' }), null);
  let getterCalls = 0, proxyCalls = 0;
  const accessor = { ...rejection };
  Object.defineProperty(accessor, 'code', { enumerable: true, get() { getterCalls++; return 'BUSY'; } });
  assert.equal(copyMobileCapabilityTraceRecord(accessor), null);
  assert.equal(copyMobileCapabilityTraceRecord(new Proxy(rejection, { ownKeys() { proxyCalls++; return []; } })), null);
  assert.equal(getterCalls, 0); assert.equal(proxyCalls, 0);
  const framed = MOBILE_CAPABILITY_TRACE_PREFIX + JSON.stringify(rejection) + '\n';
  const accepted: MobileCapabilityTraceRecord[] = [];
  const reader = createMobileCapabilityTraceReader(row => { accepted.push(row); });
  reader(MOBILE_CAPABILITY_TRACE_PREFIX + '{坏JSON}\n' + framed.slice(0, 25));
  reader(framed.slice(25));
  reader('x'.repeat(5000) + '\n' + framed);
  reader('x'.repeat(1024 * 1024 + 1));
  reader('丢弃余行\n' + framed);
  assert.deepEqual(accepted, [rejection, rejection, rejection]);
  const collector = createMobileCapabilityTraceCollector();
  collector.record(rejection);
  collector.record({ ...rejection, stage: 'main.encode' });
  collector.record({ ...rejection, role: 'cleanup', stage: 'owner.store.file.close' });
  collector.record({ ...rejection, role: 'cleanup', stage: 'owner.store.directory.close' });
  for (let index = 0; index < 300; index++) collector.record({ ...rejection, phase: 'ok', code: 'OK', stage: 'http.send' });
  const snapshot = collector.snapshot();
  assert.equal(snapshot.records.length, 256);
  assert.equal(snapshot.firstBusinessFailures.length, 1);
  assert.equal(snapshot.firstBusinessFailures[0]?.stage, 'main.auth');
  assert.deepEqual(snapshot.cleanupFailures.map(row => row.stage), ['owner.store.file.close', 'owner.store.directory.close']);
  assert.ok(snapshot.droppedRecords > 0);
  assert.ok(copyMobileCapabilityTraceSnapshot(snapshot));
  const extraArray = [...snapshot.records];
  Object.defineProperty(extraArray, Symbol('私密附加字段'), { value: '拒收' });
  assert.equal(copyMobileCapabilityTraceSnapshot({ ...snapshot, records: extraArray }), null);
  closeMobileCapabilityContext(context);
});

test('并发请求旁注不串链，sink失败不改原返回和异常，关闭及容量边界仍保首拒和真实清理阶段', async () => {
  const baseline = captureMobileCapabilityContext(), lines: string[] = [];
  const sink = (line: string): void => { lines.push(line); throw new Error('仅诊断sink失败'); };
  const first = createMobileCapabilityContext(firstId, 'main', 'http', null, undefined, sink);
  const second = createMobileCapabilityContext(secondId, 'core', 'content', first?.requestSha256 ?? null, undefined, sink);
  assert.ok(first); assert.ok(second);
  let release: () => void = () => undefined, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = failure();
  const pending = withMobileCapabilityContext(first, () => mobileCapabilityAsync('main.initial-qualification', async () => {
    calls++; await gate;
    assert.equal(captureMobileCapabilityContext(), first);
    return 17;
  }));
  withMobileCapabilityContext(second, () => {
    assert.equal(captureMobileCapabilityContext(), second);
    assert.throws(() => mobileCapabilitySync('core.rpc.scope.assert.before', () => { calls++; throw original; }), error => error === original);
    mobileCapabilityReject('core.rpc.failure', Object.assign(new Error(), { code: 'TIMEOUT' }));
  });
  release();
  assert.equal(await pending, 17); assert.equal(calls, 2);
  assert.equal(captureMobileCapabilityContext(), baseline);
  const captured = decode(lines);
  assert.ok(captured.filter(row => row.component === 'main').every(row => row.requestSha256 === first.requestSha256 && row.parentSha256 === null));
  assert.ok(captured.filter(row => row.component === 'core').every(row => row.requestSha256 === second.requestSha256 && row.parentSha256 === first.requestSha256));
  const collector = createMobileCapabilityTraceCollector();
  captured.forEach(row => { collector.record(row); });
  assert.equal(collector.snapshot().firstBusinessFailures[0]?.stage, 'core.rpc.scope.assert.before');
  const beforeClose = lines.length;
  closeMobileCapabilityContext(second);
  withMobileCapabilityContext(second, () => {
    mobileCapabilityReject('core.rpc.failure', original);
    mobileCapabilityReject('content.rpc.cancel', original, 'cleanup');
  });
  assert.equal(lines.length, beforeClose + 1);
  const limitedLines: string[] = [];
  const controller = new AbortController();
  const limited = createMobileCapabilityContext(secondId, 'owner', 'owner', second.requestSha256, controller.signal, line => { limitedLines.push(line); });
  assert.ok(limited);
  withMobileCapabilityContext(limited, () => {
    for (let index = 0; index < 80; index++) assert.equal(mobileCapabilitySync('owner.store.read', () => 1), 1);
    controller.abort();
    mobileCapabilityReject('owner.store.decrypt', original);
    mobileCapabilityReject('owner.store.file.close', original, 'cleanup');
    mobileCapabilityReject('owner.store.directory.close', original, 'cleanup');
  });
  const limitedRows = decode(limitedLines);
  assert.ok(limitedRows.length <= 64);
  assert.deepEqual(limitedRows.filter(row => row.phase === 'reject').map(row => [row.stage, row.role, row.aborted]), [
    ['owner.store.decrypt', 'business', true], ['owner.store.file.close', 'cleanup', true], ['owner.store.directory.close', 'cleanup', true],
  ]);
  closeMobileCapabilityContext(first); closeMobileCapabilityContext(limited);
});
