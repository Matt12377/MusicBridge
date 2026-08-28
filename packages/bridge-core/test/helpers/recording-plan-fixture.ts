import assert from 'node:assert/strict';
import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { archiveBackupFixture } from './archive-backup-fixture.js';

/** 同一套真实合成源、执行文件和FINALIZED归档；不绕过正式冻结条件。 */
export async function recordingPlanFixture(t: test.TestContext, prepared = false, hooks: { afterVerification?: () => Promise<void>; operationTimeoutMs?: number; format?: 'cassette' | 'dat' } = {}) {
  const { format, ...coordinatorHooks } = hooks;
  const f = await archiveBackupFixture(t, prepared, format ? { format } : {});
  const module = await import('../../src/recording/plan-coordinator.js').catch(() => ({}));
  assert.ok('createRecordingPlanCoordinator' in module, '缺少正式计划协调器，不能冻结或预检');
  assert.ok('recordingPlans' in f.repository, '缺少正式计划仓库');
  const plans = (module as typeof import('../../src/recording/plan-coordinator.js')).createRecordingPlanCoordinator({ store: f.repository.recordingPlans, ...coordinatorHooks });
  t.after(() => plans.close());
  const selection = { assetId: f.archiveRequest.assetId, archiveOperationId: f.archiveRequest.commandId };
  const preview = () => plans.preview({ selection, readId: randomUUID() });
  const request = async () => ({ selection, commandId: randomUUID(), proposalFingerprint: (await preview()).proposalFingerprint, userConfirmed: true as const });
  return { ...f, plans, planSelection: selection, planPreview: preview, planRequest: request };
}
