/** 工作台展示模型；这些字段不构成源文件写入、目录或网络授权。 */
export type LocalWorkbenchAction = 'overview' | 'artwork' | 'ai' | 'cue' | 'organize'
export type LocalAiBackend = 'ollama' | 'vllm' | 'cloud'
export type LocalWorkbenchField = 'title' | 'artist' | 'album' | 'year' | 'disc' | 'track'
export type LocalWorkbenchAvailability = { available: true } | { available: false; reason: string }
export type LocalWorkbenchCapability =
  | 'read' | 'artwork-local' | 'artwork-search' | 'artwork-file' | 'artwork-drop' | 'artwork-preview'
  | 'ai-preview' | 'cue-preview' | 'apply' | 'receipt' | 'cancel-application' | 'existing-actions'

/** albumId 是浏览分组身份；editionId 只能来自已有真实关系，不能为浏览临时伪造。 */
export interface LocalWorkbenchAlbumRef {
  albumId: string
  title: string
  artist: string
  rootId?: string
  directoryId?: string
  editionId?: string
  trackIds: readonly string[]
  /** 作者完整分组的数量与修订；opaque捕获无需公开完整成员ID。 */
  trackCount?: number
  revision?: string
}
export interface LocalWorkbenchOpenRequest { action: LocalWorkbenchAction; albums: readonly LocalWorkbenchAlbumRef[] }
export interface LocalWorkbenchCapture {
  albumId: string
  /** 由作者签发且回读验证的只读捕获引用；Renderer不能自行生成。 */
  readToken: string
}
export interface LocalWorkbenchCueRef { cueId: string; label: string; eligible: boolean; reason?: string }
export interface LocalWorkbenchAlbumSnapshot {
  album: LocalWorkbenchAlbumRef
  capture: LocalWorkbenchCapture
  availability: 'online' | 'offline' | 'unavailable'
  issues: readonly string[]
  currentArtwork: { label: string; previewUrl: string | null } | null
  cueSheets: readonly LocalWorkbenchCueRef[]
  /** 原捕获中的源名称与现有规则清洗结果，仅供审阅查询，不写回元数据。 */
  searchNames?: { original: { artist: string; title: string }; cleaned: { artist: string; title: string } }
}
export interface LocalWorkbenchReadback {
  datasetId: string
  snapshotId: string
  albums: readonly LocalWorkbenchAlbumSnapshot[]
  settings?: { scanConcurrency: number; aiBackend: LocalAiBackend; aiModelLabel: string }
  /** 原Owner持久未确认操作的只读回显；不接受Renderer输入原计划制造恢复。 */
  pendingOperations?: readonly LocalWorkbenchOperation[]
}
export interface LocalArtworkSearchSource {
  id: string
  label: string
  kind: 'aggregate' | 'provider' | 'web'
  availability: LocalWorkbenchAvailability
  /** 仅网页原端口可调用性；实际refresh仍核同原窗口和捕获。 */
  webActions?: LocalWorkbenchWebActions
}
/** Main资格投影；可导入格式仍须归一化为受预算约束的JPEG/PNG展示副本。 */
export interface LocalArtworkImportFormat { mime: string; label: string; availability: LocalWorkbenchAvailability }
export interface LocalWorkbenchArtworkCandidate {
  candidateId: string
  albumId: string
  label: string
  origin: 'local-independent' | 'embedded' | 'manual' | 'provider'
  sourceLabel: string
  previewUrl: string | null
  width: number
  height: number
  licenseLabel: string
  reason?: string
}
export interface LocalWorkbenchFieldChange {
  field: LocalWorkbenchField
  before: string | null
  after: string | null
  reason: string
}
export interface LocalAiNameCandidate {
  candidateId: string
  albumId: string
  title: string
  artist: string
  reason: string
  changes: readonly LocalWorkbenchFieldChange[]
}
export interface LocalAiAlbumResult {
  albumId: string
  state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
  candidates: readonly LocalAiNameCandidate[]
  selectedCandidateId: string | null
  message: string | null
}
export interface LocalAiBackendOption { id: LocalAiBackend; label: string; availability: LocalWorkbenchAvailability }
export interface LocalCueOutputFormat { id: string; label: string; availability: LocalWorkbenchAvailability }
export interface LocalCueOutputTarget { choiceId: string; label: string; independent: true }
export interface LocalCueSplitInput {
  datasetId: string
  captures: readonly LocalWorkbenchCapture[]
  cueSelections: readonly { albumId: string; cueId: string }[]
  outputFormat: string
  target: LocalCueOutputTarget
  sourceDisposition: 'retain'
}
export interface LocalWorkbenchPlanItem {
  itemId: string
  albumId: string
  label: string
  changes: readonly LocalWorkbenchFieldChange[]
}
export interface LocalCueSplitTrack extends LocalWorkbenchPlanItem {
  sequence: number
  sourceLabel: string
  startFrame: number
  frameCount: number
  sampleRate: number
  outputName: string
  outputFormat: string
}
interface LocalWorkbenchPlanBase {
  datasetId: string
  planId: string
  revision: string
  planHash: string
  contextFingerprint: string
  expiresAt: string
  albumIds: readonly string[]
  state: 'ready' | 'blocked'
  blockers: readonly string[]
  items: readonly LocalWorkbenchPlanItem[]
}
/** 作者持有冻结计划；这里只展示副本，最终应用必须回核原plan/revision/hash/context。 */
export type LocalWorkbenchPlan =
  | (LocalWorkbenchPlanBase & { kind: 'artwork'; scope: 'MB_ONLY'; relationship: 'existing' | 'create-on-apply' })
  | (LocalWorkbenchPlanBase & { kind: 'ai'; scope: 'MB_ONLY'; candidateIds: readonly string[] })
  | (LocalWorkbenchPlanBase & {
      kind: 'cue'; scope: 'INDEPENDENT_OUTPUT'; sourceDisposition: 'retain'
      target: LocalCueOutputTarget; tracks: readonly LocalCueSplitTrack[]
    })
export interface LocalWorkbenchApplyRequest {
  commandId: string
  datasetId: string
  planId: string
  expectedRevision: string
  planHash: string
  contextFingerprint: string
  kind: LocalWorkbenchPlan['kind']
}
export type LocalWorkbenchResultState = 'applied' | 'not-written' | 'failed' | 'unknown' | 'cancelled'
export interface LocalWorkbenchItemResult {
  itemId: string
  albumId: string
  label: string
  state: LocalWorkbenchResultState
  message: string | null
}
export interface LocalWorkbenchReceipt {
  commandId: string
  datasetId: string
  planId: string
  planHash: string
  state: 'succeeded' | 'partial' | 'failed' | 'unknown' | 'running' | 'cancelled'
  items: readonly LocalWorkbenchItemResult[]
  message: string | null
}
export type LocalWorkbenchExistingAction =
  | 'mb-info' | 'source-tags' | 'source-cover' | 'rename' | 'move' | 'organizer-history'
  | 'libraries' | 'scan-settings' | 'ai-settings' | 'scan-history' | 'scan-refresh' | 'finder' | 'lyrics'
export interface LocalWorkbenchOperation {
  request: LocalWorkbenchApplyRequest
  plan: LocalWorkbenchPlan
  receipt: LocalWorkbenchReceipt | null
  state: LocalWorkbenchReceipt['state']
}

export const LOCAL_WORKBENCH_MAX_ALBUMS = 100
export const LOCAL_WORKBENCH_MAX_ITEMS = 9900
export const LOCAL_WORKBENCH_IMAGE_INPUT_BYTES = 4 * 1024 * 1024
export const LOCAL_WORKBENCH_READBACK_BYTES = 2 * 1024 * 1024
export const LOCAL_WORKBENCH_CAPABILITIES = [
  'read', 'artwork-local', 'artwork-search', 'artwork-file', 'artwork-drop', 'artwork-preview',
  'ai-preview', 'cue-preview', 'apply', 'receipt', 'cancel-application', 'existing-actions',
] as const satisfies readonly LocalWorkbenchCapability[]
export const LOCAL_WORKBENCH_EXISTING_ACTIONS = [
  'mb-info', 'source-tags', 'source-cover', 'rename', 'move', 'organizer-history',
  'libraries', 'scan-settings', 'ai-settings', 'scan-history', 'scan-refresh', 'finder', 'lyrics',
] as const satisfies readonly LocalWorkbenchExistingAction[]

export interface LocalWorkbenchReadRequest { albums: readonly LocalWorkbenchAlbumRef[] }
export interface LocalWorkbenchArtworkRequest { datasetId: string; capture: LocalWorkbenchCapture }
export type LocalWorkbenchWebAction = 'navigate' | 'refresh' | 'external'
export interface LocalWorkbenchWebActions { navigate: LocalWorkbenchAvailability; refresh: LocalWorkbenchAvailability; external: LocalWorkbenchAvailability }
export interface LocalWorkbenchArtworkSearchRequest extends LocalWorkbenchArtworkRequest { query: string; sourceId: string; country?: string; webAction?: LocalWorkbenchWebAction }
export interface LocalWorkbenchArtworkSourceOutcome {
  source: 'douban' | 'itunes' | 'web'; country: string | null
  status: 'ready' | 'failed' | 'opened'; candidateCount: number; previewFailureCount: number
  truncated: boolean; message: string | null
}
export interface LocalWorkbenchArtworkSearchReply {
  candidates: readonly LocalWorkbenchArtworkCandidate[]
  sources: readonly LocalWorkbenchArtworkSourceOutcome[]
}
/** text只接用户明确拖入/粘贴的图片data URI或HTTPS地址，由Main受控规范化；不作为文件许可。 */
export type LocalWorkbenchArtworkImportRequest = LocalWorkbenchArtworkRequest & ({ bytes: Uint8Array; mime: string; label: string }
  | { text: string; label: string; webCaptureId?: string } | { webCaptureId: string; label: string })
