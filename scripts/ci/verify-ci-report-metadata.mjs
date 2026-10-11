import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_REPORT_MIRROR_GATE_LIMITS, CI_REPORT_MIRROR_ORIGINAL_TESTS,
  captureCiReportMirrorStage, ciReportMirrorGitEnvironment,
  validateCiReportMirrorGateArguments } from './verify-ci-report-mirror.mjs';
import { CI_REPORT_METADATA_TASK, CI_REPORT_METADATA_BRANCH, CI_REPORT_METADATA_BASE,
  CI_REPORT_METADATA_PRODUCT_SOURCE, CI_REPORT_METADATA_SOURCE_FILES, CI_REPORT_METADATA_REPORT_PATHS,
  inspectCiReportMetadataAdmission, inspectCiReportMetadataReportAdmission,
  inspectCiReportMetadataHistoricalObjects, inspectCiReportMetadataEncoding } from './ci-report-metadata-admission.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const within = (value, root) => value.startsWith(root + path.sep);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closedCode = error => /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'CI_REPORT_METADATA_GATE_FAILED';
function refuse(code) { const error = new Error('报告元数据工具 Gate 拒绝。'); error.code = code; throw error; }

// 限额与进程捕获器沿用已封口001工具，不扩大旧产品验证预算。
export const CI_REPORT_METADATA_GATE_LIMITS = CI_REPORT_MIRROR_GATE_LIMITS;
export const CI_REPORT_METADATA_ORIGINAL_TESTS = CI_REPORT_MIRROR_ORIGINAL_TESTS;
export const CI_REPORT_METADATA_SAFETY_CASE_NAMES = Object.freeze([
  '元数据修复复现原失败报告24个URL触发控制面拒绝',
  '元数据修复Source状态投影与完整历史CI证据连续绑定',
  '元数据修复直接Report摘要与当前完整CI证据连续绑定',
  '元数据修复未知字段URL与凭据不能进入状态摘要',
  '元数据修复Source十三路径与冻结角色模式完整准入',
  '元数据修复Source错误父链多父dirty及Git重定向拒绝',
  '元数据修复冻结Scope原001历史和产品字节不可漂移',
  '元数据修复Report唯一八路径父链模式与账本完整准入',
  '元数据修复摘要遗漏必需事实和CI证据digest漂移拒绝',
  '元数据修复真实路由Source需fresh工具Gate且坏报告不访问API',
  '元数据修复实际workflow镜像与两历史对象保持闭合',
  '元数据修复四workflow六job唯一新工具artifact producer闭合',
  '元数据修复失败重复retry与旧产品伪PASS不能取得复用',
  '元数据修复wholeZIP成员与三阶段raw及summary原字节连续绑定',
  '元数据修复旧Source1资格与新Source报告CI不能互相替代',
  '元数据修复复用捕获器有界退出完整raw与物理关闭',
]);
export const CI_REPORT_METADATA_INHERITED_INPUTS = Object.freeze([
  ['docs/postrust/MBM-004/CI_CORRECTION.json', 2751, '54f433e6a766cd52de98cc3c52780a71e179f669544f16488e31165e6f65d6bf'],
  ['docs/postrust/MBM-004/CI_CORRECTION_SCOPE.json', 4599, 'fda50be2ca457dd601335bd56553c6a3ac4dadc12a40007154d26d9704074702'],
  ['scripts/ci/ci-report-mirror-admission.mjs', 51638, 'e668fcfa9211073f7562814c9197399d817fddb7a6cfc2b80e95deff393782bb'],
  ['scripts/ci/verify-ci-report-mirror.mjs', 29505, '619d477242dd4b6c13045b91819dbebad151e43b829f6184f74cd98d3d87c070'],
  ['scripts/ci/test/ci-report-mirror.test.mjs', 41456, '939b3d01deb39acebb4c6a3d20da927193cdb382548c81949e2c3cbced2da9d7'],
  ['scripts/ci/verify-control-plane.mjs', 7033, 'c2f4f6c2d3dd077be39fe6157114af7d8957ff271323a7c9d46aecc4092aa784'],
].map(([relative, bytes, sha256]) => Object.freeze({ path: relative, bytes, sha256 })));
export const CI_REPORT_METADATA_CONTROL_PLANE_RAW = Object.freeze({
  stdout: { bytes: 19, sha256: hash(Buffer.from('CONTROL_PLANE=PASS\n')) },
  stderr: { bytes: 0, sha256: hash(Buffer.alloc(0)) },
});

