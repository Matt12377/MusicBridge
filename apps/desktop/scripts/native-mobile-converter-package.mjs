import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bundleRoot = appDirectory => path.join(appDirectory, 'native/mobile-ffmpeg/darwin-arm64')
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k])
async function whole(file, limit) {
  if (await realpath(file) !== file) throw new Error('Mobile 转换包不能沿符号链读取。')
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const first = await fd.stat({ bigint: true })
    if (!first.isFile() || first.size < 1n || first.size > BigInt(limit) || (first.mode & 0o022n) !== 0n) throw new Error('Mobile 转换包文件身份或权限无效。')
    const bytes = await fd.readFile(), last = await fd.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    if (BigInt(bytes.length) !== first.size || !unchanged(first, last) || !unchanged(last, named)) throw new Error('Mobile 转换包在完整读取期间发生改变。')
    return bytes
  } finally { await fd.close() }
}
export async function captureNativeMobileConverter(appDirectory) {
  try { return { schemaVersion: 1, manifestSha256: sha(await whole(path.join(bundleRoot(appDirectory), 'manifest.json'), 64 * 1024)) } }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, manifestSha256: null }; throw error }
}
/** 固定编译 pin 只准入独立 mobile 包，不能由录音包或当前旁边的文件重新授予资格。 */
export async function verifyNativeMobileConverterPackage(appDirectory) {
  const root = bundleRoot(appDirectory), captured = await captureNativeMobileConverter(appDirectory)
  let compiled
  try { compiled = JSON.parse((await whole(path.join(appDirectory, 'dist/main/mobile-converter-build.json'), 1024)).toString('utf8')) }
  catch (error) { if (error.code === 'ENOENT' && captured.manifestSha256 === null) return false; throw error }
  if (compiled.schemaVersion !== 1 || Object.keys(compiled).length !== 2) throw new Error('Mobile 转换包编译身份无效。')
  if (compiled.manifestSha256 === null && captured.manifestSha256 === null) return false
  if (!/^[a-f0-9]{64}$/u.test(compiled.manifestSha256) || compiled.manifestSha256 !== captured.manifestSha256) throw new Error('Mobile 转换包与编译 pin 不一致。')
  const manifest = JSON.parse((await whole(path.join(root, 'manifest.json'), 64 * 1024)).toString('utf8'))
  if (manifest.schemaVersion !== 1 || manifest.purpose !== 'mobile-dsd-to-pcm-flac' || manifest.platform !== 'darwin' || manifest.arch !== 'arm64'
    || manifest.sourceSha256 !== '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c'
    || manifest.configureSha256 !== '0fa7b89df2a10af5d8379a051372a4bd76260718a88176c043f47b0a479c7cec'
    || JSON.stringify(manifest.recipe) !== JSON.stringify({ outputCodec: 'flac', sampleRateHz: 48000, bitsPerSample: 24 })) throw new Error('Mobile 转换包用途或固定配方不符。')
  const allowed = ['bin/ffmpeg', 'bin/ffprobe', ...['avcodec.62', 'avfilter.11', 'avformat.62', 'avutil.60', 'swresample.6'].map(x => `lib/lib${x}.dylib`)]
  const pins = [manifest.build.ffmpeg, manifest.build.ffprobe, ...manifest.build.dependencies]
  if (pins.length !== allowed.length || new Set(pins.map(x => x.path)).size !== allowed.length) throw new Error('Mobile 转换包文件集合不完整。')
  for (const pin of pins) if (!allowed.includes(pin.path) || !/^[a-f0-9]{64}$/u.test(pin.sha256)
    || sha(await whole(path.join(root, pin.path), 64 * 1024 * 1024)) !== pin.sha256) throw new Error('Mobile 转换包实际文件与固定身份不符。')
  for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md', 'NOTICE.txt', 'BUILD.json']) await whole(path.join(root, 'legal', name), 1024 * 1024)
  if (sha(await whole(path.join(root, 'legal/ffmpeg-8.1.2.tar.xz'), 32 * 1024 * 1024)) !== manifest.sourceSha256) throw new Error('Mobile 转换包对应源码身份不符。')
  return root
}
