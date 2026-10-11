import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMbm004Admission } from './mbm004-admission.mjs';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { prepareCoreTestEnvironment } from './run-core-tests.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const core = path.join(repository, 'packages/bridge-core'), desktop = path.join(repository, 'apps/desktop');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const limit = 480_000, stageLimit = 180_000, started = performance.now();
const remaining = () => limit - (performance.now() - started);
const check = () => { if (remaining() <= 0) throw new Error('004软件Gate总预算已耗尽。'); };

/** 本轮完整自然退出与whole原日志；超时只终止本stage自有进程组，不算quiet或成功。 */
async function capture(run, name, args, cwd, env, expectedTests = null) {
  check(); const began = Date.now(), chunks = []; let length = 0, timeout = false, overflow = false, cleanupFailed = false;
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cleanupFailed = true; } };
    const append = bytes => { if (length + bytes.length > 8 * 1024 * 1024) { overflow = true; stop(); return; }
      length += bytes.length; chunks.push(Buffer.from(bytes)); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { timeout = true; stop(); }, Math.max(1, Math.floor(Math.min(stageLimit, remaining()))));
    child.once('error', error => { clearTimeout(timer); resolve({ exitCode: null, signal: null, error: error.code ?? 'SPAWN_FAILED' }); });
    child.once('close', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, error: null }); });
  });
  const raw = Buffer.concat(chunks), rawFile = `${name}.log`, counts = expectedTests === null ? null : parseTestCounts(raw.toString('utf8'));
  writeFileSync(path.join(run, rawFile), raw, { flag: 'wx', mode: 0o600 });
  const passed = result.exitCode === 0 && result.signal === null && result.error === null && !timeout && !overflow && !cleanupFailed
    && (expectedTests === null || isCompleteTestRun(counts, expectedTests));
  const receipt = { name, startedAtMs: began, finishedAtMs: Date.now(), ...result, timeout, overflow, cleanupFailed,
    expectedTests, counts, raw: { path: rawFile, bytes: raw.length, sha256: sha(raw) }, passed };
  writePrivateJson(run, `${name}.json`, receipt);
  console.log(JSON.stringify({ stage: name, passed, exitCode: result.exitCode, counts }));
  if (!passed) throw new Error(`004阶段${name}未自然通过；保留完整原日志。`);
  check(); return receipt;
}
export async function verifyMbm004Content(argv = process.argv.slice(2), env = process.env) {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('004Gate只接受Node22。');
  const source = inspectMbm004Admission(repository, env), admission = validateOfflineArguments(argv, env), run = createPrivateRun(admission);
  writePrivateJson(run, 'source-admission.json', source);
  const stages = [];
  try {
    const prepared = await prepareCoreTestEnvironment({ env, clock: { check, timeout: () => { check(); return Math.max(1, Math.floor(Math.min(stageLimit, remaining()))); } } });
    prepared.assertCurrent();
    writePrivateJson(run, 'fresh-reader.json', { privateRoot: prepared.privateRoot, receipt: prepared.receipt });
    const require = createRequire(path.join(core, 'package.json')), tsc = require.resolve('typescript/bin/tsc');
    const desktopRequire = createRequire(path.join(desktop, 'package.json'));
    const runStage = async (...args) => { prepared.assertCurrent(); const row = await capture(run, ...args, prepared.env); prepared.assertCurrent(); stages.push(row); };
    await runStage('core-composition-types', [tsc, '-p', 'tsconfig.test.json'], core);
    await runStage('main-renderer-types', [desktopRequire.resolve('vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', 'tsconfig.json'], desktop);
    await runStage('existing-e2e-types', [tsc, '--noEmit', '-p', 'tsconfig.e2e.json'], desktop);
    // 这些新目录不会由原flat test/*.test.ts自动覆盖，必须在004Gate明确逐文件执行。
    const coreNames = readdirSync(path.join(core, 'test/mbm004')).filter(name => name.endsWith('.test.ts')).sort();
    if (coreNames.length !== 17) throw new Error('004Core文件集合不完整。');
    prepared.assertCurrent(); stages.push(await capture(run, 'core-content-behavior', ['--import', 'tsx', '--test', '--test-reporter=tap',
      '--test-concurrency=1', ...coreNames.map(name => `test/mbm004/${name}`), 'test/mbm002/playback-service.test.ts'], core, prepared.env, 164)); prepared.assertCurrent();
    stages.push(await capture(run, 'main-content-https', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
      'test/mobile-content-backend.test.ts', 'test/mobile-content-rpc-main.test.ts', 'test/mobile-content-https.test.ts',
      'test/local-playback-main-timeout.test.ts', 'test/local-playback-recovery.test.ts'], desktop, prepared.env, 79)); prepared.assertCurrent();
    stages.push(await capture(run, 'receipt-diagnostics-contracts', ['--import', 'tsx', '--test', '--test-reporter=tap',
      'test/mbf001-recovery-diagnostics.test.ts'], path.join(repository, 'packages/contracts'), prepared.env, 6)); prepared.assertCurrent();
    stages.push(await capture(run, 'fixed-worker-wave-format', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
      'test/local-library-wave-extensible.test.ts', 'test/local-library-wave-empty-list.test.ts',
      'test/mbrs003/persistent-scan-owner.test.ts', 'test/mbrs004/name-rules-scan-integration.test.ts',
      'test/mbrs005/config-integration.test.ts'], core, prepared.env, 62)); prepared.assertCurrent();
    stages.push(await capture(run, 'admission-negative-cases', ['--test', '--test-reporter=tap', 'scripts/ci/test/mbm004-admission.test.mjs',
      'scripts/ci/test/mbm004-report-only.test.mjs', 'scripts/ci/test/task-applicability.test.mjs'], repository, prepared.env, 22));
    prepared.assertCurrent(); const final = inspectMbm004Admission(repository, env);
    if (JSON.stringify(source) !== JSON.stringify(final)) throw new Error('004源码准入身份漂移。');
    const receipt = { schema: 'musicbridge.mbm004.software-gate.v1', status: 'PASSED', source, stages,
      freshReader: { inputs: prepared.receipt.sourceInputs.length, outputs: prepared.receipt.outputs.length,
        compilerStages: prepared.receipt.stages, bindingSha256: prepared.receipt.readerBindingSha256 },
      canonicalUnchanged: true, oldGateReplay: false, softwareOnly: true, productionApp: 'NOT_RUN', realProviderDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' };
    writePrivateJson(run, 'result.json', receipt); console.log(JSON.stringify({ task: 'MBM-004', status: 'PASSED', source: source.headAtAdmission, run }));
    return receipt;
  } catch (error) {
    writePrivateJson(run, 'failure.json', { schema: 'musicbridge.mbm004.software-gate.v1', status: 'FAILED', source, stages,
      reason: error instanceof Error ? error.message : '004软件Gate未完成。', softwareOnly: true }); throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyMbm004Content().catch(error => { console.error(error.message); process.exitCode = 1; });
}
