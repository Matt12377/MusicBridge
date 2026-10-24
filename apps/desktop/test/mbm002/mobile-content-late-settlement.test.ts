import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IPC_VERSION, decodeMobileRequest, type MobileHeaderPairs, type MobileWireCodecContext } from '@music-bridge/contracts';
import { CoreSupervisor, type CoreMessagePort, type CoreChildProcess } from '../../src/main/core-supervisor.js';
import { attachCoreRuntimePort, type UtilityPort, type CoreRuntimeForIpc } from '../../../../packages/bridge-core/src/utility-main.js';
import { createMobileContentRpcPort } from '../../../../packages/bridge-core/src/mobile/content-rpc-port.js';
import { MobileAuthPersistenceError, MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js';
import { captureMobileContentCoreRequest, mobileContentRpcFailure, type MobileContentCoreRequest, type MobileContentCoreResponse, type MobileContentCoreSettlementObserver } from '../../../../packages/bridge-core/src/mobile/content-rpc.js';
import type { MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';

// 真实三层协议处理器；仅工作执行、内存MessagePort和进程退出为合成夹具。
// 不建立HTTP、真实Owner、文件FD、Provider或App；不把handler settled冒充FD quiet。
const scope: Readonly<MobileContentScope> = Object.freeze({ serverId: 'server.late.fixture', datasetId: 'dataset.late.fixture',
  deviceId: 'device.late.fixture', deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.late.fixture',
  accountDomain: 'account.late.fixture', providerEpoch: null });
const principal = { serverId: scope.serverId, datasetId: scope.datasetId, deviceId: scope.deviceId,
  deviceEpoch: scope.deviceEpoch, accessGeneration: scope.accessGeneration };
const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
const signal = () => new AbortController().signal;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let n = 0; n < 100; n++) await Promise.resolve(); }
function unknown(value: MobileContentCoreResponse) {
  assert.ok('kind' in value && value.kind === 'error'); assert.equal(value.outcome, 'unknown');
}
class MemoryPort implements CoreMessagePort, UtilityPort {
  peer: MemoryPort | undefined;
  readonly sent: unknown[] = [];
  readonly listeners: ((event: { data: unknown }) => void)[] = [];
  closed = false;
  constructor(readonly side: 'main' | 'core') {}
  on(_event: 'message', fn: (event: { data: unknown }) => void): void { this.listeners.push(fn); }
  start(): void {}
  close(): void { this.closed = true; }
  receive(data: unknown): void { if (!this.closed) for (const fn of this.listeners) fn({ data }); }
  postMessage(raw: unknown): void {
    const copied = structuredClone(raw); this.sent.push(copied);
    // 仅测试进程的最终退出控制。内容RPC从不造回包，全部经过真实utility处理。
    const x = copied as { version?: unknown; command?: unknown; id?: unknown };
    if (this.side === 'main' && x.version === IPC_VERSION && x.command === 'core.shutdown' && typeof x.id === 'string') {
      queueMicrotask(() => this.receive({ version: IPC_VERSION, id: x.id, ok: true, result: { stopped: true } })); return;
    }
    queueMicrotask(() => this.peer?.receive(copied));
  }
}
class MemoryChild implements CoreChildProcess {
  readonly exits: ((code: number) => void)[] = [];
  postMessage(): void {}
  once(_event: 'exit', fn: (code: number) => void): void { this.exits.push(fn); }
  exit(code: number): void { for (const fn of this.exits.splice(0)) fn(code); }
  kill(): boolean { this.exit(0); return true; } // 合成对象，不向任何OS进程发信号。
}
type Late = 'success' | 'known-failure' | 'unknown';
async function harness(t: TestContext, late: Late = 'success', mutation?: () => Promise<never>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const physical = deferred(), entered = deferred(), returned = deferred(), scopes = deferred(), fdClose = deferred();
  const sourceHandle = randomUUID(), readerId = randomUUID();
  let holdScopes = false, revoked = false, fdQuiet = false, readCalls = 0, closeCalls = 0;
  const rpc = createMobileContentRpcPort({ requestMs: 20, closeMs: 20,
    initialize: async () => undefined, invalidateDevice: async () => { revoked = true; },
    content: { dispatch: async () => { if (mutation) return mutation(); throw new Error('本测试不能派发内容写操作'); } },
    resolveScope: async () => { if (holdScopes) await scopes.promise; return scope; },
    assertScope() { if (revoked) throw new MobileServiceError(403, 'DEVICE_REVOKED'); },
    source: async (_scope, request) => {
      if (request.operation === 'read') {
        readCalls++; entered.resolve(); await physical.promise;
        try {
          if (late === 'known-failure') throw new MobileServiceError(409, 'SOURCE_CHANGED');
          if (late === 'unknown') throw new MobileAuthPersistenceError('unknown');
          return { source: 'local' as const, result: { kind: 'mobile-source-read' as const, handle: request.handle,
            readId: request.readId, start: request.start, bytes: new Uint8Array(8).fill(73) } };
        } finally { returned.resolve(); }
      }
      if (request.operation === 'close-read' || request.operation === 'release') {
        closeCalls++; entered.resolve(); await fdClose.promise; fdQuiet = true; returned.resolve();
        return { source: 'local' as const, result: { kind: 'mobile-source-ack' as const, operation: request.operation,
          handle: request.handle, readId: request.operation === 'close-read' ? request.readId : null, quiet: true as const } };
      }
      throw new Error('本测试不能prepare/renew/release或重放来源读取');
    },
  });
  const core = new MemoryPort('core'), main = new MemoryPort('main'); main.peer = core; core.peer = main;
  const children: MemoryChild[] = [];
  const supervisor = new CoreSupervisor({ entryPath: '/Volumes/LifeWeave/Developer/CommandLine/tmp/synthetic-core-never-executed.js',
    cwd: '/Volumes/LifeWeave/Developer/CommandLine/tmp', dependencies: {
      createChannel: () => ({ port1: core, port2: main }), fork: () => { const child = new MemoryChild(); children.push(child); return child; },
    } });
  const state = { runtime: 'ready' as const, roon: 'disconnected' as const, provider: 'missing' as const,
    activeStreamCount: 0, activePlaybackPresent: false };
  // IPC夹具只补实际attach在启动时用到的Runtime方法；不构造生产数据库/网络Runtime。
  const runtime = { start: async () => undefined, getState: () => state,
    mobileContentRpc: (call: MobileContentCoreRequest, parent: AbortSignal, onSettled?: MobileContentCoreSettlementObserver) => rpc.request(call, parent, onSettled),
  } as unknown as CoreRuntimeForIpc;
  const starting = supervisor.start(); await attachCoreRuntimePort(core, runtime); await starting;
  const initialized = await supervisor.requestMobileContentMain({ ...base(), action: 'initialize',
    serverId: scope.serverId, datasetId: scope.datasetId, key: new Uint8Array(32).fill(19) }, signal());
  assert.ok(initialized.action === 'initialize' && 'ok' in initialized && initialized.ok);
  t.after(async () => {
    physical.resolve(); scopes.resolve(); fdClose.resolve(); await flush(); await rpc.close();
    t.mock.timers.reset(); await supervisor.shutdown();
  });
  const read = (): Extract<MobileContentCoreRequest, { action: 'source' }> => ({ ...base(), action: 'source', scope,
    request: { operation: 'read', handle: sourceHandle, readId: readerId, start: 0, maxBytes: 8 } });
  const closeRead = (): MobileContentCoreRequest => ({ ...base(), action: 'source', scope,
    request: { operation: 'close-read', handle: sourceHandle, readId: readerId } });
  const release = (): MobileContentCoreRequest => ({ ...base(), action: 'source', scope,
    request: { operation: 'release', handle: sourceHandle } });
  const known = (id: string) => core.sent.filter((x): x is MobileContentCoreResponse => {
    const v = x as Partial<MobileContentCoreResponse>;
    return v.type === 'mobile-content-core-response' && v.id === id && !('kind' in v && v.kind === 'error' && v.outcome === 'unknown');
  });
  const admissions = async () => {
    holdScopes = true;
    const before = main.sent.length;
    const pending: Promise<unknown>[] = [];
    for (let n = 0; n < 15; n++) pending.push(supervisor.requestMobileContentMain({ ...base(), action: 'scope', principal }, signal()).catch(e => e));
    await flush();
    const count = main.sent.slice(before).filter(x => (x as { action?: unknown }).action === 'scope').length;
    scopes.resolve(); await Promise.allSettled(pending); return count;
  };
  return { rpc, runtime, supervisor, main, core, sourceHandle, physical, entered, returned, fdClose, read, closeRead, release, known, admissions,
    fdQuiet: () => fdQuiet, readCalls: () => readCalls, closeCalls: () => closeCalls, revoke: () => { revoked = true; } };
}

