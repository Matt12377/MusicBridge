import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertRelocationAdmission, assertRelocationTestScope, assertRelocationArtifactClosure, RELOCATION_BASE, relocationStageSucceeded } from '../verify-mbrs013-relocation.mjs';
import { readArtifact } from '../../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';

const read = file => readFileSync(new URL('../../../' + file, import.meta.url));
const scope = JSON.parse(read('docs/postrust/MBRS-013/EXECUTION_SCOPE.json'));
const task = read('tasks/MBRS-013_LOCAL_RELOCATION.md'), board = read('docs/postrust/MBRS-000/PACK_TASKBOARD.json'), at = read('docs/postrust/MBRS-000/PACK_ACCEPTANCE.json');
const g0 = JSON.parse(read('docs/postrust/MBRS-013/G0_HANDOFF.json')), predecessor = JSON.parse(read('docs/postrust/MBRS-013/PREDECESSOR_DELIVERY.json'));
const copy = value => structuredClone(value);
const admit = (value = scope, original = task, originalBoard = board, originalAt = at, handoff = g0, prior = predecessor) => assertRelocationAdmission(value, original, originalBoard, originalAt, handoff, prior);

test('013 Gate原8AT、18/156、17/150与已封012 R准入，准入不等于验收PASS', () => { assert.doesNotThrow(() => admit()); });
test('013 Gate拒重写任务/AT/任务板、换base/旧域/源码Schema/取消的015或降低原八项', () => {
  for (const [key, value] of Object.entries({ baseSha: '0'.repeat(40), domain: 'SOURCE_WRITES_V1', publicDomain: 'localRelocation',
    privateDomain: 'localSourceWrites', defaultCore: 'Rust', optionalRustReadonly: 'ON', catalogSchemaAtEntry: 35,
    libraryWriteEnabledDefault: true, originalTaskCount: 17, originalAcceptanceCount: 150, effectiveTaskCount: 18,
    effectiveAcceptanceCount: 156, taskAcceptanceCount: 7, cancelledTask: null, noRepeatedAgentApproval: false,
    productPlanConfirmation: 'EXTRA_AGENT_POPUP' })) { const valueScope = copy(scope); valueScope[key] = value; assert.throws(() => admit(valueScope)); }
  for (const key of ['taskSpec', 'hardDependencies', 'acceptanceIds']) { const valueScope = copy(scope); valueScope[key] = []; assert.throws(() => admit(valueScope)); }
  assert.throws(() => admit(scope, Buffer.concat([task, Buffer.from('\n')])));
  assert.throws(() => admit(scope, task, Buffer.concat([board, Buffer.from('\n')])));
  assert.throws(() => admit(scope, task, board, Buffer.concat([at, Buffer.from('\n')])));
});
test('013 Gate逐项冻结完整原预算和全计划拒绝/实际预留，不接受静默截取或借012 writer限制', () => {
  for (const [key, value] of Object.entries(scope.budgets)) {
    const changed = copy(scope); changed.budgets[key] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : 'DIFFERENT';
    assert.throws(() => admit(changed), undefined, key);
  }
  const changed = copy(scope); changed.budgets.extra = 1; assert.throws(() => admit(changed));
  for (const [key, value] of Object.entries({ runtimeRelocation: 'ENABLED', old012SourceFilesWrite: 'ENABLED',
    formatEligibility: 'ONLY_012_WRITER_FLAC_PADDING', copySourceDisposition: 'DELETE_SOURCE_AFTER_COPY' })) {
    const changed = copy(scope); changed[key] = value; assert.throws(() => admit(changed));
  }
});
test('013 Gate拒未封 predecessor、报告/远端错身份或把真实/Owner改写成软件PASS', () => {
  for (const [key, value] of Object.entries({ reportSha: '0'.repeat(40), remoteHead: '0'.repeat(40), clean: false,
    reportDirectChildOfFinalSource: false, originalFailedExecutionsPreserved: false, noThirdSelfSealing012Commit: false,
    realRoonNasAudioDeviceOwner: 'PASS', result: 'ALL_ACCEPTED' })) { const changed = copy(predecessor); changed[key] = value; assert.throws(() => admit(scope, task, board, at, g0, changed)); }
  const changed = copy(predecessor); changed.finalReceipt.sha256 = '0'.repeat(64); assert.throws(() => admit(scope, task, board, at, g0, changed));
  for (const [key, value] of Object.entries({ baseSha: '0'.repeat(40), decision: 'NOT_ADMITTED', originalEightAcceptanceRequirementsUnchanged: false })) {
    const changedG0 = copy(g0); changedG0[key] = value; assert.throws(() => admit(scope, task, board, at, changedG0));
  }
});
const inherited = read('scripts/ci/mbrs012-source-writes-scope.json');
const oldScope = JSON.parse(inherited), oldDiscovered = oldScope.groups.flatMap(group => group.tests
  .filter(name => /^test\/(?:mbrs012-|mbrs012\/)/u.test(name)).map(name => group.directory + '/' + name));
const own = { schema: 'mbrs013.relocation-test-scope.v1', baseSha: RELOCATION_BASE, implementationComplete: true,
  countsConfirmed: true, inherited426TestsPreserved: true, groups: ['packages/contracts', 'packages/bridge-core', 'apps/desktop']
    .map((directory, i) => ({ name: ['contracts-relocation', 'core-relocation', 'desktop-relocation'][i], directory, tests: ['test/mbrs013/example.test.ts'], expectedTests: 1 })) };
