import { isImportedCollectionDescriptor, type CollectionDescriptor, type CollectionPhotoImage } from './collection.js';
import type { Page, PageRequest } from './library.js';
import { isRecordingArtworkSnapshot, isMasterArtworkImage, recordingArtworkImageBytes, type RecordingArtworkSnapshot, type MasterArtworkVersion, type GetMasterArtworkRequest, type PickMasterArtworkRequest, type SaveMasterArtworkRequest, type MasterArtworkResult, type PickMasterArtworkResult } from './recording-artwork.js';

export const RECORDING_PRINT_TEMPLATE_ID = 'jp0-basic-v1' as const;
export const MAX_RECORDING_PRINT_PAGE_SIZE = 25;
export const MAX_RECORDING_PRINT_JOBS = 100_000;
export const MAX_RECORDING_PRINT_RECEIPTS = 100_000;
export const MAX_RECORDING_PRINT_OBJECT_BYTES = 1_073_741_824;
export const MAX_RECORDING_PRINT_METADATA_BYTES = 134_217_728;
export const MAX_RECORDING_PRINT_ITEM_BYTES = 262_144;
export const MAX_RECORDING_PRINT_PDF_BYTES = 4_194_304;
export const MAX_RECORDING_PRINT_PREVIEW_BYTES = 1_048_576;
export const MAX_RECORDING_PRINT_PAGES = 24;
export interface RecordingPrintGeometry {
  widthMm: 103.1875; heightMm: 101.6; widthPt: 292.5; heightPt: 288;
  flapMm: 25.4; spineMm: 12.7; coverMm: 65.0875; insideFoldMm: readonly [65.0875, 77.7875];
}
export const RECORDING_PRINT_GEOMETRY: RecordingPrintGeometry = Object.freeze({ widthMm: 103.1875, heightMm: 101.6, widthPt: 292.5, heightPt: 288, flapMm: 25.4, spineMm: 12.7, coverMm: 65.0875, insideFoldMm: Object.freeze([65.0875, 77.7875] as const) });
export interface RecordingPrintTrack { position: number; trackId: string; title: string; artist?: string }
export interface RecordingPrintSide { side: 'A' | 'B'; frameCount: number; sampleRate: number; durationMs: number; tracks: readonly RecordingPrintTrack[] }
export interface RecordingPrintFacts {
  schemaVersion: 1; recordingId: string; recordingContentHash: string; planVersionId: string; planContentHash: string; physicalId: string;
  title: string; spine: string; completedAt: string; displayDateUtc: string;
  tapeModel: { state: 'known'; descriptor: CollectionDescriptor } | { state: 'unknown' };
  sides: readonly RecordingPrintSide[]; artwork: RecordingArtworkSnapshot;
}
export interface RecordingPrintRequest {
  id: string; recordingId: string; recordingContentHash: string; planVersionId: string; planContentHash: string;
  origin: 'completion' | 'historical-backfill'; templateId: typeof RECORDING_PRINT_TEMPLATE_ID; templateHash: string; factsHash: string; inputHash: string; createdAt: string;
}
export type RecordingPrintErrorCode = 'RENDER_FAILED' | 'LAYOUT_OVERFLOW' | 'RENDER_TIMEOUT' | 'OBJECT_LIMIT';
export interface RecordingPrintJob {
  id: string; request: RecordingPrintRequest; state: 'pending' | 'rendering' | 'failed' | 'ready'; revision: number; createdAt: string; updatedAt: string;
  artifactId: string | null; errorCode: RecordingPrintErrorCode | null;
}
export interface PrintedArtifact {
  id: string; requestId: string; recordingId: string; createdAt: string; inputHash: string; templateId: typeof RECORDING_PRINT_TEMPLATE_ID; templateHash: string;
  rendererVersion: string; pdfSha256: string; size: number; pageCount: number; geometry: RecordingPrintGeometry;
  previewSha256: string; previewSize: number; artwork: RecordingArtworkSnapshot;
}
export interface ListRecordingPrintsRequest { recordingId: string; page: PageRequest }
export interface RequestRecordingPrintRequest { commandId: string; recordingId: string; expectedRecordHash: string; templateId: typeof RECORDING_PRINT_TEMPLATE_ID; userConfirmed: true }
export interface RetryRecordingPrintRequest { commandId: string; jobId: string; expectedRevision: number; userConfirmed: true }
export interface GetRecordingPrintRequest { recordingId: string; artifactId: string }
export interface ExportRecordingPrintRequest extends GetRecordingPrintRequest { expectedPdfSha256: string }
export type RecordingPrintsPage = Page<RecordingPrintJob>;
export interface RecordingPrintResult { artifact: PrintedArtifact; facts: RecordingPrintFacts; preview: CollectionPhotoImage }
export type ExportRecordingPrintResult = { state: 'cancelled' } | { state: 'exported'; artifactId: string; pdfSha256: string; size: number };
export interface RecordingPrintLease { leaseId: string; workerId: string; jobId: string; requestId: string; inputHash: string; facts: RecordingPrintFacts; artworkImage: CollectionPhotoImage | null; templateId: typeof RECORDING_PRINT_TEMPLATE_ID }
export interface ClaimRecordingPrintRequest { workerId: string }
export interface CompleteRecordingPrintRequest { leaseId: string; workerId: string; jobId: string; inputHash: string; pdfBase64: string; pdfSha256: string; preview: CollectionPhotoImage; pageCount: number; rendererVersion: string }
export interface FailRecordingPrintRequest { leaseId: string; workerId: string; jobId: string; inputHash: string; errorCode: RecordingPrintErrorCode }
export interface RecordingPrintPdfResult { artifactId: string; pdfSha256: string; size: number; pdfBase64: string }
export interface RecordingPrintsPublicApi {
  getMasterArtwork(request: GetMasterArtworkRequest): Promise<MasterArtworkResult>;
  pickMasterArtwork(request: PickMasterArtworkRequest): Promise<PickMasterArtworkResult>;
  saveMasterArtwork(request: SaveMasterArtworkRequest): Promise<MasterArtworkVersion>;
  listRecordingPrints(request: ListRecordingPrintsRequest): Promise<RecordingPrintsPage>;
  requestRecordingPrint(request: RequestRecordingPrintRequest): Promise<RecordingPrintJob>;
  retryRecordingPrint(request: RetryRecordingPrintRequest): Promise<RecordingPrintJob>;
  getRecordingPrint(request: GetRecordingPrintRequest): Promise<RecordingPrintResult>;
  exportRecordingPrint(request: ExportRecordingPrintRequest): Promise<ExportRecordingPrintResult>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const date = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v);
