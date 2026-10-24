import { writeSync } from 'node:fs'

/** Main私有旁路：只接收当前owned Utility的闭集日志，不授播放或来源许可。 */
const common = ['timestamp','level','event','schemaVersion','component','diagnosticId','stage','currentOwned','staleCallback'] as const
const phases = ['PREPARING','SUBMITTING','AWAITING_ROON','PLAYING','PAUSED','ENDED','FAILED','CANCELLED','SUBMISSION_UNKNOWN','OWNERSHIP_LOST'] as const
const outcomes = ['body-completed','pipeline-unfinished','head-ended','range-rejected','capacity-rejected','aborted','error'] as const
const guardFields = ['timestamp','level','event','schemaVersion','component','diagnosticId','requestFingerprintSha256','stage','operationStage','firstStage','phase','elapsedMs','code','errorClass','httpStatus','cancelled','intentMatch','targetMatch','sourceMatch','fenceMatch','snapshotMatch','factsMatch','differenceMask'] as const
const guardOperations = ['REQUEST_GATE','INTENT','TARGET_CAPTURE','ALBUM_MATERIALIZE','ALBUM_VALIDATE','SOURCE_CAPTURE','SOURCE_VALIDATE','SELECTED_SNAPSHOT','STOP_ACTIVE','PERSIST_QUEUE','RELEASE_CAPTURE','START_QUEUE','EDITION_RESOLVE','SECOND_CAPTURE','SECOND_FACTS','LEASE_REGISTER','SOURCE_NAMESPACE_CAPTURE','SOURCE_NAMESPACE_ACQUIRE','SOURCE_NAMED_CHECK','SOURCE_FD_OPEN','SOURCE_FD_STAT','SOURCE_FD_VERIFY','SOURCE_CLEANUP','SDK_SUBMIT','COMPLETED'] as const
const guardPhases = ['started','succeeded','failed','cleanup-failed'] as const
const guardCodes = ['NONE','UNKNOWN','BAD_REQUEST','INTERNAL_ERROR','ROON_ZONE_NOT_SELECTED','ROON_NOT_PAIRED','ROON_CORE_NOT_CONNECTED','ROON_TIMEOUT','ROON_MEDIA_ERROR','QUEUE_CONFLICT','INVENTORY_CONFLICT','INVALID_IPC_REQUEST','UNAVAILABLE','NOT_READY','LOCAL_SOURCE_CHANGED','INVALID_REQUEST','TARGET_CHANGED','FACTS_CHANGED','UNAUTHORIZED_ROOT','SEGMENT_UNSUPPORTED','READ_CANCELLED','READ_DEADLINE','ROON_TRANSPORT_UNAVAILABLE','INVENTORY_UNAVAILABLE'] as const
const guardErrors = ['NONE','BridgeError','DatasetOwnerDispatchError','LocalSourcePreparationError','Error','OTHER'] as const
const guardMatches = ['not-checked','match','mismatch'] as const
const guardHttpStatuses: readonly number[] = [0,400,401,403,404,409,412,415,422,429,500,503,504]
const fields = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value,key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!, 'value'))
}
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const choice = (value: unknown, choices: readonly string[]): value is string => typeof value === 'string' && choices.includes(value)
export type LocalPlaybackEvidenceRecord = Readonly<Record<string, string | number | boolean>>
/** false只拒收该来源的guard；日志写入抛错仍保留已验证ring，不影响原stdout。 */
export type LocalPlaybackGuardSink = (row: LocalPlaybackEvidenceRecord) => boolean | void

