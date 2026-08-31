import { isCommandOutboxRequest, isCommandOutboxAction, isCommandOutboxAcknowledge, type CommandOutboxContext } from '@music-bridge/contracts'
import { CommandOutboxError, type CommandOutboxStore } from './command-outbox-store.js'
import type { CommandOutboxService } from './command-outbox-service.js'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const invalid = (): never => { throw new CommandOutboxError('INVALID_IPC_REQUEST') }
/** 唯一持久命令入口；旧领域读取接口继续保留，任意内部命令不会注册到此处。 */
export function installCommandOutboxIpc<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  context(): Promise<CommandOutboxContext>
  service: CommandOutboxService
  store: CommandOutboxStore
}) {
  const { service, store } = options
  const handle = (channel: string, action: (value?: unknown) => unknown) => options.handle(channel, async (event, value) => {
    options.requireTrusted(event)
    try { return await action(value) }
    catch (error) {
      const code = error instanceof CommandOutboxError ? error.code : 'OUTBOX_UNAVAILABLE'
      throw new Error(`[${code}] 未确认操作暂时不可用；原命令保留，请刷新状态。`)
    }
  })
  handle('commandOutbox:context', () => options.context())
  handle('commandOutbox:overview', () => service.list())
  handle('commandOutbox:submit', async value => {
    try {
      if (!record(value) || Object.keys(value).some(key => !['request', 'retryConfirmed'].includes(key))
        || value.retryConfirmed !== undefined && value.retryConfirmed !== true || !isCommandOutboxRequest(value.request)) return { ok: false, code: 'INVALID_IPC_REQUEST' }
      const result = await service.submit(value.request, value.retryConfirmed === true ? { retryConfirmed: true } : undefined)
      return { ok: true, ...result }
    } catch (error) { return { ok: false, code: error instanceof CommandOutboxError ? error.code : 'OUTBOX_RESULT_UNKNOWN' } }
  })
  handle('commandOutbox:revokePreparedBatch', async value => {
    try {
      if (!record(value) || Object.keys(value).some(key => !['requests', 'retryConfirmed'].includes(key))
        || value.retryConfirmed !== undefined && value.retryConfirmed !== true || !Array.isArray(value.requests)
        || value.requests.length < 1 || value.requests.length > 3
        || !value.requests.every(request => isCommandOutboxRequest(request) && request.command === 'recordingPrepared.revoke')) return { ok: false, code: 'INVALID_IPC_REQUEST' }
      const submissions = await service.submitPreparedRevocations(value.requests, value.retryConfirmed === true ? { retryConfirmed: true } : undefined)
      return { ok: true, submissions }
    } catch (error) { return { ok: false, code: error instanceof CommandOutboxError ? error.code : 'OUTBOX_RESULT_UNKNOWN' } }
  })
  handle('commandOutbox:retry', async value => {
    if (!isCommandOutboxAction(value)) return invalid()
    await service.retry(value)
    const result = store.list().find(entry => entry.id === value.id)
    if (!result) throw new CommandOutboxError('OUTBOX_UNAVAILABLE')
    return result
  })
  handle('commandOutbox:dismiss', value => { if (!isCommandOutboxAction(value)) return invalid(); return service.dismiss(value) })
  handle('commandOutbox:acknowledge', value => { if (!isCommandOutboxAcknowledge(value)) return invalid(); return service.ack(value) })
}
