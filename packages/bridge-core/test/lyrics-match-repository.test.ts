import assert from 'node:assert/strict'
import { mkdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAX_LYRICS_MATCH_RECORDS,
  createLyricsMatchRepository,
} from '../src/lyrics-matching/repository.js'
import { createLocalTrackSignature } from '../src/lyrics-matching/signature.js'

const signature = createLocalTrackSignature({
  title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000,
})

test('LyricsMatchRepository persists only positive numeric NetEase mappings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-lyrics-repo-'))
  const filePath = path.join(directory, 'data', 'lyrics-match.json')
  const repository = createLyricsMatchRepository({ filePath, now: () => 1_000 })
  await repository.set({ signature, neteaseTrackId: '123456', source: 'CONFIRMED', algorithmVersion: 'lyrics-match-v1' })

  assert.equal((await repository.get(signature.key, 'lyrics-match-v1'))?.neteaseTrackId, '123456')
  await assert.rejects(repository.set({ signature, neteaseTrackId: '12x', source: 'CONFIRMED', algorithmVersion: 'lyrics-match-v1' }), /track id/iu)
  await assert.rejects(repository.set({ signature, neteaseTrackId: '123', source: 'POSSIBLE' as 'CONFIRMED', algorithmVersion: 'lyrics-match-v1' }), /source/iu)
  const serialized = await readFile(filePath, 'utf8')
  assert.doesNotMatch(serialized, /item_key|runtime|mediaPath|"lyrics"\s*:/iu)
})

test('LyricsMatchRepository invalidates old automatic records but preserves MANUAL records', async () => {
  const repository = createLyricsMatchRepository({ now: () => 2_000 })
  await repository.set({ signature, neteaseTrackId: '101', source: 'CONFIRMED', algorithmVersion: 'v1' })
  assert.equal(await repository.get(signature.key, 'v2'), undefined)
  await repository.set({ signature, neteaseTrackId: '102', source: 'MANUAL', algorithmVersion: 'v1' })
  assert.equal((await repository.get(signature.key, 'v2'))?.neteaseTrackId, '102')
})

test('LyricsMatchRepository applies deterministic LRU eviction and bounded listing', async () => {
  let now = 10
  const repository = createLyricsMatchRepository({ now: () => now++, maxEntries: 2 })
  const a = createLocalTrackSignature({ title: 'A', artists: ['Artist'] })
  const b = createLocalTrackSignature({ title: 'B', artists: ['Artist'] })
  const c = createLocalTrackSignature({ title: 'C', artists: ['Artist'] })
  for (const item of [a, b]) await repository.set({ signature: item, neteaseTrackId: '1', source: 'MANUAL', algorithmVersion: 'v1' })
  await repository.touch(a.key)
  await repository.set({ signature: c, neteaseTrackId: '3', source: 'MANUAL', algorithmVersion: 'v1' })

  assert.equal(await repository.get(b.key, 'v1'), undefined)
  assert.deepEqual((await repository.listBounded(0, 10)).map((record) => record.signature.key), [c.key, a.key])
  assert.equal(MAX_LYRICS_MATCH_RECORDS, 4_096)
})

test('LyricsMatchRepository serializes concurrent mutations', async () => {
  let now = 100
  const repository = createLyricsMatchRepository({ now: () => now++ })
  await Promise.all(Array.from({ length: 20 }, (_, index) => repository.set({
    signature: createLocalTrackSignature({ title: `Song ${index}`, artists: ['Artist'] }),
    neteaseTrackId: String(index + 1), source: 'CONFIRMED', algorithmVersion: 'v1',
  })))
  assert.equal((await repository.listBounded(0, 100)).length, 20)
})

test('LyricsMatchRepository creates atomic 0700/0600 storage without temporary residue', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-lyrics-mode-'))
  const dataDirectory = path.join(directory, 'private-data')
  const filePath = path.join(dataDirectory, 'matches.json')
  const repository = createLyricsMatchRepository({ filePath, now: () => 3_000 })
  await repository.set({ signature, neteaseTrackId: '123', source: 'MANUAL', algorithmVersion: 'v1' })

  assert.equal(statSync(dataDirectory).mode & 0o777, 0o700)
  assert.equal(statSync(filePath).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dataDirectory), ['matches.json'])
})

test('LyricsMatchRepository rolls memory back when atomic persistence fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-lyrics-rollback-'))
  const filePath = path.join(directory, 'matches.json')
  const repository = createLyricsMatchRepository({ filePath, now: () => {
    mkdirSync(filePath)
    return 4_000
  } })
  await assert.rejects(repository.set({ signature, neteaseTrackId: '123', source: 'MANUAL', algorithmVersion: 'v1' }))
  assert.equal(await repository.get(signature.key, 'v1'), undefined)
})

test('LyricsMatchRepository refuses corrupt storage and never overwrites it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-lyrics-corrupt-'))
  const filePath = path.join(directory, 'matches.json')
  await writeFile(filePath, '{broken-json', 'utf8')
  const repository = createLyricsMatchRepository({ filePath })
  await assert.rejects(repository.listBounded(0, 10), /invalid/iu)
  await assert.rejects(repository.delete(signature.key), /invalid/iu)
  assert.equal(await readFile(filePath, 'utf8'), '{broken-json')
})

test('LyricsMatchRepository fails closed for strict schema and record violations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-lyrics-strict-'))
  const validRecord = {
    signature,
    neteaseTrackId: '123',
    source: 'CONFIRMED',
    algorithmVersion: 'lyrics-match-v1',
    createdAt: 1,
    lastUsedAt: 2,
  }
  const invalidStates: readonly unknown[] = [
    { schemaVersion: 2, records: [] },
    { schemaVersion: 1, records: [], extra: true },
    { schemaVersion: 1, records: [{ ...validRecord, extra: true }] },
    { schemaVersion: 1, records: [{ ...validRecord, algorithmVersion: 'x'.repeat(65) }] },
    { schemaVersion: 1, records: [{ ...validRecord, createdAt: -1 }] },
    { schemaVersion: 1, records: [{ ...validRecord, createdAt: 3, lastUsedAt: 2 }] },
    { schemaVersion: 1, records: [validRecord, validRecord] },
    { schemaVersion: 1, records: Array.from({ length: 4_097 }, () => validRecord) },
  ]

  for (const [index, state] of invalidStates.entries()) {
    const filePath = path.join(directory, `invalid-${index}.json`)
    const serialized = JSON.stringify(state)
    await writeFile(filePath, serialized, 'utf8')
    const repository = createLyricsMatchRepository({ filePath })
    await assert.rejects(repository.listBounded(0, 10), /invalid|duplicate/iu)
    assert.equal(await readFile(filePath, 'utf8'), serialized)
  }
})
