import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { MOBILE_SAFE_ERROR_CODES, type MobileSafeErrorFacts } from '@music-bridge/contracts';

export const MOBILE_ARTIST_SEARCH_HTTP_TRACE_PREFIX = 'MUSICBRIDGE_MOBILE_ARTIST_SEARCH_HTTP_TRACE ';
const operations = ['searchTracks', 'searchAlbums', 'searchArtists', 'listLibraryArtists', 'getLibraryArtist',
  'listLibraryArtistAlbums', 'listLibraryArtistTracks', 'listLibraryArtistMatches', 'setLibraryArtistLink', 'unknown'] as const;
const sources = ['local', 'netease', 'unknown'] as const;
const kinds = ['tracks', 'albums', 'artists', 'unknown'] as const;
const maximumRequests = 256;
type Facts = { operation: typeof operations[number]; source: typeof sources[number]; kind: typeof kinds[number] };
type Code = MobileSafeErrorFacts['code'] | null;
type Stage = 'request' | 'handle-complete' | 'before-send-complete' | 'terminal' | 'cancelled';

/** 只投影已解析路径的固定分类；查询值、人物身份和路径本身均不返回。 */
export function describeMobileArtistSearchHttp(path: string, query: readonly (readonly [string, string])[]): Facts {
  let operation: Facts['operation'] = 'unknown', kind: Facts['kind'] = 'unknown';
  const search = /^\/mobile\/v1\/search\/(tracks|albums|artists)$/u.exec(path);
  const library = /^\/mobile\/v1\/library\/artists(?:\/[^/]+(?:\/(albums|tracks|matches|link))?)?$/u.exec(path);
  if (search) {
    kind = search[1] as Facts['kind'];
    operation = kind === 'tracks' ? 'searchTracks' : kind === 'albums' ? 'searchAlbums' : 'searchArtists';
  } else if (library) {
    const tail = library[1];
    kind = tail === 'tracks' ? 'tracks' : tail === 'albums' ? 'albums' : 'artists';
    operation = path === '/mobile/v1/library/artists' ? 'listLibraryArtists'
      : tail === 'albums' ? 'listLibraryArtistAlbums' : tail === 'tracks' ? 'listLibraryArtistTracks'
        : tail === 'matches' ? 'listLibraryArtistMatches' : tail === 'link' ? 'setLibraryArtistLink' : 'getLibraryArtist';
  }
  const selected = query.filter(pair => pair[0] === 'source');
  let source: Facts['source'] = selected.length === 0 && library ? 'local' : 'unknown';
  if (selected.length === 1) {
    if (selected[0]![1] === 'local') source = 'local';
    else if (selected[0]![1] === 'netease') source = 'netease';
  }
  return { operation, source, kind };
}

function facts(raw: unknown): Facts | undefined {
  try {
    if (raw === null || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 3 || !['operation', 'source', 'kind'].every(key => keys.includes(key))) return;
    const values = ['operation', 'source', 'kind'].map(key => Object.getOwnPropertyDescriptor(raw, key));
    if (values.some(value => !value || !('value' in value))) return;
    const [operation, source, kind] = values.map(value => value!.value);
    if (!operations.includes(operation) || !sources.includes(source) || !kinds.includes(kind)) return;
    return { operation, source, kind };
  } catch { return; }
}
function errorCode(error: unknown): Code {
  try {
    if (error === null || typeof error !== 'object') return null;
    const value = Object.getOwnPropertyDescriptor(error, 'code');
    return value && 'value' in value && MOBILE_SAFE_ERROR_CODES.includes(value.value) ? value.value : null;
  } catch { return null; }
}

/** 复用既有私有准备开关；每次最多四行，sink失效不能替换原HTTP结果。 */
export function createMobileArtistSearchHttpObservation(enabled: boolean,
  sink: (line: string) => void = line => { writeSync(1, line); }, now: () => number = () => performance.now()) {
  let admitted = 0;
  return { begin(raw: unknown) {
    try {
      if (!enabled || admitted >= maximumRequests) return;
      const captured = facts(raw); if (!captured) return;
      const started = now(); if (!Number.isFinite(started)) return;
      const requestId = randomUUID(); admitted++;
      let ended = false, handled = false, checked = false, code: Code = null;
      const emit = (stage: Stage, status: number | null = null): void => {
        try {
          const elapsed = now() - started;
          if (!Number.isFinite(elapsed)) return;
          sink(MOBILE_ARTIST_SEARCH_HTTP_TRACE_PREFIX + JSON.stringify({ schema: 'mb.artist-search-http.v1', requestId,
            ...captured, stage, elapsedMs: Math.round(Math.min(2_000_000, Math.max(0, elapsed)) * 1000) / 1000,
            status, code }) + '\n');
        } catch { /* 私有旁注不能改变原执行或错误。 */ }
      };
      emit('request');
      return {
        handleComplete() { if (!ended && !handled) { handled = true; emit('handle-complete'); } },
        beforeSendComplete() { if (!ended && handled && !checked) { checked = true; emit('before-send-complete'); } },
        reject(error: unknown) { if (!ended) code = errorCode(error); },
        finish(status: unknown, cancelled: boolean) {
          if (ended) return; ended = true;
          emit(cancelled ? 'cancelled' : 'terminal',
            typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null);
        },
      };
    } catch { return; }
  } };
}
