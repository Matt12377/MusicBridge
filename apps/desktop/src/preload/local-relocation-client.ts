import * as dto from '@music-bridge/contracts'
import type { DatasetScope } from './command-outbox-client.js'

export interface LocalRelocationTransport { invoke(channel: string, value?: unknown): Promise<unknown>; scope: DatasetScope }
const invalid = () => new Error('[INVALID_IPC_REQUEST] 搬迁请求或原回执无效，请只重新读取具体计划。')

/** 同窗口固定工作库；捕获发生在等待scope和计算指纹之前，不暴露路径或Main能力。 */
export function createLocalRelocationClient(transport: LocalRelocationTransport): dto.LocalRelocationPlanPublicApi {
  async function send<C extends dto.LocalRelocationPlanCommand>(command: C, raw: dto.LocalRelocationPlanCommandPayloads[C]): Promise<dto.LocalRelocationPlanCommandResults[C]> {
    if (!dto.isLocalRelocationPlanCommand(command)) throw invalid()
    let request: dto.LocalRelocationPlanCommandPayloads[C]
    try { request = dto.localRelocationPlanCommandSnapshot(command, raw) } catch { throw invalid() }
    const datasetId = await transport.scope()
    if (request.datasetId !== datasetId) throw new Error('[OUTBOX_SCOPE_MISMATCH] 工作库已改变；原搬迁请求不会自动重发。')
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(dto.localRelocationRequestFingerprintInput(command, request)))
    const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
    const rawResult = await transport.invoke('localRelocationPlan:request', { datasetId, command, payload: request })
    let result: dto.LocalRelocationPlanCommandResults[C]
    try { result = dto.localRelocationPlanCommandResultSnapshot(command, rawResult) } catch { throw invalid() }
    const value = result as dto.LocalRelocationPlanCommandResults[dto.LocalRelocationPlanCommand]
    if (command === 'localRelocationPlan.chooseTarget') {
      const choose = request as dto.LocalRelocationTargetRequest
      if (value !== null && (!('choiceId' in value) || value.kind !== choose.kind || Date.parse(value.expiresAt) <= Date.now())) throw invalid()
      return result
    }
    if (value === null || !('datasetId' in value) || value.datasetId !== datasetId) throw invalid()
    if (command === 'localRelocationPlan.get') {
      const query = request as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get'], response = value as dto.LocalRelocationPlanCommandResults['localRelocationPlan.get']
      if (response.kind !== query.selector.kind) throw invalid()
      if (query.selector.kind === 'plan' && response.kind === 'plan' && (response.planId !== query.selector.planId || response.plan && response.plan.planId !== query.selector.planId)) throw invalid()
      if (query.selector.kind === 'command' && response.kind === 'command' && (response.commandId !== query.selector.commandId || response.expectedCommand !== query.selector.expectedCommand || response.requestFingerprint !== query.selector.requestFingerprint)) throw invalid()
    } else if (command === 'localRelocationPlan.history') {
      const query = request as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.history'], response = value as dto.LocalRelocationPlanCommandResults['localRelocationPlan.history']
      if (response.kind !== query.selector.kind || response.limit !== query.limit || query.selector.kind === 'events' && response.kind === 'events' && response.planId !== query.selector.planId) throw invalid()
    } else {
      const receipt = value as dto.LocalRelocationPlanReceipt
      if (receipt.command !== command || receipt.commandId !== (request as { commandId: string }).commandId || receipt.requestFingerprint !== fingerprint) throw invalid()
    }
    return result
  }
  return Object.freeze({ localRelocationPlan: send })
}
