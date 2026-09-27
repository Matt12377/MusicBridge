import {
  MAX_REFERENCE_SOURCE_PACK_BYTES as MAX_SOURCE_BYTES, MAX_REFERENCE_REVISION_BYTES, MAX_CATALOG_REFERENCES, parseReferenceSourcePack, normalizeReferenceItems,
  MAX_REFERENCE_SOURCE_ZIP_BYTES, isReferenceSourceZipPreview,
  isPreviewCatalogRevisionRequest, isSetCatalogMatchRequest,
  type CanonicalReference, type CatalogMapping, type CatalogMatch, type CatalogRevisionDetail,
  type CatalogRevisionPreview, type CatalogSnapshot, type CatalogHistory, type ReferenceSourcePage,
  type ReferenceSourceVersion, type SourcePack, type ReferenceCatalogPublicApi, type CollectionPublicApi,
  type ReferenceSourceZipPreview, type ReferenceSourceZipReceiptPage,
  type CollectionModel, type Page,
} from '@music-bridge/contracts'

export type CatalogStep = 'source' | 'revision' | 'review' | 'history'
interface CatalogState {
  rawPack: string; sourcePreview?: { pack: SourcePack; packHash: string; items: CanonicalReference[] }
  zipBase64: string; zipPreview?: ReferenceSourceZipPreview; zipReceipts?: ReferenceSourceZipReceiptPage
  sources?: ReferenceSourcePage; source?: ReferenceSourceVersion; items: readonly CanonicalReference[]
  mappings: readonly CatalogMapping[]; revisionPreview?: CatalogRevisionPreview; history?: CatalogHistory
  current?: CatalogRevisionDetail; historical?: CatalogRevisionDetail; models?: Page<CollectionModel>
  comparison?: { before: CatalogSnapshot; after: CatalogSnapshot; added: string[]; removed: string[] }
  busy: boolean; pendingLabel?: string; error: string; notice: string; step: CatalogStep
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/^(?:ZIP |ZIP必|ZIP 编|ZIP 内|资料包暂存|资料包不能)/u.test(message) && message.length <= 200 && !message.includes('\n')) return message
  if (/CONFLICT|STALE|BASELINE/u.test(message)) return '目录或库存基线已变化。原操作未被改写；请核对未确认操作，再重新读取并预览。'
  if (/OUTBOX|TIMEOUT|UNAVAILABLE|DISCONNECTED/u.test(message)) return '暂未取得明确回执。请恢复连接后明确重试原操作，或在全局未确认操作中核对。'
  return '操作未完成。请检查资料与当前工作库，稍后重试；原输入仍保留。'
}

