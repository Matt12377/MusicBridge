import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
import type { MobileDsdCacheLimits, MobileDsdSourceAccess, MobilePreparedCache } from '../../src/mobile/prepared-cache-types.js';

export const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const valueHash = (value: unknown): string => hash(Buffer.from(JSON.stringify(value)));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
interface BoundFile { path: string; bytes: number; sha256: string }
interface BoundOutput extends BoundFile { sourcePath: string; sourceSha256: string; mtimeMs: number }
interface Preparation {
  schema: string; status: string; readerBindingSha256: string; inputsUnchanged: boolean; outputsUnchanged: boolean;
  sourceInputs: BoundFile[]; outputs: BoundOutput[];
  stages: { name: string; compilerExit: number; startedMs: number; finishedMs: number }[];
}
async function whole(file: string) {
  assert.equal(await realpath(file), file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = await fd.stat({ bigint: true }); assert.ok(a.isFile() && a.nlink === 1n && a.size > 0n && a.size <= 16n * 1024n ** 2n);
    const bytes = Buffer.alloc(Number(a.size)); let offset = 0;
    while (offset < bytes.length) { const read = await fd.read(bytes, offset, bytes.length - offset, offset); assert.ok(read.bytesRead); offset += read.bytesRead; }
    const axes = (v: typeof a) => [v.dev, v.ino, v.size, v.mode, v.uid, v.gid, v.nlink, v.mtimeNs, v.ctimeNs];
    assert.deepEqual(axes(await fd.stat({ bigint: true })), axes(a)); assert.deepEqual(axes(await lstat(file, { bigint: true })), axes(a));
    return { bytes, sha256: hash(bytes), stat: a };
  } finally { await fd.close(); }
}
let flight: ReturnType<typeof loadCore> | undefined;
async function loadCore() {
  const reader = await loadFreshMetadataReader(), file = process.env.MBRS003_READER_BUILD_BINDING;
  assert.ok(file && path.isAbsolute(file), '必须消费本轮原 Reader 与完整 Core 编译。');
  const bound = await whole(file), receiptPath = path.join(path.dirname(file), 'preparation-receipt.json'), receipt = await whole(receiptPath);
  const preparation = JSON.parse(receipt.bytes.toString('utf8')) as Preparation;
  assert.equal(preparation.schema, 'core-test.reader-preparation.v1'); assert.equal(preparation.status, 'FRESH_READER_PREPARED');
  assert.equal(preparation.readerBindingSha256, bound.sha256); assert.equal(preparation.inputsUnchanged, true); assert.equal(preparation.outputsUnchanged, true);
  const compiler = preparation.stages.find(row => row.name === 'fresh-core-compiler'); assert.ok(compiler); assert.equal(compiler.compilerExit, 0);
  const rows: BoundFile[] = [];
  for (const name of ['mobile/dsd-converter', 'mobile/mobile-ffmpeg-policy', 'mobile/prepared-cache-types', 'mobile/prepared-cache',
    'mobile/source-types', 'mobile/source-service', 'mobile/source-protocol', 'mobile/owner-service', 'mobile/owner-protocol', 'mobile/catalog-service',
    'collection/repository', 'collection/local-source-tickets', 'collection/local-scan-coordinator', 'library/dsd-container-facts',
    'library/scan-read-admission', 'recording/source-files', 'stream/physical-resource-locks']) {
    const sourcePath = `packages/bridge-core/src/${name}.ts`, source = preparation.sourceInputs.find(row => row.path === sourcePath); assert.ok(source); rows.push(source);
    for (const suffix of ['.js', '.js.map', '.d.ts']) {
      const output = preparation.outputs.find(row => row.path === `packages/bridge-core/dist/${name}${suffix}`); assert.ok(output);
      assert.equal(output.sourcePath, sourcePath); assert.equal(output.sourceSha256, source.sha256);
      assert.ok(output.mtimeMs >= compiler.startedMs && output.mtimeMs <= compiler.finishedMs); rows.push(output);
    }
  }
  async function assertBoundBytes() {
    assert.equal((await whole(file!)).sha256, bound.sha256); assert.equal((await whole(receiptPath)).sha256, receipt.sha256);
    for (const row of rows) { const actual = await whole(path.join(repositoryRoot, row.path)); assert.equal(actual.bytes.length, row.bytes); assert.equal(actual.sha256, row.sha256); }
  }
  await assertBoundBytes();
  const converter = await import(new URL('../../dist/mobile/dsd-converter.js', import.meta.url).href) as typeof import('../../src/mobile/dsd-converter.js');
  const cache = await import(new URL('../../dist/mobile/prepared-cache.js', import.meta.url).href) as typeof import('../../src/mobile/prepared-cache.js');
  const errors = await import(new URL('../../dist/mobile/prepared-cache-types.js', import.meta.url).href) as typeof import('../../src/mobile/prepared-cache-types.js');
  const files = await import(new URL('../../dist/recording/source-files.js', import.meta.url).href) as typeof import('../../src/recording/source-files.js');
  const locks = await import(new URL('../../dist/stream/physical-resource-locks.js', import.meta.url).href) as typeof import('../../src/stream/physical-resource-locks.js');
  const repository = await import(new URL('../../dist/collection/repository.js', import.meta.url).href) as typeof import('../../src/collection/repository.js');
  const scanner = await import(new URL('../../dist/collection/local-scan-coordinator.js', import.meta.url).href) as typeof import('../../src/collection/local-scan-coordinator.js');
  const admission = await import(new URL('../../dist/library/scan-read-admission.js', import.meta.url).href) as typeof import('../../src/library/scan-read-admission.js');
  const tickets = await import(new URL('../../dist/collection/local-source-tickets.js', import.meta.url).href) as typeof import('../../src/collection/local-source-tickets.js');
  const source = await import(new URL('../../dist/mobile/source-service.js', import.meta.url).href) as typeof import('../../src/mobile/source-service.js');
  const protocol = await import(new URL('../../dist/mobile/source-protocol.js', import.meta.url).href) as typeof import('../../src/mobile/source-protocol.js');
  const owner = await import(new URL('../../dist/mobile/owner-service.js', import.meta.url).href) as typeof import('../../src/mobile/owner-service.js');
  const ownerProtocol = await import(new URL('../../dist/mobile/owner-protocol.js', import.meta.url).href) as typeof import('../../src/mobile/owner-protocol.js');
  await assertBoundBytes(); return { reader, converter, cache, errors, files, locks, repository, scanner, admission, tickets, source, protocol, owner, ownerProtocol, assertBoundBytes };
}
export const freshCore = () => flight ??= loadCore();

