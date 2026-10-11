import { MBM004_TASK, MBM004_BRANCH, MBM004_BASE, MBM004_SCOPE_PATH, MBM004_STATUS_PATH,
  assertMbm004Metadata } from './mbm004-admission.mjs';
const workflows = ['.github/workflows/verify.yml', '.github/workflows/security.yml',
  '.github/workflows/rust-core.yml', '.github/workflows/electron-e2e.yml'];
const steps = {
  '.github/workflows/verify.yml': ['MBM004 内容与多设备软件 Gate',
    'Verify platform-independent workspace (typecheck, unit tests, build; no Electron)', 'Production dependency audit'],
  '.github/workflows/security.yml': ['Run directed platform-independent security tests (no Electron)'],
  '.github/workflows/rust-core.yml': ['验证实际 Rust 与 TypeScript 边界'],
  '.github/workflows/electron-e2e.yml': ['Electron startup, crash/restart, safeStorage vault and credential recovery gates',
    'Electron end-to-end flow (Playwright, production build)'],
};
const metadata = ['project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md'];
const reports = ['reports/MBM-004_RESULT.md', 'reports/MBM-004_RESULT.json', 'docs/postrust/MBM-004/CI_EVIDENCE.json'];
export const MBM004_REPORT_STATUS_FIELDS = ['state', 'implementationCommit', 'reportCommit', 'reportCommitResolution', 'report',
  'evidence', 'push', 'ci', 'updatedAt', 'finalDeliveryReceipt', 'nextBranchBaseline'];
