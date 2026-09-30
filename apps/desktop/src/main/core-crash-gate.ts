import { performance } from 'node:perf_hooks'
import type { CoreSupervisorStatus } from './core-supervisor.js'

/** 仅合成崩溃Gate等待真实终态；不改变生产Core的重启次数或启动期限。 */
export async function waitForCoreCrashFailure(
  observe: () => { status: CoreSupervisorStatus; restarts: number },
  { timeoutMs = 10_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) throw new Error('崩溃Gate等待参数无效')
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const current = observe()
    if (current.status === 'failed') return current.restarts === 1
    if (current.status === 'stopped' || current.restarts > 1) return false
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)))
  }
}
