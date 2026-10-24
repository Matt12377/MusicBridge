import type { ArtistQuery, LocalArtistSummary, LocalArtistPage, LocalArtistAlbumsQuery, LocalArtistAlbumsPage, LocalArtistTracksQuery, LocalArtistTracksPage, LocalArtistSearchResult } from './artist-search.js';
import { isArtistQuery, isLocalArtistId, isLocalArtistAlbumsQuery, isLocalArtistTracksQuery, isLocalArtistPage, isLocalArtistSummary, isLocalArtistAlbumsPage, isLocalArtistTracksPage, isLocalArtistSearchResult } from './artist-search.js';
import type { LocalPlayAction, LocalPlayTarget, LocalPlayAccepted, LocalSourceUnsupported } from './local-play-request.js';

/** 图片出处与作品来源分别表达，关联不改写本地曲目身份。 */
export interface ArtistCatalogArtist extends LocalArtistSummary {
  artworkUrl?: string;
  biography?: string;
  credit?: string;
  linkState?: 'automatic' | 'manual' | 'unlinked';
}
export interface NeteaseArtistProfile { id: string; name: string; albumCount: number; trackCount: number; artworkUrl?: string; biography: string }
export interface ArtistCatalogPage extends Omit<LocalArtistPage, 'items'> { items: readonly ArtistCatalogArtist[] }
export interface ArtistCatalogSearch extends Omit<LocalArtistSearchResult, 'artists'> { artists: ArtistCatalogPage }
export type LocalSearchPlayContext = { kind: 'artist'; artistId: string; revision: string } | { kind: 'search'; query: string; revision: string };
export interface ArtistCatalogPlayRequest { requestId: string; context: LocalSearchPlayContext; startTrackId: string; target: LocalPlayTarget; action: LocalPlayAction }
export interface ArtistSearchCatalogPublicApi {
  listArtists(request: ArtistQuery): Promise<ArtistCatalogPage>;
  getArtist(request: { artistId: string }): Promise<ArtistCatalogArtist>;
  listArtistAlbums(request: LocalArtistAlbumsQuery): Promise<LocalArtistAlbumsPage>;
  listArtistTracks(request: LocalArtistTracksQuery): Promise<LocalArtistTracksPage>;
  search(request: ArtistQuery): Promise<ArtistCatalogSearch>;
  suggest(request: { query: string }): Promise<{ keywords: string[] }>;
  artistMatches(request: { artistId: string; query?: string }): Promise<ArtistCatalogArtist[]>;
  bindArtist(request: { artistId: string; neteaseArtistId: string | null }): Promise<ArtistCatalogArtist>;
  playLocalSelection(request: ArtistCatalogPlayRequest): Promise<LocalPlayAccepted | LocalSourceUnsupported>;
}
export interface LocalArtistCommandPayloads {
  'localArtist.list': ArtistQuery;
  'localArtist.get': { artistId: string };
  'localArtist.albums': LocalArtistAlbumsQuery;
  'localArtist.tracks': LocalArtistTracksQuery;
  'localArtist.search': ArtistQuery;
}
export interface LocalArtistCommandResults {
  'localArtist.list': LocalArtistPage;
  'localArtist.get': LocalArtistSummary;
  'localArtist.albums': LocalArtistAlbumsPage;
  'localArtist.tracks': LocalArtistTracksPage;
  'localArtist.search': LocalArtistSearchResult;
}
export const LOCAL_ARTIST_COMMANDS = ['localArtist.list', 'localArtist.get', 'localArtist.albums', 'localArtist.tracks', 'localArtist.search'] as const;
export type LocalArtistCommand = typeof LOCAL_ARTIST_COMMANDS[number];
export const isLocalArtistCommand = (value: unknown): value is LocalArtistCommand => typeof value === 'string' && (LOCAL_ARTIST_COMMANDS as readonly string[]).includes(value);
export function isLocalArtistCommandPayload(command: LocalArtistCommand, value: unknown): boolean {
  if (command === 'localArtist.list' || command === 'localArtist.search') return isArtistQuery(value);
  if (command === 'localArtist.albums') return isLocalArtistAlbumsQuery(value);
  if (command === 'localArtist.tracks') return isLocalArtistTracksQuery(value);
  return !!value && typeof value === 'object' && Reflect.ownKeys(value).length === 1
    && isLocalArtistId(Object.getOwnPropertyDescriptor(value, 'artistId')?.value);
}
export function isLocalArtistCommandResult(command: LocalArtistCommand, value: unknown): boolean {
  switch (command) {
    case 'localArtist.list': return isLocalArtistPage(value);
    case 'localArtist.get': return isLocalArtistSummary(value);
    case 'localArtist.albums': return isLocalArtistAlbumsPage(value);
    case 'localArtist.tracks': return isLocalArtistTracksPage(value);
    case 'localArtist.search': return isLocalArtistSearchResult(value);
  }
}
