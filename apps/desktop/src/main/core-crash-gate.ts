import { performance } from 'node:perf_hooks'
import type { CoreSupervisorStatus } from './core-supervisor.js'

export interface CoreCrashGateObservation {
  status: CoreSupervisorStatus
  restarts: number
  lifecycle: readonly { event: 'spawn' | 'ready' | 'exit'; code?: number }[]
}

function hasTwoConfirmedCrashes(observation: CoreCrashGateObservation): boolean {
  const events = observation.lifecycle
  if (!Array.isArray(events) || events.length !== 6) return false
  return events.every((entry, index) => {
    const expected = ['spawn', 'ready', 'exit'][index % 3]
    if (!entry || entry.event !== expected) return false
    const keys = Object.keys(entry)
    return expected === 'exit'
      ? keys.length === 2 && keys.includes('event') && keys.includes('code') && entry.code === 71
      : keys.length === 1 && keys[0] === 'event'
  })
}

/** 仅合成崩溃 Gate 等真实两轮生命周期；不改变重启次数或等待期限。 */
export async function waitForCoreCrashFailure(
  observe: () => CoreCrashGateObservation,
  { timeoutMs = 10_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) throw new Error('崩溃Gate等待参数无效')
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const current = observe()
    if (current.status === 'failed') return current.restarts === 1 && hasTwoConfirmedCrashes(current)
    if (current.status === 'stopped' || current.restarts > 1) return false
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)))
  }
}
