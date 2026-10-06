import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import type { MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
interface DsdFixture { file: string; bytes: number; sha256: string; container: string; dsdClockRateHz: number;
  actualFfprobeDecodedRateHz: number; actualFfprobeCodec: string; independentFiniteDecodeExit: number;
  expectedCurrentReader: { status: 'failure'; code: 'UNSUPPORTED' } }
const directory = fileURLToPath(new URL('../fixtures/mbrs003/dsd/', import.meta.url));
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
assert.equal(hash(manifestBytes), '8495dfc424211245b50c556eb3890a3ffd91168097ba321445acdcf28b70b7ee');
const manifest = JSON.parse(manifestBytes.toString('utf8')) as { schema: string; synthetic: boolean; files: DsdFixture[] };
assert.equal(manifest.schema, 'mbrs003.synthetic-dsd-portable.v1'); assert.equal(manifest.synthetic, true); assert.equal(manifest.files.length, 2);
const { createMetadataReader } = await loadFreshMetadataReader();
for (const fixture of manifest.files) {
  test(`MBRS003 有独立短解码证据的${fixture.container}：当前Reader明确UNSUPPORTED及实际Worker/FD关闭`, { timeout: 20_000 }, async t => {
    assert.equal(/^(?:synthetic-balanced-dsd64\.dsf|synthetic-balanced-dsd64\.dff)$/u.test(fixture.file), true);
    const original = path.join(directory, fixture.file), info = await lstat(original);
    assert.equal(info.isFile() && !info.isSymbolicLink(), true);
    const bytes = await readFile(original); assert.equal(bytes.length, fixture.bytes); assert.equal(hash(bytes), fixture.sha256);
    assert.equal(fixture.independentFiniteDecodeExit, 0); assert.equal(fixture.dsdClockRateHz, 2822400);
    assert.equal(fixture.actualFfprobeDecodedRateHz, 352800); assert.notEqual(fixture.actualFfprobeDecodedRateHz, fixture.dsdClockRateHz);
    const storage = buildStoragePolicy(), temp = process.env.TMPDIR;
    assert.equal(typeof temp === 'string' && path.isAbsolute(temp), true);
    const parent = storage.check(temp!, { mustExist: true }), parentInfo = await lstat(parent);
    assert.equal(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), true); assert.equal(await realpath(parent), parent);
    assert.equal(parentInfo.mode & 0o777, 0o700); assert.equal(typeof process.getuid, 'function'); assert.equal(parentInfo.uid, process.getuid!());
    const own = await mkdtemp(path.join(parent, 'musicbridge-mbrs003-dsd-')); await chmod(own, 0o700); storage.check(own, { mustExist: true });
    const copy = path.join(own, fixture.file); await writeFile(copy, bytes, { flag: 'wx', mode: 0o600 });
    const copied = await lstat(copy); assert.equal(copied.nlink, 1); assert.equal(copied.mode & 0o777, 0o600);
    const root = { ...await authorizeSourceDirectory(own), id: randomUUID() }, events: MetadataReaderLifecycle[] = [];
    const reader = createMetadataReader({ onLifecycle: event => events.push(event) }); t.after(() => reader.close());
    const expectedSignature = (await readonlySourceCandidateMetadata(root, fixture.file)).signature;
    const result = await reader.read({ root, relative: fixture.file, expectedSignature });
    assert.equal(result.status, 'failure'); if (result.status === 'failure') {
      assert.equal(result.code, 'UNSUPPORTED'); assert.notEqual(result.readEvidence, null);
      assert.equal(result.readEvidence!.bytesRead, 64); assert.equal(result.readEvidence!.wholeAudioHash, false); assert.equal(result.readEvidence!.wholeAudioDecode, false);
    }
    const starts = events.filter((event): event is Extract<MetadataReaderLifecycle, { type: 'worker-start' | 'worker-online' }> => event.type === 'worker-start');
    assert.equal(starts.length, 1); const start = starts[0]!;
    const exited = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
    const released = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
    const done = events.findIndex(event => event.type === 'read-complete');
    assert.equal(exited >= 0 && released > exited && done > released, true);
    assert.throws(() => fstatSync(start.fd), error => (error as NodeJS.ErrnoException).code === 'EBADF');
    await reader.close(); assert.equal(hash(await readFile(copy)), fixture.sha256); assert.equal(hash(await readFile(original)), fixture.sha256);
    assert.equal(hash(await readFile(path.join(directory, 'manifest.json'))), '8495dfc424211245b50c556eb3890a3ffd91168097ba321445acdcf28b70b7ee');
  });
}