const discovered = own.groups.flatMap(group => group.tests.map(name => group.directory + '/' + name));
test('013 Gate精确保留原426测试清单并覆盖全部实际新增测试，遗漏/重复/旁路路径或未冻结均拒绝', () => {
  const actual = assertRelocationTestScope(own, inherited, discovered, oldDiscovered);
  assert.equal(actual.length, 6); assert.equal(actual.slice(0, 3).reduce((count, group) => count + group.expectedTests, 0), 426);
  for (const key of ['implementationComplete', 'countsConfirmed', 'inherited426TestsPreserved']) { const changed = copy(own); changed[key] = false; assert.throws(() => assertRelocationTestScope(changed, inherited, discovered, oldDiscovered)); }
  assert.throws(() => assertRelocationTestScope(own, Buffer.concat([inherited, Buffer.from('\n')]), discovered, oldDiscovered));
  assert.throws(() => assertRelocationTestScope(own, inherited, discovered.slice(1), oldDiscovered));
  assert.throws(() => assertRelocationTestScope(own, inherited, [...discovered, 'packages/bridge-core/test/mbrs013/omitted.test.ts'], oldDiscovered));
  for (const value of ['test/old.test.ts', 'test/mbrs012/old.test.ts', 'test/mbrs013/../escape.test.ts']) {
    const changed = copy(own); changed.groups[0].tests[0] = value; assert.throws(() => assertRelocationTestScope(changed, inherited, discovered, oldDiscovered));
  }
  const duplicate = copy(own); duplicate.groups[0].tests.push(duplicate.groups[0].tests[0]); assert.throws(() => assertRelocationTestScope(duplicate, inherited, discovered, oldDiscovered));
  assert.throws(() => assertRelocationTestScope(own, inherited, discovered, oldDiscovered.slice(1)));
});
async function artifactFixture(t) {
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
  const directory = await mkdtemp(path.join(process.env.TMPDIR, 'mbrs013-gate-artifacts-'));
  await chmod(directory, 0o700);
  const names = ['contracts.js', 'service.js', 'service.js.map', 'service.d.ts', 'worker.bundle.mjs',
    'worker.bundle.mjs.map', 'worker.meta.json', 'worker.build.json', 'reader-binding.json', 'namespace-binding.json'];
  const rows = [];
  for (const name of names) {
    const file = path.join(directory, name), bytes = Buffer.from(name + '\n');
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    rows.push({ ...(await readArtifact(file)).identity, originalBytes: bytes });
  }
  t.diagnostic('Gate独立产物变更夹具保留：' + directory);
  return { directory, rows };
}
test('013 Gate真实FD复核覆盖编译服务、声明、Worker全部材料及两份binding，逐份篡改都拒绝', async t => {
  const f = await artifactFixture(t);
  assert.equal(await assertRelocationArtifactClosure(f.rows), true);
  for (const row of f.rows) {
    const changed = Buffer.from(row.originalBytes); changed[0] ^= 1;
    await writeFile(row.file, changed);
    await assert.rejects(assertRelocationArtifactClosure(f.rows), error => error.code === 'RELOCATION_ARTIFACT_CHANGED', path.basename(row.file));
    await writeFile(row.file, row.originalBytes);
  }
  assert.equal(await assertRelocationArtifactClosure(f.rows), true);
});
test('013 Gate拒缺失、符号链接、重复或无效产物闭集，不能只检查Reader十四叶', async t => {
  const f = await artifactFixture(t), row = f.rows[0];
  await assert.rejects(assertRelocationArtifactClosure([]), error => error.code === 'RELOCATION_ARTIFACT_CLOSURE_INVALID');
  await assert.rejects(assertRelocationArtifactClosure([row, row]), error => error.code === 'RELOCATION_ARTIFACT_CLOSURE_INVALID');
  await assert.rejects(assertRelocationArtifactClosure([{ ...row, file: 'relative.js' }]), error => error.code === 'RELOCATION_ARTIFACT_CLOSURE_INVALID');
  await assert.rejects(assertRelocationArtifactClosure([{ ...row, file: path.join(f.directory, 'missing.js') }]), { code: 'ENOENT' });
  const alias = path.join(f.directory, 'alias.js'); await symlink(row.file, alias);
  await assert.rejects(assertRelocationArtifactClosure([{ ...row, file: alias }]));
});
const passed = { exitCode: 0, signal: null, closeObserved: true, timedOut: false, overflow: false, captureFailed: false,
  preparationFailed: false, groupTerminationFailed: false, expectedTests: 2, tapStatusesClean: true,
  testCounts: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 } };
test('013 Gate只认可完整自然0/null/close和精确零skip TAP；退出请求、超时、缺项与skip不能通过', () => {
  assert.equal(relocationStageSucceeded(passed), true);
  for (const [key, value] of Object.entries({ exitCode: 1, signal: 'SIGTERM', closeObserved: false, timedOut: true, overflow: true,
    captureFailed: true, preparationFailed: true, groupTerminationFailed: true, tapStatusesClean: false, expectedTests: 3 })) {
    assert.equal(relocationStageSucceeded({ ...passed, [key]: value }), false);
  }
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    const changed = copy(passed); changed.testCounts[key] = 1; assert.equal(relocationStageSucceeded(changed), false);
  }
  assert.equal(relocationStageSucceeded({ ...passed, testCounts: null }), false);
});
