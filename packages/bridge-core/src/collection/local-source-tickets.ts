import type { LyricsSnapshot } from '@music-bridge/contracts';
import { emptyLyricsSnapshot } from '../netease/lyrics.js';
import { readLocalPlaybackLyrics } from '../library/local-playback-lyrics.js';
import { MetadataLeaseReleaseError } from '../recording/source-files.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isFileAudioParameters, type LocalPlayRequest } from '@music-bridge/contracts';
import { captureLocalFactsReadonly, captureLocalFactsByIdentityReadonly, type LocalFactSelection } from '../application/local-source-resolver.js';
import type { CollectionRepository } from './repository.js';
import { LocalFactsFenceBusy, LocalSourceFence } from '../stream/local-source-fence.js';
import { isLocalSourceCaptureResult, type LocalSourceCaptureResult } from './local-source-ticket-types.js';

/** 全部读取使用Owner原连接；票据退休永久生效，不使用全库修改戳。 */
export function createLocalSourceTickets(repository: CollectionRepository, epoch: string, datasetId: string, assertOpen: () => void) {
  type Selection = { kind: 'roon'; value: LocalPlayRequest } | { kind: 'mobile'; value: LocalFactSelection };
  const tickets = new Map<string, { selection: Selection; result: LocalSourceCaptureResult; fence: LocalSourceFence }>();
  const lyricReads = new Map<string, { controller: AbortController; promise: Promise<LyricsSnapshot> }>();
  let lyricCloseFailure: MetadataLeaseReleaseError | undefined;
  let closed = false;
  const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const read = (selection: Selection) => selection.kind === 'roon' ? captureLocalFactsReadonly(selection.value,repository)
    : captureLocalFactsByIdentityReadonly(selection.value,repository);
  function matches(ticket: { selection: Selection; result: LocalSourceCaptureResult }): boolean {
    try { return same(read(ticket.selection),ticket.result.facts); } catch { return false; }
  }
  function beforeCommit(): void {
    const busy: LocalSourceFence[] = [];
    for (const ticket of tickets.values()) {
      if (!ticket.fence.current && ticket.fence.references === 0) continue;
      if (!matches(ticket)) { ticket.fence.revoke(); if (ticket.fence.references !== 0) busy.push(ticket.fence); }
    }
    if (busy.length) throw new LocalFactsFenceBusy(busy);
  }
  repository.privateInstallLocalFactsFence(beforeCommit,()=>{closed=true;for(const ticket of tickets.values())ticket.fence.revoke();});
  function capture(selection: Selection): LocalSourceCaptureResult {
      assertOpen(); if (closed || tickets.size >= 16) throw new Error('本地事实票据关闭或达到有限容量。');
      const facts = read(selection), effective = repository.localCatalog.metadata(facts.track.id).effective;
      const current = repository.localScan.privateCurrentFileState(facts.root.id, facts.relative)?.value;
      const technical = current?.outcome === 'accepted' && current.signature === facts.observation?.signature
        && current.assetId === facts.asset.id && current.trackId === facts.track.id ? current.readFacts?.technical : undefined;
      const parameters = technical ? { container: technical.container, codec: technical.codec, lossless: technical.lossless, sampleRateHz: technical.sampleRateHz,
        channels: technical.channels, bitsPerSample: technical.bitsPerSample, durationMs: technical.durationSeconds === null ? null : Math.round(technical.durationSeconds * 1000), evidence: technical.evidence } : undefined;
      const fileParameters = isFileAudioParameters(parameters) ? parameters : undefined;
      const fence = LocalSourceFence.create(), result: LocalSourceCaptureResult = {
        ticketId: randomUUID(), epoch, datasetId, buffer: fence.buffer, facts,
        metadata: { id: facts.track.id, title: effective.title || path.basename(facts.relative,path.extname(facts.relative)), artists: effective.artist ? [effective.artist] : [], album: effective.album || '',
          ...(fileParameters?.durationMs !== undefined && fileParameters.durationMs !== null ? { durationMs: fileParameters.durationMs } : {}) },
        format: path.extname(facts.relative).slice(1).toLowerCase(),
        ...(fileParameters ? {fileParameters} : {}),
      };
      if (!isLocalSourceCaptureResult(result)) { fence.revoke(); throw new Error('本地捕获事实不符合私有读取合同。'); }
      tickets.set(result.ticketId,{selection:structuredClone(selection), result:structuredClone(result),fence}); return result;
  }
  return {
    capture: (selection: LocalPlayRequest) => capture({ kind: 'roon', value: selection }),
    captureMobile: (selection: LocalFactSelection) => capture({ kind: 'mobile', value: selection }),
    revalidate(ticketId: string): boolean {
      assertOpen(); const ticket = tickets.get(ticketId); if (!ticket || closed || !ticket.fence.current) return false;
      if (!matches(ticket)) ticket.fence.revoke(); return ticket.fence.current;
    },
    readLyrics(ticketId: string): Promise<LyricsSnapshot> {
      const existing = lyricReads.get(ticketId); if (existing) return existing.promise;
      assertOpen(); const ticket = tickets.get(ticketId);
      if (closed || lyricCloseFailure || !ticket || ticket.selection.kind !== 'roon' || !ticket.fence.current || !matches(ticket) || lyricReads.size >= 2)
        return Promise.resolve(emptyLyricsSnapshot('unavailable'));
      const release = ticket.fence.retain(), controller = new AbortController();
      const current = (): void => { assertOpen(); if (closed || controller.signal.aborted || tickets.get(ticketId) !== ticket || !ticket.fence.current || !matches(ticket)) throw new Error('原播放歌词ticket已失效。'); };
      let quiet = true;
      const promise = Promise.resolve().then(() => readLocalPlaybackLyrics(ticket.result.facts, controller.signal, current)).catch(error => {
        if (error instanceof MetadataLeaseReleaseError) { quiet = false; lyricCloseFailure = error; }
        throw error;
      }).finally(() => { lyricReads.delete(ticketId); if (quiet) release(); });
      lyricReads.set(ticketId, { controller, promise }); return promise;
    },
    async joinLyrics(): Promise<void> { await Promise.allSettled([...lyricReads.values()].map(read => read.promise)); if (lyricCloseFailure) throw lyricCloseFailure; },
    release(ticketId: string): void { const ticket = tickets.get(ticketId); if (!ticket) return; ticket.fence.revoke(); ticket.fence.assertQuiet(); tickets.delete(ticketId); },
    seal(): void { closed = true; for (const ticket of tickets.values()) ticket.fence.revoke(); for (const read of lyricReads.values()) read.controller.abort(); },
    get size() { return tickets.size; },
  };
}
