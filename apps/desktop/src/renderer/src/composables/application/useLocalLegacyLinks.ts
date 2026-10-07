import { computed, ref, shallowRef, triggerRef } from 'vue'
import * as dto from '@music-bridge/contracts'

export interface LocalLegacyUiContext { key: dto.LocalLegacyKey; revision: number; title: string }
export type LocalLegacyUiApi = dto.LocalLegacyLinksPublicApi & Pick<dto.CommandOutboxPublicApi, 'getCommandOutbox'>
  & Pick<dto.LocalLibraryPublicApi, 'queryLocalLibraryTracks' | 'getLocalLibraryTrackDetail' | 'listLocalLibraryRoots'>
type Action = 'link' | 'revoke' | 'undo'
interface Pending { datasetId: string; contextKey: string; linkId: string; kind: 'confirm' | 'revoke' | 'undo'; request: dto.ExecuteLocalLegacyLink; dispatched: boolean }
const invalid = () => new Error('本地关联资料无效，请重新读取。')
const commands = ['localLegacyLinks.confirm', 'localLegacyLinks.revoke', 'localLegacyLinks.undo']
export const localLegacyContextKey = (key: dto.LocalLegacyKey): string => key.kind === 'physical-release' ? `physical:${key.physicalReleaseId}`
  : key.kind === 'digital-album' ? `digital:${key.digitalAlbumId}` : `source:${key.draftId}:${key.draftTrackId}:${key.sourceBindingId}`
