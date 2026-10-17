import type {
  LocalAiNameCandidate, LocalWorkbenchApplyRequest, LocalWorkbenchCancelRequest, LocalWorkbenchPlan,
  LocalWorkbenchReceipt, LocalCueOutputTarget, LocalArtworkImage,
} from '@music-bridge/contracts'
import type { CueOwnerAssetReference, CueReadResult } from '../../library/cue-text-reader.js'

export interface LocalWorkbenchScanMemberFact {
  signature: string
  parserVersion: string
  revision: string
  failureCode: string | null
}
/** 原Owner读取的成功资产；文件名只是事实，不是打开路径的授权。 */
export interface LocalWorkbenchCatalogMemberCapture {
  /** 元数据读取未生成成功Track时保留null，不造代表音轨。 */
  trackId: string | null
  assetId: string
  fileName: string
  title: string | null
  artist: string | null
  album: string | null
  rootRevision: string
  fileRevision: string
  locationRevision: string
  metadataRevision: string
  scan?: LocalWorkbenchScanMemberFact
}
/** 真实扫描拒绝记录没有AudioAsset与资产修订；不能用合成ID补齐。 */
export interface LocalWorkbenchRejectedMemberCapture {
  trackId: null
  assetId: null
  fileName: string
  title: null
  artist: null
  album: null
  rootRevision: string
  fileRevision: null
  locationRevision: null
  metadataRevision: null
  scan: LocalWorkbenchScanMemberFact & { failureCode: string }
}
export type LocalWorkbenchMemberCapture = LocalWorkbenchCatalogMemberCapture | LocalWorkbenchRejectedMemberCapture
export type LocalWorkbenchNameSource = 'raw' | 'manual' | 'workbench-ai' | 'unknown'
export interface LocalWorkbenchAlbumCapture {
  albumId: string
  readToken: string
  revision: string
  rootId: string
  directoryId: string
  editionId: string | null
  /** 保留原CoverDrop名称字段，候选不反写原文。 */
  artistName: string
  albumName: string
  directoryName: string
  manualLocks: { artistName: boolean; albumName: boolean }
  /** 人工覆盖与已应用AI必须由原ledger证明；未知来源不能被默认为人工或AI。 */
  nameSources?: { artistName: LocalWorkbenchNameSource; albumName: LocalWorkbenchNameSource }
  members: readonly LocalWorkbenchMemberCapture[]
}
export interface LocalCueAudioProbe {
  assetReference: CueOwnerAssetReference
  sourceLabel: string
  /** 必须是实际只读音频帧证据，时长估计或CUE声明不能填入。 */
  evidence: 'audio-pcm-read'
  readRevision: string
  sampleRate: number | null
  totalPcmFrames: number | null
}
export type LocalCueCodec = 'flac' | 'alac' | 'mp3' | 'vorbis' | 'opus' | 'wavpack' | 'pcm-wav' | 'pcm-aiff'
export interface LocalCueFormatQualification {
  formatId: string
  revision: string
  codec: LocalCueCodec
  extension: string
  lossless: boolean
  /** Main实测编码、生成文件标签与音频回读资格。 */
  evidence: 'encoder-tag-audio-roundtrip'
  available: boolean
}
export interface LocalCueSheetCapture {
  album: LocalWorkbenchAlbumCapture
  cueId: string
  cueRevision: string
  parsed: CueReadResult<CueOwnerAssetReference>
  audio: readonly LocalCueAudioProbe[]
}
/** 私有输出与源的绑定；公开sourceLabel不承担执行寻址，避免同名文件选错源。 */
export interface LocalCueOutputBinding {
  itemId: string
  albumId: string
  sourceAssetId: string
  libraryRootId: string
  sourceRootId: string
  sourceReadRevision: string
}
export interface LocalWorkbenchPlanCapture {
  datasetId: string
  datasetRevision: string
  albums: readonly LocalWorkbenchAlbumCapture[]
  artwork?: readonly LocalWorkbenchArtworkCapture[]
  cueSheets?: readonly { cueId: string; revision: string; albumId: string }[]
  cueOutputs?: readonly LocalCueOutputBinding[]
  audio?: readonly LocalCueAudioProbe[]
  target?: LocalCueOutputTarget & { revision: string }
  format?: LocalCueFormatQualification
}
/** 明确选中的已解码副本必须随原计划持久化；来源不透明标记不构成文件权限。 */
export interface LocalWorkbenchArtworkCapture {
  albumId: string
  candidateId: string
  revision: string
  image: LocalArtworkImage
  /** 与image.original完全一致的规范Base64兼容原图；缩略图不能用于恢复原图。 */
  originalBase64: string
  origin: 'local-independent' | 'embedded' | 'manual' | 'provider'
  sourceLabel: string
  licenseLabel: string
  sourceIdentity?: string
  input?: { mime: 'image/png' | 'image/jpeg' | 'image/tiff' | 'image/webp'; bytes: number; sha256: string; converted: boolean }
}
/** Main/Core私有精确计划读取；公开候选ID和读取结果都不构成文件权限。 */
export interface LocalWorkbenchFrozenArtwork {
  datasetId: string
  datasetRevision: string
  planId: string
  planHash: string
  contextFingerprint: string
  capture: LocalWorkbenchAlbumCapture
  artwork: LocalWorkbenchArtworkCapture
}
type CommonDraft = Pick<LocalWorkbenchPlan, 'albumIds' | 'state' | 'blockers' | 'items'>
export type LocalWorkbenchPlanDraft =
  | (CommonDraft & { kind: 'artwork'; scope: 'MB_ONLY'; relationship: 'existing' | 'create-on-apply' })
  | (CommonDraft & { kind: 'ai'; scope: 'MB_ONLY'; candidateIds: readonly string[] })
  | (CommonDraft & { kind: 'cue'; scope: 'INDEPENDENT_OUTPUT'; sourceDisposition: 'retain'; target: LocalCueOutputTarget; tracks: Extract<LocalWorkbenchPlan, { kind: 'cue' }>['tracks'] })

