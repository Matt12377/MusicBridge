import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

type RequestOptions = Record<string, unknown>
type RequestFunction = (
  endpoint: string,
  data: Record<string, unknown>,
  options: RequestOptions,
) => Promise<unknown>
type ProviderWrapper = (
  query: Record<string, unknown>,
  request: RequestFunction,
) => Promise<unknown> | unknown

interface RequestCall {
  endpoint: string
  data: Record<string, unknown>
  options: RequestOptions
}

const require = createRequire(import.meta.url)
const apiMain = require.resolve('@neteasecloudmusicapienhanced/api/main.js')
const apiRoot = path.dirname(apiMain)

function loadWrapper(name: string): ProviderWrapper {
  return require(path.join(apiRoot, 'module', `${name}.js`)) as ProviderWrapper
}

function fakeRequest(responses: readonly unknown[]): {
  request: RequestFunction
  calls: RequestCall[]
} {
  const calls: RequestCall[] = []
  let responseIndex = 0
  const request: RequestFunction = async (endpoint, data, options) => {
    calls.push({ endpoint, data, options })
    const response = responses[responseIndex]
    responseIndex += 1
    return response
  }
  return { request, calls }
}

test('loads the pinned NetEase API wrapper package', () => {
  const packageJson = require(path.join(apiRoot, 'package.json')) as { version?: unknown }
  assert.equal(packageJson.version, '4.40.1')
})

test('login status wrapper exposes the real nested success shape', async () => {
  const response = {
    body: { code: 200, profile: { userId: 1 }, account: { id: 1 } },
    cookie: [],
  }
  const { request, calls } = fakeRequest([response])

  const actual = await loadWrapper('login_status')(
    { cookie: { fixture: 'credential' } },
    request,
  )

  assert.deepEqual(actual, {
    status: 200,
    body: {
      data: { code: 200, profile: { userId: 1 }, account: { id: 1 } },
    },
    cookie: [],
  })
  assert.equal(calls[0]?.endpoint, '/api/w/nuser/account/get')
})

test('QR key, create and check wrappers preserve their public response fields', async () => {
  const keyCall = fakeRequest([{ body: { unikey: 'fixture-key' }, cookie: [] }])
  const keyResult = await loadWrapper('login_qr_key')(
    { cookie: { fixture: 'credential' } },
    keyCall.request,
  )
  assert.deepEqual(keyResult, {
    status: 200,
    body: { data: { unikey: 'fixture-key' }, code: 200 },
    cookie: [],
  })
  assert.equal(keyCall.calls[0]?.endpoint, '/api/login/qrcode/unikey')

  const createResult = (await loadWrapper('login_qr_create')({ key: 'fixture-key', qrimg: false }, keyCall.request)) as {
    status: number
    body: { code: number; data: { qrurl: string; qrimg: string } }
  }
  assert.equal(createResult.status, 200)
  assert.equal(createResult.body.code, 200)
  assert.equal(new URL(createResult.body.data.qrurl).searchParams.get('codekey'), 'fixture-key')
  assert.equal(createResult.body.data.qrimg, '')

  const checkCall = fakeRequest([{ body: { code: 803 }, cookie: [] }])
  const checkResult = await loadWrapper('login_qr_check')(
    { key: 'fixture-key' },
    checkCall.request,
  )
  assert.deepEqual(checkResult, {
    status: 200,
    body: { code: 803, cookie: '' },
    cookie: [],
  })
  assert.equal(checkCall.calls[0]?.endpoint, '/api/login/qrcode/client/login')
})

test('search wrapper sends bounded search parameters to the real endpoint', async () => {
  const response = { body: { code: 200, result: { songCount: 0, songs: [] } } }
  const { request, calls } = fakeRequest([response])

  const actual = await loadWrapper('search')(
    { keywords: 'fixture query', type: 1, offset: 40, limit: 20, cookie: { fixture: 'credential' } },
    request,
  )

  assert.deepEqual(actual, response)
  assert.equal(calls[0]?.endpoint, '/api/search/get')
  assert.deepEqual(calls[0]?.data, {
    s: 'fixture query',
    type: 1,
    limit: 20,
    offset: 40,
  })
  assert.deepEqual(calls[0]?.options.cookie, { fixture: 'credential' })
})

test('liked and account wrappers use the expected account endpoints', async () => {
  const accountCall = fakeRequest([{ body: { code: 200, account: { id: 1 } } }])
  const accountResult = await loadWrapper('user_account')(
    { cookie: { fixture: 'credential' } },
    accountCall.request,
  )
  assert.deepEqual(accountResult, { body: { code: 200, account: { id: 1 } } })
  assert.equal(accountCall.calls[0]?.endpoint, '/api/nuser/account/get')

  const likedCall = fakeRequest([{ body: { code: 200, ids: [101, 102] } }])
  const likedResult = await loadWrapper('likelist')(
    { uid: 1, cookie: { fixture: 'credential' } },
    likedCall.request,
  )
  assert.deepEqual(likedResult, { body: { code: 200, ids: [101, 102] } })
  assert.equal(likedCall.calls[0]?.endpoint, '/api/song/like/get')
  assert.deepEqual(likedCall.calls[0]?.data, { uid: 1 })
})