/** 只保存局部意图；跨重启追踪由 Main outbox 负责，打开面板不会重发写操作。 */
export function createReferenceCatalogController(options: {
  api: ReferenceCatalogPublicApi & Pick<CollectionPublicApi, 'listCollection'>
  onChange?: () => void
}) {
  const { api } = options
  const state: CatalogState = { rawPack: '', zipBase64: '', items: [], mappings: [], busy: false, error: '', notice: '', step: 'source' }
  let alive = true
  let pending: { label: string; execute: () => Promise<unknown>; accept: (result: unknown) => void } | undefined
  let baselineLoaded = false
  const changed = () => { if (alive) options.onChange?.() }
  const blocked = () => !alive || state.busy || !!pending
  const fail = (text: string) => { state.error = text; changed() }

  async function read<T>(operation: () => Promise<T>, accept: (result: T) => void): Promise<void> {
    if (blocked()) return
    state.busy = true; state.error = ''; changed()
    try { const result = await operation(); if (alive) accept(result) }
    catch (error) { if (alive) state.error = publicError(error) }
    finally { if (alive) { state.busy = false; changed() } }
  }
  async function retry(): Promise<void> {
    if (!alive || state.busy || !pending) return
    const original = pending
    state.busy = true; state.error = ''; changed()
    try {
      const result = await original.execute()
      if (alive) { original.accept(result); pending = undefined; state.pendingLabel = undefined }
    } catch (error) { if (alive) state.error = publicError(error) }
    finally { if (alive) { state.busy = false; changed() } }
  }
  async function write<T>(label: string, execute: () => Promise<T>, accept: (result: T) => void): Promise<void> {
    if (blocked()) return
    pending = { label, execute, accept: result => accept(result as T) }; state.pendingLabel = label
    await retry()
  }
  const draftRequest = () => ({ sourceId: state.source?.id, expectedCurrentRevisionId: state.history?.currentRevisionId ?? null, items: state.items, mappings: state.mappings })

  async function selectSource(id: string): Promise<void> {
    await read(async () => {
      const detail = await api.getReferenceSource({ id })
      const pack = parseReferenceSourcePack(detail.rawPack)
      const items = pack && normalizeReferenceItems(pack.items)
      if (!items) throw new Error('INVALID_SOURCE')
      const history = await api.getCatalogHistory({ bookId: detail.source.bookId, offset: 0, limit: 25 })
      const current = history.currentRevisionId ? await api.getCatalogRevision({ id: history.currentRevisionId }) : undefined
      const zipReceipts = await api.listReferenceSourceZipReceipts({ sourceId: id, offset: 0, limit: 25 })
      return { source: detail.source, items: current?.revision.items ?? items, history, current, zipReceipts }
    }, result => {
      Object.assign(state, result, { mappings: [], revisionPreview: undefined, historical: undefined, comparison: undefined, step: 'revision', notice: '' })
      baselineLoaded = true
    })
  }
  return {
    state,
    async start() {
      await read(() => Promise.all([api.listReferenceSources({ offset: 0, limit: 25 }), api.listCollection({ offset: 0, limit: 100 })]), ([sources, models]) => { state.sources = sources; state.models = models })
    },
    async loadSources(offset = 0) { await read(() => api.listReferenceSources({ offset, limit: 25 }), result => { state.sources = result }) },
    async loadModels(query = '', offset = 0) { await read(() => api.listCollection({ offset, limit: 100 }, { query }), result => { state.models = result }) },
    setStep(step: CatalogStep) { if (!blocked()) { state.step = step; changed() } },
    setRawPack(rawPack: string) { if (!blocked()) { state.rawPack = rawPack; state.sourcePreview = undefined; state.zipBase64 = ''; state.zipPreview = undefined; state.error = ''; changed() } },
    setZipBase64(zipBase64: string) { if (!blocked()) { state.zipBase64 = zipBase64; state.zipPreview = undefined; state.sourcePreview = undefined; state.error = ''; changed() } },
    reportInputError(message: string) { if (!blocked()) fail(message) },
    async previewZip() {
      if (blocked() || !state.zipBase64) return
      await read(() => api.previewReferenceSourceZip({ zipBase64: state.zipBase64 }), result => {
        if (!isReferenceSourceZipPreview(result)) throw new Error('INVALID_ZIP_PREVIEW')
        state.zipPreview = result
        state.notice = '容器只读预览，尚未登记。确认时会重验完全相同的 ZIP 与 JSON 字节。'
      })
    },
    async registerZip(confirmed: boolean) {
      if (blocked() || !confirmed || !state.zipPreview) return
      const preview = state.zipPreview, zipBase64 = state.zipBase64
      const request = { commandId: crypto.randomUUID(), zipBase64, expectedZipSha256: preview.zipSha256,
        expectedRawPackHash: preview.rawPackHash, userConfirmed: true as const }
      let acceptedSourceId: string | undefined
      await write('登记 ZIP 原资料', () => api.registerReferenceSourceZip(request), result => {
        acceptedSourceId = result.source.id
        state.source = result.source; state.zipBase64 = ''; state.zipPreview = undefined; state.sourcePreview = undefined
        state.items = []; state.mappings = []; state.revisionPreview = undefined; state.current = undefined; state.history = undefined
        baselineLoaded = false; state.step = 'source'
        state.notice = '原 JSON 已登记，ZIP 的 SHA、大小和入口名已留不可变回执；原 ZIP 不长期归档。请从来源列表选择此版本，再整理目录。'
      })
      if (acceptedSourceId) await read(() => Promise.all([
        api.listReferenceSources({ offset: 0, limit: 25 }),
        api.listReferenceSourceZipReceipts({ sourceId: acceptedSourceId!, offset: 0, limit: 25 }),
      ]), ([sources, receipts]) => { state.sources = sources; state.zipReceipts = receipts })
    },
    async loadZipReceipts(offset = 0) {
      const sourceId = state.source?.id
      if (sourceId) await read(() => api.listReferenceSourceZipReceipts({ sourceId, offset, limit: 25 }), result => { state.zipReceipts = result })
    },
    async previewSource() {
      if (blocked()) return
      if (new TextEncoder().encode(state.rawPack).byteLength > MAX_SOURCE_BYTES) {
        state.sourcePreview = undefined; fail('资料包不能超过 1 MiB。'); return
      }
      try {
        const input: unknown = JSON.parse(state.rawPack.replace(/^\uFEFF/u, ''))
        if (input && typeof input === 'object' && 'items' in input && Array.isArray(input.items) && input.items.length > MAX_CATALOG_REFERENCES) {
          state.sourcePreview = undefined; fail(`资料包包含 ${input.items.length} 行，单个目录最多支持 ${MAX_CATALOG_REFERENCES} 行。未截断或写入资料。`); return
        }
      } catch { /* 格式错误交由严格资料解析器统一处理。 */ }
      const pack = parseReferenceSourcePack(state.rawPack)
      const items = pack && normalizeReferenceItems(pack.items)
      if (!pack || !items) { state.sourcePreview = undefined; fail('资料包不符合 schemaVersion 1，或重复条目的身份/元数据存在冲突。请整理 JSON 后重新预览。'); return }
      const raw = state.rawPack
      await read(async () => ({ pack, items, packHash: await hashReferenceSourceText(raw) }), result => { state.sourcePreview = result; state.notice = '预览未保存。原 UTF-8 文本与 SHA-256 将一起登记。' })
    },
    async registerSource(confirmed: boolean) {
      if (blocked() || !confirmed || !state.sourcePreview) return
      const preview = state.sourcePreview
      const request = { commandId: crypto.randomUUID(), rawPack: state.rawPack, packHash: preview.packHash, userConfirmed: true as const }
      await write('登记原资料版本', () => api.registerReferenceSource(request), result => {
        state.source = result; state.sourcePreview = undefined; state.zipBase64 = ''; state.zipPreview = undefined; state.zipReceipts = undefined; state.items = structuredClone(preview.items); state.mappings = []; state.revisionPreview = undefined
        state.current = undefined; state.history = undefined; baselineLoaded = false; state.step = 'revision'
        state.notice = '原资料已登记。请读取此来源的当前基线，再预览并发布整理后的目录。'
      })
    },
    selectSource,
    setDraft(items: readonly CanonicalReference[], mappings: readonly CatalogMapping[]) {
      if (blocked()) return
      state.items = structuredClone(items); state.mappings = structuredClone(mappings); state.revisionPreview = undefined; state.error = ''; changed()
    },
    async previewRevision() {
      if (blocked()) return
      if (!baselineLoaded) { fail('请先读取此来源的当前基线，再预览目录。'); return }
      const request = draftRequest()
      if (!isPreviewCatalogRevisionRequest(request)) { fail('请检查条目必填字段、唯一身份及映射。只支持一对一、合并或拆分，禁止多对多与重复引用。'); return }
      await read(() => api.previewCatalogRevision(structuredClone(request)), result => { state.revisionPreview = result; state.notice = '预览尚未发布；请核对新增、移除、合并与拆分影响。' })
    },
    async publishRevision(confirmed: boolean) {
      if (blocked() || !confirmed || !state.revisionPreview) return
      const draft = draftRequest()
      if (!isPreviewCatalogRevisionRequest(draft)) return
      const request = structuredClone({ ...draft, commandId: crypto.randomUUID(), baselineFingerprint: state.revisionPreview.baselineFingerprint, userConfirmed: true as const })
      await write('发布目录修订', () => api.publishCatalogRevision(request), result => {
        state.current = result; state.revisionPreview = undefined; state.step = 'review'; baselineLoaded = false
        state.notice = '目录修订已发布。关联审核只改变参考目录，不会创建或增加磁带库存。'
      })
    },
    async saveMatch(match: CatalogMatch, confirmed: boolean) {
      if (blocked() || !confirmed || !state.current) return
      const request = structuredClone({ commandId: crypto.randomUUID(), revisionId: state.current.revision.id, expectedMatchVersion: state.current.matchVersion, match, userConfirmed: true as const })
      if (!isSetCatalogMatchRequest(request) || !state.current.revision.items.some(item => item.referenceId === match.referenceId)) { fail('请选择有效目录条目、已有收藏型号和审核状态。'); return }
      await write('保存关联审核', () => api.setCatalogMatch(request), result => { state.current = result; state.notice = '关联审核已保存；库存账本未改变。' })
    },
    async refreshCurrent() {
      if (state.current) await read(() => api.getCatalogRevision({ id: state.current!.revision.id }), result => { state.current = result })
    },
    async loadHistory(offset = 0) {
      const bookId = state.source?.bookId
      if (bookId) await read(() => api.getCatalogHistory({ bookId, offset, limit: 25 }), result => { state.history = result })
    },
    async loadHistoricalRevision(id: string) { await read(() => api.getCatalogRevision({ id }), result => { state.historical = result }) },
    async compareSnapshots(beforeId: string, afterId: string) {
      await read(() => Promise.all([api.getCatalogSnapshot({ id: beforeId }), api.getCatalogSnapshot({ id: afterId })]), ([before, after]) => {
        if (before.bookId !== after.bookId) { fail('只能比较同一书籍的两份历史快照。'); return }
        const a = new Set(before.entries.map(entry => entry.referenceId)), b = new Set(after.entries.map(entry => entry.referenceId))
        state.comparison = { before, after, added: [...b].filter(id => !a.has(id)), removed: [...a].filter(id => !b.has(id)) }
      })
    },
    retry,
    releasePending(confirmed: boolean) {
      if (!alive || state.busy || !confirmed || !pending) return
      pending = undefined; state.pendingLabel = undefined; state.revisionPreview = undefined; baselineLoaded = false
      state.notice = '仅退出本面板的重试状态；原操作仍在全局未确认操作中。请核对结果后重新读取基线。'; changed()
    },
    dispose() { alive = false },
  }
}

