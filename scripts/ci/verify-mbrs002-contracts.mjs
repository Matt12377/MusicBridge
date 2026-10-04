import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const base = 'f34dd904a473893f213a2a894b858c4ddfbf4423';
// 本地合同冻结执行清单：16个测试文件、67项；新增测试必须登记并真实执行。
const groups = [
  { name: 'contracts-local-behavior', directory: 'packages/contracts', expectedTests: 16,
    tests: ['test/mbrs002/local-catalog.test.ts', 'test/mbrs002/local-domain-references.test.ts',
      'test/mbrs002/local-play-request.test.ts', 'test/mbrs002/local-playback-compat.test.ts'] },
  { name: 'core-local-behavior', directory: 'packages/bridge-core', expectedTests: 41,
    tests: ['test/mbrs002/local-catalog-migration.test.ts', 'test/mbrs002/local-catalog-nonempty-migration.test.ts',
      'test/mbrs002/local-catalog-store.test.ts', 'test/mbrs002/local-catalog-restore.test.ts',
      'test/mbrs002/local-catalog-capacity.test.ts', 'test/mbrs002/local-catalog-read-budget.test.ts',
      'test/mbrs002/local-catalog-owner.test.ts', 'test/mbrs002/local-source-owner.test.ts', 'test/mbrs002/local-source-resolver.test.ts'] },
  { name: 'desktop-local-compat', directory: 'apps/desktop', expectedTests: 10,
    tests: ['test/mbrs002/local-catalog-outbox.test.ts', 'test/mbrs002/local-catalog-supervisor.test.ts',
      'test/mbrs002/local-playback-compat.test.ts'] },
];
const now = () => new Date().toISOString();
const TOTAL_BUDGET_MS = 360_000;
const STAGE_LIMIT_MS = 180_000;
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
function createBudget() {
  const startedMs = Date.now(), startedAt = now(), startedMonotonicMs = monotonicMs();
  let exhaustedPhase = null;
  const remainingMs = () => Math.max(0, TOTAL_BUDGET_MS - (monotonicMs() - startedMonotonicMs));
  const check = phase => {
    if (remainingMs() <= 0) {
      exhaustedPhase ??= phase;
      const error = new Error('整个Gate有限预算已耗尽。');
      error.code = 'GATE_TOTAL_BUDGET_EXHAUSTED';
      throw error;
    }
  };
  return { startedMs, startedAt, remainingMs, check,
    snapshot: () => {
      const elapsedMs = monotonicMs() - startedMonotonicMs;
      return { totalLimitMs: TOTAL_BUDGET_MS, startedMs, deadlineMs: startedMs + TOTAL_BUDGET_MS,
        elapsedMs, remainingMs: Math.max(0, TOTAL_BUDGET_MS - elapsedMs), exhausted: elapsedMs >= TOTAL_BUDGET_MS,
        exhaustedPhase, clock: 'MONOTONIC_HRTIME_MS',
        scope: 'ADMISSION_EXECUTION_AND_FINAL_IDENTITY_CHECKS',
        recoveryAfterDeadline: 'NO_NEW_STAGE_OR_IDENTITY_SCAN_OWNED_GROUP_CLOSE_AND_BEST_EFFORT_PRIVATE_SEAL_ONLY',
        recommendedWorkflowStepTimeoutMinutes: 8 };
    } };
}
function budgetedGit(args, budget, phase) {
  budget.check(phase);
  try {
    const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1, budget.remainingMs()), killSignal: 'SIGKILL' });
    budget.check(phase);
    return value;
  } catch (error) {
    // Git自身异常只在公开收据留下有限阶段code；预算耗尽单独记录。
    budget.check(phase);
    throw error;
  }
}
const head = budget => budgetedGit(['rev-parse', 'HEAD'], budget, 'HEAD_IDENTITY').trim();
function sourceIdentity(budget) {
  const prefixes = ['packages/contracts/src', 'packages/bridge-core/src', 'apps/desktop/src', 'packages/contracts/test', 'packages/bridge-core/test', 'apps/desktop/test'];
  const trackedOrControlledNew = budgetedGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...prefixes],
    budget, 'SOURCE_INVENTORY').split('\0').filter(Boolean);
  const names = [...new Set([...trackedOrControlledNew, 'scripts/ci/verify-mbrs002-contracts.mjs', 'scripts/ci/verify-mbrs001-offline.mjs',
    '.github/workflows/verify.yml', '.github/workflows/electron-e2e.yml', 'apps/desktop/scripts/build-storage-root.mjs', 'apps/desktop/scripts/build-storage-root.d.mts',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'packages/contracts/package.json', 'packages/contracts/tsconfig.json', 'packages/contracts/tsconfig.test.json',
    'packages/bridge-core/package.json', 'packages/bridge-core/tsconfig.json', 'packages/bridge-core/tsconfig.test.json',
    'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.e2e.json'])].sort();
  return names.map(relative => {
    budget.check('SOURCE_HASH');
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('声明源码路径越界。');
    const bytes = readFileSync(path.join(repository, relative));
    const result = { path: relative, bytes: bytes.length, sha256: sha(bytes) };
    budget.check('SOURCE_HASH');
    return result;
  });
}
/** 每个适用嵌套测试均须出现在冻结组中；哈希新文件不能代替执行。 */
function assertFrozenTestInventory(sources) {
  for (const group of groups) {
    const prefix = `${group.directory}/test/mbrs002/`;
    const expected = group.tests.map(test => `${group.directory}/${test}`).sort();
    const actual = sources.map(source => source.path).filter(name => name.startsWith(prefix) && name.endsWith('.test.ts')).sort();
    if (new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('新增嵌套测试与已冻结执行名单不一致。');
  }
}
function contractsOutputs(sources, stageStartedMs, budget) {
  const root = path.join(repository, 'packages/contracts');
  const names = sources.filter(item => item.path.startsWith('packages/contracts/src/') && item.path.endsWith('.ts') && !item.path.endsWith('.d.ts'));
  if (!names.length) throw new Error('没有可编译合同来源。');
  const rows = [];
  for (const source of names) {
    const relative = source.path.slice('packages/contracts/src/'.length, -3);
    for (const suffix of ['.js', '.d.ts', '.js.map']) {
      budget.check('FRESH_CONTRACTS_OUTPUT_HASH');
      const name = `dist/${relative}${suffix}`;
      const bytes = readFileSync(path.join(root, name));
      rows.push({ path: `packages/contracts/${name}`, bytes: bytes.length, sha256: sha(bytes), sourcePath: source.path, sourceSha256: source.sha256 });
      budget.check('FRESH_CONTRACTS_OUTPUT_HASH');
    }
  }
  if (!rows.some(item => item.path === 'packages/contracts/dist/index.js') || !rows.some(item => item.path === 'packages/contracts/dist/index.d.ts')) throw new Error('实际合同出口缺失。');
  // 新编译命令与输出摘要共同绑定；不由已有dist的存在推导新编译。
  return { freshlyExecutedBuildStartedMs: stageStartedMs, compilerSourceCount: names.length, compilerOutputCount: rows.length, outputs: rows };
}
function outputsUnchanged(outputs, budget) {
  return outputs.every(item => {
    budget.check('FINAL_CONTRACTS_OUTPUT_HASH');
    const bytes = readFileSync(path.join(repository, item.path));
    const equal = bytes.length === item.bytes && sha(bytes) === item.sha256;
    budget.check('FINAL_CONTRACTS_OUTPUT_HASH');
    return equal;
  });
}
async function capture(run, stage, env, budget, runs) {
  budget.check('STAGE_ADMISSION');
  const startedAt = now(), startedMs = Date.now(), startedMonotonicMs = monotonicMs();
  const remainingAtStartMs = budget.remainingMs(), effectiveTimeoutMs = Math.min(STAGE_LIMIT_MS, remainingAtStartMs);
  const expectedTests = stage.expectedTests ?? null;
  // 先登记阶段；日志保存异常不能把已经完成的子进程捕获从最终收据抹掉。
  const result = { name: stage.name, argv: ['node', ...(stage.display ?? stage.args)], startedAt, startedMs,
    completedAt: null, durationMs: null, captureCompletedAt: null, exitCode: null, signal: null,
    overflow: false, timedOut: false, stageTimedOut: false, gateBudgetTimedOut: false, timeoutKind: null,
    preparationFailed: false, captureFailed: false, groupTerminationFailed: false, closeObserved: false,
    ownedProcessGroupId: null, processIsolation: 'OWNED_POSIX_PROCESS_GROUP',
    stageLimitMs: STAGE_LIMIT_MS, effectiveTimeoutMs, gateRemainingAtStartMs: remainingAtStartMs,
    gateRemainingAtCloseMs: null, gateRemainingAtCompletedMs: null, expectedTests, testCounts: null, testSummaryValid: null,
    log: `${stage.name}.log`, logWritten: false, logWriteFailed: false, logFailureCode: null,
    logSha256: null, sanitizedCaptureSha256: null, redactedLogRecovery: null,
    capturedRawSha256: null, rawDiagnosticBytes: 0,
    diagnosticsPolicy: 'ALLOWLIST_STATUS_COUNTS_ONLY', rawCaptureScope: 'BOUNDED_STDOUT_STDERR_OBSERVED_ARRIVAL_BYTES' };
  runs.push(result);
  const captured = await new Promise(resolve => {
    const chunks = []; let length = 0, overflow = false, timedOut = false, stageTimedOut = false, gateBudgetTimedOut = false;
    let preparationFailed = false, captureFailed = false, groupTerminationFailed = false, child = null, timer = null, terminated = false;
    const terminateOwned = () => {
      if (terminated || child?.pid === undefined) return;
      terminated = true;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') groupTerminationFailed = true; }
    };
    const finish = (exitCode, signal, closeObserved) => {
      if (timer !== null) clearTimeout(timer);
      let raw = null;
      try { raw = Buffer.concat(chunks, length); } catch { captureFailed = true; }
      resolve({ raw, observedBytes: length, exitCode, signal, closeObserved, overflow, timedOut, stageTimedOut,
        gateBudgetTimedOut, preparationFailed, captureFailed, groupTerminationFailed,
        ownedProcessGroupId: child?.pid ?? null });
    };
    const append = bytes => {
      if (overflow || captureFailed) return;
      try {
        if (length + bytes.length > 4 * 1024 * 1024) { overflow = true; terminateOwned(); return; }
        chunks.push(Buffer.from(bytes)); length += bytes.length;
      } catch { captureFailed = true; terminateOwned(); }
    };
    try {
      budget.check('STAGE_SPAWN');
      child = spawn(process.execPath, stage.args, { cwd: path.join(repository, stage.directory), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      preparationFailed = true;
      if (error?.code === 'GATE_TOTAL_BUDGET_EXHAUSTED') { timedOut = true; gateBudgetTimedOut = true; }
      finish(null, null, false);
      return;
    }
    // 所有终止分支都等实际close；不以发出kill或exit替代管道和子进程close证据。
    child.once('close', (exitCode, signal) => finish(exitCode, signal, true));
    child.once('error', () => { preparationFailed = true; terminateOwned(); });
    try {
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.stdout.on('error', () => { captureFailed = true; terminateOwned(); });
      child.stderr.on('error', () => { captureFailed = true; terminateOwned(); });
      const expire = () => {
        timedOut = true;
        stageTimedOut = monotonicMs() - startedMonotonicMs >= STAGE_LIMIT_MS;
        gateBudgetTimedOut = budget.remainingMs() <= 0;
        // 计时器提前误差也按原先选择的有限上限失败，不会延长预算或重发阶段。
        if (!stageTimedOut && !gateBudgetTimedOut) {
          if (remainingAtStartMs <= STAGE_LIMIT_MS) gateBudgetTimedOut = true;
          else stageTimedOut = true;
        }
        terminateOwned();
      };
      const delay = Math.min(STAGE_LIMIT_MS - (monotonicMs() - startedMonotonicMs), budget.remainingMs());
      if (delay <= 0) expire();
      else timer = setTimeout(expire, delay);
    } catch { captureFailed = true; terminateOwned(); }
  });
  Object.assign(result, { captureCompletedAt: now(), exitCode: captured.exitCode, signal: captured.signal,
    overflow: captured.overflow, timedOut: captured.timedOut, stageTimedOut: captured.stageTimedOut,
    gateBudgetTimedOut: captured.gateBudgetTimedOut, preparationFailed: captured.preparationFailed,
    captureFailed: captured.captureFailed, groupTerminationFailed: captured.groupTerminationFailed,
    closeObserved: captured.closeObserved, ownedProcessGroupId: captured.ownedProcessGroupId,
    timeoutKind: captured.gateBudgetTimedOut ? 'GATE_TOTAL_BUDGET_EXHAUSTED' : captured.stageTimedOut ? 'STAGE_TIME_LIMIT_EXCEEDED' : null,
    gateRemainingAtCloseMs: budget.remainingMs(), rawDiagnosticBytes: captured.observedBytes });
  try {
    if (captured.raw === null) throw new Error('捕获聚合未完成。');
    result.capturedRawSha256 = sha(captured.raw);
    const decoded = captured.raw.toString('utf8');
    result.testCounts = parseTestCounts(decoded);
    result.testSummaryValid = expectedTests === null ? null : isCompleteTestRun(result.testCounts, expectedTests);
    const safe = sanitizeOutput(decoded);
    result.sanitizedCaptureSha256 = sha(safe);
    try {
      writeFileSync(path.join(run, result.log), safe, { flag: 'wx', mode: 0o600 });
      result.logWritten = true; result.logSha256 = result.sanitizedCaptureSha256;
    } catch {
      result.logWriteFailed = true; result.logFailureCode = 'PRIVATE_LOG_WRITE_FAILED';
      // 只保存同一allowlist后的文本；manifest可写时恢复完整脱敏捕获，不保存原始错误或路径。
      result.redactedLogRecovery = safe;
    }
  } catch {
    result.captureFailed = true;
    result.logFailureCode ??= 'CAPTURE_POSTPROCESS_FAILED';
  }
  result.completedAt = now(); result.durationMs = monotonicMs() - startedMonotonicMs;
  result.gateRemainingAtCompletedMs = budget.remainingMs();
  return result;
}
// 真实执行/capture成功与日志交付分开；故障日志不能抹掉真实fresh编译输出身份。
const stageExecutionCaptured = item => item.exitCode === 0 && item.signal === null && item.closeObserved
  && !item.overflow && !item.timedOut && !item.preparationFailed && !item.captureFailed && !item.groupTerminationFailed;
const stagePassed = item => stageExecutionCaptured(item) && item.logWritten && !item.logWriteFailed
  && (item.expectedTests === null || isCompleteTestRun(item.testCounts, item.expectedTests));

export async function runLocalContractGate(argv = process.argv.slice(2), env = process.env) {
  // 从准入之前开始计时，准备和最终核对共享同一个单调时钟预算。
  const budget = createBudget();
  budget.check('STORAGE_ADMISSION');
  const admission = validateOfflineArguments(argv, env);
  budget.check('STORAGE_ADMISSION');
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('本地合同Gate要求Node22。');
  if (groups.some(group => !Number.isSafeInteger(group.expectedTests) || group.expectedTests <= 0 || !group.tests.length)) throw new Error('最终新增测试数量尚未冻结。');
  budgetedGit(['merge-base', '--is-ancestor', base, 'HEAD'], budget, 'BASE_ANCESTRY');
  const require = createRequire(path.join(repository, 'packages/bridge-core/package.json'));
  budget.check('COMPILER_RESOLUTION');
  const tsc = require.resolve('typescript/bin/tsc'); require.resolve('tsx');
  const desktopRequire = createRequire(path.join(repository, 'apps/desktop/package.json'));
  const vueTsc = desktopRequire.resolve('vue-tsc/bin/vue-tsc.js');
  budget.check('COMPILER_RESOLUTION');
  const gitHead = head(budget), sources = sourceIdentity(budget);
  assertFrozenTestInventory(sources);
  for (const group of groups) for (const test of group.tests) {
    budget.check('FROZEN_TEST_READ');
    readFileSync(path.join(repository, group.directory, test));
    budget.check('FROZEN_TEST_READ');
  }
  const stages = [
    { name: 'fresh-contracts-build', directory: 'packages/contracts', args: [tsc, '-p', 'tsconfig.json'], display: ['typescript/bin/tsc', '-p', 'tsconfig.json'] },
    { name: 'contracts-noemit', directory: 'packages/contracts', args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'], display: ['typescript/bin/tsc', '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'core-noemit', directory: 'packages/bridge-core', args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'], display: ['typescript/bin/tsc', '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: 'desktop-noemit', directory: 'apps/desktop', args: [vueTsc, '-p', 'tsconfig.json', '--noEmit'], display: ['vue-tsc/bin/vue-tsc.js', '-p', 'tsconfig.json', '--noEmit'] },
    ...groups.map(group => ({ ...group, args: ['--import', 'tsx', '--test', '--test-reporter=tap', ...group.tests] })),
  ];
  const runs = [], failures = [];
  let freshContracts = null, sourceInputsUnchanged = false, contractsOutputsUnchanged = false;
  let sourceVerification = 'NOT_STARTED', outputVerification = 'NOT_STARTED', phase = 'PRIVATE_RUN_CREATION';
  const fail = (code, failurePhase) => {
    if (!failures.some(item => item.code === code && item.phase === failurePhase)) failures.push({ code, phase: failurePhase });
  };
  const failCaught = (error, fallback, failurePhase) => fail(error?.code === 'GATE_TOTAL_BUDGET_EXHAUSTED' ? 'GATE_TOTAL_BUDGET_EXHAUSTED' : fallback, failurePhase);
  budget.check(phase);
  const run = createPrivateRun(admission);
  // createPrivateRun返回以后立即覆盖整个生命周期，含tmp创建和所有执行/核对异常。
  try {
    phase = 'PRIVATE_TMP_PREPARATION'; budget.check(phase);
    const temporary = path.join(run, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
    budget.check(phase);
    const childEnv = { ...env, TMPDIR: temporary };
    for (const stage of stages) {
      phase = stage.name; budget.check(phase);
      const result = await capture(run, stage, childEnv, budget, runs);
      if (result.logWriteFailed) fail('PRIVATE_LOG_WRITE_FAILED', phase);
      if (result.gateBudgetTimedOut) fail('GATE_TOTAL_BUDGET_EXHAUSTED', phase);
      if (result.stageTimedOut) fail('STAGE_TIME_LIMIT_EXCEEDED', phase);
      if (result.groupTerminationFailed) fail('OWNED_GROUP_TERMINATION_FAILED', phase);
      // 只要fresh编译实际完成且capture可信，就先绑定它的输出；日志失败仍不能准入。
      if (stage.name === 'fresh-contracts-build' && stageExecutionCaptured(result)) {
        phase = 'FRESH_CONTRACTS_OUTPUT_HASH';
        freshContracts = contractsOutputs(sources, result.startedMs, budget);
        phase = stage.name;
      }
      if (!stagePassed(result)) { fail('STAGE_FAILED_OR_INCOMPLETE', phase); break; }
      budget.check(phase);
    }
  } catch (error) {
    failCaught(error, phase === 'FRESH_CONTRACTS_OUTPUT_HASH' ? 'FRESH_CONTRACTS_OUTPUTS_INVALID' : 'EXECUTION_EXCEPTION', phase);
  } finally {
    // 预算耗尽时不开始新的扫描；close已由capture等待，随后只尽力封私有失败收据。
    phase = 'FINAL_SOURCE_IDENTITY';
    try {
      budget.check(phase); sourceVerification = 'STARTED';
      sourceInputsUnchanged = head(budget) === gitHead && JSON.stringify(sourceIdentity(budget)) === JSON.stringify(sources);
      budget.check(phase); sourceVerification = 'COMPLETE';
      if (!sourceInputsUnchanged) fail('DECLARED_SOURCE_OR_HEAD_DRIFT', phase);
    } catch (error) {
      sourceVerification = error?.code === 'GATE_TOTAL_BUDGET_EXHAUSTED' ? 'INCOMPLETE_OR_SKIPPED_BUDGET_EXHAUSTED' : 'VERIFICATION_EXCEPTION';
      failCaught(error, 'SOURCE_IDENTITY_VERIFICATION_EXCEPTION', phase);
    }
    phase = 'FINAL_CONTRACTS_OUTPUT_IDENTITY';
    try {
      budget.check(phase);
      if (freshContracts === null) { outputVerification = 'NO_SUCCESSFUL_FRESH_OUTPUT_RECEIPT'; fail('FRESH_CONTRACTS_OUTPUTS_UNAVAILABLE', phase); }
      else {
        outputVerification = 'STARTED';
        contractsOutputsUnchanged = outputsUnchanged(freshContracts.outputs, budget);
        budget.check(phase); outputVerification = 'COMPLETE';
        if (!contractsOutputsUnchanged) fail('CONSUMED_CONTRACTS_OUTPUT_DRIFT', phase);
      }
    } catch (error) {
      outputVerification = error?.code === 'GATE_TOTAL_BUDGET_EXHAUSTED' ? 'INCOMPLETE_OR_SKIPPED_BUDGET_EXHAUSTED' : 'VERIFICATION_EXCEPTION';
      failCaught(error, 'CONTRACTS_OUTPUT_VERIFICATION_EXCEPTION', phase);
    }
    try { budget.check('FINAL_SUCCESS_DECISION'); }
    catch (error) { failCaught(error, 'FINAL_SUCCESS_DECISION_EXCEPTION', 'FINAL_SUCCESS_DECISION'); }
    if (runs.length !== stages.length) fail('STAGES_INCOMPLETE', 'FINAL_SUCCESS_DECISION');
    const budgetAtFinalDecision = budget.snapshot();
    const success = failures.length === 0 && !budgetAtFinalDecision.exhausted && runs.length === stages.length
      && runs.every(stagePassed) && sourceInputsUnchanged && contractsOutputsUnchanged;
    try {
      writePrivateJson(run, 'manifest.json', { schema: 'mbrs002.local-contract-gate.v1',
        startedAt: budget.startedAt, completedAt: now(), success, failureReason: failures[0]?.code ?? null, failures,
        baseSha: base, gitHead, sourceInputs: sources, sourceInputsUnchanged, sourceVerification,
        freshContracts, contractsOutputsUnchanged, outputVerification, runs, declaredStageCount: stages.length,
        gateBudget: budgetAtFinalDecision,
        failureReceiptPolicy: 'BEST_EFFORT_PRIVATE_WX_MANIFEST_WITH_COMPLETED_STAGE_CAPTURE',
        recoveryScope: 'OWNED_GROUP_CLOSE_AND_PRIVATE_SEAL_MAY_FINISH_AFTER_WORK_BUDGET_WITHIN_WORKFLOW_HEADROOM',
        manifestStorageBoundary: 'UNWRITABLE_OR_BLOCKED_STORAGE_CANNOT_GUARANTEE_A_RECEIPT_FILE',
        evidenceScope: 'SYNTHETIC_CONTRACT_STORAGE_AND_LEGACY_COMPATIBILITY_SOFTWARE_ONLY',
        identityScope: 'PINNED_HEAD_WITH_DECLARED_BASE_AND_CONTROLLED_NEW_INPUTS_NOT_TRANSITIVE_DEPENDENCY_CLOSURE',
        sourceFilesWrite: 'OFF', realLibraryRoonAccounts: 'NOT_RUN', ownerAcceptance: 'NOT_RUN',
        actualLocalControllerQueueGatewayIntegration: 'SEPARATE_MBRS_003_005_006_007_OWNERS_REMAIN' });
    } catch {
      // 不回写或覆盖任何已有manifest；存储本身失败时仍exit1，明确没有可保证的磁盘收据。
      console.error('MBRS002私有manifest写入失败；已关闭的阶段捕获未能完整落盘，Gate拒绝准入。');
      return 1;
    }
    return success ? 0 : 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLocalContractGate().then(code => { process.exitCode = code; }).catch(() => {
    console.error('MBRS002合同Gate失败；私有run创建前未完成准备，或进程异常退出，详细值未公开。'); process.exitCode = 1;
  });
}
