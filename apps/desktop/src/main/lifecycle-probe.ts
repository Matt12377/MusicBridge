const phases = [
  'bootstrap-start', 'data-prepared', 'core-spawn', 'core-ready-received',
  'onready-complete', 'supervisor-ready', 'core-exit', 'ui-loaded', 'before-quit',
  'print-stop-requested', 'print-stop-settled', 'print-stop-failed',
  'remote-stop-start', 'remote-stop-end', 'core-shutdown-start', 'core-shutdown-end',
  'outbox-close-start', 'outbox-close-end', 'outbox-close-timeout',
  'app-quit-reissued', 'will-quit',
] as const
type Phase = typeof phases[number]
interface Options { enabled: boolean; sink(line: string): unknown; now?: () => number }

/** 仅合成UI诊断使用；观测失败不能改变业务控制流，也不包含任意调用方内容。 */
export function createLifecycleProbe({ enabled, sink, now = () => performance.now() }: Options) {
  let start: number | undefined, last = 0, count = 0
  if (enabled) {
    try { const value = now(); if (Number.isFinite(value)) start = value } catch { /* 没有可信起点，不输出时间。 */ }
  }
  const mark = (phase: Phase, exitCode?: number): void => {
    if (!enabled || start === undefined || count >= 256 || !phases.includes(phase)) return
    if (phase === 'core-exit' ? !Number.isInteger(exitCode) || exitCode! < -255 || exitCode! > 255 : exitCode !== undefined) return
    try {
      const elapsed = now() - start
      if (!Number.isFinite(elapsed) || elapsed < last || elapsed > Number.MAX_SAFE_INTEGER / 1000) return
      last = elapsed
      const value = { phase, elapsedMs: Math.round(elapsed * 1000) / 1000, ...(phase === 'core-exit' ? { exitCode } : {}) }
      count++
      void Promise.resolve(sink(`TASK078_LIFECYCLE ${JSON.stringify(value)}\n`)).catch(() => undefined)
    } catch { /* 时钟或sink异常不逸出Main，不记录内部错误。 */ }
  }
  return {
    mark,
    observe(promise: Promise<unknown>, settledPhase: Phase, failedPhase: Phase): void {
      if (!enabled) return
      // 只旁路观察；不返回替代Promise，也不改变原调用方的await/void政策。
      void Promise.resolve(promise).then(() => mark(settledPhase), () => mark(failedPhase)).catch(() => undefined)
    },
  }
}
