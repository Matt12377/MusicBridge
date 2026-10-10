import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isReferenceCatalogKey, parseReferenceSourcePack, type SourcePack } from '@music-bridge/contracts';
import { readVerifiedZipEntries, type ZipBudget, type ZipEntryReceipt, type ZipReceipt } from '../recording/verified-zip.js';

/** 完整档案与旧 4 MiB、单 JSON 的资料 ZIP 入口分开，预算覆盖已审计的 r3 原包。 */
export const CASSETTE_ARCHIVE_BUDGET: Readonly<ZipBudget> = {
  maxArchiveBytes: 4 * 1024 ** 3, maxTotalBytes: 6 * 1024 ** 3,
  maxEntries: 30_000, maxEntryBytes: 128 * 1024 ** 2,
};
export class CassetteArchiveError extends Error {
  constructor(readonly code: 'INVALID_ARCHIVE' | 'INVALID_DATA' | 'CONTENT_CHANGED' | 'UNAVAILABLE' | 'CANCELLED') {
    super(`磁带资料档案：${code}`);
  }
}
export interface CassetteArchiveSummary {
  sha256: string; zipBytes: number; bookId: string; title: string; sourceVersion: string;
  itemCount: number; assetCount: number; primaryCount: number; missingPrimaryCount: number;
  realPhotoCount: number; opaqueDisplayCount: number;
}
export interface CassetteArchiveAsset {
  /** 相对应用自有档案目录的私有路径，不进入 Renderer。 */
  path: string; sha256: string; contentType: string; role: string;
  origin: 'book' | 'real-photo-reference' | 'opaque-display'; caption: string; source: string | null;
}
export interface CassetteArchiveReference {
  primaryAssetId: string | null; missingPrimaryReason: string | null;
  assetIds: string[]; realPhotoIds: string[]; opaqueDisplayIds: string[]; recordPath: string;
}
export interface LoadedCassetteArchive {
  directory: string; summary: CassetteArchiveSummary; rawPack: string;
  index: { references: Record<string, CassetteArchiveReference>; assets: Record<string, CassetteArchiveAsset> };
}
interface Fingerprint { dev: string; ino: string; size: number; mtimeNs: string; ctimeNs: string }
interface StoredEntry extends ZipEntryReceipt { fingerprint: Fingerprint }
interface ContentReceipt { path: string; sha256: string; bytes: number }
interface ArchiveManifest {
  schema: 1; sha256: string; root: string; summary: CassetteArchiveSummary;
  container: Fingerprint; index: ContentReceipt; pack: ContentReceipt; entries: ContentReceipt;
  records: Record<string, ContentReceipt>;
}
const loadedManifests = new WeakMap<LoadedCassetteArchive, ArchiveManifest>();
const hashPattern = /^[0-9a-f]{64}$/u;
const MAX_INDEX_BYTES = 16 * 1024 ** 2;
const MAX_RECEIPT_BYTES = 32 * 1024 ** 2;
const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function fail(code: CassetteArchiveError['code']): never { throw new CassetteArchiveError(code); }
function abort(signal: AbortSignal): void { if (signal.aborted) fail('CANCELLED'); }
function object(value: unknown): Record<string, unknown> { return record(value) ? value : fail('INVALID_DATA'); }
function text(value: unknown): string { return typeof value === 'string' ? value : fail('INVALID_DATA'); }
function key(value: unknown): string { return isReferenceCatalogKey(value) ? value : fail('INVALID_DATA'); }
function hash(value: unknown): string { return typeof value === 'string' && hashPattern.test(value) ? value : fail('INVALID_DATA'); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : fail('INVALID_DATA'); }
function stringList(value: unknown): string[] { return list(value).map(key); }
function rows(value: unknown): Record<string, unknown>[] { return list(value).map(object); }
function uniqueRows(values: readonly Record<string, unknown>[], field: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    const id = key(value[field]);
    if (result.has(id)) fail('INVALID_DATA');
    result.set(id, value);
  }
  return result;
}
function safeRelative(value: unknown): string {
  const path = text(value);
  if (!path || isAbsolute(path) || path.includes('\\') || path !== path.normalize('NFC') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)) fail('INVALID_DATA');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[/\\:]/u.test(part.normalize('NFKC')))) fail('INVALID_DATA');
  return path;
}
function memberPath(directory: string, path: string): string {
  const result = resolve(directory, safeRelative(path));
  if (!relative(directory, result) || relative(directory, result).startsWith(`..${sep}`) || isAbsolute(relative(directory, result))) fail('INVALID_DATA');
  return result;
}
async function realDirectories(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = dirname(absolute);
  const parents = [absolute];
  while (current !== dirname(current)) { parents.push(current); current = dirname(current); }
  for (const parent of parents.reverse()) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNAVAILABLE');
  }
}
async function ensureRealDirectories(path: string): Promise<void> {
  const absolute = resolve(path), parts: string[] = [];
  let cursor = absolute;
  while (cursor !== dirname(cursor)) { parts.push(cursor); cursor = dirname(cursor); }
  for (const directory of parts.reverse()) {
    let info = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!info) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      info = await lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNAVAILABLE');
  }
}
function fingerprint(stat: BigIntStats): Fingerprint {
  // 字符串避免 inode 与时间戳超出 JSON 安全整数。
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function regularHandle(path: string): Promise<FileHandle> {
  await realDirectories(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('UNAVAILABLE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const actual = await handle.stat({ bigint: true });
  if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) { await handle.close(); fail('CONTENT_CHANGED'); }
  return handle;
}
async function readBytes(directory: string, path: string, limit: number, expected?: ContentReceipt): Promise<Buffer> {
  const handle = await regularHandle(memberPath(directory, path));
  try {
    const before = fingerprint(await handle.stat({ bigint: true }));
    if (before.size < 1 || before.size > limit) fail('INVALID_DATA');
    const bytes = await handle.readFile();
    if (!sameFingerprint(before, fingerprint(await handle.stat({ bigint: true })))) fail('CONTENT_CHANGED');
    if (expected && (bytes.length !== expected.bytes || bytesHash(bytes) !== expected.sha256)) fail('CONTENT_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return fail('INVALID_DATA'); }
}
async function writeBytes(directory: string, path: string, bytes: Buffer): Promise<ContentReceipt> {
  const target = memberPath(directory, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return { path, bytes: bytes.length, sha256: bytesHash(bytes) };
}
async function writeJson(directory: string, path: string, value: unknown): Promise<ContentReceipt> {
  return writeBytes(directory, path, Buffer.from(JSON.stringify(value), 'utf8'));
}
async function copyContainer(sourcePath: string, directory: string, signal: AbortSignal): Promise<{ handle: FileHandle; fingerprint: Fingerprint; sha256: string }> {
  const source = await regularHandle(resolve(sourcePath));
  let target: FileHandle | undefined;
  try {
    const before = fingerprint(await source.stat({ bigint: true }));
    if (before.size < 1 || before.size > CASSETTE_ARCHIVE_BUDGET.maxArchiveBytes) fail('INVALID_ARCHIVE');
    target = await open(join(directory, 'container.zip'), 'wx+', 0o600);
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      abort(signal);
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) fail('CONTENT_CHANGED');
      const chunk = buffer.subarray(0, bytesRead);
      let written = 0;
      while (written < chunk.length) {
        const result = await target.write(chunk, written, chunk.length - written, offset + written);
        if (!result.bytesWritten) fail('UNAVAILABLE');
        written += result.bytesWritten;
      }
      digest.update(chunk); offset += bytesRead;
    }
    const sourcePathAfter = await lstat(resolve(sourcePath), { bigint: true });
    if (sourcePathAfter.isSymbolicLink() || !sourcePathAfter.isFile() || !sameFingerprint(before, fingerprint(sourcePathAfter))
      || !sameFingerprint(before, fingerprint(await source.stat({ bigint: true })))) fail('CONTENT_CHANGED');
    await target.sync();
    const owned = fingerprint(await target.stat({ bigint: true }));
    return { handle: target, fingerprint: owned, sha256: digest.digest('hex') };
  } catch (error) { await target?.close(); throw error; }
  finally { await source.close(); }
}
function mime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return fail('INVALID_DATA');
  }
}
function publicSource(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const source = text(value);
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return source;
  } catch { return null; }
}
function receipt(value: unknown): ContentReceipt {
  const data = object(value), bytes = data.bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) fail('INVALID_DATA');
  return { path: safeRelative(data.path), sha256: hash(data.sha256), bytes };
}
function storedFingerprint(value: unknown): Fingerprint {
  const data = object(value);
  if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0 || !['dev', 'ino', 'mtimeNs', 'ctimeNs'].every(field => typeof data[field] === 'string' && /^\d+$/u.test(data[field] as string))) fail('INVALID_DATA');
  return { dev: text(data.dev), ino: text(data.ino), size: data.size, mtimeNs: text(data.mtimeNs), ctimeNs: text(data.ctimeNs) };
}
function summary(value: unknown, sha256: string): CassetteArchiveSummary {
  const data = object(value);
  if (data.sha256 !== sha256) fail('INVALID_DATA');
  const fields = ['zipBytes', 'itemCount', 'assetCount', 'primaryCount', 'missingPrimaryCount', 'realPhotoCount', 'opaqueDisplayCount'] as const;
  for (const field of fields) if (typeof data[field] !== 'number' || !Number.isSafeInteger(data[field]) || (data[field] as number) < 0) fail('INVALID_DATA');
  if ((data.primaryCount as number) + (data.missingPrimaryCount as number) !== data.itemCount) fail('INVALID_DATA');
  return { sha256, zipBytes: data.zipBytes as number, bookId: key(data.bookId), title: text(data.title), sourceVersion: text(data.sourceVersion),
    itemCount: data.itemCount as number, assetCount: data.assetCount as number, primaryCount: data.primaryCount as number,
    missingPrimaryCount: data.missingPrimaryCount as number, realPhotoCount: data.realPhotoCount as number, opaqueDisplayCount: data.opaqueDisplayCount as number };
}

