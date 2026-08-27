import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { compileDirectPcm, type ExecutionSourceLocation } from './execution-compiler.js';
import type { ExecutionRecipe, ExecutionAudioReceipt } from '@music-bridge/contracts';
import { isCollectionId } from '@music-bridge/contracts';
import { authorizeSourceDirectory, sourceRootAvailability, copyReadonlySource, type RootCapability } from './source-files.js';

export class PreparationFileError extends Error { constructor() { super('Preparation 目标目录或操作归属已失效'); } }
export interface OwnedPreparation { id: string; root: RootCapability; destination: RootCapability; owner: string; directories: readonly RootCapability[]; purpose?: 'raw-render' | 'execution' }
export interface PreparationOutput { relative: string; sha256: string; size: number }
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const fail = (): never => { throw new PreparationFileError(); };
const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
export function assertPreparationOutsideSources(paths: readonly string[], roots: readonly RootCapability[]): void { if (paths.some(absolute => roots.some(root => inside(root.path, absolute)))) fail(); }
export async function authorizePreparationDestination(absolute: string, roots: readonly RootCapability[]): Promise<Omit<RootCapability, 'id'>> {
  if (!path.isAbsolute(absolute) || absolute.includes('\0') || absolute.split(path.sep).some(p => p === '.' || p === '..') || await realpath(absolute) !== absolute || roots.some(root => inside(root.path, absolute))) return fail();
  return authorizeSourceDirectory(absolute);
}
async function available(root: RootCapability): Promise<void> { if (await sourceRootAvailability(root) !== 'ONLINE') fail(); }
async function syncDirectory(root: RootCapability): Promise<void> {
  await available(root); const handle = await open(root.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat({ bigint: true }); if (!info.isDirectory() || String(info.dev) !== root.dev || String(info.ino) !== root.ino) fail(); await handle.sync(); } finally { await handle.close(); }
}
async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true }); if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(limit)) return fail();
    const bytes = Buffer.alloc(Number(info.size)); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) return fail(); offset += bytesRead; }
    const after = await handle.stat({ bigint: true }); if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) return fail();
    return bytes;
  } finally { await handle.close(); }
}
export async function checkPreparationOwnership(owned: OwnedPreparation): Promise<void> {
  if (!isCollectionId(owned.id) || owned.purpose !== undefined && owned.purpose !== 'raw-render' && owned.purpose !== 'execution' || owned.root.path !== path.join(owned.destination.path, `MusicBridge-${owned.purpose === 'execution' ? 'Execution' : owned.purpose === 'raw-render' ? 'OriginalRender' : 'Preparation'}-${owned.id}`)) return fail();
  await available(owned.destination); await available(owned.root);
  if ((await readBounded(path.join(owned.root.path, '.musicbridge-owner.json'), 1024)).toString('utf8') !== owned.owner) return fail();
  for (const directory of owned.directories) { if (!inside(owned.root.path, directory.path)) return fail(); await available(directory); }
}
export async function createPreparationDirectory(destination: RootCapability, id: string, format: 'cassette' | 'dat', purpose?: 'raw-render' | 'execution'): Promise<OwnedPreparation> {
  if (!isCollectionId(id) || purpose !== undefined && purpose !== 'raw-render' && purpose !== 'execution') return fail(); await available(destination);
  const absolute = path.join(destination.path, `MusicBridge-${purpose === 'execution' ? 'Execution' : purpose === 'raw-render' ? 'OriginalRender' : 'Preparation'}-${id}`);
  await mkdir(absolute, { mode: 0o700 });
  await available(destination);
  const root = { ...await authorizeSourceDirectory(absolute), id }, owner = JSON.stringify({ format: 1, operationId: id, nonce: randomUUID() });
  const marker = await open(path.join(absolute, '.musicbridge-owner.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await marker.writeFile(owner, 'utf8'); await marker.sync(); } finally { await marker.close(); }
  const directories: RootCapability[] = [], owned: OwnedPreparation = { id, root, destination, owner, directories, ...(purpose ? { purpose } : {}) };
  for (const relative of purpose === 'execution' ? ['Audio'] : purpose === 'raw-render' ? ['Originals'] : ['Sources', 'Bounce Targets', ...(format === 'cassette' ? ['Bounce Targets/A', 'Bounce Targets/B'] : ['Bounce Targets/Program'])]) {
    await checkPreparationOwnership(owned); const folder = path.join(absolute, relative); await mkdir(folder, { mode: 0o700 });
    directories.push({ ...await authorizeSourceDirectory(folder), id: randomUUID() });
  }
  for (const directory of [...directories].reverse()) await syncDirectory(directory);
  await syncDirectory(root); await syncDirectory(destination); await checkPreparationOwnership(owned); return owned;
}
function outputPath(owned: OwnedPreparation, relative: string): string {
  if (owned.purpose === 'execution') {
    if (!/^(?:Audio\/(?:A|B|Program)\.execution\.wav|Manifest\.json)$/u.test(relative)) return fail();
    return path.join(owned.root.path, relative);
  }
  if (owned.purpose === 'raw-render') {
    if (!/^(?:Originals\/(?:A|B|Program)\.wav|Manifest\.json)$/u.test(relative)) return fail();
    return path.join(owned.root.path, relative);
  }
  if (!/^(?:Sources\/[0-9]{3}\.(?:wav|aiff|flac)|Tracklist\.tsv|SourceLineage\.json|README\.txt|Manifest\.json)$/u.test(relative)) return fail();
  return path.join(owned.root.path, relative);
}
async function output(owned: OwnedPreparation, relative: string, write: (handle: FileHandle) => Promise<{ sha256: string; size: number }>): Promise<PreparationOutput> {
  await checkPreparationOwnership(owned); const absolute = outputPath(owned, relative);
  const handle = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await checkPreparationOwnership(owned);
    const initial = await handle.stat({ bigint: true }), result = await write(handle);
    await handle.sync(); await checkPreparationOwnership(owned);
    const final = await lstat(absolute, { bigint: true });
    if (!final.isFile() || final.nlink !== 1n || final.dev !== initial.dev || final.ino !== initial.ino) return fail();
    return { relative, ...result };
  } finally { await handle.close(); }
}
export async function writePreparationFile(owned: OwnedPreparation, relative: string, bytes: Buffer): Promise<PreparationOutput> {
  if (bytes.length > 4 * 1024 * 1024) return fail();
  return output(owned, relative, async handle => { await handle.writeFile(bytes); return { sha256: digest(bytes), size: bytes.length }; });
}
export async function copyPreparationFile(owned: OwnedPreparation, relative: string, root: RootCapability, source: string, expected: { sha256: string; size: number }, signal: AbortSignal): Promise<PreparationOutput> {
  return output(owned, relative, handle => copyReadonlySource(root, source, expected, handle, signal));
}
async function verifyOutput(owned: OwnedPreparation, file: PreparationOutput, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 68_719_476_736) return fail();
  await checkPreparationOwnership(owned); const absolute = outputPath(owned, file.relative);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(file.size)) return fail();
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024), deadline = Date.now() + 15 * 60_000; let offset = 0;
    while (offset < file.size) { signal.throwIfAborted(); if (Date.now() > deadline) return fail(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, file.size - offset), offset); if (!bytesRead) return fail(); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead; }
    const after = await lstat(absolute, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || hash.digest('hex') !== file.sha256) return fail();
    await checkPreparationOwnership(owned); signal.throwIfAborted();
  } finally { await handle.close(); }
}
export async function publishPreparation(owned: OwnedPreparation, files: readonly PreparationOutput[], manifest: Buffer, signal: AbortSignal): Promise<string> {
  if ((!files.length && owned.purpose !== 'execution') || files.length > 203 || new Set(files.map(f => f.relative)).size !== files.length || files.some(f => f.relative === 'Manifest.json')) return fail();
  signal.throwIfAborted();
  for (const file of files) await verifyOutput(owned, file, signal);
  signal.throwIfAborted(); const result = await writePreparationFile(owned, 'Manifest.json', manifest);
  for (const directory of owned.directories) await syncDirectory(directory);
  await syncDirectory(owned.root); signal.throwIfAborted(); return result.sha256;
}
export async function verifyPublishedPreparation(owned: OwnedPreparation, files: readonly PreparationOutput[], manifestHash: string, signal = new AbortController().signal): Promise<boolean> {
  try {
    await checkPreparationOwnership(owned);
    const manifest = await readBounded(outputPath(owned, 'Manifest.json'), 4 * 1024 * 1024);
    if (digest(manifest) !== manifestHash || (!files.length && owned.purpose !== 'execution')) return false;
    for (const file of files) await verifyOutput(owned, file, signal);
    await checkPreparationOwnership(owned); return true;
  } catch { return false; }
}

/** 只能在执行任务拥有的目录内写入新的编译音频，不能覆盖已有资产。 */
export async function compileExecutionFile(owned: OwnedPreparation, recipe: ExecutionRecipe, sources: readonly ExecutionSourceLocation[], signal: AbortSignal): Promise<{ file: PreparationOutput; receipt: ExecutionAudioReceipt }> {
  if (owned.purpose !== 'execution') return fail();
  let receipt: ExecutionAudioReceipt | undefined;
  const file = await output(owned, `Audio/${recipe.side}.execution.wav`, async handle => {
    receipt = await compileDirectPcm(recipe, sources, handle, signal);
    return receipt.audio;
  });
  if (!receipt) return fail();
  return { file, receipt };
}
