import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import { MessagePort } from 'node:worker_threads';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { runCoreUtilityProcess, type DatasetOwnerFactory, type UtilityPort } from '../../src/utility-main.js';
import { LOCAL_RELOCATION_MAIN_PORT_BOOTSTRAP } from '../../src/shared/source-relocation-utility-port.js';

// 控制Electron封套与Owner端点；真实Utility、Node桥端及运行关闭路径保持原实现。
// 本文件不声称真实Owner数据库、生产Electron或实际文件搬迁证据。
class ParentPort extends EventEmitter implements UtilityPort {
  readonly messages: unknown[] = [];
  closed = false;
  start(): void {}
  postMessage(value: unknown): void {
    if (this.closed) throw new Error('受控父端已关闭。');
    this.messages.push(structuredClone(value));
  }
  close(): void { if (!this.closed) { this.closed = true; this.emit('close'); } }
  get ready(): boolean { return this.messages.some(value => Object.getOwnPropertyDescriptor(value, 'event')?.value === 'core.ready'); }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, '实际Utility启动或关闭未在受控时限内收口');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
async function harness(t: TestContext, ports: ParentPort[], message: unknown, withFactory = true) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort'), previousExitCode = process.exitCode;
  let receive!: (event: { data: unknown; ports: UtilityPort[] }) => void;
  let factoryCalls = 0, ownerCloses = 0, captured: Parameters<DatasetOwnerFactory>[0] | undefined;
  const exits: (number | string | null | undefined)[] = [], identity = { epoch: randomUUID(), datasetId: randomUUID() };
  const owner: DatasetOwnerEndpoint = {
    async prepare() { return identity; }, async commitBoot() {},
    async dispatch() { throw new Error('受控启动用例不派发领域命令。'); },
    async close() { ++ownerCloses; captured?.privateSourceWritesPort?.close(); captured?.privateRelocationMainPort?.close(); },
  };
  t.mock.method(process, 'exit', ((code?: number | string | null) => { exits.push(code); }) as typeof process.exit);
  t.after(() => {
    captured?.privateSourceWritesPort?.close(); captured?.privateRelocationMainPort?.close();
    ports.forEach(port => port.close());
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor); else Reflect.deleteProperty(process, 'parentPort');
    process.exitCode = previousExitCode;
  });
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { once(_event: 'message', listener: typeof receive) { receive = listener; } } });
  const factory: DatasetOwnerFactory = options => { ++factoryCalls; captured = options; return owner; };
  await runCoreUtilityProcess({ NODE_ENV: 'test', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: '/合成/013端口回归' },
    undefined, undefined, undefined, undefined, withFactory ? factory : undefined);
  receive({ data: message, ports });
  await until(() => ports[0]?.ready === true || exits.length !== 0);
  return { owner, exits, get factoryCalls() { return factoryCalls; }, get ownerCloses() { return ownerCloses; }, get captured() { return captured; } };
}
const bootstrap = { type: 'musicbridge.core.port', playbackEventProtocol: 'compact-v1', relocationMainPort: LOCAL_RELOCATION_MAIN_PORT_BOOTSTRAP };

test('013实际Utility允许独立新域两端及原012+013三端，真正Node端分开交给受控Owner并自然关闭', async t => {
  for (const count of [2, 3]) {
    await t.test(`${count}个父端`, async child => {
      const ports = Array.from({ length: count }, () => new ParentPort()), f = await harness(child, ports, bootstrap);
      assert.equal(f.factoryCalls, 1); assert.equal(ports[0]!.ready, true); assert.deepEqual(f.exits, []);
      assert.ok(f.captured?.privateRelocationMainPort instanceof MessagePort);
      assert.notEqual(f.captured.privateRelocationMainPort, ports[count - 1]);
      if (count === 3) {
        assert.ok(f.captured.privateSourceWritesPort instanceof MessagePort);
        assert.notEqual(f.captured.privateSourceWritesPort, f.captured.privateRelocationMainPort);
      } else assert.equal(f.captured.privateSourceWritesPort, undefined);
      ports[0]!.emit('message', { data: { version: 1, id: randomUUID(), command: 'core.shutdown', payload: {} } });
      await until(() => f.exits.length !== 0);
      assert.deepEqual(f.exits, [0]); assert.equal(f.ownerCloses, 1);
      for (const port of ports.slice(1)) {
        assert.equal(port.closed, true);
        for (const event of ['message', 'close', 'messageerror']) assert.equal(port.listenerCount(event), 0);
      }
    });
  }
});

test('013错误marker、缺Owner工厂、错端口数量与跨域父端别名均在创建Owner前拒绝并关闭全部父端', async t => {
  for (const kind of ['marker', 'factory', 'one', 'four', 'alias'] as const) {
    await t.test(kind, async child => {
      const ports = Array.from({ length: kind === 'one' ? 1 : kind === 'four' ? 4 : 3 }, () => new ParentPort());
      if (kind === 'alias') ports[2] = ports[1]!;
      const f = await harness(child, ports, kind === 'marker' ? { ...bootstrap, relocationMainPort: 'other-domain' } : bootstrap, kind !== 'factory');
      assert.equal(f.factoryCalls, 0); assert.equal(f.ownerCloses, 0); assert.deepEqual(f.exits, [1]);
      for (const port of ports) { assert.equal(port.closed, true); assert.equal(port.ready, false); }
    });
  }
});
