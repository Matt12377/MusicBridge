import { createHash, randomUUID } from 'node:crypto'
import {
  isLocalWorkbenchApplyRequest, isLocalWorkbenchCommandPayload, isLocalWorkbenchIdentity, isLocalWorkbenchPlan, isLocalWorkbenchReceipt,
  isLocalWorkbenchText, isLocalArtworkImage, type LocalWorkbenchApplyRequest, type LocalWorkbenchCancelRequest, type LocalWorkbenchOperation,
  LOCAL_ARTWORK_INPUT_BYTES, LOCAL_ARTWORK_DISPLAY_BYTES, type LocalArtworkImageInfo, type LocalWorkbenchPlan, type LocalWorkbenchReceipt,
} from '@music-bridge/contracts'
import { isLocalCueAudioProbe, isLocalCueFormatQualification } from './cue-plan.js'
import { isLocalWorkbenchAlbumCapture } from './name-proposal.js'
import {
  freezeLocalWorkbenchValue, isLocalWorkbenchDataRecord, isLocalWorkbenchDenseArray, LocalWorkbenchPlanError,
  type LocalWorkbenchPlanCapture, type LocalWorkbenchPlanDraft, type LocalWorkbenchProtectedWriter,
  type LocalWorkbenchRegistryEntry, type LocalWorkbenchRegistryPersistence, type LocalWorkbenchRegistrySnapshot, type LocalWorkbenchArtworkCapture, type LocalWorkbenchFrozenArtwork,
} from './types.js'

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && a.every(value => b.includes(value))
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}'
  const result = JSON.stringify(value)
  if (result === undefined) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '冻结输入含未定义值。')
  return result
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const clone = <T>(value: T): T => structuredClone(value)
function state(entry: LocalWorkbenchRegistryEntry): LocalWorkbenchReceipt['state'] {
  return !entry.receipt ? 'unknown' : entry.receipt.state === 'running' ? 'running'
    : entry.receipt.items.some(item => item.state === 'unknown') ? 'unknown' : entry.receipt.state
}
const unresolved = (entry: LocalWorkbenchRegistryEntry): boolean => entry.original !== null && ['unknown', 'running'].includes(state(entry))
function requestMatchesPlan(request: LocalWorkbenchApplyRequest, plan: LocalWorkbenchPlan): boolean {
  return request.datasetId === plan.datasetId && request.planId === plan.planId && request.kind === plan.kind
    && request.expectedRevision === plan.revision && request.planHash === plan.planHash && request.contextFingerprint === plan.contextFingerprint
}
function requestEqual(a: LocalWorkbenchApplyRequest, b: LocalWorkbenchApplyRequest): boolean { return canonical(a) === canonical(b) }
function unknownReceipt(request: LocalWorkbenchApplyRequest, plan: LocalWorkbenchPlan): LocalWorkbenchReceipt {
  return { commandId: request.commandId, datasetId: request.datasetId, planId: request.planId, planHash: request.planHash,
    state: 'unknown', message: '原操作结果尚未确认；只查询原命令，不重复应用。',
    items: plan.items.map(item => ({ itemId: item.itemId, albumId: item.albumId, label: item.label, state: 'unknown', message: '尚未取得此项原回执。' })) }
}
function notWrittenReceipt(request: LocalWorkbenchApplyRequest, plan: LocalWorkbenchPlan, message: string): LocalWorkbenchReceipt {
  return { commandId: request.commandId, datasetId: request.datasetId, planId: request.planId, planHash: request.planHash,
    state: 'failed', message, items: plan.items.map(item => ({ itemId: item.itemId, albumId: item.albumId, label: item.label, state: 'not-written', message })) }
}
function imageBytesMatch(base64: unknown, info: LocalArtworkImageInfo, maxBytes: number): boolean {
  if (typeof base64 !== 'string' || info.bytes > maxBytes || base64.length !== 4 * Math.ceil(info.bytes / 3)
    || base64.length > 4 * Math.ceil(maxBytes / 3) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) return false
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length !== info.bytes || bytes.toString('base64') !== base64 || createHash('sha256').update(bytes).digest('hex') !== info.sha256) return false
  return info.mime === 'image/jpeg'
    ? bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
    : bytes.length >= 20 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
}
export function isLocalWorkbenchArtworkCapture(value: unknown): value is LocalWorkbenchArtworkCapture {
  if (!isLocalWorkbenchDataRecord(value, ['albumId', 'candidateId', 'revision', 'image', 'originalBase64', 'origin', 'sourceLabel', 'licenseLabel'], ['sourceIdentity', 'input'])
    || ![value.albumId, value.candidateId, value.revision].every(isLocalWorkbenchIdentity)
    || !['local-independent', 'embedded', 'manual', 'provider'].includes(String(value.origin)) || !isLocalWorkbenchText(value.sourceLabel) || !isLocalWorkbenchText(value.licenseLabel)
    || Object.hasOwn(value, 'sourceIdentity') && !isLocalWorkbenchIdentity(value.sourceIdentity)) return false
  const image = value.image
  if (!isLocalWorkbenchDataRecord(image, ['original', 'display']) || !isLocalWorkbenchDataRecord(image.original, ['mime', 'bytes', 'sha256', 'width', 'height'])
    || !isLocalWorkbenchDataRecord(image.display, ['mime', 'bytes', 'sha256', 'width', 'height', 'dataUrl']) || !isLocalArtworkImage(image)) return false
  if (!imageBytesMatch(value.originalBase64, image.original, LOCAL_ARTWORK_INPUT_BYTES)
    || !imageBytesMatch(image.display.dataUrl.slice(23), image.display, LOCAL_ARTWORK_DISPLAY_BYTES)) return false
  const input = value.input
  return !Object.hasOwn(value, 'input') || isLocalWorkbenchDataRecord(input, ['mime', 'bytes', 'sha256', 'converted'])
    && ['image/png', 'image/jpeg', 'image/tiff', 'image/webp'].includes(String(input.mime)) && typeof input.bytes === 'number'
    && Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes <= 4 * 1024 * 1024
    && typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(input.sha256) && typeof input.converted === 'boolean'
}
export function isLocalWorkbenchPlanCapture(value: unknown): value is LocalWorkbenchPlanCapture {
  if (!isLocalWorkbenchDataRecord(value, ['datasetId', 'datasetRevision', 'albums'], ['artwork', 'cueSheets', 'cueOutputs', 'audio', 'target', 'format'])
    || !isLocalWorkbenchIdentity(value.datasetId) || !isLocalWorkbenchIdentity(value.datasetRevision)
    || !isLocalWorkbenchDenseArray(value.albums, 100) || !value.albums.length || !value.albums.every(isLocalWorkbenchAlbumCapture)
    || new Set(value.albums.map(album => album.albumId)).size !== value.albums.length) return false
  const albumIds = value.albums.map(album => album.albumId)
  if (Object.hasOwn(value, 'artwork') && (!isLocalWorkbenchDenseArray(value.artwork, 100) || !value.artwork.length
    || !value.artwork.every(isLocalWorkbenchArtworkCapture) || !same(value.artwork.map(item => item.albumId), albumIds)
    || new Set(value.artwork.map(item => item.candidateId)).size !== value.artwork.length)) return false
  if (Object.hasOwn(value, 'cueSheets') && (!isLocalWorkbenchDenseArray(value.cueSheets, 100) || !value.cueSheets.every(cue => isLocalWorkbenchDataRecord(cue, ['cueId', 'revision', 'albumId'])
    && [cue.cueId, cue.revision, cue.albumId].every(isLocalWorkbenchIdentity) && albumIds.includes(cue.albumId as string))
    || new Set(value.cueSheets.map(cue => (cue as { cueId: string }).cueId)).size !== value.cueSheets.length)) return false
  if (Object.hasOwn(value, 'audio') && (!isLocalWorkbenchDenseArray(value.audio, 3200) || !value.audio.every(isLocalCueAudioProbe)
    || new Set(value.audio.map(probe => JSON.stringify([probe.assetReference.libraryRootId, probe.assetReference.assetId]))).size !== value.audio.length)) return false
  if (Object.hasOwn(value, 'target') && (!isLocalWorkbenchDataRecord(value.target, ['choiceId', 'label', 'independent', 'revision'])
    || !isLocalWorkbenchIdentity(value.target.choiceId) || !isLocalWorkbenchIdentity(value.target.revision) || !isLocalWorkbenchText(value.target.label) || value.target.independent !== true)) return false
  if (Object.hasOwn(value, 'format') && !isLocalCueFormatQualification(value.format)) return false
  if (Object.hasOwn(value, 'cueOutputs') && (!isLocalWorkbenchDenseArray(value.cueOutputs, 9900) || !value.cueOutputs.every(output => isLocalWorkbenchDataRecord(output,
    ['itemId', 'albumId', 'sourceAssetId', 'libraryRootId', 'sourceRootId', 'sourceReadRevision']) && Object.values(output).every(isLocalWorkbenchIdentity)
    && albumIds.includes(output.albumId as string)) || new Set(value.cueOutputs.map(output => (output as { itemId: string }).itemId)).size !== value.cueOutputs.length)) return false
  return Buffer.byteLength(canonical(value), 'utf8') <= 32 * 1024 * 1024
}
export function assertLocalWorkbenchCapturedPlan(plan: LocalWorkbenchPlan, capture: LocalWorkbenchPlanCapture): void {
  if (!isLocalWorkbenchPlan(plan) || !isLocalWorkbenchPlanCapture(capture) || plan.datasetId !== capture.datasetId
    || !same(plan.albumIds, capture.albums.map(album => album.albumId))) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '冻结计划与完整捕获身份不一致。')
  if (plan.kind !== 'cue') {
    if (['cueSheets', 'cueOutputs', 'audio', 'target', 'format'].some(key => Object.hasOwn(capture, key))) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', 'MB信息计划不能夹带独立输出或源写能力。')
    if (plan.kind === 'artwork' && capture.albums.some(album => plan.relationship === 'existing' ? album.editionId === null : album.editionId !== null))
      throw new LocalWorkbenchPlanError('CHANGED', '封面关系变化与本次捕获的真实发行身份不一致。')
    if (plan.kind === 'artwork' && !capture.artwork?.length) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '封面计划没有冻结明确选中的真实已解码副本。')
    if (plan.kind === 'ai' && capture.artwork !== undefined) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '名称计划不能夹带封面应用副本。')
    if (plan.kind === 'ai') for (const item of plan.items) {
      const album = capture.albums.find(value => value.albumId === item.albumId)!
      if (item.changes.some(change => change.field === 'artist' ? change.before !== album.artistName : change.before !== album.albumName)
        || plan.state === 'ready' && item.changes.some(change => change.field === 'artist' ? (album.manualLocks.artistName || album.nameSources?.artistName === 'unknown') && change.after !== album.artistName
          : (album.manualLocks.albumName || album.nameSources?.albumName === 'unknown') && change.after !== album.albumName)) throw new LocalWorkbenchPlanError('CHANGED', '名称计划的原字段、人工锁或来源不匹配捕获。')
    }
    return
  }
  if (capture.artwork !== undefined) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '独立分轨不能夹带封面应用副本。')
  const { target, format, audio, cueSheets, cueOutputs } = capture
  if (!target || !format?.available || !audio?.length || !cueSheets?.length || !cueOutputs?.length
    || plan.target.choiceId !== target.choiceId || plan.target.label !== target.label || !same(cueSheets.map(cue => cue.albumId), plan.albumIds)
    || !same(cueOutputs.map(output => output.itemId), plan.tracks.map(track => track.itemId)))
    throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '独立分轨缺少冻结目标、格式、CUE或逐轨源绑定。')
  const ranges = new Map<string, Array<{ start: number; end: number }>>()
  const used = new Set<string>()
  for (const track of plan.tracks) {
    const binding = cueOutputs.find(output => output.itemId === track.itemId)!
    const probe = audio.find(item => item.assetReference.assetId === binding.sourceAssetId && item.assetReference.libraryRootId === binding.libraryRootId
      && item.assetReference.sourceRootId === binding.sourceRootId && item.readRevision === binding.sourceReadRevision)
    const album = capture.albums.find(item => item.albumId === track.albumId)
    if (!probe || !album || binding.albumId !== track.albumId || binding.libraryRootId !== album.rootId || track.sampleRate !== probe.sampleRate
      || track.outputFormat !== format.formatId || track.startFrame + track.frameCount > probe.totalPcmFrames!
      || !album.members.some(member => member.assetId === binding.sourceAssetId && member.rootRevision === probe.assetReference.rootRevision
        && member.fileRevision === probe.assetReference.fileRevision && member.locationRevision === probe.assetReference.locationRevision))
      throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '逐轨范围不匹配实际读帧/来源修订/已资格格式，尚未生成输出。')
    const key = JSON.stringify([binding.libraryRootId, binding.sourceAssetId]), group = ranges.get(key) ?? []
    group.push({ start: track.startFrame, end: track.startFrame + track.frameCount }); ranges.set(key, group); used.add(key)
  }
  if (used.size !== audio.length) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '分轨捕获包含计划外的音频源。')
  for (const group of ranges.values()) {
    group.sort((a, b) => a.start - b.start)
    if (group.some((range, index) => index > 0 && range.start < group[index - 1]!.end)) throw new LocalWorkbenchPlanError('CUE_INVALID', '独立分轨存在重叠范围。')
  }
}
function planDigest(plan: LocalWorkbenchPlan): string { const { planHash: _hash, ...body } = plan; return digest(body) }
function validateSnapshot(value: unknown, datasetId: string): value is LocalWorkbenchRegistrySnapshot {
  if (!isLocalWorkbenchDataRecord(value, ['schemaVersion', 'datasetId', 'revision', 'entries']) || value.schemaVersion !== 1 || value.datasetId !== datasetId
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isLocalWorkbenchDenseArray(value.entries, 512)) return false
  const planIds = new Set<string>(), commandIds = new Set<string>()
  try {
    for (const raw of value.entries) {
      if (!isLocalWorkbenchDataRecord(raw, ['plan', 'capture', 'original', 'receipt', 'cancellation']) || !isLocalWorkbenchPlan(raw.plan) || !isLocalWorkbenchPlanCapture(raw.capture)) return false
      const plan = raw.plan
      assertLocalWorkbenchCapturedPlan(plan, raw.capture)
      if (plan.datasetId !== datasetId || planIds.has(plan.planId) || plan.contextFingerprint !== digest(raw.capture) || plan.planHash !== planDigest(plan)) return false
      planIds.add(plan.planId)
      if (raw.original !== null) {
        if (!isLocalWorkbenchApplyRequest(raw.original) || !requestMatchesPlan(raw.original, plan) || commandIds.has(raw.original.commandId)) return false
        commandIds.add(raw.original.commandId)
      }
      if (raw.receipt !== null && (raw.original === null || !isLocalWorkbenchReceipt(raw.receipt, raw.original as LocalWorkbenchApplyRequest, plan))) return false
      if (raw.cancellation !== null) {
        if (!isLocalWorkbenchCommandPayload('localWorkbench.plan.cancel', raw.cancellation) || raw.original === null
          || !requestEqual(raw.cancellation.original, raw.original as LocalWorkbenchApplyRequest) || commandIds.has(raw.cancellation.cancelCommandId)) return false
        commandIds.add(raw.cancellation.cancelCommandId)
      }
    }
    return Buffer.byteLength(canonical(value), 'utf8') <= 32 * 1024 * 1024
  } catch { return false }
}
/** 暴露同一完整恢复validator供原Owner durable CAS桥接使用，不能另建简化规则。 */
export function isLocalWorkbenchRegistrySnapshot(value: unknown, datasetId: string): value is LocalWorkbenchRegistrySnapshot {
  return validateSnapshot(value, datasetId)
}
const resources = (capture: LocalWorkbenchPlanCapture): Set<string> => new Set(capture.albums.flatMap(album => [
  JSON.stringify(['album', album.rootId, album.albumId]), ...album.members.map(member => member.assetId === null
    ? JSON.stringify(['scan-file', album.rootId, album.directoryId, member.fileName]) : JSON.stringify(['source', album.rootId, member.assetId])),
]))
export interface LocalWorkbenchRegistryOptions {
  datasetId: string
  persistence: LocalWorkbenchRegistryPersistence
  writer: LocalWorkbenchProtectedWriter
  now?: () => number
  makePlanId?: () => string
  ttlMs?: number
}

