import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, fstatSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile, type FileHandle } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { freshCore, hash, preparationWindow, ready, valueHash } from './fixture-helpers.js';
import type { MobileDsdSourceAccess } from '../../src/mobile/prepared-cache-types.js';

/** 本进程只承载精确 FD close 拒绝的受控负例；自然退出不代表 Dataset Owner 收尾成功。 */
const core = await freshCore(), parent = buildStoragePolicy().check(process.env.TMPDIR!, { mustExist: true });
assert.equal((await lstat(parent)).mode & 0o777, 0o700);
const directory = await mkdtemp(path.join(parent, 'musicbridge-mbm003-cache-close-')); await chmod(directory, 0o700);
const media = path.join(directory, 'media'); await mkdir(media, { mode: 0o700 });
const originalSource = await readFile(new URL('../fixtures/mbrs003/dsd/synthetic-balanced-dsd64.dsf', import.meta.url));
assert.equal(hash(originalSource), '10d760c280ef0cad105cb30d0cb9c8f18057a58874d0c3f84163dbd85e8f9a47');
const sourcePath = path.join(media, 'source.dsf'); await writeFile(sourcePath, originalSource, { flag: 'wx', mode: 0o600 });
const datasetId = randomUUID(), ownerEpoch = randomUUID(), root = { ...await core.files.authorizeSourceDirectory(media), id: randomUUID() };
const backendDirectory = process.env.MBM003_CONVERTER_DIRECTORY, manifestSha256 = process.env.MBM003_CONVERTER_MANIFEST_SHA256;
assert.ok(backendDirectory && path.isAbsolute(backendDirectory));
assert.equal(manifestSha256, '233ff1404886db6183bc159fdc81e2d191cec9ddb6f43788f0a9228a13d1f6c7');
const converter = await core.converter.loadMobileDsdConverter({ directory: backendDirectory, manifestSha256 });
const sources: MobileDsdSourceAccess[] = [], baselineClaims = core.locks.physicalResourceLocks.combinedSnapshot();
async function source(identity = 'original') {
  const observed = await core.files.readonlySourceCandidateMetadata(root, 'source.dsf');
  const result = await core.converter.openMobileDsdSource({ root, relative: 'source.dsf', signature: observed.signature, datasetId,
    identity: valueHash([datasetId, root, 'source.dsf', identity]),
    sourceAudio: { codec: 'dsd', container: 'dsf', sampleRateHz: 2_822_400, bitsPerSample: 1, channels: 2 }, assertCurrent() {} }, new AbortController().signal);
  sources.push(result); return result;
}
const cacheDirectory = path.join(directory, 'mobile-dsd-cache');
const cache = await core.cache.createMobilePreparedCache({ directory: cacheDirectory, datasetId, ownerEpoch, converter, assertCurrent() {},
  limits: { entries: 1, entryBytes: 16 * 1024, totalBytes: 16 * 1024 } });
