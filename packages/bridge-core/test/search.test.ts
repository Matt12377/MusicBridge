import assert from 'node:assert/strict'
import test from 'node:test'
import { NeteaseClient } from '../src/netease/client.js'
import { parseAlbumDetail, parseAlbumSearchPage, parseArtistDetail, parseArtistSearchPage } from '../src/netease/parse.js'

const page = { offset: 0, limit: 10 }

test('search parsers expose bounded ArtistSummary and AlbumSummary contracts', () => {
  assert.deepEqual(
    parseArtistSearchPage({
      body: {
        code: 200,
        result: {
          artistCount: 1,
          artists: [{ id: 7, name: '周杰伦', picUrl: 'http://p1.music.126.net/artist.jpg', albumSize: 18, musicSize: 120 }],
        },
      },
    }, page),
    {
      items: [{ id: '7', name: '周杰伦', artworkUrl: 'https://p1.music.126.net/artist.jpg', albumCount: 18, trackCount: 120 }],
      offset: 0,
      limit: 10,
      total: 1,
      hasMore: false,
    },
  )
  assert.deepEqual(
    parseAlbumSearchPage({
      body: {
        code: 200,
        result: {
          albumCount: 1,
          albums: [{ id: 9, name: '范特西', artist: { id: 7, name: '周杰伦' }, picUrl: 'http://p1.music.126.net/album.jpg', size: 10 }],
        },
      },
    }, page),
    {
      items: [{ id: '9', name: '范特西', artistId: '7', artistName: '周杰伦', artworkUrl: 'https://p1.music.126.net/album.jpg', trackCount: 10 }],
      offset: 0,
      limit: 10,
      total: 1,
      hasMore: false,
    },
  )
})

test('NeteaseClient routes Artist and Album search through official search types', async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = new NeteaseClient('synthetic-cookie', {
    async search(params: { type: number; keywords: string }) {
      calls.push(params)
      return { body: { code: 200, result: params.type === 100 ? { artistCount: 0, artists: [] } : { albumCount: 0, albums: [] } } }
    },
  } as never)

  await client.searchArtists('周杰伦', page)
  await client.searchAlbums('周杰伦', page)
  assert.deepEqual(calls.map((call) => call.type), [100, 10])
  assert.deepEqual(calls.map((call) => call.keywords), ['周杰伦', '周杰伦'])
})

test('configured consecutive searches keep the account credential out of the public search endpoint', async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = new NeteaseClient('MUSIC_U=synthetic-sensitive-credential', {
    async search(params: Record<string, unknown>) {
      calls.push(params)
      if (Object.hasOwn(params, 'cookie')) {
        throw Object.assign(new Error('synthetic authenticated search rejected'), {
          status: 405,
          body: { code: 405 },
        })
      }
      const type = params.type
      return {
        body: {
          code: 200,
          result: type === 100
            ? { artistCount: 0, artists: [] }
            : type === 10
              ? { albumCount: 0, albums: [] }
              : { songCount: 0, songs: [] },
        },
      }
    },
  } as never)

  for (const query of ['1', '周杰伦']) {
    await Promise.all([
      client.searchArtists(query, page),
      client.searchTracks(query, page),
      client.searchAlbums(query, page),
    ])
  }

  assert.equal(calls.length, 6)
  assert.deepEqual(calls.map((call) => call.type), [100, 1, 10, 100, 1, 10])
  assert.ok(calls.every((call) => !Object.hasOwn(call, 'cookie')))
})

test('detail parsers keep provider songs behind bounded Artist and Album detail contracts', async () => {
  const artist = parseArtistDetail({ body: { code: 200, data: { artist: { id: 7, name: '周杰伦', albumSize: 2 }, hotSongs: [{ id: 1, name: '青花瓷', ar: [{ name: '周杰伦' }], al: { name: '我很忙', picUrl: 'http://p1.music.126.net/a.jpg' } }] } } }, page)
  const album = parseAlbumDetail({ body: { code: 200, album: { id: 9, name: '范特西', artist: { id: 7, name: '周杰伦' }, picUrl: 'http://p1.music.126.net/b.jpg', size: 1 }, songs: [{ id: 2, name: '爱在西元前', ar: [{ name: '周杰伦' }], al: { name: '范特西', picUrl: 'http://p1.music.126.net/b.jpg' } }] } }, page)
  assert.equal(artist.id, '7')
  assert.equal(artist.tracks.items[0]?.title, '青花瓷')
  assert.equal(album.id, '9')
  assert.equal(album.tracks.items[0]?.album, '范特西')
})
