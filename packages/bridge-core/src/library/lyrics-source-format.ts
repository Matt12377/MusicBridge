import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isLocalLyricsId } from '@music-bridge/contracts';
import type { DatasetIdentity } from '../recording/dataset-identity.js';
import type { LocalLyricsWriteBinding } from '../collection/local-library-workbench/lyrics-writer.js';
import type { LocalLyricsProtectedWriteResult } from '../collection/local-library-lyrics/types.js';
import { createCueNativeActor, loadBundledCueConverter, type CueNativeClaim } from './bundled-cue-converter.js';
import { createLocalAudioTagsActor, loadLocalAudioTagsBundle } from './local-audio-tags-actor.js';
import type { SourceFileAttributes } from '../collection/source-writes-publisher.js';

/** 有限私有物理账本；正文只引用原歌词intent，不在每次状态变化复制。 */
export const LOCAL_LYRICS_PHYSICAL_OPERATION = 'local-lyrics-physical-v1';
export const LOCAL_LYRICS_PHYSICAL_LIMITS = Object.freeze({
  groupBytes: 32 * 1024 * 1024, resources: 2048, members: 10000, targets: 100,
  sourceBytes: 256 * 1024 * 1024, sourceGroupBytes: 2 * 1024 * 1024 * 1024,
  bodyBytes: 64 * 1024, metadataBytes: 8 * 1024 * 1024,
});
export interface LocalLyricsPhysicalBinding extends LocalLyricsWriteBinding {
  originalIntentSha256: string; originalRequestSha256: string; groupCaptureSha256: string;
  protectionSha256: string; memberCount: number; resourceCount: number; targetCount: number;
}
export interface LocalLyricsPhysicalMember {
  /** rootId=原libraryRootId；sourceRootId=原SourceRootCapability.id；fileId=原assetId。 */
  trackId: string; rootId: string; sourceRootId: string; fileId: string; rootRevision: string; fileRevision: string;
  locationRevision: string; metadataRevision: string; resourceIndex: number;
}
export interface LocalLyricsPhysicalResource {
  rootId: string; relative: string; sha256: string; bytes: number; signature: string; birthtimeNs: string;
  permissionMode: string; uid: string; gid: string; dev: string; ino: string;
}
export interface LocalLyricsPhysicalGroup {
  members: readonly LocalLyricsPhysicalMember[]; resources: readonly LocalLyricsPhysicalResource[];
}
export interface LocalLyricsPhysicalArtifact extends LocalLyricsPhysicalResource {}
export interface LocalLyricsPhysicalGrantFact {
  requestId: string; sequence: number; revision: number; authorityId: string; bindingSha256: string;
  requestSha256: string; nonce: string; validUntilMs: number;
}
export interface LocalLyricsPhysicalFidelity {
  sourceSha256: string; copySha256: string; pcmSha256: string; pcmBytes: number;
  unselectedSha256: string; pictureSha256: string | null; sampleRate: number; channels: number; frames: number;
}
export const LOCAL_LYRICS_PHYSICAL_PHASES = ['PREPARED', 'GRANTED', 'STAGED', 'PUBLISH_INTENT', 'PUBLISHED', 'FACTS_COMMITTED', 'QUIET', 'CLOSED', 'FAILED', 'UNKNOWN'] as const;
export interface LocalLyricsPhysicalRecord {
  schema: 1; operationId: string; binding: LocalLyricsPhysicalBinding; original: LocalLyricsPhysicalGroup;
  revision: number; currentOwnerEpoch: string; phase: typeof LOCAL_LYRICS_PHYSICAL_PHASES[number];
  grant: LocalLyricsPhysicalGrantFact | null;
  artifacts: { stage: LocalLyricsPhysicalArtifact | null; backup: LocalLyricsPhysicalArtifact | null; quarantine: LocalLyricsPhysicalArtifact | null; target: LocalLyricsPhysicalArtifact | null };
  fidelity: LocalLyricsPhysicalFidelity | null; result: LocalLyricsProtectedWriteResult | null;
  physicalClosed: boolean; protectionReleased: boolean; unresolved: boolean;
}
export interface LocalLyricsPhysicalStored { record: LocalLyricsPhysicalRecord; ledgerSequence: number }
/** 必须由已bind的唯一LocalCatalogStore原实例实现；没有备用文件或第二连接。 */
export interface LocalLyricsPhysicalStore {
  privateLyricsPhysicalRead(identity: DatasetIdentity, operationId: string): LocalLyricsPhysicalStored | null;
  privateLyricsPhysicalCompareAndSwap(identity: DatasetIdentity, record: LocalLyricsPhysicalRecord, expectedRevision: number | null): number;
  /** 与源事实/CAS更新同一BEGIN IMMEDIATE提交；Root同时核原intent及原group完整capture。 */
  privateLyricsPhysicalCommitPublication(identity: DatasetIdentity, record: LocalLyricsPhysicalRecord, expectedRevision: number): number;
}
const invalid = (): never => { throw new Error('歌词物理记录或有限端口绑定无效。'); };
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,31})$/u.test(v);
const text = (v: unknown, maximum = 512): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= maximum && !/[\x00-\x1f\x7f]/u.test(v) && Buffer.from(v).toString('utf8') === v;
const integer = (v: unknown, low: number, high: number): v is number => Number.isSafeInteger(v) && Number(v) >= low && Number(v) <= high;
function exact(v: unknown, fields: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || types.isProxy(v) || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const d = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(d).length === fields.length && fields.every(k => !!d[k] && 'value' in d[k]! && d[k]!.enumerable === true);
}
function relative(v: unknown): v is string { return text(v, 4096) && !v.startsWith('/') && !v.includes('\\') && v.split('/').every(p => p !== '' && p !== '.' && p !== '..'); }
/** 独立歌词私有32MiB捕获；不放宽原generic SourceWrites的2MiB/2048输入界。 */
export function captureLyricsPhysicalData(input:unknown,maximum=LOCAL_LYRICS_PHYSICAL_LIMITS.groupBytes):unknown {
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>LOCAL_LYRICS_PHYSICAL_LIMITS.groupBytes)return invalid();
  let nodes=0,bytes=0;const active=new Set<object>();
  const add=(n:number)=>{bytes+=n;if(bytes>maximum)return invalid();};
  const walk=(v:unknown,depth:number):unknown=>{
    if(++nodes>256000||depth>16)return invalid();
    if(v===null||typeof v==='boolean'){add(v===null?4:v?4:5);return v;}
    if(typeof v==='string'){if(v.length>maximum||Buffer.from(v).toString('utf8')!==v)return invalid();add(Buffer.byteLength(JSON.stringify(v)));return v;}
    if(typeof v==='number'){if(!Number.isSafeInteger(v)||Object.is(v,-0))return invalid();add(String(v).length);return v;}
    if(!v||typeof v!=='object'||types.isProxy(v)||active.has(v))return invalid();active.add(v);
    try {
      const d=Object.getOwnPropertyDescriptors(v),own=Reflect.ownKeys(d);
      if(Array.isArray(v)){
        const n=d.length?.value;if(Object.getPrototypeOf(v)!==Array.prototype||!Number.isSafeInteger(n)||n<0||n>10000||own.length!==n+1)return invalid();
        add(2+Math.max(0,n-1));const out:unknown[]=[];for(let i=0;i<n;i++){const p=d[String(i)];if(!p||!('value'in p)||!p.enumerable)return invalid();out.push(walk(p.value,depth+1));}return Object.freeze(out);
      }
      if(![Object.prototype,null].includes(Object.getPrototypeOf(v))||own.length>64||own.some(k=>typeof k!=='string'))return invalid();
      const out:Record<string,unknown>=Object.create(null);add(2+Math.max(0,own.length-1));
      for(const k of own as string[]){if(Buffer.from(k).toString('utf8')!==k)return invalid();const p=d[k];if(!p||!('value'in p)||!p.enumerable)return invalid();add(Buffer.byteLength(JSON.stringify(k))+1);out[k]=walk(p.value,depth+1);}return Object.freeze(out);
    }finally{active.delete(v);}
  };return walk(input,0);
}
export function lyricsPhysicalCanonical(v: unknown): string {
  const captured=captureLyricsPhysicalData(v);const sort=(value:unknown):unknown=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort((value as Record<string,unknown>)[k])])):value;
  return JSON.stringify(sort(captured));
}
export function lyricsPhysicalDigest(v: unknown): string { return createHash('sha256').update(lyricsPhysicalCanonical(v), 'utf8').digest('hex'); }
export function localLyricsPhysicalOperationId(binding: Pick<LocalLyricsWriteBinding, 'datasetId' | 'commandId' | 'trackId' | 'kind'>): string {
  return lyricsPhysicalDigest([binding.datasetId, binding.commandId, binding.trackId, binding.kind]);
}
export function captureLocalLyricsPhysicalBinding(input: unknown): LocalLyricsPhysicalBinding {
  const v = captureLyricsPhysicalData(input,16*1024);
  const strings = ['datasetId', 'ownerEpoch', 'commandId', 'sessionId', 'libraryId', 'albumId', 'captureId', 'trackId', 'candidateId', 'rootRevision', 'fileRevision', 'locationRevision', 'metadataRevision'];
  const hashes = ['intentFingerprint', 'bodySha256', 'originalIntentSha256', 'originalRequestSha256', 'groupCaptureSha256', 'protectionSha256'];
  if (!exact(v, [...strings, ...hashes, 'kind', 'memberCount', 'resourceCount', 'targetCount']) || strings.some(k => !isLocalLyricsId(v[k]))||!hash(v.metadataRevision) || hashes.some(k => !hash(v[k]))
    || !['lrc', 'embed'].includes(String(v.kind)) || !integer(v.memberCount, 1, 10000) || !integer(v.resourceCount, 1, 2048) || !integer(v.targetCount, 1, 100)) return invalid();
  return v as unknown as LocalLyricsPhysicalBinding;
}
function resource(v: unknown): v is LocalLyricsPhysicalResource {
  return exact(v, ['rootId', 'relative', 'sha256', 'bytes', 'signature', 'birthtimeNs', 'permissionMode', 'uid', 'gid', 'dev', 'ino']) && text(v.rootId) && relative(v.relative)
    && hash(v.sha256) && integer(v.bytes, 0, LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes) && text(v.signature, 256)
    && ['birthtimeNs', 'permissionMode', 'uid', 'gid', 'dev', 'ino'].every(k => decimal(v[k]));
}
export function captureLocalLyricsPhysicalGroup(input: unknown): LocalLyricsPhysicalGroup {
  const v = captureLyricsPhysicalData(input);
  if (!exact(v, ['members', 'resources']) || !Array.isArray(v.members) || !integer(v.members.length, 1, 10000)
    || !Array.isArray(v.resources) || !integer(v.resources.length, 1, 2048) || v.resources.some(r => !resource(r) || r.bytes < 1)) return invalid();
  const names = new Set<string>(), physical = new Set<string>(), tracks = new Set<string>(); let bytes = 0;
  for (const r of v.resources as LocalLyricsPhysicalResource[]) { const name = `${r.rootId}\0${r.relative}`, id = `${r.dev}:${r.ino}`;
    if (names.has(name) || physical.has(id)) return invalid(); names.add(name); physical.add(id); bytes += r.bytes;
  }
  if (bytes > LOCAL_LYRICS_PHYSICAL_LIMITS.sourceGroupBytes) return invalid();
  for (const m of v.members) {
    if (!exact(m, ['trackId', 'rootId', 'sourceRootId', 'fileId', 'rootRevision', 'fileRevision', 'locationRevision', 'metadataRevision', 'resourceIndex'])
      || ['trackId', 'rootId', 'sourceRootId', 'fileId', 'rootRevision', 'fileRevision', 'locationRevision', 'metadataRevision'].some(k => !isLocalLyricsId(m[k]))||!hash(m.metadataRevision)
      || !integer(m.resourceIndex, 0, v.resources.length - 1) || tracks.has(m.trackId as string)
      || (v.resources[m.resourceIndex] as LocalLyricsPhysicalResource).rootId !== m.sourceRootId) return invalid();
    tracks.add(m.trackId as string);
  }
  if (new Set(v.members.map(m => (m as LocalLyricsPhysicalMember).resourceIndex)).size !== v.resources.length) return invalid();
  return v as unknown as LocalLyricsPhysicalGroup;
}
export function captureLocalLyricsPhysicalRecord(input: unknown): LocalLyricsPhysicalRecord {
  const v = captureLyricsPhysicalData(input);
  if (!exact(v, ['schema', 'operationId', 'binding', 'original', 'revision', 'currentOwnerEpoch', 'phase', 'grant', 'artifacts', 'fidelity', 'result', 'physicalClosed', 'protectionReleased', 'unresolved'])
    || v.schema !== 1 || !hash(v.operationId) || !integer(v.revision, 1, Number.MAX_SAFE_INTEGER) || !text(v.currentOwnerEpoch)
    || !LOCAL_LYRICS_PHYSICAL_PHASES.includes(v.phase as never) || !['physicalClosed', 'protectionReleased', 'unresolved'].every(k => typeof v[k] === 'boolean')) return invalid();
  const binding = captureLocalLyricsPhysicalBinding(v.binding), group = captureLocalLyricsPhysicalGroup(v.original);
  if (localLyricsPhysicalOperationId(binding) !== v.operationId || binding.memberCount !== group.members.length || binding.resourceCount !== group.resources.length
    || binding.protectionSha256 !== lyricsPhysicalDigest(group) || !group.members.some(m => m.trackId === binding.trackId && m.rootRevision === binding.rootRevision
      && m.fileRevision === binding.fileRevision && m.locationRevision === binding.locationRevision && m.metadataRevision === binding.metadataRevision)) return invalid();
  const grant=v.grant;
  if (grant !== null && (!exact(grant, ['requestId', 'sequence', 'revision', 'authorityId', 'bindingSha256', 'requestSha256', 'nonce', 'validUntilMs'])
    || !['requestId', 'authorityId', 'nonce'].every(k => text(grant[k])) || !['sequence', 'revision', 'validUntilMs'].every(k => integer(grant[k], 1, Number.MAX_SAFE_INTEGER))
    || !hash(grant.bindingSha256) || !hash(grant.requestSha256) || typeof grant.revision!=='number'||grant.revision>=v.revision
    || grant.bindingSha256!==lyricsPhysicalDigest({...binding,ownerEpoch:v.currentOwnerEpoch}))) return invalid();
  if (!exact(v.artifacts, ['stage', 'backup', 'quarantine', 'target']) || Object.values(v.artifacts).some(r => r !== null && !resource(r))) return invalid();
  const fidelity=v.fidelity;
  if (fidelity !== null && (!exact(fidelity, ['sourceSha256', 'copySha256', 'pcmSha256', 'pcmBytes', 'unselectedSha256', 'pictureSha256', 'sampleRate', 'channels', 'frames'])
    || !['sourceSha256', 'copySha256', 'pcmSha256', 'unselectedSha256'].every(k => hash(fidelity[k])) || fidelity.pictureSha256 !== null && !hash(fidelity.pictureSha256)
    || !integer(fidelity.pcmBytes, 1, LOCAL_LYRICS_PHYSICAL_LIMITS.sourceGroupBytes) || !integer(fidelity.sampleRate, 1, 768000)
    || !integer(fidelity.channels, 1, 32) || !integer(fidelity.frames, 1, Number.MAX_SAFE_INTEGER))) return invalid();
  if (v.result !== null && (!exact(v.result, ['state', 'bodySha256']) || !['saved', 'existing', 'failed', 'unknown', 'cancelled'].includes(String(v.result.state))
    || v.result.bodySha256 !== null && !hash(v.result.bodySha256))) return invalid();
  if (v.protectionReleased && !v.physicalClosed || v.phase === 'UNKNOWN' && (!v.unresolved || v.result?.state !== 'unknown')
    || v.phase === 'CLOSED' && (!v.physicalClosed || !v.protectionReleased || v.unresolved || !['saved', 'existing'].includes(String(v.result?.state)))
    || v.phase === 'FAILED' && (!v.physicalClosed || !v.protectionReleased || v.unresolved || v.result?.state !== 'failed')
    || ['PUBLISHED', 'FACTS_COMMITTED', 'QUIET', 'CLOSED'].includes(String(v.phase)) && binding.kind === 'embed' && !v.fidelity) return invalid();
  return v as unknown as LocalLyricsPhysicalRecord;
}
export function localLyricsPhysicalImmutable(record: LocalLyricsPhysicalRecord) {
  const v = captureLocalLyricsPhysicalRecord(record); return { schema: v.schema, operationId: v.operationId, binding: v.binding, original: v.original };
}
export function localLyricsPhysicalState(record: LocalLyricsPhysicalRecord) {
  const {schema: _s, operationId: _i, binding: _b, original: _o, ...state} = captureLocalLyricsPhysicalRecord(record); return state;
}
/** 冷delta必须逐条连续验证，明确FAILED重试只能回GRANTED，不接受删掉失败历史。 */
export function assertLocalLyricsPhysicalTransition(previous: LocalLyricsPhysicalRecord | null, next: LocalLyricsPhysicalRecord): void {
  const n = captureLocalLyricsPhysicalRecord(next);
  if (!previous) { if (n.revision !== 1 || n.phase !== 'PREPARED' || n.grant || n.physicalClosed || n.protectionReleased || n.result || n.fidelity
      || Object.values(n.artifacts).some(v => v !== null)) return invalid(); return; }
  const p = captureLocalLyricsPhysicalRecord(previous);
  if (n.revision !== p.revision + 1 || lyricsPhysicalDigest(localLyricsPhysicalImmutable(p)) !== lyricsPhysicalDigest(localLyricsPhysicalImmutable(n))) return invalid();
  const nextPhases: Record<LocalLyricsPhysicalRecord['phase'], readonly LocalLyricsPhysicalRecord['phase'][]> = {
    PREPARED: ['GRANTED', 'FAILED', 'UNKNOWN'], GRANTED: ['STAGED', 'FAILED', 'UNKNOWN'], STAGED: ['PUBLISH_INTENT', 'FAILED', 'UNKNOWN'],
    PUBLISH_INTENT: ['PUBLISHED', 'FAILED', 'UNKNOWN'], PUBLISHED: ['FACTS_COMMITTED', 'UNKNOWN'], FACTS_COMMITTED: ['QUIET', 'UNKNOWN'],
    QUIET: ['CLOSED', 'UNKNOWN'], CLOSED: [], FAILED: ['GRANTED'], UNKNOWN: [],
  };
  if (!nextPhases[p.phase].includes(n.phase)) return invalid();
  if (n.phase === 'GRANTED' && (!n.grant || n.physicalClosed || n.protectionReleased || n.unresolved || n.result)) return invalid();
  if (n.phase === 'FACTS_COMMITTED' && !['saved', 'existing'].includes(String(n.result?.state))) return invalid();
}

