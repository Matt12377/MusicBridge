import { lstatSync, realpathSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMbm003ContractGate } from './mbm003-contract-gate.mjs';
import { prepareCoreTestEnvironment, coreTestSourceInputs } from './run-core-tests.mjs';
import { makeReaderBundleBinding } from './verify-mbrs003-scan.mjs';
import { readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, isCompleteTestRun } from './verify-mbrs001-offline.mjs';
import { captureMobileStage, mobileStageSucceeded, mobileTapResult, readMobileFile, mobileInputIdentity } from './verify-mbm000-contract-adoption.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = fileURLToPath(import.meta.url);
const predecessor = 'b1a8de728086e7994bb69d7dee10782f646886dd';
const canonical = { path: 'packages/contracts/mobile/openapi.json', bytes: 147445,
  sha256: '3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21' };
const nativeManifestSha256 = '233ff1404886db6183bc159fdc81e2d191cec9ddb6f43788f0a9228a13d1f6c7';
export const MBM003_SOFTWARE_BUDGETS = Object.freeze({ totalTimeoutMs: 480000, stageTimeoutMs: 180000,
  preparationTimeoutMs: 360000, killGraceMs: 10000, rawOutputBytes: 16777216,
  sourceFileBytes: 16777216, maxSourceFiles: 8192 });

const contractLeaves = [
  ['packages/contracts/test/mbm003/processing-negotiation.test.ts', 9],
  ['packages/contracts/test/mbm003/dsd-resource-state.test.ts', 9],
  ['packages/contracts/test/mbm003/resource-continuity-lossless.test.ts', 9],
];
const softwareLeaves = [
  ['packages/bridge-core/test/mbm003/dsd-container-facts.test.ts', 7],
  ['packages/bridge-core/test/mbm003/metadata-reader-dsd.test.ts', 3],
  ['packages/bridge-core/test/mbm003/dff-metadata-pad.test.ts', 2],
  ['packages/bridge-core/test/mbm003/playback-dsd.test.ts', 6],
  ['apps/desktop/test/mbm003/mobile-dsd-bootstrap.test.ts', 5],
  ['apps/desktop/test/mbm003/mobile-dsd-main.test.ts', 8],
  ['apps/desktop/test/mbm003/mobile-dsd-https.test.ts', 7],
];
const nativeLeaves = [
  ['packages/bridge-core/test/mbm003/converter.test.ts', 3],
  ['packages/bridge-core/test/mbm003/cache.test.ts', 7],
  ['packages/bridge-core/test/mbm003/source-dsd.integration.test.ts', 3],
  ['packages/bridge-core/test/mbm003/owned-domain-dsd.test.ts', 1],
  ['packages/bridge-core/test/mbm003/converter-boundary.test.ts', 1],
];
const compilerNames = ['fresh-contracts-compiler', 'fresh-core-compiler', 'fresh-fixed-metadata-worker'];
const sha = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (file, directory) => file.startsWith(directory + path.sep);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code) { const error = new Error('MBM003 软件Gate拒绝。'); error.code = code; throw error; }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function uniqueSet(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && new Set(a).size === a.length
    && equal([...a].sort(), [...b].sort());
}
function safeRelative(file) {
  return typeof file === 'string' && file.length > 0 && !path.isAbsolute(file) && !file.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
}
function parsed(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('MBM003_INPUT_JSON_INVALID'); }
}
function clock() {
  const startedMs = Date.now(), began = performance.now(), elapsedMs = () => performance.now() - began;
  const remaining = () => MBM003_SOFTWARE_BUDGETS.totalTimeoutMs - elapsedMs();
  return { startedMs, elapsedMs, remaining, check() { if (remaining() <= 0) fail('MBM003_TOTAL_BUDGET_EXHAUSTED'); } };
}
async function whole(file, check, allowEmpty = false) {
  return readMobileFile(file, { maxBytes: MBM003_SOFTWARE_BUDGETS.sourceFileBytes, check, allowEmpty });
}
async function descriptor(file, check, allowEmpty = false) { return (await whole(file, check, allowEmpty)).identity; }
async function sourceRows(check) {
  const names = new Set(coreTestSourceInputs(check).map(row => row.path));
  function walk(relative) {
    check(); const info = lstatSync(path.join(repository, relative));
    if (info.isSymbolicLink()) fail('MBM003_SOURCE_SYMLINK');
    if (info.isDirectory()) for (const name of readdirSync(path.join(repository, relative)).sort()) walk(relative + '/' + name);
    else if (info.isFile()) names.add(relative); else fail('MBM003_SOURCE_KIND');
    if (names.size > MBM003_SOFTWARE_BUDGETS.maxSourceFiles) fail('MBM003_SOURCE_COUNT_EXCEEDED');
  }
  for (const directory of ['scripts/ci', '.github/workflows', 'docs/postrust/MBM-003']) walk(directory);
  for (const file of ['AGENTS.md', 'pnpm-lock.yaml', 'apps/desktop/tsconfig.e2e.json', 'apps/desktop/electron.vite.config.ts',
    'apps/desktop/scripts/build-storage-root.mjs', 'packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs',
    canonical.path, ...['STATUS.json', 'POSTRUST_PLAN.json', 'POSTRUST_TODO.md', 'POSTRUST_PROGRESS.md'].map(n => 'project/' + n)]) names.add(file);
  if (names.size > MBM003_SOFTWARE_BUDGETS.maxSourceFiles) fail('MBM003_SOURCE_COUNT_EXCEEDED');
  const rows = [];
  for (const relative of [...names].sort()) {
    if (!safeRelative(relative)) fail('MBM003_SOURCE_PATH');
    const item = await whole(path.join(repository, relative), check, true);
    rows.push({ path: relative, bytes: item.identity.bytes, sha256: item.identity.sha256 });
  }
  return rows;
}
function readHead(check, remaining) {
  check(); const result = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4096 }).trim();
  check(); if (!/^[a-f0-9]{40}$/u.test(result)) fail('MBM003_HEAD_INVALID'); return result;
}

