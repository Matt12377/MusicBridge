import { createHmac } from 'node:crypto';
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
import { createMobileNeteaseAccountMapper, captureMobileNeteaseSongSnapshot } from './mobile-source-snapshot.js';
import { createMobileNeteaseHttpStreams, type MobileNeteaseHttpSource } from './mobile-http-stream.js';
import type { NeteaseMobileReadPort, NeteaseMobileReadRequest, NeteaseMobileAccountInvalidation } from './types.js';

const REQUEST_MS = 10_000, CLOSE_MS = 10_000, ACCOUNT_MS = 10_000, TRACKS = 256, CACHE_MS = 30_000;
const MAX_OPERATIONS = 16, MAX_COLLECTION_TRACKS = 10_000, MAX_FEED = 1000;
const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const changed = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
const busy = (): never => { throw new MobileServiceError(503, 'BUSY', true, 1000); };
const unavailable = (): never => { throw new MobileServiceError(403, 'RESOURCE_REVOKED'); };
const freeze = <T>(v: T): T => { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; };
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
function response(raw: unknown): MobileRecord {
  const value = record(raw), code = value.code ?? (mobileRecord(value.data) ? value.data.code : undefined);
  if (code === 301 || code === 302) throw new MobileServiceError(401, 'UNAUTHORIZED');
  if (code !== 200) return busy(); return value;
}
function rows(raw: unknown, max = MAX_FEED): MobileRecord[] {
  if (!Array.isArray(raw) || raw.length > max || !raw.every(mobileRecord)) return busy(); return raw;
}
function safeError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new MobileServiceError(503, 'BUSY', true, 1000);
  if (error instanceof MobileServiceError) return error;
  if (error instanceof BridgeError && ['AUTH_EXPIRED','AUTH_REQUIRED','NETEASE_NOT_CONFIGURED'].includes(error.code)) return new MobileServiceError(401, 'UNAUTHORIZED');
  if (error instanceof BridgeError && ['TRACK_UNAVAILABLE','TRACK_PREVIEW_ONLY'].includes(error.code)) return new MobileServiceError(403, 'RESOURCE_REVOKED');
  return new MobileServiceError(503, 'BUSY', true, 1000);
}

