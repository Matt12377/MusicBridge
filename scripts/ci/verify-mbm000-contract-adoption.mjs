import { constants, lstatSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOfflineArguments, createPrivateRun, writePrivateJson, sanitizeOutput,
  parseTestCounts, isCompleteTestRun } from './verify-mbrs001-offline.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contracts = 'packages/contracts';
const scopeFile = 'scripts/ci/mbm000-contract-adoption-scope.json';
const authorityRoot = 'docs/postrust/MBM-000';
const canonicalFile = contracts + '/mobile/openapi.json';
const schemaFixtureFile = contracts + '/mobile/schema-fixture-manifest.json';
const transportFixtureFile = contracts + '/mobile/fixtures/manifest.json';
export const MOBILE_EMPTY_FIXTURE_PATH = contracts + '/mobile/fixtures/bodies/empty.bin';
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const MOBILE_BASE = 'd3174bce575aa817b27ba05d39a40d3050b77be4';
export const MOBILE_MODULES = Object.freeze(['mobile-common', 'mobile-catalog', 'mobile-resource', 'mobile-content', 'mobile-wire']);
export const MOBILE_TEST_FILES = Object.freeze(['operation-contract', 'resource-envelope', 'audio-resource-state', 'content-revision']
  .map(name => contracts + '/test/mbm000/' + name + '.test.ts'));
export const MOBILE_FIXTURE_FILES = Object.freeze([contracts + '/test/mbm000/fixture-helpers.ts']);
export const MOBILE_GATE_BUDGETS = Object.freeze({ stageTimeoutMs: 120000, totalTimeoutMs: 360000, killGraceMs: 10000,
  rawOutputBytes: 16777216, sourceFileBytes: 4194304, maxSourceFiles: 4096, maxCompiledFiles: 8192 });
const stageNames = ['fresh-contracts-build', 'contracts-types', 'mobile-contract-behavior'];
const directories = [contracts + '/src', contracts + '/test', contracts + '/mobile', authorityRoot, 'scripts/ci', '.github/workflows'];
const requiredFiles = ['AGENTS.md', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
  contracts + '/package.json', contracts + '/tsconfig.json', contracts + '/tsconfig.test.json',
  'apps/desktop/scripts/build-storage-root.mjs', 'apps/desktop/scripts/build-storage-root.d.mts',
  ...['STATUS.json', 'POSTRUST_PLAN.json', 'POSTRUST_TODO.md', 'POSTRUST_PROGRESS.md'].map(name => 'project/' + name),
  ...['G0_HANDOFF.json', 'EXECUTION_SCOPE.json', 'INPUT_LOCK.json', 'TEST_SCOPE.json', 'ADOPTION.json'].map(name => authorityRoot + '/' + name),
  canonicalFile, schemaFixtureFile, 'scripts/ci/verify-mbm000-contract-adoption.mjs', scopeFile,
  'scripts/ci/test/verify-mbm000-contract-adoption.test.mjs'];
const budgetKeys = ['stageTimeoutMs', 'totalTimeoutMs', 'killGraceMs', 'rawOutputBytes', 'sourceFileBytes', 'maxSourceFiles', 'maxCompiledFiles'];
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const exactSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && same(sorted(a), sorted(b));
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && exactSet(Object.keys(value), names);
const sameBudgets = value => exactKeys(value, budgetKeys) && budgetKeys.every(key => value[key] === MOBILE_GATE_BUDGETS[key]);
const fail = code => { const error = new Error('MBM000合同Gate拒绝准入。'); error.code = code; throw error; };
const shape = s => ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(s[k])).join(':');
const safeRelative = name => typeof name === 'string' && name.length > 0 && !path.isAbsolute(name)
  && !name.includes('\\') && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
function assertPin(bytes, expected, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) fail(code);
}
function jsonBytes(bytes, code) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(code); }
}