function checkDeadline(deadline) {
  if (!Number.isFinite(deadline) || performance.now() >= deadline) refuse('CI_REPORT_METADATA_WHOLE_TIMEOUT');
}
function git(directory, args, env, deadline) {
  checkDeadline(deadline);
  const timeout = Math.floor(Math.min(CI_REPORT_METADATA_GATE_LIMITS.gitMs, deadline - performance.now()));
  if (timeout < 1) refuse('CI_REPORT_METADATA_WHOLE_TIMEOUT');
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args], {
    cwd: directory, env: ciReportMirrorGitEnvironment(env), timeout, killSignal: 'SIGKILL',
    maxBuffer: CI_REPORT_METADATA_GATE_LIMITS.gitBytes, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal !== null || result.status !== 0) refuse('CI_REPORT_METADATA_GIT_READ_FAILED');
  checkDeadline(deadline); return result.stdout;
}
function identity(directory, env, deadline) {
  const top = git(directory, ['rev-parse', '--show-toplevel'], env, deadline).trim();
  const commonDir = git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env, deadline).trim();
  const gitDir = git(directory, ['rev-parse', '--path-format=absolute', '--git-dir'], env, deadline).trim();
  if (top !== directory || commonDir !== path.join(directory, '.git') || gitDir !== commonDir
    || !lstatSync(commonDir).isDirectory() || lstatSync(commonDir).isSymbolicLink()
    || realpathSync(commonDir) !== commonDir) refuse('CI_REPORT_METADATA_INDEPENDENT_GIT_REQUIRED');
  const head = git(directory, ['rev-parse', '--verify', 'HEAD'], env, deadline).trim();
  const tree = git(directory, ['rev-parse', '--verify', 'HEAD^{tree}'], env, deadline).trim();
  const branch = git(directory, ['branch', '--show-current'], env, deadline).trim();
  const status = git(directory, ['status', '--porcelain=v1', '--untracked-files=all'], env, deadline);
  if (!/^[a-f0-9]{40}$/u.test(head) || !/^[a-f0-9]{40}$/u.test(tree)
    || branch !== CI_REPORT_METADATA_BRANCH || status !== '') refuse('CI_REPORT_METADATA_CHECKOUT_NOT_PINNED_CLEAN');
  return { head, tree, branch, status, commonDir, gitDir };
}
function wholeFile(directory, relative, deadline) {
  checkDeadline(deadline);
  const filename = path.join(directory, relative), initial = lstatSync(filename);
  if (!initial.isFile() || initial.isSymbolicLink() || (initial.mode & 0o777) !== 0o644
    || initial.size > CI_REPORT_METADATA_GATE_LIMITS.gitBytes || realpathSync(filename) !== filename)
    refuse('CI_REPORT_METADATA_INPUT_FILE_INVALID');
  let descriptor, raw;
  try {
    descriptor = openSync(filename, 'r'); const opened = fstatSync(descriptor);
    if (opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size)
      refuse('CI_REPORT_METADATA_INPUT_CHANGED_DURING_READ');
    raw = Buffer.alloc(opened.size); let offset = 0;
    while (offset < raw.length) {
      checkDeadline(deadline); const bytes = readSync(descriptor, raw, offset, Math.min(65536, raw.length - offset), offset);
      if (bytes < 1) refuse('CI_REPORT_METADATA_INPUT_CHANGED_DURING_READ'); offset += bytes;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== initial.dev || after.ino !== initial.ino || after.size !== initial.size
      || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs)
      refuse('CI_REPORT_METADATA_INPUT_CHANGED_DURING_READ');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  const final = lstatSync(filename);
  if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size
    || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs)
    refuse('CI_REPORT_METADATA_INPUT_CHANGED_DURING_READ');
  checkDeadline(deadline); return { path: relative, bytes: raw.length, sha256: hash(raw), mode: '100644' };
}

