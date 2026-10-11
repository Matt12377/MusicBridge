import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTapeCatalogCommonAdmission, inspectTapeCatalogCommonAdmission, readTapeCatalogCommonWhole,
  tapeCatalogCommonWorkflowOutputs,
} from '../tape-catalog-common-admission.mjs';

// 只读冻结Git对象和合成提交事实；这些案例不执行软件Gate、生产导入、App或手机验收。
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const task = 'TAPE-CATALOG-R3-COMMON';
const branch = 'codex/tape-catalog-common-baseline';
const base = 'c647e02b40d55b955faabc9d6a2a6220c9286bac';
const fixSource = 'fd176fdf1da069dd678b673f697cdbe8831628cc';
const tapeSource = 'ff02c6b2fd248748fe7d461259f5749dda86fa0c';
const tapeReport = '799fece27f0cfe056a56fd6258f0db380db3461e';
const tapeFinal = 'cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f';
const tapeBase = 'c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95';
const originalSource = '5e96372f0dd99e08b1e2964d68ce234eb438bbdf';
const originalReport = '99c89519f3357f4018b32930e8179b66719f99e7';
const scopePath = 'docs/tape-catalog-common/EXECUTION_SCOPE.json';
const statusPath = 'docs/tape-catalog-common/STATUS.json';
const sourceHead = 'a'.repeat(40), reportHead = 'b'.repeat(40);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
// 前序正负例读取封存的真实479 Git全文；本轮004共享接线不替换前序作者的原pins。
const whole = name => git(['show', `479e746bb7106a4dac158fe616290220de03a53a:${name}`]);
const git = args => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
  cwd: repository, maxBuffer: 16 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
});
const gitContent = gitRef => git(['show', gitRef]);
const clone = value => {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
};
const jsonBytes = value => Buffer.from(JSON.stringify(value));
const mutateJson = (bytes, operation) => {
  const value = JSON.parse(bytes); operation(value); return jsonBytes(value);
};
const corruptSameLength = bytes => {
  const result = Buffer.from(bytes); result[result.length - 1] ^= 1; return result;
};
const readCommitParents = commit => {
  const [actual, ...parents] = git(['rev-list', '--parents', '-n', '1', commit]).toString('utf8').trim().split(/\s+/u);
  assert.equal(actual, commit, '正例必须来自指定的真实Git提交'); return parents;
};

function rejected(input, code, label = '该变异应被共同基线准入拒绝') {
  assert.throws(() => assertTapeCatalogCommonAdmission(input), error => {
    assert.ok(error instanceof Error, label);
    assert.match(error.message, /[\u4e00-\u9fff]/u, '准入错因必须使用中文');
    assert.match(error.code ?? '', /^TAPE_COMMON_/u, '准入失败必须有共同任务的明确错误码');
    if (code !== undefined) assert.equal(error.code, code, label);
    return true;
  }, label);
}

function rejectMutations(operations, code) {
  for (const [label, operation] of operations) {
    const input = fixture(); operation(input); rejected(input, code, label);
  }
}

const executionBytes = whole(scopePath);
const scope = JSON.parse(executionBytes);
const tapePaths = git(['diff', '--name-only', '--no-renames', tapeBase, tapeFinal]).toString('utf8').trim()
  .split('\n').filter(name => name !== '.github/workflows/verify.yml').sort();
const commonSourcePaths = [
  scopePath, statusPath, 'docs/tape-catalog-common/INTEGRATION.md',
  'scripts/ci/tape-catalog-common-admission.mjs', 'scripts/ci/task-applicability.mjs',
  'scripts/ci/verify-tape-catalog-common.mjs', 'scripts/ci/test/tape-catalog-common-admission.test.mjs',
  'scripts/ci/test/tape-catalog-common-gate.test.mjs', 'scripts/ci/test/task-applicability.test.mjs',
  '.github/workflows/verify.yml', 'scripts/ci/verify-local-library-signed-stat-fix.mjs',
].sort();
const reportPaths = ['reports/TAPE_CATALOG_COMMON_EVIDENCE.json', 'reports/TAPE_CATALOG_COMMON_RESULT.md'];
const sourceReadbackPaths = [statusPath, 'docs/tape-catalog-common/INTEGRATION.md'];
const evidenceBoundary = {
  realCatalogImport: 'NOT_RUN', sourceMediaWrites: false, ordinary61: 'OPEN', cold61: 'OPEN',
  realOsInterruption: 'OPEN', ownerAcceptanceProven: false, oldEvidenceReattributed: false,
};
const sourceStatus = {
  schema: 'musicbridge.tape-catalog-common.status.v1', task, branch, baseSha: base,
  executionScope: scopePath, phase: 'SOURCE_IMPLEMENTATION',
  inherited: {
    macProductSource: fixSource, macDirectReport: base, tapeFrozenSource: tapeFinal,
    tapeOriginalProductSource: tapeSource, tapeOriginalProductReport: tapeReport,
    originalMbm003Source: originalSource, originalMbm003DirectReport: originalReport,
  },
  evidenceBoundary,
};
const frozenGraph = {
  baseParents: readCommitParents(base), tapeSourceParents: readCommitParents(tapeSource),
  tapeReportParents: readCommitParents(tapeReport), tapeFinalParents: readCommitParents(tapeFinal),
  tapeCiCommits: git(['rev-list', '--parents', '--reverse', '--topo-order', `${tapeReport}..${tapeFinal}`])
    .toString('utf8').trim().split('\n').map(line => {
      const [sha, ...parents] = line.split(/\s+/u); return { sha, parents };
    }),
  originalMbm003ReportParents: readCommitParents(originalReport),
};
const bytesCache = new Map();
function fixedBytes(gitRef) {
  if (!bytesCache.has(gitRef)) bytesCache.set(gitRef, gitContent(gitRef));
  return bytesCache.get(gitRef);
}
const baseTrees = new Map();
function baseTree(name) {
  if (!baseTrees.has(name)) {
    const text = git(['ls-tree', base, '--', name]).toString('utf8').trim();
    if (!text) baseTrees.set(name, null);
    else {
      const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/u.exec(text);
      assert.ok(match, '冻结基线文件应为完整普通Git blob');
      assert.equal(match[3], name, '旧blob必须绑定同一个精确路径');
      baseTrees.set(name, { mode: match[1], blob: match[2] });
    }
  }
  return baseTrees.get(name);
}
const pinnedContents = new Map(scope.currentPins.map(pin => [pin.path,
  pin.path === '.github/workflows/verify.yml' ? whole(pin.path)
    : fixedBytes(`${tapePaths.includes(pin.path) ? tapeFinal : base}:${pin.path}`)]));
const gitContents = scope.gitPins.map(pin => ({ gitRef: pin.gitRef, content: fixedBytes(pin.gitRef) }));

