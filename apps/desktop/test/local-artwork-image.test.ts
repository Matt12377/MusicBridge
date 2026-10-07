import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import type { PhotoDecoderImage } from '../src/main/collection-photos.js'
import { LocalArtworkImageError, normalizeLocalArtwork, readLocalArtworkFile } from '../src/main/local-artwork-image.js'

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function pngChunk(type: string, body = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(body.length + 12)
  chunk.writeUInt32BE(body.length, 0); chunk.write(type, 4, 'latin1'); body.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}
function pngHeader(width = 1, height = 1): Buffer {
  const body = Buffer.alloc(13)
  body.writeUInt32BE(width, 0); body.writeUInt32BE(height, 4); body[8] = 8; body[9] = 2
  return pngChunk('IHDR', body)
}
const imageData = () => pngChunk('IDAT', deflateSync(Buffer.from([0, 40, 80, 120])))
// 尺寸不为1的容器仅供 fake 边界测试；不能据此声称压缩像素或 native 解码有效。
function png(width = 1, height = 1, ancillary: Buffer[] = []): Buffer {
  return Buffer.concat([signature, pngHeader(width, height), ...ancillary, imageData(), pngChunk('IEND')])
}
function jpegSegment(marker: number, body: Buffer): Buffer {
  const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([header, body])
}
function jpegFrame(width: number, height: number, marker = 192): Buffer {
  const body = Buffer.from([8, 0, 0, 0, 0, 1, 1, 17, 0])
  body.writeUInt16BE(height, 1); body.writeUInt16BE(width, 3)
  return jpegSegment(marker, body)
}
function jpegTables(): Buffer[] {
  const quantizer = Buffer.alloc(65, 1); quantizer[0] = 0
  const table = (info: number) => { const body = Buffer.alloc(18); body[0] = info; body[1] = 1; return body }
  return [jpegSegment(219, quantizer), jpegSegment(196, Buffer.concat([table(0), table(16)]))]
}
const jpegScan = (start = 0, end = 63) => jpegSegment(218, Buffer.from([1, 1, 0, start, end, 0]))
// 合成表段/扫描容器与fake decoder只证明本模块边界，不构成真实JPEG解码证据。
function jpeg(width = 1, height = 1, metadata: Buffer[] = [], entropy = Buffer.from([63])): Buffer {
  return Buffer.concat([Buffer.from([255, 216]), ...metadata, ...jpegTables(), jpegFrame(width, height), jpegScan(), entropy, Buffer.from([255, 217])])
}
interface DecoderHooks {
  empty?: boolean
  qualities?: number[]
  resized?: { width: number; height: number; quality: 'best' }[]
  output?: (width: number, height: number) => Buffer
}
function fakeDecoder(width = 1, height = 1, hooks: DecoderHooks = {}): PhotoDecoderImage {
  return {
    isEmpty: () => hooks.empty ?? false,
    getSize: () => ({ width, height }),
    resize: size => { hooks.resized?.push(size); return fakeDecoder(size.width, size.height, hooks) },
    toJPEG: quality => { hooks.qualities?.push(quality); return hooks.output?.(width, height) ?? jpeg(width, height) },
  }
}
function rejectBeforeDecode(bytes: Buffer, message?: RegExp): void {
  let calls = 0
  assert.throws(() => normalizeLocalArtwork(bytes, () => { calls++; return fakeDecoder() }), error => {
    assert.ok(error instanceof LocalArtworkImageError)
    if (message) assert.match(error.message, message)
    return true
  })
  assert.equal(calls, 0, '非法结构或头预算必须在调用native适配器前阻断')
}

test('合成PNG归一化分开保存原始与展示字节身份，输入不变', () => {
  const input = png(), before = Buffer.from(input), output = jpeg()
  const result = normalizeLocalArtwork(input, received => { assert.deepEqual(received, input); return fakeDecoder() })
  assert.deepEqual(input, before)
  assert.deepEqual(result.original, { mime: 'image/png', bytes: input.length, sha256: hash(input), width: 1, height: 1 })
  assert.deepEqual(result.display, { mime: 'image/jpeg', bytes: output.length, sha256: hash(output), width: 1, height: 1, dataUrl: 'data:image/jpeg;base64,' + output.toString('base64') })
  assert.notEqual(result.original.sha256, result.display.sha256)
})

