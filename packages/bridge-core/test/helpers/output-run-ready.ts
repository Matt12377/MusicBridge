import type { CollectionRepository } from '../../src/collection/repository.js';

/** 合成驱动的 EOF/drain 回调并不等于关闭与末核验已提交；按精确 run 等持久屏障。 */
export async function waitForVerifiedOutputRun(repository: CollectionRepository, attemptId: string, runId: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!repository.recordingRecords.read(db => db.prepare("SELECT 1 FROM output_run_barrier_events WHERE attempt_id=? AND run_id=? AND phase='verified'").get(attemptId, runId))) {
    if (performance.now() > deadline) throw new Error('合成输出关闭与输入末核验未在期限内持久化');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