/** 不提供生产内存fallback。恢复只读取持久原命令，绝不自动调用apply补发。 */
export async function createLocalWorkbenchPlanRegistry(options: LocalWorkbenchRegistryOptions) {
  if (!isLocalWorkbenchIdentity(options.datasetId) || !options.persistence?.load || !options.persistence.save
    || !options.writer?.revalidate || !options.writer.apply || !options.writer.readOriginalReceipt)
    throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '工作台需要唯一Owner持久端口与真实受保护执行端口。')
  const now = options.now ?? Date.now, makePlanId = options.makePlanId ?? randomUUID, ttlMs = options.ttlMs ?? 10 * 60 * 1000
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 60 * 1000) throw new LocalWorkbenchPlanError('INVALID_PLAN', '冻结计划有效期配置无效。')
  let snapshot: LocalWorkbenchRegistrySnapshot
  try {
    const loaded = await options.persistence.load(options.datasetId)
    if (loaded !== null && !validateSnapshot(loaded, options.datasetId)) throw new LocalWorkbenchPlanError('INVALID_PLAN', '工作台持久计划/原回执身份无效，未恢复执行。')
    snapshot = clone(loaded ?? { schemaVersion: 1, datasetId: options.datasetId, revision: 0, entries: [] })
  } catch (error) {
    if (error instanceof LocalWorkbenchPlanError) throw error
    throw new LocalWorkbenchPlanError('PERSISTENCE_FAILED', '工作台原命令读取失败，未开始执行。')
  }
  let poisoned = false, queue: Promise<void> = Promise.resolve()
  const inFlight = new Map<string, Promise<LocalWorkbenchReceipt>>()
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run); queue = next.then(() => undefined, () => undefined); return next
  }
  async function commit(entries: readonly LocalWorkbenchRegistryEntry[]): Promise<void> {
    if (poisoned) throw new LocalWorkbenchPlanError('PERSISTENCE_FAILED', '原命令持久状态尚未确认，请重新读取；不会执行或重签。')
    const next: LocalWorkbenchRegistrySnapshot = { schemaVersion: 1, datasetId: options.datasetId, revision: snapshot.revision + 1, entries: clone(entries) }
    if (!validateSnapshot(next, options.datasetId)) throw new LocalWorkbenchPlanError('INVALID_PLAN', '工作台持久计划超出预算或身份无效，未派发执行。')
    try { await options.persistence.save(freezeLocalWorkbenchValue(clone(next)), snapshot.revision) }
    catch { poisoned = true; throw new LocalWorkbenchPlanError('PERSISTENCE_FAILED', '原命令持久结果尚未确认，未继续派发执行。') }
    snapshot = next
  }
  function entryFor(request: LocalWorkbenchApplyRequest): LocalWorkbenchRegistryEntry {
    if (!isLocalWorkbenchApplyRequest(request)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '原命令请求不符合闭集合同。')
    const entry = snapshot.entries.find(item => item.plan.planId === request.planId)
    if (!entry || !requestMatchesPlan(request, entry.plan)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '原命令与冻结计划的修订/哈希/上下文不一致。')
    return entry
  }
  function currentReceipt(request: LocalWorkbenchApplyRequest): LocalWorkbenchReceipt {
    const entry = entryFor(request)
    return clone(entry.receipt ?? unknownReceipt(request, entry.plan))
  }
  async function issuePlan(draft: LocalWorkbenchPlanDraft, capture: LocalWorkbenchPlanCapture): Promise<LocalWorkbenchPlan> {
    return serial(async () => {
      if (!isLocalWorkbenchPlanCapture(capture) || capture.datasetId !== options.datasetId) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '工作台捕获不属于当前工作库。')
      const variant = draft?.kind === 'artwork' ? ['relationship'] : draft?.kind === 'ai' ? ['candidateIds'] : draft?.kind === 'cue' ? ['sourceDisposition', 'target', 'tracks'] : []
      if (!isLocalWorkbenchDataRecord(draft, ['kind', 'scope', 'albumIds', 'state', 'blockers', 'items', ...variant]))
        throw new LocalWorkbenchPlanError('INVALID_PLAN', '纯计划含未知或隐藏字段，未采纳额外能力。')
      const planId = makePlanId()
      if (!isLocalWorkbenchIdentity(planId) || snapshot.entries.some(entry => entry.plan.planId === planId)) throw new LocalWorkbenchPlanError('INVALID_PLAN', '冻结计划身份无法建立。')
      const value = { ...draft, datasetId: capture.datasetId, planId, revision: '1', contextFingerprint: digest(capture),
        expiresAt: new Date(now() + ttlMs).toISOString(), planHash: '0'.repeat(64) } as LocalWorkbenchPlan
      assertLocalWorkbenchCapturedPlan(value, capture)
      value.planHash = planDigest(value)
      await commit([...snapshot.entries, { plan: value, capture: clone(capture), original: null, receipt: null, cancellation: null }])
      return freezeLocalWorkbenchValue(clone(value))
    })
  }
  async function settle(request: LocalWorkbenchApplyRequest, receipt: LocalWorkbenchReceipt): Promise<LocalWorkbenchReceipt> {
    return serial(async () => {
      const entry = entryFor(request)
      if (!entry.original || !requestEqual(request, entry.original) || !isLocalWorkbenchReceipt(receipt, request, entry.plan))
        throw new LocalWorkbenchPlanError('INVALID_REQUEST', '返回结果不匹配同一原命令。')
      // 终态后拒绝较早异步调用的迟到回报；未知单项保留已知项，不向下倒退。
      if (!unresolved(entry)) return clone(entry.receipt!)
      const merged: LocalWorkbenchReceipt = { ...clone(receipt), items: receipt.items.map(item => {
        const known = entry.receipt?.items.find(previous => previous.itemId === item.itemId && previous.state !== 'unknown')
        return item.state === 'unknown' && known ? clone(known) : clone(item)
      }) }
      // 原writer仍逐次核原命令；完整合并回执无变化才免写，不能绕过未确认的持久失败。
      if (entry.receipt !== null && canonical(merged) === canonical(entry.receipt)) {
        if (poisoned) throw new LocalWorkbenchPlanError('PERSISTENCE_FAILED', '原命令持久状态尚未确认，请重新读取；不会执行或重签。')
        return clone(merged)
      }
      await commit(snapshot.entries.map(item => item.plan.planId === entry.plan.planId ? { ...item, receipt: merged } : item))
      return clone(merged)
    })
  }
  async function readOriginalReceipt(request: LocalWorkbenchApplyRequest): Promise<LocalWorkbenchReceipt | null> {
    const entry = entryFor(request)
    if (!entry.original) return null
    if (!requestEqual(request, entry.original)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '只允许读取已保存的同一原命令。')
    if (!unresolved(entry)) return clone(entry.receipt!)
    let value: LocalWorkbenchReceipt | null
    try { value = await options.writer.readOriginalReceipt(freezeLocalWorkbenchValue(clone(entry.original))) }
    catch { return currentReceipt(request) }
    if (value === null) return currentReceipt(request)
    if (!isLocalWorkbenchReceipt(value, request, entry.plan)) return currentReceipt(request)
    return settle(request, value)
  }
  async function apply(request: LocalWorkbenchApplyRequest): Promise<LocalWorkbenchReceipt> {
    const accepted = await serial(async () => {
      const entry = entryFor(request)
      if (entry.original !== null) {
        if (!requestEqual(request, entry.original)) throw new LocalWorkbenchPlanError('ALREADY_DISPATCHED', '此计划已保存原命令，不能重签或重复派发。')
        return { entry: clone(entry), start: false }
      }
      if (snapshot.entries.some(item => item.original?.commandId === request.commandId || item.cancellation?.cancelCommandId === request.commandId))
        throw new LocalWorkbenchPlanError('INVALID_REQUEST', '命令身份已经用于其他原操作。')
      const claimed = resources(entry.capture)
      if (snapshot.entries.some(item => unresolved(item) && [...resources(item.capture)].some(resource => claimed.has(resource))))
        throw new LocalWorkbenchPlanError('ORIGINAL_RECEIPT_REQUIRED', '此专辑或物理源仍有未确认原命令，请先读取原回执；不能用新计划重签。')
      const known = entry.plan.state !== 'ready' ? notWrittenReceipt(request, entry.plan, '计划存在阻断项，未派发写入。')
        : Date.parse(entry.plan.expiresAt) <= now() ? notWrittenReceipt(request, entry.plan, '冻结计划已过期，未派发写入。') : null
      const reserved: LocalWorkbenchRegistryEntry = { ...entry, original: clone(request), receipt: known }
      await commit(snapshot.entries.map(item => item.plan.planId === entry.plan.planId ? reserved : item))
      return { entry: clone(reserved), start: known === null }
    })
    if (!accepted.start) return inFlight.get(request.commandId) ?? readOriginalReceipt(request).then(value => value ?? unknownReceipt(request, accepted.entry.plan))
    const run = (async (): Promise<LocalWorkbenchReceipt> => {
      let validation: { valid: true } | { valid: false; reason: string }
      try { validation = await options.writer.revalidate(freezeLocalWorkbenchValue(clone(accepted.entry.capture)), freezeLocalWorkbenchValue(clone(accepted.entry.plan))) }
      catch { return settle(request, notWrittenReceipt(request, accepted.entry.plan, '来源/目标捕获未能重新确认，未派发写入。')) }
      if (!validation || validation.valid !== true) return settle(request, notWrittenReceipt(request, accepted.entry.plan,
        validation?.valid === false && isLocalWorkbenchText(validation.reason) ? validation.reason : '来源/目标修订已变化，未派发写入。'))
      let receipt: LocalWorkbenchReceipt
      try {
        // apply自身须再次核原捕获并取得实际claims/FD/目标许可，不能把前一次revalidate当写入授权。
        receipt = await options.writer.apply(freezeLocalWorkbenchValue(clone(request)), freezeLocalWorkbenchValue(clone(accepted.entry.plan)), freezeLocalWorkbenchValue(clone(accepted.entry.capture)))
      } catch { return currentReceipt(request) }
      if (!isLocalWorkbenchReceipt(receipt, request, accepted.entry.plan)) return currentReceipt(request)
      return settle(request, receipt)
    })()
    inFlight.set(request.commandId, run)
    try { return await run } finally { inFlight.delete(request.commandId) }
  }
  async function cancel(request: LocalWorkbenchCancelRequest): Promise<LocalWorkbenchReceipt> {
    if (!isLocalWorkbenchCommandPayload('localWorkbench.plan.cancel', request)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '取消请求不符合原命令合同。')
    if (!options.writer.cancel) throw new LocalWorkbenchPlanError('CANCEL_UNAVAILABLE', '原任务取消执行端口未接入；原命令仍可查询。')
    const accepted = await serial(async () => {
      const entry = entryFor(request.original)
      if (!entry.original || !requestEqual(request.original, entry.original)) throw new LocalWorkbenchPlanError('INVALID_REQUEST', '取消只允许引用已保存原命令。')
      if (entry.cancellation !== null) {
        if (canonical(request) !== canonical(entry.cancellation)) throw new LocalWorkbenchPlanError('ALREADY_DISPATCHED', '取消命令已保存，不能重新签发。')
        return { start: false, entry: clone(entry) }
      }
      if (!unresolved(entry)) return { start: false, entry: clone(entry) }
      if (snapshot.entries.some(item => item.original?.commandId === request.cancelCommandId || item.cancellation?.cancelCommandId === request.cancelCommandId))
        throw new LocalWorkbenchPlanError('INVALID_REQUEST', '取消命令身份已经用于其他原操作。')
      await commit(snapshot.entries.map(item => item.plan.planId === entry.plan.planId ? { ...item, cancellation: clone(request) } : item))
      return { start: true, entry: clone(entry) }
    })
    if (!accepted.start) return await readOriginalReceipt(request.original) ?? unknownReceipt(request.original, accepted.entry.plan)
    let receipt: LocalWorkbenchReceipt
    try { receipt = await options.writer.cancel(freezeLocalWorkbenchValue(clone(request))) }
    catch { return currentReceipt(request.original) }
    return isLocalWorkbenchReceipt(receipt, request.original, accepted.entry.plan) ? settle(request.original, receipt)
      : currentReceipt(request.original)
  }
  function operations(): readonly LocalWorkbenchOperation[] {
    return freezeLocalWorkbenchValue(snapshot.entries.filter((entry): entry is LocalWorkbenchRegistryEntry & { original: LocalWorkbenchApplyRequest } => entry.original !== null)
      .map(entry => ({ request: clone(entry.original), plan: clone(entry.plan), receipt: clone(entry.receipt), state: state(entry) })))
  }
  function readArtworkCapture(request: { datasetId: string; planId: string; candidateId: string }): Readonly<LocalWorkbenchFrozenArtwork> | null {
    if (!isLocalWorkbenchDataRecord(request, ['datasetId', 'planId', 'candidateId']) || !Object.values(request).every(isLocalWorkbenchIdentity)
      || request.datasetId !== options.datasetId) return null
    const entry = snapshot.entries.find(value => value.plan.planId === request.planId && value.plan.kind === 'artwork')
    const artwork = entry?.capture.artwork?.find(value => value.candidateId === request.candidateId)
    const captured = artwork && entry?.capture.albums.find(value => value.albumId === artwork.albumId)
    if (!entry || !artwork || !captured) return null
    // 过期仍可只读恢复原图/回执；调用者最终应用必须另核原计划和真实权限。
    return freezeLocalWorkbenchValue(clone({ datasetId: entry.capture.datasetId, datasetRevision: entry.capture.datasetRevision,
      planId: entry.plan.planId, planHash: entry.plan.planHash, contextFingerprint: entry.plan.contextFingerprint, capture: captured, artwork }))
  }
  return {
    issuePlan, apply, readOriginalReceipt, cancel, operations, readArtworkCapture,
    getPlan: (planId: string): LocalWorkbenchPlan | null => { const value = snapshot.entries.find(entry => entry.plan.planId === planId)?.plan; return value ? freezeLocalWorkbenchValue(clone(value)) : null },
    inspect: (): Readonly<LocalWorkbenchRegistrySnapshot> => freezeLocalWorkbenchValue(clone(snapshot)),
  }
}
export type LocalWorkbenchPlanRegistry = Awaited<ReturnType<typeof createLocalWorkbenchPlanRegistry>>
