import type { CommandOutboxRequest, CommandOutboxTrackedCommand, CommandOutboxDispatchResult } from '@music-bridge/contracts'

type Payload<C extends CommandOutboxTrackedCommand> = Extract<CommandOutboxRequest, { command: C }>['payload']
type Result<C extends CommandOutboxTrackedCommand> = Extract<CommandOutboxDispatchResult, { command: C }>['result']
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const safeCodes = new Set(['OUTBOX_UNAVAILABLE', 'OUTBOX_CONFLICT', 'OUTBOX_SCOPE_MISMATCH', 'OUTBOX_LIMIT_EXCEEDED', 'OUTBOX_RESULT_UNKNOWN', 'INVALID_IPC_REQUEST', 'INVENTORY_CONFLICT'])
const failure = (code: string): Error => new Error(`[${code}] 操作回执尚未确认，请查看未确认操作；工作库变化后须重新加载。`)

/** sandbox预加载只用本地信封检查；Main负责领域DTO校验。身份固定在本次Renderer加载，不在发送时换库。 */
export function createCommandOutboxClient(invoke: (channel: string, value?: unknown) => Promise<unknown>) {
  const scope = invoke('commandOutbox:context').then(value => {
    if (!record(value) || !uuid(value.datasetId) || Object.keys(value).some(key => key !== 'datasetId')) throw failure('OUTBOX_UNAVAILABLE')
    return value.datasetId
  }).catch(() => { throw failure('OUTBOX_UNAVAILABLE') })
  void scope.catch(() => undefined)
  const failed = new Set<string>()
  return {
    async submitPreparedRevocations(payloads: readonly Payload<'recordingPrepared.revoke'>[]): Promise<readonly Result<'recordingPrepared.revoke'>[]> {
      const captured = structuredClone(payloads)
      if (!Array.isArray(captured) || captured.length < 1 || captured.length > 3) throw failure('INVALID_IPC_REQUEST')
      const keys = captured.map(payload => `recordingPrepared.revoke:${payload.commandId}`), datasetId = await scope
      let reply: unknown
      try {
        reply = await invoke('commandOutbox:revokePreparedBatch', {
          requests: captured.map(payload => ({ datasetId, command: 'recordingPrepared.revoke', payload })),
          ...(keys.some(key => failed.has(key)) ? { retryConfirmed: true } : {}),
        })
      } catch { for (const key of keys) if (failed.size < 1000) failed.add(key); throw failure('OUTBOX_RESULT_UNKNOWN') }
      if (!record(reply) || reply.ok !== true || !Array.isArray(reply.submissions) || reply.submissions.length !== captured.length
        || !reply.submissions.every(value => record(value) && uuid(value.outboxId) && 'result' in value)
        || new Set(reply.submissions.map(value => value.outboxId)).size !== captured.length) {
        for (const key of keys) if (failed.size < 1000) failed.add(key)
        throw failure(record(reply) && typeof reply.code === 'string' && safeCodes.has(reply.code) ? reply.code : 'OUTBOX_RESULT_UNKNOWN')
      }
      for (const key of keys) failed.delete(key)
      for (const submission of reply.submissions) await invoke('commandOutbox:acknowledge', { id: submission.outboxId }).catch(() => undefined)
      return reply.submissions.map(value => value.result) as Result<'recordingPrepared.revoke'>[]
    },
    async submit<C extends CommandOutboxTrackedCommand>(command: C, payload: Payload<C>): Promise<Result<C>> {
      // 等待context前复制原输入，表单随后变化不能改写已确认意图。
      const captured = structuredClone(payload), key = `${command}:${captured.commandId}`
      const datasetId = await scope
      let reply: unknown
      try {
        reply = await invoke('commandOutbox:submit', { request: { datasetId, command, payload: captured }, ...(failed.has(key) ? { retryConfirmed: true } : {}) })
      } catch { failed.add(key); throw failure('OUTBOX_RESULT_UNKNOWN') }
      if (!record(reply) || reply.ok !== true || !uuid(reply.outboxId) || !('result' in reply)) {
        if (failed.size < 1000) failed.add(key)
        const code = record(reply) && typeof reply.code === 'string' && safeCodes.has(reply.code) ? reply.code : 'OUTBOX_RESULT_UNKNOWN'
        throw failure(code)
      }
      failed.delete(key)
      // 业务结果已持久；接收确认失败时保留Main待确认记录，不伪装业务失败。
      await invoke('commandOutbox:acknowledge', { id: reply.outboxId }).catch(() => undefined)
      return reply.result as Result<C>
    },
  }
}