export interface LocalNameModelInput {
  artistName: string
  albumName: string
  directoryName: string
  audioFiles: readonly { fileName: string; title: string | null; artist: string | null; album: string | null }[]
  totalAudioFiles: number
}
export interface LocalNameProposal {
  candidateId: string
  albumId: string
  captureRevision: string
  readToken: string
  artistName: string
  albumName: string
  reason: string
}
export type LocalNameProposalResult =
  | { status: 'ready'; proposal: LocalNameProposal; candidate: LocalAiNameCandidate }
  | { status: 'unavailable'; code: 'INVALID_CAPTURE'; publicMessage: string }
  | { status: 'failed'; code: 'MODEL_BUDGET' | 'MODEL_JSON' | 'MODEL_FIELDS' | 'MODEL_INSTRUCTIONS'; publicMessage: string }

/** 真正写入由原Owner/受保护Main actor实现；纯registry从不打开源或输出文件。 */
export interface LocalWorkbenchProtectedWriter {
  revalidate(capture: Readonly<LocalWorkbenchPlanCapture>, plan: Readonly<LocalWorkbenchPlan>): Promise<{ valid: true } | { valid: false; reason: string }>
  apply(request: Readonly<LocalWorkbenchApplyRequest>, plan: Readonly<LocalWorkbenchPlan>, capture: Readonly<LocalWorkbenchPlanCapture>): Promise<LocalWorkbenchReceipt>
  readOriginalReceipt(request: Readonly<LocalWorkbenchApplyRequest>): Promise<LocalWorkbenchReceipt | null>
  cancel?(request: Readonly<LocalWorkbenchCancelRequest>): Promise<LocalWorkbenchReceipt>
}
export interface LocalWorkbenchRegistryEntry {
  plan: LocalWorkbenchPlan
  capture: LocalWorkbenchPlanCapture
  original: LocalWorkbenchApplyRequest | null
  receipt: LocalWorkbenchReceipt | null
  cancellation: LocalWorkbenchCancelRequest | null
}
export interface LocalWorkbenchRegistrySnapshot {
  schemaVersion: 1
  datasetId: string
  revision: number
  entries: readonly LocalWorkbenchRegistryEntry[]
}
/** save必须由唯一Owner原子持久化/CAS；command先落账才允许真实writer开始。 */
export interface LocalWorkbenchRegistryPersistence {
  load(datasetId: string): Promise<LocalWorkbenchRegistrySnapshot | null>
  save(snapshot: Readonly<LocalWorkbenchRegistrySnapshot>, expectedRevision: number): Promise<void>
}
export type LocalWorkbenchPlanFailure = 'INVALID_CAPTURE' | 'INVALID_PLAN' | 'INVALID_REQUEST' | 'CHANGED' | 'EXPIRED'
  | 'UNQUALIFIED_FORMAT' | 'PCM_NOT_READ' | 'CUE_INVALID' | 'ORIGINAL_RECEIPT_REQUIRED' | 'ALREADY_DISPATCHED' | 'PERSISTENCE_FAILED' | 'CANCEL_UNAVAILABLE'
export class LocalWorkbenchPlanError extends Error {
  constructor(readonly code: LocalWorkbenchPlanFailure, readonly publicMessage: string) { super(publicMessage); this.name = 'LocalWorkbenchPlanError' }
}

export function isLocalWorkbenchDataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return required.every(key => Object.hasOwn(descriptors, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string'
    && [...required, ...optional].includes(key) && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))
}
export function isLocalWorkbenchDenseArray(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key)
    && Number(key) < value.length && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))
}
export function freezeLocalWorkbenchValue<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeLocalWorkbenchValue); Object.freeze(value) }
  return value
}
