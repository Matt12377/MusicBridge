import { constants } from 'node:fs';
import { open, realpath, lstat, readdir, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isCanonicalUnsignedStatInode, nodeStatInodeAsUnsignedDecimal } from '../shared/filesystem-inode.js';

export interface LibraryWatchBundle { root: string; manifestSha256: string; programSha256: string; programBytes: number }
const admitted = new WeakSet<LibraryWatchBundle>();
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (): never => { throw new Error('本地目录监听未取得当前真实后端或关闭证明。'); };
export const LIBRARY_WATCH_SOURCE = Object.freeze({ relative: 'native/library-watch/fsevents-helper.cpp', bytes: 18771,
  sha256: '41adaa8b5218c257324e52fccbb3c60efce829691fb777686e46041812a3a03a' });
export const LIBRARY_WATCH_FILES = Object.freeze(['manifest.json', 'mb-library-watch', 'legal/fsevents-helper.cpp']);
const watchDependencies = Object.freeze(['/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices',
  '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation', '/usr/lib/libc++.1.dylib', '/usr/lib/libSystem.B.dylib']);
function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}
/** 固定小manifest的全文解析；重复键不能用末值覆盖原编译来源。 */
function parseManifest(raw: Buffer): unknown {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > 65536) return fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw); let at = 0, count = 0;
  const space = (): void => { while (at < text.length && /[\x20\t\r\n]/u.test(text[at]!)) at++; };
  function string(): string {
    const begin = at++; if (text[begin] !== '"') return fail();
    while (at < text.length) { const char = text[at++]; if (char === '"') return JSON.parse(text.slice(begin, at)) as string; if (char === '\\') at++; }
    return fail();
  }
  function value(depth: number): unknown {
    if (depth > 16 || ++count > 4096) return fail(); space(); const char = text[at];
    if (char === '"') return string();
    if (char === '{') {
      at++; space(); const result: Record<string, unknown> = Object.create(null);
      if (text[at] === '}') { at++; return result; }
      while (at < text.length) { space(); if (text[at] !== '"') return fail(); const key = string(); if (Object.hasOwn(result, key)) return fail(); space();
        if (text[at++] !== ':') return fail(); result[key] = value(depth + 1); space(); const next = text[at++]; if (next === '}') return result; if (next !== ',') return fail(); }
    } else if (char === '[') {
      at++; space(); const result: unknown[] = []; if (text[at] === ']') { at++; return result; }
      while (at < text.length) { result.push(value(depth + 1)); space(); const next = text[at++]; if (next === ']') return result; if (next !== ',') return fail(); }
    } else {
      for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) if (text.startsWith(token, at)) { at += token.length; return result; }
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(at)); if (!number) return fail(); at += number[0].length;
      const result = Number(number[0]); if (!Number.isFinite(result) || Number.isInteger(result) && !Number.isSafeInteger(result)) return fail(); return result;
    }
    return fail();
  }
  const result = value(0); space(); if (at !== text.length) return fail(); return result;
}
function watchMachO(bytes: Buffer, declared: readonly string[]): void {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c
    || bytes.readUInt32LE(8) !== 0 || bytes.readUInt32LE(12) !== 2) return fail();
  const count = bytes.readUInt32LE(16), size = bytes.readUInt32LE(20);
  if (count < 1 || count > 256 || size < 1 || size > 65536 || 32 + size > bytes.length) return fail();
  let cursor = 32, platform = 0, signature: { offset: number; bytes: number } | null = null;
  const dependencies: string[] = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > 32 + size) return fail(); const command = bytes.readUInt32LE(cursor), length = bytes.readUInt32LE(cursor + 4);
    if (length < 8 || length % 8 !== 0 || cursor + length > 32 + size) return fail();
    if ([0xc, 0xd, 0x80000018, 0x8000001f, 0x80000023].includes(command)) {
      if (command !== 0xc || length < 24) return fail(); const offset = bytes.readUInt32LE(cursor + 8);
      if (offset < 24 || offset >= length) return fail(); const end = bytes.indexOf(0, cursor + offset);
      if (end < cursor + offset || end >= cursor + length) return fail(); const raw = bytes.subarray(cursor + offset, end), name = raw.toString('utf8');
      if (!Buffer.from(name).equals(raw) || !(watchDependencies as readonly string[]).includes(name)) return fail(); dependencies.push(name);
    } else if (command === 0x8000001c || [0x24, 0x25, 0x2f, 0x30].includes(command)) return fail();
    else if (command === 0x32) { if (length < 24 || bytes.readUInt32LE(cursor + 8) !== 1 || bytes.readUInt32LE(cursor + 12) !== 13 << 16) return fail(); platform++; }
    else if (command === 0x1d) { if (length !== 16 || signature) return fail(); signature = { offset: bytes.readUInt32LE(cursor + 8), bytes: bytes.readUInt32LE(cursor + 12) }; }
    cursor += length;
  }
  if (cursor !== 32 + size || platform !== 1 || JSON.stringify(dependencies) !== JSON.stringify(declared)
    || new Set(dependencies).size !== dependencies.length || JSON.stringify([...dependencies].sort()) !== JSON.stringify([...watchDependencies].sort())
    || !signature || signature.offset < cursor || signature.bytes < 20 || signature.offset + signature.bytes !== bytes.length) return fail();
  const sig = bytes.subarray(signature.offset); if (sig.readUInt32BE(0) !== 0xfade0cc0) return fail();
  const length = sig.readUInt32BE(4), entries = sig.readUInt32BE(8);
  if (entries < 1 || entries > 16 || length > sig.length || length < 12 + entries * 8) return fail(); let directories = 0;
  for (let index = 0; index < entries; index++) {
    const type = sig.readUInt32BE(12 + index * 8), offset = sig.readUInt32BE(16 + index * 8);
    if (offset < 12 + entries * 8 || offset + 8 > length) return fail(); const n = sig.readUInt32BE(offset + 4); if (n < 8 || offset + n > length) return fail();
    if (type !== 0 && !(type >= 0x1000 && type <= 0x1005)) continue; const cd = sig.subarray(offset, offset + n);
    if (cd.length < 64 || cd.readUInt32BE(0) !== 0xfade0c02 || (cd.readUInt32BE(12) & 2) !== 2 || cd[36] !== 32 || cd[37] !== 2 || cd[39]! < 12 || cd[39]! > 16) return fail();
    const hashOffset = cd.readUInt32BE(16), slots = cd.readUInt32BE(28), codeLimit = cd.readUInt32BE(32), page = 2 ** cd[39]!;
    if (codeLimit !== signature.offset || slots !== Math.ceil(codeLimit / page) || hashOffset < 44 || hashOffset + slots * 32 > cd.length) return fail();
    for (let slot = 0; slot < slots; slot++) if (!createHash('sha256').update(bytes.subarray(slot * page, Math.min((slot + 1) * page, codeLimit))).digest().equals(cd.subarray(hashOffset + slot * 32, hashOffset + (slot + 1) * 32))) return fail();
    directories++;
  }
  if (!directories) return fail();
}
/** 供编译/打包与实际Owner共用的纯字节校验；此函数不签WeakSet运行品牌。 */
export function validateLibraryWatchArtifactBytes(manifestRaw: Buffer, program: Buffer, source: Buffer) {
  const manifest = parseManifest(manifestRaw);
  if (!keys(manifest, ['schema', 'platform', 'architecture', 'source', 'program', 'qualifiedRuntime']) || manifest.schema !== 'musicbridge.fsevents-bundle.v1'
    || manifest.platform !== 'darwin' || manifest.architecture !== 'arm64' || manifest.qualifiedRuntime !== false
    || !keys(manifest.source, ['relative', 'bytes', 'sha256']) || manifest.source.relative !== LIBRARY_WATCH_SOURCE.relative
    || manifest.source.bytes !== LIBRARY_WATCH_SOURCE.bytes || manifest.source.sha256 !== LIBRARY_WATCH_SOURCE.sha256
    || !Buffer.isBuffer(source) || source.length !== LIBRARY_WATCH_SOURCE.bytes || sha(source) !== LIBRARY_WATCH_SOURCE.sha256
    || !keys(manifest.program, ['relative', 'bytes', 'sha256', 'dependencies']) || manifest.program.relative !== 'mb-library-watch'
    || !Number.isSafeInteger(manifest.program.bytes) || Number(manifest.program.bytes) < 1 || Number(manifest.program.bytes) > 1024 * 1024
    || typeof manifest.program.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.program.sha256) || !Array.isArray(manifest.program.dependencies)
    || !manifest.program.dependencies.every((item: unknown) => typeof item === 'string') || !Buffer.isBuffer(program)
    || program.length !== manifest.program.bytes || sha(program) !== manifest.program.sha256) return fail();
  watchMachO(program, manifest.program.dependencies as string[]);
  return { manifestSha256: sha(manifestRaw), source: { ...LIBRARY_WATCH_SOURCE },
    program: { relative: 'mb-library-watch', bytes: program.length, sha256: sha(program), dependencies: [...manifest.program.dependencies] as string[] },
    packagingBytesVerified: true as const, runtimeQualificationGranted: false as const };
}
async function whole(file: string, maximum: number): Promise<Buffer> {
  if (await realpath(file) !== file) return fail();
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true }); if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum) || (before.mode & 0o7022n) !== 0n) return fail();
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after] || after[key as keyof typeof after] !== named[key as keyof typeof named])) return fail();
    return bytes;
  } finally { await fd.close(); }
}
export async function loadLibraryWatchBundle(root: string, expectedManifestSha256: string): Promise<LibraryWatchBundle> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/u.test(expectedManifestSha256)) return fail();
  const rootInfo = await lstat(root, { bigint: true }), legal = path.join(root, 'legal'), legalInfo = await lstat(legal, { bigint: true });
  if (await realpath(root) !== root || await realpath(legal) !== legal || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o7022n) !== 0n
    || !legalInfo.isDirectory() || legalInfo.isSymbolicLink() || (legalInfo.mode & 0o7022n) !== 0n
    || JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(['legal', 'manifest.json', 'mb-library-watch'])
    || JSON.stringify(await readdir(legal)) !== JSON.stringify(['fsevents-helper.cpp'])) return fail();
  const bytes = await whole(path.join(root, 'manifest.json'), 65536); if (sha(bytes) !== expectedManifestSha256) return fail();
  const programInfo = await lstat(path.join(root, 'mb-library-watch')); if ((programInfo.mode & 0o111) === 0) return fail();
  const program = await whole(path.join(root, 'mb-library-watch'), 1024 * 1024);
  const source = await whole(path.join(legal, 'fsevents-helper.cpp'), 65536), inspection = validateLibraryWatchArtifactBytes(bytes, program, source);
  const after = await lstat(root, { bigint: true }), afterLegal = await lstat(legal, { bigint: true });
  if (['dev','ino','mode','mtimeNs','ctimeNs'].some(key => rootInfo[key as keyof typeof rootInfo] !== after[key as keyof typeof after] || legalInfo[key as keyof typeof legalInfo] !== afterLegal[key as keyof typeof afterLegal])
    || JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(['legal', 'manifest.json', 'mb-library-watch'])
    || JSON.stringify(await readdir(legal)) !== JSON.stringify(['fsevents-helper.cpp'])
    || !(await whole(path.join(root, 'manifest.json'), 65536)).equals(bytes) || !(await whole(path.join(legal, 'fsevents-helper.cpp'), 65536)).equals(source)) return fail();
  const bundle = Object.freeze({ root, manifestSha256: expectedManifestSha256, programSha256: inspection.program.sha256, programBytes: inspection.program.bytes });
  admitted.add(bundle); return bundle;
}
export interface LibraryDirectoryPhysical {
  dev:string;ino:string;birthtimeNs:string;mode:string;uid:string;gid:string;
}
export interface LibraryDirectoryStructureFacts {
  schema:'musicbridge.directory-structure.fd.v1';bounds:{depth:2;entries:256;childFds:12};root:LibraryDirectoryPhysical;
  directories:Array<LibraryDirectoryPhysical & {relative:string;entries:Array<{name:string;kind:'file'|'directory'|'symlink'|'other'}>}>;
  entriesRead:number;childDirectoriesOpened:number;bounded:false;
  physicalClosed:{inputFd:true;duplicateRootFd:true;childDirectoryFds:true;directoryStreams:true};
}
const directoryPhysicalKeys=['dev','ino','birthtimeNs','mode','uid','gid'] as const;
function directoryPhysical(value:unknown):value is LibraryDirectoryPhysical {
  return keys(value,directoryPhysicalKeys)&&directoryPhysicalKeys.every(key=>typeof value[key]==='string'
    && (key==='ino'?isCanonicalUnsignedStatInode(value[key]):(key==='birthtimeNs'?/^-?(?:0|[1-9][0-9]{0,23})$/u:/^(?:0|[1-9][0-9]{0,19})$/u).test(value[key] as string)))&&(BigInt(value.mode as string)&0o170000n)===0o040000n;
}
function sameDirectoryPhysical(left:LibraryDirectoryPhysical,right:LibraryDirectoryPhysical):boolean {
  return directoryPhysicalKeys.every(key=>left[key]===right[key]);
}
/** 只解析本次Native完整原始回显；纯字节校验不授bundle或Source品牌。 */
export function readLibraryDirectoryStructureBytes(raw:Buffer,expectedRoot:LibraryDirectoryPhysical):LibraryDirectoryStructureFacts {
  if(!directoryPhysical(expectedRoot)||!Buffer.isBuffer(raw)||raw.length<2||raw.length>65536
    ||raw[raw.length-1]!==10||raw.indexOf(10)!==raw.length-1||raw.includes(13))return fail();
  const value=parseManifest(raw);
  if(!keys(value,['schema','bounds','root','directories','entriesRead','childDirectoriesOpened','bounded','physicalClosed'])
    ||value.schema!=='musicbridge.directory-structure.fd.v1'||!keys(value.bounds,['depth','entries','childFds'])
    ||value.bounds.depth!==2||value.bounds.entries!==256||value.bounds.childFds!==12
    ||!directoryPhysical(value.root)||!sameDirectoryPhysical(value.root,expectedRoot)
    ||!Array.isArray(value.directories)||value.directories.length<1||value.directories.length>13
    ||!Number.isSafeInteger(value.entriesRead)||Number(value.entriesRead)<0||Number(value.entriesRead)>256
    ||!Number.isSafeInteger(value.childDirectoriesOpened)||Number(value.childDirectoriesOpened)<0||Number(value.childDirectoriesOpened)>12
    ||value.directories.length!==Number(value.childDirectoriesOpened)+1||value.bounded!==false
    ||!keys(value.physicalClosed,['inputFd','duplicateRootFd','childDirectoryFds','directoryStreams'])
    ||Object.values(value.physicalClosed).some(closed=>closed!==true))return fail();
  const validName=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&Buffer.byteLength(name)<=1024
    &&name!=='.'&&name!=='..'&&!/[\u0000/]/u.test(name)&&!/[\ud800-\udfff]/u.test(name);
  const directories=new Map<string,LibraryDirectoryStructureFacts['directories'][number]>();let entries=0;
  for(const [index,row]of value.directories.entries()){
    if(!keys(row,[...directoryPhysicalKeys,'relative','entries'])||!directoryPhysical(Object.fromEntries(directoryPhysicalKeys.map(key=>[key,row[key]])))
      ||typeof row.relative!=='string'||directories.has(row.relative)||!Array.isArray(row.entries)
      ||index===0&&(row.relative!==''||!sameDirectoryPhysical(row as unknown as LibraryDirectoryPhysical,expectedRoot))
      ||index!==0&&(row.relative===''||row.relative.split('/').length>2||!row.relative.split('/').every(validName)))return fail();
    const names=new Set<string>();
    for(const entry of row.entries){
      if(!keys(entry,['name','kind'])||!validName(entry.name)||names.has(entry.name)
        ||typeof entry.kind!=='string'||!['file','directory','symlink','other'].includes(entry.kind)||++entries>256)return fail();
      names.add(entry.name);
    }
    directories.set(row.relative,row as unknown as LibraryDirectoryStructureFacts['directories'][number]);
  }
  if(entries!==value.entriesRead)return fail();
  for(const [relative]of directories){if(relative==='')continue;const separator=relative.lastIndexOf('/'),parent=separator<0?'':relative.slice(0,separator),name=relative.slice(separator+1);
    if(!directories.get(parent)?.entries.some(entry=>entry.name===name&&entry.kind==='directory'))return fail();}
  return value as unknown as LibraryDirectoryStructureFacts;
}
export interface LibraryDirectoryProbeRaw {
  stdout:Buffer;stderr:Buffer;exitCode:number|null;signal:NodeJS.Signals|null;pid:number|null;pidClosed:boolean;
  overflow:{firstChunkBytes:number;retainedFirstChunkBytes:number;subsequentChunks:number;subsequentBytes:number}|null;
}
/** 业务失败与实际资源闭口分开；没有原进程/pipe闭口时Owner必须保留原目录FD。 */
export class LibraryDirectoryProbeError extends Error {
  constructor(message:string,readonly physicalClosed:boolean,readonly raw:LibraryDirectoryProbeRaw|null,options?:ErrorOptions){super(message,options);this.name='LibraryDirectoryProbeError';}
}
/** 复用同一已核watch程序的私有FD模式；没有命名路径fallback、第二预算或Source许可。 */
export async function probeLibraryDirectoryStructure(bundle:LibraryWatchBundle,options:{
  root:FileHandle;signal:AbortSignal;deadlineAtMs:number;assertCurrent():Promise<void>|void;
}):Promise<{facts:LibraryDirectoryStructureFacts;raw:LibraryDirectoryProbeRaw & {exitCode:0;signal:null;pid:number;pidClosed:true}}> {
  const began=performance.now();
  const rejectBeforeSpawn=(cause:unknown):never=>{throw new LibraryDirectoryProbeError('原FD结构探测在启动前被拒绝。',true,null,{cause});};
  const current=()=>{if(options.signal.aborted||!Number.isFinite(options.deadlineAtMs)||performance.now()>=options.deadlineAtMs)
    throw new Error('原目录结构读取已取消或达到原Owner期限。');};
  let original:import('node:fs').BigIntStats;
  try{
    if(!admitted.has(bundle)||process.platform!=='darwin'||process.arch!=='arm64'||options.deadlineAtMs>began+2000)return fail();
    current();await options.assertCurrent();current();original=await options.root.stat({bigint:true});current();if(!original.isDirectory())return fail();
    const checked=await loadLibraryWatchBundle(bundle.root,bundle.manifestSha256);current();
    if(checked.programSha256!==bundle.programSha256||checked.programBytes!==bundle.programBytes)return fail();
    await options.assertCurrent();current();
  }catch(error){return rejectBeforeSpawn(error);}
  const child=spawn(path.join(bundle.root,'mb-library-watch'),['--probe-structure-fd'],{detached:true,shell:false,
    env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['pipe','pipe','pipe',options.root.fd]});
  const buffers=[[],[]] as Buffer[][];let bytes=0,failure:unknown=null,closed=false,overflow:LibraryDirectoryProbeRaw['overflow']=null;
  const signalGroup=(signal:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failure??=error;}};
  const stop=()=>{failure??=new Error('原目录结构读取已取消。');if(!closed&&!child.stdin!.destroyed)child.stdin!.end('STOP\n');};
  const abort=()=>stop();options.signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{failure??=new Error('原目录结构读取超过原Owner剩余期限。');signalGroup('SIGKILL');},Math.max(0,options.deadlineAtMs-performance.now()));
  for(const [index,stream]of [child.stdout!,child.stderr!].entries())stream.on('data',(chunk:Buffer)=>{
    if(overflow){overflow.subsequentChunks++;overflow.subsequentBytes+=chunk.length;return;}
    const next=bytes+chunk.length;
    if(next>65536){const retained=chunk.subarray(0,65536);buffers[index]!.push(retained);
      overflow={firstChunkBytes:chunk.length,retainedFirstChunkBytes:retained.length,subsequentChunks:0,subsequentBytes:0};
      failure??=new Error('原结构探测完整回显超过64KiB；仅保留有限首超界块作为失败证据。');signalGroup('SIGKILL');return;}
    buffers[index]!.push(chunk);bytes=next;
  });
  child.stdin!.on('error',error=>{failure??=error;signalGroup('SIGKILL');});
  child.once('error',error=>{failure??=error;});
  if(options.signal.aborted)stop();
  let raw:LibraryDirectoryProbeRaw|null=null;
  try{
    const exit=await new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(exitCode,signal)=>{closed=true;resolve({exitCode,signal});}));
    let pidClosed=false;if(child.pid)try{process.kill(-child.pid,0);failure??=new Error('结构探测后代进程尚未关闭。');signalGroup('SIGKILL');}
      catch(error){pidClosed=(error as NodeJS.ErrnoException).code==='ESRCH';if(!pidClosed)failure??=error;}
    const pipesClosed=[child.stdin!,child.stdout!,child.stderr!].every(stream=>stream.destroyed);
    raw={...exit,stdout:Buffer.concat(buffers[0]!),stderr:Buffer.concat(buffers[1]!),pid:child.pid??null,pidClosed,overflow};
    const physicalClosed=closed&&pidClosed&&pipesClosed;
    if(!physicalClosed)throw new LibraryDirectoryProbeError('原结构探测进程或管道闭口未知。',false,raw);
    if(failure||exit.exitCode!==0||exit.signal!==null||raw.stderr.length!==0||!child.pid)
      throw new LibraryDirectoryProbeError('原结构探测未取得当代成功回执。',true,raw,{cause:failure});
    current();await options.assertCurrent();current();const after=await options.root.stat({bigint:true});current();
    if(!after.isDirectory()||directoryPhysicalKeys.some(key=>original[key]!==after[key]))throw new Error('原Owner结构根FD身份改变。');
    const expected=Object.fromEntries(directoryPhysicalKeys.map(key=>[key,key==='ino'?nodeStatInodeAsUnsignedDecimal(original.ino):String(original[key])])) as unknown as LibraryDirectoryPhysical;
    const facts=readLibraryDirectoryStructureBytes(raw.stdout,expected);current();await options.assertCurrent();current();
    return {facts,raw:{...raw,exitCode:0,signal:null,pid:child.pid,pidClosed:true}};
  }catch(error){
    if(error instanceof LibraryDirectoryProbeError)throw error;
    throw new LibraryDirectoryProbeError('原结构建议的原身份/回执或期限未核实。',closed&&raw?.pidClosed===true,raw,{cause:error});
  }finally{clearTimeout(timer);options.signal.removeEventListener('abort',abort);}
}