const signal = new AbortController().signal, first = randomUUID();
await cache.begin({ resourceId: first, source: await source(), window: preparationWindow() }, signal);
const firstFacts = await ready(cache, first), originalOutput = Buffer.from(await cache.read(first, 0, firstFacts.size, signal));
await cache.release(first); assert.deepEqual(core.locks.physicalResourceLocks.combinedSnapshot(), baselineClaims);
const entries = await readdir(cacheDirectory); assert.equal(entries.length, 1);
const outputPath = path.join(cacheDirectory, entries[0]!, 'audio.flac'), manifestPath = path.join(cacheDirectory, entries[0]!, 'manifest.json');
assert.deepEqual(await readFile(outputPath), originalOutput);
const originalManifest = await readFile(manifestPath), changedOutput = Buffer.from(originalOutput);
changedOutput[changedOutput.length - 1] = changedOutput[changedOutput.length - 1]! ^ 1;
assert.notEqual(hash(changedOutput), hash(originalOutput));
const before = cache.snapshot(), failedResource = randomUUID();
const builtins = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
const originalOpen = builtins.open;
interface CapturedFd { file: FileHandle; descriptor: number; originalClose: () => Promise<void>; originalRead: FileHandle['read'] }
const capture: { value?: CapturedFd } = {};
let outputOpens = 0, verifierClosed = false, changed = false, closeRefusals = 0;
const closeFailure = new Error('受控缓存精确只读 FD 的 close 未核实。');
// 第一次是现有产物的完整 decode/hash 核验；仅第二次带原 namespace/physical guard 的真实 FD 注入。
builtins.open = async (...args: Parameters<typeof originalOpen>): Promise<FileHandle> => {
  const file = await originalOpen(...args); if (args[0] !== outputPath) return file;
  assert.equal(args[1], constants.O_RDONLY | constants.O_NOFOLLOW); outputOpens++;
  if (outputOpens === 1) {
    const close = file.close.bind(file);
    file.close = async () => { await close(); verifierClosed = true; }; return file;
  }
  assert.equal(outputOpens, 2); assert.equal(verifierClosed, true);
  capture.value = { file, descriptor: file.fd, originalClose: file.close.bind(file), originalRead: file.read };
  file.read = new Proxy(file.read, { apply(target, receiver, args) {
    return (async () => {
      // 到实际完整 Hash read 才改变 owned 输出，保证已获得的原 FD 和读保护都是真实的。
      if (!changed) { changed = true; await writeFile(outputPath, changedOutput); }
      return Reflect.apply(target, receiver, args);
    })();
  } });
  file.close = async () => { closeRefusals++; throw closeFailure; }; return file;
};
syncBuiltinESMExports();
const unquiet = (error: unknown) => error instanceof core.errors.MobileDsdError && error.quiet === false;
let retained: ReturnType<typeof core.locks.physicalResourceLocks.combinedSnapshot> | undefined;
try {
  await cache.begin({ resourceId: failedResource, source: await source(), window: preparationWindow() }, signal);
  let readyFailure: unknown;
  try { await ready(cache, failedResource); } catch (error) { readyFailure = error; }
  assert.ok(readyFailure instanceof core.errors.MobileDsdError);
  assert.equal(changed, true); assert.equal(outputOpens, 2); assert.equal(closeRefusals, 1); const captured = capture.value; assert.ok(captured);
  const info = await captured.file.stat({ bigint: true }); assert.equal(fstatSync(captured.descriptor, { bigint: true }).ino, info.ino);
  assert.deepEqual(core.locks.physicalResourceLocks.inspect([{ dev: String(info.dev), ino: String(info.ino) }]), { readers: 1, writers: 0, resources: 1 });
  retained = core.locks.physicalResourceLocks.combinedSnapshot(); assert.ok(retained.readers > baselineClaims.readers && retained.resources > baselineClaims.resources);
  assert.deepEqual(await readFile(outputPath), changedOutput); assert.deepEqual(await readFile(manifestPath), originalManifest);
  assert.equal(readyFailure.quiet, false, '真实目标 FD 的 close 拒绝不能被包装为已 quiet 的 SOURCE_CHANGED。');
  assert.equal(cache.qualified, false);
  assert.deepEqual(cache.snapshot(), { ...before, jobs: 1, waitingResources: 0, active: 0 });
  await assert.rejects(cache.begin({ resourceId: randomUUID(), source: await source('must-not-evict'), window: preparationWindow() }, signal), unquiet);
  await assert.rejects(cache.release(failedResource), unquiet); await assert.rejects(cache.close(), unquiet);
  assert.equal(closeRefusals, 1); assert.equal(cache.qualified, false);
  assert.equal(cache.snapshot().entries, before.entries); assert.equal(cache.snapshot().bytes, before.bytes); assert.equal(cache.snapshot().jobs, 1);
  assert.deepEqual(await readdir(cacheDirectory), entries); assert.deepEqual(await readFile(outputPath), changedOutput); assert.deepEqual(await readFile(manifestPath), originalManifest);
  assert.deepEqual(await readFile(sourcePath), originalSource); await core.assertBoundBytes();
} finally {
  builtins.open = originalOpen; syncBuiltinESMExports();
  const captured = capture.value;
  if (captured) {
    captured.file.read = captured.originalRead;
    // 只回收测试自己的底层 FD；原 SourceFile memoized close 拒绝和 guard 保留不会因此变为成功。
    captured.file.close = captured.originalClose; await captured.originalClose();
    assert.throws(() => fstatSync(captured.descriptor), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
  }
  for (const item of sources) await core.converter.closeMobileDsdSource(item);
}
assert.ok(retained && capture.value);
const after = core.locks.physicalResourceLocks.combinedSnapshot();
assert.ok(after.readers > baselineClaims.readers && after.resources > baselineClaims.resources);
assert.equal(after.writers, baselineClaims.writers); assert.ok(after.readers <= retained.readers && after.resources <= retained.resources);
await assert.rejects(cache.close(), unquiet); assert.equal(cache.qualified, false);
assert.equal(cache.snapshot().bytes, before.bytes); assert.equal(cache.snapshot().entries, before.entries);
assert.deepEqual(await readFile(outputPath), changedOutput); assert.deepEqual(await readFile(manifestPath), originalManifest);
assert.deepEqual(await readFile(sourcePath), originalSource); await core.assertBoundBytes();
process.stdout.write(`${JSON.stringify({
  schema: 'mbm003.cache-close-unverified-controlled-native-negative.v1',
  actualConvertedCache: true, exactReadonlyFdCloseRefused: true, fullHashMismatch: true,
  qualified: false, retainedCapacityAndFiles: true, retainedPhysicalAndNamespaceClaims: true,
  releaseAndCloseQuietFalse: true, laterBeginRefused: true, sourceUnchanged: true,
  testFdClosedByOriginalMethod: true, productQuietClaimed: false,
})}\n`);
