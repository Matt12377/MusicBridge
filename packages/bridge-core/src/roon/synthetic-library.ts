import { createRoonPublicLibrary, type RoonPublicLibrary } from './public-library.js';
import type { RoonEntityDescriptor, RoonLibraryService, RoonPageRequest } from './library.js';

/** 仅由显式 Core test + UI E2E 分支创建，无账号、网络或真实 Roon 访问。 */
export function createSyntheticRoonLibrary(): RoonPublicLibrary {
  const albums: RoonEntityDescriptor[] = [
    { kind: 'album', title: '关联验收专辑', artist: '关联验收艺术家', year: 1994, version: '合成首版', itemKey: 'synthetic-private-album-1' },
    { kind: 'album', title: '另一张合成专辑', artist: '另一位合成艺术家', year: 2000, itemKey: 'synthetic-private-album-2' },
  ];
  const pageOf = (items: readonly RoonEntityDescriptor[], page: RoonPageRequest) => ({ items: items.slice(page.offset, page.offset + page.limit), offset: page.offset, level: 0, total: items.length, hasMore: page.offset + page.limit < items.length });
  const empty = async () => ({ items: [], offset: 0, level: 0 });
  const service: RoonLibraryService = {
    browseAlbums: async page => pageOf(albums, page), browseArtists: empty, browseGenres: empty, browsePlaylists: empty, browseArtist: empty, browseGenre: empty, browsePlaylist: empty,
    browseAlbum: async (_album, page) => pageOf([{ kind: 'track', title: '合成关联曲目', artist: '关联验收艺术家', itemKey: 'synthetic-private-track-1', durationMs: 180000 }], page),
    searchLibrary: async (query, page, kind) => pageOf(kind === 'album' ? albums.filter(a => `${a.title} ${a.artist}`.includes(query)) : [], page),
    getImage: async () => ({ contentType: 'image/jpeg', body: Buffer.from([255, 216, 255, 217]) }),
    playTrack: async () => { throw new Error('合成目录不提供播放成功证据'); }, queueTrack: async () => { throw new Error('合成目录不提供队列成功证据'); },
  };
  return createRoonPublicLibrary(() => service);
}
