import { createHash } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { CoreIpcError } from './core-supervisor.js'

export type LocalRelocationMutationCommand = Exclude<dto.LocalRelocationPlanCommand, 'localRelocationPlan.chooseTarget' | 'localRelocationPlan.get' | 'localRelocationPlan.history'>
export const relocationRequestFingerprint = (command: dto.LocalRelocationPlanCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand]): string => createHash('sha256').update(dto.localRelocationRequestFingerprintInput(command, payload), 'utf8').digest('hex')
const invalid = () => new CoreIpcError('INVALID_IPC_REQUEST', '搬迁请求范围或具体计划无效。')
const invalidResult = () => new CoreIpcError('INVALID_IPC_RESPONSE', '搬迁原请求回执暂未核实，请只读取原命令。')
const mutation = (command: dto.LocalRelocationPlanCommand): command is LocalRelocationMutationCommand => command !== 'localRelocationPlan.chooseTarget' && command !== 'localRelocationPlan.get' && command !== 'localRelocationPlan.history'

export interface LocalRelocationHandlersOptions<E> {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  requestPublic<C extends dto.LocalRelocationPlanCommand>(command: C, payload: dto.LocalRelocationPlanCommandPayloads[C], datasetId: string): Promise<dto.LocalRelocationPlanCommandResults[C]>
  requestMain<C extends dto.LocalRelocationMainCommand>(command: C, payload: dto.LocalRelocationMainCommandPayloads[C]): Promise<dto.LocalRelocationMainCommandResults[C]>
  pickTarget(kind: 'directory' | 'file'): Promise<{ canceled: boolean; filePaths: string[] }>
}

