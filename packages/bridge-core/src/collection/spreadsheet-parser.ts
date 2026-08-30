import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { isParsedSpreadsheetWorkbook, type ParsedSpreadsheetWorkbook } from '@music-bridge/contracts';
import { MAX_WORKBOOK_BYTES } from './spreadsheet-files.js';
let activeWorker: Worker | undefined;

export class SpreadsheetParseError extends Error {
  readonly code = 'INVALID_IPC_REQUEST';
  constructor() { super('工作簿无法解析或超过安全预算，请核对文件；未写入库存。'); }
}

/** 一个可终止Worker处理一份内存输入；不是OS沙箱，原路径不进入解析线程。 */
export async function parseSpreadsheetWorkbook(bytes: Uint8Array, fileFormat: 'xlsx' | 'xls', options: { timeoutMs?: number } = {}): Promise<ParsedSpreadsheetWorkbook> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > MAX_WORKBOOK_BYTES || !['xlsx', 'xls'].includes(fileFormat)) throw new SpreadsheetParseError();
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new SpreadsheetParseError();
  if (activeWorker) throw new SpreadsheetParseError();
  const built = new URL('./spreadsheet-worker.js', import.meta.url), entry = existsSync(built) ? built : new URL('./spreadsheet-worker.ts', import.meta.url);
  const worker = new Worker(entry, { workerData: { bytes, fileFormat }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  activeWorker = worker;
  try {
    return await new Promise<ParsedSpreadsheetWorkbook>((resolve, reject) => {
      const fail = () => reject(new SpreadsheetParseError());
      const timer = setTimeout(fail, timeoutMs);
      const cleanup = () => clearTimeout(timer);
      worker.once('error', () => { cleanup(); fail(); });
      worker.once('exit', () => { cleanup(); fail(); });
      worker.once('message', (message: unknown) => {
        cleanup();
        if (!message || typeof message !== 'object' || !('ok' in message) || message.ok !== true || !('value' in message)) return fail();
        if (!isParsedSpreadsheetWorkbook(message.value) || message.value.fileFormat !== fileFormat) return fail();
        resolve(message.value);
      });
    });
  } finally { try { await worker.terminate(); } finally { if (activeWorker === worker) activeWorker = undefined; } }
}
