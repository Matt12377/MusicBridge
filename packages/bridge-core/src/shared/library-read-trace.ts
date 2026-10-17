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

/** 仅供Root整合的私有闭集；不加入Public39、不携带原错误文本或业务正文。 */
export const LOCAL_ALBUM_TRACE_PREFIX = '[local-album:read:v1] '
export const LOCAL_ALBUM_ERROR_MARKER = '本地专辑读取暂未确认，请重新读取。[LOCAL_ALBUM_READ_TRACE_V1]'
export const LOCAL_ALBUM_TRACE_STAGES = [
  'preload.input', 'preload.scope', 'preload.invoke', 'preload.dto',
  'main.receive', 'main.trusted', 'main.author', 'main.envelope', 'main.dataset', 'main.dispatch', 'main.response', 'main.dto',
  'supervisor.route', 'supervisor.send', 'supervisor.timeout', 'supervisor.response', 'supervisor.dto',
  'utility.receive', 'utility.ready', 'utility.prepare', 'utility.dataset', 'utility.read', 'utility.dto', 'utility.return',
  'client.guard', 'client.send', 'client.envelope', 'client.identity', 'client.dto', 'client.reject',
  'worker.receive', 'worker.guard', 'worker.read', 'worker.reply', 'worker.reject',
  'worker.await', 'worker.post',
  'owner.input', 'owner.refresh', 'owner.scope', 'owner.sql', 'owner.seal', 'owner.dto', 'owner.artwork', 'owner.map',
  'owner.sql.albums', 'owner.sql.tracks', 'owner.sql.artwork', 'sql.run.enter', 'sql.derived', 'owner.return',
  'localAlbum.artwork.permit-granted',
  'localAlbum.artwork.permit-deferred',
  'localAlbum.artwork.no-permit-unavailable',
  'context.supervisor.route',
  'context.supervisor.ready',
  'context.supervisor.budget',
  'context.supervisor.cancel',
  'context.supervisor.send',
  'context.supervisor.response',
  'context.supervisor.dto',
  'context.supervisor.receive.route',
  'context.supervisor.receive.failure',
  'context.utility.receive',
  'context.utility.ready',
  'context.utility.endpoint',
  'context.utility.prepare',
  'context.utility.owner',
  'context.utility.budget',
  'context.client.send',
  'context.client.response',
  'context.client.dto',
  'context.client.ready',
  'context.client.route',
  'context.client.budget',
  'context.client.cancel',
  'context.worker.receive',
  'context.worker.ready',
  'context.worker.owner',
  'context.worker.dto',
  'context.worker.reply',
  'renderer.reject',
] as const
export type LocalAlbumTraceStage = typeof LOCAL_ALBUM_TRACE_STAGES[number]
export const LOCAL_ALBUM_TRACE_CODES = [
  'INVALID_REQUEST', 'INVALID_IPC_REQUEST', 'INVALID_IPC_RESPONSE', 'NOT_READY', 'TIMEOUT', 'UNAVAILABLE',
  'SNAPSHOT_CHANGED', 'OUTBOX_SCOPE_MISMATCH', 'CONTENT_LIMIT_EXCEEDED', 'INVENTORY_CONFLICT', 'INVENTORY_UNAVAILABLE',
  'CHANGED', 'CLOSED', 'INTERNAL_ERROR', 'UNKNOWN',
] as const
export type LocalAlbumTraceCode = typeof LOCAL_ALBUM_TRACE_CODES[number]
export const LOCAL_ALBUM_TRACE_NAMES = [
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'LocalAlbumReadError', 'CoreIpcError', 'PublicIpcError',
  'DatasetOwnerTransportError', 'DatasetOwnerDispatchError', 'LocalCatalogStoreError', 'LocalFactsCommitFatal', 'UNKNOWN',
] as const
export type LocalAlbumTraceName = typeof LOCAL_ALBUM_TRACE_NAMES[number]
export const LOCAL_ALBUM_TRACE_MATCHES = ['trusted', 'dataset', 'epoch', 'root', 'revision', 'dto', 'generation', 'route'] as const
export type LocalAlbumTraceMatch = typeof LOCAL_ALBUM_TRACE_MATCHES[number]
export type LocalAlbumTraceMatches = Record<LocalAlbumTraceMatch, boolean | null>
export interface LocalAlbumSafeTrace {
  version: 1
  traceSha256: string
  parentSha256: string | null
  stage: LocalAlbumTraceStage
  firstStage: LocalAlbumTraceStage | null
  code: LocalAlbumTraceCode
  name: LocalAlbumTraceName
  mappedCode: LocalAlbumTraceCode | null
  elapsedMs: number
  outcome: 'begin' | 'ok' | 'reject'
  matches: LocalAlbumTraceMatches
  preloadAssociated: boolean
}
export interface LocalAlbumPrivateFailure {
  version: 1
  type: 'local-album-private-failure'
  correlationId: string
  trace: LocalAlbumSafeTrace
}
const localAlbumSafeFields = ['version', 'traceSha256', 'parentSha256', 'stage', 'firstStage', 'code', 'name', 'mappedCode', 'elapsedMs', 'outcome', 'matches', 'preloadAssociated'] as const
const localAlbumSafeUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const localAlbumSafeShaPattern = /^[0-9a-f]{64}$/u
const localAlbumSafeData = (value: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function localAlbumSafeClosed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
export const localAlbumTraceUUID = (value: unknown): value is string => typeof value === 'string' && localAlbumSafeUuidPattern.test(value)
/** 仅诊断关联：合法36 ASCII UUID固定单块SHA-256；不使用异步WebCrypto、Node或外部回调。 */
export function localAlbumTraceIdSha256(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== 36 || !localAlbumTraceUUID(value)) return null
  try {
    const rounds = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]
    const initial = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
    const words = new Uint32Array(64), rotate = (word: number, shift: number): number => word >>> shift | word << 32 - shift
    for (let index = 0; index < 36; index++) words[index >>> 2] = words[index >>> 2]! | value.charCodeAt(index) << (24 - (index & 3) * 8)
    words[9] = 0x80000000; words[15] = 36 * 8
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15]!, right = words[index - 2]!
      const sigma0 = rotate(left,7) ^ rotate(left,18) ^ left >>> 3, sigma1 = rotate(right,17) ^ rotate(right,19) ^ right >>> 10
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0
    }
    let a = initial[0]!, b = initial[1]!, c = initial[2]!, d = initial[3]!, e = initial[4]!, f = initial[5]!, g = initial[6]!, h = initial[7]!
    for (let index = 0; index < 64; index++) {
      const sum1 = rotate(e,6) ^ rotate(e,11) ^ rotate(e,25), choose = e & f ^ ~e & g
      const first = (h + sum1 + choose + rounds[index]! + words[index]!) >>> 0
      const sum0 = rotate(a,2) ^ rotate(a,13) ^ rotate(a,22), majority = a & b ^ a & c ^ b & c, second = (sum0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0
    }
    return [a,b,c,d,e,f,g,h].map((word,index) => ((initial[index]! + word) >>> 0).toString(16).padStart(8,'0')).join('')
  } catch { return null }
}
export function emptyLocalAlbumTraceMatches(): LocalAlbumTraceMatches {
  return { trusted: null, dataset: null, epoch: null, root: null, revision: null, dto: null, generation: null, route: null }
}
/** 调用方只传已经算出的布尔结果，诊断不再调用原validator。 */
export function copyLocalAlbumSafeTrace(value: unknown): LocalAlbumSafeTrace | null {
  try {
    if (!localAlbumSafeClosed(value, localAlbumSafeFields)) return null
    const v = Object.fromEntries(localAlbumSafeFields.map(key => [key, localAlbumSafeData(value, key)]))
    if (v.version !== 1 || typeof v.traceSha256 !== 'string' || !localAlbumSafeShaPattern.test(v.traceSha256)
      || v.parentSha256 !== null && (typeof v.parentSha256 !== 'string' || !localAlbumSafeShaPattern.test(v.parentSha256))
      || !LOCAL_ALBUM_TRACE_STAGES.includes(v.stage as LocalAlbumTraceStage)
      || v.firstStage !== null && !LOCAL_ALBUM_TRACE_STAGES.includes(v.firstStage as LocalAlbumTraceStage)
      || !LOCAL_ALBUM_TRACE_CODES.includes(v.code as LocalAlbumTraceCode)
      || !LOCAL_ALBUM_TRACE_NAMES.includes(v.name as LocalAlbumTraceName)
      || v.mappedCode !== null && !LOCAL_ALBUM_TRACE_CODES.includes(v.mappedCode as LocalAlbumTraceCode)
      || typeof v.elapsedMs !== 'number' || !Number.isFinite(v.elapsedMs) || v.elapsedMs < 0
      || !['begin', 'ok', 'reject'].includes(v.outcome as string) || typeof v.preloadAssociated !== 'boolean'
      || !localAlbumSafeClosed(v.matches, LOCAL_ALBUM_TRACE_MATCHES)) return null
    const matches = emptyLocalAlbumTraceMatches()
    for (const key of LOCAL_ALBUM_TRACE_MATCHES) {
      const match = localAlbumSafeData(v.matches, key)
      if (match !== null && typeof match !== 'boolean') return null
      matches[key] = match
    }
    return { version: 1, traceSha256: v.traceSha256, parentSha256: v.parentSha256 as string | null,
      stage: v.stage as LocalAlbumTraceStage, firstStage: v.firstStage as LocalAlbumTraceStage | null,
      code: v.code as LocalAlbumTraceCode, name: v.name as LocalAlbumTraceName, mappedCode: v.mappedCode as LocalAlbumTraceCode | null,
      elapsedMs: v.elapsedMs, outcome: v.outcome as LocalAlbumSafeTrace['outcome'], matches, preloadAssociated: v.preloadAssociated }
  } catch { return null }
}
/** Electron已经完成IPC structured-clone；Node入口仍须先拒绝Proxy，诊断不能授权。 */
export function readLocalAlbumPrivateFailure(value: unknown, expectedCorrelationId: string, expectedSha256: string): LocalAlbumPrivateFailure | null {
  try {
    if (!localAlbumTraceUUID(expectedCorrelationId) || !localAlbumSafeShaPattern.test(expectedSha256)
      || !localAlbumSafeClosed(value, ['version', 'type', 'correlationId', 'trace']) || localAlbumSafeData(value, 'version') !== 1
      || localAlbumSafeData(value, 'type') !== 'local-album-private-failure' || localAlbumSafeData(value, 'correlationId') !== expectedCorrelationId) return null
    const trace = copyLocalAlbumSafeTrace(localAlbumSafeData(value, 'trace'))
    if (!trace || trace.traceSha256 !== expectedSha256 || trace.outcome !== 'reject') return null
    return { version: 1, type: 'local-album-private-failure', correlationId: expectedCorrelationId, trace }
  } catch { return null }
}
export function localAlbumSafeMarker(trace: LocalAlbumSafeTrace): string | null {
  const safe = copyLocalAlbumSafeTrace(trace)
  if (!safe || safe.outcome !== 'reject') return null
  const text = LOCAL_ALBUM_ERROR_MARKER + JSON.stringify(safe)
  return text.length <= 2048 ? text : null
}
/** 只接受Preload自己构造的整个安全marker；不搜索原message、不提取stack或invoke前缀。 */
export function readLocalAlbumSafeMarker(message: unknown): LocalAlbumSafeTrace | null {
  if (typeof message !== 'string' || message.length > 2048 || !message.startsWith(LOCAL_ALBUM_ERROR_MARKER)) return null
  try { const safe = copyLocalAlbumSafeTrace(JSON.parse(message.slice(LOCAL_ALBUM_ERROR_MARKER.length))); return safe?.outcome === 'reject' ? safe : null } catch { return null }
}
/** 单个owned child的stdout消费器；超8KiB整行丢弃，不能转发任意stdout/stderr。 */
export function createLocalAlbumSafeTraceReader(sink: (safe: LocalAlbumSafeTrace) => void): (chunk: string) => void {
  let pending = '', dropping = false
  return chunk => {
    for (const part of chunk.split(/(?<=\n)/u)) {
      const ended = part.endsWith('\n')
      if (pending.length + part.length > 8192) { pending = ''; dropping = true }
      if (!dropping) pending += part
      if (ended) {
        if (!dropping && pending.startsWith(LOCAL_ALBUM_TRACE_PREFIX)) {
          try { const safe = copyLocalAlbumSafeTrace(JSON.parse(pending.slice(LOCAL_ALBUM_TRACE_PREFIX.length))); if (safe) sink(safe) } catch { /* 旁路失败不反向抛出。 */ }
        }
        pending = ''; dropping = false
      }
    }
  }
}

