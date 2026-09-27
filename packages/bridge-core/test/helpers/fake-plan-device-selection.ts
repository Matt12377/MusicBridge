import { randomUUID } from 'node:crypto';
import type { RecordingOutputSelection, RecordingPlanOutputBinding } from '@music-bridge/contracts';
import { DeviceSelectionError } from '../../src/recording/device-selection-broker.js';

/** 仅供隔离合成计划测试：不加载bundle、不读取系统目录、更不打开HAL。 */
export function fakePlanDeviceSelection() {
  let current: RecordingOutputSelection | null = { endpointId: 'fixture_output', selectionGeneration: randomUUID() };
  let binding: RecordingPlanOutputBinding = { endpointId: 'fixture_output', deviceUid: 'fixture-coreaudio-uid',
    backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', bufferFrames: 256,
    configurationFingerprintSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
  const deviceSelection = {
    current: () => current ? { ...current } : null,
    async binding(selection: RecordingOutputSelection, signal: AbortSignal): Promise<RecordingPlanOutputBinding> {
      if (signal.aborted || !current || selection.endpointId !== current.endpointId
        || selection.selectionGeneration !== current.selectionGeneration) throw new DeviceSelectionError('DEVICE_CHANGED');
      return { ...binding };
    },
  };
  return { deviceSelection, get outputSelection() { return current ? { ...current } : null; },
    revoke() { current = null; },
    reselect() { current = { endpointId: 'fixture_output', selectionGeneration: randomUUID() }; return { ...current }; },
    drift() { binding = { ...binding, configurationFingerprintSha256: 'b'.repeat(64) }; },
  };
}
