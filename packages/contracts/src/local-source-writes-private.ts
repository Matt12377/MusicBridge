import { isCollectionId } from './collection.js';
import { isLocalCatalogRevision } from './local-catalog.js';
import { isLocalArtworkTarget, type LocalArtworkTarget, type LocalArtworkImageInfo } from './local-artwork.js';
import type { IpcFailure } from './ipc.js';
import { validateIpcResponse } from './validator.js';
import { LOCAL_SOURCE_WRITES_BUDGET, LOCAL_SOURCE_WRITES_RANGES, isLocalSourceWritesCommandPayload, isLocalSourceWritesCommandResult, isLocalSourceWritesDatasetId, isLocalSourceWritesHash, type ConfirmLocalSourceWrites, type LocalSourceWritesRange, type LocalSourceWritesReceipt } from './local-source-writes.js';
import { localSourceWritesDataSnapshot, localSourceWritesRecord } from './local-source-writes-data.js';

/** 专用 Main→Owner 物理端口；这些名称不加入通用 IPC/dispatchInternal 白名单。 */
export const LOCAL_SOURCE_WRITES_PRIVATE_COMMANDS = ['localSourceWrites.attachOriginal', 'localSourceWrites.challenge', 'localSourceWrites.executeGranted'] as const;
export type LocalSourceWritesPrivateCommand = typeof LOCAL_SOURCE_WRITES_PRIVATE_COMMANDS[number];
export interface AttachLocalSourceWritesOriginal { datasetId: string; commandId: string; target: LocalArtworkTarget; candidateId: string; original: LocalArtworkImageInfo; bytes: Uint8Array }
export interface LocalSourceWritesOriginalReceipt { contentRef: string; sha256: string; bytes: number }
/** authorityId 是真实端口身份的投影；字段合法并不能替代 Owner 的端口/nonce/HMAC 检查。 */
export interface LocalSourceWritesPrivateGrant { challengeId: string; ownerEpoch: string; nonce: string; authorityId: string; signature: string }
export interface LocalSourceWritesChallengeRequest { datasetId: string; confirm: ConfirmLocalSourceWrites }
export interface LocalSourceWritesChallenge {
  datasetId: string; commandId: string; planId: string; expectedViewRevision: string; range: LocalSourceWritesRange;
  planHash: string; contextFingerprint: string; policyRevision: string; requestFingerprint: string; expiresAt: string;
  grant: LocalSourceWritesPrivateGrant;
}
export interface ExecuteGrantedLocalSourceWrites { datasetId: string; confirm: ConfirmLocalSourceWrites; grant: LocalSourceWritesPrivateGrant }
export interface LocalSourceWritesPrivateCommandPayloads {
  'localSourceWrites.attachOriginal': AttachLocalSourceWritesOriginal;
  'localSourceWrites.challenge': LocalSourceWritesChallengeRequest;
  'localSourceWrites.executeGranted': ExecuteGrantedLocalSourceWrites;
}
export interface LocalSourceWritesPrivateCommandResults {
  'localSourceWrites.attachOriginal': LocalSourceWritesOriginalReceipt;
  'localSourceWrites.challenge': LocalSourceWritesChallenge;
  'localSourceWrites.executeGranted': LocalSourceWritesReceipt;
}
export type SourceWritesMainRequest = { [C in LocalSourceWritesPrivateCommand]: { version: 1; type: 'source-writes-request'; requestId: string; sequence: number; command: C; payload: LocalSourceWritesPrivateCommandPayloads[C] } }[LocalSourceWritesPrivateCommand];
export type SourceWritesMainResponse = { version: 1; type: 'source-writes-response'; requestId: string; sequence: number } & ({ ok: true; result: LocalSourceWritesPrivateCommandResults[LocalSourceWritesPrivateCommand] } | { ok: false; failure: IpcFailure });

