import type {
  PreparationZipHistory, PreparationZipJob, PreparationZipProposal, PreparationZipPublicApi, PreparationZipTarget,
  PreparationZipReceiptRequest, PreviewPreparationZipRequest, StartPreparationZipRequest,
} from '@music-bridge/contracts'
import type { DatasetScope } from './command-outbox-client.js'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f/\\]/u.test(value)
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value))

/** 沙盒中只核公开信封、长度和交叉身份；完整领域合同由 Main/Core 复核。 */
function target(value: unknown): value is PreparationZipTarget {
  return record(value) && keys(value, ['id', 'label', 'expiresAt']) && uuid(value.id) && label(value.label) && iso(value.expiresAt)
}
function previewRequest(value: unknown): value is PreviewPreparationZipRequest {
  return record(value) && keys(value, ['workspaceId', 'targetId']) && uuid(value.workspaceId) && uuid(value.targetId)
}
function startRequest(value: unknown): value is StartPreparationZipRequest {
  return record(value) && keys(value, ['workspaceId', 'targetId', 'commandId', 'proposalFingerprint', 'userConfirmed'])
    && uuid(value.workspaceId) && uuid(value.targetId) && uuid(value.commandId) && hash(value.proposalFingerprint) && value.userConfirmed === true
}
function receiptRequest(value: unknown): value is PreparationZipReceiptRequest {
  if (!record(value) || Object.keys(value).length !== 2 || !record(value.request)) return false
  if (value.kind === 'start') return startRequest(value.request)
  return value.kind === 'cancel' && Object.keys(value.request).length === 2 && uuid(value.request.commandId) && uuid(value.request.id)
}
function proposal(value: unknown): value is PreparationZipProposal {
  return record(value) && keys(value, ['workspaceId', 'draftId', 'masterVersionId', 'layoutVersionId', 'targetId', 'targetLabel', 'manifestHash', 'fileCount', 'sourceBytes', 'proposalFingerprint', 'executionReady'])
    && [value.workspaceId, value.draftId, value.masterVersionId, value.layoutVersionId, value.targetId].every(uuid)
    && label(value.targetLabel) && hash(value.manifestHash) && hash(value.proposalFingerprint)
    && integer(value.fileCount, 1, 210) && integer(value.sourceBytes, 1, 200 * 68_719_476_736) && value.executionReady === false
}
function job(value: unknown): value is PreparationZipJob {
  if (!record(value) || !keys(value, ['id', 'workspaceId', 'draftId', 'state', 'targetLabel', 'fileCount', 'completedFiles', 'zipSha256', 'zipBytes', 'failure'])
    || !uuid(value.id) || !uuid(value.workspaceId) || !uuid(value.draftId) || !label(value.targetLabel)
    || !integer(value.fileCount, 1, 210) || !integer(value.completedFiles, 0, value.fileCount)) return false
  if (value.state === 'completed') return value.completedFiles === value.fileCount && hash(value.zipSha256) && integer(value.zipBytes, 1, Number.MAX_SAFE_INTEGER) && value.failure === undefined
  if (value.zipSha256 !== undefined || value.zipBytes !== undefined) return false
  if (value.state === 'failed') return ['WORKSPACE_INVALID', 'TARGET_INVALID', 'CONTENT_CHANGED', 'DISK_FULL', 'IO_ERROR', 'RECOVERY_REQUIRED'].includes(String(value.failure))
  if (value.state === 'cancelled') return value.failure === 'CANCELLED'
  return ['running', 'cancelling', 'interrupted'].includes(String(value.state)) && value.failure === undefined
}
function history(value: unknown): value is PreparationZipHistory {
  return record(value) && keys(value, ['draftId', 'jobs']) && uuid(value.draftId) && Array.isArray(value.jobs)
    && value.jobs.length <= 1000 && value.jobs.every(job) && value.jobs.every(item => item.draftId === value.draftId)
    && new Set(value.jobs.map(item => item.id)).size === value.jobs.length
}