/** 名称来自本轮完整测试源码；动态Worker两例只接受既定dsf/dff闭集。 */
async function leafCases(relative, expected, check) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode((await whole(path.join(repository, relative), check)).bytes);
  let names = [...text.matchAll(/^\s*test\(\s*'([^'\\\r\n]+)'/gmu)].map(match => match[1]);
  if (relative === 'packages/bridge-core/test/mbm003/metadata-reader-dsd.test.ts') {
    if (!text.includes("for (const ext of ['dsf','dff']) test(`MBM003真实Worker ${ext}：可信资格开启后捕获真实1-bit clock与FD静止`")) fail('MBM003_WORKER_CASE_LOOP_CHANGED');
    names = ['MBM003真实Worker dsf：可信资格开启后捕获真实1-bit clock与FD静止',
      'MBM003真实Worker dff：可信资格开启后捕获真实1-bit clock与FD静止', ...names];
  }
  if (names.length !== expected || new Set(names).size !== expected
    || names.some(name => !name || Buffer.byteLength(name) > 4096 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(name))) fail('MBM003_TEST_SCOPE_NOT_FROZEN');
  return { file: relative, expectedTests: expected, caseNames: names };
}
async function capture(stage, context, stageTimeoutMs = MBM003_SOFTWARE_BUDGETS.stageTimeoutMs) {
  context.check();
  const result = await captureMobileStage(stage, { run: context.run, temporary: context.temporary, env: context.env,
    budgets: { ...MBM003_SOFTWARE_BUDGETS, stageTimeoutMs }, remaining: context.remaining,
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, cwd: path.join(repository, stage.directory) }) });
  result.directory = stage.directory; context.runs.push(result);
  if (!mobileStageSucceeded(result) || result.exitObserved !== true || result.rawCaptureComplete !== true) fail('MBM003_STAGE_FAILED_OR_INCOMPLETE');
  context.check(); return result;
}

