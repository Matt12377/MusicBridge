import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const equal = (a, b) => JSON.stringify(sortObject(a)) === JSON.stringify(sortObject(b));
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}
const without = (value, fields) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !fields.includes(key)));
const statusFields = ['state', 'implementationCommit', 'implementationCommitResolution', 'reportCommit',
  'reportCommitResolution', 'report', 'evidence', 'push', 'ci', 'updatedAt', 'finalDeliveryReceipt',
  'nextTask', 'nextBranchBaseline'];
const taskFields = ['status', 'implementation_commit', 'implementation_commit_resolution', 'report_commit',
  'report_commit_resolution', 'report_path', 'validation_status', 'evidence_refs', 'terminal_ci_receipt'];

/** 报告路径白名单之外，机器授权/范围/验收层级也须保持；未知字段改变回退完整检查。 */
export function classifyReportChanges({ task, parent, beforeStatus, afterStatus, beforePlan, afterPlan, changes }) {
  if (!/^MBRS-0(?:0[5-9]|1[0-7])$/u.test(task) || !/^[a-f0-9]{40}$/u.test(parent)
    || beforeStatus.currentPostRustTask !== task || afterStatus.currentPostRustTask !== task
    || !Array.isArray(changes) || !changes.length) return false;
  const keys = Object.keys(afterStatus).filter(key => afterStatus[key]?.task === task);
  if (keys.length !== 1) return false;
  const key = keys[0], before = beforeStatus[key], after = afterStatus[key];
  if (!before || after.implementationCommit !== parent || !equal(without(before, statusFields), without(after, statusFields))
    || !equal(without(beforeStatus, [key]), without(afterStatus, [key]))) return false;
  if (!Array.isArray(beforePlan.tasks) || !Array.isArray(afterPlan.tasks)
    || !Array.isArray(beforePlan.acceptance_cases) || !Array.isArray(afterPlan.acceptance_cases)) return false;
  const normalizePlan = plan => ({
    ...plan,
    tasks: plan.tasks.map(row => row.id === task ? without(row, taskFields) : row),
    acceptance_cases: plan.acceptance_cases.map(row => row.task === task ? without(row, ['evidence_refs']) : row),
  });
  if (!equal(normalizePlan(beforePlan), normalizePlan(afterPlan))) return false;
  const code = task.slice(-3);
  let reportPresent = false;
  for (const entry of changes) {
    if (!['A', 'M'].includes(entry.status) || entry.newMode !== '100644'
      || entry.status === 'M' && entry.oldMode !== '100644'
      || entry.status === 'A' && entry.oldMode !== '000000') return false;
    const name = entry.path;
    const report = new RegExp('^reports/' + task + '_[A-Z0-9_]+\\.(?:md|json)$', 'u').test(name);
    const evidence = new RegExp('^docs/postrust/' + task + '/evidence/[A-Za-z0-9_-]+\\.(?:json|md)$', 'u').test(name);
    const metadata = ['project/STATUS.json', 'project/POSTRUST_PLAN.json',
      'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'].includes(name);
    if (!report && !evidence && !metadata) return false;
    if (report) reportPresent = true;
  }
  return reportPresent && code !== '';
}

const mobileStatusFields = ['implementationCommit', 'implementationCommitResolution', 'reportCommit',
  'reportCommitResolution', 'report', 'evidence', 'push', 'ci', 'updatedAt', 'finalDeliveryReceipt',
  'nextBranchBaseline'];
const mobileTaskFields = ['implementation_commit', 'implementation_commit_resolution', 'report_commit',
  'report_commit_resolution', 'report_path', 'evidence_refs', 'terminal_ci_receipt'];
const mobileScope = 'docs/postrust/MBM-000/EXECUTION_SCOPE.json';

