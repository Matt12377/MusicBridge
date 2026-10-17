import { noteDesktopArtwork, desktopArtworkStarted, desktopArtworkElapsed, desktopArtworkKey } from '../../shared/desktop-artwork-trace-node.js'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import type { CollectionRepository } from '../repository.js'
import type { DatasetProjectionPort } from '../dataset-owner-protocol.js'
import type { RootCapability } from '../../recording/source-files.js'
import { readonlySourceCandidateMetadata, sourceRootAvailability, withCheckedReadonlyMetadataSource, MetadataLeaseReleaseError, SourceFileError } from '../../recording/source-files.js'
import { readLocalEmbeddedArtwork } from '../../library/local-artwork-embedded-reader.js'
import { readonlyLocalArtworkCandidateNames } from '../../library/local-artwork-directory-candidates.js'
import type { LocalAlbumArtworkReadContext } from './types.js'
import { isLocalAlbumPrivateRelative, LocalAlbumReadError } from './grouping.js'
import type { LocalAlbumDisplayCacheEvidence, LocalAlbumDisplayCacheRecord } from './display-cache.js'
import { captureLocalAlbumContext, localAlbumPhase, emitLocalAlbumNodeTrace } from '../../shared/local-album-read-trace-node.js'

type ReadContext = { request: dto.LocalAlbumArtworkRequest; context: LocalAlbumArtworkReadContext }
type Capture = { target: ReadContext; root: RootCapability; relative: string; signature: string; expires: number }
type ReadMode = 'candidate' | 'display'
export interface LocalAlbumArtworkSources { image: dto.LocalArtworkImage | null; copies: dto.LocalArtworkSourceCopies }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
type PermitTraceStage = 'localAlbum.artwork.permit-granted' | 'localAlbum.artwork.permit-deferred' | 'localAlbum.artwork.no-permit-unavailable'

/** 仅旁注原许可结果；诊断故障不改变业务，离开时恢复原首拒绝阶段。 */
function notePermitTrace(stage: PermitTraceStage): void {
  try {
    const context = captureLocalAlbumContext()
    if (!context) return
    const previousStage = context.stage
    try {
      localAlbumPhase(stage)
      emitLocalAlbumNodeTrace('ok')
    } finally {
      context.stage = previousStage
    }
  } catch { /* 诊断自己的故障不能改变原返回、异常或许可生命周期。 */ }
}