/** 合同slice保留自己的编译区间；后续Core准备重编译Contracts时，不冒称旧mtime仍当前。 */
async function contractLayer(directory, check, storage, sourceInputs) {
  const resultFile = path.join(directory, 'result.json'), bindingFile = path.join(directory, 'binding.json');
  storage.check(resultFile, { mustExist: true, kind: 'file' }); storage.check(bindingFile, { mustExist: true, kind: 'file' });
  const result = parsed((await whole(resultFile, check)).bytes), bindingBytes = (await whole(bindingFile, check)).bytes, binding = parsed(bindingBytes);
  const expectedNames = ['fresh-contracts-build', 'contracts-types', 'contracts-behavior'];
  if (result.schema !== 'musicbridge.mbm003.contract-gate.v1' || result.state !== 'CONTRACT_SOFTWARE_ONLY_PASS'
    || result.actualContractsConsumed !== true || result.topLevelCases !== 27 || !Array.isArray(result.stages)
    || !equal(result.stages.map(row => row.name), expectedNames) || result.stages.some(row => row.exitCode !== 0
      || row.signal !== null || row.closeObserved !== true || ['timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].some(k => row[k] !== false))) fail('MBM003_CONTRACT_LAYER_INCOMPLETE');
  if (binding.schema !== 'musicbridge.mbm003.fresh-contracts-binding.v1' || binding.root !== repository
    || binding.predecessor !== predecessor || !Array.isArray(binding.inputs) || !Array.isArray(binding.artifacts)
    || result.artifactIdentity !== binding.artifactIdentity || result.inputIdentity !== sha(Buffer.from(JSON.stringify(binding.inputs)))) fail('MBM003_CONTRACT_BINDING_INVALID');
  const contractInputNames = sourceInputs.filter(row => /^(?:packages\/contracts\/src\/|packages\/contracts\/test\/)/u.test(row.path)).map(row => row.path);
  contractInputNames.push('packages/contracts/package.json', 'packages/contracts/tsconfig.json', 'packages/contracts/tsconfig.test.json',
    canonical.path, 'docs/postrust/MBM-003/CONTRACT_SEMANTICS.md', 'docs/postrust/MBM-003/CONTRACT_FREEZE.json',
    'docs/postrust/MBM-003/READY_RENEW_BOUNDARY.json', 'pnpm-lock.yaml', 'scripts/ci/mbm003-contract-gate.mjs');
  if (!uniqueSet(binding.inputs.map(row => row.path), contractInputNames)
    || binding.inputs.some(row => !equal(row, sourceInputs.find(source => source.path === row.path)))) fail('MBM003_CONTRACT_SOURCE_CLOSURE_CHANGED');
  const compiler = result.stages[0], boundCompiler = Object.fromEntries(Object.entries(compiler).filter(([key]) => key !== 'name'));
  if (!equal(binding.compiler, boundCompiler) || !Number.isFinite(compiler.startedMs) || !Number.isFinite(compiler.closedMs)
    || compiler.startedMs <= 0 || compiler.closedMs < compiler.startedMs || compiler.closedMs > Date.now()
    || compiler.closedMs - compiler.startedMs > MBM003_SOFTWARE_BUDGETS.stageTimeoutMs) fail('MBM003_CONTRACT_COMPILER_WINDOW_INVALID');
  const outputSources = new Map(binding.inputs.filter(row => /^packages\/contracts\/src\/.*\.ts$/u.test(row.path)
    && !row.path.endsWith('.d.ts')).flatMap(row => ['.js', '.js.map', '.d.ts'].map(suffix => [row.path.replace('/src/', '/dist/').slice(0, -3) + suffix, row])));
  if (!uniqueSet(binding.artifacts.map(row => row.relativePath), [...outputSources.keys()])) fail('MBM003_CONTRACT_OUTPUT_CLOSURE_INCOMPLETE');
  const projection = binding.artifacts.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 }))
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  if (sha(Buffer.from(JSON.stringify(projection))) !== binding.artifactIdentity) fail('MBM003_CONTRACT_ARTIFACT_IDENTITY_CHANGED');
  const cases = (await Promise.all(contractLeaves.map(([file, count]) => leafCases(file, count, check)))).flatMap(row => row.caseNames);
  const logs = [];
  for (const name of expectedNames) logs.push(await descriptor(path.join(directory, name + '.log'), check, true));
  const behavior = new TextDecoder('utf-8', { fatal: true }).decode((await whole(path.join(directory, 'contracts-behavior.log'), check, true)).bytes);
  const tap = mobileTapResult(behavior, 27);
  if (!isCompleteTestRun(tap.testCounts, 27) || tap.tapPlanComplete !== true || tap.tapStatusesClean !== true
    || !uniqueSet(tap.actualCaseNames, cases)) fail('MBM003_CONTRACT_TAP_INCOMPLETE');
  const artifacts = [];
  for (const row of binding.artifacts) {
    const source = outputSources.get(row.relativePath);
    if (!safeRelative(row.relativePath) || !row.relativePath.startsWith('packages/contracts/dist/')
      || row.file !== path.join(repository, row.relativePath) || !positive(row.bytes) || !/^[a-f0-9]{64}$/u.test(row.sha256)
      || !source || row.sourcePath !== source.path || row.sourceSha256 !== source.sha256 || !Number.isFinite(row.mtimeMs)
      || row.mtimeMs < compiler.startedMs || row.mtimeMs > compiler.closedMs) fail('MBM003_CONTRACT_ARTIFACT_INVALID');
    const actual = await whole(row.file, check);
    if (actual.identity.bytes !== row.bytes || actual.identity.sha256 !== row.sha256 || actual.mtimeNs !== row.mtimeNs
      || actual.mtimeMs !== row.mtimeMs) fail('MBM003_CONTRACT_ARTIFACT_DRIFT');
    artifacts.push({ ...actual.identity, path: row.relativePath, mtimeNs: actual.mtimeNs });
  }
  if (!artifacts.length || new Set(artifacts.map(row => row.path)).size !== artifacts.length) fail('MBM003_CONTRACT_ARTIFACT_INVALID');
  const consumed = [];
  const consumedNames = contractLeaves.map(([file]) => path.basename(file) + '.json');
  if (!uniqueSet(readdirSync(path.join(directory, 'consumed')), consumedNames)) fail('MBM003_CONTRACT_CONSUMPTION_CLOSURE_CHANGED');
  const selected = projection.filter(row => /^packages\/contracts\/dist\/mobile-(?:common|catalog|resource|content|wire)\.(?:js|js\.map|d\.ts)$/u.test(row.relativePath));
  if (selected.length !== 15) fail('MBM003_CONTRACT_MOBILE_OUTPUT_CLOSURE_INCOMPLETE');
  for (const [file] of contractLeaves) {
    const consumedFile = path.join(directory, 'consumed', path.basename(file) + '.json'), actual = await whole(consumedFile, check), row = parsed(actual.bytes);
    if (!plain(row) || !uniqueSet(Object.keys(row), ['schema', 'testFile', 'head', 'bindingSha256', 'artifactIdentity', 'inputIdentity', 'artifacts', 'loadedModules'])
      || row.schema !== 'musicbridge.mbm003.contract-consumption.v1' || row.testFile !== file.slice('packages/contracts/'.length)
      || row.head !== binding.head || row.bindingSha256 !== sha(bindingBytes) || row.artifactIdentity !== binding.artifactIdentity
      || row.inputIdentity !== result.inputIdentity || !equal(row.artifacts, selected)
      || !uniqueSet(row.loadedModules, selected.filter(item => item.relativePath.endsWith('.js')).map(item => item.relativePath))) fail('MBM003_CONTRACT_CONSUMPTION_CHANGED');
    consumed.push(actual.identity);
  }
  return { schema: 'musicbridge.mbm003.actual-contract-layer.v1', result: await descriptor(resultFile, check),
    binding: await descriptor(bindingFile, check), head: binding.head, logs, consumptionReceipts: consumed,
    testCounts: tap.testCounts, actualCaseNames: tap.actualCaseNames, artifactsAtContractExecution: artifacts,
    artifactIdentityAtContractExecution: binding.artifactIdentity, compiledAtThisContractLayer: true,
    subsequentCorePreparationMayRecompileContracts: true, oldContractMtimeClaimedCurrentAfterCorePreparation: false };
}

