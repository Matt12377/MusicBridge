import { AsyncLocalStorage } from 'node:async_hooks'
import { type PerformanceTraceContext, type PerformanceTraceRecorder, type PerformanceTraceSnapshot } from '@music-bridge/contracts'
import { readPerformanceMetadata } from '../shared/performance-transport.js'

export function createPerformanceIpcBridge(recorder: PerformanceTraceRecorder): {
  context(): PerformanceTraceContext | undefined
  rendererSnapshot(): PerformanceTraceSnapshot | undefined
  wrap<TEvent>(handler: (event: TEvent, ...args: any[]) => any, acceptMetadata?: (event: TEvent) => boolean): (event: TEvent, ...args: any[]) => Promise<any>
} {
  const contexts = new AsyncLocalStorage<PerformanceTraceContext>()
  let renderer: PerformanceTraceSnapshot | undefined
  return {
    context: () => contexts.getStore(),
    rendererSnapshot: () => renderer,
    wrap: (handler, acceptMetadata) => async (event, ...args) => {
      if (!recorder.isEnabled()) return handler(event, ...args)
      // 诊断输入也遵循既有 Renderer 信任边界；失败仍由原处理函数返回。
      const metadata = !acceptMetadata || acceptMetadata(event) ? readPerformanceMetadata(args.at(-1)) : undefined
      const context = metadata ? recorder.childContext(metadata.context) : recorder.context()
      if (metadata) {
        args.pop()
        if (metadata.renderer) renderer = metadata.renderer
      }
      const span = recorder.start('ipc', context)
      recorder.mark('ipc', 'main-received', context)
      const execute = async (): Promise<unknown> => {
        try { const result = await handler(event, ...args); span.end('ok'); return result }
        catch (error) { span.end('error'); throw error }
      }
      return context ? contexts.run(context, execute) : execute()
    },
  }
}
