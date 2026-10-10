import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { isReferenceCatalogKey, type CatalogHistory, type CatalogRevisionPreview } from '@music-bridge/contracts'
import {
  prepareCassetteArchive, loadCassetteArchive, getCassetteArchiveRecord, getCassetteArchiveAsset,
  type LoadedCassetteArchive,
} from '../../../../packages/bridge-core/src/collection/cassette-archive.js'
import { cassetteAssetUrl, type CassetteArchivePreview, type CassetteReferenceDetail } from '../shared/cassette-catalog.js'
import type { CoreSupervisor } from './core-supervisor.js'

type JsonRecord = Record<string, unknown>
const record = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const text = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const fail = (): never => { throw new Error('磁带资料暂时不可读取，已有目录和库存保留。') }

/** 原书文本只作安全文字投影；完整原记录和档案始终保存于应用管理目录。 */
export async function projectCassetteReference(archive: LoadedCassetteArchive, referenceId: string): Promise<CassetteReferenceDetail> {
  const source = await getCassetteArchiveRecord(archive, referenceId), info = record(source.r3_information)
  const linked = archive.index.references[referenceId]
  if (!linked) return fail()
  const sections: { title: string; text: string }[] = []
  const add = (title: string, value: unknown) => { const content = text(value); if (content) sections.push({ title, text: content }) }
  add('资料摘要', info.summary_zh)
  if (Array.isArray(info.source_transcriptions)) for (const raw of info.source_transcriptions) {
    const panel = record(raw)
    const scopeLabel = panel.scope === 'shared_context' ? '原书共享背景' : panel.scope === 'history_context' ? '原书历史背景' : '原书正文'
    add(`${scopeLabel} · ${string(panel.printed_page) || string(panel.source_page_id) || '页码未标'}`,
      panel.transcription_zh ?? '此原书区域尚未提供中文转录，原始页码与区域信息已保留。')
  }
  if (info.body_coverage_category === 'source_has_no_product_body') add('资料覆盖说明', '来源未提供该型号的独立产品正文；原始区域与来源信息已保留。')
  else if (info.body_coverage_category === 'shared_context_only') add('资料覆盖说明', '此条目仅关联共享背景正文，来源未提供独立产品正文。')
  add('共享背景资料', info.shared_context_summaries_zh)
  add('历史背景与出处', info.history_context_claims)
  add('r3 资料纠正', info.availability_correction)
  add('字段值与来源依据', info.fields)
  add('型号字段依据', source.field_basis)
  add('原书文字证据', Array.isArray(source.source_records) ? source.source_records.map(raw => {
    const item = record(raw), original = record(item.raw_source_record)
    return { source_record_id: item.source_record_id, source_page_id: original.source_page_id,
      printed_page_label: original.printed_page_label, evidence: original.evidence, notes: original.notes }
  }) : undefined)
  add('来源备注', source.notes)
  add('阅读范围与限制', { reading_status: info.reading_status, body_coverage_category: info.body_coverage_category, production_year_claim_policy: info.production_year_claim_policy })
  const assetIds = [...new Set([
    ...linked.assetIds.map(id => Object.hasOwn(archive.index.assets, `${id}:original`) ? `${id}:original` : id),
    ...linked.realPhotoIds, ...linked.opaqueDisplayIds,
  ])]
  const assets = assetIds.map(id => {
    const asset = archive.index.assets[id]
    if (!asset) return fail()
    return { id, role: asset.role, origin: asset.origin, url: cassetteAssetUrl(archive.summary.sha256, id), caption: asset.caption, source: asset.source }
  })
  const unknownFields: string[] = []
  if (source.production_year_verified !== true) unknownFields.push('生产年份未经验证；原书年份标注不等于生产年份。')
  if (source.all_possible_lengths_known !== true || source.lengths_complete !== true) unknownFields.push('全部供应时长未确定。')
  if (source.era === null) unknownFields.push('年代范围未知。')
  const available = source.availability_lengths_minutes, photographed = source.photographed_lengths_minutes
  const lengthsEvidence = Array.isArray(available)
    ? `来源明确列出的供应时长：${available.join('、')} 分钟。`
    : `全部供应时长未知。${Array.isArray(photographed) && photographed.length ? `照片标签出现 ${photographed.join('、')} 分钟；仅作该照片证据。` : ''}`
  const editionBasis = source.edition_basis === 'printed_book_entry_heading_not_global_production_year'
    ? '原书条目标题的年份标注；不是已验证的整体生产年份。' : text(source.edition_basis)
  const result: CassetteReferenceDetail = {
    referenceId, bookTitle: archive.summary.title, sourceVersion: archive.summary.sourceVersion,
    bookYearLabel: source.book_year_label === null || source.book_year_label === undefined ? null : String(source.book_year_label),
    editionBasis, lengthsEvidence, missingPrimaryReason: linked.missingPrimaryReason,
    sections, assets, unknownFields,
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) return fail()
  return result
}