export function localLegacyLinkMatches(link: dto.LocalLegacyLink, key: dto.LocalLegacyKey): boolean {
  const e = link.endpoints
  return key.kind === 'draft-source' ? e.kind === 'draft-source-track' && e.draftId === key.draftId && e.draftTrackId === key.draftTrackId && e.sourceBindingId === key.sourceBindingId
    : e.kind === 'legacy-edition' && (key.kind === 'physical-release' ? e.subject.kind === key.kind && e.subject.physicalReleaseId === key.physicalReleaseId
      : e.subject.kind === key.kind && e.subject.digitalAlbumId === key.digitalAlbumId)
}
export function localLegacyIssueMessage(issue: string | null): string {
  if (issue === 'EXACT_HASH_REQUIRED' || issue === 'SOURCE_CHANGED') return '源文件与本地资产未通过完整字节核验，未保存关联。'
  if (issue === 'LEGACY_RANGE_UNKNOWN' || issue === 'SEGMENT_MISMATCH') return '没有可核对的完整文件范围证据，未保存关联。'
  if (issue === 'SOURCE_OFFLINE' || issue === 'SOURCE_REVOKED') return '源目录离线或授权已撤销，请核对源文件后重新预览。'
  if (issue === 'PLAN_EXPIRED') return '预览已过期，请重新读取并预览。'
  if (issue === 'UNDO_CONFLICT') return '关系已有后续操作，本次撤销未保存，请读取最新历史。'
  return '关系、候选或修订已改变，请重新读取并核对后预览。'
}
/** 所有保存只发生在 confirm；恢复、历史、预览及生命周期变化均不派发保存。 */
export function useLocalLegacyLinks(api: LocalLegacyUiApi) {
  const context = shallowRef<LocalLegacyUiContext | null>(null), datasetId = ref('')
  const readState = ref<'idle' | 'loading' | 'loaded' | 'failed'>('idle'), error = ref(''), notice = ref('')
  const page = shallowRef<dto.LocalLegacyLinksReadPage | null>(null), roots = shallowRef<dto.LocalRootView[]>([])
  const candidates = shallowRef<dto.LocalLibraryQueryPage | null>(null), detail = shallowRef<dto.LocalLibraryTrackDetail | null>(null)
  const selectedEditionId = ref(''), reason = ref(''), action = ref<Action>('link'), targetLinkId = ref(''), undoEvent = shallowRef<dto.LocalLegacyLinkTransition | null>(null)
  const preview = shallowRef<dto.LocalLegacyLinkPreview | null>(null), history = shallowRef<dto.LocalLegacyLinksHistoryPage | null>(null)
  const pending = shallowRef<Pending | null>(null), overview = shallowRef<dto.CommandOutboxOverview | null>(null)
  const reading = ref(false), searching = ref(false), selecting = ref(false), previewing = ref(false), saving = ref(false), historyBusy = ref(false)
  let alive = true, generation = 0, readTicket = 0, searchTicket = 0, selectTicket = 0, previewTicket = 0, historyTicket = 0, inputRevision = 0
  const pendingByContext = new Map<string, Pending>(), recoveredCommands = new Set<string>()
  let savingOwner: Pending | null = null
  const currentKey = () => context.value ? localLegacyContextKey(context.value.key) : ''
  const valid = (g: number) => alive && generation === g
  const active = computed(() => page.value?.items.find(link => link.state === 'active') ?? null)
  const unknown = computed(() => pending.value?.dispatched && pending.value.contextKey === currentKey() && pending.value.datasetId === datasetId.value
    || overview.value?.entries.some(entry => entry.datasetId === datasetId.value && commands.includes(entry.command) && ['pending', 'sending', 'uncertain'].includes(entry.state) && !recoveredCommands.has(entry.commandId)) === true)
  const writeBlocked = computed(() => saving.value || unknown.value)
  const selectedEdition = computed(() => detail.value?.editions.find(edition => edition.id === selectedEditionId.value) ?? null)
  const selectedRoot = computed(() => roots.value.find(root => root.root.id === detail.value?.asset.libraryRootId) ?? null)
  const sourceRangeKnown = computed(() => {
    const value = detail.value
    return !!value && (value.track.segment === null || value.track.segment.startFrame === '0' && value.track.segment.endFrameExclusive === value.asset.sampleFrames && value.track.segment.timebaseHz === value.asset.timebaseHz)
  })
  const choice = computed<dto.LocalLegacyLinkChoice | null>(() => {
    const c = context.value, slot = page.value?.slot
    if (!c || !slot || slot.activeLinkId !== null) return null
    if (c.key.kind === 'draft-source') {
      const d = detail.value, root = selectedRoot.value
      if (!d || !root || root.availability !== 'ONLINE' || !sourceRangeKnown.value) return null
      return { kind: 'draft-source-track', draftId: c.key.draftId, draftTrackId: c.key.draftTrackId, expectedDraftRevision: c.revision,
        sourceBindingId: c.key.sourceBindingId, localTrackId: d.track.id, assetId: d.asset.id, expectedSelectionRevision: d.track.selectionRevision,
        expectedLibraryRootRevision: root.root.revision, expectedFileRevision: d.asset.fileRevision, expectedLocationRevision: d.asset.locationRevision,
        expectedSegment: d.track.segment, expectedSlot: slot }
    }
    const edition = selectedEdition.value
    if (!edition) return null
    const subject: dto.LocalLegacyEditionSubject = c.key.kind === 'physical-release'
      ? { kind: c.key.kind, physicalReleaseId: c.key.physicalReleaseId, expectedRevision: c.revision }
      : { kind: c.key.kind, digitalAlbumId: c.key.digitalAlbumId, expectedRevision: c.revision }
    return { kind: 'legacy-edition', subject, localEditionId: edition.id, expectedEditionRevision: edition.revision, expectedSlot: slot }
  })
  const canPreview = computed(() => readState.value === 'loaded' && !writeBlocked.value && !previewing.value && dto.isLocalLegacyReason(reason.value.trim())
    && (action.value === 'link' ? choice.value !== null : !!targetLinkId.value))
  const canConfirm = computed(() => !!preview.value && !writeBlocked.value && !previewing.value && Date.parse(preview.value.body.expiresAt) > Date.now())
  function invalidate(): void { inputRevision++; previewTicket++; previewing.value = false; preview.value = null; notice.value = '' }
  function setReason(value: string): void { reason.value = value; invalidate() }
  function setEdition(value: string): void { selectedEditionId.value = value; invalidate() }
  function resetDraft(): void { invalidate(); action.value = 'link'; targetLinkId.value = ''; undoEvent.value = null; reason.value = '' }
  function forget(p: Pending): void { if (pendingByContext.get(p.contextKey) === p) pendingByContext.delete(p.contextKey); if (pending.value === p) pending.value = null }
  function recoverHistory(events: dto.LocalLegacyLinkTransition[]): void {
    if (!context.value) return
    const p = pending.value
    for (const event of events) {
      if (event.datasetId !== datasetId.value || !localLegacyLinkMatches(event.after, context.value.key)) continue
      recoveredCommands.add(event.commandId)
      if (p?.dispatched && p.contextKey === currentKey() && p.datasetId === event.datasetId && p.request.commandId === event.commandId && p.request.previewId === event.previewId) {
        forget(p); invalidate(); notice.value = '已从持久历史读取原操作结果。'
      }
    }
    triggerRef(overview)
  }
  function setContext(value: LocalLegacyUiContext | null): void {
    const same = value && context.value && localLegacyContextKey(value.key) === currentKey() && value.revision === context.value.revision
    if (same) return
    generation++; readTicket++; searchTicket++; selectTicket++; historyTicket++; resetDraft()
    const key = value ? dto.localLegacyLinksDataSnapshot(value.key) : null
    if (value && (!dto.isLocalLegacyKey(key) || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > 1_000_000)) throw invalid()
    context.value = value && dto.isLocalLegacyKey(key) ? { key, revision: value.revision, title: value.title } : null
    pending.value = pendingByContext.get(currentKey()) ?? null; saving.value = savingOwner?.contextKey === currentKey()
    page.value = null; roots.value = []; candidates.value = null; detail.value = null; selectedEditionId.value = ''; history.value = null
    readState.value = 'idle'; error.value = ''; reading.value = searching.value = selecting.value = historyBusy.value = false
  }
  async function scope(g: number): Promise<dto.CommandOutboxOverview> {
    const value: unknown = await api.getCommandOutbox()
    if (!dto.isCommandOutboxOverview(value)) throw invalid()
    if (valid(g) && datasetId.value && datasetId.value !== value.datasetId) {
      invalidate(); page.value = null; history.value = null; readState.value = 'failed'
      throw new Error('工作库已改变，请关闭后重新打开；原操作不会自动重发。')
    }
    if (valid(g)) { datasetId.value = value.datasetId; overview.value = value }
    return value
  }
  function checkedRead(value: unknown, request: dto.ReadLocalLegacyLinks): dto.LocalLegacyLinksReadPage {
    value = dto.localLegacyLinksDataSnapshot(value, dto.LOCAL_LEGACY_LINKS_BUDGET.publicPageBytes, 32768, 100)
    if (!dto.isLocalLegacyLinksCommandResult('localLegacyLinks.read', value) || value.datasetId !== request.datasetId || value.limit !== request.limit) throw invalid()
    if (request.selector.by === 'legacy') {
      const key = request.selector.key
      if (value.slot === null || value.items.some(link => !localLegacyLinkMatches(link, key))) throw invalid()
      if (request.cursor === null && value.items.filter(link => link.state === 'active').length > 1) throw invalid()
    } else if (request.selector.by === 'link') { const id = request.selector.linkId; if (value.items.some(link => link.linkId !== id)) throw invalid() }
    return structuredClone(value)
  }
  function checkedHistory(value: unknown, request: dto.HistoryLocalLegacyLinks): dto.LocalLegacyLinksHistoryPage {
    value = dto.localLegacyLinksDataSnapshot(value, dto.LOCAL_LEGACY_LINKS_BUDGET.publicPageBytes, 32768, 100)
    if (!dto.isLocalLegacyLinksCommandResult('localLegacyLinks.history', value) || value.datasetId !== request.datasetId || value.linkId !== request.linkId || value.limit !== request.limit) throw invalid()
    return structuredClone(value)
  }
  async function read(more = false): Promise<void> {
    if (!alive || !context.value) return
    const g = generation, ticket = ++readTicket, key = structuredClone(context.value.key), previous = page.value
    if (more && !previous?.hasMore) return
    reading.value = true; if (!more) readState.value = 'loading'; error.value = ''
    try {
      const outbox = await scope(g); if (!valid(g) || ticket !== readTicket) return
      const request: dto.ReadLocalLegacyLinks = { datasetId: outbox.datasetId, selector: { by: 'legacy', key }, state: 'all', cursor: more ? previous!.cursor : null, limit: 20 }
      const value = checkedRead(await api.readLocalLegacyLinks(request), request)
      if (!valid(g) || ticket !== readTicket) return
      page.value = more && previous ? { ...value, items: [...previous.items, ...value.items] } : value; readState.value = 'loaded'
      const p = pending.value
      if (p?.dispatched && p.datasetId === outbox.datasetId && p.contextKey === currentKey()) {
        for (const linkId of new Set([p.linkId, ...page.value.items.map(link => link.linkId)])) {
          const h: dto.HistoryLocalLegacyLinks = { datasetId: outbox.datasetId, linkId, cursor: null, limit: 100 }
          const events = checkedHistory(await api.historyLocalLegacyLinks(h), h)
          if (!valid(g) || ticket !== readTicket) return
          recoverHistory(events.items); if (pending.value !== p) break
        }
        if (pending.value === p && outbox.entries.some(entry => entry.commandId === p.request.commandId && entry.state === 'rejected')) { forget(p); invalidate(); error.value = '原操作未被接受，请核对当前关系后重新预览。' }
      }
    } catch (cause) { if (valid(g) && ticket === readTicket) { readState.value = 'failed'; error.value = cause instanceof Error ? cause.message : '本地关联暂时无法读取，已有关系保留。' } }
    finally { if (valid(g) && ticket === readTicket) reading.value = false }
  }
  async function search(query: string, rootId: string | null, offset = 0): Promise<void> {
    if (!alive) return
    const g = generation, ticket = ++searchTicket; searching.value = true; error.value = ''
    try {
      await scope(g); if (!valid(g) || ticket !== searchTicket) return
      const request = { query: query.trim(), rootId, offset, limit: 20 }
      const [result, listed]: unknown[] = await Promise.all([api.queryLocalLibraryTracks(request), api.listLocalLibraryRoots()])
      if (!dto.isLocalLibraryQueryPage(result) || result.query !== request.query || result.rootId !== rootId || result.offset !== offset || result.limit !== 20
        || !Array.isArray(listed) || listed.length > 100 || !listed.every(dto.isLocalRootView)) throw invalid()
      if (valid(g) && ticket === searchTicket) { candidates.value = structuredClone(result); roots.value = structuredClone(listed) }
    } catch { if (valid(g) && ticket === searchTicket) error.value = '本地候选暂时无法读取，请重新查询；不会按标题猜测关系。' }
    finally { if (valid(g) && ticket === searchTicket) searching.value = false }
  }
  async function selectTrack(trackId: string): Promise<void> {
    if (!alive || writeBlocked.value) return
    invalidate(); const g = generation, ticket = ++selectTicket; selecting.value = true; detail.value = null; selectedEditionId.value = ''; error.value = ''
    try {
      await scope(g); if (!valid(g) || ticket !== selectTicket) return
      const [value, listed]: unknown[] = await Promise.all([api.getLocalLibraryTrackDetail(trackId), api.listLocalLibraryRoots()])
      if (!dto.isLocalLibraryTrackDetail(value) || value.track.id !== trackId || !Array.isArray(listed) || listed.length > 100 || !listed.every(dto.isLocalRootView)) throw invalid()
      if (valid(g) && ticket === selectTicket) { detail.value = structuredClone(value); roots.value = structuredClone(listed); action.value = 'link'; targetLinkId.value = ''; undoEvent.value = null }
    } catch { if (valid(g) && ticket === selectTicket) error.value = '所选曲目与目录修订暂时无法读取，请重新选择。' }
    finally { if (valid(g) && ticket === selectTicket) selecting.value = false }
  }
  function beginRevoke(link: dto.LocalLegacyLink): void {
    if (writeBlocked.value || link.state !== 'active') return
    resetDraft(); action.value = 'revoke'; targetLinkId.value = link.linkId
  }
  function beginUndo(event: dto.LocalLegacyLinkTransition): void {
    if (writeBlocked.value || event.action === 'undone') return
    resetDraft(); action.value = 'undo'; targetLinkId.value = event.linkId; undoEvent.value = structuredClone(event)
  }
  async function makePreview(): Promise<void> {
    if (!canPreview.value || !context.value) return
    const g = generation, ticket = ++previewTicket, version = inputRevision, c = context.value, chosen = choice.value ? structuredClone(choice.value) : null
    const desiredAction = action.value, linkId = targetLinkId.value, event = undoEvent.value ? structuredClone(undoEvent.value) : null, why = reason.value.trim()
    previewing.value = true; preview.value = null; error.value = ''; notice.value = ''
    try {
      const outbox = await scope(g); if (!valid(g) || ticket !== previewTicket || version !== inputRevision) return
      if (unknown.value) throw new Error('原本地关系操作结果尚未确认，请先重新读取。')
      let intent: dto.LocalLegacyLinkIntent
      if (desiredAction === 'link' && chosen) intent = { action: 'link', choice: chosen }
      else {
        const readRequest: dto.ReadLocalLegacyLinks = { datasetId: outbox.datasetId, selector: { by: 'link', linkId }, state: 'all', cursor: null, limit: 1 }
        const found = checkedRead(await api.readLocalLegacyLinks(readRequest), readRequest).items[0]
        if (!found || !localLegacyLinkMatches(found, c.key)) throw invalid()
        if (desiredAction === 'revoke' && found.state === 'active') intent = { action: 'revoke', linkId, expectedLinkRevision: found.revision }
        else if (desiredAction === 'undo' && event) intent = { action: 'undo', linkId, expectedLinkRevision: found.revision, undoTransitionEventId: event.eventId }
        else throw invalid()
      }
      if (!valid(g) || ticket !== previewTicket || version !== inputRevision) return
      const request: dto.PreviewLocalLegacyLink = { datasetId: outbox.datasetId, commandId: crypto.randomUUID(), intent, reason: why }
      const value: unknown = dto.localLegacyLinksDataSnapshot(await api.previewLocalLegacyLink(request), dto.LOCAL_LEGACY_LINKS_BUDGET.previewBytes, 2048, 100)
      if (!dto.isLocalLegacyLinkPreview(value) || value.datasetId !== outbox.datasetId || !dto.localLegacyEqual(value.body.intent, intent) || value.body.reason !== why
        || !localLegacyLinkMatches({ endpoints: value.body.endpoints } as dto.LocalLegacyLink, c.key)) throw invalid()
      if (valid(g) && ticket === previewTicket && version === inputRevision) preview.value = structuredClone(value)
    } catch (cause) { if (valid(g) && ticket === previewTicket && version === inputRevision) error.value = cause instanceof Error ? cause.message : '本次预览未完成，请核对当前关系后重新预览。' }
    finally { if (valid(g) && ticket === previewTicket) previewing.value = false }
  }
  async function confirm(): Promise<void> {
    const value = preview.value
    if (!canConfirm.value || !value) return
    const g = generation, version = inputRevision, kind = value.body.intent.action === 'link' ? 'confirm' : value.body.intent.action
    const key = context.value ? structuredClone(context.value.key) : null
    const request: dto.ExecuteLocalLegacyLink = { datasetId: value.datasetId, commandId: crypto.randomUUID(), previewId: value.previewId,
      expectedPreviewRevision: value.revision, previewHash: value.previewHash, contextFingerprint: value.contextFingerprint, userConfirmed: true }
    const p: Pending = { datasetId: value.datasetId, contextKey: currentKey(), linkId: value.body.plannedLinkId, kind, request, dispatched: false }
    pendingByContext.set(p.contextKey, p); pending.value = p; savingOwner = p; saving.value = true; error.value = ''; notice.value = ''
    try {
      const outbox = await scope(g)
      if (!valid(g) || version !== inputRevision || outbox.datasetId !== request.datasetId) { forget(p); return }
      if (unknown.value) { forget(p); throw new Error('原本地关系操作结果尚未确认，请先重新读取。') }
      p.dispatched = true; triggerRef(pending); preview.value = null
      const result: unknown = dto.localLegacyLinksDataSnapshot(await (kind === 'confirm' ? api.confirmLocalLegacyLink(request) : kind === 'revoke' ? api.revokeLocalLegacyLink(request) : api.undoLocalLegacyLink(request)), dto.LOCAL_LEGACY_LINKS_BUDGET.edgeBytes * 2, 2048, 100)
      if (!dto.isLocalLegacyLinkReceipt(result) || result.datasetId !== request.datasetId || result.commandId !== request.commandId || result.previewId !== request.previewId || result.action !== kind
        || result.link !== null && (!key || !localLegacyLinkMatches(result.link, key))) throw invalid()
      forget(p)
      if (!valid(g)) return
      invalidate(); resetDraft()
      if (result.outcome === 'applied') { await read(); if (!valid(g)) return; notice.value = kind === 'confirm' ? '本地关联已保存。' : kind === 'revoke' ? '本地关联已解除。' : '关系操作已撤销。'; if (result.link && history.value?.linkId === result.link.linkId) await readHistory(result.link.linkId) }
      else { await read(); if (valid(g)) error.value = localLegacyIssueMessage(result.issue) }
    } catch (cause) {
      if (!p.dispatched) forget(p)
      if (valid(g)) { preview.value = null; error.value = p.dispatched ? '原操作结果尚未确认，请重新读取持久关系与历史；不会自动重发。' : cause instanceof Error ? cause.message : '本次操作未派发，请重新读取。' }
    } finally { if (savingOwner === p) { savingOwner = null; if (alive && currentKey() === p.contextKey) saving.value = false } }
  }
  async function readHistory(linkId: string, more = false): Promise<void> {
    if (!alive) return
    const g = generation, ticket = ++historyTicket, previous = history.value
    if (more && (previous?.linkId !== linkId || !previous.hasMore)) return
    historyBusy.value = true; error.value = ''
    try {
      const outbox = await scope(g); if (!valid(g) || ticket !== historyTicket) return
      const request: dto.HistoryLocalLegacyLinks = { datasetId: outbox.datasetId, linkId, cursor: more ? previous!.cursor : null, limit: 20 }
      const value = checkedHistory(await api.historyLocalLegacyLinks(request), request)
      if (valid(g) && ticket === historyTicket) { history.value = more && previous ? { ...value, items: [...previous.items, ...value.items] } : value; recoverHistory(value.items) }
    } catch { if (valid(g) && ticket === historyTicket) error.value = '本地关系历史暂时无法读取，当前关系仍保留。' }
    finally { if (valid(g) && ticket === historyTicket) historyBusy.value = false }
  }
  function dispose(): void { alive = false; generation++; readTicket++; searchTicket++; selectTicket++; previewTicket++; historyTicket++; preview.value = null }
  return { context, datasetId, readState, error, notice, page, roots, candidates, detail, selectedEditionId, reason, action, targetLinkId, undoEvent,
    preview, history, pending, reading, searching, selecting, previewing, saving, historyBusy, active, unknown, writeBlocked, selectedEdition, sourceRangeKnown,
    canPreview, canConfirm, setContext, setReason, setEdition, resetDraft, invalidate, read, search, selectTrack, beginRevoke, beginUndo, makePreview, confirm, readHistory, dispose }
}
