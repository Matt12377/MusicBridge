import type { Page, TrackSummary } from './library.js';
import type { RoonLibraryPage } from './roon.js';

/**
 * 两个来源的统一搜索快照；来源保持分离，避免把 Roon 运行期引用伪装成网易云歌曲。
 */
export interface PublicAggregatedSearchResult {
  query: string;
  netease: Page<TrackSummary>;
  roon: RoonLibraryPage;
  roonAvailable: boolean;
}
