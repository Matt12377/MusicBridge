import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { CI_REPORT_MIRROR_TASK as task, CI_REPORT_MIRROR_BRANCH as branch, CI_REPORT_MIRROR_BASE as base,
  CI_REPORT_MIRROR_PRODUCT_SOURCE as product, CI_REPORT_MIRROR_SCOPE_PATH as scopePath,
  CI_REPORT_MIRROR_CORRECTION_PATH as correctionPath, CI_REPORT_MIRROR_SOURCE_FILES,
  CI_REPORT_MIRROR_REPORT_PATHS, CI_REPORT_MIRROR_CORRECTION_IDENTITY,
  assertCiReportMirrorScope, assertCiReportMirrorCorrection, inspectCiReportMirrorAdmission,
  inspectCiReportMirrorReportAdmission, inspectCiReportMirrorHistoricalObjects,
  ciReportMirrorWorkflowOutputs, validateCiReportMirrorParentCi, validateCiReportMirrorSourceReceipt,
  ciReportMirrorReportIdentity, inspectCiReportMirrorReportOnly } from '../ci-report-mirror-admission.mjs';
import { inspectReportOnly } from '../report-only-admission.mjs';
import { inspectTaskApplicability, taskApplicabilityWorkflowOutputs } from '../task-applicability.mjs';
import { CI_REPORT_MIRROR_SAFETY_CASE_NAMES as names, CI_REPORT_MIRROR_ORIGINAL_TESTS,
  ciReportMirrorGitEnvironment, captureCiReportMirrorStage, validateCiReportMirrorGateArguments } from '../verify-ci-report-mirror.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const originalHistory = ['cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f', '99c89519f3357f4018b32930e8179b66719f99e7'];
