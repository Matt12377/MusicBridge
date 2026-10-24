import { withLocalFactsMutation } from '../stream/local-source-fence.js';
import { logLibraryOperation } from '../shared/library-operation-log.js';
import { createScanReaderTurn, scheduleScanAlbums, LOCAL_SCAN_DEFAULT_SETTINGS, type LocalScanSettingsStore, type LocalScanFrozenSettings } from './local-scan-settings.js';
import type { DatasetIdentity } from '../recording/dataset-identity.js';
import { randomUUID } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import { isLocalMetadata, isLocalCatalogText, isCollectionId, isAudioAsset, isLocalTrack, isLocalCatalogRevision,
  type LocalMetadata, type ScanJobRecord, type LocalScanStartRequest, type LocalScanTransitionRequest } from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import type { DatasetProjectionPort, DatasetProjectionCommandResults } from './dataset-owner-protocol.js';
import { LocalSourceReadError } from './local-source-read-projection.js';
import { SourceFileError, MetadataLeaseReleaseError, withCheckedReadonlyMetadataSource, sourceRootAvailability, readonlySourceCandidateMetadata, type RootCapability } from '../recording/source-files.js';
import { observeRelocationFile } from './source-relocation-verify.js';
import { createMetadataReader, readRelocationMetadata } from '../library/metadata-reader.js';
import { ArtistMetadataBackfillDeferred, type ArtistMetadataBackfillCandidate } from './local-artist-metadata-types.js';
import { METADATA_PARSER_VERSION, RUST_MEDIA_METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION, CUE_INPUT_SCAN_VERSION, type MetadataReaderPort, type MetadataRawFields, type MetadataReadResult } from '../library/metadata-reader-types.js';
import { scanRelativePath, scanCanonical, type ScanPreparedBatch, type ScanPreparedItem, type ScanDiscovery, type RelocationPreparedScanRead } from './local-scan-store.js';
import type { RelocationCatalogCommitContext, RelocationScanReadRequest } from './source-relocation-scan-port.js';
import type { RelocationReadAccess } from './source-relocation-verify.js';
import {createCueSidecarReader,type CueSidecarReader,type CueSidecarReadResult} from '../library/cue-sidecar-reader.js';
import {createCueSidecarBulkReader} from '../library/cue-sidecar-bulk-reader.js';
import {parseCueText} from '../library/cue-text-reader.js';
import type {LocalCuePreparedItem,LocalCueAssetReference} from '@music-bridge/contracts';
const CUE_PARSER='cue-text-75fps/mbrs003-v1';

const PARSER = RUST_MEDIA_METADATA_PARSER_VERSION;
const DISCOVERY_TARGET_BYTES = 1024 * 1024, SCAN_FLUSH_MS = 250, SCAN_FLUSH_ITEMS = 16;
const DISCOVERY_DIRECTORY_HANDLES = 8;
const cueAudio = /\.(ogg|oga|opus|wv|ape|tta|mpc|mpp|mp\+|tak)$/iu;
const audio = /\.(flac|mp3|m4a|mp4|aac|wav|wave|aif|aiff)$/iu;
const dsdAudio = /\.(dsf|dff)$/iu;
class ScanYield extends Error { constructor(readonly reason: 'media-busy'|'admission-closed'|'deferred'|'control') { super(reason); } }
class ScanRetry extends Error {}
class ScanFatal extends Error { constructor(message: string, cause?: unknown) { super(message,{cause}); } }
type ScanDiscoveryFailureCode = 'DISCOVERY_FRONTIER_LIMIT'|'DISCOVERY_CURSOR_INVALID'|'DISCOVERY_DIRECTORY_CHECK_FAILED'
  |'DISCOVERY_DIRECTORY_OPEN_FAILED'|'DISCOVERY_DIRECTORY_READ_FAILED'|'DISCOVERY_DIRECTORY_CLOSE_FAILED';
