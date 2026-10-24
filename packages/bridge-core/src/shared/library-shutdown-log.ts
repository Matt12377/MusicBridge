import { logLibraryOperation } from './library-operation-log.js'

/** 关闭阶段仅作旁注；不能授予静止资格、替换异常或输出底层错误文本。 */
export type LibraryShutdownStage =
  | 'utility.content' | 'utility.workbench' | 'utility.mobile' | 'utility.dispatch'
  | 'runtime.controller' | 'runtime.registry' | 'runtime.mobile' | 'runtime.owner'
  | 'runtime.replica' | 'runtime.prints' | 'runtime.records' | 'runtime.attempts' | 'runtime.devices'
  | 'runtime.output' | 'runtime.plans' | 'runtime.backups' | 'runtime.archive' | 'runtime.execution'
  | 'runtime.prepared' | 'runtime.zip' | 'runtime.preparation' | 'runtime.versions' | 'runtime.candidates'
  | 'runtime.sources' | 'runtime.connections' | 'runtime.control' | 'runtime.roon' | 'runtime.lyrics' | 'runtime.gateway'
  | 'owner.background' | 'owner.mobile' | 'owner.mobile-sources' | 'owner.replica' | 'owner.prints'
  | 'owner.records' | 'owner.attempts' | 'owner.devices' | 'owner.output' | 'owner.plans' | 'owner.backups'
  | 'owner.archive' | 'owner.execution' | 'owner.prepared' | 'owner.zip' | 'owner.preparation' | 'owner.versions'
  | 'owner.workbench' | 'owner.source-writes' | 'owner.relocation-plans' | 'owner.artwork' | 'owner.albums'
  | 'owner.organizer' | 'owner.legacy' | 'owner.scan' | 'owner.media-worker' | 'owner.snapshots'
  | 'owner.relocation' | 'owner.candidates' | 'owner.sources' | 'owner.dispatches' | 'owner.barrier'
  | 'owner.source-safety' | 'owner.connections'

const codes = new Set(['NOT_READY', 'TIMEOUT', 'CANCELLED', 'CLOSED', 'INTERNAL_ERROR', 'INVALID_IPC_REQUEST', 'INVALID_IPC_RESPONSE',
  'OUTBOX_SCOPE_MISMATCH', 'INVENTORY_UNAVAILABLE', 'INVENTORY_CONFLICT', 'WORKER_FAILED', 'WORKER_START_TIMEOUT',
  'QUEUE_FULL', 'IO_ERROR', 'BUDGET_EXCEEDED', 'RELEASE_UNKNOWN', 'COMMIT_UNKNOWN', 'RECOVERY_REQUIRED',
  'ARTWORK_STORE_UNAVAILABLE', 'ARTWORK_RECORD_INVALID', 'ARTWORK_STORE_FULL', 'ARTWORK_QUEUE_UNAVAILABLE'])
function own(value: unknown, key: string): unknown {
  try { return value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined }
  catch { return undefined }
}
function errorCode(error: unknown): string {
  const code = own(error, 'code'), failure = own(own(own(error, 'failure'), 'error'), 'code')
  return typeof code === 'string' && codes.has(code) ? code : typeof failure === 'string' && codes.has(failure) ? failure : 'SHUTDOWN_STEP_FAILED'
}
export async function runLibraryShutdownStep<T>(stage: LibraryShutdownStage, operation: () => T | Promise<T>): Promise<T> {
  const began = performance.now()
  logLibraryOperation('library', `shutdown.${stage}`, 'start')
  try {
    const result = await operation()
    logLibraryOperation('library', `shutdown.${stage}`, 'complete', { elapsedMs: performance.now() - began, slowAfterMs: 100 })
    return result
  } catch (error) {
    logLibraryOperation('library', `shutdown.${stage}`, 'error', { code: errorCode(error), elapsedMs: performance.now() - began, slowAfterMs: 100 })
    throw error
  }
}
