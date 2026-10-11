import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';
import { parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { CI_REPORT_MIRROR_TASK, CI_REPORT_MIRROR_BRANCH, CI_REPORT_MIRROR_BASE,
  CI_REPORT_MIRROR_PRODUCT_SOURCE, CI_REPORT_MIRROR_SOURCE_FILES, CI_REPORT_MIRROR_REPORT_PATHS,
  inspectCiReportMirrorAdmission, inspectCiReportMirrorReportAdmission,
  inspectCiReportMirrorHistoricalObjects } from './ci-report-mirror-admission.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const external = '/Volumes/LifeWeave/Developer/CommandLine';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const within = (value, root) => value.startsWith(root + path.sep);
const closedCode = error => /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'CI_REPORT_MIRROR_GATE_FAILED';
function refuse(code) { const error = new Error('报告镜像工具 Gate 拒绝。'); error.code = code; throw error; }

export const CI_REPORT_MIRROR_GATE_LIMITS = Object.freeze({ stageMs: 90_000, wholeMs: 180_000,
  rawBytesPerStream: 16 * 1024 * 1024, gitBytes: 16 * 1024 * 1024, gitMs: 10_000 });

/** 叶文件与原173例不改写、不裁剪；旧报告失败的原命令仍完整执行。 */
export const CI_REPORT_MIRROR_ORIGINAL_TESTS = Object.freeze([
  ['report-only-admission.test.mjs', 20, 12057, 'db445f1c055b1d1577fbc22a10667a081edff02481eca9d58c8b9adf5fd31ec8'],
  ['mbm000-report-only-admission.test.mjs', 13, 14742, 'ae41a9ed6734e1750a3215822a222eefab7aafea470e3b490564896c77ef9ea4'],
  ['mbm001-report-only-admission.test.mjs', 17, 27758, '4b77aa5ddf157620560548d01dbf474df4559b83ad22c7a9dad25de82b3d0e24'],
  ['report-only-mbm002.test.mjs', 17, 28934, '4b17b9a36bd00297cac68133a2a5580b7dff805898084b23a0da267dabd85435'],
  ['report-only-mbm003.test.mjs', 19, 30369, '6248229a897f67208e8f92bb0648e041e2b1f93bad8696268e039ed6e56f2e64'],
  ['local-library-signed-stat-fix-admission.test.mjs', 14, 14577, '4f004a214ed9ebb05054f86d3a784a14258684109dce39b4c090c29d232b004e'],
  ['tape-catalog-common-admission.test.mjs', 42, 52154, '1475184a8cac603ace7da821c7f0076bb3e6a272cbbb16d523ddd095a6fe1afd'],
  ['tape-catalog-common-gate.test.mjs', 9, 13828, 'ead746ece407019fdf94a3949b9f11b7e093300a5f1501f2b175786b1c354614'],
  ['task-applicability.test.mjs', 7, 3187, '994a03406378866784a0f7b098dc88d00504f669576139b1fa0e84adc4b4e77b'],
  ['mbm004-admission.test.mjs', 9, 12905, '7cbbf7dfc903435544b147edc8c06a33cc298ba55e73f2a21199346c741ce8a4'],
  ['mbm004-report-only.test.mjs', 6, 14166, '693fae146a93cdeabfe265dcc2b125046d171ae3fb782b72c1f1733c3b04f689'],
].map(([name, expectedTests, bytes, hash]) => Object.freeze({
  path: 'scripts/ci/test/' + name, expectedTests, bytes, sha256: hash,
})));

export const CI_REPORT_MIRROR_SAFETY_CASE_NAMES = Object.freeze([
  '镜像修复真实Source十二路径与独立Git身份准入',
  '镜像修复真实直接Report八路径与本地分类准入',
  '镜像修复错误base与多父Source均拒绝',
  '镜像修复未知branch与dirty工作区均拒绝',
  '镜像修复真实Git环境重定向不能取得别仓库资格',
  '镜像修复shallow与Git overlay均拒绝',
  '镜像修复第十三Source路径与产品漂移均拒绝',
  '镜像修复Scope漏项改角色改pin与模式均拒绝',
  '镜像修复固定Correction与原失败身份不可替换',
  '镜像修复报告错误父链多父与第九路径均拒绝',
  '镜像修复报告不得改冻结Scope产品与文件模式',
  '镜像修复报告不能提升原账本或真实验收层',
  '镜像修复实际准入结果不能用普通对象冒充',
  '镜像修复独立mirror缺历史对象拒绝且不自动fetch',
  '镜像修复独立mirror两固定历史对象完整且来源不漂移',
  '镜像修复当前六job工具producer与唯一工具artifact闭合',
  '镜像修复失败producer重复run与skipped工具步骤拒绝',
  '镜像修复旧产品skipped不能冒充新软件PASS',
  '镜像修复工具捕获自然退出完整raw与物理关闭',
  '镜像修复工具超时溢出与残留进程不能写PASS',
]);

export function ciReportMirrorGitEnvironment(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(clean, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' });
  return clean;
}

function git(directory, args, env, deadline = Infinity) {
  const timeout = Math.floor(Math.min(CI_REPORT_MIRROR_GATE_LIMITS.gitMs, deadline - performance.now()));
  if (timeout <= 0) refuse('CI_REPORT_MIRROR_WHOLE_TIMEOUT');
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=', ...args], { cwd: directory, env: ciReportMirrorGitEnvironment(env),
    timeout, maxBuffer: CI_REPORT_MIRROR_GATE_LIMITS.gitBytes, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.signal !== null || result.status !== 0) refuse('CI_REPORT_MIRROR_GIT_READ_FAILED');
  if (performance.now() >= deadline) refuse('CI_REPORT_MIRROR_WHOLE_TIMEOUT');
  return result.stdout;
}

export function ciReportMirrorIdentity(directory, env = process.env, deadline = Infinity) {
  const top = git(directory, ['rev-parse', '--show-toplevel'], env, deadline).trim();
  const commonDir = git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env, deadline).trim();
  const gitDir = git(directory, ['rev-parse', '--path-format=absolute', '--git-dir'], env, deadline).trim();
  if (top !== directory || commonDir !== path.join(directory, '.git') || gitDir !== commonDir
    || !lstatSync(commonDir).isDirectory() || lstatSync(commonDir).isSymbolicLink()
    || realpathSync(commonDir) !== commonDir) refuse('CI_REPORT_MIRROR_INDEPENDENT_GIT_REQUIRED');
  const head = git(directory, ['rev-parse', '--verify', 'HEAD'], env, deadline).trim();
  const tree = git(directory, ['rev-parse', '--verify', 'HEAD^{tree}'], env, deadline).trim();
  const branch = git(directory, ['branch', '--show-current'], env, deadline).trim();
  const status = git(directory, ['status', '--porcelain=v1', '--untracked-files=all'], env, deadline);
  if (!/^[a-f0-9]{40}$/u.test(head) || !/^[a-f0-9]{40}$/u.test(tree)
    || branch !== CI_REPORT_MIRROR_BRANCH || status !== '') refuse('CI_REPORT_MIRROR_CHECKOUT_NOT_PINNED_CLEAN');
  return { head, tree, branch, status, commonDir, gitDir };
}

