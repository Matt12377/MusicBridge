import { execFileSync } from 'node:child_process';
import { lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectLocalLibrarySignedStatFixAdmission, readLocalLibraryFixWhole,
  LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK, LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH,
  LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE } from './local-library-signed-stat-fix-admission.mjs';
import { predecessorReuseWorkflowOutputs } from './mbm003-predecessor-reuse.mjs';
import { TAPE_CATALOG_COMMON_TASK, TAPE_CATALOG_COMMON_BRANCH,
  inspectTapeCatalogCommonAdmission, tapeCatalogCommonWorkflowOutputs } from './tape-catalog-common-admission.mjs';
import { MBM004_TASK, MBM004_BRANCH, MBM004_STATUS_PATH, inspectMbm004Admission, mbm004WorkflowOutputs } from './mbm004-admission.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordPath = 'docs/tape-catalog-common/STATUS.json';
function reject(code) { const error = new Error('任务适用性准入拒绝。'); error.code = code; throw error; }

/** 分支和独立任务记录均可触发严格组合检查，不能删除其中一个标记逃回旧路由。 */
export function taskApplicabilityRoute(branch, record, contentRecord = null) {
  if (branch === MBM004_BRANCH) return 'EXACT_MBM004';
  if (branch === TAPE_CATALOG_COMMON_BRANCH) return 'EXACT_TAPE_COMMON';
  if (contentRecord !== null) return 'EXACT_MBM004';
  return branch === TAPE_CATALOG_COMMON_BRANCH || record?.task === TAPE_CATALOG_COMMON_TASK
    ? 'EXACT_TAPE_COMMON' : 'ORIGINAL_LOCAL_FIX_OR_MOBILE';
}

export function inspectTaskApplicability(directory = repository, env = process.env, io = {}) {
  const read = io.read ?? readLocalLibraryFixWhole;
  const gitEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnvironment, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' });
  const git = io.git ?? (args => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args],
    { cwd: directory, env: gitEnvironment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }));
  const branch = git(['branch', '--show-current']).trim() || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  let record = null;
  try {
    const filename = path.join(directory, recordPath);
    lstatSync(filename);
    record = JSON.parse(read(filename));
  } catch (error) {
    if (error?.code !== 'ENOENT') reject('TASK_RECORD_INVALID');
  }
  let contentRecord = null;
  try { const filename = path.join(directory, MBM004_STATUS_PATH); lstatSync(filename); contentRecord = JSON.parse(read(filename)); }
  catch (error) { if (error?.code !== 'ENOENT') reject('TASK_CONTENT_RECORD_INVALID'); }
  if (taskApplicabilityRoute(branch, record, contentRecord) === 'EXACT_MBM004') return inspectMbm004Admission(directory, env);
  return taskApplicabilityRoute(branch, record) === 'EXACT_TAPE_COMMON'
    ? inspectTapeCatalogCommonAdmission(directory, env)
    : inspectLocalLibrarySignedStatFixAdmission(directory, env);
}

/** 五个输出来自同一次完整准入；工作流不能靠未知task默认跳过历史验证。 */
export function taskApplicabilityWorkflowOutputs(result) {
  if (result?.task === MBM004_TASK) return mbm004WorkflowOutputs(result);
  if (result?.task === TAPE_CATALOG_COMMON_TASK) return tapeCatalogCommonWorkflowOutputs(result);
  if (result?.task === LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK) {
    if (result.schema !== 'musicbridge.local-library-signed-stat-fix.admission.v1'
      || result.branch !== LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH || result.baseSha !== LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE
      || !/^[a-f0-9]{40}$/u.test(result.headAtAdmission ?? '') || result.exactProductFiles !== 12
      || result.exactCompatibilityFiles !== 6 || result.oldGateEvidenceReused !== true
      || result.currentFixSoftwareGateRequired !== true || result.currentFixAppDeviceOwnerProven !== false)
      reject('TASK_LOCAL_FIX_RESULT_INCOMPLETE');
    return { task: LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK, mobileTask: 'reuse-frozen', legacyGateMode: 'reuse-frozen',
      localLibraryFixTask: LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK, combinedGateMode: 'not-applicable' };
  }
  const previous = predecessorReuseWorkflowOutputs(result);
  return { ...previous, localLibraryFixTask: 'not-applicable', combinedGateMode: 'not-applicable' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) reject('TASK_UNKNOWN_ARGUMENT');
    const result = inspectTaskApplicability();
    const outputs = taskApplicabilityWorkflowOutputs(result);
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(outputs).map(([key, value]) => key + '=' + value + '\n').join(''), { flag: 'a' });
    process.stdout.write(JSON.stringify({ ...result, workflowOutputs: outputs }) + '\n');
  } catch (error) {
    process.stderr.write('任务适用性准入拒绝：' + (/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'TASK_ADMISSION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
