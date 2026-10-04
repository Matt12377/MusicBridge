import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const core = path.join(repository, 'packages/bridge-core');
const external = '/Volumes/LifeWeave/Developer/CommandLine';
const within = (candidate, root) => candidate === root || candidate.startsWith(root + path.sep);
const sha = value => createHash('sha256').update(value).digest('hex');
const testCountKeys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

/** 只接收唯一且完整的TAP最终summary；重复字段不能last-write覆盖。 */
export function parseTestCounts(raw) {
  const counts = {};
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (.*)$/u.exec(line);
    if (!match) continue;
    if (Object.hasOwn(counts, match[1]) || !/^\d+$/u.test(match[2])) return null;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    counts[match[1]] = value;
  }
  return testCountKeys.every(key => Object.hasOwn(counts, key)) ? counts : null;
}

export function isCompleteTestRun(counts, expected) {
  return counts !== null && typeof counts === 'object' && Object.keys(counts).length === testCountKeys.length
    && Number.isSafeInteger(expected) && expected > 0
    && testCountKeys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    && counts.tests === expected && counts.pass === expected
    && ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0);
}

/** 只接受一个output-root；先解析全部flags，再准入所有存储，再允许任何副作用。 */
export function validateOfflineArguments(argv, env = process.env) {
  if (argv.length !== 1 || !argv[0].startsWith('--output-root=') || argv[0].slice(14).length === 0) throw new Error('离线入口只接受一个明确output-root参数。');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('本轮离线Gate仅支持Darwin及Linux的自有进程组。');
  const outputRoot = argv[0].slice(14);
  const storage = buildStoragePolicy({ env });
  if (!storage.hosted) {
    if (storage.root !== external || statSync('/Volumes/LifeWeave').dev === statSync('/').dev) throw new Error('本机离线任务只准入真实LifeWeave命令行根。');
  }
  const output = storage.check(outputRoot);
  if (!storage.hosted && !within(output, path.join(external, 'tmp'))) throw new Error('本机离线输出必须在LifeWeave任务tmp根。');
  if (existsSync(output) || lstatSync(output, { throwIfNoEntry: false })) throw new Error('离线输出必须是全新run，禁止覆盖。');
  const temporary = storage.check(env.TMPDIR, { mustExist: true });
  const temporaryInfo = lstatSync(temporary);
  if ((temporaryInfo.mode & 0o777) !== 0o700 || (process.getuid && temporaryInfo.uid !== process.getuid())) throw new Error('离线临时目录必须为本runner所有的0700目录。');
  if (!storage.hosted && !within(temporary, path.join(external, 'tmp'))) throw new Error('本机离线临时目录必须在LifeWeave任务tmp根。');
  const cache = storage.check(env.DEV_CACHE_ROOT, { mustExist: true });
  if (!storage.hosted && !within(cache, path.join(external, 'Caches'))) throw new Error('本机缓存必须沿LifeWeave共享缓存根。');
  for (const key of ['COREPACK_HOME', 'npm_config_cache', 'ELECTRON_CACHE', 'electron_config_cache', 'XDG_CACHE_HOME']) {
    if (env[key] !== undefined) {
      const candidate = storage.check(env[key]);
      if (!within(candidate, cache)) throw new Error('离线缓存环境越出准入缓存根。');
    }
  }
  accessSync(temporary, constants.R_OK | constants.W_OK);
  accessSync(cache, constants.R_OK | constants.W_OK);
  return { output, temporary, cache, storage };
}

export function createPrivateRun(admission) {
  // admission只来自以上解析；首写前再核祖先和目标不存在，mkdir不复用叶目录。
  admission.storage.check(admission.output);
  if (existsSync(admission.output) || lstatSync(admission.output, { throwIfNoEntry: false })) throw new Error('run已存在，禁止覆盖。');
  mkdirSync(path.dirname(admission.output), { recursive: true, mode: 0o700 });
  mkdirSync(admission.output, { mode: 0o700 });
  admission.storage.check(admission.output, { mustExist: true });
  if ((lstatSync(admission.output).mode & 0o777) !== 0o700) throw new Error('新run权限必须为0700。');
  return admission.output;
}

