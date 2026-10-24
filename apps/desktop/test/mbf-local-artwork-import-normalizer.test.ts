import { closeRustMediaWorkerPool } from '../../../packages/bridge-core/src/library/rust-media-worker.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { after } from 'node:test'
import { deflateSync } from 'node:zlib'
import type { PhotoDecoderImage } from '../src/main/collection-photos.js'
import { LocalArtworkImageError } from '../src/main/local-artwork-image.js'
import { normalizeImportedLocalArtwork } from '../src/main/local-library-workbench/artwork-import-normalizer.js'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function jpegSegment(marker: number, body: Buffer): Buffer {
  const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([header, body])
}
function jpeg(width = 1, height = 1): Buffer {
  const quantizer = Buffer.alloc(65, 1); quantizer[0] = 0
  const table = (value: number) => { const bytes = Buffer.alloc(18); bytes[0] = value; bytes[1] = 1; return bytes }
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 17, 0]); frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3)
  return Buffer.concat([Buffer.from([255, 216]), jpegSegment(219, quantizer), jpegSegment(196, Buffer.concat([table(0), table(16)])), jpegSegment(192, frame), jpegSegment(218, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([63, 255, 217])])
}
function pngChunk(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(body.length + 12); chunk.writeUInt32BE(body.length, 0); chunk.write(type, 4, 'latin1'); body.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, chunk.length - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4); return chunk
}
function png(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 20, 40, 60]))), pngChunk('IEND')])
}
function decoder(width = 1, height = 1, output?: (width: number, height: number) => Buffer): PhotoDecoderImage {
  return { isEmpty: () => false, getSize: () => ({ width, height }), resize: size => decoder(size.width, size.height, output), toJPEG: () => output?.(width, height) ?? jpeg(width, height) }
}
function chunk(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8); header.write(type, 0, 'latin1'); header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body, ...(body.length & 1 ? [Buffer.from([0])] : [])])
}
function webp(chunks: readonly Buffer[] = [chunk('VP8 ', lossy())]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks]), header = Buffer.alloc(8)
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body])
}
function lossy(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(12); bytes[0] = 0x30; bytes.set([0x9d, 0x01, 0x2a], 3); bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8); bytes[10] = 1; bytes[11] = 1; return bytes
}
function lossless(width = 1, height = 1): Buffer {
  const bytes = Buffer.from([0x2f, 0, 0, 0, 0, 1]); bytes.writeUInt32LE(((width - 1) | (height - 1) << 14) >>> 0, 1); return bytes
}
function extended(flags = 0, width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(10); bytes[0] = flags; bytes.writeUIntLE(width - 1, 4, 3); bytes.writeUIntLE(height - 1, 7, 3); return chunk('VP8X', bytes)
}
interface Field { tag: number; type: number; values: number[] | Buffer; pixels?: boolean }
interface TiffOptions { big?: boolean; little?: boolean; width?: number; height?: number; orientation?: number; rows?: number; bits?: number[]; samples?: number; compression?: number; tiled?: { width: number; height: number }; blocks?: Buffer[]; extra?: Field[] }
/** 合成 TIFF/WebP/JPEG 结构与注入 decoder 只证明边界，不构成真实压缩像素或 native 解码证据。 */
function tiff(options: TiffOptions = {}) {
  const big = options.big ?? false, little = options.little ?? true, width = options.width ?? 1, height = options.height ?? 1
  const samples = options.samples ?? 1, bits = options.bits ?? [8], blocks = options.blocks ?? [Buffer.alloc(1)], unit = big ? 8 : 2, headerSize = big ? 16 : 8
  const fields: Field[] = [
    { tag: 256, type: 4, values: [width] }, { tag: 257, type: 4, values: [height] }, { tag: 258, type: 3, values: bits },
    { tag: 259, type: 3, values: [options.compression ?? 1] }, { tag: 262, type: 3, values: [samples >= 3 ? 2 : 1] },
    { tag: 274, type: 3, values: [options.orientation ?? 1] }, { tag: 277, type: 3, values: [samples] },
    ...(options.tiled ? [
      { tag: 322, type: 4, values: [options.tiled.width] }, { tag: 323, type: 4, values: [options.tiled.height] },
      { tag: 324, type: big ? 16 : 4, values: blocks.map(() => 0), pixels: true }, { tag: 325, type: big ? 16 : 4, values: blocks.map(value => value.length) },
    ] : [
      { tag: 273, type: big ? 16 : 4, values: blocks.map(() => 0), pixels: true }, { tag: 278, type: 4, values: [options.rows ?? height] },
      { tag: 279, type: big ? 16 : 4, values: blocks.map(value => value.length) },
    ]), ...(options.extra ?? []),
  ].sort((a, b) => a.tag - b.tag)
  const inline = big ? 8 : 4, entrySize = big ? 20 : 12, countSize = big ? 8 : 2
  const align = (value: number) => Math.ceil(value / unit) * unit
  const widths: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1, 13: 4, 16: 8, 18: 8 }
  const length = (field: Field) => field.values instanceof Buffer ? field.values.length : field.values.length * widths[field.type]!
  let end = align(headerSize + countSize + fields.length * entrySize + inline)
  const payloads = fields.map(field => { if (length(field) <= inline) return null; const at = end; end = align(end + length(field)); return at })
  const pixelOffsets = blocks.map(block => { const at = end; end += block.length; return at })
  const bytes = Buffer.alloc(end)
  const u16 = (value: number, at: number) => little ? bytes.writeUInt16LE(value, at) : bytes.writeUInt16BE(value, at)
  const u32 = (value: number, at: number) => little ? bytes.writeUInt32LE(value, at) : bytes.writeUInt32BE(value, at)
  const offset = (value: number, at: number) => big ? little ? bytes.writeBigUInt64LE(BigInt(value), at) : bytes.writeBigUInt64BE(BigInt(value), at) : u32(value, at)
  bytes.write(little ? 'II' : 'MM', 0, 'ascii'); u16(big ? 43 : 42, 2)
  if (big) { u16(8, 4); offset(headerSize, 8); offset(fields.length, headerSize) } else { u32(headerSize, 4); u16(fields.length, headerSize) }
  const entries = new Map<number, number>()
  fields.forEach((field, index) => {
    const at = headerSize + countSize + index * entrySize, valueAt = at + (big ? 12 : 8); entries.set(field.tag, at)
    u16(field.tag, at); u16(field.type, at + 2)
    const count = field.values.length; if (big) offset(count, at + 4); else u32(count, at + 4)
    const payload = payloads[index]; if (payload !== null && payload !== undefined) offset(payload, valueAt)
    const start = payload ?? valueAt, values = field.pixels ? pixelOffsets : field.values
    if (values instanceof Buffer) values.copy(bytes, start)
    else values.forEach((value, nth) => { const pos = start + nth * widths[field.type]!; if (field.type === 3) u16(value, pos); else if ([16, 18].includes(field.type)) offset(value, pos); else u32(value, pos) })
  })
  blocks.forEach((block, index) => block.copy(bytes, pixelOffsets[index]!))
  return { bytes, entries, pixelOffsets, nextAt: headerSize + countSize + fields.length * entrySize, valueAt: (tag: number) => entries.get(tag)! + (big ? 12 : 8), u16, u32, offset }
}
function rejectBeforeDecode(bytes: Buffer, message?: RegExp): void {
  let calls = 0
  assert.throws(() => normalizeImportedLocalArtwork(bytes, () => { calls++; return decoder() }), error => {
    assert.ok(error instanceof LocalArtworkImageError); if (message) assert.match(error.message, message); return true
  })
  assert.equal(calls, 0, '非法结构、帧数或预算必须在 native 解码前拒绝')
}

