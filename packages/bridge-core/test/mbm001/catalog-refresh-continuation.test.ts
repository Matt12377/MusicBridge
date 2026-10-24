import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { mobileCanonicalJson, type MobileTokenPair, type MobileTrack } from '@music-bridge/contracts';
import { createMobileAuthService } from '../../src/mobile/auth-service.js';
import { createMobileCatalogService } from '../../src/mobile/catalog-service.js';
import { createMobileCatalogCursorCodec, MOBILE_CATALOG_CURSOR_TTL_MS,
  type MobileCatalogCursorQueryScope } from '../../src/mobile/cursor.js';
import { MobileServiceError, type MobileAuthCrypto, type MobileAuthPersistence,
  type MobileOwnerCatalogRequest, type MobileOwnerCatalogSnapshot,
  type MobileSealedState } from '../../src/mobile/types.js';

const START = Date.UTC(2035, 0, 1), SERVER = 'server.synthetic', DATASET = 'dataset.synthetic';
const KEY = new Uint8Array(32).fill(23);
const invalid = (error: unknown) => error instanceof MobileServiceError && error.status === 409 && error.code === 'CURSOR_INVALID';
const unauthorized = (error: unknown) => error instanceof MobileServiceError && error.status === 401 && error.code === 'UNAUTHORIZED';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** 真实AuthService、AES-GCM与内存CAS；只替换Owner目录，不触真实账户/磁盘/HTTP。 */
async function fixture(t: TestContext, total = 330) {
  let now = START, stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  const encryptionKey = randomBytes(32);
  const crypto: MobileAuthCrypto = {
    seal(plain, aad) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(bytes, aad) {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
  let saveGate: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;
  const releases: Array<() => void> = [];
  const persistence: MobileAuthPersistence = {
    async load() { return stored.kind === 'missing' ? { ...stored } : { ...stored, sealed: new Uint8Array(stored.sealed) }; },
    async save(request) {
      const bytes = new Uint8Array(request.sealed), held = saveGate; saveGate = undefined;
      if (held) { held.entered.resolve(); await held.released.promise; }
      assert.equal(request.expectedRevision, stored.revision);
      stored = { kind: 'sealed', datasetId: DATASET, revision: request.expectedRevision + 1,
        commitId: request.commitId, sealed: bytes };
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    },
  };
  const auth = createMobileAuthService({ persistence, crypto, serverId: SERVER, datasetId: DATASET,
    displayName: '合成桥', environment: 'development', now: () => now });
  t.after(async () => { for (const release of releases) release(); await auth.close(); });
  const installationId = 'installation.synthetic';
  const pair = async (key: string): Promise<MobileTokenPair> => {
    const permit = await auth.issuePairing(); return auth.claim({ pairingSecret: permit.pairingSecret, installationId, deviceName: '合成手机' }, key);
  };
  let tokens = await pair('pair.first'), principal = await auth.authenticate(tokens.accessToken);
  let ownerEpoch = 'owner.first', revision = 'revision.first', afterRead: (() => Promise<void>) | undefined;
  const requests: MobileOwnerCatalogRequest[] = [];
  const tracks: MobileTrack[] = Array.from({ length: total }, (_, index) => ({ id: `track.${index}`, title: '合成曲目',
    artists: [], albumId: 'album.first', source: 'local', sourceItemId: `source.${index}`, versionId: `version.${index}`,
    contentRevision: `content.${index}`, editionLabel: '', durationMs: 1_000,
    audio: { codec: 'flac', container: 'flac', sampleRateHz: 48_000, channels: 2, bitsPerSample: 16 }, availability: 'unavailable' }));
  const service = createMobileCatalogService({ auth, serverId: SERVER, datasetId: DATASET, cursorKey: KEY, now: () => now,
    port: { async artwork() { throw new Error('本测试不读取封面。'); }, async read(request): Promise<MobileOwnerCatalogSnapshot> {
      requests.push({ ...request }); const hook = afterRead; afterRead = undefined; await hook?.();
      return { datasetId: DATASET, ownerEpoch, libraryRevision: revision, operation: request.operation,
        offset: request.offset, limit: request.limit, total, items: tracks.slice(request.offset, request.offset + request.limit) };
    } } });
  const refresh = async () => { tokens = await auth.refresh({ refreshToken: tokens.refreshToken }, `refresh.${tokens.accessExpiresAt}`);
    principal = await auth.authenticate(tokens.accessToken); return principal; };
  return { auth, service, requests, tracks, get tokens() { return tokens; }, get principal() { return principal; },
    advance(ms: number) { now += ms; }, refresh,
    async repair() { tokens = await pair('pair.again'); principal = await auth.authenticate(tokens.accessToken); return principal; },
    setRevision(value: string) { revision = value; }, setOwnerEpoch(value: string) { ownerEpoch = value; },
    onRead(hook: () => Promise<void>) { afterRead = hook; },
    blockSave() { const entered = deferred(), released = deferred(); saveGate = { entered, released };
      releases.push(released.resolve); return { entered: entered.promise, release: released.resolve }; },
    get now() { return now; } };
}

test('M56真实鉴权长分页：超过15分钟且两次refresh后仍连续offset直到真实终页', { timeout: 5_000 }, async t => {
  const f = await fixture(t), ids: string[] = [], issued: string[] = []; let cursor: string | null = null, rotations = 0;
  for (let page = 0; page < 33; page++) {
    if (page) f.advance(60_000);
    if (Date.parse(f.tokens.accessExpiresAt) <= f.now) {
      const old = f.principal, token = f.tokens.accessToken; await f.refresh(); rotations++;
      await assert.rejects(f.auth.authenticate(token), unauthorized);
      await assert.rejects(f.service.listTracks({ limit: 10, ...(cursor ? { cursor } : {}) }, old), unauthorized);
    }
    const result = await f.service.listTracks({ limit: 10, ...(cursor ? { cursor } : {}) }, f.principal);
    ids.push(...result.items.map(row => row.id)); cursor = result.nextCursor;
    if (cursor) issued.push(cursor);
  }
  assert.equal(rotations, 2); assert.equal(cursor, null); assert.deepEqual(ids, f.tracks.map(row => row.id));
  for (const token of issued) assert.match(token, /^mc2\./u);
  assert.deepEqual(f.requests.map(row => row.offset), Array.from({ length: 33 }, (_, n) => n * 10));
  assert.ok(f.requests.slice(1).every(row => row.expectedRevision === 'revision.first'));
});

test('M56刷新在Owner读取期间生效：旧principal整页拒绝，新品牌从相同cursor接续', async t => {
  const f = await fixture(t, 30), first = await f.service.listTracks({ limit: 10 }, f.principal);
  assert.ok(first.nextCursor); const old = f.principal;
  f.onRead(async () => { await f.refresh(); });
  await assert.rejects(f.service.listTracks({ limit: 10, cursor: first.nextCursor }, old), unauthorized);
  const second = await f.service.listTracks({ limit: 10, cursor: first.nextCursor }, f.principal);
  assert.equal(second.items[0]!.id, 'track.10'); assert.deepEqual(f.requests.map(row => row.offset), [0, 10, 10]);
  await assert.rejects(f.service.listTracks({ limit: 10, cursor: first.nextCursor }, { ...f.principal }), unauthorized);
});

test('M56刷新提交在途：旧principal不能绕过串行鉴权且新凭据提交后才能接续', { timeout: 5_000 }, async t => {
  const f = await fixture(t, 30), first = await f.service.listTracks({ limit: 10 }, f.principal); assert.ok(first.nextCursor);
  const old = f.principal, held = f.blockSave(), refresh = f.refresh(); await held.entered;
  const stale = f.service.listTracks({ limit: 10, cursor: first.nextCursor }, old);
  const rejects = assert.rejects(stale, unauthorized); held.release(); await refresh; await rejects;
  const next = await f.service.listTracks({ limit: 10, cursor: first.nextCursor }, f.principal);
  assert.equal(next.items[0]!.id, 'track.10'); assert.deepEqual(f.requests.map(row => row.offset), [0, 10]);
});

test('M56撤销和同installation重配仍拒旧cursor，不能把普通refresh规则当新设备许可', async t => {
  for (const operation of ['logout', 'revoke', 'repair'] as const) await t.test(operation, async child => {
    const f = await fixture(child), old = f.principal, first = await f.service.listTracks({ limit: 10 }, old); assert.ok(first.nextCursor);
    if (operation === 'logout') await f.auth.logout(old);
    if (operation === 'revoke') await f.auth.revokeDevice(old.deviceId);
    if (operation !== 'repair') await assert.rejects(f.service.listTracks({ limit: 10, cursor: first.nextCursor }, old), unauthorized);
    await f.repair(); assert.notEqual(f.principal.deviceEpoch, old.deviceEpoch);
    await assert.rejects(f.service.listTracks({ limit: 10, cursor: first.nextCursor }, f.principal), invalid);
    assert.deepEqual(f.requests.map(row => row.offset), [0]);
  });
});

test('M56原Owner和library修订仍拒旧页，不能以mc2遮掩实际目录改变', async t => {
  for (const axis of ['owner', 'revision'] as const) await t.test(axis, async child => {
    const f = await fixture(child), first = await f.service.listTracks({ limit: 10 }, f.principal); assert.ok(first.nextCursor);
    await f.refresh(); if (axis === 'owner') f.setOwnerEpoch('owner.next'); else f.setRevision('revision.next');
    await assert.rejects(f.service.listTracks({ limit: 10, cursor: first.nextCursor }, f.principal),
      error => error instanceof MobileServiceError && error.code === 'SOURCE_CHANGED');
  });
});

test('M56目录请求仍每次验证真实品牌；跨账号、设备、dataset与旧token不能借mc2', async t => {
  const f = await fixture(t), first = await f.service.listTracks({ limit: 10 }, f.principal); assert.ok(first.nextCursor);
  for (const patch of [{ accountDomain: 'account.other' }, { deviceId: 'device.other' }, { datasetId: 'dataset.other' }]) {
    await assert.rejects(f.service.listTracks({ limit: 10, cursor: first.nextCursor }, { ...f.principal, ...patch }), unauthorized);
  }
  assert.equal(f.requests.length, 1);
});

const query = (): MobileCatalogCursorQueryScope => ({ operation: 'listTracks', serverId: SERVER, deviceId: 'device.synthetic',
  datasetId: DATASET, accountDomain: 'account.synthetic', deviceEpoch: 1, generation: 1, source: 'local',
  sort: 'OWNER_LOCAL_ORDER_V1', filter: 'a'.repeat(64), albumId: null, limit: 10 });
const facts = () => ({ ...query(), ownerEpoch: 'owner.first', libraryRevision: 'revision.first', offset: 10 });
const claims = () => ({ ...facts(), v: 2, issuedAtMs: START, expiresAtMs: START + MOBILE_CATALOG_CURSOR_TTL_MS });
function signed(raw: string | Uint8Array, version = 2): string {
  const payload = Buffer.from(raw).toString('base64url');
  const mac = createHmac('sha256', KEY).update(`MusicBridge:MBM001:CATALOG_CURSOR:${version}\0`).update(payload).digest('base64url');
  return `mc${version}.${payload}.${mac}`;
}

test('M56显式mc2域：mc1原generation拒绝不变，双版本不可只换前缀串用', () => {
  const old = createMobileCatalogCursorCodec({ key: KEY, now: () => START });
  const next = createMobileCatalogCursorCodec({ key: KEY, now: () => START, version: 2 });
  const legacy = old.issue(facts()), token = next.issue(facts());
  assert.match(legacy, /^mc1\./u); assert.match(token, /^mc2\./u);
  assert.throws(() => old.open(legacy, { ...query(), generation: 2 }), invalid);
  assert.equal(next.open(token, { ...query(), generation: 2 }).offset, 10);
  assert.throws(() => next.open(token, { ...query(), generation: 0 }), invalid);
  const future = next.issue({ ...facts(), generation: 3 });
  assert.throws(() => next.open(future, { ...query(), generation: 2 }), invalid);
  assert.throws(() => next.open(legacy.replace(/^mc1/u, 'mc2'), query()), invalid);
  assert.throws(() => old.open(token.replace(/^mc2/u, 'mc1'), query()), invalid);
  assert.throws(() => next.open(legacy, query()), invalid); assert.throws(() => old.open(token, query()), invalid);
  const parts = token.split('.');
  assert.equal(parts[2], createHmac('sha256', KEY).update('MusicBridge:MBM001:CATALOG_CURSOR:2\0').update(parts[1]!).digest('base64url'));
});

test('M56 Service可读原mc1但仍严格拒刷新跨代，接续成功只签发mc2', async t => {
  const f = await fixture(t), p = f.principal;
  const scope: MobileCatalogCursorQueryScope = { ...query(), serverId: p.serverId, deviceId: p.deviceId,
    datasetId: p.datasetId, accountDomain: p.accountDomain, deviceEpoch: p.deviceEpoch, generation: p.generation,
    filter: createHash('sha256').update(mobileCanonicalJson({ q: '', albumId: null, source: 'local', operation: 'listTracks' })).digest('hex') };
  const legacy = createMobileCatalogCursorCodec({ key: KEY, now: () => f.now }).issue({ ...scope,
    ownerEpoch: 'owner.first', libraryRevision: 'revision.first', offset: 10 });
  const second = await f.service.listTracks({ limit: 10, cursor: legacy }, p);
  assert.equal(second.items[0]!.id, 'track.10'); assert.match(second.nextCursor!, /^mc2\./u);
  await f.refresh(); await assert.rejects(f.service.listTracks({ limit: 10, cursor: legacy }, f.principal), invalid);
  assert.deepEqual(f.requests.map(value => value.offset), [10]);
});

test('M56 mc2稳定轴逐项相等：账号设备修订过滤仍守门，过期不续期', () => {
  let now = START; const codec = createMobileCatalogCursorCodec({ key: KEY, now: () => now, version: 2 });
  const token = codec.issue(facts());
  for (const patch of [{ operation: 'listAlbums' }, { serverId: 'server.other' }, { deviceId: 'device.other' },
    { datasetId: 'dataset.other' }, { accountDomain: 'account.other' }, { deviceEpoch: 2 },
    { source: 'all' }, { sort: 'OTHER_SORT' }, { filter: 'b'.repeat(64) }, { albumId: 'album.other' }, { limit: 11 }, { extra: true }]) {
    assert.throws(() => codec.open(token, { ...query(), generation: 2, ...patch } as MobileCatalogCursorQueryScope), invalid);
  }
  now += MOBILE_CATALOG_CURSOR_TTL_MS - 1; assert.equal(codec.open(token, { ...query(), generation: 2 }).offset, 10);
  now++; assert.throws(() => codec.open(token, { ...query(), generation: 2 }), invalid);
  now = START - 1; assert.throws(() => codec.open(token, query()), invalid);
});

test('M56 mc2严格字节守门：坏MAC、重复键、闭键、UTF8、getter及原2048预算均拒', () => {
  const codec = createMobileCatalogCursorCodec({ key: KEY, now: () => START, version: 2 }), token = codec.issue(facts());
  assert.throws(() => codec.open(token.slice(0, -3) + (token.at(-3) === 'A' ? 'B' : 'A') + token.slice(-2), query()), invalid);
  for (const value of [{ ...claims(), v: 1 }, { ...claims(), extra: true }, { ...claims(), offset: 0 },
    { ...claims(), expiresAtMs: START + MOBILE_CATALOG_CURSOR_TTL_MS + 1 }, { ...claims(), generation: -1 }]) {
    assert.throws(() => codec.open(signed(JSON.stringify(value)), query()), invalid);
  }
  assert.throws(() => codec.open(signed(JSON.stringify(claims()).replace('"v":2', '"v":2,"v":2')), query()), invalid);
  assert.throws(() => codec.open(signed(new Uint8Array([0xc0, 0xaf])), query()), invalid);
  assert.throws(() => codec.open(token + 'A'.repeat(2048), query()), invalid);
  let gets = 0; const accessor = Object.defineProperty({ ...query() }, 'filter', { enumerable: true, get() { gets++; return 'a'.repeat(64); } });
  assert.throws(() => codec.open(token, accessor), invalid); assert.equal(gets, 0);
  const oversized = { ...claims(), serverId: 'a'.repeat(160), deviceId: 'b'.repeat(160), datasetId: 'c'.repeat(160),
    accountDomain: 'd'.repeat(160), ownerEpoch: 'e'.repeat(160), libraryRevision: 'f'.repeat(160), sort: 'g'.repeat(160), albumId: 'h'.repeat(160) };
  assert.ok(Buffer.byteLength(signed(JSON.stringify(oversized))) > 2048);
  const { v: _v, issuedAtMs: _issued, expiresAtMs: _expires, ...largeFacts } = oversized;
  assert.throws(() => codec.issue(largeFacts), invalid);
});
