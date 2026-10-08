import { createHash } from 'node:crypto'
import * as dto from '@music-bridge/contracts'

/** 仅为新013叶行为测试的受控合成DTO；不冒充OS、Core journal或真实App证明。 */
export const id = (number: number): string => `13000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`
export const datasetId = id(1), trackId = id(2)
export const selection: dto.LocalRelocationPlanSelection = { assetId: id(3), expectedFileRevision: '1', expectedLocationRevision: '1', expectedRootRevision: '1' }
export const fingerprint = (command: dto.LocalRelocationPlanCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand]): string => createHash('sha256').update(dto.localRelocationRequestFingerprintInput(command, payload)).digest('hex')
export const issue = (code: dto.LocalRelocationPlanIssueCode): dto.LocalRelocationPlanIssue => ({ code, label: '013 合成受控状态', retry: code === 'COMMAND_UNKNOWN' ? 'query-original' : 'never', operationId: null, resourceId: null })
export function readyPlan(number = 10): dto.LocalRelocationPlan {
  const operationId = id(number + 2), audio = id(number + 3), lyric = id(number + 4)
  return {
    version: 1, domain: 'LOCAL_RELOCATION_V1', datasetId, planId: id(number), jobId: id(number + 1), viewRevision: '1', journalSequence: '1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), policyRevision: '1',
    intent: { kind: 'rename', target: { ...selection }, newName: 'owned-renamed.wav', sourceDisposition: 'RETAIN' }, state: 'READY', sourceDisposition: 'RETAIN',
    closure: { complete: true, operationCount: 1, resourceCount: 2, referenceEdgeCount: 1, rootCount: 1, fingerprint: 'c'.repeat(64), totalSourceBytes: '4196', spaceVerified: true, protection: 'verified' },
    items: [{ operationId, assetId: selection.assetId, trackIds: [trackId], sourceLabel: '自有原音频', targetLabel: '具体新文件名', expectedFileRevision: '1', expectedLocationRevision: '1', expectedRootRevision: '1', state: 'pending', phase: 'PLANNED', resourceIds: [audio, lyric], issue: null }],
    resources: [{ resourceId: audio, role: 'AUDIO', label: 'owned-original.wav', operationIds: [operationId], bytes: '4096', state: 'pending', phase: 'PLANNED', verification: 'verified-source', sourceHandling: 'unchanged', contentEffect: 'whole-bytes-preserved', issue: null },
      { resourceId: lyric, role: 'LYRIC', label: 'owned-original.lrc', operationIds: [operationId], bytes: '100', state: 'pending', phase: 'PLANNED', verification: 'verified-source', sourceHandling: 'unchanged', contentEffect: 'whole-bytes-preserved', issue: null }],
    referenceEdges: [{ edgeId: id(number + 5), fromResourceId: lyric, toResourceId: audio, kind: 'LYRIC_AUDIO', shared: false }], issues: [], cleanup: { state: 'unavailable', verifiedTargetFingerprint: null, sourceResourceIds: [], issue: null }, recoveryChoices: [],
  }
}
export function fixture() {
  const context: dto.LocalRelocationPlanContext = { datasetId, kind: 'context', policy: { enabled: false, revision: '1', draining: false }, qualification: { state: 'qualified', proofFingerprint: 'd'.repeat(64), issue: null } }
  const plans = new Map<string, dto.LocalRelocationPlan>(), receipts = new Map<string, dto.LocalRelocationPlanReceipt>(), calls: { command: dto.LocalRelocationPlanCommand; payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand] }[] = []
  const unknown = new Set<string>()
  let planNumber = 100
  const receipt = (command: dto.LocalRelocationPlanReceiptCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanReceiptCommand], plan: dto.LocalRelocationPlan | null): dto.LocalRelocationPlanReceipt => {
    const value: dto.LocalRelocationPlanReceipt = { datasetId, commandId: payload.commandId, command, requestFingerprint: fingerprint(command, payload), planId: plan?.planId ?? null, jobId: plan?.jobId ?? null, outcome: 'accepted', policy: command === 'localRelocationPlan.setPolicy' ? { ...context.policy } : null, issue: null }
    receipts.set(payload.commandId, value); return value
  }
  async function dispatch(command: dto.LocalRelocationPlanCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand]): Promise<dto.LocalRelocationPlanCommandResults[dto.LocalRelocationPlanCommand]> {
    calls.push({ command, payload: structuredClone(payload) })
    if (command === 'localRelocationPlan.get') {
      const request = payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get']
      if (request.selector.kind === 'context') return structuredClone(context)
      if (request.selector.kind === 'plan') return { datasetId, kind: 'plan', planId: request.selector.planId, plan: structuredClone(plans.get(request.selector.planId) ?? null), issue: plans.has(request.selector.planId) ? null : issue('NOT_FOUND') }
      const saved = receipts.get(request.selector.commandId)
      return { datasetId, kind: 'command', commandId: request.selector.commandId, expectedCommand: request.selector.expectedCommand, requestFingerprint: request.selector.requestFingerprint, receipt: saved ? structuredClone(saved) : null, issue: saved ? null : issue(unknown.has(request.selector.commandId) ? 'COMMAND_UNKNOWN' : 'NOT_FOUND') }
    }
    if (command === 'localRelocationPlan.history') {
      const request = payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.history']
      if (request.selector.kind === 'events') return { datasetId, kind: 'events', planId: request.selector.planId, snapshotFingerprint: 'e'.repeat(64), limit: request.limit, items: [], cursor: null, hasMore: false }
      return { datasetId, kind: 'plans', snapshotFingerprint: 'e'.repeat(64), limit: request.limit, items: [...plans.values()].map(value => ({ planId: value.planId, jobId: value.jobId, viewRevision: value.viewRevision, state: value.state, createdAt: value.createdAt, operations: value.items.length, issue: null })), cursor: null, hasMore: false }
    }
    if (command === 'localRelocationPlan.chooseTarget') return { choiceId: id(500), kind: (payload as dto.LocalRelocationTargetRequest).kind, label: '自有目标目录', expiresAt: new Date(Date.now() + 600000).toISOString() }
    if (command === 'localRelocationPlan.setPolicy') {
      const request = payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.setPolicy']; context.policy = { enabled: request.enabled, revision: String(Number(context.policy.revision) + 1), draining: false }
      return receipt(command, request, null)
    }
    if (command === 'localRelocationPlan.preview') {
      const request = payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview']
      if (!context.policy.enabled) {
        const rejected: dto.LocalRelocationPlanReceipt = { datasetId, commandId: request.commandId, command, requestFingerprint: fingerprint(command, request), planId: null, jobId: null, outcome: 'rejected', policy: null, issue: issue('POLICY_DISABLED') }
        receipts.set(request.commandId, rejected); return rejected
      }
      const value = readyPlan(planNumber); planNumber += 10; value.intent = request.intent
      plans.set(value.planId, value); return receipt(command, request, value)
    }
    const request = payload as dto.LocalRelocationPlanConfirm, value = plans.get(request.planId)
    if (!value) throw new Error('受控计划不存在')
    if (command === 'localRelocationPlan.confirm') { value.state = 'RUNNING'; value.viewRevision = String(Number(value.viewRevision) + 1) }
    else if (command === 'localRelocationPlan.cleanup') { value.cleanup.state = 'running'; value.state = 'RUNNING'; value.viewRevision = String(Number(value.viewRevision) + 1) }
    else { value.state = 'CANCELLED'; value.viewRevision = String(Number(value.viewRevision) + 1) }
    return receipt(command, payload as dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanReceiptCommand], value)
  }
  const api: dto.LocalRelocationPlanPublicApi & Pick<dto.CommandOutboxPublicApi, 'getCommandOutbox'> = {
    async getCommandOutbox() { return { datasetId, entries: [] } },
    localRelocationPlan: dispatch as dto.LocalRelocationPlanPublicApi['localRelocationPlan'],
  }
  function complete(planId: string, eligible = true): void {
    const value = plans.get(planId); if (!value) throw new Error('受控计划不存在')
    value.state = 'SOURCE_RETAINED'; value.viewRevision = String(Number(value.viewRevision) + 1)
    for (const item of value.items) { item.state = 'retained'; item.phase = 'SOURCE_RETAINED' }
    for (const resource of value.resources) { resource.state = 'retained'; resource.phase = 'SOURCE_RETAINED'; resource.verification = 'verified-target'; resource.sourceHandling = eligible ? 'cleanup-eligible' : 'retained' }
    value.cleanup = { state: eligible ? 'eligible' : 'source-retained', verifiedTargetFingerprint: 'f'.repeat(64), sourceResourceIds: value.resources.map(resource => resource.resourceId), issue: null }
  }
  return { api, dispatch, context, plans, receipts, calls, unknown, receipt, complete }
}
