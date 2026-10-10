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
export async function withReadonlySourcePublicationClaims<T>(sources: readonly PublicationSource[], signal: AbortSignal, consume: (verify: () => Promise<void>, files: readonly PublicationFile[]) => Promise<T> | T): Promise<T> {
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
    } finally { await handle.close(); }
    check();
    // 恰好触及限额时保守标记截断，避免为判断“是否还有下一项”突破全局读取预算。
    const truncated = entries.length === remaining;
    const after = await lstat(current, { bigint: true });
    check();
    if (signature(before) !== signature(after) || !after.isDirectory() || await realpath(current) !== current || await sourceRootAvailability(root) !== 'ONLINE') return fail('CONTENT_CHANGED');
    return { entries, truncated };
  } catch (error) {
    if (error instanceof SourceFileError) throw error;
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
