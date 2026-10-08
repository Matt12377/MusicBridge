import { createHash } from 'node:crypto';
import { constants, fstatSync, lstatSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { MetadataReadInput } from '../library/metadata-reader-types.js';
import { MetadataLeaseReleaseError } from '../recording/source-files.js';
import type { MetadataSourceLeaseEvent, RootCapability } from '../recording/source-files.js';
import { assertPhysicalWriteClaims, physicalWriteClaimDescriptors } from '../stream/physical-resource-claims.js';
import type { PhysicalWriteClaims } from '../stream/physical-resource-claims.js';
import { assertSourceNamespaceHeld, captureSourceNamespace, retainSourceNamespaceWrite, SourceNamespaceCaptureError } from '../stream/source-namespace-claims.js';
import type { SourceNamespaceIdentity, SourceNamespaceHeldScope, SourceNamespaceWriteToken, SourceNamespaceRecoveryToken } from '../stream/source-namespace-claims.js';

export const RELOCATION_SINGLE_SOURCE_BYTES = 17_179_869_184;
export const RELOCATION_PLAN_SOURCE_BYTES = 68_719_476_736;
export const RELOCATION_HASH_CHUNK_BYTES = 1_048_576;
export const RELOCATION_RUNTIME_DEADLINE_MS = 1_800_000;
export class RelocationVerificationError extends Error {
  constructor(readonly issue: string) { super(`移动文件校验拒绝：${issue}。`); }
}
const fail = (issue: string): never => { throw new RelocationVerificationError(issue); };
export const relocationSignature = (s: BigIntStats): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
export interface RelocationFileObservation {
  readonly sha256: string;
  readonly bytes: number;
  readonly signature: string;
  readonly physical: Readonly<{ dev: string; ino: string }>;
  readonly birthtimeNs: string;
  readonly permissionMode: string;
  readonly uid: string;
  readonly gid: string;
  readonly links: string;
}
export interface RelocationIoOptions { signal?: AbortSignal; deadlineAt?: number; expectedLinks?: bigint }
export function checkRelocationIo(options: RelocationIoOptions): void {
  if (options.signal?.aborted) fail('CANCELLED');
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || Date.now() > options.deadlineAt)) fail('DEADLINE_EXCEEDED');
}
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return relocationSignature(a) === relocationSignature(b) && a.birthtimeNs === b.birthtimeNs
    && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
}
/** 只哈希完整原字节，不调用tag writer、不解析或正规化格式、标签与文件名。 */
export async function observeRelocationFile(handle: FileHandle, options: RelocationIoOptions = {}): Promise<RelocationFileObservation> {
  checkRelocationIo(options);
  const before = await handle.stat({ bigint: true }), expectedLinks = options.expectedLinks ?? 1n;
  if (!before.isFile() || before.nlink !== expectedLinks || before.size < 0n || before.size > BigInt(RELOCATION_SINGLE_SOURCE_BYTES)) return fail('SOURCE_UNQUALIFIED');
  const size = Number(before.size), buffer = Buffer.alloc(RELOCATION_HASH_CHUNK_BYTES), hash = createHash('sha256');
  let at = 0;
  while (at < size) {
    checkRelocationIo(options);
    const read = await handle.read(buffer, 0, Math.min(buffer.length, size - at), at);
    checkRelocationIo(options);
    if (!read.bytesRead) return fail('CONTENT_CHANGED');
    hash.update(buffer.subarray(0, read.bytesRead)); at += read.bytesRead;
  }
  const after = await handle.stat({ bigint: true }); checkRelocationIo(options);
  if (!sameStat(before, after)) return fail('CONTENT_CHANGED');
  return Object.freeze({ sha256: hash.digest('hex'), bytes: size, signature: relocationSignature(after),
    physical: Object.freeze({ dev: String(after.dev), ino: String(after.ino) }), birthtimeNs: String(after.birthtimeNs),
    permissionMode: String(after.mode & 0o7777n), uid: String(after.uid), gid: String(after.gid), links: String(after.nlink) });
}
export function assertSameRelocationBytes(source: RelocationFileObservation, target: RelocationFileObservation): void {
  if (source.bytes !== target.bytes || source.sha256 !== target.sha256) fail('FULL_VERIFY_FAILED');
}
interface DirectoryObservation { absolute: string; dev: string; ino: string; birthtimeNs: string; mode: string; uid: string; gid: string }
async function relocationNamespace(root: RootCapability, relative: string): Promise<SourceNamespaceIdentity> {
  try { return await captureSourceNamespace(root, relative); }
  catch (error) {
    if (!(error instanceof SourceNamespaceCaptureError)) throw error;
    if (error.code === 'SOURCE_ROOT_OFFLINE') {
      try { const info = await lstat(root.path, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== root.dev || String(info.ino) !== root.ino || await realpath(root.path) !== root.path) return fail('ROOT_CHANGED');
      } catch (statError) { if (statError instanceof RelocationVerificationError) throw statError; if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      return fail('ROOT_OFFLINE');
    }
    return fail(error.code === 'REVOKED' ? 'ROOT_REVOKED' : error.code === 'OUTSIDE_ROOT' ? 'OUT_OF_ROOT' : error.code === 'CONTENT_CHANGED' ? 'SOURCE_CHANGED' : 'IO_FAILED');
  }
}
export interface RelocationPathObservation {
  readonly root: Readonly<RootCapability>;
  readonly relative: string;
  readonly absolute: string;
  readonly parent: string;
  readonly namespace: SourceNamespaceIdentity;
  readonly ancestors: readonly Readonly<DirectoryObservation>[];
}
/** 目标可暂缺；根与全部祖先仍由原namespace作者及实际OS两次核验。 */
export async function captureRelocationPath(root: RootCapability, relative: string): Promise<RelocationPathObservation> {
  const namespace = await relocationNamespace(root, relative), ancestors: DirectoryObservation[] = [];
  let cursor = root.path;
  const directories = [root.path];
  for (const part of relative.split(path.sep).slice(0, -1)) { cursor = path.join(cursor, part); directories.push(cursor); }
  for (const absolute of directories) {
    const info = await lstat(absolute, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) return fail('ROOT_CHANGED');
    ancestors.push(Object.freeze({ absolute, dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs),
      mode: String(info.mode), uid: String(info.uid), gid: String(info.gid) }));
  }
  const observation = Object.freeze({ root: Object.freeze({ ...root }), relative, absolute: namespace.absolute,
    parent: path.dirname(namespace.absolute), namespace, ancestors: Object.freeze(ancestors) });
  await verifyRelocationPath(observation);
  return observation;
}
export async function verifyRelocationPath(value: RelocationPathObservation): Promise<void> {
  const named = await relocationNamespace(value.root, value.relative);
  if (named.absolute !== value.absolute || JSON.stringify(named.resources) !== JSON.stringify(value.namespace.resources)) return fail('ROOT_CHANGED');
  for (const prior of value.ancestors) {
    const info = await lstat(prior.absolute, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(prior.absolute) !== prior.absolute
        || String(info.dev) !== prior.dev || String(info.ino) !== prior.ino || String(info.birthtimeNs) !== prior.birthtimeNs
        || String(info.mode) !== prior.mode || String(info.uid) !== prior.uid || String(info.gid) !== prior.gid) return fail('ROOT_CHANGED');
  }
}