/** 新13/8域自行准入；旧001只复用捕获器、存储和原173叶pin。 */
export function inspectCiReportMetadataGateInputs(directory, env = process.env,
  deadline = performance.now() + CI_REPORT_METADATA_GATE_LIMITS.wholeMs) {
  const currentIdentity = identity(directory, env, deadline);
  const parents = git(directory, ['rev-list', '--parents', '-n', '1', currentIdentity.head], env, deadline).trim().split(' ');
  if (parents.length !== 2 || parents[0] !== currentIdentity.head) refuse('CI_REPORT_METADATA_UNIQUE_PARENT_REQUIRED');
  const repairRole = parents[1] === CI_REPORT_METADATA_BASE ? 'source' : 'report';
  const admission = repairRole === 'source' ? inspectCiReportMetadataAdmission(directory, env, { deadline })
    : inspectCiReportMetadataReportAdmission(directory, env, { deadline });
  if (admission.task !== CI_REPORT_METADATA_TASK || admission.repairRole !== repairRole
    || admission.headAtAdmission !== currentIdentity.head || admission.productSource !== CI_REPORT_METADATA_PRODUCT_SOURCE
    || admission.currentToolGateRequired !== true || admission.currentProductTestsRepeated !== false)
    refuse('CI_REPORT_METADATA_CURRENT_ADMISSION_REQUIRED');
  const historicalObjects = inspectCiReportMetadataHistoricalObjects(directory, env, { deadline });
  const originalTests = CI_REPORT_METADATA_ORIGINAL_TESTS.map(expected => {
    const actual = wholeFile(directory, expected.path, deadline);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) refuse('CI_REPORT_METADATA_ORIGINAL_173_INPUT_DRIFT');
    return { ...actual, expectedTests: expected.expectedTests };
  });
  const inheritedInputs = CI_REPORT_METADATA_INHERITED_INPUTS.map(expected => {
    const actual = wholeFile(directory, expected.path, deadline);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) refuse('CI_REPORT_METADATA_INHERITED_INPUT_DRIFT');
    return actual;
  });
  const sourcePaths = CI_REPORT_METADATA_SOURCE_FILES.map(row => typeof row === 'string' ? row : row.path);
  const reportPaths = CI_REPORT_METADATA_REPORT_PATHS.map(row => typeof row === 'string' ? row : row.path);
  if (sourcePaths.length !== 13 || reportPaths.length !== 8 || new Set(sourcePaths).size !== 13
    || new Set(reportPaths).size !== 8 || originalTests.reduce((sum, row) => sum + row.expectedTests, 0) !== 173
    || CI_REPORT_METADATA_SAFETY_CASE_NAMES.length !== 16) refuse('CI_REPORT_METADATA_TOOL_INPUT_CLOSED_SET_INVALID');
  const currentFiles = [...new Set([...sourcePaths, 'docs/postrust/MBM-004/CI_EVIDENCE.json',
    ...(repairRole === 'report' ? reportPaths : [])])].sort().map(relative => wholeFile(directory, relative, deadline));
  const encodingProof = inspectCiReportMetadataEncoding(directory, env, { deadline });
  for (const key of ['status', 'evidence']) {
    const expected = currentFiles.find(row => row.path === encodingProof[key]?.path);
    if (!expected || !same(encodingProof[key], { path: expected.path, bytes: expected.bytes, sha256: expected.sha256 }))
      refuse('CI_REPORT_METADATA_ENCODING_PIN_NOT_CURRENT');
  }
  if (encodingProof.jsonPointer !== (repairRole === 'source' ? '/ciRepair/sourceCi' : '/ciReportMetadata'))
    refuse('CI_REPORT_METADATA_ENCODING_POINTER_INVALID');
  checkDeadline(deadline);
  return { identity: currentIdentity, admission, historicalObjects, originalTests, inheritedInputs, currentFiles, encodingProof };
}