export interface LocalWorkbenchArtworkPreviewRequest extends LocalWorkbenchArtworkRequest { candidateId: string }
export interface LocalWorkbenchAiRequest extends LocalWorkbenchArtworkRequest { backend: LocalAiBackend }
export interface LocalWorkbenchAiCandidatesReply { albumId: string; candidates: readonly LocalAiNameCandidate[] }
export interface LocalWorkbenchAiPreviewRequest {
  datasetId: string; captures: readonly LocalWorkbenchCapture[]
  selections: readonly { albumId: string; candidateId: string }[]
}
export interface LocalWorkbenchCancelRequest { original: LocalWorkbenchApplyRequest; cancelCommandId: string }
export interface LocalWorkbenchExistingRequest { action: LocalWorkbenchExistingAction; albums: readonly LocalWorkbenchAlbumRef[] }
export type LocalWorkbenchExistingReply = { opened: true } | { opened: false; reason: string }
export interface LocalWorkbenchCapabilitiesReply {
  capabilities: Partial<Record<LocalWorkbenchCapability, LocalWorkbenchAvailability>>
  artworkSources: readonly LocalArtworkSearchSource[]
  artworkImportFormats: readonly LocalArtworkImportFormat[]
  aiBackends: readonly LocalAiBackendOption[]
  cueFormats: readonly LocalCueOutputFormat[]
  existingActions: Partial<Record<LocalWorkbenchExistingAction, LocalWorkbenchAvailability>>
}

/** 公开输入只有不透明身份/候选/目标引用；端点、路径、凭据、FD、源写grant不在此合同中。 */
export const LOCAL_WORKBENCH_COMMANDS = [
  'localWorkbench.capabilities', 'localWorkbench.read', 'localWorkbench.artwork.local', 'localWorkbench.artwork.search',
  'localWorkbench.artwork.file', 'localWorkbench.artwork.import', 'localWorkbench.artwork.preview',
  'localWorkbench.ai.suggest', 'localWorkbench.ai.preview', 'localWorkbench.cue.target', 'localWorkbench.cue.preview',
  'localWorkbench.plan.apply', 'localWorkbench.plan.receipt', 'localWorkbench.plan.cancel', 'localWorkbench.existing.open',
] as const
export type LocalWorkbenchCommand = typeof LOCAL_WORKBENCH_COMMANDS[number]
export interface LocalWorkbenchCommandPayloads {
  'localWorkbench.capabilities': Record<string, never>
  'localWorkbench.read': LocalWorkbenchReadRequest
  'localWorkbench.artwork.local': LocalWorkbenchArtworkRequest
  'localWorkbench.artwork.search': LocalWorkbenchArtworkSearchRequest
  'localWorkbench.artwork.file': LocalWorkbenchArtworkRequest
  'localWorkbench.artwork.import': LocalWorkbenchArtworkImportRequest
  'localWorkbench.artwork.preview': LocalWorkbenchArtworkPreviewRequest
  'localWorkbench.ai.suggest': LocalWorkbenchAiRequest
  'localWorkbench.ai.preview': LocalWorkbenchAiPreviewRequest
  'localWorkbench.cue.target': Record<string, never>
  'localWorkbench.cue.preview': LocalCueSplitInput
  'localWorkbench.plan.apply': LocalWorkbenchApplyRequest
  'localWorkbench.plan.receipt': LocalWorkbenchApplyRequest
  'localWorkbench.plan.cancel': LocalWorkbenchCancelRequest
  'localWorkbench.existing.open': LocalWorkbenchExistingRequest
}
export interface LocalWorkbenchCommandResults {
  'localWorkbench.capabilities': LocalWorkbenchCapabilitiesReply
  'localWorkbench.read': LocalWorkbenchReadback
  'localWorkbench.artwork.local': readonly LocalWorkbenchArtworkCandidate[]
  'localWorkbench.artwork.search': LocalWorkbenchArtworkSearchReply
  'localWorkbench.artwork.file': LocalWorkbenchArtworkCandidate | null
  'localWorkbench.artwork.import': LocalWorkbenchArtworkCandidate
  'localWorkbench.artwork.preview': Extract<LocalWorkbenchPlan, { kind: 'artwork' }>
  'localWorkbench.ai.suggest': LocalWorkbenchAiCandidatesReply
  'localWorkbench.ai.preview': Extract<LocalWorkbenchPlan, { kind: 'ai' }>
  'localWorkbench.cue.target': LocalCueOutputTarget | null
  'localWorkbench.cue.preview': Extract<LocalWorkbenchPlan, { kind: 'cue' }>
  'localWorkbench.plan.apply': LocalWorkbenchReceipt
  'localWorkbench.plan.receipt': LocalWorkbenchReceipt | null
  'localWorkbench.plan.cancel': LocalWorkbenchReceipt
  'localWorkbench.existing.open': LocalWorkbenchExistingReply
}
/** 只取消读取/候选/建议/预览；应用、原回执、任务取消及委托入口始终使用原独立协议。 */
export const LOCAL_WORKBENCH_READ_COMMANDS = [
  'localWorkbench.capabilities', 'localWorkbench.read', 'localWorkbench.artwork.local', 'localWorkbench.artwork.search',
  'localWorkbench.artwork.file', 'localWorkbench.artwork.import', 'localWorkbench.artwork.preview',
  'localWorkbench.ai.suggest', 'localWorkbench.ai.preview', 'localWorkbench.cue.target', 'localWorkbench.cue.preview',
] as const satisfies readonly LocalWorkbenchCommand[]
export type LocalWorkbenchReadCommand = typeof LOCAL_WORKBENCH_READ_COMMANDS[number]
export type LocalWorkbenchReadRequestEnvelope<K extends LocalWorkbenchReadCommand = LocalWorkbenchReadCommand> = {
  [C in K]: { requestId: string; command: C; payload: LocalWorkbenchCommandPayloads[C] }
}[K]
export interface LocalWorkbenchCancelReadRequest { requestId: string }
/** cancelled只确认Main已记录读取取消，不承诺原生选择器已关闭或Promise已收口。 */
export interface LocalWorkbenchCancelReadReply { cancelled: boolean }
export interface LocalWorkbenchPublicApi {
  requestLocalWorkbenchRead<K extends LocalWorkbenchReadCommand>(request: LocalWorkbenchReadRequestEnvelope<K>): Promise<LocalWorkbenchCommandResults[K]>
  cancelLocalWorkbenchRead(request: LocalWorkbenchCancelReadRequest): Promise<LocalWorkbenchCancelReadReply>
  localWorkbenchCapabilities(): Promise<LocalWorkbenchCapabilitiesReply>
  readLocalWorkbenchAlbums(request: LocalWorkbenchReadRequest): Promise<LocalWorkbenchReadback>
  findLocalWorkbenchArtwork(request: LocalWorkbenchArtworkRequest): Promise<readonly LocalWorkbenchArtworkCandidate[]>
  searchLocalWorkbenchArtwork(request: LocalWorkbenchArtworkSearchRequest): Promise<LocalWorkbenchArtworkSearchReply>
  chooseLocalWorkbenchArtwork(request: LocalWorkbenchArtworkRequest): Promise<LocalWorkbenchArtworkCandidate | null>
  importLocalWorkbenchArtwork(request: LocalWorkbenchArtworkImportRequest): Promise<LocalWorkbenchArtworkCandidate>
  previewLocalWorkbenchArtwork(request: LocalWorkbenchArtworkPreviewRequest): Promise<Extract<LocalWorkbenchPlan, { kind: 'artwork' }>>
  suggestLocalWorkbenchNames(request: LocalWorkbenchAiRequest): Promise<LocalWorkbenchAiCandidatesReply>
  previewLocalWorkbenchNames(request: LocalWorkbenchAiPreviewRequest): Promise<Extract<LocalWorkbenchPlan, { kind: 'ai' }>>
  chooseLocalWorkbenchCueTarget(): Promise<LocalCueOutputTarget | null>
  previewLocalWorkbenchCue(request: LocalCueSplitInput): Promise<Extract<LocalWorkbenchPlan, { kind: 'cue' }>>
  applyLocalWorkbenchPlan(request: LocalWorkbenchApplyRequest): Promise<LocalWorkbenchReceipt>
  readLocalWorkbenchReceipt(request: LocalWorkbenchApplyRequest): Promise<LocalWorkbenchReceipt | null>
  cancelLocalWorkbenchPlan(request: LocalWorkbenchCancelRequest): Promise<LocalWorkbenchReceipt>
  openLocalWorkbenchExisting(request: LocalWorkbenchExistingRequest): Promise<LocalWorkbenchExistingReply>
}