declare const relocationReadAccessBrand: unique symbol;
export interface RelocationReadAccess { readonly [relocationReadAccessBrand]: true }
export interface RelocationReadTarget {
  readonly operationId: string;
  readonly resourceId: string;
  readonly path: RelocationPathObservation;
  readonly handle: FileHandle;
  readonly observation: RelocationFileObservation;
}
interface ReadAuthority { targets: readonly RelocationReadTarget[]; claims: PhysicalWriteClaims; namespace: SourceNamespaceWriteToken | SourceNamespaceRecoveryToken;
  scope: SourceNamespaceHeldScope; active: boolean; reading: boolean; unverified: boolean; deadlineAt: number }
const reads = new WeakMap<object, ReadAuthority>();
function authority(access: unknown): ReadAuthority {
  const value = access && typeof access === 'object' ? reads.get(access) : undefined;
  if (!value || !value.active || value.unverified) return fail('READ_ACCESS_REQUIRED');
  assertPhysicalWriteClaims(value.claims, value.targets.map(target => target.observation.physical));
  assertSourceNamespaceHeld(value.namespace, value.scope);
  return value;
}
/** 仅Publisher私有调用；每个目标必须是该真实写claims已登记的FD，最终名nlink=1且完整bytes独立核验。 */
export async function createRelocationReadAccess(targets: readonly RelocationReadTarget[], claims: PhysicalWriteClaims,
  namespace: SourceNamespaceWriteToken | SourceNamespaceRecoveryToken, scope: SourceNamespaceHeldScope, signal: AbortSignal, deadlineAt: number): Promise<RelocationReadAccess> {
  if (!Array.isArray(targets) || !targets.length || targets.length > 256
      || new Set(targets.map(t => `${t.path.root.id}\0${t.path.relative}`)).size !== targets.length) return fail('READ_ACCESS_REQUIRED');
  assertPhysicalWriteClaims(claims, targets.map(t => t.observation.physical)); assertSourceNamespaceHeld(namespace, scope);
  const registered = physicalWriteClaimDescriptors(claims), captured: RelocationReadTarget[] = [];
  for (const target of targets) {
    if (!registered.includes(target.handle)) return fail('READ_ACCESS_REQUIRED');
    await verifyRelocationPath(target.path);
    const actual = await observeRelocationFile(target.handle, { signal, deadlineAt });
    if (JSON.stringify(actual) !== JSON.stringify(target.observation)) return fail('CONTENT_CHANGED');
    const named = await lstat(target.path.absolute, { bigint: true });
    if (named.isSymbolicLink() || relocationSignature(named) !== actual.signature || String(named.birthtimeNs) !== actual.birthtimeNs) return fail('CONTENT_CHANGED');
    captured.push(Object.freeze({ ...target }));
  }
  const access = Object.freeze({}) as unknown as RelocationReadAccess;
  reads.set(access, { targets: Object.freeze(captured), claims, namespace, scope, active: true, reading: false, unverified: false, deadlineAt });
  return access;
}
export function revokeRelocationReadAccess(access: RelocationReadAccess): void {
  const value = authority(access);
  if (value.reading) return fail('READER_NOT_QUIET');
  value.active = false;
}
/** 仅同Owner短事务使用；真实写claims、namespace及最终名字仍活着才返回已全Hash的私有目标。 */
export function relocationReadAccessTargets(access: RelocationReadAccess): readonly RelocationReadTarget[] {
  const value = authority(access);
  if (value.reading) return fail('READER_NOT_QUIET');
  checkRelocationIo({ deadlineAt: value.deadlineAt });
  const registered = physicalWriteClaimDescriptors(value.claims);
  for (const target of value.targets) {
    if (!registered.includes(target.handle) || target.handle.fd < 0) return fail('READ_ACCESS_REQUIRED');
    const opened = fstatSync(target.handle.fd, { bigint: true }), named = lstatSync(target.path.absolute, { bigint: true });
    if (!opened.isFile() || named.isSymbolicLink() || !sameStat(opened, named)
        || relocationSignature(opened) !== target.observation.signature || String(opened.birthtimeNs) !== target.observation.birthtimeNs
        || String(opened.nlink) !== target.observation.links || String(opened.mode & 0o7777n) !== target.observation.permissionMode
        || String(opened.uid) !== target.observation.uid || String(opened.gid) !== target.observation.gid) return fail('CONTENT_CHANGED');
    for (const prior of target.path.ancestors) {
      const current = lstatSync(prior.absolute, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(prior.absolute) !== prior.absolute
          || String(current.dev) !== prior.dev || String(current.ino) !== prior.ino || String(current.birthtimeNs) !== prior.birthtimeNs
          || String(current.mode) !== prior.mode || String(current.uid) !== prior.uid || String(current.gid) !== prior.gid) return fail('ROOT_CHANGED');
    }
  }
  return value.targets;
}
/** 实际原Reader通过此叶能力取得独立O_RDONLY句柄；消费承诺必须等原worker真实exit，不race释放。 */
export async function withRelocationMetadataRead<T>(access: RelocationReadAccess, input: MetadataReadInput, signal: AbortSignal,
  consume: (handle: FileHandle, size: number) => Promise<T>, onLeaseEvent?: (event: MetadataSourceLeaseEvent) => void): Promise<T> {
  const value = authority(access);
  if (value.reading) return fail('READER_BUSY');
  const target = value.targets.find(t => t.path.root.id === input.root.id && t.path.relative === input.relative);
  if (!target || input.root.authorized !== true || input.root.path !== target.path.root.path || input.root.dev !== target.path.root.dev
      || input.root.ino !== target.path.root.ino || input.expectedSignature !== target.observation.signature) return fail('READ_ACCESS_REQUIRED');
  const check = (): void => { input.assertCurrent?.(); checkRelocationIo({ signal, deadlineAt: value.deadlineAt }); authority(access); };
  let handle: FileHandle | undefined, fd = -1;
  const emit = (type: MetadataSourceLeaseEvent['type']): void => { try { onLeaseEvent?.({ type, fd }); } catch { /* 观察者不能取得关闭权。 */ } };
  value.reading = true;
  try {
    check(); await verifyRelocationPath(target.path);
    handle = await open(target.path.absolute, constants.O_RDONLY | constants.O_NOFOLLOW); fd = handle.fd;
    emit('lease-acquired');
    const verify = async (): Promise<void> => {
      authority(access); await verifyRelocationPath(target.path);
      const actual = await observeRelocationFile(handle!, { deadlineAt: value.deadlineAt });
      const named = await lstat(target.path.absolute, { bigint: true });
      if (JSON.stringify(actual) !== JSON.stringify(target.observation) || named.isSymbolicLink()
          || relocationSignature(named) !== actual.signature || String(named.birthtimeNs) !== actual.birthtimeNs) return fail('CONTENT_CHANGED');
    };
    await verify(); check();
    let result: T | undefined, caught = false, original: unknown;
    try { result = await consume(handle, target.observation.bytes); }
    catch (error) { caught = true; original = error; }
    await verify(); check();
    if (caught) throw original;
    return result as T;
  } finally {
    if (handle) {
      try { await handle.close(); if (handle.fd !== -1) throw new Error('独立FD未真实关闭。'); }
      catch { value.unverified = true; value.claims.retain(); retainSourceNamespaceWrite(value.namespace); throw new MetadataLeaseReleaseError(); }
      emit('lease-released');
    }
    value.reading = false;
  }
}