function wholeFile(directory, relative) {
  const filename = path.join(directory, relative), info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(filename) !== filename
    || (info.mode & 0o111) !== 0 || info.size > CI_REPORT_MIRROR_GATE_LIMITS.gitBytes)
    refuse('CI_REPORT_MIRROR_INPUT_MODE_OR_BOUND_INVALID');
  const raw = readFileSync(filename);
  const after = lstatSync(filename);
  if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || raw.length !== after.size)
    refuse('CI_REPORT_MIRROR_INPUT_CHANGED_DURING_READ');
  return { path: relative, bytes: raw.length, sha256: sha256(raw), mode: '100644' };
}

export function inspectCiReportMirrorGateInputs(directory, env = process.env,
  deadline = performance.now() + CI_REPORT_MIRROR_GATE_LIMITS.wholeMs) {
  const identity = ciReportMirrorIdentity(directory, env, deadline);
  const parents = git(directory, ['rev-list', '--parents', '-n', '1', identity.head], env, deadline).trim().split(' ');
  if (parents.length !== 2 || parents[0] !== identity.head) refuse('CI_REPORT_MIRROR_UNIQUE_PARENT_REQUIRED');
  const source = parents[1] === CI_REPORT_MIRROR_BASE
    ? inspectCiReportMirrorAdmission(directory, env, { deadline }) : inspectCiReportMirrorReportAdmission(directory, env, { deadline });
  const repairRole = parents[1] === CI_REPORT_MIRROR_BASE ? 'source' : 'report';
  if (source.task !== CI_REPORT_MIRROR_TASK || source.repairRole !== repairRole
    || source.headAtAdmission !== identity.head || source.productSource !== CI_REPORT_MIRROR_PRODUCT_SOURCE
    || source.currentToolGateRequired !== true || source.currentProductTestsRepeated !== false)
    refuse('CI_REPORT_MIRROR_CURRENT_ADMISSION_REQUIRED');
  const history = inspectCiReportMirrorHistoricalObjects(directory, env, { deadline });
  const originalTests = CI_REPORT_MIRROR_ORIGINAL_TESTS.map(expected => {
    const actual = wholeFile(directory, expected.path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      refuse('CI_REPORT_MIRROR_ORIGINAL_173_INPUT_DRIFT');
    return { ...actual, expectedTests: expected.expectedTests };
  });
  const sourcePaths = CI_REPORT_MIRROR_SOURCE_FILES.map(row => typeof row === 'string' ? row : row.path);
  const reportPaths = CI_REPORT_MIRROR_REPORT_PATHS.map(row => typeof row === 'string' ? row : row.path);
  if (sourcePaths.length !== 12 || reportPaths.length !== 8
    || new Set(sourcePaths).size !== 12 || new Set(reportPaths).size !== 8
    || originalTests.reduce((count, row) => count + row.expectedTests, 0) !== 173)
    refuse('CI_REPORT_MIRROR_TOOL_INPUT_CLOSED_SET_INVALID');
  const currentFiles = [...new Set([...sourcePaths, ...(repairRole === 'report' ? reportPaths : [])])]
    .sort().map(relative => wholeFile(directory, relative));
  if (performance.now() >= deadline) refuse('CI_REPORT_MIRROR_WHOLE_TIMEOUT');
  return { identity, admission: source, historicalObjects: history, originalTests, currentFiles };
}

/** 只接收指定新叶目录；hosted也不能用任意/tmp冒充RUNNER_TEMP。 */
export function validateCiReportMirrorGateArguments(argv, env = process.env) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--output-root' || !argv[1]
    || !path.isAbsolute(argv[1]) || path.resolve(argv[1]) !== argv[1] || /[\r\n\0]/u.test(argv[1]))
    refuse('CI_REPORT_MIRROR_GATE_ARGUMENTS_INVALID');
  if (!['darwin', 'linux'].includes(process.platform) || process.versions.node.split('.')[0] !== '22')
    refuse('CI_REPORT_MIRROR_NODE22_POSIX_REQUIRED');
  if (env.NODE_OPTIONS || env.NODE_PATH) refuse('CI_REPORT_MIRROR_NODE_OVERRIDE_REJECTED');
  const storage = buildStoragePolicy({ env });
  if (!storage.hosted && (storage.root !== external || statSync('/Volumes/LifeWeave').dev === statSync('/').dev))
    refuse('CI_REPORT_MIRROR_EXTERNAL_VOLUME_REQUIRED');
  const outputRoot = storage.check(argv[1]), parent = path.dirname(outputRoot);
  if (!storage.hosted && !within(outputRoot, path.join(external, 'tmp')))
    refuse('CI_REPORT_MIRROR_OUTPUT_OUTSIDE_EXTERNAL_TMP');
  if (existsSync(outputRoot) || lstatSync(outputRoot, { throwIfNoEntry: false }))
    refuse('CI_REPORT_MIRROR_OUTPUT_ALREADY_EXISTS');
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent)
    refuse('CI_REPORT_MIRROR_OUTPUT_PARENT_INVALID');
  return { outputRoot, storage };
}

