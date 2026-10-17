import assert from 'node:assert/strict';
import test from 'node:test';
import { copyLibraryReadTraceEvent, copyLocalAlbumSafeTrace, createLibraryReadTraceStreamReader, createLibraryReadTraceWriter, emptyLocalAlbumTraceMatches, isLibraryReadTraceEnabled, libraryReadTraceFailure, readLibraryReadTerminalMetadata, readLocalAlbumSafeTraceLine, LIBRARY_READ_TRACE_PREFIX, LOCAL_ALBUM_TRACE_PREFIX } from '../src/shared/library-read-trace.js';

test('逐请求日志：开发默认开启、生产默认关闭、显式开关覆盖且无效值不打开生产', () => {
  assert.equal(isLibraryReadTraceEnabled({}, true), true); assert.equal(isLibraryReadTraceEnabled({}, false), false);
  assert.equal(isLibraryReadTraceEnabled({ MUSIC_BRIDGE_LIBRARY_READ_TRACE: '0' }, true), false);
  assert.equal(isLibraryReadTraceEnabled({ MUSIC_BRIDGE_LIBRARY_READ_TRACE: '1' }, false), true);
  assert.equal(isLibraryReadTraceEnabled({ MUSIC_BRIDGE_LIBRARY_READ_TRACE: 'secret' }, false), false);
  const lines: string[] = []; createLibraryReadTraceWriter({ enabled: false, write: line => lines.push(line) })({ stage: 'main.receive', rendererReadId: 'private-id' }); assert.deepEqual(lines, []);
});

test('逐请求日志：任意 payload、搜索词、媒体、SDK身份、URL、凭据与 stack 全部被丢弃', () => {
  const lines: string[] = [], emit = createLibraryReadTraceWriter({ enabled: true, write: line => lines.push(line) });
  emit({ stage: 'sdk.callback', command: 'roon.library.albums', rendererReadId: 'private-caller-id-with-cookie', coreReadId: '11111111-1111-4111-8111-111111111111',
    outcome: 'ok', itemCount: 1, itemKeyCount: 1, hintCounts: { generic: 1, secretHint: 'private-hint' },
    payload: { query: 'private-query' }, title: 'private-title', item_key: 'private-item-key', session_key: 'private-session-key', url: 'https://private-url', cookie: 'private-cookie', stack: 'private-stack' });
  const event = JSON.parse(lines[0]!.slice(LIBRARY_READ_TRACE_PREFIX.length));
  assert.equal(event.rendererReadId, 'opaque-1'); assert.equal(event.coreReadId, '11111111-1111-4111-8111-111111111111'); assert.deepEqual(event.hintCounts, { generic: 1 });
  assert.doesNotMatch(lines.join(''), /private-|payload|query|title|item_key|session_key|url|cookie|stack/u);
  assert.equal(libraryReadTraceFailure(Object.assign(new Error('private-error-message'), { code: 'private-error-code' })).code, 'OTHER');
});

test('逐请求日志：伪装枚举的对象不能靠 toString 展开私密字段', () => {
  const disguised = { toString: () => 'albums', cookie: 'private-disguised-cookie' };
  const outcome = { toString: () => 'ok', credential: 'private-disguised-credential' };
  const safe = copyLibraryReadTraceEvent({ stage: 'sdk.callback', hierarchy: disguised, outcome, itemCount: 1 });
  assert.deepEqual(safe, { stage: 'sdk.callback', itemCount: 1 });
  assert.equal(readLibraryReadTerminalMetadata({ __musicBridgeLibraryReadTrace: 1, stage: { toString: () => 'renderer.return', cookie: 'private-disguised-cookie' } }), undefined);
  assert.equal(readLibraryReadTerminalMetadata({ __musicBridgeLibraryReadTrace: 1, stage: 'renderer.return', outcome }), undefined);
  assert.equal(readLibraryReadTerminalMetadata({ __musicBridgeLibraryReadTrace: 1, stage: 'renderer.cancel', payload: { cookie: 'private' } }), undefined);
});

test('逐请求日志：utility stdout 只转发有界白名单诊断并处理分块，其他文本不输出', () => {
  const lines: string[] = [], emit = createLibraryReadTraceWriter({ enabled: true, write: line => lines.push(line) });
  const consume = createLibraryReadTraceStreamReader(emit);
  const safe = `${LIBRARY_READ_TRACE_PREFIX}${JSON.stringify({ stage: 'core.finish', outcome: 'ok', coreReadId: '11111111-1111-4111-8111-111111111111', cookie: 'private-injected-cookie' })}\n`;
  consume('SDK Cookie=private-sdk-cookie\n'); consume(safe.slice(0, 9)); consume(safe.slice(9));
  consume(`${LIBRARY_READ_TRACE_PREFIX}${'x'.repeat(9000)}\n`); consume(`${LIBRARY_READ_TRACE_PREFIX}{"stage":"renderer.return","outcome":"ok"}\n`);
  assert.equal(lines.length, 1); assert.doesNotMatch(lines[0]!, /private|cookie|SDK/u);
});

test('逐请求日志：写入异常被隔离，不向业务抛出或打印原错误', () => {
  assert.doesNotThrow(() => createLibraryReadTraceWriter({ enabled: true, write: () => { throw new Error('private-write-failure'); } })({ stage: 'core.finish', outcome: 'ok' }));
});

test('本地专辑安全trace：封面许可三阶段可解析且未知阶段与敏感字段仍拒绝', () => {
  const stages = ['localAlbum.artwork.permit-granted', 'localAlbum.artwork.permit-deferred', 'localAlbum.artwork.no-permit-unavailable'] as const;
  for (const stage of stages) {
    const trace = { version: 1, traceSha256: 'a'.repeat(64), parentSha256: null, stage, firstStage: null,
      code: 'UNKNOWN', name: 'UNKNOWN', mappedCode: null, elapsedMs: 0, outcome: 'ok', matches: emptyLocalAlbumTraceMatches(), preloadAssociated: false };
    assert.deepEqual(copyLocalAlbumSafeTrace(trace), trace);
    assert.deepEqual(readLocalAlbumSafeTraceLine(LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(trace)), trace);
    for (const rejected of [
      { ...trace, stage: 'localAlbum.artwork.permit-unknown' },
      { ...trace, dataUrl: 'private-data-url' }, { ...trace, path: 'private-path' }, { ...trace, cookie: 'private-cookie' },
    ]) {
      assert.equal(copyLocalAlbumSafeTrace(rejected), null);
      assert.equal(readLocalAlbumSafeTraceLine(LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(rejected)), null);
    }
  }
});
