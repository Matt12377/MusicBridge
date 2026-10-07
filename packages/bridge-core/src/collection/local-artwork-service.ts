import path from 'node:path';
import { createHash } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import type { DatasetProjectionPort } from './dataset-owner-protocol.js';
import { readonlySourceCandidateMetadata, sourceRootAvailability, withCheckedReadonlyMetadataSource, MetadataLeaseReleaseError, SourceFileError } from '../recording/source-files.js';
import { readLocalEmbeddedArtwork } from '../library/local-artwork-embedded-reader.js';

const hash = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
const commandPart = (command: string, part: string): string => { const h = hash(command + ':' + part); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
type Capture = { target: dto.LocalArtworkTarget; fileRevision: string; locationRevision: string; rootRevision: string; sourceRootId: string; relative: string; signature: string; audioRelative:string; audioSignature:string; sha256: string; expires: number };
/** 按需读取复用原低优先级许可；读取/解码不进入同步SQLite事务，不获取音频排他锁。 */
export function createLocalArtworkService(options: { repository: CollectionRepository; assertCurrent(): void; projection?: DatasetProjectionPort }) {
  const repository = options.repository, catalog = repository.localCatalog, store = repository.localArtwork;
  const captures = new Map<string,Capture>(), requests = new Map<string, { abort: AbortController; task: Promise<dto.LocalArtworkSourceCopies> }>();
  let closed = false, fatal = false;
  const check = (): void => { options.assertCurrent(); if (closed || fatal) throw new Error('封面读取已停止，现有选图保留。'); };
  function locator(target: dto.LocalArtworkTarget) {
    check(); store.assertTarget(target);
    const detail = catalog.trackDetail(target.trackId), found = catalog.privateAssetLocator(detail.asset.id), root = catalog.root(found.asset.libraryRootId), capability = repository.sources.root(root.sourceRootId);
    if (!capability || root.sourceRootId !== found.asset.sourceRootId || found.asset.rootRevision !== root.revision) throw new Error('封面来源许可已改变。');
    return { ...found, root, capability };
  }
  async function revalidate(capture: Capture): Promise<void> {
    const value = locator(capture.target);
    if (value.asset.fileRevision !== capture.fileRevision || value.asset.locationRevision !== capture.locationRevision || value.root.revision !== capture.rootRevision
      || value.capability.id !== capture.sourceRootId || await sourceRootAvailability(value.capability) !== 'ONLINE') throw new Error('原封面来源已改变，请重新查找；已保存手选与历史来源保留。');
    const audio = await readonlySourceCandidateMetadata(value.capability,capture.audioRelative); check();
    if (audio.signature !== capture.audioSignature) throw new Error('音频来源文件已改变，请重新查找；当前选择保留。');
    const now = await readonlySourceCandidateMetadata(value.capability, capture.relative); check();
    if (now.signature !== capture.signature) throw new Error('封面源文件已改变，请重新查找。');
  }
  async function read(target: dto.LocalArtworkTarget, signal: AbortSignal): Promise<dto.LocalArtworkSourceCopies> {
    const projection = options.projection;
    if (!projection) return { status: 'source-unavailable', items: [] };
    const acquired = await projection.call('scanReadAcquire', {});
    if (acquired.status !== 'granted') return { status: 'source-unavailable', items: [] };
    const abort = new AbortController(), forward = () => abort.abort(); signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) abort.abort();
    let leaseFailed = false, watchFailed = false, finished = false;
    const watch = (async () => { while (!finished) { const v = await projection.call('scanReadWatchRevocation', { permitId: acquired.permitId }); if (v.reason === 'renew') continue; if (v.reason !== 'permit-released') abort.abort(); break; } })().catch(() => { watchFailed = true; abort.abort(); });
    const items: dto.LocalArtworkSourceCopies['items'] = [];
    try {
      const value = locator(target), deadline = Date.now() + 10_000;
      const alive = (): void => { check(); store.assertTarget(target); if (abort.signal.aborted || Date.now() > deadline) throw new Error('封面查找已取消或达到时限。'); };
      if (await sourceRootAvailability(value.capability) !== 'ONLINE') return { status: 'source-unavailable', items: [] };
      const audioObserved = await readonlySourceCandidateMetadata(value.capability,value.relative); alive();
      for (const [key, entry] of captures) if (entry.expires <= Date.now()) captures.delete(key);
      let total = 0;
      const remember = (bytes: Uint8Array, relative: string, signature: string, origin: 'local-independent' | 'embedded', label: string, index: number): void => {
        alive(); if (!bytes.length || bytes.length > dto.LOCAL_ARTWORK_INPUT_BYTES || total + bytes.length > 8 * 1024 * 1024 || items.length >= 4) return;
        const sha256 = hash(bytes), sourceIdentity = hash(JSON.stringify([target.trackId, value.asset.id, value.asset.fileRevision, value.asset.locationRevision, value.root.revision, audioObserved.signature, relative, signature, index]));
        if (!captures.has(sourceIdentity) && captures.size >= 32) throw new Error('封面来源候选缓存已满，请稍后重新查找。');
        captures.set(sourceIdentity, { target, fileRevision: value.asset.fileRevision, locationRevision: value.asset.locationRevision, rootRevision: value.root.revision, sourceRootId: value.capability.id, relative, signature, audioRelative:value.relative, audioSignature:audioObserved.signature, sha256, expires: Date.now() + 10 * 60_000 });
        total += bytes.length; items.push({ origin, sourceIdentity, sourceLabel: label, base64: Buffer.from(bytes).toString('base64') });
      };
      for (const file of ['cover.jpg','cover.png','folder.jpg','folder.png','front.jpg','front.png']) {
        alive(); if (items.length >= 2) break;
        const relative = path.posix.join(path.posix.dirname(value.relative), file);
        try {
          const observed = await readonlySourceCandidateMetadata(value.capability, relative); alive();
          if (observed.size > dto.LOCAL_ARTWORK_INPUT_BYTES) continue;
          const bytes = await withCheckedReadonlyMetadataSource(value.capability, relative, observed.signature, abort.signal, async (fd,size) => {
            const b = Buffer.alloc(size); let offset = 0;
            while (offset < size) { alive(); const next = await fd.read(b,offset,Math.min(64 * 1024,size-offset),offset); alive(); if (!next.bytesRead) throw new Error('封面文件读取提前结束。'); offset += next.bytesRead; }
            return b;
          }, alive);
          remember(bytes, relative, observed.signature, 'local-independent', file, 0);
        } catch (error) { if (error instanceof SourceFileError && error.code === 'MISSING') continue; throw error; }
      }
      if (items.length < 4) {
        const observed = audioObserved; alive();
        try {
          const pictures = await withCheckedReadonlyMetadataSource(value.capability, value.relative, observed.signature, abort.signal,
            (fd,size) => readLocalEmbeddedArtwork(fd,size,abort.signal), alive);
          for (const picture of pictures) remember(picture.bytes, value.relative, observed.signature, 'embedded', `内嵌图片 ${picture.pictureIndex + 1}`, picture.pictureIndex);
        } catch (error) { if (error instanceof MetadataLeaseReleaseError || abort.signal.aborted) throw error; /* 不支持/坏标签不妨碍已读取的独立图与手选。 */ }
      }
      for (const item of items) await revalidate(captures.get(item.sourceIdentity)!);
      // 成功读取但没有图片属于缺图；来源不可用只用于许可/可读性未满足。
      alive(); return { status: 'ready', items };
    } catch (error) { if (error instanceof MetadataLeaseReleaseError) { fatal = true; leaseFailed = true; } throw error; }
    finally {
      finished = true; signal.removeEventListener('abort',forward);
      if (!leaseFailed) { await projection.call('scanReadRelease', { permitId: acquired.permitId }); await watch; if (watchFailed) { fatal = true; throw new Error('封面只读许可收口未确认。'); } }
      else void watch;
    }
  }
  return {
    context(request: dto.LocalArtworkCommandPayloads['localArtwork.context']) { check(); return store.context(request); },
    async apply(request: dto.ApplyLocalArtworkSelection) {
      check(); if (!dto.isApplyLocalArtworkSelection(request)) throw new Error('封面应用请求无效。');
      if (store.hasReceipt(request.commandId)) return store.apply(request);
      store.assertTarget(request.target);
      const view = store.context({trackId:request.target.trackId,editionId:request.target.editionId});
      const chosen = request.candidateId ? store.inspectCandidate(request.target.editionId,request.candidateId) : view.candidates.find(c=>c.origin==='local-independent') ?? view.candidates.find(c=>c.origin==='embedded');
      if (chosen && chosen.origin !== 'manual' && chosen.origin !== 'provider') { const capture = captures.get(chosen.sourceIdentity); if (!capture || capture.expires <= Date.now()) throw new Error('封面来源需重新查找核对，已保存选择保留。'); await revalidate(capture); }
      check(); return store.apply(request);
    },
    async stage(request: dto.LocalArtworkCommandPayloads['localArtwork.stage']) {
      check(); if (!dto.isLocalArtworkCommandPayload('localArtwork.stage',request)) throw new Error('封面候选请求无效。');
      if (request.origin !== 'manual' && request.origin !== 'provider') { const capture = captures.get(request.sourceIdentity); if (!capture || capture.expires <= Date.now() || capture.target.trackId !== request.target.trackId || capture.target.editionId !== request.target.editionId || capture.target.expectedSourceRevision !== request.target.expectedSourceRevision || capture.sha256 !== request.image.original.sha256) throw new Error('封面来源候选已失效。'); await revalidate(capture); check(); }
      return store.stage(request);
    },
    createEdition(request: dto.CreateLocalArtworkEdition): dto.AlbumEdition {
      check(); if (!dto.isCreateLocalArtworkEdition(request)) throw new Error('建立独立发行请求无效。');
      const receipt = store.prepareEdition(request); if (receipt) return receipt;
      const createId = commandPart(request.commandId,'create'), linkId = commandPart(request.commandId,'link');
      const old = catalog.privateReceiptRequest(createId), link = catalog.privateReceiptRequest(linkId);
      if (old && (old.operation !== 'create-edition' || old.request.title !== request.title || old.request.edition !== '' || !dto.isAlbumEdition(old.result))) throw new Error('同一操作编号不能改变独立发行请求。');
      if (link && (link.operation !== 'link-edition-track' || link.request.trackId !== request.trackId)) throw new Error('同一操作编号不能绑定其他曲目。');
      if (old && link) return store.completeEdition(request,old.result as dto.AlbumEdition);
      if (catalog.track(request.trackId).selectionRevision !== request.expectedTrackRevision) throw new Error('曲目来源已改变，请重新建立独立发行。');
      const edition = old ? old.result as dto.AlbumEdition : catalog.createEdition({ commandId:createId,title:request.title,edition:'' });
      catalog.linkEditionTrack({ commandId:linkId,editionId:edition.id,trackId:request.trackId,disc:1,trackNumber:1,sequence:1 }); return store.completeEdition(request,edition);
    },
    readCandidates(request: dto.LocalArtworkCommandPayloads['localArtwork.readCandidates']): Promise<dto.LocalArtworkSourceCopies> {
      check(); if (!dto.isLocalArtworkCommandPayload('localArtwork.readCandidates',request) || requests.has(request.lookupId) || requests.size >= 4) throw new Error('封面读取物理请求已满或逻辑身份无效。');
      const abort = new AbortController(), task = read(request.target,abort.signal).finally(() => { requests.delete(request.lookupId); });
      requests.set(request.lookupId,{abort,task}); return task;
    },
    cancelLookup(id: string) { check(); const entry = requests.get(id); entry?.abort.abort(); return { cancelled: !!entry }; },
    async close() { closed = true; for (const entry of requests.values()) entry.abort.abort(); await Promise.allSettled([...requests.values()].map(v=>v.task)); if (fatal) throw new Error('封面资源关闭未确认，工作库连接保留。'); captures.clear(); },
  };
}
export type LocalArtworkService = ReturnType<typeof createLocalArtworkService>;
