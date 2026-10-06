import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  IPC_VERSION, validateIpcInternalRequest,
  type IpcCommandPayloads, type LocalScanInternalCommand, type LocalRelocationInternalCommand,
} from '@music-bridge/contracts';
import { installLocalLibraryHandlers } from '../../src/main/local-library-ipc.js';
import { CoreSupervisor, type CoreMessagePort, type CoreChildProcess } from '../../src/main/core-supervisor.js';

/** 只替代Electron child/port和窗口身份端口；Main handler及CoreSupervisor前置校验均用生产实现。 */
class SyntheticPort implements CoreMessagePort {
  sent: unknown[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;
  on(event: 'message', listener: (event: { data: unknown }) => void): void { assert.equal(event, 'message'); this.listener = listener; }
  start(): void {} close(): void { this.listener = undefined; }
  postMessage(value: unknown): void { this.sent.push(value); this.onPost?.(value); }
  onPost: ((value: unknown) => void) | undefined;
  receive(value: unknown): void { this.listener?.({ data: value }); }
}
class SyntheticChild implements CoreChildProcess {
  private listeners: Array<(code: number) => void> = [];
  postMessage(_value: unknown): void {}
  once(event: 'exit', listener: (code: number) => void): void { assert.equal(event, 'exit'); this.listeners.push(listener); }
  kill(): boolean { this.exit(); return true; }
  exit(): void { for (const listener of this.listeners.splice(0)) listener(0); }
}
type Sent = { version: number; id: string; command: string; payload: unknown; expectedDatasetId?: string };
async function unit(t: test.TestContext) {
  const datasetId = randomUUID(), child = new SyntheticChild(), channels: Array<{ port1: SyntheticPort; port2: SyntheticPort }> = [];
  let currentDataset = datasetId, pickCount = 0;
  const handlers = new Map<string, (event: { trusted: boolean }, value?: unknown) => unknown>();
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/not-started-core.js', cwd: '/synthetic/not-started',
    requestTimeoutMs: 1000, startupTimeoutMs: 1000,
    dependencies: { createChannel: () => { const channel = { port1: new SyntheticPort(), port2: new SyntheticPort() }; channels.push(channel); return channel; }, fork: () => child },
  });
  t.after(async () => { child.exit(); await supervisor.shutdown(); });
  const starting = supervisor.start(), port = channels[0]!.port2;
  port.onPost = value => {
    const request = value as Sent;
    queueMicrotask(() => {
      if (request.command === 'commandOutbox.context') port.receive({ version: IPC_VERSION, id: request.id, ok: true, result: { datasetId: currentDataset } });
      else if (request.command === 'localScan.page') port.receive({ version: IPC_VERSION, id: request.id, ok: true, result: { offset: 0, limit: 200, total: 0, hasMore: false, items: [] } });
      else port.receive({ version: IPC_VERSION, id: request.id, ok: false, error: { code: 'INTERNAL_ERROR', message: '合成child不执行可信命令或产品业务。' } });
    });
  };
  port.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } });
  await starting;
  installLocalLibraryHandlers<{ trusted: boolean }>({ handle: (channel, handler) => handlers.set(channel, handler), requireTrusted: event => { if (!event.trusted) throw new Error('合成窗口身份拒绝'); }, supervisor,
    pick: async () => { pickCount++; assert.fail('本新增候选只覆盖Native picker之前的边界，不能打开picker'); },
  });
  return { datasetId, supervisor, port, handlers, pickCount: () => pickCount, changeDataset: () => { currentDataset = randomUUID(); } };
}