/** 新域只采纳已封前驱与两个原输入；不把未来客户端采纳当开工批准。 */
export function assertMobileAdmission({ scope, g0, execution, lock, lockBytes, baseBytes, uiBytes, canonicalBytes }) {
  if (scope?.schema !== 'musicbridge.mbm000.contract-adoption-scope.v1' || scope.task !== 'MBM-000'
    || scope.baseReportSha !== MOBILE_BASE || scope.branch !== 'codex/mbm-000-mobile-contracts'
    || scope.canonicalContract !== canonicalFile || scope.canonicalDocumentVersion !== '1.6.0'
    || scope.baseWireContractVersion !== '0.1.0' || scope.uiCapabilitiesVersion !== '1.0.0'
    || scope.originalOperationCount !== 40 || scope.testScope !== authorityRoot + '/TEST_SCOPE.json'
    || scope.budgetAuthority !== authorityRoot + '/EXECUTION_SCOPE.json#/gateBudgets' || !sameBudgets(scope.gateBudgets)
    || !same(scope.productionFiles, MOBILE_MODULES.map(name => contracts + '/src/' + name + '.ts'))
    || !same(scope.testFiles, MOBILE_TEST_FILES) || !same(scope.fixtureFiles, MOBILE_FIXTURE_FILES)
    || !same(scope.stageNames, stageNames) || !same(scope.declaredDirectories, directories)
    || !same(scope.requiredFiles, requiredFiles) || scope.fullTransitiveToolchainClosure !== false
    || scope.softwareGateIsPairedClientAdoption !== false || scope.runtimeServiceDeviceAudioOwner !== 'NOT_RUN') fail('MBM000_SCOPE_CHANGED');
  const originalLock = { path: authorityRoot + '/INPUT_LOCK.json', bytes: 45510,
    sha256: '2f190bdd30838991ffa43a9c0acc8d114d7474a591f62b31ba03cfbbbfaae2ac' };
  if (!same(scope.inputLock, originalLock)) fail('MBM000_INPUT_LOCK_AUTHORITY_CHANGED');
  assertPin(lockBytes, originalLock, 'MBM000_ORIGINAL_INPUT_LOCK_CHANGED');
  if (g0?.schema !== 'musicbridge.mbm000.g0-handoff.v1' || g0.task !== 'MBM-000' || g0.macBaseReportSha !== MOBILE_BASE
    || !same(g0.inputLock, originalLock) || g0.originalOperationCount !== 40
    || g0.predecessorNaturalSource4Workflows6Jobs !== true || g0.predecessorNaturalReport2Workflows3Jobs !== true
    || g0.predecessorActualReportOnlyVerified !== true || g0.predecessorSoftwareDeliverySealed !== true
    || g0.predecessorRealLayerCarryoverPreserved !== true
    || g0.macPredecessorFinalReceipt?.bytes !== 705617
    || g0.macPredecessorFinalReceipt?.sha256 !== '485c115961f095074e767f46420c77d5ca4d96f2e15cd2660b9ac7f52f43c5bc'
    || g0.iosSourceSha !== 'fc332b5973d9b9c6d608aa8e683d65cef4d2c0e3'
    || g0.iosReportSha !== '26ef98f11dd1db187c496020b9564c226c50bd1e'
    || g0.iosRemoteReportSha !== g0.iosReportSha || g0.iosReportSingleParent !== g0.iosSourceSha) fail('MBM000_G0_CHANGED');
  if (execution?.schema !== 'musicbridge.mbm000.execution-scope.v1' || execution.task !== 'MBM-000'
    || execution.baseReportSha !== MOBILE_BASE || !same(execution.inputLock, originalLock)
    || execution.canonicalContract !== scope.canonicalContract || execution.operationCount !== 40
    || !same(execution.allowedProductionFiles, scope.productionFiles) || !same(execution.testFiles, MOBILE_TEST_FILES)
    || execution.gateEntry !== 'scripts/ci/verify-mbm000-contract-adoption.mjs'
    || !sameBudgets(execution.gateBudgets)) fail('MBM000_EXECUTION_SCOPE_CHANGED');
  if (lock?.schema !== 'musicbridge.mbm000.input-lock.v1' || lock.task !== 'MBM-000'
    || lock.mac?.baseReportSha !== MOBILE_BASE || lock.mobileWireApiVersion !== '1.0.0' || lock.distinctOperations !== 40
    || !Array.isArray(lock.operations) || lock.operations.length !== 40 || lock.ios?.inputCount !== 31
    || lock.macReusePointCount !== 22 || lock.macReusePoints?.length !== 22
    || lock.runtimeServiceDeviceAudioOwner !== 'NOT_RUN'
    || !same(lock.originalTaskLedger, { tasks: 18, acceptanceCases: 156, effectiveTasks: 17, effectiveAcceptanceCases: 150, cancelled015SixCases: 'N_A' })) fail('MBM000_PAIRED_INPUT_CHANGED');
  assertPin(baseBytes, lock.baseInput, 'MBM000_BASE_INPUT_CHANGED');
  assertPin(uiBytes, lock.uiInput, 'MBM000_UI_INPUT_CHANGED');
  if (lock.baseInput.documentVersion !== '0.1.0' || lock.uiInput.documentVersion !== '1.5.0') fail('MBM000_DOCUMENT_VERSION_CHANGED');
  const canonical = jsonBytes(canonicalBytes, 'MBM000_CANONICAL_INVALID');
  if (canonical?.openapi !== '3.1.1' || canonical.info?.version !== '1.6.0' || !canonical.paths
    || typeof canonical.paths !== 'object' || Array.isArray(canonical.paths)) fail('MBM000_CANONICAL_INVALID');
  const operations = [];
  for (const [name, item] of Object.entries(canonical.paths)) {
    if (!name.startsWith('/mobile/v1/') || !item || typeof item !== 'object' || Array.isArray(item)) fail('MBM000_CANONICAL_INVALID');
    for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
      if (item[verb] === undefined) continue;
      if (typeof item[verb]?.operationId !== 'string') fail('MBM000_CANONICAL_INVALID');
      operations.push(verb.toUpperCase() + ' ' + name + ' ' + item[verb].operationId);
    }
  }
  const expected = lock.operations.map(row => row.method + ' ' + row.path + ' ' + row.operationId);
  if (operations.length !== 40 || new Set(operations).size !== 40 || !exactSet(operations, expected)) fail('MBM000_CANONICAL_OPERATION_CHANGED');
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, '$ref') && (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/'))) fail('MBM000_REMOTE_SCHEMA_REF');
    for (const child of Object.values(value)) visit(child);
  };
  visit(canonical);
  return { canonical, operationCount: operations.length };
}

export function assertMobileSuccessStatusCodes(canonical, lock, adoption) {
  const differences = [];
  for (const row of lock.operations) {
    const operation = canonical.paths[row.path][row.method.toLowerCase()];
    const success = sorted(Object.keys(operation.responses ?? {}).filter(code => /^2\d\d$/u.test(code)));
    const original = sorted(row.successStatusCodes);
    if (!same(success, original)) differences.push({ operationId: row.operationId, original, success });
  }
  if (!same(differences, [{ operationId: 'headMediaAsset', original: ['200', '206'], success: ['200'] }])
    || !Array.isArray(adoption.successStatusDifferences) || adoption.successStatusDifferences.length !== 1) fail('MBM000_CANONICAL_SUCCESS_STATUS_CHANGED');
  const declared = adoption.successStatusDifferences[0];
  if (declared.operationId !== 'headMediaAsset' || !same(declared.inputSuccessStatusCodes, [200, 206])
    || !same(declared.adoptedSuccessStatusCodes, [200]) || declared.decision !== 'D2'
    || typeof declared.reason !== 'string' || declared.reason.length === 0) fail('MBM000_CANONICAL_SUCCESS_STATUS_CHANGED');
  return { unchangedOperations: 39, differences };
}