/** 移动000使用独立定位器；旧MBRS定位及验收账本保持原合同。 */
export function locateMobileReportTask(status, plan) {
  const lane = status?.mobileFrontloading20261008, adoption = status?.mobileContractAdoption;
  if (lane?.currentTask !== 'MBM-000' || plan?.execution_schedule?.current_task !== 'MBM-000'
    || adoption?.task !== 'MBM-000' || adoption.scope !== mobileScope
    || !/^[a-f0-9]{40}$/u.test(adoption.baseSha ?? '')
    || adoption.branch !== 'codex/mbm-000-mobile-contracts'
    || plan.execution_schedule.current_task_scope_ref !== mobileScope
    || plan.execution_schedule.predecessor_final_report !== adoption.baseSha
    || !Array.isArray(lane.mobileTasks) || !Array.isArray(plan.mobile_tasks)) return null;
  const keys = Object.keys(status).filter(key => status[key]?.task === 'MBM-000');
  const statusRows = lane.mobileTasks.filter(row => row?.id === 'MBM-000');
  const planRows = plan.mobile_tasks.filter(row => row?.id === 'MBM-000');
  if (keys.length !== 1 || keys[0] !== 'mobileContractAdoption'
    || statusRows.length !== 1 || planRows.length !== 1) return null;
  for (const row of [statusRows[0], planRows[0]]) {
    if (row.scope_ref !== mobileScope || row.base_report_sha !== adoption.baseSha) return null;
  }
  if (!equal(without(statusRows[0], mobileTaskFields), without(planRows[0], mobileTaskFields))) return null;
  return 'MBM-000';
}

/** 仅报告记账可变化；已测范围、对端采纳、权限、预算和真实验收不能在报告提交升层。 */
export function classifyMobileReportChanges({ task, parent, beforeStatus, afterStatus, beforePlan, afterPlan, changes }) {
  if (task !== 'MBM-000' || !/^[a-f0-9]{40}$/u.test(parent ?? '')
    || locateMobileReportTask(beforeStatus, beforePlan) !== task
    || locateMobileReportTask(afterStatus, afterPlan) !== task
    || !Array.isArray(changes) || !changes.length) return false;
  const before = beforeStatus.mobileContractAdoption, after = afterStatus.mobileContractAdoption;
  if (after.implementationCommit !== parent
    || !equal(without(before, mobileStatusFields), without(after, mobileStatusFields))) return false;
  const normalizeRows = rows => rows.map(row => row.id === task ? without(row, mobileTaskFields) : row);
  const normalizeStatus = status => ({ ...status,
    mobileContractAdoption: without(status.mobileContractAdoption, mobileStatusFields),
    mobileFrontloading20261008: { ...status.mobileFrontloading20261008,
      mobileTasks: normalizeRows(status.mobileFrontloading20261008.mobileTasks) } });
  const normalizePlan = plan => ({ ...plan, mobile_tasks: normalizeRows(plan.mobile_tasks) });
  if (!equal(normalizeStatus(beforeStatus), normalizeStatus(afterStatus))
    || !equal(normalizePlan(beforePlan), normalizePlan(afterPlan))) return false;
  const statusRow = afterStatus.mobileFrontloading20261008.mobileTasks.find(row => row.id === task);
  const planRow = afterPlan.mobile_tasks.find(row => row.id === task);
  if (statusRow.implementation_commit !== parent || planRow.implementation_commit !== parent
    || !equal(statusRow, planRow)) return false;
  let reportPresent = false;
  for (const entry of changes) {
    if (!entry || !['A', 'M'].includes(entry.status) || entry.newMode !== '100644'
      || entry.status === 'M' && entry.oldMode !== '100644'
      || entry.status === 'A' && entry.oldMode !== '000000') return false;
    const report = /^reports\/MBM-000_[A-Z0-9_]+\.(?:md|json)$/u.test(entry.path ?? '');
    const evidence = /^docs\/postrust\/MBM-000\/evidence\/[A-Za-z0-9_-]+\.(?:json|md)$/u.test(entry.path ?? '');
    const metadata = ['project/STATUS.json', 'project/POSTRUST_PLAN.json',
      'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'].includes(entry.path);
    if (!report && !evidence && !metadata) return false;
    if (report) reportPresent = true;
  }
  return reportPresent;
}

