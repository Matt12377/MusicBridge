import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';

test('真正hosted同根输出/TMP/cache准入，裸GITHUB_ACTIONS和链接越界拒绝', async () => {
  const temporary = await mkdtemp(path.join(process.env.TMPDIR, 'rust016-runner-'));
  const runner = path.join(temporary, 'runner'); await mkdir(runner, { mode: 0o700 });
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: runner };
  const policy = buildStoragePolicy({ env, platform: 'darwin' });
  assert.equal(policy.hosted, true); assert.equal(policy.check(path.join(runner, 'musicbridge-rust-core/run-1/host')), path.join(runner, 'musicbridge-rust-core/run-1/host'));
  assert.throws(() => policy.check(path.join(temporary, 'outside')));
  assert.throws(() => policy.check(path.join(runner, 'arbitrary/host')));
  assert.throws(() => policy.check(runner + '/musicbridge-x/../musicbridge-y'));
  const dedicated = path.join(runner, 'musicbridge-rust-core'); await mkdir(dedicated);
  await symlink(temporary, path.join(dedicated, 'escape')); assert.throws(() => policy.check(path.join(dedicated, 'escape/host')));
  const partial = buildStoragePolicy({ env: { GITHUB_ACTIONS: 'true', RUNNER_TEMP: runner, DEV_BUILD_ROOT: temporary }, platform: 'linux' });
  assert.equal(partial.hosted, false); assert.throws(() => buildStoragePolicy({ env: { ...env, RUNNER_TEMP: runner + '/../runner' }, platform: 'darwin' }));
});
