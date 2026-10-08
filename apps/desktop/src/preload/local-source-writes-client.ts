import * as dto from '@music-bridge/contracts'
import { sourceWriteRequestFingerprint } from '../shared/source-write-fingerprint.js'
import type { DatasetScope } from './command-outbox-client.js'

export interface LocalSourceWritesTransport { invoke(channel: string, value?: unknown): Promise<unknown>; scope: DatasetScope }
const invalid = () => new Error('[INVALID_IPC_REQUEST] 源写请求或回执无效，请重新读取具体计划。')

export function createLocalSourceWritesClient(transport: LocalSourceWritesTransport): dto.LocalSourceWritesPublicApi {
  async function send<C extends dto.LocalSourceWritesCommand>(command: C, raw: dto.LocalSourceWritesCommandPayloads[C]): Promise<dto.LocalSourceWritesCommandResults[C]> {
    let request: unknown
    try { request = dto.localSourceWritesDataSnapshot(raw, dto.LOCAL_SOURCE_WRITES_BUDGET.requestBytes, dto.LOCAL_SOURCE_WRITES_BUDGET.requestNodes) } catch { throw invalid() }
    if (!dto.isLocalSourceWritesCommandPayload(command, request)) throw invalid()
    const datasetId = await transport.scope()
    if (request.datasetId !== datasetId) throw new Error('[OUTBOX_SCOPE_MISMATCH] 工作库已改变；原请求不会自动重发。')
    const fingerprint = await sourceWriteRequestFingerprint(command, request)
    const rawResult = await transport.invoke('localSourceWrites:request', { datasetId, command, payload: request })
    let result: unknown
    try { result = dto.localSourceWritesDataSnapshot(rawResult, dto.LOCAL_SOURCE_WRITES_BUDGET.planBytes, dto.LOCAL_SOURCE_WRITES_BUDGET.publicNodes) } catch { throw invalid() }
    if (!dto.isLocalSourceWritesCommandResult(command, result) || result.datasetId !== datasetId) throw invalid()
    if (command === 'localSourceWrites.get') {
      const input = request as dto.GetLocalSourceWrites, value = result as dto.LocalSourceWritesGetResult
      if (value.kind !== input.selector.kind || input.selector.kind === 'plan' && value.kind === 'plan' && value.plan && value.plan.planId !== input.selector.planId
        || input.selector.kind === 'command' && value.kind === 'command' && (value.commandId !== input.selector.commandId || value.expectedCommand !== input.selector.expectedCommand || value.requestFingerprint !== input.selector.requestFingerprint)) throw invalid()
    } else if (command === 'localSourceWrites.history') {
      const input = request as dto.HistoryLocalSourceWrites, page = result as dto.LocalSourceWritesHistoryPage
      if (page.kind !== input.selector.kind || page.limit !== input.limit || page.kind === 'events' && input.selector.kind === 'events' && page.planId !== input.selector.planId || page.kind === 'plans' && input.selector.kind === 'plans' && page.range !== input.selector.range) throw invalid()
    } else {
      const input = request as dto.PreviewLocalSourceWrites, receipt = result as dto.LocalSourceWritesReceipt
      if (receipt.commandId !== input.commandId || receipt.command !== command || receipt.requestFingerprint !== fingerprint) throw invalid()
    }
    return result
  }
  const api: dto.LocalSourceWritesPublicApi = {
    previewLocalSourceWrites: request => send('localSourceWrites.preview', request),
    getLocalSourceWrites: request => send('localSourceWrites.get', request),
    listLocalSourceWritesHistory: request => send('localSourceWrites.history', request),
    confirmLocalSourceWrites: request => send('localSourceWrites.confirm', request),
    undoLocalSourceWrites: request => send('localSourceWrites.undo', request),
    cancelLocalSourceWrites: request => send('localSourceWrites.cancel', request),
    setLocalSourceWritesPolicy: request => send('localSourceWrites.setPolicy', request),
  }
  return Object.freeze(api)
}
