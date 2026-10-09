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
      const fence = LocalSourceFence.create(), result: LocalSourceCaptureResult = {
        ticketId: randomUUID(), epoch, datasetId, buffer: fence.buffer, facts,
        metadata: { id: facts.track.id, title: effective.title || path.basename(facts.relative,path.extname(facts.relative)), artists: effective.artist ? [effective.artist] : [], album: effective.album || '' },
        format: path.extname(facts.relative).slice(1).toLowerCase(),
        ...(isFileAudioParameters(parameters) ? {fileParameters:parameters} : {}),
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
    release(ticketId: string): void { const ticket = tickets.get(ticketId); if (!ticket) return; ticket.fence.revoke(); ticket.fence.assertQuiet(); tickets.delete(ticketId); },
    seal(): void { closed = true; for (const ticket of tickets.values()) ticket.fence.revoke(); },
    get size() { return tickets.size; },
  };
}
