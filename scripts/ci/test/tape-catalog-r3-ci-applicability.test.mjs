import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TAPE_CATALOG_R3_CI_SCOPE, validateTapeCatalogCiAdmission, inspectTapeCatalogCiAdmission,
} from '../tape-catalog-r3-ci-applicability.mjs';
import {
  inspectMbm003PredecessorReuse, predecessorReuseWorkflowOutputs,
} from '../mbm003-predecessor-reuse.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tapeBranch = 'codex/tape-catalog-r3-import';
const mobileBranch = 'codex/mbm-003-lossless-dsd-transport';
const productBase = 'c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95';
const productSource = 'ff02c6b2fd248748fe7d461259f5749dda86fa0c';
const productReport = '799fece27f0cfe056a56fd6258f0db380db3461e';
const predecessorSource = '7ec898d9f26cbafb5e01f5483bfaccf14ca61d27';
const predecessorReport = 'd5189ecba0aaf266e7fa375613a7a99beffabc2e';
const predecessorBase = 'b1a8de728086e7994bb69d7dee10782f646886dd';
const scopePath = 'docs/tape-catalog-r3/EXECUTION_SCOPE.json';
const ciScopePath = 'docs/tape-catalog-r3/CI_SCOPE.json';
const workflowPath = '.github/workflows/verify.yml';
const receiptPath = 'docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json';
const allowedCiFiles = [workflowPath, 'scripts/ci/mbm003-predecessor-reuse.mjs',
  'scripts/ci/tape-catalog-r3-ci-applicability.mjs', 'scripts/ci/test/tape-catalog-r3-ci-applicability.test.mjs',
  ciScopePath, 'docs/tape-catalog-r3/CI_APPLICABILITY.md'];
const sourceHead = 'e'.repeat(40), finalHead = 'f'.repeat(40);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalScope = readFileSync(path.join(repository, scopePath));
const ciBytes = () => Buffer.from(JSON.stringify(TAPE_CATALOG_R3_CI_SCOPE));

/** 完整真实Scope字节配合受控Git事实；本测试不执行软件Gate或改写仓库。 */
function fixture() {
  const changes = [
    { path: 'scripts/ci/tape-catalog-r3-ci-applicability.mjs', status: 'A', oldMode: '000000', newMode: '100644' },
    { path: 'scripts/ci/mbm003-predecessor-reuse.mjs', status: 'M', oldMode: '100644', newMode: '100644' },
  ];
  return {
    branch: tapeBranch, head: finalHead, stableHead: finalHead, branchAfter: tapeBranch,
    scopeBytes: Buffer.from(originalScope), ciScopeBytes: ciBytes(), workflowBytes: readFileSync(path.join(repository, workflowPath)),
    sourceParents: [productBase], reportParents: [productSource],
    commits: [{ sha: sourceHead, parents: [productReport], changes: [{ ...changes[0] }] },
      { sha: finalHead, parents: [sourceHead], changes: [{ ...changes[1] }] }],
    changes,
    clean: true, cleanAfter: true,
  };
}
function rejects(input) {
  assert.throws(() => validateTapeCatalogCiAdmission(input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /[\u4e00-\u9fff]/u, '公开准入失败必须给出中文错误');
    return true;
  });
}
function rejectMutations(operations) {
  for (const operation of operations) { const input = fixture(); operation(input); rejects(input); }
}

