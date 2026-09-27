import type { SourceCandidateScan, SourceCandidatesPublicApi, SourceJob } from '@music-bridge/contracts'
import type { DatasetScope } from './command-outbox-client.js'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const integer = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const label = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('/') && !value.startsWith('\\')

/** 预加载保持纯 sandbox：本地只检信封、边界和身份，完整领域 DTO 由 Main/Core 验证。 */
function scanEnvelope(value: unknown): value is SourceCandidateScan {
  if (!record(value) || !keys(value, ['id', 'rootId', 'draftId', 'trackId', 'expectedDraftRevision', 'state', 'scannedEntries', 'skippedSymlinks', 'skippedUnreadable', 'stopReason', 'candidates'])
    || ![value.id, value.rootId, value.draftId, value.trackId].every(uuid) || !integer(value.expectedDraftRevision, 1, 1_000_000)
    || !['running', 'completed', 'truncated', 'cancelled', 'failed'].includes(String(value.state))
    || ![value.scannedEntries, value.skippedSymlinks, value.skippedUnreadable].every(number => integer(number, 0, 3000))
    || !Array.isArray(value.candidates) || value.candidates.length > 200) return false
  return value.candidates.every(candidate => record(candidate) && keys(candidate, ['id', 'fileName', 'relativeLabel', 'extension', 'size', 'modifiedAt'])
    && uuid(candidate.id) && label(candidate.fileName) && !/[\/\\]/u.test(String(candidate.fileName)) && label(candidate.relativeLabel)
    && ['wav', 'wave', 'flac', 'aiff', 'aif'].includes(String(candidate.extension)) && integer(candidate.size, 1, 68_719_476_736)
    && typeof candidate.modifiedAt === 'string' && candidate.modifiedAt.length <= 32)
}
function jobEnvelope(value: unknown, request: { commandId: string; draftId: string; trackId: string; rootId: string }): value is SourceJob {
  return record(value) && keys(value, ['id', 'draftId', 'trackId', 'rootId', 'state', 'bindingId', 'failure'])
    && value.id === request.commandId && value.draftId === request.draftId && value.trackId === request.trackId && value.rootId === request.rootId
    && ['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(value.state))
    && (value.bindingId === undefined || uuid(value.bindingId)) && (value.failure === undefined || typeof value.failure === 'string' && value.failure.length <= 40)
}

/** Renderer 只能看去路径化的候选标签；扫描会话在 Core 重启后必须失效。 */
export function createRecordingCandidateClient(
  invoke: (channel: string, value?: unknown) => Promise<unknown>,
  select: SourceCandidatesPublicApi['selectRecordingSourceCandidate'],
  getDatasetId: DatasetScope,
): SourceCandidatesPublicApi {
  const scope = getDatasetId().catch(() => { throw new Error('[OUTBOX_SCOPE_MISMATCH] 当前工作库身份未获确认。') })
  void scope.catch(() => undefined)
  const failure = (kind: 'REQUEST' | 'RESPONSE') => new Error(`[INVALID_IPC_${kind}] 候选扫描${kind === 'REQUEST' ? '请求' : '结果'}无效。`)
  async function request(command: string, payload: unknown): Promise<unknown> {
    return invoke('recordingCandidates:request', { datasetId: await scope, command, payload: structuredClone(payload) })
  }
  return {
    async startRecordingSourceCandidateScan(payload) {
      if (!record(payload) || !keys(payload, ['commandId', 'rootId', 'draftId', 'trackId', 'expectedDraftRevision'])
        || ![payload.commandId, payload.rootId, payload.draftId, payload.trackId].every(uuid) || !integer(payload.expectedDraftRevision, 1, 1_000_000)) throw failure('REQUEST')
      const result = await request('recordingCandidates.start', payload)
      if (!scanEnvelope(result) || result.id !== payload.commandId || result.rootId !== payload.rootId || result.draftId !== payload.draftId || result.trackId !== payload.trackId || result.expectedDraftRevision !== payload.expectedDraftRevision) throw failure('RESPONSE')
      return result
    },
    async getRecordingSourceCandidateScan(id) {
      if (!uuid(id)) throw failure('REQUEST')
      const result = await request('recordingCandidates.get', { id })
      if (!record(result) || !keys(result, ['scan']) || !('scan' in result) || result.scan !== null && (!scanEnvelope(result.scan) || result.scan.id !== id)) throw failure('RESPONSE')
      return { scan: result.scan as SourceCandidateScan | null }
    },
    async cancelRecordingSourceCandidateScan(payload) {
      if (!record(payload) || !keys(payload, ['commandId', 'id']) || !uuid(payload.commandId) || !uuid(payload.id)) throw failure('REQUEST')
      const result = await request('recordingCandidates.cancel', payload)
      if (!scanEnvelope(result) || result.id !== payload.id || result.state !== 'cancelled') throw failure('RESPONSE')
      return result
    },
    async selectRecordingSourceCandidate(payload) {
      if (!record(payload) || !keys(payload, ['commandId', 'draftId', 'trackId', 'rootId', 'acquisition', 'relocateBindingId', 'candidate'])
        || ![payload.commandId, payload.draftId, payload.trackId, payload.rootId].every(uuid)
        || !['userFileBind', 'roonDesktopExport'].includes(String(payload.acquisition))
        || payload.relocateBindingId !== undefined && !uuid(payload.relocateBindingId)
        || !record(payload.candidate) || !keys(payload.candidate, ['scanId', 'candidateId', 'expectedDraftRevision'])
        || !uuid(payload.candidate.scanId) || !uuid(payload.candidate.candidateId) || !integer(payload.candidate.expectedDraftRevision, 1, 1_000_000)) throw failure('REQUEST')
      const result = await select(payload)
      if (!jobEnvelope(result, payload)) throw failure('RESPONSE')
      return result
    },
  }
}
