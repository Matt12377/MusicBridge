import type { RecordingRecordsPublicApi } from '@music-bridge/contracts'

/** 只绑定本次窗口加载的工作库；处置请求不排队、不自动重试或重放。 */
export function createRecordingRecordClient(invoke: (channel: string, value?: unknown) => Promise<unknown>): RecordingRecordsPublicApi {
  const failure = () => new Error('[OUTBOX_SCOPE_MISMATCH] 工作库身份未获确认，请重新加载录音窗口。')
  const scope = invoke('commandOutbox:context').then(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure()
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 1 || typeof record.datasetId !== 'string' || record.datasetId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.datasetId)) throw failure()
    return record.datasetId
  }).catch(() => { throw failure() })
  void scope.catch(() => undefined)
  async function send<T>(name: 'list' | 'get' | 'visual' | 'history' | 'previewDisposition' | 'applyDisposition', payload: unknown): Promise<T> {
    const captured = structuredClone(payload)
    return await invoke(`recordingRecords:${name}`, { datasetId: await scope, payload: captured }) as T
  }
  return {
    listRecordingRecords: request => send('list', request),
    getRecordingRecord: id => send('get', { id }),
    getRecordingRecordVisual: request => send('visual', request),
    getPhysicalRecordingHistory: request => send('history', request),
    previewPhysicalRecordingDisposition: request => send('previewDisposition', request),
    applyPhysicalRecordingDisposition: request => send('applyDisposition', request),
  }
}