test('合成JPEG保留输入Hash，展示副本独立重编码与去掉输入元数据', () => {
  const input = jpeg(1, 1, [jpegSegment(254, Buffer.from('合成说明'))]), qualities: number[] = []
  const result = normalizeLocalArtwork(input, () => fakeDecoder(1, 1, { qualities }))
  assert.equal(result.original.mime, 'image/jpeg'); assert.equal(result.original.sha256, hash(input))
  assert.equal(result.display.sha256, hash(jpeg())); assert.notEqual(result.original.sha256, result.display.sha256)
  assert.deepEqual(qualities, [85])
})

test('合成大图按比例缩到1200并核对副本几何，小图不放大', () => {
  const resized: NonNullable<DecoderHooks['resized']> = [], qualities: number[] = []
  const result = normalizeLocalArtwork(png(2400, 1200), () => fakeDecoder(2400, 1200, { resized, qualities }))
  assert.deepEqual(resized, [{ width: 1200, height: 600, quality: 'best' }])
  assert.deepEqual([result.display.width, result.display.height], [1200, 600]); assert.deepEqual(qualities, [85])
  resized.length = 0
  normalizeLocalArtwork(png(), () => fakeDecoder(1, 1, { resized }))
  assert.deepEqual(resized, [])
})

test('压缩字节4MiB边界先于结构与解码检查', () => {
  rejectBeforeDecode(Buffer.alloc(4 * 1024 * 1024 + 1), /4 MiB/u)
  rejectBeforeDecode(Buffer.alloc(0), /4 MiB/u)
  const atLimit = Buffer.alloc(4 * 1024 * 1024)
  assert.throws(() => normalizeLocalArtwork(atLimit, () => fakeDecoder()), /结构/u, '恰好4MiB走格式检查而非压缩超限')
})

test('声明尺寸超限与零尺寸在native前拒绝，4096方图按独立RGBA预算校核', () => {
  for (const input of [png(0, 1), png(4097, 1), png(1, 4097)]) rejectBeforeDecode(input, /像素/u)
  const result = normalizeLocalArtwork(png(4096, 4096), () => fakeDecoder(4096, 4096))
  assert.deepEqual([result.original.width, result.original.height], [4096, 4096])
  assert.deepEqual([result.display.width, result.display.height], [1200, 1200])
})

test('魔术头不能冒充完整图片，截断PNG/JPEG与非图像均在native前失败', () => {
  for (const input of [signature, Buffer.from([255, 216, 255, 217]), png().subarray(0, -1), jpeg().subarray(0, -2), Buffer.from('<svg width="1"/>')]) rejectBeforeDecode(input)
})

test('PNG每个chunk必须具有准确长度与CRC，高位类型字符不能当ASCII通过', () => {
  const badCrc = png(); badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 1
  const badLength = png(); badLength.writeUInt32BE(0xffffffff, 8)
  const highBitType = pngChunk('\u00e1BCD')
  for (const input of [badCrc, badLength, png(1, 1, [highBitType])]) rejectBeforeDecode(input)
})

test('PNG拒绝重复头、IDAT断续、缺少数据、尾随字节和未知关键chunk', () => {
  for (const input of [
    png(1, 1, [pngHeader()]),
    Buffer.concat([signature, pngHeader(), imageData(), pngChunk('tEXt', Buffer.from('key\0value')), imageData(), pngChunk('IEND')]),
    Buffer.concat([signature, pngHeader(), pngChunk('IEND')]),
    Buffer.concat([png(), Buffer.from([0])]),
    png(1, 1, [pngChunk('ABCD')]),
  ]) rejectBeforeDecode(input)
})

