import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createLocalFavoriteRepository,
  type FavoriteEntityDescriptor,
} from '../src/favorites/repository.js';

const track: FavoriteEntityDescriptor = {
  kind: 'track',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  durationMs: 180_000,
};

const album: FavoriteEntityDescriptor = {
  kind: 'album',
  title: 'Album',
  artist: 'Artist',
  year: 2024,
};

test('LocalFavoriteRepository keeps Track, Album and Artist relationships independent', async () => {
  const repository = createLocalFavoriteRepository(undefined, () => 1_000);

  assert.equal(await repository.isFavorite(track), false);
  await repository.setFavorite(track, true);
  await repository.setFavorite(album, true);
  assert.equal(await repository.isFavorite(track), true);
  assert.equal(await repository.isFavorite(album), true);

  const tracks = await repository.listFavorites('track', { offset: 0, limit: 20 });
  const albums = await repository.listFavorites('album', { offset: 0, limit: 20 });
  assert.equal(tracks.items.length, 1);
  assert.equal(albums.items.length, 1);
  assert.equal(tracks.items[0]?.title, 'Track');
  assert.equal(albums.items[0]?.title, 'Album');

  await repository.setFavorite(track, false);
  assert.equal(await repository.isFavorite(track), false);
  assert.equal((await repository.listFavorites('album', { offset: 0, limit: 20 })).items.length, 1);
});

test('LocalFavoriteRepository persists bounded descriptors without item keys or media paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-favorites-'));
  const filePath = path.join(directory, 'favorites.json');
  const repository = createLocalFavoriteRepository(filePath, () => 2_000);
  await repository.setFavorite(track, true);

  const restored = createLocalFavoriteRepository(filePath, () => 3_000);
  const page = await restored.listFavorites(undefined, { offset: 0, limit: 20 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.title, 'Track');
  const serialized = await readFile(filePath, 'utf8');
  assert.doesNotMatch(serialized, /item_key|media|path|file/i);
  assert.match(serialized, /"kind":"track"/u);
});

test('LocalFavoriteRepository refuses a corrupt persisted file instead of replacing it as an empty library', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-favorites-corrupt-'));
  const filePath = path.join(directory, 'favorites.json');
  await writeFile(filePath, '{not-json', 'utf8');
  const repository = createLocalFavoriteRepository(filePath);

  await assert.rejects(
    repository.listFavorites(undefined, { offset: 0, limit: 20 }),
    /Local favorites file is invalid/u,
  );
  await assert.rejects(
    repository.setFavorite(track, true),
    /Local favorites file is invalid/u,
  );
  assert.equal(await readFile(filePath, 'utf8'), '{not-json');
});

test('LocalFavoriteRepository rolls back memory when an atomic persist fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-favorites-rollback-'));
  const filePath = path.join(directory, 'favorites.json');
  const repository = createLocalFavoriteRepository(filePath, () => {
    mkdirSync(filePath);
    return 4_000;
  });

  await assert.rejects(repository.setFavorite(track, true));
  assert.equal(await repository.isFavorite(track), false);
  assert.equal((await repository.listFavorites('track', { offset: 0, limit: 20 })).items.length, 0);
  assert.deepEqual(await readdir(directory), ['favorites.json']);
});
