import { createHash } from 'node:crypto';
import path from 'node:path';

// 此叶只准入已封存磁带产品后的CI补丁，不取得003排程或生产资料库权限。
export const TAPE_CATALOG_R3_CI_SCOPE = Object.freeze({
  schema: 'musicbridge.tape-catalog-r3.ci-scope.v2',
  taskId: 'TAPE-CATALOG-R3',
  branch: 'codex/tape-catalog-r3-import',
  baseSha: 'c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95',
  productSourceSha: 'ff02c6b2fd248748fe7d461259f5749dda86fa0c',
  productReportSha: '799fece27f0cfe056a56fd6258f0db380db3461e',
  originalScopeSha256: '7fc8edf02cb64cdb91c286b9180ed13f1ab7878eb5c17c8d35ba37b56da368d4',
  verifyWorkflowSha256: '18c8ad0a6289833a58ccbcd94b04622a6e6d7ff53164015a125079d72236330d',
  currentMobileTask: 'MBM-003',
  allowedCiFiles: Object.freeze([
    '.github/workflows/verify.yml',
    'scripts/ci/mbm003-predecessor-reuse.mjs',
    'scripts/ci/tape-catalog-r3-ci-applicability.mjs',
    'scripts/ci/test/tape-catalog-r3-ci-applicability.test.mjs',
    'docs/tape-catalog-r3/CI_SCOPE.json',
    'docs/tape-catalog-r3/CI_APPLICABILITY.md',
  ]),
  verificationSourceCorrections: Object.freeze([
    Object.freeze({
      path: 'packages/bridge-core/test/reference-archive-catalog-store.test.ts',
      originalSha256: 'ef9fe16ca049cf8f90371ed155a8122c5f7596f4f249325f0e04fc5e0190b5f3',
      correctedSha256: 'cd29116df00bf415fac5276454472cef8f83a1702ee2baad11c602530f703b60',
      originalGitBlob: 'cc2a3d48aa885d91d828fc9a48cdd0cab7ee19f5',
      correctedGitBlob: '0db2e3167c707f023ad8fc2aee396240b3f27c39',
    }),
    Object.freeze({
      path: 'apps/desktop/e2e/collection-preview.spec.ts',
      originalSha256: '39f23ce7e245213b0e3ade1ccecfd5570a6fa56f220e277c8218f7d0d7f9b447',
      correctedSha256: '9daddcd4e6a8ee2a8486e45ada77015a4acfe664e974cf795c9306b5fd741c35',
      originalGitBlob: 'c1274330f42fd4848a119aa8798f235379baf775',
      correctedGitBlob: '545b5269149282ac09b0aa2568367b944d37679d',
    }),
  ]),
  fullVerifyRequired: true,
  currentMobileSoftwareGateRequired: true,
  historicalGateMode: 'EXACT_FROZEN_PREDECESSOR_REUSE',
  productSourceChangesAllowed: false,
  productionImportAuthorized: false,
  ownerAppModificationAuthorized: false,
});

const pin = TAPE_CATALOG_R3_CI_SCOPE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const fail = reason => { throw new Error('磁带CI适用性未准入：' + reason + '。'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function json(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024) fail('范围文件不是有界原始字节');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('范围JSON不完整'); }
}

function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length < 1
    || changes.length > pin.allowedCiFiles.length + pin.verificationSourceCorrections.length)
    fail('CI补丁变更范围不符');
  const paths = new Set();
  for (const entry of changes) {
    const correction = pin.verificationSourceCorrections.find(row => row.path === entry?.path);
    if (!plain(entry) || (!pin.allowedCiFiles.includes(entry.path) && !correction) || paths.has(entry.path)
      || !['A', 'M'].includes(entry.status) || entry.newMode !== '100644'
      || entry.oldMode !== (entry.status === 'A' ? '000000' : '100644')) fail('CI补丁含范围外路径或删除重命名链接');
    // 验证源只准入已审阅的唯一字节替换，不能在该路径下删断言或改写测试。
    if (correction && (entry.status !== 'M' || entry.oldBlob !== correction.originalGitBlob
      || entry.newBlob !== correction.correctedGitBlob)) fail('验证源不是固定原版到修正版的唯一替换');
    paths.add(entry.path);
  }
}