export function validateCiReportMetadataGateArguments(argv, env = process.env) {
  // 复用原已验证的Node22/外置卷/hosted专用子树/新目录wx策略。
  return validateCiReportMirrorGateArguments(argv, env);
}
function writeJson(outputRoot, name, value) {
  writeFileSync(path.join(outputRoot, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function controlPlanePassed(stage) {
  return stage?.passed === true && stage.expectedTests === null && stage.testCounts === null
    && stage.expectedCaseNames === null && same(stage.actualCaseNames, [])
    && ['stdout', 'stderr'].every(stream => stage.raw[stream].bytes === CI_REPORT_METADATA_CONTROL_PLANE_RAW[stream].bytes
      && stage.raw[stream].sha256 === CI_REPORT_METADATA_CONTROL_PLANE_RAW[stream].sha256);
}

/** 本轮工具与编码证明，不触发原产品Gate、编译、Provider或App。 */
export async function runCiReportMetadataGate(argv = process.argv.slice(2), env = process.env) {
  const began = performance.now(), startedAtMs = Date.now(), deadline = began + CI_REPORT_METADATA_GATE_LIMITS.wholeMs;
  const storage = validateCiReportMetadataGateArguments(argv, env);
  const before = inspectCiReportMetadataGateInputs(repository, env, deadline);
  checkDeadline(deadline); storage.storage.check(storage.outputRoot); mkdirSync(storage.outputRoot, { mode: 0o700 });
  const outputIdentity = lstatSync(storage.outputRoot);
  if ((outputIdentity.mode & 0o777) !== 0o700) refuse('CI_REPORT_METADATA_PRIVATE_RUN_REQUIRED');
  const temporary = path.join(storage.outputRoot, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const temporaryIdentity = lstatSync(temporary);
  writeJson(storage.outputRoot, 'source-before.json', before);
  const childEnvironment = ciReportMirrorGitEnvironment({ ...env, TMPDIR: temporary });
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete childEnvironment[key];
  const stages = [], failures = []; let after = null, temporaryCleanup = { createdByThisGate: true, removed: false };
  try {
    stages.push(await captureCiReportMirrorStage({ directory: repository, outputRoot: storage.outputRoot,
      name: 'original-173', args: ['--test', ...CI_REPORT_METADATA_ORIGINAL_TESTS.map(row => row.path)],
      env: childEnvironment, expectedTests: 173, deadline }));
    if (!stages.at(-1).passed) refuse('CI_REPORT_METADATA_ORIGINAL_173_NOT_COMPLETE');
    stages.push(await captureCiReportMirrorStage({ directory: repository, outputRoot: storage.outputRoot,
      name: 'control-plane', args: ['scripts/ci/verify-control-plane.mjs'], env: childEnvironment, deadline }));
    if (!controlPlanePassed(stages.at(-1))) refuse('CI_REPORT_METADATA_CONTROL_PLANE_ENCODING_NOT_PASSED');
    stages.push(await captureCiReportMirrorStage({ directory: repository, outputRoot: storage.outputRoot,
      name: 'metadata-safety', args: ['--test', '--test-reporter=tap', 'scripts/ci/test/ci-report-metadata.test.mjs'],
      env: childEnvironment, expectedTests: CI_REPORT_METADATA_SAFETY_CASE_NAMES.length,
      expectedCaseNames: [...CI_REPORT_METADATA_SAFETY_CASE_NAMES], deadline }));
    if (!stages.at(-1).passed) refuse('CI_REPORT_METADATA_SAFETY_NOT_COMPLETE');
    checkDeadline(deadline);
    const currentTemporary = lstatSync(temporary), currentOutput = lstatSync(storage.outputRoot);
    if (currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino
      || currentOutput.dev !== outputIdentity.dev || currentOutput.ino !== outputIdentity.ino
      || !currentTemporary.isDirectory() || currentTemporary.isSymbolicLink() || (currentTemporary.mode & 0o777) !== 0o700
      || !currentOutput.isDirectory() || currentOutput.isSymbolicLink() || (currentOutput.mode & 0o777) !== 0o700
      || realpathSync(temporary) !== temporary || realpathSync(storage.outputRoot) !== storage.outputRoot
      || !within(temporary, storage.outputRoot) || stages.some(row => !row.passed
        || row.physicalShutdown.pidAbsent !== true || row.physicalShutdown.processGroupAbsent !== true
        || row.observedDescendantsAbsent !== true || row.rawCaptureComplete !== true))
      refuse('CI_REPORT_METADATA_TMP_CLEANUP_NOT_OWNED_OR_CLOSED');
    rmSync(temporary, { recursive: true, force: false }); checkDeadline(deadline);
    temporaryCleanup = { createdByThisGate: true, removed: !existsSync(temporary), dev: temporaryIdentity.dev,
      ino: temporaryIdentity.ino, mode: '0700', onlyCurrentOwnedTmpRemoved: true, allStageOwnedProcessesPhysicallyClosed: true };
    if (!temporaryCleanup.removed) refuse('CI_REPORT_METADATA_TMP_CLEANUP_INCOMPLETE');
  } catch (error) { failures.push(closedCode(error)); }
  try {
    after = inspectCiReportMetadataGateInputs(repository, env, deadline); writeJson(storage.outputRoot, 'source-after.json', after);
    if (!same(before, after)) refuse('CI_REPORT_METADATA_SOURCE_INPUT_DRIFT');
  } catch (error) { failures.push(closedCode(error)); }
  const encodingPassed = stages.length >= 2 && controlPlanePassed(stages[1]);
  const success = failures.length === 0 && stages.length === 3 && stages.every(row => row.passed) && encodingPassed
    && after !== null && same(before, after) && performance.now() < deadline;
  const summary = { schema: 'musicbridge.ci-report-metadata.tool-gate.v1', task: CI_REPORT_METADATA_TASK,
    status: success ? 'PASSED_CURRENT_TOOL_GATE' : 'FAILED', success,
    headAtRun: before.identity.head, sourceSha: before.admission.sourceSha, repairRole: before.admission.repairRole,
    baseSha: CI_REPORT_METADATA_BASE, productSoftwareSource: CI_REPORT_METADATA_PRODUCT_SOURCE,
    productFingerprint: before.admission.productFingerprint, ciScopeSha256: before.admission.ciScopeSha256,
    sourceBefore: before, sourceAfter: after, sourceInputsUnchanged: after !== null && same(before, after),
    limits: CI_REPORT_METADATA_GATE_LIMITS, startedAtMs, finishedAtMs: Date.now(), durationMs: performance.now() - began,
    originalTests: 173, safetyTests: CI_REPORT_METADATA_SAFETY_CASE_NAMES.length, expectedToolTests: 189,
    controlPlaneEncodingPassed: encodingPassed, controlPlaneEncodingProof: before.encodingProof,
    currentToolGateExitCode: success ? 0 : 1, stages, failures, temporaryCleanup,
    historicalFetchByThisGate: false, historical186Replayed: false, original001CurrentHeadReplayed: false,
    productTestsOrBuildsRepeated: false, softwareEvidenceMode: 'SKIPPED_REUSED_S165',
    oldProductScopeCorrectionLocalUnchanged: true, productArtifactsCreated: 0,
    currentArtifactPolicy: 'ONE_ACTUAL_VERIFY_TOOL_RESULT_ZIP_ONLY',
    productionApp: 'NOT_RUN', realProviderDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' };
  writeJson(storage.outputRoot, 'summary.json', summary);
  return { outputRoot: storage.outputRoot, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { summary } = await runCiReportMetadataGate();
    process.stdout.write(JSON.stringify({ task: summary.task, status: summary.status, headAtRun: summary.headAtRun,
      currentToolGateExitCode: summary.currentToolGateExitCode, originalTests: summary.originalTests,
      safetyTests: summary.safetyTests, controlPlaneEncodingPassed: summary.controlPlaneEncodingPassed,
      failures: summary.failures }) + '\n');
    if (!summary.success) process.exitCode = 1;
  } catch (error) {
    process.stderr.write('报告元数据工具 Gate 拒绝：' + closedCode(error) + '\n'); process.exitCode = 1;
  }
}
