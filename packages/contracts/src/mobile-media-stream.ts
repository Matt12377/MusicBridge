import { MOBILE_CODEC_LIMITS, mobileDataSnapshot, mobileFailure, mobileInteger, mobileOk, mobileRecord } from './mobile-common.js';
import type { MobileDecodeResult } from './mobile-common.js';
import type { MobileHeaderPairs } from './mobile-wire.js';

export type MobileMediaStreamOperation = 'getMediaAsset' | 'headMediaAsset';
export type MobileMediaStreamStatus = 200 | 206 | 400 | 416;

/** 仅记录 HTTP 头部及发送计数，不认证资源归属、FD、音频内容或设备播放。 */
export interface MobileMediaStreamSnapshot {
  readonly operation: MobileMediaStreamOperation;
  readonly status: MobileMediaStreamStatus;
  readonly fullContentLength: number;
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly contentRange: string | null;
  readonly expectedBodyBytes: number;
}

interface ByteInterval { start: number; end: number; total: number }
type RequestedSelection = ByteInterval | 400 | 416;
const SNAPSHOT_FIELDS = ['operation','status','fullContentLength','contentLength','contentType','contentRange','expectedBodyBytes'] as const;

function captureHeaders(raw: MobileHeaderPairs): MobileDecodeResult<Map<string,string>> {
  // 与 whole decoder 相同的完整有界数据捕获；不调用 getter、toJSON 或字符串强制转换。
  const captured = mobileDataSnapshot(raw, MOBILE_CODEC_LIMITS, 'request');
  if (!captured.ok) return mobileFailure(captured.issue.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'INVALID_RESPONSE', 'headers');
  if (!Array.isArray(captured.value)) return mobileFailure('INVALID_RESPONSE', 'headers');
  const headers = new Map<string,string>();
  for (const row of captured.value) {
    if (!Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value))) return mobileFailure('INVALID_RESPONSE', 'headers');
    const name = row[0] as string, value = row[1] as string;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || headers.has(name.toLowerCase())) return mobileFailure('INVALID_RESPONSE', 'headers');
    headers.set(name.toLowerCase(), value);
  }
  return mobileOk(headers);
}

function selectedRequest(range: string, total: number): RequestedSelection {
  if (range.length > 128 || /[\u0000-\u001f\u007f]/u.test(range)) return 400;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match || !match[1] && !match[2]) return 400;
  const start = match[1] ? Number(match[1]) : undefined, end = match[2] ? Number(match[2]) : undefined;
  if (start !== undefined && !mobileInteger(start) || end !== undefined && !mobileInteger(end)) return 400;
  if (start === undefined) return total === 0 || end === 0 ? 416 : {start:Math.max(0,total-end!),end:total-1,total};
  if (end !== undefined && end < start) return 400;
  if (start >= total) return 416;
  return {start,end:Math.min(end ?? total-1,total-1),total};
}

function responseInterval(raw: string | null): ByteInterval | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(raw ?? '');
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  return [start,end,total].every(value => mobileInteger(value)) && start <= end && end < total ? {start,end,total} : null;
}

/**
 * 大媒体仅校验头部，不把 Content-Length 套入 JSON 的 2MiB 正文上限。
 * rangeRequested 是实际有效的单 Range；HTTP 层因 If-Range 回完整表示时不传。
 * HEAD 完全忽略该参数。成功返回后仍必须另核实际 EOF 发送计数。
 */
