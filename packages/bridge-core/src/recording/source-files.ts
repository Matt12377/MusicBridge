import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import type { BigIntStats, Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { physicalResourceLocks, type PhysicalResourceGuard } from '../stream/physical-resource-locks.js';
import { acquirePhysicalReadClaims, PhysicalClaimsUnverified, type PhysicalReadClaims } from '../stream/physical-resource-claims.js';
import { assertPhysicalWriteClaims, assertRetainedPhysicalWriteClaims, type PhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import { LocalFactsCommitFatal } from '../stream/local-source-fence.js';
import { captureSourceNamespace, acquireSourceNamespaceRead, SourceNamespaceCaptureError, SourceNamespaceUnverified, assertSourceNamespaceHeld,
  type SourceNamespaceReadClaims, type SourceNamespaceHeldObservation } from '../stream/source-namespace-claims.js';
import { parseBuffer } from 'music-metadata';
import { isSourceTechnical, type SourceTechnical, type SourceFailure, type SourceAvailability } from '@music-bridge/contracts';

export class SourceFileError extends Error { constructor(readonly code: SourceFailure) { super(code); } }
export interface RootCapability { id: string; path: string; dev: string; ino: string; authorized: boolean; label: string }
export interface FileEvidence { sha256: string; size: number; signature: string; modifiedAt: string; verifiedAt: string; technical: SourceTechnical }
const fail = (code: SourceFailure): never => { throw new SourceFileError(code); };
const signature = (s: BigIntStats): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
const directoryIdentity = (s: BigIntStats): string => [s.dev, s.ino].join(':');
export interface PublicationSource { root: RootCapability; relative: string; expectedSignature?: string }
interface PublicationFile { source: PublicationSource; handle: FileHandle; info: BigIntStats; directoryIds: string[] }
/** 持有对象只在作者内流动，不作为公开回执或失败后的自动重放许可。 */
export class SourcePublicationUnverified extends Error {
  constructor(readonly reason: 'COMMIT_UNVERIFIED' | 'RELEASE_UNVERIFIED', readonly claims: PhysicalReadClaims | undefined, readonly files: readonly PublicationFile[], cause?: unknown, readonly namespaceClaims?: SourceNamespaceReadClaims) {
    super('冻结发布或源保护释放尚未核实，原保护保留。', { cause });
  }
}

/** 真 FD/fstat 得到全集合，再分组取原读保护；跨复核与 COMMIT 保留到实际 FD quiet。 */
export async function withReadonlySourcePublicationClaims<T>(sources: readonly PublicationSource[], signal: AbortSignal, consume: (verify: () => Promise<void>, files: readonly PublicationFile[]) => Promise<T> | T, joinConsumer?: () => Promise<void>): Promise<T> {
  if (!Array.isArray(sources) || !sources.length || sources.length > 2048) return fail('LIMIT_EXCEEDED');
  const files: PublicationFile[] = [];
  let claims: PhysicalReadClaims | undefined, namespaceClaims: SourceNamespaceReadClaims | undefined, retained = false;
  const deadline = Date.now() + 15 * 60_000;
  const check = (): void => { if (signal.aborted) fail('CANCELLED'); if (Date.now() > deadline) fail('LIMIT_EXCEEDED'); };
  const verify = async (): Promise<void> => {
    for (const file of files) {
      check(); const actual = await file.handle.stat({ bigint: true }); check();
      const named = await checkedFile(file.source.root, file.source.relative); check();
      if (signature(actual) !== signature(file.info) || signature(named.info) !== signature(file.info)
        || actual.birthtimeNs !== file.info.birthtimeNs || named.info.birthtimeNs !== file.info.birthtimeNs
        || directoryIdentity(actual) !== directoryIdentity(file.info) || JSON.stringify(named.directoryIds) !== JSON.stringify(file.directoryIds)) fail('CONTENT_CHANGED');
    }
  };
  try {
    const names = [];
    for (const source of sources) { check(); names.push(await readonlySourceNamespace(source.root, source.relative)); }
    namespaceClaims = await acquireSourceNamespaceRead(names);
    for (const source of sources) {
      check(); const first = await checkedFile(source.root, source.relative); check();
      const handle = await open(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const file: PublicationFile = { source, handle, info: first.info, directoryIds: first.directoryIds }; files.push(file);
      const actual = await handle.stat({ bigint: true }); check();
      if (!actual.isFile() || signature(actual) !== signature(first.info) || actual.birthtimeNs !== first.info.birthtimeNs
        || source.expectedSignature !== undefined && source.expectedSignature !== signature(actual)) fail('CONTENT_CHANGED');
      file.info = actual;
    }
    claims = await acquirePhysicalReadClaims(files.map(file => ({ dev: String(file.info.dev), ino: String(file.info.ino) })));
    await verify();
    return await consume(verify, files);
  } catch (error) {
    if (error instanceof LocalFactsCommitFatal || error instanceof PhysicalClaimsUnverified || error instanceof SourceNamespaceUnverified) {
      claims ??= error instanceof PhysicalClaimsUnverified ? error.claims : undefined;
      if (error instanceof SourceNamespaceUnverified && 'release' in error.claims) namespaceClaims ??= error.claims;
      claims?.retain(); namespaceClaims?.retain(); retained = true;
      throw new SourcePublicationUnverified(error instanceof LocalFactsCommitFatal ? 'COMMIT_UNVERIFIED' : 'RELEASE_UNVERIFIED', claims, files, error, namespaceClaims);
    }
    throw error;
  } finally {
    if (!retained) {
      // 继承FD的Native生产者也必须实际quiet；promise返回不能代替子进程/进程组join。
      // 未核实则连原Source FD和两组保护一起保留，不发布虚假的release。
      try { await joinConsumer?.(); }
      catch (error) { claims?.retain(); namespaceClaims?.retain(); retained=true;
        throw new SourcePublicationUnverified('RELEASE_UNVERIFIED',claims,files,error,namespaceClaims); }
      const closed = await Promise.allSettled(files.map(file => file.handle.close()));
      const failure = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) { claims?.retain(); namespaceClaims?.retain(); throw new SourcePublicationUnverified('RELEASE_UNVERIFIED', claims, files, failure.reason, namespaceClaims); }
      if (claims) {
        try { await claims.release(); }
        catch (error) { namespaceClaims?.retain(); throw new SourcePublicationUnverified('RELEASE_UNVERIFIED', claims, files, error, namespaceClaims); }
      }
      try { await namespaceClaims?.release(); }
      catch (error) { throw new SourcePublicationUnverified('RELEASE_UNVERIFIED', claims, files, error, namespaceClaims); }
    }
  }
}
export interface ReadonlySourcePhysicalObservation {
  physical: { dev: string; ino: string }; signature: string; birthtimeNs: string; permissionMode: string;
  rootPhysical: { dev: string; ino: string }; rootSignature: string; rootPermissionMode: string;
  directoryIds: readonly string[]; directorySignatures: readonly string[];
}
/** 私有保护观察使用真实只读FD；返回之前必须实际close并释放原读claim。 */
export async function observeReadonlySourceProtection(root: RootCapability, relative: string, signal: AbortSignal): Promise<ReadonlySourcePhysicalObservation> {
  return withReadonlySourcePublicationClaims([{ root, relative }], signal, async (verify, files) => {
    const file = files[0]!; if (file.info.size < 1n || file.info.size > 68_719_476_736n) return fail('LIMIT_EXCEEDED');
    const ancestorPaths=[root.path];let cursor=root.path;
    for(const part of relative.split('/').slice(0,-1)){cursor=path.join(cursor,part);ancestorPaths.push(cursor);}
    const ancestors:BigIntStats[]=[];
    for(const absolute of ancestorPaths)ancestors.push(await lstat(absolute,{bigint:true}));
    await verify();
    for(const [index,absolute] of ancestorPaths.entries()){
      const current=await lstat(absolute,{bigint:true}),before=ancestors[index]!;
      if(!current.isDirectory()||current.isSymbolicLink()||signature(current)!==signature(before)||current.birthtimeNs!==before.birthtimeNs||current.mode!==before.mode) return fail('CONTENT_CHANGED');
    }
    if(signal.aborted)return fail('CANCELLED');
    return { physical: { dev:String(file.info.dev), ino:String(file.info.ino) }, signature:signature(file.info), birthtimeNs:String(file.info.birthtimeNs),
      permissionMode:String(file.info.mode & 0o7777n), rootPhysical:{dev:root.dev,ino:root.ino}, rootSignature:signature(ancestors[0]!),rootPermissionMode:String(ancestors[0]!.mode & 0o7777n),
      directoryIds:[...file.directoryIds],directorySignatures:ancestors.slice(1).map(directory=>`${signature(directory)}:${directory.mode & 0o7777n}`) };
  });
}
/** 新作者私有观察：真实FD/fstat与同协调器真实性证明；未持有的旧引用仍走原只读入口。 */
export async function observeSourceProtectionWithWriteClaims(root:RootCapability,relative:string,signal:AbortSignal,claims:PhysicalWriteClaims,namespace?:SourceNamespaceHeldObservation):Promise<ReadonlySourcePhysicalObservation> {
  return observeClaimedSourceProtection(root,relative,signal,claims,false,namespace);
}
export async function observeSourceProtectionWithRetainedWriteClaims(root:RootCapability,relative:string,signal:AbortSignal,claims:PhysicalWriteClaims,namespace?:SourceNamespaceHeldObservation):Promise<ReadonlySourcePhysicalObservation>{return observeClaimedSourceProtection(root,relative,signal,claims,true,namespace);}
async function observeClaimedSourceProtection(root:RootCapability,relative:string,signal:AbortSignal,claims:PhysicalWriteClaims,retained:boolean,namespace?:SourceNamespaceHeldObservation):Promise<ReadonlySourcePhysicalObservation> {
  const assert:typeof assertPhysicalWriteClaims=retained?assertRetainedPhysicalWriteClaims:assertPhysicalWriteClaims;assert(claims,[]);
  const namedNamespace = await readonlySourceNamespace(root,relative);
  const assertNamespace = ():void => { if(namespace)assertSourceNamespaceHeld(namespace.token,{datasetId:namespace.datasetId,planId:namespace.planId,originBinding:namespace.originBinding,operations:[{operationId:namespace.operationId,name:namedNamespace}]}); };
  assertNamespace();
  const namespaceClaims = namespace ? undefined : await acquireSourceNamespaceRead([namedNamespace]);
  let handle:FileHandle|undefined, failure:unknown;
  try {
    const named=await checkedFile(root,relative),resource={dev:String(named.info.dev),ino:String(named.info.ino)};
    const held=claims.resources.some(r=>BigInt(r.dev)===named.info.dev&&BigInt(r.ino)===named.info.ino);
    if(!held)return await observeReadonlySourceProtection(root,relative,signal);
    assert(claims,[resource]);
    handle=await open(named.absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
    const first=await handle.stat({bigint:true});
    if(!first.isFile()||signature(first)!==signature(named.info)||first.birthtimeNs!==named.info.birthtimeNs||signal.aborted)return fail('CONTENT_CHANGED');
    const paths=[root.path];let cursor=root.path;
    for(const part of relative.split('/').slice(0,-1)){cursor=path.join(cursor,part);paths.push(cursor);}
    const ancestors:BigIntStats[]=[];for(const absolute of paths)ancestors.push(await lstat(absolute,{bigint:true}));
    const second=await checkedFile(root,relative),actual=await handle.stat({bigint:true});
    if(signature(actual)!==signature(first)||actual.birthtimeNs!==first.birthtimeNs||actual.mode!==first.mode||signature(second.info)!==signature(first)||JSON.stringify(second.directoryIds)!==JSON.stringify(named.directoryIds))return fail('CONTENT_CHANGED');
    for(const [i,absolute]of paths.entries()){const current=await lstat(absolute,{bigint:true}),previous=ancestors[i]!;if(!current.isDirectory()||current.isSymbolicLink()||signature(current)!==signature(previous)||current.mode!==previous.mode||current.birthtimeNs!==previous.birthtimeNs)return fail('CONTENT_CHANGED');}
    assert(claims,[resource]);assertNamespace();if(signal.aborted)return fail('CANCELLED');
    return {physical:resource,signature:signature(actual),birthtimeNs:String(actual.birthtimeNs),permissionMode:String(actual.mode&0o7777n),rootPhysical:{dev:root.dev,ino:root.ino},rootSignature:signature(ancestors[0]!),rootPermissionMode:String(ancestors[0]!.mode&0o7777n),directoryIds:[...named.directoryIds],directorySignatures:ancestors.slice(1).map(d=>`${signature(d)}:${d.mode&0o7777n}`)};
  } catch(error) { failure=error;throw error; }
  finally {
    try{await handle?.close();}catch(error){claims.retain();namespaceClaims?.retain();throw new SourcePublicationUnverified('RELEASE_UNVERIFIED',claims,[],failure??error,namespaceClaims);}
    await namespaceClaims?.release();
  }
}
/** 只把有界的技术块交给探测器；封面、标签及任意文本块不进入解析器。 */
function technicalHeader(prefix: Buffer, size: number): { bytes: Buffer; mimeType: string; virtualSize: number; sampleFrames: number; durationMs?: number } {
  const magic = prefix.subarray(0, 4).toString('ascii');
  if (magic === 'fLaC') {
    if (prefix.length < 42 || (prefix[4]! & 0x7f) !== 0 || prefix.readUIntBE(5, 3) !== 34) return fail('UNSUPPORTED');
    let offset = 4, blocks = 0;
    while (offset + 4 <= prefix.length && ++blocks <= 2048) {
      const length = prefix.readUIntBE(offset + 1, 3), last = (prefix[offset]! & 0x80) !== 0;
      offset += 4 + length;
      if (offset >= size) return fail('UNSUPPORTED');
      if (last) { const bytes = Buffer.from(prefix.subarray(0, 42)); bytes[4] = 0x80; return { bytes, mimeType: 'audio/flac', virtualSize: size, sampleFrames: Number(prefix.readBigUInt64BE(18) & 0xfffffffffn) }; }
    }
    return fail('LIMIT_EXCEEDED');
  }
  const wav = magic === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WAVE';
  const aiff = magic === 'FORM' && prefix.subarray(8, 12).toString('ascii') === 'AIFF';
  if (!wav && !aiff || prefix.length < 12) return fail('UNSUPPORTED');
  const readSize = (at: number): number => wav ? prefix.readUInt32LE(at) : prefix.readUInt32BE(at);
  const end = readSize(4) + 8;
  if (end > size || end < 20) return fail('UNSUPPORTED');
  let format: Buffer | undefined, offset = 12, blocks = 0;
  while (offset + 8 <= prefix.length && ++blocks <= 2048) {
    const id = prefix.subarray(offset, offset + 4).toString('ascii'), length = readSize(offset + 4);
    if (offset + 8 + length > end) return fail('UNSUPPORTED');
    if (id === (wav ? 'fmt ' : 'COMM')) {
      if (format || (wav ? length < 16 || length > 40 : length !== 18) || offset + 8 + length > prefix.length) return fail('UNSUPPORTED');
      format = Buffer.from(prefix.subarray(offset, offset + 8 + length));
      if (wav && ![1, 3].includes(format.readUInt16LE(8))) return fail('UNSUPPORTED');
      // IEEE 浮点只支持 32/64 位；标签解析器不会替我们排除不存在的 16 位格式。
      if (wav && format.readUInt16LE(8) === 3 && ![32, 64].includes(format.readUInt16LE(22))) return fail('UNSUPPORTED');
    } else if (id === (wav ? 'data' : 'SSND')) {
      if (!format || length <= (wav ? 0 : 8)) return fail('UNSUPPORTED');
      if (wav) {
        const channels = format.readUInt16LE(10), bits = format.readUInt16LE(22), align = format.readUInt16LE(20), rate = format.readUInt32LE(12);
        if (!align || !rate || align !== channels * bits / 8 || length % align !== 0 || format.readUInt32LE(16) !== rate * align) return fail('UNSUPPORTED');
      } else {
        if (offset + 16 > prefix.length) return fail('LIMIT_EXCEEDED');
        const frames = format.readUInt32BE(10), channels = format.readUInt16BE(8), bits = format.readUInt16BE(14), dataOffset = prefix.readUInt32BE(offset + 8);
        if (!frames || !channels || !bits || frames * channels * Math.ceil(bits / 8) > length - 8 - dataOffset) return fail('UNSUPPORTED');
      }
      const bytes = Buffer.concat([prefix.subarray(0, 12), format, prefix.subarray(offset, offset + 8)]);
      const virtualSize = bytes.length + length;
      if (wav) bytes.writeUInt32LE(virtualSize - 8, 4); else bytes.writeUInt32BE(virtualSize - 8, 4);
      return { bytes, sampleFrames: wav ? length / format.readUInt16LE(20) : format.readUInt32BE(10), mimeType: wav ? 'audio/wav' : 'audio/aiff', virtualSize, ...(wav ? { durationMs: Math.round(length / format.readUInt16LE(20) / format.readUInt32LE(12) * 1000) } : {}) };
    }
    offset += 8 + length + (length % 2);
  }
  return fail('LIMIT_EXCEEDED');
}
export async function authorizeSourceDirectory(absolutePath: string): Promise<Omit<RootCapability, 'id'>> {
  if (!path.isAbsolute(absolutePath) || absolutePath.includes('\0') || absolutePath.split(path.sep).some(part => part === '..' || part === '.')) return fail('OUTSIDE_ROOT');
  try {
    const canonical = await realpath(absolutePath), info = await lstat(canonical, { bigint: true });
    if (!info.isDirectory() || canonical === path.parse(canonical).root) return fail('OUTSIDE_ROOT');
    return { path: canonical, dev: String(info.dev), ino: String(info.ino), authorized: true, label: path.basename(canonical).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240) || '源目录' };
  } catch (error) { if (error instanceof SourceFileError) throw error; return fail('SOURCE_ROOT_OFFLINE'); }
}
export async function sourceRootAvailability(root: RootCapability): Promise<'ONLINE' | 'SOURCE_ROOT_OFFLINE' | 'REVOKED'> {
  if (!root.authorized) return 'REVOKED';
  try { const info = await lstat(root.path, { bigint: true }); return info.isDirectory() && String(info.dev) === root.dev && String(info.ino) === root.ino && await realpath(root.path) === root.path ? 'ONLINE' : 'SOURCE_ROOT_OFFLINE'; }
  catch { return 'SOURCE_ROOT_OFFLINE'; }
}
export function sourceRelativePath(root: RootCapability, absolutePath: string): string {
  if (!path.isAbsolute(absolutePath) || absolutePath.includes('\0') || absolutePath.split(path.sep).some(part => part === '..' || part === '.')) return fail('OUTSIDE_ROOT');
  const relative = path.relative(root.path, absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail('OUTSIDE_ROOT');
  return relative;
}
interface CheckedSourceFile { absolute: string; info: BigIntStats; directoryIds: string[] }
async function checkedFile(root: RootCapability, relative: string): Promise<CheckedSourceFile> {
  const available = await sourceRootAvailability(root); if (available !== 'ONLINE') return fail(available);
  if (path.isAbsolute(relative) || relative.split(path.sep).some(p => p === '..' || p === '.' || !p)) return fail('OUTSIDE_ROOT');
  const parts = relative.split(path.sep); let current = root.path; const directoryIds: string[] = [];
  try {
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return fail('OUTSIDE_ROOT');
      if (index < parts.length - 1) directoryIds.push(directoryIdentity(info));
      if (index === parts.length - 1) {
        if (await realpath(current) !== current) return fail('OUTSIDE_ROOT');
        return { absolute: current, info, directoryIds };
      }
    }
  } catch (error) { if (error instanceof SourceFileError) throw error; return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'IO_ERROR'); }
  return fail('OUTSIDE_ROOT');
}

async function readonlySourceNamespace(root:RootCapability,relative:string) {
  try { return await captureSourceNamespace(root,relative); }
  catch(error) { if(error instanceof SourceNamespaceCaptureError)return fail(error.code);throw error; }
}
/** 命名位保护在目标 stat/open 前取得；inode 保护仍来自最终真实 FD。 */
async function protectedReadonlyOpen(root: RootCapability, relative: string, validate: (first: CheckedSourceFile) => void = () => undefined): Promise<{ first: CheckedSourceFile; handle: FileHandle; guard: PhysicalResourceGuard }> {
  const namespaceClaims = await acquireSourceNamespaceRead([await readonlySourceNamespace(root,relative)]);
  let handle: FileHandle | undefined, physical: PhysicalResourceGuard | undefined;
  try {
    const first = await checkedFile(root,relative); validate(first);
    handle = await open(first.absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('IO_ERROR'));
    const info = await handle.stat({ bigint: true }); physical = physicalResourceLocks.acquireRead([{ dev: String(info.dev), ino: String(info.ino) }]);
    let released: Promise<void> | undefined;
    const guard: PhysicalResourceGuard = { release: () => released ??= (async () => {
      try { await physical!.release(); } catch(error) { namespaceClaims.retain(); throw error; }
      await namespaceClaims.release();
    })() };
    return {first,handle,guard};
  } catch(error) {
    try { await handle?.close(); } catch(closeError) { namespaceClaims.retain(); throw closeError; }
    try { await physical?.release(); } catch(releaseError) { namespaceClaims.retain(); throw releaseError; }
    await namespaceClaims.release(); throw error;
  }
}
/** 普通播放专用只读FD；允许已授权根内硬链接，但不放宽Scanner或录音检查。
 * stat/命名身份只能拒绝可观察变化，不能证明NAS缓存或恢复时间戳的隐蔽原地修改不存在。
 * 此租约没有完整Hash证书，不能替代旧录音的严格内容证明。
 */
export async function openLocalPlaybackReadonlySource(root: RootCapability, relative: string, expectedSignature?: string): Promise<{ handle: FileHandle; size: number; signature: string; verify(): Promise<void>; close(): Promise<void> }> {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\0')) return fail('OUTSIDE_ROOT');
  const { first, handle, guard } = await protectedReadonlyOpen(root,relative,first=>{
    // Pool必须传唯一Owner捕获的signature；不能在这里以当前stat替旧catalog修订自证。
    if (expectedSignature !== undefined && (typeof expectedSignature !== 'string' || expectedSignature.length > 256 || signature(first.info) !== expectedSignature)) return fail('CONTENT_CHANGED');
    if (first.info.size < 1n || first.info.size > 68_719_476_736n) return fail('LIMIT_EXCEEDED');
  }); let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => { await handle.close(); await guard.release(); })();
  const verify = async (): Promise<void> => {
    const opened = await handle.stat({ bigint: true }), named = await checkedFile(root, relative);
    if (signature(opened) !== (expectedSignature ?? signature(first.info)) || signature(named.info) !== (expectedSignature ?? signature(first.info))
      || opened.birthtimeNs !== first.info.birthtimeNs || JSON.stringify(named.directoryIds) !== JSON.stringify(first.directoryIds)) return fail('CONTENT_CHANGED');
  };
  try { await verify(); return { handle, size: Number(first.info.size), signature: signature(first.info), verify, close }; }
  catch (error) { await close(); throw error; }
}