/** 真实专用后端、只读原合成源和独立 FD；不冒充真实媒体、HTTP 或手机听感。 */
export async function backendFixture(t: TestContext) {
  const core = await freshCore(), parent = buildStoragePolicy().check(process.env.TMPDIR!, { mustExist: true });
  const parentStat = await lstat(parent); assert.equal(parentStat.mode & 0o777, 0o700);
  const directory = await mkdtemp(path.join(parent, 'musicbridge-mbm003-core-')); await chmod(directory, 0o700);
  const media = path.join(directory, 'media'); await mkdir(media, { mode: 0o700 });
  const beforeClaims = core.locks.physicalResourceLocks.combinedSnapshot(), originals = new Map<string, Buffer>();
  for (const [ext, sha] of [['dsf', '10d760c280ef0cad105cb30d0cb9c8f18057a58874d0c3f84163dbd85e8f9a47'],
    ['dff', 'a110f3bb71e01c91b925bfffe310a8988880ce07d64369b647e28e227444cefe']] as const) {
    const bytes = await readFile(new URL(`../fixtures/mbrs003/dsd/synthetic-balanced-dsd64.${ext}`, import.meta.url)); assert.equal(hash(bytes), sha);
    originals.set(ext, bytes); await writeFile(path.join(media, `source.${ext}`), bytes, { flag: 'wx', mode: 0o600 });
  }
  const sources: MobileDsdSourceAccess[] = [], caches: MobilePreparedCache[] = [];
  const extraCleanup: (() => Promise<void> | void)[] = [];
  let closed = false;
  async function close() {
    if (closed) return; const errors: unknown[] = [];
    for (const run of [...extraCleanup].reverse()) try { await run(); } catch (error) { errors.push(error); }
    for (const cache of caches) try { await cache.close(); } catch (error) { errors.push(error); }
    for (const source of sources) try { await core.converter.closeMobileDsdSource(source); } catch (error) { errors.push(error); }
    try { assert.deepEqual(core.locks.physicalResourceLocks.combinedSnapshot(), beforeClaims); await core.assertBoundBytes(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'DSD 后端夹具未证明全部 FD 与读保护 quiet。'); closed = true;
  }
  t.after(close);
  const backendDirectory = process.env.MBM003_CONVERTER_DIRECTORY, manifestSha256 = process.env.MBM003_CONVERTER_MANIFEST_SHA256;
  assert.ok(backendDirectory && path.isAbsolute(backendDirectory), '需要本轮专用后端，不回落旧录音或系统 FFmpeg。');
  assert.equal(manifestSha256, '233ff1404886db6183bc159fdc81e2d191cec9ddb6f43788f0a9228a13d1f6c7');
  const converter = await core.converter.loadMobileDsdConverter({ directory: backendDirectory, manifestSha256 });
  const datasetId = randomUUID(), ownerEpoch = randomUUID(), root = { ...await core.files.authorizeSourceDirectory(media), id: randomUUID() };
  let alive = true;
  const assertCurrent = () => { if (!alive) throw new core.errors.MobileDsdError('RESOURCE_RELEASED'); };
  async function source(ext: 'dsf' | 'dff' = 'dsf', identity = 'original') {
    const relative = `source.${ext}`, observed = await core.files.readonlySourceCandidateMetadata(root, relative);
    const result = await core.converter.openMobileDsdSource({ root, relative, signature: observed.signature, datasetId,
      identity: valueHash([datasetId, root, relative, identity]), sourceAudio: { codec: 'dsd', container: ext, sampleRateHz: 2_822_400, bitsPerSample: 1, channels: 2 }, assertCurrent }, new AbortController().signal);
    sources.push(result); return result;
  }
  async function cache(limits?: Partial<MobileDsdCacheLimits>) {
    const result = await core.cache.createMobilePreparedCache({ directory: path.join(directory, 'mobile-dsd-cache'), datasetId, ownerEpoch, converter, assertCurrent, ...(limits ? { limits } : {}) });
    caches.push(result); return result;
  }
  async function unchanged() {
    for (const [ext, original] of originals) { assert.deepEqual(await readFile(path.join(media, `source.${ext}`)), original);
      assert.equal(hash(await readFile(new URL(`../fixtures/mbrs003/dsd/synthetic-balanced-dsd64.${ext}`, import.meta.url))), hash(original)); }
  }
  return { core, converter, directory, media, root, datasetId, ownerEpoch, originals, source, cache, assertCurrent, unchanged, close,
    onClose(run: () => Promise<void> | void) { extraCleanup.push(run); }, retire() { alive = false; } };
}
export function preparationWindow() {
  const at = Date.now(); return { resourceCreatedAtMs: at, resourceExpiresAtMs: at + 300_000, sessionExpiresAtMs: at + 1_800_000, remainingPreparationMs: 240_000 };
}
export async function ready(cache: MobilePreparedCache, resourceId: string) {
  const deadline = Date.now() + 15_000;
  for (;;) { const result = await cache.status(resourceId); if (!('preparing' in result)) return result;
    assert.ok(Date.now() < deadline, '真实整曲准备必须在有限等待内完成。'); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
}
