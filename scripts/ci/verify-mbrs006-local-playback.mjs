import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseSha = 'cce8594f4b6e9872afd576bb1b032f526c93af72';
const scopeFile = 'scripts/ci/mbrs006-local-playback-scope.json';
const packages = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'];
const regression = ["packages/contracts/test/playback-stream.test.ts", "packages/contracts/test/validator.test.ts", "packages/contracts/test/mbrs002/local-play-request.test.ts", "packages/contracts/test/mbrs002/local-playback-compat.test.ts", "packages/bridge-core/test/controller.test.ts", "packages/bridge-core/test/roon-adapter.test.ts", "packages/bridge-core/test/runtime.test.ts", "packages/bridge-core/test/playback-event-publisher.test.ts", "packages/bridge-core/test/dataset-owner.test.ts", "packages/bridge-core/test/dataset-owner-integration.test.ts", "packages/bridge-core/test/source-evidence.test.ts", "packages/bridge-core/test/mbrs002/local-source-resolver.test.ts", "apps/desktop/test/mbrs002/local-playback-compat.test.ts", "apps/desktop/test/playback-session.test.ts", "apps/desktop/test/playbackFavorites.test.ts", "apps/desktop/test/playback-stream-reducer.test.ts", "apps/desktop/test/dataset-owner-bootstrap.test.ts", "apps/desktop/test/rust-core-host.test.ts", "apps/desktop/test/mbrs003/local-library-front-boundary.test.ts", "apps/desktop/test/mbrs003/local-library-ipc.test.ts", "apps/desktop/test/mbrs003/local-library-client.test.ts", "packages/bridge-core/test/utility-playback-stream.test.ts", "packages/bridge-core/test/controller-context.test.ts", "packages/bridge-core/test/roon-sdk-callback-context.test.ts", "packages/bridge-core/test/runtime-compact-events.test.ts"];
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = code => { const error = new Error('006本地播放Gate未准入。'); error.code = code; throw error; };

/** 冻结数量与实际文件清单同时核对，不以测试声明数量代替真实TAP结果。 */
export function assertLocalPlaybackScope(scope, discovered) {
  if (scope?.schema !== 'mbrs006.local-playback-scope.v1' || scope.implementationComplete !== true
    || scope.countsConfirmed !== true || scope.baseSha !== baseSha || !Array.isArray(scope.groups)
    || scope.groups.length < 3 || scope.groups.length > 4) reject('LOCAL_PLAYBACK_SCOPE_NOT_FROZEN');
  const all = [], taskTests = [], names = new Set(), directories = new Set();
  for (const group of scope.groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name)
      || !packages.includes(group.directory) || !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0
      || !Array.isArray(group.tests) || group.tests.length === 0) reject('LOCAL_PLAYBACK_GROUP_INVALID');
    names.add(group.name); directories.add(group.directory);
    for (const test of group.tests) {
      const full = group.directory + '/' + test;
      const isTask = group.directory !== packages[2] ? /^test\/mbrs006\/[A-Za-z0-9_-]+\.test\.ts$/u.test(test)
        : /^test\/mbrs006-[A-Za-z0-9_-]+\.test\.ts$/u.test(test);
      if (typeof test !== 'string' || !isTask && !regression.includes(full)) reject('LOCAL_PLAYBACK_TEST_PATH_INVALID');
      all.push(full); if (isTask) taskTests.push(full);
    }
  }
  if (packages.some(directory => !directories.has(directory)) || regression.some(test => !all.includes(test))) reject('LOCAL_PLAYBACK_REQUIRED_REGRESSION_MISSING');
  if (new Set(all).size !== all.length || JSON.stringify(taskTests.sort()) !== JSON.stringify([...discovered].sort())) reject('LOCAL_PLAYBACK_TEST_INVENTORY_MISMATCH');
  return scope.groups;
}

