import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARTWORK_AT_MAPPING, ARTWORK_BASE_SHA, ARTWORK_EVIDENCE_POLICY, ARTWORK_EXPECTED_TESTS, ARTWORK_TASK_SPEC, ARTWORK_TESTS,
  artworkStageEvaluation, assertArtworkAdmission, assertArtworkTestInventory, captureArtworkStage, runArtworkGate } from '../verify-mbrs010-artwork.mjs';
import { validateOfflineArguments } from '../verify-mbrs001-offline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = relative => readFileSync(path.join(root, relative));
function admission() {
  return { scope: JSON.parse(read('docs/postrust/MBRS-010/EXECUTION_SCOPE.json').toString('utf8')),
    task: read(ARTWORK_TASK_SPEC.path), board: read('docs/postrust/MBRS-000/PACK_TASKBOARD.json'),
    acceptance: read('docs/postrust/MBRS-000/PACK_ACCEPTANCE.json'), g0: JSON.parse(read('docs/postrust/RUST-016/ADMISSION_DECISION.json').toString('utf8')) };
}
function admit(value) { return assertArtworkAdmission(value.scope, value.task, value.board, value.acceptance, value.g0); }
const files = () => ARTWORK_TESTS.flatMap(group => group.tests.map(file => `${group.directory}/${file}`));
function tap(count = 2) {
  return ['TAP version 13', ...Array.from({ length: count }, (_, index) => `ok ${index + 1} - 合成私有名称 Token-不可公开 /Volumes/私有路径`),
    `1..${count}`, `# tests ${count}`, '# suites 0', `# pass ${count}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', ''].join('\n');
}
const cleanResult = () => ({ exitCode: 0, signal: null, closeObserved: true, timedOut: false, overflow: false, captureFailed: false, preparationFailed: false, groupTerminationFailed: false });
function privateFixture(t) {
  const temporary = process.env.TMPDIR;
  assert.equal(typeof temporary, 'string'); assert.equal(path.isAbsolute(temporary), true);
  if (process.platform === 'darwin' && !(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'))
    assert.equal(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'), true, '本机入口测试只在外置任务临时根创建自有桩');
  const run = mkdtempSync(path.join(temporary, 'musicbridge-mbrs010-gate-entry-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  return run;
}
function stub(name, code, expectedTests = 2) { return { name, directory: '.', expectedTests, args: ['-e', code], displayArgs: ['-e', '<受控Node桩>'] }; }

test('010门禁固定原始7AT、18任务/156验收和本轮12文件184测试，不沿用旧003预算', () => {
  const cases = admit(admission()); assert.equal(cases.length, 7); assert.deepEqual(cases.map(item => item.id), ARTWORK_AT_MAPPING.map(item => item.id));
  assert.equal(ARTWORK_BASE_SHA, '0a9c211805cdaecf56c699fe0c264590a0839e0e');
  assert.equal(assertArtworkTestInventory(files()).length, 12); assert.equal(ARTWORK_EXPECTED_TESTS, 184);
  assert.equal(ARTWORK_TESTS.reduce((count, group) => count + group.expectedTests, 0), 184);
  assert.ok(ARTWORK_AT_MAPPING.every(at => at.stages.length > 0 && at.stages.every(name => ARTWORK_TESTS.some(group => group.name === name))));
  assert.ok(ARTWORK_TESTS.every(group => ARTWORK_AT_MAPPING.some(at => at.stages.includes(group.name))));
  assert.equal(ARTWORK_EVIDENCE_POLICY.originalTaskCount, 18); assert.equal(ARTWORK_EVIDENCE_POLICY.originalAcceptanceCount, 156);
  assert.equal(ARTWORK_EVIDENCE_POLICY.oldMbrs003AttemptBudgetReused, false);
  for (const key of ['realMusicBrainzReleaseSearch', 'realCoverArtArchiveImages', 'realCommonsSearch', 'roonArtworkDelivery', 'ownerAcceptance', 'listening', 'currentAndNewRealDirectPlayback'])
    assert.equal(ARTWORK_EVIDENCE_POLICY[key], 'NOT_RUN');
  assert.equal(ARTWORK_EVIDENCE_POLICY.commonsRole, 'OPTIONAL_CC0_SUPPLEMENT_NOT_MUSIC_RELEASE_SEARCH');
  assert.equal(ARTWORK_EVIDENCE_POLICY.taskCompletion, 'NOT_DECIDED_BY_THIS_SOFTWARE_GATE');
});

for (const [name, mutate, code] of [
  ['基线变化', value => { value.scope.baseSha = 'b'.repeat(40); }, 'ARTWORK_EXECUTION_SCOPE_INVALID'],
  ['任务数变化', value => { value.scope.originalTaskCount = 19; }, 'ARTWORK_EXECUTION_SCOPE_INVALID'],
  ['验收数变化', value => { value.scope.originalAcceptanceCount = 157; }, 'ARTWORK_EXECUTION_SCOPE_INVALID'],
  ['010验收数变化', value => { value.scope.taskAcceptanceCount = 8; }, 'ARTWORK_EXECUTION_SCOPE_INVALID'],
  ['源文件写回开启', value => { value.scope.sourceFilesWrite = 'ON'; }, 'ARTWORK_EXECUTION_SCOPE_INVALID'],
  ['默认Core变化', value => { value.scope.defaultCore = 'Rust'; }, 'ARTWORK_EXECUTION_SCOPE_INVALID'],
  ['缺G0准入', value => { value.scope.g0 = 'NOT_ADMITTED'; }, 'ARTWORK_EXECUTION_SCOPE_INVALID'],
  ['任务路径穿越', value => { value.scope.taskSpec.path = '../另一个任务.md'; }, 'ARTWORK_ORIGINAL_TASK_IDENTITY'],
  ['任务原文字节变化', value => { value.task = Buffer.concat([value.task, Buffer.from('\n')]); }, 'ARTWORK_ORIGINAL_TASK_IDENTITY'],
  ['原任务台账重新封口', value => { value.board = Buffer.concat([value.board, Buffer.from(' ')]); }, 'ARTWORK_ORIGINAL_PACK_IDENTITY'],
  ['原验收台账重新封口', value => { value.acceptance = Buffer.concat([value.acceptance, Buffer.from(' ')]); }, 'ARTWORK_ORIGINAL_PACK_IDENTITY'],
  ['009封存身份变化', value => { value.scope.predecessorFinalSeal.sha256 = 'b'.repeat(64); }, 'ARTWORK_PREDECESSOR_SEAL_IDENTITY'],
  ['合成G0', value => { value.g0.is_synthetic = true; }, 'ARTWORK_G0_RECORD_INVALID'],
  ['空G0退出清单', value => { value.g0.exit_items = []; }, 'ARTWORK_G0_RECORD_INVALID'],
  ['G0必需退出项开放', value => { value.g0.exit_items[0].status = 'OPEN'; }, 'ARTWORK_G0_RECORD_INVALID'],
  ['重复数据库写作者', value => { value.g0.component_owners.push({ ...value.g0.component_owners[0] }); }, 'ARTWORK_DATABASE_OWNER_INVALID'],
]) test('010准入拒绝' + name, () => { const value = admission(); mutate(value); assert.throws(() => admit(value), error => error.code === code); });

test('010测试文件不得删除、重复、追加或替换成路径穿越/旧回归', () => {
  for (const list of [files().slice(1), [...files(), files()[0]], [...files(), 'apps/desktop/test/local-artwork-extra.test.ts'],
    ['../不受控.test.ts', ...files().slice(1)], ['packages/contracts/test/validator.test.ts', ...files().slice(1)]])
    assert.throws(() => assertArtworkTestInventory(list), error => error.code === 'ARTWORK_TEST_INVENTORY_MISMATCH');
});

test('010完整TAP必须唯一计数并全部通过，失败/取消/skip/todo不能以退出0冒充完成', () => {
  assert.equal(artworkStageEvaluation(cleanResult(), tap(), 2).success, true);
  for (const raw of [tap().replace('# fail 0', '# fail 1'), tap().replace('# cancelled 0', '# cancelled 1'),
    tap().replace('# skipped 0', '# skipped 1'), tap().replace('# todo 0', '# todo 1'),
    tap().replace('# cancelled 0\n', ''), tap() + '# tests 2\n', tap().replace('# tests 2', '# tests 2abc'),
    tap().replace('ok 1 -', 'not ok 1 -'), tap().replace('ok 1 -', 'ok 1 # SKIP -'), tap().replace('ok 1 -', 'ok 1 # TODO -'), tap(1)])
    assert.equal(artworkStageEvaluation(cleanResult(), raw, 2).success, false);
});

test('010子进程非零/信号/未close/超时/溢出/捕获或准备失败均拒绝，即使TAP184全绿', () => {
  for (const partial of [{ exitCode: 1 }, { exitCode: null }, { signal: 'SIGTERM' }, { closeObserved: false },
    ...['timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].map(key => ({ [key]: true }))])
    assert.equal(artworkStageEvaluation({ ...cleanResult(), ...partial }, tap(184), 184).success, false);
});

test('010错误CLI在任何run目录或child前拒绝，不提供缩清单/计数/网络开关', async t => {
  const parent = privateFixture(t), output = path.join(parent, 'must-not-exist');
  for (const args of [[], ['--bad'], [`--output-root=${output}`, '--live'], [`--output-root=${output}`, '--expected-tests=1'],
    [`--output-root=${output}`, '--output-root=elsewhere'], ['--output-root=']]) {
    await assert.rejects(runArtworkGate(args, process.env)); assert.equal(existsSync(output), false);
  }
  assert.throws(() => validateOfflineArguments([`--output-root=${parent}`], process.env));
});

test('010准入接受真实外置或Hosted专用新run，只读解析不会提前建目录', t => {
  const parent = privateFixture(t), output = path.join(parent, 'future-run');
  const value = validateOfflineArguments([`--output-root=${output}`], { ...process.env, TMPDIR: parent });
  assert.equal(value.output, output); assert.equal(existsSync(output), false);
  assert.equal(value.temporary, parent); assert.equal(lstatSync(parent).mode & 0o777, 0o700);
});

test('010实际固定工具入口可解析，不运行编译器、不安装依赖或创建产物', () => {
  const coreRequire = createRequire(path.join(root, 'packages/bridge-core/package.json'));
  const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
  for (const [name, require, version] of [['typescript', coreRequire, '5.9.3'], ['tsx', coreRequire, '4.23.12'], ['vue-tsc', desktopRequire, '3.0.6'], ['vue', desktopRequire, '3.5.42']]) {
    assert.equal(JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version, version);
    assert.equal(lstatSync(require.resolve(name === 'typescript' ? 'typescript/lib/typescript.js' : name)).isFile(), true);
  }
  for (const file of [coreRequire.resolve('typescript/bin/tsc'), desktopRequire.resolve('vue-tsc/bin/vue-tsc.js'),
    ...['tsc.js', '_tsc.js'].map(name => path.join(path.dirname(coreRequire.resolve('typescript/package.json')), 'lib', name))])
    assert.equal(lstatSync(file).isFile(), true);
});

test('010真实受控Node退出0与完整TAP绑定，私有日志只保留状态和计数', async t => {
  const run = privateFixture(t), result = await captureArtworkStage(stub('stub-success', `process.stdout.write(${JSON.stringify(tap())});`), { run, directory: run });
  assert.equal(result.success, true); assert.equal(result.exitCode, 0); assert.equal(result.closeObserved, true); assert.equal(result.testCounts.tests, 2);
  assert.match(result.capturedRawSha256, /^[a-f0-9]{64}$/u); assert.match(result.logSha256, /^[a-f0-9]{64}$/u);
  const safe = readFileSync(path.join(run, result.log), 'utf8'); assert.ok(safe.includes('# pass 2'));
  assert.ok(!safe.includes('Token-') && !safe.includes('/Volumes/私有路径') && !safe.includes('合成私有名称'));
  for (const file of [result.log, 'stub-success.json']) assert.equal(lstatSync(path.join(run, file)).mode & 0o777, 0o600);
  const receipt = JSON.parse(readFileSync(path.join(run, 'stub-success.json'), 'utf8')); assert.equal(receipt.exitCode, 0); assert.equal(receipt.logSha256, result.logSha256);
});

test('010真实Node非零退出保留真实状态，不被完整绿色summary覆盖', async t => {
  const run = privateFixture(t), result = await captureArtworkStage(stub('stub-nonzero', `process.stdout.write(${JSON.stringify(tap())}); process.exitCode=3;`), { run, directory: run });
  assert.equal(result.exitCode, 3); assert.equal(result.testSummaryValid, true); assert.equal(result.success, false);
});

test('010真实Node失败TAP即使退出0也拒绝；不以日志尾码认绿', async t => {
  const run = privateFixture(t), raw = tap().replace('ok 1 -', 'not ok 1 -');
  const result = await captureArtworkStage(stub('stub-failed-tap', `process.stdout.write(${JSON.stringify(raw)});`), { run, directory: run });
  assert.equal(result.exitCode, 0); assert.equal(result.tapStatusesClean, false); assert.equal(result.success, false);
});

test('010超时只终止自有进程组并观察真实close，不返回未封存成功', async t => {
  const run = privateFixture(t), result = await captureArtworkStage(stub('stub-timeout', 'setInterval(()=>{},1000);'), { run, directory: run, limitMs: 75 });
  assert.equal(result.timedOut, true); assert.equal(result.closeObserved, true); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.groupTerminationFailed, false); assert.equal(result.success, false);
});

test('010输出预算超限实际终止，准备失败同样不能产生成功回执', async t => {
  const run = privateFixture(t);
  const overflow = await captureArtworkStage(stub('stub-overflow', "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);"), { run, directory: run, maxBytes: 128 });
  assert.equal(overflow.overflow, true); assert.equal(overflow.closeObserved, true); assert.equal(overflow.success, false);
  const missing = await captureArtworkStage({ ...stub('stub-preparation', 'process.exitCode=0;'), directory: 'absent' }, { run, directory: run });
  assert.equal(missing.preparationFailed, true); assert.equal(missing.success, false); assert.equal(missing.closeObserved, true);
});

test('010测试child真实TCP/DNS/HTTPS/fetch在网络前被阻断，受控HTTPS桩仍可替换', async t => {
  const run = privateFixture(t), guard = pathToFileURL(path.join(root, 'scripts/ci/verify-mbrs010-artwork.mjs')).href + '#artwork-offline';
  const code = `
    const assert=require('node:assert/strict');
    const denied=error=>error.code==='ARTWORK_NETWORK_FORBIDDEN';
    assert.throws(()=>require('node:net').connect({host:'127.0.0.1',port:1}),denied);
    assert.throws(()=>new (require('node:net').Socket)().connect({host:'127.0.0.1',port:1}),denied);
    assert.throws(()=>require('node:https').request('https://example.invalid/'),denied);
    assert.throws(()=>require('node:dns').lookup('example.invalid',()=>{}),denied);
    assert.throws(()=>new (require('node:dns/promises').Resolver)().resolve4('example.invalid'),denied);
    const https=require('node:https'),original=https.request; https.request=()=>({synthetic:true});
    assert.equal(https.request('https://example.invalid/').synthetic,true); https.request=original;
    fetch('http://127.0.0.1:1/').then(()=>{process.exitCode=1;},error=>{assert.ok(denied(error));process.stdout.write(${JSON.stringify(tap(1))});});
  `;
  const result = await captureArtworkStage({ ...stub('stub-network-denied', code, 1), args: ['--import', guard, '-e', code] }, { run, directory: run });
  assert.equal(result.success, true); assert.equal(result.testCounts.pass, 1); assert.equal(result.exitCode, 0);
});
