// 003独立的纯报告准入叶：初始化不读Git/API/制品，也不调用旧任务的CI准入器。
const taskId = 'MBM-003';
const authorityKey = 'mobileLosslessDsdTransport';
const scopePath = 'docs/postrust/MBM-003/EXECUTION_SCOPE.json';
const taskBranch = 'codex/mbm-003-lossless-dsd-transport';
const predecessor = 'b1a8de728086e7994bb69d7dee10782f646886dd';
const mobileStatusFields = ['implementationCommit', 'implementationCommitResolution', 'reportCommit',
  'reportCommitResolution', 'report', 'evidence', 'push', 'ci', 'updatedAt', 'updatedAtUTC',
  'finalDeliveryReceipt', 'nextBranchBaseline'];
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
const gateNames = ['MBM003 无损与DSD传输软件 Gate', 'MBM003 精确前序软件证据复用'];
const jobCounts = [2, 1, 2, 1], artifactCounts = [1, 0, 2, 2];
const sourceSha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/u.test(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const records = value => Array.isArray(value) && Array.from(value).every(record);

function sortObject(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, sortObject);
  if (!record(value)) throw new TypeError('报告输入必须为完整JSON值');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors[key], 'value'))) throw new TypeError('报告输入不得含访问器或隐式字段');
  return Object.fromEntries(keys.sort().map(key => [key, sortObject(descriptors[key].value)]));
}
function equal(a, b) { return JSON.stringify(sortObject(a)) === JSON.stringify(sortObject(b)); }
function without(value, fields) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
}
function locate(status, plan) {
  if (!record(status) || !record(plan)) return null;
  const lane = status.mobileFrontloading20261008, authority = status[authorityKey];
  if (!record(lane) || !record(authority) || !record(plan.execution_schedule)
    || lane.currentTask !== taskId || plan.execution_schedule.current_task !== taskId
    || authority.task !== taskId || authority.scope !== scopePath
    || authority.baseSha !== predecessor || authority.branch !== taskBranch
    || plan.execution_schedule.current_task_scope_ref !== scopePath
    || plan.execution_schedule.predecessor_final_report !== predecessor
    || !records(lane.mobileTasks) || !records(plan.mobile_tasks)) return null;
  const keys = Object.keys(status).filter(key => status[key]?.task === taskId);
  const statusRows = lane.mobileTasks.filter(row => row.id === taskId);
  const planRows = plan.mobile_tasks.filter(row => row.id === taskId);
  if (keys.length !== 1 || keys[0] !== authorityKey || statusRows.length !== 1 || planRows.length !== 1) return null;
  for (const row of [statusRows[0], planRows[0]]) {
    if (row.scope_ref !== scopePath || row.base_report_sha !== predecessor || row.branch !== taskBranch) return null;
  }
  return equal(without(statusRows[0], mobileTaskFields), without(planRows[0], mobileTaskFields)) ? taskId : null;
}

/** 003 authority、lane、schedule与双表唯一绑定已封存002报告；不判断软件或真实验收通过。 */
export function locateMobileDsdReportTask(status, plan) {
  try { return locate(status, plan); }
  catch { return null; }
}