const mobilePairingTask = 'MBM-001';
const mobilePairingAuthority = 'mobilePairingReadonlyLibrary';
const mobilePairingScope = 'docs/postrust/MBM-001/EXECUTION_SCOPE.json';
const mobilePairingBranch = 'codex/mbm-001-pairing-readonly-library';
const mobilePairingBase = 'c6c4745dfc7fe4242b8a2682798e00605649b12e';

/** 001独立定位；不能以旧013/000定位器或协调者消息替代本域来源。 */
export function locateMobilePairingReportTask(status, plan) {
  const lane = status?.mobileFrontloading20261008, authority = status?.[mobilePairingAuthority];
  if (lane?.currentTask !== mobilePairingTask || plan?.execution_schedule?.current_task !== mobilePairingTask
    || authority?.task !== mobilePairingTask || authority.scope !== mobilePairingScope
    || authority.baseSha !== mobilePairingBase || authority.branch !== mobilePairingBranch
    || plan.execution_schedule.current_task_scope_ref !== mobilePairingScope
    || plan.execution_schedule.predecessor_final_report !== mobilePairingBase
    || !Array.isArray(lane.mobileTasks) || !Array.isArray(plan.mobile_tasks)) return null;
  const keys = Object.keys(status).filter(key => status[key]?.task === mobilePairingTask);
  const statusRows = lane.mobileTasks.filter(row => row?.id === mobilePairingTask);
  const planRows = plan.mobile_tasks.filter(row => row?.id === mobilePairingTask);
  if (keys.length !== 1 || keys[0] !== mobilePairingAuthority || statusRows.length !== 1 || planRows.length !== 1) return null;
  for (const row of [statusRows[0], planRows[0]]) {
    if (row.scope_ref !== mobilePairingScope || row.base_report_sha !== mobilePairingBase) return null;
  }
  if (!equal(without(statusRows[0], mobileTaskFields), without(planRows[0], mobileTaskFields))) return null;
  return mobilePairingTask;
}

/** R只改001的报告记账；软件/App/对端/真实层、范围、旧18/156和后继任务逐值冻结。 */
export function classifyMobilePairingReportChanges({ task, parent, beforeStatus, afterStatus, beforePlan, afterPlan, changes }) {
  if (task !== mobilePairingTask || !/^[a-f0-9]{40}$/u.test(parent ?? '')
    || locateMobilePairingReportTask(beforeStatus, beforePlan) !== task
    || locateMobilePairingReportTask(afterStatus, afterPlan) !== task
    || !Array.isArray(beforePlan.tasks) || !Array.isArray(afterPlan.tasks)
    || !Array.isArray(beforePlan.acceptance_cases) || !Array.isArray(afterPlan.acceptance_cases)
    || !Array.isArray(changes) || !changes.length) return false;
  const before = beforeStatus[mobilePairingAuthority], after = afterStatus[mobilePairingAuthority];
  if (after.implementationCommit !== parent
    || !equal(without(before, mobileStatusFields), without(after, mobileStatusFields))) return false;
  const normalizeRows = rows => rows.map(row => row?.id === task ? without(row, mobileTaskFields) : row);
  const normalizeStatus = status => ({ ...status,
    [mobilePairingAuthority]: without(status[mobilePairingAuthority], mobileStatusFields),
    mobileFrontloading20261008: { ...status.mobileFrontloading20261008,
      mobileTasks: normalizeRows(status.mobileFrontloading20261008.mobileTasks) } });
  const normalizePlan = plan => ({ ...plan, mobile_tasks: normalizeRows(plan.mobile_tasks) });
  if (!equal(normalizeStatus(beforeStatus), normalizeStatus(afterStatus))
    || !equal(normalizePlan(beforePlan), normalizePlan(afterPlan))) return false;
  const statusRow = afterStatus.mobileFrontloading20261008.mobileTasks.find(row => row?.id === task);
  const planRow = afterPlan.mobile_tasks.find(row => row?.id === task);
  if (statusRow.implementation_commit !== parent || planRow.implementation_commit !== parent
    || !equal(statusRow, planRow)) return false;
  let reportPresent = false;
  const paths = new Set();
  for (const entry of changes) {
    if (!entry || !['A', 'M'].includes(entry.status) || entry.newMode !== '100644'
      || entry.status === 'M' && entry.oldMode !== '100644'
      || entry.status === 'A' && entry.oldMode !== '000000'
      || typeof entry.path !== 'string' || paths.has(entry.path)) return false;
    paths.add(entry.path);
    const report = /^reports\/MBM-001_[A-Z0-9_]+\.(?:md|json)(?![\s\S])/u.test(entry.path);
    const evidence = /^docs\/postrust\/MBM-001\/evidence\/[A-Za-z0-9_-]+\.(?:json|md)(?![\s\S])/u.test(entry.path);
    const metadata = ['project/STATUS.json', 'project/POSTRUST_PLAN.json',
      'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'].includes(entry.path);
    if (!report && !evidence && !metadata) return false;
    if (report) reportPresent = true;
  }
  return reportPresent;
}

