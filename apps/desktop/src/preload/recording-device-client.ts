import type { RecordingDeviceSelectionPublicApi } from '@music-bridge/contracts'

/** 窗口加载时固定工作库身份；设备选择不排队、不跨激活数据集重放。 */
export function createRecordingDeviceClient(invoke: (channel: string, value?: unknown) => Promise<unknown>): RecordingDeviceSelectionPublicApi {
  const failure = () => new Error('[OUTBOX_SCOPE_MISMATCH] 工作库身份未获确认，请重新加载录音窗口。')
  const scope = invoke('commandOutbox:context').then(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure()
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 1 || typeof record.datasetId !== 'string' || record.datasetId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.datasetId)) throw failure()
    return record.datasetId
  }).catch(() => { throw failure() })
  void scope.catch(() => undefined)
  async function send<T>(name: 'candidates' | 'select', payload: unknown): Promise<T> {
    const snapshot = structuredClone(payload)
    return await invoke(`recordingDevice:${name}`, { datasetId: await scope, payload: snapshot }) as T
  }
  return {
    listRecordingDeviceCandidates: () => send('candidates', {}),
    selectRecordingDevice: request => send('select', request),
  }
}
