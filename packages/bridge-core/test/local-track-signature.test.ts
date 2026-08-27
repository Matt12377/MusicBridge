import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalTrackSignature } from '../src/lyrics-matching/signature.js'

const base = {
  title: '归零',
  artists: ['林忆莲', '常石磊'],
  album: '０（２０２４版）',
  durationMs: 271_240,
  version: 'Original',
}

test('LocalTrackSignature ignores Roon runtime identity and keeps only canonical fields', () => {
  const first = createLocalTrackSignature({ ...base, runtimeReference: 'runtime-a', item_key: 'secret-a' } as typeof base)
  const second = createLocalTrackSignature({ ...base, runtimeReference: 'runtime-b', mediaPath: '/music/a.flac' } as typeof base)

  assert.equal(first.key, second.key)
  assert.deepEqual(Object.keys(first.canonical), ['title', 'artists', 'album', 'durationMs', 'version'])
  assert.doesNotMatch(JSON.stringify(first), /runtime|item_key|path|lyrics|flac/iu)
  assert.match(first.key, /^[0-9a-f]{32}$/u)
})

test('LocalTrackSignature normalizes artist order, duplicates and subsecond duration drift', () => {
  const first = createLocalTrackSignature(base)
  const second = createLocalTrackSignature({
    ...base,
    artists: [' 常石磊 ', '林忆莲', '林忆莲'],
    durationMs: 271_410,
  })

  assert.equal(first.key, second.key)
  assert.deepEqual(first.canonical.artists, ['常石磊', '林忆莲'])
  assert.equal(first.canonical.durationMs, 271_000)
})

test('LocalTrackSignature normalizes NFKC, case, finite punctuation and whitespace', () => {
  const first = createLocalTrackSignature({ title: 'ＡＢＣ - Song', artists: ['Artist'], album: 'Album' })
  const second = createLocalTrackSignature({ title: ' abc  song ', artists: ['artist'], album: 'album' })
  assert.equal(first.key, second.key)
})

test('LocalTrackSignature changes for version, artist and significant duration changes', () => {
  const original = createLocalTrackSignature(base).key
  assert.notEqual(createLocalTrackSignature({ ...base, version: 'Live' }).key, original)
  assert.notEqual(createLocalTrackSignature({ ...base, artists: ['张学友'] }).key, original)
  assert.notEqual(createLocalTrackSignature({ ...base, durationMs: 273_000 }).key, original)
})

test('LocalTrackSignature requires bounded title and artists', () => {
  assert.throws(() => createLocalTrackSignature({ title: '', artists: ['Artist'] }), /title/iu)
  assert.throws(() => createLocalTrackSignature({ title: 'Song', artists: [] }), /artist/iu)
  assert.throws(() => createLocalTrackSignature({ title: 'x'.repeat(513), artists: ['Artist'] }), /title/iu)
})
