import type { MatchResult } from './index.js';
import {
  resolvePlaybackSource,
  type PlaybackSourcePolicy,
  type ResolvedPlaybackSource,
} from './playback-resolver.js';

export type MixedQueueSource = Exclude<ResolvedPlaybackSource, 'unavailable'>;

export interface MixedQueueTransitionRequest {
  activeSource?: MixedQueueSource;
  nextSource: MixedQueueSource;
}

export interface MixedQueueTransition {
  /** 当前来源必须先结束，下一来源才允许启动，防止两个来源重叠。 */
  stopActiveBeforeStart: boolean;
  nextSource: MixedQueueSource;
}

/**
 * 为逻辑队列做来源切换规划。来源在曲目开始时锁定；后台重新匹配只能影响下一首。
 */
export function planMixedQueueTransition(
  request: MixedQueueTransitionRequest,
): MixedQueueTransition {
  return {
    stopActiveBeforeStart: request.activeSource !== undefined,
    nextSource: request.nextSource,
  };
}

export function resolveMixedQueueSource(
  policy: PlaybackSourcePolicy,
  match: Pick<MatchResult, 'state' | 'candidate'> | undefined,
  roonAvailable: boolean,
): ResolvedPlaybackSource {
  return resolvePlaybackSource(policy, match as MatchResult | undefined, roonAvailable);
}
