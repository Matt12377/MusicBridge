import * as dto from '@music-bridge/contracts'
import type { DatasetScope } from './command-outbox-client.js'

export interface LocalLegacyLinksTransport {
  invoke(channel: string, value?: unknown): Promise<unknown>
  scope: DatasetScope
  confirm(request: dto.ExecuteLocalLegacyLink): Promise<dto.LocalLegacyLinkReceipt>
  revoke(request: dto.ExecuteLocalLegacyLink): Promise<dto.LocalLegacyLinkReceipt>
  undo(request: dto.ExecuteLocalLegacyLink): Promise<dto.LocalLegacyLinkReceipt>
}
const bad = () => new Error('[INVALID_IPC_REQUEST] 本地关联请求或回执无效，请核对当前工作库。')
const changed = () => new Error('[OUTBOX_SCOPE_MISMATCH] 工作库已改变，请重新加载；原操作不会自动重发。')

export function createLocalLegacyLinksClient(transport: LocalLegacyLinksTransport): dto.LocalLegacyLinksPublicApi {
  async function send<C extends dto.LocalLegacyLinksCommand>(command: C, request: dto.LocalLegacyLinksCommandPayloads[C]): Promise<dto.LocalLegacyLinksCommandResults[C]> {
    let captured: unknown
    try { captured = dto.localLegacyLinksDataSnapshot(request, dto.LOCAL_LEGACY_LINKS_BUDGET.requestBytes, 2048, 100) } catch { throw bad() }
    if (!dto.isLocalLegacyLinksCommandPayload(command, captured)) throw bad()
    const datasetId = await transport.scope()
    if (captured.datasetId !== datasetId) throw changed()
    const raw = command === 'localLegacyLinks.confirm' ? await transport.confirm(captured as dto.ExecuteLocalLegacyLink)
      : command === 'localLegacyLinks.revoke' ? await transport.revoke(captured as dto.ExecuteLocalLegacyLink)
        : command === 'localLegacyLinks.undo' ? await transport.undo(captured as dto.ExecuteLocalLegacyLink)
          : await transport.invoke('localLegacyLinks:request', { datasetId, command, payload: captured })
    let value: unknown
    try { value = dto.localLegacyLinksDataSnapshot(raw, dto.LOCAL_LEGACY_LINKS_BUDGET.publicPageBytes, 32768, 100) } catch { throw bad() }
    if (!dto.isLocalLegacyLinksCommandResult(command, value) || value.datasetId !== datasetId) throw bad()
    if (command === 'localLegacyLinks.read' || command === 'localLegacyLinks.history') {
      const input = captured as dto.ReadLocalLegacyLinks & dto.HistoryLocalLegacyLinks
      const page = value as dto.LocalLegacyLinksReadPage & dto.LocalLegacyLinksHistoryPage
      if (page.limit !== input.limit || command === 'localLegacyLinks.history' && page.linkId !== input.linkId) throw bad()
    } else if (command === 'localLegacyLinks.preview') {
      const input = captured as dto.PreviewLocalLegacyLink, preview = value as dto.LocalLegacyLinkPreview
      if (!dto.localLegacyEqual(preview.body.intent, input.intent) || preview.body.reason !== input.reason) throw bad()
    } else {
      const input = captured as dto.ExecuteLocalLegacyLink, receipt = value as dto.LocalLegacyLinkReceipt
      if (receipt.commandId !== input.commandId || receipt.previewId !== input.previewId || receipt.action !== command.slice('localLegacyLinks.'.length)) throw bad()
    }
    return value
  }
  return Object.freeze({
    readLocalLegacyLinks: (request: dto.ReadLocalLegacyLinks) => send('localLegacyLinks.read', request),
    historyLocalLegacyLinks: (request: dto.HistoryLocalLegacyLinks) => send('localLegacyLinks.history', request),
    previewLocalLegacyLink: (request: dto.PreviewLocalLegacyLink) => send('localLegacyLinks.preview', request),
    confirmLocalLegacyLink: (request: dto.ExecuteLocalLegacyLink) => send('localLegacyLinks.confirm', request),
    revokeLocalLegacyLink: (request: dto.ExecuteLocalLegacyLink) => send('localLegacyLinks.revoke', request),
    undoLocalLegacyLink: (request: dto.ExecuteLocalLegacyLink) => send('localLegacyLinks.undo', request),
  })
}
