export type LocalWorkbenchQuitStep = readonly [phase: string, close: () => unknown]
export interface LocalWorkbenchQuitFailure { readonly phase: string; readonly reason: unknown }
export interface LocalWorkbenchQuitGroup {
  readonly steps: readonly LocalWorkbenchQuitStep[]
  readonly requiresPreviousSuccess?: boolean
  readonly onStart?: () => void
  readonly onSettled?: () => void
}

/** 只补首次登记的原关闭者；成功账本不把拒绝、超时或仍在途的工作当作闭口。 */
export function createLocalWorkbenchQuitCoordinator(options: {
  readonly groups: readonly LocalWorkbenchQuitGroup[]
  readonly onPhaseStart?: (phase: string) => void
  readonly onPhaseSettled?: (phase: string) => void
  readonly onFailure?: (failure: LocalWorkbenchQuitFailure, first: boolean) => void
}) {
  const names = new Set<string>()
  const groups = options.groups.map(group => ({ ...group, steps: group.steps.map(([phase, close]) => {
    if (names.has(phase)) throw new Error('退出关闭阶段重复，不能共用成功收据。')
    names.add(phase)
    return [phase, close] as const
  }) }))
  const completed = new Set<string>()
  let running: Promise<void> | undefined
  let confirmed = false
  let firstFailure: LocalWorkbenchQuitFailure | undefined
  const observe = (notify: (() => void) | undefined): void => {
    try { notify?.() } catch { /* 诊断旁注不能替代资源关闭，也不能改写原拒绝。 */ }
  }
  const run = async (): Promise<void> => {
    let failed = false
    for (const group of groups) {
      if (failed && group.requiresPreviousSuccess) continue
      const pending = group.steps.filter(([phase]) => !completed.has(phase))
      if (!pending.length) continue
      observe(group.onStart)
      const results = await Promise.allSettled(pending.map(([phase, close]) => Promise.resolve().then(() => {
        observe(() => options.onPhaseStart?.(phase))
        return close()
      }).then(() => {
        completed.add(phase)
        observe(() => options.onPhaseSettled?.(phase))
      }).catch(reason => {
        const first = firstFailure === undefined
        const failure = Object.freeze({ phase, reason })
        firstFailure ??= failure
        observe(() => options.onFailure?.(failure, first))
        throw reason
      })))
      observe(group.onSettled)
      if (results.some(result => result.status === 'rejected')) failed = true
    }
    if (failed) throw firstFailure?.reason
    confirmed = true
  }
  return {
    get firstFailure(): LocalWorkbenchQuitFailure | undefined { return firstFailure },
    get confirmed(): boolean { return confirmed },
    get pending(): boolean { return running !== undefined },
    request(): Promise<void> | undefined {
      if (confirmed || running) return undefined
      // 先公布同一在途尝试，再让任何原关闭回调执行；重复Quit不能并发收尾。
      const work = Promise.resolve().then(run)
      running = work
      const settled = () => { if (running === work) running = undefined }
      void work.then(settled, settled)
      return work
    },
  }
}
