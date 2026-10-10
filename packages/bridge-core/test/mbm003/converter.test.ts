import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { constants, fstatSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { backendFixture, hash } from './fixture-helpers.js';

test('MBM003专用后端：两个真实容器全FD转换并整流解码，源整Hash与身份保持，输出是真24/48 FLAC', { timeout: 45_000 }, async t => {
  const f = await backendFixture(t);
  for (const ext of ['dsf', 'dff'] as const) {
    const source = await f.source(ext), before = await lstat(path.join(f.media, `source.${ext}`), { bigint: true });
    const full = await f.core.converter.hashMobileDsdSource(source, f.assertCurrent), outputPath = path.join(f.directory, `owned-${ext}.flac`);
    const writer = await open(outputPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), writeFd = writer.fd;
    try { await f.converter.convert(source, writer, f.assertCurrent, 16 * 1024); await writer.sync(); } finally { await writer.close(); }
    assert.throws(() => fstatSync(writeFd), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
    const reader = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW), readFd = reader.fd;
    let facts: Awaited<ReturnType<typeof f.converter.verifyOutput>>;
    try { facts = await f.converter.verifyOutput(reader, source, f.assertCurrent, 16 * 1024); } finally { await reader.close(); }
    assert.throws(() => fstatSync(readFd), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
    assert.deepEqual(facts.actualAudio, { codec: 'flac', container: 'flac', sampleRateHz: 48_000, bitsPerSample: 24, channels: 2 });
    assert.equal(facts.samples, 558); assert.equal(facts.sha256, hash(await readFile(outputPath))); assert.ok(facts.size < 16 * 1024);
    assert.equal(await f.core.converter.hashMobileDsdSource(source, f.assertCurrent), full);
    const after = await lstat(path.join(f.media, `source.${ext}`), { bigint: true });
    for (const field of ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const) assert.equal(after[field], before[field]);
  }
  await f.unchanged(); await f.close();
});

test('MBM003输出资格：假opaque能力与被修改的STREAMINFO拒绝，不能把部分或16-bit输出升级ready', { timeout: 30_000 }, async t => {
  const f = await backendFixture(t), source = await f.source();
  assert.equal(f.core.converter.isQualifiedMobileDsdConverter({ ...f.converter }), false);
  await assert.rejects(f.core.converter.hashMobileDsdSource({ ...source }, f.assertCurrent), error => error instanceof f.core.errors.MobileDsdError);
  const file = path.join(f.directory, 'owned.flac'), writer = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { await f.converter.convert(source, writer, f.assertCurrent, 16 * 1024); await writer.sync(); } finally { await writer.close(); }
  const modifier = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try { const header = Buffer.alloc(42); await modifier.read(header, 0, header.length, 0);
    const packed = header.readBigUInt64BE(18), bits = (packed & ~(31n << 36n)) | (15n << 36n); header.writeBigUInt64BE(bits, 18);
    await modifier.write(header, 0, header.length, 0); await modifier.sync(); } finally { await modifier.close(); }
  const reader = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await assert.rejects(f.converter.verifyOutput(reader, source, f.assertCurrent, 16 * 1024), error => error instanceof f.core.errors.MobileDsdError && error.quiet); }
  finally { await reader.close(); }
  await f.unchanged(); await f.close();
});

test('MBM003实际子进程取消：原FFmpeg已spawn后取消必须观察真实close，关闭输出再释放源保护', { timeout: 30_000 }, async t => {
  const f = await backendFixture(t), source = await f.source(), controller = new AbortController();
  const actualSpawn = childProcess.spawn; let spawned = 0, closed = 0;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const child = actualSpawn(...args); spawned++; child.once('spawn', () => controller.abort()); child.once('close', () => { closed++; }); return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const writer = await open(path.join(f.directory, 'cancelled.flac'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600), fd = writer.fd;
  const check = () => { f.assertCurrent(); if (controller.signal.aborted) throw new f.core.errors.MobileDsdError('RESOURCE_RELEASED'); };
  try { await assert.rejects(f.converter.convert(source, writer, check, 16 * 1024), error => error instanceof f.core.errors.MobileDsdError && error.code === 'RESOURCE_RELEASED' && error.quiet); }
  finally { await writer.close(); }
  assert.equal(spawned, 1); assert.equal(closed, 1); assert.throws(() => fstatSync(fd), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
  await f.unchanged(); await f.close();
});
