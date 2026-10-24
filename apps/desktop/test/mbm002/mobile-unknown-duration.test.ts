import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { decodeMobileRequest, decodeMobileResponse, type MobileContentReadContext, type MobileOperationId,
  type MobilePersonalPlaylistTrackPage, type MobileTrack, type MobileTrackPage } from '@music-bridge/contracts';
import { createMobileBackend } from '../../src/main/mobile-backend.js';
import { createMobileContentBackend } from '../../src/main/mobile-content-backend.js';
import { createMobileHttpsServer } from '../../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../../src/main/mobile-tls-identity.js';
import { unknownDurationFixture, DURATION_DATASET } from '../../../../packages/bridge-core/test/helpers/mobile-unknown-duration-fixture.js';
import { createMobileOwnerService } from '../../../../packages/bridge-core/src/mobile/owner-service.js';
import { captureMobileContentReply } from '../../../../packages/bridge-core/src/mobile/content-protocol.js';
import type { MobileContentPort, MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import { MobileServiceError, type MobilePrincipal } from '../../../../packages/bridge-core/src/mobile/types.js';

const ORIGIN = 'https://127.0.0.1';
const FEATURE = ['X-MusicBridge-Catalog-Features', 'unknown-duration-v1'] as const;
function request<O extends MobileOperationId>(operation: O, requestPath: string, enabled = true, query: [string, string][] = []) {
  const decoded = decodeMobileRequest(operation, { method: 'GET', path: requestPath,
    headers: enabled ? [FEATURE] : [], query, body: new Uint8Array() }, { responseOrigin: ORIGIN, requestPath });
  assert.ok(decoded.ok); return decoded.value;
}
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'duration-main-')); fs.chmodSync(directory, 0o700);
  const f = unknownDurationFixture(); f.setDuration(389, null);
  Object.assign(f.collection, { privateMobileDataDirectory: () => directory });
  const owner = createMobileOwnerService({ collection: f.collection, localAlbums: f.localAlbums,
    datasetId: DURATION_DATASET, ownerEpoch: '81000000-0000-4000-8000-000000000009', assertCurrent() {} });
  const key = new Uint8Array(32).fill(9);
  const service = createMobileBackend({ serverId: 'server.duration', datasetId: DURATION_DATASET, authKey: key,
    displayName: '合成目录服务', environment: 'development', assertCurrent() {}, requestOwner: r => owner.dispatch(r),
    resizeArtwork() { throw new Error('未知时长目录测试不读取图片。'); } });
  const permit = await service.auth.issuePairing();
  const pair = await service.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.duration', deviceName: '合成设备' }, 'claim.duration');
  t.after(async () => { await service.close(); key.fill(0); fs.rmSync(directory, { recursive: true, force: true }); });
  const signal = new AbortController().signal;
  const page = async (enabled = true, cursor?: string) => {
    const decoded = request('listTracks', '/mobile/v1/tracks', enabled, [['limit', '100'], ...(cursor ? [['cursor', cursor] as [string, string]] : [])]);
    const reply = await service.backend.dispatch({ operation: 'listTracks', request: decoded, accessToken: pair.accessToken, signal });
    await reply.beforeSend?.(); return JSON.parse(Buffer.from(reply.body).toString('utf8')) as MobileTrackPage;
  };
  return { f, service, pair, signal, page };
}

/** 仅loopback合成TLS；证书、配对与密钥均在当前外置临时目录生成。 */
async function httpsFixture(t: TestContext, backend: Parameters<typeof createMobileHttpsServer>[0]['backend']) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'duration-https-')), key = randomBytes(32);
  const identity = await loadOrCreateMobileIdentity({ directory, hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, body, cipher.getAuthTag()]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8'); },
  } });
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port: 0, backend });
  const listening = await server.start();
  t.after(async () => { await server.close(); key.fill(0); fs.rmSync(directory, { recursive: true, force: true }); });
  const read = (target: string, headers: string[] = []) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const url = new URL(listening.baseUrl);
    const req = httpsRequest({ hostname: '127.0.0.1', port: url.port, path: target, method: 'GET',
      ca: identity.certificatePEM, agent: false, headers: ['Host', url.host, 'Connection', 'close', ...headers] }, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成HTTPS响应关闭。')));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
    });
    req.once('error', reject); req.setTimeout(5000, () => req.destroy(new Error('合成HTTPS请求超时。'))); req.end();
  });
  return { read };
}

