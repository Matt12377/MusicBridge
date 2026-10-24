import type { LyricsSnapshot } from '@music-bridge/contracts';
import { emptyLyricsSnapshot } from '../netease/lyrics.js';
import type { LocalSourceFacts } from '../application/local-source-facts.js';
import { MetadataLeaseReleaseError, SourceFileError, readonlySourceCandidateMetadata, withCheckedReadonlyMetadataSource } from '../recording/source-files.js';
import { isLocalSourceLyricsSnapshot } from '../collection/local-source-ticket-types.js';
import { logLibraryOperation } from '../shared/library-operation-log.js';
import { getRustMediaWorkerPool, RustMediaWorkerError } from './rust-media-worker.js';
import type { MetadataEmbeddedLyricsCandidate } from './metadata-reader-types.js';

const MAX_BYTES = 64 * 1024, MAX_LINES = 500, MAX_TEXT = 2048, MAX_TIME = 24 * 60 * 60 * 1000, READ_MS = 2000;
const unavailable = (): LyricsSnapshot => emptyLyricsSnapshot('unavailable');
/** 只接受完整、有界、严格UTF8的同步LRC；不猜编码、不截行、不推断纯音乐或网络来源。 */
export function parseLocalPlaybackLrc(raw: Uint8Array): LyricsSnapshot {
  if (raw.byteLength < 1 || raw.byteLength > MAX_BYTES) return unavailable();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return unavailable(); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return unavailable();
  let offset = 0, offsetSeen = false, timestamps = 0;
  const lines: { startMs: number; endMs?: number; text: string }[] = [];
  const timestamp = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/u;
  for (const rawLine of text.split(/\r\n|\n|\r/u)) {
    const line = rawLine.trim(); if (!line) continue;
    if (/^\[(?:ar|al|ti|au|by|re|ve):[^\]\r\n]*\]$/iu.test(line)) continue;
    const shift = /^\[offset:([+-]?\d{1,8})\]$/iu.exec(line);
    if (shift) { if (offsetSeen) return unavailable(); offsetSeen = true; offset = Number(shift[1]); continue; }
    const starts: number[] = []; let remaining = line;
    for (;;) {
      const match = timestamp.exec(remaining); if (!match) break;
      const value = Number(match[1]) * 60_000 + Number(match[2]) * 1000 + Number((match[3] ?? '').padEnd(3, '0'));
      if (Number(match[2]) >= 60 || !Number.isSafeInteger(value) || value > MAX_TIME || ++timestamps > MAX_LINES) return unavailable();
      starts.push(value); remaining = remaining.slice(match[0].length);
    }
    const body = remaining.trim();
    if (!starts.length || body.length > MAX_TEXT || /[\u0000-\u001f\u007f]/u.test(body)) return unavailable();
    // 空同步行是常见间奏/起止标记；已校验并计时间戳预算，不能使整份有正文的LRC失效。
    if (!body) continue;
    for (const startMs of starts) lines.push({ startMs, text: body });
  }
  if (!lines.length) return unavailable();
  for (const line of lines) { line.startMs += offset; if (line.startMs < 0 || line.startMs > MAX_TIME) return unavailable(); }
  return timedLyrics(lines);
}
function timedLyrics(lines: { startMs: number; endMs?: number; text: string }[]): LyricsSnapshot {
  if (!lines.length || lines.length > MAX_LINES) return unavailable();
  lines.sort((a, b) => a.startMs - b.startMs);
  let previousStart: number | undefined, nextStart: number | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (previousStart !== undefined && previousStart > line.startMs) nextStart = previousStart;
    if (nextStart !== undefined) line.endMs = nextStart;
    previousStart = line.startMs;
  }
  const result: LyricsSnapshot = { status: 'ready', lines, activeLineIndex: -1, timingSource: 'static' };
  return isLocalSourceLyricsSnapshot(result) ? result : unavailable();
}
/** 只把实际同步正文投成原合同；USLT纯文本不会生成伪造时间戳。 */
function embeddedLyrics(items: readonly MetadataEmbeddedLyricsCandidate[]): { snapshot: LyricsSnapshot; code: string } {
  const choices = new Map<string, LyricsSnapshot>();
  for (const item of items) {
    const snapshot = item.kind === 'uslt' ? parseLocalPlaybackLrc(Buffer.from(item.text, 'utf8'))
      : timedLyrics(item.lines.filter(line => line.text.trim()).map(line => ({ startMs: line.startMs, text: line.text.trim() })));
    if (snapshot.status === 'ready') choices.set(JSON.stringify(snapshot.lines), snapshot);
  }
  if (choices.size !== 1) return { snapshot: unavailable(), code: choices.size > 1 ? 'EMBEDDED_AMBIGUOUS' : items.length ? 'INVALID_EMBEDDED_LYRICS' : 'NO_EMBEDDED_LYRICS' };
  return { snapshot: choices.values().next().value!, code: 'READY_EMBEDDED' };
}
/** 只由原Owner已签发播放ticket调用。Root/locator/signature来自原事实作者，没有路径或新Source授权输入。 */
export async function readLocalPlaybackLyrics(facts: Readonly<LocalSourceFacts>, signal: AbortSignal, assertCurrent: () => void): Promise<LyricsSnapshot> {
  const started = performance.now(), observation = facts.observation, dot = facts.relative.lastIndexOf('.');
  logLibraryOperation('metadata', 'lyrics.local.read', 'start');
  if (!observation || facts.track.segment !== null || dot <= facts.relative.lastIndexOf('/')) {
    logLibraryOperation('metadata', 'lyrics.local.read', 'skipped', { code: 'UNSUPPORTED', elapsedMs: performance.now() - started });
    return unavailable();
  }
  const relative = facts.relative.slice(0, dot) + '.lrc', controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]), deadline = started + READ_MS;
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.ceil(deadline - performance.now()))); timer.unref?.();
  let resultCode = 'UNAVAILABLE', readBytes = 0;
  const leases = new Map<number, number>();
  // released只在真实close与原物理/命名保护释放均成功之后发出；不把FD号写入日志。
  const lease = (event: { type: 'lease-acquired' | 'lease-released'; fd: number }): void => {
    if (event.type === 'lease-acquired') { leases.set(event.fd, performance.now()); logLibraryOperation('metadata', 'lyrics.local.lease', 'start', { active: leases.size }); }
    else { const began = leases.get(event.fd) ?? performance.now(); leases.delete(event.fd); logLibraryOperation('metadata', 'lyrics.local.lease', 'complete', { active: leases.size, elapsedMs: performance.now() - began }); }
  };
  const check = (): void => {
    try { assertCurrent(); } catch (error) { resultCode = 'TICKET_STALE'; throw error; }
    if (signal.aborted) { resultCode = 'CANCELLED'; signal.throwIfAborted(); }
    if (controller.signal.aborted || performance.now() >= deadline) { resultCode = 'READ_DEADLINE'; throw new Error('本地歌词读取期限已到。'); }
  };
  const code = (error: unknown): string => error instanceof MetadataLeaseReleaseError ? 'QUIET_UNCONFIRMED'
    : ['TICKET_STALE','CANCELLED','READ_DEADLINE'].includes(resultCode) ? resultCode
      : error instanceof SourceFileError || error instanceof RustMediaWorkerError ? error.code : 'READ_FAILED';
  async function stage<T>(action: 'lyrics.local.audio-source' | 'lyrics.local.sidecar-stat' | 'lyrics.local.sidecar-read' | 'lyrics.local.embedded-read', work: () => Promise<T>): Promise<T> {
    const began = performance.now(); logLibraryOperation('metadata', action, 'start');
    try { const value = await work(); logLibraryOperation('metadata', action, 'complete', { elapsedMs: performance.now() - began }); return value; }
    catch (error) { logLibraryOperation('metadata', action, 'error', { code: code(error), elapsedMs: performance.now() - began }); throw error; }
  }
  try {
    check();
    const result = await stage('lyrics.local.audio-source', () => withCheckedReadonlyMetadataSource(facts.sourceRoot, facts.relative, observation.signature, combined, async (audioFile, audioSize) => {
      async function sidecar(): Promise<LyricsSnapshot | null> {
        check(); let metadata: Awaited<ReturnType<typeof readonlySourceCandidateMetadata>>;
        try { metadata = await stage('lyrics.local.sidecar-stat', () => readonlySourceCandidateMetadata(facts.sourceRoot, relative)); }
        catch (error) {
          // 只有第一次stat确认不存在才是正常缺旁置；stat成功后的替换/消失继续按原Source错误拒绝。
          if (!(error instanceof SourceFileError) || error.code !== 'MISSING') throw error;
          check(); resultCode = 'SIDECAR_MISSING'; return null;
        }
        check();
        if (metadata.size < 1 || metadata.size > MAX_BYTES) { resultCode = 'BYTE_LIMIT'; return null; }
        const bytes = await stage('lyrics.local.sidecar-read', () => withCheckedReadonlyMetadataSource(facts.sourceRoot, relative, metadata.signature, combined, async (file, size) => {
          if (size !== metadata.size || size < 1 || size > MAX_BYTES) throw new Error('本地歌词实际大小改变。');
          const buffer = Buffer.alloc(size); let position = 0;
          while (position < size) {
            check(); const read = await file.read(buffer, position, Math.min(16 * 1024, size - position), position);
            if (read.bytesRead < 1) throw new Error('本地歌词正文未完整读出。');
            position += read.bytesRead; readBytes += read.bytesRead; check();
          }
          return buffer;
        }, check, lease));
        check(); const began = performance.now(), parsed = parseLocalPlaybackLrc(bytes); resultCode = parsed.status === 'ready' ? 'READY' : 'INVALID_LRC';
        logLibraryOperation('metadata', 'lyrics.local.parse', parsed.status === 'ready' ? 'complete' : 'skipped', { code: resultCode, count: parsed.lines.length, bytes: bytes.byteLength, elapsedMs: performance.now() - began });
        return parsed.status === 'ready' ? parsed : null;
      }
      const preferred = await sidecar(); if (preferred) return preferred;
      check(); logLibraryOperation('metadata', 'lyrics.local.sidecar-fallback', 'skipped', { code: resultCode });
      // 复用仍在原首末保护内的音频只读FD；Worker不接路径，不取得任何关闭权或新Source许可。
      const embedded = await stage('lyrics.local.embedded-read', () => getRustMediaWorkerPool().readEmbeddedLyrics({
        size: audioSize, deadlineAtMs: deadline,
        async read(offset, length) {
          check();
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > 64 * 1024 || offset > audioSize - length) throw new RustMediaWorkerError('BUDGET_EXCEEDED');
          const buffer = Buffer.alloc(length), read = await audioFile.read(buffer, 0, length, offset);
          readBytes += read.bytesRead; check(); return buffer.subarray(0, read.bytesRead);
        },
      }, combined));
      check(); const began = performance.now(), selected = embeddedLyrics(embedded.items); resultCode = selected.code;
      logLibraryOperation('metadata', 'lyrics.local.embedded-parse', selected.snapshot.status === 'ready' ? 'complete' : 'skipped', {
        code: resultCode, count: selected.snapshot.lines.length, bytes: embedded.readEvidence.bytesRead,
        readMs: embedded.performance.readMs, parseMs: embedded.performance.parseMs, queueWaitMs: embedded.performance.queueWaitMs, elapsedMs: performance.now() - began,
      });
      return selected.snapshot;
    }, check, lease));
    check(); logLibraryOperation('metadata', 'lyrics.local.read', result.status === 'ready' ? 'complete' : 'skipped', { code: resultCode, count: result.lines.length, bytes: readBytes, elapsedMs: performance.now() - started });
    return result;
  } catch (error) {
    logLibraryOperation('metadata', 'lyrics.local.read', 'error', { code: leases.size ? 'QUIET_UNCONFIRMED' : code(error), active: leases.size, bytes: readBytes, elapsedMs: performance.now() - started });
    // 句柄或原保护释放未确认时不能降为无歌词；原ticket fence继续阻挡quiet和相关事实提交。
    if (error instanceof MetadataLeaseReleaseError) throw error;
    if (leases.size) throw new MetadataLeaseReleaseError();
    return unavailable();
  } finally { clearTimeout(timer); }
}
