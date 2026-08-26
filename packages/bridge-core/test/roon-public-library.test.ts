import assert from 'node:assert/strict';
import test from 'node:test';
import { roonTrackIdFromReference } from '@music-bridge/contracts';
import { createRoonLibraryService, type RoonLibraryService } from '../src/roon/library.js';
import { createRoonPublicLibrary } from '../src/roon/public-library.js';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

test('Roon public library converts runtime item keys into scoped references', async () => {
  const service = createRoonLibraryService({
    browse: {
      browse: (_options, callback) => callback(false, { list: { level: 0, count: 1 } }),
      load: (_options, callback) => callback(false, {
        offset: 0,
        items: [{
          title: 'Private Album',
          item_key: 'album:private',
          hint: 'list',
          image_key: 'image:private',
          duration: 123,
        }],
      }),
    },
    image: {
      get_image: (_key, _options, callback) => callback(false, 'image/jpeg', JPEG_BYTES),
    },
  });
  const publicLibrary = createRoonPublicLibrary(() => service);

  const page = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const item = page.items[0];
  assert.ok(item);
  assert.equal(item.title, 'Private Album');
  assert.equal(item.durationMs, 123_000);
  assert.equal('itemKey' in item, false);
  assert.equal('imageKey' in item, false);
  assert.match(item.reference, /^musicbridge-v2-entity-/u);
  assert.match(item.artworkReference ?? '', /^musicbridge-v2-image-/u);

  const image = await publicLibrary.getImage(item.artworkReference ?? '', {
    width: 128,
    height: 128,
  });
  assert.equal(image.contentType, 'image/jpeg');
  assert.deepEqual(image.body, new Uint8Array(JPEG_BYTES));
});

