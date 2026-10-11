import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { CI_REPORT_METADATA_TASK as task, CI_REPORT_METADATA_BRANCH as branch, CI_REPORT_METADATA_BASE as base,
  CI_REPORT_METADATA_HISTORICAL_SOURCE as historicalSource, CI_REPORT_METADATA_PRODUCT_SOURCE as product,
  CI_REPORT_METADATA_SCOPE_PATH as scopePath, CI_REPORT_METADATA_CORRECTION_PATH as correctionPath,
  CI_REPORT_METADATA_SOURCE_FILES, CI_REPORT_METADATA_REPORT_PATHS, CI_REPORT_METADATA_CORRECTION_IDENTITY,
  CI_REPORT_METADATA_SOURCE1_CANONICAL, CI_REPORT_METADATA_FROZEN_HISTORY,
  CI_REPORT_METADATA_GUARD_STEP as guard, CI_REPORT_METADATA_GATE_STEP as toolGate,
  CI_REPORT_METADATA_UPLOAD_STEP as toolUpload, assertCiReportMetadataScope, assertCiReportMetadataCorrection,
  inspectCiReportMetadataAdmission, inspectCiReportMetadataReportAdmission, inspectCiReportMetadataHistoricalObjects,
  inspectCiReportMetadataEncoding, ciReportMetadataWorkflowOutputs, validateCiReportMetadataParentCi,
  validateCiReportMetadataSourceReceipt, ciReportMetadataCanonicalPin, ciReportMetadataHistoricalSourceProjection,
  ciReportMetadataReportIdentity, ciReportMetadataReportProjection, inspectCiReportMetadataReportOnly } from '../ci-report-metadata-admission.mjs';
import { inspectReportOnly } from '../report-only-admission.mjs';
import { inspectTaskApplicability, taskApplicabilityWorkflowOutputs } from '../task-applicability.mjs';
import { CI_REPORT_METADATA_SAFETY_CASE_NAMES as names, CI_REPORT_METADATA_ORIGINAL_TESTS,
  CI_REPORT_METADATA_CONTROL_PLANE_RAW, CI_REPORT_METADATA_GATE_LIMITS,
  validateCiReportMetadataGateArguments } from '../verify-ci-report-metadata.mjs';
