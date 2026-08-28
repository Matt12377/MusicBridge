import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, fstatSync } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { IpcCommandPayloads, IpcInternalCommandResults } from '@music-bridge/contracts'

type Request = IpcCommandPayloads['recordingPrintWorker.pdf']
type Pdf = IpcInternalCommandResults['recordingPrintWorker.pdf']
const maxPdfBytes = 4 * 1024 * 1024
const failure = (): Error => new Error('[PRINT_EXPORT_UNCONFIRMED] PDF 导出未获确认；不会覆盖已有文件，请核对工作库并选择新文件名。')
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function checkedBytes(value: Pdf, request: Request): Buffer {
  if (value.artifactId !== request.artifactId || value.pdfSha256 !== request.expectedPdfSha256
    || !Number.isSafeInteger(value.size) || value.size < 16 || value.size > maxPdfBytes
    || typeof value.pdfBase64 !== 'string' || value.pdfBase64.length !== 4 * Math.ceil(value.size / 3)) throw failure()
  const bytes = Buffer.from(value.pdfBase64, 'base64')
  if (bytes.length !== value.size || bytes.toString('base64') !== value.pdfBase64 || hash(bytes) !== value.pdfSha256
    || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || !/%%EOF\s*$/u.test(bytes.subarray(-32).toString('ascii'))) throw failure()
  return bytes
}

/** 只导出精确历史字节。原生路径仅留Main；不覆盖，不自动重放，不操作打印机。 */
export async function exportRecordingPrintPdf(options: {
  request: Request
  readPdf(): Promise<Pdf>
  select(): Promise<{ canceled: boolean; filePath?: string }>
  assertCurrent(): Promise<void>
  /** Main生命周期代际同步检查，与最终link处于同一JS调用段。 */
  isCurrent(): boolean
}): Promise<{ state: 'cancelled' } | { state: 'exported'; artifactId: string; pdfSha256: string; size: number }> {
  let temporary: string | undefined
  try {
    const request = structuredClone(options.request)
    await options.assertCurrent()
    const initial = await options.readPdf()
    checkedBytes(initial, request)
    const destination = await options.select()
    if (destination.canceled) return { state: 'cancelled' }
    if (!destination.filePath || !path.isAbsolute(destination.filePath)) throw failure()
    await options.assertCurrent()
    const verified = await options.readPdf(), bytes = checkedBytes(verified, request)
    if (verified.size !== initial.size || verified.pdfSha256 !== initial.pdfSha256) throw failure()
    // 固定原生选定目录的规范路径；叶节点不跟随链接，发布始终exclusive。
    const selectedDirectory = path.dirname(destination.filePath), directory = await realpath(selectedDirectory)
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failure()
    const target = path.join(directory, path.basename(destination.filePath))
    try { await lstat(target); throw failure() } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const tempPath = path.join(directory, `.musicbridge-print-${randomUUID()}.tmp`)
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    temporary = tempPath
    try {
      let offset = 0
      while (offset < bytes.length) {
        const written = await handle.write(bytes, offset, bytes.length - offset, offset)
        if (written.bytesWritten <= 0) throw failure()
        offset += written.bytesWritten
      }
      await handle.sync()
    } finally { await handle.close() }
    const reader = await open(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let inode: number, device: number
    try {
      const stat = await reader.stat()
      if (!stat.isFile() || stat.size !== bytes.length || stat.nlink !== 1) throw failure()
      inode = stat.ino; device = stat.dev
      if (hash(await reader.readFile()) !== verified.pdfSha256) throw failure()
    } finally { await reader.close() }
    await options.assertCurrent()
    // 同步检查/发布避免在最后一次库身份检查与发布之间让出JS执行权。
    if (!options.isCurrent()) throw failure()
    const nowDirectory = lstatSync(directory), nowFile = lstatSync(tempPath)
    if (!nowDirectory.isDirectory() || nowDirectory.isSymbolicLink() || nowDirectory.ino !== directoryStat.ino || nowDirectory.dev !== directoryStat.dev
      || !nowFile.isFile() || nowFile.isSymbolicLink() || nowFile.ino !== inode || nowFile.dev !== device || nowFile.nlink !== 1 || nowFile.size !== bytes.length) throw failure()
    const finalReader = openSync(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const finalStat = fstatSync(finalReader)
      if (finalStat.ino !== inode || finalStat.dev !== device || finalStat.size !== bytes.length || finalStat.nlink !== 1
        || hash(readFileSync(finalReader)) !== verified.pdfSha256) throw failure()
      linkSync(tempPath, target)
    } finally { closeSync(finalReader) }
    const directoryHandle = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(directoryHandle) } finally { closeSync(directoryHandle) }
    // link按路径取源，外部进程不受JS同步段约束；发布后重新核对目标FD及名称。
    // 身份或字节不确定时只报告未确认，不能删除可能已由外部写者替换的目标。
    const publishedReader = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const published = fstatSync(publishedReader)
      if (!published.isFile() || published.ino !== inode || published.dev !== device || published.size !== bytes.length
        || hash(readFileSync(publishedReader)) !== verified.pdfSha256) throw failure()
      const named = lstatSync(target), publishedDirectory = lstatSync(directory)
      if (!named.isFile() || named.isSymbolicLink() || named.ino !== inode || named.dev !== device || named.size !== bytes.length
        || !publishedDirectory.isDirectory() || publishedDirectory.isSymbolicLink()
        || publishedDirectory.ino !== directoryStat.ino || publishedDirectory.dev !== directoryStat.dev) throw failure()
    } finally { closeSync(publishedReader) }
    return { state: 'exported', artifactId: request.artifactId, pdfSha256: verified.pdfSha256, size: verified.size }
  } catch { throw failure() }
  finally {
    if (temporary) await unlink(temporary).catch(() => undefined)
  }
}