test('JPEG/PNG沿用严格归一化，私有输入和公开兼容原图保持原身份及输入copy', () => {
  for (const [mime, bytes] of [['image/jpeg', jpeg()], ['image/png', png()]] as const) {
    const before = Buffer.from(bytes), received: Buffer[] = []
    const result = normalizeImportedLocalArtwork(bytes, value => { received.push(value); return decoder() })
    assert.deepEqual(bytes, before); assert.equal(received.length, 1); assert.notEqual(received[0], bytes)
    assert.deepEqual(result.input, { mime, bytes: bytes.length, sha256: hash(bytes), converted: false })
    assert.equal(result.image.original.mime, mime); assert.equal(result.image.original.sha256, hash(bytes)); assert.deepEqual(result.compatibleOriginalBytes, new Uint8Array(bytes)); assert.equal(result.conversionLabel, null)
  }
  rejectBeforeDecode(Buffer.from([255, 216, 255, 217]), /结构/u)
  const badCrc = png(); badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 1; rejectBeforeDecode(badCrc, /结构/u)
})

test('TIFF/WebP转换JPEG后再走旧严格管线，公开original不会冒称原输入', () => {
  for (const [mime, bytes] of [['image/tiff', tiff().bytes], ['image/webp', webp()]] as const) {
    const calls: Buffer[] = [], encoded = jpeg(), result = normalizeImportedLocalArtwork(bytes, value => { calls.push(value); return decoder(1, 1, () => encoded) })
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], bytes); assert.deepEqual(calls[1], jpeg())
    assert.deepEqual(result.input, { mime, bytes: bytes.length, sha256: hash(bytes), converted: true })
    assert.equal(result.image.original.mime, 'image/jpeg'); assert.equal(result.image.original.sha256, hash(jpeg())); assert.notEqual(result.image.original.sha256, result.input.sha256)
    assert.deepEqual(result.compatibleOriginalBytes, new Uint8Array(jpeg())); assert.match(result.conversionLabel!, /转换为 JPEG 兼容副本/u)
    assert.deepEqual(Object.keys(result.image.original).sort(), ['bytes', 'height', 'mime', 'sha256', 'width'])
    encoded.fill(0); bytes.fill(0); assert.deepEqual(result.compatibleOriginalBytes, new Uint8Array(jpeg())); assert.equal(result.image.original.sha256, hash(jpeg()))
  }
})