export function localAlbumSafeTraceCode(value: unknown): LocalAlbumTraceCode { return LOCAL_ALBUM_TRACE_CODES.includes(value as LocalAlbumTraceCode) ? value as LocalAlbumTraceCode : 'UNKNOWN' }
export function readLocalAlbumSafeTraceLine(line: unknown): LocalAlbumSafeTrace | null {
  if (typeof line !== 'string' || line.length > 2048 || !line.startsWith(LOCAL_ALBUM_TRACE_PREFIX)) return null
  try { return copyLocalAlbumSafeTrace(JSON.parse(line.slice(LOCAL_ALBUM_TRACE_PREFIX.length))) } catch { return null }
}

export interface LocalAlbumReadTraceSnapshot { schema: 'v39.local-album-safe-trace.v1'; records: LocalAlbumSafeTrace[]; firstRejects: LocalAlbumSafeTrace[]; droppedRecords: number }
export function copyLocalAlbumReadTraceSnapshot(value: unknown): LocalAlbumReadTraceSnapshot | null {
  try {
    if (!localAlbumSafeClosed(value, ['schema', 'records', 'firstRejects', 'droppedRecords'])) return null
    const schema = localAlbumSafeData(value, 'schema'), records = localAlbumSafeData(value, 'records'), rejected = localAlbumSafeData(value, 'firstRejects'), dropped = localAlbumSafeData(value, 'droppedRecords')
    if (schema !== 'v39.local-album-safe-trace.v1' || !Array.isArray(records) || records.length > 256 || !Array.isArray(rejected) || rejected.length > 64
      || !Number.isSafeInteger(dropped) || Number(dropped) < 0) return null
    const copies: LocalAlbumSafeTrace[] = [], firstRejects: LocalAlbumSafeTrace[] = [], seen = new Set<string>()
    for (const item of records) { const copy = copyLocalAlbumSafeTrace(item); if (!copy) return null; copies.push(copy) }
    for (const item of rejected) { const copy = copyLocalAlbumSafeTrace(item); if (!copy || copy.outcome !== 'reject' || copy.firstStage === null || seen.has(copy.traceSha256)) return null; seen.add(copy.traceSha256); firstRejects.push(copy) }
    return { schema, records: copies, firstRejects, droppedRecords: Number(dropped) }
  } catch { return null }
}