test('APNG三个动画chunk均显式拒绝，不以第一帧冒充单帧封面', () => {
  for (const type of ['acTL', 'fcTL', 'fdAT']) rejectBeforeDecode(png(1, 1, [pngChunk(type, Buffer.alloc(8))]), /APNG/u)
})

test('PNG元数据输入与压缩展开共用有界总预算', () => {
  rejectBeforeDecode(png(1, 1, [pngChunk('tEXt', Buffer.alloc(256 * 1024 + 1))]), /元数据/u)
  const expanded = Buffer.alloc(256 * 1024 + 1)
  const text = Buffer.concat([Buffer.from('comment\0'), Buffer.from([0]), deflateSync(expanded)])
  rejectBeforeDecode(png(1, 1, [pngChunk('zTXt', text)]), /元数据/u)
  const small = Buffer.concat([Buffer.from('comment\0'), Buffer.from([0]), deflateSync(Buffer.from('说明'))])
  assert.equal(normalizeLocalArtwork(png(1, 1, [pngChunk('zTXt', small)]), () => fakeDecoder()).original.mime, 'image/png')
})

test('PNG非法压缩元数据与非法IHDR模式在native之前失败', () => {
  rejectBeforeDecode(png(1, 1, [pngChunk('iCCP', Buffer.from('profile\0\0invalid'))]), /元数据/u)
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 7; header[9] = 2
  rejectBeforeDecode(Buffer.concat([signature, pngChunk('IHDR', header), imageData(), pngChunk('IEND')]))
})

test('PNG调色板和透明度必须满足颜色类型及顺序', () => {
  rejectBeforeDecode(png(1, 1, [pngChunk('PLTE', Buffer.from([0, 0]))]))
  rejectBeforeDecode(png(1, 1, [pngChunk('tRNS', Buffer.alloc(2))]))
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 1; header[9] = 3
  rejectBeforeDecode(Buffer.concat([signature, pngChunk('IHDR', header), imageData(), pngChunk('IEND')]))
})

test('MPO标识、重复SOF和EOI后的第二张图必须拒绝', () => {
  rejectBeforeDecode(jpeg(1, 1, [jpegSegment(226, Buffer.from('MPF\0synthetic'))]), /MPO/u)
  rejectBeforeDecode(jpeg(1, 1, [jpegFrame(1, 1)]))
  rejectBeforeDecode(Buffer.concat([jpeg(), jpeg()]))
})

test('JPEG segment长度、表段边界与扫描头不合法时拒绝', () => {
  const shortSegment = jpeg(); shortSegment.writeUInt16BE(1, 4)
  const oversizedSegment = jpeg(); oversizedSegment.writeUInt16BE(0xffff, 4)
  const missingTable = Buffer.concat([Buffer.from([255, 216]), jpegFrame(1, 1), jpegScan(), Buffer.from([63, 255, 217])])
  const badDht = Buffer.concat([Buffer.from([255, 216]), jpegSegment(196, Buffer.alloc(17)), ...jpegTables(), jpegFrame(1, 1), jpegScan(), Buffer.from([63, 255, 217])])
  for (const input of [shortSegment, oversizedSegment, missingTable, badDht]) rejectBeforeDecode(input)
})

test('JPEG空扫描、未转义FF与尾随垃圾不能通过结构检查', () => {
  for (const input of [jpeg(1, 1, [], Buffer.alloc(0)), jpeg(1, 1, [], Buffer.from([255, 1])), Buffer.concat([jpeg(), Buffer.from('tail')])]) rejectBeforeDecode(input)
})

test('合成JPEG扫描处理FF00转义，restart必须有DRI且顺序正确', () => {
  assert.equal(normalizeLocalArtwork(jpeg(1, 1, [], Buffer.from([63, 255, 0, 63])), () => fakeDecoder()).original.mime, 'image/jpeg')
  rejectBeforeDecode(jpeg(1, 1, [], Buffer.from([63, 255, 208, 63])))
  const dri = jpegSegment(221, Buffer.from([0, 1]))
  const good = jpeg(1, 1, [dri], Buffer.from([63, 255, 208, 63]))
  assert.equal(normalizeLocalArtwork(good, () => fakeDecoder()).original.mime, 'image/jpeg')
  rejectBeforeDecode(jpeg(1, 1, [dri], Buffer.from([63, 255, 209, 63])))
})