test('单帧Classic TIFF和BigTIFF的大小端入口均保留，方向旋转尺寸可校核', () => {
  for (const big of [false, true]) for (const little of [false, true]) {
    const result = normalizeImportedLocalArtwork(tiff({ big, little }).bytes, () => decoder())
    assert.equal(result.input.mime, 'image/tiff'); assert.equal(result.image.original.mime, 'image/jpeg')
  }
  const result = normalizeImportedLocalArtwork(tiff({ width: 2, height: 1, orientation: 6, blocks: [Buffer.alloc(2)] }).bytes, () => decoder(1, 2))
  assert.deepEqual([result.image.original.width, result.image.original.height], [1, 2])
})

test('WebP简单有损/无损及带元数据和alpha的扩展单帧均可进入注入解码器', () => {
  for (const bytes of [webp(), webp([chunk('VP8L', lossless())]), webp([extended(0x3c), chunk('ICCP', Buffer.from('合成ICC')), chunk('ALPH', Buffer.from([0, 128])), chunk('VP8 ', lossy()), chunk('EXIF', Buffer.from('合成Exif')), chunk('XMP ', Buffer.from('合成XMP'))])]) {
    let calls = 0; const result = normalizeImportedLocalArtwork(bytes, () => { calls++; return decoder() })
    assert.equal(calls, 2); assert.equal(result.input.mime, 'image/webp')
  }
})

test('WebP动画标志/ANIM/ANMF/额外图像及非法RIFF长度在native前拒绝', () => {
  for (const bytes of [webp([extended(2), chunk('VP8 ', lossy())]), webp([extended(), chunk('ANIM', Buffer.alloc(6)), chunk('VP8 ', lossy())]), webp([chunk('VP8 ', lossy()), chunk('ANMF', Buffer.alloc(16))]), webp([chunk('VP8 ', lossy()), chunk('VP8L', lossless())])]) rejectBeforeDecode(bytes, /多帧/u)
  const wrongSize = webp(); wrongSize.writeUInt32LE(1, 4); rejectBeforeDecode(wrongSize, /结构/u)
  const padding = webp([extended(0x20), chunk('ICCP', Buffer.from([1])), chunk('VP8 ', lossy())]); padding[12 + 18 + 9] = 1; rejectBeforeDecode(padding, /结构/u)
  rejectBeforeDecode(webp().subarray(0, -1), /结构/u)
})

test('WebP声明像素、帧头分区、画布匹配和alpha预算均先于native检查', () => {
  for (const bytes of [webp([chunk('VP8 ', lossy(4097, 1))]), webp([chunk('VP8L', lossless(4097, 1))]), webp([extended(0, 4097, 1), chunk('VP8 ', lossy())])]) rejectBeforeDecode(bytes, /像素/u)
  const partition = lossy(); partition[2] = 255
  const interframe = lossy(); interframe[0] = interframe[0]! | 1
  const version = lossless(); version[4] = 0x20
  for (const bytes of [webp([chunk('VP8 ', partition)]), webp([chunk('VP8 ', interframe)]), webp([chunk('VP8L', version)]), webp([extended(0, 2, 1), chunk('VP8 ', lossy())]), webp([extended(0x10), chunk('ALPH', Buffer.from([0, 128, 128])), chunk('VP8 ', lossy())]), webp([extended(0x10), chunk('ALPH', Buffer.from([2, 128])), chunk('VP8 ', lossy())]), webp([extended(0x20), chunk('VP8 ', lossy())])]) rejectBeforeDecode(bytes, /结构/u)
  rejectBeforeDecode(webp([extended(0x20), chunk('ICCP', Buffer.alloc(256 * 1024 + 1)), chunk('VP8 ', lossy())]), /元数据/u)
})

test('TIFF后续页、SubIFD、页身份和立体图像声明在native前拒绝', () => {
  const next = tiff(); next.offset(8, next.nextAt)
  for (const bytes of [next.bytes, tiff({ extra: [{ tag: 330, type: 4, values: [8] }] }).bytes, tiff({ extra: [{ tag: 297, type: 3, values: [0, 2] }] }).bytes, tiff({ extra: [{ tag: 254, type: 4, values: [2] }] }).bytes, tiff({ extra: [{ tag: 32997, type: 4, values: [2] }] }).bytes]) rejectBeforeDecode(bytes, /多帧/u)
  rejectBeforeDecode(tiff({ extra: [{ tag: 34665, type: 4, values: [8] }] }).bytes, /结构/u)
})

