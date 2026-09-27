import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { verifyPinnedDeviceOutputHelper, type PinnedDeviceOutputHelper } from './bundled-device-output-helper.js';
import type { GateBLiveObservation } from './gate-b-admission.js';
import { DEVICE_OUTPUT_BACKEND_ID, DEVICE_OUTPUT_BACKEND_VERSION, DEVICE_OUTPUT_DRAIN_ALGORITHM_ID } from './device-output-protocol.js';

export interface ReadonlyDeviceCatalogCandidate {
  endpointId: string; label: string; uid: string; available: boolean;
}
export type ReadonlyDeviceObservation = Omit<GateBLiveObservation, 'selectionGeneration'>;
/** 只读HAL目录/精确观测；不能从默认设备、Renderer字段或Gate B记录补造。 */
export interface ReadonlyDeviceCatalog {
  list(signal: AbortSignal): Promise<readonly ReadonlyDeviceCatalogCandidate[]>;
  observeExact(uid: string, signal: AbortSignal): Promise<ReadonlyDeviceObservation | null>;
}
export type DeviceSelectionIssue = 'INVALID_REQUEST' | 'NO_DEVICE_CATALOG' | 'NO_CANDIDATES' | 'HELPER_UNAVAILABLE' | 'OUTPUT_RUN_UNVERIFIED' | 'DEVICE_CHANGED' | 'SCOPE_CHANGED' | 'CLOSED';
export class DeviceSelectionError extends Error {
  constructor(readonly code: DeviceSelectionIssue) { super(`录音输出设备选择不可用。 [${code}]`); }
}
const fail = (code: DeviceSelectionIssue): never => { throw new DeviceSelectionError(code); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uidValid = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
  && Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= 128;
const rateValid = (value: unknown): value is number => typeof value === 'number' && [44100, 48000, 88200, 96000, 176400, 192000].includes(value);
const formatValid = (value: unknown): value is GateBLiveObservation['format'] =>
  value === 'pcm-s16le' || value === 'pcm-s24le' || value === 'pcm-s32le' || value === 'pcm-f32le';
function validCatalog(value: unknown): value is readonly ReadonlyDeviceCatalogCandidate[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => item && typeof item === 'object'
    && Object.keys(item).length === 4 && dto.isRecordingDeviceCandidate({ endpointId: item.endpointId, label: item.label, available: item.available })
    && uidValid(item.uid)) && new Set(value.map(item => item.endpointId)).size === value.length
    && new Set(value.map(item => item.uid)).size === value.length;
}
function validObservation(value: unknown): value is ReadonlyDeviceObservation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const keys = ['endpointId', 'uid', 'sampleRate', 'channelCount', 'format', 'physicalFormat', 'bufferFrames',
    'backendId', 'backendVersion', 'configurationFingerprintSha256', 'alive', 'hasOutput'];
  return Object.keys(item).length === keys.length && Object.keys(item).every(key => keys.includes(key))
    && typeof item.endpointId === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(item.endpointId)
    && uidValid(item.uid) && rateValid(item.sampleRate) && (item.channelCount === 1 || item.channelCount === 2)
    && formatValid(item.format) && item.physicalFormat === item.format
    && typeof item.bufferFrames === 'number' && Number.isSafeInteger(item.bufferFrames)
    && item.bufferFrames >= 16 && item.bufferFrames <= 4096 && (item.bufferFrames & (item.bufferFrames - 1)) === 0
    && item.backendId === DEVICE_OUTPUT_BACKEND_ID && item.backendVersion === DEVICE_OUTPUT_BACKEND_VERSION
    && hash(item.configurationFingerprintSha256) && item.alive === true && item.hasOutput === true;
}
const sameRoute = (left: ReadonlyDeviceObservation, right: ReadonlyDeviceObservation): boolean =>
  left.endpointId === right.endpointId && left.uid === right.uid && left.sampleRate === right.sampleRate
  && left.channelCount === right.channelCount && left.format === right.format && left.physicalFormat === right.physicalFormat
  && left.bufferFrames === right.bufferFrames && left.backendId === right.backendId && left.backendVersion === right.backendVersion
  && left.configurationFingerprintSha256 === right.configurationFingerprintSha256;

