import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { decodeMobileRequest, decodeMobileResponse, MOBILE_OPERATION_TABLE, type MobileTrack } from '@music-bridge/contracts';
import { createMobileBackend } from '../../src/main/mobile-backend.js';
import { createCollectionRepository } from '../../../../packages/bridge-core/src/collection/repository.js';
import { createTestDatasetDomain } from '../../../../packages/bridge-core/src/collection/dataset-domain.js';
import { createMobileContentRpcPort } from '../../../../packages/bridge-core/src/mobile/content-rpc-port.js';
import type { MobileContentCoreRequest, MobileContentCoreResponse } from '../../../../packages/bridge-core/src/mobile/content-rpc.js';
import { captureMobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import type { MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import { copyCatalogTraceRecord, withCatalogTrace, MOBILE_CATALOG_TRACE_PREFIX } from '../../../../packages/bridge-core/src/mobile/catalog-private-trace.js';
import { isMobileOwnerPrivateRequest } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { MobileServiceError, type Mobile001BackendReply, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/types.js';

const DATASET = '61000000-0000-4000-8000-000000000001';
const OWNER = '61000000-0000-4000-8000-000000000002';
const SERVER = 'server.precise-activity', ORIGIN = 'https://127.0.0.1:9443';
const TRACK = 'nt:synthetic:1';
const track: MobileTrack = { id: TRACK, title: '合成精确曲目', artists: ['合成作者'], albumId: 'na:synthetic:1',
  source: 'netease', sourceItemId: '1', versionId: 'nv:synthetic', contentRevision: 'nr:synthetic',
  editionLabel: '', durationMs: 1000, audio: { codec: 'flac', container: 'flac', sampleRateHz: 48000, channels: 2, bitsPerSample: 16 },
  availability: 'available' };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise<void>(done => setImmediate(done));
async function turns() { for (let n = 0; n < 8; n++) await turn(); }
async function until(predicate: () => boolean) {
  const end = performance.now() + 2000;
  while (!predicate()) { assert.ok(performance.now() < end, '必须进入真实请求的被保持阶段。'); await turn(); }
}

/** 实际MessageChannel承载原请求；只以合成精确Provider DTO代替真实账号网络。 */
function channel<I, O>(handler: (value: I) => Promise<O>) {
  const { port1, port2 } = new MessageChannel(); let next = 0;
  const pending = new Map<number, { resolve(value: O): void; reject(error: unknown): void }>();
  port1.on('message', (packet: { id: number; value?: O; failed?: true }) => {
    const entry = pending.get(packet.id); if (!entry) return; pending.delete(packet.id);
    if (packet.failed) entry.reject(new MobileServiceError(503, 'BUSY')); else entry.resolve(packet.value!);
  });
  port2.on('message', (packet: { id: number; value: I }) => {
    void handler(packet.value).then(value => port2.postMessage({ id: packet.id, value }),
      () => port2.postMessage({ id: packet.id, failed: true }));
  });
  const call = (value: I): Promise<O> => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); port1.postMessage({ id, value });
  });
  return Object.assign(call, {
    async quiet() { await until(() => pending.size === 0); assert.equal(pending.size, 0, '所有测试消息须自然收口。'); },
    close() { port1.close(); port2.close(); },
  });
}

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  const directory = mkdtempSync(path.join(temporary, 'mac61-precise-')); chmodSync(directory, 0o700);
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  const domain = createTestDatasetDomain({ collectionRepository: repository,
    collectionDatasetIdentity: { datasetId: DATASET, assertCurrent() {} }, localSourceEpoch: OWNER });
  const dispatchOwner = domain.mobileMain; assert.ok(dispatchOwner);
  const ownerCalls: MobileOwnerPrivateRequest['kind'][] = [], activity: string[] = [], leases = new Set<string>();
  const sqlStages: string[] = [], sourceCalls: string[] = [], scopeCalls: string[] = [];
  let readGate: ReturnType<typeof gate> | undefined, revalidateGate: ReturnType<typeof gate> | undefined;
  let readEntered = false, revalidateEntered = false;
  let failRead = false, failRevalidate = false;
  let beginGate: ReturnType<typeof gate> | undefined, endGate: ReturnType<typeof gate> | undefined;
  let beginEntered = false, endEntered = false, failBegin = false;
  const requestOwner = channel<MobileOwnerPrivateRequest, MobileOwnerPrivateResult>(async input => {
    assert.equal(isMobileOwnerPrivateRequest(input), true, '不能给私有Owner夹带新业务字段。');
    ownerCalls.push(input.kind);
    if (input.kind === 'playback-activity' && input.request.operation === 'begin') {
      beginEntered = true;
      if (beginGate) await beginGate.promise;
      if (failBegin) return { kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: null };
    }
    const result = await dispatchOwner(input);
    if (input.kind === 'playback-activity') {
      activity.push(input.request.operation);
      assert.ok('kind' in result && result.kind === 'playback-activity');
      if (result.kind === 'playback-activity' && result.leaseId) {
        if (input.request.operation === 'begin') leases.add(result.leaseId); else leases.delete(result.leaseId);
      }
      if (input.request.operation === 'end') { endEntered = true; if (endGate) await endGate.promise; }
    }
    return result;
  });
  let scope: MobileContentScope | undefined;
  const rpc = createMobileContentRpcPort({
    async initialize() {}, async invalidateDevice() {},
    async resolveScope(principal) { return scope = captureMobileContentScope({ ...principal, ownerEpoch: OWNER, accountDomain: 'account.synthetic', providerEpoch: 'provider.synthetic' }); },
    assertScope(value, stage) { assert.ok(scope); assert.deepEqual(captureMobileContentScope(value), scope); scopeCalls.push(stage); },
    async neteasePlaybackQualified() { return true; },
    async readTrack(value, id, expected, signal) {
      assert.deepEqual(captureMobileContentScope(value), scope); assert.equal(id, TRACK);
      sourceCalls.push(expected === null ? 'read' : 'revalidate');
      if (expected === null) { readEntered = true; if (readGate) await readGate.promise; if (failRead) throw new MobileServiceError(503, 'BUSY'); }
      else { revalidateEntered = true; if (revalidateGate) await revalidateGate.promise; if (failRevalidate) throw new MobileServiceError(503, 'BUSY'); }
      signal.throwIfAborted(); return structuredClone(track);
    },
    async source() { throw new MobileServiceError(400, 'INVALID_REQUEST'); },
    content: { async dispatch() { throw new MobileServiceError(400, 'INVALID_REQUEST'); } },
  });
  const requestContentRpc = channel<MobileContentCoreRequest, MobileContentCoreResponse>(
    input => rpc.request(input, new AbortController().signal));
  const handle = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey: new Uint8Array(32).fill(61),
    displayName: '合成Owner', environment: 'development', requestOwner, assertCurrent() {},
    resizeArtwork(bytes) { return bytes; }, enablePlayback: true, enableContent: true, requestContentRpc });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { try { await handle.close(); } finally { await rpc.close(); } })();
  t.after(async () => {
    readGate?.resolve(); revalidateGate?.resolve(); beginGate?.resolve(); endGate?.resolve();
    try { await close(); await requestOwner.quiet(); await requestContentRpc.quiet(); }
    finally { requestOwner.close(); requestContentRpc.close(); await domain.close(); repository.close(); rmSync(directory, { recursive: true }); }
  });
  const permit = await handle.auth.issuePairing();
  const pair = await handle.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.precise', deviceName: '合成设备' }, 'claim.precise');
  handle.activatePlayback(ORIGIN); await turns();
  ownerCalls.length = 0;
  const getTrack = async (signal = new AbortController().signal): Promise<Mobile001BackendReply> => {
    const operation = 'getTrack', rawPath = MOBILE_OPERATION_TABLE[operation].path.replace('{trackId}', encodeURIComponent(TRACK));
    const decoded = decodeMobileRequest(operation, { method: 'GET', path: rawPath,
      headers: [['Authorization', 'Bearer ' + pair.accessToken]], query: [], body: new Uint8Array() },
      { responseOrigin: ORIGIN, requestPath: rawPath });
    assert.ok(decoded.ok);
    return handle.backend.dispatch({ operation, request: decoded.value, accessToken: pair.accessToken, signal });
  };
  const body = (reply: Mobile001BackendReply) => {
    const rawPath = MOBILE_OPERATION_TABLE.getTrack.path.replace('{trackId}', encodeURIComponent(TRACK));
    const decoded = decodeMobileResponse('getTrack', { status: reply.status, headers: reply.headers, body: reply.body, finalUrl: ORIGIN + rawPath },
      { responseOrigin: ORIGIN, requestPath: rawPath });
    assert.ok(decoded.ok && decoded.value.category === 'success'); return decoded.value.body;
  };
  const page = async (changes: Partial<Extract<MobileOwnerPrivateRequest, { kind: 'catalog' }>['request']> = {}) => {
    const input: MobileOwnerPrivateRequest = { kind: 'catalog', datasetId: DATASET,
      request: { operation: 'listTracks', serverId: SERVER, offset: 1, limit: 100, q: '', albumId: null,
        itemId: null, expectedRevision: null, catalogPlaybackEnabled: false, ...changes } };
    return withCatalogTrace({ schema: 1, requestSha256: 'a'.repeat(64), nonceSha256: 'b'.repeat(64), offset: input.request.offset, limit: 100 },
      'owner', () => dispatchOwner(input), line => {
        const record = copyCatalogTraceRecord(JSON.parse(line.slice(MOBILE_CATALOG_TRACE_PREFIX.length)));
        assert.ok(record); if (record.stage === 'owner.sql-page' && record.phase === 'begin') sqlStages.push(record.stage);
      });
  };
  return { handle, getTrack, body, page, requestOwner, ownerCalls, sourceCalls, scopeCalls, sqlStages, activity, leases, close,
    holdRead() { readGate = gate(); }, holdRevalidate() { revalidateGate = gate(); },
    releaseRead() { readGate?.resolve(); }, releaseRevalidate() { revalidateGate?.resolve(); },
    readEntered: () => readEntered, revalidateEntered: () => revalidateEntered,
    failRead() { failRead = true; }, failRevalidate() { failRevalidate = true; },
    holdBegin() { beginGate = gate(); }, releaseBegin() { beginGate?.resolve(); }, beginEntered: () => beginEntered,
    holdEnd() { endGate = gate(); }, releaseEnd() { endGate?.resolve(); }, endEntered: () => endEntered,
    failBegin() { failBegin = true; } };
}

