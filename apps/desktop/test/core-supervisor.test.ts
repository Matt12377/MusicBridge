import assert from 'node:assert/strict'
import test from 'node:test'

import { IPC_VERSION } from '@music-bridge/contracts'
import {
  CoreSupervisor,
  type CoreChildProcess,
  type CoreMessagePort,
} from '../src/main/core-supervisor.js'

class FakePort implements CoreMessagePort {
  readonly sent: unknown[] = []
  private listener: ((event: { data: unknown }) => void) | undefined
  closed = false

  on(event: 'message', listener: (event: { data: unknown }) => void): void {
    assert.equal(event, 'message')
    this.listener = listener
  }

  start(): void {}

  close(): void {
    this.closed = true
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  receive(message: unknown): void {
    this.listener?.({ data: message })
  }
}

class FakeChild implements CoreChildProcess {
  readonly posted: unknown[] = []
  private exitListener: ((code: number) => void) | undefined
  killed = false

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  once(event: 'exit', listener: (code: number) => void): void {
    assert.equal(event, 'exit')
    this.exitListener = listener
  }

  kill(): boolean {
    this.killed = true
    this.exit(0)
    return true
  }

  exit(code: number): void {
    this.exitListener?.(code)
  }
}

function makeHarness() {
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  const children: FakeChild[] = []
  const supervisor = new CoreSupervisor({
    entryPath: '/tmp/core-entry.js',
    cwd: '/tmp',
    dependencies: {
      createChannel: () => {
        const channel = { port1: new FakePort(), port2: new FakePort() }
        channels.push(channel)
        return channel
      },
      fork: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
    },
    requestTimeoutMs: 20,
  })
  return { channels, children, supervisor }
}

function ready(channel: { port2: FakePort }): void {
  channel.port2.receive({
    version: IPC_VERSION,
    event: 'core.ready',
    payload: {
      state: {
        runtime: 'ready',
        roon: 'disconnected',
        provider: 'missing',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      },
    },
  })
}

test('CoreSupervisor creates request ids and resolves typed responses', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  const request = harness.supervisor.request('core.ping', {})
  await new Promise((resolve) => setImmediate(resolve))
  const sent = harness.channels[0]!.port2.sent[0] as { id: string; command: string }
  assert.equal(sent.command, 'core.ping')
  assert.match(sent.id, /^[0-9a-f-]{36}$/)
  harness.channels[0]!.port2.receive({
    version: IPC_VERSION,
    id: sent.id,
    ok: true,
    result: { pong: true },
  })
  assert.deepEqual(await request, { pong: true })
})

test('CoreSupervisor restarts a crashed Core once and then fails closed', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  harness.children[0]!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.children.length, 2)
  ready(harness.channels[1]!)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.supervisor.status, 'ready')

  harness.children[1]!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.children.length, 2)
  assert.equal(harness.supervisor.status, 'failed')
})

test('CoreSupervisor request timeout and shutdown are bounded', async () => {
  const harness = makeHarness()
  const starting = harness.supervisor.start()
  await new Promise((resolve) => setImmediate(resolve))
  ready(harness.channels[0]!)
  await starting

  await assert.rejects(harness.supervisor.request('core.getHealth', {}), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })

  await harness.supervisor.shutdown()
  assert.equal(harness.supervisor.status, 'stopped')
  assert.equal(harness.children[0]!.killed, true)
})