test('TIFF尺寸/样本展开/IFD字段/元数据预算及BigTIFF安全offset在native前拒绝', () => {
  rejectBeforeDecode(tiff({ width: 4097 }).bytes, /像素/u)
  rejectBeforeDecode(tiff({ width: 4096, height: 4096, samples: 4, bits: [64, 64, 64, 64] }).bytes, /展开/u)
  rejectBeforeDecode(tiff({ extra: [{ tag: 270, type: 7, values: Buffer.alloc(256 * 1024 + 1) }] }).bytes, /元数据/u)
  const fields = tiff(); fields.u16(513, 8); rejectBeforeDecode(fields.bytes, /结构/u)
  const unsafe = tiff({ big: true }); unsafe.bytes.writeBigUInt64LE(2n ** 63n, 8); rejectBeforeDecode(unsafe.bytes, /结构/u)
  const invalidBigHeader = tiff({ big: true }); invalidBigHeader.u16(4, 4); rejectBeforeDecode(invalidBigHeader.bytes, /结构/u)
})

test('TIFF条带必须完整、匹配且不覆盖结构/其他像素，瓦片展开有独立预算', () => {
  const headerOverlap = tiff(); headerOverlap.offset(0, headerOverlap.valueAt(273))
  const outside = tiff(); outside.offset(999999, outside.valueAt(273))
  const zeroCount = tiff(); zeroCount.offset(0, zeroCount.valueAt(279))
  const mismatch = tiff(); mismatch.offset(2, mismatch.valueAt(279))
  const shared = tiff({ height: 2, rows: 1, blocks: [Buffer.alloc(1), Buffer.alloc(1)] })
  const offsetsAt = shared.bytes.readUInt32LE(shared.valueAt(273)); shared.u32(shared.pixelOffsets[0]!, offsetsAt + 4)
  for (const bytes of [headerOverlap.bytes, outside.bytes, zeroCount.bytes, mismatch.bytes, shared.bytes]) rejectBeforeDecode(bytes, /结构/u)
  const tiles = tiff({ tiled: { width: 16, height: 16 }, blocks: [Buffer.alloc(256)] })
  assert.equal(normalizeImportedLocalArtwork(tiles.bytes, () => decoder()).input.mime, 'image/tiff')
  rejectBeforeDecode(tiff({ width: 4096, height: 4096, bits: [1], compression: 5, tiled: { width: 4095, height: 4095 }, blocks: [Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1)] }).bytes, /瓦片展开/u)
})

test('TIFF内JPEG不能以小IFD掩盖大帧/MPO，合成单帧可进入native', () => {
  rejectBeforeDecode(tiff({ compression: 7, blocks: [jpeg(4097, 1)] }).bytes, /像素/u)
  rejectBeforeDecode(tiff({ compression: 7, blocks: [Buffer.concat([Buffer.from([255, 216]), jpegSegment(226, Buffer.from('MPF\0', 'ascii')), jpeg().subarray(2)])] }).bytes, /多帧/u)
  assert.equal(normalizeImportedLocalArtwork(tiff({ compression: 7, blocks: [jpeg()] }).bytes, () => decoder()).input.mime, 'image/tiff')
})

test('native不支持TIFF/WebP时如实失败，异常细节不会穿透公开错误', () => {
  for (const [format, bytes] of [['TIFF', tiff().bytes], ['WebP', webp()]] as const) {
    let calls = 0
    assert.throws(() => normalizeImportedLocalArtwork(bytes, () => { calls++; throw new Error('私有地址 https://secret.invalid/secret') }), error => {
      assert.ok(error instanceof LocalArtworkImageError); assert.match(error.message, new RegExp(format, 'u')); assert.match(error.message, /解码器无法读取/u); assert.doesNotMatch(error.message, /secret/u); return true
    }); assert.equal(calls, 1)
    assert.throws(() => normalizeImportedLocalArtwork(bytes, () => ({ ...decoder(), isEmpty: () => true })), /解码器无法读取/u)
  }
})

