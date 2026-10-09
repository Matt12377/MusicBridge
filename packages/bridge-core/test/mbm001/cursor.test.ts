import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  createMobileCatalogCursorCodec, MOBILE_CATALOG_CURSOR_MAX_BYTES, MOBILE_CATALOG_CURSOR_TTL_MS,
  type MobileCatalogCursorClaims, type MobileCatalogCursorIssue, type MobileCatalogCursorQueryScope,
} from '../../src/mobile/cursor.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const now = Date.UTC(2030, 0, 1), key = new Uint8Array(32).fill(17);
const query = (): MobileCatalogCursorQueryScope => ({ operation: 'listTracks', serverId: 'server.1', deviceId: 'device.1',
  datasetId: 'dataset.1', accountDomain: 'account.1', deviceEpoch: 1, generation: 1, source: 'local',
  sort: 'OWNER_LOCAL_ORDER_V1', filter: 'a'.repeat(64), albumId: null, limit: 100 });
const issue = (): MobileCatalogCursorIssue => ({ ...query(), ownerEpoch: 'owner.1', libraryRevision: 'library.1', offset: 100 });
const claims = (): MobileCatalogCursorClaims => ({ ...issue(), v: 1, issuedAtMs: now, expiresAtMs: now + 300_000 });
const invalid = (error: unknown): boolean => error instanceof MobileServiceError && error.status === 409 && error.code === 'CURSOR_INVALID' && !error.retryable;

// 独立测试签名器只构造认证后坏闭集，不复制生产decode判定，也不生成公开读取资格。
function signRaw(raw: string | Uint8Array): string {
  const payload = Buffer.from(raw).toString('base64url');
  const mac = createHmac('sha256', key).update('MusicBridge:MBM001:CATALOG_CURSOR:1\0').update(payload).digest('base64url');
  return `mc1.${payload}.${mac}`;
}
function scopeOf(value: MobileCatalogCursorClaims): MobileCatalogCursorQueryScope {
  const { operation, serverId, deviceId, datasetId, accountDomain, deviceEpoch, generation, source, sort, filter, albumId, limit } = value;
  return { operation, serverId, deviceId, datasetId, accountDomain, deviceEpoch, generation, source, sort, filter, albumId, limit };
}

test('001游标使用独立32字节HMAC密钥和完整快照轴，外部改key不改已签身份', () => {
  const mutable = new Uint8Array(key), codec = createMobileCatalogCursorCodec({ key: mutable, now: () => now });
  mutable.fill(0); const token = codec.issue(issue()), parts = token.split('.');
  assert.equal(parts.length, 3); assert.equal(parts[0], 'mc1');
  assert.equal(parts[2], createHmac('sha256', key).update('MusicBridge:MBM001:CATALOG_CURSOR:1\0').update(parts[1]!).digest('base64url'));
  const opened = codec.open(token, query());
  for (const name of Object.keys(claims()) as Array<keyof MobileCatalogCursorClaims>) assert.equal(opened[name], claims()[name]);
  assert.equal(Object.getPrototypeOf(opened), null); assert.equal(opened.expiresAtMs - opened.issuedAtMs, MOBILE_CATALOG_CURSOR_TTL_MS);
  for (const length of [0, 31, 33]) assert.throws(() => createMobileCatalogCursorCodec({ key: new Uint8Array(length) }),
    error => error instanceof MobileServiceError && error.status === 400 && error.code === 'INVALID_REQUEST');
});

