import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseSha = '52c9ffe0aec3c581fe4682a8fd3ba8edf1a74f58';
const scopeFile = 'scripts/ci/mbrs005-gateway-scope.json';
const packages = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'];
const regression = ['packages/bridge-core/test/gateway.test.ts', 'packages/bridge-core/test/config.test.ts', 'packages/bridge-core/test/registry.test.ts', 'packages/bridge-core/test/source-evidence.test.ts', 'packages/bridge-core/test/mbrs002/local-source-resolver.test.ts', 'apps/desktop/test/dataset-owner-bootstrap.test.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = code => { const error = new Error('005网关Gate未准入。'); error.code = code; throw error; };

/** 冻结数量与实际文件清单同时核对，不以测试声明数量代替真实TAP结果。 */
export function assertGatewayScope(scope, discovered) {
  if (scope?.schema !== 'mbrs005.gateway-scope.v1' || scope.implementationComplete !== true
    || scope.countsConfirmed !== true || scope.baseSha !== baseSha || !Array.isArray(scope.groups)
    || scope.groups.length < 2 || scope.groups.length > 4) reject('GATEWAY_SCOPE_NOT_FROZEN');
  const all = [], taskTests = [], names = new Set(), directories = new Set();
  for (const group of scope.groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name)
      || !packages.slice(1).includes(group.directory) || !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0
      || !Array.isArray(group.tests) || group.tests.length === 0) reject('GATEWAY_GROUP_INVALID');
    names.add(group.name); directories.add(group.directory);
    for (const test of group.tests) {
      const full = group.directory + '/' + test;
      const isTask = group.directory === packages[1] ? /^test\/mbrs005\/[A-Za-z0-9_-]+\.test\.ts$/u.test(test)
        : /^test\/mbrs005-[A-Za-z0-9_-]+\.test\.ts$/u.test(test);
      if (typeof test !== 'string' || !isTask && !regression.includes(full)) reject('GATEWAY_TEST_PATH_INVALID');
      all.push(full); if (isTask) taskTests.push(full);
    }
  }
  if (!directories.has(packages[1]) || !directories.has(packages[2]) || regression.some(test => !all.includes(test))) reject('GATEWAY_REQUIRED_REGRESSION_MISSING');
  if (new Set(all).size !== all.length || JSON.stringify(taskTests.sort()) !== JSON.stringify([...discovered].sort())) reject('GATEWAY_TEST_INVENTORY_MISMATCH');
  return scope.groups;
}