/** 使用原始模式，拒绝删改类型、链接、可执行“文档”和重命名。 */
export function parseRawDiff(raw) {
  const fields = raw.split('\0'), entries = [];
  for (let i = 0; fields[i]; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/u.exec(fields[i]);
    if (!match || !fields[i + 1]) throw new Error('REPORT_DIFF_UNKNOWN');
    entries.push({ oldMode: match[1], newMode: match[2], status: match[3], path: fields[i + 1] });
  }
  return entries;
}

const workflowPaths = ['.github/workflows/verify.yml', '.github/workflows/security.yml',
  '.github/workflows/rust-core.yml', '.github/workflows/electron-e2e.yml'];
const requiredSteps = {
  '.github/workflows/verify.yml': ['Verify platform-independent workspace (typecheck, unit tests, build; no Electron)',
    'Production dependency audit'],
  '.github/workflows/security.yml': ['Run directed platform-independent security tests (no Electron)'],
  '.github/workflows/rust-core.yml': ['验证实际 Rust 与 TypeScript 边界'],
  '.github/workflows/electron-e2e.yml': ['Electron startup, crash/restart, safeStorage vault and credential recovery gates',
    'Electron end-to-end flow (Playwright, production build)'],
};
export function validateParentCi({ task, repositoryId, parent, branch, runs, proofs, now = Date.now() }) {
  if (!/^MBRS-0(?:0[5-9]|1[0-7])$/u.test(task) || !Number.isSafeInteger(repositoryId) || repositoryId < 1 || !/^[a-f0-9]{40}$/u.test(parent)
    || !Array.isArray(runs) || !Array.isArray(proofs)) return false;
  for (const file of workflowPaths) {
    const candidates = runs.filter(run => run.path === file && run.head_sha === parent && run.head_branch === branch && run.event === 'push');
    if (candidates.length !== 1) return false;
    const run = candidates[0], proof = proofs.find(value => value.runId === run.id);
    if (run.status !== 'completed' || run.conclusion !== 'success' || run.run_attempt !== 1
      || run.repository?.id !== repositoryId || run.head_repository?.id !== repositoryId || !proof
      || !Array.isArray(proof.jobs) || !proof.jobs.length
      || proof.jobs.some(job => job.run_id !== run.id || job.head_sha !== parent
        || job.status !== 'completed' || job.conclusion !== 'success')) return false;
    if (requiredSteps[file].some(name => !proof.jobs.some(job => job.steps?.some(step => step.name === name && step.conclusion === 'success')))) return false;
    // 每个任务都必须有自己的成功Gate，不能把前一任务的成功当作新任务结果。
    if (file.endsWith('/verify.yml') && !proof.jobs.some(job => job.steps?.some(step =>
      new RegExp('^MBRS' + task.slice(-3) + '(?:\\s|$)', 'u').test(step.name ?? '') && step.conclusion === 'success'))) return false;
    if (file === '.github/workflows/rust-core.yml'
      && (proof.jobs.length !== 2 || proof.jobs.some(job => !job.steps?.some(step => step.name === requiredSteps[file][0] && step.conclusion === 'success')))) return false;
    const artifacts = proof.artifacts;
    const names = file.endsWith('/verify.yml') ? ['verify-' + parent]
      : file.endsWith('/rust-core.yml') ? ['rust-core-ubuntu-latest-' + parent, 'rust-core-macos-latest-' + parent]
        : file.endsWith('/electron-e2e.yml') ? ['electron-e2e-' + parent, 'rust-host-compiled-' + parent] : [];
    if (names.length && !Array.isArray(artifacts)) return false;
    for (const name of names) {
      const matching = artifacts.filter(artifact => artifact.name === name);
      if (matching.length !== 1) return false;
      const artifact = matching[0];
      if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '') || Date.parse(artifact.expires_at) <= now
        || !Number.isFinite(Date.parse(artifact.expires_at)) || artifact.workflow_run?.id !== run.id
        || artifact.workflow_run?.head_sha !== parent || artifact.workflow_run?.repository_id !== repositoryId
        || artifact.workflow_run?.head_repository_id !== repositoryId) return false;
    }
  }
  return true;
}

