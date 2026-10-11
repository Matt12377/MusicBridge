import type { MobileSafeErrorFacts } from '@music-bridge/contracts';

/** 共用的基础错误叶子，不反向依赖 Main、Owner 或内容协议。旧入口继续重导出同一个类。 */
export class MobileServiceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503,
    readonly code: MobileSafeErrorFacts['code'], readonly retryable = false, readonly retryAfterMs?: number) {
    super('移动服务当前无法完成请求。');
  }
}
