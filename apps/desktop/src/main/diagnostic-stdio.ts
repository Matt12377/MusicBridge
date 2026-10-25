interface DiagnosticOutputStream {
  readonly destroyed?: boolean
  readonly writableEnded?: boolean
  on(event: 'error' | 'close', listener: () => void): unknown
  write(line: string): boolean
}

type DiagnosticWriter = (line: string) => void
const writers = new WeakMap<DiagnosticOutputStream, DiagnosticWriter>()

/** 诊断管道失效只关闭该路输出；监听随流保留，接住迟到的异步错误。 */
export function createDiagnosticWriter(stream: DiagnosticOutputStream): DiagnosticWriter {
  const existing = writers.get(stream)
  if (existing) return existing

  let failed = false
  const disable = () => { failed = true }
  stream.on('error', disable)
  stream.on('close', disable)
  const write: DiagnosticWriter = line => {
    if (failed || stream.destroyed || stream.writableEnded) return
    try { stream.write(line) } catch { disable() }
    // 不重试、不递归记录输出错误，也不把反压的 false 当成永久失败。
  }
  writers.set(stream, write)
  return write
}

/** 启动时先覆盖两路异步错误；后续调用复用同一监听，不按日志行增长。 */
export function installDiagnosticStdioProtection(
  stdio: { stdout: DiagnosticOutputStream; stderr: DiagnosticOutputStream } = process,
): void {
  createDiagnosticWriter(stdio.stdout)
  createDiagnosticWriter(stdio.stderr)
}

export function writeDiagnosticStdout(line: string): void {
  createDiagnosticWriter(process.stdout)(line)
}

export function writeDiagnosticStderr(line: string): void {
  createDiagnosticWriter(process.stderr)(line)
}