for (const late of ['success', 'known-failure', 'unknown'] as const) {
  test(`早UNKNOWN后原read晚${late}：${late === 'unknown' ? '仍未知保留原槽' : '晚确定结算回收RPC槽'}且不得复活原caller或FD资格`, async t => {
    const h = await harness(t, late), call = h.read();
    let deliveries = 0;
    const waiting = h.supervisor.requestMobileContentMain(call, signal()).then(result => { deliveries++; return result; });
    await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await waiting);
    assert.equal(h.fdQuiet(), false); h.physical.resolve(); await h.returned.promise; await flush();
    assert.equal(h.readCalls(), 1); assert.equal(deliveries, 1); assert.equal(h.fdQuiet(), false);
    assert.equal(h.known(call.id).some(x => 'kind' in x && x.kind === 'source' && x.result.kind === 'mobile-source-read'), false,
      '取消后的晚音频字节不能发布为原caller新成功');
    assert.equal(await h.admissions(), late === 'unknown' ? 14 : 15,
      late === 'unknown' ? '最终仍UNKNOWN不得只凭handler返回就授quiet或回收原槽' : '晚确定终态后应回收RPC槽；这不授予FD quiet');
  });
}

test('close-read晚到原quiet ACK：确有FD关闭证明才能回收，原caller仍保持UNKNOWN', async t => {
  const h = await harness(t), call = h.closeRead(), waiting = h.supervisor.requestMobileContentMain(call, signal());
  await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await waiting);
  assert.equal(h.fdQuiet(), false); h.fdClose.resolve(); await h.returned.promise; await flush();
  assert.equal(h.fdQuiet(), true); assert.equal(h.closeCalls(), 1);
  assert.equal(await h.admissions(), 15, '必须有原相同readId的quiet结算，不能永久吞掉晚ACK');
});

