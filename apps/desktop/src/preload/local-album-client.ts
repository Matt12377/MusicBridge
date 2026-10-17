import * as dto from '@music-bridge/contracts';
import type { DatasetScope } from './command-outbox-client.js';
import { LOCAL_ALBUM_TRACE_PREFIX, localAlbumSafeMarker, readLocalAlbumPrivateFailure, copyLocalAlbumSafeTrace, emptyLocalAlbumTraceMatches, localAlbumTraceIdSha256, type LocalAlbumSafeTrace, type LocalAlbumTraceStage } from '../shared/library-read-trace.js';

interface PreloadReadTrace { id: string | null; startedAtMs: number; stage: LocalAlbumTraceStage; matches: LocalAlbumSafeTrace['matches']; first: LocalAlbumSafeTrace | null; sha256: string | null }
type PreparedRead = <C extends dto.LocalAlbumCommand>(command: C, payload: dto.LocalAlbumCommandPayloads[C], trace: PreloadReadTrace) => Promise<dto.LocalAlbumCommandResults[C]>;
// 仅将现createClient与Prepared factory接在同一个调用；不保存结果或授权，不跨contextBridge暴露。
const preparedReaders = new WeakMap<dto.LocalAlbumLibraryPublicApi, PreparedRead>();
const ownedMarkerErrors = new WeakMap<object, LocalAlbumSafeTrace>();
function beginTrace(): PreloadReadTrace {
  // 诊断失效只撤回关联；原读取、原guard和单次invoke照常执行。
  const trace: PreloadReadTrace = { id: null, startedAtMs: 0, stage: 'preload.input', matches: emptyLocalAlbumTraceMatches(), first: null, sha256: null };
  try {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID !== 'function') return trace;
    const id = crypto.randomUUID(), sha256 = localAlbumTraceIdSha256(id), startedAtMs = performance.now();
    if (sha256 === null || !Number.isFinite(startedAtMs) || startedAtMs < 0) return trace;
    trace.id = id; trace.sha256 = sha256; trace.startedAtMs = startedAtMs;
  } catch { /* CSPRNG或诊断摘要失败不替代原业务异常。 */ }
  return trace;
}
function emitPreloadTrace(safe: LocalAlbumSafeTrace): void { try { console.info(LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(safe)); } catch { /* 只输出闭合安全正文。 */ } }
function traceElapsed(trace: PreloadReadTrace): number {
  try { const elapsed = performance.now() - trace.startedAtMs; return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0; } catch { return 0; }
}
function rejectTraced(error: unknown, trace: PreloadReadTrace): never {
  try {
    const owned = error && typeof error === 'object' ? ownedMarkerErrors.get(error) : undefined;
    if (!owned && trace.id !== null && trace.sha256 !== null) {
      // 浏览器不能无副作用辨识Proxy；不触碰原error的任何属性，缺首码/名如实UNKNOWN。
      const safe = copyLocalAlbumSafeTrace({ version: 1, traceSha256: trace.sha256, parentSha256: null,
        stage: trace.stage, firstStage: trace.stage, code: 'UNKNOWN', name: 'UNKNOWN', mappedCode: null,
        elapsedMs: traceElapsed(trace), outcome: 'reject', matches: { ...trace.matches }, preloadAssociated: false });
      if (safe) emitPreloadTrace(safe);
    }
  } catch { /* 旁路记录失败仍重抛同一原异常；不读取message/stack/constructor或accessor。 */ }
  throw error;
}
function rejectPrivateFailure(failure: LocalAlbumSafeTrace, trace: PreloadReadTrace): never {
  // 仅在原correlationId与本次实际SHA均严格匹配后才构造安全marker。
  trace.first = failure; trace.matches = { ...failure.matches };
  const safe = copyLocalAlbumSafeTrace({ ...failure, stage: trace.stage, elapsedMs: traceElapsed(trace) });
  const marker = safe ? localAlbumSafeMarker(safe) : null;
  const error = new Error(marker ?? '本地专辑读取暂未确认，请重新读取。');
  if (safe) { ownedMarkerErrors.set(error, safe); emitPreloadTrace(safe); }
  throw error;
}
async function tracedCall<T>(trace: PreloadReadTrace, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { return rejectTraced(error, trace); }
}
/** 在最外层原payload guard前生成一次ID；未改三个公开方法的DTO成功值/reject。 */
export async function withLocalAlbumPreparedTrace<T>(api: dto.LocalAlbumLibraryPublicApi, action: (reader: dto.LocalAlbumLibraryPublicApi, trace: PreloadReadTrace) => Promise<T>): Promise<T> {
  const trace = beginTrace(), request = preparedReaders.get(api);
  const reader: dto.LocalAlbumLibraryPublicApi = request ? {
    queryLocalAlbums: payload => request('localAlbum.query', payload, trace),
    getLocalAlbumTracks: payload => request('localAlbum.tracks', payload, trace),
    getLocalAlbumArtwork: payload => request('localAlbum.artwork', payload, trace),
  } : api;
  return tracedCall(trace, () => action(reader, trace));
}
const invalid = (): never => { throw new Error('[INVALID_IPC_REQUEST] 本地专辑请求或结果无效，请重新读取。'); };
/** 固定数据集和命令闭集；实际注册由共同装配入口接入，不退化成任意 Core 转发。 */
export function createLocalAlbumClient(invoke: (channel: string, value: unknown) => Promise<unknown>, scope: DatasetScope): dto.LocalAlbumLibraryPublicApi {
  async function request<C extends dto.LocalAlbumCommand>(command: C, payload: dto.LocalAlbumCommandPayloads[C], trace: PreloadReadTrace): Promise<dto.LocalAlbumCommandResults[C]> {
    trace.stage = 'preload.input';
    const payloadValid = dto.isLocalAlbumCommandPayload(command, payload); trace.matches.dto = payloadValid;
    if (!payloadValid) return invalid();
    trace.stage = 'preload.scope'; const datasetId = await scope();
    if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid();
    const copied = structuredClone(payload);
    trace.stage = 'preload.invoke'; const raw = await invoke('localAlbum:request', trace.id !== null && trace.sha256 !== null
      ? { datasetId, command, payload: copied, correlationId: trace.id } : { datasetId, command, payload: copied });
    // 私有失败只在本次原correlationId及其实际SHA闭匹配后消费；不解析原IPC Error.message。
    if (raw && typeof raw === 'object' && Object.getOwnPropertyDescriptor(raw, 'type')?.value === 'local-album-private-failure') {
      if (trace.id === null || trace.sha256 === null) return invalid();
      const failure = readLocalAlbumPrivateFailure(raw, trace.id, trace.sha256); if (!failure) return invalid();
      return rejectPrivateFailure(failure.trace, trace);
    }
    const result = raw;
    trace.stage = 'preload.scope'; const datasetMatched = await scope() === datasetId; trace.matches.dataset = datasetMatched;
    if (!datasetMatched) return invalid();
    trace.stage = 'preload.dto'; const resultValid = dto.isLocalAlbumCommandResult(command, result); trace.matches.dto = resultValid;
    if (!resultValid) return invalid();
    if (command === 'localAlbum.query') { const pageValid = dto.isLocalAlbumPage(result, copied as dto.LocalAlbumQuery); trace.matches.dto = pageValid; if (!pageValid) return invalid(); }
    if (command === 'localAlbum.tracks') {
      const page = result as dto.LocalAlbumTrackPage;
      const pageValid = dto.isLocalAlbumTrackPage(page, copied as dto.LocalAlbumTrackQuery, page.album); trace.matches.dto = pageValid; if (!pageValid) return invalid();
    }
    if (command === 'localAlbum.artwork') { const replyValid = dto.isLocalAlbumArtworkReply(result, copied as dto.LocalAlbumArtworkRequest); trace.matches.dto = replyValid; if (!replyValid) return invalid(); }
    return result as dto.LocalAlbumCommandResults[C];
  }
  const api: dto.LocalAlbumLibraryPublicApi = {
    queryLocalAlbums: async payload => { const trace = beginTrace(); return tracedCall(trace, () => request('localAlbum.query', payload, trace)); },
    getLocalAlbumTracks: async payload => { const trace = beginTrace(); return tracedCall(trace, () => request('localAlbum.tracks', payload, trace)); },
    getLocalAlbumArtwork: async payload => { const trace = beginTrace(); return tracedCall(trace, () => request('localAlbum.artwork', payload, trace)); },
  };
  preparedReaders.set(api, request); return api;
}
