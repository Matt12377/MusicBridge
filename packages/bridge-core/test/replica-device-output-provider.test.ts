import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, open, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RecordingOutputSelection, RecordingReplicaInspection, ReplicaAudioIdentity } from '@music-bridge/contracts';
import type { PinnedDeviceOutputHelper } from '../src/recording/bundled-device-output-helper.js';
import { createReadonlyAudioConsumer } from '../src/recording/readonly-audio-consumer.js';
import { createReplicaDeviceOutputProvider } from '../src/recording/replica-device-output-provider.js';
import type { ReplicaVerifiedInput } from '../src/recording/replica-input.js';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

test('Replica seek段按剩余真实PCM重算Hash，普通播放不携带Formal Gate B身份', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-replica-device-'));
  const pcm = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const wav = Buffer.alloc(44 + pcm.length); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  const audioFile = path.join(directory, 'source.wav'); await writeFile(audioFile, wav);
  const handle = await open(audioFile, 'r');
  const helperFile = path.join(directory, 'helper'), manifestPath = path.join(directory, 'manifest.json');
  const helperBytes = Buffer.from('只供受控Fake，不执行原生HAL'), manifestBytes = Buffer.from('{}');
  await writeFile(helperFile, helperBytes); await chmod(helperFile, 0o755); await writeFile(manifestPath, manifestBytes);
  const pin: PinnedDeviceOutputHelper = { path: helperFile, sha256: sha(helperBytes), manifestPath,
    manifestSha256: sha(manifestBytes), sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
  const audio: ReplicaAudioIdentity = { target: 'actual-execution', executionAssetId: randomUUID(), recipeHash: 'b'.repeat(64),
    pcmHashEvidence: 'frozen-execution', fileSha256: sha(wav), size: wav.length, frameCount: 16, pcmSha256: sha(pcm),
    format: { container: 'wav', sampleRate: 48000, channelCount: 2, sampleFormat: 'pcm-s16le' } };
  const inspection: RecordingReplicaInspection = { recordingId: randomUUID(), recordingContentHash: 'c'.repeat(64),
    planVersionId: randomUUID(), planContentHash: 'd'.repeat(64), archiveOperationId: randomUUID(), archiveManifestHash: 'e'.repeat(64),
    readId: randomUUID(), checkedAt: new Date().toISOString(), fingerprint: 'f'.repeat(64),
    targets: [{ target: 'actual-execution', side: 'A', state: 'verified', audio },
      { target: 'actual-execution', side: 'B', state: 'empty', frameCount: 0 }],
    playback: 'blocked', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
  const controller = new AbortController();
  const consumer = createReadonlyAudioConsumer(handle, { dataOffset: 44, frameCount: 16, channelCount: 2,
    sampleFormat: 'pcm-s16le' }, controller.signal, () => {});
  const input: ReplicaVerifiedInput = { handle, audio, dataOffset: 44, consumer, inspection,
    signal: controller.signal, checkOperation() {} };
  const selection: RecordingOutputSelection = { endpointId: 'dev_1234567890', selectionGeneration: randomUUID() };
  const observed = { ...selection, uid: 'fake-output', sampleRate: 48000, channelCount: 2 as const,
    format: 'pcm-s16le' as const, physicalFormat: 'pcm-s16le' as const, bufferFrames: 16,
    backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', configurationFingerprintSha256: '1'.repeat(64),
    alive: true, hasOutput: true };
  let current: RecordingOutputSelection | null = selection, started = 0;
  const provider = createReplicaDeviceOutputProvider({ pin,
    deviceSelection: { current: () => current, async verify() { return observed; } },
    async run(_pin, request) {
      ++started;
      assert.equal(request.header.scope, 'replica-playback');
      assert.equal('recordSha256' in request.header, false);
      assert.equal(request.header.frameCount, 12);
      assert.equal(request.header.pcmSha256, sha(pcm.subarray(16)));
      assert.equal(request.reader.descriptor.frameCount, 12);
      const read = await request.reader.readFrames(0, 12);
      assert.deepEqual(read.bytes, pcm.subarray(16)); assert.equal(read.sourceEof, true);
      return { async stop() {}, async close() {} };
    },
  });
  try {
    const result = await provider.start({ logicalRunId: randomUUID(), segmentId: randomUUID(), fromFrame: 4,
      selection, input, signal: controller.signal, checkOperation() {}, onNativeAttempt() {}, callbacks: {
        onProgress() {}, onSourceEof() {}, onDrainObserved() {}, onCleanup() {}, onComplete() {}, onFailure() {},
      } });
    assert.equal(started, 1);
    assert.equal(result.fromFrame, 4);
    assert.equal(result.header.scope, 'replica-playback');
    await result.handle.close();
    current = { ...selection, selectionGeneration: randomUUID() };
    await assert.rejects(provider.verify(selection, controller.signal), { code: 'DEVICE_CHANGED' });
    assert.equal(started, 1);
  } finally { consumer.revoke(); await handle.close(); }
});
