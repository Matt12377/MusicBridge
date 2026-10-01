import type { Page, PageRequest, PlaylistDetail, TrackSummary } from '@music-bridge/contracts'

export class PlaylistSnapshotChanged extends Error { constructor() { super('歌单内容已变化，请重新读取；当前播放继续。') } }
/** 双方缺失是旧合同；有值与缺值混合也属于不可拼接的新代。 */
export function samePlaylistSnapshot(before: Pick<PlaylistDetail, 'snapshotVersion'>, after: Pick<PlaylistDetail, 'snapshotVersion'>): boolean {
  return before.snapshotVersion === after.snapshotVersion
}
/** 每次队列操作独立绑定版本，后续变化只停止追加，不能重放已开始的音频。 */
export function createPlaylistSnapshotLoader(load: (page: PageRequest) => Promise<PlaylistDetail>, initial?: PlaylistDetail): (page: PageRequest) => Promise<Page<TrackSummary>> {
  let bound = initial !== undefined, version = initial?.snapshotVersion
  return async page => {
    const detail = await load(page)
    if (bound && detail.snapshotVersion !== version) throw new PlaylistSnapshotChanged()
    bound = true; version = detail.snapshotVersion
    return detail.tracks
  }
}
