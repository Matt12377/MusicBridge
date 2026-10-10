import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateMobileDsdReportTask } from './report-only-mbm003.mjs';
import { TAPE_CATALOG_R3_CI_SCOPE, inspectTapeCatalogCiAdmission } from './tape-catalog-r3-ci-applicability.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const receiptPath = 'docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json';
const receiptSha = '87cb1fcc67dc74013b7780cdf01e3ff0d44d756ee964938c23b0e37c266e1d4c';
const source = '7ec898d9f26cbafb5e01f5483bfaccf14ca61d27';
const report = 'd5189ecba0aaf266e7fa375613a7a99beffabc2e';
const base = 'b1a8de728086e7994bb69d7dee10782f646886dd';
const sha = b => createHash('sha256').update(b).digest('hex');
function whole(filename) {
  if (realpathSync(filename) !== filename) throw new Error('前序证据不能沿符号链。');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd, { bigint: true });
    if (!a.isFile() || a.size < 1n || a.size > 8n * 1024n * 1024n) throw new Error('前序证据不是有界普通文件。');
    const bytes = Buffer.alloc(Number(a.size)); let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length-at, null); if (!n) throw new Error('前序证据截短。'); at += n; }
    const same = b => ['dev','ino','size','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || !same(fstatSync(fd,{bigint:true})) || !same(lstatSync(filename,{bigint:true}))) throw new Error('前序证据读取时漂移。');
    return bytes;
  } finally { closeSync(fd); }
}
/** 只复用原 Source/R 软件证明；新任务仍必须运行自己的 Gate 和标准验证。 */
export function inspectMbm003PredecessorReuse(directory = root, env = process.env, io = {}) {
  const read = io.read ?? whole;
  // 固定本目录真实Git对象；不继承外部GIT目录、替换对象或配置命令注入。
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnv,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'});
  const git = io.git ?? (args => execFileSync('git',['--no-replace-objects','-c','core.fsmonitor=false',...args],
    {cwd:directory,env:gitEnv,encoding:'utf8',timeout:10000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}));
  const branch = git(['branch','--show-current']).trim() || env.GITHUB_REF_NAME;
  // Tape先准入精确CI范围；清掉继承003双表不能逃入legacy路径。
  const tape = branch === TAPE_CATALOG_R3_CI_SCOPE.branch
    ? inspectTapeCatalogCiAdmission(directory, branch, { read, git, env }) : null;
  const json = name => JSON.parse(read(path.join(directory, name)));
  const status = json('project/STATUS.json'), plan = json('project/POSTRUST_PLAN.json');
  const tasks = [status.currentMobileTask, status.mobileFrontloading20261008?.currentTask, plan.execution_schedule?.current_task];
  if (!tasks.includes('MBM-003')) {
    if (tape) throw new Error('磁带CI仍须绑定当前003软件Gate。');
    return { task: 'legacy', oldGateEvidenceReused: false };
  }
  if (tape && tasks.some(task => task !== 'MBM-003')) throw new Error('磁带CI继承的003任务选择器不一致。');
  if (locateMobileDsdReportTask(status, plan) !== 'MBM-003') throw new Error('003 authority、lane、schedule 或双表不一致。');
  const bytes = read(path.join(directory, receiptPath));
  if (bytes.length !== 3058 || sha(bytes) !== receiptSha) throw new Error('003 前序复用收据身份不符。');
  const receipt = JSON.parse(bytes);
  if (receipt.source !== source || receipt.directReport !== report || receipt.base !== base || receipt.directReportSingleParent !== source
    || receipt.oldGatesRerun !== false || receipt.new003SourceGateRequired !== true || receipt.new003DeviceAudioOwnerProven !== false) throw new Error('003 前序复用边界错误。');
  for (const pin of receipt.frozenFiles) {
    const current = read(path.join(directory,pin.path));
    if (current.length !== pin.bytes || sha(current) !== pin.sha256) throw new Error('原冻结 Gate 或报告已变，不能复用：'+pin.path);
  }
  const predecessor = json('docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json');
  if (predecessor.macSource !== source || predecessor.macDirectSoftwareReport !== report || predecessor.macFinalMetadataHead !== base
    || predecessor.sourceAndDirectReportCi !== 'PASS_EXACT_FIRST_NATURAL_REUSED_UNCHANGED') throw new Error('003 前序绑定错误。');
  if (git(['rev-list','--parents','-n','1',report]).trim() !== report+' '+source) throw new Error('原 R 不是精确 Source 的唯一直接子提交。');
  git(['merge-base','--is-ancestor',base,'HEAD']);
  if (branch !== 'codex/mbm-003-lossless-dsd-transport' && !tape) throw new Error('003 分支不符。');
  // 003完整校验之后再回读，避免外层读取期间换HEAD或分支仍输出早期Tape身份。
  if (tape && (git(['rev-parse','HEAD']).trim() !== tape.head
    || (git(['branch','--show-current']).trim() || env.GITHUB_REF_NAME) !== tape.branch
    || git(['status','--porcelain=v1','--untracked-files=all']) !== ''))
    throw new Error('磁带CI源码在完整前序检查期间漂移。');
  return { schema:'musicbridge.mbm003.predecessor-reuse-check.v1',task:tape?.task ?? 'MBM-003',state:'EXACT_PREDECESSOR_SOFTWARE_REUSED',
    predecessorSource:source,predecessorDirectReport:report,predecessorFinalMetadata:base,receiptSha256:receiptSha,
    frozenFilesRead:receipt.frozenFiles.length,oldGateEvidenceReused:true,oldExecutionSha:source,
    current003SoftwareGateRequired:true,current003AppDeviceOwnerProven:false,
    ...(tape ? { currentMobileTask:'MBM-003', parallelBranchAdmission:tape } : {}) };
}

/** 执行任务与移动回归任务分别路由；缺少实际准入结果时不生成跳过历史Gate的输出。 */
export function predecessorReuseWorkflowOutputs(result) {
  if (result?.task === 'legacy' && result.oldGateEvidenceReused === false)
    return { task:'legacy', mobileTask:'legacy', legacyGateMode:'run' };
  if (!['MBM-003', 'TAPE-CATALOG-R3'].includes(result?.task)
    || result.oldGateEvidenceReused !== true || result.current003SoftwareGateRequired !== true
    || result.task === 'TAPE-CATALOG-R3' && (result.currentMobileTask !== 'MBM-003'
      || result.parallelBranchAdmission?.task !== 'TAPE-CATALOG-R3'
      || result.parallelBranchAdmission.current003SoftwareGateRequired !== true))
    throw new Error('CI适用性结果不完整，禁止生成跳过输出。');
  return { task:result.task, mobileTask:'MBM-003', legacyGateMode:'reuse-frozen' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectMbm003PredecessorReuse();
  const outputs = predecessorReuseWorkflowOutputs(result);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key,value])=>key+'='+value+'\n').join(''),{flag:'a'});
  console.log(JSON.stringify(result));
}
