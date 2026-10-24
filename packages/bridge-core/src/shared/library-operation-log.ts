/** 资料库常开诊断：只记录闭集阶段、逻辑编号、计数和耗时，不记录路径、标签或图片。 */
export const LIBRARY_OPERATION_PREFIX = '[MB_LIBRARY_OPERATION] '
export type LibraryOperationPart = 'library' | 'scan' | 'metadata' | 'artwork' | 'cache' | 'worker' | 'ui'
export type LibraryOperationState = 'start' | 'progress' | 'complete' | 'error' | 'cancelled' | 'paused' | 'resumed' | 'hit' | 'miss' | 'skipped'
export interface LibraryOperationMetrics {
  id?: string; code?: string; elapsedMs?: number; queueWaitMs?: number; readMs?: number; parseMs?: number; commitMs?: number;
  slowAfterMs?: number; count?: number; total?: number; bytes?: number; offset?: number; roots?: number; visited?: number;
  accepted?: number; rejected?: number; active?: number; pending?: number; width?: number; height?: number;
}
export interface LibraryOperationEvent extends LibraryOperationMetrics {
  version: 1; part: LibraryOperationPart; action: string; state: LibraryOperationState; atMs: number; slow: boolean; message: string
}
const parts = new Set(['library', 'scan', 'metadata', 'artwork', 'cache', 'worker', 'ui'])
const states = new Set(['start', 'progress', 'complete', 'error', 'cancelled', 'paused', 'resumed', 'hit', 'miss', 'skipped'])
const numbers = new Set(['elapsedMs', 'queueWaitMs', 'readMs', 'parseMs', 'commitMs', 'slowAfterMs', 'count', 'total', 'bytes', 'offset', 'roots', 'visited', 'accepted', 'rejected', 'active', 'pending', 'width', 'height'])
const labels: Record<LibraryOperationPart, string> = { library: '音乐库', scan: '扫描', metadata: '标签解析', artwork: '封面处理', cache: '缓存', worker: 'Rust工作进程', ui: '资料库页面' }
const stateLabels: Record<LibraryOperationState, string> = { start: '开始', progress: '进度更新', complete: '完成', error: '失败', cancelled: '已取消', paused: '已暂停', resumed: '继续', hit: '命中', miss: '未命中', skipped: '跳过' }
const fields = new Set(['version', 'part', 'action', 'state', 'atMs', 'slow', 'message', 'id', 'code', ...numbers])
export function readLibraryOperationLine(line: string): LibraryOperationEvent | null {
  if (line.length > 2048 || !line.startsWith(LIBRARY_OPERATION_PREFIX)) return null
  try {
    const v: unknown = JSON.parse(line.slice(LIBRARY_OPERATION_PREFIX.length))
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const event = v as Record<string, unknown>
    if (Object.keys(event).some(key => !fields.has(key)) || event.version !== 1 || !parts.has(String(event.part)) || !states.has(String(event.state))
      || typeof event.action !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/u.test(event.action)
      || typeof event.slow !== 'boolean' || !Number.isSafeInteger(event.atMs) || Number(event.atMs) < 0) return null
    if (event.message !== `${labels[event.part as LibraryOperationPart]}：${stateLabels[event.state as LibraryOperationState]}`) return null
    for (const [key, value] of Object.entries(event)) {
      if (numbers.has(key) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) return null
      if (key === 'id' && (typeof value !== 'string' || !/^[a-f0-9-]{1,128}$/u.test(value))) return null
      if (key === 'code' && (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value))) return null
    }
    return event as unknown as LibraryOperationEvent
  } catch { return null }
}
export function logLibraryOperation(part: LibraryOperationPart, action: string, state: LibraryOperationState, metrics: LibraryOperationMetrics = {}): void {
  try {
    const elapsed = metrics.elapsedMs ?? 0, threshold = metrics.slowAfterMs ?? 250
    const line = LIBRARY_OPERATION_PREFIX + JSON.stringify({ version: 1, part, action, state, atMs: Date.now(), ...metrics, slow: elapsed >= threshold, message: `${labels[part]}：${stateLabels[state]}` })
    if (readLibraryOperationLine(line)) console.info(line)
  } catch { /* 诊断输出失败不改变扫描、取消或事务结果。 */ }
}
type LibraryRemovalStage='main.initial'|'main.intent'|'main.execute'|'main.result'|'owner.execute'|'owner.fence'|'owner.commit'
/** 原移除阶段只输出闭集首码与耗时；绝不展开异常、路径或用户名称。 */
export async function traceLibraryRemoval<T>(stage:LibraryRemovalStage,id:string,work:()=>T|Promise<T>):Promise<T> {
  const started=performance.now();logLibraryOperation('library','remove.'+stage,'start',{id})
  try{const result=await work();logLibraryOperation('library','remove.'+stage,'complete',{id,elapsedMs:Math.max(0,performance.now()-started)});return result}
  catch(error){
    let code='UNKNOWN'
    try{const descriptor=error!==null&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code'):undefined,value=descriptor&&'value'in descriptor?descriptor.value:undefined
      if(typeof value==='string'&&['TIMEOUT','NOT_READY','OUTBOX_SCOPE_MISMATCH','INVALID_IPC_REQUEST','INVALID_IPC_RESPONSE','INVALID_CAPTURE','INVALID_REQUEST','CHANGED','INVENTORY_CONFLICT','INVENTORY_UNAVAILABLE'].includes(value))code=value}catch{ /* 不读取异常getter。 */ }
    logLibraryOperation('library','remove.'+stage,'error',{id,code,elapsedMs:Math.max(0,performance.now()-started)});throw error
  }
}
type LibraryImportStage='main.native'|'main.authorize'|'main.held'|'main.registration'|'main.bridge-held'|'main.bridge-approved'|'main.bridge-registration'|'main.cleanup'
  |'owner.proof'|'owner.proof-check'|'owner.authorize'|'owner.fd'|'owner.fd-check'|'owner.role'|'owner.role-budget-check'
