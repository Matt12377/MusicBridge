import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { IPC_VERSION } from '@music-bridge/contracts';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../src/main/core-supervisor.js';
import { createMobileRangeWindowProbe, createMobileRangeWindowCoreReceiver, withMobileRangeWindowContext,
  mobileRangeWindowCoreObserve, mobileRangeWindowCoreFacts, copyMobileRangeWindowSnapshot } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js';
import { SOURCE_CALL, sourceResponse, sourceBytes } from '../../../../packages/bridge-core/test/mbm002/source-byte-pipeline-fixture.js';
import { captureMobileContentCoreResponse, type MobileContentCoreRequest } from '../../../../packages/bridge-core/src/mobile/content-rpc.js';

class Port implements CoreMessagePort {
  readonly sent: unknown[] = [];
  readonly listeners: ((event: { data: unknown }) => void)[] = [];
  failSeed = false;
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listeners.push(listener); }
  postMessage(raw: unknown) {
    const value = raw as { type?: string; version?: number; id?: string; command?: string };
    if (this.failSeed && value.type === 'mobile-range-window-seed') throw new Error('合成旁注post故障');
    this.sent.push(raw);
    if (value.version === IPC_VERSION && value.command === 'core.shutdown') queueMicrotask(() => this.receive({ version: IPC_VERSION,
      id: value.id, ok: true, result: { stopped: true } }));
  }
  start() {} close() {}
  receive(data: unknown) { for (const listener of this.listeners) listener({ data }); }
}
class Child implements CoreChildProcess {
  readonly exits: ((code: number) => void)[] = [];
  postMessage() {} once(_event: 'exit', listener: (code: number) => void) { this.exits.push(listener); }
  kill() { this.exit(0); return true; }
  exit(code: number) { for (const listener of this.exits.splice(0)) listener(code); }
}
async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channels: { port1: Port; port2: Port }[] = [], children: Child[] = [];
  const supervisor = new CoreSupervisor({ entryPath: '/Volumes/LifeWeave/Developer/CommandLine/tmp/mobile-range-wire-synthetic.js',
    cwd: '/Volumes/LifeWeave/Developer/CommandLine/tmp', startupTimeoutMs: 20, dependencies: {
      createChannel() { const channel = { port1: new Port(), port2: new Port() }; channels.push(channel); return channel; },
      fork() { const child = new Child(); children.push(child); return child; } } });
  t.after(async () => { t.mock.timers.reset(); await supervisor.shutdown(); });
  const ready = () => channels.at(-1)!.port2.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
    runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } });
  const starting = supervisor.start(); ready(); await starting;
  return { supervisor, channels, children, ready };
}
const http = (ordinal: number) => ({ requestId: `${ordinal.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
  method: 'GET', operation: 'getMediaAsset', range: ordinal === 1 ? 'bytes=0-65535' : 'bytes=65536-327679' });
async function coreFrame(seed: unknown) {
  let frame: unknown;
  const receiver = createMobileRangeWindowCoreReceiver({ sink: raw => { frame = raw; } });
  receiver.acceptSeed(seed);
  await receiver.run(SOURCE_CALL.id, 'read', () => mobileRangeWindowCoreObserve('core.source.execute', async () => {
    mobileRangeWindowCoreFacts(() => {});
  }));
  assert.ok(frame); return frame;
}

test('M32 Supervisor只为选中Range发seed、仍先后只调原一次RPC；坏帧不发布且不改变原reply', async t => {
  const f = await fixture(t), port = f.channels[0]!.port2;
  const ordinary = f.supervisor.requestMobileContentMain(SOURCE_CALL, new AbortController().signal);
  assert.equal(port.sent.length, 1); port.receive(sourceResponse(sourceBytes())); await ordinary;
  const probe = createMobileRangeWindowProbe({ enabled: true, windowSink() {} }), context = probe.claim(http(1)); assert.ok(context);
  const pending = withMobileRangeWindowContext(context, () => f.supervisor.requestMobileContentMain(SOURCE_CALL, new AbortController().signal));
  assert.deepEqual(port.sent.slice(1).map(raw => (raw as { type: string }).type), ['mobile-range-window-seed', 'mobile-content-core-request']);
  const frame = await coreFrame(port.sent[1]);
  port.receive({ ...frame as object, extra: '私密正文' });
  assert.equal(probe.snapshot().malformedFrames, 1);
  port.receive({ ...frame as object, requestSha256: 'f'.repeat(64) });
  assert.equal(probe.snapshot().unmatchedFrames, 1);
  port.receive(frame); port.receive(sourceResponse(sourceBytes()));
  assert.deepEqual(await pending, captureMobileContentCoreResponse(sourceResponse(sourceBytes()), SOURCE_CALL));
  const observed = probe.snapshot(); assert.ok(copyMobileRangeWindowSnapshot(observed));
  assert.equal(observed.requests[0]!.pendingSpans, 0);
  assert.equal(observed.requests[0]!.records.find(row => row.stage === 'core.source.ticket-facts.composite')!.count, 1);
  assert.equal(port.sent.filter(raw => (raw as { type: string }).type === 'mobile-content-core-request').length, 2);
});

test('M32 Supervisor旧Core不能向新代同nonce窗口补帧；seed post失败不阻断原业务', async t => {
  const f = await fixture(t), oldPort = f.channels[0]!.port2;
  const oldProbe = createMobileRangeWindowProbe({ enabled: true, windowSink() {} }), old = oldProbe.claim(http(1)); assert.ok(old);
  const pending = withMobileRangeWindowContext(old, () => f.supervisor.requestMobileContentMain(SOURCE_CALL, new AbortController().signal));
  const oldFrame = await coreFrame(oldPort.sent[0]); oldPort.receive(oldFrame); oldPort.receive(sourceResponse(sourceBytes())); await pending;
  f.children[0]!.exit(1); await new Promise<void>(resolve => setImmediate(resolve));
  f.ready(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.supervisor.status, 'ready');
  const probe = createMobileRangeWindowProbe({ enabled: true, windowSink() {} }), context = probe.claim(http(2)); assert.ok(context);
  const port = f.channels.at(-1)!.port2;
  const next = withMobileRangeWindowContext(context, () => f.supervisor.requestMobileContentMain(SOURCE_CALL, new AbortController().signal));
  oldPort.receive(oldFrame);
  assert.equal(probe.snapshot().requests[0]!.records.some(row => row.stage.startsWith('core.source.')), false);
  const fresh = await coreFrame(port.sent[0]); port.receive(fresh); port.receive(sourceResponse(sourceBytes())); await next;
  assert.equal(probe.snapshot().malformedFrames, 0); assert.equal(probe.snapshot().unmatchedFrames, 0);
  port.failSeed = true;
  const call: MobileContentCoreRequest = { ...SOURCE_CALL, id: '50000000-0000-4000-8000-000000000001' };
  const failedSeed = withMobileRangeWindowContext(context, () => f.supervisor.requestMobileContentMain(call, new AbortController().signal));
  const response = { ...sourceResponse(sourceBytes()), id: call.id }; port.receive(response);
  assert.deepEqual(await failedSeed, captureMobileContentCoreResponse(response, call)); assert.equal(probe.snapshot().malformedFrames, 1);
  assert.equal(f.supervisor.status, 'ready');
});
