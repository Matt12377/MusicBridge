export interface StartupProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  output?: 'capture' | 'inherit'
  readyMarker?: string
  expectedMarker?: string
  startupTimeoutMs?: number
  exitTimeoutMs?: number
  killGraceMs?: number
  closeTimeoutMs?: number
  outputLimitBytes?: number
  /** 仅受控合成双崩溃探针，原文保存于私有目录，不进入返回摘要。 */
  rawCaptureDirectory?: string
}
export interface StartupProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  closed: boolean
  ready: boolean
  markerSeen: boolean
  failure: 'spawn-error' | 'startup-timeout' | 'exit-timeout' | 'close-timeout' | 'output-limit' | 'process-exit' | 'marker-missing' | 'capture-error' | null
}
export function runStartupProcess(command: string, args: string[], options?: StartupProcessOptions): Promise<StartupProcessResult>
