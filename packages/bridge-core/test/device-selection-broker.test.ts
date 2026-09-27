import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRecordingDeviceSelectionBroker, DeviceSelectionError, type ReadonlyDeviceCatalog,
  type ReadonlyDeviceObservation } from '../src/recording/device-selection-broker.js';
import type { PinnedDeviceOutputHelper } from '../src/recording/bundled-device-output-helper.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function pin(): Promise<PinnedDeviceOutputHelper> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-selection-'));
  const helper = path.join(directory, 'helper'), manifest = path.join(directory, 'manifest.json');
  const helperBytes = Buffer.from('不会执行的受控测试helper'), manifestBytes = Buffer.from('{}');
  await writeFile(helper, helperBytes); await chmod(helper, 0o755); await writeFile(manifest, manifestBytes);
  return { path: helper, sha256: digest(helperBytes), manifestPath: manifest, manifestSha256: digest(manifestBytes),
    sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
}
const route = (): ReadonlyDeviceObservation => ({ endpointId: 'endpoint_1', uid: 'CoreAudio:private-uid',
  sampleRate: 48000, channelCount: 2, format: 'pcm-s16le', physicalFormat: 'pcm-s16le', bufferFrames: 256,
  backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', configurationFingerprintSha256: 'b'.repeat(64),
  alive: true, hasOutput: true });
function catalog(observation: () => ReadonlyDeviceObservation | null = route): ReadonlyDeviceCatalog {
  return { async list() { return [{ endpointId: 'endpoint_1', label: '受控输出设备', uid: 'CoreAudio:private-uid', available: true }]; },
    async observeExact(uid) { assert.equal(uid, 'CoreAudio:private-uid'); return observation(); } };
}
const issue = (code: DeviceSelectionError['code']) => (error: unknown) => error instanceof DeviceSelectionError && error.code === code;

test('生产无只读目录时只返回blocked，不枚举默认HAL、不签发选择', async () => {
  const broker = createRecordingDeviceSelectionBroker({ pin: await pin() });
  assert.deepEqual(await broker.list(), { candidates: [], selected: null, blockedReason: 'NO_DEVICE_CATALOG',
    deviceOpened: false, gateB: 'NOT_RUN', formalReady: false });
  await assert.rejects(broker.select({ endpointId: 'endpoint_1' }), issue('NO_DEVICE_CATALOG'));
  broker.close();
});

test('Core签发选择代际，绑定只读精确观测；重选、漂移、切库立即撤销旧代际', async () => {
  const helper = await pin(); let observed = route(), current = true;
  const broker = createRecordingDeviceSelectionBroker({ pin: helper, catalog: catalog(() => observed),
    assertCurrent() { if (!current) throw new Error('工作库已切换'); } });
  const first = await broker.select({ endpointId: 'endpoint_1' });
  assert.equal(first.endpointId, 'endpoint_1');
  assert.equal(Object.hasOwn(first, 'uid'), false);
  assert.equal((await broker.list()).selected?.selectionGeneration, first.selectionGeneration);
  assert.deepEqual(await broker.binding(first, new AbortController().signal), {
    endpointId: 'endpoint_1', deviceUid: 'CoreAudio:private-uid', backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0',
    bufferFrames: 256, configurationFingerprintSha256: 'b'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1',
  });
  const second = await broker.select({ endpointId: 'endpoint_1' });
  assert.notEqual(second.selectionGeneration, first.selectionGeneration);
  await assert.rejects(broker.verify(first, new AbortController().signal), issue('DEVICE_CHANGED'));
  observed = { ...observed, configurationFingerprintSha256: 'c'.repeat(64) };
  await assert.rejects(broker.verify(second, new AbortController().signal), issue('DEVICE_CHANGED'));
  assert.equal(broker.current(), null);
  const third = await broker.select({ endpointId: 'endpoint_1' });
  current = false;
  await assert.rejects(broker.verify(third, new AbortController().signal), issue('SCOPE_CHANGED'));
  current = true;
  assert.equal(broker.current(), null);
  broker.close();
});

test('选择期间撤销及固定helper漂移均不得产生新可用代际', async () => {
  const helper = await pin();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const broker = createRecordingDeviceSelectionBroker({ pin: helper, catalog: {
    ...catalog(), async observeExact() { await gate; return route(); },
  } });
  const pending = broker.select({ endpointId: 'endpoint_1' });
  broker.revoke(); release();
  await assert.rejects(pending, issue('DEVICE_CHANGED'));
  assert.equal(broker.current(), null);
  broker.close();

  const changed = createRecordingDeviceSelectionBroker({ pin: helper, catalog: catalog() });
  const selection = await changed.select({ endpointId: 'endpoint_1' });
  await writeFile(helper.path, '替换了固定helper');
  await assert.rejects(changed.verify(selection, new AbortController().signal), issue('HELPER_UNAVAILABLE'));
  assert.equal(changed.current(), null);
  changed.close();
});

test('旧精确观测迟到失败或漂移，不得撤销并发完成的新选择', async () => {
  for (const staleResult of ['throw', 'drift'] as const) {
    let calls = 0, entered!: () => void, release!: () => void;
    const seen = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const helper = await pin();
    const broker = createRecordingDeviceSelectionBroker({ pin: helper, catalog: {
      async list() { return [{ endpointId: 'endpoint_1', label: '受控输出设备', uid: 'CoreAudio:private-uid', available: true }]; },
      async observeExact() {
        calls += 1;
        if (calls === 2) {
          entered(); await gate;
          if (staleResult === 'throw') throw new Error('旧观测失败');
          return { ...route(), configurationFingerprintSha256: 'c'.repeat(64) };
        }
        return route();
      },
    } });
    const first = await broker.select({ endpointId: 'endpoint_1' });
    const oldVerification = broker.verify(first, new AbortController().signal);
    await seen;
    const latest = await broker.select({ endpointId: 'endpoint_1' });
    release();
    await assert.rejects(oldVerification, issue('DEVICE_CHANGED'));
    assert.deepEqual(broker.current(), latest);
    assert.equal((await broker.verify(latest, new AbortController().signal)).selectionGeneration, latest.selectionGeneration);
    broker.close();
  }
});