/** 闭集检查先核描述符；拒绝getter、隐藏键、符号键、自定义原型，不通过拷贝抹掉未知授权字段。 */
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  return required.every(key => Object.hasOwn(descriptors, key)) && keys.every(key => typeof key === 'string'
    && [...required, ...optional].includes(key) && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))
}
function dense(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === 'length' || typeof key === 'string'
    && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))
}
export function isLocalWorkbenchIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,4095}$/u.test(value)
}
export function isLocalWorkbenchText(value: unknown, empty = false, max = 2048): value is string {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0)
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value) && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)
}
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const backend = (value: unknown): value is LocalAiBackend => value === 'ollama' || value === 'vllm' || value === 'cloud'
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && a.every(item => b.includes(item))
const idList = (value: unknown, max: number, min = 0): value is string[] => dense(value, max) && value.length >= min && value.every(isLocalWorkbenchIdentity) && new Set(value).size === value.length
function bounded(value: unknown, max = 8 * 1024 * 1024): boolean { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= max } catch { return false } }
export function isLocalWorkbenchAvailability(value: unknown): value is LocalWorkbenchAvailability {
  return closed(value, ['available']) && value.available === true || closed(value, ['available', 'reason']) && value.available === false && isLocalWorkbenchText(value.reason)
}
export function isLocalWorkbenchAlbumRef(value: unknown): value is LocalWorkbenchAlbumRef {
  return closed(value, ['albumId', 'title', 'artist', 'trackIds'], ['rootId', 'directoryId', 'editionId', 'trackCount', 'revision'])
    && isLocalWorkbenchIdentity(value.albumId) && isLocalWorkbenchText(value.title, true) && isLocalWorkbenchText(value.artist, true)
    && idList(value.trackIds, 10000) && ['rootId', 'directoryId', 'editionId'].every(key => !Object.hasOwn(value, key) || isLocalWorkbenchIdentity(value[key]))
    && (!Object.hasOwn(value, 'trackCount') || integer(value.trackCount)) && (!Object.hasOwn(value, 'revision') || isLocalWorkbenchIdentity(value.revision))
}
export function isLocalWorkbenchCapture(value: unknown): value is LocalWorkbenchCapture {
  return closed(value, ['albumId', 'readToken']) && isLocalWorkbenchIdentity(value.albumId) && isLocalWorkbenchIdentity(value.readToken)
}
export function isLocalWorkbenchReadRequest(value: unknown): value is LocalWorkbenchReadRequest {
  return closed(value, ['albums']) && dense(value.albums, LOCAL_WORKBENCH_MAX_ALBUMS) && value.albums.length > 0
    && value.albums.every(isLocalWorkbenchAlbumRef) && new Set(value.albums.map(item => item.albumId)).size === value.albums.length && bounded(value)
}
export function isLocalWorkbenchPreviewImage(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length <= 1_500_000 && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
}
export function isLocalWorkbenchArtworkCandidate(value: unknown, albumId?: string): value is LocalWorkbenchArtworkCandidate {
  return closed(value, ['candidateId', 'albumId', 'label', 'origin', 'sourceLabel', 'previewUrl', 'width', 'height', 'licenseLabel'], ['reason'])
    && isLocalWorkbenchIdentity(value.candidateId) && isLocalWorkbenchIdentity(value.albumId) && (albumId === undefined || value.albumId === albumId)
    && isLocalWorkbenchText(value.label) && ['local-independent', 'embedded', 'manual', 'provider'].includes(String(value.origin))
    && isLocalWorkbenchText(value.sourceLabel) && isLocalWorkbenchText(value.licenseLabel) && isLocalWorkbenchPreviewImage(value.previewUrl)
    && integer(value.width, 1, 4096) && integer(value.height, 1, 4096) && value.width * value.height <= 16 * 1024 * 1024
    && (!Object.hasOwn(value, 'reason') || isLocalWorkbenchText(value.reason))
}
export function isLocalWorkbenchFieldChange(value: unknown): value is LocalWorkbenchFieldChange {
  return closed(value, ['field', 'before', 'after', 'reason']) && ['title', 'artist', 'album', 'year', 'disc', 'track'].includes(String(value.field))
    && (value.before === null || isLocalWorkbenchText(value.before, true)) && (value.after === null || isLocalWorkbenchText(value.after, true)) && isLocalWorkbenchText(value.reason)
}
const changes = (value: unknown): value is LocalWorkbenchFieldChange[] => dense(value, 6) && value.every(isLocalWorkbenchFieldChange) && new Set(value.map(item => item.field)).size === value.length
export function isLocalAiNameCandidate(value: unknown, albumId?: string): value is LocalAiNameCandidate {
  return closed(value, ['candidateId', 'albumId', 'title', 'artist', 'reason', 'changes']) && isLocalWorkbenchIdentity(value.candidateId)
    && isLocalWorkbenchIdentity(value.albumId) && (albumId === undefined || value.albumId === albumId) && isLocalWorkbenchText(value.title)
    && isLocalWorkbenchText(value.artist) && isLocalWorkbenchText(value.reason) && changes(value.changes) && value.changes.length > 0
    && value.changes.every(change => change.field === 'artist' && change.after === value.artist || change.field === 'album' && change.after === value.title)
}
export function isLocalCueOutputTarget(value: unknown): value is LocalCueOutputTarget {
  return closed(value, ['choiceId', 'label', 'independent']) && isLocalWorkbenchIdentity(value.choiceId) && isLocalWorkbenchText(value.label) && value.independent === true
}
function planItem(value: unknown): value is LocalWorkbenchPlanItem {
  return closed(value, ['itemId', 'albumId', 'label', 'changes']) && isLocalWorkbenchIdentity(value.itemId) && isLocalWorkbenchIdentity(value.albumId) && isLocalWorkbenchText(value.label) && changes(value.changes)
}
function cueTrack(value: unknown): value is LocalCueSplitTrack {
  return closed(value, ['itemId', 'albumId', 'label', 'changes', 'sequence', 'sourceLabel', 'startFrame', 'frameCount', 'sampleRate', 'outputName', 'outputFormat'])
    && isLocalWorkbenchIdentity(value.itemId) && isLocalWorkbenchIdentity(value.albumId) && isLocalWorkbenchText(value.label) && changes(value.changes)
    && integer(value.sequence, 1, 99) && isLocalWorkbenchText(value.sourceLabel) && integer(value.startFrame) && integer(value.frameCount, 1)
    && integer(value.sampleRate, 1, 768000) && Number.isSafeInteger(value.startFrame + value.frameCount)
    && isLocalWorkbenchText(value.outputName, false, 512) && !/[\\/:]/u.test(value.outputName) && value.outputName !== '.' && value.outputName !== '..'
    && isLocalWorkbenchIdentity(value.outputFormat)
}
export function isLocalWorkbenchPlan(value: unknown): value is LocalWorkbenchPlan {
  const base = ['kind', 'scope', 'datasetId', 'planId', 'revision', 'planHash', 'contextFingerprint', 'expiresAt', 'albumIds', 'state', 'blockers', 'items']
  if (!closed(value, base, ['relationship', 'candidateIds', 'sourceDisposition', 'target', 'tracks'])) return false
  const variant = value.kind === 'artwork' ? ['relationship'] : value.kind === 'ai' ? ['candidateIds'] : value.kind === 'cue' ? ['sourceDisposition', 'target', 'tracks'] : null
  if (!variant || !closed(value, [...base, ...variant])) return false
  if (!isLocalWorkbenchIdentity(value.datasetId) || !isLocalWorkbenchIdentity(value.planId) || !isLocalWorkbenchIdentity(value.revision)
    || !hash(value.planHash) || !hash(value.contextFingerprint) || !isLocalWorkbenchText(value.expiresAt, false, 32)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))
    || !idList(value.albumIds, LOCAL_WORKBENCH_MAX_ALBUMS, 1) || !['ready', 'blocked'].includes(String(value.state))
    || !dense(value.blockers, 1000) || !value.blockers.every(item => isLocalWorkbenchText(item)) || value.state === 'ready' && value.blockers.length !== 0
    || !dense(value.items, LOCAL_WORKBENCH_MAX_ITEMS) || !value.items.length || !value.items.every(planItem)
    || new Set(value.items.map(item => item.itemId)).size !== value.items.length
    || !same([...new Set(value.items.map(item => item.albumId))], value.albumIds) || !bounded(value)) return false
  if (value.kind === 'artwork') return value.scope === 'MB_ONLY' && ['existing', 'create-on-apply'].includes(String(value.relationship))
  if (value.kind === 'ai') return value.scope === 'MB_ONLY' && idList(value.candidateIds, LOCAL_WORKBENCH_MAX_ALBUMS, 1)
    && value.candidateIds.length === value.albumIds.length && value.items.every(item => item.changes.length > 0 && item.changes.every(change => change.field === 'artist' || change.field === 'album'))
  if (value.scope !== 'INDEPENDENT_OUTPUT' || value.sourceDisposition !== 'retain' || !isLocalCueOutputTarget(value.target)
    || !dense(value.tracks, LOCAL_WORKBENCH_MAX_ITEMS) || !value.tracks.every(cueTrack) || value.tracks.length !== value.items.length
    || !same(value.tracks.map(track => track.itemId), value.items.map(item => item.itemId))) return false
  const items = value.items
  return value.tracks.every(track => items.some(item => item.itemId === track.itemId && item.albumId === track.albumId && item.label === track.label
    && JSON.stringify(item.changes) === JSON.stringify(track.changes)))
    && new Set(value.tracks.map(track => JSON.stringify([track.albumId, track.sequence]))).size === value.tracks.length
    && new Set(value.tracks.map(track => JSON.stringify([track.albumId, track.outputName]))).size === value.tracks.length
}
export function isLocalWorkbenchApplyRequest(value: unknown): value is LocalWorkbenchApplyRequest {
  return closed(value, ['commandId', 'datasetId', 'planId', 'expectedRevision', 'planHash', 'contextFingerprint', 'kind'])
    && ['commandId', 'datasetId', 'planId', 'expectedRevision'].every(key => isLocalWorkbenchIdentity(value[key]))
    && hash(value.planHash) && hash(value.contextFingerprint) && ['artwork', 'ai', 'cue'].includes(String(value.kind))
}
export function isLocalWorkbenchReceipt(value: unknown, request?: LocalWorkbenchApplyRequest, plan?: LocalWorkbenchPlan): value is LocalWorkbenchReceipt {
  if (!closed(value, ['commandId', 'datasetId', 'planId', 'planHash', 'state', 'items', 'message'])
    || !['commandId', 'datasetId', 'planId'].every(key => isLocalWorkbenchIdentity(value[key])) || !hash(value.planHash)
    || !['succeeded', 'partial', 'failed', 'unknown', 'running', 'cancelled'].includes(String(value.state))
    || value.message !== null && !isLocalWorkbenchText(value.message) || !dense(value.items, LOCAL_WORKBENCH_MAX_ITEMS) || !value.items.length) return false
  if (!value.items.every(item => closed(item, ['itemId', 'albumId', 'label', 'state', 'message']) && isLocalWorkbenchIdentity(item.itemId)
    && isLocalWorkbenchIdentity(item.albumId) && isLocalWorkbenchText(item.label) && ['applied', 'not-written', 'failed', 'unknown', 'cancelled'].includes(String(item.state))
    && (item.message === null || isLocalWorkbenchText(item.message))) || new Set(value.items.map(item => (item as LocalWorkbenchItemResult).itemId)).size !== value.items.length) return false
  const items = value.items as unknown as LocalWorkbenchItemResult[]
  return (request === undefined || value.commandId === request.commandId && value.datasetId === request.datasetId && value.planId === request.planId && value.planHash === request.planHash)
    && (plan === undefined || same(items.map(item => item.itemId), plan.items.map(item => item.itemId))
      && items.every(item => plan.items.some(expected => expected.itemId === item.itemId && expected.albumId === item.albumId)))
    && (value.state !== 'succeeded' || items.every(item => item.state === 'applied')) && bounded(value)
}
/** 通用原操作回显；读取回复另限定pending状态，原registry终态列表仍可严格验证。 */
export function isLocalWorkbenchOperation(value: unknown, datasetId?: string): value is LocalWorkbenchOperation {
  if (!closed(value, ['request', 'plan', 'receipt', 'state']) || !isLocalWorkbenchApplyRequest(value.request)
    || !isLocalWorkbenchPlan(value.plan)) return false
  const request = value.request, plan = value.plan
  if (datasetId !== undefined && request.datasetId !== datasetId || request.datasetId !== plan.datasetId
    || request.planId !== plan.planId || request.expectedRevision !== plan.revision || request.planHash !== plan.planHash
    || request.contextFingerprint !== plan.contextFingerprint || request.kind !== plan.kind) return false
  if (value.receipt === null) return value.state === 'unknown' && bounded(value)
  if (!isLocalWorkbenchReceipt(value.receipt, request, plan)
    || value.receipt.items.some(item => !plan.items.some(expected => expected.itemId === item.itemId && expected.label === item.label))) return false
  const state = value.receipt.state === 'running' ? 'running' : value.receipt.items.some(item => item.state === 'unknown') ? 'unknown' : value.receipt.state
  return value.state === state && bounded(value)
}
export function isLocalWorkbenchReadback(value: unknown, request?: LocalWorkbenchReadRequest): value is LocalWorkbenchReadback {
  if (!closed(value, ['datasetId', 'snapshotId', 'albums'], ['settings', 'pendingOperations']) || !isLocalWorkbenchIdentity(value.datasetId) || !isLocalWorkbenchIdentity(value.snapshotId)
    || !dense(value.albums, LOCAL_WORKBENCH_MAX_ALBUMS) || !value.albums.length) return false
  if (Object.hasOwn(value, 'pendingOperations')) {
    const datasetId = value.datasetId, operations = value.pendingOperations
    if (!dense(operations, 100) || !operations.every((operation): operation is LocalWorkbenchOperation => isLocalWorkbenchOperation(operation, datasetId)
      && (operation.state === 'unknown' || operation.state === 'running'))
      || new Set(operations.map(operation => operation.request.commandId)).size !== operations.length
      || new Set(operations.map(operation => operation.plan.planId)).size !== operations.length) return false
  }
  if (!value.albums.every(item => closed(item, ['album', 'capture', 'availability', 'issues', 'currentArtwork', 'cueSheets'], ['searchNames']) && isLocalWorkbenchAlbumRef(item.album)
    && isLocalWorkbenchCapture(item.capture) && item.capture.albumId === item.album.albumId && ['online', 'offline', 'unavailable'].includes(String(item.availability))
    && dense(item.issues, 1000) && item.issues.every(issue => isLocalWorkbenchText(issue))
    && (item.currentArtwork === null || closed(item.currentArtwork, ['label', 'previewUrl']) && isLocalWorkbenchText(item.currentArtwork.label) && isLocalWorkbenchPreviewImage(item.currentArtwork.previewUrl))
    && (!Object.hasOwn(item,'searchNames') || closed(item.searchNames,['original','cleaned'])
      && [item.searchNames.original,item.searchNames.cleaned].every(names=>closed(names,['artist','title']) && isLocalWorkbenchText(names.artist,true) && isLocalWorkbenchText(names.title,true)))
    && dense(item.cueSheets, 100) && item.cueSheets.every(cue => closed(cue, ['cueId', 'label', 'eligible'], ['reason']) && isLocalWorkbenchIdentity(cue.cueId)
      && isLocalWorkbenchText(cue.label) && typeof cue.eligible === 'boolean' && (!Object.hasOwn(cue, 'reason') || isLocalWorkbenchText(cue.reason)))
    && new Set(item.cueSheets.map(cue => (cue as LocalWorkbenchCueRef).cueId)).size === item.cueSheets.length)) return false
  const albums = value.albums as unknown as LocalWorkbenchAlbumSnapshot[]
  return new Set(albums.map(item => item.album.albumId)).size === albums.length
    && (request === undefined || same(albums.map(item => item.album.albumId), request.albums.map(item => item.albumId))
      && albums.every(item => request.albums.some(expected => expected.albumId === item.album.albumId && same(expected.trackIds, item.album.trackIds))))
    && (!Object.hasOwn(value, 'settings') || closed(value.settings, ['scanConcurrency', 'aiBackend', 'aiModelLabel']) && integer(value.settings.scanConcurrency, 1, 24)
      && backend(value.settings.aiBackend) && isLocalWorkbenchText(value.settings.aiModelLabel, true)) && bounded(value, LOCAL_WORKBENCH_READBACK_BYTES)
}
const captures = (value: unknown): value is LocalWorkbenchCapture[] => dense(value, LOCAL_WORKBENCH_MAX_ALBUMS) && value.length > 0
  && value.every(isLocalWorkbenchCapture) && new Set(value.map(item => item.albumId)).size === value.length
