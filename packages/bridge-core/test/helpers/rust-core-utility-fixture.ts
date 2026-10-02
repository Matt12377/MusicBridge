import childProcess from 'node:child_process';
import path from 'node:path';
import { parentPort, workerData, Worker, type MessagePort } from 'node:worker_threads';
import type { IpcRequest } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { runCoreUtilityProcess, type UtilityPort } from '../../src/utility-main.js';
import { seedRustCollection } from './rust-core-collection-fixture.js';

export interface RustUtilityFixtureConfig {
  directory: string;
  models: number;
  binary: { path: string; sha256: string };
  rust: boolean;
  large?: boolean;
  holdBoot?: boolean;
  missingCapabilities?: boolean;
}
export interface RustUtilityObservation {
  type: 'observation'; sequence: number; elapsedMs: number; event: string;
  [key: string]: unknown;
}

// 只在测试线程中适配 Electron 的父端口形状；生产入口仍执行原函数。
if (!parentPort) throw new Error('实际 Core 测试入口缺少可信父端口。');
const trusted = parentPort, config = workerData as RustUtilityFixtureConfig;
const started = performance.now(); let sequence = 0;
function observe(event: string, values: Record<string, unknown> = {}) {
  trusted.postMessage({ type: 'observation', sequence: ++sequence, elapsedMs: performance.now() - started, event, ...values });
}
let raw: ReturnType<typeof createDatasetOwnerClient> | undefined;
let releaseBoot!: () => void;
const bootRelease = new Promise<void>(resolve => { releaseBoot = resolve; });
if (!config.holdBoot) releaseBoot();
const children = new Map<number, ReturnType<typeof childProcess.spawn>>();
const spawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
  if (args[0] !== config.binary.path) throw new Error('实际集成只准许固定 Rust 二进制。');
  const child = spawn(...args);
  if (child.pid !== undefined) children.set(child.pid, child);
  observe('rust.spawn', { pid: child.pid, liveChildren: children.size });
  let buffered = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    while (buffered.includes('\n')) {
      const index = buffered.indexOf('\n'), line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
      const frame = JSON.parse(line) as { operation: string; ok: boolean };
      observe('rust.frame', { operation: frame.operation, ok: frame.ok, pid: child.pid });
    }
  });
  child.once('close', (code, signal) => {
    if (child.pid !== undefined) children.delete(child.pid);
    observe('rust.exit', { pid: child.pid, code, signal, liveChildren: children.size });
  });
  return child;
}) as typeof childProcess.spawn;

trusted.on('message', (value: unknown) => {
  const input = value as { type?: string; id?: string; request?: IpcRequest; pid?: number };
  if (input.type === 'fixture.releaseBoot') releaseBoot();
  if (input.type === 'fixture.oracle' && raw && input.request) {
    void raw.dispatch(input.request).then(result => trusted.postMessage({ type: 'oracle', id: input.id, result }),
      () => trusted.postMessage({ type: 'oracle', id: input.id, failed: true }));
  }
  if (input.type === 'fixture.killRust' && typeof input.pid === 'number') {
    const child = children.get(input.pid);
    observe('fixture.killRust', { pid: input.pid, accepted: child?.kill('SIGKILL') ?? false });
  }
});

Object.defineProperty(process, 'parentPort', { value: {
  once(_event: 'message', listener: (event: { data: unknown; ports: UtilityPort[] }) => void) {
    trusted.once('message', (value: { type: string; port: MessagePort }) => {
      if (value.type !== 'fixture.bind') throw new Error('测试启动消息无效。');
      const port = value.port;
      listener({ data: { type: 'musicbridge.core.port' }, ports: [{
        on(_name, callback) { return port.on('message', data => callback({ data })); },
        start() { port.start(); },
        postMessage(message) {
          const event = message as { event?: string };
          if (event.event === 'core.ready') observe('core.ready');
          port.postMessage(message);
        },
      }] });
    });
  },
} });

await runCoreUtilityProcess({ NODE_ENV: 'test', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: config.directory },
  undefined, undefined, undefined, undefined, ({ projection, onFatal }) => {
    const worker = new Worker(new URL('./dataset-owner-version-fixture.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'], workerData: { dataDirectory: config.directory },
    });
    observe('node.spawn', { threadId: worker.threadId });
    worker.once('exit', code => observe('node.exit', { code }));
    raw = createDatasetOwnerClient({ worker, projection, onFatal: reason => { observe('node.fatal', { reason }); onFatal(reason); } });
    const client = raw;
    const source = {
      async prepare() { observe('node.prepare'); const identity = await client.prepare(); observe('node.prepared', { identity }); return identity; },
      async commitBoot() {
        observe('node.boot'); await client.commitBoot();
        if (config.models) seedRustCollection(path.join(config.directory, 'collection.v1.sqlite'), config.models);
        observe('node.bootSeeded', { models: config.models }); await bootRelease; observe('node.bootComplete');
      },
      async dispatch(request: IpcRequest) { observe('node.dispatch', { command: request.command, requestId: request.id }); return client.dispatch(request); },
      async close() { observe('node.close'); await client.close(); observe('node.closed'); },
    };
    if (config.missingCapabilities) return source;
    return { ...source,
      async getCollectionSnapshotVersion() { observe('node.version'); return client.getCollectionSnapshotVersion(); },
      async exportCollectionSnapshot() { observe('node.exportPlain'); return client.exportCollectionSnapshot(); },
      async exportVersionedCollectionSnapshot() {
        observe('node.export'); const result = await client.exportVersionedCollectionSnapshot();
        observe('node.exportComplete', { models: result.snapshot.models.length, jsonBytes: Buffer.byteLength(JSON.stringify(result.snapshot)) }); return result;
      },
      async exportLargeVersionedCollectionSnapshot() {
        observe('node.exportLarge'); const result = await client.exportLargeVersionedCollectionSnapshot();
        observe('node.exportComplete', { models: result.snapshot.models.length, jsonBytes: Buffer.byteLength(JSON.stringify(result.snapshot)) }); return result;
      },
    };
  }, config.rust ? { binary: config.binary, startupTimeoutMs: 30_000, requestTimeoutMs: 10_000,
    ...(config.large ? { snapshotProfile: 'v3-5000' as const } : {}) } : undefined);
trusted.postMessage({ type: 'fixture.installed' });