function file(input, name) {
  const row = input.currentFiles.find(candidate => candidate.path === name);
  assert.ok(row, `正例应包含待变异文件：${name}`); return row;
}
function gitFile(input, gitRef) {
  const row = input.gitFiles.find(candidate => candidate.gitRef === gitRef);
  assert.ok(row, `正例应包含待变异Git对象：${gitRef}`); return row;
}
function rawChange(name, content) {
  const previous = baseTree(name);
  return {
    path: name, status: previous ? 'M' : 'A', oldMode: previous?.mode ?? '000000',
    newMode: '100644', oldBlob: previous?.blob ?? '0'.repeat(40), newBlob: blob(content),
  };
}
function fixture() {
  const contents = new Map(pinnedContents);
  for (const name of commonSourcePaths) {
    if (contents.has(name)) continue;
    contents.set(name, name === scopePath ? executionBytes : name === statusPath ? jsonBytes(sourceStatus)
      : Buffer.from(`// 合成共同基线公开输入：${name}。\n`));
  }
  const changedNames = [...tapePaths, ...commonSourcePaths].sort();
  const changes = changedNames.map(name => rawChange(name, contents.get(name)));
  return {
    identity: {
      branch, branchAfter: branch, head: sourceHead, stableHead: sourceHead,
      githubSha: null, githubRefName: null, githubHeadRef: null, runnerRequired: false,
      clean: true, cleanAfter: true,
      git: {
        topLevelIsDirectory: true, gitDirInsideRepository: true, commonDirMatchesGitDir: true,
        objectFormat: 'sha1', shallow: false, replaceRefs: [], grafts: false, alternates: false,
        externalGitEnvironment: [],
      },
    },
    executionBytes, taskStatusBytes: contents.get(statusPath), frozenGraph: clone(frozenGraph),
    commits: [{ sha: sourceHead, parents: [base], changes: changes.map(row => ({ ...row })) }],
    changes: changes.map(row => ({ ...row })),
    currentFiles: [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([path, content]) => ({ path, content })),
    gitFiles: [...gitContents.map(row => ({ ...row })),
      ...sourceReadbackPaths.map(name => ({ gitRef: `${sourceHead}:${name}`, content: contents.get(name) }))],
  };
}
function changeFile(input, name, content) {
  file(input, name).content = content;
  if (name === statusPath) input.taskStatusBytes = content;
  if (name === scopePath) input.executionBytes = content;
  for (const row of input.changes) if (row.path === name) row.newBlob = blob(content);
  for (const commit of input.commits) for (const row of commit.changes) if (row.path === name) row.newBlob = blob(content);
  if (input.commits.length === 1 && sourceReadbackPaths.includes(name)) gitFile(input, `${sourceHead}:${name}`).content = content;
}

function reportFixture() {
  const input = fixture();
  const reportStatus = jsonBytes({ ...sourceStatus, phase: 'SOURCE_VERIFIED_REPORT', sourceSha: sourceHead });
  const integration = Buffer.from('共同Source已完成合成软件验证，旧Mac实际运行仍归5e/R99，私有磁带资料未导入。\n');
  const evidence = jsonBytes({
    schema: 'musicbridge.tape-catalog-common.evidence.v1', task, branch, baseSha: base,
    sourceSha: sourceHead, evidenceBoundary,
  });
  const result = Buffer.from('共同基线合成结果：仅验证准入规则。私有磁带资料导入未运行。\n');
  const replacements = new Map([[statusPath, reportStatus], [sourceReadbackPaths[1], integration],
    [reportPaths[0], evidence], [reportPaths[1], result]]);
  const reportChanges = [];
  for (const [name, content] of replacements) {
    const previous = input.currentFiles.find(row => row.path === name);
    reportChanges.push({
      path: name, status: previous ? 'M' : 'A', oldMode: previous ? '100644' : '000000',
      oldBlob: previous ? blob(previous.content) : '0'.repeat(40), newMode: '100644', newBlob: blob(content),
    });
    if (previous) { previous.content = content; input.changes.find(row => row.path === name).newBlob = blob(content); }
    else { input.currentFiles.push({ path: name, content }); input.changes.push(rawChange(name, content)); }
  }
  input.taskStatusBytes = reportStatus;
  input.identity.head = reportHead; input.identity.stableHead = reportHead;
  input.commits.push({ sha: reportHead, parents: [sourceHead], changes: reportChanges });
  return input;
}
function changeReportFile(input, name, content) {
  file(input, name).content = content;
  if (name === statusPath) input.taskStatusBytes = content;
  input.changes.find(row => row.path === name).newBlob = blob(content);
  input.commits[1].changes.find(row => row.path === name).newBlob = blob(content);
}
const rawRows = rows => rows.map(row =>
  `:${row.oldMode} ${row.newMode} ${row.oldBlob} ${row.newBlob} ${row.status}\0${row.path}\0`).join('');