export interface LyricsSourceFormatObservation {
  format: 'wav' | 'flac'; sha256: string; bytes: number; audioSha256: string;
  unselectedSha256: string; pictureSha256: string | null; sampleRate: number; channels: number; frames: number;
}
/** 这里只证明有限容器元数据；完整PCM必须由实际Native EOF解码再独立比较。 */
export async function observeLyricsSourceFormat(handle: FileHandle, format: 'wav' | 'flac', signal: AbortSignal): Promise<LyricsSourceFormatObservation> {
  const before = await handle.stat({bigint: true});
  if (!before.isFile() || before.size < 1n || before.size > BigInt(LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes) || signal.aborted) return invalid();
  const read = async (at: number, count: number): Promise<Buffer> => {
    if (signal.aborted || count < 0 || count > LOCAL_LYRICS_PHYSICAL_LIMITS.metadataBytes || at < 0 || at + count > Number(before.size)) return invalid();
    const out = Buffer.alloc(count); let offset = 0;
    while (offset < count) { const n = await handle.read(out, offset, count - offset, at + offset); if (!n.bytesRead) return invalid(); offset += n.bytesRead; if (signal.aborted) return invalid(); } return out;
  };
  const digestRange = async (at: number, count: number): Promise<string> => {
    const h = createHash('sha256'); for (let offset = 0; offset < count;) { const n = Math.min(1024 * 1024, count - offset); h.update(await read(at + offset, n)); offset += n; } return h.digest('hex');
  };
  const facts: unknown[] = [], pictures: string[] = []; let sampleRate = 0, channels = 0, frames = 0, audioSha256 = '';
  const head = await read(0, Math.min(Number(before.size), 12));
  if (format === 'flac') {
    if (head.subarray(0, 4).toString('ascii') !== 'fLaC') return invalid();
    let at = 4, count = 0, metadata = 0, last = false;
    while (!last) {
      if (++count > 2048) return invalid(); const h = await read(at, 4), type = h[0]! & 127, size = h.readUIntBE(1, 3); last = (h[0]! & 128) !== 0;
      metadata += size + 4; if (metadata > LOCAL_LYRICS_PHYSICAL_LIMITS.metadataBytes) return invalid(); const bytes = await read(at + 4, size); at += size + 4;
      if (type === 0) { if (count !== 1 || size !== 34) return invalid(); const n = bytes.readBigUInt64BE(10); sampleRate = Number(n >> 44n); channels = Number((n >> 41n) & 7n) + 1; frames = Number(n & 0xfffffffffn); facts.push(['STREAMINFO', bytes.toString('base64')]); }
      else if (type === 1) { /* padding长度可以变，内容不能伪装另一个未选标签。 */ if (bytes.some(v => v !== 0)) return invalid(); }
      else if (type === 4) {
        let pos = 0; const number = (): number => { if (pos + 4 > bytes.length) return invalid(); const n = bytes.readUInt32LE(pos); pos += 4; return n; };
        const field = (): Buffer => { const n = number(); if (n > LOCAL_LYRICS_PHYSICAL_LIMITS.metadataBytes || pos + n > bytes.length) return invalid(); const b = bytes.subarray(pos, pos + n); pos += n; return b; };
        const vendor = field().toString('base64'), n = number(), comments: string[] = []; if (n > 65536) return invalid();
        for (let i = 0; i < n; i++) { const raw = field(), value = raw.toString('utf8'); if (!Buffer.from(value).equals(raw)) return invalid(); const sep = value.indexOf('='); if (sep < 1) return invalid(); const key = value.slice(0, sep).toUpperCase(); if (!['LYRICS', 'UNSYNCEDLYRICS'].includes(key)) comments.push(key + value.slice(sep)); }
        if (pos !== bytes.length) return invalid(); facts.push(['COMMENTS', vendor, comments.sort()]);
      } else { const s = createHash('sha256').update(bytes).digest('hex'); facts.push(['BLOCK', type, s, size]); if (type === 6) pictures.push(s); }
    }
    if (at >= Number(before.size)) return invalid(); audioSha256 = await digestRange(at, Number(before.size) - at);
  } else {
    if (head.length !== 12 || head.subarray(0, 4).toString('ascii') !== 'RIFF' || head.subarray(8, 12).toString('ascii') !== 'WAVE' || head.readUInt32LE(4) + 8 !== Number(before.size)) return invalid();
    let at = 12, count = 0, audioBytes = 0, block = 0, metadata = 0;
    while (at < Number(before.size)) {
      if (++count > 2048) return invalid(); const h = await read(at, 8), id = h.subarray(0, 4).toString('ascii'), size = h.readUInt32LE(4); at += 8;
      if (at + size + (size & 1) > Number(before.size)) return invalid();
      if (id === 'data') { if (audioSha256 || !block || size % block) return invalid(); audioBytes = size; audioSha256 = await digestRange(at, size); }
      else {
        metadata += size; if (metadata > LOCAL_LYRICS_PHYSICAL_LIMITS.metadataBytes) return invalid(); const bytes = await read(at, size);
        if (id === 'fmt ') { if (sampleRate || size < 16 || ![1, 3].includes(bytes.readUInt16LE(0))) return invalid(); channels = bytes.readUInt16LE(2); sampleRate = bytes.readUInt32LE(4); block = bytes.readUInt16LE(12); facts.push(['fmt', bytes.toString('base64')]); }
        else if (id.toLowerCase() === 'id3 ') { const frames = lyricsUnselectedId3Frames(bytes); if(frames.unselected.length)facts.push(['ID3', frames.unselected]); pictures.push(...frames.pictures); }
        else facts.push(['CHUNK', id, createHash('sha256').update(bytes).digest('hex'), size]);
      }
      at += size + (size & 1);
    }
    if (!audioSha256 || !block) return invalid(); frames = audioBytes / block;
  }
  const after = await handle.stat({bigint: true});
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].some(k => before[k as keyof typeof before] !== after[k as keyof typeof after])
    || !sampleRate || !channels || !frames || signal.aborted) return invalid();
  return {format, sha256: await digestRange(0, Number(before.size)), bytes: Number(before.size), audioSha256,
    unselectedSha256: lyricsPhysicalDigest(facts), pictureSha256: pictures.length ? lyricsPhysicalDigest(pictures) : null, sampleRate, channels, frames};
}
function lyricsUnselectedId3Frames(bytes: Buffer): {unselected: unknown[]; pictures: string[]} {
  if (bytes.length < 10 || bytes.subarray(0, 3).toString('ascii') !== 'ID3' || ![3, 4].includes(bytes[3]!) || bytes[4] !== 0 || bytes[5] !== 0) return invalid();
  const syn = (b: Buffer, at: number): number => { if (b.subarray(at, at + 4).some(v => v > 127)) return invalid(); return b[at]! * 2097152 + b[at + 1]! * 16384 + b[at + 2]! * 128 + b[at + 3]!; };
  const end = 10 + syn(bytes, 6); if (end !== bytes.length) return invalid(); let at = 10; const unselected: unknown[] = [], pictures: string[] = [];
  while (at < end) {
    if (bytes[at] === 0) { if (bytes.subarray(at).some(v => v !== 0)) return invalid(); break; }
    if (at + 10 > end) return invalid(); const id = bytes.subarray(at, at + 4).toString('ascii'), n = bytes[3] === 4 ? syn(bytes, at + 4) : bytes.readUInt32BE(at + 4), flags = bytes.readUInt16BE(at + 8); at += 10;
    if (!/^[A-Z0-9]{4}$/u.test(id) || flags !== 0 || n < 1 || at + n > end) return invalid(); const body = bytes.subarray(at, at + n); at += n;
    if (id === 'USLT') continue;
    if (id[0] === 'T' && id !== 'TXXX') {
      const encoding = body[0]!, raw = body.subarray(1); let value: string;
      if (encoding === 0) value = raw.toString('latin1');
      else if (encoding === 3) { value = raw.toString('utf8'); if (!Buffer.from(value).equals(raw)) return invalid(); }
      else if (encoding === 1 && raw.length % 2 === 0 && raw.subarray(0, 2).equals(Buffer.from([255, 254]))) value = raw.subarray(2).toString('utf16le');
      else return invalid();
      unselected.push([id, value.replace(/\0+$/u, '')]);
    } else { const sha = createHash('sha256').update(body).digest('hex'); unselected.push([id, n, sha]); if (id === 'APIC') pictures.push(sha); }
  }
  return {unselected: unselected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), pictures};
}

