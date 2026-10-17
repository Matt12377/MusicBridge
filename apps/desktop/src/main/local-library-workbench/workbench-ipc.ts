import { randomUUID } from 'node:crypto'
import * as dto from '@music-bridge/contracts'

type Result = dto.LocalWorkbenchCommandResults[dto.LocalWorkbenchCommand]
export type LocalWorkbenchMainRequest = { [C in dto.LocalWorkbenchCommand]: { command: C; payload: dto.LocalWorkbenchCommandPayloads[C] } }[dto.LocalWorkbenchCommand]
export interface LocalWorkbenchMainEvent {
  senderFrame?: { url?: string } | null
  sender: { id: number; isDestroyed?(): boolean; once?(name: 'destroyed', listener: () => void): unknown; removeListener?(name: 'destroyed', listener: () => void): unknown }
}
export interface LocalWorkbenchMainContext { datasetId: string; signal: AbortSignal; /** 当前实际Main作者的闭包；不序列化，不构成SourceFiles许可。 */ assertCurrent?(): void | Promise<void> }
export interface LocalWorkbenchIpcOptions {
  ipcMain: { handle(channel: string, handler: (event: LocalWorkbenchMainEvent, value: unknown) => Promise<unknown>): void; removeHandler?(channel: string): void }
  assertTrusted(event: LocalWorkbenchMainEvent): void
  assertDataset(datasetId: string): void | Promise<void>
  /** 在首个await后固定同一真实作者；相同dataset的新代不能接收旧回复。 */
  captureAuthor?(datasetId: string): Promise<() => Promise<void>>
  /** 此端口必须接实际 Main/Core 服务；IPC 不构造替代 writer 或不可用占位服务。 */
  request(request: LocalWorkbenchMainRequest, context: LocalWorkbenchMainContext): Promise<Result>
  /** 主机生命周期关闭原生选择器或受控来源，随后仍等待原 Promise 完成。 */
  closeReadResources?(): Promise<void>
}
interface Pending { datasetId: string; controller: AbortController; task: Promise<Result> }
interface SenderState {
  event: LocalWorkbenchMainEvent
  active: Map<string, Pending>
  used: Map<string, number>
  cancelledBeforeRead: Map<string, { datasetId: string; at: number }>
  destroyed(): void
}
const invalid = (): never => { throw new Error('整理请求无效，请重新读取。') }
const abortError = (): Error => { const error = new Error('整理读取已取消。'); error.name = 'AbortError'; return error }
const closedRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'))
}