class ScanDiscoveryFailure extends Error { constructor(readonly code:ScanDiscoveryFailureCode) { super('扫描目录发现失败。'); } }
async function discoveryOperation<T>(code:ScanDiscoveryFailureCode,operation:()=>Promise<T>):Promise<T> {
  try {return await operation();}
  catch(error) {
    if(error instanceof SourceFileError && ['REVOKED','SOURCE_ROOT_OFFLINE'].includes(error.code))throw error;
    throw new ScanDiscoveryFailure(code);
  }
}
interface Cursor { relative: string; skip: number; signature: string | null }
const cursorToken = (cursor: Cursor,mode:'audio'|'pending'|'cue'='audio'): string => `${mode === 'cue' ? '~cue-v1/':mode === 'pending' ? '~scan-cue-v1/':'~scan-v1/'}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
function cursorFrom(token: string,allowCueTokens=false): Cursor {
  const prefix=(allowCueTokens ? ['~scan-v1/','~scan-cue-v1/','~cue-v1/','~cue-manifest-v1/']:['~scan-v1/']).find(prefix=>token.startsWith(prefix));
  if(!prefix) return {relative:token,skip:0,signature:null};
  const value: unknown = JSON.parse(Buffer.from(token.slice(prefix.length),'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('扫描游标结构无效。');
  const v=value as Record<string,unknown>;
  if (Object.keys(v).length !== 3 || !(v.relative === '' || scanRelativePath(v.relative)) || typeof v.skip !== 'number'
    || !Number.isSafeInteger(v.skip) || v.skip<0 || !(v.signature === null || typeof v.signature === 'string' && v.signature.length <=512)) throw new Error('扫描游标结构无效。');
  return {relative:v.relative,skip:v.skip,signature:v.signature};
}
const cueManifestToken = (rowId=0,index=0): string => `~cue-manifest-v1/${Buffer.from(JSON.stringify({ relative: rowId ? `~discovery-${rowId}`:'', skip: index, signature: null })).toString('base64url')}`;
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
interface OpenDirectory {dir:Dir;relative:string;skip:number;signature:string}
/** 深度优先游标沿用原持久格式；少量只读目录句柄保留父级位置，冷恢复仍只重放对应目录的 skip。 */
class Walk {
  private readonly opened=new Map<string,OpenDirectory>();
  constructor(private readonly root:RootCapability,private readonly signal:AbortSignal,private readonly current:()=>void,private readonly cueMode=false,private readonly allowCueTokens=false,private readonly dsdEnabled=false,private readonly cueInputEnabled=false,private readonly useCueManifest=true) {}
  private check():void { this.current(); if(this.signal.aborted) throw new ScanYield('control'); }
  private async closeDirectory(relative:string):Promise<void> {
    const opened=this.opened.get(relative);if(!opened)return;
    await discoveryOperation('DISCOVERY_DIRECTORY_CLOSE_FAILED',()=>opened.dir.close());
    // 只有真实 close 确认后才移除；失败的句柄仍由 finally 收口，不能提前宣称 quiet。
    if(this.opened.get(relative)===opened)this.opened.delete(relative);
  }
  async close():Promise<void> {
    const results=await Promise.allSettled([...this.opened.keys()].map(relative=>this.closeDirectory(relative)));
    for(const result of results)if(result.status==='rejected')throw result.reason;
  }
  private async open(cursor:Cursor,observed:Awaited<ReturnType<typeof directory>>):Promise<OpenDirectory> {
    let opened=this.opened.get(cursor.relative);
    if(opened && (opened.skip!==cursor.skip || opened.signature!==observed.signature)) {
      await this.closeDirectory(cursor.relative);opened=undefined;
    }
    if(!opened) {
      if(this.opened.size>=DISCOVERY_DIRECTORY_HANDLES)await this.closeDirectory(this.opened.keys().next().value!);
      const dir=await discoveryOperation('DISCOVERY_DIRECTORY_OPEN_FAILED',()=>opendir(observed.absolute));
      opened={dir,relative:cursor.relative,skip:0,signature:observed.signature};this.opened.set(cursor.relative,opened);
      while(opened.skip<cursor.skip) {
        this.check();const entry=await discoveryOperation('DISCOVERY_DIRECTORY_READ_FAILED',()=>dir.read());this.check();
        if(!entry)throw new ScanDiscoveryFailure('DISCOVERY_CURSOR_INVALID');opened.skip++;
      }
    }
    this.opened.delete(cursor.relative);this.opened.set(cursor.relative,opened);return opened;
  }
  async next(frontier:readonly string[],budget=2000):Promise<{relatives:string[];frontiers:string[][];frontier:string[];cueRelatives:string[];cueAware:boolean}> {
    const queue=[...frontier],relatives:string[]=[],frontiers:string[][]=[],cueRelatives:string[]=[];
    const directories=new Map<string,Awaited<ReturnType<typeof directory>>>();
    let inspected=0,manifestBytes=0,foundCue=this.allowCueTokens || frontier.some(p=>p.startsWith('~scan-cue-v1/'));
    while(queue.length && relatives.length<(this.cueMode ? 1:64) && inspected<budget && manifestBytes<DISCOVERY_TARGET_BYTES) {
      this.check();let cursor:Cursor;
      try {cursor=cursorFrom(queue[0]!,this.allowCueTokens || this.cueMode);}
      catch {throw new ScanDiscoveryFailure('DISCOVERY_CURSOR_INVALID');}
      // 每个有界发现片段只核一次目录；源 FD 的真实读前/读后身份检查仍由原 Reader 完成。
      let observed=directories.get(cursor.relative);
      if(!observed) {observed=await discoveryOperation('DISCOVERY_DIRECTORY_CHECK_FAILED',()=>directory(this.root,cursor.relative));directories.set(cursor.relative,observed);}this.check();
      if(cursor.signature !== null && cursor.signature !== statSignature(observed)) {await this.closeDirectory(cursor.relative);cursor={relative:cursor.relative,skip:0,signature:null};}
      const opened=await this.open(cursor,observed);
      this.check();const entry=await discoveryOperation('DISCOVERY_DIRECTORY_READ_FAILED',()=>opened.dir.read());this.check();
      if(!entry) {await this.closeDirectory(cursor.relative);queue.shift();continue;}
      inspected++;opened.skip++;
      queue[0]=cursorToken({relative:cursor.relative,skip:opened.skip,signature:observed.signature},this.cueMode ? 'cue':'audio');
      const relative=cursor.relative ? `${cursor.relative}/${entry.name}` : entry.name;
      if(!scanRelativePath(relative) || entry.isSymbolicLink()) continue;
      // 父级续读位置留在 frontier，先完成新子目录；宽目录不再同时积压全部兄弟目录。
      if(entry.isDirectory()) {if(queue.length>=200)throw new ScanDiscoveryFailure('DISCOVERY_FRONTIER_LIMIT');queue.unshift(cursorToken({relative,skip:0,signature:null},this.cueMode ? 'cue':'audio'));}
      else if(entry.isFile()) {
        if(/\.cue$/iu.test(entry.name)) {
          foundCue=true;
          if(this.cueMode) {relatives.push(relative);frontiers.push([...queue]);}
          else {cueRelatives.push(relative);manifestBytes+=Buffer.byteLength(JSON.stringify(relative));}
        } else if(!this.cueMode && (audio.test(entry.name) || this.dsdEnabled && dsdAudio.test(entry.name) || this.cueInputEnabled && cueAudio.test(entry.name))) {
          relatives.push(relative);frontiers.push([...queue]);manifestBytes+=Buffer.byteLength(JSON.stringify([relative,queue]));
        }
      }
    }
    // 新任务按持久发现清单进入 CUE 阶段；旧 ~cue-v1 游标继续走原目录恢复路径。
    if(!this.cueMode && foundCue && queue.length===0) queue.push(this.useCueManifest ? cueManifestToken(0):cursorToken({relative:'',skip:0,signature:null},'cue'));
    return {relatives,frontiers,frontier:queue,cueRelatives,cueAware:this.allowCueTokens || this.cueMode || foundCue};
  }

}
/** Catalog现有512字符准入独立于reader4096 UTF8预算；拒绝整个item，保留字段名分类而不截断。 */
export function admitScanFields(fields:MetadataRawFields):{status:'accepted';fields:LocalMetadata}|{status:'rejected';code:string} {
  const names=['title','artist','album','year','disc','track','albumArtist','artists','albumArtists'] as const;
  if(![Object.prototype,null].includes(Object.getPrototypeOf(fields)) || Reflect.ownKeys(fields).some(k=>typeof k !== 'string' || !(names as readonly string[]).includes(k) || !Object.prototype.propertyIsEnumerable.call(fields,k))) return {status:'rejected',code:'CATALOG_METADATA_INVALID'};
  for(const key of names) { const value=fields[key];if(value !== undefined && (Array.isArray(value)
    ? value.length>64||value.some(v=>!isLocalCatalogText(v)) : !isLocalCatalogText(value,true))) return {status:'rejected',code:`CATALOG_FIELD_INVALID_${key.toUpperCase()}`}; }
  if(!isLocalMetadata(fields)) return {status:'rejected',code:'CATALOG_METADATA_INVALID'};
  return {status:'accepted',fields:{...fields}};
}
interface Running { controller:AbortController; done:Promise<void> }
export interface LocalScanCoordinatorOptions {
  /** 仅生产 Owner 组合显式选择；旧任务始终使用原 launch 冻结值。 */
  localScanReadProfile?: 'bulk-v2';
  identity?: DatasetIdentity;
  settings?: LocalScanSettingsStore;
  onCompleted?(job: ScanJobRecord, context?: { retry: boolean }): Promise<void>;
  /** 已提交批次的派生工作只唤醒，不参与扫描原事务与成功判定。 */
  onCommitted?(job: ScanJobRecord): void;
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
  const readConcurrency = options.localScanReadProfile === 'bulk-v2' ? 8 : 2;
  const readerTurn = createScanReaderTurn(readConcurrency), cueReaderTurn = createScanReaderTurn(1), cueBulkTurn = createScanReaderTurn(8), frozenSettings = new Map<string, LocalScanFrozenSettings>();
  const jobTurns = new Map<string, ReturnType<typeof createScanReaderTurn>>(), controlledJobs = new Set<string>(), controlledLibraries = new Set<string>();
  const verifiedEmbeddedDirectories = new Map<string, Set<string>>();
  const cueInputMetadataEnabled = options.cueInputMetadataEnabled === true;
  const store=options.repository.localScan,reader=options.reader ?? createMetadataReader({concurrency:readConcurrency,maxPending:0,dsdMetadataEnabled:options.dsdMetadataEnabled === true,cueInputMetadataEnabled});
  const cueReader=options.cueReader ?? createCueSidecarReader();
  let cueBulkReader:ReturnType<typeof createCueSidecarBulkReader>|undefined;
  const runs=new Map<string,Running>();let closing=false,fatal:ScanFatal|undefined,closed:Promise<void>|undefined;
  let recoveryEnabled=false,recoveryTimer:ReturnType<typeof setTimeout>|undefined,recoveryActive:Promise<void>|undefined,mediaYielding=0;
  const relocationPrepared = new WeakMap<object, { request: RelocationScanReadRequest; reads: readonly RelocationPreparedScanRead[]; consumed: boolean }>();
  function assertCurrent():void {if(fatal) throw fatal;options.assertCurrent();}
  function assertEntry():void {assertCurrent();options.assertReady?.();if(closing) throw new Error('扫描owner已关闭新入口。');}
  async function stage<T>(action:string,jobId:string,signal:AbortSignal|undefined,operation:()=>Promise<T>):Promise<T> {
    const started=performance.now();logLibraryOperation('scan',action,'start',{id:jobId});
    try {const value=await operation();logLibraryOperation('scan',action,'complete',{id:jobId,elapsedMs:performance.now()-started});return value;}
    catch(error){logLibraryOperation('scan',action,signal?.aborted ? 'cancelled':'error',{id:jobId,elapsedMs:performance.now()-started});throw error;}
  }
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
  async function consumeReadTurn<T>(job: ScanJobRecord, signal: AbortSignal, consume: () => Promise<T>): Promise<T> {
    const queued = performance.now(), current = () => readerTurn.consume(signal, async () => {
      logLibraryOperation('scan', 'scan.read-admission', 'complete', { id: job.jobId, queueWaitMs: performance.now() - queued, elapsedMs: performance.now() - queued, active: readerTurn.inspect().active });
      return consume();
    });
    logLibraryOperation('scan', 'scan.read-admission', 'start', { id: job.jobId, pending: readerTurn.inspect().waiting });
    try { const turn = jobTurns.get(job.jobId); return turn ? await turn.consume(signal, current) : await current(); }
    catch (error) { logLibraryOperation('scan', 'scan.read-admission', signal.aborted ? 'cancelled' : 'error', { id: job.jobId, queueWaitMs: performance.now() - queued, elapsedMs: performance.now() - queued }); throw error; }
  }
  async function admittedRead<T extends {status:'ok'|'failure';code?:string}>(job:ScanJobRecord,signal:AbortSignal,consume:(root:RootCapability,signal:AbortSignal)=>Promise<T>):Promise<T> {
    const projection=options.projection;
    if(!projection) throw new ScanYield('deferred');
    let acquired:DatasetProjectionCommandResults['scanReadAcquire'];
    try {acquired=await projection.call('scanReadAcquire',{},{signal});}
    catch(error) {
      // Owner 封口先于各读者 join；尚未取票的扫描沿原准入暂停，不把控制交错写成源读取失败。
      if(error instanceof LocalSourceReadError && (error.code==='SOURCE_READ_CLOSED' || signal.aborted && error.code==='SOURCE_READ_CANCELLED'))
        throw new ScanYield('admission-closed');
      throw error;
    }
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
    const quietStarted=performance.now();
    try {await projection.call('scanReadRelease',{permitId:acquired.permitId});await watch;
      logLibraryOperation('scan','scan.source-quiet','complete',{id:job.jobId,elapsedMs:performance.now()-quietStarted});}
    catch(error) {logLibraryOperation('scan','scan.source-quiet','error',{id:job.jobId,code:'SOURCE_QUIET_FAILED',elapsedMs:performance.now()-quietStarted});fatal=new ScanFatal('扫描quiet后票据释放未确认。',error);throw fatal;}
    if(watchFailure) {fatal=new ScanFatal('扫描读取watch收口失败。',watchFailure);throw fatal;}
    if(yielded) throw new ScanYield(yielded);
    if(signal.aborted) throw new ScanYield('control');return result;
  }
  function cueInputJob(job: ScanJobRecord): boolean {
    // job 公开 DTO 不带解析器版本；只读原 SQL 列，不由当前 options 给旧 job 改身份。
    return cueInputMetadataEnabled && store.privateJobParserVersion(job.jobId) === CUE_INPUT_SCAN_VERSION;
  }
  function metadataFitsJob(job: ScanJobRecord, result: Extract<MetadataReadResult, { status: 'ok' }>): boolean {
    if (!cueInputJob(job)) return (result.parserVersion === METADATA_PARSER_VERSION || result.parserVersion === RUST_MEDIA_METADATA_PARSER_VERSION)
      && ['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF'].includes(result.technical.container);
    return ['TTA','TAK'].includes(result.technical.container) ? result.parserVersion === CUE_HEADER_METADATA_PARSER_VERSION
      : result.parserVersion === METADATA_PARSER_VERSION || result.parserVersion === RUST_MEDIA_METADATA_PARSER_VERSION;
  }
  function itemParser(job: ScanJobRecord, relative: string, container?: string): string {
    return cueInputJob(job) && (container === undefined ? /\.(tta|tak)$/iu.test(relative) : ['TTA','TAK'].includes(container))
      ? CUE_HEADER_METADATA_PARSER_VERSION : RUST_MEDIA_METADATA_PARSER_VERSION;
  }
  function rememberEmbeddedDirectory(jobId:string,directory:string):void {
    const known=verifiedEmbeddedDirectories.get(jobId);if(!known || known.has(directory))return;
    if(known.size>=128)known.delete(known.values().next().value!);known.add(directory);
  }
  async function read(job:ScanJobRecord,relative:string,signature:string,signal:AbortSignal,libraryCurrent?:()=>boolean):Promise<MetadataReadResult> {
    const directory=path.posix.dirname(relative);
    const result = await consumeReadTurn(job,signal, () => admittedRead(job,signal,(root,local)=>{
      // 仅旧曲目补读携带活动库检查；排队取票后再次核对，不调用已撤库的Reader。
      if(libraryCurrent && !libraryCurrent())return Promise.resolve({status:'failure',code:'REVOKED',readEvidence:null} as const);
      const includeEmbeddedArtwork=!verifiedEmbeddedDirectories.get(job.jobId)?.has(directory);
      if(!includeEmbeddedArtwork)logLibraryOperation('scan','scan.embedded-artwork','skipped',{id:job.jobId,code:'DIRECTORY_COVER_VERIFIED'});
      return reader.read({root,relative,expectedSignature:signature,includeEmbeddedArtwork,assertCurrent:()=>{
        authority(job);if(libraryCurrent && !libraryCurrent())throw new SourceFileError('REVOKED');
      }},local);
    }));
    // 同启用 Reader 恢复旧 job 时，晚返回的新族事实仍明确拒绝，真实 FD/Worker 已先 quiet。
    if(result.status === 'ok' && !metadataFitsJob(job,result))return {status:'failure',code:'UNSUPPORTED',readEvidence:result.readEvidence};
    if(result.status==='ok' && result.coverEvidence.length)rememberEmbeddedDirectory(job.jobId,directory);
    return result;
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
      const result = await consumeReadTurn(admissionJob,signal, () => admittedRead(admissionJob, signal, (_root, local) => readRelocationMetadata(reader,
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
    const checked=new Map<string,LocalCueAssetReference>();
    for(const track of result.tracks) {
      authority(job);const ref=track.assetReference,known=checked.get(ref.relative);
      if(known){if(scanCanonical(known)!==scanCanonical(ref))return false;continue;}
      const selected=store.privateCueAssociation(job.libraryRootId,ref.relative);
      if(selected.status !== 'bound') return false;const captured=selected.reference;
      if((['assetId','libraryRootId','sourceRootId','rootRevision','fileRevision','locationRevision','relative','signature'] as const).some(key=>captured[key] !== ref[key]) || ref.sourceRootId !== job.sourceRootId || ref.rootRevision !== job.rootRevision) return false;
      try {if((await readonlySourceCandidateMetadata(authority(job),ref.relative)).signature !== ref.signature) return false;}
      catch(error) {if(error instanceof SourceFileError && ['MISSING','OUTSIDE_ROOT','CONTENT_CHANGED'].includes(error.code)) return false;throw error;}
      checked.set(ref.relative,ref);
    }
    return true;
  }
  async function cueItem(job:ScanJobRecord,relative:string,signal:AbortSignal):Promise<LocalCuePreparedItem> {
    return stage('scan.cue',job.jobId,signal,()=>cueItemBody(job,relative,signal));
  }
  async function cueItemBody(job:ScanJobRecord,relative:string,signal:AbortSignal):Promise<LocalCuePreparedItem> {
    const stat=await readonlySourceCandidateMetadata(authority(job),relative),prior=store.privateCueSnapshot(job.libraryRootId,relative);
    const base={relative,signature:stat.signature,parserVersion:CUE_PARSER,previousSnapshotId:prior?.id ?? null};
    if(prior?.item.outcome === 'accepted' && prior.item.result && prior.item.signature === stat.signature && prior.item.parserVersion === CUE_PARSER
      && await currentCueReferences(job,prior.item.result)) return {...base,outcome:'accepted',failureCode:null,reused:true,result:prior.item.result};
    const bulk=frozenSettings.get(job.jobId)?.readerConcurrency===8, turn=bulk ? cueBulkTurn:cueReaderTurn;
    const value:CueSidecarReadResult=await turn.consume(signal,()=>consumeReadTurn(job,signal, () => admittedRead(job,signal,(root,local)=>{
      const selected=bulk ? options.cueReader ?? (cueBulkReader ??= createCueSidecarBulkReader()):cueReader;
      return selected.read({root,relative,expectedSignature:stat.signature,assertCurrent:()=>{authority(job);}},local);
    })));
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
      const observed = await consumeReadTurn(job, signal, () => admittedRead(job, signal, async (currentRoot, local) => {
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
      }));
      // 只有本计划明确保源且当前完整Hash/物理身份仍一致才跳过；同内容其它拷贝仍是独立候选。
      if (observed.status === 'ok' && observed.skipped) return null;
    }
    const previous=store.privateCurrentFileState(job.libraryRootId,relative);
    const cachedContainer = previous?.value.readFacts?.technical.container, parserVersion = itemParser(job, relative, cachedContainer);
    const cacheAllowed = cueInputJob(job) || cachedContainer === undefined || ['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF'].includes(cachedContainer);
    if(cacheAllowed && previous?.value.outcome === 'accepted' && previous.value.signature === stat.signature && (previous.value.parserVersion === parserVersion || parserVersion === RUST_MEDIA_METADATA_PARSER_VERSION && previous.value.parserVersion === METADATA_PARSER_VERSION)) {
      const asset=options.repository.localCatalog.asset(previous.value.assetId!);
      if(asset.sourceRootId === job.sourceRootId && asset.rootRevision === job.rootRevision) {
        if(previous.value.readFacts?.coverEvidence.length)rememberEmbeddedDirectory(job.jobId,path.posix.dirname(relative));
        return {relative,signature:stat.signature,parserVersion:previous.value.parserVersion,outcome:'accepted',fields:{},failureCode:null,reused:true,readFacts:null};
      }
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
  async function revalidate(job:ScanJobRecord,batch:ScanPreparedBatch,signal=new AbortController().signal):Promise<boolean> {
    return stage('scan.revalidate',job.jobId,signal,()=>revalidateBody(job,batch,signal));
  }
  async function revalidateBody(job:ScanJobRecord,batch:ScanPreparedBatch,signal:AbortSignal):Promise<boolean> {
    const root=authority(job);
    const matches=async(prepared:{relative:string;signature:string}):Promise<boolean>=>{
      signal.throwIfAborted();
      try {const actual=await readonlySourceCandidateMetadata(root,prepared.relative);signal.throwIfAborted();return actual.signature===prepared.signature;}
      catch(error) {signal.throwIfAborted();if(error instanceof SourceFileError && ['MISSING','CONTENT_CHANGED','OUTSIDE_ROOT'].includes(error.code)) return false;throw error;}
    };
    // 仅原冻结八槽任务并行；旧任务和未launch的公开prepare仍沿用串行重核。
    const concurrency=frozenSettings.get(job.jobId)?.readerConcurrency===8 ? 8:1;
    let cursor=0,unchanged=true,stopped=false;
    const worker=async():Promise<void>=>{
      while(!stopped && !signal.aborted) {
        const prepared=batch.items[cursor++];if(!prepared)return;
        try {
          // 与解析共用jobTurn→全局readerTurn；回调进入前解析已释放原槽，不能另开八槽池。
          const same=await consumeReadTurn(job,signal,()=>stopped ? Promise.resolve(true):matches(prepared));
          if(!same){unchanged=false;stopped=true;}
        } catch(error){stopped=true;throw error;}
      }
    };
    // 失败或取消都等全部已启动/排队检查settled；底层stat没有可提前归还的取消接口。
    const settled=await Promise.allSettled(Array.from({length:Math.min(concurrency,batch.items.length)},worker));
    const rejected=settled.find((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(rejected)throw rejected.reason;
    signal.throwIfAborted();
    if(!unchanged)return false;
    // CUE本体和引用保持原串行核验；两轮调用各自重读，不共享stat观察。
    for(const prepared of batch.cueItems ?? []) if(!await matches(prepared))return false;
    for(const cue of batch.cueItems ?? []) {
      signal.throwIfAborted();
      if(cue.result){const current=await currentCueReferences(job,cue.result);signal.throwIfAborted();if(!current)return false;}
    }
    signal.throwIfAborted();
    return true;
  }
  async function commitFenced(request:{commandId:string;jobId:string;batchId:string;expectedRevision:string},signal?:AbortSignal):Promise<ScanJobRecord> {
    const started=performance.now();let commitMs=0;logLibraryOperation('scan','scan.commit','start',{id:request.jobId});
    try { const result=await withLocalFactsMutation(() => {assertEntry();signal?.throwIfAborted();const committing=performance.now();try{return store.privateCommitBatch(request);}finally{commitMs+=performance.now()-committing;}},async () => {
      assertEntry();signal?.throwIfAborted();const job=scoped(request.jobId),batch=store.privatePreparedBatches(request.jobId).find(b=>b.batchId===request.batchId);
      if(!store.receipt(request.commandId) && (!batch || !await revalidate(job,batch,signal))) throw new Error('派发quiet后扫描提交事实已改变。');
      assertEntry();signal?.throwIfAborted();
    });
      logLibraryOperation('scan','scan.commit','complete',{id:request.jobId,elapsedMs:performance.now()-started,commitMs});
      try{options.onCommitted?.(result);}catch{logLibraryOperation('artwork','artwork.background.notify','error',{id:request.jobId,code:'BACKGROUND_QUEUE_FAILED'});}return result;
    } catch(error){logLibraryOperation('scan','scan.commit',signal?.aborted ? 'cancelled':'error',{id:request.jobId,elapsedMs:performance.now()-started,commitMs});throw error;}
  }
  /** 新八槽manifest只预读未来有限项；每个持久discovery与commit仍严格一项。 */
  function cuePrefetch(job:ScanJobRecord,frontier:readonly string[],discovery:ScanDiscovery,parent:AbortSignal) {
    if(frozenSettings.get(job.jobId)?.readerConcurrency!==8 || !discovery.cueMode || discovery.entries.length!==1
      || frontier.length!==1 || !frontier[0]?.startsWith('~cue-manifest-v1/'))return null;
    const entries:{before:string;relative:string;frontier:string[]}[]=[],seen=new Set<string>();
    let cursorFrontier=[...frontier];
    for(let index=0;index<8 && cursorFrontier.length;index++) {
      parent.throwIfAborted();
      const before=cursorFrontier[0]!,cursor=cursorFrom(before,true),match=/^~discovery-(0|[1-9][0-9]*)$/u.exec(cursor.relative);
      if(cursor.relative!=='' && !match)throw new Error('CUE预读清单游标无效。');
      const rowId=match ? Number(match[1]):0;if(!Number.isSafeInteger(rowId))throw new Error('CUE预读清单游标超出预算。');
      const page=store.privateDiscoveredCuePage(job.jobId,{rowId,index:cursor.skip},1),relative=page.relatives[0];
      if(relative===undefined || seen.has(relative))break;
      const next=page.hasMore ? [cueManifestToken(page.next.rowId,page.next.index)]:[];
      entries.push({before,relative,frontier:next});seen.add(relative);cursorFrontier=next;
    }
    if(!entries.length || entries[0]!.relative!==discovery.entries[0]!.relative
      || scanCanonical(entries[0]!.frontier)!==scanCanonical(discovery.frontier))return null;
    type Outcome={ok:true;value:LocalCuePreparedItem|null}|{ok:false;error:unknown};
    const slots=entries.map(entry=>{
      let resolve!:(value:Outcome)=>void;
      const result=new Promise<Outcome>(settle=>{resolve=settle;});
      return {entry,result,resolve,settled:false};
    });
    const control=new AbortController(),signal=AbortSignal.any([parent,control.signal]);
    const settle=(index:number,outcome:Outcome):void=>{const slot=slots[index]!;if(!slot.settled){slot.settled=true;slot.resolve(outcome);}};
    const done=scheduleScanAlbums(entries.map(entry=>entry.relative),frozenSettings.get(job.jobId)?.albumConcurrency ?? LOCAL_SCAN_DEFAULT_SETTINGS.albumConcurrency,
      signal,async(relative,local):Promise<LocalCuePreparedItem|null>=>{
        try{return await cueItem(job,relative,local);}catch(error){if(error instanceof SourceFileError && error.code==='MISSING')return null;throw error;}
      },(value,index)=>settle(index,{ok:true,value}),8).then(()=>{
        for(let index=0;index<slots.length;index++)if(!slots[index]!.settled)settle(index,{ok:false,error:new Error('CUE预读窗口未完整收口。')});
      },error=>{control.abort(error);for(let index=0;index<slots.length;index++)settle(index,{ok:false,error});});
    return {
      matches(before:readonly string[],relative:string):boolean{return before.length===1 && slots.some(slot=>slot.entry.before===before[0] && slot.entry.relative===relative);},
      async take(before:readonly string[],relative:string,local:AbortSignal):Promise<LocalCuePreparedItem|null> {
        const slot=slots.find(value=>before.length===1 && value.entry.before===before[0] && value.entry.relative===relative);
        if(!slot)throw new Error('CUE预读项不属于当前原游标。');
        const abort=():void=>control.abort(local.reason);local.addEventListener('abort',abort,{once:true});
        try {local.throwIfAborted();const outcome=await slot.result;local.throwIfAborted();if(!outcome.ok)throw outcome.error;return outcome.value;}
        catch(error){control.abort(error);await done;throw error;}
        finally{local.removeEventListener('abort',abort);}
      },
      async close():Promise<void>{control.abort();await done;},
    };
  }
  async function execute(jobId:string,signal:AbortSignal):Promise<void> {
    const started = performance.now();
    let walk:Walk|undefined,walkCue=false,walkTokens=false;
    let cueWindow:ReturnType<typeof cuePrefetch>=null;
    logLibraryOperation('scan', 'scan.job', 'start', { id: jobId });
    try {
      let job=scoped(jobId);
      const flushItems=frozenSettings.get(jobId)?.readerConcurrency===8 ? 64:SCAN_FLUSH_ITEMS;
      // 失去本私有能力时保原 job/checkpoint；不能忽略新族文件后宣称 completed。
      if (!cueInputMetadataEnabled && typeof store.privateJobParserVersion === 'function'
        && store.privateJobParserVersion(job.jobId) === CUE_INPUT_SCAN_VERSION) throw new ScanYield('deferred');
      walk=new Walk(authority(job),signal,()=>{authority(job);},false,false,options.dsdMetadataEnabled === true,cueInputJob(job),store.privateUseCueDiscoveryManifest?.(jobId) ?? false);
      while(!signal.aborted && !closing && job.phase === 'running') {
        authority(job);
        const pending=store.privatePreparedBatches(jobId);
        if(pending.length) {
          const batch=pending[0]!;
          if(!await revalidate(job,batch,signal)) {store.privateAbandonBatch({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision,reason:'CONTENT_CHANGED'});continue;}
          if(signal.aborted) break;
          job=await commitFenced({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision},signal);continue;
        }
        const before=store.privateCheckpoint(jobId),frontier=before?.frontier ?? [''],allowCueTokens=store.privateCueAwareCheckpoint(jobId);
        const persisted = typeof store.privatePendingDiscovery === 'function' ? store.privatePendingDiscovery(jobId) : null;
        let discovery:ScanDiscovery, consumed=persisted?.consumed ?? 0;
        const discoveryStarted=performance.now();
        logLibraryOperation('scan', 'scan.discovery', 'start', { id: jobId });
        try {if(persisted) {
          discovery=persisted.discovery;
          logLibraryOperation('scan', 'scan.discovery', 'hit', { id: jobId, count: discovery.entries.length-consumed, elapsedMs:performance.now()-discoveryStarted });
        } else {
          const manifestMode=allowCueTokens && (frontier[0]?.startsWith('~cue-manifest-v1/') ?? false);
          const cueMode=manifestMode || allowCueTokens && (frontier[0]?.startsWith('~cue-v1/') ?? false);
          if(manifestMode) {
            const cursor=cursorFrom(frontier[0]!,true),match=/^~discovery-(0|[1-9][0-9]*)$/u.exec(cursor.relative);
            if(cursor.relative!=='' && !match)throw new Error('CUE发现清单游标无效。');
            const rowId=match ? Number(match[1]):0;if(!Number.isSafeInteger(rowId))throw new Error('CUE发现清单游标超出预算。');
            const page=store.privateDiscoveredCuePage(jobId,{rowId,index:cursor.skip},1);
            const next=page.hasMore ? [cueManifestToken(page.next.rowId,page.next.index)]:[];
            discovery={discoveryId:randomUUID(),jobId,checkpointBefore:job.checkpointRef,
              entries:page.relatives.map(relative=>({relative,frontier:next})),frontier:next,cueRelatives:[],cueAware:true,cueMode:true};
          } else {
            if(cueMode !== walkCue || allowCueTokens !== walkTokens){await walk.close();walk=new Walk(authority(job),signal,()=>{authority(job);},cueMode,allowCueTokens,options.dsdMetadataEnabled === true,cueInputJob(job),store.privateUseCueDiscoveryManifest?.(jobId) ?? false);walkCue=cueMode;walkTokens=allowCueTokens;}
            const found=await walk.next(frontier);
            discovery={discoveryId:randomUUID(),jobId,checkpointBefore:job.checkpointRef,
              entries:found.relatives.map((relative,index)=>({relative,frontier:found.frontiers[index]!})),frontier:found.frontier,
              cueRelatives:found.cueRelatives,cueAware:found.cueAware,cueMode};
          }
          signal.throwIfAborted();
          store.privateRecordDiscovery?.({commandId:randomUUID(),jobId,expectedRevision:job.jobRevision,discovery});
        }
        } catch(error){logLibraryOperation('scan','scan.discovery',signal.aborted ? 'cancelled':'error',{
          id:jobId,code:error instanceof ScanDiscoveryFailure ? error.code:error instanceof SourceFileError && ['REVOKED','SOURCE_ROOT_OFFLINE'].includes(error.code) ? error.code:'DISCOVERY_FAILED',elapsedMs:performance.now()-discoveryStarted});throw error;}
        logLibraryOperation('scan', 'scan.discovery', 'complete', { id: jobId, count:discovery.entries.length-consumed, elapsedMs:performance.now()-discoveryStarted });
        const batchItems=discovery.cueMode ? 1:flushItems;
        if(discovery.cueMode && discovery.entries.length===1) {
          const relative=discovery.entries[0]!.relative;
          if(!cueWindow?.matches(frontier,relative)){await cueWindow?.close();cueWindow=cuePrefetch(job,frontier,discovery,signal);}
        } else {await cueWindow?.close();cueWindow=null;}
        type ParsedItem={cue:LocalCuePreparedItem}|{audio:ScanPreparedItem|null}|null;
        const results=new Map<number,ParsedItem>(), control=new AbortController(), parseSignal=AbortSignal.any([signal,control.signal]);
        let flushed=consumed,finalized=false,flushFailure:unknown,flushChain=Promise.resolve();
        const flush=async (finish=false):Promise<void>=>{
          parseSignal.throwIfAborted();
          while(!finalized) {
            let end=flushed;while(end<discovery.entries.length && results.has(end) && end-flushed<batchItems)end++;
            if(end===flushed && !(finish && discovery.entries.length===0))return;
            const final=end===discovery.entries.length;
            const items:ScanPreparedItem[]=[],cueItems:LocalCuePreparedItem[]=[];
            for(let index=flushed;index<end;index++){const value=results.get(index);if(value && 'cue' in value)cueItems.push(value.cue);else if(value && 'audio' in value && value.audio)items.push(value.audio);}
            const batch:ScanPreparedBatch={batchId:randomUUID(),jobId,expectedJobRevision:job.jobRevision,checkpointBefore:job.checkpointRef,
              items,frontier:final ? discovery.frontier:discovery.entries[end-1]!.frontier,completed:final && discovery.frontier.length===0,
              ...(discovery.cueAware ? {kind:'cue-sidecars-v1' as const,cueItems}:{})};
            // 只提交原顺序中已完成的连续前缀；后续在途读取不会令checkpoint越过未完成项。
            parseSignal.throwIfAborted();
            await stage('scan.prepare',jobId,parseSignal,async()=>{store.privatePrepareBatch({commandId:randomUUID(),jobId,batch});});
            if(!await revalidate(job,batch,parseSignal)) {store.privateAbandonBatch({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision,reason:'CONTENT_CHANGED'});throw new ScanRetry();}
            parseSignal.throwIfAborted();
            job=await commitFenced({commandId:randomUUID(),jobId,batchId:batch.batchId,expectedRevision:job.jobRevision},parseSignal);
            // 只在原批次真正提交后计数；续扫复用与新读取分开，避免将检查点跳涨当成读取吞吐。
            const committedItems=[...items,...cueItems],fresh=committedItems.filter(value=>!value.reused),reused=committedItems.length-fresh.length;
            const batchAction=discovery.cueMode ? 'scan.batch.cue':'scan.batch.audio';
            logLibraryOperation('scan',batchAction,'complete',{id:jobId,code:'FRESH',count:fresh.length,
              accepted:fresh.filter(value=>value.outcome==='accepted').length,rejected:fresh.filter(value=>value.outcome==='rejected').length});
            if(reused)logLibraryOperation('scan',batchAction,'hit',{id:jobId,code:'REUSED',count:reused});
            logLibraryOperation('scan','scan.progress.committed','progress',{id:jobId,code:discovery.cueMode ? 'CUE':'AUDIO',
              visited:Number(job.progress.visited),accepted:Number(job.progress.accepted),rejected:Number(job.progress.rejected)});
            for(let index=flushed;index<end;index++)results.delete(index);
            flushed=end;finalized=final;
          }
        };
        const requestFlush=(finish=false):Promise<void>=>{
          flushChain=flushChain.then(()=>flushFailure ? undefined:flush(finish)).catch(error=>{flushFailure=error;control.abort(error);});
          return flushChain;
        };
        const timer=setInterval(()=>{void requestFlush();},SCAN_FLUSH_MS);timer.unref?.();
        let parseFailure:unknown;
        try {
          await scheduleScanAlbums(discovery.entries.slice(consumed).map(entry=>entry.relative),frozenSettings.get(jobId)?.albumConcurrency ?? LOCAL_SCAN_DEFAULT_SETTINGS.albumConcurrency,
            parseSignal,async(relative,local):Promise<ParsedItem>=>{
              try{if(!discovery.cueMode)return {audio:await item(job,relative,local)};
                const value=cueWindow?.matches(frontier,relative) ? await cueWindow.take(frontier,relative,local):await cueItem(job,relative,local);
                return value ? {cue:value}:null;}
              catch(error){if(error instanceof SourceFileError && error.code==='MISSING')return null;throw error;}
            },async(value,index)=>{results.set(consumed+index,value);let ready=flushed;while(results.has(ready))ready++;if(ready-flushed>=batchItems)await requestFlush();},discovery.cueMode ? 1 : frozenSettings.get(jobId)?.readerConcurrency ?? 2);
          await requestFlush(true);
        } catch(error){parseFailure=error;control.abort(error);}
        finally {clearInterval(timer);await flushChain;}
        if(flushFailure instanceof ScanRetry){await cueWindow?.close();cueWindow=null;await walk.close();continue;}
        if(flushFailure)throw flushFailure;
        if(parseFailure)throw parseFailure;
        if(signal.aborted || closing)throw new ScanYield('control');
        if(!finalized)throw new Error('扫描发现片段未完成持久checkpoint。');
      }
      if (scoped(jobId).phase === 'completed') {
        await walk.close();walk=undefined;
        await options.onCompleted?.(scoped(jobId), { retry: false });
        logLibraryOperation('scan','scan.job','complete',{id:jobId,elapsedMs:performance.now()-started,visited:Number(job.progress.visited),accepted:Number(job.progress.accepted),rejected:Number(job.progress.rejected)});
      } else logLibraryOperation('scan','scan.job','cancelled',{id:jobId,elapsedMs:performance.now()-started});
    } catch(error) {
      if(error instanceof ScanFatal) {
        fatal=error;
        const code=typeof error.cause==='string' && ['CLOSED','QUEUE_FULL','WORKER_FAILED','ADMISSION_FAILED'].includes(error.cause) ? error.cause:'FATAL';
        logLibraryOperation('scan','scan.job','error',{id:jobId,code,elapsedMs:performance.now()-started});throw error;
      }
      const current=scoped(jobId);
      if(current.phase === 'running' && !signal.aborted) {
        if(error instanceof ScanYield || error instanceof SourceFileError && ['REVOKED','SOURCE_ROOT_OFFLINE'].includes(error.code)) {
          const cause=error instanceof ScanYield && error.reason !== 'control' ? error.reason:'source-offline';
          store.privatePause({commandId:randomUUID(),jobId,expectedRevision:current.jobRevision,cause});
          logLibraryOperation('scan','scan.job','paused',{id:jobId,code:cause.replaceAll('-','_').toUpperCase(),elapsedMs:performance.now()-started});
        } else {store.privateFail({commandId:randomUUID(),jobId,expectedRevision:current.jobRevision,
          code:error instanceof Error && error.message === 'ROOT_REVISION_CHANGED' ? 'ROOT_REVISION_CHANGED':'SCAN_READ_FAILED'});
          logLibraryOperation('scan','scan.job','error',{id:jobId,code:'SCAN_READ_FAILED',elapsedMs:performance.now()-started});}
      } else if (current.phase === 'completed') {
        // 主目录与checkpoint已经提交，附加快照失败不能改写扫描的完成事实。
        logLibraryOperation('scan','scan.snapshot','error',{id:jobId,code:'SNAPSHOT_FAILED',elapsedMs:performance.now()-started});
        logLibraryOperation('scan','scan.job','complete',{id:jobId,elapsedMs:performance.now()-started,visited:Number(current.progress.visited),accepted:Number(current.progress.accepted),rejected:Number(current.progress.rejected)});
      } else logLibraryOperation('scan','scan.job','cancelled',{id:jobId,elapsedMs:performance.now()-started});
    } finally {try{await cueWindow?.close();}finally{await walk?.close();}}
  }
  function launch(job:ScanJobRecord,newJob=false):void {
    if(runs.has(job.jobId) || job.phase !== 'running') return;
    let frozen = options.settings?.frozen(options.identity!, job.jobId) ?? frozenSettings.get(job.jobId);
    if (!frozen) {
      const settings = options.settings?.read(options.identity!) ?? LOCAL_SCAN_DEFAULT_SETTINGS;
      frozen = { jobId: job.jobId, settingsRevision: settings.revision, albumConcurrency: settings.albumConcurrency, readerConcurrency: newJob ? readConcurrency : 2 };
      if (options.settings) {
        const started = performance.now();
        logLibraryOperation('scan','scan.settings.freeze','start',{id:job.jobId});
        try {
          frozen = options.settings.freeze(options.identity!, { schema: frozen.readerConcurrency === 8 ? 2 : 1, datasetId: options.datasetId, eventId: randomUUID(), commandId: randomUUID(), kind: 'launch', frozen });
          logLibraryOperation('scan','scan.settings.freeze','complete',{id:job.jobId,elapsedMs:performance.now()-started});
        } catch(error) {
          logLibraryOperation('scan','scan.settings.freeze','error',{id:job.jobId,elapsedMs:performance.now()-started,code:'SCAN_SETTINGS_FREEZE_FAILED'});
          throw error;
        }
      }
    }
    frozenSettings.set(job.jobId, Object.freeze({ ...frozen }));
    // 每个 job 保留原冻结上限，不能借 Owner 的八槽扩大历史一槽/两槽任务。
    jobTurns.set(job.jobId, createScanReaderTurn(frozen.readerConcurrency));
    verifiedEmbeddedDirectories.set(job.jobId,new Set());
    const controller=new AbortController();
    const done=Promise.resolve().then(()=>execute(job.jobId,controller.signal)).catch(error=>{fatal=error instanceof ScanFatal ? error:new ScanFatal('扫描资源收口失败。',error);}).finally(()=>{runs.delete(job.jobId);jobTurns.get(job.jobId)?.close();jobTurns.delete(job.jobId);verifiedEmbeddedDirectories.delete(job.jobId);});
    runs.set(job.jobId,{controller,done});
  }
  async function quiet(jobId:string):Promise<void> {
    const run=runs.get(jobId);run?.controller.abort(new ScanYield('control'));if(run) await run.done;if(fatal) throw fatal;
  }
  async function recoverAvailable():Promise<void> {
    if(closing || fatal || mediaYielding || typeof store.privateAutomaticResumePage !== 'function')return;
    assertEntry();const started=performance.now();let resumed=0;
    logLibraryOperation('scan','scan.recovery','start',{});
    try {
      let after=0;
      do {
        const page=store.privateAutomaticResumePage(options.datasetId,after,200);after=page.nextRow;
        for(const captured of page.items) {
          if(closing || fatal || mediaYielding)return;
          if(runs.has(captured.jobId) || controlledJobs.has(captured.jobId) || controlledLibraries.has(captured.libraryRootId))continue;
          try {
            const root=authority(captured);
            if(!options.repository.localCatalog.privateLibraryManagementRootAvailable(captured.libraryRootId)
              || await sourceRootAvailability(root)!=='ONLINE')continue;
            // 异步检查期间收到手动 pause/cancel 或根修订变化时，不能用旧捕获重新启动。
            assertEntry();if(closing || mediaYielding || runs.has(captured.jobId) || controlledJobs.has(captured.jobId) || controlledLibraries.has(captured.libraryRootId))continue;
            const current=scoped(captured.jobId);authority(current);
            if(current.jobRevision!==captured.jobRevision || !['pending','running','paused'].includes(current.phase))continue;
            const running=current.phase==='running' ? current:store.resume({commandId:randomUUID(),jobId:current.jobId,expectedRevision:current.jobRevision});
            launch(running);resumed++;logLibraryOperation('scan','scan.job','resumed',{id:running.jobId});
          } catch(error) {
            if(closing || fatal)throw error;
            // 离线、撤权与旧root修订只保留事实，下一轮重新核当前来源；不改写手动暂停状态。
            logLibraryOperation('scan','scan.recovery-root','skipped',{id:captured.jobId,code:'ROOT_UNAVAILABLE'});
          }
        }
        if(!page.hasMore)break;
      } while(!closing);
      logLibraryOperation('scan','scan.recovery','complete',{count:resumed,elapsedMs:performance.now()-started});
    } catch(error) {logLibraryOperation('scan','scan.recovery',closing ? 'cancelled':'error',{elapsedMs:performance.now()-started});if(!closing)throw error;}
  }
  function scheduleRecovery(delay=5000):void {
    if(!recoveryEnabled || closing || fatal)return;
    recoveryTimer=setTimeout(()=>{
      recoveryTimer=undefined;
      recoveryActive=recoverAvailable().catch(()=>{ /* 阶段日志已记录；保留原任务，后续只重核ONLINE与原许可。 */ })
        .finally(()=>{recoveryActive=undefined;scheduleRecovery();});
    },delay);recoveryTimer.unref?.();
  }
  return {
    /** 旧逻辑曲目补读仍经同一Reader/Source票据/媒体退让；不重放扫描任务或改文件。 */
    async privateReadArtistMetadata(candidate: ArtistMetadataBackfillCandidate, signal: AbortSignal): Promise<MetadataReadResult> {
      assertEntry();
      const libraryCurrent=()=>options.repository.localCatalog.privateLibraryManagementRootAvailable(candidate.asset.libraryRootId);
      if(!libraryCurrent())return {status:'failure',code:'REVOKED',readEvidence:null};
      const current = store.privateCurrentFileState(candidate.asset.libraryRootId, candidate.relative);
      const track = options.repository.localCatalog.track(candidate.track.id), asset = options.repository.localCatalog.asset(track.assetId);
      if (!current || !candidate.signature || current.jobId !== candidate.scanJobId || current.value.signature !== candidate.signature
        || current.value.assetId !== candidate.asset.id || current.value.trackId !== candidate.track.id && candidate.track.segment === null
        || scanCanonical(track) !== scanCanonical(candidate.track) || scanCanonical(asset) !== scanCanonical(candidate.asset)) return { status: 'failure', code: 'CONTENT_CHANGED', readEvidence: null };
      try { return await read(scoped(current.jobId), candidate.relative, candidate.signature, signal, libraryCurrent); }
      catch (error) { if (error instanceof ScanYield) throw new ArtistMetadataBackfillDeferred(); throw error; }
    },
    start(request:LocalScanStartRequest):ScanJobRecord {assertEntry();const result=store.start({...request,datasetId:options.datasetId,parserVersion:cueInputMetadataEnabled ? CUE_INPUT_SCAN_VERSION : PARSER});
      // public原start回执固定pending；仅首次明确创建启动，不把UNKNOWN同body重试当自动恢复。
      if(result.created) {const running=store.resume({commandId:randomUUID(),jobId:result.job.jobId,expectedRevision:result.job.jobRevision});launch(running,true);}return result.job;},
    async pause(request:LocalScanTransitionRequest):Promise<ScanJobRecord> {assertEntry();const job=scoped(request.jobId);if(store.receipt(request.commandId) || job.jobRevision !== request.expectedRevision) return store.pause(request);controlledJobs.add(request.jobId);try{await quiet(request.jobId);const result=store.pause(request);logLibraryOperation('scan','scan.job','paused',{id:request.jobId,code:'MANUAL_PAUSE'});return result;}finally{controlledJobs.delete(request.jobId);}},
    async cancel(request:LocalScanTransitionRequest):Promise<ScanJobRecord> {assertEntry();const job=scoped(request.jobId);if(store.receipt(request.commandId) || job.jobRevision !== request.expectedRevision) return store.cancel(request);controlledJobs.add(request.jobId);try{await quiet(request.jobId);const result=store.cancel(request);logLibraryOperation('scan','scan.job','cancelled',{id:request.jobId});return result;}finally{controlledJobs.delete(request.jobId);}},
    resume(request:LocalScanTransitionRequest):ScanJobRecord {assertEntry();scoped(request.jobId);const old=store.receipt(request.commandId),result=store.resume(request);if(!old) launch(result);return result;},
    get(jobId:string):ScanJobRecord {assertEntry();return scoped(jobId);},
    page(page:{offset:number;limit:number}) {assertEntry();return store.page(options.datasetId,page);},
    receipt(commandId:string) {assertEntry();const receipt=store.receipt(commandId);if(receipt && receipt.result.datasetId !== options.datasetId) throw new Error('扫描回执不属于当前dataset。');return receipt;},
    async prepareBatch(request:{commandId:string;jobId:string;batch:ScanPreparedBatch}) {assertEntry();scoped(request.jobId);controlledJobs.add(request.jobId);try{await quiet(request.jobId);
      // 第一张CUE-aware checkpoint只由生产Walk捕获/提交；可信IPC也不能给旧cursor换解释。
      if(request.batch.kind === 'cue-sidecars-v1' && !store.privateCueAwareCheckpoint(request.jobId)) throw new Error('CUE阶段尚无实际持久checkpoint/receipt来源。');if(!await revalidate(scoped(request.jobId),request.batch)) throw new Error('扫描准备事实已改变。');return store.privatePrepareBatch(request);}finally{controlledJobs.delete(request.jobId);}},
    async commitBatch(request:{commandId:string;jobId:string;batchId:string;expectedRevision:string}) {assertEntry();scoped(request.jobId);controlledJobs.add(request.jobId);try{await quiet(request.jobId);const batch=store.privatePreparedBatches(request.jobId).find(b=>b.batchId === request.batchId);
      if(!store.receipt(request.commandId) && (!batch || !await revalidate(scoped(request.jobId),batch))) throw new Error('扫描提交事实已改变。');return await commitFenced(request);}finally{controlledJobs.delete(request.jobId);}},
    async yieldForMedia():Promise<void> {assertEntry();mediaYielding++;try{for(const jobId of [...runs.keys()]) {await quiet(jobId);const job=scoped(jobId);if(job.phase === 'running') store.privatePause({commandId:randomUUID(),jobId,expectedRevision:job.jobRevision,cause:'media-busy'});}}finally{mediaYielding--;}},
    /** commitBoot 后才打开恢复循环；查询已有目录事实不依赖这条后台扫描完成。 */
    privateStartRecovery():void {assertEntry();if(recoveryEnabled)return;recoveryEnabled=true;scheduleRecovery(0);},
    privateRecoverAvailable:recoverAvailable,
    close():Promise<void> {if(closed) return closed;closing=true;recoveryEnabled=false;clearTimeout(recoveryTimer);readerTurn.close();cueReaderTurn.close();cueBulkTurn.close();closed=(async()=>{for(const run of runs.values()) run.controller.abort(new ScanYield('control'));await recoveryActive;await Promise.all([...runs.values()].map(r=>r.done));await Promise.all([reader.close(),cueReader.close(),cueBulkReader?.close()]);if(fatal) throw fatal;})();return closed;},
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
      controlledLibraries.add(libraryId);try{
      let expected:number|null=null;
      for(let offset=0;;){accepting();const page=store.page(options.datasetId,{offset,limit:200});
        if(expected!==null&&expected!==page.total)throw new Error('本库停止期间扫描清单已变化，未撤绑定。');expected=page.total;
        for(const job of page.items.filter(job=>job.libraryRootId===libraryId)){
          if(job.phase==='running'&&!runs.has(job.jobId))throw new Error('原running扫描没有当前实际join作者，不能凭空Map撤库。');
          await quiet(job.jobId);accepting();const current=scoped(job.jobId);
          if(!['completed','cancelled','failed'].includes(current.phase))store.cancel({commandId:randomUUID(),jobId:current.jobId,expectedRevision:current.jobRevision});}
        offset+=page.items.length;if(!page.hasMore)break;}
      accepting();}finally{controlledLibraries.delete(libraryId);}
    },
    privateFrozenSettings(jobId: string) { assertCurrent(); const value = frozenSettings.get(jobId) ?? options.settings?.frozen(options.identity!, jobId); return value ? { ...value } : null; },
    privateReaderTurn: () => readerTurn.inspect(),
    privateWait(jobId:string):Promise<void> {return runs.get(jobId)?.done ?? Promise.resolve();},
  };
}
export type LocalScanCoordinator=ReturnType<typeof createLocalScanCoordinator>;
