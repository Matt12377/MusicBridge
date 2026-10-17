import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js';
import { loadLibraryWatchBundle, startLibraryMonitor } from '../../src/library/fsevents-library-monitor.js';
import { mergeNativeEvidence, nativeEvidencePin, rawReceipt } from '../../src/library/local-cue-format-qualification.js';

test('真正FSEvents事件使原根读取失效，STOP取得原生ACK后无迟到回调且FD与进程实际闭合', { skip: process.platform !== 'darwin' }, async () => {
  const evidence = process.env.MB_V39_NATIVE_PROOF_DIR; assert.ok(evidence);
  const directory = path.join(evidence, 'watcher'); await mkdir(directory, { mode: 0o700 });
  const bundleRoot = process.env.MB_V39_WATCH_BUNDLE ?? path.join(directory, 'bundle');
  if (!process.env.MB_V39_WATCH_BUNDLE) {
    const script = fileURLToPath(new URL('../../../../scripts/native/build-library-watch.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, bundleRoot, path.join(directory, 'build')], { detached: true, env: process.env, stdio: ['ignore','pipe','pipe'] });
    const raw = [[], []] as Buffer[][]; let size = 0, failed = false;
    const kill = (): void => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failed = true; } };
    const timer = setTimeout(() => { failed = true; kill(); }, 180000);
    for (const [index, stream] of [child.stdout!, child.stderr!].entries()) stream.on('data', (bytes: Buffer) => {
      size += bytes.length; if (size > 16 * 1024 * 1024) { failed = true; kill(); } else raw[index]!.push(bytes);
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => { failed = true; }); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    let gone = false; if (child.pid) try { process.kill(-child.pid, 0); kill(); } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    await rawReceipt(directory, 'build', { stdout: Buffer.concat(raw[0]!), stderr: Buffer.concat(raw[1]!), exitCode: result.code, signal: result.signal,
      pid: child.pid ?? null, pidClosed: gone }, evidence);
    assert.equal(failed, false); assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(gone, true);
  }
  const manifest = await readFile(path.join(bundleRoot, 'manifest.json'));
  const bundle = await loadLibraryWatchBundle(bundleRoot, createHash('sha256').update(manifest).digest('hex'));
  const rootPath = path.join(directory, 'source-root'); await mkdir(rootPath, { mode: 0o700 });
  const root = { ...await authorizeSourceDirectory(rootPath), id: randomUUID() }, handle = await open(root.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const rootIdentity = await handle.stat({ bigint: true });
  let observed = 0, revision = 0, current = true, notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  const assertCurrent = async (): Promise<void> => { assert.equal(current, true); assert.equal(await sourceRootAvailability(root), 'ONLINE');
    const actual = await handle.stat({ bigint: true }); assert.equal(actual.dev, rootIdentity.dev); assert.equal(actual.ino, rootIdentity.ino); };
  const originalRevision = revision;
  const monitor = await startLibraryMonitor(bundle, { root: handle, assertCurrent, invalidate() { observed++; revision++; notify(); } });
  let stopped: Awaited<ReturnType<typeof monitor.stop>> | undefined;
  try {
    await writeFile(path.join(rootPath, '新扫描事实.wav'), '合成目录变更', { flag: 'wx', mode: 0o600 });
    let expiry: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([notified, new Promise<never>((_, reject) => { expiry = setTimeout(() => reject(new Error('未收到实际FSEvents事件。')), 15000); })]); }
    finally { if (expiry) clearTimeout(expiry); }
    assert.ok(observed > 0); assert.notEqual(revision, originalRevision);
    assert.throws(() => assert.equal(revision, originalRevision), '变更前读取身份必须失效。');
    stopped = await monitor.stop();
    assert.equal(stopped.stopAcknowledged, true); assert.equal(stopped.callbacksAfterStop, 0); assert.equal(stopped.pidClosed, true);
    const count = observed; current = false;
    await writeFile(path.join(rootPath, '关闭后.wav'), '关闭后变更', { flag: 'wx', mode: 0o600 });
    assert.equal(observed, count);
  } finally { if (!stopped) await monitor.close(); await handle.close(); }
  await assert.rejects(handle.stat(), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
  assert.equal(monitor.inspect().acknowledged, true); assert.equal(monitor.inspect().callbacksAfterStop, 0);
  const raw = await rawReceipt(directory, 'watch', { ...stopped!, exitCode: 0, signal: null }, evidence);
  const packageEvidence = process.env.MB_V39_WATCH_BUNDLE ? null : { manifest: await nativeEvidencePin(path.join(bundleRoot, 'manifest.json'), evidence),
    program: await nativeEvidencePin(path.join(bundleRoot, 'mb-library-watch'), evidence) };
  await mergeNativeEvidence(evidence, { watcher: { stopAcknowledged: true, invalidationVerified: true, fdsClosed: true,
    invalidationsObserved: stopped!.invalidationsObserved, callbacksAfterStop: 0, raw, bundle: packageEvidence } });
});
