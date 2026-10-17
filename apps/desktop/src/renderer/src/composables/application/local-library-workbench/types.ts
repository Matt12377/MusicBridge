import type {
  LocalWorkbenchAction, LocalAiBackend, LocalWorkbenchField, LocalWorkbenchAvailability, LocalWorkbenchCapability, LocalWorkbenchAlbumRef, LocalWorkbenchOpenRequest, LocalWorkbenchCapture, LocalWorkbenchCueRef, LocalWorkbenchAlbumSnapshot, LocalWorkbenchReadback, LocalArtworkSearchSource, LocalArtworkImportFormat, LocalWorkbenchArtworkCandidate, LocalWorkbenchFieldChange, LocalAiNameCandidate, LocalAiAlbumResult, LocalAiBackendOption, LocalCueOutputFormat, LocalCueOutputTarget, LocalCueSplitInput, LocalWorkbenchPlanItem, LocalCueSplitTrack, LocalWorkbenchPlan, LocalWorkbenchApplyRequest, LocalWorkbenchResultState, LocalWorkbenchItemResult, LocalWorkbenchReceipt, LocalWorkbenchExistingAction, LocalWorkbenchOperation, LocalWorkbenchArtworkSearchReply, LocalWorkbenchArtworkSourceOutcome, LocalWorkbenchArtworkSearchRequest, LocalWorkbenchWebAction
} from '@music-bridge/contracts'
export type {
  LocalWorkbenchAction, LocalAiBackend, LocalWorkbenchField, LocalWorkbenchAvailability, LocalWorkbenchCapability, LocalWorkbenchAlbumRef, LocalWorkbenchOpenRequest, LocalWorkbenchCapture, LocalWorkbenchCueRef, LocalWorkbenchAlbumSnapshot, LocalWorkbenchReadback, LocalArtworkSearchSource, LocalArtworkImportFormat, LocalWorkbenchArtworkCandidate, LocalWorkbenchFieldChange, LocalAiNameCandidate, LocalAiAlbumResult, LocalAiBackendOption, LocalCueOutputFormat, LocalCueOutputTarget, LocalCueSplitInput, LocalWorkbenchPlanItem, LocalCueSplitTrack, LocalWorkbenchPlan, LocalWorkbenchApplyRequest, LocalWorkbenchResultState, LocalWorkbenchItemResult, LocalWorkbenchReceipt, LocalWorkbenchExistingAction, LocalWorkbenchOperation, LocalWorkbenchArtworkSearchReply, LocalWorkbenchArtworkSourceOutcome, LocalWorkbenchArtworkSearchRequest, LocalWorkbenchWebAction
} from '@music-bridge/contracts'

export interface LocalWorkbenchPortContext { signal: AbortSignal }
export interface LocalWorkbenchPorts {
  capabilities?: Partial<Record<LocalWorkbenchCapability, LocalWorkbenchAvailability>>
  artworkSources?: readonly LocalArtworkSearchSource[]
  artworkImportFormats?: readonly LocalArtworkImportFormat[]
  aiBackends?: readonly LocalAiBackendOption[]
  cueFormats?: readonly LocalCueOutputFormat[]
  existingActions?: Partial<Record<LocalWorkbenchExistingAction, LocalWorkbenchAvailability>>
  readAlbums?(request: { albums: readonly LocalWorkbenchAlbumRef[] }, context: LocalWorkbenchPortContext): Promise<LocalWorkbenchReadback>
  findArtworkCandidates?(request: { datasetId: string; capture: LocalWorkbenchCapture }, context: LocalWorkbenchPortContext): Promise<readonly LocalWorkbenchArtworkCandidate[]>
  searchArtworkCandidates?(request: LocalWorkbenchArtworkSearchRequest, context: LocalWorkbenchPortContext): Promise<LocalWorkbenchArtworkSearchReply>
  chooseArtworkFile?(request: { datasetId: string; capture: LocalWorkbenchCapture }, context: LocalWorkbenchPortContext): Promise<LocalWorkbenchArtworkCandidate | null>
  importArtworkBytes?(request: import('@music-bridge/contracts').LocalWorkbenchArtworkImportRequest, context: LocalWorkbenchPortContext): Promise<LocalWorkbenchArtworkCandidate>
  previewArtwork?(request: { datasetId: string; capture: LocalWorkbenchCapture; candidateId: string }, context: LocalWorkbenchPortContext): Promise<LocalWorkbenchPlan & { kind: 'artwork' }>
  suggestAlbumName?(request: { datasetId: string; capture: LocalWorkbenchCapture; backend: LocalAiBackend }, context: LocalWorkbenchPortContext): Promise<{ albumId: string; candidates: readonly LocalAiNameCandidate[] }>
  previewAi?(request: { datasetId: string; captures: readonly LocalWorkbenchCapture[]; selections: readonly { albumId: string; candidateId: string }[] }, context: LocalWorkbenchPortContext): Promise<LocalWorkbenchPlan & { kind: 'ai' }>
  chooseCueOutputTarget?(context: LocalWorkbenchPortContext): Promise<LocalCueOutputTarget | null>
  previewCueSplit?(request: LocalCueSplitInput, context: LocalWorkbenchPortContext): Promise<LocalWorkbenchPlan & { kind: 'cue' }>
  applyPlan?(request: LocalWorkbenchApplyRequest): Promise<LocalWorkbenchReceipt>
  /** 只读取原命令。unknown/running不得调用applyPlan替代核对。 */
  readOriginalReceipt?(request: LocalWorkbenchApplyRequest): Promise<LocalWorkbenchReceipt | null>
  cancelApplication?(request: { original: LocalWorkbenchApplyRequest; cancelCommandId: string }): Promise<LocalWorkbenchReceipt>
  /** 委托既有受保护对话框；工作台不构造SOURCE_FILES计划或新writer。 */
  openExistingAction?(request: { action: LocalWorkbenchExistingAction; albums: readonly LocalWorkbenchAlbumRef[] }): Promise<{ opened: true } | { opened: false; reason: string }>
}