/** 源根FD与assertCurrent仅由SourceFiles作者给出；每次失效再核同一许可。 */
export async function startLibraryMonitor(bundle: LibraryWatchBundle, options: {
  root: FileHandle; assertCurrent(): Promise<void> | void; invalidate(): Promise<void> | void
}) {
  if (!admitted.has(bundle)) return fail();
  await options.assertCurrent(); const rootIdentity = await options.root.stat({ bigint: true }); if (!rootIdentity.isDirectory()) return fail();
  const currentBundle = await loadLibraryWatchBundle(bundle.root, bundle.manifestSha256);
  if (currentBundle.programSha256 !== bundle.programSha256 || currentBundle.programBytes !== bundle.programBytes) return fail();
  const child = spawn(path.join(bundle.root, 'mb-library-watch'), ['--watch-fd'], { detached: true, shell: false,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['pipe','pipe','pipe',options.root.fd] });
  const raw = [[],[]] as Buffer[][]; let rawBytes = 0, partial = '', ready = false, acknowledged = false, closing = false;
  let invalidationsObserved = 0, callbacksAfterStop = 0, failure: unknown = null, processExited = false;
  const callbacks = new Set<Promise<void>>();
  const kill = (): void => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error; } };
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const started = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startTimer = setTimeout(() => { failure ??= new Error('目录监听未在期限内启动。'); readyReject(failure); kill(); }, 1500);
  child.stdout!.on('data', (bytes: Buffer) => {
    rawBytes += bytes.length; if (rawBytes > 65536) { failure ??= new Error('目录监听回显超过预算。'); kill(); return; } raw[0]!.push(bytes);
    partial += bytes.toString('utf8');
    for (;;) {
      const at = partial.indexOf('\n'); if (at < 0) break; const line = partial.slice(0, at); partial = partial.slice(at + 1);
      if (line === 'READY' && !ready && !acknowledged) { ready = true; clearTimeout(startTimer); readyResolve(); }
      else if (line === 'STOPPED' && closing && ready && !acknowledged) acknowledged = true;
      else if (line === 'INVALIDATE' && ready && !acknowledged) {
        invalidationsObserved++;
        if (!closing) {
          const operation = Promise.resolve().then(async () => {
            await options.assertCurrent(); const current = await options.root.stat({ bigint: true });
            if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) return fail();
            await options.invalidate();
          });
          callbacks.add(operation); void operation.catch(error => { failure ??= error; }).finally(() => callbacks.delete(operation));
        }
      } else {
        if (line === 'INVALIDATE' && acknowledged) callbacksAfterStop++;
        failure ??= new Error('目录监听返回无效协议。'); kill();
      }
    }
  });
  child.stderr!.on('data', (bytes: Buffer) => { rawBytes += bytes.length; if (rawBytes > 65536) { failure ??= new Error('目录监听回显超过预算。'); kill(); } else raw[1]!.push(bytes); });
  child.stdin!.on('error', error => { failure ??= error; readyReject(error); kill(); });
  child.once('error', error => { failure ??= error; readyReject(error); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => {
    processExited = true; if (!closing) failure ??= new Error('目录监听未经关闭确认已退出。');
    clearTimeout(startTimer); if (!ready) readyReject(new Error('目录监听未启动即退出。')); resolve({ code, signal });
  }));
  let closure: Promise<{ stopAcknowledged: true; invalidationsObserved: number; callbacksAfterStop: 0; pid: number; pidClosed: true; stdout: Buffer; stderr: Buffer }> | undefined;
  async function stop() {
    if (closure) return closure; closing = true;
    closure = (async () => {
      const timer = setTimeout(() => { failure ??= new Error('目录监听关闭超过期限。'); kill(); }, 2000);
      try {
        child.stdin!.end('STOP\n'); const result = await exited; await Promise.allSettled([...callbacks]);
        let closed = false;
        if (child.pid) try { process.kill(-child.pid, 0); kill(); } catch (error) { closed = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (failure || result.code !== 0 || result.signal || !acknowledged || partial || callbacksAfterStop !== 0 || !closed || !child.pid) return fail();
        return { stopAcknowledged: true as const, invalidationsObserved, callbacksAfterStop: 0 as const, pid: child.pid,
          pidClosed: true as const, stdout: Buffer.concat(raw[0]!), stderr: Buffer.concat(raw[1]!) };
      } finally { clearTimeout(timer); }
    })();
    return closure;
  }
  try { await started; await options.assertCurrent(); }
  catch (error) { closing = true; kill(); await exited; await Promise.allSettled([...callbacks]); throw error; }
  return { stop, close: stop, inspect: () => ({ ready, closing, acknowledged, invalidationsObserved, callbacksAfterStop, failed: failure !== null, exited: processExited }) };
}

