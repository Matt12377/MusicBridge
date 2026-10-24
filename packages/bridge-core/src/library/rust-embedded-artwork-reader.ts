import type { FileHandle } from 'node:fs/promises'
import { getRustMediaWorkerPool, RustMediaWorkerError } from './rust-media-worker.js'
import { logLibraryOperation } from '../shared/library-operation-log.js'

/** 调用者持有原源许可和FD关闭权；Rust只通过有界位置读取RPC借用句柄。 */
export async function readRustEmbeddedArtwork(handle: FileHandle, size: number, signal: AbortSignal): Promise<ReadonlyArray<{ bytes: Uint8Array; pictureIndex: number }>> {
  const started = performance.now()
  logLibraryOperation('artwork', 'embedded.read', 'start')
  try {
    const result = await getRustMediaWorkerPool().readEmbeddedArtwork({ size, async read(offset, length) {
      if (signal.aborted) throw new RustMediaWorkerError('CANCELLED')
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > 64 * 1024 || offset > size || length > size - offset) throw new RustMediaWorkerError('BUDGET_EXCEEDED')
      const buffer = Buffer.alloc(length), read = await handle.read(buffer, 0, length, offset)
      if (signal.aborted) throw new RustMediaWorkerError('CANCELLED')
      return buffer.subarray(0, read.bytesRead)
    } }, signal)
    logLibraryOperation('artwork', 'embedded.read', 'complete', { elapsedMs: performance.now() - started, count: result.items.length, bytes: result.readEvidence.bytesRead,
      readMs: result.performance.readMs, parseMs: result.performance.parseMs, queueWaitMs: result.performance.queueWaitMs, slowAfterMs: 100 })
    return Object.freeze(result.items.map(item => Object.freeze({ bytes: item.bytes, pictureIndex: item.pictureIndex })))
  } catch (error) {
    logLibraryOperation('artwork', 'embedded.read', signal.aborted ? 'cancelled' : 'error', { elapsedMs: performance.now() - started, code: error instanceof RustMediaWorkerError ? error.code : 'IO_ERROR', slowAfterMs: 100 })
    throw error
  }
}
