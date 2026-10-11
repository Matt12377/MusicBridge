import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { mobileContentRequestSnapshot, mobileContentResponseSnapshot, mobileTrackSelectionEquals } from '@music-bridge/contracts';
import type { LocalLibraryTrackDetail, MobileLyricsContent, MobileLyricLine, MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import { captureLocalFactsByIdentityReadonly, LocalSourcePreparationError } from '../application/local-source-resolver.js';
import type { LocalSourceFacts } from '../application/local-source-facts.js';
import type { CollectionRepository } from '../collection/repository.js';
import {
  openLocalPlaybackReadonlySource, readonlySourceCandidateMetadata, SourceFileError,
  withCheckedReadonlyMetadataSource,
} from '../recording/source-files.js';
import { MobileServiceError } from './types.js';

export const MOBILE_LOCAL_LYRICS_MAX_SOURCE_BYTES = 1024 * 1024;
const maxLines = 2000, maxLineBytes = 4096, maxReadMs = 10_000;
const sourceChanged = (): never => { throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
const unavailable = (): never => { throw new MobileServiceError(503, 'BUSY'); };
const limited = (): never => { throw new MobileServiceError(503, 'CONTENT_LIMIT_EXCEEDED'); };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const digest = (v: Uint8Array | string): string => createHash('sha256').update(v).digest('hex');
function directoryAxes(s: BigIntStats): string {
  return [s.dev, s.ino, s.birthtimeNs, s.mode, s.uid, s.gid].join(':');
}
export interface MobileLocalLyricsSnapshot {
  lyrics: MobileLyricsContent;
  /** 私有闭包重新读取完整 sidecar 与媒体事实，不经 IPC 序列化。 */
  beforeSend(): Promise<void>;
}

/** 原授权目录中精确版本的同 stem .lrc，只读、不模糊匹配、不搜索 Provider。 */
export function createMobileContentLocalLyrics(options: {
  collection: CollectionRepository; datasetId: string; assertCurrent(): void;
}) {
  const { collection, datasetId, assertCurrent } = options;
  function facts(selection: MobileTrackSelection, detail: LocalLibraryTrackDetail): LocalSourceFacts {
    assertCurrent();
    const captured = mobileContentRequestSnapshot('favoriteTrackSelection', selection);
    if (!captured.ok) return unavailable();
    selection = captured.value; const parts = selection.trackId.split(':');
    if (selection.source !== 'local' || parts.length !== 4 || parts[0] !== 'lt' || parts[1] !== datasetId
      || parts[2] !== detail.track.id || !detail.editions.some(e => e.id === parts[3]) || detail.track.segment !== null) return unavailable();
    const original = collection.localCatalog.trackDetail(detail.track.id);
    if (!same(original.track, detail.track) || !same(original.asset, detail.asset)
      || !original.editions.some(e => e.id === parts[3])) return sourceChanged();
    const identity = digest(JSON.stringify([datasetId, original.asset.id, original.asset.fileRevision,
      original.track.selectionRevision, original.track.segment]));
    if (selection.versionId !== `lv:${identity}` || selection.contentRevision !== `lc:${identity}`) return sourceChanged();
    const value = captureLocalFactsByIdentityReadonly({ local_track_id: detail.track.id, asset_id: detail.asset.id,
      expected_asset_revision: detail.asset.fileRevision }, collection);
    if (!value.observation || value.root.role !== 'library' || !value.sourceRoot.authorized) return unavailable();
    assertCurrent(); return value;
  }
  /** 不调用旧 parser 的 slice/坏行跳过分支；完整正文超界或混合坏行整体失败。 */
  function parse(text: string, selection: MobileTrackSelection, wholeHash: string): MobileLyricsContent {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return unavailable();
    const rawLines = text.split(/\r\n|\n|\r/u), rows: MobileLyricLine[] = [];
    let timed: boolean | undefined;
    const pattern = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/u;
    for (const raw of rawLines) {
      const line = raw.trim(); if (!line) continue;
      // 已知 LRC 元数据是完整独立行；不把未知 bracket 或坏时间戳当作 missing。
      if (/^\[(?:ar|al|ti|au|by|re|ve):[^\]\r\n]*\]$/iu.test(line)) continue;
      const starts: number[] = []; let remaining = line;
      for (;;) {
        const match = pattern.exec(remaining); if (!match) break;
        const minutes = Number(match[1]), seconds = Number(match[2]);
        const fraction = Number((match[3] ?? '').padEnd(3, '0'));
        const start = minutes * 60_000 + seconds * 1000 + fraction;
        if (seconds >= 60 || !Number.isSafeInteger(start) || start > 24 * 60 * 60 * 1000) return unavailable();
        starts.push(start); remaining = remaining.slice(match[0].length);
      }
      const isTimed = starts.length > 0;
      if (timed !== undefined && timed !== isTimed || !isTimed && line.startsWith('[')) return unavailable();
      timed = isTimed;
      const body = remaining.trim();
      if (!body || Buffer.byteLength(body, 'utf8') > maxLineBytes) return body ? limited() : unavailable();
      if (rows.length + (starts.length || 1) > maxLines) return limited();
      if (isTimed) for (const startMs of starts) rows.push({ id: `line:${rows.length}`, text: body, startMs });
      else rows.push({ id: `line:${rows.length}`, text: body });
    }
    if (!rows.length) return unavailable();
    if (timed) rows.sort((a, b) => a.startMs! - b.startMs!);
    const result = mobileContentResponseSnapshot('lyrics', { ...selection, status: 'ready',
      lyricRevision: `ll:${digest(JSON.stringify([selection, wholeHash]))}`, synchronized: timed === true, lines: rows });
    if (!result.ok) return limited(); return result.value;
  }
  async function readOnce(selection: MobileTrackSelection, track: MobileTrack, detail: LocalLibraryTrackDetail,
    signal: AbortSignal): Promise<{ lyrics: MobileLyricsContent; factsHash: string; sidecarHash: string | null }> {
    const started = Date.now(), handles: { name: string; handle: FileHandle; identity: string }[] = [];
    const check = (): void => {
      assertCurrent(); if (signal.aborted || Date.now() - started > maxReadMs) return unavailable();
    };
    let media: Awaited<ReturnType<typeof openLocalPlaybackReadonlySource>> | undefined;
    try {
      check();
      if (!mobileTrackSelectionEquals(selection, { trackId: track.id, source: track.source,
        versionId: track.versionId, contentRevision: track.contentRevision })) return sourceChanged();
      const before = facts(selection, detail), root = before.sourceRoot;
      if (!before.observation || path.isAbsolute(before.relative) || before.relative.split(/[\\/]/u).some(p => !p || p === '.' || p === '..')) return unavailable();
      const parts = before.relative.split(path.sep), filename = parts.pop()!, parsed = path.parse(filename);
      if (!parsed.name || !parsed.ext) return unavailable();
      let name = root.path;
      for (const part of [null, ...parts]) {
        if (part !== null) name = path.join(name, part);
        check(); const named = await lstat(name, { bigint: true });
        if (!named.isDirectory() || named.isSymbolicLink() || await realpath(name) !== name
          || part === null && (String(named.dev) !== root.dev || String(named.ino) !== root.ino)) return sourceChanged();
        const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
        handles.push({ name, handle, identity: directoryAxes(named) });
        if (directoryAxes(await handle.stat({ bigint: true })) !== directoryAxes(named)) return sourceChanged();
      }
      const verifyDirectories = async (): Promise<void> => {
        for (const directory of handles) {
          check(); const fd = await directory.handle.stat({ bigint: true }), named = await lstat(directory.name, { bigint: true });
          if (!named.isDirectory() || named.isSymbolicLink() || directoryAxes(fd) !== directory.identity
            || directoryAxes(named) !== directory.identity || await realpath(directory.name) !== directory.name) return sourceChanged();
        }
      };
      media = await openLocalPlaybackReadonlySource(root, before.relative, before.observation.signature);
      check(); await media.verify();
      const relative = path.join(...parts, parsed.name + '.lrc');
      let sidecarHash: string | null = null, lyrics: MobileLyricsContent;
      let metadata: Awaited<ReturnType<typeof readonlySourceCandidateMetadata>> | undefined;
      try { metadata = await readonlySourceCandidateMetadata(root, relative); }
      catch (error) { if (!(error instanceof SourceFileError) || error.code !== 'MISSING') throw error; }
      if (metadata === undefined) {
        // 只在全部已授权父目录实际可读、媒体当前且精确文件确实缺失时返回 missing。
        await verifyDirectories(); await media.verify(); check();
        try { await lstat(path.join(root.path, relative)); return sourceChanged(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        lyrics = { ...selection, status: 'missing', synchronized: false, lines: [] };
      } else {
        if (metadata.size < 1) return unavailable();
        if (metadata.size > MOBILE_LOCAL_LYRICS_MAX_SOURCE_BYTES) return limited();
        const bytes = await withCheckedReadonlyMetadataSource(root, relative, metadata.signature, signal, async (fd, size) => {
          if (size !== metadata!.size || size > MOBILE_LOCAL_LYRICS_MAX_SOURCE_BYTES) return sourceChanged();
          const result = Buffer.alloc(size); let offset = 0;
          while (offset < size) {
            check(); const read = await fd.read(result, offset, Math.min(65536, size - offset), offset);
            if (!read.bytesRead) return unavailable(); offset += read.bytesRead;
          }
          const extra = Buffer.alloc(1); if ((await fd.read(extra, 0, 1, size)).bytesRead !== 0) return sourceChanged();
          check(); return result;
        }, check);
        sidecarHash = digest(bytes);
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return unavailable(); }
        lyrics = parse(text, selection, sidecarHash);
      }
      await verifyDirectories(); await media.verify();
      const after = facts(selection, detail); if (!same(before, after)) return sourceChanged();
      check(); return { lyrics, sidecarHash, factsHash: digest(JSON.stringify(before)) };
    } catch (error) {
      if (error instanceof MobileServiceError) throw error;
      if (error instanceof SourceFileError && error.code === 'CONTENT_CHANGED') return sourceChanged();
      if (error instanceof LocalSourcePreparationError && error.code === 'FACTS_CHANGED') return sourceChanged();
      return unavailable();
    } finally {
      const failures: unknown[] = [];
      try { await media?.close(); } catch (error) { failures.push(error); }
      for (const directory of [...handles].reverse()) try { await directory.handle.close(); } catch (error) { failures.push(error); }
      if (failures.length) return unavailable();
    }
  }
  return {
    async read(selection: MobileTrackSelection, track: MobileTrack, detail: LocalLibraryTrackDetail,
      signal: AbortSignal): Promise<MobileLocalLyricsSnapshot> {
      const captured = mobileContentRequestSnapshot('favoriteTrackSelection', selection);
      if (!captured.ok) return unavailable(); selection = Object.freeze(captured.value);
      const original = await readOnce(selection, track, detail, signal);
      return { lyrics: original.lyrics, async beforeSend() {
        const current = await readOnce(selection, track, detail, signal);
        if (current.factsHash !== original.factsHash || current.sidecarHash !== original.sidecarHash
          || !same(current.lyrics, original.lyrics)) return sourceChanged();
      } };
    },
  };
}
