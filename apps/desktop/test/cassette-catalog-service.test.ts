import assert from 'node:assert/strict'
import test from 'node:test'
import { createCassetteCatalogService, installCassetteCatalogHandlers } from '../src/main/cassette-catalog-service.js'
import { cassetteAssetUrl } from '../src/shared/cassette-catalog.js'

test('完整档案选择与资料详情先核可信发送者，不接受Renderer文件路径', async () => {
  const handlers = new Map<string, (event: { trusted: boolean }, value?: unknown) => unknown>()
  let picks = 0, details = 0
  installCassetteCatalogHandlers<{ trusted: boolean }>({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: event => { if (!event.trusted) throw new Error('非可信窗口') },
    service: { pick: async () => { picks++; return null }, detail: async () => { details++; throw new Error('/private/secret') },
      image: async () => new Response(null) },
  })
  await assert.rejects(async () => handlers.get('cassetteCatalog:pick-archive')!({ trusted: false }), /非可信窗口/u)
  await assert.rejects(async () => handlers.get('cassetteCatalog:detail')!({ trusted: false }, {}), /非可信窗口/u)
  await assert.rejects(async () => handlers.get('cassetteCatalog:pick-archive')!({ trusted: true }, { path: '/private/secret' }), /请求无效/u)
  assert.equal(picks, 0)
  assert.equal(details, 0)
  assert.equal(await handlers.get('cassetteCatalog:pick-archive')!({ trusted: true }), null)
  await assert.rejects(async () => handlers.get('cassetteCatalog:detail')!({ trusted: true }, {}), error => error instanceof Error && !error.message.includes('/private/'))
  assert.equal(picks, 1)
  assert.equal(details, 1)
})

test('图片路由拒绝跨来源、路径、非图像身份与异常编码，不读取档案目录', async () => {
  let roots = 0
  const service = createCassetteCatalogService({
    dataDirectory: () => { roots++; return undefined },
    chooseArchive: async () => null,
    request: async () => { throw new Error('不应请求Core') },
  })
  for (const url of [
    'file:///private/secret', 'https://app/reference-assets/' + 'a'.repeat(64) + '/image',
    'musicbridge://other/reference-assets/' + 'a'.repeat(64) + '/image',
    'musicbridge://app/reference-assets/' + 'a'.repeat(64) + '/image?path=/private/secret',
    'musicbridge://app/reference-assets/' + 'a'.repeat(64) + '/%2Fprivate%2Fsecret',
    'musicbridge://app/reference-assets/' + 'a'.repeat(64) + '/%zz',
    'musicbridge://app/reference-assets/not-a-hash/image',
  ]) assert.equal((await service.image(url, 'GET')).status, 404, url)
  assert.equal((await service.image(cassetteAssetUrl('a'.repeat(64), 'image'), 'POST')).status, 404)
  for (const value of [{ sha256: 'a'.repeat(64), referenceId: '../secret' }, { sha256: 'a'.repeat(64), referenceId: 'known', path: '/private/secret' }])
    await assert.rejects(service.detail(value), /磁带资料/u)
  assert.equal(roots, 0)
})

test('取消完整档案选择不会读取Core或创建目录', async () => {
  let requests = 0, roots = 0
  const service = createCassetteCatalogService({
    dataDirectory: () => { roots++; return undefined },
    chooseArchive: async () => null,
    request: async () => { requests++; throw new Error('不应请求Core') },
  })
  assert.equal(await service.pick(), null)
  assert.equal(requests, 0)
  assert.equal(roots, 0)
})