function validateVerificationSources(sources) {
  if (!Array.isArray(sources) || sources.length !== pin.verificationSourceCorrections.length)
    fail('验证源字节绑定不完整');
  for (const [index, correction] of pin.verificationSourceCorrections.entries()) {
    const source = sources[index];
    if (!plain(source) || source.path !== correction.path) fail('验证源绑定路径不符');
    for (const [field, expectedSha, expectedBlob] of [
      ['originalBytes', correction.originalSha256, correction.originalGitBlob],
      ['correctedBytes', correction.correctedSha256, correction.correctedGitBlob],
    ]) {
      const bytes = source[field];
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024
        || sha(bytes) !== expectedSha || blob(bytes) !== expectedBlob) fail('验证源原始或修正字节身份不符');
    }
  }
}

/** 核真实只读事实；结果只是CI任务适用性，不宣称任何软件Gate已通过。 */
export function validateTapeCatalogCiAdmission(input) {
  if (!plain(input) || input.branch !== pin.branch || input.branchAfter !== pin.branch) fail('分支不符');
  if (!commitId(input.head) || input.head !== input.stableHead
    || input.githubHead !== undefined && input.githubHead !== input.head) fail('HEAD不稳定或与runner不符');
  if (input.runnerRequired === true && (!commitId(input.githubHead) || input.githubBranch !== pin.branch))
    fail('runner固定源码身份缺失');
  if (input.githubBranch !== undefined && input.githubBranch !== pin.branch) fail('runner分支不符');
  if (input.clean !== true || input.cleanAfter !== true) fail('工作区不是清洁固定源码');
  const scope = json(input.scopeBytes);
  if (sha(input.scopeBytes) !== pin.originalScopeSha256 || scope.taskId !== pin.taskId
    || scope.branch !== pin.branch || scope.baseSha !== pin.baseSha) fail('原产品范围身份不符');
  if (!equal(json(input.ciScopeBytes), pin)) fail('CI补丁范围或权限不符');
  if (!Buffer.isBuffer(input.workflowBytes) || sha(input.workflowBytes) !== pin.verifyWorkflowSha256)
    fail('完整verify和当前移动Gate的工作流身份不符');
  validateVerificationSources(input.verificationSources);
  if (!equal(input.sourceParents, [pin.baseSha]) || !equal(input.reportParents, [pin.productSourceSha]))
    fail('固定产品Source和直接报告基线不符');
  if (!Array.isArray(input.commits) || input.commits.length < 1 || input.commits.length > 32)
    fail('不是封存报告之后的有界CI补丁链');
  let previous = pin.productReportSha;
  const seen = new Set([previous, pin.productSourceSha, pin.baseSha]);
  const seenCorrections = new Set();
  for (const entry of input.commits) {
    if (!plain(entry) || !commitId(entry.sha) || seen.has(entry.sha) || !equal(entry.parents, [previous]))
      fail('CI补丁不是唯一父提交线性接续');
    // 累计diff会隐藏中途修改再撤回的产品路径，故每个新增提交也分别限定范围。
    validateChanges(entry.changes);
    for (const change of entry.changes) {
      if (!pin.verificationSourceCorrections.some(row => row.path === change.path)) continue;
      if (seenCorrections.has(change.path)) fail('验证源修正不能在提交链重复出现');
      seenCorrections.add(change.path);
    }
    seen.add(entry.sha); previous = entry.sha;
  }
  if (previous !== input.head) fail('CI补丁链未闭合到当前HEAD');
  if (pin.verificationSourceCorrections.some(row => !seenCorrections.has(row.path)))
    fail('提交链缺少已绑定的验证源修正');
  validateChanges(input.changes);
  if (pin.verificationSourceCorrections.some(row => !input.changes.some(change => change.path === row.path)))
    fail('累计diff缺少已绑定的验证源修正');
  return {
    task: pin.taskId, branch: pin.branch, head: input.head,
    baseSha: pin.baseSha, productSourceSha: pin.productSourceSha, productReportSha: pin.productReportSha,
    currentMobileTask: pin.currentMobileTask, fullVerifyRequired: true, current003SoftwareGateRequired: true,
    historicalGateMode: pin.historicalGateMode, runtimeProductSourceChanged: false,
    verificationSourcesChanged: true, pinnedVerificationSourceChanges: pin.verificationSourceCorrections,
    productionAppOrDatabaseAuthorized: false,
  };
}

