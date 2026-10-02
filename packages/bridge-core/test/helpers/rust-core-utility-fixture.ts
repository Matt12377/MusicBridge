import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parentPort, workerData, Worker, type MessagePort } from 'node:worker_threads';
import type { IpcRequest } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { runCoreUtilityProcess, type UtilityPort } from '../../src/utility-main.js';
import type { RustReadonlyCoreController } from '../../src/rust-core/host-controller.js';
import { seedRustCollection } from './rust-core-collection-fixture.js';

export interface RustUtilityFixtureConfig {
  directory: string;
  models: number;
  binary: { path: string; sha256: string };
  rust: boolean;
  large?: boolean;
  holdBoot?: boolean;
  missingCapabilities?: boolean;
  hostControl?: boolean;
  seedReference?: boolean;
  holdRefreshBoot?: boolean;
  throwHostCallback?: boolean;
  spoofEnv?: boolean;
  startupData?: Record<string, unknown>;
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
let controller: RustReadonlyCoreController | undefined;
let shutdownId: string | undefined;
let spawned = 0;
let releaseRefreshBoot: (() => void) | undefined;
let releaseBoot!: () => void;
const bootRelease = new Promise<void>(resolve => { releaseBoot = resolve; });
if (!config.holdBoot) releaseBoot();
const children = new Map<number, ReturnType<typeof childProcess.spawn>>();
const spawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
  if (args[0] !== config.binary.path) throw new Error('实际集成只准许固定 Rust 二进制。');
  const child = spawn(...args);
  spawned++;
  // 第二个真实候选暂挂 commitBoot 写入，主机关闭已开始后由测试释放；不伪造任何原生 ACK。
  if (config.holdRefreshBoot && spawned === 2 && child.stdin) {
    const input = child.stdin, write = input.write.bind(input); let held: Parameters<typeof input.write> | undefined;
    input.write = ((...values: Parameters<typeof input.write>) => {
      const text = String(values[0]);
      if (text.includes('"operation":"commitBoot"') && !held) {
        held = values;
        releaseRefreshBoot = () => { if (held) { observe('rust.releaseHeldBoot', { pid: child.pid }); write(...held); held = undefined; } };
        observe('rust.commitBootHeld', { pid: child.pid }); return true;
      }
      return write(...values);
    }) as typeof input.write;
  }
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
  if (input.type === 'fixture.releaseRefreshBoot') releaseRefreshBoot?.();
  if (input.type === 'fixture.oracle' && raw && input.request) {
    void raw.dispatch(input.request).then(result => trusted.postMessage({ type: 'oracle', id: input.id, result }),
      (error: unknown) => trusted.postMessage({ type: 'oracle', id: input.id, failed: true,
        ...(error && typeof error === 'object' && 'failure' in error ? { failure: error.failure } : {}) }));
  }
  if (input.type === 'fixture.killRust' && typeof input.pid === 'number') {
    const child = children.get(input.pid);
    observe('fixture.killRust', { pid: input.pid, accepted: child?.kill('SIGKILL') ?? false });
  }
  if (input.type === 'fixture.hostControl') {
    const control = value as Record<string, unknown>;
    if (Object.keys(control).some(key => !['type', 'id', 'operation'].includes(key)) || typeof control.id !== 'string'
      || !['status', 'refresh', 'invalidate'].includes(String(control.operation))) {
      trusted.postMessage({ type: 'hostControl', id: control.id, ok: false, code: 'INVALID_REQUEST' }); return;
    }
    if (!controller) { trusted.postMessage({ type: 'hostControl', id: control.id, ok: false, code: 'NOT_READY' }); return; }
    const capability = controller;
    observe('host.control', { operation: control.operation, id: control.id });
    void Promise.resolve().then(async () => {
      if (control.operation === 'refresh') await capability.refresh();
      if (control.operation === 'invalidate') capability.invalidate();
      const status = capability.getStatus(); observe('host.controlComplete', { operation: control.operation, id: control.id, status });
      trusted.postMessage({ type: 'hostControl', id: control.id, ok: true, status });
    }).catch((error: unknown) => {
      const allowed = ['NOT_READY', 'CLOSING', 'STALE_SNAPSHOT', 'TIMEOUT', 'PROCESS_EXIT', 'SNAPSHOT_UNAVAILABLE'];
      const code = error && typeof error === 'object' && 'code' in error && allowed.includes(String(error.code)) ? error.code : 'SNAPSHOT_UNAVAILABLE';
      observe('host.controlRejected', { operation: control.operation, id: control.id, code });
      trusted.postMessage({ type: 'hostControl', id: control.id, ok: false, code });
    });
  }
});