const errorCode = (v: unknown): v is RecordingPrintErrorCode => v === 'RENDER_FAILED' || v === 'LAYOUT_OVERFLOW' || v === 'RENDER_TIMEOUT' || v === 'OBJECT_LIMIT';
const renderer = (v: unknown): v is string => typeof v === 'string' && v.length <= 120 && v.trim() === v && /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(v);
const itemBudget = (v: unknown): boolean => new TextEncoder().encode(JSON.stringify(v)).length <= MAX_RECORDING_PRINT_ITEM_BYTES;
export function isRecordingPrintGeometry(v: unknown): v is RecordingPrintGeometry {
  if (!record(v) || !keys(v, Object.keys(RECORDING_PRINT_GEOMETRY))) return false;
  return Object.entries(RECORDING_PRINT_GEOMETRY).every(([key, value]) => Array.isArray(value) ? Array.isArray(v[key]) && v[key].length === 2 && v[key][0] === value[0] && v[key][1] === value[1] : v[key] === value);
}
function side(v: unknown): v is RecordingPrintSide {
  if (!record(v) || !keys(v, ['side', 'frameCount', 'sampleRate', 'durationMs', 'tracks']) || (v.side !== 'A' && v.side !== 'B') || !integer(v.frameCount, v.side === 'A' ? 1 : 0)
    || !integer(v.sampleRate, 8000, 384000) || !integer(v.durationMs, 0, 21_600_000) || !Array.isArray(v.tracks) || v.tracks.length > 200) return false;
  const duration = Number((BigInt(v.frameCount) * 2000n + BigInt(v.sampleRate)) / (2n * BigInt(v.sampleRate)));
  return v.durationMs === duration && (v.frameCount === 0) === (v.tracks.length === 0) && v.tracks.every((t, index) => record(t) && keys(t, ['position', 'trackId', 'title', 'artist']) && t.position === index + 1 && uuid(t.trackId) && text(t.title) && (t.artist === undefined || text(t.artist)));
}
export function isRecordingPrintFacts(v: unknown): v is RecordingPrintFacts {
  if (!record(v) || !keys(v, ['schemaVersion', 'recordingId', 'recordingContentHash', 'planVersionId', 'planContentHash', 'physicalId', 'title', 'spine', 'completedAt', 'displayDateUtc', 'tapeModel', 'sides', 'artwork']) || v.schemaVersion !== 1
    || !uuid(v.recordingId) || !uuid(v.planVersionId) || !hash(v.recordingContentHash) || !hash(v.planContentHash) || typeof v.physicalId !== 'string' || v.physicalId.trim() !== v.physicalId || !/^MB-C-\d{5,9}$/u.test(v.physicalId)
    || !text(v.title) || !text(v.spine) || !date(v.completedAt) || v.displayDateUtc !== v.completedAt.slice(0, 10) || !isRecordingArtworkSnapshot(v.artwork)
    || !record(v.tapeModel) || !(v.tapeModel.state === 'unknown' ? keys(v.tapeModel, ['state']) : v.tapeModel.state === 'known' && keys(v.tapeModel, ['state', 'descriptor']) && isImportedCollectionDescriptor(v.tapeModel.descriptor) && v.tapeModel.descriptor.format === 'cassette')
    || !Array.isArray(v.sides) || v.sides.length !== 2 || !v.sides.every(side) || v.sides[0]!.side !== 'A' || v.sides[1]!.side !== 'B') return false;
  if (v.artwork.state === 'captured' && v.artwork.version.createdAt > v.completedAt) return false;
  const tracks = v.sides.flatMap(s => s.tracks);
  return tracks.length <= 200 && new Set(tracks.map(t => t.trackId)).size === tracks.length && itemBudget(v);
}
export function isRecordingPrintRequest(v: unknown): v is RecordingPrintRequest {
  return record(v) && keys(v, ['id', 'recordingId', 'recordingContentHash', 'planVersionId', 'planContentHash', 'origin', 'templateId', 'templateHash', 'factsHash', 'inputHash', 'createdAt'])
    && uuid(v.id) && uuid(v.recordingId) && uuid(v.planVersionId) && hash(v.recordingContentHash) && hash(v.planContentHash) && hash(v.templateHash) && hash(v.factsHash) && hash(v.inputHash)
    && (v.origin === 'completion' || v.origin === 'historical-backfill') && v.templateId === RECORDING_PRINT_TEMPLATE_ID && date(v.createdAt);
}
export function isRecordingPrintJob(v: unknown): v is RecordingPrintJob {
  if (!record(v) || !keys(v, ['id', 'request', 'state', 'revision', 'createdAt', 'updatedAt', 'artifactId', 'errorCode']) || !uuid(v.id) || !isRecordingPrintRequest(v.request)
    || !integer(v.revision, 1) || !date(v.createdAt) || !date(v.updatedAt) || v.createdAt < v.request.createdAt || v.updatedAt < v.createdAt) return false;
  if (v.state === 'ready') return uuid(v.artifactId) && v.errorCode === null;
  return v.artifactId === null && (v.state === 'failed' ? errorCode(v.errorCode) : (v.state === 'pending' || v.state === 'rendering') && v.errorCode === null);
}
export function isPrintedArtifact(v: unknown): v is PrintedArtifact {
  return record(v) && keys(v, ['id', 'requestId', 'recordingId', 'createdAt', 'inputHash', 'templateId', 'templateHash', 'rendererVersion', 'pdfSha256', 'size', 'pageCount', 'geometry', 'previewSha256', 'previewSize', 'artwork'])
    && uuid(v.id) && uuid(v.requestId) && uuid(v.recordingId) && date(v.createdAt) && hash(v.inputHash) && v.templateId === RECORDING_PRINT_TEMPLATE_ID && hash(v.templateHash)
    && renderer(v.rendererVersion) && hash(v.pdfSha256) && integer(v.size, 12, MAX_RECORDING_PRINT_PDF_BYTES) && integer(v.pageCount, 1, MAX_RECORDING_PRINT_PAGES)
    && isRecordingPrintGeometry(v.geometry) && hash(v.previewSha256) && integer(v.previewSize, 4, MAX_RECORDING_PRINT_PREVIEW_BYTES) && isRecordingArtworkSnapshot(v.artwork);
}
export function isListRecordingPrintsRequest(v: unknown): v is ListRecordingPrintsRequest { return record(v) && keys(v, ['recordingId', 'page']) && uuid(v.recordingId) && record(v.page) && keys(v.page, ['offset', 'limit']) && integer(v.page.offset, 0, MAX_RECORDING_PRINT_JOBS) && integer(v.page.limit, 1, MAX_RECORDING_PRINT_PAGE_SIZE); }
export function isRequestRecordingPrintRequest(v: unknown): v is RequestRecordingPrintRequest { return record(v) && keys(v, ['commandId', 'recordingId', 'expectedRecordHash', 'templateId', 'userConfirmed']) && uuid(v.commandId) && uuid(v.recordingId) && hash(v.expectedRecordHash) && v.templateId === RECORDING_PRINT_TEMPLATE_ID && v.userConfirmed === true; }
export function isRetryRecordingPrintRequest(v: unknown): v is RetryRecordingPrintRequest { return record(v) && keys(v, ['commandId', 'jobId', 'expectedRevision', 'userConfirmed']) && uuid(v.commandId) && uuid(v.jobId) && integer(v.expectedRevision, 1) && v.userConfirmed === true; }
export function isGetRecordingPrintRequest(v: unknown): v is GetRecordingPrintRequest { return record(v) && keys(v, ['recordingId', 'artifactId']) && uuid(v.recordingId) && uuid(v.artifactId); }
export function isExportRecordingPrintRequest(v: unknown): v is ExportRecordingPrintRequest { return record(v) && keys(v, ['recordingId', 'artifactId', 'expectedPdfSha256']) && uuid(v.recordingId) && uuid(v.artifactId) && hash(v.expectedPdfSha256); }
export function isRecordingPrintsPage(v: unknown): v is RecordingPrintsPage {
  if (!record(v) || !keys(v, ['items', 'offset', 'limit', 'total', 'hasMore']) || !integer(v.offset, 0, MAX_RECORDING_PRINT_JOBS) || !integer(v.limit, 1, MAX_RECORDING_PRINT_PAGE_SIZE) || !integer(v.total, 0, MAX_RECORDING_PRINT_JOBS)
    || !Array.isArray(v.items) || v.items.length > v.limit || !v.items.every(isRecordingPrintJob)) return false;
  return v.items.length <= Math.max(0, v.total - v.offset) && new Set(v.items.map(j => j.id)).size === v.items.length && new Set(v.items.map(j => j.request.recordingId)).size <= 1 && v.hasMore === (v.offset + v.items.length < v.total);
}
export function isRecordingPrintResult(v: unknown): v is RecordingPrintResult {
  return record(v) && keys(v, ['artifact', 'facts', 'preview']) && isPrintedArtifact(v.artifact) && isRecordingPrintFacts(v.facts) && isMasterArtworkImage(v.preview)
    && v.artifact.recordingId === v.facts.recordingId && v.artifact.createdAt >= v.facts.completedAt && JSON.stringify(v.artifact.artwork) === JSON.stringify(v.facts.artwork) && recordingArtworkImageBytes(v.preview) === v.artifact.previewSize;
}
export function isExportRecordingPrintResult(v: unknown): v is ExportRecordingPrintResult { return record(v) && (v.state === 'cancelled' ? keys(v, ['state']) : v.state === 'exported' && keys(v, ['state', 'artifactId', 'pdfSha256', 'size']) && uuid(v.artifactId) && hash(v.pdfSha256) && integer(v.size, 12, MAX_RECORDING_PRINT_PDF_BYTES)); }
export function isRecordingPrintLease(v: unknown): v is RecordingPrintLease {
  if (!record(v) || !keys(v, ['leaseId', 'workerId', 'jobId', 'requestId', 'inputHash', 'facts', 'artworkImage', 'templateId']) || !uuid(v.leaseId) || !uuid(v.workerId) || !uuid(v.jobId) || !uuid(v.requestId) || !hash(v.inputHash) || !isRecordingPrintFacts(v.facts) || v.templateId !== RECORDING_PRINT_TEMPLATE_ID) return false;
  const art = v.facts.artwork;
  return art.state === 'not-captured' ? v.artworkImage === null : isMasterArtworkImage(v.artworkImage) && v.artworkImage.width === art.version.width && v.artworkImage.height === art.version.height && recordingArtworkImageBytes(v.artworkImage) === art.version.size;
}
export function isClaimRecordingPrintRequest(v: unknown): v is ClaimRecordingPrintRequest { return record(v) && keys(v, ['workerId']) && uuid(v.workerId); }
function leaseFields(v: Record<string, unknown>): boolean { return uuid(v.leaseId) && uuid(v.workerId) && uuid(v.jobId) && hash(v.inputHash); }
/** 只核对有界编码与PDF边界；真实PDF解析/Hash/页数验证由Main和Core执行。 */
export function isRecordingPrintPdfBase64(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 16 || v.length > Math.ceil(MAX_RECORDING_PRINT_PDF_BYTES / 3) * 4 || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(v)) return false;
  try { const decoded = atob(v); return decoded.length <= MAX_RECORDING_PRINT_PDF_BYTES && decoded.startsWith('%PDF-') && /%%EOF[\r\n\t ]*$/u.test(decoded) && btoa(decoded) === v; } catch { return false; }
}
/** 仅验证请求字段；两个内容字段保持unknown，调用者必须另验实际内容。 */
export function isCompleteRecordingPrintRequestFields(v: unknown): v is Omit<CompleteRecordingPrintRequest, 'pdfBase64' | 'preview'> & { pdfBase64: unknown; preview: unknown } {
  return record(v) && keys(v, ['leaseId', 'workerId', 'jobId', 'inputHash', 'pdfBase64', 'pdfSha256', 'preview', 'pageCount', 'rendererVersion']) && leaseFields(v)
    && hash(v.pdfSha256) && integer(v.pageCount, 1, MAX_RECORDING_PRINT_PAGES) && renderer(v.rendererVersion);
}
export function isCompleteRecordingPrintRequest(v: unknown): v is CompleteRecordingPrintRequest {
  return isCompleteRecordingPrintRequestFields(v) && isRecordingPrintPdfBase64(v.pdfBase64) && isMasterArtworkImage(v.preview);
}
export function isFailRecordingPrintRequest(v: unknown): v is FailRecordingPrintRequest { return record(v) && keys(v, ['leaseId', 'workerId', 'jobId', 'inputHash', 'errorCode']) && leaseFields(v) && errorCode(v.errorCode); }
export function isRecordingPrintPdfResult(v: unknown): v is RecordingPrintPdfResult {
  return record(v) && keys(v, ['artifactId', 'pdfSha256', 'size', 'pdfBase64']) && uuid(v.artifactId) && hash(v.pdfSha256) && integer(v.size, 12, MAX_RECORDING_PRINT_PDF_BYTES)
    && isRecordingPrintPdfBase64(v.pdfBase64) && atob(v.pdfBase64).length === v.size;
}
