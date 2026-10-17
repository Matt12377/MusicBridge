import type { TrackSummary } from '@music-bridge/contracts'
import type { LocalAlbumSummary, LocalAlbumTrackItem } from './types.js'

/** 表格只展示已有事实；版本、格式和时长不从名称或扩展名猜测。 */
export function localAlbumTrackPresentation(item: LocalAlbumTrackItem, album?: LocalAlbumSummary): TrackSummary {
  const metadata = item.facts.metadata.effective
  const version = [...new Set([...item.facts.versionTokens.map(token => token.raw), item.facts.metadata.override?.annotations?.versionDescription ?? ''].filter(Boolean))].join(' · ')
  const parameters = item.facts.fileParameters
  return { id: item.facts.track.id, title: metadata.title || '来源未提供标题', artists: metadata.artist ? [metadata.artist] : [], album: metadata.album || album?.title || '',
    ...(version ? { version } : {}), ...(parameters?.durationMs !== null && parameters?.durationMs !== undefined ? { durationMs: parameters.durationMs } : {}),
    ...(parameters?.codec ? { format: parameters.codec } : {}) }
}
