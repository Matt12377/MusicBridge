import { lstat, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bundleRoot = appDirectory => path.join(appDirectory, 'native/ffmpeg/darwin-arm64')

async function regularBytes(file, limit) {
  const info = await lstat(file)
  if (!info.isFile() || info.size > limit || await realpath(file) !== file || (info.mode & 0o022) !== 0) throw new Error('原生构建包含非普通文件、不安全路径或超限文件。')
  return readFile(file)
}

export async function captureNativeConverter(appDirectory) {
  const file = path.join(bundleRoot(appDirectory), 'manifest.json')
  try {
    return { schemaVersion: 1, manifestSha256: digest(await regularBytes(file, 64 * 1024)) }
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, manifestSha256: null }
    throw error
  }
}

/** 打包校验使用应用构建时的身份快照；不能临时重新接受旁边的新清单。 */
export async function verifyNativeConverterPackage(appDirectory) {
  const metadata = JSON.parse(await regularBytes(path.join(appDirectory, 'dist/main/converter-build.json'), 1024))
  if (metadata.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(metadata.manifestSha256)) throw new Error('应用未编入固定转换器；请先准备原生包并重新构建应用。')
  const root = bundleRoot(appDirectory), bytes = await regularBytes(path.join(root, 'manifest.json'), 64 * 1024)
  if (digest(bytes) !== metadata.manifestSha256) throw new Error('原生包与应用编译时的构建身份不一致。')
  const manifest = JSON.parse(bytes)
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'darwin' || manifest.arch !== 'arm64') throw new Error('原生包的平台不符合当前打包目标。')
  const pins = [manifest.build.ffmpeg, manifest.build.ffprobe, ...manifest.build.dependencies]
  const allowed = ['bin/ffmpeg', 'bin/ffprobe', ...['avcodec.62','avfilter.11','avformat.62','avutil.60','swresample.6'].map(name => `lib/lib${name}.dylib`)]
  if (pins.length !== allowed.length || new Set(pins.map(pin => pin.path)).size !== allowed.length) throw new Error('原生包文件集合不完整。')
  for (const pin of pins) {
    if (!allowed.includes(pin.path) || digest(await regularBytes(path.join(root, pin.path), 64 * 1024 * 1024)) !== pin.sha256) throw new Error('原生包文件身份不一致。')
  }
  for (const name of ['COPYING.LGPLv2.1','LICENSE.md','NOTICE.txt','BUILD.json']) {
    if (!(await regularBytes(path.join(root, 'legal', name), 1024 * 1024)).length) throw new Error('缺少许可或构建材料。')
  }
  if (digest(await regularBytes(path.join(root, 'legal/ffmpeg-8.1.2.tar.xz'), 32 * 1024 * 1024)) !== manifest.sourceSha256) throw new Error('对应源码身份不一致。')
  return root
}

export default async function beforePack(context) {
  // 这里只准入已核验的本地候选；Developer ID 会改变原生文件散列，需要独立的先签名后锁定流程。
  if (context.electronPlatformName !== 'darwin' || context.arch !== 3 || process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false' || context.packager.platformSpecificBuildOptions.identity !== null || context.packager.config.electronFuses?.resetAdHocDarwinSignature !== true) {
    throw new Error('当前转换器只准入 macOS arm64 本地包；需关闭自动签名发现、设置 mac.identity=null 并启用 Fuses ad-hoc 重签。发布签名尚未放行。')
  }
  await verifyNativeConverterPackage(await realpath(context.packager.info.appDir))
}
