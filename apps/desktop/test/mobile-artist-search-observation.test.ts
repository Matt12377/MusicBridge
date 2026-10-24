import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileArtistSearchHttpObservation, describeMobileArtistSearchHttp,
  MOBILE_ARTIST_SEARCH_HTTP_TRACE_PREFIX } from '../src/main/mobile-artist-search-observation.js';

const selected = { operation: 'searchArtists', source: 'netease', kind: 'artists' };
const rows = (lines: string[]) => lines.map(line => {
  assert.ok(line.startsWith(MOBILE_ARTIST_SEARCH_HTTP_TRACE_PREFIX));
  return JSON.parse(line.slice(MOBILE_ARTIST_SEARCH_HTTP_TRACE_PREFIX.length));
});

test('私有艺术家HTTP观察仅输出四个有界阶段和固定字段', () => {
  const lines: string[] = []; let clock = 10;
  const observation = createMobileArtistSearchHttpObservation(true, line => lines.push(line), () => clock);
  const lease = observation.begin(selected); assert.ok(lease);
  clock = 13; lease.handleComplete(); lease.handleComplete();
  clock = 15; lease.beforeSendComplete(); lease.beforeSendComplete();
  clock = 18; lease.finish(200, false); lease.finish(500, true); lease.reject(new Error('不应重开终态'));
  const records = rows(lines);
  assert.deepEqual(records.map(row => row.stage), ['request', 'handle-complete', 'before-send-complete', 'terminal']);
  assert.deepEqual(records.map(row => row.elapsedMs), [0, 3, 5, 8]);
  assert.deepEqual(records.map(row => row.status), [null, null, null, 200]);
  assert.equal(new Set(records.map(row => row.requestId)).size, 1);
  assert.match(records[0].requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  for (const row of records) {
    assert.deepEqual(Object.keys(row).sort(), ['schema', 'requestId', 'operation', 'source', 'kind', 'stage', 'elapsedMs', 'status', 'code'].sort());
    assert.equal(row.schema, 'mb.artist-search-http.v1'); assert.equal(row.operation, 'searchArtists');
    assert.equal(row.source, 'netease'); assert.equal(row.kind, 'artists'); assert.equal(row.code, null);
  }
});

test('sink抛错不改变原受控处理返回、顺序或异常身份', async () => {
  const calls: string[] = [], result = { status: 200 }, failure = new Error('合成原错误');
  const observation = createMobileArtistSearchHttpObservation(true, () => { throw new Error('合成sink失败'); });
  async function handle(fail: boolean) {
    const lease = observation.begin(selected); assert.ok(lease);
    try {
      calls.push('handle'); if (fail) throw failure;
      lease.handleComplete(); calls.push('beforeSend'); lease.beforeSendComplete(); return result;
    } catch (error) { lease.reject(error); throw error; }
    finally { calls.push('finish'); lease.finish(fail ? 503 : 200, false); }
  }
  assert.equal(await handle(false), result);
  assert.deepEqual(calls, ['handle', 'beforeSend', 'finish']);
  calls.length = 0;
  await assert.rejects(() => handle(true), error => error === failure);
  assert.deepEqual(calls, ['handle', 'finish']);
});

test('未知枚举、额外字段、getter和toJSON不能进入输出', () => {
  const lines: string[] = [], observation = createMobileArtistSearchHttpObservation(true, line => lines.push(line));
  const secret = '合成禁止内容'; let touched = false;
  for (const raw of [
    { ...selected, query: secret }, { ...selected, source: secret }, { ...selected, operation: secret },
    { ...selected, kind: secret }, { ...selected, toJSON() { touched = true; return secret; } },
    Object.defineProperty({ ...selected }, 'source', { get() { touched = true; return secret; } }),
    { ...selected, [Symbol('合成秘密字段')]: secret },
  ]) assert.equal(observation.begin(raw), undefined);
  assert.equal(lines.length, 0); assert.equal(touched, false);
  const projected = describeMobileArtistSearchHttp('/mobile/v1/search/artists', [['source', secret], ['q', secret], ['cursor', secret]]);
  const lease = observation.begin(projected); assert.ok(lease);
  lease.reject({ code: secret, message: secret, stack: secret, toJSON() { touched = true; return secret; } });
  lease.finish(secret, false);
  assert.equal(touched, false); assert.ok(!lines.join('').includes(secret));
  assert.deepEqual(rows(lines).map(row => [row.source, row.status, row.code]), [['unknown', null, null], ['unknown', null, null]]);
});

test('取消或安全拒绝仅记录既有闭集错误码，不冒充底层quiet', () => {
  const lines: string[] = [], observation = createMobileArtistSearchHttpObservation(true, line => lines.push(line));
  const lease = observation.begin(selected); assert.ok(lease);
  lease.reject(Object.assign(new Error('合成私有错误正文'), { code: 'BUSY' }));
  lease.finish(null, true); lease.handleComplete(); lease.beforeSendComplete();
  const records = rows(lines);
  assert.deepEqual(records.map(row => row.stage), ['request', 'cancelled']);
  assert.equal(records[1].code, 'BUSY'); assert.equal(records[1].status, null);
  assert.ok(!lines.join('').includes('合成私有错误正文'));
});

test('默认关闭、异常时钟和单实例准入上限均不积累无限日志', () => {
  const lines: string[] = [];
  assert.equal(createMobileArtistSearchHttpObservation(false, line => lines.push(line)).begin(selected), undefined);
  assert.equal(createMobileArtistSearchHttpObservation(true, line => lines.push(line), () => NaN).begin(selected), undefined);
  const observation = createMobileArtistSearchHttpObservation(true, line => lines.push(line));
  for (let index = 0; index < 256; index++) { const lease = observation.begin(selected); assert.ok(lease); lease.finish(200, false); }
  assert.equal(observation.begin(selected), undefined); assert.equal(lines.length, 512);
});

test('路由分类只保留来源和操作，不保留人物或查询信息', () => {
  assert.deepEqual(describeMobileArtistSearchHttp('/mobile/v1/search/tracks', [['source', 'local'], ['q', '合成查询']]),
    { operation: 'searchTracks', source: 'local', kind: 'tracks' });
  assert.deepEqual(describeMobileArtistSearchHttp('/mobile/v1/library/artists/合成人物/albums', [['q', '合成查询']]),
    { operation: 'listLibraryArtistAlbums', source: 'local', kind: 'albums' });
  assert.deepEqual(describeMobileArtistSearchHttp('/mobile/v1/search/artists', [['source', 'local'], ['source', 'netease']]),
    { operation: 'searchArtists', source: 'unknown', kind: 'artists' });
});
