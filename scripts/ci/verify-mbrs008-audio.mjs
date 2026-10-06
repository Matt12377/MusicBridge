import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { makeReaderBundleBinding, makeCueBinding } from './verify-mbrs003-scan.mjs';
import { readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseSha = '8140124adbf71f09d4cc27dd0a295b42ff3827c8';
const scopeFile = 'scripts/ci/mbrs008-audio-scope.json';
const packages = ['packages/contracts', 'packages/bridge-core', 'apps/desktop'];
const boundReaderSources = ['recording/source-files', 'library/metadata-reader', 'library/metadata-reader-worker', 'library/metadata-reader-types', 'library/cue-sidecar-reader', 'library/cue-sidecar-worker'];
export const AUDIO_REGRESSION_TESTS = Object.freeze(["packages/bridge-core/test/local-file-gateway.test.ts", "packages/bridge-core/test/mbrs006/controller-local.test.ts", "packages/bridge-core/test/mbrs006/local-facts-fence.test.ts", "packages/bridge-core/test/mbrs006/local-session-lifecycle.test.ts", "packages/bridge-core/test/mbrs006/owner-facts-integration.test.ts", "packages/bridge-core/test/mbrs006/runtime-local.test.ts", "packages/bridge-core/test/playback-event-publisher.test.ts", "packages/bridge-core/test/roon-adapter.test.ts", "packages/bridge-core/test/source-evidence.test.ts", "packages/bridge-core/test/mbrs007/controller-queue.test.ts", "packages/bridge-core/test/mbrs007/edition-queue.test.ts", "packages/bridge-core/test/mbrs007/runtime-queue-protocol.test.ts", "packages/bridge-core/test/recording-workspace.test.ts", "packages/bridge-core/test/recording-capacity-queued-stop.test.ts", "packages/contracts/test/validator.test.ts", "packages/contracts/test/playback-stream.test.ts", "packages/contracts/test/mbrs002/local-playback-compat.test.ts", "packages/contracts/test/mbrs006/local-playback-contract.test.ts", "apps/desktop/test/player-details.test.ts", "apps/desktop/test/playback-stream-reducer.test.ts", "apps/desktop/test/playback-stream-session.test.ts", "apps/desktop/test/mbrs006-local-consumer.test.ts", "apps/desktop/test/mbrs002/local-playback-compat.test.ts"]);
const regression = AUDIO_REGRESSION_TESTS;
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = code => { const error = new Error('008音质透明Gate未准入。'); error.code = code; throw error; };

/** 冻结数量与实际文件清单同时核对，不以测试声明数量代替真实TAP结果。 */
export function assertAudioScope(scope, discovered) {
  if (scope?.schema !== 'mbrs008.audio-scope.v1' || scope.implementationComplete !== true
    || scope.countsConfirmed !== true || scope.baseSha !== baseSha || !Array.isArray(scope.groups)
    || scope.groups.length < 3 || scope.groups.length > 4) reject('AUDIO_SCOPE_NOT_FROZEN');
  const all = [], taskTests = [], names = new Set(), directories = new Set();
  for (const group of scope.groups) {
    if (!/^[a-z][a-z0-9-]{1,60}$/u.test(group.name) || names.has(group.name)
      || !packages.includes(group.directory) || !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0
      || !Array.isArray(group.tests) || group.tests.length === 0) reject('AUDIO_GROUP_INVALID');
    names.add(group.name); directories.add(group.directory);
    for (const test of group.tests) {
      const full = group.directory + '/' + test;
      const isTask = group.directory !== packages[2] ? /^test\/mbrs008\/[A-Za-z0-9_-]+\.test\.ts$/u.test(test)
        : /^test\/mbrs008-[A-Za-z0-9_-]+\.test\.ts$/u.test(test);
      if (typeof test !== 'string' || !isTask && !regression.includes(full)) reject('AUDIO_TEST_PATH_INVALID');
      all.push(full); if (isTask) taskTests.push(full);
    }
  }
  if (packages.some(directory => !directories.has(directory)) || regression.some(test => !all.includes(test))) reject('AUDIO_REQUIRED_REGRESSION_MISSING');
  if (new Set(all).size !== all.length || JSON.stringify(taskTests.sort()) !== JSON.stringify([...discovered].sort())) reject('AUDIO_TEST_INVENTORY_MISMATCH');
  return scope.groups;
}

function nestedTests() {
  const found = [];
  const walk = relative => {
    const info = lstatSync(path.join(repository, relative), { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) reject('AUDIO_TEST_SYMLINK');
    if (info.isDirectory()) for (const item of readdirSync(path.join(repository, relative)).sort()) walk(`${relative}/${item}`);
    else if (info.isFile() && relative.endsWith('.test.ts')) found.push(relative);
  };
  walk('packages/contracts/test/mbrs008');
  walk('packages/bridge-core/test/mbrs008');
  for (const name of readdirSync(path.join(repository, 'apps/desktop/test')).sort()) if (/^mbrs008-.*\.test\.ts$/u.test(name)) walk('apps/desktop/test/' + name);
  return found.sort();
}

export async function runAudioTransparencyGate(argv = process.argv.slice(2), env = process.env) {
  const startedAt = new Date().toISOString(), started = performance.now(), totalLimitMs = 360_000;
  const remaining = () => totalLimitMs - (performance.now() - started);
  const check = () => { if (remaining() <= 0) reject('AUDIO_TOTAL_BUDGET_EXHAUSTED'); };
  const git = args => {
    check();
    const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4 * 1024 * 1024 });
    check(); return value.trim();
  };
  const admission = validateOfflineArguments(argv, env);
  if (Number(process.versions.node.split('.')[0]) !== 22) reject('AUDIO_NODE22_REQUIRED');
  git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  const groups = assertAudioScope(JSON.parse(readFileSync(path.join(repository, scopeFile), 'utf8')), nestedTests());
  const identity = () => {
    check();
    const names = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      'packages/contracts/src', 'packages/contracts/test', 'packages/bridge-core/src', 'packages/bridge-core/test', 'apps/desktop/src', 'apps/desktop/test']).split('\0').filter(Boolean));
    for (const name of [...regression, 'packages/bridge-core/scripts/mbrs001/file-http.ts', 'packages/bridge-core/scripts/mbrs001/fake-roon-sdk.ts', 'packages/bridge-core/scripts/mbrs001/attempt.ts', 'packages/bridge-core/scripts/mbrs001/offline-poc.ts', 'packages/bridge-core/scripts/mbrs001/tsconfig.json', scopeFile, 'scripts/ci/verify-mbrs008-audio.mjs', 'scripts/ci/verify-mbrs008-ui-render.mjs', 'scripts/ci/test/verify-mbrs008-audio.test.mjs', 'scripts/ci/verify-mbrs003-scan.mjs', 'scripts/ci/report-only-admission.mjs', 'scripts/ci/test/report-only-admission.test.mjs', 'packages/bridge-core/scripts/build-metadata-reader-worker.mjs', 'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs', 'apps/desktop/tsconfig.e2e.json', 'apps/desktop/e2e/task-069.spec.ts', 'apps/desktop/e2e/task-070.spec.ts', 'apps/desktop/e2e/task-078.spec.ts', 'apps/desktop/e2e/task-085-collection.spec.ts', 'apps/desktop/e2e/v1-ui.spec.ts', 'apps/desktop/electron.vite.config.ts',
      'scripts/ci/verify-mbrs001-offline.mjs', 'scripts/ci/run-core-tests.mjs', 'scripts/ci/test/run-core-tests.test.mjs', 'apps/desktop/scripts/build-storage-root.mjs',
      '.github/workflows/verify.yml', '.github/workflows/rust-core.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'docs/postrust/MBRS-008/EXECUTION_SCOPE.json', 'docs/postrust/MBRS-008/REUSE_MAP_RESOLVED.md', 'docs/postrust/MBRS-008/AUDIO_TRANSPARENCY_REPORT.md', 'docs/postrust/MBRS-008/FORMAT_CAPABILITY_MATRIX.json', 'docs/postrust/MBRS-008/BOUNDARY_AND_LIMITATIONS.md', 'docs/postrust/MBRS-008/PREVIOUS_DELIVERY_RECEIPT.json', 'docs/postrust/MBRS-008/DEFERRED_MOBILE_HANDOFF.md', 'tasks/MBRS-008_AUDIO_TRANSPARENCY.md',
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
    { name: 'desktop-ui-render', directory: packages[2], args: ['../../scripts/ci/verify-mbrs008-ui-render.mjs'] },
    ...groups.map(group => ({ ...group, args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...group.tests] })),
  ];
  const run = createPrivateRun(admission), runs = [], failures = [], freshOutputs = [], testBindings = [];
  let inputsUnchanged = false, outputsUnchanged = false, testBindingsUnchanged = false, freshCoreCompilation = null;
  const freshUiOutputs = [];
  const fail = code => { if (!failures.includes(code)) failures.push(code); };
  const saveBinding = (file, value, producer) => {
    check(); writePrivateJson(run, file, value);
    const bytes = readFileSync(path.join(run, file)); testBindings.push({ file, bytes: bytes.length, sha256: hash(bytes), producer });
  };
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
    result.captureCompletedAt = new Date().toISOString();
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
    const tmp = path.join(run, 'tmp'); mkdirSync(tmp, { mode: 0o700 }); childEnv = { ...env, TMPDIR: tmp,
      MBRS008_BUILD_ID: 'mbrs008-' + hash(JSON.stringify(sourceInputs)),
      MBRS008_PRIVATE_EVIDENCE_ROOT: path.join(tmp, 'private-evidence'),
      MBRS003_READER_BUILD_BINDING: path.join(run, 'reader-build-binding.json'), MBRS003_CUE_BUILD_BINDING: path.join(run, 'cue-build-binding.json') };
    mkdirSync(childEnv.MBRS008_PRIVATE_EVIDENCE_ROOT, { mode: 0o700 });
    for (const stage of stages) {
      const result = await capture(stage);
      if (!result.success) { fail(result.timedOut ? 'AUDIO_STAGE_TIMEOUT' : 'AUDIO_STAGE_FAILED_OR_INCOMPLETE'); break; }
      if (stage.name === 'desktop-ui-render') {
        const ui = JSON.parse(readFileSync(path.join(childEnv.MBRS008_PRIVATE_EVIDENCE_ROOT, 'ui-render-receipt.json'), 'utf8'));
        if (ui.success !== true || ui.sourceInputsUnchanged !== true || ui.startedAtMs < result.startedMs - 1 || ui.outputs?.length !== 2) reject('AUDIO_UI_RENDER_INCOMPLETE');
        for (const output of ui.outputs) {
          const file = path.join(childEnv.MBRS008_PRIVATE_EVIDENCE_ROOT, output.file), info = lstatSync(file), bytes = readFileSync(file);
          if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs < result.startedMs - 1 || hash(bytes) !== output.sha256 || bytes.length !== output.bytes) reject('AUDIO_UI_OUTPUT_NOT_FRESH');
          freshUiOutputs.push({path: file, bytes: bytes.length, sha256: output.sha256, producer: stage.name});
        }
        saveBinding('ui-render-binding.json', ui, stage.name);
      }
      if (stage.name === 'fresh-contracts-build' || stage.name === 'fresh-core-build') {
        const names = stage.directory === packages[0] ? ['audio-quality', 'local-playback-compat', 'playback', 'index'] : ['application/audio-quality-evidence', 'application/pcm-evidence', 'stream/http-byte-evidence', 'application/bridge-controller', 'application/local-source-resolver', 'collection/local-source-tickets', 'collection/local-source-ticket-types'];
        for (const name of names) for (const ext of ['.js', '.d.ts']) {
          check(); const relative = `${stage.directory}/dist/${name}${ext}`, full = path.join(repository, relative);
          if (!lstatSync(full).isFile() || statSync(full).mtimeMs < result.startedMs - 1) reject('AUDIO_OUTPUT_NOT_FRESH');
          const bytes = readFileSync(full);
          freshOutputs.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name });
        }
        if (stage.name === 'fresh-core-build') {
          if (JSON.stringify(identity()) !== JSON.stringify(sourceInputs)) reject('AUDIO_PRE_BINDING_SOURCE_DRIFT');
          const boundOutputs = [];
          for (const name of boundReaderSources) {
            const sourcePath = `packages/bridge-core/src/${name}.ts`, source = sourceInputs.find(row => row.path === sourcePath);
            if (!source) reject('AUDIO_READER_SOURCE_MISSING');
            for (const ext of ['.js', '.js.map']) {
              check(); const relative = `packages/bridge-core/dist/${name}${ext}`, full = path.join(repository, relative), info = lstatSync(full);
              if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs < result.startedMs || info.mtimeMs > Date.parse(result.captureCompletedAt)) reject('AUDIO_READER_OUTPUT_NOT_FRESH');
              const bytes = readFileSync(full), row = { path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name,
                sourcePath, sourceSha256: source.sha256 };
              boundOutputs.push(row); freshOutputs.push(row);
            }
          }
          freshCoreCompilation = { compilerExit: 0, compilerStartedAtMs: result.startedMs,
            compilerFinishedAtMs: Date.parse(result.captureCompletedAt), outputs: boundOutputs };
          saveBinding('cue-build-binding.json', makeCueBinding(sourceInputs, freshCoreCompilation), stage.name);
        }
      }
      if (stage.name === 'fresh-core-worker-bundle') {
        if (JSON.stringify(identity()) !== JSON.stringify(sourceInputs)) reject('AUDIO_PRE_BINDING_SOURCE_DRIFT');
        const entry = 'packages/bridge-core/dist/library/metadata-reader-worker.bundle';
        const receipt = JSON.parse(readFileSync(path.join(repository, entry + '.build.json'), 'utf8'));
        if (receipt.status !== 'FRESH_FIXED_WORKER_BUNDLE_BUILT' || receipt.startedAtMs < result.startedMs - 1) reject('AUDIO_WORKER_BUNDLE_NOT_FRESH');
        for (const suffix of ['.mjs', '.mjs.map', '.meta.json', '.build.json']) {
          const relative = entry + suffix, bytes = readFileSync(path.join(repository, relative));
          freshOutputs.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), producer: stage.name });
        }
        const fixed = await readFixedMetadataWorkerBundle(path.join(repository, 'packages/bridge-core'), check);
        saveBinding('reader-build-binding.json', makeReaderBundleBinding(sourceInputs, freshCoreCompilation, fixed.manifest), stage.name);
      }
    }
    check(); inputsUnchanged = git(['rev-parse', 'HEAD']) === gitHead && JSON.stringify(identity()) === JSON.stringify(sourceInputs);
    outputsUnchanged = freshOutputs.length === 38 && new Set(freshOutputs.map(x => x.path)).size === 38
      && freshOutputs.every(x => { check(); return hash(readFileSync(path.join(repository, x.path))) === x.sha256; })
      && freshUiOutputs.length === 2 && freshUiOutputs.every(x => {check(); const info=lstatSync(x.path);return info.isFile()&&!info.isSymbolicLink()&&hash(readFileSync(x.path))===x.sha256;});
    testBindingsUnchanged = testBindings.length === 3 && testBindings.every(x => {
      check(); const full = path.join(run, x.file), info = lstatSync(full); return info.isFile() && !info.isSymbolicLink() && hash(readFileSync(full)) === x.sha256;
    });
    if (!inputsUnchanged) fail('AUDIO_SOURCE_DRIFT'); if (!outputsUnchanged) fail('AUDIO_OUTPUT_DRIFT');
    if (!testBindingsUnchanged) fail('AUDIO_TEST_BINDING_DRIFT_OR_INCOMPLETE');
  } catch (error) { fail(error?.code ?? 'AUDIO_EXECUTION_OR_CAPTURE_FAILED'); }
  if (runs.length !== stages.length) fail('AUDIO_STAGES_INCOMPLETE');
  if (remaining() <= 0) fail('AUDIO_TOTAL_BUDGET_EXHAUSTED');
  const success = failures.length === 0 && runs.every(x => x.success) && inputsUnchanged && outputsUnchanged && testBindingsUnchanged;
  writePrivateJson(run, 'manifest.json', { schema: 'mbrs008.audio-transparency-gate.v1', startedAt, completedAt: new Date().toISOString(),
    success, failures, baseSha, gitHead, sourceInputs, inputsUnchanged, freshOutputs, freshUiOutputs, outputsUnchanged, testBindings, testBindingsUnchanged, runs,
    gateBudget: { totalLimitMs, stageLimitMs: 180_000, elapsedMs: performance.now() - started, clock: 'MONOTONIC_PERFORMANCE' },
    evidenceScope: 'CURRENT_OWNER_FILE_PARAMETERS_CONTROLLER_AND_SYNTHETIC_FD_HTTP_OFFLINE_PCM_AND_SSR_NOT_REAL_ROON_OR_DEVICE',
    sourceIdentityScope: 'DECLARED_SOURCE_AND_FRESH_AUDIO_OUTPUTS_NOT_TRANSITIVE_DEPENDENCY_CLOSURE',
    aiNetworkRequired: false, sourceFilesWrite: 'OFF_EXCEPT_OWN_SYNTHETIC_FIXTURES', new100k300kStarted: false,
    realAccountsRoonPlaybackOwnerAcceptance: 'NOT_RUN', at00802_03_04RealRoon: 'NOT_RUN_DEFERRED', at00806GaplessRelockAudio: 'NOT_RUN_DEFERRED', actualLanDeployment: 'NOT_RUN' });
  return success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAudioTransparencyGate().then(code => { process.exitCode = code; }).catch(() => {
    console.error('MBRS008音质透明Gate失败；准备或私有收据未完成，详细值未公开。'); process.exitCode = 1;
  });
}
