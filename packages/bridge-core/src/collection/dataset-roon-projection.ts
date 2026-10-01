import { randomUUID } from 'node:crypto';
import { isDigitalAlbumMetadata, isDraftTrackMetadata } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { RoonPublicLibrary } from '../roon/public-library.js';
import {
  isDatasetProjectionPayload,
  type DatasetOwnerProjectionHandler,
  type DatasetProjectionCommand,
  type DatasetProjectionCommandPayloads,
} from './dataset-owner-protocol.js';

interface ProjectionTicket {
  epoch: string;
  scope: string;
  source: RoonPublicLibrary;
  permitId?: string;
}
const invalid = (): never => { throw new BridgeError('BAD_REQUEST', '数据集元数据投影请求无效。', { httpStatus: 400 }); };
const unavailable = (): never => { throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', '元数据来源已经变化，请重新选择。', { httpStatus: 503 }); };

/** 仅传公开元数据和不透明引用；Roon会话、播放上下文及SDK始终留在父Core。 */
export function createDatasetRoonProjectionGateway(
  getLibrary: () => RoonPublicLibrary | undefined,
  options: { isCurrentOwner?: (epoch: string) => boolean } = {},
): { handler: DatasetOwnerProjectionHandler; close(): void } {
  const tickets = new Map<string, ProjectionTicket>();
  let closed = false;
  function current(epoch: string): void {
    if (closed || options.isCurrentOwner?.(epoch) === false) unavailable();
  }
  function library(): RoonPublicLibrary { return getLibrary() ?? unavailable(); }
  function capture(epoch: string, scope: string, source: RoonPublicLibrary): { scope: string; projectionId: string } {
    const projectionId = randomUUID();
    // 票据随当前owner在途操作释放；关闭/故障清空整代，不能让SQL排队超时改变业务合同。
    tickets.set(projectionId, { epoch, scope, source });
    return { scope, projectionId };
  }
  async function handle(
    command: DatasetProjectionCommand,
    payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand],
    context: { epoch: string; datasetId?: string },
  ): Promise<unknown> {
    current(context.epoch);
    if (!isDatasetProjectionPayload(command, payload)) return invalid();
    switch (command) {
      case 'browseAlbumCandidates': {
        const p = payload as DatasetProjectionCommandPayloads['browseAlbumCandidates'];
        const source = library();
        const scope = source.getReadScope();
        const result = p.query.trim()
          ? await source.searchLibrary(p.query.trim(), p.page, 'album')
          : await source.browseAlbums(p.page);
        current(context.epoch);
        if (source !== library() || scope !== source.getReadScope()) return unavailable();
        return result;
      }
      case 'captureAlbumMetadata': {
        const p = payload as DatasetProjectionCommandPayloads['captureAlbumMetadata'];
        const source = library();
        const scope = source.getReadScope();
        const metadata = source.getAlbumSnapshot(p.reference);
        if (!isDigitalAlbumMetadata(metadata)) return invalid();
        if (scope !== source.getReadScope()) return unavailable();
        return { ...capture(context.epoch, scope, source), metadata };
      }
      case 'captureTrackMetadataBatch': {
        const p = payload as DatasetProjectionCommandPayloads['captureTrackMetadataBatch'];
        const source = library();
        const scope = source.getReadScope();
        // 同一同步段捕获整批，顺序与原草稿append完全相同。
        const metadata = p.references.map(reference => source.getTrackSnapshot(reference));
        if (!metadata.every(isDraftTrackMetadata)) return invalid();
        if (scope !== source.getReadScope()) return unavailable();
        return { ...capture(context.epoch, scope, source), metadata };
      }
      case 'acquirePermit': {
        const p = payload as DatasetProjectionCommandPayloads['acquirePermit'];
        const ticket = tickets.get(p.projectionId);
        if (!ticket || ticket.epoch !== context.epoch || ticket.scope !== p.scope || ticket.permitId
          || library() !== ticket.source || ticket.source.getReadScope() !== ticket.scope) return unavailable();
        const permitId = randomUUID();
        ticket.permitId = permitId;
        // 许可是捕获证据的线性化点，不锁Transport，也不等待worker同步事务。
        return { scope: ticket.scope, projectionId: p.projectionId, permitId };
      }
      case 'releasePermit': {
        const p = payload as DatasetProjectionCommandPayloads['releasePermit'];
        const ticket = tickets.get(p.projectionId);
        if (!ticket || ticket.epoch !== context.epoch || ticket.scope !== p.scope || ticket.permitId !== p.permitId) return unavailable();
        tickets.delete(p.projectionId);
        return { released: true as const };
      }
    }
  }
  return {
    // wire边界对command/payload/result逐项验证，内部实现的switch保留对应类型关系。
    handler: handle as DatasetOwnerProjectionHandler,
    close() { closed = true; tickets.clear(); },
  };
}
