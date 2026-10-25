import { captureMobileDirectoryQuery, captureMobileDirectoryPage, type MobileDirectoryQuery, type MobileDirectoryPage, type MobileDirectoryArtist } from '../mobile/directory-rpc.js';
import { createHmac } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  mobileCanonicalJson, mobileCatalogResponseSnapshot, mobileContentResponseSnapshot, mobileDataSnapshot,
  mobileInteger, mobileRecord, mobileTrackSelectionEquals, mobileUtf8Bytes,
} from '@music-bridge/contracts';
import type {
  MobileContentReadContext, MobileDiscoveryCollectionRecord, MobileJsonValue, MobileLyricsContent,
  MobileRecord, MobileTrack, MobileTrackSelection, MobileUIAlbumRecord,
} from '@music-bridge/contracts';
import type { GatewayFetch } from '../stream/upstream-policy.js';
import { captureMobileContentReply, captureMobileContentRequest } from '../mobile/content-protocol.js';
import type { MobileContentOperation, MobileContentPort, MobileContentServiceInput, MobileContentSnapshot } from '../mobile/content-types.js';
import type { MobileNeteaseContentProviderPort, MobileNeteaseContentProviderRequest, MobileNeteaseContentProviderFacts } from '../mobile/content-provider-service.js';
import { captureMobileNeteaseSelection } from '../mobile/netease-catalog-service.js';
import { assertMobileNeteaseAccount, captureMobileNeteaseScope, mobileNeteaseId } from '../mobile/netease-source-types.js';
import type { MobileNeteaseAccount, MobileNeteaseAccountPort, MobileNeteaseCatalogPort, MobileNeteaseFence,
  MobileNeteaseObservedAudio, MobileNeteaseScope, MobileNeteaseStreamPort } from '../mobile/netease-source-types.js';
import { MobileServiceError } from '../mobile/types.js';
import { BridgeError } from '../shared/errors.js';
import { parseResolvedAudioStream } from './parse.js';
import { createMobileNeteaseAccountMapper, captureMobileNeteaseSongSnapshot, captureMobileNeteaseDirectorySongSnapshot } from './mobile-source-snapshot.js';
import { createMobileNeteaseHttpStreams, type MobileNeteaseHttpSource } from './mobile-http-stream.js';
import type { NeteaseMobileReadPort, NeteaseMobileReadRequest, NeteaseMobileAccountInvalidation } from './types.js';
import { createMobileNeteaseArtwork, mobileNeteaseArtworkURL, mobileNeteaseArtworkIdentity, type MobileNeteaseArtworkData, type MobileNeteaseArtworkKind } from './mobile-artwork.js';
import { mobileAccountShapeFailure } from './client.js';
import { mobileNeteaseSongAlbum, mobileNeteaseAlbumRegistration, mobileNeteaseSongAlbumName, isMobileNeteaseUnregisteredAlbumId } from './mobile-song-album.js';
import { captureMobileCapabilityContext, mobileCapabilityReject, mobileCapabilitySync, type MobileCapabilityStage } from '../mobile/capability-trace.js';

const REQUEST_MS = 10_000, CLOSE_MS = 10_000, ACCOUNT_MS = 10_000, TRACKS = 256, CACHE_MS = 30_000;
const MAX_OPERATIONS = 16, MAX_COLLECTION_TRACKS = 10_000, MAX_FEED = 1000;
const RECOMMENDED_CANDIDATES = 10, RECOMMENDED_POLICY = 'recommended-bounded-v1';
const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const changed = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
const busy = (): never => { throw new MobileServiceError(503, 'BUSY', true, 1000); };
const unavailable = (): never => { throw new MobileServiceError(403, 'RESOURCE_REVOKED'); };
const freeze = <T>(v: T): T => { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; };
const artworkFrom = (value: MobileRecord) => mobileNeteaseArtworkURL(value.picUrl)
  ?? mobileNeteaseArtworkURL(value.blurPicUrl) ?? mobileNeteaseArtworkURL(value.coverImgUrl);
function data(raw: unknown): MobileJsonValue { const c = mobileDataSnapshot(raw); return c.ok ? c.value : busy(); }
function record(raw: unknown): MobileRecord { const c = data(raw); return mobileRecord(c) ? c : busy(); }
function canonical(raw: unknown): string { return mobileCanonicalJson(data(raw)); }
function providerId(v: unknown): string {
  if (typeof v === 'string' && /^[1-9][0-9]{0,31}(?![\s\S])/u.test(v)) return v;
  if (mobileInteger(v, 1)) return String(v); return changed();
}
function text(v: unknown, empty = false): string {
  if (typeof v !== 'string' || !empty && !v.trim() || mobileUtf8Bytes(v) > 1024 || /[\u0000-\u001f\u007f-\u009f]/u.test(v)) return changed();
  return v;
}
/** 可选版本显示不授予身份；合法短值原样，畸形标量降级，控制字符仅规整显示空白。 */
function optionalEditionLabel(value: unknown): string {
  if (typeof value !== 'string' || mobileUtf8Bytes(value) > 1024) return '';
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim() : value;
}

class ProviderLoginRequired extends Error {}
const providerLoginMissing = (error: unknown) => error instanceof ProviderLoginRequired
  || error instanceof BridgeError && ['AUTH_EXPIRED','AUTH_REQUIRED','NETEASE_NOT_CONFIGURED'].includes(error.code);
function response(raw: unknown): MobileRecord {
  const value = record(raw), code = value.code ?? (mobileRecord(value.data) ? value.data.code : undefined);
  if (code === 301 || code === 302) throw new ProviderLoginRequired();
  if (code !== 200) return busy(); return value;
}
function rows(raw: unknown, max = MAX_FEED): MobileRecord[] {
  if (!Array.isArray(raw) || raw.length > max || !raw.every(mobileRecord)) return busy(); return raw;
}
function safeError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new MobileServiceError(503, 'BUSY', true, 1000);
  if (providerLoginMissing(error)) return new MobileServiceError(403, 'RESOURCE_REVOKED');
  if (error instanceof MobileServiceError) return error;
  if (error instanceof BridgeError && ['TRACK_UNAVAILABLE','TRACK_PREVIEW_ONLY'].includes(error.code)) return new MobileServiceError(403, 'RESOURCE_REVOKED');
  return new MobileServiceError(503, 'BUSY', true, 1000);
}