test('daily recommendation wrapper stays pinned to recommend_songs and never refreshes or dislikes', async () => {
  const response = {
    body: { code: 200, dailySongs: [], recommendReasons: [] },
    cookie: [],
  }
  const { request, calls } = fakeRequest([response])
  const actual = await loadWrapper('recommend_songs')(
    { cookie: { fixture: 'credential' }, afresh: false },
    request,
  )
  assert.deepEqual(actual, response)
  assert.equal(calls[0]?.endpoint, '/api/v3/discovery/recommend/songs')
  assert.deepEqual(calls[0]?.data, { afresh: false })
  assert.equal(calls[0]?.options.crypto, 'weapi')
  assert.equal(calls.some((call) => call.endpoint.includes('dislike')), false)
})

test('playlist list, detail and track wrappers compose the pinned API calls', async () => {
  const listCall = fakeRequest([{ body: { code: 200, playlist: [], playlistCount: 0, more: false } }])
  const listResult = await loadWrapper('user_playlist')(
    { uid: 1, offset: 0, limit: 20, cookie: { fixture: 'credential' } },
    listCall.request,
  )
  assert.deepEqual(listResult, { body: { code: 200, playlist: [], playlistCount: 0, more: false } })
  assert.equal(listCall.calls[0]?.endpoint, '/api/user/playlist')

  const detailCall = fakeRequest([{ body: { code: 200, playlist: { id: 301 } } }])
  const detailResult = await loadWrapper('playlist_detail')(
    { id: '301', cookie: { fixture: 'credential' } },
    detailCall.request,
  )
  assert.deepEqual(detailResult, { body: { code: 200, playlist: { id: 301 } } })
  assert.equal(detailCall.calls[0]?.endpoint, '/api/v6/playlist/detail')

  const tracksCall = fakeRequest([
    { body: { playlist: { trackIds: [{ id: 101 }, { id: 102 }, { id: 103 }] } } },
    { body: { code: 200, songs: [] } },
  ])
  const tracksResult = await loadWrapper('playlist_track_all')(
    { id: '301', offset: 1, limit: 1, cookie: { fixture: 'credential' } },
    tracksCall.request,
  )
  assert.deepEqual(tracksResult, { body: { code: 200, songs: [] } })
  assert.deepEqual(
    tracksCall.calls.map((call) => call.endpoint),
    ['/api/v6/playlist/detail', '/api/v3/song/detail'],
  )
  assert.equal(tracksCall.calls[1]?.data.c, '[{"id":102}]')
})

test('song detail and lossless URL wrappers preserve request policy', async () => {
  const detailCall = fakeRequest([{ body: { code: 200, songs: [] } }])
  const detailResult = await loadWrapper('song_detail')(
    { ids: '101, 102', cookie: { fixture: 'credential' } },
    detailCall.request,
  )
  assert.deepEqual(detailResult, { body: { code: 200, songs: [] } })
  assert.equal(detailCall.calls[0]?.endpoint, '/api/v3/song/detail')
  assert.equal(detailCall.calls[0]?.options.crypto, 'weapi')
  assert.equal(detailCall.calls[0]?.data.c, '[{"id":101},{"id":102}]')

  const urlCall = fakeRequest([{ body: { code: 200, data: [] } }])
  const urlResult = await loadWrapper('song_url_v1')(
    { id: '101', level: 'lossless', cookie: { fixture: 'credential' } },
    urlCall.request,
  )
  assert.deepEqual(urlResult, { body: { code: 200, data: [] } })
  assert.equal(urlCall.calls[0]?.endpoint, '/api/song/enhance/player/url/v1')
  assert.equal(urlCall.calls[0]?.options.crypto, 'xeapi')
  assert.deepEqual(urlCall.calls[0]?.data, {
    ids: '[101]',
    level: 'lossless',
    encodeType: 'flac',
  })
})

test('lyric_new wrapper uses the pinned lyric endpoint and bounded request fields', async () => {
  const response = { body: { code: 200, lrc: { lyric: '' } } }
  const { request, calls } = fakeRequest([response])
  const actual = await loadWrapper('lyric_new')(
    { id: '101', cookie: { fixture: 'credential' } },
    request,
  )

  assert.deepEqual(actual, response)
  assert.equal(calls[0]?.endpoint, '/api/song/lyric/v1')
  assert.deepEqual(calls[0]?.data, {
    id: '101',
    cp: false,
    tv: 0,
    lv: 0,
    rv: 0,
    kv: 0,
    yv: 0,
    ytv: 0,
    yrv: 0,
  })
})
