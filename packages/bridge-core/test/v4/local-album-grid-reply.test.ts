import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { projectLocalAlbumArtworkReply } from '../../src/collection/local-album-browser/artwork-reply.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import type { CollectionRepository } from '../../src/collection/repository.js'

const request: dto.LocalAlbumArtworkRequest = { albumKey: 'synthetic-grid', rootId: '11111111-1111-4111-8111-000000000001', editionId: null, representativeTrackId: null, revision: 'revision-1' }
// 合成DTO只验证传输与守门，不冒充图片解码。
function display(bytes: number, width: number): dto.LocalArtworkImage['display'] {
  const data = Buffer.alloc(bytes, 1)
  return { mime: 'image/jpeg', bytes, sha256: createHash('sha256').update(data).digest('hex'), width, height: width, dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` }
}
const full = display(120000, 1200), grid = display(3000, 256)
const image: dto.LocalArtworkImage = { original: { mime: full.mime, bytes: full.bytes, sha256: full.sha256, width: full.width, height: full.height }, display: full }

test('封面传输尺寸：网格只传小副本，详情保留原图，逻辑身份与持久对象不变', () => {
  const read = { image, grid, status: 'ready' as const }, ordinary = projectLocalAlbumArtworkReply(request, read)
  const query = { ...request, variant: 'grid' as const }, compact = projectLocalAlbumArtworkReply(query, read)
  assert.equal(ordinary.image?.display, full); assert.equal(compact.image?.display, grid)
  assert.equal(compact.image?.original, image.original); assert.equal(read.image.display, full)
  assert.ok(JSON.stringify(compact).length < JSON.stringify(ordinary).length / 10)
  assert.equal(dto.isLocalAlbumArtworkReply(compact, query), true)
  assert.equal(dto.isLocalAlbumCommandResult('localAlbum.artwork', compact), true)
  assert.equal(dto.isLocalAlbumArtworkReply(compact, request), false)
  assert.equal(dto.isLocalAlbumArtworkReply(ordinary, query), false)
  for (const variant of ['full', '', null, undefined, true]) assert.equal(dto.isLocalAlbumArtworkRequest({ ...request, variant }), false)
  assert.equal(dto.isLocalAlbumArtworkRequest(query), true)
  assert.throws(() => projectLocalAlbumArtworkReply(query, { ...read, image: { ...image, display: { ...full, width: 9999 } } }))
  assert.equal(projectLocalAlbumArtworkReply(query, { image: null, status: 'ready' }).image, null)
  assert.equal(projectLocalAlbumArtworkReply(query, { image, status: 'ready' }).image?.display, full, '旧资源无grid时保留合法旧图')
})

test('封面传输尺寸：Owner本地命中仍核原作者，网格不读根或源，详情另取高清', async t => {
  let reads = 0, live = true
  const service = createLocalAlbumOwnerService({ repository: { localCatalog: {}, localScan: {} } as unknown as CollectionRepository,
    assertCurrent() { if (!live) throw new Error('原作者已退出') },
    async readRootViews() { throw new Error('本地命中不得读取根') }, async readArtwork() { throw new Error('本地命中不得提取来源') },
    readCachedArtwork() { reads++; return { image, grid, status: 'ready' } } })
  t.after(() => service.close())
  assert.equal((await service.getArtwork({ ...request, variant: 'grid' })).image?.display, grid)
  assert.equal((await service.getArtwork(request)).image?.display, full)
  assert.equal(reads, 2); live = false
  await assert.rejects(service.getArtwork({ ...request, variant: 'grid' })); assert.equal(reads, 2)
})
