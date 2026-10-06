import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  IPC_VERSION, validateIpcResponseForCommand,
  type LocalScanTransitionRequest, type PublicErrorCode,
} from '@music-bridge/contracts';
import { installLocalLibraryHandlers } from '../../src/main/local-library-ipc.js';
import { createLocalLibraryClient } from '../../src/preload/local-library-client.js';
import {
  CoreIpcError, CoreSupervisor, type CoreMessagePort, type CoreChildProcess,
} from '../../src/main/core-supervisor.js';

const unavailable = '[INVENTORY_UNAVAILABLE] 操作未获确认；现有音乐库保留，请查看任务与未确认操作。';
const conflict = '[INVENTORY_CONFLICT] 当前任务或音乐库状态已改变，请刷新后重新核对。';
const privateDiagnostic = '合成对端不可公开的诊断细节';
type Sent = { version: number; id: string; command: string; payload: unknown; expectedDatasetId?: string };

/** 只替代Electron child/port；Supervisor的解析、pending处理和CoreIpcError构造用生产实现。 */
class ControlledPort implements CoreMessagePort {
  sent: unknown[] = [];
  onPost: ((value: unknown) => void) | undefined;
  private listener: ((event: { data: unknown }) => void) | undefined;
  on(event: 'message', listener: (event: { data: unknown }) => void): void {
    assert.equal(event, 'message'); this.listener = listener;
  }
  start(): void {}
  close(): void { this.listener = undefined; }
  postMessage(value: unknown): void { this.sent.push(value); this.onPost?.(value); }
  receive(value: unknown): void { this.listener?.({ data: value }); }
}
class ControlledChild implements CoreChildProcess {
  private listeners: Array<(code: number) => void> = [];
  postMessage(_value: unknown): void {}
  once(event: 'exit', listener: (code: number) => void): void {
    assert.equal(event, 'exit'); this.listeners.push(listener);
  }
  kill(): boolean { this.exit(); return true; }
  exit(): void { for (const listener of this.listeners.splice(0)) listener(0); }
}
async function actualSupervisor(t: test.TestContext) {
  const child = new ControlledChild();
  const channels: Array<{ port1: ControlledPort; port2: ControlledPort }> = [];
  let responseCode: PublicErrorCode = 'INVENTORY_CONFLICT';
  let lastResponse: unknown;
  const supervisor = new CoreSupervisor({
    entryPath: '/synthetic/not-started-core.js', cwd: '/synthetic/not-started',
    requestTimeoutMs: 1000, startupTimeoutMs: 1000,
    dependencies: {
      createChannel: () => {
        const value = { port1: new ControlledPort(), port2: new ControlledPort() };
        channels.push(value); return value;
      },
      fork: () => child,
    },
  });
  t.after(async () => { child.exit(); await supervisor.shutdown(); });
  const starting = supervisor.start(), port = channels[0]!.port2;
  port.onPost = value => {
    const request = value as Sent;
    queueMicrotask(() => {
      lastResponse = { version: IPC_VERSION, id: request.id, ok: false,
        error: { code: responseCode, message: privateDiagnostic } };
      port.receive(lastResponse);
    });
  };
  port.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
    runtime: 'ready', roon: 'disconnected', provider: 'missing',
    activeStreamCount: 0, activePlaybackPresent: false,
  } } });
  await starting;
  return { supervisor, port, setCode: (code: PublicErrorCode) => { responseCode = code; },
    response: () => lastResponse };
}
function bridge(supervisor: Pick<CoreSupervisor, 'request' | 'requestInternal'>) {
  const datasetId = randomUUID();
  const payload: LocalScanTransitionRequest = {
    commandId: randomUUID(), jobId: randomUUID(), expectedRevision: '1',
  };
  const handlers = new Map<string, (event: { trusted: boolean }, value?: unknown) => unknown>();
  const invokes: Array<{ channel: string; value: unknown }> = [];
  let trustedCalls = 0, picks = 0, writes = 0;
  installLocalLibraryHandlers<{ trusted: boolean }>({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: event => { trustedCalls++; assert.equal(event.trusted, true); }, supervisor,
    pick: async () => { picks++; assert.fail('错误投影测试不能打开原生选择器'); },
  });
  // 此invoke是受控跨层接线，没有真实Electron序列化；Main handler及preload client均为生产实现。
  const client = createLocalLibraryClient(async (channel, value) => {
    invokes.push({ channel, value: structuredClone(value) });
    const handler = handlers.get(channel); assert.ok(handler);
    return handler({ trusted: true }, value);
  }, async () => datasetId, {
    chooseRoot: async () => { writes++; assert.fail('不能另发目录写命令'); },
    confirm: async () => { writes++; assert.fail('不能另发重定位确认'); },
    relink: async () => { writes++; assert.fail('不能另发目录关联'); },
  });
  return { client, datasetId, payload, invokes, counters: () => ({ trustedCalls, picks, writes }) };
}
function once(f: ReturnType<typeof bridge>): void {
  assert.deepEqual(f.invokes, [{ channel: 'localLibrary:request', value: {
    datasetId: f.datasetId, command: 'localScan.cancel', payload: f.payload,
  } }]);
  assert.deepEqual(f.counters(), { trustedCalls: 1, picks: 0, writes: 0 });
}
async function rejectsWith(f: ReturnType<typeof bridge>, message: string): Promise<void> {
  await assert.rejects(f.client.localLibraryScan('localScan.cancel', f.payload), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    assert.equal(error.message.includes(privateDiagnostic), false);
    return true;
  });
  // 经过一次额外事件轮次后仍无第二次业务发送；不将受控接线冒作真实Native/CUA取消结果。
  await new Promise<void>(resolve => setImmediate(resolve));
  once(f);
}

