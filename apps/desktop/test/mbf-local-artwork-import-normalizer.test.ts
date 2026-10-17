import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
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

import { mkdtemp as webpMktemp, mkdir as webpMkdir, rm as webpRm, readdir as webpReaddir } from 'node:fs/promises'
import path from 'node:path'
import { spawn as webpSpawn, type ChildProcess } from 'node:child_process'
import { createLocalArtworkImportNormalizer, LocalArtworkNormalizationPhysicalError, type LocalArtworkNormalizationContext } from '../src/main/local-library-workbench/artwork-import-normalizer.js'

/** 真实自有Node子进程/stdio/副本FD，JPEG像素decoder仍合成；不冒sips或Electron资格。 */
async function webpOsComponent(t:test.TestContext,mode='copy',image=decoder()){
  const temporary=process.env.TMPDIR
  if(!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))throw Error('WebP组件必须使用批准外置临时根')
  const directory=await webpMktemp(path.join(temporary,'webp-os-component-')),privateRoot=path.join(directory,'captured')
  await webpMkdir(privateRoot,{mode:0o700})
  const children:ChildProcess[]=[],closures:{child:boolean;stdout:boolean;stderr:boolean}[]=[],started:Promise<void>[]=[]
  let decodeCalls=0,identityCurrent=true
  const identityError=new Error('原Main作者已经换代'),input=webp(),encoded=jpeg()
  const program=String.raw`const fs=require('node:fs'),path=require('node:path');const [input,output,mode,expected,jpeg]=process.argv.slice(1);const data=fs.readFileSync(input),crypto=require('node:crypto');if(crypto.createHash('sha256').update(data).digest('hex')!==expected)throw Error('captured-mismatch');if((fs.statSync(input).mode&511)!==384||(fs.statSync(path.dirname(input)).mode&511)!==448)throw Error('private-permissions');if(mode==='input-changed')fs.appendFileSync(input,Buffer.from([7]));if(mode==='oversize')fs.writeFileSync(output,Buffer.alloc(4194305));else fs.writeFileSync(output,Buffer.from(jpeg,'base64'));if(mode==='cleanup-failed')fs.writeFileSync(path.join(path.dirname(input),'unexpected-private-file'),'retain');process.stdout.write('component-ready\n');if(mode==='held')setInterval(()=>{},1000);`
  const adapter=createLocalArtworkImportNormalizer({privateRoot,decode(){decodeCalls++;return image},spawnProcess(source,output,cwd){
    const child=webpSpawn('/Users/yihe/.nvm/versions/node/v22.23.2/bin/node',['-e',program,source,output,mode,hash(input),encoded.toString('base64')],{cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{LANG:'C',LC_ALL:'C',TMPDIR:cwd}})
    const closed={child:false,stdout:false,stderr:false};closures.push(closed);children.push(child)
    child.once('close',()=>{closed.child=true});child.stdout.once('close',()=>{closed.stdout=true});child.stderr.once('close',()=>{closed.stderr=true})
    started.push(new Promise<void>(resolve=>child.stdout.once('data',()=>{if(mode==='identity-changed')identityCurrent=false;resolve()})))
    return child
  }})
  t.after(async()=>{if(mode==='cleanup-failed')await assert.rejects(adapter.close(),LocalArtworkNormalizationPhysicalError);else await adapter.close();await webpRm(directory,{recursive:true,force:true})})
  const context=(signal=new AbortController().signal,deadlineAtMs=performance.now()+2000):LocalArtworkNormalizationContext=>({signal,deadlineAtMs,assertCurrent(){if(!identityCurrent)throw identityError}})
  const waitStarted=async(work:Promise<unknown>)=>{let settled=false;const completed=work.then(()=>{settled=true},()=>{settled=true});while(!started.length&&!settled)await new Promise<void>(resolve=>setImmediate(resolve));if(started.length)await Promise.race([started[0]!,completed])}
  const quiet=()=>{for(const [index,child]of children.entries()){assert.deepEqual(closures[index],{child:true,stdout:true,stderr:true});assert.ok(child.pid);assert.throws(()=>process.kill(-child.pid!,0),{code:'ESRCH'})}}
  return{adapter,input,encoded,privateRoot,children,context,waitStarted,quiet,identityError,decodeCalls:()=>decodeCalls}
}

test('WebP异步适配：原捕获SHA与JPEG材料分记，真实子进程和私有目录闭口后才返回',async t=>{
  assert.equal(process.platform,'darwin','本OS组件要求当前Mac；不把其他平台分支或跳过当成功')
  const h=await webpOsComponent(t),original=Buffer.from(h.input),value=await h.adapter.normalize(h.input,h.context())
  assert.equal(value.input.mime,'image/webp');assert.equal(value.input.sha256,hash(original));assert.equal(value.input.bytes,original.length);assert.equal(value.input.converted,true)
  assert.equal(value.image.original.mime,'image/jpeg');assert.equal(value.image.original.sha256,hash(h.encoded));assert.equal(value.image.original.bytes,h.encoded.length)
  assert.equal(hash(value.compatibleOriginalBytes),value.image.original.sha256);assert.deepEqual(h.input,original);assert.equal(value.image.display.width,1);assert.equal(value.image.display.height,1)
  h.quiet();assert.deepEqual(await webpReaddir(h.privateRoot),[]);assert.deepEqual(h.adapter.inspect(),{active:0,retained:0,closing:false})
  const childrenBefore=h.children.length,plain=jpeg(),ordinary=await h.adapter.normalize(plain,h.context())
  assert.equal(ordinary.input.mime,'image/jpeg');assert.equal(ordinary.input.converted,false);assert.equal(ordinary.image.original.sha256,hash(plain))
  assert.deepEqual(ordinary.compatibleOriginalBytes,new Uint8Array(plain));assert.equal(h.children.length,childrenBefore,'正常JPEG仍走原同步像素路径，不派系统转换')
})