const sourcePaths = CI_REPORT_MIRROR_SOURCE_FILES.map(row => typeof row === 'string' ? row : row.path);
const reportPaths = CI_REPORT_MIRROR_REPORT_PATHS.map(row => typeof row === 'string' ? row : row.path);
const copy = value => structuredClone(value);
const sha = raw => createHash('sha256').update(raw).digest('hex');
const counts = tests => ({ tests, pass: tests, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
const rejected = error => /^CI_(?:REPORT_MIRROR|MIRROR)_/u.test(error?.code ?? '');
// 真实hosted SHA仅属于本轮Source；合成fixture不继承其资格上下文。
const fixtureEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GITHUB_') && !key.startsWith('GIT_')));
const guard = 'CI修复精确身份与原软件复用准入';
const toolGate = 'CI报告镜像历史对象修复工具 Gate';
const originalNegative = '验证报告CI准入正负例';
const record = filename => JSON.parse(readFileSync(filename));

let fixtureRoot, fixtureDirectory, fixtureSource, sourceTree;
/** 所有Git写入仅发生在本次自有外置fixture；不接触真实工作树、索引或remote。 */
function command(directory, args, { input, allowFailure = false, environment = process.env } = {}) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: directory, env: ciReportMirrorGitEnvironment(environment), input, encoding: 'utf8',
    timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(result.error, undefined, 'fixture Git必须有界自然退出');
  assert.equal(result.signal, null);
  if (!allowFailure) assert.equal(result.status, 0, result.stderr);
  return allowFailure ? result : result.stdout.trim();
}
function commitTree(directory, tree, parents, message) {
  return command(directory, ['-c', 'user.name=MusicBridge CI Fixture', '-c', 'user.email=ci-fixture@example.invalid',
    'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], { input: message + '\n' });
}
function clone(directory, destination, head, observedBranch = branch) {
  command(path.dirname(destination), ['-c', 'protocol.file.allow=always', 'clone', '--no-local',
    '--no-hardlinks', '--no-checkout', '--', directory, destination]);
  command(destination, ['checkout', '-B', observedBranch, head, '--']);
  assert.equal(command(destination, ['rev-parse', '--path-format=absolute', '--git-common-dir']), path.join(destination, '.git'));
  assert.equal(existsSync(path.join(destination, '.git/objects/info/alternates')), false);
  return destination;
}
function fixture(t) {
  if (!fixtureRoot) {
    const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR, { mustExist: true });
    if (!storage.hosted) assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
    fixtureRoot = mkdtempSync(path.join(temporary, 'ci-report-mirror-test-'));
    storage.check(fixtureRoot, { mustExist: true });
    fixtureDirectory = clone(repository, path.join(fixtureRoot, 'source'), base);
    for (const relative of sourcePaths) {
      const filename = path.join(fixtureDirectory, relative); mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      writeFileSync(filename, readFileSync(path.join(repository, relative)), { mode: 0o644 }); chmodSync(filename, 0o644);
    }
    command(fixtureDirectory, ['add', '--', ...sourcePaths]); sourceTree = command(fixtureDirectory, ['write-tree']);
    fixtureSource = commitTree(fixtureDirectory, sourceTree, [base], '受控真实Git Source；不代表当前CI或软件新实跑');
    command(fixtureDirectory, ['update-ref', 'refs/heads/' + branch, fixtureSource]);
  }
  command(fixtureDirectory, ['checkout', '-f', '-B', branch, fixtureSource, '--']);
  command(fixtureDirectory, ['reset', '--hard', fixtureSource]);
  assert.equal(command(fixtureDirectory, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  t.diagnostic('受控真实Git fixture=' + fixtureDirectory + ' Source=' + fixtureSource + ' base=' + base);
  return { directory: fixtureDirectory, source: fixtureSource, root: fixtureRoot };
}
after(() => { if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: false }); });

function checkout(directory, head) { command(directory, ['checkout', '-f', '-B', branch, head, '--']); }
function commitWorking(directory, paths, parents = [base]) {
  command(directory, ['add', '--', ...paths]); const tree = command(directory, ['write-tree']);
  const head = commitTree(directory, tree, parents, '受控拒绝边界变异'); checkout(directory, head); return head;
}
function jsonEdit(directory, relative, edit) {
  const filename = path.join(directory, relative), value = record(filename); edit(value);
  writeFileSync(filename, JSON.stringify(value, null, 2) + '\n'); return value;
}
function hosted(head) { return { ...fixtureEnvironment, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_EVENT_NAME: 'push', GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'Matt12377/MusicBridge',
  GITHUB_REF_NAME: branch, GITHUB_SHA: head }; }

/** 只测试producer判定；所有id/raw pins均受控合成，绝不写成真实平台CI资格。 */
function ci(source) {
  const files = ['verify', 'security', 'rust-core', 'electron-e2e'];
  const jobNames = [['verify', 'dependency-audit'], ['static-security'],
    ['rust-core (ubuntu-latest)', 'rust-core (macos-latest)'], ['macos-electron-gate']];
  const successNames = new Set([guard, '复用165已封存产品软件证据', toolGate, '准备准入正负例的精确历史Git对象',
    '保留本次CI修复工具证据', 'Validate control plane', 'Validate security and product boundaries',
    'Scan workspace import cycles', 'Production dependency audit', 'Validate machine control state',
    'Run boundary, loopback, secret and URL/query scans']);
  const workflowSteps = (file, job) => {
    const lines = readFileSync(path.join(repository, '.github/workflows/' + file + '.yml'), 'utf8').split('\n');
    const start = lines.indexOf('  ' + job + ':'); assert.ok(start >= 0);
    let end = start + 1; while (end < lines.length && !/^  [a-z][a-z0-9-]*:/u.test(lines[end])) end++;
    return lines.slice(start, end).map(line => /^      - name: (.+)$/u.exec(line)?.[1]).filter(Boolean)
      .map(name => ({ name, status: 'completed', conclusion: successNames.has(name) ? 'success' : 'skipped' }));
  };
  const runs = files.map((name, index) => ({ id: 8100 + index, path: '.github/workflows/' + name + '.yml',
    repository: { id: 1340424953 }, head_repository: { id: 1340424953 }, head_sha: source, head_branch: branch,
    event: 'push', run_attempt: 1, status: 'completed', conclusion: 'success' }));
  const proofs = runs.map((run, index) => ({ runId: run.id, jobs: jobNames[index].map((name, ordinal) => ({
    id: run.id * 10 + ordinal, name, run_id: run.id, head_sha: source, status: 'completed', conclusion: 'success',
    steps: workflowSteps(files[index], index === 2 ? 'rust-core' : name),
  })), artifacts: index === 0 ? [{ id: 91001, name: 'verify-' + source, expired: false,
    size_in_bytes: 11, digest: 'sha256:' + 'd'.repeat(64), expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: run.id, head_sha: source, repository_id: 1340424953, head_repository_id: 1340424953 } }] : [] }));
  return { task, repositoryId: 1340424953, parent: source, branch, runs, proofs, now: Date.parse('2026-10-11T00:00:00Z') };
}
function sourceReceipt(source) {
  const value = ci(source), pin = filename => ({ path: '/synthetic-ci-fixture/' + filename, bytes: 11, sha256: 'd'.repeat(64) });
  const members = [];
  const crc32 = raw => {
    let result = 0xffffffff;
    for (const byte of raw) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = result >>> 1 ^ (result & 1 ? 0xedb88320 : 0); }
    return (result ^ 0xffffffff) >>> 0;
  };
  const member = (filename, raw) => {
    const row = { path: filename, bytes: raw.length, sha256: sha(raw), crc32: crc32(raw) }; members.push(row); return row;
  };
  const stages = [[173, 'original-173'], [names.length, 'mirror-safety']].map(([expectedTests, name]) => {
    const caseNames = expectedTests === names.length ? [...names] : Array.from({ length: expectedTests }, (_, index) => '受控原叶case_' + (index + 1));
    const stdout = Buffer.from('TAP version 13\n' + caseNames.map((caseName, index) => 'ok ' + (index + 1) + ' - ' + caseName).join('\n')
      + '\n1..' + expectedTests + '\n' + Object.entries(counts(expectedTests)).map(([key, count]) => '# ' + key + ' ' + count).join('\n') + '\n');
    const stderr = Buffer.alloc(0);
    return { name, expectedTests, passed: true, exitCode: 0, signal: null, pid: 20001 + expectedTests,
      exitObserved: true, closeObserved: true, timedOut: false, overflow: false, spawnFailed: false, interrupted: false,
      cleanupFailed: false, terminationRequested: false, lingeringOwnedGroup: false,
      physicalShutdown: { pidAbsent: true, processGroupAbsent: true },
      observedDescendants: [], observedDescendantsAbsent: true, descendantScanFailed: false,
      rawForcedClosed: false, boundedSettleObserved: false, unexpectedPipeHolder: false,
      rawCaptureComplete: true, testCounts: counts(expectedTests), tapComplete: true,
      actualCaseNames: caseNames, expectedCaseNames: name === 'mirror-safety' ? caseNames : null, caseNamesMatched: true,
      raw: { stdout: member(name + '.stdout.log', stdout), stderr: member(name + '.stderr.log', stderr) } };
  });
  const sourceBefore = { identity: { head: source, status: '', branch, tree: sourceTree, commonDir: '/synthetic-ci-fixture/.git', gitDir: '/synthetic-ci-fixture/.git' } };
  const summary = { schema: 'musicbridge.ci-report-mirror.tool-gate.v1', task, status: 'PASSED_CURRENT_TOOL_GATE', success: true,
    headAtRun: source, sourceSha: source, repairRole: 'source', baseSha: base, productSoftwareSource: product,
    sourceInputsUnchanged: true, sourceBefore, sourceAfter: copy(sourceBefore), currentToolGateExitCode: 0, failures: [],
    originalTests: 173, safetyTests: names.length, expectedToolTests: 173 + names.length, stages,
    productTestsOrBuildsRepeated: false, softwareEvidenceMode: 'SKIPPED_REUSED_S165', productArtifactsCreated: 0,
    productionApp: 'NOT_RUN', realProviderDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' };
  const summaryRaw = Buffer.from(JSON.stringify(summary, null, 2) + '\n'); member('summary.json', summaryRaw);
  return { schema: 'musicbridge.root.ci-report-mirror.first-natural-ci191.v1',
    status: 'SEALED_FIRST_NATURAL_TOOL_CI_WITH_ORIGINAL_S165_SOFTWARE_REUSE', phase: 'source', task,
    revision: source, branch, repository: 'Matt12377/MusicBridge', repositoryId: value.repositoryId,
    recordedAt: '2026-10-11T00:00:00Z', code: null, before: { head: source, status: '' }, after: { head: source, status: '' },
    runs: value.runs, proofs: value.proofs, logs: value.proofs.flatMap(proof => proof.jobs.map(job => ({
      runId: proof.runId, jobId: job.id, jobName: job.name, raw: pin('job-' + job.id + '.log'),
      transport: 'DIRECT_GITHUB_API_302_AND_MEMORY_ONLY_SIGNED_URL', redirectLocationArchived: false,
      credentialsArchived: false, authorizationForwardedAcrossHosts: false,
    }))), artifacts: [{ id: 91001, name: 'verify-' + source, zip: pin('tool.zip'), members,
      allMembersBytesAndCrcRead: true, expandedBytes: 11, credentialsArchived: false,
      signedRedirectArchived: false, authorizationForwardedAcrossHosts: false,
      toolContent: { entry: 'summary.json', phase: 'source', result: summary, rawBase64: summaryRaw.toString('base64') } }],
    metadataFiles: [], oldProductSource: product, oldFailedReport: base,
    oldFailurePreserved: true, oldProductTestsRepeated: false, oldProductZipsDownloadedOrCrcReplayed: false,
    compiledAndApp: 'SKIPPED_REUSED_S165', reruns: 0, dispatches: 0,
    credentialsOrSignedRedirectArchived: false, realApplicationServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' };
}
function report(directory, source, sourceCi = sourceReceipt(source)) {
  checkout(directory, source); const repair = ciReportMirrorReportIdentity(source, sourceCi);
  for (const relative of reportPaths) {
    const filename = path.join(directory, relative);
    if (relative.endsWith('.md')) appendFileSync(filename, '\nCI_REPORT_MIRROR_001：仅受控Git分类fixture；不是平台CI或Owner验收。\n');
    else jsonEdit(directory, relative, value => {
      if (relative === 'project/STATUS.json') value.mobileContentMultidevice.ciRepair = copy(repair);
      else if (relative === 'project/POSTRUST_PLAN.json') value.mobile_tasks.find(row => row.id === 'MBM-004').ciRepair = copy(repair);
      else value.ciRepair = copy(repair);
    });
  }
  return commitWorking(directory, reportPaths, [source]);
}
function api(value, called) {
  return async route => {
    called?.push(route);
    if (route === '') return { id: value.repositoryId, private: false, full_name: 'Matt12377/MusicBridge' };
    if (route.startsWith('/actions/runs?')) return { total_count: value.runs.length, workflow_runs: value.runs };
    const id = Number(/\/runs\/(\d+)/u.exec(route)?.[1]), proof = value.proofs.find(row => row.runId === id);
    assert.ok(proof, '未知producer请求拒绝');
    return route.includes('/jobs?') ? { total_count: proof.jobs.length, jobs: proof.jobs }
      : { total_count: proof.artifacts.length, artifacts: proof.artifacts };
  };
}
async function reportRejected(directory, head, value = ci(fixtureSource), environment = hosted(head)) {
  const result = await inspectCiReportMirrorReportOnly(environment, directory, api(value));
  assert.equal(result.mode, 'full'); assert.notEqual(result.productResultsReused, true);
}

function preparationCode() {
  const lines = readFileSync(path.join(repository, '.github/workflows/verify.yml'), 'utf8').split('\n');
  const start = lines.indexOf('      - name: 准备准入正负例的精确历史Git对象'); assert.ok(start >= 0);
  let end = start + 1; while (end < lines.length && !/^      - name:/u.test(lines[end])) end++;
  const body = lines.slice(start, end), run = body.indexOf('        run: |'); assert.ok(run >= 0);
  return body.slice(run + 1).map(line => { assert.ok(line === '' || line.startsWith('          ')); return line.slice(10); }).join('\n');
}
function preparation(mirror, donor, expectedHead, extraEnvironment = {}) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', preparationCode()], {
    cwd: mirror, env: { ...process.env, ...extraEnvironment, GITHUB_WORKSPACE: donor, GITHUB_SHA: expectedHead },
    encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
}
function historyPresent(directory, ref) { return command(directory, ['cat-file', '-e', ref + '^{commit}'], { allowFailure: true }).status === 0; }

/** 完整真实workflow接线：guard先核donor，再由原镜像工具固定HEAD，最后共同本地历史prep。 */
function workflowMirror(donor, destination, expectedHead, root) {
  const environment = { ...fixtureEnvironment, GITHUB_SHA: expectedHead, GITHUB_REF_NAME: branch, DEV_BUILD_ROOT: root };
  delete environment.RUNNER_ENVIRONMENT;
  const commandFile = path.join(root, path.basename(destination) + '-github-env');
  writeFileSync(commandFile, '', { flag: 'wx', mode: 0o600 }); environment.GITHUB_ENV = commandFile;
  const invoke = args => {
    const result = spawnSync(process.execPath, args, { cwd: donor, env: environment,
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
  };
  const guardResult = invoke([path.join(donor, 'scripts/ci/ci-report-mirror-admission.mjs'), '--workflow-guard']);
  if (guardResult.status !== 0) return { status: guardResult.status, rejectedAt: 'REAL_WORKFLOW_GUARD', guardResult };
  const mirrorResult = invoke([path.join(donor, 'scripts/ci/prepare-build-workspace-mirror.mjs'),
    '--source', donor, '--destination', destination, '--expected-head', expectedHead]);
  if (mirrorResult.status !== 0) return { status: mirrorResult.status, rejectedAt: 'ORIGINAL_SOURCE_PINNED_MIRROR', guardResult, mirrorResult };
  const historicalResult = preparation(destination, donor, expectedHead);
  return { status: historicalResult.status, rejectedAt: historicalResult.status === 0 ? null : 'EXACT_TWO_OBJECTS_PREPARATION',
    guardResult, mirrorResult, historicalResult };
}

const behaviors = [
  t => {
    const value = fixture(t), admitted = inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment);
    assert.equal(admitted.headAtAdmission, value.source); assert.equal(admitted.baseSha, base);
    assert.equal(admitted.productSource, product); assert.equal(admitted.repairRole, 'source');
    assert.equal(admitted.currentToolGateRequired, true); assert.equal(admitted.currentProductTestsRepeated, false);
    const scopeBytes = readFileSync(path.join(value.directory, scopePath));
    assert.equal(assertCiReportMirrorScope(JSON.parse(scopeBytes), scopeBytes).files.length, 12);
    assert.equal(ciReportMirrorWorkflowOutputs(admitted).repairMode, 'reuse-s165');
    assert.equal(taskApplicabilityWorkflowOutputs(inspectTaskApplicability(value.directory, fixtureEnvironment)).repairMode, 'reuse-s165');
    assert.equal(command(value.directory, ['diff', '--name-only', base, value.source]).split('\n').length, 12);
    assert.equal(command(value.directory, ['status', '--porcelain']), '');
  },
  async t => {
    const value = fixture(t), head = report(value.directory, value.source);
    const admitted = inspectCiReportMirrorReportAdmission(value.directory, fixtureEnvironment);
    assert.equal(admitted.sourceSha, value.source); assert.equal(admitted.headAtAdmission, head);
    assert.equal(admitted.repairRole, 'report'); assert.equal(admitted.productSource, product);
    const local = await inspectReportOnly(hosted(head), value.directory, api(ci(value.source)));
    assert.equal(local.mode, 'report-only'); assert.equal(local.reason, 'EXACT_PARENT_CI_REPAIR_GATE_SUCCESS');
    assert.equal(local.parentSourceSha, value.source); assert.equal(local.productSoftwareSource ?? local.productSource, product);
    assert.equal(command(value.directory, ['diff', '--name-only', value.source, head]).split('\n').length, 8);
    t.diagnostic('LOCAL_REPORT_CLASSIFICATION_WITH_HOSTED_CONTEXT_VALUES；无平台API或实际hosted CI执行。');
  },
  t => {
    const value = fixture(t);
    for (const parents of [[product], [base, product]]) {
      const head = commitTree(value.directory, sourceTree, parents, '受控错误Source父链'); checkout(value.directory, head);
      assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
    }
  },
  t => {
    const value = fixture(t); command(value.directory, ['checkout', '-B', branch + '-unknown']);
    assert.throws(() => inspectCiReportMirrorAdmission(value.directory, { ...fixtureEnvironment, GITHUB_REF_NAME: branch }), rejected);
    checkout(value.directory, value.source);
    const dirty = path.join(value.directory, 'ci-fixture-untracked.txt'); writeFileSync(dirty, '自有未跟踪变异\n', { flag: 'wx' });
    try { assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected); } finally { rmSync(dirty); }
    appendFileSync(path.join(value.directory, sourcePaths[0]), '\n');
    assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
  },
  async t => {
    const value = fixture(t), decoy = clone(value.directory, path.join(value.root, 'decoy'), value.source);
    try {
      const wrong = commitTree(value.directory, sourceTree, [product], '实际错误父链'); checkout(value.directory, wrong);
      for (const redirect of [{ GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy },
        { GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: path.join(decoy, '.git/index'),
          GIT_OBJECT_DIRECTORY: path.join(decoy, '.git/objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy, '.git/objects') },
        { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: decoy }]) {
        assert.throws(() => inspectCiReportMirrorAdmission(value.directory, { ...fixtureEnvironment, ...redirect }), rejected);
        const calls = [], result = await inspectReportOnly({ ...hosted(wrong), ...redirect }, value.directory, api(ci(value.source), calls));
        assert.equal(result.mode, 'full'); assert.equal(calls.length, 0);
      }
      assert.equal(command(value.directory, ['rev-parse', 'HEAD']), wrong);
    } finally { rmSync(decoy, { recursive: true, force: false }); }
  },
  t => {
    const value = fixture(t);
    for (const [relative, text] of [['shallow', value.source + '\n'], ['info/grafts', value.source + ' ' + product + '\n'],
      ['objects/info/alternates', path.join(repository, '.git/objects') + '\n']]) {
      const filename = path.join(value.directory, '.git', relative); mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, text, { flag: 'wx' });
      try { assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected); } finally { rmSync(filename); }
    }
    command(value.directory, ['replace', base, product]);
    try { assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected); }
    finally { command(value.directory, ['replace', '-d', base]); }
  },
  t => {
    const value = fixture(t), extra = 'packages/bridge-core/src/ci-mirror-escape.ts';
    writeFileSync(path.join(value.directory, extra), 'export const 逃逸 = true;\n', { flag: 'wx' });
    commitWorking(value.directory, [extra]); assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
    checkout(value.directory, value.source);
    const productPath = 'packages/bridge-core/src/runtime.ts'; appendFileSync(path.join(value.directory, productPath), '\n');
    commitWorking(value.directory, [productPath]); assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
  },
  t => {
    const value = fixture(t), original = record(path.join(value.directory, scopePath));
    for (const edit of [v => { v.files.pop(); }, v => { v.files[0].role = 'product'; },
      v => { v.files[0].sha256 = 'f'.repeat(64); }, v => { v.files[0].oldMode = '120000'; },
      v => { v.files[0].status = 'M'; }, v => { v.reportPaths.push('reports/EXTRA.md'); }]) {
      checkout(value.directory, value.source); const changed = copy(original); edit(changed);
      writeFileSync(path.join(value.directory, scopePath), JSON.stringify(changed, null, 2) + '\n');
      commitWorking(value.directory, [scopePath]); assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
    }
    checkout(value.directory, value.source); chmodSync(path.join(value.directory, '.github/workflows/security.yml'), 0o755);
    commitWorking(value.directory, ['.github/workflows/security.yml']);
    assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
    checkout(value.directory, value.source); const target = path.join(value.directory, 'tasks/CI-REPORT-MIRROR-001.md'); rmSync(target);
    symlinkSync('CI-REPORT-MIRROR-001.md.missing', target); commitWorking(value.directory, ['tasks/CI-REPORT-MIRROR-001.md']);
    assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
  },
  t => {
    const value = fixture(t), changed = copy(CI_REPORT_MIRROR_CORRECTION_IDENTITY);
    changed.productSource = 'b'.repeat(40); assert.throws(() => assertCiReportMirrorCorrection(changed), rejected);
    writeFileSync(path.join(value.directory, correctionPath), JSON.stringify(changed, null, 2) + '\n');
    commitWorking(value.directory, [correctionPath]); assert.throws(() => inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment), rejected);
  },
  async t => {
    const value = fixture(t), valid = report(value.directory, value.source), tree = command(value.directory, ['rev-parse', valid + '^{tree}']);
    for (const parents of [[base], [value.source, base]]) {
      const head = commitTree(value.directory, tree, parents, '受控错误Report父链'); checkout(value.directory, head);
      assert.throws(() => inspectCiReportMirrorReportAdmission(value.directory, fixtureEnvironment), rejected);
      await reportRejected(value.directory, head);
    }
    checkout(value.directory, valid); const extra = 'reports/CI-MIRROR-EXTRA.md'; writeFileSync(path.join(value.directory, extra), '自有第九路径\n');
    const head = commitWorking(value.directory, [extra], [value.source]);
    assert.throws(() => inspectCiReportMirrorReportAdmission(value.directory, fixtureEnvironment), rejected); await reportRejected(value.directory, head);
  },
  async t => {
    const value = fixture(t), valid = report(value.directory, value.source);
    for (const relative of [scopePath, correctionPath, 'docs/postrust/MBM-004/LOCAL_SOFTWARE_EVIDENCE.json', 'packages/bridge-core/src/runtime.ts']) {
      checkout(value.directory, valid); appendFileSync(path.join(value.directory, relative), '\n');
      const head = commitWorking(value.directory, [relative], [value.source]);
      assert.throws(() => inspectCiReportMirrorReportAdmission(value.directory, fixtureEnvironment), rejected); await reportRejected(value.directory, head);
    }
    checkout(value.directory, valid); chmodSync(path.join(value.directory, 'reports/MBM-004_RESULT.md'), 0o755);
    const head = commitWorking(value.directory, ['reports/MBM-004_RESULT.md'], [value.source]);
    assert.throws(() => inspectCiReportMirrorReportAdmission(value.directory, fixtureEnvironment), rejected); await reportRejected(value.directory, head);
  },
  async t => {
    const value = fixture(t), valid = report(value.directory, value.source);
    const originalPlan = record(path.join(value.directory, 'project/POSTRUST_PLAN.json'));
    assert.equal(originalPlan.tasks.length, 18); assert.equal(originalPlan.acceptance_cases.length, 156);
    for (const [relative, edit] of [['project/POSTRUST_PLAN.json', v => { v.tasks[0].status = 'PASSED'; }],
      ['project/POSTRUST_PLAN.json', v => { v.acceptance_cases.pop(); }],
      ['project/POSTRUST_PLAN.json', v => { v.mobile_tasks.find(row => row.id === 'MBM-004').owner_acceptance = 'PASSED'; }],
      ['project/STATUS.json', v => { v.mobileContentMultidevice.productionApp = 'PASSED'; }]]) {
      checkout(value.directory, valid); jsonEdit(value.directory, relative, edit);
      const head = commitWorking(value.directory, [relative], [value.source]);
      assert.throws(() => inspectCiReportMirrorReportAdmission(value.directory, fixtureEnvironment), rejected); await reportRejected(value.directory, head);
    }
  },
  t => {
    const value = fixture(t), actual = inspectCiReportMirrorAdmission(value.directory, fixtureEnvironment);
    for (const forged of [{ task }, copy(actual), { ...actual, repairMode: 'reuse-s165' }]) {
      assert.throws(() => ciReportMirrorWorkflowOutputs(forged), rejected);
      assert.throws(() => taskApplicabilityWorkflowOutputs(forged));
    }
    assert.equal(ciReportMirrorWorkflowOutputs(actual).repairMode, 'reuse-s165');
  },
  t => {
    const value = fixture(t), head = command(repository, ['rev-parse', 'HEAD']);
    const mirror = clone(repository, path.join(value.root, 'missing-history'), head);
    try {
      for (const ref of originalHistory) assert.equal(historyPresent(mirror, ref), false);
      const before = command(mirror, ['show-ref']);
      assert.throws(() => inspectCiReportMirrorHistoricalObjects(mirror, process.env), rejected);
      for (const ref of originalHistory) assert.equal(historyPresent(mirror, ref), false);
      assert.equal(command(mirror, ['show-ref']), before);
      const leaf = path.join(mirror, 'scripts/ci/test/tape-catalog-common-admission.test.mjs'); rmSync(leaf);
      const skipped = preparation(mirror, '/nonexistent-ci-fixture-donor', head);
      assert.equal(skipped.status, 0, skipped.stderr);
      for (const ref of originalHistory) assert.equal(historyPresent(mirror, ref), false);
      assert.equal(existsSync(path.join(mirror, '.git/FETCH_HEAD')), false);
    } finally { rmSync(mirror, { recursive: true, force: false }); }
  },
  t => {
    const value = fixture(t), actualHead = command(repository, ['rev-parse', 'HEAD']);
    const mirror = path.join(value.root, 'workflow-good', 'exact-history');
    try {
      const before = command(repository, ['rev-parse', 'HEAD^{tree}']);
      command(value.directory, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
        repository, ...originalHistory]);
      for (const ref of originalHistory) assert.equal(historyPresent(value.directory, ref), true);
      const wrongDestination = path.join(value.root, 'workflow-wrong', 'wrong-donor-mirror');
      const wrong = workflowMirror(value.directory, wrongDestination, actualHead, value.root);
      assert.notEqual(wrong.status, 0, '不同HEAD donor先由真实guard拒绝');
      assert.equal(wrong.rejectedAt, 'REAL_WORKFLOW_GUARD'); assert.equal(existsSync(wrongDestination), false);
      const good = workflowMirror(repository, mirror, actualHead, value.root);
      assert.equal(good.status, 0, good.historicalResult?.stderr ?? good.mirrorResult?.stderr);
      for (const ref of originalHistory) assert.equal(historyPresent(mirror, ref), true);
      const verified = inspectCiReportMirrorHistoricalObjects(mirror, process.env); assert.ok(verified);
      assert.equal(command(mirror, ['rev-parse', 'HEAD']), actualHead);
      assert.equal(command(mirror, ['status', '--porcelain']), '');
      assert.equal(command(repository, ['rev-parse', 'HEAD^{tree}']), before);
      for (const pin of CI_REPORT_MIRROR_ORIGINAL_TESTS) {
        const raw = readFileSync(path.join(mirror, pin.path)); assert.equal(raw.length, pin.bytes); assert.equal(sha(raw), pin.sha256);
      }
      t.diagnostic('自有独立mirror仅local donor固定两完整SHA；未网络fetch、未重跑历史186。');
      const incompleteDonor = clone(repository, path.join(value.root, 'one-object-donor'), actualHead);
      command(incompleteDonor, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
        repository, originalHistory[0]]);
      assert.equal(historyPresent(incompleteDonor, originalHistory[1]), false);
      const incompleteDestination = path.join(value.root, 'workflow-missing', 'one-object-mirror');
      const missing = workflowMirror(incompleteDonor, incompleteDestination, actualHead, value.root);
      assert.notEqual(missing.status, 0); assert.equal(missing.rejectedAt, 'EXACT_TWO_OBJECTS_PREPARATION');
      assert.throws(() => inspectCiReportMirrorHistoricalObjects(incompleteDestination, process.env), rejected);
    } finally { if (existsSync(mirror)) rmSync(mirror, { recursive: true, force: false }); }
  },
  t => {
    const value = fixture(t), proof = ci(value.source);
    assert.equal(validateCiReportMirrorParentCi(proof), true);
    assert.equal(validateCiReportMirrorSourceReceipt(sourceReceipt(value.source), value.source), true);
    assert.equal(proof.runs.length, 4); assert.equal(proof.proofs.flatMap(row => row.jobs).length, 6);
    assert.equal(proof.proofs.flatMap(row => row.artifacts).length, 1);
    t.diagnostic('producer fixture为受控合成元数据；无平台请求、无真实工具ZIP内容消费。');
  },
  async t => {
    const value = fixture(t), head = report(value.directory, value.source);
    for (const [index, edit] of [v => { v.runs[0].conclusion = 'failure'; }, v => { v.runs.push(copy(v.runs[0])); },
      v => { v.proofs[0].jobs[0].conclusion = 'failure'; }, v => { v.proofs[0].jobs[0].steps.find(row => row.name === toolGate).conclusion = 'skipped'; },
      v => { v.proofs[0].jobs[0].steps.find(row => row.name === originalNegative).conclusion = 'success'; },
      v => { v.proofs[2].jobs.pop(); }, v => { v.proofs[0].artifacts[0].expired = true; },
      v => { v.runs[0].run_attempt = 2; }, v => { v.runs[0].head_sha = product; },
      v => { v.proofs[1].runId = v.proofs[0].runId; }, v => { v.now = NaN; }].entries()) {
      const changed = ci(value.source); edit(changed); assert.equal(validateCiReportMirrorParentCi(changed), false);
      // 全部producer变异验严格判定；实际报告API接线分别核失败、重复run和工具skipped。
      if ([0, 1, 3].includes(index)) await reportRejected(value.directory, head, changed);
    }
  },
  async t => {
    const value = fixture(t), head = report(value.directory, value.source);
    for (const [proofIndex, jobIndex, stepName] of [[0, 0, 'MBM004 内容与多设备软件 Gate'],
      [0, 0, 'Verify platform-independent workspace (typecheck, unit tests, build; no Electron)'],
      [1, 0, 'Run directed platform-independent security tests (no Electron)'],
      [2, 0, '验证实际 Rust 与 TypeScript 边界'],
      [3, 0, 'Electron end-to-end flow (Playwright, production build)']]) {
      const changed = ci(value.source); changed.proofs[proofIndex].jobs[jobIndex].steps.find(row => row.name === stepName).conclusion = 'success';
      assert.equal(validateCiReportMirrorParentCi(changed), false);
      if (proofIndex === 0 && stepName === 'MBM004 内容与多设备软件 Gate') await reportRejected(value.directory, head, changed);
    }
    const fabricated = sourceReceipt(value.source); fabricated.oldProductTestsRepeated = true;
    assert.equal(validateCiReportMirrorSourceReceipt(fabricated, value.source), false);
    const decodedDrift = sourceReceipt(value.source); decodedDrift.artifacts[0].toolContent.result.success = false;
    assert.equal(validateCiReportMirrorSourceReceipt(decodedDrift, value.source), false);
    const rawDrift = sourceReceipt(value.source); rawDrift.artifacts[0].toolContent.rawBase64 = Buffer.from('{}\n').toString('base64');
    assert.equal(validateCiReportMirrorSourceReceipt(rawDrift, value.source), false);
  },
  async t => {
    const value = fixture(t), outputRoot = path.join(value.root, 'capture-success'); mkdirSync(outputRoot, { mode: 0o700 });
    const stdout = '完整stdout原字节\n', stderr = '完整stderr原字节\n';
    const result = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'natural',
      args: ['-e', 'process.stdout.write(' + JSON.stringify(stdout) + ');process.stderr.write(' + JSON.stringify(stderr) + ')'],
      timeoutMs: 5_000, env: ciReportMirrorGitEnvironment(process.env) });
    assert.equal(result.passed, true); assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
    assert.ok(result.durationMs <= result.budgetMs);
    assert.equal(result.exitObserved, true); assert.equal(result.closeObserved, true); assert.equal(result.rawCaptureComplete, true);
    assert.deepEqual(result.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    for (const [stream, expected] of [['stdout', stdout], ['stderr', stderr]]) {
      const raw = readFileSync(path.join(outputRoot, result.raw[stream].path));
      assert.equal(raw.toString('utf8'), expected); assert.equal(raw.length, result.raw[stream].bytes); assert.equal(sha(raw), result.raw[stream].sha256);
      assert.equal(lstatSync(path.join(outputRoot, result.raw[stream].path)).mode & 0o777, 0o600);
    }
  },
  async t => {
    const value = fixture(t), outputRoot = path.join(value.root, 'capture-failures'); mkdirSync(outputRoot, { mode: 0o700 });
    const timeout = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'timeout',
      args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 500 });
    assert.equal(timeout.passed, false); assert.equal(timeout.timedOut, true); assert.equal(timeout.terminationRequested, true);
    assert.deepEqual(timeout.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    const overflow = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'overflow',
      args: ['-e', 'process.stdout.write(Buffer.alloc(8192,65));setInterval(()=>{},1000)'], timeoutMs: 5_000, maxBytesPerStream: 1024 });
    assert.equal(overflow.passed, false); assert.equal(overflow.overflow, true); assert.equal(overflow.rawCaptureComplete, false);
    assert.equal(overflow.raw.stdout.bytes, 1024); assert.deepEqual(overflow.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    const lingering = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'lingering',
      args: ['-e', "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),200)"], timeoutMs: 5_000 });
    assert.equal(lingering.passed, false); assert.equal(lingering.lingeringOwnedGroup, true);
    assert.deepEqual(lingering.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    const escaped = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'detached-pipe',
      args: ['-e', "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});c.unref();setTimeout(()=>process.exit(0),200)"], timeoutMs: 5_000 });
    assert.equal(escaped.passed, false); assert.equal(escaped.unexpectedPipeHolder, true);
    assert.ok(escaped.observedDescendants.length > 0);
    assert.ok(escaped.durationMs <= escaped.budgetMs || escaped.timedOut);
    const psDirectory = path.join(value.root, 'owned-failed-ps'); mkdirSync(psDirectory, { mode: 0o700 });
    writeFileSync(path.join(psDirectory, 'ps'), '#!/bin/sh\nexit 1\n', { flag: 'wx', mode: 0o700 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = psDirectory + path.delimiter + (previousPath ?? '');
      const failedPs = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'failed-ps',
        args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 500 });
      assert.equal(failedPs.passed, false); assert.equal(failedPs.descendantScanFailed, true);
      assert.equal(failedPs.cleanupFailed, true); assert.equal(failedPs.terminationRequested, true);
      assert.deepEqual(failedPs.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
    assert.throws(() => validateCiReportMirrorGateArguments(['--output-root', outputRoot, '--stage-ms', '999999']));
    assert.throws(() => validateCiReportMirrorGateArguments(['--output-root', outputRoot], { ...process.env, NODE_OPTIONS: '--require=/synthetic/override' }));
  },
];

if (behaviors.length !== names.length) throw new Error('镜像修复安全测试闭集不完整。');
for (const [index, behavior] of behaviors.entries()) test(names[index], async t => {
  // 每项同步Git检查前让出事件循环，使真实TAP进度可以排空。
  await new Promise(resolve => setImmediate(resolve));
  return behavior(t);
});