export function validateMobileMediaStreamHeaders(
  operation: MobileMediaStreamOperation,
  status: number,
  headers: MobileHeaderPairs,
  fullContentLength: number,
  rangeRequested?: string,
): MobileDecodeResult<MobileMediaStreamSnapshot> {
  if (operation !== 'getMediaAsset' && operation !== 'headMediaAsset' || !mobileInteger(status) || ![200,206,400,416].includes(status)) return mobileFailure('INVALID_RESPONSE', 'status');
  if (!mobileInteger(fullContentLength)) return mobileFailure('INVALID_RESPONSE', 'full-content-length');
  const captured = captureHeaders(headers); if (!captured.ok) return captured;
  const h = captured.value, rawLength = h.get('content-length');
  if (rawLength === undefined || !/^(0|[1-9]\d*)$/u.test(rawLength) || !mobileInteger(Number(rawLength))) return mobileFailure('INVALID_RESPONSE', 'content-length');
  const contentLength = Number(rawLength), contentRange = h.get('content-range') ?? null, contentType = h.get('content-type') ?? null;
  if (operation === 'headMediaAsset') {
    // 本入口只消费媒体成功头及 GET 范围拒绝；HEAD 安全错误由原响应入口处理。
    if (status !== 200 || contentRange !== null || contentLength !== fullContentLength) return mobileFailure('INVALID_RESPONSE', 'head');
  } else if (status === 400) {
    if (contentLength !== 0 || contentRange !== null) return mobileFailure('INVALID_RESPONSE', 'range');
  } else if (status === 416) {
    const match = /^bytes \*\/(0|[1-9]\d*)$/u.exec(contentRange ?? '');
    if (!match || !mobileInteger(Number(match[1])) || Number(match[1]) !== fullContentLength || contentLength !== 0) return mobileFailure('INVALID_RESPONSE', 'range');
  } else if (status === 206) {
    const interval = responseInterval(contentRange);
    if (!interval || interval.total !== fullContentLength || contentLength !== interval.end-interval.start+1 || h.get('accept-ranges') !== 'bytes') return mobileFailure('INVALID_RESPONSE', 'range');
  } else if (contentRange !== null || contentLength !== fullContentLength || h.get('accept-ranges') !== 'bytes') return mobileFailure('INVALID_RESPONSE', 'range');

  if (operation === 'getMediaAsset' && rangeRequested !== undefined) {
    if (typeof rangeRequested !== 'string') return mobileFailure('INVALID_RESPONSE', 'range-request');
    const selected = selectedRequest(rangeRequested,fullContentLength);
    if (status === 206) {
      const interval = responseInterval(contentRange)!;
      if (typeof selected === 'number' || selected.start !== interval.start || selected.end !== interval.end || selected.total !== interval.total) return mobileFailure('INVALID_RESPONSE', 'range-request');
    } else if ((status === 400 || status === 416) && selected !== status) return mobileFailure('INVALID_RESPONSE', 'range-request');
    // 200 仍允许服务器回完整表示；这里不把合法 HTTP 回退升级成新的请求资格。
  }
  return mobileOk(Object.freeze({operation,status:status as MobileMediaStreamStatus,fullContentLength,contentLength,contentType,contentRange,
    expectedBodyBytes:operation === 'headMediaAsset' || status === 400 || status === 416 ? 0 : contentLength}));
}

/** 按实际发送字节严格收口，不能以声明 Content-Length 或读取计划冒充已发送正文。 */
export function validateMobileMediaStreamCompletion(snapshot: MobileMediaStreamSnapshot, actualBytes: number): MobileDecodeResult<MobileMediaStreamSnapshot> {
  if (!mobileInteger(actualBytes)) return mobileFailure('INVALID_RESPONSE', 'actual-bytes');
  const captured = mobileDataSnapshot(snapshot); if (!captured.ok) return mobileFailure('INVALID_RESPONSE', 'snapshot');
  const value = captured.value;
  if (!mobileRecord(value) || Object.keys(value).length !== SNAPSHOT_FIELDS.length || SNAPSHOT_FIELDS.some(key => !Object.hasOwn(value,key))) return mobileFailure('INVALID_RESPONSE', 'snapshot');
  if (value.operation !== 'getMediaAsset' && value.operation !== 'headMediaAsset' || !mobileInteger(value.status) || !mobileInteger(value.fullContentLength)
    || !mobileInteger(value.contentLength) || !mobileInteger(value.expectedBodyBytes) || value.contentType !== null && typeof value.contentType !== 'string'
    || value.contentRange !== null && typeof value.contentRange !== 'string') return mobileFailure('INVALID_RESPONSE', 'snapshot');
  const headers: [string,string][] = [['Content-Length',String(value.contentLength)],['Accept-Ranges','bytes']];
  if (value.contentType !== null) headers.push(['Content-Type',value.contentType]);
  if (value.contentRange !== null) headers.push(['Content-Range',value.contentRange]);
  const validated = validateMobileMediaStreamHeaders(value.operation,value.status,headers,value.fullContentLength);
  if (!validated.ok || validated.value.expectedBodyBytes !== value.expectedBodyBytes) return mobileFailure('INVALID_RESPONSE', 'snapshot');
  if (actualBytes !== validated.value.expectedBodyBytes) return mobileFailure('INVALID_RESPONSE', 'actual-bytes');
  return validated;
}