export interface ActualMobileNeteasePortsOptions {
  client: NeteaseMobileReadPort; serverId: string; datasetId: string; ownerEpoch: string;
  identityKey32: Uint8Array; assertCurrent: MobileNeteaseFence; now?: () => number;
  /** 仅受控 transport 测试注入；生产省略时执行原 HTTPS/DNS/redirect 策略。 */
  fetch?: GatewayFetch;
  artworkFetch?: GatewayFetch;
  privateProviderDiagnostics?: boolean;
}
export interface ActualMobileNeteaseAlbumPage {
  account: Readonly<MobileNeteaseAccount>; album: Readonly<MobileUIAlbumRecord>; items: readonly MobileTrack[];
  offset: number; limit: number; total: number; revision: string; source: 'netease';
}
export interface ActualMobileNeteaseLyrics {
  body: MobileLyricsContent; context: MobileContentReadContext;
}
export interface ActualMobileNeteasePorts {
  readonly qualified: boolean; readonly account: MobileNeteaseAccountPort; readonly provider: MobileNeteaseContentProviderPort;
  readonly catalog: MobileNeteaseCatalogPort; readonly streams: MobileNeteaseStreamPort; readonly lyrics: MobileContentPort;
  readDirectory(scope: MobileNeteaseScope, query: MobileDirectoryQuery, signal: AbortSignal): Promise<MobileDirectoryPage>;
  resolveTrackId(scope: MobileNeteaseScope, trackId: string, signal: AbortSignal): Promise<Readonly<MobileTrack>>;
  readObservedTrack(scope: MobileNeteaseScope, trackId: string, expectedSelection: Readonly<MobileTrackSelection> | null, signal: AbortSignal): Promise<Readonly<MobileTrack>>;
  resolveSelection(scope: MobileNeteaseScope, identity: Readonly<{ trackId: string; versionId: string; contentRevision: string }>, signal: AbortSignal): Promise<Readonly<MobileTrackSelection>>;
  resolveLyrics(scope: MobileNeteaseScope, selection: MobileTrackSelection, signal: AbortSignal): Promise<ActualMobileNeteaseLyrics>;
  resolveAlbumTracks(scope: MobileNeteaseScope, albumId: string, page: Readonly<{ offset: number; limit: number }>, signal: AbortSignal): Promise<ActualMobileNeteaseAlbumPage>;
  assertAlbumRevision(scope: MobileNeteaseScope, albumId: string, revision: string, signal: AbortSignal): Promise<void>;
  assertCurrent(scope: MobileNeteaseScope, stage: 'acquire' | 'lease', signal: AbortSignal): Promise<void>;
  readArtwork(scope: MobileNeteaseScope, artworkId: string, signal: AbortSignal): Promise<MobileNeteaseArtworkData>;
  assertArtwork(scope: MobileNeteaseScope, artworkId: string, signal: AbortSignal): Promise<string>;
  onAccountInvalidated(listener: (event: Readonly<NeteaseMobileAccountInvalidation>) => void): () => void;
  close(): Promise<void>;
}
interface ResolvedMedia { source: Readonly<MobileNeteaseHttpSource>; md5: string }
type DirectoryMedia = { media: ResolvedMedia; unavailable: null } | { media: null; unavailable: 'permission'|'preview'|'url-missing' };
interface TrackEntry {
  account: Readonly<MobileNeteaseAccount>; track: Readonly<MobileTrack>; observed: Readonly<MobileNeteaseObservedAudio>;
  mediaBase: string; metadata: MobileJsonValue; born: number;
}
interface AlbumState { raw: MobileRecord; album: Readonly<MobileUIAlbumRecord>; songs: MobileRecord[]; revision: string }
interface CollectionState { collection: Readonly<MobileDiscoveryCollectionRecord>; ids: string[]; revision: string; diagnostic: CollectionDiagnostic | null }
interface CollectionDiagnostic { account: string; owner: string; provider: string | null; identity: string; ids: string; title: string; artwork: string | null; updated: string; offset: number }
interface CompleteLyricLine { text: string; startMs: number | null; secondaryText?: string }
const LYRIC_LINES = 2000, LYRIC_TEXT_BYTES = 4096, LYRIC_BODY_BYTES = 2 * 1024 * 1024;
function lyricText(value: string): string {
  if (!value.trim() || mobileUtf8Bytes(value) > LYRIC_TEXT_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return busy();
  return value;
}
/** 新版接口把作词、作曲等署名放在带毫秒时间的JSON行中；只取文字，不呈现链接附注。 */
function completeCreditLine(raw: string): CompleteLyricLine | null {
  if (!raw.trimStart().startsWith('{')) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!mobileRecord(value) || !Object.hasOwn(value, 't') && !Object.hasOwn(value, 'c')) return null;
  if (!mobileInteger(value.t) || !Array.isArray(value.c)) return busy();
  let joined = '';
  for (const part of value.c) {
    if (!mobileRecord(part) || typeof part.tx !== 'string') return busy();
    joined += part.tx;
  }
  return { text: lyricText(joined), startMs: value.t };
}
/** 本域完整 LRC 视图；旧 fuzzy parser 的裁剪、跳坏行和去重不进入手机合同。 */
function completeLrc(source: string): CompleteLyricLine[] {
  if (mobileUtf8Bytes(source) > LYRIC_BODY_BYTES || /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(source)) return busy();
  const parsed: CompleteLyricLine[] = []; let offset = 0, hasOffset = false, entries = 0;
  for (const raw of source.split(/\r?\n/u)) {
    if (!raw.trim()) continue;
    const credit = completeCreditLine(raw);
    if (credit) {
      if (++entries > LYRIC_LINES) return busy();
      parsed.push(credit); continue;
    }
    const metadata = /^\[(ar|ti|al|by|re|ve|length|offset):([^\]\r\n]*)\](?![\s\S])/u.exec(raw);
    if (metadata) {
      if (mobileUtf8Bytes(metadata[2]!) > LYRIC_TEXT_BYTES) return busy();
      if (metadata[1] === 'offset') {
        if (hasOffset || !/^(?:0|-?[1-9][0-9]{0,8})(?![\s\S])/u.test(metadata[2]!)) return busy();
        offset = Number(metadata[2]); hasOffset = true;
      }
      continue;
    }
    let at = 0; const times: number[] = [];
    while (raw[at] === '[') {
      const match = /^\[([0-9]{1,5}):([0-9]{2})(?:[.:]([0-9]{1,3}))?\]/u.exec(raw.slice(at));
      if (!match) break;
      const start = Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] ?? '').padEnd(3, '0'));
      if (Number(match[2]) >= 60 || !mobileInteger(start)) return busy();
      times.push(start); at += match[0].length;
    }
    entries += times.length || 1;
    if (entries > LYRIC_LINES) return busy();
    if (times.length === 0) {
      // 损坏的时间戳不能被降级成无时间文本；完整纯文本正文仍可准确表达。
      if (/^\[[0-9]+[:.,]/u.test(raw)) return busy();
      parsed.push({ text: lyricText(raw), startMs: null });
    } else {
      // 空同步标记是正常的间奏或结束位置；校验时间并计数后，不伪造显示正文。
      if (!raw.slice(at).trim()) continue;
      const lineText = lyricText(raw.slice(at));
      for (const startMs of times) parsed.push({ text: lineText, startMs });
    }
  }
  const timed = parsed.some(line => line.startMs !== null);
  if (timed && parsed.some(line => line.startMs === null)) return busy();
  for (const line of parsed) if (line.startMs !== null) {
    const start = line.startMs + offset; if (!mobileInteger(start)) return busy(); line.startMs = start;
  }
  return timed ? parsed.sort((a, b) => a.startMs! - b.startMs!) : parsed;
}
function completeYrc(source: string): CompleteLyricLine[] {
  if (mobileUtf8Bytes(source) > LYRIC_BODY_BYTES || /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(source)) return busy();
  const output: CompleteLyricLine[] = [];
  for (const raw of source.split(/\r?\n/u)) {
    if (!raw.trim()) continue;
    const credit = completeCreditLine(raw);
    if (credit) {
      output.push(credit); if (output.length > LYRIC_LINES) return busy();
      continue;
    }
    const header = /^\[([0-9]+),([0-9]+)\]/u.exec(raw);
    if (!header) return busy();
    const start = Number(header[1]), duration = Number(header[2]), end = start + duration;
    if (!mobileInteger(start) || !mobileInteger(duration, 1) || !Number.isSafeInteger(end)) return busy();
    let at = header[0].length, joined = '';
    while (at < raw.length) {
      const word = /^\(([0-9]+),([0-9]+)(?:,[0-9]+)?\)/u.exec(raw.slice(at));
      if (!word) return busy();
      const wordStart = Number(word[1]), wordDuration = Number(word[2]);
      if (!mobileInteger(wordStart, start, end) || !mobileInteger(wordDuration, 1) || wordStart + wordDuration > end) return busy();
      const textAt = at + word[0].length, next = raw.indexOf('(', textAt);
      const textEnd = next === -1 ? raw.length : next;
      joined += raw.slice(textAt, textEnd); if (mobileUtf8Bytes(joined) > LYRIC_TEXT_BYTES) return busy(); at = textEnd;
    }
    output.push({ text: lyricText(joined), startMs: start }); if (output.length > LYRIC_LINES) return busy();
  }
  return output.sort((a, b) => a.startMs! - b.startMs!);
}

