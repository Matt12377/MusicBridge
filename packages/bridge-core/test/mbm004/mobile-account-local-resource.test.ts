import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { createLocalSourceTickets } from '../../src/collection/local-source-tickets.js';
import { NeteaseClient } from '../../src/netease/client.js';
import type { NeteaseMobileAccountSnapshot, NeteaseRequestOptions } from '../../src/netease/types.js';
import { createMobileContentRuntime } from '../../src/mobile/content-runtime.js';
import type { MobileContentCoreRequest } from '../../src/mobile/content-rpc.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import { createMobileOwnerSourceService } from '../../src/mobile/source-service.js';
import { makeContentRuntimeOwnerFixture } from './content-owner-fixture.js';

function quiet(source: ReturnType<typeof createMobileOwnerSourceService>, tickets: ReturnType<typeof createLocalSourceTickets>): void {
  const snapshot = source.resourceSnapshot();
  for (const key of ['liveResources', 'preparing', 'releasing', 'readers', 'activeIo', 'openLeases',
    'reservations', 'tickets', 'retainedFences', 'lanes'] as const) assert.equal(snapshot[key], 0, `${key} 必须真实归零。`);
  assert.equal(tickets.size, 0);
}
function ack(value: MobileOwnerSourceResult, operation: 'close-read' | 'verify' | 'renew' | 'release', handle: string, readId: string | null = null): void {
  assert.deepEqual(value, { kind: 'mobile-source-ack', operation, handle, readId, quiet: true });
}

