import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoonLibraryService } from '../src/roon/library.js';
import { createRoonPublicLibrary } from '../src/roon/public-library.js';

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
      get_image: (_key, _options, callback) => callback(false, 'image/jpeg', Buffer.from('cover')),
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
  assert.deepEqual(image.body, new Uint8Array(Buffer.from('cover')));
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
    browseAlbum: async () => ({ items: [], offset: 0, level: 0 }),
    browseArtist: async () => ({ items: [], offset: 0, level: 0 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => ({ contentType: 'image/jpeg', body: Buffer.from('') }),
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
  const publicLibrary = createRoonPublicLibrary(() => ({
    browseAlbums: async () => ({
      items: [{ kind: 'album', title: 'Album', itemKey: 'album:1' }],
      offset: 0,
      level: 0,
    }),
    browseArtists: async () => ({ items: [], offset: 0, level: 0 }),
    browseGenres: async () => ({ items: [], offset: 0, level: 0 }),
    browsePlaylists: async () => ({ items: [], offset: 0, level: 0 }),
    browseAlbum: async () => ({
      items: [{ kind: 'track', title: 'Track', itemKey: 'track:1', hint: 'list' }],
      offset: 0,
      level: 1,
    }),
    browseArtist: async () => ({ items: [], offset: 0, level: 0 }),
    searchLibrary: async () => ({ items: [], offset: 0, level: 0 }),
    getImage: async () => ({ contentType: 'image/jpeg', body: Buffer.from('') }),
    playTrack: async (track, zone) => {
      actions.push({ kind: 'play', zone, itemKey: track.itemKey ?? '' });
    },
    queueTrack: async (track, zone) => {
      actions.push({ kind: 'queue', zone, itemKey: track.itemKey ?? '' });
    },
  }));

  const albums = await publicLibrary.browseAlbums({ offset: 0, limit: 20 });
  const album = albums.items[0];
  assert.ok(album);
  const tracks = await publicLibrary.browseAlbum(album.reference, { offset: 0, limit: 20 });
  const track = tracks.items[0];
  assert.ok(track);
  await publicLibrary.playTrack(track.reference, 'zone-1');
  await publicLibrary.queueTrack(track.reference, 'zone-1');
  assert.deepEqual(actions, [
    { kind: 'play', zone: 'zone-1', itemKey: 'track:1' },
    { kind: 'queue', zone: 'zone-1', itemKey: 'track:1' },
  ]);
});

test('Roon public library exposes typed artist, genre, playlist and search pages', async () => {
  const publicLibrary = createRoonPublicLibrary(() => ({
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
    getImage: async () => ({ contentType: 'image/jpeg', body: Buffer.from('') }),
    playTrack: async () => undefined,
    queueTrack: async () => undefined,
  }));

  const artists = await publicLibrary.browseArtists({ offset: 0, limit: 20 });
  const genres = await publicLibrary.browseGenres({ offset: 0, limit: 20 });
  const playlists = await publicLibrary.browsePlaylists({ offset: 0, limit: 20 });
  const artist = artists.items[0];
  assert.ok(artist);
  const artistAlbums = await publicLibrary.browseArtist(artist.reference, { offset: 0, limit: 20 });
  const search = await publicLibrary.searchLibrary('search', { offset: 0, limit: 20 });

  assert.deepEqual(
    [genres.items[0]?.kind, playlists.items[0]?.kind, artistAlbums.items[0]?.kind, search.items[0]?.kind],
    ['genre', 'playlist', 'album', 'track'],
  );
  assert.match(artistAlbums.items[0]?.reference ?? '', /^musicbridge-v2-entity-/u);
  assert.match(search.items[0]?.reference ?? '', /^musicbridge-v2-entity-/u);
});
