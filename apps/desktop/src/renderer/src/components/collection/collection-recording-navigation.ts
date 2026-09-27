/** 收藏页传给录音工作台的选择意图；不代表已预留、已认证或正式开录。 */
export interface RecordingPhysicalSelection {
  physicalId: string
  physicalRevision: number
  modelId: string
  skuId: string
  packaging: 'opened' | 'sealed'
}

export interface CollectionReturnLocation {
  physicalId: string
  modelId: string
  returnOffset: number
}

export interface CollectionStartEntry extends RecordingPhysicalSelection {
  returnOffset: number
}

/** 从已预留单盘直达确切制作；仅是导航身份，不能替代实时预留校验。 */
export interface RecordingReservationNavigation {
  physicalId: string
  draftId: string
  planId: string
}

export interface RecordingReservationSelection extends RecordingPhysicalSelection, RecordingReservationNavigation {}

export interface CollectionReservationEntry extends RecordingReservationSelection {
  returnOffset: number
}