test('原cancel UNKNOWN后同代精确recheck：真quiet只收原目标及旧cancel，不留下第二个幽灵槽', async t => {
  const h = await harness(t), call = h.read(), reading = h.supervisor.requestMobileContentMain(call, signal());
  await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await reading);
  const cancel: Extract<MobileContentCoreRequest, { action: 'cancel' }> = { ...base(), action: 'cancel', requestId: call.id, snapshotId: null, scope };
  const cancelling = h.supervisor.requestMobileContentMain(cancel, signal());
  await flush(); t.mock.timers.tick(21); await flush(); unknown(await cancelling);
  h.physical.resolve(); await h.returned.promise; await flush();
  assert.equal(h.fdQuiet(), false, '取消read handler不是关闭FD');
  const recheck = { ...cancel, id: randomUUID() };
  const ack = await h.supervisor.requestMobileContentMain(recheck, signal(), { previousCancelId: cancel.id });
  assert.ok(ack.action === 'cancel' && 'kind' in ack && ack.kind === 'cancelled' && ack.quiet);
  assert.equal(h.fdQuiet(), false);
  assert.equal(await h.admissions(), 15, '同代同scope同目标真quiet复核后，旧cancel nonce也应结算');
});

test('仍未结算的来源读取：保持UNKNOWN及原占位，不能把timer触发当settled', async t => {
  const h = await harness(t), call = h.read(), waiting = h.supervisor.requestMobileContentMain(call, signal());
  await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await waiting);
  assert.equal(h.fdQuiet(), false); assert.equal(h.known(call.id).length, 0);
  assert.equal(await h.admissions(), 14, '原物理handler未结束时确实保留一格，不扩大16内容总界');
});

test('错scope关闭复核不post，重复原nonce不能重绑在途Actor', async t => {
  const h = await harness(t), call = h.read(), waiting = h.supervisor.requestMobileContentMain(call, signal());
  await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await waiting);
  const cancel: Extract<MobileContentCoreRequest, { action: 'cancel' }> = { ...base(), action: 'cancel', requestId: call.id, snapshotId: null, scope };
  const cancelling = h.supervisor.requestMobileContentMain(cancel, signal());
  await flush(); t.mock.timers.tick(21); await flush(); unknown(await cancelling);
  const before = h.main.sent.length;
  await assert.rejects(h.supervisor.requestMobileContentMain({ ...cancel, id: randomUUID(), scope: { ...scope, accountDomain: 'account.other.fixture' } },
    signal(), { previousCancelId: cancel.id }), MobileAuthPersistenceError);
  await assert.rejects(h.supervisor.requestMobileContentMain(call, signal()), MobileAuthPersistenceError);
  assert.equal(h.main.sent.length, before); assert.equal(h.fdQuiet(), false);
});