interface Selected { public: dto.RecordingOutputSelection; observed: ReadonlyDeviceObservation }
interface Options {
  catalog?: ReadonlyDeviceCatalog;
  pin?: PinnedDeviceOutputHelper;
  assertCurrent?: () => void;
  assertIdle?: () => void;
  outputRecoveryReady?: () => boolean;
}

/** UUID代际仅存在Core内存；切库/关闭撤销，重新选择即使同一设备也产生新代际。 */
export function createRecordingDeviceSelectionBroker({ catalog, pin, assertCurrent = () => {}, assertIdle = () => {}, outputRecoveryReady = () => true }: Options) {
  const lifetime = new AbortController();
  let generation = 0, selected: Selected | undefined;
  const revoke = () => { generation += 1; selected = undefined; };
  const revokeIfCurrent = (ticket: number, snapshot: Selected | undefined) => {
    if (generation === ticket && selected === snapshot) revoke();
  };
  const check = (signal: AbortSignal) => {
    if (lifetime.signal.aborted) return fail('CLOSED');
    if (signal.aborted) return fail('SCOPE_CHANGED');
    try { assertCurrent(); } catch { revoke(); return fail('SCOPE_CHANGED'); }
  };
  const helper = async (signal: AbortSignal) => {
    if (!pin) return fail('HELPER_UNAVAILABLE');
    try { await verifyPinnedDeviceOutputHelper(pin); } catch { return fail('HELPER_UNAVAILABLE'); }
    check(signal);
  };
  const entries = async (signal: AbortSignal): Promise<readonly ReadonlyDeviceCatalogCandidate[]> => {
    if (!catalog) return fail('NO_DEVICE_CATALOG');
    let value: unknown;
    try { value = await catalog.list(signal); } catch { check(signal); return fail('NO_DEVICE_CATALOG'); }
    check(signal);
    if (!validCatalog(value)) return fail('NO_DEVICE_CATALOG');
    return value;
  };
  const observe = async (uid: string, signal: AbortSignal): Promise<ReadonlyDeviceObservation> => {
    if (!catalog) return fail('NO_DEVICE_CATALOG');
    let value: unknown;
    try { value = await catalog.observeExact(uid, signal); } catch { check(signal); return fail('DEVICE_CHANGED'); }
    check(signal);
    if (!validObservation(value) || value.uid !== uid) return fail('DEVICE_CHANGED');
    return value;
  };
  const verify = async (selection: dto.RecordingOutputSelection, signal: AbortSignal): Promise<GateBLiveObservation> => {
    check(signal);
    if (!dto.isRecordingOutputSelection(selection) || !selected || selection.endpointId !== selected.public.endpointId
      || selection.selectionGeneration !== selected.public.selectionGeneration) return fail('DEVICE_CHANGED');
    const ticket = generation, snapshot = selected;
    let observed: ReadonlyDeviceObservation;
    try {
      await helper(signal);
      observed = await observe(snapshot.observed.uid, signal);
      await helper(signal);
    } catch (error) { revokeIfCurrent(ticket, snapshot); throw error; }
    if (generation !== ticket || selected !== snapshot) return fail('DEVICE_CHANGED');
    if (!sameRoute(snapshot.observed, observed)) { revokeIfCurrent(ticket, snapshot); return fail('DEVICE_CHANGED'); }
    check(signal);
    return { ...observed, selectionGeneration: selection.selectionGeneration };
  };
  return {
    async list(): Promise<dto.RecordingDeviceCandidates> {
      check(lifetime.signal);
      if (!outputRecoveryReady()) return { candidates: [], selected: null, blockedReason: 'OUTPUT_RUN_UNVERIFIED', deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };
      if (!catalog) return { candidates: [], selected: null, blockedReason: 'NO_DEVICE_CATALOG', deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };
      if (!pin) return { candidates: [], selected: null, blockedReason: 'HELPER_UNAVAILABLE', deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };
      const ticket = generation, snapshot = selected;
      try {
        await helper(lifetime.signal);
        const current = await entries(lifetime.signal);
        if (generation !== ticket || selected !== snapshot) return { candidates: [], selected: null, blockedReason: 'NO_DEVICE_CATALOG', deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };
        if (snapshot) {
          const candidate = current.find(item => item.endpointId === snapshot.public.endpointId && item.available && item.uid === snapshot.observed.uid);
          if (!candidate) revokeIfCurrent(ticket, snapshot);
          else try { await verify(snapshot.public, lifetime.signal); } catch { revokeIfCurrent(ticket, snapshot); }
        }
        if (snapshot !== selected && generation !== ticket) return { candidates: [], selected: null, blockedReason: 'NO_DEVICE_CATALOG', deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };
        const candidates = current.map(({ endpointId, label, available }) => ({ endpointId, label, available }));
        return { candidates, selected: selected?.public ?? null,
          blockedReason: candidates.some(item => item.available) ? null : 'NO_CANDIDATES', deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };
      } catch (error) {
        revokeIfCurrent(ticket, snapshot);
        if (error instanceof DeviceSelectionError && (error.code === 'SCOPE_CHANGED' || error.code === 'CLOSED')) throw error;
        const blockedReason = error instanceof DeviceSelectionError && error.code === 'HELPER_UNAVAILABLE' ? 'HELPER_UNAVAILABLE' : 'NO_DEVICE_CATALOG';
        return { candidates: [], selected: null, blockedReason, deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };
      }
    },
    async select(request: dto.SelectRecordingDeviceRequest): Promise<dto.RecordingOutputSelection> {
      check(lifetime.signal);
      if (!outputRecoveryReady()) return fail('OUTPUT_RUN_UNVERIFIED');
      if (!dto.isSelectRecordingDeviceRequest(request)) return fail('INVALID_REQUEST');
      try { assertIdle(); } catch { return fail('SCOPE_CHANGED'); }
      revoke(); const ticket = generation;
      await helper(lifetime.signal);
      const current = await entries(lifetime.signal), candidate = current.find(item => item.endpointId === request.endpointId && item.available);
      if (!candidate) return fail('NO_CANDIDATES');
      const observed = await observe(candidate.uid, lifetime.signal);
      if (observed.endpointId !== candidate.endpointId || generation !== ticket) return fail('DEVICE_CHANGED');
      await helper(lifetime.signal);
      check(lifetime.signal);
      if (generation !== ticket) return fail('DEVICE_CHANGED');
      const publicSelection = Object.freeze({ endpointId: candidate.endpointId, selectionGeneration: randomUUID() });
      selected = { public: publicSelection, observed: Object.freeze({ ...observed }) };
      return { ...publicSelection };
    },
    verify,
    async binding(selection: dto.RecordingOutputSelection, signal: AbortSignal): Promise<dto.RecordingPlanOutputBinding> {
      const observed = await verify(selection, signal);
      return { endpointId: observed.endpointId, deviceUid: observed.uid, backendId: DEVICE_OUTPUT_BACKEND_ID,
        backendVersion: DEVICE_OUTPUT_BACKEND_VERSION, bufferFrames: observed.bufferFrames,
        configurationFingerprintSha256: observed.configurationFingerprintSha256, drainAlgorithmId: DEVICE_OUTPUT_DRAIN_ALGORITHM_ID };
    },
    async observeExactForAdmission(uid: string, signal: AbortSignal): Promise<GateBLiveObservation | null> {
      if (!selected || selected.observed.uid !== uid) return null;
      try { return await verify(selected.public, signal); } catch { return null; }
    },
    current(): dto.RecordingOutputSelection | null { check(lifetime.signal); return selected ? { ...selected.public } : null; },
    revoke,
    close() { revoke(); lifetime.abort(); },
  };
}
export type RecordingDeviceSelectionBroker = ReturnType<typeof createRecordingDeviceSelectionBroker>;
