import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { type LocalLibraryTrackDetail } from '@music-bridge/contracts';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { LocalSourceFence } from '../../src/stream/local-source-fence.js';
import type { LocalSourceCaptureResult } from '../../src/collection/local-source-ticket-types.js';
import { mobileLocalContentDigest } from '../../src/mobile/local-album-identity.js';
import { captureMobileOwnerPrivateResult } from '../../src/mobile/owner-boundary-capture.js';
import { isMobileOwnerSourceResult, type MobileOwnerSourceRequest, type MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import { ownedSourceByteLength } from '../../src/mobile/owned-source-bytes.js';
import { captureMobileContentCoreResponse, type MobileContentCoreRequest, type MobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { SOURCE_SCOPE, SOURCE_REQUEST, byteScans, sourceBytes } from './source-byte-pipeline-fixture.js';

const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const signal = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 };
type SourceRead = Extract<MobileOwnerSourceResult, { kind: 'mobile-source-read' }>;
interface OwnerPacket { kind: 'owner-read'; result: SourceRead; scans: number; events: string[]; owned: number | null }
interface MainPacket { kind: 'main-read'; before: number | null; after: number | null; scans: number; sha256: string; length: number }

async function worker(t: TestContext, data: unknown) {
  const value = new Worker(new URL('./source-owned-producer-worker.mjs', import.meta.url), { workerData: data, execArgv: [], resourceLimits: signal });
  t.after(() => value.terminate());
  const exited = once(value, 'exit'); assert.deepEqual((await once(value, 'message'))[0], { kind: 'ready' });
  return { value, async send<T>(packet: unknown): Promise<T> { const incoming = once(value, 'message'); value.postMessage(packet); return (await incoming)[0] as T; },
    async close() { value.postMessage({ kind: 'close' }); assert.deepEqual(await exited, [0]); assert.equal(value.threadId, -1); } };
}

/** 受控Owner事实＋原SourceService/物理FD＋真实Worker；不是Scanner、SQLite或手机证据。 */
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'source-owned-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // 真正的PCM WAVE；所有生产物理身份与文件长度检查均作用于这一个自有文件。
  const data = Buffer.alloc(262144), payload = data.byteLength - 44;
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(192000, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(payload, 40);
  for (let index = 44; index < data.length; index++) data[index] = index % 251;
  const filename = path.join(directory, 'synthetic.wav'); await writeFile(filename, data, { mode: 0o600 });
  const sourceRoot = { id: randomUUID(), ...await authorizeSourceDirectory(directory) }, info = await stat(filename, { bigint: true });
  const root = { id: randomUUID(), sourceRootId: sourceRoot.id, role: 'library' as const, revision: '1' };
  const asset = { id: randomUUID(), libraryRootId: root.id, sourceRootId: sourceRoot.id, rootRevision: '1', fileRevision: '2', locationRevision: '3', sampleFrames: null, timebaseHz: null };
  const track = { id: randomUUID(), assetId: asset.id, selectionRevision: '4', segment: null }, editionId = randomUUID();
  const detail: LocalLibraryTrackDetail = { track, asset, metadata: { raw: { title: '自有合成PCM' }, override: null, effective: { title: '自有合成PCM' } },
    versionTokens: [], editions: [{ id: editionId, title: '自有合成PCM', edition: '', revision: '1' }], fileParameters: null };
  const datasetId = randomUUID(), epoch = randomUUID(), fence = LocalSourceFence.create();
  const capture: LocalSourceCaptureResult = { ticketId: randomUUID(), epoch, datasetId, buffer: fence.buffer,
    metadata: { id: track.id, title: '自有合成PCM', artists: [], album: '' }, format: 'wav',
    fileParameters: { container: 'WAVE', codec: 'pcm_s16le', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
      durationMs: Math.round(payload / 192), evidence: 'bounded-parser-reported' },
    facts: { sourceRoot, root, asset, track, relative: path.basename(filename), observation: {
      signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), assetId: asset.id, trackId: track.id,
      libraryRootId: root.id, sourceRootId: sourceRoot.id, fileRevision: '2', rootRevision: '1', locationRevision: '3', selectionRevision: '4' } } };
  const content = mobileLocalContentDigest(datasetId, detail), selection = { resourceId: randomUUID(), trackId: `lt:${datasetId}:${track.id}:${editionId}`,
    versionId: 'lv:' + content, contentRevision: 'lc:' + content };
  const owner = await worker(t, { role: 'owner', capture, detail, editionId, selection }), main = await worker(t, { role: 'main' });
  return { owner, main, data, datasetId, selection, fence, filename };
}

