import * as dto from '@music-bridge/contracts'
import { LocalAlbumReadError } from './grouping.js'

/** 先核完整原回复，再裁减传输；网格请求不取得新来源或写入权限。 */
export function projectLocalAlbumArtworkReply(request: dto.LocalAlbumArtworkRequest,
  read: Pick<dto.LocalAlbumArtworkReply, 'image' | 'grid' | 'status'>): dto.LocalAlbumArtworkReply {
  const reply: dto.LocalAlbumArtworkReply = { albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId,
    representativeTrackId: request.representativeTrackId, revision: request.revision,
    ...(request.variant ? { variant: request.variant } : {}), ...read }
  if (!dto.isLocalAlbumArtworkReply(reply, request)) throw new LocalAlbumReadError('UNAVAILABLE', '本地封面回复暂时无效，请重试。')
  if (request.variant !== 'grid' || !reply.image || !reply.grid) return reply
  return { ...reply, image: { original: reply.image.original, display: reply.grid } }
}