/** 原 NeteaseClient 是唯一凭据作者；所有手机身份从真实 ID/代际/元数据/有限媒体头产生。 */
export function createActualMobileNeteasePorts(options: ActualMobileNeteasePortsOptions): ActualMobileNeteasePorts {
  const { client, serverId, datasetId, ownerEpoch } = options, fence = options.assertCurrent, now = options.now ?? Date.now;
  if (![serverId,datasetId,ownerEpoch].every(mobileNeteaseId) || typeof fence !== 'function'
    || !(options.identityKey32 instanceof Uint8Array) || !(options.identityKey32.buffer instanceof ArrayBuffer) || options.identityKey32.byteLength !== 32) return invalid();
  const key = Buffer.from(options.identityKey32);
  const digest = (domain: string, value: unknown) => createHmac('sha256', key).update(`MusicBridge:MBM004:${domain}:1\0`).update(canonical(value)).digest('hex');
  const namespace = digest('NETEASE_NAMESPACE', [serverId,datasetId]).slice(0,16);
  const accountMapper = createMobileNeteaseAccountMapper({serverId,datasetId,key:Buffer.from(createHmac('sha256',key).update('NETEASE_ACCOUNT').digest())});
  const id = (kind: 'nt' | 'na' | 'np' | 'nch', raw: unknown) => `${kind}:${namespace}:${providerId(raw)}`;
  function originalId(kind: 'nt' | 'na' | 'np' | 'nch', value: string): string {
    if (typeof value !== 'string' || !value.startsWith(`${kind}:${namespace}:`)) return invalid();
    const raw = value.slice(kind.length + namespace.length + 2); return providerId(raw);
  }
  const trackCache = new Map<string, TrackEntry>(), callbacks = new Set<(event: Readonly<NeteaseMobileAccountInvalidation>) => void>();
  const pending = new Set<Promise<unknown>>(), controllers = new Set<AbortController>();
  const stages = new WeakMap<AbortSignal, 'acquire' | 'lease'>();
  let cachedAccount: { value: Readonly<MobileNeteaseAccount>; accountId: string; born: number } | null = null;
  type AccountValue = Readonly<MobileNeteaseAccount> | null;
  type AccountWaiter = { resolve(value: AccountValue): void; reject(error: unknown): void };
  type AccountFlight = { generation: number; controller: AbortController; waiters: Set<AccountWaiter> };
  let accountFlight: AccountFlight | null = null;
  let closed = false, fatal = false, closing: Promise<void> | null = null, accountGeneration = 0;
  let missingAccountUntil = 0;
  let accountDiagnosticClaims = 0;
  // 私有旁注独立最多64行、16个修订基线；无URL/身份值/素材摘要出Core。
  const collectionBaselines = new Map<string, CollectionDiagnostic>(); let collectionDiagnosticClaims = 0;
  function noteCollection(state: CollectionState, expected: string | null, offset: number): void {
    if (options.privateProviderDiagnostics !== true) return;
    try {
      const trace = captureMobileCapabilityContext();
      if (trace?.privateContentDiagnostic !== true || trace.closed || collectionDiagnosticClaims >= 64) return;
      const prior = expected === null ? undefined : collectionBaselines.get(expected), next = state.diagnostic;
      if (!next) return;
      const eq = (field: keyof CollectionDiagnostic) => prior ? prior[field] === next[field] : null;
      collectionDiagnosticClaims++;
      trace.sink('MUSICBRIDGE_MOBILE_COLLECTION_TRACE ' + JSON.stringify({ schema: 'mb.mobile-collection-trace.v1',
        requestSha256: trace.requestSha256, epochMs: Date.now(), stage: 'liked.revision.compare',
        baselinePresent: !!prior, expectedPresent: expected !== null, revisionEqual: expected === null ? null : expected === state.revision,
        accountDomainEqual: eq('account'), ownerEpochEqual: eq('owner'), providerEpochEqual: eq('provider'),
        collectionIdEqual: eq('identity'), trackIdsEqual: eq('ids'), titleEqual: eq('title'),
        artworkIdentityEqual: eq('artwork'), updateTimeEqual: eq('updated'), firstOffset: prior?.offset ?? null, offset }) + '\n');
      if (!collectionBaselines.has(state.revision)) {
        if (collectionBaselines.size >= 16) collectionBaselines.delete(collectionBaselines.keys().next().value!);
        collectionBaselines.set(state.revision, { ...next, offset });
      }
    } catch { /* 私有旁注写失败不替换实际分页结果。 */ }
  }
  const contentDiagnosticClaims = new WeakSet<object>();
  type ProviderPhase = 'feed' | 'mapping' | 'song-detail' | 'stream' | 'audio-probe';
  function sourceConsistencyChanged(stage: () => MobileCapabilityStage): never {
    try { return changed(); } catch (error) {
      try {
        const context = captureMobileCapabilityContext();
        if (options.privateProviderDiagnostics === true && context?.privateContentDiagnostic === true
          && !context.closed && !context.firstBusiness && !contentDiagnosticClaims.has(context)) {
          contentDiagnosticClaims.add(context); mobileCapabilityReject(stage(), error);
        }
      } catch { /* 私有分类失败不替换原一致性拒绝。 */ }
      throw error;
    }
  }
  function selectionStage(kind: 'exact' | 'directory', expected: MobileTrackSelection, actual: MobileTrackSelection): MobileCapabilityStage {
    const field = expected.trackId !== actual.trackId ? 'track-id' : expected.source !== actual.source ? 'source'
      : expected.versionId !== actual.versionId ? 'version' : 'revision';
    return `provider.source.selection.${kind}.${field}` as MobileCapabilityStage;
  }
  function contentStageDiagnostic(stage: MobileCapabilityStage, error: unknown): void {
    try {
      const context = captureMobileCapabilityContext();
      if (options.privateProviderDiagnostics !== true || !context || context.closed || contentDiagnosticClaims.has(context)) return;
      contentDiagnosticClaims.add(context);
      mobileCapabilityReject(stage, error);
    } catch { /* 旁注不能替换原异常或触发第二次请求。 */ }
  }
  function contentDiagnostic(phase: ProviderPhase, error: unknown): void { contentStageDiagnostic(`provider.content.${phase}`, error); }
  function mappingFailure(stage: MobileCapabilityStage, code: 'SOURCE_CHANGED'|'RESOURCE_REVOKED' = 'SOURCE_CHANGED'): never {
    const error=new MobileServiceError(code==='RESOURCE_REVOKED'?403:409,code);contentStageDiagnostic(stage,error);throw error;
  }
  function mappingSync<T>(stage: MobileCapabilityStage, work: () => T): T {
    try { return work(); } catch (error) { contentStageDiagnostic(stage, error); throw error; }
  }
  function providerSync<T>(phase: ProviderPhase, work: () => T): T {
    try { return work(); } catch (error) { contentDiagnostic(phase, error); throw error; }
  }
  async function providerStep<T>(phase: ProviderPhase, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { contentDiagnostic(phase, error); throw error; }
  }
  function accountDiagnostic(reason: 'ready' | 'auth-expired' | 'not-configured' | 'timeout' | 'shape' | 'unknown'): void {
    const context = captureMobileCapabilityContext();
    if (options.privateProviderDiagnostics !== true || !context || context.closed || accountDiagnosticClaims >= 8) return;
    accountDiagnosticClaims++;
    const stage = `provider.account.${reason}` as MobileCapabilityStage;
    if (reason === 'ready' || reason === 'not-configured') mobileCapabilitySync(stage, () => undefined);
    else mobileCapabilityReject(stage, new MobileServiceError(reason === 'auth-expired' ? 403 : 503,
      reason === 'auth-expired' ? 'RESOURCE_REVOKED' : 'BUSY'));
  }
  const artwork = createMobileNeteaseArtwork({ key: Buffer.from(createHmac('sha256', key).update('NETEASE_ARTWORK').digest()),
    serverId, datasetId, ownerEpoch, namespace, ...(options.artworkFetch ? { fetch: options.artworkFetch } : {}) });
  const clock = (): number => { const v = now(); return mobileInteger(v) ? v : busy(); };
  const ready = (): void => { if (closed || fatal) return busy(); };
  function loginMissing(): void {
    accountGeneration++; cachedAccount = null; trackCache.clear(); http.invalidateAccount(); artwork.invalidate();
    missingAccountUntil = clock() + ACCOUNT_MS;
  }
  async function actualAccount(signal: AbortSignal): Promise<Readonly<MobileNeteaseAccount> | null> {
    ready(); signal.throwIfAborted(); if (!client.configured) { accountDiagnostic('not-configured'); if (cachedAccount) loginMissing(); return null; }
    if (clock() < missingAccountUntil) return null;
    if (cachedAccount && clock() - cachedAccount.born < ACCOUNT_MS) return cachedAccount.value;
    if (!accountFlight) {
      const flight: AccountFlight = { generation: accountGeneration, controller: new AbortController(), waiters: new Set() };
      accountFlight = flight; controllers.add(flight.controller);
      // 只共享 Provider 身份事实。各设备的授权、Scope 和取消仍由各自请求持有。
      const work = (async () => {
        let value: AccountValue;
        try { value = await readAccount(flight.controller.signal, flight.generation); }
        finally { await client.awaitMobileQuiet(flight.controller.signal); }
        flight.controller.signal.throwIfAborted(); ready();
        if (value !== null && flight.generation !== accountGeneration) return changed();
        return value;
      })();
      pending.add(work);
      const finish = (result: { value: AccountValue } | { error: unknown }): void => {
        pending.delete(work); controllers.delete(flight.controller);
        if (accountFlight === flight) accountFlight = null;
        for (const waiter of [...flight.waiters]) {
          if ('error' in result) waiter.reject(result.error); else waiter.resolve(result.value);
        }
        flight.waiters.clear();
      };
      void work.then(value => finish({ value }), error => finish({ error }));
    }
    const flight = accountFlight;
    // 最后一个等待者取消后，真实 SDK 静止之前不再发起重复查询。
    if (flight.controller.signal.aborted || flight.generation !== accountGeneration || flight.waiters.size >= 64) return busy();
    return new Promise<AccountValue>((resolve, reject) => {
      const detach = (): void => { flight.waiters.delete(waiter); signal.removeEventListener('abort', cancel); };
      const waiter: AccountWaiter = {
        resolve(value) { detach(); resolve(value); },
        reject(error) { detach(); reject(error); },
      };
      const cancel = (): void => {
        waiter.reject(signal.reason);
        if (flight.waiters.size === 0) flight.controller.abort();
      };
      flight.waiters.add(waiter); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  async function readAccount(signal: AbortSignal, generation: number): Promise<AccountValue> {
    let actual: Awaited<ReturnType<NeteaseMobileReadPort['mobileAccount']>>;
    try { actual = await client.mobileAccount({signal,timeoutMs:REQUEST_MS,priority:'playback'}); }
    catch (error) {
      signal.throwIfAborted(); ready(); if (generation !== accountGeneration) return changed();
      if (options.privateProviderDiagnostics === true && accountDiagnosticClaims < 8 && captureMobileCapabilityContext()) {
        let reason: 'timeout' | 'shape' | 'auth-expired' | 'not-configured' | 'unknown' = 'unknown';
        try {
          const details = !nodeTypes.isProxy(error) && error instanceof BridgeError ? Object.getOwnPropertyDescriptor(error, 'details')?.value : undefined;
          if (!nodeTypes.isProxy(error) && error instanceof BridgeError
            && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'NETEASE_NOT_CONFIGURED') reason = 'not-configured';
          else if (details && typeof details === 'object' && !nodeTypes.isProxy(details)
            && Object.getOwnPropertyDescriptor(details, 'reason')?.value === 'request-timeout') reason = 'timeout';
          else if (mobileAccountShapeFailure(error)) reason = 'shape';
          else if (!nodeTypes.isProxy(error) && providerLoginMissing(error)) reason = 'auth-expired';
        } catch { /* 旁注失败不替换原业务异常。 */ }
        accountDiagnostic(reason);
      }
      if (providerLoginMissing(error)) { loginMissing(); return null; }
      throw error;
    }
    signal.throwIfAborted(); ready(); if (generation !== accountGeneration) return changed();
    const value = accountMapper.capture(actual.accountId, actual.providerEpoch);
    if (cachedAccount && canonical(cachedAccount.value) !== canonical(value)) {
      // 同 Cookie 的上游账户事实也不得静默替换已有 lease 的绑定。
      trackCache.clear(); http.invalidateAccount(); artwork.invalidate();
    }
    cachedAccount = { value, accountId: providerId(actual.accountId), born: clock() }; accountDiagnostic('ready'); return value;
  }
  async function current(scopeRaw: MobileNeteaseScope, stage: 'acquire' | 'lease', signal: AbortSignal, queryAccount = true): Promise<MobileNeteaseScope> {
    const scope = captureMobileNeteaseScope(scopeRaw);
    if (scope.serverId !== serverId || scope.datasetId !== datasetId || scope.ownerEpoch !== ownerEpoch) return changed();
    const effectiveStage = stages.get(signal) ?? stage;
    ready(); signal.throwIfAborted(); await fence(scope, effectiveStage); signal.throwIfAborted(); ready();
    const account = queryAccount ? await actualAccount(signal) : cachedAccount?.value ?? null;
    assertMobileNeteaseAccount(scope, account); if (!client.configured) throw new MobileServiceError(403, 'RESOURCE_REVOKED');
    await fence(scope, effectiveStage); signal.throwIfAborted(); ready(); return scope;
  }
  async function api(scope: MobileNeteaseScope, request: NeteaseMobileReadRequest, signal: AbortSignal): Promise<MobileRecord> {
    await current(scope, 'acquire', signal);
    const streaming = request.operation === 'stream' || request.operation === 'streams';
    const phase = streaming ? 'stream' : request.operation === 'song-detail' ? 'song-detail' : 'feed';
    const raw = await providerStep(phase, () => client.mobileRead(request,{signal,timeoutMs:REQUEST_MS,priority:streaming?'playback':'background'}));
    await current(scope, 'acquire', signal, false); if (raw.providerEpoch !== scope.providerEpoch) return changed();
    return providerSync(phase, () => response(raw.response));
  }
  async function artworkURL(scope: MobileNeteaseScope, kind: MobileNeteaseArtworkKind, item: string, signal: AbortSignal): Promise<unknown> {
    if (kind === 'r') {
      const body = await api(scope, { operation: 'artist-profile', id: item }, signal);
      if (!mobileRecord(body.artist) || providerId(body.artist.id) !== item) return changed();
      return artworkFrom(body.artist);
    }
    if (kind === 's') {
      const values = await songs(scope, [item], signal), song = values[0];
      if (!song || !mobileRecord(song.al)) return changed(); return artworkFrom(song.al);
    }
    const body = await api(scope, kind === 'a' ? { operation: 'album', id: item } : { operation: 'playlist-detail', id: item }, signal);
    const value = kind === 'a' ? body.album : body.playlist;
    if (!mobileRecord(value) || providerId(value.id) !== item) return changed();
    return artworkFrom(value);
  }
  async function run<T>(scopeRaw: MobileNeteaseScope, signal: AbortSignal, operation: (scope: MobileNeteaseScope, owned: AbortSignal) => Promise<T>, stage: 'acquire' | 'lease' = 'acquire', awaitFailureQuiet = false, awaitSignalQuiet = false): Promise<T> {
    ready(); const scope = captureMobileNeteaseScope(scopeRaw); if (pending.size >= MAX_OPERATIONS) return busy();
    const controller = new AbortController(), abort = () => controller.abort();
    stages.set(controller.signal, stage);
    controllers.add(controller); signal.addEventListener('abort', abort, {once:true}); if (signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refusal = new Promise<never>((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new MobileServiceError(503,'BUSY',true,1000)); },REQUEST_MS); });
    const work = (async () => { try {
      const captured = await current(scope, 'acquire', controller.signal); const value = await operation(captured,controller.signal);
      await current(captured,'acquire',controller.signal,false); return value;
    } finally { if (awaitSignalQuiet) await client.awaitMobileQuiet(controller.signal); } })();
    pending.add(work); void work.finally(() => { pending.delete(work); controllers.delete(controller); signal.removeEventListener('abort',abort); if(timer)clearTimeout(timer); }).catch(() => undefined);
    try { return await Promise.race([work,refusal]); } catch(error) {
      if (providerLoginMissing(error)) loginMissing();
      controller.abort(); const failure = safeError(error,signal);
      // 封面与独立曲目详情：10秒封输出并取消，RPC flight等本次真实工作静止才确认quiet。
      // 不等待其他操作、不提前释放原pending/图片4槽，也不延长任何网络工作期限。
      if (awaitFailureQuiet) await work.catch(() => undefined);
      throw failure;
    }
  }
  const cacheKey = (scope: MobileNeteaseScope, rawId: string) => canonical([scope.accountDomain,scope.providerEpoch,rawId]);
  function remember(scope: MobileNeteaseScope, rawId: string, entry: TrackEntry): void {
    const k = cacheKey(scope,rawId); trackCache.delete(k);
    if (trackCache.size >= TRACKS) trackCache.delete(trackCache.keys().next().value!); trackCache.set(k,entry);
  }
  function resolvedMedia(rawId: string, row: MobileRecord): ResolvedMedia {
    if (typeof row.md5 !== 'string' || !/^[a-fA-F0-9]{32}(?![\s\S])/u.test(row.md5)
      || !mobileInteger(row.size,4) || !mobileInteger(row.expi,1,604800)) return busy();
    const resolved = parseResolvedAudioStream({code:200,data:[row]},rawId,'hires');
    const md5 = row.md5.toLowerCase(), sourceIdentity = 'ns:'+digest('NETEASE_MEDIA',[rawId,md5,row.size]);
    return {md5,source:freeze({account:cachedAccount!.value,sourceIdentity,size:row.size,
      expiresAtMs:clock()+Math.min(row.expi*1000,300000),upstreamUrl:resolved.upstreamUrl,requestHeaders:{...resolved.requestHeaders},
      contentDigest:{algorithm:'md5',value:md5},
      ...(options.privateProviderDiagnostics===true?{diagnosticMediaMd5:md5}:{})})};
  }
  const mediaVersion = (rawId:string,stream:ResolvedMedia) => 'nv:'+digest('NETEASE_MEDIA_VERSION',[rawId,stream.md5,stream.source.size]);
  function directoryMedia(rawId:string,row:MobileRecord):DirectoryMedia {
    // 只把明确的单曲授权拒绝降为不可用；未知状态、损坏描述符与不安全URL继续拒绝整次读取。
    if(row.code!==200){if([401,403,404].includes(row.code as number))return{media:null,unavailable:'permission'};return mappingSync('provider.content.stream.item-status',changed);}
    if(row.freeTrialInfo!==null&&row.freeTrialInfo!==undefined)return{media:null,unavailable:'preview'};
    if(row.url===null)return{media:null,unavailable:'url-missing'};
    return{media:resolvedMedia(rawId,row),unavailable:null};
  }
  async function media(scope: MobileNeteaseScope, rawId: string, signal: AbortSignal): Promise<ResolvedMedia> {
    const raw = await api(scope,{operation:'stream',id:rawId,quality:'hires'},signal);
    return providerSync('stream', () => {
      const values=rows(raw.data,100),matching=values.filter(v=>providerId(v.id)===rawId);if(matching.length!==1)return changed();
      const captured=directoryMedia(rawId,matching[0]!);return captured.media??unavailable();
    });
  }
  async function mediaBatch(scope:MobileNeteaseScope,ids:string[],signal:AbortSignal):Promise<DirectoryMedia[]> {
    if(ids.length===0)return[];if(ids.length>100||new Set(ids).size!==ids.length)return changed();
    const raw=await api(scope,{operation:'streams',ids,quality:'hires'},signal);
    return providerSync('stream',()=>{const values=rows(raw.data,100),byId=new Map<string,MobileRecord>();
      for(const row of values){const rawId=mappingSync('provider.content.stream.batch.id-invalid',()=>providerId(row.id));
        if(!ids.includes(rawId))return mappingSync('provider.content.stream.batch.unexpected-id',changed);
        if(byId.has(rawId))return mappingSync('provider.content.stream.batch.duplicate-id',changed);byId.set(rawId,row);}
      if(byId.size!==ids.length)return mappingSync('provider.content.stream.batch.missing-id',changed);return ids.map(rawId=>directoryMedia(rawId,byId.get(rawId)!));});
  }
  function songMaterial(song: MobileRecord): MobileJsonValue {
    const sourceId = mappingSync('provider.content.mapping.song-id', () => providerId(song.id));
    const album = mappingSync('provider.content.mapping.album-shape', () => mobileNeteaseSongAlbum(song.al));
    const albumId = mappingSync('provider.content.mapping.album-id', () => mobileNeteaseAlbumRegistration(album));
    const artistRows = mappingSync('provider.content.mapping.artists-shape', () => {
      if (!Array.isArray(song.ar) || song.ar.length === 0 || song.ar.length > 32) return changed(); return song.ar;
    });
    const duration = mappingSync('provider.content.mapping.duration', () => mobileInteger(song.dt,1) ? song.dt : changed());
    const artists = artistRows.map(value => {
      const artist = mappingSync('provider.content.mapping.artists-shape', () => mobileRecord(value) ? value : changed());
      // 艺人注册ID只参与元数据；精确零与缺省均表示没有注册身份，不用于曲目路由。
      return {id:mappingSync('provider.content.mapping.artist-id', () => artist.id === undefined || artist.id === 0 || artist.id === '0' ? null : providerId(artist.id)),
        name:mappingSync('provider.content.mapping.artist-name', () => text(artist.name))};
    });
    const editionLabel = mappingSync('provider.content.mapping.edition', () => optionalEditionLabel(Array.isArray(song.alia) ? song.alia[0] : undefined));
    const name = mappingSync('provider.content.mapping.song-title', () => text(song.name));
    const albumName = mappingSync('provider.content.mapping.album-name', () => mobileNeteaseSongAlbumName(album,albumId));
    return {id:sourceId,name,ar:artists,al:{id:albumId,name:albumName},dt:duration,editionLabel};
  }
  async function songs(scope: MobileNeteaseScope, ids: string[], signal: AbortSignal): Promise<MobileRecord[]> {
    if (ids.length === 0) return [];
    if (ids.length > 100 || new Set(ids).size !== ids.length) return changed();
    const result = await api(scope,{operation:'song-detail',ids},signal);
    return providerSync('song-detail', () => {
    const values = rows(result.songs,100);
    const byId = new Map<string,MobileRecord>(); for(const value of values){const rawId=providerId(value.id);if(byId.has(rawId)||!ids.includes(rawId))return changed();byId.set(rawId,value);}
    if(byId.size!==ids.length)return unavailable();return ids.map(rawId=>byId.get(rawId)!);
    });
  }
  function songAlbumBinding(scope: MobileNeteaseScope, rawId: string, album: MobileRecord): { albumId: string; providerAlbumId: string | null } {
    const providerAlbumId=mobileNeteaseAlbumRegistration(album);
    // 未注册归属是独立opaque身份，不是假造上游专辑；账号/代际/曲目全部绑定。
    const albumId=providerAlbumId===null?'nu:'+digest('NETEASE_UNREGISTERED_ALBUM',[serverId,datasetId,ownerEpoch,scope.accountDomain,scope.providerEpoch,rawId]):id('na',providerAlbumId);
    return{albumId,providerAlbumId};
  }
  /** 仅已核rawId的两个独立只读请求；不共享事实/权限，失败仍按原detail先后顺序裁决。 */
  async function knownTrackReads<D,S>(signal:AbortSignal,detail:()=>Promise<D>,stream:()=>Promise<S>):Promise<[D,S]>{
    const [d,s]=await Promise.allSettled([detail(),stream()]);
    if(d.status==='rejected'||s.status==='rejected'){
      // abort/本地超时不代表SDK静止；原signal的物理请求落定后才归还这次并行工作。
      try{await client.awaitMobileQuiet(signal);}finally{
        if(d.status==='rejected')throw d.reason;
        if(s.status==='rejected')throw s.reason;
      }
    }
    if(d.status!=='fulfilled'||s.status!=='fulfilled')return busy();
    return[d.value,s.value];
  }
  async function observeSong(scope: MobileNeteaseScope, song: MobileRecord, metadata:MobileJsonValue,
    rawId:string,stream:ResolvedMedia,signal: AbortSignal): Promise<TrackEntry> {
    const observed = await providerStep('audio-probe', () => http.probe(scope,stream.source,signal)); await current(scope,'acquire',signal,false);
    return providerSync('mapping', () => {
    const versionId = mediaVersion(rawId,stream);
    const contentRevision = 'nr:'+digest('NETEASE_TRACK',[versionId,metadata]);
    const selection:MobileTrackSelection={trackId:id('nt',rawId),source:'netease',versionId,contentRevision};
    const album = mobileNeteaseSongAlbum(song.al), material = metadata as MobileRecord;
    const artworkId = artwork.bind(scope, 's', rawId, artworkFrom(album));
    const facts = captureMobileNeteaseSongSnapshot(song,{account:stream.source.account,selection,sourceItemId:rawId,
      ...songAlbumBinding(scope,rawId,album),editionLabel:text(material.editionLabel,true),observed,availability:'available',
      ...(artworkId ? { artworkId } : {})});
    const checked = mobileCatalogResponseSnapshot('track',facts.track); if(!checked.ok)return busy();
    const entry:TrackEntry={account:stream.source.account,track:freeze(checked.value),observed,mediaBase:stream.source.sourceIdentity,metadata,born:clock()};
    remember(scope,rawId,entry);return entry;
    });
  }
  async function directorySongs(scope:MobileNeteaseScope,raw:MobileRecord[],signal:AbortSignal):Promise<MobileTrack[]> {
    const metadata=providerSync('mapping',()=>raw.map(song=>songMaterial(song))),ids=raw.map(song=>providerId(song.id));
    const streams=await mediaBatch(scope,ids,signal);await current(scope,'acquire',signal,false);
    return directorySongTracks(scope,raw,metadata,ids,streams);
  }
  function directorySongTracks(scope:MobileNeteaseScope,raw:MobileRecord[],metadata:MobileJsonValue[],ids:string[],streams:DirectoryMedia[]):MobileTrack[]{
    return providerSync('mapping',()=>raw.map((song,index)=>{
      const rawId=ids[index]!,stream=streams[index]!,material=metadata[index] as MobileRecord,album=mobileNeteaseSongAlbum(song.al);
      const versionId=stream.media?mediaVersion(rawId,stream.media):'nv:'+digest('NETEASE_UNAVAILABLE_VERSION',[rawId,scope.providerEpoch,stream.unavailable]);
      const contentRevision='nr:'+digest('NETEASE_TRACK',[versionId,material]);
      const selection:MobileTrackSelection={trackId:id('nt',rawId),source:'netease',versionId,contentRevision};
      const artworkId=artwork.bind(scope,'s',rawId,artworkFrom(album));
      const facts=mappingSync('provider.content.mapping.directory-snapshot',()=>captureMobileNeteaseDirectorySongSnapshot(song,{account:cachedAccount!.value,selection,sourceItemId:rawId,
        ...songAlbumBinding(scope,rawId,album),editionLabel:text(material.editionLabel,true),
        media:stream.media?{md5:stream.media.md5,size:stream.media.source.size}:null,availability:stream.media?'available':'unavailable',
        ...(artworkId?{artworkId}:{})}));
      return mappingSync('provider.content.mapping.track-dto',()=>{const checked=mobileCatalogResponseSnapshot('track',facts.track);if(!checked.ok)return busy();return freeze(checked.value);});
    }));
  }
  async function directoryTrackId(scope:MobileNeteaseScope,publicId:string,signal:AbortSignal):Promise<MobileTrack>{
    const rawId=originalId('nt',publicId);
    const [detail,streams]=await knownTrackReads(signal,async()=>{
      const raw=await songs(scope,[rawId],signal),metadata=providerSync('mapping',()=>raw.map(song=>songMaterial(song))),ids=raw.map(song=>providerId(song.id));
      return{raw,metadata,ids};
    },()=>mediaBatch(scope,[rawId],signal));
    await current(scope,'acquire',signal,false);
    return directorySongTracks(scope,detail.raw,detail.metadata,detail.ids,streams)[0]!;
  }
  async function mapTwo<T,R>(items: readonly T[], action: (value:T)=>Promise<R>): Promise<R[]> {
    const output = new Array<R>(items.length); let at=0;
    await Promise.all(Array.from({length:Math.min(2,items.length)},async()=>{while(at<items.length){const index=at++;output[index]=await action(items[index]!);}}));return output;
  }
  async function trackId(scope: MobileNeteaseScope, publicId: string, signal: AbortSignal): Promise<TrackEntry> {
    const rawId=originalId('nt',publicId);
    const [detail,stream]=await knownTrackReads(signal,async()=>{
      const values=await songs(scope,[rawId],signal),song=values[0]!,metadata=providerSync('mapping',()=>songMaterial(song)),id=providerId(song.id);
      return{song,metadata,id};
    },()=>media(scope,rawId,signal));
    return observeSong(scope,detail.song,detail.metadata,detail.id,stream,signal);
  }
  async function exactTrack(scope: MobileNeteaseScope, selectionRaw: MobileTrackSelection, signal: AbortSignal): Promise<TrackEntry> {
    const selection = captureMobileNeteaseSelection(selectionRaw), entry = await trackId(scope,selection.trackId,signal);
    if(!mobileTrackSelectionEquals(selection,{trackId:entry.track.id,source:entry.track.source,versionId:entry.track.versionId,contentRevision:entry.track.contentRevision}))return sourceConsistencyChanged(()=>selectionStage('exact',selection,{trackId:entry.track.id,source:entry.track.source,versionId:entry.track.versionId,contentRevision:entry.track.contentRevision}));return entry;
  }
  async function refreshSource(scope: MobileNeteaseScope, selection: Readonly<MobileTrackSelection>, signal: AbortSignal): Promise<MobileNeteaseHttpSource> {
    const rawId = originalId('nt',selection.trackId); let entry=trackCache.get(cacheKey(scope,rawId));
    if(!entry||clock()-entry.born>=CACHE_MS||entry.track.versionId!==selection.versionId||entry.track.contentRevision!==selection.contentRevision)entry=await exactTrack(scope,selection,signal);
    const [detail,stream]=await Promise.all([songs(scope,[rawId],signal),media(scope,rawId,signal)]);
    if(canonical(songMaterial(detail[0]!))!==canonical(entry.metadata)||stream.source.sourceIdentity!==entry.mediaBase)return sourceConsistencyChanged(()=>
      canonical(songMaterial(detail[0]!))!==canonical(entry.metadata)?'provider.source.refresh.metadata':'provider.source.refresh.media-base');
    return stream.source;
  }
  const http = createMobileNeteaseHttpStreams({assertCurrent:async(scope,stage)=>{await current(scope,stage,new AbortController().signal,false);},
    refresh:(scope,selection,signal)=>run(scope,signal,(s,owned)=>refreshSource(s,selection,owned),'lease'),now,
    privateDiagnostics:options.privateProviderDiagnostics===true,...(options.fetch?{fetch:options.fetch}:{})});
  const unsubscribe=client.onMobileAccountInvalidated(event=>{accountGeneration++;cachedAccount=null;trackCache.clear();http.invalidateAccount();
    missingAccountUntil=0;artwork.invalidate();
    for(const c of controllers)c.abort();for(const listener of callbacks){try{listener(event);}catch{/* 观察者不能阻断实际撤销。 */}}});
  const account:MobileNeteaseAccountPort={async current(signal){try{return await actualAccount(signal);}catch(error){throw safeError(error,signal);}}};
  function albumRecord(scope: MobileNeteaseScope, raw: MobileRecord, songsRaw?: readonly MobileRecord[]): Readonly<MobileUIAlbumRecord> {
    const albumId=providerId(raw.id), names=Array.isArray(raw.artists)?rows(raw.artists,32):mobileRecord(raw.artist)?[raw.artist]:null;
    if(!names||names.length===0)return changed();const artists=names.map(a=>text(a.name));
    const count=raw.size??raw.trackCount;if(!mobileInteger(count,0,MAX_COLLECTION_TRACKS)||songsRaw&&count!==songsRaw.length)return changed();
    const album:MobileUIAlbumRecord={id:id('na',albumId),source:'netease',title:text(raw.name),artists,editionLabel:typeof raw.type==='string'?text(raw.type,true):'',trackCount:count};
    const artworkId = artwork.bind(scope, 'a', albumId, artworkFrom(raw)); if (artworkId) album.artworkId = artworkId;
    if(mobileInteger(raw.publishTime,1)){const year=new Date(raw.publishTime).getUTCFullYear();if(mobileInteger(year,0,9999))album.year=year;}
    const result=mobileContentResponseSnapshot('uiAlbum',album);return result.ok?freeze(result.value):busy();
  }
  async function albumState(scope: MobileNeteaseScope, albumId: string, signal: AbortSignal): Promise<AlbumState> {
    if(isMobileNeteaseUnregisteredAlbumId(albumId))return unavailable();
    const rawId=originalId('na',albumId), body=await api(scope,{operation:'album',id:rawId},signal);
    return providerSync('mapping', () => {
    if(!mobileRecord(body.album)||providerId(body.album.id)!==rawId)return changed();const raw=body.album, values=rows(body.songs,MAX_COLLECTION_TRACKS);
    const seen=new Set<string>();for(const song of values){const rawSongId=providerId(song.id);if(seen.has(rawSongId)||!mobileRecord(song.al)||providerId(song.al.id)!==rawId)return changed();seen.add(rawSongId);songMaterial(song);}
    const album=albumRecord(scope,raw,values),revision='nr:'+digest('NETEASE_ALBUM',[album,values.map(songMaterial)]);return{raw,album,songs:values,revision};
    });
  }
  async function collectionState(scope: MobileNeteaseScope, publicId: string, kind: 'playlist'|'chart', signal: AbortSignal, observed?: MobileRecord): Promise<CollectionState> {
    const rawId=originalId(kind==='chart'?'nch':'np',publicId), body=observed??await api(scope,{operation:'playlist-detail',id:rawId},signal);
    return providerSync('mapping', () => {
    const p=mappingSync('provider.content.mapping.collection-identity',()=>{if(!mobileRecord(body.playlist)||providerId(body.playlist.id)!==rawId)return changed();return body.playlist;});
    if(!Array.isArray(p.trackIds))return mappingFailure('provider.content.collection.track-ids-missing');
    const trackIds=mappingSync('provider.content.mapping.collection-member-id',()=>rows(p.trackIds,MAX_COLLECTION_TRACKS).map(v=>providerId(v.id)));
    if(new Set(trackIds).size!==trackIds.length)return mappingFailure('provider.content.collection.duplicate-ids');
    if(!mobileInteger(p.trackCount,0,MAX_COLLECTION_TRACKS)||p.trackCount!==trackIds.length)return mappingFailure('provider.content.collection.count-mismatch');
    let title:string;try{title=text(p.name);}catch(error){contentStageDiagnostic('provider.content.collection.invalid-name',error);throw error;}
    // 上游更新时间不是公开内容；仅时间戳刷新不能破坏已签发的成员游标。
    const material={id:rawId,name:title,trackCount:p.trackCount,ids:trackIds};
    const artworkId=artwork.bind(scope,'p',rawId,artworkFrom(p))??null;
    const logicalArtwork=mobileNeteaseArtworkIdentity(artworkFrom(p));
    const revision='nr:'+digest('NETEASE_COLLECTION',[serverId,datasetId,scope.ownerEpoch,scope.accountDomain,scope.providerEpoch,material,logicalArtwork]),collection:MobileDiscoveryCollectionRecord={id:publicId,kind,title,artworkId,trackCount:p.trackCount,collectionRevision:revision};
    return{collection:freeze(collection),ids:trackIds,revision,diagnostic:options.privateProviderDiagnostics===true?{account:scope.accountDomain,owner:scope.ownerEpoch,provider:scope.providerEpoch,identity:publicId,
      ids:digest('NETEASE_COLLECTION_IDS',trackIds),title:digest('NETEASE_COLLECTION_TITLE',title),artwork:logicalArtwork,updated:digest('NETEASE_COLLECTION_UPDATED',p.updateTime??null),offset:0}:null};
    });
  }
  async function recommendedCollection(scope: MobileNeteaseScope, publicId: string, signal: AbortSignal,
    onInvalid: (body: MobileRecord) => void): Promise<CollectionState | null> {
    const rawId=originalId('np',publicId),body=await api(scope,{operation:'playlist-detail',id:rawId},signal);
    // 只隔离本次已通过API/账户围栏的局部数据；网络、登录、取消和投影错误均不捕获。
    // 预检不修补计数或成员；合格者仍交原collectionState生成真实同次修订。
    const p=body.playlist,nativeId=(value:unknown):string|null=>typeof value==='string'&&/^[1-9][0-9]{0,31}(?![\s\S])/u.test(value)
      ?value:mobileInteger(value,1)?String(value):null;
    const invalid=()=>{onInvalid(body);return null;};
    if(!mobileRecord(p)||nativeId(p.id)!==rawId||!Array.isArray(p.trackIds)||p.trackIds.length>MAX_COLLECTION_TRACKS
      ||!mobileInteger(p.trackCount,0,MAX_COLLECTION_TRACKS)||p.trackCount!==p.trackIds.length
      ||typeof p.name!=='string'||!p.name.trim()||mobileUtf8Bytes(p.name)>1024||/[\u0000-\u001f\u007f-\u009f]/u.test(p.name))return invalid();
    const ids=new Set<string>();
    for(const member of p.trackIds){
      const memberId=mobileRecord(member)?nativeId(member.id):null;
      if(memberId===null||ids.has(memberId))return invalid();ids.add(memberId);
    }
    return collectionState(scope,publicId,'playlist',signal,body);
  }
  async function liked(scope: MobileNeteaseScope, signal: AbortSignal, selectedId?: string): Promise<CollectionState> {
    await current(scope,'acquire',signal);const accountId=cachedAccount!.accountId;
    // 续页用本次fresh detail核原生红心归属；不缓存授权、不复用旧detail。
    // 旧SDK缺少资格字段或历史10时，仍完整执行原有有界身份扫描。
    let observed: MobileRecord | undefined;
    if (selectedId !== undefined) {
      const rawId=originalId('np',selectedId);observed=await api(scope,{operation:'playlist-detail',id:rawId},signal);
      const p=observed.playlist;
      if(!mobileRecord(p)||providerId(p.id)!==rawId)return mappingFailure('provider.content.mapping.collection-identity');
      const owner=p.userId===undefined?null:providerId(p.userId),creator=mobileRecord(p.creator)?providerId(p.creator.userId):null;
      if(owner!==null&&creator!==null&&owner!==creator||owner!==null&&owner!==accountId||creator!==null&&creator!==accountId)
        return mappingFailure('provider.content.liked.creator-mismatch');
      if(p.specialType!==undefined&&p.specialType!==null&&![5,'5',10,'10'].includes(p.specialType as number|string))
        return mappingFailure('provider.content.liked.not-found','RESOURCE_REVOKED');
      if((p.specialType===5||p.specialType==='5')&&(owner??creator)===accountId)
        return collectionState(scope,selectedId,'playlist',signal,observed);
    }
    const selected = (rawId:string) => collectionState(scope,id('np',rawId),'playlist',signal,
      selectedId===id('np',rawId)?observed:undefined);
    let nativeId:string|null=null,legacyId:string|null=null,legacyAmbiguous=false,numberMarker=false,stringMarker=false;
    for(let offset=0;offset<1000;offset+=100){
      const body=await api(scope,{operation:'user-playlists',userId:accountId,offset,limit:100},signal),list=rows(body.playlist,100);
      for(const candidate of list){
        numberMarker ||= typeof candidate.specialType==='number';stringMarker ||= typeof candidate.specialType==='string';
        const native=candidate.specialType===5||candidate.specialType==='5',legacy=candidate.specialType===10||candidate.specialType==='10';
        if(!native&&!legacy)continue;
        try{
          const owner=candidate.userId===undefined?null:providerId(candidate.userId),creator=mobileRecord(candidate.creator)?providerId(candidate.creator.userId):null;
          if(owner!==null&&creator!==null&&owner!==creator)return mappingFailure('provider.content.liked.creator-mismatch');
          // 用户歌单可包含收藏的他人歌单；只有明确且一致的外来归属可以跳过。
          const declaredOwner=owner??creator;if(declaredOwner!==null&&declaredOwner!==accountId)continue;
        }
        catch(error){contentStageDiagnostic('provider.content.liked.creator-mismatch',error);throw error;}
        const candidateId=providerSync('mapping',()=>providerId(candidate.id));
        if(native){if(nativeId!==null)return mappingFailure('provider.content.liked.ambiguous');nativeId=candidateId;}
        else if(legacyId!==null)legacyAmbiguous=true;else legacyId=candidateId;
      }
      if(body.more===false){
        // 原生5优先。只有完成同一有限扫描确认没有5，历史10才取得兼容资格。
        if(nativeId!==null)return selected(nativeId);
        if(legacyAmbiguous)return mappingFailure('provider.content.liked.ambiguous');
        if(legacyId!==null)return selected(legacyId);
        const context=captureMobileCapabilityContext();if(options.privateProviderDiagnostics===true&&context&&!context.closed){
          if(numberMarker)mobileCapabilitySync('provider.content.liked.marker-number',()=>undefined);
          if(stringMarker)mobileCapabilitySync('provider.content.liked.marker-string',()=>undefined);}
        return mappingFailure('provider.content.liked.not-found','RESOURCE_REVOKED');
      }
      if(body.more!==true||list.length!==100)return busy();
    }return busy();
  }
  async function pageTracks(scope:MobileNeteaseScope,ids:string[],signal:AbortSignal,albumId?:string):Promise<MobileTrack[]>{
    const tracks=await directorySongs(scope,await songs(scope,ids,signal),signal);if(albumId&&tracks.some(track=>track.albumId!==albumId))return changed();return tracks;
  }
  function page(input: {offset:number;limit:number},total:number): {start:number;end:number;next:number|null} {
    if(!mobileInteger(input.offset,0,total)||!mobileInteger(input.limit,1,100))return invalid();const end=Math.min(total,input.offset+input.limit);
    return{start:input.offset,end,next:end<total?end:null};
  }
  async function newAlbums(scope:MobileNeteaseScope,input:{offset:number;limit:number;expectedRevision:string|null},signal:AbortSignal):Promise<{items:MobileUIAlbumRecord[];revision:string;next:number|null}>{
    async function read(offset:number,limit:number){
      const body=await api(scope,{operation:'new-albums',offset,limit},signal),list=providerSync('mapping',()=>rows(body.albums,100));
      if(!mobileInteger(body.total))return mappingFailure('provider.content.albums.total');
      if(offset>body.total||list.length!==Math.min(limit,body.total-offset))return mappingFailure('provider.content.albums.page-length');
      const items=list.map(raw=>providerSync('mapping',()=>albumRecord(scope,raw)));
      if(new Set(items.map(item=>item.id)).size!==items.length)return mappingFailure('provider.content.albums.duplicate-ids');
      return{total:body.total,items};
    }
    // 首屏是每次请求的有限稳定锚；总数不是本次物化上限，也不触发全库读取。
    const anchor=await read(0,100),revision='nr:'+digest('NETEASE_ALBUM_FEED',[anchor.total,anchor.items]);
    if(input.expectedRevision!==null&&input.expectedRevision!==revision)return mappingFailure('provider.content.albums.anchor-changed');
    const p=page(input,anchor.total);
    if(p.end<=anchor.items.length)return{items:anchor.items.slice(p.start,p.end),revision,next:p.next};
    const selected=await read(p.start,input.limit);if(selected.total!==anchor.total)return mappingFailure('provider.content.albums.total');
    const positions=new Map(anchor.items.map((item,index)=>[item.id,index]));
    if(selected.items.some((item,index)=>positions.has(item.id)&&positions.get(item.id)!==p.start+index))return mappingFailure('provider.content.albums.duplicate-ids');
    const after=await read(0,100);if(after.total!==anchor.total||canonical(after.items)!==canonical(anchor.items))return mappingFailure('provider.content.albums.anchor-changed');
    return{items:selected.items,revision,next:p.next};
  }
  async function directory(scope: MobileNeteaseScope, rawQuery: MobileDirectoryQuery, signal: AbortSignal): Promise<MobileDirectoryPage> {
    const query = captureMobileDirectoryQuery(rawQuery);
    async function read(offset: number, limit: number): Promise<{ rows: MobileRecord[]; total: number }> {
      if (query.artistId !== null && query.kind !== 'albums') {
        const body = await api(scope, { operation: query.kind === 'artists' ? 'artist-profile' : 'artist-songs', id: query.artistId }, signal);
        if (!mobileRecord(body.artist) || providerId(body.artist.id) !== query.artistId) return changed();
        const all = query.kind === 'artists' ? [body.artist] : rows(body.hotSongs, MAX_COLLECTION_TRACKS);
        return { rows: all.slice(offset, offset + limit), total: all.length };
      }
      const body = await api(scope, query.artistId !== null
        ? { operation: 'artist-albums', id: query.artistId, offset, limit }
        : { operation: 'directory-search', kind: query.kind, query: query.query, offset, limit }, signal);
      const result = query.artistId !== null ? body : record(body.result);
      if (query.artistId !== null && (!mobileRecord(body.artist) || providerId(body.artist.id) !== query.artistId)) return changed();
      const count = query.artistId !== null ? record(body.artist).albumSize
        : result[query.kind === 'tracks' ? 'songCount' : query.kind === 'albums' ? 'albumCount' : 'artistCount'];
      const rawItems = result[query.artistId !== null ? 'hotAlbums' : query.kind === 'tracks' ? 'songs' : query.kind];
      const list = count === 0 && rawItems === undefined ? [] : rows(rawItems, 100);
      if (!mobileInteger(count, 0, 300000) || offset > count || list.length !== Math.min(limit, count - offset)) return changed();
      if (new Set(list.map(value => providerId(value.id))).size !== list.length) return changed();
      return { rows: list, total: count };
    }
    // 有限首屏作为上游无快照接口的稳定锚；翻页时重核，变化明确返回 SOURCE_CHANGED。
    const anchor = await read(0, 100);
    const revision = 'nr:' + digest('NETEASE_DIRECTORY', [scope.accountDomain, scope.providerEpoch, query.kind, query.query, query.artistId, anchor]);
    if (query.expectedRevision !== null && query.expectedRevision !== revision) return changed();
    const selected = query.offset + query.limit <= 100 || anchor.total <= 100
      ? { rows: anchor.rows.slice(query.offset, query.offset + query.limit), total: anchor.total } : await read(query.offset, query.limit);
    if (query.offset > anchor.total || selected.total !== anchor.total) return changed();
    const anchorPositions = new Map(anchor.rows.map((row, index) => [providerId(row.id), index]));
    if (selected.rows.some((row, index) => anchorPositions.has(providerId(row.id)) && anchorPositions.get(providerId(row.id)) !== query.offset + index)) return changed();
    let items: MobileDirectoryPage['items'];
    if (query.kind === 'tracks') items = await pageTracks(scope, selected.rows.map(value => providerId(value.id)), signal);
    else if (query.kind === 'albums') items = selected.rows.map(value => {
      const { year: _year, ...album } = albumRecord(scope, value); return album;
    });
    else items = selected.rows.map(value => {
      const artistId = providerId(value.id);
      const artworkId = artwork.bind(scope, 'r', artistId, artworkFrom(value));
      const biography = typeof value.briefDesc === 'string' ? value.briefDesc.slice(0, 20000) : '';
      const artist: MobileDirectoryArtist = { id: artistId, name: text(value.name), source: 'netease',
        albumCount: mobileInteger(value.albumSize) ? value.albumSize : 0,
        trackCount: mobileInteger(value.musicSize) ? value.musicSize : 0,
        ...(artworkId ? { artworkId } : {}), biography, credit: '人物资料来自网易云' };
      return artist;
    });
    if (query.offset !== 0) {
      const after = await read(0, 100); if (canonical(after) !== canonical(anchor)) return changed();
    }
    await current(scope, 'acquire', signal, false);
    return captureMobileDirectoryPage({ kind: query.kind, items, offset: query.offset, limit: query.limit,
      total: anchor.total, revision, nextOffset: query.offset + items.length < anchor.total ? query.offset + items.length : null }, query);
  }
  function context(scope:MobileNeteaseScope,revision:string,extras:Partial<MobileContentReadContext>={}):MobileContentReadContext{
    return{serverId,deviceId:scope.deviceId,accountDomain:scope.accountDomain,source:'netease',revision,...extras};
  }
  const provider:MobileNeteaseContentProviderPort={async read(input){
    return run(input.scope,input.signal,async(scope,signal):Promise<MobileNeteaseContentProviderFacts>=>{
      const request=captureMobileContentRequest(input.operation,input.request);let body:unknown,ctx:MobileContentReadContext,nextOffset:number|null=null;
      if(!mobileInteger(input.offset)||!mobileInteger(input.limit,1,100)||input.expectedRevision!==null&&!mobileNeteaseId(input.expectedRevision))return invalid();
      switch(input.operation){
        case 'getNeteaseLikedPlaylist':case 'listNeteaseLikedPlaylistTracks':{
          const collection=await liked(scope,signal,input.operation==='listNeteaseLikedPlaylistTracks'?String(request.query.playlistId):undefined),c=collection.collection;
          noteCollection(collection,input.expectedRevision,input.offset);
          if(input.operation==='listNeteaseLikedPlaylistTracks'&&request.query.playlistId!==c.id)return changed();
          if(input.expectedRevision!==null&&input.expectedRevision!==collection.revision)return mappingSync('provider.content.mapping.revision-mismatch',changed);
          if(input.operation==='getNeteaseLikedPlaylist'){body={source:'netease',playlistId:c.id,accountDomain:scope.accountDomain,playlistRevision:collection.revision,title:c.title,trackCount:c.trackCount,...(c.artworkId===null?{}:{artworkId:c.artworkId})};ctx=context(scope,collection.revision,{playlistId:c.id});}
          else{const p=page(input,collection.ids.length),items=await pageTracks(scope,collection.ids.slice(p.start,p.end),signal);nextOffset=p.next;
            body={source:'netease',playlistId:c.id,accountDomain:scope.accountDomain,playlistRevision:collection.revision,trackCount:c.trackCount,items,nextCursor:null};ctx=context(scope,collection.revision,{playlistId:c.id,limit:input.limit,pageOffset:input.offset});}
          break;
        }
        case 'getNeteaseDiscoveryCollectionTracks':{
          const kind=request.query.kind;if(kind!=='playlist'&&kind!=='chart')return invalid();
          const collectionId=request.pathParameters.collectionId!;
          const collection=await collectionState(scope,collectionId,kind,signal),p=page(input,collection.ids.length),items=await pageTracks(scope,collection.ids.slice(p.start,p.end),signal);nextOffset=p.next;
          body={accountDomain:scope.accountDomain,collection:collection.collection,items,nextCursor:null};ctx=context(scope,collection.revision,{collectionId,kind,collection:collection.collection,limit:input.limit,pageOffset:input.offset});break;
        }
        case 'listNeteaseRecommendedPlaylists':case 'listNeteaseCharts':{
          const kind=input.operation==='listNeteaseCharts'?'chart':'playlist';
          const upstream=await api(scope,kind==='chart'?{operation:'charts'}:{operation:'recommended-playlists',limit:RECOMMENDED_CANDIDATES},signal);
          const ids=providerSync('mapping',()=>{const feed=rows(kind==='chart'?upstream.list:upstream.result,kind==='chart'?100:RECOMMENDED_CANDIDATES),values=feed.map(v=>id(kind==='chart'?'nch':'np',v.id));if(new Set(values).size!==values.length)return changed();return values;});
          // 本批推荐固定最多10候选；超量拒绝，完整资格化后供容量10单页或更小容量严格分页。
          const rejected:{first?:MobileRecord}={};
          const qualified=kind==='playlist'?(await mapTwo(ids,publicId=>recommendedCollection(scope,publicId,signal,
            body=>{if(publicId===ids[0])rejected.first=body;})))
            .filter((value):value is CollectionState=>value!==null):null;
          if(qualified!==null&&ids.length>0&&qualified.length===0){
            // 非空feed全部失格时，用同次第一项原详情保留原严格错误及闭集首因，不重读API。
            if(rejected.first)await collectionState(scope,ids[0]!,'playlist',signal,rejected.first);
            return changed();
          }
          const revision='nr:'+digest('NETEASE_COLLECTION_FEED',qualified===null?[kind,ids]:[kind,RECOMMENDED_POLICY,RECOMMENDED_CANDIDATES,qualified.map(value=>value.collection)]);
          if(input.expectedRevision!==null&&input.expectedRevision!==revision)return changed();
          const p=page(input,qualified?.length??ids.length);nextOffset=p.next;
          const selected=qualified===null?await mapTwo(ids.slice(p.start,p.end),publicId=>collectionState(scope,publicId,kind,signal)):qualified.slice(p.start,p.end);
          body={accountDomain:scope.accountDomain,feedRevision:revision,items:selected.map(v=>v.collection),nextCursor:null};ctx=context(scope,revision,{limit:input.limit,pageOffset:input.offset});break;
        }
        case 'listNeteaseNewAlbums':{
          const selected=await newAlbums(scope,input,signal);nextOffset=selected.next;
          body={accountDomain:scope.accountDomain,feedRevision:selected.revision,items:selected.items,nextCursor:null};ctx=context(scope,selected.revision,{limit:input.limit,pageOffset:input.offset});break;
        }
        case 'getNeteaseDailyRecommendations':case 'getNeteasePersonalFM':{
          if(input.offset!==0)return invalid();const isDaily=input.operation==='getNeteaseDailyRecommendations';
          const upstream=await api(scope,{operation:isDaily?'daily':'personal-fm'},signal);
          const raw=isDaily?(mobileRecord(upstream.data)?upstream.data.dailySongs:undefined):upstream.data;
          const ids=providerSync('mapping',()=>{const list=rows(raw,100),values=list.map(v=>providerId(v.id));if(new Set(values).size!==values.length)return changed();return values;});
          const items=await directorySongs(scope,await songs(scope,ids,signal),signal);
          if(isDaily){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(clock()));
            const part=(name:string)=>parts.find(p=>p.type===name)?.value??busy(),date=`${part('year')}-${part('month')}-${part('day')}`;
            const revision='nr:'+digest('NETEASE_DAILY',[scope.accountDomain,date,items]);body={source:'netease',recommendationDate:date,timeZone:'Asia/Shanghai',feedRevision:revision,items};ctx=context(scope,revision);}
          else{const revision='nr:'+digest('NETEASE_FM',[scope.accountDomain,scope.providerEpoch,items]);body={accountDomain:scope.accountDomain,batchRevision:revision,items};ctx=context(scope,revision);}break;
        }
      }
      if(input.expectedRevision!==null&&ctx.revision!==input.expectedRevision)return mappingSync('provider.content.mapping.revision-mismatch',changed);
      // 独立 provider 也使用实际原 request+scope+可信 context，不等待后来的门面补校验。
      // 私有端口的 continuation 是精确 offset；真实公开 cursor 仍只由 ProviderService 签发。
      // count 校验须在“确实有后页”的视图执行，内部验证 token 不进入返回正文。
      const validationBody=nextOffset!==null?{...record(body),nextCursor:'private:'+digest('NETEASE_CONTINUATION',[scope.accountDomain,input.operation,ctx.revision,nextOffset])}:body;
      const checked=providerSync('mapping',()=>mappingSync('provider.content.mapping.reply-dto',()=>captureMobileContentReply(input.operation,request,scope,{status:200,category:'success',body:validationBody},ctx)));
      const outgoing=nextOffset!==null?{...record(checked.reply.body),nextCursor:null}:checked.reply.body;
      return{account:cachedAccount!.value,body:outgoing,context:checked.context,nextOffset};
    });
  }};
  async function resolveLyrics(scope:MobileNeteaseScope,selectionRaw:MobileTrackSelection,signal:AbortSignal):Promise<ActualMobileNeteaseLyrics>{
    const selection=captureMobileNeteaseSelection(selectionRaw);await exactTrack(scope,selection,signal);
    const raw=await api(scope,{operation:'lyrics',id:originalId('nt',selection.trackId)},signal);
    const inner=mobileRecord(raw.data)?raw.data:raw;const fields=['lrc','yrc','tlyric','romalrc','yromalrc'] as const;
    const sources:Partial<Record<typeof fields[number],string>>={};let sourceBytes=0;
    for(const field of fields){const value=inner[field]??raw[field];
      if(value!==undefined&&(!mobileRecord(value)||value.lyric!==undefined&&typeof value.lyric!=='string'))return busy();
      if(mobileRecord(value)&&typeof value.lyric==='string'){sources[field]=value.lyric;sourceBytes+=mobileUtf8Bytes(value.lyric);}}
    if(sourceBytes>LYRIC_BODY_BYTES)return busy();
    const lrcLines=sources.lrc?.trim()?completeLrc(sources.lrc):[],yrcLines=sources.yrc?.trim()?completeYrc(sources.yrc):[];
    const translation=sources.tlyric?.trim()?completeLrc(sources.tlyric):[];
    // Romanization 是另一完整可选表示；不能以预算为由静默截尾或跳坏行。
    for(const field of ['romalrc','yromalrc'] as const)if(sources[field]?.trim())completeLrc(sources[field]!);
    const lines=lrcLines.length?lrcLines:yrcLines;
    const identity={trackId:selection.trackId,source:'netease' as const,versionId:selection.versionId,contentRevision:selection.contentRevision};let body:MobileLyricsContent;
    const instrumental=['pureMusic','instrumental','nolyric'].some(field=>[true,1,'1'].includes(inner[field] as true|1|'1')||[true,1,'1'].includes(raw[field] as true|1|'1'));
    if(lines.length){
      if(instrumental)return busy();const synchronized=lines.every(line=>line.startMs!==null);
      if(translation.length){if(translation.some(line=>line.startMs===null)||!synchronized)return busy();
        const side=new Map<number,string>();for(const line of translation){const time=line.startMs!;if(side.has(time)||!lines.some(v=>v.startMs===time))return busy();side.set(time,line.text);}
        for(const line of lines){const secondaryText=side.get(line.startMs!);if(secondaryText!==undefined)line.secondaryText=secondaryText;}}
      body={...identity,status:'ready',lyricRevision:'nr:'+digest('NETEASE_LYRICS',[selection,raw]),synchronized,
        lines:lines.map((line,index)=>({id:'nl:'+digest('NETEASE_LYRIC_LINE',[selection,index,line]),...line}))};
    }else if(translation.length)return busy();
    else if(instrumental)body={...identity,status:'instrumental',synchronized:false,lines:[]};
    else if(inner.uncollected===true||raw.uncollected===true||sources.lrc===''||sources.yrc==='')body={...identity,status:'missing',synchronized:false,lines:[]};
    else return busy();
    const checked=mobileContentResponseSnapshot('lyrics',body);if(!checked.ok)return busy();
    // 同次查询的完整身份再核，不用当前播放队列或标题猜歌词所属。
    await exactTrack(scope,selection,signal);return{body:checked.value,context:context(scope,selection.contentRevision,{selection})};
  }
  const lyrics:MobileContentPort={async dispatch<O extends MobileContentOperation>(input:MobileContentServiceInput<O>):Promise<MobileContentSnapshot<O>>{
    if(input.operation!=='getExactTrackLyrics')return invalid();const request=captureMobileContentRequest(input.operation,input.request);
    if(request.query.source!=='netease')return invalid();
    const selection=captureMobileNeteaseSelection({trackId:request.pathParameters.trackId,source:request.query.source,versionId:request.query.versionId,contentRevision:request.query.contentRevision});
    const scope=captureMobileNeteaseScope(input.scope),result=await run(scope,input.signal,(s,signal)=>resolveLyrics(s,selection,signal));
    const checked=captureMobileContentReply(input.operation,request,scope,{status:200,category:'success',body:result.body},result.context);
    return{operation:input.operation,scope,reply:checked.reply,context:checked.context,async beforeSend(){await run(scope,input.signal,async(s,signal)=>{await exactTrack(s,selection,signal);});}};
  }};
  const catalog:MobileNeteaseCatalogPort={
    async track(scope,selection,signal){return run(scope,signal,async(s,owned)=>{const entry=await exactTrack(s,selection,owned);return{account:entry.account,track:entry.track as MobileTrack};},'lease');},
    async album(scope,albumId,signal){return run(scope,signal,async(s,owned)=>{const state=await albumState(s,albumId,owned);return{account:cachedAccount!.value,album:state.album as MobileUIAlbumRecord};},'lease',true,true);},
  };
  const streams:MobileNeteaseStreamPort={async open(input,signal){
    const captured=record(input);
    if(Reflect.ownKeys(captured).length!==3||!['scope','resourceId','selection'].every(k=>Object.hasOwn(captured,k))
      ||typeof captured.resourceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/u.test(captured.resourceId))return invalid();
    const capturedScope=captureMobileNeteaseScope(captured.scope),capturedSelection=captureMobileNeteaseSelection(captured.selection);
    let cleanup:(()=>Promise<void>)|null=null;try{return await run(capturedScope,signal,async(scope,owned)=>{
    const selection=capturedSelection,source=await refreshSource(scope,selection,owned);
    const opened=await http.openFromSource(scope,source,selection,owned);cleanup=()=>opened.lease.release();const entry=trackCache.get(cacheKey(scope,originalId('nt',selection.trackId)));
    if(!entry||canonical(entry.observed)!==canonical(opened.observed)){await opened.lease.release();return sourceConsistencyChanged(()=>entry?'provider.source.open.observed':'provider.source.open.cache-missing');}return opened.lease;
  },'lease');}catch(error){if(cleanup){const closeLease=cleanup as ()=>Promise<void>;await closeLease();}throw error;}}};
  return{
    get qualified(){return !closed&&!fatal&&http.qualified&&client.configured;},account,provider,catalog,streams,lyrics,
    readDirectory:(scope,query,signal)=>run(scope,signal,(s,owned)=>directory(s,query,owned)),
    resolveTrackId:(scope,track,signal)=>run(scope,signal,(s,owned)=>directoryTrackId(s,track,owned)),
    readObservedTrack:(scope,track,expected,signal)=>run(scope,signal,async(s,owned)=>{
      const selected=expected===null?null:captureMobileNeteaseSelection(expected);
      if(selected!==null&&selected.trackId!==track)return invalid();
      const entry=selected===null?await trackId(s,track,owned):await exactTrack(s,selected,owned);
      return entry.track;
    },'acquire',true,true),
    resolveSelection:(scope,identity,signal)=>run(scope,signal,async(s,owned)=>{const captured=record(identity);
      if(Reflect.ownKeys(captured).length!==3||!['trackId','versionId','contentRevision'].every(k=>Object.hasOwn(captured,k)))return invalid();
      const selection=captureMobileNeteaseSelection({...captured,source:'netease'}),track=await directoryTrackId(s,selection.trackId,owned);
      if(!mobileTrackSelectionEquals(selection,{trackId:track.id,source:track.source,versionId:track.versionId,contentRevision:track.contentRevision}))return sourceConsistencyChanged(()=>selectionStage('directory',selection,{trackId:track.id,source:track.source,versionId:track.versionId,contentRevision:track.contentRevision}));return selection;}),
    resolveLyrics:(scope,selection,signal)=>run(scope,signal,(s,owned)=>resolveLyrics(s,selection,owned)),
    resolveAlbumTracks:(scope,albumId,input,signal)=>run(scope,signal,async(s,owned)=>{
      const value=record(input);if(Reflect.ownKeys(value).length!==2||!mobileInteger(value.offset)||!mobileInteger(value.limit,1,100))return invalid();
      const pagination={offset:value.offset,limit:value.limit};const state=await albumState(s,albumId,owned),p=page(pagination,state.songs.length);
      const ids=state.songs.slice(p.start,p.end).map(song=>providerId(song.id)),tracks=await pageTracks(s,ids,owned,albumId);
      const after=await albumState(s,albumId,owned);if(after.revision!==state.revision)return changed();
      // 归属和专辑修订均确认后，缺图歌曲复用原专辑封面引用；不重签歌曲图源或改变播放选择。
      const items=tracks.map(track=>!track.artworkId&&state.album.artworkId?freeze({...track,artworkId:state.album.artworkId}):track);
      return freeze({account:cachedAccount!.value,album:state.album,items,offset:pagination.offset,limit:pagination.limit,total:state.songs.length,revision:state.revision,source:'netease' as const});},'acquire',true,true),
    assertAlbumRevision:(scope,albumId,revision,signal)=>run(scope,signal,async(s,owned)=>{if(!mobileNeteaseId(revision)||(await albumState(s,albumId,owned)).revision!==revision)return changed();},'acquire',true,true),
    async assertCurrent(scope,stage,signal){await current(scope,stage,signal);},
    readArtwork:(scope,id,signal)=>run(scope,signal,(s,owned)=>artwork.read(s,id,owned,(kind,item,signal)=>artworkURL(s,kind,item,signal)),'acquire',true),
    assertArtwork:(scope,id,signal)=>run(scope,signal,(s,owned)=>artwork.assert(s,id,owned,(kind,item,signal)=>artworkURL(s,kind,item,signal)),'acquire',true),
    onAccountInvalidated(listener){if(typeof listener!=='function'||callbacks.size>=16)return invalid();callbacks.add(listener);return()=>{callbacks.delete(listener);};},
    close(){
      if(closing)return closing;closed=true;unsubscribe();for(const controller of controllers)controller.abort();
      artwork.close();
      let timer:ReturnType<typeof setTimeout>|undefined;
      const quiet=(async()=>{await http.close();while(pending.size)await Promise.allSettled([...pending]);await client.awaitMobileQuiet();trackCache.clear();collectionBaselines.clear();cachedAccount=null;callbacks.clear();key.fill(0);})();
      const refused=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{fatal=true;reject(new MobileServiceError(503,'BUSY',true,1000));},CLOSE_MS);});
      closing=Promise.race([quiet,refused]).catch(error=>{fatal=true;throw safeError(error);}).finally(()=>{if(timer)clearTimeout(timer);});return closing;
    },
  };
}
