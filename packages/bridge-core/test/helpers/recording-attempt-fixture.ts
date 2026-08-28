import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { recordingPlanFixture } from './recording-plan-fixture.js';
import { createRecordingAttemptCoordinator, type RecordingAttemptAdmissionProvider, type RecordingAttemptDriverRequest } from '../../src/recording/attempt-coordinator.js';

/** 只在测试构造器注入受控驱动；不注册IPC/环境认证入口，不触设备。 */
export async function recordingAttemptFixture(t: test.TestContext, format: 'cassette' | 'dat' = 'cassette') {
  const f = await recordingPlanFixture(t, false, { format });
  const frozenPlan = await f.plans.freeze(await f.planRequest());
  const starts: RecordingAttemptDriverRequest[] = [];
  let stops = 0, closes = 0;
  const provider: RecordingAttemptAdmissionProvider = {
    async authorize() {},
    async start(request) {
      starts.push(request);
      return { async stop() { ++stops; }, async close() { ++closes; } };
    },
  };
  const attempts = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: provider });
  t.after(() => attempts.close());
  const beginRequest = () => ({ commandId: randomUUID(), planVersionId: frozenPlan.id, planContentHash: frozenPlan.contentHash, userConfirmed: true as const });
  return { ...f, frozenPlan, starts, provider, attempts, beginRequest, driverCounts: () => ({ stops, closes }) };
}
