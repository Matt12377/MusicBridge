import { withLocalFactsMutation } from '../stream/local-source-fence.js';
import { createScanReaderTurn, scheduleScanAlbums, LOCAL_SCAN_DEFAULT_SETTINGS, type LocalScanSettingsStore, type LocalScanFrozenSettings } from './local-scan-settings.js';
import type { DatasetIdentity } from '../recording/dataset-identity.js';
import { randomUUID } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import { isLocalMetadata, isLocalCatalogText, isCollectionId, isAudioAsset, isLocalTrack, isLocalCatalogRevision,
  type LocalMetadata, type ScanJobRecord, type LocalScanStartRequest, type LocalScanTransitionRequest } from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import type { DatasetProjectionPort } from './dataset-owner-protocol.js';
import { SourceFileError, MetadataLeaseReleaseError, withCheckedReadonlyMetadataSource, sourceRootAvailability, readonlySourceCandidateMetadata, type RootCapability } from '../recording/source-files.js';
import { observeRelocationFile } from './source-relocation-verify.js';
import { createMetadataReader, readRelocationMetadata } from '../library/metadata-reader.js';
import { METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION, CUE_INPUT_SCAN_VERSION, type MetadataReaderPort, type MetadataRawFields, type MetadataReadResult } from '../library/metadata-reader-types.js';
import { scanRelativePath, scanCanonical, type ScanPreparedBatch, type ScanPreparedItem, type RelocationPreparedScanRead } from './local-scan-store.js';
import type { RelocationCatalogCommitContext, RelocationScanReadRequest } from './source-relocation-scan-port.js';
import type { RelocationReadAccess } from './source-relocation-verify.js';
import {createCueSidecarReader,type CueSidecarReader,type CueSidecarReadResult} from '../library/cue-sidecar-reader.js';
import {parseCueText} from '../library/cue-text-reader.js';
import type {LocalCuePreparedItem,LocalCueAssetReference} from '@music-bridge/contracts';
const CUE_PARSER='cue-text-75fps/mbrs003-v1';