function parents(text, expected) {
  const fields = text.trim().split(/\s+/u);
  if (fields.shift() !== expected) fail('Git提交身份不符');
  return fields;
}
function changes(raw) {
  const fields = raw.split('\0');
  if (fields.pop() !== '') fail('Git变更记录未闭合');
  const rows = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/u.exec(fields[index]);
    if (!match || typeof fields[index + 1] !== 'string') fail('Git变更记录格式不符');
    rows.push({ path: fields[index + 1], oldMode: match[1], newMode: match[2],
      oldBlob: match[3], newBlob: match[4], status: match[5] });
  }
  return rows;
}

/** read/git由前序校验器提供真实FD稳定读取和有界Git；测试可注入事实，不注入准入结果。 */
export function inspectTapeCatalogCiAdmission(directory, branch, { read, git, env = process.env } = {}) {
  if (branch !== pin.branch || typeof read !== 'function' || typeof git !== 'function') fail('分支或读取器不符');
  const head = git(['rev-parse', 'HEAD']).trim();
  const scopeBytes = read(path.join(directory, 'docs/tape-catalog-r3/EXECUTION_SCOPE.json'));
  const ciScopeBytes = read(path.join(directory, 'docs/tape-catalog-r3/CI_SCOPE.json'));
  const workflowBytes = read(path.join(directory, '.github/workflows/verify.yml'));
  const verificationSources = pin.verificationSourceCorrections.map(row => ({
    path: row.path,
    originalBytes: Buffer.from(git(['show', pin.productSourceSha + ':' + row.path]), 'utf8'),
    correctedBytes: read(path.join(directory, row.path)),
  }));
  const sourceParents = parents(git(['rev-list', '--parents', '-n', '1', pin.productSourceSha]), pin.productSourceSha);
  const reportParents = parents(git(['rev-list', '--parents', '-n', '1', pin.productReportSha]), pin.productReportSha);
  const commitText = git(['rev-list', '--parents', '--reverse', '--topo-order', pin.productReportSha + '..HEAD']).trim();
  const commits = commitText ? commitText.split('\n').map(line => {
    const [sha, ...parents] = line.trim().split(/\s+/u);
    if (!commitId(sha) || parents.length !== 1 || !commitId(parents[0])) fail('Git补丁父链不符');
    return { sha, parents, changes: changes(git(['diff','--raw','-z','--no-renames','--no-ext-diff','--no-textconv',parents[0],sha,'--no-abbrev'])) };
  }) : [];
  const actualChanges = changes(git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', pin.productReportSha, 'HEAD', '--no-abbrev']));
  const clean = git(['status', '--porcelain=v1', '--untracked-files=all']) === '';
  const stableHead = git(['rev-parse', 'HEAD']).trim();
  const branchAfter = git(['branch', '--show-current']).trim() || env.GITHUB_REF_NAME;
  const cleanAfter = git(['status', '--porcelain=v1', '--untracked-files=all']) === '';
  return validateTapeCatalogCiAdmission({ branch, head, stableHead, branchAfter, scopeBytes, ciScopeBytes,
    workflowBytes, verificationSources, sourceParents, reportParents, commits, changes: actualChanges, clean, cleanAfter,
    ...(env.GITHUB_ACTIONS === 'true' ? { runnerRequired: true, githubHead: env.GITHUB_SHA, githubBranch: env.GITHUB_REF_NAME } : {}) });
}
