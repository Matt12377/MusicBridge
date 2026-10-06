import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalPlaybackScope } from '../verify-mbrs006-local-playback.mjs';

// 这些数量只属于准入输入fixture；产品范围使用另存的实际TAP冻结清单。
const valid = () => ({
  schema: 'mbrs006.local-playback-scope.v1',
  baseSha: 'cce8594f4b6e9872afd576bb1b032f526c93af72',
  implementationComplete: true, countsConfirmed: true,
  groups: [
    { name: 'core-local-playback', directory: 'packages/bridge-core', expectedTests: 1,
      tests: ['test/mbrs006/local-facts-fence.test.ts'] },
    { name: 'core-affected-regression', directory: 'packages/bridge-core', expectedTests: 1,
      tests: ['test/controller.test.ts', 'test/roon-adapter.test.ts', 'test/runtime.test.ts',
        'test/playback-event-publisher.test.ts', 'test/dataset-owner.test.ts',
        'test/dataset-owner-integration.test.ts', 'test/source-evidence.test.ts',
        'test/mbrs002/local-source-resolver.test.ts', 'test/utility-playback-stream.test.ts',
        'test/controller-context.test.ts', 'test/roon-sdk-callback-context.test.ts', 'test/runtime-compact-events.test.ts'] },
    { name: 'contracts-local-identity', directory: 'packages/contracts', expectedTests: 1,
      tests: ['test/playback-stream.test.ts', 'test/validator.test.ts', 'test/mbrs002/local-play-request.test.ts', 'test/mbrs002/local-playback-compat.test.ts'] },
    { name: 'desktop-local-consumer', directory: 'apps/desktop', expectedTests: 1,
      tests: ['test/mbrs002/local-playback-compat.test.ts', 'test/playback-session.test.ts', 'test/playbackFavorites.test.ts',
        'test/playback-stream-reducer.test.ts', 'test/dataset-owner-bootstrap.test.ts', 'test/rust-core-host.test.ts',
        'test/mbrs003/local-library-front-boundary.test.ts', 'test/mbrs003/local-library-ipc.test.ts', 'test/mbrs003/local-library-client.test.ts',
        'test/security.test.ts', 'test/ipc-security.test.ts', 'test/csp.test.ts', 'test/protocol.test.ts', 'test/preload.test.ts', 'test/credential-provisioning.test.ts', 'test/credential-vault.test.ts'] },
  ],
});
const inventory = scope => scope.groups.flatMap(group => group.tests
  .filter(name => name.includes('/mbrs006/') || name.startsWith('test/mbrs006-'))
  .map(name => group.directory + '/' + name));
function rejects(edit, code) {
  const scope = valid(), paths = inventory(scope); edit(scope);
  assert.throws(() => assertLocalPlaybackScope(scope, paths), error => error.code === code);
}
test('006 Gate：三个产品包与原播放器、Owner、consumer回归同时准入', () => {
  const scope = valid(); assert.equal(assertLocalPlaybackScope(scope, inventory(scope)).length, 4);
});
test('006 Gate：实现或真实数量尚未冻结时拒绝', () => {
  for (const field of ['implementationComplete', 'countsConfirmed']) {
    rejects(scope => { scope[field] = false; }, 'LOCAL_PLAYBACK_SCOPE_NOT_FROZEN');
  }
});
test('006 Gate：非005最终报告基线拒绝', () => {
  rejects(scope => { scope.baseSha = 'a'.repeat(40); }, 'LOCAL_PLAYBACK_SCOPE_NOT_FROZEN');
});
test('006 Gate：零项、负数与非整数计数拒绝', () => {
  for (const count of [0, -1, 0.5]) {
    rejects(scope => { scope.groups[0].expectedTests = count; }, 'LOCAL_PLAYBACK_GROUP_INVALID');
  }
});
test('006 Gate：新增产品测试漏列或重复列入拒绝', () => {
  const scope = valid();
  assert.throws(() => assertLocalPlaybackScope(scope,
    [...inventory(scope), 'packages/bridge-core/test/mbrs006/new.test.ts']),
  error => error.code === 'LOCAL_PLAYBACK_TEST_INVENTORY_MISMATCH');
  rejects(value => { value.groups[0].tests.push(value.groups[0].tests[0]); }, 'LOCAL_PLAYBACK_TEST_INVENTORY_MISMATCH');
});
test('006 Gate：漏原Adapter、运行时、收藏consumer或合同回归拒绝', () => {
  for (const [group, name] of [[1, 'test/roon-adapter.test.ts'], [1, 'test/runtime.test.ts'],
    [2, 'test/validator.test.ts'], [3, 'test/playbackFavorites.test.ts'],
    [3, 'test/mbrs003/local-library-front-boundary.test.ts']]) {
    rejects(scope => { scope.groups[group].tests = scope.groups[group].tests.filter(item => item !== name); },
      'LOCAL_PLAYBACK_REQUIRED_REGRESSION_MISSING');
  }
  rejects(scope => { scope.groups.pop(); }, 'LOCAL_PLAYBACK_REQUIRED_REGRESSION_MISSING');
});
test('006 Gate：跨目录、旧任务、任意回归和重复组名拒绝', () => {
  for (const name of ['../secret.test.ts', 'test/mbrs006/../bad.test.ts',
    'test/mbrs005/http.test.ts', '/test/mbrs006/a.test.ts', 'test/arbitrary.test.ts']) {
    rejects(scope => { scope.groups[0].tests[0] = name; }, 'LOCAL_PLAYBACK_TEST_PATH_INVALID');
  }
  rejects(scope => { scope.groups[0].directory = 'native/rust-core'; }, 'LOCAL_PLAYBACK_GROUP_INVALID');
  rejects(scope => { scope.groups[1].name = scope.groups[0].name; }, 'LOCAL_PLAYBACK_GROUP_INVALID');
});