async function generateIndex(directory: string, root: string, entries: readonly StoredEntry[], sha256: string, zipBytes: number): Promise<LoadedCassetteArchive> {
  const byPath = new Map(entries.filter(entry => entry.kind === 'file').map(entry => [entry.name, entry]));
  const read = async (path: string): Promise<unknown> => {
    const name = root + path, entry = byPath.get(name);
    if (!entry?.sha256) fail('INVALID_DATA');
    return json(await readBytes(directory, `files/${name}`, CASSETTE_ARCHIVE_BUDGET.maxEntryBytes, { path: name, sha256: entry.sha256, bytes: entry.size }));
  };
  const rawSource = await read('catalog/SOURCEPACK.json');
  const pack = parseReferenceSourcePack(JSON.stringify(rawSource));
  if (!pack || pack.items.some(item => item.image.kind !== 'none' || item.archive !== undefined)) fail('INVALID_DATA');
  const catalog = object(await read('catalog/reference_catalog_r3.json'));
  if (catalog.schema_version !== 'musicbridge-rich-reference-r3/v1' || catalog.bookId !== pack.bookId || catalog.sourceVersion !== pack.sourceVersion) fail('INVALID_DATA');
  const rich = uniqueRows(rows(catalog.records), 'referenceId');
  const primary = uniqueRows(rows(object(await read('catalog/primary_images.json')).records), 'referenceId');
  const native = uniqueRows(rows(await read('catalog/images_manifest.json')), 'asset_id');
  const photos = uniqueRows(rows(object(await read('photo_upgrade/PHOTO_REFERENCES.json')).records), 'reference_id');
  const overlays = uniqueRows(rows(object(await read('photo_upgrade/DISPLAY_OVERLAY.json')).records), 'asset_id');
  const reconciliation = object(await read('catalog/PRIMARY_RECONCILIATION.json'));
  const reasons = uniqueRows(rows(reconciliation.remaining_no_primary_cases), 'referenceId');
  if (rich.size !== pack.items.length || primary.size !== rich.size) fail('INVALID_DATA');
  const references: Record<string, CassetteArchiveReference> = Object.create(null) as Record<string, CassetteArchiveReference>;
  const assets: Record<string, CassetteArchiveAsset> = Object.create(null) as Record<string, CassetteArchiveAsset>;
  function addAsset(id: string, data: Record<string, unknown>, pathField: string, shaField: string | undefined,
    origin: CassetteArchiveAsset['origin'], caption: string, source: string | null): void {
    key(id);
    if (Object.hasOwn(assets, id)) fail('INVALID_DATA');
    const path = safeRelative(data[pathField]), entry = byPath.get(root + path);
    if (!entry?.sha256 || shaField && hash(data[shaField]) !== entry.sha256) fail('INVALID_DATA');
    assets[id] = { path: `files/${root}${path}`, sha256: entry.sha256, contentType: mime(path), role: text(data.role ?? data.observed_source_role), origin, caption, source };
  }
  for (const [id, data] of native) {
    const caption = `原书第 ${text(String(data.printed_page_label ?? '未知'))} 页参考图；${text(data.role)}${typeof data.use_limit === 'string' ? `；${data.use_limit}` : ''}`;
    addAsset(id, data, 'wall_512_path', undefined, 'book', caption, null);
    addAsset(`${id}:original`, data, 'cutout_path', 'sha256', 'book', caption, null);
    for (const canonicalId of stringList(data.canonical_reference_ids)) if (!rich.has(canonicalId)) fail('INVALID_DATA');
  }
  for (const item of pack.items) {
    const data = rich.get(item.referenceId), choice = primary.get(item.referenceId);
    if (!data || !choice || data.bookId !== item.bookId) fail('INVALID_DATA');
    // 兼容 SourcePack 只负责身份投影；不允许它与完整档案的身份字段悄悄分叉。
    for (const field of ['brand', 'series', 'edition', 'model', 'iec', 'era'] as const) if (data[field] !== item[field]) fail('INVALID_DATA');
    const primaryAssetId = choice.primary_asset_id === null ? null : key(choice.primary_asset_id);
    const assetIds = [...new Set([...stringList(data.asset_ids), ...stringList(data.auxiliary_asset_ids)])];
    if (assetIds.some(id => !native.has(id)) || primaryAssetId !== null && (!native.has(primaryAssetId) || !assetIds.includes(primaryAssetId))) fail('INVALID_DATA');
    if (data.r3_information === undefined || !record(data.r3_information)) fail('INVALID_DATA');
    const reason = reasons.get(item.referenceId);
    references[item.referenceId] = { primaryAssetId,
      missingPrimaryReason: primaryAssetId === null ? typeof reason?.reason_label === 'string' ? reason.reason_label : '原书未提供合格的独立主图。' : null,
      assetIds, realPhotoIds: [], opaqueDisplayIds: [], recordPath: `records/${item.referenceId}.json` };
  }
  for (const [id, data] of photos) {
    const logicalId = `photo:${id}`;
    if (!native.has(key(data.asset_id))) fail('INVALID_DATA');
    addAsset(logicalId, data, 'local_relative_path', 'sha256', 'real-photo-reference', text(data.use_label), publicSource(data.source_url));
    for (const canonicalId of stringList(data.canonical_ids)) {
      const reference = references[canonicalId];
      if (!reference) fail('INVALID_DATA');
      reference.realPhotoIds.push(logicalId);
    }
  }
  for (const [id, data] of overlays) {
    const logicalId = `display:${id}`;
    if (!native.has(id) || !photos.has(key(data.reference_id)) || data.display_mode !== 'opaque_original_photograph_with_watermark'
      || data.original_catalogue_primary_asset_id_changed !== false || data.original_alpha_png_changed !== false) fail('INVALID_DATA');
    const caption = `保留水印的真实照片辅助展示；${text(photos.get(key(data.reference_id))!.use_label)}`;
    addAsset(logicalId, data, 'photo_relative_path', 'sha256', 'opaque-display', caption, publicSource(data.source_url));
    const original = byPath.get(root + safeRelative(data.original_native_relative_path));
    if (!original || original.sha256 !== hash(data.original_native_sha256)) fail('INVALID_DATA');
    for (const canonicalId of stringList(data.canonical_ids)) {
      const reference = references[canonicalId];
      if (!reference) fail('INVALID_DATA');
      reference.opaqueDisplayIds.push(logicalId);
    }
  }
  const primaryCount = Object.values(references).filter(value => value.primaryAssetId !== null).length;
  const archiveSummary: CassetteArchiveSummary = { sha256, zipBytes, bookId: pack.bookId, title: pack.title, sourceVersion: pack.sourceVersion,
    itemCount: rich.size, assetCount: native.size, primaryCount, missingPrimaryCount: rich.size - primaryCount,
    realPhotoCount: photos.size, opaqueDisplayCount: overlays.size };
  const normalized: SourcePack = { ...pack, items: pack.items.map(item => ({ ...item, archive: { sha256, primaryAssetId: references[item.referenceId]!.primaryAssetId } })) };
  const rawPack = JSON.stringify(normalized);
  if (!parseReferenceSourcePack(rawPack)) fail('INVALID_DATA');
  const records: Record<string, ContentReceipt> = Object.create(null) as Record<string, ContentReceipt>;
  for (const [id, data] of rich) records[id] = await writeJson(directory, references[id]!.recordPath, data);
  const index = { references, assets };
  const indexReceipt = await writeJson(directory, 'index.json', index);
  const packReceipt = await writeBytes(directory, 'source-pack.json', Buffer.from(rawPack));
  const entriesReceipt = await writeJson(directory, 'entry-receipts.json', entries);
  if (indexReceipt.bytes > MAX_INDEX_BYTES || entriesReceipt.bytes > MAX_RECEIPT_BYTES) fail('INVALID_DATA');
  const handle = await regularHandle(join(directory, 'container.zip'));
  let container: Fingerprint;
  try { container = fingerprint(await handle.stat({ bigint: true })); } finally { await handle.close(); }
  const manifest: ArchiveManifest = { schema: 1, sha256, root, summary: archiveSummary, container,
    index: indexReceipt, pack: packReceipt, entries: entriesReceipt, records };
  await writeJson(directory, 'manifest.json', manifest);
  return { directory, summary: archiveSummary, rawPack, index };
}