/** 完整I/O观察通过真实目录加受控Git事实组成；这里只注入facts，不注入准入结果。 */
function ioFixture(input = fixture(), { overrides = {}, late = {}, readOverride } = {}) {
  const calls = [], reads = [], counts = new Map();
  const parentRows = new Map([
    [base, frozenGraph.baseParents], [tapeSource, frozenGraph.tapeSourceParents],
    [tapeReport, frozenGraph.tapeReportParents], [tapeFinal, frozenGraph.tapeFinalParents],
    [originalReport, frozenGraph.originalMbm003ReportParents],
  ]);
  const read = absolute => {
    assert.ok(path.isAbsolute(absolute), 'inspector必须读取明确绝对路径');
    const name = path.relative(repository, absolute).split(path.sep).join('/');
    reads.push(name);
    const readCount = reads.filter(item => item === name).length;
    const content = file(input, name).content;
    return readOverride ? readOverride(name, content, readCount) : content;
  };
  const run = args => {
    calls.push([...args]);
    const key = JSON.stringify(args), count = counts.get(key) ?? 0; counts.set(key, count + 1);
    if (Object.hasOwn(overrides, key)) return typeof overrides[key] === 'function' ? overrides[key](count) : overrides[key];
    const output = value => Buffer.from(value);
    if (key === JSON.stringify(['branch', '--show-current'])) return output(count >= 2 && late.branch !== undefined
      ? late.branch : count === 0 ? input.identity.branch : input.identity.branchAfter);
    if (key === JSON.stringify(['rev-parse', '--verify', 'HEAD^{commit}'])) return output(count >= 2 && late.head !== undefined
      ? late.head : count === 0 ? input.identity.head : input.identity.stableHead);
    if (key === JSON.stringify(['status', '--porcelain=v1', '--untracked-files=all'])) return output(count >= 2 && late.dirty
      ? ' M project/STATUS.json\n' : (count === 0 ? input.identity.clean : input.identity.cleanAfter) ? '' : ' M project/STATUS.json\n');
    if (key === JSON.stringify(['rev-parse', '--show-toplevel'])) return output(repository);
    if (key === JSON.stringify(['rev-parse', '--path-format=absolute', '--git-dir'])
      || key === JSON.stringify(['rev-parse', '--path-format=absolute', '--git-common-dir'])) return output(path.join(repository, '.git'));
    if (key === JSON.stringify(['rev-parse', '--show-object-format'])) return output(input.identity.git.objectFormat);
    if (key === JSON.stringify(['rev-parse', '--is-shallow-repository'])) return output(String(input.identity.git.shallow));
    if (key === JSON.stringify(['for-each-ref', '--format=%(refname)', 'refs/replace'])) return output(count > 0 && late.replace
      ? `refs/replace/${base}\n` : input.identity.git.replaceRefs.join('\n'));
    if (args[0] === 'rev-list' && args[1] === '--parents' && args[2] === '-n' && args[3] === '1' && args.length === 5) {
      const parents = parentRows.get(args[4]); assert.ok(parents, 'inspector不能读取未声明固定提交');
      return output([args[4], ...parents].join(' '));
    }
    if (key === JSON.stringify(['rev-list', '--parents', '--reverse', '--topo-order', `${tapeReport}..${tapeFinal}`]))
      return output(frozenGraph.tapeCiCommits.map(row => [row.sha, ...row.parents].join(' ')).join('\n'));
    if (key === JSON.stringify(['rev-list', '--parents', '--reverse', '--topo-order', `${base}..${input.identity.head}`]))
      return output(input.commits.map(row => [row.sha, ...row.parents].join(' ')).join('\n'));
    const prefix = ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev'];
    if (JSON.stringify(args.slice(0, 7)) === JSON.stringify(prefix) && args.length === 10 && args[9] === '--') {
      const commit = input.commits.find(row => row.parents[0] === args[7] && row.sha === args[8]);
      const cumulative = args[7] === base && args[8] === input.identity.head;
      // 单个Source的每提交diff和累计diff端点相同，真实Git不能为它们给出两套事实。
      if (commit && cumulative) assert.deepEqual(commit.changes, input.changes, '相同Git diff端点必须表示相同的完整差异');
      const rows = commit?.changes ?? (cumulative ? input.changes : undefined);
      assert.ok(rows, 'inspector必须逐个读取指定提交差异'); return output(rawRows(rows));
    }
    if (args[0] === 'show' && args.length === 2) return gitFile(input, args[1]).content;
    throw new Error(`测试没有声明这个Git只读事实：${key}`);
  };
  return { input, read, git: run, calls, reads, counts };
}
function rejectedIo(io, env = {}, code) {
  assert.throws(() => inspectTapeCatalogCommonAdmission(repository, env, { read: io.read, git: io.git }), error => {
    assert.match(error.message, /[\u4e00-\u9fff]/u);
    assert.match(error.code ?? '', /^TAPE_COMMON_/u);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  }, 'I/O读取中的身份漂移必须严格拒绝');
}

test('共同准入：固定c647唯一父FD、52个CFA文件与12产品/45保护的正例均来自真实Git全文', () => {
  assert.equal(tapePaths.length, 52);
  assert.equal(commonSourcePaths.length, 11);
  assert.equal(scope.task, task); assert.equal(scope.branch, branch); assert.equal(scope.baseSha, base);
  assert.deepEqual(frozenGraph.baseParents, [fixSource]);
  assert.deepEqual(frozenGraph.tapeSourceParents, [tapeBase]);
  assert.deepEqual(frozenGraph.tapeReportParents, [tapeSource]);
  assert.deepEqual(frozenGraph.originalMbm003ReportParents, [originalSource]);
  assert.deepEqual(scope.frozenGraph, frozenGraph);
  assert.deepEqual(scope.sourceChangedPaths.map(row => row.path).sort(), [...tapePaths, ...commonSourcePaths].sort());
  assert.equal(scope.productPins.length, 12); assert.equal(scope.protectedFiles.length, 45);
  const input = fixture(), before = clone(input);
  for (const pin of scope.currentPins) {
    const bytes = file(input, pin.path).content;
    assert.equal(bytes.length, pin.bytes, `${pin.path}必须完整读取`);
    assert.equal(sha(bytes), pin.sha256, `${pin.path}的SHA绑定全文`);
    assert.equal(blob(bytes), pin.gitBlob, `${pin.path}的Git blob绑定全文`);
  }
  const result = assertTapeCatalogCommonAdmission(input);
  assert.equal(result.task, task);
  assert.deepEqual(input, before, '纯准入不能改写提交图、文件或历史输入');
  assert.deepEqual(tapeCatalogCommonWorkflowOutputs(result), {
    task, mobileTask: 'reuse-frozen', legacyGateMode: 'reuse-frozen',
    localLibraryFixTask: 'LOCAL_LIBRARY_SIGNED_STAT_FIX', combinedGateMode: 'run',
  });
});

test('共同准入：分支、分支回读及相似basename不能借旧修复或旧磁带路由准入', () => {
  rejectMutations(['codex/else', 'codex/fix-local-library-loading', 'codex/tape-catalog-r3-import',
    `${branch}/suffix`, `${branch}-suffix`, '', null].flatMap(value => [
    [`初读错分支${value}`, input => { input.identity.branch = value; }],
    [`回读错分支${value}`, input => { input.identity.branchAfter = value; }],
  ]));
});

test('共同准入：HEAD及runner的SHA/Ref/PR源分支必须绑定同一个Source', () => {
  for (const value of ['', null, 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), base, tapeFinal]) {
    for (const key of ['head', 'stableHead']) {
      const input = fixture(); input.identity[key] = value; rejected(input, undefined, `${key}不能使用${value}`);
    }
  }
  const runner = fixture(); Object.assign(runner.identity, {
    runnerRequired: true, githubSha: sourceHead, githubRefName: branch, githubHeadRef: null,
  });
  assert.equal(assertTapeCatalogCommonAdmission(runner).task, task, '精确push runner正例必须先准入');
  for (const [key, values] of [
    ['githubSha', [null, '', reportHead, base, 'a'.repeat(39)]],
    ['githubRefName', [null, '', 'main', `${branch}-copy`, '123/merge']],
    ['githubHeadRef', ['main', 'codex/tape-catalog-r3-import', `${branch}-copy`]],
  ]) for (const value of values) {
    const input = clone(runner); input.identity[key] = value; rejected(input, undefined, `runner ${key}身份漂移`);
  }
});

test('共同准入：前后工作区dirty或脱离独立Git目录均不允许输出复用', () => {
  rejectMutations(['clean', 'cleanAfter'].flatMap(key => [false, undefined, 'true'].map(value =>
    [`${key}不是确定清洁状态`, input => { input.identity[key] = value; }])));
  for (const key of ['topLevelIsDirectory', 'gitDirInsideRepository', 'commonDirMatchesGitDir']) {
    for (const value of [false, undefined, 'true']) {
      const input = fixture(); input.identity.git[key] = value; rejected(input, undefined, `${key}必须证明真实仓库身份`);
    }
  }
});

