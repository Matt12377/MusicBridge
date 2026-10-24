import { logLibraryOperation } from '../../../../../../../packages/bridge-core/src/shared/library-operation-log.js'

type LocalPlaybackStep = 'detail' | 'target' | 'roots' | 'dataset' | 'submit'

/** 只观察原单次调用；submit返回不等于Roon已播放，不读异常正文、不重发原请求。 */
export async function traceLocalPlaybackStep<T>(step: LocalPlaybackStep, work: () => Promise<T>): Promise<T> {
  const started = performance.now(), action = `playback.local-${step}`
  logLibraryOperation('ui', action, 'start')
  try {
    const result = await work()
    logLibraryOperation('ui', action, 'complete', { elapsedMs: Math.max(0, performance.now() - started), code: 'RETURNED' })
    return result
  } catch (error) {
    logLibraryOperation('ui', action, 'error', { elapsedMs: Math.max(0, performance.now() - started), code: 'UNCONFIRMED' })
    throw error
  }
}
