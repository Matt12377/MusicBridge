import type { CatalogRevisionDelta, CatalogRevisionDetail, ImportReferenceArchiveCatalogRequest } from '@music-bridge/contracts'

/** 资料档案只通过来源身份和逻辑资产 ID 访问，不公开本地文件路径。 */
export interface CassetteArchiveSummary {
  sha256: string
  zipBytes: number
  bookId: string
  title: string
  sourceVersion: string
  itemCount: number
  assetCount: number
  primaryCount: number
  missingPrimaryCount: number
  realPhotoCount: number
  opaqueDisplayCount: number
}

export interface CassetteArchivePreview {
  summary: CassetteArchiveSummary
  datasetId: string
  expectedCurrentRevisionId: string | null
  baselineFingerprint: string
  delta: CatalogRevisionDelta
}

export interface CassetteReferenceAsset {
  id: string
  role: string
  origin: 'book' | 'real-photo-reference' | 'opaque-display'
  url: string
  caption: string
  source: string | null
}

export interface CassetteReferenceDetail {
  referenceId: string
  bookTitle: string
  sourceVersion: string
  bookYearLabel: string | null
  editionBasis: string
  lengthsEvidence: string
  missingPrimaryReason: string | null
  sections: readonly { title: string; text: string }[]
  assets: readonly CassetteReferenceAsset[]
  unknownFields: readonly string[]
}

export interface CassetteCatalogApi {
  pickCassetteArchive(): Promise<CassetteArchivePreview | null>
  importCassetteArchive(request: ImportReferenceArchiveCatalogRequest): Promise<CatalogRevisionDetail>
  getCassetteReferenceDetail(request: { sha256: string; referenceId: string }): Promise<CassetteReferenceDetail>
}

export function cassetteAssetUrl(sha256: string, assetId: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(assetId)) throw new Error('磁带资料图片身份无效。')
  return `musicbridge://app/reference-assets/${sha256}/${encodeURIComponent(assetId)}`
}