export function assertMobileTestScope(scope, execution, discovered, fixtures) {
  if (scope?.schema !== 'musicbridge.mbm000.test-scope.v1' || scope.task !== 'MBM-000' || scope.baseReportSha !== MOBILE_BASE
    || !same(scope.testFiles, MOBILE_TEST_FILES) || !same(scope.fixtureFiles, MOBILE_FIXTURE_FILES)
    || !exactSet(discovered, MOBILE_TEST_FILES) || !exactSet(fixtures, MOBILE_FIXTURE_FILES)
    || !Number.isSafeInteger(scope.expectedTests) || scope.expectedTests < 1
    || !Array.isArray(scope.caseNames) || scope.caseNames.length !== scope.expectedTests
    || new Set(scope.caseNames).size !== scope.caseNames.length
    || scope.caseNames.some(name => typeof name !== 'string' || name.length === 0 || /[\r\n]/u.test(name))) fail('MBM000_TEST_SCOPE_NOT_FROZEN');
  const b = scope.gateBudgets;
  if (!sameBudgets(b) || !sameBudgets(execution.gateBudgets)) fail('MBM000_GATE_BUDGET_NOT_FROZEN');
  return { expectedTests: scope.expectedTests, caseNames: [...scope.caseNames], gateBudgets: { ...b } };
}

/** 两份manifest职责独立；此处只用完整JSON body，不从transport抽取投影。 */
export function assertMobileSchemaFixtureManifest(adoption, manifest, canonicalBytes, manifestBytes, canonical) {
  const pin = (value, name) => exactKeys(value, ['path', 'bytes', 'sha256']) && value.path === name
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && /^[a-f0-9]{64}$/u.test(value.sha256);
  if (adoption?.schema !== 'musicbridge.mbm000.adoption.v1' || adoption.task !== 'MBM-000'
    || adoption.baseReportSha !== MOBILE_BASE || adoption.documentVersion !== '1.6.0'
    || adoption.baseWireContractVersion !== '0.1.0' || adoption.uiCapabilitiesVersion !== '1.0.0'
    || adoption.versionSemantics?.publicHashFieldsAdded !== false || !sameBudgets(adoption.gateBudgets)
    || !pin(adoption.canonical, canonicalFile) || !pin(adoption.schemaFixtureManifest, schemaFixtureFile)) fail('MBM000_ADOPTION_NOT_FROZEN');
  assertPin(canonicalBytes, adoption.canonical, 'MBM000_CANONICAL_PIN_CHANGED');
  assertPin(manifestBytes, adoption.schemaFixtureManifest, 'MBM000_SCHEMA_FIXTURE_PIN_CHANGED');
  if (!exactKeys(manifest, ['schema', 'canonical', 'fixtures'])
    || manifest.schema !== 'musicbridge.mbm000.schema-fixture-manifest.v1' || !same(manifest.canonical, adoption.canonical)
    || !Array.isArray(manifest.fixtures) || manifest.fixtures.length < 2 || manifest.fixtures.length > MOBILE_GATE_BUDGETS.maxSourceFiles
    || !manifest.fixtures.some(row => row.valid === true) || !manifest.fixtures.some(row => row.valid === false)
    || !canonical.components?.schemas || typeof canonical.components.schemas !== 'object' || Array.isArray(canonical.components.schemas)) fail('MBM000_SCHEMA_FIXTURE_MANIFEST_INVALID');
  const seen = new Set();
  for (const row of manifest.fixtures) {
    if (!exactKeys(row, ['path', 'schemaRef', 'valid']) || !safeRelative(row.path)
      || !row.path.startsWith(contracts + '/mobile/fixtures/bodies/') || typeof row.valid !== 'boolean'
      || typeof row.schemaRef !== 'string' || !/^#\/components\/schemas\/[A-Za-z][A-Za-z0-9]*$/u.test(row.schemaRef)
      || !Object.hasOwn(canonical.components.schemas, row.schemaRef.slice('#/components/schemas/'.length))) fail('MBM000_SCHEMA_FIXTURE_MANIFEST_INVALID');
    const key = row.path + '\n' + row.schemaRef;
    if (seen.has(key)) fail('MBM000_SCHEMA_FIXTURE_MANIFEST_INVALID'); seen.add(key);
  }
  if (canonical.components.schemas.ServerInfo?.properties?.contractVersion?.const !== '0.1.0'
    || canonical.components.schemas.Capabilities?.properties?.contractVersion?.const !== '0.1.0'
    || canonical.components.schemas.UIContentCapabilities?.properties?.version?.const !== '1.0.0') fail('MBM000_BASE_WIRE_VERSION_CHANGED');
  return manifest.fixtures;
}

/** 仅重映射内存中的本地components引用；磁盘canonical字节始终按ADOPTION核验。 */
function localSchemaDocument(canonical) {
  const convert = value => {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === '$ref') {
        if (typeof child !== 'string' || !/^#\/components\/schemas\/[A-Za-z][A-Za-z0-9]*$/u.test(child)) fail('MBM000_SCHEMA_REF_NOT_LOCAL_COMPONENT');
        return [key, '#/$defs/' + child.slice('#/components/schemas/'.length)];
      }
      return [key, convert(child)];
    }));
  };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: convert(canonical.components.schemas) };
}