function writeJson(outputRoot, filename, value) {
  writeFileSync(path.join(outputRoot, filename), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function absence(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { pidAbsent: false, processGroupAbsent: false };
  const gone = value => { try { process.kill(value, 0); return false; } catch (error) { return error?.code === 'ESRCH'; } };
  return { pidAbsent: gone(pid), processGroupAbsent: gone(-pid) };
}

/** 只读PID/PPID/PGID/启动时刻；不读取进程命令、环境、账号或凭据。 */
function processForest(deadline) {
  const timeout = Math.floor(Math.min(1000, deadline - performance.now()));
  if (!Number.isFinite(deadline) || timeout < 1) return null;
  const result = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart='], {
    env: { PATH: process.env.PATH, LC_ALL: 'C' }, timeout, maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || result.signal !== null || performance.now() >= deadline) return null;
  const rows = new Map();
  for (const line of result.stdout.split('\n').filter(value => value.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) return null;
    const [pid, ppid, pgid] = match.slice(1, 4).map(Number);
    if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid < 1 || ppid < 0 || pgid < 0 || rows.has(pid)) return null;
    rows.set(pid, { pid, ppid, pgid, started: match[4] });
  }
  return rows;
}

/** 实际自有POSIX进程组；只有close+exit+PID/组均物理消失才可写通过。 */
export async function captureCiReportMirrorStage({ directory, outputRoot, name, args, env = process.env,
  expectedTests = null, expectedCaseNames = null, timeoutMs = CI_REPORT_MIRROR_GATE_LIMITS.stageMs,
  deadline = performance.now() + CI_REPORT_MIRROR_GATE_LIMITS.wholeMs,
  maxBytesPerStream = CI_REPORT_MIRROR_GATE_LIMITS.rawBytesPerStream }) {
  if (!/^[a-z0-9-]+$/u.test(name) || !Array.isArray(args) || args.some(value => typeof value !== 'string')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CI_REPORT_MIRROR_GATE_LIMITS.stageMs
    || !Number.isSafeInteger(maxBytesPerStream) || maxBytesPerStream < 1
    || maxBytesPerStream > CI_REPORT_MIRROR_GATE_LIMITS.rawBytesPerStream || !Number.isFinite(deadline))
    refuse('CI_REPORT_MIRROR_STAGE_BOUND_INVALID');
  const startedAtMs = Date.now(), began = performance.now();
  const budgetMs = Math.floor(Math.min(timeoutMs, deadline - began));
  if (budgetMs < 1) refuse('CI_REPORT_MIRROR_WHOLE_TIMEOUT');
  const stageDeadline = Math.min(deadline, began + budgetMs);
  const buffers = { stdout: [], stderr: [] }, lengths = { stdout: 0, stderr: 0 };
  let timedOut = false, overflow = false, spawnFailed = false, exitObserved = false, closeObserved = false;
  let interrupted = false, cleanupFailed = false, terminationRequested = false, child;
  let rawForcedClosed = false, boundedSettleObserved = false, descendantScanFailed = false, unexpectedPipeHolder = false;
  const owned = new Map();
  const scan = () => {
    const rows = processForest(stageDeadline);
    if (rows === null) { descendantScanFailed = true; return null; }
    if (child?.pid && rows.has(child.pid)) {
      const previous = owned.get(child.pid), current = rows.get(child.pid);
      if (previous && previous.started !== current.started) descendantScanFailed = true;
      else owned.set(child.pid, current);
    }
    const originalRoot = owned.get(child?.pid), currentRoot = rows.get(child?.pid);
    if (originalRoot && (!currentRoot || currentRoot.started === originalRoot.started)) {
      // 直属进程自然退出后，同一自有组的后代仍需完成物理关闭。
      for (const row of rows.values()) if (row.pgid === child.pid && !owned.has(row.pid)) owned.set(row.pid, row);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        const parent = owned.get(row.ppid), actualParent = rows.get(row.ppid);
        if (!owned.has(row.pid) && parent && actualParent?.started === parent.started) { owned.set(row.pid, row); changed = true; }
      }
    }
    if ([...owned.values()].some(entry => entry.pgid === 0)) { descendantScanFailed = true; cleanupFailed = true; }
    return rows;
  };
  const terminate = () => {
    terminationRequested = true;
    if (!child?.pid) return;
    const rows = scan(), groups = new Set(!exitObserved ? [child.pid] : []);
    if (rows) for (const entry of owned.values()) {
      const observed = rows.get(entry.pid);
      if (observed?.started === entry.started && observed.pgid === child.pid) groups.add(child.pid);
    }
    if (rows) for (const entry of owned.values()) {
      const observed = rows.get(entry.pid);
      if (observed?.started === entry.started && observed.pgid !== child.pid) {
        // 只终止已证实属于本stage后代的独立组；未知组没有清理权限。
        if (observed.pgid > 0 && owned.has(observed.pgid)) groups.add(observed.pgid); else cleanupFailed = true;
      }
    }
    if (rows === null) {
      cleanupFailed = true;
      // ps失败仍终止本API detached spawn形成的已知直属组；未知后代组不获清理资格。
    }
    for (const group of groups) try { process.kill(-group, 'SIGKILL'); }
    catch (error) { if (error?.code !== 'ESRCH') cleanupFailed = true; }
  };
  const interrupt = () => { interrupted = true; terminate(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let result;
  try {
    result = await new Promise(resolve => {
      child = spawn(process.execPath, args, { cwd: directory, env, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
      scan(); const monitor = setInterval(scan, 40);
      let settled = false, exitPipeTimer = null, exitCodeSeen = null, signalSeen = null;
      const finish = value => {
        if (settled) return; settled = true; clearInterval(monitor); clearTimeout(timer);
        clearTimeout(finalTimer); if (exitPipeTimer !== null) clearTimeout(exitPipeTimer); resolve(value);
      };
      const forceSettle = () => {
        if (settled) return;
        timedOut = performance.now() >= stageDeadline || timedOut;
        boundedSettleObserved = true; rawForcedClosed = true; cleanupFailed = true; terminate();
        child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        finish({ exitCode: exitCodeSeen, signal: signalSeen });
      };
      const append = stream => bytes => {
        const remaining = maxBytesPerStream - lengths[stream];
        if (bytes.length > remaining) {
          if (remaining > 0) { buffers[stream].push(Buffer.from(bytes.subarray(0, remaining))); lengths[stream] += remaining; }
          overflow = true; terminate(); return;
        }
        if (overflow) return;
        buffers[stream].push(Buffer.from(bytes)); lengths[stream] += bytes.length;
      };
      child.stdout.on('data', append('stdout')); child.stderr.on('data', append('stderr'));
      child.stdout.on('error', () => { cleanupFailed = true; terminate(); });
      child.stderr.on('error', () => { cleanupFailed = true; terminate(); });
      // 把清理时间留在本stage/whole原截止内；杀主组后pipe不关也必须有界失败返回。
      const remainingMs = Math.max(0, stageDeadline - performance.now());
      const reserve = Math.min(1000, Math.floor(remainingMs / 5));
      const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, remainingMs - reserve));
      const finalTimer = setTimeout(forceSettle, Math.max(1, stageDeadline - performance.now()));
      child.once('error', () => { spawnFailed = true; });
      child.once('exit', (exitCode, signal) => {
        exitObserved = true; exitCodeSeen = exitCode; signalSeen = signal;
        exitPipeTimer = setTimeout(() => { if (!settled) { unexpectedPipeHolder = true; terminate(); } },
          Math.min(250, Math.max(1, stageDeadline - performance.now())));
      });
      child.once('close', (exitCode, signal) => {
        closeObserved = true; finish({ exitCode, signal });
      });
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  let physicalShutdown = absence(child?.pid), finalForest = scan();
  const descendantsRemain = () => finalForest === null || [...owned.values()].some(entry => entry.pid !== child?.pid
    && finalForest.get(entry.pid)?.started === entry.started);
  const lingeringOwnedGroup = (!physicalShutdown.processGroupAbsent || descendantsRemain() || unexpectedPipeHolder) && Boolean(child?.pid);
  if (lingeringOwnedGroup) {
    terminate();
    for (let attempts = 0; attempts < 20 && performance.now() < stageDeadline
      && (!physicalShutdown.pidAbsent || !physicalShutdown.processGroupAbsent || descendantsRemain()); attempts++) {
      const remainingMs = Math.floor(stageDeadline - performance.now());
      if (remainingMs < 1) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(10, remainingMs)));
      physicalShutdown = absence(child.pid); finalForest = scan();
    }
  }
  finalForest = scan();
  const observedDescendants = [...owned.values()].filter(entry => entry.pid !== child?.pid).map(entry => ({
    pid: entry.pid, pgid: entry.pgid, started: entry.started,
    physicallyAbsent: finalForest !== null && finalForest.get(entry.pid)?.started !== entry.started,
  }));
  const observedDescendantsAbsent = finalForest !== null && observedDescendants.every(row => row.physicallyAbsent);
  if (!physicalShutdown.pidAbsent || !physicalShutdown.processGroupAbsent || !observedDescendantsAbsent || descendantScanFailed)
    cleanupFailed = true;
  const raw = {};
  for (const stream of ['stdout', 'stderr']) {
    const bytes = Buffer.concat(buffers[stream], lengths[stream]), filename = `${name}.${stream}.log`;
    writeFileSync(path.join(outputRoot, filename), bytes, { flag: 'wx', mode: 0o600 });
    raw[stream] = { path: filename, bytes: bytes.length, sha256: sha256(bytes) };
  }
  const decoded = Buffer.concat(buffers.stdout, lengths.stdout).toString('utf8');
  const testCounts = expectedTests === null ? null : parseTestCounts(decoded);
  const plans = [...decoded.matchAll(/^1\.\.(\d+)\s*$/gmu)].map(match => Number(match[1]));
  const cases = [...decoded.matchAll(/^(ok|not ok) (\d+) - (.*)$/gmu)].map(match => ({
    status: match[1], ordinal: Number(match[2]), name: match[3],
  }));
  const tapComplete = expectedTests === null || isCompleteTestRun(testCounts, expectedTests)
    && plans.length === 1 && plans[0] === expectedTests && cases.length === expectedTests
    && cases.every((row, index) => row.status === 'ok' && row.ordinal === index + 1 && !/ # (?:SKIP|TODO)\b/iu.test(row.name));
  const actualCaseNames = cases.map(row => row.name);
  const caseNamesMatched = expectedCaseNames === null
    || JSON.stringify(actualCaseNames) === JSON.stringify(expectedCaseNames);
  const durationMs = performance.now() - began;
  if (performance.now() >= stageDeadline || performance.now() >= deadline || durationMs > budgetMs) timedOut = true;
  const passed = result.exitCode === 0 && result.signal === null && exitObserved && closeObserved
    && !timedOut && !overflow && !spawnFailed && !interrupted && !cleanupFailed && !lingeringOwnedGroup
    && durationMs <= budgetMs && performance.now() < stageDeadline && performance.now() < deadline
    && tapComplete && caseNamesMatched;
  const receipt = { name, command: ['node', ...args], directory, pid: child?.pid ?? null,
    startedAtMs, finishedAtMs: Date.now(), durationMs, budgetMs,
    ...result, exitObserved, closeObserved, timedOut, overflow, spawnFailed, interrupted,
    cleanupFailed, terminationRequested, lingeringOwnedGroup, physicalShutdown,
    observedDescendants, observedDescendantsAbsent, descendantScanFailed,
    rawForcedClosed, boundedSettleObserved, unexpectedPipeHolder,
    raw, rawCaptureComplete: closeObserved && !overflow && !spawnFailed && !rawForcedClosed,
    rawCaptureScope: 'FULL_SEPARATE_STDOUT_STDERR_BYTES_UNTIL_CLOSE_WITH_FIXED_BOUNDS',
    expectedTests, testCounts, tapComplete, expectedCaseNames, actualCaseNames, caseNamesMatched, passed };
  writeJson(outputRoot, `${name}.json`, receipt);
  return receipt;
}

/** 当前Source/直接Report工具验证；不执行旧产品Gate、编译、安装或App。 */
export async function runCiReportMirrorGate(argv = process.argv.slice(2), env = process.env) {
  const began = performance.now(), deadline = began + CI_REPORT_MIRROR_GATE_LIMITS.wholeMs;
  const storage = validateCiReportMirrorGateArguments(argv, env);
  const before = inspectCiReportMirrorGateInputs(repository, env, deadline);
  storage.storage.check(storage.outputRoot);
  mkdirSync(storage.outputRoot, { mode: 0o700 });
  if ((lstatSync(storage.outputRoot).mode & 0o777) !== 0o700) refuse('CI_REPORT_MIRROR_PRIVATE_RUN_REQUIRED');
  const temporary = path.join(storage.outputRoot, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const temporaryIdentity = lstatSync(temporary);
  writeJson(storage.outputRoot, 'source-before.json', before);
  const childEnvironment = ciReportMirrorGitEnvironment({ ...env, TMPDIR: temporary });
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete childEnvironment[key];
  const stages = [], failures = []; let after = null, temporaryCleanup = { createdByThisGate: true, removed: false };
  try {
    stages.push(await captureCiReportMirrorStage({ directory: repository, outputRoot: storage.outputRoot,
      name: 'original-173', args: ['--test', ...CI_REPORT_MIRROR_ORIGINAL_TESTS.map(row => row.path)],
      env: childEnvironment, expectedTests: 173, deadline }));
    if (!stages.at(-1).passed) refuse('CI_REPORT_MIRROR_ORIGINAL_173_NOT_COMPLETE');
    stages.push(await captureCiReportMirrorStage({ directory: repository, outputRoot: storage.outputRoot,
      name: 'mirror-safety', args: ['--test', '--test-reporter=tap', 'scripts/ci/test/ci-report-mirror.test.mjs'],
      env: childEnvironment, expectedTests: CI_REPORT_MIRROR_SAFETY_CASE_NAMES.length,
      expectedCaseNames: [...CI_REPORT_MIRROR_SAFETY_CASE_NAMES], deadline }));
    if (!stages.at(-1).passed) refuse('CI_REPORT_MIRROR_SAFETY_NOT_COMPLETE');
    const currentTemporary = lstatSync(temporary);
    if (currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino
      || !currentTemporary.isDirectory() || currentTemporary.isSymbolicLink() || (currentTemporary.mode & 0o777) !== 0o700
      || realpathSync(temporary) !== temporary || !within(temporary, realpathSync(storage.outputRoot))
      || stages.some(row => !row.passed || !row.physicalShutdown.pidAbsent || !row.physicalShutdown.processGroupAbsent
        || row.observedDescendantsAbsent !== true || row.rawCaptureComplete !== true))
      refuse('CI_REPORT_MIRROR_TMP_CLEANUP_NOT_OWNED_OR_CLOSED');
    rmSync(temporary, { recursive: true, force: false });
    temporaryCleanup = { createdByThisGate: true, removed: !existsSync(temporary),
      dev: temporaryIdentity.dev, ino: temporaryIdentity.ino, mode: '0700',
      onlyCurrentOwnedTmpRemoved: true, allStageOwnedProcessesPhysicallyClosed: true };
    if (!temporaryCleanup.removed) refuse('CI_REPORT_MIRROR_TMP_CLEANUP_INCOMPLETE');
  } catch (error) { failures.push(closedCode(error)); }
  try {
    after = inspectCiReportMirrorGateInputs(repository, env, deadline);
    writeJson(storage.outputRoot, 'source-after.json', after);
    if (JSON.stringify(before) !== JSON.stringify(after)) refuse('CI_REPORT_MIRROR_SOURCE_INPUT_DRIFT');
  } catch (error) { failures.push(closedCode(error)); }
  const success = failures.length === 0 && stages.length === 2 && stages.every(row => row.passed)
    && after !== null && JSON.stringify(before) === JSON.stringify(after) && performance.now() < deadline;
  const summary = { schema: 'musicbridge.ci-report-mirror.tool-gate.v1', task: CI_REPORT_MIRROR_TASK,
    status: success ? 'PASSED_CURRENT_TOOL_GATE' : 'FAILED', success,
    headAtRun: before.identity.head, sourceSha: before.admission.sourceSha, repairRole: before.admission.repairRole,
    baseSha: CI_REPORT_MIRROR_BASE, productSoftwareSource: CI_REPORT_MIRROR_PRODUCT_SOURCE,
    productFingerprint: before.admission.productFingerprint, ciScopeSha256: before.admission.ciScopeSha256,
    sourceBefore: before, sourceAfter: after, sourceInputsUnchanged: after !== null && JSON.stringify(before) === JSON.stringify(after),
    limits: CI_REPORT_MIRROR_GATE_LIMITS, startedAtMs: Date.now() - (performance.now() - began),
    finishedAtMs: Date.now(), durationMs: performance.now() - began,
    originalTests: 173, safetyTests: CI_REPORT_MIRROR_SAFETY_CASE_NAMES.length,
    expectedToolTests: 173 + CI_REPORT_MIRROR_SAFETY_CASE_NAMES.length,
    currentToolGateExitCode: success ? 0 : 1, stages, failures, temporaryCleanup,
    historicalFetchByThisGate: false, historical186Replayed: false,
    productTestsOrBuildsRepeated: false, softwareEvidenceMode: 'SKIPPED_REUSED_S165',
    oldProductScopeCorrectionLocalUnchanged: true, productArtifactsCreated: 0,
    currentArtifactPolicy: 'ONE_ACTUAL_VERIFY_TOOL_RESULT_ZIP_ONLY',
    productionApp: 'NOT_RUN', realProviderDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' };
  writeJson(storage.outputRoot, 'summary.json', summary);
  return { outputRoot: storage.outputRoot, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { summary } = await runCiReportMirrorGate();
    process.stdout.write(JSON.stringify({ task: summary.task, status: summary.status, headAtRun: summary.headAtRun,
      currentToolGateExitCode: summary.currentToolGateExitCode, originalTests: summary.originalTests,
      safetyTests: summary.safetyTests, failures: summary.failures }) + '\n');
    if (!summary.success) process.exitCode = 1;
  } catch (error) {
    process.stderr.write('报告镜像工具 Gate 拒绝：' + closedCode(error) + '\n'); process.exitCode = 1;
  }
}
