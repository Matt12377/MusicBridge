import type test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadBundledOutputHelper } from '../../src/recording/bundled-output-helper.js';
import { pcmWaveHeader, inspectConversionOutput } from '../../src/recording/execution-wave.js';
import type { RecordingOutputRunner } from '../../src/recording/output-input.js';
import { recordingProfileContent } from './recording-profile-fixture.js';

export const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export type OutputInput = Parameters<RecordingOutputRunner['run']>[0];
export class FakeOutputChild extends EventEmitter {
  readonly writes: Buffer[] = [];
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, callback) => { this.writes.push(Buffer.from(chunk)); callback(); } });
  kill(signal?: NodeJS.Signals | number): boolean { this.kills.push(signal); return true; }
  process(): ChildProcess { return this as unknown as ChildProcess; }
  close(code: number | null = 0): void { this.emit('close', code, code === null ? 'SIGKILL' : null); }
}
export function nativeEvent(input: OutputInput, kind: number, sequence = kind, code = 0): Buffer {
  const b = Buffer.alloc(128); b.write('MBFE'); b.writeUInt16LE(1, 4); b.writeUInt16LE(kind, 6); b.writeUInt32LE(sequence, 8); b.writeUInt32LE(code, 12);
  Buffer.from(input.identity.runId.replaceAll('-', ''), 'hex').copy(b, 16); b.writeBigUInt64LE(BigInt(sequence * 1000), 32);
  if (kind === 4 || kind === 5) b.writeBigUInt64LE(BigInt(input.audio.frameCount), 40);
  if (kind >= 2) Buffer.from(input.audio.pcmSha256, 'hex').copy(b, 64);
  if (kind === 5) Buffer.from(input.audio.pcmSha256, 'hex').copy(b, 96);
  return b;
}
export function complete(child: FakeOutputChild, input: OutputInput): void {
  for (let kind = 1; kind <= 5; kind++) child.stdout.write(nativeEvent(input, kind));
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('合成进程未到达预期检查点'); await new Promise(resolve => setTimeout(resolve, 1)); }
}
export async function outputHelperFixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-helper-runner-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'bin')); await mkdir(path.join(directory, 'build'));
  const helper = path.join(directory, 'bin/output-helper'), hal = path.join(directory, 'build/core-audio-adapter.o');
  await writeFile(helper, '受控子进程替身，不执行此文本', { mode: 0o700 }); await writeFile(hal, '合成HAL编译证据', { mode: 0o600 });
  const manifest = JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.1.0', mode: 'synthetic-only', files: { helper: { path: 'bin/output-helper', sha256: sha('受控子进程替身，不执行此文本') }, halAdapter: { path: 'build/core-audio-adapter.o', sha256: sha('合成HAL编译证据') } }, sourceSha256: 'a'.repeat(64) });
  await writeFile(path.join(directory, 'manifest.json'), manifest, { mode: 0o600 });
  const pin = (await loadBundledOutputHelper(directory, sha(manifest)))!;
  const frameCount = 2051, pcm = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount * 2; i++) pcm.writeInt16LE((i * 31 % 65536) - 32768, i * 2);
  const wavPath = path.join(directory, '合成立体声.wav'); await writeFile(wavPath, Buffer.concat([pcmWaveHeader(48000, 2, 16, frameCount), pcm]));
  const handle = await open(wavPath, 'r'); t.after(() => handle.close());
  const abort = new AbortController(), format = { ...recordingProfileContent(48000).executionFormat, outputProfileVersion: randomUUID() };
  const audio = await inspectConversionOutput(handle, format, abort.signal);
  const input: OutputInput = { handle, audio, format, signal: abort.signal, checkOperation: () => undefined, identity: { runId: randomUUID(), planVersionId: randomUUID(), assetId: randomUUID(), planContentHash: '1'.repeat(64), recipeHash: '2'.repeat(64) } };
  return { directory, pin, helper, hal, input, abort, pcm };
}
