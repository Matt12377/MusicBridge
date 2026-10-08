import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { readonlySourceCandidateMetadata, withCheckedReadonlyMetadataSource, type RootCapability } from '../recording/source-files.js';
import { relocationFail, relocationHash } from './local-relocation-journal.js';
import { checkRelocationIo, type RelocationIoOptions } from './source-relocation-verify.js';

export interface RelocationPrimaryFile {
  operationId: string; resourceId: string; assetId: string; sourceRoot: RootCapability; sourceRelative: string;
  targetRoot: RootCapability; targetRelative: string;
}
export interface RelocationDirectoryMember { assetId: string; sourceRootId: string; relative: string }
export interface RelocationCompanionDraft {
  resourceId: string; role: dto.LocalRelocationResourceRole; sourceRoot: RootCapability; sourceRelative: string;
  targetRoot: RootCapability; targetRelative: string; operationIds: string[]; sharedMemberIds: string[];
  action: 'move' | 'copy-retain' | 'retain' | 'rewrite-reference'; rewrittenBytes: Buffer | null;
}
export interface RelocationCompanionClosure {
  complete: true; companions: RelocationCompanionDraft[]; edges: dto.LocalRelocationReferenceEdge[];
  inventories: readonly { sourceRootId: string; directory: string; fingerprint: string }[];
}
const audioExtension = /\.(?:flac|mp3|m4a|mp4|wav|wave|aiff|aif|alac|ogg|opus|ape|wv)$/iu;
const lyricExtension = /\.(?:lrc|srt|lyrics|txt)$/iu;
const imageExtension = /\.(?:jpg|jpeg|png|webp|gif|bmp|tif|tiff)$/iu;
const manifestExtension = /\.(?:m3u|m3u8)$/iu;
const stem = (relative: string): string => path.posix.basename(relative, path.posix.extname(relative));
const sourceKey = (rootId: string, relative: string): string => `${rootId}\0${relative}`;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function readReferenceText(root: RootCapability, relative: string, options: RelocationIoOptions): Promise<string> {
  checkRelocationIo(options);
  const metadata = await readonlySourceCandidateMetadata(root, relative);
  return withCheckedReadonlyMetadataSource(root, relative, metadata.signature, options.signal ?? new AbortController().signal, async (handle, bytes) => {
    if (bytes > dto.LOCAL_RELOCATION_PLAN_BUDGET.allTextBytes) return relocationFail('OVER_BUDGET');
    const buffer = Buffer.alloc(bytes); let at = 0;
    while (at < bytes) {
      checkRelocationIo(options); const read = await handle.read(buffer, at, bytes - at, at);
      if (!read.bytesRead) return relocationFail('SOURCE_CHANGED'); at += read.bytesRead;
    }
    try { return decoder.decode(buffer); } catch { return relocationFail('UNKNOWN_REFERENCE'); }
  });
}
/** 真目录闭集，不按大小写或Unicode合并名字；目录变化和任何未认证引用都要求重新预览。 */
export async function observeRelocationCompanions(primaries: readonly RelocationPrimaryFile[], members: readonly RelocationDirectoryMember[],
  options: RelocationIoOptions = {}): Promise<RelocationCompanionClosure> {
  if (!primaries.length || primaries.length > dto.LOCAL_RELOCATION_PLAN_BUDGET.operations) return relocationFail('OVER_BUDGET');
  const bySource = new Map(primaries.map(value => [sourceKey(value.sourceRoot.id, value.sourceRelative), value]));
  if (bySource.size !== primaries.length) return relocationFail('CLOSURE_INCOMPLETE');
  const directories = new Map<string, { root: RootCapability; directory: string; selected: RelocationPrimaryFile[] }>();
  for (const primary of primaries) {
    const directory = path.posix.dirname(primary.sourceRelative), key = sourceKey(primary.sourceRoot.id, directory);
    const entry = directories.get(key) ?? { root: primary.sourceRoot, directory, selected: [] }; entry.selected.push(primary); directories.set(key, entry);
  }
  const companions = new Map<string, RelocationCompanionDraft>(), edges: dto.LocalRelocationReferenceEdge[] = [], inventories: { sourceRootId: string; directory: string; fingerprint: string }[] = [];
  let allNameBytes = 0, allEntries = 0;
  const add = (draft: RelocationCompanionDraft, referenced: readonly RelocationPrimaryFile[], kind: dto.LocalRelocationReferenceKind): void => {
    const key = sourceKey(draft.sourceRoot.id, draft.sourceRelative), previous = companions.get(key);
    if (previous && (previous.targetRoot.id !== draft.targetRoot.id || previous.targetRelative !== draft.targetRelative || previous.action !== draft.action)) return relocationFail('SHARED_REFERENCE');
    if (!previous) companions.set(key, draft);
    const selected = companions.get(key)!;
    for (const primary of referenced) {
      if (!selected.operationIds.includes(primary.operationId)) selected.operationIds.push(primary.operationId);
      if (!edges.some(edge => edge.fromResourceId === selected.resourceId && edge.toResourceId === primary.resourceId && edge.kind === kind)) edges.push({ edgeId: randomUUID(), fromResourceId: selected.resourceId,
        toResourceId: primary.resourceId, kind, shared: selected.sharedMemberIds.length > 1 });
    }
    if (primaries.length + companions.size > dto.LOCAL_RELOCATION_PLAN_BUDGET.closedResources || edges.length > dto.LOCAL_RELOCATION_PLAN_BUDGET.referenceEdges) relocationFail('OVER_BUDGET');
  };
  for (const group of directories.values()) {
    checkRelocationIo(options);
    const absolute = path.join(group.root.path, group.directory), before = await lstat(absolute, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return relocationFail('SYMLINK');
    const inventory: { name: string; signature: string; kind: 'file' | 'directory' | 'other' }[] = [];
    const directory = await opendir(absolute);
    for await (const entry of directory) {
      checkRelocationIo(options); allNameBytes += Buffer.byteLength(entry.name, 'utf8');
      if (++allEntries > dto.LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes || allNameBytes > dto.LOCAL_RELOCATION_PLAN_BUDGET.allTextBytes) return relocationFail('OVER_BUDGET');
      const info = await lstat(path.join(absolute, entry.name), { bigint: true });
      if (info.isSymbolicLink()) return relocationFail('UNKNOWN_REFERENCE');
      inventory.push({ name: entry.name, signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' });
    }
    inventory.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const peers = members.filter(value => value.sourceRootId === group.root.id && path.posix.dirname(value.relative) === group.directory);
    for (const entry of inventory) {
      const relative = path.posix.join(group.directory, entry.name);
      if (entry.kind !== 'file') continue;
      if (audioExtension.test(entry.name)) {
        if (!peers.some(value => value.relative === relative) && !bySource.has(sourceKey(group.root.id, relative))) return relocationFail('CLOSURE_INCOMPLETE');
        continue;
      }
      const matching = group.selected.filter(value => stem(value.sourceRelative) === stem(entry.name));
      if (/\.cue$/iu.test(entry.name) || manifestExtension.test(entry.name)) {
        const cue = /\.cue$/iu.test(entry.name), text = await readReferenceText(group.root, relative, options), referenced: RelocationPrimaryFile[] = [];
        const references: { old: string; replacement: string }[] = [];
        if (cue) {
          const declared = [...text.matchAll(/^[\t \uFEFF]*FILE[\t ]+"([^"\r\n]+)"[\t ]+[A-Za-z0-9]+[\t ]*\r?$/gmu)];
          if (!declared.length || [...text.matchAll(/^[\t \uFEFF]*FILE\b/gmu)].length !== declared.length) return relocationFail('UNKNOWN_REFERENCE');
          for (const match of declared) {
            const name = match[1]!;
            if (!dto.isLocalRelocationRelative(name, false)) return relocationFail('UNKNOWN_REFERENCE');
            const sourceRelative = path.posix.join(group.directory, name), primary = bySource.get(sourceKey(group.root.id, sourceRelative));
            if (!primary) return relocationFail('SHARED_REFERENCE');
            if (path.posix.dirname(primary.targetRelative) !== path.posix.dirname(group.selected[0]!.targetRelative)
              || primary.targetRoot.id !== group.selected[0]!.targetRoot.id) return relocationFail('SHARED_REFERENCE');
            const replacement = path.posix.basename(primary.targetRelative); if (replacement.includes('"')) return relocationFail('UNKNOWN_REFERENCE');
            references.push({ old: name, replacement }); if (!referenced.includes(primary)) referenced.push(primary);
          }
        } else {
          for (const line of text.split(/\r\n|\n|\r/u)) {
            if (!line || line.startsWith('#') || line === '\uFEFF') continue;
            const name = line.startsWith('\uFEFF') ? line.slice(1) : line;
            if (!dto.isLocalRelocationRelative(name, false)) return relocationFail('UNKNOWN_REFERENCE');
            const primary = bySource.get(sourceKey(group.root.id, path.posix.join(group.directory, name)));
            if (!primary) return relocationFail('SHARED_REFERENCE');
            if (primary.targetRoot.id !== group.selected[0]!.targetRoot.id || path.posix.dirname(primary.targetRelative) !== path.posix.dirname(group.selected[0]!.targetRelative)) return relocationFail('SHARED_REFERENCE');
            references.push({ old: name, replacement: path.posix.basename(primary.targetRelative) }); if (!referenced.includes(primary)) referenced.push(primary);
          }
          if (!references.length) return relocationFail('UNKNOWN_REFERENCE');
        }
        const lead = referenced[0]!, targetDirectory = path.posix.dirname(lead.targetRelative);
        const targetName = matching.length === 1 && referenced.length === 1 ? `${stem(lead.targetRelative)}${path.posix.extname(entry.name)}` : entry.name;
        const rewritten = cue ? text.replace(/(^[\t \uFEFF]*FILE[\t ]+")([^"\r\n]+)("[\t ]+[A-Za-z0-9]+[\t ]*\r?$)/gmu,
          (_whole, prefix: string, name: string, suffix: string) => `${prefix}${references.find(value => value.old === name)!.replacement}${suffix}`)
          : text.replace(/[^\r\n]+/gu, line => {
            const bom = line.startsWith('\uFEFF') ? '\uFEFF' : '', name = bom ? line.slice(1) : line;
            return references.some(value => value.old === name) ? `${bom}${references.find(value => value.old === name)!.replacement}` : line;
          });
        const targetRelative = path.posix.join(targetDirectory, targetName), unchanged = lead.targetRoot.id === group.root.id && targetRelative === relative;
        if (unchanged && rewritten !== text) return relocationFail('SHARED_REFERENCE');
        add({ resourceId: randomUUID(), role: cue ? 'CUE' : 'MANIFEST', sourceRoot: group.root, sourceRelative: relative, targetRoot: lead.targetRoot, targetRelative,
          operationIds: referenced.map(value => value.operationId), sharedMemberIds: referenced.length > 1 ? referenced.map(value => value.assetId) : [],
          action: unchanged ? 'retain' : rewritten === text ? 'copy-retain' : 'rewrite-reference', rewrittenBytes: rewritten === text ? null : Buffer.from(rewritten, 'utf8') }, referenced, cue ? 'CUE_AUDIO' : 'MANIFEST');
      } else if (lyricExtension.test(entry.name) && matching.length || imageExtension.test(entry.name)) {
        const isImage = imageExtension.test(entry.name), references = matching.length ? matching : group.selected, lead = references[0]!;
        const sharedMembers = matching.length ? peers.filter(value => stem(value.relative) === stem(entry.name)) : peers;
        const targetName = matching.length === 1 ? `${stem(lead.targetRelative)}${path.posix.extname(entry.name)}` : entry.name;
        const targetRelative = path.posix.join(path.posix.dirname(lead.targetRelative), targetName), unchanged = lead.targetRoot.id === group.root.id && targetRelative === relative;
        if (references.some(value => value.targetRoot.id !== lead.targetRoot.id || path.posix.dirname(value.targetRelative) !== path.posix.dirname(lead.targetRelative))) return relocationFail('SHARED_REFERENCE');
        add({ resourceId: randomUUID(), role: !isImage ? 'LYRIC' : matching.length ? 'IMAGE' : 'DIRECTORY_SHARED_COVER', sourceRoot: group.root, sourceRelative: relative,
          targetRoot: lead.targetRoot, targetRelative, operationIds: references.map(value => value.operationId), sharedMemberIds: sharedMembers.length > 1 ? sharedMembers.map(value => value.assetId) : [],
          action: unchanged ? 'retain' : 'copy-retain', rewrittenBytes: null }, references, !isImage ? 'LYRIC_AUDIO' : matching.length ? 'IMAGE_AUDIO' : 'DIRECTORY_COVER');
      } else if (matching.length || group.selected.some(value => entry.name.startsWith(`${stem(value.sourceRelative)}.`))) return relocationFail('UNKNOWN_REFERENCE');
    }
    const after = await lstat(absolute, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return relocationFail('SOURCE_CHANGED');
    inventories.push({ sourceRootId: group.root.id, directory: group.directory, fingerprint: relocationHash(inventory) });
  }
  return { complete: true, companions: [...companions.values()], edges, inventories };
}