/** 注入Git仅描述受控提交事实；收据、Scope和冻结文件仍逐个读取真实完整字节。 */
function ioFixture(input = fixture(), { readOverrides = {}, gitOverrides = {}, late = {} } = {}) {
  const reads = [], calls = [];
  let headReads = 0, statusReads = 0, predecessorAncestorRead = false;
  const read = file => {
    const absolute = path.isAbsolute(file) ? file : path.join(repository, file);
    const relative = path.relative(repository, absolute).split(path.sep).join('/');
    reads.push(relative);
    const bytes = readFileSync(absolute);
    return Object.hasOwn(readOverrides, relative) ? readOverrides[relative](Buffer.from(bytes)) : bytes;
  };
  const git = args => {
    calls.push([...args]); const key = JSON.stringify(args);
    if (Object.hasOwn(gitOverrides, key)) return gitOverrides[key]();
    if (key === JSON.stringify(['rev-parse', 'HEAD'])) {
      if (predecessorAncestorRead && late.head !== undefined) { headReads++; return late.head; }
      return headReads++ === 0 ? input.head : input.stableHead;
    }
    if (key === JSON.stringify(['branch', '--show-current']))
      return predecessorAncestorRead && late.branch !== undefined ? late.branch : headReads >= 2 ? input.branchAfter : input.branch;
    if (key === JSON.stringify(['status', '--porcelain=v1', '--untracked-files=all']))
      return predecessorAncestorRead && late.dirty ? ' M apps/desktop/src/main/index.ts'
        : (statusReads++ === 0 ? input.clean : input.cleanAfter) ? '' : ' M apps/desktop/src/main/index.ts';
    if (key === JSON.stringify(['rev-list', '--parents', '-n', '1', productSource])) return [productSource, ...input.sourceParents].join(' ');
    if (key === JSON.stringify(['rev-list', '--parents', '-n', '1', productReport])) return [productReport, ...input.reportParents].join(' ');
    if (key === JSON.stringify(['rev-list', '--parents', '-n', '1', predecessorReport])) return `${predecessorReport} ${predecessorSource}`;
    if (key === JSON.stringify(['merge-base', '--is-ancestor', predecessorBase, 'HEAD'])) { predecessorAncestorRead = true; return ''; }
    if (key === JSON.stringify(['rev-list', '--parents', '--reverse', '--topo-order', `${productReport}..HEAD`]))
      return input.commits.map(row => [row.sha, ...row.parents].join(' ')).join('\n');
    const diffPrefix = ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
    if (JSON.stringify(args.slice(0, 6)) === JSON.stringify(diffPrefix)) {
      const rows = args[6] === productReport && args[7] === 'HEAD' ? input.changes
        : input.commits.find(row => row.parents[0] === args[6] && row.sha === args[7])?.changes;
      if (rows) return rows.map(row => `:${row.oldMode} ${row.newMode} ${row.status === 'A' ? '0'.repeat(40) : '1'.repeat(40)} ${'2'.repeat(40)} ${row.status}\0${row.path}\0`).join('');
    }
    throw new Error(`测试未声明此Git读取：${key}`);
  };
  return { read, git, reads, calls, env: {} };
}
const jsonChange = operation => bytes => { const value = JSON.parse(bytes); operation(value); return Buffer.from(JSON.stringify(value)); };

test('Tape完整真实Scope与线性CI提交可准入，执行身份和当前003及完整verify义务分别保留', () => {
  assert.equal(sha(originalScope), '7fc8edf02cb64cdb91c286b9180ed13f1ab7878eb5c17c8d35ba37b56da368d4');
  const input = fixture(), before = fixture();
  const result = validateTapeCatalogCiAdmission(input);
  assert.equal(result.task, 'TAPE-CATALOG-R3');
  assert.equal(result.currentMobileTask, 'MBM-003');
  assert.equal(result.fullVerifyRequired, true);
  assert.equal(result.current003SoftwareGateRequired, true);
  assert.equal(result.historicalGateMode, 'EXACT_FROZEN_PREDECESSOR_REUSE');
  assert.equal(result.productSourceSha, productSource);
  assert.equal(result.productReportSha, productReport);
  assert.deepEqual(input, before);
  assert.throws(() => predecessorReuseWorkflowOutputs(result), '单独Tape准入不能代替原前序凭证核验');
});