test('共同准入：Git replace、grafts、alternates、浅历史及外部Git环境不得伪造图或文件身份', () => {
  rejectMutations([
    ['替换任一对象', input => { input.identity.git.replaceRefs = [`refs/replace/${base}`]; }],
    ['替换收据报告', input => { input.identity.git.replaceRefs = [`refs/replace/${originalReport}`]; }],
    ['grafts替换父链', input => { input.identity.git.grafts = true; }],
    ['alternates隐藏对象来源', input => { input.identity.git.alternates = true; }],
    ['浅历史', input => { input.identity.git.shallow = true; }],
    ['另一对象格式', input => { input.identity.git.objectFormat = 'sha256'; }],
    ['外部GIT_DIR', input => { input.identity.git.externalGitEnvironment = ['GIT_DIR']; }],
    ['外部替换控制', input => { input.identity.git.externalGitEnvironment = ['GIT_REPLACE_REF_BASE']; }],
    ['外部配置', input => { input.identity.git.externalGitEnvironment = ['GIT_CONFIG_COUNT']; }],
  ]);
});

test('共同准入：所有固定原Source/直接Report父关系以及CFA补丁父链逐项拒绝漂移', () => {
  for (const key of ['baseParents', 'tapeSourceParents', 'tapeReportParents', 'tapeFinalParents', 'originalMbm003ReportParents']) {
    for (const replacement of [[], [sourceHead], [...frozenGraph[key], reportHead]]) {
      const input = fixture(); input.frozenGraph[key] = replacement; rejected(input, undefined, `固定${key}漂移`);
    }
  }
  rejectMutations([
    ['漏掉CFA前序CI提交', input => { input.frozenGraph.tapeCiCommits.shift(); }],
    ['CFA不是唯一父', input => { input.frozenGraph.tapeCiCommits[1].parents.push(sourceHead); }],
    ['CFA前序换头', input => { input.frozenGraph.tapeCiCommits[0].sha = sourceHead; }],
    ['重排CFA历史', input => { input.frozenGraph.tapeCiCommits.reverse(); }],
  ]);
});

test('共同准入：Source必须精确一个直接c647子提交，额外分支/合并/空链不能以累计diff掩饰', () => {
  rejectMutations([
    ['Source没有提交', input => { input.commits = []; }],
    ['Source不是c647直接子', input => { input.commits[0].parents = [fixSource]; }],
    ['Source多父合并', input => { input.commits[0].parents.push(tapeFinal); }],
    ['Source没有父关系', input => { input.commits[0].parents = []; }],
    ['Source提交身份与HEAD不一致', input => { input.commits[0].sha = reportHead; }],
    ['多一个未授权Source', input => { input.commits.push({ sha: reportHead, parents: [sourceHead], changes: [] }); }],
  ]);
});

test('共同准入：Source任一删除/改名/复制/类型变更或符号链接/执行位都不能混入精确63路径', () => {
  for (const status of ['D', 'R100', 'R', 'C100', 'T', '?', 'M\0A']) {
    const input = fixture(); input.commits[0].changes[0].status = status; input.changes[0].status = status;
    rejected(input, undefined, `${status}不是允许的原样导入`);
  }
  for (const mode of ['120000', '100755', '160000', '040000', '000000', '644']) {
    for (const key of ['oldMode', 'newMode']) {
      const input = fixture(); input.commits[0].changes[0][key] = mode; input.changes[0][key] = mode;
      rejected(input, undefined, `${key}=${mode}必须拒绝`);
    }
  }
});

test('共同准入：新增文件伪旧blob、累计diff与每提交blob不一致、重复或漏变更都被拒绝', () => {
  rejectMutations([
    ['source漏路径', input => { input.commits[0].changes.pop(); }],
    ['累计diff漏路径', input => { input.changes.pop(); }],
    ['source重复路径', input => { input.commits[0].changes.push({ ...input.commits[0].changes[0] }); }],
    ['累计重复路径', input => { input.changes.push({ ...input.changes[0] }); }],
    ['只有累计diff放入第三blob', input => { input.changes[0].newBlob = 'c'.repeat(40); }],
    ['source旧blob篡改', input => { input.commits[0].changes[0].oldBlob = 'c'.repeat(40); }],
    ['新增文件伪旧blob', input => { input.commits[0].changes.find(row => row.status === 'A').oldBlob = 'c'.repeat(40); }],
    ['伪完整blob', input => { input.commits[0].changes[0].newBlob = 'c'.repeat(39); }],
    ['未知row字段', input => { input.commits[0].changes[0].renameFrom = 'project/STATUS.json'; }],
  ]);
});

test('共同准入：目录前缀、dot/双斜线/反斜线和范围外合同不能冒充精确basename', () => {
  for (const name of ['../outside', './' + scopePath, scopePath + '/child', 'docs/tape-catalog-common//STATUS.json',
    'docs\\tape-catalog-common\\STATUS.json', 'packages/contracts/mobile/openapi.json',
    'packages/contracts/src/index.ts', 'reports/TAPE_CATALOG_COMMON_EXTRA.md', 'private/profile/library.db']) {
    const input = fixture(); input.commits[0].changes[0].path = name; input.changes[0].path = name;
    rejected(input, undefined, `未授权路径${name}`);
  }
});

test('共同准入：中途越界再回退仍拒绝，完整累计diff不能抹掉历史源写或权限变更', () => {
  for (const name of ['project/STATUS.json', 'project/POSTRUST_PLAN.json', 'packages/contracts/mobile/openapi.json',
    'apps/desktop/src/main/core-environment.ts', 'packages/bridge-core/src/library/metadata-reader-worker.ts']) {
    const input = fixture();
    const forbidden = { path: name, status: 'M', oldMode: '100644', newMode: '100644', oldBlob: 'c'.repeat(40), newBlob: 'd'.repeat(40) };
    input.commits[0].changes.push(forbidden);
    input.commits.push({ sha: reportHead, parents: [sourceHead], changes: [{ ...forbidden, oldBlob: forbidden.newBlob, newBlob: forbidden.oldBlob }] });
    input.identity.head = reportHead; input.identity.stableHead = reportHead;
    rejected(input, undefined, `${name}中途改动后回退仍越界`);
  }
});

test('共同准入：8字段纯输入闭集、identity及Git事实闭集不接纳额外准入开关', () => {
  for (const key of Object.keys(fixture())) {
    const input = fixture(); delete input[key]; rejected(input, undefined, `缺少完整${key}`);
  }
  rejectMutations([
    ['输入额外PASS', input => { input.admitted = true; }],
    ['identity借外部authorized', input => { input.identity.authorized = true; }],
    ['Git借skip保护', input => { input.identity.git.skipProtected = true; }],
    ['Source行借executionSha', input => { input.commits[0].executionSha = fixSource; }],
  ]);
});

