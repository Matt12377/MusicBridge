import { geometry, tiffGeometry, webpGeometry } from '../../../../../packages/bridge-core/src/library/artwork-import-validation.js'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { LocalArtworkImportFormat } from '@music-bridge/contracts'
import type { PhotoDecoderImage } from '../collection-photos.js'
import { LocalArtworkImageError, normalizeLocalArtwork, normalizeLocalArtworkInWorker, type NormalizedLocalArtwork } from '../local-artwork-image.js'

const MAX_INPUT_BYTES = 4 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export type ImportedLocalArtworkMime = 'image/png' | 'image/jpeg' | 'image/tiff' | 'image/webp'
/** 仅供 Main 捕获；原输入身份不能当成旧公开 original 的身份。 */
export interface ImportedLocalArtworkInput {
  mime: ImportedLocalArtworkMime
  bytes: number
  sha256: string
  converted: boolean
}
export interface NormalizedImportedLocalArtwork {
  image: NormalizedLocalArtwork
  /** TIFF/WebP 时为转换后的 JPEG copy；与 image.original 的字节身份一致。 */
  compatibleOriginalBytes: Uint8Array
  input: ImportedLocalArtworkInput
  conversionLabel: string | null
}
const fail = (message: string): never => { throw new LocalArtworkImageError(message) }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** 生产异步入口：保留输入身份与兼容副本关系，像素处理使用常驻Rust池。 */
export async function normalizeImportedLocalArtworkInWorker(bytes: Uint8Array, signal?: AbortSignal): Promise<NormalizedImportedLocalArtwork> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_INPUT_BYTES) fail('封面图片必须非空，压缩大小不得超过4 MiB。')
  const captured = Buffer.from(bytes)
  const mime: ImportedLocalArtworkMime = captured.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png'
    : captured[0] === 255 && captured[1] === 216 ? 'image/jpeg'
      : ['II', 'MM'].includes(captured.toString('latin1', 0, 2)) ? 'image/tiff'
        : captured.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp' : fail('请选择完整的单帧TIFF、WebP、JPEG或PNG封面。')
  const converted = mime === 'image/tiff' || mime === 'image/webp'
  const result = await normalizeLocalArtworkInWorker(captured, signal)
  return { image: result.image, compatibleOriginalBytes: result.compatibleOriginalBytes, input: { mime, bytes: captured.length, sha256: hash(captured), converted },
    conversionLabel: converted ? `${mime === 'image/tiff' ? 'TIFF' : 'WebP'}输入已转换为JPEG兼容副本；原输入身份单独保留。` : null }
}

/**
 * 同步探针和旧夹具入口；生产图片统一使用上方异步Rust入口。
 * 合成 decoder 只证明调用边界；实际 TIFF/WebP native 能力须由 Electron Gate 单独确认。
 */
export function normalizeImportedLocalArtwork(bytes: Uint8Array, decode: (bytes: Buffer) => PhotoDecoderImage): NormalizedImportedLocalArtwork {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_INPUT_BYTES) fail('封面图片必须非空，压缩大小不得超过 4 MiB。')
  const captured = Buffer.from(bytes)
  const prefix = captured.toString('latin1', 0, 2)
  const mime: ImportedLocalArtworkMime = captured.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png'
    : captured[0] === 255 && captured[1] === 216 ? 'image/jpeg'
      : prefix === 'II' || prefix === 'MM' ? 'image/tiff'
        : captured.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp'
          : fail('封面格式不受支持，请选择单帧 TIFF、WebP、JPEG 或 PNG。')
  const converted = mime === 'image/tiff' || mime === 'image/webp'
  const input: ImportedLocalArtworkInput = { mime, bytes: captured.length, sha256: hash(captured), converted }
  if (!converted) return { image: normalizeLocalArtwork(captured, decode), compatibleOriginalBytes: new Uint8Array(captured), input, conversionLabel: null }
  const declared = mime === 'image/tiff' ? tiffGeometry(captured) : { ...webpGeometry(captured), orientation: 1 }
  const format = mime === 'image/tiff' ? 'TIFF' : 'WebP'
  let image: PhotoDecoderImage
  try {
    image = decode(Buffer.from(captured))
    if (image.isEmpty()) fail(`当前图片解码器无法读取这张 ${format} 封面，请提供完整单帧副本或使用支持该格式的解码器。`)
  } catch (error) {
    if (error instanceof LocalArtworkImageError) throw error
    return fail(`当前图片解码器无法读取这张 ${format} 封面，请提供完整单帧副本或使用支持该格式的解码器。`)
  }
  try {
    const actual = image.getSize(); geometry(actual)
    const swapped = declared.orientation >= 5 && declared.orientation <= 8
      && actual.width === declared.height && actual.height === declared.width
    if (!swapped && (actual.width !== declared.width || actual.height !== declared.height)) fail('封面的实际解码尺寸与文件声明不一致。')
    const compatible = image.toJPEG(85)
    if (!Buffer.isBuffer(compatible) || compatible.length < 4 || compatible.length > MAX_INPUT_BYTES) fail('封面的 JPEG 兼容副本无效或超过 4 MiB。')
    const copied = Buffer.from(compatible), normalized = normalizeLocalArtwork(copied, decode)
    if (normalized.original.width !== actual.width || normalized.original.height !== actual.height) fail('封面的 JPEG 兼容副本尺寸与转换前不一致。')
    return { image: normalized, compatibleOriginalBytes: new Uint8Array(copied), input, conversionLabel: `${format} 输入已转换为 JPEG 兼容副本；原输入身份仅保存在 Main 捕获记录。` }
  } catch (error) {
    if (error instanceof LocalArtworkImageError) throw error
    return fail(`${format} 封面转换为 JPEG 兼容副本失败，请换一张完整的单帧图片。`)
  }
}