test('精确CI声明绑定独立产品基线、原Scope和修复workflow，只有六个明确文件可改', () => {
  assert.deepEqual(TAPE_CATALOG_R3_CI_SCOPE, {
    schema: 'musicbridge.tape-catalog-r3.ci-scope.v1', taskId: 'TAPE-CATALOG-R3', branch: tapeBranch,
    baseSha: productBase, productSourceSha: productSource, productReportSha: productReport,
    originalScopeSha256: '7fc8edf02cb64cdb91c286b9180ed13f1ab7878eb5c17c8d35ba37b56da368d4',
    verifyWorkflowSha256: '18c8ad0a6289833a58ccbcd94b04622a6e6d7ff53164015a125079d72236330d',
    currentMobileTask: 'MBM-003', allowedCiFiles, fullVerifyRequired: true,
    currentMobileSoftwareGateRequired: true, historicalGateMode: 'EXACT_FROZEN_PREDECESSOR_REUSE',
    productSourceChangesAllowed: false, productionImportAuthorized: false, ownerAppModificationAuthorized: false,
  });
  for (const name of allowedCiFiles) {
    const input = fixture();
    input.changes = [{ path: name, status: 'M', oldMode: '100644', newMode: '100644' }];
    assert.equal(validateTapeCatalogCiAdmission(input).task, 'TAPE-CATALOG-R3');
  }
});

test('未知分支和近似Tape名称不能借继承003双表取得Tape准入', () => {
  for (const branch of ['', mobileBranch, 'codex/unknown', `${tapeBranch}-extra`, `${tapeBranch}\n`]) {
    const input = fixture(); input.branch = branch; input.branchAfter = branch; rejects(input);
  }
});

test('原Scope同长度等价JSON字节变更仍拒绝，不能只核解析后任务名称', () => {
  const equivalent = fixture(), at = equivalent.scopeBytes.indexOf(0x20);
  assert.ok(at >= 0);
  equivalent.scopeBytes[at] = 0x09;
  assert.equal(equivalent.scopeBytes.length, originalScope.length);
  assert.deepEqual(JSON.parse(equivalent.scopeBytes), JSON.parse(originalScope));
  rejects(equivalent);
  const changed = fixture(), scope = JSON.parse(changed.scopeBytes);
  scope.baseSha = '0'.repeat(40); changed.scopeBytes = Buffer.from(JSON.stringify(scope)); rejects(changed);
  rejectMutations([
    input => { input.scopeBytes = Buffer.concat([input.scopeBytes, Buffer.from('\n')]); },
    input => { input.scopeBytes = input.scopeBytes.subarray(0, input.scopeBytes.length - 1); },
    input => { input.scopeBytes = Buffer.from('{"taskId":"TAPE-CATALOG-R3"}'); },
  ]);
});

test('CI声明必须是完整精确逻辑对象，新增字段和缺失声明不能生成宽泛豁免', () => {
  rejectMutations([
    input => { input.ciScopeBytes = Buffer.from(JSON.stringify({ ...TAPE_CATALOG_R3_CI_SCOPE, allowAllFiles: true })); },
    input => { input.ciScopeBytes = Buffer.from('{}'); },
    input => { input.ciScopeBytes = Buffer.from('null'); },
    input => { input.ciScopeBytes = Buffer.from('[]'); },
    input => { input.ciScopeBytes = Buffer.from('{'); },
  ]);
});

test('workflow核完整修复后字节，旧workflow或同长度漂移不能偷偷关闭verify及当前003 Gate', () => {
  const input = fixture();
  assert.equal(sha(input.workflowBytes), TAPE_CATALOG_R3_CI_SCOPE.verifyWorkflowSha256);
  const before = execFileSync('git', ['show', `${productReport}:${workflowPath}`], {
    cwd: repository, maxBuffer: 1024 * 1024,
  });
  assert.equal(sha(before), 'f37a88bd97a7906514bf91a899efc9f6d4802162b567d5b033a3714666b8ad71');
  input.workflowBytes = before; rejects(input);
  const changed = fixture(), bytes = Buffer.from(changed.workflowBytes);
  bytes[0] ^= 1; changed.workflowBytes = bytes; rejects(changed);
  rejectMutations([
    value => { value.workflowBytes = Buffer.concat([value.workflowBytes, Buffer.from('\n')]); },
    value => { value.workflowBytes = Buffer.from('name: verify\n'); },
  ]);
});