test('共同准入：Scope不是Buffer、非法UTF8/JSON、换task/base/权限或pin均不可准入', () => {
  for (const bytes of [new Uint8Array(executionBytes), Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('{')]) {
    const input = fixture(); input.executionBytes = bytes; rejected(input, undefined, '范围必须有完整原始字节');
  }
  for (const [label, operation] of [
    ['假冒原FD任务', value => { value.task = 'LOCAL_LIBRARY_SIGNED_STAT_FIX'; }],
    ['假冒003任务', value => { value.task = 'MBM-003'; }],
    ['移动到旧Source', value => { value.baseSha = originalSource; }],
    ['扩充Source路径', value => { value.sourceChangedPaths.push({ ...value.sourceChangedPaths[0], path: 'project/STATUS.json' }); }],
    ['FD pin第三版', value => { value.productPins[0].sha256 = 'f'.repeat(64); }],
    ['CFA pin第三版', value => { value.tapeCatalogPins[0].bytes++; }],
    ['独立authority未知权限', value => { value.productionImportAuthorized = true; }],
  ]) {
    const input = fixture(); changeFile(input, scopePath, mutateJson(input.executionBytes, operation));
    rejected(input, undefined, label);
  }
});

test('共同准入：FD12产品完整新字节逐个冻结，旧5e版与同长度第三版均不准入', () => {
  assert.equal(scope.productPins.length, 12);
  for (const pin of scope.productPins) {
    for (const bytes of [corruptSameLength(pinnedContents.get(pin.path)),
      Buffer.concat([pinnedContents.get(pin.path), Buffer.from('\n')]), fixedBytes(`${originalSource}:${pin.path}`)]) {
      const input = fixture(); changeFile(input, pin.path, bytes);
      rejected(input, undefined, `${pin.path}不能降回旧版或准入第三版`);
    }
  }
});

test('共同准入：全部52个CFA文件正文及修正版验证源不允许新增第三版或恢复旧断言', () => {
  for (const name of tapePaths) {
    const input = fixture(); changeFile(input, name, corruptSameLength(pinnedContents.get(name)));
    rejected(input, undefined, `${name}不是冻结CFA全文`);
  }
  for (const name of ['apps/desktop/e2e/collection-preview.spec.ts', 'packages/bridge-core/test/reference-archive-catalog-store.test.ts']) {
    const input = fixture(); changeFile(input, name, fixedBytes(`${tapeSource}:${name}`));
    rejected(input, undefined, `${name}不能降回未经冻结CI修正的原验证源`);
  }
});

test('共同准入：45份FD保护文件仅路由器精确CFA全文例外，旧路由和任意第三版一律拒绝', () => {
  const exception = 'scripts/ci/mbm003-predecessor-reuse.mjs';
  assert.equal(scope.protectedFiles.length, 45);
  for (const pin of scope.protectedFiles) {
    const input = fixture(); changeFile(input, pin.path, corruptSameLength(pinnedContents.get(pin.path)));
    rejected(input, undefined, `${pin.path}不能借继承放宽冻结保护`);
  }
  const previous = fixture(); changeFile(previous, exception, fixedBytes(`${base}:${exception}`));
  rejected(previous, undefined, '路由器在共同基线也只能使用唯一CFA版本');
  assert.deepEqual(pinnedContents.get(exception), fixedBytes(`${tapeFinal}:${exception}`));
  assert.notDeepEqual(pinnedContents.get(exception), fixedBytes(`${base}:${exception}`));
});

test('共同准入：mobile合同1.7/40与core-environment DSD转换保护原文件完整冻结', () => {
  assert.equal(scope.mobileContract.path, 'packages/contracts/mobile/openapi.json');
  assert.equal(scope.mobileContract.version, '1.7.0'); assert.equal(scope.mobileContract.operations, 40);
  assert.equal(scope.coreEnvironment.path, 'apps/desktop/src/main/core-environment.ts');
  const guard = pinnedContents.get(scope.coreEnvironment.path).toString('utf8');
  assert.match(guard, /dsd|DSD/u, '独立正例必须确实包含DSD处理保护');
  for (const name of [scope.mobileContract.path, scope.coreEnvironment.path]) {
    for (const bytes of [Buffer.alloc(0), corruptSameLength(pinnedContents.get(name)),
      Buffer.concat([pinnedContents.get(name), Buffer.from('\n// 放宽转换保护。\n')])]) {
      const input = fixture(); changeFile(input, name, bytes); rejected(input, undefined, `${name}保护不允许漂移`);
    }
  }
});

test('共同准入：不删除/清空/改旧STATUS、PLAN、TODO、PROGRESS，也不清选择器逃入legacy', () => {
  for (const name of ['project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md']) {
    for (const bytes of [Buffer.alloc(0), Buffer.from('{}\n'), corruptSameLength(pinnedContents.get(name))]) {
      const input = fixture(); changeFile(input, name, bytes); rejected(input, undefined, `旧账本${name}必须逐字节继承`);
    }
    const missing = fixture(); missing.currentFiles = missing.currentFiles.filter(row => row.path !== name);
    rejected(missing, undefined, `${name}删除不能取得legacy权限`);
  }
  for (const [name, operation] of [
    ['project/STATUS.json', value => { delete value.currentMobileTask; delete value.currentLocalLibraryFixTask; delete value.localLibrarySignedStatFix; }],
    ['project/POSTRUST_PLAN.json', value => { delete value.execution_schedule; delete value.local_library_signed_stat_fix; }],
  ]) {
    const input = fixture(); changeFile(input, name, mutateJson(file(input, name).content, operation));
    rejected(input, undefined, `${name}不能清旧标记绕过严格共同准入`);
  }
});

test('共同准入：R99五报告逐件完整Git ref/blob/长度/SHA绑定，2MB CI报告不得截取', () => {
  const inherited = JSON.parse(fixedBytes(`${base}:reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EVIDENCE.json`)).originalMbm003ReportInheritance;
  assert.equal(inherited.originalSource, originalSource); assert.equal(inherited.originalDirectReport, originalReport);
  assert.equal(inherited.immutableOriginalFiles.length, 5);
  assert.deepEqual(scope.originalMbm003ReportInheritance, inherited, '必须完整继承c647的R99说明');
  assert.equal(inherited.immutableOriginalFiles.find(row => row.path.endsWith('/source-ci.json')).bytes, 2098500);
  for (const pin of inherited.immutableOriginalFiles) {
    const bytes = fixedBytes(pin.gitRef);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha(bytes), pin.sha256); assert.equal(blob(bytes), pin.gitBlob);
    for (const replacement of [corruptSameLength(bytes), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('\n')])]) {
      const input = fixture(); gitFile(input, pin.gitRef).content = replacement;
      rejected(input, undefined, `${pin.path}不是完整R99原报告`);
    }
    const wrongRef = fixture(); gitFile(wrongRef, pin.gitRef).gitRef = `${fixSource}:${pin.path}`;
    rejected(wrongRef, undefined, `${pin.path}不能改由FD归属`);
    const missing = fixture(); missing.gitFiles = missing.gitFiles.filter(row => row.gitRef !== pin.gitRef);
    rejected(missing, undefined, `${pin.path}不能只保留四个继承报告`);
    for (const key of ['gitRef', 'gitBlob', 'bytes', 'sha256']) {
      const input = fixture(); changeFile(input, scopePath, mutateJson(input.executionBytes, value => {
        const row = value.originalMbm003ReportInheritance.immutableOriginalFiles.find(candidate => candidate.path === pin.path);
        row[key] = key === 'bytes' ? row[key] + 1 : key === 'gitRef' ? `${fixSource}:${pin.path}` : 'f'.repeat(key === 'sha256' ? 64 : 40);
      }));
      rejected(input, undefined, `${pin.path}的声明${key}不能漂移`);
    }
  }
});

