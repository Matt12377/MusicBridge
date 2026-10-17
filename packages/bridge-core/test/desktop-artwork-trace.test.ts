import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createDesktopArtworkCollector, copyDesktopArtworkEvidence } from '../src/shared/desktop-artwork-trace-node.js'
import { desktopArtworkIdentitySha256, copyDesktopArtworkEvent, readDesktopArtworkLine, DESKTOP_ARTWORK_PREFIX, type DesktopArtworkEvent } from '../src/shared/desktop-artwork-trace.js'

const event = (): DesktopArtworkEvent => ({ version: 1, origin: 'core', stage: 'disk-hit', keySha256: 'a'.repeat(64), requestSha256: null,
  atMs: 1_792_228_000_000, elapsedMs: 2, bytes: 1200, decodedBytes: 0, count: 1, reason: 'none', code: 'UNKNOWN' })

test('桌面封面私有观察：默认关闭的收集器不记录，数字聚合独立于有限记录环', () => {
  const off = createDesktopArtworkCollector(false); off.collect(event()); assert.equal(off.snapshot().totals['disk-hit'], 0)
  const on = createDesktopArtworkCollector(true)
  for (let index = 0; index < 600; index++) on.collect(event())
  const snapshot = on.snapshot()
  assert.equal(snapshot.records.length, 512); assert.equal(snapshot.totals['disk-hit'], 600)
  assert.equal(snapshot.droppedRecords, 88); assert.equal(snapshot.truncated, true); assert.equal(snapshot.totalsComplete, true)
  on.collect({ ...event(), stage: 'observer-truncated', reason: 'capacity' })
  assert.equal(on.snapshot().totalsComplete, false)
})

test('桌面封面私有观察：未知正文、非有限数、getter和Proxy均不能进入诊断证据', () => {
  const collector = createDesktopArtworkCollector(true)
  let accesses = 0
  const getter = { ...event() }; Object.defineProperty(getter, 'bytes', { enumerable: true, get() { accesses++; return 1 } })
  const proxy = new Proxy(event(), { ownKeys() { accesses++; throw new Error('不能触碰Proxy') } })
  for (const value of [{ ...event(), path: '/private/example' }, { ...event(), atMs: 1.5 }, { ...event(), atMs: Infinity }, { ...event(), elapsedMs: NaN }, { ...event(), code: 'PRIVATE_ERROR_TEXT' }, getter, proxy]) collector.collect(value)
  assert.equal(accesses, 0); assert.equal(collector.snapshot().records.length, 0)
  assert.equal(copyDesktopArtworkEvent({ ...event(), image: 'secret' }), null)
  assert.equal(readDesktopArtworkLine(DESKTOP_ARTWORK_PREFIX + JSON.stringify({ ...event(), title: 'private' })), null)
  assert.equal(readDesktopArtworkLine(DESKTOP_ARTWORK_PREFIX + ' '.repeat(1600)), null)
  const snapshot = collector.snapshot()
  assert.ok(copyDesktopArtworkEvidence(snapshot)); assert.equal(copyDesktopArtworkEvidence({ ...snapshot, unknown: true }), null)
  assert.equal(copyDesktopArtworkEvidence({ ...snapshot, records: [proxy] }), null); assert.equal(accesses, 0)
})

test('桌面封面私有身份：有界多块和Unicode摘要与Node SHA256一致', () => {
  for (const identity of ['', 'abc', 'a'.repeat(64), 'a'.repeat(4096), JSON.stringify(['来源', 'a'.repeat(80), '修订'])]) assert.equal(desktopArtworkIdentitySha256(identity), createHash('sha256').update(identity).digest('hex'))
  assert.equal(desktopArtworkIdentitySha256('a'.repeat(4097)), null)
})
