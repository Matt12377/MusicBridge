import type {
  LyricLine,
  LyricWord,
  LyricsSnapshot,
} from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';

const MAX_SOURCE_TEXT_LENGTH = 512 * 1024;
const MAX_LYRICS_LINES = 500;
const MAX_LYRICS_WORDS = 200;
const MAX_LYRICS_TEXT_LENGTH = 2_048;
const MAX_LYRICS_TOTAL_TEXT_LENGTH = 256 * 1024;
const MAX_LYRICS_DURATION_MS = 24 * 60 * 60 * 1000;

interface MutableLine {
  startMs: number;
  endMs?: number;
  text: string;
  translation?: string;
  romanization?: string;
  words?: LyricWord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function bodyOf(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'Invalid NetEase lyrics response', {
      httpStatus: 502,
    });
  }
  return isRecord(response.body) ? response.body : response;
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(body.data) ? body.data : undefined;
}

function readField(
  body: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return data?.[key] ?? body[key];
}

function responseBodyCode(body: Record<string, unknown>): void {
  const data = dataOf(body);
  const code = numeric(body.code) ?? numeric(data?.code);
  if (code === undefined) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'Invalid NetEase lyrics response', {
      httpStatus: 502,
    });
  }
  if (code === 301 || code === 302) {
    throw new BridgeError('AUTH_EXPIRED', 'Provider session expired', {
      httpStatus: 401,
    });
  }
  if (code !== 200) {
    throw new BridgeError('NETEASE_REQUEST_FAILED', 'NetEase lyrics request failed', {
      httpStatus: 502,
      details: { code },
    });
  }
}

function boundedSource(value: unknown): string | undefined {
  const source = nonEmptyString(value);
  if (!source || source.length > MAX_SOURCE_TEXT_LENGTH) return undefined;
  return source;
}

function fractionToMs(value: string | undefined): number {
  if (!value) return 0;
  const fraction = value.slice(0, 3).padEnd(3, '0');
  return Number(fraction);
}

function lrcTimestampToMs(minutes: string, seconds: string, fraction?: string): number | undefined {
  const minuteValue = Number(minutes);
  const secondValue = Number(seconds);
  const result = minuteValue * 60_000 + secondValue * 1_000 + fractionToMs(fraction);
  if (
    !Number.isSafeInteger(result) ||
    minuteValue < 0 ||
    secondValue < 0 ||
    secondValue >= 60 ||
    result < 0 ||
    result > MAX_LYRICS_DURATION_MS
  ) {
    return undefined;
  }
  return result;
}

function parseLrc(source: string): MutableLine[] {
  const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const lines: MutableLine[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    timestampPattern.lastIndex = 0;
    const matches = [...rawLine.matchAll(timestampPattern)];
    if (matches.length === 0) continue;
    const text = rawLine.replace(timestampPattern, '').trim();
    if (!text || text.length > MAX_LYRICS_TEXT_LENGTH) continue;
    for (const match of matches) {
      const startMs = lrcTimestampToMs(match[1] ?? '', match[2] ?? '', match[3]);
      if (startMs === undefined) continue;
      lines.push({ startMs, text });
    }
  }
  return lines;
}

function parseYrc(source: string): MutableLine[] {
  const lines: MutableLine[] = [];
  const wordPattern = /\((\d+),(\d+)(?:,\d+)?\)([\s\S]*?)(?=\(\d+,\d+(?:,\d+)?\)|$)/g;
  for (const rawLine of source.split(/\r?\n/)) {
    const header = rawLine.match(/^\[(\d+),(\d+)\]/);
    if (!header) continue;
    const lineStart = Number(header[1]);
    const lineDuration = Number(header[2]);
    const lineEnd = lineStart + lineDuration;
    if (
      !Number.isSafeInteger(lineStart) ||
      !Number.isSafeInteger(lineDuration) ||
      lineStart < 0 ||
      lineDuration <= 0 ||
      lineEnd > MAX_LYRICS_DURATION_MS
    ) {
      continue;
    }

    const remainder = rawLine.slice(header[0].length);
    wordPattern.lastIndex = 0;
    const words: LyricWord[] = [];
    for (const match of remainder.matchAll(wordPattern)) {
      const startMs = Number(match[1]);
      const duration = Number(match[2]);
      const wordText = (match[3] ?? '').trim();
      const endMs = Math.min(lineEnd, startMs + duration);
      if (
        !wordText ||
        wordText.length > MAX_LYRICS_TEXT_LENGTH ||
        !Number.isSafeInteger(startMs) ||
        !Number.isSafeInteger(duration) ||
        startMs < lineStart ||
        endMs <= startMs
      ) {
        continue;
      }
      words.push({ startMs, endMs, text: wordText });
      if (words.length >= MAX_LYRICS_WORDS) break;
    }
    const text = words.map((word) => word.text).join('').trim();
    if (!text || text.length > MAX_LYRICS_TEXT_LENGTH) continue;
    lines.push({ startMs: lineStart, endMs: lineEnd, text, words });
  }
  return lines;
}

