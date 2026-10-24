import type { AlbumEditionTrack } from '@music-bridge/contracts'
import type { LocalAlbumTrackFact } from './types.js'

/** 仅原Owner同步帧中的成员身份证明；不携带完整组摘要、库存、FD或Source授权。 */
export interface LocalAlbumSourceMemberRequest {
  trackId: string; groupHash: string | null; editionId: string | null
}
export interface LocalAlbumSourceMemberIdentity {
  rootId: string; albumKey: string; groupHash: string; editionId: string | null
  fact: Pick<LocalAlbumTrackFact, 'relative' | 'summary' | 'rawMetadata'>
  editionLink: AlbumEditionTrack | null
}
/** null只表示窄证明不足，调用者保留原精确作者；0/1/2仍分别表示缺失、唯一、多义。 */
export interface LocalAlbumSourceMemberResult {
  legacyGroupCount: number | null; items: readonly LocalAlbumSourceMemberIdentity[]
}