// 真实冷Client/账号解析器→runtime/RPC→原Owner/SQLite/Scanner/Reader/源FD；SDK端口全部合成，无HTTP或真实账号。
test('MBM账号投影：完整profile经真实scope仍可读取续租释放本地原字节且撤权守门', { concurrency: false }, async t => {
  const f = await makeContentRuntimeOwnerFixture(t), key = new Uint8Array(randomBytes(32));
  let tickets: ReturnType<typeof createLocalSourceTickets> | undefined;
  let source: ReturnType<typeof createMobileOwnerSourceService> | undefined;
  let runtime: ReturnType<typeof createMobileContentRuntime> | undefined;
  const failures: unknown[] = [];
  try {
    tickets = createLocalSourceTickets(f.repository, f.ownerEpoch, f.datasetId, f.assertCurrent);
    source = createMobileOwnerSourceService({ collection: f.repository, datasetId: f.datasetId,
      ownerEpoch: f.ownerEpoch, tickets, assertCurrent: f.assertCurrent });
    const actualSource = source;
    const owner: DatasetOwnerEndpoint = { ...f.ownerEndpoint,
      async mobileMain(request) {
        if (request.kind === 'media-source') {
          assert.equal(request.datasetId, f.datasetId); return actualSource.dispatch(request.request);
        }
        return f.ownerEndpoint.mobileMain!(request);
      },
    };
    const calls = { account: 0, other: 0 };
    const forbidden = async (): Promise<never> => { calls.other++; throw new Error('本地原字节读取不得调用其他Provider方法。'); };
    const profile = { userId: '700', nickname: '完整合成档案', avatarImgId: Number.MAX_SAFE_INTEGER + 1,
      avatarUrl: 'https://synthetic.invalid/unused-cover', backgroundImgId: Number.MAX_SAFE_INTEGER + 3 };
    const client = new NeteaseClient('synthetic-local-resource-only', {
      login_qr_key: forbidden, login_qr_create: forbidden, login_qr_check: forbidden,
      login_status: forbidden, logout: forbidden, song_detail: forbidden, song_url_v1: forbidden,
      async user_account() { calls.account++; return { body: { code: 200, account: { id: '700' }, profile },
        cookie: ['synthetic-wrapper-cookie-never-forwarded'] }; },
    }, async () => undefined);
    const observedAccounts: NeteaseMobileAccountSnapshot[] = [];
    const nativeAccount = client.mobileAccount.bind(client);
    t.mock.method(client, 'mobileAccount', async (options?: NeteaseRequestOptions) => {
      const value = await nativeAccount(options); observedAccounts.push(value); return value;
    });
    runtime = createMobileContentRuntime({ owner, netease: client, assertCurrent: f.assertCurrent });
    const rpc = (request: MobileContentCoreRequest) => runtime!.request(request, new AbortController().signal);
    const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
    const initialized = await rpc({ ...base(), action: 'initialize', serverId: f.serverId,
      datasetId: f.datasetId, key: new Uint8Array(key) });
    assert.ok('ok' in initialized && initialized.ok);
    const scoped = await rpc({ ...base(), action: 'scope', principal: { serverId: f.serverId,
      datasetId: f.datasetId, deviceId: 'synthetic.local.resource.device', deviceEpoch: 1, accessGeneration: 1 } });
    assert.ok('kind' in scoped && scoped.kind === 'scope', '完整profile的无关头像整数不得使真实账号scope拒绝。');
    const scope = scoped.scope;
    assert.equal(calls.account, 1, '冷scope即时只读取一次原Client账号。');
    assert.equal(observedAccounts.length, 1); assert.equal(observedAccounts[0]!.accountId, '700');
    assert.equal(scope.providerEpoch, observedAccounts[0]!.providerEpoch);
    assert.notEqual(scope.accountDomain, `local:${f.datasetId}`);
    assert.equal(scope.datasetId, f.datasetId); assert.equal(scope.ownerEpoch, f.ownerEpoch);
    assert.deepEqual(Object.keys(observedAccounts[0]!).sort(), ['accountId', 'providerEpoch']);
    const sourceRpc = async (request: MobileOwnerSourceRequest): Promise<MobileOwnerSourceResult> => {
      const response = await rpc({ ...base(), action: 'source', scope, request });
      assert.ok(response.action === 'source' && 'kind' in response && response.kind === 'source',
        '每次本地资源操作必须穿过原runtime scope与RPC守门。');
      assert.equal(response.source, 'local'); return response.result;
    };
    const handle = randomUUID();
    const prepared = await sourceRpc({ operation: 'prepare', selection: { resourceId: handle,
      trackId: f.track.id, versionId: f.track.versionId, contentRevision: f.track.contentRevision } });
    assert.equal(prepared.kind, 'mobile-source-prepared'); assert.ok(prepared.kind === 'mobile-source-prepared');
    assert.equal(prepared.source.handle, handle); assert.equal(prepared.source.contentType, 'audio/wav');
    assert.equal(prepared.source.size, f.original.length); assert.equal(prepared.source.processing.mode, 'direct');
    assert.equal(prepared.source.processing.fromPreparedCache, false);
    assert.deepEqual(prepared.source.actualAudio, prepared.source.sourceAudio);
    const readId = randomUUID(), chunks: Uint8Array[] = [];
    for (let start = 0; start < f.original.length;) {
      const read = await sourceRpc({ operation: 'read', handle, readId, start, maxBytes: 64 * 1024 });
      assert.ok(read.kind === 'mobile-source-read'); assert.equal(read.handle, handle);
      assert.equal(read.readId, readId); assert.equal(read.start, start);
      assert.ok(read.bytes.length > 0 && read.bytes.length <= 64 * 1024);
      assert.ok(start + read.bytes.length <= f.original.length);
      chunks.push(read.bytes); start += read.bytes.length;
    }
    assert.deepEqual(Buffer.concat(chunks), f.original, '整曲读取必须保持原WAV所有字节。');
    const eof = await sourceRpc({ operation: 'read', handle, readId, start: f.original.length, maxBytes: 64 * 1024 });
    assert.ok(eof.kind === 'mobile-source-read'); assert.equal(eof.bytes.length, 0);
    ack(await sourceRpc({ operation: 'close-read', handle, readId }), 'close-read', handle, readId);
    assert.ok(f.original.length > 32);
    const rangeId = randomUUID(), range = await sourceRpc({ operation: 'read', handle, readId: rangeId, start: 7, maxBytes: 13 });
    assert.ok(range.kind === 'mobile-source-read');
    assert.deepEqual(range.bytes, new Uint8Array(f.original.subarray(7, 20)));
    ack(await sourceRpc({ operation: 'close-read', handle, readId: rangeId }), 'close-read', handle, rangeId);
    ack(await sourceRpc({ operation: 'verify', handle }), 'verify', handle);
    ack(await sourceRpc({ operation: 'renew', handle }), 'renew', handle);
    ack(await sourceRpc({ operation: 'release', handle }), 'release', handle);
    quiet(source, tickets);
    const revoked = await rpc({ ...base(), action: 'invalidate-device', serverId: f.serverId, datasetId: f.datasetId,
      deviceId: scope.deviceId, deviceEpoch: scope.deviceEpoch });
    assert.ok('ok' in revoked && revoked.ok);
    const denied = await rpc({ ...base(), action: 'source', scope, request: { operation: 'prepare', selection: {
      resourceId: randomUUID(), trackId: f.track.id, versionId: f.track.versionId, contentRevision: f.track.contentRevision } } });
    assert.ok('kind' in denied && denied.kind === 'error');
    assert.equal(denied.status, 401); assert.equal(denied.code, 'UNAUTHORIZED'); quiet(source, tickets);
    // 原10秒账号缓存可以自然过期；每次实际重读仍须保持同一账号及真实Provider代际。
    assert.ok(calls.account >= 1); assert.equal(calls.other, 0);
    assert.equal(observedAccounts.length, calls.account);
    assert.ok(observedAccounts.every(account => account.accountId === '700' && account.providerEpoch === scope.providerEpoch));
    assert.deepEqual(await readFile(f.file), f.original);
  } catch (error) { failures.push(error); }
  // 实际runtime/source全部关闭后才让原夹具关闭Reader/Repository；首业务错误不被清理错误覆盖。
  for (const close of [() => runtime?.close(), () => source?.close(), () => tickets?.seal()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (source && tickets) { try { quiet(source, tickets); } catch (error) { failures.push(error); } }
  try { assert.deepEqual(await readFile(f.file), f.original); } catch (error) { failures.push(error); }
  key.fill(0);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, '原账号与本地资源业务或真实清理未完全成立。', { cause: failures[0] });
});