const nativeRoots=new WeakMap<object,string>();
const nativePorts = new WeakSet<object>(), nativeBaselines = new WeakMap<object, { port: object; observation: LyricsSourceFormatObservation; pcmSha256: string; pcmBytes: number; values: Readonly<Record<string, string | undefined>> }>();
export interface LyricsNativeBaseline {readonly purpose: 'LYRICS'}
export interface LyricsNativeFidelityPort {
  captureOriginal(handle:FileHandle,format:'wav'|'flac',claim:CueNativeClaim,signal:AbortSignal,absolute:string):Promise<LyricsNativeBaseline>;
  verifyCopy(baseline:LyricsNativeBaseline,copy:FileHandle,format:'wav'|'flac',body:string,claim:CueNativeClaim,signal:AbortSignal,absolute:string):Promise<LocalLyricsPhysicalFidelity>;
  join(commandId:string):Promise<void>; close():Promise<void>;
}
export function lyricsNativeTemporaryRoot(port:LyricsNativeFidelityPort):string {assertLyricsNativeFidelityPort(port);return nativeRoots.get(port)!;}
export function assertLyricsNativeFidelityPort(port:unknown):asserts port is LyricsNativeFidelityPort {
  if(!port||typeof port!=='object'||!nativePorts.has(port))return invalid();
}
/** 固定包整件核验后才创建此品牌；调用者不能提交opened/EOF布尔字段换资格。 */
export async function createLyricsNativeFidelityPort(options:{cueRoot:string;cueManifestSha256:string;tagsRoot:string;tagsManifestSha256:string;temporaryRoot:string}):Promise<LyricsNativeFidelityPort> {
  if(!path.isAbsolute(options.temporaryRoot)||await realpath(options.temporaryRoot)!==options.temporaryRoot)return invalid();
  const directory=await lstat(options.temporaryRoot,{bigint:true});if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077n)!==0n)return invalid();
  const cue=createCueNativeActor(await loadBundledCueConverter(options.cueRoot,options.cueManifestSha256));
  const tags=createLocalAudioTagsActor(await loadLocalAudioTagsBundle(options.tagsRoot,options.tagsManifestSha256));
  let closing=false,number=0;const nativeInstance=randomUUID();
  async function pcm(handle:FileHandle,format:'wav'|'flac',observation:LyricsSourceFormatObservation,claim:CueNativeClaim,signal:AbortSignal,absolute:string):Promise<{sha256:string;bytes:number}> {
    if(closing||signal.aborted)return invalid();await claim.assertCurrent();
    const expected=observation.frames*observation.channels*4;if(!integer(expected,1,LOCAL_LYRICS_PHYSICAL_LIMITS.sourceGroupBytes))return invalid();
    const relative=lyricsPhysicalDigest([nativeInstance,claim.commandId,++number])+'.s32le';if(!relative.match(/^[A-Za-z0-9_-]+\.s32le$/u))return invalid();
    if(!path.isAbsolute(absolute)||await realpath(absolute)!==absolute)return invalid();
    const source=await handle.stat({bigint:true}),input=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
    const reread=await input.stat({bigint:true}).catch(async error=>{await input.close();throw error;});
    if(source.dev!==reread.dev||source.ino!==reread.ino||source.birthtimeNs!==reread.birthtimeNs||source.size!==reread.size){await input.close();return invalid();}
    let out:FileHandle;try{out=await open(path.join(options.temporaryRoot,relative),constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_RDWR,0o600);}catch(error){await input.close();throw error;}
    const cancel=new AbortController(),combined=AbortSignal.any([signal,cancel.signal]);let overflow=false;
    const watcher=setInterval(()=>{void out.stat().then(s=>{if(s.size>expected){overflow=true;cancel.abort();}}).catch(()=>cancel.abort());},25);
    try {
      const run=await cue.decode(input,out,format,claim,combined);await cue.join(claim.commandId);
      if(run.exitCode!==0||run.signal!==null||!run.pidClosed||overflow||combined.aborted)return invalid();
      const stat=await out.stat();if(stat.size!==expected)return invalid();const h=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);let at=0;
      while(at<stat.size){const n=await out.read(chunk,0,Math.min(chunk.length,stat.size-at),at);if(!n.bytesRead||signal.aborted)return invalid();h.update(chunk.subarray(0,n.bytesRead));at+=n.bytesRead;}
      await claim.assertCurrent();return {sha256:h.digest('hex'),bytes:at};
    }finally{clearInterval(watcher);const closed=await Promise.allSettled([cue.join(claim.commandId),input.close(),out.close()]);if(closed.some(v=>v.status==='rejected'))return invalid();}
  }
  const port:LyricsNativeFidelityPort={
    async captureOriginal(handle,format,claim,signal,absolute){
      if(closing)return invalid();await claim.assertCurrent();const observation=await observeLyricsSourceFormat(handle,format,signal);
      const read=await tags.run({fd:handle.fd,commandId:claim.commandId,claimId:claim.claimId,assertCurrent:claim.assertCurrent},format==='wav'?'pcm-wav':'flac',null,signal);
      await tags.join(claim.commandId);if(read.exitCode!==0||!read.pidClosed||!read.actorFdsClosed)return invalid();
      const decoded=await pcm(handle,format,observation,claim,signal,absolute),baseline=Object.freeze({purpose:'LYRICS' as const});
      nativeBaselines.set(baseline,{port,observation,pcmSha256:decoded.sha256,pcmBytes:decoded.bytes,values:read.values});return baseline;
    },
    async verifyCopy(baseline,copy,format,body,claim,signal,absolute){
      const original=nativeBaselines.get(baseline);if(closing||!original||original.port!==port||original.observation.format!==format)return invalid();
      await claim.assertCurrent();const observation=await observeLyricsSourceFormat(copy,format,signal),old=original.observation;
      if(observation.unselectedSha256!==old.unselectedSha256||observation.pictureSha256!==old.pictureSha256||observation.audioSha256!==old.audioSha256
        ||observation.frames!==old.frames||observation.channels!==old.channels||observation.sampleRate!==old.sampleRate)return invalid();
      const read=await tags.run({fd:copy.fd,commandId:claim.commandId,claimId:claim.claimId,assertCurrent:claim.assertCurrent},format==='wav'?'pcm-wav':'flac',null,signal);await tags.join(claim.commandId);
      if(read.exitCode!==0||!read.pidClosed||!read.actorFdsClosed||read.values.LYRICS!==body
        ||Object.keys(original.values).some(k=>k!=='LYRICS'&&read.values[k as keyof typeof read.values]!==original.values[k]))return invalid();
      const decoded=await pcm(copy,format,observation,claim,signal,absolute);if(decoded.sha256!==original.pcmSha256||decoded.bytes!==original.pcmBytes)return invalid();
      return {sourceSha256:old.sha256,copySha256:observation.sha256,pcmSha256:decoded.sha256,pcmBytes:decoded.bytes,
        unselectedSha256:observation.unselectedSha256,pictureSha256:observation.pictureSha256,sampleRate:observation.sampleRate,channels:observation.channels,frames:observation.frames};
    },
    async join(commandId){const results=await Promise.allSettled([tags.join(commandId),cue.join(commandId)]);if(results.some(r=>r.status==='rejected'))return invalid();},
    async close(){closing=true;const results=await Promise.allSettled([tags.close(),cue.close()]);if(results.some(r=>r.status==='rejected'))return invalid();},
  };nativePorts.add(port);nativeRoots.set(port,options.temporaryRoot);return Object.freeze(port);
}

