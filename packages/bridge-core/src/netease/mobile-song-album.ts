import { mobileDataSnapshot, mobileInteger, mobileRecord, mobileUtf8Bytes, type MobileRecord } from '@music-bridge/contracts';
import { MobileServiceError } from '../mobile/types.js';
const invalid = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };

/** 缺省和null表示没有专辑记录；其它非普通对象不能冒充未注册专辑。 */
export function mobileNeteaseSongAlbum(raw: unknown): MobileRecord {
  if (raw === undefined || raw === null) return Object.freeze({});
  const captured = mobileDataSnapshot(raw);
  if (!captured.ok || !mobileRecord(captured.value)) return invalid();
  return captured.value;
}
/** 精确零/缺省/null是未注册标记；不能宽松Number转换或替代非法真实ID。 */
export function mobileNeteaseAlbumRegistration(album: MobileRecord): string | null {
  const value = album.id;
  if (value === undefined || value === null || value === 0 || value === '0') return null;
  if (typeof value === 'string' && /^[1-9][0-9]{0,31}(?![\s\S])/u.test(value)) return value;
  if (mobileInteger(value, 1)) return String(value);
  return invalid();
}
export function mobileNeteaseSongAlbumName(album: MobileRecord, registered: string | null): string {
  const value = album.name;
  if (registered === null && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || registered !== null && !value.trim() || mobileUtf8Bytes(value) > 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return invalid();
  return value;
}
export const isMobileNeteaseUnregisteredAlbumId = (value: unknown): value is string =>
  typeof value === 'string' && /^nu:[a-f0-9]{64}$/u.test(value);
