import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createCollectionRepository } from '../../../../packages/bridge-core/src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../../../../packages/bridge-core/src/collection/local-album-browser/owner-port.js'
import { readLocalStartupAuditCache, saveLocalStartupAuditCache } from '../../../../packages/bridge-core/src/collection/local-startup-audit-cache.js'
import { sourceRootAvailability } from '../../../../packages/bridge-core/src/recording/source-files.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../../../packages/bridge-core/src/shared/library-operation-log.js'

// 显式容量Gate：先执行owner-80000，再提供其私有合成目录；绝不打开已有用户profile。
// 仅读原合成库，克隆到新私有目录后才经过原冷开恢复/保存缓存/重开；没有Scanner、Parser或播放。
// 缓存显式版本仅为测试口参数，不替代打包App的实现seal或官方Electron身份。
const hashFile = async (file: string) => { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex') }

test('80,000条旧记录：原冷开完整核验，内容绑定缓存暖开不重放历史，首100张与当前详情可读', { timeout: 180_000 }, async t => {
  const temporary = process.env.TMPDIR, corpus = process.env.MUSIC_BRIDGE_PROGRESSIVE_SYNTHETIC_CORPUS
  assert.ok(temporary && path.isAbsolute(temporary)); assert.equal(await realpath(temporary), temporary)
  assert.ok(corpus && path.isAbsolute(corpus)); assert.equal(path.dirname(corpus), temporary)
  assert.match(path.basename(corpus), /^progressive-library-80000-[A-Za-z0-9]+$/u)
  assert.equal(await realpath(corpus), corpus)
  for (const directory of [temporary, corpus]) {
    const info = await lstat(directory)
    assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(info.mode & 0o777, 0o700)
    assert.equal(info.uid, process.getuid!())
  }
  const sourceFile = path.join(corpus, 'collection.sqlite'), proofFile = path.join(corpus, 'proof.json')
  for (const file of [sourceFile, proofFile]) { const info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(info.nlink, 1); assert.equal(info.uid, process.getuid!()) }
  assert.ok((await lstat(proofFile)).size < 1024 * 1024)
  const input = JSON.parse(await readFile(proofFile, 'utf8')) as Record<string, unknown>
  assert.equal(input.stage, 'progressive-library-batches'); assert.equal(input.synthetic, true); assert.equal(input.result, 'pass')
  assert.equal(input.rows, 80_000); assert.equal(input.albums, 8000); assert.equal(input.commits, 401)
  assert.equal(input.database, sourceFile); assert.equal(input.source, path.join(corpus, 'owned-empty-source'))
  assert.equal(input.parserExecuted, false); assert.equal(input.actualAudio, false); assert.equal(input.ownerAccepted, false)
  assert.equal(typeof input.libraryRootId, 'string'); assert.deepEqual(await readdir(String(input.source)), [])
  const originalHash = await hashFile(sourceFile)
  const directory = await mkdtemp(path.join(temporary, 'progressive-library-cold-audit-')); await chmod(directory, 0o700)
  const filePath = path.join(directory, 'collection.sqlite'); await copyFile(sourceFile, filePath, constants.COPYFILE_FICLONE)
  assert.equal(await hashFile(filePath), originalHash)
  const opened = new Set<ReturnType<typeof createCollectionRepository>>(), owners = new Set<ReturnType<typeof createLocalAlbumOwnerService>>()
  t.after(() => { for (const owner of owners) owner.close(); for (const repository of opened) repository.close() })
  const events: LibraryOperationEvent[] = []
  t.mock.method(console, 'info', (line: unknown) => { const event = readLibraryOperationLine(String(line)); if (event) events.push(event) })
  const repository = createCollectionRepository({ filePath }); opened.add(repository)
  let started = performance.now(); repository.list({ offset: 0, limit: 1 }); const coldRepositoryMs = performance.now() - started
  assert.equal(repository.privateStartupAuditReused, false)
  assert.ok(events.some(event => event.action === 'startup.repository.catalog' && event.state === 'complete'))
  assert.ok(events.some(event => event.action === 'startup.repository.scan' && event.state === 'complete'))
  const db = repository.localCatalog.privateRead(current => current)
  for (const table of ['local_catalog_tracks', 'local_catalog_assets', 'local_scan_file_state']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 80_000)
  assert.equal(db.prepare('SELECT count(*) n FROM local_scan_batches').get()!.n, 401)
  const createOwner = (current: typeof repository) => {
    const owner = createLocalAlbumOwnerService({ repository: current, assertCurrent() { assert.ok(opened.has(current)) },
      async readRootViews() {
        const root = current.localCatalog.root(String(input.libraryRootId))
        return [{ root, label: '合成旧库来源', availability: await sourceRootAvailability(current.sources.root(root.sourceRootId)) }]
      }, async readArtwork() { throw new Error('本Gate无源媒体读取或图片解码') } })
    owners.add(owner); return owner
  }
  const query = { query: '', rootId: null, filter: 'all' as const, offset: 0, limit: 100 }
  const owner = createOwner(repository)
  started = performance.now(); const coldPage = await owner.queryVersionedAlbums(query); const coldFirst100Ms = performance.now() - started
  assert.equal(coldPage.page.items.length, 100); assert.equal(coldPage.page.total, 8000)
  // 与现有缓存单元保护相同的显式测试版本；无全局/环境实现身份override。
  const controlledImplementationVersion = 'e'.repeat(64)
  started = performance.now(); assert.equal(await saveLocalStartupAuditCache(db, filePath, { implementationVersion: controlledImplementationVersion }), true)
  const saveCacheMs = performance.now() - started
  owner.close(); owners.delete(owner); repository.close(); opened.delete(repository)
  started = performance.now(); const candidate = await readLocalStartupAuditCache(filePath, { implementationVersion: controlledImplementationVersion }); const readCacheMs = performance.now() - started
  assert.ok(candidate)
  assert.equal(await readLocalStartupAuditCache(filePath, { implementationVersion: 'f'.repeat(64) }), undefined, '实现身份变化必须失效')
  events.length = 0
  const warm = createCollectionRepository({ filePath, startupAudit: candidate }); opened.add(warm)
  started = performance.now(); warm.list({ offset: 0, limit: 1 }); const warmRepositoryMs = performance.now() - started
  assert.equal(warm.privateStartupAuditReused, true)
  assert.ok(events.some(event => event.action === 'startup.repository.audit-reuse' && event.code === 'CONTENT_MATCH'))
  assert.equal(events.some(event => ['startup.repository.catalog', 'startup.repository.scan'].includes(event.action)), false)
  const warmOwner = createOwner(warm)
  started = performance.now(); const page = await warmOwner.queryVersionedAlbums(query); const warmFirst100Ms = performance.now() - started
  assert.equal(page.page.items.length, 100); assert.equal(page.page.total, 8000)
  assert.deepEqual(page.page.items.map(album => album.id), coldPage.page.items.map(album => album.id))
  const first = page.page.items[0]!
  const detail = await warmOwner.queryAlbumTracks({ albumKey: first.id, rootId: first.rootId, offset: 0, limit: 100 })
  assert.equal(detail.total, 10); assert.equal(detail.items.length, 10)
  assert.equal(await hashFile(sourceFile), originalHash, '旧合成原件始终未被恢复写或cache写触碰')
  const proof = { schemaVersion: 1, stage: 'progressive-library-audit', synthetic: true, rows: 80_000, albums: 8000, batches: 401,
    originalUnchanged: true, originalSha256: originalHash, coldRepositoryMs, coldFirst100Ms, saveCacheMs, readCacheMs, warmRepositoryMs, warmFirst100Ms,
    warmHistoryReplayed: false, firstAlbumTracks: detail.total, parserExecuted: false, actualElectronTransport: false, actualDatasetOwnerProcess: false,
    playbackRequested: false, actualAudio: false, ownerAccepted: false, result: 'pass' }
  await writeFile(path.join(directory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  t.diagnostic('PROGRESSIVE_LIBRARY_COLD_AUDIT_80000_PASS ' + JSON.stringify(proof))
})