test('合成渐进JPEG允许有界多扫描，禁止不合法频段', () => {
  const make = (end: number) => Buffer.concat([Buffer.from([255, 216]), ...jpegTables(), jpegFrame(1, 1, 194), jpegScan(0, end), Buffer.from([63]), jpegScan(1, 63), Buffer.from([63, 255, 217])])
  assert.equal(normalizeLocalArtwork(make(0), () => fakeDecoder()).original.mime, 'image/jpeg')
  rejectBeforeDecode(make(63))
})

test('JPEG APP和COM累计元数据超限在native前失败', () => {
  rejectBeforeDecode(jpeg(1, 1, Array.from({ length: 5 }, () => jpegSegment(254, Buffer.alloc(60_000)))), /元数据/u)
})

test('fake解码为空、异常和实际尺寸不一致均失败且不暴露内部路径', () => {
  assert.throws(() => normalizeLocalArtwork(png(), () => fakeDecoder(1, 1, { empty: true })), /完整解码/u)
  assert.throws(() => normalizeLocalArtwork(png(), () => fakeDecoder(2, 1)), /不一致/u)
  for (const size of [0, 4097, Number.NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => normalizeLocalArtwork(png(), () => fakeDecoder(size, 1)), /像素/u)
  assert.throws(() => normalizeLocalArtwork(png(), () => { throw new Error('/合成秘密/封面.png') }), error => error instanceof LocalArtworkImageError && !error.message.includes('/合成秘密'))
})

test('fake缩放结果错误或为空时不能编码并返回部分副本', () => {
  const source = fakeDecoder(2400, 1200)
  assert.throws(() => normalizeLocalArtwork(png(2400, 1200), () => ({ ...source, resize: () => fakeDecoder(2, 2) })), /尺寸不一致/u)
  assert.throws(() => normalizeLocalArtwork(png(2400, 1200), () => ({ ...source, resize: () => fakeDecoder(1200, 600, { empty: true }) })), /缩放失败/u)
})

test('展示JPEG必须完整、尺寸相符且压缩字节不超过1MiB', () => {
  for (const output of [Buffer.alloc(1024 * 1024 + 1), Buffer.from([255, 216, 255, 217]), png(), jpeg(2, 1)]) {
    assert.throws(() => normalizeLocalArtwork(png(), () => fakeDecoder(1, 1, { output: () => output })), LocalArtworkImageError)
  }
})

async function fixture(t: test.TestContext): Promise<string> {
  const root = process.env.TMPDIR ?? os.tmpdir()
  if (process.platform === 'darwin' && !(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')) {
    assert.ok(path.isAbsolute(root) && root.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'), '本机测试TMPDIR必须设置到当前任务的外置临时目录')
  }
  await fs.access(root, constants.W_OK)
  const directory = await fs.mkdtemp(path.join(root, 'musicbridge-local-artwork-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}
function observedHandle(handle: FileHandle, options: { afterRead?: () => Promise<void>; beforeRead?: () => void; closed: () => void }): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
        options.beforeRead?.()
        const result = await target.read(buffer, offset, length, position)
        await options.afterRead?.()
        return result
      }
      if (property === 'close') return async () => { options.closed(); await target.close() }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('真实合成文件只读原字节，FD在成功后关闭且不修改来源', async t => {
  const directory = await fixture(t), file = path.join(directory, 'source.png'), input = png()
  await fs.writeFile(file, input)
  const before = await fs.stat(file, { bigint: true }), realOpen = fs.open
  let closed = 0
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => observedHandle(await realOpen(...args), { closed: () => { closed++ } }))
  assert.deepEqual(await readLocalArtworkFile(file), input)
  assert.equal(closed, 1)
  assert.deepEqual(await fs.readFile(file), input)
  const after = await fs.stat(file, { bigint: true })
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs], [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs])
})

test('读取拒绝相对路径、NUL、符号链接、目录与缺失文件，错误不含来源路径', async t => {
  const directory = await fixture(t), file = path.join(directory, 'source.png'), link = path.join(directory, 'link.png')
  await fs.writeFile(file, png()); await fs.symlink(file, link)
  for (const name of ['relative.png', file + '\0', link, directory, path.join(directory, 'missing.png')]) {
    await assert.rejects(readLocalArtworkFile(name), error => error instanceof LocalArtworkImageError && !error.message.includes(directory))
  }
})

test('空文件与大于4MiB文件在打开FD前拒绝', async t => {
  const directory = await fixture(t), empty = path.join(directory, 'empty.png'), oversized = path.join(directory, 'oversized.png')
  await fs.writeFile(empty, Buffer.alloc(0)); await fs.writeFile(oversized, Buffer.alloc(4 * 1024 * 1024 + 1))
  let opened = 0
  t.mock.method(fs, 'open', async () => { opened++; throw new Error('不应打开') })
  await assert.rejects(readLocalArtworkFile(empty), /普通文件/u)
  await assert.rejects(readLocalArtworkFile(oversized), /4 MiB/u)
  assert.equal(opened, 0)
})

test('lstat与open后fstat之间的变化被拒绝并关闭真实FD', async t => {
  const directory = await fixture(t), file = path.join(directory, 'changing.png')
  await fs.writeFile(file, png())
  const realOpen = fs.open; let closed = 0
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args)
    await fs.writeFile(file, jpeg())
    return observedHandle(handle, { closed: () => { closed++ } })
  })
  await assert.rejects(readLocalArtworkFile(file), /读取前发生变化/u)
  assert.equal(closed, 1)
})