function coreRead(raw: SourceRead, request: Extract<MobileOwnerSourceRequest, { operation: 'read' }>, datasetId: string) {
  return byteScans(() => {
    const result = captureMobileOwnerPrivateResult(raw, { kind: 'media-source', datasetId, request });
    assert.ok(result && 'kind' in result && result.kind === 'mobile-source-read');
    assert.equal(isMobileOwnerSourceResult(result, request), true);
    const scope = { ...SOURCE_SCOPE, datasetId, accountDomain: `local:${datasetId}` };
    const call: Extract<MobileContentCoreRequest, { action: 'source' }> = { type: 'mobile-content-core-request', id: randomUUID(), action: 'source', scope, request };
    let response: Extract<MobileContentCoreResponse, { action: 'source'; kind: 'source' }> = {
      type: 'mobile-content-core-response', id: call.id, action: 'source', kind: 'source', scope, source: 'local', result };
    for (let count = 0; count < 3; count++) {
      const next = captureMobileContentCoreResponse(response, call);
      assert.ok(next.action === 'source' && next.kind === 'source' && next.result.kind === 'mobile-source-read'); response = next;
    }
    return { response, call, first: result };
  });
}

test('M57 原Source真实FD与两次Worker入站保留13个guard，仅枚举两个外来64KiB原件', { timeout: 20_000 }, async t => {
  const f = await fixture(t), totals = { owner: 0, core: 0, main: 0 }, copies: boolean[] = [], brands: (number | null)[] = [], sequences: string[] = [];
  for (let index = 0; index < 4; index++) {
    const request = { ...SOURCE_REQUEST, handle: f.selection.resourceId, start: index * 65536 };
    const source = await f.owner.send<OwnerPacket>({ request }); assert.equal(source.kind, 'owner-read');
    assert.equal(source.result.kind, 'mobile-source-read'); assert.deepEqual(Buffer.from(source.result.bytes), f.data.subarray(request.start, request.start + 65536));
    assert.equal(ownedSourceByteLength(source.result.bytes, 65536), null, 'Owner品牌不能跨真实IPC');
    assert.equal(source.events.filter(value => value === 'facts').length, 15);
    assert.equal(source.events.filter(value => value === 'selected').length, 15);
    assert.equal(source.events.filter(value => value === 'named').length, 4);
    assert.equal(source.events.filter(value => value === 'read').length, 1);
    const core = coreRead(source.result, request, f.datasetId), expected = sha(source.result.bytes);
    const main = await f.main.send<MainPacket>({ response: core.value.response, call: core.value.call });
    assert.equal(main.kind, 'main-read'); assert.equal(main.before, null); assert.equal(main.after, 65536);
    assert.equal(main.length, 65536); assert.equal(main.sha256, expected);
    totals.owner += source.scans; totals.core += core.scans; totals.main += main.scans;
    copies.push(core.value.first.bytes.buffer !== source.result.bytes.buffer); brands.push(source.owned);
    sequences.push(sha(Buffer.from(JSON.stringify(source.events))));
  }
  console.log(JSON.stringify({ schema: 'mb.mac57.synthetic-source-enumeration.v1', blocks: 4, totals, scans: totals.owner + totals.core + totals.main,
    ticketFacts: 60, selections: 60, namedVerify: 16, actualFdReads: 4, realIpcBoundaries: 2, sequences, claim: '合成行为计数，不是手机SLA' }));
  assert.deepEqual(totals, { owner: 0, core: 4, main: 4 });
  assert.deepEqual(copies, [true, true, true, true], '完整入站后必须拥有独立副本');
  assert.deepEqual(brands, [65536, 65536, 65536, 65536], '只有原Source自己的新存储取得同realm资格');
  assert.deepEqual(sequences, Array(4).fill('14d37d23b7d61d7d4764059faaffd06d8689ac5a6e937f1007f03c01178e7fea'), '原15轮fresh闭环、4轮命名检查与read顺序保持');
  const eofRequest = { ...SOURCE_REQUEST, handle: f.selection.resourceId, start: f.data.length };
  const eof = await f.owner.send<OwnerPacket>({ request: eofRequest });
  assert.equal(eof.result.kind, 'mobile-source-read'); assert.equal(eof.result.bytes.byteLength, 0);
  assert.equal(eof.owned, 0); assert.equal(eof.events.filter(value => value === 'read').length, 0);
  const captured = captureMobileOwnerPrivateResult(eof.result, { kind: 'media-source', datasetId: f.datasetId, request: eofRequest });
  assert.ok(captured && 'kind' in captured && captured.kind === 'mobile-source-read'); assert.equal(ownedSourceByteLength(captured.bytes, 65536), 0);
  await f.owner.close(); await f.main.close(); assert.equal(f.fence.references, 0);
});