function sourceBytes(rawPack: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(rawPack)
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('资料包不能超过 1 MiB。')
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== rawPack) throw new Error('资料必须是有效 UTF-8，不能替换原始字符。')
  return bytes
}

export async function readReferenceSourceFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<string> {
  return readJsonFile(file, MAX_SOURCE_BYTES, '1 MiB')
}

export async function readReferenceSourceZipFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<string> {
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('请选择 ZIP 文件。')
  if (file.size < 1 || file.size > MAX_REFERENCE_SOURCE_ZIP_BYTES) throw new Error('ZIP 不能超过 4 MiB。')
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_REFERENCE_SOURCE_ZIP_BYTES) throw new Error('ZIP 不能超过 4 MiB。')
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

export async function readReferenceRevisionFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<string> {
  return readJsonFile(file, MAX_REFERENCE_REVISION_BYTES, '4 MiB')
}

async function readJsonFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, limit: number, label: string): Promise<string> {
  if (!file.name.toLowerCase().endsWith('.json')) throw new Error('请选择结构化 JSON 文件。')
  if (file.size > limit) throw new Error(`资料包不能超过 ${label}。`)
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > limit) throw new Error(`资料包不能超过 ${label}。`)
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) }
  catch { throw new Error('文件不是有效 UTF-8；未替换或改写原始字节。') }
}

export async function hashReferenceSourceText(rawPack: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', sourceBytes(rawPack))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