/** sender/工作库/nonce 围栏与有限读租约；确认取消不等于底层已退出。 */
export function registerLocalWorkbenchIpc(options: LocalWorkbenchIpcOptions) {
  const senders = new Map<number, SenderState>(), writes = new Set<Promise<Result>>()
  const channels = ['localWorkbench:request', 'localWorkbench:read', 'localWorkbench:cancelRead'] as const
  let closing = false, closeTask: Promise<void> | null = null, sealingReads: Promise<void> | null = null
  async function check(event: LocalWorkbenchMainEvent, datasetId: string): Promise<void> {
    options.assertTrusted(event)
    if (closing || event.sender.isDestroyed?.()) throw new Error('整理读取已关闭，请重新加载。')
    await options.assertDataset(datasetId)
    options.assertTrusted(event)
    if (closing || event.sender.isDestroyed?.()) throw new Error('整理读取已关闭，请重新加载。')
  }
  function sender(event: LocalWorkbenchMainEvent): SenderState {
    const existing = senders.get(event.sender.id)
    if (existing) {
      if (existing.event.sender !== event.sender) return invalid()
      return existing
    }
    if (senders.size >= 32) throw new Error('整理窗口读取数已达上限，请关闭已不用的窗口。')
    const state: SenderState = { event, active: new Map(), used: new Map(), cancelledBeforeRead: new Map(), destroyed() {
      for (const pending of state.active.values()) pending.controller.abort()
      state.cancelledBeforeRead.clear(); state.used.clear()
      // 活动 Promise 尚未收口时保留记录，close() 必须还能等待它。
      if (!state.active.size) senders.delete(event.sender.id)
    } }
    event.sender.once?.('destroyed', state.destroyed); senders.set(event.sender.id, state)
    return state
  }
  function prune(state: SenderState): void {
    const before = Date.now() - 30 * 60 * 1000
    for (const [id, at] of state.used) if (at < before) state.used.delete(id)
    for (const [id, value] of state.cancelledBeforeRead) if (value.at < before) state.cancelledBeforeRead.delete(id)
  }
  function validateResult(request: LocalWorkbenchMainRequest, result: unknown, datasetId: string): Result {
    if (!dto.isLocalWorkbenchCommandResult(request.command, result, request.payload)
      || request.command === 'localWorkbench.read' && (result as dto.LocalWorkbenchReadback).datasetId !== datasetId) return invalid()
    return structuredClone(result) as Result
  }
  async function runRead(event: LocalWorkbenchMainEvent, datasetId: string, envelope: dto.LocalWorkbenchReadRequestEnvelope): Promise<Result> {
    await check(event, datasetId)
    const state = sender(event); prune(state)
    if (state.active.has(envelope.requestId) || state.used.has(envelope.requestId)) throw new Error('同一整理读取编号不能重复发送。')
    const early = state.cancelledBeforeRead.get(envelope.requestId)
    if (early) {
      state.cancelledBeforeRead.delete(envelope.requestId); state.used.set(envelope.requestId, Date.now())
      if (early.datasetId !== datasetId) return invalid()
      throw abortError()
    }
    if (state.active.size >= 24 || state.used.size >= 1024) throw new Error('整理读取达到当前窗口预算，请等待或重新加载。')
    let assertCurrent: (() => Promise<void>) | undefined
    const controller = new AbortController(), request = { command: envelope.command, payload: envelope.payload } as LocalWorkbenchMainRequest
    // 在作者异步回读前登记nonce，重复请求/早到取消和close都能命中原活动Promise。
    const task = Promise.resolve().then(async () => {
      if (options.captureAuthor) {
        assertCurrent = await options.captureAuthor(datasetId)
        await check(event, datasetId); await assertCurrent()
      }
      if (controller.signal.aborted) throw abortError()
      return options.request(request, { datasetId, signal: controller.signal, ...(assertCurrent ? { assertCurrent } : {}) })
    })
    const pending: Pending = { datasetId, controller, task }; state.active.set(envelope.requestId, pending)
    try {
      const result = await task
      if (assertCurrent) await assertCurrent(); await check(event, datasetId)
      if (controller.signal.aborted) throw abortError()
      return validateResult(request, result, datasetId)
    } catch (error) {
      if (controller.signal.aborted) throw abortError()
      // 模型端点、源 URL、路径、凭据和内部错误栈不转入 Renderer。
      if (error instanceof Error && error.name === 'AbortError') throw abortError()
      throw new Error('整理读取未完成，请重新读取或查看该项状态。')
    } finally {
      if (state.active.get(envelope.requestId) === pending) state.active.delete(envelope.requestId)
      state.used.set(envelope.requestId, Date.now())
      if (event.sender.isDestroyed?.() && !state.active.size) senders.delete(event.sender.id)
    }
  }
  options.ipcMain.handle('localWorkbench:read', async (event, value) => {
    options.assertTrusted(event)
    if (!closedRecord(value, ['datasetId', 'request']) || !dto.isCommandOutboxDatasetId(value.datasetId) || !dto.isLocalWorkbenchReadRequestEnvelope(value.request)) return invalid()
    const datasetId = value.datasetId, request = structuredClone(value.request)
    if ('datasetId' in request.payload && request.payload.datasetId !== datasetId) return invalid()
    return runRead(event, datasetId, request)
  })
  options.ipcMain.handle('localWorkbench:cancelRead', async (event, value) => {
    options.assertTrusted(event)
    if (!closedRecord(value, ['datasetId', 'request']) || !dto.isCommandOutboxDatasetId(value.datasetId) || !dto.isLocalWorkbenchCancelReadRequest(value.request)) return invalid()
    const datasetId = value.datasetId, id = value.request.requestId
    await check(event, datasetId)
    const state = sender(event); prune(state)
    const pending = state.active.get(id)
    if (pending) {
      if (pending.datasetId !== datasetId) return invalid()
      pending.controller.abort(); return { cancelled: true }
    }
    if (state.used.has(id)) return { cancelled: false }
    if (state.cancelledBeforeRead.size >= 128) throw new Error('待确认取消读取达到预算，请重新加载。')
    const previous = state.cancelledBeforeRead.get(id)
    if (previous && previous.datasetId !== datasetId) return invalid()
    state.cancelledBeforeRead.set(id, { datasetId, at: Date.now() })
    return { cancelled: true }
  })
  options.ipcMain.handle('localWorkbench:request', async (event, value) => {
    options.assertTrusted(event)
    if (!closedRecord(value, ['datasetId', 'command', 'payload']) || !dto.isCommandOutboxDatasetId(value.datasetId)
      || !(dto.LOCAL_WORKBENCH_COMMANDS as readonly unknown[]).includes(value.command)
      || !dto.isLocalWorkbenchCommandPayload(value.command as dto.LocalWorkbenchCommand, value.payload)) return invalid()
    const datasetId = value.datasetId, request = structuredClone({ command: value.command, payload: value.payload }) as LocalWorkbenchMainRequest
    if ('datasetId' in request.payload && request.payload.datasetId !== datasetId
      || request.command === 'localWorkbench.plan.cancel' && request.payload.original.datasetId !== datasetId) return invalid()
    await check(event, datasetId)
    if (dto.isLocalWorkbenchReadCommand(request.command)) return runRead(event, datasetId, { ...request, requestId: randomUUID() } as dto.LocalWorkbenchReadRequestEnvelope)
    // 应用、原回执查询和任务取消不共享读取取消信号；关闭面板不能撤回应用。
    let assertCurrent: (() => Promise<void>) | undefined
    const task = Promise.resolve().then(async () => {
      if (options.captureAuthor) {
        assertCurrent = await options.captureAuthor(datasetId)
        await check(event, datasetId); await assertCurrent()
      }
      return options.request(request, { datasetId, signal: new AbortController().signal, ...(assertCurrent ? { assertCurrent } : {}) })
    })
    writes.add(task)
    try {
      const result = await task
      if (assertCurrent) await assertCurrent(); await check(event, datasetId)
      return validateResult(request, result, datasetId)
    } catch { throw new Error('原操作结果尚未确认，请按原命令查看回执。') }
    finally { writes.delete(task) }
  })
  function sealReads():Promise<void>{
    if(!sealingReads){
      closing=true
      for(const state of senders.values())for(const pending of state.active.values())pending.controller.abort()
      for(const channel of channels)options.ipcMain.removeHandler?.(channel)
      const cleanup=Promise.resolve().then(()=>options.closeReadResources?.())
      sealingReads=Promise.allSettled([cleanup,...[...senders.values()].flatMap(state=>[...state.active.values()].map(pending=>pending.task))]).then(results=>{if(results[0]?.status==='rejected')throw results[0].reason})
    }
    return sealingReads
  }
  return {
    sealReads,
    close(): Promise<void> {
      if (closeTask) return closeTask
      closeTask = (async () => {
        const cleanup = sealReads()
        // 立刻登记cleanup的拒绝处理；资源关闭出错时也必须等待已在执行的读取。
        const results = await Promise.allSettled([cleanup, ...writes])
        for (const state of senders.values()) state.event.sender.removeListener?.('destroyed', state.destroyed)
        senders.clear()
        if (results[0]?.status === 'rejected') throw results[0].reason
      })()
      return closeTask
    },
    pendingReads(): number { return [...senders.values()].reduce((sum, state) => sum + state.active.size, 0) },
  }
}