/** 大档案在 Main 本地选择和流式校验；目录写入仍只走既有 Core/outbox 作者。 */
export function createCassetteCatalogService(options: {
  dataDirectory: () => string | undefined
  chooseArchive: () => Promise<string | null>
  request: CoreSupervisor['request']
}) {
  let selecting = false
  const root = () => { const directory = options.dataDirectory(); if (!directory || !path.isAbsolute(directory)) return fail(); return path.join(directory, 'reference-archives') }
  const archives = new Map<string, { seal: string; archive: Promise<LoadedCassetteArchive> }>()
  async function archiveFor(sha256: string): Promise<LoadedCassetteArchive> {
    const directory = root(), identity = await lstat(path.join(directory, sha256, 'manifest.json'), { bigint: true })
    if (!identity.isFile() || identity.isSymbolicLink()) return fail()
    const seal = [identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs].join(':')
    const key = path.join(directory, sha256), prior = archives.get(key)
    if (prior?.seal === seal) return prior.archive
    if (archives.size >= 4) archives.delete(archives.keys().next().value!)
    const archive = loadCassetteArchive(directory, sha256)
    archives.set(key, { seal, archive })
    try { return await archive } catch (error) { archives.delete(key); throw error }
  }
  return {
    async pick(): Promise<CassetteArchivePreview | null> {
      if (selecting) throw new Error('磁带资料档案正在校验，请等本次预览完成。')
      selecting = true
      try {
        const selected = await options.chooseArchive()
        if (!selected) return null
        const context = await options.request('commandOutbox.context', {})
        const archive = await prepareCassetteArchive({ archivePath: selected, archiveRoot: root() })
        const history: CatalogHistory = await options.request('referenceCatalog.history', { bookId: archive.summary.bookId, offset: 0, limit: 25 })
        const preview: CatalogRevisionPreview = await options.request('referenceCatalog.previewArchive', {
          archiveSha256: archive.summary.sha256, expectedDatasetId: context.datasetId, expectedCurrentRevisionId: history.currentRevisionId,
        })
        return { summary: archive.summary, datasetId: context.datasetId, expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
          baselineFingerprint: preview.baselineFingerprint, delta: preview.delta }
      } finally { selecting = false }
    },
    async detail(value: unknown): Promise<CassetteReferenceDetail> {
      const request = record(value)
      if (Object.keys(request).some(key => !['sha256', 'referenceId'].includes(key)) || !hash(request.sha256) || !isReferenceCatalogKey(request.referenceId)) return fail()
      return projectCassetteReference(await archiveFor(request.sha256), request.referenceId)
    },
    async image(urlValue: string, method: string): Promise<Response> {
      try {
        const url = new URL(urlValue)
        if (!['GET', 'HEAD'].includes(method) || url.protocol !== 'musicbridge:' || url.hostname !== 'app' || url.search || url.hash || url.username || url.password || url.port) return new Response(null, { status: 404 })
        const match = /^\/reference-assets\/([0-9a-f]{64})\/([^/]+)$/u.exec(url.pathname)
        if (!match) return new Response(null, { status: 404 })
        const sha256 = match[1]!, assetId = decodeURIComponent(match[2]!)
        if (!isReferenceCatalogKey(assetId)) return new Response(null, { status: 404 })
        const asset = await getCassetteArchiveAsset(await archiveFor(sha256), assetId)
        const fd = await open(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await fd.stat({ bigint: true })
          if (!before.isFile() || before.size < 1n || before.size > 32n * 1024n * 1024n) return new Response(null, { status: 404 })
          const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), named = await lstat(asset.path, { bigint: true })
          if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after] || after[key as keyof typeof after] !== named[key as keyof typeof named])
            || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) return new Response(null, { status: 404 })
          return new Response(method === 'HEAD' ? null : new Uint8Array(bytes), { headers: {
            'Content-Type': asset.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          } })
        } finally { await fd.close() }
      } catch { return new Response(null, { status: 404 }) }
    },
  }
}

export function installCassetteCatalogHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  service: ReturnType<typeof createCassetteCatalogService>
}): void {
  options.handle('cassetteCatalog:pick-archive', async (event, value) => {
    options.requireTrusted(event)
    if (value !== undefined) throw new Error('磁带资料选择请求无效。')
    try { return await options.service.pick() } catch (error) {
      if (error instanceof Error && /(?:INVENTORY_CONFLICT|CONFLICT|STALE)/u.test(error.message)) throw new Error('目录基线或型号身份发生变化，请核对映射后重新预览。')
      throw new Error('完整磁带资料档案校验或预览失败；已有目录、库存和输入档案保留。')
    }
  })
  options.handle('cassetteCatalog:detail', async (event, value) => {
    options.requireTrusted(event)
    try { return await options.service.detail(value) } catch { return fail() }
  })
}