const attributeExec=promisify(execFile);
const linuxLyricsAttributes=`import os,sys,fcntl,array
p,dev,ino=sys.argv[1:];fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
try:
 a=os.fstat(fd)
 if str(a.st_dev)!=dev or str(a.st_ino)!=ino or a.st_nlink!=1 or os.listxattr(fd): raise RuntimeError('unproven')
 flags=array.array('L',[0]);fcntl.ioctl(fd,0x80086601,flags,True)
 if flags[0] & ~0x80000: raise RuntimeError('unproven')
 b=os.fstat(fd)
 if (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns,a.st_mode,a.st_uid,a.st_gid)!=(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns,b.st_mode,b.st_uid,b.st_gid): raise RuntimeError('changed')
 print('CLEAN '+str(a.st_dev)+':'+str(a.st_ino)+':'+str(a.st_mode&4095)+':'+str(a.st_uid)+':'+str(a.st_gid))
finally:os.close(fd)
`;
/** 同原SourceWrites的有限属性策略，独立歌词用途不扩展原publisher或引入模块循环。 */
export async function observeLyricsSourceAttributes(absolute:string,handle:FileHandle):Promise<SourceFileAttributes> {
  const before=await handle.stat({bigint:true}),named=await lstat(absolute,{bigint:true});
  const same=(a:typeof before,b:typeof before):boolean=>['dev','ino','size','mtimeNs','ctimeNs','birthtimeNs','mode','uid','gid','nlink'].every(k=>a[k as keyof typeof a]===b[k as keyof typeof b]);
  if(!same(before,named)||!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid!())||before.gid!==BigInt(process.getgid!()))return invalid();
  const options={timeout:3000,maxBuffer:16384,encoding:'utf8' as const,env:{LANG:'C',LC_ALL:'C'}};let profile:Record<string,unknown>;
  if(process.platform==='darwin'){
    const x=await attributeExec('/usr/bin/xattr',[absolute],options);if(x.stderr||!['','com.apple.provenance\n'].includes(x.stdout))return invalid();
    if(!x.stdout)profile={proof:'MACOS_EMPTY_XATTR_ACL_FLAGS_V1'};
    else {const p=await attributeExec('/usr/bin/xattr',['-px','com.apple.provenance',absolute],options),hex=p.stdout.replace(/[ \r\n\t]/gu,'');if(p.stderr||!/^[a-fA-F0-9]{22}$/u.test(hex))return invalid();profile={proof:'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1',provenance:{bytes:11,sha256:createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex')}};}
    const acl=await attributeExec('/bin/ls',['-lde',absolute],options),flags=await attributeExec('/usr/bin/stat',['-f','%f',absolute],options),mode=acl.stdout.split(/\s/u)[0]??'';
    if(acl.stderr||flags.stderr||flags.stdout!=='0\n'||acl.stdout.trimEnd().split('\n').length!==1||!(x.stdout?/^-[rwxstST-]{9}@$/u:/^-[rwxstST-]{9}$/u).test(mode))return invalid();
  }else if(process.platform==='linux'){
    const p=await attributeExec('/usr/bin/python3',['-I','-S','-c',linuxLyricsAttributes,absolute,String(before.dev),String(before.ino)],options);
    if(p.stderr||p.stdout!==`CLEAN ${before.dev}:${before.ino}:${before.mode&0o7777n}:${before.uid}:${before.gid}\n`)return invalid();profile={proof:'LINUX_EMPTY_XATTR_ACL_FLAGS_V1'};
  }else return invalid();
  if(!same(before,await handle.stat({bigint:true}))||!same(before,await lstat(absolute,{bigint:true})))return invalid();
  return {mode:String(before.mode&0o7777n),uid:String(before.uid),gid:String(before.gid),...profile} as SourceFileAttributes;
}
