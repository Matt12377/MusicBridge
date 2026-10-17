import type { PhotoDecoderImage } from './collection-photos.js';
import { normalizeLocalArtwork } from './local-artwork-image.js';
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js';

/** 仅Provider图片使用；先复用原完整容器/像素预算，再解码缩图，最终JPEG仍不超过iOS的1MiB。 */
export function resizeMobileProviderArtwork(bytes: Uint8Array, size: 96 | 256 | 512,
  decode: (bytes: Buffer) => PhotoDecoderImage): Uint8Array {
  try {
    if (![96, 256, 512].includes(size)) throw new MobileServiceError(400, 'INVALID_REQUEST');
    const normalized = normalizeLocalArtwork(bytes, decode);
    const image = decode(Buffer.from(normalized.display.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'));
    if (image.isEmpty()) throw new MobileServiceError(503, 'BUSY');
    const encoded = image.resize({ width: size, height: size, quality: 'best' }).toJPEG(85);
    if (encoded.byteLength > 1024 * 1024) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
    const checked = normalizeLocalArtwork(encoded, decode);
    if (checked.original.width > size || checked.original.height > size) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
    const output = new Uint8Array(Buffer.from(checked.display.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'));
    if (output.byteLength > 1024 * 1024) throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED');
    return output;
  } catch (error) {
    if (error instanceof MobileServiceError) throw error;
    throw new MobileServiceError(503, 'BUSY');
  }
}