export function writePrivateJson(run, filename, value) {
  if (!/^[a-zA-Z0-9_.-]+\.json$/u.test(filename)) throw new Error('私有结果文件名不合法。');
  writeFileSync(path.join(run, filename), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

/** TAP仅保留状态/计数，舍弃名称、actual/expected/stack等任意诊断字节。 */
export function sanitizeOutput(raw) {
  const safe = [];
  let omitted = 0;
  for (const line of raw.split(/\r?\n/u)) {
    const test = /^\s*(not ok|ok) (\d+)(?:\s+-.*)?$/u.exec(line);
    if (test) { safe.push(`${test[1]} ${test[2]} - case_${test[2]}`); continue; }
    if (/^TAP version \d+$|^\s*1\.\.\d+$|^# (tests|suites|pass|fail|cancelled|skipped|todo) \d+$/u.test(line)) { safe.push(line.trim()); continue; }
    const code = /error (TS\d+):/u.exec(line);
    if (code) { safe.push(`TypeScript ${code[1]}（详细值未公开）`); continue; }
    if (line.trim()) omitted += 1;
  }
  safe.push(`# omitted_diagnostic_lines ${omitted}`);
  return safe.join('\n') + '\n';
}

async function capture(run, name, args, cwd, env, displayArgs = args) {
  const started = Date.now();
  const result = await new Promise(resolve => {
    const chunks = []; let rawByteLength = 0; let overflow = false; let timedOut = false;
    let preparationFailed = false; let groupTerminationFailed = false;
    // POSIX detached创建本stage独立session/process group；只清理该自有组，避免遗留node --test子进程。
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let killed = false;
    const terminateOwnedGroup = () => {
      if (killed || child.pid === undefined) return;
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) {
        if (error.code !== 'ESRCH') groupTerminationFailed = true;
      }
    };
    const append = bytes => {
      if (overflow) return;
      if (rawByteLength + bytes.length > 4 * 1024 * 1024) { overflow = true; terminateOwnedGroup(); }
      else { chunks.push(Buffer.from(bytes)); rawByteLength += bytes.length; }
    };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; terminateOwnedGroup(); }, 180_000);
    child.once('error', () => { preparationFailed = true; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); resolve({ rawBytes: Buffer.concat(chunks, rawByteLength), exitCode, signal, overflow, timedOut, preparationFailed, groupTerminationFailed });
    });
  });
  const decoded = result.rawBytes.toString('utf8');
  const sanitized = sanitizeOutput(decoded);
  const testCounts = parseTestCounts(decoded);
  const log = `${name}.log`;
  writeFileSync(path.join(run, log), sanitized, { flag: 'wx', mode: 0o600 });
  return { name, argv: ['node', ...displayArgs], exitCode: result.exitCode, signal: result.signal,
    overflow: result.overflow, timedOut: result.timedOut, preparationFailed: result.preparationFailed, groupTerminationFailed: result.groupTerminationFailed,
    durationMs: Date.now() - started, processIsolation: 'OWNED_POSIX_PROCESS_GROUP', testCounts,
    log, logSha256: sha(sanitized), capturedRawSha256: sha(result.rawBytes), rawDiagnosticBytes: result.rawBytes.length,
    rawCaptureScope: 'BOUNDED_STDOUT_STDERR_OBSERVED_ARRIVAL_BYTES', diagnosticsPolicy: 'ALLOWLIST_STATUS_COUNTS_ONLY' };
}