test('MBRS003 Main前置：四个完整合法trusted body在普通channel及实际Supervisor零转发，缺scope也不进私有port', { timeout: 10_000 }, async t => {
  const f = await unit(t), handler = f.handlers.get('localLibrary:request')!, id = randomUUID(), batchId = randomUUID();
  type Trusted = LocalScanInternalCommand | LocalRelocationInternalCommand;
  const trusted: Pick<IpcCommandPayloads, Trusted> = {
    'localScan.prepareBatch': { commandId: randomUUID(), jobId: id, batch: { batchId, jobId: id, expectedJobRevision: '1', checkpointBefore: null, items: [], frontier: [], completed: true } },
    'localScan.commitBatch': { commandId: randomUUID(), jobId: id, batchId, expectedRevision: '1' },
    'localRelocation.capture': { assetId: id, expectedFileRevision: '1', expectedLocationRevision: '1', expectedRootRevision: '1', absolutePaths: ['/synthetic/native-only.wav'] },
    'localRelocation.registerRoot': { commandId: randomUUID(), sourceRootId: id },
  };
  for (const command of Object.keys(trusted) as Trusted[]) {
    // 先证实完整内部schema有效；不把该控制冒充真实origin/文件/Owner事实。
    assert.equal(validateIpcInternalRequest({ version: 1, id: randomUUID(), command, payload: trusted[command], expectedDatasetId: f.datasetId }).ok, true, command);
    const before: number = f.port.sent.length;
    await assert.rejects(async () => handler({ trusted: true }, { datasetId: f.datasetId, command, payload: trusted[command] }), /INVALID_IPC_REQUEST/u);
    await assert.rejects(f.supervisor.request(command, trusted[command], f.datasetId), { code: 'INVALID_IPC_REQUEST' });
    await assert.rejects(f.supervisor.requestInternal(command, trusted[command]), { code: 'INVALID_IPC_REQUEST' });
    assert.equal(f.port.sent.length, before, command); assert.equal(f.pickCount(), 0);
  }
  await assert.rejects(async () => handler({ trusted: true }, { command: 'localScan.page', payload: { offset: 0, limit: 200 } }), /INVALID_IPC_REQUEST/u);
  const hiddenPayload = Object.defineProperty({ offset: 0, limit: 200 }, 'absolutePaths', { value: ['/synthetic/forbidden.wav'] });
  await assert.rejects(async () => handler({ trusted: true }, { datasetId: f.datasetId, command: 'localScan.page', payload: hiddenPayload }), /INVALID_IPC_REQUEST/u);
  assert.equal(f.port.sent.length, 0);
  // 同一实际handler→实际Supervisor正控制，证明启动和观察端口没有失接造成假零发送。
  assert.deepEqual(await handler({ trusted: true }, { datasetId: f.datasetId, command: 'localScan.page', payload: { offset: 0, limit: 200 } }), { offset: 0, limit: 200, total: 0, hasMore: false, items: [] });
  assert.equal(f.port.sent.length, 1);
  const sent = f.port.sent[0] as Sent;
  assert.equal(sent.command, 'localScan.page'); assert.equal(sent.expectedDatasetId, f.datasetId);
});

test('MBRS003 Main候选选择前置：missing/hidden/symbol scope与壳注入零Core发送，旧dataset仅context查询且零Native/capture', { timeout: 10_000 }, async t => {
  const f = await unit(t), handler = f.handlers.get('localLibrary:chooseCandidates')!;
  const selection = { assetId: randomUUID(), expectedFileRevision: '1', expectedLocationRevision: '1', expectedRootRevision: '1' };
  const hiddenSelection = Object.defineProperty({ ...selection }, 'absolutePaths', { value: ['/synthetic/forbidden.wav'] });
  const publicBodies: unknown[] = [
    { selection },
    Object.defineProperty({ datasetId: f.datasetId, selection }, 'absolutePaths', { value: ['/synthetic/forbidden.wav'] }),
    { datasetId: f.datasetId, selection, [Symbol('trusted-capture')]: true },
    { datasetId: f.datasetId, selection: hiddenSelection },
  ];
  for (const value of publicBodies) {
    await assert.rejects(async () => handler({ trusted: true }, value), /INVALID_IPC_REQUEST/u);
    assert.equal(f.port.sent.length, 0); assert.equal(f.pickCount(), 0);
  }
  f.changeDataset();
  // 此context返回是外部Core对端的合成响应；Main mismatch及拒绝后续步骤是实际实现。
  await assert.rejects(async () => handler({ trusted: true }, { datasetId: f.datasetId, selection }), /INVENTORY_UNAVAILABLE/u);
  assert.equal(f.port.sent.length, 1); assert.equal(f.pickCount(), 0);
  const sent = f.port.sent[0] as Sent;
  assert.equal(sent.command, 'commandOutbox.context'); assert.deepEqual(sent.payload, {});
  assert.equal(f.port.sent.some(value => (value as Sent).command === 'localRelocation.capture'), false);
  assert.equal(f.port.sent.some(value => (value as Sent).command === 'recordingSources.context'), false);
  // 普通scan跨dataset不在本Main handler查context；真正Owner fence由既有真实Worker用例覆盖，不能宣称这里零发送。
});
