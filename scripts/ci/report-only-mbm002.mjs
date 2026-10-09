import { validateMobileParentCi } from './report-only-admission.mjs';

// 此叶与原准入器仅互引函数；模块初始化不调用对方，也不读取Git、网络或制品内容。
const taskId = 'MBM-002';
const authorityKey = 'mobilePlaybackResources';
const scopePath = 'docs/postrust/MBM-002/EXECUTION_SCOPE.json';
const taskBranch = 'codex/mbm-002-phone-resource-playback';
const predecessor = '8044d935e242d8647adc21445116fb49c9100e4a';
const mobileStatusFields = ['implementationCommit', 'implementationCommitResolution', 'reportCommit',
  'reportCommitResolution', 'report', 'evidence', 'push', 'ci', 'updatedAt', 'finalDeliveryReceipt',
  'nextBranchBaseline'];
const mobileTaskFields = ['implementation_commit', 'implementation_commit_resolution', 'report_commit',
  'report_commit_resolution', 'report_path', 'evidence_refs', 'terminal_ci_receipt'];
const metadataPaths = ['project/STATUS.json', 'project/POSTRUST_PLAN.json',
  'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'];
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
const gateNames = ['MBRS013 同内容位置迁移与具体清理 Gate', 'MBM000 移动合同双端采纳 Gate',
  'MBM001 配对与只读曲库 Gate', 'MBM002 手机资源播放 Gate'];

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}
function equal(a, b) { return JSON.stringify(sortObject(a)) === JSON.stringify(sortObject(b)); }
function without(value, fields) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !fields.includes(key)));
}
function locate(status, plan) {
  const lane = status?.mobileFrontloading20261008, authority = status?.[authorityKey];
  if (lane?.currentTask !== taskId || plan?.execution_schedule?.current_task !== taskId
    || authority?.task !== taskId || authority.scope !== scopePath
    || authority.baseSha !== predecessor || authority.branch !== taskBranch
    || plan.execution_schedule.current_task_scope_ref !== scopePath
    || plan.execution_schedule.predecessor_final_report !== predecessor
    || !Array.isArray(lane.mobileTasks) || !Array.isArray(plan.mobile_tasks)) return null;
  const keys = Object.keys(status).filter(key => status[key]?.task === taskId);
  const statusRows = lane.mobileTasks.filter(row => row?.id === taskId);
  const planRows = plan.mobile_tasks.filter(row => row?.id === taskId);
  if (keys.length !== 1 || keys[0] !== authorityKey || statusRows.length !== 1 || planRows.length !== 1) return null;
  for (const row of [statusRows[0], planRows[0]]) {
    if (row.scope_ref !== scopePath || row.base_report_sha !== predecessor) return null;
  }
  return equal(without(statusRows[0], mobileTaskFields), without(planRows[0], mobileTaskFields)) ? taskId : null;
}

/** 002独立authority、lane与schedule必须唯一绑定真实001最终报告。 */
export function locateMobilePlaybackReportTask(status, plan) {
  try { return locate(status, plan); }
  catch { return null; }
}

/** R只允许本域报告记账；软件/App/真实/Owner、权限、预算、旧账和后继任务原样保留。 */
export function classifyMobilePlaybackReportChanges(input) {
  try { return classify(input); }
  catch { return false; }
}
function classify({ task, parent, beforeStatus, afterStatus, beforePlan, afterPlan, changes }) {
  if (task !== taskId || typeof parent !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/u.test(parent)
    || locate(beforeStatus, beforePlan) !== taskId || locate(afterStatus, afterPlan) !== taskId
    || !Array.isArray(beforePlan.tasks) || !Array.isArray(afterPlan.tasks)
    || !Array.isArray(beforePlan.acceptance_cases) || !Array.isArray(afterPlan.acceptance_cases)
    || !Array.isArray(changes) || !changes.length) return false;
  const before = beforeStatus[authorityKey], after = afterStatus[authorityKey];
  if (after.implementationCommit !== parent
    || !equal(without(before, mobileStatusFields), without(after, mobileStatusFields))) return false;
  const normalizeRows = rows => rows.map(row => row?.id === task ? without(row, mobileTaskFields) : row);
  const normalizeStatus = status => ({ ...status,
    [authorityKey]: without(status[authorityKey], mobileStatusFields),
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
    const report = /^reports\/MBM-002_[A-Z0-9_]+\.(?:md|json)(?![\s\S])/u.test(entry.path);
    const evidence = /^docs\/postrust\/MBM-002\/evidence\/[A-Za-z0-9_-]+\.(?:json|md)(?![\s\S])/u.test(entry.path);
    if (!report && !evidence && !metadataPaths.includes(entry.path)) return false;
    if (report) reportPresent = true;
  }
  return reportPresent;
}

/** 只核同Source首次自然push的producer与平台digest元数据；不验证ZIP或替代产品/设备/Owner证据。 */
export function validateMobilePlaybackParentCi(input) {
  try { return validateProducerMetadata(input); }
  catch { return false; }
}
function validateProducerMetadata(input) {
  const now = input?.now === undefined ? Date.now() : input.now;
  if (input?.task !== taskId || input.branch !== taskBranch
    || typeof input.parent !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/u.test(input.parent)
    || !Array.isArray(input.runs) || input.runs.length !== 4
    || !Array.isArray(input.proofs) || input.proofs.length !== 4
    || !Number.isFinite(now)
    || !validateMobileParentCi({ ...input, task: 'MBM-000', now })) return false;
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
      if (!positiveId(artifact?.id) || artifactIds.has(artifact.id)
        || typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(artifact.digest)) return false;
      artifactIds.add(artifact.id);
    }
    for (const name of requiredSteps[file]) {
      const producers = proof.jobs.filter(job => successStep(job, name));
      if (producers.length !== (file === '.github/workflows/rust-core.yml' ? 2 : 1)) return false;
    }
    if (file === '.github/workflows/verify.yml') {
      const product = proof.jobs.find(job => successStep(job, requiredSteps[file][0]));
      const audit = proof.jobs.find(job => successStep(job, requiredSteps[file][1]));
      if (!product || !audit || product === audit || gateNames.some(name => !successStep(product, name)
        || proof.jobs.flatMap(job => job.steps).filter(step => step?.name === name).length !== 1)) return false;
    }
  }
  return runIds.size === 4 && jobIds.size === 6 && artifactIds.size === 5;
}