export async function runOfflineGate(argv = process.argv.slice(2), env = process.env) {
  const admission = validateOfflineArguments(argv, env);
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('离线Gate要求Node22。');
  const require = createRequire(path.join(core, 'package.json'));
  const tsc = require.resolve('typescript/bin/tsc');
  // 不安装依赖；解析失败属于准备失败，且发生在首mkdir/child前。
  require.resolve('tsx');
  // HEAD及声明的直接输入在所有存储准入后、首写前读取；不冒充传递依赖完整闭集。
  const readHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const gitHead = readHead();
  if (!/^[a-f0-9]{40}$/u.test(gitHead)) throw new Error('离线Gate无法绑定Git HEAD。');
  const sources = ['packages/bridge-core/scripts/mbrs001/file-http.ts', 'packages/bridge-core/scripts/mbrs001/fake-roon-sdk.ts',
    'packages/bridge-core/scripts/mbrs001/attempt.ts', 'packages/bridge-core/scripts/mbrs001/offline-poc.ts',
    'packages/bridge-core/scripts/mbrs001/tsconfig.json', 'packages/bridge-core/scripts/mbrs001/test/file-http.test.ts',
    'packages/bridge-core/scripts/mbrs001/test/official-adapter.test.ts', 'packages/bridge-core/scripts/mbrs001/test/attempt-lifecycle.test.ts',
    'scripts/ci/verify-mbrs001-offline.mjs', '.github/workflows/verify.yml', 'packages/bridge-core/src/roon/adapter.ts',
    'packages/bridge-core/src/roon/sdk.ts', 'packages/bridge-core/src/roon/types.ts', 'packages/bridge-core/src/stream/gateway.ts',
    'packages/bridge-core/src/stream/registry.ts', 'packages/bridge-core/test/roon-adapter.test.ts',
    'packages/bridge-core/test/gateway.test.ts', 'packages/bridge-core/test/registry.test.ts',
    'apps/desktop/scripts/build-storage-root.mjs', 'apps/desktop/scripts/build-storage-root.d.mts',
    'packages/bridge-core/tsconfig.json', 'packages/bridge-core/tsconfig.test.json',
    'packages/contracts/tsconfig.json', 'packages/contracts/package.json', 'packages/bridge-core/package.json',
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
  const readInputs = () => sources.map(relative => { const bytes = readFileSync(path.join(repository, relative)); return { path: relative, bytes: bytes.length, sha256: sha(bytes) }; });
  const identities = readInputs();
  const run = createPrivateRun(admission);
  const temporary = path.join(run, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const childEnv = { ...env, TMPDIR: temporary };
  const runs = [];
  const stages = [];
  if (!existsSync(path.join(repository, 'packages/contracts/dist/index.js')) || !existsSync(path.join(repository, 'packages/contracts/dist/index.d.ts'))) {
    stages.push({ name: 'contracts-preparation', args: [tsc, '-p', 'tsconfig.json'], cwd: path.join(repository, 'packages/contracts'), display: ['typescript/bin/tsc', '-p', 'tsconfig.json'] });
  }
  stages.push({ name: 'nested-noemit', args: [tsc, '-p', 'scripts/mbrs001/tsconfig.json', '--noEmit'], cwd: core, display: ['typescript/bin/tsc', '-p', 'scripts/mbrs001/tsconfig.json', '--noEmit'] },
    { name: 'nested-behavior', expectedTests: 32, args: ['--import', 'tsx', '--test', '--test-reporter=tap', 'scripts/mbrs001/test/file-http.test.ts', 'scripts/mbrs001/test/official-adapter.test.ts', 'scripts/mbrs001/test/attempt-lifecycle.test.ts'], cwd: core },
    { name: 'existing-regressions', expectedTests: 118, args: ['--import', 'tsx', '--test', '--test-reporter=tap', 'test/roon-adapter.test.ts', 'test/gateway.test.ts', 'test/registry.test.ts'], cwd: core },
    { name: 'offline-reproduction', args: ['--import', 'tsx', 'scripts/mbrs001/offline-poc.ts', `--output-root=${path.join(run, 'poc')}`], display: ['--import', 'tsx', 'scripts/mbrs001/offline-poc.ts', '--output-root=<run>/poc'], cwd: core });
  const stageSucceeded = result => result.exitCode === 0 && !result.signal && !result.timedOut && !result.overflow
    && !result.preparationFailed && !result.groupTerminationFailed
    && (result.expectedTests === null || isCompleteTestRun(result.testCounts, result.expectedTests));
  for (const stage of stages) {
    const captured = await capture(run, stage.name, stage.args, stage.cwd, childEnv, stage.display ?? stage.args);
    const expectedTests = stage.expectedTests ?? null;
    const result = { ...captured, expectedTests,
      testSummaryValid: expectedTests === null ? null : isCompleteTestRun(captured.testCounts, expectedTests) };
    runs.push(result);
    if (!stageSucceeded(result)) break;
  }
  let success = runs.length === stages.length && runs.every(stageSucceeded);
  let failureReason = success ? null : 'STAGE_FAILED_OR_INCOMPLETE';
  let poc = null;
  if (success) {
    try {
      const result = readFileSync(path.join(run, 'poc', 'result.json'));
      const parsed = JSON.parse(result.toString('utf8'));
      if (parsed.synthetic !== true || parsed.completed !== true || parsed.liveRoon !== 'BLOCKED_ENV'
        || parsed.localResources.openFds !== 0 || parsed.localResources.activeRequestRefs !== 0 || parsed.localResources.actualClosedHandleProbe !== true) throw new Error('离线结果没有实际资源收口。');
      poc = { file: 'poc/result.json', sha256: sha(result), bytes: result.length };
    } catch { success = false; failureReason = 'POC_RECEIPT_INVALID'; }
  }
  let inputsUnchanged = false;
  try { inputsUnchanged = readHead() === gitHead && JSON.stringify(readInputs()) === JSON.stringify(identities); }
  catch { /* 声明输入消失或HEAD读取失败同样不能成功。 */ }
  if (!inputsUnchanged) { success = false; failureReason = 'DECLARED_INPUT_OR_HEAD_DRIFT'; }
  writePrivateJson(run, 'manifest.json', { schema: 'mbrs001.offline-gate.v1', synthetic: true, success, failureReason,
    liveRoon: 'BLOCKED_ENV', ownerAcceptance: 'NOT_TESTED', finiteSoftwareG0: 'ADMITTED',
    finiteSoftwareG0Authority: 'RUST-016_LIMITED_SOFTWARE_ADMISSION',
    gitHead, identityScope: 'PINNED_GIT_HEAD_WITH_DECLARED_DIRECT_INPUTS', declaredInputsUnchanged: inputsUnchanged,
    sourceInputs: identities, runs, poc,
    knownGapsAreObservationsNotFixes: true });
  return success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runOfflineGate().then(code => { process.exitCode = code; }).catch(() => {
    console.error('MBRS001离线Gate失败；未公开原路径或内部诊断值。'); process.exitCode = 1;
  });
}
