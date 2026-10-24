import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { LocalAlbumArtworkRequest, LocalArtworkImage } from '@music-bridge/contracts'
import type { CollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'

const request: LocalAlbumArtworkRequest = { albumKey: 'synthetic-album', rootId: '11111111-1111-4111-8111-000000000001',
  editionId: null, representativeTrackId: null, revision: 'synthetic-revision' }
function image(): LocalArtworkImage {
  const bytes = readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  const common = { mime: 'image/jpeg' as const, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 16, height: 16 }
  return { original: common, display: { ...common, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } }
}
test('本地封面直读：命中不刷新音乐根、不查询全库、不申请源许可，已关闭作者仍拒绝', async t => {
  const selected = image(); let rootReads = 0, sourceReads = 0, localReads = 0
  const service = createLocalAlbumOwnerService({
    repository: { localCatalog: {}, localScan: {} } as unknown as CollectionRepository, assertCurrent() {},
    async readRootViews() { rootReads++; throw new Error('本地封面命中不得访问NAS') },
    async readArtwork() { sourceReads++; throw new Error('本地封面命中不得重新提取') },
    readCachedArtwork() { localReads++; return { image: selected, status: 'ready' } },
  })
  t.after(() => service.close())
  const reply = await service.getArtwork(request)
  assert.deepEqual(reply.image, selected)
  assert.deepEqual([rootReads, sourceReads, localReads], [0, 0, 1])
  const controller = new AbortController(); controller.abort()
  await assert.rejects(service.getArtwork(request, { purpose: 'background', signal: controller.signal }))
  assert.equal(localReads, 1, '取消不能继续读取本地资源')
  service.close()
  await assert.rejects(service.getArtwork(request))
  assert.equal(localReads, 1)
})

test('本地封面直读：显式刷新仍走来源核对，损坏的本地回复不会发布', async t => {
  let localReads = 0, rootReads = 0
  const service = createLocalAlbumOwnerService({
    repository: { localCatalog: {}, localScan: {} } as unknown as CollectionRepository, assertCurrent() {},
    async readRootViews() { rootReads++; throw new Error('合成离线') },
    async readArtwork() { throw new Error('不应到达') },
    readCachedArtwork() { localReads++; return { image: image(), grid: { ...image().display, width: 999 }, status: 'ready' } },
  })
  t.after(() => service.close())
  await assert.rejects(service.getArtwork(request))
  assert.equal(rootReads, 0)
  await assert.rejects(service.getArtwork({ ...request, refresh: true }))
  assert.deepEqual([localReads, rootReads], [1, 1])
})