export interface ActualMobileNeteasePortsOptions {
  client: NeteaseMobileReadPort; serverId: string; datasetId: string; ownerEpoch: string;
  identityKey32: Uint8Array; assertCurrent: MobileNeteaseFence; now?: () => number;
  /** 仅受控 transport 测试注入；生产省略时执行原 HTTPS/DNS/redirect 策略。 */
  fetch?: GatewayFetch;
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
  resolveTrackId(scope: MobileNeteaseScope, trackId: string, signal: AbortSignal): Promise<Readonly<MobileTrack>>;
  resolveSelection(scope: MobileNeteaseScope, identity: Readonly<{ trackId: string; versionId: string; contentRevision: string }>, signal: AbortSignal): Promise<Readonly<MobileTrackSelection>>;
  resolveLyrics(scope: MobileNeteaseScope, selection: MobileTrackSelection, signal: AbortSignal): Promise<ActualMobileNeteaseLyrics>;
  resolveAlbumTracks(scope: MobileNeteaseScope, albumId: string, page: Readonly<{ offset: number; limit: number }>, signal: AbortSignal): Promise<ActualMobileNeteaseAlbumPage>;
  assertAlbumRevision(scope: MobileNeteaseScope, albumId: string, revision: string, signal: AbortSignal): Promise<void>;
  assertCurrent(scope: MobileNeteaseScope, stage: 'acquire' | 'lease', signal: AbortSignal): Promise<void>;
  onAccountInvalidated(listener: (event: Readonly<NeteaseMobileAccountInvalidation>) => void): () => void;
  close(): Promise<void>;
}
interface ResolvedMedia { source: Readonly<MobileNeteaseHttpSource>; md5: string }
interface TrackEntry {
  account: Readonly<MobileNeteaseAccount>; track: Readonly<MobileTrack>; observed: Readonly<MobileNeteaseObservedAudio>;
  mediaBase: string; metadata: MobileJsonValue; born: number;
}
interface AlbumState { raw: MobileRecord; album: Readonly<MobileUIAlbumRecord>; songs: MobileRecord[]; revision: string }
interface CollectionState { collection: Readonly<MobileDiscoveryCollectionRecord>; ids: string[]; revision: string }
interface CompleteLyricLine { text: string; startMs: number | null; secondaryText?: string }
const LYRIC_LINES = 2000, LYRIC_TEXT_BYTES = 4096, LYRIC_BODY_BYTES = 2 * 1024 * 1024;
function lyricText(value: string): string {
  if (!value.trim() || mobileUtf8Bytes(value) > LYRIC_TEXT_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return busy();
  return value;
}
/** 本域完整 LRC 视图；旧 fuzzy parser 的裁剪、跳坏行和去重不进入手机合同。 */
function completeLrc(source: string): CompleteLyricLine[] {
  if (mobileUtf8Bytes(source) > LYRIC_BODY_BYTES || /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(source)) return busy();
  const parsed: CompleteLyricLine[] = []; let offset = 0, hasOffset = false;
  for (const raw of source.split(/\r?\n/u)) {
    if (!raw.trim()) continue;
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
    if (times.length === 0) {
      // 损坏的时间戳不能被降级成无时间文本；完整纯文本正文仍可准确表达。
      if (/^\[[0-9]+[:.,]/u.test(raw)) return busy();
      parsed.push({ text: lyricText(raw), startMs: null });
    } else {
      const lineText = lyricText(raw.slice(at));
      for (const startMs of times) parsed.push({ text: lineText, startMs });
    }
    if (parsed.length > LYRIC_LINES) return busy();
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
  let closed = false, fatal = false, closing: Promise<void> | null = null, accountGeneration = 0;
  const clock = (): number => { const v = now(); return mobileInteger(v) ? v : busy(); };
  const ready = (): void => { if (closed || fatal) return busy(); };
  async function actualAccount(signal: AbortSignal): Promise<Readonly<MobileNeteaseAccount> | null> {
    ready(); signal.throwIfAborted(); if (!client.configured) return null;
    if (cachedAccount && clock() - cachedAccount.born < ACCOUNT_MS) return cachedAccount.value;
    const generation = accountGeneration;
    const actual = await client.mobileAccount({signal,timeoutMs:REQUEST_MS,priority:'playback'});
    signal.throwIfAborted(); ready(); if (generation !== accountGeneration) return changed();
    const value = accountMapper.capture(actual.accountId, actual.providerEpoch);
    if (cachedAccount && canonical(cachedAccount.value) !== canonical(value)) {
      // 同 Cookie 的上游账户事实也不得静默替换已有 lease 的绑定。
      trackCache.clear(); http.invalidateAccount();
    }
    cachedAccount = { value, accountId: providerId(actual.accountId), born: clock() }; return value;
  }
  async function current(scopeRaw: MobileNeteaseScope, stage: 'acquire' | 'lease', signal: AbortSignal, queryAccount = true): Promise<MobileNeteaseScope> {
    const scope = captureMobileNeteaseScope(scopeRaw);
    if (scope.serverId !== serverId || scope.datasetId !== datasetId || scope.ownerEpoch !== ownerEpoch) return changed();
    const effectiveStage = stages.get(signal) ?? stage;
    ready(); signal.throwIfAborted(); await fence(scope, effectiveStage); signal.throwIfAborted(); ready();
    const account = queryAccount ? await actualAccount(signal) : cachedAccount?.value ?? null;
    assertMobileNeteaseAccount(scope, account); if (!client.configured) throw new MobileServiceError(401, 'UNAUTHORIZED');
    await fence(scope, effectiveStage); signal.throwIfAborted(); ready(); return scope;
  }
  async function api(scope: MobileNeteaseScope, request: NeteaseMobileReadRequest, signal: AbortSignal): Promise<MobileRecord> {
    await current(scope, 'acquire', signal);
    const raw = await client.mobileRead(request,{signal,timeoutMs:REQUEST_MS,priority:request.operation==='stream'?'playback':'background'});
    await current(scope, 'acquire', signal, false); if (raw.providerEpoch !== scope.providerEpoch) return changed();
    return response(raw.response);
  }
  async function run<T>(scopeRaw: MobileNeteaseScope, signal: AbortSignal, operation: (scope: MobileNeteaseScope, owned: AbortSignal) => Promise<T>, stage: 'acquire' | 'lease' = 'acquire'): Promise<T> {
    ready(); const scope = captureMobileNeteaseScope(scopeRaw); if (pending.size >= MAX_OPERATIONS) return busy();
    const controller = new AbortController(), abort = () => controller.abort();
    stages.set(controller.signal, stage);
    controllers.add(controller); signal.addEventListener('abort', abort, {once:true}); if (signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refusal = new Promise<never>((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new MobileServiceError(503,'BUSY',true,1000)); },REQUEST_MS); });
    const work = (async () => { const captured = await current(scope, 'acquire', controller.signal); const value = await operation(captured,controller.signal);
      await current(captured,'acquire',controller.signal,false); return value; })();
    pending.add(work); void work.finally(() => { pending.delete(work); controllers.delete(controller); signal.removeEventListener('abort',abort); if(timer)clearTimeout(timer); }).catch(() => undefined);
    try { return await Promise.race([work,refusal]); } catch(error) { controller.abort(); throw safeError(error,signal); }
  }
  const cacheKey = (scope: MobileNeteaseScope, rawId: string) => canonical([scope.accountDomain,scope.providerEpoch,rawId]);
  function remember(scope: MobileNeteaseScope, rawId: string, entry: TrackEntry): void {
    const k = cacheKey(scope,rawId); trackCache.delete(k);
    if (trackCache.size >= TRACKS) trackCache.delete(trackCache.keys().next().value!); trackCache.set(k,entry);
  }
  async function media(scope: MobileNeteaseScope, rawId: string, signal: AbortSignal): Promise<ResolvedMedia> {
    const raw = await api(scope,{operation:'stream',id:rawId,quality:'hires'},signal), values = rows(raw.data,100);
    const matching = values.filter(v => providerId(v.id) === rawId); if (matching.length !== 1) return changed();
    const row = matching[0]!;
    if (row.freeTrialInfo !== null && row.freeTrialInfo !== undefined || row.code !== undefined && row.code !== 200) return unavailable();
    if (typeof row.md5 !== 'string' || !/^[a-fA-F0-9]{32}(?![\s\S])/u.test(row.md5)
      || !mobileInteger(row.size,4) || !mobileInteger(row.expi,1,604800)) return busy();
    const resolved = parseResolvedAudioStream(raw,rawId,'hires');
    const md5 = row.md5.toLowerCase(), sourceIdentity = 'ns:'+digest('NETEASE_MEDIA',[rawId,md5,row.size]);
    return {md5,source:freeze({account:cachedAccount!.value,sourceIdentity,size:row.size,
      expiresAtMs:clock()+Math.min(row.expi*1000,300000),upstreamUrl:resolved.upstreamUrl,requestHeaders:{...resolved.requestHeaders}})};
  }
  function songMaterial(song: MobileRecord): MobileJsonValue {
    const sourceId = providerId(song.id); if (!mobileRecord(song.al)) return changed();
    const album = song.al, albumId = providerId(album.id);
    if (!Array.isArray(song.ar) || song.ar.length === 0 || song.ar.length > 32 || !mobileInteger(song.dt,1)) return changed();
    const artists = song.ar.map(a => { if (!mobileRecord(a)) return changed(); return {id:a.id===undefined?null:providerId(a.id),name:text(a.name)}; });
    const editionLabel = Array.isArray(song.alia) && song.alia.length > 0 ? text(song.alia[0],true) : '';
    return {id:sourceId,name:text(song.name),ar:artists,al:{id:albumId,name:text(album.name)},dt:song.dt,editionLabel};
  }
  async function songs(scope: MobileNeteaseScope, ids: string[], signal: AbortSignal): Promise<MobileRecord[]> {
    if (ids.length === 0) return [];
    if (ids.length > 100 || new Set(ids).size !== ids.length) return changed();
    const result = await api(scope,{operation:'song-detail',ids},signal), values = rows(result.songs,100);
    const byId = new Map<string,MobileRecord>(); for(const value of values){const rawId=providerId(value.id);if(byId.has(rawId)||!ids.includes(rawId))return changed();byId.set(rawId,value);}
    if(byId.size!==ids.length)return unavailable();return ids.map(rawId=>byId.get(rawId)!);
  }
  async function observeSong(scope: MobileNeteaseScope, song: MobileRecord, signal: AbortSignal): Promise<TrackEntry> {
    const metadata = songMaterial(song), rawId = providerId(song.id), stream = await media(scope,rawId,signal);
    const observed = await http.probe(scope,stream.source,signal); await current(scope,'acquire',signal,false);
    const versionId = 'nv:'+digest('NETEASE_VERSION',[rawId,stream.md5,stream.source.size,observed.audio,observed.headerSha256]);
    const contentRevision = 'nr:'+digest('NETEASE_TRACK',[versionId,metadata]);
    const selection:MobileTrackSelection={trackId:id('nt',rawId),source:'netease',versionId,contentRevision};
    const album = song.al as MobileRecord, material = metadata as MobileRecord;
    const facts = captureMobileNeteaseSongSnapshot(song,{account:stream.source.account,selection,sourceItemId:rawId,
      albumId:id('na',album.id),providerAlbumId:providerId(album.id),editionLabel:text(material.editionLabel,true),observed,availability:'available'});
    const checked = mobileCatalogResponseSnapshot('track',facts.track); if(!checked.ok)return busy();
    const entry:TrackEntry={account:stream.source.account,track:freeze(checked.value),observed,mediaBase:stream.source.sourceIdentity,metadata,born:clock()};
    remember(scope,rawId,entry);return entry;
  }
  async function mapTwo<T,R>(items: readonly T[], action: (value:T)=>Promise<R>): Promise<R[]> {
    const output = new Array<R>(items.length); let at=0;
    await Promise.all(Array.from({length:Math.min(2,items.length)},async()=>{while(at<items.length){const index=at++;output[index]=await action(items[index]!);}}));return output;
  }
  async function trackId(scope: MobileNeteaseScope, publicId: string, signal: AbortSignal): Promise<TrackEntry> {
    const rawId = originalId('nt',publicId), values = await songs(scope,[rawId],signal);return observeSong(scope,values[0]!,signal);
  }
  async function exactTrack(scope: MobileNeteaseScope, selectionRaw: MobileTrackSelection, signal: AbortSignal): Promise<TrackEntry> {
    const selection = captureMobileNeteaseSelection(selectionRaw), entry = await trackId(scope,selection.trackId,signal);
    if(!mobileTrackSelectionEquals(selection,{trackId:entry.track.id,source:entry.track.source,versionId:entry.track.versionId,contentRevision:entry.track.contentRevision}))return changed();return entry;
  }
  async function refreshSource(scope: MobileNeteaseScope, selection: Readonly<MobileTrackSelection>, signal: AbortSignal): Promise<MobileNeteaseHttpSource> {
    const rawId = originalId('nt',selection.trackId); let entry=trackCache.get(cacheKey(scope,rawId));
    if(!entry||clock()-entry.born>=CACHE_MS||entry.track.versionId!==selection.versionId||entry.track.contentRevision!==selection.contentRevision)entry=await exactTrack(scope,selection,signal);
    const [detail,stream]=await Promise.all([songs(scope,[rawId],signal),media(scope,rawId,signal)]);
    if(canonical(songMaterial(detail[0]!))!==canonical(entry.metadata)||stream.source.sourceIdentity!==entry.mediaBase)return changed();
    return stream.source;
  }
  const http = createMobileNeteaseHttpStreams({assertCurrent:async(scope,stage)=>{await current(scope,stage,new AbortController().signal,false);},
    refresh:(scope,selection,signal)=>run(scope,signal,(s,owned)=>refreshSource(s,selection,owned),'lease'),now,...(options.fetch?{fetch:options.fetch}:{})});
  const unsubscribe=client.onMobileAccountInvalidated(event=>{accountGeneration++;cachedAccount=null;trackCache.clear();http.invalidateAccount();
    for(const c of controllers)c.abort();for(const listener of callbacks){try{listener(event);}catch{/* 观察者不能阻断实际撤销。 */}}});
  const account:MobileNeteaseAccountPort={async current(signal){try{return await actualAccount(signal);}catch(error){throw safeError(error,signal);}}};
  function albumRecord(raw: MobileRecord, songsRaw?: readonly MobileRecord[]): Readonly<MobileUIAlbumRecord> {
    const albumId=providerId(raw.id), names=Array.isArray(raw.artists)?rows(raw.artists,32):mobileRecord(raw.artist)?[raw.artist]:null;
    if(!names||names.length===0)return changed();const artists=names.map(a=>text(a.name));
    const count=raw.size??raw.trackCount;if(!mobileInteger(count,0,MAX_COLLECTION_TRACKS)||songsRaw&&count!==songsRaw.length)return changed();
    const album:MobileUIAlbumRecord={id:id('na',albumId),source:'netease',title:text(raw.name),artists,editionLabel:typeof raw.type==='string'?text(raw.type,true):'',trackCount:count};
    if(mobileInteger(raw.publishTime,1)){const year=new Date(raw.publishTime).getUTCFullYear();if(mobileInteger(year,0,9999))album.year=year;}
    const result=mobileContentResponseSnapshot('uiAlbum',album);return result.ok?freeze(result.value):busy();
  }
  async function albumState(scope: MobileNeteaseScope, albumId: string, signal: AbortSignal): Promise<AlbumState> {
    const rawId=originalId('na',albumId), body=await api(scope,{operation:'album',id:rawId},signal);
    if(!mobileRecord(body.album)||providerId(body.album.id)!==rawId)return changed();const raw=body.album, values=rows(body.songs,MAX_COLLECTION_TRACKS);
    const seen=new Set<string>();for(const song of values){const rawSongId=providerId(song.id);if(seen.has(rawSongId)||!mobileRecord(song.al)||providerId(song.al.id)!==rawId)return changed();seen.add(rawSongId);songMaterial(song);}
    const album=albumRecord(raw,values),revision='nr:'+digest('NETEASE_ALBUM',[album,values.map(songMaterial)]);return{raw,album,songs:values,revision};
  }
  async function collectionState(scope: MobileNeteaseScope, publicId: string, kind: 'playlist'|'chart', signal: AbortSignal): Promise<CollectionState> {
    const rawId=originalId(kind==='chart'?'nch':'np',publicId), body=await api(scope,{operation:'playlist-detail',id:rawId},signal);
    if(!mobileRecord(body.playlist)||providerId(body.playlist.id)!==rawId)return changed();const p=body.playlist;
    const trackIds=rows(p.trackIds,MAX_COLLECTION_TRACKS).map(v=>providerId(v.id));
    if(new Set(trackIds).size!==trackIds.length||!mobileInteger(p.trackCount,0,MAX_COLLECTION_TRACKS)||p.trackCount!==trackIds.length)return changed();
    const material={id:rawId,name:text(p.name),trackCount:p.trackCount,updateTime:p.updateTime??null,ids:trackIds};
    const revision='nr:'+digest('NETEASE_COLLECTION',material),collection:MobileDiscoveryCollectionRecord={id:publicId,kind,title:text(p.name),artworkId:null,trackCount:p.trackCount,collectionRevision:revision};
    return{collection:freeze(collection),ids:trackIds,revision};
  }
  async function liked(scope: MobileNeteaseScope, signal: AbortSignal): Promise<CollectionState> {
    await actualAccount(signal);const accountId=cachedAccount!.accountId;
    for(let offset=0;offset<1000;offset+=100){const body=await api(scope,{operation:'user-playlists',userId:accountId,offset,limit:100},signal),list=rows(body.playlist,100);
      const candidates=list.filter(p=>p.specialType===10);if(candidates.length>1)return changed();
      if(candidates.length===1){const candidate=candidates[0]!;if(mobileRecord(candidate.creator)&&providerId(candidate.creator.userId)!==accountId)return changed();return collectionState(scope,id('np',candidate.id),'playlist',signal);}
      if(body.more===false)return unavailable();if(body.more!==true||list.length!==100)return busy();
    }return busy();
  }
  async function pageTracks(scope:MobileNeteaseScope,ids:string[],signal:AbortSignal,albumId?:string):Promise<MobileTrack[]>{
    const raw=await songs(scope,ids,signal),entries=await mapTwo(raw,song=>observeSong(scope,song,signal));
    const tracks=entries.map(entry=>entry.track as MobileTrack);if(albumId&&tracks.some(track=>track.albumId!==albumId))return changed();return tracks;
  }
  function page(input: {offset:number;limit:number},total:number): {start:number;end:number;next:number|null} {
    if(!mobileInteger(input.offset,0,total)||!mobileInteger(input.limit,1,100))return invalid();const end=Math.min(total,input.offset+input.limit);
    return{start:input.offset,end,next:end<total?end:null};
  }
  async function newAlbums(scope:MobileNeteaseScope,signal:AbortSignal):Promise<MobileUIAlbumRecord[]>{
    const out:MobileUIAlbumRecord[]=[],seen=new Set<string>();let total:number|null=null,first:string|null=null;
    do{const body=await api(scope,{operation:'new-albums',offset:out.length,limit:100},signal),list=rows(body.albums,100);
      if(!mobileInteger(body.total,0,MAX_FEED)||total!==null&&body.total!==total)return changed();total=body.total;
      if(out.length===0)first=canonical(list);
      if(list.length!==Math.min(100,total-out.length))return changed();
      for(const raw of list){const album=albumRecord(raw);if(seen.has(album.id))return changed();seen.add(album.id);out.push(album);}
    }while(out.length<total);
    if(out.length>100){const again=await api(scope,{operation:'new-albums',offset:0,limit:100},signal);if(again.total!==total||canonical(rows(again.albums,100))!==first)return changed();}
    return out;
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
          const collection=await liked(scope,signal),c=collection.collection;
          if(input.operation==='listNeteaseLikedPlaylistTracks'&&request.query.playlistId!==c.id)return changed();
          if(input.operation==='getNeteaseLikedPlaylist'){body={source:'netease',playlistId:c.id,accountDomain:scope.accountDomain,playlistRevision:collection.revision,title:c.title,trackCount:c.trackCount};ctx=context(scope,collection.revision,{playlistId:c.id});}
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
          const upstream=await api(scope,kind==='chart'?{operation:'charts'}:{operation:'recommended-playlists',limit:100},signal);
          const feed=rows(kind==='chart'?upstream.list:upstream.result,100),ids=feed.map(v=>id(kind==='chart'?'nch':'np',v.id));if(new Set(ids).size!==ids.length)return changed();
          const all=await mapTwo(ids,publicId=>collectionState(scope,publicId,kind,signal)),revision='nr:'+digest('NETEASE_COLLECTION_FEED',[kind,all.map(v=>v.collection)]),p=page(input,all.length);nextOffset=p.next;
          body={accountDomain:scope.accountDomain,feedRevision:revision,items:all.slice(p.start,p.end).map(v=>v.collection),nextCursor:null};ctx=context(scope,revision,{limit:input.limit,pageOffset:input.offset});break;
        }
        case 'listNeteaseNewAlbums':{
          const all=await newAlbums(scope,signal),revision='nr:'+digest('NETEASE_ALBUM_FEED',all),p=page(input,all.length);nextOffset=p.next;
          body={accountDomain:scope.accountDomain,feedRevision:revision,items:all.slice(p.start,p.end),nextCursor:null};ctx=context(scope,revision,{limit:input.limit,pageOffset:input.offset});break;
        }
        case 'getNeteaseDailyRecommendations':case 'getNeteasePersonalFM':{
          if(input.offset!==0)return invalid();const isDaily=input.operation==='getNeteaseDailyRecommendations';
          const upstream=await api(scope,{operation:isDaily?'daily':'personal-fm'},signal);
          const raw=isDaily?(mobileRecord(upstream.data)?upstream.data.dailySongs:undefined):upstream.data;
          const list=rows(raw,100),ids=list.map(v=>providerId(v.id));if(new Set(ids).size!==ids.length)return changed();
          const details=await songs(scope,ids,signal),entries=await mapTwo(details,song=>observeSong(scope,song,signal)),items=entries.map(e=>e.track);
          if(isDaily){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(clock()));
            const part=(name:string)=>parts.find(p=>p.type===name)?.value??busy(),date=`${part('year')}-${part('month')}-${part('day')}`;
            const revision='nr:'+digest('NETEASE_DAILY',[scope.accountDomain,date,items]);body={source:'netease',recommendationDate:date,timeZone:'Asia/Shanghai',feedRevision:revision,items};ctx=context(scope,revision);}
          else{const revision='nr:'+digest('NETEASE_FM',[scope.accountDomain,scope.providerEpoch,items]);body={accountDomain:scope.accountDomain,batchRevision:revision,items};ctx=context(scope,revision);}break;
        }
      }
      if(input.expectedRevision!==null&&ctx.revision!==input.expectedRevision)return changed();
      // 独立 provider 也使用实际原 request+scope+可信 context，不等待后来的门面补校验。
      // 私有端口的 continuation 是精确 offset；真实公开 cursor 仍只由 ProviderService 签发。
      // count 校验须在“确实有后页”的视图执行，内部验证 token 不进入返回正文。
      const validationBody=nextOffset!==null?{...record(body),nextCursor:'private:'+digest('NETEASE_CONTINUATION',[scope.accountDomain,input.operation,ctx.revision,nextOffset])}:body;
      const checked=captureMobileContentReply(input.operation,request,scope,{status:200,category:'success',body:validationBody},ctx);
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
    async album(scope,albumId,signal){return run(scope,signal,async(s,owned)=>{const state=await albumState(s,albumId,owned);return{account:cachedAccount!.value,album:state.album as MobileUIAlbumRecord};},'lease');},
  };
  const streams:MobileNeteaseStreamPort={async open(input,signal){
    const captured=record(input);
    if(Reflect.ownKeys(captured).length!==3||!['scope','resourceId','selection'].every(k=>Object.hasOwn(captured,k))
      ||typeof captured.resourceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/u.test(captured.resourceId))return invalid();
    const capturedScope=captureMobileNeteaseScope(captured.scope),capturedSelection=captureMobileNeteaseSelection(captured.selection);
    let cleanup:(()=>Promise<void>)|null=null;try{return await run(capturedScope,signal,async(scope,owned)=>{
    const selection=capturedSelection,source=await refreshSource(scope,selection,owned);
    const opened=await http.openFromSource(scope,source,selection,owned);cleanup=()=>opened.lease.release();const entry=trackCache.get(cacheKey(scope,originalId('nt',selection.trackId)));
    if(!entry||canonical(entry.observed)!==canonical(opened.observed)){await opened.lease.release();return changed();}return opened.lease;
  },'lease');}catch(error){if(cleanup){const closeLease=cleanup as ()=>Promise<void>;await closeLease();}throw error;}}};
  return{
    get qualified(){return !closed&&!fatal&&http.qualified&&client.configured;},account,provider,catalog,streams,lyrics,
    resolveTrackId:(scope,track,signal)=>run(scope,signal,async(s,owned)=>(await trackId(s,track,owned)).track),
    resolveSelection:(scope,identity,signal)=>run(scope,signal,async(s,owned)=>{const captured=record(identity);
      if(Reflect.ownKeys(captured).length!==3||!['trackId','versionId','contentRevision'].every(k=>Object.hasOwn(captured,k)))return invalid();
      const selection=captureMobileNeteaseSelection({...captured,source:'netease'});await exactTrack(s,selection,owned);return selection;}),
    resolveLyrics:(scope,selection,signal)=>run(scope,signal,(s,owned)=>resolveLyrics(s,selection,owned)),
    resolveAlbumTracks:(scope,albumId,input,signal)=>run(scope,signal,async(s,owned)=>{
      const value=record(input);if(Reflect.ownKeys(value).length!==2||!mobileInteger(value.offset)||!mobileInteger(value.limit,1,100))return invalid();
      const pagination={offset:value.offset,limit:value.limit};const state=await albumState(s,albumId,owned),p=page(pagination,state.songs.length);
      const ids=state.songs.slice(p.start,p.end).map(song=>providerId(song.id)),items=await pageTracks(s,ids,owned,albumId);
      const after=await albumState(s,albumId,owned);if(after.revision!==state.revision)return changed();
      return freeze({account:cachedAccount!.value,album:state.album,items,offset:pagination.offset,limit:pagination.limit,total:state.songs.length,revision:state.revision,source:'netease' as const});}),
    assertAlbumRevision:(scope,albumId,revision,signal)=>run(scope,signal,async(s,owned)=>{if(!mobileNeteaseId(revision)||(await albumState(s,albumId,owned)).revision!==revision)return changed();}),
    async assertCurrent(scope,stage,signal){await current(scope,stage,signal);},
    onAccountInvalidated(listener){if(typeof listener!=='function'||callbacks.size>=16)return invalid();callbacks.add(listener);return()=>{callbacks.delete(listener);};},
    close(){
      if(closing)return closing;closed=true;unsubscribe();for(const controller of controllers)controller.abort();
      let timer:ReturnType<typeof setTimeout>|undefined;
      const quiet=(async()=>{await http.close();while(pending.size)await Promise.allSettled([...pending]);await client.awaitMobileQuiet();trackCache.clear();cachedAccount=null;callbacks.clear();key.fill(0);})();
      const refused=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{fatal=true;reject(new MobileServiceError(503,'BUSY',true,1000));},CLOSE_MS);});
      closing=Promise.race([quiet,refused]).catch(error=>{fatal=true;throw safeError(error);}).finally(()=>{if(timer)clearTimeout(timer);});return closing;
    },
  };
}