test('MBRS003 Main确认错误：实际Supervisor合法INVENTORY_CONFLICT经handler与preload保留且原请求只发送一次', { timeout: 10_000 }, async t => {
  const core = await actualSupervisor(t), f = bridge(core.supervisor);
  await rejectsWith(f, conflict);
  const checked = validateIpcResponseForCommand(core.response(), 'localScan.cancel');
  assert.equal(checked.ok, true);
  assert.ok(checked.ok && !checked.value.ok && checked.value.error.code === 'INVENTORY_CONFLICT');
  assert.equal(core.port.sent.length, 1);
  const sent = core.port.sent[0] as Sent;
  assert.equal(sent.command, 'localScan.cancel'); assert.equal(sent.expectedDatasetId, f.datasetId);
  assert.deepEqual(sent.payload, f.payload);
});

test('MBRS003 Main未知错误：其它实际确认码与伪造CONFLICT字串仍Unavailable且没有业务自动重发', { timeout: 10_000 }, async t => {
  const core = await actualSupervisor(t);
  for (const code of ['TIMEOUT', 'INTERNAL_ERROR', 'INVENTORY_UNAVAILABLE'] as const) {
    core.setCode(code); const before = core.port.sent.length, f = bridge(core.supervisor);
    await rejectsWith(f, unavailable);
    assert.equal(core.port.sent.length, before + 1);
    assert.deepEqual((core.port.sent[before] as Sent).payload, f.payload);
  }
  const forged: unknown[] = [
    new Error('[INVENTORY_CONFLICT] ' + privateDiagnostic),
    Object.assign(new Error(privateDiagnostic), { name: 'CoreIpcError', code: 'INVENTORY_CONFLICT' }),
    { name: 'CoreIpcError', code: 'INVENTORY_CONFLICT', message: privateDiagnostic },
    '[INVENTORY_CONFLICT] ' + privateDiagnostic,
    new Error(privateDiagnostic, { cause: new CoreIpcError('INVENTORY_CONFLICT', privateDiagnostic) }),
  ];
  for (const cause of forged) {
    const calls: Array<{ command: unknown; payload: unknown; datasetId: unknown }> = [];
    // 这些故障显式注入Main依赖，不冒实际Core返回；用于证明不可凭message/name/code猜测确认结果。
    const dependency: Pick<CoreSupervisor, 'request' | 'requestInternal'> = {
      request: (async (command: unknown, payload: unknown, datasetId?: string) => {
        calls.push({ command, payload: structuredClone(payload), datasetId }); throw cause;
      }) as CoreSupervisor['request'],
      requestInternal: (async () => { assert.fail('未知错误不能自动改走可信入口'); }) as CoreSupervisor['requestInternal'],
    };
    const f = bridge(dependency), before = core.port.sent.length;
    await rejectsWith(f, unavailable);
    assert.deepEqual(calls, [{ command: 'localScan.cancel', payload: f.payload, datasetId: f.datasetId }]);
    assert.equal(core.port.sent.length, before);
  }
});