/** 独立schema预检，不计入TAP或三段行为数；不联网、不忽略普通未知keyword。 */
export async function preflightMobileSchemas({ root, canonical, fixtures, require, budgets, check = () => {}, inspect = readMobileFile }) {
  check(); const started = performance.now();
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const addFormats = require('ajv-formats').default;
  if (require('ajv/package.json').version !== '8.20.0' || require('ajv-formats/package.json').version !== '3.0.1') fail('MBM000_FIXED_SCHEMA_TOOL_VERSION_CHANGED');
  const options = { strict: true, strictTypes: false, strictRequired: false, allErrors: false, validateFormats: true };
  const ajv = new Ajv2020(options);
  addFormats(ajv, ['uri', 'date-time', 'date']);
  ajv.addFormat('binary', true);
  ajv.addKeyword({ keyword: 'x-max-utf8-bytes', type: 'string', schemaType: 'number',
    metaSchema: { type: 'integer', minimum: 0 }, validate: (limit, value) => Buffer.byteLength(value, 'utf8') <= limit });
  for (const keyword of ['x-first-track-cover', 'x-trusted-capability']) ajv.addKeyword({ keyword, valid: true });
  const document = localSchemaDocument(canonical);
  const names = sorted(Object.keys(document.$defs)), validators = new Map();
  if (!names.length || names.length > budgets.maxSourceFiles) fail('MBM000_SCHEMA_COUNT_OVER_BUDGET');
  for (const name of names) { check(); validators.set(name, ajv.compile({ ...document, $ref: '#/$defs/' + name })); }
  const observations = [];
  for (const row of fixtures) {
    check(); const actual = await inspect(path.join(root, row.path), { maxBytes: budgets.sourceFileBytes, check });
    let value, parseValid = true;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(actual.bytes)); } catch { parseValid = false; }
    const schemaName = row.schemaRef.slice('#/components/schemas/'.length);
    const valid = parseValid && validators.get(schemaName)(value);
    if (valid !== row.valid) fail('MBM000_SCHEMA_FIXTURE_EXPECTATION_FAILED');
    observations.push({ ...row, bytes: actual.identity.bytes, sha256: actual.identity.sha256, parseValid, actualValid: valid });
  }
  // 实际require闭包只证明这些已加载模块；不是工具链全传递闭包。
  const entries = [require.resolve('ajv/dist/2020.js'), require.resolve('ajv-formats'), require.resolve('ajv/package.json'), require.resolve('ajv-formats/package.json')];
  const loaded = new Set();
  const visit = file => {
    if (loaded.has(file)) return;
    if (loaded.size >= budgets.maxSourceFiles) fail('MBM000_SCHEMA_TOOL_COUNT_OVER_BUDGET'); loaded.add(file);
    const module = require.cache[file]; if (!module) fail('MBM000_SCHEMA_TOOL_LOAD_NOT_OBSERVED');
    for (const child of module.children) visit(child.filename);
  };
  for (const file of entries) visit(file);
  const tools = [];
  for (const file of sorted(new Set(await Promise.all([...loaded].map(file => realpath(file)))))) {
    check(); tools.push((await inspect(file, { maxBytes: budgets.sourceFileBytes, check })).identity);
  }
  return { schema: 'musicbridge.mbm000.independent-schema-preflight.v1', success: true, durationMs: performance.now() - started,
    engine: { ajv: '8.20.0', ajvFormats: '3.0.1', options }, formats: ['uri', 'date-time', 'date'], binaryFormatAnnotationOnly: true,
    annotationKeywords: ['x-first-track-cover', 'x-trusted-capability'], utf8ByteKeywordActuallyValidated: true,
    externalSchemaFetch: false, fullBodyOnly: true, componentSchemaCount: names.length, fixtures: observations,
    fixtureCount: observations.length, testCountContribution: 0, loadedSchemaToolEntries: tools, fullTransitiveToolchainClosure: false };
}

/** 空body仅按真实manifest的唯一零字节声明准入；其它输入不继承这个例外。 */
export function mobileInputAllowsEmpty(relative, manifest) {
  if (relative !== MOBILE_EMPTY_FIXTURE_PATH) return false;
  if (manifest?.schema !== 'musicbridge.mobile.full-body-fixture-manifest.v1' || !Array.isArray(manifest.bodyFiles)) fail('MBM000_EMPTY_BODY_NOT_DECLARED');
  const rows = manifest.bodyFiles.filter(row => row?.fileName === 'bodies/empty.bin');
  if (rows.length !== 1 || !exactKeys(rows[0], ['fileName', 'bytes', 'sha256', 'encoding'])
    || rows[0].bytes !== 0 || rows[0].sha256 !== emptySha256 || rows[0].encoding !== 'RAW_BINARY') fail('MBM000_EMPTY_BODY_NOT_DECLARED');
  return true;
}