test('共同准入：不将R99五份原报告落入工作树，也不接纳未声明Git对象或重复current行', () => {
  for (const pin of scope.originalMbm003ReportInheritance.immutableOriginalFiles) {
    const input = fixture(); input.currentFiles.push({ path: pin.path, content: fixedBytes(pin.gitRef) });
    rejected(input, undefined, `${pin.path}未经准许不能复制进共同Source`);
  }
  rejectMutations([
    ['额外私有Git对象', input => { input.gitFiles.push({ gitRef: `${base}:private/library.sqlite`, content: Buffer.from('合成私有库') }); }],
    ['重复Git ref', input => { input.gitFiles.push({ ...input.gitFiles[0] }); }],
    ['重复当前文件', input => { input.currentFiles.push({ ...input.currentFiles[0] }); }],
    ['额外ZIP', input => { input.currentFiles.push({ path: 'private/tape-catalog-r3.zip', content: Buffer.from('合成私有ZIP') }); }],
  ]);
});

test('共同准入：当前文件和Git全文只收Buffer；UTF8转码、摘要或数组不能代替原始bytes', () => {
  for (const target of ['currentFiles', 'gitFiles']) {
    for (const replacement of [row => row.content.toString('utf8'), row => new Uint8Array(row.content),
      row => ({ bytes: row.content.length, sha256: sha(row.content) }), () => null]) {
      const input = fixture(); input[target][0].content = replacement(input[target][0]);
      rejected(input, undefined, `${target}不接受非Buffer数据`);
    }
    const missing = fixture(); missing[target].pop(); rejected(missing, undefined, `${target}缺失最后一份原字节`);
  }
});

test('共同准入：134个固定Git来源逐件验全文，FD/BASE/CFA来源bytes第三版不能被正确当前文件掩盖', () => {
  assert.equal(scope.gitPins.length, 134);
  for (const pin of scope.gitPins) {
    const input = fixture(); gitFile(input, pin.gitRef).content = corruptSameLength(fixedBytes(pin.gitRef));
    rejected(input, 'TAPE_COMMON_FROZEN_GIT_BYTES_DRIFT', `${pin.gitRef}必须是精确原始Git全文`);
  }
});

test('共同准入：独立STATUS task/branch/base/scope或Source phase不一致均不能继承旧权限', () => {
  for (const [key, value] of [
    ['schema', 'musicbridge.other.status.v1'], ['task', 'MBM-003'], ['task', 'LOCAL_LIBRARY_SIGNED_STAT_FIX'],
    ['branch', 'codex/fix-local-library-loading'], ['baseSha', originalSource], ['executionScope', 'project/STATUS.json'],
    ['phase', 'COMPLETE'], ['phase', 'SOURCE_VERIFIED_REPORT'],
  ]) {
    const input = fixture(); changeFile(input, statusPath, mutateJson(input.taskStatusBytes, status => { status[key] = value; }));
    rejected(input, undefined, `独立STATUS ${key}不能漂移`);
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from('{}\n'), Buffer.from([0xff])]) {
    const input = fixture(); changeFile(input, statusPath, bytes); rejected(input, undefined, '独立STATUS必须完整有效');
  }
});

test('共同准入：任何软件/真实资料导入/普通61/冷启61/OS中断/Owner升层均拒绝', () => {
  for (const [key, values] of [
    ['realCatalogImport', ['PASS', 'COMPLETE', true]], ['sourceMediaWrites', [true, 'ON']],
    ['ordinary61', ['PASS', 'CLOSED']], ['cold61', ['PASS', 'CLOSED']], ['realOsInterruption', ['PASS', 'CLOSED']],
    ['ownerAcceptanceProven', [true, 'PASS']], ['oldEvidenceReattributed', [true]],
  ]) for (const value of values) {
    const input = fixture(); changeFile(input, statusPath, mutateJson(input.taskStatusBytes, status => { status.evidenceBoundary[key] = value; }));
    rejected(input, undefined, `${key}不能被共同Source自行升层`);
  }
  const missing = fixture(); changeFile(missing, statusPath, mutateJson(missing.taskStatusBytes, status => { delete status.evidenceBoundary; }));
  rejected(missing, undefined, '缺完整证据边界不能准入');
});

test('共同准入：旧FD/5e/R99成果归属与私有导入权限声明不能在Scope中被重标或升层', () => {
  for (const [label, operation] of [
    ['将原软件证据归到FD', value => { value.originalMbm003ReportInheritance.originalSource = fixSource; }],
    ['将R99报告归到共同Source', value => { value.originalMbm003ReportInheritance.originalDirectReport = sourceHead; }],
    ['省掉5e运行归属边界', value => { value.originalMbm003ReportInheritance.original5eRuntimeAnd99ReportingFactsNotRelabeledAsFixFd = false; }],
    ['声称真实磁带资料已导入', value => { value.evidenceBoundary.productionCatalogImport = 'PASS'; }],
    ['升级Owner', value => { value.evidenceBoundary.currentCombinedAppDeviceOwnerProven = true; }],
    ['放行普通61', value => { value.evidenceBoundary.ordinary61Acceptance = 'PASS'; }],
    ['要求重跑旧手机', value => { value.evidenceBoundary.newPhoneOrOldSoftwareRevalidationRequiredByReportInheritance = true; }],
  ]) {
    const input = fixture(); changeFile(input, scopePath, mutateJson(input.executionBytes, operation)); rejected(input, undefined, label);
  }
});

test('共同准入：只有本模块完整准入结果能生成五输出，flags/克隆/部分结果不能跳旧Gate', () => {
  const result = assertTapeCatalogCommonAdmission(fixture());
  assert.equal(tapeCatalogCommonWorkflowOutputs(result).combinedGateMode, 'run');
  for (const candidate of [null, {}, clone(result), { ...result }, { task, oldGateEvidenceReused: true },
    { task, currentMobileTask: 'MBM-003', oldGateEvidenceReused: true, current003SoftwareGateRequired: true },
    { task: 'legacy', oldGateEvidenceReused: false }]) {
    assert.throws(() => tapeCatalogCommonWorkflowOutputs(candidate), error => {
      assert.match(error.message, /[\u4e00-\u9fff]/u); return true;
    }, '不完整或伪造结果不得输出reuse-frozen');
  }
  for (const key of Object.keys(result)) {
    const forged = { ...result }; delete forged[key]; assert.throws(() => tapeCatalogCommonWorkflowOutputs(forged), '部分结果禁止复用');
  }
});

