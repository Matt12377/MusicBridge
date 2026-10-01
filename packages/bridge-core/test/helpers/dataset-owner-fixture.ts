import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { responseFailure } from '../../src/shared/ipc-failure.js';
import { DatasetOwnerDispatchError, ownerRecord, type OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js';

if (parentPort === null) throw new Error('测试fixture必须运行在线程中。');
const mode = String(workerData.mode);
const port = parentPort;
if (mode === 'stale') port.on('message', message => {
  if (ownerRecord(message) && message.type === 'request') port.postMessage({ version: 1, type: 'response', epoch: randomUUID(), requestId: message.requestId, operation: message.operation, ok: true, result: '旧epoch结果' });
});
attachDatasetOwnerWorkerPort(port, {
  async prepare(_epoch, projection) {
    let active = 0;
    let commits = 0;
    let stopped = false;
    let closed = false;
    let release!: () => void;
    const stopRequested = new Promise<void>(resolve => { release = resolve; });
    const domain: OwnedDatasetDomain = {
      datasetId: workerData.datasetId as string,
      async dispatch(request) {
        if (closed) throw new Error('连接已提前关闭。');
        if (mode === 'public-id') return { publicId: request.id };
        if (mode === 'crash') process.exit(17); // 合成断链故障，生产owner不主动退出。
        if (mode === 'projection') {
          const capture = await projection.call('captureAlbumMetadata', { reference: `musicbridge-v2-entity-${randomUUID()}` });
          const permit = await projection.call('acquirePermit', { scope: capture.scope, projectionId: capture.projectionId });
          await projection.call('releasePermit', permit);
          return capture.metadata;
        }
        if (mode === 'safe-failure') throw new DatasetOwnerDispatchError(responseFailure(request.id, 'ATTEMPT_NOT_ACCEPTED', '合成fixture已证实未受理。'));
        if (mode === 'hold') {
          active++;
          await stopRequested;
          if (closed || !stopped) throw new Error('关闭顺序错误。');
          active--;
        }
        return { stopped, commits, command: request.command };
      },
      commitBoot() { commits++; },
      async close(beforeConnectionClose) {
        stopped = true;
        release();
        await beforeConnectionClose?.();
        if (active !== 0) throw new Error('在途dispatch未收口。');
        if (mode === 'close-failure') throw new Error('合成关闭故障：内部路径与堆栈不应跨线程。');
        closed = true;
      },
      failureForError(id) { return responseFailure(id, 'INTERNAL_ERROR', '合成领域操作失败。'); },
    };
    return domain;
  },
});