/** 真正O_NOFOLLOW读取；全FD和命名九项stat对账，默认仍拒空文件。 */
export async function readMobileFile(file, { maxBytes = 1048576, check = () => {}, allowEmpty = false } = {}) {
  check(); if (!path.isAbsolute(file) || await realpath(file) !== file) fail('MBM000_FILE_NOT_CANONICAL');
  check(); const named = await lstat(file, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.size < (allowEmpty === true ? 0n : 1n) || named.size > BigInt(maxBytes)) fail('MBM000_FILE_BUDGET_OR_KIND');
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes, mtimeNs;
  try {
    const first = await fd.stat({ bigint: true }); if (shape(first) !== shape(named)) fail('MBM000_FILE_CHANGED');
    mtimeNs = first.mtimeNs.toString();
    const chunks = []; let offset = 0;
    while (offset < Number(first.size)) {
      check(); const block = Buffer.alloc(Math.min(1048576, Number(first.size) - offset));
      const { bytesRead } = await fd.read(block, 0, block.length, offset); check();
      if (!bytesRead) fail('MBM000_FILE_CHANGED'); chunks.push(block.subarray(0, bytesRead)); offset += bytesRead;
    }
    bytes = Buffer.concat(chunks); if (shape(await fd.stat({ bigint: true })) !== shape(first)) fail('MBM000_FILE_CHANGED');
  } finally { await fd.close(); }
  if (shape(await lstat(file, { bigint: true })) !== shape(named)) fail('MBM000_FILE_CHANGED'); check();
  return { bytes, identity: { file, bytes: bytes.length, sha256: sha(bytes) }, mtimeMs: Number(mtimeNs) / 1e6, mtimeNs };
}
export function mobileArtifactIdentity(rows) {
  return sha(JSON.stringify(rows.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 }))
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)));
}
export function mobileInputIdentity(rows) { return sha(JSON.stringify(rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))); }
export function mobileStageSucceeded(result) {
  return result.exitCode === 0 && result.signal === null && result.closeObserved === true
    && ['timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].every(key => result[key] === false)
    && (result.expectedTests === null && result.name !== 'mobile-contract-behavior'
      || isCompleteTestRun(result.testCounts, result.expectedTests) && result.tapStatusesClean === true
      && result.tapPlanComplete === true && exactSet(result.actualCaseNames, result.expectedCaseNames));
}

export function mobileTapResult(raw, expected) {
  const plans = [...raw.matchAll(/^1\.\.(\d+)$/gmu)];
  return { testCounts: parseTestCounts(raw),
    tapPlanComplete: plans.length === 1 && Number(plans[0][1]) === expected,
    tapStatusesClean: !/^\s*not ok \d+|^\s*ok \d+[^\r\n]*#\s*(?:SKIP|TODO)\b/imu.test(raw),
    actualCaseNames: [...raw.matchAll(/^# Subtest: (.+)$/gmu)].map(match => match[1]) };
}

/** 只清理本stage自有POSIX组；exit事件不等于close，超限前缀不冒充完整raw。 */
export async function captureMobileStage(stage, { run, temporary, env, budgets, remaining,
  spawnProcess = spawn, killGroup = pid => process.kill(-pid, 'SIGKILL') }) {
  if (!/^[a-z][a-z0-9-]{1,60}$/u.test(stage.name)) fail('MBM000_STAGE_NAME_INVALID');
  const began = performance.now(); const result = { name: stage.name, directory: contracts,
    argv: [process.execPath, ...stage.args], startedMs: Date.now(), closedMs: null,
    expectedTests: stage.expectedTests ?? null, expectedCaseNames: stage.caseNames ?? null,
    exitCode: null, signal: null, closeObserved: false, exitObserved: false,
    timedOut: false, overflow: false, captureFailed: false, preparationFailed: false, groupTerminationFailed: false };
  const chunks = []; let length = 0, observed = 0;
  await new Promise(resolve => {
    let child, timer, grace, stopped = false, settled = false;
    const settle = () => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); resolve(); };
    const terminate = () => {
      if (stopped || settled) return; stopped = true;
      if (child?.pid !== undefined) try { killGroup(child.pid); } catch (error) { if (error.code !== 'ESRCH') result.groupTerminationFailed = true; }
      grace = setTimeout(() => { result.groupTerminationFailed = true; settle(); }, budgets.killGraceMs);
    };
    try { child = spawnProcess(process.execPath, stage.args, { cwd: path.join(repository, contracts), env,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { result.preparationFailed = true; settle(); return; }
    child.once('exit', () => { result.exitObserved = true; });
    child.once('close', (code, signal) => { result.exitCode = code; result.signal = signal; result.closedMs = Date.now(); result.closeObserved = true; settle(); });
    child.once('error', () => { result.preparationFailed = true; terminate(); });
    const append = bytes => {
      observed += bytes.length;
      if (result.overflow || result.captureFailed) return;
      try {
        if (length + bytes.length > budgets.rawOutputBytes) { result.overflow = true; terminate(); }
        else { chunks.push(Buffer.from(bytes)); length += bytes.length; }
      } catch { result.captureFailed = true; terminate(); }
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) { result.preparationFailed = true; terminate(); continue; }
      stream.on('data', append); stream.once('error', () => { result.captureFailed = true; terminate(); });
    }
    timer = setTimeout(() => { result.timedOut = true; terminate(); }, Math.max(1, Math.min(budgets.stageTimeoutMs, remaining())));
  });
  const bytes = Buffer.concat(chunks); let raw = '';
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { result.captureFailed = true; }
  const safe = sanitizeOutput(raw);
  Object.assign(result, { durationMs: performance.now() - began, rawBytes: bytes.length, rawSha256: sha(bytes), observedRawBytes: observed,
    rawCaptureComplete: result.closeObserved && !result.overflow && !result.captureFailed,
    ...(result.expectedTests === null ? { testCounts: null, tapPlanComplete: null, tapStatusesClean: null, actualCaseNames: null } : mobileTapResult(raw, result.expectedTests)),
    log: stage.name + '.log', logSha256: sha(safe), rawLog: 'tmp/' + stage.name + '.raw.log',
    processIsolation: 'OWNED_POSIX_PROCESS_GROUP', rawCaptureScope: 'STDOUT_STDERR_OBSERVED_ARRIVAL_BYTES_NOT_CHRONOLOGICAL_RECONSTRUCTION' });
  writeFileSync(path.join(run, result.log), safe, { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(temporary, stage.name + '.raw.log'), bytes, { flag: 'wx', mode: 0o600 });
  result.success = mobileStageSucceeded(result); return result;
}

function discover(root, relative, maxFiles, check, depth = 0) {
  check(); if (!safeRelative(relative) || depth > 32) fail('MBM000_INPUT_DIRECTORY_INVALID');
  const info = lstatSync(path.join(root, relative));
  if (info.isSymbolicLink()) fail('MBM000_INPUT_SYMLINK');
  if (info.isFile()) return [relative];
  if (!info.isDirectory()) fail('MBM000_INPUT_NOT_ORDINARY');
  const result = [];
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    result.push(...discover(root, relative + '/' + name, maxFiles, check, depth + 1));
    if (result.length > maxFiles) fail('MBM000_SOURCE_COUNT_OVER_BUDGET');
  }
  return result;
}
export async function assertMobileArtifactClosure(rows, inspect = file => readMobileFile(file, { maxBytes: 16777216 })) {
  if (!Array.isArray(rows) || rows.length === 0 || new Set(rows.map(row => row?.file)).size !== rows.length) fail('MBM000_ARTIFACT_CLOSURE_INVALID');
  for (const row of rows) {
    if (!row || typeof row.file !== 'string' || !path.isAbsolute(row.file) || !Number.isSafeInteger(row.bytes) || row.bytes < 1
      || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)) fail('MBM000_ARTIFACT_CLOSURE_INVALID');
    const actual = (await inspect(row.file)).identity;
    if (actual.file !== row.file || actual.bytes !== row.bytes || actual.sha256 !== row.sha256) fail('MBM000_ARTIFACT_CHANGED');
  }
  return true;
}

export async function captureMobileCompilerOutputs(root, inputs, compiler, { budgets, check = () => {} }, inspect = readMobileFile) {
  if (!mobileStageSucceeded(compiler) || compiler.name !== 'fresh-contracts-build'
    || !Number.isFinite(compiler.startedMs) || !Number.isFinite(compiler.closedMs) || compiler.closedMs < compiler.startedMs) fail('MBM000_COMPILER_NOT_NATURALLY_CLOSED');
  const sources = inputs.filter(row => row.path.startsWith(contracts + '/src/') && row.path.endsWith('.ts') && !row.path.endsWith('.d.ts'));
  const outputs = [];
  if (sources.length === 0 || sources.length * 3 > budgets.maxCompiledFiles) fail('MBM000_COMPILED_COUNT_OVER_BUDGET');
  for (const source of sources) for (const suffix of ['.js', '.js.map', '.d.ts']) {
    const relativePath = source.path.replace('/src/', '/dist/').slice(0, -3) + suffix;
    const actual = await inspect(path.join(root, relativePath), { maxBytes: budgets.sourceFileBytes, check });
    if (typeof actual.mtimeNs !== 'string' || !/^-?\d+$/u.test(actual.mtimeNs)) fail('MBM000_COMPILED_STAT_INVALID');
    if (actual.mtimeMs < compiler.startedMs || actual.mtimeMs > compiler.closedMs) fail('MBM000_COMPILED_OUTPUT_NOT_FRESH');
    outputs.push({ ...actual.identity, relativePath, sourcePath: source.path, sourceSha256: source.sha256, mtimeMs: actual.mtimeMs, mtimeNs: actual.mtimeNs });
  }
  return outputs.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}

export async function assertMobileConsumption(receipts, binding, bindingBytes) {
  if (!Array.isArray(receipts) || receipts.length !== 4 || !exactSet(receipts.map(row => row.testFile), MOBILE_TEST_FILES.map(file => file.slice(contracts.length + 1)))) fail('MBM000_CONSUMPTION_INCOMPLETE');
  const modules = MOBILE_MODULES.map(name => contracts + '/dist/' + name + '.js');
  const expected = binding.artifacts.filter(row => MOBILE_MODULES.some(name => row.sourcePath === contracts + '/src/' + name + '.ts'))
    .map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 }));
  if (expected.length !== 15) fail('MBM000_MOBILE_COMPILED_CLOSURE_INCOMPLETE');
  for (const row of receipts) if (!exactKeys(row, ['schema', 'testFile', 'head', 'bindingSha256', 'artifactIdentity', 'inputIdentity', 'artifacts', 'loadedModules'])
    || row.schema !== 'musicbridge.mbm000.contract-consumption.v1' || row.head !== binding.head
    || row.bindingSha256 !== sha(bindingBytes) || row.artifactIdentity !== binding.artifactIdentity
    || row.inputIdentity !== mobileInputIdentity(binding.inputs) || !same(row.artifacts, expected)
    || !exactSet(row.loadedModules, modules)) fail('MBM000_CONSUMPTION_CHANGED');
  return true;
}