/** 复用当前Source的原完整producer验证，并要求同一Source自己的移动000 Gate成功。 */
export function validateMobileParentCi(input) {
  if (input?.task !== 'MBM-000' || !validateParentCi({ ...input, task: 'MBRS-013' })) return false;
  const verify = input.runs.filter(run => run.path === '.github/workflows/verify.yml');
  if (verify.length !== 1 || input.proofs.filter(proof => proof.runId === verify[0].id).length !== 1) return false;
  const proof = input.proofs.find(value => value.runId === verify[0].id);
  const own = proof.jobs.flatMap(job => job.steps ?? []).filter(step =>
    step.name === 'MBM000 移动合同双端采纳 Gate');
  return own.length === 1 && own[0].status === 'completed' && own[0].conclusion === 'success';
}

/** 001须继承同一push的原producer及013/000 Gate，再证明自己的Gate；只读制品平台元数据。 */
export function validateMobilePairingParentCi(input) {
  try { return validateMobilePairingProducerMetadata(input); }
  catch { return false; }
}
function validateMobilePairingProducerMetadata(input) {
  if (input?.task !== mobilePairingTask || input.branch !== mobilePairingBranch
    || !Array.isArray(input.runs) || input.runs.length !== 4
    || !Array.isArray(input.proofs) || input.proofs.length !== 4
    || !Number.isFinite(input.now ?? Date.now())
    || !validateMobileParentCi({ ...input, task: 'MBM-000' })) return false;
  const positiveId = value => Number.isSafeInteger(value) && value > 0;
  const runIds = new Set(), jobIds = new Set(), artifactIds = new Set();
  const jobCounts = { '.github/workflows/verify.yml': 2, '.github/workflows/security.yml': 1,
    '.github/workflows/rust-core.yml': 2, '.github/workflows/electron-e2e.yml': 1 };
  const artifactCounts = { '.github/workflows/verify.yml': 1, '.github/workflows/security.yml': 0,
    '.github/workflows/rust-core.yml': 2, '.github/workflows/electron-e2e.yml': 2 };
  const successStep = (job, name) => {
    if (!Array.isArray(job.steps)) return false;
    const steps = job.steps.filter(step => step?.name === name);
    return steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success';
  };
  for (const file of workflowPaths) {
    const runs = input.runs.filter(run => run?.path === file);
    if (runs.length !== 1 || !positiveId(runs[0].id) || runIds.has(runs[0].id)) return false;
    const run = runs[0]; runIds.add(run.id);
    const proofs = input.proofs.filter(proof => proof?.runId === run.id);
    if (proofs.length !== 1) return false;
    const proof = proofs[0];
    if (!Array.isArray(proof.jobs) || proof.jobs.length !== jobCounts[file]
      || !Array.isArray(proof.artifacts) || proof.artifacts.length !== artifactCounts[file]) return false;
    for (const job of proof.jobs) {
      if (!positiveId(job?.id) || jobIds.has(job.id) || !Array.isArray(job.steps)) return false;
      jobIds.add(job.id);
    }
    for (const artifact of proof.artifacts) {
      if (!positiveId(artifact?.id) || artifactIds.has(artifact.id)) return false;
      artifactIds.add(artifact.id);
    }
    for (const name of requiredSteps[file]) {
      const producers = proof.jobs.filter(job => successStep(job, name));
      if (producers.length !== (file === '.github/workflows/rust-core.yml' ? 2 : 1)) return false;
    }
    if (file === '.github/workflows/verify.yml') {
      const gates = ['MBRS013 同内容位置迁移与具体清理 Gate', 'MBM000 移动合同双端采纳 Gate',
        'MBM001 配对与只读曲库 Gate'];
      const product = proof.jobs.find(job => successStep(job, requiredSteps[file][0]));
      const audit = proof.jobs.find(job => successStep(job, requiredSteps[file][1]));
      if (!product || !audit || product === audit || gates.some(name => !successStep(product, name)
        || proof.jobs.flatMap(job => job.steps).filter(step => step?.name === name).length !== 1)) return false;
    }
  }
  return runIds.size === 4 && jobIds.size === 6 && artifactIds.size === 5;
}

