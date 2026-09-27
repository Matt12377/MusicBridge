import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { isCollectionId } from '@music-bridge/contracts';
import { checkPreparationOwnership, verifyPublishedPreparation, type PreparationOutput } from './preparation-files.js';
import type { StoredPreparationJob } from './preparation-store.js';
import { sourceRootAvailability, type RootCapability } from './source-files.js';
import { verifyVerifiedZip, writeVerifiedZip, type ZipBudget, type ZipEntryDescription, type ZipEntrySource, type ZipReceipt } from './verified-zip.js';
import type { PreparationZipTargetBinding, StoredPreparationZipJob, ZipFileIdentity } from './preparation-export-store.js';

export class PreparationZipFileError extends Error {
  constructor(readonly code: 'WORKSPACE_INVALID' | 'TARGET_INVALID' | 'CONTENT_CHANGED' | 'RECOVERY_REQUIRED') { super(code); }
}
const fail = (code: PreparationZipFileError['code']): never => { throw new PreparationZipFileError(code); };
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const safeName = (name: string): boolean => !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(name) && Buffer.byteLength(name) <= 255 && name.toLowerCase().endsWith('.zip');
const identity = (stat: { dev: bigint; ino: bigint }): ZipFileIdentity => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a: ZipFileIdentity, b: ZipFileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const expectedFile = (relative: string): boolean => /^(?:Sources\/[0-9]{3}\.(?:wav|aiff|flac)|Tracklist\.tsv|SourceLineage\.json|README\.txt)$/u.test(relative);

export function preparationZipTempPath(target: PreparationZipTargetBinding, id: string): string {
  if (!isCollectionId(id) || !safeName(path.basename(target.absolute)) || target.absolute !== path.join(target.parent.path, path.basename(target.absolute))) return fail('TARGET_INVALID');
  return path.join(target.parent.path, `.musicbridge-preparation-zip-${id}.partial`);
}
/** 父目录的 dev/ino 和整条 realpath 链在预览、写入和发布前重新核对。 */
export async function checkPreparationZipTarget(target: PreparationZipTargetBinding, workspaceRoot: string, requireLive = true): Promise<void> {
  if (!isCollectionId(target.id) || !safeName(path.basename(target.absolute)) || target.absolute !== path.join(target.parent.path, path.basename(target.absolute)) || inside(workspaceRoot, target.absolute) || inside(workspaceRoot, target.parent.path)) return fail('TARGET_INVALID');
  if (requireLive && (!Number.isFinite(Date.parse(target.expiresAt)) || Date.now() >= Date.parse(target.expiresAt))) return fail('TARGET_INVALID');
  if (await sourceRootAvailability(target.parent) !== 'ONLINE' || await realpath(target.parent.path) !== target.parent.path) return fail('TARGET_INVALID');
  const parent = await lstat(target.parent.path, { bigint: true });
  if (!parent.isDirectory() || identity(parent).dev !== target.parent.dev || identity(parent).ino !== target.parent.ino) return fail('TARGET_INVALID');
}
async function readManifest(job: StoredPreparationJob, signal: AbortSignal): Promise<Buffer> {
  if (!job.owned || !job.manifestHash) return fail('WORKSPACE_INVALID');
  signal.throwIfAborted(); await checkPreparationOwnership(job.owned);
  const absolute = path.join(job.owned.root.path, 'Manifest.json');
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 4n * 1024n * 1024n) return fail('WORKSPACE_INVALID');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return fail('CONTENT_CHANGED');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(absolute, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.dev !== named.dev || before.ino !== named.ino || sha(bytes) !== job.manifestHash) return fail('CONTENT_CHANGED');
    await checkPreparationOwnership(job.owned); signal.throwIfAborted(); return bytes;
  } finally { await handle.close(); }
}
async function exactWorkspace(job: StoredPreparationJob): Promise<readonly string[]> {
  if (!job.owned || job.owned.purpose !== undefined || !job.manifestHash || !job.files.length || job.files.length > 203 || job.files.some(file => !expectedFile(file.relative)) || new Set(job.files.map(file => file.relative)).size !== job.files.length) return fail('WORKSPACE_INVALID');
  await checkPreparationOwnership(job.owned);
  const root = job.owned.root.path;
  const directories = job.owned.directories.map(directory => path.relative(root, directory.path).split(path.sep).join('/'));
  const expectedDirs = job.input.layout.spec.format === 'cassette' ? ['Sources', 'Bounce Targets', 'Bounce Targets/A', 'Bounce Targets/B'] : ['Sources', 'Bounce Targets', 'Bounce Targets/Program'];
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirs)) return fail('WORKSPACE_INVALID');
  const top = ['.musicbridge-owner.json', 'Sources', 'Bounce Targets', 'Manifest.json', ...job.files.filter(file => !file.relative.startsWith('Sources/')).map(file => file.relative)].sort();
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(top)) return fail('WORKSPACE_INVALID');
  if (JSON.stringify((await readdir(path.join(root, 'Sources'))).sort()) !== JSON.stringify(job.files.filter(file => file.relative.startsWith('Sources/')).map(file => path.basename(file.relative)).sort())) return fail('WORKSPACE_INVALID');
  if (JSON.stringify((await readdir(path.join(root, 'Bounce Targets'))).sort()) !== JSON.stringify((job.input.layout.spec.format === 'cassette' ? ['A','B'] : ['Program']).sort())) return fail('WORKSPACE_INVALID');
  for (const child of job.input.layout.spec.format === 'cassette' ? ['A','B'] : ['Program']) if ((await readdir(path.join(root, 'Bounce Targets', child))).length) return fail('WORKSPACE_INVALID');
  await checkPreparationOwnership(job.owned);
  return directories;
}
function source(job: StoredPreparationJob, file: PreparationOutput, signal: AbortSignal): ZipEntrySource {
  return { name: file.relative, kind: 'file', size: file.size, sha256: file.sha256, open: async () => {
    if (!job.owned) return fail('WORKSPACE_INVALID');
    signal.throwIfAborted(); await checkPreparationOwnership(job.owned);
    const absolute = path.join(job.owned.root.path, file.relative);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      const named = await lstat(absolute, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(file.size) || named.dev !== before.dev || named.ino !== before.ino) return fail('CONTENT_CHANGED');
      const initial = identity(before);
      async function* chunks(): AsyncGenerator<Buffer> {
        try {
          const chunk = Buffer.allocUnsafe(1024 * 1024);
          let offset = 0;
          while (offset < file.size) {
            signal.throwIfAborted();
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, file.size - offset), offset);
            if (!bytesRead) return fail('CONTENT_CHANGED');
            offset += bytesRead;
            yield Buffer.from(chunk.subarray(0, bytesRead));
          }
          const after = await handle.stat({ bigint: true }), current = await lstat(absolute, { bigint: true });
          if (!sameIdentity(initial, identity(after)) || !sameIdentity(initial, identity(current)) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return fail('CONTENT_CHANGED');
          await checkPreparationOwnership(job.owned!); signal.throwIfAborted();
        } finally { await handle.close(); }
      }
      const raw = Readable.from(chunks(), { objectMode: false });
      const guarded = new Transform({
        transform(chunk: Buffer, _encoding, done) { done(null, chunk); },
        destroy(error, done) {
          const rawClosed = raw.closed ? Promise.resolve() : new Promise<void>(resolve => raw.once('close', resolve));
          raw.destroy();
          void rawClosed.then(() => handle.close()).then(() => done(error), closeError => done(closeError as Error));
        },
      });
      raw.once('error', error => guarded.destroy(error));
      raw.pipe(guarded);
      return guarded;
    } catch (error) { await handle.close(); throw error; }
  } };
}