const statusFields = MBM004_REPORT_STATUS_FIELDS;
const taskFields = ['implementation_commit', 'report_commit', 'report_commit_resolution', 'report_path', 'evidence_refs', 'terminal_ci_receipt'];
const without = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
export function locateMobileContentReportTask(status, plan) {
  try {
    assertMbm004Metadata(status, plan);
    if (status.mobileContentMultidevice.software !== 'PASSED'
      || status.mobileFrontloading20261008.mobileTasks.find(row => row.id === MBM004_TASK).software !== 'PASSED') return null;
    return MBM004_TASK;
  } catch { return null; }
}
/** 唯一直接Source的报告只能更新本域记账，不能升真实/Owner证据或换已验证源码。 */
export function classifyMobileContentReportChanges({ task, parent, beforeStatus, afterStatus, beforePlan, afterPlan, changes }) {
  try {
    if (task !== MBM004_TASK || !sha(parent) || locateMobileContentReportTask(beforeStatus, beforePlan) !== task
      || locateMobileContentReportTask(afterStatus, afterPlan) !== task || !Array.isArray(changes) || !changes.length
      || afterStatus.mobileContentMultidevice.implementationCommit !== parent) return false;
    const normalizeRows = rows => rows.map(row => row.id === task ? without(row, taskFields) : row);
    const normalizeStatus = status => ({ ...status, mobileContentMultidevice: without(status.mobileContentMultidevice, statusFields),
      mobileFrontloading20261008: { ...status.mobileFrontloading20261008,
        mobileTasks: normalizeRows(status.mobileFrontloading20261008.mobileTasks) } });
    if (!equal(normalizeStatus(beforeStatus), normalizeStatus(afterStatus))
      || !equal({ ...beforePlan, mobile_tasks: normalizeRows(beforePlan.mobile_tasks) },
        { ...afterPlan, mobile_tasks: normalizeRows(afterPlan.mobile_tasks) })) return false;
    for (const row of [afterStatus.mobileFrontloading20261008.mobileTasks.find(row => row.id === task), afterPlan.mobile_tasks.find(row => row.id === task)])
      if (row.implementation_commit !== parent) return false;
    const seen = new Set(); let report = false;
    for (const row of changes) {
      if (!['A', 'M'].includes(row.status) || row.newMode !== '100644'
        || row.status === 'A' && row.oldMode !== '000000' || row.status === 'M' && row.oldMode !== '100644'
        || seen.has(row.path) || ![...metadata, ...reports, MBM004_STATUS_PATH].includes(row.path)) return false;
      seen.add(row.path); report ||= row.path === reports[0];
    }
    return report;
  } catch { return false; }
}
/** 完整4次自然push/6jobs/5artifacts，逐producer核本轮004Gate；不把制品元数据当内容消费。 */
export function validateMobileContentParentCi({ task, repositoryId, parent, branch, runs, proofs, now = Date.now() }) {
  try {
    if (task !== MBM004_TASK || !positive(repositoryId) || !sha(parent) || branch !== MBM004_BRANCH || !Number.isFinite(now)
      || !Array.isArray(runs) || runs.length !== 4 || !Array.isArray(proofs) || proofs.length !== 4) return false;
    const runIds = new Set(), jobIds = new Set(), artifactIds = new Set();
    const successStep = (job, name) => {
      const selected = job.steps.filter(step => step.name === name);
      return selected.length === 1 && selected[0].status === 'completed' && selected[0].conclusion === 'success';
    };
    for (let index = 0; index < workflows.length; index++) {
      const file = workflows[index], selected = runs.filter(run => run.path === file);
      if (selected.length !== 1) return false;
      const run = selected[0], matchingProofs = proofs.filter(value => value?.runId === run.id);
      if (matchingProofs.length !== 1) return false;
      const proof = matchingProofs[0];
      if (!positive(run.id) || runIds.has(run.id) || run.repository?.id !== repositoryId || run.head_repository?.id !== repositoryId
        || run.head_sha !== parent || run.head_branch !== branch || run.event !== 'push'
        || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'success'
        || !Array.isArray(proof?.jobs) || proof.jobs.length !== [2, 1, 2, 1][index]
        || !Array.isArray(proof.artifacts) || proof.artifacts.length !== [1, 0, 2, 2][index]) return false;
      runIds.add(run.id);
      for (const job of proof.jobs) {
        if (!positive(job.id) || jobIds.has(job.id) || job.run_id !== run.id || job.head_sha !== parent || job.status !== 'completed'
          || job.conclusion !== 'success' || !Array.isArray(job.steps)) return false;
        jobIds.add(job.id);
      }
      for (const name of steps[file]) {
        const matches = proof.jobs.flatMap(job => job.steps).filter(step => step.name === name);
        // Rust矩阵两平台各有同名一步；其余producer必须唯一。
        if (matches.length !== (index === 2 ? 2 : 1) || matches.some(step => step.status !== 'completed' || step.conclusion !== 'success')) return false;
      }
      if (index === 2 && proof.jobs.some(job => !successStep(job, steps[file][0]))) return false;
      if (index === 0) {
        const [gateName, standardName, auditName] = steps[file];
        const product = proof.jobs.find(job => successStep(job, gateName) && successStep(job, standardName));
        const audit = proof.jobs.find(job => successStep(job, auditName));
        if (!product || !audit || product === audit) return false;
      }
      const names = index === 0 ? [`verify-${parent}`] : index === 2
        ? [`rust-core-ubuntu-latest-${parent}`, `rust-core-macos-latest-${parent}`] : index === 3
          ? [`rust-host-compiled-${parent}`, `electron-e2e-${parent}`] : [];
      if (names.some(name => proof.artifacts.filter(artifact => artifact.name === name).length !== 1)) return false;
      for (const artifact of proof.artifacts) {
        if (!positive(artifact.id) || artifactIds.has(artifact.id) || artifact.expired !== false
          || !positive(artifact.size_in_bytes) || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '')
          || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= now
          || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== parent
          || artifact.workflow_run?.repository_id !== repositoryId || artifact.workflow_run?.head_repository_id !== repositoryId) return false;
        artifactIds.add(artifact.id);
      }
    }
    return runIds.size === 4 && jobIds.size === 6 && artifactIds.size === 5;
  } catch { return false; }
}
export const MBM004_REPORT_IDENTITY = Object.freeze({ task: MBM004_TASK, branch: MBM004_BRANCH,
  baseSha: MBM004_BASE, scope: MBM004_SCOPE_PATH });