export async function inspectReportOnly(env = process.env, directory = root, getJson) {
  const full = reason => ({ mode: 'full', reason, productResultsReused: false });
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_API_URL !== 'https://api.github.com'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY ?? '')
    || !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '')) return full('NOT_PUBLIC_HOSTED_PUSH_CONTEXT');
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  try {
    if (git(['rev-parse', 'HEAD']).trim() !== env.GITHUB_SHA || git(['status', '--porcelain']).trim()) return full('CHECKOUT_NOT_PINNED_CLEAN');
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ');
    if (parents.length !== 2) return full('NOT_SINGLE_PARENT');
    const parent = parents[1], branch = git(['branch', '--show-current']).trim() || env.GITHUB_REF_NAME;
    const json = (revision, name) => JSON.parse(git(['show', revision + ':' + name]));
    const afterStatus = json('HEAD', 'project/STATUS.json'), beforeStatus = json(parent, 'project/STATUS.json');
    const afterPlan = json('HEAD', 'project/POSTRUST_PLAN.json'), beforePlan = json(parent, 'project/POSTRUST_PLAN.json');
    const mobileTasks = [beforeStatus.mobileFrontloading20261008?.currentTask,
      afterStatus.mobileFrontloading20261008?.currentTask, beforePlan.execution_schedule?.current_task,
      afterPlan.execution_schedule?.current_task];
    const mobile = mobileTasks.some(value => typeof value === 'string' && value.startsWith('MBM-'));
    const pairing = mobileTasks.includes(mobilePairingTask);
    const task = pairing ? locateMobilePairingReportTask(afterStatus, afterPlan)
      : mobile ? locateMobileReportTask(afterStatus, afterPlan) : afterStatus.currentPostRustTask;
    const classify = pairing ? classifyMobilePairingReportChanges : mobile ? classifyMobileReportChanges : classifyReportChanges;
    if (!classify({ task, parent, afterStatus, beforeStatus, afterPlan, beforePlan,
      changes: parseRawDiff(git(['diff', '--raw', '-z', '--no-renames', parent, 'HEAD'])) })) return full('SOURCE_SCOPE_OR_AUTHORITY_CHANGED');
    const started = performance.now();
    const api = getJson ?? (async route => {
      if (performance.now() - started >= 90000) throw new Error('REPORT_API_BUDGET');
      // 当前仓库为公开仓库。仅用公开只读API，不增加workflow token权限，也不传任何凭据。
      const response = await fetch('https://api.github.com/repos/' + env.GITHUB_REPOSITORY + route, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('REPORT_API_UNAVAILABLE');
      const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error('REPORT_API_OVERFLOW');
      return JSON.parse(text);
    });
    const repo = await api(''); if (!Number.isSafeInteger(repo.id) || repo.private !== false || repo.full_name !== env.GITHUB_REPOSITORY) return full('REPOSITORY_IDENTITY_UNKNOWN');
    const listing = await api('/actions/runs?head_sha=' + parent + '&event=push&per_page=100');
    if (!Number.isSafeInteger(listing.total_count) || listing.total_count > 100 || listing.total_count !== listing.workflow_runs?.length) return full('RUN_LIST_INCOMPLETE');
    const runs = listing.workflow_runs, selected = workflowPaths.map(file => runs.filter(run => run.path === file));
    if (selected.some(items => items.length !== 1)) return full('REQUIRED_SOURCE_RUN_MISSING_OR_AMBIGUOUS');
    const proofs = [];
    for (const [run] of selected) {
      const jobs = await api('/actions/runs/' + run.id + '/attempts/1/jobs?per_page=100');
      if (!Number.isSafeInteger(jobs.total_count) || jobs.total_count > 100 || jobs.total_count !== jobs.jobs?.length) return full('JOB_LIST_INCOMPLETE');
      let artifacts = [];
      if (!run.path.endsWith('/security.yml')) {
        const listing = await api('/actions/runs/' + run.id + '/artifacts?per_page=100');
        if (!Number.isSafeInteger(listing.total_count) || listing.total_count > 100 || listing.total_count !== listing.artifacts?.length) return full('ARTIFACT_LIST_INCOMPLETE');
        artifacts = listing.artifacts;
      }
      proofs.push({ runId: run.id, jobs: jobs.jobs, artifacts });
    }
    const validate = pairing ? validateMobilePairingParentCi : mobile ? validateMobileParentCi : validateParentCi;
    if (!validate({ task, repositoryId: repo.id, parent, branch, runs, proofs })) return full('PARENT_PRODUCT_GATE_NOT_PROVEN');
    return { schema: 'musicbridge.report-only-ci.v1', mode: 'report-only', reason: 'EXACT_PARENT_PRODUCT_CI_SUCCESS',
      task, reportSha: env.GITHUB_SHA, parentSourceSha: parent, repositoryId: repo.id,
      productResultsReused: true, artifactContentDownloaded: false,
      evidenceScope: 'PUBLIC_PLATFORM_PRODUCER_AND_ARTIFACT_DIGEST_METADATA_NOT_CONTENT_VALIDATION',
      workflows: proofs.map(proof => ({ runId: proof.runId, jobIds: proof.jobs.map(job => job.id),
        artifacts: proof.artifacts.map(({ id, name, digest, expired }) => ({ id, name, digest, expired })) })) };
  } catch { return full('UNKNOWN_IDENTITY_OR_API_STATE'); }
}

async function main() {
  const result = await inspectReportOnly();
  const output = process.env.GITHUB_OUTPUT;
  if (output) writeFileSync(output, 'mode=' + result.mode + '\n', { flag: 'a' });
  const evidence = process.env.RUNNER_TEMP;
  if (evidence && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    const directory = path.join(evidence, 'musicbridge-verify'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, 'report-only-admission.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  }
  console.log('CI_MODE=' + result.mode + ' reason=' + result.reason);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { process.exitCode = 1; });