export type LibraryWatchStopReceipt = Awaited<ReturnType<Awaited<ReturnType<typeof startLibraryMonitor>>['stop']>>;
export interface LibraryWatchRootLease {
  readonly root: FileHandle;
  /** 原Root作者的许可代次；不是文件事件读取代次，也不构成新许可。 */
  readonly generation: string;
  assertCurrent(): Promise<void> | void;
  release(): Promise<void> | void;
}
export interface LibraryWatchRegistryOptions {
  bundle: LibraryWatchBundle;
  /** 同一真实Owner/Source作者返回实际目录FD；内部失败资源仍由该作者保留。 */
  acquireRoot(rootId: string): Promise<LibraryWatchRootLease>;
  /** 必须等待Browser/readleases/CUE来源等原失效操作，不得fire-and-forget。 */
  invalidate(rootId: string, generation: string): Promise<void> | void;
}
/** 显式启用的有限目录实例；没有新FD重试、JSON许可或系统监听fallback。 */
export function createLibraryWatchRegistry(options: LibraryWatchRegistryOptions) {
  if (!keys(options, ['bundle', 'acquireRoot', 'invalidate']) || !admitted.has(options.bundle)
    || typeof options.acquireRoot !== 'function' || typeof options.invalidate !== 'function') return fail();
  type Monitor = Awaited<ReturnType<typeof startLibraryMonitor>>;
  interface Entry {
    rootId: string; desired: boolean; status: 'starting' | 'watching' | 'stopping' | 'disabled' | 'failed';
    lease: LibraryWatchRootLease | null; root: FileHandle | null; generation: string | null;
    identity: import('node:fs').BigIntStats | null; monitor: Monitor | null;
    failure: unknown; startTask: Promise<void>; startPromise: Promise<void>;
    stopPromise: Promise<LibraryWatchStopReceipt | null> | null; callbacks: Set<Promise<void>>;
  }
  const entries = new Map<string, Entry>(); let closing = false;
  const rootKey = (rootId: string): void => { if (typeof rootId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(rootId)) return fail(); };
  function failed(entry: Entry, error: unknown): void { entry.failure ??= error; entry.desired = false; entry.status = 'failed'; }
  async function assertLease(entry: Entry): Promise<void> {
    const lease = entry.lease;
    if (!lease || lease.root !== entry.root || lease.generation !== entry.generation || !entry.identity || !entry.root) return fail();
    await lease.assertCurrent();
    const current = await entry.root.stat({ bigint: true });
    if (!current.isDirectory() || current.dev !== entry.identity.dev || current.ino !== entry.identity.ino
      || current.birthtimeNs !== entry.identity.birthtimeNs || lease.root !== entry.root || lease.generation !== entry.generation) return fail();
    await lease.assertCurrent();
  }
  // 仅到期失败，不把超时当物理quiet。原Native仍沿1500/2000ms和64KiB收口；lease保留。
  function bounded<T>(entry: Entry, operation: Promise<T>, label: string): Promise<T> {
    const began = performance.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('目录监听'+label+'超过原Owner关闭期限。'); failed(entry, error); reject(error);
        void stopEntry(entry).catch(() => {});
      }, 2000);
      operation.then(value => {
        clearTimeout(timer);
        if (performance.now() - began >= 2000 || entry.failure !== null) {
          const error = entry.failure ?? new Error('目录监听'+label+'未在原期限内完成。'); failed(entry, error); reject(error);
        } else resolve(value);
      }, error => { clearTimeout(timer); failed(entry, error); reject(error); });
    });
  }
  function invalidate(entry: Entry): Promise<void> {
    const operation = Promise.resolve().then(async () => {
      if (!entry.desired || closing || entry.failure !== null) return;
      await assertLease(entry);
      if (!entry.desired || closing || entry.failure !== null) return;
      await options.invalidate(entry.rootId, entry.generation!);
      await assertLease(entry);
    });
    entry.callbacks.add(operation);
    return operation.catch(error => {
      failed(entry, error); void stopEntry(entry).catch(() => {}); throw error;
    }).finally(() => entry.callbacks.delete(operation));
  }
  function stopEntry(entry: Entry): Promise<LibraryWatchStopReceipt | null> {
    entry.desired = false; if (entry.stopPromise) return entry.stopPromise;
    if (entry.failure === null) entry.status = 'stopping';
    const deadline = performance.now() + 2000;
    const operation = (async (): Promise<LibraryWatchStopReceipt | null> => {
      // 一直等原启动任务；deadline只使结果失败，不伪装晚到FD或子进程已关闭。
      await entry.startTask.catch(() => {});
      const receipt = entry.monitor ? await entry.monitor.stop() : null;
      await Promise.allSettled([...entry.callbacks]);
      if (entry.failure !== null || performance.now() >= deadline) throw entry.failure ?? new Error('目录监听原关闭期限已到。');
      if (entry.monitor) {
        const state = entry.monitor.inspect();
        if (!receipt || !state.exited || state.failed || !state.acknowledged || state.callbacksAfterStop !== 0
          || !receipt.pidClosed || !receipt.stopAcknowledged || receipt.callbacksAfterStop !== 0) return fail();
      }
      if (entry.lease) {
        // 关闭旧lease不向已经撤销的作者获取新权限；只能在原Native和回调quiet后执行。
        if (!entry.root || entry.lease.root !== entry.root) return fail();
        await entry.lease.release();
        try { await entry.root.stat(); return fail(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
        if (entry.failure !== null || performance.now() >= deadline) throw entry.failure ?? new Error('目录监听FD关闭未在原期限内证明。');
        entry.lease = null; entry.root = null; entry.identity = null;
      }
      entry.status = 'disabled'; return receipt;
    })();
    entry.stopPromise = bounded(entry, operation, '关闭'); return entry.stopPromise;
  }
  async function startEntry(entry: Entry): Promise<void> {
    try {
      const lease = await options.acquireRoot(entry.rootId); entry.lease = lease;
      if (!keys(lease, ['root', 'generation', 'assertCurrent', 'release']) || !lease.root
        || typeof lease.root.stat !== 'function' || !Number.isSafeInteger(lease.root.fd) || lease.root.fd < 0
        || typeof lease.assertCurrent !== 'function' || typeof lease.release !== 'function'
        || typeof lease.generation !== 'string' || !lease.generation.length || Buffer.byteLength(lease.generation) > 256
        || /[\u0000-\u001f\u007f]/u.test(lease.generation)) return fail();
      entry.root = lease.root; entry.generation = lease.generation; entry.identity = await entry.root.stat({ bigint: true });
      await assertLease(entry);
      if (!entry.desired || closing || entry.failure !== null) return;
      entry.monitor = await startLibraryMonitor(options.bundle, { root: entry.root,
        assertCurrent: () => assertLease(entry), invalidate: () => invalidate(entry) });
      const state = entry.monitor.inspect(); if (!state.ready || state.failed || state.exited) return fail();
      await assertLease(entry);
      if (entry.desired && !closing && entry.failure === null) entry.status = 'watching';
    } catch (error) { failed(entry, error); throw error; }
  }
  function enable(rootId: string): Promise<void> {
    rootKey(rootId); if (closing) return Promise.reject(new Error('目录监听注册表正在关闭。'));
    const old = entries.get(rootId);
    if (old && old.status !== 'disabled') {
      const native = old.monitor?.inspect();
      if (native?.failed || native?.exited) failed(old, new Error('原目录监听已失败或退出，不能自动重新取FD。'));
      if (old.failure !== null || !old.desired) return Promise.reject(old.failure ?? new Error('原目录监听仍在关闭。'));
      return old.startPromise;
    }
    const entry: Entry = { rootId, desired: true, status: 'starting', lease: null, root: null, generation: null,
      identity: null, monitor: null, failure: null, startTask: Promise.resolve(), startPromise: Promise.resolve(),
      stopPromise: null, callbacks: new Set() };
    entries.set(rootId, entry); entry.startTask = Promise.resolve().then(() => startEntry(entry));
    entry.startPromise = bounded(entry, entry.startTask, '启动');
    void entry.startPromise.catch(() => { void stopEntry(entry).catch(() => {}); }); return entry.startPromise;
  }
  function disable(rootId: string): Promise<LibraryWatchStopReceipt | null> {
    rootKey(rootId); const entry = entries.get(rootId); return entry ? stopEntry(entry) : Promise.resolve(null);
  }
  function watching(rootId: string): boolean {
    rootKey(rootId); const entry = entries.get(rootId), state = entry?.monitor?.inspect();
    return !!entry?.desired && !closing && entry.failure === null && entry.status === 'watching'
      && !!state?.ready && !state.closing && !state.failed && !state.exited;
  }
  function inspect(rootId: string) {
    rootKey(rootId); const entry = entries.get(rootId), native = entry?.monitor?.inspect();
    const isFailed = !!entry && (entry.failure !== null || native?.failed === true || native?.exited === true && entry.desired);
    return Object.freeze({ rootId, status: isFailed ? 'failed' : entry?.status ?? 'disabled', generation: entry?.generation ?? null,
      watching: watching(rootId), leaseRetained: !!entry?.lease, failed: isFailed, exited: native?.exited ?? false });
  }
  return {
    enable, disable, remove: disable, revoke: disable, watching, inspect,
    async close(): Promise<void> {
      closing = true; const results = await Promise.allSettled([...entries.values()].map(stopEntry));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, '目录监听关闭未取得全部原资源证明，lease继续保留。');
    },
  };
}