test('M35真实Main→Owner目录：显式协商连续五页401曲完整通过，原cursor/重核及单曲详情不变', async t => {
  const f = await fixture(t), tracks: MobileTrack[] = []; let cursor: string | undefined, revision: string | undefined;
  do {
    const page = await f.page(true, cursor); revision ??= page.libraryRevision;
    assert.equal(page.libraryRevision, revision); tracks.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(tracks.length, 401); assert.equal(new Set(tracks.map(x => x.id)).size, 401);
  const affected = tracks[389]!; assert.equal(affected.durationMs, null); assert.equal(affected.availability, 'unavailable');
  const decoded = request('getTrack', `/mobile/v1/tracks/${affected.id}`);
  const detail = await f.service.backend.dispatch({ operation: 'getTrack', request: decoded, accessToken: f.pair.accessToken, signal: f.signal });
  await detail.beforeSend?.(); assert.deepEqual(JSON.parse(Buffer.from(detail.body).toString('utf8')), affected);
  assert.ok(f.f.counts().queries >= 12);
});

test('M35真实Main兼容：旧请求正常数字页仍200，含null页和单曲严格拒绝且不泄漏null正文', async t => {
  const f = await fixture(t); let cursor: string | undefined;
  for (let i = 0; i < 3; i++) { const page = await f.page(false, cursor); assert.equal(page.items.length, 100); assert.ok(page.nextCursor); cursor = page.nextCursor; }
  await assert.rejects(f.page(false, cursor), e => e instanceof MobileServiceError && e.status === 503 && e.code === 'BUSY');
  const decoded = request('getTrack', `/mobile/v1/tracks/${f.f.id(389)}`, false);
  await assert.rejects(f.service.backend.dispatch({ operation: 'getTrack', request: decoded, accessToken: f.pair.accessToken, signal: f.signal }),
    e => e instanceof MobileServiceError && e.status === 503 && e.code === 'BUSY');
});

test('M35真实HTTPS→Main→Owner→最终capture：新头允许未知本地行，旧客户端仍503且错误头不投递', async t => {
  const f = await fixture(t); f.f.setDuration(0, null); let calls = 0;
  const h = await httpsFixture(t, { dispatch: async input => { calls++; return f.service.backend.dispatch(input); } });
  const auth = ['Authorization', `Bearer ${f.pair.accessToken}`], feature = [...FEATURE];
  const result = await h.read('/mobile/v1/tracks?limit=100', [...auth, ...feature]);
  assert.equal(result.status, 200); const page = result.body as unknown as MobileTrackPage;
  assert.equal(page.items.length, 100); assert.equal(page.items[0]!.durationMs, null); assert.equal(page.items[0]!.availability, 'unavailable');
  const old = await h.read('/mobile/v1/tracks?limit=100', auth); assert.equal(old.status, 503);
  assert.equal(Object.hasOwn(old.body, 'items'), false); assert.equal(JSON.stringify(old.body).includes('durationMs'), false);
  const detail = await h.read(`/mobile/v1/tracks/${f.f.id(0)}`, [...auth, ...feature]); assert.equal(detail.status, 200); assert.equal(detail.body.durationMs, null);
  const before = calls;
  for (const invalid of [['X-MusicBridge-Catalog-Features', 'unknown-duration-v2'], [...feature, ...feature]]) {
    assert.equal((await h.read('/mobile/v1/tracks', [...auth, ...invalid])).status, 400);
  }
  assert.equal(calls, before);
  f.f.setDuration(0, 1000); assert.equal((await h.read('/mobile/v1/tracks?limit=100', auth)).status, 200);
});

test('M35真实HTTPS最终capture：后端不能给旧请求自签nullable许可', async t => {
  const body = Buffer.from(JSON.stringify({ items: [{ id: 'local.track', title: '合成曲', artists: [], albumId: 'local.album', source: 'local',
    sourceItemId: 'local.item', versionId: 'local.version', contentRevision: 'local.revision', editionLabel: '', durationMs: null,
    availability: 'unavailable', audio: { codec: 'flac', container: 'flac' } }], nextCursor: null, libraryRevision: 'revision.synthetic' }));
  const h = await httpsFixture(t, { async dispatch() { return { status: 200, body, headers: [['Content-Type', 'application/json']], catalogFeatures: 'unknown-duration-v1' }; } });
  assert.equal((await h.read('/mobile/v1/tracks')).status, 503);
  assert.equal((await h.read('/mobile/v1/tracks', [...FEATURE])).status, 200);
});

test('M35真实Main守门：已协商回包仍受beforeSend修订/账号撤销/取消围栏', async t => {
  for (const change of ['revision', 'revoke', 'abort'] as const) {
    const f = await fixture(t), controller = new AbortController();
    const reply = await f.service.backend.dispatch({ operation: 'listTracks', request: request('listTracks', '/mobile/v1/tracks'),
      accessToken: f.pair.accessToken, signal: controller.signal });
    if (change === 'revision') f.f.setRevision('scope:2');
    else if (change === 'revoke') await f.service.auth.revokeDevice(f.pair.deviceId);
    else controller.abort();
    assert.ok(reply.beforeSend); await assert.rejects(reply.beforeSend(), MobileServiceError);
  }
});

test('M35真实内容Main：内部nullable不等于出站许可，嵌套Track仅由真实Features头放行', async t => {
  const f = await fixture(t), principal = await f.service.auth.authenticate(f.pair.accessToken);
  let revision = 'playlist.rev1'; const received: string[][] = [];
  const scope = (actor: MobilePrincipal): Readonly<MobileContentScope> => ({ serverId: actor.serverId, datasetId: actor.datasetId,
    deviceId: actor.deviceId, deviceEpoch: actor.deviceEpoch, accessGeneration: actor.generation,
    ownerEpoch: 'owner.duration', providerEpoch: null, accountDomain: actor.accountDomain });
  const selectedScope = scope(principal);
  const track = { id: 'local.synthetic.track', title: '合成未知时长', artists: [], albumId: 'local.synthetic.album', source: 'local' as const,
    sourceItemId: 'local.synthetic.item', versionId: 'local.synthetic.version', contentRevision: 'local.synthetic.revision', editionLabel: '',
    durationMs: null, availability: 'unavailable' as const, audio: { codec: 'flac', container: 'flac' } };
  const port: MobileContentPort = { async dispatch(input) {
    assert.equal(input.operation, 'listPersonalPlaylistTracks'); received.push(Object.keys(input.request).sort());
    const originalRevision = revision;
    const context: MobileContentReadContext = { serverId: input.scope.serverId, deviceId: input.scope.deviceId,
      accountDomain: input.scope.accountDomain, playlistId: 'playlist.synthetic', revision, limit: 100, pageOffset: 0 };
    const body = { accountDomain: input.scope.accountDomain,
      playlist: { playlistId: 'playlist.synthetic', title: '合成列表', icon: 'music.note', description: '', trackCount: 1, playlistRevision: revision },
      items: [track], nextCursor: null };
    const facts = captureMobileContentReply(input.operation, input.request, input.scope, { status: 200, category: 'success', body }, context);
    return { operation: input.operation, scope: input.scope, reply: facts.reply, context: facts.context,
      beforeSend: async () => { if (revision !== originalRevision) throw new MobileServiceError(409, 'SOURCE_CHANGED'); } };
  } };
  const backend = createMobileContentBackend({ auth: f.service.auth, content: port, resolveScope: async () => selectedScope,
    assertScope(current) { if (current.ownerEpoch !== selectedScope.ownerEpoch) throw new MobileServiceError(409, 'SOURCE_CHANGED'); } });
  t.after(() => backend.close());
  const input = (enabled: boolean) => ({ operation: 'listPersonalPlaylistTracks' as const, request: request('listPersonalPlaylistTracks', '/mobile/v1/ui/playlists/playlist.synthetic/tracks', enabled,
    [['accountDomain', selectedScope.accountDomain], ['playlistRevision', revision], ['limit', '100']]), origin: ORIGIN, accessToken: f.pair.accessToken, signal: f.signal });
  await assert.rejects(backend.dispatch(input(false)), e => e instanceof MobileServiceError && e.status === 503 && e.code === 'BUSY');
  const enabled = input(true), reply = await backend.dispatch(enabled); await reply.beforeSend();
  const decoded = decodeMobileResponse('listPersonalPlaylistTracks', { status: reply.status, headers: reply.headers, body: reply.body,
    finalUrl: `${ORIGIN}${enabled.request.path}` }, { responseOrigin: ORIGIN, requestPath: enabled.request.path, content: reply.contentContext, catalogFeatures: 'unknown-duration-v1' });
  assert.ok(decoded.ok); assert.equal(decoded.value.category, 'success');
  assert.equal((decoded.value.body as MobilePersonalPlaylistTrackPage).items[0]!.durationMs, null);
  assert.ok(received.length >= 2); for (const names of received) assert.deepEqual(names, ['body', 'path', 'pathParameters', 'query']);
  revision = 'playlist.rev2'; await assert.rejects(reply.beforeSend(), MobileServiceError);
});
