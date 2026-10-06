import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

interface ApeManifest {
  schema: string; synthetic: boolean;
  fixture: { file: string; bytes: number; sha256: string; gitBlobSHA1: string;
    expectedCurrentReader: { status: 'failure'; code: 'UNSUPPORTED' } };
  source: { treeSHA: string; gitBlobSHA1: string };
  documents: { file: string; bytes: number; sha256: string }[];
  rootActualCompleteness: { probeExit: number; decodeExit: number; gateExit: number; retry: number;
    decodedPCMBytes: number; decodedPCMCRC32: string; productReaderWasRun: boolean };
}
const directory = fileURLToPath(new URL('../fixtures/mbrs003/ape-assessment/', import.meta.url));
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
assert.equal(hash(manifestBytes), '1de8eb94307c5188c0c5dddfda8411f5bf01a2ba112d956528e343ea5982b518');
const manifest = JSON.parse(manifestBytes.toString('utf8')) as ApeManifest;
assert.equal(manifest.schema, 'mbrs003.synthetic-ape-assessment-portable.v1');
assert.equal(manifest.synthetic, true);
const { createMetadataReader } = await loadFreshMetadataReader();

test('MBRS003 完整作者合成APE：默认Reader明确UNSUPPORTED并实际Worker退出、FD关闭与私有许可归还', { timeout: 20_000 }, async t => {
  const fixture = manifest.fixture;
  assert.equal(fixture.file, 'silence_mono8k.ape'); assert.equal(fixture.bytes, 174);
  assert.equal(fixture.sha256, 'e49c9f3a28587d9f10644d64a72e047432249a8b3a8ff34f2c8f61fe4c07ba1c');
  assert.equal(manifest.source.treeSHA, 'ea6e8ca2848b18716a49ca6de0fe4d8d26d4893a');
  assert.equal(manifest.source.gitBlobSHA1, '1591dafc45d63e2136029e8d760d97dd1f7d4989');
  assert.deepEqual(fixture.expectedCurrentReader, { status: 'failure', code: 'UNSUPPORTED' });
  // 这里只核已封Root完整性收据的portable摘要；测试不调用probe/decoder/网络。
  const prior = manifest.rootActualCompleteness;
  assert.equal(prior.probeExit, 0); assert.equal(prior.decodeExit, 0); assert.equal(prior.gateExit, 0);
  assert.equal(prior.retry, 0); assert.equal(prior.decodedPCMBytes, 3200);
  assert.equal(prior.decodedPCMCRC32, 'CB7B98A6'); assert.equal(prior.productReaderWasRun, false);
  assert.equal(manifest.documents.length, 2);
  for (const document of manifest.documents) {
    assert.equal(['LICENSE-MIT.txt', 'NOTICE.md'].includes(document.file), true);
    const text = await readFile(path.join(directory, document.file));
    assert.equal(text.length, document.bytes); assert.equal(hash(text), document.sha256);
  }
  const original = path.join(directory, fixture.file), info = await lstat(original);
  assert.equal(info.isFile() && !info.isSymbolicLink(), true);
  const bytes = await readFile(original); assert.equal(bytes.length, fixture.bytes); assert.equal(hash(bytes), fixture.sha256);
  // 小夹具身份核验不等于生产Reader全音频Hash。
  const gitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(gitBlob, fixture.gitBlobSHA1);
  const storage = buildStoragePolicy(), temp = process.env.TMPDIR;
  assert.equal(typeof temp === 'string' && path.isAbsolute(temp), true);
  const parent = storage.check(temp!, { mustExist: true }), parentInfo = await lstat(parent);
  assert.equal(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), true); assert.equal(await realpath(parent), parent);
  assert.equal(parentInfo.mode & 0o777, 0o700); assert.equal(typeof process.getuid, 'function'); assert.equal(parentInfo.uid, process.getuid!());
  const own = await mkdtemp(path.join(parent, 'musicbridge-mbrs003-ape-')); await chmod(own, 0o700); storage.check(own, { mustExist: true });
  const copy = path.join(own, fixture.file); await writeFile(copy, bytes, { flag: 'wx', mode: 0o600 });
  const copied = await lstat(copy); assert.equal(copied.nlink, 1); assert.equal(copied.mode & 0o777, 0o600); assert.equal(copied.uid, process.getuid!());
  const root = { ...await authorizeSourceDirectory(own), id: randomUUID() };
  const events: MetadataReaderLifecycle[] = [], order: string[] = [];
  const context = { epoch: randomUUID(), datasetId: randomUUID() };
  // 固定quiet仅供此许可单元场景；真实票据本体沿生产实现，不冒Controller/Scanner优先级证明。
  const admission = createScanReadAdmission({ isBusy: () => false });
  let acquireCount = 0, releaseCount = 0, quietAtPermitRelease = false;
  const reader = createMetadataReader({
    onLifecycle(event) { events.push(event); order.push(event.type); },
    readAdmission: { async acquire(signal) {
      assert.equal(signal.aborted, false); assert.equal(admission.resourceCounts().permits, 0);
      const permit = admission.acquire(context); assert.equal(permit.status, 'granted');
      if (permit.status !== 'granted') throw new Error('合成quiet场景必须实际取得许可。');
      ++acquireCount; order.push('permit-acquired'); assert.equal(admission.resourceCounts().permits, 1);
      return () => {
        const start = events.find(event => event.type === 'worker-start');
        assert.ok(start && start.type === 'worker-start');
        const exited = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
        const closed = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
        quietAtPermitRelease = exited >= 0 && closed > exited;
        assert.equal(quietAtPermitRelease, true, '许可归还前必须已收到真实exit及父线程lease关闭事件');
        assert.throws(() => fstatSync(start.fd), error => (error as NodeJS.ErrnoException).code === 'EBADF');
        assert.deepEqual(admission.release(context, permit.permitId), { released: true });
        ++releaseCount; order.push('permit-released'); assert.equal(admission.resourceCounts().permits, 0);
      };
    } },
  });
  t.after(async () => { await reader.close(); admission.close(); });
  const expectedSignature = (await readonlySourceCandidateMetadata(root, fixture.file)).signature;
  const result = await reader.read({ root, relative: fixture.file, expectedSignature });
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') {
    assert.equal(result.code, 'UNSUPPORTED'); assert.notEqual(result.readEvidence, null);
    assert.equal(result.readEvidence!.bytesRead, 64);
    assert.equal(result.readEvidence!.wholeAudioHash, false); assert.equal(result.readEvidence!.wholeAudioDecode, false);
  }
  const starts = events.filter((event): event is Extract<MetadataReaderLifecycle, { type: 'worker-start' | 'worker-online' }> => event.type === 'worker-start');
  assert.equal(starts.length, 1); const start = starts[0]!;
  const exited = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
  const closed = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
  const done = events.findIndex(event => event.type === 'read-complete');
  assert.equal(exited >= 0 && closed > exited && done > closed, true);
  const exitEvent = events[exited]!; assert.equal(exitEvent.type, 'worker-exit');
  if (exitEvent.type === 'worker-exit') assert.equal(exitEvent.exitCode, 0);
  assert.throws(() => fstatSync(start.fd), error => (error as NodeJS.ErrnoException).code === 'EBADF');
  assert.equal(acquireCount, 1); assert.equal(releaseCount, 1); assert.equal(quietAtPermitRelease, true);
  assert.equal(order.indexOf('permit-acquired') < order.indexOf('lease-acquired'), true);
  assert.equal(order.indexOf('worker-exit') < order.indexOf('lease-released'), true);
  assert.equal(order.indexOf('lease-released') < order.indexOf('permit-released'), true);
  assert.equal(order.indexOf('permit-released') < order.indexOf('read-complete'), true);
  assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  await reader.close(); admission.close();
  assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
  assert.equal(hash(await readFile(copy)), fixture.sha256); assert.equal(hash(await readFile(original)), fixture.sha256);
  assert.equal(hash(await readFile(path.join(directory, 'manifest.json'))), '1de8eb94307c5188c0c5dddfda8411f5bf01a2ba112d956528e343ea5982b518');
  for (const document of manifest.documents) assert.equal(hash(await readFile(path.join(directory, document.file))), document.sha256);
});