test('真实撤销后迟到read不得发布bytes或重新进入同源读取', async t => {
  const h = await harness(t), call = h.read(), waiting = h.supervisor.requestMobileContentMain(call, signal());
  await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await waiting);
  h.revoke(); h.physical.resolve(); await h.returned.promise; await flush();
  assert.equal(h.known(call.id).some(x => 'kind' in x && x.kind === 'source'), false);
  const next = await h.supervisor.requestMobileContentMain({ ...h.read(), request: { operation: 'read', handle: h.sourceHandle,
    readId: randomUUID(), start: 8, maxBytes: 8 } }, signal());
  assert.ok('kind' in next && next.kind === 'error'); assert.equal(next.status, 403); assert.equal(next.code, 'DEVICE_REVOKED');
  assert.equal(h.readCalls(), 1); assert.equal(h.fdQuiet(), false);
});

test('可信旁注早于首UNKNOWN且重复通知：仍先发送首结果、晚终态最多一次且原caller不复活', async t => {
  const h = await harness(t), call = h.read();
  h.runtime.mobileContentRpc = async (raw, parent, onSettled) => {
    const request = captureMobileContentCoreRequest(raw);
    if (request.id !== call.id) return h.rpc.request(request, parent, onSettled);
    const known = mobileContentRpcFailure(request, new MobileServiceError(409, 'SOURCE_CHANGED'));
    // 可信Runtime的交错夹具：不伪造wire，由真实utility完成闭集校验及首/晚post。
    onSettled?.(known); onSettled?.(known); onSettled?.(known);
    return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
  };
  let delivered = 0;
  const first = await h.supervisor.requestMobileContentMain(call, signal()).then(result => { delivered++; return result; });
  unknown(first); await flush();
  const frames = h.core.sent.filter((raw): raw is MobileContentCoreResponse => {
    const row = raw as Partial<MobileContentCoreResponse>;
    return row.type === 'mobile-content-core-response' && row.id === call.id;
  });
  assert.equal(frames.length, 2); unknown(frames[0]!);
  const later = frames[1]; assert.ok(later && 'kind' in later && later.kind === 'error');
  assert.equal(later.code, 'SOURCE_CHANGED'); assert.equal(later.outcome, null);
  assert.equal(delivered, 1); assert.equal(h.readCalls(), 0); assert.equal(h.fdQuiet(), false);
  assert.equal(await h.admissions(), 15);
});

test('结算旁注抛错不改变原read终态：真实handler单次结束且原caller仍UNKNOWN', async t => {
  const h = await harness(t, 'known-failure'), call = h.read();
  const runtimeRequest = h.runtime.mobileContentRpc!;
  h.runtime.mobileContentRpc = (request, parent, onSettled) => runtimeRequest(request, parent, response => {
    onSettled?.(response); throw new Error('合成旁注故障不得改变业务结算');
  });
  const reading = h.supervisor.requestMobileContentMain(call, signal());
  await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await reading);
  h.physical.resolve(); await h.returned.promise; await flush();
  assert.equal(h.readCalls(), 1); assert.equal(h.known(call.id).length, 1); assert.equal(h.fdQuiet(), false);
  assert.equal(await h.admissions(), 15);
});

