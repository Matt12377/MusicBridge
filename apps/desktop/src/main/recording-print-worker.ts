import { randomUUID } from 'node:crypto'
import type { IpcCommandPayloads } from '@music-bridge/contracts'
import type { CoreSupervisor } from './core-supervisor.js'
import type { createRecordingPrintRenderer } from './recording-print-renderer.js'

const allowedErrors = ['RENDER_FAILED', 'LAYOUT_OVERFLOW', 'RENDER_TIMEOUT', 'OBJECT_LIMIT'] as const
/** 与UI生命周期无关的串行worker；只恢复打印，不恢复录音或保存对话框。 */
export function createRecordingPrintWorker(options: {
  datasetId: string
  requestInternal: CoreSupervisor['requestInternal']
  renderer: Pick<ReturnType<typeof createRecordingPrintRenderer>, 'render' | 'close'>
  intervalMs?: number
}) {
  const workerId = randomUUID(), intervalMs = options.intervalMs ?? 1_500
  let stopped = false, started = false, timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<void> | undefined
  function schedule(): void {
    if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.() }
  }
  async function cycle(): Promise<void> {
    const claimed = await options.requestInternal('recordingPrintWorker.claim', { workerId }, options.datasetId)
    if (stopped || !claimed.lease) return
    const lease = claimed.lease
    const identity = { leaseId: lease.leaseId, workerId, jobId: lease.jobId, inputHash: lease.inputHash }
    try {
      const output = await options.renderer.render(lease)
      if (stopped) return
      const payload: IpcCommandPayloads['recordingPrintWorker.complete'] = { ...identity, ...output }
      // 原提交可能已落盘；仅重试同一有界结果，不重渲染、不替换旧PDF。
      try { await options.requestInternal('recordingPrintWorker.complete', payload, options.datasetId) }
      catch (error) {
        if (stopped) return
        await options.requestInternal('recordingPrintWorker.complete', payload, options.datasetId)
      }
    } catch (error) {
      if (stopped) return
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      const errorCode = allowedErrors.find(value => value === code) ?? 'RENDER_FAILED'
      // Core只接受仍有效lease；已完成或换库不会被这份迟到故障改写。
      await options.requestInternal('recordingPrintWorker.fail', { ...identity, errorCode }, options.datasetId)
    }
  }
  function run(): void {
    if (stopped || flight) return
    flight = cycle().catch(() => undefined).finally(() => { flight = undefined; schedule() })
  }
  return {
    start(): void { if (started || stopped) return; started = true; run() },
    async stop(): Promise<void> {
      if (!stopped) { stopped = true; if (timer) clearTimeout(timer); options.renderer.close() }
      await flight
    },
  }
}
