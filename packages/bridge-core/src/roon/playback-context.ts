import type { RoonLibraryItem, TrackSummary } from '@music-bridge/contracts';

/** Core内部授权窗口；offset属于全部有效条目，items仅含可播放曲目。 */
export interface RoonPlaybackContextItem {
  reference: string;
  zoneId: string;
  track: TrackSummary;
  roonItem: RoonLibraryItem;
}
export interface RoonPlaybackContextPage {
  items: readonly RoonPlaybackContextItem[];
  offset: number;
  nextOffset: number;
  /** 本页已达尾部EOF；不能直接复制缓存整体的complete。 */
  complete: boolean;
}
export interface RoonPlaybackContextLease {
  initial: RoonPlaybackContextPage & { selectedIndex: number };
  isCurrent(): boolean;
  /** 无可见游标副作用；Controller持有已发布窗口与事务暂存位置。 */
  read(page: { offset: number; limit: number }, options: {
    signal: AbortSignal;
    isCurrent(): boolean;
  }): Promise<RoonPlaybackContextPage>;
  release(): void;
}