/** 本代 Main 的一像素有界探针；通过原完整规范化及展示 JPEG 实际回读才报告可调用。 */
export function probeLocalArtworkImportFormats(decode:(bytes:Buffer)=>PhotoDecoderImage):readonly LocalArtworkImportFormat[] {
  const chunk=(type:string,body:Buffer=Buffer.alloc(0))=>{
    const bytes=Buffer.alloc(body.length+12);bytes.writeUInt32BE(body.length,0);bytes.write(type,4,'ascii');body.copy(bytes,8)
    let crc=0xffffffff
    for(const value of bytes.subarray(4,bytes.length-4)){crc^=value;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}
    bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2
  const png=Buffer.concat([PNG_SIGNATURE,chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,37,73,109]))),chunk('IEND')])
  // 一像素、单strip、未压缩Classic TIFF；无外部来源、账户、路径或应用对话框。
  const fields=[[256,4,1,1],[257,4,1,1],[258,3,3,146],[259,3,1,1],[262,3,1,2],[273,4,1,152],[274,3,1,1],[277,3,1,3],[278,4,1,1],[279,4,1,3],[284,3,1,1]] as const
  const tiff=Buffer.alloc(155);tiff.write('II',0,'ascii');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);tiff.writeUInt16LE(fields.length,8)
  fields.forEach(([tag,type,count,value],index)=>{const at=10+index*12;tiff.writeUInt16LE(tag,at);tiff.writeUInt16LE(type,at+2);tiff.writeUInt32LE(count,at+4);tiff.writeUInt32LE(value,at+8)})
  for(let index=0;index<3;index++)tiff.writeUInt16LE(8,146+index*2);tiff.set([37,73,109],152)
  // 单帧 VP8 的完整小副本；不能用帧头通过代替真实 native 解码成功。
  const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')
  let compatibleJpeg:Buffer|undefined
  const probe=(mime:ImportedLocalArtworkMime,bytes:Buffer|undefined):LocalArtworkImportFormat=>{
    let verified=false
    if(bytes){try{
      const result=normalizeImportedLocalArtwork(bytes,decode),display=result.image.display
      const encoded=Buffer.from(display.dataUrl.slice('data:image/jpeg;base64,'.length),'base64'),read=decode(Buffer.from(encoded)),size=read.getSize()
      verified=result.input.mime===mime&&result.input.sha256===hash(bytes)&&result.image.original.width===1&&result.image.original.height===1
        &&display.width===1&&display.height===1&&encoded.length===display.bytes&&hash(encoded)===display.sha256&&!read.isEmpty()&&size.width===1&&size.height===1
      if(mime==='image/png'&&verified)compatibleJpeg=Buffer.from(encoded)
    }catch{/* 未通过当前 Main 真实规范化/回读时保不可用，不推断其他格式或授权。 */}}
    return {mime,label:mime.slice('image/'.length).toUpperCase(),availability:verified?{available:true}:{available:false,reason:'此格式未通过当前 Main 的有界解码和兼容副本回读。'}}
  }
  const pngResult=probe('image/png',png),jpegResult=probe('image/jpeg',compatibleJpeg)
  return [jpegResult,pngResult,probe('image/tiff',tiff),probe('image/webp',webp)]
}