/** 复用只准精确当前源码和真实原Core/Worker输出；不接受路径指向任意旧dist或缺字段记录。 */
async function coreLayer(receiptFile, check, storage, contracts, mode) {
  storage.check(receiptFile, { mustExist: true, kind: 'file' });
  const receipt = parsed((await whole(receiptFile, check)).bytes), directory = path.dirname(receiptFile);
  if (path.basename(receiptFile) !== 'preparation-receipt.json' || receipt.schema !== 'core-test.reader-preparation.v1'
    || receipt.status !== 'FRESH_READER_PREPARED' || receipt.inputsUnchanged !== true || receipt.outputsUnchanged !== true
    || !Array.isArray(receipt.sourceInputs) || !equal(receipt.sourceInputs, coreTestSourceInputs(check))
    || !Array.isArray(receipt.toolInputs) || !receipt.toolInputs.length || !Array.isArray(receipt.outputs) || !receipt.outputs.length
    || !Array.isArray(receipt.stages) || !equal(receipt.stages.map(row => row.name), compilerNames)) fail('MBM003_CORE_PREPARATION_INVALID');
  for (const row of receipt.stages) if (row.compilerExit !== 0 || !Number.isFinite(row.startedMs) || !Number.isFinite(row.finishedMs)
    || row.startedMs <= 0 || row.finishedMs < row.startedMs || row.finishedMs > Date.now()
    || row.finishedMs - row.startedMs > MBM003_SOFTWARE_BUDGETS.stageTimeoutMs) fail('MBM003_CORE_PREPARATION_WINDOW');
  if (receipt.stages.some((row, index) => index > 0 && row.startedMs < receipt.stages[index - 1].finishedMs)
    || receipt.stages[2].finishedMs - receipt.stages[0].startedMs > MBM003_SOFTWARE_BUDGETS.preparationTimeoutMs) fail('MBM003_CORE_PREPARATION_WINDOW');
  const tools = [];
  const require = createRequire(path.join(repository, 'packages/bridge-core/package.json'));
  const toolFiles = [require.resolve('typescript/bin/tsc'), require.resolve('typescript/package.json'),
    ...['tsc.js', '_tsc.js'].map(name => path.join(path.dirname(require.resolve('typescript/package.json')), 'lib', name))].map(file => realpathSync(file));
  if (!uniqueSet(receipt.toolInputs.map(row => row.file), toolFiles)) fail('MBM003_CORE_TOOL_CLOSURE_INVALID');
  for (const row of receipt.toolInputs) {
    if (typeof row.file !== 'string' || !path.isAbsolute(row.file) || !positive(row.bytes) || !/^[a-f0-9]{64}$/u.test(row.sha256)) fail('MBM003_CORE_TOOL_INVALID');
    const actual = await descriptor(row.file, check);
    if (!equal(actual, row)) fail('MBM003_CORE_TOOL_CHANGED'); tools.push(actual);
  }
  if (new Set(tools.map(row => row.file)).size !== tools.length) fail('MBM003_CORE_TOOL_INVALID');
  if (parsed((await whole(realpathSync(require.resolve('typescript/package.json')), check)).bytes).version !== '5.9.3') fail('MBM003_CORE_TOOL_VERSION_CHANGED');
  const requiredOutputs = receipt.sourceInputs.filter(row => /^(?:packages\/contracts|packages\/bridge-core)\/src\/.*\.ts$/u.test(row.path)
    && !row.path.endsWith('.d.ts')).flatMap(row => ['.js', '.js.map', '.d.ts'].map(suffix => row.path.replace('/src/', '/dist/').slice(0, -3) + suffix));
  requiredOutputs.push(...['.mjs', '.mjs.map', '.meta.json', '.build.json'].map(suffix => 'packages/bridge-core/dist/library/metadata-reader-worker.bundle' + suffix));
  if (!uniqueSet(receipt.outputs.map(row => row.path), requiredOutputs)) fail('MBM003_CORE_OUTPUT_CLOSURE_INCOMPLETE');
  const outputSources = new Map(receipt.sourceInputs.filter(row => /^(?:packages\/contracts|packages\/bridge-core)\/src\/.*\.ts$/u.test(row.path)
    && !row.path.endsWith('.d.ts')).flatMap(row => ['.js', '.js.map', '.d.ts'].map(suffix => [row.path.replace('/src/', '/dist/').slice(0, -3) + suffix, row])));
  const current = [], reboundContractOutputs = [];
  for (const row of receipt.outputs) {
    if (!safeRelative(row.path) || !positive(row.bytes) || !/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isFinite(row.mtimeMs)) fail('MBM003_CORE_OUTPUT_INVALID');
    const file = path.join(repository, row.path); storage.check(file, { mustExist: true, kind: 'file' });
    const actual = await whole(file, check);
    if (actual.identity.bytes !== row.bytes || actual.identity.sha256 !== row.sha256) fail('MBM003_CORE_OUTPUT_CHANGED');
    const index = row.path.startsWith('packages/contracts/dist/') ? 0 : row.path.includes('metadata-reader-worker.bundle.') ? 2 : 1;
    const source = outputSources.get(row.path);
    if (index !== 2 && (!source || row.sourcePath !== source.path || row.sourceSha256 !== source.sha256)
      || index === 2 && (Object.hasOwn(row, 'sourcePath') || Object.hasOwn(row, 'sourceSha256'))) fail('MBM003_CORE_OUTPUT_SOURCE_CHANGED');
    const originalStage = receipt.stages[index];
    if (row.mtimeMs < originalStage.startedMs || row.mtimeMs > originalStage.finishedMs) fail('MBM003_CORE_OUTPUT_NOT_ORIGINAL_COMPILER');
    const originalMtimeStillCurrent = lstatSync(file).mtimeMs === row.mtimeMs;
    if (!originalMtimeStillCurrent) {
      const freshContract = contracts.artifactsAtContractExecution.find(item => item.path === row.path);
      if (mode !== 'reuse' || index !== 0 || !freshContract || freshContract.bytes !== row.bytes
        || freshContract.sha256 !== row.sha256 || freshContract.mtimeNs !== actual.mtimeNs) fail('MBM003_CORE_OUTPUT_MTIME_CHANGED');
      reboundContractOutputs.push({ path: row.path, originalMtimeMs: row.mtimeMs, currentMtimeNs: actual.mtimeNs,
        recompiledAtThisGateContractLayer: true, bytesAndSha256Unchanged: true });
    }
    current.push({ path: row.path, ...actual.identity, mtimeNs: actual.mtimeNs });
  }
  const bindingFile = path.join(directory, 'reader-build-binding.json'); storage.check(bindingFile, { mustExist: true, kind: 'file' });
  const bindingBytes = (await whole(bindingFile, check)).bytes, binding = parsed(bindingBytes);
  if (!/^[a-f0-9]{64}$/u.test(receipt.readerBindingSha256) || sha(bindingBytes) !== receipt.readerBindingSha256
    || binding.schema !== 'mbrs003.reader.fresh-build.v2' || binding.compilerExit !== 0
    || binding.compilerStartedAtMs !== receipt.stages[1].startedMs || !Number.isFinite(binding.compilerFinishedAtMs)
    || binding.compilerFinishedAtMs < binding.compilerStartedAtMs || binding.compilerFinishedAtMs > receipt.stages[1].finishedMs) fail('MBM003_READER_BINDING_INVALID');
  const fixed = await readFixedMetadataWorkerBundle(path.join(repository, 'packages/bridge-core'), check);
  if (fixed.manifest.startedAtMs < receipt.stages[2].startedMs || fixed.manifest.finishedAtMs > receipt.stages[2].finishedMs) fail('MBM003_WORKER_NOT_ORIGINAL_BUILD_WINDOW');
  const expectedBinding = makeReaderBundleBinding(receipt.sourceInputs, { compilerExit: 0,
    compilerStartedAtMs: binding.compilerStartedAtMs, compilerFinishedAtMs: binding.compilerFinishedAtMs,
    outputs: receipt.outputs.filter(row => row.path.startsWith('packages/bridge-core/dist/') && !row.path.includes('metadata-reader-worker.bundle.')) }, fixed.manifest);
  if (!equal(binding, expectedBinding)) fail('MBM003_READER_BINDING_CLOSURE_CHANGED');
  const snapshot = { inputs: receipt.sourceInputs, tools, outputs: current, readerBinding: await descriptor(bindingFile, check) };
  async function assertCurrent() {
    check(); if (!equal(receipt.sourceInputs, coreTestSourceInputs(check))) fail('MBM003_CORE_SOURCE_DRIFT');
    for (const row of tools) if (!equal(await descriptor(row.file, check), row)) fail('MBM003_CORE_TOOL_DRIFT');
    for (const row of current) {
      const actual = await whole(row.file, check);
      if (actual.identity.bytes !== row.bytes || actual.identity.sha256 !== row.sha256 || actual.mtimeNs !== row.mtimeNs) fail('MBM003_CORE_COMPILED_DRIFT');
    }
    if (!equal(await descriptor(bindingFile, check), snapshot.readerBinding)) fail('MBM003_READER_BINDING_DRIFT');
  }
  await assertCurrent();
  return { env: { MBRS003_READER_BUILD_BINDING: bindingFile }, assertCurrent,
    proof: { mode, receipt: await descriptor(receiptFile, check), readerBinding: snapshot.readerBinding,
      sourceInputIdentity: mobileInputIdentity(receipt.sourceInputs), stages: receipt.stages,
      toolInputs: tools, currentOutputRows: current, currentOutputCount: current.length,
      currentOutputIdentity: mobileInputIdentity(current.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))),
      originalCompilerExecutionRepeated: mode === 'fresh',
      reusedCoreAndWorkerKeepExactOriginalMtime: mode === 'reuse', reboundContractOutputs,
      bindingSnapshotDoesNotCertifyLaterMutableDist: true, fullTransitiveToolchainClosure: false } };
}

