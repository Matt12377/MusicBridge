import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_LYRICS_COMMANDS, LOCAL_LYRICS_LIMITS, isLocalLyricsCommandPayload, isLocalLyricsCandidateDetail, isLocalLyricsSafeText } from '../src/local-library-lyrics.js'

const scope = { datasetId: 'dataset', libraryId: 'library', albumId: 'album', captureId: 'capture' }
const library = { datasetId: 'dataset', libraryId: 'library', captureId: 'capture' }
test('歌词公开十六命令保持精确身份与原回执请求闭集', () => {
  const payloads = [ { scope }, { sessionId: 'session' }, { sessionId: 'session', candidateId: 'candidate' }, { sessionId: 'session', trackId: 'track', candidateId: null }, { sessionId: 'session' }, { sessionId: 'session' }, { sessionId: 'session', commandId: 'command', embed: true }, ...Array.from({ length: 3 }, () => ({ sessionId: 'session', commandId: 'command' })), { commandId: 'job', library, embed: false }, ...Array.from({ length: 3 }, () => ({ jobId: 'job' })), { jobId: 'job', albumIds: ['album'] }, { library, filter: 'missingLyrics', offset: 0, limit: 200 } ]
  assert.equal(LOCAL_LYRICS_COMMANDS.length, 16)
  LOCAL_LYRICS_COMMANDS.forEach((c, i) => { assert.equal(isLocalLyricsCommandPayload(c, payloads[i]), true, c); assert.equal(isLocalLyricsCommandPayload(c, { ...payloads[i], url: 'https://private.invalid' }), false, c) })
})
test('歌词合同拒绝getter与错误dataset以及路径凭据身份', () => {
  let reads = 0
  const getter = Object.defineProperty({}, 'scope', { get() { reads++; return scope }, enumerable: true })
  assert.equal(isLocalLyricsCommandPayload('localLyrics.query', getter), false); assert.equal(reads, 0)
  for (const datasetId of ['', '/Users/private', 'https://provider.invalid', 'token=secret']) assert.equal(isLocalLyricsCommandPayload('localLyrics.query', { scope: { ...scope, datasetId } }), false)
  assert.equal(isLocalLyricsCommandPayload('localLyrics.query', { scope: { ...scope, extra: 'grant' } }), false)
})
test('歌词正文按UTF8字节限额且源URL凭据不进入Renderer', () => {
  const candidate = { candidateId: 'candidate', trackId: 'track', source: 'lrclib', title: '歌曲', artist: '艺人', album: '专辑', durationMs: 1000, language: 'zh', version: 'original', score: 100 }
  assert.equal(isLocalLyricsCandidateDetail({ candidate, body: '[00:01.00]歌词' }), true)
  assert.equal(isLocalLyricsCandidateDetail({ candidate, body: '字'.repeat(LOCAL_LYRICS_LIMITS.bodyBytes) }), false)
  for (const body of ['https://upstream.invalid/key', 'Authorization: Bearer private', '\u0000bad', 'access_token=private']) assert.equal(isLocalLyricsCandidateDetail({ candidate, body }), false)
  assert.equal(isLocalLyricsCandidateDetail({ candidate: { ...candidate, endpoint: 'private' }, body: '歌词' }), false)
  assert.equal(isLocalLyricsSafeText('[01:02.30]合法\n下一行', 1024, true), true)
})
test('歌词库存第九筛选不把unknown当missing并保原分页限额', () => {
  assert.equal(isLocalLyricsCommandPayload('localLyrics.inventory', { library, filter: 'missingLyrics', offset: 200, limit: 200 }), true)
  for (const limit of [0, 201, 1.5]) assert.equal(isLocalLyricsCommandPayload('localLyrics.inventory', { library, filter: 'all', offset: 0, limit }), false)
  assert.equal(isLocalLyricsCommandPayload('localLyrics.inventory', { library, filter: 'missing', offset: 0, limit: 1 }), false)
  assert.equal(isLocalLyricsCommandPayload('localLyrics.job.retry', { jobId: 'job', albumIds: ['a', 'a'] }), false)
})


test('UI04原entry：仅job.read接受单专辑定位，三字段引用闭集保持原十六命令', async () => {
  const { isLocalLyricsJobOriginalEntry } = await import('../src/local-library-lyrics.js')
  assert.equal(LOCAL_LYRICS_COMMANDS.length, 16)
  assert.equal(isLocalLyricsCommandPayload('localLyrics.job.read', { jobId: 'job' }), true)
  assert.equal(isLocalLyricsCommandPayload('localLyrics.job.read', { jobId: 'job', albumId: 'album' }), true)
  for (const command of ['localLyrics.job.stop', 'localLyrics.job.resume'] as const) assert.equal(isLocalLyricsCommandPayload(command, { jobId: 'job', albumId: 'album' }), false)
  for (const payload of [{ jobId: 'job', albumId: undefined }, { jobId: 'job', albumId: null }, { jobId: 'job', albumId: '' }, { jobId: 'job', albumIds: ['album'] }, { jobId: 'job', albumId: 'album', grant: true }]) assert.equal(isLocalLyricsCommandPayload('localLyrics.job.read', payload), false)
  let reads = 0
  assert.equal(isLocalLyricsCommandPayload('localLyrics.job.read', Object.defineProperty({ jobId: 'job' }, 'albumId', { enumerable: true, get() { reads++; return 'album' } })), false)
  const entry = { scope, sessionId: 'session', saveRequest: { sessionId: 'session', commandId: 'original-save', embed: true } }
  assert.equal(isLocalLyricsJobOriginalEntry(entry), true)
  assert.equal(isLocalLyricsJobOriginalEntry({ scope, sessionId: null, saveRequest: null }), true)
  for (const value of [ { ...entry, saveRequest: { ...entry.saveRequest, sessionId: 'other-session' } }, { ...entry, sessionId: null }, { ...entry, path: '/private/source' }, { ...entry, saveRequest: { ...entry.saveRequest, captureId: 'new-capture' } }, { ...entry, scope: { ...scope, sourceRootId: 'root' } }, { ...entry, scope: { ...scope, libraryId: 'file:///private/source' } } ]) assert.equal(isLocalLyricsJobOriginalEntry(value), false)
  assert.equal(isLocalLyricsJobOriginalEntry(Object.defineProperty({ scope, sessionId: 'session' }, 'saveRequest', { enumerable: true, get() { reads++; return entry.saveRequest } })), false)
  assert.equal(reads, 0)
})