export interface LocalArtworkNormalizationContext {
  signal: AbortSignal
  /** 仅本Main进程performance.now域；调用者在原flight入场固定，不能逐图续期。 */
  deadlineAtMs: number
  assertCurrent?(): void | Promise<void>
}
export class LocalArtworkNormalizationPhysicalError extends Error {
  constructor(readonly failure: unknown) { super('封面转换的实际资源关闭未确认，原读取未发布。'); this.name = 'LocalArtworkNormalizationPhysicalError' }
}
export interface LocalArtworkImportNormalizerOptions {
  privateRoot: string
  decode(bytes: Buffer): PhotoDecoderImage
  /** 旧夹具的兼容字段；Rust生产入口不调用逐图系统转换。 */
  spawnProcess?(input: string, output: string, directory: string): ChildProcess
}
interface ConversionFlight {
  controller: AbortController
  work: Promise<NormalizedImportedLocalArtwork>
  physicalFailure: boolean
}
const normalizationExpired = (): Error => { const error = new Error('封面读取的原响应期限已到。'); error.name = 'AbortError'; return error }
/** 原响应期限与取消信号覆盖Rust任务；不再创建临时图片或逐图启动系统转换器。 */
export function createLocalArtworkImportNormalizer(options: LocalArtworkImportNormalizerOptions) {
  if (!path.isAbsolute(options.privateRoot) || path.resolve(options.privateRoot) !== options.privateRoot
    || options.privateRoot === path.parse(options.privateRoot).root || typeof options.decode !== 'function') throw new Error('封面转换需要Main自有的规范私有目录。')
  const active = new Set<ConversionFlight>()
  let closing = false, closure: Promise<void> | undefined
  function normalize(bytes: Uint8Array, context: LocalArtworkNormalizationContext): Promise<NormalizedImportedLocalArtwork> {
    const deadline = context.deadlineAtMs, parent = context.signal, assert = context.assertCurrent
    if (closing || parent.aborted || !Number.isFinite(deadline) || performance.now() >= deadline) return Promise.reject(normalizationExpired())
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_INPUT_BYTES) return Promise.reject(new LocalArtworkImageError('封面图片必须非空，压缩大小不得超过4 MiB。'))
    if (active.size >= 2) return Promise.reject(new Error('封面处理槽位正忙，请稍后重新读取。'))
    const captured = Buffer.from(bytes), controller = new AbortController(), forward = () => controller.abort()
    parent.addEventListener('abort', forward, { once: true }); if (parent.aborted) forward()
    const timer = setTimeout(forward, Math.max(1, deadline - performance.now()))
    const guard = async (): Promise<void> => {
      if (closing || controller.signal.aborted || context.deadlineAtMs !== deadline || context.signal !== parent
        || context.assertCurrent !== assert || performance.now() >= deadline) throw normalizationExpired()
      await assert?.()
      if (closing || controller.signal.aborted || performance.now() >= deadline) throw normalizationExpired()
    }
    let work!: Promise<NormalizedImportedLocalArtwork>
    const flight: ConversionFlight = { controller, get work() { return work }, physicalFailure: false }
    work = Promise.resolve().then(async () => {
      await guard()
      const result = await normalizeImportedLocalArtworkInWorker(captured, controller.signal)
      await guard()
      return result
    }).finally(() => { clearTimeout(timer); active.delete(flight); parent.removeEventListener('abort', forward) })
    active.add(flight); void work.catch(() => {}); return work
  }
  return {
    normalize,
    close(): Promise<void> {
      if (!closure) { closing = true; for (const flight of active) flight.controller.abort(); closure = Promise.allSettled([...active].map(flight => flight.work)).then(() => {}) }
      return closure
    },
    inspect: () => ({ active: active.size, retained: 0, closing }),
  }
}
export type LocalArtworkImportNormalizer = ReturnType<typeof createLocalArtworkImportNormalizer>