function childEnvironment(env, temporary, mode) {
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:MUSIC_BRIDGE_|NETEASE_|ROON_|MBRS003_READER_BUILD_BINDING$|MBM003_)/u.test(key)));
  Object.assign(result, { TMPDIR: temporary, NODE_ENV: 'test', COREPACK_ENABLE_NETWORK: '0', npm_config_ignore_scripts: 'true' });
  if (mode === 'native') Object.assign(result, { MBM003_CONVERTER_DIRECTORY: env.MBM003_CONVERTER_DIRECTORY,
    MBM003_CONVERTER_MANIFEST_SHA256: env.MBM003_CONVERTER_MANIFEST_SHA256 });
  return result;
}
async function nativeAdmission(mode, env, storage, check) {
  if (mode !== 'native') return null;
  if (storage.hosted || env.GITHUB_ACTIONS === 'true' || process.platform !== 'darwin' || process.arch !== 'arm64'
    || env.MBM003_CONVERTER_MANIFEST_SHA256 !== nativeManifestSha256
    || typeof env.MBM003_CONVERTER_DIRECTORY !== 'string' || !path.isAbsolute(env.MBM003_CONVERTER_DIRECTORY)) fail('MBM003_NATIVE_MODE_NOT_QUALIFIED');
  storage.check(env.MBM003_CONVERTER_DIRECTORY, { mustExist: true });
  const file = path.join(env.MBM003_CONVERTER_DIRECTORY, 'manifest.json'), actual = await descriptor(file, check);
  if (actual.sha256 !== nativeManifestSha256) fail('MBM003_NATIVE_MANIFEST_CHANGED');
  return { manifest: actual, platform: process.platform, architecture: process.arch,
    modeExplicitlySelected: true, qualificationStillRequiresActualNativeTests: true };
}

