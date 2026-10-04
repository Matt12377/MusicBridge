import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// 历史对象按原生产者字段保全，不能套当前schema补字段或重写。
const identities = {
  'source05-multi-read-fragment.json': ['d0ebfd169c398327bcb47baa935a4161a8bc520368ff2104dcd1babb88dfefbf', 47, '05'],
  'source05-reset-1-fragment.json': ['14af66cbe56573bea2ddc78d6a5253d36c6fdf635ab5f8934e2ba1560679fbfe', 6, '05'],
  'source05-reset-2-fragment.json': ['92a6c853e1eac4389a3edd15939ab86cb660731e11bd1e3aa8910b4a2f7e0322', 6, '05'],
  'source08-settings-discard-fragment.json': ['c9ee7c0991a70b1d52f626b6acd9fc6277ae10291e67e6d1c92bdc12d42138f4', 15, '08'],
} as const
const sourceHashes = { '05': '03ed7e49782d32c422da6d6d8ec653442862b48f830610f743fd3119391026ef', '08': '4cf19b78de49a243b425bcf56a67d6ceea3bdaf287568e4b91e0555001f2b4c5' }
export type HistoricalFragmentName = keyof typeof identities
export function decodeHistoricalFragment(name: HistoricalFragmentName, bytes: Buffer): { events: any[]; original_event_indices: number[] } {
  const [sha256, count, source] = identities[name]
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, '历史片段字节身份改变')
  const value = JSON.parse(bytes.toString())
  assert.deepEqual(Object.keys(value).sort(), ['kind', 'source', 'source_raw_sha256', 'selector', 'original_event_indices', 'events'].sort())
  assert.equal(value.kind, 'HISTORICAL_LOCAL_FRAGMENT'); assert.equal(value.source, source)
  assert.equal(value.source_raw_sha256, sourceHashes[source]); assert.equal(value.events.length, count)
  assert.equal(value.original_event_indices.length, count)
  assert.ok(value.original_event_indices.every((index: number, i: number, all: number[]) => Number.isSafeInteger(index) && index >= 0 && (i === 0 || index > all[i - 1]!)))
  return value
}
export function historicalScaleFragment(name: HistoricalFragmentName) {
  return decodeHistoricalFragment(name, readFileSync(new URL('../fixtures/rust015-historical/' + name, import.meta.url)))
}
