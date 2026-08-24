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