/** 仅软件入口；Hosted不运行native叶、不把未执行叶计成skip或合格后端。 */
export async function runMbm003SoftwareGate(outputRoot, { env = process.env, mode = 'hosted', corePreparationFile } = {}) {
  if (!['hosted', 'native'].includes(mode) || typeof outputRoot !== 'string'
    || corePreparationFile !== undefined && (typeof corePreparationFile !== 'string' || !path.isAbsolute(corePreparationFile))) fail('MBM003_ARGUMENT_INVALID');
  const budget = clock(), admission = validateOfflineArguments(['--output-root=' + outputRoot], env);
  if (process.versions.node.split('.')[0] !== '22') fail('MBM003_NODE22_REQUIRED');
  const initialHead = readHead(budget.check, budget.remaining), inputs = await sourceRows(budget.check);
  const canonicalBytes = (await whole(path.join(repository, canonical.path), budget.check)).bytes;
  if (canonicalBytes.length !== canonical.bytes || sha(canonicalBytes) !== canonical.sha256) fail('MBM003_CURRENT_CONTRACT_CHANGED');
  const native = await nativeAdmission(mode, env, admission.storage, budget.check);
  const wanted = mode === 'native' ? [...softwareLeaves, ...nativeLeaves] : softwareLeaves;
  const leaves = await Promise.all(wanted.map(([file, count]) => leafCases(file, count, budget.check)));
  if (new Set(leaves.flatMap(row => row.caseNames)).size !== leaves.reduce((count, row) => count + row.expectedTests, 0)) fail('MBM003_CASE_NAME_COLLISION');
  const run = createPrivateRun(admission), temporary = path.join(run, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const runs = [], failures = [], startTime = budget.startedMs; let contracts = null, core = null, sourceInputsUnchanged = false, compiledOutputsUnchanged = false;
  const context = { run, temporary, runs, ...budget, env: childEnvironment(env, temporary, mode) };
  const unchanged = async () => {
    budget.check(); if (readHead(budget.check, budget.remaining) !== initialHead || !equal(await sourceRows(budget.check), inputs)) fail('MBM003_SOURCE_DRIFT');
  };
  try {
    await unchanged();
    const contractsDirectory = path.join(run, 'contracts');
    await capture({ name: 'contract-slice', directory: '.', args: [entry, '--internal=contracts', '--output-root=' + contractsDirectory] }, context,
      MBM003_SOFTWARE_BUDGETS.preparationTimeoutMs);
    contracts = await contractLayer(contractsDirectory, budget.check, admission.storage, inputs);
    if (contracts.head !== initialHead) fail('MBM003_CONTRACT_HEAD_CHANGED'); await unchanged();
    if (corePreparationFile === undefined) {
      const handoffFile = path.join(run, 'core-handoff.json');
      await capture({ name: 'fresh-core-preparation', directory: '.', args: [entry, '--internal=prepare', '--handoff=' + handoffFile] }, context,
        MBM003_SOFTWARE_BUDGETS.preparationTimeoutMs);
      const handoff = parsed((await whole(handoffFile, budget.check)).bytes);
      if (handoff.schema !== 'musicbridge.mbm003.core-preparation-handoff.v1' || typeof handoff.receipt !== 'string'
        || !within(handoff.receipt, temporary) || typeof handoff.readerBinding !== 'string') fail('MBM003_PREPARATION_HANDOFF_INVALID');
      core = await coreLayer(handoff.receipt, budget.check, admission.storage, contracts, 'fresh');
      if (core.env.MBRS003_READER_BUILD_BINDING !== handoff.readerBinding) fail('MBM003_PREPARATION_HANDOFF_INVALID');
    } else core = await coreLayer(corePreparationFile, budget.check, admission.storage, contracts, 'reuse');
    await unchanged(); Object.assign(context.env, core.env);
    for (const leaf of leaves) {
      await core.assertCurrent(); await unchanged();
      const directory = leaf.file.startsWith('apps/desktop/') ? 'apps/desktop' : 'packages/bridge-core';
      const name = (directory === 'apps/desktop' ? 'desktop-' : 'core-') + path.basename(leaf.file, '.test.ts').replaceAll('.', '-');
      await capture({ name, directory, expectedTests: leaf.expectedTests, caseNames: leaf.caseNames,
        args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', path.relative(directory, leaf.file)] }, context);
      await core.assertCurrent(); await unchanged();
    }
    if (native && !equal(await descriptor(native.manifest.file, budget.check), native.manifest)) fail('MBM003_NATIVE_MANIFEST_DRIFT');
    await core.assertCurrent(); compiledOutputsUnchanged = true; await unchanged(); sourceInputsUnchanged = true;
  } catch (error) {
    failures.push(/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'MBM003_SOFTWARE_GATE_EXCEPTION');
    try { await unchanged(); sourceInputsUnchanged = true; }
    catch (readbackError) {
      const code = /^[A-Z0-9_]+$/u.test(readbackError?.code ?? '') ? readbackError.code : 'MBM003_FINAL_SOURCE_READBACK_INCOMPLETE';
      if (!failures.includes(code)) failures.push(code);
    }
  }
  const behavior = runs.filter(row => row.expectedTests !== null), expectedBehaviorTests = leaves.reduce((sum, leaf) => sum + leaf.expectedTests, 0);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key,
    behavior.reduce((sum, row) => sum + (row.testCounts?.[key] ?? 0), 0)]));
  const expectedStages = 1 + (corePreparationFile === undefined ? 1 : 0) + leaves.length;
  const success = failures.length === 0 && contracts !== null && core !== null && sourceInputsUnchanged && compiledOutputsUnchanged
    && runs.length === expectedStages && behavior.length === leaves.length && runs.every(mobileStageSucceeded)
    && isCompleteTestRun(counts, expectedBehaviorTests) && budget.remaining() > 0;
  const summary = { schema: 'musicbridge.mbm003.software-gate.v1', task: 'MBM-003', mode, success, failures,
    state: success ? mode === 'native' ? 'SOFTWARE_AND_NATIVE_SYNTHETIC_BACKEND_PASS' : 'HOSTED_SOFTWARE_ONLY_PASS' : 'FAILED',
    baseSha: predecessor, headAtRun: initialHead, workingSourceBytesBoundSeparatelyFromHead: true,
    startedMs: startTime, finishedMs: Date.now(), durationMs: budget.elapsedMs(), budgets: MBM003_SOFTWARE_BUDGETS,
    sourceInputs: inputs, sourceInputIdentity: mobileInputIdentity(inputs), sourceInputsUnchanged,
    contractLayer: contracts, currentCoreAndWorker: core?.proof ?? null, compiledOutputsUnchanged,
    runs, expectedStages, completedStages: runs.length, expectedBehaviorTests, behaviorCounts: counts,
    allLayerTests: counts.tests + (contracts?.testCounts.tests ?? 0), allLayerPass: counts.pass + (contracts?.testCounts.pass ?? 0),
    selectedTestLeaves: leaves, nativeAdmission: native, nativeLeavesExecuted: mode === 'native' && success,
    nativeLeavesExcludedFromHostedApplicableScope: mode === 'hosted' ? nativeLeaves.map(([file, count]) => ({ file, expectedTests: count, executed: false })) : [],
    exclusionsAreNotSkippedPasses: true, qualificationNotInferredFromFilePresence: true,
    evidenceScope: mode === 'native' ? 'LOCAL_DARWIN_SYNTHETIC_CONVERTER_CACHE_SOURCE_AND_SOFTWARE_ONLY' : 'CONTRACT_ACTOR_REAL_METADATA_WORKER_AND_CONTROLLED_MAIN_TLS_ONLY',
    fullTransitiveToolchainClosure: false, productionApp: 'NOT_PROVEN_BY_THIS_GATE',
    physicalDeviceAudioRoute: 'NOT_PROVEN', realProviderRoonNAS: 'NOT_RUN', ownerAcceptance: 'NOT_PROVEN',
    pairedFinalDelivery: 'NOT_PROVEN_BY_THIS_MAC_SOFTWARE_GATE' };
  writePrivateJson(run, 'summary.json', summary); return { run, summary };
}