function nestedTests() {
  const found = [];
  const walk = relative => {
    const info = lstatSync(path.join(repository, relative), { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) reject('LOCAL_PLAYBACK_TEST_SYMLINK');
    if (info.isDirectory()) for (const item of readdirSync(path.join(repository, relative)).sort()) walk(`${relative}/${item}`);
    else if (info.isFile() && relative.endsWith('.test.ts')) found.push(relative);
  };
  walk('packages/contracts/test/mbrs006');
  walk('packages/bridge-core/test/mbrs006');
  for (const name of readdirSync(path.join(repository, 'apps/desktop/test')).sort()) if (/^mbrs006-.*\.test\.ts$/u.test(name)) walk('apps/desktop/test/' + name);
  return found.sort();
}

export async function runLocalPlaybackGate(argv = process.argv.slice(2), env = process.env) {
  const startedAt = new Date().toISOString(), started = performance.now(), totalLimitMs = 360_000;
  const remaining = () => totalLimitMs - (performance.now() - started);
  const check = () => { if (remaining() <= 0) reject('LOCAL_PLAYBACK_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => {
    check();
    const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4 * 1024 * 1024 });
    check(); return value.trim();
  };
  const admission = validateOfflineArguments(argv, env);
  if (Number(process.versions.node.split('.')[0]) !== 22) reject('LOCAL_PLAYBACK_NODE22_REQUIRED');
  git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  const groups = assertLocalPlaybackScope(JSON.parse(readFileSync(path.join(repository, scopeFile), 'utf8')), nestedTests());
  const identity = () => {
    check();
    const names = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      'packages/contracts/src', 'packages/contracts/test', 'packages/bridge-core/src', 'packages/bridge-core/test', 'apps/desktop/src', 'apps/desktop/test']).split('\0').filter(Boolean));
    for (const name of [scopeFile, 'scripts/ci/verify-mbrs006-local-playback.mjs', 'scripts/ci/test/verify-mbrs006-local-playback.test.mjs', 'scripts/ci/report-only-admission.mjs', 'scripts/ci/test/report-only-admission.test.mjs', 'packages/bridge-core/scripts/build-metadata-reader-worker.mjs', 'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs', 'apps/desktop/tsconfig.e2e.json', 'apps/desktop/electron.vite.config.ts',
      'scripts/ci/verify-mbrs001-offline.mjs', 'apps/desktop/scripts/build-storage-root.mjs',
      '.github/workflows/verify.yml', '.github/workflows/rust-core.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'docs/postrust/MBRS-006/EXECUTION_SCOPE.json', 'docs/postrust/MBRS-006/API_BEHAVIOR_MAPPING.md', 'tasks/MBRS-006_LOCAL_AUDIO_INPUT.md',
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
    { name: 'contracts-types', directory: packages[0], args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] },
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
      if (!result.success) { fail(result.timedOut ? 'LOCAL_PLAYBACK_STAGE_TIMEOUT' : 'LOCAL_PLAYBACK_STAGE_FAILED_OR_INCOMPLETE'); break; }
      if (stage.name === 'fresh-contracts-build' || stage.name === 'fresh-core-build') {
        const names = stage.directory === packages[0] ? ['index'] : ['application/bridge-controller', 'application/local-source-resolver', 'application/playback-event-publisher', 'roon/adapter', 'collection/dataset-owner-worker', 'collection/local-source-tickets', 'collection/repository', 'stream/local-source-fence', 'recording/source-store', 'runtime', 'utility-main'];
        for (const name of names) for (const ext of ['.js', '.d.ts']) {
          check(); const relative = `${stage.directory}/dist/${name}${ext}`, full = path.join(repository, relative);
          if (!lstatSync(full).isFile() || statSync(full).mtimeMs < result.startedMs - 1) reject('LOCAL_PLAYBACK_OUTPUT_NOT_FRESH');
          const bytes = readFileSync(full);
          freshOutputs.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name });
        }
      }
      if (stage.name === 'fresh-core-worker-bundle') {
        const entry = 'packages/bridge-core/dist/library/metadata-reader-worker.bundle';
        const receipt = JSON.parse(readFileSync(path.join(repository, entry + '.build.json'), 'utf8'));
        if (receipt.status !== 'FRESH_FIXED_WORKER_BUNDLE_BUILT' || receipt.startedAtMs < result.startedMs - 1) reject('LOCAL_PLAYBACK_WORKER_BUNDLE_NOT_FRESH');
        for (const suffix of ['.mjs', '.mjs.map', '.meta.json', '.build.json']) {
          const relative = entry + suffix, bytes = readFileSync(path.join(repository, relative));
          freshOutputs.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name });
        }
      }
    }
    check(); inputsUnchanged = git(['rev-parse', 'HEAD']) === gitHead && JSON.stringify(identity()) === JSON.stringify(sourceInputs);
    outputsUnchanged = freshOutputs.length === 28 && freshOutputs.every(x => { check(); return hash(readFileSync(path.join(repository, x.path))) === x.sha256; });
    if (!inputsUnchanged) fail('LOCAL_PLAYBACK_SOURCE_DRIFT'); if (!outputsUnchanged) fail('LOCAL_PLAYBACK_OUTPUT_DRIFT');
  } catch (error) { fail(error?.code ?? 'LOCAL_PLAYBACK_EXECUTION_OR_CAPTURE_FAILED'); }
  if (runs.length !== stages.length) fail('LOCAL_PLAYBACK_STAGES_INCOMPLETE');
  if (remaining() <= 0) fail('LOCAL_PLAYBACK_TOTAL_BUDGET_EXHAUSTED');
  const success = failures.length === 0 && runs.every(x => x.success) && inputsUnchanged && outputsUnchanged;
  writePrivateJson(run, 'manifest.json', { schema: 'mbrs006.local-playback-gate.v1', startedAt, completedAt: new Date().toISOString(),
    success, failures, baseSha, gitHead, sourceInputs, inputsUnchanged, freshOutputs, outputsUnchanged, runs,
    gateBudget: { totalLimitMs, stageLimitMs: 180_000, elapsedMs: performance.now() - started, clock: 'MONOTONIC_PERFORMANCE' },
    evidenceScope: 'SAME_PRODUCTION_CONTROLLER_ADAPTER_OWNER_AND_SYNTHETIC_SDK_SQL_HTTP_IO_NOT_REAL_ROON',
    sourceIdentityScope: 'DECLARED_SOURCE_AND_FRESH_LOCAL_PLAYBACK_OUTPUTS_NOT_TRANSITIVE_DEPENDENCY_CLOSURE',
    aiNetworkRequired: false, sourceFilesWrite: 'OFF_EXCEPT_OWN_SYNTHETIC_FIXTURES', new100k300kStarted: false,
    realAccountsRoonPlaybackOwnerAcceptance: 'NOT_RUN', at00601_04_07RealRoon: 'NOT_RUN_DEFERRED', actualLanDeployment: 'NOT_RUN' });
  return success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLocalPlaybackGate().then(code => { process.exitCode = code; }).catch(() => {
    console.error('MBRS006本地播放Gate失败；准备或私有收据未完成，详细值未公开。'); process.exitCode = 1;
  });
}
