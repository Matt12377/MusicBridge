import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseSha = '7570d51973cc23d2a9894f63ba09d6444b9f484a';
const scopeFile = 'scripts/ci/mbrs004-rule-scope.json';
const packages = ['packages/contracts', 'packages/bridge-core'];
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = code => { const error = new Error('004规则Gate未准入。'); error.code = code; throw error; };

/** 冻结数量与实际文件清单同时核对，不以测试声明数量代替真实TAP结果。 */
export function assertRuleScope(scope, discovered) {
  if (scope?.schema !== 'mbrs004.rule-scope.v1' || scope.implementationComplete !== true
    || scope.countsConfirmed !== true || scope.baseSha !== baseSha || !Array.isArray(scope.groups)
    || scope.groups.length < 1 || scope.groups.length > packages.length) reject('RULE_SCOPE_NOT_FROZEN');
  const expected = [], names = new Set(), directories = new Set();
  for (const group of scope.groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name)
      || !packages.includes(group.directory) || directories.has(group.directory)
      || !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0
      || !Array.isArray(group.tests) || group.tests.length === 0) reject('RULE_GROUP_INVALID');
    names.add(group.name); directories.add(group.directory);
    for (const test of group.tests) {
      if (typeof test !== 'string' || !/^test\/mbrs004\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.ts$/u.test(test)) reject('RULE_TEST_PATH_INVALID');
      expected.push(`${group.directory}/${test}`);
    }
  }
  if (!directories.has('packages/bridge-core')) reject('RULE_SCOPE_NOT_FROZEN');
  if (new Set(expected).size !== expected.length
    || JSON.stringify(expected.sort()) !== JSON.stringify([...discovered].sort())) reject('RULE_TEST_INVENTORY_MISMATCH');
  return scope.groups;
}

