import { spawn } from 'node:child_process'

// 只拥有本次spawn的直接子进程；不扫描PID、不终止进程组或其他应用。
export function runStartupProcess(command, args, options = {}) {
  const {
    cwd, env = process.env, output = 'capture', readyMarker, expectedMarker,
    startupTimeoutMs = 30_000, exitTimeoutMs = 30_000,
    killGraceMs = 1_000, closeTimeoutMs = 2_000, outputLimitBytes = 65_536,
  } = options
  const limits = [startupTimeoutMs, exitTimeoutMs, killGraceMs, closeTimeoutMs, outputLimitBytes]
  if (limits.some(value => !Number.isSafeInteger(value) || value < 1 || value > 1_048_576)
    || !['capture', 'inherit'].includes(output)
    || [readyMarker, expectedMarker].some(value => value !== undefined && (typeof value !== 'string' || !value.length || value.length > 128))
    || (output === 'inherit' && (readyMarker || expectedMarker))) throw new Error('进程等待配置无效')

  return new Promise(resolve => {
    let child, settled = false, exited = false, code = null, signal = null, failure = null
    let ready = !readyMarker, markerSeen = !expectedMarker, bytes = 0, tail = ''
    let deadline, escalation, cleanup, closeDeadline
    const tailLength = Math.max(readyMarker?.length ?? 0, expectedMarker?.length ?? 0) - 1
    function finish(closed) {
      if (settled) return
      settled = true
      for (const timer of [deadline, escalation, cleanup, closeDeadline]) clearTimeout(timer)
      if (!failure) failure = code !== 0 || signal !== null ? 'process-exit' : !markerSeen ? 'marker-missing' : null
      // 未能取得close时只关闭本脚本持有的管道；不能把本地释放伪报为子进程正常关闭。
      if (!closed) {
        child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref()
      }
      resolve({ code, signal, closed, ready, markerSeen, failure })
    }
    function killOwned(signal) {
      if (!exited && child?.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal) } catch { /* 仍由有界close收口报告失败，不打印内部错误。 */ }
      }
    }
    function fail(reason) {
      if (settled || failure) return
      failure = reason
      clearTimeout(deadline)
      if (exited) { finish(false); return }
      killOwned('SIGTERM')
      escalation = setTimeout(() => {
        killOwned('SIGKILL')
        cleanup = setTimeout(() => finish(false), closeTimeoutMs)
      }, killGraceMs)
    }
    function armDeadline() {
      clearTimeout(deadline)
      deadline = setTimeout(() => fail(exited ? 'close-timeout' : ready ? 'exit-timeout' : 'startup-timeout'), ready ? exitTimeoutMs : startupTimeoutMs)
    }
    function consume(chunk, stdout) {
      if (settled || failure) return
      bytes += chunk.length
      if (bytes > outputLimitBytes) { fail('output-limit'); return }
      if (!stdout) return
      const text = tail + chunk.toString('utf8')
      if (!ready && text.includes(readyMarker)) { ready = true; armDeadline() }
      if (!markerSeen && text.includes(expectedMarker)) markerSeen = true
      tail = tailLength > 0 ? text.slice(-tailLength) : ''
    }
    try {
      child = spawn(command, args, { cwd, env, stdio: output === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    } catch {
      failure = 'spawn-error'; finish(false); return
    }
    armDeadline()
    child.stdout?.on('data', chunk => consume(chunk, true))
    child.stderr?.on('data', chunk => consume(chunk, false))
    child.on('error', () => fail('spawn-error'))
    child.once('exit', (exitCode, exitSignal) => {
      exited = true; code = exitCode; signal = exitSignal
      if (!settled) closeDeadline = setTimeout(() => {
        if (!failure) failure = 'close-timeout'
        finish(false)
      }, closeTimeoutMs)
    })
    child.once('close', (exitCode, exitSignal) => {
      code = exitCode; signal = exitSignal
      finish(true)
    })
  })
}
