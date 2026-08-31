import type { RecordingReplicaPublicApi } from '@music-bridge/contracts'

/** 只绑定本次窗口加载的工作库；Replica请求不排队、不自动重播或取得新库身份。 */
export function createRecordingReplicaClient(invoke: (channel: string, value?: unknown) => Promise<unknown>): RecordingReplicaPublicApi {
  const failure = () => new Error('[OUTBOX_SCOPE_MISMATCH] 工作库身份未获确认，请重新加载录音窗口。')
  const scope = invoke('commandOutbox:context').then(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure()
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 1 || typeof record.datasetId !== 'string' || record.datasetId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.datasetId)) throw failure()
    return record.datasetId
  }).catch(() => { throw failure() })
  void scope.catch(() => undefined)
  async function send<T>(name: 'status' | 'inspect' | 'cancelRead' | 'start' | 'get' | 'stop', payload: unknown): Promise<T> {
    const captured = structuredClone(payload)
    return await invoke(`recordingReplica:${name}`, { datasetId: await scope, payload: captured }) as T
  }
  return {
    getRecordingReplicaStatus: () => send('status', {}),
    inspectRecordingReplica: request => send('inspect', request),
    cancelRecordingReplicaRead: readId => send('cancelRead', { readId }),
    startRecordingReplica: request => send('start', request),
    getRecordingReplicaRun: runId => send('get', { runId }),
    stopRecordingReplica: runId => send('stop', { runId }),
  }
}
