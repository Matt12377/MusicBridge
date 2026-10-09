import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOfflineArguments } from '../verify-mbrs001-offline.mjs';
import { MOBILE_BASE, MOBILE_MODULES, MOBILE_TEST_FILES, MOBILE_FIXTURE_FILES, MOBILE_GATE_BUDGETS, MOBILE_EMPTY_FIXTURE_PATH,
  assertMobileAdmission, assertMobileTestScope, assertMobileSchemaFixtureManifest, assertMobileSuccessStatusCodes,
  preflightMobileSchemas, readMobileFile, mobileInputAllowsEmpty, mobileArtifactIdentity, mobileInputIdentity, mobileTapResult,
  mobileStageSucceeded, captureMobileStage, assertMobileArtifactClosure, captureMobileCompilerOutputs,
  assertMobileConsumption } from '../verify-mbm000-contract-adoption.mjs';

// 本文件的时钟/进程/小schema均是受控Gate单元材料，不是移动服务、吞吐或真实客户端证据。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = relative => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const clone = value => structuredClone(value);
const canonicalFile = 'packages/contracts/mobile/openapi.json';
const manifestFile = 'packages/contracts/mobile/schema-fixture-manifest.json';
const pin = (relative, bytes) => ({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
const bad = code => error => error?.code === code;
const fullNames = ['受控合同甲', '受控合同乙'];
const tap = (names = fullNames) => 'TAP version 13\n' + names.map((name, i) =>
  '# Subtest: ' + name + '\nok ' + (i + 1) + ' - ' + name + '\n').join('')
  + '1..' + names.length + '\n# tests ' + names.length + '\n# pass ' + names.length
  + '\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const closed = (name = 'fresh-contracts-build') => ({ name, exitCode: 0, signal: null, closeObserved: true,
  timedOut: false, overflow: false, captureFailed: false, preparationFailed: false, groupTerminationFailed: false,
  expectedTests: null, expectedCaseNames: null, startedMs: 100, closedMs: 200 });
const behavior = raw => ({ ...closed('mobile-contract-behavior'), expectedTests: 2, expectedCaseNames: fullNames,
  ...mobileTapResult(raw, 2) });