function nestedTests() {
  const found = [];
  const walk = relative => {
    const info = lstatSync(path.join(repository, relative), { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) reject('RULE_TEST_SYMLINK');
    if (info.isDirectory()) for (const item of readdirSync(path.join(repository, relative)).sort()) walk(`${relative}/${item}`);
    else if (info.isFile() && relative.endsWith('.test.ts')) found.push(relative);
  };
  for (const directory of packages) walk(`${directory}/test/mbrs004`);
  return found.sort();
}

export async function runRuleGate(argv = process.argv.slice(2), env = process.env) {
  const startedAt = new Date().toISOString(), started = performance.now(), totalLimitMs = 360_000;
  const remaining = () => totalLimitMs - (performance.now() - started);
  const check = () => { if (remaining() <= 0) reject('RULE_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => {
    check();
    const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4 * 1024 * 1024 });
    check(); return value.trim();
  };
  const admission = validateOfflineArguments(argv, env);
  if (Number(process.versions.node.split('.')[0]) !== 22) reject('RULE_NODE22_REQUIRED');
  git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  const groups = assertRuleScope(JSON.parse(readFileSync(path.join(repository, scopeFile), 'utf8')), nestedTests());
  const identity = () => {
    check();
    const names = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      'packages/contracts/src', 'packages/contracts/test', 'packages/bridge-core/src', 'packages/bridge-core/test']).split('\0').filter(Boolean));
    for (const name of [scopeFile, 'scripts/ci/verify-mbrs004-rules.mjs', 'scripts/ci/test/verify-mbrs004-rules.test.mjs',
      'scripts/ci/verify-mbrs001-offline.mjs', 'apps/desktop/scripts/build-storage-root.mjs',
      '.github/workflows/verify.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'docs/postrust/MBRS-004/upstream-lock.json', 'tasks/MBRS-004_COVERDROP_NAME_VERSION_RULES.md',
      ...packages.flatMap(p => [`${p}/package.json`, `${p}/tsconfig.json`, `${p}/tsconfig.test.json`])]) names.add(name);
    return [...names].sort().map(relative => {
      check(); const bytes = readFileSync(path.join(repository, relative));
      return { path: relative, bytes: bytes.length, sha256: hash(bytes) };
    });
  };
  const gitHead = git(['rev-parse', 'HEAD']), sourceInputs = identity();
  const require = createRequire(path.join(repository, 'packages/bridge-core/package.json'));
  const tsc = require.resolve('typescript/bin/tsc'); require.resolve('tsx');
  const stages = [
    { name: 'fresh-contracts-build', directory: packages[0], args: [tsc, '-p', 'tsconfig.json'] },
    { name: 'fresh-core-build', directory: packages[1], args: [tsc, '-p', 'tsconfig.json'] },
    ...packages.map(directory => ({ name: directory === packages[0] ? 'contracts-types' : 'core-types', directory, args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] })),
    ...groups.map(group => ({ ...group, args: ['--import', 'tsx', '--test', '--test-reporter=tap', ...group.tests] })),
  ];
  const run = createPrivateRun(admission), runs = [], failures = [], freshOutputs = [];
  let inputsUnchanged = false, outputsUnchanged = false;
  const fail = code => { if (!failures.includes(code)) failures.push(code); };
  const capture = async stage => {
    check();
    const stageStarted = performance.now(), limitMs = Math.min(180_000, remaining());
    const result = { name: stage.name, directory: stage.directory, expectedTests: stage.expectedTests ?? null,
      startedAt: new Date().toISOString(), startedMs: Date.now(), limitMs, exitCode: null, signal: null, closeObserved: false,
      timedOut: false, overflow: false, captureFailed: false, preparationFailed: false, groupTerminationFailed: false };
    const chunks = []; let length = 0, child, timer;
    const terminate = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error?.code !== 'ESRCH') result.groupTerminationFailed = true; }
    };
    await new Promise(resolve => {
      try {
        child = spawn(process.execPath, stage.args, { cwd: path.join(repository, stage.directory), env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { result.preparationFailed = true; resolve(); return; }
      child.once('close', (code, signal) => { clearTimeout(timer); result.exitCode = code; result.signal = signal; result.closeObserved = true; resolve(); });
      child.once('error', () => { result.preparationFailed = true; terminate(); });
      const append = bytes => {
        if (result.overflow || result.captureFailed) return;
        try {
          if (length + bytes.length > 4 * 1024 * 1024) { result.overflow = true; terminate(); return; }
          chunks.push(Buffer.from(bytes)); length += bytes.length;
        } catch { result.captureFailed = true; terminate(); }
      };
      child.stdout.on('data', append); child.stderr.on('data', append);
      for (const stream of [child.stdout, child.stderr]) stream.once('error', () => { result.captureFailed = true; terminate(); });
      timer = setTimeout(() => { result.timedOut = true; terminate(); }, Math.max(1, limitMs));
    });
    const raw = Buffer.concat(chunks).toString('utf8');
    result.rawSha256 = hash(raw); result.durationMs = performance.now() - stageStarted;
    result.testCounts = stage.expectedTests === undefined ? null : parseTestCounts(raw);
    result.testSummaryValid = stage.expectedTests === undefined ? null : isCompleteTestRun(result.testCounts, stage.expectedTests);
    result.log = `${stage.name}.log`; const safe = sanitizeOutput(raw); result.logSha256 = hash(safe);
    writeFileSync(path.join(run, result.log), safe, { flag: 'wx', mode: 0o600 });
    result.success = result.exitCode === 0 && result.signal === null && result.closeObserved && !result.timedOut
      && !result.overflow && !result.captureFailed && !result.preparationFailed && !result.groupTerminationFailed
      && (stage.expectedTests === undefined || result.testSummaryValid);
    runs.push(result); return result;
  };
  let childEnv;
  try {
    const tmp = path.join(run, 'tmp'); mkdirSync(tmp, { mode: 0o700 }); childEnv = { ...env, TMPDIR: tmp };
    for (const stage of stages) {
      const result = await capture(stage);
      if (!result.success) { fail(result.timedOut ? 'RULE_STAGE_TIMEOUT' : 'RULE_STAGE_FAILED_OR_INCOMPLETE'); break; }
      if (stage.name.startsWith('fresh-')) {
        const names = stage.directory === packages[0] ? ['local-name-rules', 'index'] : ['library/local-name-rules'];
        for (const name of names) for (const ext of ['.js', '.d.ts']) {
          check(); const relative = `${stage.directory}/dist/${name}${ext}`, full = path.join(repository, relative);
          if (!lstatSync(full).isFile() || statSync(full).mtimeMs < result.startedMs - 1) reject('RULE_OUTPUT_NOT_FRESH');
          const bytes = readFileSync(full);
          freshOutputs.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name });
        }
      }
    }
    check(); inputsUnchanged = git(['rev-parse', 'HEAD']) === gitHead && JSON.stringify(identity()) === JSON.stringify(sourceInputs);
    outputsUnchanged = freshOutputs.length === 6 && freshOutputs.every(x => { check(); return hash(readFileSync(path.join(repository, x.path))) === x.sha256; });
    if (!inputsUnchanged) fail('RULE_SOURCE_DRIFT'); if (!outputsUnchanged) fail('RULE_OUTPUT_DRIFT');
  } catch (error) { fail(error?.code ?? 'RULE_EXECUTION_OR_CAPTURE_FAILED'); }
  if (runs.length !== stages.length) fail('RULE_STAGES_INCOMPLETE');
  if (remaining() <= 0) fail('RULE_TOTAL_BUDGET_EXHAUSTED');
  const success = failures.length === 0 && runs.every(x => x.success) && inputsUnchanged && outputsUnchanged;
  writePrivateJson(run, 'manifest.json', { schema: 'mbrs004.rule-gate.v1', startedAt, completedAt: new Date().toISOString(),
    success, failures, baseSha, gitHead, sourceInputs, inputsUnchanged, freshOutputs, outputsUnchanged, runs,
    gateBudget: { totalLimitMs, stageLimitMs: 180_000, elapsedMs: performance.now() - started, clock: 'MONOTONIC_PERFORMANCE' },
    evidenceScope: 'PURE_RULES_AND_SYNTHETIC_EXISTING_CATALOG_SCAN_INTEGRATION',
    sourceIdentityScope: 'DECLARED_SOURCE_AND_FRESH_RULE_OUTPUTS_NOT_TRANSITIVE_DEPENDENCY_CLOSURE',
    aiNetworkRequired: false, sourceFilesWrite: 'OFF', new100k300kStarted: false,
    realAccountsRoonPlaybackOwnerAcceptance: 'NOT_RUN', at006Playback: 'DEFERRED_TO_MBRS005_MBRS006_AND_FINAL_ACCEPTANCE' });
  return success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRuleGate().then(code => { process.exitCode = code; }).catch(() => {
    console.error('MBRS004规则Gate失败；准备或私有收据未完成，详细值未公开。'); process.exitCode = 1;
  });
}