/** 目录准备只输出固定阶段、耗时与闭集错误码；不读取异常正文或getter。 */
export async function traceLibraryImport<T>(stage:LibraryImportStage,id:string|undefined,work:()=>T|Promise<T>):Promise<T> {
  const started=performance.now();logLibraryOperation('library','import.'+stage,'start',{...(id?{id}:{})})
  try{const result=await work();logLibraryOperation('library','import.'+stage,'complete',{...(id?{id}:{}),elapsedMs:Math.max(0,performance.now()-started)});return result}
  catch(error){
    let code='UNKNOWN'
    try{if(error!==null&&typeof error==='object'){
      const descriptor=Object.getOwnPropertyDescriptor(error,'code'),value=descriptor&&'value'in descriptor?descriptor.value:undefined
      if(typeof value==='string'&&['TIMEOUT','NOT_READY','OUTBOX_SCOPE_MISMATCH','INVALID_IPC_REQUEST','INVALID_IPC_RESPONSE','INVALID_CAPTURE','INVALID_REQUEST','CHANGED','INVENTORY_CONFLICT','INVENTORY_UNAVAILABLE',
        'EACCES','EPERM','ENOENT','ENOTDIR','EIO','EAGAIN','EWOULDBLOCK','ESTALE','EBADF','ELOOP','ENAMETOOLONG','ETIMEDOUT'].includes(value))code=value
      const closed=Object.getOwnPropertyDescriptor(error,'physicalClosed');if(closed&&'value'in closed&&typeof closed.value==='boolean')code=closed.value?'PROBE_FAILED_CLOSED':'PROBE_CLOSE_UNKNOWN'
    }}catch{ /* 诊断不能触发异常对象的自由属性访问。 */ }
    logLibraryOperation('library','import.'+stage,'error',{...(id?{id}:{}),code,elapsedMs:Math.max(0,performance.now()-started)});throw error
  }
}
/** 逐行闭集转发；超长行整行丢弃，不能把尾部误当成新记录。 */
export function createLibraryOperationLogReader(write: (line: string) => void): (chunk: string) => void {
  let pending = '', discard = false
  return chunk => {
    for (const part of chunk.split(/(?<=\n)/u)) {
      if (!discard) pending += part
      if (pending.length > 2048) { pending = ''; discard = true }
      if (!part.endsWith('\n')) continue
      if (!discard) { const event = readLibraryOperationLine(pending.trimEnd()); if (event) { try { write(LIBRARY_OPERATION_PREFIX + JSON.stringify(event) + '\n') } catch { /* 原操作继续。 */ } } }
      pending = ''; discard = false
    }
  }
}