function artworkRequest(value: unknown, extra: readonly string[] = [], optional: readonly string[] = []): value is Record<string, unknown> & LocalWorkbenchArtworkRequest {
  return closed(value, ['datasetId', 'capture', ...extra], optional) && isLocalWorkbenchIdentity(value.datasetId) && isLocalWorkbenchCapture(value.capture)
}
export function isLocalWorkbenchAiPreviewRequest(value: unknown): value is LocalWorkbenchAiPreviewRequest {
  return closed(value, ['datasetId', 'captures', 'selections']) && isLocalWorkbenchIdentity(value.datasetId) && captures(value.captures)
    && dense(value.selections, LOCAL_WORKBENCH_MAX_ALBUMS) && value.selections.length > 0 && value.selections.every(item => closed(item, ['albumId', 'candidateId'])
      && isLocalWorkbenchIdentity(item.albumId) && isLocalWorkbenchIdentity(item.candidateId))
    && same(value.captures.map(item => item.albumId), value.selections.map(item => (item as { albumId: string }).albumId))
    && new Set(value.selections.map(item => (item as { candidateId: string }).candidateId)).size === value.selections.length
}
export function isLocalCueSplitInput(value: unknown): value is LocalCueSplitInput {
  return closed(value, ['datasetId', 'captures', 'cueSelections', 'outputFormat', 'target', 'sourceDisposition']) && isLocalWorkbenchIdentity(value.datasetId)
    && captures(value.captures) && dense(value.cueSelections, LOCAL_WORKBENCH_MAX_ALBUMS) && value.cueSelections.length > 0
    && value.cueSelections.every(item => closed(item, ['albumId', 'cueId']) && isLocalWorkbenchIdentity(item.albumId) && isLocalWorkbenchIdentity(item.cueId))
    && same(value.captures.map(item => item.albumId), value.cueSelections.map(item => (item as { albumId: string }).albumId))
    && isLocalWorkbenchIdentity(value.outputFormat) && isLocalCueOutputTarget(value.target) && value.sourceDisposition === 'retain'
}
function capabilityMap(value: unknown, keys: readonly string[]): boolean { return closed(value, [], keys) && Object.values(value).every(isLocalWorkbenchAvailability) }
export function isLocalWorkbenchCapabilitiesReply(value: unknown): value is LocalWorkbenchCapabilitiesReply {
  return closed(value, ['capabilities', 'artworkSources', 'artworkImportFormats', 'aiBackends', 'cueFormats', 'existingActions'])
    && capabilityMap(value.capabilities, LOCAL_WORKBENCH_CAPABILITIES) && capabilityMap(value.existingActions, LOCAL_WORKBENCH_EXISTING_ACTIONS)
    && dense(value.artworkSources, 32) && value.artworkSources.every(item => closed(item, ['id', 'label', 'kind', 'availability'], ['webActions']) && isLocalWorkbenchIdentity(item.id)
      && isLocalWorkbenchText(item.label) && ['aggregate', 'provider', 'web'].includes(String(item.kind)) && isLocalWorkbenchAvailability(item.availability)
      && (!Object.hasOwn(item, 'webActions') || item.kind === 'web' && closed(item.webActions, ['navigate', 'refresh', 'external'])
        && isLocalWorkbenchAvailability(item.webActions.navigate) && isLocalWorkbenchAvailability(item.webActions.refresh) && isLocalWorkbenchAvailability(item.webActions.external)))
    && new Set(value.artworkSources.map(item => (item as LocalArtworkSearchSource).id)).size === value.artworkSources.length
    && dense(value.artworkImportFormats, 16) && value.artworkImportFormats.every(item => closed(item, ['mime', 'label', 'availability']) && typeof item.mime === 'string'
      && /^image\/(?:jpeg|png|tiff|webp|gif|heic|heif|bmp)$/u.test(item.mime) && isLocalWorkbenchText(item.label) && isLocalWorkbenchAvailability(item.availability))
    && new Set(value.artworkImportFormats.map(item => (item as LocalArtworkImportFormat).mime)).size === value.artworkImportFormats.length
    && dense(value.aiBackends, 3) && value.aiBackends.every(item => closed(item, ['id', 'label', 'availability']) && backend(item.id) && isLocalWorkbenchText(item.label) && isLocalWorkbenchAvailability(item.availability))
    && new Set(value.aiBackends.map(item => (item as LocalAiBackendOption).id)).size === value.aiBackends.length
    && dense(value.cueFormats, 32) && value.cueFormats.every(item => closed(item, ['id', 'label', 'availability']) && isLocalWorkbenchIdentity(item.id) && isLocalWorkbenchText(item.label) && isLocalWorkbenchAvailability(item.availability))
    && new Set(value.cueFormats.map(item => (item as LocalCueOutputFormat).id)).size === value.cueFormats.length && bounded(value, 65536)
}
export function isLocalWorkbenchCommand(value: unknown): value is LocalWorkbenchCommand { return (LOCAL_WORKBENCH_COMMANDS as readonly unknown[]).includes(value) }
export function isLocalWorkbenchCommandPayload<K extends LocalWorkbenchCommand>(command: K, value: unknown): value is LocalWorkbenchCommandPayloads[K] {
  switch (command) {
    case 'localWorkbench.capabilities': case 'localWorkbench.cue.target': return closed(value, [])
    case 'localWorkbench.read': return isLocalWorkbenchReadRequest(value)
    case 'localWorkbench.artwork.local': case 'localWorkbench.artwork.file': return artworkRequest(value)
    case 'localWorkbench.artwork.search': return closed(value, ['datasetId', 'capture', 'query', 'sourceId'], ['country', 'webAction'])
      && isLocalWorkbenchIdentity(value.datasetId) && isLocalWorkbenchCapture(value.capture)
      && isLocalWorkbenchText(value.query, false, 256) && value.query.trim().length > 0 && isLocalWorkbenchIdentity(value.sourceId)
      && (!Object.hasOwn(value, 'country') || typeof value.country === 'string' && /^[A-Z]{2}$/u.test(value.country))
      && (!Object.hasOwn(value, 'webAction') || typeof value.webAction === 'string' && ['navigate', 'refresh', 'external'].includes(value.webAction))
    case 'localWorkbench.artwork.import': return artworkRequest(value, ['bytes', 'mime', 'label']) && value.bytes instanceof Uint8Array && Object.getPrototypeOf(value.bytes) === Uint8Array.prototype
      && value.bytes.byteLength > 0 && value.bytes.byteLength <= LOCAL_WORKBENCH_IMAGE_INPUT_BYTES && typeof value.mime === 'string' && /^image\/(?:jpeg|png|tiff|webp|gif|heic|heif|bmp)$/u.test(value.mime) && isLocalWorkbenchText(value.label, false, 512)
      || artworkRequest(value, ['webCaptureId', 'label']) && typeof value.webCaptureId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[1-9]\d{0,5}$/u.test(value.webCaptureId)
      && isLocalWorkbenchText(value.label, false, 512)
      || artworkRequest(value, ['text', 'label'], ['webCaptureId']) && (!Object.hasOwn(value, 'webCaptureId') || typeof value.webCaptureId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[1-9]\d{0,5}$/u.test(value.webCaptureId)) && typeof value.text === 'string' && value.text.length > 0
      && value.text.length <= 4 * Math.ceil(LOCAL_WORKBENCH_IMAGE_INPUT_BYTES / 3) + 128 && !/[\u0000-\u001f\u007f]/u.test(value.text)
      && (/^https:\/\/[^ ]+$/u.test(value.text) && value.text.length <= 4096 || /^data:image\/(?:jpeg|png|tiff|webp|gif|heic|heif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value.text))
      && isLocalWorkbenchText(value.label, false, 512)
    case 'localWorkbench.artwork.preview': return artworkRequest(value, ['candidateId']) && isLocalWorkbenchIdentity(value.candidateId)
    case 'localWorkbench.ai.suggest': return artworkRequest(value, ['backend']) && backend(value.backend)
    case 'localWorkbench.ai.preview': return isLocalWorkbenchAiPreviewRequest(value)
    case 'localWorkbench.cue.preview': return isLocalCueSplitInput(value)
    case 'localWorkbench.plan.apply': case 'localWorkbench.plan.receipt': return isLocalWorkbenchApplyRequest(value)
    case 'localWorkbench.plan.cancel': return closed(value, ['original', 'cancelCommandId']) && isLocalWorkbenchApplyRequest(value.original) && isLocalWorkbenchIdentity(value.cancelCommandId) && value.cancelCommandId !== value.original.commandId
    case 'localWorkbench.existing.open': return closed(value, ['action', 'albums']) && (LOCAL_WORKBENCH_EXISTING_ACTIONS as readonly unknown[]).includes(value.action) && isLocalWorkbenchReadRequest({ albums: value.albums })
  }
  return false
}
export function isLocalWorkbenchCommandResult<K extends LocalWorkbenchCommand>(command: K, value: unknown, request: LocalWorkbenchCommandPayloads[K]): value is LocalWorkbenchCommandResults[K] {
  if (!isLocalWorkbenchCommandPayload(command, request)) return false
  switch (command) {
    case 'localWorkbench.capabilities': return isLocalWorkbenchCapabilitiesReply(value)
    case 'localWorkbench.read': return isLocalWorkbenchReadback(value, request as LocalWorkbenchReadRequest)
    case 'localWorkbench.artwork.local': return dense(value, 100) && value.every(item => isLocalWorkbenchArtworkCandidate(item, (request as LocalWorkbenchArtworkRequest).capture.albumId))
    case 'localWorkbench.artwork.search': return isLocalWorkbenchArtworkSearchReply(value, (request as LocalWorkbenchArtworkRequest).capture.albumId)
    case 'localWorkbench.artwork.file': return value === null || isLocalWorkbenchArtworkCandidate(value, (request as LocalWorkbenchArtworkRequest).capture.albumId)
    case 'localWorkbench.artwork.import': return isLocalWorkbenchArtworkCandidate(value, (request as LocalWorkbenchArtworkRequest).capture.albumId)
    case 'localWorkbench.artwork.preview': return isLocalWorkbenchPlan(value) && value.kind === 'artwork' && value.datasetId === (request as LocalWorkbenchArtworkRequest).datasetId && same(value.albumIds, [(request as LocalWorkbenchArtworkRequest).capture.albumId])
    case 'localWorkbench.ai.suggest': return closed(value, ['albumId', 'candidates']) && value.albumId === (request as LocalWorkbenchAiRequest).capture.albumId && dense(value.candidates, 8) && value.candidates.length > 0
      && value.candidates.every(item => isLocalAiNameCandidate(item, value.albumId as string)) && new Set(value.candidates.map(item => (item as LocalAiNameCandidate).candidateId)).size === value.candidates.length && bounded(value, 65536)
    case 'localWorkbench.ai.preview': return isLocalWorkbenchPlan(value) && value.kind === 'ai' && value.datasetId === (request as LocalWorkbenchAiPreviewRequest).datasetId
      && same(value.albumIds, (request as LocalWorkbenchAiPreviewRequest).selections.map(item => item.albumId)) && same(value.candidateIds, (request as LocalWorkbenchAiPreviewRequest).selections.map(item => item.candidateId))
    case 'localWorkbench.cue.target': return value === null || isLocalCueOutputTarget(value)
    case 'localWorkbench.cue.preview': return isLocalWorkbenchPlan(value) && value.kind === 'cue' && value.datasetId === (request as LocalCueSplitInput).datasetId
      && value.target.choiceId === (request as LocalCueSplitInput).target.choiceId && same(value.albumIds, (request as LocalCueSplitInput).cueSelections.map(item => item.albumId))
    case 'localWorkbench.plan.apply': return isLocalWorkbenchReceipt(value, request as LocalWorkbenchApplyRequest)
    case 'localWorkbench.plan.receipt': return value === null || isLocalWorkbenchReceipt(value, request as LocalWorkbenchApplyRequest)
    case 'localWorkbench.plan.cancel': return isLocalWorkbenchReceipt(value, (request as LocalWorkbenchCancelRequest).original)
    case 'localWorkbench.existing.open': return closed(value, ['opened']) && value.opened === true || closed(value, ['opened', 'reason']) && value.opened === false && isLocalWorkbenchText(value.reason)
  }
  return false
}
export function isLocalWorkbenchReadCommand(value: unknown): value is LocalWorkbenchReadCommand { return (LOCAL_WORKBENCH_READ_COMMANDS as readonly unknown[]).includes(value) }
const readNonce = (value: unknown): value is string => isLocalWorkbenchIdentity(value) && value.length <= 128
export function isLocalWorkbenchReadRequestEnvelope(value: unknown): value is LocalWorkbenchReadRequestEnvelope {
  return closed(value, ['requestId', 'command', 'payload']) && readNonce(value.requestId) && isLocalWorkbenchReadCommand(value.command)
    && isLocalWorkbenchCommandPayload(value.command, value.payload)
}
export function isLocalWorkbenchCancelReadRequest(value: unknown): value is LocalWorkbenchCancelReadRequest {
  return closed(value, ['requestId']) && readNonce(value.requestId)
}
export function isLocalWorkbenchCancelReadReply(value: unknown): value is LocalWorkbenchCancelReadReply {
  return closed(value, ['cancelled']) && typeof value.cancelled === 'boolean'
}
export function isLocalWorkbenchReadResult<K extends LocalWorkbenchReadCommand>(value: unknown, request: LocalWorkbenchReadRequestEnvelope<K>): value is LocalWorkbenchCommandResults[K] {
  return isLocalWorkbenchReadRequestEnvelope(request) && isLocalWorkbenchCommandResult(request.command, value, request.payload)
}