test('WebP异步适配：预取消和原截止已到零派发，实际子进程取消后等stdio与FD真闭',async t=>{
  assert.equal(process.platform,'darwin')
  const h=await webpOsComponent(t,'held'),pre=new AbortController();pre.abort()
  await assert.rejects(h.adapter.normalize(h.input,h.context(pre.signal)),{name:'AbortError'})
  await assert.rejects(h.adapter.normalize(h.input,h.context(undefined,performance.now()-1)),{name:'AbortError'});assert.equal(h.children.length,0)
  for(const invalid of [Buffer.alloc(4*1024*1024+1),webp([extended(2),chunk('VP8 ',lossy())])])await assert.rejects(h.adapter.normalize(invalid,h.context()),LocalArtworkImageError)
  assert.equal(h.children.length,0);assert.equal(h.decodeCalls(),0,'新异步入口也须在系统转换与像素解码前拒绝超界和动画')
  const controller=new AbortController(),work=h.adapter.normalize(h.input,h.context(controller.signal)),rejection=assert.rejects(work,{name:'AbortError'})
  await h.waitStarted(work);assert.equal(h.adapter.inspect().active,1);controller.abort();await rejection
  h.quiet();assert.deepEqual(await webpReaddir(h.privateRoot),[]);assert.equal(h.adapter.inspect().retained,0)
  const late=await webpOsComponent(t,'held'),parent=new AbortController(),deadline=performance.now()+180,lateWork=late.adapter.normalize(late.input,late.context(parent.signal,deadline)),lateReject=assert.rejects(lateWork,{name:'AbortError'})
  await late.waitStarted(lateWork);await lateReject;assert.equal(parent.signal.aborted,false);assert.ok(performance.now()>=deadline);late.quiet();assert.deepEqual(await webpReaddir(late.privateRoot),[])
})

test('WebP异步适配：输出读前超界、实际尺寸失败和输入副本身份变化均拒绝，原输入不改',async t=>{
  assert.equal(process.platform,'darwin')
  for(const mode of ['oversize','input-changed','decode-size']){
    const h=await webpOsComponent(t,mode,mode==='decode-size'?decoder(2,1):decoder()),before=Buffer.from(h.input)
    await assert.rejects(h.adapter.normalize(h.input,h.context()),mode==='oversize'?/超过4 MiB/u:mode==='input-changed'?/副本已变化/u:/尺寸|身份/u)
    if(mode!=='decode-size')assert.equal(h.decodeCalls(),0,'输出超界或input身份变化必须先于native解码')
    h.quiet();assert.deepEqual(h.input,before);assert.deepEqual(await webpReaddir(h.privateRoot),[]);await h.adapter.close()
  }
})

test('WebP异步适配：原作者换代不发布，cleanup失败独立保留且close不能签quiet',async t=>{
  assert.equal(process.platform,'darwin')
  const changed=await webpOsComponent(t,'identity-changed');await assert.rejects(changed.adapter.normalize(changed.input,changed.context()),error=>error===changed.identityError)
  changed.quiet();assert.deepEqual(await webpReaddir(changed.privateRoot),[]);await changed.adapter.close()
  const failed=await webpOsComponent(t,'cleanup-failed');await assert.rejects(failed.adapter.normalize(failed.input,failed.context()),LocalArtworkNormalizationPhysicalError)
  failed.quiet();assert.equal(failed.adapter.inspect().retained,1);assert.equal((await webpReaddir(failed.privateRoot)).length,1)
  await assert.rejects(failed.adapter.normalize(failed.input,failed.context()),/原资源尚未收口/u)
  const decodeBefore=failed.decodeCalls(),childrenBefore=failed.children.length
  await assert.rejects(failed.adapter.normalize(jpeg(),failed.context()),/原资源尚未收口/u)
  assert.equal(failed.decodeCalls(),decodeBefore,'真实cleanup未确认后，合法JPEG也不得越过retained守门解码')
  assert.equal(failed.children.length,childrenBefore,'真实cleanup未确认后不得派发新转换')
  await assert.rejects(failed.adapter.close(),LocalArtworkNormalizationPhysicalError)
})

import { open as closeProbeOpen, writeFile as closeProbeWrite, type FileHandle as CloseProbeHandle } from 'node:fs/promises'