test('共同报告：唯一直接Report精确新增2报告与修改独立STATUS/INTEGRATION，结果仍要求fresh组合Gate', () => {
  const input = reportFixture(), before = clone(input);
  const result = assertTapeCatalogCommonAdmission(input);
  assert.equal(result.task, task); assert.deepEqual(result.closure, {
    phase: 'DIRECT_REPORT', sourceSha: sourceHead, reportSha: reportHead, commits: [sourceHead, reportHead], baseSha: base,
  });
  assert.deepEqual(input, before, '报告准入仍必须是纯读取');
  assert.deepEqual(tapeCatalogCommonWorkflowOutputs(result), {
    task, mobileTask: 'reuse-frozen', legacyGateMode: 'reuse-frozen', localLibraryFixTask: 'LOCAL_LIBRARY_SIGNED_STAT_FIX', combinedGateMode: 'run',
  });
});

test('共同报告：错Source父、双父、重复Source SHA或第二份报告不能扩大直接Report图', () => {
  for (const operation of [
    input => { input.commits[1].parents = [base]; }, input => { input.commits[1].parents = [fixSource]; },
    input => { input.commits[1].parents.push(originalReport); }, input => { input.commits[1].sha = sourceHead; },
    input => { input.commits.push({ sha: 'c'.repeat(40), parents: [reportHead], changes: [] }); },
  ]) { const input = reportFixture(); operation(input); rejected(input, undefined, '不符合唯一直接报告图'); }
});

test('共同报告：报告2新增缺一、伪报告basename、删除/改名/链接/执行位或额外旧任务报告均拒绝', () => {
  for (const name of reportPaths) {
    const input = reportFixture(); input.commits[1].changes = input.commits[1].changes.filter(row => row.path !== name);
    rejected(input, undefined, `报告必须完整包含${name}`);
  }
  for (const operation of [
    input => { input.commits[1].changes[0].status = 'D'; }, input => { input.commits[1].changes[0].status = 'R100'; },
    input => { input.commits[1].changes[0].newMode = '120000'; }, input => { input.commits[1].changes[0].newMode = '100755'; },
    input => { input.commits[1].changes[0].path = 'reports/MBM-003_RESULT.md'; },
    input => { input.commits[1].changes.push(rawChange('reports/TAPE_CATALOG_COMMON_EXTRA.md', Buffer.from('合成'))); },
  ]) { const input = reportFixture(); operation(input); rejected(input, undefined, '报告越界不能准入'); }
});

test('共同报告：报告不能再改产品/Scope/workflow/保护源，即使最终字节回到冻结版', () => {
  for (const name of [scope.productPins[0].path, tapePaths[0], scopePath, '.github/workflows/verify.yml', 'project/STATUS.json']) {
    const input = reportFixture(); const bytes = file(input, name).content;
    input.commits[1].changes.push({ path: name, status: 'M', oldMode: '100644', newMode: '100644', oldBlob: 'c'.repeat(40), newBlob: blob(bytes) });
    rejected(input, undefined, `${name}不能在Report中假装回退完毕`);
  }
});

test('共同报告：STATUS/EVIDENCE的Source SHA精确绑定新Source，不冒充FD/5e/R99执行范围', () => {
  for (const name of [statusPath, reportPaths[0]]) for (const value of [fixSource, originalSource, originalReport, reportHead, null]) {
    const input = reportFixture(); changeReportFile(input, name, mutateJson(file(input, name).content, status => { status.sourceSha = value; }));
    rejected(input, undefined, `${name}不能把${value}写成当前Source`);
  }
  for (const [key, value] of [['task', 'MBM-003'], ['task', 'LOCAL_LIBRARY_SIGNED_STAT_FIX'], ['branch', 'codex/fix-local-library-loading'],
    ['baseSha', originalSource], ['schema', 'musicbridge.mbm003.evidence.v1']]) {
    const input = reportFixture(); changeReportFile(input, reportPaths[0], mutateJson(file(input, reportPaths[0]).content, evidence => { evidence[key] = value; }));
    rejected(input, undefined, `报告${key}不能沿旧身份`);
  }
});

test('共同报告：私有磁带导入未跑与旧软件/真实运行/Owner边界不能被报告升层', () => {
  for (const name of [statusPath, reportPaths[0]]) for (const [key, value] of [
    ['realCatalogImport', 'PASS'], ['sourceMediaWrites', true], ['ordinary61', 'PASS'], ['cold61', 'PASS'],
    ['realOsInterruption', 'PASS'], ['ownerAcceptanceProven', true], ['oldEvidenceReattributed', true],
  ]) {
    const input = reportFixture(); changeReportFile(input, name, mutateJson(file(input, name).content, record => { record.evidenceBoundary[key] = value; }));
    rejected(input, undefined, `${name}不能升层${key}`);
  }
});

test('共同报告：新报告原字节/UTF8/Source读回/累计blob缺失或不一致都不能通过', () => {
  for (const name of reportPaths) for (const bytes of [Buffer.alloc(0), Buffer.from([0xff])]) {
    const input = reportFixture(); changeReportFile(input, name, bytes); rejected(input, undefined, `${name}必须完整普通UTF8`);
  }
  for (const operation of [
    input => { input.changes.find(row => row.path === statusPath).newBlob = 'c'.repeat(40); },
    input => { input.commits[1].changes.find(row => row.path === statusPath).oldBlob = 'c'.repeat(40); },
    input => { gitFile(input, `${sourceHead}:${statusPath}`).content = input.taskStatusBytes; },
    input => { gitFile(input, `${sourceHead}:${sourceReadbackPaths[1]}`).content = file(input, sourceReadbackPaths[1]).content; },
  ]) { const input = reportFixture(); operation(input); rejected(input, undefined, 'Report必须保留完整Source读回'); }
});

test('共同I/O：逐件Buffer读取全部当前文件及134+2 Git对象，并在完整准入后再次读回', () => {
  for (const input of [fixture(), reportFixture()]) {
    const io = ioFixture(input), result = inspectTapeCatalogCommonAdmission(repository, {}, { read: io.read, git: io.git });
    assert.equal(result.task, task);
    assert.equal(io.calls.filter(args => args[0] === 'show').length, scope.gitPins.length + 2);
    for (const row of input.currentFiles) assert.equal(io.reads.filter(name => name === row.path).length, 2, `${row.path}必须前后读回`);
    for (const commit of input.commits) assert.ok(io.calls.some(args => args[0] === 'diff' && args.includes(commit.sha)), '每提交必须独立读raw diff');
    assert.equal(tapeCatalogCommonWorkflowOutputs(result).combinedGateMode, 'run');
  }
});

