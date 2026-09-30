import assert from 'node:assert/strict';
import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { recordingPlanFixture } from './recording-plan-fixture.js';
import type { acquireRecordingOutputInputLease } from '../../src/recording/output-input.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** 仅审计输出 Attempt 生命周期；合成归档不是物理输入采集，假租期不打开设备或音频 FD。 */
export async function outputAttemptAuditFixture(t: test.TestContext) {
  const f = await recordingPlanFixture(t);
  const plan = await f.plans.freeze(await f.planRequest());
  const lifecycle: string[] = [];
  const acquireInputLease: typeof acquireRecordingOutputInputLease = async (input, signal, check) => {
    check(); lifecycle.push('lease-acquired');
    const format = input.plan.profileSnapshot.settings.format;
    return {
      signal,
      provider: {
        signal, audio: input.receipt.audio, format, checkOperation: check,
        consumer: {
          descriptor: { dataOffset: input.receipt.audio.dataOffset, frameCount: input.receipt.audio.frameCount,
            channelCount: format.channelCount, sampleFormat: format.outputSampleFormat },
          async readFrames() { assert.fail('生命周期审计不得实际读取或播放音频'); },
        },
      },
      async release() { lifecycle.push('lease-released'); return signal.aborted ? 'cancelled' : 'verified'; },
    };
  };
  const request = () => ({ commandId: randomUUID(), planVersionId: plan.id, planContentHash: plan.contentHash, userConfirmed: true as const });
  const barrier = (attemptId: string) => f.repository.recordingRecords.read(db =>
    db.prepare('SELECT phase,reason FROM output_run_barrier_events WHERE attempt_id=? ORDER BY rowid').all(attemptId)
      .map(row => ({ phase: String(row.phase), reason: row.reason === null ? null : String(row.reason) })));
  async function waitUntil(check: () => boolean) {
    const deadline = performance.now() + 3_000;
    while (!check()) {
      if (performance.now() >= deadline) assert.fail('合成生命周期未在期限内收口');
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
  return { ...f, lifecycle, acquireInputLease, request, barrier, waitUntil };
}
