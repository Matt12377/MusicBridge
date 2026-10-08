import { createHash } from 'node:crypto'
import { isCommandOutboxAction, isCommandOutboxAcknowledge, isCommandOutboxDatasetId, isCommandOutboxDispatchResult, isLocalSourceWritesOutboxCommand, isLocalSourceWritesReceipt, localSourceWritesDataSnapshot, localSourceWritesRequestCanonical, type LocalSourceWritesCommandPayloads, type CommandOutboxAction, type CommandOutboxAcknowledge, type CommandOutboxRequest, type CommandOutboxOverview, type CommandOutboxErrorCode } from '@music-bridge/contracts'
import { CommandOutboxError, type CommandOutboxStore, type StoredCommandOutboxEntry, type CommandOutboxConfirmation } from './command-outbox-store.js'

export interface CommandOutboxSubmission { outboxId: string; result: unknown }
const rejectedCodes: readonly CommandOutboxErrorCode[] = ['INVALID_IPC_REQUEST', 'INVENTORY_CONFLICT', 'BACKUP_CONFLICT', 'OUTBOX_CONFLICT']
const sourceWriteCommand = (command: string): boolean => command === 'localSourceWrites.confirm' || command === 'localSourceWrites.undo' || command === 'localSourceWrites.setPolicy'
/** 所有恢复发送均由 submit 新确认或 retry 人工入口触发；构造、查询和冷启动没有 executor 副作用。 */
export function createCommandOutboxService(options: {
  store: CommandOutboxStore
  currentDataset(): Promise<string>
  execute(entry: StoredCommandOutboxEntry): Promise<unknown>
  recoverAcrossDataset?(entry: StoredCommandOutboxEntry): Promise<{ found: boolean; result?: unknown }>
}) {
  const { store } = options
  const flights = new Map<string, Promise<CommandOutboxSubmission>>()
  let closed = false, closing: Promise<void> | undefined
  store.recoverInterrupted()
  function capturedSourceReceipt(entry: StoredCommandOutboxEntry, raw: unknown): unknown {
    if (!isLocalSourceWritesOutboxCommand(entry.command)) return raw
    let result: unknown
    try { result = localSourceWritesDataSnapshot(raw, 16384) } catch { throw new CommandOutboxError('OUTBOX_RESULT_UNKNOWN', entry.id) }
    const fingerprint = createHash('sha256').update(localSourceWritesRequestCanonical(entry.command, entry.payload as LocalSourceWritesCommandPayloads[typeof entry.command]), 'utf8').digest('hex')
    if (!isLocalSourceWritesReceipt(result) || result.datasetId !== entry.datasetId || result.command !== entry.command || result.commandId !== entry.commandId || result.requestFingerprint !== fingerprint) throw new CommandOutboxError('OUTBOX_RESULT_UNKNOWN', entry.id)
    return result
  }
  const response = (entry: StoredCommandOutboxEntry): CommandOutboxSubmission => ({ outboxId: entry.id, result: structuredClone(capturedSourceReceipt(entry, entry.result)) })
  function persistResult(entry: StoredCommandOutboxEntry, result: unknown): CommandOutboxSubmission {
    try {
      result = capturedSourceReceipt(entry, result)
      if (!isCommandOutboxDispatchResult({ command: entry.command, result })) throw new CommandOutboxError('OUTBOX_RESULT_UNKNOWN', entry.id)
      // 只有保存过且重新读取的结果可返回Renderer，executor成功并不等于outbox已确认。
      return response(store.succeed(entry.id, result))
    } catch {
      try { store.markUncertain(entry.id) } catch { /* 落盘不可用时保留sending，冷开转为uncertain。 */ }
      throw new CommandOutboxError('OUTBOX_RESULT_UNKNOWN', entry.id)
    }
  }
  function run(id: string, explicitRetry = false, executeSource?: (entry: StoredCommandOutboxEntry) => Promise<unknown>): Promise<CommandOutboxSubmission> {
    const pending = flights.get(id); if (pending) return pending
    const work = (async () => {
      const entry = store.get(id)
      if (sourceWriteCommand(entry.command) && (explicitRetry || !executeSource)) throw new CommandOutboxError('OUTBOX_CONFLICT', id)
      if (entry.state === 'succeeded') return response(entry)
      if (!['pending', 'uncertain'].includes(entry.state)) throw new CommandOutboxError('OUTBOX_CONFLICT', id)
      let dataset: string
      try { dataset = await options.currentDataset() } catch { store.markUncertain(id); throw new CommandOutboxError('OUTBOX_RESULT_UNKNOWN', id) }
      if (closed) { store.markUncertain(id); throw new CommandOutboxError('OUTBOX_UNAVAILABLE', id) }
      if (dataset !== entry.datasetId || !isCommandOutboxDatasetId(dataset)) {
        // 切库后只有人工恢复激活回执可跨scope查询；回调不允许再次停止、重启或执行业务。
        if (isCommandOutboxDatasetId(dataset) && explicitRetry && entry.command === 'recordingBackups.activate' && options.recoverAcrossDataset) {
          let recovered: { found: boolean; result?: unknown } | undefined
          try { recovered = await options.recoverAcrossDataset(structuredClone(entry)) } catch { /* 查询失败仍保留原scope和待确认记录。 */ }
          const dispatch = { command: entry.command, result: recovered?.result }
          if (recovered?.found === true && isCommandOutboxDispatchResult(dispatch) && dispatch.command === 'recordingBackups.activate'
            && ['active', 'failed', 'rolled-back', 'superseded'].includes(dispatch.result.state)
            && dispatch.result.restoreJobId === entry.payload.restoreJobId && dispatch.result.previousId === entry.payload.expectedActiveId) {
            store.markSending(id); return persistResult(entry, dispatch.result)
          }
        }
        store.markUncertain(id, 'OUTBOX_SCOPE_MISMATCH'); throw new CommandOutboxError('OUTBOX_SCOPE_MISMATCH', id)
      }
      const sending = store.markSending(id)
      let result: unknown
      try { result = await (sourceWriteCommand(sending.command) ? executeSource!(sending) : options.execute(sending)) }
      catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        if (rejectedCodes.includes(code as CommandOutboxErrorCode)) { store.reject(id, code as CommandOutboxErrorCode); throw new CommandOutboxError(code as CommandOutboxErrorCode, id) }
        store.markUncertain(id, code === 'OUTBOX_SCOPE_MISMATCH' ? code : 'OUTBOX_RESULT_UNKNOWN')
        throw new CommandOutboxError(code === 'OUTBOX_SCOPE_MISMATCH' ? code : 'OUTBOX_RESULT_UNKNOWN', id)
      }
      return persistResult(entry, result)
    })()
    flights.set(id, work)
    void work.finally(() => { if (flights.get(id) === work) flights.delete(id) }).catch(() => undefined)
    return work
  }
  function checkSubmission(submissionOptions?: { retryConfirmed?: true }): void {
    if (closed) throw new CommandOutboxError('OUTBOX_UNAVAILABLE')
    if (submissionOptions && (Object.keys(submissionOptions).some(key => key !== 'retryConfirmed') || submissionOptions.retryConfirmed !== undefined && submissionOptions.retryConfirmed !== true)) throw new CommandOutboxError('OUTBOX_CONFLICT')
  }
  async function dispatchConfirmed(value: CommandOutboxConfirmation, explicitRetry: boolean, executeSource?: (entry: StoredCommandOutboxEntry) => Promise<unknown>): Promise<CommandOutboxSubmission> {
    const flight = flights.get(value.entry.id)
    if (flight) return flight
    if (value.entry.state === 'succeeded') return response(value.entry)
    if (!value.created && explicitRetry && ['pending', 'uncertain'].includes(value.entry.state)) return run(value.entry.id, true)
    if (!value.created) throw new CommandOutboxError(value.entry.errorCode ?? 'OUTBOX_RESULT_UNKNOWN', value.entry.id)
    return run(value.entry.id, false, executeSource)
  }
  return {
    async submit(request: CommandOutboxRequest, submissionOptions?: { retryConfirmed?: true }): Promise<CommandOutboxSubmission> {
      checkSubmission(submissionOptions)
      if (sourceWriteCommand(request.command)) throw new CommandOutboxError('INVALID_IPC_REQUEST')
      return dispatchConfirmed(store.confirm(request), submissionOptions?.retryConfirmed === true)
    },
    /** 此入口只交给可信 Main 源写 handler；能力在回调中，不写入可重放的请求。 */
    async submitSourceWrites(request: CommandOutboxRequest, executeSource: (entry: StoredCommandOutboxEntry) => Promise<unknown>): Promise<CommandOutboxSubmission> {
      checkSubmission()
      if (!sourceWriteCommand(request.command) || typeof executeSource !== 'function') throw new CommandOutboxError('INVALID_IPC_REQUEST')
      return dispatchConfirmed(store.confirm(request), false, executeSource)
    },
    findSourceWrites(commandId: string, datasetId: string): StoredCommandOutboxEntry | null {
      const view = store.list().find(entry => entry.commandId === commandId && entry.datasetId === datasetId && sourceWriteCommand(entry.command))
      return view ? store.get(view.id) : null
    },
    /** 只保存 Owner 已核对的原命令回执；这里不会调用 executor 或申请 grant。 */
    reconcileSourceWrites(id: string, result: unknown): CommandOutboxSubmission | null {
      if (closed || flights.has(id)) return null
      const entry = store.get(id)
      if (!sourceWriteCommand(entry.command)) throw new CommandOutboxError('INVALID_IPC_REQUEST')
      result = capturedSourceReceipt(entry, result)
      if (entry.state === 'succeeded') return response(entry)
      if (!['pending', 'uncertain'].includes(entry.state)) return null
      if (!isCommandOutboxDispatchResult({ command: entry.command, result })) throw new CommandOutboxError('OUTBOX_RESULT_UNKNOWN', id)
      store.markSending(id)
      return persistResult(entry, result)
    },
    async submitPreparedRevocations(requests: readonly CommandOutboxRequest[], submissionOptions?: { retryConfirmed?: true }): Promise<readonly CommandOutboxSubmission[]> {
      checkSubmission(submissionOptions)
      const confirmed = store.confirmBatch(requests)
      // Main接手后独立完成分发；首项失败或Renderer断开不取消已经持久确认的尾项。
      const outcomes = await Promise.allSettled(confirmed.map(value => dispatchConfirmed(value, submissionOptions?.retryConfirmed === true)))
      const failed = outcomes.find(outcome => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      return outcomes.map(outcome => (outcome as PromiseFulfilledResult<CommandOutboxSubmission>).value)
    },
    async retry(request: CommandOutboxAction): Promise<CommandOutboxSubmission> {
      if (closed || !isCommandOutboxAction(request)) throw new CommandOutboxError('OUTBOX_CONFLICT')
      if (sourceWriteCommand(store.get(request.id).command)) throw new CommandOutboxError('OUTBOX_CONFLICT', request.id)
      return run(request.id, true)
    },
    ack(request: CommandOutboxAcknowledge) { if (closed || !isCommandOutboxAcknowledge(request)) throw new CommandOutboxError('OUTBOX_CONFLICT'); return store.ack(request.id) },
    dismiss(request: CommandOutboxAction) { if (closed || !isCommandOutboxAction(request) || flights.has(request.id)) throw new CommandOutboxError('OUTBOX_CONFLICT'); return store.dismiss(request.id) },
    async list(): Promise<CommandOutboxOverview> {
      let datasetId: string
      try { datasetId = await options.currentDataset() } catch { throw new CommandOutboxError('OUTBOX_UNAVAILABLE') }
      if (!isCommandOutboxDatasetId(datasetId)) throw new CommandOutboxError('OUTBOX_UNAVAILABLE')
      return { datasetId, entries: store.list().filter(entry => !entry.acknowledged && entry.state !== 'dismissed').map(entry => ({ ...entry,
        canRetry: entry.canRetry && (entry.datasetId === datasetId || entry.command === 'recordingBackups.activate' && !!options.recoverAcrossDataset) && !flights.has(entry.id) })) }
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      closing = Promise.allSettled([...flights.values()]).then(() => store.close())
      return closing
    },
  }
}
export type CommandOutboxService = ReturnType<typeof createCommandOutboxService>
