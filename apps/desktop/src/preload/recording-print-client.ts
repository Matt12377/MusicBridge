import type { RecordingPrintsPublicApi } from '@music-bridge/contracts'

/** 所有请求固定本次窗口工作库；选图只暂存，保存/导出不自动重放。 */
export function createRecordingPrintClient(invoke: (channel: string, value?: unknown) => Promise<unknown>): RecordingPrintsPublicApi {
  const failure = () => new Error('[OUTBOX_SCOPE_MISMATCH] 工作库身份未获确认，请重新加载录音窗口。')
  const scope = invoke('commandOutbox:context').then(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure()
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 1 || typeof record.datasetId !== 'string' || record.datasetId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.datasetId)) throw failure()
    return record.datasetId
  }).catch(() => { throw failure() })
  void scope.catch(() => undefined)
  async function send<T>(channel: string, payload: unknown): Promise<T> {
    const captured = structuredClone(payload)
    return await invoke(channel, { datasetId: await scope, payload: captured }) as T
  }
  return {
    getMasterArtwork: request => send('masterArtwork:get', request),
    pickMasterArtwork: request => send('masterArtwork:pick', request),
    saveMasterArtwork: request => send('masterArtwork:save', request),
    listRecordingPrints: request => send('recordingPrints:list', request),
    requestRecordingPrint: request => send('recordingPrints:request', request),
    retryRecordingPrint: request => send('recordingPrints:retry', request),
    getRecordingPrint: request => send('recordingPrints:get', request),
    exportRecordingPrint: request => send('recordingPrints:export', request),
  }
}