/** 只在应用自有 staging 中复制和解包；完整校验后一次 rename 发布不可变 SHA 目录。 */
export async function prepareCassetteArchive(options: { archivePath: string; archiveRoot: string; signal?: AbortSignal }): Promise<LoadedCassetteArchive> {
  const signal = options.signal ?? new AbortController().signal;
  abort(signal);
  if (!isAbsolute(options.archiveRoot) || !isAbsolute(options.archivePath)) fail('UNAVAILABLE');
  const archiveRoot = resolve(options.archiveRoot);
  await ensureRealDirectories(archiveRoot);
  await realDirectories(archiveRoot);
  const directory = await mkdtemp(join(archiveRoot, '.cassette-stage-'));
  const owned = await lstat(directory, { bigint: true });
  let moved = false;
  try {
    const copied = await copyContainer(options.archivePath, directory, signal);
    let root: string | undefined;
    const fingerprints = new Map<string, Fingerprint>();
    let archiveReceipt: ZipReceipt;
    try {
      const existing = await lstat(join(archiveRoot, copied.sha256)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      if (existing) return await loadCassetteArchive(archiveRoot, copied.sha256);
      archiveReceipt = await readVerifiedZipEntries(copied.handle, CASSETTE_ARCHIVE_BUDGET, signal, async (entry, chunks) => {
        const prefix = `${entry.name.split('/')[0]!}/`;
        if (!root) root = prefix;
        if (prefix !== root || !entry.name.startsWith(root) || entry.kind === 'file' && entry.name === root.slice(0, -1)) fail('INVALID_DATA');
        const path = `files/${entry.name.replace(/\/$/u, '')}`, target = memberPath(directory, path);
        if (entry.kind === 'directory') {
          await mkdir(target, { recursive: true, mode: 0o700 });
          for await (const _ of chunks) { /* 空目录仍消费到 EOF。 */ }
          fingerprints.set(entry.name, fingerprint(await lstat(target, { bigint: true })));
          return;
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const handle = await open(target, 'wx', 0o600);
        try {
          for await (const chunk of chunks) {
            let offset = 0;
            while (offset < chunk.length) {
              const result = await handle.write(chunk, offset, chunk.length - offset);
              if (!result.bytesWritten) fail('UNAVAILABLE');
              offset += result.bytesWritten;
            }
          }
          fingerprints.set(entry.name, fingerprint(await handle.stat({ bigint: true })));
        } finally { await handle.close(); }
      });
    } finally { await copied.handle.close(); }
    if (!root || archiveReceipt.sha256 !== copied.sha256) fail('CONTENT_CHANGED');
    const entries: StoredEntry[] = archiveReceipt.entries.map(entry => ({ ...entry, fingerprint: fingerprints.get(entry.name)! }));
    if (entries.some(entry => !entry.fingerprint)) fail('INVALID_DATA');
    await generateIndex(directory, root, entries, archiveReceipt.sha256, archiveReceipt.size);
    abort(signal);
    const destination = join(archiveRoot, archiveReceipt.sha256);
    try {
      // 非空不可变目录不可被 rename 覆盖；并发相同 SHA 发布者共用已核档案。
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      if (existing) return await loadCassetteArchive(archiveRoot, archiveReceipt.sha256);
      await rename(directory, destination);
      moved = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      return await loadCassetteArchive(archiveRoot, archiveReceipt.sha256);
    }
    return await loadCassetteArchive(archiveRoot, archiveReceipt.sha256);
  } catch (error) {
    if (signal.aborted) fail('CANCELLED');
    if (error instanceof CassetteArchiveError) throw error;
    throw new CassetteArchiveError('INVALID_ARCHIVE');
  } finally {
    if (!moved) {
      const current = await lstat(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) fail('CONTENT_CHANGED');
      await rm(directory, { recursive: true });
    }
  }
}

/** 重载只读验证来源绑定、生成文件 SHA 和原始条目身份；不反复全量解压 3.3 GiB。 */
export async function loadCassetteArchive(archiveRoot: string, sha256: string): Promise<LoadedCassetteArchive> {
  hash(sha256);
  if (!isAbsolute(archiveRoot)) fail('UNAVAILABLE');
  const directory = join(resolve(archiveRoot), sha256);
  await realDirectories(directory);
  const data = object(json(await readBytes(directory, 'manifest.json', MAX_RECEIPT_BYTES)));
  if (data.schema !== 1 || data.sha256 !== sha256) fail('INVALID_DATA');
  const archiveSummary = summary(data.summary, sha256);
  const root = safeRelative(text(data.root).replace(/\/$/u, '')) + '/';
  if (root.split('/').length !== 2) fail('INVALID_DATA');
  const manifest: ArchiveManifest = { schema: 1, sha256, root, summary: archiveSummary, container: storedFingerprint(data.container),
    index: receipt(data.index), pack: receipt(data.pack), entries: receipt(data.entries), records: {} };
  if (manifest.index.path !== 'index.json' || manifest.pack.path !== 'source-pack.json' || manifest.entries.path !== 'entry-receipts.json') fail('INVALID_DATA');
  const container = await regularHandle(join(directory, 'container.zip'));
  try {
    if (!sameFingerprint(manifest.container, fingerprint(await container.stat({ bigint: true }))) || manifest.container.size !== archiveSummary.zipBytes) fail('CONTENT_CHANGED');
  } finally { await container.close(); }
  const entries = rows(json(await readBytes(directory, manifest.entries.path, MAX_RECEIPT_BYTES, manifest.entries)));
  if (!entries.length || entries.length > CASSETTE_ARCHIVE_BUDGET.maxEntries) fail('INVALID_DATA');
  const byPath = new Map<string, { sha256: string; bytes: number; fingerprint: Fingerprint }>();
  const seenNames = new Set<string>();
  let expandedBytes = 0;
  // lstat 不重读图像字节，保留每个已实际 CRC/SHA 核过的原始条目的 inode、尺寸和时间戳封印。
  for (const entry of entries) {
    const name = text(entry.name), isDirectory = entry.kind === 'directory';
    if (entry.kind !== 'file' && !isDirectory || !name.startsWith(root)) fail('INVALID_DATA');
    const path = safeRelative(name.replace(/\/$/u, '')), expected = storedFingerprint(entry.fingerprint);
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > CASSETTE_ARCHIVE_BUDGET.maxEntryBytes || !isDirectory && expected.size !== entry.size) fail('INVALID_DATA');
    expandedBytes += entry.size;
    if (expandedBytes > CASSETTE_ARCHIVE_BUDGET.maxTotalBytes || seenNames.has(name)) fail('INVALID_DATA');
    seenNames.add(name);
    const actual = await lstat(memberPath(directory, `files/${path}`), { bigint: true });
    if (actual.isSymbolicLink() || (isDirectory ? !actual.isDirectory() : !actual.isFile())) fail('CONTENT_CHANGED');
    if (!isDirectory) {
      if (!sameFingerprint(expected, fingerprint(actual))) fail('CONTENT_CHANGED');
      byPath.set(name, { sha256: hash(entry.sha256), bytes: entry.size, fingerprint: expected });
    }
  }
  const rawPackBytes = await readBytes(directory, manifest.pack.path, 1024 ** 2, manifest.pack);
  const rawPack = new TextDecoder('utf-8', { fatal: true }).decode(rawPackBytes), pack = parseReferenceSourcePack(rawPack);
  if (!pack || pack.bookId !== archiveSummary.bookId || pack.title !== archiveSummary.title || pack.sourceVersion !== archiveSummary.sourceVersion || pack.items.length !== archiveSummary.itemCount) fail('INVALID_DATA');
  async function original(path: string): Promise<unknown> {
    const name = root + path, entry = byPath.get(name);
    if (!entry) fail('INVALID_DATA');
    return json(await readBytes(directory, `files/${name}`, CASSETTE_ARCHIVE_BUDGET.maxEntryBytes, { path: name, sha256: entry.sha256, bytes: entry.bytes }));
  }
  const originalPack = parseReferenceSourcePack(JSON.stringify(await original('catalog/SOURCEPACK.json')));
  const originalPrimary = uniqueRows(rows(object(await original('catalog/primary_images.json')).records), 'referenceId');
  if (!originalPack || originalPack.items.length !== pack.items.length || originalPack.bookId !== pack.bookId || originalPack.title !== pack.title
    || originalPack.sourceVersion !== pack.sourceVersion || originalPrimary.size !== pack.items.length) fail('INVALID_DATA');
  const originalItems = new Map(originalPack.items.map(item => [item.referenceId, item]));
  // 原始 SourcePack 与主图关系小于完整档案；每次导入核对它们，不凭生成 index 自证身份。
  for (const item of pack.items) {
    const baseline = originalItems.get(item.referenceId), choice = originalPrimary.get(item.referenceId);
    if (!baseline || !choice || baseline.image.kind !== 'none' || item.image.kind !== 'none'
      || JSON.stringify({ ...item, archive: undefined }) !== JSON.stringify(baseline)
      || item.archive?.primaryAssetId !== choice.primary_asset_id) fail('INVALID_DATA');
  }
  const indexData = object(json(await readBytes(directory, manifest.index.path, MAX_INDEX_BYTES, manifest.index)));
  const referenceData = object(indexData.references), assetData = object(indexData.assets), recordReceipts = object(data.records);
  if (Object.keys(referenceData).length !== pack.items.length || Object.keys(recordReceipts).length !== pack.items.length) fail('INVALID_DATA');
  const references: Record<string, CassetteArchiveReference> = Object.create(null) as Record<string, CassetteArchiveReference>;
  const assets: Record<string, CassetteArchiveAsset> = Object.create(null) as Record<string, CassetteArchiveAsset>;
  for (const [id, raw] of Object.entries(assetData)) {
    key(id);
    const asset = object(raw), path = safeRelative(asset.path), entry = byPath.get(path.replace(/^files\//u, ''));
    if (!path.startsWith('files/') || !entry || entry.sha256 !== hash(asset.sha256) || mime(path) !== asset.contentType
      || !['book', 'real-photo-reference', 'opaque-display'].includes(text(asset.origin))) fail('INVALID_DATA');
    assets[id] = { path, sha256: entry.sha256, contentType: mime(path), role: text(asset.role), origin: asset.origin as CassetteArchiveAsset['origin'], caption: text(asset.caption), source: publicSource(asset.source) };
  }
  for (const item of pack.items) {
    if (!Object.hasOwn(referenceData, item.referenceId) || !Object.hasOwn(recordReceipts, item.referenceId)) fail('INVALID_DATA');
    const ref = object(referenceData[item.referenceId]), storedRecord = receipt(recordReceipts[item.referenceId]);
    const primaryAssetId = ref.primaryAssetId === null ? null : key(ref.primaryAssetId);
    if (item.archive?.sha256 !== sha256 || item.archive.primaryAssetId !== primaryAssetId || primaryAssetId !== null && (!Object.hasOwn(assets, primaryAssetId) || assets[primaryAssetId]!.origin !== 'book')) fail('INVALID_DATA');
    const recordPath = safeRelative(ref.recordPath);
    if (recordPath !== `records/${item.referenceId}.json` || storedRecord.path !== recordPath) fail('INVALID_DATA');
    const assetIds = stringList(ref.assetIds), realPhotoIds = stringList(ref.realPhotoIds), opaqueDisplayIds = stringList(ref.opaqueDisplayIds);
    for (const [ids, origin] of [[assetIds, 'book'], [realPhotoIds, 'real-photo-reference'], [opaqueDisplayIds, 'opaque-display']] as const)
      if (new Set(ids).size !== ids.length || ids.some(id => !Object.hasOwn(assets, id) || assets[id]!.origin !== origin)) fail('INVALID_DATA');
    if (primaryAssetId !== null && !assetIds.includes(primaryAssetId)) fail('INVALID_DATA');
    references[item.referenceId] = { primaryAssetId, missingPrimaryReason: ref.missingPrimaryReason === null ? null : text(ref.missingPrimaryReason), assetIds, realPhotoIds, opaqueDisplayIds, recordPath };
    manifest.records[item.referenceId] = storedRecord;
  }
  const count = (origin: CassetteArchiveAsset['origin']): number => Object.entries(assets).filter(([id, asset]) => asset.origin === origin && (origin !== 'book' || !id.endsWith(':original'))).length;
  if (count('book') !== archiveSummary.assetCount || count('real-photo-reference') !== archiveSummary.realPhotoCount || count('opaque-display') !== archiveSummary.opaqueDisplayCount
    || Object.values(references).filter(ref => ref.primaryAssetId !== null).length !== archiveSummary.primaryCount) fail('INVALID_DATA');
  const loaded = { directory, summary: archiveSummary, rawPack, index: { references, assets } };
  for (const ref of Object.values(references)) { Object.freeze(ref.assetIds); Object.freeze(ref.realPhotoIds); Object.freeze(ref.opaqueDisplayIds); Object.freeze(ref); }
  for (const asset of Object.values(assets)) Object.freeze(asset);
  Object.freeze(references); Object.freeze(assets); Object.freeze(loaded.index); Object.freeze(loaded.summary); Object.freeze(loaded);
  loadedManifests.set(loaded, manifest);
  return loaded;
}

export async function getCassetteArchiveRecord(archive: LoadedCassetteArchive, referenceId: string): Promise<Record<string, unknown>> {
  key(referenceId);
  const manifest = loadedManifests.get(archive);
  if (!manifest || !Object.hasOwn(manifest.records, referenceId)) fail('UNAVAILABLE');
  const expected = manifest.records[referenceId]!;
  const value = object(json(await readBytes(archive.directory, expected.path, CASSETTE_ARCHIVE_BUDGET.maxEntryBytes, expected)));
  if (value.referenceId !== referenceId || value.bookId !== archive.summary.bookId) fail('INVALID_DATA');
  return value;
}

export async function getCassetteArchiveAsset(archive: LoadedCassetteArchive, assetId: string): Promise<{ path: string; sha256: string; contentType: string }> {
  key(assetId);
  if (!loadedManifests.has(archive) || !Object.hasOwn(archive.index.assets, assetId)) fail('UNAVAILABLE');
  const asset = archive.index.assets[assetId]!, path = memberPath(archive.directory, asset.path), handle = await regularHandle(path);
  try {
    const before = fingerprint(await handle.stat({ bigint: true }));
    if (before.size < 1 || before.size > CASSETTE_ARCHIVE_BUDGET.maxEntryBytes) fail('INVALID_DATA');
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) fail('CONTENT_CHANGED');
      digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (digest.digest('hex') !== asset.sha256 || !sameFingerprint(before, fingerprint(await handle.stat({ bigint: true })))) fail('CONTENT_CHANGED');
    return { path, sha256: asset.sha256, contentType: asset.contentType };
  } finally { await handle.close(); }
}