test('共同I/O：实际runner错GITHUB_SHA、Ref/HeadRef或缺身份不得退回本机准入', () => {
  const valid = { GITHUB_ACTIONS: 'true', GITHUB_SHA: sourceHead, GITHUB_REF_NAME: branch };
  const positive = ioFixture();
  assert.equal(inspectTapeCatalogCommonAdmission(repository, valid, { read: positive.read, git: positive.git }).task, task);
  for (const env of [
    { ...valid, GITHUB_SHA: reportHead }, { ...valid, GITHUB_REF_NAME: 'main' }, { ...valid, GITHUB_HEAD_REF: 'codex/else' },
    { ...valid, GITHUB_SHA: undefined }, { ...valid, GITHUB_REF_NAME: undefined },
  ]) rejectedIo(ioFixture(), env, 'TAPE_COMMON_RUNNER_MISMATCH');
});

test('共同I/O：外部GIT_DIR/WORK_TREE/replace/config环境在读取任何证据前即被拒绝', () => {
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_REPLACE_REF_BASE', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY']) {
    const io = ioFixture(); rejectedIo(io, { [key]: '合成外部覆盖' }, 'TAPE_COMMON_EXTERNAL_GIT_ENVIRONMENT');
    assert.equal(io.calls.length, 0); assert.equal(io.reads.length, 0);
  }
});

test('共同I/O：真实观察到replace ref、浅仓库、commonDir或topLevel漂移均阻断', () => {
  for (const [args, output] of [
    [['for-each-ref', '--format=%(refname)', 'refs/replace'], `refs/replace/${base}\n`],
    [['rev-parse', '--is-shallow-repository'], 'true'], [['rev-parse', '--show-object-format'], 'sha256'],
    [['rev-parse', '--path-format=absolute', '--git-common-dir'], path.dirname(repository)],
    [['rev-parse', '--show-toplevel'], path.dirname(repository)],
  ]) {
    const io = ioFixture(fixture(), { overrides: { [JSON.stringify(args)]: output } });
    rejectedIo(io, {}, 'TAPE_COMMON_GIT_CONTEXT_REJECTED'); assert.equal(io.reads.length, 0);
  }
});

test('共同I/O：Git show转码字符串与截断对象均拒绝，不能把JSON parse成功当原报告证据', () => {
  const pin = scope.originalMbm003ReportInheritance.immutableOriginalFiles.find(row => row.path.endsWith('/source-ci.json'));
  for (const output of [fixedBytes(pin.gitRef).toString('utf8'), fixedBytes(pin.gitRef).subarray(0, 1024 * 1024)]) {
    const io = ioFixture(fixture(), { overrides: { [JSON.stringify(['show', pin.gitRef])]: output } });
    rejectedIo(io, {}, typeof output === 'string' ? 'TAPE_COMMON_GIT_BINARY_READ_REQUIRED' : 'TAPE_COMMON_FROZEN_GIT_BYTES_DRIFT');
  }
});

test('共同I/O：raw diff截断/rename、真实多提交越界后回退或父链错误无法绕过规则', () => {
  const sourceDiff = ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev', base, sourceHead, '--'];
  for (const replacement of [rawRows(fixture().changes).slice(0, -1), ':100644 100644 ' + 'c'.repeat(40) + ' ' + 'd'.repeat(40) + ' R100\0project/STATUS.json\0']) {
    rejectedIo(ioFixture(fixture(), { overrides: { [JSON.stringify(sourceDiff)]: replacement } }), {}, 'TAPE_COMMON_GIT_DIFF_INVALID');
  }
  const hidden = fixture(), forbiddenPath = 'project/STATUS.json';
  const originalBytes = file(hidden, forbiddenPath).content;
  const forbidden = {
    path: forbiddenPath, status: 'M', oldMode: '100644', newMode: '100644',
    oldBlob: blob(originalBytes), newBlob: blob(corruptSameLength(originalBytes)),
  };
  hidden.commits[0].changes.push(forbidden);
  hidden.commits.push({
    sha: reportHead, parents: [sourceHead],
    changes: [{ ...forbidden, oldBlob: forbidden.newBlob, newBlob: forbidden.oldBlob }],
  });
  hidden.identity.head = reportHead; hidden.identity.stableHead = reportHead;
  assert.equal(hidden.changes.length, 63, '第二个Source回退主STATUS后，累计diff只有合法63路径');
  assert.ok(hidden.changes.every(row => row.path !== forbiddenPath), '最终累计diff不能显示已回退的越界主STATUS');
  const hiddenIo = ioFixture(hidden);
  rejectedIo(hiddenIo, {}, 'TAPE_COMMON_SOURCE_CHANGES_REJECTED');
  assert.equal(hiddenIo.reads.length, 0, 'Source必须单提交且精确闭集，历史越界在读取文件前拒绝');
  const wrongParent = ioFixture(fixture(), { overrides: {
    [JSON.stringify(['rev-list', '--parents', '-n', '1', originalReport])]: `${originalReport} ${fixSource}`,
  } });
  rejectedIo(wrongParent, {}, 'TAPE_COMMON_FROZEN_GRAPH_MISMATCH');
});

test('共同I/O：完整准入后HEAD/branch/dirty/replace或任一文件迟到漂移不能返回早期复用结果', () => {
  for (const late of [{ head: reportHead }, { branch: 'codex/else' }, { dirty: true }, { replace: true }]) {
    rejectedIo(ioFixture(fixture(), { late }), {}, 'TAPE_COMMON_ADMISSION_DRIFT');
  }
  for (const name of [scopePath, statusPath, scope.productPins[0].path, 'project/STATUS.json', scope.coreEnvironment.path]) {
    const io = ioFixture(fixture(), { readOverride: (file, bytes, count) => file === name && count > 1 ? corruptSameLength(bytes) : bytes });
    rejectedIo(io, {}, 'TAPE_COMMON_ADMISSION_DRIFT');
  }
});

test('共同I/O：未知I/O入口与伪注入admission结果被拒绝，不存在自带PASS捷径', () => {
  const io = ioFixture();
  for (const injection of [{ ...io, assert: () => ({ task }) }, { read: io.read, git: io.git, admitted: true },
    { read: true, git: io.git }, { read: io.read, git: true }]) {
    assert.throws(() => inspectTapeCatalogCommonAdmission(repository, {}, injection), error => error.code === 'TAPE_COMMON_REPOSITORY_INVALID');
  }
});

test('共同I/O：FD完整读取函数保持普通文件真实字节，并拒绝相对路径与超过指定预算', () => {
  const filename = path.join(repository, 'apps/desktop/src/main/core-environment.ts');
  assert.deepEqual(readTapeCatalogCommonWhole(filename), fixedBytes(`${base}:apps/desktop/src/main/core-environment.ts`));
  assert.throws(() => readTapeCatalogCommonWhole('apps/desktop/src/main/core-environment.ts'), error => error.code === 'TAPE_COMMON_FILE_NOT_CANONICAL');
  assert.throws(() => readTapeCatalogCommonWhole(filename, 1), error => error.code === 'TAPE_COMMON_FILE_KIND_OR_BUDGET');
});
