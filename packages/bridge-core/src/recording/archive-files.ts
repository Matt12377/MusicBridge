import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink, statfs, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isCollectionId, isArchiveObjectDescriptor, type ArchiveObjectRole } from '@music-bridge/contracts';
import { authorizeSourceDirectory, sourceRootAvailability, copyReadonlySource, withVerifiedReadonlySource, probeReadonlySource, type RootCapability } from './source-files.js';

export class ArchiveFileError extends Error {
  constructor(readonly code: 'ARCHIVE_ROOT_INVALID' | 'ARCHIVE_RECOVERY_REQUIRED' | 'ARCHIVE_INPUT_INVALID' | 'ARCHIVE_DISK_FULL') { super(code); }
}
export interface OwnedArchive {
  id: string; parent: RootCapability; root: RootCapability; objects: RootCapability; operations: RootCapability; owner: string;
}
export interface ArchiveFileInput {
  role: ArchiveObjectRole; name: string; source: RootCapability; relative: string;
  sha256: string; size: number; media: 'audio' | 'json';
}
export interface ArchiveInlineInput {
  role: 'metadata' | 'manifest'; name: string; content: string;
  sha256: string; size: number; media: 'json';
}
export type ArchiveInput = ArchiveFileInput | ArchiveInlineInput;
export interface ArchiveRootInitialization { id: string; parent: RootCapability; owner: string }
export interface ArchiveLineage { masterVersionId: string; layoutVersionId: string; executionAssetId: string }
export interface OwnedArchiveOperation {
  id: string; archive: OwnedArchive; directory: RootCapability; staging: RootCapability;
  files: readonly ArchiveInput[]; lineage: ArchiveLineage; intent: string; manifest: string;
}
export type ArchiveFilePhase = 'INTENT_WRITTEN' | 'STAGED' | 'VERIFIED' | 'PROMOTED' | 'DB_COMMITTED' | 'FINALIZED';
export const archiveDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const fail = (code: ArchiveFileError['code'] = 'ARCHIVE_RECOVERY_REQUIRED'): never => { throw new ArchiveFileError(code); };
const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const hash = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
const relative = (value: string): boolean => !!value && !path.isAbsolute(value) && !value.includes('\0') && !value.includes('\\') && value.split('/').every(p => !!p && p !== '.' && p !== '..');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EEXIST';
async function available(root: RootCapability): Promise<void> { if (await sourceRootAvailability(root) !== 'ONLINE') fail('ARCHIVE_ROOT_INVALID'); }
async function sync(root: RootCapability): Promise<void> {
  await available(root); const handle = await open(root.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat({ bigint: true }); if (!info.isDirectory() || String(info.dev) !== root.dev || String(info.ino) !== root.ino) fail('ARCHIVE_ROOT_INVALID'); await handle.sync(); } finally { await handle.close(); }
}
async function readText(absolute: string, maximum = 4 * 1024 * 1024): Promise<string> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)) return fail();
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) return fail(); offset += bytesRead; }
    const after = await handle.stat({ bigint: true }), current = await lstat(absolute, { bigint: true });
    if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return fail();
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}
async function writeExclusive(directory: RootCapability, name: string, text: string, check: () => void = () => undefined): Promise<void> {
  check(); await available(directory); check(); const absolute = path.join(directory.path, name);
  const handle = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await available(directory); check(); await handle.writeFile(text); check(); await handle.sync(); } finally { await handle.close(); }
  check(); await sync(directory);
}
export async function previewArchiveRoot(absolute: string, protectedRoots: readonly RootCapability[]): Promise<RootCapability> {
  if (!path.isAbsolute(absolute) || absolute.includes('\0') || absolute.split(path.sep).some(p => p === '.' || p === '..') || await realpath(absolute) !== absolute || protectedRoots.some(r => inside(r.path, absolute) || inside(absolute, r.path))) return fail('ARCHIVE_INPUT_INVALID');
  return { ...await authorizeSourceDirectory(absolute), id: randomUUID() };
}
/** 只创建意图；调用方在写文件前把这份 owner nonce 与命令一起持久化。 */
export function planArchiveRootInitialization(parent: RootCapability, id: string): ArchiveRootInitialization {
  if (!isCollectionId(id) || !parent.authorized) return fail('ARCHIVE_INPUT_INVALID');
  return { id, parent: structuredClone(parent), owner: JSON.stringify({ schemaVersion: 1, archiveId: id, nonce: randomUUID() }) + '\n' };
}
export async function initializeArchiveRoot(parent: RootCapability, id: string, protectedRoots: readonly RootCapability[], confirmed: boolean): Promise<OwnedArchive> {
  return initializePlannedArchiveRoot(planArchiveRootInitialization(parent, id), protectedRoots, confirmed);
}
export async function initializePlannedArchiveRoot(plan: ArchiveRootInitialization, protectedRoots: readonly RootCapability[], confirmed: boolean, check: () => void = () => undefined): Promise<OwnedArchive> {
  check();
  const { id, parent, owner } = plan;
  if (confirmed !== true || !isCollectionId(id) || typeof owner !== 'string' || owner.length > 1024) return fail('ARCHIVE_INPUT_INVALID');
  const marker: unknown = JSON.parse(owner);
  if (!marker || typeof marker !== 'object' || !('nonce' in marker) || !isCollectionId(marker.nonce) || owner !== JSON.stringify({ schemaVersion: 1, archiveId: id, nonce: marker.nonce }) + '\n') return fail('ARCHIVE_INPUT_INVALID');
  await available(parent); await previewArchiveRoot(parent.path, protectedRoots); check();
  const absolute = path.join(parent.path, `MusicBridge-Archive-${id}`); let created = false;
  try { await mkdir(absolute, { mode: 0o700 }); created = true; } catch (error) { if (!exists(error)) throw error; }
  await available(parent); check(); const root = { ...await authorizeSourceDirectory(absolute), id };
  if (root.path !== absolute) return fail('ARCHIVE_ROOT_INVALID');
  if (created) await writeExclusive(root, '.musicbridge-owner.json', owner, check);
  else if (await readText(path.join(absolute, '.musicbridge-owner.json'), 1024) !== owner) return fail('ARCHIVE_ROOT_INVALID');
  const children: RootCapability[] = [];
  for (const name of ['Objects', 'Operations']) {
    await available(root); check(); const child = path.join(absolute, name);
    try { await mkdir(child, { mode: 0o700 }); } catch (error) { if (!exists(error)) throw error; }
    const capability = { ...await authorizeSourceDirectory(child), id };
    if (capability.path !== child) return fail('ARCHIVE_ROOT_INVALID'); children.push(capability);
  }
  const result: OwnedArchive = { id, parent, root, objects: children[0]!, operations: children[1]!, owner };
  check(); await sync(result.objects); check(); await sync(result.operations); check(); await sync(root); check(); await sync(parent); await checkArchiveRoot(result); check(); return result;
}
export async function checkArchiveRoot(archive: OwnedArchive): Promise<void> {
  if (!isCollectionId(archive.id) || archive.root.path !== path.join(archive.parent.path, `MusicBridge-Archive-${archive.id}`) || archive.objects.path !== path.join(archive.root.path, 'Objects') || archive.operations.path !== path.join(archive.root.path, 'Operations')) return fail('ARCHIVE_ROOT_INVALID');
  for (const root of [archive.parent, archive.root, archive.objects, archive.operations]) await available(root);
  if (await readText(path.join(archive.root.path, '.musicbridge-owner.json'), 1024) !== archive.owner) fail('ARCHIVE_ROOT_INVALID');
}
function validateInput(files: readonly ArchiveInput[], lineage: ArchiveLineage): void {
  if (!lineage || Object.keys(lineage).sort().join(',') !== 'executionAssetId,layoutVersionId,masterVersionId' || !Object.values(lineage).every(isCollectionId) || !Array.isArray(files) || files.length < 1 || files.length > 1000) return fail('ARCHIVE_INPUT_INVALID');
  const names = new Set<string>(), sizes = new Map<string, number>(); let total = 0;
  for (const f of files) {
    const descriptor = { role: f.role, name: f.name, media: f.media, sha256: f.sha256, size: f.size };
    if (!isArchiveObjectDescriptor(descriptor) || names.has(`${f.role}:${f.name}`) || sizes.has(f.sha256) && sizes.get(f.sha256) !== f.size) return fail('ARCHIVE_INPUT_INVALID');
    if ('content' in f) {
      if ('source' in f || 'relative' in f || f.media !== 'json' || !['metadata','manifest'].includes(f.role) || typeof f.content !== 'string' || Buffer.byteLength(f.content) !== f.size || archiveDigest(f.content) !== f.sha256) return fail('ARCHIVE_INPUT_INVALID');
    } else if (!relative(f.relative) || !f.source?.authorized) return fail('ARCHIVE_INPUT_INVALID');
    names.add(`${f.role}:${f.name}`); sizes.set(f.sha256, f.size); total += f.size;
  }
  if (!Number.isSafeInteger(total) || total > 1_099_511_627_776) fail('ARCHIVE_INPUT_INVALID');
}
export function archiveManifest(id: string, files: readonly ArchiveInput[], lineage: ArchiveLineage): string {
  validateInput(files, lineage); if (!isCollectionId(id)) return fail('ARCHIVE_INPUT_INVALID');
  return JSON.stringify({ schemaVersion: 1, operationId: id, lineage, files: files.map(({ role, name, sha256, size, media }) => ({ role, name, sha256, size, media })), formalRecording: false }, null, 2) + '\n';
}
export async function createArchiveOperation(archive: OwnedArchive, id: string, files: readonly ArchiveInput[], lineage: ArchiveLineage): Promise<OwnedArchiveOperation> {
  const manifest = archiveManifest(id, files, lineage); await checkArchiveRoot(archive);
  if (files.some(f => !('content' in f) && (inside(archive.root.path, f.source.path) || inside(f.source.path, archive.root.path)))) return fail('ARCHIVE_INPUT_INVALID');
  const intent = JSON.stringify({ schemaVersion: 1, operationId: id, archiveId: archive.id, files, lineage, manifestHash: archiveDigest(manifest) }) + '\n';
  if (Buffer.byteLength(intent) > 4 * 1024 * 1024) return fail('ARCHIVE_INPUT_INVALID');
  const absolute = path.join(archive.operations.path, id); let prior = false;
  try { await mkdir(absolute, { mode: 0o700 }); } catch (error) { if (!exists(error)) throw error; prior = true; }
  await checkArchiveRoot(archive);
  const directory = { ...await authorizeSourceDirectory(absolute), id };
  if (directory.path !== absolute) return fail();
  if (prior) {
    if (await readText(path.join(absolute, 'Intent.json')) !== intent || await readText(path.join(absolute, 'Manifest.json')) !== manifest) return fail();
  } else {
    await writeExclusive(directory, 'Intent.json', intent); await writeExclusive(directory, 'Manifest.json', manifest);
    await mkdir(path.join(absolute, 'Staging'), { mode: 0o700 }); await sync(directory); await sync(archive.operations);
  }
  const staging = { ...await authorizeSourceDirectory(path.join(absolute, 'Staging')), id };
  const operation = { id, archive, directory, staging, files: structuredClone(files), lineage: structuredClone(lineage), intent, manifest };
  await markArchivePhase(operation, 'INTENT_WRITTEN'); return operation;
}
async function checkOperation(op: OwnedArchiveOperation): Promise<void> {
  await checkArchiveRoot(op.archive);
  if (!isCollectionId(op.id) || op.directory.path !== path.join(op.archive.operations.path, op.id) || op.staging.path !== path.join(op.directory.path, 'Staging') || archiveManifest(op.id, op.files, op.lineage) !== op.manifest || JSON.stringify({ schemaVersion: 1, operationId: op.id, archiveId: op.archive.id, files: op.files, lineage: op.lineage, manifestHash: archiveDigest(op.manifest) }) + '\n' !== op.intent) return fail();
  await available(op.directory); await available(op.staging);
  if (await readText(path.join(op.directory.path, 'Intent.json')) !== op.intent || await readText(path.join(op.directory.path, 'Manifest.json')) !== op.manifest) return fail();
}
const phaseText = (op: OwnedArchiveOperation, phase: ArchiveFilePhase): string => JSON.stringify({ operationId: op.id, manifestHash: archiveDigest(op.manifest), phase }) + '\n';
export async function hasArchivePhase(op: OwnedArchiveOperation, phase: ArchiveFilePhase): Promise<boolean> {
  await checkOperation(op);
  try { if (await readText(path.join(op.directory.path, `${phase}.json`), 1024) !== phaseText(op, phase)) return fail(); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
export async function markArchivePhase(op: OwnedArchiveOperation, phase: ArchiveFilePhase): Promise<void> {
  await checkOperation(op);
  try { await writeExclusive(op.directory, `${phase}.json`, phaseText(op, phase)); } catch (error) { if (!exists(error) || !await hasArchivePhase(op, phase)) throw error; }
}
const unique = (op: OwnedArchiveOperation): ArchiveInput[] => [...new Map(op.files.map(f => [f.sha256, f])).values()];
export function archiveObjectPath(archive: OwnedArchive, sha256: string): string { if (!hash(sha256)) return fail('ARCHIVE_INPUT_INVALID'); return path.join(archive.objects.path, sha256); }
async function verifyFile(root: RootCapability, name: string, file: ArchiveInput, signal: AbortSignal): Promise<void> {
  await withVerifiedReadonlySource(root, name, file, signal, async () => undefined);
}
/** 恢复 link 成功但尚未解除临时别名的窗口；不触碰独立 inode 的失败半成品。 */
async function normalizeStageAliases(op: OwnedArchiveOperation, file: ArchiveInput, signal: AbortSignal): Promise<void> {
  const stable = await lstat(path.join(op.staging.path, file.sha256), { bigint: true });
  if (stable.nlink === 1n) return;
  for (const name of await readdir(op.staging.path)) {
    const prefix = `${file.sha256}.partial-`; if (!name.startsWith(prefix) || !isCollectionId(name.slice(prefix.length))) continue;
    signal.throwIfAborted(); await checkOperation(op); const absolute = path.join(op.staging.path, name), before = await lstat(absolute, { bigint: true });
    if (before.isSymbolicLink() || before.dev !== stable.dev || before.ino !== stable.ino) continue;
    await verifyFile(op.staging, name, file, signal);
    const current = await lstat(absolute, { bigint: true });
    if (current.ino !== before.ino || current.dev !== before.dev || current.ctimeNs !== before.ctimeNs) return fail();
    await unlink(absolute); await sync(op.staging);
  }
}
/** 失败的 .partial 文件不覆盖、不清理；只有完整校验的文件才取得稳定暂存名。 */
export async function stageArchiveOperation(op: OwnedArchiveOperation, signal: AbortSignal, hooks: { copy?: typeof copyReadonlySource; availableBytes?: () => Promise<bigint> } = {}): Promise<void> {
  signal.throwIfAborted(); await checkOperation(op);
  const space = hooks.availableBytes ? await hooks.availableBytes() : await statfs(op.archive.root.path, { bigint: true }).then(s => s.bavail * s.bsize);
  const pending: ArchiveInput[] = [];
  for (const f of unique(op)) {
    try { await lstat(path.join(op.staging.path, f.sha256)); await verifyFile(op.staging, f.sha256, f, signal); await normalizeStageAliases(op, f, signal); } catch (error) { if (!missing(error)) throw error; pending.push(f); }
  }
  if (space < pending.reduce((n, f) => n + BigInt(f.size), 4n * 1024n * 1024n)) return fail('ARCHIVE_DISK_FULL');
  for (const f of pending) {
    signal.throwIfAborted(); await checkOperation(op); const temporary = `${f.sha256}.partial-${randomUUID()}`, absolute = path.join(op.staging.path, temporary);
    const handle = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      if ('content' in f) { signal.throwIfAborted(); await handle.writeFile(f.content, 'utf8'); }
      else { await (hooks.copy ?? copyReadonlySource)(f.source, f.relative, f, handle, signal); await withVerifiedReadonlySource(f.source, f.relative, f, signal, async () => undefined); }
      await handle.sync();
      await verifyFile(op.staging, temporary, f, signal); await checkOperation(op);
      const current = await lstat(absolute, { bigint: true }), opened = await handle.stat({ bigint: true });
      if (current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1n) return fail();
      await link(absolute, path.join(op.staging.path, f.sha256)); await sync(op.staging); await unlink(absolute); await sync(op.staging);
    } finally { await handle.close(); }
  }
  await markArchivePhase(op, 'STAGED');
}
export async function verifyArchiveStaging(op: OwnedArchiveOperation, signal: AbortSignal): Promise<void> {
  if (!await hasArchivePhase(op, 'STAGED')) return fail();
  // 不同角色即使 Hash 相同，也各自满足声明的解析类型。
  for (const f of op.files) {
    signal.throwIfAborted(); await verifyFile(op.staging, f.sha256, f, signal);
    if (f.media === 'audio') { const evidence = await probeReadonlySource(op.staging, f.sha256, signal); if (evidence.sha256 !== f.sha256 || evidence.size !== f.size) return fail(); }
    else { const content: unknown = JSON.parse(await readText(path.join(op.staging.path, f.sha256))); if (!content || typeof content !== 'object') return fail(); }
  }
  await markArchivePhase(op, 'VERIFIED');
}
export async function verifyArchiveObjects(op: OwnedArchiveOperation, signal: AbortSignal): Promise<void> {
  await checkOperation(op);
  for (const f of unique(op)) {
    signal.throwIfAborted(); const absolute = archiveObjectPath(op.archive, f.sha256), object = await lstat(absolute, { bigint: true });
    if (!object.isFile() || object.isSymbolicLink() || object.nlink < 1n || object.nlink > 2n) return fail();
    if (object.nlink === 2n) { const stage = await lstat(path.join(op.staging.path, f.sha256), { bigint: true }); if (stage.ino !== object.ino || stage.dev !== object.dev) return fail(); }
    await verifyFile(op.archive.objects, f.sha256, f, signal);
  }
}
/** link 是同卷原子 no-replace 发布；不使用会覆盖旧对象的 rename。 */
export async function promoteArchiveOperation(op: OwnedArchiveOperation, signal: AbortSignal): Promise<void> {
  if (!await hasArchivePhase(op, 'VERIFIED')) return fail();
  for (const f of unique(op)) {
    signal.throwIfAborted(); await checkOperation(op); await verifyFile(op.staging, f.sha256, f, signal);
    try { await link(path.join(op.staging.path, f.sha256), archiveObjectPath(op.archive, f.sha256)); } catch (error) { if (!exists(error)) throw error; }
    await sync(op.archive.objects);
  }
  await verifyArchiveObjects(op, signal); await markArchivePhase(op, 'PROMOTED');
}
/** 调用方必须已提交数据库。只移除本意图中、且对象库已有完整副本的稳定暂存名。 */
export async function finalizeArchiveOperation(op: OwnedArchiveOperation, signal: AbortSignal): Promise<void> {
  if (!await hasArchivePhase(op, 'PROMOTED') || !await hasArchivePhase(op, 'DB_COMMITTED')) return fail(); await verifyArchiveObjects(op, signal);
  for (const f of unique(op)) {
    signal.throwIfAborted(); await checkOperation(op); const absolute = path.join(op.staging.path, f.sha256);
    let before; try { before = await lstat(absolute, { bigint: true }); } catch (error) { if (missing(error)) continue; throw error; }
    await verifyFile(op.staging, f.sha256, f, signal); await verifyFile(op.archive.objects, f.sha256, f, signal);
    const current = await lstat(absolute, { bigint: true });
    if (current.ino !== before.ino || current.dev !== before.dev || current.ctimeNs !== before.ctimeNs || current.isSymbolicLink()) return fail();
    await unlink(absolute); await sync(op.staging);
  }
  await markArchivePhase(op, 'FINALIZED');
}
