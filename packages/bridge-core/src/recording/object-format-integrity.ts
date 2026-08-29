import { MAX_COLLECTION_PHOTO_BYTES, MAX_MASTER_ARTWORK_BYTES, MAX_RECORDING_PRINT_PDF_BYTES, isCollectionPhotoDimensions } from '@music-bridge/contracts';

/** 只处理实际raw；等价于公开guard验证Buffer标准base64编码，不接受外部编码或信任标志。 */
export function isCollectionPhotoBytes(bytes: Uint8Array, width: unknown, height: unknown): boolean {
  // Collection原合同按编码长度限额，MAX+1/2在同一编码长度桶时仍可接受，不能偷偷收紧。
  return isCollectionPhotoDimensions(width, height) && Math.ceil(bytes.byteLength / 3) * 4 <= Math.ceil(MAX_COLLECTION_PHOTO_BYTES / 3) * 4
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function isMasterArtworkBytes(bytes: Uint8Array, width: unknown, height: unknown): boolean {
  return bytes.byteLength <= MAX_MASTER_ARTWORK_BYTES && isCollectionPhotoBytes(bytes, width, height);
}

export function isRecordingPrintPdfBytes(bytes: Uint8Array): boolean {
  if (Math.ceil(bytes.byteLength / 3) * 4 < 16 || bytes.byteLength > MAX_RECORDING_PRINT_PDF_BYTES) return false;
  if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) return false;
  let end = bytes.byteLength;
  // 对应原Latin-1解码后的 /%%EOF[\r\n\t ]*$/；没有新增PDF结构或尾随字符规则。
  while (end > 0 && (bytes[end - 1] === 13 || bytes[end - 1] === 10 || bytes[end - 1] === 9 || bytes[end - 1] === 32)) --end;
  return end >= 5 && bytes[end - 5] === 0x25 && bytes[end - 4] === 0x25 && bytes[end - 3] === 0x45 && bytes[end - 2] === 0x4f && bytes[end - 1] === 0x46;
}