const record = localSourceWritesRecord;
const invalid = (): never => { throw new Error('源写私有端口的数据、材料或预算无效。'); };
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const backingLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const typedArraySet = Uint8Array.prototype.set;
function ownData(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || !names.every(name => keys.includes(name))) return invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    Object.defineProperty(result, name, { value: descriptor.value, enumerable: true });
  }
  return result;
}
/** 用原生 brand getter 核整块 backing；不枚举数百万个字节，也不调用自定义 iterator。 */
function binarySnapshot(input: unknown): Uint8Array {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Uint8Array.prototype) return invalid();
  const backing: unknown = bufferGetter.call(input), size: unknown = byteLengthGetter.call(input), offset: unknown = offsetGetter.call(input);
  if (!backing || typeof backing !== 'object' || Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || offset !== 0 || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > LOCAL_SOURCE_WRITES_BUDGET.originalBytes) return invalid();
  if (backingLengthGetter.call(backing) !== size || resizableGetter?.call(backing) === true) return invalid();
  const result = new Uint8Array(size);
  typedArraySet.call(result, input as Uint8Array);
  return result;
}
const positiveSequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const imageInfo = (value: unknown): value is LocalArtworkImageInfo => record(value, ['mime', 'bytes', 'sha256', 'width', 'height']) && (value.mime === 'image/png' || value.mime === 'image/jpeg')
  && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= LOCAL_SOURCE_WRITES_BUDGET.originalBytes && isLocalSourceWritesHash(value.sha256)
  && typeof value.width === 'number' && Number.isSafeInteger(value.width) && value.width > 0 && value.width <= 4096 && typeof value.height === 'number' && Number.isSafeInteger(value.height) && value.height > 0 && value.height <= 4096 && value.width * value.height <= 16777216;
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function grant(value: unknown): value is LocalSourceWritesPrivateGrant {
  return record(value, ['challengeId', 'ownerEpoch', 'nonce', 'authorityId', 'signature']) && [value.challengeId, value.ownerEpoch, value.authorityId].every(isCollectionId) && isLocalSourceWritesHash(value.nonce) && isLocalSourceWritesHash(value.signature);
}
function logicalPayload(command: LocalSourceWritesPrivateCommand, value: unknown): boolean {
  if (command === 'localSourceWrites.challenge') return record(value, ['datasetId', 'confirm']) && isLocalSourceWritesDatasetId(value.datasetId) && isLocalSourceWritesCommandPayload('localSourceWrites.confirm', value.confirm) && value.confirm.datasetId === value.datasetId;
  return command === 'localSourceWrites.executeGranted' && record(value, ['datasetId', 'confirm', 'grant']) && isLocalSourceWritesDatasetId(value.datasetId) && isLocalSourceWritesCommandPayload('localSourceWrites.confirm', value.confirm) && value.confirm.datasetId === value.datasetId && grant(value.grant);
}
export function localSourceWritesOriginalSnapshot(input: unknown): AttachLocalSourceWritesOriginal {
  try {
    const raw = ownData(input, ['datasetId', 'commandId', 'target', 'candidateId', 'original', 'bytes']);
    const { bytes: rawBytes, ...metadata } = raw;
    const captured = localSourceWritesDataSnapshot(metadata, LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes);
    if (!record(captured, ['datasetId', 'commandId', 'target', 'candidateId', 'original']) || !isLocalSourceWritesDatasetId(captured.datasetId) || ![captured.commandId, captured.candidateId].every(isCollectionId) || !isLocalArtworkTarget(captured.target) || !imageInfo(captured.original)) return invalid();
    const bytes = binarySnapshot(rawBytes);
    if (bytes.byteLength !== captured.original.bytes) return invalid();
    return Object.freeze({ ...captured, bytes }) as unknown as AttachLocalSourceWritesOriginal;
  } catch { return invalid(); }
}
export const isLocalSourceWritesPrivateCommand = (value: unknown): value is LocalSourceWritesPrivateCommand => typeof value === 'string' && (LOCAL_SOURCE_WRITES_PRIVATE_COMMANDS as readonly string[]).includes(value);
export function localSourceWritesMainRequestSnapshot(input: unknown): SourceWritesMainRequest {
  try {
    const raw = ownData(input, ['version', 'type', 'requestId', 'sequence', 'command', 'payload']);
    if (!isLocalSourceWritesPrivateCommand(raw.command)) return invalid();
    let captured: unknown;
    if (raw.command === 'localSourceWrites.attachOriginal') {
      const payload = localSourceWritesOriginalSnapshot(raw.payload), { bytes: _bytes, ...metadata } = payload;
      const envelope = localSourceWritesDataSnapshot({ ...raw, payload: metadata }, LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes);
      if (!record(envelope, ['version', 'type', 'requestId', 'sequence', 'command', 'payload'])) return invalid();
      captured = Object.freeze({ ...envelope, payload });
    } else captured = localSourceWritesDataSnapshot(raw, LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes);
    if (!record(captured, ['version', 'type', 'requestId', 'sequence', 'command', 'payload']) || captured.version !== 1 || captured.type !== 'source-writes-request' || !isCollectionId(captured.requestId) || !positiveSequence(captured.sequence) || captured.command !== raw.command) return invalid();
    if (captured.command !== 'localSourceWrites.attachOriginal' && !logicalPayload(raw.command, captured.payload)) return invalid();
    return captured as unknown as SourceWritesMainRequest;
  } catch { return invalid(); }
}
export function isSourceWritesMainRequest(input: unknown): input is SourceWritesMainRequest { try { localSourceWritesMainRequestSnapshot(input); return true; } catch { return false; } }
export function isLocalSourceWritesPrivateCommandResult<C extends LocalSourceWritesPrivateCommand>(command: C, input: unknown): input is LocalSourceWritesPrivateCommandResults[C] {
  try {
    const value = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes);
    if (command === 'localSourceWrites.attachOriginal') return record(value, ['contentRef', 'sha256', 'bytes']) && isCollectionId(value.contentRef) && isLocalSourceWritesHash(value.sha256) && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= LOCAL_SOURCE_WRITES_BUDGET.originalBytes;
    if (command === 'localSourceWrites.executeGranted') return isLocalSourceWritesCommandResult('localSourceWrites.confirm', value);
    return command === 'localSourceWrites.challenge' && record(value, ['datasetId', 'commandId', 'planId', 'expectedViewRevision', 'range', 'planHash', 'contextFingerprint', 'policyRevision', 'requestFingerprint', 'expiresAt', 'grant'])
      && isLocalSourceWritesDatasetId(value.datasetId) && [value.commandId, value.planId].every(isCollectionId) && [value.expectedViewRevision, value.policyRevision].every(isLocalCatalogRevision)
      && typeof value.range === 'string' && (LOCAL_SOURCE_WRITES_RANGES as readonly string[]).includes(value.range) && [value.planHash, value.contextFingerprint, value.requestFingerprint].every(isLocalSourceWritesHash) && date(value.expiresAt) && grant(value.grant);
  } catch { return false; }
}
export function localSourceWritesMainResponseSnapshot(input: unknown, command: LocalSourceWritesPrivateCommand): SourceWritesMainResponse {
  try {
    const value = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.originalMetadataEnvelopeBytes);
    if (!record(value, ['version', 'type', 'requestId', 'sequence', 'ok'], ['result', 'failure']) || value.version !== 1 || value.type !== 'source-writes-response' || !isCollectionId(value.requestId) || !positiveSequence(value.sequence)) return invalid();
    if (value.ok === true && record(value, ['version', 'type', 'requestId', 'sequence', 'ok', 'result']) && isLocalSourceWritesPrivateCommandResult(command, value.result)) return value as unknown as SourceWritesMainResponse;
    if (value.ok !== false || !record(value, ['version', 'type', 'requestId', 'sequence', 'ok', 'failure']) || !record(value.failure, ['version', 'id', 'ok', 'error']) || value.failure.id !== value.requestId || value.failure.ok !== false
      || !record(value.failure.error, ['code', 'message'], ['diagnosticId']) || !validateIpcResponse(value.failure).ok) return invalid();
    return value as unknown as SourceWritesMainResponse;
  } catch { return invalid(); }
}
export function isSourceWritesMainResponse(input: unknown, command: LocalSourceWritesPrivateCommand): input is SourceWritesMainResponse { try { localSourceWritesMainResponseSnapshot(input, command); return true; } catch { return false; } }
