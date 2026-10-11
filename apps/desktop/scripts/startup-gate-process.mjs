import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

function privateSyntheticCapture(directory, env, expectedMarker, output, limit) {
  const flags = ['MUSIC_BRIDGE_UI_E2E', 'MUSIC_BRIDGE_STARTUP_TEST', 'MUSIC_BRIDGE_CORE_TEST_MODE', 'MUSIC_BRIDGE_CORE_CRASH_GATE']
  if (typeof directory !== 'string' || directory.length > 1024 || !path.isAbsolute(directory)
    || flags.some(key => env[key] !== '1') || env.NETEASE_COOKIE !== undefined
    || output !== 'capture' || expectedMarker !== 'CORE_CRASH_GATE_PASS' || limit > 65_536) throw new Error('合成崩溃私有捕获配置无效')
  const temporary = fs.realpathSync(os.tmpdir())
  const ownedDirectory = (value, pattern) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !pattern.test(path.basename(value))) throw new Error('私有目录无效')
    const resolved = path.resolve(value), entry = fs.lstatSync(resolved)
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700
      || fs.realpathSync(resolved) !== resolved || fs.realpathSync(path.dirname(resolved)) !== temporary
      || typeof process.getuid === 'function' && entry.uid !== process.getuid()) throw new Error('私有目录无效')
    return { resolved, dev: entry.dev, ino: entry.ino }
  }
  const own = ownedDirectory(directory, /^musicbridge-task036-crash-capture-[A-Za-z0-9._-]+$/u)
  ownedDirectory(env.MUSIC_BRIDGE_STARTUP_USER_DATA_DIR, /^musicbridge-task036-startup-[A-Za-z0-9._-]+$/u)
  const streams = new Map(), opening = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
  let retained = 0, observed = 0, truncated = false, closed = false
  const ensureDirectory = () => {
    const current = fs.lstatSync(own.resolved)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== own.dev || current.ino !== own.ino
      || (current.mode & 0o777) !== 0o700) throw new Error('私有目录已变化')
  }
  const closeStreams = () => {
    for (const entry of streams.values()) if (entry.fd !== undefined) {
      const fd = entry.fd; entry.fd = undefined
      try { fs.closeSync(fd) } catch { /* 调用方仍保留捕获失败。 */ }
    }
  }
  try {
    for (const name of ['stdout', 'stderr']) {
      ensureDirectory()
      const location = path.join(own.resolved, name + '.log'), fd = fs.openSync(location, opening, 0o600)
      const entry = { fd, path: location, bytes: 0, hash: createHash('sha256') }; streams.set(name, entry)
      const info = fs.fstatSync(fd)
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('私有文件无效')
    }
  } catch (error) { closeStreams(); throw error }
  return {
    consume(name, chunk) {
      if (closed) return
      observed += chunk.length
      const entry = streams.get(name), copy = chunk.subarray(0, Math.max(0, limit - retained))
      let offset = 0
      while (offset < copy.length) {
        const written = fs.writeSync(entry.fd, copy, offset, copy.length - offset)
        if (written < 1) throw new Error('私有捕获写入失败')
        entry.hash.update(copy.subarray(offset, offset + written)); entry.bytes += written; retained += written; offset += written
      }
      if (observed > limit) truncated = true
    },
    finish(result) {
      if (closed) return
      closed = true
      try {
        ensureDirectory()
        const raw = {}
        for (const [name, entry] of streams) {
          const info = fs.fstatSync(entry.fd)
          if (!info.isFile() || info.size !== entry.bytes || (info.mode & 0o777) !== 0o600) throw new Error('私有捕获文件变化')
          fs.fsyncSync(entry.fd); fs.closeSync(entry.fd); entry.fd = undefined
          raw[name] = { path: entry.path, bytes: entry.bytes, sha256: entry.hash.digest('hex') }
        }
        const record = { schema: 'musicbridge.synthetic-core-crash-capture.v1', result, observedBytes: observed,
          retainedBytes: retained, combinedLimitBytes: limit, truncated,
          complete: result.closed && !truncated && observed === retained && result.failure !== 'capture-error', raw }
        const buffer = Buffer.from(JSON.stringify(record, null, 2) + '\n'), file = path.join(own.resolved, 'capture.json')
        const fd = fs.openSync(file, opening, 0o600)
        try {
          let offset = 0
          while (offset < buffer.length) {
            const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
            if (written < 1) throw new Error('私有捕获收据写入失败')
            offset += written
          }
          fs.fsyncSync(fd)
        } finally { fs.closeSync(fd) }
      } finally { closeStreams() }
    },
  }
}

// 只拥有本次spawn的直接子进程；不扫描PID、不终止进程组或其他应用。
export function runStartupProcess(command, args, options = {}) {
  const {
    cwd, env = process.env, output = 'capture', readyMarker, expectedMarker, rawCaptureDirectory,
    startupTimeoutMs = 30_000, exitTimeoutMs = 30_000,
    killGraceMs = 1_000, closeTimeoutMs = 2_000, outputLimitBytes = 65_536,
  } = options
  const limits = [startupTimeoutMs, exitTimeoutMs, killGraceMs, closeTimeoutMs, outputLimitBytes]
  if (limits.some(value => !Number.isSafeInteger(value) || value < 1 || value > 1_048_576)
    || !['capture', 'inherit'].includes(output)
    || [readyMarker, expectedMarker].some(value => value !== undefined && (typeof value !== 'string' || !value.length || value.length > 128))
    || (output === 'inherit' && (readyMarker || expectedMarker))) throw new Error('进程等待配置无效')

  return new Promise(resolve => {
    let child, settled = false, exited = false, code = null, signal = null, failure = null, capture
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
      if (capture) {
        try { capture.finish({ code, signal, closed, ready, markerSeen, failure }) }
        catch { failure = 'capture-error' }
      }
      // 默认和显式捕获都保留原六字段；私有原文只写入专用文件。
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
      if (settled) return
      // 失败进程的剩余输出仍读至natural close；原合计限额不改变。
      if (capture) {
        try { capture.consume(stdout ? 'stdout' : 'stderr', chunk) }
        catch { fail('capture-error'); return }
      }
      if (failure) return
      bytes += chunk.length
      if (bytes > outputLimitBytes) { fail('output-limit'); return }
      if (!stdout) return
      const text = tail + chunk.toString('utf8')
      if (!ready && text.includes(readyMarker)) { ready = true; armDeadline() }
      if (!markerSeen && text.includes(expectedMarker)) markerSeen = true
      tail = tailLength > 0 ? text.slice(-tailLength) : ''
    }
    if (rawCaptureDirectory !== undefined) {
      try { capture = privateSyntheticCapture(rawCaptureDirectory, env, expectedMarker, output, outputLimitBytes) }
      catch { failure = 'capture-error'; finish(true); return }
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