/** 内部准备仍调用原API；父runner将整条同步编译链放入自有POSIX组并给360秒而非120秒。 */
async function internal(argv) {
  if (argv.length !== 2) fail('MBM003_INTERNAL_ARGUMENT_INVALID');
  if (argv[0] === '--internal=contracts' && argv[1].startsWith('--output-root=')) {
    const result = await runMbm003ContractGate(argv[1].slice('--output-root='.length), { env: process.env });
    process.stdout.write(JSON.stringify({ state: result.state, topLevelCases: result.topLevelCases }) + '\n'); return;
  }
  if (argv[0] === '--internal=prepare' && argv[1].startsWith('--handoff=')) {
    const handoff = argv[1].slice('--handoff='.length), storage = (await import('../../apps/desktop/scripts/build-storage-root.mjs')).buildStoragePolicy();
    storage.check(handoff, { kind: 'file' }); storage.check(process.env.TMPDIR, { mustExist: true });
    if (path.dirname(handoff) !== path.dirname(process.env.TMPDIR) || path.basename(handoff) !== 'core-handoff.json') fail('MBM003_INTERNAL_HANDOFF_PATH');
    const prepared = await prepareCoreTestEnvironment({ env: process.env }); prepared.assertCurrent();
    const receipt = path.join(prepared.privateRoot, 'preparation-receipt.json');
    if (!within(receipt, process.env.TMPDIR)) fail('MBM003_INTERNAL_PREPARATION_PATH');
    writeFileSync(handoff, JSON.stringify({ schema: 'musicbridge.mbm003.core-preparation-handoff.v1',
      receipt, readerBinding: prepared.env.MBRS003_READER_BUILD_BINDING }) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write('MBM003_FRESH_CORE_WORKER_PREPARED\n'); return;
  }
  fail('MBM003_INTERNAL_ARGUMENT_INVALID');
}
function argumentsFor(argv) {
  const fields = {};
  for (const argument of argv) {
    const match = /^--(output-root|mode|core-preparation)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(fields, match[1]) || /[\u0000-\u001f\u007f]/u.test(match[2])) fail('MBM003_ARGUMENT_INVALID');
    fields[match[1]] = match[2];
  }
  if (!fields['output-root'] || Object.keys(fields).length > 3) fail('MBM003_ARGUMENT_INVALID');
  return { outputRoot: fields['output-root'], mode: fields.mode ?? 'hosted',
    ...(fields['core-preparation'] === undefined ? {} : { corePreparationFile: fields['core-preparation'] }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0]?.startsWith('--internal=')) await internal(argv);
    else {
      const args = argumentsFor(argv), { summary } = await runMbm003SoftwareGate(args.outputRoot, args);
      process.stdout.write(JSON.stringify({ task: summary.task, mode: summary.mode, success: summary.success,
        tests: summary.allLayerTests, pass: summary.allLayerPass, failures: summary.failures,
        deviceAndOwnerAcceptance: 'NOT_PROVEN' }) + '\n');
      if (!summary.success) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write('MBM003 Gate拒绝：' + (/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'ADMISSION_OR_PREPARATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
