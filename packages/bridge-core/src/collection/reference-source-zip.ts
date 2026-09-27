import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isPreviewReferenceSourceZipRequest, normalizeReferenceItems, parseReferenceSourcePack,
  MAX_REFERENCE_SOURCE_PACK_BYTES, MAX_REFERENCE_SOURCE_ZIP_BYTES,
  type ReferenceSourceZipEntryName, type ReferenceSourceZipPreview, type SourcePack,
} from '@music-bridge/contracts';
import { readVerifiedZipEntries, type ZipBudget } from '../recording/verified-zip.js';

export class ReferenceSourceZipError extends Error {
  constructor(readonly code: 'INVALID_BASE64' | 'INVALID_CONTAINER' | 'INVALID_SOURCE' | 'STAGING_UNAVAILABLE' | 'STAGING_CLEANUP_FAILED') { super(code); }
}
export interface ParsedReferenceSourceZip { preview: ReferenceSourceZipPreview; rawPack: string; pack: SourcePack }

const budget: ZipBudget = {
  maxEntries: 1, maxEntryBytes: MAX_REFERENCE_SOURCE_PACK_BYTES,
  maxTotalBytes: MAX_REFERENCE_SOURCE_PACK_BYTES, maxArchiveBytes: MAX_REFERENCE_SOURCE_ZIP_BYTES,
};
const entryName = (value: string): value is ReferenceSourceZipEntryName => value === 'catalog.json' || value === 'source.json';
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 原容器只在独占 staging 内暂存以复用中立 CRC/SHA/ZIP64 校验；成功与失败均清理。 */
export async function parseReferenceSourceZip(zipBase64: string, stagingRoot: string): Promise<ParsedReferenceSourceZip> {
  if (!isPreviewReferenceSourceZipRequest({ zipBase64 }) || !stagingRoot) throw new ReferenceSourceZipError('INVALID_BASE64');
  const bytes = Buffer.from(zipBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_REFERENCE_SOURCE_ZIP_BYTES || bytes.toString('base64') !== zipBase64)
    throw new ReferenceSourceZipError('INVALID_BASE64');
  try {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(stagingRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReferenceSourceZipError('STAGING_UNAVAILABLE');
  } catch { throw new ReferenceSourceZipError('STAGING_UNAVAILABLE'); }

  const directory = await mkdtemp(join(stagingRoot, 'source-pack-'));
  const path = join(directory, 'container.zip');
  let owned: { dev: number; ino: number } | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: ParsedReferenceSourceZip | undefined;
  let failure: unknown;
  try {
    handle = await open(path, 'wx+', 0o600);
    const stat = await handle.stat();
    owned = { dev: stat.dev, ino: stat.ino };
    await handle.writeFile(bytes);
    await handle.sync();
    let rawBytes: Buffer | undefined;
    const receipt = await readVerifiedZipEntries(handle, budget, new AbortController().signal, async (entry, chunks) => {
      if (entry.kind !== 'file' || !entryName(entry.name)) throw new ReferenceSourceZipError('INVALID_CONTAINER');
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > MAX_REFERENCE_SOURCE_PACK_BYTES) throw new ReferenceSourceZipError('INVALID_SOURCE');
        parts.push(chunk);
      }
      rawBytes = Buffer.concat(parts, size);
    });
    const entry = receipt.entries[0];
    if (receipt.entries.length !== 1 || !entry || !entryName(entry.name) || !rawBytes || rawBytes.length !== entry.size)
      throw new ReferenceSourceZipError('INVALID_CONTAINER');
    let rawPack: string;
    try { rawPack = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBytes); }
    catch { throw new ReferenceSourceZipError('INVALID_SOURCE'); }
    if (!Buffer.from(rawPack, 'utf8').equals(rawBytes)) throw new ReferenceSourceZipError('INVALID_SOURCE');
    const pack = parseReferenceSourcePack(rawPack);
    const items = pack && normalizeReferenceItems(pack.items);
    if (!pack || !items) throw new ReferenceSourceZipError('INVALID_SOURCE');
    const preview: ReferenceSourceZipPreview = {
      entryName: entry.name, zipSha256: receipt.sha256, zipBytes: receipt.size, rawPackHash: sha(rawBytes),
      bookId: pack.bookId, title: pack.title, sourceVersion: pack.sourceVersion, itemCount: items.length,
    };
    result = { preview, rawPack, pack };
  } catch (error) { failure = error; }
  finally {
    try {
      await handle?.close();
      if (owned) {
        const current = await lstat(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino)
          throw new ReferenceSourceZipError('STAGING_CLEANUP_FAILED');
        await unlink(path);
      }
      await rmdir(directory);
    } catch { throw new ReferenceSourceZipError('STAGING_CLEANUP_FAILED'); }
  }
  if (failure) {
    if (failure instanceof ReferenceSourceZipError) throw failure;
    throw new ReferenceSourceZipError('INVALID_CONTAINER');
  }
  return result!;
}
