import path from 'node:path'
import { isLocalCatalogText } from '@music-bridge/contracts'
import { readonlySourceCaseMatchedCandidateMetadata, readonlySourceDirectoryEntries, SourceFileError, type RootCapability } from '../recording/source-files.js'

const preferredNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', 'cover.tiff', 'cover.tif', 'cover.webp'] as const

/** 只枚举原专辑目录；名称仅负责发现，原FD字节仍须由可信Main实际解码。 */
export async function* readonlyLocalArtworkCandidateNames(options: {
  root: RootCapability; directory: string; signal: AbortSignal; deadlineMs: number
  assertCurrent(): void; hasCandidateSlot(): boolean; unresolved(): void
}): AsyncGenerator<string> {
  // 固定名直读先于目录遍历；大目录或任意readdir顺序不能挡住原固定名。
  for (const name of preferredNames) {
    options.assertCurrent(); if (!options.hasCandidateSlot()) return
    try {
      const found = await readonlySourceCaseMatchedCandidateMetadata(options.root, path.posix.join(options.directory, name), options.assertCurrent)
      options.assertCurrent(); yield path.posix.basename(found.relative)
    } catch (error) {
      if (error instanceof SourceFileError && error.code === 'MISSING') { options.assertCurrent(); continue }
      throw error
    }
  }
  options.assertCurrent()
  if (!options.hasCandidateSlot()) return
  let listed: Awaited<ReturnType<typeof readonlySourceDirectoryEntries>>
  try {
    listed = await readonlySourceDirectoryEntries(options.root, options.directory === '.' ? '' : options.directory,
      512, options.signal, options.deadlineMs)
  } catch (error) {
    // 可选发现失败不吞掉已读固定副本；关闭未确认、身份变更与取消仍沿原错误拒绝。
    if (error instanceof SourceFileError && (error.code === 'MISSING' || error.code === 'IO_ERROR')) {
      options.assertCurrent(); options.unresolved(); return
    }
    throw error
  }
  options.assertCurrent()
  // 截断不能证明只有这一张图；不为判断第513项而突破原读取上限。
  if (listed.truncated) { options.unresolved(); return }
  const files = listed.entries.filter(entry => entry.isFile() && !entry.isSymbolicLink()
    && isLocalCatalogText(entry.name) && Buffer.byteLength(entry.name) <= 1024
    && !entry.name.startsWith('.') && !/[\\/\u0000-\u001f\u007f]/u.test(entry.name)
    && /\.(?:jpe?g|png|tiff?|webp)$/iu.test(entry.name)
    && !preferredNames.some(name => name === entry.name))
  for (const preferred of preferredNames) {
    const matches = files.filter(entry => entry.name.toLowerCase() === preferred)
    if (matches.length > 1) { options.unresolved(); return }
    if (matches.length === 1) { options.assertCurrent(); yield matches[0]!.name; if (!options.hasCandidateSlot()) return }
  }
  const other = files.filter(entry => !preferredNames.some(name => name === entry.name.toLowerCase()))
  if (other.length === 1) { options.assertCurrent(); yield other[0]!.name }
  else if (other.length > 1) options.unresolved()
}