/** 候选扫描只枚举目录项；进入和离开目录时都核验根内目录身份，不跟随符号链接。 */
export async function readonlySourceDirectoryEntries(root: RootCapability, relative: string, remaining: number, signal: AbortSignal, deadlineMs: number): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const check = (): void => { if (signal.aborted) fail('CANCELLED'); if (Date.now() > deadlineMs) fail('LIMIT_EXCEEDED'); };
  check();
  const available = await sourceRootAvailability(root); if (available !== 'ONLINE') return fail(available);
  if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > 3000) return fail('LIMIT_EXCEEDED');
  const parts = relative ? relative.split(path.sep) : [];
  if (path.isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..')) return fail('OUTSIDE_ROOT');
  let current = root.path;
  try {
    for (const part of parts) {
      check();
      current = path.join(current, part);
      const info = await lstat(current, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) return fail('OUTSIDE_ROOT');
    }
    const before = await lstat(current, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(current) !== current) return fail('OUTSIDE_ROOT');
    const entries: Dirent[] = [];
    const handle = await opendir(current);
    try {
      while (entries.length < remaining) {
        check();
        const entry = await handle.read();
        check();
        if (!entry) break;
        entries.push(entry);
      }
    } finally {
      try { await handle.close(); } catch { throw new MetadataLeaseReleaseError(); }
    }
    check();
    // 恰好触及限额时保守标记截断，避免为判断“是否还有下一项”突破全局读取预算。
    const truncated = entries.length === remaining;
    const after = await lstat(current, { bigint: true });
    check();
    if (signature(before) !== signature(after) || !after.isDirectory() || await realpath(current) !== current || await sourceRootAvailability(root) !== 'ONLINE') return fail('CONTENT_CHANGED');
    return { entries, truncated };
  } catch (error) {
    if (error instanceof SourceFileError || error instanceof MetadataLeaseReleaseError) throw error;
    return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'IO_ERROR');
  }
}
/** 扫描阶段只读取 stat，不读取文件内容、Hash 或技术头部。 */
export async function readonlySourceCandidateMetadata(root: RootCapability, relative: string): Promise<{ signature: string; directoryIds: readonly string[]; size: number; modifiedAt: string }> {
  const { info, directoryIds } = await checkedFile(root, relative);
  // 一个硬链接可把授权根外的同一 inode 伪装为根内候选；候选自动发现保守跳过。
  if (info.nlink !== 1n) return fail('OUTSIDE_ROOT');
  if (info.size < 1n || info.size > 68_719_476_736n) return fail('LIMIT_EXCEEDED');
  return { signature: signature(info), directoryIds, size: Number(info.size), modifiedAt: new Date(Number(info.mtimeNs / 1_000_000n)).toISOString() };
}
/** 固定叶名只恢复同一规范父目录中的实际大小写；原Source严格读取合同不变。 */
export async function readonlySourceCaseMatchedCandidateMetadata(root:RootCapability,relative:string,assertCurrent:()=>void):Promise<{relative:string;signature:string;directoryIds:readonly string[];size:number;modifiedAt:string}>{
  const check=():void=>assertCurrent();check();
  if(path.isAbsolute(relative)||relative.split(path.sep).some(part=>!part||part==='.'||part==='..'))return fail('OUTSIDE_ROOT');
  const available=await sourceRootAvailability(root);check();if(available!=='ONLINE')return fail(available);
  const parts=relative.split(path.sep),leaf=parts.at(-1)!;
  // 此发现口仅供固定ASCII文件名；不把任意路径或Unicode归一化变成新许可。
  if(!/^[A-Za-z0-9._-]{1,240}$/u.test(leaf))return fail('OUTSIDE_ROOT');
  const ancestors:{absolute:string;info:BigIntStats}[]=[];let parent=root.path;
  const same=(a:BigIntStats,b:BigIntStats):boolean=>signature(a)===signature(b)&&a.birthtimeNs===b.birthtimeNs&&a.mode===b.mode&&a.uid===b.uid&&a.gid===b.gid&&a.nlink===b.nlink;
  try{
    for(const part of ['',...parts.slice(0,-1)]){
      if(part)parent=path.join(parent,part);check();const info=await lstat(parent,{bigint:true});check();
      if(!info.isDirectory()||info.isSymbolicLink()||await realpath(parent)!==parent)return fail('OUTSIDE_ROOT');check();ancestors.push({absolute:parent,info});
    }
    const requested=path.join(parent,leaf),before=await lstat(requested,{bigint:true});check();
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)return fail('OUTSIDE_ROOT');
    const actual=await realpath(requested);check();
    if(path.dirname(actual)!==parent||path.basename(actual).toLowerCase()!==leaf.toLowerCase())return fail('OUTSIDE_ROOT');
    const matched=path.relative(root.path,actual),checked=await checkedFile(root,matched);check();
    if(!same(before,checked.info))return fail('CONTENT_CHANGED');
    const metadata=await readonlySourceCandidateMetadata(root,matched);check();
    const after=await lstat(requested,{bigint:true});check();
    if(!after.isFile()||after.isSymbolicLink()||!same(before,after)||metadata.signature!==signature(before))return fail('CONTENT_CHANGED');
    for(const ancestor of ancestors){const current=await lstat(ancestor.absolute,{bigint:true});check();if(!current.isDirectory()||current.isSymbolicLink()||!same(ancestor.info,current)||await realpath(ancestor.absolute)!==ancestor.absolute)return fail('CONTENT_CHANGED');check();}
    if(await sourceRootAvailability(root)!=='ONLINE')return fail('SOURCE_ROOT_OFFLINE');check();
    return {relative:matched,...metadata};
  }catch(error){if(error instanceof SourceFileError)throw error;return fail((error as NodeJS.ErrnoException).code==='ENOENT'?'MISSING':'IO_ERROR');}
}
export async function sourceFileAvailability(root: RootCapability, relative: string, expected: string): Promise<SourceAvailability> {
  try { return signature((await checkedFile(root, relative)).info) === expected ? 'ONLINE' : 'CONTENT_CHANGED'; }
  catch (error) { const code = error instanceof SourceFileError ? error.code : 'IO_ERROR'; return code === 'REVOKED' || code === 'SOURCE_ROOT_OFFLINE' || code === 'MISSING' ? code : 'CONTENT_CHANGED'; }
}
export class SourceCatalogReleaseError extends Error { constructor() { super('目录资格的只读句柄关闭尚未确认。'); } }
/** Owner 目录的即时只读资格；最多读 12 字节，不签票据、不保留 FD，也不代替真正 prepare 的保护租约。 */
export function readonlySourceCatalogFileAvailable(root: RootCapability, relative: string, expectedSignature: string,
  pcmHeader?: 'WAVE' | 'AIFF'): boolean {
  let descriptor: number | undefined;
  try {
    if (!root.authorized || !path.isAbsolute(root.path) || root.path === path.parse(root.path).root
      || typeof relative !== 'string' || relative.length > 4096 || relative.includes('\0') || path.isAbsolute(relative)
      || typeof expectedSignature !== 'string' || expectedSignature.length > 256 || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30}):\d+:-?\d+:-?\d+$/u.test(expectedSignature)) return false;
    const parts = relative.split(path.sep);
    if (parts.length > 256 || parts.some(part => !part || part === '.' || part === '..')) return false;
    const named = () => {
      const rootInfo = lstatSync(root.path, { bigint: true });
      if (!root.authorized || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() || String(rootInfo.dev) !== root.dev
        || String(rootInfo.ino) !== root.ino || realpathSync(root.path) !== root.path) return fail('SOURCE_ROOT_OFFLINE');
      const identity = (info: BigIntStats) => `${directoryIdentity(info)}:${info.birthtimeNs}:${info.mode}`;
      const directoryIds = [identity(rootInfo)];
      let absolute = root.path;
      for (const [index, part] of parts.entries()) {
        absolute = path.join(absolute, part);
        const info = lstatSync(absolute, { bigint: true });
        if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return fail('OUTSIDE_ROOT');
        if (index < parts.length - 1) directoryIds.push(identity(info));
        else {
          if (realpathSync(absolute) !== absolute) return fail('OUTSIDE_ROOT');
          return { absolute, info, directoryIds };
        }
      }
      return fail('OUTSIDE_ROOT');
    };
    const before = named();
    if (signature(before.info) !== expectedSignature || before.info.size < 1n || before.info.size > 68_719_476_736n) return false;
    // 非阻塞标志保证命名竞争替换成 FIFO 等特殊文件时，目录请求不会等待另一端。
    descriptor = openSync(before.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || signature(opened) !== expectedSignature || opened.birthtimeNs !== before.info.birthtimeNs) return false;
    if (pcmHeader !== undefined) {
      const head = Buffer.alloc(12);
      if (readSync(descriptor, head, 0, head.length, 0) !== head.length) return false;
      const magic = head.subarray(0, 4).toString('ascii'), kind = head.subarray(8, 12).toString('ascii');
      if (pcmHeader === 'WAVE' ? magic !== 'RIFF' || kind !== 'WAVE' : magic !== 'FORM' || kind !== 'AIFF') return false;
    }
    const actual = fstatSync(descriptor, { bigint: true }), after = named();
    return actual.isFile() && signature(actual) === expectedSignature && signature(after.info) === expectedSignature
      && actual.birthtimeNs === opened.birthtimeNs && after.info.birthtimeNs === opened.birthtimeNs
      && JSON.stringify(after.directoryIds) === JSON.stringify(before.directoryIds);
  } catch { return false; }
  finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); }
      catch { throw new SourceCatalogReleaseError(); }
    }
  }
}
export class MetadataLeaseReleaseError extends Error { constructor() { super('元数据只读租期的句柄关闭未确认。'); } }
export interface MetadataSourceLeaseEvent { type: 'lease-acquired' | 'lease-released'; fd: number }
/** 标签扫描的stat身份租期：不全Hash、不调用旧录音技术探测；消费必须先join实际worker。 */
export async function withCheckedReadonlyMetadataSource<T>(root: RootCapability, relative: string, expectedSignature: string, signal: AbortSignal,
  consume: (handle: FileHandle, size: number) => Promise<T>, assertCurrent?: () => void,
  onLeaseEvent?: (event: MetadataSourceLeaseEvent) => void): Promise<T> {
  const check = (): void => { assertCurrent?.(); if (signal.aborted) fail('CANCELLED'); };
  check();
  if (relative.includes('\0') || relative.length > 4096) return fail('OUTSIDE_ROOT');
  const { first, handle, guard } = await protectedReadonlyOpen(root,relative,first=>{check();
    if (typeof expectedSignature !== 'string' || expectedSignature.length > 256 || signature(first.info) !== expectedSignature) return fail('CONTENT_CHANGED');
    if (first.info.nlink !== 1n) return fail('OUTSIDE_ROOT');
    if (first.info.size < 1n || first.info.size > 68_719_476_736n) return fail('LIMIT_EXCEEDED');
  });
  const fd = handle.fd;
  const emit = (type: MetadataSourceLeaseEvent['type']): void => { try { onLeaseEvent?.({type,fd}); } catch { /* 观察者不能阻止关闭。 */ } };
  try {
    emit('lease-acquired');
    const before = await handle.stat({bigint:true});
    const verify = async (): Promise<void> => {
      const opened = await handle.stat({bigint:true}), named = await checkedFile(root,relative);
      if (opened.nlink !== 1n || named.info.nlink !== 1n || signature(opened) !== expectedSignature || signature(named.info) !== expectedSignature
        || JSON.stringify(named.directoryIds) !== JSON.stringify(first.directoryIds)) return fail('CONTENT_CHANGED');
    };
    if (signature(before) !== expectedSignature) return fail('CONTENT_CHANGED');
    await verify(); check();
    let value: T | undefined, caught = false, originalError: unknown;
    try { value = await consume(handle,Number(before.size)); }
    catch (error) { caught = true; originalError = error; }
    // 取消/解析失败也等consume实际终结之后重核，不race释放仍在使用的FD。
    await verify(); assertCurrent?.();
    if (caught) throw originalError;
    check(); return value as T;
  } finally {
    try { await handle.close(); }
    catch { throw new MetadataLeaseReleaseError(); }
    await guard.release();
    emit('lease-released');
  }
}
/** Core 内部只读句柄租期：完整 Hash 后读取，结束时重核文件与授权身份；不公开句柄或路径。 */
export async function withVerifiedReadonlySource<T>(root: RootCapability, relative: string, expected: { sha256: string; size: number }, signal: AbortSignal, consume: (handle: FileHandle, check: () => void) => Promise<T>, checkOperation: () => void = () => undefined): Promise<T> {
  const deadline = Date.now() + 15 * 60_000;
  const check = (): void => { checkOperation(); if (signal.aborted) fail('CANCELLED'); if (Date.now() > deadline) fail('LIMIT_EXCEEDED'); };
  check(); const { first, handle, guard } = await protectedReadonlyOpen(root,relative,first=>{
    if (!/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 68_719_476_736 || first.info.size !== BigInt(expected.size)) return fail('CONTENT_CHANGED');
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (signature(before) !== signature(first.info) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < expected.size) {
      check(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset);
      if (!bytesRead) return fail('CONTENT_CHANGED'); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (hash.digest('hex') !== expected.sha256) return fail('HASH_MISMATCH');
    if (signature(await handle.stat({ bigint: true })) !== signature(before)) return fail('CONTENT_CHANGED');
    check(); const result = await consume(handle, check); check();
    if (signature(await handle.stat({ bigint: true })) !== signature(before) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    return result;
  } finally { await handle.close(); await guard.release(); }
}
export interface ReplicaSourceLeaseOptions {
  /** 必须由冻结帧数/采样率计算；公开请求没有时长或期限参数。 */
  durationMs: number;
  preparationTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  watchIntervalMs?: number;
  /** 只供可信测试注入单调时钟，不改变生产上限。 */
  now?: () => number;
  /** 同FD格式/PCM核验属于准备阶段，不能挤占消费余量。 */
  verify?: (handle: FileHandle, check: () => void, signal: AbortSignal) => Promise<void>;
  finalize?: (handle: FileHandle, check: () => void, signal: AbortSignal) => Promise<void>;
  /** 仅Core内部使用；拒绝/超时并不能代替FD实际关闭的事实。 */
  onLeaseEvent?: (event: 'acquired' | 'released' | 'release-unverified') => void;
}
/** Replica独立有限租期；旧源/编译调用的15分钟默认完全不变。 */
export async function withVerifiedReadonlyReplicaSource<T>(root: RootCapability, relative: string, expected: { sha256: string; size: number }, signal: AbortSignal,
  consume: (handle: FileHandle, check: () => void, signal: AbortSignal) => Promise<T>, checkOperation: () => void, options: ReplicaSourceLeaseOptions): Promise<T> {
  const limit = (value: number | undefined, maximum: number): number => { const n = value ?? maximum; if (!Number.isSafeInteger(n) || n < 1 || n > maximum) return fail('LIMIT_EXCEEDED'); return n; };
  const duration = limit(options.durationMs, 6 * 60 * 60_000), preparation = limit(options.preparationTimeoutMs, 15 * 60_000), finalization = limit(options.finalizationTimeoutMs, 15 * 60_000);
  const watchMs = limit(options.watchIntervalMs, 1000), now = options.now ?? (() => performance.now());
  const controller = new AbortController(), started = now(), totalDeadline = started + preparation + duration + 120_000 + finalization;
  let deadline = started + preparation;
  const abort = (error: unknown) => { if (!controller.signal.aborted) controller.abort(error); };
  const forwarded = () => abort(signal.reason instanceof Error ? signal.reason : new SourceFileError('CANCELLED'));
  signal.addEventListener('abort', forwarded, { once: true }); if (signal.aborted) forwarded();
  const check = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason;
    try { checkOperation(); if (now() > Math.min(deadline, totalDeadline)) fail('LIMIT_EXCEEDED'); }
    catch (error) { abort(error); throw error; }
  };
  let guard: PhysicalResourceGuard | undefined;
  let handle: FileHandle | undefined, control: ReturnType<typeof setInterval> | undefined, watcher: ReturnType<typeof setInterval> | undefined, watching: Promise<void> | undefined;
  try {
    check(); const protectedFile = await protectedReadonlyOpen(root,relative,first=>{
      if (!/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 68_719_476_736 || first.info.size !== BigInt(expected.size) || first.info.nlink !== 1n) return fail('CONTENT_CHANGED');
    }); const first = protectedFile.first; handle = protectedFile.handle; guard = protectedFile.guard;
    options.onLeaseEvent?.('acquired');
    const opened = handle, before = await opened.stat({ bigint: true });
    const verifyIdentity = async () => { check(); const current = await opened.stat({ bigint: true }), named = (await checkedFile(root, relative)).info; check(); if (current.nlink !== 1n || named.nlink !== 1n || signature(current) !== signature(before) || signature(named) !== signature(before)) fail('CONTENT_CHANGED'); };
    if (signature(before) !== signature(first.info)) return fail('CONTENT_CHANGED');
    const hashFile = async () => {
      const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
      while (offset < expected.size) { check(); const { bytesRead } = await opened.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset); if (!bytesRead) fail('CONTENT_CHANGED'); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead; }
      check(); if (hash.digest('hex') !== expected.sha256) fail('HASH_MISMATCH');
    };
    control = setInterval(() => { try { check(); } catch (error) { abort(error); } }, 50);
    await verifyIdentity(); await hashFile(); await options.verify?.(opened, check, controller.signal); await verifyIdentity();
    deadline = Math.min(totalDeadline - finalization, now() + duration + 120_000);
    watcher = setInterval(() => { if (!watching) watching = verifyIdentity().catch(abort).finally(() => { watching = undefined; }); }, watchMs);
    // consume必须等待其持有者真正close；超时只撤销signal，绝不race后释放仍在使用的FD。
    const result = await consume(opened, check, controller.signal);
    check(); clearInterval(watcher); if (watching) await watching; check();
    deadline = Math.min(totalDeadline, now() + finalization);
    await verifyIdentity(); await hashFile(); await options.finalize?.(opened, check, controller.signal); await verifyIdentity(); check(); return result;
  } finally {
    clearInterval(control); clearInterval(watcher); signal.removeEventListener('abort', forwarded);
    if (watching) await watching;
    if (handle) {
      try { await handle.close(); await guard?.release(); options.onLeaseEvent?.('released'); }
      catch (error) { options.onLeaseEvent?.('release-unverified'); throw error; }
    }
  }
}
/** 目标句柄由工作区层排他创建；这里不接收目标路径，也不修改原件属性。 */
export async function copyReadonlySource(root: RootCapability, relative: string, expected: { sha256: string; size: number }, destination: FileHandle, signal: AbortSignal): Promise<{ sha256: string; size: number }> {
  const checkAbort = (): void => { if (signal.aborted) fail('CANCELLED'); };
  checkAbort(); const protectedFile = await protectedReadonlyOpen(root,relative,first=>{
    if (!Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 68_719_476_736 || first.info.size !== BigInt(expected.size)) return fail('CONTENT_CHANGED');
  }), first = protectedFile.first, source = protectedFile.handle;
  try {
    const before = await source.stat({ bigint: true }), target = await destination.stat({ bigint: true });
    if (signature(before) !== signature(first.info) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    if (!target.isFile() || target.size !== 0n || (target.dev === before.dev && target.ino === before.ino)) return fail('IO_ERROR');
    const inputHash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024), deadline = Date.now() + 15 * 60_000;
    let offset = 0;
    while (offset < expected.size) {
      checkAbort(); if (Date.now() > deadline) return fail('LIMIT_EXCEEDED');
      const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset);
      if (!bytesRead) return fail('CONTENT_CHANGED');
      inputHash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        checkAbort();
        const { bytesWritten } = await destination.write(chunk, written, bytesRead - written, offset + written);
        if (!bytesWritten) return fail('IO_ERROR');
        written += bytesWritten;
      }
      offset += bytesRead;
    }
    checkAbort();
    if (signature(await source.stat({ bigint: true })) !== signature(before) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    if (inputHash.digest('hex') !== expected.sha256) return fail('HASH_MISMATCH');
    await destination.sync();
    const outputHash = createHash('sha256'); offset = 0;
    while (offset < expected.size) {
      checkAbort();
      const { bytesRead } = await destination.read(chunk, 0, Math.min(chunk.length, expected.size - offset), offset);
      if (!bytesRead) return fail('HASH_MISMATCH');
      outputHash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    checkAbort();
    if ((await destination.stat()).size !== expected.size || outputHash.digest('hex') !== expected.sha256) return fail('HASH_MISMATCH');
    if (signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    return { sha256: expected.sha256, size: expected.size };
  } finally { await source.close(); await protectedFile.guard.release(); }
}
/** 原件始终只读；完整 Hash 与头部技术探测是独立证据，不宣称音频逐帧解码通过。 */
export async function probeReadonlySource(root: RootCapability, relative: string, signal: AbortSignal): Promise<FileEvidence> {
  const checkAbort = (): void => { if (signal.aborted) fail('CANCELLED'); };
  checkAbort(); const { first, handle, guard } = await protectedReadonlyOpen(root,relative,first=>{
    if (first.info.size <= 0n || first.info.size > 68_719_476_736n) return fail('LIMIT_EXCEEDED');
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (signature(before) !== signature(first.info) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
    // 探测最多取前 16 MiB；超大头部或需要文件尾才能探测的格式明确拒绝。
    const prefix = Buffer.alloc(Math.min(Number(before.size), 16 * 1024 * 1024));
    let offset = 0; const deadline = Date.now() + 15 * 60_000;
    while (offset < Number(before.size)) {
      checkAbort(); if (Date.now() > deadline) return fail('LIMIT_EXCEEDED');
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      if (!bytesRead) return fail('CONTENT_CHANGED');
      hash.update(chunk.subarray(0, bytesRead));
      if (offset < prefix.length) chunk.copy(prefix, offset, 0, Math.min(bytesRead, prefix.length - offset));
      offset += bytesRead;
    }
    checkAbort();
    const header = technicalHeader(prefix, Number(before.size));
    const metadata = await parseBuffer(header.bytes, { mimeType: header.mimeType, size: header.virtualSize }, { skipCovers: true, skipPostHeaders: true }).catch(() => fail('UNSUPPORTED'));
    const f = metadata.format;
    const technical = { container: f.container, codec: f.codec, sampleRate: f.sampleRate, channels: f.numberOfChannels,
      durationMs: f.sampleRate === undefined ? undefined : Math.round(header.sampleFrames / f.sampleRate * 1000), lossless: f.lossless, sampleFrames: header.sampleFrames, frameEvidence: 'container-declared',
      ...(f.bitsPerSample ? { bitsPerSample: f.bitsPerSample } : {}) };
    if (!isSourceTechnical(technical) || !technical.lossless) return fail('UNSUPPORTED');
    checkAbort();
    if (signature(await handle.stat({ bigint: true })) !== signature(before) || signature((await checkedFile(root, relative)).info) !== signature(before)) return fail('CONTENT_CHANGED');
    return { sha256: hash.digest('hex'), size: Number(before.size), signature: signature(before), modifiedAt: new Date(Number(before.mtimeNs / 1_000_000n)).toISOString(), verifiedAt: new Date().toISOString(), technical };
  } finally { await handle.close(); await guard.release(); }
}

// 独立LYRICS作者：不把标签/封面旧范围cast成歌词，也不改变旧publisher的4MiB边界。
import { link as lyricsLink, rename as lyricsRename, unlink as lyricsUnlink } from 'node:fs/promises';
import { acquirePhysicalWriteClaims, registerPhysicalWriteClaimDescriptors, closePhysicalWriteClaimDescriptors, releaseRetainedPhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import { acquireSourceNamespaceWrite, releaseSourceNamespaceWrite, retainSourceNamespaceWrite, type SourceNamespaceOperation, type SourceNamespaceHeldScope } from '../stream/source-namespace-claims.js';
import { sourceWritesPolicy } from '../collection/local-source-writes-journal.js';
import { assertSourceWritesMainActor, requestSourceWritesLyricsGrant, assertSourceWritesLyricsGrant, SourceWritesLyricsGrantError, type SourceWritesMainActor, type SourceWritesLyricsGrant } from '../collection/source-writes-authority.js';
import { LocalLyricsError, lyricsCanonical, lyricsDigest, type LocalLyricsSaveIntent, type LocalLyricsSelectedBody, type LocalLyricsSaveRecord, type LocalLyricsProtectedWriteResult } from '../collection/local-library-lyrics/types.js';
import { assertLocalLyricsSaveRecord } from '../collection/local-library-lyrics/save-coordinator.js';
import type { LocalCatalogStore } from '../collection/local-catalog-store.js';
import type { DatasetIdentity } from './dataset-identity.js';
import type { LocalLyricsWriteBinding, LocalLyricsHeldPublication, LocalLyricsSourceFilesAuthor } from '../collection/local-library-workbench/lyrics-writer.js';
import type { SourceFileAttributes, PublisherTarget } from '../collection/source-writes-publisher.js';
import { LOCAL_LYRICS_PHYSICAL_LIMITS, captureLocalLyricsPhysicalBinding, captureLocalLyricsPhysicalGroup, captureLocalLyricsPhysicalRecord,
  assertLocalLyricsPhysicalTransition, localLyricsPhysicalOperationId, lyricsPhysicalDigest, observeLyricsSourceAttributes,
  assertLyricsNativeFidelityPort, lyricsNativeTemporaryRoot, observeLyricsSourceFormat, type LyricsNativeFidelityPort, type LyricsNativeBaseline, type LocalLyricsPhysicalStore, type LocalLyricsPhysicalBinding,
  type LocalLyricsPhysicalRecord, type LocalLyricsPhysicalGroup, type LocalLyricsPhysicalArtifact, type LocalLyricsPhysicalResource } from '../library/lyrics-source-format.js';

export interface LyricsResolvedOriginalGroup {
  /** 原Owner保存capture的完整摘要；自身提交造成的变化必须由原commit lineage复核，不能刷新水位充授权。 */
  captureSha256:string;group:LocalLyricsPhysicalGroup;roots:readonly RootCapability[];
  assertCurrent():void|Promise<void>;
}
export interface LyricsSourceSafetyPort {
  reserveLyrics(targets:readonly PublisherTarget[],extraBytes:number):Promise<{id:string;directory:string;release():void}>;
}
export interface LyricsSourceFilesAuthorOptions {
  identity:DatasetIdentity;ownerEpoch:string;catalog:LocalCatalogStore&LocalLyricsPhysicalStore;
  mainActor:SourceWritesMainActor;native:LyricsNativeFidelityPort;sourceSafety:LyricsSourceSafetyPort;
  /** 原writer实际TagLib actor的join；不可用race或声明字段代替子进程关闭。 */
  joinTaggedWriter(commandId:string):Promise<void>;
  /** Root唯一原作者从saved intent/readToken解析全组；不能接受UI给出的path或不完整track数组。 */
  resolveOriginalGroup(binding:Readonly<LocalLyricsWriteBinding>,intent:Readonly<LocalLyricsSaveIntent>,signal:AbortSignal):Promise<LyricsResolvedOriginalGroup>;
  assertAccepting():void;
}
interface LyricsHeldFile {handle:FileHandle;root:RootCapability;relative:string;info:BigIntStats;sha256:string|null;source:boolean}
interface LyricsPublicationState {
  publication:LocalLyricsHeldPublication;binding:LocalLyricsPhysicalBinding;intent:LocalLyricsSaveIntent;selected:LocalLyricsSelectedBody;
  resolved:LyricsResolvedOriginalGroup;record:LocalLyricsPhysicalRecord;grantRevision:number;grant:SourceWritesLyricsGrant;
  physical:PhysicalWriteClaims;namespace:LocalLyricsHeldPublication['namespace'];files:LyricsHeldFile[];source:LyricsHeldFile;
  stage:LyricsHeldFile|null;backup:LyricsHeldFile|null;targetRelative:string;stageRelative:string;backupRelative:string;quarantineRelative:string;
  privateRoot:RootCapability;reservation:{id:string;directory:string;release():void};policyRevision:string;attributes:SourceFileAttributes;baseline:LyricsNativeBaseline|null;signal:AbortSignal;controller:AbortController;
  task:Promise<LocalLyricsProtectedWriteResult>|null;finished:boolean;unknown:boolean;moved:boolean;
}
const lyricsPublications=new WeakMap<object,LyricsPublicationState>();
const lyricsPhysicalResource=(s:BigIntStats)=>({dev:String(s.dev),ino:String(s.ino)});
const sameLyricsAttributes=(a:SourceFileAttributes,b:SourceFileAttributes):boolean=>a.mode===b.mode&&a.uid===b.uid&&a.gid===b.gid&&a.proof===b.proof
  &&(a.proof!=='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'||b.proof==='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'&&a.provenance.sha256===b.provenance.sha256&&a.provenance.bytes===b.provenance.bytes);
function lyricsSameBinding(original:LocalLyricsWriteBinding,next:LocalLyricsWriteBinding):boolean {
  const keys=['datasetId','commandId','sessionId','intentFingerprint','libraryId','albumId','captureId','trackId','candidateId','bodySha256','kind','rootRevision','fileRevision','locationRevision','metadataRevision'] as const;
  return keys.every(k=>original[k]===next[k]);
}
function lyricsRelativeNames(relative:string,operationId:string,kind:'lrc'|'embed') {
  const directory=path.posix.dirname(relative),base=path.posix.basename(relative),dot=base.lastIndexOf('.');
  if(dot<1)throw new LocalLyricsError('CONFLICT');const join=(name:string)=>directory==='.'?name:directory+'/'+name;
  return {target:kind==='embed'?relative:join(base.slice(0,dot)+'.lrc'),stage:join(`.mb-lyrics-${operationId}.stage`),backup:join(`.mb-lyrics-${operationId}.backup`),quarantine:join(`.mb-lyrics-${operationId}.original`)};
}
async function lyricsFdHash(handle:FileHandle,maximum:number,signal:AbortSignal):Promise<{sha256:string;bytes:number}> {
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size<0n||before.size>BigInt(maximum))throw new LocalLyricsError('BUDGET');
  const h=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);let at=0;
  while(at<Number(before.size)){if(signal.aborted)throw new LocalLyricsError('CLOSED');const n=await handle.read(chunk,0,Math.min(chunk.length,Number(before.size)-at),at);if(!n.bytesRead)throw new LocalLyricsError('CONFLICT');h.update(chunk.subarray(0,n.bytesRead));at+=n.bytesRead;}
  const after=await handle.stat({bigint:true});if(signature(after)!==signature(before)||after.birthtimeNs!==before.birthtimeNs)throw new LocalLyricsError('STALE');return {sha256:h.digest('hex'),bytes:at};
}
async function lyricsCopyFd(source:FileHandle,target:FileHandle,expected:LocalLyricsPhysicalResource,signal:AbortSignal):Promise<void> {
  if((await target.stat()).size!==0)throw new LocalLyricsError('CONFLICT');const chunk=Buffer.allocUnsafe(1024*1024);let at=0;
  while(at<expected.bytes){if(signal.aborted)throw new LocalLyricsError('CLOSED');const n=await source.read(chunk,0,Math.min(chunk.length,expected.bytes-at),at);if(!n.bytesRead)throw new LocalLyricsError('CONFLICT');let wrote=0;while(wrote<n.bytesRead){const w=await target.write(chunk,wrote,n.bytesRead-wrote,at+wrote);if(!w.bytesWritten)throw new LocalLyricsError('CONFLICT');wrote+=w.bytesWritten;}at+=n.bytesRead;}
  await target.sync();const actual=await lyricsFdHash(target,LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes,signal);if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw new LocalLyricsError('CONFLICT');
}
/** 原同连接ledger+实际Mainport+全group解析+实际EOF作者缺一不可。 */
export function createLyricsSourceFilesAuthor(options:LyricsSourceFilesAuthorOptions):LocalLyricsSourceFilesAuthor {
  const {identity,catalog,native}=options;
  if(!options.ownerEpoch||!['privateLyricsPhysicalRead','privateLyricsPhysicalCompareAndSwap','privateLyricsPhysicalCommitPublication'].every(k=>typeof (catalog as unknown as Record<string,unknown>)?.[k]==='function')
    ||typeof options.sourceSafety?.reserveLyrics!=='function'||typeof options.joinTaggedWriter!=='function'||typeof options.resolveOriginalGroup!=='function'||typeof options.assertAccepting!=='function')throw new LocalLyricsError('CLOSED');
  assertSourceWritesMainActor(options.mainActor);assertLyricsNativeFidelityPort(native);
  let closing=false;const held=new Map<string,Set<LyricsPublicationState>>(),preparing=new Set<string>();
  function policy(){return catalog.privateSourceWritesRead(v=>sourceWritesPolicy(v.projection,identity.datasetId));}
  function accepting(signal?:AbortSignal):void{identity.assertCurrent();options.assertAccepting();assertSourceWritesMainActor(options.mainActor);if(closing||signal?.aborted||!policy().enabled||policy().draining)throw new LocalLyricsError('CLOSED');}
  function saved(binding:LocalLyricsWriteBinding,intent:LocalLyricsSaveIntent,selected:LocalLyricsSelectedBody):void {
    accepting();const stored=catalog.privateLyricsRecord(identity.datasetId,'save',binding.commandId) as LocalLyricsSaveRecord|null;
    if(!stored)throw new LocalLyricsError('NOT_FOUND');assertLocalLyricsSaveRecord(stored);
    if(binding.datasetId!==identity.datasetId||binding.ownerEpoch!==options.ownerEpoch||lyricsCanonical(stored.intent)!==lyricsCanonical(intent)||binding.intentFingerprint!==intent.fingerprint
      ||!intent.selected.some(v=>lyricsCanonical(v)===lyricsCanonical(selected))||binding.trackId!==selected.track.trackId||binding.candidateId!==selected.candidateId||binding.bodySha256!==selected.sha256
      ||lyricsDigest(selected.body)!==selected.sha256||selected.track.wholeTrack||binding.kind==='embed'&&(!intent.request.embed||!['wav','flac'].includes(selected.track.format)))throw new LocalLyricsError('STALE');
  }
  function read(binding:LocalLyricsWriteBinding){
    identity.assertCurrent();const original=catalog.privateLyricsPhysicalRead(identity,localLyricsPhysicalOperationId(binding));
    if(!original)return null;const record=captureLocalLyricsPhysicalRecord(original.record);if(!Number.isSafeInteger(original.ledgerSequence)||original.ledgerSequence<1||!lyricsSameBinding(record.binding,binding))throw new LocalLyricsError('CONFLICT');return {record,ledgerSequence:original.ledgerSequence};
  }
  function write(state:LyricsPublicationState|{record:LocalLyricsPhysicalRecord},patch:Partial<LocalLyricsPhysicalRecord>,commit=false):void {
    identity.assertCurrent();if(commit&&'grant'in state)assertSourceWritesLyricsGrant(state.grant,options.mainActor,state.binding,state.grantRevision);
    const previous=state.record,next=captureLocalLyricsPhysicalRecord({...previous,...patch,revision:previous.revision+1});
    assertLocalLyricsPhysicalTransition(previous,next);const seq=commit?catalog.privateLyricsPhysicalCommitPublication(identity,next,previous.revision):catalog.privateLyricsPhysicalCompareAndSwap(identity,next,previous.revision);
    if(!Number.isSafeInteger(seq)||seq<1)throw new LocalLyricsError('CONFLICT');state.record=next;
  }
  async function artifact(file:LyricsHeldFile,signal:AbortSignal):Promise<LocalLyricsPhysicalArtifact>{
    const actual=await file.handle.stat({bigint:true}),observed=await lyricsFdHash(file.handle,LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes,signal);
    return {rootId:file.root.id,relative:file.relative,sha256:observed.sha256,bytes:observed.bytes,signature:signature(actual),birthtimeNs:String(actual.birthtimeNs),permissionMode:String(actual.mode&0o7777n),uid:String(actual.uid),gid:String(actual.gid),...lyricsPhysicalResource(actual)};
  }
  async function verify(state:LyricsPublicationState,intent?:LocalLyricsSaveIntent):Promise<void>{
    accepting(state.signal);if(policy().revision!==state.policyRevision)throw new LocalLyricsError('STALE');if(state.finished||state.unknown)throw new LocalLyricsError('CLOSED');
    assertSourceWritesLyricsGrant(state.grant,options.mainActor,state.binding,state.grantRevision);
    if(intent&&lyricsCanonical(intent)!==lyricsCanonical(state.intent))throw new LocalLyricsError('STALE');
    await state.resolved.assertCurrent();assertPhysicalWriteClaims(state.physical,[]);assertSourceNamespaceHeld(state.namespace.token,state.namespace.scope);
    for(const f of state.files.filter(v=>v.source)){
      const actual=await f.handle.stat({bigint:true});if(signature(actual)!==signature(f.info)||actual.birthtimeNs!==f.info.birthtimeNs||actual.nlink!==1n)throw new LocalLyricsError('STALE');
      const named=await checkedFile(f.root,f.relative);if(signature(named.info)!==signature(f.info)||named.info.birthtimeNs!==f.info.birthtimeNs)throw new LocalLyricsError('STALE');
    }
    for(const f of state.files.filter(v=>!v.source)){
      const actual=await f.handle.stat({bigint:true}),named=await lstat(path.join(f.root.path,f.relative),{bigint:true});
      if(actual.dev!==f.info.dev||actual.ino!==f.info.ino||actual.birthtimeNs!==f.info.birthtimeNs||named.dev!==actual.dev||named.ino!==actual.ino||named.birthtimeNs!==actual.birthtimeNs)throw new LocalLyricsError('STALE');
    }
    accepting(state.signal);
  }
  async function retainUnknown(state:LyricsPublicationState):Promise<void>{
    state.unknown=true;try{state.physical.retain();}catch{/* 原失权不重新构造。 */}try{retainSourceNamespaceWrite(state.namespace.token);}catch{/* 保留最早事实。 */}
    if(state.record.phase!=='UNKNOWN')try{write(state,{phase:'UNKNOWN',result:{state:'unknown',bodySha256:null},unresolved:true});}catch{/* 失败原件仍为冷恢复依据，不伪报closed。 */}
  }
  async function finish(state:LyricsPublicationState,result:LocalLyricsProtectedWriteResult):Promise<LocalLyricsProtectedWriteResult>{
    // 实际Nativejoin在FD quiet之前，claims与namespace跨事实COMMIT全程持有。
    try{
      await options.joinTaggedWriter(state.binding.commandId);await native.join(state.binding.commandId);
      if(state.record.phase==='FACTS_COMMITTED'){
        await closePhysicalWriteClaimDescriptors(state.physical);write(state,{phase:'QUIET',physicalClosed:true});
        await state.physical.release();await releaseSourceNamespaceWrite(state.namespace.token,[state.record.operationId]);
        write(state,{phase:'CLOSED',protectionReleased:true,unresolved:false,result});
      }else{
        const guard=new AbortController().signal;const artifacts={...state.record.artifacts,stage:state.stage?await artifact(state.stage,guard):null,backup:state.backup?await artifact(state.backup,guard):null};
        await closePhysicalWriteClaimDescriptors(state.physical);await state.physical.release();await releaseSourceNamespaceWrite(state.namespace.token,[state.record.operationId]);
        write(state,{artifacts,phase:'FAILED',physicalClosed:true,protectionReleased:true,unresolved:false,result:{state:'failed',bodySha256:result.bodySha256}});
      }
      state.reservation.release();state.finished=true;held.get(state.binding.commandId)?.delete(state);return result;
    }catch{await retainUnknown(state);throw new LocalLyricsError('CLOSED');}
  }
  async function prepare(binding:LocalLyricsWriteBinding,intent:LocalLyricsSaveIntent,selected:LocalLyricsSelectedBody,actor:SourceWritesMainActor,signal:AbortSignal,retry:boolean):Promise<LocalLyricsHeldPublication>{
    accepting(signal);if(actor!==options.mainActor)throw new LocalLyricsError('CLOSED');saved(binding,intent,selected);
    const policyRevision=policy().revision;const operationId=localLyricsPhysicalOperationId(binding);if(preparing.has(operationId)||[...held.values()].some(set=>[...set].some(s=>s.record.operationId===operationId)))throw new LocalLyricsError('IN_FLIGHT');
    const old=read(binding);if(old&&(!retry||old.record.phase!=='FAILED'||!old.record.physicalClosed||!old.record.protectionReleased||old.record.unresolved))throw new LocalLyricsError('IN_FLIGHT');
    if(retry&&!old)throw new LocalLyricsError('NOT_FOUND');preparing.add(operationId);
    const files:LyricsHeldFile[]=[];let physical:PhysicalWriteClaims|undefined,namespace:LocalLyricsHeldPublication['namespace']|undefined,state:LyricsPublicationState|undefined;
    let bare:{record:LocalLyricsPhysicalRecord}|undefined,reservation:Awaited<ReturnType<LyricsSourceSafetyPort['reserveLyrics']>>|undefined;
    try{
      const resolved=await options.resolveOriginalGroup(binding,intent,signal);await resolved.assertCurrent();const group=captureLocalLyricsPhysicalGroup(resolved.group);
      if(resolved.captureSha256!==intent.captureFingerprint||new Set(resolved.roots.map(v=>v.id)).size!==resolved.roots.length)throw new LocalLyricsError('STALE');
      const member=group.members.find(v=>v.trackId===binding.trackId);if(!member||['rootRevision','fileRevision','locationRevision','metadataRevision'].some(k=>member[k as keyof typeof member]!==binding[k as keyof typeof binding]))throw new LocalLyricsError('STALE');
      const resource=group.resources[member.resourceIndex]!,root=resolved.roots.find(v=>v.id===resource.rootId);if(!root)throw new LocalLyricsError('STALE');
      const targetCount=intent.selected.length*(intent.request.embed?2:1);if(targetCount>100)throw new LocalLyricsError('BUDGET');
      const directories=new Map<string,{root:RootCapability;relative:string;absolute:string;info:BigIntStats}>();
      for(const r of group.resources){accepting(signal);const capability=resolved.roots.find(v=>v.id===r.rootId);if(!capability)throw new LocalLyricsError('STALE');
        const named=await checkedFile(capability,r.relative);if(signature(named.info)!==r.signature||String(named.info.birthtimeNs)!==r.birthtimeNs||named.info.nlink!==1n||named.info.size!==BigInt(r.bytes))throw new LocalLyricsError('STALE');
        const handle=await open(named.absolute,constants.O_RDONLY|constants.O_NOFOLLOW),info=await handle.stat({bigint:true});files.push({handle,root:capability,relative:r.relative,info,sha256:r.sha256,source:true});
        if(signature(info)!==r.signature||info.nlink!==1n||String(info.birthtimeNs)!==r.birthtimeNs||String(info.dev)!==r.dev||String(info.ino)!==r.ino||String(info.uid)!==r.uid||String(info.gid)!==r.gid||String(info.mode&0o7777n)!==r.permissionMode)throw new LocalLyricsError('STALE');
        let cursor=capability.path;for(const part of ['',...r.relative.split('/').slice(0,-1)]){if(part)cursor=path.join(cursor,part);const info=await lstat(cursor,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink())throw new LocalLyricsError('STALE');directories.set(`${info.dev}:${info.ino}`,{root:capability,relative:path.relative(capability.path,cursor),absolute:cursor,info});}
      }
      // 预先按整个业务intent的最大保护副本/备份集合核物理界，不能逐轨split绕过2048。
      if(group.resources.length+directories.size+targetCount*3>2048)throw new LocalLyricsError('BUDGET');
      for(const d of directories.values()){const handle=await open(d.absolute,constants.O_RDONLY|constants.O_NOFOLLOW);files.push({handle,root:d.root,relative:d.relative,info:await handle.stat({bigint:true}),sha256:null,source:false});}
      let extraBytes=0;const safetyTargets:PublisherTarget[]=[];
      for(const choice of intent.selected){const m=group.members.find(v=>v.trackId===choice.track.trackId);if(!m)throw new LocalLyricsError('STALE');const r=group.resources[m.resourceIndex]!,cap=resolved.roots.find(v=>v.id===r.rootId)!;
        const names=lyricsRelativeNames(r.relative,localLyricsPhysicalOperationId({...binding,trackId:m.trackId,kind:'lrc'}),'lrc');
        safetyTargets.push({operationId:localLyricsPhysicalOperationId({...binding,trackId:m.trackId,kind:'lrc'}),root:cap,libraryRootPath:cap.path,relative:names.target,expected:null,attributes:null,change:null,replacementBytes:Buffer.from(choice.body,'utf8')});
        if(intent.request.embed){const observation=await observeLyricsSourceFormat(files[m.resourceIndex]!.handle,choice.track.format as 'wav'|'flac',signal);extraBytes+=observation.frames*observation.channels*4*2;
          safetyTargets.push({operationId:localLyricsPhysicalOperationId({...binding,trackId:m.trackId,kind:'embed'}),root:cap,libraryRootPath:cap.path,relative:r.relative,expected:{sha256:r.sha256,bytes:r.bytes,signature:r.signature,physical:{dev:r.dev,ino:r.ino},permissionMode:r.permissionMode,birthtimeNs:r.birthtimeNs},attributes:null,change:null,replacementBytes:null});}
      }
      if(!Number.isSafeInteger(extraBytes)||extraBytes>LOCAL_LYRICS_PHYSICAL_LIMITS.sourceGroupBytes)throw new LocalLyricsError('BUDGET');
      if(new Set(safetyTargets.map(t=>path.join(t.root.path,t.relative))).size!==safetyTargets.length)throw new LocalLyricsError('CONFLICT');
      reservation=await options.sourceSafety.reserveLyrics(safetyTargets,extraBytes);
      const privateRoot={...await authorizeSourceDirectory(reservation.directory),id:'lyrics-safety-'+identity.datasetId};
      const temp=lyricsNativeTemporaryRoot(native);if(temp!==reservation.directory&&!temp.startsWith(reservation.directory+path.sep))throw new LocalLyricsError('CLOSED');
      const privateHandle=await open(privateRoot.path,constants.O_RDONLY|constants.O_NOFOLLOW);files.push({handle:privateHandle,root:privateRoot,relative:'',info:await privateHandle.stat({bigint:true}),sha256:null,source:false});
      const allNames:SourceNamespaceOperation[]=[];for(const r of group.resources){const capability=resolved.roots.find(v=>v.id===r.rootId)!;allNames.push({operationId,name:await captureSourceNamespace(capability,r.relative)});}
      for(const selectedMember of intent.selected){const m=group.members.find(v=>v.trackId===selectedMember.track.trackId);if(!m)throw new LocalLyricsError('STALE');const r=group.resources[m.resourceIndex]!,capability=resolved.roots.find(v=>v.id===r.rootId)!;
        for(const kind of intent.request.embed?(['lrc','embed'] as const):(['lrc'] as const)){const names=lyricsRelativeNames(r.relative,localLyricsPhysicalOperationId({...binding,trackId:m.trackId,kind}),kind);allNames.push({operationId,name:await captureSourceNamespace(capability,names.target)});const privateOperation=localLyricsPhysicalOperationId({...binding,trackId:m.trackId,kind});for(const suffix of ['stage','backup','original'])allNames.push({operationId,name:await captureSourceNamespace(privateRoot,privateOperation+'.'+suffix)});}}
      const completeNames=[...new Map(allNames.map(v=>[v.operationId+'\0'+v.name.absolute,v])).values()];if(completeNames.length>2048)throw new LocalLyricsError('BUDGET');
      const protectionSha256=lyricsPhysicalDigest(group),wire=captureLocalLyricsPhysicalBinding(old?{...old.record.binding,ownerEpoch:binding.ownerEpoch}:{...binding,originalIntentSha256:lyricsPhysicalDigest(intent),originalRequestSha256:lyricsPhysicalDigest(intent.request),groupCaptureSha256:resolved.captureSha256,protectionSha256,memberCount:group.members.length,resourceCount:group.resources.length,targetCount});
      if(old){
        if(lyricsPhysicalDigest(old.record.original.members)!==lyricsPhysicalDigest(group.members)||old.record.original.resources.length!==group.resources.length)throw new LocalLyricsError('STALE');
        for(const [index,current] of group.resources.entries()){const previous=old.record.original.resources[index]!;if(lyricsPhysicalDigest(previous)===lyricsPhysicalDigest(current))continue;
          if(previous.rootId!==current.rootId||previous.relative!==current.relative)throw new LocalLyricsError('STALE');
          const proved=intent.selected.some(item=>{const m=group.members.find(v=>v.trackId===item.track.trackId);if(m?.resourceIndex!==index)return false;
            const candidate=catalog.privateLyricsPhysicalRead(identity,localLyricsPhysicalOperationId({...binding,trackId:item.track.trackId,kind:'embed'}));if(!candidate)return false;const record=captureLocalLyricsPhysicalRecord(candidate.record),after=record.artifacts.target;
            return record.phase==='CLOSED'&&record.binding.commandId===binding.commandId&&record.binding.originalIntentSha256===wire.originalIntentSha256&&record.binding.groupCaptureSha256===wire.groupCaptureSha256
              &&record.result?.state==='saved'&&record.fidelity?.sourceSha256===previous.sha256&&!!after&&lyricsPhysicalDigest(after)===lyricsPhysicalDigest(current);});
          if(!proved)throw new LocalLyricsError('STALE');
        }
      }
      const record=old?.record??captureLocalLyricsPhysicalRecord({schema:1,operationId,binding:wire,original:group,revision:1,currentOwnerEpoch:options.ownerEpoch,phase:'PREPARED',grant:null,artifacts:{stage:null,backup:null,quarantine:null,target:null},fidelity:null,result:null,physicalClosed:false,protectionReleased:false,unresolved:false});
      bare={record};if(!old){assertLocalLyricsPhysicalTransition(null,record);const seq=catalog.privateLyricsPhysicalCompareAndSwap(identity,record,null);if(!Number.isSafeInteger(seq)||seq<1)throw new LocalLyricsError('CONFLICT');}
      const grantRevision=record.revision,grant=await requestSourceWritesLyricsGrant(actor,wire,grantRevision,signal),fact=assertSourceWritesLyricsGrant(grant,actor,wire,grantRevision);
      write(bare,{phase:'GRANTED',currentOwnerEpoch:options.ownerEpoch,grant:fact,physicalClosed:false,protectionReleased:false,unresolved:false,result:null});
      const derived=lyricsRelativeNames(resource.relative,operationId,binding.kind),names={target:derived.target,stage:operationId+'.stage',backup:operationId+'.backup',quarantine:operationId+'.original'},origin={datasetId:identity.datasetId,originPlanId:binding.commandId,planHash:wire.originalIntentSha256,contextFingerprint:wire.groupCaptureSha256,journalSequence:String(bare.record.revision),projectionFingerprint:wire.protectionSha256};
      const scope:SourceNamespaceHeldScope={datasetId:identity.datasetId,planId:binding.commandId,originBinding:origin,operations:completeNames};namespace={token:await acquireSourceNamespaceWrite({...origin,operations:completeNames}),scope,recovery:false};
      const acquireFile=async(relative:string,copy:boolean):Promise<LyricsHeldFile>=>{
        const absolute=path.join(privateRoot.path,relative);let handle:FileHandle;
        if(retry){const prior=old!.record.artifacts[relative===names.stage?'stage':'backup'];if(!prior){
          // 明确拒绝可发生在创建副本之前；真实缺失probe之后仍以EXCL创建，既有文件不被截断。
          try{await lstat(absolute);throw new LocalLyricsError('CONFLICT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          handle=await open(absolute,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_RDWR,0o600);
        }else{const named=await checkedFile(privateRoot,relative);if(signature(named.info)!==prior.signature||String(named.info.birthtimeNs)!==prior.birthtimeNs)throw new LocalLyricsError('STALE');handle=await open(absolute,constants.O_RDWR|constants.O_NOFOLLOW);const current=await lyricsFdHash(handle,LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes,signal);if(current.sha256!==prior.sha256||current.bytes!==prior.bytes){await handle.close();throw new LocalLyricsError('STALE');}if(copy)await handle.truncate(0);}}
        else handle=await open(absolute,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_RDWR,0o600);
        const file={handle,root:privateRoot,relative,info:await handle.stat({bigint:true}),sha256:null,source:false};files.push(file);return file;
      };
      const source=files[member.resourceIndex]!,attributes=await observeLyricsSourceAttributes(path.join(root.path,resource.relative),source.handle);
      let stage:LyricsHeldFile|null=null,backup:LyricsHeldFile|null=null;
      if(binding.kind==='embed'){
        stage=await acquireFile(names.stage,true);backup=await acquireFile(names.backup,false);
        await stage.handle.chmod(Number(attributes.mode));await stage.handle.chown(Number(attributes.uid),Number(attributes.gid));
      }else stage=await acquireFile(names.stage,true);
      // 现存同stem LRC只读入完整claims；绝不O_TRUNC或覆盖。
      if(binding.kind==='lrc')try{const named=await checkedFile(root,names.target),handle=await open(named.absolute,constants.O_RDONLY|constants.O_NOFOLLOW);files.push({handle,root,relative:names.target,info:await handle.stat({bigint:true}),sha256:null,source:false});}catch(error){if(!(error instanceof SourceFileError&&error.code==='MISSING')&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      physical=await acquirePhysicalWriteClaims(files.map(f=>lyricsPhysicalResource(f.info)));registerPhysicalWriteClaimDescriptors(physical,files.map(f=>f.handle));
      for(const [index,r] of group.resources.entries()){const actual=await lyricsFdHash(files[index]!.handle,LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes,signal);if(actual.sha256!==r.sha256||actual.bytes!==r.bytes)throw new LocalLyricsError('STALE');}
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      const publication=Object.freeze({grant,physical,namespace,copy:binding.kind==='embed'?{fd:stage!.handle.fd,commandId:binding.commandId,claimId:operationId,assertCurrent:async()=>{await verify(state!);const now=await stage!.handle.stat({bigint:true});if(now.dev!==stage!.info.dev||now.ino!==stage!.info.ino||now.nlink!==1n)throw new LocalLyricsError('STALE');}}:null});
      state={policyRevision,privateRoot,reservation,publication,binding:wire,intent,selected,resolved,record:bare.record,grantRevision,grant,physical,namespace,files,source,stage,backup,targetRelative:names.target,stageRelative:names.stage,backupRelative:names.backup,quarantineRelative:names.quarantine,attributes,baseline:null,signal:combined,controller,task:null,finished:false,unknown:false,moved:false};
      lyricsPublications.set(publication,state);const set=held.get(binding.commandId)??new Set<LyricsPublicationState>();set.add(state);held.set(binding.commandId,set);
      await verify(state);
      if(binding.kind==='embed'){
        if((await backup!.handle.stat()).size===0)await lyricsCopyFd(source.handle,backup!.handle,resource,combined);
        else if((await lyricsFdHash(backup!.handle,LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes,combined)).sha256!==resource.sha256)throw new LocalLyricsError('STALE');
        await lyricsCopyFd(source.handle,stage!.handle,resource,combined);
        if(!sameLyricsAttributes(attributes,await observeLyricsSourceAttributes(path.join(privateRoot.path,names.stage),stage!.handle)))throw new LocalLyricsError('CONFLICT');
        state.baseline=await native.captureOriginal(source.handle,selected.track.format as 'wav'|'flac',{commandId:binding.commandId,claimId:operationId,assertCurrent:()=>verify(state!)},combined,path.join(root.path,resource.relative));
      }
      write(state,{phase:'STAGED',artifacts:{stage:await artifact(stage!,combined),backup:backup?await artifact(backup,combined):null,quarantine:null,target:null}});await verify(state);return publication;
    }catch(error){
      if(state){if(state.moved)await retainUnknown(state);else try{await finish(state,{state:'failed',bodySha256:null});}catch{/* 未收口仍unknown。 */}}
      else {
        const joined=await native.join(binding.commandId).then(()=>true,()=>false),closed=await Promise.allSettled(files.map(f=>f.handle.close()));
        if(joined&&closed.every(v=>v.status==='fulfilled')){try{reservation?.release();if(physical)await physical.release();if(namespace)await releaseSourceNamespaceWrite(namespace.token,[operationId]);if(bare&&['PREPARED','GRANTED'].includes(bare.record.phase))write(bare,{phase:error instanceof SourceWritesLyricsGrantError&&error.code==='UNKNOWN'?'UNKNOWN':'FAILED',physicalClosed:true,protectionReleased:true,result:{state:error instanceof SourceWritesLyricsGrantError&&error.code==='UNKNOWN'?'unknown':'failed',bodySha256:null},unresolved:error instanceof SourceWritesLyricsGrantError&&error.code==='UNKNOWN'});}catch{/* 最后原状态保持未知，不能冒closed。 */}}
        else {physical?.retain();if(namespace)retainSourceNamespaceWrite(namespace.token);if(bare)try{write(bare,{phase:'UNKNOWN',result:{state:'unknown',bodySha256:null},unresolved:true});}catch{/* 原记录保留。 */}}
      }
      throw error;
    }finally{preparing.delete(operationId);}
  }
  function own(publication:LocalLyricsHeldPublication):LyricsPublicationState{const state=lyricsPublications.get(publication);if(!state||!held.get(state.binding.commandId)?.has(state))throw new LocalLyricsError('CLOSED');return state;}
  async function publish(state:LyricsPublicationState,body:Uint8Array|null,bodySha256:string):Promise<LocalLyricsProtectedWriteResult>{
    try{
      await verify(state);if(bodySha256!==state.binding.bodySha256||state.record.phase!=='STAGED')throw new LocalLyricsError('STALE');
      const sourceRoot=state.source.root,rootPath=sourceRoot.path,privatePath=state.privateRoot.path,target=path.join(rootPath,state.targetRelative),stage=state.stage!;
      if(state.binding.kind==='lrc'){
        if(!body||body.length<1||body.length>LOCAL_LYRICS_PHYSICAL_LIMITS.bodyBytes||createHash('sha256').update(body).digest('hex')!==bodySha256)throw new LocalLyricsError('CONFLICT');
        const exists=state.files.find(f=>!f.source&&f.relative===state.targetRelative);
        if(exists){const actual=await lyricsFdHash(exists.handle,LOCAL_LYRICS_PHYSICAL_LIMITS.bodyBytes,state.signal);
          if(actual.sha256!==bodySha256)return await finish(state,{state:'failed',bodySha256:actual.sha256});
          write(state,{phase:'PUBLISH_INTENT'});write(state,{phase:'PUBLISHED',artifacts:{...state.record.artifacts,target:await artifact(exists,state.signal)}});
          write(state,{phase:'FACTS_COMMITTED',result:{state:'existing',bodySha256}},true);return await finish(state,{state:'existing',bodySha256});
        }
        let at=0;while(at<body.length){const n=await stage.handle.write(body,at,body.length-at,at);if(!n.bytesWritten)throw new LocalLyricsError('CONFLICT');at+=n.bytesWritten;}await stage.handle.sync();
        const proof=await artifact(stage,state.signal);if(proof.sha256!==bodySha256)throw new LocalLyricsError('CONFLICT');
        write(state,{phase:'PUBLISH_INTENT',artifacts:{...state.record.artifacts,stage:proof}});await verify(state);
        try{await lyricsLink(path.join(privatePath,state.stageRelative),target);state.moved=true;}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return await finish(state,{state:'failed',bodySha256:null});throw error;}
      }else{
        if(!state.baseline)throw new LocalLyricsError('CLOSED');await native.join(state.binding.commandId);
        const fidelity=await native.verifyCopy(state.baseline,stage.handle,state.selected.track.format as 'wav'|'flac',state.selected.body,{commandId:state.binding.commandId,claimId:state.record.operationId,assertCurrent:()=>verify(state)},state.signal,path.join(privatePath,state.stageRelative));
        if(!sameLyricsAttributes(state.attributes,await observeLyricsSourceAttributes(path.join(privatePath,state.stageRelative),stage.handle)))throw new LocalLyricsError('CONFLICT');
        await stage.handle.sync();const proof=await artifact(stage,state.signal);if(fidelity.copySha256!==proof.sha256||fidelity.sourceSha256!==state.source.sha256)throw new LocalLyricsError('CONFLICT');
        write(state,{phase:'PUBLISH_INTENT',fidelity,artifacts:{...state.record.artifacts,stage:proof}});await verify(state);
        // 原source只读FD与原inode保留在quarantine；实际保护副本独占发布到空出的原命名位。
        try{await lstat(path.join(privatePath,state.quarantineRelative));throw new LocalLyricsError('CONFLICT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        await lyricsRename(target,path.join(privatePath,state.quarantineRelative));state.moved=true;
        const moved=await lstat(path.join(privatePath,state.quarantineRelative),{bigint:true});if(moved.dev!==state.source.info.dev||moved.ino!==state.source.info.ino||moved.birthtimeNs!==state.source.info.birthtimeNs)throw new LocalLyricsError('CONFLICT');
        await lyricsLink(path.join(privatePath,state.stageRelative),target);
      }
      const stagedFact=state.record.artifacts.stage!;
      await lyricsUnlink(path.join(privatePath,state.stageRelative));
      const parentRelative=path.posix.dirname(state.targetRelative)==='.'?'':path.posix.dirname(state.targetRelative);
      const parent=state.files.find(f=>f.root.id===sourceRoot.id&&f.relative===parentRelative&&f.info.isDirectory()),privateDirectory=state.files.find(f=>f.root.id===state.privateRoot.id&&f.relative==='');
      if(!parent||!privateDirectory)throw new LocalLyricsError('CLOSED');await parent.handle.sync();await privateDirectory.handle.sync();
      // link后stage与target是同一inode；不允许外部writer。先核whole，再commit同Owner事实。
      const published=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{
        const proof=await lyricsFdHash(published,LOCAL_LYRICS_PHYSICAL_LIMITS.sourceBytes,state.signal),now=await published.stat({bigint:true}),staged=await stage.handle.stat({bigint:true});
        if(now.dev!==staged.dev||now.ino!==staged.ino||proof.sha256!==stagedFact.sha256)throw new LocalLyricsError('CONFLICT');
        const targetFact={...stagedFact,rootId:state.source.root.id,relative:state.targetRelative,signature:signature(now),birthtimeNs:String(now.birthtimeNs)};
        let quarantine:LocalLyricsPhysicalArtifact|null=null;if(state.binding.kind==='embed'){const h=await open(path.join(privatePath,state.quarantineRelative),constants.O_RDONLY|constants.O_NOFOLLOW);try{quarantine=await artifact({...state.source,root:state.privateRoot,handle:h,relative:state.quarantineRelative},state.signal);}finally{await h.close();}}
        write(state,{phase:'PUBLISHED',artifacts:{...state.record.artifacts,stage:null,target:targetFact,quarantine}});
        write(state,{phase:'FACTS_COMMITTED',result:{state:'saved',bodySha256}},true);
      }finally{await published.close();}
      return await finish(state,{state:'saved',bodySha256});
    }catch(error){
      if(state.moved||['PUBLISHED','FACTS_COMMITTED','QUIET'].includes(state.record.phase)){await retainUnknown(state);return {state:'unknown',bodySha256:null};}
      await finish(state,{state:'failed',bodySha256:null});throw error;
    }
  }
  function launch(publication:LocalLyricsHeldPublication,body:Uint8Array|null,sha256:string,signal:AbortSignal){const state=own(publication);if(signal.aborted||state.task)throw new LocalLyricsError('IN_FLIGHT');const abort=()=>state.controller.abort();signal.addEventListener('abort',abort,{once:true});state.task=publish(state,body,sha256);void state.task.finally(()=>signal.removeEventListener('abort',abort)).catch(()=>{});return state.task;}
  return {
    prepare:(b,i,s,a,signal)=>prepare(b,i,s,a,signal,false),prepareFailedRetry:(b,i,s,a,signal)=>prepare(b,i,s,a,signal,true),
    async assertGranted(pub,b,i){const state=own(pub);if(!lyricsSameBinding(state.binding,b)||b.ownerEpoch!==options.ownerEpoch)throw new LocalLyricsError('STALE');await verify(state,i);},
    publishLrcExclusive:(pub,body,signal)=>launch(pub,body,createHash('sha256').update(body).digest('hex'),signal),
    publishTaggedCopy:(pub,sha256,signal)=>launch(pub,null,sha256,signal),
    async readOriginal(binding){const original=read(binding);if(!original)return null;return original.record.phase==='CLOSED'||original.record.phase==='FAILED'?original.record.result:{state:'unknown',bodySha256:null};},
    async join(commandId){const active=[...(held.get(commandId)??[])];await Promise.allSettled(active.flatMap(s=>s.task?[s.task]:[]));await options.joinTaggedWriter(commandId);await native.join(commandId);
      for(const state of active)if(!state.task&&!state.finished&&!state.unknown&&!state.moved)await finish(state,{state:'failed',bodySha256:null});
      if(active.some(s=>s.unknown||!s.finished))throw new LocalLyricsError('CLOSED');},
    async close(){closing=true;for(const set of held.values())for(const s of set)s.controller.abort();await Promise.allSettled([...held.values()].flatMap(set=>[...set].flatMap(s=>s.task?[s.task]:[])));for(const set of held.values())for(const state of [...set])if(!state.task&&!state.finished&&!state.unknown&&!state.moved)await finish(state,{state:'failed',bodySha256:null});
      await native.close();if([...held.values()].some(set=>set.size>0)||preparing.size)throw new LocalLyricsError('CLOSED');},
  };
}