test('M61有效RED：精确getTrack被保持时，MessageChannel后页不得进入原Owner SQL', async t => {
  const f = await fixture(t); f.holdRead();
  const pending = f.getTrack(); void pending.catch(() => {}); await until(f.readEntered);
  const page = f.page();
  try {
    await turns();
    await f.requestOwner({ kind: 'load', datasetId: DATASET });
    assert.equal(f.sqlStages.length, 0, '精确播放元数据的真实生命周期必须持有原Owner活动。');
  } finally {
    f.releaseRead(); const reply = await pending; await reply.beforeSend?.(); await page;
  }
  assert.deepEqual(f.sourceCalls, ['read', 'revalidate']);
  assert.deepEqual(f.activity, ['begin', 'end']); assert.equal(f.leases.size, 0);
  assert.equal(f.sqlStages.length, 1, '正常退出后后台必须恢复原完整页处理。');
});

test('M61发送前复验仍持活动，完整DTO与原fresh读取/认证次数不变', async t => {
  const f = await fixture(t); f.holdRevalidate();
  const reply = await f.getTrack(); assert.deepEqual(JSON.parse(JSON.stringify(f.body(reply))), track);
  assert.equal(f.leases.size, 1, 'dispatch返回不能提前结束同HTTP的活动。');
  const sending = reply.beforeSend!(); void sending.catch(() => {});
  await until(f.revalidateEntered);
  const page = f.page();
  try { await turns(); assert.equal(f.sqlStages.length, 0); assert.equal(f.leases.size, 1); }
  finally { f.releaseRevalidate(); await sending; await page; }
  assert.deepEqual(f.sourceCalls, ['read', 'revalidate']); assert.equal(f.scopeCalls.length, 8);
  assert.equal(f.ownerCalls.filter(kind => kind === 'load').length, 3, 'authenticate、原alive及最终auth都必须实际重读Owner。');
  assert.deepEqual(f.activity, ['begin', 'end']); assert.equal(f.leases.size, 0);
});