/** 独立Main叶路由；物理路径、grant与FD均不进入Renderer或旧五条找回命令。 */
export function installLocalRelocationHandlers<E>(options: LocalRelocationHandlersOptions<E>): { close(): void } {
  let closed = false
  // 仅阻止本次Main生命周期内的在途/未知重入；持久原命令仍由Core同Owner journal认证。
  const pending = new Map<string, { command: LocalRelocationMutationCommand; fingerprint: string; promise: Promise<dto.LocalRelocationPlanReceipt> }>()
  const route = async (event: E, raw: unknown) => {
    options.requireTrusted(event)
    const alive = () => { if (closed) throw new CoreIpcError('NOT_READY', '搬迁入口已关闭。'); options.requireTrusted(event) }
    alive()
    let captured: unknown
    try { captured = dto.localRelocationDataSnapshot(raw) } catch { throw invalid() }
    if (typeof captured !== 'object' || captured === null || Array.isArray(captured)) throw invalid()
    const envelope = captured as Record<string, unknown>
    if (Object.keys(envelope).length !== 3 || !['datasetId', 'command', 'payload'].every(key => Object.hasOwn(envelope, key)) || !dto.isLocalRelocationPlanDatasetId(envelope.datasetId) || !dto.isLocalRelocationPlanCommand(envelope.command)) throw invalid()
    const command = envelope.command, datasetId = envelope.datasetId
    let request: dto.LocalRelocationPlanCommandPayloads[typeof command]
    try { request = dto.localRelocationPlanCommandSnapshot(command, envelope.payload) } catch { throw invalid() }
    if (request.datasetId !== datasetId) throw invalid()
    const fingerprint = relocationRequestFingerprint(command, request)
    const result = (value: unknown): dto.LocalRelocationPlanCommandResults[typeof command] => {
      let response: dto.LocalRelocationPlanCommandResults[typeof command]
      try { response = dto.localRelocationPlanCommandResultSnapshot(command, value) } catch { throw invalidResult() }
      if (command === 'localRelocationPlan.chooseTarget') {
        if (response !== null && (!('choiceId' in response) || response.kind !== (request as dto.LocalRelocationTargetRequest).kind || Date.parse(response.expiresAt) <= Date.now())) throw invalidResult()
        return response
      }
      if (response === null || !('datasetId' in response) || response.datasetId !== datasetId) throw invalidResult()
      if (mutation(command)) {
        const receipt = response as dto.LocalRelocationPlanReceipt
        if (receipt.command !== command || receipt.commandId !== (request as { commandId: string }).commandId || receipt.requestFingerprint !== fingerprint) throw invalidResult()
      } else if (command === 'localRelocationPlan.get') {
        const query = request as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get'], responseGet = response as dto.LocalRelocationPlanCommandResults['localRelocationPlan.get']
        if (responseGet.kind !== query.selector.kind) throw invalidResult()
        if (query.selector.kind === 'plan' && responseGet.kind === 'plan' && (responseGet.planId !== query.selector.planId || responseGet.plan && responseGet.plan.planId !== query.selector.planId)) throw invalidResult()
        if (query.selector.kind === 'command' && responseGet.kind === 'command' && (responseGet.commandId !== query.selector.commandId || responseGet.expectedCommand !== query.selector.expectedCommand || responseGet.requestFingerprint !== query.selector.requestFingerprint)) throw invalidResult()
        if (query.selector.kind === 'command' && responseGet.kind === 'command' && responseGet.receipt) {
          const receipt = responseGet.receipt
          if (receipt.datasetId !== datasetId || receipt.commandId !== query.selector.commandId || receipt.command !== query.selector.expectedCommand || receipt.requestFingerprint !== query.selector.requestFingerprint) throw invalidResult()
          const key = `${datasetId}:${receipt.commandId}`, entry = pending.get(key)
          if (entry && entry.command === receipt.command && entry.fingerprint === receipt.requestFingerprint) pending.delete(key)
        }
      } else if (command === 'localRelocationPlan.history') {
        const query = request as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.history'], responseHistory = response as dto.LocalRelocationPlanCommandResults['localRelocationPlan.history']
        if (responseHistory.kind !== query.selector.kind || responseHistory.limit !== query.limit || query.selector.kind === 'events' && responseHistory.kind === 'events' && responseHistory.planId !== query.selector.planId) throw invalidResult()
      }
      return response
    }
    if (command === 'localRelocationPlan.chooseTarget') {
      const choose = request as dto.LocalRelocationTargetRequest
      const checkScope = async () => {
        const context = await options.requestPublic('localRelocationPlan.get', { datasetId, selector: { kind: 'context' } }, datasetId)
        if (!dto.isLocalRelocationPlanCommandResult('localRelocationPlan.get', context) || context.kind !== 'context' || context.datasetId !== datasetId) throw invalidResult()
        alive()
      }
      await checkScope()
      const picked = await options.pickTarget(choose.kind)
      alive()
      if (picked.canceled) return null
      if (picked.filePaths.length !== 1 || typeof picked.filePaths[0] !== 'string') throw invalid()
      await checkScope()
      return result(await options.requestMain('localRelocationMain.captureTarget', { datasetId, commandId: choose.commandId, kind: choose.kind, absolutePath: picked.filePaths[0] }))
    }
    if (!mutation(command)) {
      const query = request as dto.LocalRelocationPlanCommandPayloads[typeof command]
      return result(await options.requestPublic(command, query, datasetId))
    }
    const mutationRequest = request as dto.LocalRelocationPlanCommandPayloads[LocalRelocationMutationCommand]
    const key = `${datasetId}:${mutationRequest.commandId}`, prior = pending.get(key)
    if (prior) {
      if (prior.command !== command || prior.fingerprint !== fingerprint) throw invalid()
      return result(await prior.promise)
    }
    if (pending.size >= 128) throw new CoreIpcError('NOT_READY', '请先核对已有搬迁未知请求；新请求尚未投递。')
    const execute = async (): Promise<dto.LocalRelocationPlanReceipt> => {
      alive()
      const originalRaw = await options.requestPublic('localRelocationPlan.get', { datasetId, selector: { kind: 'command', commandId: mutationRequest.commandId, expectedCommand: command, requestFingerprint: fingerprint } }, datasetId)
      let original: dto.LocalRelocationPlanCommandResults['localRelocationPlan.get']
      try { original = dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.get', originalRaw) } catch { throw invalidResult() }
      if (original.kind !== 'command' || original.datasetId !== datasetId || original.commandId !== mutationRequest.commandId || original.expectedCommand !== command || original.requestFingerprint !== fingerprint) throw invalidResult()
      if (original.receipt) return result(original.receipt) as dto.LocalRelocationPlanReceipt
      if (original.issue?.code !== 'NOT_FOUND') throw new CoreIpcError('NOT_READY', '原搬迁请求结果未知；只可读取核对，不会重新申请能力。')
      alive()
      if (command !== 'localRelocationPlan.confirm' && command !== 'localRelocationPlan.cleanup') return result(await options.requestPublic(command, mutationRequest, datasetId)) as dto.LocalRelocationPlanReceipt
      const cleanup = command === 'localRelocationPlan.cleanup'
      const confirm = request as dto.LocalRelocationPlanConfirm
      const cleanupRequest = request as dto.LocalRelocationPlanCleanup
      const challenge = cleanup
        ? await options.requestMain('localRelocationMain.challengeCleanup', { datasetId, cleanup: cleanupRequest })
        : await options.requestMain('localRelocationMain.challenge', { datasetId, confirm })
      if (!dto.isLocalRelocationMainCommandResult(cleanup ? 'localRelocationMain.challengeCleanup' : 'localRelocationMain.challenge', challenge)) throw invalidResult()
      if (challenge.datasetId !== datasetId || challenge.commandId !== confirm.commandId || challenge.planId !== confirm.planId || challenge.expectedViewRevision !== confirm.expectedViewRevision || challenge.domain !== 'LOCAL_RELOCATION_V1' || challenge.action !== (cleanup ? 'cleanup' : 'execute') || challenge.planHash !== confirm.planHash || challenge.contextFingerprint !== confirm.contextFingerprint || challenge.requestFingerprint !== fingerprint || Date.parse(challenge.expiresAt) <= Date.now()) throw invalidResult()
      if (cleanup ? challenge.verifiedTargetFingerprint !== cleanupRequest.verifiedTargetFingerprint || challenge.sourceResourceIds.length !== cleanupRequest.sourceResourceIds.length || challenge.sourceResourceIds.some((id, index) => id !== cleanupRequest.sourceResourceIds[index]) : challenge.verifiedTargetFingerprint !== null || challenge.sourceResourceIds.length !== 0) throw invalidResult()
      alive()
      // grant只在本次真实Main私有调用内流动；旧012端口与通用Outbox不接收它。
      return result(cleanup
        ? await options.requestMain('localRelocationMain.cleanupGranted', { datasetId, cleanup: cleanupRequest, grant: challenge.grant })
        : await options.requestMain('localRelocationMain.executeGranted', { datasetId, confirm, grant: challenge.grant })) as dto.LocalRelocationPlanReceipt
    }
    const promise = Promise.resolve().then(execute)
    const entry = { command, fingerprint, promise }
    pending.set(key, entry)
    // 只有已核受理/拒绝回执才释放内存槽；失联或校验失败保留原绑定，绝不重播。
    void promise.then(() => { if (pending.get(key) === entry) pending.delete(key) }, () => undefined)
    return result(await promise)
  }
  options.handle('localRelocationPlan:request', async (event, raw) => {
    try { return await route(event, raw) }
    catch (failure) { throw new CoreIpcError(failure instanceof CoreIpcError ? failure.code : 'INVALID_IPC_REQUEST', '搬迁请求未获确认，请只读取原命令；已有材料保留。') }
  })
  return { close() { closed = true } }
}