export function isLocalWorkbenchArtworkSearchReply(value: unknown, albumId?: string): value is LocalWorkbenchArtworkSearchReply {
  return closed(value, ['candidates', 'sources']) && dense(value.candidates, 100)
    && value.candidates.every(item => isLocalWorkbenchArtworkCandidate(item, albumId))
    && new Set(value.candidates.map(item => item.candidateId)).size === value.candidates.length
    && dense(value.sources, 2) && value.sources.length > 0
    && value.sources.every(item => closed(item, ['source', 'country', 'status', 'candidateCount', 'previewFailureCount', 'truncated', 'message'])
      && ['douban', 'itunes', 'web'].includes(String(item.source))
      && (item.country === null || typeof item.country === 'string' && /^[A-Z]{2}$/u.test(item.country))
      && ['ready', 'failed', 'opened'].includes(String(item.status)) && integer(item.candidateCount, 0, 100)
      && integer(item.previewFailureCount, 0, 100) && typeof item.truncated === 'boolean'
      && (item.message === null || isLocalWorkbenchText(item.message, false, 1024)))
    && new Set(value.sources.map(item => (item as LocalWorkbenchArtworkSourceOutcome).source)).size === value.sources.length && bounded(value, LOCAL_WORKBENCH_READBACK_BYTES)
}