test('M61读取异常与复验异常均释放活动，失败不发布新的成功回执', async t => {
  for (const phase of ['read', 'revalidate'] as const) await t.test(phase, async child => {
    const f = await fixture(child);
    if (phase === 'read') { f.failRead(); await assert.rejects(f.getTrack(), MobileServiceError); }
    else { const reply = await f.getTrack(); f.failRevalidate(); await assert.rejects(reply.beforeSend!(), MobileServiceError); }
    await turns(); assert.deepEqual(f.activity, ['begin', 'end']); assert.equal(f.leases.size, 0);
    const page = await f.page(); assert.ok('items' in page, '原后台完整页应恢复，不能以BUSY代替。');
    assert.equal(f.sqlStages.length, 1);
  });
});

test('M61断开覆盖读取中、dispatch后未发送及复验中三个阶段', async t => {
  for (const phase of ['read', 'returned', 'revalidate'] as const) await t.test(phase, async child => {
    const f = await fixture(child), controller = new AbortController();
    if (phase === 'read') {
      f.holdRead(); const pending = f.getTrack(controller.signal); void pending.catch(() => {}); await until(f.readEntered);
      controller.abort(); await turns(); assert.equal(f.leases.size, 0);
      f.releaseRead(); await assert.rejects(pending);
    } else {
      const reply = await f.getTrack(controller.signal); assert.equal(f.leases.size, 1);
      if (phase === 'revalidate') {
        f.holdRevalidate(); const sending = reply.beforeSend!(); void sending.catch(() => {}); await until(f.revalidateEntered);
        controller.abort(); await turns(); assert.equal(f.leases.size, 0); f.releaseRevalidate(); await assert.rejects(sending);
      } else {
        controller.abort(); await turns(); assert.equal(f.leases.size, 0); await assert.rejects(reply.beforeSend!());
      }
    }
    await turns(); assert.deepEqual(f.activity, ['begin', 'end']);
    const page = await f.page(); assert.ok('items' in page); assert.equal(f.sqlStages.length, 1);
  });
});

