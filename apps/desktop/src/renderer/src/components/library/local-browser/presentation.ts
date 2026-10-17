import type { LocalAlbumFilter, LocalAlbumStatus, LocalAlbumSummary } from '../../../composables/application/local-library-browser/types.js'
import { LOCAL_WORKBENCH_MAX_ALBUMS } from '@music-bridge/contracts'

export const LOCAL_ALBUM_FILTER_LABELS: Readonly<Record<LocalAlbumFilter, string>> = {
  all: '全部专辑',
  'missing-artwork': '缺封面',
  'has-artwork': '已有封面',
  'cue-unsplit': '未分轨',
  'metadata-issue': '标签异常',
  'parse-failed': '名称解析失败',
  'loose-audio': '散落音频',
  'track-named-audio': 'track 音轨',
  'missing-lyrics': '缺歌词',
}

export interface LocalAlbumWorkbenchRequest {
  action: 'overview' | 'artwork' | 'ai' | 'cue' | 'organize'
  albumId?: string
  editionId?: string
  trackId?: string
}

export const LOCAL_ALBUM_BATCH_LIMIT = LOCAL_WORKBENCH_MAX_ALBUMS
/** 浏览身份由真实读模型提供；不能从标题、目录显示名或代表曲目推导。 */
export interface LocalAlbumWorkbenchBatchTarget {
  albumKey: string
  rootId: string
  revision: string
  kind: LocalAlbumSummary['kind']
  title: string
  artists: readonly string[]
  editionId: string | null
  representativeTrackId: string | null
}
export interface LocalAlbumWorkbenchBatchRequest {
  action: LocalAlbumWorkbenchRequest['action']
  albums: readonly LocalAlbumWorkbenchBatchTarget[]
}

export function localAlbumWorkbenchBatchRequest(albums: readonly LocalAlbumSummary[], action: LocalAlbumWorkbenchRequest['action'] = 'overview'): LocalAlbumWorkbenchBatchRequest {
  return {
    action,
    albums: albums.map(album => ({
      albumKey: album.id, rootId: album.rootId, revision: album.revision, kind: album.kind,
      title: album.title, artists: [...album.artists], editionId: album.editionId, representativeTrackId: album.representativeTrackId,
    })),
  }
}

export function localAlbumIdentity(album: LocalAlbumSummary): string {
  const values = [album.year, album.versionLabel, album.sourceLabel].filter((value): value is string => !!value)
  return values.length ? values.join(' · ') : album.kind === 'edition' ? '已保存的独立发行' : '按源目录收录'
}

export function localAlbumIssueLabel(statuses: readonly LocalAlbumStatus[]): string {
  return statuses.filter(status => status !== 'has-artwork').map(status => LOCAL_ALBUM_FILTER_LABELS[status]).join(' · ')
}

export function localAlbumWorkbenchRequest(album: LocalAlbumSummary, action: LocalAlbumWorkbenchRequest['action'], trackId?: string): LocalAlbumWorkbenchRequest {
  return {
    action,
    albumId: album.id,
    ...(album.editionId ? { editionId: album.editionId } : {}),
    ...(trackId || album.representativeTrackId ? { trackId: trackId || album.representativeTrackId! } : {}),
  }
}
