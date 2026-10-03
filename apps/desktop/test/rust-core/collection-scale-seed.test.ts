import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { collectionScaleDescriptor, seedCollectionScaleProfile } from '../../scripts/collection-scale-seed.js'

const stage = '/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-015-i0qxwbi7/author-c'
mkdirSync(stage, { recursive: true, mode: 0o700 })
test('非法规模在任何夹具写入前拒绝', () => {
  const profile = mkdtempSync(path.join(stage, 'musicbridge-ui-diagnostics-rejected-'))
  assert.throws(() => seedCollectionScaleProfile(profile, 99 as never, randomUUID()), /未准入/u)
  assert.equal(existsSync(path.join(profile, 'data')), false)
})
test('非外置profile在文件系统访问前拒绝', () => assert.throws(() => seedCollectionScaleProfile('/Users/yihe/not-a-test-profile', 0, randomUUID()), /未准入/u))
test('六工作量中的字面通配符和Unicode是实际descriptor事实', () => {
  assert.equal(collectionScaleDescriptor(5).edition, 'RUST015%_literal')
  assert.equal(collectionScaleDescriptor(7).edition, 'RUST015樱花🌸')
  assert.throws(() => collectionScaleDescriptor(0), /未准入/u)
})
for (const count of [0, 100, 2000, 2001, 5000, 5001] as const) test(`原schema装入${count}个完整合成型号并关闭Node句柄`, () => {
  const profile = mkdtempSync(path.join(stage, 'musicbridge-ui-diagnostics-facts-')), receipt = seedCollectionScaleProfile(profile, count, randomUUID())
  assert.equal(receipt.modelCount, count); assert.equal(receipt.models.length, count); assert.equal(receipt.handlesClosedBeforeLaunch, true)
  assert.equal(receipt.writer, 'Node-before-App'); assert.equal(receipt.seedDomainLedger, 0); assert.equal(receipt.seedMainOutbox, 0)
  assert.equal(statSync(path.join(profile, 'rust015-seed.json')).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(path.join(profile, 'rust015-seed.json'), 'utf8')), receipt)
  const db = new DatabaseSync(receipt.database.path, { readOnly: true })
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM collection_models').get() as { n: number }).n, count)
    assert.equal((db.prepare('SELECT count(*) AS n FROM inventory_ledger').get() as { n: number }).n, 0)
    if (count) assert.deepEqual(JSON.parse((db.prepare('SELECT descriptor FROM collection_models ORDER BY rowid LIMIT 1').get() as { descriptor: string }).descriptor), collectionScaleDescriptor(1))
  } finally { db.close() }
  assert.throws(() => seedCollectionScaleProfile(profile, count, randomUUID()), /全新空白/u)
})
test('原默认startup名字仅允许0模型且仍关闭全部Node句柄',()=>{
 const profile=mkdtempSync(path.join(stage,'musicbridge-task036-startup-')),nonce=randomUUID()
 assert.throws(()=>seedCollectionScaleProfile(profile,100,nonce),/未准入/u);assert.equal(existsSync(path.join(profile,'data')),false)
 const receipt=seedCollectionScaleProfile(profile,0,nonce);assert.equal(receipt.modelCount,0);assert.deepEqual(receipt.models,[]);assert.equal(receipt.handlesClosedBeforeLaunch,true);assert.equal(receipt.seedDomainLedger,0)
})