test('读取期间内容和纳秒时间变化被拒绝，失败仍关闭FD', async t => {
  const directory = await fixture(t), file = path.join(directory, 'changing.png')
  await fs.writeFile(file, png())
  const realOpen = fs.open; let closed = 0, changed = false
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => observedHandle(await realOpen(...args), {
    closed: () => { closed++ },
    afterRead: async () => {
      if (changed) return
      changed = true
      await fs.writeFile(file, Buffer.from(png()).fill(7, 45, 46))
      const future = new Date(Date.now() + 10_000); await fs.utimes(file, future, future)
    },
  }))
  await assert.rejects(readLocalArtworkFile(file), /读取时发生变化/u)
  assert.equal(closed, 1)
})

test('读取异常清理FD并把底层路径错误替换为中文公开提示', async t => {
  const directory = await fixture(t), file = path.join(directory, 'source.png')
  await fs.writeFile(file, png())
  const realOpen = fs.open; let closed = 0
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => observedHandle(await realOpen(...args), {
    closed: () => { closed++ }, beforeRead: () => { throw new Error(file) },
  }))
  await assert.rejects(readLocalArtworkFile(file), error => error instanceof LocalArtworkImageError && /无法安全读取/u.test(error.message) && !error.message.includes(file))
  assert.equal(closed, 1)
})

test('读取期间路径换到另一inode不能返回旧候选，两个合成文件均保留', async t => {
  const directory = await fixture(t), file = path.join(directory, 'source.png'), prior = path.join(directory, 'prior.png')
  await fs.writeFile(file, png())
  const realOpen = fs.open; let closed = 0, replaced = false
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => observedHandle(await realOpen(...args), {
    closed: () => { closed++ },
    afterRead: async () => {
      if (replaced) return
      replaced = true
      await fs.rename(file, prior); await fs.writeFile(file, png())
    },
  }))
  await assert.rejects(readLocalArtworkFile(file), error => error instanceof LocalArtworkImageError && /变化/u.test(error.message))
  assert.equal(closed, 1); assert.deepEqual(await fs.readFile(prior), png()); assert.deepEqual(await fs.readFile(file), png())
})
