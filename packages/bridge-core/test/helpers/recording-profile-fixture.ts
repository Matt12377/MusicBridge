import { randomUUID } from 'node:crypto';
import type { RecordingProfileContent } from '@music-bridge/contracts';
export function recordingProfileContent(sampleRate = 44100): RecordingProfileContent {
  return { name: '隔离测试录音参数', signalChain: [{ id: randomUUID(), kind: 'audio-interface', label: '合成声卡' }, { id: randomUUID(), kind: 'connection', label: '合成 RCA 连接' }, { id: randomUUID(), kind: 'cassette-deck', label: '合成磁带机' }], defaults: { noiseReduction: 'Off', calibration: '人工校准', recordLevel: null, preRollMs: 1000 }, compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true }, executionFormat: { sampleRate, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'isolated-test-no-output', version: '1' } } };
}