test('001游标篡改错误key非规范base64与额外段均拒绝，不接受客户端重签资格', () => {
  const codec = createMobileCatalogCursorCodec({ key, now: () => now }), token = codec.issue(issue());
  const parts = token.split('.'), mac = parts[2]!;
  const mutated = `${parts[0]}.${parts[1]}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  for (const bad of [mutated, token.replace('mc1.', 'mc2.'), `${token}.extra`, `${parts[0]}.${parts[1]}=.${mac}`, '', `${token}\n`]) {
    assert.throws(() => codec.open(bad, query()), invalid);
  }
  const foreign = createMobileCatalogCursorCodec({ key: new Uint8Array(32).fill(18), now: () => now });
  assert.throws(() => foreign.open(token, query()), invalid);
});

test('001游标所有设备工作库账号查询轴逐项绑定，认证MAC不允许跨scope', () => {
  const codec = createMobileCatalogCursorCodec({ key, now: () => now }), token = codec.issue(issue());
  const changes: Array<Record<string, unknown>> = [
    { operation: 'listAlbums' }, { serverId: 'server.other' }, { deviceId: 'device.other' }, { datasetId: 'dataset.other' },
    { accountDomain: 'account.other' }, { deviceEpoch: 2 }, { generation: 2 }, { source: 'all' },
    { sort: 'OTHER_SORT' }, { filter: 'b'.repeat(64) }, { albumId: 'album.other' }, { limit: 99 }, { extra: true },
  ];
  for (const change of changes) assert.throws(() => codec.open(token, { ...query(), ...change } as MobileCatalogCursorQueryScope), invalid);
});

test('001已认证payload仍严格闭键安全整数UTF8与重复键，异常原型getter不读取', () => {
  const codec = createMobileCatalogCursorCodec({ key, now: () => now });
  const missing: Record<string, unknown> = { ...claims() }; delete missing.ownerEpoch;
  const badClaims: unknown[] = [missing, { ...claims(), extra: true }, { ...claims(), v: 2 }, { ...claims(), offset: 0 },
    { ...claims(), offset: Number.MAX_SAFE_INTEGER + 1 }, { ...claims(), ownerEpoch: 'bad\n' },
    { ...claims(), expiresAtMs: now + 300_001 }, { ...claims(), expiresAtMs: now }, { ...claims(), filter: 'not-a-hash' }];
  for (const value of badClaims) assert.throws(() => codec.open(signRaw(JSON.stringify(value)), query()), invalid);
  const raw = JSON.stringify(claims());
  assert.throws(() => codec.open(signRaw(raw.replace('"v":1', '"v":1,"v":1')), query()), invalid);
  assert.throws(() => codec.open(signRaw(new Uint8Array([0xc0, 0xaf])), query()), invalid);
  let accesses = 0; const accessor = Object.defineProperty({ ...query() }, 'filter', { enumerable: true, get() { accesses++; return 'a'.repeat(64); } });
  assert.throws(() => codec.open(codec.issue(issue()), accessor), invalid); assert.equal(accesses, 0);
  assert.throws(() => codec.issue(Object.assign(Object.create({ inherited: true }) as object, issue()) as MobileCatalogCursorIssue), invalid);
});

test('001游标短期限前可用到期必拒，时钟倒退或非安全时钟不续签', () => {
  let time = now; const codec = createMobileCatalogCursorCodec({ key, now: () => time }), token = codec.issue(issue());
  time = now + MOBILE_CATALOG_CURSOR_TTL_MS - 1; assert.equal(codec.open(token, query()).offset, 100);
  time++; assert.throws(() => codec.open(token, query()), invalid);
  time = now - 1; assert.throws(() => codec.open(token, query()), invalid);
  for (const invalidTime of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    time = invalidTime; assert.throws(() => codec.issue(issue()), invalid);
  }
});

test('001游标完整UTF8字节预算在B前后生效，合法MAC超限也拒绝', () => {
  const codec = createMobileCatalogCursorCodec({ key, now: () => now });
  const sized = (bytes: number): MobileCatalogCursorClaims => {
    const value = { ...claims(), albumId: 'album.1' };
    const names = ['serverId', 'deviceId', 'datasetId', 'accountDomain', 'ownerEpoch', 'libraryRevision', 'sort', 'albumId'] as const;
    for (const name of names) {
      const missing = bytes - Buffer.byteLength(JSON.stringify(value));
      if (missing <= 0) break;
      value[name] += 'x'.repeat(Math.min(missing, 160 - value[name].length));
    }
    assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes); return value;
  };
  const below = sized(1_499), edge = sized(1_500), above = sized(1_501);
  const beforeToken = signRaw(JSON.stringify(below)), token = signRaw(JSON.stringify(edge)), afterToken = signRaw(JSON.stringify(above));
  assert.equal(Buffer.byteLength(beforeToken), MOBILE_CATALOG_CURSOR_MAX_BYTES - 1);
  assert.equal(Buffer.byteLength(token), MOBILE_CATALOG_CURSOR_MAX_BYTES);
  assert.equal(codec.open(beforeToken, scopeOf(below)).offset, 100); assert.equal(codec.open(token, scopeOf(edge)).offset, 100);
  // 无padding的base64长度跳过B+1；同时测B+1原字节及B+2完整合法签名结构。
  assert.equal(Buffer.byteLength(`${token}A`), MOBILE_CATALOG_CURSOR_MAX_BYTES + 1);
  assert.throws(() => codec.open(`${token}A`, scopeOf(edge)), invalid);
  assert.equal(Buffer.byteLength(afterToken), MOBILE_CATALOG_CURSOR_MAX_BYTES + 2);
  assert.throws(() => codec.open(afterToken, scopeOf(above)), invalid);
});
