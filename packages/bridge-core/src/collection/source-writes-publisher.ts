import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, lstat, realpath, mkdir, opendir, statfs, link, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquirePhysicalWriteClaims, assertRetainedPhysicalWriteClaims, registerPhysicalWriteClaimDescriptors, transferPhysicalWriteClaims, physicalWriteClaimDescriptors, closePhysicalWriteClaimDescriptors, PhysicalClaimsUnverified, type PhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import { PhysicalResourceBusy } from '../stream/physical-resource-locks.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { acquireSourceNamespaceWrite, assertSourceNamespaceHeld, captureSourceNamespace, retainSourceNamespaceWrite, releaseSourceNamespaceWrite, type SourceNamespaceOriginBinding, type SourceNamespaceOperation, type SourceNamespaceHeldScope, type SourceNamespaceHeldObservation, type SourceNamespaceWriteToken, type SourceNamespaceRecoveryToken } from '../stream/source-namespace-claims.js';
import { sourceRootAvailability, type RootCapability } from '../recording/source-files.js';
import { writeSourceTagRegion, type SourceRegionChange } from './source-write-format.js';
import { observeSourceWriteFile, verifySourceWriteResult, SOURCE_WRITE_FILE_BYTES, type SourceWriteFileObservation } from './source-write-verify.js';

