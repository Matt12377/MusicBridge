import { isLibraryReadCommand, type IpcCommand, type LibraryReadCommand } from '@music-bridge/contracts';

export const LIBRARY_READ_TRACE_PREFIX = '[library:read] ';
const STAGES = new Set([
  'renderer.dispatch', 'renderer.return', 'renderer.cancel',
  'main.receive', 'main.dispatch', 'main.response', 'main.finish', 'main.cancel',
  'core.receive', 'core.flight.start', 'core.flight.join', 'core.scope', 'core.finish', 'core.flight.close', 'core.return', 'core.map',
  'sdk.dispatch', 'sdk.callback', 'sdk.finish',
]);
const REASONS = new Set([
  'renderer-cancel', 'renderer-deadline', 'owner-destroyed', 'owner-navigation', 'main-cancel', 'main-signal',
  'main-deadline', 'scope-changed', 'zone-changed', 'credential-changed', 'shutdown',
  'subscriber-deadline', 'sdk-deadline', 'sdk-error', 'upstream-response', 'last-subscriber-release', 'unknown',
]);
const CODES = new Set(['CANCELLED', 'TIMEOUT', 'READ_CANCELLED', 'READ_DEADLINE', 'ROON_LIBRARY_REQUEST_FAILED', 'ROON_LIBRARY_INVALID_PAGE', 'BAD_REQUEST', 'INVALID_IPC_REQUEST', 'NOT_READY', 'INTERNAL_ERROR', 'OTHER']);
const ID_FIELDS = ['rendererReadId', 'coreReadId', 'flightId', 'sdkId'] as const;
const COUNTS = ['subscriberCount', 'offset', 'limit', 'count', 'itemCount', 'itemKeyCount', 'rawCount', 'mappedCount', 'filteredCount', 'total', 'scopeEpoch'] as const;
const BOOLEANS = ['late', 'hasMore', 'scopeChanged', 'shutdownChanged', 'credentialChanged', 'serviceChanged', 'readScopeChanged', 'zoneChanged', 'unknownScopeChanged'] as const;
const HINTS = ['generic', 'list', 'actionList', 'action', 'header', 'unknown', 'missing', 'null'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE = /^opaque-[1-9][0-9]{0,12}$/;
export type LibraryReadTraceReason =
  | 'renderer-cancel' | 'renderer-deadline' | 'owner-destroyed' | 'owner-navigation' | 'main-cancel' | 'main-signal'
  | 'main-deadline' | 'scope-changed' | 'zone-changed' | 'credential-changed' | 'shutdown'
  | 'subscriber-deadline' | 'sdk-deadline' | 'sdk-error' | 'upstream-response' | 'last-subscriber-release' | 'unknown';
export interface LibraryReadTraceEvent extends Record<string, unknown> {
  stage: string;
  command?: LibraryReadCommand;
  rendererReadId?: string;
  coreReadId?: string;
  flightId?: string;
  sdkId?: string;
  outcome?: 'ok' | 'cancelled' | 'timeout' | 'error';
  code?: string;
  reason?: LibraryReadTraceReason;
}
export type LibraryReadTraceSink = (event: LibraryReadTraceEvent) => void;

/** 开发版默认开启；显式 0/1 优先，未知环境值不能开启生产诊断。 */
export function isLibraryReadTraceEnabled(env: { MUSIC_BRIDGE_LIBRARY_READ_TRACE?: string }, development = false): boolean {
  return env.MUSIC_BRIDGE_LIBRARY_READ_TRACE === '1' || (env.MUSIC_BRIDGE_LIBRARY_READ_TRACE !== '0' && development);
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= Number.MAX_SAFE_INTEGER; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** 只复制固定枚举、计数和随机身份；不展开 payload、scope、SDK 对象或 Error。 */
export function copyLibraryReadTraceEvent(input: unknown, alias?: (value: string) => string): LibraryReadTraceEvent | undefined {
  try {
    if (!record(input) || typeof input.stage !== 'string' || !STAGES.has(input.stage)) return undefined;
    const result: LibraryReadTraceEvent = { stage: input.stage };
    if (isLibraryReadCommand(input.command)) result.command = input.command;
    for (const field of ID_FIELDS) {
      const value = input[field];
      if (typeof value !== 'string' || !value.length || value.length > 128) continue;
      if (UUID.test(value)) result[field] = value;
      else if (alias) result[field] = alias(value);
      else if (OPAQUE.test(value)) result[field] = value;
    }
    if (typeof input.outcome === 'string' && ['ok', 'cancelled', 'timeout', 'error'].includes(input.outcome)) result.outcome = input.outcome as NonNullable<LibraryReadTraceEvent['outcome']>;
    if (typeof input.code === 'string') result.code = CODES.has(input.code) ? input.code : 'OTHER';
    if (typeof input.reason === 'string' && REASONS.has(input.reason)) result.reason = input.reason as LibraryReadTraceReason;
    if (input.operation === 'browse' || input.operation === 'load') result.operation = input.operation;
    if (typeof input.hierarchy === 'string' && ['albums', 'artists', 'genres', 'playlists', 'search', 'unknown'].includes(input.hierarchy)) result.hierarchy = input.hierarchy;
    for (const field of COUNTS) if (count(input[field])) result[field] = input[field];
    for (const field of BOOLEANS) if (typeof input[field] === 'boolean') result[field] = input[field];
    if (record(input.hintCounts)) {
      const hints: Record<string, number> = {};
      for (const field of HINTS) if (count(input.hintCounts[field])) hints[field] = input.hintCounts[field] as number;
      result.hintCounts = hints;
    }
    return result;
  } catch { return undefined; }
}

export function createLibraryReadTraceWriter(options: { enabled: boolean; write(line: string): void }): LibraryReadTraceSink {
  const aliases = new Map<string, string>(); let nextAlias = 0;
  const alias = (value: string): string => {
    const previous = aliases.get(value); if (previous) return previous;
    const opaque = `opaque-${++nextAlias}`;
    if (aliases.size >= 2048) aliases.delete(aliases.keys().next().value!);
    aliases.set(value, opaque); return opaque;
  };
  return event => {
    if (!options.enabled) return;
    try { const safe = copyLibraryReadTraceEvent(event, alias); if (safe) options.write(`${LIBRARY_READ_TRACE_PREFIX}${JSON.stringify(safe)}\n`); }
    catch { /* 诊断输出失败不能改变读取行为。 */ }
  };
}

export function emitLibraryReadTrace(sink: LibraryReadTraceSink | undefined, event: LibraryReadTraceEvent): void {
  try { sink?.(event); } catch { /* 诊断回调不得改变读取终态。 */ }
}

export function libraryReadTraceFailure(error: unknown): { outcome: NonNullable<LibraryReadTraceEvent['outcome']>; code: string; reason?: LibraryReadTraceReason } {
  let code: string | undefined, reason: LibraryReadTraceReason | undefined;
  try {
    if (record(error)) {
      if (typeof error.code === 'string') code = CODES.has(error.code) ? error.code : 'OTHER';
      if (typeof error.libraryReadSource === 'string' && REASONS.has(error.libraryReadSource)) reason = error.libraryReadSource as LibraryReadTraceReason;
      // Electron 的错误包装只提取固定公开错误码；原消息绝不进入日志。
      if (!code && typeof error.message === 'string') code = error.message.match(/\[(CANCELLED|TIMEOUT|NOT_READY|INVALID_IPC_REQUEST|INTERNAL_ERROR)\]/)?.[1];
    }
  } catch { /* 不读取不可信对象的更多内容。 */ }
  return { outcome: ['CANCELLED', 'READ_CANCELLED'].includes(code ?? '') ? 'cancelled' : ['TIMEOUT', 'READ_DEADLINE'].includes(code ?? '') ? 'timeout' : 'error', code: code ?? 'OTHER', ...(reason ? { reason } : {}) };
}

/** 比较内部 scope，只返回变化布尔量；原账户、Zone、服务 scope 从不序列化。 */
export function libraryReadScopeChanges(command: IpcCommand, before: string, after: string): Record<string, boolean> {
  const changes: Record<string, boolean> = { scopeChanged: before !== after };
  if (before === after) return changes;
  try {
    const left: unknown = JSON.parse(before), right: unknown = JSON.parse(after);
    if (!Array.isArray(left) || !Array.isArray(right)) return { ...changes, unknownScopeChanged: true };
    const combined = command === 'library.match' || command === 'library.aggregateSearch';
    const fields = ['shutdownChanged', ...(combined || command.startsWith('library.') ? ['credentialChanged'] : []), ...(combined || !command.startsWith('library.') ? ['serviceChanged', 'readScopeChanged', 'zoneChanged'] : [])];
    for (let i = 0; i < fields.length; i++) changes[fields[i]!] = left[i] !== right[i];
    return changes;
  } catch { return { ...changes, unknownScopeChanged: true }; }
}

/** utility stdout 只转发重新校验后的诊断行；其他输出和 stderr 不进入父终端。 */
export function createLibraryReadTraceStreamReader(sink: LibraryReadTraceSink): (chunk: string) => void {
  let pending = '', dropping = false;
  return chunk => {
    for (const part of chunk.split(/(?<=\n)/u)) {
      const ended = part.endsWith('\n');
      if (pending.length + part.length > 8192) { pending = ''; dropping = true; }
      if (!dropping) pending += part;
      if (!ended) continue;
      if (!dropping && pending.startsWith(LIBRARY_READ_TRACE_PREFIX)) {
        try {
          const event = copyLibraryReadTraceEvent(JSON.parse(pending.slice(LIBRARY_READ_TRACE_PREFIX.length)));
          if (event && (event.stage.startsWith('core.') || event.stage.startsWith('sdk.'))) emitLibraryReadTrace(sink, event);
        } catch { /* 忽略非结构化输出和不完整诊断行。 */ }
      }
      pending = ''; dropping = false;
    }
  };
}

export interface LibraryReadTerminalMetadata {
  __musicBridgeLibraryReadTrace: 1;
  stage: 'renderer.dispatch' | 'renderer.return' | 'renderer.cancel';
  outcome?: LibraryReadTraceEvent['outcome'];
  code?: string;
  reason?: 'renderer-cancel' | 'renderer-deadline';
}
/** 私有尾参数只允许这三个由 preload 构造的阶段，不提供任意日志入口。 */
export function readLibraryReadTerminalMetadata(value: unknown): LibraryReadTerminalMetadata | undefined {
  try {
    if (!record(value) || value.__musicBridgeLibraryReadTrace !== 1 || Object.keys(value).some(key => !['__musicBridgeLibraryReadTrace', 'stage', 'outcome', 'code', 'reason'].includes(key))) return undefined;
    if (typeof value.stage !== 'string' || !['renderer.dispatch', 'renderer.return', 'renderer.cancel'].includes(value.stage)) return undefined;
    if (value.outcome !== undefined && (typeof value.outcome !== 'string' || !['ok', 'cancelled', 'timeout', 'error'].includes(value.outcome))) return undefined;
    if (value.code !== undefined && (typeof value.code !== 'string' || !CODES.has(value.code))) return undefined;
    if (value.reason !== undefined && value.reason !== 'renderer-cancel' && value.reason !== 'renderer-deadline') return undefined;
    if (value.stage === 'renderer.dispatch' && Object.keys(value).length !== 2) return undefined;
    return { __musicBridgeLibraryReadTrace: 1, stage: value.stage as LibraryReadTerminalMetadata['stage'], ...(value.outcome === undefined ? {} : { outcome: value.outcome as NonNullable<LibraryReadTraceEvent['outcome']> }), ...(value.code === undefined ? {} : { code: value.code as string }), ...(value.reason === undefined ? {} : { reason: value.reason as NonNullable<LibraryReadTerminalMetadata['reason']> }) };
  } catch { return undefined; }
}