/** R仅改本域报告及精确记账字段；所有软件/App/真实/Owner、权限、范围和旧账逐值冻结。 */
export function classifyMobileDsdReportChanges(input) {
  try { return classify(input); }
  catch { return false; }
}
function classify({ task, parent, beforeStatus, afterStatus, beforePlan, afterPlan, changes }) {
  if (task !== taskId || !sourceSha(parent)
    || locate(beforeStatus, beforePlan) !== taskId || locate(afterStatus, afterPlan) !== taskId
    || !records(beforePlan.tasks) || !records(afterPlan.tasks)
    || !records(beforePlan.acceptance_cases) || !records(afterPlan.acceptance_cases)
    || !records(changes) || !changes.length) return false;
  const before = beforeStatus[authorityKey], after = afterStatus[authorityKey];
  if (after.implementationCommit !== parent
    || !equal(without(before, mobileStatusFields), without(after, mobileStatusFields))) return false;
  const normalizeRows = rows => rows.map(row => row.id === task ? without(row, mobileTaskFields) : row);
  const normalizeStatus = status => ({ ...status,
    [authorityKey]: without(status[authorityKey], mobileStatusFields),
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
  const paths = new Set();
  for (const entry of changes) {
    if (!['A', 'M'].includes(entry.status) || entry.newMode !== '100644'
      || entry.status === 'M' && entry.oldMode !== '100644'
      || entry.status === 'A' && entry.oldMode !== '000000'
      || typeof entry.path !== 'string' || paths.has(entry.path)) return false;
    paths.add(entry.path);
    const report = /^reports\/MBM-003_[A-Z0-9_]+\.(?:md|json)(?![\s\S])/u.test(entry.path);
    const evidence = /^docs\/postrust\/MBM-003\/evidence\/[A-Za-z0-9_-]+\.(?:json|md)(?![\s\S])/u.test(entry.path);
    if (!report && !evidence && !metadataPaths.includes(entry.path)) return false;
    if (report) reportPresent = true;
  }
  return reportPresent;
}

/** 仅核同Source首次自然push的完整producer与平台digest元数据，不声称已下载ZIP/读制品或真实验收。 */
export function validateMobileDsdParentCi(input) {
  try { return validateProducerMetadata(input); }
  catch { return false; }
}
function validateProducerMetadata(input) {
  const now = input?.now === undefined ? Date.now() : input.now;
  if (!record(input) || input.task !== taskId || input.branch !== taskBranch || !sourceSha(input.parent)
    || !positiveId(input.repositoryId) || !records(input.runs) || input.runs.length !== 4
    || !records(input.proofs) || input.proofs.length !== 4 || !Number.isFinite(now)) return false;
  const runIds = new Set(), jobIds = new Set(), artifactIds = new Set();
  const artifactNames = [['verify-' + input.parent], [],
    ['rust-core-ubuntu-latest-' + input.parent, 'rust-core-macos-latest-' + input.parent],
    ['electron-e2e-' + input.parent, 'rust-host-compiled-' + input.parent]];
  const successStep = (job, name) => {
    const steps = job.steps.filter(step => step.name === name);
    return steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success';
  };
  for (const [index, file] of workflowPaths.entries()) {
    const runs = input.runs.filter(run => run.path === file);
    if (runs.length !== 1) return false;
    const run = runs[0];
    if (!positiveId(run.id) || runIds.has(run.id) || run.head_sha !== input.parent
      || run.head_branch !== taskBranch || run.event !== 'push' || run.run_attempt !== 1
      || run.status !== 'completed' || run.conclusion !== 'success'
      || run.repository?.id !== input.repositoryId || run.head_repository?.id !== input.repositoryId) return false;
    runIds.add(run.id);
    const proofs = input.proofs.filter(proof => proof.runId === run.id);
    if (proofs.length !== 1) return false;
    const proof = proofs[0];
    if (!records(proof.jobs) || proof.jobs.length !== jobCounts[index]
      || !records(proof.artifacts) || proof.artifacts.length !== artifactCounts[index]) return false;
    for (const job of proof.jobs) {
      if (!positiveId(job.id) || jobIds.has(job.id) || job.run_id !== run.id || job.head_sha !== input.parent
        || job.status !== 'completed' || job.conclusion !== 'success'
        || !records(job.steps) || !job.steps.length
        || job.steps.some(step => typeof step.name !== 'string' || !step.name.length)) return false;
      jobIds.add(job.id);
    }
    const steps = proof.jobs.flatMap(job => job.steps);
    for (const name of requiredSteps[file]) {
      const expected = file === workflowPaths[2] ? 2 : 1;
      if (steps.filter(step => step.name === name).length !== expected
        || proof.jobs.filter(job => successStep(job, name)).length !== expected) return false;
    }
    if (file === workflowPaths[0]) {
      const product = proof.jobs.find(job => successStep(job, requiredSteps[file][0]));
      const audit = proof.jobs.find(job => successStep(job, requiredSteps[file][1]));
      if (!product || !audit || product === audit || gateNames.some(name =>
        !successStep(product, name) || steps.filter(step => step.name === name).length !== 1)) return false;
    }
    for (const artifact of proof.artifacts) {
      const origin = artifact.workflow_run;
      if (!positiveId(artifact.id) || artifactIds.has(artifact.id)
        || !artifactNames[index].includes(artifact.name)
        || proof.artifacts.filter(value => value.name === artifact.name).length !== 1
        || artifact.expired !== false || typeof artifact.digest !== 'string'
        || !/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(artifact.digest)
        || typeof artifact.expires_at !== 'string' || !Number.isFinite(Date.parse(artifact.expires_at))
        || Date.parse(artifact.expires_at) <= now || !record(origin)
        || origin.id !== run.id || origin.head_sha !== input.parent
        || origin.repository_id !== input.repositoryId || origin.head_repository_id !== input.repositoryId) return false;
      artifactIds.add(artifact.id);
    }
  }
  return runIds.size === 4 && jobIds.size === 6 && artifactIds.size === 5;
}