export const SOURCE_PUBLISHER_PROFILE='NONATOMIC_QUARANTINE_LINK_V1' as const;
export const SOURCE_SAFETY_BYTES=2*1024*1024*1024;
const executeFile=promisify(execFile);
export class SourcePublisherError extends Error {constructor(readonly issue:string){super(`源文件发布拒绝：${issue}。`);}}
const fail=(issue:string):never=>{throw new SourcePublisherError(issue);};
const signature=(s:BigIntStats):string=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const resource=(s:BigIntStats)=>({dev:String(s.dev),ino:String(s.ino)});
const inside=(parent:string,child:string):boolean=>{const relative=path.relative(parent,child);return !relative||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`);};
interface SourceAttributeOwner {mode:string;uid:string;gid:string}
export type SourceFileAttributes=SourceAttributeOwner&(
  {proof:'MACOS_EMPTY_XATTR_ACL_FLAGS_V1'|'LINUX_EMPTY_XATTR_ACL_FLAGS_V1'}
  |{proof:'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1';provenance:{bytes:11;sha256:string}}
);
// Linux 的只读资格探针：文件描述符上的真实 xattr 包含 POSIX ACL/capability；extent 是存储布局标志。
const linuxAttributesScript=`import os,sys,fcntl,array
p,dev,ino=sys.argv[1:]
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
try:
 a=os.fstat(fd)
 if not os.path.isfile(p) or str(a.st_dev)!=dev or str(a.st_ino)!=ino or a.st_nlink!=1 or os.listxattr(fd): raise RuntimeError('unproven')
 flags=array.array('L',[0]); fcntl.ioctl(fd,0x80086601,flags,True)
 if flags[0] & ~0x80000: raise RuntimeError('unproven')
 b=os.fstat(fd)
 if (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns,a.st_mode,a.st_uid,a.st_gid)!=(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns,b.st_mode,b.st_uid,b.st_gid): raise RuntimeError('changed')
 print('CLEAN '+str(a.st_dev)+':'+str(a.st_ino)+':'+str(a.st_mode & 4095)+':'+str(a.st_uid)+':'+str(a.st_gid))
finally: os.close(fd)
`;
export const sameSourceFileAttributeProof=(a:SourceFileAttributes,b:SourceFileAttributes|null):boolean=>b!==null&&a.proof===b.proof&&(a.proof!=='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'||b.proof==='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'&&a.provenance.bytes===b.provenance.bytes&&a.provenance.sha256===b.provenance.sha256);
export const sameSourceFileAttributes=(a:SourceFileAttributes,b:SourceFileAttributes|null):boolean=>b!==null&&a.mode===b.mode&&a.uid===b.uid&&a.gid===b.gid&&sameSourceFileAttributeProof(a,b);
/** 固定绝对系统工具、无shell；缺工具/输出不明/超时都不是属性干净的证据。 */
export async function observeSourceFileAttributes(absolute:string,handle:FileHandle):Promise<SourceFileAttributes> {
  const before=await handle.stat({bigint:true}),named=await lstat(absolute,{bigint:true});
  if(!['darwin','linux'].includes(process.platform)||!before.isFile()||before.nlink!==1n||signature(before)!==signature(named)||before.birthtimeNs!==named.birthtimeNs)return fail('FILE_ATTRIBUTES_UNPROVEN');
  if(typeof process.getuid!=='function'||typeof process.getgid!=='function'||before.uid!==BigInt(process.getuid())||before.gid!==BigInt(process.getgid()))return fail('FILE_ATTRIBUTES_UNPROVEN');
  try {
    const options={timeout:3000,maxBuffer:16384,encoding:'utf8' as const,env:{LANG:'C',LC_ALL:'C'}};
    let profile:Pick<Extract<SourceFileAttributes,{proof:'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'}>,'proof'|'provenance'>|{proof:'MACOS_EMPTY_XATTR_ACL_FLAGS_V1'|'LINUX_EMPTY_XATTR_ACL_FLAGS_V1'};
    if(process.platform==='darwin'){
      // 唯一例外是系统实际生成的11字节opaque provenance；不写入、清除或解释它。
      const names=await executeFile('/usr/bin/xattr',[absolute],options);
      if(names.stderr!==''||names.stdout!==''&&names.stdout!=='com.apple.provenance\n')return fail('FILE_ATTRIBUTES_UNPROVEN');
      if(names.stdout==='')profile={proof:'MACOS_EMPTY_XATTR_ACL_FLAGS_V1'};
      else{
        const value=await executeFile('/usr/bin/xattr',['-px','com.apple.provenance',absolute],options);
        if(value.stderr!==''||!/^[0-9A-Fa-f \t\r\n]+$/u.test(value.stdout))return fail('FILE_ATTRIBUTES_UNPROVEN');
        const hex=value.stdout.replace(/[ \t\r\n]/gu,'');if(!/^[0-9A-Fa-f]{22}$/u.test(hex))return fail('FILE_ATTRIBUTES_UNPROVEN');
        profile={proof:'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1',provenance:{bytes:11,sha256:createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex')}};
      }
      const acl=await executeFile('/bin/ls',['-lde',absolute],options),flags=await executeFile('/usr/bin/stat',['-f','%f',absolute],options),mode=acl.stdout.split(/\s/u)[0]??'';
      const modePattern=profile.proof==='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'?/^-[rwxstST-]{9}@$/u:/^-[rwxstST-]{9}$/u;
      if(acl.stderr!==''||flags.stderr!==''||flags.stdout!=='0\n'||acl.stdout.trimEnd().split('\n').length!==1||!modePattern.test(mode))return fail('FILE_ATTRIBUTES_UNPROVEN');
    }else{
      if(!['x64','arm64'].includes(process.arch))return fail('FILE_ATTRIBUTES_UNPROVEN');
      const actual=await executeFile('/usr/bin/python3',['-I','-S','-c',linuxAttributesScript,absolute,String(before.dev),String(before.ino)],options);
      if(actual.stderr!==''||actual.stdout!==`CLEAN ${before.dev}:${before.ino}:${before.mode&0o7777n}:${before.uid}:${before.gid}\n`)return fail('FILE_ATTRIBUTES_UNPROVEN');
      profile={proof:'LINUX_EMPTY_XATTR_ACL_FLAGS_V1'};
    }
    const after=await handle.stat({bigint:true}),current=await lstat(absolute,{bigint:true});
    if(signature(after)!==signature(before)||signature(current)!==signature(after)||after.birthtimeNs!==before.birthtimeNs||current.birthtimeNs!==before.birthtimeNs||after.nlink!==1n||current.nlink!==1n||after.mode!==before.mode||after.uid!==before.uid||after.gid!==before.gid||current.mode!==after.mode||current.uid!==after.uid||current.gid!==after.gid)return fail('SOURCE_CHANGED');
    return {mode:String(before.mode&0o7777n),uid:String(before.uid),gid:String(before.gid),...profile};
  }catch(error){if(error instanceof SourcePublisherError)throw error;return fail('FILE_ATTRIBUTES_UNPROVEN');}
}
/** 独立备份保持私有权限；只对原件的属性证明比较，不把原件权限套到备份。 */
export async function observeSourceBackupAttributes(absolute:string,handle:FileHandle,original:SourceFileAttributes|null,expected:SourceFileAttributes|null=null):Promise<SourceFileAttributes>{
  const actual=await observeSourceFileAttributes(absolute,handle);
  if(actual.mode!==String(0o600)||original&&!sameSourceFileAttributeProof(actual,original)||expected&&!sameSourceFileAttributes(actual,expected))return fail('BACKUP_INVALID');
  return actual;
}
export interface PublisherTarget {
  operationId:string; root:RootCapability; libraryRootPath:string; relative:string;
  expected:SourceWriteFileObservation|SourcePublishedBlob|null; attributes:SourceFileAttributes|null;
  change:SourceRegionChange|null; replacementBytes:Buffer|null;
  restorationFile?:string; restorationSha256?:string; restorationBytes?:number; removeTarget?:boolean;
  restorationAudio?:boolean;
  restorationAttributes?:SourceFileAttributes|null; restorationBackupAttributes?:SourceFileAttributes;
  protectedSources?:readonly {root:RootCapability;relative:string;signature:string;physical:{dev:string;ino:string}}[];
}
export interface SourcePublisherJournalFact {
  operationId:string; phase:'BACKUP'|'STAGED'|'CAPTURE_INTENT'|'CAPTURED'|'PUBLISH_INTENT'|'PUBLISHED'|'CLEANUP'|'VERIFIED'|'FACTS_COMMITTED'|'QUIET'|'UNKNOWN';
  backup:string; quarantine:string; stage:string; beforeSha256:string|null; afterSha256:string|null;
  backupAttributes?:SourceFileAttributes;
}
export interface SourcePublisherInput {
  targets:readonly PublisherTarget[]; privateDirectory:string; signal:AbortSignal;
  planId:string; namespaceBinding:SourceNamespaceOriginBinding; namespaceRecovery?:SourceNamespaceRecoveryToken;
  physicalRecovery?:{claims:PhysicalWriteClaims;handles:readonly FileHandle[]};
  namespaceHeld?(protection:SourcePublisherNamespaceProtection):void;
  phase(fact:SourcePublisherJournalFact):void;
  verifyProtection(claims:PhysicalWriteClaims):Promise<void>;
  prepareCommit?(target:PublisherTarget,after:SourceWriteFileObservation|SourcePublishedBlob|null,backup:SourceBackupFact):Promise<void>;
  commit(target:PublisherTarget,after:SourceWriteFileObservation|SourcePublishedBlob|null,backup:SourceBackupFact):void;
}
export interface SourcePublishedBlob {sha256:string;bytes:number;signature:string;physical:{dev:string;ino:string};permissionMode:string;birthtimeNs:string}
export interface SourceBackupFact {path:string;sha256:string;bytes:number;physical:{dev:string;ino:string};attributes?:SourceFileAttributes}
interface OwnedFile {
  target:PublisherTarget; absolute:string; parent:string; parentHandle:FileHandle; parentInfo:BigIntStats; ancestors:{path:string;handle:FileHandle;info:BigIntStats}[];
  original:FileHandle|null; originalInfo:BigIntStats|null; restoration:FileHandle|null; stage:FileHandle; backup:FileHandle;
  privateHandle:FileHandle; privateInfo:BigIntStats; stagePath:string; backupPath:string; quarantinePath:string;
  backupFact:SourceBackupFact|null; stageSha256:string|null; stagedAttributes:SourceFileAttributes|null; moved:boolean; published:boolean; committed:boolean;
}
interface SourcePublisherRetainedProtection {claims:PhysicalWriteClaims;files:readonly OwnedFile[];namespaceProtection:SourcePublisherNamespaceProtection}
export type SourcePublisherOutcome={outcome:'confirmed';applied:string[];backups:SourceBackupFact[];issue:string|null;retainedProtection:SourcePublisherRetainedProtection|null}|{outcome:'not-performed';issue:string;applied:[]}|{outcome:'unknown';issue:string;applied:string[]};
export type SourcePublisherNamespaceProtection={token:SourceNamespaceWriteToken;scope:SourceNamespaceHeldScope;recovery:false}|{token:SourceNamespaceRecoveryToken;scope:SourceNamespaceHeldScope;recovery:true};
export class SourcePublicationRecoveryRequired extends Error {
  constructor(readonly outcome:Extract<SourcePublisherOutcome,{outcome:'unknown'}>,readonly claims:PhysicalWriteClaims|null,readonly files:readonly OwnedFile[],cause?:unknown,readonly namespaceProtection:SourcePublisherNamespaceProtection|null=null,readonly additionalHandles:readonly FileHandle[]=[]){super('源发布或quiet结果未知，原件、备份、暂存与保护保留，必须显式对账。',{cause});}
}
/** 库目标和目录共享音频使用同一命名位；私有备份/隔离原件仍由真实 inode guards 保护。 */
export async function sourcePublisherNamespaceOperations(targets:readonly Pick<PublisherTarget,'operationId'|'root'|'relative'|'protectedSources'>[]):Promise<SourceNamespaceOperation[]>{
  const result:SourceNamespaceOperation[]=[],seen=new Set<string>();
  for(const target of targets){const sources=[{root:target.root,relative:target.relative},...(target.protectedSources??[]).filter(s=>s.root.id===target.root.id&&s.root.path===target.root.path)];
    for(const source of sources){const name=await captureSourceNamespace(source.root,source.relative),key=`${target.operationId}\0${name.absolute}`;if(!seen.has(key)){seen.add(key);result.push({operationId:target.operationId,name});}}
  }return result;
}
/** 冷核只重持实际 FD，绝不从旧 JSON 或 SAB 负槽伪造 writer 身份。 */
export async function holdSourceRecoveryPhysicalFiles(sources:readonly {root:RootCapability;relative:string;allowMissing:boolean}[],namespaceResourceCount=0):Promise<PhysicalWriteClaims>{
  if(!sources.length||sources.length>2048)return fail('BUDGET_EXCEEDED');const handles:FileHandle[]=[],seen=new Set<string>(),resources:ReturnType<typeof resource>[]=[],claims:PhysicalWriteClaims[]=[];
  const hold=async(absolute:string,directory:boolean,expected?:BigIntStats):Promise<void>=>{
    if(seen.has(absolute))return;const before=expected??await lstat(absolute,{bigint:true});if(before.isSymbolicLink()||(directory?!before.isDirectory():!before.isFile()))return fail('UNKNOWN_PROTECTION');
    if(await realpath(absolute)!==absolute)return fail('UNKNOWN_PROTECTION');const fd=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|(directory?constants.O_DIRECTORY:0));handles.push(fd);
    const actual=await fd.stat({bigint:true}),named=await lstat(absolute,{bigint:true});if(actual.dev!==before.dev||actual.ino!==before.ino||actual.birthtimeNs!==before.birthtimeNs||named.dev!==actual.dev||named.ino!==actual.ino||named.birthtimeNs!==actual.birthtimeNs||!directory&&actual.size>BigInt(SOURCE_WRITE_FILE_BYTES))return fail('SOURCE_CHANGED');
    seen.add(absolute);resources.push(resource(actual));
  };
  try{for(const source of sources){const checked=await checkedTarget({operationId:'',root:source.root,libraryRootPath:source.root.path,relative:source.relative,expected:null,attributes:null,change:null,replacementBytes:null});for(const parent of checked.parents)await hold(parent.path,true,parent.info);
      try{await hold(checked.absolute,false);}catch(error){if(!source.allowMissing||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    if(new Set(resources.map(r=>`${r.dev}:${r.ino}`)).size+namespaceResourceCount>2048)return fail('BUDGET_EXCEEDED');
    const value=await acquirePhysicalWriteClaims(resources);claims.push(value);registerPhysicalWriteClaimDescriptors(value,handles);value.retain();return value;
  }catch(error){if(claims.length){for(const value of claims)value.retain();throw new SourcePublicationRecoveryRequired({outcome:'unknown',issue:'RELEASE_UNKNOWN',applied:[]},claims[0]??null,[],error);}
    const closed=await Promise.allSettled(handles.map(fd=>fd.close()));if(closed.some(r=>r.status==='rejected'))return fail('RELEASE_UNKNOWN');throw error;}
}
async function checkedTarget(target:PublisherTarget):Promise<{absolute:string;parent:string;parents:{path:string;info:BigIntStats}[]}> {
  if(await sourceRootAvailability(target.root)!=='ONLINE')return fail(target.root.authorized?'SOURCE_OFFLINE':'SOURCE_REVOKED');
  if(typeof target.relative!=='string'||target.relative.length>4096||/[\u0000-\u001f\u007f\\:]/u.test(target.relative)||target.relative.startsWith('/')||target.relative.split('/').some(p=>!p||p==='.'||p==='..'))return fail('NAMESPACE_CONFLICT');
  let current=target.root.path;const first=await lstat(current,{bigint:true});if(!first.isDirectory()||first.isSymbolicLink()||String(first.dev)!==target.root.dev||String(first.ino)!==target.root.ino)return fail('SOURCE_CHANGED');const parents=[{path:current,info:first}];
  for(const part of target.relative.split('/').slice(0,-1)){current=path.join(current,part);const info=await lstat(current,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink())return fail('NAMESPACE_CONFLICT');parents.push({path:current,info});}
  const absolute=path.join(target.root.path,target.relative);if(await realpath(current)!==current)return fail('NAMESPACE_CONFLICT');
  return {absolute,parent:current,parents};
}
export async function observeSourcePublishedBlob(handle:FileHandle,maximum=4194304,signal?:AbortSignal):Promise<SourcePublishedBlob> {
  const first=await handle.stat({bigint:true}),size=Number(first.size);if(!first.isFile()||first.nlink!==1n||!Number.isSafeInteger(size)||size<1||size>maximum)return fail('SOURCE_CHANGED');
  const hash=createHash('sha256'),buffer=Buffer.alloc(262144);let at=0;
  while(at<size){if(signal?.aborted)return fail('CANCELLED');const v=await handle.read(buffer,0,Math.min(buffer.length,size-at),at);if(!v.bytesRead)return fail('SOURCE_CHANGED');hash.update(buffer.subarray(0,v.bytesRead));at+=v.bytesRead;}
  const last=await handle.stat({bigint:true});if(signature(first)!==signature(last)||first.mode!==last.mode||first.birthtimeNs!==last.birthtimeNs)return fail('SOURCE_CHANGED');
  return {sha256:hash.digest('hex'),bytes:size,signature:signature(last),physical:resource(last),permissionMode:String(last.mode&0o7777n),birthtimeNs:String(last.birthtimeNs)};
}
const readHash=observeSourcePublishedBlob;
/** 恢复只清理由认证发布日志证明的私有stage别名；普通硬链接资格检查保持不变。 */
export async function reconcileSourcePublishedStage(input:{root:RootCapability;relative:string;operationId:string;privateDirectory:string;stage:string;sha256:string;claims:PhysicalWriteClaims;namespace:SourceNamespaceHeldObservation;signal:AbortSignal}):Promise<void>{
  const area=path.join(input.privateDirectory,input.operationId);
  if(input.stage!==path.join(area,'stage')||!inside(input.privateDirectory,area)||!dtoHash(input.sha256))return fail('BACKUP_INVALID');
  assertRetainedPhysicalWriteClaims(input.claims,[]);
  let stageNamed:BigIntStats;
  try{stageNamed=await lstat(input.stage,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const checked=await checkedTarget({operationId:input.operationId,root:input.root,libraryRootPath:input.root.path,relative:input.relative,expected:null,attributes:null,change:null,replacementBytes:null});
  let targetNamed:BigIntStats;
  try{targetNamed=await lstat(checked.absolute,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&stageNamed.isFile()&&!stageNamed.isSymbolicLink()&&stageNamed.nlink===1n)return;throw error;}
  if(stageNamed.isFile()&&!stageNamed.isSymbolicLink()&&stageNamed.nlink===1n&&targetNamed.isFile()&&!targetNamed.isSymbolicLink()&&targetNamed.nlink===1n&&signature(stageNamed)!==signature(targetNamed))return;
  if(!stageNamed.isFile()||stageNamed.isSymbolicLink()||!targetNamed.isFile()||targetNamed.isSymbolicLink()||stageNamed.nlink!==2n||targetNamed.nlink!==2n||signature(stageNamed)!==signature(targetNamed)||stageNamed.birthtimeNs!==targetNamed.birthtimeNs)return fail('SOURCE_CHANGED');
  const handles:FileHandle[]=[],parents:{absolute:string;handle:FileHandle;before:BigIntStats}[]=[];
  const keep=async(absolute:string,directory:boolean):Promise<FileHandle>=>{const fd=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|(directory?constants.O_DIRECTORY:0));handles.push(fd);return fd;};
  try{
    const privateNamed=await lstat(area,{bigint:true});
    if(!privateNamed.isDirectory()||privateNamed.isSymbolicLink()||await realpath(area)!==area||(privateNamed.mode&0o777n)!==0o700n||typeof process.getuid!=='function'||privateNamed.uid!==BigInt(process.getuid())||privateNamed.dev!==stageNamed.dev)return fail('BACKUP_INVALID');
    for(const parent of [...checked.parents,{path:area,info:privateNamed}])parents.push({absolute:parent.path,handle:await keep(parent.path,true),before:parent.info});
    const file=await keep(checked.absolute,false),stage=await keep(input.stage,false),first=await file.stat({bigint:true});
    const fence=async(expectedLinks:bigint,expected:BigIntStats):Promise<void>=>{
      if(input.signal.aborted)return fail('CANCELLED');
      assertRetainedPhysicalWriteClaims(input.claims,[resource(first),...parents.map(p=>resource(p.before))]);
      const name=await captureSourceNamespace(input.root,input.relative);assertSourceNamespaceHeld(input.namespace.token,{datasetId:input.namespace.datasetId,planId:input.namespace.planId,originBinding:input.namespace.originBinding,operations:[{operationId:input.namespace.operationId,name}]});
      await checkedTarget({operationId:input.operationId,root:input.root,libraryRootPath:input.root.path,relative:input.relative,expected:null,attributes:null,change:null,replacementBytes:null});
      for(const parent of parents){const actual=await parent.handle.stat({bigint:true}),named=await lstat(parent.absolute,{bigint:true});if(!named.isDirectory()||named.isSymbolicLink()||actual.dev!==parent.before.dev||actual.ino!==parent.before.ino||actual.birthtimeNs!==parent.before.birthtimeNs||actual.mode!==parent.before.mode||actual.uid!==parent.before.uid||actual.gid!==parent.before.gid||named.dev!==actual.dev||named.ino!==actual.ino||named.birthtimeNs!==actual.birthtimeNs||named.mode!==actual.mode||named.uid!==actual.uid||named.gid!==actual.gid)return fail('SOURCE_CHANGED');}
      const actual=await file.stat({bigint:true}),alias=await stage.stat({bigint:true}),named=await lstat(checked.absolute,{bigint:true});
      for(const observed of [actual,alias,named])if(signature(observed)!==signature(expected)||observed.birthtimeNs!==expected.birthtimeNs||observed.mode!==expected.mode||observed.uid!==expected.uid||observed.gid!==expected.gid||observed.nlink!==expectedLinks)return fail('SOURCE_CHANGED');
      if(expectedLinks===2n){const privateAlias=await lstat(input.stage,{bigint:true});if(privateAlias.isSymbolicLink()||signature(privateAlias)!==signature(expected)||privateAlias.birthtimeNs!==expected.birthtimeNs)return fail('SOURCE_CHANGED');}
    };
    if(!first.isFile()||signature(first)!==signature(stageNamed)||first.birthtimeNs!==stageNamed.birthtimeNs||first.size<1n||first.size>BigInt(SOURCE_WRITE_FILE_BYTES))return fail('SOURCE_CHANGED');
    await fence(2n,first);
    const hash=createHash('sha256'),buffer=Buffer.alloc(262144);let at=0;
    while(at<Number(first.size)){if(input.signal.aborted)return fail('CANCELLED');const read=await file.read(buffer,0,Math.min(buffer.length,Number(first.size)-at),at);if(!read.bytesRead)return fail('SOURCE_CHANGED');hash.update(buffer.subarray(0,read.bytesRead));at+=read.bytesRead;}
    if(hash.digest('hex')!==input.sha256)return fail('SOURCE_CHANGED');await fence(2n,first);
    // 只去掉库外的同inode别名，源路径、bytes、backup与quarantine不作回退或替换。
    await unlink(input.stage);await parents.at(-1)!.handle.sync();
    const after=await file.stat({bigint:true});if(after.dev!==first.dev||after.ino!==first.ino||after.birthtimeNs!==first.birthtimeNs||after.size!==first.size||after.mtimeNs!==first.mtimeNs||after.mode!==first.mode||after.uid!==first.uid||after.gid!==first.gid||after.nlink!==1n)return fail('SOURCE_CHANGED');
    await fence(1n,after);try{await lstat(input.stage,{bigint:true});return fail('REPLACEMENT_UNKNOWN');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if((await readHash(file,SOURCE_WRITE_FILE_BYTES,input.signal)).sha256!==input.sha256)return fail('SOURCE_CHANGED');await fence(1n,after);
  }finally{
    const closed=await Promise.allSettled(handles.map(fd=>fd.close()));if(closed.some(r=>r.status==='rejected')){input.claims.retain();throw new SourcePublicationRecoveryRequired({outcome:'unknown',issue:'RELEASE_UNKNOWN',applied:[]},input.claims,[],undefined,null,handles);}
  }
}
const dtoHash=(value:string):boolean=>/^[0-9a-f]{64}$/u.test(value);
async function fenceNamespace(file:OwnedFile):Promise<void>{
  await checkedTarget(file.target);
  for(const ancestor of file.ancestors){const actual=await ancestor.handle.stat({bigint:true}),named=await lstat(ancestor.path,{bigint:true});
    if(!named.isDirectory()||named.isSymbolicLink()||actual.dev!==ancestor.info.dev||actual.ino!==ancestor.info.ino||named.dev!==actual.dev||named.ino!==actual.ino||named.birthtimeNs!==actual.birthtimeNs||actual.mode!==ancestor.info.mode||actual.uid!==ancestor.info.uid||actual.gid!==ancestor.info.gid)return fail('SOURCE_CHANGED');
  }
  const privateNamed=await lstat(path.dirname(file.stagePath),{bigint:true});if(privateNamed.dev!==file.privateInfo.dev||privateNamed.ino!==file.privateInfo.ino||privateNamed.birthtimeNs!==file.privateInfo.birthtimeNs||privateNamed.mode!==file.privateInfo.mode||privateNamed.uid!==file.privateInfo.uid||privateNamed.gid!==file.privateInfo.gid||privateNamed.isSymbolicLink())return fail('REPLACEMENT_UNKNOWN');
}
async function writeAll(handle:FileHandle,bytes:Buffer,position:number):Promise<void>{let at=0;while(at<bytes.length){const v=await handle.write(bytes,at,bytes.length-at,position+at);if(!v.bytesWritten)return fail('BACKUP_UNAVAILABLE');at+=v.bytesWritten;}}
async function copyIndependent(source:FileHandle,target:FileHandle,size:number,signal:AbortSignal,prefix?:Buffer):Promise<void>{
  let at=0;const buffer=Buffer.alloc(262144);if(prefix){await writeAll(target,prefix,0);at=prefix.length;}
  while(at<size){if(signal.aborted)return fail('CANCELLED');const v=await source.read(buffer,0,Math.min(buffer.length,size-at),at);if(!v.bytesRead)return fail('SOURCE_CHANGED');await writeAll(target,buffer.subarray(0,v.bytesRead),at);at+=v.bytesRead;}
  await target.truncate(size);await target.sync();
}
/** 库外独占同卷仓库，未确认stage/backup/quarantine全部计量；不删除历史保全材料。 */
export function createSourceSafetyRepository(privateDirectory:string){
  const reserved=new Map<string,number>();
  async function root():Promise<{absolute:string;info:BigIntStats}>{
    if(!path.isAbsolute(privateDirectory))return fail('BACKUP_UNAVAILABLE');await mkdir(privateDirectory,{recursive:true,mode:0o700});
    const absolute=await realpath(privateDirectory),info=await lstat(absolute,{bigint:true});
    if(absolute!==privateDirectory||!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777n)!==0o700n||typeof process.getuid!=='function'||info.uid!==BigInt(process.getuid()))return fail('BACKUP_UNAVAILABLE');return {absolute,info};
  }
  async function usage():Promise<number>{let bytes=0,entries=0;const start=await root(),queue=[start.absolute];
    while(queue.length){const directory=await opendir(queue.shift()!);for await(const entry of directory){if(++entries>50000)return fail('BUDGET_EXCEEDED');const absolute=path.join(directory.path,entry.name),info=await lstat(absolute,{bigint:true});if(info.isSymbolicLink())return fail('BACKUP_UNAVAILABLE');if(info.isDirectory())queue.push(absolute);else if(info.isFile()){bytes+=Number(info.size);if(!Number.isSafeInteger(bytes)||bytes>SOURCE_SAFETY_BYTES)return fail('INSUFFICIENT_SPACE');}else return fail('BACKUP_UNAVAILABLE');}}
    return bytes;
  }
  return {
    async preflight(targets:readonly PublisherTarget[]):Promise<{bytes:number;directory:string}>{
      if(!targets.length||targets.length>100)return fail('BUDGET_EXCEEDED');const owned=await root();let amount=0,io=0;
      for(const target of targets){const checked=await checkedTarget(target),parent=await lstat(checked.parent,{bigint:true});if(parent.dev!==owned.info.dev||inside(target.libraryRootPath,owned.absolute)||inside(owned.absolute,target.libraryRootPath))return fail('BACKUP_UNAVAILABLE');
        const size=target.expected?.bytes??target.replacementBytes?.length??target.restorationBytes??0;if((size<1&&!(target.removeTarget&&target.expected===null))||size>SOURCE_WRITE_FILE_BYTES)return fail('BUDGET_EXCEEDED');io+=size;amount+=3*size+(target.replacementBytes?.length??0)+16384*20;
        const handle=await open(checked.parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await handle.sync();}catch{return fail('BACKUP_UNAVAILABLE');}finally{await handle.close();}
      }
      if(io>2147483648||amount>SOURCE_SAFETY_BYTES||await usage()+[...reserved.values()].reduce((a,b)=>a+b,0)+amount>SOURCE_SAFETY_BYTES)return fail('INSUFFICIENT_SPACE');
      const space=await statfs(owned.absolute,{bigint:true});if(space.bavail*space.bsize<BigInt(amount+1048576))return fail('INSUFFICIENT_SPACE');
      const probe=path.join(owned.absolute,`probe-${randomUUID()}`),linked=`${probe}.link`;const file=await open(probe,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await file.write(Buffer.from('能力观察'));await file.sync();await link(probe,linked);let refused=false;try{await link(probe,linked);}catch(error){refused=(error as NodeJS.ErrnoException).code==='EEXIST';}if(!refused)return fail('BACKUP_UNAVAILABLE');const dir=await open(owned.absolute,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}
      finally{await file.close();await unlink(linked).catch(()=>{});await unlink(probe).catch(()=>{});}
      return {bytes:amount,directory:owned.absolute};
    },
    async reserve(targets:readonly PublisherTarget[]):Promise<{id:string;directory:string;release():void}>{const check=await this.preflight(targets),id=randomUUID();reserved.set(id,check.bytes);return {id,directory:check.directory,release(){reserved.delete(id);}};},
    usage,
  };
}
export type SourceSafetyRepository=ReturnType<typeof createSourceSafetyRepository>;

/** 所有真实FD齐备后才取得整组原SAB写claims；SQL只有同步commit callback，文件/SQLite并非原子事务。 */
export async function publishSourceWrites(input:SourcePublisherInput,safety:SourceSafetyRepository):Promise<SourcePublisherOutcome>{
  const files:OwnedFile[]=[],handles:FileHandle[]=[],applied:string[]=[];let claims:PhysicalWriteClaims|null=input.physicalRecovery?.claims??null,retained=false,reservation:Awaited<ReturnType<SourceSafetyRepository['reserve']>>|undefined,namespaceProtection:SourcePublisherNamespaceProtection|null=null;
  const keep=(handle:FileHandle):FileHandle=>{handles.push(handle);return handle;};
  const phase=(file:OwnedFile,value:SourcePublisherJournalFact['phase']):void=>input.phase({operationId:file.target.operationId,phase:value,backup:file.backupPath,quarantine:file.quarantinePath,stage:file.stagePath,beforeSha256:file.target.expected?.sha256??null,afterSha256:file.stageSha256,...(value==='BACKUP'&&file.backupFact?.attributes?{backupAttributes:file.backupFact.attributes}:{})});
  try{
    const operations=await sourcePublisherNamespaceOperations(input.targets),scope={datasetId:input.namespaceBinding.datasetId,planId:input.planId,originBinding:input.namespaceBinding,operations};
    if(input.namespaceRecovery){assertSourceNamespaceHeld(input.namespaceRecovery,scope);namespaceProtection={token:input.namespaceRecovery,scope,recovery:true};}
    else {const token=await acquireSourceNamespaceWrite({...input.namespaceBinding,operations});namespaceProtection={token,scope,recovery:false};}
    input.namespaceHeld?.(namespaceProtection);
    reservation=await safety.reserve(input.targets);
    for(const target of input.targets){
      if(input.signal.aborted)return fail('CANCELLED');const checked=await checkedTarget(target),ancestors:OwnedFile['ancestors']=[];
      for(const parent of checked.parents){const handle=keep(await open(parent.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)),info=await handle.stat({bigint:true});if(info.dev!==parent.info.dev||info.ino!==parent.info.ino||info.birthtimeNs!==parent.info.birthtimeNs)return fail('SOURCE_CHANGED');ancestors.push({path:parent.path,handle,info});}
      const parentHandle=ancestors[ancestors.length-1]!.handle,parentInfo=ancestors[ancestors.length-1]!.info;
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(target.operationId))return fail('INVALID_REQUEST');
      // 私有目的地由已绑定operation_id确定；重复/未知旧执行不覆盖已保全材料。
      const owned=path.join(reservation.directory,target.operationId);await mkdir(owned,{mode:0o700});const privateHandle=keep(await open(owned,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)),privateInfo=await privateHandle.stat({bigint:true});
      const stagePath=path.join(owned,'stage'),backupPath=path.join(owned,'backup'),quarantinePath=path.join(owned,'quarantine');
      const stage=keep(await open(stagePath,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)),backup=keep(await open(backupPath,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));
      let original:FileHandle|null=null,originalInfo:BigIntStats|null=null;
      if(target.expected){original=keep(await open(checked.absolute,constants.O_RDONLY|constants.O_NOFOLLOW));originalInfo=await original.stat({bigint:true});if(signature(originalInfo)!==target.expected.signature||originalInfo.birthtimeNs.toString()!==target.expected.birthtimeNs||originalInfo.nlink!==1n)return fail('SOURCE_CHANGED');}
      else{try{await lstat(checked.absolute,{bigint:true});return fail('NAMESPACE_CONFLICT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      const restoration=target.restorationFile?keep(await open(target.restorationFile,constants.O_RDONLY|constants.O_NOFOLLOW)):null;
      if(target.restorationFile&&!inside(reservation.directory,target.restorationFile))return fail('BACKUP_INVALID');
      if(restoration&&!target.restorationAttributes)return fail('BACKUP_INVALID');
      files.push({target,absolute:checked.absolute,parent:checked.parent,parentHandle,parentInfo,ancestors,original,originalInfo,restoration,stage,backup,privateHandle,privateInfo,stagePath,backupPath,quarantinePath,backupFact:null,stageSha256:null,stagedAttributes:null,moved:false,published:false,committed:false});
    }
    const resources=[];for(const file of files){resources.push(...file.ancestors.map(a=>resource(a.info)),resource(file.privateInfo),resource(await file.stage.stat({bigint:true})),resource(await file.backup.stat({bigint:true})));if(file.originalInfo)resources.push(resource(file.originalInfo));if(file.restoration)resources.push(resource(await file.restoration.stat({bigint:true})));}
    for(const source of input.targets.flatMap(t=>t.protectedSources??[])){
      if(await sourceRootAvailability(source.root)!=='ONLINE')return fail('SOURCE_REVOKED');
      const absolute=path.join(source.root.path,source.relative);if(!inside(source.root.path,absolute)||await realpath(absolute)!==absolute)return fail('NAMESPACE_CONFLICT');
      const handle=keep(await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW)),info=await handle.stat({bigint:true});if(signature(info)!==source.signature||String(info.dev)!==source.physical.dev||String(info.ino)!==source.physical.ino)return fail('SOURCE_CHANGED');resources.push(resource(info));
    }
    // 恢复继承原整组guards/FD，另名hardlink不会在旧组释放与新组取得之间偷出读窗口。
    for(const file of files)await fenceNamespace(file);assertSourceNamespaceHeld(namespaceProtection.token,namespaceProtection.scope);
    if(input.physicalRecovery)for(const fd of input.physicalRecovery.handles){if(fd.fd<0)continue;const actual=await fd.stat({bigint:true});resources.push(resource(actual));keep(fd);}
    const completeResources=new Set([...resources,...(input.physicalRecovery?.claims.resources??[])].map(r=>`${r.dev}:${r.ino}`)),namespaceResourceCount=new Set(operations.flatMap(o=>o.name.resources.map(r=>`${r.dev}\0${r.absolute}`))).size;
    if(completeResources.size+namespaceResourceCount>2048)return fail('BUDGET_EXCEEDED');
    const uniqueResources=[...new Map(resources.map(r=>[`${r.dev}:${r.ino}`,r])).values()];
    if(input.physicalRecovery){claims=await transferPhysicalWriteClaims(input.physicalRecovery.claims,uniqueResources,handles);for(const fd of physicalWriteClaimDescriptors(claims))if(!handles.includes(fd))handles.push(fd);}
    else{claims=await acquirePhysicalWriteClaims(uniqueResources);registerPhysicalWriteClaimDescriptors(claims,handles);}
    for(const file of files)await fenceNamespace(file);assertSourceNamespaceHeld(namespaceProtection.token,namespaceProtection.scope);await input.verifyProtection(claims);
    for(const file of files){
      if(input.signal.aborted)return fail('CANCELLED');const target=file.target,expected=target.expected;
      if(file.original&&expected){
        const attributes=await observeSourceFileAttributes(file.absolute,file.original);if(!sameSourceFileAttributes(attributes,target.attributes))return fail('FILE_ATTRIBUTES_UNPROVEN');
        const desired=file.restoration?target.restorationAttributes!:attributes;await file.stage.chmod(Number(desired.mode));await file.stage.chown(Number(desired.uid),Number(desired.gid));
        await copyIndependent(file.original,file.backup,expected.bytes,input.signal);const independent=await readHash(file.backup,SOURCE_WRITE_FILE_BYTES,input.signal);if(independent.sha256!==expected.sha256||independent.physical.ino===expected.physical.ino&&independent.physical.dev===expected.physical.dev)return fail('BACKUP_INVALID');
        const backupAttributes=await observeSourceBackupAttributes(file.backupPath,file.backup,attributes);file.backupFact={path:file.backupPath,sha256:independent.sha256,bytes:independent.bytes,physical:independent.physical,attributes:backupAttributes};phase(file,'BACKUP');
        if(target.change){if(!('prefix'in expected))return fail('INVALID_REQUEST');const changed=writeSourceTagRegion(expected.prefix,expected.bytes,target.change);await copyIndependent(file.original,file.stage,expected.bytes,input.signal,changed.bytes);const fresh=await observeSourceWriteFile(file.stage,input.signal);verifySourceWriteResult(expected,fresh,target.change);file.stageSha256=fresh.sha256;}
        else if(file.restoration){
          await observeSourceBackupAttributes(target.restorationFile!,file.restoration,target.restorationAttributes!,target.restorationBackupAttributes??null);
          const restored='audioStart'in expected?await observeSourceWriteFile(file.restoration,input.signal):await readHash(file.restoration,4194304,input.signal);
          if(restored.sha256!==target.restorationSha256||'audioStart'in expected&&(!('audioStart'in restored)||typeof restored.audioStart!=='number'||!('audioPayloadSha256'in restored)||typeof restored.audioPayloadSha256!=='string'||restored.audioPayloadSha256!==expected.audioPayloadSha256||restored.audioStart!==expected.audioStart||restored.bytes!==expected.bytes))return fail('BACKUP_INVALID');
          await copyIndependent(file.restoration,file.stage,restored.bytes,input.signal);file.stageSha256=restored.sha256;
        }
        else if(target.removeTarget){await file.stage.sync();file.stageSha256=null;}
        else if(target.replacementBytes){await writeAll(file.stage,target.replacementBytes,0);await file.stage.sync();file.stageSha256=createHash('sha256').update(target.replacementBytes).digest('hex');}
        else return fail('INVALID_REQUEST');
      }else if(file.restoration){await observeSourceBackupAttributes(target.restorationFile!,file.restoration,target.restorationAttributes!,target.restorationBackupAttributes??null);const restored=target.restorationAudio?await observeSourceWriteFile(file.restoration,input.signal):await readHash(file.restoration,4194304,input.signal);if(restored.sha256!==target.restorationSha256||restored.bytes!==target.restorationBytes)return fail('BACKUP_INVALID');await copyIndependent(file.restoration,file.stage,restored.bytes,input.signal);await file.stage.chmod(Number(target.restorationAttributes!.mode));await file.stage.chown(Number(target.restorationAttributes!.uid),Number(target.restorationAttributes!.gid));await file.stage.sync();file.stageSha256=restored.sha256;}
      else if(target.removeTarget){await file.stage.sync();file.stageSha256=null;}
      else if(target.replacementBytes){await writeAll(file.stage,target.replacementBytes,0);await file.stage.chmod(0o644);await file.stage.sync();file.stageSha256=createHash('sha256').update(target.replacementBytes).digest('hex');}
      else return fail('INVALID_REQUEST');
      if(!file.backupFact){await file.backup.sync();const backupAttributes=await observeSourceBackupAttributes(file.backupPath,file.backup,null),info=await file.backup.stat({bigint:true});if(info.size!==0n)return fail('BACKUP_INVALID');file.backupFact={path:file.backupPath,sha256:createHash('sha256').update(Buffer.alloc(0)).digest('hex'),bytes:0,physical:resource(info),attributes:backupAttributes};phase(file,'BACKUP');}
      await file.stage.sync();file.stagedAttributes=await observeSourceFileAttributes(file.stagePath,file.stage);
      const desired=file.restoration?target.restorationAttributes!:target.attributes;if(!target.removeTarget&&desired&&!sameSourceFileAttributes(file.stagedAttributes,desired))return fail('FILE_ATTRIBUTES_UNPROVEN');
      if(!target.removeTarget&&!desired&&!sameSourceFileAttributeProof(file.stagedAttributes,file.backupFact.attributes??null))return fail('FILE_ATTRIBUTES_UNPROVEN');
      phase(file,'STAGED');await file.privateHandle.sync();
    }
    await input.verifyProtection(claims);
    for(const file of files){
      if(input.signal.aborted)return fail('CANCELLED');const target=file.target;
      // 每个真实目标移动前重读同一持久保护；上一项成功不授权下一项。
      await input.verifyProtection(claims);
      assertSourceNamespaceHeld(namespaceProtection.token,namespaceProtection.scope);
      await fenceNamespace(file);
      if(file.original&&target.expected){const current='audioStart'in target.expected?await observeSourceWriteFile(file.original,input.signal):await readHash(file.original,SOURCE_WRITE_FILE_BYTES,input.signal);if(current.sha256!==target.expected.sha256||current.signature!==target.expected.signature)return fail('SOURCE_CHANGED');const named=await lstat(file.absolute,{bigint:true});if(signature(named)!==current.signature||String(named.birthtimeNs)!==target.expected.birthtimeNs)return fail('SOURCE_CHANGED');if(!sameSourceFileAttributes(await observeSourceFileAttributes(file.absolute,file.original),target.attributes))return fail('FILE_ATTRIBUTES_UNPROVEN');}
      if(!sameSourceFileAttributes(await observeSourceFileAttributes(file.stagePath,file.stage),file.stagedAttributes))return fail('FILE_ATTRIBUTES_UNPROVEN');
      await observeSourceBackupAttributes(file.backupPath,file.backup,target.expected?target.attributes:null,file.backupFact!.attributes??null);
      if(file.backupFact!.bytes){const actual=await readHash(file.backup,SOURCE_WRITE_FILE_BYTES,input.signal);if(actual.sha256!==file.backupFact!.sha256||actual.bytes!==file.backupFact!.bytes||actual.physical.dev!==file.backupFact!.physical.dev||actual.physical.ino!==file.backupFact!.physical.ino)return fail('BACKUP_INVALID');}else if((await file.backup.stat({bigint:true})).size!==0n)return fail('BACKUP_INVALID');
      if(!target.removeTarget&&(await readHash(file.stage,SOURCE_WRITE_FILE_BYTES,input.signal)).sha256!==file.stageSha256)return fail('SOURCE_CHANGED');
      phase(file,'CAPTURE_INTENT');
      if(file.original){
        // 已存在且独占的私有目录，quarantine名从未安装；路径缺失窗口真实存在。
        await rename(file.absolute,file.quarantinePath);file.moved=true;await file.privateHandle.sync();await file.parentHandle.sync();
        const captured=await open(file.quarantinePath,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{const actual=await readHash(captured,SOURCE_WRITE_FILE_BYTES),before=target.expected!;if(actual.sha256!==before.sha256||actual.physical.dev!==before.physical.dev||actual.physical.ino!==before.physical.ino||actual.birthtimeNs!==before.birthtimeNs)return fail('REPLACEMENT_UNKNOWN');const attributes=await observeSourceFileAttributes(file.quarantinePath,captured);if(!sameSourceFileAttributes(attributes,target.attributes))return fail('FILE_ATTRIBUTES_UNPROVEN');}finally{await captured.close();}
      }
      phase(file,'CAPTURED');phase(file,'PUBLISH_INTENT');
      await fenceNamespace(file);
      if(!target.removeTarget){await link(file.stagePath,file.absolute);file.published=true;}
      await file.parentHandle.sync();phase(file,'PUBLISHED');
      await unlink(file.stagePath);await file.privateHandle.sync();phase(file,'CLEANUP');
      await fenceNamespace(file);let after:SourceWriteFileObservation|SourcePublishedBlob|null=null;
      if(target.removeTarget){try{await lstat(file.absolute,{bigint:true});return fail('REPLACEMENT_UNKNOWN');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      else {const final=await open(file.absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{after=target.restorationAudio||target.expected&&'audioStart'in target.expected?await observeSourceWriteFile(final):await readHash(final,4194304);if(after.sha256!==file.stageSha256)return fail('REPLACEMENT_UNKNOWN');if(target.change&&target.expected&&'prefix'in target.expected)verifySourceWriteResult(target.expected,after as SourceWriteFileObservation,target.change);const named=await lstat(file.absolute,{bigint:true});if(signature(named)!==after.signature||named.nlink!==1n)return fail('REPLACEMENT_UNKNOWN');const attrs=await observeSourceFileAttributes(file.absolute,final);if(!sameSourceFileAttributes(attrs,file.stagedAttributes))return fail('FILE_ATTRIBUTES_UNPROVEN');}finally{await final.close();}}
      await fenceNamespace(file);
      const backup=file.backupFact!;await input.prepareCommit?.(target,after,backup);await fenceNamespace(file);
      if(after){const named=await lstat(file.absolute,{bigint:true});if(signature(named)!==after.signature||String(named.birthtimeNs)!==after.birthtimeNs)return fail('REPLACEMENT_UNKNOWN');}
      else {try{await lstat(file.absolute,{bigint:true});return fail('REPLACEMENT_UNKNOWN');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      phase(file,'VERIFIED');input.commit(target,after,backup);file.committed=true;applied.push(target.operationId);phase(file,'FACTS_COMMITTED');
    }
    // 引用保留真实能力的最终状态；正常finally释放后不能据此重新品牌化或retain。
    // closure回执丢失仍需材料/能力状态供冷对账，不能把源已变更归为普通失败。
    return {outcome:'confirmed',applied,backups:files.flatMap(f=>f.backupFact?[f.backupFact]:[]),issue:null,retainedProtection:{claims,files,namespaceProtection}};
  }catch(error){
    const uncertain=!!input.physicalRecovery||files.some(f=>(f.moved||f.published)&&!f.committed)||error instanceof LocalFactsCommitFatal||error instanceof PhysicalClaimsUnverified;
    if(uncertain){retained=true;claims?.retain();if(namespaceProtection)retainSourceNamespaceWrite(namespaceProtection.token,input.targets.map(t=>t.operationId));for(const file of files)try{phase(file,'UNKNOWN');}catch{/* 已持久的最末意图仍是恢复依据，不捏造回滚。 */}const issue=error instanceof LocalFactsCommitFatal?'COMMIT_UNKNOWN':error instanceof PhysicalClaimsUnverified?'RELEASE_UNKNOWN':'REPLACEMENT_UNKNOWN';throw new SourcePublicationRecoveryRequired({outcome:'unknown',issue,applied},claims,files,error,namespaceProtection,handles);}
    const issue=error instanceof SourcePublisherError?error.issue:error instanceof PhysicalResourceBusy?'ACTIVE_READER':'BACKUP_UNAVAILABLE';
    return applied.length?{outcome:'confirmed',applied,backups:files.flatMap(f=>f.backupFact?[f.backupFact]:[]),issue,retainedProtection:null}:{outcome:'not-performed',issue,applied:[]};
  }finally{
    if(!retained){
      try{
        if(claims)await closePhysicalWriteClaimDescriptors(claims);
        else{const closed=await Promise.allSettled([...new Set(handles)].map(f=>f.close())),failure=closed.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(failure)throw failure.reason;}
        // QUIET只表示真实FD已关闭；guard继续持有直到这条持久事件确认。
        for(const file of files)phase(file,'QUIET');
        if(namespaceProtection?.recovery){if(!claims)throw new Error('恢复缺少完整真实物理保护。');}
        else{await claims?.release();if(namespaceProtection)await releaseSourceNamespaceWrite(namespaceProtection.token,input.targets.map(t=>t.operationId));}
        reservation?.release();
      }catch(error){const held=claims?.state==='released'?null:claims;held?.retain();if(namespaceProtection)retainSourceNamespaceWrite(namespaceProtection.token,input.targets.map(t=>t.operationId));throw new SourcePublicationRecoveryRequired({outcome:'unknown',issue:'RELEASE_UNKNOWN',applied},held,files,error,namespaceProtection,handles);}
    }
  }
}