export async function runMobileContractGate(argv = process.argv.slice(2), env = process.env) {
  const startedAt = new Date().toISOString(), began = performance.now();
  const remaining = () => MOBILE_GATE_BUDGETS.totalTimeoutMs - (performance.now() - began);
  const check = () => { if (remaining() <= 0) fail('MBM000_TOTAL_BUDGET_EXHAUSTED'); };
  const storage = validateOfflineArguments(argv, env);
  if (process.versions.node.split('.')[0] !== '22') fail('MBM000_NODE22_REQUIRED');
  // 首写前只读有限配置；实际测试数/本域预算必须由本任务正式锁提供。
  const admissionRows = new Map();
  const admissionRead = async relative => {
    const actual = await readMobileFile(path.join(repository, relative), { maxBytes: MOBILE_GATE_BUDGETS.sourceFileBytes, check });
    const row = { path: relative, bytes: actual.identity.bytes, sha256: actual.identity.sha256 };
    if (admissionRows.has(relative) && !same(admissionRows.get(relative), row)) fail('MBM000_ADMISSION_INPUT_DRIFT');
    admissionRows.set(relative, row); return actual.bytes;
  };
  const readJson = async relative => jsonBytes(await admissionRead(relative), 'MBM000_ADMISSION_JSON_INVALID');
  const scope = await readJson(scopeFile);
  const g0 = await readJson(authorityRoot + '/G0_HANDOFF.json');
  const execution = await readJson(authorityRoot + '/EXECUTION_SCOPE.json');
  const lockBytes = await admissionRead(authorityRoot + '/INPUT_LOCK.json'), lock = jsonBytes(lockBytes, 'MBM000_INPUT_LOCK_INVALID');
  const canonicalBytes = await admissionRead(canonicalFile);
  const admission = assertMobileAdmission({ scope, g0, execution, lock, lockBytes,
    baseBytes: await admissionRead(lock.baseInput.path), uiBytes: await admissionRead(lock.uiInput.path), canonicalBytes });
  const adoption = await readJson(authorityRoot + '/ADOPTION.json');
  const schemaFixtureBytes = await admissionRead(schemaFixtureFile);
  const schemaManifest = jsonBytes(schemaFixtureBytes, 'MBM000_SCHEMA_FIXTURE_MANIFEST_INVALID');
  const schemaFixtures = assertMobileSchemaFixtureManifest(adoption, schemaManifest, canonicalBytes, schemaFixtureBytes, admission.canonical);
  if (!exactKeys(adoption.transportFixtureManifest, ['path', 'bytes', 'sha256'])
    || adoption.transportFixtureManifest.path !== transportFixtureFile) fail('MBM000_TRANSPORT_FIXTURE_NOT_FROZEN');
  const transportBytes = await admissionRead(transportFixtureFile);
  assertPin(transportBytes, adoption.transportFixtureManifest, 'MBM000_TRANSPORT_FIXTURE_PIN_CHANGED');
  const transportManifest = jsonBytes(transportBytes, 'MBM000_TRANSPORT_FIXTURE_INVALID');
  mobileInputAllowsEmpty(MOBILE_EMPTY_FIXTURE_PATH, transportManifest);
  const successStatusCodes = assertMobileSuccessStatusCodes(admission.canonical, lock, adoption);
  const test = await readJson(scope.testScope);
  const found = discover(repository, contracts + '/test/mbm000', MOBILE_GATE_BUDGETS.maxSourceFiles, check);
  const tests = assertMobileTestScope(test, execution, found.filter(name => name.endsWith('.test.ts')), found.filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')));
  const budgets = tests.gateBudgets;
  const git = args => { check(); const value = execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: Math.max(1, Math.floor(remaining())), maxBuffer: 4194304 }); check(); return value.replace(/\s+$/u, ''); };
  git(['merge-base', '--is-ancestor', MOBILE_BASE, 'HEAD']);
  const head = git(['rev-parse', 'HEAD']); if (!/^[a-f0-9]{40}$/u.test(head)) fail('MBM000_HEAD_INVALID');
  const inputNames = () => {
    const names = scope.declaredDirectories.flatMap(relative => discover(repository, relative, budgets.maxSourceFiles, check));
    names.push(...scope.requiredFiles, ...scope.productionFiles, ...scope.testFiles, ...scope.fixtureFiles, ...lock.macReusePoints.map(row => row.path));
    const result = sorted(new Set(names)); if (result.length > budgets.maxSourceFiles) fail('MBM000_SOURCE_COUNT_OVER_BUDGET'); return result;
  };
  const readInputs = async () => {
    const rows = [];
    for (const name of inputNames()) {
      const allowEmpty = mobileInputAllowsEmpty(name, transportManifest);
      const actual = await readMobileFile(path.join(repository, name), { maxBytes: budgets.sourceFileBytes, check, allowEmpty });
      if (allowEmpty) assertPin(actual.bytes, { bytes: 0, sha256: emptySha256 }, 'MBM000_EMPTY_BODY_CHANGED');
      rows.push({ path: name, bytes: actual.identity.bytes, sha256: actual.identity.sha256 });
    }
    return rows;
  };
  const inputs = await readInputs();
  for (const row of admissionRows.values()) if (!same(inputs.find(input => input.path === row.path), row)) fail('MBM000_ADMISSION_INPUT_DRIFT');
  for (const pinned of lock.macReusePoints) {
    const actual = inputs.find(row => row.path === pinned.path); if (actual?.bytes !== pinned.bytes || actual?.sha256 !== pinned.sha256) fail('MBM000_EXISTING_MAC_BOUNDARY_CHANGED');
  }
  const require = createRequire(path.join(repository, contracts, 'package.json'));
  const toolNames = [require.resolve('typescript/bin/tsc'), require.resolve('typescript/package.json'), require.resolve('tsx'), require.resolve('tsx/package.json')];
  const tools = [];
  for (const file of sorted(new Set(await Promise.all(toolNames.map(file => realpath(file)))))) tools.push((await readMobileFile(file, { maxBytes: budgets.sourceFileBytes, check })).identity);
  const tsc = await realpath(toolNames[0]);
  if (jsonBytes((await readMobileFile(await realpath(toolNames[1]), { maxBytes: budgets.sourceFileBytes, check })).bytes, 'MBM000_TOOL_PACKAGE_INVALID').version !== '5.9.3'
    || jsonBytes((await readMobileFile(await realpath(toolNames[3]), { maxBytes: budgets.sourceFileBytes, check })).bytes, 'MBM000_TOOL_PACKAGE_INVALID').version !== '4.23.12'
    || (await readJson('package.json')).packageManager !== 'pnpm@10.17.1') fail('MBM000_FIXED_TOOL_VERSION_CHANGED');
  const run = createPrivateRun(storage), temporary = path.join(run, 'tmp'), consumed = path.join(run, 'consumed');
  for (const directory of [temporary, consumed]) mkdirSync(directory, { mode: 0o700 });
  const bindingFile = path.join(run, 'fresh-contract-build-binding.json');
  const childEnv = { ...env, TMPDIR: temporary, MBM000_CONTRACT_BUILD_BINDING: bindingFile, MBM000_CONTRACT_CONSUMPTION_ROOT: consumed };
  const stages = [{ name: stageNames[0], args: [tsc, '-p', 'tsconfig.json'] },
    { name: stageNames[1], args: [tsc, '-p', 'tsconfig.test.json', '--noEmit'] },
    { name: stageNames[2], expectedTests: tests.expectedTests, caseNames: tests.caseNames,
      args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...MOBILE_TEST_FILES.map(file => file.slice(contracts.length + 1))] }];
  const runs = [], failures = [], compiled = [], closure = [];
  let binding = null, inputsUnchanged = false, artifactsUnchanged = false, consumptionComplete = false, schemaPreflight = null;
  try {
    schemaPreflight = await preflightMobileSchemas({ root: repository, canonical: admission.canonical, fixtures: schemaFixtures, require, budgets, check });
    tools.push(...schemaPreflight.loadedSchemaToolEntries);
    writePrivateJson(run, 'independent-schema-preflight.json', schemaPreflight);
    for (const stage of stages) {
      check(); const result = await captureMobileStage(stage, { run, temporary, env: childEnv, budgets, remaining }); runs.push(result);
      if (!result.success) { failures.push('MBM000_STAGE_FAILED_OR_INCOMPLETE'); break; }
      if (stage.name === stageNames[0]) {
        compiled.push(...await captureMobileCompilerOutputs(repository, inputs, result, { budgets, check }));
        const actualDist = discover(repository, contracts + '/dist', budgets.maxCompiledFiles, check);
        if (!exactSet(actualDist, compiled.map(row => row.relativePath))) fail('MBM000_COMPILED_INVENTORY_CHANGED');
        const compiler = Object.fromEntries(['startedMs', 'closedMs', 'exitCode', 'signal', 'closeObserved', 'timedOut', 'overflow', 'captureFailed', 'preparationFailed', 'groupTerminationFailed'].map(key => [key, result[key]]));
        binding = { schema: 'musicbridge.mbm000.fresh-contracts-binding.v1', root: repository, head, predecessor: MOBILE_BASE,
          inputs, compiler, artifacts: compiled, artifactIdentity: mobileArtifactIdentity(compiled),
          fullTransitiveToolchainClosure: false, softwareGateIsPairedClientAdoption: false };
        writePrivateJson(run, path.basename(bindingFile), binding);
        closure.push(...compiled, (await readMobileFile(bindingFile, { maxBytes: budgets.sourceFileBytes, check })).identity);
      }
    }
    inputsUnchanged = git(['rev-parse', 'HEAD']) === head && same(await readInputs(), inputs);
    if (!inputsUnchanged) fail('MBM000_DECLARED_INPUT_OR_HEAD_DRIFT');
    if (binding && runs.length === stages.length && runs.every(mobileStageSucceeded)) {
      const files = readdirSync(consumed).sort();
      const expected = MOBILE_TEST_FILES.map(file => path.basename(file) + '.json');
      if (!exactSet(files, expected)) fail('MBM000_CONSUMPTION_INCOMPLETE');
      const receipts = [];
      for (const file of files) { const actual = await readMobileFile(path.join(consumed, file), { maxBytes: budgets.sourceFileBytes, check }); receipts.push(jsonBytes(actual.bytes, 'MBM000_CONSUMPTION_JSON_INVALID')); closure.push(actual.identity); }
      const bytes = (await readMobileFile(bindingFile, { maxBytes: budgets.sourceFileBytes, check })).bytes;
      await assertMobileConsumption(receipts, binding, bytes); consumptionComplete = true;
      await assertMobileArtifactClosure([...closure, ...tools], file => readMobileFile(file, { maxBytes: budgets.sourceFileBytes, check })); artifactsUnchanged = true;
      writePrivateJson(run, 'compiled-output-closure.json', compiled); writePrivateJson(run, 'consumed-artifact-closure.json', closure);
      if (!same(await readInputs(), inputs) || git(['rev-parse', 'HEAD']) !== head) fail('MBM000_FINAL_INPUT_DRIFT');
    }
    check();
  } catch (error) { failures.push(/^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'MBM000_GATE_EXCEPTION'); }
  const success = failures.length === 0 && runs.length === stages.length && runs.every(mobileStageSucceeded)
    && schemaPreflight?.success === true && inputsUnchanged && artifactsUnchanged && consumptionComplete && remaining() > 0;
  const behavior = runs.find(result => result.name === stageNames[2]);
  const summary = { schema: 'musicbridge.mbm000.contract-adoption-gate.v1', task: 'MBM-000', baseReportSha: MOBILE_BASE, head,
    startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - began, success, failures,
    gateBudgets: budgets, operationCount: admission.operationCount, operationCountIsTestCount: false, successStatusCodes,
    independentSchemaPreflight: schemaPreflight,
    sourceInputs: inputs, sourceInputCount: inputs.length, sourceInputIdentity: mobileInputIdentity(inputs),
    declaredToolEntries: tools, inputScope: 'DECLARED_SOURCE_TEST_CONFIGURATION_DIRECT_TOOL_ENTRIES_AND_ACTUALLY_LOADED_SCHEMA_TOOLS_NOT_TRANSITIVE_TOOLCHAIN',
    inputsUnchanged, compiledOutputCount: compiled.length, consumedArtifactCount: closure.length,
    compiledOutputIdentity: binding?.artifactIdentity ?? null, artifactsUnchanged, consumptionComplete,
    completedStages: runs.length, expectedStages: stages.length, runs,
    expectedTests: tests.expectedTests, tests: behavior?.testCounts?.tests ?? 0, pass: behavior?.testCounts?.pass ?? 0,
    fullTransitiveToolchainClosure: false, pairedClientFinalAdoption: 'NOT_PROVEN_BY_THIS_SOFTWARE_GATE',
    productionApp: 'NOT_RUN_BY_THIS_GATE', runtimeServiceDeviceAudioOwner: 'NOT_RUN',
    existingLoopbackNodeWriterRustDefaultBoundary: 'UNCHANGED_MAC_REUSE_POINTS_PINNED' };
  writePrivateJson(run, 'summary.json', summary); return { run, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { run, summary } = await runMobileContractGate();
    process.stdout.write(JSON.stringify({ run, success: summary.success, tests: summary.tests, pass: summary.pass,
      failedStages: summary.runs.filter(row => !row.success).map(({ name, exitCode, signal, closeObserved, timedOut, testCounts }) => ({ name, exitCode, signal, closeObserved, timedOut, testCounts })), failures: summary.failures }) + '\n');
    if (!summary.success) process.exitCode = 1;
  } catch (error) { process.stderr.write('MBM000合同Gate拒绝：' + (/^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'ADMISSION_FAILED') + '\n'); process.exitCode = 1; }
}
