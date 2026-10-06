/** 纯规则证据不授予目录访问能力，也不产生曲目或发行版身份。 */
export type NameEvidenceSource = 'title' | 'artist' | 'album' | 'albumArtist' | 'directory';
export interface VersionNameToken { raw: string; source: NameEvidenceSource; kind: 'edition' | 'format' | 'disc' | 'year'; start: number; end: number }
export interface NameRuleEvidence { raw: string; display: string; canonicalKey: string; searchAliases: string[]; versionTokens: VersionNameToken[] }
export interface AlbumNameMemberFact { trackId: string; title?: string; artist?: string; albumArtist?: string; album?: string }
export interface ManualAlbumNameOverride { artistName?: string; albumName?: string; boundaryId?: string }
export interface AlbumNameRuleInput {
  artistName: string; albumName: string; members: readonly AlbumNameMemberFact[];
  manual?: ManualAlbumNameOverride; aiMode: 'off' | 'optional';
}
export interface AlbumNameCandidate {
  field: 'artist' | 'album'; source: 'artist' | 'albumArtist' | 'album'; value: string; canonicalKey: string;
  supportingTrackIds: string[]; validTagCount: number; totalTrackCount: number;
  coverage: number; consistency: number; confidence: 'high' | 'low' | 'ambiguous'; needsConfirmation: boolean;
}
export interface AlbumNameRuleResult {
  artist: NameRuleEvidence; album: NameRuleEvidence; members: AlbumNameMemberFact[];
  rawNames: { artistName: string; albumName: string }; rawVersionTokens: VersionNameToken[];
  memberEvidence: { trackId: string; title?: NameRuleEvidence; artist?: NameRuleEvidence; albumArtist?: NameRuleEvidence; album?: NameRuleEvidence }[];
  candidates: AlbumNameCandidate[]; manual: ManualAlbumNameOverride | null; aiMode: 'off' | 'optional';
}
/** 所有目录和文件事实必须由原 owner 预先捕获；本模块不读取路径。 */
export interface NameDirectoryFact { id: string; parentId: string | null; name: string; directAudioCount: number; cueCount?: number }
export type NameDirectoryRole = 'album-container' | 'collection-container' | 'disc' | 'format' | 'version' | 'track' | 'ordinary';
export interface ManualAlbumBoundary { directoryId: string; boundaryId: string }
export interface AlbumBoundaryCandidate { directoryId: string; boundaryId: string; reason: 'manual' | 'structural' | 'numbered-discs' | 'track-folders' | 'directory'; needsConfirmation: boolean }
