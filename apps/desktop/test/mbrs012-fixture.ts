import * as dto from '@music-bridge/contracts'
import { sourceWriteFingerprint } from '../src/main/local-source-writes-ipc.js'
export const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
export const datasetId = id(1), trackId = id(2), editionId = id(3)
export const target: dto.LocalSourceWritesTarget = { mode: 'single', trackId }
export function readyPlan(planId = id(10)): dto.LocalSourceWritesPlan {
  const now = Date.now()
  return { version: 1, datasetId, planId, jobId: id(11), viewRevision: '1', journalSequence: '1', scope: 'SOURCE_FILES', range: 'TAGS', state: 'READY', createdAt: new Date(now).toISOString(), readyAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(), policyRevision: '1', planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), journalFingerprint: 'c'.repeat(64), summary: '一个自制源文件的具体标签预览', items: [{ operationId: id(12), resourceRef: id(13), trackId, assetId: id(14), label: '自制源曲目', profile: 'NATIVE_FLAC_FIXED_TAG_REGION_V1', expectedFileRevision: '1', currentFileRevision: '1', expectedRootRevision: '1', expectedLocationRevision: '1', expectedSelectionRevision: '1', changes: [{ field: 'title', action: 'set', before: ['原始标题'], after: ['新标题'] }], artwork: null, state: 'planned', phase: 'PLANNED', backup: { state: 'not-created', bytes: null }, verification: { audio: 'pending', unselectedMetadata: 'pending', content: 'pending', reread: 'pending' }, issue: null }], issues: [], resourceSummary: { resources: 1, sharedTargets: 1, backupBytes: '1000', spaceVerified: true, protection: 'verified' }, undoOf: null, recoveryOf: null, recoveryChoices: [] }
}
export function fixture() {
  let currentDataset = datasetId
  const policy: dto.LocalSourceWritesPolicy = { enabled: false, revision: '1', draining: false }
  const context: dto.LocalSourceWritesContext = { datasetId, policy, capabilities: { publisherProfile: 'NONATOMIC_QUARANTINE_LINK_V1', formats: [{ profile: 'NATIVE_FLAC_FIXED_TAG_REGION_V1', qualified: true, tags: true, embeddedCover: true, fields: [...dto.LOCAL_SOURCE_WRITES_FIELDS], issue: null }, { profile: 'MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1', qualified: true, tags: true, embeddedCover: true, fields: [...dto.LOCAL_SOURCE_WRITES_FIELDS], issue: null }], directoryCover: { qualified: true, issue: null } }, materials: [{ editionId, candidateId: id(20), selectionId: id(21), selectionRevision: '1', availability: 'available', contentRef: id(22), originalSha256: 'd'.repeat(64), issue: null }] }
  const plans = new Map<string, dto.LocalSourceWritesPlan>(), receipts = new Map<string, dto.LocalSourceWritesReceipt>(), reads: dto.GetLocalSourceWrites[] = [], previews: dto.PreviewLocalSourceWrites[] = [], confirms: dto.ConfirmLocalSourceWrites[] = [], undos: dto.UndoLocalSourceWrites[] = [], cancels: dto.CancelLocalSourceWrites[] = [], policies: dto.SetLocalSourceWritesPolicy[] = [], historyCalls: dto.HistoryLocalSourceWrites[] = []
  const entries: dto.CommandOutboxView[] = []
  const copy = <T>(value: T): T => structuredClone(value)
  function receipt<C extends dto.LocalSourceWritesReceiptCommand>(command: C, request: dto.LocalSourceWritesCommandPayloads[C], planId: string | null): dto.LocalSourceWritesReceipt {
    const value = { datasetId: request.datasetId, commandId: request.commandId, command, requestFingerprint: sourceWriteFingerprint(command, request), planId, jobId: planId ? plans.get(planId)!.jobId : null, outcome: 'accepted' as const, policy: command === 'localSourceWrites.setPolicy' ? copy(policy) : null, issue: null }
    receipts.set(request.commandId, value); return copy(value)
  }
  const api: dto.LocalSourceWritesPublicApi & Pick<dto.CommandOutboxPublicApi, 'getCommandOutbox'> = {
    getCommandOutbox: async () => ({ datasetId: currentDataset, entries: copy(entries) }),
    getLocalSourceWrites: async request => {
      reads.push(copy(request)); const selector = request.selector
      if (selector.kind === 'context') return { datasetId: currentDataset, kind: 'context', context: { ...copy(context), datasetId: currentDataset } }
      if (selector.kind === 'plan') { const value = plans.get(selector.planId); return { datasetId: currentDataset, kind: 'plan', plan: value ? copy(value) : null, issue: value ? null : 'NOT_FOUND' } }
      const found = receipts.get(selector.commandId), value = found?.command === selector.expectedCommand && found.requestFingerprint === selector.requestFingerprint ? found : null
      return { datasetId: currentDataset, ...selector, receipt: value ? copy(value) : null, issue: value ? null : 'NOT_FOUND' }
    },
    previewLocalSourceWrites: async request => {
      previews.push(copy(request)); const value = readyPlan(id(100 + previews.length)), intent = request.intent
      if (intent.kind === 'tags') {
        const original: Record<dto.LocalSourceWritesField, string[]> = { title: ['原始标题'], artist: ['原艺人甲', '原艺人乙'], album: ['原专辑'], year: ['2026'], disc: ['1'], track: ['2'] }
        value.items[0]!.changes = dto.LOCAL_SOURCE_WRITES_FIELDS.flatMap(field => { const change = intent.fields[field]; return change ? [{ field, action: change.action, before: original[field], after: change.action === 'set' ? [change.value] : null }] : [] })
      }
      if (intent.kind === 'embedded-cover' || intent.kind === 'directory-cover') {
        value.range = intent.kind === 'embedded-cover' ? 'EMBEDDED_COVER' : 'DIRECTORY_COVER'; value.items[0]!.changes = []
        value.items[0]!.artwork = { ...intent.artwork, mime: 'image/png', bytes: 130, width: 16, height: 16, slot: intent.kind === 'embedded-cover' ? 'front' : 'directory' }
      }
      plans.set(value.planId, value); return receipt('localSourceWrites.preview', request, value.planId)
    },
    confirmLocalSourceWrites: async request => { confirms.push(copy(request)); const value = plans.get(request.planId)!; value.state = 'RUNNING'; value.viewRevision = '2'; return receipt('localSourceWrites.confirm', request, request.planId) },
    undoLocalSourceWrites: async request => {
      undos.push(copy(request)); const value = readyPlan(id(200 + undos.length)), origin = plans.get(request.planId)!
      value.undoOf = request.planId; value.range = origin.range; value.items[0]!.artwork = null
      value.items[0]!.expectedFileRevision = origin.items[0]!.currentFileRevision; value.items[0]!.currentFileRevision = origin.items[0]!.currentFileRevision
      value.items[0]!.changes = origin.range === 'TAGS' ? origin.items[0]!.changes.map(change => ({ field: change.field, action: change.before === null ? 'remove' : 'set', before: change.after, after: change.before })) : []
      value.items[0]!.restoration = { originPlanId: origin.planId, originOperationId: request.operationIds[0]!, kind: origin.range === 'DIRECTORY_COVER' ? 'remove-new-directory-cover' : 'restore-audio-file', material: origin.range === 'DIRECTORY_COVER' ? 'verified-absence' : 'verified-backup', expectedOutputSha256: origin.range === 'DIRECTORY_COVER' ? null : 'e'.repeat(64) }
      plans.set(value.planId, value); return receipt('localSourceWrites.undo', request, value.planId)
    },
    cancelLocalSourceWrites: async request => { cancels.push(copy(request)); const value = plans.get(request.planId)!; value.state = 'CANCELLED'; value.viewRevision = String(BigInt(value.viewRevision) + 1n); return receipt('localSourceWrites.cancel', request, request.planId) },
    setLocalSourceWritesPolicy: async request => { policies.push(copy(request)); policy.enabled = request.enabled; policy.revision = String(BigInt(policy.revision) + 1n); return receipt('localSourceWrites.setPolicy', request, null) },
    listLocalSourceWritesHistory: async request => {
      historyCalls.push(copy(request))
      if (request.selector.kind === 'events') return { datasetId: currentDataset, kind: 'events', planId: request.selector.planId, snapshotFingerprint: 'f'.repeat(64), limit: request.limit, items: [], cursor: null, hasMore: false }
      return { datasetId: currentDataset, kind: 'plans', range: request.selector.range, snapshotFingerprint: 'f'.repeat(64), limit: request.limit, items: [...plans.values()].map(value => ({ planId: value.planId, jobId: value.jobId, viewRevision: value.viewRevision, range: value.range, state: value.state, createdAt: value.createdAt, operations: value.items.length, issue: value.issues[0] ?? null })), cursor: null, hasMore: false }
    },
  }
  function complete(planId: string): void { const value = plans.get(planId)!; value.state = 'COMPLETED'; value.viewRevision = '3'; for (const item of value.items) { item.state = 'applied'; item.phase = 'TERMINAL'; item.currentFileRevision = value.range === 'DIRECTORY_COVER' ? item.expectedFileRevision : String(BigInt(item.expectedFileRevision) + 1n); item.backup = { state: 'retained', bytes: '1000' }; item.verification = { audio: value.range === 'DIRECTORY_COVER' ? 'not-applicable' : 'verified', unselectedMetadata: value.range === 'DIRECTORY_COVER' ? 'not-applicable' : 'verified', content: 'verified', reread: 'verified' } } }
  return { api, context, policy, plans, receipts, reads, previews, confirms, undos, cancels, policies, historyCalls, entries, receipt, complete, changeDataset: (value: string) => { currentDataset = value } }
}
export function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
