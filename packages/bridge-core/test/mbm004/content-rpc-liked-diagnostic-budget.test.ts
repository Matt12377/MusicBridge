import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { MOBILE_OPERATION_TABLE, mobileContentResponseSnapshot } from '@music-bridge/contracts';
import { createMobileContentRpcPort } from '../../src/mobile/content-rpc-port.js';
import { createMobileContentProviderService } from '../../src/mobile/content-provider-service.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import type { MobileContentScope, MobileContentOperation, MobileContentPort } from '../../src/mobile/content-types.js';
import { captureMobileCapabilityContext, copyMobileCapabilityTraceRecord, createMobileCapabilityTraceReader,
  mobileCapabilityRequestSha, type MobileCapabilityTraceRecord } from '../../src/mobile/capability-trace.js';
import { createMobilePrivateContentTraceRelay } from '../../src/mobile/private-content-trace-relay.js';
import { createActualMobileNeteasePorts, type ActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import type { NeteaseMobileReadPort } from '../../src/netease/types.js';
import { captureMobileNeteaseScope } from '../../src/mobile/netease-source-types.js';

// 原RPC→ProviderService→实际映射器组合；SDK端口仅给合成目录，不建立HTTP或使用真实账号。
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
const signal = () => new AbortController().signal;
const identity = { serverId: 'server.rpc-budget', datasetId: 'dataset.rpc-budget', ownerEpoch: 'owner.rpc-budget' };
const principal = { serverId: identity.serverId, datasetId: identity.datasetId, deviceId: 'device.rpc-budget', deviceEpoch: 1, accessGeneration: 1 };
const stage = 'provider.content.collection.count-mismatch';
const fields = ['schema', 'component', 'requestSha256', 'parentSha256', 'relatedSha256', 'epochMs', 'elapsedMs',
  'stage', 'phase', 'role', 'name', 'code', 'outcome', 'aborted', 'initState'].sort();

async function fixture(t: TestContext, enabled: boolean) {
  let actual: ActualMobileNeteasePorts | undefined;
  let service: ReturnType<typeof createMobileContentProviderService> | undefined;
  let broken = false, reads = 0, initializations = 0;
  const observed: { operation: string; privateContext: boolean }[] = [];
  const rows: MobileCapabilityTraceRecord[] = [], relayed: MobileCapabilityTraceRecord[] = [], lines: string[] = [];
  const downstream = createMobileCapabilityTraceReader(row => { relayed.push(row); });
  const relay = createMobilePrivateContentTraceRelay({ enabled: true, sink(line) { lines.push(line); downstream(line); } });
  const reader = createMobileCapabilityTraceReader(row => { rows.push(row); relay.capability(row); });
  const client: NeteaseMobileReadPort = {
    configured: true,
    async mobileAccount() { return { accountId: '700', providerEpoch: 'provider.rpc-budget' }; },
    async mobileRead(request) {
      reads++;
      const response = request.operation === 'user-playlists'
        ? { code: 200, more: false, playlist: [{ id: '9', specialType: 5, creator: { userId: '700' } }] }
        : request.operation === 'charts' ? { code: 200, list: [{ id: '9' }] }
          : request.operation === 'playlist-detail' ? { code: 200, playlist: { id: '9', name: '合成红心目录',
            specialType: 5, creator: { userId: '700' }, userId: '700', trackCount: broken ? 1 : 0, trackIds: [], updateTime: 7 } }
            : assert.fail('此夹具不读取歌曲、来源地址或音频。');
      return { providerEpoch: 'provider.rpc-budget', response };
    },
    onMobileAccountInvalidated() { return () => {}; },
    async awaitMobileQuiet() {},
  };
  const content: MobileContentPort = { async dispatch(input) {
    const context = captureMobileCapabilityContext();
    observed.push({ operation: input.operation, privateContext: context?.privateContentDiagnostic === true });
    // 仅重定向原RPC创建的输出sink；不创建context，不补写privateContentDiagnostic。
    if (context) Object.defineProperty(context, 'sink', { value: (line: string) => reader(line) });
    assert.ok(service); return service.dispatch(input);
  } };
  const rpc = createMobileContentRpcPort({
    async initialize(input) {
      initializations++;
      actual = createActualMobileNeteasePorts({ client, ...identity, identityKey32: new Uint8Array(32).fill(19),
        privateProviderDiagnostics: input.privateProviderDiagnostics === true, now: () => 1700000000000,
        async assertCurrent() {}, fetch: async () => { throw new Error('合成目录测试禁止HTTP。'); } });
      service = createMobileContentProviderService({ provider: actual.provider, cursorKey: new Uint8Array(32).fill(23),
        now: () => 1700000000000, assertCurrent: scope => actual!.assertCurrent(scope, 'acquire', signal()) });
    },
    async invalidateDevice() {}, content,
    async resolveScope(value) {
      assert.ok(actual); const account = await actual.account.current(signal()); assert.ok(account);
      return { ...value, ownerEpoch: identity.ownerEpoch, ...account };
    },
    assertScope(scope, mode, owned) { assert.ok(actual); return actual.assertCurrent(captureMobileNeteaseScope(scope), mode, owned); },
    async source() { return assert.fail('目录诊断不准备播放资源。'); },
  });
  t.after(async () => { await rpc.close(); service?.close(); await actual?.close(); });
  const key = new Uint8Array(32).fill(17);
  const initialized = await rpc.request({ ...base(), action: 'initialize', serverId: identity.serverId, datasetId: identity.datasetId,
    key, ...(enabled ? { privateProviderDiagnostics: true as const } : {}) }, signal());
  assert.ok(initialized.action === 'initialize' && 'ok' in initialized && initialized.ok);
  const scoped = await rpc.request({ ...base(), action: 'scope', principal }, signal());
  assert.ok(scoped.action === 'scope' && scoped.kind === 'scope');
  const scope: Readonly<MobileContentScope> = scoped.scope;
  async function dispatch(operation: MobileContentOperation, query: Record<string, string | number> = {}) {
    const id = randomUUID(), request = captureMobileContentRequest(operation,
      { path: MOBILE_OPERATION_TABLE[operation].path, pathParameters: {}, query, body: null });
    const reply = await rpc.request({ type: 'mobile-content-core-request', id, action: 'dispatch', operation, scope, request }, signal());
    if (reply.action === 'dispatch' && reply.kind === 'snapshot') {
      const ack = await rpc.request({ ...base(), action: 'revalidate', snapshotId: reply.snapshotId, scope }, signal());
      assert.ok(ack.action === 'revalidate' && ack.kind === 'validated');
    }
    return { id, reply };
  }
  const metadata = await dispatch('getNeteaseLikedPlaylist');
  assert.ok(metadata.reply.action === 'dispatch' && metadata.reply.kind === 'snapshot' && metadata.reply.operation === 'getNeteaseLikedPlaylist');
  const captured = mobileContentResponseSnapshot('neteaseLikedPlaylist', metadata.reply.reply.body);
  assert.ok(captured.ok); const body = captured.value;
  const query = { playlistId: body.playlistId, accountDomain: body.accountDomain, playlistRevision: body.playlistRevision, limit: 1 };
  return { rpc, dispatch, query, observed, rows, relayed, lines,
    breakMapping(value = true) { broken = value; }, reads: () => reads, initializations: () => initializations,
    reinitialize: () => rpc.request({ ...base(), action: 'initialize', serverId: identity.serverId, datasetId: identity.datasetId,
      key: new Uint8Array(32).fill(17), privateProviderDiagnostics: true }, signal()),
  };
}

test('真实RPC的红心第9/20/512次保留实际映射首拒并穿过reader与relay，第513次预算停止且业务照常', async t => {
  const f = await fixture(t, true);
  for (let index = 1; index <= 513; index++) {
    const broken = [9, 20, 512, 513].includes(index); f.breakMapping(broken);
    const { id, reply } = await f.dispatch('listNeteaseLikedPlaylistTracks', f.query);
    assert.equal(f.observed.at(-1)?.privateContext, index <= 512, `第${index}次RPC诊断上下文预算不符。`);
    if (!broken) { assert.ok(reply.action === 'dispatch' && reply.kind === 'snapshot'); continue; }
    assert.ok('kind' in reply && reply.kind === 'error'); assert.equal(reply.status, 409); assert.equal(reply.code, 'SOURCE_CHANGED');
    assert.equal(reply.retryable, false); assert.equal(reply.outcome, null);
    const sha = mobileCapabilityRequestSha('content', id);
    const original = f.rows.find(row => row.requestSha256 === sha && row.stage === stage && row.phase === 'reject');
    const forwarded = f.relayed.find(row => row.requestSha256 === sha && row.stage === stage && row.phase === 'reject');
    assert.equal(!!original, index <= 512); assert.equal(!!forwarded, index <= 512);
    if (original) { assert.deepEqual(Object.keys(original).sort(), fields); assert.ok(copyMobileCapabilityTraceRecord(original)); }
  }
  assert.equal(f.observed.filter(row => row.operation === 'listNeteaseLikedPlaylistTracks').length, 513);
  assert.equal(f.observed.filter(row => row.operation === 'listNeteaseLikedPlaylistTracks' && row.privateContext).length, 512);
  assert.equal(f.initializations(), 1);
  assert.doesNotMatch(f.lines.join(''), /合成红心目录|accountId|playlistId|https?:|cookie|token|message|stack/iu);
});

test('RPC只有红心分页扩到512，榜单第9次仍停旁注且原409不变', async t => {
  const f = await fixture(t, true); f.breakMapping();
  for (let index = 1; index <= 9; index++) {
    const { reply } = await f.dispatch('listNeteaseCharts', { limit: 1 });
    assert.ok('kind' in reply && reply.kind === 'error'); assert.equal(reply.status, 409); assert.equal(reply.code, 'SOURCE_CHANGED');
    assert.equal(f.observed.at(-1)?.privateContext, index <= 8);
  }
  assert.equal(f.observed.filter(row => row.operation === 'listNeteaseCharts' && row.privateContext).length, 8);
});

test('RPC私有开关缺省关闭，重复initialize不能提升或重置原预算', async t => {
  const f = await fixture(t, false); await f.reinitialize(); f.breakMapping();
  for (let index = 1; index <= 20; index++) {
    const { id, reply } = await f.dispatch('listNeteaseLikedPlaylistTracks', f.query);
    assert.ok('kind' in reply && reply.kind === 'error'); assert.equal(reply.status, 409); assert.equal(reply.code, 'SOURCE_CHANGED');
    assert.equal(f.observed.at(-1)?.privateContext, false);
    assert.equal(f.rows.filter(row => row.requestSha256 === mobileCapabilityRequestSha('content', id)).length, 0);
  }
  assert.equal(f.initializations(), 1); assert.equal(f.relayed.length, 0);
});