test('产品Source必须直接来自固定base，产品R必须是Source唯一直接子提交', () => {
  rejectMutations([
    input => { input.sourceParents = ['0'.repeat(40)]; },
    input => { input.sourceParents = []; },
    input => { input.sourceParents.push(predecessorBase); },
    input => { input.reportParents = [productBase]; },
    input => { input.reportParents = []; },
    input => { input.reportParents.push(predecessorReport); },
  ]);
});

test('R之后CI链须完整唯一线性连接到当前head，错误父链与合并均拒绝', () => {
  rejectMutations([
    input => { input.commits[0].parents = [productSource]; },
    input => { input.commits[1].parents = [productReport]; },
    input => { input.commits[1].parents.push(productReport); },
    input => { input.commits[0].parents = []; },
    input => { input.commits.reverse(); },
    input => { input.commits.pop(); },
    input => { input.commits = []; },
    input => { input.head = productReport; input.stableHead = productReport; },
    input => { input.commits[1].sha = sourceHead; input.head = sourceHead; input.stableHead = sourceHead; },
    input => { input.commits[0].sha += '\n'; },
    input => { input.head = 'unknown'; input.stableHead = 'unknown'; },
  ]);
});

test('累计diff看似只改CI也不能掩盖逐提交产品改后撤回，空提交或逐提交删除同样拒绝', () => {
  rejectMutations([
    input => { input.commits[0].changes[0].path = 'apps/desktop/src/main/index.ts'; },
    input => { input.commits[1].changes[0].status = 'D'; },
    input => { input.commits[1].changes = []; },
    input => { delete input.commits[0].changes; },
  ]);
});

test('CI提交链总预算有界，不能以更多准许文件提交绕过读取上限', () => {
  const input = fixture(); let previous = productReport;
  input.commits = Array.from({ length: 33 }, (_, index) => {
    const sha = (index + 1).toString(16).padStart(40, '0');
    const row = { sha, parents: [previous], changes: [{ ...input.changes[1] }] };
    previous = sha; return row;
  });
  input.head = previous; input.stableHead = previous; rejects(input);
});

test('CI补丁不能触及产品、003合同、共享账本或未登记CI文件，危险路径也拒绝', () => {
  for (const name of [
    'apps/desktop/src/main/index.ts', 'packages/bridge-core/src/collection/cassette-archive.ts',
    'packages/contracts/mobile/openapi.json', 'project/STATUS.json', 'docs/postrust/MBM-003/EXECUTION_SCOPE.json',
    scopePath, 'scripts/ci/unapproved.mjs', '../scripts/ci/mbm003-predecessor-reuse.mjs',
    '/scripts/ci/mbm003-predecessor-reuse.mjs', 'scripts\\ci\\mbm003-predecessor-reuse.mjs',
    'scripts/ci/./mbm003-predecessor-reuse.mjs', 'scripts/ci/mbm003-predecessor-reuse.mjs\0',
  ]) {
    const input = fixture(); input.changes[0].path = name; rejects(input);
  }
  const empty = fixture(); empty.changes = []; rejects(empty);
});

test('仅准新增或修改普通文件，删除重命名执行位和错误旧mode不能混入CI补丁', () => {
  for (const status of ['D', 'R100', 'C100', 'T', 'U', '']) {
    const input = fixture(); input.changes[0].status = status; rejects(input);
  }
  rejectMutations([
    input => { input.changes[0].oldMode = '100644'; },
    input => { input.changes[1].oldMode = '000000'; },
    input => { input.changes[0].newMode = '100755'; },
    input => { input.changes[1].oldMode = '120000'; },
    input => { input.changes[1].newMode = '120000'; },
    input => { input.changes.push({ ...input.changes[0] }); },
  ]);
});

test('dirty状态与读取前后head或分支漂移拒绝，不能绑定到另一次工作树', () => {
  rejectMutations([
    input => { input.clean = false; }, input => { input.cleanAfter = false; },
    input => { input.stableHead = sourceHead; },
    input => { input.branchAfter = mobileBranch; },
    input => { input.branchAfter = ''; },
  ]);
});

