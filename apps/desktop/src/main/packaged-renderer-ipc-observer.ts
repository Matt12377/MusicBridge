import { types } from 'node:util'

export interface PackagedRendererIpcSender {
  webContentsId: number
  rendererPid: number
  frameUrl: string
  trusted: true
}
const channels = new Set(['collection:list', 'collection:detail', 'commandOutbox:context', 'commandOutbox:overview',
  'commandOutbox:submit', 'commandOutbox:revokePreparedBatch', 'commandOutbox:retry', 'commandOutbox:dismiss', 'commandOutbox:acknowledge'])
const publicCodes = new Set(['NOT_READY', 'INVALID_IPC_REQUEST', 'INVALID_IPC_RESPONSE', 'INTERNAL_ERROR', 'INVENTORY_CONFLICT',
  'BACKUP_CONFLICT', 'OUTBOX_CONFLICT', 'OUTBOX_UNAVAILABLE', 'OUTBOX_SCOPE_MISMATCH', 'OUTBOX_LIMIT_EXCEEDED', 'OUTBOX_RESULT_UNKNOWN'])
let invocationSequence = 0
function publicCode(error: unknown): string {
  try {
    if (error instanceof Error) {
      const code = /\[([A-Z_]+)\]/u.exec(error.message)?.[1]
      if (code && publicCodes.has(code)) return code
    }
  } catch { /* 观察失败不借错误对象扩展业务行为。 */ }
  return 'INTERNAL_ERROR'
}
export function observePackagedRendererIpc<E, A extends unknown[], R>(options: {
  channel: string
  listener(event: E, ...args: A): R
  trustedSender(event: E): PackagedRendererIpcSender | undefined
  observe(event: string, data: Record<string, unknown>): unknown
}): (event: E, ...args: A) => R {
  if (!channels.has(options.channel)) return options.listener
  function observe(event: string, data: Record<string, unknown>): void {
    try {
      const returned = options.observe(event, structuredClone(data))
      if (returned !== undefined) void Promise.resolve(returned).catch(() => {})
    } catch { /* 严格 Gate 拒绝缺失观察；原 listener 与回执保持。 */ }
  }
  return (event, ...args) => {
    let sender: PackagedRendererIpcSender | undefined
    try { sender = options.trustedSender(event) } catch { /* 原 listener 仍自行验证并返回原拒绝。 */ }
    if (!sender) return options.listener(event, ...args)
    const invokeId = `ipc-${++invocationSequence}`, channel = options.channel
    observe('main.ipcRequest', { invokeId, channel, args, sender })
    let result: R
    try { result = options.listener(event, ...args) }
    catch (error) { observe('main.ipcRejected', { invokeId, channel, code: publicCode(error) }); throw error }
    // 原 Promise 身份与完成时刻不变，只登记消费后的独立旁路。
    if (types.isPromise(result)) {
      try {
        void result.then(value => { observe('main.ipcReply', { invokeId, channel, result: value }) },
          error => { observe('main.ipcRejected', { invokeId, channel, code: publicCode(error) }) }).catch(() => {})
      } catch { /* 非标准 Promise 的观察异常不能改变原返回。 */ }
    } else observe('main.ipcReply', { invokeId, channel, result })
    return result
  }
}