test('Roon public library 为同一运行期实体复用稳定引用', async () => {
  const service: RoonLibraryService = {
    browseAlbums: async () => ({
      items: [{
        kind: 'album',
        title: 'Stable Album',
        itemKey: 'album:stable',
        imageKey: 'image:stable',
      }],
      offset: 0,
      level: 0,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async () => ({ items: [], offset: 0, level: 1 }),
    browseArtist: async () => ({ items: [], offset: 0, level: 1 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  };
  const publicLibrary = createRoonPublicLibrary(() => service);

  const first = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const second = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });

  assert.equal(first.items[0]?.reference, second.items[0]?.reference);
  assert.equal(first.items[0]?.artworkReference, second.items[0]?.artworkReference);
});

test('Roon public library 按图片身份与尺寸去重并缓存受控二进制', async () => {
  let imageCalls = 0;
  const summaries: Array<Record<string, unknown>> = [];
  const service: RoonLibraryService = {
    browseAlbums: async () => ({
      items: [{ kind: 'album', title: 'Cached Album', itemKey: 'album:cached', imageKey: 'image:cached' }],
      offset: 0,
      level: 0,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async () => ({ items: [], offset: 0, level: 1 }),
    browseArtist: async () => ({ items: [], offset: 0, level: 1 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => {
      imageCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { contentType: 'image/jpeg', body: JPEG_BYTES };
    },
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  };
  const publicLibrary = createRoonPublicLibrary(() => service, {
    maxImageCacheEntries: 4,
    onImageShape: (summary) => summaries.push(summary as unknown as Record<string, unknown>),
  });
  const page = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const reference = page.items[0]?.artworkReference ?? '';

  const [first, second] = await Promise.all([
    publicLibrary.getImage(reference, { width: 256, height: 256, scale: 'fit', format: 'image/jpeg' }),
    publicLibrary.getImage(reference, { width: 256, height: 256, scale: 'fit', format: 'image/jpeg' }),
  ]);
  assert.equal(imageCalls, 1);
  assert.deepEqual(first.body, second.body);
  assert.notEqual(first.body, second.body);

  await publicLibrary.getImage(reference, { width: 256, height: 256, scale: 'fit', format: 'image/jpeg' });
  assert.equal(imageCalls, 1);
  await publicLibrary.getImage(reference, { width: 512, height: 512, scale: 'fit', format: 'image/jpeg' });
  assert.equal(imageCalls, 2);
  assert.deepEqual(summaries, [{
    layer: 'bridge-core-output',
    contentType: 'image/jpeg',
    byteLength: 8,
    magic8: 'ffd8ffe000104a46',
    bodyType: 'Uint8Array',
    isBuffer: false,
    isUint8Array: true,
    isArrayBuffer: false,
    valid: true,
  }, {
    layer: 'bridge-core-output',
    contentType: 'image/jpeg',
    byteLength: 8,
    magic8: 'ffd8ffe000104a46',
    bodyType: 'Uint8Array',
    isBuffer: false,
    isUint8Array: true,
    isArrayBuffer: false,
    valid: true,
  }]);
});

test('Roon public library 使用有界 LRU，并在 Core Service 更换时隔离旧缓存', async () => {
  const calls = new Map<string, number>();
  const makeService = (suffix: string): RoonLibraryService => ({
    browseAlbums: async () => ({
      items: ['a', 'b', 'c'].map((key) => ({
        kind: 'album' as const,
        title: `${suffix}-${key}`,
        itemKey: `album:${suffix}:${key}`,
        imageKey: `image:${suffix}:${key}`,
      })),
      offset: 0,
      level: 0,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async () => ({ items: [], offset: 0, level: 1 }),
    browseArtist: async () => ({ items: [], offset: 0, level: 1 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async (imageKey) => {
      calls.set(imageKey, (calls.get(imageKey) ?? 0) + 1);
      return { contentType: 'image/jpeg', body: JPEG_BYTES };
    },
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  });
  let service = makeService('first');
  const publicLibrary = createRoonPublicLibrary(() => service, { maxImageCacheEntries: 2 });
  const firstPage = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const firstRefs = firstPage.items.map((item) => item.artworkReference ?? '');

  await publicLibrary.getImage(firstRefs[0]!, { width: 256, height: 256 });
  await publicLibrary.getImage(firstRefs[1]!, { width: 256, height: 256 });
  await publicLibrary.getImage(firstRefs[0]!, { width: 256, height: 256 });
  await publicLibrary.getImage(firstRefs[2]!, { width: 256, height: 256 });
  await publicLibrary.getImage(firstRefs[1]!, { width: 256, height: 256 });
  assert.equal(calls.get('image:first:a'), 1);
  assert.equal(calls.get('image:first:b'), 2);
  assert.equal(calls.get('image:first:c'), 1);

  service = makeService('replacement');
  const replacementPage = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const replacementReference = replacementPage.items[0]?.artworkReference ?? '';
  await publicLibrary.getImage(replacementReference, { width: 256, height: 256 });
  assert.equal(calls.get('image:replacement:a'), 1);
  await assert.rejects(publicLibrary.getImage(firstRefs[0]!, { width: 256, height: 256 }));
});

test('Roon public library 对图片失败使用短时 negative cache', async () => {
  let now = 1_000;
  let imageCalls = 0;
  const service: RoonLibraryService = {
    browseAlbums: async () => ({
      items: [{ kind: 'album', title: 'Missing Art', itemKey: 'album:missing', imageKey: 'image:missing' }],
      offset: 0,
      level: 0,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async () => ({ items: [], offset: 0, level: 1 }),
    browseArtist: async () => ({ items: [], offset: 0, level: 1 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => {
      imageCalls += 1;
      throw new Error('synthetic image failure');
    },
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  };
  const publicLibrary = createRoonPublicLibrary(() => service, {
    negativeImageTtlMs: 100,
    now: () => now,
  });
  const page = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const reference = page.items[0]?.artworkReference ?? '';

  await assert.rejects(publicLibrary.getImage(reference, { width: 256, height: 256 }));
  await assert.rejects(publicLibrary.getImage(reference, { width: 256, height: 256 }));
  assert.equal(imageCalls, 1);
  now += 101;
  await assert.rejects(publicLibrary.getImage(reference, { width: 256, height: 256 }));
  assert.equal(imageCalls, 2);
});

test('Roon public library 保留超过 4096 个仍可能可见的实体引用', async () => {
  let openedTitle: string | undefined;
  const service: RoonLibraryService = {
    browseAlbums: async ({ offset, limit }) => ({
      items: Array.from({ length: limit }, (_, index) => {
        const absoluteIndex = offset + index;
        return {
          kind: 'album' as const,
          title: `Album ${absoluteIndex}`,
          itemKey: `album:${absoluteIndex}`,
        };
      }),
      offset,
      level: 0,
      total: 4_100,
      hasMore: offset + limit < 4_100,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async (album) => {
      openedTitle = album.title;
      return { items: [], offset: 0, level: 1 };
    },
    browseArtist: async () => ({ items: [], offset: 0, level: 1 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  };
  const publicLibrary = createRoonPublicLibrary(() => service);
  let firstReference = '';
  for (let offset = 0; offset < 4_100; offset += 100) {
    const page = await publicLibrary.browseAlbums({ offset, limit: 100 });
    if (offset === 0) firstReference = page.items[0]?.reference ?? '';
  }

  await publicLibrary.browseAlbum(firstReference, { offset: 0, limit: 20 });
  assert.equal(openedTitle, 'Album 0');
});

test('Roon public library 在 Core Library Service 更换后立即作废旧 Context 引用', async () => {
  let replacementBrowseCalls = 0;
  const original: RoonLibraryService = {
    browseAlbums: async () => ({
      items: [{ kind: 'album', title: 'Old Album', itemKey: 'album:old' }],
      offset: 0,
      level: 0,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async () => ({ items: [], offset: 0, level: 1 }),
    browseArtist: async () => ({ items: [], offset: 0, level: 1 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  };
  const replacement: RoonLibraryService = {
    ...original,
    browseAlbum: async () => {
      replacementBrowseCalls += 1;
      return { items: [], offset: 0, level: 1 };
    },
  };
  let current = original;
  const publicLibrary = createRoonPublicLibrary(() => current);
  const page = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const oldReference = page.items[0]?.reference ?? '';
  current = replacement;

  await assert.rejects(
    publicLibrary.browseAlbum(oldReference, { offset: 0, limit: 20 }),
    (error: unknown) => error instanceof Error && 'code' in error
      && (error as { code?: unknown }).code === 'ROON_LIBRARY_INVALID_REFERENCE',
  );
  assert.equal(replacementBrowseCalls, 0);
});

test('Roon public library rejects stale album and image references before Core calls', async () => {
  let browseCalls = 0;
  const publicLibrary = createRoonPublicLibrary(() => ({
    browseAlbums: async () => {
      browseCalls += 1;
      return { items: [], offset: 0, level: 0 };
    },
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async () => ({ items: [], offset: 0, level: 0 }),
    browseArtist: async () => ({ items: [], offset: 0, level: 0 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  }));

  await assert.rejects(
    publicLibrary.browseAlbum('musicbridge-v2-entity-stale', { offset: 0, limit: 20 }),
    (error: unknown) => error instanceof Error && 'code' in error
      && (error as { code?: unknown }).code === 'ROON_LIBRARY_INVALID_REFERENCE',
  );
  await assert.rejects(
    publicLibrary.getImage('musicbridge-v2-image-stale'),
    (error: unknown) => error instanceof Error && 'code' in error
      && (error as { code?: unknown }).code === 'ROON_LIBRARY_INVALID_REFERENCE',
  );
  assert.equal(browseCalls, 0);
});

test('Roon public library resolves a Track reference for typed play and queue only', async () => {
  const actions: Array<{ kind: string; zone: string; itemKey: string }> = [];
  const service: RoonLibraryService = {
    browseAlbums: async () => ({
      items: [{ kind: 'album', title: 'Album', itemKey: 'album:1' }],
      offset: 0,
      level: 0,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenre: async () => ({ items: [], offset: 0, level: 1 }),
    browsePlaylist: async () => ({ items: [], offset: 0, level: 1 }),
    browseAlbum: async () => ({
      items: [{
        kind: 'track',
        title: 'Track',
        itemKey: 'track:1',
        imageKey: 'image:track-1',
        hint: 'list',
      }],
      offset: 0,
      level: 1,
    }),
    browseArtist: async () => ({ items: [], offset: 0, level: 0 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    playTrack: async (track, zone) => {
      actions.push({ kind: 'play', zone, itemKey: track.itemKey ?? '' });
    },
    queueTrack: async (track, zone) => {
      actions.push({ kind: 'queue', zone, itemKey: track.itemKey ?? '' });
    },
  };
  const publicLibrary = createRoonPublicLibrary(() => service);

  const albums = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  const tracks = await publicLibrary.browseAlbum(album.reference, { offset: 0, limit: 20 });
  const track = tracks.items[0];
  assert.ok(track);
  assert.ok(track.artworkReference);
  const summary = publicLibrary.getTrackSummary(track.reference);
  assert.deepEqual(summary, {
    id: roonTrackIdFromReference(track.reference),
    title: 'Track',
    artists: ['Roon Library'],
    album: 'Roon Library',
    artworkReference: track.artworkReference,
  });
  await publicLibrary.playTrack(track.reference, 'zone-1');
  await publicLibrary.queueTrack(track.reference, 'zone-1');
  assert.deepEqual(actions, [
    { kind: 'play', zone: 'zone-1', itemKey: 'track:1' },
    { kind: 'queue', zone: 'zone-1', itemKey: 'track:1' },
  ]);
});

test('Roon public library exposes typed artist, genre, playlist and search pages', async () => {
  const service: RoonLibraryService = {
    browseAlbums: async () => ({ items: [], offset: 0, level: 0 }),
    browseArtists: async () => ({
      items: [{ kind: 'artist', title: 'Artist', itemKey: 'artist:1' }],
      offset: 0,
      level: 0,
    }),
    browseGenres: async () => ({
      items: [{ kind: 'genre', title: 'Genre', itemKey: 'genre:1' }],
      offset: 0,
      level: 0,
    }),
    browsePlaylists: async () => ({
      items: [{ kind: 'playlist', title: 'Playlist', itemKey: 'playlist:1' }],
      offset: 0,
      level: 0,
    }),
    browseGenre: async () => ({
      items: [{ kind: 'album', title: 'Genre Album', itemKey: 'album:genre-1' }],
      offset: 0,
      level: 1,
    }),
    browsePlaylist: async () => ({
      items: [{ kind: 'track', title: 'Playlist Track', itemKey: 'track:playlist-1' }],
      offset: 0,
      level: 1,
    }),
    browseAlbum: async () => ({ items: [], offset: 0, level: 0 }),
    browseArtist: async () => ({
      items: [{ kind: 'album', title: 'Artist Album', itemKey: 'album:artist-1' }],
      offset: 0,
      level: 0,
    }),
    searchLibrary: async () => ({
      items: [{ kind: 'track', title: 'Search Track', itemKey: 'track:search-1' }],
      offset: 0,
      level: 0,
    }),
    getImage: async () => ({ contentType: 'image/jpeg', body: JPEG_BYTES }),
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  };
  const publicLibrary = createRoonPublicLibrary(() => service);

  const artists = await publicLibrary.browseArtists({ offset: 0, limit: 20 });
  const genres = await publicLibrary.browseGenres({ offset: 0, limit: 20 });
  const playlists = await publicLibrary.browsePlaylists({ offset: 0, limit: 20 });
  const artist = artists.items[0];
  const genre = genres.items[0];
  const playlist = playlists.items[0];
  assert.ok(artist);
  assert.ok(genre);
  assert.ok(playlist);
  const artistAlbums = await publicLibrary.browseArtist(artist.reference, { offset: 0, limit: 20 });
  const genreItems = await publicLibrary.browseGenre(genre.reference, { offset: 0, limit: 20 });
  const playlistTracks = await publicLibrary.browsePlaylist(playlist.reference, { offset: 0, limit: 20 });
  const search = await publicLibrary.searchLibrary('search', { offset: 0, limit: 20 });

  assert.deepEqual(
    [genres.items[0]?.kind, playlists.items[0]?.kind, artistAlbums.items[0]?.kind, search.items[0]?.kind],
    ['genre', 'playlist', 'album', 'track'],
  );
  assert.match(artistAlbums.items[0]?.reference ?? '', /^musicbridge-v2-entity-/u);
  assert.equal(genreItems.items[0]?.kind, 'album');
  assert.equal(playlistTracks.items[0]?.kind, 'track');
  assert.match(search.items[0]?.reference ?? '', /^musicbridge-v2-entity-/u);
});