test('hosted准入必须绑定runner的SHA和分支，缺失与不一致不能借本地事实补位', () => {
  const input = fixture();
  Object.assign(input, { runnerRequired: true, githubHead: finalHead, githubBranch: tapeBranch });
  assert.equal(validateTapeCatalogCiAdmission(input).task, 'TAPE-CATALOG-R3');
  for (const operation of [
    value => { delete value.githubHead; }, value => { delete value.githubBranch; },
    value => { value.githubHead = sourceHead; }, value => { value.githubBranch = mobileBranch; },
  ]) { const value = { ...fixture(), runnerRequired: true, githubHead: finalHead, githubBranch: tapeBranch }; operation(value); rejects(value); }
});

test('workflow输出不接受未知执行身份或缺失当前003义务，不把准入结果伪装成Gate通过', () => {
  const result = inspectMbm003PredecessorReuse(repository, {}, ioFixture());
  for (const value of [null, {}, { ...result, task: 'unknown' }, { ...result, current003SoftwareGateRequired: false },
    { ...result, current003SoftwareGateRequired: undefined }, { ...result, currentMobileTask: 'MBM-002' },
    { ...result, oldGateEvidenceReused: false }, { ...result, parallelBranchAdmission: undefined },
    { ...result, parallelBranchAdmission: { ...result.parallelBranchAdmission, current003SoftwareGateRequired: false } }]) {
    assert.throws(() => predecessorReuseWorkflowOutputs(value));
  }
  assert.deepEqual(predecessorReuseWorkflowOutputs({ task: 'legacy', oldGateEvidenceReused: false }), {
    task: 'legacy', mobileTask: 'legacy', legacyGateMode: 'run',
  });
});