test('未知内容写入不进入媒体late白名单：handler晚拒绝仍保原UNKNOWN槽且不重投写入', async t => {
  const entered = deferred(), finish = deferred(), returned = deferred(); let writes = 0;
  t.after(() => finish.resolve());
  const h = await harness(t, 'success', async () => {
    writes++; entered.resolve(); await finish.promise; returned.resolve(); throw new MobileServiceError(503, 'BUSY');
  });
  const directory = new URL('../../../../packages/contracts/mobile/fixtures/', import.meta.url);
  type Body = { fileName: string; bytes: number; sha256: string };
  type Row = { operationId: string; role: string; context: string; method: string; path: string;
    request: { headers: MobileHeaderPairs; query: MobileHeaderPairs; body: Body | null } };
  const fixture = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as {
    cases: Row[]; contexts: Record<string, MobileWireCodecContext> };
  const row = fixture.cases.find(value => value.operationId === 'setAlbumFavorite' && value.role === 'DECLARED_SUCCESS'); assert.ok(row);
  const body = row.request.body; assert.ok(body); assert.match(body.fileName, /^bodies\/[A-Za-z0-9_.-]+$/u);
  const bytes = new Uint8Array(readFileSync(new URL(body.fileName, directory)));
  assert.equal(bytes.byteLength, body.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), body.sha256);
  const context = fixture.contexts[row.context]; assert.ok(context);
  // 只把合成fixture的账号域对齐本harness；仍走原公开解码与私有scope守门。
  const requestBody = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), accountDomain: scope.accountDomain }));
  const decoded = decodeMobileRequest('setAlbumFavorite', { method: row.method, path: row.path,
    headers: row.request.headers, query: row.request.query, body: requestBody }, context); assert.ok(decoded.ok);
  const call: MobileContentCoreRequest = { ...base(), action: 'dispatch', operation: 'setAlbumFavorite', scope, request: decoded.value };
  const writing = h.supervisor.requestMobileContentMain(call, signal());
  assert.equal(await Promise.race([entered.promise.then(() => true), writing.then(() => false)]), true,
    '写入fixture必须确已到达真实dispatcher，不能把scope早拒绝误当UNKNOWN验证');
  await flush(); t.mock.timers.tick(21); await flush(); unknown(await writing);
  finish.resolve(); await returned.promise; await flush();
  assert.equal(writes, 1); assert.equal(h.known(call.id).length, 0);
  await assert.rejects(h.supervisor.requestMobileContentMain(call, signal()), MobileAuthPersistenceError);
  assert.equal(writes, 1); assert.equal(await h.admissions(), 14);
});

test('release晚到原quiet ACK：资源释放必须真静止才补终态且不复活原UNKNOWN调用', async t => {
  const h = await harness(t), call = h.release(), releasing = h.supervisor.requestMobileContentMain(call, signal());
  await h.entered.promise; await flush(); t.mock.timers.tick(21); await flush(); unknown(await releasing);
  assert.equal(h.fdQuiet(), false); h.fdClose.resolve(); await h.returned.promise; await flush();
  assert.equal(h.fdQuiet(), true); assert.equal(h.closeCalls(), 1);
  const settled = h.known(call.id); assert.equal(settled.length, 1);
  const ack = settled[0]; assert.ok(ack?.action === 'source' && 'kind' in ack && ack.kind === 'source');
  assert.ok(ack.result.kind === 'mobile-source-ack'); assert.equal(ack.result.operation, 'release'); assert.equal(ack.result.quiet, true);
  assert.equal(await h.admissions(), 15);
});

test('仅Main调用者取消后Core首次正常bytes：丢弃晚数据但收已确定RPC槽，不能冒FDquiet', async t => {
  const h = await harness(t), call = h.read(), controller = new AbortController();
  let delivered = 0, rejected = 0;
  const reading = h.supervisor.requestMobileContentMain(call, controller.signal).then(value => {
    delivered++; return value;
  }, error => { rejected++; throw error; });
  const failed = assert.rejects(reading, MobileAuthPersistenceError);
  await h.entered.promise; await flush(); controller.abort(); await failed;
  assert.equal(delivered, 0); assert.equal(rejected, 1); assert.equal(h.fdQuiet(), false);
  // 不tick Core/utility期限，不另发cancel；原物理read仍可正常完成第一次wire回应。
  h.physical.resolve(); await h.returned.promise; await flush();
  const frames = h.known(call.id); assert.equal(frames.length, 1);
  const first = frames[0]; assert.ok(first?.action === 'source' && 'kind' in first && first.kind === 'source');
  assert.ok(first.result.kind === 'mobile-source-read'); assert.equal(first.result.bytes.byteLength, 8);
  assert.equal(h.main.sent.some(raw => (raw as { action?: unknown }).action === 'cancel'), false);
  assert.equal(h.readCalls(), 1); assert.equal(delivered, 0); assert.equal(rejected, 1); assert.equal(h.fdQuiet(), false);
  assert.equal(await h.admissions(), 15, '原read已known结束且caller已取消时，仅丢字节不能继续占RPC槽');
});
