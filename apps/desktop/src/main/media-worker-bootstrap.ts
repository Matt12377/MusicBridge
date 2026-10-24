import path from 'node:path'
import { resolveRustMediaWorkerBinary } from '../../../../packages/bridge-core/src/library/rust-media-worker.js'

/** 路径由当前 Main 入口与编译身份决定，不能采用 Electron 文件启动时的 getAppPath。 */
export async function resolveDesktopMediaWorker(options: {
  entryDirectory: string
  resourcesDirectory: string
  packaged: boolean
  binarySha256: string
}): Promise<{ binaryPath: string; binarySha256: string }> {
  const root = options.packaged ? options.resourcesDirectory : path.resolve(options.entryDirectory, '../..', 'native')
  const binaryPath = path.join(root, 'media-worker', `${process.platform}-${process.arch}`, 'bin',
    process.platform === 'win32' ? 'musicbridge-media-worker.exe' : 'musicbridge-media-worker')
  // 在创建 Owner 前核对真实文件和编译摘要，避免后台扫描才发现资源缺失。
  return { binaryPath: await resolveRustMediaWorkerBinary({ binaryPath, binarySha256: options.binarySha256 }),
    binarySha256: options.binarySha256 }
}