Object.defineProperty(process, 'parentPort', { value: {
  once(_event: 'message', listener: (event: { data: unknown; ports: UtilityPort[] }) => void) {
    trusted.once('message', (value: { type: string; port: MessagePort }) => {
      if (value.type !== 'fixture.bind') throw new Error('测试启动消息无效。');
      const port = value.port;
      listener({ data: config.startupData ?? { type: 'musicbridge.core.port' }, ports: [{
        on(_name, callback) { return port.on('message', data => {
          if ((data as IpcRequest).command === 'core.shutdown') shutdownId = (data as IpcRequest).id;
          callback({ data });
        }); },
        start() { port.start(); },
        postMessage(message) {
          const event = message as { event?: string };
          if (event.event === 'core.ready') observe('core.ready');
          if (controller && (message as { id?: string; ok?: boolean }).id === shutdownId && (message as { ok?: boolean }).ok) {
            const capability = controller;
            observe('host.closedStatus', { status: capability.getStatus() });
            void capability.refresh().then(() => observe('host.refreshAfterCloseAccepted'),
              error => observe('host.refreshAfterCloseRejected', { code: (error as { code?: string }).code }));
          }
          port.postMessage(message);
        },
      }] });
    });
  },
} });

await runCoreUtilityProcess({ NODE_ENV: 'test', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DATA_DIRECTORY: config.directory,
  ...(config.spoofEnv ? { MUSIC_BRIDGE_RUST_READONLY: '1', MUSIC_BRIDGE_RUST_HOST_CONTROL: '1', MUSIC_BRIDGE_RUST_BINARY: config.binary.path } : {}) },
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
        if (config.seedReference) {
          const items = [{ referenceId: 'synthetic-reference', bookId: 'rust007-reference', brand: '合成品牌', series: '合成系列',
            model: '合成参考型号', edition: '1990', lengths: [90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '新建测试目录', confidence: 'high' }];
          const rawPack = JSON.stringify({ schemaVersion: 1, bookId: 'rust007-reference', title: 'RUST007 合成目录', sourceVersion: 'v1', items });
          const dispatch = (command: IpcRequest['command'], payload: unknown) => client.dispatch({ version: 1, id: randomUUID(), command, payload });
          const reference = await dispatch('referenceCatalog.registerSource', { commandId: randomUUID(), rawPack,
            packHash: createHash('sha256').update(rawPack).digest('hex'), userConfirmed: true }) as { id: string };
          const revisionInput = { sourceId: reference.id, expectedCurrentRevisionId: null, items, mappings: [] };
          const preview = await dispatch('referenceCatalog.previewRevision', revisionInput) as { baselineFingerprint: string };
          const published = await dispatch('referenceCatalog.publishRevision', { ...revisionInput, commandId: randomUUID(),
            baselineFingerprint: preview.baselineFingerprint, userConfirmed: true }) as { revision: { id: string } };
          observe('node.referenceSeeded', { sourceId: reference.id, revisionId: published.revision.id, bookId: 'rust007-reference', writer: 'Node' });
        }
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
    ...(config.large ? { snapshotProfile: 'v3-5000' as const } : {}) } : undefined,
  ...(config.hostControl ? [(value: RustReadonlyCoreController) => {
    controller = value;
    observe('host.delivered', { frozen: Object.isFrozen(value), keys: Object.keys(value), status: value.getStatus() });
    if (config.throwHostCallback) throw new Error('受控可信主机回调失败。');
  }] : []));
trusted.postMessage({ type: 'fixture.installed' });