function admission() {
  const lockBytes = readFileSync(path.join(root, 'docs/postrust/MBM-000/INPUT_LOCK.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  return { scope: json('scripts/ci/mbm000-contract-adoption-scope.json'),
    g0: json('docs/postrust/MBM-000/G0_HANDOFF.json'), execution: json('docs/postrust/MBM-000/EXECUTION_SCOPE.json'),
    lock, lockBytes, baseBytes: readFileSync(path.join(root, lock.baseInput.path)),
    uiBytes: readFileSync(path.join(root, lock.uiInput.path)), canonicalBytes: readFileSync(path.join(root, canonicalFile)) };
}
function testScope() {
  return { schema: 'musicbridge.mbm000.test-scope.v1', task: 'MBM-000', baseReportSha: MOBILE_BASE,
    testFiles: [...MOBILE_TEST_FILES], fixtureFiles: [...MOBILE_FIXTURE_FILES], expectedTests: 2,
    caseNames: [...fullNames], gateBudgets: { ...MOBILE_GATE_BUDGETS } };
}
function schemaFixture() {
  const canonicalBytes = readFileSync(path.join(root, canonicalFile)), canonical = JSON.parse(canonicalBytes.toString('utf8'));
  const manifest = { schema: 'musicbridge.mbm000.schema-fixture-manifest.v1', canonical: pin(canonicalFile, canonicalBytes), fixtures: [
    { path: 'packages/contracts/mobile/fixtures/bodies/controlled-valid.json', schemaRef: '#/components/schemas/ServerInfo', valid: true },
    { path: 'packages/contracts/mobile/fixtures/bodies/controlled-invalid.json', schemaRef: '#/components/schemas/ServerInfo', valid: false },
  ] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const adoption = { ...json('docs/postrust/MBM-000/ADOPTION.json'), schemaFixtureManifest: pin(manifestFile, manifestBytes) };
  return { adoption, manifest, canonicalBytes, manifestBytes, canonical };
}
async function owned(t) {
  assert.equal(typeof process.env.TMPDIR, 'string');
  const candidate = path.join(process.env.TMPDIR, 'mbm000-gate-unit-' + randomUUID());
  const storage = validateOfflineArguments(['--output-root=' + candidate], process.env);
  const directory = mkdtempSync(path.join(storage.temporary, 'mbm000-gate-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return realpath(directory);
}
function fakeChild() {
  const child = new EventEmitter(); child.pid = 31415;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child;
}
async function captureControlled(t, stage, script, { stageMs = 100, graceMs = 30, rawBytes = 4096, kill } = {}) {
  const directory = await owned(t), temporary = path.join(directory, 'tmp'); mkdirSync(temporary, { mode: 0o700 });
  const child = fakeChild(), kills = [];
  const result = await captureMobileStage(stage, { run: directory, temporary, env: {},
    budgets: { ...MOBILE_GATE_BUDGETS, stageTimeoutMs: stageMs, killGraceMs: graceMs, rawOutputBytes: rawBytes },
    remaining: () => 1000, spawnProcess: () => { queueMicrotask(() => script(child)); return child; },
    killGroup: pid => { kills.push(pid); if (kill) kill(child); else queueMicrotask(() => child.emit('close', null, 'SIGKILL')); } });
  return { result, kills, directory };
}

test('准入绑定真实前驱、原31对端输入和40操作，不把未采纳客户端当运行证据', () => {
  const value = admission(), accepted = assertMobileAdmission(value);
  assert.equal(accepted.operationCount, 40); assert.equal(accepted.canonical.info.version, '1.6.0');
  assert.equal(value.scope.fullTransitiveToolchainClosure, false);
  assert.equal(value.scope.softwareGateIsPairedClientAdoption, false);
});

test('错误前驱、旧版本、原mirror修改和新remote引用都拒绝', () => {
  const first = admission(), wrongBase = clone(first); wrongBase.g0.macBaseReportSha = '0'.repeat(40);
  assert.throws(() => assertMobileAdmission({ ...first, g0: wrongBase.g0 }), bad('MBM000_G0_CHANGED'));
  const wrongScope = clone(first.scope); wrongScope.baseWireContractVersion = '1.0.0';
  assert.throws(() => assertMobileAdmission({ ...first, scope: wrongScope }), bad('MBM000_SCOPE_CHANGED'));
  assert.throws(() => assertMobileAdmission({ ...first, baseBytes: Buffer.concat([first.baseBytes, Buffer.from(' ')]) }), bad('MBM000_BASE_INPUT_CHANGED'));
  const canonical = JSON.parse(first.canonicalBytes.toString('utf8')); canonical.components.schemas.Error.$ref = 'https://example.invalid/schema';
  assert.throws(() => assertMobileAdmission({ ...first, canonicalBytes: Buffer.from(JSON.stringify(canonical)) }), bad('MBM000_REMOTE_SCHEMA_REF'));
});

test('40操作不能被同数量的更名、换method或新增path替代', () => {
  const first = admission(), original = JSON.parse(first.canonicalBytes.toString('utf8'));
  const row = first.lock.operations[0], canonical = clone(original);
  canonical.paths[row.path][row.method.toLowerCase()].operationId += 'Changed';
  assert.throws(() => assertMobileAdmission({ ...first, canonicalBytes: Buffer.from(JSON.stringify(canonical)) }), bad('MBM000_CANONICAL_OPERATION_CHANGED'));
  const moved = clone(original); moved.paths[row.path].post = moved.paths[row.path].get; delete moved.paths[row.path].get;
  assert.throws(() => assertMobileAdmission({ ...first, canonicalBytes: Buffer.from(JSON.stringify(moved)) }), bad('MBM000_CANONICAL_OPERATION_CHANGED'));
});

test('仅HEAD采纳200的D2差异允许，其它成功码或未声明差异拒绝', () => {
  const first = admission(), canonical = JSON.parse(first.canonicalBytes.toString('utf8'));
  const adoption = { successStatusDifferences: [{ operationId: 'headMediaAsset', inputSuccessStatusCodes: [200, 206],
    adoptedSuccessStatusCodes: [200], decision: 'D2', reason: 'HEAD完整响应不使用206。' }] };
  assert.equal(assertMobileSuccessStatusCodes(canonical, first.lock, adoption).unchangedOperations, 39);
  assert.throws(() => assertMobileSuccessStatusCodes(canonical, first.lock, { successStatusDifferences: [] }), bad('MBM000_CANONICAL_SUCCESS_STATUS_CHANGED'));
  const changed = clone(canonical), row = first.lock.operations[0]; changed.paths[row.path][row.method.toLowerCase()].responses['201'] = { description: '受控漂移' };
  assert.throws(() => assertMobileSuccessStatusCodes(changed, first.lock, adoption), bad('MBM000_CANONICAL_SUCCESS_STATUS_CHANGED'));
});

test('四明确嵌套文件和完整唯一caseNames准入，缺test、extrafixture或猜40计数拒绝', () => {
  const value = testScope(), execution = { gateBudgets: clone(MOBILE_GATE_BUDGETS) };
  assert.equal(assertMobileTestScope(value, execution, MOBILE_TEST_FILES, MOBILE_FIXTURE_FILES).expectedTests, 2);
  assert.throws(() => assertMobileTestScope(value, execution, MOBILE_TEST_FILES.slice(1), MOBILE_FIXTURE_FILES), bad('MBM000_TEST_SCOPE_NOT_FROZEN'));
  assert.throws(() => assertMobileTestScope(value, execution, MOBILE_TEST_FILES, [...MOBILE_FIXTURE_FILES, 'unexpected.ts']), bad('MBM000_TEST_SCOPE_NOT_FROZEN'));
  assert.throws(() => assertMobileTestScope({ ...value, expectedTests: 40 }, execution, MOBILE_TEST_FILES, MOBILE_FIXTURE_FILES), bad('MBM000_TEST_SCOPE_NOT_FROZEN'));
  assert.throws(() => assertMobileTestScope({ ...value, caseNames: [fullNames[0], fullNames[0]] }, execution, MOBILE_TEST_FILES, MOBILE_FIXTURE_FILES), bad('MBM000_TEST_SCOPE_NOT_FROZEN'));
});

test('本域120秒stage和360秒总预算必须完整原值，不借旧013预算或增加上限', () => {
  const value = testScope();
  for (const key of Object.keys(MOBILE_GATE_BUDGETS)) {
    const gateBudgets = { ...MOBILE_GATE_BUDGETS, [key]: MOBILE_GATE_BUDGETS[key] + 1 };
    assert.throws(() => assertMobileTestScope({ ...value, gateBudgets }, { gateBudgets }, MOBILE_TEST_FILES, MOBILE_FIXTURE_FILES), bad('MBM000_GATE_BUDGET_NOT_FROZEN'));
  }
  assert.throws(() => assertMobileTestScope(value, {}, MOBILE_TEST_FILES, MOBILE_FIXTURE_FILES), bad('MBM000_GATE_BUDGET_NOT_FROZEN'));
});

test('schema manifest核wholebody引用、两份真实hash和三种版本，拒projection、remote与重复', () => {
  const value = schemaFixture();
  assert.equal(assertMobileSchemaFixtureManifest(value.adoption, value.manifest, value.canonicalBytes, value.manifestBytes, value.canonical).length, 2);
  assert.throws(() => assertMobileSchemaFixtureManifest(value.adoption, value.manifest, Buffer.concat([value.canonicalBytes, Buffer.from(' ')]), value.manifestBytes, value.canonical), bad('MBM000_CANONICAL_PIN_CHANGED'));
  const changed = clone(value.manifest); changed.fixtures[0].path = 'packages/contracts/mobile/projected.json';
  const bytes = Buffer.from(JSON.stringify(changed)), adoption = { ...value.adoption, schemaFixtureManifest: pin(manifestFile, bytes) };
  assert.throws(() => assertMobileSchemaFixtureManifest(adoption, changed, value.canonicalBytes, bytes, value.canonical), bad('MBM000_SCHEMA_FIXTURE_MANIFEST_INVALID'));
  const duplicate = clone(value.manifest); duplicate.fixtures.push(duplicate.fixtures[0]);
  const duplicatedBytes = Buffer.from(JSON.stringify(duplicate));
  assert.throws(() => assertMobileSchemaFixtureManifest({ ...value.adoption, schemaFixtureManifest: pin(manifestFile, duplicatedBytes) }, duplicate,
    value.canonicalBytes, duplicatedBytes, value.canonical), bad('MBM000_SCHEMA_FIXTURE_MANIFEST_INVALID'));
  const wrongVersion = clone(value.canonical); wrongVersion.components.schemas.ServerInfo.properties.contractVersion.const = '1.0.0';
  assert.throws(() => assertMobileSchemaFixtureManifest(value.adoption, value.manifest, value.canonicalBytes, value.manifestBytes, wrongVersion), bad('MBM000_BASE_WIRE_VERSION_CHANGED'));
});

test('AJV真实执行UTF8字节与官方date-time/uri/date format，annotation不冒充业务事实', async t => {
  const directory = await owned(t), bodyDirectory = path.join(directory, 'packages/contracts/mobile/fixtures/bodies');
  mkdirSync(bodyDirectory, { recursive: true, mode: 0o700 });
  const rows = [{ name: 'a.json', schema: 'Text', value: '中文', valid: false },
    { name: 'b.json', schema: 'Text', value: 'abcd', valid: true },
    { name: 'c.json', schema: 'Moment', value: '2026-10-09T00:00:00Z', valid: true },
    { name: 'd.json', schema: 'Moment', value: '2026-99-99T00:00:00Z', valid: false },
    { name: 'e.json', schema: 'Uri', value: 'https://example.invalid/resource', valid: true },
    { name: 'f.json', schema: 'Uri', value: 'not a URI', valid: false },
    { name: 'g.json', schema: 'Day', value: '2026-02-30', valid: false }];
  for (const row of rows) writeFileSync(path.join(bodyDirectory, row.name), JSON.stringify(row.value), { flag: 'wx', mode: 0o600 });
  const canonical = { components: { schemas: { Text: { type: 'string', 'x-max-utf8-bytes': 4 }, Moment: { type: 'string', format: 'date-time' },
    Uri: { type: 'string', format: 'uri' }, Day: { type: 'string', format: 'date', 'x-trusted-capability': { note: '受控注释' } } } } };
  const result = await preflightMobileSchemas({ root: directory, canonical,
    fixtures: rows.map(row => ({ path: 'packages/contracts/mobile/fixtures/bodies/' + row.name, schemaRef: '#/components/schemas/' + row.schema, valid: row.valid })),
    require: createRequire(path.join(root, 'packages/contracts/package.json')), budgets: MOBILE_GATE_BUDGETS });
  assert.equal(result.success, true); assert.equal(result.testCountContribution, 0); assert.equal(result.externalSchemaFetch, false);
  assert.equal(result.utf8ByteKeywordActuallyValidated, true); assert.equal(result.fixtures.length, rows.length);
  assert.equal(result.engine.options.strict, true); assert.equal(result.engine.options.strictTypes, false); assert.equal(result.engine.options.strictRequired, false);
});

test('AJV普通未知keyword和缺失本地ref均失败，不网络补schema', async t => {
  const directory = await owned(t), require = createRequire(path.join(root, 'packages/contracts/package.json'));
  const parameters = { root: directory, fixtures: [], require, budgets: MOBILE_GATE_BUDGETS };
  await assert.rejects(preflightMobileSchemas({ ...parameters, canonical: { components: { schemas: { Bad: { type: 'string', unknownOrdinaryKeyword: true } } } } }), /unknown keyword/u);
  await assert.rejects(preflightMobileSchemas({ ...parameters, canonical: { components: { schemas: { Bad: { $ref: 'https://example.invalid/schema' } } } } }), bad('MBM000_SCHEMA_REF_NOT_LOCAL_COMPONENT'));
  await assert.rejects(preflightMobileSchemas({ ...parameters, canonical: { components: { schemas: { Bad: { $ref: '#/components/schemas/Missing' } } } } }), /reference/u);
});

test('只有完整TAP计划/六计数/唯一全部名称通过，重复summary和skip/todo均拒绝', () => {
  assert.equal(mobileStageSucceeded(behavior(tap())), true);
  assert.equal(mobileStageSucceeded(behavior(tap([...fullNames].reverse()))), true);
  for (const raw of [tap() + '# pass 2\n', tap().replace('# todo 0\n', ''), tap().replace('1..2\n', '1..1\n'),
    tap().replace('ok 1 -', 'not ok 1 -'), tap().replace('ok 1 - 受控合同甲', 'ok 1 - 受控合同甲 # SKIP'),
    tap().replace('ok 1 - 受控合同甲', 'ok 1 - 受控合同甲 # TODO'), tap([fullNames[0], fullNames[0]])]) {
    assert.equal(mobileStageSucceeded(behavior(raw)), false);
  }
});

test('exit0没有自然close仍失败，signal和任何捕获/终止错误不能被pass计数覆盖', () => {
  const result = behavior(tap());
  for (const changed of [{ closeObserved: false }, { exitCode: 1 }, { signal: 'SIGKILL' }, { timedOut: true },
    { overflow: true }, { captureFailed: true }, { preparationFailed: true }, { groupTerminationFailed: true }]) {
    assert.equal(mobileStageSucceeded({ ...result, ...changed }), false);
  }
  assert.equal(mobileStageSucceeded({ ...closed('mobile-contract-behavior'), expectedTests: null }), false);
});

test('受控进程完整stdout与stderr经实际close后才判成功并保存完整raw身份', async t => {
  const stage = { name: 'mobile-contract-behavior', args: [], expectedTests: 2, caseNames: fullNames };
  const { result, directory } = await captureControlled(t, stage, child => {
    child.stdout.emit('data', Buffer.from(tap())); child.emit('exit', 0, null);
    queueMicrotask(() => { child.stderr.emit('data', Buffer.from('受控诊断\n')); child.emit('close', 0, null); });
  });
  assert.equal(result.success, true); assert.equal(result.closeObserved, true); assert.equal(result.exitObserved, true);
  const bytes = readFileSync(path.join(directory, result.rawLog)); assert.equal(result.rawSha256, digest(bytes));
  assert.match(bytes.toString('utf8'), /受控诊断/u); assert.doesNotMatch(readFileSync(path.join(directory, result.log), 'utf8'), /受控诊断/u);
});

test('受控exit-only触发超时后自有组SIGKILL，不以已有完整TAP伪造close成功', async t => {
  const { result, kills } = await captureControlled(t, { name: 'mobile-contract-behavior', args: [], expectedTests: 2, caseNames: fullNames },
    child => { child.stdout.emit('data', Buffer.from(tap())); child.emit('exit', 0, null); }, { stageMs: 10 });
  assert.deepEqual(kills, [31415]); assert.equal(result.timedOut, true); assert.equal(result.success, false);
  assert.equal(result.signal, 'SIGKILL'); assert.equal(result.closeObserved, true);
});

test('受控raw超限和无法观察close均失败，截断prefix不称完整raw', async t => {
  const overflow = await captureControlled(t, { name: 'fresh-contracts-build', args: [] },
    child => child.stdout.emit('data', Buffer.alloc(128)), { rawBytes: 64 });
  assert.equal(overflow.result.overflow, true); assert.equal(overflow.result.rawCaptureComplete, false); assert.equal(overflow.result.success, false);
  const noClose = await captureControlled(t, { name: 'fresh-contracts-build', args: [] }, child => child.emit('exit', 0, null),
    { stageMs: 10, graceMs: 10, kill: () => {} });
  assert.equal(noClose.result.groupTerminationFailed, true); assert.equal(noClose.result.closeObserved, false); assert.equal(noClose.result.success, false);
});

test('真正完整FD读取拒绝symlink、超字节上限和捕获后内容变更', async t => {
  const directory = await owned(t), file = path.join(directory, 'owned.json'), link = path.join(directory, 'alias.json');
  writeFileSync(file, '{"value":1}', { flag: 'wx', mode: 0o600 }); symlinkSync(file, link);
  const actual = await readMobileFile(file), row = actual.identity;
  assert.match(actual.mtimeNs, /^-?\d+$/u);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { assert.equal(actual.mtimeNs, (await fd.stat({ bigint: true })).mtimeNs.toString()); }
  finally { await fd.close(); }
  assert.equal(await assertMobileArtifactClosure([row]), true);
  await assert.rejects(readMobileFile(link), bad('MBM000_FILE_NOT_CANONICAL'));
  await assert.rejects(readMobileFile(file, { maxBytes: 1 }), bad('MBM000_FILE_BUDGET_OR_KIND'));
  writeFileSync(file, '{"value":2}'); await assert.rejects(assertMobileArtifactClosure([row]), bad('MBM000_ARTIFACT_CHANGED'));
  await assert.rejects(assertMobileArtifactClosure([row, row]), bad('MBM000_ARTIFACT_CLOSURE_INVALID'));
});

test('默认拒空，只对manifest精确绑定的合法HTTP空body显式准入，不放宽未知source或产物', async t => {
  const directory = await owned(t), empty = path.join(directory, 'empty.bin'), source = path.join(directory, 'unknown.ts');
  writeFileSync(empty, Buffer.alloc(0), { flag: 'wx', mode: 0o600 }); writeFileSync(source, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  await assert.rejects(readMobileFile(empty), bad('MBM000_FILE_BUDGET_OR_KIND'));
  const actual = await readMobileFile(empty, { allowEmpty: true });
  assert.equal(actual.identity.bytes, 0); assert.equal(actual.identity.sha256, digest(Buffer.alloc(0)));
  const manifest = { schema: 'musicbridge.mobile.full-body-fixture-manifest.v1', bodyFiles: [
    { fileName: 'bodies/empty.bin', bytes: 0, sha256: digest(Buffer.alloc(0)), encoding: 'RAW_BINARY' },
  ] };
  assert.equal(mobileInputAllowsEmpty(MOBILE_EMPTY_FIXTURE_PATH, manifest), true);
  assert.equal(mobileInputAllowsEmpty('packages/contracts/src/unknown.ts', manifest), false);
  assert.equal(mobileInputAllowsEmpty(MOBILE_EMPTY_FIXTURE_PATH + '.unknown', manifest), false);
  await assert.rejects(readMobileFile(source, { allowEmpty: mobileInputAllowsEmpty('packages/contracts/src/unknown.ts', manifest) }), bad('MBM000_FILE_BUDGET_OR_KIND'));
  await assert.rejects(assertMobileArtifactClosure([actual.identity]), bad('MBM000_ARTIFACT_CLOSURE_INVALID'));
  for (const row of [{ ...manifest.bodyFiles[0], bytes: 1 }, { ...manifest.bodyFiles[0], sha256: digest('非空') },
    { ...manifest.bodyFiles[0], encoding: 'UTF8_JSON' }]) {
    assert.throws(() => mobileInputAllowsEmpty(MOBILE_EMPTY_FIXTURE_PATH, { ...manifest, bodyFiles: [row] }), bad('MBM000_EMPTY_BODY_NOT_DECLARED'));
  }
  assert.throws(() => mobileInputAllowsEmpty(MOBILE_EMPTY_FIXTURE_PATH, { ...manifest, bodyFiles: [] }), bad('MBM000_EMPTY_BODY_NOT_DECLARED'));
  assert.throws(() => mobileInputAllowsEmpty(MOBILE_EMPTY_FIXTURE_PATH, { ...manifest, bodyFiles: [...manifest.bodyFiles, ...manifest.bodyFiles] }), bad('MBM000_EMPTY_BODY_NOT_DECLARED'));
});

test('完整FD中途源字节漂移会拒绝，不把末尾当前版本拼成原快照', async t => {
  const directory = await owned(t), file = path.join(directory, 'owned.txt'); writeFileSync(file, '原字节', { flag: 'wx', mode: 0o600 });
  let observations = 0;
  await assert.rejects(readMobileFile(file, { check: () => { observations += 1; if (observations === 3) writeFileSync(file, '新且不同长度字节'); } }), bad('MBM000_FILE_CHANGED'));
});

test('编译闭包必须同自然compiler窗口的js/map/d.ts全三件，不接受旧mtime', async () => {
  const inputs = MOBILE_MODULES.map(name => ({ path: 'packages/contracts/src/' + name + '.ts', bytes: 5, sha256: digest(name) }));
  const inspect = async file => ({ identity: { file, bytes: 4, sha256: digest(file) }, mtimeMs: 150, mtimeNs: '150000000' });
  const output = await captureMobileCompilerOutputs(root, inputs, closed(), { budgets: MOBILE_GATE_BUDGETS }, inspect);
  assert.equal(output.length, 15); assert.equal(output.filter(row => row.relativePath.endsWith('.js.map')).length, 5);
  assert(output.every(row => row.mtimeNs === '150000000'));
  for (const mtimeMs of [99, 201]) await assert.rejects(captureMobileCompilerOutputs(root, inputs, closed(), { budgets: MOBILE_GATE_BUDGETS },
    async file => ({ ...await inspect(file), mtimeMs })), bad('MBM000_COMPILED_OUTPUT_NOT_FRESH'));
  await assert.rejects(captureMobileCompilerOutputs(root, inputs, { ...closed(), closeObserved: false }, { budgets: MOBILE_GATE_BUDGETS }, inspect), bad('MBM000_COMPILER_NOT_NATURALLY_CLOSED'));
  await assert.rejects(captureMobileCompilerOutputs(root, inputs, closed(), { budgets: MOBILE_GATE_BUDGETS },
    async file => ({ ...await inspect(file), mtimeNs: undefined })), bad('MBM000_COMPILED_STAT_INVALID'));
});

function consumption() {
  const artifacts = MOBILE_MODULES.flatMap(name => ['.js', '.js.map', '.d.ts'].map(suffix => ({
    file: path.join(root, 'packages/contracts/dist/' + name + suffix), relativePath: 'packages/contracts/dist/' + name + suffix,
    sourcePath: 'packages/contracts/src/' + name + '.ts', sourceSha256: digest(name), bytes: 4, sha256: digest(name + suffix), mtimeMs: 150, mtimeNs: '150000000',
  }))).sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const inputs = MOBILE_MODULES.map(name => ({ path: 'packages/contracts/src/' + name + '.ts', bytes: 4, sha256: digest(name) }));
  const binding = { head: 'a'.repeat(40), artifacts, inputs, artifactIdentity: mobileArtifactIdentity(artifacts) };
  const bindingBytes = Buffer.from(JSON.stringify(binding));
  const receipts = MOBILE_TEST_FILES.map(testFile => ({ schema: 'musicbridge.mbm000.contract-consumption.v1',
    testFile: testFile.slice('packages/contracts/'.length), head: binding.head, bindingSha256: digest(bindingBytes), artifactIdentity: binding.artifactIdentity,
    inputIdentity: mobileInputIdentity(inputs), artifacts: artifacts.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })),
    loadedModules: MOBILE_MODULES.map(name => 'packages/contracts/dist/' + name + '.js').sort() }));
  return { binding, bindingBytes, receipts };
}

test('四实际消费回执必须绑定同一fresh图/15件/5加载模块，单项或额外键不补齐', async () => {
  const value = consumption(); assert.equal(await assertMobileConsumption(value.receipts, value.binding, value.bindingBytes), true);
  await assert.rejects(assertMobileConsumption(value.receipts.slice(1), value.binding, value.bindingBytes), bad('MBM000_CONSUMPTION_INCOMPLETE'));
  const changed = clone(value.receipts); changed[0].head = 'b'.repeat(40);
  await assert.rejects(assertMobileConsumption(changed, value.binding, value.bindingBytes), bad('MBM000_CONSUMPTION_CHANGED'));
  const stale = clone(value.receipts); stale[0].bindingSha256 = digest('旧binding');
  await assert.rejects(assertMobileConsumption(stale, value.binding, value.bindingBytes), bad('MBM000_CONSUMPTION_CHANGED'));
  const missing = clone(value.receipts); missing[0].artifacts.pop();
  await assert.rejects(assertMobileConsumption(missing, value.binding, value.bindingBytes), bad('MBM000_CONSUMPTION_CHANGED'));
  const extra = clone(value.receipts); extra[0].runtimeService = 'PASS';
  await assert.rejects(assertMobileConsumption(extra, value.binding, value.bindingBytes), bad('MBM000_CONSUMPTION_CHANGED'));
  const src = clone(value.receipts); src[0].loadedModules[0] = 'packages/contracts/src/mobile-common.ts';
  await assert.rejects(assertMobileConsumption(src, value.binding, value.bindingBytes), bad('MBM000_CONSUMPTION_CHANGED'));
});

test('身份算法精确JS排序后映射bytes/hash，不把source路径或绝对机密路径掺入artifactIdentity', () => {
  const rows = [{ file: '/private/controlled/a', relativePath: 'z.js', bytes: 3, sha256: digest('z') },
    { file: '/private/controlled/b', relativePath: 'a.js', bytes: 2, sha256: digest('a') }];
  const expected = digest(JSON.stringify([rows[1], rows[0]].map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 }))));
  assert.equal(mobileArtifactIdentity(rows), expected); assert.equal(mobileArtifactIdentity([...rows].reverse()), expected);
  assert.equal(mobileInputIdentity([{ path: 'z', bytes: 3, sha256: digest('z') }, { path: 'a', bytes: 2, sha256: digest('a') }]),
    digest(JSON.stringify([{ path: 'a', bytes: 2, sha256: digest('a') }, { path: 'z', bytes: 3, sha256: digest('z') }])));
});
