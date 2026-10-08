import { createHash, randomUUID } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js'
import type { createCommandOutboxService } from './command-outbox-service.js'

export const sourceWriteFingerprint = <C extends dto.LocalSourceWritesCommand>(command: C, request: dto.LocalSourceWritesCommandPayloads[C]): string => createHash('sha256').update(dto.localSourceWritesRequestCanonical(command, request), 'utf8').digest('hex')
const invalid = () => new CoreIpcError('INVALID_IPC_REQUEST', '源写请求范围或字段无效。')

/** 普通 Core 没有文件写能力；此闭集 Main 路由独占具体确认的物理端口。 */
export function installLocalSourceWritesHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  supervisor: Pick<CoreSupervisor, 'request' | 'requestSourceWrites'>
  outbox: ReturnType<typeof createCommandOutboxService>
}) {
  let closed = false
  options.handle('localSourceWrites:request', async (event, raw) => {
    options.requireTrusted(event)
    if (closed) throw new CoreIpcError('NOT_READY', '源写入口已关闭。')
    let captured: unknown
    try { captured = dto.localSourceWritesDataSnapshot(raw, dto.LOCAL_SOURCE_WRITES_BUDGET.requestBytes, dto.LOCAL_SOURCE_WRITES_BUDGET.requestNodes) } catch { throw invalid() }
    if (!dto.localSourceWritesRecord(captured, ['datasetId', 'command', 'payload']) || !dto.isLocalSourceWritesDatasetId(captured.datasetId) || !dto.isLocalSourceWritesCommand(captured.command)) throw invalid()
    const command = captured.command, payload = captured.payload, datasetId = captured.datasetId
    if (!dto.isLocalSourceWritesCommandPayload(command, payload) || payload.datasetId !== datasetId) throw invalid()
    const validated = dto.validateIpcRequest({ version: dto.IPC_VERSION, id: randomUUID(), command, payload, expectedDatasetId: datasetId })
    if (!validated.ok) throw invalid()
    const request = validated.value.payload as dto.LocalSourceWritesCommandPayloads[typeof command]
    const fingerprint = sourceWriteFingerprint(command, request)
    const alive = () => { if (closed) throw new CoreIpcError('NOT_READY', '源写入口已关闭。'); options.requireTrusted(event) }
    const captureResult = (value: unknown): dto.LocalSourceWritesCommandResults[typeof command] => {
      let result: unknown
      try { result = dto.localSourceWritesDataSnapshot(value, dto.LOCAL_SOURCE_WRITES_BUDGET.planBytes, dto.LOCAL_SOURCE_WRITES_BUDGET.publicNodes) } catch { throw new CoreIpcError('INVALID_IPC_RESPONSE', '源写回执预算无效。') }
      if (!dto.isLocalSourceWritesCommandResult(command, result) || result.datasetId !== datasetId) throw new CoreIpcError('INVALID_IPC_RESPONSE', '源写回执范围无效。')
      if (command !== 'localSourceWrites.get' && command !== 'localSourceWrites.history') {
        const receipt = result as dto.LocalSourceWritesReceipt, original = request as dto.PreviewLocalSourceWrites
        if (receipt.command !== command || receipt.commandId !== original.commandId || receipt.requestFingerprint !== fingerprint) throw new CoreIpcError('INVALID_IPC_RESPONSE', '源写原请求回执无效。')
      }
      return result
    }
    let rawResult: unknown
    if (dto.isLocalSourceWritesOutboxCommand(command)) {
      const submission = await options.outbox.submitSourceWrites({ datasetId, command, payload: request } as dto.CommandOutboxRequest, async entry => {
        if (entry.datasetId !== datasetId || entry.command !== command || sourceWriteFingerprint(command, entry.payload as dto.LocalSourceWritesCommandPayloads[typeof command]) !== fingerprint) throw invalid()
        if (command !== 'localSourceWrites.confirm') return captureResult(await options.supervisor.request(command, entry.payload as dto.LocalSourceWritesCommandPayloads[typeof command], datasetId))
        alive()
        const confirm = request as dto.ConfirmLocalSourceWrites
        const challenge = await options.supervisor.requestSourceWrites('localSourceWrites.challenge', { datasetId, confirm })
        if (challenge.datasetId !== datasetId || challenge.commandId !== confirm.commandId || challenge.planId !== confirm.planId || challenge.expectedViewRevision !== confirm.expectedViewRevision || challenge.range !== confirm.range || challenge.planHash !== confirm.planHash || challenge.contextFingerprint !== confirm.contextFingerprint || challenge.requestFingerprint !== fingerprint || Date.parse(challenge.expiresAt) <= Date.now()) throw new CoreIpcError('INVALID_IPC_RESPONSE', '具体源写确认绑定已变化。')
        alive()
        // grant 始终留在 Main/Owner；Renderer 收到的只有持久受理回执。
        return captureResult(await options.supervisor.requestSourceWrites('localSourceWrites.executeGranted', { datasetId, confirm, grant: challenge.grant }))
      })
      rawResult = submission.result
    } else {
      if (!dto.isLocalSourceWritesCommandPayload(command, request)) throw invalid()
      rawResult = await options.supervisor.request(command, request, datasetId)
    }
    const result = captureResult(rawResult)
    if (command === 'localSourceWrites.get') {
      const query = request as dto.GetLocalSourceWrites, value = result as dto.LocalSourceWritesGetResult
      if (query.selector.kind !== value.kind || query.selector.kind === 'plan' && value.kind === 'plan' && value.plan && value.plan.planId !== query.selector.planId) throw new CoreIpcError('INVALID_IPC_RESPONSE', '源写查询身份无效。')
      if (query.selector.kind === 'command' && value.kind === 'command') {
        if (value.commandId !== query.selector.commandId || value.expectedCommand !== query.selector.expectedCommand || value.requestFingerprint !== query.selector.requestFingerprint) throw new CoreIpcError('INVALID_IPC_RESPONSE', '源写原命令身份无效。')
        const entry = options.outbox.findSourceWrites(value.commandId, datasetId)
        if (value.receipt && entry && entry.command === value.expectedCommand && dto.isLocalSourceWritesOutboxCommand(entry.command)
          && sourceWriteFingerprint(entry.command, entry.payload as dto.LocalSourceWritesCommandPayloads[typeof entry.command]) === value.requestFingerprint) options.outbox.reconcileSourceWrites(entry.id, value.receipt)
      }
    }
    return result
  })
  return { close: () => { closed = true } }
}