/** 任何额外字段、accessor或未知枚举都整条拒绝；不读错误文本、URL、路径或会话id。 */
export function copyLocalPlaybackEvidence(value: unknown): LocalPlaybackEvidenceRecord | null {
  try {
    if (!value || typeof value !== 'object') return null
    const read = (key: string): unknown => Object.getOwnPropertyDescriptor(value,key)?.value
    const stage = read('stage'), component = read('component')
    if (component === 'controller' && stage === 'request-guard') {
      if (!fields(value,guardFields)) return null
      const row = Object.fromEntries(guardFields.map(key => [key,read(key)]))
      if (row.schemaVersion !== 1 || row.level !== 'info' || row.event !== 'local_play_request_guard_evidence' || row.component !== 'controller' || row.stage !== 'request-guard'
        || typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.timestamp)
        || !Number.isFinite(Date.parse(row.timestamp)) || new Date(row.timestamp).toISOString() !== row.timestamp
        || typeof row.diagnosticId !== 'string' || !/^diag-local-[a-f0-9]{64}$/u.test(row.diagnosticId)
        || typeof row.requestFingerprintSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.requestFingerprintSha256)
        || !choice(row.operationStage,guardOperations) || !choice(row.firstStage,['NONE',...guardOperations])
        || !choice(row.phase,guardPhases) || !integer(row.elapsedMs,0,86_400_000) || !choice(row.code,guardCodes)
        || !choice(row.errorClass,guardErrors) || typeof row.httpStatus !== 'number' || !guardHttpStatuses.includes(row.httpStatus)
        || !choice(row.cancelled,['not-observed','yes']) || !integer(row.differenceMask,0,16383)
        || !['intentMatch','targetMatch','sourceMatch','fenceMatch','snapshotMatch','factsMatch'].every(key => choice(row[key],guardMatches))) return null
      return Object.freeze(row as Record<string,string | number | boolean>)
    }
    let keys: readonly string[]
    if (component === 'controller' && stage === 'roon-phase') keys = [...common,'sessionConfirmed','elapsedMs','phase']
    else if (component === 'controller' && stage === 'position') keys = [...common,'sessionConfirmed','elapsedMs','sampleSequence','source','positionMs','positionAdvanced']
    else if (component === 'gateway' && stage === 'request') keys = [...common,'requestSequence','method','routeClass','rangeClass']
    else if (component === 'gateway' && stage === 'truncated') keys = [...common,'requestSequence','method','routeClass','rangeClass','requestLimit']
    else if (component === 'gateway' && stage === 'transfer-terminal') keys = [...common,'requestSequence','method','routeClass','rangeClass','outcome','statusCode','pipelineBodyBytesObserved','observedBytesCapped','responseFinished','elapsedMs',
      ...(Object.hasOwn(value,'completedPipelineBodyBytes') ? ['completedPipelineBodyBytes'] : [])]
    else return null
    if (!fields(value,keys)) return null
    const row = Object.fromEntries(keys.map(key => [key,read(key)]))
    if (row.schemaVersion !== 1 || row.level !== 'info'
      || row.event !== (component === 'gateway' ? 'local_playback_media_evidence' : 'local_playback_evidence')
      || typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp))
      || typeof row.diagnosticId !== 'string' || !/^diag-local-[a-f0-9]{64}$/u.test(row.diagnosticId)
      || typeof row.currentOwned !== 'boolean' || typeof row.staleCallback !== 'boolean' || row.currentOwned && row.staleCallback) return null
    if (component === 'controller') {
      if (typeof row.sessionConfirmed !== 'boolean' || row.currentOwned && !row.sessionConfirmed || !integer(row.elapsedMs,0,86_400_000)) return null
      if (stage === 'roon-phase' && !choice(row.phase,phases)) return null
      if (stage === 'position' && (!integer(row.sampleSequence,1,2) || !choice(row.source,['audio-input','zone'])
        || !integer(row.positionMs,0,86_400_000) || row.positionAdvanced !== (row.sampleSequence === 2)
        || row.currentOwned !== true || row.sessionConfirmed !== true || row.staleCallback !== false)) return null
    } else {
      if (!integer(row.requestSequence,1,stage === 'truncated' ? 17 : 16) || !choice(row.method,['GET','HEAD']) || row.routeClass !== 'local-file'
        || !choice(row.rangeClass,['none','start-end','start-open','suffix','other'])) return null
      if (stage === 'truncated' && (row.requestSequence !== 17 || row.requestLimit !== 16)) return null
      if (stage === 'transfer-terminal') {
        if (!choice(row.outcome,outcomes) || !integer(row.statusCode,100,599) || !integer(row.pipelineBodyBytesObserved,0,Number.MAX_SAFE_INTEGER)
          || typeof row.observedBytesCapped !== 'boolean' || typeof row.responseFinished !== 'boolean' || !integer(row.elapsedMs,0,86_400_000)) return null
        if (row.method === 'HEAD' && (row.pipelineBodyBytesObserved !== 0 || Object.hasOwn(row,'completedPipelineBodyBytes'))) return null
        if (Object.hasOwn(row,'completedPipelineBodyBytes') && (row.outcome !== 'body-completed' || row.method !== 'GET'
          || row.responseFinished !== true || row.observedBytesCapped !== false || row.completedPipelineBodyBytes !== row.pipelineBodyBytesObserved)) return null
        if (row.outcome === 'body-completed' && (!Object.hasOwn(row,'completedPipelineBodyBytes') || row.responseFinished !== true || row.observedBytesCapped !== false)) return null
      }
    }
    return Object.freeze(row as Record<string,string | number | boolean>)
  } catch { return null }
}

