import {
  copyPerformanceTraceContext,
  copyPerformanceTraceSnapshot,
  type PerformanceTraceContext,
  type PerformanceTraceSnapshot,
  type PerformanceTraceRecorder,
  type PerformanceOperation,
  type PerformanceOutcome,
  type PerformanceSpan,
} from '@music-bridge/contracts'

export interface PerformanceTransportMetadata {
  __musicBridgePerformance: 1
  context: PerformanceTraceContext
  renderer?: PerformanceTraceSnapshot
}

/** 诊断只接受白名单数值和随机身份；绝不转发业务参数。 */
export function readPerformanceMetadata(value: unknown): PerformanceTransportMetadata | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const input = value as Record<string, unknown>
    if (input.__musicBridgePerformance !== 1
      || Object.keys(input).some(key => !['__musicBridgePerformance', 'context', 'renderer'].includes(key))) return undefined
    const context = copyPerformanceTraceContext(input.context)
    if (!context) return undefined
    const renderer = input.renderer === undefined ? undefined : copyPerformanceTraceSnapshot(input.renderer)
    if (input.renderer !== undefined && (!renderer || renderer.component !== 'renderer')) return undefined
    return { __musicBridgePerformance: 1, context, ...(renderer ? { renderer } : {}) }
  } catch { return undefined }
}

export function createPerformanceInvoker(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  recorder: PerformanceTraceRecorder,
  afterFrame?: (callback: () => void) => void,
  consumeInteraction?: () => PerformanceTraceContext | undefined,
): (channel: string, ...args: unknown[]) => Promise<unknown> {
  return async (channel, ...args) => {
    if (!recorder.isEnabled()) return invoke(channel, ...args)
    let parent: PerformanceTraceContext | undefined
    try { parent = consumeInteraction?.() } catch { /* 交互诊断故障不得阻止业务调用。 */ }
    const span = recorder.start('ipc', parent ? recorder.childContext(parent) : undefined)
    const context = span.context
    if (!context) return invoke(channel, ...args)
    const metadata: PerformanceTransportMetadata = {
      __musicBridgePerformance: 1,
      context,
      ...(channel === 'diagnostics:export' ? { renderer: recorder.snapshot() } : {}),
    }
    try {
      const result = await invoke(channel, ...args, metadata)
      span.end('ok')
      // 这是 IPC 返回后的下一帧标记；不冒充声音开始或业务数据已呈现。
      try { afterFrame?.(() => recorder.mark('render', 'first-render', context)) } catch { /* 诊断不得改变结果。 */ }
      return result
    } catch (error) {
      span.end('error')
      throw error
    }
  }
}

export interface PerformanceInteractionDiagnostics {
  begin(operation: PerformanceOperation): PerformanceTraceContext | undefined
  use(context: PerformanceTraceContext | undefined): void
  end(context: PerformanceTraceContext | undefined, outcome?: PerformanceOutcome): void
}

export function createPerformanceInteractions(recorder: PerformanceTraceRecorder): {
  api: PerformanceInteractionDiagnostics
  consume(): PerformanceTraceContext | undefined
} {
  const active = new Map<string, PerformanceSpan>()
  let current: PerformanceTraceContext | undefined
  const owned = (value: unknown): PerformanceTraceContext | undefined => {
    const context = copyPerformanceTraceContext(value)
    return context && active.get(context.requestId)?.context?.traceId === context.traceId ? context : undefined
  }
  return {
    consume: () => { const context = current; current = undefined; return context },
    api: {
      begin: operation => {
        if (!recorder.isEnabled()) return undefined
        const span = recorder.start(operation)
        if (span.context) {
          active.set(span.context.requestId, span)
          recorder.mark('render', 'renderer-click', span.context)
        }
        return span.context
      },
      use: context => { current = owned(context) },
      end: (context, outcome) => {
        const safe = owned(context)
        if (!safe) return
        active.get(safe.requestId)?.end(outcome)
        active.delete(safe.requestId)
        if (current?.requestId === safe.requestId) current = undefined
      },
    },
  }
}