test('M61关闭先释放同HTTP活动，再等待原Core请求quiet，迟到内容不发布', async t => {
  const f = await fixture(t); f.holdRead();
  const pending = f.getTrack(); void pending.catch(() => {}); await until(f.readEntered);
  const closing = f.close(); void closing.catch(() => {}); await turns();
  assert.equal(f.leases.size, 0, '不能等迟到Provider回复才松后台。');
  f.releaseRead(); await assert.rejects(pending); await closing;
  assert.deepEqual(f.activity, ['begin', 'end']);
  const page = await f.page(); assert.ok('items' in page);
});

test('M61迟到begin ACK遇断开或关闭只归还自己的同代租约，不启动精读', async t => {
  for (const phase of ['abort', 'close'] as const) await t.test(phase, async child => {
    const f = await fixture(child), controller = new AbortController(); f.holdBegin();
    const pending = f.getTrack(controller.signal); void pending.catch(() => {}); await until(f.beginEntered);
    const closing = phase === 'close' ? f.close() : undefined; void closing?.catch(() => {});
    if (phase === 'abort') controller.abort();
    await assert.rejects(pending);
    f.releaseBegin(); await turns(); if (closing) await closing;
    assert.deepEqual(f.activity, ['begin', 'end']); assert.equal(f.leases.size, 0); assert.deepEqual(f.sourceCalls, []);
  });
});

test('M61RAM提示失败不改变业务，end ACK迟到不阻塞成功发送前守门', async t => {
  for (const phase of ['begin-failure', 'end-late'] as const) await t.test(phase, async child => {
    const f = await fixture(child); if (phase === 'begin-failure') f.failBegin(); else f.holdEnd();
    const reply = await f.getTrack(); assert.deepEqual(JSON.parse(JSON.stringify(f.body(reply))), track);
    await reply.beforeSend!();
    if (phase === 'end-late') { await until(f.endEntered); assert.equal(f.leases.size, 0); f.releaseEnd(); }
    await turns(); assert.deepEqual(f.sourceCalls, ['read', 'revalidate']); assert.equal(f.scopeCalls.length, 8);
    assert.equal(f.ownerCalls.filter(kind => kind === 'load').length, 3);
    assert.equal(f.leases.size, 0);
  });
});

test('M61活动不扩大60原两秒让步预算，耗完仍走原完整后台页', async t => {
  const f = await fixture(t); f.holdRead();
  const pending = f.getTrack(); void pending.catch(() => {}); await until(f.readEntered);
  let now = 0; t.mock.method(performance, 'now', () => now);
  const page = f.page();
  try {
    await turns(); assert.equal(f.sqlStages.length, 0); now = 2001;
    const result = await page; assert.ok('items' in result); assert.equal(f.sqlStages.length, 1);
    assert.equal(f.leases.size, 1, '后台预算耗完不会冒充归还或撤销真实前台。');
  } finally { f.releaseRead(); const reply = await pending; await reply.beforeSend!(); }
  await turns(); assert.equal(f.leases.size, 0);
});

test('M61精读活动期间首批、search和album列表维持60原准入规则', async t => {
  const f = await fixture(t); f.holdRead();
  const pending = f.getTrack(); void pending.catch(() => {}); await until(f.readEntered);
  try {
    for (const changes of [{ offset: 0 }, { q: '合成' }, { operation: 'listAlbums' as const }]) {
      const previous = f.sqlStages.length; const result = await f.page(changes);
      assert.ok('items' in result); assert.equal(f.sqlStages.length, previous + 1);
    }
    assert.equal(f.leases.size, 1);
  } finally { f.releaseRead(); const reply = await pending; await reply.beforeSend!(); }
});
