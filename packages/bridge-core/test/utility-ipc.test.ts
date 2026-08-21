import assert from 'node:assert/strict';
import test from 'node:test';
import { IPC_VERSION, type IpcEventMessage } from '@music-bridge/contracts';
import {
  attachCoreRuntimePort,
  type CoreRuntimeForIpc,
  type UtilityPort,
} from '../src/utility-main.js';

class FakePort implements UtilityPort {
  readonly messages: unknown[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;

  on(event: 'message', listener: (event: { data: unknown }) => void): void {
    assert.equal(event, 'message');
    this.listener = listener;
  }

  start(): void {}

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  send(message: unknown): void {
    this.listener?.({ data: message });
  }
}

function makeRuntime(): CoreRuntimeForIpc & { shutdownCalls: number } {
  const state = {
    runtime: 'ready' as const,
    roon: 'disconnected' as const,
    provider: 'missing' as const,
    activeStreamCount: 0,
    activePlaybackPresent: false,
  };
  return {
    shutdownCalls: 0,
    async start() {},
    async shutdown() {
      this.shutdownCalls += 1;
    },
    ping: () => ({ pong: true as const }),
    getHealth: () => state,
    getState: () => state,
    listZones: () => [],
    selectZone: async () => state,
  };
}

test('utility IPC returns ready, typed responses and bounded events', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  assert.deepEqual(port.messages[0], {
    version: IPC_VERSION,
    event: 'core.ready',
    payload: { state: runtime.getState() },
  } satisfies IpcEventMessage);

  port.send({
    version: IPC_VERSION,
    id: 'ping-1',
    command: 'core.ping',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'ping-1',
    ok: true,
    result: { pong: true },
  });
});

test('utility IPC rejects invalid payloads without throwing internal details', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'bad-1',
    command: 'roon.selectZone',
    payload: { zoneId: 7 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'bad-1',
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  });
});

test('utility shutdown is bounded behind the typed command', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'shutdown-1',
    command: 'core.shutdown',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.shutdownCalls, 1);
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'shutdown-1',
    ok: true,
    result: { stopped: true },
  });
});
