import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMobileContentCursorCodec, MOBILE_CONTENT_CURSOR_TTL_MS } from '../../src/mobile/content-cursor.js';
import type { MobileContentPageScope } from '../../src/mobile/content-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const key = new Uint8Array(32).fill(41);
function query(): MobileContentPageScope {
  return { scope: { serverId: 'server-a', datasetId: 'dataset-a', deviceId: 'device-a', deviceEpoch: 1,
    accessGeneration: 1, ownerEpoch: 'owner-a', accountDomain: 'account-a', providerEpoch: 'provider-a' },
  operation: 'getNeteaseDiscoveryCollectionTracks', source: 'netease', parentId: 'collection-a', kind: 'playlist',
  filterHash: 'a'.repeat(64), sort: 'provider-order', limit: 20 };
}
const invalid = (error: unknown): boolean => error instanceof MobileServiceError && error.status === 409 && error.code === 'CURSOR_INVALID';

test('004 游标返回原分页事实，不泄露目录、账号标识且不依赖调用方对象后续修改', () => {
  let now = 1000;
  const codec = createMobileContentCursorCodec({ key, now: () => now }), q = query();
  const token = codec.issue({ query: q, revision: 'revision-a', offset: 20 });
  const claims = codec.open(token, q);
  assert.equal(claims.offset, 20); assert.equal(claims.revision, 'revision-a');
  assert.equal(claims.expiresAtMs, 301000); assert(Object.isFrozen(claims));
  const payload = Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8');
  assert(!payload.includes('account-a')); assert(!payload.includes('collection-a'));
  now = claims.expiresAtMs - 1; assert.equal(codec.open(token, query()).offset, 20);
  now++; assert.throws(() => codec.open(token, query()), invalid);
});

test('任何权限或查询围栏改变后旧 continuation 均不能重放', () => {
  const codec = createMobileContentCursorCodec({ key, now: () => 1000 }), q = query();
  const token = codec.issue({ query: q, revision: 'revision-a', offset: 20 });
  for (const name of ['serverId', 'datasetId', 'deviceId', 'ownerEpoch', 'accountDomain', 'providerEpoch'] as const) {
    const other = query(); other.scope = { ...other.scope, [name]: 'changed' };
    assert.throws(() => codec.open(token, other), invalid, name);
  }
  for (const name of ['deviceEpoch', 'accessGeneration'] as const) {
    const other = query(); other.scope = { ...other.scope, [name]: 2 };
    assert.throws(() => codec.open(token, other), invalid, name);
  }
  const alternatives: Partial<MobileContentPageScope>[] = [
    { operation: 'listNeteaseCharts' }, { source: 'local' }, { parentId: 'collection-b' }, { parentId: null },
    { kind: 'chart' }, { kind: null }, { filterHash: 'b'.repeat(64) }, { sort: 'title' }, { limit: 21 },
  ];
  for (const change of alternatives) assert.throws(() => codec.open(token, { ...query(), ...change }), invalid);
});

test('004 与 001 域隔离，篡改、非规范编码及超限 token 均拒绝', () => {
  const codec = createMobileContentCursorCodec({ key, now: () => 1000 }), q = query();
  const token = codec.issue({ query: q, revision: 'revision-a', offset: 20 });
  const parts = token.split('.');
  const changed = Buffer.from(JSON.stringify({ ...codec.open(token, q), offset: 40 })).toString('base64url');
  for (const value of [token.replace('mc4.', 'mc1.'), `mc4.${changed}.${parts[2]}`, `${token}=`,
    `mc4.${parts[1]}=.${parts[2]}`, `mc4.${parts[1]}.${'a'.repeat(43)}`, 'x'.repeat(2049)]) {
    assert.throws(() => codec.open(value, q), invalid);
  }
});

test('签名有效仍不能接受重复字段、未知字段、错误时间或零偏移', () => {
  const codec = createMobileContentCursorCodec({ key, now: () => 1000 }), q = query();
  const token = codec.issue({ query: q, revision: 'revision-a', offset: 20 }), original = codec.open(token, q);
  const sign = (raw: string): string => {
    const payload = Buffer.from(raw).toString('base64url');
    const signature = createHmac('sha256', key).update('MusicBridge:MBM004:CONTENT_CURSOR:1\0').update(payload).digest('base64url');
    return `mc4.${payload}.${signature}`;
  };
  for (const raw of [JSON.stringify({ ...original, offset: 0 }), JSON.stringify({ ...original, issuedAtMs: 1001, expiresAtMs: 301001 }),
    JSON.stringify({ ...original, expiresAtMs: original.expiresAtMs + 1 }), JSON.stringify({ ...original, extra: true }),
    JSON.stringify(original).replace('"offset":20', '"offset":20,"offset":40')]) {
    assert.throws(() => codec.open(sign(raw), q), invalid);
  }
  assert.throws(() => codec.issue({ query: q, revision: 'revision-a', offset: 0 }), invalid);
  assert.throws(() => codec.issue({ query: q, revision: 'revision-a', offset: Number.MAX_SAFE_INTEGER + 1 }), invalid);
});

test('最大标识查询仍在既有2048字节限制内，字段顺序不改变同一查询身份', () => {
  const codec = createMobileContentCursorCodec({ key, now: () => 1000 }), q = query(), id = 'a'.repeat(160);
  q.scope = { serverId: id, datasetId: id, deviceId: id, deviceEpoch: Number.MAX_SAFE_INTEGER,
    accessGeneration: Number.MAX_SAFE_INTEGER, ownerEpoch: id, accountDomain: id, providerEpoch: id };
  q.parentId = id; q.sort = id;
  const token = codec.issue({ query: q, revision: id, offset: Number.MAX_SAFE_INTEGER });
  assert(Buffer.byteLength(token) <= 2048);
  const reordered = { limit: q.limit, sort: q.sort, filterHash: q.filterHash, kind: q.kind, parentId: q.parentId,
    source: q.source, operation: q.operation, scope: { ...q.scope } };
  assert.equal(codec.open(token, reordered).revision, id);
});

test('密钥以创建时快照持有，坏时钟和未授权扩展的query不生成游标', () => {
  const ownedKey = new Uint8Array(key), q = query();
  const codec = createMobileContentCursorCodec({ key: ownedKey, now: () => 1000 });
  ownedKey.fill(0);
  const token = codec.issue({ query: q, revision: 'revision-a', offset: 20 });
  assert.equal(createMobileContentCursorCodec({ key, now: () => 1000 }).open(token, q).offset, 20);
  assert.throws(() => createMobileContentCursorCodec({ key, now: () => -1 }).issue({ query: q, revision: 'r', offset: 20 }), invalid);
  assert.throws(() => createMobileContentCursorCodec({ key: new Uint8Array(31) }));
  assert.throws(() => codec.issue({ query: { ...q, url: 'https://upstream.invalid/' } as MobileContentPageScope, revision: 'r', offset: 20 }));
  let calls = 0;
  const hostile = { ...q, get sort(): string { calls++; return 'title'; } };
  assert.throws(() => codec.issue({ query: hostile, revision: 'r', offset: 20 }));
  assert.equal(calls, 0);
  assert.equal(MOBILE_CONTENT_CURSOR_TTL_MS, 300000);
});
