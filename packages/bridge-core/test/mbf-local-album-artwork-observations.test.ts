import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createLocalAlbumDisplayCache, type LocalAlbumDisplayCacheRecord } from '../src/collection/local-album-browser/display-cache.js'
import { createLocalAlbumArtworkObservationStore } from '../src/collection/local-album-browser/artwork-observation-store.js'
import type { LocalAlbumSqlArtworkObservation } from '../src/collection/local-album-browser/sql-types.js'

// 紧凑派生事实和真实独立SQLite；仅自有JPEG夹具，不创建音乐库或读取真实来源，不代表大规模性能测试。
test('MBF封面计数：图片实际淘汰不删紧凑事实，关闭重开及scope清理保持隔离', async t => {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成观察库须使用外置临时目录。')
  const directory = await mkdtemp(path.join(temporary, 'mbf-artwork-observations-'))
  let store: ReturnType<typeof createLocalAlbumArtworkObservationStore> | undefined, display: ReturnType<typeof createLocalAlbumDisplayCache> | undefined
  t.after(async () => {
    const errors: unknown[] = []
    try { display?.close() } catch (error) { errors.push(error) }
    try { store?.close() } catch (error) { errors.push(error) }
    try { await rm(directory, { recursive: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '紧凑封面观察测试未全部关闭。', { cause: errors[0] })
  })
  const filePath = path.join(directory, 'work.sqlite.album-artwork-observations.sqlite')
  const datasetId = randomUUID(), otherDatasetId = randomUUID(), rootId = randomUUID(), otherRootId = randomUUID()
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const sourceRevision = hash('synthetic-source-revision-1'), otherRevision = hash('synthetic-source-revision-2')
  const facts = Array.from({ length: 3 }, (_, index): LocalAlbumSqlArtworkObservation => ({ albumKey: `synthetic-album-${index}`, rootId, sourceRevision, state: index % 2 ? 'missing' : 'available', revision: hash(`synthetic-artwork-${index}`) }))
  const sorted = (values: readonly LocalAlbumSqlArtworkObservation[]) => [...values].sort((left, right) => left.albumKey.localeCompare(right.albumKey))
  store = createLocalAlbumArtworkObservationStore({ filePath })
  for (const fact of facts) assert.equal(store.put(datasetId, fact), true)
  assert.deepEqual(sorted(store.read(datasetId, sourceRevision)), sorted(facts))
  assert.deepEqual(store.read(otherDatasetId, sourceRevision), []); assert.deepEqual(store.read(datasetId, otherRevision), [])
  const unrelated: LocalAlbumSqlArtworkObservation = { albumKey: 'synthetic-unrelated-album', rootId: otherRootId, sourceRevision, state: 'available', revision: hash('synthetic-unrelated-artwork') }
  assert.equal(store.put(otherDatasetId, unrelated), true)
  const revised: LocalAlbumSqlArtworkObservation = { ...unrelated, albumKey: 'synthetic-other-revision', sourceRevision: otherRevision }
  assert.equal(store.put(datasetId, revised), true)
  async function image(side: 16 | 32): Promise<LocalAlbumDisplayCacheRecord> {
    const jpeg = await readFile(new URL(`./fixtures/mbrs012-source/owned-cover-${side}.jpg`, import.meta.url))
    const info = { mime: 'image/jpeg' as const, bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'), width: side, height: side }
    return { image: { original: { ...info }, display: { ...info, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }, evidence: {
      independent: [{ relative: `synthetic/${side}.jpg`, signature: `1:${side}:${jpeg.length}:4:5`, size: jpeg.length, included: true }],
      embedded: null, unresolved: false, embeddedConfirmed: false, independentOnly: true,
    } }
  }
  const displayFile = path.join(directory, 'display.sqlite'), first = await image(16), second = await image(32)
  const firstKey = hash(facts[0]!.albumKey), secondKey = hash(facts[2]!.albumKey)
  display = createLocalAlbumDisplayCache({ filePath: displayFile, maxEntries: 1 })
  display.put(firstKey, rootId, first); assert.equal(display.get(firstKey, rootId)!.image.display.sha256, first.image.display.sha256)
  display.put(secondKey, rootId, second)
  assert.equal(display.get(firstKey, rootId), null, '控制例必须真实淘汰首张显示图。')
  assert.equal(display.get(secondKey, rootId)!.image.display.sha256, second.image.display.sha256)
  assert.deepEqual(store.read(datasetId, sourceRevision).find(fact => fact.albumKey === facts[0]!.albumKey), facts[0])
  assert.deepEqual(sorted(store.read(datasetId, sourceRevision)), sorted(facts), '图片LRU不能删除对应计数事实。')
  display.close(); display = createLocalAlbumDisplayCache({ filePath: displayFile, maxEntries: 1 })
  assert.equal(display.get(firstKey, rootId), null); assert.equal(display.get(secondKey, rootId)!.image.display.sha256, second.image.display.sha256)
  store.close(); store = createLocalAlbumArtworkObservationStore({ filePath })
  assert.deepEqual(sorted(store.read(datasetId, sourceRevision)), sorted(facts))
  assert.deepEqual(store.read(otherDatasetId, sourceRevision), [unrelated]); assert.deepEqual(store.read(datasetId, otherRevision), [revised])
  store.removeRoot(rootId)
  assert.deepEqual(store.read(datasetId, sourceRevision), []); assert.equal(store.put(datasetId, facts[0]!), false)
  assert.deepEqual(store.read(otherDatasetId, sourceRevision), [unrelated]); assert.deepEqual(store.read(datasetId, otherRevision), [revised])
  store.close(); store = createLocalAlbumArtworkObservationStore({ filePath })
  assert.deepEqual(store.read(datasetId, sourceRevision), []); assert.equal(store.put(datasetId, facts[0]!), false)
  assert.deepEqual(store.read(otherDatasetId, sourceRevision), [unrelated]); assert.deepEqual(store.read(datasetId, otherRevision), [revised])
  store.removeDataset(datasetId)
  assert.deepEqual(store.read(datasetId, otherRevision), []); assert.deepEqual(store.read(otherDatasetId, sourceRevision), [unrelated])
  store.close(); store = createLocalAlbumArtworkObservationStore({ filePath })
  assert.deepEqual(store.read(datasetId, otherRevision), []); assert.deepEqual(store.read(otherDatasetId, sourceRevision), [unrelated])
  assert.equal(store.put(datasetId, revised), true, '单工作库失效不是永久撤根，新证据仍可重新写入。')
  assert.deepEqual(store.read(datasetId, otherRevision), [revised]); assert.equal(store.put(datasetId, facts[0]!), false)
})
