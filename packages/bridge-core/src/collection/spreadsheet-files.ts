import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;
export class SpreadsheetReadError extends Error {
  readonly code = 'INVALID_IPC_REQUEST';
  constructor() { super('无法读取工作簿。请选择不超过8MiB的普通XLSX或XLS文件，原文件未修改。'); }
}

/** 原生选择授权仅限这个普通文件；不扫描、写入或保留其所在目录权限。 */
export async function readSpreadsheetFile(absolutePath: string): Promise<{ bytes: Buffer; displayName: string; fileFormat: 'xlsx' | 'xls' }> {
  try {
    if (!path.isAbsolute(absolutePath)) throw new SpreadsheetReadError();
    const displayName = path.basename(absolutePath), extension = path.extname(displayName).toLowerCase();
    if (!['.xlsx', '.xls'].includes(extension) || displayName.length > 255 || /[\\\x00-\x1f\x7f]/u.test(displayName)) throw new SpreadsheetReadError();
    const original = await lstat(absolutePath);
    if (!original.isFile() || original.isSymbolicLink() || original.size < 8 || original.size > MAX_WORKBOOK_BYTES) throw new SpreadsheetReadError();
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.ino !== original.ino || before.dev !== original.dev || before.size !== original.size
        || before.mtimeMs !== original.mtimeMs || before.ctimeMs !== original.ctimeMs) throw new SpreadsheetReadError();
      const output = Buffer.alloc(before.size + 1); let size = 0;
      while (size < output.length) { const read = await handle.read(output, size, output.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      const after = await handle.stat(), current = await lstat(absolutePath);
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) throw new SpreadsheetReadError();
      bytes = output.subarray(0, size);
    } finally { await handle.close(); }
    if (extension === '.xlsx' ? bytes.readUInt32LE(0) !== 0x04034b50 : !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new SpreadsheetReadError();
    return { bytes, displayName, fileFormat: extension === '.xlsx' ? 'xlsx' : 'xls' };
  } catch { throw new SpreadsheetReadError(); }
}