function dedupeLines(lines: readonly MutableLine[]): MutableLine[] {
  const deduped = new Map<string, MutableLine>();
  for (const line of lines) {
    const key = `${line.startMs}\u0000${line.text}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, {
        ...line,
        ...(line.words ? { words: [...line.words] } : {}),
      });
      continue;
    }
    if (line.endMs !== undefined && existing.endMs === undefined) existing.endMs = line.endMs;
    if (line.translation && !existing.translation) existing.translation = line.translation;
    if (line.romanization && !existing.romanization) existing.romanization = line.romanization;
    if (line.words && !existing.words) existing.words = [...line.words];
  }
  return [...deduped.values()].sort((left, right) => left.startMs - right.startMs);
}

function mergeSideChannel(
  lines: MutableLine[],
  sideLines: readonly MutableLine[],
  field: 'translation' | 'romanization',
): void {
  const byStart = new Map<number, MutableLine>();
  for (const line of sideLines) {
    if (!byStart.has(line.startMs)) byStart.set(line.startMs, line);
  }
  for (const line of lines) {
    const side = byStart.get(line.startMs);
    const text = side?.text;
    if (text) line[field] = text;
  }
}

function inferLineEnds(lines: MutableLine[]): void {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (!line || line.endMs !== undefined || !next || next.startMs <= line.startMs) continue;
    line.endMs = next.startMs;
  }
}

function toPublicLine(line: MutableLine): LyricLine {
  return {
    startMs: line.startMs,
    ...(line.endMs !== undefined ? { endMs: line.endMs } : {}),
    text: line.text,
    ...(line.translation ? { translation: line.translation } : {}),
    ...(line.romanization ? { romanization: line.romanization } : {}),
    ...(line.words && line.words.length > 0 ? { words: line.words.map((word) => ({ ...word })) } : {}),
  };
}

export function emptyLyricsSnapshot(
  status: LyricsSnapshot['status'] = 'idle',
  timingSource: LyricsSnapshot['timingSource'] = 'static',
): LyricsSnapshot {
  return {
    status,
    lines: [],
    activeLineIndex: -1,
    timingSource,
  };
}

export function parseLyricsResponse(response: unknown): LyricsSnapshot {
  const body = bodyOf(response);
  responseBodyCode(body);
  const data = dataOf(body);
  const lrcRecord = isRecord(readField(body, data, 'lrc'))
    ? (readField(body, data, 'lrc') as Record<string, unknown>)
    : undefined;
  const yrcRecord = isRecord(readField(body, data, 'yrc'))
    ? (readField(body, data, 'yrc') as Record<string, unknown>)
    : undefined;
  const translationRecord = isRecord(readField(body, data, 'tlyric'))
    ? (readField(body, data, 'tlyric') as Record<string, unknown>)
    : undefined;
  const romanizationRecord = isRecord(readField(body, data, 'romalrc'))
    ? (readField(body, data, 'romalrc') as Record<string, unknown>)
    : undefined;

  const sources = [
    boundedSource(yrcRecord?.lyric),
    boundedSource(lrcRecord?.lyric),
    boundedSource(translationRecord?.lyric),
    boundedSource(romanizationRecord?.lyric),
  ];
  if (
    [yrcRecord?.lyric, lrcRecord?.lyric, translationRecord?.lyric, romanizationRecord?.lyric]
      .some((value) => typeof value === 'string' && value.length > MAX_SOURCE_TEXT_LENGTH)
  ) {
    return emptyLyricsSnapshot('unavailable');
  }

  const yrcLines = sources[0] ? parseYrc(sources[0]) : [];
  const lrcLines = sources[1] ? parseLrc(sources[1]) : [];
  const lines = dedupeLines(yrcLines.length > 0 ? yrcLines : lrcLines);
  if (sources[2]) mergeSideChannel(lines, dedupeLines(parseLrc(sources[2])), 'translation');
  if (sources[3]) mergeSideChannel(lines, dedupeLines(parseLrc(sources[3])), 'romanization');
  inferLineEnds(lines);

  const boundedLines = lines.slice(0, MAX_LYRICS_LINES);
  const totalTextLength = boundedLines.reduce((total, line) => {
    const words = line.words?.reduce((wordTotal, word) => wordTotal + word.text.length, 0) ?? 0;
    return total + line.text.length + (line.translation?.length ?? 0) +
      (line.romanization?.length ?? 0) + words;
  }, 0);
  if (totalTextLength > MAX_LYRICS_TOTAL_TEXT_LENGTH) {
    return emptyLyricsSnapshot('unavailable');
  }
  if (boundedLines.length > 0) {
    return {
      status: 'ready',
      lines: boundedLines.map(toPublicLine),
      activeLineIndex: -1,
      timingSource: 'static',
    };
  }

  const instrumental = [
    body.pureMusic,
    body.instrumental,
    body.nolyric,
    data?.pureMusic,
    data?.instrumental,
    data?.nolyric,
  ].some((value) => value === true || value === 1 || value === '1');
  return emptyLyricsSnapshot(instrumental ? 'instrumental' : 'unavailable');
}