/** 库管理与配置使用独立有限合同，不接受路径、FD、写许可或通用命令。 */
export type LocalLibraryRole = 'catalog' | 'artist' | 'album' | 'container'
export interface LocalLibraryManagedRoot {
  libraryId: string; label: string; role: LocalLibraryRole; online: boolean; watching: boolean
  latestSnapshotId: string | null; totalAlbums: number; totalTracks: number
  scanState: 'idle' | 'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled' | 'offline'
}
export interface LocalLibraryManagementReadback {
  datasetId: string; revision: string; libraries: readonly LocalLibraryManagedRoot[]; scanConcurrency: number
}
export interface LocalLibraryImportChoice { choiceId: string; label: string; suggestedRole: LocalLibraryRole; evidence: readonly string[] }
export interface LocalLibraryCompleteCapture {
  datasetId: string; captureId: string; libraryIds: readonly string[]; revision: string
  lyricsLibraries: readonly { datasetId: string; libraryId: string; captureId: string }[]
}
export interface LocalLibraryManagementOperation {
  commandId: string; kind: string; state: 'running' | 'succeeded' | 'partial' | 'failed' | 'unknown' | 'cancelled'
  libraryIds: readonly string[]; message: string | null
}
export interface LocalLibraryBatchItem {
  albumId: string; state: 'queued' | 'running' | 'ready' | 'applied' | 'review' | 'failed' | 'unknown' | 'cancelled'
  message: string | null
}
export interface LocalLibraryBatchPage {
  jobId: string; captureId: string; kind: 'ai' | 'cue'
  state: 'queued' | 'running' | 'stopped' | 'complete' | 'partial' | 'unknown' | 'failed'
  totalAlbums: number; processedAlbums: number; succeededAlbums: number; failedAlbums: number
  offset: number; items: readonly LocalLibraryBatchItem[]
  /** 仅单专辑job.read回显原完整捕获的安全引用；不签发新的捕获或写许可。 */
  originalEntry?: LocalLibraryJobOriginalEntry | null
}
export interface LocalLibraryJobOriginalEntry {
  datasetId: string; album: LocalWorkbenchAlbumRef; capture: LocalWorkbenchCapture
}
export const LOCAL_LIBRARY_MANAGEMENT_COMMANDS = [
  'library.read', 'library.import.prepare', 'library.import.confirm', 'library.capture', 'library.album.capture', 'library.albums.capture',
  'library.rename', 'library.remove', 'library.snapshot.load', 'library.snapshot.retry', 'library.operation.read',
  'library.settings.read', 'library.settings.save', 'library.watch.set',
  'library.ai.start', 'library.cue.start', 'library.job.read', 'library.job.stop', 'library.job.resume', 'library.job.retry',
] as const
export type LocalLibraryManagementCommand = typeof LOCAL_LIBRARY_MANAGEMENT_COMMANDS[number]
export interface LocalLibraryManagementPayloads {
  'library.read': Record<string, never>; 'library.import.prepare': Record<string, never>
  'library.import.confirm': { commandId: string; choiceId: string; role: LocalLibraryRole }
  'library.capture': { libraryIds: readonly string[] }
  'library.album.capture': { albumId: string; rootId: string; revision: string }
  'library.albums.capture': { albums: readonly { albumId: string; rootId: string; revision: string }[] }
  'library.rename': { commandId: string; libraryId: string; name: string }
  'library.remove': { commandId: string; libraryIds: readonly string[] }
  'library.snapshot.load': { commandId: string; libraryId: string }
  'library.snapshot.retry': { commandId: string; libraryId: string }
  'library.operation.read': { commandId: string }
  'library.settings.read': Record<string, never>
  'library.settings.save': { commandId: string; scanConcurrency: number }
  'library.watch.set': { commandId: string; libraryId: string; enabled: boolean }
  'library.ai.start': { commandId: string; captureId: string; backend: LocalAiBackend; selection: 'missing-cover' | 'selected'; albumIds: readonly string[] }
  'library.cue.start': { commandId: string; captureId: string; selection: 'all-unsplit' | 'selected'; selections: readonly { albumId: string; cueId: string }[]; outputFormat: string; target: LocalCueOutputTarget }
  'library.job.read': { jobId: string; offset: number; limit: number; albumId?: string }
  'library.job.stop': { jobId: string }; 'library.job.resume': { jobId: string }
  'library.job.retry': { jobId: string; albumIds: readonly string[] }
}
export interface LocalLibraryManagementResults {
  'library.read': LocalLibraryManagementReadback; 'library.import.prepare': LocalLibraryImportChoice | null
  'library.import.confirm': LocalLibraryManagementOperation; 'library.capture': LocalLibraryCompleteCapture
  'library.album.capture': LocalWorkbenchReadback
  'library.albums.capture': LocalWorkbenchReadback
  'library.rename': LocalLibraryManagementOperation; 'library.remove': LocalLibraryManagementOperation
  'library.snapshot.load': LocalLibraryManagementOperation; 'library.snapshot.retry': LocalLibraryManagementOperation
  'library.operation.read': LocalLibraryManagementOperation | null
  'library.settings.read': { scanConcurrency: number; revision: string }
  'library.settings.save': LocalLibraryManagementOperation; 'library.watch.set': LocalLibraryManagementOperation
  'library.ai.start': LocalLibraryBatchPage; 'library.cue.start': LocalLibraryBatchPage
  'library.job.read': LocalLibraryBatchPage | null; 'library.job.stop': LocalLibraryBatchPage
  'library.job.resume': LocalLibraryBatchPage; 'library.job.retry': LocalLibraryBatchPage
}
/** 仅Main受信管理方法内取消临时目录；不进入Owner原20/39命令表。 */
export type LocalLibraryManagementMainCommand = LocalLibraryManagementCommand | 'library.import.cancel'
export interface LocalLibraryManagementMainPayloads extends LocalLibraryManagementPayloads {
  'library.import.cancel': { choiceId: string }
}
export interface LocalLibraryManagementMainResults extends LocalLibraryManagementResults {
  'library.import.cancel': { choiceId: string; released: boolean }
}
export function isLocalLibraryManagementMainCommand(value: unknown): value is LocalLibraryManagementMainCommand {
  return value === 'library.import.cancel' || isLocalLibraryManagementCommand(value)
}
export function isLocalLibraryManagementMainPayload<C extends LocalLibraryManagementMainCommand>(command: C, value: unknown): value is LocalLibraryManagementMainPayloads[C] {
  try {
    if (command === 'library.import.cancel') return closed(value, ['choiceId']) && isLocalWorkbenchIdentity(value.choiceId) && bounded(value, 128 * 1024)
    return isLocalLibraryManagementPayload(command as LocalLibraryManagementCommand, value)
  } catch { return false }
}
export function isLocalLibraryManagementMainResult<C extends LocalLibraryManagementMainCommand>(command: C, value: unknown, request: LocalLibraryManagementMainPayloads[C]): value is LocalLibraryManagementMainResults[C] {
  try {
    if (command === 'library.import.cancel') return isLocalLibraryManagementMainPayload(command, request)
      && closed(value, ['choiceId', 'released']) && value.choiceId === (request as LocalLibraryManagementMainPayloads['library.import.cancel']).choiceId
      && typeof value.released === 'boolean' && bounded(value, 128 * 1024)
    return isLocalLibraryManagementResult(command as LocalLibraryManagementCommand, value, request as LocalLibraryManagementPayloads[LocalLibraryManagementCommand])
  } catch { return false }
}
export interface LocalNameModelSettings { endpoint: string; model: string }
export interface LocalNameSettings {
  revision: string; backend: LocalAiBackend; ollama: LocalNameModelSettings; vllm: LocalNameModelSettings
  cloud: LocalNameModelSettings & { keyConfigured: boolean }
}
export interface LocalNameSettingsInput {
  expectedRevision: string; backend: LocalAiBackend; ollama: LocalNameModelSettings; vllm: LocalNameModelSettings; cloud: LocalNameModelSettings
}
export const LOCAL_NAME_SETTINGS_COMMANDS = ['name.settings.read', 'name.settings.save', 'name.settings.securityPrompt'] as const
export type LocalNameSettingsCommand = typeof LOCAL_NAME_SETTINGS_COMMANDS[number]
export interface LocalNameSettingsPayloads {
  'name.settings.read': Record<string, never>
  'name.settings.save': { commandId: string; settings: LocalNameSettingsInput }
  'name.settings.securityPrompt': { commandId: string; backend: 'cloud' }
}
export interface LocalNameSettingsResults {
  'name.settings.read': LocalNameSettings; 'name.settings.save': LocalNameSettings
  'name.settings.securityPrompt': { configured: boolean; cancelled: boolean }
}
export interface LocalWorkbenchPublicApi {
  localLibraryManagement<C extends LocalLibraryManagementMainCommand>(command: C, payload: LocalLibraryManagementMainPayloads[C]): Promise<LocalLibraryManagementMainResults[C]>
  localNameSettings<C extends LocalNameSettingsCommand>(command: C, payload: LocalNameSettingsPayloads[C]): Promise<LocalNameSettingsResults[C]>
}
export function isLocalLibraryManagementPayload<C extends LocalLibraryManagementCommand>(command: C, value: unknown): value is LocalLibraryManagementPayloads[C] {
  try {
    switch (command) {
      case 'library.read': case 'library.import.prepare': case 'library.settings.read': return closed(value, [])
      case 'library.import.confirm': return closed(value, ['commandId', 'choiceId', 'role']) && isLocalWorkbenchIdentity(value.commandId) && isLocalWorkbenchIdentity(value.choiceId) && typeof value.role === 'string' && ['catalog', 'artist', 'album', 'container'].includes(value.role)
      case 'library.capture': return closed(value, ['libraryIds']) && idList(value.libraryIds, 10000, 1) && bounded(value, 128 * 1024)
      case 'library.album.capture': return closed(value, ['albumId', 'rootId', 'revision']) && isLocalWorkbenchIdentity(value.albumId)
        && isLocalWorkbenchIdentity(value.rootId) && isLocalWorkbenchIdentity(value.revision)
      case 'library.albums.capture': return closed(value, ['albums']) && dense(value.albums, 100) && value.albums.length > 0
        && value.albums.every(item => isLocalLibraryManagementPayload('library.album.capture', item))
        && new Set(value.albums.map(item => (item as LocalLibraryManagementPayloads['library.album.capture']).albumId)).size === value.albums.length && bounded(value, 128 * 1024)
      case 'library.rename': return closed(value, ['commandId', 'libraryId', 'name']) && isLocalWorkbenchIdentity(value.commandId) && isLocalWorkbenchIdentity(value.libraryId) && isLocalWorkbenchText(value.name, false, 256)
      case 'library.remove': return closed(value, ['commandId', 'libraryIds']) && isLocalWorkbenchIdentity(value.commandId) && idList(value.libraryIds, 10000, 1) && bounded(value, 128 * 1024)
      case 'library.snapshot.load': case 'library.snapshot.retry': return closed(value, ['commandId', 'libraryId']) && isLocalWorkbenchIdentity(value.commandId) && isLocalWorkbenchIdentity(value.libraryId)
      case 'library.operation.read': return closed(value, ['commandId']) && isLocalWorkbenchIdentity(value.commandId)
      case 'library.settings.save': return closed(value, ['commandId', 'scanConcurrency']) && isLocalWorkbenchIdentity(value.commandId) && integer(value.scanConcurrency, 1, 24)
      case 'library.watch.set': return closed(value, ['commandId', 'libraryId', 'enabled']) && isLocalWorkbenchIdentity(value.commandId) && isLocalWorkbenchIdentity(value.libraryId) && typeof value.enabled === 'boolean'
      case 'library.ai.start': return closed(value, ['commandId', 'captureId', 'backend', 'selection', 'albumIds']) && isLocalWorkbenchIdentity(value.commandId) && isLocalWorkbenchIdentity(value.captureId) && backend(value.backend)
        && ['missing-cover', 'selected'].includes(String(value.selection)) && idList(value.albumIds, 10000) && (value.selection !== 'selected' || value.albumIds.length > 0) && bounded(value, 128 * 1024)
      case 'library.cue.start': return closed(value, ['commandId', 'captureId', 'selection', 'selections', 'outputFormat', 'target']) && isLocalWorkbenchIdentity(value.commandId) && isLocalWorkbenchIdentity(value.captureId)
        && ['all-unsplit', 'selected'].includes(String(value.selection)) && dense(value.selections, 100)
        && (value.selection === 'all-unsplit' ? value.selections.length === 0 : value.selections.length > 0)
        && value.selections.every(item => closed(item, ['albumId', 'cueId']) && isLocalWorkbenchIdentity(item.albumId) && isLocalWorkbenchIdentity(item.cueId))
        && new Set(value.selections.map(item => (item as { albumId: string }).albumId)).size === value.selections.length && isLocalWorkbenchIdentity(value.outputFormat) && isLocalCueOutputTarget(value.target) && bounded(value, 128 * 1024)
      case 'library.job.read': return closed(value, ['jobId', 'offset', 'limit'], ['albumId']) && isLocalWorkbenchIdentity(value.jobId) && integer(value.offset) && integer(value.limit, 1, 200)
        && (!Object.hasOwn(value, 'albumId') || isLocalWorkbenchIdentity(value.albumId))
      case 'library.job.stop': case 'library.job.resume': return closed(value, ['jobId']) && isLocalWorkbenchIdentity(value.jobId)
      case 'library.job.retry': return closed(value, ['jobId', 'albumIds']) && isLocalWorkbenchIdentity(value.jobId) && idList(value.albumIds, 10000, 1) && bounded(value, 128 * 1024)
    }
  } catch { return false }
}
export function isLocalNameSettingsPayload<C extends LocalNameSettingsCommand>(command: C, value: unknown): value is LocalNameSettingsPayloads[C] {
  try {
    if (command === 'name.settings.read') return closed(value, [])
    if (command === 'name.settings.securityPrompt') return closed(value, ['commandId', 'backend']) && isLocalWorkbenchIdentity(value.commandId) && value.backend === 'cloud'
    if (!closed(value, ['commandId', 'settings']) || !isLocalWorkbenchIdentity(value.commandId)
      || !closed(value.settings, ['expectedRevision', 'backend', 'ollama', 'vllm', 'cloud']) || !isLocalWorkbenchIdentity(value.settings.expectedRevision) || !backend(value.settings.backend)) return false
    const settings = value.settings
    return ['ollama', 'vllm', 'cloud'].every(key => {
      const setting = settings[key]
      // 原 vLLM 默认模型为空；未选后端允许尚未配置，当前后端必须有实际模型。
      if (!closed(setting, ['endpoint', 'model']) || !isLocalWorkbenchText(setting.endpoint, false, 2048) || !isLocalWorkbenchText(setting.model, key !== settings.backend, 256)) return false
      const endpoint = new URL(setting.endpoint)
      return ['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
        && (key !== 'cloud' || endpoint.protocol === 'https:')
    }) && bounded(value, 128 * 1024)
  } catch { return false }
}

export function isLocalLibraryManagementCommand(value: unknown): value is LocalLibraryManagementCommand {
  return (LOCAL_LIBRARY_MANAGEMENT_COMMANDS as readonly unknown[]).includes(value)
}
export function isLocalNameSettingsCommand(value: unknown): value is LocalNameSettingsCommand {
  return (LOCAL_NAME_SETTINGS_COMMANDS as readonly unknown[]).includes(value)
}
const managedRoot = (value: unknown): value is LocalLibraryManagedRoot => closed(value,
  ['libraryId', 'label', 'role', 'online', 'watching', 'latestSnapshotId', 'totalAlbums', 'totalTracks', 'scanState'])
  && isLocalWorkbenchIdentity(value.libraryId) && isLocalWorkbenchText(value.label, false, 256)
  && typeof value.role === 'string' && ['catalog', 'artist', 'album', 'container'].includes(value.role) && typeof value.online === 'boolean' && typeof value.watching === 'boolean'
  && (value.latestSnapshotId === null || isLocalWorkbenchIdentity(value.latestSnapshotId)) && integer(value.totalAlbums) && integer(value.totalTracks)
  && ['idle', 'queued', 'running', 'paused', 'complete', 'failed', 'cancelled', 'offline'].includes(String(value.scanState))
function managementOperation(value: unknown): value is LocalLibraryManagementOperation {
  return closed(value, ['commandId', 'kind', 'state', 'libraryIds', 'message']) && isLocalWorkbenchIdentity(value.commandId)
    && isLocalLibraryManagementCommand(value.kind) && ['running', 'succeeded', 'partial', 'failed', 'unknown', 'cancelled'].includes(String(value.state))
    && idList(value.libraryIds, 10000) && (value.message === null || isLocalWorkbenchText(value.message, false, 1024))
}
function batchPage(value: unknown): value is LocalLibraryBatchPage {
  return closed(value, ['jobId', 'captureId', 'kind', 'state', 'totalAlbums', 'processedAlbums', 'succeededAlbums', 'failedAlbums', 'offset', 'items'], ['originalEntry'])
    && isLocalWorkbenchIdentity(value.jobId) && isLocalWorkbenchIdentity(value.captureId) && ['ai', 'cue'].includes(String(value.kind))
    && ['queued', 'running', 'stopped', 'complete', 'partial', 'unknown', 'failed'].includes(String(value.state))
    && integer(value.totalAlbums, 0, 10000) && integer(value.processedAlbums, 0, value.totalAlbums as number)
    && integer(value.succeededAlbums, 0, value.processedAlbums as number) && integer(value.failedAlbums, 0, value.processedAlbums as number)
    && (value.succeededAlbums as number) + (value.failedAlbums as number) <= (value.processedAlbums as number)
    && integer(value.offset, 0, value.totalAlbums as number) && dense(value.items, 200)
    && value.items.every(item => closed(item, ['albumId', 'state', 'message']) && isLocalWorkbenchIdentity(item.albumId)
      && ['queued', 'running', 'ready', 'applied', 'review', 'failed', 'unknown', 'cancelled'].includes(String(item.state))
      && (item.message === null || isLocalWorkbenchText(item.message, false, 1024)))
    && new Set(value.items.map(item => (item as LocalLibraryBatchItem).albumId)).size === value.items.length
    && (value.offset as number) + value.items.length <= (value.totalAlbums as number)
    && (!Object.hasOwn(value, 'originalEntry') || value.originalEntry === null || isLocalLibraryJobOriginalEntry(value.originalEntry))
}
export function isLocalLibraryJobOriginalEntry(value: unknown): value is LocalLibraryJobOriginalEntry {
  return closed(value, ['datasetId', 'album', 'capture']) && isLocalWorkbenchIdentity(value.datasetId)
    && isLocalWorkbenchAlbumRef(value.album) && !!value.album.rootId && value.album.trackIds.length === 0
    && integer(value.album.trackCount) && isLocalWorkbenchIdentity(value.album.revision)
    && isLocalWorkbenchCapture(value.capture) && value.capture.albumId === value.album.albumId
}
export function isLocalLibraryManagementResult<C extends LocalLibraryManagementCommand>(command: C, value: unknown, request: LocalLibraryManagementPayloads[C]): value is LocalLibraryManagementResults[C] {
  try {
    if (!isLocalLibraryManagementPayload(command, request) || !bounded(value, 128 * 1024)) return false
    switch (command) {
      case 'library.read': return closed(value, ['datasetId', 'revision', 'libraries', 'scanConcurrency']) && isLocalWorkbenchIdentity(value.datasetId)
        && isLocalWorkbenchIdentity(value.revision) && dense(value.libraries, 10000) && value.libraries.every(managedRoot)
        && new Set(value.libraries.map(item => item.libraryId)).size === value.libraries.length && integer(value.scanConcurrency, 1, 24)
      case 'library.import.prepare': return value === null || closed(value, ['choiceId', 'label', 'suggestedRole', 'evidence'])
        && isLocalWorkbenchIdentity(value.choiceId) && isLocalWorkbenchText(value.label, false, 256)
        && typeof value.suggestedRole === 'string' && ['catalog', 'artist', 'album', 'container'].includes(value.suggestedRole) && dense(value.evidence, 32) && value.evidence.every(item => isLocalWorkbenchText(item, false, 1024))
      case 'library.capture': {
        const expected = request as LocalLibraryManagementPayloads['library.capture']
        return closed(value, ['datasetId', 'captureId', 'libraryIds', 'revision', 'lyricsLibraries']) && isLocalWorkbenchIdentity(value.datasetId)
          && isLocalWorkbenchIdentity(value.captureId) && isLocalWorkbenchIdentity(value.revision) && idList(value.libraryIds, 10000, 1)
          && same(value.libraryIds, expected.libraryIds) && dense(value.lyricsLibraries, 10000) && value.lyricsLibraries.length === value.libraryIds.length
          && value.lyricsLibraries.every(item => closed(item, ['datasetId', 'libraryId', 'captureId']) && item.datasetId === value.datasetId
            && (value.libraryIds as string[]).includes(item.libraryId as string) && isLocalWorkbenchIdentity(item.captureId))
          && new Set(value.lyricsLibraries.map(item => (item as { libraryId: string }).libraryId)).size === value.lyricsLibraries.length
      }
      case 'library.album.capture': {
        const expected = request as LocalLibraryManagementPayloads['library.album.capture']
        return isLocalWorkbenchReadback(value) && value.albums.length === 1 && value.albums[0]!.album.albumId === expected.albumId
          && value.albums[0]!.album.rootId === expected.rootId && value.albums[0]!.album.trackIds.length === 0
          && value.albums[0]!.album.revision === expected.revision && integer(value.albums[0]!.album.trackCount)
      }
      case 'library.albums.capture': {
        const expected = request as LocalLibraryManagementPayloads['library.albums.capture']
        return isLocalWorkbenchReadback(value) && value.albums.length === expected.albums.length
          && value.albums.every(item => expected.albums.some(target => target.albumId === item.album.albumId && target.rootId === item.album.rootId
            && target.revision === item.album.revision) && item.album.trackIds.length === 0 && integer(item.album.trackCount))
      }
      case 'library.settings.read': return closed(value, ['scanConcurrency', 'revision']) && integer(value.scanConcurrency, 1, 24) && isLocalWorkbenchIdentity(value.revision)
      case 'library.operation.read': return value === null || managementOperation(value) && value.commandId === (request as { commandId: string }).commandId
      case 'library.ai.start': case 'library.cue.start': return batchPage(value) && !Object.hasOwn(value, 'originalEntry') && value.jobId === (request as { commandId: string }).commandId
        && value.captureId === (request as { captureId: string }).captureId && value.kind === (command === 'library.ai.start' ? 'ai' : 'cue')
      case 'library.job.read': {
        const expected = request as LocalLibraryManagementPayloads['library.job.read']
        return value === null || batchPage(value) && value.jobId === expected.jobId && value.offset === expected.offset && value.items.length <= expected.limit
          && (expected.albumId === undefined ? !Object.hasOwn(value, 'originalEntry') : Object.hasOwn(value, 'originalEntry')
            && (value.originalEntry === null || value.originalEntry?.album.albumId === expected.albumId))
      }
      case 'library.job.stop': case 'library.job.resume': case 'library.job.retry': return batchPage(value) && !Object.hasOwn(value, 'originalEntry') && value.jobId === (request as { jobId: string }).jobId
      default: return managementOperation(value) && value.commandId === (request as { commandId: string }).commandId
        && (value.kind === command || command === 'library.snapshot.retry' && value.kind === 'library.snapshot.load')
    }
  } catch { return false }
}
export function isLocalNameSettingsResult<C extends LocalNameSettingsCommand>(command: C, value: unknown, request: LocalNameSettingsPayloads[C]): value is LocalNameSettingsResults[C] {
  try {
    if (!isLocalNameSettingsPayload(command, request) || !bounded(value, 128 * 1024)) return false
    if (command === 'name.settings.securityPrompt') return closed(value, ['configured', 'cancelled']) && typeof value.configured === 'boolean' && typeof value.cancelled === 'boolean'
    if (!closed(value, ['revision', 'backend', 'ollama', 'vllm', 'cloud']) || !isLocalWorkbenchIdentity(value.revision)
      || !closed(value.cloud, ['endpoint', 'model', 'keyConfigured']) || typeof value.cloud.keyConfigured !== 'boolean') return false
    return isLocalNameSettingsPayload('name.settings.save', { commandId: 'readback-validation', settings: { expectedRevision: value.revision,
      backend: value.backend, ollama: value.ollama, vllm: value.vllm, cloud: { endpoint: value.cloud.endpoint, model: value.cloud.model } } })
  } catch { return false }
}