export interface PreparationZipPlan { entries: readonly ZipEntryDescription[]; sources: (signal: AbortSignal) => readonly ZipEntrySource[]; packageManifest: string; budget: ZipBudget; sourceBytes: number }
export async function planPreparationZip(job: StoredPreparationJob, signal: AbortSignal): Promise<PreparationZipPlan> {
  if (job.public.state !== 'completed' || !job.owned || !job.manifestHash || !await verifyPublishedPreparation(job.owned, job.files, job.manifestHash, signal)) return fail('WORKSPACE_INVALID');
  const directories = await exactWorkspace(job);
  const manifest = await readManifest(job, signal);
  const sortedFiles = [...job.files].sort((a, b) => a.relative.localeCompare(b.relative, 'en-US'));
  const packageManifest = JSON.stringify({ schemaVersion: 1, kind: 'musicbridge-preparation-zip', workspaceId: job.public.id, masterVersionId: job.input.master.id, layoutVersionId: job.input.layout.id, manifestHash: job.manifestHash, files: sortedFiles, directories, executionReady: false }, null, 2) + '\n';
  const packageBytes = Buffer.from(packageManifest);
  if (packageBytes.length > 4 * 1024 * 1024) return fail('WORKSPACE_INVALID');
  const entries: ZipEntryDescription[] = [
    ...directories.map(name => ({ name: `${name}/`, kind: 'directory' as const, size: 0 })),
    ...sortedFiles.map(file => ({ name: file.relative, kind: 'file' as const, size: file.size, sha256: file.sha256 })),
    { name: 'Manifest.json', kind: 'file', size: manifest.length, sha256: sha(manifest) },
    { name: 'PackageManifest.json', kind: 'file', size: packageBytes.length, sha256: sha(packageBytes) },
  ];
  const sourceBytes = entries.reduce((sum, item) => sum + item.size, 0);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1 || entries.length > 210) return fail('WORKSPACE_INVALID');
  const budget: ZipBudget = { maxEntries: entries.length, maxEntryBytes: Math.min(68_719_476_736, sourceBytes), maxTotalBytes: sourceBytes, maxArchiveBytes: sourceBytes + 16 * 1024 * 1024 };
  const sources = (readSignal: AbortSignal): readonly ZipEntrySource[] => [
    ...directories.map(name => ({ name: `${name}/`, kind: 'directory' as const, size: 0 })),
    ...sortedFiles.map(file => source(job, file, readSignal)),
    { ...entries.at(-2)!, open: async () => Readable.from([manifest]) },
    { ...entries.at(-1)!, open: async () => Readable.from([packageBytes]) },
  ];
  return { entries, sources, packageManifest, budget, sourceBytes };
}
export async function createPreparationZipTemp(target: PreparationZipTargetBinding, jobId: string, workspaceRoot: string, requireLive = true): Promise<{ handle: FileHandle; path: string; identity: ZipFileIdentity }> {
  await checkPreparationZipTarget(target, workspaceRoot, requireLive);
  const temp = preparationZipTempPath(target, jobId);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size !== 0n || info.nlink !== 1n) return fail('TARGET_INVALID');
    await checkPreparationZipTarget(target, workspaceRoot, requireLive);
    return { handle, path: temp, identity: identity(info) };
  } catch (error) { await handle.close(); throw error; }
}
export async function writeAndVerifyPreparationZip(handle: FileHandle, sources: readonly ZipEntrySource[], entries: readonly ZipEntryDescription[], budget: ZipBudget, signal: AbortSignal): Promise<ZipReceipt> {
  const written = await writeVerifiedZip(handle, sources, budget, signal);
  const verified = await verifyVerifiedZip(handle, entries, budget, signal);
  if (written.sha256 !== verified.sha256 || written.size !== verified.size) return fail('CONTENT_CHANGED');
  return verified;
}
export async function publishPreparationZip(target: PreparationZipTargetBinding, job: StoredPreparationZipJob, signal: AbortSignal, check: () => void = () => undefined): Promise<void> {
  if (!job.temp || !job.verified) return fail('RECOVERY_REQUIRED');
  await checkPreparationZipTarget(target, job.workspace.owned.root.path, false);
  signal.throwIfAborted();
  const temp = preparationZipTempPath(target, job.public.id), info = await lstat(temp, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || !sameIdentity(identity(info), job.temp) || info.size !== BigInt(job.verified.size)) return fail('RECOVERY_REQUIRED');
  // link 成功就是取消/成功的线性化边界；EEXIST 绝不覆盖用户同名文件。
  signal.throwIfAborted(); check();
  await link(temp, target.absolute);
  const directory = await open(target.parent.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
/** 冷启动只检查已有 temp/final，不续写；可识别发布窗口中的双链接同 inode。 */
export async function verifyPreparationZipPublication(job: StoredPreparationZipJob, signal: AbortSignal): Promise<boolean> {
  if (!job.temp || !job.verified) return false;
  const target = job.target;
  try {
    await checkPreparationZipTarget(target, job.workspace.owned.root.path, false);
    const temp = preparationZipTempPath(target, job.public.id);
    const finalInfo = await lstat(target.absolute, { bigint: true });
    if (!finalInfo.isFile() || !sameIdentity(identity(finalInfo), job.temp) || finalInfo.size !== BigInt(job.verified.size)) return false;
    let tempInfo: BigIntStats | undefined;
    try { tempInfo = await lstat(temp, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (tempInfo ? !tempInfo.isFile() || !sameIdentity(identity(tempInfo), job.temp) || finalInfo.nlink !== 2n : finalInfo.nlink !== 1n) return false;
    const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(identity(opened), job.temp)) return false;
      const sourceBytes = job.entries.reduce((sum, entry) => sum + entry.size, 0);
      const budget: ZipBudget = { maxEntries: job.entries.length, maxEntryBytes: Math.min(68_719_476_736, sourceBytes), maxTotalBytes: sourceBytes, maxArchiveBytes: sourceBytes + 16 * 1024 * 1024 };
      const verified = await verifyVerifiedZip(handle, job.entries, budget, signal);
      const after = await lstat(target.absolute, { bigint: true });
      return verified.sha256 === job.verified.sha256 && verified.size === job.verified.size && sameIdentity(identity(after), job.temp) && after.size === finalInfo.size;
    } finally { await handle.close(); }
  } catch { return false; }
}
/** 仅在完成回执已持久化后清除已确证属于本任务的第二链接。 */
export async function removeOwnedPreparationZipTemp(job: StoredPreparationZipJob, check: () => void = () => undefined): Promise<void> {
  if (job.public.state !== 'completed' || !job.temp || !job.verified) return;
  const temp = preparationZipTempPath(job.target, job.public.id);
  try {
    check();
    const tempInfo = await lstat(temp, { bigint: true }), finalInfo = await lstat(job.target.absolute, { bigint: true });
    check();
    if (tempInfo.isFile() && finalInfo.isFile() && tempInfo.nlink === 2n && finalInfo.nlink === 2n && sameIdentity(identity(tempInfo), job.temp) && sameIdentity(identity(finalInfo), job.temp)) await unlink(temp);
  } catch { /* 不清理未知文件；完成回执仍可复核。 */ }
}