import { captureCiReportMirrorStage, ciReportMirrorGitEnvironment } from '../verify-ci-report-mirror.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourcePaths = CI_REPORT_METADATA_SOURCE_FILES.map(row => row.path);
const reportPaths = [...CI_REPORT_METADATA_REPORT_PATHS];
const originalHistory = CI_REPORT_METADATA_CORRECTION_IDENTITY.historicalObjects;
const copy = value => structuredClone(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const counts = tests => ({ tests, pass: tests, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
const record = filename => JSON.parse(readFileSync(filename));
const rejected = error => /^CI_(?:REPORT_METADATA|MIRROR)_/u.test(error?.code ?? '');
// 合成Git/producer不继承本轮hosted身份；raw证据均明确Fake，不是平台CI资格。
const fixtureEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith('GITHUB_') && !key.startsWith('GIT_')));
let fixtureRoot, fixtureDirectory, fixtureSource, sourceTree, actualSource, cachedReceipt;

/** Git写入只发生在本轮自有fixture；真实工作树仅读取不可变对象。 */
function command(directory, args, { input, allowFailure = false, environment = fixtureEnvironment, binary = false } = {}) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: directory, env: ciReportMirrorGitEnvironment(environment), input, encoding: binary ? undefined : 'utf8',
    timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(result.error, undefined, 'fixture Git必须有界自然退出'); assert.equal(result.signal, null);
  if (!allowFailure) assert.equal(result.status, 0, binary ? result.stderr.toString('utf8') : result.stderr);
  return allowFailure ? result : binary ? result.stdout : result.stdout.trim();
}
function commitTree(directory, tree, parents, message) {
  return command(directory, ['-c', 'user.name=MusicBridge CI Fixture', '-c', 'user.email=ci-fixture@example.invalid',
    'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], { input: message + '\n' });
}
function clone(directory, destination, head, observedBranch = branch) {
  command(path.dirname(destination), ['-c', 'protocol.file.allow=always', 'clone', '--no-local', '--no-hardlinks',
    '--no-checkout', '--', directory, destination]);
  command(destination, ['checkout', '-B', observedBranch, head, '--']);
  assert.equal(command(destination, ['rev-parse', '--path-format=absolute', '--git-common-dir']), path.join(destination, '.git'));
  assert.equal(existsSync(path.join(destination, '.git/objects/info/alternates')), false); return destination;
}
function checkout(directory, head) { command(directory, ['checkout', '-f', '-B', branch, head, '--']); }
function fixture(t) {
  if (!fixtureRoot) {
    const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR, { mustExist: true });
    if (!storage.hosted) assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
    fixtureRoot = mkdtempSync(path.join(temporary, 'ci-report-metadata-test-')); storage.check(fixtureRoot, { mustExist: true });
    const current = command(repository, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ');
    assert.equal(current.length, 2, '真实Source/Report必须唯一父链');
    actualSource = current[1] === base ? current[0] : current[1];
    assert.equal(command(repository, ['rev-list', '--parents', '-n', '1', actualSource]).split(' ')[1], base);
    fixtureDirectory = clone(repository, path.join(fixtureRoot, 'source'), base);
    // Report的STATUS含追加摘要；始终从实际Source的13个Git blob读取，不复制当前FS。
    for (const relative of sourcePaths) {
      const bytes = command(repository, ['show', actualSource + ':' + relative], { binary: true });
      const filename = path.join(fixtureDirectory, relative); mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      writeFileSync(filename, bytes, { mode: 0o644 }); chmodSync(filename, 0o644);
    }
    command(fixtureDirectory, ['add', '--', ...sourcePaths]); sourceTree = command(fixtureDirectory, ['write-tree']);
    fixtureSource = commitTree(fixtureDirectory, sourceTree, [base], '受控Fake Source；仅验证实际Git准入，不是平台CI');
    command(fixtureDirectory, ['update-ref', 'refs/heads/' + branch, fixtureSource]);
  }
  checkout(fixtureDirectory, fixtureSource);
  assert.equal(command(fixtureDirectory, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  t.diagnostic('受控Fake Git fixture=' + fixtureDirectory + ' source=' + fixtureSource + ' actualSourceInput=' + actualSource);
  return { directory: fixtureDirectory, source: fixtureSource, root: fixtureRoot };
}
function commitWorking(directory, paths, parents = [base]) {
  command(directory, ['add', '--', ...paths]); const tree = command(directory, ['write-tree']);
  const head = commitTree(directory, tree, parents, '受控Fake闭集行为变异'); checkout(directory, head); return head;
}
/** 保留旧JSON数值原literal；JS语义相等不能代替授权域外大整数的原始精度。 */
function numericTokens(text) {
  const tokens = new Map(); let offset = 0; const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/yu;
  const space = () => { while ([' ', '\t', '\r', '\n'].includes(text[offset])) offset++; };
  const string = () => {
    const start = offset; assert.equal(text[offset++], '"');
    while (offset < text.length) {
      const character = text[offset++]; if (character === '\\') offset++;
      else if (character === '"') return text.slice(start, offset);
    }
    assert.fail('fixture JSON字符串必须完整');
  };
  const escaped = key => key.replace(/~/gu, '~0').replace(/\//gu, '~1');
  const value = (pointer, depth) => {
    assert.ok(depth <= 128); space(); const first = text[offset];
    if (first === '{') {
      offset++; space(); if (text[offset] === '}') { offset++; return; }
      for (;;) {
        space(); const key = JSON.parse(string()); space(); assert.equal(text[offset++], ':');
        value(pointer + '/' + escaped(key), depth + 1); space(); const separator = text[offset++];
        if (separator === '}') return; assert.equal(separator, ',');
      }
    }
    if (first === '[') {
      offset++; space(); if (text[offset] === ']') { offset++; return; } let index = 0;
      for (;;) {
        value(pointer + '/' + index++, depth + 1); space(); const separator = text[offset++];
        if (separator === ']') return; assert.equal(separator, ',');
      }
    }
    if (first === '"') { string(); return; }
    for (const literal of ['true', 'false', 'null']) if (text.startsWith(literal, offset)) { offset += literal.length; return; }
    const start = offset; number.lastIndex = offset; const matched = number.exec(text); assert.ok(matched);
    offset = number.lastIndex; tokens.set(pointer, { start, end: offset, raw: text.slice(start, offset) });
  };
  value('', 0); space(); assert.equal(offset, text.length); return tokens;
}
function valueAt(data, pointer) {
  return pointer.split('/').slice(1).reduce((current, key) => current?.[key.replace(/~1/gu, '/').replace(/~0/gu, '~')], data);
}
function jsonEdit(directory, relative, edit) {
  const filename = path.join(directory, relative), before = readFileSync(filename, 'utf8'), value = JSON.parse(before); edit(value);
  const generated = JSON.stringify(value, null, 2) + '\n', previous = numericTokens(before), changes = [];
  for (const [pointer, token] of numericTokens(generated)) {
    const old = previous.get(pointer);
    if (old && old.raw !== token.raw && typeof valueAt(value, pointer) === 'number'
      && Object.is(valueAt(value, pointer), Number(old.raw))) changes.push({ ...token, replacement: old.raw });
  }
  const pieces = []; let cursor = 0;
  for (const token of changes.sort((a, b) => a.start - b.start)) {
    pieces.push(generated.slice(cursor, token.start), token.replacement); cursor = token.end;
  }
  pieces.push(generated.slice(cursor)); writeFileSync(filename, pieces.join('')); return value;
}
const protectedMtimePointer = '/postRustPersistentIncrementalScan20261004/latestVerifiedProgress/evidenceRefs/actualReadonlyInputConfig/mtimeNs';
function assertProtectedMtime(directory) {
  const parentBytes = command(repository, ['show', base + ':project/STATUS.json'], { binary: true });
  const old = numericTokens(parentBytes.toString('utf8')).get(protectedMtimePointer);
  const current = numericTokens(readFileSync(path.join(directory, 'project/STATUS.json'), 'utf8')).get(protectedMtimePointer);
  assert.ok(old && current); assert.ok(BigInt(old.raw) > 2n ** 53n); assert.equal(current.raw, old.raw); return old.raw;
}
function mutateProtectedMtime(directory, delta) {
  const filename = path.join(directory, 'project/STATUS.json'), text = readFileSync(filename, 'utf8');
  const token = numericTokens(text).get(protectedMtimePointer); assert.ok(token);
  const next = (BigInt(token.raw) + delta).toString(); assert.equal(Number(next), Number(token.raw), '反例必须让JS number仍相等');
  assert.notEqual(next, token.raw); writeFileSync(filename, text.slice(0, token.start) + next + text.slice(token.end));
}
function repinSource(directory, relative) {
  const scope = record(path.join(directory, scopePath)), raw = readFileSync(path.join(directory, relative));
  const row = scope.files.find(entry => entry.path === relative); assert.ok(row); row.bytes = raw.length; row.sha256 = sha(raw);
  const self = scope.files.find(entry => entry.path === scopePath); let bytes;
  for (let count = 0; count < 8; count++) {
    bytes = Buffer.from(JSON.stringify(scope, null, 2) + '\n'); if (self.bytes === bytes.length) break;
    self.bytes = bytes.length;
  }
  bytes = Buffer.from(JSON.stringify(scope, null, 2) + '\n'); assert.equal(self.bytes, bytes.length);
  writeFileSync(path.join(directory, scopePath), bytes); return commitWorking(directory, [relative, scopePath]);
}
function hosted(head) { return { ...fixtureEnvironment, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_EVENT_NAME: 'push', GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'Matt12377/MusicBridge',
  GITHUB_REF_NAME: branch, GITHUB_SHA: head }; }
function node(directory, args, environment = fixtureEnvironment, timeout = 20_000) {
  const result = spawnSync(process.execPath, args, { cwd: directory, env: ciReportMirrorGitEnvironment(environment),
    timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
}
function control(directory) { return node(directory, ['scripts/ci/verify-control-plane.mjs']); }
function fullSource1(directory) { return record(path.join(directory, 'docs/postrust/MBM-004/CI_EVIDENCE.json')).ciRepair.sourceCi; }
function filePin(directory, relative) {
  const raw = readFileSync(path.join(directory, relative)); return { path: relative, bytes: raw.length, sha256: sha(raw), mode: '100644' };
}

/** producer/raw/CRC/ZIP收据完全受控合成；callback不访问平台、不产生真实资格。 */
function ci(source) {
  const files = ['verify', 'security', 'rust-core', 'electron-e2e'];
  const jobs = [['verify', 'dependency-audit'], ['static-security'],
    ['rust-core (ubuntu-latest)', 'rust-core (macos-latest)'], ['macos-electron-gate']];
  const successes = new Set([guard, '复用165已封存产品软件证据', toolGate, toolUpload,
    '准备准入正负例的精确历史Git对象', 'Validate control plane', 'Validate security and product boundaries',
    'Scan workspace import cycles', 'Production dependency audit', 'Validate machine control state',
    'Run boundary, loopback, secret and URL/query scans']);
  const steps = (file, job) => {
    const lines = readFileSync(path.join(repository, '.github/workflows/' + file + '.yml'), 'utf8').split('\n');
    const start = lines.indexOf('  ' + job + ':'); assert.ok(start >= 0); let end = start + 1;
    while (end < lines.length && !/^  [a-z][a-z0-9-]*:/u.test(lines[end])) end++;
    return lines.slice(start, end).map(line => /^      - name: (.+)$/u.exec(line)?.[1]).filter(Boolean)
      .map(name => ({ name, status: 'completed', conclusion: successes.has(name) ? 'success' : 'skipped' }));
  };
  const runs = files.map((name, index) => ({ id: 88100 + index, path: '.github/workflows/' + name + '.yml',
    repository: { id: 1340424953 }, head_repository: { id: 1340424953 }, head_sha: source, head_branch: branch,
    event: 'push', run_attempt: 1, status: 'completed', conclusion: 'success' }));
  const proofs = runs.map((run, index) => ({ runId: run.id, jobs: jobs[index].map((name, ordinal) => ({
    id: run.id * 10 + ordinal, name, run_id: run.id, head_sha: source, status: 'completed', conclusion: 'success',
    steps: steps(files[index], index === 2 ? 'rust-core' : name),
  })), artifacts: index === 0 ? [{ id: 991001, name: 'verify-' + source, expired: false,
    size_in_bytes: 11, digest: 'sha256:' + 'd'.repeat(64), expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: run.id, head_sha: source, repository_id: 1340424953, head_repository_id: 1340424953 } }] : [] }));
  return { task, repositoryId: 1340424953, parent: source, branch, runs, proofs, now: Date.parse('2026-10-11T00:00:00Z') };
}
function crc32(raw) {
  let result = 0xffffffff;
  for (const byte of raw) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = result >>> 1 ^ (result & 1 ? 0xedb88320 : 0); }
  return (result ^ 0xffffffff) >>> 0;
}
function sourceReceipt(value) {
  if (cachedReceipt) return copy(cachedReceipt);
  const producers = ci(value.source), members = [];
  const member = (filename, raw) => { const row = { path: filename, bytes: raw.length, sha256: sha(raw), crc32: crc32(raw) }; members.push(row); return row; };
  const fakePin = filename => ({ path: '/synthetic-ci-metadata-fixture/' + filename, bytes: 11, sha256: 'd'.repeat(64) });
  const encodingProof = inspectCiReportMetadataEncoding(value.directory, fixtureEnvironment);
  const stages = [['original-173', 173], ['control-plane', null], ['metadata-safety', 16]].map(([name, expectedTests], index) => {
    const caseNames = name === 'metadata-safety' ? [...names] : expectedTests === null ? []
      : Array.from({ length: expectedTests }, (_, ordinal) => '受控原叶case_' + (ordinal + 1));
    const stdout = expectedTests === null ? Buffer.from('CONTROL_PLANE=PASS\n') : Buffer.from('TAP version 13\n'
      + caseNames.map((caseName, ordinal) => 'ok ' + (ordinal + 1) + ' - ' + caseName).join('\n') + '\n1..' + expectedTests + '\n'
      + Object.entries(counts(expectedTests)).map(([key, count]) => '# ' + key + ' ' + count).join('\n') + '\n');
    const rawPin = (stream, bytes) => {
      const row = member(name + '.' + stream + '.log', bytes); return { path: row.path, bytes: row.bytes, sha256: row.sha256 };
    };
    const stage = { name, command: ['node', name === 'control-plane' ? 'scripts/ci/verify-control-plane.mjs' : '--test'],
      directory: value.directory, pid: 20001 + index, startedAtMs: 1791686400000 + index * 2,
      finishedAtMs: 1791686400001 + index * 2, durationMs: 1, budgetMs: 90000,
      expectedTests, passed: true, exitCode: 0, signal: null, exitObserved: true, closeObserved: true,
      timedOut: false, overflow: false, spawnFailed: false, interrupted: false, cleanupFailed: false,
      terminationRequested: false, lingeringOwnedGroup: false, physicalShutdown: { pidAbsent: true, processGroupAbsent: true },
      observedDescendants: [], observedDescendantsAbsent: true, descendantScanFailed: false,
      rawForcedClosed: false, boundedSettleObserved: false, unexpectedPipeHolder: false,
      rawCaptureComplete: true, rawCaptureScope: 'FULL_SEPARATE_STDOUT_STDERR_BYTES_UNTIL_CLOSE_WITH_FIXED_BOUNDS',
      testCounts: expectedTests === null ? null : counts(expectedTests), tapComplete: true,
      actualCaseNames: caseNames, expectedCaseNames: name === 'metadata-safety' ? caseNames : null, caseNamesMatched: true,
      raw: { stdout: rawPin('stdout', stdout), stderr: rawPin('stderr', Buffer.alloc(0)) } };
    member(name + '.json', Buffer.from(JSON.stringify(stage, null, 2) + '\n')); return stage;
  });
  const sourceBefore = { identity: { head: value.source, status: '', branch, tree: sourceTree,
    commonDir: path.join(value.directory, '.git'), gitDir: path.join(value.directory, '.git') },
    admission: { sourceSha: value.source, exactSourceFiles: 13, repairRole: 'source', encodingProof,
      ciScopeSha256: sha(readFileSync(path.join(value.directory, scopePath))) },
    currentFiles: [...new Set([...sourcePaths, 'docs/postrust/MBM-004/CI_EVIDENCE.json'])].sort().map(relative => filePin(value.directory, relative)),
    encodingProof };
  member('source-before.json', Buffer.from(JSON.stringify(sourceBefore, null, 2) + '\n'));
  member('source-after.json', Buffer.from(JSON.stringify(sourceBefore, null, 2) + '\n'));
  const summary = { schema: 'musicbridge.ci-report-metadata.tool-gate.v1', task, status: 'PASSED_CURRENT_TOOL_GATE', success: true,
    headAtRun: value.source, sourceSha: value.source, repairRole: 'source', baseSha: base, productSoftwareSource: product,
    sourceInputsUnchanged: true, sourceBefore, sourceAfter: copy(sourceBefore), currentToolGateExitCode: 0, failures: [],
    originalTests: 173, safetyTests: 16, expectedToolTests: 189, limits: CI_REPORT_METADATA_GATE_LIMITS,
    startedAtMs: 1791686400000, finishedAtMs: 1791686400006, durationMs: 6, stages,
    controlPlaneEncodingPassed: true, controlPlaneEncodingProof: encodingProof,
    temporaryCleanup: { createdByThisGate: true, removed: true, onlyCurrentOwnedTmpRemoved: true, allStageOwnedProcessesPhysicallyClosed: true },
    productTestsOrBuildsRepeated: false, softwareEvidenceMode: 'SKIPPED_REUSED_S165', productArtifactsCreated: 0,
    productionApp: 'NOT_RUN', realProviderDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' };
  const summaryRaw = Buffer.from(JSON.stringify(summary, null, 2) + '\n'); member('summary.json', summaryRaw);
  cachedReceipt = { schema: 'musicbridge.root.ci-report-metadata.first-natural-ci.v1',
    status: 'SEALED_FIRST_NATURAL_TOOL_CI_WITH_ORIGINAL_S165_SOFTWARE_REUSE', phase: 'source', task,
    revision: value.source, branch, repository: 'Matt12377/MusicBridge', repositoryId: producers.repositoryId,
    recordedAt: '2026-10-11T00:00:00Z', code: null,
    before: { head: value.source, parent: base, branch, tree: sourceTree, status: '' },
    after: { head: value.source, parent: base, branch, tree: sourceTree, status: '' },
    runs: producers.runs, proofs: producers.proofs, logs: producers.proofs.flatMap(proof => proof.jobs.map(job => ({
      runId: proof.runId, jobId: job.id, jobName: job.name, raw: fakePin('job-' + job.id + '.log'),
      transport: 'DIRECT_GITHUB_API_302_AND_MEMORY_ONLY_SIGNED_URL', redirectLocationArchived: false,
      credentialsArchived: false, authorizationForwardedAcrossHosts: false,
    }))), artifacts: [{ id: 991001, name: 'verify-' + value.source, zip: fakePin('tool.zip'), members,
      allMembersBytesAndCrcRead: true, expandedBytes: members.reduce((sum, row) => sum + row.bytes, 0),
      credentialsArchived: false, signedRedirectArchived: false, authorizationForwardedAcrossHosts: false,
      toolContent: { entry: 'summary.json', phase: 'source', result: summary, rawBase64: summaryRaw.toString('base64') } }],
    metadataFiles: [], oldProductSource: product, oldFailedReport: base, oldFailurePreserved: true,
    oldProductTestsRepeated: false, oldProductZipsDownloadedOrCrcReplayed: false, compiledAndApp: 'SKIPPED_REUSED_S165',
    reruns: 0, dispatches: 0, credentialsOrSignedRedirectArchived: false,
    realApplicationServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' };
  return copy(cachedReceipt);
}
function report(value, sourceCi = sourceReceipt(value)) {
  checkout(value.directory, value.source); const identity = ciReportMetadataReportIdentity(value.source, sourceCi);
  const projection = ciReportMetadataReportProjection(identity);
  for (const relative of reportPaths) {
    const filename = path.join(value.directory, relative);
    if (relative.endsWith('.md')) appendFileSync(filename, '\nCI_REPORT_METADATA_001：受控Fake Git报告；不代表平台CI或Owner验收。\n');
    else jsonEdit(value.directory, relative, data => {
      if (relative === 'project/STATUS.json') data.mobileContentMultidevice.ciReportMetadata = copy(projection);
      else if (relative === 'project/POSTRUST_PLAN.json') data.mobile_tasks.find(row => row.id === 'MBM-004').ciReportMetadata = copy(identity);
      else data.ciReportMetadata = copy(identity);
    });
  }
  return commitWorking(value.directory, reportPaths, [value.source]);
}
function api(value, called) { return async route => {
  called?.push(route);
  if (route === '') return { id: value.repositoryId, private: false, full_name: 'Matt12377/MusicBridge' };
  if (route.startsWith('/actions/runs?')) return { total_count: value.runs.length, workflow_runs: value.runs };
  const id = Number(/\/runs\/(\d+)/u.exec(route)?.[1]), proof = value.proofs.find(row => row.runId === id);
  assert.ok(proof, '未知producer请求拒绝');
  return route.includes('/jobs?') ? { total_count: proof.jobs.length, jobs: proof.jobs }
    : { total_count: proof.artifacts.length, artifacts: proof.artifacts };
}; }
async function reportRejected(directory, head, producers = ci(fixtureSource), environment = hosted(head)) {
  const result = await inspectCiReportMetadataReportOnly(environment, directory, api(producers));
  assert.equal(result.mode, 'full'); assert.notEqual(result.productResultsReused, true);
}
function rewriteSyntheticSummary(receipt, edit) {
  const artifact = receipt.artifacts[0]; edit(artifact.toolContent.result);
  const summary = artifact.toolContent.result;
  for (const [filename, value] of [['source-before.json', summary.sourceBefore], ['source-after.json', summary.sourceAfter],
    ...summary.stages.map(stage => [stage.name + '.json', stage])]) {
    const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    Object.assign(artifact.members.find(row => row.path === filename), { bytes: raw.length, sha256: sha(raw), crc32: crc32(raw) });
  }
  const raw = Buffer.from(JSON.stringify(summary, null, 2) + '\n');
  artifact.toolContent.rawBase64 = raw.toString('base64'); Object.assign(artifact.members.find(row => row.path === 'summary.json'),
    { bytes: raw.length, sha256: sha(raw), crc32: crc32(raw) });
  artifact.expandedBytes = artifact.members.reduce((sum, row) => sum + row.bytes, 0); return receipt;
}
function preparationCode() {
  const lines = readFileSync(path.join(repository, '.github/workflows/verify.yml'), 'utf8').split('\n');
  const start = lines.indexOf('      - name: 准备准入正负例的精确历史Git对象'); assert.ok(start >= 0); let end = start + 1;
  while (end < lines.length && !/^      - name:/u.test(lines[end])) end++;
  const body = lines.slice(start, end), run = body.indexOf('        run: |'); assert.ok(run >= 0);
  return body.slice(run + 1).map(line => { assert.ok(line === '' || line.startsWith('          ')); return line.slice(10); }).join('\n');
}
function historyPresent(directory, ref) { return command(directory, ['cat-file', '-e', ref + '^{commit}'], { allowFailure: true }).status === 0; }
function preparation(mirror, donor, head) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', preparationCode()], {
    cwd: mirror, env: { ...fixtureEnvironment, GITHUB_WORKSPACE: donor, GITHUB_SHA: head },
    timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
}
/** 真实guard→原source-pinned mirror→共同两历史对象准备，不对裸fetch增加另一套身份规则。 */
function workflowMirror(donor, destination, expectedHead, root) {
  const environment = { ...fixtureEnvironment, GITHUB_SHA: expectedHead, GITHUB_REF_NAME: branch, DEV_BUILD_ROOT: root };
  delete environment.RUNNER_ENVIRONMENT;
  const commandFile = path.join(root, path.basename(destination) + '-github-env'); writeFileSync(commandFile, '', { flag: 'wx', mode: 0o600 });
  environment.GITHUB_ENV = commandFile;
  const guarded = node(donor, [path.join(donor, 'scripts/ci/ci-report-metadata-admission.mjs'), '--workflow-guard'], environment, 30_000);
  if (guarded.status !== 0) return { status: guarded.status, rejectedAt: 'REAL_METADATA_GUARD' };
  const mirrored = node(donor, [path.join(donor, 'scripts/ci/prepare-build-workspace-mirror.mjs'),
    '--source', donor, '--destination', destination, '--expected-head', expectedHead], environment, 30_000);
  if (mirrored.status !== 0) return { status: mirrored.status, rejectedAt: 'REAL_SOURCE_PINNED_MIRROR' };
  const prepared = preparation(destination, donor, expectedHead); return { status: prepared.status, destination };
}

const behaviors = [
  t => {
    const value = fixture(t); checkout(value.directory, base);
    const original = fullSource1(value.directory), urls = [];
    const visit = (entry, key = '') => { if (Array.isArray(entry)) entry.forEach(item => visit(item, key));
      else if (entry && typeof entry === 'object') Object.entries(entry).forEach(([field, item]) => visit(item, field));
      else if (typeof entry === 'string' && /^https?:\/\/.+[?&].+/u.test(entry)) urls.push(key); };
    visit(original); assert.equal(urls.length, 24); assert.equal(urls.filter(key => key === 'avatar_url').length, 16);
    assert.equal(urls.filter(key => key === 'notifications_url').length, 8);
    const result = control(value.directory); assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CONTROL_PLANE=FAIL reason=status-secret-or-url\n'); assert.equal(result.stdout, '');
    t.diagnostic('真实原控制面在不可变失败Report字节上RED；这是私有fixture，不重写失败历史。');
  },
  t => {
    const value = fixture(t), original = fullSource1(value.directory), status = record(path.join(value.directory, 'project/STATUS.json'));
    assertProtectedMtime(value.directory);
    assert.deepEqual(ciReportMetadataCanonicalPin(original), CI_REPORT_METADATA_SOURCE1_CANONICAL);
    const summary = ciReportMetadataHistoricalSourceProjection(original);
    assert.deepEqual(status.mobileContentMultidevice.ciRepair.sourceCi, summary);
    assert.equal(summary.fullObject.jsonPointer, '/ciRepair/sourceCi'); assert.equal(summary.fullObject.sha256, CI_REPORT_METADATA_SOURCE1_CANONICAL.sha256);
    assert.equal(summary.workflows.length, 4); assert.equal(summary.workflows.flatMap(row => row.jobs).length, 6);
    assert.equal(summary.logs.length, 6); assert.equal(summary.artifacts.length, 1);
    assert.equal(summary.artifacts[0].totalTapTests, 193); assert.equal(/https?:\/\//iu.test(JSON.stringify(summary)), false);
    const result = control(value.directory); assert.equal(result.status, 0); assert.equal(result.stdout, 'CONTROL_PLANE=PASS\n'); assert.equal(result.stderr, '');
    const actual = inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment); assert.equal(actual.sourceSha, value.source);
    assert.equal(actual.productSource, product); assert.equal(actual.currentToolGateRequired, true);
  },
  t => {
    const value = fixture(t), head = report(value), status = record(path.join(value.directory, 'project/STATUS.json'));
    assertProtectedMtime(value.directory);
    const full = record(path.join(value.directory, 'docs/postrust/MBM-004/CI_EVIDENCE.json')).ciReportMetadata;
    assert.deepEqual(status.mobileContentMultidevice.ciReportMetadata, ciReportMetadataReportProjection(full));
    assert.deepEqual(status.mobileContentMultidevice.ciReportMetadata.fullObject, {
      path: 'docs/postrust/MBM-004/CI_EVIDENCE.json', jsonPointer: '/ciReportMetadata', ...ciReportMetadataCanonicalPin(full) });
    assert.equal(full.sourceSha, value.source); assert.equal(full.sourceCi.artifacts[0].toolContent.result.expectedToolTests, 189);
    assert.equal(full.reportSha, null); assert.equal(full.reportCi, null); assert.equal(full.ownerAcceptance, 'NOT_RUN');
    assert.deepEqual(ciReportMetadataCanonicalPin(fullSource1(value.directory)), CI_REPORT_METADATA_SOURCE1_CANONICAL);
    const result = control(value.directory); assert.equal(result.status, 0); assert.equal(result.stdout, 'CONTROL_PLANE=PASS\n'); assert.equal(result.stderr, '');
    const actual = inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment); assert.equal(actual.headAtAdmission, head);
    assert.equal(actual.sourceSha, value.source); assert.equal(actual.repairRole, 'report');
  },
  t => {
    const value = fixture(t);
    for (const note of ['https://example.invalid/avatar?synthetic=1', 'MUSIC_U=synthetic', 'Bearer synthetic']) {
      checkout(value.directory, value.source); jsonEdit(value.directory, 'project/STATUS.json', data => { data.mobileContentMultidevice.ciRepair.sourceCi.note = note; });
      const result = control(value.directory); assert.equal(result.status, 1); assert.match(result.stderr, /status-secret-or-url/u);
      repinSource(value.directory, 'project/STATUS.json'); assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    }
    checkout(value.directory, value.source); jsonEdit(value.directory, 'project/STATUS.json', data => { data.mobileContentMultidevice.ciRepair.sourceCi.unknown = '不能藏入摘要'; });
    repinSource(value.directory, 'project/STATUS.json'); assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    const head = report(value); jsonEdit(value.directory, 'project/STATUS.json', data => { data.mobileContentMultidevice.ciReportMetadata.rawBase64 = Buffer.from('不能藏入原正文').toString('base64'); });
    commitWorking(value.directory, ['project/STATUS.json'], [value.source]); assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected);
    assert.ok(head);
  },
  t => {
    const value = fixture(t), scope = record(path.join(value.directory, scopePath));
    assert.equal(assertCiReportMetadataScope(scope, readFileSync(path.join(value.directory, scopePath))), scope);
    assert.equal(scope.files.length, 13); assert.equal(sourcePaths.length, 13); assert.equal(reportPaths.length, 8);
    assert.equal(scope.files.filter(row => row.status === 'A').length, 6); assert.equal(scope.files.filter(row => row.status === 'M').length, 7);
    assert.equal(scope.files.find(row => row.path === 'project/STATUS.json').role, 'machine-status-projection');
    assert.equal(assertCiReportMetadataCorrection(copy(CI_REPORT_METADATA_CORRECTION_IDENTITY)).baseSha, base);
    const actual = inspectTaskApplicability(value.directory, fixtureEnvironment);
    assert.equal(actual.task, task); assert.equal(actual.sourceSha, value.source); assert.equal(actual.currentProductTestsRepeated, false);
    assert.equal(ciReportMetadataWorkflowOutputs(actual).repairMode, 'reuse-s165');
    for (const forged of [copy(actual), { task }]) { assert.throws(() => ciReportMetadataWorkflowOutputs(forged), rejected); assert.throws(() => taskApplicabilityWorkflowOutputs(forged)); }
    assertProtectedMtime(value.directory);
    for (const delta of [-1n, 1n]) {
      checkout(value.directory, value.source); mutateProtectedMtime(value.directory, delta); repinSource(value.directory, 'project/STATUS.json');
      assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    }
  },
  async t => {
    const value = fixture(t), decoy = clone(value.directory, path.join(value.root, 'decoy'), value.source);
    for (const parents of [[historicalSource], [base, product]]) {
      const head = commitTree(value.directory, sourceTree, parents, '受控错误父链'); checkout(value.directory, head);
      assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    }
    const wrong = commitTree(value.directory, sourceTree, [product], '受控实际错误Source'); checkout(value.directory, wrong);
    const redirect = { GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: path.join(decoy, '.git/index'), GIT_OBJECT_DIRECTORY: path.join(decoy, '.git/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy, '.git/objects'), GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: decoy };
    assert.throws(() => inspectCiReportMetadataAdmission(value.directory, { ...fixtureEnvironment, ...redirect }), rejected);
    const calls = [], classified = await inspectReportOnly({ ...hosted(wrong), ...redirect }, value.directory, api(ci(value.source), calls));
    assert.equal(classified.mode, 'full'); assert.equal(calls.length, 0); assert.equal(command(value.directory, ['rev-parse', 'HEAD']), wrong);
    checkout(value.directory, value.source); command(value.directory, ['checkout', '-B', branch + '-unknown']);
    assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    assert.throws(() => inspectTaskApplicability(value.directory, fixtureEnvironment));
    checkout(value.directory, value.source); const dirty = path.join(value.directory, 'ci-metadata-untracked.txt'); writeFileSync(dirty, '受控dirty\n', { flag: 'wx' });
    try { assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected); } finally { rmSync(dirty); }
    for (const [relative, text] of [['shallow', value.source + '\n'], ['info/grafts', value.source + ' ' + product + '\n'],
      ['objects/info/alternates', path.join(repository, '.git/objects') + '\n']]) {
      const filename = path.join(value.directory, '.git', relative); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, text, { flag: 'wx' });
      try { assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected); } finally { rmSync(filename); }
    }
    command(value.directory, ['replace', base, product]); try { assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected); }
    finally { command(value.directory, ['replace', '-d', base]); }
  },
  t => {
    const value = fixture(t), originalScope = record(path.join(value.directory, scopePath));
    for (const edit of [data => { data.files.pop(); }, data => { data.files[0].role = 'product'; },
      data => { data.files[0].sha256 = 'f'.repeat(64); }, data => { data.files[0].oldMode = '120000'; },
      data => { data.reportPaths.push('reports/EXTRA.md'); }]) {
      checkout(value.directory, value.source); const changed = copy(originalScope); edit(changed);
      writeFileSync(path.join(value.directory, scopePath), JSON.stringify(changed, null, 2) + '\n'); commitWorking(value.directory, [scopePath]);
      assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    }
    for (const relative of ['packages/bridge-core/src/runtime.ts', ...CI_REPORT_METADATA_FROZEN_HISTORY.map(row => row.path), correctionPath]) {
      checkout(value.directory, value.source); appendFileSync(path.join(value.directory, relative), '\n'); commitWorking(value.directory, [relative]);
      assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    }
    checkout(value.directory, value.source); const extra = 'scripts/ci/ci-metadata-fourteenth.mjs'; writeFileSync(path.join(value.directory, extra), 'export const synthetic = true;\n');
    commitWorking(value.directory, [extra]); assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    checkout(value.directory, value.source); chmodSync(path.join(value.directory, '.github/workflows/security.yml'), 0o755);
    commitWorking(value.directory, ['.github/workflows/security.yml']); assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    checkout(value.directory, value.source); const taskFile = sourcePaths[0]; rmSync(path.join(value.directory, taskFile));
    symlinkSync('CI-REPORT-METADATA-001.md.missing', path.join(value.directory, taskFile)); commitWorking(value.directory, [taskFile]);
    assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
  },
  async t => {
    const value = fixture(t), valid = report(value), tree = command(value.directory, ['rev-parse', valid + '^{tree}']);
    for (const parents of [[base], [value.source, base]]) {
      const head = commitTree(value.directory, tree, parents, '受控坏Report父链'); checkout(value.directory, head);
      assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected); await reportRejected(value.directory, head);
    }
    checkout(value.directory, valid); const extra = 'reports/CI-METADATA-NINTH.md'; writeFileSync(path.join(value.directory, extra), '受控第九路径\n');
    const extraHead = commitWorking(value.directory, [extra], [value.source]); assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected);
    await reportRejected(value.directory, extraHead);
    for (const [relative, edit] of [['project/POSTRUST_PLAN.json', data => { data.acceptance_cases.pop(); }],
      ['project/POSTRUST_PLAN.json', data => { data.mobile_tasks.find(row => row.id === 'MBM-004').owner_acceptance = 'PASSED'; }],
      ['project/STATUS.json', data => { data.mobileContentMultidevice.productionApp = 'PASSED'; }]]) {
      checkout(value.directory, valid); jsonEdit(value.directory, relative, edit); commitWorking(value.directory, [relative], [value.source]);
      assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected);
    }
    checkout(value.directory, valid); chmodSync(path.join(value.directory, reportPaths[0]), 0o755); commitWorking(value.directory, [reportPaths[0]], [value.source]);
    assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected);
    checkout(value.directory, valid); const plan = record(path.join(value.directory, 'project/POSTRUST_PLAN.json'));
    assert.equal(plan.tasks.length, 18); assert.equal(plan.acceptance_cases.length, 156);
    assert.equal(command(value.directory, ['diff', '--name-only', value.source, valid]).split('\n').length, 8);
    assertProtectedMtime(value.directory);
    for (const delta of [-1n, 1n]) {
      checkout(value.directory, valid); mutateProtectedMtime(value.directory, delta); commitWorking(value.directory, ['project/STATUS.json'], [value.source]);
      assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected);
    }
  },
  t => {
    const value = fixture(t);
    for (const edit of [summary => { summary.logs.pop(); }, summary => { summary.workflows[0].jobs.pop(); },
      summary => { summary.fullObject.sha256 = 'f'.repeat(64); }, summary => { summary.artifacts[0].totalTapTests = 189; }]) {
      checkout(value.directory, value.source); jsonEdit(value.directory, 'project/STATUS.json', data => edit(data.mobileContentMultidevice.ciRepair.sourceCi));
      repinSource(value.directory, 'project/STATUS.json'); assert.throws(() => inspectCiReportMetadataAdmission(value.directory, fixtureEnvironment), rejected);
    }
    const valid = report(value);
    for (const edit of [summary => { summary.fullObject.sha256 = 'f'.repeat(64); }, summary => { summary.sourceCi.logs.pop(); }]) {
      checkout(value.directory, valid); jsonEdit(value.directory, 'project/STATUS.json', data => edit(data.mobileContentMultidevice.ciReportMetadata));
      commitWorking(value.directory, ['project/STATUS.json'], [value.source]); assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected);
    }
    checkout(value.directory, valid); jsonEdit(value.directory, 'docs/postrust/MBM-004/CI_EVIDENCE.json', data => { data.ciReportMetadata.sourceCi.runs.reverse(); });
    commitWorking(value.directory, ['docs/postrust/MBM-004/CI_EVIDENCE.json'], [value.source]);
    assert.throws(() => inspectCiReportMetadataReportAdmission(value.directory, fixtureEnvironment), rejected);
    const pin = ciReportMetadataCanonicalPin({ 中文: '保留UTF8', 数组: [2, 1], nested: { z: 1, a: 2 } });
    assert.deepEqual(pin, ciReportMetadataCanonicalPin({ nested: { a: 2, z: 1 }, 数组: [2, 1], 中文: '保留UTF8' }));
    assert.notDeepEqual(pin, ciReportMetadataCanonicalPin({ 中文: '保留UTF8', 数组: [1, 2], nested: { a: 2, z: 1 } }));
  },
  async t => {
    const value = fixture(t), sourceCalls = [], sourceMode = await inspectReportOnly(hosted(value.source), value.directory, api(ci(value.source), sourceCalls));
    assert.equal(sourceMode.mode, 'full'); assert.equal(sourceCalls.length, 0);
    const admitted = inspectTaskApplicability(value.directory, fixtureEnvironment), output = taskApplicabilityWorkflowOutputs(admitted);
    assert.equal(output.repairMode, 'reuse-s165'); assert.equal(admitted.currentToolGateRequired, true);
    const head = report(value), calls = [], result = await inspectReportOnly(hosted(head), value.directory, api(ci(value.source), calls));
    assert.equal(result.mode, 'report-only'); assert.equal(result.parentSourceSha, value.source); assert.ok(calls.length > 0);
    assert.equal(result.productSoftwareSource ?? result.productSource, product);
    t.diagnostic('LOCAL_REPORT_CLASSIFICATION_WITH_HOSTED_CONTEXT_VALUES；受控API，无实际hosted CI。');
    jsonEdit(value.directory, 'project/STATUS.json', data => { data.mobileContentMultidevice.ciReportMetadata.ownerAcceptance = 'PASSED'; });
    const bad = commitWorking(value.directory, ['project/STATUS.json'], [value.source]), badCalls = [];
    const rejectedMode = await inspectReportOnly(hosted(bad), value.directory, api(ci(value.source), badCalls));
    assert.equal(rejectedMode.mode, 'full'); assert.equal(badCalls.length, 0);
  },
  t => {
    const value = fixture(t), head = command(repository, ['rev-parse', 'HEAD']);
    const donor = clone(repository, path.join(value.root, 'workflow-donor'), head);
    for (const ref of originalHistory) {
      assert.equal(historyPresent(donor, ref), false);
      command(donor, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--force', repository, ref]);
      assert.equal(historyPresent(donor, ref), true);
    }
    const mirror = path.join(value.root, 'workflow-mirror'); const result = workflowMirror(donor, mirror, head, value.root);
    assert.equal(result.status, 0); assert.equal(command(mirror, ['rev-parse', 'HEAD']), head);
    const history = inspectCiReportMetadataHistoricalObjects(mirror, fixtureEnvironment); assert.ok(history);
    for (const ref of originalHistory) assert.equal(historyPresent(mirror, ref), true);
    command(donor, ['checkout', '-B', branch + '-wrong', base]);
    const rejectedMirror = workflowMirror(donor, path.join(value.root, 'wrong-head-mirror'), head, value.root);
    assert.notEqual(rejectedMirror.status, 0); assert.equal(existsSync(path.join(value.root, 'wrong-head-mirror')), false);
    const missing = clone(repository, path.join(value.root, 'missing-history'), head), refsBefore = command(missing, ['show-ref']);
    assert.throws(() => inspectCiReportMetadataHistoricalObjects(missing, fixtureEnvironment), rejected);
    assert.equal(command(missing, ['show-ref']), refsBefore); for (const ref of originalHistory) assert.equal(historyPresent(missing, ref), false);
    rmSync(path.join(missing, 'scripts/ci/test/tape-catalog-common-admission.test.mjs'));
    assert.equal(preparation(missing, '/nonexistent-ci-metadata-donor', head).status, 0);
    assert.equal(existsSync(path.join(missing, '.git/FETCH_HEAD')), false);
    for (const ref of originalHistory) assert.equal(historyPresent(missing, ref), false);
    const one = clone(repository, path.join(value.root, 'one-history-only'), head);
    command(one, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--force', repository, originalHistory[0]]);
    assert.throws(() => inspectCiReportMetadataHistoricalObjects(one, fixtureEnvironment), rejected);
  },
  t => {
    const value = fixture(t), producers = ci(value.source), receipt = sourceReceipt(value);
    assert.equal(validateCiReportMetadataParentCi(producers), true); assert.equal(validateCiReportMetadataSourceReceipt(receipt, value.source), true);
    assert.equal(producers.runs.length, 4); assert.equal(producers.proofs.flatMap(row => row.jobs).length, 6);
    assert.equal(producers.proofs.flatMap(row => row.artifacts).length, 1);
    for (const proof of producers.proofs) for (const job of proof.jobs) assert.equal(job.steps.find(row => row.name === guard).conclusion, 'success');
    const verify = producers.proofs[0].jobs.find(row => row.name === 'verify');
    assert.equal(verify.steps.find(row => row.name === toolGate).conclusion, 'success');
    assert.equal(verify.steps.find(row => row.name === '验证报告CI准入正负例').conclusion, 'skipped');
    assert.equal(verify.steps.find(row => row.name === 'CI报告镜像历史对象修复工具 Gate').conclusion, 'skipped');
    assert.equal(receipt.artifacts[0].toolContent.result.expectedToolTests, 189);
    t.diagnostic('以上six-job/one-ZIP均Fake producer判定fixture，不是实际平台PASS。');
  },
  async t => {
    const value = fixture(t), head = report(value);
    for (const [index, edit] of [producers => { producers.proofs[0].jobs[0].conclusion = 'failure'; },
      producers => { producers.runs.push(copy(producers.runs[0])); }, producers => { producers.runs[0].run_attempt = 2; },
      producers => { producers.proofs[0].jobs[0].steps.find(row => row.name === toolGate).conclusion = 'skipped'; },
      producers => { producers.proofs[0].runId = producers.proofs[1].runId; }, producers => { producers.proofs[2].jobs.pop(); },
      producers => { producers.proofs[0].artifacts.push(copy(producers.proofs[0].artifacts[0])); },
      producers => { producers.runs[0].repository.id = 1; }, producers => { producers.runs[0].head_sha = product; },
      producers => { producers.now = NaN; }].entries()) {
      const changed = ci(value.source); edit(changed); assert.equal(validateCiReportMetadataParentCi(changed), false);
      if ([0, 1, 3].includes(index)) await reportRejected(value.directory, head, changed);
    }
    for (const [proofIndex, jobIndex, name] of [[0, 0, 'MBM004 内容与多设备软件 Gate'],
      [0, 0, 'Verify platform-independent workspace (typecheck, unit tests, build; no Electron)'],
      [1, 0, 'Run directed platform-independent security tests (no Electron)'], [2, 0, '验证实际 Rust 与 TypeScript 边界'],
      [3, 0, 'Electron end-to-end flow (Playwright, production build)']]) {
      const changed = ci(value.source); changed.proofs[proofIndex].jobs[jobIndex].steps.find(row => row.name === name).conclusion = 'success';
      assert.equal(validateCiReportMetadataParentCi(changed), false);
    }
    const retryReceipt = sourceReceipt(value); retryReceipt.reruns = 1; assert.equal(validateCiReportMetadataSourceReceipt(retryReceipt, value.source), false);
  },
  t => {
    const value = fixture(t), receipt = sourceReceipt(value); assert.equal(validateCiReportMetadataSourceReceipt(receipt, value.source), true);
    const edits = [data => { data.artifacts[0].zip.sha256 = 'e'.repeat(64); }, data => { data.artifacts[0].allMembersBytesAndCrcRead = false; },
      data => { data.artifacts[0].members.find(row => row.path === 'control-plane.stdout.log').sha256 = 'e'.repeat(64); },
      data => { data.artifacts[0].members.pop(); }, data => { data.logs[0].raw.bytes = 0; },
      data => { data.logs[1].jobId = data.logs[0].jobId; }, data => { data.artifacts[0].toolContent.rawBase64 = Buffer.from('{}\n').toString('base64'); },
      data => { data.artifacts[0].toolContent.result.success = false; },
      data => rewriteSyntheticSummary(data, summary => { summary.stages[1].expectedTests = 1; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].physicalShutdown.processGroupAbsent = false; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].terminationRequested = true; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].descendantScanFailed = true; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].rawForcedClosed = true; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].boundedSettleObserved = true; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].unexpectedPipeHolder = true; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].observedDescendants = [{ physicallyAbsent: false }]; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].rawCaptureScope = 'PARTIAL'; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].durationMs = summary.stages[2].budgetMs + 1; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[1].rawCaptureComplete = false; }),
      data => rewriteSyntheticSummary(data, summary => { summary.stages[2].testCounts.skipped = 1; }),
      data => rewriteSyntheticSummary(data, summary => { summary.controlPlaneEncodingPassed = false; }),
      data => rewriteSyntheticSummary(data, summary => { summary.controlPlaneEncodingProof.evidence.sha256 = 'e'.repeat(64); }),
      data => rewriteSyntheticSummary(data, summary => { summary.limits.stageMs++; }),
      data => rewriteSyntheticSummary(data, summary => { summary.limits.wholeMs++; }),
      data => rewriteSyntheticSummary(data, summary => { summary.durationMs = 180000; }),
      data => rewriteSyntheticSummary(data, summary => { summary.temporaryCleanup.removed = false; }),
      data => rewriteSyntheticSummary(data, summary => { summary.sourceAfter.identity.head = base; })];
    for (const edit of edits) { const changed = copy(receipt); edit(changed); assert.equal(validateCiReportMetadataSourceReceipt(changed, value.source), false); }
    for (const stage of receipt.artifacts[0].toolContent.result.stages) for (const pin of Object.values(stage.raw)) {
      const member = receipt.artifacts[0].members.find(row => row.path === pin.path); assert.equal(member.bytes, pin.bytes); assert.equal(member.sha256, pin.sha256);
    }
    for (const stream of ['stdout', 'stderr']) assert.equal(receipt.artifacts[0].toolContent.result.stages[1].raw[stream].sha256, CI_REPORT_METADATA_CONTROL_PLANE_RAW[stream].sha256);
  },
  async t => {
    const value = fixture(t), oldReceipt = fullSource1(value.directory), current = sourceReceipt(value);
    assert.equal(oldReceipt.revision, historicalSource); assert.equal(oldReceipt.artifacts[0].toolContent.result.expectedToolTests, 193);
    assert.equal(validateCiReportMetadataSourceReceipt(oldReceipt, value.source), false);
    assert.equal(validateCiReportMetadataSourceReceipt(current, historicalSource), false);
    const changed = rewriteSyntheticSummary(copy(current), summary => { summary.schema = 'musicbridge.ci-report-mirror.tool-gate.v1'; summary.expectedToolTests = 193; });
    assert.equal(validateCiReportMetadataSourceReceipt(changed, value.source), false);
    const reportAsSource = copy(current); reportAsSource.phase = 'report'; assert.equal(validateCiReportMetadataSourceReceipt(reportAsSource, value.source), false);
    const head = report(value), projected = record(path.join(value.directory, 'project/STATUS.json')).mobileContentMultidevice.ciReportMetadata;
    assert.equal(projected.sourceSha, value.source); assert.equal(projected.reportSha, null); assert.equal(projected.reportCi, null);
    const ownGreen = ci(head); await reportRejected(value.directory, head, ownGreen);
    assert.equal(ciReportMetadataCanonicalPin(fullSource1(value.directory)).sha256, CI_REPORT_METADATA_SOURCE1_CANONICAL.sha256);
  },
  async t => {
    const value = fixture(t), outputRoot = path.join(value.root, 'capture'); mkdirSync(outputRoot, { mode: 0o700 });
    const stdout = '完整UTF8 stdout\n', stderr = '完整UTF8 stderr\n';
    const natural = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'natural',
      args: ['-e', 'process.stdout.write(' + JSON.stringify(stdout) + ');process.stderr.write(' + JSON.stringify(stderr) + ')'],
      env: fixtureEnvironment, timeoutMs: 5_000 });
    assert.equal(natural.passed, true); assert.equal(natural.rawCaptureComplete, true); assert.equal(natural.closeObserved, true);
    assert.equal(natural.exitObserved, true); assert.deepEqual(natural.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    assert.equal(natural.observedDescendantsAbsent, true); assert.ok(natural.durationMs <= natural.budgetMs);
    for (const [stream, text] of [['stdout', stdout], ['stderr', stderr]]) {
      const pin = natural.raw[stream], raw = readFileSync(path.join(outputRoot, pin.path));
      assert.equal(raw.toString('utf8'), text); assert.equal(raw.length, pin.bytes); assert.equal(sha(raw), pin.sha256);
      assert.equal(lstatSync(path.join(outputRoot, pin.path)).mode & 0o777, 0o600);
    }
    const timeout = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'timeout',
      args: ['-e', 'setInterval(()=>{},1000)'], env: fixtureEnvironment, timeoutMs: 500 });
    assert.equal(timeout.passed, false); assert.equal(timeout.timedOut, true); assert.equal(timeout.terminationRequested, true);
    assert.deepEqual(timeout.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    const overflow = await captureCiReportMirrorStage({ directory: value.directory, outputRoot, name: 'overflow',
      args: ['-e', 'process.stdout.write(Buffer.alloc(8192,65));setInterval(()=>{},1000)'], env: fixtureEnvironment,
      timeoutMs: 5_000, maxBytesPerStream: 1024 });
    assert.equal(overflow.passed, false); assert.equal(overflow.overflow, true); assert.equal(overflow.rawCaptureComplete, false);
    assert.equal(overflow.raw.stdout.bytes, 1024); assert.deepEqual(overflow.physicalShutdown, { pidAbsent: true, processGroupAbsent: true });
    const argumentsRoot = path.join(value.root, 'new-gate-output');
    assert.equal(validateCiReportMetadataGateArguments(['--output-root', argumentsRoot], process.env).outputRoot, argumentsRoot);
    for (const argv of [[], ['--output-root', outputRoot], ['--output-root', '/tmp/ci-metadata'], ['--output-root', argumentsRoot, '--skip']])
      assert.throws(() => validateCiReportMetadataGateArguments(argv, process.env));
    assert.equal(CI_REPORT_METADATA_GATE_LIMITS.stageMs, 90000); assert.equal(CI_REPORT_METADATA_GATE_LIMITS.wholeMs, 180000);
    assert.equal(CI_REPORT_METADATA_ORIGINAL_TESTS.length, 11); assert.equal(CI_REPORT_METADATA_ORIGINAL_TESTS.reduce((sum, row) => sum + row.expectedTests, 0), 173);
  },
];

assert.equal(behaviors.length, 16); assert.equal(names.length, 16);
for (const [index, behavior] of behaviors.entries()) test(names[index], async t => {
  // 同步Git读取之间排空真实TAP进度；不缩减断言、变异或限额。
  await new Promise(resolve => setImmediate(resolve));
  return behavior(t);
});