/** 同一库/专辑工作台的受保护保存参与者，不创造另一套播放或写入会话。 */
export interface LocalWorkbenchSaveParticipant {
  pending: Readonly<import('vue').Ref<boolean>>
  locked: Readonly<import('vue').Ref<boolean>>
  save(): Promise<boolean>
  discard(): boolean | Promise<boolean>
}
export type LocalWorkbenchPane = LocalWorkbenchAction | 'lyrics' | 'library'

/** 原任务结果的只读定位；库捕获与专辑捕获是不同引用。 */
export interface LocalWorkbenchLyricsResultKey {
  jobId: string
  jobRevision: number
  library: import('@music-bridge/contracts').LocalLyricsLibraryRequest
  albumId: string
  category: 'review' | 'failed' | 'unknown'
}
export interface LocalWorkbenchLibraryResultKey { jobId: string; captureId: string; kind: 'ai' | 'cue'; albumId: string }
export type LocalWorkbenchInspectionPhase = 'idle' | 'loading' | 'ready' | 'stale' | 'error'
export type LocalWorkbenchInspectionReadPhase = LocalWorkbenchInspectionPhase | 'not-found'
export interface LocalWorkbenchResultInspection<K> {
  key: K
  phase: LocalWorkbenchInspectionPhase
  album: import('@music-bridge/contracts').LocalAlbumSummary | null
  trackPage: import('@music-bridge/contracts').LocalAlbumTrackPage | null
  capture: LocalWorkbenchCapture | null
  error: string | null
}
export interface LocalWorkbenchLyricsOriginalEntry {
  scope: import('@music-bridge/contracts').LocalLyricsScope
  sessionId: string | null
  saveRequest: import('@music-bridge/contracts').LocalLyricsSaveRequest | null
}
export type LocalWorkbenchOriginalLyricsEntry = LocalWorkbenchLyricsOriginalEntry
export interface LocalWorkbenchLyricsInspectionOperation {
  request: Readonly<import('@music-bridge/contracts').LocalLyricsSaveRequest>
  receipt: import('@music-bridge/contracts').LocalLyricsSaveReceipt | null
  phase?: LocalWorkbenchInspectionReadPhase
  error?: string | null
}
export interface LocalWorkbenchLyricsResultInspection extends LocalWorkbenchResultInspection<LocalWorkbenchLyricsResultKey> {
  originalEntry: LocalWorkbenchLyricsOriginalEntry | null
  session: import('@music-bridge/contracts').LocalLyricsSession | null
  operations: readonly LocalWorkbenchLyricsInspectionOperation[]
  detail: import('@music-bridge/contracts').LocalLyricsCandidateDetail | null
  sessionPhase: LocalWorkbenchInspectionReadPhase
  detailPhase: LocalWorkbenchInspectionReadPhase
}
export type LocalWorkbenchLibraryResultInspection = LocalWorkbenchResultInspection<LocalWorkbenchLibraryResultKey>
export interface LocalWorkbenchLyricsResultContext { signal: AbortSignal }

export function sameLocalWorkbenchLyricsResultKey(a: LocalWorkbenchLyricsResultKey, b: LocalWorkbenchLyricsResultKey): boolean {
  return a.jobId === b.jobId && a.jobRevision === b.jobRevision && a.albumId === b.albumId && a.category === b.category
    && a.library.datasetId === b.library.datasetId && a.library.libraryId === b.library.libraryId && a.library.captureId === b.library.captureId
}
export function sameLocalWorkbenchLibraryResultKey(a: LocalWorkbenchLibraryResultKey, b: LocalWorkbenchLibraryResultKey): boolean {
  return a.jobId === b.jobId && a.captureId === b.captureId && a.kind === b.kind && a.albumId === b.albumId
}
export function localWorkbenchLyricsResultKeyMatches(
  key: LocalWorkbenchLyricsResultKey, snapshot: import('@music-bridge/contracts').LocalLyricsJobSnapshot | null | undefined,
  original: import('@music-bridge/contracts').LocalLyricsJobStartRequest | null | undefined,
): boolean {
  if (!snapshot || !original || key.jobId !== original.commandId || snapshot.jobId !== original.commandId || key.jobRevision !== snapshot.revision) return false
  const same = (library: import('@music-bridge/contracts').LocalLyricsLibraryRequest) => library.datasetId === key.library.datasetId
    && library.libraryId === key.library.libraryId && library.captureId === key.library.captureId
  if (!same(original.library) || !same(snapshot.library)) return false
  const ids = key.category === 'review' ? snapshot.reviewAlbumIds : key.category === 'failed' ? snapshot.failedAlbumIds : key.category === 'unknown' ? snapshot.unknownAlbumIds : []
  return ids.includes(key.albumId)
}
export function localWorkbenchLibraryResultKeyMatches(
  key: LocalWorkbenchLibraryResultKey, page: import('@music-bridge/contracts').LocalLibraryBatchPage | null | undefined,
  original: { command: 'library.ai.start' | 'library.cue.start'; payload: { commandId: string; captureId: string } } | null | undefined,
): boolean {
  return !!page && !!original && key.jobId === original.payload.commandId && page.jobId === key.jobId
    && key.captureId === original.payload.captureId && page.captureId === key.captureId && page.kind === key.kind
    && key.kind === (original.command === 'library.ai.start' ? 'ai' : 'cue') && page.items.some(item => item.albumId === key.albumId)
}