test('M57 新存储形状资格不代表事实或物理身份，撤权/原文件变化仍拒绝而无字节发布', { timeout: 20_000 }, async t => {
  for (const change of ['facts', 'physical'] as const) await t.test(change, async child => {
    const f = await fixture(child), request = { ...SOURCE_REQUEST, handle: f.selection.resourceId, start: 0 };
    const before = await f.owner.send<OwnerPacket>({ request }); assert.equal(before.result.kind, 'mobile-source-read');
    if (change === 'facts') f.fence.revoke();
    else { const changed = Buffer.from(f.data); changed[100] = changed[100]! ^ 255; await writeFile(f.filename, changed, { mode: 0o600 }); }
    const failed = await f.owner.send<{ result: { kind: string; code: string; status: number } }>({ request: { ...request, start: 65536 } });
    assert.equal(failed.result.kind, 'mobile-error'); assert.equal(failed.result.status, 409); assert.equal(failed.result.code, 'SOURCE_CHANGED');
    assert.equal(Object.hasOwn(failed.result, 'bytes'), false);
    await f.owner.close(); await f.main.close(); assert.equal(f.fence.references, 0);
  });
});

test('M57 Owner入站原件完整拒绝extra/Symbol/getter/Proxy/Buffer/SAB/错误身份，不能复制洗白', () => {
  const request = SOURCE_REQUEST, make = (bytes: unknown) => ({ kind: 'mobile-source-read', handle: request.handle, readId: request.readId, start: request.start, bytes });
  let getters = 0;
  const extra = sourceBytes(); Object.defineProperty(extra, 'extra', { value: 1 });
  const symbol = sourceBytes(); Object.defineProperty(symbol, Symbol('extra'), { value: 1 });
  const getter = sourceBytes(); Object.defineProperty(getter, 'extra', { get() { getters++; return 1; } });
  class Subclass extends Uint8Array {}
  const prototype = sourceBytes(); Object.setPrototypeOf(prototype, {});
  const bad = [extra, symbol, getter, new Proxy(sourceBytes(), {}), Buffer.alloc(65536), new Subclass(65536),
    new Uint8Array(new SharedArrayBuffer(65536)), prototype, new Uint8Array(65537)];
  const owner = { kind: 'media-source' as const, datasetId: SOURCE_SCOPE.datasetId, request };
  for (const bytes of bad) assert.equal(captureMobileOwnerPrivateResult(make(bytes), owner), null);
  const valid = make(sourceBytes()), bytesGetter = { ...valid };
  Object.defineProperty(bytesGetter, 'bytes', { enumerable: true, get() { getters++; return sourceBytes(); } });
  for (const raw of [{ ...valid, extra: 1 }, bytesGetter, new Proxy(valid, {}), { ...valid, handle: randomUUID() },
    { ...valid, readId: randomUUID() }, { ...valid, start: request.start + 1 }]) assert.equal(captureMobileOwnerPrivateResult(raw, owner), null);
  assert.equal(getters, 0);
});

test('M57 Owner完整入站后fixed独立副本保留空EOF/RAB准入，detach不能伪装EOF', () => {
  const owner = { kind: 'media-source' as const, datasetId: SOURCE_SCOPE.datasetId, request: SOURCE_REQUEST };
  const result = (bytes: Uint8Array) => ({ kind: 'mobile-source-read' as const, handle: SOURCE_REQUEST.handle, readId: SOURCE_REQUEST.readId, start: SOURCE_REQUEST.start, bytes });
  const empty = captureMobileOwnerPrivateResult(result(new Uint8Array()), owner); assert.ok(empty && 'kind' in empty && empty.kind === 'mobile-source-read');
  assert.equal(ownedSourceByteLength(empty.bytes, 65536), 0);
  const detached = sourceBytes(); structuredClone(detached, { transfer: [detached.buffer] });
  assert.equal(captureMobileOwnerPrivateResult(result(detached), owner), null);
  type Resizable = ArrayBuffer & { resize(size: number): void; resizable: boolean };
  const RAB = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => Resizable;
  const buffer = new RAB(65544, { maxByteLength: 131072 }), raw = new Uint8Array(buffer, 8, 65536); raw.set(sourceBytes());
  const value = byteScans(() => captureMobileOwnerPrivateResult(result(raw), owner)); assert.equal(value.scans, 1);
  assert.ok(value.value && 'kind' in value.value && value.value.kind === 'mobile-source-read');
  const bytes = value.value.bytes; assert.equal(ownedSourceByteLength(bytes, 65536), 65536);
  assert.equal((bytes.buffer as Resizable).resizable, false); assert.equal(bytes.byteOffset, 0); assert.equal(bytes.buffer.byteLength, 65536);
  buffer.resize(0); assert.deepEqual(bytes, sourceBytes()); structuredClone(buffer, { transfer: [buffer] }); assert.deepEqual(bytes, sourceBytes());
  assert.equal(Reflect.defineProperty(bytes, 'extra', { value: 1 }), false); assert.equal(Reflect.setPrototypeOf(bytes, {}), false);
  assert.equal(ownedSourceByteLength(structuredClone(bytes), 65536), null);
});
