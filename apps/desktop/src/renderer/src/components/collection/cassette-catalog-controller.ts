import type { CatalogRevisionDetail, ImportReferenceArchiveCatalogRequest } from '@music-bridge/contracts'
import type { CassetteArchivePreview, CassetteCatalogApi } from '../../../../shared/cassette-catalog'

export interface CassetteArchiveImportState {
  busy: boolean
  preview?: CassetteArchivePreview
  pendingRequest?: Readonly<ImportReferenceArchiveCatalogRequest>
  result?: CatalogRevisionDetail
  error: string
  notice: string
}

function publicError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (/CONFLICT|STALE|BASELINE|DATASET_CHANGED/u.test(message)) return '资料库或目录基线已变化，请先核对原操作回执，再重新选择资料包并预览。'
  return '完整资料包导入尚未取得明确回执。请核对原操作并明确重试；不会自动重发。'
}

/** 大 ZIP 字节与路径留在 Main；局部恢复始终使用同一命令与预览身份。 */
export function createCassetteArchiveImportController(options: {
  api: CassetteCatalogApi
  onChange?: () => void
  onImported?: (detail: CatalogRevisionDetail) => void
}) {
  const state: CassetteArchiveImportState = { busy: false, error: '', notice: '' }
  let alive = true
  const changed = () => { if (alive) options.onChange?.() }

  async function retry(): Promise<void> {
    if (!alive || state.busy || !state.pendingRequest) return
    const request = state.pendingRequest
    state.busy = true; state.error = ''; changed()
    try {
      const result = await options.api.importCassetteArchive(request)
      if (alive) {
        state.pendingRequest = undefined; state.preview = undefined; state.result = result
        state.notice = '完整资料已导入并发布。目录与图片用于参考，未创建磁带库存。'
        options.onImported?.(result)
      }
    } catch (cause) { if (alive) state.error = publicError(cause) }
    finally { if (alive) { state.busy = false; changed() } }
  }

  return {
    state,
    async pickArchive(): Promise<void> {
      if (!alive || state.busy || state.pendingRequest) return
      state.busy = true; state.error = ''; state.notice = ''; changed()
      try {
        const preview = await options.api.pickCassetteArchive()
        if (alive && preview) { state.preview = structuredClone(preview); state.result = undefined }
      } catch {
        if (alive) state.error = '资料包未载入。请选择完整且有效的磁带资料 ZIP；现有目录与库存保留。'
      } finally { if (alive) { state.busy = false; changed() } }
    },
    async importArchive(confirmed: boolean): Promise<void> {
      if (!alive || state.busy || state.pendingRequest || !confirmed || !state.preview) return
      const preview = state.preview
      state.pendingRequest = Object.freeze({ commandId: crypto.randomUUID(), archiveSha256: preview.summary.sha256, expectedDatasetId: preview.datasetId,
        expectedCurrentRevisionId: preview.expectedCurrentRevisionId, baselineFingerprint: preview.baselineFingerprint,
        userConfirmed: true as const })
      await retry()
    },
    retry,
    releasePending(): void {
      if (!alive || state.busy || !state.pendingRequest) return
      state.pendingRequest = undefined; state.preview = undefined; state.error = ''
      state.notice = '已退出本地重试。原命令仍可从全局未确认操作中核对，不会自动重发。'; changed()
    },
    dispose(): void { alive = false },
  }
}