test('TIFF/WebP解码尺寸及兼容JPEG输出重新校核，损坏/超预算副本不再调用native', () => {
  for (const bytes of [tiff().bytes, webp()]) {
    assert.throws(() => normalizeImportedLocalArtwork(bytes, () => decoder(2, 1)), /尺寸与文件声明不一致/u)
    for (const output of [Buffer.from([255, 216, 255, 217]), Buffer.alloc(4 * 1024 * 1024 + 1), jpeg(4097, 1)]) {
      let calls = 0
      assert.throws(() => normalizeImportedLocalArtwork(bytes, () => { calls++; return decoder(1, 1, () => output) }), LocalArtworkImageError)
      assert.equal(calls, 1, '转换副本也须通过完整结构及预算校验，再交第二次 native 解码')
    }
  }
  rejectBeforeDecode(Buffer.alloc(4 * 1024 * 1024 + 1), /4 MiB/u)
})

import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getRustMediaWorkerPool, RustMediaWorkerError, type RustMediaWorkerPool, type RustProcessImageResult } from '../../../packages/bridge-core/src/library/rust-media-worker.js'
import { createLocalArtworkImportNormalizer, type LocalArtworkNormalizationContext } from '../src/main/local-library-workbench/artwork-import-normalizer.js'

// 由仓库自有 owned-cover-16.png 经 cwebp -lossless 生成；不以假压缩帧头充当解码正例。
const ownedWebp = () => Buffer.from('UklGRjAAAABXRUJQVlA4TCMAAAAvD8ADALkKRPQ/drWoRMH7HwYibRs0BfOvd/D0qUX/I085FwA=', 'base64')
async function ownedImages() {
  const images = [
    { mime: 'image/webp' as const, bytes: ownedWebp(), sha256: 'e7d229527a1eb5f5c1018f1af8543c0d11185121b6068608bc4b103844a0132b' },
    { mime: 'image/png' as const, bytes: await readFile(new URL('../../../packages/bridge-core/test/fixtures/mbrs012-source/owned-cover-16.png', import.meta.url)), sha256: 'cbb5f0d4e01cedca1e94c0c6c5bb78c1e716834a0eb45ed2022c505dc500a7c6' },
    { mime: 'image/jpeg' as const, bytes: await readFile(new URL('../../../packages/bridge-core/test/fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)), sha256: '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d' },
  ]
  for (const image of images) assert.equal(hash(image.bytes), image.sha256)
  return images
}
function latch() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function observeSettlement(work: Promise<unknown>) {
  let settled = false
  void work.then(() => { settled = true }, () => { settled = true })
  return () => settled
}
const normalizationTurn = () => new Promise<void>(resolve => setImmediate(resolve))
function rustCancelled(error: unknown): boolean {
  assert.ok(error instanceof RustMediaWorkerError)
  assert.equal(error.name, 'RustMediaWorkerError'); assert.equal(error.code, 'CANCELLED')
  return true
}
interface ObservedImageCall {
  input: Parameters<RustMediaWorkerPool['processImage']>[0]
  signal: AbortSignal | undefined
  actual: Promise<RustProcessImageResult>
  delivered: Promise<RustProcessImageResult>
  release(): void
  holdExpired(): boolean
}
/** 只观察真实 processImage，门闩最多延迟原 Promise 交付1秒，成功值和失败对象均原样返回。 */
async function rustNormalizerComponent(t: test.TestContext, hold = false) {
  const temporary = process.env.TMPDIR
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'), '组件必须使用批准的外置临时根')
  const directory = await mkdtemp(path.join(temporary, 'artwork-memory-rust-'))
  const pool = getRustMediaWorkerPool(), processImage = pool.processImage
  const calls: ObservedImageCall[] = [], roots: string[] = [], ownedFiles: string[] = []
  const adapters: ReturnType<typeof createLocalArtworkImportNormalizer>[] = []
  let entered = latch(), decodeCalls = 0, spawnCalls = 0
  const observed = t.mock.method(pool, 'processImage', function (this: RustMediaWorkerPool, ...args: Parameters<RustMediaWorkerPool['processImage']>) {
    const gate = latch(); let expired = false, timer: ReturnType<typeof setTimeout> | undefined
    const release = () => { if (timer) clearTimeout(timer); gate.release() }
    if (hold) timer = setTimeout(() => { expired = true; release() }, 1000)
    else release()
    const actual = processImage.apply(this, args)
    const delivered = actual.finally(() => gate.promise)
    void delivered.catch(() => {})
    const call = { input: args[0], signal: args[1], actual, delivered, release, holdExpired: () => expired }
    calls.push(call); const notify = entered; entered = latch(); notify.release()
    return delivered
  })
  function createAdapter() {
    const privateRoot = path.join(directory, `unused-private-root-${roots.length}`); roots.push(privateRoot)
    const adapter = createLocalArtworkImportNormalizer({ privateRoot,
      decode() { decodeCalls++; throw new Error('内存Rust入口不得调用兼容decoder') },
      spawnProcess() { spawnCalls++; throw new Error('内存Rust入口不得逐图启动系统转换器') },
    })
    adapters.push(adapter); return adapter
  }
  const adapter = createAdapter()
  t.after(async () => {
    try { for (const call of calls) call.release(); await Promise.all(adapters.map(value => value.close())) }
    finally { observed.mock.restore(); await rm(directory, { recursive: true, force: true }) }
  })
  const context = (signal = new AbortController().signal, deadlineAtMs = performance.now() + 2000): LocalArtworkNormalizationContext => ({ signal, deadlineAtMs, assertCurrent() {} })
  async function waitForCall(index: number, work: Promise<unknown>): Promise<ObservedImageCall> {
    while (!calls[index]) await Promise.race([entered.promise, work.then(() => assert.fail('未派发真实Rust便已成功'), error => { throw error })])
    return calls[index]!
  }
  async function assertNoTemporaryCopies() {
    assert.equal(decodeCalls, 0); assert.equal(spawnCalls, 0)
    assert.deepEqual((await readdir(directory)).sort(), [...ownedFiles].sort())
    for (const root of roots) await assert.rejects(stat(root), { code: 'ENOENT' })
    assert.ok(calls.every(call => !call.holdExpired()), '观察门闩必须由用例显式释放，不能靠超时通过')
  }
  async function ownedFile(name: string, bytes: Buffer) {
    const file = path.join(directory, name); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); ownedFiles.push(name); return file
  }
  return { adapter, calls, context, waitForCall, assertNoTemporaryCopies, createAdapter, ownedFile }
}

test('内存Rust适配：真实WebP/PNG/JPEG保留捕获SHA、兼容字节和几何，不派逐图进程或临时副本', async t => {
  const h = await rustNormalizerComponent(t)
  for (const [index, fixture] of (await ownedImages()).entries()) {
    const before = Buffer.from(fixture.bytes), converted = fixture.mime === 'image/webp'
    const value = await h.adapter.normalize(fixture.bytes, h.context()), call = h.calls[index]!
    const actual = await call.actual
    assert.equal(await call.delivered, actual, '观察器必须返回原Rust结果对象')
    assert.notEqual(call.input.bytes, fixture.bytes); assert.deepEqual(call.input.bytes, before); assert.deepEqual(fixture.bytes, before)
    assert.deepEqual(value.input, { mime: fixture.mime, bytes: before.length, sha256: hash(before), converted })
    assert.deepEqual(actual.original, { mime: fixture.mime, width: 16, height: 16 })
    assert.deepEqual([value.image.original.width, value.image.original.height, value.image.display.width, value.image.display.height], [16, 16, 16, 16])
    assert.equal(value.image.original.mime, converted ? 'image/jpeg' : fixture.mime)
    if (converted) assert.ok(actual.compatible)
    const compatible = converted ? actual.compatible!.bytes : before
    assert.ok(value.compatibleOriginalBytes instanceof Uint8Array); assert.deepEqual(Buffer.from(value.compatibleOriginalBytes), Buffer.from(compatible))
    assert.equal(value.image.original.bytes, compatible.length); assert.equal(value.image.original.sha256, hash(compatible))
    if (converted) { assert.notEqual(value.input.sha256, value.image.original.sha256); assert.match(value.conversionLabel!, /转换为JPEG兼容副本/u) }
    else { assert.equal(value.conversionLabel, null); assert.equal(value.image.original.sha256, value.input.sha256) }
    const display = Buffer.from(value.image.display.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')
    assert.equal(hash(display), value.image.display.sha256); assert.equal(display.length, value.image.display.bytes); assert.deepEqual(display, Buffer.from(actual.bytes))
    assert.deepEqual([call.input.maxEdge, call.input.maxOutputBytes, call.input.gridSize], [1200, 768 * 1024, 512])
    assert.ok(actual.grid); assert.ok(actual.bytes.length <= 768 * 1024); assert.ok(actual.grid.bytes.length <= 256 * 1024); assert.ok(compatible.length <= 4 * 1024 * 1024)
    assert.deepEqual(h.adapter.inspect(), { active: 0, retained: 0, closing: false })
  }
  assert.equal(h.calls.length, 3); await h.assertNoTemporaryCopies()
})

test('内存Rust适配：预取消及原截止零派发，在途取消与原deadline等待真实Promise收口', async t => {
  const h = await rustNormalizerComponent(t, true), input = ownedWebp(), pre = new AbortController(); pre.abort()
  await assert.rejects(h.adapter.normalize(input, h.context(pre.signal)), { name: 'AbortError' })
  for (const deadline of [performance.now() - 1, NaN, Infinity]) await assert.rejects(h.adapter.normalize(input, h.context(undefined, deadline)), { name: 'AbortError' })
  assert.equal(h.calls.length, 0); assert.deepEqual(h.adapter.inspect(), { active: 0, retained: 0, closing: false })
  for (const mode of ['in-flight', 'parent', 'deadline'] as const) {
    const parent = new AbortController(), context = h.context(parent.signal, performance.now() + (mode === 'deadline' ? 180 : 2000))
    const index = h.calls.length, work = h.adapter.normalize(input, context), settled = observeSettlement(work), call = await h.waitForCall(index, work)
    assert.ok(call.signal); assert.equal(settled(), false)
    if (mode === 'in-flight') {
      parent.abort(); assert.equal(call.signal.aborted, true)
      let actualCancellation: unknown
      await assert.rejects(call.actual, error => { rustCancelled(error); actualCancellation = error; return true })
      assert.equal(settled(), false); assert.equal(h.adapter.inspect().active, 1)
      call.release(); await assert.rejects(work, error => error === actualCancellation)
      assert.deepEqual(h.adapter.inspect(), { active: 0, retained: 0, closing: false })
      continue
    }
    await call.actual; assert.equal(call.holdExpired(), false)
    // Rust结果是真实的；仅交付仍在途，不声称取消时native解码本身仍运行。
    if (mode === 'parent') parent.abort()
    else if (!call.signal.aborted) await new Promise<void>(resolve => call.signal!.addEventListener('abort', () => resolve(), { once: true }))
    assert.equal(call.signal.aborted, true); assert.equal(parent.signal.aborted, mode === 'parent')
    if (mode === 'deadline') {
      while (performance.now() < context.deadlineAtMs) await new Promise(resolve => setTimeout(resolve, Math.max(1, context.deadlineAtMs - performance.now())))
      assert.ok(performance.now() >= context.deadlineAtMs)
    }
    await normalizationTurn(); assert.equal(settled(), false); assert.equal(h.adapter.inspect().active, 1)
    call.release(); await assert.rejects(work, rustCancelled)
    assert.deepEqual(h.adapter.inspect(), { active: 0, retained: 0, closing: false })
  }
  assert.equal(h.calls.length, 3); await h.assertNoTemporaryCopies()
})

test('内存Rust适配：严格结构先拒绝，真实损坏压缩像素失败后仍可处理下一张自有图片', async t => {
  const h = await rustNormalizerComponent(t)
  const invalidCrc = png(); invalidCrc[invalidCrc.length - 1] = invalidCrc[invalidCrc.length - 1]! ^ 1
  for (const input of [Buffer.alloc(4 * 1024 * 1024 + 1), invalidCrc, webp([extended(2), chunk('VP8 ', lossy())]), webp([chunk('VP8 ', lossy(4097, 1))])]) {
    await assert.rejects(h.adapter.normalize(input, h.context()), LocalArtworkImageError)
  }
  assert.equal(h.calls.length, 0, '结构、帧数和输入预算先于真实Rust派发')
  const broken = webp(), before = Buffer.from(broken)
  await assert.rejects(h.adapter.normalize(broken, h.context()), error => {
    assert.ok(error instanceof LocalArtworkImageError); assert.doesNotMatch(error.message, /secret|Cookie|stack|https?:/u); return true
  })
  assert.equal(h.calls.length, 1); await assert.rejects(h.calls[0]!.actual, error => {
    assert.ok(error instanceof RustMediaWorkerError); assert.equal(error.code, 'PARSE_FAILED'); return true
  })
  assert.deepEqual(broken, before); assert.deepEqual(h.adapter.inspect(), { active: 0, retained: 0, closing: false })
  const input = (await ownedImages()).find(image => image.mime === 'image/png')!.bytes, captured = Buffer.from(input)
  const work = h.adapter.normalize(input, h.context()); input.fill(7) // 调用者主动改自己的buffer，原捕获不能跟着变化。
  const value = await work
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1]!.input.bytes, captured); assert.notEqual(h.calls[1]!.input.bytes, input)
  assert.equal(value.input.sha256, hash(captured)); assert.equal(value.image.original.sha256, hash(captured)); assert.deepEqual(Buffer.from(value.compatibleOriginalBytes), captured)
  assert.deepEqual([value.image.original.width, value.image.original.height], [16, 16]); await h.assertNoTemporaryCopies()
})

test('内存Rust适配：作者、父signal或deadline换代均拒绝真实迟到结果', async t => {
  const h = await rustNormalizerComponent(t, true), input = ownedWebp(), before = Buffer.from(input)
  for (const mode of ['owner', 'author', 'signal', 'deadline'] as const) {
    const parent = new AbortController(), context = h.context(parent.signal), identityError = new Error('原Main作者已经换代')
    let current = true; context.assertCurrent = () => { if (!current) throw identityError }
    const index = h.calls.length, work = h.adapter.normalize(input, context), call = await h.waitForCall(index, work)
    await call.actual; assert.equal(call.holdExpired(), false); assert.equal(h.adapter.inspect().active, 1)
    if (mode === 'owner') current = false
    else if (mode === 'author') context.assertCurrent = () => {}
    else if (mode === 'signal') context.signal = new AbortController().signal
    else context.deadlineAtMs += 1000
    call.release()
    if (mode === 'owner') await assert.rejects(work, error => error === identityError)
    else await assert.rejects(work, { name: 'AbortError' })
    assert.equal(parent.signal.aborted, false); assert.equal(call.signal!.aborted, false, '换代拒绝不能冒充超时或父取消')
    assert.deepEqual(input, before); assert.deepEqual(h.adapter.inspect(), { active: 0, retained: 0, closing: false })
  }
  assert.equal(h.calls.length, 4); await h.assertNoTemporaryCopies()
})

test('内存Rust适配：两槽有界且收口后可复用，close等待在途结果且不关闭共享Rust池', async t => {
  const h = await rustNormalizerComponent(t, true), input = ownedWebp()
  const first = h.adapter.normalize(input, h.context()), second = h.adapter.normalize(input, h.context())
  const a = await h.waitForCall(0, first), b = await h.waitForCall(1, second); await Promise.all([a.actual, b.actual])
  assert.equal(h.adapter.inspect().active, 2)
  await assert.rejects(h.adapter.normalize(input, h.context()), /封面处理槽位正忙/u); assert.equal(h.calls.length, 2)
  a.release(); await first; assert.equal(h.adapter.inspect().active, 1)
  const reused = h.adapter.normalize(input, h.context()), c = await h.waitForCall(2, reused); await c.actual
  assert.equal(h.adapter.inspect().active, 2); b.release(); await second; assert.equal(h.adapter.inspect().active, 1)
  const reusedSettled = observeSettlement(reused), close = h.adapter.close(), closeSettled = observeSettlement(close)
  assert.equal(h.adapter.close(), close); assert.equal(c.signal!.aborted, true)
  await normalizationTurn(); assert.equal(reusedSettled(), false); assert.equal(closeSettled(), false)
  assert.deepEqual(h.adapter.inspect(), { active: 1, retained: 0, closing: true })
  await assert.rejects(h.adapter.normalize(input, h.context()), { name: 'AbortError' }); assert.equal(h.calls.length, 3)
  c.release(); await assert.rejects(reused, rustCancelled); await close
  assert.deepEqual(h.adapter.inspect(), { active: 0, retained: 0, closing: true })
  const independent = h.createAdapter(), next = independent.normalize(input, h.context()), d = await h.waitForCall(3, next)
  await d.actual; d.release(); const value = await next
  assert.equal(value.input.sha256, hash(input)); assert.equal(value.image.original.mime, 'image/jpeg')
  assert.deepEqual(independent.inspect(), { active: 0, retained: 0, closing: false }); await h.assertNoTemporaryCopies()
})

test('内存Rust适配：未分配文件FD，独立持有人close拒绝或同步throw不污染normalizer收口', async t => {
  const h = await rustNormalizerComponent(t), input = ownedWebp()
  for (const mode of ['promise', 'sync'] as const) {
    const bytes = Buffer.from('独立持有人的真实FD不得由图片normalizer处置'), file = await h.ownedFile(`independent-${mode}.bin`, bytes)
    const handle = await open(file, 'r'), originalClose = handle.close.bind(handle), originalFd = handle.fd
    const failure = new Error('独立持有人close未确认'); let closeCalls = 0
    Object.defineProperty(handle, 'close', { configurable: true, value: () => { closeCalls++; if (mode === 'sync') throw failure; return Promise.reject(failure) } })
    try {
      if (mode === 'sync') assert.throws(() => handle.close(), error => error === failure)
      else await assert.rejects(handle.close(), error => error === failure)
      assert.ok(originalFd >= 0); assert.equal(handle.fd, originalFd); await handle.stat()
      const adapter = mode === 'promise' ? h.adapter : h.createAdapter(), value = await adapter.normalize(input, h.context())
      assert.equal(value.image.original.mime, 'image/jpeg'); assert.equal(value.input.sha256, hash(input)); await adapter.close()
      assert.deepEqual(adapter.inspect(), { active: 0, retained: 0, closing: true })
      assert.equal(closeCalls, 1, 'normalizer未获得此FD，也不能替独立持有人重试close')
      assert.equal(handle.fd, originalFd); assert.deepEqual(await handle.readFile(), bytes); await handle.stat()
      await h.assertNoTemporaryCopies()
    } finally { await originalClose() }
    assert.equal(handle.fd, -1)
  }
  assert.equal(h.calls.length, 2)
})


// 本测试进程拥有实际图片处理池；用例结束后等待原Rust子进程静止并释放句柄。
after(async () => { await closeRustMediaWorkerPool() })