function nestedTests() {
  const found = [];
  const walk = relative => {
    const info = lstatSync(path.join(repository, relative), { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) reject('GATEWAY_TEST_SYMLINK');
    if (info.isDirectory()) for (const item of readdirSync(path.join(repository, relative)).sort()) walk(`${relative}/${item}`);
    else if (info.isFile() && relative.endsWith('.test.ts')) found.push(relative);
  };
  walk('packages/bridge-core/test/mbrs005');
  for (const name of readdirSync(path.join(repository, 'apps/desktop/test')).sort()) if (/^mbrs005-.*\.test\.ts$/u.test(name)) walk('apps/desktop/test/' + name);
  return found.sort();
}

export async function runGatewayGate(argv = process.argv.slice(2), env = process.env) {
  const startedAt = new Date().toISOString(), started = performance.now(), totalLimitMs = 360_000;
  const remaining = () => totalLimitMs - (performance.now() - started);
  const check = () => { if (remaining() <= 0) reject('GATEWAY_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => {
    check();
    const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4 * 1024 * 1024 });
    check(); return value.trim();
  };
  const admission = validateOfflineArguments(argv, env);
  if (Number(process.versions.node.split('.')[0]) !== 22) reject('GATEWAY_NODE22_REQUIRED');
  git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  const groups = assertGatewayScope(JSON.parse(readFileSync(path.join(repository, scopeFile), 'utf8')), nestedTests());
  const identity = () => {
    check();
    const names = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      'packages/contracts/src', 'packages/contracts/test', 'packages/bridge-core/src', 'packages/bridge-core/test', 'apps/desktop/src', 'apps/desktop/test']).split('\0').filter(Boolean));
    for (const name of [scopeFile, 'scripts/ci/verify-mbrs005-gateway.mjs', 'scripts/ci/test/verify-mbrs005-gateway.test.mjs', 'scripts/ci/report-only-admission.mjs', 'scripts/ci/test/report-only-admission.test.mjs', 'packages/bridge-core/scripts/build-metadata-reader-worker.mjs', 'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs', 'apps/desktop/tsconfig.e2e.json', 'apps/desktop/electron.vite.config.ts',
      'scripts/ci/verify-mbrs001-offline.mjs', 'apps/desktop/scripts/build-storage-root.mjs',
      '.github/workflows/verify.yml', '.github/workflows/rust-core.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'docs/postrust/MBRS-005/EXECUTION_SCOPE.json', 'docs/postrust/MBRS-005/NETWORK_ACCESS.md', 'tasks/MBRS-005_LOCAL_FILE_GATEWAY.md',
      ...packages.flatMap(p => [`${p}/package.json`, `${p}/tsconfig.json`, ...(p === 'apps/desktop' ? [] : [`${p}/tsconfig.test.json`])])]) names.add(name);
    return [...names].sort().map(relative => {
      check(); const bytes = readFileSync(path.join(repository, relative));
      return { path: relative, bytes: bytes.length, sha256: hash(bytes) };
    });
  };
  const gitHead = git(['rev-parse', 'HEAD']), sourceInputs = identity();
  const require = createRequire(path.join(repository, 'packages/bridge-core/package.json'));
  const tsc = require.resolve('typescript/bin/tsc'); require.resolve('tsx');
  const desktopRequire = createRequire(path.join(repository, 'apps/desktop/package.json'));
  const stages = [
    { name: 'fresh-contracts-build', directory: packages[0], args: [tsc, '-p', 'tsconfig.json'] },
    { name: 'fresh-core-build', directory: packages[1], args: [tsc, '-p', 'tsconfig.json'] },
    { name: 'fresh-core-worker-bundle', directory: packages[1], args: ['scripts/build-metadata-reader-worker.mjs'] },
    { name: 'core-types', directory: packages[1], args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'desktop-types', directory: packages[2], args: [desktopRequire.resolve('vue-tsc/bin/vue-tsc.js'), '-p', 'tsconfig.json', '--noEmit'] },
    { name: 'desktop-e2e-types', directory: packages[2], args: [tsc, '-p', 'tsconfig.e2e.json', '--noEmit'] },
    ...groups.map(group => ({ ...group, args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...group.tests] })),
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
    result.log = `${stage.name}.log`; const safe = sanitizeOutput(raw).replace(/\/local-stream\/[A-Za-z0-9_-]+/gu, '/local-stream/[已脱敏]'); result.logSha256 = hash(safe);
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
      if (!result.success) { fail(result.timedOut ? 'GATEWAY_STAGE_TIMEOUT' : 'GATEWAY_STAGE_FAILED_OR_INCOMPLETE'); break; }
      if (stage.name === 'fresh-contracts-build' || stage.name === 'fresh-core-build') {
        const names = stage.directory === packages[0] ? ['index'] : ['stream/local-file-source', 'stream/local-file-http', 'stream/physical-resource-locks', 'stream/gateway', 'stream/registry', 'recording/source-files', 'runtime'];
        for (const name of names) for (const ext of ['.js', '.d.ts']) {
          check(); const relative = `${stage.directory}/dist/${name}${ext}`, full = path.join(repository, relative);
          if (!lstatSync(full).isFile() || statSync(full).mtimeMs < result.startedMs - 1) reject('GATEWAY_OUTPUT_NOT_FRESH');
          const bytes = readFileSync(full);
          freshOutputs.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name });
        }
      }
      if (stage.name === 'fresh-core-worker-bundle') {
        const entry = 'packages/bridge-core/dist/library/metadata-reader-worker.bundle';
        const receipt = JSON.parse(readFileSync(path.join(repository, entry + '.build.json'), 'utf8'));
        if (receipt.status !== 'FRESH_FIXED_WORKER_BUNDLE_BUILT' || receipt.startedAtMs < result.startedMs - 1) reject('GATEWAY_WORKER_BUNDLE_NOT_FRESH');
        for (const suffix of ['.mjs', '.mjs.map', '.meta.json', '.build.json']) {
          const relative = entry + suffix, bytes = readFileSync(path.join(repository, relative));
          freshOutputs.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name });
        }
      }
    }
    check(); inputsUnchanged = git(['rev-parse', 'HEAD']) === gitHead && JSON.stringify(identity()) === JSON.stringify(sourceInputs);
    outputsUnchanged = freshOutputs.length === 20 && freshOutputs.every(x => { check(); return hash(readFileSync(path.join(repository, x.path))) === x.sha256; });
    if (!inputsUnchanged) fail('GATEWAY_SOURCE_DRIFT'); if (!outputsUnchanged) fail('GATEWAY_OUTPUT_DRIFT');
  } catch (error) { fail(error?.code ?? 'GATEWAY_EXECUTION_OR_CAPTURE_FAILED'); }
  if (runs.length !== stages.length) fail('GATEWAY_STAGES_INCOMPLETE');
  if (remaining() <= 0) fail('GATEWAY_TOTAL_BUDGET_EXHAUSTED');
  const success = failures.length === 0 && runs.every(x => x.success) && inputsUnchanged && outputsUnchanged;
  writePrivateJson(run, 'manifest.json', { schema: 'mbrs005.gateway-gate.v1', startedAt, completedAt: new Date().toISOString(),
    success, failures, baseSha, gitHead, sourceInputs, inputsUnchanged, freshOutputs, outputsUnchanged, runs,
    gateBudget: { totalLimitMs, stageLimitMs: 180_000, elapsedMs: performance.now() - started, clock: 'MONOTONIC_PERFORMANCE' },
    evidenceScope: 'PRODUCTION_LOCAL_FILE_GATEWAY_AND_REAL_OWN_SYNTHETIC_HTTP_WORKER_IO_NOT_REAL_ROON',
    sourceIdentityScope: 'DECLARED_SOURCE_AND_FRESH_GATEWAY_OUTPUTS_NOT_TRANSITIVE_DEPENDENCY_CLOSURE',
    aiNetworkRequired: false, sourceFilesWrite: 'OFF_EXCEPT_OWN_SYNTHETIC_FIXTURES', new100k300kStarted: false,
    realAccountsRoonPlaybackOwnerAcceptance: 'NOT_RUN', at00506RealRoon: 'NOT_RUN_DEFERRED', actualLanDeployment: 'NOT_RUN' });
  return success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGatewayGate().then(code => { process.exitCode = code; }).catch(() => {
    console.error('MBRS005网关Gate失败；准备或私有收据未完成，详细值未公开。'); process.exitCode = 1;
  });
}
