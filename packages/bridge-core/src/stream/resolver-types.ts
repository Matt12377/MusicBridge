import type { ResolvedAudioStream } from '../netease/types.js';

/** 私有解析类型叶子：来源分流与Registry共用，不反向依赖租约或注册实现。 */
export interface StreamResolveRequest {
  reason?: 'upstream_expired';
  status?: number;
}

export type StreamResolver = (
  request?: StreamResolveRequest,
) => Promise<ResolvedAudioStream>;