test('真实Tape适配器完整读取Scope与workflow，解析Git父链和raw补丁后仍要求当前003及完整verify', () => {
  const io = ioFixture(), result = inspectTapeCatalogCiAdmission(repository, tapeBranch, io);
  assert.equal(result.task, 'TAPE-CATALOG-R3');
  assert.equal(result.fullVerifyRequired, true);
  assert.equal(result.current003SoftwareGateRequired, true);
  for (const name of [scopePath, ciScopePath, workflowPath]) assert.ok(io.reads.includes(name), `未完整读取${name}`);
  assert.equal(io.calls.filter(args => JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD'])).length, 2);
  assert.equal(io.calls.filter(args => args[0] === 'status').length, 2);
  assert.throws(() => predecessorReuseWorkflowOutputs(result), '读取Tape范围不能跳过原003冻结检查');
});

test('真实Tape适配器不丢raw删除或危险路径，读取后dirty与head漂移也拒绝', () => {
  for (const operation of [
    input => { input.changes[0].status = 'D'; },
    input => { input.changes[0].path = 'apps/desktop/src/main/index.ts'; },
    input => { input.changes[0].path = '../scripts/ci/mbm003-predecessor-reuse.mjs'; },
    input => { input.stableHead = sourceHead; },
    input => { input.branchAfter = mobileBranch; },
    input => { input.cleanAfter = false; },
    input => { input.commits[0].changes[0].path = 'apps/desktop/src/main/index.ts'; },
  ]) {
    const input = fixture(); operation(input);
    assert.throws(() => inspectTapeCatalogCiAdmission(repository, tapeBranch, ioFixture(input)));
  }
});

test('真实适配器拒绝未闭合或不合法的Git raw记录，不跳过解析失败的变更', () => {
  const read = JSON.stringify(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', productReport, 'HEAD']);
  const header = `:000000 100644 ${'0'.repeat(40)} ${'2'.repeat(40)} A`;
  for (const raw of ['unexpected', `${header}\0scripts/ci/tape-catalog-r3-ci-applicability.mjs`,
    `${header}\0`, `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} R100\0${workflowPath}\0`]) {
    const io = ioFixture(fixture(), { gitOverrides: { [read]: () => raw } });
    assert.throws(() => inspectTapeCatalogCiAdmission(repository, tapeBranch, io));
  }
});

test('hosted真实适配器接受固定runner身份，不能缺失或改用别的源码SHA和分支', () => {
  const io = ioFixture();
  Object.assign(io.env, { GITHUB_ACTIONS: 'true', GITHUB_SHA: finalHead, GITHUB_REF_NAME: tapeBranch });
  assert.equal(inspectTapeCatalogCiAdmission(repository, tapeBranch, io).task, 'TAPE-CATALOG-R3');
  for (const operation of [
    env => { delete env.GITHUB_SHA; }, env => { delete env.GITHUB_REF_NAME; },
    env => { env.GITHUB_SHA = sourceHead; }, env => { env.GITHUB_REF_NAME = mobileBranch; },
  ]) {
    const changed = ioFixture();
    Object.assign(changed.env, { GITHUB_ACTIONS: 'true', GITHUB_SHA: finalHead, GITHUB_REF_NAME: tapeBranch });
    operation(changed.env);
    assert.throws(() => inspectTapeCatalogCiAdmission(repository, tapeBranch, changed));
  }
});

test('Tape继承003双表时真实前序核验仍逐个读取全部冻结凭证，执行身份不会被写成003', () => {
  const io = ioFixture(), result = inspectMbm003PredecessorReuse(repository, {}, io);
  assert.equal(result.task, 'TAPE-CATALOG-R3');
  assert.equal(result.currentMobileTask, 'MBM-003');
  assert.equal(result.parallelBranchAdmission.fullVerifyRequired, true);
  assert.equal(result.parallelBranchAdmission.current003SoftwareGateRequired, true);
  assert.equal(result.current003SoftwareGateRequired, true);
  assert.equal(result.oldGateEvidenceReused, true);
  assert.equal(result.current003AppDeviceOwnerProven, false);
  const receipt = JSON.parse(readFileSync(path.join(repository, receiptPath)));
  assert.ok(io.reads.includes(receiptPath));
  for (const pin of receipt.frozenFiles) assert.ok(io.reads.includes(pin.path), `未核原冻结文件${pin.path}`);
  assert.ok(io.calls.some(args => JSON.stringify(args) === JSON.stringify(['merge-base', '--is-ancestor', predecessorBase, 'HEAD'])));
  assert.deepEqual(predecessorReuseWorkflowOutputs(result), {
    task: 'TAPE-CATALOG-R3', mobileTask: 'MBM-003', legacyGateMode: 'reuse-frozen',
  });
});

test('003原分支保持真实严格正例与原workflow输出，不要求Tape准入也不放宽003检查', () => {
  const input = fixture(); input.branch = mobileBranch; input.branchAfter = mobileBranch;
  const io = ioFixture(input), result = inspectMbm003PredecessorReuse(repository, {}, io);
  assert.equal(result.task, 'MBM-003');
  assert.equal(result.oldGateEvidenceReused, true);
  assert.equal(result.current003SoftwareGateRequired, true);
  assert.equal(result.current003AppDeviceOwnerProven, false);
  assert.equal(io.reads.includes(scopePath), false);
  assert.equal(io.calls.some(args => args.includes(productSource)), false);
  assert.deepEqual(predecessorReuseWorkflowOutputs(result), {
    task: 'MBM-003', mobileTask: 'MBM-003', legacyGateMode: 'reuse-frozen',
  });
});

test('继承003资料的未知分支仍拒绝，不会借Tape入口回落到legacy', () => {
  for (const branch of ['codex/unknown', `${tapeBranch}-extra`, `${mobileBranch}-extra`]) {
    const input = fixture(); input.branch = branch; input.branchAfter = branch;
    assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, ioFixture(input)));
  }
});

test('Tape三个003selector及双表必须全部一致，任一缺失或漂移不能触发legacy早退', () => {
  const overrides = [
    ['project/STATUS.json', value => { delete value.currentMobileTask; }],
    ['project/STATUS.json', value => { value.mobileFrontloading20261008.currentTask = 'MBM-002'; }],
    ['project/POSTRUST_PLAN.json', value => { value.execution_schedule.current_task = 'MBM-004'; }],
    ['project/STATUS.json', value => { value.mobileLosslessDsdTransport.baseSha = productBase; }],
    ['project/POSTRUST_PLAN.json', value => { value.mobile_tasks.find(row => row.id === 'MBM-003').scope_ref = scopePath; }],
  ];
  for (const [name, operation] of overrides) {
    const io = ioFixture(fixture(), { readOverrides: { [name]: jsonChange(operation) } });
    assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io));
  }
  const io = ioFixture(fixture(), { readOverrides: {
    'project/STATUS.json': jsonChange(value => { value.currentMobileTask = 'none'; value.mobileFrontloading20261008.currentTask = 'none'; }),
    'project/POSTRUST_PLAN.json': jsonChange(value => { value.execution_schedule.current_task = 'none'; }),
  } });
  assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io));
});

