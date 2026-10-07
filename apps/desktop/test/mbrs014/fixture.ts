import * as dto from '@music-bridge/contracts'
import { localLegacyLinkMatches, type LocalLegacyUiApi, type LocalLegacyUiContext } from '../../src/renderer/src/composables/application/useLocalLegacyLinks.js'
export const id = (n: number) => `14141414-1414-4414-8414-${String(n).padStart(12, '0')}`
export const dataset = id(1), trackId = id(2), assetId = id(3), editionId = id(4), otherEditionId = id(5), releaseId = id(6), digitalId = id(7), draftId = id(8), draftTrackId = id(9), bindingId = id(10)
export const copy = <T>(value: T): T => structuredClone(value)
export const physical = (): LocalLegacyUiContext => ({ key: { kind: 'physical-release', physicalReleaseId: releaseId }, revision: 3, title: '原实体发行' })
export const digital = (): LocalLegacyUiContext => ({ key: { kind: 'digital-album', digitalAlbumId: digitalId }, revision: 4, title: '原数字对象' })
export const source = (): LocalLegacyUiContext => ({ key: { kind: 'draft-source', draftId, draftTrackId, sourceBindingId: bindingId }, revision: 7, title: '旧源曲目' })
export const detailFixture = (): dto.LocalLibraryTrackDetail => ({ track: { id: trackId, assetId, selectionRevision: '6', segment: null }, asset: { id: assetId, libraryRootId: id(11), sourceRootId: id(12), rootRevision: '2', fileRevision: '8', locationRevision: '9', sampleFrames: '44100', timebaseHz: 44100 }, metadata: { raw: { title: '同名曲目', artist: '自制作者', album: '同名专辑' }, override: null, effective: { title: '同名曲目', artist: '自制作者', album: '同名专辑' } }, versionTokens: [], editions: [{ id: editionId, title: '同名专辑', edition: '同名版本', revision: '10' }, { id: otherEditionId, title: '同名专辑', edition: '同名版本', revision: '11' }], fileParameters: null })
export function fixture() {
  let serial = 100, currentDataset = dataset
  const links = new Map<string, dto.LocalLegacyLink>(), events: dto.LocalLegacyLinkTransition[] = [], previews = new Map<string, dto.LocalLegacyLinkPreview>()
  const writes: dto.ExecuteLocalLegacyLink[] = [], readRequests: dto.ReadLocalLegacyLinks[] = [], previewRequests: dto.PreviewLocalLegacyLink[] = []
  let overviewEntries: dto.CommandOutboxView[] = []
  const detail = detailFixture(), roots: dto.LocalRootView[] = [{ root: { id: id(11), sourceRootId: id(12), revision: '13', role: 'library' }, label: '自制源目录', availability: 'ONLINE' }]
  const next = () => id(serial++)
  function endpoints(choice: dto.LocalLegacyLinkChoice): dto.LocalLegacyLinkEndpoints {
    if (choice.kind === 'legacy-edition') return { kind: choice.kind, subject: choice.subject.kind === 'physical-release'
      ? { kind: 'physical-release', physicalReleaseId: choice.subject.physicalReleaseId, revision: choice.subject.expectedRevision, summary: { format: 'cd', title: '原实体发行', artist: '原作者', year: null, edition: null }, releaseFingerprint: 'c'.repeat(64) }
      : { kind: 'digital-album', digitalAlbumId: choice.subject.digitalAlbumId, revision: choice.subject.expectedRevision, metadata: { title: '原数字对象', artist: '原作者' } }, localEditionId: choice.localEditionId, editionRevision: choice.expectedEditionRevision, title: '同名专辑', edition: '同名版本' }
    return { kind: choice.kind, draftId: choice.draftId, draftTrackId: choice.draftTrackId, draftRevision: choice.expectedDraftRevision, sourceBindingId: choice.sourceBindingId, bindingRootId: id(14), localTrackId: choice.localTrackId, assetId: choice.assetId, selectionRevision: choice.expectedSelectionRevision, libraryRootId: id(11), sourceRootId: id(12), libraryRootRevision: choice.expectedLibraryRootRevision, assetRootRevision: '2', fileRevision: choice.expectedFileRevision, locationRevision: choice.expectedLocationRevision, segment: copy(choice.expectedSegment) }
  }
  function evidence(e: dto.LocalLegacyLinkEndpoints): dto.LocalLegacyLinkEvidence {
    return e.kind === 'legacy-edition' ? { kind: 'manual-edition' } : { kind: 'exact-file', sha256: 'f'.repeat(64), size: '88244', bindingFingerprint: 'a'.repeat(64), assetProofFingerprint: 'b'.repeat(64), coverage: e.segment === null ? { mode: 'whole-file' } : { mode: 'whole-file-span', segment: e.segment, sourceFrames: '44100', sourceTimebaseHz: 44100 } }
  }
  async function execute(request: dto.ExecuteLocalLegacyLink, kind: dto.LocalLegacyLinkReceipt['action']): Promise<dto.LocalLegacyLinkReceipt> {
    writes.push(copy(request)); const p = previews.get(request.previewId)!
    const intent = p.body.intent, old = intent.action === 'link' ? null : links.get(intent.linkId)!, eventId = next()
    const link: dto.LocalLegacyLink = { version: 1, datasetId: currentDataset, linkId: p.body.plannedLinkId, revision: old ? String(BigInt(old.revision) + 1n) : '1', state: intent.action === 'link' || intent.action === 'undo' && old?.state === 'revoked' ? 'active' : 'revoked', endpoints: copy(p.body.endpoints), evidence: copy(p.body.evidence), lastTransitionEventId: eventId }
    links.set(link.linkId, link); events.push({ eventId, datasetId: currentDataset, linkId: link.linkId, commandId: request.commandId, previewId: p.previewId, action: kind === 'confirm' ? 'confirmed' : kind === 'revoke' ? 'revoked' : 'undone', occurredAt: new Date().toISOString(), reason: p.body.reason, before: copy(old), after: copy(link), undoOfEventId: intent.action === 'undo' ? intent.undoTransitionEventId : null })
    return { datasetId: currentDataset, commandId: request.commandId, action: kind, previewId: p.previewId, outcome: 'applied', link: copy(link), transitionEventId: eventId, issue: null }
  }
  const api: LocalLegacyUiApi = {
    getCommandOutbox: async () => ({ datasetId: currentDataset, entries: copy(overviewEntries) }),
    queryLocalLibraryTracks: async request => ({ ...request, total: 1, hasMore: false, items: [{ track: copy(detail.track), asset: copy(detail.asset), metadata: copy(detail.metadata.effective), versionTokens: [] }] }),
    getLocalLibraryTrackDetail: async () => copy(detail), listLocalLibraryRoots: async () => copy(roots),
    readLocalLegacyLinks: async request => {
      readRequests.push(copy(request)); const selector = request.selector
      const items = [...links.values()].filter(link => selector.by === 'link' ? link.linkId === selector.linkId : selector.by === 'legacy' ? localLegacyLinkMatches(link, selector.key) : false).filter(link => request.state === 'all' || link.state === 'active')
      const active = items.find(link => link.state === 'active'), latest = items.at(-1)
      return { datasetId: currentDataset, selectorFingerprint: 'a'.repeat(64), snapshotFingerprint: 'b'.repeat(64), limit: request.limit, items: copy(items.slice(0, request.limit)), slot: selector.by === 'legacy' ? { activeLinkId: active?.linkId ?? null, lastTransitionEventId: latest?.lastTransitionEventId ?? null } : null, cursor: null, hasMore: false }
    },
    historyLocalLegacyLinks: async request => ({ datasetId: currentDataset, linkId: request.linkId, snapshotFingerprint: 'c'.repeat(64), limit: request.limit, items: copy(events.filter(event => event.linkId === request.linkId).slice(-request.limit)), cursor: null, hasMore: false }),
    previewLocalLegacyLink: async request => {
      previewRequests.push(copy(request)); const intent = request.intent, before = intent.action === 'link' ? null : links.get(intent.linkId)!, e = intent.action === 'link' ? endpoints(intent.choice) : copy(before!.endpoints), proof = intent.action === 'link' ? evidence(e) : copy(before!.evidence)
      const restores = intent.action === 'link' || intent.action === 'undo' && before?.state === 'revoked', previewTime = Date.now(), createdAt = new Date(previewTime).toISOString(), expiresAt = new Date(previewTime + 600_000).toISOString(), previewId = next()
      const p: dto.LocalLegacyLinkPreview = { previewId, revision: '1', datasetId: currentDataset, previewHash: 'd'.repeat(64), contextFingerprint: 'e'.repeat(64), body: { version: 1, datasetId: currentDataset, previewId, plannedLinkId: before?.linkId ?? next(), createdAt, expiresAt, intent: copy(intent), reason: request.reason, before: copy(before), endpoints: e, evidence: proof, guard: { slot: intent.action === 'link' ? copy(intent.choice.expectedSlot) : { activeLinkId: before!.state === 'active' ? before!.linkId : null, lastTransitionEventId: before!.lastTransitionEventId }, expectedLinkRevision: before?.revision ?? null, endpointsFingerprint: restores ? 'a'.repeat(64) : null, editionMembersFingerprint: restores && proof.kind === 'manual-edition' ? 'b'.repeat(64) : null, bindingFingerprint: restores && proof.kind === 'exact-file' ? proof.bindingFingerprint : null, assetProofFingerprint: restores && proof.kind === 'exact-file' ? proof.assetProofFingerprint : null } } }
      previews.set(p.previewId, copy(p)); return p
    }, confirmLocalLegacyLink: request => execute(request, 'confirm'), revokeLocalLegacyLink: request => execute(request, 'revoke'), undoLocalLegacyLink: request => execute(request, 'undo'),
  }
  return { api, detail, roots, links, events, previews, writes, readRequests, previewRequests, setDataset: (value: string) => { currentDataset = value }, setOutbox: (value: dto.CommandOutboxView[]) => { overviewEntries = value } }
}
export function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
