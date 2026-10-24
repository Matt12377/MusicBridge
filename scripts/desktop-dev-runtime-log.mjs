import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

export const DESKTOP_RUNTIME_LOG_FILE_BYTES = 4 * 1024 * 1024;
export const DESKTOP_RUNTIME_LOG_FILES = 3;
export const DESKTOP_RUNTIME_LOG_PENDING_BYTES = 256 * 1024;
const CLOSE_WAIT_MS = 1000;
const ownedName = /^library-operation-[0-9]{17}-[0-9]+-[a-f0-9]{32}-[0-9]{6}\.log$/u;
const bounded = (value, maximum, minimum = 1) => Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : maximum;
function safeWarn(warn, text) { try { warn('[开发运行日志] ' + text); } catch { /* 提示不能改写开发进程或应用结果。 */ } }

/** 只在已验证构建完成后调用；日志在workspace之外，失败只关闭诊断旁路。 */
export async function createDesktopDevRuntimeLog(paths, {
  warn = text => console.error(text), maxFileBytes = DESKTOP_RUNTIME_LOG_FILE_BYTES,
  maxFiles = DESKTOP_RUNTIME_LOG_FILES, maxPendingBytes = DESKTOP_RUNTIME_LOG_PENDING_BYTES,
} = {}) {
  maxFileBytes = bounded(maxFileBytes, DESKTOP_RUNTIME_LOG_FILE_BYTES, 4096);
  maxFiles = bounded(maxFiles, DESKTOP_RUNTIME_LOG_FILES);
  maxPendingBytes = bounded(maxPendingBytes, DESKTOP_RUNTIME_LOG_PENDING_BYTES, 4096);
  let handle, currentFile, firstFile, bytes = 0, sequence = 0;
  let directory, base, createReader;
  const off = { enabled: false, firstFile: null, stdout() {}, stderr() {}, async close() {} };
  const release = async () => { const previous = handle; handle = undefined; if (previous) await previous.close(); };
  const retain = async () => {
    const candidates = [];
    for (const name of await fs.readdir(directory)) {
      if (!ownedName.test(name)) continue;
      const file = paths.policy.check(path.join(directory, name), { mustExist: true, kind: 'file' });
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxFileBytes) throw new Error('日志文件身份或大小不符。');
      candidates.push({ file, name, modified: info.mtimeMs });
    }
    candidates.sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
    const keep = new Set([currentFile, ...candidates.filter(value => value.file !== currentFile).slice(0, maxFiles - 1).map(value => value.file)]);
    for (const candidate of candidates) if (!keep.has(candidate.file)) await fs.unlink(candidate.file);
  };
  const openSegment = async () => {
    if (sequence > 999999) throw new Error('日志分段预算已结束。');
    currentFile = paths.policy.check(path.join(directory, base + '-' + String(sequence++).padStart(6, '0') + '.log'), { kind: 'file' });
    handle = await fs.open(currentFile, 'wx', 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('日志文件身份无效。');
    paths.policy.check(currentFile, { mustExist: true, kind: 'file' });
    bytes = 0; firstFile ??= currentFile;
    await retain();
  };
  try {
    paths.policy.check(paths.root, { mustExist: true });
    if (paths.workspace !== path.join(paths.root, 'workspace')) throw new Error('开发副本身份不符。');
    const validator = paths.policy.check(path.join(paths.workspace, 'packages/bridge-core/dist/shared/library-operation-log.js'), { mustExist: true, kind: 'file' });
    const compiled = await import(pathToFileURL(validator).href);
    if (typeof compiled.readLibraryOperationLine !== 'function' || typeof compiled.createLibraryOperationLogReader !== 'function') throw new Error('原日志校验器不可用。');
    // 复用原reader：原readLibraryOperationLine核通过才将canonical闭集正文送入待写队列。
    createReader = compiled.createLibraryOperationLogReader;
    directory = paths.policy.check(path.join(paths.root, 'logs'));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    paths.policy.check(directory, { mustExist: true });
    const stamp = new Date().toISOString().replace(/\D/gu, '');
    base = 'library-operation-' + stamp + '-' + process.pid + '-' + randomUUID().replaceAll('-', '');
    await openSegment();
  } catch {
    void release().catch(() => {});
    safeWarn(warn, '初始化失败，仅保留原终端输出；应用启动不受影响。');
    return off;
  }
  const queue = [];
  let pendingBytes = 0, writing = false, disabled = false, closing = false, closeWork, closeTimer, finishClose;
  const done = () => { clearTimeout(closeTimer); finishClose?.(); };
  const stop = text => {
    if (!disabled) { disabled = true; queue.length = 0; pendingBytes = 0; safeWarn(warn, text); }
  };
  async function pump() {
    if (writing) return;
    writing = true;
    try {
      while (!disabled && queue.length) {
        const buffer = queue.shift(); pendingBytes -= buffer.length;
        if (bytes + buffer.length > maxFileBytes) { await release(); if (disabled) break; await openSegment(); }
        let offset = 0;
        while (!disabled && offset < buffer.length) {
          const result = await handle.write(buffer, offset, buffer.length - offset, null);
          if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) throw new Error('日志写入未推进。');
          offset += result.bytesWritten; bytes += result.bytesWritten;
        }
      }
    } catch { stop('写入失败，已停止持久化；原终端输出继续。'); }
    finally {
      writing = false;
      if (disabled || closing) {
        try { await release(); } catch { stop('文件关闭失败，已停止持久化；应用结果不受影响。'); }
        done();
      }
    }
  }
  const enqueue = line => {
    if (disabled) return;
    const buffer = Buffer.from(line, 'utf8');
    if (buffer.length > maxFileBytes || pendingBytes + buffer.length > maxPendingBytes) {
      stop('待写队列达到上限，已停止持久化；原终端输出继续。'); void pump(); return;
    }
    queue.push(buffer); pendingBytes += buffer.length; void pump();
  };
  const stdoutReader = createReader(enqueue), stderrReader = createReader(enqueue);
  const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
  const consume = (decoder, reader, chunk) => {
    if (disabled || closing) return;
    try { reader(decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)); }
    catch { stop('事件读取失败，已停止持久化；原终端输出继续。'); void pump(); }
  };
  return {
    enabled: true, firstFile,
    stdout: chunk => consume(stdoutDecoder, stdoutReader, chunk), stderr: chunk => consume(stderrDecoder, stderrReader, chunk),
    close() {
      if (closeWork) return closeWork;
      closeWork = new Promise(resolve => { finishClose = resolve; });
      if (!disabled) {
        try { stdoutReader(stdoutDecoder.end() + '\n'); stderrReader(stderrDecoder.end() + '\n'); }
        catch { stop('尾部事件读取失败，已停止持久化；应用结果不受影响。'); }
      }
      closing = true;
      closeTimer = setTimeout(() => { stop('收尾超过1秒，已停止新记录；开发锁按原流程释放。'); done(); }, CLOSE_WAIT_MS);
      void pump(); return closeWork;
    },
  };
}

/** 原字节分别转发到原stdout/stderr；stdin与child的信号/退出处理仍由开发入口负责。 */
export function teeDesktopRuntimeOutput(child, log, { stdout = process.stdout, stderr = process.stderr, warn = text => console.error(text) } = {}) {
  const detached = [];
  for (const [source, destination, consume] of [[child.stdout, stdout, log.stdout], [child.stderr, stderr, log.stderr]]) {
    if (!source) continue;
    const onData = chunk => { try { consume(chunk); } catch { /* 诊断异常不能中断原输出。 */ } };
    const onError = () => { source.unpipe(destination); safeWarn(warn, '终端输出通道不可写，应用继续运行。'); };
    source.pipe(destination, { end: false }); source.on('data', onData); destination.on('error', onError);
    detached.push(() => { source.off('data', onData); source.unpipe(destination); destination.off('error', onError); });
  }
  return () => { for (const detach of detached.splice(0)) detach(); };
}