test('原003分支authority和双表仍严格绑定旧base与scope，Tape新增准入不扩大旧分支权限', () => {
  for (const [name, operation] of [
    ['project/STATUS.json', value => { value.mobileLosslessDsdTransport.baseSha = productBase; }],
    ['project/STATUS.json', value => { value.mobileLosslessDsdTransport.branch = tapeBranch; }],
    ['project/POSTRUST_PLAN.json', value => { value.mobile_tasks.find(row => row.id === 'MBM-003').scope_ref = scopePath; }],
    ['project/POSTRUST_PLAN.json', value => { value.mobile_tasks.push({ ...value.mobile_tasks.find(row => row.id === 'MBM-003') }); }],
  ]) {
    const input = fixture(); input.branch = mobileBranch; input.branchAfter = mobileBranch;
    const io = ioFixture(input, { readOverrides: { [name]: jsonChange(operation) } });
    assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io));
  }
});

test('Tape在原b1祖先核验之后才发生HEAD、分支或dirty变化，外层最后回读仍必须拒绝', () => {
  const ancestorRead = JSON.stringify(['merge-base', '--is-ancestor', predecessorBase, 'HEAD']);
  for (const late of [{ head: sourceHead }, { branch: mobileBranch }, { dirty: true }]) {
    const io = ioFixture(fixture(), { late });
    assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io), /完整前序检查期间漂移/u);
    const at = io.calls.findIndex(args => JSON.stringify(args) === ancestorRead);
    assert.ok(at >= 0, '迟到漂移必须发生在旧前序祖先检查之后');
    assert.ok(io.calls.slice(at + 1).some(args => JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD'])), '完整旧前序核验之后仍须回读HEAD');
  }
});

test('原收据和任一冻结文件破坏均在Tape及003原分支拒绝，不能因新准入而跳过', () => {
  const receipt = JSON.parse(readFileSync(path.join(repository, receiptPath)));
  for (const branch of [tapeBranch, mobileBranch]) {
    for (const name of [receiptPath, ...receipt.frozenFiles.map(pin => pin.path)]) {
      const input = fixture(); input.branch = branch; input.branchAfter = branch;
      const io = ioFixture(input, { readOverrides: { [name]: bytes => { bytes[0] ^= 1; return bytes; } } });
      assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io));
    }
    const input = fixture(); input.branch = branch; input.branchAfter = branch;
    const io = ioFixture(input, { readOverrides: {
      'docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json': jsonChange(value => { value.macDirectSoftwareReport = productReport; }),
    } });
    assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io));
  }
});

test('原003前序R仍须唯一直接父提交且前序base必须是祖先，Tape准入不覆盖这些检查', () => {
  for (const branch of [tapeBranch, mobileBranch]) {
    const input = fixture(); input.branch = branch; input.branchAfter = branch;
    const reportRead = JSON.stringify(['rev-list', '--parents', '-n', '1', predecessorReport]);
    for (const parents of [[productSource], [predecessorSource, productBase], []]) {
      const io = ioFixture(input, { gitOverrides: { [reportRead]: () => [predecessorReport, ...parents].join(' ') } });
      assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io));
    }
    const ancestorRead = JSON.stringify(['merge-base', '--is-ancestor', predecessorBase, 'HEAD']);
    const io = ioFixture(input, { gitOverrides: { [ancestorRead]: () => { throw new Error('原前序base不是当前提交祖先。'); } } });
    assert.throws(() => inspectMbm003PredecessorReuse(repository, {}, io));
  }
});
