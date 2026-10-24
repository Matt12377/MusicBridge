import { isScanJobRecord, type LocalLibraryPublicApi, type ScanJobRecord } from '@music-bridge/contracts'

/** 只刷新原任务的CAS修订；控制命令只发送一次，未知结果与拒绝均原样向上返回。 */
export async function controlLocalLibraryScan(
  api: Pick<LocalLibraryPublicApi, 'localLibraryScan'>,
  observed: ScanJobRecord,
  operation: 'pause' | 'resume' | 'cancel',
  commandId: string,
): Promise<ScanJobRecord> {
  const identity = { jobId: observed.jobId, datasetId: observed.datasetId, libraryRootId: observed.libraryRootId,
    sourceRootId: observed.sourceRootId, rootRevision: observed.rootRevision }
  const latest = await api.localLibraryScan('localScan.get', { jobId: identity.jobId })
  if (!isScanJobRecord(latest) || latest.jobId !== identity.jobId || latest.datasetId !== identity.datasetId
    || latest.libraryRootId !== identity.libraryRootId || latest.sourceRootId !== identity.sourceRootId
    || latest.rootRevision !== identity.rootRevision) {
    throw new Error('[INVENTORY_CONFLICT] 扫描任务身份已变化，控制操作未发送。请刷新状态后重试。')
  }
  return api.localLibraryScan(`localScan.${operation}`, { commandId, jobId: identity.jobId, expectedRevision: latest.jobRevision })
}