/** 未建立发行的目录也能读图；不会调用 stage/apply/createEdition。所有字节仅进入可信 Main。 */
export function createLocalAlbumArtworkReader(options: {
  repository: CollectionRepository; projection?: DatasetProjectionPort; datasetId?: string; assertCurrent(): void
}) {
  const catalog = options.repository.localCatalog, captures = new Map<string, Capture>()
  type DisplayProof = { target: ReadContext; key: string; evidence: LocalAlbumDisplayCacheEvidence; deadline: number }
  type DisplayVerification = { key: string; record: LocalAlbumDisplayCacheRecord }
  const displayProofs = new WeakMap<LocalAlbumArtworkSources, DisplayProof>()
  const retiredLibraries=new Set<string>()
  const active = new Map<string, { libraryId:string; abort: AbortController; task: Promise<LocalAlbumArtworkSources> }>()
  const permitReleases = new Map<string, Promise<boolean>>()
  let closed = false, fatal = false
  const check = (): void => { options.assertCurrent(); if (closed || fatal) throw new Error('专辑封面读取已停止。') }
  function locate(target: ReadContext) {
    check()
    const { request, context } = target, { album, representative, directory } = context
    if (!dto.isLocalAlbumArtworkRequest(request) || !dto.isLocalAlbumSummary(album)
      || request.albumKey !== album.id || request.rootId !== album.rootId || request.revision !== album.revision
      || request.editionId !== album.editionId || request.representativeTrackId !== album.representativeTrackId
      || directory !== null && !isLocalAlbumPrivateRelative(directory, true)) throw new Error('专辑封面身份无效。')
    if(retiredLibraries.has(album.rootId)||!catalog.privateLibraryManagementRootAvailable(album.rootId))throw new Error('原库专辑封面读取已撤销。')
    const root = catalog.root(album.rootId), capability = options.repository.sources.root(root.sourceRootId)
    if (representative) {
      const detail = catalog.trackDetail(representative.summary.track.id), locator = catalog.privateAssetLocator(detail.asset.id)
      if (!same(detail.track, representative.summary.track) || !same(detail.asset, representative.summary.asset)
        || !same(detail.metadata.raw, representative.rawMetadata) || !same(detail.metadata.effective, representative.summary.metadata)
        || locator.relative !== representative.relative || detail.asset.libraryRootId !== root.id
        || detail.asset.sourceRootId !== capability.id || detail.asset.rootRevision !== root.revision) throw new Error('专辑封面来源已改变。')
      return { root, capability, relative: locator.relative, directory: directory ?? path.posix.dirname(locator.relative) }
    }
    if (album.trackCount !== 0 || album.representativeTrackId !== null || directory === null) throw new Error('专辑目录来源不可读取。')
    return { root, capability, relative: null, directory: directory || '.' }
  }
  // 版本覆盖图源优先级、嵌入解析及Main规范化；这些规则变化必须同步更新。
  function displayCacheKey(target: ReadContext, value: ReturnType<typeof locate>): string | null {
    if (!options.repository.privateLocalAlbumDisplayCache || !dto.isCollectionId(options.datasetId)
      || !/^[a-f0-9]{64}$/u.test(target.context.artworkSourceRevision ?? '')) return null
    return hash(['local-album-display-v2', options.datasetId, target.context.artworkSourceRevision, value.root, value.capability,
      target.request.albumKey, target.request.rootId, target.request.editionId, target.request.representativeTrackId, value.directory])
  }
  async function verifyDisplayEvidence(value: ReturnType<typeof locate>, evidence: LocalAlbumDisplayCacheEvidence, signal: AbortSignal, deadlineAtMs: number, alive: () => void): Promise<boolean> {
    if (evidence.unresolved || !evidence.embeddedConfirmed && !evidence.independentOnly || evidence.independent.length > 32) return false
    let index = 0, included = 0, unresolved = false
    for await (const name of readonlyLocalArtworkCandidateNames({ root: value.capability, directory: value.directory, signal,
      deadlineMs: Date.now() + Math.max(0, deadlineAtMs - performance.now()), assertCurrent: alive,
      hasCandidateSlot: () => included < 2, unresolved: () => { unresolved = true } })) {
      alive(); const relative = path.posix.join(value.directory, name), expected = evidence.independent[index++]
      if (!expected || relative !== expected.relative) return false
      let observed: Awaited<ReturnType<typeof readonlySourceCandidateMetadata>>
      try { observed = await readonlySourceCandidateMetadata(value.capability, relative) }
      catch (error) { if (error instanceof SourceFileError && error.code === 'MISSING') return false; throw error }
      alive(); if (observed.signature !== expected.signature || observed.size !== expected.size) return false
      if (expected.included) included++
    }
    if (unresolved || index !== evidence.independent.length) return false
    if (value.relative === null) return evidence.embedded === null
    if (!evidence.embedded || evidence.embedded.relative !== value.relative) return false
    let observed: Awaited<ReturnType<typeof readonlySourceCandidateMetadata>>
    try { observed = await readonlySourceCandidateMetadata(value.capability, value.relative) }
    catch (error) { if (error instanceof SourceFileError && error.code === 'MISSING') return false; throw error }
    alive(); return observed.signature === evidence.embedded.signature && observed.size === evidence.embedded.size
  }
  async function revalidateCapture(captured: Capture, readCurrent?: () => void): Promise<void> {
    check(); readCurrent?.()
    if (captured.expires <= Date.now()) throw new Error('封面捕获已过期，请重新读取。')
    const current = locate(captured.target)
    if (!same(current.capability, captured.root) || await sourceRootAvailability(current.capability) !== 'ONLINE') throw new Error('封面来源许可或目录已改变。')
    check(); readCurrent?.()
    const observed = await readonlySourceCandidateMetadata(current.capability, captured.relative)
    check(); readCurrent?.(); if (observed.signature !== captured.signature) throw new Error('封面来源文件已改变。')
  }
  async function revalidate(sourceIdentity: string): Promise<void> {
    check()
    const captured = captures.get(sourceIdentity)
    if (!captured) throw new Error('封面捕获已过期，请重新读取。')
    await revalidateCapture(captured)
  }
  /** 只等本实例实际释放一次；不轮询其它读者、不增加许可或延长原请求期限。 */
  async function waitForPermitRelease(signal: AbortSignal, deadlineAtMs: number): Promise<boolean> {
    check()
    const releases = [...permitReleases.values()]
    if (!releases.length || signal.aborted || performance.now() >= deadlineAtMs) return false
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (released: boolean): void => {
        if (settled) return
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop)
        resolve(released && !signal.aborted && performance.now() < deadlineAtMs)
      }
      const stop = (): void => finish(false)
      const timer = setTimeout(stop, Math.max(1, Math.ceil(deadlineAtMs - performance.now())))
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop()
      void Promise.race(releases).then(finish, stop)
    })
  }
  async function read(target: ReadContext, signal: AbortSignal, readDeadlineAtMs: number, mode: ReadMode, verification?: DisplayVerification): Promise<LocalAlbumArtworkSources> {
    const value = locate(target), empty = (): LocalAlbumArtworkSources => ({ image: null, copies: { status: 'source-unavailable', items: [] } })
    if (signal.aborted || performance.now() >= readDeadlineAtMs) return empty()
    if (!verification && target.request.editionId && target.request.representativeTrackId) {
      const selected = options.repository.localArtwork.context({ trackId: target.request.representativeTrackId, editionId: target.request.editionId }).selection?.candidate
      if (selected) {
        const image = { original: structuredClone(selected.original), display: structuredClone(selected.display) }
        if (!dto.isLocalArtworkImage(image)) throw new Error('已保存的专辑封面副本无效。')
        check(); locate(target); if (signal.aborted || performance.now() >= readDeadlineAtMs) throw new Error('专辑封面读取已取消或超时。')
        return { image, copies: { status: 'ready', items: [] } }
      }
    }
    const projection = options.projection
    if (!projection || signal.aborted) return empty()
    const online = await sourceRootAvailability(value.capability) === 'ONLINE'
    if (!online && verification) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '封面来源在解码期间已不可用，请重新读取。')
    if (!online) return empty()
    if (signal.aborted || performance.now() >= readDeadlineAtMs) return empty()
    let acquired = await projection.call('scanReadAcquire', mode === 'display' ? { purpose: 'local-album-display' } : {})
    if (acquired.status === 'granted') notePermitTrace('localAlbum.artwork.permit-granted')
    else if (acquired.status === 'deferred') notePermitTrace('localAlbum.artwork.permit-deferred')
    if (acquired.status !== 'granted') {
      // 可选落盘确认不排队，不因别的前台读取占槽拖延已成功的封面回复。
      if (verification) { notePermitTrace('localAlbum.artwork.no-permit-unavailable'); return empty() }
      const released = await waitForPermitRelease(signal, readDeadlineAtMs)
      check(); const current = locate(target)
      if (!same(current.root, value.root) || !same(current.capability, value.capability)
        || current.relative !== value.relative || current.directory !== value.directory) throw new Error('等候期间封面来源已改变。')
      if (!released || signal.aborted || performance.now() >= readDeadlineAtMs
        || await sourceRootAvailability(value.capability) !== 'ONLINE') {
        notePermitTrace('localAlbum.artwork.no-permit-unavailable'); return empty()
      }
      check(); locate(target)
      if (signal.aborted || performance.now() >= readDeadlineAtMs) {
        notePermitTrace('localAlbum.artwork.no-permit-unavailable'); return empty()
      }
      acquired = await projection.call('scanReadAcquire', mode === 'display' ? { purpose: 'local-album-display' } : {})
      if (acquired.status === 'granted') notePermitTrace('localAlbum.artwork.permit-granted')
      else if (acquired.status === 'deferred') notePermitTrace('localAlbum.artwork.permit-deferred')
      if (acquired.status !== 'granted') { check(); notePermitTrace('localAlbum.artwork.no-permit-unavailable'); return empty() }
    }
    const permit = acquired
    let finishPermit!: (released: boolean) => void
    permitReleases.set(permit.permitId, new Promise<boolean>(resolve => { finishPermit = resolve }))
    const abort = new AbortController(), forward = (): void => abort.abort()
    signal.addEventListener('abort', forward, { once: true }); if (signal.aborted || performance.now() >= readDeadlineAtMs) forward()
    let finished = false, leaseFailed = false, watchFailed = false
    const watch = (async () => { while (!finished) { const result = await projection.call('scanReadWatchRevocation', { permitId: permit.permitId });
      if (result.reason === 'renew') continue
      if (result.reason !== 'permit-released') abort.abort()
      break
    } })().catch(() => { watchFailed = true; abort.abort() })
    const deadline = Date.now() + 10_000, items: dto.LocalArtworkSourceCopies['items'] = [], pendingCaptures = new Map<string, Capture>()
    const sourceStarted = desktopArtworkStarted()
    const displayKey = mode === 'display' ? displayCacheKey(target, value) : null
    const traceKey = desktopArtworkKey(JSON.stringify([target.request.albumKey, target.request.rootId, target.request.editionId, target.request.representativeTrackId, target.request.revision]))
    let cacheHit = false, cacheProofComplete = true
    const independentProof: LocalAlbumDisplayCacheEvidence['independent'][number][] = []
    let embeddedProof: LocalAlbumDisplayCacheEvidence['embedded'] = null
    let result!: LocalAlbumArtworkSources
    const alive = (): void => { check(); locate(target); if (abort.signal.aborted || signal.aborted || performance.now() >= readDeadlineAtMs || Date.now() > deadline) throw new Error('专辑封面读取已取消或超时。') }
    let total = 0, embeddedConfirmed = value.relative === null, independentUnresolved = false
    const remember = (bytes: Uint8Array, relative: string, signature: string, origin: 'local-independent' | 'embedded', label: string, index: number): void => {
      alive()
      if (!bytes.length || bytes.length > dto.LOCAL_ARTWORK_INPUT_BYTES || total + bytes.length > 8 * 1024 * 1024 || items.length >= 4) return
      if (mode === 'candidate') for (const [key, entry] of captures) if (entry.expires <= Date.now()) captures.delete(key)
      const digest = createHash('sha256').update(bytes).digest('hex')
      const sourceIdentity = hash([target.request, value.root, relative, signature, origin, index, digest])
      const additions = [...pendingCaptures.keys()].filter(key => !captures.has(key)).length
      if (mode === 'candidate' && !captures.has(sourceIdentity) && !pendingCaptures.has(sourceIdentity) && captures.size + additions >= 64) throw new Error('封面来源缓存已满，请稍后重新查找。')
      const captured = { target: structuredClone(target), root: value.capability, relative, signature, expires: Date.now() + 10 * 60_000 }, base64 = Buffer.from(bytes).toString('base64')
      alive(); pendingCaptures.set(sourceIdentity, captured)
      total += bytes.length; items.push({ origin, sourceIdentity, sourceLabel: label, base64 })
    }
    try {
      if (verification && displayKey !== verification.key) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '封面来源已改变，请重新读取。')
      const cached = mode === 'display' && displayKey ? verification?.record ?? options.repository.privateLocalAlbumDisplayCache?.get(displayKey, target.request.rootId) : null
      if (cached && await verifyDisplayEvidence(value, cached.evidence, abort.signal, readDeadlineAtMs, alive)) {
        alive(); result = { image: cached.image, copies: { status: 'ready', items: [] } }; cacheHit = true
        if (!verification) noteDesktopArtwork('disk-hit', traceKey, { bytes: cached.image.display.bytes })
      }
      if (verification && !cacheHit) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '封面来源在解码期间已改变，请重新读取。')
      if (!cacheHit) {
      if (mode === 'display' && !verification) noteDesktopArtwork('disk-miss', traceKey, { reason: !displayKey ? 'no-cache' : cached ? 'source-changed' : 'not-found' })
      const independentSignatures = new Set<string>()
      for await (const file of readonlyLocalArtworkCandidateNames({ root: value.capability, directory: value.directory, signal: abort.signal,
        deadlineMs: Math.min(deadline, Date.now() + Math.max(0, readDeadlineAtMs - performance.now())), assertCurrent: alive,
        hasCandidateSlot: () => items.length < 2, unresolved: () => { independentUnresolved = true } })) {
        alive(); if (items.length >= 2) break
        const relative = path.posix.join(value.directory, file)
        try {
          const observed = await readonlySourceCandidateMetadata(value.capability, relative); alive()
          const proof = { relative, signature: observed.signature, size: observed.size, included: false }
          if (independentProof.length < 32) independentProof.push(proof); else cacheProofComplete = false
          if (observed.size > dto.LOCAL_ARTWORK_INPUT_BYTES || independentSignatures.has(observed.signature)) continue
          const extractionStarted = desktopArtworkStarted()
          const bytes = await withCheckedReadonlyMetadataSource(value.capability, relative, observed.signature, abort.signal, async (fd, size) => {
            if (mode === 'display') noteDesktopArtwork('source-extract', traceKey)
            const bytes = Buffer.alloc(size)
            for (let offset = 0; offset < size;) { alive(); const result = await fd.read(bytes, offset, Math.min(64 * 1024, size - offset), offset); alive()
              if (!result.bytesRead) throw new Error('封面来源被截断。'); offset += result.bytesRead }
            return bytes
          }, alive)
          if (mode === 'display') noteDesktopArtwork('source-extract', traceKey, { count: 0, elapsedMs: desktopArtworkElapsed(extractionStarted), bytes: bytes.length })
          const previousCount = items.length
          remember(bytes, relative, observed.signature, 'local-independent', file, 0)
          if (items.length > previousCount) { independentSignatures.add(observed.signature); proof.included = true }
        } catch (error) { if (error instanceof SourceFileError && error.code === 'MISSING') continue; throw error }
      }
      if (value.relative && items.length < 4) {
        try {
          const observed = await readonlySourceCandidateMetadata(value.capability, value.relative); alive()
          embeddedProof = { relative: value.relative, signature: observed.signature, size: observed.size }
          const extractionStarted = desktopArtworkStarted()
          const pictures = await withCheckedReadonlyMetadataSource(value.capability, value.relative, observed.signature, abort.signal,
            (fd, size) => { if (mode === 'display') noteDesktopArtwork('source-extract', traceKey); return readLocalEmbeddedArtwork(fd, size, abort.signal) }, alive)
          if (mode === 'display') noteDesktopArtwork('source-extract', traceKey, { count: 0, elapsedMs: desktopArtworkElapsed(extractionStarted) })
          embeddedConfirmed = true
          for (const picture of pictures) remember(picture.bytes, value.relative, observed.signature, 'embedded', `内嵌图片 ${picture.pictureIndex + 1}`, picture.pictureIndex)
        } catch (error) {
          if (error instanceof MetadataLeaseReleaseError || error instanceof SourceFileError || abort.signal.aborted) throw error
          // 不支持的内嵌容器不阻断已实读独立图；也不能把无法解析当作“确认无图”。
        }
      }
      for (const item of items) { alive(); await revalidateCapture(pendingCaptures.get(item.sourceIdentity)!, alive); alive() }
      alive(); result = { image: null, copies: { status: items.length || (embeddedConfirmed && !independentUnresolved) ? 'ready' : 'source-unavailable', items } }
      }
    } catch (error) {
      if (error instanceof MetadataLeaseReleaseError) { fatal = true; leaseFailed = true }
      throw error
    } finally {
      finished = true; signal.removeEventListener('abort', forward)
      if (!leaseFailed) {
        let released = false
        try { await projection.call('scanReadRelease', { permitId: permit.permitId }); await watch
          if (watchFailed) throw new Error('专辑封面许可收口未确认。')
          released = true
        } catch (error) { fatal = true; throw error }
        finally { if (released) permitReleases.delete(permit.permitId); finishPermit(released) }
      } else { finishPermit(false); void watch }
    }
    // 原FD与许可真正闭后再发布；截止到达不能把未完成捕获塞入共享来源缓存。
    alive()
    // 显示仍保本次完整来源回核；真实资源已闭后返回，既不触共享门槛也不发布/清理候选。
    if (mode === 'display') {
      const independentOnly = items.length > 0 && items.every(item => item.origin === 'local-independent')
      if (!cacheHit && displayKey && cacheProofComplete && !independentUnresolved && (embeddedConfirmed || independentOnly)) {
        displayProofs.set(result, { target: structuredClone(target), key: displayKey, deadline: readDeadlineAtMs,
          evidence: { independent: independentProof, embedded: embeddedProof, unresolved: false, embeddedConfirmed, independentOnly } })
      }
      if (!verification) noteDesktopArtwork('source-read', traceKey, { count: 0, elapsedMs: desktopArtworkElapsed(sourceStarted), bytes: total })
      return result
    }
    for (const [key, entry] of captures) if (entry.expires <= Date.now()) captures.delete(key)
    const additions = [...pendingCaptures.keys()].filter(key => !captures.has(key)).length
    if (captures.size + additions > 64) throw new Error('封面来源缓存已满，请稍后重新查找。')
    const previous = new Map([...pendingCaptures.keys()].map(key => [key, captures.get(key)] as const))
    try {
      alive()
      for (const [key, captured] of pendingCaptures) captures.set(key, captured)
      alive(); return result
    } catch (error) {
      // 此同步段没有await；只撤回本次尚未返回的发布，保留先前同来源捕获。
      for (const [key, captured] of previous) { if (captured) captures.set(key, captured); else captures.delete(key) }
      throw error
    }
  }
  function readTask(target: ReadContext, lookupId: string, signal?: AbortSignal, deadlineAtMs?: number, mode: ReadMode = 'candidate', verification?: DisplayVerification): Promise<LocalAlbumArtworkSources> {
      check(); if (!dto.isCollectionId(lookupId) || active.has(lookupId) || active.size >= 4) throw new Error('专辑封面读取请求已满或身份无效。')
      if (mode !== 'candidate' && mode !== 'display') throw new Error('专辑封面私有读取用途无效。')
      if (deadlineAtMs !== undefined && !Number.isFinite(deadlineAtMs)) throw new Error('封面读取原期限无效。')
      const acceptedAtMs = performance.now(), readDeadlineAtMs = Math.min(deadlineAtMs ?? acceptedAtMs + 2000, acceptedAtMs + 2000)
      const abort = new AbortController(), forward = (): void => abort.abort()
      signal?.addEventListener('abort', forward, { once: true }); if (signal?.aborted) forward()
      if (mode === 'display' && !verification) noteDesktopArtwork('source-read', desktopArtworkKey(JSON.stringify([target.request.albumKey, target.request.rootId, target.request.editionId, target.request.representativeTrackId, target.request.revision])))
      const task = read(target, abort.signal, readDeadlineAtMs, mode, verification).finally(() => { active.delete(lookupId); signal?.removeEventListener('abort', forward) })
      active.set(lookupId, { libraryId:target.request.rootId,abort,task }); return task

  }
  return {
    readSources(target: ReadContext, lookupId: string, signal?: AbortSignal, deadlineAtMs?: number, mode: ReadMode = 'candidate'): Promise<LocalAlbumArtworkSources> { return readTask(target, lookupId, signal, deadlineAtMs, mode) },
    async retainDisplay(sources: LocalAlbumArtworkSources, image: dto.LocalArtworkImage, seal: () => void): Promise<void> {
      const proof = displayProofs.get(sources); displayProofs.delete(sources)
      if (!proof) { noteDesktopArtwork('disk-skip', null, { reason: 'no-proof' }); return }
      check(); locate(proof.target); seal()
      // 本地容量与许可不足都只放弃派生落盘；来源、身份与撤销错误仍由上方检查抛出。
      if (!options.repository.privateLocalAlbumDisplayCache) { noteDesktopArtwork('disk-skip', proof.key, { reason: 'no-cache' }); return }
      if (performance.now() >= proof.deadline) { noteDesktopArtwork('disk-skip', proof.key, { reason: 'expired' }); return }
      if (active.size >= 4) { noteDesktopArtwork('disk-skip', proof.key, { reason: 'busy' }); return }
      // 解码await后用原总两槽再核metadata，期限仍是第一次读取的原期限。
      const verifyStarted = desktopArtworkStarted()
      const checked = await readTask(proof.target, randomUUID(), undefined, proof.deadline, 'display', { key: proof.key, record: { image, evidence: proof.evidence } })
      noteDesktopArtwork('revalidate', proof.key, { elapsedMs: desktopArtworkElapsed(verifyStarted) })
      check(); if (!checked.image) { noteDesktopArtwork('disk-skip', proof.key, { reason: 'unresolved' }); return }
      if (checked.image.display.sha256 !== image.display.sha256 || checked.image.original.sha256 !== image.original.sha256) throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '封面来源在解码期间已改变，请重新读取。')
      locate(proof.target); seal()
      options.repository.privateLocalAlbumDisplayCache.put(proof.key, proof.target.request.rootId, { image, evidence: proof.evidence })
      check(); seal()
    },
    revalidate,
    cancel(lookupId: string) { active.get(lookupId)?.abort.abort() },
    async removeLibrary(libraryId:string){check();retiredLibraries.add(libraryId);const selected=[...active.values()].filter(value=>value.libraryId===libraryId)
      for(const entry of selected)entry.abort.abort();await Promise.allSettled(selected.map(entry=>entry.task))
      if(fatal)throw new Error('本库专辑封面许可关闭未确认，捕获继续保留。')
      for(const [key,capture]of captures)if(capture.target.request.rootId===libraryId)captures.delete(key)
      options.repository.privateLocalAlbumDisplayCache?.removeRoot(libraryId)
    },
    async close() { closed = true; for (const entry of active.values()) entry.abort.abort()
      await Promise.allSettled([...active.values()].map(entry => entry.task))
      if (fatal) throw new Error('专辑封面资源关闭未确认，原工作库连接必须保留。')
      captures.clear()
    },
  }
}
