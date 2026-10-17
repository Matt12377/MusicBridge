import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumDisplayCache, type LocalAlbumDisplayCacheRecord } from '../src/collection/local-album-browser/display-cache.js'

const rootA = '44444444-4444-4444-8444-000000000001', rootB = '44444444-4444-4444-8444-000000000002'
const key = (n: number): string => createHash('sha256').update(`合成显示缓存-${n}`).digest('hex')
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
type Cache = ReturnType<typeof createLocalAlbumDisplayCache>
type Limits = { maxEntries?: number; maxBytes?: number }
function record(mark: number, side: 16 | 32 = 16, padding = 0): LocalAlbumDisplayCacheRecord {
  // 只复用现有自有JPEG字节；COM不改变像素。此处证明缓存编码/hash/SOF，不声称Native解码。
  const seed = readFileSync(new URL(`./fixtures/mbrs012-source/owned-cover-${side}.jpg`, import.meta.url))
  const comment = Buffer.alloc(5 + padding); comment[0] = 255; comment[1] = 254; comment.writeUInt16BE(comment.length - 2, 2); comment[4] = mark
  const jpeg = Buffer.concat([seed.subarray(0, 2), comment, seed.subarray(2)])
  const info = { mime: 'image/jpeg' as const, bytes: jpeg.length, sha256: sha(jpeg), width: side, height: side }
  return { image: { original: { ...info }, display: { ...info, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }, evidence: {
    independent: [
      { relative: '合成专辑/cover.jpg', signature: `1:2:${jpeg.length}:4:${mark}`, size: jpeg.length, included: true },
      { relative: '合成专辑/folder.jpg', signature: '1:9:4194305:4:5', size: dto.LOCAL_ARTWORK_INPUT_BYTES + 1, included: false },
    ],
    embedded: { relative: '合成专辑/01.wav', signature: '11:22:12345:44:55', size: 12345 }, unresolved: false, embeddedConfirmed: true, independentOnly: false,
  } }
}
function fixture(t: test.TestContext) {
  const temporary = process.env.TMPDIR, allowed = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
  assert.ok(temporary && path.isAbsolute(temporary) && (path.resolve(temporary) === allowed || path.resolve(temporary).startsWith(allowed + '/')), '合成缓存测试仅允许外置任务TMPDIR')
  const directory = mkdtempSync(path.join(temporary, 'mbf-display-cache-')), file = path.join(directory, 'cache.sqlite'), primary = path.join(directory, 'primary.sqlite')
  const closers: Array<() => void> = []
  t.after(() => {
    const errors: unknown[] = []
    for (const close of closers.reverse()) { try { close() } catch (error) { errors.push(error) } }
    try { rmSync(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '合成显示缓存资源未全部清理。', { cause: errors[0] })
  })
  function sql(target = file, readOnly = false) {
    const db = new DatabaseSync(target, { readOnly, allowExtension: false }); let closed = false
    const close = () => { if (!closed) { db.close(); closed = true } }
    closers.push(close); return { db, close }
  }
  const source = sql(primary)
  source.db.exec('CREATE TABLE synthetic_primary(id INTEGER PRIMARY KEY,value TEXT NOT NULL) STRICT')
  source.db.prepare('INSERT INTO synthetic_primary VALUES(1,?)').run('合成原库字节，缓存不能修改')
  source.close(); chmodSync(primary, 0o600)
  const original = readFileSync(primary)
  function open(limits: Limits = {}): Cache {
    const cache = createLocalAlbumDisplayCache({ filePath: file, ...limits }); closers.push(() => cache.close()); return cache
  }
  return { directory, file, primary, original, open, sql,
    unchanged() { assert.deepEqual(readFileSync(primary), original, '旁边主库的全部字节必须保持原样') } }
}
function assertImage(actual: LocalAlbumDisplayCacheRecord | null, expected: LocalAlbumDisplayCacheRecord): void {
  assert.ok(actual); assert.deepEqual(actual, expected)
  const bytes = Buffer.from(actual.image.display.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')
  assert.equal(bytes.length, actual.image.display.bytes); assert.equal(sha(bytes), expected.image.display.sha256)
}

test('本地专辑显示缓存：真实JPEG以BLOB持久化，重开复用SHA且不改旁边主库', t => {
  const f = fixture(t), cache = f.open(), first = record(1), second = record(2, 32)
  assert.equal(existsSync(f.file), false, '构造不得预分配缓存或打开数据库')
  cache.put(key(1), rootA, first); cache.put(key(2), rootB, second)
  assertImage(cache.get(key(1), rootA), first); assertImage(cache.get(key(2), rootB), second)
  assert.equal(cache.get(key(1), rootB), null, 'root身份不能用相同key绕过')
  assert.equal(statSync(f.file).mode & 0o777, 0o600); assert.equal(statSync(f.file).nlink, 1)
  const inspect = f.sql(f.file, true)
  const row = inspect.db.prepare('SELECT typeof(jpeg) kind,length(jpeg) bytes,instr(metadata,?) data_url,instr(metadata,?) base64 FROM local_album_display_cache WHERE cache_key=?').get('dataUrl', 'data:image', key(1))!
  assert.equal(row.kind, 'blob'); assert.equal(row.bytes, first.image.display.bytes); assert.equal(row.data_url, 0); assert.equal(row.base64, 0)
  const pageBytes = Number(inspect.db.prepare('PRAGMA page_size').get()!.page_size), pages = Number(inspect.db.prepare('PRAGMA page_count').get()!.page_count)
  assert.equal(pageBytes, 4096); assert.ok(pageBytes * pages < 1024 * 1024, '只核实际占用，不把另一连接的PRAGMA当作者连接上限')
  inspect.close(); assert.ok(statSync(f.file).size < 1024 * 1024, '两张小图不能预分配GiB文件')
  cache.close(); cache.put(key(3), rootA, record(3))
  const cold = f.open(); assertImage(cold.get(key(1), rootA), first); assertImage(cold.get(key(2), rootB), second); assert.equal(cold.get(key(3), rootA), null)
  f.unchanged()
})

test('本地专辑显示缓存：内存命中不逐图落盘，LRU字节条数受限且撤根拒迟到写', t => {
  const f = fixture(t), a = record(1), b = record(2), c = record(3), payload = a.image.display.bytes
  const cache = f.open({ maxEntries: 2, maxBytes: payload * 2 })
  cache.put(key(1), rootA, a); cache.put(key(2), rootB, b)
  const beforeHits = readFileSync(f.file)
  for (let index = 0; index < 12; index++) assertImage(cache.get(key(1), rootA), a)
  assert.deepEqual(readFileSync(f.file), beforeHits, '命中只能修改内存触碰，不能同步更新SQLite的LRU')
  cache.put(key(3), rootB, c)
  assertImage(cache.get(key(1), rootA), a); assert.equal(cache.get(key(2), rootB), null); assertImage(cache.get(key(3), rootB), c)
  cache.put(key(4), rootA, record(4, 16, payload * 2)); assert.equal(cache.get(key(4), rootA), null)
  const inspect = f.sql(f.file, true), usage = inspect.db.prepare('SELECT count(*) n,sum(payload_bytes) bytes FROM local_album_display_cache').get()!
  assert.equal(usage.n, 2); assert.equal(usage.bytes, payload * 2); inspect.close()
  cache.removeRoot(rootB); cache.put(key(5), rootB, record(5))
  assert.equal(cache.get(key(3), rootB), null); assert.equal(cache.get(key(5), rootB), null); assertImage(cache.get(key(1), rootA), a)
  cache.close(); const cold = f.open({ maxEntries: 2, maxBytes: payload * 2 })
  assert.equal(cold.get(key(3), rootB), null); assert.equal(cold.get(key(5), rootB), null); assertImage(cold.get(key(1), rootA), a)
  f.unchanged()
})

test('本地专辑显示缓存：单entry坏JSON或SHA或尺寸仅本项miss，合法邻项仍可复用', t => {
  for (const damage of ['json', 'sha', 'geometry', 'old-evidence'] as const) {
    const f = fixture(t), cache = f.open(), a = record(1), b = record(2, 32)
    cache.put(key(1), rootA, a); cache.put(key(2), rootB, b); cache.close()
    const corrupt = f.sql()
    if (damage === 'json') corrupt.db.prepare('UPDATE local_album_display_cache SET metadata=? WHERE cache_key=?').run('{bad-json', key(1))
    else if (damage === 'sha') {
      const jpeg = Buffer.from(a.image.display.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'); jpeg[6] = jpeg[6]! ^ 1
      corrupt.db.prepare('UPDATE local_album_display_cache SET jpeg=? WHERE cache_key=?').run(jpeg, key(1))
    } else {
      const row = corrupt.db.prepare('SELECT metadata FROM local_album_display_cache WHERE cache_key=?').get(key(1))!
      const metadata = JSON.parse(String(row.metadata))
      if (damage === 'old-evidence') delete metadata.evidence.independentOnly
      else metadata.display.width = 32
      corrupt.db.prepare('UPDATE local_album_display_cache SET metadata=? WHERE cache_key=?').run(JSON.stringify(metadata), key(1))
    }
    corrupt.close()
    const cold = f.open(); assert.equal(cold.get(key(1), rootA), null); assert.equal(cold.get(key(1), rootA), null)
    assertImage(cold.get(key(2), rootB), b)
    cold.put(key(3), rootB, record(3)); assertImage(cold.get(key(3), rootB), record(3))
    const inspect = f.sql(f.file, true); assert.equal(inspect.db.prepare('SELECT count(*) n FROM local_album_display_cache WHERE cache_key=?').get(key(1))!.n, 1, '坏entry可保原件但不得返回'); inspect.close()
    f.unchanged()
  }
})

test('本地专辑显示缓存：结构或版本损坏停用实例并保留派生原件', t => {
  for (const damage of ['schema', 'version'] as const) {
    const f = fixture(t), cache = f.open(), a = record(1), b = record(2)
    cache.put(key(1), rootA, a); cache.put(key(2), rootB, b); cache.close()
    const corrupt = f.sql(); corrupt.db.exec(damage === 'schema' ? 'CREATE TABLE cache_schema_damage(value TEXT) STRICT' : 'PRAGMA user_version=99'); corrupt.close()
    const before = readFileSync(f.file), cold = f.open()
    assert.equal(cold.get(key(1), rootA), null); assert.equal(cold.get(key(2), rootB), null)
    cold.put(key(3), rootA, record(3)); cold.removeRoot(rootB); cold.close()
    assert.deepEqual(readFileSync(f.file), before, '结构损坏不能删除、重建或覆写原件')
    f.unchanged()
  }
})

test('本地专辑显示缓存：闭集evidence与真实bytes/hash/尺寸拒绝无效输入，unresolved不持久', t => {
  const f = fixture(t), cache = f.open(), invalid: LocalAlbumDisplayCacheRecord[] = []
  const unresolved = record(1); unresolved.evidence.unresolved = true; invalid.push(unresolved)
  const traversal = record(2); traversal.evidence.independent[0]!.relative = '../outside.jpg'; invalid.push(traversal)
  const extra = record(3); Object.assign(extra.evidence, { sensitive: '合成未知字段' }); invalid.push(extra)
  const large = record(4); large.evidence.independent = Array.from({ length: 33 }, () => ({ relative: 'cover.jpg', signature: '1:2:3:4:5', size: 3, included: false })); invalid.push(large)
  const unconfirmed = record(20); unconfirmed.evidence.embeddedConfirmed = false; invalid.push(unconfirmed)
  const contradictory = record(21); contradictory.evidence.independentOnly = true; contradictory.evidence.embeddedConfirmed = false; contradictory.evidence.independent = contradictory.evidence.independent.map(value => ({ ...value, included: false })); invalid.push(contradictory)
  const wrongHash = record(5); wrongHash.image.display.sha256 = '0'.repeat(64); invalid.push(wrongHash)
  const wrongBytes = record(6); wrongBytes.image.display.bytes++; invalid.push(wrongBytes)
  const wrongBase64 = record(7); wrongBase64.image.display.dataUrl = wrongBase64.image.display.dataUrl.replace(/.$/u, 'A'); invalid.push(wrongBase64)
  const wrongGeometry = record(8); wrongGeometry.image.display.height = 32; invalid.push(wrongGeometry)
  let getters = 0
  const accessor = record(9); Object.defineProperty(accessor.evidence, 'unresolved', { enumerable: true, get() { getters++; return false } }); invalid.push(accessor)
  const inherited = record(22), prototype = Object.create(Array.prototype)
  Object.defineProperty(prototype, 'toJSON', { get() { getters++; return () => [] } }); Object.setPrototypeOf(inherited.evidence.independent, prototype); invalid.push(inherited)
  for (const [index, value] of invalid.entries()) cache.put(key(100 + index), rootA, value)
  cache.put('not-a-hash', rootA, record(10)); cache.put(key(10), 'not-a-root', record(10))
  assert.equal(getters, 0); assert.equal(existsSync(f.file), false, '无效输入不得打开或写缓存')
  const valid = record(11, 32); cache.put(key(11), rootA, valid); assertImage(cache.get(key(11), rootA), valid)
  for (const index of invalid.keys()) assert.equal(cache.get(key(100 + index), rootA), null)
  const independent = record(12); independent.evidence.embeddedConfirmed = false; independent.evidence.independentOnly = true
  cache.put(key(12), rootA, independent); assertImage(cache.get(key(12), rootA), independent)
  cache.put(key(130), rootA, inherited); assert.equal(getters, 0); assertImage(cache.get(key(11), rootA), valid)
  f.unchanged()
})

test('本地专辑显示缓存：symlink和hardlink及只读文件均miss，内存模式不落盘', t => {
  for (const boundary of ['symlink', 'hardlink', 'readonly'] as const) {
    const f = fixture(t), value = record(1)
    if (boundary === 'symlink') symlinkSync(f.primary, f.file)
    else if (boundary === 'hardlink') linkSync(f.primary, f.file)
    else { const initial = f.open(); initial.put(key(1), rootA, value); initial.close(); chmodSync(f.file, 0o400) }
    const cache = f.open(); assert.equal(cache.get(key(1), rootA), null); cache.put(key(2), rootA, record(2)); cache.close()
    if (boundary === 'symlink') assert.equal(lstatSync(f.file).isSymbolicLink(), true)
    if (boundary === 'hardlink') assert.equal(statSync(f.file).nlink, 2)
    if (boundary === 'readonly') { assert.equal(statSync(f.file).mode & 0o777, 0o400); chmodSync(f.file, 0o600) }
    f.unchanged()
  }
  const f = fixture(t), value = record(8), memory = createLocalAlbumDisplayCache({ filePath: ':memory:' })
  t.after(() => memory.close()); memory.put(key(8), rootA, value); assertImage(memory.get(key(8), rootA), value); memory.close()
  const next = createLocalAlbumDisplayCache({ filePath: ':memory:' }); t.after(() => next.close()); assert.equal(next.get(key(8), rootA), null)
  assert.equal(existsSync(f.file), false); f.unchanged()
})


test('本地专辑显示缓存：磁盘近配额put仅短事务，撤根分批让出且close止写，COMMIT拒绝整体回滚', async t => {
  const f = fixture(t), fRollback = fixture(t), values = Array.from({ length: 64 }, (_, index) => record(index))
  const payload = values[0]!.image.display.bytes, cache = f.open({ maxEntries: 64, maxBytes: payload * 64 })
  for (const [index, value] of values.entries()) cache.put(key(index), rootA, value)
  const rollbackCache = fRollback.open({ maxEntries: 2, maxBytes: payload * 2 })
  rollbackCache.put(key(1), rootA, record(1)); rollbackCache.put(key(2), rootB, record(2))
  const initial = f.sql(f.file, true); assert.equal(initial.db.prepare('SELECT count(*) n FROM local_album_display_cache').get()!.n, 64); initial.close()
  type Transaction = { writes: number; parameterBytes: number }
  const transactions: Transaction[] = []
  let active: Transaction | null = null, outsideWrites = 0, failCommit = false, rollbackWrites = 0
  const originalExec = DatabaseSync.prototype.exec, originalPrepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') { assert.equal(active, null); originalExec.call(this, sql); active = { writes: 0, parameterBytes: 0 }; return }
    if (sql === 'COMMIT') {
      if (failCommit) { failCommit = false; throw new Error('合成COMMIT拒绝') }
      originalExec.call(this, sql); assert.ok(active); transactions.push(active); active = null; return
    }
    if (sql === 'ROLLBACK') { originalExec.call(this, sql); rollbackWrites += active?.writes ?? 0; active = null; return }
    originalExec.call(this, sql)
  })
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql)
    if (!/^(?:INSERT|UPDATE|DELETE)\b/u.test(sql)) return statement
    return new Proxy(statement, { get(target, property) {
      if (property === 'run') return (...parameters: SQLInputValue[]) => {
        const current = active
        if (!current) outsideWrites++
        else {
          current.writes++
          for (const value of parameters) current.parameterBytes += typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 0
        }
        return target.run(...parameters)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  // 64个合法命中不能产生64次落盘；需要超过4个victim的大put应整次放弃，不能先删一部分。
  const beforeHits = readFileSync(f.file)
  for (const [index, value] of values.entries()) assertImage(cache.get(key(index), rootA), value)
  assert.deepEqual(readFileSync(f.file), beforeHits); assert.equal(outsideWrites, 0); assert.equal(transactions.length, 0)
  cache.put(key(900), rootB, record(90, 16, payload * 20)); assert.equal(cache.get(key(900), rootB), null)
  assert.equal(transactions.length, 0); assert.deepEqual(readFileSync(f.file), beforeHits)
  const larger = record(200, 16, payload * 2); cache.put(key(1000), rootB, larger)
  assertImage(cache.get(key(1000), rootB), larger); assert.equal(transactions.length, 1)
  assert.ok(transactions[0]!.writes >= 2 && transactions[0]!.writes <= 5); assert.ok(transactions[0]!.parameterBytes < 16 * 1024 * 1024); assert.equal(outsideWrites, 0)
  const beforeRemove = f.sql(f.file, true), remainingBefore = Number(beforeRemove.db.prepare('SELECT count(*) n FROM local_album_display_cache WHERE root_id=?').get(rootA)!.n)
  assert.ok(remainingBefore > 4); beforeRemove.close(); transactions.length = 0
  cache.removeRoot(rootA); cache.put(key(1001), rootA, record(201))
  assert.equal(cache.get(key(40), rootA), null); assert.equal(cache.get(key(1001), rootA), null)
  assert.equal(transactions.length, 1); assert.equal(transactions[0]!.writes, 1, '首响应只提交root墓碑，不同步删除整根')
  const immediate = f.sql(f.file, true)
  assert.equal(Number(immediate.db.prepare('SELECT count(*) n FROM local_album_display_cache WHERE root_id=?').get(rootA)!.n), remainingBefore)
  assert.equal(immediate.db.prepare('SELECT count(*) n FROM local_album_display_cache_retired_roots WHERE root_id=?').get(rootA)!.n, 1); immediate.close()
  await new Promise<void>(resolve => setImmediate(resolve))
  const afterTurn = f.sql(f.file, true), remainingAfter = Number(afterTurn.db.prepare('SELECT count(*) n FROM local_album_display_cache WHERE root_id=?').get(rootA)!.n); afterTurn.close()
  assert.ok(remainingAfter > 0 && remainingAfter < remainingBefore, '真实setImmediate批次必须让出事件循环，不能用微任务跑完整根')
  assert.ok(transactions.every(value => value.writes <= 4 && value.parameterBytes < 16 * 1024 * 1024)); assert.equal(outsideWrites, 0)
  cache.close(); const committedAtClose = transactions.length
  await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(transactions.length, committedAtClose, 'close后不得继续清理或提交派生DB')
  const closed = f.sql(f.file, true); assert.equal(Number(closed.db.prepare('SELECT count(*) n FROM local_album_display_cache WHERE root_id=?').get(rootA)!.n), remainingAfter); closed.close()
  const cold = f.open({ maxEntries: 64, maxBytes: payload * 64 }); assert.equal(cold.get(key(40), rootA), null); assertImage(cold.get(key(1000), rootB), larger); cold.close()
  // 原SQL确实执行了淘汰+插入后，在COMMIT前拒绝；新连接必须仍见原两条且无新条目。
  transactions.length = 0; failCommit = true; rollbackCache.put(key(3), rootA, record(3))
  assert.equal(rollbackWrites, 2); assert.equal(transactions.length, 0); assert.equal(outsideWrites, 0)
  const restored = fRollback.sql(fRollback.file, true), rows = restored.db.prepare('SELECT cache_key FROM local_album_display_cache ORDER BY cache_key').all()
  assert.deepEqual(rows.map(row => row.cache_key), [key(1), key(2)].sort()); restored.close()
  const retry = fRollback.open({ maxEntries: 2, maxBytes: payload * 2 }); assertImage(retry.get(key(1), rootA), record(1)); assertImage(retry.get(key(2), rootB), record(2)); assert.equal(retry.get(key(3), rootA), null)
  f.unchanged(); fRollback.unchanged()
})
