import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, fstatSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import type { MetadataReaderLifecycle, MetadataReaderPort, MetadataReadResult } from '../../src/library/metadata-reader-types.js';
import type { RelocationReadAccess } from '../../src/collection/source-relocation-verify.js';
import type { PhysicalWriteClaims } from '../../src/stream/physical-resource-claims.js';
import type { SourceNamespaceWriteToken } from '../../src/stream/source-namespace-claims.js';
import { audioFixture, coreAudioIds, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

// 全部不透明品牌来自同一份真实新编译图；原Reader准备声明不可省略或替换。
async function actualGraph() {
  const reader = await loadFreshMetadataReader();
  const locks: typeof import('../../src/stream/physical-resource-locks.js') = await import(new URL('../../dist/stream/physical-resource-locks.js', import.meta.url).href);
  const claims: typeof import('../../src/stream/physical-resource-claims.js') = await import(new URL('../../dist/stream/physical-resource-claims.js', import.meta.url).href);
  const namespace: typeof import('../../src/stream/source-namespace-claims.js') = await import(new URL('../../dist/stream/source-namespace-claims.js', import.meta.url).href);
  const verify: typeof import('../../src/collection/source-relocation-verify.js') = await import(new URL('../../dist/collection/source-relocation-verify.js', import.meta.url).href);
  assert.equal(locks.physicalResourceLocks.combinedSnapshot().resources, 0);
  const shared = new SharedArrayBuffer(locks.PHYSICAL_RESOURCE_BUFFER_BYTES);
  locks.installPhysicalResourceCoordinator(shared);
  assert.equal(locks.physicalResourceLocks.buffer, shared);
  return { reader, locks, claims, namespace, verify, peer: new locks.PhysicalResourceCoordinator(shared) };
}

async function heldTargets(t: TestContext, ids: readonly string[]) {
  const graph = await actualGraph(), f = await audioFixture(t), handles: FileHandle[] = [];
  const controller = new AbortController(), deadlineAt = Date.now() + 30_000;
  let physical: PhysicalWriteClaims | undefined, named: SourceNamespaceWriteToken | undefined;
  let descriptorsRegistered = false, active = true;
  const release = async (): Promise<void> => {
    if (!active) return;
    if (physical && descriptorsRegistered) await graph.claims.closePhysicalWriteClaimDescriptors(physical);
    else await Promise.all(handles.filter(handle => handle.fd >= 0).map(handle => handle.close()));
    assert.equal(handles.every(handle => handle.fd === -1), true);
    if (physical) await physical.release();
    if (named) await graph.namespace.releaseSourceNamespaceWrite(named, named.operationIds);
    assert.equal(graph.peer.combinedSnapshot().resources, 0);
    active = false;
  };
  // 第一个FD前登记逐阶段清理；准备失败也必须核真实quiet后才释放已取得的保护。
  t.after(release);
  const targets = [];
  for (const id of ids) {
    const handle = await open(f.file(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    handles.push(handle);
    const observation = await graph.verify.observeRelocationFile(handle, { signal: controller.signal, deadlineAt });
    assert.equal(observation.sha256, f.entry(id).sha256);
    assert.equal(observation.bytes, f.entry(id).bytes);
    assert.equal(observation.links, '1');
    targets.push({ operationId: randomUUID(), resourceId: randomUUID(), handle, observation,
      path: await graph.verify.captureRelocationPath(f.root, f.entry(id).file) });
  }
  const baselines = new Map<string, Extract<MetadataReadResult, { status: 'ok' }>>();
  const originalReader = graph.reader.createMetadataReader();
  try {
    for (const target of targets) {
      const result = await originalReader.read({ root: f.root, relative: target.path.relative, expectedSignature: target.observation.signature });
      assert.ok(result.status === 'ok', '写保护前先取得原Parser的真实格式与标签事实');
      baselines.set(target.path.relative, result);
    }
  } finally { await originalReader.close(); }
  const binding = { datasetId: randomUUID(), originPlanId: randomUUID(), planHash: '1'.repeat(64),
    contextFingerprint: '2'.repeat(64), journalSequence: '1', projectionFingerprint: '3'.repeat(64) };
  const operations = targets.map(target => ({ operationId: target.operationId, name: target.path.namespace }));
  physical = await graph.claims.acquirePhysicalWriteClaims(targets.map(target => target.observation.physical));
  graph.claims.registerPhysicalWriteClaimDescriptors(physical, handles);
  descriptorsRegistered = true;
  named = await graph.namespace.acquireSourceNamespaceWrite({ ...binding, operations });
  const scope = { datasetId: binding.datasetId, planId: binding.originPlanId, originBinding: binding, operations };
  const access = await graph.verify.createRelocationReadAccess(targets, physical, named, scope, controller.signal, deadlineAt);
  return { ...graph, f, targets, baselines, controller, physical, named, scope, access, release };
}

function assertRealWorkerQuiet(events: readonly MetadataReaderLifecycle[]): void {
  const acquired = events.findIndex(event => event.type === 'lease-acquired');
  const started = events.findIndex(event => event.type === 'worker-start');
  const exited = events.findIndex(event => event.type === 'worker-exit');
  const released = events.findIndex(event => event.type === 'lease-released');
  const completed = events.findIndex(event => event.type === 'read-complete');
  assert.ok(acquired >= 0 && started > acquired && exited > started && released > exited && completed > released,
    '真实原Worker exit必须先于独立FD关闭、lease释放及read完成');
  const held = events[acquired]!, quiet = events[released]!;
  assert.ok('fd' in held && 'fd' in quiet);
  assert.equal(quiet.fd, held.fd);
  assert.throws(() => fstatSync(quiet.fd), { code: 'EBADF' }, '真实独立Reader FD已经关闭');
}

test('013真实新编译Reader在同SAB写保护内读取六格式完整原字节，普通Reader仍被阻止，exit后才释放', async t => {
  const f = await heldTargets(t, coreAudioIds), events: MetadataReaderLifecycle[] = [];
  const reader = f.reader.createMetadataReader({ onLifecycle: event => events.push(event) });
  assert.deepEqual(Object.keys(reader), ['read', 'close']);
  try {
    for (const target of f.targets) {
      const input = { root: f.f.root, relative: target.path.relative, expectedSignature: target.observation.signature };
      const keys = Object.keys(input), before = JSON.stringify(input);
      events.length = 0;
      const ordinary = await reader.read(input);
      assert.deepEqual(ordinary, { status: 'failure', code: 'IO_ERROR', readEvidence: null });
      assert.equal(events.some(event => event.type === 'lease-acquired' || event.type === 'worker-start'), false);
      assert.throws(() => f.peer.acquireRead([target.observation.physical]), f.locks.PhysicalResourceBusy);
      assert.throws(() => f.peer.acquireSourceNamespaceRead(target.path.namespace.resources), f.locks.PhysicalResourceBusy);
      events.length = 0;
      const result = await f.reader.readRelocationMetadata(reader, input, f.access);
      assert.ok(result.status === 'ok');
      const entry = f.f.entry(coreAudioIds[f.targets.indexOf(target)]!);
      const baseline = f.baselines.get(target.path.relative)!;
      assert.deepEqual(result.technical, baseline.technical);
      assert.deepEqual(result.fields, baseline.fields);
      assert.deepEqual(result.coverEvidence, baseline.coverEvidence);
      assert.equal(result.technical.sampleRateHz, entry.observedAudio!.sampleRate);
      assert.equal(result.technical.channels, entry.observedAudio!.channels);
      assert.equal(result.readEvidence.wholeAudioHash, false);
      assertRealWorkerQuiet(events);
      assert.equal(f.physical.state, 'held');
      assert.equal(f.named.state, 'held');
      assert.equal(f.verify.relocationReadAccessTargets(f.access).length, 6);
      assert.deepEqual(Object.keys(input), keys);
      assert.equal(JSON.stringify(input), before);
    }
    await f.f.assertUnchanged();
    f.verify.revokeRelocationReadAccess(f.access);
  } finally { await reader.close(); await f.release(); }
});

test('013 JSON、FD数字、伪Reader、错误绑定与已撤销能力均不能绕过实际原Reader', async t => {
  const f = await heldTargets(t, ['core-flac']), events: MetadataReaderLifecycle[] = [];
  const reader = f.reader.createMetadataReader({ onLifecycle: event => events.push(event) });
  const target = f.targets[0]!, input = { root: f.f.root, relative: target.path.relative, expectedSignature: target.observation.signature };
  let fakeReadCalls = 0, getters = 0;
  const fakeReader: MetadataReaderPort = { async read() { ++fakeReadCalls; throw new Error('伪Reader不得执行'); }, async close() {} };
  try {
    assert.deepEqual(await f.reader.readRelocationMetadata(fakeReader, input, f.access),
      { status: 'failure', code: 'ADMISSION_FAILED', readEvidence: null });
    const fake = { fd: target.handle.fd, targets: f.targets, get authorized() { ++getters; return true; } };
    for (const access of [fake, JSON.parse(JSON.stringify(f.access)), { fd: target.handle.fd }, {}]) {
      const result = await f.reader.readRelocationMetadata(reader, input, access as RelocationReadAccess);
      assert.deepEqual(result, { status: 'failure', code: 'IO_ERROR', readEvidence: null });
    }
    for (const changed of [{ ...input, expectedSignature: 'different' },
      { ...input, root: { ...input.root, id: randomUUID() } }, { ...input, relative: 'different.flac' }]) {
      assert.deepEqual(await f.reader.readRelocationMetadata(reader, changed, f.access),
        { status: 'failure', code: 'IO_ERROR', readEvidence: null });
    }
    assert.equal(fakeReadCalls, 0); assert.equal(getters, 0);
    assert.equal(events.some(event => event.type === 'lease-acquired' || event.type === 'worker-start'), false);
    f.verify.revokeRelocationReadAccess(f.access);
    assert.deepEqual(await f.reader.readRelocationMetadata(reader, input, f.access),
      { status: 'failure', code: 'IO_ERROR', readEvidence: null });
    assert.equal(f.physical.state, 'held');
    assert.equal(events.some(event => event.type === 'worker-start'), false);
  } finally { await reader.close(); await f.release(); }
});

test('013真实Worker启动期间关闭原Reader，必须join exit及真实FD quiet，写保护不能提前释放', async t => {
  const f = await heldTargets(t, ['core-wav']), events: MetadataReaderLifecycle[] = [];
  let closing: Promise<void> | undefined;
  const reader = f.reader.createMetadataReader({ onLifecycle(event) {
    events.push(event);
    if (event.type === 'worker-online') {
      assert.equal(f.physical.state, 'held');
      assert.equal(f.named.state, 'held');
      closing = reader.close();
    }
  } });
  try {
    const target = f.targets[0]!, input = { root: f.f.root, relative: target.path.relative, expectedSignature: target.observation.signature };
    assert.deepEqual(await f.reader.readRelocationMetadata(reader, input, f.access),
      { status: 'failure', code: 'CANCELLED', readEvidence: null });
    assert.ok(closing, '确实在真实Worker online阶段请求关闭');
    await closing;
    assertRealWorkerQuiet(events);
    assert.equal(f.physical.state, 'held');
    assert.equal(f.named.state, 'held');
    f.verify.revokeRelocationReadAccess(f.access);
    assert.deepEqual(await reader.read(input), { status: 'failure', code: 'CLOSED', readEvidence: null });
  } finally { await reader.close(); await f.release(); }
});