/** 仅私有guard单行；同步写失败或短写只丢诊断输出，不经过stderr异步流。 */
export function writeLocalPlaybackGuardSync(value: unknown, fd = 2): boolean {
  try {
    const row = copyLocalPlaybackEvidence(value)
    if (!row || row.event !== 'local_play_request_guard_evidence' || !integer(fd,0,2_147_483_647)) return false
    const line = Buffer.from(JSON.stringify(row)+'\n','utf8')
    if (line.length > 8192) return false
    return writeSync(fd,line) === line.length
  } catch { return false }
}

/** 每个child单独创建；8KiB整行丢弃，最多256个已验证事件，不转发普通stdout。 */
export function createLocalPlaybackEvidenceCollector() {
  const rows: LocalPlaybackEvidenceRecord[] = []
  const legacy = { pending: '', dropping: false }
  let sources = new WeakMap<LocalPlaybackGuardSink, { pending: string; dropping: boolean }>()
  return {
    consume(chunk: string, guardSink?: LocalPlaybackGuardSink): void {
      try {
        let state = guardSink ? sources.get(guardSink) : legacy
        if (!state) { state = { pending: '', dropping: false }; sources.set(guardSink!,state) }
        for (const part of chunk.split(/(?<=\n)/u)) {
          const ended = part.endsWith('\n')
          if (state.pending.length + part.length > 8192) { state.pending = ''; state.dropping = true }
          if (!state.dropping) state.pending += part
          if (ended) {
            if (!state.dropping && state.pending.startsWith('{')) {
              try {
                const row = copyLocalPlaybackEvidence(JSON.parse(state.pending))
                if (row) {
                  let admit = true
                  if (row.event === 'local_play_request_guard_evidence') {
                    try { admit = guardSink?.(row) !== false } catch { /* 私有日志失败仍保留已验证ring。 */ }
                  }
                  if (admit) { rows.push(row); if (rows.length > 256) rows.shift() }
                }
              } catch { /* 非闭集日志忽略。 */ }
            }
            state.pending = ''; state.dropping = false
          }
        }
      } catch { /* 旁路不能影响原child读取、退出或回执。 */ }
    },
    snapshot(): readonly LocalPlaybackEvidenceRecord[] { return rows.map(row => Object.freeze({...row})) },
    clear(): void { rows.length = 0; legacy.pending = ''; legacy.dropping = false; sources = new WeakMap() },
  }
}