/** 只观察本次真实输入read，在该真实FileHandle上注入close时序；原read结果完整转发。 */
async function observeActualInputClose(h:Awaited<ReturnType<typeof webpOsComponent>>,install:(handle:CloseProbeHandle,close:()=>Promise<void>)=>void){
  const temporary=process.env.TMPDIR;assert.ok(temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const file=path.join(path.dirname(h.privateRoot),'independent-close-observer.bin');await closeProbeWrite(file,Buffer.from('自有观察FD'),{flag:'wx',mode:0o600})
  const sample=await closeProbeOpen(file,'r'),prototype=Object.getPrototypeOf(sample),descriptor=Object.getOwnPropertyDescriptor(prototype,'read');assert.ok(descriptor);assert.equal(typeof descriptor.value,'function')
  const originalRead:CloseProbeHandle['read']=descriptor.value
  let selected:CloseProbeHandle|undefined,originalClose:(()=>Promise<void>)|undefined
  Object.defineProperty(prototype,'read',{...descriptor,value:function(this:CloseProbeHandle,...args:Parameters<CloseProbeHandle['read']>){
    const handle=this,work=originalRead.apply(handle,args)
    return work.then(result=>{
      if(!selected&&Buffer.isBuffer(result.buffer)&&result.bytesRead===h.input.length&&result.buffer.subarray(0,h.input.length).equals(h.input)){
        selected=handle;const close=handle.close;originalClose=()=>close.call(handle);install(handle,originalClose)
      }
      return result
    })
  }})
  return{file,sample,selected:()=>selected,async restore(){Object.defineProperty(prototype,'read',descriptor);if(selected&&originalClose&&selected.fd!==-1)await originalClose();await sample.close()}}
}

test('WebP副本关闭：甲close真实fulfilled后乙复用同数字FD，甲不误retained且乙仍可读取',async t=>{
  assert.equal(process.platform,'darwin')
  const h=await webpOsComponent(t),beta=path.join(path.dirname(h.privateRoot),'independent-beta.bin'),betaBytes=Buffer.from('乙真实FD不得由甲旧整数关闭')
  await closeProbeWrite(beta,betaBytes,{flag:'wx',mode:0o600})
  const acquired:CloseProbeHandle[]=[],oldNumbers:number[]=[];let reused:CloseProbeHandle|undefined,calls=0,alphaCloseFulfilled=false
  const observer=await observeActualInputClose(h,(handle,originalClose)=>{
    const oldFd=handle.fd;oldNumbers.push(oldFd)
    Object.defineProperty(handle,'close',{configurable:true,value:()=>{
      calls++
      return originalClose().then(async()=>{
        alphaCloseFulfilled=true;assert.equal(handle.fd,-1)
        for(let attempt=0;attempt<64;attempt++){
          const next=await closeProbeOpen(beta,'r');acquired.push(next)
          if(next.fd===oldFd){reused=next;return}
        }
        assert.fail('本次未实际复用原FD，不能拿伪数字替代本负例')
      })
    }})
  })
  try{
    const result=await h.adapter.normalize(h.input,h.context());assert.equal(result.image.original.mime,'image/jpeg')
    assert.equal(alphaCloseFulfilled,true);assert.equal(calls,1);assert.equal(oldNumbers.length,1);assert.ok(reused)
    assert.equal(reused.fd,oldNumbers[0]);assert.deepEqual(await reused.readFile(),betaBytes)
    await reused.stat();assert.equal(observer.selected()!.fd,-1)
    assert.deepEqual(h.adapter.inspect(),{active:0,retained:0,closing:false});h.quiet();assert.deepEqual(await webpReaddir(h.privateRoot),[])
  }finally{for(const handle of acquired)await handle.close();await observer.restore()}
})

test('WebP副本关闭：原close拒绝或同步throw保真实handle及首业务错误，不能只凭fd标签签quiet',async t=>{
  assert.equal(process.platform,'darwin')
  for(const mode of ['promise','sync'] as const){
    const h=await webpOsComponent(t,'cleanup-failed'),business=new Error('原作者受控拒绝'),closeFailure=new Error('原真实FileHandle受控close未确认')
    let armed=false,calls=0,held:CloseProbeHandle|undefined
    const observer=await observeActualInputClose(h,(handle)=>{
      held=handle;armed=true
      const originalWork=Promise.reject<void>(closeFailure);void originalWork.catch(()=>{})
      Object.defineProperty(handle,'close',{configurable:true,value:()=>{calls++;if(mode==='sync')throw closeFailure;return originalWork}})
    })
    try{
      await assert.rejects(h.adapter.normalize(h.input,{...h.context(),assertCurrent(){if(armed)throw business}}),error=>{
        assert.ok(error instanceof LocalArtworkNormalizationPhysicalError);assert.ok(error.failure instanceof AggregateError)
        assert.equal(error.failure.errors[0],business);assert.ok(error.failure.errors.includes(closeFailure));return true
      })
      assert.ok(held);assert.ok(held.fd>=0);await held.stat();assert.equal(calls,1)
      assert.equal(h.adapter.inspect().retained,1);await assert.rejects(h.adapter.close(),LocalArtworkNormalizationPhysicalError)
    }finally{await observer.restore()}
  }
})