/** 沙盒只收短时目标句柄与公开回执；路径、目录身份和私有授权留在 Main/Core。 */
export function createPreparationZipClient(invoke: (channel: string, value?: unknown) => Promise<unknown>, getDatasetId: DatasetScope): PreparationZipPublicApi {
  const scope = getDatasetId().catch(() => { throw new Error('[OUTBOX_SCOPE_MISMATCH] 工作库身份未获确认，请重新加载录音窗口。') })
  void scope.catch(() => undefined)
  const invalid = (kind: 'REQUEST' | 'RESPONSE') => new Error(`[INVALID_IPC_${kind}] Logic ZIP ${kind === 'REQUEST' ? '请求' : '回执'}无效。`)
  async function request(command: string, payload: unknown): Promise<unknown> {
    return invoke('recordingPreparationZip:request', { datasetId: await scope, command, payload: structuredClone(payload) })
  }
  return {
    async choosePreparationZipTarget(workspaceId) {
      if (!uuid(workspaceId)) throw invalid('REQUEST')
      const result = await invoke('recordingPreparationZip:choose', { datasetId: await scope, workspaceId })
      if (result !== null && !target(result)) throw invalid('RESPONSE')
      return result
    },
    async previewPreparationZip(payload) {
      if (!previewRequest(payload)) throw invalid('REQUEST')
      const result = await request('recordingPreparationZip.preview', payload)
      if (!proposal(result) || result.workspaceId !== payload.workspaceId || result.targetId !== payload.targetId) throw invalid('RESPONSE')
      return result
    },
    async startPreparationZip(payload) {
      if (!startRequest(payload)) throw invalid('REQUEST')
      const result = await request('recordingPreparationZip.start', payload)
      if (!job(result) || result.id !== payload.commandId || result.workspaceId !== payload.workspaceId) throw invalid('RESPONSE')
      return result
    },
    async listPreparationZips(draftId) {
      if (!uuid(draftId)) throw invalid('REQUEST')
      const result = await request('recordingPreparationZip.list', { draftId })
      if (!history(result) || result.draftId !== draftId) throw invalid('RESPONSE')
      return result
    },
    async getPreparationZipJob(id) {
      if (!uuid(id)) throw invalid('REQUEST')
      const result = await request('recordingPreparationZip.job', { id })
      if (!record(result) || Object.keys(result).length !== 1 || result.job !== null && (!job(result.job) || result.job.id !== id)) throw invalid('RESPONSE')
      return { job: result.job as Awaited<ReturnType<PreparationZipPublicApi['getPreparationZipJob']>>['job'] }
    },
    async getPreparationZipReceipt(payload) {
      if (!receiptRequest(payload)) throw invalid('REQUEST')
      const result = await request('recordingPreparationZip.receipt', payload)
      if (!record(result) || Object.keys(result).sort().join(',') !== 'job,status'
        || result.status === 'accepted' && (!job(result.job)
          || payload.kind === 'start' && (result.job.id !== payload.request.commandId || result.job.workspaceId !== payload.request.workspaceId)
          || payload.kind === 'cancel' && result.job.id !== payload.request.id)
        || result.status !== 'accepted' && (!(result.status === 'not-accepted' && payload.kind === 'start' || result.status === 'unknown') || result.job !== null)) throw invalid('RESPONSE')
      return result as Awaited<ReturnType<PreparationZipPublicApi['getPreparationZipReceipt']>>
    },
    async cancelPreparationZipJob(payload) {
      if (!record(payload) || Object.keys(payload).length !== 2 || !uuid(payload.commandId) || !uuid(payload.id)) throw invalid('REQUEST')
      const result = await request('recordingPreparationZip.cancel', payload)
      if (!job(result) || result.id !== payload.id) throw invalid('RESPONSE')
      return result
    },
  }
}
