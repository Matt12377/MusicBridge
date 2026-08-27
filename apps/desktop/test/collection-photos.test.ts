import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pickCollectionPhoto, type PhotoDecoderImage } from '../src/main/collection-photos.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZAAAAABJRU5ErkJggg==', 'base64')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
function decoder(width = 1, height = 1): PhotoDecoderImage {
  return { isEmpty: () => false, getSize: () => ({ width, height }), resize: size => decoder(size.width, size.height), toJPEG: () => jpeg }
}
test('照片选择取消不读取文件，不调用解码器', async () => {
  assert.equal(await pickCollectionPhoto(async () => ({ canceled: true, filePaths: [] }), () => { throw new Error('不应调用') }), null)
})
test('照片导入只读取选择文件，生成有界副本且原文件字节不变', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-photos-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'sample.png'); await writeFile(filePath, png)
  const result = await pickCollectionPhoto(async () => ({ canceled: false, filePaths: [filePath] }), bytes => { assert.deepEqual(bytes, png); return decoder() })
  assert.deepEqual(result, { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 })
  assert.deepEqual(await readFile(filePath), png)
})
test('拒绝符号链接、伪装格式、像素炸弹和缺失路径；错误不泄露文件位置', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-photos-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const good = path.join(directory, 'source.png'); await writeFile(good, png)
  const link = path.join(directory, 'link.png'); await symlink(good, link)
  const fake = path.join(directory, 'fake.jpg'); await writeFile(fake, png)
  const bomb = path.join(directory, 'bomb.png'); const large = Buffer.from(png); large.writeUInt32BE(50000, 16); await writeFile(bomb, large)
  for (const file of [link, fake, bomb, path.join(directory, 'missing.png'), directory]) {
    await assert.rejects(pickCollectionPhoto(async () => ({ canceled: false, filePaths: [file] }), () => { throw new Error('非法文件不应解码') }), (e: Error) => !e.message.includes(directory) && !e.message.includes('不应解码'))
  }
})
test('解码失败和展示副本超限明确失败，不返回部分照片', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-photos-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'sample.png'); await writeFile(filePath, png)
  const select = async () => ({ canceled: false, filePaths: [filePath] })
  await assert.rejects(pickCollectionPhoto(select, () => ({ ...decoder(), isEmpty: () => true })), /无法解码/u)
  await assert.rejects(pickCollectionPhoto(select, () => { throw new Error(filePath) }), e => e instanceof Error && !e.message.includes(filePath))
  await assert.rejects(pickCollectionPhoto(select, () => ({ ...decoder(), toJPEG: () => Buffer.alloc(2_000_000) })), /过大/u)
})