const PARSER = METADATA_PARSER_VERSION;
const cueAudio = /\.(ogg|oga|opus|wv|ape|tta|mpc|mpp|mp\+|tak)$/iu;
const audio = /\.(flac|mp3|m4a|mp4|aac|wav|wave|aif|aiff)$/iu;
const dsdAudio = /\.(dsf|dff)$/iu;
class ScanYield extends Error { constructor(readonly reason: 'media-busy'|'admission-closed'|'deferred'|'control') { super(reason); } }
class ScanFatal extends Error { constructor(message: string, cause?: unknown) { super(message,{cause}); } }
interface Cursor { relative: string; skip: number; signature: string | null }
const cursorToken = (cursor: Cursor,mode:'audio'|'pending'|'cue'='audio'): string => `${mode === 'cue' ? '~cue-v1/':mode === 'pending' ? '~scan-cue-v1/':'~scan-v1/'}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
function cursorFrom(token: string,allowCueTokens=false): Cursor {
  const prefix=(allowCueTokens ? ['~scan-v1/','~scan-cue-v1/','~cue-v1/']:['~scan-v1/']).find(prefix=>token.startsWith(prefix));
  if(!prefix) return {relative:token,skip:0,signature:null};
  const value: unknown = JSON.parse(Buffer.from(token.slice(prefix.length),'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('扫描游标结构无效。');
  const v=value as Record<string,unknown>;
  if (Object.keys(v).length !== 3 || !(v.relative === '' || scanRelativePath(v.relative)) || typeof v.skip !== 'number'
    || !Number.isSafeInteger(v.skip) || v.skip<0 || !(v.signature === null || typeof v.signature === 'string' && v.signature.length <=512)) throw new Error('扫描游标结构无效。');
  return {relative:v.relative,skip:v.skip,signature:v.signature};
}
const statSignature = (s: Awaited<ReturnType<typeof directory>>) => s.signature;
async function directory(root:RootCapability,relative:string):Promise<{absolute:string;signature:string}> {
  if(await sourceRootAvailability(root) !== 'ONLINE') throw new SourceFileError(root.authorized ? 'SOURCE_ROOT_OFFLINE':'REVOKED');
  if(relative !== '' && !scanRelativePath(relative)) throw new SourceFileError('OUTSIDE_ROOT');
  let absolute=root.path;
  for(const part of relative ? relative.split('/') : []) {
    absolute=path.join(absolute,part); const s=await lstat(absolute,{bigint:true});
    if(!s.isDirectory() || s.isSymbolicLink()) throw new SourceFileError('OUTSIDE_ROOT');
  }
  const s=await lstat(absolute,{bigint:true});
  if(!s.isDirectory() || s.isSymbolicLink() || await realpath(absolute) !== absolute) throw new SourceFileError('OUTSIDE_ROOT');
  return {absolute,signature:[s.dev,s.ino,s.mtimeNs,s.ctimeNs].join(':')};
}
/** 只读目录流与持久游标分离；暖扫描保留一个Dir句柄，冷恢复最多重放该目录原skip。 */
class Walk {
  private opened: {dir:Dir;relative:string;skip:number;signature:string}|undefined;
  constructor(private readonly root:RootCapability,private readonly signal:AbortSignal,private readonly current:()=>void,private readonly cueMode=false,private readonly allowCueTokens=false,private readonly dsdEnabled=false,private readonly cueInputEnabled=false) {}
  private check():void { this.current(); if(this.signal.aborted) throw new ScanYield('control'); }
  async close():Promise<void> { const opened=this.opened;this.opened=undefined;if(opened) await opened.dir.close(); }
  async next(frontier:readonly string[],budget=2000):Promise<{relatives:string[];frontier:string[];cueAware:boolean}> {
    const queue=[...frontier],relatives:string[]=[];let inspected=0,foundCue=this.allowCueTokens && frontier.some(p=>p.startsWith('~scan-cue-v1/'));
    while(queue.length && relatives.length<(this.cueMode ? 1:200) && inspected<budget) {
      this.check();let cursor=cursorFrom(queue[0]!,this.allowCueTokens || this.cueMode);const observed=await directory(this.root,cursor.relative);this.check();
      if(cursor.signature !== null && cursor.signature !== statSignature(observed)) { await this.close();cursor={relative:cursor.relative,skip:0,signature:null}; }
      if(!this.opened || this.opened.relative !== cursor.relative || this.opened.skip !== cursor.skip || this.opened.signature !== observed.signature) {
        await this.close();const dir=await opendir(observed.absolute);
        this.opened={dir,relative:cursor.relative,skip:0,signature:observed.signature};
        while(this.opened.skip<cursor.skip) {this.check();if(!await dir.read()) throw new Error('扫描冷游标超出目录边界。');this.opened.skip++;}
      }
      this.check();const entry=await this.opened.dir.read();this.check();
      if(!entry) { await this.close();queue.shift();continue; }
      inspected++;this.opened.skip++;
      queue[0]=cursorToken({relative:cursor.relative,skip:this.opened.skip,signature:observed.signature},this.cueMode ? 'cue':'audio');
      const relative=cursor.relative ? `${cursor.relative}/${entry.name}` : entry.name;
      if(!scanRelativePath(relative) || entry.isSymbolicLink()) continue;
      if(entry.isDirectory()) { if(queue.length>=200) throw new Error('扫描目录frontier超过200项。');queue.push(cursorToken({relative,skip:0,signature:null},this.cueMode ? 'cue':'audio')); }
      else if(entry.isFile()) {if(/\.cue$/iu.test(entry.name)) {foundCue=true;if(this.cueMode) relatives.push(relative);} else if(!this.cueMode && (audio.test(entry.name) || this.dsdEnabled && dsdAudio.test(entry.name) || this.cueInputEnabled && cueAudio.test(entry.name))) relatives.push(relative);}
    }
    if(!this.cueMode && foundCue) {if(queue.length) queue[0]=cursorToken(cursorFrom(queue[0]!,this.allowCueTokens || this.cueMode), 'pending');else queue.push(cursorToken({relative:'',skip:0,signature:null},'cue'));}
    return {relatives,frontier:queue,cueAware:this.allowCueTokens || this.cueMode || foundCue};
  }
}
/** Catalog现有512字符准入独立于reader4096 UTF8预算；拒绝整个item，保留字段名分类而不截断。 */
export function admitScanFields(fields:MetadataRawFields):{status:'accepted';fields:LocalMetadata}|{status:'rejected';code:string} {
  const names=['title','artist','album','year','disc','track'] as const;
  if(![Object.prototype,null].includes(Object.getPrototypeOf(fields)) || Reflect.ownKeys(fields).some(k=>typeof k !== 'string' || !(names as readonly string[]).includes(k) || !Object.prototype.propertyIsEnumerable.call(fields,k))) return {status:'rejected',code:'CATALOG_METADATA_INVALID'};
  for(const key of names) { const value=fields[key];if(value !== undefined && !isLocalCatalogText(value,true)) return {status:'rejected',code:`CATALOG_FIELD_INVALID_${key.toUpperCase()}`}; }
  if(!isLocalMetadata(fields)) return {status:'rejected',code:'CATALOG_METADATA_INVALID'};
  return {status:'accepted',fields:{...fields}};
}
interface Running { controller:AbortController; done:Promise<void> }
export interface LocalScanCoordinatorOptions {
  identity?: DatasetIdentity;
  settings?: LocalScanSettingsStore;
  onCompleted?(job: ScanJobRecord, context?: { retry: boolean }): Promise<void>;
  /** 同Owner资格开启；原扫描范围与旧Reader默认保持。 */
  dsdMetadataEnabled?: boolean;
  /** 私有显式开启；只给新 CUE 输入 job 扩展音频族，不升级旧 job。 */
  cueInputMetadataEnabled?: boolean;
  repository:CollectionRepository;datasetId:string;assertCurrent():void;
  projection?:DatasetProjectionPort;assertReady?():void;
  /** 仅可信测试替换读取port；生产组合总是创建真实有限reader。 */
  reader?:MetadataReaderPort;
  cueReader?:CueSidecarReader;
}
export function createLocalScanCoordinator(options:LocalScanCoordinatorOptions) {
  if (options.settings && (!options.identity || options.identity.datasetId !== options.datasetId)) throw new Error('扫描设置必须绑定现存同一工作库作者。');
  const readerTurn = createScanReaderTurn(), frozenSettings = new Map<string, LocalScanFrozenSettings>();
  const cueInputMetadataEnabled = options.cueInputMetadataEnabled === true;
  const store=options.repository.localScan,reader=options.reader ?? createMetadataReader({concurrency:1,maxPending:1,dsdMetadataEnabled:options.dsdMetadataEnabled === true,cueInputMetadataEnabled});
  const cueReader=options.cueReader ?? createCueSidecarReader();
  const runs=new Map<string,Running>();let closing=false,fatal:ScanFatal|undefined,closed:Promise<void>|undefined;
  const relocationPrepared = new WeakMap<object, { request: RelocationScanReadRequest; reads: readonly RelocationPreparedScanRead[]; consumed: boolean }>();
  function assertCurrent():void {if(fatal) throw fatal;options.assertCurrent();}
  function assertEntry():void {assertCurrent();options.assertReady?.();if(closing) throw new Error('扫描owner已关闭新入口。');}
  function scoped(jobId:string):ScanJobRecord {const job=store.get(jobId);if(job.datasetId !== options.datasetId) throw new Error('扫描任务不属于当前dataset。');return job;}
  function authority(job:ScanJobRecord):RootCapability {
    assertCurrent();const root=options.repository.localCatalog.root(job.libraryRootId);
    if(root.revision !== job.rootRevision || root.sourceRootId !== job.sourceRootId) throw new Error('ROOT_REVISION_CHANGED');
    const source=options.repository.sources.root(root.sourceRootId);
    if(!source || source.id !== job.sourceRootId || typeof source.path !== 'string' || !path.isAbsolute(source.path)
      || typeof source.dev !== 'string' || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(source.dev) || typeof source.ino !== 'string' || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(source.ino)
      || typeof source.authorized !== 'boolean' || typeof source.label !== 'string') throw new Error('扫描SourceStore根结构无效。');
    if(!source.authorized) throw new SourceFileError('REVOKED');return source;
  }
  async function admittedRead<T extends {status:'ok'|'failure';code?:string}>(job:ScanJobRecord,signal:AbortSignal,consume:(root:RootCapability,signal:AbortSignal)=>Promise<T>):Promise<T> {
    const projection=options.projection;
    if(!projection) throw new ScanYield('deferred');
    const acquired=await projection.call('scanReadAcquire',{});
    if(acquired.status === 'deferred') throw new ScanYield('deferred');
    const local=new AbortController();let settled=false,watchFailure:unknown,yielded:'media-busy'|'admission-closed'|undefined;
    const forward=()=>local.abort(signal.reason);signal.addEventListener('abort',forward,{once:true});if(signal.aborted) forward();
    const watch=(async()=>{
      while(!settled) {
        const observation=await projection.call('scanReadWatchRevocation',{permitId:acquired.permitId});
        if(observation.reason === 'renew') continue;
        if(observation.reason === 'media-busy' || observation.reason === 'admission-closed') {yielded=observation.reason;local.abort(new ScanYield(observation.reason));}
        // release由已quiet的读取方发起；permit-released无需取消已落定read。
        break;
      }
    })().catch(error=>{watchFailure=error;local.abort(error);});
    let result:T;
    try { result=await consume(authority(job),local.signal); }
    catch(error) { settled=true;fatal=new ScanFatal('扫描读取未返回可确认关闭结果。',error);await watch;throw fatal; }
    finally {signal.removeEventListener('abort',forward);}
    settled=true;
    if(result.status === 'failure' && result.code === 'LEASE_RELEASE_FAILED') {
      fatal=new ScanFatal('扫描FD关闭未确认；禁止交接、释放Core票据或自动重试。');
      // Core关闭将解决尚挂着的watch；该票据故意不release，不伪装quiet。
      void watch;throw fatal;
    }
    if(watchFailure) {fatal=new ScanFatal('扫描读取票据撤销通道失效。',watchFailure);throw fatal;}
    try {await projection.call('scanReadRelease',{permitId:acquired.permitId});await watch;}
    catch(error) {fatal=new ScanFatal('扫描quiet后票据释放未确认。',error);throw fatal;}
    if(watchFailure) {fatal=new ScanFatal('扫描读取watch收口失败。',watchFailure);throw fatal;}
    if(yielded) throw new ScanYield(yielded);
    if(signal.aborted) throw new ScanYield('control');return result;
  }
  function cueInputJob(job: ScanJobRecord): boolean {
    // job 公开 DTO 不带解析器版本；只读原 SQL 列，不由当前 options 给旧 job 改身份。
    return cueInputMetadataEnabled && store.privateJobParserVersion(job.jobId) === CUE_INPUT_SCAN_VERSION;
  }
  function metadataFitsJob(job: ScanJobRecord, result: Extract<MetadataReadResult, { status: 'ok' }>): boolean {
    if (!cueInputJob(job)) return result.parserVersion === METADATA_PARSER_VERSION
      && ['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF'].includes(result.technical.container);
    return ['TTA','TAK'].includes(result.technical.container) ? result.parserVersion === CUE_HEADER_METADATA_PARSER_VERSION
      : result.parserVersion === METADATA_PARSER_VERSION;
  }
  function itemParser(job: ScanJobRecord, relative: string, container?: string): string {
    return cueInputJob(job) && (container === undefined ? /\.(tta|tak)$/iu.test(relative) : ['TTA','TAK'].includes(container))
      ? CUE_HEADER_METADATA_PARSER_VERSION : METADATA_PARSER_VERSION;
  }
  async function read(job:ScanJobRecord,relative:string,signature:string,signal:AbortSignal):Promise<MetadataReadResult> {
    const result = await readerTurn.consume(signal, () => admittedRead(job,signal,(root,local)=>reader.read({root,relative,expectedSignature:signature,assertCurrent:()=>{authority(job);}},local)));
    // 同启用 Reader 恢复旧 job 时，晚返回的新族事实仍明确拒绝，真实 FD/Worker 已先 quiet。
    return result.status === 'ok' && !metadataFitsJob(job, result) ? { status: 'failure', code: 'UNSUPPORTED', readEvidence: result.readEvidence } : result;
  }
  /** 新位置只使用真实原Reader的私有能力；旧raw与普通扫描字段准入不因整文件移动改变。 */
  async function prepareRelocationReads(request: RelocationScanReadRequest, access: RelocationReadAccess, signal: AbortSignal): Promise<unknown> {
    assertEntry(); signal.throwIfAborted();
    const same = (a: unknown, b: unknown): boolean => scanCanonical(a) === scanCanonical(b);
    const closedKeys = (value: unknown, names: readonly string[]): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
      && Reflect.ownKeys(value).length === names.length && Reflect.ownKeys(value).every(key => typeof key === 'string'
        && names.includes(key) && Object.prototype.propertyIsEnumerable.call(value, key));
    if (!closedKeys(request, ['datasetId', 'planId', 'planHash', 'resourceClosureHash', 'mappings'])
      || request.datasetId !== options.datasetId || !isCollectionId(request.planId)
      || !/^[a-f0-9]{64}$/u.test(request.planHash) || !/^[a-f0-9]{64}$/u.test(request.resourceClosureHash)
      || !Array.isArray(request.mappings) || request.mappings.length === 0 || request.mappings.length > 100
      || new Set(request.mappings.map(mapping => mapping.beforeAsset.id)).size !== request.mappings.length) throw new Error('移动扫描完整映射无效。');
    const reads: RelocationPreparedScanRead[] = [];
    for (const mapping of request.mappings) {
      assertEntry(); signal.throwIfAborted();
      if (!closedKeys(mapping, ['operationId', 'resourceId', 'beforeAsset', 'tracks', 'destination'])
        || !isCollectionId(mapping.operationId) || !isCollectionId(mapping.resourceId) || !isAudioAsset(mapping.beforeAsset)
        || !Array.isArray(mapping.tracks) || !mapping.tracks.length || mapping.tracks.length > 200 || !mapping.tracks.every(isLocalTrack)
        || !closedKeys(mapping.destination, ['libraryRootId', 'sourceRootId', 'rootRevision', 'relative'])
        || !isCollectionId(mapping.destination.libraryRootId) || !isCollectionId(mapping.destination.sourceRootId)
        || !isLocalCatalogRevision(mapping.destination.rootRevision) || !scanRelativePath(mapping.destination.relative)) throw new Error('移动扫描资源或目的根无效。');
      const before = options.repository.localCatalog.privateRelocationSnapshot(mapping.beforeAsset.id);
      const destinationRoot = options.repository.localCatalog.root(mapping.destination.libraryRootId);
      const targetRoot = options.repository.sources.root(mapping.destination.sourceRootId);
      const state = store.privateCurrentFileState(before.libraryRoot.id, before.relative);
      if (!same(before.asset, mapping.beforeAsset) || !same(before.tracks, mapping.tracks)
        || before.asset.rootRevision !== before.libraryRoot.revision || before.asset.sourceRootId !== before.libraryRoot.sourceRootId
        || !state || state.value.outcome !== 'accepted' || state.value.assetId !== before.asset.id || !state.value.trackId
        || !mapping.tracks.some((track: import('@music-bridge/contracts').LocalTrack) => track.id === state.value.trackId)) throw new Error('移动扫描原身份或真实读取资格已改变。');
      const directRoot = destinationRoot.sourceRootId === mapping.destination.sourceRootId && destinationRoot.revision === mapping.destination.rootRevision;
      const futureRelink = destinationRoot.id === before.libraryRoot.id && same(destinationRoot, before.libraryRoot)
        && mapping.destination.rootRevision === (BigInt(destinationRoot.revision) + 1n).toString()
        && destinationRoot.sourceRootId !== mapping.destination.sourceRootId;
      if ((!directRoot && !futureRelink) || !targetRoot.authorized) throw new Error('移动扫描目的根关联或许可已改变。');
      const assertMapping = (): void => {
        assertEntry();
        if (!same(options.repository.localCatalog.privateRelocationSnapshot(before.asset.id), before)
          || !same(options.repository.localCatalog.root(destinationRoot.id), destinationRoot)
          || !same(options.repository.sources.root(targetRoot.id), targetRoot)) throw new Error('移动扫描准备期间完整位置事实已改变。');
      };
      assertMapping();
      const stat = await readonlySourceCandidateMetadata(targetRoot, mapping.destination.relative);
      assertMapping(); signal.throwIfAborted();
      // 只供原读取准入核currentness；持久job/batch由同库短事务中的原Scanner作者另行生成。
      const admissionJob: ScanJobRecord = { schemaVersion: '1.2', jobId: randomUUID(), datasetId: options.datasetId,
        libraryRootId: destinationRoot.id, sourceRootId: destinationRoot.sourceRootId, rootRevision: destinationRoot.revision,
        jobRevision: '1', checkpointRef: null, progress: { visited: '0', accepted: '0', rejected: '0' }, phase: 'pending', failureCode: null };
      const result = await readerTurn.consume(signal, () => admittedRead(admissionJob, signal, (_root, local) => readRelocationMetadata(reader,
        { root: targetRoot, relative: mapping.destination.relative, expectedSignature: stat.signature, assertCurrent: assertMapping }, access, local)));
      if (result.status !== 'ok') {
        if (result.code === 'LEASE_RELEASE_FAILED') fatal = new ScanFatal('移动扫描真实FD关闭未核实，禁止继续或自动重试。');
        throw fatal ?? new Error(`移动扫描原Reader拒绝：${result.code}。`);
      }
      assertMapping(); signal.throwIfAborted();
      const item: ScanPreparedItem = { relative: mapping.destination.relative, signature: stat.signature, parserVersion: result.parserVersion,
        outcome: 'accepted', fields: {}, failureCode: null, reused: false,
        readFacts: { technical: result.technical, coverEvidence: result.coverEvidence, readEvidence: result.readEvidence } };
      reads.push({ mapping, item, primaryTrackId: state.value.trackId });
    }
    const prepared = Object.freeze({});
    relocationPrepared.set(prepared, { request, reads: Object.freeze(reads), consumed: false });
    return prepared;
  }
  function consumeRelocationReads(context: RelocationCatalogCommitContext, prepared: unknown): readonly RelocationPreparedScanRead[] {
    assertEntry();
    const stored = prepared && typeof prepared === 'object' ? relocationPrepared.get(prepared) : undefined;
    const { commitCommandId: _command, afterAssets: _assets, ...request } = context;
    if (!stored || stored.consumed || scanCanonical(stored.request) !== scanCanonical(request)) throw new Error('移动扫描不是原Reader准备的完整私有证明。');
    stored.consumed = true; return stored.reads;
  }
  // 旧受控mock没有本域端口时维持原扫描行为；真实repository始终安装，缺端口无法取得013 ticket。
  if (typeof store.privateInstallRelocationScanAuthor === 'function') store.privateInstallRelocationScanAuthor(prepareRelocationReads, consumeRelocationReads);
  async function currentCueReferences(job:ScanJobRecord,result:import('@music-bridge/contracts').LocalCueResult):Promise<boolean> {
    for(const track of result.tracks) {
      const ref=track.assetReference,selected=store.privateCueAssociation(job.libraryRootId,ref.relative);
      if(selected.status !== 'bound') return false;const captured=selected.reference;
      if((['assetId','libraryRootId','sourceRootId','rootRevision','fileRevision','locationRevision','relative','signature'] as const).some(key=>captured[key] !== ref[key]) || ref.sourceRootId !== job.sourceRootId || ref.rootRevision !== job.rootRevision) return false;
      try {if((await readonlySourceCandidateMetadata(authority(job),ref.relative)).signature !== ref.signature) return false;}
      catch(error) {if(error instanceof SourceFileError && ['MISSING','OUTSIDE_ROOT','CONTENT_CHANGED'].includes(error.code)) return false;throw error;}
    }
    return true;
  }
  async function cueItem(job:ScanJobRecord,relative:string,signal:AbortSignal):Promise<LocalCuePreparedItem> {
    const stat=await readonlySourceCandidateMetadata(authority(job),relative),prior=store.privateCueSnapshot(job.libraryRootId,relative);
    const base={relative,signature:stat.signature,parserVersion:CUE_PARSER,previousSnapshotId:prior?.id ?? null};
    if(prior?.item.outcome === 'accepted' && prior.item.result && prior.item.signature === stat.signature && prior.item.parserVersion === CUE_PARSER
      && await currentCueReferences(job,prior.item.result)) return {...base,outcome:'accepted',failureCode:null,reused:true,result:prior.item.result};
    const value:CueSidecarReadResult=await readerTurn.consume(signal, () => admittedRead(job,signal,(root,local)=>cueReader.read({root,relative,expectedSignature:stat.signature,assertCurrent:()=>{authority(job);}},local)));
    if(value.status === 'failure') {
      if(['REVOKED','SOURCE_ROOT_OFFLINE'].includes(value.code)) throw new SourceFileError(value.code as 'REVOKED'|'SOURCE_ROOT_OFFLINE');
      return {...base,outcome:'rejected',failureCode:value.code,reused:false,result:null};
    }
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value.bytes);}catch{return {...base,outcome:'rejected',failureCode:'MALFORMED',reused:false,result:null};}
    // 有限候选键仅供owner查表，最终纯parser才给语法/声明成功；不凭FILE文字创建资产。
    const keys=new Set<string>();for(const match of text.matchAll(/^\s*FILE[ \t]+"([^"\r\n]+)"[ \t]+[A-Z0-9]+[ \t]*$/gmu)) {keys.add(match[1]!);if(keys.size>32) return {...base,outcome:'rejected',failureCode:'BUDGET_EXCEEDED',reused:false,result:null};}
    const associations=new Map<string,readonly LocalCueAssetReference[]>();let ambiguous=false;
    for(const key of keys) {
      if(key.length>512 || Buffer.byteLength(key)>512 || /[\/\\:]/u.test(key) || key === '.' || key === '..') continue;
      const candidate=path.posix.join(path.posix.dirname(relative),key),selected=store.privateCueAssociation(job.libraryRootId,candidate);
      if(selected.status === 'ambiguous'){ambiguous=true;associations.set(key,[]);continue;}
      if(selected.status !== 'bound'){associations.set(key,[]);continue;}
      const ref=selected.reference;
      if(ref.sourceRootId !== job.sourceRootId || ref.rootRevision !== job.rootRevision){associations.set(key,[]);continue;}
      try{if((await readonlySourceCandidateMetadata(authority(job),candidate)).signature !== ref.signature){associations.set(key,[]);continue;}}
      catch(error){if(error instanceof SourceFileError && ['MISSING','OUTSIDE_ROOT','CONTENT_CHANGED'].includes(error.code)){associations.set(key,[]);continue;}throw error;}
      associations.set(key,[ref]);
    }
    const result=parseCueText(value.bytes,associations);
    return result.status === 'ok' ? {...base,outcome:'accepted',failureCode:null,reused:false,result}
      : {...base,outcome:'rejected',failureCode:ambiguous && result.code === 'UNBOUND_FILE' ? 'AMBIGUOUS_FILE':result.code,reused:false,result:null};
  }
  async function item(job:ScanJobRecord,relative:string,signal:AbortSignal):Promise<ScanPreparedItem | null> {
    const root=authority(job),stat=await readonlySourceCandidateMetadata(root,relative);
    const retained = typeof store.privateRetainedSource === 'function' ? store.privateRetainedSource(job.datasetId, job.libraryRootId, job.sourceRootId, job.rootRevision, relative) : null;
    if (retained && retained.observation.signature === stat.signature && retained.observation.bytes === stat.size) {
      const observed = await admittedRead(job, signal, async (currentRoot, local) => {
        try {
          const skipped = await withCheckedReadonlyMetadataSource(currentRoot, relative, stat.signature, local, async handle => {
            const actual = await observeRelocationFile(handle, { signal: local, deadlineAt: Date.now() + 1_800_000 });
            const still = store.privateRetainedSource(job.datasetId, job.libraryRootId, job.sourceRootId, job.rootRevision, relative);
            return scanCanonical(actual) === scanCanonical(retained.observation) && scanCanonical(still) === scanCanonical(retained);
          }, () => { authority(job); });
          return { status: 'ok' as const, skipped };
        } catch (error) {
          if (error instanceof MetadataLeaseReleaseError) return { status: 'failure' as const, code: 'LEASE_RELEASE_FAILED', skipped: false };
          if (local.aborted) return { status: 'failure' as const, code: 'CANCELLED', skipped: false };
          return { status: 'ok' as const, skipped: false };
        }
      });
      // 只有本计划明确保源且当前完整Hash/物理身份仍一致才跳过；同内容其它拷贝仍是独立候选。
      if (observed.status === 'ok' && observed.skipped) return null;
    }
    const previous=store.privateCurrentFileState(job.libraryRootId,relative);
    const cachedContainer = previous?.value.readFacts?.technical.container, parserVersion = itemParser(job, relative, cachedContainer);
    const cacheAllowed = cueInputJob(job) || cachedContainer === undefined || ['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF'].includes(cachedContainer);
    if(cacheAllowed && previous?.value.outcome === 'accepted' && previous.value.signature === stat.signature && previous.value.parserVersion === parserVersion) {
      const asset=options.repository.localCatalog.asset(previous.value.assetId!);
      if(asset.sourceRootId === job.sourceRootId && asset.rootRevision === job.rootRevision)
        return {relative,signature:stat.signature,parserVersion,outcome:'accepted',fields:{},failureCode:null,reused:true,readFacts:null};
    }
    const result=await read(job,relative,stat.signature,signal);
    const base={relative,signature:stat.signature,parserVersion:itemParser(job,relative),reused:false};
    if(result.status === 'failure') {
      if(['REVOKED','SOURCE_ROOT_OFFLINE'].includes(result.code)) throw new SourceFileError(result.code === 'REVOKED' ? 'REVOKED':'SOURCE_ROOT_OFFLINE');
      if(['CLOSED','QUEUE_FULL','WORKER_FAILED','ADMISSION_FAILED'].includes(result.code)) throw new ScanFatal('扫描reader无法继续安全受理。',result.code);
      return {...base,outcome:'rejected',fields:null,failureCode:result.code,readFacts:null};
    }
    base.parserVersion = result.parserVersion;
    const admission=admitScanFields(result.fields),readFacts={technical:result.technical,coverEvidence:result.coverEvidence,readEvidence:result.readEvidence};
    return admission.status === 'accepted' ? {...base,outcome:'accepted',fields:admission.fields,failureCode:null,readFacts}
      : {...base,outcome:'rejected',fields:null,failureCode:admission.code,readFacts};
  }
  async function revalidate(job:ScanJobRecord,batch:ScanPreparedBatch):Promise<boolean> {
    const root=authority(job);
    for(const prepared of [...batch.items,...(batch.cueItems ?? [])]) {
      try {if((await readonlySourceCandidateMetadata(root,prepared.relative)).signature !== prepared.signature) return false;}
      catch(error) {if(error instanceof SourceFileError && ['MISSING','CONTENT_CHANGED','OUTSIDE_ROOT'].includes(error.code)) return false;throw error;}
    }
    for(const cue of batch.cueItems ?? []) if(cue.result && !await currentCueReferences(job,cue.result)) return false;
    return true;
  }
  async function commitFenced(request:{commandId:string;jobId:string;batchId:string;expectedRevision:string},signal?:AbortSignal):Promise<ScanJobRecord> {
    return withLocalFactsMutation(() => {assertEntry();signal?.throwIfAborted();return store.privateCommitBatch(request);},async () => {
      assertEntry();signal?.throwIfAborted();const job=scoped(request.jobId),batch=store.privatePreparedBatches(request.jobId).find(b=>b.batchId===request.batchId);
      if(!store.receipt(request.commandId) && (!batch || !await revalidate(job,batch))) throw new Error('派发quiet后扫描提交事实已改变。');
      assertEntry();signal?.throwIfAborted();
    });
  }
  async function execute(jobId:string,signal:AbortSignal):Promise<void> {
    let walk:Walk|undefined,walkCue=false,walkTokens=false;
    try {
      let job=scoped(jobId);
      // 失去本私有能力时保原 job/checkpoint；不能忽略新族文件后宣称 completed。
      if (!cueInputMetadataEnabled && typeof store.privateJobParserVersion === 'function'
        && store.privateJobParserVersion(job.jobId) === CUE_INPUT_SCAN_VERSION) throw new ScanYield('deferred');
      walk=new Walk(authority(job),signal,()=>{authority(job);},false,false,options.dsdMetadataEnabled === true,cueInputJob(job));
      while(!signal.aborted && !closing && job.phase === 'running') {
        authority(job);
        const pending=store.privatePreparedBatches(jobId);
        if(pending.length) {
          const batch=pending[0]!;
          if(!await revalidate(job,batch)) {store.privateAbandonBatch({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision,reason:'CONTENT_CHANGED'});continue;}
          if(signal.aborted) break;
          job=await commitFenced({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision},signal);continue;
        }
        const before=store.privateCheckpoint(jobId),frontier=before?.frontier ?? [''],allowCueTokens=store.privateCueAwareCheckpoint(jobId),cueMode=allowCueTokens && (frontier[0]?.startsWith('~cue-v1/') ?? false);
        if(cueMode !== walkCue || allowCueTokens !== walkTokens){await walk.close();walk=new Walk(authority(job),signal,()=>{authority(job);},cueMode,allowCueTokens,options.dsdMetadataEnabled === true,cueInputJob(job));walkCue=cueMode;walkTokens=allowCueTokens;}
        const discovered=await walk.next(frontier);
        // 一个CUE的最多99条事实为一短批，目录cursor在发现1项后即持久化。
        const items:ScanPreparedItem[]=[],cueItems:LocalCuePreparedItem[]=[];
        const parsed = await scheduleScanAlbums(discovered.relatives, frozenSettings.get(jobId)?.albumConcurrency ?? LOCAL_SCAN_DEFAULT_SETTINGS.albumConcurrency,
          signal, async (relative, local) => {
            try { return cueMode ? { cue: await cueItem(job, relative, local) } : { audio: await item(job, relative, local) }; }
            catch (error) {
              // 消失条目没有成功读取事实；保留旧实体，不造拒绝签名。
              if (error instanceof SourceFileError && error.code === 'MISSING') return null;
              throw error;
            }
          });
        for (const value of parsed) { if (value && 'cue' in value) cueItems.push(value.cue!); else if (value && 'audio' in value && value.audio) items.push(value.audio); }
        if(signal.aborted || closing) throw new ScanYield('control');
        const batch:ScanPreparedBatch={batchId:randomUUID(),jobId,expectedJobRevision:job.jobRevision,checkpointBefore:job.checkpointRef,
          items,frontier:discovered.frontier,completed:discovered.frontier.length === 0,...(discovered.cueAware ? {kind:'cue-sidecars-v1' as const,cueItems}:{})};
        // 完整body先不可变prepare；任何commit前再次核真实stat，实体/子账本/checkpoint在同一短事务。
        store.privatePrepareBatch({commandId:randomUUID(),jobId,batch});
        if(!await revalidate(job,batch)) {store.privateAbandonBatch({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision,reason:'CONTENT_CHANGED'});await walk.close();continue;}
        if(signal.aborted || closing) throw new ScanYield('control');
        job=await commitFenced({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision},signal);
      }
      if (scoped(jobId).phase === 'completed') {
        // 完成快照只在真实目录句柄quiet之后捕获；失败独立于已完成的扫描事实。
        await walk.close(); walk = undefined;
        await options.onCompleted?.(scoped(jobId), { retry: false });
      }
    } catch(error) {
      if(error instanceof ScanFatal) {fatal=error;throw error;}
      const current=scoped(jobId);
      if(current.phase === 'running' && !signal.aborted) {
        if(error instanceof ScanYield || error instanceof SourceFileError && ['REVOKED','SOURCE_ROOT_OFFLINE'].includes(error.code))
          store.pause({commandId:randomUUID(),jobId,expectedRevision:current.jobRevision});
        else store.privateFail({commandId:randomUUID(),jobId,expectedRevision:current.jobRevision,
          code:error instanceof Error && error.message === 'ROOT_REVISION_CHANGED' ? 'ROOT_REVISION_CHANGED':'SCAN_READ_FAILED'});
      }
    } finally {await walk?.close();}
  }
  function launch(job:ScanJobRecord):void {
    if(runs.has(job.jobId) || job.phase !== 'running') return;
    let frozen = options.settings?.frozen(options.identity!, job.jobId) ?? frozenSettings.get(job.jobId);
    if (!frozen) {
      const settings = options.settings?.read(options.identity!) ?? LOCAL_SCAN_DEFAULT_SETTINGS;
      frozen = { jobId: job.jobId, settingsRevision: settings.revision, albumConcurrency: settings.albumConcurrency, readerConcurrency: 1 };
      if (options.settings) frozen = options.settings.freeze(options.identity!, { schema: 1, datasetId: options.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'launch', frozen });
    }
    frozenSettings.set(job.jobId, Object.freeze({ ...frozen }));
    const controller=new AbortController();
    const done=Promise.resolve().then(()=>execute(job.jobId,controller.signal)).catch(error=>{fatal=error instanceof ScanFatal ? error:new ScanFatal('扫描资源收口失败。',error);}).finally(()=>runs.delete(job.jobId));
    runs.set(job.jobId,{controller,done});
  }
  async function quiet(jobId:string):Promise<void> {
    const run=runs.get(jobId);run?.controller.abort(new ScanYield('control'));if(run) await run.done;if(fatal) throw fatal;
  }
  return {
    start(request:LocalScanStartRequest):ScanJobRecord {assertEntry();const result=store.start({...request,datasetId:options.datasetId,parserVersion:cueInputMetadataEnabled ? CUE_INPUT_SCAN_VERSION : PARSER});
      // public原start回执固定pending；仅首次明确创建启动，不把UNKNOWN同body重试当自动恢复。
      if(result.created) {const running=store.resume({commandId:randomUUID(),jobId:result.job.jobId,expectedRevision:result.job.jobRevision});launch(running);}return result.job;},
    async pause(request:LocalScanTransitionRequest):Promise<ScanJobRecord> {assertEntry();const job=scoped(request.jobId);if(store.receipt(request.commandId) || job.jobRevision !== request.expectedRevision) return store.pause(request);await quiet(request.jobId);return store.pause(request);},
    async cancel(request:LocalScanTransitionRequest):Promise<ScanJobRecord> {assertEntry();const job=scoped(request.jobId);if(store.receipt(request.commandId) || job.jobRevision !== request.expectedRevision) return store.cancel(request);await quiet(request.jobId);return store.cancel(request);},
    resume(request:LocalScanTransitionRequest):ScanJobRecord {assertEntry();scoped(request.jobId);const old=store.receipt(request.commandId),result=store.resume(request);if(!old) launch(result);return result;},
    get(jobId:string):ScanJobRecord {assertEntry();return scoped(jobId);},
    page(page:{offset:number;limit:number}) {assertEntry();return store.page(options.datasetId,page);},
    receipt(commandId:string) {assertEntry();const receipt=store.receipt(commandId);if(receipt && receipt.result.datasetId !== options.datasetId) throw new Error('扫描回执不属于当前dataset。');return receipt;},
    async prepareBatch(request:{commandId:string;jobId:string;batch:ScanPreparedBatch}) {assertEntry();scoped(request.jobId);await quiet(request.jobId);
      // 第一张CUE-aware checkpoint只由生产Walk捕获/提交；可信IPC也不能给旧cursor换解释。
      if(request.batch.kind === 'cue-sidecars-v1' && !store.privateCueAwareCheckpoint(request.jobId)) throw new Error('CUE阶段尚无实际持久checkpoint/receipt来源。');if(!await revalidate(scoped(request.jobId),request.batch)) throw new Error('扫描准备事实已改变。');return store.privatePrepareBatch(request);},
    async commitBatch(request:{commandId:string;jobId:string;batchId:string;expectedRevision:string}) {assertEntry();scoped(request.jobId);await quiet(request.jobId);const batch=store.privatePreparedBatches(request.jobId).find(b=>b.batchId === request.batchId);
      if(!store.receipt(request.commandId) && (!batch || !await revalidate(scoped(request.jobId),batch))) throw new Error('扫描提交事实已改变。');return commitFenced(request);},
    async yieldForMedia():Promise<void> {assertEntry();for(const jobId of [...runs.keys()]) {await quiet(jobId);const job=scoped(jobId);if(job.phase === 'running') store.pause({commandId:randomUUID(),jobId,expectedRevision:job.jobRevision});}},
    close():Promise<void> {if(closed) return closed;closing=true;readerTurn.close();closed=(async()=>{for(const run of runs.values()) run.controller.abort(new ScanYield('control'));await Promise.all([...runs.values()].map(r=>r.done));await Promise.all([reader.close(),cueReader.close()]);if(fatal) throw fatal;})();return closed;},
    async retryCompletedSnapshot(jobId: string): Promise<void> {
      assertEntry(); const job = scoped(jobId); authority(job);
      if (job.phase !== 'completed' || runs.has(jobId) || !options.onCompleted) throw new Error('只有资源已关闭的完成扫描可独立重试快照。');
      // 原completed job/frozen/文件批均不改变，不launch、resume或调用Reader。
      await options.onCompleted(job, { retry: true }); assertEntry();
    },
    async privateQuiesceLibrary(libraryId:string,context:{signal?:AbortSignal;deadlineAtMs?:number}={}):Promise<void>{
      const accepting=()=>{assertEntry();if(context.signal?.aborted||context.deadlineAtMs!==undefined&&performance.now()>=context.deadlineAtMs)throw new Error('原本库扫描join尚未在同Owner期限内确认。');};
      accepting();const original=options.repository.localCatalog.root(libraryId);
      if(original.role!=='library')throw new Error('仅原library可以停止本库扫描。');
      let expected:number|null=null;
      for(let offset=0;;){accepting();const page=store.page(options.datasetId,{offset,limit:200});
        if(expected!==null&&expected!==page.total)throw new Error('本库停止期间扫描清单已变化，未撤绑定。');expected=page.total;
        for(const job of page.items.filter(job=>job.libraryRootId===libraryId)){
          if(job.phase==='running'&&!runs.has(job.jobId))throw new Error('原running扫描没有当前实际join作者，不能凭空Map撤库。');
          await quiet(job.jobId);accepting();const current=scoped(job.jobId);
          if(!['completed','cancelled','failed'].includes(current.phase))store.cancel({commandId:randomUUID(),jobId:current.jobId,expectedRevision:current.jobRevision});}
        offset+=page.items.length;if(!page.hasMore)break;}
      accepting();
    },
    privateFrozenSettings(jobId: string) { assertCurrent(); const value = frozenSettings.get(jobId) ?? options.settings?.frozen(options.identity!, jobId); return value ? { ...value } : null; },
    privateReaderTurn: () => readerTurn.inspect(),
    privateWait(jobId:string):Promise<void> {return runs.get(jobId)?.done ?? Promise.resolve();},
  };
}
export type LocalScanCoordinator=ReturnType<typeof createLocalScanCoordinator>;
